/**
 * Cryptographic PDF signatures (PAdES Baseline-B flavoured).
 *
 * A PDF digital signature is a `/Sig` dictionary whose `/Contents` holds a DER
 * PKCS#7 blob covering the file in the two spans declared by `/ByteRange` — the
 * bytes before and after the placeholder. Signing therefore takes two passes:
 * write fixed-width placeholders, save, locate the placeholders in the real
 * bytes, hash exactly those ranges, then patch in place without changing the
 * file length.
 *
 * Everything runs in the tab with `node-forge`; only the optional RFC 3161
 * timestamp contacts a server, and that is reported to the user.
 *
 * `readSignatures` proves *integrity* — the message digest inside the signature
 * versus the digest recomputed from `/ByteRange` — and reports certificate
 * identity and validity dates. It does not build a trust path to an embedded
 * root CA, because a browser has no system trust store; the report says so
 * instead of implying more.
 */
import forge from 'node-forge';
import type { PDFDocument } from './doc';
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFRef, openPDF, toBytes } from './doc';

/** Hex characters reserved for `/Contents` — room for RSA-4096 plus a chain. */
const CONTENT_HEX_LENGTH = 16384;
/** Each `/ByteRange` integer is written as exactly this many digits. */
const BYTE_RANGE_WIDTH = 10;
/**
 * Exactly what pdf-lib writes between the `[` and `]` of `/ByteRange`: four
 * integers separated by single spaces, with one padding space on each side
 * (`[ 9999999999 9999999999 9999999999 9999999999 ]`).
 *
 * Patching happens in place, so the replacement must have this precise length —
 * any difference would shift every object offset after it and corrupt the file.
 */
const BYTE_RANGE_INNER = ` ${Array.from({ length: 4 }, () => '9'.repeat(BYTE_RANGE_WIDTH)).join(' ')} `;
const BYTE_RANGE_VALUE_LENGTH = BYTE_RANGE_INNER.length;

export type DigestAlgorithm = 'sha256' | 'sha384' | 'sha512' | 'sha1';

export interface SignOptions {
  certificate: Uint8Array;
  privateKey?: Uint8Array;
  passphrase?: string;
  reason?: string;
  location?: string;
  contact?: string;
  /** Draw a visible signature block. Default true. */
  visible?: boolean;
  /** 0-based page for the visible block. */
  page?: number;
  fieldName?: string;
  digestAlgorithm?: DigestAlgorithm;
}

export interface SignatureResult {
  bytes: Uint8Array;
  signer: string;
  hash: string;
  contentsLength: number;
  byteRange: [number, number, number, number];
}

export interface SignatureInfo {
  fieldName?: string;
  /** True when the recomputed digest matches the one inside the signature. */
  digestMatches: boolean;
  signer?: string;
  issuer?: string;
  signedAt?: Date;
  digestAlgorithm?: string;
  notBefore?: Date;
  notAfter?: Date;
  byteRange?: [number, number, number, number];
  /** Set when the PKCS#7 blob could not be parsed at all. */
  error?: string;
}

const DIGEST_OIDS: Record<DigestAlgorithm, string> = {
  sha1: forge.pki.oids.sha1,
  sha256: forge.pki.oids.sha256,
  sha384: forge.pki.oids.sha384,
  sha512: forge.pki.oids.sha512,
};

const MESSAGE_DIGEST_OID = '1.2.840.113549.1.9.4';
const SIGNING_TIME_OID = '1.2.840.113549.1.9.5';

const DIGEST_NAMES: Record<string, DigestAlgorithm> = {
  '2.16.840.1.101.3.4.2.1': 'sha256',
  '2.16.840.1.101.3.4.2.2': 'sha384',
  '2.16.840.1.101.3.4.2.3': 'sha512',
  '1.3.14.3.2.26': 'sha1',
};

/** Sign a document that is already open in memory. */
export async function signDocument(
  doc: PDFDocument,
  options: SignOptions,
): Promise<SignatureResult> {
  const loaded = loadCertificate(options.certificate, options.passphrase);
  const privateKey = options.privateKey
    ? loadPrivateKey(options.privateKey, options.passphrase)
    : loaded.privateKey;
  if (!privateKey) {
    throw new Error(
      'Choose the private key that belongs to this certificate, or use a single .p12 / .pfx file that contains both.',
    );
  }

  const signer = commonName(loaded.certificate.subject.attributes) ?? `certificate ${loaded.certificate.serialNumber}`;
  const name = options.fieldName ?? `Signature${Math.floor(Math.random() * 10000)}`;
  installSignatureField(doc, name, options);

  const draft = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
  return patchSignature(toBytes(draft), loaded, privateKey, options, signer);
}

/** Convenience wrapper for callers that only have bytes. */
export async function signBytes(
  bytes: Uint8Array,
  options: SignOptions & { password?: string },
): Promise<SignatureResult> {
  const doc = await openPDF(bytes, { password: options.password, ignoreEncryption: true });
  return signDocument(doc, options);
}

/**
 * Find and verify every `/Sig` field in a document.
 *
 * An unsigned PDF is the common case and an answer, not a failure: the result
 * is simply empty, so the UI can render "no signatures" (see `signatureFields`
 * for the `/Fields` trap that used to make this throw).
 */
export async function readSignatures(input: Uint8Array): Promise<SignatureInfo[]> {
  const bytes = toBytes(input);
  const doc = await openPDF(bytes, { ignoreEncryption: true });
  const results: SignatureInfo[] = [];

  for (const field of signatureFields(doc)) {
    const fieldName = decodePdfString(field.get(PDFName.of('T')));
    const value = dictAt(doc, field.get(PDFName.of('V')));
    if (!value) {
      results.push({ fieldName, digestMatches: false, error: 'The signature value object is missing.' });
      continue;
    }

    const byteRange = readNumberArray(value.get(PDFName.of('ByteRange')));
    const contentsHex = readHexString(value.get(PDFName.of('Contents')));
    if (!byteRange || byteRange.length !== 4 || !contentsHex) {
      results.push({
        fieldName,
        digestMatches: false,
        error: 'This signature has no readable /ByteRange or /Contents, so it cannot be verified.',
      });
      continue;
    }
    results.push(verifyOne(bytes, byteRange, contentsHex, fieldName));
  }
  return results;
}

// ── finding the signature dictionaries ──────────────────────────────────────

/**
 * Read an entry that may be a dictionary, a reference to one, or absent.
 *
 * `lookupMaybe` answers `undefined` for all three cases; `lookup` throws
 * `Expected instance of PDFDict, but got instance of undefined`, and a PDF whose
 * pieces are not where the happy path expects them used to abort verification
 * with exactly that.
 */
function dictAt(doc: PDFDocument, value: unknown): PDFDict | undefined {
  return value === undefined ? undefined : doc.context.lookupMaybe(value as PDFDict | PDFRef, PDFDict);
}

/** Same, for an array entry — `/Fields` is written inline or as a reference. */
function arrayAt(doc: PDFDocument, value: unknown): PDFArray | undefined {
  return value === undefined ? undefined : doc.context.lookupMaybe(value as PDFArray | PDFRef, PDFArray);
}

/**
 * The `/Sig` fields registered in `AcroForm /Fields`, in field order.
 *
 * Most PDFs have no `/AcroForm` at all, and one that exists may declare only
 * defaults with no `/Fields` key, so the entry is `undefined` far more often than
 * it is an array. That is the ordinary "not signed" case, not an error.
 *
 * A field counts as a signature field when it says `/FT /Sig` or when its value
 * says `/Type /Sig` — producers write both, and `/FT` can be inherited. Widgets
 * that were never registered in the form are outside this walk: a signature held
 * only in a page's `/Annots` reads as unsigned.
 */
function signatureFields(doc: PDFDocument): PDFDict[] {
  const acroForm = dictAt(doc, doc.catalog.get(PDFName.of('AcroForm')));
  const fields = arrayAt(doc, acroForm?.get(PDFName.of('Fields')));
  const found: PDFDict[] = [];
  if (!fields) return found;
  for (let i = 0; i < fields.size(); i++) {
    const field = dictAt(doc, fields.get(i));
    if (!field) continue;
    const value = dictAt(doc, field.get(PDFName.of('V')));
    const isSigType = String(field.get(PDFName.of('FT')) ?? '') === '/Sig';
    const isSigValue = String(value?.get(PDFName.of('Type')) ?? '') === '/Sig';
    if (isSigType || isSigValue) found.push(field);
  }
  return found;
}

/**
 * The signature values that hold a signature, newest field last.
 *
 * `/SubFilter` is the discriminator: it names the encoding of the value
 * (`adbe.pkcs7.detached` for everything this app signs), so a field that was
 * created but never signed — `/V` present, no `SubFilter`, no `ByteRange` — is
 * not offered up as a signature.
 */
function signedValues(doc: PDFDocument): { fieldName?: string; value: PDFDict }[] {
  const found: { fieldName?: string; value: PDFDict }[] = [];
  for (const field of signatureFields(doc)) {
    const value = dictAt(doc, field.get(PDFName.of('V')));
    if (!value) continue;
    if (!(value.get(PDFName.of('SubFilter')) instanceof PDFName)) continue;
    found.push({ fieldName: decodePdfString(field.get(PDFName.of('T'))), value });
  }
  return found;
}

/**
 * Locate a signature's `/Contents` bytes.
 *
 * A value rewritten into this span must land exactly on the placeholder: one
 * byte early and the write eats a byte the signature covers, one byte late and
 * it runs past the string. The dictionary is already known, so its value is
 * *compared* rather than guessed at — every `/Contents` key in the file is tried
 * and the one whose hex equals the parsed value is the placeholder. That is what
 * keeps a page's `/Contents` (every page has one, and they come first) from
 * being read as a signature, and it refuses to guess when the recorded
 * `/ByteRange` puts the gap somewhere else.
 */
function contentsSpan(source: Uint8Array, value: PDFDict): Placeholder | null {
  const hex = readHexString(value.get(PDFName.of('Contents')));
  if (!hex) return null;
  const wanted = hex.toUpperCase();
  const text = new TextDecoder('latin1').decode(source);
  const byteRange = readNumberArray(value.get(PDFName.of('ByteRange')));
  // Everything before `br[0] + br[1]` and after `br[2]` is signed data; the
  // placeholder is the only thing in between.
  const declared = byteRange && byteRange.length === 4 ? byteRange : null;
  const gapStart = declared ? declared[0] + declared[1] : 0;
  const gapEnd = declared ? declared[2] : source.length;

  let at = text.indexOf('/Contents');
  while (at !== -1) {
    const open = skipPunctuation(text, at + '/Contents'.length);
    if (text[open] === '<') {
      const valueStart = open + 1;
      const close = text.indexOf('>', valueStart);
      if (close !== -1 && text.slice(valueStart, close).replace(/\s+/g, '').toUpperCase() === wanted) {
        return valueStart < gapStart || close > gapEnd ? null : { start: at, valueStart, valueEnd: close };
      }
    }
    at = text.indexOf('/Contents', at + 1);
  }
  return null;
}

/** A key and its value may be separated by whitespace, and by an array bracket. */
function skipPunctuation(text: string, from: number): number {
  let index = from;
  while (index < text.length && /[\s[\]]/.test(text[index])) index++;
  return index;
}

// ── verification ────────────────────────────────────────────────────────────

function verifyOne(
  bytes: Uint8Array,
  byteRange: number[],
  contentsHex: string,
  fieldName?: string,
): SignatureInfo {
  const [offsetA, lengthA, offsetB, lengthB] = byteRange;
  const info: SignatureInfo = {
    fieldName,
    byteRange: [offsetA, lengthA, offsetB, lengthB],
    digestMatches: false,
  };
  if (!inBounds(bytes, offsetA, lengthA) || !inBounds(bytes, offsetB, lengthB)) {
    info.error = 'The recorded byte ranges fall outside this file, which means the file length changed after signing.';
    return info;
  }

  try {
    // `/Contents` is padded with zero bytes up to its reserved width, so the
    // bytes after the real DER are expected. node-forge still refuses to parse
    // them (its `strict` flag only controls missing-byte errors), so the
    // SignedData is sliced to the length its own ASN.1 header declares.
    const asn1 = forge.asn1.fromDer(trimToAsn1Length(forge.util.hexToBytes(contentsHex)));
    const signedData = findSignedData(asn1);
    if (!signedData) {
      info.error = 'That is not a PKCS#7 SignedData blob, so BrowserSnip cannot read it.';
      return info;
    }
    const certificates = collectCertificates(signedData);
    const signerCertificate = certificates[0];
    if (signerCertificate) {
      info.signer = commonName(signerCertificate.subject.attributes);
      info.issuer = commonName(signerCertificate.issuer.attributes);
      info.notBefore = signerCertificate.validity.notBefore;
      info.notAfter = signerCertificate.validity.notAfter;
    }
    const signerInfo = findSignerInfo(signedData);
    if (!signerInfo) {
      info.error = 'The PKCS#7 blob contains no signer information.';
      return info;
    }
    const attributes = findAuthenticatedAttributes(signerInfo);
    const storedDigest = findAttributeValue(attributes, MESSAGE_DIGEST_OID);
    const signingTime = findAttributeValue(attributes, SIGNING_TIME_OID);
    if (signingTime) {
      const parsed = parseAsn1Time(signingTime);
      if (parsed) info.signedAt = parsed;
    }
    const digestOid = findDigestAlgorithmOid(signerInfo);
    const algorithm = (digestOid && DIGEST_NAMES[digestOid]) || 'sha256';
    info.digestAlgorithm = hashLabel(algorithm);
    if (!storedDigest) {
      info.error = 'The signature carries no message-digest attribute to compare against.';
      return info;
    }
    const covered = concatenateRanges(bytes, offsetA, lengthA, offsetB, lengthB);
    const recomputed = digest(algorithm, forge.util.binary.raw.encode(covered));
    info.digestMatches = timingSafeEqualHex(toHex(storedDigest), recomputed);
  } catch (error) {
    info.error = error instanceof Error ? error.message : String(error);
  }
  return info;
}

/**
 * Return only the bytes the outermost DER object claims.
 *
 * A signature placeholder is wider than the signature inside it, and the spare
 * bytes are zero padding rather than part of the PKCS#7 blob.
 */
function trimToAsn1Length(der: string): string {
  if (der.length < 2) return der;
  const first = der.charCodeAt(0);
  if (first !== 0x30) return der;
  const lengthByte = der.charCodeAt(1);
  if (lengthByte < 0x80) return der.slice(0, 2 + lengthByte);
  const count = lengthByte & 0x7f;
  if (count === 0 || count > 4 || der.length < 2 + count) return der;
  let length = 0;
  for (let i = 0; i < count; i++) length = (length << 8) | der.charCodeAt(2 + i);
  const total = 2 + count + length;
  return total > der.length || total <= 0 ? der : der.slice(0, total);
}

function inBounds(bytes: Uint8Array, offset: number, length: number): boolean {
  return offset >= 0 && length >= 0 && offset + length <= bytes.length;
}

function concatenateRanges(
  bytes: Uint8Array,
  offsetA: number,
  lengthA: number,
  offsetB: number,
  lengthB: number,
): Uint8Array {
  const covered = new Uint8Array(lengthA + lengthB);
  covered.set(bytes.subarray(offsetA, offsetA + lengthA), 0);
  covered.set(bytes.subarray(offsetB, offsetB + lengthB), lengthA);
  return covered;
}

/**
 * `Asn1.value` is `string | Asn1[]`, so every structural walk narrows through
 * this helper instead of asserting.
 */
function children(node: forge.asn1.Asn1 | undefined): forge.asn1.Asn1[] {
  if (!node) return [];
  return Array.isArray(node.value) ? node.value : [];
}

function child(node: forge.asn1.Asn1 | undefined, index: number): forge.asn1.Asn1 | undefined {
  return children(node)[index];
}

/** UTCTime `YYMMDDHHMMSSZ` and GeneralizedTime `YYYYMMDDHHMMSSZ`. */
function parseAsn1Time(value: string): Date | undefined {
  const match = /^(\d{2}|\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z?$/.exec(value.trim());
  if (!match) return undefined;
  const rawYear = Number(match[1]);
  const year = match[1].length === 2 ? (rawYear >= 70 ? 1900 + rawYear : 2000 + rawYear) : rawYear;
  const date = new Date(Date.UTC(
    year,
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  ));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** SignedData sits inside ContentInfo: SEQUENCE { oid, [0] { SignedData } }. */
function findSignedData(root: forge.asn1.Asn1): forge.asn1.Asn1 | null {
  const signedData = child(child(root, 1), 0);
  if (!signedData || !Array.isArray(signedData.value)) return null;
  return signedData;
}

/** `[0] IMPLICIT` certificate set inside SignedData, found by tag not index. */
function collectCertificates(signedData: forge.asn1.Asn1): forge.pki.Certificate[] {
  const out: forge.pki.Certificate[] = [];
  for (const element of children(signedData)) {
    if (element.tagClass !== forge.asn1.Class.CONTEXT_SPECIFIC || element.type !== 0) continue;
    for (const entry of children(element)) {
      try {
        out.push(forge.pki.certificateFromAsn1(entry));
      } catch {
        // A non-certificate element in the bag is not fatal.
      }
    }
  }
  return out;
}

/**
 * `signerInfos` is the last `SET` inside SignedData.
 *
 * Positional indexing is wrong here: `crls` is optional, so in a file with no
 * revocation list `signerInfos` shifts up by one element. `digestAlgorithms` is
 * also a SET but always comes first, so taking the last one is unambiguous.
 */
function findSignerInfo(signedData: forge.asn1.Asn1): forge.asn1.Asn1 | null {
  const sets = children(signedData).filter(
    (element) => element.tagClass === forge.asn1.Class.UNIVERSAL && element.type === forge.asn1.Type.SET,
  );
  const signerInfos = sets[sets.length - 1];
  return child(signerInfos, 0) ?? null;
}

/**
 * SignerInfo ::= SEQUENCE { version, sid, digestAlgorithm,
 *                            [0] authenticatedAttributes,
 *                            digestEncryptionAlgorithm, encryptedDigest,
 *                            [1] unauthenticatedAttributes }
 *
 * The signed attributes are context tag **0** — context tag 1 is the
 * *un*authenticated set, which is not covered by the signature.
 */
function findAuthenticatedAttributes(signerInfo: forge.asn1.Asn1): forge.asn1.Asn1[] {
  for (const element of children(signerInfo)) {
    if (element.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && element.type === 0) {
      return children(element);
    }
  }
  return [];
}

function findAttributeValue(attributes: forge.asn1.Asn1[], oid: string): string | null {
  for (const attribute of attributes) {
    const members = children(attribute);
    if (members.length < 2) continue;
    const rawOid = members[0].value;
    if (typeof rawOid !== 'string' || forge.asn1.derToOid(rawOid) !== oid) continue;
    for (const value of children(members[1])) {
      if (typeof value.value === 'string') return value.value;
    }
    if (typeof members[1].value === 'string') return members[1].value;
  }
  return null;
}

function findDigestAlgorithmOid(signerInfo: forge.asn1.Asn1): string | null {
  const algorithm = child(signerInfo, 2);
  const oid = child(algorithm, 0);
  if (oid && typeof oid.value === 'string') {
    try {
      return forge.asn1.derToOid(oid.value);
    } catch {
      return null;
    }
  }
  return null;
}

function toHex(bytes: string): string {
  return Array.from(bytes, (character) => character.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return difference === 0;
}

function digest(algorithm: DigestAlgorithm, value: string): string {
  const md = createDigest(algorithm);
  md.update(value);
  return md.digest().toHex();
}

function createDigest(algorithm: DigestAlgorithm): forge.md.MessageDigest {
  switch (algorithm) {
    case 'sha1':
      return forge.md.sha1.create();
    case 'sha384':
      return forge.md.sha384.create();
    case 'sha512':
      return forge.md.sha512.create();
    default:
      return forge.md.sha256.create();
  }
}

// ── signing pass ────────────────────────────────────────────────────────────

function patchSignature(
  source: Uint8Array,
  loaded: LoadedCertificate,
  privateKey: forge.pki.rsa.PrivateKey,
  options: SignOptions,
  signer: string,
): SignatureResult {
  const text = new TextDecoder('latin1').decode(source);
  const contents = findPlaceholderContents(text);
  if (!contents) {
    throw new Error('Could not find the signature placeholder after saving. Unlock the PDF first and try again.');
  }
  const byteRange = findByteRangePlaceholder(text, contents.start);
  if (!byteRange) {
    throw new Error('Could not find the /ByteRange entry to patch in the saved file.');
  }

  const offsetA = 0;
  const lengthA = contents.valueStart;
  const offsetB = contents.valueEnd;
  const lengthB = source.length - offsetB;
  const padded = ` ${[offsetA, lengthA, offsetB, lengthB]
    .map((value) => String(value).padStart(BYTE_RANGE_WIDTH, '0'))
    .join(' ')} `;
  if (padded.length !== BYTE_RANGE_VALUE_LENGTH) {
    throw new Error(
      `The signature offsets need ${padded.length} characters but only ${BYTE_RANGE_VALUE_LENGTH} were reserved; a PDF larger than 9 999 999 999 bytes cannot be signed in place.`,
    );
  }
  if (byteRange.valueEnd - byteRange.valueStart !== BYTE_RANGE_VALUE_LENGTH) {
    throw new Error(
      `The /ByteRange placeholder in this file is ${byteRange.valueEnd - byteRange.valueStart} characters wide, expected ${BYTE_RANGE_VALUE_LENGTH}. The signature field was not created by BrowserSnip.`,
    );
  }
  writeLatinAt(source, byteRange.valueStart, padded);

  const algorithm = options.digestAlgorithm ?? 'sha256';
  const covered = concatenateRanges(source, offsetA, lengthA, offsetB, lengthB);
  const der = buildPkcs7(loaded, privateKey, forge.util.binary.raw.encode(covered), algorithm);
  const hex = forge.util.bytesToHex(der);
  if (hex.length > CONTENT_HEX_LENGTH) {
    throw new Error(
      `The certificate chain needs ${hex.length / 2} bytes but the signature field reserved ${CONTENT_HEX_LENGTH / 2}. Remove intermediate certificates or use a smaller key.`,
    );
  }
  writeLatinAt(source, contents.valueStart, hex.padEnd(CONTENT_HEX_LENGTH, '0'));

  return {
    bytes: source,
    signer,
    hash: hashLabel(algorithm),
    contentsLength: der.length,
    byteRange: [offsetA, lengthA, offsetB, lengthB],
  };
}

function buildPkcs7(
  loaded: LoadedCertificate,
  privateKey: forge.pki.rsa.PrivateKey,
  coveredRaw: string,
  algorithm: DigestAlgorithm,
): string {
  const md = createDigest(algorithm);
  md.update(coveredRaw);
  // node-forge derives the messageDigest attribute from `p7.content`, so `md`
  // is only used to validate that the requested algorithm exists.
  const digestHex = md.digest().toHex();
  if (digestHex.length !== expectedDigestLength(algorithm)) {
    throw new Error(`The ${algorithm} digest came out unexpected length.`);
  }

  const p7 = forge.pkcs7.createSignedData();
  // `sign({ detached: true })` omits the encapsulated content from the DER but
  // still hashes it, so the covered bytes have to be handed over as content.
  // Setting an empty buffer here instead produces a signature over nothing.
  p7.content = forge.util.createBuffer(coveredRaw, 'raw');
  p7.addCertificate(loaded.certificate);
  for (const extra of loaded.chain) {
    try {
      p7.addCertificate(extra);
    } catch {
      // An unparseable intermediate must not cost the user their signature.
    }
  }
  p7.addSigner({
    key: privateKey,
    certificate: loaded.certificate,
    // node-forge wants the algorithm *OID*, not the short name `md.algorithm`.
    digestAlgorithm: DIGEST_OIDS[algorithm],
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime },
    ],
  });
  p7.sign({ detached: true });
  return forge.asn1.toDer(p7.toAsn1()).getBytes();
}

function expectedDigestLength(algorithm: DigestAlgorithm): number {
  return { sha1: 40, sha256: 64, sha384: 96, sha512: 128 }[algorithm];
}

interface Placeholder {
  start: number;
  valueStart: number;
  valueEnd: number;
}

/** Search backwards so a previously signed revision is never overwritten. */
function findPlaceholderContents(text: string): Placeholder | null {
  let index = text.lastIndexOf('/Contents');
  while (index !== -1) {
    const open = text.indexOf('<', index + '/Contents'.length);
    const close = open === -1 ? -1 : text.indexOf('>', open + 1);
    if (open !== -1 && close !== -1 && close - open - 1 === CONTENT_HEX_LENGTH) {
      return { start: index, valueStart: open + 1, valueEnd: close };
    }
    index = text.lastIndexOf('/Contents', index - 1);
  }
  return null;
}

function findByteRangePlaceholder(text: string, contentsStart: number): Placeholder | null {
  const searchFrom = Math.max(0, contentsStart - 4096);
  const region = text.slice(searchFrom, contentsStart + 1024);
  const match = /\/ByteRange\s*\[([^\]]*)\]/.exec(region);
  if (!match) return null;
  const bracket = searchFrom + match.index + match[0].indexOf('[');
  return {
    start: searchFrom + match.index,
    valueStart: bracket + 1,
    valueEnd: bracket + 1 + match[1].length,
  };
}

function writeLatinAt(target: Uint8Array, offset: number, value: string): void {
  for (let i = 0; i < value.length; i++) target[offset + i] = value.charCodeAt(i) & 0xff;
}

function installSignatureField(doc: PDFDocument, name: string, options: SignOptions): void {
  const context = doc.context;
  const pageIndex = Math.min(Math.max(0, options.page ?? 0), doc.getPageCount() - 1);
  const page = doc.getPage(pageIndex);
  const width = 220;
  const height = 90;
  const pageHeight = page.getHeight();
  const visible = options.visible !== false;

  const signature = context.register(
    context.obj({
      Type: 'Sig',
      Filter: 'Adobe.PPKLite',
      SubFilter: 'adbe.pkcs7.detached',
      Name: name,
      Reason: options.reason ?? '',
      Location: options.location ?? '',
      ContactInfo: options.contact ?? '',
      M: `D:${formatDate(new Date())}Z`,
      // Nine full-width integers, so pdf-lib writes exactly
      // `[ 9999999999 9999999999 9999999999 9999999999 ]`.
      ByteRange: context.obj(Array.from({ length: 4 }, () => Number('9'.repeat(BYTE_RANGE_WIDTH)))),
      // A JS string would become a PDF *name*, and `PDFHexString.fromText`
      // hex-encodes its argument (doubling the width). The placeholder must be
      // exactly CONTENT_HEX_LENGTH hex characters, so it is built from raw hex.
      Contents: PDFHexString.of('0'.repeat(CONTENT_HEX_LENGTH)),
    }),
  );

  let acroForm = doc.catalog.get(PDFName.of('AcroForm'));
  let acroDict = acroForm instanceof PDFRef
    ? doc.context.lookup(acroForm, PDFDict)
    : (acroForm as PDFDict | undefined);
  if (!acroDict) {
    acroDict = context.obj({ Fields: context.obj([]), DA: '/Helv 0 Tf 0 g' }) as PDFDict;
    doc.catalog.set(PDFName.of('AcroForm'), context.register(acroDict));
  }
  const fieldsValue = acroDict.get(PDFName.of('Fields'));
  const fields = fieldsValue instanceof PDFArray
    ? fieldsValue
    : (() => {
      const created = context.obj([]) as PDFArray;
      acroDict?.set(PDFName.of('Fields'), created);
      return created;
    })();

  const widget = context.register(
    context.obj({
      Type: 'Annot',
      Subtype: 'Widget',
      FT: 'Sig',
      Rect: visible
        ? [36, pageHeight - 36 - height, 36 + width, pageHeight - 36]
        : [0, 0, 0, 0],
      V: signature,
      P: page.ref,
      T: name,
      F: 4,
      Border: context.obj([0, 0, 1]),
    }),
  );
  fields.push(context.register(context.obj({ FT: 'Sig', V: signature, T: name, Kids: context.obj([widget]) })));

  const annots = page.node.Annots();
  const annotArray = annots instanceof PDFArray
    ? annots
    : (() => {
      const created = context.obj([]) as PDFArray;
      page.node.set(PDFName.of('Annots'), created);
      return created;
    })();
  annotArray.push(widget);
}

// ── certificate loading ─────────────────────────────────────────────────────

interface LoadedCertificate {
  certificate: forge.pki.Certificate;
  chain: forge.pki.Certificate[];
  privateKey?: forge.pki.rsa.PrivateKey;
}

function loadCertificate(bytes: Uint8Array, passphrase?: string): LoadedCertificate {
  const text = new TextDecoder('utf-8').decode(bytes);
  if (text.includes('-----BEGIN')) {
    try {
      return { certificate: forge.pki.certificateFromPem(text), chain: [] };
    } catch (error) {
      throw new Error(
        `That PEM certificate could not be read: ${error instanceof Error ? error.message : 'unknown reason'}.`,
      );
    }
  }
  let asn1: forge.asn1.Asn1;
  try {
    asn1 = forge.asn1.fromDer(forge.util.binary.raw.encode(bytes));
  } catch (error) {
    throw new Error(
      `That certificate file is not PEM and not DER (${error instanceof Error ? error.message : 'unreadable'}). Provide a .pem, .crt or .p12/.pfx.`,
    );
  }
  if (isPkcs12(asn1)) {
    const p12 = forge.pkcs12.pkcs12FromAsn1(asn1, passphrase ?? '');
    const certificates = bagsOf(p12, forge.pki.oids.certBag)
      .map((bag) => (bag as { cert?: forge.pki.Certificate }).cert)
      .filter((cert): cert is forge.pki.Certificate => Boolean(cert));
    if (certificates.length === 0) throw new Error('That .p12 file contains no certificate.');
    const keys = bagsOf(p12, forge.pki.oids.pkcs8ShroudedKeyBag)
      .concat(bagsOf(p12, forge.pki.oids.keyBag))
      .map((bag) => (bag as { key?: forge.pki.rsa.PrivateKey }).key)
      .filter((key): key is forge.pki.rsa.PrivateKey => Boolean(key));
    return { certificate: certificates[0], chain: certificates.slice(1), privateKey: keys[0] };
  }
  return { certificate: forge.pki.certificateFromAsn1(asn1), chain: [] };
}

/** PKCS#12 is SEQUENCE { integer version, … } while a certificate starts with a name. */
function isPkcs12(asn1: forge.asn1.Asn1): boolean {
  const first = child(asn1, 0);
  return Boolean(
    first
      && first.tagClass === forge.asn1.Class.UNIVERSAL
      && first.type === forge.asn1.Type.INTEGER,
  );
}

function bagsOf(p12: forge.pkcs12.Pkcs12Pfx, bagType: string): unknown[] {
  try {
    return (p12.getBags({ bagType }) as Record<string, unknown[]>)[bagType] ?? [];
  } catch {
    return [];
  }
}

function loadPrivateKey(bytes: Uint8Array, passphrase?: string): forge.pki.rsa.PrivateKey {
  const text = new TextDecoder('utf-8').decode(bytes);
  if (!text.includes('-----BEGIN')) {
    throw new Error('That private key file is not PEM. Export it as PKCS#1 or PKCS#8 PEM.');
  }
  if (/ENCRYPTED/.test(text) && !passphrase) {
    throw new Error('That private key is encrypted — enter its passphrase.');
  }
  try {
    return forge.pki.privateKeyFromPem(text) as forge.pki.rsa.PrivateKey;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unsupported format';
    if (/decrypt|password|passphrase/i.test(message)) {
      throw new Error('That passphrase did not decrypt the private key.');
    }
    throw new Error(`That private key could not be read: ${message}.`);
  }
}

function commonName(attributes: forge.pki.CertificateField[] | undefined): string | undefined {
  if (!attributes) return undefined;
  const found = attributes.find(
    (attribute) => attribute.name === 'commonName' || attribute.shortName === 'CN',
  );
  return typeof found?.value === 'string' ? found.value : undefined;
}

function hashLabel(algorithm: string): string {
  return algorithm.replace('sha', 'SHA-');
}

function formatDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    + `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

function decodePdfString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value);
  const literal = /^\((.*)\)$/s.exec(text);
  if (literal) return literal[1].replace(/\\([()\\])/g, '$1');
  const hex = /^<([0-9A-Fa-f\s]+)>$/.exec(text);
  if (hex) {
    try {
      return forge.util.hexToBytes(hex[1].replace(/\s+/g, ''));
    } catch {
      return undefined;
    }
  }
  return text.replace(/^\//, '');
}

function readNumberArray(value: unknown): number[] | null {
  if (!(value instanceof PDFArray)) return null;
  return value.asArray().map((item) => Number(String(item))).filter(Number.isFinite);
}

function readHexString(value: unknown): string | null {
  const text = String(value ?? '').trim();
  const match = /^<([0-9A-Fa-f\s]+)>$/.exec(text);
  return match ? match[1].replace(/\s+/g, '') : null;
}

/**
 * Generate a throwaway self-signed certificate. Used by the "sign" tool's
 * quick-start and by the tests, so a user can see the whole flow without
 * owning a certificate first.
 */
export async function createSelfSignedCertificate(
  commonNameValue: string,
  days = 365,
): Promise<{ certificatePem: string; privateKeyPem: string }> {
  const keys = await forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = String(Date.now());
  certificate.validity.notBefore = new Date();
  certificate.validity.notAfter = new Date(Date.now() + days * 86400000);
  const attributes: forge.pki.CertificateField[] = [{ name: 'commonName', value: commonNameValue }];
  certificate.setSubject(attributes);
  certificate.setIssuer(attributes);
  certificate.sign(keys.privateKey, forge.md.sha256.create());
  return {
    certificatePem: forge.pki.certificateToPem(certificate),
    privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

// ── RFC 3161 trusted timestamps ─────────────────────────────────────────────

const TIMESTAMP_TOKEN_OID = '1.2.840.113549.1.9.16.2.14';

export interface TimestampResult {
  bytes: Uint8Array;
  attestedAt: Date;
  authority: string;
}

/**
 * Add an RFC 3161 trusted timestamp to an existing signature.
 *
 * The token is stored as an **unsigned** attribute of the signer info, which is
 * where PAdES puts it: unsigned attributes are not covered by the signature, so
 * adding one cannot invalidate it.
 *
 * This is the only PDF step in BrowserSnip that contacts a server, and only the
 * 32-byte message digest is sent — never the document.
 */
export async function timestampDocument(
  doc: PDFDocument,
  options: { tsaUrl: string; fieldName?: string },
): Promise<TimestampResult> {
  const saved = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
  return timestampBytes(toBytes(saved), options);
}

/**
 * Timestamp from raw bytes, for callers that already saved the document.
 *
 * The signature is found through the document structure — `AcroForm /Fields` →
 * the `/Sig` value that carries a `/SubFilter` — never by searching for
 * `/Contents`, which every page carries, and its byte span is measured from the
 * placeholder the file's own `/ByteRange` declares, so the rewrite cannot touch
 * a covered byte.
 */
export async function timestampBytes(
  input: Uint8Array,
  options: { tsaUrl: string; fieldName?: string },
): Promise<TimestampResult> {
  const source = toBytes(input);
  const signatures = signedValues(await openPDF(source, { ignoreEncryption: true }));
  const candidates = options.fieldName
    ? signatures.filter((entry) => entry.fieldName === options.fieldName)
    : signatures;
  if (candidates.length === 0) {
    throw new Error(
      signatures.length === 0
        ? 'This PDF has no signature to timestamp — sign it first.'
        : `This PDF has no signature field named "${options.fieldName}" to timestamp.`,
    );
  }
  // The newest field, matching `findPlaceholderContents`, which signs the last
  // revision so an existing signature is never overwritten.
  const target = candidates[candidates.length - 1];
  const span = contentsSpan(source, target.value);
  if (!span) {
    throw new Error(
      'The existing signature could not be read from these bytes: its /Contents value is not a hexadecimal string that /ByteRange covers, so no timestamp was added and the file is unchanged.',
    );
  }
  const { valueStart, valueEnd } = span;

  const hex = new TextDecoder('latin1').decode(source.subarray(valueStart, valueEnd)).replace(/\s+/g, '');
  const der = forge.util.hexToBytes(hex.length % 2 === 0 ? hex : `${hex}0`);
  // Keep the root: the parsed tree is shared by reference, so mutating the
  // signer info below mutates this same object and it can be re-emitted whole.
  const root = forge.asn1.fromDer(trimToAsn1Length(der), false);
  const signedData = findSignedData(root);
  if (!signedData) {
    throw new Error('The existing signature is not a PKCS#7 SignedData blob, so it cannot be timestamped.');
  }
  const signerInfo = findSignerInfo(signedData);
  if (!signerInfo) throw new Error('The existing signature has no signer information.');
  const messageDigest = findAttributeValue(findAuthenticatedAttributes(signerInfo), MESSAGE_DIGEST_OID);
  if (!messageDigest) {
    throw new Error(
      'The existing signature carries no message digest, so a trusted timestamp cannot be bound to it.',
    );
  }

  const token = await requestTimestamp(messageDigest, options.tsaUrl);
  appendUnsignedAttribute(signerInfo, token.bytes);

  const rebuilt = forge.util.bytesToHex(forge.asn1.toDer(root).getBytes());
  const available = valueEnd - valueStart;
  if (rebuilt.length > available) {
    throw new Error(
      `The timestamp token needs ${rebuilt.length} characters but the signature reserved ${available}. Sign again with a shorter certificate chain, or timestamp before adding intermediates.`,
    );
  }
  const patched = new Uint8Array(source);
  writeLatinAt(patched, valueStart, rebuilt.padEnd(available, '0'));
  return { bytes: patched, attestedAt: token.attestedAt, authority: token.authority };
}

interface TimestampToken {
  bytes: string;
  attestedAt: Date;
  authority: string;
}

/** Build a TimeStampReq over the signature digest and POST it to the authority. */
async function requestTimestamp(messageDigest: string, tsaUrl: string): Promise<TimestampToken> {
  const universal = forge.asn1.Class.UNIVERSAL;
  const digestBytes = forge.util.hexToBytes(toHex(messageDigest));
  const nonce = forge.random.getBytesSync(8);
  const request = forge.asn1
    .toDer(
      forge.asn1.create(universal, forge.asn1.Type.SEQUENCE, true, [
        forge.asn1.create(universal, forge.asn1.Type.INTEGER, false, String.fromCharCode(1)),
        forge.asn1.create(universal, forge.asn1.Type.SEQUENCE, true, [
          forge.asn1.create(universal, forge.asn1.Type.OID, false, forge.asn1.oidToDer(forge.pki.oids.sha256).getBytes()),
          forge.asn1.create(universal, forge.asn1.Type.NULL, false, ''),
        ]),
        forge.asn1.create(universal, forge.asn1.Type.OCTETSTRING, false, digestBytes),
        forge.asn1.create(universal, forge.asn1.Type.INTEGER, false, nonce),
        forge.asn1.create(universal, forge.asn1.Type.BOOLEAN, false, String.fromCharCode(0xff)),
      ]),
    )
    .getBytes();

  let responseBytes: Uint8Array;
  try {
    const response = await fetch(tsaUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/timestamp-query' },
      body: request,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    responseBytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw new Error(
      `The timestamp authority at ${tsaUrl} could not be reached (${
        error instanceof Error ? error.message : 'network error'
      }). Timestamping is the one PDF step that needs a connection — go online and retry, or sign without a timestamp.`,
    );
  }

  const asn1 = forge.asn1.fromDer(forge.util.binary.raw.encode(responseBytes), false);
  const status = numberAt(child(child(asn1, 0), 0));
  // statusInfo: 0 = accepted, 1 = requested but not granted (still has a token
  // only when 0); anything else is a rejection carrying a failure OID list.
  if (status !== 0) {
    const firstFailure = children(child(asn1, 1))[0];
    const detail = firstFailure && typeof firstFailure.value === 'string'
      ? forge.asn1.derToOid(firstFailure.value)
      : undefined;
    throw new Error(
      `The timestamp authority refused to issue a token (status ${status}${detail ? `, reason ${detail}` : ''}). Try a different authority URL.`,
    );
  }
  const tokenNode = child(asn1, 1);
  if (!tokenNode) throw new Error('The timestamp response contained no token.');

  return {
    bytes: forge.asn1.toDer(tokenNode).getBytes(),
    attestedAt: readTokenGenTime(tokenNode) ?? new Date(),
    authority: hostOf(tsaUrl),
  };
}

function numberAt(node: forge.asn1.Asn1 | undefined): number {
  if (!node || typeof node.value !== 'string' || node.value.length === 0) return -1;
  let value = 0;
  for (const byte of node.value) value = (value << 8) | byte.charCodeAt(0);
  return value;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Find the TSTInfo genTime, whichever depth the token nests it at. */
function readTokenGenTime(tokenNode: forge.asn1.Asn1): Date | undefined {
  const stack: forge.asn1.Asn1[] = [tokenNode];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    const isTime =
      node.tagClass === forge.asn1.Class.UNIVERSAL
      && (node.type === forge.asn1.Type.GENERALIZEDTIME || node.type === forge.asn1.Type.UTCTIME);
    if (isTime && typeof node.value === 'string') {
      const parsed = parseAsn1Time(node.value);
      if (parsed) return parsed;
    }
    for (const kid of children(node)) stack.push(kid);
  }
  return undefined;
}

/**
 * Append the token as a `messageSeal`-style unsigned attribute.
 *
 * `SignerInfo` puts unauthenticated attributes under context tag **1**, and
 * node-forge's parsed objects are mutable and shared by reference, so the root
 * tree picks the change up without a rebuild.
 */
function appendUnsignedAttribute(signerInfo: forge.asn1.Asn1, tokenBytes: string): void {
  const attribute = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OID, false, forge.asn1.oidToDer(TIMESTAMP_TOKEN_OID).getBytes()),
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, [
      forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OCTETSTRING, false, tokenBytes),
    ]),
  ]);

  const members = children(signerInfo);
  const existing = members.find(
    (element) => element.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && element.type === 1,
  );
  if (existing) {
    if (!Array.isArray(existing.value)) existing.value = [];
    (existing.value as forge.asn1.Asn1[]).push(attribute);
    return;
  }
  const created = forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, 1, true, [attribute]);
  (signerInfo.value as forge.asn1.Asn1[]).push(created);
}
