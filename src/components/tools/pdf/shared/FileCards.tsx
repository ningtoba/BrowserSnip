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
import { describeEncryption, refusalReason, type PdfEncryption } from '@/lib/pdf/core/guard';
import { formatFileSize } from '@/lib/utils/download';
import type { FileLockState, FileRunState } from '@/stores/process-store';
import { splitFileName } from './toolForm';
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
  /** True while the page is already printing the failure these cards came from.
   *
   * The store writes the same message onto the file that broke it, so with a
   * single document an error would be said twice: once on the card, once on the
   * run panel that offers Retry. One panel per complaint.
   */
  errorShown?: boolean;
  /** Page one to show, when a tool is pointed at a specific page. */
  thumbnailPage?: number;
  /**
   * The job's open password — the secret typed on a card, if any.
   *
   * Held by `usePdfTool` and passed to the runner as `RunRequest.password`, the
   * channel `openInputs` already reads. One secret per job, which is what the
   * plumbing carries; a job with two locked files says so on the row rather than
   * pretending the boxes are independent.
   */
  password?: string;
  onPassword?: (value: string) => void;
  /** True while a re-read prompted by a new secret is still in flight. */
  passwordChecking?: boolean;
  /**
   * True when this tool asks for a password in its own form.
   *
   * Then the card states the lock and names that field instead of adding a second
   * box beside it: two inputs for one secret is how a user ends up typing it into
   * the wrong one. The tool's own field is the only box, and the runner's
   * precedence can never see both filled.
   */
  toolOwnsPassword?: boolean;
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
  password = '',
  onPassword,
  passwordChecking = false,
  toolOwnsPassword = false,
}: FileCardsProps) {
  const { sessions, failed } = useFileSessions(files, !imageInput);
  /** Which card is grabbed, and which gap its drop would land in. */
  const [drag, setDrag] = useState<{ from: number; gap: number } | null>(null);
  // More than one locked file in the job: the secret is one string for all of
  // them, and the row has to say that instead of offering two boxes that look
  // like they hold two answers.
  const lockedCards = files.filter((file) => {
    const lock = states[file.name]?.lock ?? 'none';
    return lock === 'needs-password' || lock === 'wrong-password';
  }).length;

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
            <FileName name={file.name} />
            <p className="mt-0.5 font-mono text-[10px] tabular-nums text-ink-muted">
              {formatFileSize(file.size)}
              {' · '}
              {state?.pages != null
                ? `${state.pages} ${state.pages === 1 ? 'page' : 'pages'}`
                : 'counting pages…'}
            </p>
            <FileLockRow
              name={file.name}
              lock={state?.lock ?? 'none'}
              encryption={state?.encryption ?? null}
              password={password}
              onPassword={onPassword}
              checking={passwordChecking}
              toolOwnsPassword={toolOwnsPassword}
              shared={lockedCards > 1}
            />
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
 * card with no file has nothing to say, so it gets no word. A file whose lock is
 * still shut is not `Ready` either: the run would refuse it, and the word has to
 * say so before the click rather than after.
 */
function cardStage(state?: FileRunState): string {
  if (state?.error) return 'Stopped';
  if (state?.lock === 'needs-password' || state?.lock === 'wrong-password' || state?.lock === 'unsupported') {
    return 'Locked';
  }
  return state?.pages == null ? 'Reading' : 'Ready';
}

/**
 * The card's file name: two lines, and the end of the string kept reachable.
 *
 * One truncated line turned "quarterly-report-2024-q3-final-draft-signed.pdf"
 * into a fragment that identified nothing, because the part that separates files
 * from each other — the version digits and the extension — is at the end. The
 * head gets two lines with an ellipsis at the cut, the tail keeps its own line
 * once the name is too long for two, and the whole name is in `title`.
 */
export function FileName({ name, className = 'mt-2' }: { name: string; className?: string }) {
  const { head, tail } = splitFileName(name);
  return (
    <p
      className={`${className} text-[11px] font-semibold leading-snug text-ink`}
      title={name}
      data-file-name={tail ? 'split' : 'whole'}
    >
      <span className="line-clamp-2 break-words">{head}</span>
      {tail && (
        <span data-file-tail className="block break-all font-mono text-[10px] font-normal text-ink-muted">
          {tail}
        </span>
      )}
    </p>
  );
}

/* ── the lock, stated on the file that carries it ─────────────────────────── */

export interface FileLockRowProps {
  /** The file this row speaks for, so the box can be named to a screen reader. */
  name: string;
  /** What the pre-flight's password check answered for this file. */
  lock: FileLockState;
  /** The file's own encryption dictionary, as `core/guard` classified it. */
  encryption: PdfEncryption | null;
  /** The job's secret, from `usePdfTool`. */
  password: string;
  onPassword?: (value: string) => void;
  /** True while a re-read prompted by a new secret is still outstanding. */
  checking?: boolean;
  /** True when the tool declares a password field of its own. */
  toolOwnsPassword?: boolean;
  /** True when more than one file in this job needs a secret. */
  shared?: boolean;
}

/**
 * What this file's lock is, and the one place its password can be typed.
 *
 * An `/Encrypt` entry states two things: which cipher the bytes carry, and which
 * secret opens it. The app asked for that secret only inside a tool that declared a
 * password field — four tools — so every other one refused an AES-128 file outright
 * while `core/crypto` could read it back as words. The fact about the file lives on
 * the card, so that is where the entry goes: one component, and the ~120 tools that
 * ask nothing gain it at once.
 *
 * Three rules keep the row honest:
 *
 * - it names the cipher **and the revision** the dictionary actually spells, never a
 *   strength the file does not carry;
 * - a cipher this app cannot undo is refused with the same clause the run gives, and
 *   gets **no box** — a control that cannot change the output is the kind this
 *   campaign keeps deleting;
 * - "no password yet" and "that password is wrong" are said differently, because one
 *   is a request and the other is a correction.
 *
 * When the tool has its own password field, the row states the lock and names that
 * field instead of stacking a second box beside it: two inputs for one secret is how
 * a user ends up typing it into the wrong one.
 */
export function FileLockRow({
  name,
  lock,
  encryption,
  password,
  onPassword,
  checking = false,
  toolOwnsPassword = false,
  shared = false,
}: FileLockRowProps) {
  if (lock === 'none' || !encryption) return null;
  const ciphered = encryption.state === 'ciphered';
  const headline = ciphered
    ? `Encrypted with ${describeEncryption(encryption)}`
    : `Password gate, ${describeEncryption(encryption)}`;
  const asks = (lock === 'needs-password' || lock === 'wrong-password') && !toolOwnsPassword;

  let tone = 'border-cream-border bg-cream-soft/70 text-ink-soft';
  let text: string;
  if (lock === 'unsupported') {
    tone = 'border-warn/25 bg-warn/5 text-warn';
    text = `Left alone because ${refusalReason(encryption) ?? 'this app cannot undo this cipher'}. Its password does not change that: a tool that rebuilds the file refuses it and says why.`;
  } else if (lock === 'opens-empty') {
    text = ciphered
      ? 'Its user password is empty, so the pages open with nothing typed.'
      : 'It opens with nothing typed: the flags ask a reader to behave, and there is no cipher to undo.';
  } else if (lock === 'opened') {
    tone = 'border-success/25 bg-success/5 text-success';
    text = 'Password accepted — the pages are readable.';
  } else if (lock === 'wrong-password') {
    tone = 'border-danger/25 bg-danger/5 text-danger';
    text = toolOwnsPassword
      ? 'That is not the password for this file. Correct it in this tool’s own password box.'
      : 'That is not the password for this file — it is still closed. Try again.';
  } else {
    tone = 'border-warn/25 bg-warn/5 text-warn';
    text = toolOwnsPassword
      ? 'This file needs its password to be opened, and this tool asks for it in its own options.'
      : 'This file needs its password before anything here can read its pages.';
  }

  return (
    // A drag started inside the box is a text selection, not a reorder: the card
    // is draggable on multi-file tools, and stealing the gesture made the field
    // impossible to edit.
    <div
      className={`mt-1.5 space-y-1 rounded-doodle border p-1.5 ${tone}`}
      data-file-lock={lock}
      onDragStart={(event) => event.stopPropagation()}
    >
      <p className="font-mono text-[9px] uppercase leading-snug tracking-[0.08em]" data-file-cipher>
        {headline}
      </p>
      <p className="text-[10px] leading-snug">{text}</p>
      {asks && (
        <label className="block space-y-1">
          <span className="font-mono text-[9px] uppercase tracking-[0.08em]">
            Password for this file
          </span>
          <input
            type="password"
            value={password}
            onChange={(event) => onPassword?.(event.target.value)}
            placeholder="Opens this file"
            aria-label={`Open password for ${name}`}
            data-file-password={name}
            autoComplete="off"
            spellCheck={false}
            className={`doodle-input w-full px-2 py-1 text-[11px] ${FOCUS_RING}`}
          />
          {shared && (
            <span className="block text-[9px] leading-snug opacity-80">
              One secret per job: this applies to every locked file here.
            </span>
          )}
          {checking && (
            <span className="block font-mono text-[9px] uppercase tracking-[0.08em]" data-lock-checking>
              re-reading…
            </span>
          )}
        </label>
      )}
    </div>
  );
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
