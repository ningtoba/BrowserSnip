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

/** Cheap structural check for an `/Encrypt` trailer entry without parsing. */
export function looksEncrypted(bytes: Uint8Array): boolean {
  const tail = bytes.subarray(Math.max(0, bytes.length - 4096));
  const text = new TextDecoder('latin1').decode(tail);
  return /\/Encrypt[\s\d]/.test(text) || /\/Encrypt>>/.test(text);
}

/**
 * Open a PDF. Unlike the previous `pdf-lib` call sites in this repo, a wrong
 * password is reported as a `PasswordRequiredError` so the UI can re-prompt
 * instead of showing a generic red banner.
 */
export async function openPDF(
  src: ArrayBuffer | Uint8Array | Bytes,
  options: OpenOptions = {},
): Promise<PDFDocument> {
  const bytes = toBytes(src);
  const { password, ignoreEncryption = false } = options;

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
  /** 1 = RC4-40, 2 = RC4-128, 4 = AES-128, 5 = AES-256. */
  version?: 1 | 2 | 4 | 5;
  permissions?: PDFPermissions;
}

/**
 * Real encryption. The legacy code path built seven permission booleans and
 * then dropped them on the floor because `@pdfsmaller/pdf-encrypt-lite` is
 * RC4-128 only; this uses the fork's crypto so AES-256 and the `/P` flag
 * dictionary actually reach the file.
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

  const encrypt: EncryptOptions = {
    ownerPassword: owner,
    userPassword: opts.userPassword ?? '',
    version: opts.version ?? 5,
    permissions: opts.permissions,
  };
  return doc.save({ encrypt });
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
 */
export async function drawPageInto(
  target: PDFDocument,
  page: PDFPage,
  source: PDFPage,
  box: { x: number; y: number; width: number; height: number },
  options: { scale?: number; rotate?: number; opacity?: number } = {},
): Promise<PDFEmbeddedPage> {
  const embedded = await target.embedPage(source);
  const rotate = options.rotate ?? 0;
  const swap = Math.abs(((rotate % 360) + 360) % 360) % 180 === 90;
  const sw = source.getWidth();
  const sh = source.getHeight();
  const natural = swap ? Math.min(box.width / sh, box.height / sw) : Math.min(box.width / sw, box.height / sh);
  const scale = (options.scale ?? 1) * natural;
  const drawW = (swap ? sh : sw) * scale;
  const drawH = (swap ? sw : sh) * scale;
  const x = box.x + (box.width - drawW) / 2;
  const y = box.y + (box.height - drawH) / 2;

  page.drawPage(embedded, {
    x,
    y,
    xScale: scale,
    yScale: scale,
    rotate: degrees(rotate),
    opacity: options.opacity,
  });
  return embedded;
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
  // SAFETY: `PDFContext` keeps the parsed `PDFHeader` on a field the public
  // type does not declare; it is present on every document loaded from bytes.
  const header = (
    doc.context as unknown as { header?: { toString(): string } | string }
  ).header;
  const text = typeof header === 'string' ? header : String(header ?? '');
  const m = text.match(/PDF-(\d\.\d)/);
  return m ? m[1] : '1.7';
}
