/**
 * The ciphered-input guard: which locked files this app may rewrite, and which it
 * must refuse (the `encrypted-inputs` row of `docs/TOOL-CAMPAIGN.md`, measured in
 * `docs/research/encrypted-inputs-findings.md`).
 *
 * The bug is not "encrypted files do not work". It is that a file locked with a
 * **real crypt filter** previews correctly, edits wrongly and says nothing: the
 * engine holds each page stream exactly as the file stores it — ciphertext — and
 * `core/doc.ts` has no decrypt pass, while the writer labels the copy with the
 * source's own dictionary. The rig measured 18 of 18 such outputs with the right
 * page count, a password that still opened them, `planted_pages 3 → 0`, sheet-1
 * ink `0.46 % → 0.0 %`, text `182 → 0` characters and `qpdf --check` reporting
 * errors. This project's standing rule is that a tool says no rather than
 * producing a plausible empty file, so a rewrite of a ciphered file is refused
 * before any work happens.
 *
 * The distinction that makes that shippable is the **effective crypt filter**, not
 * the presence of an `/Encrypt` entry:
 *
 * - `ciphered` — `/StmF` or `/StrF` resolves to `RC4`, `AESV2` or `AESV3` (or
 *   `/V` is 1-3, where RC4 is implied with no filter to opt out of). Refused.
 * - `gate-only` — a password and the `/P` flags over the predefined `/None`
 *   filter: "the data are not encrypted". This is what `protect` writes, and the
 *   rig's own control shows the same three operations keep its words, so these
 *   keep working exactly as they did.
 *
 * Every fixture is therefore locked **outside** this repo — by libqpdf and by
 * MuPDF, in both trailer spellings — and each assertion reads the classification,
 * the refusal or the produced bytes, never a sentence quoted from a plan. See
 * `tests/fixtures/encrypted/README.md` for why a file this engine encrypted is no
 * evidence about a cipher.
 *
 * `reads no words out of an AES-128 file, and cannot even inflate its streams`
 * below measures the cause rather than the guard. When a decrypt pass lands in
 * `core/doc.ts:openPDF` it is that test which says this refusal can come down.
 *
 * **Red before the guard, measured:** with `rejectCiphered` forced off in
 * `tools/runner.ts` — one line, the guard lifted and nothing else changed — 66 of
 * the 111 tests here go red (11 rewriting tools × the 6 ciphered fixtures), plus
 * one in `edge-organize.test.ts`: 67 across the two files. Every rewriting tool
 * produces a file again, and those files are the 18-of-18 blank ones the rig
 * judged. The gate-only tests are green in both states, which is the point of the
 * split: nothing that works today is refused by this guard.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef } from '@maxwbh/pdf-lib';
import type { PDFPage } from '@maxwbh/pdf-lib';
import {
  cipheredInputError,
  classifyEncryption,
  describeEncryption,
  inspectPdf,
  isToolInputError,
  preflightPdf,
  type PdfEncryption,
} from '@/lib/pdf/core/guard';
import { openPDF, saveEncrypted, looksEncrypted } from '@/lib/pdf/core/doc';
import { streamBytes } from '@/lib/pdf/core/content';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import type { ToolValues } from '@/lib/pdf/tools/types';

const FIXTURES = resolve(process.cwd(), 'tests/fixtures/encrypted');

/** `tests/fixtures/encrypted` — written by libqpdf and MuPDF, never by this app. */
const fixtureBytes = (name: string): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, name)));

/** The secret every locked fixture carries; see the fixtures' README for the locks. */
const PASSWORD = 'hunter2';

/** The sentence each of the three sheets was planted with. */
const PLANTED = 'Lighthouse Inventory 1887';

function fileOf(bytes: Uint8Array, name: string): File {
  return new File([new Uint8Array(bytes) as BlobPart], name, { type: 'application/pdf' });
}

/** The shape `preflightPdf` reads: a `File`-shaped source, never opened in full. */
const asSource = (bytes: Uint8Array, name: string) => {
  const file = fileOf(bytes, name);
  return { name: file.name, size: file.size, blob: () => file };
};

async function run(toolId: string, values: ToolValues, name: string, password?: string) {
  const tool = getPdfTool(toolId);
  expect(tool, `tool "${toolId}" is not registered`).toBeTruthy();
  return runPdfTool({
    toolId,
    files: [fileOf(fixtureBytes(name), name)],
    values,
    password,
    onProgress: () => undefined,
    onLog: () => undefined,
  });
}

/**
 * What this app's engine sees when it opens a document: the words its own content
 * reader can inflate, and the streams it could not inflate at all.
 *
 * MuPDF writes each page's text as a hex string, so the string operands are
 * decoded here rather than grepped. A ciphertext stream under `/FlateDecode`
 * throws the engine's own complaint, and that is counted rather than swallowed:
 * it is the measurement the guard exists because of.
 */
async function engineView(bytes: Uint8Array, password?: string): Promise<{ words: string; undecoded: number }> {
  const doc = await PDFDocument.load(bytes, {
    ...(password ? { password } : {}),
    // The same order the guard uses: read the structure even without the secret.
    ignoreEncryption: !password,
    updateMetadata: false,
  });
  const parts: string[] = [];
  let undecoded = 0;
  for (const page of doc.getPages()) {
    for (const stream of contentsOf(doc, page)) {
      let raw: Uint8Array;
      try {
        raw = streamBytes(stream);
      } catch {
        undecoded += 1;
        continue;
      }
      parts.push(Buffer.from(raw).toString('latin1'));
    }
  }
  return { words: decodeStrings(parts.join('\n')), undecoded };
}

/** A page's `/Contents` streams, inline or behind a reference, one or many. */
function contentsOf(doc: PDFDocument, page: PDFPage): PDFRawStream[] {
  const value = page.node.get(PDFName.of('Contents'));
  const items = value instanceof PDFArray
    ? Array.from({ length: value.size() }, (_, index) => value.get(index))
    : [value];
  const out: PDFRawStream[] = [];
  for (const item of items) {
    const stream = item instanceof PDFRef ? doc.context.lookup(item) : item;
    if (stream instanceof PDFRawStream) out.push(stream);
  }
  return out;
}

/** The literal and hex string operands of a content stream, as text. */
function decodeStrings(content: string): string {
  const out: string[] = [];
  for (const match of content.matchAll(/<([0-9A-Fa-f\s]*)>|\(((?:[^()\\]|\\.)*)\)/g)) {
    if (match[1] !== undefined) {
      const hex = match[1].replace(/\s+/g, '');
      if (hex.length % 2 === 0) out.push(Buffer.from(hex, 'hex').toString('latin1'));
      continue;
    }
    out.push((match[2] ?? '').replace(/\\([()\\])/g, '$1'));
  }
  return out.join(' ');
}

/** Encrypt a document the way this app's own `protect` does: a gate, no cipher. */
async function gateOnly(): Promise<Uint8Array> {
  const doc = await openPDF(fixtureBytes('plain.pdf'), { ignoreEncryption: true });
  return saveEncrypted(doc, { userPassword: PASSWORD, ownerPassword: PASSWORD });
}

/* ── 1. the classification ───────────────────────────────────────────────── */

describe('classifying what a lock does to the contents', () => {
  it('calls an unlocked file none', async () => {
    const seen = await inspectPdf(fixtureBytes('plain.pdf'), 'plain.pdf');
    expect(seen.encryption).toMatchObject({ state: 'none', algorithm: null, version: null, revision: null });
    expect(seen.encrypted).toBe(false);
    expect(seen.error).toBeNull();
  });

  it('calls this app’s own gate gate-only, and keeps naming it "no cipher"', async () => {
    const seen = await inspectPdf(await gateOnly(), 'own-protected.pdf', { password: PASSWORD });
    expect(seen.encryption).toMatchObject({
      state: 'gate-only',
      algorithm: 'no cipher',
      streamFilter: null,
      method: null,
      version: 4,
      revision: 4,
    });
    expect(seen.encrypted).toBe(true);
    expect(seen.error).toBeNull();
    expect(seen.pages).toBe(3);
  });

  it('names RC4-128 at revision 3, where there is no crypt filter to read', async () => {
    const seen = await inspectPdf(fixtureBytes('rc4-128-user.pdf'), 'rc4-128-user.pdf', { password: PASSWORD });
    expect(seen.encryption).toMatchObject({
      state: 'ciphered',
      algorithm: 'RC4-128',
      streamFilter: null,
      method: 'RC4',
      version: 2,
      revision: 3,
    });
    expect(describeEncryption(seen.encryption as PdfEncryption)).toBe('RC4-128 (revision 3)');
  });

  it('names AES-128 from the filter /StmF selects, not the strongest name in /CF', async () => {
    const seen = await inspectPdf(fixtureBytes('aes-128-user.pdf'), 'aes-128-user.pdf', { password: PASSWORD });
    expect(seen.encryption).toMatchObject({
      state: 'ciphered',
      algorithm: 'AES-128',
      streamFilter: 'StdCF',
      stringFilter: 'StdCF',
      method: 'AESV2',
      version: 4,
      revision: 4,
    });
    expect(describeEncryption(seen.encryption as PdfEncryption)).toBe('AES-128 (crypt filter /StdCF, revision 4)');
  });

  it('names AES-256 (revision 6) even though the password check still fails on it', async () => {
    const seen = await inspectPdf(fixtureBytes('aes-256-user.pdf'), 'aes-256-user.pdf', { password: PASSWORD });
    expect(seen.encryption).toMatchObject({
      state: 'ciphered',
      algorithm: 'AES-256',
      streamFilter: 'StdCF',
      method: 'AESV3',
      version: 5,
      revision: 6,
    });
    // The R6 verification defect is its own task. It must not hide the cipher:
    // "that password is not correct" is the wrong instruction for a file no
    // password will ever make editable here.
    expect(seen.error).toBe('BAD_PASSWORD');
  });

  it('calls an owner-only ciphered file ciphered, though anyone can open it', async () => {
    const seen = await inspectPdf(fixtureBytes('rc4-128-owner.pdf'), 'rc4-128-owner.pdf');
    expect(seen.opensWithEmptyPassword).toBe(true);
    expect(seen.needsPassword).toBe(false);
    expect(seen.error).toBeNull();
    expect(seen.encryption).toMatchObject({ state: 'ciphered', algorithm: 'RC4-128' });
  });

  it('names the same cipher whichever outside producer wrote the file', async () => {
    // qpdf writes `/Encrypt 12 0 R`; MuPDF inlines the dictionary. Two spellings
    // of one lock, and the classification reads the lock, not the spelling — so
    // these two pairs must answer identically to their qpdf twins above.
    const rc4 = await inspectPdf(fixtureBytes('mu-rc4-128-user.pdf'), 'mu-rc4-128-user.pdf', { password: PASSWORD });
    expect(rc4.encryption).toMatchObject({ state: 'ciphered', algorithm: 'RC4-128', version: 2, revision: 3 });
    const aes = await inspectPdf(fixtureBytes('mu-aes-128-user.pdf'), 'mu-aes-128-user.pdf', { password: PASSWORD });
    expect(aes.encryption).toMatchObject({
      state: 'ciphered', algorithm: 'AES-128', streamFilter: 'StdCF', method: 'AESV2', revision: 4,
    });
  });

  it('reads the effective filter out of a dictionary it is handed', async () => {
    const { context } = await PDFDocument.create();
    const classify = (build: (dict: PDFDict) => void): PdfEncryption => {
      const dict = PDFDict.withContext(context);
      build(dict);
      return classifyEncryption(dict);
    };

    // `/V 4` with an AES filter *defined* and never *selected*: `/StmF` defaults to
    // the predefined `/None`, so the streams are plaintext. Reading `/CF` alone
    // called this AES-128, which is how a password gate with no cipher came to be
    // reported as one in the first place.
    const definesWithoutSelecting = classify((dict) => {
      dict.set(PDFName.of('V'), PDFNumber.of(4));
      dict.set(PDFName.of('R'), PDFNumber.of(4));
      const filters = PDFDict.withContext(context);
      const standard = PDFDict.withContext(context);
      standard.set(PDFName.of('CFM'), PDFName.of('AESV2'));
      standard.set(PDFName.of('Length'), PDFNumber.of(16));
      filters.set(PDFName.of('StdCF'), standard);
      dict.set(PDFName.of('CF'), filters);
    });
    expect(definesWithoutSelecting.state).toBe('gate-only');
    expect(definesWithoutSelecting.algorithm).toBe('no cipher');
    expect(definesWithoutSelecting.streamFilter).toBeNull();

    // `/Identity` is the other predefined plaintext filter, named explicitly.
    expect(classify((dict) => {
      dict.set(PDFName.of('V'), PDFNumber.of(4));
      dict.set(PDFName.of('R'), PDFNumber.of(4));
      dict.set(PDFName.of('StmF'), PDFName.of('Identity'));
    }).state).toBe('gate-only');

    // A filter that is selected but not defined is still a cipher claim, not the
    // absence of one: the safe answer about those bytes is "we cannot read them".
    const dangling = classify((dict) => {
      dict.set(PDFName.of('V'), PDFNumber.of(4));
      dict.set(PDFName.of('R'), PDFNumber.of(4));
      dict.set(PDFName.of('StmF'), PDFName.of('StdCF'));
    });
    expect(dangling.state).toBe('ciphered');
    expect(dangling.algorithm).toBe('unknown');

    // `/V 1` with no `/Length` is the spec's 40-bit RC4.
    expect(classify((dict) => {
      dict.set(PDFName.of('V'), PDFNumber.of(1));
      dict.set(PDFName.of('R'), PDFNumber.of(2));
    })).toMatchObject({ state: 'ciphered', algorithm: 'RC4-40', revision: 2 });
  });

  it('refuses pdf-lib’s own save({ encrypt }), which claims a cipher it never ran', async () => {
    // The fixture the old `edge-organize` test locked its "protected" document
    // with. Its dictionary selects `/CFM /AESV2` while its streams are plaintext,
    // so it is not evidence about a cipher in either direction — and the guard
    // reads the claim the file makes, which is what a reader would read too.
    const doc = await openPDF(fixtureBytes('plain.pdf'), { ignoreEncryption: true });
    const bytes = await doc.save({
      encrypt: { userPassword: PASSWORD, ownerPassword: 'owner', version: 4, permissions: {} as never },
    });
    const seen = await inspectPdf(bytes, 'self-encrypted.pdf', { password: PASSWORD });
    expect(seen.encryption).toMatchObject({ state: 'ciphered', algorithm: 'AES-128' });
  });
});

/* ── 2. the cheap scan that decides whether to parse at all ─────────── */

describe('the trailer scan in front of the parse', () => {
  it('finds an /Encrypt dictionary that is inlined, not just one that is referenced', () => {
    // The MuPDF fixtures are the proof; this line is why they were ever refused.
    // A scan matching only `/Encrypt 12 0 R` — the reference spelling qpdf uses,
    // and the one `looksEncrypted` knew — called every MuPDF-locked file
    // unencrypted, so the pre-flight never parsed it, no cipher was classified and
    // the rewrite went ahead. The audit rig measured it: 6 produced files, all of
    // them from the two MuPDF RC4-128 / AES-128 fixtures, and the two MuPDF
    // AES-256 ones refused as `BAD_PASSWORD` / `PASSWORD_REQUIRED` — an
    // unnameable cipher, because the dictionary was never read.
    const inlined = new TextEncoder().encode(
      '%PDF-1.7\ntrailer<</Size 14/Root 1 0 R/Encrypt<</Filter/Standard/R 3/V 2/Length 128/P -3376>>>>\nstartxref\n4964\n%%EOF\n',
    );
    expect(looksEncrypted(inlined)).toBe(true);
    for (const name of ['rc4-128-user.pdf', 'mu-rc4-128-user.pdf', 'mu-aes-128-user.pdf', 'aes-256-user.pdf']) {
      expect(looksEncrypted(fixtureBytes(name)), name).toBe(true);
    }
    // And the permissions key is not the dictionary key: `/EncryptMetadata true`
    // is in the same trailer as every one of these, and must not answer alone.
    expect(looksEncrypted(new TextEncoder().encode('trailer<</EncryptMetadata true>>>>'))).toBe(false);
    expect(looksEncrypted(fixtureBytes('plain.pdf'))).toBe(false);
  });
});

/* ── 3. what the engine actually holds ───────────────────────────────────── */

describe('the ciphertext the guard refuses', () => {
  it('reads the words this app can see in an unlocked file', async () => {
    const view = await engineView(fixtureBytes('plain.pdf'));
    expect(view.undecoded).toBe(0);
    expect(view.words).toContain(PLANTED);
    expect(view.words).toContain('Sheet ALPHA body copy');
  });

  it('reads the words through this app’s own gate', async () => {
    const view = await engineView(await gateOnly(), PASSWORD);
    expect(view.undecoded).toBe(0);
    expect(view.words).toContain(PLANTED);
  });

  it('reads no words out of an AES-128 file, and cannot even inflate its streams', async () => {
    // The measurement behind the refusal, on the bytes rather than on a message:
    // the opened document has 3 pages, the password works, and its content is not
    // text at all. A decrypt pass on load will redden this test, and that is the
    // moment this guard can be reconsidered.
    const view = await engineView(fixtureBytes('aes-128-user.pdf'), PASSWORD);
    expect(view.words).not.toContain(PLANTED);
    expect(view.undecoded).toBeGreaterThan(0);
  });

  it('reads no words out of an RC4-128 file either', async () => {
    const view = await engineView(fixtureBytes('rc4-128-user.pdf'), PASSWORD);
    expect(view.words).not.toContain(PLANTED);
  });
});

/* ── 4. the refusal ──────────────────────────────────────────────────────── */

describe('the refusal says what the file is and what to do', () => {
  it('names the cipher, the filter and the revision', async () => {
    const seen = await inspectPdf(fixtureBytes('aes-128-user.pdf'), 'contract.pdf', { password: PASSWORD });
    const error = cipheredInputError('contract.pdf', seen.encryption as PdfEncryption);
    expect(error.code).toBe('UNSUPPORTED');
    expect(error.fileName).toBe('contract.pdf');
    expect(error.passwordRequired).toBe(false);
    expect(error.message).toBe(
      '"contract.pdf" is encrypted with AES-128 (crypt filter /StdCF, revision 4): '
      + 'its pages are stored as ciphertext, and this app cannot decrypt them yet.',
    );
    expect(error.hint).toMatch(/Decrypt the file in the program that locked it/);
    expect(error.hint).toMatch(/password alone does not help/);
    expect(error.hint).toMatch(/open and preview/);
    expect(error.hint).toMatch(/blank pages/);
    // The other half of the rule, stated in the sentence itself.
    expect(error.hint).toMatch(/a password gate with no crypt filter[\s\S]*is edited normally/);
  });

  it('does not claim that every locked file is refused', async () => {
    const seen = await inspectPdf(fixtureBytes('rc4-128-user.pdf'), 'scan.pdf', { password: PASSWORD });
    const error = cipheredInputError('scan.pdf', seen.encryption as PdfEncryption);
    expect(error.message).toMatch(/RC4-128 \(revision 3\)/);
    const said = `${error.message} ${error.hint}`;
    expect(said).not.toMatch(/\b(all|every|any) (encrypted|password[- ]protected) files\b/i);
    expect(said).not.toMatch(/cannot (open|read|preview) (this |the )?(encrypted )?(file|PDF|pages)/i);
    expect(said).not.toMatch(/not support(ed)? (any )?encryption/i);
  });
});

/* ── 5. the guard on the tools that rewrite content ──────────────────────── */

/** Tools that hand back a PDF rebuilt from the source's own page streams. */
const REWRITING: { id: string; values: ToolValues }[] = [
  { id: 'rotate', values: { degrees: 90, pages: 'all' } },
  { id: 'remove-pages', values: { pages: '2' } },
  { id: 'split', values: { mode: 'every' } },
  { id: 'pdf-compress', values: {} },
  { id: 'sanitize-pdf', values: {} },
  { id: 'flatten-pdf', values: {} },
  { id: 'remove-metadata', values: {} },
  { id: 'protect', values: { mode: 'both', userPassword: 'new-open', ownerPassword: 'new-owner' } },
  { id: 'unlock', values: {} },
  { id: 'change-permissions', values: { action: 'set' } },
  { id: 'remove-restrictions', values: {} },
];

/** Tools declared `readsOnly`: text, pictures, archives and reports. */
const READING: { id: string; values: ToolValues }[] = [
  { id: 'page-dimensions', values: {} },
  { id: 'pdfs-to-zip', values: {} },
  { id: 'view-metadata', values: {} },
  { id: 'extract-attachments', values: {} },
];

describe.each([
  'aes-128-user.pdf',
  'rc4-128-user.pdf',
  'rc4-128-owner.pdf',
  'aes-256-user.pdf',
  'mu-aes-128-user.pdf',
  'mu-rc4-128-user.pdf',
] as const)(
  'a ciphered input read from %s',
  (name) => {
    // The owner-only file's user password is empty, so it is run with nothing.
    const password = name === 'rc4-128-owner.pdf' ? undefined : PASSWORD;

    it.each(REWRITING)('is refused by $id before any work, rather than emptied', async ({ id, values }) => {
      const refusal = await run(id, values, name, password).then(
        () => null,
        (error: unknown) => error,
      );
      expect(refusal, `${id} produced a file from ${name} instead of refusing it`).toBeTruthy();
      expect(isToolInputError(refusal), 'the refusal is a bare Error').toBe(true);
      const error = refusal as ReturnType<typeof cipheredInputError>;
      expect(error.code).toBe('UNSUPPORTED');
      expect(error.passwordRequired).toBe(false);
      expect(error.message).toContain(name);
      expect(error.message).toMatch(/stored as ciphertext, and this app cannot decrypt them yet/);
    });

    it.each(READING)('is not refused as encrypted by $id, which rewrites nothing', async ({ id, values }) => {
      // A reader may still refuse this file for its own reason — there are no
      // attachments to pull out — but it must not be the cipher refusal, which
      // would withhold a tool whose answer does not depend on decrypting.
      const error = await run(id, values, name, password).then(() => null, (caught: unknown) => caught);
      if (error === null) return;
      const blamed = isToolInputError(error) && error.code === 'UNSUPPORTED' && /ciphertext/.test(error.message);
      expect(blamed, `${id} refused ${name} as encrypted: ${error instanceof Error ? error.message : String(error)}`).toBe(false);
    });
  },
);

describe('the refusal is the pre-flight’s, not each tool’s', () => {
  it('is raised before a password is ever asked for', async () => {
    const refusal = await preflightPdf(asSource(fixtureBytes('aes-128-user.pdf'), 'aes-128-user.pdf'), undefined, {
      rejectCiphered: true,
    });
    expect(refusal?.code).toBe('UNSUPPORTED');
    expect(refusal?.message).toMatch(/AES-128/);
    expect(refusal?.passwordRequired).toBe(false);
  });

  it('leaves the password gate standing for a gate-only file', async () => {
    const source = asSource(await gateOnly(), 'own-protected.pdf');
    const blind = await preflightPdf(source, undefined, { rejectCiphered: true });
    expect(blind?.code).toBe('PASSWORD_REQUIRED');
    expect(blind?.passwordRequired).toBe(true);
    expect(await preflightPdf(source, PASSWORD, { rejectCiphered: true })).toBeNull();
  });

  it('asks nothing of a reader, and nothing of an unlocked file', async () => {
    const ciphered = asSource(fixtureBytes('aes-128-user.pdf'), 'aes-128-user.pdf');
    expect(await preflightPdf(ciphered, PASSWORD)).toBeNull();
    expect(await preflightPdf(ciphered, PASSWORD, { rejectCiphered: false })).toBeNull();
    const plain = asSource(fixtureBytes('plain.pdf'), 'plain.pdf');
    expect(await preflightPdf(plain, undefined, { rejectCiphered: true })).toBeNull();
  });
});

/* ── 6. the direction that must not regress ─────────────────────────────── */

describe('a gate-only file is edited exactly as it was before', () => {
  it('rotates this app’s protected file, keeps its gate and keeps its words', async () => {
    const outcome = await runPdfTool({
      toolId: 'rotate',
      files: [fileOf(await gateOnly(), 'contract.pdf')],
      values: { degrees: 90, pages: 'all' },
      password: PASSWORD,
      onProgress: () => undefined,
      onLog: () => undefined,
    });
    const bytes = new Uint8Array(await outcome.outputs[0].blob.arrayBuffer());
    const text = Buffer.from(bytes).toString('latin1');
    // The gate is re-issued, not silently lifted: the copy still carries
    // `/Encrypt` and still answers to the password the user holds.
    expect(text).toMatch(/\/Encrypt/);
    await expect(PDFDocument.load(bytes, { password: PASSWORD })).resolves.toBeTruthy();
    expect(outcome.warnings.join(' ')).toMatch(/re-applied/i);

    const produced = await PDFDocument.load(bytes, { password: PASSWORD, updateMetadata: false });
    expect(produced.getPageCount()).toBe(3);
    expect(produced.getPages().every((page) => page.getRotation().angle === 90)).toBe(true);
    // …and the pages are not the empty rectangles a foreign cipher produces.
    const view = await engineView(bytes, PASSWORD);
    expect(view.words).toContain(PLANTED);
    expect(view.words).toContain('Sheet BRAVO body copy');
    expect(outcome.pagesOut).toBe(3);
  });

  it('unlocks it, which is the tool whose job the gate is', async () => {
    const locked = await gateOnly();
    const outcome = await runPdfTool({
      toolId: 'unlock',
      files: [fileOf(locked, 'contract.pdf')],
      values: {},
      password: PASSWORD,
      onProgress: () => undefined,
      onLog: () => undefined,
    });
    const bytes = new Uint8Array(await outcome.outputs[0].blob.arrayBuffer());
    const after = await inspectPdf(bytes, 'unlocked.pdf');
    expect(after.encrypted).toBe(false);
    expect(after.encryption).toMatchObject({ state: 'none' });
    expect((await engineView(bytes)).words).toContain(PLANTED);
  });
});
