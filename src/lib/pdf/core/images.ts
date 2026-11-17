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
  /** File name, used when a caller has one, so the sentence can name it. */
  name?: string;
  /**
   * How long the browser gets to answer before this module admits it will not.
   * Defaults to `IMAGE_DECODE_TIMEOUT_MS`; 0 removes the bound.
   */
  decodeTimeoutMs?: number;
}

/**
 * A refusal from the browser's own image decoders, in the user's words.
 *
 * Named so a caller can tell "this browser cannot open this picture" apart from
 * a bug. `stalled` marks the worse case: the browser started, answered neither
 * yes nor no, and this module stopped waiting for it.
 */
export class ImageDecodeError extends Error {
  override readonly name = 'ImageDecodeError';
  readonly stalled: boolean;

  constructor(message: string, stalled = false) {
    super(message);
    this.stalled = stalled;
  }
}

/**
 * How long a decode may take before the run is told it will not finish.
 *
 * `createImageBitmap` and the `<img>` load event are both promises the browser
 * keeps, and either can go unanswered: a stalled blob URL, a codec the engine
 * abandons silently, or a build with no bitmap API at all. Untimed, every
 * image-backed tool inherits a spinner with no message and no way out.
 */
export const IMAGE_DECODE_TIMEOUT_MS = 30_000;

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

/**
 * How many bytes a BMP header says its pixel array occupies, and where it starts.
 *
 * Only the `BITMAPINFOHEADER` family (40 bytes and up) is modelled. A header this
 * does not understand returns `null` so the browser still gets its try — a
 * refusal is only ever made on the file's own numbers.
 */
function bmpPixelArray(bytes: Uint8Array):
  | { strokes: string }
  | { width: number; rows: number; offBits: number; required: number; bottomUp: boolean }
  | null {
  if (bytes.length < 26) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerSize = view.getUint32(14, true);
  if (headerSize < 40) return null;
  const width = view.getInt32(18, true);
  const height = view.getInt32(22, true);
  const planes = view.getUint16(26, true);
  const bpp = view.getUint16(28, true);
  const compression = view.getUint32(30, true);
  // RLE (1, 2) is run-length coded, so no stride applies to it.
  if (width <= 0 || height === 0 || planes !== 1) return null;
  if (![1, 4, 8, 16, 24, 32].includes(bpp) || (compression !== 0 && compression !== 3)) return null;
  const used = view.getUint32(46, true);
  const palette = bpp <= 8 ? (used > 0 ? used : 2 ** bpp) * 4 : 0;
  const headerEnd = 14 + headerSize + palette;
  const offBits = view.getUint32(10, true);
  const rows = Math.abs(height);
  const stride = Math.ceil((bpp * width) / 32) * 4;
  if (offBits < headerEnd) {
    return { strokes: `its header points the pixels at byte ${offBits}, but the header and palette alone run to byte ${headerEnd}` };
  }
  if (offBits > bytes.length) {
    return { strokes: `its header points the pixels at byte ${offBits}, past the ${bytes.length} byte(s) the file holds` };
  }
  return { width, rows, offBits, required: offBits + stride * rows, bottomUp: height > 0 };
}

/**
 * Refuse a BMP whose own header describes more pixels than the file carries.
 *
 * Chrome does not: it paints the rows it has and fills the rest with white, so a
 * 24-bit 243 x 160 file cut after 10 rows embedded as a complete 243 x 160 page
 * with 150 invented white rows on top and nothing said (measured; Pillow calls
 * the same file `truncated`). Every other raster format here fails loudly or
 * carries a length; BMP is the one whose header states the byte count, so it is
 * checked before the decoder is asked.
 */
function assertBmpComplete(bytes: Uint8Array): void {
  const facts = bmpPixelArray(bytes);
  if (!facts) return;
  if ('strokes' in facts) throw new Error(facts.strokes);
  if (bytes.length >= facts.required) return;
  const stride = (facts.required - facts.offBits) / facts.rows;
  const missing = Math.ceil((facts.required - bytes.length) / stride);
  const where = facts.bottomUp ? 'top' : 'bottom';
  throw new Error(
    `its header describes ${facts.required} byte(s) of pixels for a ${facts.width} x ${facts.rows} picture `
    + `but the file stops after ${bytes.length} — the ${Math.min(missing, facts.rows)} row(s) at its ${where} `
    + 'would come out blank',
  );
}

/**
 * Whether the RIFF header's own byte count is satisfied by the file, in words.
 *
 * A WebP is RIFF: `File Size` at byte 4 says how long the file is and each chunk
 * header repeats the same claim about its own payload, both of them counted from
 * the bytes. Nothing on the decode path reads either, so a file cut short is
 * handed to `createImageBitmap`, which — measured on the dev build — answers a
 * *complete* 400 x 240 bitmap of white: a truncated WebP became a blank page, at
 * the right size, with the card claiming `2 WEBP image(s) -> 2 page(s)` (Pillow
 * refuses the same file, `could not create decoder object`). Only the file's own
 * numbers are used, and only `RIFF`/`WEBP` files are judged, so a MIME guess from
 * a name still reaches the browser.
 */
function webpShortfall(bytes: Uint8Array): string | null {
  if (bytes.length < 12 || !ascii(bytes, 0, 'RIFF') || !ascii(bytes, 8, 'WEBP')) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declared = view.getUint32(4, true) + 8;
  if (declared < 12) return `its RIFF header claims a ${declared} byte(s) file, which is shorter than the header itself`;
  // Trailing bytes past the declared length are legal and ignored (spec: a reader
  // MAY parse such a file), so only a *short* file and a chunk overrunning the
  // declared end are faults. Walking the chunks catches a file whose header size
  // was rewritten to the truncated length beside the cut payload.
  let at = 12;
  while (at + 8 <= declared) {
    const fourcc = String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
    const size = view.getUint32(at + 4, true);
    const end = at + 8 + size + (size & 1);
    if (end > declared) {
      return `its '${fourcc}' chunk at byte ${at} says ${size} byte(s), which runs past the ${declared} byte(s) its header declares`;
    }
    at = end;
  }
  if (bytes.length < declared) {
    return `its header says the file is ${declared} byte(s) long, but the file stops after ${bytes.length} — ${declared - bytes.length} byte(s) of the picture are missing`;
  }
  return null;
}

/** How many frames the file holds; `1` for a still, more for an animation. */
export function webpFrameCount(bytes: Uint8Array): number {
  if (!ascii(bytes, 0, 'RIFF') || !ascii(bytes, 8, 'WEBP')) return 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = Math.min(bytes.length, view.getUint32(4, true) + 8);
  let frames = 0;
  for (let at = 12; at + 8 <= end;) {
    const size = view.getUint32(at + 4, true);
    if (ascii(bytes, at, 'ANMF')) frames += 1;
    at += 8 + size + (size & 1);
  }
  return Math.max(1, frames);
}

function assertWebpComplete(bytes: Uint8Array): void {
  const fault = webpShortfall(bytes);
  if (fault) throw new Error(fault);
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
    case 'image/bmp':
      assertBmpComplete(bytes);
      return decodeNative(bytes, mime, options);
    case 'image/webp':
      assertWebpComplete(bytes);
      return decodeNative(bytes, mime, options);
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
  const short = tiffShortfall(ifds as unknown as { t273?: unknown; t279?: unknown }[], bytes.length);
  if (short) {
    throw new Error(`the file stops early: ${short}. The page would come out with its lower`
      + ' part blank');
  }
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
  const source = await loadBitmap(bytes, mime, options);
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

/** Formats whose label reads better in a sentence than the MIME does. */
function formatName(mime: string): string {
  if (mime === 'image/heic' || mime === 'image/heif') return 'HEIC/HEIF';
  if (mime === 'image/vnd.adobe.photoshop') return 'Photoshop (PSD)';
  return mime.replace('image/', '').toUpperCase() || 'this format';
}

/** `"scan-01.jpg" ` when a name is known, `This image` when it is not. */
function subject(name?: string): string {
  return name ? `"${name}"` : 'This image';
}

/**
 * Run `work` with a deadline that always produces an outcome.
 *
 * The point is not the number of seconds, it is that the caller is never left
 * awaiting a promise the browser has stopped intending to settle.
 */
function withDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  onExpire: () => ImageDecodeError,
): Promise<T> {
  if (timeoutMs <= 0) return work;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(onExpire());
    }, timeoutMs);
    // A bound must not be the reason a test process waits for it to fire.
    (timer as { unref?: () => void }).unref?.();
    void work.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * The `<img>` route. Both outcomes are handled; neither may be silent.
 *
 * An `onerror` that forgets to reject is as bad as no handler at all, so both
 * callbacks settle this promise and the caller still wraps it in a deadline for
 * the case where the load event never fires.
 */
function loadThroughImageTag(url: string): Promise<Bitmap> {
  return new Promise<Bitmap>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`the browser refused to load it as a picture`));
    img.src = url;
  });
}

/**
 * Decode bytes to a bitmap by whichever route this browser offers.
 *
 * Feature-detected, fallen back, and bounded: a missing `createImageBitmap` must
 * not strand the caller on a load event that never fires.
 */
async function loadBitmap(
  bytes: Uint8Array,
  mime: string,
  options: DecodeOptions,
): Promise<Bitmap> {
  const blob = new Blob([bytes as BlobPart], { type: mime || 'application/octet-stream' });
  const timeoutMs = options.decodeTimeoutMs ?? IMAGE_DECODE_TIMEOUT_MS;
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  const stall = (route: string): ImageDecodeError =>
    new ImageDecodeError(
      `${subject(options.name)} (${formatName(mime)}) did not finish decoding after ${seconds}s on the `
      + `${route} path: this browser started to open it and never answered. Re-export it as PNG or JPEG, `
      + 'or try another browser.',
      true,
    );

  let bitmapFailure: Error | null = null;
  if (typeof createImageBitmap === 'function') {
    try {
      return await withDeadline(createImageBitmap(blob), timeoutMs, () => stall('createImageBitmap'));
    } catch (err) {
      // A stall will not be cured by asking the same browser a second way.
      if (err instanceof ImageDecodeError) throw err;
      bitmapFailure = err instanceof Error ? err : new Error(String(err));
    }
  } else if (typeof Image !== 'function') {
    throw new ImageDecodeError(
      `${subject(options.name)} cannot be decoded here: this browser has no image decoder for `
      + `${formatName(mime)}. Convert it to PNG or JPEG, or open it in a browser whose platform can decode it.`,
    );
  }

  const url = URL.createObjectURL(blob);
  try {
    return await withDeadline(loadThroughImageTag(url), timeoutMs, () => stall('img'));
  } catch (err) {
    if (err instanceof ImageDecodeError) throw err;
    throw unsupported(mime, options.name, bitmapFailure ?? (err instanceof Error ? err : null));
  } finally {
    // Revoked on every exit, deadline included, so an abandoned load cannot
    // keep the bytes alive for the life of the tab.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/**
 * The refusal, in the user's words.
 *
 * "or open it in Safari or Chrome 130+" named a browser version, and the version
 * was measured to be beside the point: Chrome for Testing 151 on Linux has no
 * HEIC decoder at all, because the codec is the *platform's* (measured; the same
 * two files decode in Pillow on the same machine and fail in both `createImageBitmap`
 * and `<img>` — `docs/tasks/heic-decoder-claim-ticket.md`). So the dependency is
 * named instead of a version.
 */
function unsupported(mime: string, name?: string, cause?: Error | null): Error {
  return new ImageDecodeError(
    `${subject(name)} could not be opened: this browser has no decoder for ${formatName(mime)}`
    + `${cause ? ` (${cause.message})` : ''}. Convert the file to PNG or JPEG, or open it in a browser whose platform can decode it.`,
  );
}

function decodeTiff(bytes: Uint8Array, options: DecodeOptions): DecodedImage {
  const buffer = bufferOf(bytes);
  const ifds = UTIF.decode(buffer);
  if (ifds.length === 0) throw new Error('That TIFF file did not contain any decodable pages.');
  return ifdToCanvas(ifds[0], buffer, options, 1);
}

/**
 * How far past the end of the file a TIFF's own strip table reaches, or `null`.
 *
 * UTIF and the browser's canvas pad a short file with white and answer a
 * complete page, so a TIFF cut during transfer embedded as a full 200 x 120
 * sheet with its lower 72 rows blank and nothing said (measured). The strip
 * offsets and byte counts are in the directory, so the file can be asked
 * whether it is all there before anything is drawn — the same question the BMP
 * and WebP readers ask of their own headers.
 */
function tiffShortfall(ifds: { t273?: unknown; t279?: unknown }[], fileLength: number): string | null {
  let longest = 0;
  let needs = 0;
  for (const ifd of ifds) {
    const offsets = numberList(ifd.t273);
    const counts = numberList(ifd.t279);
    if (offsets.length === 0 || offsets.length !== counts.length) continue;
    for (let index = 0; index < offsets.length; index += 1) {
      const end = offsets[index] + counts[index];
      if (end > longest) {
        longest = end;
        needs = counts[index];
      }
    }
  }
  if (longest === 0 || longest <= fileLength) return null;
  return `${fileLength} byte(s) in the file, but a strip starts at ${longest - needs} and runs`
    + ` ${needs} byte(s), to ${longest}`;
}

/** The numbers in a TIFF directory entry, whether UTIF stored one or a list. */
function numberList(value: unknown): number[] {
  const list = Array.isArray(value) ? value : [value];
  return list.map((item) => Number(item)).filter((item) => Number.isFinite(item) && item >= 0);
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
