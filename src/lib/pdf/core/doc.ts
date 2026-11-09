/**
 * PDF document core.
 *
 * Wraps `@maxwbh/pdf-lib` — a maintained pdf-lib fork that adds AES/RC4
 * encryption on save, password-aware loading, file attachments and
 * incremental (append-only) saves. Incremental save is what lets us edit a
 * signed document without destroying the existing ByteRange signature, the
 * same strategy BentoPDF's text editor documents.
 *
 * Every operation in this app is local: bytes in, bytes out. Nothing here
 * ever touches the network except the explicit lazy engine loaders.
 */
import * as fontkitNamespace from '@pdf-lib/fontkit';
import {
  PDFDocument,
  PDFPage,
  PDFName,
  PDFDict,
  PDFHexString,
  PDFFlateStream,
  PDFRawStream,
  PDFRef,
  PDFArray,
  PDFContext,
  PDFNumber,
  PDFBool,
  PDFNull,
  PDFObject,
  PDFSecurity,
  PDFString,
  PDFStream,
  StandardFonts,
  rgb,
  cmyk,
  degrees,
  LineCapStyle,
  decodePDFRawStream,
} from '@maxwbh/pdf-lib';
import type {
  PDFFont,
  PDFImage,
  PDFEmbeddedPage,
  SaveOptions,
  EncryptOptions,
  PDFPermissions,
} from '@maxwbh/pdf-lib';
import { cropBox } from './pages';
import { decryptDocument } from './crypto';

type FontkitInstance = Parameters<PDFDocument['registerFontkit']>[0];

// SAFETY: `@pdf-lib/fontkit` is a CommonJS module whose export *is* the fontkit
// instance pdf-lib expects (`{ create(buffer) }`). Depending on the bundler's
// interop mode it can arrive nested under `.default` instead; both shapes are
// the same runtime object, so narrowing to the registered instance is sound.
function resolveFontkit(): FontkitInstance {
  const ns = fontkitNamespace as { default?: FontkitInstance } & FontkitInstance;
  return ns.default ?? ns;
}

/** The fontkit instance registered on every document this module produces. */
export const fontkit: FontkitInstance = resolveFontkit();

export type Bytes = Uint8Array;

export interface OpenOptions {
  /** User or owner password. Required for encrypted documents. */
  password?: string;
  /**
   * Allow encrypted documents through without a password. Streams stay
   * encrypted, so page copying can yield blank output — prefer `password`.
   */
  ignoreEncryption?: boolean;
  /** Retain `/ID` and don't rewrite the modification date on save. */
  updateMetadata?: boolean;
}

/** Thrown when a document needs a password the caller did not supply. */
export class PasswordRequiredError extends Error {
  readonly name = 'PasswordRequiredError';
  constructor(message = 'This PDF is password protected.') {
    super(message);
  }
}

export function isPasswordError(err: unknown): boolean {
  if (err instanceof PasswordRequiredError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /encrypt|password/i.test(msg) && !/not encrypted/i.test(msg);
}

/**
 * Cheap structural check for an `/Encrypt` trailer entry without parsing.
 *
 * The key has to be recognised whatever follows it, because producers differ:
 * qpdf writes `/Encrypt 12 0 R`, MuPDF inlines the whole dictionary —
 * `/Encrypt<</Filter/Standard/R 3/V 2 …>>` — and a scan that only looked for the
 * reference spelling called every MuPDF-locked file unencrypted, which is how a
 * ciphered document reached an editing tool with nothing asked of it. The
 * delimiter must not be a word character, or `/EncryptMetadata` answers yes on a
 * file whose only crime is having permissions.
 */
export function looksEncrypted(bytes: Uint8Array): boolean {
  const tail = bytes.subarray(Math.max(0, bytes.length - 4096));
  const text = new TextDecoder('latin1').decode(tail);
  return /\/Encrypt(?![A-Za-z0-9_])/.test(text);
}

/**
 * Open a PDF. Unlike the previous `pdf-lib` call sites in this repo, a wrong
 * password is reported as a `PasswordRequiredError` so the UI can re-prompt
 * instead of showing a generic red banner.
 *
 * A file whose crypt filter names a real cipher is decrypted here first, so every
 * tool in the catalogue is handed plaintext rather than ciphertext — see
 * `decryptCipheredPDF` and `core/crypto.ts`.
 */
export async function openPDF(
  src: ArrayBuffer | Uint8Array | Bytes,
  options: OpenOptions = {},
): Promise<PDFDocument> {
  const bytes = toBytes(src);
  const { password, ignoreEncryption = false } = options;

  const decrypted = await decryptCipheredPDF(bytes, options);
  if (decrypted) return decrypted;

  if (password) {
    try {
      return await PDFDocument.load(bytes, { password, ignoreEncryption: false });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/encrypt/i.test(msg)) {
        throw new PasswordRequiredError(
          'That password is not correct for this PDF.',
        );
      }
      throw err;
    }
  }

  if (!ignoreEncryption && looksEncrypted(bytes)) {
    // pdf-lib refuses encrypted documents without ignoreEncryption; surface a
    // typed error the UI understands rather than an opaque parse failure.
    throw new PasswordRequiredError();
  }

  return PDFDocument.load(bytes, {
    ignoreEncryption: true,
    updateMetadata: options.updateMetadata ?? true,
  });
}

/** What `PDFDocument.load` stamps into `/Info`; the decrypt pass repeats it. */
const LOADED_PRODUCER = 'pdf-lib (https://github.com/Hopding/pdf-lib)';

/**
 * Undo a real cipher, when `core/crypto` can, and hand back a plaintext document.
 *
 * `null` means "this is not the path for this file", and every caller's existing
 * behaviour then applies untouched: no `/Encrypt` entry at all; a gate whose
 * effective crypt filter is `/None` (what this app's own `protect` writes, whose
 * streams were never ciphered); a cipher this app refuses by name, such as
 * AES-256, a public-key handler or a file whose objects live in object streams; a
 * lock whose secret did not open it; and a file too damaged to parse, whose error
 * the ordinary path reports. Keeping the exception list on the returning-null side
 * is what limits this to the case that was actually broken — a file with
 * ciphertext behind its dictionary, and the password to open it.
 */
async function decryptCipheredPDF(
  bytes: Bytes,
  options: OpenOptions,
): Promise<PDFDocument | null> {
  if (!looksEncrypted(bytes)) return null;
  let doc: PDFDocument;
  try {
    // The structure is readable whatever the cipher: `pdf-lib` only checks a
    // password when asked to, and checking one is not the same as undoing it.
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    return null;
  }
  const outcome = await decryptDocument(doc, options.password);
  if (outcome.kind !== 'decrypted') return null;
  // Stamped *after* the strings are readable: loading with `updateMetadata` would
  // write a plaintext ModDate into a still-ciphered document, and the pass would
  // then decrypt its own stamp into mojibake.
  if (options.updateMetadata !== false) {
    const now = new Date();
    doc.setProducer(LOADED_PRODUCER);
    doc.setModificationDate(now);
    if (!doc.getCreator()) doc.setCreator(LOADED_PRODUCER);
    if (!doc.getCreationDate()) doc.setCreationDate(now);
  }
  return doc;
}

export async function newPDF(): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  return doc;
}

/** Register fontkit on a document that came from `openPDF`. Idempotent. */
export function withFontkit(doc: PDFDocument): PDFDocument {
  try {
    doc.registerFontkit(fontkit);
  } catch {
    /* already registered, or the fork rejects a duplicate */
  }
  return doc;
}

export interface SavePdfOptions extends SaveOptions {
  /** Force the `/ID` + ModDate refresh. Defaults to pdf-lib behaviour. */
  compress?: boolean;
}

export async function savePDF(
  doc: PDFDocument,
  options: SavePdfOptions = {},
): Promise<Bytes> {
  const { compress, ...rest } = options;
  return doc.save({ useObjectStreams: compress ?? true, ...rest });
}

export interface PasswordOptions {
  userPassword?: string;
  ownerPassword?: string;
  permissions?: PDFPermissions;
}

/**
 * The password gate and the `/P` flags, written as the crypt filter `/None`.
 *
 * `@maxwbh/pdf-lib`'s `save({ encrypt })` registers an `/Encrypt` dictionary and
 * a document `/ID`, and its `PDFSecurity` computes `/O` and `/U` by the
 * revision-4 algorithm — but nothing ever calls `PDFSecurity.encryptStream` or
 * `encryptString`, so the strings and streams are serialized exactly as this app
 * holds them. The fork therefore has no strength to select: `version` chose the
 * label on a dictionary, not a cipher, and `/V 5 /R 6` with `/CFM /AESV2` was a
 * 256-bit label beside a 128-bit filter over plaintext bytes. Measured against
 * MuPDF, poppler, qpdf, pypdf and Ghostscript, that file opened nowhere: MuPDF
 * refused it outright, qpdf reported `some V=5 encryption dictionary parameters
 * are missing or the wrong type`, and where a reader did get in it decrypted
 * plaintext and lost the page.
 *
 * What the bytes *are* is expressible, and it is what this writes: `/V 4 /R 4`
 * with a 128-bit key (the strength `/O` and `/U` are genuinely computed at), an
 * empty `/CF`, and no `/StmF` or `/StrF` — whose spec default is the predefined
 * crypt filter `/None`, "the data are not encrypted". Every reader asked here
 * opens that file, keeps its text, and — in MuPDF, qpdf and pypdf — refuses it
 * without the password. poppler reads it and reports it as unencrypted, because
 * a gate with no cipher is nothing for it to undo.
 *
 * The dictionary is assembled here rather than by `save({ encrypt })` for one
 * reason: `setupEncryption` writes the cipher claim itself, and this file must
 * not serialize the document twice to take one key back out.
 */
export async function saveEncrypted(
  doc: PDFDocument,
  opts: PasswordOptions,
): Promise<Bytes> {
  const owner =
    opts.ownerPassword && opts.ownerPassword.length > 0
      ? opts.ownerPassword
      : opts.userPassword || randomOwnerPassword();

  if (!opts.userPassword && !opts.ownerPassword) {
    throw new Error('Enter an owner or a user password to protect this PDF.');
  }

  const security = new PDFSecurity(doc.context);
  // Revision 4 is not a preference: it is the only `/O` and `/U` this engine
  // actually computes to spec, and the only `/V` whose crypt filters can name
  // `/None`. Ask for 256-bit here and the answer is still a 128-bit hash.
  security.setupEncryption({
    ownerPassword: owner,
    userPassword: opts.userPassword ?? '',
    permissions: opts.permissions,
    version: 4,
  });

  const dict = security.createEncryptDict();
  dict.set(PDFName.of('CF'), PDFDict.withContext(doc.context));
  dict.delete(PDFName.of('StmF'));
  dict.delete(PDFName.of('StrF'));
  dict.set(PDFName.of('EncryptMetadata'), PDFBool.True);
  doc.context.trailerInfo.Encrypt = doc.context.register(dict);

  // `/U` is computed over the `/ID`, so the pair is written from the same id the
  // hashes were derived with; `save()` without `encrypt` leaves both alone.
  const id = PDFArray.withContext(doc.context);
  const documentId = PDFHexString.fromBytes(security.getDocumentId());
  id.push(documentId);
  id.push(documentId);
  doc.context.trailerInfo.ID = id;

  return doc.save({ useObjectStreams: true });
}

function randomOwnerPassword(): string {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Snapshot + `saveIncremental` pair for append-only revisions. */
export async function saveIncremental(
  doc: PDFDocument,
  encrypt?: EncryptOptions,
): Promise<Bytes> {
  // takeSnapshot must be called before the edits for a true append; when the
  // caller did not snapshot early we fall back to a full save, which is still
  // correct, just not byte-append-only.
  try {
    const bytes = await doc.saveIncremental({});
    if (bytes && bytes.length > 0) return bytes;
  } catch {
    /* fall through */
  }
  return doc.save(encrypt ? { encrypt } : {});
}

export async function snapshot(doc: PDFDocument): Promise<void> {
  try {
    await doc.takeSnapshot();
  } catch {
    /* the fork tolerates a missing snapshot and full-saves instead */
  }
}

/** Clone a document by round-tripping its bytes — cheap isolation between tools. */
export async function clonePDF(
  doc: PDFDocument,
  options: SavePdfOptions = {},
): Promise<PDFDocument> {
  const bytes = await savePDF(doc, options);
  return openPDF(bytes, { ignoreEncryption: true });
}

/**
 * Import pages from one or more documents into a fresh document, preserving
 * the requested order and mapping source indices to destination pages.
 */
export async function collectPages(
  sources: { doc: PDFDocument; pages: number[] }[],
): Promise<{ doc: PDFDocument; ranges: { start: number; count: number }[] }> {
  const target = await newPDF();
  const ranges: { start: number; count: number }[] = [];
  for (const { doc, pages } of sources) {
    if (pages.length === 0) continue;
    const start = target.getPageCount();
    const copied = await target.copyPages(doc, pages);
    copied.forEach((p) => target.addPage(p));
    ranges.push({ start, count: pages.length });
  }
  return { doc: target, ranges };
}

/**
 * Draw a source page onto a target page as a form XObject. This is the
 * primitive behind N-up, booklet, overlay, posterize, rotate-by-arbitrary-
 * angle and fix-page-size: it scales and repositions real vector content
 * instead of rasterising it.
 *
 * The source is measured **per page**, from its own visible box (E8): a
 * document whose second sheet is a different size is not squeezed into the
 * first sheet's rectangle. Two things the page content stream does not carry
 * are re-applied here, because `embedPage` copies the raw stream (B1 item 1):
 *
 * - `/Rotate` is a display instruction, so an embedded page comes out sideways
 *   unless the turn is composed into the draw matrix (E9). `options.rotate` is
 *   an **extra clockwise** turn on top of the page's own `/Rotate` — clockwise
 *   is what `/Rotate`, the UI and a viewer all mean — and the two are added
 *   before being negated for pdf-lib, whose content matrix turns
 *   counter-clockwise.
 * - the box origin is honoured by clipping to the visible box **in the page's
 *   own coordinates**, which is what shifts an offset `/MediaBox` (e.g. a
 *   scanned sheet at `[36 36 612 792]`) back onto the cell instead of cropping
 *   its left and bottom edges away.
 *
 * The turn is composed around the centre of that box: the rotated bounding
 * rectangle is what gets scaled into `box`, so a quarter-turned sheet fills a
 * cell sized for it as displayed rather than overflowing its neighbour.
 */
export async function drawPageInto(
  target: PDFDocument,
  page: PDFPage,
  source: PDFPage,
  box: { x: number; y: number; width: number; height: number },
  options: { scale?: number; rotate?: number; opacity?: number } = {},
): Promise<PDFEmbeddedPage> {
  const region = cropBox(source);
  const embedded = await target.embedPage(source, {
    left: region.x,
    bottom: region.y,
    right: region.x + region.width,
    top: region.y + region.height,
  });

  const clockwise = normalise360(pageRotation(source) + (options.rotate ?? 0));
  const radians = (-clockwise * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  // The embedder shifts the region's bottom-left to the origin, so the four
  // corners of the visible box are what the draw matrix turns.
  const corners = [
    [0, 0],
    [region.width, 0],
    [0, region.height],
    [region.width, region.height],
  ].map(([x, y]) => [snap(x * cos - y * sin), snap(x * sin + y * cos)] as const);
  const minX = Math.min(...corners.map((c) => c[0]));
  const maxX = Math.max(...corners.map((c) => c[0]));
  const minY = Math.min(...corners.map((c) => c[1]));
  const maxY = Math.max(...corners.map((c) => c[1]));
  const drawnWidth = maxX - minX;
  const drawnHeight = maxY - minY;
  if (drawnWidth <= 0 || drawnHeight <= 0 || box.width <= 0 || box.height <= 0) {
    // Nothing this cell can hold: a zero-area source box or target box would
    // only write `0 0 0 0 … cm`, which no viewer draws.
    return embedded;
  }

  const scale = (options.scale ?? 1) * Math.min(box.width / drawnWidth, box.height / drawnHeight);
  page.drawPage(embedded, {
    x: box.x + (box.width - drawnWidth * scale) / 2 - minX * scale,
    y: box.y + (box.height - drawnHeight * scale) / 2 - minY * scale,
    xScale: scale,
    yScale: scale,
    rotate: degrees(-clockwise),
    opacity: options.opacity,
  });
  return embedded;
}

/** A page's own `/Rotate` as a clockwise angle in 0–359 (0 when absent). */
export function pageRotation(page: PDFPage): number {
  return normalise360(page.getRotation().angle);
}

/** `450 → 90`, `-90 → 270`; readers take `/Rotate` modulo 360 and writers do emit both. */
function normalise360(angle: number): number {
  return ((angle % 360) + 360) % 360;
}

/** Clear the `6.1e-17` a quarter turn leaves behind. */
function snap(value: number): number {
  return Math.abs(value) < 1e-9 ? 0 : value;
}

/** Low-level access used by the annotation / metadata / content modules. */
export {
  PDFDocument,
  PDFPage,
  PDFName,
  PDFDict,
  PDFHexString,
  PDFFlateStream,
  PDFRawStream,
  PDFRef,
  PDFArray,
  PDFContext,
  PDFNumber,
  PDFBool,
  PDFNull,
  PDFObject,
  PDFSecurity,
  PDFString,
  PDFStream,
  StandardFonts,
  rgb,
  cmyk,
  degrees,
  LineCapStyle,
  decodePDFRawStream,
};
export type { PDFFont, PDFImage, PDFEmbeddedPage, EncryptOptions, PDFPermissions };

export function toBytes(src: ArrayBuffer | Uint8Array | Bytes): Uint8Array {
  if (src instanceof Uint8Array) return src;
  return new Uint8Array(src);
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

export async function blobToBytes(blob: Blob): Promise<Bytes> {
  return new Uint8Array(await blob.arrayBuffer());
}

/** Document catalog helpers shared by several tools. */
export function catalog(doc: PDFDocument) {
  return doc.catalog;
}

export function context(doc: PDFDocument): PDFContext {
  return doc.context;
}

/** Read the PDF version header the fork exposes on the context. */
export function pdfVersion(doc: PDFDocument): string {
  const header = pdfHeaderOf(doc);
  const text = typeof header === 'string' ? header : String(header ?? '');
  const m = text.match(/PDF-(\d\.\d)/);
  return m ? m[1] : '1.7';
}

/** Versions a `%PDF-M.m` line can carry; the ones tools ever need to ask for. */
export type PdfVersion = '1.4' | '1.5' | '1.6' | '1.7' | '2.0';

/**
 * The `PDFHeader` the fork keeps on the context. `major`/`minor` are `private`
 * in the class, which is a compile-time-only label: at runtime they are plain
 * writable own properties, and the class itself is not exported.
 */
type PdfHeader = { major: string; minor: string; toString(): string };

function pdfHeaderOf(doc: PDFDocument): PdfHeader | string | undefined {
  // SAFETY: `PDFHeader` is not exported by the fork, so the only honest shape
  // for the field is the two digits it stores plus `toString()`.
  return (doc.context as unknown as { header?: PdfHeader | string }).header;
}

/** `1.5 < 1.7` — the numeric comparison a version string cannot get by with. */
function comparePdfVersions(a: string, b: string): number {
  const [am = 0, an = 0] = a.split('.').map(Number);
  const [bm = 0, bn = 0] = b.split('.').map(Number);
  return am !== bm ? am - bm : an - bn;
}

/**
 * Raise the PDF version a document declares (B2 item 1): a tool that writes
 * object streams into a file that still says `1.4` has to say `1.5` first,
 * instead of only warning about the mismatch.
 *
 * It raises and never lowers — downgrading a file that already uses newer
 * structures would make it read worse, not better — and returns the version
 * the document declares afterwards, which is what a caller should report.
 *
 * Two surfaces carry the claim and this only reaches one of them: the fork's
 * full-save writers hard-code `%PDF-1.7`, while `saveIncremental` copies the
 * original bytes verbatim. Use `applyPdfVersion` on the saved bytes when the
 * emitted header itself has to change.
 */
export function setPdfVersion(doc: PDFDocument, version: PdfVersion): string {
  const header = pdfHeaderOf(doc);
  if (!header || typeof header === 'string') return pdfVersion(doc);
  const current = pdfVersion(doc);
  if (comparePdfVersions(version, current) <= 0) return current;
  const [major, minor] = version.split('.');
  header.major = major ?? '1';
  header.minor = minor ?? '7';
  return version;
}

/**
 * Rewrite the `%PDF-M.m` line of already-saved bytes, raising it to `version`.
 *
 * Every version string is the same width and the patch is done in place, so it
 * cannot move a byte an xref offset points at — which is the whole reason it is
 * safe to apply to a finished file rather than re-saving it.
 */
export function applyPdfVersion(bytes: Bytes, version: PdfVersion): Bytes {
  const text = new TextDecoder('latin1').decode(bytes.subarray(0, 9));
  const match = /^%PDF-(\d\.\d)/.exec(text);
  if (!match || comparePdfVersions(version, match[1]) <= 0) return bytes;
  const major = version.charCodeAt(0);
  const minor = version.charCodeAt(2);
  bytes[5] = major;
  bytes[7] = minor;
  return bytes;
}
