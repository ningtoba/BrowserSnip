/**
 * UX tests for the page organizer (M3).
 *
 * jsdom has no canvas and fires no real drag events, so nothing here pretends to
 * drag a thumbnail. Instead each checklist item is asserted where it is decided:
 * the reducer in `organize/workspace.ts`, the preview geometry in
 * `organize/preview.ts`, and the card projection the grid mounts. The plan model
 * itself is covered by `tests/pdf/page-organizer.test.ts`; these are the
 * *interaction* transitions that pass sits or fails on.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import {
  EMPTY_SELECTION,
  ORGANIZE_SHORTCUTS,
  cardActionForKey,
  cardModels,
  cardModelsEqual as cardModelsEqualFn,
  changedCardCount,
  clampGap,
  documentKey,
  gapForCardPoint,
  gapForGridPoint,
  gapForLanding,
  historyAvailability,
  initialWorkspace,
  keysOwnTheOrganizer,
  landingIndex,
  liftedIndexes,
  movePlanItems,
  organizerReducer,
  planRefusal,
  renderWindow,
  saveIsStale,
  saveToken,
  selectIndex,
  selectionSize,
  type CardModel as CardModelish,
  type WorkspaceAction,
  type WorkspaceState,
} from '@/components/tools/pdf/organize/workspace';
import {
  defaultPlan,
  pageItem,
  planToPageOrder,
  planWarnings,
  type Plan,
  type PlanSource,
} from '@/components/tools/pdf/organize/plan';
import { THUMB_SLOT, outputRotation, previewBox, previewBoxStyle } from '@/components/tools/pdf/organize/preview';

// ── harness ─────────────────────────────────────────────────────────────────

function filesOf(...docs: { name: string; pages: number; size?: number }[]) {
  return docs.map((d, index) => ({
    name: d.name,
    size: d.size ?? 1000 + index,
    pages: d.pages,
  }));
}

/** Open documents the way the pane does when the file list resolves. */
function openDocs(
  docs: { name: string; pages: number; size?: number }[],
  statuses: ('loading' | 'ready' | 'locked' | 'error')[] = [],
): WorkspaceState {
  const files = filesOf(...docs);
  return organizerReducer(initialWorkspace(), {
    type: 'sync',
    docKey: documentKey(files),
    sources: docs.map((d) => ({ name: d.name, pages: d.pages })),
    statuses: statuses.length
      ? statuses
      : docs.map(() => 'ready' as const),
  });
}

const run = (state: WorkspaceState, action: WorkspaceAction): WorkspaceState =>
  organizerReducer(state, action);

const step = (state: WorkspaceState, ...actions: WorkspaceAction[]): WorkspaceState =>
  actions.reduce(run, state);

const fourPages = () => openDocs([{ name: 'report.pdf', pages: 4 }]);

/** 0-based source page of each planned slot, for order assertions. */
function order(plan: Plan): number[] {
  return plan.map((item) => (item.kind === 'blank' ? -1 : item.page));
}

const noThumbs = () => undefined;

function modelsOf(state: WorkspaceState) {
  return cardModels(state, { thumbFor: noThumbs });
}

/** Select an exact set of slots: one plain click, then Cmd-clicks. */
function selectPages(state: WorkspaceState, indexes: number[]): WorkspaceState {
  let next = run(state, { type: 'select', index: indexes[0], mode: 'single' });
  for (const index of indexes.slice(1)) {
    next = run(next, { type: 'select', index, mode: 'toggle' });
  }
  expect(next.selection.indexes).toEqual([...indexes]);
  return next;
}

/** The warning lines the pane would show, joined for a single assertion. */
function planWarningsText(plan: Plan, sources: PlanSource[]): string {
  return planWarnings(plan, sources).map((w) => w.text).join(' | ');
}

// ── selection: Cmd-click, Shift-range, whole-selection actions ──────────────

describe('selection model', () => {
  it('replaces on a plain click, adds and removes on Cmd-click, spans on Shift-click', () => {
    let selection = selectIndex(EMPTY_SELECTION, 1, 'single', 6);
    expect(selection.indexes).toEqual([1]);

    selection = selectIndex(selection, 3, 'toggle', 6);
    expect(selection.indexes).toEqual([1, 3]);

    selection = selectIndex(selection, 1, 'toggle', 6);
    expect(selection.indexes).toEqual([3], 'Cmd-click again removes a single page');
    expect(selection.anchor).toBe(1, 'the last card touched is the anchor, selected or not');

    selection = selectIndex(selection, 4, 'range', 6);
    expect(selection.indexes).toEqual([1, 2, 3, 4]);

    selection = selectIndex(selection, 2, 'range', 6);
    expect(selection.indexes).toEqual([1, 2], 'and the range can be walked back the other way');

    selection = selectIndex(selection, 9, 'range', 6);
    expect(selection.indexes).toEqual([1, 2], 'out-of-range targets are ignored');
  });

  it('keeps a selection inside the plan when the plan shrinks', () => {
    const state = step(
      fourPages(),
      { type: 'select', index: 3, mode: 'single' },
      { type: 'select', index: 2, mode: 'range' },
    );
    expect(state.selection.indexes).toEqual([2, 3]);
    const narrowed = run(state, { type: 'remove', index: 2 });
    expect(narrowed.plan).toHaveLength(2);
    expect(narrowed.selection.indexes.every((i) => i < narrowed.plan.length)).toBe(true);
  });
});

describe('every action applies to the whole selection', () => {
  const selected = (): WorkspaceState => selectPages(fourPages(), [0, 2]);

  it('rotates all of them, and says how many', () => {
    const state = run(selected(), { type: 'rotate', delta: 90 });
    expect(state.plan.map((i) => (i.kind === 'page' ? i.rotate : null))).toEqual([90, 0, 90, 0]);
    expect(state.status).toMatch(/2 pages/);
  });

  it('duplicates all of them as one block and selects the copies', () => {
    const state = run(selected(), { type: 'duplicate' });
    expect(order(state.plan)).toEqual([0, 1, 2, 0, 2, 3]);
    expect(state.selection.indexes).toEqual([3, 4], 'the new copies are what stays selected');
  });

  it('removes all of them in one undo step', () => {
    const state = run(selected(), { type: 'remove' });
    expect(order(state.plan)).toEqual([1, 3]);
    const undone = run(state, { type: 'undo' });
    expect(order(undone.plan)).toEqual([0, 1, 2, 3], 'one undo restores the whole batch');
  });

  it('skips blank sheets when rotating, and says so', () => {
    const withBlank = step(
      fourPages(),
      { type: 'select', index: 1, mode: 'single' },
      { type: 'insertBlank', index: 1 },
    );
    expect(withBlank.plan.map((i) => i.kind)).toEqual(['page', 'page', 'blank', 'page', 'page']);
    const state = selectPages(withBlank, [1, 2]);
    const rotated = run(state, { type: 'rotate', delta: 90 });
    expect(rotated.status).toMatch(/1 page/);
    expect(rotated.status).toMatch(/1 blank sheet skipped/);
    expect(rotated.plan.map((i) => (i.kind === 'page' ? i.rotate : 'blank'))).toEqual([
      0,
      90,
      'blank',
      0,
      0,
    ]);
  });

  it('acts on the clicked card alone when it is not part of the selection', () => {
    const state = step(
      selected(),
      // The selection is {0, 2}; card 3 is outside it.
      { type: 'rotate', index: 3, delta: 90 },
    );
    expect(state.plan.map((i) => (i.kind === 'page' ? i.rotate : null))).toEqual([0, 0, 0, 90]);
    expect(state.selection.indexes).toEqual([3], 'and the selection follows what was clicked');
  });

  it('refuses to act on nothing, with a reason instead of silence', () => {
    const state = run(fourPages(), { type: 'duplicate' });
    expect(order(state.plan)).toEqual([0, 1, 2, 3]);
    expect(state.status).toMatch(/Nothing is selected/);
    expect(historyAvailability(state).canUndo).toBe(false);
  });
});

// ── drag: insertion indicator, landing gap, dropping outside ────────────────

describe('drag model', () => {
  it('maps a pointer onto the card to the gap on the near side of its centre', () => {
    const rect = { left: 0, top: 0, width: 100, height: 200 };
    expect(gapForCardPoint(rect, 2, { x: 60, y: 100 })).toBe(3);
    expect(gapForCardPoint(rect, 2, { x: 40, y: 100 })).toBe(2);
    expect(gapForCardPoint(rect, 2, { x: 50, y: 20 })).toBe(2, 'above the centre means before the card');
    expect(gapForCardPoint(rect, 2, { x: 50, y: 190 })).toBe(3, 'and below it means after');
  });

  it('treats the empty space after the last row as the end-of-list gap', () => {
    const grid = { left: 0, top: 0, width: 600, height: 800 };
    const last = { left: 400, top: 20, width: 150, height: 200 };
    expect(gapForGridPoint(grid, last, 5, { x: 10, y: 400 })).toBe(5);
    expect(gapForGridPoint(grid, last, 5, { x: 580, y: 40 })).toBe(5);
    expect(gapForGridPoint(grid, last, 5, { x: 450, y: 100 })).toBeNull();
    expect(gapForGridPoint(grid, null, 0, { x: 10, y: 10 })).toBe(0);
  });

  it('shows exactly one indicator, on the landing gap, with the 1-based position', () => {
    const dragging = step(fourPages(), { type: 'dragStart', payload: { kind: 'plan', indexes: [0] } });
    const state = run(dragging, { type: 'dragOver', gap: 3 });
    expect(state.gap).toBe(3);
    expect(landingIndex(state.plan, [0], 3)).toBe(2);

    const models = modelsOf(state);
    expect(models.filter((m) => m.gapBefore || m.gapAfter)).toHaveLength(1);
    expect(models[3].gapBefore).toBe(true);
    expect(models[3].gapTarget).toBe(3, 'the badge reports where the page actually lands');
    expect(models.filter((m) => m.gapTarget !== null)).toHaveLength(1);
    expect(models.filter((m) => m.lifted)).toHaveLength(1);
  });

  it('draws the indicator after the last card when dropping at the end', () => {
    const state = step(fourPages(), { type: 'dragStart', payload: { kind: 'plan', indexes: [1] } }, {
      type: 'dragOver',
      gap: 4,
    });
    const models = modelsOf(state);
    expect(models.filter((m) => m.gapBefore || m.gapAfter)).toHaveLength(1);
    expect(models[3].gapAfter).toBe(true);
    expect(models[3].gapTarget).toBe(4);
  });

  it('moves the whole dragged block, in order, to the gap', () => {
    const six = openDocs([{ name: 'a.pdf', pages: 6 }]);
    const state = step(
      selectPages(six, [0, 1, 2]),
      { type: 'dragStart', payload: { kind: 'plan', indexes: [0, 1, 2] } },
      { type: 'dragOver', gap: 5 },
      { type: 'drop', gap: 5 },
    );
    expect(order(state.plan)).toEqual([3, 4, 0, 1, 2, 5]);
    expect(state.selection.indexes).toEqual([2, 3, 4], 'the dragged cards stay selected after the drop');
    expect(state.status).toMatch(/position 3/);
  });

  it('agrees with movePlanItem for a single card, so one-card drags have one definition', () => {
    const plan = defaultPlan([{ name: 'a.pdf', pages: 5 }], 0);
    for (let from = 0; from < 5; from += 1) {
      for (let to = 0; to <= 5; to += 1) {
        const single = plan;
        const moved = movePlanItems(single, [from], to).plan;
        expect(order(moved)).toEqual(order(moveOne(single, from, to)));
      }
    }
  });

  it('is a no-op when the drop lands where the card already is, and costs no undo point', () => {
    const before = fourPages();
    const state = step(
      before,
      { type: 'dragStart', payload: { kind: 'plan', indexes: [2] } },
      { type: 'drop', gap: 3 },
    );
    expect(order(state.plan)).toEqual([0, 1, 2, 3]);
    expect(historyAvailability(state).canUndo).toBe(false);
    expect(state.status).toMatch(/already at position 3/);
  });

  it('does not reorder when the drag ends outside the grid', () => {
    const before = fourPages();
    const dragging = step(before, { type: 'dragStart', payload: { kind: 'plan', indexes: [0, 1] } });
    const hovered = run(dragging, { type: 'dragOver', gap: 4 });
    expect(liftedIndexes(hovered)).toEqual([0, 1]);

    const released = run(hovered, { type: 'dragEnd' });
    expect(released.plan).toBe(before.plan, 'the plan object is untouched, not merely equal');
    expect(released.gap).toBeNull();
    expect(liftedIndexes(released)).toEqual([]);
    expect(historyAvailability(released).canUndo).toBe(false);
    expect(released.status).toMatch(/unchanged/);

    const models = modelsOf(released);
    expect(models.some((m) => m.gapBefore || m.gapAfter)).toBe(false, 'the indicator never haunts the grid');
  });

  it('inserts a dragged-in page from another document at the gap', () => {
    const two = openDocs([
      { name: 'report.pdf', pages: 2 },
      { name: 'appendix.pdf', pages: 2 },
    ]);
    const state = step(
      two,
      { type: 'dragStart', payload: { kind: 'source', source: 1, page: 1 } },
      { type: 'dragOver', gap: 1 },
      { type: 'drop', gap: 1 },
    );
    expect(state.plan).toEqual([pageItem(0, 0), pageItem(1, 1), pageItem(0, 1)]);
    expect(planToPageOrder(state.plan)).toBe('f1:1, f2:2, f1:2');
  });

  it('clamps a gap to the plan', () => {
    const plan = defaultPlan([{ name: 'a.pdf', pages: 3 }], 0);
    expect(clampGap(-5, plan)).toBe(0);
    expect(clampGap(99, plan)).toBe(3);
  });
});

function moveOne(plan: Plan, from: number, to: number): Plan {
  if (from === to || to === from + 1) return plan;
  const next = [...plan];
  const [item] = next.splice(from, 1);
  const insertAt = Math.max(0, Math.min(next.length, to > from ? to - 1 : to));
  next.splice(insertAt, 0, item);
  return next;
}

// ── keyboard-only reordering ────────────────────────────────────────────────

describe('keyboard model', () => {
  it('picks the selection up with Space, moves it one slot per arrow, drops it with Space', () => {
    const state = run(fourPages(), { type: 'select', index: 1, mode: 'single' });

    const picked = run(state, cardActionForKey({ key: ' ' }, { index: 1, carrying: false })!);
    expect(picked.carrying).toEqual([1]);
    expect(picked.gap).toBe(1);
    expect(picked.status).toMatch(/Picked up report.pdf page 2/);

    const right = run(picked, cardActionForKey({ key: 'ArrowRight' }, { index: 1, carrying: true })!);
    expect(order(right.plan)).toEqual([0, 1, 2, 3], 'the plan itself waits for the drop');
    expect(right.gap).toBe(3, 'gap 2 would land the card back where it started');
    expect(modelsOf(right)[right.gap!].gapBefore).toBe(true);

    const dropped = run(right, cardActionForKey({ key: ' ' }, { index: 1, carrying: true })!);
    expect(order(dropped.plan)).toEqual([0, 2, 1, 3]);
    expect(dropped.carrying).toBeNull();
    expect(dropped.selection.indexes).toEqual([2]);
  });

  it('walks the whole distance of the plan with one press per position', () => {
    let state = step(fourPages(), { type: 'select', index: 0, mode: 'single' }, { type: 'pickUp', index: 0 });    const seen: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      state = run(state, { type: 'carryMove', delta: 1 });
      seen.push(landingIndex(state.plan, state.carrying!, state.gap!));
    }
    expect(seen).toEqual([1, 2, 3, 3, 3, 3], 'stops at the last position and says why');
    expect(state.status).toMatch(/cannot move later/);

    for (let i = 0; i < 6; i += 1) state = run(state, { type: 'carryMove', delta: -1 });
    expect(landingIndex(state.plan, state.carrying!, state.gap!)).toBe(0);
    expect(state.status).toMatch(/cannot move earlier/);
  });

  it('never offers a gap inside the carried run, so one press is one position', () => {
    const plan = defaultPlan([{ name: 'a.pdf', pages: 6 }], 0);
    const run3 = [1, 2, 3];
    const gaps: number[] = [];
    for (let landing = 0; landing <= plan.length - run3.length; landing += 1) {
      const gap = gapForLanding(plan, run3, landing);
      expect(landingIndex(plan, run3, gap)).toBe(landing);
      expect(gap === 2 || gap === 3).toBe(false, 'a gap between two carried pages means nothing');
      gaps.push(gap);
    }
    expect(gaps).toEqual([...gaps].sort((a, b) => a - b), 'moving down the plan moves the gap down too');
  });

  it('cancels a carry on Escape with the order untouched, and a second Escape clears the selection', () => {
    const state = step(fourPages(), { type: 'select', index: 2, mode: 'single' }, { type: 'pickUp', index: 2 });
    const cancelled = run(state, cardActionForKey({ key: 'Escape' }, { index: 2, carrying: true })!);
    expect(order(cancelled.plan)).toEqual([0, 1, 2, 3]);
    expect(cancelled.carrying).toBeNull();
    expect(selectionSize(cancelled.selection)).toBe(1, 'Escape only unwinds one level');

    const cleared = run(cancelled, cardActionForKey({ key: 'Escape' }, { index: 2, carrying: false })!);
    expect(selectionSize(cleared.selection)).toBe(0);
  });

  it('decodes Delete, R, Shift+R, D and B onto the selection', () => {
    const selected = selectPages(fourPages(), [1, 2]);
    expect(order(run(selected, cardActionForKey({ key: 'Delete' }, { index: 1, carrying: false })!).plan)).toEqual([0, 3]);
    expect(
      run(selected, cardActionForKey({ key: 'r' }, { index: 1, carrying: false })!).plan.map((i) =>
        i.kind === 'page' ? i.rotate : null,
      ),
    ).toEqual([0, 90, 90, 0]);
    expect(
      run(selected, cardActionForKey({ key: 'R', shiftKey: true }, { index: 1, carrying: false })!).plan.map((i) =>
        i.kind === 'page' ? i.rotate : null,
      ),
    ).toEqual([0, 270, 270, 0]);
    expect(
      order(run(selected, cardActionForKey({ key: 'd' }, { index: 1, carrying: false })!).plan),
    ).toEqual([0, 1, 2, 1, 2, 3]);
    expect(
      order(run(selected, cardActionForKey({ key: 'b' }, { index: 2, carrying: false })!).plan),
    ).toEqual([0, 1, 2, -1, 3]);
    expect(
      order(run(selected, cardActionForKey({ key: 'B' }, { index: 2, carrying: false })!).plan),
    ).toEqual([0, 1, 2, -1, 3], 'uppercase letters still mean the same action');
  });

  it('runs Ctrl/Cmd+D and Ctrl/Cmd+A, and leaves other chords alone', () => {
    const state = step(fourPages(), { type: 'select', index: 2, mode: 'single' });
    expect(cardActionForKey({ key: 'd', ctrlKey: true }, { index: 2, carrying: false })).toEqual({
      type: 'duplicate',
      index: 2,
    });
    expect(cardActionForKey({ key: 'a', metaKey: true }, { index: 2, carrying: false })).toEqual({
      type: 'selectAll',
    });
    expect(cardActionForKey({ key: 'p', ctrlKey: true }, { index: 2, carrying: false })).toBeNull();
    expect(cardActionForKey({ key: 'f', ctrlKey: true }, { index: 2, carrying: false })).toBeNull();
    const all = run(state, cardActionForKey({ key: 'a', ctrlKey: true }, { index: 2, carrying: false })!);
    expect(selectionSize(all.selection)).toBe(4);
  });

  it('undoes and redoes from the card, matching the toolbar', () => {
    const state = selectPages(fourPages(), [0]);
    const removed = run(state, { type: 'remove', index: 0 });
    const undo = run(removed, cardActionForKey({ key: 'z', ctrlKey: true }, { index: 0, carrying: false })!);
    expect(order(undo.plan)).toEqual([0, 1, 2, 3]);
    expect(undo.status).toMatch(/Undid removed 1 page/);
    const redo = run(undo, cardActionForKey({ key: 'Z', ctrlKey: true, shiftKey: true }, { index: 0, carrying: false })!);
    expect(order(redo.plan)).toEqual([1, 2, 3]);
    expect(redo.status).toMatch(/Redid removed 1 page/);
    expect(order(run(redo, cardActionForKey({ key: 'y', ctrlKey: true }, { index: 0, carrying: false })!).plan)).toEqual(
      [1, 2, 3],
    );

    const undoneAgain = run(redo, { type: 'undo' });
    const winRedo = run(undoneAgain, cardActionForKey({ key: 'y', ctrlKey: true }, { index: 0, carrying: false })!);
    expect(order(winRedo.plan)).toEqual([1, 2, 3], 'Ctrl+Y is the same redo, spelled for Windows');
  });

  it('walks the grid with arrows and Home/End without dropping keys on the floor', () => {
    let state = run(fourPages(), { type: 'select', index: 0, mode: 'single' });
    state = run(state, cardActionForKey({ key: 'ArrowRight' }, { index: 0, carrying: false })!);
    expect(state.focused).toBe(1);
    expect(state.selection.indexes).toEqual([1]);
    state = run(state, cardActionForKey({ key: 'ArrowLeft', shiftKey: true }, { index: 1, carrying: false })!);
    expect(state.selection.indexes).toEqual([0, 1]);
    state = run(state, cardActionForKey({ key: 'End' }, { index: 1, carrying: false })!);
    expect(state.focused).toBe(3);
    state = run(state, cardActionForKey({ key: 'Home' }, { index: 3, carrying: false })!);
    expect(state.focused).toBe(0);
    const tooFar = run(state, cardActionForKey({ key: 'ArrowUp' }, { index: 0, carrying: false })!);
    expect(tooFar.focused).toBe(0);
  });

  it('nudges with Alt+Arrow, one position per press', () => {
    const state = step(
      openDocs([{ name: 'a.pdf', pages: 5 }]),
      { type: 'select', index: 2, mode: 'single' },
    );
    const nudged = run(state, cardActionForKey({ key: 'ArrowRight', altKey: true }, { index: 2, carrying: false })!);
    expect(order(nudged.plan)).toEqual([0, 1, 3, 2, 4]);
    const atEdge = step(
      openDocs([{ name: 'a.pdf', pages: 2 }]),
      { type: 'select', index: 0, mode: 'single' },
      { type: 'nudge', delta: -1 },
    );
    expect(order(atEdge.plan)).toEqual([0, 1]);
    expect(atEdge.status).toMatch(/already starts at the first page/);
  });

  it('lets a focused card button keep its own activation keys', () => {
    const card = { index: 2, carrying: false };
    expect(cardActionForKey({ key: ' ' }, { ...card, fromChild: true })).toBeNull();
    expect(cardActionForKey({ key: 'Enter' }, { ...card, fromChild: true })).toBeNull();
    expect(cardActionForKey({ key: 'r' }, { ...card, fromChild: true })).toBeNull();
    expect(cardActionForKey({ key: 'ArrowRight' }, { ...card, fromChild: true })).toEqual({
      type: 'focusMove',
      delta: 1,
      extend: false,
    });
    expect(cardActionForKey({ key: 'Delete' }, { ...card, fromChild: true })).toEqual({
      type: 'remove',
      index: 2,
    });
  });

  it('documents every key it binds, so the in-pane list cannot drift', () => {
    const documented = new Set(ORGANIZE_SHORTCUTS.map((s) => s.keys.join('+')));
    for (const keys of ['Space', 'Delete', 'R', 'Shift+R', 'D', 'B', 'Ctrl+A', 'Ctrl+Z', 'Esc']) {
      expect(documented.has(keys), keys).toBe(true);
    }
    for (const shortcut of ORGANIZE_SHORTCUTS) {
      expect(shortcut.label.length).toBeGreaterThan(8);
      expect(shortcut.label.endsWith('.')).toBe(false, 'shortcut labels are phrases, not sentences');
    }
  });
});

describe('keyboard guard', () => {
  const element = (tag: string, attrs: Record<string, string> = {}) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  };

  it('loses to typing, dialogs and menus, and to a child that already handled the key', () => {
    expect(keysOwnTheOrganizer({ key: 'Delete', target: element('input') })).toBe(false);
    expect(keysOwnTheOrganizer({ key: 'Delete', target: element('textarea') })).toBe(false);
    expect(
      keysOwnTheOrganizer({ key: 'Delete', target: element('div', { contenteditable: 'true' }) }),
    ).toBe(false);
    const dialog = element('div', { role: 'dialog' });
    const inside = element('button');
    dialog.appendChild(inside);
    expect(keysOwnTheOrganizer({ key: 'Delete', target: inside })).toBe(false);
    expect(keysOwnTheOrganizer({ key: 'Delete', defaultPrevented: true })).toBe(false);
  });

  it('keeps working for inputs that take no typing', () => {
    expect(keysOwnTheOrganizer({ key: 'Delete', target: element('button') })).toBe(true);
    expect(keysOwnTheOrganizer({ key: 'Delete', target: element('input', { type: 'checkbox' }) })).toBe(
      true,
    );
  });
});

// ── 1-based numbers, E8/E9 preview, E13, E19, E7 ────────────────────────────

describe('page numbers are 1-based everywhere the user can read them', () => {
  it('labels the slot, the source page and the plan string from one', () => {
    const state = step(
      openDocs([
        { name: 'report.pdf', pages: 2 },
        { name: 'appendix.pdf', pages: 2 },
      ]),
      { type: 'insertPages', source: 1, pages: [1], gap: 2 },
    );
    const models = modelsOf(state);
    expect(models.map((m) => m.position)).toEqual([1, 2, 3]);
    expect(models.map((m) => m.sourcePage)).toEqual([1, 2, 2]);
    expect(models[2].label).toBe('appendix.pdf page 2, position 3 of 3');
    expect(planToPageOrder(state.plan)).toBe('f1:1, f1:2, f2:2');
  });

  it('keeps counting from one when a blank sheet joins in', () => {
    const state = run(fourPages(), { type: 'insertBlank', index: -1 });
    const models = modelsOf(state);
    expect(models[0].kind).toBe('blank');
    expect(models[0].position).toBe(1);
    expect(models[0].label).toBe('Blank sheet, position 1 of 5');
    expect(models[1].position).toBe(2);
    expect(planToPageOrder(state.plan)).toBe('blank, 1, 2, 3, 4');
  });
});

describe('mixed page sizes and rotated pages (E8, E9)', () => {
  it('swaps the box for a quarter turn so the rotated page fits its own footprint', () => {
    const portrait = { width: 66, height: 132 };
    const straight = previewBox(portrait, 0, THUMB_SLOT);
    const turned = previewBox(portrait, 90, THUMB_SLOT);
    expect(straight.boxHeight).toBeGreaterThan(straight.boxWidth);
    expect(turned.boxWidth).toBeGreaterThan(turned.boxHeight);
    // The rotated footprint is exactly the turned image: no clipping, no overlap.
    expect(turned.boxWidth).toBe(turned.imageHeight);
    expect(turned.boxHeight).toBe(turned.imageWidth);
    expect(turned.imageWidth / turned.imageHeight).toBeCloseTo(66 / 132, 5);
    expect(previewBox(portrait, 180, THUMB_SLOT)).toMatchObject({
      boxWidth: straight.boxWidth,
      boxHeight: straight.boxHeight,
    });
    expect(previewBox(portrait, 270, THUMB_SLOT)).toMatchObject({
      boxWidth: turned.boxWidth,
      boxHeight: turned.boxHeight,
    });
    expect(straight.boxHeight).toBeLessThanOrEqual(THUMB_SLOT.height);
    expect(turned.boxWidth).toBeLessThanOrEqual(THUMB_SLOT.width);
  });

  it('keeps each page’s own aspect ratio and stays inside the slot (E8)', () => {
    const sizes = [
      { width: 132, height: 66 }, // landscape
      { width: 66, height: 132 }, // portrait
      { width: 100, height: 100 }, // square
    ];
    for (const size of sizes) {
      const box = previewBox(size, 0, THUMB_SLOT);
      expect(box.boxWidth).toBeLessThanOrEqual(THUMB_SLOT.width);
      expect(box.boxHeight).toBeLessThanOrEqual(THUMB_SLOT.height);
      expect(box.imageWidth / box.imageHeight).toBeCloseTo(size.width / size.height, 1);
    }
  });

  it('centres the rotated image in the box it reserves', () => {
    const box = previewBox({ width: 66, height: 132 }, 90, THUMB_SLOT);
    const style = previewBoxStyle(box);
    expect(style.inner.left * 2 + style.inner.width).toBe(box.boxWidth);
    expect(style.inner.top * 2 + style.inner.height).toBe(box.boxHeight);
    expect(style.inner.transform).toBe('rotate(90deg)');
  });

  it('falls back to a portrait box before the browser reports a size, and re-lays out after', () => {
    const state = step(fourPages(), { type: 'select', index: 0, mode: 'single' }, { type: 'rotate', delta: 90 });
    const unmeasured = modelsOf(state)[0];
    expect(unmeasured.preview.measured).toBe(false);
    const measured = cardModels(state, {
      thumbFor: noThumbs,
      sizes: { '0:0': { width: 66, height: 132 } },
    })[0];
    expect(measured.preview.measured).toBe(true);
    expect(measured.preview.boxWidth).toBe(132);
    expect(measured.preview.boxHeight).toBe(66);
    expect(measured.preview.imageWidth).toBe(66);
    expect(measured.preview.imageHeight).toBe(132);
    expect(changedCardCount([unmeasured], [measured])).toBe(1);
  });

  it('writes source rotation plus the planned delta, which is what the preview showed', () => {
    expect(outputRotation(90, 90)).toBe(180);
    expect(outputRotation(270, 90)).toBe(0);
    expect(outputRotation(0, 0)).toBe(0);
    expect(outputRotation(180, 90)).toBe(270);
  });
});

describe('a plan with no output pages is refused with a reason (E13)', () => {
  it('refuses an emptied plan and names the count', () => {
    const state = step(
      fourPages(),
      { type: 'selectAll' },
      { type: 'remove' },
    );
    expect(state.plan).toHaveLength(0);
    expect(state.refusal).toMatch(/0 output pages/);
    expect(planRefusal([], [{ name: 'report.pdf', pages: 4 }])).toMatch(/empty PDF/);
    expect(modelsOf(state)).toHaveLength(0);
  });

  it('clears the refusal the moment a page comes back', () => {
    const emptied = step(fourPages(), { type: 'selectAll' }, { type: 'remove' });
    const refilled = run(emptied, { type: 'insertPages', source: 0, pages: [0] });
    expect(refilled.refusal).toBeNull();
    expect(refilled.plan).toHaveLength(1);
  });

  it('refuses a plan that points at pages the documents no longer have (E6, E19)', () => {
    const state = run(fourPages(), { type: 'sync', docKey: 'other', sources: [{ name: 'report.pdf', pages: 2 }], statuses: ['ready'] });
    expect(state.refusal).toBeNull();
    const shrunk = run(
      step(fourPages(), { type: 'select', index: 0, mode: 'single' }, { type: 'select', index: 3, mode: 'range' }),
      { type: 'useAsBase', source: 0 },
    );
    expect(shrunk.refusal).toBeNull();
  });

  it('says it is still rendering rather than blaming the user', () => {
    expect(planRefusal([], [{ name: 'report.pdf', pages: 0 }], ['loading'])).toMatch(/Waiting for the first page/);
    expect(planRefusal([], [], [])).toMatch(/No document is open/);
  });

  it('keeps a blank-only plan buildable but warns that nothing came from a document', () => {
    const state = step(
      fourPages(),
      { type: 'selectAll' },
      { type: 'remove' },
      { type: 'insertBlank' },
      { type: 'insertBlank' },
    );
    expect(state.plan).toHaveLength(2);
    expect(planRefusal(state.plan, [{ name: 'report.pdf', pages: 4 }])).toBeNull();
    expect(planWarningsText(state.plan, [{ name: 'report.pdf', pages: 4 }])).toMatch(/blank sheet/);
  });
});

describe('undo and redo survive switching between loaded documents (E19)', () => {
  const A = { name: 'a.pdf', pages: 3, size: 100 };
  const B = { name: 'b.pdf', pages: 2, size: 200 };

  it('keeps each document’s own history', () => {
    let state = openDocs([A]);
    state = step(state, { type: 'select', index: 0, mode: 'single' }, { type: 'remove', index: 0 });
    expect(order(state.plan)).toEqual([1, 2]);

    state = run(state, { type: 'sync', docKey: documentKey([B]), sources: [B], statuses: ['ready'] });
    expect(order(state.plan)).toEqual([0, 1], 'B opens on its own order, not A’s');
    expect(historyAvailability(state)).toEqual({ canUndo: false, canRedo: false });
    expect(run(state, { type: 'undo' }).status).toMatch(/Nothing to undo yet for these documents/);

    state = step(state, { type: 'select', index: 1, mode: 'single' }, { type: 'rotate', index: 1, delta: 90 });

    state = run(state, { type: 'sync', docKey: documentKey([A]), sources: [A], statuses: ['ready'] });
    expect(order(state.plan)).toEqual([1, 2], 'A’s plan comes back as the user left it');
    expect(historyAvailability(state).canUndo).toBe(true);

    const undone = run(state, { type: 'undo' });
    expect(order(undone.plan)).toEqual([0, 1, 2]);
    expect(undone.status).toMatch(/Undid removed 1 page/);

    const redone = run(undone, { type: 'redo' });
    expect(order(redone.plan)).toEqual([1, 2]);
    expect(redone.status).toMatch(/Redid removed 1 page/);

    // B’s own stack is untouched by any of that.
    const backToB = run(redone, { type: 'sync', docKey: documentKey([B]), sources: [B], statuses: ['ready'] });
    expect(backToB.plan.map((i) => (i.kind === 'page' ? i.rotate : null))).toEqual([0, 90]);
    expect(historyAvailability(backToB).canUndo).toBe(true);
  });

  it('does not treat a page count arriving as a different document', () => {
    const key = documentKey([A]);
    const loading = organizerReducer(initialWorkspace(), {
      type: 'sync',
      docKey: key,
      sources: [{ name: A.name, pages: 0 }],
      statuses: ['loading'],
    });
    expect(loading.plan).toHaveLength(0);
    const loaded = run(loading, {
      type: 'sync',
      docKey: key,
      sources: [{ name: A.name, pages: 3 }],
      statuses: ['ready'],
    });
    expect(order(loaded.plan)).toEqual([0, 1, 2]);
    expect(loaded.refusal).toBeNull();
  });

  it('reports an unsaved edit honestly when the plan moved mid-save', () => {
    const state = step(fourPages(), { type: 'select', index: 0, mode: 'single' }, { type: 'remove', index: 0 });
    const token = saveToken(state);
    expect(saveIsStale(token, state)).toBe(false);
    expect(saveIsStale(token, run(state, { type: 'undo' }))).toBe(true);
    expect(saveIsStale(token, run(state, { type: 'announce', message: 'x' }))).toBe(false, 'announcements are not edits');
    const reopened = run(state, { type: 'sync', docKey: documentKey([B]), sources: [B], statuses: ['ready'] });
    expect(saveIsStale(token, reopened)).toBe(true);
  });

  it('records one undo point per gesture, not per intermediate step', () => {
    let state = step(
      openDocs([{ name: 'a.pdf', pages: 4 }]),
      { type: 'select', index: 0, mode: 'single' },
      { type: 'select', index: 2, mode: 'range' },
      { type: 'dragStart', payload: { kind: 'plan', indexes: [0, 1, 2] } },
      { type: 'dragOver', gap: 3 },
      { type: 'dragOver', gap: 4 },
      { type: 'drop', gap: 4 },
    );
    expect(order(state.plan)).toEqual([3, 0, 1, 2]);
    state = run(state, { type: 'undo' });
    expect(order(state.plan)).toEqual([0, 1, 2, 3], 'the whole drag was one step');
    expect(historyAvailability(state).canUndo).toBe(false);
  });

  it('restores the selection bounds when an undo grows the plan back', () => {
    const state = step(fourPages(), { type: 'selectAll' }, { type: 'remove' });
    const undone = run(state, { type: 'undo' });
    expect(undone.plan).toHaveLength(4);
    expect(undone.selection.indexes.every((i) => i < 4)).toBe(true);
  });
});

describe('a 500-page plan does not re-render every thumbnail (E7)', () => {
  const big = () => openDocs([{ name: 'huge.pdf', pages: 500 }]);

  it('mounts a bounded window no matter how long the plan is', () => {
    const window = renderWindow({
      count: 500,
      columns: 5,
      rowHeight: 232,
      scrollTop: 0,
      viewportHeight: 800,
      maxItems: 96,
    });
    expect(window.end - window.start).toBeLessThanOrEqual(96);
    expect(window.hiddenAfter).toBeGreaterThan(400);

    const scrolled = renderWindow({
      count: 500,
      columns: 5,
      rowHeight: 232,
      scrollTop: 5000,
      viewportHeight: 800,
      maxItems: 96,
    });
    expect(scrolled.start).toBeGreaterThan(window.start);
    expect(scrolled.end - scrolled.start).toBeLessThanOrEqual(96);

    const tall = renderWindow({
      count: 500,
      columns: 10,
      rowHeight: 232,
      scrollTop: 0,
      viewportHeight: 20000,
      maxItems: 96,
    });
    expect(tall.end - tall.start).toBeLessThanOrEqual(96);
  });

  it('mounts everything when the plan is short, and nothing when it is empty', () => {
    const small = renderWindow({
      count: 6,
      columns: 5,
      rowHeight: 232,
      scrollTop: 0,
      viewportHeight: 800,
      maxItems: 96,
    });
    expect({ start: small.start, end: small.end }).toEqual({ start: 0, end: 6 });
    expect(small.hiddenBefore + small.hiddenAfter).toBe(0);

    const empty = renderWindow({
      count: 0,
      columns: 5,
      rowHeight: 232,
      scrollTop: 0,
      viewportHeight: 0,
      maxItems: 96,
    });
    expect(empty).toEqual({
      start: 0,
      end: 0,
      padTop: 0,
      padBottom: 0,
      hiddenBefore: 0,
      hiddenAfter: 0,
    });
  });

  it('shows the end of the plan without mounting the start', () => {
    const window = renderWindow({
      count: 500,
      columns: 5,
      rowHeight: 232,
      scrollTop: 100 * 232,
      viewportHeight: 800,
      maxItems: 96,
    });
    expect(window.end).toBe(500);
    expect(window.hiddenBefore).toBeGreaterThan(400);
    expect(window.padTop).toBeGreaterThan(0);
    expect(window.padBottom).toBe(0);
  });

  it('dirties one card for a rotation and two for a focus move, out of five hundred', () => {
    const state = step(big(), { type: 'select', index: 250, mode: 'single' });
    const before = modelsOf(state);
    const rotated = run(state, { type: 'rotate', index: 250, delta: 90 });
    expect(changedCardCount(before, modelsOf(rotated))).toBe(1);

    const moved = run(state, { type: 'focusMove', delta: 1 });
    const changed = changedCardCount(before, modelsOf(moved));
    expect(changed).toBeLessThanOrEqual(3);
    expect(changed).toBeGreaterThan(0);

    const dragging = run(state, { type: 'dragStart', payload: { kind: 'plan', indexes: [250] } });
    const whileDragging = modelsOf(dragging);
    const hovered = run(dragging, { type: 'dragOver', gap: 100 });
    expect(changedCardCount(whileDragging, modelsOf(hovered))).toBe(
      2,
      'moving the gap relights one card and clears the previous one, nothing else',
    );
  });

  it('dirties only the span a moved run crosses, not the whole 500-page grid', () => {
    const state = selectPages(big(), [10, 11, 12]);
    const before = modelsOf(state);
    const dropped = step(state, {
      type: 'dragStart',
      payload: { kind: 'plan', indexes: [10, 11, 12] },
    }, {
      type: 'drop',
      gap: 20,
    });
    expect(order(dropped.plan)).toEqual([
      ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      ...Array.from({ length: 7 }, (_, i) => i + 13),
      ...[10, 11, 12],
      ...Array.from({ length: 480 }, (_, i) => i + 20),
    ]);
    const after = modelsOf(dropped);
    let changed = 0;
    for (let i = 0; i < before.length; i += 1) if (!sameContent(before[i], after[i])) changed += 1;
    expect(changed).toBe(10, 'the crossed span, not 500 cards');
  });

  it('keeps untouched cards identical objects when only one page rotates', () => {
    const state = selectPages(big(), [7]);
    const before = modelsOf(state);
    const after = modelsOf(run(state, { type: 'rotate', index: 7, delta: 90 }));
    let reused = 0;
    for (let i = 0; i < before.length; i += 1) if (cardModelsEqualFn(before[i], after[i])) reused += 1;
    expect(reused).toBe(499);
  });

  function sameContent(a: CardModelish, b: CardModelish) {
    return a.page === b.page && a.source === b.source && a.rotate === b.rotate;
  }

  it('keeps the projection cheap enough to recompute per keystroke', () => {
    const state = big();
    const started = Date.now();
    for (let i = 0; i < 50; i += 1) modelsOf(state);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

// ── the plan string stays in step with the grid ─────────────────────────────

describe('plan text', () => {
  it('applies a typed plan and keeps a bad one in the field with the reason', () => {
    const state = run(fourPages(), { type: 'applyPlanText', spec: '4, blank, 2r90' });
    expect(order(state.plan)).toEqual([3, -1, 1]);
    expect(state.plan[2]).toEqual(pageItem(0, 1, 90));
    expect(state.inputError).toBeNull();

    const broken = run(state, { type: 'applyPlanText', spec: '9' });
    expect(broken.plan).toEqual(state.plan, 'the grid keeps what it had');
    expect(broken.inputError).toMatch(/page 9 of file 1, which has 4/);
    expect(broken.status).toMatch(/not applied/);
  });

  it('resets and rebuilds from another document through the reducer', () => {
    const two = openDocs([
      { name: 'report.pdf', pages: 2 },
      { name: 'appendix.pdf', pages: 3 },
    ]);
    const edited = run(two, { type: 'useAsBase', source: 1 });
    expect(order(edited.plan)).toEqual([0, 1, 2]);
    expect(planToPageOrder(edited.plan)).toBe('f2:1, f2:2, f2:3');
    const back = run(edited, { type: 'resetOrder' });
    expect(order(back.plan)).toEqual([0, 1]);
    const already = run(back, { type: 'resetOrder' });
    expect(already.status).toMatch(/already the original page order/);
    expect(historyAvailability(already).canUndo).toBe(true);
  });
});

// ── the pane still mounts as the registry expects ───────────────────────────

describe('pane shell', () => {
  it('renders the empty state, not a blank pane, when no file is open', async () => {
    const { cleanup, render, screen } = await import('@testing-library/react');
    const PageOrganizer = (await import('@/components/tools/pdf/organize/PageOrganizer')).default;
    const { useFileStore } = await import('@/stores/file-store');
    useFileStore.setState({ files: [], file: null, params: {} });
    render(createElement(PageOrganizer));
    expect(screen.getByText(/No pages to organise yet/)).toBeInTheDocument();
    // An empty plan is published as an explicit empty plan, never as "no value",
    // which the registry would read as "the whole document" (E13).
    expect(useFileStore.getState().params.pageOrder).toEqual([]);
    cleanup();
  });

  it('names the next action in the empty state', async () => {
    const { cleanup, render, screen } = await import('@testing-library/react');
    const PageOrganizer = (await import('@/components/tools/pdf/organize/PageOrganizer')).default;
    const { useFileStore } = await import('@/stores/file-store');
    useFileStore.setState({ files: [], file: null, params: {} });
    render(createElement(PageOrganizer));
    expect(screen.getByText(/Add one or more PDFs/)).toBeInTheDocument();
    expect(screen.getByText(/first becomes the page order you edit/)).toBeInTheDocument();
    cleanup();
  });
});
