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
import { dpiToScale } from './measure';
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
  await initOcr();
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
    try {
      recognised = await recognizeCanvas(render.canvas);
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
