/**
 * `core/crypto` — the read path for a PDF somebody else ciphered.
 *
 * An `/Encrypt` entry says two different things, and this app used to hear only
 * one of them. It says *which secret opens the file*, which `@maxwbh/pdf-lib`
 * does check; and it says *the strings and streams are ciphertext*, which nothing
 * checked or undid: the fork ships `PDFSecurity.decryptStream` with **no caller**,
 * so a foreign AES-128 file reached every tool as raw ciphertext behind its own
 * `/Filter`. The measured cost
 * (`docs/research/encrypted-inputs-findings.md` §3): 18 of 18 rebuilt files kept
 * their page count, kept answering to the user's password, and lost every word —
 * `planted_pages 3 → 0`, sheet-1 ink `0.46 % → 0.0 %`, text `182 → 0` characters,
 * and `qpdf --check` reporting errors on all 18.
 *
 * This module undoes that, for the two strengths it can **prove** with content:
 *
 *   * **RC4-128** — `/V 2 /R 3`, the pre-crypt-filter handler (ISO 32000-1 §7.3.3,
 *     revision 3).
 *   * **AES-128** — `/V 4 /R 4` whose effective crypt filter is `/CFM /AESV2`
 *     (§7.4.4, revision 4).
 *
 * Everything else is refused by name rather than by silence: AES-256 (`/R 5`,
 * `/R 6`, `/CFM /AESV3` and its `/OE`/`/UE`/`/Perms` derivations), 40-bit RC4 (no
 * outside fixture, so no claim to make), public-key handlers (`/Filter` other than
 * `/Standard`), a crypt filter that is named but not defined, and any file whose
 * objects live in **object streams** — `@maxwbh/pdf-lib` expands those while it
 * parses, before any caller can decrypt, so their content is already gone by the
 * time this module is asked. `assessAccess` reports which of these it is, and
 * `core/guard.ts` refuses a rewrite on that answer rather than on the bare
 * presence of a cipher.
 *
 * The primitives, in the order the constraints arrive: **MD5** comes from
 * `node-forge`, already a dependency and already how `core/attachments.ts`
 * computes a file's `/CheckSum` (Web Crypto does not implement MD5).
 * **AES-128-CBC** is native Web Crypto, which is why the pass is asynchronous.
 * **RC4** has no Web Crypto name, so it is delegated to the fork's own
 * `rc4Encrypt`, which this module's fixture test exercises end to end. Nothing
 * leaves the tab and nothing new is installed.
 *
 * The two kinds of secret stay apart, because the spec keeps them apart: the
 * **user** secret gates opening, the **owner** secret gates permissions and grants
 * a reader access as well. `DecryptOutcome.openedAs` says which one was typed, and
 * `suppliedMatched` is false for a wrong password on a permissions-only file
 * instead of quietly true because the file happened to open.
 */
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFString,
  rc4Encrypt,
} from '@maxwbh/pdf-lib';
import type { PDFContext, PDFDocument, PDFObject } from '@maxwbh/pdf-lib';
import { md } from 'node-forge';

/** The strength names this app decrypts, and the guard reports as supported. */
export type CipherStrength = 'RC4-128' | 'AES-128';

/** Why a cipher is left alone, in the vocabulary `core/guard.ts` renders. */
export type UnsupportedReason =
  /** `/CFM /AESV3`, `/R 5` or `/R 6`: needs `/OE`/`/UE`/`/Perms`. */
  | 'aes-256'
  /** 40-bit RC4 (`/V 1 /R 2`): no outside fixture, so no claim to make. */
  | 'rc4-40'
  /** `/Filter` is not `/Standard`: a public-key (certificate) handler. */
  | 'public-key'
  /** A crypt filter that is named but not defined, or a method not understood. */
  | 'unsupported-filter'
  /** The dictionary lacks a value the key derivation needs. */
  | 'missing-parameters'
  /** AES-CBC is unavailable in this browser (no `crypto.subtle`). */
  | 'no-aes-primitives'
  /** Objects live in object streams, which the parser cannot re-read. */
  | 'object-streams'
  /** The effective crypt filter is `/None`: a password gate over plaintext. */
  | 'no-cipher';

/** What `assessAccess` answers about one parsed document and one candidate secret. */
export type AccessVerdict =
  | {
      kind: 'opens';
      strength: CipherStrength;
      /** Whose secret opened it; `empty` is a permissions-only lock. */
      openedAs: 'user' | 'owner' | 'empty';
      /** The supplied password verified by itself, rather than the empty one. */
      suppliedMatched: boolean;
      fileKey: Uint8Array;
    }
  | { kind: 'needs-password'; strength: CipherStrength }
  | { kind: 'bad-password'; strength: CipherStrength }
  | { kind: 'gate-only' }
  | { kind: 'unsupported'; reason: UnsupportedReason; strength: CipherStrength | null };

/** What `decryptDocument` answers, after the attempt. */
export type DecryptOutcome =
  | {
      kind: 'decrypted';
      strength: CipherStrength;
      /** Whose secret opened it; `empty` is a permissions-only lock. */
      openedAs: 'user' | 'owner' | 'empty';
      /** The supplied password verified by itself, rather than the empty one. */
      suppliedMatched: boolean;
      streams: number;
      strings: number;
    }
  | { kind: 'needs-password'; strength: CipherStrength }
  | { kind: 'bad-password'; strength: CipherStrength }
  | { kind: 'unsupported'; reason: UnsupportedReason; strength: CipherStrength | null };

/** The 32 bytes every pre-revision-6 password is padded with (Table 28). */
const PASSWORD_PADDING = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

/** The four bytes an AES crypt filter adds to the object-key hash (Table 31). */
const AES_SALT = Uint8Array.from([0x73, 0x41, 0x6c, 0x54]);

const utf8 = new TextEncoder();

/** A byte string as JavaScript holds it: one code unit per byte. */
const binary = (bytes: Uint8Array): string => String.fromCharCode(...Array.from(bytes));

/** The inverse of `binary`, for a digest that came back as a byte string. */
const fromBinary = (text: string): Uint8Array =>
  Uint8Array.from(text, (character) => character.charCodeAt(0));

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** MD5 over the concatenation, the way every PDF key derivation wants it. */
function md5(...parts: Uint8Array[]): Uint8Array {
  const digest = md.md5.create();
  digest.update(binary(concat(...parts)));
  return fromBinary(digest.digest().bytes());
}

function xorWithRepeat(key: Uint8Array, value: number): Uint8Array {
  return Uint8Array.from(key, (byte) => byte ^ value);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((byte, index) => byte === right[index]);
}

/**
 * A password as the pre-revision-6 algorithms take it: 32 bytes, padded or cut.
 *
 * A non-ASCII secret is hashed as its UTF-8 bytes, which is what this app writes
 * its own gate with, so a file this app locked and a file it is reading agree on
 * what the password means.
 */
function padSecret(text: string): Uint8Array {
  const bytes = utf8.encode(text);
  if (bytes.length >= 32) return bytes.subarray(0, 32);
  return concat(bytes, PASSWORD_PADDING.subarray(0, 32 - bytes.length));
}

/* ── AES-128-CBC through Web Crypto ──────────────────────────────────────── */

function subtle(): SubtleCrypto | null {
  const host = (globalThis as { crypto?: Crypto }).crypto;
  return host?.subtle ?? null;
}

/** Whether AES-CBC exists here; RC4-only files never ask, so the probe is per-strength. */
export function hasAesPrimitives(): boolean {
  return typeof subtle()?.importKey === 'function';
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function aesKey(key: Uint8Array): Promise<CryptoKey> {
  const cacheKey = binary(key);
  let pending = keyCache.get(cacheKey);
  if (!pending) {
    const api = subtle();
    if (!api) return Promise.reject(new Error('Web Crypto AES is unavailable'));
    pending = api.importKey('raw', key, { name: 'AES-CBC' }, false, ['decrypt', 'encrypt']);
    keyCache.set(cacheKey, pending);
  }
  return pending;
}

/** `E(k, data)` for one block: the first block of a CBC encryption with a zero IV. */
async function aesEncryptBlock(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const api = subtle();
  if (!api) throw new Error('Web Crypto AES is unavailable');
  const sealed = await api.encrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, await aesKey(key), data);
  return new Uint8Array(sealed, 0, 16);
}

/** Drop a well-formed PKCS#5 pad; keep everything else as content. */
function stripPadding(plain: Uint8Array): Uint8Array {
  const count = plain[plain.length - 1] ?? 0;
  if (count < 1 || count > 16 || count > plain.length) return plain;
  const tail = plain.subarray(plain.length - count);
  return tail.every((byte) => byte === count) ? plain.subarray(0, plain.length - count) : plain;
}

/**
 * Decrypt a PDF string or stream: 16-byte IV, then whole AES-128-CBC blocks.
 *
 * Producers do get the padding wrong, and a payload this module cannot hand back
 * is a blank page, so a bad pad is tolerated: when Web Crypto's strict unpadding
 * throws, a synthetic padding block is appended and unpad-decrypted, which leaves
 * every real byte in place.
 */
async function aesCbcDecrypt(key: Uint8Array, payload: Uint8Array): Promise<Uint8Array> {
  const api = subtle();
  if (!api) throw new Error('Web Crypto AES is unavailable');
  if (payload.length < 32 || (payload.length - 16) % 16 !== 0) {
    throw new Error(`an AES payload of ${payload.length} bytes is not block-aligned`);
  }
  const iv = payload.subarray(0, 16);
  const cipher = payload.subarray(16);
  const cryptoKey = await aesKey(key);
  try {
    return stripPadding(new Uint8Array(await api.decrypt({ name: 'AES-CBC', iv }, cryptoKey, cipher)));
  } catch {
    const last = cipher.subarray(cipher.length - 16);
    const filler = await aesEncryptBlock(key, xorOnes(last, 16));
    const loosened = await api.decrypt({ name: 'AES-CBC', iv }, cryptoKey, concat(cipher, filler));
    const whole = new Uint8Array(loosened, 0, loosened.byteLength - 16);
    return stripPadding(whole);
  }
}

/** XOR every byte with `value`. */
function xorOnes(bytes: Uint8Array, value: number): Uint8Array {
  return Uint8Array.from(bytes, (byte) => byte ^ value);
}

/* ── the encryption dictionary ───────────────────────────────────────────── */

/** The `/Encrypt` dictionary, whether the trailer references it or inlines it. */
function encryptionDict(context: PDFContext): PDFDict | undefined {
  const entry = context.trailerInfo.Encrypt;
  if (entry instanceof PDFDict) return entry;
  if (entry instanceof PDFRef) return context.lookupMaybe(entry, PDFDict);
  return undefined;
}

function integer(dict: PDFDict, key: string): number | null {
  const value = dict.lookupMaybe(PDFName.of(key), PDFNumber);
  return value ? Math.trunc(value.asNumber()) : null;
}

function secretBytes(dict: PDFDict, key: string): Uint8Array | null {
  const value = dict.lookupMaybe(PDFName.of(key), PDFString, PDFHexString);
  return value ? value.asBytes() : null;
}

/** The document's first `/ID` string: a salt in every key derivation. */
function documentId(context: PDFContext): Uint8Array | null {
  const entry = context.trailerInfo.ID;
  const array = entry instanceof PDFRef ? context.lookupMaybe(entry, PDFArray) : entry;
  if (!(array instanceof PDFArray)) return null;
  const first = array.get(0);
  if (first instanceof PDFString || first instanceof PDFHexString) return first.asBytes();
  return null;
}

type Method = 'RC4' | 'AESV2';

/** The predefined filters: named in `/StmF`, never listed in `/CF`. */
const PLAINTEXT_FILTERS = new Set(['None', 'Identity']);

/** A filter name resolved to what it does to bytes, or why this module cannot say. */
type Filter =
  | { ok: true; method: Method | null; keyBytes: number | null }
  | { ok: false; reason: UnsupportedReason };

/**
 * Resolve one crypt filter name to its method.
 *
 * `method: null` is an answer, not a failure: an absent `/StmF` (whose default is
 * the predefined `/None`) and a filter whose `/CFM` is `/None` both mean "these
 * bytes are already plaintext", which is the gate this app's own `protect` writes.
 */
function resolveFilter(dict: PDFDict, name: string | null): Filter {
  if (name === null || PLAINTEXT_FILTERS.has(name)) return { ok: true, method: null, keyBytes: null };
  const declared = dict.lookupMaybe(PDFName.of('CF'), PDFDict)?.get(PDFName.of(name));
  const filter = declared instanceof PDFRef ? dict.context.lookupMaybe(declared, PDFDict) : declared;
  if (!(filter instanceof PDFDict)) return { ok: false, reason: 'unsupported-filter' };
  const method = filter.lookupMaybe(PDFName.of('CFM'), PDFName)?.decodeText() ?? 'None';
  const declaredLength = integer(filter, 'Length');
  if (method === 'None' || method === 'Identity') return { ok: true, method: null, keyBytes: null };
  if (method === 'V2') return { ok: true, method: 'RC4', keyBytes: (declaredLength ?? 128) / 8 };
  if (method === 'AESV2') return { ok: true, method: 'AESV2', keyBytes: declaredLength ?? 16 };
  // `/AESV3` and anything else (`/Crypt` with a sub-filter, RFC 3164 mail
  // encryption) is a cipher this seam does not implement: named, never guessed.
  return { ok: false, reason: method === 'AESV3' ? 'aes-256' : 'unsupported-filter' };
}

interface Cipher {
  strength: CipherStrength;
  revision: number;
  /** The method in force over streams, and over strings; `null` is plaintext. */
  stream: Method | null;
  string: Method | null;
  keyBytes: number;
  owner: Uint8Array;
  user: Uint8Array;
  permissions: number;
  /** `/EncryptMetadata false`: the user metadata and `/Info` stay in the clear. */
  metadataEncrypted: boolean;
  documentId: Uint8Array;
}

type CipherRead = { ok: true; cipher: Cipher } | { ok: false; reason: UnsupportedReason };

/**
 * Everything the key derivation needs, read once from the dictionary.
 *
 * This asks the same question `core/guard.ts:classifyEncryption` asks — the
 * **effective** filter, not the strongest name in the file, because a dictionary
 * can define a filter it never selects — and answers it narrowly: only RC4 at a
 * 16-byte key and `/CFM /AESV2` come back as a cipher. `/V 3` without a `/CF`
 * dictionary is the revision that could mean either, so it is refused rather than
 * assumed.
 */
function readCipher(context: PDFContext, dict: PDFDict): CipherRead {
  const handler = dict.lookupMaybe(PDFName.of('Filter'), PDFName)?.decodeText();
  if (handler !== 'Standard') return { ok: false, reason: 'public-key' };

  const version = integer(dict, 'V') ?? 1;
  const revision = integer(dict, 'R');
  if (revision === null) return { ok: false, reason: 'missing-parameters' };
  if (revision >= 5 || version >= 5) return { ok: false, reason: 'aes-256' };

  const owner = secretBytes(dict, 'O');
  const user = secretBytes(dict, 'U');
  const permissions = integer(dict, 'P');
  const id = documentId(context);
  if (!owner || !user || owner.length < 32 || user.length < 32) return { ok: false, reason: 'missing-parameters' };
  if (permissions === null || !id) return { ok: false, reason: 'missing-parameters' };

  const declaresFilters = dict.lookupMaybe(PDFName.of('CF'), PDFDict) !== undefined;
  let stream: Method | null = 'RC4';
  let string: Method | null = 'RC4';
  let keyBytes = (integer(dict, 'Length') ?? 40) / 8;

  if (version >= 4 || declaresFilters) {
    if (!declaresFilters) return { ok: false, reason: 'unsupported-filter' };
    const streamFilter = resolveFilter(dict, dict.lookupMaybe(PDFName.of('StmF'), PDFName)?.decodeText() ?? null);
    const stringFilter = resolveFilter(dict, dict.lookupMaybe(PDFName.of('StrF'), PDFName)?.decodeText() ?? null);
    if (!streamFilter.ok) return { ok: false, reason: streamFilter.reason };
    if (!stringFilter.ok) return { ok: false, reason: stringFilter.reason };
    if (streamFilter.method === null && stringFilter.method === null) {
      // The `/None` filter is in force over both channels: a gate, not a cipher.
      return { ok: false, reason: 'no-cipher' };
    }
    // One method over both channels is what a `/V 4` handler writes. A file that
    // mixes them, or caps the key anywhere but 16 bytes, is refused rather than
    // half-decrypted: a stream left ciphered reads as a blank page.
    if (streamFilter.method !== stringFilter.method) return { ok: false, reason: 'unsupported-filter' };
    const method = streamFilter.method;
    if (method === null) return { ok: false, reason: 'no-cipher' };
    if (streamFilter.keyBytes !== null && streamFilter.keyBytes !== 16) {
      return { ok: false, reason: 'unsupported-filter' };
    }
    stream = method;
    string = method;
    keyBytes = 16;
  } else if (version === 3 || keyBytes !== 16) {
    return { ok: false, reason: keyBytes <= 5 ? 'rc4-40' : 'unsupported-filter' };
  }

  if (stream === 'AESV2' && !hasAesPrimitives()) return { ok: false, reason: 'no-aes-primitives' };

  const metadata = dict.lookupMaybe(PDFName.of('EncryptMetadata'), PDFBool);
  return {
    ok: true,
    cipher: {
      strength: stream === 'AESV2' ? 'AES-128' : 'RC4-128',
      revision,
      stream,
      string,
      keyBytes,
      owner,
      user,
      permissions,
      metadataEncrypted: metadata ? metadata === PDFBool.True : true,
      documentId: id,
    },
  };
}

/* ── key derivation (ISO 32000-1 §7.3.3, revisions 2-4) ──────────────────── */

/** Algorithm 2: the file encryption key, from a padded user password. */
function fileEncryptionKey(cipher: Cipher, padded: Uint8Array): Uint8Array {
  const parts = [
    padded,
    cipher.owner,
    Uint8Array.from([
      cipher.permissions & 0xff,
      (cipher.permissions >> 8) & 0xff,
      (cipher.permissions >> 16) & 0xff,
      (cipher.permissions >> 24) & 0xff,
    ]),
    cipher.documentId,
  ];
  if (cipher.revision >= 4 && !cipher.metadataEncrypted) {
    parts.push(Uint8Array.from([0xff, 0xff, 0xff, 0xff]));
  }
  let hash = md5(...parts);
  if (cipher.revision >= 3) {
    for (let round = 0; round < 50; round++) hash = md5(hash.subarray(0, cipher.keyBytes));
  }
  return hash.subarray(0, cipher.keyBytes);
}

/**
 * Algorithms 4 and 5: the value a correct password puts in `/U`.
 *
 * The stored `/U` is 32 bytes and only its first 16 are the hash; the rest is
 * arbitrary, which is why the comparison is a 16-byte one.
 */
function userKey(cipher: Cipher, fileKey: Uint8Array): Uint8Array {
  if (cipher.revision === 2) return rc4Encrypt(fileKey, PASSWORD_PADDING);
  let value = rc4Encrypt(fileKey, md5(PASSWORD_PADDING, cipher.documentId));
  for (let round = 1; round <= 19; round++) {
    value = rc4Encrypt(xorWithRepeat(fileKey, round), value);
  }
  return value;
}

/**
 * Algorithm 7 backwards: the user passwords the owner secret could be wrapping.
 *
 * The file key is derived from the *user* password, so an owner secret has to
 * unwind `/O` first. Every unpadded candidate is returned — the padding is
 * self-describing but a real password can end inside the pad pattern — and each
 * one is verified against `/U` before it is trusted.
 */
function userSecretsFromOwner(cipher: Cipher, ownerPassword: string): Uint8Array[] {
  let hash = md5(padSecret(ownerPassword));
  if (cipher.revision >= 3) {
    for (let round = 0; round < 50; round++) hash = md5(hash);
  }
  const key = hash.subarray(0, cipher.keyBytes);
  let value = rc4Encrypt(key, cipher.owner.subarray(0, 32));
  if (cipher.revision >= 3) {
    for (let round = 19; round >= 1; round--) value = rc4Encrypt(xorWithRepeat(key, round), value);
  }
  const candidates: Uint8Array[] = [];
  for (let length = 0; length <= 32; length++) {
    const tail = value.subarray(length);
    if (tail.every((byte, index) => byte === PASSWORD_PADDING[length + index])) {
      candidates.push(concat(value.subarray(0, length), PASSWORD_PADDING.subarray(0, 32 - length)));
    }
  }
  return candidates;
}

/** Algorithm 1: the per-object key, salted by object number, generation and `/sAlT`. */
function objectKey(cipher: Cipher, fileKey: Uint8Array, ref: PDFRef, method: Method): Uint8Array {
  const seed = Uint8Array.from([
    ...fileKey,
    ref.objectNumber & 0xff,
    (ref.objectNumber >> 8) & 0xff,
    (ref.objectNumber >> 16) & 0xff,
    ref.generationNumber & 0xff,
    (ref.generationNumber >> 8) & 0xff,
  ]);
  const hash = md5(method === 'AESV2' ? concat(seed, AES_SALT) : seed);
  return hash.subarray(0, Math.min(fileKey.length + 5, 16));
}

function opensWith(cipher: Cipher, padded: Uint8Array): Uint8Array | null {
  const fileKey = fileEncryptionKey(cipher, padded);
  const computed = userKey(cipher, fileKey);
  return equalBytes(computed.subarray(0, 16), cipher.user.subarray(0, 16)) ? fileKey : null;
}

/**
 * Which secret this is, and the file key it yields.
 *
 * The supplied password is tried as the user secret, then as the owner secret
 * (which is a different lock, and a reader is entitled to open it), then the empty
 * password — the whole of a permissions-only lock. A password that is none of
 * those is `bad-password`, never an "accepted" file that then decrypts to
 * mojibake; on a permissions-only file it still opens, and `suppliedMatched: false`
 * is what says the typed secret was not the one it opened with.
 */
function verdictFor(cipher: Cipher, password: string | undefined): AccessVerdict {
  if (password) {
    const asUser = opensWith(cipher, padSecret(password));
    if (asUser) return { kind: 'opens', strength: cipher.strength, fileKey: asUser, openedAs: 'user', suppliedMatched: true };
    for (const candidate of userSecretsFromOwner(cipher, password)) {
      const fileKey = opensWith(cipher, candidate);
      if (fileKey) return { kind: 'opens', strength: cipher.strength, fileKey, openedAs: 'owner', suppliedMatched: true };
    }
  }
  const asEmpty = opensWith(cipher, padSecret(''));
  if (asEmpty) {
    return { kind: 'opens', strength: cipher.strength, fileKey: asEmpty, openedAs: 'empty', suppliedMatched: password === '' };
  }
  return password
    ? { kind: 'bad-password', strength: cipher.strength }
    : { kind: 'needs-password', strength: cipher.strength };
}

/**
 * Read one parsed document's lock and say what this module can do with it.
 *
 * This is the whole of what `core/guard.ts` asks before refusing a rewrite, and
 * the same answer `decryptDocument` acts on, so the refusal and the decryption
 * cannot drift apart.
 */
export function assessAccess(doc: PDFDocument, password?: string): AccessVerdict {
  const dict = encryptionDict(doc.context);
  if (!dict) return { kind: 'unsupported', reason: 'missing-parameters', strength: null };
  const read = readCipher(doc.context, dict);
  if (!read.ok) {
    return read.reason === 'no-cipher'
      ? { kind: 'gate-only' }
      : { kind: 'unsupported', reason: read.reason, strength: null };
  }
  // A cipher this module can undo is still useless where the page tree lives
  // inside an object stream: those bytes were inflated before anyone was asked.
  if (objectStreamsUnreadable(doc)) {
    return { kind: 'unsupported', reason: 'object-streams', strength: read.cipher.strength };
  }
  return verdictFor(read.cipher, password);
}

/* ── the pass ────────────────────────────────────────────────────────────── */

/**
 * Files this app cannot read even with the cipher undone.
 *
 * `@maxwbh/pdf-lib` expands object streams while it parses, so their contents are
 * inflated **before** any decryptor is consulted. In a ciphered file that inflate
 * fails, the parser keeps the bytes as an invalid object, and every dictionary
 * inside — page tree, outlines, form fields — is absent. It is visible from the
 * context, and it is not a cipher this module can serve.
 */
export function objectStreamsUnreadable(doc: PDFDocument): boolean {
  return doc.context
    .enumerateIndirectObjects()
    .some(([, object]) => object?.constructor?.name === 'PDFInvalidObject');
}

/**
 * Decrypt one parsed document in place.
 *
 * Each stream payload is replaced with its plaintext — **before** the `/Filter`
 * chain runs, because that is the order the spec writes them in: plaintext, then
 * flate, then cipher — and each string with its decoded bytes. A stream's
 * `/Length` follows the new count, direct or behind a reference, because a writer
 * that copies the old dictionary over shorter bytes would describe plaintext with
 * a ciphertext length.
 *
 * The `/Encrypt` entry is then dropped from the trailer: the bytes this document
 * now holds are plaintext and `@maxwbh/pdf-lib`'s writer runs no cipher on the way
 * out, so keeping the dictionary would be the same false claim in the other
 * direction. `core/guard.ts` reads the *source* file's own dictionary before this
 * runs, and `tools/runner.ts:preserveProtection` re-applies this app's password
 * gate to the result, so a locked input does not silently come back unlocked.
 */
export async function decryptDocument(doc: PDFDocument, password?: string): Promise<DecryptOutcome> {
  const context = doc.context;
  const verdict = assessAccess(doc, password);
  if (verdict.kind === 'gate-only') return { kind: 'unsupported', reason: 'no-cipher', strength: null };
  if (verdict.kind !== 'opens') return verdict;
  const { fileKey, openedAs, suppliedMatched, strength } = verdict;
  const cipher = cipherOf(context);
  if (!cipher) return { kind: 'unsupported', reason: 'missing-parameters', strength };

  const exempt = exemptRefs(context, cipher);
  let streams = 0;
  let strings = 0;

  for (const [ref, object] of context.enumerateIndirectObjects()) {
    const cleared = exempt.has(refKey(ref));
    if (object instanceof PDFRawStream) {
      if (cipher.stream && !cleared) {
        const plain = await decryptBytes(cipher, fileKey, ref, cipher.stream, object.getContents());
        writeStream(context, ref, object, plain);
        streams += 1;
      }
      if (!cleared) strings += await decryptStrings(context, object.dict, ref, cipher, fileKey);
      continue;
    }
    if (!cleared) strings += await decryptStrings(context, object, ref, cipher, fileKey);
  }

  context.trailerInfo.Encrypt = undefined;
  return { kind: 'decrypted', strength, openedAs, suppliedMatched, streams, strings };
}

/** The dictionary `assessAccess` already read, taken back out for the walk. */
function cipherOf(context: PDFContext): Cipher | null {
  const dict = encryptionDict(context);
  if (!dict) return null;
  const read = readCipher(context, dict);
  return read.ok ? read.cipher : null;
}

const refKey = (ref: PDFRef): string => `${ref.objectNumber} ${ref.generationNumber}`;

/** One payload's bytes, under one method. */
function decryptBytes(
  cipher: Cipher,
  fileKey: Uint8Array,
  ref: PDFRef,
  method: Method,
  data: Uint8Array,
): Promise<Uint8Array> | Uint8Array {
  const key = objectKey(cipher, fileKey, ref, method);
  return method === 'RC4' ? rc4Encrypt(key, data) : aesCbcDecrypt(key, data);
}

/**
 * The objects the spec leaves in the clear.
 *
 * The encryption dictionary's own `/O`, `/U`, `/OE` and `/UE` are keys and are
 * never ciphered (ISO 32000-1 §7.3.2.1), and with `/EncryptMetadata false` the
 * `/Info` dictionary and the user metadata stream stay readable — which matters
 * twice over, because both feed the key derivation.
 */
function exemptRefs(context: PDFContext, cipher: Cipher): Set<string> {
  const exempt = new Set<string>();
  const mark = (value: unknown) => {
    if (value instanceof PDFRef) exempt.add(refKey(value));
  };
  mark(context.trailerInfo.Encrypt);
  if (cipher.metadataEncrypted) return exempt;
  mark(context.trailerInfo.Info);
  mark(context.lookupMaybe(context.trailerInfo.Root, PDFDict)?.get(PDFName.of('Metadata')));
  return exempt;
}

/** Put a decrypted payload back, with the length that matches its bytes. */
function writeStream(context: PDFContext, ref: PDFRef, stream: PDFRawStream, plain: Uint8Array): void {
  const declared = stream.dict.get(PDFName.of('Length'));
  const length = PDFNumber.of(plain.length);
  if (declared instanceof PDFRef) context.assign(declared, length);
  else stream.dict.set(PDFName.of('Length'), length);
  context.assign(ref, PDFRawStream.of(stream.dict, plain));
}

/**
 * Decrypt every string of one object in place, with that object's key, and return
 * how many were undone.
 *
 * Strings are rewritten as hex because arbitrary bytes have to survive: a literal
 * `(...)` would need the cipher's output escaped, and a value that came out wrong
 * would read as mojibake rather than refuse.
 */
async function decryptStrings(
  context: PDFContext,
  value: unknown,
  ref: PDFRef,
  cipher: Cipher,
  fileKey: Uint8Array,
  depth = 0,
): Promise<number> {
  const method = cipher.string;
  if (!method || depth > 24) return 0;
  if (value instanceof PDFString || value instanceof PDFHexString) {
    return 0;
  }
  if (value instanceof PDFArray) {
    let done = 0;
    for (let index = 0; index < value.size(); index++) {
      const item = value.get(index);
      if (item instanceof PDFString || item instanceof PDFHexString) {
        value.set(index, PDFHexString.fromBytes(await decryptBytes(cipher, fileKey, ref, method, item.asBytes())));
        done += 1;
      } else {
        done += await decryptStrings(context, item, ref, cipher, fileKey, depth + 1);
      }
    }
    return done;
  }
  if (value instanceof PDFDict) {
    let done = 0;
    for (const [key, item] of value.entries()) {
      if (item instanceof PDFString || item instanceof PDFHexString) {
        value.set(key, PDFHexString.fromBytes(await decryptBytes(cipher, fileKey, ref, method, item.asBytes())));
        done += 1;
      } else {
        done += await decryptStrings(context, item, ref, cipher, fileKey, depth + 1);
      }
    }
    return done;
  }
  return 0;
}

/** Keep the type import honest: this module reads parsed values, it never builds them. */
export type { PDFObject };
