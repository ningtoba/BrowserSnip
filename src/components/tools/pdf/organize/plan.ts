/**
 * The organize pane's plan model: what a plan *is*, independent of React.
 *
 * A plan is an ordered list of items, each one either "put page *p* of file *f*
 * here, rotated *r* degrees on top of whatever the source page already carries"
 * or "put a blank sheet here". Every interaction in the pane — drag, per-card
 * button, keyboard, the plan text field — is a reducer over this list; the
 * reducer lives in `workspace.ts` and the state transitions are what
 * `tests/pdf/ux-organize.test.ts` and `tests/pdf/page-organizer.test.ts` assert.
 *
 * Page numbers are 0-based in the model and 1-based everywhere the user can see
 * them (labels, the `pageOrder` grammar, the badges on each card); the +1 lives
 * in the two places that speak to a human, never in the middle of a function.
 */
import { PageSpecError, normaliseRotation } from '@/lib/pdf/core/pages';

export type PlanRotation = 0 | 90 | 180 | 270;

/** One open document, as far as the plan is concerned. */
export interface PlanSource {
  name: string;
  pages: number;
}

/** How a source file is doing in the previewer, for the pane's honesty lines. */
export type SourceStatus = 'loading' | 'ready' | 'locked' | 'error';

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

/** Add `delta` degrees to every planned page in `indexes`, skipping blanks. */
export function rotatePlanItems(plan: Plan, indexes: number[], delta: number): Plan {
  const wanted = new Set(indexes);
  return plan.map((item, i) => {
    if (!wanted.has(i) || item.kind !== 'page') return item;
    return { ...item, rotate: normaliseRotation(item.rotate + delta) as PlanRotation };
  });
}

/** Repeat an item directly after itself. */
export function duplicatePlanItem(plan: Plan, index: number): Plan {
  const item = plan[index];
  if (!item) return plan;
  return insertPlanItems(plan, index + 1, [item]);
}

/**
 * Repeat every item in `indexes` as one block after the last of them.
 *
 * The copies stay together and keep their order — the way duplicating selected
 * slides works in a presentation app — rather than interleaving with the
 * originals, which reads as a shuffle when the selection is not contiguous.
 */
export function duplicatePlanItems(plan: Plan, indexes: number[]): { plan: Plan; inserted: number[] } {
  const picked = [...new Set(indexes)].filter((i) => i >= 0 && i < plan.length).sort((a, b) => a - b);
  if (picked.length === 0) return { plan, inserted: [] };
  const last = picked[picked.length - 1];
  const copies = picked.map((index) => ({ ...plan[index] }));
  const next: Plan = [...plan.slice(0, last + 1), ...copies, ...plan.slice(last + 1)];
  const inserted = copies.map((_, offset) => last + 1 + offset);
  return { plan: next, inserted };
}

export function deletePlanItem(plan: Plan, index: number): Plan {
  if (index < 0 || index >= plan.length) return plan;
  return plan.filter((_, i) => i !== index);
}

/** Remove every item in `indexes`. */
export function deletePlanItems(plan: Plan, indexes: number[]): Plan {
  const wanted = new Set(indexes);
  if (wanted.size === 0) return plan;
  return plan.filter((_, i) => !wanted.has(i));
}

/** A blank sheet after `index` (`-1` puts it in front of everything). */
export function insertBlankAfter(plan: Plan, index: number): Plan {
  return insertPlanItems(plan, index + 1, [BLANK_ITEM]);
}

/** `count` blank sheets after `index`. */
export function insertBlanksAfter(plan: Plan, index: number, count: number): Plan {
  return insertPlanItems(
    plan,
    index + 1,
    Array.from({ length: Math.max(1, count) }, () => BLANK_ITEM),
  );
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

/**
 * Whether a plan can be built, in the words the pane shows before saving.
 *
 * A plan is a promise about pages that may no longer exist: every page was
 * deleted, or the only items left are blank sheets, or a document was swapped
 * while the grid was open and its page numbers now run past the end (E6, E13,
 * E19). `Save` refuses the empty case, but the user should read the reason in the
 * plan header rather than in an error after the click.
 */
export interface PlanWarning {
  tone: 'info' | 'warn' | 'danger';
  text: string;
}

export function planWarnings(
  plan: Plan,
  sources: PlanSource[],
  options: { statuses?: SourceStatus[] } = {},
): PlanWarning[] {
  const notes: PlanWarning[] = [];
  const stats = planStats(plan, sources.length);

  if (plan.length === 0) {
    notes.push({
      tone: 'danger',
      text: 'This plan has 0 output pages — every page was removed, so saving would produce an empty PDF.',
    });
    return notes;
  }
  if (stats.pages === 0) {
    notes.push({
      tone: 'warn',
      text: `All ${stats.blanks} output page${stats.blanks === 1 ? ' is' : 's are'} blank sheet${
        stats.blanks === 1 ? '' : 's'
      }: nothing from a document would be in the result.`,
    });
  }

  const missing: string[] = [];
  for (const item of plan) {
    if (item.kind !== 'page') continue;
    const source = sources[item.source];
    if (!source) {
      missing.push(`file ${item.source + 1} is no longer open`);
    } else if (item.page >= source.pages) {
      missing.push(`page ${item.page + 1} of “${source.name}”, which has ${source.pages}`);
    }
  }
  if (missing.length > 0) {
    notes.push({
      tone: 'danger',
      text: `${missing.length} planned page${missing.length === 1 ? '' : 's'} refer${
        missing.length === 1 ? 's' : ''
      } to a document that changed (${[...new Set(missing)].slice(0, 2).join('; ')}). Remove them or press Reset order.`,
    });
  }

  const statuses = options.statuses ?? [];
  const locked = statuses.filter((status) => status === 'locked').length;
  const broken = statuses.filter((status) => status === 'error').length;
  if (locked > 0) {
    notes.push({
      tone: 'warn',
      text: `${locked} open file${locked === 1 ? ' is' : 's are'} password locked and cannot contribute pages until it is unlocked.`,
    });
  }
  if (broken > 0) {
    notes.push({
      tone: 'warn',
      text: `${broken} open file${broken === 1 ? '' : 's'} could not be previewed; pages from ${
        broken === 1 ? 'it' : 'them'
      } may fail to build.`,
    });
  }

  if (stats.pages > 0 && stats.distinct < stats.pages) {
    notes.push({
      tone: 'info',
      text: `${stats.pages - stats.distinct} page${
        stats.pages - stats.distinct === 1 ? '' : 's'
      } in this plan duplicate${stats.pages - stats.distinct === 1 ? 's' : ''} another — the output repeats them on purpose.`,
    });
  }
  if (sources.length === 1 && sources[0].pages === 1) {
    notes.push({
      tone: 'info',
      text: 'The document has one page, so reordering can only duplicate it or add blank sheets around it.',
    });
  }
  return notes;
}

/** True when the plan is exactly the untouched page order of `source`. */
export function isPristinePlan(plan: Plan, sources: PlanSource[], source = 0): boolean {
  const base = defaultPlan(sources, source);
  if (base.length !== plan.length) return false;
  return base.every((item, index) => sameItem(plan[index], item));
}

/** Whether two plans are equal in content (the reducer uses this to skip
 *  no-op commits, so an arrow key at the end of the list is not an undo point
 *  and nothing announces "Moved" when nothing moved). */
export function samePlan(a: Plan, b: Plan): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((item, index) => sameItem(item, b[index]));
}

export function sameItem(a: PlanItem | undefined, b: PlanItem): boolean {
  if (!a) return false;
  if (a.kind === 'blank' || b.kind === 'blank') return a.kind === b.kind;
  return a.source === b.source && a.page === b.page && a.rotate === b.rotate;
}

/**
 * What one planned slot is, in the words the pane says out loud.
 *
 * Positions and page numbers are 1-based here, because every caller feeds a
 * live region or a `srcLabel`.
 */
export function describeItem(plan: Plan, index: number, sources: PlanSource[]): string {
  const item = plan[index];
  if (!item) return `position ${index + 1}`;
  if (item.kind === 'blank') return `the blank sheet at position ${index + 1}`;
  const name = sources[item.source]?.name ?? `file ${item.source + 1}`;
  return `${name} page ${item.page + 1}`;
}

/** The accessible name of one card, including its 1-based position. */
export function cardLabel(
  plan: Plan,
  index: number,
  sources: PlanSource[],
  total = plan.length,
): string {
  const item = plan[index];
  if (!item) return `position ${index + 1} of ${total}`;
  const where = `position ${index + 1} of ${total}`;
  if (item.kind === 'blank') return `Blank sheet, ${where}`;
  const name = sources[item.source]?.name ?? `file ${item.source + 1}`;
  const turn = item.rotate ? `, rotated ${item.rotate} degrees` : '';
  return `${name} page ${item.page + 1}${turn}, ${where}`;
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
