import { formatFileSize } from '@/lib/utils/download';
import { EmptyState } from './EmptyState';
import { ErrorPanel } from './ErrorPanel';
import { ProgressBar } from './ProgressBar';

/** One row in the queue. Everything except `id`/`name` is optional so a tool
 * can start showing rows before it has inspected the file. */
export interface FileQueueItem {
  /** Stable id — file name is fine while the queue is name-keyed. */
  id: string;
  name: string;
  size?: number | null;
  /** `null`/`undefined` renders as "counting pages" when `busy`, else "—". */
  pages?: number | null;
  /** Data URL or object URL of the first page. */
  thumbnail?: string | null;
  /** 0..100 for this file only. */
  percent?: number | null;
  message?: string | null;
  /** Named failure (E1/E2/E4): the row shows it and offers Retry. */
  error?: string | null;
  /** Being inspected / currently processed. */
  busy?: boolean;
}

export interface FileQueueProps {
  items: FileQueueItem[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  onRemove?: (id: string) => void;
  /** Move the item at `from` to `to` (order matters for merge-like tools). */
  onReorder?: (from: number, to: number) => void;
  onRetry?: (id: string) => void;
  emptyTitle?: string;
  emptyBody?: string;
  className?: string;
}

/**
 * The input list every tool surface shares: name, size, page count, thumbnail,
 * per-file progress, reorder and remove, and a named error per row.
 */
export function FileQueue({
  items,
  selectedId,
  onSelect,
  onRemove,
  onReorder,
  onRetry,
  emptyTitle = 'No files yet',
  emptyBody = 'Drop a PDF here — it never leaves this device.',
  className = '',
}: FileQueueProps) {
  if (items.length === 0) {
    return <EmptyState title={emptyTitle} body={emptyBody} icon="🗂" className={className} />;
  }

  return (
    <ol className={`space-y-1.5 ${className}`}>
      {items.map((item, index) => {
        const active = selectedId === item.id;
        return (
          <li
            key={item.id}
            className={`rounded-doodle border bg-cream-light p-2 ${
              active ? 'border-accent ring-1 ring-accent/35' : 'border-cream-border'
            }`}
          >
            <div className="flex items-start gap-2">
              <span className="w-4 shrink-0 pt-0.5 text-center font-mono text-[10px] tabular-nums text-ink-muted">
                {index + 1}
              </span>
              {item.thumbnail ? (
                <img
                  src={item.thumbnail}
                  alt=""
                  className="h-12 w-9 shrink-0 rounded border border-cream-border object-contain"
                />
              ) : (
                <span
                  aria-hidden
                  className="flex h-12 w-9 shrink-0 items-center justify-center rounded border border-cream-border bg-cream-soft text-[9px] text-ink-muted"
                >
                  {item.busy ? '…' : 'PDF'}
                </span>
              )}

              <button
                type="button"
                onClick={() => onSelect?.(item.id)}
                disabled={!onSelect}
                className="min-w-0 flex-1 text-left disabled:cursor-default"
              >
                <span className="block truncate text-[11px] font-semibold text-ink" title={item.name}>
                  {item.name}
                </span>
                <span className="mt-0.5 block font-mono text-[10px] tabular-nums text-ink-muted">
                  {item.size != null ? formatFileSize(item.size) : '—'}
                  {' · '}
                  {item.pages != null
                    ? `${item.pages} ${item.pages === 1 ? 'page' : 'pages'}`
                    : item.busy
                      ? 'counting pages…'
                      : 'pages unknown'}
                </span>
              </button>

              <span className="flex shrink-0 items-center gap-1">
                {onReorder && (
                  <>
                    <button
                      type="button"
                      aria-label={`Move ${item.name} earlier`}
                      title="Move earlier"
                      disabled={index === 0}
                      onClick={() => onReorder(index, index - 1)}
                      className="rounded border border-cream-border px-1 text-[10px] text-ink-muted hover:border-ink-muted hover:text-ink disabled:opacity-35"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${item.name} later`}
                      title="Move later"
                      disabled={index === items.length - 1}
                      onClick={() => onReorder(index, index + 1)}
                      className="rounded border border-cream-border px-1 text-[10px] text-ink-muted hover:border-ink-muted hover:text-ink disabled:opacity-35"
                    >
                      ↓
                    </button>
                  </>
                )}
                {onRemove && (
                  <button
                    type="button"
                    aria-label={`Remove ${item.name}`}
                    title="Remove"
                    onClick={() => onRemove(item.id)}
                    className="rounded border border-cream-border px-1 text-[10px] text-ink-muted hover:border-danger/40 hover:text-danger"
                  >
                    ✕
                  </button>
                )}
              </span>
            </div>

            {item.percent != null && !item.error && (
              <ProgressBar
                className="mt-2"
                percent={item.percent}
                message={item.message}
                label={`Processing ${item.name}`}
                tone={item.busy ? 'accent' : 'success'}
                indeterminate={item.busy && item.percent === 0}
              />
            )}

            {item.error && (
              <ErrorPanel
                className="mt-2"
                message={item.error}
                fileName={item.name}
                onRetry={onRetry ? () => onRetry(item.id) : undefined}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
