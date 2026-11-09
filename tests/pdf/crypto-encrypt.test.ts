/**
 * The write path: what `protect` puts in the file, and what comes back out.
 *
 * `core/crypto.ts` spent two commits proving it could *undo* a cipher somebody
 * else ran (RC4-128 and AES-128, `crypto-decrypt.test.ts`). This file is the
 * other direction, and it exists because the direction that had evidence was the
 * easy one: this app's own writer and reader were free to share a mistake, and
 * the `protect` row records that they did — a dictionary naming `/CFM /AESV2`
 * over streams that were never ciphered, which is what every reader that believes
 * a `/CFM` renders as blank paper.
 *
 * So the assertions are of three kinds, and only the first is this module's word:
 *
 *   * **bytes** — the dictionary says AES-128 and the payloads behind it do not
 *     inflate, so the claim and the content agree in both directions;
 *   * **this app's read path** — `decryptDocument` and `openPDF` hand back the
 *     planted text and the planted strings, character for character, which is
 *     what makes a protected download re-openable here rather than a locked box
 *     the app cannot pick itself;
 *   * **a second implementation** — pdf.js, which ships its own AES-128 and
 *     shares no code with this module, is asked for the same words. Byte-for-byte
 *     agreement between the writer, this reader and that one is the only evidence
 *     that counts, and the outside half of it is measured on files by MuPDF,
 *     qpdf, poppler, pypdf and Ghostscript:
 *
 *       PROTECT_PROBE_DIR=/tmp/pb npx vitest run tests/pdf/protect-spec.test.ts
 *       python3 docs/research/protect-readers.py /tmp/pb "Secret Alice 42 Bravo" open-sesame
 *
 * One strength is written, because one strength is read: AES-128 at `/V 4 /R 4`.
 * AES-256 is asserted *absent* rather than assumed — `/R 6` needs `/OE`, `/UE` and
 * a different `/U`, none of which this module derives, and ciphertext the app
 * cannot open is half a feature.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import { inflateSync } from 'node:zlib';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, StandardFonts, rgb } from '@maxwbh/pdf-lib';
import { assessAccess, decryptDocument, encryptDocument } from '@/lib/pdf/core/crypto';
import { openPDF, resealLikeSource, saveEncrypted, looksEncrypted } from '@/lib/pdf/core/doc';
import { saveGateOnly } from './gate-harness';
import { inspectPdf } from '@/lib/pdf/core/guard';
import { openRender } from '@/lib/pdf/core/render';

const latin1 = new TextDecoder('latin1');
const FIXTURES = resolve(process.cwd(), 'tests/fixtures/encrypted');
/** The secret `scripts/encrypted-fixtures.py` locked every fixture with. */
const PASSWORD = 'hunter2';
/** The sentence the fixture plants on sheet 1. */
const SHEET = ['Lighthouse Inventory 1887 page 1'];
const USER = 'open-sesame';
const OWNER = 'owner-key';
const WRONG = 'not-the-password';
const WORDS = 'Secret Alice 42 Bravo';
const FIELD_VALUE = 'Ada Lovelace';

beforeAll(() => {
  // pdf.js resolves its worker to an `http://` URL Node's ESM loader refuses;
  // same shim `protect-spec.test.ts` carries. Without it the second
  // implementation never starts, and "a reader agreed" would be this app alone.
  let workerPath = `file://${process.cwd()}/node_modules/pdfjs-dist/build/pdf.worker.mjs`;
  Object.defineProperty(GlobalWorkerOptions, 'workerSrc', {
    configurable: true,
    get: () => workerPath,
    set: (value: string) => {
      if (value.startsWith('file:') || value.startsWith('data:')) workerPath = value;
    },
  });
}, 120_000);

/** A document with a page, a field value, a note and a title: one of each channel. */
async function sample(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < 2; index++) {
    const page = doc.addPage([306, 408]);
    page.drawText(`${WORDS} on page ${index + 1}`, { x: 24, y: 360, size: 14, font, color: rgb(0, 0, 0) });
  }
  const form = doc.getForm();
  form.createTextField('applicant.name').setText(FIELD_VALUE);
  doc.setTitle('Lighthouse Inventory');
  return doc.save({ useObjectStreams: false });
}

/** Load as the file is carried, without undoing anything: the seal view. */
async function sealed(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
}

/** One encryption dictionary, read out of the file by hand. */
function encryptBody(bytes: Uint8Array): string {
  const raw = latin1.decode(bytes);
  const start = raw.indexOf('/Filter /Standard');
  expect(start, 'no /Filter /Standard dictionary in the saved file').toBeGreaterThan(-1);
  const endobj = raw.indexOf('endobj', start);
  return raw.slice(start, raw.lastIndexOf('>>', endobj) + 2).replace(/\s+/g, ' ');
}

/** Every stream payload in the file, inflated where it inflates. */
function payloads(doc: PDFDocument): { inflated: number; raw: number; text: string } {
  let inflated = 0;
  let raw = 0;
  const parts: string[] = [];
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const bytes = object.getContents();
    const hasFilter = object.dict.get(PDFName.of('Filter')) !== undefined;
    if (hasFilter) {
      try {
        parts.push(latin1.decode(inflateSync(Buffer.from(bytes))));
        inflated += 1;
        continue;
      } catch {
        /* it will not inflate: that is what ciphertext looks like */
      }
    }
    raw += 1;
    parts.push(latin1.decode(bytes));
  }
  return { inflated, raw, text: parts.join('\n') };
}

/** The words a document's page streams hold, through this app's content reader. */
function pageWords(doc: PDFDocument): string[] {
  return doc.getPages().map((page) => {
    const value = page.node.get(PDFName.of('Contents'));
    const items = value instanceof PDFArray
      ? Array.from({ length: value.size() }, (_, index) => value.get(index))
      : [value];
    const runs: string[] = [];
    for (const item of items) {
      const stream = item instanceof PDFRef ? doc.context.lookup(item) : item;
      if (!(stream instanceof PDFRawStream)) continue;
      try {
        runs.push(latin1.decode(inflateSync(Buffer.from(stream.getContents()))));
      } catch {
        runs.push(latin1.decode(stream.getContents()));
      }
    }
    // MuPDF-style hex operands and literal operands both appear in real content.
    return runs.join(' ').replace(/<([0-9A-Fa-f\s]+)>/g, (_, hex: string) =>
      Buffer.from(hex.replace(/\s+/g, ''), 'hex').toString('latin1'));
  });
}

/** What pdf.js makes of the bytes: pages and text, or the refusal it printed. */
async function readerSays(bytes: Uint8Array, password?: string): Promise<{ pages: number; text: string } | { refused: string }> {
  try {
    const session = await openRender(bytes, password ? { password } : {});
    try {
      const pages = session.numPages;
      const text = (await Promise.all(Array.from({ length: pages }, (_, index) => session.textItems(index + 1))))
        .map((items) => items.map((item) => item.str).join(' '))
        .join(' | ')
        .trim();
      return { pages, text };
    } finally {
      await session.destroy();
    }
  } catch (error) {
    return { refused: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}

/** How many `/Filter /Standard` dictionaries a parsed document carries. */
function standardDicts(doc: PDFDocument): number {
  return doc.context.enumerateIndirectObjects().filter(([, object]) =>
    object instanceof PDFDict && object.lookupMaybe(PDFName.of('Filter'), PDFName)?.asString() === '/Standard').length;
}

/* ── the dictionary, off the bytes ───────────────────────────────────────── */

describe('the save writes the dictionary the cipher claims', () => {
  it('selects AES-128 in both channels, at revision 4, with the four hashes', async () => {
    const bytes = await saveEncrypted(await sealed(await sample()), {
      userPassword: USER,
      ownerPassword: OWNER,
      permissions: { printing: true, copying: false },
    });
    const body = encryptBody(bytes);

    expect(body).toMatch(/\/V 4\b/);
    expect(body).toMatch(/\/R 4\b/);
    expect(body).toMatch(/\/Length 128\b/);
    // The filter is defined *and* selected: an `/AESV2` sitting in `/CF` with no
    // `/StmF` beside it is a gate, and a `/StmF` naming nothing is a cipher this
    // module refuses to guess at. Both halves are read here for that reason.
    expect(body).toMatch(/\/CF << \/StdCF << \/CFM \/AESV2/);
    expect(body).toMatch(/\/Length 16/);
    expect(body).toMatch(/\/StmF \/StdCF/);
    expect(body).toMatch(/\/StrF \/StdCF/);
    expect(body).toMatch(/\/P -?\d+/);
    expect(body).toMatch(/\/EncryptMetadata true/);
    // Revision 4 sizes: 32 bytes of `/O` and `/U`, 16 of `/Perms`, and none of the
    // revision-6 extras this module neither derives nor reads.
    for (const key of ['O', 'U'] as const) {
      const value = new RegExp(`/${key} <([0-9A-Fa-f]+)>`).exec(body)?.[1] ?? '';
      expect(value.length / 2, `/${key} is a revision-4 value`).toBe(32);
    }
    const perms = /\/Perms <([0-9A-Fa-f]+)>/.exec(body)?.[1] ?? '';
    expect(perms.length / 2, 'Algorithm 5 writes a 16-byte /Perms').toBe(16);
    expect(body).not.toMatch(/\/OE|\/UE|\/AESV3|\/Perms <[0-9A-Fa-f]{64}/);
  }, 300_000);

  it('puts the same fresh /ID in both trailer slots, because /O /U /Perms came from it', async () => {
    const doc = await sealed(await sample());
    const bytes = await saveEncrypted(doc, { userPassword: USER, ownerPassword: OWNER });
    const seen = await sealed(bytes);
    const id = seen.context.trailerInfo.ID;
    expect(id instanceof PDFArray, 'the trailer carries no /ID').toBe(true);
    const pair = (id as PDFArray).asArray();
    expect(pair.length).toBe(2);
    const first = pair[0] as PDFHexString;
    const second = pair[1] as PDFHexString;
    expect(first.asBytes().length, 'the /ID is a 16-byte salt').toBe(16);
    expect(latin1.decode(second.asBytes())).toBe(latin1.decode(first.asBytes()));
    // The key depends on it, so a save that re-locked the same document with the
    // same passwords had better not have reused the old one.
    const again = await saveEncrypted(await sealed(await sample()), { userPassword: USER, ownerPassword: OWNER });
    const againId = (await sealed(again)).context.trailerInfo.ID as PDFArray;
    expect(latin1.decode((againId.get(0) as PDFHexString).asBytes()))
      .not.toBe(latin1.decode(first.asBytes()));
  }, 300_000);

  it('leaves no object streams behind, which is the shape this app cannot re-read', async () => {
    const bytes = await saveEncrypted(await sealed(await sample()), { userPassword: USER, ownerPassword: OWNER });
    const raw = latin1.decode(bytes);
    expect(raw).not.toMatch(/\/Type\s*\/ObjStm/);
    expect(looksEncrypted(bytes)).toBe(true);
  }, 300_000);

  it('ciphers content a tool added after the file was opened', async () => {
    // The shape every real run takes: a document parsed, then edited, then
    // protected. A stream created after the parse is still a stream, and the
    // dictionary claims the whole file — so it has to be ciphered too, and its
    // words have to come back.
    const doc = await sealed(await sample());
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([306, 408]).drawText(`${WORDS} on a page added after the parse`, { x: 24, y: 360, size: 12, font });
    const bytes = await saveEncrypted(doc, { userPassword: USER, ownerPassword: OWNER });
    const shut = payloads(await sealed(bytes));
    expect(shut.inflated, 'a payload that inflates was not ciphered').toBe(0);
    const view = pageWords(await openPDF(bytes, { password: USER }));
    expect(view.length).toBe(3);
    expect(view[2]).toContain('added after the parse');
  }, 300_000);

  it('ciphers what the writer creates while it writes', async () => {
    // `save()` generates a form field's appearance streams at the moment it
    // serializes, and flushes pending page content and embedded assets there. An
    // object born then, after a single ciphering pass, would be written in the
    // clear behind a dictionary that says AES-128 — the mirror image of the
    // defect this module ends. `saveEncrypted` therefore serializes once before
    // it ciphers anything, and the count of objects in the file it hands back is
    // the proof that nothing arrived afterwards.
    const doc = await sealed(await sample());
    doc.getForm(); // what the tools' structure census does, and what arms the lazy pass
    const bytes = await saveEncrypted(doc, { userPassword: USER, ownerPassword: OWNER });
    const seen = await sealed(bytes);
    const streams = [...seen.context.enumerateIndirectObjects()].filter(([, object]) => object instanceof PDFRawStream);
    expect(streams.length, 'the document holds no streams at all').toBeGreaterThan(0);
    for (const [, stream] of streams) {
      const payload = (stream as PDFRawStream).getContents();
      expect(() => inflateSync(Buffer.from(payload)), `stream ${payload.length} left in the clear`).toThrow();
    }
  }, 300_000);
});

/* ── the bytes behind the claim ──────────────────────────────────────────── */

describe('the bytes are ciphertext, in both channels', () => {
  it('cipheres every stream, so nothing inflates to the words it held', async () => {
    const plain = await sample();
    const open = payloads(await sealed(plain));
    // `drawText` writes the run as a hex string, so plaintext shows the phrase in
    // one of these two spellings. Ciphertext shows it in neither.
    const hexWords = Buffer.from(`${WORDS} on page 1`, 'utf8').toString('hex').toUpperCase();
    expect(open.text.includes(WORDS) || open.text.includes(hexWords), open.text.slice(0, 120)).toBe(true);
    expect(open.raw, 'the plaintext streams are the control, not the claim').toBe(0);

    const bytes = await saveEncrypted(await sealed(plain), { userPassword: USER, ownerPassword: OWNER });
    const shut = payloads(await sealed(bytes));
    expect(shut.inflated, 'a payload that inflates was not ciphered').toBe(0);
    expect(shut.raw, 'every stream of the document is under the cipher').toBeGreaterThan(0);
    expect(shut.text).not.toContain(WORDS);
    expect(shut.text).not.toContain(hexWords);
    expect(latin1.decode(bytes), 'no string of the document survives in the clear')
      .not.toContain(FIELD_VALUE);
    expect(latin1.decode(bytes)).not.toContain('Lighthouse Inventory');
    expect(latin1.decode(bytes)).not.toContain(WORDS);
  }, 300_000);

  it('keeps /Length equal to the payload the file actually carries', async () => {
    // The writer recomputes it, which is the only reason an AES payload (IV + blocks,
    // longer than the bytes it came from) is not described by a stale length.
    const bytes = await saveEncrypted(await sealed(await sample()), { userPassword: USER, ownerPassword: OWNER });
    const doc = await sealed(bytes);
    let checked = 0;
    for (const [, object] of doc.context.enumerateIndirectObjects()) {
      if (!(object instanceof PDFRawStream)) continue;
      const declared = object.dict.lookupMaybe(PDFName.of('Length'), PDFNumber)?.asNumber();
      expect(declared, 'a stream dictionary without /Length').toBe(object.getContents().length);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  }, 300_000);

  it('leaves the encryption dictionary alone, which is what makes the file openable', async () => {
    const doc = await sealed(await sample());
    const bytes = await saveEncrypted(doc, { userPassword: USER, ownerPassword: OWNER });
    const seen = await sealed(bytes);
    const dict = seen.context.trailerInfo.Encrypt;
    const resolved = dict instanceof PDFRef ? seen.context.lookupMaybe(dict, PDFDict) : dict;
    expect(resolved instanceof PDFDict, 'no /Encrypt dictionary').toBe(true);
    // /O and /U are exempt from the cipher they describe (ISO 32000-1 §7.3.2.1):
    // a reader that had to decrypt them first could never decrypt anything.
    const owner = (resolved as PDFDict).lookupMaybe(PDFName.of('O'), PDFHexString);
    expect(owner, '/O is missing or not a hex string').toBeTruthy();
    expect(owner!.asBytes().length).toBe(32);
  }, 300_000);
});

/* ── the round trip, through this app and through another implementation ─── */

describe('the ciphertext opens again, twice over', () => {
  it('hands the words and the strings back to this app\u2019s own read path', async () => {
    const bytes = await saveEncrypted(await sealed(await sample()), { userPassword: USER, ownerPassword: OWNER });
    const outcome = await decryptDocument(await sealed(bytes), USER);
    expect(outcome.kind, JSON.stringify(outcome)).toBe('decrypted');
    // Streams *and* strings: a count of 0 for either is a channel the writer
    // claimed and the reader never walked.
    expect((outcome as { streams: number }).streams).toBeGreaterThan(0);
    expect((outcome as { strings: number }).strings).toBeGreaterThan(0);

    const doc = await openPDF(bytes, { password: USER });
    expect(pageWords(doc)[0]).toContain(WORDS);
    expect(doc.getTitle()).toBe('Lighthouse Inventory');
    const field = doc.getForm().getField('applicant.name');
    expect(field && 'getText' in field ? (field as { getText(): string }).getText() : null).toBe(FIELD_VALUE);
  }, 300_000);

  it('answers pdf.js, which runs its own AES-128, with the same pages and words', async () => {
    const bytes = await saveEncrypted(await sealed(await sample()), { userPassword: USER, ownerPassword: OWNER });

    const blind = await readerSays(bytes);
    expect('refused' in blind, `pdf.js read a ciphered file with no password: ${JSON.stringify(blind)}`).toBe(true);

    const wrong = await readerSays(bytes, WRONG);
    expect('refused' in wrong, `pdf.js accepted a wrong password: ${JSON.stringify(wrong)}`).toBe(true);

    const opened = await readerSays(bytes, USER);
    expect('pages' in opened, `pdf.js refused the file this app wrote: ${JSON.stringify(opened)}`).toBe(true);
    expect((opened as { pages: number }).pages).toBe(2);
    const text = (opened as { text: string }).text;
    expect(text).toContain(`${WORDS} on page 1`);
    expect(text).toContain(`${WORDS} on page 2`);
  }, 300_000);

  it('names which secret opened it, and refuses one that opened nothing', async () => {
    const bytes = await saveEncrypted(await sealed(await sample()), { userPassword: USER, ownerPassword: OWNER });
    expect(assessAccess(await sealed(bytes), USER)).toMatchObject({ kind: 'opens', strength: 'AES-128', openedAs: 'user' });
    expect(assessAccess(await sealed(bytes), OWNER)).toMatchObject({ kind: 'opens', strength: 'AES-128', openedAs: 'owner' });
    expect(assessAccess(await sealed(bytes), WRONG)).toMatchObject({ kind: 'bad-password', strength: 'AES-128' });
    expect(assessAccess(await sealed(bytes))).toMatchObject({ kind: 'needs-password', strength: 'AES-128' });
  }, 300_000);

  it('is a file the guard lets a rewriting tool touch', async () => {
    // The `encrypted-inputs` refusal exists for ciphertext this app cannot undo.
    // A file it ciphered itself must not fall into that bucket, or `protect`
    // would lock the user out of their own downloads.
    const bytes = await saveEncrypted(await sealed(await sample()), { userPassword: USER, ownerPassword: OWNER });
    const seen = await inspectPdf(bytes, 'claim.pdf', { password: USER });
    expect(seen.encryption).toMatchObject({
      state: 'ciphered', algorithm: 'AES-128', method: 'AESV2', streamFilter: 'StdCF', supported: true, refusal: null,
    });
    expect(seen.passwordAccepted).toBe(true);
    expect(seen.pages).toBe(2);
  }, 300_000);
});

/* ── a browser without the cipher ─────────────────────────────────────────── */

describe('a browser with no AES-CBC writes nothing at all', () => {
  it('refuses before half the document is ciphered', async () => {
    // The whole point of checking the primitive up front: a dictionary that names
    // `/CFM /AESV2` over streams nobody ran the filter on is the contradiction this
    // module refuses to *read*, so it must not be allowed to write one either.
    const host = globalThis as { crypto?: Crypto };
    const real = host.crypto;
    const subtle = real?.subtle;
    try {
      if (real && subtle) Object.defineProperty(real, 'subtle', { value: undefined, configurable: true });
      await expect(
        saveEncrypted(await sealed(await sample()), { userPassword: USER, ownerPassword: OWNER }),
      ).rejects.toThrow(/no AES-CBC/);
    } finally {
      if (real && subtle) Object.defineProperty(real, 'subtle', { value: subtle, configurable: true });
    }
    // And with the primitive back, the same call writes a ciphered file.
    const bytes = await saveEncrypted(await sealed(await sample()), { userPassword: USER, ownerPassword: OWNER });
    expect(latin1.decode(bytes)).not.toContain(WORDS);
  }, 300_000);
});

/* ── the permissions-only shape ──────────────────────────────────────────── */

describe('a permissions-only save is ciphered and still opens freely', () => {
  it('derives its key from the empty user secret and asks nobody for a password', async () => {
    const bytes = await saveEncrypted(await sealed(await sample()), {
      userPassword: '',
      ownerPassword: OWNER,
      permissions: { printing: false, copying: false, contentAccessibility: true },
    });
    const seen = await inspectPdf(bytes, 'claim.pdf');
    expect(seen.encrypted).toBe(true);
    expect(seen.needsPassword, 'an empty user password must not ask for one').toBe(false);
    expect(seen.opensWithEmptyPassword).toBe(true);
    expect(seen.algorithm, 'restricted is not the same as in the clear').toBe('AES-128');
    expect(seen.permissions).toMatchObject({ printing: false, copying: false, contentAccessibility: true });

    // Anyone can derive the key — the secret is the empty string — so the pages
    // read, with this app's reader and with pdf.js.
    const doc = await openPDF(bytes);
    expect(pageWords(doc)[0]).toContain(WORDS);
    const opened = await readerSays(bytes);
    expect('pages' in opened, `pdf.js refused a file with no open password: ${JSON.stringify(opened)}`).toBe(true);
    expect((opened as { text: string }).text).toContain(WORDS);
  }, 300_000);

  it('changes the file key when /P changes, so the flags cannot be rewritten quietly', async () => {
    const lock = async (permissions: Record<string, boolean>) => saveEncrypted(await sealed(await sample()), {
      userPassword: '', ownerPassword: OWNER, permissions,
    });
    const wide = await lock({ printing: true, modifying: true, copying: true });
    const tight = await lock({ printing: false, modifying: false, copying: false });
    const value = (bytes: Uint8Array) => Number(/\/P (-?\d+)/.exec(encryptBody(bytes))?.[1]);
    expect(value(wide)).not.toBe(value(tight));
    // `/P` is an input to Algorithm 2, so different flags mean a different file
    // key and a different `/U` — and `/Perms` is the 16 bytes a reader checks to
    // notice somebody rewrote them without the owner password.
    const userValue = (bytes: Uint8Array) => /\/U <([0-9A-Fa-f]+)>/.exec(encryptBody(bytes))?.[1] ?? '';
    const permsValue = (bytes: Uint8Array) => /\/Perms <([0-9A-Fa-f]+)>/.exec(encryptBody(bytes))?.[1] ?? '';
    expect(userValue(wide)).toHaveLength(64);
    expect(userValue(tight)).toHaveLength(64);
    expect(userValue(wide)).not.toBe(userValue(tight));
    expect(permsValue(wide)).not.toBe(permsValue(tight));
  }, 300_000);
});

/* ── carrying a lock forward over an edit ────────────────────────────────── */

describe('an edit keeps the protection it came with, rather than a new one', () => {
  /** One value of the encryption dictionary, as the file writes it. */
  const dictValue = (bytes: Uint8Array, key: string): string =>
    new RegExp(`/${key} <([0-9A-Fa-f]+)>`).exec(encryptBody(bytes))?.[1] ?? '';

  it('reseals a permissions-only file with the source\u2019s own /O, so its owner password still works', async () => {
    // `edit-metadata` renaming a title must not swap the secret that lifts the
    // restrictions. /O is the owner password sealed under the file key: identical
    // bytes mean the same owner password, and a re-derived lock would change them.
    const locked = await saveEncrypted(await sealed(await sample()), {
      userPassword: '',
      ownerPassword: OWNER,
      permissions: { printing: false, copying: false },
    });
    const edited = await openPDF(locked);
    edited.setTitle('Renamed');
    const resealed = await resealLikeSource(edited, locked);
    expect(resealed, 'the edit lost the lock it arrived with').not.toBeNull();
    const bytes = resealed!.bytes;

    expect(resealed!.strength).toBe('AES-128');
    expect(dictValue(bytes, 'O'), 'a different /O is a different owner password').toBe(dictValue(locked, 'O'));
    expect(dictValue(bytes, 'U')).toBe(dictValue(locked, 'U'));
    expect(dictValue(bytes, 'Perms'), 'a different /Perms is a checksum over different flags').toBe(dictValue(locked, 'Perms'));
    expect(/\/P (-?\d+)/.exec(encryptBody(bytes))![1])
      .toBe(/\/P (-?\d+)/.exec(encryptBody(locked))![1]);
    // `/ID[0]` is the salt `/U` and `/Perms` were both derived over, so it must not
    // move; `/ID[1]` is the one the spec asks a modified file to change.
    const idPair = async (source: Uint8Array) => {
      const ids = (await sealed(source)).context.trailerInfo.ID as PDFArray;
      return [0, 1].map((index) => latin1.decode((ids.get(index) as PDFHexString).asBytes()));
    };
    const [lockedFirst, lockedSecond] = await idPair(locked);
    const [copyFirst, copySecond] = await idPair(bytes);
    expect(copyFirst, 'a new /ID[0] would be a new file key, and a new key is a new lock').toBe(lockedFirst);
    expect(copySecond).not.toBe(lockedSecond);

    // Still ciphertext, still readable, still asks for nothing.
    expect(latin1.decode(bytes)).not.toContain(FIELD_VALUE);
    const seen = await inspectPdf(bytes, 'renamed.pdf');
    expect(seen.encrypted).toBe(true);
    expect(seen.opensWithEmptyPassword).toBe(true);
    expect(seen.algorithm).toBe('AES-128');
    expect((await openPDF(bytes)).getTitle()).toBe('Renamed');
    expect(pageWords(await openPDF(bytes))[0]).toContain(WORDS);
  }, 300_000);

  it('keeps the strength of a foreign file it was asked to edit', async () => {
    // An RC4-128 input must not come back claiming AES-128, and a `/None` gate
    // must not be quietly upgraded into a cipher: the copy carries the lock the
    // user was given, dictionary and all.
    const rc4 = new Uint8Array(readFileSync(join(FIXTURES, 'rc4-128-user.pdf')));
    const edited = await openPDF(rc4, { password: PASSWORD });
    edited.addPage([200, 200]);
    const resealed = await resealLikeSource(edited, rc4, PASSWORD);
    expect(resealed, 'the RC4-128 lock was not carried forward').not.toBeNull();
    const body = encryptBody(resealed!.bytes);
    expect(resealed!.strength).toBe('RC4-128');
    expect(body).toMatch(/\/V 2/);
    expect(body).toMatch(/\/R 3/);
    expect(body).not.toMatch(/\/CFM/);
    // And the copy still answers to the password the source was locked with.
    expect(pageWords(await openPDF(resealed!.bytes, { password: PASSWORD }))[0]).toContain(SHEET[0]);
  }, 300_000);

  it('hands back null when there is no lock to carry', async () => {
    const plain = await sample();
    expect(await resealLikeSource(await sealed(plain), plain)).toBeNull();
    // A wrong secret is not a lock either: resealing with it would issue a key
    // that the file\u2019s own /U does not answer to.
    const locked = await saveEncrypted(await sealed(await sample()), { userPassword: USER, ownerPassword: OWNER });
    expect(await resealLikeSource(await openPDF(locked, { password: USER }), locked, WRONG)).toBeNull();
  }, 300_000);
});

/* ── the seam itself ─────────────────────────────────────────────────────── */

describe('encryptDocument, asked directly', () => {
  it('counts what it ciphered and reports the strength it wrote', async () => {
    const doc = await sealed(await sample());
    const written = await encryptDocument(doc, { userPassword: USER, ownerPassword: OWNER, permissions: -3392 });
    // Two page content streams: every stream this document holds.
    expect(written).toEqual({ strength: 'AES-128', streams: 2, strings: expect.any(Number) });
    expect(written.strings).toBeGreaterThan(0);
    // `/P` is the integer the caller handed over, signed, in the file — not one the
    // module recomputed on the way.
    expect(encryptBody(await doc.save({ useObjectStreams: false }))).toMatch(/\/P -3392\b/);
    // The dictionary is in the trailer, and the document in memory is the ciphered
    // one: a caller that keeps editing after the save is editing ciphertext.
    const body = latin1.decode(await doc.save({ useObjectStreams: false }));
    expect(body).toMatch(/\/CFM \/AESV2/);
  }, 300_000);

  it('drops a stale /Encrypt entry rather than ciphering somebody else\u2019s /O', async () => {
    // A gate-only document read with `ignoreEncryption` still carries its source's
    // dictionary; leaving it registered would describe the file twice and run the
    // new cipher over the old hashes.
    const gated = await saveGateOnly(await sealed(await sample()), { userPassword: 'first' });
    const reopened = await sealed(gated);
    expect(reopened.isEncrypted).toBe(true);
    expect(standardDicts(reopened), 'the gate this file arrived with').toBe(1);

    const bytes = await saveEncrypted(reopened, { userPassword: USER, ownerPassword: OWNER });
    expect(standardDicts(await sealed(bytes)), 'two encryption dictionaries in one file').toBe(1);
    expect(pageWords(await openPDF(bytes, { password: USER }))[0]).toContain(WORDS);
  }, 300_000);

  it('refuses to claim a cipher it did not run, which is the defect this commit ends', async () => {
    // The vendor's own `save({ encrypt })` still writes `/CFM /AESV2` over streams
    // it never ciphered. `core/crypto` names that contradiction `plaintext-claim`
    // rather than decrypting readable words into garbage, so the shape is asserted
    // here as the thing the writer must not produce.
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]).drawText(WORDS, { x: 20, y: 100 });
    const vendor = await doc.save({ useObjectStreams: false, encrypt: { userPassword: USER, ownerPassword: OWNER, version: 4 } });
    const vendorHex = Buffer.from(WORDS, 'utf8').toString('hex').toUpperCase();
    const body = encryptBody(vendor);
    expect(body, 'the vendor dictionary still names AES-128').toMatch(/\/CFM \/AESV2/);
    const said = payloads(await sealed(vendor));
    expect(said.text.includes(WORDS) || said.text.includes(vendorHex), 'the words are still in the clear').toBe(true);
    expect(said.inflated, 'and every one of its streams inflates').toBeGreaterThan(0);
    expect(await decryptDocument(await sealed(vendor), USER)).toMatchObject({ kind: 'unsupported', reason: 'plaintext-claim' });

    const ours = await saveEncrypted(await sealed(vendor), { userPassword: USER, ownerPassword: OWNER });
    expect(latin1.decode(ours)).not.toContain(WORDS);
    expect(await decryptDocument(await sealed(ours), USER)).toMatchObject({ kind: 'decrypted', strength: 'AES-128' });
  }, 300_000);
});
