/**
 * The decryption seam, measured against the words the document was written with.
 *
 * `tests/fixtures/encrypted/` holds files locked by **outside** encryptors —
 * libqpdf 12.3.2 and MuPDF 1.28.2, never by this app — over one countable base
 * document (`plain.pdf`, same directory): three pages that each name their own
 * sheet, so "the page count is right and the text is gone" is visible rather than
 * theoretical. That is the failure this module exists to end, and it is why every
 * test here asserts **extracted text equal to the planted plaintext**: the rig in
 * `docs/research/encrypted-inputs-findings.md` §3 measured 18 of 18 rebuilt files
 * that opened, counted 3 pages, still answered to the password, and held 0
 * characters. An "it decrypted" assertion would have passed on all 18.
 *
 * The scope is the three strengths proven here — RC4-128 (`/V 2 /R 3`), AES-128
 * (`/V 4 /R 4 /CFM /AESV2`) and AES-256 (`/V 5 /R 6 /CFM /AESV3`, whose own
 * derivations, secrets and `/Perms` decision are worked through in
 * `tests/pdf/crypto-aes256.test.ts`). What is left *refused by name* is named at
 * the bottom of this file, because a guard that claims a strength it cannot read
 * is the same trap wearing a different hat.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef } from '@maxwbh/pdf-lib';
import type { PDFPage } from '@maxwbh/pdf-lib';
import { assessAccess, decryptDocument } from '@/lib/pdf/core/crypto';
import { openPDF, saveEncrypted } from '@/lib/pdf/core/doc';
import { saveGateOnly } from './gate-harness';
import { streamBytes } from '@/lib/pdf/core/content';

const FIXTURES = resolve(process.cwd(), 'tests/fixtures/encrypted');
const PASSWORD = 'hunter2';
const WRONG = 'not-the-password';

/** What `scripts/encrypted-fixtures.py` plants on each sheet of the base file. */
const PLANTED = 'Lighthouse Inventory 1887';
const SHEETS = ['ALPHA', 'BRAVO', 'CHARLIE'];
const SHEET_TEXT = SHEETS.map((sheet) => `${PLANTED} page ${SHEETS.indexOf(sheet) + 1}`);

const fixtureBytes = (name: string): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, name)));

/**
 * The words the engine can read on each page: every string operand of every
 * content stream, inflated first.
 *
 * MuPDF writes page text as hex strings, so the operands are decoded rather than
 * grepped; a stream that will not inflate (ciphertext under `/FlateDecode`) throws
 * here, which is the measurement, not an accident to swallow.
 */
function pageWords(doc: PDFDocument): string[] {
  return doc.getPages().map((page) => decodeStrings(contentsText(doc, page)));
}

/** The first `/Contents` stream of a page, inline or behind a reference. */
function firstContentStream(doc: PDFDocument, page: PDFPage): PDFRawStream {
  const value = page.node.get(PDFName.of('Contents'));
  const item = value instanceof PDFArray ? value.get(0) : value;
  const stream = item instanceof PDFRef ? doc.context.lookup(item) : item;
  if (!(stream instanceof PDFRawStream)) throw new Error('this page has no raw /Contents stream');
  return stream;
}

function contentsText(doc: PDFDocument, page: PDFPage): string {
  const value = page.node.get(PDFName.of('Contents'));
  const items = value instanceof PDFArray
    ? Array.from({ length: value.size() }, (_, index) => value.get(index))
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

/** The engine's own lenient read: structure parsed, bytes untouched. */
async function loadRaw(name: string): Promise<PDFDocument> {
  return PDFDocument.load(fixtureBytes(name), { ignoreEncryption: true, updateMetadata: false });
}

/** What the unlocked base says, so every expectation below is a measurement. */
describe('the base document every fixture starts from', () => {
  it('carries one planted sentence and one sheet word per page', async () => {
    const words = pageWords(await loadRaw('plain.pdf'));
    expect(words.length).toBe(3);
    words.forEach((page, index) => {
      expect(page).toContain(SHEET_TEXT[index]);
      expect(page).toContain(`Sheet ${SHEETS[index]} body copy`);
    });
  });
});

/* ── the three strengths this app now reads ────────────────────────────────── */

describe.each([
  ['rc4-128-user.pdf', 'RC4-128', 'qpdf'],
  ['mu-rc4-128-user.pdf', 'RC4-128', 'MuPDF'],
  ['aes-128-user.pdf', 'AES-128', 'qpdf'],
  ['mu-aes-128-user.pdf', 'AES-128', 'MuPDF'],
])('decrypting %s (%s by %s)', (name, strength) => {
  it('names the cipher from the dictionary before anything is undone', async () => {
    const verdict = await assessAccess(await loadRaw(name), PASSWORD);
    expect(verdict.kind).toBe('opens');
    if (verdict.kind !== 'opens') return;
    expect(verdict.strength).toBe(strength);
    expect(verdict.openedAs).toBe('user');
  });

  it('hands back the planted sentence on every page, and the real title', async () => {
    const doc = await loadRaw(name);
    const outcome = await decryptDocument(doc, PASSWORD);
    expect(outcome).toMatchObject({ kind: 'decrypted', strength, openedAs: 'user', suppliedMatched: true });
    expect(outcome.kind === 'decrypted' && outcome.streams).toBeGreaterThan(0);
    expect(outcome.kind === 'decrypted' && outcome.strings).toBeGreaterThan(0);

    const words = pageWords(doc);
    expect(words.length).toBe(3);
    words.forEach((page, index) => {
      expect(page).toContain(SHEET_TEXT[index]);
      expect(page).toContain(`Sheet ${SHEETS[index]} body copy`);
    });
    // The string pass, proven on a value rather than on a byte count.
    expect(doc.getTitle()).toBe(PLANTED);
    expect(doc.getAuthor()).toBe('encrypted fixtures');
  });

  it('leaves the engine holding flate, not ciphertext, and drops the claim', async () => {
    const doc = await loadRaw(name);
    await decryptDocument(doc, PASSWORD);
    const stream = firstContentStream(doc, doc.getPages()[0]);
    // A zlib stream starts `78` + one of four legal check bytes; before this
    // module it started with whatever the cipher happened to produce.
    const head = Array.from(stream.getContents()).slice(0, 2).map((byte) => byte.toString(16).padStart(2, '0'));
    expect(head[0]).toBe('78');
    expect(['01', '5e', '9c', 'da']).toContain(head[1]);
    expect(stream.dict.lookupMaybe(PDFName.of('Length'), PDFNumber)?.asNumber()).toBe(stream.getContents().length);
    // The document no longer tells a reader to decrypt what is already plaintext.
    expect(doc.context.trailerInfo.Encrypt).toBeUndefined();
  });

  it('survives a save, and the saved bytes still hold the words', async () => {
    const doc = await loadRaw(name);
    await decryptDocument(doc, PASSWORD);
    const bytes = await doc.save({ useObjectStreams: false });
    const words = pageWords(await PDFDocument.load(bytes, { updateMetadata: false }));
    words.forEach((page, index) => expect(page).toContain(SHEET_TEXT[index]));
    expect(new TextDecoder('latin1').decode(bytes)).not.toMatch(/\/Encrypt(?![A-Za-z0-9_])/);
  });
});

/* ── the two kinds of secret ─────────────────────────────────────────────── */

describe('the two secrets an /Encrypt dictionary can carry', () => {
  it('asks for a password when the user secret is real', async () => {
    expect(await assessAccess(await loadRaw('rc4-128-user.pdf'))).toMatchObject({ kind: 'needs-password' });
    const outcome = await decryptDocument(await loadRaw('rc4-128-user.pdf'));
    expect(outcome).toMatchObject({ kind: 'needs-password', strength: 'RC4-128' });
  });

  it('refuses a wrong password instead of opening on the empty one', async () => {
    const doc = await loadRaw('rc4-128-user.pdf');
    expect(await assessAccess(doc, WRONG)).toMatchObject({ kind: 'bad-password' });
    expect(await decryptDocument(await loadRaw('rc4-128-user.pdf'), WRONG))
      .toMatchObject({ kind: 'bad-password' });
    expect(doc.isEncrypted).toBe(true);
  });

  it('opens a permissions-only file with nothing typed, and says it was the empty secret', async () => {
    const doc = await loadRaw('rc4-128-owner.pdf');
    expect(await assessAccess(doc)).toMatchObject({ kind: 'opens', openedAs: 'empty', suppliedMatched: false });
    const outcome = await decryptDocument(doc);
    expect(outcome).toMatchObject({ kind: 'decrypted', openedAs: 'empty', suppliedMatched: false });
    expect(pageWords(doc)[0]).toContain(SHEET_TEXT[0]);
    expect(doc.getTitle()).toBe(PLANTED);
  });

  it('keeps the owner secret distinct from the user secret it is not', async () => {
    // The owner-only fixture carries `hunter2` as its *owner* secret, so it opens
    // as the owner rather than as the empty user password it also answers to.
    const ownerFile = await loadRaw('rc4-128-owner.pdf');
    expect(await decryptDocument(ownerFile, PASSWORD))
      .toMatchObject({ kind: 'decrypted', openedAs: 'owner', suppliedMatched: true });
    expect(pageWords(ownerFile)[0]).toContain(SHEET_TEXT[0]);
    // On a file whose user secret is real, the owner secret opens it too — as the
    // owner, unwrapped from `/O` rather than accepted because `Boolean(password)`.
    const userFile = await decryptDocument(await loadRaw('rc4-128-user.pdf'), PASSWORD);
    expect(userFile).toMatchObject({ kind: 'decrypted', openedAs: 'user' });
  });

  it('does not call a deliberately wrong password correct on a permissions-only file', async () => {
    const outcome = await decryptDocument(await loadRaw('rc4-128-owner.pdf'), WRONG);
    expect(outcome).toMatchObject({ kind: 'decrypted', openedAs: 'empty', suppliedMatched: false });
  });
});

/* ── what is still refused, and by name ──────────────────────────────────── */

describe('the ciphers this module does not claim', () => {
  it('reads AES-256 now, and proves its streams were ciphered before it did', async () => {
    // The refusal this file exists to end: read leniently, the revision-6 fixture's
    // page stream will not inflate, and the same document hands back its words a few
    // lines later. `tests/pdf/crypto-aes256.test.ts` holds the derivation-level
    // assertions; this one keeps the two sides of the change in one place.
    expect(await assessAccess(await loadRaw('aes-256-user.pdf'), PASSWORD))
      .toMatchObject({ kind: 'opens', strength: 'AES-256' });
    expect(await decryptDocument(await loadRaw('aes-256-user.pdf'), PASSWORD))
      .toMatchObject({ kind: 'decrypted', strength: 'AES-256' });
    const shut = await loadRaw('aes-256-user.pdf');
    expect(() => streamBytes(firstContentStream(shut, shut.getPages()[0]))).toThrow();
    const opened = await loadRaw('aes-256-user.pdf');
    await decryptDocument(opened, PASSWORD);
    expect(pageWords(opened)[0]).toContain(SHEET_TEXT[0]);
  });

  it('refuses AES-256 under a handler revision it has no fixture for', async () => {
    // Revision 5 hashes the password without the ladder and revision 7 runs the
    // crypt filter without the padding. Both are named rather than guessed: the
    // dictionary below is the revision-6 fixture's own, with the `/R` the module
    // has no outside-locked file to check against, which is the whole reason it is
    // still refused.
    const doc = await loadRaw('aes-256-user.pdf');
    const entry = doc.context.trailerInfo.Encrypt;
    const dict = entry instanceof PDFRef ? doc.context.lookupMaybe(entry, PDFDict) : entry;
    if (!(dict instanceof PDFDict)) throw new Error('the fixture carries no /Encrypt dictionary');
    dict.set(PDFName.of('R'), PDFNumber.of(5));
    expect(await assessAccess(doc, PASSWORD))
      .toMatchObject({ kind: 'unsupported', reason: 'aes-256', strength: null });
    expect(await decryptDocument(doc, PASSWORD))
      .toMatchObject({ kind: 'unsupported', reason: 'aes-256' });
  });

  it('calls a password gate a gate, not a cipher — the shape this app used to write', async () => {
    // Built by the gate harness rather than by `saveEncrypted`, because that writer
    // runs AES-128 now: what has to keep being classified `gate-only` is a file
    // somebody else left in the clear behind a prompt, including every copy this
    // app protected before the cipher landed.
    const bytes = await saveGateOnly(await loadRaw('plain.pdf'), { userPassword: PASSWORD, ownerPassword: PASSWORD });
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    expect(await assessAccess(doc, PASSWORD)).toEqual({ kind: 'gate-only' });
    expect(await decryptDocument(doc, PASSWORD))
      .toMatchObject({ kind: 'unsupported', reason: 'no-cipher' });
    // Its streams were never ciphered, so its words are readable untouched.
    expect(pageWords(doc)[0]).toContain(SHEET_TEXT[0]);
  });

  it('reads back the file this app now writes, at the strength it names', async () => {
    const bytes = await saveEncrypted(await loadRaw('plain.pdf'), {
      userPassword: PASSWORD,
      ownerPassword: PASSWORD,
    });
    const sealed = () => PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    expect(await assessAccess(await sealed(), PASSWORD))
      .toMatchObject({ kind: 'opens', strength: 'AES-128', openedAs: 'user' });
    // Before the pass its page will not even inflate, and after it the words are
    // there: the two directions of this module, on bytes this module wrote.
    const shut = await sealed();
    expect(() => pageWords(shut)).toThrow(/could not be decompressed/);
    expect(await decryptDocument(await sealed(), PASSWORD))
      .toMatchObject({ kind: 'decrypted', strength: 'AES-128' });
    const opened = await openPDF(bytes, { password: PASSWORD });
    expect(pageWords(opened)[0]).toContain(SHEET_TEXT[0]);
  });
});

