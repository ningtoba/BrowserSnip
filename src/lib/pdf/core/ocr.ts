/**
 * OCR and the searchable text layer.
 *
 * The recogniser is `src/lib/ocr/engine.ts` (ppu-paddle-ocr, ONNX in the
 * browser) — its real exported API only: `initOcr`, `recognizeCanvas`,
 * `getOcrStatus`, `destroyOcr`. No tesseract, no invented functions.
 *
 * Coordinate contract (the one thing that is easy to get wrong here):
 *
 * - `recognizeCanvas` reports boxes in **raster pixels**, origin top-left of
 *   the rendered page.
 * - `ExtractedTextItem` (pdf.js, via `core/render`) reports boxes in
 *   **rotated viewer space**, origin top-left, scale 1.
 * - `OcrPageResult.rect` — and therefore everything this module writes into the
 *   PDF — is **unrotated PDF user space with a bottom-left origin**, the same
 *   convention as `AnnotationSpec.rect` in the contract's §2.
 *
 * {@link viewerRectToUserSpace} (exported from `./tables`, the dependency-free
 * geometry module of this group) is the single pure function that performs that
 * last conversion for both paths, so a `/Rotate 90` page cannot drift.
 */
import type { PDFDocument, PDFPage, PDFFont, PDFName, PDFOperator } from '@maxwbh/pdf-lib';
import {
  TextRenderingMode,
  beginText,
  endText,
  setFillingRgbColor,
  setFontAndSize,
  setTextMatrix,
  setTextRenderingMode,
  showText,
} from '@maxwbh/pdf-lib';
import { initOcr, recognizeCanvas } from '@/lib/ocr/engine';
import type { FlattenedPaddleOcrResult } from 'ppu-paddle-ocr/web';
import { RenderCancelled, joinReadingOrder } from './render';
import type { ExtractedTextItem, PdfSession } from './render';
import { resolvePages } from './pages';
import { dpiToScale, inkRatio, isBlankFromRatio } from './measure';
import { getFont } from './fonts';
import { viewerRectToUserSpace, viewerSizeOf, pageFrameOfView } from './tables';
import type { PageFrame, QuadRect, TopLeftBox } from './tables';

export type { PageFrame, TopLeftBox } from './tables';
export { userSpaceToSvgMatrix, viewerRectToUserSpace, viewerSizeOf } from './tables';

export { destroyOcr, getOcrStatus } from '@/lib/ocr/engine';

/** A recognised word, in unrotated PDF user space (bottom-left origin). */
export interface OcrWord {
  text: string;
  rect: QuadRect;
  confidence: number;
}

export interface OcrPageResult {
  /** 1-based page number, matching `PdfSession`. */
  page: number;
  text: string;
  /** Raster size that was recognised, in pixels. */
  width: number;
  height: number;
  /** Recognised lines, in unrotated PDF user space. */
  blocks: OcrWord[];
  /** Recognised words — this is what the text layer is built from. */
  words: OcrWord[];
  /** True when the page already carried a real text layer and was skipped. */
  alreadySearchable: boolean;
  /**
   * What the painted page bitmap is actually made of, measured here rather than
   * inferred from the word count. Absent when the page was never rendered — a
   * skipped page, or one the recogniser never reached — which is the difference
   * between "this page is empty" and "nobody looked", and callers must not
   * collapse the two.
   */
  ink?: OcrInkReading;
}

/** Non-white coverage of one rendered page, measured after pdf.js painted it. */
export interface OcrInkReading {
  /** Pixels the reading covers (`inkRatio` skips the fully transparent ones). */
  sampled: number;
  /** Fraction of them that are ink, 0..1. */
  ratio: number;
  /** `ratio` under the blank rule ({@link BLANK_INK_RATIO}): nothing on the page. */
  blank: boolean;
}

/**
 * Ink at or below this fraction is a page with nothing on it — the same 0.1 %
 * floor `isBlankPage` in `./measure` applies, so the two blank rules in this
 * library stay one number with one meaning.
 */
export const BLANK_INK_RATIO = 0.001;

/**
 * The reader could not do its work. This is a statement about the *engine*, and
 * it is deliberately not the same thing as "the page has no text": a file that
 * was never analysed cannot be reported as a file with nothing in it.
 *
 * `phase` keeps the two honest differences apart —
 * `load` the models never arrived, `recognise` they arrived but stopped
 * answering partway through — and both mean the document was not read.
 */
/**
 * The reader could not do its work. This is a statement about the *engine*, and
 * it is deliberately not the same thing as "the page has no text": a file that
 * was never analysed cannot be reported as a file with nothing in it.
 *
 * `phase` keeps the two honest differences apart — `load` the models never
 * arrived, `recognise` they arrived but stopped answering partway through — and
 * both mean the document was not read. The message stays the engine's own words
 * verbatim: `digitize-document` quotes this string in its degradation line, and
 * a wrapper sentence here would put this row's phrasing in that tool's mouth.
 */
export class OcrEngineUnavailable extends Error {
  readonly phase: 'load' | 'recognise';
  /** Page the reader died on, for `phase: 'recognise'`. */
  readonly page?: number;
  /** The engine's own words, kept so the report can name the real reason. */
  readonly detail: string;

  constructor(phase: 'load' | 'recognise', detail: string, page?: number) {
    super(detail);
    this.name = 'OcrEngineUnavailable';
    this.phase = phase;
    this.detail = detail;
    if (page !== undefined) this.page = page;
  }
}

export interface OcrDocumentOptions {
  /** Page spec understood by `core/pages.resolvePages`; default every page. */
  pages?: string;
  /** Raster density handed to the recogniser. Default 200 dpi. */
  dpi?: number;
  /**
   * Accepted for tool-UI parity. The bundled PaddleOCR model is dictionary
   * driven, so the recogniser itself has no language switch; `lang` is only
   * reported back through `onStatus`.
   */
  lang?: string;
  onProgress?: (done: number, total: number, page: number) => void;
  signal?: AbortSignal;
  onStatus?: (status: string) => void;
  /** OCR pages that already have a text layer instead of skipping them. */
  force?: boolean;
}

/**
 * Split one recognised line into word boxes by distributing the line width
 * over characters in proportion to their share of the line. Pure and
 * canvas-free; the input is structurally a `RecognitionResult`.
 */
export function wordBoxesFromLines(
  lines: readonly { text: string; box: TopLeftBox; confidence: number }[],
): OcrWord[] {
  const words: OcrWord[] = [];
  for (const line of lines) {
    const text = line.text ?? '';
    if (!text.trim()) continue;
    const total = [...text].reduce((n, ch) => n + (/\s/.test(ch) ? 0.34 : 0.66), 0);
    if (total <= 0) continue;
    let cursor = line.box.x;
    let run = '';
    let runStart = cursor;
    const flush = () => {
      if (!run.trim()) return;
      words.push({
        text: run.trim(),
        rect: {
          x: round(runStart, 2),
          y: round(line.box.y, 2),
          width: round(Math.max(0.5, cursor - runStart), 2),
          height: round(line.box.height, 2),
        },
        confidence: round(line.confidence, 4),
      });
    };
    for (const ch of text) {
      const advance = (/\s/.test(ch) ? 0.34 : 0.66) * (line.box.width / total);
      if (/\s/.test(ch)) {
        flush();
        run = '';
        cursor += advance;
        runStart = cursor;
      } else {
        if (!run) runStart = cursor;
        run += ch;
        cursor += advance;
      }
    }
    flush();
  }
  return words;
}

/**
 * A page is "already searchable" when its visible text layer holds enough real
 * characters. Invisible mode-3 runs do not count — they are what this module
 * writes, so counting them would make a second OCR pass a no-op.
 */
export function isPageSearchable(
  items: readonly ExtractedTextItem[],
  opts: { minChars?: number } = {},
): boolean {
  const minChars = opts.minChars ?? 24;
  let visible = 0;
  for (const item of items) {
    if (item.isInvisible) continue;
    visible += item.str.replace(/\s+/g, '').length;
    if (visible >= minChars) return true;
  }
  return false;
}

/**
 * Recognise the selected pages.
 *
 * Pages that already carry a text layer are skipped and reported with
 * `alreadySearchable: true`, because that is what a user expects from
 * "OCR PDF": it adds text where there is none and leaves good pages alone.
 *
 * Three outcomes leave this function and they are not interchangeable: the
 * engine could not read the file at all ({@link OcrEngineUnavailable}), a page
 * was read and holds no letters, and a page was read and holds no ink
 * (`OcrPageResult.ink`). Only the first is a claim about the reader.
 */
export async function ocrDocument(
  session: PdfSession,
  opts: OcrDocumentOptions = {},
): Promise<OcrPageResult[]> {
  const pages = resolvePages(opts.pages, session.numPages);
  const scale = dpiToScale(opts.dpi ?? 200);
  const results: OcrPageResult[] = [];

  if (opts.lang) opts.onStatus?.(`Language hint: ${opts.lang}`);
  opts.onStatus?.('Loading the OCR models…');
  try {
    await initOcr();
  } catch (error) {
    // The models are fetched on first use; a failure here is the reader missing,
    // not the document empty, and must never reach the user as "no text found".
    throw new OcrEngineUnavailable('load', describe(error));
  }
  opts.onStatus?.('OCR engine ready');

  for (let i = 0; i < pages.length; i++) {
    if (opts.signal?.aborted) {
      throw new RenderCancelled('OCR was cancelled before it finished this document.');
    }
    const pageNumber = pages[i] + 1;
    const frame = await pageFrameOf(session, pages[i]);
    const items = await session.textItems(pageNumber);

    if (!opts.force && isPageSearchable(items)) {
      const displayed = viewerSizeOf(frame);
      results.push({
        page: pageNumber,
        text: joinReadingOrder(items.filter((item) => !item.isInvisible)),
        width: round(displayed.width * scale, 0),
        height: round(displayed.height * scale, 0),
        blocks: [],
        words: [],
        alreadySearchable: true,
      });
      opts.onProgress?.(i + 1, pages.length, pageNumber);
      continue;
    }

    opts.onStatus?.(`Recognising page ${pageNumber}…`);
    const render = await session.renderPage(pageNumber, scale, { background: '#ffffff' });
    let recognised: FlattenedPaddleOcrResult;
    let ink: OcrInkReading | undefined;
    try {
      // `renderPage` settles when the paint is *scheduled*; the pixels land on
      // `finished`. Reading the canvas on the statement after `renderPage` is
      // what made this tool answer "Nothing was recognised" about a legible
      // scan: measured off the same bitmap in Chromium
      // (`docs/research/ocr-cause-probe.mjs`), it holds 0 non-white px at the
      // settle and 94 145 px (2.17 %) once `finished` resolves. Same family as
      // `6b9b479`, `4ba14b6`, `8313e2d`, `38ef532` — the await belongs at the
      // read, and `core/render.ts` is already honest about the paint.
      // A rejection here is pdf.js saying it never painted (or was cancelled):
      // that is not the engine's fault and is not wrapped as such.
      await render.finished;
      ink = measurePageInk(render);
      try {
        // `noCache` is not an optimisation flag: the vendor result cache keys on
        // the buffer length plus its first 1024 bytes, so two same-size sheets
        // that begin with paper collide and page N is answered with page N−1's
        // words. See `src/lib/ocr/engine.ts` for the measurement.
        recognised = await recognizeCanvas(render.canvas, { noCache: true });
      } catch (error) {
        if (opts.signal?.aborted) {
          throw new RenderCancelled('OCR was cancelled before it finished this document.');
        }
        // A reader that throws is still not a document that is empty: report it
        // as the engine failing on this page, with the page named.
        throw new OcrEngineUnavailable('recognise', describe(error), pageNumber);
      }
    } catch (error) {
      if (opts.signal?.aborted) {
        throw new RenderCancelled('OCR was cancelled before it finished this document.');
      }
      throw error;
    } finally {
      render.cancel();
    }
    if (opts.signal?.aborted) {
      throw new RenderCancelled('OCR was cancelled before it finished this document.');
    }

    // Raster pixels → viewer units (scale 1) → unrotated user space. The frame
    // stays unrotated on purpose: `viewerRectToUserSpace` applies the quarter
    // turn itself, using `/Rotate` plus the unrotated box.
    const toViewer = (box: TopLeftBox): TopLeftBox => ({
      x: box.x / scale,
      y: box.y / scale,
      width: box.width / scale,
      height: box.height / scale,
    });
    const lineBoxes = recognised.results.map((line) => ({
      text: line.text,
      box: toViewer(line.box),
      confidence: line.confidence,
    }));
    const blocks = lineBoxes.map((line) => ({
      text: line.text,
      rect: viewerRectToUserSpace(line.box, frame),
      confidence: round(line.confidence, 4),
    }));
    const words = wordBoxesFromLines(lineBoxes).map((word) => ({
      ...word,
      rect: viewerRectToUserSpace(word.rect, frame),
    }));

    results.push({
      page: pageNumber,
      text: recognised.text ?? blocks.map((b) => b.text).join('\n'),
      width: render.width,
      height: render.height,
      blocks,
      words,
      alreadySearchable: false,
      ink,
    });
    opts.onProgress?.(i + 1, pages.length, pageNumber);
  }

  opts.onStatus?.(`OCR finished: ${results.length} page(s) processed`);
  return results;
}

export interface SearchableLayerOptions {
  /** Render mode 3 (invisible) text. Defaults to true — the normal case. */
  invisible?: boolean;
  /** Size used when a box has no usable height. Default 8 pt. */
  fontSizeFallback?: number;
  /** OCR boxes are squeezed to their width; clamp pathological values here. */
  maxStretch?: number;
}

/**
 * Write a real, selectable text layer over pages that were rasterised by OCR.
 *
 * Text is drawn with `page.pushOperators(...)` in render mode 3 by default, one
 * run per word, squeezed horizontally so the selection rectangle matches the
 * word in the image. When `invisible` is false the runs are painted black
 * instead, which is what "overlay extractable text" means.
 */
export async function addSearchableTextLayer(
  doc: PDFDocument,
  results: OcrPageResult[],
  opts: SearchableLayerOptions = {},
): Promise<{ words: number; pages: number; skipped: number }> {
  const mode =
    opts.invisible === false ? TextRenderingMode.Fill : TextRenderingMode.Invisible;
  const fallback = opts.fontSizeFallback ?? 8;
  const maxStretch = opts.maxStretch ?? 4;
  const fontKeys = new Map<PDFPage, Map<string, PDFName>>();
  let words = 0;
  let pages = 0;
  let skipped = 0;

  for (const result of results) {
    if (result.alreadySearchable) {
      skipped += 1;
      continue;
    }
    const runs = result.words.length > 0 ? result.words : result.blocks;
    if (runs.length === 0) {
      skipped += 1;
      continue;
    }
    const index = result.page - 1;
    if (index < 0 || index >= doc.getPageCount()) {
      throw new Error(
        `The OCR result refers to page ${result.page}, but this document has ${doc.getPageCount()} page(s).`,
      );
    }
    const page = doc.getPage(index);
    const ops: PDFOperator[] = [];
    for (const run of runs) {
      const text = run.text.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const size = run.rect.height > 1 ? round(run.rect.height * 0.85, 2) : fallback;
      const font = await getFont(doc, { text, size });
      const key = fontKeyFor(page, font, fontKeys);
      const natural = font.widthOfTextAtSize(text, size);
      const stretch = natural > 0 ? clamp(run.rect.width / natural, 0.05, maxStretch) : 1;
      const baseline = round(run.rect.y + run.rect.height * 0.08, 3);
      if (mode === TextRenderingMode.Fill) ops.push(setFillingRgbColor(0, 0, 0));
      ops.push(
        beginText(),
        setFontAndSize(key, size),
        setTextRenderingMode(mode),
        setTextMatrix(round(stretch, 5), 0, 0, 1, round(run.rect.x, 3), baseline),
        showText(font.encodeText(text)),
        endText(),
      );
      words += 1;
    }
    if (ops.length > 0) {
      page.pushOperators(...ops);
      pages += 1;
    }
  }
  return { words, pages, skipped };
}

/** Counts for the result banner: how many pages OCR actually added. */
export function ocrCounts(results: readonly OcrPageResult[]): {
  pages: number;
  recognised: number;
  alreadySearchable: number;
  words: number;
} {
  let recognised = 0;
  let alreadySearchable = 0;
  let words = 0;
  for (const result of results) {
    if (result.alreadySearchable) alreadySearchable += 1;
    else recognised += 1;
    words += result.words.length;
  }
  return { pages: results.length, recognised, alreadySearchable, words };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Non-white coverage of a painted page bitmap, or `undefined` when the bitmap
 * cannot be read at all.
 *
 * `render` must already have awaited `finished`, or this measures the white fill
 * and every page looks blank — which is the defect this module just learned about
 * the hard way. A canvas with no readable pixels yields no claim rather than a
 * false one: "not measured" and "measured empty" are different sentences.
 */
function measurePageInk(render: {
  ctx?: CanvasRenderingContext2D;
  width: number;
  height: number;
}): OcrInkReading | undefined {
  if (!render.ctx?.getImageData) return undefined;
  let data: Uint8ClampedArray;
  try {
    data = render.ctx.getImageData(0, 0, render.width, render.height).data;
  } catch {
    return undefined;
  }
  const ratio = inkRatio(data, { stride: 1 });
  const sampled = Math.floor(data.length / 4);
  if (sampled === 0) return undefined;
  return {
    sampled,
    ratio: round(ratio, 6),
    blank: isBlankFromRatio(ratio, BLANK_INK_RATIO),
  };
}

/** The engine's own words, for an error that has to name a reason. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read a page's unrotated box and /Rotate from pdf.js. `page.view` is the
 * effective crop box (already in user space) and `page.rotate` the display
 * rotation, which is exactly the pair {@link viewerRectToUserSpace} expects.
 */
async function pageFrameOf(session: PdfSession, zeroBased: number): Promise<PageFrame> {
  const page = await session.page(zeroBased + 1);
  const frame = pageFrameOfView(page.view, page.rotate);
  if (frame) return frame;
  // `view` is always present on a live proxy; the unrotated viewport is the
  // belt-and-braces path for stubbed sessions in tests.
  const viewport = page.getViewport({ scale: 1, rotation: 0 });
  return { x0: 0, y0: 0, width: viewport.width, height: viewport.height, rotation: 0 };
}

/** Register `font` in the page's /Resources /Font dict once per page. */
function fontKeyFor(
  page: PDFPage,
  font: PDFFont,
  cache: Map<PDFPage, Map<string, PDFName>>,
): PDFName {
  let perPage = cache.get(page);
  if (!perPage) {
    perPage = new Map();
    cache.set(page, perPage);
  }
  const existing = perPage.get(font.name);
  if (existing) return existing;
  const key = page.node.newFontDictionary(font.name, font.ref);
  perPage.set(font.name, key);
  return key;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
