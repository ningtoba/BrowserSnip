/**
 * Measurement, blank-page / skew detection and raster-based page rewriting.
 *
 * The canvas half of this module is thin on purpose: every number that can be
 * computed from a pixel buffer lives in a pure, exported function
 * (`inkRatio`, `alphaMaskFromPixels`, `skewFromProjectionProfile`,
 * `thresholdPixels`, `whitenPixels`, `sharpenPixels`, `cssFilterString`,
 * `pageSizeName`) so it can be unit-tested without a 2D context — jsdom has no
 * canvas, and `npx vitest` runs in jsdom.
 *
 * Deviation from the module note in `docs/PDF-ENGINE-CONTRACT.md` §5: this file
 * also imports `resolvePages` / `displayedSize` from `./pages`. Re-parsing the
 * "which pages" grammar and re-deriving the rotated page box here would give
 * the app two spellings of both concepts, and `./pages` is a frozen module.
 */
import { PDFDocument } from '@maxwbh/pdf-lib';
import type { PDFImage, PDFPage } from '@maxwbh/pdf-lib';
import { RenderCancelled } from './render';
import type { PageRender, PdfSession } from './render';
import { canvasToBlob } from './raster';
import type { ImageFormat } from './images';
import { PAGE_SIZES, displayedSize, resolvePages } from './pages';

/** Progress reporter every long-running tool receives. */
export type ProgressFn = (fraction: number, message?: string) => void;

/** 72 pt per inch is the PDF definition of a user-space unit. */
export function dpiToScale(dpi: number): number {
  return dpi / 72;
}

// ---------------------------------------------------------------------------
// Pure pixel maths
// ---------------------------------------------------------------------------

/** Perceived luminance of one pixel, 0..255. */
export function lumaOf(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Fraction of sampled pixels that count as ink.
 *
 * `pixels` is RGBA row-major (a `ImageData.data` buffer). Sampling every
 * `stride`-th pixel keeps a 300 dpi page cheap: the ratio is what matters, not
 * the exact count.
 */
export function inkRatio(
  pixels: Uint8ClampedArray | Uint8Array,
  opts: { cutoff?: number; stride?: number } = {},
): number {
  const cutoff = opts.cutoff ?? 220;
  const stride = Math.max(1, Math.round(opts.stride ?? 1));
  let sampled = 0;
  let inked = 0;
  for (let i = 0; i + 3 < pixels.length; i += 4 * stride) {
    const alpha = pixels[i + 3];
    if (alpha === 0) continue; // transparent = paper
    sampled += 1;
    const alphaScale = alpha / 255;
    const luma = lumaOf(pixels[i], pixels[i + 1], pixels[i + 2]) * alphaScale;
    if (luma < cutoff) inked += 1;
  }
  return sampled === 0 ? 0 : inked / sampled;
}

/** Decision rule for {@link isBlankPage}: ink below the threshold is blank. */
export function isBlankFromRatio(ratio: number, threshold: number): boolean {
  return ratio <= threshold;
}

/**
 * 1 where a pixel is ink, 0 where it is paper. RGBA in, one byte per pixel out.
 * Used as the input of the projection-profile skew search.
 */
export function alphaMaskFromPixels(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  opts: { cutoff?: number } = {},
): Uint8Array {
  const cutoff = opts.cutoff ?? 200;
  const mask = new Uint8Array(width * height);
  for (let y = 0, p = 0; y < height; y++) {
    for (let x = 0; x < width; x++, p += 4) {
      const alpha = pixels[p + 3];
      const luma = lumaOf(pixels[p], pixels[p + 1], pixels[p + 2]) * (alpha / 255);
      mask[y * width + x] = alpha > 0 && luma < cutoff ? 1 : 0;
    }
  }
  return mask;
}

/** Variance-over-mean² of a projection profile: how "striped" it is. */
export function profilePeakiness(profile: Int32Array | Float64Array | number[]): number {
  let sum = 0;
  for (let i = 0; i < profile.length; i++) sum += profile[i];
  if (sum === 0) return 0;
  const mean = sum / profile.length;
  let variance = 0;
  for (let i = 0; i < profile.length; i++) {
    const d = profile[i] - mean;
    variance += d * d;
  }
  return variance / profile.length / (mean * mean);
}

export interface SkewEstimate {
  /** Degrees; positive = the page text runs downhill left to right. */
  angle: number;
  /** 0..1 — how much sharper the best profile is than the median one. */
  confidence: number;
}

/**
 * Projection-profile skew search (the "Hough-lite" of document scanning).
 *
 * For every candidate angle the ink pixels are projected onto an axis and the
 * resulting row histogram is scored by peakiness; text rows align, so the
 * straightening angle maximises the score. A coarse sweep is refined around the
 * best coarse angle. Pure: `alphaMask` is {@link alphaMaskFromPixels} output.
 */
export function skewFromProjectionProfile(
  alphaMask: Uint8Array,
  width: number,
  height: number,
  maxAngle: number,
  opts: { coarseStep?: number; fineStep?: number; inkSample?: number } = {},
): SkewEstimate {
  const coarse = Math.max(0.05, opts.coarseStep ?? 0.5);
  const fine = Math.max(0.01, opts.fineStep ?? 0.05);
  const limit = Math.abs(maxAngle);
  if (!(limit > 0) || width < 8 || height < 8) return { angle: 0, confidence: 0 };

  const xs: number[] = [];
  const ys: number[] = [];
  const stride = Math.max(1, Math.round(opts.inkSample ?? 1));
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      if (alphaMask[y * width + x]) {
        xs.push(x);
        ys.push(y);
      }
    }
  }
  if (xs.length < 32) return { angle: 0, confidence: 0 };

  const cx = width / 2;
  const cy = height / 2;
  const rows = Math.ceil(Math.hypot(width, height));
  const score = (degreesValue: number): number => {
    const rad = (degreesValue * Math.PI) / 180;
    const sin = Math.sin(rad);
    const cos = Math.cos(rad);
    const profile = new Int32Array(rows);
    for (let i = 0; i < xs.length; i++) {
      const dx = xs[i] - cx;
      const dy = ys[i] - cy;
      const row = Math.round(-dx * sin + dy * cos) + (rows >> 1);
      if (row >= 0 && row < rows) profile[row] += 1;
    }
    return profilePeakiness(profile);
  };

  const angles: number[] = [];
  for (let a = -limit; a <= limit + 1e-9; a += coarse) angles.push(round(a, 4));
  const coarseScores = angles.map(score);
  let bestIndex = 0;
  for (let i = 1; i < coarseScores.length; i++) {
    if (coarseScores[i] > coarseScores[bestIndex]) bestIndex = i;
  }
  const coarseAngle = angles[bestIndex];

  const refined: number[] = [];
  for (let a = coarseAngle - coarse; a <= coarseAngle + coarse + 1e-9; a += fine) {
    if (a >= -limit && a <= limit) refined.push(round(a, 4));
  }
  const fineScores = refined.map(score);
  let bestFine = bestIndex >= 0 ? coarseScores[bestIndex] : 0;
  let angle = coarseAngle;
  for (let i = 0; i < refined.length; i++) {
    if (fineScores[i] > bestFine) {
      bestFine = fineScores[i];
      angle = refined[i];
    }
  }

  const all = [...coarseScores, ...fineScores].filter((s) => Number.isFinite(s)).sort((a, b) => a - b);
  const median = all.length ? all[Math.floor(all.length / 2)] : 0;
  const peak = Math.max(bestFine, coarseScores[bestIndex] ?? 0);
  const confidence = peak > 0 ? clamp01((peak - median) / peak) : 0;
  // A flat, noise-driven profile must not report a confident correction.
  return { angle: confidence < 0.15 ? 0 : round(angle, 3), confidence: round(confidence, 3) };
}

// ---------------------------------------------------------------------------
// Pure colour maths
// ---------------------------------------------------------------------------

export interface FilterSpec {
  brightness?: number;
  contrast?: number;
  saturation?: number;
  hue?: number;
  invert?: boolean;
  grayscale?: boolean;
  sepia?: boolean;
}

/**
 * Compose the ONE CSS filter string every raster tool hands to
 * `PdfSession.renderPage`. Empty spec returns `''`, which callers treat as
 * "no filter" so the canvas `ctx.filter` stays untouched.
 */
export function cssFilterString(spec: FilterSpec): string {
  const parts: string[] = [];
  if (spec.grayscale) parts.push('grayscale(1)');
  if (spec.sepia) parts.push('sepia(1)');
  if (spec.invert) parts.push('invert(1)');
  if (isFiniteNumber(spec.brightness) && spec.brightness !== 1) {
    parts.push(`brightness(${round(spec.brightness as number, 4)})`);
  }
  if (isFiniteNumber(spec.contrast) && spec.contrast !== 1) {
    parts.push(`contrast(${round(spec.contrast as number, 4)})`);
  }
  if (isFiniteNumber(spec.saturation) && spec.saturation !== 1) {
    parts.push(`saturate(${round(spec.saturation as number, 4)})`);
  }
  if (isFiniteNumber(spec.hue) && spec.hue !== 0) {
    parts.push(`hue-rotate(${round(spec.hue as number, 2)}deg)`);
  }
  return parts.join(' ');
}

/** Hard bilevel threshold in place (scanner "black and white" mode). */
export function thresholdPixels(
  pixels: Uint8ClampedArray | Uint8Array,
  cutoff = 128,
): Uint8ClampedArray | Uint8Array {
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const value = lumaOf(pixels[i], pixels[i + 1], pixels[i + 2]) < cutoff ? 0 : 255;
    pixels[i] = value;
    pixels[i + 1] = value;
    pixels[i + 2] = value;
  }
  return pixels;
}

/**
 * Push light pixels towards paper white in place, which is what "whitening"
 * means in a scanner pipeline. `level` 0..1; 0 is a no-op.
 */
export function whitenPixels(
  pixels: Uint8ClampedArray | Uint8Array,
  level = 0.5,
): Uint8ClampedArray | Uint8Array {
  const amount = clamp(level, 0, 1);
  if (amount === 0) return pixels;
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const gamma = 1 - amount * 0.9;
    for (let c = 0; c < 3; c++) {
      const normalised = pixels[i + c] / 255;
      pixels[i + c] = Math.round(Math.pow(normalised, gamma) * 255);
    }
  }
  return pixels;
}

/**
 * 3×3 unsharp kernel applied in place through a copy of the buffer.
 * `amount` 0 is a no-op, 1 is a strong sharpen.
 */
export function sharpenPixels(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  amount = 0.6,
): Uint8ClampedArray | Uint8Array {
  const strength = clamp(amount, 0, 2);
  if (strength === 0 || width < 3 || height < 3) return pixels;
  const source = new Uint8ClampedArray(pixels);
  const centre = 1 + 4 * strength;
  const side = -strength;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const offset = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const around =
          source[offset - 4 + c] +
          source[offset + 4 + c] +
          source[offset - width * 4 + c] +
          source[offset + width * 4 + c];
        const value = source[offset + c] * centre + around * side;
        pixels[offset + c] = value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
      }
    }
  }
  return pixels;
}

// ---------------------------------------------------------------------------
// Page-size report
// ---------------------------------------------------------------------------

/** Extra named sizes the frozen `PAGE_SIZES` table does not carry (points). */
const NAMED_SIZES: Record<string, [number, number]> = {
  ...PAGE_SIZES,
  dl: [311.81, 623.62], // 110 × 220 mm envelope
  'executive': [720, 1008],
  'b5': [498.9, 708.66],
};

const SIZE_LABELS: Record<string, string> = {
  a3: 'A3',
  a4: 'A4',
  a5: 'A5',
  dl: 'DL',
  b5: 'B5',
  executive: 'Executive',
  legal: 'Legal',
  letter: 'Letter',
  tabloid: 'Tabloid',
  'business-card': 'Business card',
};

/** Tolerance the contract asks for: a named size must match within 1 pt. */
export const PAGE_NAME_TOLERANCE_PT = 1;

/**
 * Closest standard name for a page box, or `'Custom'`. Orientation is reported
 * separately, so a rotated Letter page still names as Letter.
 */
export function pageSizeName(widthPt: number, heightPt: number, tolerance = PAGE_NAME_TOLERANCE_PT): string {
  let best: { key: string; distance: number } | null = null;
  for (const [key, [w, h]] of Object.entries(NAMED_SIZES)) {
    const direct = Math.hypot(widthPt - w, heightPt - h);
    const swapped = Math.hypot(widthPt - h, heightPt - w);
    const distance = Math.min(direct, swapped);
    if (!best || distance < best.distance) best = { key, distance };
  }
  if (!best || best.distance > tolerance) return 'Custom';
  return SIZE_LABELS[best.key] ?? best.key;
}

export interface PageSizeRow {
  page: number;
  widthPt: number;
  heightPt: number;
  widthMm: number;
  heightMm: number;
  orientation: 'portrait' | 'landscape' | 'square';
  rotation: number;
  name: string;
}

/** Pure pdf-lib: one row per page, sized after its /Rotate-adjusted box. */
export function pageSizeReport(doc: PDFDocument): PageSizeRow[] {
  const mm = 25.4 / 72;
  return doc.getPages().map((page: PDFPage, index) => {
    const size = displayedSize(page);
    const rotation = page.getRotation().angle;
    const widthPt = round(size.width, 2);
    const heightPt = round(size.height, 2);
    const orientation =
      widthPt === heightPt ? 'square' : widthPt > heightPt ? 'landscape' : 'portrait';
    return {
      page: index + 1,
      widthPt,
      heightPt,
      widthMm: round(widthPt * mm, 2),
      heightMm: round(heightPt * mm, 2),
      orientation,
      rotation,
      name: pageSizeName(size.width, size.height),
    };
  });
}

/** Size presets offered by the rasterise / compress UIs. */
export function compressionPresets(): {
  id: string;
  label: string;
  dpi: number;
  quality: number;
  description: string;
}[] {
  return [
    { id: 'screen', label: 'Screen', dpi: 96, quality: 0.62, description: 'Smallest file, on-screen reading only.' },
    { id: 'web', label: 'Web', dpi: 150, quality: 0.75, description: 'Good balance for email and web uploads.' },
    { id: 'print', label: 'Print', dpi: 300, quality: 0.9, description: 'Print-ready raster quality.' },
    { id: 'archive', label: 'Archive', dpi: 400, quality: 0.96, description: 'Large pages, best for archival scans.' },
  ];
}

// ---------------------------------------------------------------------------
// Canvas-backed tools
// ---------------------------------------------------------------------------

export interface BlankPageOptions {
  /** Ink fraction at or below which a page counts as blank. Default 0.001. */
  inkThreshold?: number;
  /** Render scale; 0.5 samples ~4 px per point, plenty for a blank test. */
  scale?: number;
}

/**
 * Blank-page test: rasterise at low scale and measure the ink fraction.
 * Returns the ratio so callers can show "0.4 % ink" instead of a bare no.
 */
export async function isBlankPage(
  session: PdfSession,
  page: number,
  opts: BlankPageOptions = {},
): Promise<{ blank: boolean; inkRatio: number }> {
  const threshold = opts.inkThreshold ?? 0.001;
  const render = await session.renderPage(page, opts.scale ?? 0.5);
  try {
    const ctx = render.ctx;
    const data = ctx.getImageData(0, 0, render.width, render.height).data;
    const ratio = inkRatio(data, { stride: 1 });
    return { blank: isBlankFromRatio(ratio, threshold), inkRatio: round(ratio, 6) };
  } finally {
    render.cancel();
  }
}

export interface SkewOptions {
  /** Largest angle to search, in degrees. Default 7. */
  maxAngle?: number;
  scale?: number;
  cutoff?: number;
}

/**
 * Projection-profile skew estimate for one page, in **bitmap** degrees: the angle
 * the rendered text lines run at, measured with y pointing *down* (a page whose
 * text rises to the right — a positive PDF user-space rotation — answers
 * negative). The correction handed to `applySkew` is the negation of this, which
 * is what {@link deskewAngleFor} exists to spell out.
 */
export async function detectSkew(
  session: PdfSession,
  page: number,
  opts: SkewOptions = {},
): Promise<SkewEstimate> {
  const render = await session.renderPage(page, opts.scale ?? 1.5, { background: '#ffffff' });
  try {
    // `renderPage` settles when the paint is only *scheduled*; its synchronous
    // work is the white background fill. Reading the bitmap before `finished`
    // therefore measured an empty page, the estimator found under 32 ink pixels,
    // and every tilted page came back `{ angle: 0, confidence: 0 }` — deskew
    // reported "nothing to do" on a 6° scan. Same lesson as `renderToCanvas`
    // (`694e007`) and `rasterizePages` (`6b9b479`).
    await render.finished;
    const data = render.ctx.getImageData(0, 0, render.width, render.height).data;
    const mask = alphaMaskFromPixels(data, render.width, render.height, { cutoff: opts.cutoff ?? 200 });
    return skewFromProjectionProfile(mask, render.width, render.height, opts.maxAngle ?? 7);
  } finally {
    render.cancel();
  }
}

export interface RasterizeOptions {
  dpi: number;
  format: 'jpeg' | 'png';
  quality?: number;
  filter?: string;
  background?: string;
  /** Page spec understood by `core/pages.resolvePages`; default all pages. */
  pages?: string;
  progress: ProgressFn;
  signal: AbortSignal;
}

/**
 * Rasterise the selected pages into a **new** document: one image per page at
 * the original page size, so the output reflows identically in a viewer.
 * The source document is only read for page geometry.
 */
export async function rasterizeWithOptions(
  session: PdfSession,
  doc: PDFDocument,
  opts: RasterizeOptions,
): Promise<Uint8Array> {
  const pages = resolvePages(opts.pages, session.numPages);
  const scale = dpiToScale(Math.max(36, opts.dpi));
  const target = await PDFDocument.create();
  for (let i = 0; i < pages.length; i++) {
    throwIfCancelled(opts.signal, 'Page rasterising was cancelled.');
    const index = pages[i];
    const source = doc.getPage(index);
    const size = displayedSize(source);
    const render = await session.renderPage(index + 1, scale, {
      filter: opts.filter,
      background: opts.background ?? (opts.format === 'jpeg' ? '#ffffff' : undefined),
    });
    const image = await embedRender(target, render, opts.format, opts.quality ?? 0.9);
    render.cancel();
    const page = target.addPage([size.width, size.height]);
    page.drawImage(image, { x: 0, y: 0, width: size.width, height: size.height });
    opts.progress((i + 1) / pages.length, `Rasterised page ${index + 1} of ${session.numPages}`);
  }
  return new Uint8Array(await target.save({ useObjectStreams: true }));
}

export interface ColorFilterOptions {
  brightness: number;
  contrast: number;
  saturation: number;
  hue: number;
  invert: boolean;
  grayscale: boolean;
  /** Optional bilevel cutoff (0..255) applied after the CSS filter. */
  threshold?: number;
  pages: string;
  progress: ProgressFn;
  signal: AbortSignal;
  dpi?: number;
  quality?: number;
  background?: string;
}

/** Colour adjustment. The CSS filter string is composed once, then reused. */
export async function applyColorFilter(
  session: PdfSession,
  doc: PDFDocument,
  opts: ColorFilterOptions,
): Promise<Uint8Array> {
  const filter = cssFilterString({
    brightness: opts.brightness,
    contrast: opts.contrast,
    saturation: opts.saturation,
    hue: opts.hue,
    invert: opts.invert,
    grayscale: opts.grayscale,
  });
  const scale = dpiToScale(opts.dpi ?? 200);
  const pages = resolvePages(opts.pages, session.numPages);
  const target = await PDFDocument.create();
  for (let i = 0; i < pages.length; i++) {
    throwIfCancelled(opts.signal, 'Colour adjustment was cancelled.');
    const index = pages[i];
    const size = displayedSize(doc.getPage(index));
    const render = await session.renderPage(index + 1, scale, {
      filter: filter || undefined,
      background: opts.background ?? '#ffffff',
    });
    // `renderPage` settles when the paint is only *scheduled*; its synchronous
    // work is the background fill, and `RenderOptions.filter` lands inside this
    // same promise on the *finished* bitmap (`core/render.ts`). Reading
    // `render.ctx` or encoding `render.canvas` before this await copied paper
    // with a filter applied to nothing — which is how `pdf-to-greyscale`'s
    // re-render method shipped a 1166×1652 image at 0.00 % ink for a source page
    // measuring 19.50 %. Same missing await as `detectSkew` above, `694e007`,
    // `6b9b479`, `8313e2d`, `4ba14b6` and `38ef532`.
    await render.finished;
    if (typeof opts.threshold === 'number') {
      const data = render.ctx.getImageData(0, 0, render.width, render.height);
      thresholdPixels(data.data, opts.threshold);
      render.ctx.putImageData(data, 0, 0);
    }
    const image = await embedRender(target, render, 'jpeg', opts.quality ?? 0.9);
    render.cancel();
    const page = target.addPage([size.width, size.height]);
    page.drawImage(image, { x: 0, y: 0, width: size.width, height: size.height });
    opts.progress((i + 1) / pages.length, `Recoloured page ${index + 1} of ${session.numPages}`);
  }
  return new Uint8Array(await target.save({ useObjectStreams: true }));
}

export interface ScannerEffectOptions {
  dpi: number;
  whitening: boolean;
  sharpen: boolean;
  grayscale: boolean;
  contrast: number;
  progress: ProgressFn;
  signal: AbortSignal;
  /** Page spec; default every page. */
  pages?: string;
  /** Optional bilevel output instead of grey anti-aliased text. */
  threshold?: number;
  quality?: number;
}

/** Deskew-free "scan look": contrast + optional whitening, sharpen, greyscale. */
export async function scannerEffect(
  session: PdfSession,
  doc: PDFDocument,
  opts: ScannerEffectOptions,
): Promise<Uint8Array> {
  const scale = dpiToScale(Math.max(36, opts.dpi));
  const filter = cssFilterString({
    contrast: opts.contrast,
    grayscale: opts.grayscale,
    // Whitening lifts the paper, so it is expressed as brightness on top of the
    // contrast boost rather than as a second pixel pass when not thresholding.
    brightness: opts.whitening ? 1.08 : 1,
  });
  const pages = resolvePages(opts.pages, session.numPages);
  const target = await PDFDocument.create();
  for (let i = 0; i < pages.length; i++) {
    throwIfCancelled(opts.signal, 'The scanner effect was cancelled.');
    const index = pages[i];
    const size = displayedSize(doc.getPage(index));
    const render = await session.renderPage(index + 1, scale, { filter: filter || undefined, background: '#ffffff' });
    const imageData = render.ctx.getImageData(0, 0, render.width, render.height);
    if (opts.whitening) whitenPixels(imageData.data, 0.45);
    if (typeof opts.threshold === 'number') thresholdPixels(imageData.data, opts.threshold);
    if (opts.sharpen) sharpenPixels(imageData.data, render.width, render.height, 0.7);
    render.ctx.putImageData(imageData, 0, 0);
    const image = await embedRender(target, render, 'jpeg', opts.quality ?? 0.85);
    render.cancel();
    const page = target.addPage([size.width, size.height]);
    page.drawImage(image, { x: 0, y: 0, width: size.width, height: size.height });
    opts.progress((i + 1) / pages.length, `Scanned page ${index + 1} of ${session.numPages}`);
  }
  return new Uint8Array(await target.save({ useObjectStreams: true }));
}

/**
 * The angle to hand `applySkew` for a measured tilt: the negation of
 * {@link SkewEstimate.angle}, clamped to ±`maxAngle`.
 *
 * The two live in different conventions — the estimate is a bitmap angle (y
 * down), `applySkew` turns the page clockwise as it is viewed — so this one
 * negation is the whole translation between them, and skipping it turns a
 * straighten into a double tilt. Clamped because a page past the user's
 * "largest angle to correct" must be left alone rather than half-turned.
 */
export function deskewAngleFor(measured: SkewEstimate, maxAngle: number): number {
  return clamp(-measured.angle, -maxAngle, maxAngle);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function embedRender(
  target: PDFDocument,
  render: PageRender,
  format: 'jpeg' | 'png',
  quality: number,
): Promise<PDFImage> {
  const blob = await canvasToBlob(render.canvas, format as ImageFormat, quality, {
    background: format === 'jpeg' ? '#ffffff' : undefined,
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // A canvas that cannot encode the requested type returns PNG and says nothing
  // about it — that is the HTML spec's fallback, not a hypothetical. Embedding by
  // the *asked* format died inside pdf-lib with "SOI not found in JPEG", so the
  // bytes decide which embedder runs.
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  return isJpeg ? target.embedJpg(bytes) : target.embedPng(bytes);
}

function throwIfCancelled(signal: AbortSignal, message: string): void {
  if (signal.aborted) throw new RenderCancelled(message);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function isFiniteNumber(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
