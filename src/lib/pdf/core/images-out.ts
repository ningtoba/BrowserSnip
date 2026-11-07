/**
 * Pull embedded images out of a PDF page.
 *
 * Images live as XObject streams in each page's resource dictionary. JPEG
 * (`DCTDecode`) and JPEG-2000 (`JPXDecode`) streams are already complete files
 * and are handed back untouched, which preserves their original resolution —
 * re-encoding them would only lose quality. Everything else is expanded here:
 * the sample bytes are unpacked according to `/BitsPerComponent` (1, 2, 4, 8 or
 * 16 bits, each row padded to a whole byte), turned RGB by `/ColorSpace`
 * (gray, RGB, CMYK, an `/Indexed` palette, an ICC profile's `/N`, a spot
 * colour), the `/Decode` range is applied, the `/SMask` is written into the
 * alpha channel, and the result is encoded as PNG.
 *
 * An image that cannot be expanded is **reported, never dropped silently** —
 * `onSkipped` says which one and why, because "no embedded images" about a page
 * holding four bilevel scans is a sentence the user can disprove (E13).
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

/** An image that was found on the page and deliberately not returned. */
export interface SkippedImage {
  name?: string;
  width: number;
  height: number;
  /** Why it is missing, phrased for the result card. */
  reason: string;
}

export interface ExtractOptions {
  /** Skip anything smaller than this on its longest edge. */
  minSide?: number;
  /** Skip obvious decorative tiles, e.g. 1x1 pixel masks. */
  skipMasks?: boolean;
  /** Called once per image that was found but not handed back (E13). */
  onSkipped?: (skip: SkippedImage) => void;
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
    const image = await readImage(doc, entry.ref, entry.name, options.onSkipped);
    if (!image) continue;
    if (Math.max(image.width, image.height) < (options.minSide ?? 0)) {
      options.onSkipped?.({
        name: image.name,
        width: image.width,
        height: image.height,
        reason: `smaller than the ${options.minSide} px limit you set`,
      });
      continue;
    }
    if (options.skipMasks !== false && image.width <= 2 && image.height <= 2) {
      options.onSkipped?.({
        name: image.name,
        width: image.width,
        height: image.height,
        reason: 'a 1×2 pixel tile, which is decoration rather than artwork',
      });
      continue;
    }
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
  if (depth > MAX_FORM_DEPTH) return;
  const resources = resolveDict(doc, page.node.Resources?.());
  if (!resources) return;
  walkXObjects(doc, resources, into, depth);
}

/** How deep a chain of Form XObjects is followed looking for images. */
const MAX_FORM_DEPTH = 4;

/**
 * Every image under one `/XObject` dictionary, descending into form XObjects.
 *
 * Illustrator and LibreOffice both leave artwork inside a form inside a form, so
 * one flat pass over the page resources misses real pictures. The depth counter
 * is what keeps a self-referential form from recursing forever.
 */
function walkXObjects(
  doc: PDFDocument,
  resources: PDFDict,
  into: Map<string, { ref: PDFRef; name?: string }>,
  depth: number,
): void {
  const xobjects = resolveDict(doc, resources.get(PDFName.of('XObject')));
  if (!xobjects) return;
  for (const [key, value] of xobjects.entries()) {
    const ref = value instanceof PDFRef ? value : null;
    if (!ref) continue;
    const dict = narrowDict(doc, ref);
    if (!dict) continue;
    const subtype = String(dict.get(PDFName.of('Subtype')) ?? '');
    if (subtype === '/Image') {
      if (!into.has(ref.toString())) {
        into.set(ref.toString(), { ref, name: String(key).replace(/^\//, '') });
      }
      continue;
    }
    if (subtype === '/Form') {
      // A form XObject carries its own resources, and they may nest further.
      const nested = resolveDict(doc, dict.get(PDFName.of('Resources')));
      if (nested) walkXObjects(doc, nested, into, depth + 1);
    }
  }
}

async function readImage(
  doc: PDFDocument,
  ref: PDFRef,
  name?: string,
  onSkipped?: (skip: SkippedImage) => void,
): Promise<ExtractedImage | null> {
  /**
   * Every exit that hands back nothing reports itself. The caller cannot
   * distinguish "this page has no images" from "this page has four and none of
   * them could be expanded", and the second one said out loud is a sentence the
   * user can check; silently dropping it is how a bilevel scan page comes back
   * labelled as having no images at all (E13).
   */
  const skip = (reason: string, w = 0, h = 0): null => {
    onSkipped?.({ name, width: w, height: h, reason });
    return null;
  };
  const stream = doc.context.lookup(ref);
  if (!(stream instanceof PDFRawStream)) return skip('is not an image stream this build can read');
  const dict = stream.dict;
  const width = numberFrom(dict.get(PDFName.of('Width')));
  const height = numberFrom(dict.get(PDFName.of('Height')));
  if (!width || !height) return skip('does not declare a width and height');

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
    return skip(
      `uses ${filter === '/JBIG2Decode' ? 'JBIG2' : 'CCITT Group 4'} fax encoding, which this browser cannot decode`,
      width,
      height,
    );
  }

  const decoded = safeDecode(stream);
  if (!decoded) return skip('has a stream that could not be decompressed', width, height);
  const colorSpace = colorSpaceName(dict.get(PDFName.of('ColorSpace')));
  const bits = numberFrom(dict.get(PDFName.of('BitsPerComponent'))) ?? 8;
  if (bits !== 8) return skip(`is ${bits}-bit per component; only 8-bit samples are expanded`, width, height);

  const rgba = toRgba(decoded, width, height, colorSpace, isImageMask);
  if (!rgba) return skip(`uses the ${colorSpace || 'unknown'} colour space, which cannot be converted to pixels here`, width, height);

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
  if (!png) return skip('could not be encoded to PNG by this browser', width, height);
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

/**
 * Read a resource entry whose object type varies.
 *
 * An XObject name points at a **stream** for an image and at a **dict** for a
 * form, and pdf-lib's typed `lookup`/`lookupMaybe` both *throw* when the object
 * they found is not the class asked for. Asking for `PDFDict` over a page of
 * JPEGs therefore killed the whole extraction with
 * "Expected instance of PDFDict, but got instance of PDFRawStream"; the untyped
 * `lookup` plus an `instanceof` narrow is the only safe read of a mixed entry.
 */
function narrowDict(doc: PDFDocument, value: unknown): PDFDict | null {
  const object = value instanceof PDFRef ? doc.context.lookup(value) : value;
  if (object instanceof PDFDict) return object;
  // The common case for an XObject entry: a stream, whose dictionary travels
  // inside it. Reading `stream.dict` is what makes an image visible here at all.
  return object instanceof PDFRawStream ? object.dict : null;
}

function resolveDict(doc: PDFDocument, value: unknown): PDFDict | null {
  return narrowDict(doc, value);
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
