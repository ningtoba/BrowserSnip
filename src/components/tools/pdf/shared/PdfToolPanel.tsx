/**
 * Shared PDF tool UI kit.
 *
 * Renders a `PdfToolDefinition`'s field list into the sidebar panel, so a tool
 * that only needs controls writes no component at all. Styling reuses the app's
 * existing vocabulary (`doodle-*`, `cream`, `ink`, category accents) rather
 * than inventing a second look.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { fadeUp, staggerParent, tapDown } from '@/lib/motion';
import { usePdfTool, type UsePdfTool } from '@/hooks/usePdfTool';
import { useFileStore } from '@/stores/file-store';
import { useProcessStore } from '@/stores/process-store';
import { openRender, thumbnails, type PdfSession } from '@/lib/pdf/core/render';
import { formatPages, tryResolvePages } from '@/lib/pdf/core/pages';
import { engineReady, enginePurpose } from '@/lib/pdf/core/engine-ops';
import type { EngineId } from '@/lib/pdf/engines/provider';
import {
  type FileValue,
  type PdfToolDefinition,
  type ToolField,
  type ToolValues,
} from '@/lib/pdf/tools/types';

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
  const api = usePdfTool(toolId);
  const panel = (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={staggerParent}
      className="doodle-section space-y-3"
    >
      {before}
      <EngineNotice ids={api.tool?.engines ?? []} />
      <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
        {api.tool?.name ?? toolId}
      </p>
      {api.needsPassword && (
        <PasswordGate api={api} />
      )}
      <LockedNotice visible={api.locked} />
      {api.tool?.fields?.map((field) => (
        <FieldControl
          key={field.key}
          field={field}
          values={api.values}
          onChange={api.setValue}
        />
      ))}
      {api.tool?.notes?.map((note) => (
        <p key={note} className="text-[10px] leading-relaxed text-ink-muted">
          {note}
        </p>
      ))}
      <RunControls api={api} onDone={onDone} />
    </motion.div>
  );

  if (hidden) {
    return <div className="hidden" aria-hidden>{panel}</div>;
  }
  return panel;
}

function RunControls({ api, onDone }: { api: UsePdfTool; onDone?: () => void }) {
  return (
    <motion.div variants={fadeUp} className="flex items-center gap-2 pt-1">
      <motion.button
        whileTap={tapDown}
        id="tool-process-btn"
        disabled={api.isRunning}
        onClick={async () => {
          const outcome = await api.run();
          if (outcome) onDone?.();
        }}
        className="doodle-btn flex-1 disabled:opacity-50"
      >
        {api.isRunning ? 'Working…' : 'Run'}
      </motion.button>
      {api.isRunning && (
        <button onClick={api.cancel} className="doodle-btn doodle-btn-danger text-[11px]">
          Cancel
        </button>
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
}

interface ControlProps {
  field: ToolField;
  value: unknown;
  /** Already bound to this field's key. */
  onChange: (next: unknown) => void;
}

export function FieldControl({ field, values, onChange }: FieldControlProps) {
  if (field.when && !field.when(values)) return null;
  const value = values[field.key] ?? field.default ?? null;
  const set = (next: unknown) => onChange(field.key, next);

  return (
    <motion.div variants={fadeUp} className={field.half ? 'space-y-1' : 'space-y-1'}>
      <Label field={field} value={value} />
      <Control field={field} value={value} onChange={set} />
      {field.help && <p className="text-[10px] leading-relaxed text-ink-muted">{field.help}</p>}
    </motion.div>
  );
}

function Label({ field, value }: { field: ToolField; value: unknown }) {
  if (field.type === 'toggle') return null;
  const showValue = (field.type === 'slider' || field.type === 'number') && typeof value === 'number';
  return (
    <span className="flex items-baseline justify-between gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
      <span>{field.label}</span>
      {showValue && (
        <span className="font-display text-[11px] normal-case tracking-normal text-ink-soft tabular-nums">
          {value}
          {field.unit ?? ''}
        </span>
      )}
    </span>
  );
}

function Control({ field, value, onChange }: ControlProps) {
  switch (field.type) {
    case 'toggle':
      return (
        <label className="flex cursor-pointer items-center justify-between gap-2 py-0.5">
          <span className="text-[11px] text-ink-soft">{field.label}</span>
          <input
            type="checkbox"
            checked={typeof value === 'boolean' ? value : Boolean(field.default)}
            onChange={(event) => onChange(event.target.checked)}
            className="h-3 w-3 accent-[#2563EB]"
          />
        </label>
      );
    case 'textarea':
      return (
        <textarea
          value={String(value ?? '')}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder}
          rows={4}
          className="doodle-input resize-y font-mono text-[11px] leading-relaxed"
        />
      );
    case 'number':
      return (
        <input
          type="number"
          value={typeof value === 'number' ? value : Number(value ?? 0)}
          min={field.min}
          max={field.max}
          step={field.step ?? 1}
          onChange={(event) => onChange(event.target.valueAsNumber)}
          className="doodle-input"
        />
      );
    case 'slider':
      return (
        <input
          type="range"
          min={field.min ?? 0}
          max={field.max ?? 1}
          step={field.step ?? 0.01}
          value={typeof value === 'number' ? value : Number(field.default ?? 0)}
          onChange={(event) => onChange(event.target.valueAsNumber)}
          className="w-full accent-[#2563EB]"
        />
      );
    case 'color':
      return (
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={/^#[0-9a-f]{6}$/i.test(String(value ?? '')) ? String(value) : '#000000'}
            onChange={(event) => onChange(event.target.value)}
            className="h-7 w-10 cursor-pointer rounded border border-cream-border bg-white"
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
                className="h-3 w-3 accent-[#2563EB]"
              />
              {option.label}
            </label>
          ))}
        </div>
      );
    }
    case 'pages':
      return <PagePicker field={field} value={value} onChange={onChange} />;
    case 'password':
      return (
        <input
          type="password"
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
  field,
  value,
  onChange,
}: {
  field: ToolField;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const file = useFileStore((s) => s.file);
  const [session, setSession] = useState<PdfSession | null>(null);
  const [urls, setUrls] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const spec = typeof value === 'string' ? value : 'all';

  useEffect(() => {
    if (!file) return;
    let disposed = false;
    let local: PdfSession | null = null;
    setUrls([]);
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
        const strip = await thumbnails(opened, {
          maxSide: 96,
          onPage: (page, url) => {
            if (disposed) return;
            setUrls((current) => {
              const next = [...current];
              next[page - 1] = url;
              return next;
            });
          },
        });
        if (!disposed) setUrls(strip);
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

  const selected = useMemo(() => {
    if (!session) return new Set<number>();
    const resolved = tryResolvePages(spec, session.numPages);
    return new Set(resolved ?? []);
  }, [session, spec]);

  const toggle = useCallback(
    (index: number) => {
      if (!session) return;
      const next = new Set(selected);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      const ordered = [...next].sort((a, b) => a - b);
      onChange(ordered.length === session.numPages ? 'all' : formatPages(ordered));
    },
    [onChange, selected, session],
  );

  if (error) return <p className="text-[10px] text-danger">{error}</p>;
  if (!session) {
    return (
      <input
        value={spec}
        onChange={(event) => onChange(event.target.value)}
        placeholder="1,3,5-7"
        className="doodle-input"
      />
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1">
        <input
          value={spec}
          onChange={(event) => onChange(event.target.value)}
          className="doodle-input flex-1 font-mono text-[10px]"
          aria-label="Page selection"
        />
        <button
          type="button"
          onClick={() => onChange('all')}
          className="doodle-chip doodle-chip-inactive text-[9px]"
        >
          all
        </button>
        <button
          type="button"
          onClick={() => onChange('')}
          className="doodle-chip doodle-chip-inactive text-[9px]"
        >
          none
        </button>
      </div>
      <div className="grid max-h-52 grid-cols-4 gap-1 overflow-y-auto pr-1 sm:grid-cols-5">
        {Array.from({ length: session.numPages }, (_, index) => (
          <button
            key={index}
            type="button"
            onClick={() => toggle(index)}
            title={`Page ${index + 1}`}
            className={`group relative overflow-hidden rounded border transition-colors ${
              selected.has(index)
                ? 'border-accent ring-1 ring-accent/40'
                : 'border-cream-border hover:border-ink-muted'
            }`}
          >
            {urls[index] ? (
              <img src={urls[index]} alt="" className="h-full w-full object-contain" />
            ) : (
              <span className="flex aspect-[3/4] items-center justify-center bg-cream-soft text-[9px] text-ink-muted">
                {index + 1}
              </span>
            )}
            <span
              className={`absolute bottom-0 right-0 px-1 text-[8px] font-semibold tabular-nums ${
                selected.has(index) ? 'bg-accent text-white' : 'bg-white/80 text-ink-muted'
              }`}
            >
              {index + 1}
            </span>
          </button>
        ))}
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
      {chosen.map((item, index) => (
        <div
          key={`${item.name}-${index}`}
          className="flex items-center justify-between gap-2 rounded border border-cream-border bg-white px-2 py-1 text-[10px]"
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
          <section key={section.title} className="rounded-doodle-md border border-cream-border bg-white">
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
