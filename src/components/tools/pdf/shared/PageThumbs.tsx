import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { thumbnails, type PdfSession } from '@/lib/pdf/core/render';
import { EmptyState } from './EmptyState';

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
            />
          ))}
        </div>
        <div style={{ height: belowRows * rowHeight }} aria-hidden />
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-cream-border pt-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-muted tabular-nums">
          {selected.length === 0
            ? `${total} pages`
            : `${selected.length} of ${total} selected`}
        </span>
        <span className="flex items-center gap-1">
          {onRotate && (
            <button
              type="button"
              disabled={selected.length === 0}
              onClick={() => onRotate([...selected].sort((a, b) => a - b), 90)}
              className="doodle-chip doodle-chip-inactive w-auto px-2 py-1 text-[10px] disabled:opacity-40"
            >
              Rotate
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              disabled={selected.length === 0}
              onClick={() => onDelete([...selected].sort((a, b) => a - b))}
              className="doodle-chip doodle-chip-inactive w-auto px-2 py-1 text-[10px] text-danger disabled:opacity-40"
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
}

function ThumbCell({ session, page, maxSide, selected, onPick }: ThumbCellProps) {
  const key = `${session.fingerprint || 'doc'}:${page}:${maxSide}`;
  const [url, setUrl] = useState<string | null>(() => thumbCache.get(key) ?? null);

  useEffect(() => {
    if (url) return;
    let alive = true;
    thumbnails(session, { pages: [page], maxSide })
      .then((list) => {
        if (!alive) return;
        const next = list[0] ?? '';
        // An empty string means no 2-D context (headless test, canvas-blocked
        // browser); the numbered placeholder is the honest fallback.
        if (next) {
          cachePut(key, next);
          setUrl(next);
        }
      })
      .catch(() => {
        /* placeholder stays visible; the page number is still selectable */
      });
    return () => {
      alive = false;
    };
  }, [key, maxSide, page, session, url]);

  return (
    <button
      type="button"
      aria-label={`Page ${page}`}
      aria-pressed={selected}
      onClick={(event) => onPick(event.shiftKey)}
      className={`group relative overflow-hidden rounded border transition-colors ${
        selected ? 'border-accent ring-1 ring-accent/40' : 'border-cream-border hover:border-ink-muted'
      }`}
    >
      {url ? (
        <img src={url} alt="" className="h-full w-full object-contain" />
      ) : (
        <span className="flex aspect-[3/4] items-center justify-center bg-cream-soft font-mono text-[10px] text-ink-muted tabular-nums">
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
