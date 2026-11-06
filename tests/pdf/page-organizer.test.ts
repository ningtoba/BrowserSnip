/**
 * Pure tests for the `PageOrganizer` plan model.
 *
 * The pane renders pdf.js thumbnails, which jsdom cannot do, so these tests
 * cover the half that matters for correctness: the reducers behind every
 * drag/keyboard action, and the round-trip between the in-memory plan and the
 * `pageOrder` string the tool registry parses (`3, 1r90, blank`).
 */
import { describe, expect, it } from 'vitest';
import FormCreatorMain, { FormCreatorMain as FormCreatorNamed } from '@/components/tools/pdf/edit/FormCreatorMain';
import FormFillMain, { FormFillMain as FormFillNamed } from '@/components/tools/pdf/edit/FormFillMain';
import PageOrganizer, { PageOrganizer as PageOrganizerNamed } from '@/components/tools/pdf/organize/PageOrganizer';
import {
  BLANK_ITEM,
  defaultPlan,
  deletePlanItem,
  duplicatePlanItem,
  firstPlannedSource,
  insertBlankAfter,
  insertPagesFrom,
  insertPlanItems,
  isPristinePlan,
  movePlanItem,
  pageItem,
  parsePageOrder,
  planStats,
  planToPageOrder,
  rotatePlanItem,
  swapPlanItems,
  type Plan,
  type PlanSource,
} from '@/components/tools/pdf/organize/PageOrganizer';

const SOURCES: PlanSource[] = [
  { name: 'report.pdf', pages: 4 },
  { name: 'appendix.pdf', pages: 2 },
];

/** Tokens the registry's `parsePlan` accepts, verbatim. */
const REGISTRY_TOKEN = /^(?:\d+(?:r(?:90|180|270))?|blank)$/;

describe('defaultPlan', () => {
  it('lists every page of one source in order', () => {
    expect(defaultPlan(SOURCES, 0)).toEqual([
      pageItem(0, 0),
      pageItem(0, 1),
      pageItem(0, 2),
      pageItem(0, 3),
    ]);
    expect(defaultPlan(SOURCES, 1)).toEqual([pageItem(1, 0), pageItem(1, 1)]);
  });

  it('is empty for a missing or pageless source', () => {
    expect(defaultPlan(SOURCES, 7)).toEqual([]);
    expect(defaultPlan([{ name: 'empty.pdf', pages: 0 }])).toEqual([]);
  });
});

describe('movePlanItem (drag reorder)', () => {
  const plan = defaultPlan(SOURCES, 0);

  it('moves a page rightwards using the pre-removal index', () => {
    expect(planToPositions(movePlanItem(plan, 0, 3))).toEqual([1, 2, 0, 3]);
  });

  it('moves a page leftwards', () => {
    expect(planToPositions(movePlanItem(plan, 3, 1))).toEqual([0, 3, 1, 2]);
  });

  it('appends when the slot is the end of the list', () => {
    expect(planToPositions(movePlanItem(plan, 0, plan.length))).toEqual([1, 2, 3, 0]);
  });

  it('is a no-op for the same slot, out-of-range sources and clamps', () => {
    expect(movePlanItem(plan, 2, 2)).toBe(plan);
    expect(movePlanItem(plan, 9, 1)).toBe(plan);
    expect(planToPositions(movePlanItem(plan, 2, 99))).toEqual([0, 1, 3, 2]);
    expect(planToPositions(movePlanItem(plan, 2, -5))).toEqual([2, 0, 1, 3]);
  });

  it('does not mutate the input plan', () => {
    const before = JSON.stringify(plan);
    movePlanItem(plan, 0, 2);
    expect(JSON.stringify(plan)).toBe(before);
  });
});

describe('swapPlanItems (keyboard nudge)', () => {
  const plan = defaultPlan(SOURCES, 0);

  it('exchanges two adjacent slots', () => {
    expect(planToPositions(swapPlanItems(plan, 1, 2))).toEqual([0, 2, 1, 3]);
  });

  it('ignores moves off either end', () => {
    expect(swapPlanItems(plan, 0, -1)).toBe(plan);
    expect(swapPlanItems(plan, 3, 4)).toBe(plan);
    expect(swapPlanItems(plan, 2, 2)).toBe(plan);
  });

  it('carries blanks along with pages', () => {
    const withBlank = insertBlankAfter(plan, 1);
    expect(planToPositions(withBlank)).toEqual([0, 1, -1, 2, 3]);
    expect(planToPositions(swapPlanItems(withBlank, 1, 2))).toEqual([0, -1, 1, 2, 3]);
  });
});

describe('rotatePlanItem', () => {
  it('adds a quarter turn and wraps back to the source rotation', () => {
    let plan: Plan = [pageItem(0, 0)];
    for (const expected of [90, 180, 270, 0]) {
      plan = rotatePlanItem(plan, 0, 90);
      const item = plan[0];
      expect(item.kind === 'page' && item.rotate).toBe(expected);
    }
  });

  it('accepts counter-clockwise turns', () => {
    const plan = rotatePlanItem([pageItem(0, 0, 90)], 0, -90);
    expect(plan[0]).toEqual(pageItem(0, 0, 0));
  });

  it('leaves blank sheets and other slots alone', () => {
    const plan: Plan = [pageItem(0, 0), BLANK_ITEM, pageItem(0, 1)];
    const rotated = rotatePlanItem(plan, 1, 90);
    expect(rotated).toEqual(plan);
    expect(rotatePlanItem(plan, 0, 180)[2]).toEqual(pageItem(0, 1));
  });
});

describe('duplicatePlanItem', () => {
  it('repeats an item directly after itself, keeping rotation', () => {
    const plan: Plan = [pageItem(0, 1, 90), pageItem(0, 2)];
    expect(duplicatePlanItem(plan, 0)).toEqual([pageItem(0, 1, 90), pageItem(0, 1, 90), pageItem(0, 2)]);
  });

  it('duplicates a blank sheet without sharing the object', () => {
    const plan: Plan = [BLANK_ITEM];
    const next = duplicatePlanItem(plan, 0);
    expect(next).toHaveLength(2);
    expect(next[1]).not.toBe(next[0]);
    expect(next[1]).toEqual({ kind: 'blank' });
  });

  it('is a no-op for an index outside the plan', () => {
    const plan = defaultPlan(SOURCES, 0);
    expect(duplicatePlanItem(plan, 9)).toBe(plan);
  });
});

describe('deletePlanItem', () => {
  it('removes exactly one slot, including repeats', () => {
    const plan: Plan = [pageItem(0, 0), pageItem(0, 1), pageItem(0, 1)];
    expect(deletePlanItem(plan, 2)).toEqual([pageItem(0, 0), pageItem(0, 1)]);
    expect(deletePlanItem(plan, 1)).toEqual([pageItem(0, 0), pageItem(0, 1)]);
  });

  it('keeps the plan intact for out-of-range indices', () => {
    const plan = defaultPlan(SOURCES, 0);
    expect(deletePlanItem(plan, -1)).toBe(plan);
    expect(deletePlanItem(plan, plan.length)).toBe(plan);
  });
});

describe('insertBlankAfter', () => {
  it('adds a sheet after the given slot', () => {
    const plan = defaultPlan(SOURCES, 0);
    expect(planToPositions(insertBlankAfter(plan, 1))).toEqual([0, 1, -1, 2, 3]);
  });

  it('supports -1 (in front) and the last index (append)', () => {
    const plan: Plan = [pageItem(0, 0)];
    expect(planToPositions(insertBlankAfter(plan, -1))).toEqual([-1, 0]);
    expect(planToPositions(insertBlankAfter(plan, 0))).toEqual([0, -1]);
  });
});

describe('insertPagesFrom (pull pages from another document)', () => {
  it('inserts 0-based pages of any source at the slot', () => {
    const plan = defaultPlan(SOURCES, 0);
    const next = insertPagesFrom(plan, 2, 1, [0, 1]);
    expect(next).toEqual([
      pageItem(0, 0),
      pageItem(0, 1),
      pageItem(1, 0),
      pageItem(1, 1),
      pageItem(0, 2),
      pageItem(0, 3),
    ]);
  });

  it('applies the requested rotation to each inserted page', () => {
    expect(insertPagesFrom([], 0, 1, [0, 1], 270)).toEqual([pageItem(1, 0, 270), pageItem(1, 1, 270)]);
  });

  it('copies items so the plan never shares objects', () => {
    const items = [pageItem(0, 0)];
    const plan = insertPlanItems([], 0, items);
    expect(plan[0]).not.toBe(items[0]);
  });

  it('clamps the insertion index', () => {
    const plan: Plan = [pageItem(0, 0)];
    expect(insertPlanItems(plan, 9, [BLANK_ITEM])).toEqual([pageItem(0, 0), BLANK_ITEM]);
    expect(insertPlanItems(plan, -3, [BLANK_ITEM])).toEqual([BLANK_ITEM, pageItem(0, 0)]);
    expect(insertPlanItems(plan, 0, [])).toBe(plan);
  });
});

describe('planStats', () => {
  it('counts pages, blanks, per-source usage and reuse', () => {
    const plan: Plan = [
      pageItem(0, 0),
      BLANK_ITEM,
      pageItem(0, 1),
      pageItem(0, 1),
      pageItem(1, 0, 90),
    ];
    expect(planStats(plan, 2)).toEqual({
      total: 5,
      pages: 4,
      blanks: 1,
      perSource: [3, 1],
      distinct: 3,
    });
  });

  it('survives an empty plan and a source that is no longer open', () => {
    expect(planStats([], 0)).toEqual({ total: 0, pages: 0, blanks: 0, perSource: [], distinct: 0 });
    expect(planStats([pageItem(4, 0)], 1)).toEqual({
      total: 1,
      pages: 1,
      blanks: 0,
      perSource: [0],
      distinct: 1,
    });
  });
});

describe('isPristinePlan', () => {
  it('is true only for the untouched order of the given source', () => {
    expect(isPristinePlan(defaultPlan(SOURCES, 0), SOURCES, 0)).toBe(true);
    expect(isPristinePlan(rotatePlanItem(defaultPlan(SOURCES, 0), 0, 90), SOURCES, 0)).toBe(false);
    expect(isPristinePlan(insertBlankAfter(defaultPlan(SOURCES, 0), 0), SOURCES, 0)).toBe(false);
    expect(isPristinePlan(defaultPlan(SOURCES, 1), SOURCES, 1)).toBe(true);
    expect(isPristinePlan([], [], 0)).toBe(true);
  });
});

describe('firstPlannedSource', () => {
  it('skips leading blanks so sheet size comes from a real page', () => {
    expect(firstPlannedSource([BLANK_ITEM, pageItem(1, 0)])).toBe(1);
    expect(firstPlannedSource([BLANK_ITEM])).toBeUndefined();
  });
});

describe('planToPageOrder / parsePageOrder', () => {
  it('emits the registry grammar for a single-document plan', () => {
    const plan: Plan = [
      pageItem(0, 2),
      pageItem(0, 0, 90),
      BLANK_ITEM,
      pageItem(0, 1, 270),
    ];
    const spec = planToPageOrder(plan);
    expect(spec).toBe('3, 1r90, blank, 2r270');
    for (const token of spec.split(', ')) expect(token).toMatch(REGISTRY_TOKEN);
  });

  it('round-trips the brief’s own example', () => {
    const spec = '3, 1r90, blank, 2';
    const plan = parsePageOrder(spec, SOURCES);
    expect(plan).toEqual([pageItem(0, 2), pageItem(0, 0, 90), BLANK_ITEM, pageItem(0, 1)]);
    expect(planToPageOrder(plan)).toBe(spec);
  });

  it('qualifies pages with their file once a second document is used', () => {
    const plan: Plan = [pageItem(0, 0), pageItem(1, 1, 180), BLANK_ITEM];
    expect(planToPageOrder(plan)).toBe('f1:1, f2:2r180, blank');
  });

  const cases: Plan[] = [
    defaultPlan(SOURCES, 0),
    [BLANK_ITEM, ...defaultPlan(SOURCES, 1)],
    rotatePlanItem(defaultPlan(SOURCES, 0), 1, 180),
    insertPagesFrom(defaultPlan(SOURCES, 0), 1, 1, [0, 1], 90),
    duplicatePlanItem(insertBlankAfter(defaultPlan(SOURCES, 1), 0), 2),
    movePlanItem(insertPagesFrom(defaultPlan(SOURCES, 0), 2, 1, [1]), 0, 4),
  ];

  it('round-trips every plan shape the UI can produce', () => {
    cases.forEach((plan, index) => {
      const spec = planToPageOrder(plan);
      expect(parsePageOrder(spec, SOURCES), `case ${index}: ${spec}`).toEqual(plan);
      expect(planToPageOrder(parsePageOrder(spec, SOURCES))).toBe(spec);
    });
  });

  it('treats an empty spec as the first document in order, like the registry', () => {
    expect(parsePageOrder('', SOURCES)).toEqual(defaultPlan(SOURCES, 0));
    expect(parsePageOrder('   ', SOURCES)).toEqual(defaultPlan(SOURCES, 0));
  });

  it('accepts the mixed comma / space separators the registry accepts', () => {
    expect(parsePageOrder('1 2r90, blank, 4', SOURCES)).toEqual([
      pageItem(0, 0),
      pageItem(0, 1, 90),
      BLANK_ITEM,
      pageItem(0, 3),
    ]);
  });

  it('normalises odd rotations the same way core/pages does', () => {
    const plan = parsePageOrder('1r45', SOURCES);
    expect(plan).toEqual([pageItem(0, 0, 90)]);
  });

  it('refuses malformed plans with a sentence naming what to do', () => {
    expect(() => parsePageOrder('banana', SOURCES)).toThrow(/is not a page token/);
    expect(() => parsePageOrder('5', SOURCES)).toThrow(/has 4 pages/);
    expect(() => parsePageOrder('f3:1', SOURCES)).toThrow(/2 PDFs are open/);
    expect(() => parsePageOrder('f1:9', SOURCES)).toThrow(/page 9 of file 1/);
    expect(() => parsePageOrder(',,', SOURCES)).toThrow(/empty/);
    expect(() => parsePageOrder('1', [])).toThrow(/0 PDFs are open/);
  });

  it('parses a blank-only plan without needing a source page', () => {
    expect(parsePageOrder('blank, blank', SOURCES)).toEqual([BLANK_ITEM, BLANK_ITEM]);
  });
});

/** `-1` marks a blank sheet so the assertions stay readable. */
function planToPositions(plan: Plan): number[] {
  return plan.map((item) => (item.kind === 'blank' ? -1 : item.page));
}

/**
 * `registry.ts` lazy-imports all three panes by path and mounts the default
 * export, so a renamed component is a blank pane rather than a build error.
 * These assertions make that contract explicit.
 */
describe('pane export contract', () => {
  it('exports each pane as both the default and a named component', () => {
    expect(typeof PageOrganizer).toBe('function');
    expect(typeof PageOrganizerNamed).toBe('function');
    expect(PageOrganizerNamed).toBe(PageOrganizer);
    expect(typeof FormFillMain).toBe('function');
    expect(typeof FormFillNamed).toBe('function');
    expect(FormFillNamed).toBe(FormFillMain);
    expect(typeof FormCreatorMain).toBe('function');
    expect(typeof FormCreatorNamed).toBe('function');
    expect(FormCreatorNamed).toBe(FormCreatorMain);
  });

  it('takes no props, as the registry mounts it', () => {
    // A bespoke main view is rendered as `<MainView />`, so every pane must
    // work with an empty prop bag.
    expect(PageOrganizer.length).toBe(0);
    expect(FormFillMain.length).toBe(0);
    expect(FormCreatorMain.length).toBe(0);
  });
});
