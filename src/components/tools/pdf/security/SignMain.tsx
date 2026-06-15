/**
 * SignMain — Visual PDF signature overlay.
 *
 * The overlay handles selection, dragging, and resizing of placed
 * signatures. Signature content is prepared in the sidebar (SignTool)
 * and placed via "Add to PDF" at a default position, then adjusted here.
 */
import { useRef, useEffect, useLayoutEffect, useState, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { useFileStore } from '@/stores/file-store';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs', import.meta.url,
).toString();

// ═══════════════════ Shared state ═══════════════════

export interface SigItem {
  id: string;
  type: 'text' | 'image' | 'draw';
  text: string;
  imageDataUrl: string | null;
  imageBytes: ArrayBuffer | null;
  page: number;
  x: number;        // fraction 0–1 of page width (left edge)
  y: number;        // fraction 0–1 of page height (bottom edge, PDF coords)
  w: number;        // pt
  h: number;        // pt
  color: string;
  fontFamily: string;
}

interface SignState {
  page: number;
  totalPages: number;
  items: SigItem[];
  selectedId: string | null;
}

let _state: SignState = { page: 1, totalPages: 1, items: [], selectedId: null };
export let _pageW = 595;
export let _pageH = 842;
let _listeners = new Set<() => void>();
function notify() { _listeners.forEach((fn) => fn()); }

export function getSignState() { return _state; }
export function getSignPageSize() { return { width: _pageW, height: _pageH }; }
export function setSignPage(p: Partial<Pick<SignState, 'page' | 'totalPages'>>) { _state = { ..._state, ...p }; notify(); }
export function addSigItem(item: Omit<SigItem, 'page' | 'color' | 'fontFamily' | 'x' | 'y'> & Partial<Pick<SigItem, 'color' | 'fontFamily' | 'x' | 'y'>>) {
  const full: SigItem = {
    ...item,
    page: _state.page,
    color: item.color ?? '#000000',
    fontFamily: item.fontFamily ?? 'Helvetica',
    x: item.x ?? 0.5 - (item.w / _pageW) / 2,
    y: item.y ?? 0.5 - (item.h / _pageH) / 2,
  };
  _state.items.push(full); _state.selectedId = full.id; notify();
}
export function updateSigItem(id: string, patch: Partial<SigItem>) {
  const idx = _state.items.findIndex((s) => s.id === id);
  if (idx >= 0) _state.items[idx] = { ..._state.items[idx], ...patch }; notify();
}
export function removeSigItem(id: string) {
  _state.items = _state.items.filter((s) => s.id !== id);
  if (_state.selectedId === id) _state.selectedId = _state.items[_state.items.length - 1]?.id ?? null; notify();
}
export function selectSigItem(id: string | null) { _state.selectedId = id; notify(); }
export function subscribeSign(fn: () => void) { _listeners.add(fn); return () => { _listeners.delete(fn); }; }

// ═══════════════════ Constants ═══════════════════

const HANDLE_SIZE = 10;
const MIN_ITEM_W = 30;
const MIN_ITEM_H = 14;

// ═══════════════════ Component ═══════════════════

export function SignMain() {
  const pdfCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const file = useFileStore((s) => s.file);

  const [loading, setLoading] = useState(true);
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [st, setSt] = useState<SignState>(_state);
  const [canvasDims, setCanvasDims] = useState({ w: 0, h: 0 });
  const [scale, setScale] = useState(1.0);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  useEffect(() => subscribeSign(() => setSt({ ..._state })), []);

  // ── Scale: compute from window + container dimensions ────

  const recomputeScale = useCallback(() => {
    if (!pdfDoc) return;
    // Use container width (reliable) and window height (reliable)
    const cw = wrapperRef.current?.clientWidth;
    const availW = cw ? cw - 32 : window.innerWidth - 400;
    const availH = window.innerHeight - 160;
    const s = Math.min(availW / _pageW, availH / _pageH);
    const next = Math.max(0.8, Math.min(1.5, s));
    if (Math.abs(next - scaleRef.current) > 0.005) {
      setScale(next);
    }
  }, [pdfDoc]);

  // Compute on mount + when pdfDoc appears (layout effect = before paint)
  useLayoutEffect(() => { if (pdfDoc) recomputeScale(); }, [pdfDoc, recomputeScale]);

  // Recompute on window resize
  useEffect(() => {
    window.addEventListener('resize', recomputeScale);
    return () => window.removeEventListener('resize', recomputeScale);
  }, [recomputeScale]);

  // ── Load PDF ────────────────────────────────────────────

  useEffect(() => {
    if (!file) { setLoading(false); return; }
    const load = async () => {
      try {
        const buf = await file.arrayBuffer();
        const task = pdfjsLib.getDocument({ data: buf });
        const doc = await task.promise;
        const pageIdx = Math.min(_state.page - 1, doc.numPages - 1);
        const page = await doc.getPage(pageIdx + 1);
        const natVp = page.getViewport({ scale: 1 });
        _pageW = natVp.width;
        _pageH = natVp.height;
        setPdfDoc(doc);
        setSignPage({ totalPages: doc.numPages });
        const s = scaleRef.current;
        const vp = page.getViewport({ scale: s });
        pdfCanvasRef.current!.width = vp.width;
        pdfCanvasRef.current!.height = vp.height;
        setCanvasDims({ w: vp.width, h: vp.height });
        await page.render({ canvasContext: pdfCanvasRef.current!.getContext('2d')!, viewport: vp }).promise;
        setLoading(false);
      } catch { setLoading(false); }
    };
    load();
  }, [file]);

  // ── Re-render on page or scale change ────────────────────

  useEffect(() => {
    if (!pdfDoc || !pdfCanvasRef.current || !scale) return;
    (async () => {
      try {
        const pageIdx = Math.min(st.page - 1, pdfDoc.numPages - 1);
        const page = await pdfDoc.getPage(pageIdx + 1);
        const vp = page.getViewport({ scale });
        pdfCanvasRef.current!.width = vp.width;
        pdfCanvasRef.current!.height = vp.height;
        setCanvasDims({ w: vp.width, h: vp.height });
        await page.render({ canvasContext: pdfCanvasRef.current!.getContext('2d')!, viewport: vp }).promise;
      } catch { /* render error */ }
    })();
  }, [pdfDoc, st.page, scale]);

  // ── Keyboard ────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (_state.selectedId) removeSigItem(_state.selectedId);
      }
      if (e.key === 'Escape') selectSigItem(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ═══════════════════ Drag & Resize ═══════════════════

  const dragRef = useRef<{
    id: string; mode: 'move' | 'resize'; handle: string;
    startX: number; startY: number;
    origX: number; origY: number; origW: number; origH: number;
  } | null>(null);

  const onItemDragStart = useCallback((e: React.MouseEvent, id: string) => {
    e.preventDefault(); e.stopPropagation();
    selectSigItem(id);
    const item = _state.items.find((s) => s.id === id);
    if (!item) return;
    dragRef.current = {
      id, mode: 'move', handle: 'move',
      startX: e.clientX, startY: e.clientY,
      origX: item.x, origY: item.y, origW: item.w, origH: item.h,
    };
  }, []);

  const onHandleStart = useCallback((e: React.MouseEvent, id: string, handle: string) => {
    e.preventDefault(); e.stopPropagation();
    const item = _state.items.find((s) => s.id === id);
    if (!item) return;
    dragRef.current = {
      id, mode: 'resize', handle,
      startX: e.clientX, startY: e.clientY,
      origX: item.x, origY: item.y, origW: item.w, origH: item.h,
    };
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d || !overlayRef.current) return;
      const rect = overlayRef.current.getBoundingClientRect();
      const item = _state.items.find((s) => s.id === d.id);
      if (!item) return;
      const dx = (e.clientX - d.startX) / rect.width;
      const dy = -(e.clientY - d.startY) / rect.height;

      if (d.mode === 'move') {
        item.x = Math.max(0, Math.min(1 - item.w / _pageW, d.origX + dx));
        item.y = Math.max(0, Math.min(1 - item.h / _pageH, d.origY + dy));
      } else {
        const s = scaleRef.current;
        const dpx = (e.clientX - d.startX) / s;
        const dpy = -(e.clientY - d.startY) / s;
        let newX = d.origX, newY = d.origY, newW = d.origW, newH = d.origH;
        switch (d.handle) {
          case 'e':  newW = Math.max(MIN_ITEM_W, d.origW + dpx); break;
          case 'w':  newW = Math.max(MIN_ITEM_W, d.origW - dpx); newX = d.origX + (d.origW - newW) / _pageW; break;
          case 'n':  newH = Math.max(MIN_ITEM_H, d.origH + dpy); break;
          case 's':  newH = Math.max(MIN_ITEM_H, d.origH - dpy); newY = d.origY + (d.origH - newH) / _pageH; break;
          case 'ne': newW = Math.max(MIN_ITEM_W, d.origW + dpx); newH = Math.max(MIN_ITEM_H, d.origH + dpy); break;
          case 'nw': newW = Math.max(MIN_ITEM_W, d.origW - dpx); newH = Math.max(MIN_ITEM_H, d.origH + dpy); newX = d.origX + (d.origW - newW) / _pageW; break;
          case 'se': newW = Math.max(MIN_ITEM_W, d.origW + dpx); newH = Math.max(MIN_ITEM_H, d.origH - dpy); newY = d.origY + (d.origH - newH) / _pageH; break;
          case 'sw': newW = Math.max(MIN_ITEM_W, d.origW - dpx); newH = Math.max(MIN_ITEM_H, d.origH - dpy); newX = d.origX + (d.origW - newW) / _pageW; newY = d.origY + (d.origH - newH) / _pageH; break;
        }
        item.x = Math.max(0, Math.min(1 - newW / _pageW, newX));
        item.y = Math.max(0, Math.min(1 - newH / _pageH, newY));
        item.w = newW; item.h = newH;
      }
      notify();
    };
    const onUp = () => { dragRef.current = null; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  // ═══════════════════ Helpers ═══════════════════

  const handleStyle = (x: number, y: number, cursor: string): React.CSSProperties => ({
    position: 'absolute', left: x - HANDLE_SIZE / 2, top: y - HANDLE_SIZE / 2,
    width: HANDLE_SIZE, height: HANDLE_SIZE,
    background: '#3b82f6', border: '2px solid white', borderRadius: 2,
    cursor, zIndex: 20, boxShadow: '0 0 0 1px rgba(0,0,0,0.2)',
  });

  // ═══════════════════ Render ═══════════════════

  const hasPdf = !loading && pdfDoc;
  const pageItems = st.items.filter((item) => item.page === st.page);

  const handleTextChange = useCallback((id: string, text: string) => {
    updateSigItem(id, { text });
  }, []);

  // Empty / loading inside persistent wrapper so ref never null
  return (
    <div className="relative flex-1 overflow-hidden flex flex-col">
      {/* Page nav */}
      <div className="flex items-center justify-between shrink-0 px-3 py-1.5 border-b border-ink/20 bg-ink-darker">
        <div className="flex items-center gap-2">
          {hasPdf && st.totalPages > 1 && (
            <>
              <button onClick={() => setSignPage({ page: Math.max(1, st.page - 1) })}
                disabled={st.page <= 1}
                className="doodle-chip text-[10px] doodle-chip-inactive disabled:opacity-30">
                ◂ Prev
              </button>
              <span className="text-[11px] text-ink-muted tabular-nums min-w-[4rem] text-center">
                {st.page} / {st.totalPages}
              </span>
              <button onClick={() => setSignPage({ page: Math.min(st.totalPages, st.page + 1) })}
                disabled={st.page >= st.totalPages}
                className="doodle-chip text-[10px] doodle-chip-inactive disabled:opacity-30">
                Next ▸
              </button>
            </>
          )}
        </div>
        <span className="text-[10px] text-ink-muted/70">
          {pageItems.length} signature{pageItems.length !== 1 ? 's' : ''} on this page
          {st.selectedId && ' · selected'}
        </span>
      </div>

      {/* Canvas area */}
      <div ref={wrapperRef} className="flex-1 overflow-hidden flex items-center justify-center p-4">
        {!file && !loading && <p className="text-ink-muted text-xs">Load a PDF to start signing</p>}
        {loading && <p className="text-ink-muted text-xs animate-pulse">Loading PDF…</p>}

        {hasPdf && (
          <div className="relative shrink-0" style={{ lineHeight: 0 }}>
            <canvas ref={pdfCanvasRef} className="shadow-doodle-card rounded-md" />

            {canvasDims.w > 0 && (
              <div ref={overlayRef} className="absolute inset-0" style={{ zIndex: 10 }}>
                {pageItems.map((item) => {
                  const vpX = item.x * canvasDims.w;
                  const vpY = (1 - item.y) * canvasDims.h;
                  const vpW = item.w * scale;
                  const vpH = item.h * scale;
                  const isSelected = item.id === st.selectedId;
                  const borderColor = item.type === 'text' ? 'border-blue-400'
                    : item.type === 'image' ? 'border-emerald-400' : 'border-purple-400';
                  const selBg = item.type === 'text' ? 'bg-blue-500/10'
                    : item.type === 'image' ? 'bg-emerald-500/10' : 'bg-purple-500/10';

                  return (
                    <div key={item.id}
                      onMouseDown={(e) => onItemDragStart(e, item.id)}
                      className={`absolute border-2 rounded select-none cursor-move ${borderColor} ${isSelected ? selBg : 'bg-transparent'}`}
                      style={{ left: vpX, top: vpY - vpH, width: vpW, height: vpH, zIndex: isSelected ? 15 : 12 }}
                    >

                      {/* Text */}
                      {item.type === 'text' && (
                        isSelected ? (
                          <textarea value={item.text}
                            onChange={(e) => handleTextChange(item.id, e.target.value)}
                            onMouseDown={(e) => e.stopPropagation()}
                            className="w-full h-full bg-transparent border-0 outline-none resize-none text-black px-1.5 pt-3 pb-0.5 font-['Helvetica',sans-serif]"
                            style={{ fontSize: Math.max(8, item.h * 0.45 * scale) }}
                            placeholder="Type…" autoFocus />
                        ) : (
                          <div className="w-full h-full flex items-center px-1.5 overflow-hidden pointer-events-none">
                            <span className="text-black/80 font-['Helvetica',sans-serif]"
                              style={{ fontSize: Math.max(8, item.h * 0.45 * scale) }}>
                              {item.text || '(empty)'}
                            </span>
                          </div>
                        )
                      )}

                      {/* Image / Draw */}
                      {(item.type === 'image' || item.type === 'draw') && (
                        item.imageDataUrl ? (
                          <img src={item.imageDataUrl} alt={item.type}
                            className="w-full h-full object-contain pointer-events-none p-0.5" />
                        ) : (
                          <div className="flex flex-col items-center justify-center h-full gap-0.5 pointer-events-none opacity-50">
                            <span className="text-base">{item.type === 'image' ? '🖼️' : '✎'}</span>
                            <span className="text-[9px] italic">{item.type === 'image' ? 'Image' : 'Drawing'}</span>
                          </div>
                        )
                      )}

                      {/* Resize handles */}
                      {isSelected && (
                        <>
                          <div style={handleStyle(0, 0, 'nw-resize')} onMouseDown={(e) => onHandleStart(e, item.id, 'nw')} />
                          <div style={handleStyle(vpW, 0, 'ne-resize')} onMouseDown={(e) => onHandleStart(e, item.id, 'ne')} />
                          <div style={handleStyle(0, vpH, 'sw-resize')} onMouseDown={(e) => onHandleStart(e, item.id, 'sw')} />
                          <div style={handleStyle(vpW, vpH, 'se-resize')} onMouseDown={(e) => onHandleStart(e, item.id, 'se')} />
                          <div style={handleStyle(vpW / 2, 0, 'n-resize')} onMouseDown={(e) => onHandleStart(e, item.id, 'n')} />
                          <div style={handleStyle(vpW / 2, vpH, 's-resize')} onMouseDown={(e) => onHandleStart(e, item.id, 's')} />
                          <div style={handleStyle(0, vpH / 2, 'w-resize')} onMouseDown={(e) => onHandleStart(e, item.id, 'w')} />
                          <div style={handleStyle(vpW, vpH / 2, 'e-resize')} onMouseDown={(e) => onHandleStart(e, item.id, 'e')} />
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
