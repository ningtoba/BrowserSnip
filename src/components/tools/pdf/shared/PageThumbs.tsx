import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { thumbnails, type PdfSession } from '@/lib/pdf/core/render';
import { EmptyState } from './EmptyState';
import { FOCUS_RING } from './focusRing';

export interface PageThumbsProps {
  /** Document to thumbnail. `null` renders the empty state. */
  session: PdfSession | null;
  /** 1-based selected pages. */
  selected?: number[];
  onSelect?: (pages: number[]) => void;
  /** Called with the selection and a delta in degrees. */
  onRotate?: (pages: number[], delta: number) => void;
  onDelete?: (pages: number[]) => void;
  /** Longest edge of a rendered thumbnail, in CSS pixels. */
  maxSide?: number;
  columns?: number;
  /** Row height estimate used to work out the visible window. */
  rowHeight?: number;
  label?: string;
  className?: string;
}

/**
 * Rendered thumbnails, keyed so a scroll back does not re-rasterise a page.
 * Bounded: the oldest entries go once the cap is hit, which is what keeps a
 * 500-page document from holding 500 JPEGs (E7/E12).
 */
const THUMB_CACHE_LIMIT = 400;
const thumbCache = new Map<string, string>();

function cachePut(key: string, url: string): void {
  if (thumbCache.size >= THUMB_CACHE_LIMIT) {
    const oldest = thumbCache.keys().next();
    if (!oldest.done) thumbCache.delete(oldest.value);
  }
  thumbCache.set(key, url);
}

export interface PageThumbnail {
  /** Data URL once drawn; `null` while pending or unavailable. */
  url: string | null;
  /** The raster came back with nothing to show (no 2-D context, dead page). */
  unavailable: boolean;
}

/**
 * One page's raster, through the shared bounded cache.
 *
 * The page grid and the loaded-state file cards both need a single page image,
 * and a second implementation would be a second cache holding a second 500
 * JPEGs. `unavailable` is a state of its own: jsdom has no 2-D context, so a
 * test (and a canvas-blocked browser) must be told the image is not coming
 * rather than watch a spinner forever.
 */
export function usePageThumbnail(
  session: PdfSession | null,
  page: number,
  maxSide: number,
  /** Lets a virtualised strip count the tiles still in flight. */
  onStatus?: (page: number, busy: boolean) => void,
): PageThumbnail {
  const key = session ? `${session.fingerprint || 'doc'}:${page}:${maxSide}` : null;
  const [url, setUrl] = useState<string | null>(() => (key ? thumbCache.get(key) ?? null : null));
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    setUrl(key ? thumbCache.get(key) ?? null : null);
    setUnavailable(false);
  }, [key]);

  useEffect(() => {
    if (!session || !key || url) return;
    let alive = true;
    onStatus?.(page, true);
    thumbnails(session, { pages: [page], maxSide })
      .then((list) => {
        if (!alive) return;
        const next = list[0] ?? '';
        if (next) {
          cachePut(key, next);
          setUrl(next);
        } else {
          setUnavailable(true);
        }
      })
      .catch(() => {
        if (alive) setUnavailable(true);
      })
      .finally(() => {
        if (alive) onStatus?.(page, false);
      });
    return () => {
      alive = false;
      onStatus?.(page, false);
    };
    // `onStatus` is a stable callback in every caller and `key` already encodes
    // the session, page and size, so listing them would restart the raster on
    // every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, key, url, page, maxSide]);

  return { url, unavailable };
}

export function PageThumbs({
  session,
  selected = [],
  onSelect,
  onRotate,
  onDelete,
  maxSide = 110,
  columns = 4,
  rowHeight = 150,
  label = 'Pages',
  className = '',
}: PageThumbsProps) {
  const total = session?.numPages ?? 0;
  const scroller = useRef<HTMLDivElement | null>(null);
  const anchor = useRef<number | null>(null);
  const [window0, setWindow0] = useState(0);
  const [windowCount, setWindowCount] = useState(columns * 3);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  /**
   * Which pages in the window are still waiting for their raster. The strip
   * says so out loud, because "24 tiles with a number in them" and "24 blank
   * squares" look identical to a user who does not know a render is in flight.
   */
  const [drawing, setDrawing] = useState<Set<number>>(() => new Set());
  const report = useCallback((page: number, busy: boolean) => {
    setDrawing((current) => {
      const next = new Set(current);
      if (busy) next.add(page);
      else next.delete(page);
      return next.size === current.size ? current : next;
    });
  }, []);

  /** Only the rows near the viewport get a DOM node and a raster. */
  const measure = useCallback(() => {
    const el = scroller.current;
    const visibleRows = Math.max(1, Math.ceil((el?.clientHeight || 0) / rowHeight));
    const scrollTop = el?.scrollTop || 0;
    const firstRow = Math.floor(scrollTop / rowHeight);
    const startRow = Math.max(0, firstRow - 1);
    const endRow = Math.min(Math.ceil(total / columns), firstRow + visibleRows + 1);
    setWindow0(startRow * columns);
    setWindowCount(Math.max(columns, (endRow - startRow) * columns));
  }, [columns, rowHeight, total]);

  useEffect(() => {
    measure();
  }, [measure]);

  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
    anchor.current = null;
    // The cells report their own state, and their cleanup drains it, so a new
    // document needs no explicit reset here — clearing the set in this effect
    // would run after the children had already reported, and hide the truth.
    measure();
  }, [session, measure]);

  const pick = useCallback(
    (page: number, shift: boolean) => {
      if (!onSelect) return;
      if (shift && anchor.current != null) {
        const from = Math.min(anchor.current, page);
        const to = Math.max(anchor.current, page);
        const span: number[] = [];
        for (let p = from; p <= to; p++) span.push(p);
        onSelect([...new Set([...selected, ...span])].sort((a, b) => a - b));
        return;
      }
      anchor.current = page;
      const next = new Set(selected);
      if (next.has(page)) next.delete(page);
      else next.add(page);
      onSelect([...next].sort((a, b) => a - b));
    },
    [onSelect, selected],
  );

  if (!session || total === 0) {
    return (
      <EmptyState
        className={className}
        icon="📄"
        title="No pages to show"
        body="Open a PDF and its pages appear here, one thumbnail per page."
      />
    );
  }

  const first = Math.min(window0, Math.max(0, total - columns));
  const last = Math.min(total, first + windowCount);
  const pages: number[] = [];
  for (let page = first + 1; page <= last; page++) pages.push(page);
  const aboveRows = Math.floor(first / columns);
  const belowRows = Math.max(0, Math.ceil(total / columns) - Math.ceil(last / columns));

  return (
    <div className={`flex min-h-0 flex-col gap-2 ${className}`}>
      <div
        ref={scroller}
        onScroll={measure}
        aria-label={label}
        aria-busy={drawing.size > 0}
        className="min-h-0 flex-1 overflow-y-auto pr-1"
      >
        <div style={{ height: aboveRows * rowHeight }} aria-hidden />
        <div
          className="grid gap-1.5"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {pages.map((page) => (
            <ThumbCell
              key={page}
              session={session}
              page={page}
              maxSide={maxSide}
              selected={selectedSet.has(page)}
              onPick={(shift) => pick(page, shift)}
              onStatus={report}
            />
          ))}
        </div>
        <div style={{ height: belowRows * rowHeight }} aria-hidden />
      </div>

      {drawing.size > 0 && (
        <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-muted">
          Drawing {drawing.size} of {pages.length} visible page{pages.length === 1 ? '' : 's'} ·
          {' '}
          {total} in this file
        </p>
      )}

      <div className="flex items-center justify-between gap-2 border-t border-cream-border pt-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-muted tabular-nums">
          {selected.length === 0
            ? `${total} pages · pick pages to rotate or delete`
            : `${selected.length} of ${total} selected`}
        </span>
        <span className="flex items-center gap-1">
          {onRotate && (
            <button
              type="button"
              disabled={selected.length === 0}
              title={selected.length === 0 ? 'Pick at least one page to rotate' : 'Rotate the picked pages right'}
              onClick={() => onRotate([...selected].sort((a, b) => a - b), 90)}
              className={`doodle-chip doodle-chip-inactive w-auto px-2 py-1 text-[10px] disabled:opacity-40 ${FOCUS_RING}`}
            >
              Rotate
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              disabled={selected.length === 0}
              title={selected.length === 0 ? 'Pick at least one page to delete' : 'Delete the picked pages'}
              onClick={() => onDelete([...selected].sort((a, b) => a - b))}
              className={`doodle-chip doodle-chip-inactive w-auto px-2 py-1 text-[10px] text-danger disabled:opacity-40 ${FOCUS_RING}`}
            >
              Delete
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

interface ThumbCellProps {
  session: PdfSession;
  page: number;
  maxSide: number;
  selected: boolean;
  onPick: (shift: boolean) => void;
  /** Tells the strip this page is waiting for, or has finished, its raster. */
  onStatus: (page: number, busy: boolean) => void;
}

function ThumbCell({ session, page, maxSide, selected, onPick, onStatus }: ThumbCellProps) {
  // `unavailable` is the state where the render came back with nothing to show
  // — a headless test, or a browser that refused the 2-D context. The tile then
  // says the image is unavailable instead of pretending it is still arriving.
  const { url, unavailable: noImage } = usePageThumbnail(session, page, maxSide, onStatus);

  return (
    <button
      type="button"
      aria-label={`Page ${page}`}
      aria-pressed={selected}
      onClick={(event) => onPick(event.shiftKey)}
      data-thumb={url ? 'image' : noImage ? 'unavailable' : 'drawing'}
      title={url ? `Page ${page}` : noImage ? `Page ${page} — no image in this browser` : `Page ${page} — drawing`}
      className={`group relative overflow-hidden rounded border transition-colors ${
        selected ? 'border-accent ring-1 ring-accent/40' : 'border-cream-border hover:border-ink-muted'
      } ${FOCUS_RING}`}
    >
      {url ? (
        <img src={url} alt="" className="h-full w-full object-contain" />
      ) : (
        <span className="flex aspect-[3/4] flex-col items-center justify-center gap-0.5 rounded border border-dashed border-cream-border bg-cream-soft font-mono text-[10px] text-ink-muted tabular-nums">
          <span aria-hidden className="text-[12px] leading-none">
            {noImage ? '◇' : '◌'}
          </span>
          {page}
        </span>
      )}
      <span
        className={`absolute bottom-0 right-0 px-1 text-[8px] font-semibold tabular-nums ${
          selected ? 'bg-accent text-cream-light' : 'bg-cream-light/80 text-ink-muted'
        }`}
      >
        {page}
      </span>
    </button>
  );
}
