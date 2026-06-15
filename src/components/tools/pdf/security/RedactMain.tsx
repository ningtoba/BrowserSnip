/**
 * RedactMain — Visual PDF redaction overlay.
 *
 * Drag on empty area to draw new redaction rectangles.
 * Click existing redactions to select, drag to move, handles to resize.
 * Delete/Backspace to remove selected, Escape to deselect.
 */
import { useRef, useEffect, useState, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { useFileStore } from '@/stores/file-store';

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
let _listeners = new Set<() => void>();
function notify() { _listeners.forEach((fn) => fn()); }

export function getRedactState() { return _state; }
export function getRedactPageSize() { return { width: _pageW, height: _pageH }; }
export function setRedactPage(p: Partial<Pick<RedactState, 'page' | 'totalPages'>>) { _state = { ..._state, ...p }; notify(); }
export function setRedactColor(c: string) { _state = { ..._state, color: c }; notify(); }
export function addRedaction(r: Omit<Redaction, 'id' | 'page'>) {
  const full: Redaction = { ...r, id: `r-${Date.now()}`, page: _state.page };
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
const HANDLE_SIZE = 10;
const MIN_SIZE_FRAC = 0.01;

export function RedactMain() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const file = useFileStore((s) => s.file);

  const [loading, setLoading] = useState(true);
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [st, setSt] = useState<RedactState>(_state);
  const [canvasDims, setCanvasDims] = useState({ w: 0, h: 0 });

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
  } | null>(null);
  const [drawing, setDrawing] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const onStartDraw = useCallback((e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    if (!overlayRef.current) return;
    const rect = overlayRef.current.getBoundingClientRect();
    dragRef.current = { mode: 'draw', startX: e.clientX, startY: e.clientY };
    const fx = (e.clientX - rect.left) / rect.width;
    const fy = 1 - (e.clientY - rect.top) / rect.height;
    setDrawing({ x: fx, y: fy, w: 0, h: 0 });
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
        updateRedaction(d.id!, { x: newX, y: newY });
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
        updateRedaction(d.id!, { x: nx, y: ny, w: nw, h: nh });
      }
    };
    const onUp = () => {
      if (dragRef.current?.mode === 'draw' && drawing) {
        if (drawing.w > 0.003 && drawing.h > 0.003) {
          addRedaction({ x: drawing.x, y: drawing.y, w: drawing.w, h: drawing.h });
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

  const handleStyle = (x: number, y: number, cursor: string): React.CSSProperties => ({
    position: 'absolute', left: x - HANDLE_SIZE / 2, top: y - HANDLE_SIZE / 2,
    width: HANDLE_SIZE, height: HANDLE_SIZE,
    background: '#ef4444', border: '2px solid white', borderRadius: 2,
    cursor, zIndex: 25, boxShadow: '0 0 0 1px rgba(0,0,0,0.2)',
  });

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
      <div className="flex items-center justify-between shrink-0 px-3 py-1.5 border-b border-ink/20 bg-ink-darker">
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
        <span className="text-[10px] text-ink-muted/70">
          {pageRedactions.length} redaction{pageRedactions.length !== 1 ? 's' : ''} · Drag to mark
        </span>
      </div>

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
                    style={{
                      left, top, width, height,
                      background: fillColor,
                      borderColor: sel ? '#ef4444' : 'transparent',
                      zIndex: sel ? 15 : 12,
                      cursor: sel ? 'move' : 'pointer',
                    }}
                  >
                    {sel && (
                      <>
                        {/* Corners */}
                        <div style={handleStyle(0, 0, 'nw-resize')} onMouseDown={(e) => onStartResize(e, r.id, 'nw')} />
                        <div style={handleStyle(width, 0, 'ne-resize')} onMouseDown={(e) => onStartResize(e, r.id, 'ne')} />
                        <div style={handleStyle(0, height, 'sw-resize')} onMouseDown={(e) => onStartResize(e, r.id, 'sw')} />
                        <div style={handleStyle(width, height, 'se-resize')} onMouseDown={(e) => onStartResize(e, r.id, 'se')} />
                        {/* Edges */}
                        <div style={handleStyle(width / 2, 0, 'n-resize')} onMouseDown={(e) => onStartResize(e, r.id, 'n')} />
                        <div style={handleStyle(width / 2, height, 's-resize')} onMouseDown={(e) => onStartResize(e, r.id, 's')} />
                        <div style={handleStyle(0, height / 2, 'w-resize')} onMouseDown={(e) => onStartResize(e, r.id, 'w')} />
                        <div style={handleStyle(width, height / 2, 'e-resize')} onMouseDown={(e) => onStartResize(e, r.id, 'e')} />
                      </>
                    )}
                  </div>
                );
              })}

              {drawing && (
                <div className="absolute border-2 border-red-400 rounded-sm pointer-events-none"
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
