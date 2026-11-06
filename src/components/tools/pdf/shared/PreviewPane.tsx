import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PdfSession } from '@/lib/pdf/core/render';
import { EmptyState } from './EmptyState';

export interface PreviewPaneProps {
  /** Document to show. `null` renders the empty state. */
  session: PdfSession | null;
  /** 1-based page. Omit to let the pane keep its own page state. */
  page?: number;
  onPageChange?: (page: number) => void;
  /**
   * Second document. When present the pane becomes a before/after split, which
   * is what transform tools (rotate, crop, compress, convert) were missing.
   */
  after?: PdfSession | null;
  /** Named in the error state so a failure points at a file (E3). */
  fileName?: string | null;
  minZoom?: number;
  maxZoom?: number;
  emptyBody?: string;
  className?: string;
}

interface PageSize {
  width: number;
  height: number;
  /** The page's own /Rotate, in degrees (E9). */
  rotation: number;
}

/**
 * The workspace's job: a real page preview with zoom/fit, a stepper, rotation,
 * and a split comparison for transform tools.
 */
export function PreviewPane({
  session,
  page,
  onPageChange,
  after = null,
  fileName,
  minZoom = 25,
  maxZoom = 400,
  emptyBody = 'Preview the current page here, then compare it with the result.',
  className = '',
}: PreviewPaneProps) {
  const total = session?.numPages ?? 0;
  const [inner, setInner] = useState(1);
  const [zoomPct, setZoomPct] = useState(100);
  const [fit, setFit] = useState(true);
  const [spin, setSpin] = useState(0);
  const [split, setSplit] = useState(50);
  const [size, setSize] = useState<PageSize | null>(null);
  const [stageWidth, setStageWidth] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const stage = useRef<HTMLDivElement | null>(null);

  const current = Math.max(1, Math.min(page ?? inner, Math.max(total, 1)));

  const goTo = useCallback(
    (next: number, raw?: boolean) => {
      if (total === 0) return;
      const clamped = Math.max(1, Math.min(Math.round(next), total));
      if (page === undefined) setInner(clamped);
      onPageChange?.(clamped);
      if (raw && clamped !== Math.round(next)) {
        setNotice(
          total === 1
            ? 'This PDF has one page, so page 2 does not exist.'
            : `This PDF runs from page 1 to ${total}; showing page ${clamped}.`,
        );
      } else {
        setNotice(null);
      }
    },
    [onPageChange, page, total],
  );

  // Measure the stage so "fit width" is a real number, not a guess.
  useEffect(() => {
    const measure = () => setStageWidth(stage.current?.clientWidth ?? 0);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [session]);

  useEffect(() => {
    let alive = true;
    if (!session || total === 0) {
      setSize(null);
      return;
    }
    session
      .page(current)
      .then((proxy) => {
        const viewport = proxy.getViewport({ scale: 1 });
        if (alive) setSize({ width: viewport.width, height: viewport.height, rotation: viewport.rotation });
        proxy.cleanup();
      })
      .catch(() => {
        if (alive) setSize(null);
      });
    return () => {
      alive = false;
    };
  }, [current, session, total]);

  const fitScale = useMemo(() => {
    if (!size || stageWidth <= 0) return 1;
    return Math.max(0.1, Math.min(4, stageWidth / size.width));
  }, [size, stageWidth]);

  const scale = fit ? fitScale : zoomPct / 100;
  const shownPct = Math.max(minZoom, Math.min(maxZoom, Math.round(scale * 100)));

  const step = (delta: number) => setZoomPct(Math.max(minZoom, Math.min(maxZoom, Math.round((fit ? fitScale : zoomPct / 100) * 100 + delta))));

  if (!session || total === 0) {
    return (
      <EmptyState
        className={`${className} h-full`}
        icon="🖥"
        title={fileName ? `${fileName} has nothing to preview` : 'Nothing to preview yet'}
        body={emptyBody}
      />
    );
  }

  return (
    <div className={`flex min-h-0 flex-col gap-2 ${className}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Previous page"
            title="Previous page"
            disabled={current <= 1}
            onClick={() => goTo(current - 1)}
            className="doodle-chip doodle-chip-inactive w-auto px-2 py-1 text-[11px] disabled:opacity-40"
          >
            ‹
          </button>
          <input
            type="number"
            aria-label="Page number"
            min={1}
            max={total}
            value={current}
            onChange={(event) => goTo(Number(event.target.value) || 1, true)}
            className="doodle-input w-16 px-2 py-1 text-center text-[11px] tabular-nums"
          />
          <span className="font-mono text-[10px] text-ink-muted tabular-nums">of {total}</span>
          <button
            type="button"
            aria-label="Next page"
            title="Next page"
            disabled={current >= total}
            onClick={() => goTo(current + 1)}
            className="doodle-chip doodle-chip-inactive w-auto px-2 py-1 text-[11px] disabled:opacity-40"
          >
            ›
          </button>
        </span>

        <span className="mx-1 h-4 w-px bg-cream-border" aria-hidden />

        <button
          type="button"
          aria-label="Zoom out"
          title="Zoom out"
          onClick={() => {
            setFit(false);
            step(-25);
          }}
          className="doodle-chip doodle-chip-inactive w-auto px-2 py-1 text-[11px]"
        >
          −
        </button>
        <span className="w-12 text-center font-mono text-[10px] text-ink-soft tabular-nums">
          {shownPct}%
        </span>
        <button
          type="button"
          aria-label="Zoom in"
          title="Zoom in"
          onClick={() => {
            setFit(false);
            step(25);
          }}
          className="doodle-chip doodle-chip-inactive w-auto px-2 py-1 text-[11px]"
        >
          +
        </button>
        <button
          type="button"
          onClick={() => setFit(true)}
          className={`doodle-chip w-auto px-2 py-1 text-[10px] ${fit ? 'doodle-chip-active' : 'doodle-chip-inactive'}`}
        >
          Fit width
        </button>
        <button
          type="button"
          onClick={() => {
            setFit(false);
            setZoomPct(100);
          }}
          className={`doodle-chip w-auto px-2 py-1 text-[10px] ${!fit && zoomPct === 100 ? 'doodle-chip-active' : 'doodle-chip-inactive'}`}
        >
          Actual size
        </button>

        <span className="mx-1 h-4 w-px bg-cream-border" aria-hidden />

        <button
          type="button"
          aria-label="Rotate preview left"
          title="Rotate preview left"
          onClick={() => setSpin((s) => (s + 270) % 360)}
          className="doodle-chip doodle-chip-inactive w-auto px-2 py-1 text-[11px]"
        >
          ⟲
        </button>
        <button
          type="button"
          aria-label="Rotate preview right"
          title="Rotate preview right"
          onClick={() => setSpin((s) => (s + 90) % 360)}
          className="doodle-chip doodle-chip-inactive w-auto px-2 py-1 text-[11px]"
        >
          ⟳
        </button>
      </div>

      {notice && (
        <p className="rounded-doodle-md border border-warn/25 bg-warn/5 px-2 py-1 text-[10px] leading-relaxed text-warn">
          {notice}
        </p>
      )}

      <div ref={stage} className="relative min-h-0 flex-1 overflow-auto rounded-doodle-md border border-cream-border bg-cream-soft p-3">
        {after ? (
          <div className="relative mx-auto" style={{ maxWidth: size ? size.width * scale : undefined }}>
            <PageCanvas session={after} page={current} scale={scale} spin={spin} label="After" fileName={fileName} />
            <div
              className="absolute inset-0 overflow-hidden"
              style={{ clipPath: `inset(0 ${100 - split} 0 0)` }}
            >
              <PageCanvas session={session} page={current} scale={scale} spin={spin} label="Before" fileName={fileName} />
            </div>
            <input
              type="range"
              min={0}
              max={100}
              value={split}
              aria-label="Before and after split"
              onChange={(event) => setSplit(Number(event.target.value))}
              className="absolute inset-x-0 bottom-2 mx-auto w-2/3"
            />
          </div>
        ) : (
          <div className="mx-auto" style={{ maxWidth: size ? size.width * scale : undefined }}>
            <PageCanvas session={session} page={current} scale={scale} spin={spin} fileName={fileName} />
          </div>
        )}
      </div>

      <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-muted tabular-nums">
        {size
          ? `${Math.round(size.width)} × ${Math.round(size.height)} pt${size.rotation ? ` · page /Rotate ${size.rotation}` : ''}`
          : 'Page size unknown'}
        {' · '}
        {after ? 'before / after' : 'rendered on this device'}
      </p>
    </div>
  );
}

interface PageCanvasProps {
  session: PdfSession;
  page: number;
  scale: number;
  spin: number;
  /** Corner tag, e.g. "Before". */
  label?: string;
  fileName?: string | null;
}

function PageCanvas({ session, page, scale, spin, label, fileName }: PageCanvasProps) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    let alive = true;
    setError(null);
    session
      .renderToCanvas(page, element, Math.max(0.1, scale))
      .catch((err: unknown) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : 'Could not draw this page.');
      });
    return () => {
      alive = false;
    };
  }, [page, scale, session]);

  return (
    <div className="relative flex justify-center">
      <canvas
        ref={canvas}
        aria-label={label ? `${label} preview, page ${page}` : `Page ${page} preview`}
        className="max-w-full rounded border border-cream-border bg-cream-light shadow-doodle"
        style={{ transform: spin ? `rotate(${spin}deg)` : undefined }}
      />
      {label && (
        <span className="absolute left-1 top-1 rounded bg-cream-light/85 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em] text-ink-muted">
          {label}
        </span>
      )}
      {error && (
        <p className="absolute inset-x-1 bottom-1 rounded bg-danger/10 px-2 py-1 text-[10px] text-danger">
          {fileName ? `${fileName}: ` : ''}
          {error}
        </p>
      )}
    </div>
  );
}
