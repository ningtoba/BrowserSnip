/**
 * CompareMain — Visual PDF comparison overlay.
 *
 * Renders two PDFs side by side and highlights pixel differences
 * on the first document. Drag the threshold slider to control
 * sensitivity.
 */
import { useRef, useEffect, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import * as pdfjsLib from 'pdfjs-dist';
import { useFileStore } from '@/stores/file-store';
import { scaleIn } from '@/lib/motion';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs', import.meta.url,
).toString();

// ═══════════════════ Shared state ═══════════════════

interface CompareState {
  sensitivity: number;   // 0–255, pixel diff threshold
  highlightColor: string; // hex
  page: number;
  totalPages: number;    // min of both docs
  /** Share of the compared page's pixels that differ, one decimal. */
  diffPercent: number;
  /** Absolute pixel count behind `diffPercent`, so the number can be checked. */
  diffPixels: number;
  /** Pixels of the compared pair, at the resolution the diff ran at. */
  totalPixels: number;
  /** Separate changed areas, found by joining neighbouring changed pixels. */
  diffRegions: number;
  /**
   * Where the changed areas are, largest first, in points measured from the
   * top-left of the sheet in view (x right, y down) — the space the overlay is
   * painted in and the space `compare-pdfs` marks the export in.
   *
   * A percentage is not something a reader can check; "x 40–380, y 60–100 pt" is.
   */
  diffAreas: DiffArea[];
  /**
   * Whether the diff ran over document A's own page box rather than a taller
   * union frame. Two sheets of different heights share the larger box, and the
   * pane bottom-aligns them inside it, so the frame's top edge is then above
   * A's page and the areas no longer name a spot on it.
   */
  areasOnPage: boolean;
  /**
   * Whether the numbers beside these fields came from a diff that actually ran.
   *
   * Without it "0 % differ" means two different things — compared and equal, or
   * never compared at all — and the second one is exactly how this pane shipped
   * a verdict of “nothing differs” over pages it had not read.
   */
  compared: boolean;
}

/** One changed area, in points, from the top-left of what was compared. */
export interface DiffArea {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** How many areas the state carries; the count of the rest is in `diffRegions`. */
const AREA_LIMIT = 12;

let _state: CompareState = {
  sensitivity: 30,
  highlightColor: '#ff0000',
  page: 1,
  totalPages: 1,
  diffPercent: 0,
  diffPixels: 0,
  totalPixels: 0,
  diffRegions: 0,
  diffAreas: [],
  areasOnPage: true,
  compared: false,
};
let _listeners = new Set<() => void>();
function notify() { _listeners.forEach((fn) => fn()); }

/**
 * Repaints the overlay from the pixels last compared, at whatever threshold and
 * colour the state now holds. Installed by `CompareMain` while a pair is loaded.
 *
 * The panel invites the user to "lower the sensitivity to catch smaller changes",
 * so moving that slider has to move the answer — and it can do it without
 * rendering either page again, because a page's per-pixel distance does not
 * depend on the threshold the distance is judged at.
 */
let _repaint: (() => void) | null = null;

export function getCompareState() { return _state; }
export function setCompareSensitivity(s: number) { _state.sensitivity = s; _repaint?.(); notify(); }
export function setCompareHighlightColor(c: string) { _state.highlightColor = c; _repaint?.(); notify(); }
export function setComparePage(p: number) { _state.page = p; notify(); }
export function subscribeCompare(fn: () => void) { _listeners.add(fn); return () => { _listeners.delete(fn); }; }

// ═══════════════════ Component ═══════════════════

const DISPLAY_SCALE = 1.0;

/**
 * The pixels one compared pair was measured over.
 *
 * `scale` is device pixels per PDF point, so an area divided by it is in the
 * page's own points — the unit the export marks in and the unit the sentence
 * quotes.
 */
interface ComparedFrame {
  distance: Uint16Array;
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  scale: number;
  /** Device pixels from the frame's top edge to the top of document A's page. */
  originY: number;
  /** Whether that offset is zero, i.e. the frame *is* A's page box. */
  areasOnPage: boolean;
}

/** The highlight colour the overlay paints with, as three channels. */
function parseHighlight(value: string): [number, number, number] {
  const hex = value.replace('#', '');
  return [
    Number.parseInt(hex.substring(0, 2), 16) || 0,
    Number.parseInt(hex.substring(2, 4), 16) || 0,
    Number.parseInt(hex.substring(4, 6), 16) || 0,
  ];
}

/**
 * The separate changed areas a diff mask holds, largest first.
 *
 * A percentage of pixels is not something a user can check by eye; "4 changed
 * areas, the biggest where the clause was" is. Neighbouring changed pixels are
 * joined on a coarse grid, so one edited paragraph reads as one area and two
 * edits in opposite corners read as two, whatever the resolution the diff ran
 * at. The *bounds* are then taken from the pixels themselves, not from that
 * grid: a cell is only used to decide which changes belong together, so an area
 * reported at x 40–380 pt really does stop at 380.
 *
 * Coordinates are device pixels of the frame the mask was measured in, with the
 * right and bottom edges exclusive — the same convention
 * `docs/research/compare-measure.py` reports the exported marks in.
 */
export function diffAreasOf(
  changed: Uint8Array,
  width: number,
  height: number,
  cell = 16,
): DiffArea[] {
  if (width <= 0 || height <= 0 || changed.length < width * height) return [];
  const cols = Math.max(1, Math.ceil(width / cell));
  const rows = Math.max(1, Math.ceil(height / cell));
  const touched = new Uint8Array(cols * rows);
  for (let y = 0; y < height; y++) {
    const row = Math.min(rows - 1, Math.floor(y / cell));
    for (let x = 0; x < width; x++) {
      if (!changed[y * width + x]) continue;
      touched[row * cols + Math.min(cols - 1, Math.floor(x / cell))] = 1;
    }
  }
  // Flood fill over the coarse grid: 4-neighbourhood, so a diagonal scratch is
  // not joined to the line above it. `region` is the cell's id, or -1.
  const region = new Int32Array(cols * rows).fill(-1);
  let regions = 0;
  for (let start = 0; start < touched.length; start++) {
    if (!touched[start] || region[start] >= 0) continue;
    region[start] = regions;
    const stack = [start];
    while (stack.length > 0) {
      const index = stack.pop()!;
      const col = index % cols;
      const row = (index - col) / cols;
      const neighbours = [col > 0 ? index - 1 : -1, col < cols - 1 ? index + 1 : -1, row > 0 ? index - cols : -1, row < rows - 1 ? index + cols : -1];
      for (const next of neighbours) {
        if (next < 0 || !touched[next] || region[next] >= 0) continue;
        region[next] = regions;
        stack.push(next);
      }
    }
    regions += 1;
  }
  if (regions === 0) return [];
  const bounds = Array.from({ length: regions }, () => ({
    x0: width, y0: height, x1: -1, y1: -1,
  }));
  for (let y = 0; y < height; y++) {
    const row = Math.min(rows - 1, Math.floor(y / cell));
    for (let x = 0; x < width; x++) {
      if (!changed[y * width + x]) continue;
      const id = region[row * cols + Math.min(cols - 1, Math.floor(x / cell))];
      if (id < 0) continue;
      const box = bounds[id];
      if (x < box.x0) box.x0 = x;
      if (x > box.x1) box.x1 = x;
      if (y < box.y0) box.y0 = y;
      if (y > box.y1) box.y1 = y;
    }
  }
  return bounds
    .filter((box) => box.x1 >= 0)
    .map((box) => ({ x0: box.x0, y0: box.y0, x1: box.x1 + 1, y1: box.y1 + 1 }))
    .sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0));
}

/** How many separate changed areas a mask holds. */
export function countDiffRegions(
  changed: Uint8Array,
  width: number,
  height: number,
  cell = 16,
): number {
  return diffAreasOf(changed, width, height, cell).length;
}

/** The attribute spelling of an area, for a probe to read off the DOM. */
export function diffAreaAttribute(area: DiffArea): string {
  return [area.x0, area.y0, area.x1, area.y1].map((v) => Math.round(v * 10) / 10).join(',');
}

/** The sentence spelling: `x 40–380 · y 60–100 pt`, edges rounded to whole points. */
export function diffAreaWords(area: DiffArea): string {
  const pt = (v: number) => Math.round(v);
  return `x ${pt(area.x0)}–${pt(area.x1)} · y ${pt(area.y0)}–${pt(area.y1)} pt`;
}

export function CompareMain() {
  const canvasARef = useRef<HTMLCanvasElement>(null);
  const canvasBRef = useRef<HTMLCanvasElement>(null);
  const diffCanvasRef = useRef<HTMLCanvasElement>(null);
  const files = useFileStore((s) => s.files);

  const [loading, setLoading] = useState(true);
  const [st, setSt] = useState<CompareState>(_state);
  const [pageCount, setPageCount] = useState(1);
  /**
   * The pixels the last pair was measured over, kept so the threshold and the
   * highlight colour can be re-applied without rendering either page again.
   */
  const compared = useRef<ComparedFrame | null>(null);
  /**
   * The unified frame the diff ran in. Both pages are bottom-aligned inside it,
   * which is what lets the overlay land on the words rather than a page-height
   * above or below them when the two documents differ in size.
   */
  const [diffBox, setDiffBox] = useState({ width: 0, height: 0 });

  useEffect(() => subscribeCompare(() => setSt({ ..._state })), []);

  // The store outlives the pane: a repaint bound to an unmounted canvas would
  // answer a slider move with pixels nobody is looking at. Unmount only — an
  // effect without a dependency list would clear this on every re-render, and the
  // pane re-renders on every notification it publishes.
  useEffect(() => () => {
    _repaint = null;
    compared.current = null;
  }, []);

  // ── Load and render both PDFs ─────────────────────────────

  useEffect(() => {
    if (files.length < 2) { setLoading(false); return; }
    setLoading(true);

    const run = async () => {
      try {
        const [bufA, bufB] = await Promise.all([files[0].arrayBuffer(), files[1].arrayBuffer()]);
        const [taskA, taskB] = [pdfjsLib.getDocument({ data: bufA }), pdfjsLib.getDocument({ data: bufB })];
        const [docA, docB] = await Promise.all([taskA.promise, taskB.promise]);

        const totalPages = Math.min(docA.numPages, docB.numPages);
        setPageCount(totalPages);
        _state.totalPages = totalPages;
        _state.compared = false;

        await renderPagePair(docA, docB, Math.min(_state.page, totalPages));
        setLoading(false);
      } catch { setLoading(false); }
    };
    run();
  }, [files]);
  // Re-render on page change
  useEffect(() => {
    if (!files[0] || !files[1] || loading) return;
    let cancelled = false;
    const opened: pdfjsLib.PDFDocumentProxy[] = [];
    const run = async () => {
      try {
        const [bufA, bufB] = await Promise.all([files[0].arrayBuffer(), files[1].arrayBuffer()]);
        const [taskA, taskB] = [pdfjsLib.getDocument({ data: bufA }), pdfjsLib.getDocument({ data: bufB })];
        const [docA, docB] = await Promise.all([taskA.promise, taskB.promise]);
        // A page change used to leak both documents: pdf.js keeps a worker and
        // WASM buffers per proxy until it is destroyed explicitly.
        opened.push(docA, docB);
        if (cancelled) return;
        await renderPagePair(docA, docB, Math.min(st.page, pageCount));
      } catch {
        /* the next page render reports the failure */
      } finally {
        if (cancelled) for (const doc of opened) void doc.destroy();
      }
    };
    run();
    return () => {
      cancelled = true;
      for (const doc of opened) void doc.destroy();
    };
  }, [st.page]);

  const renderPagePair = async (docA: pdfjsLib.PDFDocumentProxy, docB: pdfjsLib.PDFDocumentProxy, pageNum: number) => {
    const [pageA, pageB] = await Promise.all([
      docA.getPage(pageNum),
      docB.getPage(pageNum),
    ]);

    // Render both at the same dimensions (use the larger one)
    const vpA = pageA.getViewport({ scale: 1 });
    const vpB = pageB.getViewport({ scale: 1 });
    const maxW = Math.max(vpA.width, vpB.width);
    const maxH = Math.max(vpA.height, vpB.height);

    const vpAU = pageA.getViewport({ scale: DISPLAY_SCALE });
    const vpBU = pageB.getViewport({ scale: DISPLAY_SCALE });

    // Render doc A
    const cA = canvasARef.current;
    const cB = canvasBRef.current;
    const overlayCanvas = diffCanvasRef.current;
    if (!cA || !cB || !overlayCanvas) {
      // The canvases stay mounted for as long as a pair is loaded — the loading
      // state is an overlay on the sheet, not a replacement for it — so this only
      // fires for a render attempted against a DOM that is not up yet. That used to
      // be the normal case: the first pair was attempted while the placeholder held
      // the page, threw on a null canvas, and left the panel reporting “Nothing
      // differs on the page in view” over sheets it had never painted. Say so, and
      // report no verdict rather than an all-clear one.
      _state.compared = false;
      _repaint = null;
      notify();
      return;
    }
    cA.width = vpAU.width; cA.height = vpAU.height;
    await pageA.render({ canvasContext: cA.getContext('2d')!, viewport: vpAU }).promise;

    // Render doc B
    cB.width = vpBU.width; cB.height = vpBU.height;
    await pageB.render({ canvasContext: cB.getContext('2d')!, viewport: vpBU }).promise;

    // Compute diff at unified resolution
    const diffScale = DISPLAY_SCALE;
    const diffW = Math.round(maxW * diffScale);
    const diffH = Math.round(maxH * diffScale);

    const tmpA = document.createElement('canvas'); tmpA.width = diffW; tmpA.height = diffH;
    const ctxA = tmpA.getContext('2d')!;
    ctxA.fillStyle = '#ffffff'; ctxA.fillRect(0, 0, diffW, diffH);
    ctxA.drawImage(cA, 0, 0, vpAU.width, vpAU.height, 0, diffH - vpAU.height, vpAU.width, vpAU.height);

    const tmpB = document.createElement('canvas'); tmpB.width = diffW; tmpB.height = diffH;
    const ctxB = tmpB.getContext('2d')!;
    ctxB.fillStyle = '#ffffff'; ctxB.fillRect(0, 0, diffW, diffH);
    ctxB.drawImage(cB, 0, 0, vpBU.width, vpBU.height, 0, diffH - vpBU.height, vpBU.width, vpBU.height);

    const dataA = ctxA.getImageData(0, 0, diffW, diffH).data;
    const dataB = ctxB.getImageData(0, 0, diffW, diffH).data;

    // The per-pixel distance, which is the half that does not depend on the
    // threshold. `publishDiff` judges these numbers, so moving the sensitivity
    // slider re-answers from pixels already read instead of rendering both pages
    // again — and the verdict beside the slider stays the verdict the setting gives.
    const distance = new Uint16Array(diffW * diffH);
    for (let p = 0; p < distance.length; p++) {
      const i = p * 4;
      distance[p] = Math.abs(dataA[i] - dataB[i])
        + Math.abs(dataA[i + 1] - dataB[i + 1])
        + Math.abs(dataA[i + 2] - dataB[i + 2]);
    }
    compared.current = {
      distance,
      canvas: overlayCanvas,
      width: diffW,
      height: diffH,
      scale: diffScale,
      // Both sheets are bottom-aligned inside the frame, so the frame's top edge is
      // this many device pixels above the top of A's page — the offset the reported
      // areas are measured back down by.
      originY: diffH - vpAU.height,
      areasOnPage: diffW === vpAU.width && diffH === vpAU.height,
    };
    publishDiff();
    _repaint = publishDiff;
    setDiffBox({ width: diffW, height: diffH });
  };

  /**
   * Paint the overlay and publish the counts from the pixels last compared.
   *
   * This is the verdict the user reads: every number on it is a measurement of the
   * two painted canvases, and the areas are given in the page's own points so the
   * sentence can be checked against the sheet beside it.
   */
  const publishDiff = () => {
    const frame = compared.current;
    if (!frame) return;
    const { distance, canvas, width, height, scale, originY } = frame;
    canvas.width = width;
    canvas.height = height;
    const diffCtx = canvas.getContext('2d');
    if (!diffCtx) return;
    const diffImg = diffCtx.createImageData(width, height);
    const diffData = diffImg.data;
    const sensitivity = _state.sensitivity;
    const [hr, hg, hb] = parseHighlight(_state.highlightColor);

    let diffCount = 0;
    const totalPixels = width * height;
    const changed = new Uint8Array(totalPixels);

    for (let p = 0; p < totalPixels; p++) {
      const dist = distance[p];
      if (dist <= sensitivity) continue;
      const i = p * 4;
      diffData[i] = hr;
      diffData[i + 1] = hg;
      diffData[i + 2] = hb;
      diffData[i + 3] = Math.min(255, Math.round(dist * 1.5));
      diffCount += 1;
      changed[p] = 1;
    }

    diffCtx.putImageData(diffImg, 0, 0);
    _state.diffPixels = diffCount;
    _state.totalPixels = totalPixels;
    _state.diffPercent = Math.round((diffCount / totalPixels) * 1000) / 10;
    const areas = diffAreasOf(changed, width, height).map((area) => ({
      x0: area.x0 / scale,
      y0: (area.y0 - originY) / scale,
      x1: area.x1 / scale,
      y1: (area.y1 - originY) / scale,
    }));
    _state.diffRegions = areas.length;
    _state.diffAreas = areas.slice(0, AREA_LIMIT);
    _state.areasOnPage = frame.areasOnPage;
    _state.compared = true;
    notify();
  };

  // ── Render ──────────────────────────────────────────────

  const hasFiles = files.length >= 2;
  const diffPct = st.diffPercent;
  /**
   * The counts a user can check, in the order they can check them.
   *
   * Three states, because there are three answers: nothing compared yet, compared
   * and equal, compared and changed. Folding the first into the second is how a
   * pane that never painted a pixel said “Nothing differs on the page in view”.
   */
  const largest = st.diffAreas[0];
  const resultLine = !st.compared
    ? 'Neither page has been read yet — no comparison has run.'
    : st.diffPixels === 0
      ? `No differences found on page ${st.page} at this sensitivity — the export marks nothing.`
      : `${st.diffRegions} changed area${st.diffRegions === 1 ? '' : 's'} · ${st.diffPixels.toLocaleString()} of ${st.totalPixels.toLocaleString()} pixels (${diffPct}%) on page ${st.page}${
        largest ? ` · largest at ${diffAreaWords(largest)} from the ${st.areasOnPage ? "page's" : "compared sheet's"} top-left${
          st.diffRegions > st.diffAreas.length ? ` · ${st.diffRegions - st.diffAreas.length} more` : ''
        }` : ''
      }`;

  if (!hasFiles && !loading) {
    return (
      <div className="flex h-full items-center justify-center opacity-40">
        <motion.div
          initial="hidden"
          animate="visible"
          variants={scaleIn}
          className="text-center space-y-2"
        >
          <span className="text-5xl block">🔍</span>
          <p className="text-xs text-ink-muted">Add two PDFs to compare them side by side</p>
        </motion.div>
      </div>
    );
  }

  if (loading && !hasFiles) {
    return (
      <div className="flex h-full items-center justify-center animate-pulse">
        <span className="text-4xl">🔍</span>
      </div>
    );
  }

  return (
    <div className="relative flex-1 overflow-hidden flex flex-col">
      {/* Page nav + info */}
      <div className="flex items-center justify-between shrink-0 px-3 py-1.5 border-b border-cream-border bg-cream-light">
        <div className="flex items-center gap-2">
          {pageCount > 1 && (
            <>
              <button onClick={() => setComparePage(Math.max(1, st.page - 1))}
                disabled={st.page <= 1}
                className="doodle-chip text-[10px] doodle-chip-inactive disabled:opacity-30">◂ Prev</button>
              <span className="text-[11px] text-ink-muted tabular-nums">{st.page} / {pageCount}</span>
              <button onClick={() => setComparePage(Math.min(pageCount, st.page + 1))}
                disabled={st.page >= pageCount}
                className="doodle-chip text-[10px] doodle-chip-inactive disabled:opacity-30">Next ▸</button>
            </>
          )}
        </div>
        <span
          className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted/70"
          role="status"
          aria-live="polite"
          data-compare-counts={st.diffRegions}
          data-compare-pixels={st.diffPixels}
          data-compare-read={st.compared}
          data-compare-identical={st.compared && st.diffPixels === 0}
          data-compare-area={largest ? diffAreaAttribute(largest) : undefined}
        >
          {resultLine}
        </span>
      </div>

      {/*
        One scroller for both documents: page turns, zoom and scroll are shared by
        construction, so the pair cannot drift apart mid-read. Both pages sit on
        the same baseline box, which is the frame the diff was computed in.
      */}
      <div data-compare-scroll className="relative flex-1 overflow-auto p-4">
        {/*
          The loading state sits *over* the sheets instead of replacing them: these
          two canvases are what the verdict is measured from, and unmounting them
          while the pair loads is what let the first comparison throw on a null
          canvas and report "nothing differs" for pages it had never painted.
        */}
        {loading && (
          <div
            data-compare-loading
            className="absolute inset-0 z-10 flex items-center justify-center bg-cream/80"
          >
            <span className="animate-pulse text-4xl">🔍</span>
          </div>
        )}
        <div className="flex gap-4 justify-center items-start min-h-full">
          {/* Document A */}
          <div className="relative shrink-0" style={{ lineHeight: 0 }}>
            <p className="text-[10px] text-ink-muted mb-1 text-center truncate max-w-[300px]">A · {files[0]?.name}</p>
            <div
              className="relative"
              style={diffBox.width > 0
                ? { width: diffBox.width, height: diffBox.height, display: 'flex', alignItems: 'flex-end' }
                : undefined}
            >
              <canvas ref={canvasARef} className="shadow-doodle-card rounded-md block" />
              {/* Diff overlay, in the same unified frame as the comparison */}
              <canvas
                ref={diffCanvasRef}
                data-compare-overlay
                className="absolute top-0 left-0 rounded-md"
                style={{ mixBlendMode: 'multiply', pointerEvents: 'none', width: '100%', height: '100%' }}
              />
            </div>
          </div>

          {/* Document B */}
          <div className="relative shrink-0" style={{ lineHeight: 0 }}>
            <p className="text-[10px] text-ink-muted mb-1 text-center truncate max-w-[300px]">B · {files[1]?.name}</p>
            <div
              className="relative"
              style={diffBox.width > 0
                ? { width: diffBox.width, height: diffBox.height, display: 'flex', alignItems: 'flex-end' }
                : undefined}
            >
              <canvas ref={canvasBRef} className="shadow-doodle-card rounded-md block" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
