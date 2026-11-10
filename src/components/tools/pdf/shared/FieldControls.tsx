/**
 * The option controls a schema-driven tool offers, and nothing else.
 *
 * These render a `PdfToolDefinition`'s field list, so a tool that only needs
 * controls writes no component at all. Styling reuses the app's existing
 * vocabulary (`doodle-*`, `cream`, `ink`, category accents) rather than inventing
 * a second look, and every value is validated where it is typed: numbers are
 * clamped into range with the reason beside them (E15), page ranges are checked
 * against the document that is actually loaded (E6).
 *
 * The panel is collapsible because the page shape puts options in the bar under
 * the file cards: a tool with one slider should not look like a form, and a
 * collapsed panel still names what is set.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { fadeUp } from '@/lib/motion';
import { openRender, type PdfSession } from '@/lib/pdf/core/render';
import { formatPages, tryResolvePages } from '@/lib/pdf/core/pages';
import { pageRangeProblem } from '@/lib/pdf/core/guard';
import { engineReady, enginePurpose } from '@/lib/pdf/core/engine-ops';
import type { EngineId } from '@/lib/pdf/engines/provider';
import { useFileStore } from '@/stores/file-store';
import type { UsePdfTool } from '@/hooks/usePdfTool';
import { describeOptions, isSetByUser, leadField, quietSummary } from './toolForm';
import { EmptyState } from './EmptyState';
import { ErrorPanel } from './ErrorPanel';
import { PageThumbs } from './PageThumbs';
import { FOCUS_RING } from './focusRing';
import type { FileValue, ToolField, ToolValues } from '@/lib/pdf/tools/types';

export const OPTIONS_PANEL_ID = 'tool-options';

export interface OptionsPanelProps {
  api: UsePdfTool;
  /** Extra controls above the generated fields (editor state, etc.). */
  before?: React.ReactNode;
  /**
   * Fields the user has operated, from `useTouchedFields`.
   *
   * The surface owns it because the panel unmounts whenever the page changes
   * state, and a deliberate choice must survive a trip back to the drop zone.
   */
  touched?: ReadonlySet<string>;
}

/**
 * Which fields the user has moved, by key.
 *
 * "Differs from the default" is a different question and the wrong one: a slider
 * dragged to the middle and back to 150, or a preset re-chosen deliberately, is
 * still a decision the collapsed row must keep showing. The set is read off the
 * value bag as it changes, so it catches every writer — the generated controls,
 * the page picker, and a bespoke editor calling `setValues`.
 */
export function useTouchedFields(
  toolId: string | undefined,
  values: ToolValues,
): ReadonlySet<string> {
  const state = useRef<{ toolId: string | undefined; previous: ToolValues; touched: Set<string> }>({
    toolId,
    previous: values,
    touched: new Set(),
  });
  const live = state.current;
  if (live.toolId !== toolId) {
    // A different tool means a re-seeded form; nothing in it has been touched.
    live.toolId = toolId;
    live.previous = values;
    live.touched = new Set();
  } else if (live.previous !== values) {
    for (const [key, value] of Object.entries(values)) {
      // A key the bag did not carry yet arrived from the definition's defaults,
      // not from a hand: the form seeding itself must not read as three changes.
      if (!(key in live.previous) || value === live.previous[key]) continue;
      live.touched.add(key);
    }
    live.previous = values;
  }
  return live.touched;
}

/**
 * Everything the user can change, in one compact row.
 *
 * The bar used to unfold every field at once — seven inputs, a page strip and
 * the password gate — which took about 40% of the viewport away from the file
 * cards, the thing the user is actually looking at. So the bar shows one field:
 * the one the run is waiting on (see `leadField`), and folds the rest behind a
 * disclosure that counts them.
 *
 * Nothing that blocks is hidden silently. The field the button is waiting for is
 * the visible one, an invalid field behind the disclosure is named on the
 * disclosure, the summary line echoes only what the user changed — or, when they
 * changed nothing, says what the run will do — and the reason line under the
 * button fires whatever is folded away.
 */
export function OptionsPanel({ api, before, touched }: OptionsPanelProps) {
  const [open, setOpen] = useState(false);
  const disclosure = useRef<HTMLButtonElement>(null);
  const restore = useRef(false);
  const fields = useMemo(
    () => (api.tool?.fields ?? []).filter((field) => !field.when || field.when(api.values)),
    [api.tool, api.values],
  );
  const lead = leadField(fields, api.issues, api.values, touched);
  const folded = fields.filter((field) => field !== lead);
  const problems = folded.filter((field) => api.issues[field.key]).length;
  const engineCount = api.tool?.engines?.length ?? 0;
  // What the row cannot show: the fields behind the disclosure, plus the engine
  // note, which only exists in the panel.
  const hidden = folded.length + engineCount;
  // The lead field is on screen as a control, so the line beside it carries only
  // what the user moved *behind* the fold. When they moved nothing anywhere the
  // row would be silent, and a silent collapsed panel cannot be told from one
  // that has been set up — so it says what the run will do instead.
  const quiet = fields.some((field) => isSetByUser(field, api.values, touched)) ? '' : quietSummary(api.tool);
  const summary = describeOptions(folded, api.values, {
    touched,
    shown: lead ? [lead.key] : [],
    whenQuiet: quiet,
  });
  // A tool with no options, no password and no engine note has nothing to fold,
  // so the row is not rendered at all rather than taking bar height for nothing.
  const controls = fields.length > 0 || api.needsPassword || engineCount > 0;

  const show = (next: boolean) => {
    if (!next) restore.current = true;
    setOpen(next);
  };
  useEffect(() => {
    // Collapsing unmounts the disclosure that was clicked and mounts the closed
    // one in its place, so the write waits for that node to exist. Without it the
    // keyboard user lands back at the top of the page after closing the panel.
    if (open || !restore.current) return;
    restore.current = false;
    disclosure.current?.focus();
  }, [open]);

  return (
    <div className="space-y-1.5" data-options-panel={open ? 'open' : 'closed'}>
      {before}

      {controls && (
        <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
          {api.needsPassword && (
            <div className="w-[240px] space-y-1">
              <LockedNotice visible={api.locked} problem={api.lockProblem} />
            </div>
          )}

          {lead && !open && (
            <div className={lead.type === 'toggle' ? '' : 'w-[240px]'}>
              <FieldControl
                field={lead}
                values={api.values}
                onChange={api.setValue}
                notice={api.notices[lead.key]}
                issue={api.issues[lead.key]}
                effective={api.checked[lead.key]}
                pageCount={api.pageCount}
                compact
              />
            </div>
          )}

          {hidden > 0 && !open && (
            <button
              ref={disclosure}
              type="button"
              aria-expanded={false}
              aria-controls={OPTIONS_PANEL_ID}
              data-options-attention={problems > 0 ? 'true' : undefined}
              onClick={() => show(true)}
              title={summary}
              className={`mb-1 flex items-center gap-1.5 rounded font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted transition-colors hover:text-ink ${FOCUS_RING}`}
            >
              <span aria-hidden>▸</span>
              {hidden} more option{hidden === 1 ? '' : 's'}
              {problems > 0 && (
                <span className="text-danger normal-case tracking-normal">
                  · {problems} need{problems === 1 ? 's' : ''} attention
                </span>
              )}
            </button>
          )}

          {!open && summary && (
            <p
              id={OPTIONS_PANEL_ID}
              className="mb-1 min-w-0 flex-1 font-mono text-[10px] leading-relaxed text-ink-muted line-clamp-2"
              title={summary}
            >
              {summary}
            </p>
          )}

          {open && (
            <button
              ref={disclosure}
              type="button"
              aria-expanded
              aria-controls={OPTIONS_PANEL_ID}
              onClick={() => show(false)}
              className={`mb-1 flex items-center gap-1.5 rounded font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted transition-colors hover:text-ink ${FOCUS_RING}`}
            >
              <span aria-hidden>▾</span>
              Fewer options
            </button>
          )}
        </div>
      )}

      {open && controls && (
        <div id={OPTIONS_PANEL_ID} className="flex flex-wrap items-start gap-x-5 gap-y-3">
          {api.groups.map((group) => (
            <section
              key={group.title || 'general'}
              className="min-w-[200px] max-w-[340px] flex-1 space-y-2.5"
            >
              {group.title && <GroupHeading title={group.title} />}
              {group.fields.map((field) => (
                <FieldControl
                  key={field.key}
                  field={field}
                  values={api.values}
                  onChange={api.setValue}
                  notice={api.notices[field.key]}
                  issue={api.issues[field.key]}
                  effective={api.checked[field.key]}
                  pageCount={api.pageCount}
                />
              ))}
            </section>
          ))}
          <EngineNotice ids={api.tool?.engines ?? []} />
        </div>
      )}

      <NotesPanel notes={api.tool?.notes ?? []} defaultOpen={Boolean(api.tool?.unavailable)} />
    </div>
  );
}

export function GroupHeading({ title }: { title: string }) {
  return (
    <h4 className="border-b border-cream-border pb-1 font-mono text-[9px] uppercase tracking-[0.12em] text-ink-muted">
      {title}
    </h4>
  );
}

/** Collapsible honesty panel — the tool's limits, not a wall of small text. */
export function NotesPanel({ notes, defaultOpen }: { notes: string[]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const listId = 'tool-notes-list';
  if (notes.length === 0) return null;
  return (
    <div className="rounded-doodle-md border border-cream-border bg-cream-soft/70">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
        className={`flex w-full items-center justify-between gap-2 rounded-doodle-md px-2.5 py-1.5 text-left ${FOCUS_RING}`}
      >
        <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-ink-muted">
          Honest notes ({notes.length})
        </span>
        <span aria-hidden className="text-[10px] text-ink-muted">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open && (
        <ul id={listId} className="space-y-1 px-2.5 pb-2">
          {notes.map((note) => (
            <li key={note} className="text-[10px] leading-relaxed text-ink-soft">
              {note}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The nudge after a run that stopped at the password.
 *
 * Two failures, two asks. `needed` is "give me something I do not have"; `wrong`
 * is "what you typed was not it". One sentence for both sends a user off to hunt
 * for a secret they just tried, which is the same class of bug as a refusal that
 * names the wrong reason — so the notice reads the code the guard raised.
 *
 * It points at the tool's own field, not at a box of this panel's: the generic
 * gate that used to live here wrote the same secret from a second input, and
 * "which of these two does Unlock read?" had no answer on the page.
 */
function LockedNotice({
  visible,
  problem,
}: {
  visible: boolean;
  problem: 'needed' | 'wrong' | null;
}) {
  if (!visible) return null;
  return (
    <p
      data-password-notice={problem ?? 'needed'}
      className="rounded-doodle-md border border-warn/25 bg-warn/5 p-2 text-[10px] leading-relaxed text-warn"
    >
      {problem === 'wrong'
        ? 'That password did not open this PDF — it is still closed. Correct it in this tool’s password field, then run again.'
        : 'This PDF needs its password before it can be opened. Type it in this tool’s password field, then run again.'}
    </p>
  );
}

function EngineNotice({ ids }: { ids: readonly EngineId[] }) {
  const missing = ids.filter((id) => !engineReady(id));
  if (ids.length === 0) return null;
  if (missing.length === 0) {
    return (
      <p className="text-[10px] leading-relaxed text-success">
        Advanced engine ready — files are still processed on this device.
      </p>
    );
  }
  return (
    <p className="w-full rounded-doodle-md border border-cream-border bg-cream-soft p-2 text-[10px] leading-relaxed text-ink-soft">
      {missing.map((id) => enginePurpose(id)).join(' ')} The module loads once from a CDN and is
      cached; your PDF never leaves this tab.
    </p>
  );
}

// ── individual controls ─────────────────────────────────────────────────────

interface FieldControlProps {
  field: ToolField;
  values: ToolValues;
  onChange: (key: string, value: unknown) => void;
  /** Why this value was changed to fit the tool's limits (E15). */
  notice?: string | null;
  /** Blocking complaint about this value. */
  issue?: string | null;
  /** The value the tool will actually receive, after clamping. */
  effective?: unknown;
  /** Page count of the loaded document, for range checks (E6). */
  pageCount?: number | null;
  /**
   * Bar mode: one line tall, no strip, no help.
   *
   * The collapsed options row is the height of one control, so the lead field
   * gives up the heavy parts of its control (the page thumbnails, the help
   * sentence) while keeping its value, its clamp notice and its error.
   */
  compact?: boolean;
}

export function FieldControl({
  field,
  values,
  onChange,
  notice,
  issue,
  effective,
  pageCount,
  compact = false,
}: FieldControlProps) {
  if (field.when && !field.when(values)) return null;
  const value = values[field.key] ?? field.default ?? null;
  const set = (next: unknown) => onChange(field.key, next);
  // A real `for`/`id` pair, so "Resolution" is the accessible name of the box
  // rather than a floating caption a screen reader never reaches.
  const inputId = `tool-field-${field.key}`;
  const bound = LABELABLE_TYPES.has(field.type) ? inputId : undefined;
  const noticeId = `${inputId}-notice`;
  const issueId = `${inputId}-issue`;
  const describedBy = [notice ? noticeId : null, issue ? issueId : null].filter(Boolean).join(' ') || undefined;

  return (
    <motion.div variants={fadeUp} className="space-y-1">
      <Label field={field} value={effective ?? value} htmlFor={bound} />
      <Control
        field={field}
        value={value}
        onChange={set}
        pageCount={pageCount}
        inputId={bound}
        describedBy={bound ? describedBy : undefined}
        compact={compact}
      />
      {notice && <p id={noticeId} className="text-[10px] leading-relaxed text-warn">{notice}</p>}
      {issue && <p id={issueId} className="text-[10px] leading-relaxed text-danger">{issue}</p>}
      {!compact && !notice && !issue && field.help && (
        <p className="text-[10px] leading-relaxed text-ink-muted">{field.help}</p>
      )}
    </motion.div>
  );
}

/** Field types whose control is a single labelable form element. */
const LABELABLE_TYPES = new Set<ToolField['type']>([
  'text',
  'textarea',
  'number',
  'slider',
  'select',
  'password',
  'pages',
  'dimensions',
]);

function Label({
  field,
  value,
  htmlFor,
}: {
  field: ToolField;
  value: unknown;
  htmlFor?: string;
}) {
  if (field.type === 'toggle') return null;
  const showValue =
    (field.type === 'slider' || field.type === 'number') &&
    typeof value === 'number' &&
    Number.isFinite(value);
  const readout = showValue
    ? `${trim(value as number)}${field.unit ?? ''}`
    : field.unit
      ? `(${field.unit})`
      : '';
  const caption = 'font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted';
  // The label carries only the field's words: the required mark is CSS content
  // and the live value sits beside it, so "Resolution" stays the accessible name.
  const title = (
    <>
      {field.label}
      {field.required && <span className="ml-0.5 text-danger after:content-['*']" aria-hidden />}
    </>
  );
  return (
    <div className="flex items-baseline justify-between gap-2">
      {htmlFor ? (
        <label htmlFor={htmlFor} className={caption}>
          {title}
        </label>
      ) : (
        <span className={caption}>{title}</span>
      )}
      <span className="font-display text-[11px] normal-case tracking-normal text-ink-soft tabular-nums">
        {readout}
      </span>
    </div>
  );
}

function trim(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

interface ControlProps {
  field: ToolField;
  value: unknown;
  /** Already bound to this field's key. */
  onChange: (next: unknown) => void;
  pageCount?: number | null;
  /** Present when the label can be bound to this control. */
  inputId?: string;
  /**
   * Ids of the notice and issue lines under this control. A visible caption is
   * not an announced one: without this a screen reader reads "Open password"
   * and never hears "Enter the password readers must type to open this PDF",
   * which is the entire reason the message exists.
   */
  describedBy?: string;
  /** See `FieldControlProps.compact`. */
  compact?: boolean;
}

function Control({ field, value, onChange, pageCount, inputId, describedBy, compact = false }: ControlProps) {
  switch (field.type) {
    case 'toggle':
      return (
        <label
          className={`flex cursor-pointer items-center gap-2 py-0.5 ${
            // In the collapsed row the box belongs next to its words; the wide
            // two-column form keeps its label and box on opposite edges.
            compact ? '' : 'justify-between'
          }`}
        >
          <span className="text-[11px] text-ink-soft">{field.label}</span>
          <input
            type="checkbox"
            checked={typeof value === 'boolean' ? value : Boolean(field.default)}
            onChange={(event) => onChange(event.target.checked)}
            className="h-3 w-3 accent-accent"
          />
        </label>
      );
    case 'textarea':
      return (
        <textarea
          id={inputId}
          aria-describedby={describedBy}
          value={String(value ?? '')}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder}
          rows={4}
          className="doodle-input resize-y font-mono text-[11px] leading-relaxed"
        />
      );
    case 'number': {
      // The raw text stays editable; clamping happens in the value layer so
      // typing "400" into a 72–300 field does not fight the keyboard.
      const typed = typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
      return (
        <input
          type="number"
          id={inputId}
          aria-describedby={describedBy}
          value={typed}
          min={field.min}
          max={field.max}
          step={field.step ?? 1}
          onChange={(event) => onChange(event.target.valueAsNumber)}
          className="doodle-input"
        />
      );
    }
    case 'slider':
      return (
        <input
          type="range"
          id={inputId}
          aria-describedby={describedBy}
          min={field.min ?? 0}
          max={field.max ?? 1}
          step={field.step ?? 0.01}
          value={typeof value === 'number' ? value : Number(field.default ?? 0)}
          onChange={(event) => onChange(event.target.valueAsNumber)}
          className="w-full accent-accent"
        />
      );
    case 'color':
      return (
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label={`${field.label} colour`}
            value={/^#[0-9a-f]{6}$/i.test(String(value ?? '')) ? String(value) : '#000000'}
            onChange={(event) => onChange(event.target.value)}
            className={`h-7 w-10 cursor-pointer rounded border border-cream-border bg-cream-light ${FOCUS_RING}`}
          />
          <input
            aria-label={`${field.label} hex value`}
            value={String(value ?? '')}
            onChange={(event) => onChange(event.target.value)}
            className="doodle-input font-mono text-[11px]"
          />
        </div>
      );
    case 'select':
      return (
        <select
          id={inputId}
          aria-describedby={describedBy}
          value={String(value ?? field.default ?? '')}
          onChange={(event) => onChange(coerce(field, event.target.value))}
          className="doodle-input"
        >
          {(field.options ?? []).map((option) => (
            <option key={String(option.value)} value={String(option.value)}>
              {option.label}
              {option.hint ? ` — ${option.hint}` : ''}
            </option>
          ))}
        </select>
      );
    case 'segmented':
      return (
        <div role="group" aria-label={field.label} className="flex flex-wrap gap-1">
          {(field.options ?? []).map((option) => {
            const active = String(value) === String(option.value);
            return (
              <button
                key={String(option.value)}
                type="button"
                aria-pressed={active}
                title={option.hint}
                onClick={() => onChange(coerce(field, String(option.value)))}
                className={`doodle-chip text-[10px] ${active ? 'doodle-chip-active' : 'doodle-chip-inactive'} ${FOCUS_RING}`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      );
    case 'multiselect': {
      const chosen = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div
          role="group"
          aria-label={field.label}
          className={`grid grid-cols-2 gap-x-2 gap-y-0.5 overflow-y-auto pr-1 ${
            compact ? 'max-h-24' : 'max-h-40'
          }`}
        >
          {(field.options ?? []).map((option) => (
            <label
              key={String(option.value)}
              className="flex cursor-pointer items-center gap-1.5 py-0.5 text-[10px] text-ink-soft"
            >
              <input
                type="checkbox"
                checked={chosen.includes(String(option.value))}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...chosen, String(option.value)]
                      : chosen.filter((item) => item !== String(option.value)),
                  )
                }
                className={`h-3 w-3 accent-accent ${FOCUS_RING}`}
              />
              {option.label}
            </label>
          ))}
        </div>
      );
    }
    case 'pages':
      return (
        <PagePicker
          value={value}
          onChange={onChange}
          pageCount={pageCount}
          inputId={inputId}
          describedBy={describedBy}
          compact={compact}
        />
      );
    case 'password':
      return (
        <input
          type="password"
          id={inputId}
          aria-describedby={describedBy}
          value={String(value ?? '')}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder}
          className="doodle-input"
          autoComplete="off"
        />
      );
    case 'file':
      return <FilePicker field={field} value={value} onChange={onChange} />;
    case 'dimensions':
      return (
        <div role="group" aria-label={field.label} className="grid grid-cols-2 gap-2">
          {(['width', 'height'] as const).map((axis) => {
            const current = (value ?? {}) as Record<string, number>;
            return (
              <input
                key={axis}
                type="number"
                id={axis === 'width' ? inputId : undefined}
                // Only one input can wear the field's label, so the other names
                // itself with the same words plus its axis.
                aria-label={axis === 'width' ? undefined : `${field.label} ${axis}`}
                min={1}
                value={current[axis] ?? 0}
                onChange={(event) => onChange({ ...current, [axis]: event.target.valueAsNumber })}
                placeholder={axis}
                className="doodle-input"
              />
            );
          })}
        </div>
      );
    case 'text':
    default:
      return (
        <input
          id={inputId}
          aria-describedby={describedBy}
          value={String(value ?? '')}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder}
          className="doodle-input"
        />
      );
  }
}

function coerce(field: ToolField, raw: string): string | number {
  const option = field.options?.find((candidate) => String(candidate.value) === raw);
  return typeof option?.value === 'number' ? option.value : raw;
}

// ── page picker ─────────────────────────────────────────────────────────────

function PagePicker({
  value,
  onChange,
  pageCount,
  inputId,
  describedBy,
  compact = false,
}: {
  value: unknown;
  onChange: (next: unknown) => void;
  pageCount?: number | null;
  inputId?: string;
  /** See `ControlProps.describedBy`. */
  describedBy?: string;
  compact?: boolean;
}) {
  const file = useFileStore((s) => s.file);
  const [session, setSession] = useState<PdfSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const spec = typeof value === 'string' ? value : 'all';

  useEffect(() => {
    if (!file) return;
    let disposed = false;
    let local: PdfSession | null = null;
    setError(null);
    (async () => {
      try {
        const opened = await openRender(new Uint8Array(await file.arrayBuffer()));
        if (disposed) {
          await opened.destroy();
          return;
        }
        local = opened;
        setSession(opened);
      } catch (err) {
        if (!disposed) {
          setError(err instanceof Error ? err.message : 'Could not preview this PDF.');
        }
      }
    })();
    return () => {
      disposed = true;
      void local?.destroy();
      setSession(null);
    };
  }, [file]);

  const total = session?.numPages ?? pageCount ?? 0;
  const selected = useMemo(() => {
    if (!total) return [] as number[];
    const resolved = tryResolvePages(spec, total);
    return (resolved ?? []).map((index) => index + 1);
  }, [spec, total]);

  const apply = useCallback(
    (pages: number[]) => {
      if (pages.length === 0) {
        onChange('');
        return;
      }
      onChange(
        pages.length === total
          ? 'all'
          : formatPages(
              [...pages]
                .sort((a, b) => a - b)
                .map((p) => p - 1),
            ),
      );
    },
    [onChange, total],
  );

  // The strip knows the real page count, so it can say "page 9 of 3" here even
  // when the workspace metadata has not landed yet.
  const problem = total > 0 ? pageRangeProblem(spec, total) : null;

  if (error) {
    return (
      <div className="space-y-1.5">
        <ErrorPanel message={error} fileName={file?.name} />
        <input
          id={inputId}
          aria-describedby={describedBy}
          value={spec}
          onChange={(event) => onChange(event.target.value)}
          placeholder="1,3,5-7"
          className="doodle-input"
        />
      </div>
    );
  }

  if (!session) {
    return (
      <input
        id={inputId}
          aria-describedby={describedBy}
        value={spec === 'all' ? '' : spec}
        onChange={(event) => onChange(event.target.value || 'all')}
        placeholder="1,3,5-7"
        className="doodle-input"
      />
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1">
        <input
          id={inputId}
          aria-describedby={describedBy}
          value={spec}
          onChange={(event) => onChange(event.target.value)}
          className="doodle-input flex-1 font-mono text-[10px]"
          placeholder="1,3,5-7"
        />
        <button
          type="button"
          aria-pressed={spec === 'all'}
          title="Every page of this file"
          onClick={() => onChange('all')}
          className={`doodle-chip w-auto px-2 text-[9px] ${
            spec === 'all' ? 'doodle-chip-active' : 'doodle-chip-inactive'
          } ${FOCUS_RING}`}
        >
          all
        </button>
        <button
          type="button"
          aria-pressed={spec === ''}
          title="Clear the selection"
          onClick={() => onChange('')}
          className={`doodle-chip w-auto px-2 text-[9px] ${
            spec === '' ? 'doodle-chip-active' : 'doodle-chip-inactive'
          } ${FOCUS_RING}`}
        >
          none
        </button>
      </div>
      <p className="font-mono text-[9px] uppercase tracking-[0.08em] text-ink-muted tabular-nums">
        {selected.length === total
          ? `all ${total} ${total === 1 ? 'page' : 'pages'} picked`
          : `${selected.length} of ${total} pages picked`}
      </p>
      {problem && <p className="text-[10px] leading-relaxed text-danger">{problem}</p>}
      {/* The strip is the reason this control is not bar height: a collapsed row
          gets the text field, the count and the error, and the picker comes back
          when the options are expanded. */}
      {!compact && (
        <div className="h-52">
          <PageThumbs
            session={session}
            selected={selected}
            onSelect={apply}
            columns={4}
            rowHeight={120}
            maxSide={96}
            label="Pages in this file"
          />
        </div>
      )}
    </div>
  );
}

// ── file field ──────────────────────────────────────────────────────────────

function FilePicker({
  field,
  value,
  onChange,
}: {
  field: ToolField;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const chosen = (Array.isArray(value) ? value : value ? [value] : []) as FileValue[];

  const pick = async (list: FileList | null) => {
    if (!list) return;
    const taken = await Promise.all(
      Array.from(list).map(async (file) => ({
        name: file.name,
        mimeType: file.type,
        size: file.size,
        bytes: new Uint8Array(await file.arrayBuffer()),
      })),
    );
    onChange(field.multiple ? [...chosen, ...taken].slice(0, field.maxFiles ?? 20) : taken.slice(0, 1));
  };

  return (
    <div role="group" aria-label={field.label} className="space-y-1">
      <button
        type="button"
        onClick={() => input.current?.click()}
        className={`doodle-btn doodle-btn-secondary w-auto px-3 py-1.5 text-[11px] ${FOCUS_RING}`}
      >
        {chosen.length > 0 ? `${chosen.length} file${chosen.length === 1 ? '' : 's'} chosen` : 'Choose file…'}
      </button>
      <input
        ref={input}
        type="file"
        accept={field.accept}
        multiple={field.multiple}
        className="hidden"
        onChange={(event) => void pick(event.target.files)}
      />
      {chosen.length === 0 && (
        <EmptyState
          title="No attachment yet"
          body="Add the extra file this step needs — it is read in this tab and never uploaded."
          icon="📎"
        />
      )}
      {chosen.map((item, index) => (
        <div
          key={`${item.name}-${index}`}
          className="flex items-center justify-between gap-2 rounded border border-cream-border bg-cream-light px-2 py-1 text-[10px]"
        >
          <span className="truncate">{item.name}</span>
          <button
            type="button"
            aria-label={`Remove ${item.name}`}
            title="Remove this attachment"
            onClick={() => onChange(chosen.filter((_, i) => i !== index))}
            className={`text-ink-muted hover:text-danger ${FOCUS_RING}`}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
