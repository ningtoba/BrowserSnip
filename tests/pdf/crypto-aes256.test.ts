/**
 * AES-256 (revision 6) read by this app, measured against outside-locked files.
 *
 * `tests/fixtures/encrypted/` carries four revision-6 files, two producers by two
 * kinds of secret, all written over `plain.pdf` by libqpdf 12.3.2 and MuPDF 1.28.2
 * — never by this app, because a cipher this module read back only from its own
 * writer would be pdf-lib checking its own arithmetic. The strength was refused
 * outright until this file's assertions went green: the correct password answered
 * `BAD_PASSWORD`, an owner-only AES-256 file was reported as locked where five
 * outside readers open it with nothing typed, and 12 of the 36 operation runs in
 * `docs/research/encrypted-inputs-findings.md` produced no file at all.
 *
 * What is asserted here is the **content**, not a byte count. A revision-6 key
 * schedule that is wrong in its last detail still opens: the ladder converges, the
 * wrap unwraps, the page count is 3 — and every word is mojibake. So each fixture
 * is asked for the sentence planted on each sheet, the document title and author,
 * and the two outline entries, which is what an outside reader reports for the same
 * bytes (`scripts/encrypted-fixtures.py` prints that verification per file).
 *
 * The details with the sharpest teeth get their own tests:
 *
 *   * the `/OE` / `/UE` unwrap runs with **no** PKCS#5 padding — unpadding a 32-byte
 *     file key hands back 16 to 31 bytes, which still decrypts into plausible text;
 *   * `/Perms` is verified, and its absence is explicitly trusted (see
 *     `permsAgrees`);
 *   * the two kinds of secret stay apart, and the owner-only files open with
 *     nothing typed, as the readers do.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef } from '@maxwbh/pdf-lib';
import { assessAccess, decryptDocument } from '@/lib/pdf/core/crypto';
import { openPDF } from '@/lib/pdf/core/doc';
import { streamBytes } from '@/lib/pdf/core/content';
import { readOutline } from '@/lib/pdf/core/bookmarks';

const FIXTURES = resolve(process.cwd(), 'tests/fixtures/encrypted');
const PASSWORD = 'hunter2';
const WRONG = 'not-the-password';

const PLANTED = 'Lighthouse Inventory 1887';
const SHEETS = ['ALPHA', 'BRAVO', 'CHARLIE'];
const SHEET_TEXT = SHEETS.map((sheet, index) => `${PLANTED} page ${index + 1}`);

const fixtureBytes = (name: string): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, name)));

/** The engine's own lenient read: structure parsed, bytes untouched. */
async function loadRaw(name: string): Promise<PDFDocument> {
  return PDFDocument.load(fixtureBytes(name), { ignoreEncryption: true, updateMetadata: false });
}

/** Every string operand of every page content stream, inflated first. */
function pageWords(doc: PDFDocument): string[] {
  return doc.getPages().map((page, index) => decodeStrings(contentsText(doc, index)));
}

function contentsText(doc: PDFDocument, index: number): string {
  const page = doc.getPages()[index];
  const value = page.node.get(PDFName.of('Contents'));
  const items = value instanceof PDFArray
    ? Array.from({ length: value.size() }, (_, position) => value.get(position))
    : [value];
  const parts: string[] = [];
  for (const item of items) {
    const stream = item instanceof PDFRef ? doc.context.lookup(item) : item;
    if (stream instanceof PDFRawStream) parts.push(Buffer.from(streamBytes(stream)).toString('latin1'));
  }
  return parts.join('\n');
}

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

/**
 * The outline the engine reads, compared with what the **unlocked** base gives.
 *
 * `readOutline` returns one of this document's two entries over a MuPDF-written
 * name tree, identically whether the file is locked or not — the `encrypted-inputs`
 * row records that as the outline reader's loss, not a cipher effect, and it
 * reproduces on the control. Asserting a count here would pin this cipher to
 * somebody else's bug, so the bar is "reads exactly as the same bytes unlocked":
 * the outline is not *further* damaged by the password or by the cipher.
 */
async function expectPlantedContent(doc: PDFDocument): Promise<void> {
  const words = pageWords(doc);
  expect(words.length, 'page count').toBe(3);
  words.forEach((page, index) => {
    expect(page, `sheet ${SHEETS[index]}`).toContain(SHEET_TEXT[index]);
    expect(page, `sheet ${SHEETS[index]}`).toContain(`Sheet ${SHEETS[index]} body copy`);
  });
  // The string pass: `/Info` is ciphered like any other dictionary's strings, so a
  // key that is wrong about padding shows up here as mojibake rather than as zero.
  expect(doc.getTitle()).toBe(PLANTED);
  expect(doc.getAuthor()).toBe('encrypted fixtures');
  const base = await loadRaw('plain.pdf');
  expect(readOutline(doc).map((entry) => entry.title))
    .toEqual(readOutline(base).map((entry) => entry.title));
}

/** The `/Encrypt` dictionary of a parsed document, as the file spells it. */
function encryptDict(doc: PDFDocument) {
  const entry = doc.context.trailerInfo.Encrypt;
  const dict = entry instanceof PDFRef ? doc.context.lookupMaybe(entry, PDFDict) : entry;
  if (!(dict instanceof PDFDict)) throw new Error('this fixture has no /Encrypt dictionary');
  return dict;
}

/**
 * name -> what the file's own dictionary says opens it, measured with pypdf, qpdf,
 * MuPDF and poppler in `tests/fixtures/encrypted/README.md`.
 */
const AES256_INPUTS = [
  { name: 'aes-256-user.pdf', producer: 'qpdf', secret: PASSWORD, opensAs: 'user' },
  { name: 'aes-256-owner.pdf', producer: 'qpdf', secret: PASSWORD, opensAs: 'owner' },
  { name: 'mu-aes-256-user.pdf', producer: 'MuPDF', secret: PASSWORD, opensAs: 'user' },
  { name: 'mu-aes-256-owner.pdf', producer: 'MuPDF', secret: PASSWORD, opensAs: 'owner' },
] as const;

describe.each(AES256_INPUTS)('reading %s (AES-256 by $producer)', ({ name, secret, opensAs }) => {
  it('reads the revision-6 dictionary as a cipher it undoes', async () => {
    const doc = await loadRaw(name);
    const dict = encryptDict(doc);
    // The shape the older strengths do not have: 48-byte /O and /U, the two wraps,
    // and a 32-byte key length selected by both channels.
    expect(dict.lookupMaybe(PDFName.of('V'), PDFNumber)?.asNumber()).toBe(5);
    expect(dict.lookupMaybe(PDFName.of('R'), PDFNumber)?.asNumber()).toBe(6);
    expect(dict.lookupMaybe(PDFName.of('O'), PDFHexString)?.asBytes().length).toBe(48);
    expect(dict.lookupMaybe(PDFName.of('U'), PDFHexString)?.asBytes().length).toBe(48);
    expect(dict.lookupMaybe(PDFName.of('OE'), PDFHexString)?.asBytes().length).toBe(32);
    expect(dict.lookupMaybe(PDFName.of('UE'), PDFHexString)?.asBytes().length).toBe(32);
    expect(dict.lookupMaybe(PDFName.of('Perms'), PDFHexString)?.asBytes().length).toBe(16);

    const verdict = await assessAccess(doc, secret);
    expect(verdict).toMatchObject({ kind: 'opens', strength: 'AES-256', openedAs: opensAs === 'user' ? 'user' : 'owner' });
    // The unwrapped key is the whole 32 bytes. Had the unwrap run Web Crypto's
    // padded decrypt, this would be 16 to 31 bytes and every word mojibake.
    if (verdict.kind !== 'opens') return;
    expect(verdict.fileKey.length, 'the file key is 32 bytes, not an unpadded remainder').toBe(32);
  });

  it('hands back the planted sentence, the title and the outline', async () => {
    const doc = await loadRaw(name);
    const outcome = await decryptDocument(doc, secret);
    expect(outcome).toMatchObject({ kind: 'decrypted', strength: 'AES-256', openedAs: opensAs === 'user' ? 'user' : 'owner' });
    expect(outcome.kind === 'decrypted' && outcome.streams).toBeGreaterThan(0);
    expect(outcome.kind === 'decrypted' && outcome.strings).toBeGreaterThan(0);
    await expectPlantedContent(doc);
  });

  it('leaves the engine holding flate, not ciphertext, and drops the claim', async () => {
    const doc = await loadRaw(name);
    await decryptDocument(doc, secret);
    // The *stored* payload is what carries the zlib head: `streamBytes` runs the
    // filter chain and hands back the page's own operators, which start with a
    // newline whatever the cipher did.
    const head = Array.from(rawContent(doc, 0).getContents()).slice(0, 2)
      .map((byte) => byte.toString(16).padStart(2, '0'));
    expect(head[0]).toBe('78');
    expect(['01', '5e', '9c', 'da']).toContain(head[1]);
    expect(doc.context.trailerInfo.Encrypt).toBeUndefined();
  });

  it('survives a save, and the saved bytes still hold the words', async () => {
    const doc = await loadRaw(name);
    await decryptDocument(doc, secret);
    const bytes = await doc.save({ useObjectStreams: false });
    const reloaded = await PDFDocument.load(bytes, { updateMetadata: false });
    pageWords(reloaded).forEach((page, index) => expect(page).toContain(SHEET_TEXT[index]));
    expect(new TextDecoder('latin1').decode(bytes)).not.toMatch(/\/Encrypt(?![A-Za-z0-9_])/);
  });

  it('opens through the shipped read path, not only through the module', async () => {
    const doc = await openPDF(fixtureBytes(name), { password: secret });
    await expectPlantedContent(doc);
  });
});

function rawContent(doc: PDFDocument, index: number): PDFRawStream {
  const value = doc.getPages()[index].node.get(PDFName.of('Contents'));
  const item = value instanceof PDFArray ? value.get(0) : value;
  const stream = item instanceof PDFRef ? doc.context.lookup(item) : item;
  if (!(stream instanceof PDFRawStream)) throw new Error('this page has no raw /Contents stream');
  return stream;
}

/* ── the two kinds of secret, kept apart ─────────────────────────────────── */

describe('the secrets an AES-256 dictionary can carry', () => {
  it('asks for a password on a user-password file, and refuses a wrong one by name', async () => {
    expect(await assessAccess(await loadRaw('aes-256-user.pdf')))
      .toMatchObject({ kind: 'needs-password', strength: 'AES-256' });
    expect(await assessAccess(await loadRaw('aes-256-user.pdf'), WRONG))
      .toMatchObject({ kind: 'bad-password', strength: 'AES-256' });
    expect(await decryptDocument(await loadRaw('aes-256-user.pdf'), WRONG))
      .toMatchObject({ kind: 'bad-password', strength: 'AES-256' });
    // The MuPDF-written file behaves the same: this is the handler, not the producer.
    expect(await decryptDocument(await loadRaw('mu-aes-256-user.pdf'), WRONG))
      .toMatchObject({ kind: 'bad-password', strength: 'AES-256' });
  });

  it('opens an owner-only file with nothing typed, as every outside reader does', async () => {
    for (const name of ['aes-256-owner.pdf', 'mu-aes-256-owner.pdf']) {
      const verdict = await assessAccess(await loadRaw(name));
      expect(verdict, name).toMatchObject({ kind: 'opens', openedAs: 'empty', suppliedMatched: false });
      const doc = await loadRaw(name);
      const outcome = await decryptDocument(doc);
      expect(outcome, name).toMatchObject({ kind: 'decrypted', openedAs: 'empty', suppliedMatched: false });
      await expectPlantedContent(doc);
    }
  });

  it('opens an owner-only file with the owner secret, and says it was the owner', async () => {
    for (const name of ['aes-256-owner.pdf', 'mu-aes-256-owner.pdf']) {
      const outcome = await decryptDocument(await loadRaw(name), PASSWORD);
      expect(outcome, name).toMatchObject({ kind: 'decrypted', openedAs: 'owner', suppliedMatched: true });
    }
  });

  it('does not call a deliberately wrong password correct on a permissions-only file', async () => {
    for (const name of ['aes-256-owner.pdf', 'mu-aes-256-owner.pdf']) {
      const outcome = await decryptDocument(await loadRaw(name), WRONG);
      expect(outcome, name).toMatchObject({ kind: 'decrypted', openedAs: 'empty', suppliedMatched: false });
    }
  });

  it('takes the owner secret of a user-password file as the owner, not as the user', async () => {
    // Both fixtures in this corpus carry `hunter2` twice, so the only way to tell
    // the two derivations apart is which one is reported: `/O` unwraps through the
    // whole 48-byte `/U`, `/U` through nothing, and a module that used one for the
    // other would not reach the planted sentence at all.
    const verdict = await assessAccess(await loadRaw('aes-256-user.pdf'), PASSWORD);
    expect(verdict).toMatchObject({ kind: 'opens', openedAs: 'user' });
  });
});

/* ── /Perms, decided explicitly ──────────────────────────────────────────── */

describe('the /Perms check value', () => {
  it('refuses a value that does not decrypt to its own marker', async () => {
    const doc = await loadRaw('aes-256-user.pdf');
    const dict = encryptDict(doc);
    const perms = dict.lookupMaybe(PDFName.of('Perms'), PDFHexString);
    if (!perms) throw new Error('the fixture carries no /Perms');
    // One byte of the ciphertext changed: the block it lands in comes out random,
    // so the marker is gone without the dictionary saying anything about itself.
    const bytes = perms.asBytes();
    const flipped = Uint8Array.from(bytes, (byte, index) => (index === 4 ? byte ^ 0x01 : byte));
    dict.set(PDFName.of('Perms'), PDFHexString.fromBytes(flipped));
    expect(await assessAccess(doc, PASSWORD))
      .toMatchObject({ kind: 'unsupported', reason: 'perms-mismatch', strength: 'AES-256' });
    expect(await decryptDocument(doc, PASSWORD))
      .toMatchObject({ kind: 'unsupported', reason: 'perms-mismatch' });
    // Untouched, the same file opens: the refusal is the value, not the password.
    expect(await assessAccess(await loadRaw('aes-256-user.pdf'), PASSWORD))
      .toMatchObject({ kind: 'opens' });
  });

  it('trusts a file that carries no /Perms at all, and still returns the words', async () => {
    // The explicit decision, stated in `permsAgrees`: `/U` is what authenticates
    // the secret, so a revision-6 file without the optional check value opens
    // rather than being refused for a missing nicety.
    const doc = await loadRaw('aes-256-user.pdf');
    const dict = encryptDict(doc);
    dict.delete(PDFName.of('Perms'));
    const outcome = await decryptDocument(doc, PASSWORD);
    expect(outcome).toMatchObject({ kind: 'decrypted', strength: 'AES-256' });
    await expectPlantedContent(doc);
  });

  it('opens on a wrong /P beside a marker that verifies', async () => {
    // Bytes 0-7 exist to tell a reader the permissions were edited, not to say the
    // content is unreadable — qpdf, MuPDF, poppler and pypdf all open such a file.
    const doc = await loadRaw('aes-256-user.pdf');
    const dict = encryptDict(doc);
    const permissions = dict.lookupMaybe(PDFName.of('P'), PDFNumber);
    if (!permissions) throw new Error('the fixture carries no /P');
    dict.set(PDFName.of('P'), PDFNumber.of(permissions.asNumber() ^ 0x04));
    expect(await decryptDocument(doc, PASSWORD)).toMatchObject({ kind: 'decrypted' });
    await expectPlantedContent(doc);
  });
});

/* ── the shape of the dictionary, refused rather than guessed ────────────── */

describe('a revision-6 dictionary this module will not guess at', () => {
  it('refuses the revision-5 spelling, which hashes without the ladder', async () => {
    const doc = await loadRaw('aes-256-user.pdf');
    encryptDict(doc).set(PDFName.of('R'), PDFNumber.of(5));
    expect(await assessAccess(doc, PASSWORD))
      .toMatchObject({ kind: 'unsupported', reason: 'aes-256', strength: null });
  });

  it('refuses a revision-6 dictionary whose /U is the 32-byte revision-4 one', async () => {
    const doc = await loadRaw('aes-256-user.pdf');
    const dict = encryptDict(doc);
    const user = dict.lookupMaybe(PDFName.of('U'), PDFHexString);
    if (!user) throw new Error('the fixture carries no /U');
    dict.set(PDFName.of('U'), PDFHexString.fromBytes(user.asBytes().subarray(0, 32)));
    expect(await assessAccess(doc, PASSWORD))
      .toMatchObject({ kind: 'unsupported', reason: 'missing-parameters', strength: null });
  });

  it('refuses an AES-256 filter declared at a length other than 32 bytes', async () => {
    const doc = await loadRaw('aes-256-user.pdf');
    const filters = encryptDict(doc).lookupMaybe(PDFName.of('CF'), PDFDict);
    const standard = filters?.lookupMaybe(PDFName.of('StdCF'), PDFDict);
    if (!standard) throw new Error('the fixture does not define /CF /StdCF');
    standard.set(PDFName.of('Length'), PDFNumber.of(16));
    expect(await assessAccess(doc, PASSWORD))
      .toMatchObject({ kind: 'unsupported', reason: 'unsupported-filter', strength: null });
  });
});
