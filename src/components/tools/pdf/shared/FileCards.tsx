/**
 * The loaded state: one horizontal card per file.
 *
 * A queue of stacked rows told you the file name and nothing else. A card is a
 * thing you can recognise — the first page, the size, how many pages are about
 * to be worked on — and in the new shape it is the only preview a schema-driven
 * tool needs, because the options live in the bar under it.
 *
 * Order is work for merge, split and compare, so cards drag; the two arrow
 * buttons are the keyboard version of the same gesture, and dropping outside a
 * card is a no-op rather than a corruption.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { openRender, type PdfSession } from '@/lib/pdf/core/render';
import { formatFileSize } from '@/lib/utils/download';
import type { FileRunState } from '@/stores/process-store';
import { ErrorPanel } from './ErrorPanel';
import { usePageThumbnail } from './PageThumbs';
import { FOCUS_RING } from './focusRing';

/** Enough previews to recognise a stack of files without holding 500 documents open. */
const SESSION_LIMIT = 8;

export interface FileCardsProps {
  files: File[];
  /** Per-file state from the process store: the page count, and why a file failed. */
  states: Record<string, FileRunState>;
  /** Multi-document tools reorder; single-document tools do not offer it. */
  reorderable: boolean;
  /** Image-input tools thumbnail the file itself, not a parsed PDF. */
  imageInput?: boolean;
  onRemove: (index: number) => void;
  onReorder: (from: number, to: number) => void;
  /** Opens the picker again — the "add more" card. */
  onAddMore?: () => void;
  addMoreLabel?: string;
  /**
   * True while the page is already printing the failure these cards came from.
   *
   * The store writes the same message onto the file that broke it, so with a
   * single document an error would be said twice: once on the card, once on the
   * run panel that offers Retry. One panel per complaint.
   */
  errorShown?: boolean;
  /** Page one to show, when a tool is pointed at a specific page. */
  thumbnailPage?: number;
}

const keyFor = (file: File): string => `${file.name}:${file.size}`;

/**
 * One `PdfSession` per visible file, kept alive while the file is in the list.
 *
 * Thumbnails come from the real renderer, so a session has to outlive a render
 * call; the map is the owner, files leaving the list close theirs, and the
 * unmount closes whatever is left. Encrypted or unreadable files get `null`,
 * which the card draws as a stated placeholder rather than a spinner.
 */
function useFileSessions(
  files: File[],
  enabled: boolean,
): { sessions: Record<string, PdfSession>; failed: Record<string, boolean> } {
  const living = useRef(new Map<string, PdfSession>());
  const alive = useRef(true);
  const [sessions, setSessions] = useState<Record<string, PdfSession>>({});
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const keys = useMemo(() => files.slice(0, SESSION_LIMIT).map(keyFor), [files]);
  const signature = keys.join('|');

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const wanted = files.slice(0, SESSION_LIMIT);
    const wantedKeys = new Set(wanted.map(keyFor));
    // A card is identified by name and bytes, so re-picking the same file must
    // not reopen — or double-destroy — the document it already has.
    setFailed((current) => {
      const next: Record<string, boolean> = {};
      for (const key of wantedKeys) if (current[key]) next[key] = true;
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });

    for (const key of [...living.current.keys()]) {
      if (wantedKeys.has(key)) continue;
      const gone = living.current.get(key);
      living.current.delete(key);
      void gone?.destroy();
    }

    for (const file of wanted) {
      const key = keyFor(file);
      if (living.current.has(key)) continue;
      void (async () => {
        try {
          const session = await openRender(new Uint8Array(await file.arrayBuffer()));
          if (!alive.current) {
            await session.destroy();
            return;
          }
          const previous = living.current.get(key);
          living.current.set(key, session);
          if (previous) void previous.destroy();
          setSessions((current) => ({ ...current, [key]: session }));
        } catch {
          // A file pdf.js will not open still gets a card; the run names the
          // reason, and the card says the page could not be drawn.
          if (alive.current) setFailed((current) => ({ ...current, [key]: true }));
        }
      })();
    }
  }, [enabled, files, signature]);

  useEffect(() => {
    const owned = living.current;
    return () => {
      for (const session of owned.values()) void session.destroy();
      owned.clear();
    };
  }, []);

  return { sessions, failed };
}


export function FileCards({
  files,
  states,
  reorderable,
  imageInput = false,
  onRemove,
  onReorder,
  onAddMore,
  addMoreLabel = 'Add more',
  errorShown = false,
  thumbnailPage = 1,
}: FileCardsProps) {
  const { sessions, failed } = useFileSessions(files, !imageInput);
  /** Which card is grabbed, and which gap its drop would land in. */
  const [drag, setDrag] = useState<{ from: number; gap: number } | null>(null);

  const finish = (to: number) => {
    const from = drag?.from;
    setDrag(null);
    if (from == null || from === to) return;
    onReorder(from, to);
  };

  /** Pointer x a card → the gap it is being dropped on, in list positions. */
  const gapAt = (event: React.DragEvent<HTMLElement>, index: number): number => {
    const box = event.currentTarget.getBoundingClientRect();
    return event.clientX > box.left + box.width / 2 ? index + 1 : index;
  };

  /** Gap position → the index the dragged card lands at. */
  const targetFor = (from: number, gap: number): number =>
    Math.max(0, Math.min(files.length - 1, gap > from ? gap - 1 : gap));

  return (
    <ol
      className="flex list-none gap-3 overflow-x-auto pb-2"
      aria-label="Files in this job"
      onDragOver={(event) => {
        if (reorderable && drag) event.preventDefault();
      }}
    >
      {files.map((file, index) => {
        const state = states[file.name];
        const before = drag !== null && drag.gap === index;
        const after = drag !== null && drag.gap === files.length && index === files.length - 1;
        return (
          <li
            key={keyFor(file)}
            data-card={index}
            draggable={reorderable}
            onDragStart={(event) => {
              if (!reorderable) return;
              event.dataTransfer.effectAllowed = 'move';
              // Any value works as a marker; the drop target decides the slot.
              event.dataTransfer.setData('text/plain', String(index));
              setDrag({ from: index, gap: index });
            }}
            onDragOver={(event) => {
              if (!reorderable || !drag) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              setDrag({ from: drag.from, gap: gapAt(event, index) });
            }}
            onDrop={(event) => {
              if (!reorderable || !drag) return;
              event.preventDefault();
              // Dropping onto the slot it left is a no-op, and a drop past the
              // end means the last position, not a hole in the list.
              finish(targetFor(drag.from, gapAt(event, index)));
            }}
            onDragEnd={() => setDrag(null)}
            className={`relative w-[212px] shrink-0 rounded-doodle-md border bg-cream-light p-2.5 transition-colors ${
              drag?.from === index
                ? 'border-accent/50 opacity-70'
                : 'border-cream-border hover:border-ink-muted/60'
            } ${before || after ? 'border-accent' : ''}`}
          >
            {(before || after) && (
              <span
                aria-hidden
                data-drop-gap={before ? 'before' : 'after'}
                className={`absolute top-2 bottom-2 w-0.5 rounded bg-accent ${before ? '-left-2' : '-right-2'}`}
              />
            )}
            <CardThumb
              file={file}
              session={sessions[keyFor(file)] ?? null}
              unreadable={Boolean(failed[keyFor(file)])}
              imageInput={imageInput}
              page={thumbnailPage}
            />
            <p className="mt-2 truncate text-[11px] font-semibold text-ink" title={file.name}>
              {file.name}
            </p>
            <p className="mt-0.5 font-mono text-[10px] tabular-nums text-ink-muted">
              {formatFileSize(file.size)}
              {' · '}
              {state?.pages != null
                ? `${state.pages} ${state.pages === 1 ? 'page' : 'pages'}`
                : 'counting pages…'}
            </p>
            <div className="mt-2 flex items-center justify-between gap-1">
              <span className="font-mono text-[9px] uppercase tracking-[0.08em] text-ink-muted">
                {cardStage(state)}
              </span>
              <span className="flex items-center gap-1">
                {reorderable && (
                  <>
                    <button
                      type="button"
                      aria-label={`Move ${file.name} earlier`}
                      title={index === 0 ? 'This file is already first' : 'Move earlier'}
                      disabled={index === 0}
                      onClick={() => onReorder(index, index - 1)}
                      className={`flex h-7 w-7 items-center justify-center rounded border border-cream-border text-[11px] text-ink-muted hover:border-ink-muted hover:text-ink disabled:opacity-35 ${FOCUS_RING}`}
                    >
                      ←
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${file.name} later`}
                      title={index === files.length - 1 ? 'This file is already last' : 'Move later'}
                      disabled={index === files.length - 1}
                      onClick={() => onReorder(index, index + 1)}
                      className={`flex h-7 w-7 items-center justify-center rounded border border-cream-border text-[11px] text-ink-muted hover:border-ink-muted hover:text-ink disabled:opacity-35 ${FOCUS_RING}`}
                    >
                      →
                    </button>
                  </>
                )}
                <button
                  type="button"
                  aria-label={`Remove ${file.name}`}
                  title="Remove from this job"
                  onClick={() => onRemove(index)}
                  className={`flex h-7 w-7 items-center justify-center rounded border border-cream-border text-[11px] text-ink-muted hover:border-danger/40 hover:text-danger ${FOCUS_RING}`}
                >
                  ✕
                </button>
              </span>
            </div>
            {!errorShown && state?.error && (
              <ErrorPanel className="mt-2" message={state.error} fileName={file.name} />
            )}
          </li>
        );
      })}

      {onAddMore && (
        <li className="w-[132px] shrink-0">
          <button
            type="button"
            onClick={onAddMore}
            className={`flex h-full min-h-[168px] w-full flex-col items-center justify-center gap-1 rounded-doodle-md border border-dashed border-cream-border bg-cream-soft/60 px-3 text-center transition-colors hover:border-accent hover:bg-cream-light ${FOCUS_RING}`}
          >
            <span aria-hidden className="text-[18px] text-ink-muted">
              +
            </span>
            <span className="text-[11px] font-medium text-ink-soft">{addMoreLabel}</span>
            <span className="text-[10px] text-ink-muted">It stays on this device</span>
          </button>
        </li>
      )}
    </ol>
  );
}

/**
 * What this card knows about its file, in one word.
 *
 * The queue's `rowStage` answers "where is this file in a running job"; a card on
 * the ready screen is not in a job yet, and printing its `Waiting` there told the
 * user something was queued when the button was simply waiting to be pressed. A
 * card with no file has nothing to say, so it gets no word.
 */
function cardStage(state?: FileRunState): string {
  if (state?.error) return 'Stopped';
  return state?.pages == null ? 'Reading' : 'Ready';
}

interface CardThumbProps {
  file: File;
  session: PdfSession | null;
  /** The document would not open at all, so no image is ever coming. */
  unreadable: boolean;
  imageInput: boolean;
  page: number;
}

/**
 * The card's picture, or an honest placeholder.
 *
 * A PDF goes through `core/render` like every other preview in the app; an
 * image is its own thumbnail. A file that will not open, or a browser with no
 * 2-D context, says so instead of spinning.
 */
function CardThumb({ file, session, unreadable, imageInput, page }: CardThumbProps) {
  const { url, unavailable } = usePageThumbnail(imageInput ? null : session, page, 150);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!imageInput) return;
    const created = URL.createObjectURL(file);
    setObjectUrl(created);
    return () => URL.revokeObjectURL(created);
  }, [file, imageInput]);

  const shown = imageInput ? objectUrl : url;

  if (shown) {
    return (
      <img
        src={shown}
        alt=""
        data-card-thumb="image"
        className="h-[104px] w-full rounded border border-cream-border bg-cream-soft object-contain"
      />
    );
  }

  return (
    <span
      aria-hidden
      data-card-thumb={unreadable || unavailable || session ? 'placeholder' : 'waiting'}
      className="flex h-[104px] w-full items-center justify-center rounded border border-dashed border-cream-border bg-cream-soft font-mono text-[10px] uppercase tracking-[0.08em] text-ink-muted"
    >
      {unreadable || unavailable
        ? 'no preview'
        : imageInput
          ? file.name.split('.').pop() ?? 'file'
          : '◌'}
    </span>
  );
}
