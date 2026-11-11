/**
 * The AES-256 write path: what this app puts into a revision-6 file, measured
 * against revision-6 files somebody else wrote.
 *
 * `tests/fixtures/encrypted/` carries four `/V 5 /R 6` files — libqpdf and MuPDF,
 * each as a user-password file and as an owner-password-only one — and
 * `tests/pdf/crypto-aes256.test.ts` proves this app can *undo* them. This file is
 * the other direction, and it is written so that direction cannot be proven by
 * this app agreeing with itself:
 *
 *   * **the foreign file's own randomness.** `revision6Values` is fed a fixture's
 *     own file key (unwrapped by the read path) and the fixture's own four salts
 *     and four `/Perms` random bytes, and must hand back that fixture's `/U`, `/UE`,
 *     `/O`, `/OE` and `/Perms` **byte for byte**. A ladder that picked SHA-384 on a
 *     different round, or that padded the password the revision-4 way, or that ran
 *     `/UE` through Web Crypto's padded encrypt, reproduces none of it — and the
 *     same call with a secret the fixture does not carry is asserted to reproduce
 *     none of it either, because "the comparison ran" is not a result.
 *   * **the file this writer produces**, read back by this app's own reader (words,
 *     title, field value, which secret opened it) and by **pdf.js**, which ships its
 *     own AES-256 and shares no code with this module.
 *   * **the outside readers**, run over files this writer produces by
 *     `docs/research/aes256-write-readers.py` (pypdf, MuPDF, libqpdf through
 *     pikepdf, poppler, Ghostscript), whose log is kept beside it.
 *
 * The details that silently corrupt each get an assertion: `/CFM /AESV3` with
 * `/Length 32` selected by both channels, the 48-byte `/O` and `/U`, the two
 * 32-byte wrapped keys under a zero IV with **no** padding, `/Perms` carrying `T`
 * or `F` at byte 8 and `adb` at 9-11, `/EncryptMetadata` written out loud and
 * obeyed, and both kinds of secret derived the way revision 6 derives them — which
 * is not the way revision 4 does, since at revision 6 the file key is random and no
 * password hashes into it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFRef, StandardFonts, degrees, rgb } from '@maxwbh/pdf-lib';
import {
  assessAccess,
  decryptDocument,
  encryptDocument,
  retainedLock,
  revision6Values,
  type Cipher,
  type Revision6Seal,
} from '@/lib/pdf/core/crypto';
import { openPDF, resealLikeSource, saveEncrypted } from '@/lib/pdf/core/doc';
import { inspectPdf } from '@/lib/pdf/core/guard';
import { openRender } from '@/lib/pdf/core/render';

const latin1 = new TextDecoder('latin1');
const FIXTURES = resolve(process.cwd(), 'tests/fixtures/encrypted');
/**
 * Where the outside-reader rig takes its files: `AES256_PROBE_DIR=/tmp/a256 npx
 * vitest run tests/pdf/crypto-aes256-write.test.ts` then
 * `python3 docs/research/aes256-write-readers.py /tmp/a256`.
 */
const PROBE_DIR = process.env.AES256_PROBE_DIR ?? '';
/** The secret `scripts/encrypted-fixtures.py` locked every fixture with. */
const PASSWORD = 'hunter2';
const PLANTED = 'Lighthouse Inventory 1887 page 1';
const USER = 'open-sesame';
const OWNER = 'owner-key';
const WRONG = 'not-the-password';
const WORDS = 'Secret Alice 42 Bravo';
const FIELD_VALUE = 'Ada Lovelace';
const TITLE = 'Lighthouse Inventory';

beforeAll(() => {
  // pdf.js points its worker at `import.meta.url`, which Vitest serves over
  // `http:` and Node's ESM loader refuses — and `openRender` re-assigns it on
  // every call, so the pin has to be a getter. Without this the second
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

beforeAll(() => {
  if (PROBE_DIR) mkdirSync(PROBE_DIR, { recursive: true });
});

const fixtureBytes = (name: string): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, name)));

/** A document with two pages, a field value and a title: one of each channel. */
async function sample(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < 2; index++) {
    const page = doc.addPage([306, 408]);
    page.drawText(`${WORDS} on page ${index + 1}`, { x: 24, y: 360, size: 14, font, color: rgb(0, 0, 0) });
  }
  doc.getForm().createTextField('applicant.name').setText(FIELD_VALUE);
  doc.setTitle(TITLE);
  return doc.save({ useObjectStreams: false });
}

/** Load as the file is carried, without undoing anything: the seal view. */
async function sealed(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
}

/** The `/Encrypt` dictionary body as the file spells it. */
function encryptBody(bytes: Uint8Array): string {
  const raw = latin1.decode(bytes);
  const start = raw.indexOf('/Filter /Standard');
  expect(start, 'no /Filter /Standard dictionary in the saved file').toBeGreaterThan(-1);
  return raw.slice(start, raw.lastIndexOf('>>', raw.indexOf('endobj', start)) + 2).replace(/\s+/g, ' ');
}

/** One dictionary value, in the hex the file carries it in. */
function dictHex(body: string, key: string): string {
  return new RegExp(`/${key} <([0-9A-Fa-f]+)>`).exec(body)?.[1] ?? '';
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/** `/P` as the check value records it: four bytes, low-order first. */
const le32 = (value: number): Uint8Array =>
  Uint8Array.from([value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff]);

/**
 * AES-256-ECB on one block, built from the platform's CBC — the test's own.
 *
 * `/Perms` is a single block under a zero IV, and the four bytes that make it
 * irreproducible are the random ones at 12-15. Reading them back is what lets the
 * byte-identity test hand the writer a foreign file's *whole* input, so this does
 * not borrow `core/crypto`'s unpad helper: decrypting `[C, E(C ⊕ 0x10…)]` yields
 * the ECB answer in block 1 and a well-formed pad in block 2, which Web Crypto
 * strips rather than throwing on.
 */
async function ecbOpenBlock(key: Uint8Array, block: Uint8Array): Promise<Uint8Array> {
  const api = globalThis.crypto.subtle;
  const handle = await api.importKey('raw', key, { name: 'AES-CBC' }, false, ['encrypt', 'decrypt']);
  const filler = await api.encrypt(
    { name: 'AES-CBC', iv: new Uint8Array(16) },
    handle,
    Uint8Array.from(block, (byte) => byte ^ 0x10),
  );
  const opened = await api.decrypt(
    { name: 'AES-CBC', iv: new Uint8Array(16) },
    handle,
    concat(block, new Uint8Array(filler, 0, 16)),
  );
  return new Uint8Array(opened, 0, 16);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Every page's own operators, inflated, with its string operands decoded. */
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
      const stored = stream.getContents();
      let text = latin1.decode(stored);
      try {
        text = latin1.decode(inflateSync(Buffer.from(stored)));
      } catch {
        /* stored raw, or ciphertext that will not inflate */
      }
      runs.push(text);
    }
    // MuPDF-style hex operands and literal operands both appear in real content.
    return runs.join(' ').replace(/<([0-9A-Fa-f\s]+)>/g, (_, digits: string) =>
      Buffer.from(digits.replace(/\s+/g, ''), 'hex').toString('latin1'));
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

/**
 * One file's whole revision-6 state, in the shape the writer takes as input.
 *
 * The file key comes out of the read path (`retainedLock` unwraps it from `/UE` or
 * `/OE`), the four salts out of the 48-byte `/U` and `/O`, and the check value's
 * four random bytes out of `/Perms` itself. `Cipher` carries those extras as
 * optional because it describes every strength, so the sizes revision 6 requires
 * are asserted here rather than compared through a `null`.
 */
async function revision6State(bytes: Uint8Array, password: string): Promise<{
  seal: Revision6Seal;
  carried: { user: Uint8Array; userWrap: Uint8Array; owner: Uint8Array; ownerWrap: Uint8Array; perms: Uint8Array };
  permsPlain: Uint8Array;
  cipher: Cipher;
}> {
  const lock = await retainedLock(bytes, password);
  expect(lock, 'the read path did not carry this file’s lock').not.toBeNull();
  const cipher = lock!.cipher;
  expect(cipher, 'a revision-6 file must yield a cipher, not a gate').not.toBeNull();
  const { user, owner } = cipher!;
  const userWrap = cipher!.userWrap;
  const ownerWrap = cipher!.ownerWrap;
  const perms = cipher!.perms;
  expect(user, '/U').toHaveLength(48);
  expect(owner, '/O').toHaveLength(48);
  expect(userWrap, '/UE').toHaveLength(32);
  expect(ownerWrap, '/OE').toHaveLength(32);
  expect(perms, '/Perms').toHaveLength(16);
  const permsPlain = await ecbOpenBlock(lock!.fileKey, perms!);
  return {
    cipher: cipher!,
    permsPlain,
    carried: { user, owner, userWrap: userWrap!, ownerWrap: ownerWrap!, perms: perms! },
    seal: {
      fileKey: lock!.fileKey,
      userValidationSalt: user.subarray(32, 40),
      userKeySalt: user.subarray(40, 48),
      ownerValidationSalt: owner.subarray(32, 40),
      ownerKeySalt: owner.subarray(40, 48),
      permsRandom: permsPlain.subarray(12, 16),
    },
  };
}

/* ── 1. the ladder, inverted, on files this app did not write ────────────── */

/**
 * The four revision-6 fixtures, with the secrets the corpus README says each
 * carries. An owner-only fixture has an **empty user** password, and revision 6
 * derives `/U` from the user secret with no user data and `/O` from the owner
 * secret with the whole 48-byte `/U` as user data — the one derivation the two
 * secrets do not share, which is why both variants are in this table.
 */
const R6_INPUTS = [
  { name: 'aes-256-user.pdf', producer: 'libqpdf', user: PASSWORD, owner: PASSWORD },
  { name: 'aes-256-owner.pdf', producer: 'libqpdf', user: '', owner: PASSWORD },
  { name: 'mu-aes-256-user.pdf', producer: 'MuPDF', user: PASSWORD, owner: PASSWORD },
  { name: 'mu-aes-256-owner.pdf', producer: 'MuPDF', user: '', owner: PASSWORD },
] as const;

describe.each(R6_INPUTS)('the writer, fed %s’s own randomness ($producer)', ({ name, user, owner }) => {
  it('reproduces the fixture’s /U, /UE, /O, /OE and /Perms byte for byte', async () => {
    const { cipher, carried, seal } = await revision6State(fixtureBytes(name), PASSWORD);
    expect(cipher.strength).toBe('AES-256');
    const values = await revision6Values(
      { userPassword: user, ownerPassword: owner, permissions: cipher.permissions, encryptMetadata: cipher.metadataEncrypted },
      seal,
    );
    expect(hex(values.user), '/U').toBe(hex(carried.user));
    expect(hex(values.userWrap), '/UE').toBe(hex(carried.userWrap));
    expect(hex(values.owner), '/O').toBe(hex(carried.owner));
    expect(hex(values.ownerWrap), '/OE').toBe(hex(carried.ownerWrap));
    expect(hex(values.perms), '/Perms').toBe(hex(carried.perms));
    // The key this writer wraps is 32 bytes of CSPRNG, never a hash of something
    // shorter: the spec pads a short file key with the 0x41…0x7E string, which is
    // the one case that padding exists for, and it is not this writer's.
    expect(values.fileKey).toHaveLength(32);
  }, 300_000);

  it('records /P, /EncryptMetadata and the marker where the readers look for them', async () => {
    const { cipher, permsPlain } = await revision6State(fixtureBytes(name), PASSWORD);
    // The producer's own check value, in the clear: `/P` little-endian, the upper
    // half of the 64-bit value all ones, `T` or `F` for the metadata, then `adb`.
    // Byte 8 is what `revision6PermsPlain` writes the flag into, and 9-11 is what
    // `permsAgrees` reads the marker from — one byte of drift and every file this
    // app writes refuses its own key.
    expect(hex(permsPlain.subarray(0, 4))).toBe(hex(le32(cipher.permissions)));
    expect(Array.from(permsPlain.subarray(4, 8))).toEqual([0xff, 0xff, 0xff, 0xff]);
    expect(latin1.decode(permsPlain.subarray(8, 12))).toBe(`${cipher.metadataEncrypted ? 'T' : 'F'}adb`);
  }, 300_000);

  it('reproduces none of it from a secret the fixture does not carry', async () => {
    // The negative half of the byte-identity claim: same randomness, wrong secret.
    const { cipher, carried, seal } = await revision6State(fixtureBytes(name), PASSWORD);
    const values = await revision6Values(
      { userPassword: WRONG, ownerPassword: WRONG, permissions: cipher.permissions, encryptMetadata: cipher.metadataEncrypted },
      seal,
    );
    expect(hex(values.user)).not.toBe(hex(carried.user));
    expect(hex(values.userWrap)).not.toBe(hex(carried.userWrap));
    expect(hex(values.owner)).not.toBe(hex(carried.owner));
    expect(hex(values.ownerWrap)).not.toBe(hex(carried.ownerWrap));
    // `/Perms` is over the file key, which the wrong secret did not change, so it
    // matching here is the point rather than a miss: the check value records the
    // dictionary, it does not authenticate a password.
    expect(hex(values.perms)).toBe(hex(carried.perms));
  }, 300_000);
});

/* ── 2. the file this writer produces ────────────────────────────────────── */

describe('an AES-256 file this app writes', () => {
  const write = async (): Promise<Uint8Array> => saveEncrypted(await sealed(await sample()), {
    userPassword: USER,
    ownerPassword: OWNER,
    cipher: 'AES-256',
    permissions: { printing: true, copying: false },
  });

  it('spells the revision-6 dictionary the fixtures spell', async () => {
    const body = encryptBody(await write());
    expect(body).toMatch(/\/V 5\b/);
    expect(body).toMatch(/\/R 6\b/);
    expect(body).toMatch(/\/Length 256\b/);
    expect(body).toMatch(/\/CF << \/StdCF << \/CFM \/AESV3/);
    expect(body).toMatch(/\/Length 32/);
    expect(body).toMatch(/\/StmF \/StdCF/);
    expect(body).toMatch(/\/StrF \/StdCF/);
    // Written out loud in both directions: an absent key means `true` to a reader
    // that defaults it and nothing to one that does not.
    expect(body).toMatch(/\/EncryptMetadata true/);
    expect(body).not.toMatch(/\/CFM \/AESV2/);
    // The five values, at revision-6 sizes — 32 bytes of `/U` is the revision-4
    // spelling this handler refuses on the way back in.
    expect(dictHex(body, 'O')).toHaveLength(96);
    expect(dictHex(body, 'U')).toHaveLength(96);
    expect(dictHex(body, 'OE')).toHaveLength(64);
    expect(dictHex(body, 'UE')).toHaveLength(64);
    expect(dictHex(body, 'Perms')).toHaveLength(32);
  }, 300_000);

  it('ciphers every stream and string, so the words are in neither', async () => {
    // The control first: the same reader, on the same bytes unlocked, does see the
    // phrase. Without it "the words are not in the file" would also be true of a
    // file whose content stream was simply never written.
    expect(pageWords(await sealed(await sample()))[0]).toContain(WORDS);
    const raw = latin1.decode(await write());
    expect(raw).not.toContain(WORDS);
    expect(raw).not.toContain(FIELD_VALUE);
    expect(raw).not.toContain(TITLE);
    let ciphered = 0;
    for (const [, object] of (await sealed(await write())).context.enumerateIndirectObjects()) {
      if (!(object instanceof PDFRawStream) || !object.dict.get(PDFName.of('Filter'))) continue;
      expect(() => inflateSync(Buffer.from(object.getContents())), 'a payload that inflates was not ciphered').toThrow();
      ciphered += 1;
    }
    expect(ciphered, 'the document holds no ciphered streams at all').toBeGreaterThan(0);
  }, 300_000);

  it('comes back through this app’s own reader, string channel included', async () => {
    const bytes = await write();
    expect(await assessAccess(await sealed(bytes), USER))
      .toMatchObject({ kind: 'opens', strength: 'AES-256', openedAs: 'user' });
    const outcome = await decryptDocument(await sealed(bytes), USER);
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: 'decrypted', strength: 'AES-256' });
    expect((outcome as { streams: number }).streams).toBeGreaterThan(0);
    expect((outcome as { strings: number }).strings).toBeGreaterThan(0);

    const doc = await openPDF(bytes, { password: USER });
    expect(pageWords(doc)[0]).toContain(WORDS);
    expect(doc.getTitle()).toBe(TITLE);
    const field = doc.getForm().getField('applicant.name');
    expect(field && 'getText' in field ? (field as { getText(): string }).getText() : null).toBe(FIELD_VALUE);
    // The owner secret opens the same file and says it was the owner: `/O` is
    // derived over the 48-byte `/U` and `/U` over nothing, so a writer that used
    // one derivation for both cannot produce this answer.
    expect(await assessAccess(await sealed(bytes), OWNER))
      .toMatchObject({ kind: 'opens', strength: 'AES-256', openedAs: 'owner', suppliedMatched: true });
    expect(await assessAccess(await sealed(bytes), WRONG))
      .toMatchObject({ kind: 'bad-password', strength: 'AES-256' });
    expect(await assessAccess(await sealed(bytes)))
      .toMatchObject({ kind: 'needs-password', strength: 'AES-256' });
  }, 300_000);

  it('answers pdf.js, which runs its own AES-256, with the same pages and words', async () => {
    const bytes = await write();
    // The claim is about AES-256 specifically. Without this line a writer that
    // quietly stayed at revision 4 would pass every verdict below for the wrong
    // reason, because pdf.js reads AES-128 perfectly well too.
    expect(encryptBody(bytes)).toMatch(/\/CFM \/AESV3/);
    expect(encryptBody(bytes)).toMatch(/\/R 6\b/);
    expect('refused' in await readerSays(bytes), 'pdf.js read a ciphered file with no password').toBe(true);
    expect('refused' in await readerSays(bytes, WRONG), 'pdf.js accepted a wrong password').toBe(true);
    const opened = await readerSays(bytes, USER);
    expect('pages' in opened, `pdf.js refused the file this app wrote: ${JSON.stringify(opened)}`).toBe(true);
    expect((opened as { pages: number }).pages).toBe(2);
    const text = (opened as { text: string }).text;
    expect(text).toContain(`${WORDS} on page 1`);
    expect(text).toContain(`${WORDS} on page 2`);
  }, 300_000);

  it('is a file the guard lets a rewriting tool touch', async () => {
    const seen = await inspectPdf(await write(), 'claim.pdf', { password: USER });
    expect(seen.encryption).toMatchObject({
      state: 'ciphered', algorithm: 'AES-256', method: 'AESV3', revision: 6, supported: true, refusal: null,
    });
    expect(seen.passwordAccepted).toBe(true);
    expect(seen.pages).toBe(2);
  }, 300_000);

  it('wraps its own /UE with the user secret and its /OE with the owner one', async () => {
    // The write side of the two derivations, checked against the file's own bytes.
    // Had the writer wrapped the key under one hash twice, `/OE` would not match.
    const { cipher, carried, seal } = await revision6State(await write(), USER);
    const values = await revision6Values(
      { userPassword: USER, ownerPassword: OWNER, permissions: cipher.permissions, encryptMetadata: cipher.metadataEncrypted },
      seal,
    );
    expect(hex(values.user)).toBe(hex(carried.user));
    expect(hex(values.userWrap)).toBe(hex(carried.userWrap));
    expect(hex(values.owner)).toBe(hex(carried.owner));
    expect(hex(values.ownerWrap)).toBe(hex(carried.ownerWrap));
    expect(hex(values.perms)).toBe(hex(carried.perms));
  }, 300_000);
});

/* ── 3. the owner-only variant, which revision 6 derives differently ─────── */

describe('an AES-256 file with no open password', () => {
  const write = async (): Promise<Uint8Array> => saveEncrypted(await sealed(await sample()), {
    userPassword: '',
    ownerPassword: OWNER,
    cipher: 'AES-256',
    permissions: { printing: false, copying: false, contentAccessibility: true },
  });

  it('asks nobody for a password, and still holds ciphertext', async () => {
    const bytes = await write();
    const seen = await inspectPdf(bytes, 'claim.pdf');
    expect(seen.encrypted).toBe(true);
    expect(seen.needsPassword, 'an empty user password must not ask for one').toBe(false);
    expect(seen.opensWithEmptyPassword).toBe(true);
    expect(seen.algorithm, 'restricted is not the same as in the clear').toBe('AES-256');
    expect(seen.permissions).toMatchObject({ printing: false, copying: false, contentAccessibility: true });
    expect(latin1.decode(bytes)).not.toContain(WORDS);

    const opened = await readerSays(bytes);
    expect('pages' in opened, `pdf.js refused a file with no open password: ${JSON.stringify(opened)}`).toBe(true);
    expect((opened as { text: string }).text).toContain(WORDS);
    expect(pageWords(await openPDF(bytes))[0]).toContain(WORDS);
  }, 300_000);

  it('derives /U from the empty secret and /O from the owner one', async () => {
    const bytes = await write();
    const lock = await retainedLock(bytes, OWNER);
    expect(lock!.openedAs, 'the owner secret must not be reported as the user one').toBe('owner');
    const { cipher, carried, seal } = await revision6State(bytes, OWNER);
    // The user secret here is the empty string — not the 32 bytes of Table 28 that
    // revision 4 hashes, which is the one place the two families disagree about what
    // a blank password means.
    const values = await revision6Values(
      { userPassword: '', ownerPassword: OWNER, permissions: cipher.permissions, encryptMetadata: cipher.metadataEncrypted },
      seal,
    );
    expect(hex(values.user)).toBe(hex(carried.user));
    expect(hex(values.userWrap)).toBe(hex(carried.userWrap));
    expect(hex(values.owner)).toBe(hex(carried.owner));
    expect(hex(values.perms)).toBe(hex(carried.perms));
  }, 300_000);

  it('names the owner secret as the one that lifts the restrictions', async () => {
    const bytes = await write();
    expect(await assessAccess(await sealed(bytes), OWNER))
      .toMatchObject({ kind: 'opens', openedAs: 'owner', suppliedMatched: true });
    // A wrong secret on a permissions-only file is still wrong: the empty user
    // secret opens it, and `suppliedMatched` is what says the typed one did not.
    expect(await assessAccess(await sealed(bytes), WRONG))
      .toMatchObject({ kind: 'opens', openedAs: 'empty', suppliedMatched: false });
  }, 300_000);
});

/* ── 4. /P and /EncryptMetadata, decided and recorded ────────────────────── */

describe('what the revision-6 check value records', () => {
  /** `/P` as the file itself carries it, not as the form asked for it. */
  const declared = (bytes: Uint8Array): number =>
    Number(/\/P (-?\d+)/.exec(encryptBody(bytes))?.[1] ?? 0);

  const asked = async (permissions: Record<string, boolean>): Promise<Uint8Array> => saveEncrypted(
    await sealed(await sample()),
    { userPassword: '', ownerPassword: OWNER, cipher: 'AES-256', permissions },
  );

  it('writes the /P it was given, where a reader can diff it', async () => {
    const wide = await asked({ printing: true, modifying: true, copying: true });
    const tight = await asked({ printing: false, modifying: false, copying: false });
    const widePlain = (await revision6State(wide, '')).permsPlain;
    const tightPlain = (await revision6State(tight, '')).permsPlain;
    // At revision 6 the file key is random, so `/P` is not mixed into it the way
    // revision 4 mixes it into Algorithm 2 — the check value is what records it,
    // and the bytes edited there are the tamper this value exists to show.
    expect(hex(widePlain.subarray(0, 4))).toBe(hex(le32(declared(wide))));
    expect(hex(tightPlain.subarray(0, 4))).toBe(hex(le32(declared(tight))));
    expect(declared(wide)).not.toBe(declared(tight));
    expect(hex(widePlain)).not.toBe(hex(tightPlain));
  }, 300_000);

  it('leaves the metadata in the clear only when it was told to', async () => {
    const lock = async (encryptMetadata: boolean): Promise<Uint8Array> => {
      const doc = await sealed(await sample());
      await encryptDocument(doc, {
        userPassword: USER,
        ownerPassword: OWNER,
        permissions: -3392,
        strength: 'AES-256',
        encryptMetadata,
      });
      return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
    };
    const ciphered = await lock(true);
    const clear = await lock(false);
    expect(encryptBody(ciphered)).toMatch(/\/EncryptMetadata true/);
    expect(encryptBody(clear)).toMatch(/\/EncryptMetadata false/);
    // `/Info` is exempt from the cipher with the flag false, and not with it true —
    // the dictionary's claim and the bytes behind it, checked in both directions.
    expect((await sealed(clear)).getTitle()).toBe(TITLE);
    expect((await sealed(ciphered)).getTitle()).not.toBe(TITLE);
    // The flag is byte 8 of the check value at this revision, not a key input.
    expect(String.fromCharCode((await revision6State(ciphered, USER)).permsPlain[8])).toBe('T');
    expect(String.fromCharCode((await revision6State(clear, USER)).permsPlain[8])).toBe('F');
    // Both files still read, pages and words included, and the page streams are
    // ciphered either way: `/EncryptMetadata false` unciphers the document's name
    // tags, not its content.
    for (const bytes of [ciphered, clear]) {
      expect(latin1.decode(bytes)).not.toContain(WORDS);
      expect(pageWords(await openPDF(bytes, { password: USER }))[0]).toContain(WORDS);
    }
  }, 300_000);

  it('refuses its own file when the check value is edited away from the key', async () => {
    // The `/Perms` gate in the read path, fed by a file this app wrote: one byte of
    // the ciphertext changed and the marker is gone, without the dictionary saying
    // anything about itself.
    const bytes = await asked({ printing: true });
    const sealedDoc = await sealed(bytes);
    const entry = sealedDoc.context.trailerInfo.Encrypt;
    const dict = entry instanceof PDFRef ? sealedDoc.context.lookupMaybe(entry, PDFDict) : entry;
    expect(dict instanceof PDFDict, 'the sealed file lost its dictionary').toBe(true);
    const value = dictHex(encryptBody(bytes), 'Perms');
    const flipped = Uint8Array.from(Buffer.from(value, 'hex'), (byte, index) => (index === 5 ? byte ^ 0x01 : byte));
    (dict as PDFDict).set(PDFName.of('Perms'), PDFHexString.fromBytes(flipped));
    expect(await assessAccess(sealedDoc, USER))
      .toMatchObject({ kind: 'unsupported', reason: 'perms-mismatch', strength: 'AES-256' });
    // Untouched, the same bytes open: the refusal is the value, not the password.
    expect(await assessAccess(await sealed(bytes), USER)).toMatchObject({ kind: 'opens', strength: 'AES-256' });
  }, 300_000);
});

/* ── 5. an AES-256 lock carried through an edit ──────────────────────────── */

describe('an edit to a file this app ciphered at 256 bits', () => {
  it('keeps the source’s own /O, /U, /OE, /UE, /Perms and /ID[0]', async () => {
    // `protect` issues the lock; a later, unrelated edit must not re-issue it. At
    // revision 6 that is the same rule as everywhere else with sharper teeth: a
    // re-derived lock means a new random file key, which is every stream in the
    // file ciphered under a key the secret the user holds no longer unwraps.
    const locked = await saveEncrypted(await sealed(await sample()), {
      userPassword: '', ownerPassword: OWNER, cipher: 'AES-256', permissions: { printing: false },
    });
    const edited = await openPDF(locked);
    edited.setTitle('Renamed');
    const resealed = await resealLikeSource(edited, locked);
    expect(resealed, 'the edit lost the lock it arrived with').not.toBeNull();
    expect(resealed!.strength).toBe('AES-256');

    const before = encryptBody(locked);
    const after = encryptBody(resealed!.bytes);
    for (const key of ['O', 'U', 'OE', 'UE', 'Perms']) {
      expect(dictHex(after, key), `/${key} changed, so the secret did too`).toBe(dictHex(before, key));
    }
    expect(/\/P (-?\d+)/.exec(after)![1]).toBe(/\/P (-?\d+)/.exec(before)![1]);
    expect(after).toMatch(/\/V 5\b/);
    expect(after).toMatch(/\/R 6\b/);
    // Still ciphertext, still readable, still asks for nothing.
    expect(latin1.decode(resealed!.bytes)).not.toContain(FIELD_VALUE);
    const seen = await inspectPdf(resealed!.bytes, 'renamed.pdf');
    expect(seen.algorithm).toBe('AES-256');
    expect(seen.opensWithEmptyPassword).toBe(true);
    const doc = await openPDF(resealed!.bytes);
    expect(doc.getTitle()).toBe('Renamed');
    expect(pageWords(doc)[0]).toContain(WORDS);
  }, 300_000);

  it('hands a fixture’s words through an edit and back out at its own strength', async () => {
    // The foreign direction, over a file this app did not write: turn a sheet of the
    // libqpdf fixture, re-seal with its carried lock, and the copy is AES-256 with
    // the sentence still on it.
    const source = fixtureBytes('aes-256-user.pdf');
    const doc = await openPDF(source, { password: PASSWORD });
    expect(pageWords(doc)[0]).toContain(PLANTED);
    doc.getPage(0).setRotation(degrees(90));
    const resealed = await resealLikeSource(doc, source, PASSWORD);
    expect(resealed, 'the AES-256 lock was not carried forward').not.toBeNull();
    expect(resealed!.strength).toBe('AES-256');
    expect(latin1.decode(resealed!.bytes)).not.toContain(PLANTED);
    const copy = await openPDF(resealed!.bytes, { password: PASSWORD });
    expect(pageWords(copy)[0]).toContain(PLANTED);
    expect(copy.getPageCount()).toBe(3);
    expect(copy.getPage(0).getRotation().angle).toBe(90);
  }, 300_000);
});

/* ── 6. the files the outside readers are shown ──────────────────────────── */

/**
 * The corpus's own three locks, written by this app.
 *
 * `tests/fixtures/encrypted/plain.pdf` is the base every foreign fixture was
 * locked from, and `/P` is the `-3376` the corpus carries — copy and accessibility
 * allowed, print, modify, annotate, form-fill and assemble refused. So a reader
 * that has already been shown `aes-256-user.pdf` and `mu-aes-256-owner.pdf` is
 * shown these: the planted sentence, the sheet words, the ink, the bookmarks and
 * the permissions are the ones `scripts/encrypted-fixtures.py` measured, and any
 * difference left is the cipher's, not the document's.
 *
 * The dumps are asserted before they are written, and asserted against this app's
 * reader as well as the byte-level claims — `docs/research/aes256-write-readers.py`
 * is the second opinion, not the only one.
 */
describe('the AES-256 files the outside readers are shown', () => {
  /** The corpus permission set, spelled the way `permissionsToFlags` takes it. */
  const CORPUS_PERMISSIONS = { copying: true, contentAccessibility: true };

  const dump = (name: string, bytes: Uint8Array): void => {
    if (PROBE_DIR) writeFileSync(join(PROBE_DIR, name), bytes);
  };

  /** `/P` as the saved file spells it. */
  const permissionsOf = (bytes: Uint8Array): number =>
    Number(/\/P (-?\d+)/.exec(encryptBody(bytes))?.[1] ?? 0);

  it('locks the fixture base at -3376 with an open password', async () => {
    const bytes = await saveEncrypted(await sealed(fixtureBytes('plain.pdf')), {
      userPassword: PASSWORD, ownerPassword: PASSWORD, cipher: 'AES-256', permissions: CORPUS_PERMISSIONS,
    });
    expect(permissionsOf(bytes), 'the same /P the qpdf and MuPDF fixtures carry').toBe(-3376);
    expect(latin1.decode(bytes)).toMatch(/\/CFM \/AESV3/);
    expect(latin1.decode(bytes)).not.toContain(PLANTED);
    expect(pageWords(await openPDF(bytes, { password: PASSWORD }))[0]).toContain(PLANTED);
    const opened = await readerSays(bytes, PASSWORD);
    expect('pages' in opened, `pdf.js refused this lock: ${JSON.stringify(opened)}`).toBe(true);
    expect((opened as { text: string }).text).toContain(PLANTED);
    expect('refused' in await readerSays(bytes), 'a user-password file must not open with nothing').toBe(true);
    dump('a256-app-user.pdf', bytes);
  }, 300_000);

  it('locks it again with no open password, at the same /P', async () => {
    const bytes = await saveEncrypted(await sealed(fixtureBytes('plain.pdf')), {
      userPassword: '', ownerPassword: PASSWORD, cipher: 'AES-256', permissions: CORPUS_PERMISSIONS,
    });
    expect(permissionsOf(bytes)).toBe(-3376);
    expect(latin1.decode(bytes)).not.toContain(PLANTED);
    const seen = await inspectPdf(bytes, 'a256-app-owner.pdf');
    expect(seen).toMatchObject({ encrypted: true, needsPassword: false, opensWithEmptyPassword: true, algorithm: 'AES-256' });
    expect(pageWords(await openPDF(bytes))[0]).toContain(PLANTED);
    expect(await assessAccess(await sealed(bytes), PASSWORD))
      .toMatchObject({ kind: 'opens', openedAs: 'owner', suppliedMatched: true });
    dump('a256-app-owner.pdf', bytes);
  }, 300_000);

  it('locks it a third time with the metadata left in the clear', async () => {
    const doc = await sealed(fixtureBytes('plain.pdf'));
    await encryptDocument(doc, {
      userPassword: PASSWORD,
      ownerPassword: PASSWORD,
      permissions: -3376,
      strength: 'AES-256',
      encryptMetadata: false,
    });
    const bytes = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
    expect(encryptBody(bytes)).toMatch(/\/EncryptMetadata false/);
    expect(permissionsOf(bytes)).toBe(-3376);
    // `/Title` readable, the page's operators not: the exemption and the cipher,
    // both doing their own jobs in the same file.
    expect((await sealed(bytes)).getTitle()).toBe(PLANTED.split(' page')[0]);
    expect(latin1.decode(bytes)).not.toContain(PLANTED);
    expect(pageWords(await openPDF(bytes, { password: PASSWORD }))[0]).toContain(PLANTED);
    dump('a256-app-plainmeta.pdf', bytes);
  }, 300_000);
});
