/**
 * Universal image decode/encode.
 *
 * `image-to-pdf` used to sniff only "PNG or assume JPEG", so the drop zone's
 * advertised WEBP/GIF/AVIF/TIFF inputs threw inside `embedJpg`. Everything
 * here decodes through the browser first (PNG/JPEG/GIF/WebP/AVIF/BMP wherever
 * the engine supports them), uses a software decoder for TIFF, extracts the
 * flattened composite from a PSD, and re-encodes into a container pdf-lib can
 * actually embed.
 */
import UTIF from 'utif';
import type { PDFDocument, PDFImage } from '@maxwbh/pdf-lib';
import { canvasContext2d, canvasToBlob, encodeBmp, encodeTiff } from './raster';

export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'bmp' | 'tiff';

export interface DecodedImage {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  /** Source format that was decoded, after magic-number correction. */
  mime: string;
}

export interface DecodeOptions {
  /** Hint only — magic bytes always win. */
  mime?: string;
  /** Cap the longest edge to bound memory on pathological inputs. */
  maxSide?: number;
  /** Composite transparency onto this colour instead of keeping alpha. */
  background?: string;
}

const MAGIC_TABLE: { test: (b: Uint8Array) => boolean; mime: string }[] = [
  { test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47, mime: 'image/png' },
  { test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff, mime: 'image/jpeg' },
  { test: (b) => ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a'), mime: 'image/gif' },
  { test: (b) => ascii(b, 0, 'BM'), mime: 'image/bmp' },
  { test: (b) => b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a, mime: 'image/tiff' },
  { test: (b) => b[0] === 0x4d && b[1] === 0x4d && b[3] === 0x2a, mime: 'image/tiff' },
  { test: (b) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP'), mime: 'image/webp' },
  { test: (b) => ascii(b, 4, 'ftyp') && (ascii(b, 8, 'avif') || ascii(b, 8, 'avis')), mime: 'image/avif' },
  { test: (b) => ascii(b, 4, 'ftyp'), mime: 'image/heic' },
  { test: (b) => ascii(b, 0, '8BPS'), mime: 'image/vnd.adobe.photoshop' },
];

function ascii(b: Uint8Array, start: number, s: string): boolean {
  for (let i = 0; i < s.length; i++) if (b[start + i] !== s.charCodeAt(i)) return false;
  return true;
}

/** Magic-number sniff; the declared MIME or filename is frequently wrong. */
export function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  for (const entry of MAGIC_TABLE) if (entry.test(bytes)) return entry.mime;
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, Math.min(bytes.length, 512)))
    .replace(/^\s+/, '');
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
    return 'image/svg+xml';
  }
  return null;
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  dib: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
  heif: 'image/heif',
  svg: 'image/svg+xml',
  psd: 'image/vnd.adobe.photoshop',
};

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/vnd.adobe.photoshop': 'psd',
};

export function mimeForFile(name: string): string | undefined {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext];
}

export function extensionForMime(mime: string): string {
  const base = mime.split(';')[0].trim().toLowerCase();
  return EXT_BY_MIME[base] ?? (base.startsWith('image/') ? base.slice(6) : 'bin');
}

/** Resolve a MIME from magic bytes, then the declared type, then the name. */
export function resolveImageMime(bytes: Uint8Array, declared?: string, name?: string): string {
  return sniffImageMime(bytes) ?? declared ?? (name ? mimeForFile(name) : undefined) ?? 'image/png';
}

/**
 * Decode any image this browser (or utif) can read into an RGBA canvas.
 * Formats that only exist in a proprietary container — HEIC/HEIF on non-Apple
 * engines — report a specific, actionable error instead of throwing a blob.
 */
export async function decodeImage(
  input: Uint8Array | ArrayBuffer | Blob,
  options: DecodeOptions = {},
): Promise<DecodedImage> {
  const bytes = toBytes(input);
  const mime = resolveImageMime(bytes, options.mime);

  switch (mime) {
    case 'image/tiff':
      return decodeTiff(bytes, options);
    case 'image/svg+xml':
      return decodeSvg(bytes, options);
    case 'image/vnd.adobe.photoshop':
      return decodePhotoshop(bytes, options);
    default:
      return decodeNative(bytes, mime, options);
  }
}

/** Decode every page of a multi-page TIFF. */
export async function decodeImagePages(
  input: Uint8Array | ArrayBuffer,
  options: DecodeOptions = {},
): Promise<DecodedImage[]> {
  const bytes = toBytes(input);
  const mime = resolveImageMime(bytes, options.mime);
  if (mime !== 'image/tiff') return [await decodeImage(bytes, { ...options, mime })];
  const buffer = bufferOf(bytes);
  const ifds = UTIF.decode(buffer);
  const out: DecodedImage[] = [];
  for (let index = 0; index < ifds.length; index++) {
    out.push(ifdToCanvas(ifds[index], buffer, options, index + 1));
  }
  if (out.length === 0) throw new Error('That TIFF file did not contain any decodable pages.');
  return out;
}

async function decodeNative(
  bytes: Uint8Array,
  mime: string,
  options: DecodeOptions,
): Promise<DecodedImage> {
  const source = await loadBitmap(bytes, mime);
  try {
    const scale = sizeScale(source.width, source.height, options.maxSide);
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvasContext2d(canvas);
    if (options.background) {
      ctx.fillStyle = options.background;
      ctx.fillRect(0, 0, width, height);
    }
    ctx.drawImage(source, 0, 0, width, height);
    return { canvas, width, height, mime };
  } finally {
    if ('close' in source && typeof source.close === 'function') source.close();
  }
}

type Bitmap = ImageBitmap | HTMLImageElement;

async function loadBitmap(bytes: Uint8Array, mime: string): Promise<Bitmap> {
  const blob = new Blob([bytes as BlobPart], { type: mime || 'application/octet-stream' });
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob);
    } catch {
      /* the <img> path supports more formats on some engines */
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(unsupported(mime));
      img.src = url;
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function unsupported(mime: string): Error {
  const label = mime === 'image/heic' || mime === 'image/heif' ? 'HEIC/HEIF' : mime;
  return new Error(
    `This browser cannot decode ${label}. Convert the file to PNG or JPEG, or open it in Safari or Chrome 130+.`,
  );
}

function decodeTiff(bytes: Uint8Array, options: DecodeOptions): DecodedImage {
  const buffer = bufferOf(bytes);
  const ifds = UTIF.decode(buffer);
  if (ifds.length === 0) throw new Error('That TIFF file did not contain any decodable pages.');
  return ifdToCanvas(ifds[0], buffer, options, 1);
}

/**
 * What UTIF hands back for one decoded page.
 *
 * The ambient `UtifIFD` type names the dimensions `w` and `h`, but `decodeImage`
 * publishes `width` / `height` (copied out of the `t256` / `t257` tags) and
 * never sets anything else, so `ifd.w` is `undefined` on every real file.
 */
interface UtifPage {
  width?: unknown;
  height?: unknown;
  t256?: unknown;
  t257?: unknown;
}

/** One TIFF dimension: a positive whole number, or `null` when unstated. */
function dimension(value: unknown): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const size = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(size) && size >= 1 ? Math.round(size) : null;
}

/**
 * The size a decoded TIFF page really has, read from the fields UTIF fills in
 * (falling back to the raw tags, which are already there after `UTIF.decode`,
 * so a page's size can be reported without decompressing it — E12).
 *
 * `null` means "the file does not say", and callers must show that honestly
 * instead of painting a 0 × 0 or 1 × 1 placeholder (E15).
 */
export function tiffPageDimensions(ifd: unknown): { width: number | null; height: number | null } {
  const page = (ifd ?? {}) as UtifPage;
  return {
    width: dimension(page.width ?? page.t256),
    height: dimension(page.height ?? page.t257),
  };
}

/**
 * Down-scale factor for `maxSide`. An absent, non-finite or non-positive cap
 * means "keep the real size" rather than collapsing the image to a point (E15).
 */
function sizeScale(width: number, height: number, maxSide?: number): number {
  const cap = typeof maxSide === 'number' && Number.isFinite(maxSide) && maxSide > 0 ? maxSide : 0;
  if (!cap) return 1;
  return Math.min(1, cap / Math.max(width, height));
}

function ifdToCanvas(
  ifd: ReturnType<typeof UTIF.decode>[number],
  buffer: ArrayBuffer,
  options: DecodeOptions,
  page = 1,
): DecodedImage {
  UTIF.decodeImage(buffer, ifd);
  const { width, height } = tiffPageDimensions(ifd);
  if (width === null || height === null) {
    throw new Error(
      `Page ${page} of that TIFF does not record a width and height, so it cannot be decoded.`,
    );
  }
  const rgba = UTIF.toRGBA8(ifd);
  const scale = sizeScale(width, height, options.maxSide);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvasContext2d(canvas);
  if (options.background) {
    ctx.fillStyle = options.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  const stage = document.createElement('canvas');
  stage.width = width;
  stage.height = height;
  const stageCtx = canvasContext2d(stage);
  stageCtx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  ctx.drawImage(stage, 0, 0, canvas.width, canvas.height);
  return { canvas, width: canvas.width, height: canvas.height, mime: 'image/tiff' };
}

async function decodeSvg(bytes: Uint8Array, options: DecodeOptions): Promise<DecodedImage> {
  const text = new TextDecoder().decode(bytes);
  const withXmlns = /xmlns=/.test(text)
    ? text
    : text.replace(/<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
  return decodeNative(new TextEncoder().encode(withXmlns), 'image/svg+xml', options);
}

async function decodePhotoshop(bytes: Uint8Array, options: DecodeOptions): Promise<DecodedImage> {
  // Layer data needs a real PSD parser; the flattened composite appended at
  // the end of the file is what every "PSD preview" implementation uses.
  const preview = findEmbeddedPreview(bytes);
  if (!preview) {
    throw new Error(
      'That PSD has no flattened preview embedded, so its layers cannot be rasterised in the browser.',
    );
  }
  return decodeNative(preview.bytes, preview.mime, options);
}

function findEmbeddedPreview(bytes: Uint8Array): { bytes: Uint8Array; mime: string } | null {
  for (let i = bytes.length - 4; i > 4; i--) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd8 && bytes[i + 2] === 0xff) {
      return { bytes: bytes.subarray(i), mime: 'image/jpeg' };
    }
    if (bytes[i] === 0x89 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x4e && bytes[i + 3] === 0x47) {
      return { bytes: bytes.subarray(i), mime: 'image/png' };
    }
  }
  return null;
}

export interface EncodeOptions {
  format: ImageFormat;
  quality?: number;
  background?: string;
}

export async function encodeImage(
  canvas: HTMLCanvasElement,
  options: EncodeOptions,
): Promise<Blob> {
  const { format, quality = 0.92, background } = options;
  if (format === 'bmp') return encodeBmp(flatten(canvas, background));
  if (format === 'tiff') return encodeTiff(flatten(canvas, background));
  return canvasToBlob(canvas, format, quality, { background });
}

export async function encodeImageBytes(
  canvas: HTMLCanvasElement,
  options: EncodeOptions,
): Promise<{ bytes: Uint8Array; mime: string; ext: string }> {
  const blob = await encodeImage(canvas, options);
  const mime = options.format === 'jpeg' ? 'image/jpeg' : `image/${options.format}`;
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    mime,
    ext: options.format === 'jpeg' ? 'jpg' : options.format,
  };
}

function flatten(canvas: HTMLCanvasElement, background?: string): HTMLCanvasElement {
  if (!background) return canvas;
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = canvasContext2d(out);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, 0, 0);
  return out;
}

/**
 * Rasterise through a canvas so any input format becomes a PNG or JPEG that
 * pdf-lib can embed. This is what makes the advertised WEBP/GIF/AVIF/TIFF/
 * HEIC/PSD/SVG drop zone actually work.
 */
export async function toEmbeddableImage(
  doc: PDFDocument,
  input: Uint8Array | ArrayBuffer | Blob,
  options: DecodeOptions & { format?: 'png' | 'jpeg'; quality?: number } = {},
): Promise<PDFImage & { sourceMime: string }> {
  const decoded = await decodeImage(input, options);
  const format = options.format ?? 'png';
  const encoded = await encodeImageBytes(decoded.canvas, {
    format,
    quality: options.quality,
    background: format === 'jpeg' ? options.background ?? '#ffffff' : options.background,
  });
  const image =
    format === 'jpeg'
      ? await doc.embedJpg(encoded.bytes)
      : await doc.embedPng(encoded.bytes);
  return Object.assign(image, { sourceMime: decoded.mime });
}

export function toBytes(input: Uint8Array | ArrayBuffer | Blob): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(0);
}

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
