/**
 * Pure-logic tests for `src/lib/pdf/core/tables.ts`.
 *
 * No canvas and no pdf.js at runtime: `ExtractedTextItem` is a plain object, so
 * the fixtures below are synthesised in the same space pdf.js reports text
 * (rotated viewer space, origin top-left, points at scale 1).
 */
import { describe, expect, it } from 'vitest';
import type { ExtractedTextItem } from '@/lib/pdf/core/render';
import {
  clusterRows,
  columnsFromRows,
  csvEscapeField,
  detectTables,
  fmtNumber,
  gridFromRules,
  gridRow,
  gridRows,
  isVisibleText,
  joinRuns,
  logicalRows,
  looksLikeHeader,
  pageFrameOfView,
  rowToCsv,
  ruledConfidence,
  ruleEdges,
  scoreTable,
  svgMatrix,
  tablesToAoa,
  tablesToCsv,
  userSpaceToSvgMatrix,
  viewerRectToUserSpace,
  viewerSizeOf,
} from '@/lib/pdf/core/tables';
import type { PageFrame, VectorLine } from '@/lib/pdf/core/tables';

interface ItemSeed {
  str: string;
  x: number;
  y: number;
  w: number;
  h?: number;
  page?: number;
  invisible?: boolean;
  fontName?: string;
}

/** Build a text run exactly as `core/render.toExtractedItems` would. */
function item(seed: ItemSeed): ExtractedTextItem {
  const h = seed.h ?? 10;
  const size = h / 1.15;
  return {
    str: seed.str,
    transform: [size, 0, 0, size, seed.x, 841.89 - seed.y],
    width: seed.w,
    height: h,
    fontSize: size,
    fontName: seed.fontName ?? 'F0',
    dir: 'ltr',
    page: seed.page ?? 1,
    x: seed.x,
    y: seed.y,
    w: seed.w,
    h,
    hasEOL: false,
    isInvisible: seed.invisible ?? false,
    // Upright text only: up the page is up the screen.
    ux: 0,
    uy: -1,
  };
}

/** Three-plus column invoice grid with one deliberately missing cell. */
function invoiceRows(): ExtractedTextItem[] {
  return [
    item({ str: 'Item', x: 50, y: 100, w: 30 }),
    item({ str: 'Qty', x: 200, y: 100, w: 25 }),
    item({ str: 'Price', x: 320, y: 100, w: 40 }),
    item({ str: 'Widget', x: 50, y: 120, w: 45 }),
    item({ str: '3', x: 200, y: 120, w: 8 }),
    item({ str: '$1.50', x: 320, y: 120, w: 35 }),
    item({ str: 'Gizmo', x: 50, y: 140, w: 40 }),
    item({ str: '7', x: 200, y: 140, w: 8 }),
    // no price for Gizmo — the row must still come out rectangular
    item({ str: 'Total', x: 50, y: 160, w: 35 }),
    item({ str: '10', x: 200, y: 160, w: 12 }),
    item({ str: '$10.50', x: 320, y: 160, w: 45 }),
  ];
}

const A4: PageFrame = { x0: 0, y0: 0, width: 595.28, height: 841.89, rotation: 0 };

describe('clusterRows', () => {
  it('groups runs that share a baseline and orders them left to right', () => {
    const rows = clusterRows([
      item({ str: 'B', x: 200, y: 100, w: 20 }),
      item({ str: 'A', x: 50, y: 101, w: 20 }),
      item({ str: 'C', x: 50, y: 130, w: 20 }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0].items.map((i) => i.str)).toEqual(['A', 'B']);
    expect(rows[1].items.map((i) => i.str)).toEqual(['C']);
    expect(rows[0].top).toBe(100);
    expect(rows[0].bottom).toBe(111);
  });

  it('drops invisible (render mode 3) and whitespace-only runs', () => {
    const rows = clusterRows([
      item({ str: 'real', x: 50, y: 100, w: 20 }),
      item({ str: 'ghost', x: 50, y: 200, w: 20, invisible: true }),
      item({ str: '   ', x: 50, y: 300, w: 10 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].items[0].str).toBe('real');
    expect(isVisibleText(item({ str: ' ', x: 0, y: 0, w: 1 }))).toBe(false);
    expect(isVisibleText(item({ str: 'x', x: 0, y: 0, w: 1, invisible: true }))).toBe(false);
  });
});

describe('columnsFromRows', () => {
  it('reads the column count off the x-gap histogram', () => {
    const columns = columnsFromRows(clusterRows(invoiceRows()));
    expect(columns).toHaveLength(3);
    expect(columns[0].start).toBeCloseTo(50, 1);
    expect(columns[1].start).toBeCloseTo(200, 1);
    expect(columns[2].start).toBeCloseTo(320, 1);
  });

  it('keeps a tightly spaced paragraph as one column', () => {
    const rows = clusterRows([
      item({ str: 'The quick brown', x: 50, y: 100, w: 120 }),
      item({ str: 'fox jumps over', x: 50, y: 112, w: 118 }),
    ]);
    expect(columnsFromRows(rows)).toHaveLength(1);
  });
});

describe('detectTables — whitespace mode', () => {
  it('emits rectangular rows with empty placeholders and a header row', () => {
    const tables = detectTables(invoiceRows());
    expect(tables).toHaveLength(1);
    const [table] = tables;
    expect(table.page).toBe(1);
    expect(table.rows).toEqual([
      ['Item', 'Qty', 'Price'],
      ['Widget', '3', '$1.50'],
      ['Gizmo', '7', ''],
      ['Total', '10', '$10.50'],
    ]);
    expect(table.rows.every((row) => row.length === 3)).toBe(true);
    expect(table.headerRow).toEqual(['Item', 'Qty', 'Price']);
    expect(table.confidence).toBeGreaterThan(0.6);
    expect(table.confidence).toBeLessThanOrEqual(1);
    expect(table.rect.x).toBeCloseTo(50, 1);
    expect(table.rect.width).toBeCloseTo(315, 1);
  });

  it('ignores pages that hold nothing but prose', () => {
    const tables = detectTables([
      item({ str: 'This invoice covers the quarter just ended and is due in', x: 50, y: 100, w: 400 }),
      item({ str: 'full within thirty days of the date printed above.', x: 50, y: 112, w: 300 }),
    ]);
    expect(tables).toEqual([]);
  });

  it('needs minRows rows before calling a block a table', () => {
    const oneRow = [
      item({ str: 'Qty', x: 200, y: 100, w: 25 }),
      item({ str: 'Price', x: 320, y: 100, w: 40 }),
    ];
    expect(detectTables(oneRow, { minRows: 2 })).toEqual([]);
    const tables = detectTables(oneRow, { minRows: 1 });
    expect(tables).toHaveLength(1);
  });

  it('skips runs an earlier OCR pass left invisible', () => {
    const ghosts = invoiceRows().map((run) => ({ ...run, isInvisible: true }));
    expect(detectTables(ghosts)).toEqual([]);
  });

  it('keeps separate tables on one page apart and sorts by page', () => {
    const second = invoiceRows().map((run) => ({
      ...run,
      page: 2,
      y: run.y + 300,
    }));
    const tables = detectTables([...invoiceRows(), ...second]);
    expect(tables.map((table) => table.page)).toEqual([1, 2]);
  });
});

describe('detectTables — ruled mode', () => {
  const lines: VectorLine[] = [
    // vertical rules at the column edges
    { x1: 50, y1: 100, x2: 50, y2: 180, width: 0.5 },
    { x1: 200, y1: 100, x2: 200.4, y2: 180, width: 0.5 },
    { x1: 320, y1: 100, x2: 320, y2: 180, width: 0.5 },
    { x1: 420, y1: 100, x2: 420, y2: 180, width: 0.5 },
    // horizontal rules at the row edges
    { x1: 50, y1: 100, x2: 420, y2: 100, width: 0.5 },
    { x1: 50, y1: 120, x2: 420, y2: 120.3, width: 0.5 },
    { x1: 50, y1: 150, x2: 420, y2: 150, width: 0.5 },
    { x1: 50, y1: 180, x2: 420, y2: 180, width: 0.5 },
  ];

  it('takes the grid from the rules, not from the gaps', () => {
    const items = [
      item({ str: 'Widget', x: 60, y: 105, w: 45 }),
      item({ str: '3', x: 210, y: 105, w: 8 }),
      item({ str: '$1.50', x: 330, y: 105, w: 35 }),
      item({ str: 'Gizmo', x: 60, y: 130, w: 40 }),
      item({ str: '7', x: 210, y: 130, w: 8 }),
      item({ str: 'Total', x: 60, y: 160, w: 35 }),
      item({ str: '10', x: 210, y: 160, w: 12 }),
    ];
    const tables = detectTables(items, { lines });
    expect(tables).toHaveLength(1);
    expect(tables[0].rows).toEqual([
      ['Widget', '3', '$1.50'],
      ['Gizmo', '7', ''],
      ['Total', '10', ''],
    ]);
    expect(tables[0].rect).toEqual({ x: 50, y: 100, width: 370, height: 80 });
    expect(tables[0].confidence).toBeGreaterThan(0.7);
  });

  it('can be switched off with useVectorLines: false', () => {
    const tables = detectTables(
      [
        item({ str: 'Widget', x: 60, y: 105, w: 45 }),
        item({ str: 'Gizmo', x: 60, y: 130, w: 40 }),
      ],
      { lines, useVectorLines: false, minRows: 2 },
    );
    expect(tables).toEqual([]);
  });

  it('clusters near-duplicate rule coordinates', () => {
    const edges = ruleEdges([
      { x1: 100, y1: 0, x2: 100.3, y2: 50, width: 0.6 },
      { x1: 100.1, y1: 10, x2: 100.1, y2: 60, width: 0.6 },
      { x1: 0, y1: 20, x2: 80, y2: 20.2, width: 0.6 },
    ]);
    expect(edges.vertical).toHaveLength(1);
    expect(edges.vertical[0]).toBeCloseTo(100.13, 1);
    expect(edges.horizontal).toHaveLength(1);
  });

  it('gridFromRules tolerates a missing rule pair', () => {
    const rows = clusterRows([
      item({ str: 'A', x: 60, y: 105, w: 20 }),
      item({ str: 'B', x: 210, y: 105, w: 20 }),
    ]);
    expect(gridFromRules(rows, [50, 200, 320], [100, 120])).toEqual([['A', 'B']]);
    expect(gridFromRules(rows, [50], [100, 120])).toEqual([]);
  });
});

/**
 * Cells are joined by the same rule as a line of prose (`joinRuns`, documented
 * with the measurement behind it): a browser-generated page writes "世界" as two
 * runs and the cell that holds it must still read "世界".
 */
describe('the run join inside cells', () => {
  it('keeps a split word inside one cell whole', () => {
    const [row] = clusterRows([
      item({ str: 'Ünïcødé', x: 200, y: 100, w: 30 }),
      // the word space was its own (dropped) run, so 0.32 em of blank is left
      item({ str: '世', x: 232.78, y: 100, w: 9.75 }),
      item({ str: '界', x: 242.53, y: 100, w: 9.75 }),
      item({ str: 'naïve', x: 255.06, y: 100, w: 20 }),
    ]);
    expect(gridRow(row, [{ start: 195, end: 290 }])).toEqual(['Ünïcødé 世界 naïve']);
  });

  it('still puts one space between the words of a cell that has them', () => {
    const [row] = clusterRows([
      item({ str: 'Line', x: 200, y: 100, w: 18 }),
      item({ str: 'one', x: 220, y: 100, w: 14 }),
    ]);
    expect(gridRow(row, [{ start: 195, end: 290 }])).toEqual(['Line one']);
    expect(joinRuns(row.items)).toBe('Line one');
  });

  it('separates the two lines a wrapped cell stacks in one grid cell', () => {
    // `gridFromRules` buckets every physical row of a ruled band into the same
    // cell: a line break inside a cell is a word boundary, never a glue.
    const rows = clusterRows([
      item({ str: 'Line', x: 200, y: 100, w: 18 }),
      item({ str: 'one', x: 220, y: 100, w: 14 }),
      item({ str: 'Line', x: 200, y: 112, w: 18 }),
      item({ str: 'two', x: 220, y: 112, w: 14 }),
    ]);
    expect(rows).toHaveLength(2);
    expect(gridFromRules(rows, [195, 290], [95, 130])).toEqual([['Line one Line two']]);
  });

  it('reads a step of a whole line as a break and a step inside the band as flow', () => {
    const first = item({ str: 'one', x: 220, y: 100, w: 14 });
    // A second line of the same cell starts back at the left rule: its box begins
    // left of where this one ends, and it sits a full line below.
    expect(joinRuns([first, item({ str: 'two', x: 200, y: 112, w: 14 })])).toBe('one two');
    // The same junction 0.8 pt off the baseline is one word, not two.
    expect(joinRuns([first, item({ str: 'two', x: 234, y: 99.2, w: 14 })])).toBe('onetwo');
  });
});

/**
 * A cell with a `<br>` (or a wrapped phrase) is painted as several text lines
 * whose boxes reach into each other vertically; every genuine row break leaves a
 * positive gap. `logicalRows` folds only the overlap class — measured as 2 of the
 * 217 consecutive row pairs across the bar fixtures and the 49-PDF corpus, both of
 * them this case, and 0 changes in the other 54 tables.
 */
describe('logicalRows — folding the lines of one cell', () => {
  const line = (str: string, x: number, top: number, w = 40, h = 9.75): ExtractedTextItem =>
    item({ str, x, y: top, w, h });

  it('folds rows whose boxes overlap into one row', () => {
    // The geometry cells.pdf really reports: 141.00–150.75, 147.00–156.75,
    // 152.25–162.00 — each pair overlapping by 3.75 / 4.5 pt.
    const rows = clusterRows([
      line('Line one', 71.66, 141),
      line('newline cell', 166.85, 147),
      line('4', 271.71, 147),
      line('Line two', 71.66, 152.25),
    ]);
    expect(rows).toHaveLength(3);
    const folded = logicalRows(rows);
    expect(folded).toHaveLength(1);
    expect(folded[0].top).toBeCloseTo(141, 2);
    expect(folded[0].bottom).toBeCloseTo(162, 2);
  });

  it('builds the row the author wrote, not three', () => {
    const rows = clusterRows([
      line('Item', 71.66, 66),
      line('Note', 166.85, 66),
      line('Val', 271.71, 66),
      line('Line one', 71.66, 141),
      line('newline cell', 166.85, 147),
      line('4', 271.71, 147),
      line('Line two', 71.66, 152.25),
    ]);
    const columns = columnsFromRows(rows);
    expect(gridRows(rows, columns)).toEqual([
      ['Item', 'Note', 'Val'],
      ['Line one Line two', 'newline cell', '4'],
    ]);
  });

  it('leaves tight-but-separated rows alone (the control)', () => {
    // Spreadsheet exports run 6.88 pt lines 1.93 pt apart: every one of those
    // pairs is a real row, and none of them overlaps.
    const rows = clusterRows([
      line('Q1', 68.92, 68, 20, 6.88),
      line('Q2', 68.92, 76.81, 20, 6.88),
      line('Q3', 68.92, 85.62, 20, 6.88),
    ]);
    expect(rows).toHaveLength(3);
    expect(logicalRows(rows)).toHaveLength(3);
  });

  it('folds nothing at all when a row starts exactly where the last ended', () => {
    const rows = clusterRows([
      line('a', 50, 100),
      line('b', 50, 109.75),
    ]);
    expect(logicalRows(rows)).toHaveLength(2);
  });
});

describe('confidence scores', () => {
  it('scores a dense multi-column grid above a sparse one', () => {
    const dense = [
      ['a', 'b', 'c'],
      ['d', 'e', 'f'],
      ['g', 'h', 'i'],
    ];
    const sparse = [
      ['a', '', ''],
      ['', 'e', ''],
      ['', '', 'i'],
    ];
    expect(scoreTable(dense)).toBeGreaterThan(scoreTable(sparse));
    expect(scoreTable([['only', 'one row']])).toBeGreaterThan(0);
    expect(scoreTable([['one column only']])).toBe(0);
  });

  it('rates a filled ruled grid above an empty one', () => {
    const filled = [
      ['a', 'b'],
      ['c', 'd'],
    ];
    const empty = [
      ['', ''],
      ['', ''],
    ];
    expect(ruledConfidence(filled, 2)).toBeGreaterThan(ruledConfidence(empty, 2));
    expect(ruledConfidence(empty, 2)).toBe(0.7);
  });

  it('flags label-over-number tables as headers only', () => {
    expect(
      looksLikeHeader([
        ['Item', 'Qty'],
        ['Widget', '3'],
        ['Gizmo', '7'],
      ]),
    ).toBe(true);
    expect(
      looksLikeHeader([
        ['Widget', '3'],
        ['Gizmo', '7'],
      ]),
    ).toBe(false);
    expect(
      looksLikeHeader([
        ['Q1', 'Q2'],
        ['Q3', 'Q4'],
      ]),
    ).toBe(false);
  });
});

describe('CSV output', () => {
  it('escapes exactly what RFC 4180 says to escape', () => {
    expect(csvEscapeField('plain')).toBe('plain');
    expect(csvEscapeField('a,b')).toBe('"a,b"');
    expect(csvEscapeField('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscapeField('line1\nline2')).toBe('"line1\nline2"');
    expect(csvEscapeField('line1\r\nline2')).toBe('"line1\r\nline2"');
    expect(csvEscapeField('')).toBe('');
    expect(csvEscapeField('a;b', ';')).toBe('"a;b"');
    expect(rowToCsv(['a,b', 'ok', ''])).toBe('"a,b",ok,');
  });

  it('writes CRLF records and keeps placeholder cells', () => {
    const csv = tablesToCsv(detectTables(invoiceRows()));
    expect(csv.split('\r\n')).toEqual([
      'Item,Qty,Price',
      'Widget,3,$1.50',
      'Gizmo,7,',
      'Total,10,$10.50',
    ]);
  });

  it('several tables are separated by one blank record', () => {
    const rows = invoiceRows();
    const csv = tablesToCsv([
      ...detectTables(rows),
      ...detectTables(rows.map((run) => ({ ...run, page: 2, y: run.y + 400 }))),
    ]);
    expect(csv.split('\r\n\r\n')).toHaveLength(2);
  });

  it('tablesToAoa copies, so callers cannot mutate the table', () => {
    const [table] = detectTables(invoiceRows());
    const [aoa] = tablesToAoa([table]);
    aoa[0][0] = 'changed';
    expect(table.rows[0][0]).toBe('Item');
  });
});

describe('page frame geometry', () => {
  const landscape: PageFrame = { ...A4, rotation: 90 };

  it('viewerSizeOf swaps the box only for quarter turns', () => {
    expect(viewerSizeOf(A4)).toEqual({ width: 595.28, height: 841.89 });
    expect(viewerSizeOf(landscape)).toEqual({ width: 841.89, height: 595.28 });
    expect(viewerSizeOf({ ...A4, rotation: 180 })).toEqual({ width: 595.28, height: 841.89 });
  });

  it('viewerRectToUserSpace flips y for an unrotated page', () => {
    expect(viewerRectToUserSpace({ x: 10, y: 20, width: 30, height: 8 }, A4)).toEqual({
      x: 10,
      y: 841.89 - 28,
      width: 30,
      height: 8,
    });
  });

  it('maps a /Rotate 90 viewer box back to unrotated user space', () => {
    // The displayed top-left corner is the unrotated bottom-left corner.
    expect(viewerRectToUserSpace({ x: 0, y: 0, width: 4, height: 6 }, landscape)).toEqual({
      x: 0,
      y: 0,
      width: 6,
      height: 4,
    });
    // A box at the right edge of the displayed page sits at the top unrotated:
    // the displayed width *is* the unrotated height.
    expect(
      viewerRectToUserSpace({ x: 835.89, y: 0, width: 6, height: 4 }, landscape),
    ).toEqual({ x: 0, y: 835.89, width: 4, height: 6 });
  });

  it('round-trips through the SVG root matrix for every quarter turn', () => {
    for (const rotation of [0, 90, 180, 270] as const) {
      const frame: PageFrame = { ...A4, rotation };
      const viewer = viewerSizeOf(frame);
      expect(viewer.width).toBeGreaterThan(0);
      const rect = { x: 20, y: 30, width: 40, height: 12 };
      const user = viewerRectToUserSpace(rect, frame);
      const matrix = userSpaceToSvgMatrix(frame);
      const back = (x: number, y: number) => [
        matrix[0] * x + matrix[2] * y + matrix[4],
        matrix[1] * x + matrix[3] * y + matrix[5],
      ];
      // Corner names swap under a quarter turn, so compare the bounding box.
      const corners = [
        back(user.x, user.y),
        back(user.x + user.width, user.y),
        back(user.x, user.y + user.height),
        back(user.x + user.width, user.y + user.height),
      ];
      const xs = corners.map((c) => c[0]);
      const ys = corners.map((c) => c[1]);
      expect(Math.min(...xs)).toBeCloseTo(rect.x, 3);
      expect(Math.min(...ys)).toBeCloseTo(rect.y, 3);
      expect(Math.max(...xs)).toBeCloseTo(rect.x + rect.width, 3);
      expect(Math.max(...ys)).toBeCloseTo(rect.y + rect.height, 3);
    }
  });

  it('keeps a non-zero crop origin', () => {
    const offset: PageFrame = { x0: -12, y0: 6, width: 400, height: 600, rotation: 0 };
    const rect = viewerRectToUserSpace({ x: 0, y: 0, width: 10, height: 10 }, offset);
    expect(rect.x).toBeCloseTo(-12, 6);
    expect(rect.y + rect.height).toBeCloseTo(606, 6);
  });

  it('pageFrameOfView rejects unusable views', () => {
    expect(pageFrameOfView([0, 0, 10, 20], 90)).toEqual({
      x0: 0,
      y0: 0,
      width: 10,
      height: 20,
      rotation: 90,
    });
    expect(pageFrameOfView([0, 0, 10], 0)).toBeNull();
    expect(pageFrameOfView([0, 0, Number.NaN, 10], 0)).toBeNull();
    expect(pageFrameOfView(undefined, undefined)).toBeNull();
  });

  it('formats numbers for path data without -0 or float noise', () => {
    expect(fmtNumber(1.23456, 2)).toBe('1.23');
    expect(fmtNumber(-0.0001, 2)).toBe('0');
    expect(fmtNumber(Number.POSITIVE_INFINITY, 2)).toBe('0');
    expect(svgMatrix([1, 0, 0, -1, 0.0004, 841.8898], 2)).toBe('1 0 0 -1 0 841.89');
  });
});
