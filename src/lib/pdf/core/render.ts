/**
 * pdf.js rendering sessions.
 *
 * The previous implementation kept one module-level `currentDoc`, so the two
 * `PDFViewer` instances plus `ThumbnailStrip` that `ToolWorkspace` mounts at
 * once each destroyed the others' proxy ("last writer wins"), and unmount
 * cleanup called a global `terminate()` that invalidated documents other
 * components were still drawing. Every caller now owns an explicit session
 * that it destroys itself.
 *
 * This module also fixes the long-standing CJK gap: `cMapUrl` and
 * `standardFontDataUrl` are supplied from assets copied into the build, and
 * encrypted documents raise a typed password error instead of a raw
 * `PasswordException`.
 */
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
// `types/src/pdf.d.ts` only re-exports six type names, so the text-run types
// are read from their declaring module instead.
import type {
  TextContent,
  TextItem,
  TextMarkedContent,
} from 'pdfjs-dist/types/src/display/api';
import { PasswordRequiredError } from './doc';
import { canvasToBlob, extensionForImage } from './raster';
import type { ImageFormat } from './images';

let workerConfigured = false;

function configureWorker(): void {
  if (workerConfigured) return;
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.mjs',
    import.meta.url,
  ).toString();
  workerConfigured = true;
}

/**
 * Asset roots produced by `vite-plugin-static-copy` (`cmaps/` and
 * `standard_fonts/` in `dist/`). Resolved against `document.baseURI` so the
 * app works on the custom domain and on a GitHub Pages subpath alike.
 */
function assetRoot(sub: string): string {
  const base = typeof document !== 'undefined' ? document.baseURI : 'http://localhost/';
  try {
    return new URL(`/${sub}/`, base).href;
  } catch {
    return `/${sub}/`;
  }
}

export interface OpenRenderOptions {
  password?: string;
  /** Cancel a slow load. */
  signal?: AbortSignal;
  /** Skip font/metrics that this caller does not need (thumbnails, text). */
  intent?: 'display' | 'print' | 'any';
}

export interface PdfSession {
  readonly doc: PDFDocumentProxy;
  readonly numPages: number;
  /** Stable per-file id from pdf.js, used to de-duplicate loaded previews. */
  readonly fingerprint: string;
  page(n: number): Promise<PDFPageProxy>;
  /** Render `n` (1-based) into `canvas` at `scale`, honouring page /Rotate. */
  renderToCanvas(n: number, canvas: OffscreenCanvas | HTMLCanvasElement, scale?: number): Promise<{ width: number; height: number }>;
  /**
   * Start painting page `n` into a detached canvas. The returned `canvas` is
   * empty until `PageRender.finished` resolves — pdf.js renders asynchronously
   * and this call returns while it works, which is what makes `cancel()` able to
   * abort a superseded page.
   */
  renderPage(n: number, scale: number, opts?: RenderOptions): Promise<PageRender>;
  textContent(n: number): Promise<TextContent>;
  textItems(n: number): Promise<ExtractedTextItem[]>;
  metadata(): Promise<RenderMetadata>;
  attachments(): Promise<Record<string, Uint8Array>>;
  /** pdf.js objects must be released explicitly or they retain WASM buffers. */
  destroy(): Promise<void>;
}

export interface RenderOptions {
  scale?: number;
  rotation?: number;
  /**
   * CSS filter applied to the rendered page — e.g. `invert(1)`, `grayscale(1)`,
   * `contrast(1.35)`. Empty or `none` means "paint the page exactly as displayed".
   *
   * It lands on the **finished bitmap**, not during the paint, and that is not an
   * implementation detail: pdf.js calls `resetCtxToDefault` in `beginDrawing`,
   * which writes `filter = 'none'` over whatever the caller set on the context, so
   * an assignment before `page.render()` only ever reached pdf.js's own background
   * fill. `invert-colors` shipped inverted paper with un-inverted ink that way —
   * black text on a black sheet, which measures as ink and reads as nothing.
   *
   * Because the pass is part of the paint, a caller sees it only after
   * {@link PageRender.finished} resolves, exactly like the pixels themselves.
   */
  filter?: string;
  background?: string;
}

export interface PageRender {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  /** Points per device pixel — converts viewer coordinates into PDF user space. */
  unitsPerPixel: number;
  pageNumber: number;
  /**
   * Resolves when pdf.js has actually painted `canvas`.
   *
   * `renderPage` settles as soon as the task is *scheduled*, so a caller can
   * still `cancel()` a render the user superseded; the pixels arrive after that.
   * Reading `canvas` / `ctx` — or copying them anywhere — therefore has to await
   * this promise first, or the copy takes an empty bitmap. It rejects when the
   * task was cancelled, which is how a caller tells "nothing painted yet" from
   * "nothing will ever paint".
   */
  finished: Promise<void>;
  /**
   * Aborts an in-flight paint — after it, nothing more is drawn into `canvas`,
   * and `finished` rejects — and releases the page proxy. It is *not* an undo:
   * pixels already copied into a caller's own canvas stay there, so a render
   * superseded mid-flight can still be cancelled without blanking a page that
   * was already shown.
   */
  cancel(): void;
}

export interface RenderMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  creationDate?: string;
  modDate?: string;
  numPages: number;
  fingerprint: string;
  /** AcroForm field count, when the document has one. */
  formFields: number;
}

/** A text run in PDF user space (origin bottom-left, pre-rotation). */
export interface ExtractedTextItem {
  str: string;
  /** Transform matrix from the content stream. */
  transform: number[];
  width: number;
  height: number;
  fontName: string;
  dir: 'ltr' | 'rtl' | string;
  /** 1-based page. */
  page: number;
  /** Bounding box in PDF user space, origin top-left of the *rotated* page. */
  x: number;
  y: number;
  w: number;
  h: number;
  hasEOL: boolean;
  /** 1 when the run is hidden render mode 3 (the OCR/searchable-layer case). */
  isInvisible: boolean;
}

export class RenderCancelled extends Error {
  readonly name = 'RenderCancelled';
}

/**
 * Filter a finished page bitmap in place: paper and ink together, exactly once.
 *
 * The filter cannot ride on the paint. pdf.js's `beginDrawing` calls
 * `resetCtxToDefault`, which writes `filter = 'none'` over anything the caller put
 * on the context before `page.render()` — so a pre-paint assignment reaches only
 * pdf.js's own background fill, and `invert-colors` shipped inverted paper under
 * un-inverted ink (black text on a black sheet: it measures as ink and reads as
 * nothing). Applying it after the last operator is what makes the option mean what
 * it says.
 *
 * A second surface rather than a self-copy because `copy` must replace the page
 * with the *filtered* pixels: drawing a canvas onto itself while filtering depends
 * on the implementation snapshotting the source first. One page-sized canvas per
 * page, released when this returns, inside a loop that already keeps one page in
 * flight.
 */
function applyFilterToPage(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  filter: string,
): void {
  const painted = document.createElement('canvas');
  painted.width = canvas.width;
  painted.height = canvas.height;
  const source = painted.getContext('2d');
  if (!source) return;
  source.filter = filter;
  source.drawImage(canvas, 0, 0);
  // The identity transform, because pdf.js leaves the page transform on the
  // context and this copy is device-pixel to device-pixel.
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // Both are pdf.js's to leave as it likes — the copy must be a plain replace, so
  // neither the alpha nor a leftover filter may ride on it.
  ctx.globalAlpha = 1;
  ctx.filter = 'none';
  ctx.globalCompositeOperation = 'copy';
  ctx.drawImage(painted, 0, 0);
  ctx.restore();
}

export async function openRender(
  src: ArrayBuffer | Uint8Array,
  options: OpenRenderOptions = {},
): Promise<PdfSession> {
  configureWorker();
  const data = src instanceof Uint8Array ? src : new Uint8Array(src);

  let doc: PDFDocumentProxy;
  try {
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(data.slice(0)),
      password: options.password,
      cMapUrl: assetRoot('cmaps'),
      cMapPacked: true,
      standardFontDataUrl: assetRoot('standard_fonts'),
      useSystemFonts: true,
      isEvalSupported: false,
      disableAutoFetch: true,
      disableStream: true,
    });
    doc = await withAbort(loadingTask.promise, options.signal);
  } catch (err) {
    if (isNamed(err, 'PasswordException')) {
      throw new PasswordRequiredError(
        options.password
          ? 'That password is not correct for this PDF.'
          : 'This PDF is password protected.',
      );
    }
    throw asPasswordError(err);
  }

  let destroyed = false;
  const guard = () => {
    if (destroyed) throw new RenderCancelled('This PDF preview was closed.');
  };

  const session: PdfSession = {
    get doc() {
      guard();
      return doc;
    },
    get numPages() {
      return doc.numPages;
    },
    get fingerprint() {
      return doc.fingerprints?.[0] ?? '';
    },
    async page(n: number) {
      guard();
      return doc.getPage(n);
    },
    async renderToCanvas(n, canvas, scale = 1.5) {
      const render = await session.renderPage(n, scale);
      const target = canvas as OffscreenCanvas | HTMLCanvasElement;
      target.width = render.width;
      target.height = render.height;
      const ctx = target.getContext('2d');
      if (!ctx) {
        render.cancel();
        throw new Error('Could not get a 2D drawing context.');
      }
      try {
        // The copy used to run straight after `page.render()` was scheduled, so
        // it moved an empty bitmap and `cancel()` then killed the task that was
        // about to fill it: a page that loaded blank while its text still
        // extracted. Await the paint, and only then copy; a cancelled task
        // rejects here, so a superseded render never paints late.
        await render.finished;
        ctx.drawImage(render.canvas, 0, 0);
      } finally {
        render.cancel();
      }
      return { width: render.width, height: render.height };
    },
    async renderPage(n, scale = 1.5, renderOptions = {}) {
      guard();
      const page = await doc.getPage(n);
      const viewport = page.getViewport({
        scale,
        rotation: renderOptions.rotation ?? page.rotate,
      });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        page.cleanup();
        throw new Error('Could not get a 2D drawing context.');
      }
      if (renderOptions.background) {
        ctx.fillStyle = renderOptions.background;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      const task: RenderTask = page.render({ canvasContext: ctx, viewport });
      const filter = renderOptions.filter && renderOptions.filter !== 'none' ? renderOptions.filter : null;
      // pdf.js paints asynchronously; this promise is the only evidence the
      // bitmap holds anything. The extra `catch` marks the rejection as observed
      // so a caller that never awaits `finished` does not log an unhandled
      // rejection when its render is cancelled — awaiting still sees the error.
      const finished = task.promise.then(() => {
        // Paper and ink together, once, after the last operator has landed. A
        // page the caller asked to filter is filtered here or not at all: see
        // `RenderOptions.filter` for why the pre-paint assignment could not work.
        if (filter) applyFilterToPage(canvas, ctx, filter);
      });
      finished.catch(() => undefined);
      return {
        canvas,
        ctx,
        width: canvas.width,
        height: canvas.height,
        unitsPerPixel: 1 / scale,
        pageNumber: n,
        finished,
        cancel() {
          try {
            task.cancel();
          } catch {
            /* the task already settled */
          }
          page.cleanup();
        },
      };
    },
    async textContent(n) {
      guard();
      const page = await doc.getPage(n);
      try {
        return await page.getTextContent();
      } finally {
        page.cleanup();
      }
    },
    async textItems(n) {
      guard();
      const page = await doc.getPage(n);
      try {
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        return toExtractedItems(content, n, viewport.height);
      } finally {
        page.cleanup();
      }
    },
    async metadata() {
      guard();
      const meta = await doc.getMetadata();
      const info = asRecord(meta.info) ?? {};
      const formCount = await countFormFields(doc);
      return {
        title: asString(info.Title),
        author: asString(info.Author),
        subject: asString(info.Subject),
        keywords: asString(info.Keywords),
        creator: asString(info.Creator),
        producer: asString(info.Producer),
        creationDate: asString(info.CreationDate),
        modDate: asString(info.ModDate),
        numPages: doc.numPages,
        fingerprint: this.fingerprint,
        formFields: formCount,
      };
    },
    async attachments() {
      guard();
      const items = await doc.getAttachments();
      const out: Record<string, Uint8Array> = {};
      for (const [name, file] of Object.entries(items ?? {})) {
        const record = asRecord(file);
        const content = record?.content;
        if (content instanceof Uint8Array) out[name] = content;
        else if (content instanceof ArrayBuffer) out[name] = new Uint8Array(content);
      }
      return out;
    },
    async destroy() {
      if (destroyed) return;
      destroyed = true;
      try {
        await doc.destroy();
      } catch {
        /* already torn down by the worker */
      }
    },
  };

  return session;
}

async function countFormFields(doc: PDFDocumentProxy): Promise<number> {
  try {
    const fields = await doc.getFieldObjects();
    return fields ? Object.keys(fields).length : 0;
  } catch {
    return 0;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !(value instanceof Map)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Convert pdf.js text runs into PDF user-space boxes with a top-left origin.
 * pdf.js reports `transform` in PDF user space (bottom-left origin, already
 * including the page's /Rotate); the y-flip below produces coordinates that
 * line up with a rendered canvas at scale 1.
 */
export function toExtractedItems(
  content: TextContent,
  page: number,
  viewportHeight: number,
): ExtractedTextItem[] {
  const out: ExtractedTextItem[] = [];
  for (const item of content.items) {
    if (!isTextItem(item)) continue;
    const [a = 0, b = 0, , , e = 0, f = 0] = item.transform.map(Number);
    const w = item.width;
    const h = Math.hypot(b, a) || Math.abs(item.height) || 0;
    const fontSize = Math.hypot(a, b);
    out.push({
      str: item.str,
      transform: item.transform,
      width: item.width,
      height: item.height,
      fontName: item.fontName,
      dir: item.dir,
      page,
      x: e,
      y: viewportHeight - (f + h),
      w,
      h,
      hasEOL: item.hasEOL,
      // A zero font matrix means the run was drawn invisibly (mode 3), which
      // is exactly what an OCR text layer looks like.
      isInvisible: fontSize === 0,
    });
  }
  return out;
}

function isTextItem(item: TextItem | TextMarkedContent): item is TextItem {
  return 'str' in item && typeof item.str === 'string';
}

export interface DocumentText {
  page: number;
  items: ExtractedTextItem[];
  raw: string;
}

/** Reading-order text for every page, in parallel-safe batches. */
export async function extractDocumentText(
  session: PdfSession,
  options: { pages?: number[]; onProgress?: (done: number, total: number) => void; batchSize?: number } = {},
): Promise<DocumentText[]> {
  const pages = options.pages ?? range(1, session.numPages);
  const batchSize = options.batchSize ?? 4;
  const out: DocumentText[] = [];
  for (let i = 0; i < pages.length; i += batchSize) {
    const chunk = pages.slice(i, i + batchSize);
    const results = await Promise.all(
      chunk.map(async (p) => {
        const items = await session.textItems(p);
        return { page: p, items, raw: joinReadingOrder(items) };
      }),
    );
    out.push(...results);
    options.onProgress?.(Math.min(i + batchSize, pages.length), pages.length);
  }
  return out;
}

/**
 * Group text runs into visual lines by baseline, then join. pdf.js already
 * yields items in content-stream order which is usually close to reading
 * order; line grouping fixes the two-column and table cases.
 */
export function joinReadingOrder(items: ExtractedTextItem[], tolerance = 3): string {
  const lines: ExtractedTextItem[][] = [];
  for (const item of items) {
    if (!item.str && !item.hasEOL) continue;
    const baseline = Math.round(item.y + item.h);
    const match = lines.find((l) => Math.abs(Math.round(l[0].y + l[0].h) - baseline) <= tolerance);
    if (match) match.push(item);
    else lines.push([item]);
  }
  return lines
    .map((line) =>
      [...line]
        .sort((a, b) => a.x - b.x)
        .map((i) => i.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .join('\n');
}

export function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

/**
 * Thumbnail strip. Renders incrementally and reports progress so a 500-page
 * document no longer blocks the UI on 500 base64 strings.
 */
export async function thumbnails(
  session: PdfSession,
  options: { maxSide?: number; pages?: number[]; onPage?: (index: number, url: string) => void; signal?: AbortSignal } = {},
): Promise<string[]> {
  const maxSide = options.maxSide ?? 140;
  const pages = options.pages ?? range(1, session.numPages);
  const urls: string[] = [];
  for (const p of pages) {
    if (options.signal?.aborted) throw new RenderCancelled('Thumbnail generation was cancelled.');
    const page = await session.doc.getPage(p);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(maxSide / base.width, maxSide / base.height, 2);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const ctx = canvas.getContext('2d');
    if (ctx) {
      await page.render({ canvasContext: ctx, viewport }).promise;
      const url = canvas.toDataURL('image/jpeg', 0.72);
      urls.push(url);
      options.onPage?.(p, url);
    } else {
      urls.push('');
    }
    page.cleanup();
    // Yield to the event loop so long documents stay responsive.
    await new Promise((r) => setTimeout(r, 0));
  }
  return urls;
}

/** Rasterise every page to a chosen image format. */
export async function rasterizePages(
  session: PdfSession,
  options: {
    format: ImageFormat;
    quality?: number;
    scale?: number;
    pages?: number[];
    filter?: string;
    background?: string;
    onProgress?: (done: number, total: number) => void;
  },
): Promise<{ name: string; blob: Blob }[]> {
  const pages = options.pages ?? range(1, session.numPages);
  const scale = options.scale ?? 2;
  const out: { name: string; blob: Blob }[] = [];
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const render = await session.renderPage(p, scale, {
      filter: options.filter,
      background: options.background,
    });
    // `renderPage` settles when the task is *scheduled*; the pixels land on
    // `finished`. Encoding `render.canvas` before that shipped a CBZ of blank
    // sheets: measured on the deployed build, six identical 23 690-byte JPEGs at
    // 0.00 % ink under a line that read "6 pages rendered at 200 dpi"
    // (`docs/research/cbz-bytes.mjs`). Same rule `renderToCanvas` learned in
    // `694e007` — a copied or encoded canvas is only worth what pdf.js has
    // painted into it by then.
    await render.finished;
    const blob = await canvasToBlob(render.canvas, options.format, options.quality ?? 0.92, {
      background: options.background,
    });
    out.push({
      name: `page-${String(p).padStart(3, '0')}.${extensionForImage(options.format)}`,
      blob,
    });
    render.cancel();
    options.onProgress?.(i + 1, pages.length);
  }
  return out;
}

export { canvasToBlob, extensionForImage };
export type { ImageFormat };

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new RenderCancelled('Cancelled before the PDF opened.'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new RenderCancelled('The PDF load was cancelled.'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

function isNamed(err: unknown, name: string): boolean {
  const e = err as { name?: string; message?: string };
  return e?.name === name || /password/i.test(String(e?.message ?? ''));
}

function asPasswordError(err: unknown): Error {
  if (isNamed(err, 'PasswordException')) {
    return new PasswordRequiredError('This PDF is password protected.');
  }
  return err instanceof Error ? err : new Error(String(err));
}

export type { PDFDocumentProxy, PDFPageProxy, TextContent, TextItem };
