/**
 * CropMain — Visual PDF crop tool with draggable overlay.
 *
 * Renders the first PDF page to a canvas with a semi-transparent mask
 * and draggable handles. The crop rect is shared with CropTool sidebar.
 */
import { useRef, useEffect, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { scaleIn } from '@/lib/motion';
import * as pdfjsLib from 'pdfjs-dist';
import { useFileStore } from '@/stores/file-store';
import type { PdfCropParams } from '@/types';
import { NUDGE_BIG_FRACTION, NUDGE_FRACTION, nudgeEdge, slideRect, type CropEdge } from './cropModel';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs', import.meta.url,
).toString();

// ── Shared crop rect as fractions (0–1) of page dimensions ──
// Fractions eliminate ALL scaling issues — the same fraction
// applies to viewport pixels, PDF points, or any unit.

export interface CropRect {
  top: number;    // 0–1 fraction from top
  right: number;  // 0–1 fraction from right
  bottom: number; // 0–1 fraction from bottom
  left: number;   // 0–1 fraction from left
}

let _cropRect: CropRect = { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 };
let _pageSizePt = { width: 595, height: 842 }; // A4 default
let _listeners = new Set<() => void>();

function notify() { _listeners.forEach((fn) => fn()); }

export function getCropRect() { return _cropRect; }
export function getPageSizePt() { return _pageSizePt; }

export function setCropRect(r: Partial<CropRect>) {
  _cropRect = { ..._cropRect, ...r };
  notify();
}

export function subscribeCrop(fn: () => void) {
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}

// ── Component ──

const DISPLAY_SCALE = 1.2;

export function CropMain() {
  const file = useFileStore((s) => s.file);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loading, setLoading] = useState(true);
  const [canvasDims, setCanvasDims] = useState({ w: 0, h: 0 });
  const pdfDocRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const [rect, setRect] = useState<CropRect>(_cropRect);

  // Sync with shared state
  useEffect(() => {
    const unsub = subscribeCrop(() => setRect({ ..._cropRect }));
    return unsub;
  }, []);

  // Load and render first page
  useEffect(() => {
    if (!file) { setLoading(false); return; }

    const load = async () => {
      try {
        const buf = await file.arrayBuffer();
        const task = pdfjsLib.getDocument({ data: buf });
        const doc = await task.promise;
        pdfDocRef.current = doc;

        const page = await doc.getPage(1);
        const natVp = page.getViewport({ scale: 1 });
        _pageSizePt = { width: natVp.width, height: natVp.height };
        const vp = page.getViewport({ scale: DISPLAY_SCALE });
        const canvas = canvasRef.current!;
        canvas.width = vp.width;
        canvas.height = vp.height;
        setCanvasDims({ w: vp.width, h: vp.height });

        const ctx = canvas.getContext('2d')!;
        await page.render({ canvasContext: ctx, viewport: vp }).promise;

        setLoading(false);
      } catch (err) {
        console.error('[CropMain]', err);
        setLoading(false);
      }
    };

    load();

    return () => {
      pdfDocRef.current?.destroy();
      pdfDocRef.current = null;
    };
  }, [file]);

  // Convert fraction rect to viewport pixels for display
  const cLeft = rect.left * canvasDims.w;
  const cRight = canvasDims.w - rect.right * canvasDims.w;
  const cTop = rect.top * canvasDims.h;
  const cBottom = canvasDims.h - rect.bottom * canvasDims.h;
  const cW = cRight - cLeft;
  const cH = cBottom - cTop;
  const hasCrop = rect.top > 0 || rect.right > 0 || rect.bottom > 0 || rect.left > 0;

  // ── Drag handlers ──

  const dragRef = useRef<{
    handle: string;
    startX: number; startY: number;
    origRect: CropRect;
  } | null>(null);

  const handleMouseDown = useCallback((handle: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = {
      handle,
      startX: e.clientX,
      startY: e.clientY,
      origRect: { ..._cropRect },
    };
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      // Screen pixel delta → fraction of canvas dimension
      const dx = (e.clientX - d.startX) / canvasDims.w;
      const dy = (e.clientY - d.startY) / canvasDims.h;
      const r = { ...d.origRect };
      const minFrac = 40 / Math.min(canvasDims.w, canvasDims.h);

      const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
      switch (d.handle) {
        case 'left':   r.left = clamp(d.origRect.left + dx, 0, 1 - r.right - minFrac); break;
        case 'right':  r.right = clamp(d.origRect.right - dx, 0, 1 - r.left - minFrac); break;
        case 'top':    r.top = clamp(d.origRect.top + dy, 0, 1 - r.bottom - minFrac); break;
        case 'bottom': r.bottom = clamp(d.origRect.bottom - dy, 0, 1 - r.top - minFrac); break;
        case 'tl': r.left = clamp(d.origRect.left + dx, 0, 1 - r.right - minFrac);
                   r.top = clamp(d.origRect.top + dy, 0, 1 - r.bottom - minFrac); break;
        case 'tr': r.right = clamp(d.origRect.right - dx, 0, 1 - r.left - minFrac);
                   r.top = clamp(d.origRect.top + dy, 0, 1 - r.bottom - minFrac); break;
        case 'bl': r.left = clamp(d.origRect.left + dx, 0, 1 - r.right - minFrac);
                   r.bottom = clamp(d.origRect.bottom - dy, 0, 1 - r.top - minFrac); break;
        case 'br': r.right = clamp(d.origRect.right - dx, 0, 1 - r.left - minFrac);
                   r.bottom = clamp(d.origRect.bottom - dy, 0, 1 - r.top - minFrac); break;
        case 'move': {
          const mx = clamp(dx, -d.origRect.left, 1 - d.origRect.right - minFrac - d.origRect.left);
          const my = clamp(dy, -d.origRect.top, 1 - d.origRect.bottom - minFrac - d.origRect.top);
          r.left = d.origRect.left + mx;
          r.right = d.origRect.right - mx;
          r.top = d.origRect.top + my;
          r.bottom = d.origRect.bottom - my;
          break;
        }
      }

      setCropRect(r);
    };

    const onUp = () => { dragRef.current = null; };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [canvasDims]);

  const handleSize = 10;
  /** Grab room around each handle: the target is 22 px, the mark stays 10 px. */
  const handleSlop = 6;

  /**
   * Handles are buttons, not painted divs: they take focus, they announce which
   * edge they move, and the arrow keys move that edge — the pointer gesture and
   * the keyboard gesture change exactly the same number.
   */
  const handleStyle = (x: number, y: number, cursor: string): React.CSSProperties => ({
    position: 'absolute',
    left: x - (handleSize + handleSlop * 2) / 2,
    top: y - (handleSize + handleSlop * 2) / 2,
    width: handleSize + handleSlop * 2,
    height: handleSize + handleSlop * 2,
    display: 'grid',
    placeItems: 'center',
    cursor,
    zIndex: 20,
    background: 'transparent',
    border: 0,
    padding: 0,
  });

  const handleFace: React.CSSProperties = {
    width: handleSize,
    height: handleSize,
    background: '#2563EB',
    border: '2px solid white',
    borderRadius: 2,
    boxShadow: '0 0 0 1px rgba(27,27,24,0.18)',
  };

  const nudgeWithKeys = useCallback((event: React.KeyboardEvent, edges: CropEdge[]) => {
    const step = event.shiftKey ? NUDGE_BIG_FRACTION : NUDGE_FRACTION;
    let dx = 0;
    let dy = 0;
    if (event.key === 'ArrowLeft') dx = -step;
    else if (event.key === 'ArrowRight') dx = step;
    else if (event.key === 'ArrowUp') dy = -step;
    else if (event.key === 'ArrowDown') dy = step;
    else if (event.key === 'Enter' || event.key === ' ') dy = step;
    else return;
    event.preventDefault();
    event.stopPropagation();
    const rect = { ..._cropRect };
    // Each handle owns the edge(s) it sits on; a horizontal handle takes the
    // opposite sign on the right edge so "right arrow" always means "widen".
    if (edges.length === 2) {
      setCropRect(slideRect(rect, dx, dy));
      return;
    }
    const edge = edges[0];
    if (edge === 'left') setCropRect(nudgeEdge(rect, 'left', dx));
    else if (edge === 'right') setCropRect(nudgeEdge(rect, 'right', -dx));
    else if (edge === 'top') setCropRect(nudgeEdge(rect, 'top', dy));
    else setCropRect(nudgeEdge(rect, 'bottom', -dy));
  }, []);

  if (!file && !loading) {
    return (
      <motion.div
        initial="hidden"
        animate="visible"
        variants={scaleIn}
        className="flex h-full items-center justify-center opacity-40"
      >
        <span className="text-5xl">✂️</span>
      </motion.div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center animate-pulse">
        <span className="text-4xl">✂️</span>
      </div>
    );
  }

  return (
    <div className="relative flex-1 overflow-hidden flex items-center justify-center p-4">
      <div className="relative shrink-0" style={{ lineHeight: 0 }}>
        <canvas ref={canvasRef} className="shadow-doodle-card rounded-md" />

        {/* Crop overlay — only visible when crop is active */}
        {canvasDims.w > 0 && (
          <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 10 }}>
            {hasCrop && (
              <>
                {/* Top mask */}
                <div className="absolute bg-black/40" style={{ top: 0, left: 0, right: 0, height: cTop }} />
                {/* Bottom mask */}
                <div className="absolute bg-black/40" style={{ bottom: 0, left: 0, right: 0, height: rect.bottom * canvasDims.h }} />
                {/* Left mask */}
                <div className="absolute bg-black/40" style={{ top: cTop, left: 0, width: cLeft, height: cH }} />
                {/* Right mask */}
                <div className="absolute bg-black/40" style={{ top: cTop, right: 0, width: rect.right * canvasDims.w, height: cH }} />
              </>
            )}

            {hasCrop ? (
              <>
                {/* Crop border — the whole kept rectangle, movable from the keyboard */}
                <button
                  type="button"
                  data-crop-move
                  aria-label="Kept rectangle — arrow keys slide it, Shift for larger steps"
                  onKeyDown={(event) => nudgeWithKeys(event, ['left', 'top'])}
                  className="absolute border-2 border-accent pointer-events-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  style={{ top: cTop, left: cLeft, width: cW, height: cH, cursor: 'move', zIndex: 15 }}
                  onMouseDown={(e) => handleMouseDown('move', e)}
                />
                {/* Handles: 22 px targets around a 10 px face, cursor matches direction */}
                <button type="button" data-crop-handle="nw" aria-label="Top left corner — arrow keys resize the crop"
                  onKeyDown={(event) => nudgeWithKeys(event, ['left', 'top'])}
                  style={handleStyle(cLeft, cTop, 'nwse-resize')} onMouseDown={(e) => handleMouseDown('tl', e)} className="pointer-events-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"><span style={handleFace} /></button>
                <button type="button" data-crop-handle="ne" aria-label="Top right corner — arrow keys resize the crop"
                  onKeyDown={(event) => nudgeWithKeys(event, ['right', 'top'])}
                  style={handleStyle(cRight, cTop, 'nesw-resize')} onMouseDown={(e) => handleMouseDown('tr', e)} className="pointer-events-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"><span style={handleFace} /></button>
                <button type="button" data-crop-handle="sw" aria-label="Bottom left corner — arrow keys resize the crop"
                  onKeyDown={(event) => nudgeWithKeys(event, ['left', 'bottom'])}
                  style={handleStyle(cLeft, cBottom, 'nesw-resize')} onMouseDown={(e) => handleMouseDown('bl', e)} className="pointer-events-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"><span style={handleFace} /></button>
                <button type="button" data-crop-handle="se" aria-label="Bottom right corner — arrow keys resize the crop"
                  onKeyDown={(event) => nudgeWithKeys(event, ['right', 'bottom'])}
                  style={handleStyle(cRight, cBottom, 'nwse-resize')} onMouseDown={(e) => handleMouseDown('br', e)} className="pointer-events-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"><span style={handleFace} /></button>
                <button type="button" data-crop-handle="n" aria-label="Top edge — arrow keys take more or less off the top"
                  onKeyDown={(event) => nudgeWithKeys(event, ['top'])}
                  style={handleStyle((cLeft + cRight) / 2, cTop, 'ns-resize')} onMouseDown={(e) => handleMouseDown('top', e)} className="pointer-events-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"><span style={handleFace} /></button>
                <button type="button" data-crop-handle="s" aria-label="Bottom edge — arrow keys take more or less off the bottom"
                  onKeyDown={(event) => nudgeWithKeys(event, ['bottom'])}
                  style={handleStyle((cLeft + cRight) / 2, cBottom, 'ns-resize')} onMouseDown={(e) => handleMouseDown('bottom', e)} className="pointer-events-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"><span style={handleFace} /></button>
                <button type="button" data-crop-handle="w" aria-label="Left edge — arrow keys take more or less off the left"
                  onKeyDown={(event) => nudgeWithKeys(event, ['left'])}
                  style={handleStyle(cLeft, (cTop + cBottom) / 2, 'ew-resize')} onMouseDown={(e) => handleMouseDown('left', e)} className="pointer-events-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"><span style={handleFace} /></button>
                <button type="button" data-crop-handle="e" aria-label="Right edge — arrow keys take more or less off the right"
                  onKeyDown={(event) => nudgeWithKeys(event, ['right'])}
                  style={handleStyle(cRight, (cTop + cBottom) / 2, 'ew-resize')} onMouseDown={(e) => handleMouseDown('right', e)} className="pointer-events-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"><span style={handleFace} /></button>
              </>
            ) : (
              <div
                className="absolute inset-2 border-2 border-dashed border-accent/20 rounded pointer-events-auto"
                style={{ cursor: 'crosshair', zIndex: 15 }}
                onMouseDown={(e) => {
                  // Click on page edge to start cropping
                  const svg = (e.target as HTMLElement).closest('.absolute');
                  if (!svg) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const x = e.clientX - rect.left;
                  const y = e.clientY - rect.top;
                  const boxW = rect.width;
                  const boxH = rect.height;
                  // Determine which edge is closest and start dragging from there
                  const distTop = y;
                  const distBottom = boxH - y;
                  const distLeft = x;
                  const distRight = boxW - x;
                  const minDist = Math.min(distTop, distBottom, distLeft, distRight);
                  let handle: string;
                  if (minDist === distTop) handle = 'top';
                  else if (minDist === distBottom) handle = 'bottom';
                  else if (minDist === distLeft) handle = 'left';
                  else handle = 'right';
                  // Set initial crop at page edge, then start drag
                  setCropRect({ top: 0, right: 0, bottom: 0, left: 0 });
                  dragRef.current = {
                    handle,
                    startX: e.clientX,
                    startY: e.clientY,
                    origRect: { top: 0, right: 0, bottom: 0, left: 0 },
                  };
                }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
