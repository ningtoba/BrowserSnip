/**
 * FormCreatorMain — the `/form-creator` pane.
 *
 * Drag rectangles onto a rendered page to design an AcroForm: one draft field
 * per rectangle, with a name, tooltip, required/read-only flags, font size,
 * multiline + max length for text, and choice options for dropdown / list /
 * radio. The list on the right *is* the tab order — fields are created in that
 * order and `createFormField` appends to `/AcroForm /Fields`, which is what
 * viewers tab through.
 *
 * Geometry rule: a draft's `rect` is stored in PDF user space (points, origin
 * bottom-left) because that is what the engine needs, but every interaction
 * happens in screen space and is mapped back through `PageViewport`, so a page
 * with `/Rotate 90` drags exactly like it looks.
 *
 * If the document already has an AcroForm the pane says so and offers to keep
 * those fields (new ones are appended after them) or replace the whole form.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFileStore } from '@/stores/file-store';
import { useProcessStore } from '@/stores/process-store';
import { openPDF, savePDF, PasswordRequiredError } from '@/lib/pdf/core/doc';
import { createFormField, hasXfa, listFormFields, type FormFieldInfo, type QuadRect } from '@/lib/pdf/core/forms';
import { openRender, type PdfSession } from '@/lib/pdf/core/render';
import { rectToOverlay, type OverlayBox } from './FormFillMain';

export type DraftType = 'text' | 'checkbox' | 'radio' | 'dropdown' | 'list';

export interface DraftField {
  id: string;
  /** 0-based page index. */
  page: number;
  type: DraftType;
  /** PDF user space, origin bottom-left. */
  rect: QuadRect;
  name: string;
  /** `/TU` — the tooltip / alternate name readers show. */
  label: string;
  required: boolean;
  readOnly: boolean;
  multiline: boolean;
  fontSize: number;
  maxLength: number;
  /** One option per line for dropdown / list / radio. */
  options: string[];
  value: string;
}

export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

const FIELD_TYPES: { type: DraftType; label: string; icon: string; hint: string }[] = [
  { type: 'text', label: 'Text', icon: 'T', hint: 'One line, or several when multiline is on' },
  { type: 'checkbox', label: 'Checkbox', icon: '☑', hint: 'A single tick box' },
  { type: 'radio', label: 'Radio group', icon: '◉', hint: 'One option per row — add the choices on the right' },
  { type: 'dropdown', label: 'Dropdown', icon: '▾', hint: 'A collapsed choice list' },
  { type: 'list', label: 'List box', icon: '☰', hint: 'An always-visible choice list' },
];

/** Heights used when a single click drops a field instead of a drag. */
const DEFAULT_HEIGHT_PT: Record<DraftType, number> = {
  text: 16,
  checkbox: 12,
  radio: 14,
  dropdown: 16,
  list: 72,
};

const HANDLES: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

// ── pure geometry (screen space) ────────────────────────────────────────────

export interface Point {
  x: number;
  y: number;
}

/** Box from two dragged corners: never inverted, never smaller than `min`. */
export function boxFromCorners(a: Point, b: Point, min = 2): OverlayBox {
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  return {
    left,
    top,
    width: Math.max(min, Math.abs(b.x - a.x)),
    height: Math.max(min, Math.abs(b.y - a.y)),
  };
}

/** Apply a screen-space drag to one handle of `box`. */
export function resizeBox(
  box: OverlayBox,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  min = 10,
): OverlayBox {
  let { left, top, width, height } = box;
  if (handle.includes('w')) {
    const shift = Math.min(dx, width - min);
    left += shift;
    width -= shift;
  }
  if (handle.includes('e')) width = Math.max(min, width + dx);
  if (handle.includes('n')) {
    const shift = Math.min(dy, height - min);
    top += shift;
    height -= shift;
  }
  if (handle.includes('s')) height = Math.max(min, height + dy);
  return { left, top, width, height };
}

export function translateBox(box: OverlayBox, dx: number, dy: number): OverlayBox {
  return { ...box, left: box.left + dx, top: box.top + dy };
}

/** Keep a box inside the rendered page, preserving its size where possible. */
export function clampBox(box: OverlayBox, pageWidth: number, pageHeight: number): OverlayBox {
  const width = Math.min(box.width, pageWidth);
  const height = Math.min(box.height, pageHeight);
  return {
    left: Math.max(0, Math.min(Math.max(0, pageWidth - width), box.left)),
    top: Math.max(0, Math.min(Math.max(0, pageHeight - height), box.top)),
    width,
    height,
  };
}

/** A checkbox widget should be square: shrink whichever edge is longer. */
export function squareBox(box: OverlayBox): OverlayBox {
  const side = Math.min(box.width, box.height);
  return { left: box.left, top: box.top, width: side, height: side };
}

/** A unique, PDF-safe field name: `Text2`, `Check1`, `Choice3`, … */
export function nextFieldName(kind: DraftType, taken: string[]): string {
  const stem = kind === 'checkbox' ? 'Check' : kind === 'radio' ? 'Group' : kind === 'text' ? 'Text' : 'Choice';
  const used = new Set(taken.map((name) => name.toLowerCase()));
  for (let n = 1; n < 10_000; n += 1) {
    const candidate = `${stem}${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${stem}-${Date.now()}`;
}

export function moveInTabOrder(fields: DraftField[], index: number, delta: number): DraftField[] {
  const to = index + delta;
  if (index < 0 || to < 0 || index >= fields.length || to >= fields.length) return fields;
  const next = [...fields];
  const [item] = next.splice(index, 1);
  next.splice(to, 0, item);
  return next;
}

/** Split the options textarea: one choice per line, blanks dropped. */
export function parseOptions(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export interface DraftProblem {
  id: string;
  message: string;
}

/**
 * Everything that would make `createFormField` throw, or produce a field nobody
 * can use: a missing or duplicate name (pdf-lib refuses two fields with the same
 * name), a near-zero rect, or a choice field with nothing to choose.
 */
export function validateDrafts(drafts: DraftField[], existingNames: string[]): DraftProblem[] {
  const problems: DraftProblem[] = [];
  const seen = new Set(existingNames.map((name) => name.toLowerCase()));
  for (const draft of drafts) {
    const name = draft.name.trim();
    if (!name) {
      problems.push({ id: draft.id, message: 'Give every field a name.' });
    } else if (seen.has(name.toLowerCase())) {
      problems.push({
        id: draft.id,
        message: `"${name}" is used more than once — field names must be unique.`,
      });
    } else {
      seen.add(name.toLowerCase());
    }
    if (draft.rect.width < 2 || draft.rect.height < 2) {
      problems.push({ id: draft.id, message: `${name || 'A field'} is too small to click in a real PDF.` });
    }
    const needsOptions = draft.type === 'dropdown' || draft.type === 'list' || draft.type === 'radio';
    if (needsOptions && draft.options.length === 0) {
      problems.push({ id: draft.id, message: `${name || 'A choice field'} needs at least one option.` });
    }
  }
  return problems;
}

/** The `createFormField` argument for one draft. */
export function toCreateSpec(draft: DraftField) {
  const name = draft.name.trim();
  return {
    type: draft.type,
    rect: draft.rect,
    name,
    label: draft.label.trim() || undefined,
    options: draft.options.length > 0 ? [...draft.options] : undefined,
    value: draft.value || undefined,
    fontSize: draft.type === 'checkbox' || draft.type === 'radio' ? undefined : draft.fontSize,
    multiline: draft.multiline,
    required: draft.required,
    readOnly: draft.readOnly,
    maxLength: draft.maxLength > 0 ? draft.maxLength : undefined,
  };
}

export interface ViewportView {
  width: number;
  height: number;
  /** `PageViewport.convertToPdfPoint` for the page on screen. */
  toPdf: (x: number, y: number) => ArrayLike<number>;
}

/** Screen box → PDF rect via two opposite corners; rotations stay axis-aligned. */
export function boxToRect(box: OverlayBox, view: Pick<ViewportView, 'toPdf'>): QuadRect {
  const a = view.toPdf(box.left, box.top);
  const b = view.toPdf(box.left + box.width, box.top + box.height);
  const xs = [Number(a[0]), Number(b[0])];
  const ys = [Number(a[1]), Number(b[1])];
  return {
    x: Math.min(xs[0], xs[1]),
    y: Math.min(ys[0], ys[1]),
    width: Math.max(1, Math.abs(xs[1] - xs[0])),
    height: Math.max(1, Math.abs(ys[1] - ys[0])),
  };
}

// ── pane ────────────────────────────────────────────────────────────────────

type Phase = 'empty' | 'loading' | 'ready' | 'locked' | 'error';

interface PageView {
  /** 1-based, for the controls. */
  page: number;
  numPages: number;
  widthPt: number;
  heightPt: number;
  rotation: number;
}

interface Gesture {
  kind: 'draw' | 'move' | 'resize';
  handle?: ResizeHandle;
  id?: string;
  /** The field type being drawn, captured so pointer-up needs no extra state. */
  type?: DraftType;
  start: Point;
  orig: OverlayBox;
}

let idCounter = 0;

function newId(): string {
  idCounter += 1;
  return `fld-${Date.now().toString(36)}-${idCounter}`;
}

export default function FormCreatorMain(): JSX.Element {
  const file = useFileStore((s) => s.file);

  const [phase, setPhase] = useState<Phase>('empty');
  const [message, setMessage] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState<PageView | null>(null);
  const [existing, setExisting] = useState<FormFieldInfo[]>([]);
  const [xfa, setXfa] = useState(false);
  const [drafts, setDrafts] = useState<DraftField[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tool, setTool] = useState<DraftType | 'select'>('text');
  const [scale, setScale] = useState(1.3);
  const [boxes, setBoxes] = useState<Record<string, OverlayBox>>({});
  const [drawBox, setDrawBox] = useState<OverlayBox | null>(null);
  const [conflict, setConflict] = useState<'keep' | 'replace'>('keep');
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const sessionRef = useRef<PdfSession | null>(null);
  const viewRef = useRef<ViewportView | null>(null);
  const canvasHost = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const passwordRef = useRef(password);
  passwordRef.current = password;
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const boxesRef = useRef(boxes);
  boxesRef.current = boxes;
  const drawBoxRef = useRef(drawBox);
  drawBoxRef.current = drawBox;
  const pageRef = useRef(page);
  pageRef.current = page;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  const problems = useMemo(
    () => validateDrafts(drafts, conflict === 'replace' ? [] : existing.map((field) => field.name)),
    [conflict, drafts, existing],
  );
  const selectedDraft = useMemo(() => drafts.find((draft) => draft.id === selected) ?? null, [drafts, selected]);
  const onPage = useMemo(
    () => drafts.filter((draft) => draft.page === (page?.page ?? 1) - 1),
    [drafts, page],
  );

  /** Recompute the on-screen box of the given drafts. */
  const recomputeBoxes = useCallback((list: DraftField[]) => {
    const view = viewRef.current;
    if (!view) return;
    setBoxes((current) => {
      const next = { ...current };
      for (const draft of list) {
        next[draft.id] = clampBox(
          rectToOverlay(draft.rect, (x, y) => view.toPdf(x, y)),
          view.width,
          view.height,
        );
      }
      return next;
    });
  }, []);

  // ── open the document: a pdf.js session to draw on, pdf-lib to read fields ──
  useEffect(() => {
    if (!file) {
      setPhase('empty');
      setPage(null);
      setExisting([]);
      setDrafts([]);
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
        const fields = listFormFields(doc);
        if (!token.alive) return;
        setExisting(fields);
        setXfa(hasXfa(doc));
        setPage({ page: 1, numPages: opened.numPages, widthPt: 0, heightPt: 0, rotation: 0 });
        setPhase('ready');
        setStatus(
          fields.length > 0
            ? `This document already has ${fields.length} form field${
                fields.length === 1 ? '' : 's'
              }. Choose keep or replace, then add your own.`
            : 'No form yet — drag a rectangle on the page to add the first field.',
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

  // ── render the page and map the design overlay onto it ────────────────────
  useEffect(() => {
    const session = sessionRef.current;
    const host = canvasHost.current;
    if (!session || !page || !host) return;
    let cancelled = false;
    let render: Awaited<ReturnType<PdfSession['renderPage']>> | null = null;

    (async () => {
      try {
        const proxy = await session.page(page.page);
        const viewport = proxy.getViewport({ scale });
        viewRef.current = {
          width: viewport.width,
          height: viewport.height,
          toPdf: (x, y) => viewport.convertToPdfPoint(x, y),
        };
        render = await session.renderPage(page.page, scale);
        if (cancelled) return;
        render.canvas.className = 'block rounded-md shadow-doodle-card';
        host.replaceChildren(render.canvas);
        setPage((current) =>
          current
            ? {
                ...current,
                widthPt: viewport.width / scale,
                heightPt: viewport.height / scale,
                rotation: viewport.rotation,
              }
            : current,
        );
        recomputeBoxes(draftsRef.current.filter((draft) => draft.page === page.page - 1));
      } catch (err) {
        if (!cancelled) {
          setMessage(err instanceof Error ? err.message : 'This page could not be rendered.');
        }
      }
    })();

    return () => {
      cancelled = true;
      render?.cancel();
    };
    // `page.widthPt/heightPt/rotation` are written *by* this effect; depending on
    // the whole object would re-render the page forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page?.page, page?.numPages, scale, recomputeBoxes]);

  // Keep boxes in step with rect edits (drag, nudge, page change).
  useEffect(() => {
    if (!page) return;
    recomputeBoxes(drafts.filter((draft) => draft.page === page.page - 1));
  }, [drafts, page, recomputeBoxes]);

  // Esc drops back to the select tool.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      setTool('select');
      setSelected(null);
      gesture.current = null;
      setDrawBox(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // ── pointer interaction ───────────────────────────────────────────────────
  const localPoint = useCallback((event: React.PointerEvent): Point => {
    const host = overlayRef.current;
    if (!host) return { x: 0, y: 0 };
    const rect = host.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }, []);

  const capture = (event: React.PointerEvent) => {
    try {
      overlayRef.current?.setPointerCapture(event.pointerId);
    } catch {
      /* pointer capture is unsupported here; the gesture still works via bubbling */
    }
  };

  const commitField = useCallback(
    (raw: OverlayBox, type: DraftType) => {
      const view = viewRef.current;
      const current = pageRef.current;
      if (!view || !current) return;
      const box = type === 'checkbox' ? squareBox(raw) : raw;
      const draft: DraftField = {
        id: newId(),
        page: current.page - 1,
        type,
        rect: boxToRect(box, view),
        name: nextFieldName(type, [
          ...draftsRef.current.map((draft) => draft.name),
          ...(conflict === 'keep' ? existing.map((field) => field.name) : []),
        ]),
        label: '',
        required: false,
        readOnly: false,
        multiline: false,
        fontSize: 12,
        maxLength: 0,
        options: type === 'radio' || type === 'dropdown' || type === 'list' ? ['Option 1', 'Option 2'] : [],
        value: '',
      };
      setDrafts((list) => [...list, draft]);
      setSelected(draft.id);
      setTool('select');
      setStatus(
        `Added a ${type} field named "${draft.name}" on page ${current.page} — ${Math.round(
          draft.rect.width,
        )} × ${Math.round(draft.rect.height)} pt. Pick a type again to place another.`,
      );
    },
    [conflict, existing],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const active = gesture.current;
      const view = viewRef.current;
      if (!active || !view) return;
      const now = localPoint(event);
      const dx = now.x - active.start.x;
      const dy = now.y - active.start.y;

      if (active.kind === 'draw') {
        setDrawBox(clampBox(boxFromCorners(active.start, now), view.width, view.height));
        return;
      }
      const id = active.id;
      if (!id) return;
      const moved = clampBox(
        active.kind === 'move'
          ? translateBox(active.orig, dx, dy)
          : resizeBox(active.orig, active.handle ?? 'se', dx, dy, 8),
        view.width,
        view.height,
      );
      const rect = boxToRect(moved, view);
      setBoxes((current) => ({ ...current, [id]: moved }));
      setDrafts((list) => list.map((draft) => (draft.id === id ? { ...draft, rect } : draft)));
    },
    [localPoint],
  );

  const onPointerUp = useCallback(() => {
    const active = gesture.current;
    gesture.current = null;
    if (!active) return;
    if (active.kind !== 'draw') {
      const view = viewRef.current;
      const box = active.id ? boxesRef.current[active.id] : null;
      if (view && box) {
        const rect = boxToRect(box, view);
        setStatus(
          `Field moved to x ${Math.round(rect.x)}, y ${Math.round(rect.y)} — ${Math.round(
            rect.width,
          )} × ${Math.round(rect.height)} pt.`,
        );
      }
      return;
    }
    const box = drawBoxRef.current;
    setDrawBox(null);
    const type = active.type ?? 'text';
    const view = viewRef.current;
    if (!view) return;
    if (!box || box.width < 6 || box.height < 4) {
      // A click, not a drag: drop a default-sized field of the chosen type.
      const heightPx = Math.max(12, DEFAULT_HEIGHT_PT[type] * scaleRef.current);
      const widthPx = type === 'checkbox' ? heightPx : Math.max(80, view.width * 0.26);
      commitField(
        clampBox(
          { left: active.start.x, top: active.start.y, width: widthPx, height: heightPx },
          view.width,
          view.height,
        ),
        type,
      );
      return;
    }
    commitField(box, type);
  }, [commitField]);

  const startDraw = useCallback(
    (event: React.PointerEvent) => {
      if (tool === 'select') {
        if (event.target === event.currentTarget) setSelected(null);
        return;
      }
      const point = localPoint(event);
      capture(event);
      const origin: OverlayBox = { left: point.x, top: point.y, width: 0, height: 0 };
      gesture.current = { kind: 'draw', type: tool, start: point, orig: origin };
      setDrawBox(origin);
    },
    [localPoint, tool],
  );

  const startMove = useCallback(
    (event: React.PointerEvent, draft: DraftField) => {
      if (tool !== 'select') return;
      event.stopPropagation();
      const box = boxes[draft.id];
      if (!box) return;
      capture(event);
      gesture.current = { kind: 'move', id: draft.id, start: localPoint(event), orig: box };
      setSelected(draft.id);
    },
    [boxes, localPoint, tool],
  );

  const startResize = useCallback(
    (event: React.PointerEvent, draft: DraftField, handle: ResizeHandle) => {
      event.stopPropagation();
      const box = boxes[draft.id];
      if (!box) return;
      capture(event);
      gesture.current = { kind: 'resize', id: draft.id, handle, start: localPoint(event), orig: box };
      setSelected(draft.id);
    },
    [boxes, localPoint],
  );

  // ── draft editing ─────────────────────────────────────────────────────────
  const patch = useCallback((id: string, changes: Partial<DraftField>) => {
    setDrafts((list) => list.map((draft) => (draft.id === id ? { ...draft, ...changes } : draft)));
  }, []);

  const removeDraft = useCallback((id: string) => {
    setDrafts((list) => {
      const gone = list.find((draft) => draft.id === id);
      if (gone) setStatus(`Deleted field "${gone.name}".`);
      return list.filter((draft) => draft.id !== id);
    });
    setSelected((current) => (current === id ? null : current));
  }, []);

  const duplicateDraft = useCallback((id: string) => {
    setDrafts((list) => {
      const index = list.findIndex((draft) => draft.id === id);
      const source = list[index];
      if (!source) return list;
      const copy: DraftField = {
        ...source,
        id: newId(),
        name: nextFieldName(source.type, list.map((draft) => draft.name)),
        // Step it down the page so both are visible; PDF y grows upward, and
        // the screen box is derived from the rect, so subtract in PDF space.
        rect: { ...source.rect, y: Math.max(0, source.rect.y - 24) },
        options: [...source.options],
      };
      setSelected(copy.id);
      setStatus(`Duplicated "${source.name}" as "${copy.name}" 24 pt below it.`);
      return [...list.slice(0, index + 1), copy, ...list.slice(index + 1)];
    });
  }, []);

  const reorder = useCallback((id: string, delta: number) => {
    setDrafts((list) => {
      const index = list.findIndex((draft) => draft.id === id);
      const next = moveInTabOrder(list, index, delta);
      if (next !== list) setStatus(`Tab order: ${next.length} fields, moved one ${delta < 0 ? 'earlier' : 'later'}.`);
      return next;
    });
  }, []);

  const nudgeSelected = useCallback(
    (dxPx: number, dyPx: number) => {
      const view = viewRef.current;
      const target = selectedDraft;
      const box = target ? boxes[target.id] : null;
      if (!view || !target || !box) return;
      const moved = clampBox(translateBox(box, dxPx, dyPx), view.width, view.height);
      patch(target.id, { rect: boxToRect(moved, view) });
    },
    [boxes, patch, selectedDraft],
  );

  // ── save ──────────────────────────────────────────────────────────────────
  const save = useCallback(async () => {
    if (!file || drafts.length === 0) return;
    setSaving(true);
    setSaveError(null);
    const store = useProcessStore.getState();
    store.startProcessing('Create PDF Form', '_form.pdf');
    store.setPercent(6, 'Opening the document…');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const doc = await openPDF(bytes, { password: password || undefined });
      let removed = 0;
      if (conflict === 'replace') {
        const form = doc.getForm();
        for (const field of [...form.getFields()]) {
          form.removeField(field);
          removed += 1;
        }
      }
      // The list order *is* the tab order: `createFormField` appends to
      // `/AcroForm /Fields`, and viewers follow that array.
      let created = 0;
      for (let index = 0; index < drafts.length; index += 1) {
        const draft = drafts[index];
        const spec = toCreateSpec(draft);
        if (createFormField(doc, draft.page, spec) >= 0) created += 1;
        store.setPercent(6 + Math.round((84 * (index + 1)) / drafts.length), `Adding ${spec.name}…`);
      }
      store.setPercent(94, 'Saving…');
      const out = await savePDF(doc);
      const blob = new Blob([out as BlobPart], { type: 'application/pdf' });
      store.setOutput(blob, URL.createObjectURL(blob));
      const line = `Added ${created} fillable field${created === 1 ? '' : 's'}${
        removed ? `, removed ${removed} existing field${removed === 1 ? '' : 's'}` : ''
      }. Tab order follows the field list.`;
      store.appendLog(`FormCreatorMain: ${line}`);
      setStatus(line);
    } catch (err) {
      const text = err instanceof Error ? err.message : 'The form could not be saved.';
      store.setError(text);
      setSaveError(text);
    } finally {
      setSaving(false);
    }
  }, [conflict, drafts, file, password]);

  // ── render ────────────────────────────────────────────────────────────────
  if (phase === 'empty' || phase === 'loading') {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="max-w-sm px-6 text-center">
          <div className="mb-3 text-4xl" aria-hidden>
            🧾
          </div>
          <p className="font-display text-[13px] font-semibold text-ink">
            {phase === 'loading' ? 'Opening the document…' : 'No PDF loaded'}
          </p>
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-muted">
            {phase === 'loading'
              ? 'Rendering the first page so you can drop fields onto it.'
              : 'Add a PDF, then drag rectangles over its pages to build fillable text, checkbox, choice and list fields.'}
          </p>
        </div>
      </div>
    );
  }

  if (phase === 'locked' || phase === 'error') {
    return (
      <div className="flex h-full items-center justify-center">
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
              <button type="button" className="doodle-btn text-[11px]" onClick={() => setAttempt((n) => n + 1)}>
                Open
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-cream-border bg-cream-light/60 px-3 py-2">
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Field type to place">
          {FIELD_TYPES.map((option) => (
            <button
              key={option.type}
              type="button"
              title={option.hint}
              aria-pressed={tool === option.type}
              onClick={() => setTool(option.type)}
              className={`doodle-chip text-[10px] ${
                tool === option.type ? 'doodle-chip-active' : 'doodle-chip-inactive'
              }`}
            >
              <span aria-hidden className="mr-1">
                {option.icon}
              </span>
              {option.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setTool('select')}
            aria-pressed={tool === 'select'}
            title="Select, move and resize (Esc)"
            className={`doodle-chip text-[10px] ${tool === 'select' ? 'doodle-chip-active' : 'doodle-chip-inactive'}`}
          >
            ✥ Select
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] text-ink-muted">
            {drafts.length} field{drafts.length === 1 ? '' : 's'}
            {problems.length > 0 ? ` · ${problems.length} to fix` : ''}
          </span>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || drafts.length === 0 || problems.length > 0}
            className="doodle-btn text-[11px] disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save form'}
          </button>
        </div>
      </div>

      {existing.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-warn/25 bg-warn/5 px-3 py-2 text-[10px] text-warn">
          <span>
            This document already has an AcroForm ({existing.length} field{existing.length === 1 ? '' : 's'}
            {xfa ? ', plus an XFA packet' : ''}).
          </span>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              name="acroform-conflict"
              checked={conflict === 'keep'}
              onChange={() => setConflict('keep')}
              className="h-3 w-3 accent-[#D97706]"
            />
            Keep them and add mine
          </label>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              name="acroform-conflict"
              checked={conflict === 'replace'}
              onChange={() => setConflict('replace')}
              className="h-3 w-3 accent-[#D97706]"
            />
            Replace the whole form
          </label>
          {xfa && conflict === 'replace' && (
            <span>Replacing clears the AcroForm widgets; an XFA layout still needs Acrobat to follow.</span>
          )}
        </div>
      )}

      {saveError && (
        <p className="shrink-0 border-b border-danger/25 bg-danger/[0.07] px-3 py-2 text-[11px] text-danger">
          {saveError}
        </p>
      )}
      {problems.length > 0 && (
        <ul className="shrink-0 space-y-0.5 border-b border-danger/25 bg-danger/[0.05] px-3 py-2 text-[10px] text-danger">
          {problems.map((problem) => (
            <li key={`${problem.id}-${problem.message}`}>{problem.message}</li>
          ))}
        </ul>
      )}

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="min-h-0 flex-1 overflow-auto bg-cream p-3">
          <div className="relative mx-auto w-fit" style={{ lineHeight: 0 }}>
            <div ref={canvasHost} />
            <div
              ref={overlayRef}
              className="absolute inset-0"
              style={{ cursor: tool === 'select' ? 'default' : 'crosshair', lineHeight: 'normal' }}
              onPointerDown={startDraw}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              {onPage.map((draft) => {
                const box = boxes[draft.id];
                if (!box) return null;
                const isSelected = draft.id === selected;
                return (
                  <div
                    key={draft.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`${draft.type} field ${draft.name} on page ${draft.page + 1}`}
                    title={`${draft.name}${draft.label ? ` — ${draft.label}` : ''}`}
                    onPointerDown={(event) => startMove(event, draft)}
                    onFocus={() => setSelected(draft.id)}
                    onKeyDown={(event) => {
                      const step = event.shiftKey ? 10 : 1;
                      if (event.key === 'ArrowLeft') {
                        event.preventDefault();
                        nudgeSelected(-step, 0);
                      } else if (event.key === 'ArrowRight') {
                        event.preventDefault();
                        nudgeSelected(step, 0);
                      } else if (event.key === 'ArrowUp') {
                        event.preventDefault();
                        nudgeSelected(0, -step);
                      } else if (event.key === 'ArrowDown') {
                        event.preventDefault();
                        nudgeSelected(0, step);
                      } else if (event.key === 'Delete' || event.key === 'Backspace') {
                        event.preventDefault();
                        removeDraft(draft.id);
                      }
                    }}
                    className={`absolute flex items-center justify-center overflow-hidden border text-[9px] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                      isSelected ? 'border-accent bg-accent/15' : 'border-accent/50 bg-accent/5'
                    }`}
                    style={{
                      left: box.left,
                      top: box.top,
                      width: box.width,
                      height: box.height,
                      cursor: tool === 'select' ? 'move' : 'crosshair',
                    }}
                  >
                    <span className="pointer-events-none max-w-full truncate px-1 font-mono text-accent">
                      {draft.name}
                      {draft.required ? ' *' : ''}
                    </span>
                    {isSelected &&
                      HANDLES.map((handle) => (
                        <span
                          key={handle}
                          role="presentation"
                          aria-hidden
                          onPointerDown={(event) => startResize(event, draft, handle)}
                          className="absolute h-2 w-2 rounded-sm border border-white bg-accent"
                          style={handleStyle(handle)}
                        />
                      ))}
                  </div>
                );
              })}

              {drawBox && (
                <div
                  className="pointer-events-none absolute border-2 border-dashed border-accent bg-accent/10"
                  style={{ left: drawBox.left, top: drawBox.top, width: drawBox.width, height: drawBox.height }}
                />
              )}
            </div>
          </div>
        </div>

        <aside className="flex max-h-[26rem] min-h-0 w-full shrink-0 flex-col border-t border-cream-border bg-cream-light/40 lg:max-h-none lg:w-96 lg:border-l lg:border-t-0">
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
              Fields — this list is the tab order
            </p>
            <ol className="mt-1 list-none space-y-1 p-0">
              {drafts.map((draft, index) => (
                <li key={draft.id}>
                  <div
                    className={`flex items-center gap-1 rounded-doodle-md border px-1.5 py-1 text-[10px] ${
                      draft.id === selected ? 'border-accent bg-white' : 'border-cream-border bg-white/70'
                    }`}
                  >
                    <span className="w-5 shrink-0 text-center font-mono tabular-nums text-ink-muted">
                      {index + 1}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setSelected(draft.id);
                        setPage((current) =>
                          current
                            ? { ...current, page: Math.min(current.numPages, draft.page + 1) }
                            : current,
                        );
                      }}
                      className="min-w-0 flex-1 truncate text-left text-ink hover:text-accent"
                      title={draft.name}
                    >
                      {draft.name}
                      <span className="ml-1 text-ink-muted">
                        {draft.type} · p{draft.page + 1}
                      </span>
                    </button>
                    <IconChip label="Move earlier in tab order" onClick={() => reorder(draft.id, -1)} disabled={index === 0}>
                      ↑
                    </IconChip>
                    <IconChip
                      label="Move later in tab order"
                      onClick={() => reorder(draft.id, 1)}
                      disabled={index === drafts.length - 1}
                    >
                      ↓
                    </IconChip>
                    <IconChip label="Duplicate this field" onClick={() => duplicateDraft(draft.id)}>
                      ⧉
                    </IconChip>
                    <IconChip label="Delete this field" onClick={() => removeDraft(draft.id)} danger>
                      ✕
                    </IconChip>
                  </div>
                </li>
              ))}
              {drafts.length === 0 && (
                <li className="rounded-doodle-md border border-dashed border-cream-border p-3 text-[10px] leading-relaxed text-ink-muted">
                  No fields yet. Pick a type above, then drag a rectangle on the page — a single click drops a
                  default-sized field. Arrow keys nudge a selected field, Delete removes it.
                </li>
              )}
            </ol>
          </div>

          {selectedDraft && (
            <div className="shrink-0 space-y-2 border-t border-cream-border bg-white p-2">
              <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
                {selectedDraft.type} field
              </p>
              <div className="grid grid-cols-2 gap-2">
                <Labeled label="Name">
                  <input
                    value={selectedDraft.name}
                    onChange={(event) => patch(selectedDraft.id, { name: event.target.value })}
                    className="doodle-input text-[11px]"
                    aria-label="Field name"
                  />
                </Labeled>
                <Labeled label="Tooltip">
                  <input
                    value={selectedDraft.label}
                    onChange={(event) => patch(selectedDraft.id, { label: event.target.value })}
                    placeholder="Shown instead of the name"
                    className="doodle-input text-[11px]"
                    aria-label="Field tooltip"
                  />
                </Labeled>
                <Labeled label="Font size (pt)">
                  <input
                    type="number"
                    min={4}
                    max={72}
                    value={selectedDraft.fontSize}
                    onChange={(event) =>
                      patch(selectedDraft.id, { fontSize: event.target.valueAsNumber || 12 })
                    }
                    className="doodle-input text-[11px]"
                    aria-label="Font size in points"
                  />
                </Labeled>
                <Labeled label="Max length (0 = no limit)">
                  <input
                    type="number"
                    min={0}
                    max={9999}
                    value={selectedDraft.maxLength}
                    onChange={(event) =>
                      patch(selectedDraft.id, { maxLength: Math.max(0, event.target.valueAsNumber || 0) })
                    }
                    className="doodle-input text-[11px]"
                    aria-label="Maximum text length"
                  />
                </Labeled>
              </div>
              <Labeled label="Initial value">
                <input
                  value={selectedDraft.value}
                  onChange={(event) => patch(selectedDraft.id, { value: event.target.value })}
                  className="doodle-input text-[11px]"
                  aria-label="Initial value"
                  placeholder={selectedDraft.type === 'checkbox' ? 'Any text except off/0/false/no ticks it' : 'Pre-filled text'}
                />
              </Labeled>
              {(selectedDraft.type === 'dropdown' ||
                selectedDraft.type === 'list' ||
                selectedDraft.type === 'radio') && (
                <Labeled label="Options (one per line)">
                  <textarea
                    value={selectedDraft.options.join('\n')}
                    onChange={(event) => patch(selectedDraft.id, { options: parseOptions(event.target.value) })}
                    rows={4}
                    className="doodle-input w-full resize-y text-[11px]"
                    aria-label="Choice options, one per line"
                  />
                </Labeled>
              )}
              <div className="flex flex-wrap items-center gap-3 pt-0.5">
                <Check
                  label="Required"
                  checked={selectedDraft.required}
                  onChange={(next) => patch(selectedDraft.id, { required: next })}
                />
                <Check
                  label="Read-only"
                  checked={selectedDraft.readOnly}
                  onChange={(next) => patch(selectedDraft.id, { readOnly: next })}
                />
                <Check
                  label="Multiline"
                  checked={selectedDraft.multiline}
                  onChange={(next) => patch(selectedDraft.id, { multiline: next })}
                  disabled={selectedDraft.type !== 'text'}
                />
              </div>
              <p className="text-[9px] leading-relaxed text-ink-muted">
                {Math.round(selectedDraft.rect.width)} × {Math.round(selectedDraft.rect.height)} pt at x{' '}
                {Math.round(selectedDraft.rect.x)}, y {Math.round(selectedDraft.rect.y)} (bottom-left origin).
                Arrow keys nudge the box; hold Shift for 10 pt steps.
              </p>
            </div>
          )}
        </aside>
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-cream-border bg-cream-light/60 px-3 py-1.5">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="doodle-chip text-[10px] doodle-chip-inactive disabled:opacity-30"
            disabled={!page || page.page <= 1}
            onClick={() => setPage((current) => (current ? { ...current, page: Math.max(1, current.page - 1) } : current))}
          >
            ◂ Prev
          </button>
          <input
            type="number"
            min={1}
            max={page?.numPages ?? 1}
            value={page?.page ?? 1}
            onChange={(event) => {
              const next = Math.max(1, Math.min(page?.numPages ?? 1, event.target.valueAsNumber || 1));
              setPage((current) => (current ? { ...current, page: next } : current));
            }}
            className="doodle-input w-16 text-center font-mono text-[10px]"
            aria-label="Page number"
          />
          <span className="text-[10px] tabular-nums text-ink-muted">/ {page?.numPages ?? 0}</span>
          <button
            type="button"
            className="doodle-chip text-[10px] doodle-chip-inactive disabled:opacity-30"
            disabled={!page || page.page >= page.numPages}
            onClick={() =>
              setPage((current) =>
                current ? { ...current, page: Math.min(current.numPages, current.page + 1) } : current,
              )
            }
          >
            Next ▸
          </button>
          <button
            type="button"
            className="doodle-chip text-[10px] doodle-chip-inactive"
            onClick={() => setScale((s) => Math.max(0.5, Number((s - 0.2).toFixed(2))))}
          >
            −
          </button>
          <span className="text-[10px] tabular-nums text-ink-muted">{Math.round(scale * 100)}%</span>
          <button
            type="button"
            className="doodle-chip text-[10px] doodle-chip-inactive"
            onClick={() => setScale((s) => Math.min(3, Number((s + 0.2).toFixed(2))))}
          >
            +
          </button>
        </div>
        <p className="min-w-0 flex-1 truncate text-[10px] text-ink-muted" aria-live="polite">
          {status ??
            `${
              page?.widthPt ? `${Math.round(page.widthPt)} × ${Math.round(page.heightPt)} pt · ` : ''
            }${onPage.length} field${onPage.length === 1 ? '' : 's'} on this page · ${
              tool === 'select' ? 'drag a field to move it' : 'drag a rectangle to place a field'
            }`}
        </p>
      </div>
    </div>
  );
}

// ── small pieces ────────────────────────────────────────────────────────────

function handleStyle(handle: ResizeHandle): React.CSSProperties {
  const vertical = handle.startsWith('n') ? 0 : handle.startsWith('s') ? 100 : 50;
  const horizontal = handle.endsWith('w') ? 0 : handle.endsWith('e') ? 100 : 50;
  return {
    left: `${horizontal}%`,
    top: `${vertical}%`,
    marginLeft: -4,
    marginTop: -4,
    cursor: `${handle}-resize`,
  };
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="block space-y-0.5">
      <span className="block font-mono text-[9px] uppercase tracking-[0.08em] text-ink-muted">{label}</span>
      {children}
    </label>
  );
}

function Check({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <label className={`flex items-center gap-1 text-[10px] text-ink-soft ${disabled ? 'opacity-40' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="h-3 w-3 accent-[#2563EB]"
      />
      {label}
    </label>
  );
}

function IconChip({
  label,
  onClick,
  children,
  disabled,
  danger,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  danger?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={`rounded px-1 py-0.5 text-[10px] leading-none hover:bg-cream-soft focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-25 ${
        danger ? 'text-danger' : 'text-ink-soft'
      }`}
    >
      {children}
    </button>
  );
}

export { FormCreatorMain };
