/**
 * Real PDF compression.
 *
 * The previous implementation re-encoded every image as DeviceRGB JPEG, which
 * threw away `/SMask` transparency, flattened indexed and CMYK colour spaces,
 * and re-encoded lossy data on every run. This version keeps each image's own
 * colour space and soft mask, only touches images that are actually larger
 * than they need to be, and guarantees it never returns a file bigger than the
 * input — the property BentoPDF advertises for its own engine.
 *
 * Three paths that looked like this and were not: re-encoding wrote PNG bytes
 * under a `/FlateDecode` filter (a PNG container is not a deflate stream of
 * samples, and PDF images have no alpha channel to put it in); downsampling used
 * `putImageData`, which copies pixels without resampling — so a scan asked for at
 * 150 dpi came back as the top-left quarter of itself; and `collectImages` asked
 * whether an XObject `instanceof PDFDict`, which an image *stream* is not, so it
 * found no image in any file and every "N image(s) re-encoded" claim this module
 * prints was vacuous. The first two live in `recompressImage`; all three are
 * measured in `tests/pdf/optimize-bytes.test.ts`, where the numbers come out of
 * the bytes rather than out of the report.
 *
 * Artwork inside a Form XObject is collected too: `collectImages` descends into
 * `/Subtype /Form` entries (de-duplicated by reference, bounded by
 * `MAX_FORM_DEPTH`) and `measurePlacements` carries each form's `/BBox` and
 * `/Matrix` into the effective-size calculation, because that is the shape of an
 * InDesign or Illustrator export and of every page the merge path borrows. An
 * image under artwork whose placement could not be measured is re-encoded but
 * never downsampled, and the report names it instead of claiming a resolution cap
 * it did not apply.
 */
import { PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFArray, PDFStream } from './doc';
import type { PDFDocument } from './doc';
import { openPDF, savePDF, toBytes } from './doc';
import { pageContentOps, parseContentStream, streamBytes } from './content';
import type { ContentOp } from './content';
import { canvasContext2d } from './raster';
import { formatBytes } from '@/lib/utils/format';

export type CompressionPreset = 'lossless' | 'light' | 'balanced' | 'strong' | 'extreme';

export interface CompressOptions {
  preset?: CompressionPreset;
  /** Override the preset's JPEG quality (0.05–0.99). */
  jpegQuality?: number;
  /** Downsample images whose effective DPI exceeds this. */
  maxDpi?: number;
  /** Keep alpha soft masks. Turning this off saves more but can black out logos. */
  keepTransparency?: boolean;
  /** Rewrite colour images as 8-bit greyscale. */
  grayscale?: boolean;
  /** Drop XMP metadata and the /Info dictionary. */
  stripMetadata?: boolean;
  /** Stop as soon as the output is at or under this many bytes. */
  targetBytes?: number;
  onProgress?: (fraction: number, message?: string) => void;
  signal?: AbortSignal;
}

export interface ImageCompressResult {
  total: number;
  replaced: number;
  skipped: number;
  /** Bytes saved by image re-encoding before object-stream compression. */
  savedBytes: number;
  /** Images that could not be decoded by this browser. */
  undecodable: number;
  /**
   * Images whose placement on the page could not be measured — artwork inside a
   * Form XObject the walk could not follow, mostly. They are still re-encoded,
   * but never downsampled, so the dpi cap in this report does not describe them.
   */
  unmeasured: number;
}

export interface CompressReport {
  before: number;
  /** Size of the bytes the caller gets back — the input again when it was kept. */
  after: number;
  /**
   * Size the rebuild itself produced, kept even when `bytes` is the untouched
   * input because the rebuild was the larger of the two (B2 item 2). Without it
   * a tool can only say "the original came back", never the honest delta E14
   * asks for, and "compressed" would be a lie over a file that grew.
   */
  rebuildBytes: number;
  preset: CompressionPreset;
  appliedQuality: number;
  appliedDpi: number;
  images: ImageCompressResult;
  textPreserved: boolean;
  metadataStripped: boolean;
  notes: string[];
}

interface PresetSettings {
  quality: number;
  dpi: number;
  resample: boolean;
  description: string;
}

export const COMPRESSION_PRESETS: Record<CompressionPreset, PresetSettings> = {
  lossless: {
    quality: 0.99,
    dpi: 1000,
    resample: false,
    description: 'Rebuild the file structure only. Text and every pixel stay identical.',
  },
  light: {
    quality: 0.82,
    dpi: 220,
    resample: true,
    description: 'Near-indistinguishable on screen. Best for documents you will print.',
  },
  balanced: {
    quality: 0.65,
    dpi: 150,
    resample: true,
    description: 'The usual choice for email and web upload.',
  },
  strong: {
    quality: 0.45,
    dpi: 110,
    resample: true,
    description: 'Visible softening in detailed photos, fine for scans and text.',
  },
  extreme: {
    quality: 0.28,
    dpi: 72,
    resample: true,
    description: 'Smallest possible. Only suitable for preview or archival thumbnails.',
  },
};

/** Ladder used when the user asks for a specific target size. */
const TARGET_LADDER: CompressionPreset[] = ['lossless', 'light', 'balanced', 'strong', 'extreme'];

export interface CompressInput {
  bytes: Uint8Array;
  password?: string;
}

export async function compressPDF(
  input: CompressInput,
  options: CompressOptions = {},
): Promise<{ bytes: Uint8Array; report: CompressReport; pages: number }> {
  const requested = options.preset ?? 'balanced';
  if (options.targetBytes) {
    return compressToTarget(input, options);
  }
  const settings = COMPRESSION_PRESETS[requested];
  return runCompression(input, options, requested, {
    quality: options.jpegQuality ?? settings.quality,
    dpi: options.maxDpi ?? settings.dpi,
    resample: settings.resample,
  });
}

async function runCompression(
  input: CompressInput,
  options: CompressOptions,
  preset: CompressionPreset,
  settings: { quality: number; dpi: number; resample: boolean },
): Promise<{ bytes: Uint8Array; report: CompressReport; pages: number }> {
  const source = toBytes(input.bytes);
  const doc = await openPDF(source, { password: input.password, ignoreEncryption: true });
  /**
   * Read here, while the document is open, because the caller only ever gets
   * bytes back and the result screen asks how many pages came out (E20). It is
   * the source's page count even when the rebuild is discarded below — the
   * untouched original and the rebuild describe the same document.
   */
  const pages = doc.getPageCount();
  const notes: string[] = [];

  const found = await collectImages(doc);
  const images = found.images;
  // An image under artwork the placement walk could not follow has no honest
  // box to measure against, so it is re-encoded but never downsampled: see
  // `ImageRef.unmeasuredReason`.
  const unmeasured = images.filter((image) => image.unmeasuredReason !== null);
  options.onProgress?.(0.05, `Found ${images.length} image${images.length === 1 ? '' : 's'}`);
  const result: ImageCompressResult = {
    total: images.length,
    replaced: 0,
    skipped: 0,
    savedBytes: 0,
    undecodable: 0,
    unmeasured: unmeasured.length,
  };

  // A browser with no 2D canvas cannot decode or re-encode a picture at all.
  // Asking it 200 times produced 200 failures and a report that read as though
  // the images had simply refused to shrink (E14, and E20 for the platform
  // rather than for an engine).
  const raster = settings.resample || settings.quality < 0.95;
  const canRasterise = images.length === 0 || !raster || canDrawImages();
  if (raster && !canRasterise) {
    result.skipped = images.length;
    notes.push(
      images.length === 1
        ? 'This browser cannot re-encode images, so its one image stays byte-for-byte as it is; only the file structure was rebuilt.'
        : `This browser cannot re-encode images, so all ${images.length} images stay byte-for-byte as they are; only the file structure was rebuilt.`,
    );
  }
  if (raster && canRasterise) {
    for (let i = 0; i < images.length; i++) {
      if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const image = images[i];
      const outcome = await recompressImage(doc, image, settings, options);
      if (outcome === 'undecodable') result.undecodable += 1;
      else if (outcome === 'skipped') result.skipped += 1;
      else {
        result.replaced += 1;
        result.savedBytes += outcome;
      }
      options.onProgress?.(0.05 + (0.85 * (i + 1)) / images.length, `Re-encoded image ${i + 1} of ${images.length}`);
    }
  }

  if (options.grayscale) {
    // Only claim the pixels changed if something actually reached a canvas:
    // lossless mode re-encodes nothing, and a browser without a 2D context
    // re-encodes nothing either, but both used to report a greyscale pass.
    notes.push(
      result.replaced > 0
        ? `${result.replaced} image${result.replaced === 1 ? '' : 's'} re-encoded as greyscale.`
        : 'Greyscale was asked for, but no image was re-encoded, so every colour in the file is unchanged.',
    );
  }
  if (options.stripMetadata) {
    stripDocumentMetadata(doc);
    notes.push('Removed the /Info dictionary and XMP metadata.');
  }
  if (result.undecodable > 0) {
    notes.push(
      `${result.undecodable} image${result.undecodable === 1 ? '' : 's'} use a format this browser cannot decode, so they were left untouched.`,
    );
  }
  // Only say this when a dpi cap was actually in play: lossless mode downsamples
  // nothing, so a "it kept its resolution" note there would report a decision
  // that was never made.
  if (settings.resample && unmeasured.length > 0) {
    notes.push(unmeasuredNote(unmeasured));
  }
  if (found.unvisited.size > 0) {
    notes.push(unvisitedNote(found.unvisited));
  }
  if (!settings.resample) {
    notes.push('Lossless mode: no image was resampled or re-encoded.');
  }
  const bytes = await savePDF(doc, { useObjectStreams: true });
  options.onProgress?.(1, 'Writing the compressed file');

  const report: CompressReport = {
    before: source.byteLength,
    after: bytes.byteLength,
    rebuildBytes: bytes.byteLength,
    preset,
    appliedQuality: settings.quality,
    appliedDpi: settings.dpi,
    images: result,
    textPreserved: true,
    metadataStripped: options.stripMetadata ?? false,
    notes,
  };

  // Never hand back something bigger than the input.
  if (bytes.byteLength >= source.byteLength) {
    const grew = bytes.byteLength > source.byteLength;
    report.notes.unshift(
      `The rebuild measured ${formatBytes(bytes.byteLength)} against the original ${formatBytes(source.byteLength)}, so ${grew ? 'it was larger' : 'it saved nothing'} and the original was returned unchanged.`,
    );
    report.after = source.byteLength;
    return { bytes: source, report, pages };
  }
  return { bytes, report, pages };
}

async function compressToTarget(
  input: CompressInput,
  options: CompressOptions,
): Promise<{ bytes: Uint8Array; report: CompressReport; pages: number }> {
  const target = options.targetBytes ?? 0;
  let best: { bytes: Uint8Array; report: CompressReport; pages: number } | null = null;
  for (let i = 0; i < TARGET_LADDER.length; i++) {
    const preset = TARGET_LADDER[i];
    const attempt = await runCompression(input, options, preset, {
      quality: COMPRESSION_PRESETS[preset].quality,
      dpi: COMPRESSION_PRESETS[preset].dpi,
      resample: COMPRESSION_PRESETS[preset].resample,
    });
    // The *closest* attempt, not simply the last one. A harder rung can come back
    // larger — a masked logo that only survives as PNG, an image that stops being
    // worth re-encoding — and the tool promises to "stop with the closest attempt
    // when it cannot", so handing back rung five because it ran last would be a
    // claim about the loop rather than about the bytes (E14).
    if (!best || attempt.bytes.byteLength < best.bytes.byteLength) best = attempt;
    options.onProgress?.((i + 1) / TARGET_LADDER.length, `${preset} preset → ${(attempt.bytes.byteLength / 1024 / 1024).toFixed(1)} MB`);
    if (attempt.bytes.byteLength <= target) {
      attempt.report.notes.unshift(
        `Reached the ${(target / 1024 / 1024).toFixed(1)} MB target at the "${preset}" preset.`,
      );
      return attempt;
    }
  }
  if (!best) throw new Error('Compression produced no result.');
  best.report.notes.unshift(
    `${(best.bytes.byteLength / 1024 / 1024).toFixed(1)} MB is the smallest achievable without rasterising the text. Rasterising the pages would get closer to the target but the text would stop being selectable.`,
  );
  return best;
}

// ── image discovery ─────────────────────────────────────────────────────────

/**
 * How many levels of Form XObject the two walks below descend.
 *
 * The per-path `visiting` set is what stops a reference cycle spinning: a form
 * can never appear twice on one path, so termination does not depend on this
 * number. What the bound caps is *work* — a form drawn five times is walked five
 * times, because each placement has to be measured to find the widest one — and
 * it fixes "how deep do we look" at the same value `core/redact.ts` walks to, so
 * a picture that redaction can reach is a picture compression can reach too.
 */
const MAX_FORM_DEPTH = 6;

interface ImageRef {
  ref: PDFRef;
  dict: PDFDict;
  /** Name its resource dictionary knows it by, so a note can name it back. */
  name: string;
  /** Widest the image is ever displayed, in points — used for effective DPI. */
  displayWidth: number;
  displayHeight: number;
  /**
   * Why the placement could not be measured, or `null` when every placement of
   * it was. An image under artwork the walk could not follow is re-encoded —
   * replacing the stream cannot change how the page is laid out — but never
   * downsampled: a box nobody measured is a box that could have been guessed too
   * small, and resizing on that guess would change the page's appearance while
   * the report claimed a resolution cap it had not applied.
   */
  unmeasuredReason: string | null;
}

interface Discovered {
  images: ImageRef[];
  /** Forms whose contents were never opened: resource name → what stopped it. */
  unvisited: Map<string, string>;
}

/**
 * Every image in the document, page-level and nested, de-duplicated by reference
 * so a logo used on 200 pages — or a form drawn five times — is re-encoded once.
 *
 * Images are found by walking `/Resources /XObject` recursively: a picture inside
 * a Form XObject is the normal shape of an InDesign or Illustrator export, and of
 * every page brought in through the merge path. Their display boxes come from
 * `measurePlacements`, not from `/Width`: effective resolution is pixels over the
 * size on the page, and reading the pixel width back out again made every image
 * exactly 72 dpi — so "maximum image resolution" never downsampled anything, and
 * a 300 dpi scan stayed a 300 dpi scan while the report said the cap had run.
 */
async function collectImages(doc: PDFDocument): Promise<Discovered> {
  const placements = measurePlacements(doc);
  const byRef = new Map<string, ImageRef>();
  const unvisited = new Map<string, string>();
  doc.getPages().forEach((page, index) => {
    const xobjects = xObjectsOf(doc, readDict(page.node.Resources?.(), doc));
    if (!xobjects) return;
    discoverImages(
      doc,
      xobjects,
      placements,
      byRef,
      unvisited,
      0,
      new Set<string>(),
      placements.unreadablePages.get(index) ?? null,
    );
  });
  return { images: [...byRef.values()], unvisited };
}

function discoverImages(
  doc: PDFDocument,
  xobjects: PDFDict,
  placements: Placements,
  into: Map<string, ImageRef>,
  unvisited: Map<string, string>,
  depth: number,
  visiting: Set<string>,
  reason: string | null,
): void {
  for (const [key, value] of xobjects.entries()) {
    const ref = value instanceof PDFRef ? value : null;
    if (!ref) continue;
    const name = String(key).replace(/^\//, '');
    const object = doc.context.lookup(ref);
    // An image is a *stream*, and a stream's dictionary is reached through
    // `.dict`: `instanceof PDFDict` is false for `PDFRawStream`/`PDFFlateStream`
    // in this pdf-lib build, so testing for a dictionary here collected no
    // image at all and every compress run reported "no images" over a scan.
    const dict = object instanceof PDFStream ? object.dict : object;
    if (!(dict instanceof PDFDict)) continue;
    const subtype = readName(dict, 'Subtype');
    const refKey = ref.toString();
    if (subtype === 'Image') {
      if (into.has(refKey)) continue;
      // A tainted path outranks a measured box: the measurement only covers the
      // placements the walk could see, and the widest placement is the one that
      // has to keep its pixels.
      const box = reason === null ? placements.boxes.get(refKey) : undefined;
      into.set(refKey, {
        ref,
        dict,
        name,
        displayWidth: box?.width ?? 0,
        displayHeight: box?.height ?? 0,
        unmeasuredReason: reason,
      });
      continue;
    }
    if (subtype !== 'Form') continue;
    // A form reached through itself was already walked at the outer level and its
    // images are in `into` by reference: this is the line that keeps
    // `/A → /B → /A` from recursing forever.
    if (visiting.has(refKey)) continue;
    if (depth >= MAX_FORM_DEPTH) {
      unvisited.set(name, `below ${MAX_FORM_DEPTH} levels of form nesting`);
      continue;
    }
    const nested = xObjectsOf(doc, formResources(doc, dict) ?? dict);
    if (!nested) continue;
    visiting.add(refKey);
    discoverImages(
      doc,
      nested,
      placements,
      into,
      unvisited,
      depth + 1,
      visiting,
      reason ?? placements.blocked.get(refKey) ?? null,
    );
    visiting.delete(refKey);
  }
}

/** The `/XObject` map of a resource dictionary, if it has one. */
function xObjectsOf(doc: PDFDocument, resources: PDFDict | null | undefined): PDFDict | null {
  return resources ? readDict(resources.get(PDFName.of('XObject')), doc) : null;
}

/**
 * A form's own resources. PDF requires `/Resources` on a form that uses names; a
 * form that omits it and carries `/XObject` directly is readable in the wild, so
 * the caller falls back to the form dictionary rather than skipping it.
 */
function formResources(doc: PDFDocument, dict: PDFDict): PDFDict | null {
  return readDict(dict.get(PDFName.of('Resources')), doc);
}

type Matrix = [number, number, number, number, number, number];

const IDENTITY_MATRIX: Matrix = [1, 0, 0, 1, 0, 0];

function multiplyMatrix(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

interface Placements {
  /** Widest box each image reference is ever painted into, in points. */
  boxes: Map<string, { width: number; height: number }>;
  /** Forms the walk could not follow: reference → the reason, as a clause. */
  blocked: Map<string, string>;
  /** Why one page's content could not be measured, by page index. */
  unreadablePages: Map<number, string>;
}

/**
 * The box each image XObject is painted into, at every depth, by reference string.
 *
 * A page draws an image as `[w 0 0 h x y] cm /Im1 Do` after any number of `q` /
 * `cm` / `Q` pairs, so the honest measure of "how big is this on the page" is the
 * unit square through the CTM that was current when `Do` ran. A form is walked
 * through its own content with that CTM extended the way a viewer extends it:
 * shift the `/BBox` lower-left to the origin, apply the form's `/Matrix`, then
 * the transform the form was drawn with. The widest placement wins — and because
 * the walk goes through every matrix that reaches a shared form, a form used once
 * as a stamp and once as a poster leaves enough pixels for the poster.
 *
 * Inline images (`BI … EI`) need no lookup and are not in this map.
 */
function measurePlacements(doc: PDFDocument): Placements {
  const state: Placements = { boxes: new Map(), blocked: new Map(), unreadablePages: new Map() };
  /** Decoded form content, so a form drawn five times is decompressed once. */
  const parsed = new Map<string, ContentOp[] | null>();
  doc.getPages().forEach((page, index) => {
    const xobjects = xObjectsOf(doc, readDict(page.node.Resources?.(), doc));
    if (!xobjects) return;
    let ops: ContentOp[];
    try {
      ops = pageContentOps(page);
    } catch {
      // Not "a page with no pictures on it": every image placed from this page
      // keeps its resolution instead of being measured against a box nobody saw.
      state.unreadablePages.set(
        index,
        `is placed on page ${index + 1}, whose content stream this parser could not read`,
      );
      return;
    }
    walkPlacements(state, doc, ops, xobjects, IDENTITY_MATRIX, 0, new Set<string>(), parsed);
  });
  return state;
}

function walkPlacements(
  state: Placements,
  doc: PDFDocument,
  ops: ContentOp[],
  xobjects: PDFDict | null,
  start: Matrix,
  depth: number,
  visiting: Set<string>,
  parsed: Map<string, ContentOp[] | null>,
): void {
  let ctm = start;
  const stack: Matrix[] = [];
  for (const op of ops) {
    if (op.name === 'q') {
      stack.push(ctm);
    } else if (op.name === 'Q') {
      ctm = stack.pop() ?? start;
    } else if (op.name === 'cm') {
      const values = op.operands.filter((item) => item.kind === 'number').map((item) => (item as { value: number }).value);
      if (values.length === 6) ctm = multiplyMatrix(values as Matrix, ctm);
    } else if (op.name === 'Do') {
      const name = op.operands.find((item) => item.kind === 'name') as { value?: string } | undefined;
      if (!name?.value) continue;
      const entry = xobjects?.get(PDFName.of(name.value));
      const ref = entry instanceof PDFRef ? entry : null;
      if (!ref) continue;
      const object = doc.context.lookup(ref);
      const dict = object instanceof PDFStream ? object.dict : object;
      if (!(dict instanceof PDFDict)) continue;
      const subtype = readName(dict, 'Subtype');
      const key = ref.toString();
      if (subtype === 'Image') {
        recordBox(state, key, ctm);
        continue;
      }
      if (subtype !== 'Form') continue;
      const drawn = `/${name.value}`;
      if (visiting.has(key)) {
        // Drawn inside itself. The outer placement was measured and this one was
        // not, so nothing under it can claim to know its widest size.
        state.blocked.set(key, `the form ${drawn} is drawn inside itself, so not every placement of it was measured`);
        continue;
      }
      if (depth >= MAX_FORM_DEPTH) {
        state.blocked.set(key, `the form ${drawn} is below ${MAX_FORM_DEPTH} levels of form nesting`);
        continue;
      }
      const formOps = formContentOps(object, parsed, key);
      if (!formOps) {
        state.blocked.set(key, `the content stream of the form ${drawn} could not be read`);
        continue;
      }
      const bbox = readNumberArray(dict, 'BBox');
      if (bbox.length !== 4 || bbox[2] <= bbox[0] || bbox[3] <= bbox[1]) {
        state.blocked.set(key, `the form ${drawn} has no usable /BBox to map its own space through`);
        continue;
      }
      const matrixValues = readNumberArray(dict, 'Matrix');
      const matrix: Matrix = matrixValues.length === 6 ? (matrixValues as Matrix) : IDENTITY_MATRIX;
      const base = multiplyMatrix(
        multiplyMatrix([1, 0, 0, 1, -bbox[0], -bbox[1]], matrix),
        ctm,
      );
      visiting.add(key);
      walkPlacements(
        state,
        doc,
        formOps,
        xObjectsOf(doc, formResources(doc, dict) ?? dict),
        base,
        depth + 1,
        visiting,
        parsed,
      );
      visiting.delete(key);
    }
  }
}

/** Decoded operators of a form's content stream, or `null` when it cannot be read. */
function formContentOps(object: unknown, parsed: Map<string, ContentOp[] | null>, key: string): ContentOp[] | null {
  const cached = parsed.get(key);
  if (cached !== undefined) return cached;
  let ops: ContentOp[] | null = null;
  if (object instanceof PDFStream) {
    try {
      ops = parseContentStream(streamBytes(object));
    } catch {
      ops = null;
    }
  }
  parsed.set(key, ops);
  return ops;
}

function recordBox(state: Placements, key: string, ctm: Matrix): void {
  const corners = [
    [ctm[4], ctm[5]],
    [ctm[0] + ctm[4], ctm[1] + ctm[5]],
    [ctm[2] + ctm[4], ctm[3] + ctm[5]],
    [ctm[0] + ctm[2] + ctm[4], ctm[1] + ctm[3] + ctm[5]],
  ];
  const width = Math.abs(Math.max(...corners.map((c) => c[0])) - Math.min(...corners.map((c) => c[0])));
  const height = Math.abs(Math.max(...corners.map((c) => c[1])) - Math.min(...corners.map((c) => c[1])));
  const seen = state.boxes.get(key);
  if (!seen || width * height > seen.width * seen.height) state.boxes.set(key, { width, height });
}

/** The numbers of a numeric array entry such as `/BBox` or `/Matrix`. */
function readNumberArray(dict: PDFDict, key: string): number[] {
  const value = dict.lookup(PDFName.of(key));
  if (!(value instanceof PDFArray)) return [];
  const out: number[] = [];
  for (let i = 0; i < value.size(); i++) {
    const item = value.get(i);
    if (!(item instanceof PDFNumber)) return [];
    out.push(item.asNumber());
  }
  return out;
}

/** Why an image was re-encoded without being downsampled; names the artwork. */
function unmeasuredNote(images: ImageRef[]): string {
  const named = images
    .slice(0, 3)
    .map((image) => `/${image.name} (${image.unmeasuredReason})`)
    .join('; ');
  const more = images.length > 3 ? `; and ${images.length - 3} more` : '';
  return images.length === 1
    ? `1 image sits inside artwork this walk could not measure (${named}${more}), so it was re-encoded at the resolution it is stored at and was not downsampled; the maximum-resolution cap did not touch it.`
    : `${images.length} images sit inside artwork this walk could not measure (${named}${more}), so they were re-encoded at the resolution they are stored at and were not downsampled; the maximum-resolution cap did not touch them.`;
}

/** Why whole forms were never searched, so "nothing to do" is not a silent lie. */
function unvisitedNote(unvisited: Map<string, string>): string {
  const entries = [...unvisited.entries()];
  const named = entries.slice(0, 3).map(([name, why]) => `/${name} (${why})`).join(', ');
  const more = entries.length > 3 ? `, and ${entries.length - 3} more` : '';
  return entries.length === 1
    ? `1 Form XObject was not searched for images (${named}), so anything inside it is byte-for-byte unchanged.`
    : `${entries.length} Form XObjects were not searched for images (${named}${more}), so anything inside them is byte-for-byte unchanged.`;
}

function readDict(value: unknown, doc?: PDFDocument): PDFDict | null {
  if (value instanceof PDFDict) return value;
  // A dictionary may be stored behind a reference, which `PDFPageLeaf`'s own
  // accessors resolve but a plain `dict.get` does not.
  if (value instanceof PDFRef && doc) {
    const resolved = doc.context.lookup(value);
    return resolved instanceof PDFDict ? resolved : null;
  }
  return null;
}

function readName(dict: PDFDict, key: string): string | null {
  const value = dict.get(PDFName.of(key));
  if (!value) return null;
  return value.toString().replace(/^\//, '');
}

function readNumber(dict: PDFDict, key: string): number | null {
  const value = dict.get(PDFName.of(key));
  if (!value) return null;
  const parsed = Number(value.toString());
  return Number.isFinite(parsed) ? parsed : null;
}

// ── image re-encoding ───────────────────────────────────────────────────────

type RecompressOutcome = 'undecodable' | 'skipped' | number;

/**
 * Can this browser put pixels on a canvas and take them back out again?
 *
 * Probed once per document rather than per image: `getImageData` and `toBlob`
 * both fail without the optional `canvas` package (this repo's own test
 * environment), and an image that cannot be drawn cannot be re-encoded — a
 * 200-image scan should say so in one sentence, not fail 200 times and report
 * that the images merely refused to shrink.
 */
function canDrawImages(): boolean {
  try {
    const probe = document.createElement('canvas');
    probe.width = 1;
    probe.height = 1;
    const ctx = canvasContext2d(probe);
    ctx.getImageData(0, 0, 1, 1);
    return typeof probe.toBlob === 'function';
  } catch {
    return false;
  }
}

async function recompressImage(
  doc: PDFDocument,
  image: ImageRef,
  settings: { quality: number; dpi: number; resample: boolean },
  options: CompressOptions,
): Promise<RecompressOutcome> {
  const stream = doc.context.lookup(image.ref);
  if (!(stream instanceof PDFRawStream)) return 'skipped';
  const originalBytes = stream.contents instanceof Uint8Array ? stream.contents : new Uint8Array(stream.contents as ArrayLike<number>);
  const filter = readName(image.dict, 'Filter');
  if (filter && !['DCTDecode', 'JPXDecode', 'FlateDecode'].includes(filter)) {
    // CCITT / JBIG2 are fax encodings that a canvas cannot decode losslessly.
    return 'skipped';
  }

  const decoded = await decodeRaster(originalBytes, filter, image.dict, doc);
  if (!decoded) return 'undecodable';

  const width = decoded.width;
  const height = decoded.height;
  const effectiveDpi = image.displayWidth > 0 ? (width * 72) / image.displayWidth : settings.dpi;
  const scale = settings.resample && effectiveDpi > settings.dpi ? settings.dpi / effectiveDpi : 1;
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));

  // A JPEG that is already below the requested quality and resolution gains
  // nothing from another lossy pass.
  if (filter === 'DCTDecode' && scale >= 0.99 && settings.quality >= jpegQualityOf(originalBytes)) {
    return 'skipped';
  }

  // Full size first, then one scaled draw. `putImageData` copies a rectangle of
  // pixels without resampling and clips it to the canvas, so painting a 2480 px
  // scan straight into the 1240 px canvas used to keep its top-left quarter and
  // call that "downsampled to 150 dpi": a silent crop of the user's page, with
  // the bottom half of every line of text gone. `drawImage` is the operator that
  // resamples.
  const full = document.createElement('canvas');
  full.width = width;
  full.height = height;
  canvasContext2d(full).putImageData(decoded.imageData, 0, 0);

  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvasContext2d(canvas);
  if (decoded.hasAlpha) {
    // Paper, not ink, underneath: the soft mask is kept as it stands, so any
    // pixel it fully hides is invisible either way, but a *partly* transparent
    // edge (an anti-aliased logo) blends with whatever is underneath it. Left
    // unfilled, those pixels composite to black and the logo grows a dark halo.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, targetWidth, targetHeight);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(full, 0, 0, targetWidth, targetHeight);
  if (options.grayscale) {
    const grey = document.createElement('canvas');
    grey.width = targetWidth;
    grey.height = targetHeight;
    const greyCtx = canvasContext2d(grey);
    greyCtx.filter = 'grayscale(1)';
    greyCtx.drawImage(canvas, 0, 0);
    const back = canvasContext2d(canvas);
    back.clearRect(0, 0, canvas.width, canvas.height);
    back.drawImage(grey, 0, 0);
  }

  // JPEG for the picture, the file's own `/SMask` for the transparency.
  // A PDF image has no alpha channel of its own, so the PNG bytes this used to
  // write — labelled `/FlateDecode`, which a PNG container is not — either lost
  // the mask or failed to decode at all, and the loss happened whether or not
  // the user asked to keep transparency. Dropping the mask is now what
  // `keepTransparency: false` actually does.
  const encoded = await encodeCanvas(canvas, settings.quality);
  if (!encoded) return 'undecodable';
  if (encoded.byteLength >= originalBytes.byteLength) {
    // Re-encoding made it bigger (common for small icons and flat graphics).
    return 'skipped';
  }

  applyImageStream(doc, image, encoded, { width: targetWidth, height: targetHeight }, options.keepTransparency ?? true);
  return originalBytes.byteLength - encoded.byteLength;
}

interface DecodedRaster {
  imageData: ImageData;
  width: number;
  height: number;
  hasAlpha: boolean;
}

/**
 * Decode an image XObject into RGBA pixels. JPEG and JP2 are handed to the
 * browser's own decoders by re-wrapping the raw stream in the right container;
 * FlateDecode images are inflated with `DecompressionStream` and expanded
 * according to their colour space, which avoids adding a zlib dependency.
 */
async function decodeRaster(
  bytes: Uint8Array,
  filter: string | null,
  dict: PDFDict,
  doc: PDFDocument,
): Promise<DecodedRaster | null> {
  const width = Number(readNumber(dict, 'Width')) || 0;
  const height = Number(readNumber(dict, 'Height')) || 0;
  if (!width || !height) return null;
  const bits = Number(readNumber(dict, 'BitsPerComponent')) || 8;

  if (filter === 'DCTDecode' || filter === 'JPXDecode') {
    const mime = filter === 'DCTDecode' ? 'image/jpeg' : 'image/jp2';
    try {
      const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvasContext2d(canvas);
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close?.();
      return {
        imageData: ctx.getImageData(0, 0, canvas.width, canvas.height),
        width: canvas.width,
        height: canvas.height,
        hasAlpha: false,
      };
    } catch {
      return null;
    }
  }

  if (filter !== 'FlateDecode' && filter !== null) return null;
  if (bits !== 8) return null; // 1/2/4-bit bitmaps and 16-bit need unpacking

  const inflated = await inflate(bytes);
  if (!inflated) return null;
  const colorSpace = resolveColorSpace(dict, doc);
  const channels = colorSpace === 'DeviceGray' || colorSpace === 'Indexed' ? 1 : colorSpace === 'DeviceCMYK' ? 4 : 3;
  const expected = width * height * channels;
  if (inflated.length < expected) return null;

  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const src = i * channels;
    const dst = i * 4;
    if (channels === 1) {
      const v = colorSpace === 'Indexed' ? paletteLookup(inflated[src], dict, doc, inflated) : inflated[src];
      rgba[dst] = v;
      rgba[dst + 1] = v;
      rgba[dst + 2] = v;
    } else if (channels === 3) {
      rgba[dst] = inflated[src];
      rgba[dst + 1] = inflated[src + 1];
      rgba[dst + 2] = inflated[src + 2];
    } else {
      const k = inflated[src + 3];
      rgba[dst] = 255 * (1 - Math.min(1, inflated[src] / 255 + k / 255));
      rgba[dst + 1] = 255 * (1 - Math.min(1, inflated[src + 1] / 255 + k / 255));
      rgba[dst + 2] = 255 * (1 - Math.min(1, inflated[src + 2] / 255 + k / 255));
    }
    rgba[dst + 3] = 255;
  }

  // A /SMask carries the real alpha channel; without it a soft-masked logo
  // turns into a black box, which is exactly the old bug.
  let hasAlpha = false;
  const smask = readReference(dict, 'SMask', doc);
  if (smask) {
    const mask = await loadSoftMask(smask, width, height, doc);
    if (mask) {
      hasAlpha = true;
      for (let i = 0; i < width * height; i++) rgba[i * 4 + 3] = mask[i];
    }
  }
  return { imageData: new ImageData(rgba, width, height), width, height, hasAlpha };
}

async function loadSoftMask(
  ref: PDFRef,
  width: number,
  height: number,
  doc: PDFDocument,
): Promise<Uint8Array | null> {
  const stream = doc.context.lookup(ref);
  if (!(stream instanceof PDFRawStream)) return null;
  const dict = stream.dict as PDFDict;
  const raw = stream.contents instanceof Uint8Array ? stream.contents : new Uint8Array(stream.contents as ArrayLike<number>);
  const filter = readName(dict, 'Filter');
  if (filter !== 'FlateDecode' && filter !== null) return null;
  const inflated = await inflate(raw);
  if (!inflated || inflated.length < width * height) return null;
  return inflated.subarray(0, width * height);
}

function resolveColorSpace(dict: PDFDict, doc: PDFDocument): string {
  const value = dict.get(PDFName.of('ColorSpace'));
  if (!value) return 'DeviceRGB';
  if (typeof value.toString === 'function') {
    const text = value.toString();
    if (text.startsWith('/')) return text.slice(1);
    if (text.startsWith('[')) {
      const first = /\/([A-Za-z0-9]+)/.exec(text);
      if (first?.[1] === 'Indexed' || first?.[1] === 'Pattern') return 'Indexed';
      if (first?.[1]) return first[1];
    }
  }
  if (value instanceof PDFRef) {
    const resolved = doc.context.lookup(value);
    if (resolved instanceof PDFArray) {
      const head = resolved.get(0);
      const name = String(head?.toString() ?? '');
      return name.replace(/^\//, '') === 'Indexed' ? 'Indexed' : name.replace(/^\//, '') || 'DeviceRGB';
    }
    if (resolved) return String(resolved.toString()).replace(/^\//, '') || 'DeviceRGB';
  }
  return 'DeviceRGB';
}

function paletteLookup(index: number, dict: PDFDict, doc: PDFDocument, inflated: Uint8Array): number {
  // Approximate the palette by luminance of the index; a full Indexed decode
  // would need the /Decode array and the base colour space, and the savings
  // are small compared with getting the alpha channel right.
  void dict;
  void doc;
  void inflated;
  return Math.round((index / 255) * 255);
}

function readReference(dict: PDFDict, key: string, doc: PDFDocument): PDFRef | null {
  void doc;
  const value = dict.get(PDFName.of(key));
  return value instanceof PDFRef ? value : null;
}

const inflateCache = new WeakMap<Uint8Array, Promise<Uint8Array | null>>();

async function inflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  const cached = inflateCache.get(bytes);
  if (cached) return cached;
  const task = (async () => {
    if (typeof DecompressionStream === 'undefined') return null;
    try {
      // PDF FlateDecode is zlib-wrapped deflate.
      const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
      const buffer = await new Response(stream).arrayBuffer();
      return new Uint8Array(buffer);
    } catch {
      try {
        const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        const buffer = await new Response(stream).arrayBuffer();
        return new Uint8Array(buffer);
      } catch {
        return null;
      }
    }
  })();
  inflateCache.set(bytes, task);
  return task;
}

/** Read the quantisation table out of a JPEG to avoid a needless re-encode. */
function jpegQualityOf(bytes: Uint8Array): number {
  for (let i = 2; i < bytes.length - 2; i++) {
    if (bytes[i] !== 0xff) continue;
    const marker = bytes[i + 1];
    if (marker === 0xdb || marker === 0xc4) {
      const table = bytes.subarray(i + 4, i + 4 + 64);
      if (table.length < 64) return 0;
      const baseline = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55];
      let sum = 0;
      for (let k = 0; k < 16; k++) sum += table[k] - baseline[k];
      const scale = sum / 16;
      return Math.max(0, Math.min(1, (50 - scale / 2) / 50));
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    i += 1 + length;
  }
  return 0;
}

/** Encode the re-drawn picture; `null` when this browser will not produce a JPEG. */
async function encodeCanvas(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Uint8Array | null> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', quality),
  );
  if (!blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Replace an image XObject in place, keeping its colour space and — when asked
 * — its soft mask.
 *
 * The mask reference is copied rather than re-encoded: its own resolution may
 * differ from the picture's, which PDF allows and readers scale, so downsizing
 * the image does not have to downsize the alpha.
 */
function applyImageStream(
  doc: PDFDocument,
  image: ImageRef,
  encoded: Uint8Array,
  size: { width: number; height: number },
  keepTransparency: boolean,
): void {
  const dictionary = doc.context.obj({
    Type: 'XObject',
    Subtype: 'Image',
    Width: size.width,
    Height: size.height,
    BitsPerComponent: 8,
    ColorSpace:
      readName(image.dict, 'ColorSpace') === 'DeviceGray' ? 'DeviceGray' : readColorSpaceName(image.dict),
    Filter: 'DCTDecode',
  });
  if (keepTransparency) {
    const mask = image.dict.get(PDFName.of('SMask'));
    // A mask is nearly always indirect; the spec also allows the stream object
    // itself, which `context.lookup` cannot answer for, so it is registered.
    const ref = mask instanceof PDFRef
      ? mask
      : mask instanceof PDFRawStream
        ? doc.context.register(mask)
        : null;
    if (ref) dictionary.set(PDFName.of('SMask'), ref);
  }
  doc.context.assign(image.ref, PDFRawStream.of(dictionary, encoded));
}

function readColorSpaceName(dict: PDFDict): string {
  const text = readName(dict, 'ColorSpace') ?? 'DeviceRGB';
  return ['DeviceRGB', 'DeviceGray', 'DeviceCMYK'].includes(text) ? text : 'DeviceRGB';
}

function stripDocumentMetadata(doc: PDFDocument): void {
  const info = doc.context.trailerInfo.Info;
  if (info instanceof PDFRef) doc.context.delete(info);
  doc.catalog.delete(PDFName.of('Metadata'));
}

export { COMPRESSION_PRESETS as presets };
