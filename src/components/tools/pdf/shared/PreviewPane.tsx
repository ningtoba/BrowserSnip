import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PdfSession } from '@/lib/pdf/core/render';
import { EmptyState } from './EmptyState';
import { FOCUS_RING } from './focusRing';

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

/** How the page is scaled when the user is not asking for a number. */
type FitMode = 'width' | 'page' | 'custom';

/**
 * Where the bar should sit after a zoom that keeps a point still.
 *
 * `(scroll + offset) * ratio - offset` holds the content pixel under the cursor
 * at the same viewport offset, which is what "zoom to the cursor" means. With a
 * factor of 1 it returns the offset it was given.
 */
export function zoomAnchorScroll(scroll: number, cursorOffset: number, ratio: number): number {
  return Math.round((scroll + cursorOffset) * ratio - cursorOffset);
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
  const [mode, setMode] = useState<FitMode>('width');
  const [spin, setSpin] = useState(0);
  const [split, setSplit] = useState(50);
  const [size, setSize] = useState<PageSize | null>(null);
  const [stageBox, setStageBox] = useState({ width: 0, height: 0 });
  const [notice, setNotice] = useState<string | null>(null);
  const stage = useRef<HTMLDivElement | null>(null);
  /** Set by a cursor-anchored zoom, applied once the new size is in the DOM. */
  const keepPoint = useRef<{ x: number; y: number; ratio: number } | null>(null);

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

  // Measure the stage so "fit width" and "fit page" are real numbers, not guesses.
  useEffect(() => {
    const measure = () =>
      setStageBox({
        width: stage.current?.clientWidth ?? 0,
        height: stage.current?.clientHeight ?? 0,
      });
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
    if (!size || stageBox.width <= 0) return 1;
    const across = stageBox.width / size.width;
    // Fit page also divides by the height, which is what stops a tall page from
    // running off the pane and hiding the stepper's answer.
    const down = mode === 'page' && stageBox.height > 0 ? stageBox.height / size.height : Infinity;
    return Math.max(0.1, Math.min(4, Math.min(across, down)));
  }, [mode, size, stageBox]);

  const scale = mode === 'custom' ? zoomPct / 100 : fitScale;
  const shownPct = Math.max(minZoom, Math.min(maxZoom, Math.round(scale * 100)));

  const step = (delta: number) => zoomAt((mode === 'custom' ? zoomPct : Math.round(scale * 100)) + delta, null);

  /**
   * Zoom by a step, keeping the content point at `offset` of the pane still.
   *
   * `offset` is `null` for a keyboard or button zoom, which keeps the centre of
   * the view instead. The scroll is corrected in the layout effect below,
   * because the new page size does not exist until the DOM has it.
   */
  const zoomAt = useCallback(
    (to: number, offset: { x: number; y: number } | null) => {
      const from = mode === 'custom' ? zoomPct : Math.round(scale * 100);
      const next = Math.max(minZoom, Math.min(maxZoom, to));
      if (next === from) return;
      const el = stage.current;
      const point = offset ?? {
        x: (el?.clientWidth ?? 0) / 2,
        y: (el?.scrollTop ?? 0) + 1,
      };
      keepPoint.current = { x: point.x, y: point.y, ratio: next / from };
      setMode('custom');
      setZoomPct(next);
    },
    [maxZoom, minZoom, mode, scale, zoomPct],
  );

  // Put the scroll back where the cursor was, after the new page size is real.
  useLayoutEffect(() => {
    const plan = keepPoint.current;
    const el = stage.current;
    if (!plan || !el) return;
    keepPoint.current = null;
    el.scrollLeft = zoomAnchorScroll(el.scrollLeft, plan.x, plan.ratio);
    el.scrollTop = zoomAnchorScroll(el.scrollTop, plan.y, plan.ratio);
  }, [scale]);

  // Ctrl/Cmd + wheel is zoom-to-cursor everywhere else in this app's family
  // (pdf.js viewer, Figma); a plain wheel stays a scroll. Registered natively
  // rather than through `onWheel` because React's wheel listeners are passive,
  // and a gesture that cannot call `preventDefault` also zooms the whole tab.
  const zoomFromWheel = useCallback(
    (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey) || total === 0) return;
      const el = stage.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const from = mode === 'custom' ? zoomPct : Math.round(scale * 100);
      event.preventDefault();
      zoomAt(from + (event.deltaY < 0 ? 25 : -25), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    },
    [mode, scale, total, zoomAt, zoomPct],
  );

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    el.addEventListener('wheel', zoomFromWheel, { passive: false });
    return () => el.removeEventListener('wheel', zoomFromWheel);
  }, [zoomFromWheel]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // Page turning is suppressed while a field has the caret: arrows inside the
    // page box or the split slider belong to that control.
    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable)
    ) {
      return;
    }
    const keys: Record<string, () => void> = {
      ArrowRight: () => goTo(current + 1),
      PageDown: () => goTo(current + 1),
      ArrowLeft: () => goTo(current - 1),
      PageUp: () => goTo(current - 1),
      Home: () => goTo(1),
      End: () => goTo(total),
      '+': () => step(25),
      '=': () => step(25),
      '-': () => step(-25),
      _: () => step(-25),
      '0': () => setMode('width'),
      '1': () => {
        setMode('custom');
        setZoomPct(100);
      },
    };
    const move = keys[event.key];
    if (!move || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    move();
  };

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
            className={`doodle-chip doodle-chip-inactive w-auto px-2 py-1 text-[11px] disabled:opacity-40 ${FOCUS_RING}`}
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
            className={`doodle-chip doodle-chip-inactive w-auto px-2 py-1 text-[11px] disabled:opacity-40 ${FOCUS_RING}`}
          >
            ›
          </button>
        </span>

        <span className="mx-1 h-4 w-px bg-cream-border" aria-hidden />

        <button
          type="button"
          aria-label="Zoom out"
          title="Zoom out"
          onClick={() => step(-25)}
          className={`doodle-chip doodle-chip-inactive w-auto px-2 py-1 text-[11px] ${FOCUS_RING}`}
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
          onClick={() => step(25)}
          className={`doodle-chip doodle-chip-inactive w-auto px-2 py-1 text-[11px] ${FOCUS_RING}`}
        >
          +
        </button>
        <button
          type="button"
          aria-pressed={mode === 'width'}
          title="Fit the page width to the pane (0)"
          onClick={() => setMode('width')}
          className={`doodle-chip w-auto px-2 py-1 text-[10px] ${
            mode === 'width' ? 'doodle-chip-active' : 'doodle-chip-inactive'
          } ${FOCUS_RING}`}
        >
          Fit width
        </button>
        <button
          type="button"
          aria-pressed={mode === 'page'}
          title="Fit the whole page in the pane"
          onClick={() => setMode('page')}
          className={`doodle-chip w-auto px-2 py-1 text-[10px] ${
            mode === 'page' ? 'doodle-chip-active' : 'doodle-chip-inactive'
          } ${FOCUS_RING}`}
        >
          Fit page
        </button>
        <button
          type="button"
          aria-pressed={mode === 'custom' && zoomPct === 100}
          title="Show the page at 1:1 (1)"
          onClick={() => {
            setMode('custom');
            setZoomPct(100);
          }}
          className={`doodle-chip w-auto px-2 py-1 text-[10px] ${
            mode === 'custom' && zoomPct === 100 ? 'doodle-chip-active' : 'doodle-chip-inactive'
          } ${FOCUS_RING}`}
        >
          Actual size
        </button>

        <span className="mx-1 h-4 w-px bg-cream-border" aria-hidden />

        <button
          type="button"
          aria-label="Rotate preview left"
          title="Rotate preview left"
          onClick={() => setSpin((s) => (s + 270) % 360)}
          className={`doodle-chip doodle-chip-inactive w-auto px-2 py-1 text-[11px] ${FOCUS_RING}`}
        >
          ⟲
        </button>
        <button
          type="button"
          aria-label="Rotate preview right"
          title="Rotate preview right"
          onClick={() => setSpin((s) => (s + 90) % 360)}
          className={`doodle-chip doodle-chip-inactive w-auto px-2 py-1 text-[11px] ${FOCUS_RING}`}
        >
          ⟳
        </button>
      </div>

      {notice && (
        <p
          role="status"
          className="rounded-doodle-md border border-warn/25 bg-warn/5 px-2 py-1 text-[10px] leading-relaxed text-warn"
        >
          {notice}
        </p>
      )}

      <div
        ref={stage}
        tabIndex={0}
        role="group"
        aria-label="Page preview"
        aria-describedby="preview-keys"
        data-fit={mode}
        data-zoom={shownPct}
        onKeyDown={onKeyDown}
        className={`relative min-h-0 flex-1 overflow-auto rounded-doodle-md border border-cream-border bg-cream-soft p-3 ${FOCUS_RING}`}
      >
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

      <p id="preview-keys" className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-muted tabular-nums">
        {size
          ? `${Math.round(size.width)} × ${Math.round(size.height)} pt${size.rotation ? ` · page /Rotate ${size.rotation}` : ''}`
          : 'Page size unknown'}
        {' · '}
        {after ? 'before / after' : 'rendered on this device'}
        {' · '}
        ← → turn pages, + − zoom, Ctrl + scroll zooms to the cursor
      </p>

      {/* The page and its scale, said out loud for whoever cannot see the pane. */}
      <p role="status" aria-live="polite" className="sr-only">
        {`Page ${current} of ${total}${mode === 'custom' ? `, ${shownPct} per cent` : `, ${mode === 'page' ? 'fit to page' : 'fit to width'}`}`}
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
  // A page that has not been painted yet is a dashed tile with a number in it,
  // never a white rectangle: on a 500-page document the pane sat blank while
  // pdf.js worked, which read as a crash (E7).
  const [drawing, setDrawing] = useState(true);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    let alive = true;
    setError(null);
    setDrawing(true);
    session
      .renderToCanvas(page, element, Math.max(0.1, scale))
      .then(() => {
        if (alive) setDrawing(false);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setDrawing(false);
        setError(err instanceof Error ? err.message : 'Could not draw this page.');
      });
    return () => {
      alive = false;
    };
  }, [page, scale, session]);

  return (
    <div
      className="relative flex justify-center"
      data-canvas-state={error ? 'error' : drawing ? 'rendering' : 'ready'}
    >
      <canvas
        ref={canvas}
        aria-label={label ? `${label} preview, page ${page}` : `Page ${page} preview`}
        className="max-w-full rounded border border-cream-border bg-cream-light shadow-doodle"
        style={{ transform: spin ? `rotate(${spin}deg)` : undefined }}
      />
      {drawing && !error && (
        <div
          aria-hidden
          className="absolute inset-0 flex items-center justify-center rounded border border-dashed border-cream-border bg-cream-soft"
        >
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-muted">
            Drawing page {page}
          </span>
        </div>
      )}
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
