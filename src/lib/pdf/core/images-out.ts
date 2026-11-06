/**
 * Pull embedded images out of a PDF page.
 *
 * Images live as XObject streams in each page's resource dictionary. JPEG
 * (`DCTDecode`) and JPEG-2000 (`JPXDecode`) streams are already complete files
 * and are handed back untouched, which preserves their original resolution —
 * re-encoding them would only lose quality. Raw and Flate-compressed sample
 * data is expanded according to its colour space and written as PNG.
 */
import { PDFArray, PDFDict, PDFName, PDFRawStream, PDFRef, decodePDFRawStream } from './doc';
import type { PDFDocument, PDFPage } from './doc';

export interface ExtractedImage {
  bytes: Uint8Array;
  mime: string;
  extension: string;
  width: number;
  height: number;
  /** The resource name it was drawn under, when known. */
  name?: string;
  /** Soft mask (transparency) bytes, kept separate so PNG output can apply it. */
  hasAlpha: boolean;
}

export interface ExtractOptions {
  /** Skip anything smaller than this on its longest edge. */
  minSide?: number;
  /** Skip obvious decorative tiles, e.g. 1x1 pixel masks. */
  skipMasks?: boolean;
}

/** Every image XObject reachable from a page, de-duplicated by object id. */
export async function extractPageImages(
  doc: PDFDocument,
  pageNumber: number,
  options: ExtractOptions = {},
): Promise<ExtractedImage[]> {
  const page = doc.getPage(pageNumber - 1);
  const found = new Map<string, { ref: PDFRef; name?: string }>();
  collectImageRefs(doc, page, found, 0);

  const out: ExtractedImage[] = [];
  for (const [, entry] of found) {
    const image = await readImage(doc, entry.ref, entry.name);
    if (!image) continue;
    if (Math.max(image.width, image.height) < (options.minSide ?? 0)) continue;
    if (options.skipMasks !== false && image.width <= 2 && image.height <= 2) continue;
    out.push(image);
  }
  return out;
}

/** Same, across every page, keeping the first occurrence of each object. */
export async function extractAllImages(
  doc: PDFDocument,
  options: ExtractOptions = {},
): Promise<{ image: ExtractedImage; page: number }[]> {
  const seen = new Set<string>();
  const out: { image: ExtractedImage; page: number }[] = [];
  for (let page = 1; page <= doc.getPageCount(); page++) {
    const images = await extractPageImages(doc, page, options);
    for (const image of images) {
      const key = `${image.width}x${image.height}:${image.bytes.length}:${hash(image.bytes)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ image, page });
    }
  }
  return out;
}

function collectImageRefs(
  doc: PDFDocument,
  page: PDFPage,
  into: Map<string, { ref: PDFRef; name?: string }>,
  depth: number,
): void {
  if (depth > 2) return;
  const resources = resolveDict(doc, page.node.Resources?.());
  if (!resources) return;
  const xobjects = resolveDict(doc, resources.get(PDFName.of('XObject')));
  if (!xobjects) return;
  for (const [key, value] of xobjects.entries()) {
    const ref = value instanceof PDFRef ? value : null;
    if (!ref) continue;
    const dict = doc.context.lookup(ref, PDFDict);
    if (!dict) continue;
    const subtype = String(dict.get(PDFName.of('Subtype')) ?? '');
    if (subtype === '/Image') {
      if (!into.has(ref.toString())) {
        into.set(ref.toString(), { ref, name: String(key).replace(/^\//, '') });
      }
      continue;
    }
    if (subtype === '/Form') {
      // Form XObjects can nest their own resources with images inside.
      const nested = resolveDict(doc, dict.get(PDFName.of('Resources')));
      if (!nested) continue;
      const nestedXobjects = resolveDict(doc, nested.get(PDFName.of('XObject')));
      if (!nestedXobjects) continue;
      for (const [, item] of nestedXobjects.entries()) {
        const nestedRef = item instanceof PDFRef ? item : null;
        if (!nestedRef) continue;
        const nestedDict = doc.context.lookup(nestedRef, PDFDict);
        if (nestedDict && String(nestedDict.get(PDFName.of('Subtype'))) === '/Image') {
          if (!into.has(nestedRef.toString())) into.set(nestedRef.toString(), { ref: nestedRef });
        }
      }
    }
  }
}

async function readImage(
  doc: PDFDocument,
  ref: PDFRef,
  name?: string,
): Promise<ExtractedImage | null> {
  const stream = doc.context.lookup(ref);
  if (!(stream instanceof PDFRawStream)) return null;
  const dict = stream.dict;
  const width = numberFrom(dict.get(PDFName.of('Width')));
  const height = numberFrom(dict.get(PDFName.of('Height')));
  if (!width || !height) return null;

  const filter = String(dict.get(PDFName.of('Filter')) ?? '');
  const isImageMask = String(dict.get(PDFName.of('ImageMask')) ?? '') === 'true';

  // Native containers are returned verbatim: no decode, no re-encode.
  if (filter === '/DCTDecode' && !isImageMask) {
    return {
      bytes: streamBytes(stream),
      mime: 'image/jpeg',
      extension: 'jpg',
      width,
      height,
      name,
      hasAlpha: false,
    };
  }
  if (filter === '/JPXDecode' && !isImageMask) {
    return {
      bytes: streamBytes(stream),
      mime: 'image/jp2',
      extension: 'jp2',
      width,
      height,
      name,
      hasAlpha: false,
    };
  }
  if (filter === '/CCITTFaxDecode' || filter === '/JBIG2Decode') {
    // Fax encodings need a dedicated decoder to turn into RGBA.
    return null;
  }

  const decoded = safeDecode(stream);
  if (!decoded) return null;
  const colorSpace = colorSpaceName(dict.get(PDFName.of('ColorSpace')));
  const bits = numberFrom(dict.get(PDFName.of('BitsPerComponent'))) ?? 8;
  if (bits !== 8) return null;

  const rgba = toRgba(decoded, width, height, colorSpace, isImageMask);
  if (!rgba) return null;

  const smask = dict.get(PDFName.of('SMask'));
  const maskRef = smask instanceof PDFRef ? smask : null;
  let hasAlpha = false;
  if (maskRef) {
    const mask = doc.context.lookup(maskRef);
    const maskBytes = mask instanceof PDFRawStream ? safeDecode(mask) : null;
    if (maskBytes && maskBytes.length >= width * height) {
      for (let i = 0; i < width * height; i++) rgba[i * 4 + 3] = maskBytes[i];
      hasAlpha = true;
    }
  }

  const png = await encodePng(rgba, width, height);
  if (!png) return null;
  return { bytes: png, mime: 'image/png', extension: 'png', width, height, name, hasAlpha };
}

function toRgba(
  data: Uint8Array,
  width: number,
  height: number,
  colorSpace: string,
  imageMask: boolean,
): Uint8ClampedArray | null {
  const count = width * height;
  const rgba = new Uint8ClampedArray(count * 4);
  if (imageMask || colorSpace === 'DeviceGray') {
    if (data.length < count) return null;
    for (let i = 0; i < count; i++) {
      const grey = imageMask ? 255 - data[i] : data[i];
      rgba[i * 4] = grey;
      rgba[i * 4 + 1] = grey;
      rgba[i * 4 + 2] = grey;
      rgba[i * 4 + 3] = 255;
    }
    return rgba;
  }
  if (colorSpace === 'DeviceCMYK') {
    if (data.length < count * 4) return null;
    for (let i = 0; i < count; i++) {
      const c = data[i * 4] / 255;
      const m = data[i * 4 + 1] / 255;
      const y = data[i * 4 + 2] / 255;
      const k = data[i * 4 + 3] / 255;
      rgba[i * 4] = Math.round(255 * (1 - Math.min(1, c + k)));
      rgba[i * 4 + 1] = Math.round(255 * (1 - Math.min(1, m + k)));
      rgba[i * 4 + 2] = Math.round(255 * (1 - Math.min(1, y + k)));
      rgba[i * 4 + 3] = 255;
    }
    return rgba;
  }
  if (data.length < count * 3) return null;
  for (let i = 0; i < count; i++) {
    rgba[i * 4] = data[i * 3];
    rgba[i * 4 + 1] = data[i * 3 + 1];
    rgba[i * 4 + 2] = data[i * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

let pngEncoder: ImageBitmap | null = null;
void pngEncoder;

async function encodePng(rgba: Uint8ClampedArray, width: number, height: number): Promise<Uint8Array | null> {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
}

function safeDecode(stream: PDFRawStream): Uint8Array | null {
  try {
    const decoded = decodePDFRawStream(stream);
    const bytes = decoded?.decode?.();
    if (!bytes) return null;
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayLike<number>);
  } catch {
    return null;
  }
}

function streamBytes(stream: PDFRawStream): Uint8Array {
  return stream.contents instanceof Uint8Array
    ? stream.contents
    : new Uint8Array(stream.contents as ArrayLike<number>);
}

function resolveDict(doc: PDFDocument, value: unknown): PDFDict | null {
  if (value instanceof PDFDict) return value;
  if (value instanceof PDFRef) return doc.context.lookup(value, PDFDict) ?? null;
  return null;
}

function numberFrom(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const parsed = Number(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function colorSpaceName(value: unknown): string {
  if (value instanceof PDFArray) {
    const head = value.get(0);
    return String(head ?? '').replace(/^\//, '') === 'Indexed' ? 'Indexed' : String(head ?? '').replace(/^\//, '');
  }
  return String(value ?? '/DeviceRGB').replace(/^\//, '');
}

function hash(bytes: Uint8Array): string {
  let value = 2166136261;
  const sample = Math.min(bytes.length, 4096);
  for (let i = 0; i < sample; i++) {
    value ^= bytes[i];
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0).toString(36);
}
