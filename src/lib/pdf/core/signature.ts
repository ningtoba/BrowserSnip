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
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  StandardFonts,
  openPDF,
  toBytes,
} from './doc';
import type { PDFFont } from './doc';
import type { PDFObject } from './doc';
import { quarterTurn, viewerRectToUserSpace, viewerSizeOf, type PageFrame, type QuadRect } from './tables';

/** Shape accepted by `PDFContext.obj`; a bare string there becomes a PDF *name*. */
type ObjValue = number | boolean | string | null | PDFObject | ObjValue[] | { [key: string]: ObjValue };

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
  /**
   * True/False once the signature value itself was checked against the signer
   * certificate's public key. `undefined` means it could not be checked (no
   * certificate, an algorithm node-forge cannot verify, or a parse failure).
   *
   * The digest alone is not integrity: the message-digest attribute lives inside
   * the PKCS#7 blob, so a blob whose RSA value was swapped for another still
   * carries the right digest and used to read `valid` here while openssl's
   * `cms -verify` refused it.
   */
  signatureVerifies?: boolean;
  subFilter?: string;
  /** Subject and issuer are the same name: nothing vouches for this certificate. */
  selfSigned?: boolean;
  /** Every signed range, so a reader can see exactly what was covered. */
  signedRanges?: { start: number; length: number }[];
  fileLength?: number;
  /** True when the ranges start at byte 0 and end at the end of the file. */
  coversWholeFile?: boolean;
  /** Bytes before the first range or after the last: outside the signature. */
  bytesBeforeFirstRange?: number;
  bytesAfterLastRange?: number;
  /** The `/ByteRange` gap does not line up with the `/Contents` hex string. */
  gapMismatch?: boolean;
  /** A `/SubFilter` this reader has no rule for. */
  subFilterUnsupported?: boolean;
  signer?: string;
  issuer?: string;
  signedAt?: Date;
  digestAlgorithm?: string;
  notBefore?: Date;
  notAfter?: Date;
  byteRange?: number[];
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
  const name = options.fieldName ?? nextFieldName(doc);
  await installSignatureField(doc, name, options, signer);

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
    if (!byteRange || byteRange.length < 4 || byteRange.length % 2 !== 0 || !contentsHex) {
      results.push({
        fieldName,
        digestMatches: false,
        error: 'This signature has no readable /ByteRange or /Contents, so it cannot be verified.',
      });
      continue;
    }
    const subFilter = readName(value.get(PDFName.of('SubFilter')));
    const certBlobs = readCertEntries(doc, value);
    results.push(verifyOne(bytes, byteRange, contentsHex, fieldName, subFilter, certBlobs));
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

const PKCS7_SUBFILTERS = new Set(['adbe.pkcs7.detached', 'adbe.pkcs7.sha1', 'ETSI.CAdES.detached']);
const RAW_SUBFILTER = 'adbe.x509.rsa_sha1';

/** A `/Name` entry, without the leading slash. */
function readName(value: unknown): string | undefined {
  const text = String(value ?? '');
  return text.startsWith('/') ? text.slice(1) : (text || undefined);
}

/**
 * Certificate blobs from a raw-signature dictionary's `/Cert`.
 *
 * `adbe.x509.rsa_sha1` has no PKCS#7 envelope, so the certificate a reader must
 * use lives here — and a file that omits it cannot be checked at all.
 */
function readCertEntries(doc: PDFDocument, value: PDFDict): string[] {
  const entry = value.get(PDFName.of('Cert'));
  const resolved = entry instanceof PDFRef ? doc.context.lookup(entry) : entry;
  const items = resolved instanceof PDFArray ? resolved.asArray() : resolved ? [resolved] : [];
  const out: string[] = [];
  for (const item of items) {
    const target = item instanceof PDFRef ? doc.context.lookupMaybe(item, PDFHexString) : item;
    const hex = readHexString(target);
    if (hex) out.push(hex);
  }
  return out;
}

function verifyOne(
  bytes: Uint8Array,
  byteRange: number[],
  contentsHex: string,
  fieldName: string | undefined,
  subFilter: string | undefined,
  certBlobs: string[],
): SignatureInfo {
  const ranges: { start: number; length: number }[] = [];
  for (let i = 0; i + 1 < byteRange.length; i += 2) {
    ranges.push({ start: byteRange[i], length: byteRange[i + 1] });
  }
  const first = ranges[0];
  const last = ranges[ranges.length - 1];
  const info: SignatureInfo = {
    fieldName,
    subFilter,
    byteRange,
    signedRanges: ranges,
    fileLength: bytes.length,
    digestMatches: false,
    coversWholeFile: Boolean(first && last && first.start === 0 && last.start + last.length === bytes.length),
    bytesBeforeFirstRange: first?.start ?? 0,
    bytesAfterLastRange: last ? bytes.length - (last.start + last.length) : 0,
  };
  if (ranges.some((range) => !inBounds(bytes, range.start, range.length))) {
    info.error = 'The recorded byte ranges fall outside this file, which means the file length changed after signing.';
    return info;
  }

  if (subFilter === RAW_SUBFILTER) {
    return verifyRawSignature(bytes, ranges, contentsHex, info, certBlobs);
  }
  if (subFilter && !PKCS7_SUBFILTERS.has(subFilter)) info.subFilterUnsupported = true;

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
      info.selfSigned = nameKey(signerCertificate.subject.attributes) === nameKey(signerCertificate.issuer.attributes);
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
    // The digest gap must be the `/Contents` string and nothing else. A range
    // that starts after `<` or ends before `>` leaves neighbouring bytes outside
    // the signature while still digesting cleanly.
    if (ranges.length === 2) {
      const gapStart = first.start + first.length;
      const gapEnd = ranges[1].start;
      const gap = new TextDecoder('latin1').decode(bytes.subarray(gapStart, gapEnd)).trim();
      // The signing pass ends the first range right after the `<` and starts the
      // second at the `>`, so the gap is exactly the hex string and nothing else.
      if (gap.replace(/\s+/g, '') !== contentsHex) info.gapMismatch = true;
    }
    const covered = concatenateSpans(bytes, ranges);
    const recomputed = digest(algorithm, forge.util.binary.raw.encode(covered));
    info.digestMatches = timingSafeEqualHex(toHex(storedDigest), recomputed);
    // A correct message digest only proves the attribute was not edited. The RSA
    // value over those attributes is what binds the blob to the certificate; a
    // blob with its signature bytes swapped kept reading `valid` without this.
    if (signerCertificate && attributes.length > 0) {
      info.signatureVerifies = verifySignedAttributes(signerInfo, attributes, signerCertificate, algorithm);
    }
  } catch (error) {
    info.error = error instanceof Error ? error.message : String(error);
  }
  return info;
}

/** Compare two X.509 names field by field, so a self-issued cert is named as such. */
function nameKey(attributes: forge.pki.CertificateField[] | undefined): string {
  return (attributes ?? []).map((attribute) => `${attribute.shortName ?? attribute.name}=${String(attribute.value)}`).join(',');
}

/** The last OCTET STRING in a SignerInfo: the encrypted digest (the signature). */
function findSignatureValue(signerInfo: forge.asn1.Asn1): string | undefined {
  const octets = children(signerInfo).filter(
    (element) => element.tagClass === forge.asn1.Class.UNIVERSAL
      && element.type === forge.asn1.Type.OCTETSTRING
      && typeof element.value === 'string',
  );
  const value = octets[octets.length - 1]?.value;
  return typeof value === 'string' && value.length > 32 ? value : undefined;
}

/**
 * Check the RSA value over the DER of the signed attributes.
 *
 * RFC 5652 signs the attributes re-encoded as a universal `SET OF`, not the
 * context-tagged `[0]` they are stored under.
 */
function verifySignedAttributes(
  signerInfo: forge.asn1.Asn1,
  attributes: forge.asn1.Asn1[],
  certificate: forge.pki.Certificate,
  algorithm: DigestAlgorithm,
): boolean | undefined {
  const signature = findSignatureValue(signerInfo);
  if (!signature) return undefined;
  const publicKey = certificate.publicKey as forge.pki.rsa.PublicKey;
  if (typeof publicKey.verify !== 'function') return undefined;
  const set = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attributes);
  const md = createDigest(algorithm);
  md.update(forge.asn1.toDer(set).getBytes());
  try {
    return Boolean(publicKey.verify(md.digest().bytes(), signature, 'RSASSA-PKCS1-v1_5'));
  } catch {
    return false;
  }
}

/**
 * `adbe.x509.rsa_sha1`: `/Contents` is the bare PKCS#1 signature over the
 * covered bytes, and the key is in `/Cert`. There is no message digest to read,
 * so the public-key check *is* the integrity check.
 */
function verifyRawSignature(
  bytes: Uint8Array,
  ranges: { start: number; length: number }[],
  contentsHex: string,
  info: SignatureInfo,
  certBlobs: string[],
): SignatureInfo {
  info.digestAlgorithm = 'SHA-1';
  const certificate = certBlobs.length > 0
    ? (() => {
      try {
        return forge.pki.certificateFromAsn1(
          forge.asn1.fromDer(trimToAsn1Length(forge.util.hexToBytes(certBlobs[0]))),
        );
      } catch {
        return undefined;
      }
    })()
    : undefined;
  if (!certificate) {
    info.error = 'This is a raw PKCS#1 signature (/adbe.x509.rsa_sha1) with no readable /Cert, so there is no certificate to check it against.';
    return info;
  }
  info.signer = commonName(certificate.subject.attributes);
  info.issuer = commonName(certificate.issuer.attributes);
  info.notBefore = certificate.validity.notBefore;
  info.notAfter = certificate.validity.notAfter;
  info.selfSigned = nameKey(certificate.subject.attributes) === nameKey(certificate.issuer.attributes);
  const covered = concatenateSpans(bytes, ranges);
  const md = forge.md.sha1.create();
  md.update(forge.util.binary.raw.encode(covered));
  try {
    info.signatureVerifies = Boolean(
      (certificate.publicKey as forge.pki.rsa.PublicKey).verify(
        md.digest().bytes(),
        trimToAsn1Length(forge.util.hexToBytes(contentsHex)),
        'RSASSA-PKCS1-v1_5',
      ),
    );
  } catch {
    info.signatureVerifies = false;
  }
  info.digestMatches = info.signatureVerifies === true;
  return info;
}

function concatenateSpans(
  bytes: Uint8Array,
  ranges: { start: number; length: number }[],
): Uint8Array {
  const covered = new Uint8Array(ranges.reduce((total, range) => total + range.length, 0));
  let at = 0;
  for (const range of ranges) {
    covered.set(bytes.subarray(range.start, range.start + range.length), at);
    at += range.length;
  }
  return covered;
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
 * The signature value octets of a `SignerInfo` — the `encryptedDigest` OCTET
 * STRING, which is what a signature time-stamp imprints.
 *
 * It is the only UNIVERSAL OCTET STRING directly under the `SignerInfo`: the
 * signed attributes sit under the context tag `[0]`, and the fields before it are
 * an INTEGER, a SEQUENCE pair (`sid`, `digestAlgorithm`), so a top-level scan
 * cannot reach into them.
 */
function signatureValueOf(signerInfo: forge.asn1.Asn1): string | null {
  const value = children(signerInfo).find(
    (member) => member.tagClass === forge.asn1.Class.UNIVERSAL && member.type === forge.asn1.Type.OCTETSTRING,
  );
  return value && typeof value.value === 'string' && value.value.length > 0 ? value.value : null;
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

/** Reserved width and height of the visible block, in points. */
const BLOCK_WIDTH = 220;
const BLOCK_HEIGHT = 90;
/** Print (4) + Locked (128): the mark belongs on paper and seals the field. */
const WIDGET_FLAGS = 132;

/** A text string, or nothing at all when the user left the box empty. */
function textOrNothing(value: string | undefined): PDFHexString | undefined {
  const trimmed = value?.trim();
  return trimmed ? PDFHexString.fromText(trimmed) : undefined;
}

/**
 * A field name that is not already taken (`Signature1`, `Signature2`, …).
 *
 * A random four-digit suffix used to be good enough for one signature and collided
 * on the second one: two fields named `/Signature8563` are one field to a reader
 * resolving names, so the earlier signature became unreachable.
 */
function nextFieldName(doc: PDFDocument): string {
  const taken = new Set(signatureFields(doc).map((field) => decodePdfString(field.get(PDFName.of('T')))));
  let index = 1;
  while (taken.has(`Signature${index}`)) index += 1;
  return `Signature${index}`;
}

/** Fonts that draw the block, embedded once per document. */
async function blockFonts(doc: PDFDocument): Promise<{ body: PDFFont; head: PDFFont }> {
  return {
    body: await doc.embedFont(StandardFonts.Helvetica),
    head: await doc.embedFont(StandardFonts.HelveticaBold),
  };
}

/** WinAnsi has no glyph for most scripts, so a character it cannot draw reads `?`. */
function drawable(text: string): string {
  return text.replace(/[^\x20-\x7e\xa0-\xff]/gu, '?');
}

/** Cut a line to a width, with a trailing ellipsis when it had to be cut. */
function fitLine(font: PDFFont, text: string, size: number, width: number): string {
  const safe = drawable(text);
  if (font.widthOfTextAtSize(safe, size) <= width) return safe;
  let cut = safe;
  while (cut.length > 1 && font.widthOfTextAtSize(`${cut}...`, size) > width) cut = cut.slice(0, -1);
  return `${cut}...`;
}

/** `D:20261116161643Z` → `2026-11-16 16:16:43 UTC`, the same instant as `/M`. */
function readableDate(date: Date): string {
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 19)} UTC`;
}

const escapeLiteral = (text: string) => text.replace(/([()\\])/g, '\\$1');

/**
 * The appearance stream for the visible block: a bordered white box naming the
 * signer, the instant, and the reason.
 *
 * Without `/AP` the widget is a rectangle with an empty border and *nothing*
 * painted: `/Rect` alone was measured to add zero dark pixels to the page, so the
 * card's "visible signature block" was a box nobody could see. The block is drawn
 * in the annotation's own space (`BBox [0 0 w h]`), which is what a reader scales
 * onto `/Rect`.
 */
async function signatureAppearance(
  doc: PDFDocument,
  signer: string,
  options: SignOptions,
  signedAt: Date,
  width: number,
  height: number,
  area: QuadRect,
  rotation: number,
): Promise<PDFRef> {
  const context = doc.context;
  const { body, head } = await blockFonts(doc);
  const inner = width - 16;
  const lines: string[] = ['q', '1 1 1 rg', `0 0 ${width} ${height} re`, 'f',
    '0.45 0.45 0.5 RG', '0.7 w', `0.5 0.5 ${width - 1} ${height - 1} re`, 'S', 'Q'];
  const write = (font: PDFFont, size: number, text: string, x: number, y: number) => {
    lines.push('q', '0.08 0.08 0.12 rg', 'BT', `/${font === head ? 'F2' : 'F1'} ${size} Tf`,
      `1 0 0 1 ${x} ${y} Tm`, `(${escapeLiteral(fitLine(font, text, size, inner))}) Tj`, 'ET', 'Q');
  };
  lines.push('q', '0.35 0.35 0.4 rg', 'BT', '/F1 6.5 Tf', `1 0 0 1 8 ${height - 14} Tm`,
    '(Digitally signed by) Tj', 'ET', 'Q');
  write(head, 9, signer, 8, height - 26);
  write(body, 7, `Date: ${readableDate(signedAt)}`, 8, height - 40);
  if (options.reason?.trim()) write(body, 7, `Reason: ${options.reason}`, 8, height - 52);
  if (options.location?.trim()) write(body, 7, `Location: ${options.location}`, 8, height - 64);

  // The block is laid out upright in the *displayed* `width × height` frame, but a
  // viewer paints a widget's appearance and then turns the whole page by `/Rotate`,
  // which would leave the text reading sideways on a quarter-turned sheet (the D4
  // probe: "Digitally signed by" ran down the displayed left edge, and the block sat
  // in the wrong corner). The inverse turn baked inside the stream — the same recipe
  // `core/annotations` uses for a stamp's appearance (census row 9) — cancels the
  // page's, so the block reads upright as displayed. The `/BBox` stays the **stored**
  // rect's own size (`area`), which is what the viewer scales onto `/Rect`.
  const matrix = uprightMatrix(area, rotation);
  const turned = matrix.join(' ') !== '1 0 0 1 0 0';
  const ops = turned ? `q\n${matrix.join(' ')} cm\n${lines.join('\n')}\nQ` : lines.join('\n');
  const content = `${ops}\n`;
  const stream = context.flateStream(content, {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: [0, 0, Math.round(area.width), Math.round(area.height)],
    Matrix: [1, 0, 0, 1, 0, 0],
    Resources: { Font: { F1: body.ref, F2: head.ref } },
  });
  stream.dict.set(PDFName.of('Length'), PDFNumber.of(stream.contents.length));
  return context.register(stream);
}

/**
 * The matrix that puts a box drawn as *displayed* into the appearance's own space,
 * so the page's `/Rotate` turns the block's frame but not its words.
 *
 * Mirrors `core/annotations.uprightMatrix` (census row 9) exactly: the appearance is
 * authored upright in the displayed `w × h` frame, and this maps it into the stored
 * rect's `area.width × area.height` space so a viewer that rotates the page leaves
 * the text reading normally. `/Rotate 0` is the identity, so an unturned sheet's
 * appearance stream is byte-identical to before.
 */
function uprightMatrix(rect: QuadRect, rotation: number): number[] {
  const r = (v: number) => Math.round(v * 1000) / 1000;
  switch (((Math.round(rotation / 90) * 90) % 360 + 360) % 360) {
    case 90:
      return [0, 1, -1, 0, r(rect.width), 0];
    case 180:
      return [-1, 0, 0, -1, r(rect.width), r(rect.height)];
    case 270:
      return [0, -1, 1, 0, 0, r(rect.height)];
    default:
      return [1, 0, 0, 1, 0, 0];
  }
}

async function installSignatureField(
  doc: PDFDocument,
  name: string,
  options: SignOptions,
  signer: string,
): Promise<void> {
  const context = doc.context;
  const pageIndex = Math.min(Math.max(0, options.page ?? 0), doc.getPageCount() - 1);
  const page = doc.getPage(pageIndex);
  const box = page.getMediaBox();
  const rotation = quarterTurn(page.getRotation().angle);
  // The block is sized and aimed in the frame a viewer *shows* (`SignMain` and the
  // card both speak of the top-left of the page as displayed), then mapped into
  // stored user space through the shared viewer table — the census row-4 mapper.
  // Anchoring it at the stored `getWidth()/getHeight()` corner instead put the
  // signature in a different corner on every quarter-turned sheet (census #17).
  const frame: PageFrame = {
    x0: box.x,
    y0: box.y,
    width: box.width,
    height: box.height,
    rotation,
  };
  const sheet = viewerSizeOf(frame);
  // A sheet smaller than the block still gets a block, and one that fits: the rect
  // is shrunk to the displayed sheet and clamped inside it, so nothing hangs off a
  // 150x100 page (the appearance is clipped to `/BBox`, which follows the rect).
  const width = Math.max(Math.min(BLOCK_WIDTH, sheet.width - 8), 40);
  const height = Math.max(Math.min(BLOCK_HEIGHT, sheet.height - 8), 24);
  // 36 pt inside the DISPLAYED top-left corner, clamped onto the sheet.
  const dLeft = Math.min(Math.max(36, 4), Math.max(sheet.width - width - 4, 4));
  const dTop = Math.min(Math.max(36, 4), Math.max(sheet.height - height - 4, 4));
  // Displayed-space box → stored user-space rect (origin top-left → bottom-left).
  const area = viewerRectToUserSpace({ x: dLeft, y: dTop, width, height }, frame);
  const visible = options.visible !== false;
  const signedAt = new Date();

  // `/Name` is the *signer*, not the field: a validator's panel shows this line to
  // say who signed, and it used to show `Signature8563`. `/Reason`, `/Location` and
  // `/ContactInfo` are text strings (a JS string would become a PDF *name*, spaces
  // and all) and an empty one is left out rather than written as a bare `/`.
  const signatureEntries: { [key: string]: ObjValue } = {
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'adbe.pkcs7.detached',
    Name: PDFHexString.fromText(signer),
    M: `D:${formatDate(signedAt)}Z`,
    // Nine full-width integers, so pdf-lib writes exactly
    // `[ 9999999999 9999999999 9999999999 9999999999 ]`.
    ByteRange: context.obj(Array.from({ length: 4 }, () => Number('9'.repeat(BYTE_RANGE_WIDTH)))),
    // A JS string would become a PDF *name*, and `PDFHexString.fromText`
    // hex-encodes its argument (doubling the width). The placeholder must be
    // exactly CONTENT_HEX_LENGTH hex characters, so it is built from raw hex.
    Contents: PDFHexString.of('0'.repeat(CONTENT_HEX_LENGTH)),
  };
  const reason = textOrNothing(options.reason);
  const location = textOrNothing(options.location);
  const contact = textOrNothing(options.contact);
  if (reason) signatureEntries.Reason = reason;
  if (location) signatureEntries.Location = location;
  if (contact) signatureEntries.ContactInfo = contact;
  const signature = context.register(context.obj(signatureEntries));
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

  const field = context.register(context.obj({ FT: 'Sig', V: signature, T: name }));
  // `/Parent` is what makes the widget the *appearance* of that field. Without it
  // poppler reads the widget as a second, separate signature ("was asked for widget
  // and didn't had one" / "Bad bounding box") and lists one signature twice.
  // The widget is the field's *appearance*, so it carries no `/FT`, `/T` or `/V` of
  // its own: with those repeated, pypdf listed one signature as two fields
  // (`/Signature1` and `/Signature1./Signature1`).
  const widget = context.register(
    context.obj({
      Type: 'Annot',
      Subtype: 'Widget',
      Parent: field,
      Rect: visible ? [area.x, area.y, area.x + area.width, area.y + area.height] : [0, 0, 0, 0],
      P: page.ref,
      F: WIDGET_FLAGS,
      Border: context.obj([0, 0, 1]),
      ...(visible
        ? { AP: { N: await signatureAppearance(doc, signer, options, signedAt, width, height, area, rotation) } }
        : {}),
    }),
  );
  fields.push(field);
  context.lookup(field, PDFDict).set(PDFName.of('Kids'), context.obj([widget]));

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
 *
 * The caller hands over the bytes it read, not an opened document, on purpose:
 * `/ByteRange` names offsets in the signed file, and `PDFDocument.save` moves
 * those offsets. `timestamp-pdf` used to save first and so refused every file
 * `digital-sign-pdf` wrote — the chain its own refusal message asks for.
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
  // The imprint is over the signature *value* octets, not over the document: that
  // is what a signature time-stamp is (ETSI EN 319 142-1 §6.3, CAdES signature-time-stamp),
  // and it is the only thing a verifier can recompute from the file without
  // re-hashing pages. Hashing the `messageDigest` attribute — the document digest —
  // made the token a stamp over the pages with nothing tying it to this signature.
  const signatureValue = signatureValueOf(signerInfo);
  if (!signatureValue) {
    throw new Error(
      'The existing signature carries no signature value octets, so a trusted timestamp cannot be bound to it.',
    );
  }
  const imprint = forge.md.sha256.create().update(signatureValue).digest().getBytes();

  const token = await requestTimestamp(imprint, options.tsaUrl);
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

/**
 * Build a `TimeStampReq` over the signature value's digest and POST it to the
 * authority, then read the granted token back.
 *
 * The request is laid out as RFC 3161 §2.4.1 defines it —
 * `SEQUENCE { version, messageImprint { hashAlgorithm, hashedMessage }, nonce,
 * certReq }`. The first build put the digest straight into the request beside the
 * version, with no `messageImprint` wrapper, so the token this app asked for was
 * rejected by every authority: `openssl ts -query` reads the wrapper as the
 * algorithm and stops on a wrong tag, and a live responder answers HTTP 400
 * ("this authority could not be reached"), which is why no timestamp had ever
 * been produced in a browser.
 */
async function requestTimestamp(imprint: string, tsaUrl: string): Promise<TimestampToken> {
  const universal = forge.asn1.Class.UNIVERSAL;
  const nonce = forge.random.getBytesSync(8);
  const request = forge.asn1
    .toDer(
      forge.asn1.create(universal, forge.asn1.Type.SEQUENCE, true, [
        forge.asn1.create(universal, forge.asn1.Type.INTEGER, false, String.fromCharCode(1)),
        createMessageImprint(imprint),
        derInteger(nonce),
        forge.asn1.create(universal, forge.asn1.Type.BOOLEAN, false, String.fromCharCode(0xff)),
      ]),
    )
    .getBytes();

  // Bytes, not the binary string `forge` hands back: a string body is encoded as
  // *UTF-8* by `fetch`, so every DER octet above 0x7f left as two bytes and the
  // request stopped being DER at all. A live authority answers that with HTTP 400
  // (measured: rfc3161.ai.moda returns 400 on the string body and 200 on the same
  // bytes as a `Uint8Array`).
  const requestBytes = Uint8Array.from(request, (character) => character.charCodeAt(0) & 0xff);

  let responseBytes: Uint8Array;
  try {
    const response = await fetch(tsaUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/timestamp-query' },
      body: requestBytes,
    });
    // A reachable authority can still turn the request down, and that is a
    // different thing to say than "unreachable": an HTTP status arrives here, a
    // blocked or offline request never does.
    if (!response.ok) {
      throw new Error(`the authority answered HTTP ${response.status}`);
    }
    responseBytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'network error';
    throw new Error(/^the authority answered HTTP/.test(detail) ? detail : `the request failed (${detail})`);
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
      `the authority refused to issue a token (status ${status}${detail ? `, reason ${detail}` : ''})`,
    );
  }
  const tokenNode = child(asn1, 1);
  if (!tokenNode) throw new Error('the response carried no token');

  // The token's own `TSTInfo` is where the time it attests lives, and where the
  // nonce comes back. Reading a time off the outer tree instead found the TSA's
  // own `signingTime` — or, when it found nothing, this machine's clock, which is
  // not what the authority said.
  const info = tstInfoOf(tokenNode);
  if (!info) throw new Error('the token carries no TSTInfo, so it attests no time');
  // `genTime` is the attested time; the tree-wide search is the fallback for a
  // token that nests its TSTInfo somewhere this reader does not expect.
  const attestedAt = genTimeOf(info) ?? readTokenGenTime(tokenNode);
  if (!attestedAt) throw new Error('the token states no time in its TSTInfo');
  const echoed = nonceOf(info);
  if (echoed !== null && !sameInteger(echoed, nonce)) {
    throw new Error('the token answers a different request (its nonce is not the one sent)');
  }

  return {
    bytes: forge.asn1.toDer(tokenNode).getBytes(),
    attestedAt,
    authority: hostOf(tsaUrl),
  };
}

/** `messageImprint ::= SEQUENCE { hashAlgorithm, hashedMessage }`. */
function createMessageImprint(imprint: string): forge.asn1.Asn1 {
  const universal = forge.asn1.Class.UNIVERSAL;
  return forge.asn1.create(universal, forge.asn1.Type.SEQUENCE, true, [
    forge.asn1.create(universal, forge.asn1.Type.SEQUENCE, true, [
      forge.asn1.create(universal, forge.asn1.Type.OID, false, forge.asn1.oidToDer(forge.pki.oids.sha256).getBytes()),
      forge.asn1.create(universal, forge.asn1.Type.NULL, false, ''),
    ]),
    forge.asn1.create(universal, forge.asn1.Type.OCTETSTRING, false, imprint),
  ]);
}

/**
 * A DER `INTEGER` from raw octets: leading zeroes drop, and a high first bit
 * gains a `0x00` prefix so the number stays positive. Without the prefix a nonce
 * of `0x80…` encodes negative and a strict authority rejects the request — it
 * depended on the coin toss of the first random byte.
 */
function derInteger(octets: string): forge.asn1.Asn1 {
  let value = octets;
  let index = 0;
  while (index < value.length - 1 && value.charCodeAt(index) === 0) index++;
  value = value.slice(index);
  if (value.charCodeAt(0) > 0x7f) value = `\u0000${value}`;
  return forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.INTEGER, false, value);
}

/** Same number, whichever way its leading octets were written. */
function sameInteger(a: string, b: string): boolean {
  const trim = (value: string) => value.replace(/^[\u0000]+/, '');
  return trim(a) === trim(b);
}

/**
 * The `TSTInfo` inside a token: `ContentInfo { oid, [0] SignedData }`,
 * `SignedData.encapContentInfo { eContentType, [0] OCTET STRING }`, and the octet
 * string is the DER of a `TSTInfo`. The OCTET STRING is not parsed by
 * `forge.asn1.fromDer`, so its contents are parsed here.
 */
function tstInfoOf(tokenNode: forge.asn1.Asn1): forge.asn1.Asn1 | null {
  const encapsulated = child(child(child(child(tokenNode, 1), 0), 2), 1);
  const wrapped = child(encapsulated, 0);
  if (!wrapped || typeof wrapped.value !== 'string' || wrapped.value.length === 0) return null;
  try {
    return forge.asn1.fromDer(wrapped.value, false);
  } catch {
    return null;
  }
}

/** `TSTInfo.genTime`, the moment the authority attests. */
function genTimeOf(info: forge.asn1.Asn1): Date | undefined {
  for (const member of children(info)) {
    const isTime = member.tagClass === forge.asn1.Class.UNIVERSAL
      && (member.type === forge.asn1.Type.GENERALIZEDTIME || member.type === forge.asn1.Type.UTCTIME);
    if (isTime && typeof member.value === 'string') return parseAsn1Time(member.value);
  }
  return undefined;
}

/**
 * `TSTInfo.nonce`, when the authority echoed one.
 *
 * It is the INTEGER that follows `genTime`. Taking "the first INTEGER that is not
 * the version" picked the *serial number* instead, which is why a real DigiCert
 * token read as an answer to a different request.
 */
function nonceOf(info: forge.asn1.Asn1): string | null {
  let afterTime = false;
  for (const member of children(info)) {
    if (member.tagClass !== forge.asn1.Class.UNIVERSAL) continue;
    if (member.type === forge.asn1.Type.GENERALIZEDTIME || member.type === forge.asn1.Type.UTCTIME) {
      afterTime = true;
      continue;
    }
    if (afterTime && member.type === forge.asn1.Type.INTEGER && typeof member.value === 'string') {
      return member.value;
    }
  }
  return null;
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
