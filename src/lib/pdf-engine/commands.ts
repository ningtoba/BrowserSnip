/**
 * The four operations the registry has no `core` implementation for.
 *
 * This file used to be 1,500 lines: a complete second implementation of every
 * PDF operation, reached through `hooks/usePDFEngine.ts` and its own
 * `executeToolCommand` switch, with no guard pre-flight, no field clamping, no
 * structural `warnings` and no progress. That switch is gone — one dispatch
 * path now, `lib/pdf/tools/**` + `tools/runner.ts` — and this module is only a
 * library of last resorts that the registry's `run` bodies call:
 *
 * | export               | called by                                             |
 * |----------------------|-------------------------------------------------------|
 * | `repairPDF`          | `tools/optimize.ts` (`repair`) — the damaged-file reader and its raw-byte fallback exist nowhere else. |
 * | `scanImagesToPdf`    | `tools/legacy.ts` (`scan-to-pdf`) — kept instead of `core/pack.pdfFromImages` because that path re-encodes every page as PNG; a camera frame is already JPEG and must stay JPEG. |
 * | `drawSignatureMarks` | `tools/legacy.ts` (`sign`) — placing a picture or a typed name at a point the user dragged to. |
 * | `comparePDFs`        | `tools/legacy.ts` (`compare`) — the pixel diff that produces an annotated PDF, and the only compare path the shipped page reaches. `tools/security.ts` computes a diff for its *report*, but collects each page's overlay into a local `images` list it never returns, so that path writes no picture and no file. |
 *
 * What this module is waiting on, so it can shrink to nothing:
 * - `core/pack` gaining "keep the source container" so the scan path can move
 *   onto it (and stop being the only place that knows scan's fit rules).
 * - A `core` home for the two-document pixel diff (probably beside
 *   `core/render`, next to the single-owner pdf.js sessions it should use).
 * - `repairPDF` moving into `core/` and `tools/optimize.ts` dropping its
 *   cross-module import. Requested in `docs/tasks/s3-request.md`.
 *
 * Nothing under `src/components/**` may import this module: a component reaches
 * an operation through `runPdfTool`, never directly. `tests/pdf/one-path.test.ts`
 * keeps that true.
 */
import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  newPDF,
  openPDF,
  rgb,
  savePDF,
  StandardFonts,
} from '../pdf/core/doc';
import { embedImageBytes, fitScale } from '../pdf/core/pack';
import { pageSize as resolvePageSize } from '../pdf/core/pages';
import { openRender } from '../pdf/core/render';
import { drawTextU } from '../pdf/core/fonts';
import { parseHexColor, throwIfAborted } from '../pdf/tools/helpers';

/** Progress and cancellation, supplied by the runner through the tool context. */
export interface RunHooks {
  progress?: (fraction: number, message?: string) => void;
  signal?: AbortSignal;
}

/* ── OPTIMIZE: repair ─────────────────────────────────────────────────────── */

/**
 * Repair a damaged or malformed PDF by rebuilding its internal structure.
 *
 * What this does:
 * - Rebuilds the cross-reference (xref) table
 * - Copies all pages into a fresh document (fixes broken page trees)
 * - Strips encryption that may be causing read failures
 * - Removes corrupted annotations and form fields
 * - Rewrites with clean linear object numbering
 *
 * This is equivalent to a "save as optimized" in desktop PDF tools.
 * Severely corrupted files where the parser fails entirely
 * cannot be recovered in the browser.
 */
export async function repairPDF(pdfBuffer: ArrayBuffer): Promise<Uint8Array> {
  const bytes = new Uint8Array(pdfBuffer);
  let srcDoc: PDFDocument | null = null;

  // Strategy 1: open with the shared loader, ignoring `/Encrypt` — a damaged
  // security dictionary is not a reason to refuse the file (`repair` exists for
  // files nothing else will open, and it re-saves unencrypted).
  try {
    srcDoc = await openPDF(bytes, { ignoreEncryption: true });
  } catch { /* will try raw recovery */ }

  // Strategy 2: raw byte-level recovery — scan for page content streams
  if (!srcDoc) {
    srcDoc = await recoverPagesFromRawBytes(bytes);
  }

  if (!srcDoc) {
    throw new Error(
      'This PDF is too damaged to recover. The internal catalog and page tree ' +
      'are corrupted beyond what the browser can repair. Try a desktop PDF editor.',
    );
  }

  const pageCount = srcDoc.getPageCount();
  if (pageCount === 0) {
    throw new Error('No readable pages could be recovered from this PDF.');
  }

  // Rebuild: copy all recovered pages into a brand-new document
  const repaired = await PDFDocument.create();

  const pageIndices = srcDoc.getPageIndices();
  const copied = await repaired.copyPages(srcDoc, pageIndices);
  for (const page of copied) {
    repaired.addPage(page);
  }

  // Copy metadata if readable
  try { const title = srcDoc.getTitle(); if (title) repaired.setTitle(title); } catch { /* metadata is optional */ }
  try { const author = srcDoc.getAuthor(); if (author) repaired.setAuthor(author); } catch { /* metadata is optional */ }

  repaired.setProducer('BrowserSnip PDF');
  repaired.setCreator('BrowserSnip PDF');

  return repaired.save({ useObjectStreams: true });
}

/**
 * Last-resort recovery: scan raw PDF bytes for content streams, then
 * rebuild pages around whatever content data is still intact.
 */
async function recoverPagesFromRawBytes(bytes: Uint8Array): Promise<PDFDocument | null> {
  const text = new TextDecoder('latin1').decode(bytes);

  // Find likely page content streams — data between "stream" and "endstream"
  // that contains PDF drawing operators
  const streamPattern = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  const contents: Uint8Array[] = [];
  let match: RegExpExecArray | null;

  while ((match = streamPattern.exec(text)) !== null) {
    const raw = match[1];
    // Only accept streams that contain PDF page-drawing operators
    if (/[Tt][Jj]|[Tt][Dd]|[Tt]m|cm\b|[Dd][Oo]\b|BT\b|ET\b|BDC\b|re\b|[mM] [lL]/.test(raw)) {
      contents.push(new TextEncoder().encode(raw));
    }
  }

  if (contents.length === 0) return null;

  // Try to find /MediaBox dimensions for each recovered stream, default to letter
  const mediaPattern = /\/MediaBox\s*\[([^\]]+)\]/g;
  const mediaBoxes: Array<[number, number, number, number]> = [];
  while ((match = mediaPattern.exec(text)) !== null) {
    const nums = match[1].split(/\s+/).map(Number).filter((n) => !Number.isNaN(n));
    if (nums.length >= 4) mediaBoxes.push([nums[0], nums[1], nums[2], nums[3]]);
  }

  const doc = await PDFDocument.create();
  const context = doc.context;

  for (let i = 0; i < contents.length; i++) {
    const streamBytes = contents[i];
    if (streamBytes.length < 10) continue;

    // Determine page size from matching /MediaBox, or default to letter
    const box = mediaBoxes[i] ?? [0, 0, 612, 792];
    const pageWidth = box[2] - box[0];
    const pageHeight = box[3] - box[1];

    try {
      const page = doc.addPage([pageWidth, pageHeight]);

      // Build a raw content stream dict
      const streamDict = PDFDict.withContext(context);
      streamDict.set(PDFName.of('Length'), PDFNumber.of(streamBytes.length));

      const contentStream = PDFRawStream.of(streamDict, streamBytes);

      // Register the new stream in the document context
      const ref = context.nextRef();
      context.assign(ref, contentStream);

      // Attach the recovered content to the page via the internal page node
      page.node.set(PDFName.of('Contents'), ref);
    } catch {
      continue;
    }
  }

  if (doc.getPageCount() === 0) return null;

  doc.setTitle('Recovered PDF');
  doc.setSubject('Partially recovered from corrupted file');
  return doc;
}

/* ── CONVERT TO PDF: scan ─────────────────────────────────────────────────── */

export interface ScanImage {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

export interface ScanLayout {
  /** Named sheet (`a4`, `letter`…) or `fit` / `original` to hug the capture. */
  pageSize: string;
  orientation: 'portrait' | 'landscape' | 'auto';
  /** Points on every edge. */
  margin: number;
  fit: 'contain' | 'cover' | 'stretch';
}

export interface ScanResult {
  bytes: Uint8Array;
  pages: number;
  /** Captures that could not be decoded, named, with the reason. */
  skipped: { name: string; reason: string }[];
}

/**
 * Build one page per captured frame.
 *
 * The source container is preserved — a camera frame stays a JPEG — which is
 * why this does not go through `core/pack.pdfFromImages` (that rasterises every
 * image onto a canvas and embeds the result as PNG, roughly doubling a scan).
 * A frame this browser cannot decode is skipped and named rather than killing
 * the run, because losing page 4 of a 20-page scan is better than losing the
 * whole scan.
 */
export async function scanImagesToPdf(
  images: ScanImage[],
  layout: ScanLayout,
  hooks: RunHooks = {},
): Promise<ScanResult> {
  const doc = await newPDF();
  const skipped: ScanResult['skipped'] = [];
  const margin = layout.margin;

  for (let index = 0; index < images.length; index++) {
    throwIfAborted(hooks.signal ?? new AbortController().signal);
    const image = images[index];
    try {
      const embedded = await embedImageBytes(doc, image.bytes, { mime: image.mime });
      const naturalWidth = embedded.width;
      const naturalHeight = embedded.height;
      const hug = layout.pageSize === 'fit' || layout.pageSize === 'original';
      const landscape = layout.orientation === 'landscape'
        || (layout.orientation === 'auto' && naturalWidth > naturalHeight);
      const [sheetWidth, sheetHeight] = hug
        ? [naturalWidth + margin * 2, naturalHeight + margin * 2]
        : resolvePageSize(layout.pageSize, landscape);

      const page = doc.addPage([sheetWidth, sheetHeight]);
      const usableWidth = Math.max(1, sheetWidth - margin * 2);
      const usableHeight = Math.max(1, sheetHeight - margin * 2);
      const scale = hug ? 1 : fitScale(naturalWidth, naturalHeight, usableWidth, usableHeight, layout.fit);
      const drawWidth = Math.min(naturalWidth * scale, usableWidth);
      const drawHeight = Math.min(naturalHeight * scale, usableHeight);
      page.drawImage(embedded, {
        x: margin + (usableWidth - drawWidth) / 2,
        y: margin + (usableHeight - drawHeight) / 2,
        width: drawWidth,
        height: drawHeight,
      });
    } catch (error) {
      skipped.push({
        name: image.name,
        reason: error instanceof Error ? error.message : 'this browser could not decode it',
      });
    }
    hooks.progress?.((index + 1) / images.length, `Placed page ${index + 1} of ${images.length}`);
  }

  const bytes = await savePDF(doc);
  return { bytes, pages: doc.getPageCount(), skipped };
}

/* ── SECURITY: visual signature ───────────────────────────────────────────── */

/**
 * One mark the user placed on the page.
 *
 * `x`/`y` are fractions of the *target* page's own box (`x` from the left, `y`
 * from the bottom, PDF user space) and `width`/`height` are points, so a mark
 * aimed at page 3 of a mixed-size document lands where it was aimed instead of
 * at page 1's geometry.
 */
export interface SignatureMark {
  type: 'text' | 'image';
  text: string;
  image?: Uint8Array | null;
  mime?: string;
  /** 1-based page number. */
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  fontFamily?: string;
}

export interface SignatureResult {
  placed: number;
  /** What had to be given up or moved, in sentences for `result.warnings`. */
  notes: string[];
}

/**
 * Draw the placed marks into the document.
 *
 * Text goes through `core/fonts.drawTextU`, so a signature typed in Chinese,
 * Cyrillic or Arabic embeds a real face instead of throwing the WinAnsi
 * `drawText` error the old path died on.
 */
export async function drawSignatureMarks(
  doc: PDFDocument,
  marks: readonly SignatureMark[],
  hooks: RunHooks = {},
): Promise<SignatureResult> {
  const pages = doc.getPages();
  const notes: string[] = [];
  let placed = 0;
  let missing = 0;
  let moved = 0;

  for (let index = 0; index < marks.length; index++) {
    throwIfAborted(hooks.signal ?? new AbortController().signal);
    const mark = marks[index];
    const page = pages[mark.page - 1];
    if (!page) {
      missing += 1;
      continue;
    }
    const box = page.getMediaBox();
    const width = Math.min(Math.max(1, mark.width), box.width);
    const height = Math.min(Math.max(1, mark.height), box.height);
    const rawX = box.x + Math.min(Math.max(mark.x, 0), 1) * box.width;
    const rawY = box.y + Math.min(Math.max(mark.y, 0), 1) * box.height;
    const x = Math.min(Math.max(rawX, box.x), box.x + box.width - width);
    const y = Math.min(Math.max(rawY, box.y), box.y + box.height - height);
    if (Math.abs(x - rawX) > 0.5 || Math.abs(y - rawY) > 0.5) moved += 1;

    if (mark.type === 'image') {
      if (!mark.image || mark.image.length === 0) {
        missing += 1;
        continue;
      }
      try {
        const embedded = await embedImageBytes(doc, mark.image, { mime: mark.mime, format: 'png' });
        page.drawImage(embedded, { x, y, width, height });
        placed += 1;
      } catch (error) {
        notes.push(`A signature image on page ${mark.page} could not be embedded: ${
          error instanceof Error ? error.message : 'this browser could not decode it'
        }`);
      }
      continue;
    }

    const text = mark.text.trim();
    if (!text) {
      missing += 1;
      continue;
    }
    const size = clampFontSize(height);
    const { r, g, b } = parseHexColor(mark.color ?? '#000000');
    try {
      await drawTextU(page, {
        text,
        x,
        y: y + (height - size) / 2,
        size,
        color: rgb(r, g, b),
        fontFamily: mark.fontFamily,
        maxWidth: box.x + box.width - x,
      });
      placed += 1;
    } catch (error) {
      // `core/fonts` fetches a Unicode face from the CDN for scripts the
      // standard 14 cannot spell; offline, that fetch is what fails.
      notes.push(`The typed signature "${text}" on page ${mark.page} was not written: ${
        error instanceof Error ? error.message : 'its font could not be loaded'
      }. Offline, a signature drawn or uploaded as a picture still works.`);
    }
    hooks.progress?.((index + 1) / marks.length, `Placed signature ${index + 1} of ${marks.length}`);
  }

  if (missing > 0) {
    notes.push(`${count(missing, 'signature')} pointed at a page this document does not have, or had nothing to draw, and was left out.`);
  }
  if (moved > 0) {
    notes.push(`${count(moved, 'signature')} hung past the edge of its page and was pulled back inside it.`);
  }
  return { placed, notes };
}

/** A typed mark keeps the old visual size rule: 65 % of the box, 7–72 pt. */
function clampFontSize(boxHeight: number): number {
  return Math.max(7, Math.min(72, boxHeight * 0.65));
}

function count(value: number, noun: string): string {
  return value === 1 ? `1 ${noun}` : `${value} ${noun}s`;
}

/* ── SECURITY: compare ────────────────────────────────────────────────────── */

export interface CompareOptions {
  /** CSS hex painted over a differing pixel. */
  highlightColor: string;
  /** Sum of the per-channel differences a pixel must exceed to count (5–150). */
  sensitivity: number;
  /** Device pixels per PDF point while rendering. */
  scale?: number;
}

export interface CompareResult {
  bytes: Uint8Array;
  /** Pages that exist in both documents, and so were actually compared. */
  compared: number;
  /** Pages only the first / second document has — reported, never diffed. */
  onlyInFirst: number;
  onlyInSecond: number;
}

/**
 * Render both documents and write document A with the differences painted on.
 *
 * The pixels are compared through `core/render`'s single-owner pdf.js sessions,
 * so the preview and this file agree, and the page-count difference comes back
 * as a number instead of silently truncating the shorter document.
 */
export async function comparePDFs(
  first: Uint8Array,
  second: Uint8Array,
  options: CompareOptions,
  hooks: RunHooks = {},
): Promise<CompareResult> {
  const scale = options.scale ?? 2;
  const out = await newPDF();
  const highlight = parseHexColor(options.highlightColor);
  const labelFont = await out.embedFont(StandardFonts.Helvetica);
  const sessionA = await openRender(first);
  const sessionB = await openRender(second);
  const compared = Math.min(sessionA.numPages, sessionB.numPages);

  try {
    for (let page = 1; page <= compared; page++) {
      throwIfAborted(hooks.signal ?? new AbortController().signal);
      const [renderA, renderB] = await Promise.all([
        sessionA.renderPage(page, scale),
        sessionB.renderPage(page, scale),
      ]);
      // `renderPage` settles when the task is *scheduled*; the pixels arrive on
      // `finished`. Both canvases are read below — once into the page copy, once
      // through the diff — and reading them early is what shipped a comparison
      // where every page measured paper, so nothing could ever be marked
      // (the campaign's unawaited-paint family; `docs/TOOL-CAMPAIGN.md`, the
      // `compare-pdfs` row, carries the deployed numbers).
      await Promise.all([renderA.finished, renderB.finished]);
      const width = Math.max(renderA.width, renderB.width);
      const height = Math.max(renderA.height, renderB.height);
      const sheet = document.createElement('canvas');
      sheet.width = width;
      sheet.height = height;
      const context = sheet.getContext('2d');
      if (!context) throw new Error('This browser cannot render a page to compare it.');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
      context.drawImage(renderA.canvas, 0, 0);

      const overlay = diffCanvas(renderA, renderB, width, height, options.sensitivity, highlight);
      const pageImage = await embedImageBytes(out, await canvasPng(sheet), { mime: 'image/png' });
      const outPage = out.addPage([width / scale, height / scale]);
      outPage.drawImage(pageImage, { x: 0, y: 0, width: width / scale, height: height / scale });
      if (overlay) {
        const overlayImage = await embedImageBytes(out, await canvasPng(overlay), { mime: 'image/png' });
        outPage.drawImage(overlayImage, {
          x: 0,
          y: 0,
          width: width / scale,
          height: height / scale,
          opacity: 0.7,
        });
      }
      outPage.drawText(`Page ${page} — comparison`, {
        x: 10,
        y: height / scale - 14,
        size: 10,
        font: labelFont,
        color: rgb(0.5, 0.5, 0.5),
      });
      renderA.cancel();
      renderB.cancel();
      hooks.progress?.(page / compared, `Compared page ${page} of ${compared}`);
    }
  } finally {
    await sessionA.destroy();
    await sessionB.destroy();
  }

  return {
    bytes: await savePDF(out),
    compared,
    onlyInFirst: Math.max(0, sessionA.numPages - compared),
    onlyInSecond: Math.max(0, sessionB.numPages - compared),
  };
}

/** Paint every pixel over the threshold in the highlight colour, with alpha. */
function diffCanvas(
  a: { canvas: HTMLCanvasElement; width: number; height: number },
  b: { canvas: HTMLCanvasElement; width: number; height: number },
  width: number,
  height: number,
  sensitivity: number,
  highlight: { r: number; g: number; b: number },
): HTMLCanvasElement | null {
  const grab = (source: HTMLCanvasElement): Uint8ClampedArray => {
    const holder = document.createElement('canvas');
    holder.width = width;
    holder.height = height;
    const context = holder.getContext('2d');
    if (!context) return new Uint8ClampedArray(width * height * 4);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(source, 0, 0);
    return context.getImageData(0, 0, width, height).data;
  };
  const dataA = grab(a.canvas);
  const dataB = grab(b.canvas);
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const context = out.getContext('2d');
  if (!context) return null;
  const paint = context.createImageData(width, height);
  const target = paint.data;
  for (let i = 0; i < width * height; i++) {
    const j = i * 4;
    const distance = Math.abs(dataA[j] - dataB[j])
      + Math.abs(dataA[j + 1] - dataB[j + 1])
      + Math.abs(dataA[j + 2] - dataB[j + 2]);
    if (distance > sensitivity) {
      target[j] = Math.round(highlight.r * 255);
      target[j + 1] = Math.round(highlight.g * 255);
      target[j + 2] = Math.round(highlight.b * 255);
      target[j + 3] = Math.min(255, Math.round(distance * 1.5));
    }
  }
  context.putImageData(paint, 0, 0);
  return out;
}

async function canvasPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('This browser could not encode the comparison page.');
  return new Uint8Array(await blob.arrayBuffer());
}
