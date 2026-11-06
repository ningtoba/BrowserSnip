/**
 * PageOrganizer — the `organize` tool's page planner (replaces the old
 * reorder-only `OrganizeMain` grid).
 *
 * The pane owns a *plan*: an ordered list of items, each one either "put page
 * *p* of file *f* here, rotated *r* degrees" or "put a blank sheet here". Every
 * interaction — drag-and-drop, the per-card buttons, the keyboard shortcuts, the
 * plan text box — is a pure reducer over that list, which is what
 * `tests/pdf/page-organizer.test.ts` exercises.
 *
 * Two things leave the pane:
 *
 * 1. `params.pageOrder` on the file store, in the grammar the registry parses
 *    (`3, 1r90, blank`). When a plan pulls from more than one open document,
 *    each page token is qualified with its file (`f2:3r90`) because the
 *    registry's `parsePlan` only ever sees the first input — which is why the
 *    pane also builds the export itself with **Save**, and that path understands
 *    the whole multi-file plan.
 * 2. The rebuilt PDF, pushed straight into the process store so the workspace's
 *    preview and download actions light up.
 *
 * Sessions are owned here: one `PdfSession` per open file, destroyed when the
 * file list changes and on unmount. The old module-level preview document leaked
 * them and invalidated whichever other component rendered last.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFileStore } from '@/stores/file-store';
import { useProcessStore } from '@/stores/process-store';
import { degrees, newPDF, openPDF, savePDF, PasswordRequiredError } from '@/lib/pdf/core/doc';
import type { PDFDocument } from '@maxwbh/pdf-lib';
import { displayedSize, normaliseRotation, resolvePages, PageSpecError } from '@/lib/pdf/core/pages';
import { openRender, thumbnails, type PdfSession } from '@/lib/pdf/core/render';

// ── the plan model (pure, unit-tested) ──────────────────────────────────────

export type PlanRotation = 0 | 90 | 180 | 270;

/** One open document, as far as the plan is concerned. */
export interface PlanSource {
  name: string;
  pages: number;
}

export type PlanItem =
  | { kind: 'page'; source: number; page: number; rotate: PlanRotation }
  | { kind: 'blank' };

export type Plan = PlanItem[];

/** `blank` in the plan grammar: a sheet sized like the page before it. */
export const BLANK_ITEM: PlanItem = { kind: 'blank' };

export function pageItem(source: number, page: number, rotate: PlanRotation = 0): PlanItem {
  return { kind: 'page', source, page, rotate };
}

/** Every page of one source, in document order. */
export function defaultPlan(sources: PlanSource[], source = 0): Plan {
  const doc = sources[source];
  if (!doc || doc.pages < 1) return [];
  return Array.from({ length: doc.pages }, (_, index) => pageItem(source, index));
}

/** Insert `items` so they start at `index` (clamped; `plan.length` appends). */
export function insertPlanItems(plan: Plan, index: number, items: PlanItem[]): Plan {
  if (items.length === 0) return plan;
  const at = Math.max(0, Math.min(plan.length, index));
  const copies = items.map((item) => ({ ...item }));
  return [...plan.slice(0, at), ...copies, ...plan.slice(at)];
}

/**
 * Move the item at `from` to insertion position `to`, where `to` indexes the
 * list *as it is now* — so `to` may be `plan.length` and a drop to the right of
 * the dragged card needs no pre-adjustment by the caller.
 */
export function movePlanItem(plan: Plan, from: number, to: number): Plan {
  if (from < 0 || from >= plan.length || from === to) return plan;
  const next = [...plan];
  const [item] = next.splice(from, 1);
  const insertAt = Math.max(0, Math.min(next.length, to > from ? to - 1 : to));
  next.splice(insertAt, 0, item);
  return next;
}

/** Exchange two slots — the keyboard "nudge one position" reducer. */
export function swapPlanItems(plan: Plan, from: number, to: number): Plan {
  if (from === to) return plan;
  if (from < 0 || to < 0 || from >= plan.length || to >= plan.length) return plan;
  const next = [...plan];
  next[from] = plan[to];
  next[to] = plan[from];
  return next;
}

/** Add `delta` degrees to one planned page. Rotation is absolute: four turns
 *  return to the source page's own `/Rotate`, which `rotate: 0` inherits. */
export function rotatePlanItem(plan: Plan, index: number, delta: number): Plan {
  return plan.map((item, i) => {
    if (i !== index || item.kind !== 'page') return item;
    return { ...item, rotate: normaliseRotation(item.rotate + delta) as PlanRotation };
  });
}

/** Repeat an item directly after itself. */
export function duplicatePlanItem(plan: Plan, index: number): Plan {
  const item = plan[index];
  if (!item) return plan;
  return insertPlanItems(plan, index + 1, [item]);
}

export function deletePlanItem(plan: Plan, index: number): Plan {
  if (index < 0 || index >= plan.length) return plan;
  return plan.filter((_, i) => i !== index);
}

/** A blank sheet after `index` (`-1` puts it in front of everything). */
export function insertBlankAfter(plan: Plan, index: number): Plan {
  return insertPlanItems(plan, index + 1, [BLANK_ITEM]);
}

/** Pull 0-based `pages` out of one source, inserting them at `index`. */
export function insertPagesFrom(
  plan: Plan,
  index: number,
  source: number,
  pages: number[],
  rotate: PlanRotation = 0,
): Plan {
  return insertPlanItems(
    plan,
    index,
    pages.map((page) => pageItem(source, page, rotate)),
  );
}

export interface PlanStats {
  total: number;
  /** Planned pages that came from a document. */
  pages: number;
  blanks: number;
  /** How many pages each source contributes, indexed like `sources`. */
  perSource: number[];
  /** Distinct source pages used — lower than `pages` when something is duplicated. */
  distinct: number;
}

export function planStats(plan: Plan, sourceCount: number): PlanStats {
  const perSource = new Array<number>(Math.max(0, sourceCount)).fill(0);
  const used = new Set<string>();
  let blanks = 0;
  for (const item of plan) {
    if (item.kind === 'blank') {
      blanks += 1;
      continue;
    }
    // Sources are bounded by the open files: a plan that references a file which
    // is no longer open still counts towards `pages`, just not to a tab.
    if (item.source >= 0 && item.source < perSource.length) perSource[item.source] += 1;
    used.add(`${item.source}:${item.page}`);
  }
  return {
    total: plan.length,
    pages: plan.length - blanks,
    blanks,
    perSource,
    distinct: used.size,
  };
}

/** True when the plan is exactly the untouched page order of `source`. */
export function isPristinePlan(plan: Plan, sources: PlanSource[], source = 0): boolean {
  const base = defaultPlan(sources, source);
  if (base.length !== plan.length) return false;
  return base.every((item, index) => sameItem(plan[index], item));
}

function sameItem(a: PlanItem | undefined, b: PlanItem): boolean {
  if (!a) return false;
  if (a.kind === 'blank' || b.kind === 'blank') return a.kind === b.kind;
  return a.source === b.source && a.page === b.page && a.rotate === b.rotate;
}

// ── the `pageOrder` string grammar ──────────────────────────────────────────

const TOKEN = /^(?:f(\d+):)?(\d+)(?:r(\d{1,3}))?$/i;

/**
 * Serialise a plan for `params.pageOrder`.
 *
 * Single-document plans use the registry's grammar verbatim (`3, 1r90, blank`).
 * A plan that touches a second document qualifies every page token with its
 * file (`f2:3`), which the registry's parser rejects — see the note rendered in
 * the pane footer.
 */
export function planToPageOrder(plan: Plan): string {
  const multi = plan.some((item) => item.kind === 'page' && item.source !== 0);
  return plan
    .map((item) => {
      if (item.kind === 'blank') return 'blank';
      const file = multi ? `f${item.source + 1}:` : '';
      const rotate = item.rotate ? `r${item.rotate}` : '';
      return `${file}${item.page + 1}${rotate}`;
    })
    .join(', ');
}

/**
 * Parse a `pageOrder` string back into a plan. `sources` bounds the page
 * numbers, so a plan written against a document that is no longer open is
 * refused with a sentence instead of silently dropping pages.
 *
 * An empty spec means "the whole first document, in order" — the same default
 * the registry applies.
 */
export function parsePageOrder(spec: string, sources: PlanSource[]): Plan {
  const text = (spec ?? '').trim();
  if (!text) return defaultPlan(sources, 0);
  const out: Plan = [];
  for (const raw of text.split(/[,\s]+/)) {
    const token = raw.trim();
    if (!token) continue;
    if (/^blank$/i.test(token)) {
      out.push({ kind: 'blank' });
      continue;
    }
    const match = TOKEN.exec(token);
    if (!match) {
      throw new PageSpecError(
        `"${token}" is not a page token. Use 3, 3r90 or blank — f2:3 pulls page 3 of the second file.`,
      );
    }
    const fileNumber = match[1] ? Number(match[1]) : 1;
    const source = sources[fileNumber - 1];
    if (!source) {
      throw new PageSpecError(
        `"${token}" asks for file ${fileNumber}, but ${sources.length} PDF${
          sources.length === 1 ? '' : 's'
        } ${sources.length === 1 ? 'is' : 'are'} open.`,
      );
    }
    const page = Number(match[2]) - 1;
    if (page < 0 || page >= source.pages) {
      throw new PageSpecError(
        `"${token}" refers to page ${page + 1} of file ${fileNumber}, which has ${source.pages} page${
          source.pages === 1 ? '' : 's'
        }.`,
      );
    }
    const rotate = match[3] ? (normaliseRotation(Number(match[3])) as PlanRotation) : 0;
    out.push(pageItem(fileNumber - 1, page, rotate));
  }
  if (out.length === 0) throw new PageSpecError('The page order is empty.');
  return out;
}

/** The first planned page item's source — blank sheets copy its page size. */
export function firstPlannedSource(plan: Plan): number | undefined {
  for (const item of plan) {
    if (item.kind === 'page') return item.source;
  }
  return undefined;
}

// ── pane state ──────────────────────────────────────────────────────────────

type SourceStatus = 'loading' | 'ready' | 'locked' | 'error';

interface SourceState {
  name: string;
  size: number;
  pages: number;
  /** Thumbnail data URLs, index = page - 1; sparse while rendering. */
  thumbs: (string | undefined)[];
  status: SourceStatus;
  message?: string;
  /** Pages rendered so far, for the progress line. */
  done: number;
}

/**
 * What a drag is carrying: an existing card (reorder) or a page pulled out of
 * one of the open documents (insert). `slot` on drop is always an insertion
 * index into the plan as it stands.
 */
type DragPayload =
  | { kind: 'plan'; index: number }
  | { kind: 'source'; source: number; page: number };

const THUMB_MAX_SIDE = 132;

export default function PageOrganizer(): JSX.Element {
  const files = useFileStore((s) => s.files);
  const params = useFileStore((s) => s.params);
  const setParams = useFileStore((s) => s.setParams);

  const [sources, setSources] = useState<SourceState[]>([]);
  const [plan, setPlan] = useState<Plan>([]);
  const [selected, setSelected] = useState<number | null>(null);
  /** Keyboard "picked up" card, plus the slot it would drop into. */
  const [carried, setCarried] = useState<number | null>(null);
  const [dropSlot, setDropSlot] = useState<number | null>(null);
  const [tray, setTray] = useState(0);
  const [traySpec, setTraySpec] = useState('all');
  const [planText, setPlanText] = useState('');
  const [planTextError, setPlanTextError] = useState<string | null>(null);
  const [passwords, setPasswords] = useState<Record<number, string>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [focusCard, setFocusCard] = useState<number | null>(null);

  const sessions = useRef(new Map<number, PdfSession>());
  const passwordsRef = useRef(passwords);
  passwordsRef.current = passwords;
  const planRef = useRef<Plan>(plan);
  planRef.current = plan;
  const dragPayload = useRef<DragPayload | null>(null);
  const cardRefs = useRef(new Map<number, HTMLDivElement>());

  const readyCount = useMemo(() => sources.filter((s) => s.status === 'ready').length, [sources]);
  const planSources = useMemo<PlanSource[]>(
    () => sources.map((s) => ({ name: s.name, pages: s.pages })),
    [sources],
  );
  const stats = useMemo(() => planStats(plan, sources.length), [plan, sources.length]);
  const loading = sources.some((s) => s.status === 'loading');
  const customised = planSources.length > 0 && !isPristinePlan(plan, planSources, 0);
  const multiFile = stats.perSource.filter((n) => n > 0).length > 1;

  const announce = useCallback((line: string) => setStatus(line), []);

  const destroySessions = useCallback(() => {
    for (const session of sessions.current.values()) void session.destroy();
    sessions.current.clear();
  }, []);

  // ── one session + thumbnail strip per open file ───────────────────────────
  useEffect(() => {
    const token = { alive: true };
    destroySessions();
    setPasswords({});
    setPlanTextError(null);
    if (files.length === 0) {
      setSources([]);
      setPlan([]);
      setSelected(null);
      setTray(0);
      return () => {
        token.alive = false;
      };
    }

    setSources(
      files.map(
        (file): SourceState => ({
          name: file.name,
          size: file.size,
          pages: 0,
          thumbs: [],
          status: 'loading',
          done: 0,
        }),
      ),
    );
    setTray(0);

    const patch = (index: number, next: Partial<SourceState>) =>
      setSources((current) => current.map((s, i) => (i === index ? { ...s, ...next } : s)));

    const fillThumb = (index: number, page: number, url: string) =>
      setSources((current) => {
        const existing = current[index];
        if (!existing) return current;
        const thumbs = [...existing.thumbs];
        thumbs[page - 1] = url;
        return current.map((s, i) =>
          i === index ? { ...s, thumbs, done: Math.max(s.done, page) } : s,
        );
      });

    (async () => {
      for (let index = 0; index < files.length; index += 1) {
        if (!token.alive) return;
        const file = files[index];
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const session = await openRender(bytes, { password: passwordsRef.current[index] });
          if (!token.alive) {
            await session.destroy();
            return;
          }
          sessions.current.set(index, session);
          patch(index, { pages: session.numPages, thumbs: new Array(session.numPages), done: 0 });
          const urls = await thumbnails(session, {
            maxSide: THUMB_MAX_SIDE,
            onPage: (page, url) => {
              if (token.alive) fillThumb(index, page, url);
            },
          });
          if (!token.alive) return;
          patch(index, { status: 'ready', thumbs: urls, done: urls.length });
        } catch (err) {
          if (!token.alive) return;
          const message = err instanceof Error ? err.message : 'This PDF could not be previewed.';
          patch(index, {
            status: err instanceof PasswordRequiredError ? 'locked' : 'error',
            message,
          });
        }
      }
    })();

    return () => {
      token.alive = false;
      destroySessions();
    };
    // Password retries are handled by `retryWithPassword`, so `passwords` is
    // read through a ref and stays out of these dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, destroySessions]);

  /** Re-preview one locked file with the password just typed for it. */
  const retryWithPassword = useCallback(
    async (index: number) => {
      const file = files[index];
      if (!file) return;
      setSources((current) =>
        current.map((s, i) => (i === index ? { ...s, status: 'loading', message: undefined } : s)),
      );
      try {
        const session = await openRender(new Uint8Array(await file.arrayBuffer()), {
          password: passwords[index] || undefined,
        });
        await sessions.current.get(index)?.destroy().catch(() => undefined);
        sessions.current.set(index, session);
        const thumbs = new Array<string | undefined>(session.numPages);
        setSources((current) =>
          current.map((s, i) => (i === index ? { ...s, pages: session.numPages, thumbs } : s)),
        );
        const urls = await thumbnails(session, {
          maxSide: THUMB_MAX_SIDE,
          onPage: (page, url) => {
            setSources((current) => {
              const existing = current[index];
              if (!existing) return current;
              const next = [...existing.thumbs];
              next[page - 1] = url;
              return current.map((s, i) =>
                i === index ? { ...s, thumbs: next, done: Math.max(s.done, page) } : s,
              );
            });
          },
        });
        setSources((current) =>
          current.map((s, i) =>
            i === index
              ? { ...s, status: 'ready', thumbs: urls, done: urls.length }
              : s,
          ),
        );
        announce(`Unlocked ${file.name} — ${session.numPages} pages available.`);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'That password did not open this PDF.';
        setSources((current) =>
          current.map((s, i) => (i === index ? { ...s, status: 'locked', message } : s)),
        );
      }
    },
    [announce, files, passwords],
  );

  // ── seed the plan once the documents are known ────────────────────────────
  const seededFor = useRef('');
  useEffect(() => {
    if (readyCount === 0) return;
    const key = planSources.map((s) => `${s.name}:${s.pages}`).join('|');
    if (seededFor.current === key) return;
    seededFor.current = key;
    const external = typeof params.pageOrder === 'string' ? params.pageOrder.trim() : '';
    if (external) {
      try {
        setPlan(parsePageOrder(external, planSources));
        return;
      } catch {
        // A plan written against a different set of documents: fall back to
        // the first file's own order rather than losing the whole grid.
      }
    }
    setPlan(defaultPlan(planSources, 0));
  }, [params.pageOrder, planSources, readyCount]);

  // ── publish the plan as the registry's `pageOrder` value ──────────────────
  useEffect(() => {
    const spec = planToPageOrder(plan);
    setPlanText(spec);
    const current = useFileStore.getState().params;
    if (current.pageOrder === spec) return;
    setParams({ ...current, pageOrder: spec });
  }, [plan, setParams]);

  // Return focus to the card a keyboard action just moved.
  useEffect(() => {
    if (focusCard === null) return;
    cardRefs.current.get(focusCard)?.focus();
    setFocusCard(null);
  }, [focusCard]);

  // ── plan edits ────────────────────────────────────────────────────────────
  const describe = useCallback(
    (item: PlanItem | undefined, index: number) => {
      if (!item) return `position ${index + 1}`;
      if (item.kind === 'blank') return `the blank sheet at position ${index + 1}`;
      const name = planSources[item.source]?.name ?? `file ${item.source + 1}`;
      return `${name} page ${item.page + 1}`;
    },
    [planSources],
  );

  const applyPlan = useCallback(
    (next: Plan, line: string, slot?: number) => {
      setPlan(next);
      announce(line);
      if (slot !== undefined) {
        setSelected(next.length === 0 ? null : Math.max(0, Math.min(slot, next.length - 1)));
      }
    },
    [announce],
  );

  const rotate = useCallback(
    (index: number, delta: number) => {
      const item = planRef.current[index];
      if (!item) return;
      if (item.kind === 'blank') {
        announce('A blank sheet has nothing to rotate.');
        return;
      }
      const next = rotatePlanItem(planRef.current, index, delta);
      const after = next[index];
      applyPlan(
        next,
        after?.kind === 'page'
          ? `${describe(after, index)} is now rotated ${after.rotate} degrees.`
          : 'Rotation unchanged.',
        index,
      );
    },
    [announce, applyPlan, describe],
  );

  const duplicate = useCallback(
    (index: number) => {
      const item = planRef.current[index];
      if (!item) return;
      applyPlan(duplicatePlanItem(planRef.current, index), `Duplicated ${describe(item, index)}.`, index + 1);
      setFocusCard(index + 1);
    },
    [applyPlan, describe],
  );

  const remove = useCallback(
    (index: number) => {
      const item = planRef.current[index];
      if (!item) return;
      const next = deletePlanItem(planRef.current, index);
      applyPlan(next, `Removed ${describe(item, index)}.`, Math.min(index, next.length - 1));
      setFocusCard(Math.min(index, next.length - 1));
    },
    [applyPlan, describe],
  );

  const addBlankAfter = useCallback(
    (index: number) => {
      const next = insertBlankAfter(planRef.current, index);
      applyPlan(next, `Inserted a blank sheet after position ${index + 1}.`, index + 1);
      setFocusCard(index + 1);
    },
    [applyPlan],
  );

  /** Where a new page lands: after the selection, otherwise at the end. */
  const insertionIndex = useCallback(
    () =>
      selected === null
        ? planRef.current.length
        : Math.min(planRef.current.length, selected + 1),
    [selected],
  );

  const insertPages = useCallback(
    (source: number, pages: number[], at?: number) => {
      if (pages.length === 0) {
        announce('That page selection matched no page in this document.');
        return;
      }
      const index = at ?? insertionIndex();
      const next = insertPagesFrom(planRef.current, index, source, pages);
      const name = planSources[source]?.name ?? `file ${source + 1}`;
      applyPlan(
        next,
        `Inserted ${pages.length} page${pages.length === 1 ? '' : 's'} from ${name} at position ${
          index + 1
        }.`,
        index + pages.length - 1,
      );
      setFocusCard(index + pages.length - 1);
    },
    [announce, applyPlan, insertionIndex, planSources],
  );

  const move = useCallback(
    (from: number, to: number) => {
      const item = planRef.current[from];
      if (!item) return;
      const next = movePlanItem(planRef.current, from, to);
      if (next === planRef.current) return;
      const landed = to > from ? to - 1 : to;
      applyPlan(next, `Moved ${describe(item, from)} to position ${landed + 1}.`, landed);
      setFocusCard(landed);
    },
    [applyPlan, describe],
  );

  const nudge = useCallback(
    (index: number, delta: number) => {
      const to = index + delta;
      if (to < 0 || to >= planRef.current.length) {
        announce(delta < 0 ? 'That is already the first page.' : 'That is already the last page.');
        return;
      }
      const item = planRef.current[index];
      applyPlan(swapPlanItems(planRef.current, index, to), `Moved ${describe(item, index)} to position ${to + 1}.`, to);
      setFocusCard(to);
    },
    [announce, applyPlan, describe],
  );

  const pickUp = useCallback(
    (index: number) => {
      setCarried(index);
      setDropSlot(index);
      announce(
        `Picked up ${describe(planRef.current[index], index)}. Arrow keys choose the slot, Space drops it, Escape cancels.`,
      );
    },
    [announce, describe],
  );

  const drop = useCallback(() => {
    if (carried === null) return;
    const slot = dropSlot ?? carried;
    setCarried(null);
    setDropSlot(null);
    move(carried, slot);
  }, [carried, dropSlot, move]);

  const moveCarryTarget = useCallback(
    (delta: number) => {
      if (carried === null) return;
      const next = Math.max(0, Math.min(planRef.current.length, (dropSlot ?? carried) + delta));
      setDropSlot(next);
      announce(`Drop at position ${next + 1}.`);
    },
    [announce, carried, dropSlot],
  );

  const cancelCarry = useCallback(() => {
    if (carried === null) return;
    setCarried(null);
    setDropSlot(null);
    announce('Move cancelled.');
  }, [announce, carried]);

  const resetOrder = useCallback(() => {
    setPlan(defaultPlan(planSources, 0));
    setSelected(null);
    setCarried(null);
    setDropSlot(null);
    announce('Reset to the original page order of the first document.');
  }, [announce, planSources]);

  const startFrom = useCallback(
    (source: number) => {
      const next = defaultPlan(planSources, source);
      setPlan(next);
      setSelected(null);
      announce(
        `Started a new order from ${planSources[source]?.name ?? 'that file'} — ${next.length} page${
          next.length === 1 ? '' : 's'
        }.`,
      );
    },
    [announce, planSources],
  );

  /** Apply a hand-edited or pasted plan string. */
  const applyPlanText = useCallback(() => {
    try {
      const next = parsePageOrder(planText, planSources);
      setPlan(next);
      setPlanTextError(null);
      setSelected(null);
      announce(`Loaded a ${next.length}-page plan from the text field.`);
    } catch (err) {
      setPlanTextError(err instanceof Error ? err.message : 'That page order could not be read.');
    }
  }, [announce, planSources, planText]);

  // ── drop handling ─────────────────────────────────────────────────────────
  const finishDrop = useCallback(
    (slot: number) => {
      const payload = dragPayload.current;
      dragPayload.current = null;
      setDropSlot(null);
      if (!payload) return;
      if (payload.kind === 'plan') {
        move(payload.index, slot);
        return;
      }
      insertPages(payload.source, [payload.page], slot);
    },
    [insertPages, move],
  );

  // ── export ────────────────────────────────────────────────────────────────
  const buildPlan = useCallback(async () => {
    const current = planRef.current;
    if (current.length === 0) throw new Error('The page order is empty — add a page first.');
    const docs = new Map<number, PDFDocument>();
    const open = async (source: number): Promise<PDFDocument> => {
      const cached = docs.get(source);
      if (cached) return cached;
      const file = files[source];
      if (!file) throw new Error(`File ${source + 1} is no longer open.`);
      try {
        const doc = await openPDF(new Uint8Array(await file.arrayBuffer()), {
          password: passwordsRef.current[source] || undefined,
        });
        docs.set(source, doc);
        return doc;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'it could not be read.';
        throw new Error(`"${file.name}" could not be opened: ${message}`);
      }
    };
    const sizeOfFirstPage = async (): Promise<{ width: number; height: number }> => {
      const source = firstPlannedSource(current) ?? 0;
      const doc = await open(source);
      if (doc.getPageCount() === 0) throw new Error(`"${files[source]?.name ?? 'That file'}" has no pages to size a blank sheet from.`);
      return displayedSize(doc.getPage(0));
    };

    const target = await newPDF();
    for (let index = 0; index < current.length; index += 1) {
      const item = current[index];
      if (item.kind === 'blank') {
        const reference =
          target.getPageCount() > 0
            ? displayedSize(target.getPage(target.getPageCount() - 1))
            : await sizeOfFirstPage();
        target.insertPage(index, [reference.width, reference.height]);
      } else {
        const source = await open(item.source);
        const [page] = await target.copyPages(source, [item.page]);
        if (item.rotate) page.setRotation(degrees(normaliseRotation(item.rotate)));
        target.insertPage(index, page);
      }
      useProcessStore
        .getState()
        .setPercent(
          Math.round((90 * (index + 1)) / current.length),
          item.kind === 'blank'
            ? 'Inserted a blank sheet'
            : `Placed page ${index + 1} of ${current.length}`,
        );
    }
    return target;
  }, [files]);

  const save = useCallback(async () => {
    if (plan.length === 0) return;
    setSaving(true);
    setSaveError(null);
    const store = useProcessStore.getState();
    store.startProcessing('Organize PDF', '_organized.pdf');
    store.setPercent(3, `Rebuilding ${plan.length} page${plan.length === 1 ? '' : 's'}…`);
    try {
      const doc = await buildPlan();
      store.setPercent(94, 'Saving…');
      const bytes = await savePDF(doc);
      const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
      store.setOutput(blob, URL.createObjectURL(blob));
      store.appendLog(
        `PageOrganizer: ${stats.pages} page${stats.pages === 1 ? '' : 's'} from ${
          stats.perSource.filter((n) => n > 0).length
        } file(s), ${stats.blanks} blank sheet${stats.blanks === 1 ? '' : 's'}.`,
      );
      announce(`Saved a ${plan.length}-page PDF.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'The reordered PDF could not be saved.';
      store.setError(message);
      setSaveError(message);
    } finally {
      setSaving(false);
    }
  }, [announce, buildPlan, plan, stats]);

  // ── render ────────────────────────────────────────────────────────────────
  if (files.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <div className="mb-3 text-4xl" aria-hidden>
            📑
          </div>
          <p className="font-display text-[13px] font-semibold text-ink">No pages to organise yet</p>
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-muted">
            Add one or more PDFs in the left panel. The first becomes the page order you edit, and every
            other file becomes a source you can pull pages from.
          </p>
        </div>
      </div>
    );
  }

  const traySource = sources[tray];
  const reused =
    stats.distinct === stats.pages
      ? ''
      : ` · ${stats.distinct} source page${stats.distinct === 1 ? '' : 's'} reused`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-cream-border bg-cream-light/60 px-3 py-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
            Plan: {stats.total} page{stats.total === 1 ? '' : 's'}
          </span>
          <span className="text-[10px] text-ink-muted">
            {stats.pages} from documents · {stats.blanks} blank{reused}
          </span>
          {sources.length > 1 && (
            <span className="text-[10px] text-ink-muted">
              {sources.map((s, i) => `${i + 1}: ${s.pages}p`).join(' · ')}
            </span>
          )}
          {customised && <span className="text-[10px] font-medium text-accent">Custom order</span>}
          {loading && <span className="text-[10px] text-warn">Rendering thumbnails…</span>}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={resetOrder} className="doodle-chip text-[10px] doodle-chip-inactive">
            Reset order
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || plan.length === 0}
            className="doodle-btn text-[11px] disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save reordered PDF'}
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* the plan */}
        <div
          className="min-h-0 flex-1 overflow-y-auto p-3"
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
          }}
          onDragLeave={(event) => {
            if (event.currentTarget === event.target) setDropSlot(null);
          }}
          onDrop={(event) => {
            event.preventDefault();
            finishDrop(planRef.current.length);
          }}
        >
          {saveError && <Notice tone="danger">{saveError}</Notice>}
          <ul className="grid list-none gap-3 p-0 sm:grid-cols-[repeat(auto-fill,minmax(152px,1fr))]">
            {plan.map((item, index) => (
              <PlanCard
                key={`${index}-${item.kind}-${item.kind === 'page' ? `${item.source}:${item.page}` : 'blank'}`}
                index={index}
                item={item}
                thumb={item.kind === 'page' ? sources[item.source]?.thumbs[item.page] : undefined}
                sourceName={item.kind === 'page' ? planSources[item.source]?.name ?? '' : ''}
                total={plan.length}
                selected={selected === index}
                carried={carried === index}
                dropBefore={dropSlot !== null && dropSlot === index}
                dropAfter={dropSlot !== null && dropSlot === index + 1}
                registerRef={(node) => {
                  if (node) cardRefs.current.set(index, node);
                  else cardRefs.current.delete(index);
                }}
                onSelect={() => setSelected(index)}
                onDragStart={(payload) => {
                  dragPayload.current = payload;
                }}
                onDragOverSlot={(slot) => setDropSlot(slot)}
                onDropCard={() => finishDrop(dropSlot ?? index)}
                onRotate={(delta) => rotate(index, delta)}
                onDuplicate={() => duplicate(index)}
                onDelete={() => remove(index)}
                onBlankAfter={() => addBlankAfter(index)}
                onNudge={(delta) => nudge(index, delta)}
                onPickUp={() => pickUp(index)}
                onDropCarry={drop}
                onCarryMove={moveCarryTarget}
                onCancelCarry={cancelCarry}
              />
            ))}
            {plan.length === 0 && (
              <li className="col-span-full rounded-doodle-md border border-dashed border-cream-border p-6 text-center text-[11px] text-ink-muted">
                Every page was removed. Drag a page in from the right, or press Reset order.
              </li>
            )}
          </ul>

          <div className="mt-4 rounded-doodle-md border border-cream-border bg-cream-light p-3">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
              Page order value
            </span>
            <div className="mt-1 flex gap-2">
              <input
                value={planText}
                onChange={(event) => setPlanText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    applyPlanText();
                  }
                }}
                spellCheck={false}
                className="doodle-input flex-1 font-mono text-[11px]"
                aria-label="Page order value"
                aria-describedby="plan-order-help"
              />
              <button type="button" onClick={applyPlanText} className="doodle-btn text-[11px]">
                Apply
              </button>
            </div>
            <p id="plan-order-help" className="mt-1 text-[10px] leading-relaxed text-ink-muted">
              This is the <code>pageOrder</code> value the tool registry parses, so the sidebar field and
              this grid always agree.{' '}
              {multiFile
                ? 'This plan uses more than one file, so its tokens carry a file prefix (f2:3) and only the Save button above can build it — the sidebar Run reads the first file alone.'
                : 'Tokens: 3 = page 3, 3r90 = page 3 rotated 90°, blank = empty sheet.'}
            </p>
            {planTextError && <p className="mt-1 text-[10px] text-danger">{planTextError}</p>}
          </div>
        </div>

        {/* sources */}
        <aside className="flex max-h-80 min-h-0 w-full shrink-0 flex-col border-t border-cream-border bg-cream-light/40 lg:max-h-none lg:w-72 lg:border-l lg:border-t-0">
          <div
            className="flex shrink-0 flex-wrap gap-1 border-b border-cream-border px-2 py-2"
            role="tablist"
            aria-label="Source files"
          >
            {sources.map((source, index) => (
              <button
                key={`${source.name}-${index}`}
                type="button"
                role="tab"
                aria-selected={tray === index}
                title={source.name}
                onClick={() => setTray(index)}
                className={`doodle-chip max-w-[10rem] truncate text-[10px] ${
                  tray === index ? 'doodle-chip-active' : 'doodle-chip-inactive'
                }`}
              >
                {index + 1}. {source.name}
                {source.status === 'locked' ? ' 🔒' : ''}
              </button>
            ))}
          </div>

          {traySource?.status === 'locked' && (
            <div className="shrink-0 space-y-1 border-b border-cream-border px-2 py-2">
              <p className="text-[10px] leading-relaxed text-warn">{traySource.message}</p>
              <div className="flex gap-1">
                <input
                  type="password"
                  value={passwords[tray] ?? ''}
                  onChange={(event) => setPasswords((c) => ({ ...c, [tray]: event.target.value }))}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void retryWithPassword(tray);
                    }
                  }}
                  placeholder="Password"
                  className="doodle-input flex-1 text-[11px]"
                  aria-label={`Password for ${traySource.name}`}
                />
                <button
                  type="button"
                  onClick={() => void retryWithPassword(tray)}
                  className="doodle-btn text-[10px]"
                >
                  Open
                </button>
              </div>
            </div>
          )}

          {traySource?.status === 'error' && (
            <div className="shrink-0 border-b border-cream-border px-2 py-2">
              <p className="text-[10px] leading-relaxed text-danger">{traySource.message}</p>
            </div>
          )}

          <div className="flex shrink-0 items-center gap-1 px-2 py-2">
            <input
              value={traySpec}
              onChange={(event) => setTraySpec(event.target.value)}
              className="doodle-input flex-1 font-mono text-[10px]"
              aria-label={`Pages to insert from ${traySource?.name ?? 'this file'}`}
              placeholder="1,3,5-7"
            />
            <button
              type="button"
              onClick={() => {
                const total = traySource?.pages ?? 0;
                if (total === 0) return;
                try {
                  insertPages(tray, resolvePages(traySpec || 'all', total));
                } catch (err) {
                  announce(
                    err instanceof Error ? err.message : 'That page selection could not be read.',
                  );
                }
              }}
              disabled={!traySource || traySource.status !== 'ready'}
              className="doodle-btn text-[10px] disabled:opacity-40"
            >
              Insert
            </button>
            <button
              type="button"
              onClick={() => startFrom(tray)}
              disabled={!traySource || traySource.status !== 'ready'}
              className="doodle-chip text-[10px] doodle-chip-inactive disabled:opacity-40"
              title="Replace the plan with every page of this file"
            >
              Use as base
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {traySource?.status === 'loading' && (
              <p className="px-1 py-2 text-[10px] text-ink-muted">
                Rendering thumbnails… {traySource.done}/{traySource.pages || '?'}
              </p>
            )}
            <div className="grid grid-cols-3 gap-1.5">
              {Array.from({ length: traySource?.pages ?? 0 }, (_, page) => (
                <button
                  key={page}
                  type="button"
                  draggable
                  onDragStart={(event) => {
                    dragPayload.current = { kind: 'source', source: tray, page };
                    event.dataTransfer.effectAllowed = 'copy';
                    event.dataTransfer.setData('text/plain', `f${tray + 1}:${page + 1}`);
                  }}
                  onClick={() => insertPages(tray, [page])}
                  title={`Insert page ${page + 1} of ${traySource?.name ?? ''}`}
                  aria-label={`Insert page ${page + 1} of ${traySource?.name ?? 'this file'}`}
                  className="relative overflow-hidden rounded border border-cream-border bg-white hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {traySource?.thumbs[page] ? (
                    <img
                      src={traySource.thumbs[page]}
                      alt=""
                      className="h-auto w-full select-none"
                      draggable={false}
                    />
                  ) : (
                    <span className="flex aspect-[3/4] items-center justify-center bg-cream-soft text-[9px] text-ink-muted">
                      {page + 1}
                    </span>
                  )}
                  <span className="absolute bottom-0 right-0 bg-white/85 px-1 text-[8px] font-semibold tabular-nums text-ink-muted">
                    {page + 1}
                  </span>
                </button>
              ))}
            </div>
            {traySource?.status === 'ready' && (
              <p className="px-1 pt-2 text-[10px] leading-relaxed text-ink-muted">
                Drag a page into the plan, or click it to insert after the selected page. Used here:{' '}
                {stats.perSource[tray] ?? 0} of {traySource.pages}.
              </p>
            )}
          </div>
        </aside>
      </div>

      {/* live region: every plan edit is announced here */}
      <div
        className="shrink-0 border-t border-cream-border bg-cream-light/60 px-3 py-1.5 text-[10px] leading-relaxed text-ink-muted"
        aria-live="polite"
      >
        {status ??
          'Drag thumbnails to reorder, or focus a page and press Space, then the arrow keys, then Space again. R rotates, D duplicates, B inserts a blank after it, Delete removes it.'}
      </div>
    </div>
  );
}

// ── one planned page ────────────────────────────────────────────────────────

interface PlanCardProps {
  index: number;
  item: PlanItem;
  thumb?: string;
  sourceName: string;
  total: number;
  selected: boolean;
  carried: boolean;
  dropBefore: boolean;
  dropAfter: boolean;
  registerRef: (node: HTMLDivElement | null) => void;
  onSelect: () => void;
  onDragStart: (payload: DragPayload) => void;
  onDragOverSlot: (slot: number) => void;
  onDropCard: () => void;
  onRotate: (delta: number) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onBlankAfter: () => void;
  onNudge: (delta: number) => void;
  onPickUp: () => void;
  onDropCarry: () => void;
  onCarryMove: (delta: number) => void;
  onCancelCarry: () => void;
}

function PlanCard(props: PlanCardProps): JSX.Element {
  const { index, item, thumb, sourceName, total, selected, carried, onDragStart } = props;
  const rotation = item.kind === 'page' ? item.rotate : 0;
  const label =
    item.kind === 'blank'
      ? `Blank sheet, position ${index + 1} of ${total}`
      : `${sourceName} page ${item.page + 1}${rotation ? `, rotated ${rotation} degrees` : ''}, position ${
          index + 1
        } of ${total}`;

  return (
    <li className="relative">
      {props.dropBefore && (
        <span className="absolute -left-1.5 top-0 h-full w-1 rounded bg-accent" aria-hidden />
      )}
      <div
        ref={props.registerRef}
        role="group"
        aria-roledescription="planned page"
        aria-label={selected ? `${label}, selected` : label}
        tabIndex={0}
        draggable
        onDragStart={(event) => {
          onDragStart({ kind: 'plan', index });
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', `plan:${index}`);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = 'move';
          const rect = event.currentTarget.getBoundingClientRect();
          const before =
            Math.abs(event.clientY - rect.top - rect.height / 2) > Math.abs(event.clientX - rect.left - rect.width / 2)
              ? event.clientY < rect.top + rect.height / 2
              : event.clientX < rect.left + rect.width / 2;
          props.onDragOverSlot(before ? index : index + 1);
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          props.onDropCard();
        }}
        onFocus={props.onSelect}
        onKeyDown={(event) => {
          const carrying = carried;
          switch (event.key) {
            case ' ':
            case 'Enter':
              event.preventDefault();
              if (carrying) props.onDropCarry();
              else props.onPickUp();
              break;
            case 'Escape':
              event.preventDefault();
              props.onCancelCarry();
              break;
            case 'ArrowLeft':
            case 'ArrowUp':
              event.preventDefault();
              if (carrying) props.onCarryMove(-1);
              else if (event.altKey) props.onNudge(-1);
              break;
            case 'ArrowRight':
            case 'ArrowDown':
              event.preventDefault();
              if (carrying) props.onCarryMove(1);
              else if (event.altKey) props.onNudge(1);
              break;
            case 'Delete':
            case 'Backspace':
              event.preventDefault();
              props.onDelete();
              break;
            case 'r':
            case 'R':
              event.preventDefault();
              props.onRotate(event.shiftKey ? -90 : 90);
              break;
            case 'd':
            case 'D':
              event.preventDefault();
              props.onDuplicate();
              break;
            case 'b':
            case 'B':
              event.preventDefault();
              props.onBlankAfter();
              break;
            default:
              break;
          }
        }}
        className={`relative rounded-doodle-md border bg-white transition-shadow ${
          selected ? 'border-accent ring-1 ring-accent/30' : 'border-cream-border'
        } ${carried ? 'opacity-60 ring-2 ring-accent' : ''} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`}
      >
        <div className="overflow-hidden rounded-t-[10px] p-1.5">
          <div
            className="flex items-center justify-center"
            style={{
              transform: rotation ? `rotate(${rotation}deg)` : undefined,
              transition: 'transform 160ms ease-out',
            }}
          >
            {thumb ? (
              <img src={thumb} alt="" className="max-h-32 w-auto select-none" draggable={false} />
            ) : (
              <span className="flex h-32 w-full items-center justify-center rounded bg-cream-soft text-[10px] text-ink-muted">
                {item.kind === 'blank' ? 'blank' : '…'}
              </span>
            )}
          </div>
        </div>
        <span className="absolute left-1 top-1 rounded-full bg-ink/75 px-1.5 py-0.5 text-[9px] font-bold tabular-nums text-white">
          {index + 1}
        </span>
        {item.kind === 'page' && item.rotate !== 0 && (
          <span className="absolute right-1 top-1 rounded bg-accent px-1 py-0.5 text-[9px] font-semibold text-white">
            r{item.rotate}
          </span>
        )}
        {item.kind === 'page' && item.source !== 0 && (
          <span className="absolute bottom-9 right-1 rounded bg-acc-violet px-1 py-0.5 text-[9px] font-semibold text-white">
            f{item.source + 1}
          </span>
        )}
        <div className="flex flex-wrap items-center justify-center gap-0.5 border-t border-cream-border px-1 py-1">
          <CardButton title="Rotate 90° counter-clockwise (Shift+R)" onClick={() => props.onRotate(-90)}>
            ⟲
          </CardButton>
          <CardButton title="Rotate 90° clockwise (R)" onClick={() => props.onRotate(90)}>
            ⟳
          </CardButton>
          <CardButton title="Move one position earlier (Alt+Left)" onClick={() => props.onNudge(-1)}>
            ◀
          </CardButton>
          <CardButton title="Move one position later (Alt+Right)" onClick={() => props.onNudge(1)}>
            ▶
          </CardButton>
          <CardButton title="Duplicate this page (D)" onClick={props.onDuplicate}>
            ⧉
          </CardButton>
          <CardButton title="Insert a blank sheet after this page (B)" onClick={props.onBlankAfter}>
            ▢
          </CardButton>
          <CardButton title="Delete this page (Delete)" onClick={props.onDelete} danger>
            ✕
          </CardButton>
        </div>
      </div>
      {props.dropAfter && (
        <span className="absolute -right-1.5 top-0 h-full w-1 rounded bg-accent" aria-hidden />
      )}
    </li>
  );
}

function CardButton({
  title,
  onClick,
  children,
  danger,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={`rounded px-1 py-0.5 text-[11px] leading-none transition-colors hover:bg-cream-soft focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
        danger ? 'text-danger' : 'text-ink-soft'
      }`}
    >
      {children}
    </button>
  );
}

function Notice({ tone, children }: { tone: 'danger' | 'warn'; children: React.ReactNode }): JSX.Element {
  const cls =
    tone === 'danger'
      ? 'border-danger/25 bg-danger/[0.07] text-danger'
      : 'border-warn/25 bg-warn/5 text-warn';
  return (
    <p className={`mb-3 rounded-doodle-md border px-3 py-2 text-[11px] leading-relaxed ${cls}`}>
      {children}
    </p>
  );
}

export { PageOrganizer };
