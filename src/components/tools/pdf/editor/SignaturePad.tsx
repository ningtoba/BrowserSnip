/**
 * SignaturePad — draw a signature on a small canvas and hand back a raster.
 *
 * The result is JPEG with a white ground on purpose: an annotation appearance
 * stream can only carry an image without alpha through
 * `annotations.embedRasterImage`, so a transparent PNG would be refused at
 * export time. The editor places the returned raster with the Image/Stamp
 * machinery, which keeps one code path for every picture on a page.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { fadeUp, tapDown } from '@/lib/motion';
import { encodeImageBytes } from '@/lib/pdf/core/images';
import type { PlacedRaster } from './types';
import type { Point } from './geometry';

const PAD_WIDTH = 560;
const PAD_HEIGHT = 190;

export interface SignaturePadProps {
  open: boolean;
  /** Ink colour of the pen. */
  color?: string;
  strokeWidth?: number;
  onCancel: () => void;
  onAccept: (raster: PlacedRaster) => void;
}

export function SignaturePad({
  open,
  color = '#1B1B18',
  strokeWidth = 2.5,
  onCancel,
  onAccept,
}: SignaturePadProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokesRef = useRef<Point[][]>([]);
  const drawingRef = useRef(false);
  const [hasInk, setHasInk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const repaint = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
    ctx.lineWidth = strokeWidth * dpr;
    for (const stroke of strokesRef.current) {
      if (stroke.length === 0) continue;
      ctx.beginPath();
      stroke.forEach((point, index) => {
        const x = point.x * dpr;
        const y = point.y * dpr;
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
  }, [color, strokeWidth]);

  useEffect(() => {
    if (!open) return;
    strokesRef.current = [];
    setHasInk(false);
    setError('');
    const canvas = canvasRef.current;
    if (canvas) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(PAD_WIDTH * dpr);
      canvas.height = Math.floor(PAD_HEIGHT * dpr);
    }
    repaint();
  }, [open, repaint]);

  const localPoint = (event: React.PointerEvent<HTMLCanvasElement>): Point => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  const accept = async () => {
    const canvas = canvasRef.current;
    if (!canvas || !hasInk) return;
    setBusy(true);
    setError('');
    try {
      const trimmed = trimToInk(canvas, strokesRef.current, Math.min(window.devicePixelRatio || 1, 2));
      const encoded = await encodeImageBytes(trimmed, {
        format: 'jpeg',
        quality: 0.92,
        background: '#ffffff',
      });
      onAccept({
        bytes: encoded.bytes,
        url: `data:${encoded.mime};base64,${toBase64(encoded.bytes)}`,
        width: trimmed.width,
        height: trimmed.height,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'This browser could not export the signature.');
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-ink/30 p-4 backdrop-blur-subtle">
      <motion.div
        variants={fadeUp}
        initial="hidden"
        animate="visible"
        className="w-full max-w-[600px] rounded-doodle-lg border border-cream-border bg-cream-light p-4 shadow-doodle-card"
      >
        <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
          Draw your signature
        </p>
        <canvas
          ref={canvasRef}
          style={{ width: PAD_WIDTH, height: PAD_HEIGHT, maxWidth: '100%' }}
          className="mt-2 w-full cursor-crosshair touch-none rounded-doodle-md border border-dashed border-cream-border bg-white"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            drawingRef.current = true;
            strokesRef.current = [...strokesRef.current, [localPoint(event)]];
            setHasInk(true);
            repaint();
          }}
          onPointerMove={(event) => {
            if (!drawingRef.current) return;
            const strokes = strokesRef.current;
            const current = strokes[strokes.length - 1];
            if (!current) return;
            current.push(localPoint(event));
            repaint();
          }}
          onPointerUp={() => {
            drawingRef.current = false;
          }}
          onPointerLeave={() => {
            drawingRef.current = false;
          }}
        />
        <p className="mt-2 text-[10px] leading-relaxed text-ink-muted">
          The signature is placed on a white ground — PDF stamp images cannot keep transparency.
        </p>
        {error && <p className="mt-2 text-[10px] text-danger">{error}</p>}
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              strokesRef.current = strokesRef.current.slice(0, -1);
              setHasInk(strokesRef.current.length > 0);
              repaint();
            }}
            disabled={!hasInk}
            className="doodle-btn doodle-btn-secondary text-[11px] disabled:opacity-40"
          >
            Undo stroke
          </button>
          <button
            type="button"
            onClick={() => {
              strokesRef.current = [];
              setHasInk(false);
              repaint();
            }}
            disabled={!hasInk}
            className="doodle-btn doodle-btn-secondary text-[11px] disabled:opacity-40"
          >
            Clear
          </button>
          <span className="flex-1" />
          <button type="button" onClick={onCancel} className="doodle-btn doodle-btn-secondary text-[11px]">
            Cancel
          </button>
          <motion.button
            whileTap={tapDown}
            type="button"
            onClick={() => void accept()}
            disabled={!hasInk || busy}
            className="doodle-btn text-[11px] disabled:opacity-50"
          >
            {busy ? 'Preparing…' : 'Place signature'}
          </motion.button>
        </div>
      </motion.div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Canvas helpers                                                      *
 * ------------------------------------------------------------------ */

/** Cut the blank margins off the pad so the placed signature is tight. */
function trimToInk(source: HTMLCanvasElement, strokes: Point[][], dpr: number): HTMLCanvasElement {
  const points = strokes.flat();
  if (points.length === 0) return source;
  const pad = 12;
  const x0 = Math.max(Math.min(...points.map((p) => p.x)) - pad, 0);
  const y0 = Math.max(Math.min(...points.map((p) => p.y)) - pad, 0);
  const x1 = Math.min(Math.max(...points.map((p) => p.x)) + pad, source.width / dpr);
  const y1 = Math.min(Math.max(...points.map((p) => p.y)) + pad, source.height / dpr);
  const width = Math.max(Math.round((x1 - x0) * dpr), 1);
  const height = Math.max(Math.round((y1 - y0) * dpr), 1);
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d');
  if (!ctx) return source;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(
    source,
    Math.round(x0 * dpr),
    Math.round(y0 * dpr),
    width,
    height,
    0,
    0,
    width,
    height,
  );
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
