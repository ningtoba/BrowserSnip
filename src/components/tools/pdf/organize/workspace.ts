/**
 * The page organizer's workspace reducer — the layer EmbedPDF leaves to the
 * application, modelled on Stirling-PDF's `trackWorkspaceReducer.ts`: one pure
 * function over an immutable plan, with undo/redo inside it, and every gesture
 * (pointer drag, keyboard carry, button, plan text) expressed as an action.
 *
 * Why it is separate from the component: the drag-and-drop and keyboard rules
 * are the whole experience of this pane, and jsdom has neither canvas nor real
 * drag events. Keeping them here means `tests/pdf/ux-organize.test.ts` can
 * assert the *transitions* — what a Shift-range selects, which gap a drop lands
 * in, what a keystroke costs in re-renders — without a browser.
 *
 * The rules this module exists to enforce:
 *
 * 1. **One selection, many actions.** Every mutating action resolves to
 *    `targets()` — the whole selection when the acted-on card is in it, the
 *    clicked card alone otherwise, nothing otherwise (and "nothing" is answered
 *    with a reason, never silence).
 * 2. **A drag is a gap, not a swap.** The visible state during a drag is
 *    `gap`: an insertion index into the plan as it stands (0…plan.length).
 *    Exactly one card renders the indicator for a gap, so a landing position is
 *    never drawn twice. Releasing outside the grid dispatches `dragEnd`, which
 *    clears the drag and leaves the plan byte-identical.
 * 3. **Keyboard-only reordering.** Space picks the selection up, arrows move the
 *    gap, Space drops it, Escape cancels. It is the same reducer path as a mouse
 *    drag, so both agree.
 * 4. **History is per document.** `histories[docKey]` survives loading another
 *    PDF and coming back (E19), and every entry carries the sentence that
 *    describes it so undo can be announced to assistive tech.
 * 5. **A change that changes nothing is not an undo point.** `samePlan` guards
 *    every commit, so an arrow key at the end of the list neither reorders nor
 *    claims to.
 */
import {
  canRedo,
  canUndo,
  createHistory,
  pushHistory,
  redoHistory,
  undoHistory,
  type HistoryState,
} from '@/components/tools/pdf/editor/history';
import { historyCommandForKey, isTypingTarget } from '@/components/tools/pdf/editor/shortcuts';
import type { Shortcut } from '@/components/tools/pdf/editor/shortcuts';
import {
  cardLabel,
  defaultPlan,
  deletePlanItems,
  duplicatePlanItems,
  insertBlanksAfter,
  insertPagesFrom,
  parsePageOrder,
  planWarnings,
  rotatePlanItems,
  samePlan,
  type Plan,
  type PlanItem,
  type PlanRotation,
  type PlanSource,
  type SourceStatus,
} from './plan';
import { previewBox, sizeKey, type PageSize, type PreviewBox } from './preview';

// ── selection ───────────────────────────────────────────────────────────────

export type SelectMode = 'single' | 'toggle' | 'range';

export interface Selection {
  /** Sorted, de-duplicated 0-based plan slots. */
  readonly indexes: readonly number[];
  /** The anchor a Shift-range grows from. */
  readonly anchor: number | null;
}

export const EMPTY_SELECTION: Selection = { indexes: [], anchor: null };

export function sortedUnique(indexes: readonly number[]): number[] {
  return [...new Set(indexes)].sort((a, b) => a - b);
}

export function isSelected(selection: Selection, index: number): boolean {
  return selection.indexes.includes(index);
}

export function selectionSize(selection: Selection): number {
  return selection.indexes.length;
}

function inRange(index: number, count: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < count;
}

/**
 * Apply a pointer/keyboard selection to `index`.
 *
 * `range` is Shift: contiguous from the anchor, replacing the previous range but
 * keeping the anchor, so pressing Shift and walking the arrows paints a block.
 * `toggle` is Cmd/Ctrl-click: adds or removes one card and re-anchors there.
 */
export function selectIndex(
  selection: Selection,
  index: number,
  mode: SelectMode,
  count: number,
): Selection {
  if (!inRange(index, count)) return selection;
  if (mode === 'single') return { indexes: [index], anchor: index };
  if (mode === 'toggle') {
    const has = isSelected(selection, index);
    const indexes = has
      ? selection.indexes.filter((i) => i !== index)
      : sortedUnique([...selection.indexes, index]);
    return { indexes, anchor: index };
  }
  const anchor = selection.anchor ?? index;
  const [from, to] = anchor <= index ? [anchor, index] : [index, anchor];
  const span: number[] = [];
  for (let i = from; i <= to; i += 1) span.push(i);
  return { indexes: span, anchor };
}

/** Drop slots that no longer exist (after a delete, or a shorter plan). */
export function clampSelection(selection: Selection, count: number): Selection {
  const indexes = selection.indexes.filter((i) => inRange(i, count));
  const anchor = selection.anchor !== null && inRange(selection.anchor, count) ? selection.anchor : null;
  if (indexes.length === selection.indexes.length && anchor === selection.anchor) return selection;
  return { indexes, anchor };
}

export function selectAllIndexes(count: number): Selection {
  return { indexes: Array.from({ length: count }, (_, i) => i), anchor: 0 };
}

// ── gaps: where a drop lands ────────────────────────────────────────────────

export type DragPayload =
  | { kind: 'plan'; indexes: number[] }
  | { kind: 'source'; source: number; page: number };

/** Clamp an insertion position into `0 … plan.length`. */
export function clampGap(gap: number, plan: Plan): number {
  if (!Number.isFinite(gap)) return 0;
  return Math.max(0, Math.min(plan.length, Math.round(gap)));
}

/**
 * Where the lifted cards actually end up: the insertion index into the plan
 * *after* they have been taken out. Reporting this is what lets the indicator
 * say "drop at 7" and have the card land at 7.
 */
export function landingIndex(plan: Plan, indexes: readonly number[], gap: number): number {
  const lifted = sortedUnique(indexes);
  const before = lifted.filter((i) => i < gap).length;
  return Math.max(0, Math.min(plan.length - lifted.length, gap - before));
}

/**
 * Move every card in `indexes` so the group starts at `gap`'s landing position,
 * preserving their relative order. Non-contiguous selections move as one block,
 * which is what a multi-select drag should feel like.
 *
 * With one index this is `movePlanItem`, so the single-card path has one
 * definition rather than two.
 */
export function movePlanItems(plan: Plan, indexes: readonly number[], gap: number): { plan: Plan; at: number } {
  const lifted = sortedUnique(indexes).filter((i) => inRange(i, plan.length));
  if (lifted.length === 0) return { plan, at: clampGap(gap, plan) };
  const items = lifted.map((i) => plan[i]);
  const rest = plan.filter((_, i) => !lifted.includes(i));
  const at = landingIndex(plan, lifted, clampGap(gap, plan));
  return { plan: [...rest.slice(0, at), ...items.map((item) => ({ ...item })), ...rest.slice(at)], at };
}

/** A gap is only worth drawing while something is being carried into it. */
export function gapTarget(plan: Plan, lifted: readonly number[], gap: number | null): number | null {
  if (gap === null || lifted.length === 0) return null;
  return landingIndex(plan, lifted, gap) + 1;
}

/** True for a gap strictly between two carried cards: the group cannot land there. */
function gapInsideRun(lifted: readonly number[], gap: number): boolean {
  if (lifted.length < 2) return false;
  const first = Math.min(...lifted);
  const last = Math.max(...lifted);
  return gap > first && gap <= last;
}

/**
 * The gap that means "land at this position", used by the keyboard carry.
 *
 * Two neighbouring gaps can describe the same landing spot (the one just before
 * a carried card and the one just after it), so arrows would need two presses to
 * move one slot. This returns the first gap that reaches `landing`, skipping the
 * ones inside the carried run, which makes one arrow press one position.
 */
export function gapForLanding(plan: Plan, lifted: readonly number[], landing: number): number {
  const run = sortedUnique(lifted);
  for (let gap = 0; gap <= plan.length; gap += 1) {
    if (gapInsideRun(run, gap)) continue;
    if (landingIndex(plan, run, gap) === landing) return gap;
  }
  return clampGap(landing, plan);
}

export interface ElementRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Which insertion gap a pointer sits over, given one card's box.
 *
 * Measured from the card's centre along whichever axis the pointer is further
 * past, so a wrapped grid resolves the same way a single row does — the bug
 * Stirling's "Fix drag and drop indicator on tracks" commit is about.
 */
export function gapForCardPoint(
  rect: ElementRect,
  index: number,
  point: { x: number; y: number },
): number {
  const dx = point.x - (rect.left + rect.width / 2);
  const dy = point.y - (rect.top + rect.height / 2);
  const after = Math.abs(dx) >= Math.abs(dy) ? dx > 0 : dy > 0;
  return after ? index + 1 : index;
}

/**
 * The gap for a drop in the grid container rather than on a card: below the last
 * row, or to the right of the last card, means "after everything" — the oversized
 * end-of-list drop zone that makes dropping at the end easy (Stirling PR #2466).
 * `null` means the pointer is over used space, so the card under it decides.
 */
export function gapForGridPoint(
  grid: ElementRect,
  lastCard: ElementRect | null,
  count: number,
  point: { x: number; y: number },
): number | null {
  if (point.x < grid.left || point.x > grid.left + grid.width) return null;
  if (point.y < grid.top || point.y > grid.top + grid.height) return null;
  if (!lastCard) return count;
  if (point.y > lastCard.top + lastCard.height) return count;
  if (point.x > lastCard.left + lastCard.width) return count;
  return null;
}

// ── the window that is worth drawing (E7) ───────────────────────────────────

export interface WindowInput {
  count: number;
  columns: number;
  rowHeight: number;
  scrollTop: number;
  viewportHeight: number;
  /** Extra rows kept on each side so a fast scroll never shows the void. */
  overscanRows?: number;
  /** jsdom reports a 0-height viewport; keep a real floor so tests see cards. */
  minRows?: number;
  /** Hard ceiling on rendered cards, however tall the window is. */
  maxItems?: number;
}

export interface WindowRange {
  start: number;
  end: number;
  padTop: number;
  padBottom: number;
  hiddenBefore: number;
  hiddenAfter: number;
}

/**
 * The slice of the plan to mount.
 *
 * A 500-page document is ~500 thumbnails plus ~3500 buttons; mounting all of
 * them turns every keystroke into a full-grid reconciliation. This keeps the
 * mounted set bounded and independent of `count`, which is the part a test can
 * check without a browser.
 */
export function renderWindow(input: WindowInput): WindowRange {
  const columns = Math.max(1, Math.floor(input.columns));
  if (input.count <= 0) {
    return { start: 0, end: 0, padTop: 0, padBottom: 0, hiddenBefore: 0, hiddenAfter: 0 };
  }
  const rowHeight = Math.max(1, input.rowHeight);
  const overscan = Math.max(0, input.overscanRows ?? 2);
  const minRows = Math.max(1, input.minRows ?? 4);
  const maxItems = Math.max(columns, input.maxItems ?? 120);
  const maxRows = Math.max(1, Math.floor(maxItems / columns));
  const rows = Math.ceil(Math.max(0, input.count) / columns);
  const visibleRows = Math.max(
    minRows,
    Math.ceil(Math.max(0, input.viewportHeight) / rowHeight) + overscan * 2,
  );
  const mountedRows = Math.min(maxRows, rows, visibleRows);
  const firstRow = Math.max(
    0,
    Math.min(rows - mountedRows, Math.floor(Math.max(0, input.scrollTop) / rowHeight) - overscan),
  );
  const lastRow = firstRow + mountedRows;
  const start = firstRow * columns;
  const end = Math.min(Math.max(0, input.count), lastRow * columns);
  return {
    start,
    end,
    padTop: firstRow * rowHeight,
    padBottom: Math.max(0, (rows - lastRow) * rowHeight),
    hiddenBefore: start,
    hiddenAfter: Math.max(0, Math.max(0, input.count) - end),
  };
}

// ── card projection (what the grid mounts, and what may re-render) ──────────

export interface CardModel {
  key: string;
  index: number;
  /** 1-based position badge. */
  position: number;
  kind: 'page' | 'blank';
  source: number;
  page: number;
  /** 1-based source page for the on-card label (blanks: 0, unused). */
  sourcePage: number;
  rotate: PlanRotation;
  sourcePages: number;
  /** Name of the file this page came from, for the card's tooltip. */
  sourceName: string;
  selected: boolean;
  /** How many cards share this one's selection, for button titles (0 when unselected). */
  groupSize: number;
  lifted: boolean;
  focused: boolean;
  gapBefore: boolean;
  gapAfter: boolean;
  /** 1-based position the lifted cards would land at, on the indicator badge. */
  gapTarget: number | null;
  thumb: string | undefined;
  preview: PreviewBox;
  label: string;
}

export interface CardModelOptions {
  /** Thumbnail data URL for a source page, `undefined` while it renders. */
  thumbFor: (source: number, page: number) => string | undefined;
  /** Intrinsic thumbnail sizes the browser has reported so far (E8). */
  sizes?: Record<string, PageSize>;
  slot?: PageSize;
}

export function liftedIndexes(state: WorkspaceState): number[] {
  if (state.drag?.kind === 'plan') return state.drag.indexes;
  return state.carrying ? [...state.carrying] : [];
}

/**
 * Project the plan into the props each card needs.
 *
 * The flat, primitive shape is deliberate: `cardModelsEqual` can then decide
 * "this card did not change" without touching React, and the E7 test counts the
 * cards a keystroke actually dirties.
 */
export function cardModels(state: WorkspaceState, options: CardModelOptions): CardModel[] {
  const { plan, sources } = state;
  const lifted = liftedIndexes(state);
  const liftedSet = new Set(lifted);
  const gap = state.gap;
  const target = gapTarget(plan, lifted, gap);
  const focusIndex = state.focused ?? state.selection.anchor ?? 0;
  /** One card owns the indicator for a gap, and only that card carries the
   *  landing number — otherwise every card in the grid dirties each time the
   *  drag pointer crosses a boundary. */
  const gapOwner =
    gap === null
      ? -1
      : gap < plan.length
        ? gap
        : plan.length > 0
          ? plan.length - 1
          : -1;
  return plan.map((item, index) => {
    const page = item.kind === 'page' ? item.page : -1;
    const source = item.kind === 'page' ? item.source : -1;
    const natural = item.kind === 'page' ? options.sizes?.[sizeKey(source, page)] : undefined;
    return {
      key: `slot-${index}`,
      index,
      position: index + 1,
      kind: item.kind,
      source,
      page,
      sourcePage: item.kind === 'page' ? item.page + 1 : 0,
      rotate: item.kind === 'page' ? item.rotate : 0,
      sourcePages: item.kind === 'page' ? (sources[item.source]?.pages ?? 0) : 0,
      sourceName: item.kind === 'page' ? (sources[item.source]?.name ?? `file ${item.source + 1}`) : '',
      selected: isSelected(state.selection, index),
      groupSize: isSelected(state.selection, index) ? state.selection.indexes.length : 0,
      lifted: liftedSet.has(index),
      focused: focusIndex === index,
      gapBefore: gap !== null && gap === index && gap < plan.length,
      gapAfter: gap !== null && plan.length > 0 && gap === plan.length && index === plan.length - 1,
      gapTarget: index === gapOwner ? target : null,
      thumb: item.kind === 'page' ? options.thumbFor(source, page) : undefined,
      preview: previewBox(natural, item.kind === 'page' ? item.rotate : 0, options.slot),
      label: cardLabel(plan, index, sources),
    };
  });
}

/** Props equality for the memoized card — everything React would re-draw. */
export function cardModelsEqual(a: CardModel, b: CardModel): boolean {
  if (a === b) return true;
  return (
    a.key === b.key &&
    a.index === b.index &&
    a.position === b.position &&
    a.kind === b.kind &&
    a.source === b.source &&
    a.page === b.page &&
    a.sourcePage === b.sourcePage &&
    a.rotate === b.rotate &&
    a.sourcePages === b.sourcePages &&
    a.sourceName === b.sourceName &&
    a.selected === b.selected &&
    a.groupSize === b.groupSize &&
    a.lifted === b.lifted &&
    a.focused === b.focused &&
    a.gapBefore === b.gapBefore &&
    a.gapAfter === b.gapAfter &&
    a.gapTarget === b.gapTarget &&
    a.thumb === b.thumb &&
    a.label === b.label &&
    a.preview.boxWidth === b.preview.boxWidth &&
    a.preview.boxHeight === b.preview.boxHeight &&
    a.preview.imageWidth === b.preview.imageWidth &&
    a.preview.imageHeight === b.preview.imageHeight &&
    a.preview.rotation === b.preview.rotation &&
    a.preview.measured === b.preview.measured
  );
}

/** How many cards differ between two projections — the E7 assertion. */
export function changedCardCount(a: CardModel[], b: CardModel[]): number {
  if (a.length !== b.length) return Math.max(a.length, b.length);
  let changed = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (!cardModelsEqual(a[i], b[i])) changed += 1;
  }
  return changed;
}

// ── refusal (E13) ───────────────────────────────────────────────────────────

/**
 * Why this plan cannot be built right now, in one sentence — or `null` when it
 * can. `Save` and `Run` read this, so a disabled button always has a reason next
 * to it, and a plan of zero output pages is refused instead of downloaded.
 */
export function planRefusal(
  plan: Plan,
  sources: PlanSource[],
  statuses: SourceStatus[] = [],
): string | null {
  if (sources.length === 0) return 'No document is open, so there is nothing to build.';
  if (plan.length === 0) {
    const loading = statuses.some((s) => s === 'loading') || sources.every((s) => s.pages === 0);
    return loading
      ? 'Waiting for the first page to render before this plan can be built.'
      : 'This plan has 0 output pages: every page was removed, so the result would be an empty PDF.';
  }
  const blocked = planWarnings(plan, sources, { statuses }).find((note) => note.tone === 'danger');
  return blocked ? blocked.text : null;
}

// ── per-document identity (E19) ─────────────────────────────────────────────

/**
 * Identity of the open document set: names and byte sizes, *not* page counts.
 * Page counts arrive a tick later with the preview, and an identity that changed
 * when they did would wipe the plan the user is mid-way through editing.
 */
export function documentKey(files: readonly { name: string; size: number }[]): string {
  return files.map((f) => `${f.name}:${f.size}`).join('|');
}

export interface SaveToken {
  docKey: string;
  revision: number;
  pages: number;
}

/** What the plan was when a save started. */
export function saveToken(state: WorkspaceState): SaveToken {
  return { docKey: state.docKey, revision: state.revision, pages: state.plan.length };
}

/**
 * True when the documents or the plan moved while a save was in flight, so its
 * result must be thrown away rather than downloaded as if it were current (E19).
 */
export function saveIsStale(started: SaveToken, now: WorkspaceState): boolean {
  return started.docKey !== now.docKey || started.revision !== now.revision;
}

// ── state and actions ───────────────────────────────────────────────────────

export interface PlanSnapshot {
  plan: Plan;
  /** Past-tense phrase: "removed 3 pages". Undo says this out loud. */
  label: string;
}

export interface WorkspaceState {
  docKey: string;
  sources: PlanSource[];
  statuses: SourceStatus[];
  plan: Plan;
  selection: Selection;
  focused: number | null;
  gap: number | null;
  drag: DragPayload | null;
  /** Slots picked up with Space; the pointer drag carries `drag` instead. */
  carrying: number[] | null;
  histories: Record<string, HistoryState<PlanSnapshot>>;
  /** Last sentence for the live region. */
  status: string;
  /** Why the plan cannot be built (E13); null when it can. */
  refusal: string | null;
  /** A rejected plan string or page range, in the field's own words. */
  inputError: string | null;
  revision: number;
}

export const IDLE_STATUS =
  'Click a page to select it, Shift or Cmd-click for more, then Space to pick the selection up, the arrow keys to choose the gap, Space to drop it. Delete removes, R rotates, D duplicates, B adds a blank sheet, and Ctrl+Z undoes.';

export function initialWorkspace(): WorkspaceState {
  return {
    docKey: '',
    sources: [],
    statuses: [],
    plan: [],
    selection: EMPTY_SELECTION,
    focused: null,
    gap: null,
    drag: null,
    carrying: null,
    histories: {},
    status: IDLE_STATUS,
    refusal: planRefusal([], []),
    inputError: null,
    revision: 0,
  };
}

export type WorkspaceAction =
  | { type: 'sync'; docKey: string; sources: PlanSource[]; statuses: SourceStatus[] }
  | { type: 'select'; index: number; mode?: SelectMode }
  | { type: 'selectAll' }
  | { type: 'clearSelection' }
  | { type: 'focusTo'; index: number }
  | { type: 'focusCard'; index: number }
  | { type: 'focusMove'; delta: number; extend?: boolean }
  | { type: 'dragStart'; payload: DragPayload }
  | { type: 'dragOver'; gap: number }
  | { type: 'dragEnd' }
  | { type: 'drop'; gap: number }
  | { type: 'pickUp'; index?: number }
  | { type: 'carryMove'; delta: number }
  | { type: 'dropCarry' }
  | { type: 'cancelCarry' }
  | { type: 'nudge'; index?: number; delta: number }
  | { type: 'rotate'; index?: number; delta: number }
  | { type: 'duplicate'; index?: number }
  | { type: 'remove'; index?: number }
  | { type: 'insertBlank'; index?: number }
  | { type: 'insertPages'; source: number; pages: number[]; gap?: number }
  | { type: 'useAsBase'; source: number }
  | { type: 'resetOrder' }
  | { type: 'applyPlanText'; spec: string }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'announce'; message: string };

const countText = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

const outputLine = (plan: Plan): string => `Plan is ${countText(plan.length, 'output page')}.`;

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function rotateLabel(delta: number): string {
  const turn = normaliseDelta(delta);
  if (turn === 180) return 'rotated 180°';
  return `rotated ${turn}° ${turn === 90 ? 'clockwise' : 'counter-clockwise'}`;
}

function normaliseDelta(delta: number): number {
  const turn = ((Math.round(delta / 90) * 90) % 360 + 360) % 360;
  return turn > 180 ? turn - 360 : turn;
}

/** The cards an action applies to: the whole selection when `index` is in it. */
function targets(state: WorkspaceState, index?: number): number[] {
  if (index !== undefined && index >= 0 && index < state.plan.length) {
    if (isSelected(state.selection, index)) return [...state.selection.indexes];
    return [index];
  }
  return [...state.selection.indexes];
}

/**
 * The selection to leave behind after an action that named a card.
 *
 * Pressing a card's own Rotate when it is not part of the selection acts on that
 * card (see `targets`), so the selection has to follow it — otherwise the next
 * Delete silently hits the previous group instead of what the user just turned.
 */
function selectionAfterTarget(state: WorkspaceState, indexes: number[], index?: number): Selection {
  if (index === undefined || isSelected(state.selection, index)) return state.selection;
  return { indexes: sortedUnique(indexes), anchor: index };
}

function nothingSelected(state: WorkspaceState, verb: string): WorkspaceState {
  return {
    ...state,
    status: `Nothing is selected, so there is nothing to ${verb}. Click a page, or press Ctrl+A for all ${countText(state.plan.length, 'page')}.`,
  };
}

/** Apply a committed plan change: history, selection clamp, refusal, announcement. */
function commit(
  state: WorkspaceState,
  next: Plan,
  label: string,
  options: {
    selection?: Selection;
    focused?: number | null;
    clearCarry?: boolean;
    quiet?: string;
  } = {},
): WorkspaceState {
  const current = state.histories[state.docKey] ?? createHistory<PlanSnapshot>({ plan: state.plan, label: 'opened the plan' });
  if (samePlan(next, state.plan)) {
    return {
      ...state,
      histories: { ...state.histories, [state.docKey]: current },
      carrying: options.clearCarry ? null : state.carrying,
      drag: options.clearCarry ? null : state.drag,
      gap: options.clearCarry ? null : state.gap,
      status: options.quiet ?? state.status,
    };
  }
  const history = pushHistory(current, { plan: next, label });
  const selection = clampSelection(options.selection ?? state.selection, next.length);
  const focused =
    options.focused === undefined
      ? selection.indexes[selection.indexes.length - 1] ?? state.focused
      : options.focused === null
        ? state.focused
        : options.focused;
  return {
    ...state,
    plan: next,
    histories: { ...state.histories, [state.docKey]: history },
    selection,
    focused: focused !== null && focused < next.length ? focused : next.length > 0 ? next.length - 1 : null,
    carrying: options.clearCarry ? null : state.carrying,
    drag: options.clearCarry ? null : state.drag,
    gap: options.clearCarry ? null : state.gap,
    status: capitalize(`${label}. ${outputLine(next)}`),
    refusal: planRefusal(next, state.sources, state.statuses),
    revision: state.revision + 1,
  };
}

function historyOf(state: WorkspaceState): HistoryState<PlanSnapshot> {
  return state.histories[state.docKey] ?? createHistory<PlanSnapshot>({ plan: state.plan, label: 'opened the plan' });
}

/** Re-seed after documents change without touching history of other docs. */
function openDocuments(
  state: WorkspaceState,
  docKey: string,
  sources: PlanSource[],
  statuses: SourceStatus[],
): WorkspaceState {
  const loaded = sources.some((s) => s.pages > 0);
  const existing = state.histories[docKey];
  if (existing) {
    // Coming back to a document keeps its own undo stack, including the redo
    // branch that was never taken (E19).
    const plan = existing.present.plan;
    return {
      ...state,
      docKey,
      sources,
      statuses,
      plan,
      selection: clampSelection(EMPTY_SELECTION, plan.length),
      focused: plan.length > 0 ? 0 : null,
      gap: null,
      drag: null,
      carrying: null,
      status: capitalize(`Reopened ${sources.map((s) => s.name).join(' + ') || 'the documents'}: ${countText(plan.length, 'planned page')}, ${existing.past.length > 0 ? `${existing.past.length} undo step${existing.past.length === 1 ? '' : 's'} still available` : 'no changes to undo'}.`),
      refusal: planRefusal(plan, sources, statuses),
      inputError: null,
    };
  }
  const plan = loaded ? defaultPlan(sources, 0) : [];
  if (!loaded) {
    // Nothing to seed yet: no history slot, so the `sync` that brings the page
    // count still counts as opening the document.
    return {
      ...state,
      docKey,
      sources,
      statuses,
      plan: [],
      selection: EMPTY_SELECTION,
      focused: null,
      gap: null,
      drag: null,
      carrying: null,
      status: 'Waiting for the first page to render…',
      refusal: planRefusal([], sources, statuses),
      inputError: null,
    };
  }
  const history = createHistory<PlanSnapshot>({ plan, label: 'opened the plan' });
  return {
    ...state,
    docKey,
    sources,
    statuses,
    plan,
    histories: { ...state.histories, [docKey]: history },
    selection: EMPTY_SELECTION,
    focused: plan.length > 0 ? 0 : null,
    gap: null,
    drag: null,
    carrying: null,
    status: plan.length > 0
      ? capitalize(`${countText(plan.length, 'page')} from ${sources.map((s) => s.name).join(' + ')} loaded. ${sources.length > 1 ? 'Drag pages in from the right, or pick a page and press D to duplicate it.' : 'Drag a page, or press Space then the arrow keys, to reorder.'}`)
      : 'Waiting for the first page to render…',
    refusal: planRefusal(plan, sources, statuses),
    inputError: null,
    revision: state.revision,
  };
}

export function organizerReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  const plan = state.plan;
  switch (action.type) {
    case 'sync': {
      const loaded = action.sources.some((s) => s.pages > 0);
      const known = state.histories[action.docKey];
      if (action.docKey !== state.docKey) {
        return openDocuments(state, action.docKey, action.sources, action.statuses);
      }
      // The file list resolves before pdf.js reports a page count. Until a page
      // exists there is nothing to seed and nothing to remember, so the document
      // stays "pending": registering a history slot here would freeze an empty
      // plan in place and the real pages would never appear.
      if (!known && loaded && plan.length === 0) {
        return openDocuments(state, action.docKey, action.sources, action.statuses);
      }
      const refusal = planRefusal(plan, action.sources, action.statuses);
      if (
        refusal === state.refusal &&
        action.statuses.length === state.statuses.length &&
        action.statuses.every((s, i) => s === state.statuses[i]) &&
        action.sources.length === state.sources.length &&
        action.sources.every((s, i) => s.pages === state.sources[i].pages && s.name === state.sources[i].name)
      ) {
        return state;
      }
      return { ...state, sources: action.sources, statuses: action.statuses, refusal };
    }

    case 'select': {
      const selection = selectIndex(state.selection, action.index, action.mode ?? 'single', plan.length);
      return { ...state, selection, focused: action.index, inputError: null };
    }

    case 'selectAll':
      if (plan.length === 0) return nothingSelected(state, 'select');
      return {
        ...state,
        selection: selectAllIndexes(plan.length),
        focused: state.focused ?? 0,
        status: `Selected all ${countText(plan.length, 'page')}.`,
      };

    case 'clearSelection':
      if (state.selection.indexes.length === 0) return state;
      return { ...state, selection: EMPTY_SELECTION, status: 'Selection cleared.' };

    case 'focusCard': {
      if (!inRange(action.index, plan.length)) return state;
      // Tabbing in selects nothing, so the first card a user reaches by Tab can
      // be deleted immediately; walking with arrows must not throw away a
      // Shift-range, so an existing selection is left alone here.
      const selection =
        state.selection.indexes.length === 0
          ? selectIndex(state.selection, action.index, 'single', plan.length)
          : state.selection;
      if (state.focused === action.index && selection === state.selection) return state;
      return { ...state, focused: action.index, selection };
    }

    case 'focusTo': {
      const target = action.index < 0 ? plan.length + action.index : action.index;
      if (!inRange(target, plan.length)) return state;
      const selection = selectIndex(state.selection, target, 'single', plan.length);
      return { ...state, focused: target, selection };
    }

    case 'focusMove': {
      if (plan.length === 0) return state;
      const from = state.focused ?? (action.delta < 0 ? plan.length : -1);
      const next = Math.max(0, Math.min(plan.length - 1, from + action.delta));
      if (next === state.focused) {
        return { ...state, status: action.delta < 0 ? 'That is the first page.' : 'That is the last page.' };
      }
      const selection = selectIndex(
        state.selection,
        next,
        action.extend ? 'range' : 'single',
        plan.length,
      );
      return { ...state, focused: next, selection };
    }

    case 'dragStart': {
      if (action.payload.kind === 'plan') {
        const indexes = sortedUnique(action.payload.indexes).filter((i) => inRange(i, plan.length));
        if (indexes.length === 0) return state;
        const gap = clampGap(Math.min(...indexes), plan);
        return {
          ...state,
          drag: { kind: 'plan', indexes },
          gap,
          selection: { indexes, anchor: indexes[0] },
          focused: indexes[0],
          status: `Dragging ${countText(indexes.length, 'page')}. A line shows the gap it will land in; release outside the grid to cancel.`,
        };
      }
      return {
        ...state,
        drag: action.payload,
        gap: clampGap(state.selection.indexes.length ? Math.max(...state.selection.indexes) + 1 : plan.length, plan),
        status: `Carrying page ${action.payload.page + 1} of ${state.sources[action.payload.source]?.name ?? `file ${action.payload.source + 1}`} — release it over the grid to insert, or anywhere else to cancel.`,
      };
    }

    case 'dragOver': {
      const gap = clampGap(action.gap, plan);
      if (gap === state.gap) return state;
      return { ...state, gap };
    }

    case 'dragEnd': {
      // Releasing outside the grid, or on a card that refused the drop: the plan
      // must not move, and the indicator must not haunt the grid.
      if (!state.drag) return state.gap === null ? state : { ...state, gap: null };
      return {
        ...state,
        drag: null,
        gap: state.carrying === null ? null : state.gap,
        status: 'Drop cancelled — the page order is unchanged.',
      };
    }

    case 'drop': {
      const gap = clampGap(action.gap, plan);
      if (state.drag?.kind === 'source') {
        const moved = insertPagesFrom(plan, gap, state.drag.source, [state.drag.page]);
        return commit(state, moved, `inserted page ${state.drag.page + 1} at position ${gap + 1}`, {
          selection: { indexes: [gap], anchor: gap },
          focused: gap,
          clearCarry: true,
        });
      }
      const lifted = liftedIndexes(state);
      if (lifted.length === 0) return { ...state, gap: null };
      return moveSelection(state, lifted, gap);
    }

    case 'pickUp': {
      const wanted = action.index ?? state.focused ?? state.selection.anchor ?? undefined;
      if (wanted === undefined || wanted < 0 || !inRange(wanted, plan.length)) {
        return nothingSelected(state, 'pick up');
      }
      const index = wanted;
      const indexes = isSelected(state.selection, index) ? [...state.selection.indexes] : [index];
      return {
        ...state,
        carrying: indexes,
        selection: { indexes, anchor: index },
        focused: index,
        gap: clampGap(Math.min(...indexes), plan),
        status: `Picked up ${describeTargets(plan, sourcesOf(state), indexes)}. Arrow keys choose the gap, Space drops it, Escape cancels.`,
      };
    }

    case 'carryMove': {
      if (!state.carrying) return state;
      const run = state.carrying;
      const maxLanding = Math.max(0, plan.length - run.length);
      const current = landingIndex(plan, run, state.gap ?? run[0]);
      const wanted = Math.max(0, Math.min(maxLanding, current + action.delta));
      if (wanted === current) {
        return {
          ...state,
          status:
            action.delta < 0
              ? 'The selection is already first — it cannot move earlier.'
              : 'The selection is already last — it cannot move later.',
        };
      }
      const gap = gapForLanding(plan, run, wanted);
      return { ...state, gap, status: `Drop at position ${wanted + 1} of ${countText(plan.length, 'page')}.` };
    }

    case 'dropCarry': {
      if (!state.carrying) return state;
      return moveSelection(state, state.carrying, clampGap(state.gap ?? 0, plan));
    }

    case 'cancelCarry': {
      if (!state.carrying && state.gap === null) return state;
      return {
        ...state,
        carrying: null,
        drag: null,
        gap: null,
        status: 'Move cancelled — the page order is unchanged.',
      };
    }

    case 'nudge': {
      const indexes = targets(state, action.index);
      if (indexes.length === 0) return nothingSelected(state, 'move');
      // Nudging counts in landed positions, not gaps: one press, one slot.
      const current = landingIndex(plan, indexes, Math.min(...indexes));
      const wanted = current + action.delta;
      if (wanted < 0) return { ...state, status: 'The selection already starts at the first page.' };
      if (wanted > plan.length - indexes.length) {
        return { ...state, status: 'The selection already ends at the last page.' };
      }
      return moveSelection(state, indexes, gapForLanding(plan, indexes, wanted));
    }

    case 'rotate': {
      const indexes = targets(state, action.index);
      if (indexes.length === 0) return nothingSelected(state, 'rotate');
      const turnable = indexes.filter((i) => plan[i]?.kind === 'page');
      if (turnable.length === 0) {
        return { ...state, status: 'A blank sheet has nothing to rotate — select a page instead.' };
      }
      const next = rotatePlanItems(plan, turnable, action.delta);
      if (samePlan(next, plan)) return { ...state, status: 'Rotation unchanged.' };
      const blankSkipped = indexes.length - turnable.length;
      return commit(state, next, `${rotateLabel(action.delta)} ${countText(turnable.length, 'page')}${blankSkipped ? ` (${blankSkipped} blank sheet${blankSkipped === 1 ? '' : 's'} skipped)` : ''}`, {
        selection: selectionAfterTarget(state, turnable, action.index),
      });
    }

    case 'duplicate': {
      const indexes = targets(state, action.index);
      if (indexes.length === 0) return nothingSelected(state, 'duplicate');
      const { plan: next, inserted } = duplicatePlanItems(plan, indexes);
      if (inserted.length === 0) return state;
      return commit(state, next, `duplicated ${countText(indexes.length, 'page')}`, {
        selection: { indexes: inserted, anchor: inserted[inserted.length - 1] },
        focused: inserted[inserted.length - 1],
      });
    }

    case 'remove': {
      const indexes = targets(state, action.index);
      if (indexes.length === 0) return nothingSelected(state, 'remove');
      const next = deletePlanItems(plan, indexes);
      const anchor = Math.min(Math.max(...indexes), next.length - 1);
      return commit(state, next, `removed ${countText(indexes.length, 'page')}`, {
        selection: anchor >= 0 ? { indexes: [anchor], anchor } : EMPTY_SELECTION,
        focused: anchor >= 0 ? anchor : null,        quiet: 'Nothing is selected to remove.',
      });
    }

    case 'insertBlank': {
      // `index: -1` means "in front of everything", which is how the empty grid
      // gets its first sheet.
      const indexes = action.index === -1 ? [] : targets(state, action.index);
      const after =
        action.index === -1 ? -1 : indexes.length > 0 ? Math.max(...indexes) : plan.length - 1;
      const next = insertBlanksAfter(plan, after, 1);
      const at = after + 1;
      return commit(state, next, 'inserted a blank sheet', {
        selection: { indexes: [at], anchor: at },
        focused: at,
      });
    }

    case 'insertPages': {
      if (action.pages.length === 0) {
        return { ...state, inputError: 'That page selection matched no page in this document.' };
      }
      const gap = clampGap(action.gap ?? (state.selection.indexes.length ? Math.max(...state.selection.indexes) + 1 : plan.length), plan);
      const next = insertPagesFrom(plan, gap, action.source, action.pages);
      const name = state.sources[action.source]?.name ?? `file ${action.source + 1}`;
      const last = gap + action.pages.length - 1;
      return commit(state, next, `inserted ${countText(action.pages.length, 'page')} from ${name} at position ${gap + 1}`, {
        selection: { indexes: [last], anchor: last },
        focused: last,
      });
    }

    case 'useAsBase': {
      const next = defaultPlan(state.sources, action.source);
      const name = state.sources[action.source]?.name ?? `file ${action.source + 1}`;
      return commit(state, next, `started over from ${name}`, {
        selection: EMPTY_SELECTION,
        focused: next.length > 0 ? 0 : null,
      });
    }

    case 'resetOrder': {
      const next = defaultPlan(state.sources, 0);
      if (samePlan(next, plan)) {
        return { ...state, status: 'The plan is already the original page order.', gap: null, carrying: null, drag: null };
      }
      return commit(state, next, 'reset to the original page order', {
        selection: EMPTY_SELECTION,
        focused: next.length > 0 ? 0 : null,
        clearCarry: true,
      });
    }

    case 'applyPlanText': {
      try {
        const next = parsePageOrder(action.spec, state.sources);
        return commit(state, next, 'loaded the plan from the page order field', {
          selection: EMPTY_SELECTION,
          focused: next.length > 0 ? 0 : null,
        });
      } catch (err) {
        return {
          ...state,
          inputError: err instanceof Error ? err.message : 'That page order could not be read.',
          status: 'The page order was not applied — the field still holds what you typed.',
        };
      }
    }

    case 'undo': {
      const history = historyOf(state);
      if (!canUndo(history)) {
        return { ...state, status: 'Nothing to undo yet for these documents.' };
      }
      const undone = history.present;
      const next = undoHistory(history);
      const plan = next.present.plan;
      return {
        ...state,
        plan,
        histories: { ...state.histories, [state.docKey]: next },
        selection: clampSelection(state.selection, plan.length),
        focused: state.focused !== null && state.focused < plan.length ? state.focused : null,
        gap: null,
        carrying: null,
        drag: null,
        status: `Undid ${undone.label}. ${outputLine(plan)}`,
        refusal: planRefusal(plan, state.sources, state.statuses),
        revision: state.revision + 1,
      };
    }

    case 'redo': {
      const history = historyOf(state);
      if (!canRedo(history)) {
        return { ...state, status: 'Nothing to redo for these documents.' };
      }
      const next = redoHistory(history);
      const plan = next.present.plan;
      return {
        ...state,
        plan,
        histories: { ...state.histories, [state.docKey]: next },
        selection: clampSelection(state.selection, plan.length),
        focused: state.focused !== null && state.focused < plan.length ? state.focused : null,
        gap: null,
        carrying: null,
        drag: null,
        status: `Redid ${next.present.label}. ${outputLine(plan)}`,
        refusal: planRefusal(plan, state.sources, state.statuses),
        revision: state.revision + 1,
      };
    }

    case 'announce':
      return { ...state, status: action.message };

    default:
      return state;
  }
}

function sourcesOf(state: WorkspaceState): PlanSource[] {
  return state.sources;
}

function describeTargets(plan: Plan, sources: PlanSource[], indexes: number[]): string {
  if (indexes.length === 1) return describeItemOrBlank(plan, indexes[0], sources);
  const first = describeItemOrBlank(plan, Math.min(...indexes), sources);
  const last = describeItemOrBlank(plan, Math.max(...indexes), sources);
  return `${countText(indexes.length, 'page')} from ${first} to ${last}`;
}

function describeItemOrBlank(plan: Plan, index: number, sources: PlanSource[]): string {
  const item: PlanItem | undefined = plan[index];
  if (!item) return `position ${index + 1}`;
  if (item.kind === 'blank') return `the blank sheet at position ${index + 1}`;
  const name = sources[item.source]?.name ?? `file ${item.source + 1}`;
  return `${name} page ${item.page + 1}`;
}

/** Shared commit path for every "move these slots to that gap" gesture. */
function moveSelection(state: WorkspaceState, indexes: number[], gap: number): WorkspaceState {
  const lifted = sortedUnique(indexes);
  const { plan: next, at } = movePlanItems(state.plan, lifted, gap);
  const moved = lifted.length === 1 && at === lifted[0];
  const selection: Selection = {
    indexes: lifted.map((_, i) => at + i),
    anchor: at + lifted.length - 1,
  };
  return commit(state, next, `moved ${describeTargets(state.plan, state.sources, lifted)} to position ${at + 1}`, {
    selection,
    focused: at + lifted.length - 1,
    clearCarry: true,
    quiet: moved
      ? `${countText(lifted.length, 'page')} ${lifted.length === 1 ? 'is' : 'are'} already at position ${at + 1}.`
      : undefined,
  });
}

// ── keyboard ────────────────────────────────────────────────────────────────

export interface KeyInfo {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  defaultPrevented?: boolean;
  target?: EventTarget | null;
}

/**
 * Stirling's guard, verbatim in intent: a child that already handled the key
 * wins, typing in a field wins, and a dialog or menu over the editor owns the
 * keys so a Delete cannot chew through pages behind an open popover.
 *
 * Inputs that take no typing (a card's own buttons, a checkbox, a radio) deliberately do
 * *not* suppress the map — Stirling's `NON_TEXT_INPUTS` exemption — because
 * "press Delete and the page goes" must still work after clicking a card button.
 */
const NON_TEXT_INPUT_TYPES = ['checkbox', 'radio', 'button', 'submit', 'image', 'reset'];

function takesTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  const type = typeof element?.getAttribute === 'function' ? element.getAttribute('type') : null;
  if (
    element?.tagName?.toUpperCase() === 'INPUT' &&
    type !== null &&
    NON_TEXT_INPUT_TYPES.includes(type.toLowerCase())
  ) {
    return false;
  }
  return isTypingTarget(target);
}

export function keysOwnTheOrganizer(event: KeyInfo): boolean {
  if (event.defaultPrevented) return false;
  const target = event.target ?? null;
  if (!target) return true;
  const element = target as Element;
  if (typeof element.closest === 'function' && element.closest('[role="dialog"], [role="menu"], [role="tooltip"]')) {
    return false;
  }
  return !takesTyping(target);
}

const isMod = (event: KeyInfo): boolean => Boolean(event.ctrlKey || event.metaKey);

/**
 * Decode one keypress on a page card into the action it runs.
 *
 * Returning the action (rather than calling anything) is what lets a test read
 * the keyboard map as state transitions, and lets the card, the grid and the
 * toolbar share one table.
 */
export function cardActionForKey(
  event: KeyInfo,
  context: { index: number; carrying: boolean; fromChild?: boolean },
): WorkspaceAction | null {
  const { index, carrying } = context;
  const key = event.key;
  const history = historyCommandForKey(key, { ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey });
  if (history) return { type: history };

  if (key === ' ' || key === 'Spacebar' || key === 'Enter') {
    // A focused card button owns activation keys; the card must not also pick
    // the page up when Space clicks the button.
    if (context.fromChild) return null;
    return carrying ? { type: 'dropCarry' } : { type: 'pickUp', index };
  }
  if (key === 'Escape') return carrying ? { type: 'cancelCarry' } : { type: 'clearSelection' };

  const backwards = key === 'ArrowLeft' || key === 'ArrowUp';
  const forwards = key === 'ArrowRight' || key === 'ArrowDown';
  if (backwards || forwards) {
    const delta = backwards ? -1 : 1;
    if (carrying) return { type: 'carryMove', delta };
    if (event.altKey) return { type: 'nudge', index, delta };
    return { type: 'focusMove', delta, extend: Boolean(event.shiftKey) };
  }
  if (key === 'Home') return { type: 'focusTo', index: 0 };
  if (key === 'End') return { type: 'focusTo', index: -1 };

  if (key === 'Delete' || key === 'Backspace') return { type: 'remove', index };

  if (isMod(event)) {
    const bare = key.length === 1 ? key.toLowerCase() : key;
    if (bare === 'a') return { type: 'selectAll' };
    if (bare === 'd') return context.fromChild ? null : { type: 'duplicate', index };
    if (bare === 'z') return { type: event.shiftKey ? 'redo' : 'undo' };
    return null;
  }
  if (event.altKey) return null;
  if (context.fromChild) return null;

  switch (key.length === 1 ? key.toLowerCase() : key) {
    case 'r':
      return { type: 'rotate', index, delta: event.shiftKey ? -90 : 90 };
    case 'd':
      return { type: 'duplicate', index };
    case 'b':
      return { type: 'insertBlank', index };
    default:
      return null;
  }
}

/**
 * The map the pane renders inside itself (the brief: "the shortcut list is
 * reachable from inside the surface, not only in docs"), and the source for the
 * live region's hint line.
 */
export const ORGANIZE_SHORTCUTS: Shortcut[] = [
  { keys: ['Space'], label: 'Pick up the selected pages, then pick them back down', group: 'pages' },
  { keys: ['←', '→'], label: 'Move the gap while carrying, or walk the selection', group: 'pages' },
  { keys: ['Shift', '←'], label: 'Extend the selection to the previous page', group: 'pages' },
  { keys: ['Alt', '←'], label: 'Move the selection one position earlier', group: 'pages' },
  { keys: ['Esc'], label: 'Cancel the carry, then clear the selection', group: 'pages' },
  { keys: ['Delete'], label: 'Remove every selected page', group: 'pages' },
  { keys: ['R'], label: 'Rotate the selection 90° clockwise', group: 'pages' },
  { keys: ['Shift', 'R'], label: 'Rotate the selection 90° counter-clockwise', group: 'pages' },
  { keys: ['D'], label: 'Duplicate the selection', group: 'pages' },
  { keys: ['B'], label: 'Insert a blank sheet after the selection', group: 'pages' },
  { keys: ['Ctrl', 'A'], label: 'Select every page in the plan', group: 'pages' },
  { keys: ['Ctrl', 'Z'], label: 'Undo the last change', group: 'pages' },
  { keys: ['Ctrl', 'Shift', 'Z'], label: 'Re-apply the change just undone', group: 'pages' },
  { keys: ['Ctrl', 'Y'], label: 'Redo, the Windows way', group: 'pages' },
];

/** `Ctrl+Shift+Z` renders as `Ctrl + Shift + Z`, matching the editor's list. */
export function formatOrganizeShortcut(shortcut: Shortcut): string {
  return shortcut.keys.join(' + ');
}

/** Whether undo/redo should be enabled, for the toolbar's `aria-disabled` copy. */
export function historyAvailability(state: WorkspaceState): { canUndo: boolean; canRedo: boolean } {
  const history = historyOf(state);
  return { canUndo: canUndo(history), canRedo: canRedo(history) };
}
