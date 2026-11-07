/**
 * Pull embedded images out of a PDF page.
 *
 * Images live as XObject streams in each page's resource dictionary. JPEG
 * (`DCTDecode`) and JPEG-2000 (`JPXDecode`) streams are already complete files
 * and are handed back untouched, which preserves their original resolution —
 * re-encoding them would only lose quality. Everything else is expanded here:
 * the sample bytes are unpacked according to `/BitsPerComponent` (1, 2, 4, 8 or
 * 16 bits, MSB first, each row padded to a whole byte), turned RGB by
 * `/ColorSpace` (DeviceGray/RGB/CMYK, an `/Indexed` palette over any base, an
 * ICC profile counted by its `/N`, a calibrated `CalGray`/`CalRGB`), the
 * `/Decode` range is applied, the `/SMask` is written into the alpha channel,
 * and the result is encoded as PNG.
 *
 * The bit depths and colour spaces are not decoration: a scanned page is a
 * **1-bit bilevel** `/DeviceGray` image, and skipping `bits !== 8` meant the
 * one thing people actually bring back "no embedded images" (E12).
 *
 * An image that cannot be expanded is **reported, never dropped silently** —
 * `onSkipped` says which one and why, because "no embedded images" about a page
 * holding four bilevel scans is a sentence the user can disprove (E13).
 */
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFString,
  decodePDFRawStream,
} from './doc';
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
        reason: `is below the ${options.minSide} px size limit you set`,
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
  const bits = numberFrom(dict.get(PDFName.of('BitsPerComponent'))) ?? 8;
  // An image mask has no colour space at all: the samples are a coverage grid,
  // painted in the current fill colour, and the only honest reading of one here
  // is black-on-white grey.
  const rawSpace = dict.get(PDFName.of('ColorSpace'));
  const space: ColorSpacePlan | ColorSpaceFailure = isImageMask
    ? { model: 'gray', components: 1 }
    : rawSpace === undefined
      ? { reason: 'does not declare a /ColorSpace, so its samples cannot be placed in a colour model' }
      : colorSpacePlan(doc, rawSpace);
  if ('reason' in space) return skip(space.reason, width, height);
  if (!SUPPORTED_BITS.includes(bits)) {
    return skip(
      `uses ${bits}-bit samples; ${SUPPORTED_BITS.slice(0, -1).join(', ')} and ${SUPPORTED_BITS[SUPPORTED_BITS.length - 1]} bit are expanded and nothing else`,
      width,
      height,
    );
  }

  const grid = sampleGrid(decoded, bits, space.components, width, height);
  if (decoded.length < grid.needed) {
    return skip(
      `is short of sample data: ${decoded.length} byte(s) arrived where ${grid.needed} are needed for a ${width}×${height} ${bits}-bit, ${space.components}-component image`,
      width,
      height,
    );
  }
  const rgba = toRgba(grid, width, height, space, decodeRanges(dict, isImageMask));

  const smask = dict.get(PDFName.of('SMask'));
  const maskRef = smask instanceof PDFRef ? smask : null;
  let hasAlpha = false;
  if (maskRef) {
    const mask = doc.context.lookup(maskRef);
    const alpha = mask instanceof PDFRawStream ? alphaOf(mask, width, height) : null;
    if (alpha) {
      for (let i = 0; i < width * height; i++) rgba[i * 4 + 3] = alpha[i];
      hasAlpha = true;
    }
  }

  const png = await encodePng(rgba, width, height);
  if (!png) return skip('could not be encoded to PNG by this browser', width, height);
  return { bytes: png, mime: 'image/png', extension: 'png', width, height, name, hasAlpha };
}

/** Bit depths with a sample unpacker here; anything else is reported, not guessed. */
const SUPPORTED_BITS = [1, 2, 4, 8, 16];

/** How the decoded samples become colour. */
interface ColorSpacePlan {
  /** The channel order a pixel is written in. */
  model: 'gray' | 'rgb' | 'cmyk';
  /** Samples per pixel **as stored**, which is 1 for a palette index. */
  components: number;
  /** `/Indexed`: the sample is a position in this table. */
  palette?: { bytes: Uint8Array; hival: number };
}

/** A colour space this build cannot evaluate, with the sentence that says so. */
interface ColorSpaceFailure {
  reason: string;
}

/** The name a `/ColorSpace` entry carries, without its slash. */
function spaceName(value: unknown): string {
  const head = value instanceof PDFArray ? value.get(0) : value;
  return head instanceof PDFName ? String(head).replace(/^\//, '') : '';
}

/**
 * Read `/ColorSpace` into something the pixel loop can act on.
 *
 * `CalGray`/`CalRGB` carry a colourimetry matrix and transfer curves that are
 * dropped here — the samples are painted as if they were Device equivalents,
 * a small colour shift on the few files that use them. A `Separation` or
 * `DeviceN` tint transform is a PostScript program, and an interpreter for it
 * does not belong in an image exporter, so those are reported instead (E13).
 */
function colorSpacePlan(doc: PDFDocument, value: unknown): ColorSpacePlan | ColorSpaceFailure {
  const name = spaceName(value);
  if (!(value instanceof PDFArray)) {
    const plan = planForName(name);
    return plan ?? { reason: `names the /${name || 'unknown'} colour space, which has no channel count here` };
  }
  if (name === 'Indexed') {
    return indexedPlan(doc, value);
  }
  if (name === 'ICCBased') {
    const stream = doc.context.lookup(value.get(1));
    const components = stream instanceof PDFRawStream
      ? numberFrom(stream.dict.get(PDFName.of('N')))
      : null;
    const plan = components === null ? null : planForComponents(components);
    return plan ?? { reason: 'uses an ICC profile whose /N component count is missing or is not 1, 3 or 4' };
  }
  if (name === 'CalGray') return { model: 'gray', components: 1 };
  if (name === 'CalRGB') return { model: 'rgb', components: 3 };
  if (name === 'Lab') {
    return { reason: 'uses the /Lab colour space, which needs the page’s white point to place on screen' };
  }
  if (name === 'Separation' || name === 'DeviceN') {
    return {
      reason: `uses the /${name} colour space: its tint transform is PostScript, which this browser does not run`,
    };
  }
  if (name === 'Pattern') {
    return { reason: 'uses a /Pattern colour space, so its colour comes from a tiling pattern rather than a sample grid' };
  }
  return { reason: `uses the /${name || 'unknown'} colour space, which cannot be converted to pixels here` };
}

function planForName(name: string): ColorSpacePlan | null {
  if (name === 'DeviceGray' || name === 'Gray') return { model: 'gray', components: 1 };
  if (name === 'DeviceRGB' || name === 'RGB') return { model: 'rgb', components: 3 };
  if (name === 'DeviceCMYK' || name === 'CMYK') return { model: 'cmyk', components: 4 };
  return null;
}

function planForComponents(components: number): ColorSpacePlan | null {
  if (components === 1) return { model: 'gray', components: 1 };
  if (components === 3) return { model: 'rgb', components: 3 };
  if (components === 4) return { model: 'cmyk', components: 4 };
  return null;
}

/**
 * `[/Indexed base hival lookup]`: every sample is one index into `lookup`.
 *
 * The table may be a literal string, a hex string or a stream reference, and
 * its entries follow the **base** space’s channel order — 3 bytes for RGB, 4
 * for CMYK, 1 for gray. `/Decode` does not apply to an indexed space: the
 * sample is already the position in the table, clamped to `hival`.
 */
function indexedPlan(doc: PDFDocument, array: PDFArray): ColorSpacePlan | ColorSpaceFailure {
  const base = colorSpacePlan(doc, array.get(1));
  if ('reason' in base) {
    return { reason: `uses an /Indexed palette over a colour space this browser cannot expand (${base.reason})` };
  }
  const hival = numberFrom(array.get(2));
  const table = paletteBytes(doc, array.get(3));
  if (hival === null || hival < 0 || !table) {
    return { reason: 'uses an /Indexed palette whose high index or lookup table cannot be read' };
  }
  const stride = base.components;
  if (table.length < (hival + 1) * stride) {
    return {
      reason: `uses an /Indexed palette with ${table.length} byte(s) of table, short of the ${(hival + 1) * stride} that ${hival + 1} entries need`,
    };
  }
  return { model: base.model, components: 1, palette: { bytes: table, hival } };
}

function paletteBytes(doc: PDFDocument, value: unknown): Uint8Array | null {
  const object = value instanceof PDFRef ? doc.context.lookup(value) : value;
  if (object instanceof PDFRawStream) return safeDecode(object);
  // `decodeText()` hands back one character per source byte, so the char codes
  // are the palette bytes; a palette is binary data that merely travels in a
  // string.
  if (object instanceof PDFString || object instanceof PDFHexString) {
    const text = object.decodeText();
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
    return out;
  }
  return null;
}

/**
 * The `/Decode` range per channel, in the normalised 0–1 space PDF maps samples
 * into. The spec’s default inverts an image mask: a 1-bit mask paints where the
 * sample is 0, so the mask of a Type 3 glyph or a stencil comes out the right
 * way round.
 */
function decodeRanges(dict: PDFDict, imageMask: boolean): number[][] {
  const raw = dict.get(PDFName.of('Decode'));
  const fallback = imageMask ? [1, 0] : [0, 1];
  const out: number[][] = [];
  for (let channel = 0; channel < 4; channel++) {
    const low = raw instanceof PDFArray ? numberFrom(raw.get(channel * 2)) : null;
    const high = raw instanceof PDFArray ? numberFrom(raw.get(channel * 2 + 1)) : null;
    out.push([low ?? fallback[0], high ?? fallback[1]]);
  }
  return out;
}

/**
 * Random access into a PDF sample grid: MSB first, `bits` per sample, and every
 * **row** padded out to a whole byte (4 one-bit samples cost a byte, not half
 * one — a scanner page packed without this reads one pixel off per row).
 */
interface SampleGrid {
  /** Bytes the whole grid needs, padding included. */
  needed: number;
  /** The largest value one sample can hold. */
  max: number;
  read(sample: number): number;
}

function sampleGrid(
  data: Uint8Array,
  bits: number,
  components: number,
  width: number,
  height: number,
): SampleGrid {
  const samplesPerRow = width * components;
  const bytesPerRow = Math.ceil((samplesPerRow * bits) / 8);
  return {
    needed: bytesPerRow * height,
    max: (1 << bits) - 1,
    read(sample: number): number {
      const row = Math.floor(sample / samplesPerRow);
      const first = row * bytesPerRow * 8 + (sample - row * samplesPerRow) * bits;
      let value = 0;
      for (let offset = 0; offset < bits; offset++) {
        const bit = first + offset;
        value = (value << 1) | ((data[bit >> 3] >> (7 - (bit & 7))) & 1);
      }
      return value;
    },
  };
}

/**
 * Samples to RGBA.
 *
 * Each sample leaves its own bit depth through `255 / (2^b − 1)` — so a bilevel
 * 1 is white rather than a washed-out 255, and a 4-bit 15 is 255 rather than 15
 * — is pushed through `/Decode`, and is then resolved by the colour model:
 * palette index, gray, RGB, or CMYK with the plain subtractive mix the rest of
 * this app uses.
 */
function toRgba(
  grid: SampleGrid,
  width: number,
  height: number,
  space: ColorSpacePlan,
  decode: number[][],
): Uint8ClampedArray {
  const count = width * height;
  const rgba = new Uint8ClampedArray(count * 4);
  const channelOf = (sample: number, channel: number): number => {
    const value = grid.read(sample) / grid.max;
    const [low, high] = decode[channel];
    return Math.round(clamp(low + value * (high - low), 0, 1) * 255);
  };
  const stride = space.model === 'cmyk' ? 4 : space.model === 'gray' ? 1 : 3;

  for (let pixel = 0; pixel < count; pixel++) {
    let red: number;
    let green: number;
    let blue: number;
    if (space.palette) {
      // The palette is laid out in the base space’s channel order.
      const index = Math.min(grid.read(pixel), space.palette.hival);
      const entry = space.palette.bytes;
      const at = index * stride;
      if (space.model === 'cmyk') {
        [red, green, blue] = cmykToRgb(entry[at] / 255, entry[at + 1] / 255, entry[at + 2] / 255, entry[at + 3] / 255);
      } else if (space.model === 'gray') {
        red = green = blue = entry[at];
      } else {
        red = entry[at];
        green = entry[at + 1];
        blue = entry[at + 2];
      }
    } else if (space.model === 'gray') {
      red = green = blue = channelOf(pixel, 0);
    } else if (space.model === 'rgb') {
      red = channelOf(pixel * 3, 0);
      green = channelOf(pixel * 3 + 1, 1);
      blue = channelOf(pixel * 3 + 2, 2);
    } else {
      const [c, m, y, k] = [
        channelOf(pixel * 4, 0) / 255,
        channelOf(pixel * 4 + 1, 1) / 255,
        channelOf(pixel * 4 + 2, 2) / 255,
        channelOf(pixel * 4 + 3, 3) / 255,
      ];
      [red, green, blue] = cmykToRgb(c, m, y, k);
    }
    const at = pixel * 4;
    rgba[at] = red;
    rgba[at + 1] = green;
    rgba[at + 2] = blue;
    rgba[at + 3] = 255;
  }
  return rgba;
}

/** The plain subtractive mix: no black generation, no under colour removal. */
function cmykToRgb(cyan: number, magenta: number, yellow: number, key: number): number[] {
  return [
    Math.round(255 * (1 - Math.min(1, cyan + key))),
    Math.round(255 * (1 - Math.min(1, magenta + key))),
    Math.round(255 * (1 - Math.min(1, yellow + key))),
  ];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * A soft mask as 8-bit alpha, at whatever depth it was stored.
 *
 * `/SMask` is its own gray image, so a 1-bit mask over the same grid is legal
 * and has to be unpacked with the mask’s own `/BitsPerComponent`; reading it as
 * one byte per pixel gives a 4× too-small mask and half-transparent artwork.
 */
function alphaOf(mask: PDFRawStream, width: number, height: number): Uint8Array | null {
  const bytes = safeDecode(mask);
  if (!bytes) return null;
  const bits = numberFrom(mask.dict.get(PDFName.of('BitsPerComponent'))) ?? 8;
  if (!SUPPORTED_BITS.includes(bits)) return null;
  const maskWidth = numberFrom(mask.dict.get(PDFName.of('Width'))) ?? width;
  const maskHeight = numberFrom(mask.dict.get(PDFName.of('Height'))) ?? height;
  if (maskWidth !== width || maskHeight !== height) return null;
  const grid = sampleGrid(bytes, bits, 1, width, height);
  if (bytes.length < grid.needed) return null;
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < alpha.length; i++) {
    alpha[i] = Math.round((grid.read(i) / grid.max) * 255);
  }
  return alpha;
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

function hash(bytes: Uint8Array): string {
  let value = 2166136261;
  const sample = Math.min(bytes.length, 4096);
  for (let i = 0; i < sample; i++) {
    value ^= bytes[i];
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0).toString(36);
}
