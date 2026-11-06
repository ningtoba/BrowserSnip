/**
 * Shared PDF tool UI kit.
 *
 * Renders a `PdfToolDefinition`'s field list into the sidebar rail, so a tool
 * that only needs controls writes no component at all. Styling reuses the app's
 * existing vocabulary (`doodle-*`, `cream`, `ink`, category accents) rather
 * than inventing a second look.
 *
 * The rail's job is to be honest before it is pretty: fields are grouped and
 * labelled, numbers are clamped into range with the reason next to them, the
 * primary action carries the tool's own verb and stays off until the inputs
 * work, and the tool's limits live in a collapsible panel instead of loose
 * paragraphs.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { fadeUp, staggerParent, tapDown } from '@/lib/motion';
import { usePdfTool, type UsePdfTool } from '@/hooks/usePdfTool';
import { useFileStore } from '@/stores/file-store';
import { useProcessStore, type ToolPhase } from '@/stores/process-store';
import { openRender, thumbnails, type PdfSession } from '@/lib/pdf/core/render';
import { formatPages, tryResolvePages } from '@/lib/pdf/core/pages';
import { pageRangeProblem } from '@/lib/pdf/core/guard';
import { engineReady, enginePurpose } from '@/lib/pdf/core/engine-ops';
import type { EngineId } from '@/lib/pdf/engines/provider';
import {
  type FileValue,
  type PdfToolDefinition,
  type ToolField,
  type ToolValues,
} from '@/lib/pdf/tools/types';
import { EmptyState } from './EmptyState';
import { ErrorPanel } from './ErrorPanel';
import { FileQueue } from './FileQueue';
import { PageThumbs } from './PageThumbs';
import { ProgressBar } from './ProgressBar';
import { ResultCard, type ResultItem } from './ResultCard';

export interface PdfToolPanelProps {
  toolId: string;
  /** Extra controls rendered above the generated form (editor state, etc.). */
  before?: React.ReactNode;
  /** Render the Run button but let the caller trigger it. */
  hidden?: boolean;
  /** Called after a successful run with the produced outputs. */
  onDone?: () => void;
}

/** The generated sidebar panel for one tool. */
export function PdfToolPanel({ toolId, before, hidden, onDone }: PdfToolPanelProps) {
  const file = useFileStore((s) => s.file);
  const metadata = useFileStore((s) => s.metadata);
  // A page count is only usable for validation while it describes this file.
  const pageCount =
    metadata && 'pageCount' in metadata && metadata.pageCount > 0 && (!file || metadata.fileName === file.name)
      ? metadata.pageCount
      : null;
  const api = usePdfTool(toolId, { pageCount });

  const panel = (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={staggerParent}
      className="doodle-section space-y-3"
    >
      {before}

      <header className="space-y-1">
        <div className="flex items-start justify-between gap-2">
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
            {api.tool?.name ?? toolId}
          </p>
          <PhaseBadge phase={api.phase} />
        </div>
        <p className="text-[11px] leading-relaxed text-ink-soft">{api.promise}</p>
      </header>

      <EngineNotice ids={api.tool?.engines ?? []} />
      {api.needsPassword && <PasswordGate api={api} />}
      <LockedNotice visible={api.locked} />

      <InputQueue />

      {api.groups.map((group) => (
        <section key={group.title || 'general'} className="space-y-2.5">
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

      <NotesPanel notes={api.tool?.notes ?? []} defaultOpen={Boolean(api.tool?.unavailable)} />

      <RunProgress />
      <RunError onRetry={() => void api.run()} />
      <RunControls api={api} onDone={onDone} />
      <ResultSummary engines={api.tool?.engines ?? []} />
    </motion.div>
  );

  if (hidden) {
    return <div className="hidden" aria-hidden>{panel}</div>;
  }
  return panel;
}

// ── state chrome ────────────────────────────────────────────────────────────

const PHASE_LABEL: Record<ToolPhase, string> = {
  idle: 'No file',
  inspecting: 'Reading file',
  ready: 'Ready',
  running: 'Working',
  done: 'Done',
  error: 'Needs attention',
};

const PHASE_CLASS: Record<ToolPhase, string> = {
  idle: 'border-cream-border text-ink-muted',
  inspecting: 'border-cream-border text-ink-muted',
  ready: 'border-accent/30 text-accent',
  running: 'border-accent/30 text-accent',
  done: 'border-success/30 text-success',
  error: 'border-danger/30 text-danger',
};

function PhaseBadge({ phase }: { phase: ToolPhase }) {
  return (
    <span
      data-phase={phase}
      className={`shrink-0 rounded-full border bg-cream-light px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em] ${PHASE_CLASS[phase]}`}
    >
      {PHASE_LABEL[phase]}
    </span>
  );
}

function GroupHeading({ title }: { title: string }) {
  return (
    <h4 className="border-b border-cream-border pb-1 font-mono text-[9px] uppercase tracking-[0.12em] text-ink-muted">
      {title}
    </h4>
  );
}

/** Collapsible honesty panel — the tool's limits, not a wall of small text. */
function NotesPanel({ notes, defaultOpen }: { notes: string[]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  if (notes.length === 0) return null;
  return (
    <div className="rounded-doodle-md border border-cream-border bg-cream-soft/70">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left"
      >
        <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-ink-muted">
          Honest notes ({notes.length})
        </span>
        <span aria-hidden className="text-[10px] text-ink-muted">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open && (
        <ul className="space-y-1 px-2.5 pb-2">
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

function RunProgress() {
  const phase = useProcessStore((s) => s.phase);
  const progress = useProcessStore((s) => s.progress);
  const statusMessage = useProcessStore((s) => s.statusMessage);
  const isProcessing = useProcessStore((s) => s.isProcessing);
  if (!isProcessing && phase !== 'running') return null;
  return <ProgressBar percent={progress} message={statusMessage} label="Working" indeterminate={progress === 0} />;
}

function RunError({ onRetry }: { onRetry: () => void }) {
  const error = useProcessStore((s) => s.error);
  const hint = useProcessStore((s) => s.errorHint);
  const files = useFileStore((s) => s.files);
  if (!error) return null;
  const named = files.find((candidate) => error.includes(candidate.name));
  return (
    <ErrorPanel
      message={error}
      hint={hint ?? undefined}
      fileName={named?.name ?? (files.length === 1 ? files[0].name : null)}
      onRetry={onRetry}
    />
  );
}

/** Multi-file tools show the queue the result depends on, in order. */
function InputQueue() {
  const files = useFileStore((s) => s.files);
  const removeFile = useFileStore((s) => s.removeFile);
  const reorderFiles = useFileStore((s) => s.reorderFiles);
  const fileStates = useProcessStore((s) => s.fileStates);
  const phase = useProcessStore((s) => s.phase);
  if (files.length < 2) return null;

  const items = files.map((item) => {
    const state = fileStates[item.name];
    return {
      id: item.name,
      name: item.name,
      size: item.size,
      pages: state?.pages ?? null,
      percent: state?.percent ?? null,
      message: state?.message,
      error: state?.error ?? null,
      busy: phase === 'running' && (state?.percent ?? 0) < 100,
    };
  });

  return (
    <motion.section variants={fadeUp} className="space-y-1.5">
      <GroupHeading title="Your files" />
      <FileQueue
        items={items}
        onRemove={(id) => {
          const index = files.findIndex((candidate) => candidate.name === id);
          if (index >= 0) removeFile(index);
        }}
        onReorder={(from, to) => reorderFiles(from, to)}
      />
    </motion.section>
  );
}

/** The result of the last run, read straight from the process store. */
function ResultSummary({ engines }: { engines: readonly EngineId[] }) {
  const phase = useProcessStore((s) => s.phase);
  const blobs = useProcessStore((s) => s.outputBlobs);
  const names = useProcessStore((s) => s.outputNames);
  const sizeBefore = useProcessStore((s) => s.sizeBefore);
  const warnings = useProcessStore((s) => s.warnings);
  const statusMessage = useProcessStore((s) => s.statusMessage);
  const file = useFileStore((s) => s.file);

  if (phase !== 'done' || blobs.length === 0) return null;
  const outputs: ResultItem[] = blobs.map((blob, index) => ({
    name: names[index] ?? `output-${index + 1}`,
    blob,
  }));
  const degraded = warnings.some((warning) => /degrad/i.test(warning));

  return (
    <ResultCard
      outputs={outputs}
      sizeBefore={sizeBefore}
      warnings={warnings}
      message={statusMessage || undefined}
      engine={engines[0] ?? null}
      degraded={degraded}
      original={file ? { name: file.name, blob: file } : null}
    />
  );
}

function RunControls({ api, onDone }: { api: UsePdfTool; onDone?: () => void }) {
  return (
    <motion.div variants={fadeUp} className="space-y-1.5 pt-1">
      <div className="flex items-center gap-2">
        <motion.button
          whileTap={api.canRun && !api.isRunning ? tapDown : undefined}
          id="tool-process-btn"
          disabled={!api.canRun || api.isRunning}
          aria-disabled={!api.canRun || api.isRunning}
          onClick={async () => {
            const outcome = await api.run();
            if (outcome) onDone?.();
          }}
          className="doodle-btn flex-1 disabled:opacity-50"
        >
          {api.isRunning ? 'Working…' : api.verb}
        </motion.button>
        {api.isRunning && (
          <button onClick={api.cancel} className="doodle-btn doodle-btn-danger text-[11px]">
            Cancel
          </button>
        )}
      </div>
      {api.canRun && !api.isRunning && api.advisories.length > 0 && (
        <p className="rounded-md border border-warn/25 bg-warn/5 px-2.5 py-1.5 text-[11px] leading-relaxed text-warn">
          {api.advisories[0]}
        </p>
      )}

      {!api.canRun && !api.isRunning && api.blockers.length > 0 && (
        <p className="text-[10px] leading-relaxed text-ink-muted">
          {api.blockers[0]}
          {api.blockers.length > 1 ? ` (+${api.blockers.length - 1} more to fix)` : ''}
        </p>
      )}
    </motion.div>
  );
}

function PasswordGate({ api }: { api: UsePdfTool }) {
  return (
    <label className="block space-y-1">
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
        PDF password
      </span>
      <input
        type="password"
        value={api.password}
        onChange={(event) => api.setPassword(event.target.value)}
        placeholder="Not required unless the file is protected"
        className="doodle-input"
        autoComplete="off"
      />
    </label>
  );
}

function LockedNotice({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <p className="rounded-doodle-md border border-warn/25 bg-warn/5 p-2 text-[10px] leading-relaxed text-warn">
      This PDF is password protected. Enter its password above and run again.
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
    <p className="rounded-doodle-md border border-cream-border bg-cream-soft p-2 text-[10px] leading-relaxed text-ink-soft">
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
}

export function FieldControl({
  field,
  values,
  onChange,
  notice,
  issue,
  effective,
  pageCount,
}: FieldControlProps) {
  if (field.when && !field.when(values)) return null;
  const value = values[field.key] ?? field.default ?? null;
  const set = (next: unknown) => onChange(field.key, next);
  // A real `for`/`id` pair, so "Resolution" is the accessible name of the box
  // rather than a floating caption a screen reader never reaches.
  const inputId = `tool-field-${field.key}`;
  const bound = LABELABLE_TYPES.has(field.type) ? inputId : undefined;

  return (
    <motion.div variants={fadeUp} className="space-y-1">
      <Label field={field} value={effective ?? value} htmlFor={bound} />
      <Control field={field} value={value} onChange={set} pageCount={pageCount} inputId={bound} />
      {notice && (
        <p className="text-[10px] leading-relaxed text-warn">{notice}</p>
      )}
      {issue && (
        <p className="text-[10px] leading-relaxed text-danger">{issue}</p>
      )}
      {!notice && !issue && field.help && (
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
    (field.type === 'slider' || field.type === 'number') && typeof value === 'number' && Number.isFinite(value);
  const readout = showValue ? `${trim(value as number)}${field.unit ?? ''}` : field.unit ? `(${field.unit})` : '';
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
}

function Control({ field, value, onChange, pageCount, inputId }: ControlProps) {
  switch (field.type) {
    case 'toggle':
      return (
        <label className="flex cursor-pointer items-center justify-between gap-2 py-0.5">
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
            value={/^#[0-9a-f]{6}$/i.test(String(value ?? '')) ? String(value) : '#000000'}
            onChange={(event) => onChange(event.target.value)}
            className="h-7 w-10 cursor-pointer rounded border border-cream-border bg-cream-light"
          />
          <input
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
        <div className="flex flex-wrap gap-1">
          {(field.options ?? []).map((option) => {
            const active = String(value) === String(option.value);
            return (
              <button
                key={String(option.value)}
                type="button"
                title={option.hint}
                onClick={() => onChange(coerce(field, String(option.value)))}
                className={`doodle-chip text-[10px] ${active ? 'doodle-chip-active' : 'doodle-chip-inactive'}`}
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
        <div className="grid max-h-40 grid-cols-2 gap-x-2 gap-y-0.5 overflow-y-auto pr-1">
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
                className="h-3 w-3 accent-accent"
              />
              {option.label}
            </label>
          ))}
        </div>
      );
    }
    case 'pages':
      return <PagePicker value={value} onChange={onChange} pageCount={pageCount} inputId={inputId} />;
    case 'password':
      return (
        <input
          type="password"
          id={inputId}
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
        <div className="grid grid-cols-2 gap-2">
          {(['width', 'height'] as const).map((axis) => {
            const current = (value ?? {}) as Record<string, number>;
            return (
              <input
                key={axis}
                type="number"
                id={axis === 'width' ? inputId : undefined}
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
}: {
  value: unknown;
  onChange: (next: unknown) => void;
  pageCount?: number | null;
  inputId?: string;
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
      onChange(pages.length === total ? 'all' : formatPages([...pages].sort((a, b) => a - b).map((p) => p - 1)));
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
          value={spec}
          onChange={(event) => onChange(event.target.value)}
          className="doodle-input flex-1 font-mono text-[10px]"
          placeholder="1,3,5-7"
        />
        <button
          type="button"
          onClick={() => onChange('all')}
          className="doodle-chip doodle-chip-inactive w-auto px-2 text-[9px]"
        >
          all
        </button>
        <button
          type="button"
          onClick={() => onChange('')}
          className="doodle-chip doodle-chip-inactive w-auto px-2 text-[9px]"
        >
          none
        </button>
      </div>
      {problem && <p className="text-[10px] leading-relaxed text-danger">{problem}</p>}
      <div className="h-52">
        <PageThumbs session={session} selected={selected} onSelect={apply} columns={4} rowHeight={120} maxSide={96} />
      </div>
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
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => input.current?.click()}
        className="doodle-btn doodle-btn-secondary w-full text-[11px]"
      >
        {chosen.length > 0 ? `${chosen.length} file(s) chosen` : 'Choose file…'}
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
        <EmptyState title="No attachment yet" body="This step needs an extra file." icon="📎" />
      )}
      {chosen.map((item, index) => (
        <div
          key={`${item.name}-${index}`}
          className="flex items-center justify-between gap-2 rounded border border-cream-border bg-cream-light px-2 py-1 text-[10px]"
        >
          <span className="truncate">{item.name}</span>
          <button
            type="button"
            onClick={() => onChange(chosen.filter((_, i) => i !== index))}
            className="text-ink-muted hover:text-danger"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

// ── report view ─────────────────────────────────────────────────────────────

/** Renders a `kind: 'report'` result — metadata, comparisons, page sizes. */
export function ReportView() {
  const report = useProcessStore((s) => s.report);
  if (!report) return null;
  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto max-w-3xl space-y-4">
        {report.message && (
          <p className="rounded-doodle-md border border-accent/20 bg-accent/5 p-3 text-[12px] leading-relaxed text-ink">
            {report.message}
          </p>
        )}
        {report.sections.map((section) => (
          <section key={section.title} className="rounded-doodle-md border border-cream-border bg-cream-light">
            <h3 className="border-b border-cream-border px-4 py-2 font-display text-[13px] font-semibold text-ink">
              {section.title}
            </h3>
            {section.rows && (
              <dl className="divide-y divide-cream-border">
                {section.rows.map((row, index) => (
                  <div key={`${row.label}-${index}`} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] gap-3 px-4 py-1.5">
                    <dt className="truncate font-mono text-[10px] uppercase tracking-[0.08em] text-ink-muted">
                      {row.label}
                    </dt>
                    <dd className="break-words font-mono text-[11px] text-ink-soft">{row.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {section.text && (
              <pre className="whitespace-pre-wrap px-4 py-3 font-mono text-[11px] leading-relaxed text-ink-soft">
                {section.text}
              </pre>
            )}
            {section.images && section.images.length > 0 && (
              <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3">
                {section.images.map((image, index) => (
                  <figure key={`${image.label}-${index}`} className="space-y-1">
                    <img
                      src={URL.createObjectURL(image.blob)}
                      alt={image.label}
                      className="w-full rounded border border-cream-border"
                    />
                    <figcaption className="text-[10px] text-ink-muted">{image.label}</figcaption>
                  </figure>
                ))}
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}

/** Exposed so bespoke editors can reuse the same panel chrome. */
export type { PdfToolDefinition };
