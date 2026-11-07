/**
 * RedactMain — Visual PDF redaction overlay.
 *
 * Drag across words to mark them: the band snaps to the real text lines from the
 * page's text layer, so a redaction covers the words and not the leading above
 * them, and one drag leaves one object carrying one box per line. A drag that
 * catches no words creates nothing and says so — an empty box is the one thing a
 * redaction must never be. Holding Shift marks an area instead (a photograph, a
 * scanned page with no text layer). Click a mark to select it, drag to move, handles
 * to resize, arrows to nudge, `Ctrl/Cmd-D` to duplicate, Delete to remove, Escape
 * to deselect.
 */
import { useRef, useEffect, useState, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { useFileStore } from '@/stores/file-store';
import { toExtractedItems, type ExtractedTextItem } from '@/lib/pdf/core/render';
import { snapTextLines, type SnappedLine } from '@/components/tools/pdf/editor/quads';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs', import.meta.url,
).toString();

// ═══════════════════ Shared state ═══════════════════

export interface Redaction {
  id: string;
  page: number;
  x: number;      // fraction 0–1 of page width
  y: number;      // fraction 0–1 of page height (bottom-left origin)
  w: number;      // fraction of page width
  h: number;      // fraction of page height
  /**
   * One box per text line the drag caught, in the same fraction space.
   *
   * Present whenever the mark came from words, which is the normal case: the
   * engine then deletes each line's text and paints each line's box, instead of
   * blacking out the gap between the first and last word of a paragraph.
   */
  lines?: RedactionLine[];
  /** True for a Shift-drag area mark, which covers pixels rather than words. */
  free?: boolean;
}

/** One line of a redaction, as page fractions. */
export interface RedactionLine {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface RedactState {
  page: number;
  totalPages: number;
  redactions: Redaction[];
  selectedId: string | null;
  color: string;
}

let _state: RedactState = { page: 1, totalPages: 1, redactions: [], selectedId: null, color: '#000000' };
let _pageW = 595;
let _pageH = 842;
let _redactionSeq = 0;
let _listeners = new Set<() => void>();
function notify() { _listeners.forEach((fn) => fn()); }

export function getRedactState() { return _state; }
export function getRedactPageSize() { return { width: _pageW, height: _pageH }; }
export function setRedactPage(p: Partial<Pick<RedactState, 'page' | 'totalPages'>>) { _state = { ..._state, ...p }; notify(); }
export function setRedactColor(c: string) { _state = { ..._state, color: c }; notify(); }
export function addRedaction(r: Omit<Redaction, 'id' | 'page'>) {
  const full: Redaction = { ...r, id: `r-${++_redactionSeq}`, page: _state.page };
  _state = { ..._state, redactions: [..._state.redactions, full], selectedId: full.id };
  notify();
}
export function updateRedaction(id: string, patch: Partial<Redaction>) {
  _state = { ..._state, redactions: _state.redactions.map((r) => r.id === id ? { ...r, ...patch } : r) };
  notify();
}
export function removeRedaction(id: string) {
  const next = _state.redactions.filter((r) => r.id !== id);
  _state = { ..._state, redactions: next, selectedId: _state.selectedId === id ? (next[next.length - 1]?.id ?? null) : _state.selectedId };
  notify();
}
export function selectRedaction(id: string | null) { _state = { ..._state, selectedId: id }; notify(); }
export function subscribeRedact(fn: () => void) { _listeners.add(fn); return () => { _listeners.delete(fn); }; }

// ═══════════════════ Component ═══════════════════

const DISPLAY_SCALE = 1.0;
/** Visible handle size, and the extra transparent slop around it (brief: ≥8 px). */
const HANDLE_SIZE = 10;
const HANDLE_SLOP = 6;
/** Below this a drag is a mouse twitch, not an intention. */
const MIN_DRAG_FRAC = 0.003;
/** A resized mark never shrinks below this fraction of the page. */
const MIN_SIZE_FRAC = 0.01;

/**
 * Turn the lines a drag caught into one mark: the boxes as page fractions, plus
 * the bounding box the overlay drags and resizes.
 *
 * Returns `null` for a drag that caught nothing, which is what keeps an empty
 * rectangle out of the document.
 */
export function redactionFromLines(
  lines: SnappedLine[],
  canvas: { width: number; height: number },
): { lines: RedactionLine[]; box: RedactionLine } | null {
  if (lines.length === 0 || canvas.width <= 0 || canvas.height <= 0) return null;
  const boxes = lines.map((line) => {
    const x = line.x0 / canvas.width;
    const right = line.x1 / canvas.width;
    // Viewport space is top-down; the model is bottom-up PDF space.
    const top = line.y0 / canvas.height;
    const bottom = line.y1 / canvas.height;
    return { x, y: 1 - bottom, w: Math.max(0, right - x), h: Math.max(0, bottom - top) };
  });
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.w));
  const top = Math.max(...boxes.map((b) => b.y + b.h));
  return { lines: boxes, box: { x, y, w: right - x, h: top - y } };
}

/** The regions to hand the engine: one per line, or the box for an area mark. */
export function redactionRegions(
  redaction: Redaction,
  pageSizePt: { width: number; height: number },
): { page: number; x: number; y: number; width: number; height: number }[] {
  const source = redaction.lines && redaction.lines.length > 0 ? redaction.lines : [redaction];
  return source.map((box) => ({
    page: redaction.page - 1,
    x: Math.round(box.x * pageSizePt.width),
    y: Math.round(box.y * pageSizePt.height),
    width: Math.max(1, Math.round(box.w * pageSizePt.width)),
    height: Math.max(1, Math.round(box.h * pageSizePt.height)),
  }));
}

/** Move a mark's line boxes by the same page-fraction delta as its bounds. */
export function translateLines(lines: RedactionLine[], dx: number, dy: number): RedactionLine[] {
  return lines.map((line) => ({
    ...line,
    x: Math.max(0, Math.min(1 - line.w, line.x + dx)),
    y: Math.max(0, Math.min(1 - line.h, line.y + dy)),
  }));
}

/**
 * Scale a mark's line boxes with the box they belong to.
 *
 * Resizing a word mark by hand is rare (dragging the band again is the normal
 * gesture), but the lines must never drift off the words they were snapped to.
 */
export function scaleLines(
  lines: RedactionLine[],
  from: { x: number; y: number; w: number; h: number },
  to: { x: number; y: number; w: number; h: number },
): RedactionLine[] {
  if (from.w <= 0 || from.h <= 0) return lines;
  const sx = to.w / from.w;
  const sy = to.h / from.h;
  return lines.map((line) => ({
    x: to.x + (line.x - from.x) * sx,
    y: to.y + (line.y - from.y) * sy,
    w: line.w * sx,
    h: line.h * sy,
  }));
}

export function RedactMain() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const file = useFileStore((s) => s.file);

  const [loading, setLoading] = useState(true);
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [st, setSt] = useState<RedactState>(_state);
  const [canvasDims, setCanvasDims] = useState({ w: 0, h: 0 });
  /** The current page's text runs, in viewport space, for line snapping. */
  const itemsRef = useRef<ExtractedTextItem[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => subscribeRedact(() => setSt({ ..._state })), []);

  // ── Load PDF ────────────────────────────────────────────────

  useEffect(() => {
    if (!file) { setLoading(false); return; }
    const load = async () => {
      try {
        const buf = await file.arrayBuffer();
        const doc = await pdfjsLib.getDocument({ data: buf }).promise;
        setPdfDoc(doc);
        setRedactPage({ totalPages: doc.numPages });
        const pageIdx = Math.min(_state.page - 1, doc.numPages - 1);
        const page = await doc.getPage(pageIdx + 1);
        const natVp = page.getViewport({ scale: 1 });
        _pageW = natVp.width; _pageH = natVp.height;
        itemsRef.current = toExtractedItems(await page.getTextContent(), pageIdx + 1, natVp.height);
        const vp = page.getViewport({ scale: DISPLAY_SCALE });
        canvasRef.current!.width = vp.width;
        canvasRef.current!.height = vp.height;
        setCanvasDims({ w: vp.width, h: vp.height });
        await page.render({ canvasContext: canvasRef.current!.getContext('2d')!, viewport: vp }).promise;
        setLoading(false);
      } catch { setLoading(false); }
    };
    load();
  }, [file]);

  // ── Re-render on page change ────────────────────────────────

  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return;
    (async () => {
      try {
        const pageIdx = Math.min(st.page - 1, pdfDoc.numPages - 1);
        const page = await pdfDoc.getPage(pageIdx + 1);
        const vp = page.getViewport({ scale: DISPLAY_SCALE });
        canvasRef.current!.width = vp.width;
        canvasRef.current!.height = vp.height;
        setCanvasDims({ w: vp.width, h: vp.height });
        itemsRef.current = toExtractedItems(await page.getTextContent(), pageIdx + 1, vp.height);
        await page.render({ canvasContext: canvasRef.current!.getContext('2d')!, viewport: vp }).promise;
      } catch { /* render error */ }
    })();
  }, [pdfDoc, st.page]);

  // ── Keyboard ────────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && _state.selectedId) {
        removeRedaction(_state.selectedId);
      }
      if (e.key === 'Escape') selectRedaction(null);
      // One level at a time: Escape only deselects, it never closes the pane.
      const step = e.shiftKey ? 0.02 : 0.002;
      const selected = _state.redactions.find((r) => r.id === _state.selectedId);
      if (selected && (e.key === 'd' || e.key === 'D') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        addRedaction({
          x: Math.min(1 - selected.w, selected.x + step),
          y: Math.min(1 - selected.h, selected.y + step),
          w: selected.w,
          h: selected.h,
          lines: selected.lines?.map((line) => ({
            ...line,
            x: Math.min(1 - line.w, line.x + step),
            y: Math.min(1 - line.h, line.y + step),
          })),
          free: selected.free,
        });
      }
      if (selected && e.key.startsWith('Arrow')) {
        e.preventDefault();
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0;
        const move = (box: RedactionLine): RedactionLine => ({
          ...box,
          x: Math.max(0, Math.min(1 - box.w, box.x + dx)),
          y: Math.max(0, Math.min(1 - box.h, box.y + dy)),
        });
        updateRedaction(selected.id, {
          ...move(selected),
          lines: selected.lines?.map(move),
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ═══════════════════ Drag, Move & Resize ═══════════════════

  const dragRef = useRef<{
    mode: 'draw' | 'move' | 'resize';
    id?: string;
    handle?: string;
    startX: number; startY: number;
    origX?: number; origY?: number; origW?: number; origH?: number;
    /** True when the drag started with Shift held: an area mark, not a word mark. */
    free?: boolean;
  } | null>(null);
  const [drawing, setDrawing] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const onStartDraw = useCallback((e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    if (!overlayRef.current) return;
    const rect = overlayRef.current.getBoundingClientRect();
    // Shift is the deliberate "mark an area, not words" gesture: photographs and
    // scanned pages with no text layer have no lines to snap to.
    dragRef.current = { mode: 'draw', startX: e.clientX, startY: e.clientY, free: e.shiftKey };
    const fx = (e.clientX - rect.left) / rect.width;
    const fy = 1 - (e.clientY - rect.top) / rect.height;
    setDrawing({ x: fx, y: fy, w: 0, h: 0 });
    setNotice(null);
    selectRedaction(null);
  }, []);

  const onStartMove = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const r = _state.redactions.find((rr) => rr.id === id);
    if (!r) return;
    selectRedaction(id);
    dragRef.current = {
      mode: 'move', id, handle: 'move',
      startX: e.clientX, startY: e.clientY,
      origX: r.x, origY: r.y, origW: r.w, origH: r.h,
    };
  }, []);

  const onStartResize = useCallback((e: React.MouseEvent, id: string, handle: string) => {
    e.stopPropagation();
    const r = _state.redactions.find((rr) => rr.id === id);
    if (!r) return;
    dragRef.current = {
      mode: 'resize', id, handle,
      startX: e.clientX, startY: e.clientY,
      origX: r.x, origY: r.y, origW: r.w, origH: r.h,
    };
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d || !overlayRef.current) return;
      const rect = overlayRef.current.getBoundingClientRect();

      if (d.mode === 'draw') {
        const fx1 = (d.startX - rect.left) / rect.width;
        const fy1 = 1 - (d.startY - rect.top) / rect.height;
        const fx2 = (e.clientX - rect.left) / rect.width;
        const fy2 = 1 - (e.clientY - rect.top) / rect.height;
        setDrawing({ x: Math.min(fx1, fx2), y: Math.min(fy1, fy2), w: Math.abs(fx2 - fx1), h: Math.abs(fy2 - fy1) });
      } else if (d.mode === 'move') {
        const dx = (e.clientX - d.startX) / rect.width;
        const dy = -(e.clientY - d.startY) / rect.height;
        const newX = Math.max(0, Math.min(1 - d.origW!, d.origX! + dx));
        const newY = Math.max(0, Math.min(1 - d.origH!, d.origY! + dy));
        const current = _state.redactions.find((r) => r.id === d.id);
        updateRedaction(d.id!, {
          x: newX,
          y: newY,
          // The lines ride along, or a snapped mark stops covering its words.
          lines: current?.lines
            ? translateLines(current.lines, newX - current.x, newY - current.y)
            : current?.lines,
        });
      } else if (d.mode === 'resize') {
        const dx = (e.clientX - d.startX) / rect.width;
        const dy = -(e.clientY - d.startY) / rect.height;
        let nx = d.origX!, ny = d.origY!, nw = d.origW!, nh = d.origH!;
        switch (d.handle) {
          case 'e':  nw = Math.max(MIN_SIZE_FRAC, d.origW! + dx); break;
          case 'w':  nw = Math.max(MIN_SIZE_FRAC, d.origW! - dx); nx = d.origX! + (d.origW! - nw); break;
          case 'n':  nh = Math.max(MIN_SIZE_FRAC, d.origH! + dy); break;
          case 's':  nh = Math.max(MIN_SIZE_FRAC, d.origH! - dy); ny = d.origY! + (d.origH! - nh); break;
          case 'ne': nw = Math.max(MIN_SIZE_FRAC, d.origW! + dx); nh = Math.max(MIN_SIZE_FRAC, d.origH! + dy); break;
          case 'nw': nw = Math.max(MIN_SIZE_FRAC, d.origW! - dx); nh = Math.max(MIN_SIZE_FRAC, d.origH! + dy); nx = d.origX! + (d.origW! - nw); break;
          case 'se': nw = Math.max(MIN_SIZE_FRAC, d.origW! + dx); nh = Math.max(MIN_SIZE_FRAC, d.origH! - dy); ny = d.origY! + (d.origH! - nh); break;
          case 'sw': nw = Math.max(MIN_SIZE_FRAC, d.origW! - dx); nh = Math.max(MIN_SIZE_FRAC, d.origH! - dy); nx = d.origX! + (d.origW! - nw); ny = d.origY! + (d.origH! - nh); break;
        }
        nx = Math.max(0, Math.min(1 - nw, nx));
        ny = Math.max(0, Math.min(1 - nh, ny));
        const before = _state.redactions.find((r) => r.id === d.id);
        updateRedaction(d.id!, {
          x: nx,
          y: ny,
          w: nw,
          h: nh,
          lines: before?.lines
            ? scaleLines(before.lines, { x: before.x, y: before.y, w: before.w, h: before.h }, { x: nx, y: ny, w: nw, h: nh })
            : before?.lines,
        });
      }
    };
    const onUp = () => {
      const gesture = dragRef.current;
      if (gesture?.mode === 'draw' && drawing) {
        if (drawing.w > MIN_DRAG_FRAC && drawing.h > MIN_DRAG_FRAC) {
          if (gesture.free) {
            addRedaction({ ...drawing, free: true });
            setNotice('Area mark added — it covers pixels, so this page will be re-rendered.');
          } else {
            const snapped = redactionFromLines(
              snapTextLines(itemsRef.current, {
                x0: drawing.x * canvasDims.w,
                y0: (1 - drawing.y - drawing.h) * canvasDims.h,
                x1: (drawing.x + drawing.w) * canvasDims.w,
                y1: (1 - drawing.y) * canvasDims.h,
              }),
              { width: canvasDims.w, height: canvasDims.h },
            );
            if (snapped) {
              addRedaction({ ...snapped.box, lines: snapped.lines });
              setNotice(
                snapped.lines.length > 1
                  ? `Marked ${snapped.lines.length} lines of text as one redaction.`
                  : 'Marked one line of text.',
              );
            } else {
              // Nothing was created, and the pane says why plus the way round it.
              setNotice(
                `Page ${_state.page} has no words under that box, so nothing was marked. Drag again across the text, or hold Shift to mark an area of a photograph.`,
              );
            }
          }
        }
        setDrawing(null);
      }
      dragRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [drawing]);

  // ═══════════════════ Helpers ═══════════════════

  /**
   * A `HANDLE_SIZE` square with `HANDLE_SLOP` of invisible grab room on every
   * side, so the pointer target is 22 px while the mark still reads as a corner.
   */
  const handleStyle = (x: number, y: number, cursor: string): React.CSSProperties => ({
    position: 'absolute', left: x - (HANDLE_SIZE + HANDLE_SLOP * 2) / 2, top: y - (HANDLE_SIZE + HANDLE_SLOP * 2) / 2,
    width: HANDLE_SIZE + HANDLE_SLOP * 2, height: HANDLE_SIZE + HANDLE_SLOP * 2,
    display: 'grid', placeItems: 'center', cursor, zIndex: 25, background: 'transparent',
  });

  const handleFace: React.CSSProperties = {
    width: HANDLE_SIZE, height: HANDLE_SIZE,
    background: '#DC2626', border: '2px solid white', borderRadius: 2,
    boxShadow: '0 0 0 1px rgba(27,27,24,0.18)',
  };

  const getOverlayRect = (r: Redaction) => {
    const left = r.x * canvasDims.w;
    const top = (1 - r.y - r.h) * canvasDims.h;
    return { left, top, width: r.w * canvasDims.w, height: r.h * canvasDims.h };
  };

  const pageRedactions = st.redactions.filter((r) => r.page === st.page);
  const rgb = ((h: string) => { const x = h.replace('#', ''); return { r: parseInt(x.substring(0,2),16), g: parseInt(x.substring(2,4),16), b: parseInt(x.substring(4,6),16) }; })(st.color);
  const fillColor = `rgba(${rgb.r},${rgb.g},${rgb.b},0.5)`;

  // ═══════════════════ Render ═══════════════════

  const hasPdf = !loading && pdfDoc;

  if (!file && !loading) {
    return <div className="flex h-full items-center justify-center opacity-40"><span className="text-5xl">🟦</span></div>;
  }
  if (loading) {
    return <div className="flex h-full items-center justify-center animate-pulse"><span className="text-4xl">🟦</span></div>;
  }

  return (
    <div className="relative flex-1 overflow-hidden flex flex-col">
      <div className="flex items-center justify-between shrink-0 px-3 py-1.5 border-b border-cream-border bg-cream-light">
        <div className="flex items-center gap-2">
          {hasPdf && st.totalPages > 1 && (
            <>
              <button onClick={() => setRedactPage({ page: Math.max(1, st.page - 1) })}
                disabled={st.page <= 1}
                className="doodle-chip text-[10px] doodle-chip-inactive disabled:opacity-30">◂ Prev</button>
              <span className="text-[11px] text-ink-muted tabular-nums min-w-[4rem] text-center">{st.page} / {st.totalPages}</span>
              <button onClick={() => setRedactPage({ page: Math.min(st.totalPages, st.page + 1) })}
                disabled={st.page >= st.totalPages}
                className="doodle-chip text-[10px] doodle-chip-inactive disabled:opacity-30">Next ▸</button>
            </>
          )}
        </div>
        <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted/70">
          {/* Each line is written separately, so the number is worth showing. */}
          {pageRedactions.length} mark{pageRedactions.length !== 1 ? 's' : ''} ·{' '}
          {pageRedactions.reduce((total, r) => total + (r.lines?.length ?? 1), 0)} region
          {pageRedactions.reduce((total, r) => total + (r.lines?.length ?? 1), 0) === 1 ? '' : 's'} · Drag across words
        </span>
      </div>

      {/* What the last drag did, or why it did nothing. */}
      <p
        role="status"
        aria-live="polite"
        data-redact-notice={notice ? 'shown' : 'idle'}
        className={`shrink-0 px-3 py-1 text-[10px] leading-relaxed ${
          notice ? 'border-b border-cream-border bg-cream-soft text-ink-soft' : 'hidden'
        }`}
      >
        {notice}
      </p>

      <div className="flex-1 overflow-auto flex items-center justify-center p-4">
        <div className="relative shrink-0" style={{ lineHeight: 0 }}>
          <canvas ref={canvasRef} className="shadow-doodle-card rounded-md" />

          {canvasDims.w > 0 && (
            <div ref={overlayRef} className="absolute inset-0 cursor-crosshair" style={{ zIndex: 10 }}
              onMouseDown={onStartDraw}>
              {pageRedactions.map((r) => {
                const { left, top, width, height } = getOverlayRect(r);
                const sel = r.id === st.selectedId;
                return (
                  <div key={r.id}
                    onMouseDown={(e) => onStartMove(e, r.id)}
                    className="absolute border-2 rounded-sm"
                    data-redact-mark={r.id}
                    data-redact-lines={r.lines?.length ?? 1}
                    style={{
                      left, top, width, height,
                      // A word mark paints its lines, not the band between the
                      // first and last word; an area mark paints its rectangle.
                      background: r.lines && r.lines.length > 0 ? 'transparent' : fillColor,
                      borderColor: sel ? '#DC2626' : 'transparent',
                      borderStyle: r.lines && r.lines.length > 1 && !sel ? 'dashed' : 'solid',
                      zIndex: sel ? 15 : 12,
                      cursor: sel ? 'move' : 'pointer',
                    }}
                    title={
                      r.lines && r.lines.length > 1
                        ? `One redaction covering ${r.lines.length} lines of text`
                        : r.free
                          ? 'Area mark'
                          : 'Text redaction'
                    }
                  >
                    {r.lines?.map((line, index) => (
                      <div
                        key={`${r.id}-line-${index}`}
                        data-redact-line
                        className="absolute pointer-events-none"
                        style={{
                          left: (line.x - r.x) * canvasDims.w,
                          top: (1 - line.y - line.h - (1 - r.y - r.h)) * canvasDims.h,
                          width: line.w * canvasDims.w,
                          height: line.h * canvasDims.h,
                          background: fillColor,
                        }}
                      />
                    ))}
                    {sel && (
                      <>
                        {/* Corners */}
                        <div style={handleStyle(0, 0, 'nwse-resize')} onMouseDown={(e) => onStartResize(e, r.id, 'nw')}><div style={handleFace} /></div>
                        <div style={handleStyle(width, 0, 'nesw-resize')} onMouseDown={(e) => onStartResize(e, r.id, 'ne')}><div style={handleFace} /></div>
                        <div style={handleStyle(0, height, 'nesw-resize')} onMouseDown={(e) => onStartResize(e, r.id, 'sw')}><div style={handleFace} /></div>
                        <div style={handleStyle(width, height, 'nwse-resize')} onMouseDown={(e) => onStartResize(e, r.id, 'se')}><div style={handleFace} /></div>
                        {/* Edges */}
                        <div style={handleStyle(width / 2, 0, 'ns-resize')} onMouseDown={(e) => onStartResize(e, r.id, 'n')}><div style={handleFace} /></div>
                        <div style={handleStyle(width / 2, height, 'ns-resize')} onMouseDown={(e) => onStartResize(e, r.id, 's')}><div style={handleFace} /></div>
                        <div style={handleStyle(0, height / 2, 'ew-resize')} onMouseDown={(e) => onStartResize(e, r.id, 'w')}><div style={handleFace} /></div>
                        <div style={handleStyle(width, height / 2, 'ew-resize')} onMouseDown={(e) => onStartResize(e, r.id, 'e')}><div style={handleFace} /></div>
                      </>
                    )}
                  </div>
                );
              })}

              {drawing && (
                <div className="absolute border-2 border-danger rounded-sm pointer-events-none"
                  style={{
                    left: drawing.x * canvasDims.w,
                    top: (1 - drawing.y - drawing.h) * canvasDims.h,
                    width: drawing.w * canvasDims.w,
                    height: drawing.h * canvasDims.h,
                    background: fillColor, zIndex: 20,
                  }} />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
