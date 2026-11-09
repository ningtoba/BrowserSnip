/**
 * The `protect` row's evidence: what the encryption dictionary says, whether an
 * independent engine can read the file it produced, and whether a protect → unlock
 * round trip keeps the objects nobody asked to change.
 *
 * Why this file exists beside `security-bytes.test.ts`: the triage found a
 * dictionary claiming `/V 5 /R 6` with a crypt filter of `/CFM /AESV2 /Length 16`,
 * no `/OE`, `/UE` or `/Perms`, and a card that said "Protected with AES-256".
 * Measured, the cause was one level deeper — `@maxwbh/pdf-lib`'s writer registers
 * the dictionary and never calls its own `PDFSecurity.encryptStream`, so no
 * stream or string is ciphered at any strength. Every assertion here is therefore
 * about **agreement**: between the two halves of the dictionary, between the
 * dictionary and the bytes behind it, and between the file and what a second
 * implementation of the format makes of it.
 *
 * The rig is also a dump: `PROTECT_PROBE_DIR=/tmp/pb npx vitest run
 * tests/pdf/protect-spec.test.ts` writes the tool's own output for
 * `docs/research/protect-readers.py`, which asks MuPDF, poppler, qpdf, pypdf and
 * Ghostscript the same four questions of every file — opens, gates, text, `/P`.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  PDFArray,
  PDFCheckBox,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFTextField,
  StandardFonts,
  rgb,
} from '@maxwbh/pdf-lib';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import { inspectPdf } from '@/lib/pdf/core/guard';
import { openRender } from '@/lib/pdf/core/render';
import { annotationCount } from '@/lib/pdf/core/annotations';
import { addAnnotation } from '@/lib/pdf/core/annotations';
import { addAttachments, listAttachments } from '@/lib/pdf/core/attachments';
import { readOutline, writeOutline } from '@/lib/pdf/core/bookmarks';
import { inflateSync } from 'node:zlib';
import type { PdfToolDefinition, ToolValues } from '@/lib/pdf/tools/types';

const latin1 = new TextDecoder('latin1');
const PROBE_DIR = process.env.PROTECT_PROBE_DIR ?? '';
const USER = 'open-sesame';
const OWNER = 'owner-key';
const WORDS = 'Secret Alice 42 Bravo';

beforeAll(() => {
  let workerPath = `file://${process.cwd()}/node_modules/pdfjs-dist/build/pdf.worker.mjs`;
  Object.defineProperty(GlobalWorkerOptions, 'workerSrc', {
    configurable: true,
    get: () => workerPath,
    set: (value: string) => {
      if (value.startsWith('file:') || value.startsWith('data:')) workerPath = value;
    },
  });
  if (PROBE_DIR) mkdirSync(PROBE_DIR, { recursive: true });
});

// ── fixture: everything a copy is known to lose ─────────────────────────────

/**
 * Three text pages, two filled fields, a note, a link, two bookmarks and an
 * enclosure — the set the `remove-blank-pages` row found a page-tree rebuild
 * dropping, so "it opened" is never the claim.
 */
async function richFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < 3; index++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`${WORDS} on page ${index + 1}`, { x: 60, y: 700, size: 18, font, color: rgb(0, 0, 0) });
  }
  const form = doc.getForm();
  form.createTextField('applicant.name').setText('Ada Lovelace');
  form.createCheckBox('agree').check();
  addAnnotation(doc, {
    kind: 'Text', page: 0, rect: { x: 120, y: 400, width: 24, height: 24 }, contents: 'Alice needs a note',
  });
  addAnnotation(doc, {
    kind: 'Link', page: 1, rect: { x: 60, y: 60, width: 140, height: 20 },
    link: { type: 'uri', uri: 'https://example.com' },
  });
  writeOutline(doc, [{ title: 'Chapter Bravo', page: 0 }, { title: 'Intro', page: 1 }]);
  await addAttachments(doc, [
    { name: 'source.csv', bytes: new TextEncoder().encode('a,b\n1,2\n'), mimeType: 'text/csv' },
  ]);
  return doc.save({ useObjectStreams: false });
}

function pdfFile(bytes: Uint8Array, name: string): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });
}

interface RunOutcome {
  outputs: { blob: Blob; name: string }[];
  message?: string;
  warnings: string[];
}

async function run(id: string, values: ToolValues = {}, files?: File[], password?: string): Promise<RunOutcome> {
  const tool = getPdfTool(id) as PdfToolDefinition | undefined;
  expect(tool, `tool "${id}" is not registered`).toBeTruthy();
  const inputs = files ?? [pdfFile(await richFixture(), 'claim.pdf')];
  return (await runPdfTool({
    toolId: id, files: inputs, values, password, onProgress: () => {}, onLog: () => {},
  })) as unknown as RunOutcome;
}

async function bytesOf(outcome: RunOutcome, index = 0): Promise<Uint8Array> {
  expect(outcome.outputs.length, 'the tool produced no output').toBeGreaterThan(index);
  return new Uint8Array(await outcome.outputs[index].blob.arrayBuffer());
}

function dump(name: string, bytes: Uint8Array): void {
  if (PROBE_DIR) writeFileSync(path.join(PROBE_DIR, name), bytes);
}

// ── the dictionary, off the raw bytes ───────────────────────────────────────

/** The `/Encrypt` object's body, found by hand — no pdf-lib, no guard. */
function encryptDictBody(bytes: Uint8Array): string {
  const raw = latin1.decode(bytes);
  const start = raw.indexOf('/Filter /Standard');
  expect(start, 'the saved file carries no /Filter /Standard dictionary').toBeGreaterThan(-1);
  // The dictionary ends at the `>>` that closes the object, not at the first
  // nested one — `/CF << >>` is exactly the nested pair under test.
  const body = raw.slice(start, raw.indexOf('>>', raw.indexOf('>>', start) + 2) + 2);
  return body.replace(/\s+/g, ' ');
}

/** One key of the dictionary as the file writes it, or null when absent. */
function field(body: string, key: string): string | null {
  const found = new RegExp(`/${key}\\s+(<<[^>]*>>|<([0-9A-Fa-f\\s]+)>|\\([^)]*\\)|-?\\d+|true|false|null|/[A-Za-z0-9]+)`).exec(body);
  return found ? found[1] : null;
}

function hexBytes(value: string | null): number {
  const hex = /<\s*([0-9A-Fa-f\s]*)>/.exec(value ?? '')?.[1]?.replace(/\s+/g, '') ?? '';
  return hex.length / 2;
}

/** The raw `/P` integer, read off the file rather than decoded by this app. */
function rawPermissionValue(bytes: Uint8Array): number {
  const found = /\/P\s+(-?\d+)/.exec(latin1.decode(bytes));
  expect(found, 'the saved file has no /P value').not.toBeNull();
  return Number(found![1]);
}

/** ISO 32000-1 Table 25: bit `n` (1-based) of `/P`. */
function permissionBit(value: number, bit: number): boolean {
  return ((value >> (bit - 1)) & 1) === 1;
}

/** Every stream in the file, inflated with `node:zlib`: what a text extractor sees. */
async function inflatedStreams(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const parts: string[] = [];
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const stored = object.getContents();
    try {
      parts.push(latin1.decode(inflateSync(Buffer.from(stored))));
    } catch {
      parts.push(latin1.decode(stored));
    }
  }
  return parts.join('\n');
}

/** The objects a copy silently drops, counted out of the saved bytes. */
async function structureOf(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  let annotsEntries = 0;
  for (const page of doc.getPages()) {
    const value = page.node.get(PDFName.of('Annots'));
    const resolved = value instanceof PDFRef ? doc.context.lookup(value) : value;
    if (resolved instanceof PDFArray) annotsEntries += resolved.size();
  }
  const form = doc.getForm();
  return {
    pages: doc.getPageCount(),
    // Two ways at the same count: the app's own helper, and a walk of every
    // page's `/Annots` array. They have to agree with each other as well as with
    // the source, or one of them is reading a page tree the file does not have.
    annotations: annotationCount(doc),
    annotsEntries,
    fields: form.getFields().length,
    fieldValues: form.getFields().map((field) => (field instanceof PDFTextField ? field.getText() : field instanceof PDFCheckBox && field.isChecked() ? 'checked' : '')).sort(),
    bookmarks: readOutline(doc).length,
    attachments: listAttachments(doc).map((file) => file.name).sort(),
  };
}

// ── what a second implementation makes of the file ──────────────────────────

/** pdf.js — the reader this app previews with, and not the one that wrote it. */
async function readerSays(bytes: Uint8Array, password?: string): Promise<{ pages: number; text: string } | { refused: string }> {
  try {
    const session = await openRender(bytes, password ? { password } : {});
    try {
      const pages = session.numPages;
      const text = (await Promise.all([1, pages].map((page) => session.textItems(page))))
        .map((items) => items.map((item) => item.str).join(' '))
        .join(' | ')
        .trim();
      return { pages, text };
    } finally {
      await session.destroy();
    }
  } catch (error) {
    return { refused: error instanceof Error ? error.message : String(error) };
  }
}

// ── the dictionary ──────────────────────────────────────────────────────────

describe('the encryption dictionary agrees with itself and with the bytes', () => {
  it('writes the /None gate: a revision-4 dictionary that names no cipher', async () => {
    const outcome = await run('protect', {
      mode: 'both', userPassword: USER, ownerPassword: OWNER,
      allowPrinting: false, printLevel: 'low', allowModifying: false, allowCopying: false,
      allowAnnotating: false, allowFillingForms: false, allowAccessibility: true, allowAssembling: false,
    });
    const bytes = await bytesOf(outcome);
    dump('protect-gated.pdf', bytes);
    const body = encryptDictBody(bytes);

    // What R6/AES-256 requires, field by field, and what is here instead. A
    // `/V 5` dictionary needs `/O` and `/U` of 48 bytes plus `/OE`, `/UE` and
    // `/Perms`; this engine has no R6 key schedule, so it writes none of them —
    // and the file used to say `/V 5` anyway, which is why MuPDF refused it with
    // "encryption dictionary missing owner encryption key" and qpdf with "some
    // V=5 encryption dictionary parameters are missing or the wrong type".
    expect(field(body, 'V'), body).toBe('4');
    expect(field(body, 'R'), body).toBe('4');
    expect(field(body, 'Length'), body).toBe('128');
    expect(hexBytes(field(body, 'O')), 'the revision-4 /O is 32 bytes, not the 48 an R6 file needs').toBe(32);
    expect(hexBytes(field(body, 'U')), 'the revision-4 /U is 32 bytes').toBe(32);
    expect(field(body, 'OE'), 'a file with no R6 key schedule must not carry /OE').toBeNull();
    expect(field(body, 'UE'), 'a file with no R6 key schedule must not carry /UE').toBeNull();
    expect(field(body, 'Perms'), 'a file with no R6 key schedule must not carry /Perms').toBeNull();
    expect(body).not.toMatch(/\/AESV2|\/AESV3|\/CFM|\/V 5|\/R 6|\/Length 256/);

    // The claim the dictionary makes about the streams: `/StmF` and `/StrF` are
    // absent, so both take the spec's default — the predefined `/None` filter,
    // "the data are not encrypted". `/CF` is present and empty, which is the
    // spelling all five readers in `protect-readers.py` accept; naming a filter
    // of `/None` outright is what made pypdf and Ghostscript refuse the file.
    expect(field(body, 'CF'), body).toMatch(/^<<\s*>>$/);
    expect(field(body, 'StmF')).toBeNull();
    expect(field(body, 'StrF')).toBeNull();
    expect(field(body, 'EncryptMetadata'), 'the key the /U was derived with assumes metadata is not exempt')
      .toBe('true');

    // And the bytes behind it agree: the page content inflates as it came in, so
    // a reader that obeys `/None` shows the page and a reader that ignores the
    // dictionary lifts the text. Either way nothing is being decrypted — which is
    // what a ciphertext file looks like *not* being, and the shape the readers
    // that mangled this file could not produce.
    const streams = await inflatedStreams(bytes);
    // `drawText` writes the run as a hex string, so the phrase is either in the
    // clear or in its hex spelling — both are plaintext, neither is ciphertext.
    const hexWords = Buffer.from(`${WORDS} on page 1`, 'utf8').toString('hex').toUpperCase();
    expect(streams.includes(WORDS) || streams.includes(hexWords),
      'the page content is plaintext, so it must not be labelled ciphertext').toBe(true);
  }, 300_000);

  it('says in the result what the file is, and never names a strength it did not write', async () => {
    const outcome = await run('protect', { mode: 'both', userPassword: USER, ownerPassword: OWNER });
    const message = outcome.message ?? '';
    expect(message).toMatch(/Protected with an open password/);
    expect(message).toMatch(/no crypt filter[^.]*copied through rather than ciphered/);
    for (const name of ['AES-256', 'AES-128', 'RC4-128', 'RC4-40']) {
      expect(message, `the result still sells ${name}`).not.toContain(name);
    }
    // No warning walks any of it back: the dictionary and the bytes agree, so
    // there is nothing left to admit.
    expect(outcome.warnings.join(' ')).not.toMatch(/does not carry|readers split|No PDF reader could be started/i);
  }, 300_000);
});

// ── the gate, judged by an engine that did not write it ─────────────────────

describe('the gate holds an independent reader and opens for the password', () => {
  it('asks pdf.js for the password, and gives it the page it asked for', async () => {
    const bytes = await bytesOf(await run('protect', { mode: 'both', userPassword: USER, ownerPassword: OWNER }));

    // Without one: the guard refuses, and so does the second implementation.
    const gate = await inspectPdf(bytes, 'claim.pdf');
    expect(gate.encrypted).toBe(true);
    expect(gate.needsPassword).toBe(true);
    expect(gate.algorithm, 'a gate whose crypt filter is /None is not a cipher').toBe('no cipher');
    const refused = await readerSays(bytes);
    expect('refused' in refused, `pdf.js opened a gated file with no password: ${JSON.stringify(refused)}`).toBe(true);

    // With it: pages and words, counted out of the reader rather than echoed
    // from the run. This is the check the old `/V 5 /R 6` file could not pass —
    // pdf.js threw on it with "Invalid argument for stringToBytes".
    const opened = await readerSays(bytes, USER);
    expect('pages' in opened, `pdf.js refused the password it was given: ${JSON.stringify(opened)}`).toBe(true);
    expect((opened as { pages: number }).pages).toBe(3);
    expect((opened as { text: string }).text).toContain('Secret Alice 42 Bravo on page 1');
    // A wrong one is refused, not waved through: the /O and /U are real revision-4
    // hashes, and MuPDF, qpdf and pypdf refuse the same file the same way (the
    // reader that ignores the gate entirely is poppler — see the row).
    const wrong = await readerSays(bytes, 'not-the-password');
    expect('refused' in wrong, `a wrong password got through: ${JSON.stringify(wrong)}`).toBe(true);
  }, 300_000);
});

// ── permissions, out of the integer in the file ─────────────────────────────

describe('the permissions are the file’s, not the form’s', () => {
  it('records every flag it was given, read back bit by bit from the raw /P', async () => {
    const outcome = await run('protect', {
      mode: 'both', userPassword: USER, ownerPassword: OWNER,
      allowPrinting: true, printLevel: 'low', allowModifying: false, allowCopying: false,
      allowAnnotating: true, allowFillingForms: false, allowAccessibility: true, allowAssembling: true,
    });
    const bytes = await bytesOf(outcome);
    const p = rawPermissionValue(bytes);
    expect(permissionBit(p, 3), 'printing').toBe(true);
    expect(permissionBit(p, 12), 'high-resolution printing (the form asked for low)').toBe(false);
    expect(permissionBit(p, 4), 'modification').toBe(false);
    expect(permissionBit(p, 5), 'copying').toBe(false);
    expect(permissionBit(p, 6), 'annotation').toBe(true);
    expect(permissionBit(p, 9), 'form filling').toBe(false);
    expect(permissionBit(p, 10), 'screen readers').toBe(true);
    expect(permissionBit(p, 11), 'page assembly').toBe(true);
    // The sentence the tool speaks is built from these bits, not from the form.
    expect(outcome.message).toMatch(/printing allowed \(low resolution only\)/);
    expect(outcome.message).toMatch(/editing blocked/);
    expect(outcome.message).toMatch(/page assembly allowed/);
    expect(outcome.warnings.join(' ')).not.toMatch(/not what was asked for|did not reach the file/i);
  }, 300_000);

  it('opens a permissions-only file with no password and still refuses the restricted actions', async () => {
    const outcome = await run('protect', {
      mode: 'owner', userPassword: '', ownerPassword: OWNER,
      allowPrinting: false, printLevel: 'low', allowModifying: false, allowCopying: false,
      allowAnnotating: false, allowFillingForms: false, allowAccessibility: true, allowAssembling: false,
    });
    const bytes = await bytesOf(outcome);
    dump('protect-permissions-only.pdf', bytes);

    const p = rawPermissionValue(bytes);
    expect(permissionBit(p, 3), 'printing is refused').toBe(false);
    expect(permissionBit(p, 5), 'copying is refused').toBe(false);
    expect(permissionBit(p, 10), 'screen readers are allowed').toBe(true);

    // It opens: the guard, pdf-lib, and pdf.js all get in with no password at all.
    const gate = await inspectPdf(bytes, 'claim.pdf');
    expect(gate.encrypted).toBe(true);
    expect(gate.needsPassword, 'an empty user password must not ask for one').toBe(false);
    expect(gate.opensWithEmptyPassword).toBe(true);
    expect(gate.pages).toBe(3);
    await expect(PDFDocument.load(bytes)).resolves.toBeTruthy();
    const opened = await readerSays(bytes);
    expect('pages' in opened, `a reader refused a file with no open password: ${JSON.stringify(opened)}`).toBe(true);
    expect(outcome.message).toMatch(/restrictions only — no open password was set/);
    expect(outcome.message).toMatch(/with the restrictions above in force/);
  }, 300_000);
});

// ── protect → unlock, counted on both sides ─────────────────────────────────

describe('protect → unlock hands back the same document', () => {
  it('keeps the pages, the text, the fields and their values, the comments, the bookmarks and the enclosures', async () => {
    const source = await richFixture();
    dump('00-source.pdf', source);
    const before = await structureOf(source);
    expect(before).toMatchObject({
      pages: 3, annotations: 2, annotsEntries: 2, fields: 2, bookmarks: 2, attachments: ['source.csv'],
    });
    const sourceText = await readerSays(source);
    expect('pages' in sourceText).toBe(true);

    const locked = await bytesOf(await run('protect', { mode: 'both', userPassword: USER, ownerPassword: OWNER }));
    const gated = await structureOf(locked);
    expect(gated, 'protect itself lost an object').toEqual(before);

    const unlocked = await run('unlock', { password: USER }, [pdfFile(locked, 'claim.pdf')]);
    const back = await bytesOf(unlocked);
    dump('90-round-trip.pdf', back);

    // The gate is gone — found in the bytes, not in a flag.
    expect(latin1.decode(back.subarray(back.length - 4096))).not.toMatch(/\/Encrypt[\s\d]/);
    expect((await inspectPdf(back, 'claim.pdf')).encrypted).toBe(false);

    // …and everything the run was not asked to change is still there, counted
    // the same way on both sides. "It decrypted" is not the claim; this is.
    expect(await structureOf(back)).toEqual(before);

    // A reader that never saw the password gets the same words out of the
    // round-tripped file as it got out of the source.
    const after = await readerSays(back);
    expect(after).toEqual(sourceText);
    expect(unlocked.warnings.join(' ')).not.toMatch(/did not carry over|missing from the copy|extracts different text/i);
  }, 600_000);
});

// ── the escalation: files a real encryptor wrote ────────────────────────────

/**
 * What this app says about a PDF that is encrypted **for real**.
 *
 * `docs/research/protect-reference.py` writes these with qpdf, so nothing in the
 * set was produced by the engine that now has to read it. The question is not
 * academic: every tool opens a file through `core/doc.ts`, and the fork has no
 * caller for its own `PDFSecurity.decryptStream` either — so a password that
 * pdf.js can pass may still hand the rest of the app ciphertext. Run it with:
 *
 *   ENCRYPTED_INPUTS_DIR=/tmp/ref npx vitest run tests/pdf/protect-spec.test.ts
 *
 * With no directory set the block is skipped: it reports numbers for the
 * `encrypted-inputs` row of docs/TOOL-CAMPAIGN.md, it does not assert them.
 */
const INPUT_DIR = process.env.ENCRYPTED_INPUTS_DIR ?? '';
/** The password `protect-reference.py` encrypted its fixtures with. */
const INPUT_PASSWORD = process.env.ENCRYPTED_INPUTS_PASSWORD ?? 'reader-pass';

async function describeInput(label: string, file: string): Promise<Record<string, string>> {
  const { readFileSync } = await import('node:fs');
  const bytes = new Uint8Array(readFileSync(path.join(INPUT_DIR, file)));
  const row: Record<string, string> = { file: label };
  // Each question is asked on its own, because "the second step throws" is itself
  // one of the numbers this row is for.
  const step = async (name: string, ask: () => Promise<string>) => {
    try {
      row[name] = await ask();
    } catch (error) {
      row[name] = `throws ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
    }
  };

  await step('guard, no password', async () => {
    const blind = await inspectPdf(bytes, file);
    return `encrypted=${blind.encrypted} needsPassword=${blind.needsPassword} algorithm=${blind.algorithm} pages=${blind.pages} error=${blind.error}`;
  });

  await step('guard + password', async () => {
    const keyed = await inspectPdf(bytes, file, { password: INPUT_PASSWORD });
    return `accepted=${keyed.passwordAccepted} pages=${keyed.pages} /P=${keyed.permissions?.raw ?? '—'} error=${keyed.error}`;
  });

  // The preview path — pdf.js, a second implementation that does run the cipher,
  // whatever this app's own engine makes of the same bytes.
  await step('preview (pdf.js)', async () => {
    const preview = await readerSays(bytes, INPUT_PASSWORD);
    return 'pages' in preview
      ? `pages=${preview.pages} text="${preview.text.slice(0, 34)}"`
      : `refuses: ${preview.refused.slice(0, 70)}`;
  });

  // The engine every editing tool actually holds: does page 1 come back as
  // operators, or as ciphertext sitting under its own /Filter?
  await step('pdf-lib page 1', async () => {
    const doc = await PDFDocument.load(bytes, { password: INPUT_PASSWORD, updateMetadata: false });
    const value = doc.getPages()[0].node.get(PDFName.of('Contents'));
    // A page's `/Contents` is usually an array of streams; take the first one and
    // look at its head, because "78 9c" is a zlib stream and anything else under a
    // `/FlateDecode` is ciphertext the engine was never asked to undo.
    const first = value instanceof PDFArray ? value.get(0) : value;
    const resolved = first instanceof PDFRef ? doc.context.lookup(first) : first;
    if (!(resolved instanceof PDFRawStream)) return `${value?.constructor?.name ?? '?'} — not a stream this can read`;
    const head = Array.from(resolved.getContents()).slice(0, 4).map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const filter = resolved.dict.lookupMaybe(PDFName.of('Filter'), PDFName)?.decodeText() ?? '';
    return `${head} /Filter /${filter}${/^78 (01|9c|da)/.test(head) ? ' — flate, so plaintext' : ' — ciphertext behind its own /Filter'}`;
  });

  // A routine edit. `rotate` copies the page tree and re-saves, and the runner
  // re-applies the source's gate to the output — so this file is the answer to
  // "did my edit survive my password?".
  await step('after rotate', async () => {
    const rotated = await run('rotate', { degrees: 90 }, [pdfFile(bytes, file)], INPUT_PASSWORD);
    const out = await bytesOf(rotated);
    dump(`rotated-${label.replace(/[^a-z0-9]+/gi, '-')}.pdf`, out);
    const after = await inspectPdf(out, file, { password: USER });
    const afterReader = await readerSays(out, USER);
    return `encrypted=${after.encrypted} algorithm=${after.algorithm} pages=${after.pages} accepted=${after.passwordAccepted}; pdf.js: ${
      'pages' in afterReader ? `"${afterReader.text.slice(0, 30)}"` : `refuses (${afterReader.refused.slice(0, 45)})`
    }`;
  });

  // And the tool whose whole job is the other direction.
  await step('after unlock', async () => {
    const unlocked = await run('unlock', { password: INPUT_PASSWORD }, [pdfFile(bytes, file)]);
    const freeBytes = await bytesOf(unlocked);
    dump(`unlocked-${label.replace(/[^a-z0-9]+/gi, '-')}.pdf`, freeBytes);
    const free = await readerSays(freeBytes);
    return 'pages' in free
      ? `opens with no password; pdf.js text="${free.text.slice(0, 30)}"`
      : `refuses: ${free.refused.slice(0, 70)}`;
  });

  return row;
}

describe.skipIf(!INPUT_DIR)('what this app says about files a real encryptor wrote', () => {
  it('reports gate, page count, preview, one routine edit and unlock for each', async () => {
    // The three strengths qpdf can write, or whatever else the directory holds —
    // the same questions are asked of this app's own gated file below.
    const known: [string, string][] = [
      ['qpdf RC4-128 (V2/R3)', 'ref-r3-rc4.pdf'],
      ['qpdf AES-128 (V4/R4)', 'ref-r4-aes128.pdf'],
      ['qpdf AES-256 (V5/R6)', 'ref-r6-aes256.pdf'],
    ];
    const present = known.filter(([, file]) => existsSync(path.join(INPUT_DIR, file)));
    const others = readdirSync(INPUT_DIR)
      .filter((file) => file.endsWith('.pdf') && !present.some(([, file2]) => file2 === file))
      .map((file): [string, string] => [file, file]);
    const rows: Record<string, string>[] = [];
    for (const [label, file] of [...present, ...others]) {
      try {
        rows.push(await describeInput(label, file));
      } catch (error) {
        rows.push({ file: label, aborted: error instanceof Error ? error.message : String(error) });
      }
    }
    for (const row of rows) {
      console.log(`\n### ${row.file}`);
      for (const [key, value] of Object.entries(row)) {
        if (key !== 'file') console.log(`  ${key}: ${value}`);
      }
    }
    expect(rows.length).toBeGreaterThanOrEqual(1);
  }, 600_000);
});
