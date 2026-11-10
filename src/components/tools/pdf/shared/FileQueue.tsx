import { formatFileSize } from '@/lib/utils/download';
import type { PdfEncryption } from '@/lib/pdf/core/guard';
import type { FileLockState } from '@/stores/process-store';
import { EmptyState } from './EmptyState';
import { ErrorPanel } from './ErrorPanel';
import { FileLockRow } from './FileCards';
import { ProgressBar } from './ProgressBar';
import { FOCUS_RING } from './focusRing';

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
  /** The file's own encryption dictionary, as the pre-flight classified it. */
  encryption?: PdfEncryption | null;
  /** What the password check answered for this file — see `FileLockRow`. */
  lock?: FileLockState;
}

export interface FileQueueProps {
  items: FileQueueItem[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  onRemove?: (id: string) => void;
  /** Move the item at `from` to `to` (order matters for merge-like tools). */
  onReorder?: (from: number, to: number) => void;
  onRetry?: (id: string) => void;
  /**
   * One line above the rows, for the case where per-file percentages are
   * inferred rather than measured (the runner reports one sweep for the whole
   * job). Saying "estimated" beats a bar that looks exact and is not.
   */
  progressNote?: string | null;
  /**
   * The job's open password, and the setter that takes one typed on a row.
   *
   * The row itself is `FileCards:FileLockRow` — the same component the cards draw,
   * so a queue and a card can never disagree about what a lock means or where the
   * secret goes.
   */
  password?: string;
  onPassword?: (value: string) => void;
  /** True while a re-read prompted by a new secret is still outstanding. */
  passwordChecking?: boolean;
  /** True when the tool declares a password field of its own. */
  toolOwnsPassword?: boolean;
  emptyTitle?: string;
  emptyBody?: string;
  className?: string;
}

/**
 * Which of the five states a row is in, in one word.
 *
 * A queue of four files used to be four identical tiles; the word is what tells
 * "waiting for its turn" apart from "working" and "stopped with an error".
 */
export function rowStage(item: FileQueueItem): 'Waiting' | 'Starting' | 'Working' | 'Done' | 'Stopped' {
  if (item.error) return 'Stopped';
  const percent = item.percent ?? 0;
  if (item.busy) return percent > 0 ? 'Working' : 'Starting';
  if (percent >= 100) return 'Done';
  return 'Waiting';
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
  progressNote,
  password = '',
  onPassword,
  passwordChecking = false,
  toolOwnsPassword = false,
  emptyTitle = 'No files yet',
  emptyBody = 'Drop a PDF here — it never leaves this device.',
  className = '',
}: FileQueueProps) {
  if (items.length === 0) {
    return <EmptyState title={emptyTitle} body={emptyBody} icon="🗂" className={className} />;
  }
  // More than one row needs the secret: one string covers the job, and the row has
  // to say that rather than look like it holds its own answer.
  const lockedRows = items.filter(
    (item) => item.lock === 'needs-password' || item.lock === 'wrong-password',
  ).length;

  return (
    <div className={className}>
      {progressNote && (
        <p className="pb-1.5 font-mono text-[9px] uppercase tracking-[0.08em] text-ink-muted">
          {progressNote}
        </p>
      )}
      <ol className="space-y-1.5">
      {items.map((item, index) => {
        const active = selectedId === item.id;
        const failed = Boolean(item.error);
        const stage = rowStage(item);
        return (
          <li
            key={item.id}
            aria-current={active ? 'true' : undefined}
            className={`rounded-doodle border bg-cream-light p-2 ${
              active ? 'border-accent ring-1 ring-accent/35' : 'border-cream-border'
            } ${failed ? 'border-danger/40' : ''}`}
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
                  className="flex h-12 w-9 shrink-0 items-center justify-center rounded border border-dashed border-cream-border bg-cream-soft font-mono text-[9px] text-ink-muted"
                >
                  {item.busy ? '◌' : 'PDF'}
                </span>
              )}

              <button
                type="button"
                onClick={() => onSelect?.(item.id)}
                disabled={!onSelect}
                className={`min-w-0 flex-1 text-left disabled:cursor-default ${FOCUS_RING}`}
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
                  {' · '}
                  {stage}
                </span>
              </button>

              <span className="flex shrink-0 items-center gap-1">
                {onReorder && (
                  <>
                    <button
                      type="button"
                      aria-label={`Move ${item.name} earlier`}
                      title={index === 0 ? 'This file is already first' : 'Move earlier'}
                      disabled={index === 0}
                      onClick={() => onReorder(index, index - 1)}
                      className={`flex h-7 w-7 items-center justify-center rounded border border-cream-border text-[11px] text-ink-muted hover:border-ink-muted hover:text-ink disabled:opacity-35 ${FOCUS_RING}`}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${item.name} later`}
                      title={index === items.length - 1 ? 'This file is already last' : 'Move later'}
                      disabled={index === items.length - 1}
                      onClick={() => onReorder(index, index + 1)}
                      className={`flex h-7 w-7 items-center justify-center rounded border border-cream-border text-[11px] text-ink-muted hover:border-ink-muted hover:text-ink disabled:opacity-35 ${FOCUS_RING}`}
                    >
                      ↓
                    </button>
                  </>
                )}
                {onRemove && (
                  <button
                    type="button"
                    aria-label={`Remove ${item.name}`}
                    title="Remove from the list"
                    onClick={() => onRemove(item.id)}
                    className={`flex h-7 w-7 items-center justify-center rounded border border-cream-border text-[11px] text-ink-muted hover:border-danger/40 hover:text-danger ${FOCUS_RING}`}
                  >
                    ✕
                  </button>
                )}
              </span>
            </div>

            {(item.lock ?? 'none') !== 'none' && (
              <FileLockRow
                name={item.name}
                lock={item.lock ?? 'none'}
                encryption={item.encryption ?? null}
                password={password}
                onPassword={onPassword}
                checking={passwordChecking}
                toolOwnsPassword={toolOwnsPassword}
                shared={lockedRows > 1}
              />
            )}
            {item.busy && item.percent == null && !failed && (
              // Working with nothing measured yet: say so with a track that
              // moves, never a determinate bar at a made-up number.
              <ProgressBar className="mt-2" percent={0} indeterminate label={`Processing ${item.name}`} />
            )}
            {item.percent != null && !failed && (
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
    </div>
  );
}
