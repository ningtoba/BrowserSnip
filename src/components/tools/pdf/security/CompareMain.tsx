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
}

let _state: CompareState = {
  sensitivity: 30,
  highlightColor: '#ff0000',
  page: 1,
  totalPages: 1,
  diffPercent: 0,
  diffPixels: 0,
  totalPixels: 0,
  diffRegions: 0,
};
let _listeners = new Set<() => void>();
function notify() { _listeners.forEach((fn) => fn()); }

export function getCompareState() { return _state; }
export function setCompareSensitivity(s: number) { _state.sensitivity = s; notify(); }
export function setCompareHighlightColor(c: string) { _state.highlightColor = c; notify(); }
export function setComparePage(p: number) { _state.page = p; notify(); }
export function subscribeCompare(fn: () => void) { _listeners.add(fn); return () => { _listeners.delete(fn); }; }

// ═══════════════════ Component ═══════════════════

const DISPLAY_SCALE = 1.0;

/**
 * How many separate changed areas a diff mask holds.
 *
 * A percentage of pixels is not something a user can check by eye; "4 changed
 * areas" is. Neighbouring changed pixels are joined on a coarse grid, so one
 * edited paragraph reads as one area and two edits in opposite corners read as
 * two, whatever the resolution the diff ran at.
 */
export function countDiffRegions(
  changed: Uint8Array,
  width: number,
  height: number,
  cell = 16,
): number {
  if (width <= 0 || height <= 0 || changed.length < width * height) return 0;
  const cols = Math.max(1, Math.ceil(width / cell));
  const rows = Math.max(1, Math.ceil(height / cell));
  const touched = new Uint8Array(cols * rows);
  for (let y = 0; y < height; y++) {
    const row = Math.min(rows - 1, Math.floor(y / cell));
    for (let x = 0; x < width; x++) {
      if (!changed[y * width + x]) continue;
      touched[row * cols + Math.min(cols - 1, Math.floor(x / cell))] = 1;
      break;
    }
  }
  // Flood fill over the coarse grid: 4-neighbourhood, so a diagonal scratch is
  // not joined to the line above it.
  const seen = new Uint8Array(cols * rows);
  let regions = 0;
  for (let start = 0; start < touched.length; start++) {
    if (!touched[start] || seen[start]) continue;
    regions += 1;
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const index = stack.pop()!;
      const col = index % cols;
      const row = (index - col) / cols;
      const neighbours = [col > 0 ? index - 1 : -1, col < cols - 1 ? index + 1 : -1, row > 0 ? index - cols : -1, row < rows - 1 ? index + cols : -1];
      for (const next of neighbours) {
        if (next < 0 || !touched[next] || seen[next]) continue;
        seen[next] = 1;
        stack.push(next);
      }
    }
  }
  return regions;
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
   * The unified frame the diff ran in. Both pages are bottom-aligned inside it,
   * which is what lets the overlay land on the words rather than a page-height
   * above or below them when the two documents differ in size.
   */
  const [diffBox, setDiffBox] = useState({ width: 0, height: 0 });

  useEffect(() => subscribeCompare(() => setSt({ ..._state })), []);

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
    const cA = canvasARef.current!;
    cA.width = vpAU.width; cA.height = vpAU.height;
    await pageA.render({ canvasContext: cA.getContext('2d')!, viewport: vpAU }).promise;

    // Render doc B
    const cB = canvasBRef.current!;
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

    // Build diff overlay
    const diffCanvas = diffCanvasRef.current!;
    diffCanvas.width = diffW;
    diffCanvas.height = diffH;
    const diffCtx = diffCanvas.getContext('2d')!;
    const diffImg = diffCtx.createImageData(diffW, diffH);
    const diffData = diffImg.data;

    const sensitivity = _state.sensitivity;
    const h = _state.highlightColor.replace('#', '');
    const hr = parseInt(h.substring(0, 2), 16);
    const hg = parseInt(h.substring(2, 4), 16);
    const hb = parseInt(h.substring(4, 6), 16);

    let diffCount = 0;
    const totalPixels = diffW * diffH;
    const changed = new Uint8Array(totalPixels);

    for (let p = 0; p < totalPixels; p++) {
      const i = p * 4;
      const dr = Math.abs(dataA[i] - dataB[i]);
      const dg = Math.abs(dataA[i + 1] - dataB[i + 1]);
      const db = Math.abs(dataA[i + 2] - dataB[i + 2]);
      const dist = dr + dg + db;

      if (dist > sensitivity) {
        diffData[i] = hr;
        diffData[i + 1] = hg;
        diffData[i + 2] = hb;
        diffData[i + 3] = Math.min(255, Math.round(dist * 1.5));
        diffCount++;
        changed[p] = 1;
      } else {
        diffData[i] = 0;
        diffData[i + 1] = 0;
        diffData[i + 2] = 0;
        diffData[i + 3] = 0;
      }
    }

    diffCtx.putImageData(diffImg, 0, 0);
    _state.diffPixels = diffCount;
    _state.totalPixels = totalPixels;
    _state.diffPercent = Math.round((diffCount / totalPixels) * 1000) / 10;
    _state.diffRegions = countDiffRegions(changed, diffW, diffH);
    notify();
    setDiffBox({ width: diffW, height: diffH });
  };

  // ── Render ──────────────────────────────────────────────

  const hasFiles = files.length >= 2;
  const diffPct = st.diffPercent;
  /** The counts a user can check, in the order they can check them. */
  const resultLine = st.diffPixels === 0
    ? `No differences found on page ${st.page} at this sensitivity — the export marks nothing.`
    : `${st.diffRegions} changed area${st.diffRegions === 1 ? '' : 's'} · ${st.diffPixels.toLocaleString()} of ${st.totalPixels.toLocaleString()} pixels (${diffPct}%) on page ${st.page}`;

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

  if (loading) {
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
          data-compare-identical={st.diffPixels === 0}
        >
          {resultLine}
        </span>
      </div>

      {/*
        One scroller for both documents: page turns, zoom and scroll are shared by
        construction, so the pair cannot drift apart mid-read. Both pages sit on
        the same baseline box, which is the frame the diff was computed in.
      */}
      <div data-compare-scroll className="flex-1 overflow-auto p-4">
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
