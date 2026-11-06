/**
 * FormFillMain — the `/form-filler` pane.
 *
 * Reads the document's AcroForm with `listFormFields`, renders one real input
 * per field positioned over the pdf.js page (plus a flat field list, which is
 * the accessible path and works when a widget sits off-page), and writes the
 * answers back with `fillForm`.
 *
 * Unicode: `fillForm` encodes WinAnsi values with the standard 14 fonts and
 * sets `/NeedAppearances` for the rest so the viewer draws them. That is fine
 * on screen but not on paper, so "Fill and flatten" additionally bakes the
 * appearances through `flattenForm` (which pulls a face from `core/fonts`) and
 * then draws whatever survived with `drawTextU` from the same module — every
 * piece of text this pane puts into the file goes through `core/fonts`, never
 * through a bare Helvetica `page.drawText`.
 *
 * XFA is reported, not faked: `hasXfa` tells us the file carries an XFA packet.
 * The AcroForm mirror is what gets filled here; a packet-only (XFA-only) form
 * exposes no fields and needs Adobe Acrobat.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFileStore } from '@/stores/file-store';
import { useProcessStore } from '@/stores/process-store';
import type { PDFDocument } from '@maxwbh/pdf-lib';
import { openPDF, rgb, savePDF, PasswordRequiredError } from '@/lib/pdf/core/doc';
import { drawTextU, needsUnicodeFont } from '@/lib/pdf/core/fonts';
import {
  fillForm,
  flattenForm,
  hasXfa,
  listFormFields,
  type FormFieldInfo,
  type QuadRect,
} from '@/lib/pdf/core/forms';
import { openRender, type PdfSession } from '@/lib/pdf/core/render';

export type FormValue = string | boolean;

/** A field box in CSS pixels over the rendered canvas. */
export interface OverlayBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Map a widget rectangle (PDF user space, origin bottom-left) into a box over
 * the rendered page. `toViewport` is `PageViewport.convertToViewportPoint`, so
 * page `/Rotate` and non-zero media-box offsets are already accounted for.
 */
export function rectToOverlay(
  rect: QuadRect,
  toViewport: (x: number, y: number) => ArrayLike<number>,
): OverlayBox {
  const a = toViewport(rect.x, rect.y + rect.height);
  const b = toViewport(rect.x + rect.width, rect.y);
  const left = Math.min(Number(a[0]), Number(b[0]));
  const top = Math.min(Number(a[1]), Number(b[1]));
  return {
    left,
    top,
    width: Math.max(1, Math.abs(Number(b[0]) - Number(a[0]))),
    height: Math.max(1, Math.abs(Number(b[1]) - Number(a[1]))),
  };
}

/** Sensible starting values, straight from what the form already holds. */
export function initialValuesFor(fields: FormFieldInfo[]): Record<string, FormValue> {
  const out: Record<string, FormValue> = {};
  for (const field of fields) {
    if (field.type === 'checkbox') out[field.name] = Boolean(field.checked);
    else if (field.type === 'signature' || field.type === 'button') continue;
    else out[field.name] = field.value ?? '';
  }
  return out;
}

/** Fields that hold a value this pane can write. */
export function isFillable(field: FormFieldInfo): boolean {
  return field.type !== 'button' && field.type !== 'signature';
}

/**
 * The value bag to hand `fillForm`.
 *
 * Unknown names would be reported as failures, and an empty radio value is not
 * a selectable export value — clearing a group is `undefined`, not `''` — so an
 * untouched radio group is left alone instead of being counted as a miss.
 */
export function fillPayload(
  values: Record<string, FormValue>,
  fields: FormFieldInfo[],
): Record<string, FormValue> {
  const out: Record<string, FormValue> = {};
  for (const field of fields) {
    if (!isFillable(field)) continue;
    const value = values[field.name];
    if (value === undefined) continue;
    if (field.type === 'radio' && String(value).trim() === '') continue;
    out[field.name] = value;
  }
  return out;
}

/** Font size (pt) to draw a value with, derived from the widget height. */
export function drawSizeFor(field: FormFieldInfo): number {
  const height = field.rect.height || 12;
  return Math.max(6, Math.min(14, height * 0.62));
}

type Phase = 'empty' | 'loading' | 'ready' | 'locked' | 'error';

interface PageGeometry {
  /** 1-based. */
  page: number;
  numPages: number;
  widthPt: number;
  heightPt: number;
  rotation: number;
}

const MIN_SCALE = 0.5;
const MAX_SCALE = 3;

export default function FormFillMain(): JSX.Element {
  const file = useFileStore((s) => s.file);

  const [phase, setPhase] = useState<Phase>('empty');
  const [message, setMessage] = useState<string | null>(null);
  const [fields, setFields] = useState<FormFieldInfo[]>([]);
  const [xfa, setXfa] = useState(false);
  const [values, setValues] = useState<Record<string, FormValue>>({});
  const [geometry, setGeometry] = useState<PageGeometry | null>(null);
  const [boxes, setBoxes] = useState<Record<string, OverlayBox>>({});
  const [scale, setScale] = useState(1.4);
  const [focused, setFocused] = useState<string | null>(null);
  const [flatten, setFlatten] = useState(false);
  const [password, setPassword] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [filter, setFilter] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const sessionRef = useRef<PdfSession | null>(null);
  const canvasHost = useRef<HTMLDivElement | null>(null);
  const passwordRef = useRef(password);
  passwordRef.current = password;

  const fillable = useMemo(() => fields.filter(isFillable), [fields]);
  const unicodeNeeded = useMemo(
    () =>
      fillable.filter(
        (field) => typeof values[field.name] === 'string' && needsUnicodeFont(values[field.name] as string),
      ).length,
    [fillable, values],
  );
  const requiredMissing = useMemo(
    () =>
      fillable
        .filter((field) => field.required)
        .filter((field) => {
          const value = values[field.name];
          return field.type === 'checkbox' ? value !== true : !String(value ?? '').trim();
        }),
    [fillable, values],
  );

  // ── open the document: one pdf.js session + one pdf-lib field read ────────
  useEffect(() => {
    if (!file) {
      setPhase('empty');
      setFields([]);
      setGeometry(null);
      setBoxes({});
      return;
    }
    const token = { alive: true };
    let session: PdfSession | null = null;
    setPhase('loading');
    setMessage(null);
    setBoxes({});

    (async () => {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const opened = await openRender(bytes, { password: passwordRef.current || undefined });
        if (!token.alive) {
          await opened.destroy();
          return;
        }
        session = opened;
        sessionRef.current = opened;
        const doc = await openPDF(bytes, { password: passwordRef.current || undefined });
        const read = listFormFields(doc);
        if (!token.alive) return;
        setFields(read);
        setXfa(hasXfa(doc));
        setValues(initialValuesFor(read));
        setGeometry({
          page: 1,
          numPages: opened.numPages,
          widthPt: 0,
          heightPt: 0,
          rotation: 0,
        });
        setPhase('ready');
        setStatus(
          read.length === 0
            ? null
            : `${read.length} form field${read.length === 1 ? '' : 's'} found, in tab order.`,
        );
      } catch (err) {
        if (!token.alive) return;
        setPhase(err instanceof PasswordRequiredError ? 'locked' : 'error');
        setMessage(err instanceof Error ? err.message : 'This PDF could not be opened.');
      }
    })();

    return () => {
      token.alive = false;
      const owned = session;
      session = null;
      if (sessionRef.current === owned) sessionRef.current = null;
      if (owned) void owned.destroy();
    };
  }, [file, attempt]);

  // ── render the current page and place the widgets over it ─────────────────
  useEffect(() => {
    const session = sessionRef.current;
    const host = canvasHost.current;
    if (!session || !geometry || !host) return;
    let cancelled = false;
    let render: Awaited<ReturnType<PdfSession['renderPage']>> | null = null;

    (async () => {
      try {
        const proxy = await session.page(geometry.page);
        const viewport = proxy.getViewport({ scale });
        const pageFields = fields.filter((field) => field.page === geometry.page - 1);
        const next: Record<string, OverlayBox> = {};
        for (const field of pageFields) {
          const box = rectToOverlay(field.rect, (x, y) => viewport.convertToViewportPoint(x, y));
          next[field.name] = box;
        }
        render = await session.renderPage(geometry.page, scale);
        if (cancelled) return;
        render.canvas.className = 'block shadow-doodle-card rounded-md';
        host.replaceChildren(render.canvas);
        setBoxes(next);
        setGeometry((current) =>
          current
            ? {
                ...current,
                widthPt: viewport.width / scale,
                heightPt: viewport.height / scale,
                rotation: viewport.rotation,
              }
            : current,
        );
      } catch (err) {
        if (!cancelled) {
          useProcessStore.getState().setError(
            err instanceof Error ? err.message : 'This page could not be rendered.',
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      render?.cancel();
    };
  }, [fields, geometry?.page, geometry?.numPages, scale]);

  const setValue = useCallback((name: string, value: FormValue) => {
    setValues((current) => ({ ...current, [name]: value }));
  }, []);

  const goToField = useCallback(
    (field: FormFieldInfo) => {
      if (field.page >= 0) {
        setGeometry((current) =>
          current ? { ...current, page: Math.min(current.numPages, field.page + 1) } : current,
        );
      }
      setFocused(field.name);
      setStatus(`Focused ${field.alternateName || field.name}.`);
    },
    [],
  );

  const visibleFields = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return fillable;
    return fillable.filter((field) =>
      [field.name, field.alternateName ?? '', field.type, `page ${field.page + 1}`]
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  }, [fillable, filter]);

  const onThisPage = useMemo(
    () => (geometry ? fields.filter((f) => f.page === geometry.page - 1) : []),
    [fields, geometry],
  );

  // ── save ──────────────────────────────────────────────────────────────────
  const save = useCallback(async () => {
    if (!file) return;
    setSaving(true);
    setSaveError(null);
    const store = useProcessStore.getState();
    store.startProcessing('Fill Form', '_filled.pdf');
    store.setPercent(6, 'Applying your answers…');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const doc = await openPDF(bytes, { password: password || undefined });
      const result = fillForm(doc, fillPayload(values, fields));
      let report = `Filled ${result.filled} field${result.filled === 1 ? '' : 's'}`;
      if (result.missing.length > 0) {
        const shown = result.missing.slice(0, 4).join(', ');
        report += `; ${result.missing.length} could not be written (${shown}${
          result.missing.length > 4 ? ', …' : ''
        })`;
      }
      report += '.';

      if (flatten) {
        store.setPercent(55, 'Flattening the form…');
        const baked = await flattenForm(doc, sessionRef.current ?? undefined);
        const leftovers = listFormFields(doc).filter(isFillable);
        const drawn = await bakeRemainingText(doc, leftovers);
        report += ` Flattened ${baked.flattened + drawn.drawn} field${
          baked.flattened + drawn.drawn === 1 ? '' : 's'
        } into the page`;
        report +=
          drawn.skipped > 0
            ? `; ${drawn.skipped} stayed interactive (no value to draw, a rotated page, or a signature).`
            : '.';
      }

      store.setPercent(92, 'Saving…');
      const out = await savePDF(doc);
      const blob = new Blob([out as BlobPart], { type: 'application/pdf' });
      store.setOutput(blob, URL.createObjectURL(blob));
      store.appendLog(`FormFillMain: ${report}`);
      setStatus(report);
    } catch (err) {
      const text = err instanceof Error ? err.message : 'The filled PDF could not be saved.';
      store.setError(text);
      setSaveError(text);
    } finally {
      setSaving(false);
    }
  }, [file, fields, flatten, password, values]);

  // ── render ────────────────────────────────────────────────────────────────
  if (phase === 'empty') {
    return (
      <Pane>
        <EmptyState
          icon="🗒️"
          title="No PDF loaded"
          body="Add a fillable PDF (a tax form, an application, a contract with fields). BrowserSnip reads its AcroForm and shows one input per field."
        />
      </Pane>
    );
  }

  if (phase === 'loading') {
    return (
      <Pane>
        <EmptyState icon="⏳" title="Reading the form…" body="Counting fields and rendering the first page." />
      </Pane>
    );
  }

  if (phase === 'locked' || phase === 'error') {
    return (
      <Pane>
        <div className="mx-auto max-w-md space-y-3 p-6 text-center">
          <div className="text-3xl" aria-hidden>
            {phase === 'locked' ? '🔒' : '⚠️'}
          </div>
          <p className="font-display text-[13px] font-semibold text-ink">
            {phase === 'locked' ? 'This PDF is password protected' : 'This PDF could not be opened'}
          </p>
          <p className="text-[11px] leading-relaxed text-ink-muted">{message}</p>
          {phase === 'locked' && (
            <div className="flex gap-2">
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    setAttempt((n) => n + 1);
                  }
                }}
                placeholder="Document password"
                className="doodle-input flex-1"
                aria-label="Document password"
              />
              <button
                type="button"
                className="doodle-btn text-[11px]"
                onClick={() => setAttempt((n) => n + 1)}
              >
                Open
              </button>
            </div>
          )}
        </div>
      </Pane>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-cream-border bg-cream-light/60 px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
            {file?.name ?? 'Document'}
          </span>
          <span className="text-[10px] text-ink-muted">
            {fields.length} field{fields.length === 1 ? '' : 's'} · {fillable.length} fillable
            {requiredMissing.length > 0 ? ` · ${requiredMissing.length} required still empty` : ''}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-[10px] text-ink-soft">
            <input
              type="checkbox"
              checked={flatten}
              onChange={(event) => setFlatten(event.target.checked)}
              className="h-3 w-3 accent-[#2563EB]"
            />
            Fill and flatten
          </label>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="doodle-btn text-[11px] disabled:opacity-50"
          >
            {saving ? 'Saving…' : flatten ? 'Fill, flatten and save' : 'Fill and save'}
          </button>
        </div>
      </div>

      {xfa && <XfaNotice fieldCount={fields.length} />}
      {saveError && (
        <p className="shrink-0 border-b border-danger/25 bg-danger/[0.07] px-3 py-2 text-[11px] text-danger">
          {saveError}
        </p>
      )}

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* the page, with the widgets over it */}
        <div className="min-h-0 flex-1 overflow-auto bg-cream p-3">
          <div className="relative mx-auto w-fit" style={{ lineHeight: 0 }}>
            <div ref={canvasHost} />
            {onThisPage.map((field) => {
              const box = boxes[field.name];
              if (!box) return null;
              return (
                <div
                  key={field.name}
                  className="absolute"
                  style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
                >
                  <FieldControl
                    field={field}
                    value={values[field.name]}
                    onChange={(next) => setValue(field.name, next)}
                    variant="overlay"
                    scale={scale}
                    focused={focused === field.name}
                    onFocus={() => setFocused(field.name)}
                    inputId={`ov-${safeId(field.name)}`}
                  />
                </div>
              );
            })}
          </div>
        </div>

        {/* flat field list: the keyboard/screen-reader path */}
        <aside className="flex max-h-96 min-h-0 w-full shrink-0 flex-col border-t border-cream-border bg-cream-light/40 lg:max-h-none lg:w-80 lg:border-l lg:border-t-0">
          <div className="shrink-0 space-y-1.5 border-b border-cream-border px-2 py-2">
            <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
              All fields — tab order
            </p>
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter by name, type or page"
              className="doodle-input text-[11px]"
              aria-label="Filter form fields"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            {fields.length === 0 && (
              <p className="px-1 py-3 text-[11px] leading-relaxed text-ink-muted">
                This document has no AcroForm fields. {xfa ? 'Its form is XFA-only.' : ''} Use Create PDF
                Form to add fields you can fill here.
              </p>
            )}
            <ul className="list-none space-y-2 p-0">
              {visibleFields.map((field) => (
                <li
                  key={field.name}
                  className={`rounded-doodle-md border p-2 ${
                    focused === field.name ? 'border-accent bg-white' : 'border-cream-border bg-white/70'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <label
                      htmlFor={`list-${safeId(field.name)}`}
                      className="min-w-0 flex-1 cursor-pointer text-[11px] font-medium leading-snug text-ink"
                      title={field.name}
                    >
                      {field.alternateName || field.name}
                      {field.required ? <span className="text-danger"> *</span> : null}
                    </label>
                    <button
                      type="button"
                      onClick={() => goToField(field)}
                      className="doodle-chip text-[9px] doodle-chip-inactive"
                      title={`Show on page ${field.page + 1}`}
                      disabled={field.page < 0}
                    >
                      {field.page < 0 ? 'no widget' : `p${field.page + 1}`}
                    </button>
                  </div>
                  <p className="mt-0.5 truncate font-mono text-[9px] text-ink-muted" title={field.name}>
                    {field.type}
                    {field.multiline ? ' · multiline' : ''}
                    {field.maxLen ? ` · max ${field.maxLen}` : ''}
                    {field.readOnly ? ' · read-only' : ''}
                  </p>
                  <div className="mt-1.5">
                    <FieldControl
                      field={field}
                      value={values[field.name]}
                      onChange={(next) => setValue(field.name, next)}
                      variant="list"
                      scale={1}
                      focused={focused === field.name}
                      onFocus={() => setFocused(field.name)}
                      inputId={`list-${safeId(field.name)}`}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>

      {/* page controls + live status */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-cream-border bg-cream-light/60 px-3 py-1.5">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="doodle-chip text-[10px] doodle-chip-inactive disabled:opacity-30"
            disabled={!geometry || geometry.page <= 1}
            onClick={() => setGeometry((c) => (c ? { ...c, page: Math.max(1, c.page - 1) } : c))}
          >
            ◂ Prev
          </button>
          <input
            type="number"
            min={1}
            max={geometry?.numPages ?? 1}
            value={geometry?.page ?? 1}
            onChange={(event) => {
              const next = Math.max(1, Math.min(geometry?.numPages ?? 1, event.target.valueAsNumber || 1));
              setGeometry((c) => (c ? { ...c, page: next } : c));
            }}
            className="doodle-input w-16 text-center font-mono text-[10px]"
            aria-label="Page number"
          />
          <span className="text-[10px] tabular-nums text-ink-muted">/ {geometry?.numPages ?? 0}</span>
          <button
            type="button"
            className="doodle-chip text-[10px] doodle-chip-inactive disabled:opacity-30"
            disabled={!geometry || geometry.page >= geometry.numPages}
            onClick={() =>
              setGeometry((c) => (c ? { ...c, page: Math.min(c.numPages, c.page + 1) } : c))
            }
          >
            Next ▸
          </button>
          <button
            type="button"
            className="doodle-chip text-[10px] doodle-chip-inactive"
            onClick={() => setScale((s) => Math.max(MIN_SCALE, Number((s - 0.2).toFixed(2))))}
          >
            −
          </button>
          <span className="text-[10px] tabular-nums text-ink-muted">{Math.round(scale * 100)}%</span>
          <button
            type="button"
            className="doodle-chip text-[10px] doodle-chip-inactive"
            onClick={() => setScale((s) => Math.min(MAX_SCALE, Number((s + 0.2).toFixed(2))))}
          >
            +
          </button>
        </div>
        <p className="min-w-0 flex-1 truncate text-[10px] text-ink-muted" aria-live="polite">
          {status ??
            `${geometry?.widthPt ? `${Math.round(geometry.widthPt)} × ${Math.round(geometry.heightPt)} pt` : ''}`}
        </p>
      </div>

      {unicodeNeeded > 0 && (
        <p className="shrink-0 border-t border-warn/25 bg-warn/5 px-3 py-1.5 text-[10px] leading-relaxed text-warn">
          {unicodeNeeded} value{unicodeNeeded === 1 ? '' : 's'} need a Unicode font. Viewers will draw them
          correctly; tick <strong>Fill and flatten</strong> to embed them in the page so they also survive
          printing and merging.
        </p>
      )}
    </div>
  );
}

/**
 * Draw the values that `flattenForm` could not bake and remove those widgets,
 * so a flattened file really is static. Text goes through `core/fonts`, which is
 * what keeps CJK/Cyrillic/emoji answers renderable.
 */
async function bakeRemainingText(
  doc: PDFDocument,
  leftovers: FormFieldInfo[],
): Promise<{ drawn: number; skipped: number }> {
  const pages = doc.getPages();
  const form = doc.getForm();
  let drawn = 0;
  let skipped = 0;

  for (const field of leftovers) {
    const page = pages[field.page];
    const text = typeof field.value === 'string' ? field.value : '';
    const rotated = page ? page.getRotation().angle % 360 !== 0 : true;
    const drawable = field.type === 'text' || field.type === 'dropdown' || field.type === 'list';
    if (!page || !text || rotated || !drawable) {
      skipped += 1;
      continue;
    }
    try {
      await drawTextU(page, {
        text,
        x: field.rect.x + 1,
        y: field.rect.y + Math.max(1, field.rect.height * 0.2),
        size: drawSizeFor(field),
        color: rgb(0, 0, 0),
        maxWidth: Math.max(1, field.rect.width - 2),
        lineHeight: drawSizeFor(field) * 1.15,
      });
      // `removeField` wants the live object; it drops the widget annotation and
      // the `/AcroForm /Fields` entry, which is what makes the page static.
      const live = form.getFieldMaybe(field.name);
      if (live) form.removeField(live);
      drawn += 1;
    } catch {
      // The face could not be fetched (offline CJK, for instance): leave the
      // field interactive rather than dropping the answer.
      skipped += 1;
    }
  }
  return { drawn, skipped };
}

// ── one field, in either the overlay or the flat list ───────────────────────

interface FieldControlProps {
  field: FormFieldInfo;
  value: FormValue | undefined;
  onChange: (value: FormValue) => void;
  variant: 'overlay' | 'list';
  scale: number;
  focused: boolean;
  onFocus: () => void;
  inputId: string;
}

function FieldControl(props: FieldControlProps): JSX.Element {
  const { field, inputId, onChange, onFocus, variant } = props;
  const overlay = variant === 'overlay';
  const name = field.alternateName || field.name;
  const base = overlay
    ? 'block h-full w-full rounded-none border bg-white/85 px-0.5 font-body text-ink outline-none focus:bg-white focus:ring-1 focus:ring-accent'
    : 'doodle-input w-full text-[11px]';
  const border = field.required ? 'border-danger/50' : 'border-ink-muted/40';
  const text = String(props.value ?? '');
  const fontSize = overlay
    ? `${Math.max(8, Math.min(16, (field.rect.height || 12) * 0.66 * Math.max(0.5, Math.min(2, props.scale))))}px`
    : undefined;

  if (field.readOnly) {
    return (
      <span
        id={inputId}
        title={`${name} is read-only`}
        className={`block w-full overflow-hidden whitespace-nowrap text-ellipsis text-[10px] text-ink-muted ${
          overlay ? 'px-0.5' : ''
        }`}
        style={fontSize ? { fontSize } : undefined}
      >
        {text}
      </span>
    );
  }

  switch (field.type) {
    case 'text':
      if (field.multiline) {
        return (
          <textarea
            id={inputId}
            aria-label={name}
            value={text}
            onFocus={onFocus}
            onChange={(event) => onChange(event.target.value)}
            maxLength={field.maxLen}
            className={`${base} ${border} resize-none leading-tight`}
            style={fontSize ? { fontSize } : undefined}
          />
        );
      }
      return (
        <input
          id={inputId}
          type="text"
          aria-label={name}
          value={text}
          onFocus={onFocus}
          onChange={(event) => onChange(event.target.value)}
          maxLength={field.maxLen}
          className={`${base} ${border}`}
          style={fontSize ? { fontSize } : undefined}
        />
      );
    case 'checkbox':
      return (
        <label className={`flex items-center gap-1 ${overlay ? 'h-full w-full' : 'text-[11px] text-ink-soft'}`}>
          <input
            id={inputId}
            type="checkbox"
            aria-label={name}
            checked={props.value === true || props.value === 'true'}
            onFocus={onFocus}
            onChange={(event) => onChange(event.target.checked)}
            className="h-3.5 w-3.5 accent-[#2563EB]"
          />
          {!overlay && <span className="truncate">{name}</span>}
        </label>
      );
    case 'radio': {
      const options = field.options ?? [];
      if (options.length === 0) {
        return (
          <input
            id={inputId}
            type="text"
            aria-label={`${name} (export value)`}
            value={text}
            onFocus={onFocus}
            onChange={(event) => onChange(event.target.value)}
            className={`${base} ${border}`}
            placeholder={overlay ? '' : 'export value'}
          />
        );
      }
      return (
        <div
          className={`flex ${overlay ? 'h-full w-full flex-col justify-around' : 'flex-col gap-0.5'}`}
          role="radiogroup"
          aria-label={name}
        >
          {options.map((option) => (
            <label
              key={option}
              className={`flex min-w-0 items-center gap-1 ${overlay ? '' : 'text-[11px] text-ink-soft'}`}
              style={fontSize ? { fontSize } : undefined}
            >
              <input
                id={overlay ? `${inputId}-${safeId(option)}` : inputId}
                type="radio"
                name={`radio-${field.name}`}
                value={option}
                checked={text === option}
                onFocus={onFocus}
                onChange={() => onChange(option)}
                className="h-3 w-3 shrink-0 accent-[#2563EB]"
              />
              <span className="truncate" title={option}>
                {option}
              </span>
            </label>
          ))}
        </div>
      );
    }
    case 'dropdown':
    case 'list':
      return (
        <select
          id={inputId}
          aria-label={name}
          value={text}
          onFocus={onFocus}
          onChange={(event) => onChange(event.target.value)}
          className={`${base} ${border}`}
          style={fontSize ? { fontSize } : undefined}
        >
          <option value="">—</option>
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
          {text && !(field.options ?? []).includes(text) && <option value={text}>{text}</option>}
        </select>
      );
    case 'signature':
    default:
      return (
        <span
          id={inputId}
          className={`flex h-full w-full items-center rounded border border-dashed ${border} bg-white/60 px-1 text-[9px] text-ink-muted`}
          title={`${name} is a ${field.type} field — sign it in a viewer that supports signatures`}
        >
          {field.type}
        </span>
      );
  }
}

// ── small pieces ────────────────────────────────────────────────────────────

function Pane({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="flex h-full min-h-0 flex-col items-center justify-center">{children}</div>;
}

function EmptyState({ icon, title, body }: { icon: string; title: string; body: string }): JSX.Element {
  return (
    <div className="max-w-sm px-6 text-center">
      <div className="mb-3 text-4xl" aria-hidden>
        {icon}
      </div>
      <p className="font-display text-[13px] font-semibold text-ink">{title}</p>
      <p className="mt-1.5 text-[11px] leading-relaxed text-ink-muted">{body}</p>
    </div>
  );
}

function XfaNotice({ fieldCount }: { fieldCount: number }): JSX.Element {
  return (
    <div className="shrink-0 border-b border-warn/25 bg-warn/5 px-3 py-2 text-[10px] leading-relaxed text-warn">
      <strong>This document carries an XFA form packet.</strong> What works here: the AcroForm mirror below
      ({fieldCount} field{fieldCount === 1 ? '' : 's'}), the values written into it, and flattening, which
      removes the packet so the result opens identically everywhere. What does not: the pixel-perfect XFA
      layout, XFA calculations and validation — those need Adobe Acrobat, or Chrome&apos;s built-in XFA
      viewer in older releases. If the field list is empty, the form is XFA-only and cannot be filled in a
      browser without Acrobat.
    </div>
  );
}

function safeId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
}

export { FormFillMain };
