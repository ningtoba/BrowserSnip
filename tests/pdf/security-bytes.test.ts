/**
 * Byte-level proof for the security category (worker SECURITY-2).
 *
 * `edge-security.test.ts` covers the edges — the wrong password, the empty file,
 * the page that does not exist, a signature that was tampered with. This file
 * covers the promises themselves, and it reads them out of the bytes the tools
 * wrote rather than out of the tool's own `message`:
 *
 *   * **protect** — the `/Encrypt` dictionary, the two password hashes and the
 *     `/P` bits are found in the file by hand, and the page count is read back
 *     *through* the password.
 *   * **permissions only** — a bare `PDFDocument.load` with no password option
 *     gets in, and the same file's `/P` value refuses printing and copying at the
 *     bit level (ISO 32000-1 Table 25), decoded here instead of by `core/guard`.
 *   * **empty password** — nothing may call a file with an empty user password
 *     "protected", including the metadata report.
 *   * **wrong password** — the run raises the re-prompt error and hands back no
 *     file at all; the source bytes still carry their gate.
 *   * **metadata** — removal clears `/Info` **and** the XMP packet, whether the
 *     packet is an indirect object or inlined into the catalog.
 *   * **protect → unlock** — the round trip is judged on what it kept: page count,
 *     the text a reader extracts, every field and its value, the comment popovers,
 *     the outline and the enclosures. "Did it decrypt" is not the question; "did
 *     it survive" is.
 *
 * Two checks deliberately bypass this app's own object model: `node:zlib`
 * inflates the streams it reads, and the `/P` integer is taken off the raw file
 * with a regex, so a helper that is wrong in the same way twice cannot hide it.
 *
 * `digital-sign-pdf`, `validate-signature-pdf` and `timestamp-pdf` are proven on
 * bytes in `edge-security.test.ts` (sign → read back → tamper → re-validate), so
 * they are only listed in the coverage check at the bottom of this file.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import { inflateSync } from 'node:zlib';
import {
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFTextField,
  StandardFonts,
  degrees,
  rgb,
} from '@maxwbh/pdf-lib';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import { securityTools } from '@/lib/pdf/tools/security';
import { inspectPdf } from '@/lib/pdf/core/guard';
import { saveEncrypted } from '@/lib/pdf/core/doc';
import { openRender } from '@/lib/pdf/core/render';
import { pageContentStreams } from '@/lib/pdf/core/content';
import { readInfo, readXmp, toLocalBytes, writeInfo, writeXmp } from '@/lib/pdf/core/metadata';
import { addAnnotation, annotationCount, listAnnotations } from '@/lib/pdf/core/annotations';
import { addAttachments } from '@/lib/pdf/core/attachments';
import { listAttachments } from '@/lib/pdf/core/attachments';
import { readOutline, writeOutline } from '@/lib/pdf/core/bookmarks';
import { readZip } from '@/lib/pdf/core/archive';
import type { PdfToolDefinition, ToolValues } from '@/lib/pdf/tools/types';

const latin1 = new TextDecoder('latin1');

/**
 * pdf.js points its worker at `import.meta.url`, which under Vite's transform is
 * an http URL Node's ESM loader refuses, and `openRender` re-assigns it on every
 * call — so a one-off write gets overwritten. A setter keeps the on-disk path.
 * Page *rendering* still needs a canvas, which jsdom has none of; this file only
 * asks pdf.js to open documents, count their pages and extract their text.
 */
beforeAll(() => {
  let workerPath = `file://${process.cwd()}/node_modules/pdfjs-dist/build/pdf.worker.mjs`;
  Object.defineProperty(GlobalWorkerOptions, 'workerSrc', {
    configurable: true,
    get: () => workerPath,
    set: (value: string) => {
      if (value.startsWith('file:') || value.startsWith('data:')) workerPath = value;
    },
  });
});

// ── fixtures ────────────────────────────────────────────────────────────────

const WORDS = 'Secret Alice 42 Bravo';

/** Three text pages, the last one turned a quarter turn. */
async function textFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < 3; index++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`${WORDS} on page ${index + 1}`, { x: 60, y: 700, size: 18, font, color: rgb(0, 0, 0) });
    if (index === 2) page.setRotation(degrees(90));
  }
  return doc.save({ useObjectStreams: false });
}

/**
 * Everything a password removal is known to lose, plus the properties and the
 * XMP packet repeating the same words: two filled fields, a comment with text in
 * it, two bookmarks and an enclosure.
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
  writeOutline(doc, [{ title: 'Chapter Bravo', page: 0 }, { title: 'Intro', page: 1 }]);
  await addAttachments(doc, [
    { name: 'source.csv', bytes: new TextEncoder().encode('a,b\n1,2\n'), mimeType: 'text/csv' },
  ]);
  writeInfo(doc, {
    title: 'Secret Alice',
    author: 'Ada Lovelace',
    subject: 'Bravo file',
    keywords: 'Alice, Bravo',
    creator: 'Fixture Maker',
    producer: 'Fixture Writer',
    creationDate: "D:20010203040506Z",
    modDate: "D:20010203040506Z",
    lang: 'en-GB',
  });
  writeXmp(doc, xmpPacket('Secret Alice', 2, 'B'));
  return doc.save({ useObjectStreams: false });
}

function xmpPacket(title: string, pdfaPart: number, conformance: string): string {
  return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>`
    + `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999-02-22-rdf-syntax-ns#">`
    + `<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">`
    + `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${title}</rdf:li></rdf:Alt></dc:title>`
    + `</rdf:Description>`
    + `<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">`
    + `<pdfaid:part>${pdfaPart}</pdfaid:part><pdfaid:conformance>${conformance}</pdfaid:conformance>`
    + `</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
}

/** A page with something drawn on it and no text layer, which is a scan's shape. */
async function silentFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  page.drawRectangle({ x: 40, y: 400, width: 200, height: 100, color: rgb(0, 0, 0) });
  return doc.save({ useObjectStreams: false });
}

/** One page with words and one without, so a partial failure is visible. */
async function halfSilentFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText('First page words', { x: 60, y: 700, size: 18, font, color: rgb(0, 0, 0) });
  doc.addPage([595, 842]);
  return doc.save({ useObjectStreams: false });
}

// ── byte readers ────────────────────────────────────────────────────────────

function pdfFile(bytes: Uint8Array, name: string): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });
}

interface RunOutcome {
  outputs: { blob: Blob; name: string }[];
  message?: string;
  warnings: string[];
  report?: { sections: { title: string; rows?: { label: string; value: string }[] }[]; message?: string };
}

async function run(id: string, values: ToolValues = {}, files?: File[], password?: string): Promise<RunOutcome> {
  const tool = getPdfTool(id) as PdfToolDefinition | undefined;
  expect(tool, `tool "${id}" is not registered`).toBeTruthy();
  const inputs = files ?? [pdfFile(await textFixture(), 'fixture.pdf')];
  return (await runPdfTool({
    toolId: id, files: inputs, values, password, onProgress: () => {}, onLog: () => {},
  })) as unknown as RunOutcome;
}

async function bytesOf(outcome: RunOutcome, index = 0): Promise<Uint8Array> {
  expect(outcome.outputs.length, 'the tool produced no output').toBeGreaterThan(index);
  return new Uint8Array(await outcome.outputs[index].blob.arrayBuffer());
}

/** Every stream in the file, inflated with `node:zlib` — no pdf-lib decoding. */
async function inflatedStreams(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const parts: string[] = [];
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const stored = object.getContents();
    try {
      parts.push(latin1.decode(inflateSync(Buffer.from(stored))));
    } catch {
      // Not flate (an image, or stored raw): the stored bytes are the answer.
      parts.push(latin1.decode(stored));
    }
  }
  return parts.join('\n');
}

/**
 * Whether a phrase is still in the file as written.
 *
 * `drawText` stores a run as a hex string, so the ASCII phrase never appears in
 * a content stream — its hex spelling is the byte-level form of "is this text
 * still here", and a redaction that split the run can no longer satisfy it.
 */
async function streamsHoldPhrase(bytes: Uint8Array, phrase: string): Promise<boolean> {
  const all = await inflatedStreams(bytes);
  const hex = Buffer.from(phrase, 'utf8').toString('hex').toUpperCase();
  return all.includes(phrase) || all.includes(hex) || latin1.decode(bytes).includes(phrase);
}

/** The pages' own content, concatenated — what "the page is unchanged" means. */
async function pageContent(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  return doc
    .getPages()
    .map((page, index) => `page ${index + 1}\n${pageContentStreams(page).map((stream) => latin1.decode(stream.bytes)).join('\n')}`)
    .join('\n');
}

/** The raw `/P` integer from the encryption dictionary, read off the file. */
function rawPermissionValue(bytes: Uint8Array): number {
  const match = /\/P\s+(-?\d+)/.exec(latin1.decode(bytes));
  expect(match, 'the saved file has no /P value').not.toBeNull();
  return Number(match![1]);
}

/** ISO 32000-1 Table 25: bit `n` (1-based) of `/P`, as a boolean. */
function permissionBit(value: number, bit: number): boolean {
  return ((value >> (bit - 1)) & 1) === 1;
}

/** What a PDF reader — not this app's writer — can extract from one page. */
async function readerText(bytes: Uint8Array, page = 1, password?: string): Promise<string> {
  const session = await openRender(bytes, password ? { password } : {});
  try {
    return (await session.textItems(page)).map((item) => item.str).join(' ').trim();
  } finally {
    await session.destroy();
  }
}

async function readerPageCount(bytes: Uint8Array, password?: string): Promise<number> {
  const session = await openRender(bytes, password ? { password } : {});
  try {
    return session.numPages;
  } finally {
    await session.destroy();
  }
}

/** Every `/P` off except screen readers, and low-resolution printing. */
const RESTRICTIVE: ToolValues = {
  allowPrinting: false,
  printLevel: 'low',
  allowModifying: false,
  allowCopying: false,
  allowAnnotating: false,
  allowFillingForms: false,
  allowAccessibility: true,
  allowAssembling: false,
};

// ── protect ─────────────────────────────────────────────────────────────────

describe('protect writes the gate it promises, and the bytes agree', () => {
  it('records /Encrypt, the hashes and the /P bits, then opens on the password with the page count read back', async () => {
    const outcome = await run('protect', {
      mode: 'both', userPassword: 'open-sesame', ownerPassword: 'owner-key', version: '5', ...RESTRICTIVE,
    });
    const bytes = await bytesOf(outcome);
    const raw = latin1.decode(bytes);

    // The dictionary, found by hand rather than through the guard.
    expect(raw).toMatch(/\/Encrypt\s+\d+\s+\d+\s+R/);
    expect(raw).toMatch(/\/Filter\s*\/Standard/);
    expect(raw).toMatch(/\/O\s*<[0-9A-Fa-f]+>/);
    expect(raw).toMatch(/\/U\s*<[0-9A-Fa-f]+>/);
    // …and what it really writes for the AES-256 option: a 256-bit /V and /R
    // beside a 128-bit crypt filter. The mismatch is the defect named in
    // docs/tasks/security2-request.md; the tool has to say it out loud.
    expect(raw).toMatch(/\/V 5/);
    expect(raw).toMatch(/\/R 6/);
    expect(raw).toMatch(/\/Length 256/);
    expect(raw).toMatch(/\/CFM\s*\/AESV2/);

    // Table 25, bit by bit, out of the integer sitting in the file.
    const p = rawPermissionValue(bytes);
    expect(permissionBit(p, 3), 'printing').toBe(false);
    expect(permissionBit(p, 4), 'modification').toBe(false);
    expect(permissionBit(p, 5), 'copying').toBe(false);
    expect(permissionBit(p, 6), 'annotation').toBe(false);
    expect(permissionBit(p, 9), 'form filling').toBe(false);
    expect(permissionBit(p, 10), 'screen readers').toBe(true);
    expect(permissionBit(p, 11), 'assembly').toBe(false);
    expect(permissionBit(p, 12), 'high-resolution printing').toBe(false);

    // Without the password the file asks for one; the page count comes back with it.
    const locked = await inspectPdf(bytes, 'out.pdf');
    expect(locked.encrypted).toBe(true);
    expect(locked.needsPassword).toBe(true);
    expect(locked.error).toBe('PASSWORD_REQUIRED');
    const opened = await inspectPdf(bytes, 'out.pdf', { password: 'open-sesame' });
    expect(opened.passwordAccepted).toBe(true);
    expect(opened.error).toBeNull();
    // Decrypted with the password, the page count comes back — the number is read
    // out of the opened file, not carried over from the run.
    expect(opened.pages).toBe(3);
    const decrypted = await PDFDocument.load(bytes, { password: 'open-sesame', updateMetadata: false });
    expect(decrypted.getPageCount()).toBe(3);
    expect(await streamsHoldPhrase(bytes, 'Bravo on page 2')).toBe(true);
    // A second reader is asked too, and whichever answer it gave the result says
    // that and not the other: this browser's engine writes the gate but cannot
    // hand the cipher back to pdf.js, which is the defect the warning carries.
    const readerOpens = await readerPageCount(bytes, 'open-sesame').then(() => true, () => false);
    if (readerOpens) {
      expect(outcome.message).toMatch(/A PDF reader opened the copy with that password and read 3 page\(s\)/);
    } else {
      expect(outcome.warnings.join(' ')).toMatch(/A PDF reader refused the password|No PDF reader could be started/i);
      expect(outcome.message).toMatch(/no independent reader could confirm the gate/);
    }

    // The tool's sentence is about the file, and it admits the one thing the
    // bytes will not support: that the page streams came out as they went in.
    expect(outcome.message).toMatch(/AES-256 and an open password/);
    expect(outcome.message).toMatch(/printing blocked/);
    expect(outcome.message).toMatch(/screen readers allowed/);
    expect(outcome.warnings.join(' ')).toMatch(/not rewritten as ciphertext|ignores \/Encrypt/i);
    expect(outcome.warnings.join(' ')).toMatch(/crypt filter declares \/AESV2/i);
    expect(await streamsHoldPhrase(bytes, WORDS)).toBe(true);
  }, 300_000);

  it('does not promise ciphertext it does not write', () => {
    const tool = getPdfTool('protect')!;
    const help = tool.fields?.find((field) => field.key === 'userPassword')?.help ?? '';
    expect(help).toMatch(/ignores \/Encrypt/);
    expect(help).not.toMatch(/the bytes are encrypted/i);
    expect(tool.description).not.toMatch(/real AES/i);
    const notes = tool.notes?.join(' ') ?? '';
    expect(notes).toMatch(/copied through as they are/i);
    // The capability the engine does not have names a real alternative instead of
    // quietly faking the output.
    expect(notes).toMatch(/PDF to Images/i);
  });

  it('leaves the owner password the user typed alone, rather than re-encrypting over it', async () => {
    const outcome = await run(
      'protect',
      { mode: 'both', userPassword: 'open-sesame', ownerPassword: 'owner-key', version: '4', ...RESTRICTIVE },
      undefined,
      'open-sesame',
    );
    const bytes = await bytesOf(outcome);
    const guard = await inspectPdf(bytes, 'out.pdf', { password: 'owner-key' });
    expect(guard.passwordAccepted, 'the owner password must still be the owner password').toBe(true);
    expect(latin1.decode(bytes)).toMatch(/\/P\s+-?\d+/);
    // Both passwords were named, so the "one password does both jobs" warning is
    // not earned here — and it must be when the owner box is left empty.
    expect(outcome.warnings.join(' ')).not.toMatch(/also the owner password/i);
    const shared = await run('protect', { mode: 'user', userPassword: 'same-one', version: '4', ...RESTRICTIVE });
    expect(shared.warnings.join(' ')).toMatch(/also the owner password/i);
  }, 300_000);
});

// ── permissions only, and the empty password ────────────────────────────────

describe('a permissions-only file is restricted, not locked', () => {
  it('opens with no password yet refuses the restricted actions at the bit level', async () => {
    const outcome = await run('protect', {
      mode: 'owner', userPassword: '', ownerPassword: 'owner-key', version: '4', ...RESTRICTIVE,
    });
    const bytes = await bytesOf(outcome);

    // The reader's point of view: no password option at all, no ignoreEncryption.
    const reader = await PDFDocument.load(bytes);
    expect(reader.getPageCount()).toBe(3);
    const p = rawPermissionValue(bytes);
    expect(permissionBit(p, 3), 'printing is refused').toBe(false);
    expect(permissionBit(p, 5), 'copying is refused').toBe(false);
    expect(permissionBit(p, 6), 'comments are refused').toBe(false);
    expect(permissionBit(p, 10), 'screen readers are allowed').toBe(true);

    const gate = await inspectPdf(bytes, 'out.pdf');
    expect(gate.encrypted).toBe(true);
    expect(gate.needsPassword).toBe(false);
    expect(gate.opensWithEmptyPassword).toBe(true);
    expect(gate.pages).toBe(3);

    // Nothing in the result may call this a file that asks for a password.
    expect(outcome.message).toMatch(/restrictions only — no open password was set/);
    expect(outcome.message).not.toMatch(/and an open password/);
    expect(outcome.warnings.join(' ')).not.toMatch(/does not open on the empty password/i);
    // The reader claim is checked, never assumed: whichever answer pdf.js gave,
    // the result says that and not the other.
    const readerOpens = await readerPageCount(bytes).then(() => true, () => false);
    if (readerOpens) {
      expect(outcome.message).toMatch(/A PDF reader opened the copy with no password/);
    } else {
      expect(outcome.warnings.join(' ')).toMatch(/will not open the saved file without one|No PDF reader could be started/i);
    }
  }, 300_000);

  it('reports an empty user password as no password in View Metadata', async () => {
    const locked = await bytesOf(await run('protect', {
      mode: 'owner', userPassword: '', ownerPassword: 'owner-key', version: '4', ...RESTRICTIVE,
    }));
    const outcome = await run('view-metadata', {}, [pdfFile(locked, 'restricted.pdf')]);
    const rows = new Map(
      outcome.report?.sections.find((section) => section.title === 'Protection')?.rows?.map((row) => [row.label, row.value]),
    );
    expect(rows.get('Encrypted')).toBe('yes');
    expect(rows.get('Open password'), 'an empty user password is not a lock').toMatch(/none|without one/i);
    expect(rows.get('Open password')).not.toMatch(/^required$/);
    expect(rows.get('Restrictions recorded')).toMatch(/printing blocked/);
    // The raw /P the report prints is the integer in the file.
    expect(Number(rows.get('Raw /P value'))).toBe(rawPermissionValue(locked));
    // And the file the report describes really is readable: pages counted.
    expect(outcome.report?.sections.find((section) => section.title === 'File')?.rows)
      .toContainEqual({ label: 'Pages', value: '3' });
  }, 300_000);

  it('change-permissions rewrites the bits and leaves the file opening freely', async () => {
    const outcome = await run('change-permissions', {
      action: 'set', ownerPassword: 'owner-key', version: '4',
      allowPrinting: true, printLevel: 'low', allowModifying: true, allowCopying: false,
      allowAnnotating: true, allowFillingForms: true, allowAccessibility: true, allowAssembling: false,
    });
    const bytes = await bytesOf(outcome);
    const p = rawPermissionValue(bytes);
    expect(permissionBit(p, 3)).toBe(true);
    expect(permissionBit(p, 12), 'low-resolution printing only').toBe(false);
    expect(permissionBit(p, 5), 'copying stays refused').toBe(false);
    expect(permissionBit(p, 6)).toBe(true);
    const reader = await PDFDocument.load(bytes);
    expect(reader.getPageCount()).toBe(3);
    expect(outcome.message).toMatch(/printing allowed \(low resolution only\)/);
    expect(await streamsHoldPhrase(bytes, WORDS)).toBe(true);

    const cleared = await run('change-permissions', { action: 'clear', ownerPassword: 'owner-key' }, [pdfFile(bytes, 'restricted.pdf')]);
    const clearedBytes = await bytesOf(cleared);
    expect(latin1.decode(clearedBytes)).not.toMatch(/\/Encrypt[\s\d]/);
    expect(await readerPageCount(clearedBytes)).toBe(3);
    expect(cleared.message).toMatch(/3 page\(s\)/);
    // Clearing is a trailer edit, so the pages keep their words.
    expect(await streamsHoldPhrase(clearedBytes, WORDS)).toBe(true);
  }, 300_000);
});

// ── the wrong password ──────────────────────────────────────────────────────

describe('a wrong password re-prompts and produces no file', () => {
  it('raises BAD_PASSWORD without writing a half-decrypted document', async () => {
    const locked = await bytesOf(await run('protect', {
      mode: 'user', userPassword: 'open-sesame', ownerPassword: '', version: '4', ...RESTRICTIVE,
    }));
    let failure: (Record<string, unknown> & { code?: string; message?: string }) | null = null;
    try {
      await run('unlock', { password: 'wrong-sesame' }, [pdfFile(locked, 'contract.pdf')]);
    } catch (error) {
      failure = error as Record<string, unknown> & { code?: string; message?: string };
    }
    expect(failure, 'the run should have been refused').not.toBeNull();
    expect(failure!.code).toBe('BAD_PASSWORD');
    expect(failure!.passwordRequired, 'the UI must ask again, not report a crash').toBe(true);
    expect(failure!.message).toMatch(/contract\.pdf/);
    expect(failure!.message).not.toMatch(/corrupt|damaged/i);
    expect(failure!.outputs ?? [], 'no file may be handed back').toHaveLength(0);

    // The source is untouched: still gated, still carrying its user-password hash.
    const after = await inspectPdf(locked, 'contract.pdf');
    expect(after.encrypted).toBe(true);
    expect(after.needsPassword).toBe(true);
    expect(latin1.decode(locked)).toMatch(/\/U\s*<[0-9A-Fa-f]+>/);
  }, 300_000);

  it('still opens a restricted-but-readable file when the password box is empty', async () => {
    const restricted = await bytesOf(await run('protect', {
      mode: 'owner', userPassword: '', ownerPassword: 'owner-key', version: '4', ...RESTRICTIVE,
    }));
    const outcome = await run('unlock', {}, [pdfFile(restricted, 'restricted.pdf')]);
    expect(outcome.message).toMatch(/Removed protection/);
    const bytes = await bytesOf(outcome);
    expect(latin1.decode(bytes)).not.toMatch(/\/Encrypt[\s\d]/);
    expect((await inspectPdf(bytes, 'unlocked.pdf')).encrypted).toBe(false);
    expect(await readerPageCount(bytes)).toBe(3);
  }, 300_000);
});

// ── protect → unlock round trip ─────────────────────────────────────────────

describe('the protect → unlock round trip keeps everything it was not asked to change', () => {
  it('leaves the page count, the extractable text, the filled fields, the comments, the outline and the enclosures', async () => {
    const source = await richFixture();
    const before = await PDFDocument.load(source, { updateMetadata: false });
    const sourcePages = await Promise.all([1, 2, 3].map((page) => readerText(source, page)));

    const locked = await bytesOf(await run('protect', {
      mode: 'both', userPassword: 'open-sesame', ownerPassword: 'owner-key', version: '4', ...RESTRICTIVE,
    }, [pdfFile(source, 'claim.pdf')]));
    expect(latin1.decode(locked)).toMatch(/\/Encrypt\s+\d+\s+\d+\s+R/);

    const unlocked = await run('unlock', { password: 'open-sesame' }, [pdfFile(locked, 'claim.pdf')]);
    const bytes = await bytesOf(unlocked);

    // Gate gone, found in the bytes rather than in a flag.
    expect(latin1.decode(bytes)).not.toMatch(/\/Encrypt[\s\d]/);
    const gate = await inspectPdf(bytes, 'claim.pdf');
    expect(gate.encrypted).toBe(false);
    expect(gate.error).toBeNull();
    expect(gate.pages).toBe(3);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(3);

    // The text a reader lifts out is the text that went in, page for page.
    const afterPages = await Promise.all([1, 2, 3].map((page) => readerText(bytes, page)));
    expect(afterPages).toEqual(sourcePages);
    expect(afterPages[0]).toContain('Secret Alice 42 Bravo on page 1');

    // The parts a page-tree rebuild drops are all still there, values included.
    const after = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(after.getForm().getFields().map((field) => field.getName()))
      .toEqual(before.getForm().getFields().map((field) => field.getName()));
    const typedBefore = before.getForm().getField('applicant.name');
    const agreedBefore = before.getForm().getField('agree');
    const typed = after.getForm().getField('applicant.name');
    const agreed = after.getForm().getField('agree');
    expect(typed).toBeInstanceOf(PDFTextField);
    expect(agreed).toBeInstanceOf(PDFCheckBox);
    // The answers, not just the field names: an unlock that reset the form would
    // still report two fields carried over.
    expect((typed as PDFTextField).getText(), 'the answer that was typed is still typed')
      .toBe((typedBefore as PDFTextField).getText());
    expect((typed as PDFTextField).getText()).toBe('Ada Lovelace');
    expect((agreed as PDFCheckBox).isChecked(), 'the tick state is the state that was stored')
      .toBe((agreedBefore as PDFCheckBox).isChecked());

    expect(listAnnotations(after).map((mark) => [mark.kind, mark.contents]))
      .toEqual(listAnnotations(before).map((mark) => [mark.kind, mark.contents]));
    expect(annotationCount(after)).toBe(annotationCount(before));
    expect(readOutline(after).map((node) => node.title)).toEqual(['Chapter Bravo', 'Intro']);
    expect(listAttachments(after).map((file) => [file.name, latin1.decode(file.bytes)]))
      .toEqual([['source.csv', 'a,b\n1,2\n']]);
    // The properties survived a password round trip too.
    expect(readInfo(after).title).toBe('Secret Alice');

    // Nothing was admitted as lost, and no claim outruns the file.
    const warnings = unlocked.warnings.join(' ');
    expect(warnings).not.toMatch(/did not carry over|missing from the copy|differently/i);
    expect(unlocked.message).toMatch(/carrying 2 form field\(s\), 1 annotation\(s\) \/ comment\(s\), 2 bookmark\(s\), 1 embedded file\(s\)/);
    expect(unlocked.message).toMatch(/page content verified/);
  }, 300_000);

  it('remove-restrictions clears the dictionary without touching the pages', async () => {
    const source = await richFixture();
    const locked = await saveEncrypted(await PDFDocument.load(source), {
      userPassword: '', ownerPassword: 'owner-key', version: 4,
      permissions: { printing: false, copying: false },
    });
    const outcome = await run('remove-restrictions', {}, [pdfFile(locked, 'claim.pdf')], 'owner-key');
    const bytes = await bytesOf(outcome);
    const raw = latin1.decode(bytes);
    expect(raw).not.toMatch(/\/Encrypt[\s\d]/);
    expect(raw, 'the /P dictionary went with it').not.toMatch(/\/P\s+-?\d+/);
    expect(await readerText(bytes, 1)).toContain('Bravo');
    expect(await pageContent(bytes)).toBe(await pageContent(source));
    expect(listAttachments(await PDFDocument.load(bytes)).map((file) => file.name)).toEqual(['source.csv']);
    expect(outcome.warnings.join(' ')).not.toMatch(/did not carry over/i);
  }, 300_000);

  it('says so when the source has no gate at all, and returns the same bytes', async () => {
    const source = await textFixture();
    const outcome = await run('unlock', {}, [pdfFile(source, 'free.pdf')]);
    expect(outcome.message).toMatch(/is not password protected/);
    expect(await bytesOf(outcome)).toEqual(source);
  }, 300_000);
});

// ── metadata ────────────────────────────────────────────────────────────────

describe('remove-metadata clears /Info and the XMP packet', () => {
  it('empties the properties, deletes the indirect packet, and leaves the page alone', async () => {
    const source = await richFixture();
    expect(await streamsHoldPhrase(source, 'Secret Alice')).toBe(true);

    const outcome = await run('remove-metadata', { info: true, xmp: true, attachments: false, readerSettings: true }, [pdfFile(source, 'claim.pdf')]);
    const bytes = await bytesOf(outcome);
    expect(outcome.message).toMatch(/Removed \d propert/);
    expect(outcome.message).toMatch(/XMP packet/);

    const raw = latin1.decode(bytes);
    // Nothing a reader shows under "Properties" survives.
    // The dates are checked through `/Info` below: an embedded file's `/Params`
    // legitimately carries its own `/CreationDate`, and it must survive.
    for (const key of ['/Title', '/Author', '/Subject', '/Keywords', '/Creator']) {
      expect(raw, `${key} survived the strip`).not.toContain(key);
    }
    const reloaded = await PDFDocument.load(bytes, { updateMetadata: false });
    const info = readInfo(reloaded);
    expect(info.title).toBeUndefined();
    expect(info.author).toBeUndefined();
    expect(info.lang, 'the catalog /Lang went too').toBeUndefined();
    expect(info.creationDate, 'the /Info dates went too').toBeUndefined();
    expect(info.modDate).toBeUndefined();
    expect(readXmp(reloaded), 'the XMP packet is gone, not merely empty').toBeNull();
    expect(raw).not.toMatch(/\/Metadata\s+\d+\s+\d+\s+R/);
    expect(raw).not.toContain('xmpmeta');
    expect(await inflatedStreams(bytes)).not.toContain('xmpmeta');

    // The document itself is untouched, and the enclosure was not selected.
    expect(reloaded.getPageCount()).toBe(3);
    expect(await streamsHoldPhrase(bytes, WORDS)).toBe(true);
    expect(listAttachments(reloaded).map((file) => file.name)).toEqual(['source.csv']);

    const second = await run('remove-metadata', { info: true, xmp: true, attachments: false, readerSettings: true }, [pdfFile(bytes, 'clean.pdf')]);
    expect(second.message).toMatch(/Nothing was removed/);
    expect(second.warnings.join(' ')).toMatch(/the output is the same document/i);
  }, 300_000);

  it('clears an XMP packet that a producer inlined into the catalog', async () => {
    const doc = await PDFDocument.load(await textFixture());
    const inlined = doc.context.stream(
      toLocalBytes(new TextEncoder().encode(xmpPacket('Inlined Alice', 1, 'A'))),
      { Type: 'Metadata', Subtype: 'XML' },
    );
    doc.catalog.set(PDFName.of('Metadata'), inlined);
    writeInfo(doc, { title: 'Inlined Alice' });
    const bytes = await doc.save({ useObjectStreams: false });

    const seen = await run('view-metadata', {}, [pdfFile(bytes, 'inline.pdf')]);
    expect(
      seen.report?.sections.find((section) => section.title === 'XMP metadata')?.rows?.map((row) => row.value),
    ).toContain('Inlined Alice');

    const outcome = await run('remove-metadata', { info: true, xmp: true, attachments: false, readerSettings: false }, [pdfFile(bytes, 'inline.pdf')]);
    expect(outcome.message).toMatch(/XMP packet/);
    const stripped = await bytesOf(outcome);
    expect(latin1.decode(stripped)).not.toContain('xmpmeta');
    expect(readXmp(await PDFDocument.load(stripped, { updateMetadata: false }))).toBeNull();
    expect((await PDFDocument.load(stripped, { updateMetadata: false })).catalog.get(PDFName.of('Metadata'))).toBeUndefined();
  }, 300_000);

  it('does not count a store that was never there', async () => {
    const doc = await PDFDocument.load(await textFixture());
    const bytes = await doc.save({ useObjectStreams: false });
    const outcome = await run('remove-metadata', { info: true, xmp: true, attachments: true, readerSettings: true }, [pdfFile(bytes, 'bare.pdf')]);
    // pdf-lib stamps Producer/Creator and the dates on save, so the strip does
    // have something to remove; what must not happen is claiming the rest.
    expect(outcome.message).toMatch(/Removed \d propert/);
    expect(outcome.message).not.toMatch(/reader settings/i);
    expect(outcome.message).not.toMatch(/embedded file/i);
    expect(outcome.message).not.toMatch(/XMP packet/i);
  }, 300_000);

  it('removes the embedded files only when it was asked to', async () => {
    const source = await richFixture();
    const kept = await bytesOf(await run('remove-metadata', { info: true, xmp: true, attachments: false, readerSettings: false }, [pdfFile(source, 'claim.pdf')]));
    expect(listAttachments(await PDFDocument.load(kept, { updateMetadata: false }))).toHaveLength(1);
    const cleared = await bytesOf(await run('remove-metadata', { info: false, xmp: false, attachments: true, readerSettings: false }, [pdfFile(source, 'claim.pdf')]));
    const doc = await PDFDocument.load(cleared, { updateMetadata: false });
    expect(listAttachments(doc)).toHaveLength(0);
    expect(readInfo(doc).title, 'the properties were not in scope').toBe('Secret Alice');
  }, 300_000);
});

describe('edit-metadata changes the properties and nothing else', () => {
  it('writes the /Info strings, the catalog language and a matching XMP packet, and keeps the PDF/A identity', async () => {
    const source = await richFixture();
    const contentBefore = await pageContent(source);
    const outcome = await run('edit-metadata', {
      title: 'Renamed Claim', author: 'Grace Hopper', subject: '', keywords: 'one, two',
      creator: 'Original App', producer: 'Rewritten Writer', docLanguage: 'de-DE',
      syncXmp: true, touchDates: true,
    }, [pdfFile(source, 'claim.pdf')]);
    const bytes = await bytesOf(outcome);
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const info = readInfo(doc);
    expect(info.title).toBe('Renamed Claim');
    expect(info.author).toBe('Grace Hopper');
    expect(info.subject, 'a blank field keeps the current value').toBe('Bravo file');
    expect(info.keywords).toBe('one, two');
    expect(info.creator).toBe('Original App');
    expect(info.producer).toBe('Rewritten Writer');
    expect(info.lang).toBe('de-DE');
    expect(info.modDate).not.toBe('D:20010203040506Z');
    expect(info.creationDate, 'the control reads "modification date", so the birthday stays').toBe('D:20010203040506Z');

    const xmp = readXmp(doc);
    expect(xmp?.title).toBe('Renamed Claim');
    expect(xmp?.creator).toBe('Grace Hopper');
    expect(xmp?.keywords).toEqual(['one', 'two']);
    expect(xmp?.pdfaPart, 'editing properties must not un-archive the file').toBe(2);
    expect(xmp?.pdfaConformance).toBe('B');
    expect(xmp?.raw).toContain('Renamed Claim');

    // The promise: the pages are left exactly as they were.
    expect(await pageContent(bytes)).toBe(contentBefore);
    expect(doc.getPageCount()).toBe(3);
    expect(await readerText(bytes, 1)).toContain(WORDS);
    expect(outcome.message).toMatch(/Updated the document properties/);
  }, 300_000);

  it('leaves the dates alone when the toggle is off, and the packet alone when sync is off', async () => {
    const source = await richFixture();
    const bytes = await bytesOf(await run('edit-metadata', {
      title: 'Only The Title', syncXmp: false, touchDates: false,
    }, [pdfFile(source, 'claim.pdf')]));
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const info = readInfo(doc);
    expect(info.title).toBe('Only The Title');
    expect(info.modDate, 'the modification date was not asked for').toBe('D:20010203040506Z');
    expect(readXmp(doc)?.title, 'the two stores may now disagree, and the panel says so').toBe('Secret Alice');
  }, 300_000);

  it('keeps a permissions-only file protected while it renames it', async () => {
    // The settled ruling: an unrelated operation must not quietly unlock a file.
    const locked = await bytesOf(await run('protect', {
      mode: 'owner', userPassword: '', ownerPassword: 'owner-key', version: '4', ...RESTRICTIVE,
    }));
    const outcome = await run('edit-metadata', { title: 'Renamed', syncXmp: false, touchDates: true }, [pdfFile(locked, 'locked.pdf')]);
    const bytes = await bytesOf(outcome);
    const gate = await inspectPdf(bytes, 'renamed.pdf');
    expect(gate.encrypted, 'the gate survived the rename').toBe(true);
    expect(gate.opensWithEmptyPassword).toBe(true);
    expect(rawPermissionValue(bytes)).toBe(rawPermissionValue(locked));
    expect(outcome.warnings.join(' ')).not.toMatch(/without a password/i);
    expect(readInfo(await PDFDocument.load(bytes, { updateMetadata: false })).title).toBe('Renamed');
  }, 300_000);
});

// ── redaction ───────────────────────────────────────────────────────────────

describe('redact-pdf deletes the words, and proves it from the saved file', () => {
  it('takes the phrase out of the page content, not just off the screen', async () => {
    const source = await textFixture();
    expect(await streamsHoldPhrase(source, 'Bravo on page 1')).toBe(true);
    const outcome = await run('redact-pdf', {
      fill: '#000000', alsoMetadata: false,
      // Displayed-page coordinates: the run sits at user-space y 700 of an
      // 842 pt sheet, so its top is 842 - 700 - 18 ≈ 124 from the top; the box
      // spans the whole line, which is what a clean redaction needs.
      regions: [{ page: 0, x: 40, y: 110, width: 340, height: 44 }],
    }, [pdfFile(source, 'claim.pdf')]);
    const bytes = await bytesOf(outcome);
    expect(await streamsHoldPhrase(bytes, 'Bravo on page 1')).toBe(false);
    expect(await streamsHoldPhrase(bytes, 'Bravo on page 2')).toBe(true);
    const streams = await inflatedStreams(bytes);
    expect(streams).toMatch(/re\s+f/); // the fill was still painted
    expect(outcome.message).toMatch(/deleting the glyphs themselves/i);
    expect(outcome.message).toMatch(/none of the \d+ word\(s\) that were under the marks still extracts/);
  }, 300_000);

  it('says when a mark only covered part of a word instead of calling it redacted', async () => {
    const source = await textFixture();
    // The same line, cropped one character short: the glyphs that survive still
    // spell a word a reader can select, and only the saved file can say so.
    const outcome = await run('redact-pdf', {
      fill: '#000000', alsoMetadata: false,
      regions: [{ page: 0, x: 55, y: 118, width: 260, height: 34 }],
    }, [pdfFile(source, 'claim.pdf')]);
    const bytes = await bytesOf(outcome);
    expect(await streamsHoldPhrase(bytes, 'Bravo on page 1')).toBe(false);
    expect(outcome.message).toMatch(/but \d+ word\(s\) under those areas still extract from the saved file/);
    expect(outcome.message).not.toMatch(/deleting the glyphs themselves/i);
    expect(outcome.warnings.join(' ')).toMatch(/covered, not gone/i);
  }, 300_000);

  it('reads a mark on a turned page in the space the editor drew it in', async () => {
    const source = await textFixture();
    // Page 3 carries /Rotate 90: the run sits at user-space (60,700) and advances
    // along user +x, so on screen it starts at (700, 60) and runs downward.
    const outcome = await run('redact-pdf', {
      fill: '#000000', alsoMetadata: false,
      regions: [{ page: 2, x: 685, y: 50, width: 60, height: 240 }],
    }, [pdfFile(source, 'turn.pdf')]);
    const bytes = await bytesOf(outcome);
    expect(await streamsHoldPhrase(bytes, 'Bravo on page 3')).toBe(false);
    expect(await streamsHoldPhrase(bytes, 'Bravo on page 1')).toBe(true);
    const streams = await inflatedStreams(bytes);
    // The bar is painted in unrotated user space, where page content lives: the
    // mark's y becomes x and its x becomes y, each with the other's extent.
    expect(streams).toMatch(/50 685 240 60 re/);
    expect(outcome.message).toMatch(/deleting the glyphs themselves/i);
    // The word-level re-check works in the space the text layer reports, and a
    // turned page reports its runs in unrotated user space — so on this page the
    // tool can only claim what the content stream says, and has to say that.
    expect(outcome.message).toMatch(/no whole word under the marks could be located|none of the \d+ word\(s\) that were under the marks still extracts/);
  }, 300_000);

  it('with the metadata option on, the words go from the properties, the packet and the outline', async () => {
    const source = await richFixture();
    const outcome = await run('redact-pdf', {
      fill: '#000000', alsoMetadata: true,
      regions: [{ page: 0, x: 40, y: 110, width: 340, height: 44 }],
    }, [pdfFile(source, 'claim.pdf')]);
    const bytes = await bytesOf(outcome);
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const info = readInfo(doc);
    expect(info.title ?? '', 'the redacted word is out of /Title').not.toMatch(/Alice/i);
    expect(info.keywords ?? '').not.toMatch(/Alice|Bravo/i);
    expect(info.keywords ?? '', 'deleting a keyword does not leave the comma behind').not.toBe(',');
    expect(info.author, 'a property that never held the word keeps it').toBe('Ada Lovelace');
    expect(readXmp(doc)?.raw ?? '').not.toMatch(/Alice/);
    expect(readOutline(doc).map((node) => node.title)).toEqual(['Chapter', 'Intro']);
    expect(outcome.warnings.join(' ')).toMatch(/Also deleted the redacted words from/i);
    // The comment popover is outside every store this tool rewrites, and saying
    // so is the difference between a caveat and a lie.
    expect(outcome.warnings.join(' ')).toMatch(/still hold the redacted words/i);
    expect(listAnnotations(doc).map((mark) => mark.contents).join(' ')).toMatch(/Alice/);
    expect(await streamsHoldPhrase(bytes, 'Bravo on page 1')).toBe(false);
  }, 300_000);

  it('with the metadata option off, it names where the words survived', async () => {
    const source = await richFixture();
    const outcome = await run('redact-pdf', {
      fill: '#000000', alsoMetadata: false,
      regions: [{ page: 0, x: 40, y: 110, width: 340, height: 44 }],
    }, [pdfFile(source, 'claim.pdf')]);
    const bytes = await bytesOf(outcome);
    expect(await streamsHoldPhrase(bytes, 'Bravo on page 1')).toBe(false);
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(readInfo(doc).title).toBe('Secret Alice');
    expect(outcome.warnings.join(' ')).toMatch(/was off, so the redacted words stay in/i);
    expect(outcome.warnings.join(' ')).toMatch(/document propert/i);
    expect(readXmp(doc)?.raw ?? '').toMatch(/Alice/);
  }, 300_000);
});

// ── attachments ─────────────────────────────────────────────────────────────

describe('the attachments tools are judged on the bytes they carry', () => {
  const enclosure = (name: string, text: string) => ({
    name, mimeType: 'text/plain', bytes: new TextEncoder().encode(text), size: text.length,
  });

  it('add-attachments stores the payload exactly and counts what it actually did', async () => {
    const outcome = await run('add-attachments', {
      files: [enclosure('notes.txt', 'first enclosure'), enclosure('other.txt', 'second')],
      description: 'Enclosure note',
    }, [pdfFile(await textFixture(), 'claim.pdf')]);
    const bytes = await bytesOf(outcome);
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(listAttachments(doc).map((file) => [file.name, latin1.decode(file.bytes), file.description]).sort()).toEqual([
      ['notes.txt', 'first enclosure', 'Enclosure note'],
      ['other.txt', 'second', 'Enclosure note'],
    ]);
    expect(outcome.message).toMatch(/Embedded 2 new file\(s\)/);
    expect(outcome.message).toMatch(/now carries 2 attachment\(s\)/);
    expect(outcome.message).not.toMatch(/it held/);
    expect(outcome.warnings.join(' ')).not.toMatch(/is not in the saved file/i);

    // Pages and content survive the write.
    expect(doc.getPageCount()).toBe(3);
    expect(await streamsHoldPhrase(bytes, 'Bravo on page 1')).toBe(true);
  }, 300_000);

  it('add-attachments replaces a stored name instead of doubling it, and says which', async () => {
    const once = await bytesOf(await run('add-attachments', { files: [enclosure('notes.txt', 'v1')] }, [pdfFile(await textFixture(), 'claim.pdf')]));
    const outcome = await run('add-attachments', { files: [enclosure('notes.txt', 'v2 replaced')] }, [pdfFile(once, 'claim.pdf')]);
    const stored = listAttachments(await PDFDocument.load(await bytesOf(outcome), { updateMetadata: false }));
    expect(stored.map((file) => [file.name, latin1.decode(file.bytes)])).toEqual([['notes.txt', 'v2 replaced']]);
    expect(outcome.message).toMatch(/Embedded 0 new file\(s\) and replaced 1 already stored/);
    expect(outcome.message).toMatch(/up from 1/);

    // Two files under one name in the same run: a PDF stores one per name.
    const clash = await run('add-attachments', { files: [enclosure('same.txt', 'a'), enclosure('same.txt', 'b')] }, [pdfFile(await textFixture(), 'claim.pdf')]);
    expect(clash.warnings.join(' ')).toMatch(/shared a name|only the last copy/i);
    expect(listAttachments(await PDFDocument.load(await bytesOf(clash), { updateMetadata: false })).map((file) => [file.name, latin1.decode(file.bytes)]))
      .toEqual([['same.txt', 'b']]);
  }, 300_000);

  it('extract-attachments hands back the same bytes, one file for one, a ZIP for several', async () => {
    const attached = await bytesOf(await run('add-attachments', {
      files: [enclosure('one.txt', 'alpha payload'), enclosure('two.txt', 'beta payload')],
    }, [pdfFile(await textFixture(), 'claim.pdf')]));
    const many = await run('extract-attachments', {}, [pdfFile(attached, 'claim.pdf')]);
    expect(many.outputs.map((output) => output.name)).toEqual(['claim-attachments.zip']);
    const entries = await readZip(many.outputs[0].blob);
    expect(entries.map((entry) => [entry.name, latin1.decode(entry.bytes)]).sort()).toEqual([
      ['one.txt', 'alpha payload'],
      ['two.txt', 'beta payload'],
    ]);

    const solo = await bytesOf(await run('add-attachments', { files: [enclosure('solo.txt', 'only this')] }, [pdfFile(await textFixture(), 'claim.pdf')]));
    const one = await run('extract-attachments', {}, [pdfFile(solo, 'claim.pdf')]);
    expect(one.outputs.map((output) => output.name)).toEqual(['solo.txt']);
    expect(latin1.decode(new Uint8Array(await one.outputs[0].blob.arrayBuffer()))).toBe('only this');
  }, 300_000);

  it('edit-attachments deletes the named enclosure and leaves the other intact', async () => {
    const attached = await bytesOf(await run('add-attachments', {
      files: [enclosure('drop.txt', 'gone now'), enclosure('keep.txt', 'kept payload')],
    }, [pdfFile(await textFixture(), 'claim.pdf')]));
    const outcome = await run('edit-attachments', { remove: 'drop.txt, never-listed.txt' }, [pdfFile(attached, 'claim.pdf')]);
    const bytes = await bytesOf(outcome);
    const stored = listAttachments(await PDFDocument.load(bytes, { updateMetadata: false }));
    expect(stored.map((file) => [file.name, latin1.decode(file.bytes)])).toEqual([['keep.txt', 'kept payload']]);
    expect(outcome.message).toMatch(/Removed 1 of 2 requested/);
    expect(outcome.message).toMatch(/Remaining: 1/);
    expect(outcome.warnings.join(' ')).toMatch(/"never-listed\.txt" is not embedded/i);
    expect(await streamsHoldPhrase(bytes, 'Bravo on page 1'), 'the pages are not the enclosure').toBe(true);
  }, 300_000);
});

// ── flatten ─────────────────────────────────────────────────────────────────

describe('flatten-pdf reports what the saved file is, not what the counters said', () => {
  it('bakes the fields away and counts the comments separately from them', async () => {
    const source = await richFixture();
    const outcome = await run('flatten-pdf', { forms: true, annotations: false, keepLinks: true, dpi: 96 }, [pdfFile(source, 'claim.pdf')]);
    const bytes = await bytesOf(outcome);
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(doc.getForm().getFields()).toHaveLength(0);
    expect(outcome.message).toMatch(/2 form field\(s\) removed from the form/);
    expect(outcome.message).not.toMatch(/content of 0 page/);
    expect(outcome.warnings.join(' ')).toMatch(/annotation flattening was off/i);
    // The comment is still a comment: it was never in scope.
    expect(listAnnotations(doc).map((mark) => mark.contents)).toContain('Alice needs a note');
    expect(await streamsHoldPhrase(bytes, 'Bravo on page 1')).toBe(true);
  }, 300_000);

  it('names a comment it could not draw instead of counting it as baked', async () => {
    const source = await richFixture();
    const before = await PDFDocument.load(source, { updateMetadata: false });
    const marksBefore = listAnnotations(before).filter((mark) => mark.kind === 'Text').length;
    expect(marksBefore).toBe(1);

    const outcome = await run('flatten-pdf', { forms: true, annotations: true, keepLinks: true, dpi: 96 }, [pdfFile(source, 'claim.pdf')]);
    const bytes = await bytesOf(outcome);
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const live = listAnnotations(doc).filter((mark) => mark.kind === 'Text');
    const claimed = Number(/(\d+) annotation\(s\) drawn/.exec(outcome.message ?? '')?.[1]);
    expect(Number.isNaN(claimed), `the message has to state the annotation count: ${outcome.message}`).toBe(false);
    // The file decides: a mark counted as baked is not still sitting in /Annots,
    // and one that is has to have been admitted to in the warnings.
    expect(claimed + live.length).toBe(marksBefore);
    if (live.length > 0) {
      expect(outcome.warnings.join(' ')).toMatch(/still live annotations in the saved file|could not be drawn into the page content/i);
    }
    // The comment this app creates stores its appearance as a stream, which is
    // the fact `core/flatten.ts:140` asks for as a `PDFDict` — the lookup throws
    // and nothing gets drawn. Pinned here so the fix has an assertion to aim at
    // (docs/tasks/security2-request.md), not a hypothesis.
    expect(appearanceKind(doc, live[0] ?? listAnnotations(before).find((mark) => mark.kind === 'Text')!)).toBe('stream');
  }, 300_000);
});

/**
 * Whether an annotation's `/AP /N` resolves to a stream (the PDF answer) or a
 * dictionary — read from the saved bytes, not from a helper's assumption.
 */
function appearanceKind(doc: PDFDocument, mark: { ref: PDFRef }): 'stream' | 'dict' | 'none' {
  const annotation = doc.context.lookup(mark.ref, PDFDict);
  const ap = annotation?.get(PDFName.of('AP'));
  const apDict = ap instanceof PDFRef ? doc.context.lookup(ap, PDFDict) : ap;
  if (!(apDict instanceof PDFDict)) return 'none';
  const normal = apDict.get(PDFName.of('N'));
  const appearance = normal instanceof PDFRef ? doc.context.lookup(normal) : normal;
  if (appearance instanceof PDFRawStream) return 'stream';
  return appearance instanceof PDFDict ? 'dict' : 'none';
}

// ── compare ─────────────────────────────────────────────────────────────────

describe('compare-pdfs does not call an unreadable page a match', () => {
  it('says a page with no text layer could not be compared at all', async () => {
    const silent = await silentFixture();
    const outcome = await run('compare-pdfs', { mode: 'text', dpi: 96, sensitivity: 24 }, [
      pdfFile(silent, 'a.pdf'), pdfFile(silent, 'b.pdf'),
    ]);
    expect(outcome.report?.sections[0].rows?.[0].value).toMatch(/extractable text/i);
    expect(outcome.report?.message).toMatch(/Nothing could be compared/i);
    expect(outcome.report?.message).not.toMatch(/No differences found/i);

    const half = await halfSilentFixture();
    const mixed = await run('compare-pdfs', { mode: 'text', dpi: 96, sensitivity: 24 }, [
      pdfFile(half, 'a.pdf'), pdfFile(half, 'b.pdf'),
    ]);
    expect(mixed.report?.sections[0].rows?.[1].value).toMatch(/extractable text/i);
    expect(mixed.report?.sections[0].rows?.[0].value).toMatch(/identical text/i);
    expect(mixed.warnings.join(' ')).toMatch(/1 of 2 page\(s\) have no extractable text/i);
    expect(mixed.report?.message).toMatch(/No differences found across 2 page/);
  }, 300_000);

  it('reads the difference out of two files that differ in one word', async () => {
    const left = await textFixture();
    const other = await PDFDocument.load(await textFixture());
    other.getPages()[1].drawText('One extra clause', { x: 60, y: 600, size: 18, font: await other.embedFont(StandardFonts.Helvetica), color: rgb(1, 0, 0) });
    const right = await other.save({ useObjectStreams: false });
    const outcome = await run('compare-pdfs', { mode: 'text', dpi: 96, sensitivity: 24 }, [
      pdfFile(left, 'a.pdf'), pdfFile(right, 'b.pdf'),
    ]);
    expect(outcome.report?.sections[0].rows?.[1].value).toMatch(/text differs/i);
    expect(outcome.report?.message).toMatch(/1 of 3 page\(s\) differ/i);
    expect(outcome.report?.sections[0].rows?.[0].value).toMatch(/identical text/i);
  }, 300_000);
});

// ── coverage ────────────────────────────────────────────────────────────────

describe('every tool in the category has been read back from its bytes somewhere', () => {
  /** Tools whose output is a PDF this suite (or `edge-security`) re-opens. */
  const PROVEN = [
    'protect', 'unlock', 'change-permissions', 'remove-restrictions', 'flatten-pdf', 'redact-pdf',
    'edit-metadata', 'remove-metadata', 'add-attachments', 'edit-attachments', 'compare-pdfs',
    // Proven in `edge-security.test.ts`: sign → validate the bytes → tamper one.
    'digital-sign-pdf', 'timestamp-pdf',
  ];

  /** Tools that hand back a report rather than bytes, and what they read from. */
  const REPORTING = ['view-metadata', 'extract-attachments', 'validate-signature-pdf'];

  it('names every security tool exactly once across the two lists', () => {
    expect(securityTools.length).toBe(PROVEN.length + REPORTING.length);
    expect([...PROVEN, ...REPORTING].sort()).toEqual(securityTools.map((tool) => tool.id).sort());
  });

  it('keeps the report-only tools free of a PDF output', () => {
    for (const id of REPORTING) {
      const tool = getPdfTool(id)!;
      expect(tool.surface, `${id} claims a surface it does not have`).toBe('none');
    }
    for (const id of PROVEN) {
      expect(getPdfTool(id)?.run, `${id} has no run to prove`).toBeTruthy();
    }
  });

  it('states an unimplemented capability as an unavailable reason, never as invented output', () => {
    // Nothing in this family is stubbed today. If a tool is stubbed later it has
    // to name the alternative the way `protect` names PDF to Images for the
    // ciphertext this browser cannot write.
    const stubbed = securityTools.filter((tool) => tool.unavailable);
    expect(stubbed.map((tool) => tool.id)).toEqual([]);
    for (const tool of securityTools) {
      expect(tool.notes?.length ?? 0, `${tool.id} has no notes to read its limits from`).toBeGreaterThan(0);
    }
  });
});
