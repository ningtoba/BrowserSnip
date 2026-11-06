/**
 * Table detection from extracted text.
 *
 * Two independent strategies, both pure and canvas-free:
 *
 * 1. **Whitespace / projection mode** — rows come from baseline clustering of
 *    `ExtractedTextItem[]`, columns from an x-gap projection histogram over the
 *    row band. This is the mode that works on text-layer PDFs with no rules.
 * 2. **Ruled mode** — when `core/layout`-style vector lines are supplied, the
 *    grid comes from the rules themselves (column edges from vertical strokes,
 *    row edges from horizontal strokes) and text is bucketed into the cells.
 *
 * Everything here is coordinate-agnostic: it works in whatever user space the
 * caller extracted in. `ExtractedTextItem` boxes are *origin top-left of the
 * rotated page*, so `VectorLine` values must be in the same space (see
 * {@link VectorLine}).
 *
 * This module deliberately has no runtime `pdfjs-dist` import — only a type
 * import — so it stays loadable in jsdom tests.
 */
import type { ExtractedTextItem } from './render';

/** Axis-aligned rectangle in the caller's coordinate space. */
export interface QuadRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A straight vector stroke, in the same space as the text items. */
export interface VectorLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
}

/**
 * Unrotated page box plus its `/Rotate` — the whole description of a page
 * needed to convert between the four coordinate spaces this module group uses.
 */
export interface PageFrame {
  /** Crop-box origin in user space (non-zero on some scanned documents). */
  x0: number;
  y0: number;
  /** Unrotated width / height in user space. */
  width: number;
  height: number;
  /** `/Rotate`, degrees clockwise; only multiples of 90 are meaningful. */
  rotation: number;
}

/** A box with a **top-left** origin (raster pixels or rotated viewer space). */
export interface TopLeftBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DetectedTable {
  /** 1-based page number, copied from the items that produced the table. */
  page: number;
  rect: QuadRect;
  /** Rectangular: every row has exactly as many cells as the widest column set. */
  rows: string[][];
  /** 0..1 — see {@link scoreTable} and {@link ruledConfidence}. */
  confidence: number;
  /** Copy of `rows[0]` when it looks like a header rather than data. */
  headerRow?: string[];
}

export interface DetectTableOptions {
  /** Minimum rows for a block to count as a table. Default 2. */
  minRows?: number;
  /** Baseline clustering tolerance, in coordinate units. Default 3. */
  tolerance?: number;
  /** Use `lines` for a ruled grid when supplied. Default true. */
  useVectorLines?: boolean;
  /** Vector rules in the same space as `items` (ruled-table mode). */
  lines?: VectorLine[];
  /** Narrowest empty x-span that separates two columns. Default 6. */
  minColGap?: number;
  /** Histogram resolution. Default 1 (one unit per bin). */
  xBinSize?: number;
}

const DEFAULTS = {
  minRows: 2,
  tolerance: 3,
  minColGap: 6,
  xBinSize: 1,
} as const;

interface ResolvedOptions {
  minRows: number;
  tolerance: number;
  minColGap: number;
  xBinSize: number;
}

/** One visual line of text runs, ordered left to right by `x`. */
export interface TextRow {
  /** Baseline of the row: `y + height` of the average item in the row. */
  baseline: number;
  top: number;
  bottom: number;
  items: ExtractedTextItem[];
}

interface ColumnRange {
  start: number;
  end: number;
}

/**
 * Detect tables on the pages represented by `items`.
 *
 * Ruled grids win over whitespace grids when both are possible, and rows that
 * a ruled table already consumed are not offered to the whitespace pass.
 */
export function detectTables(
  items: ExtractedTextItem[],
  opts: DetectTableOptions = {},
): DetectedTable[] {
  const options: ResolvedOptions = {
    minRows: opts.minRows ?? DEFAULTS.minRows,
    tolerance: opts.tolerance ?? DEFAULTS.tolerance,
    minColGap: opts.minColGap ?? DEFAULTS.minColGap,
    xBinSize: opts.xBinSize ?? DEFAULTS.xBinSize,
  };
  const lines = opts.lines ?? [];
  const useVectorLines = opts.useVectorLines ?? lines.length > 0;

  const tables: DetectedTable[] = [];
  for (const [page, pageItems] of groupByPage(items)) {
    const rows = clusterRows(pageItems, options.tolerance);
    if (rows.length < options.minRows) continue;

    let remaining = rows;
    if (useVectorLines && lines.length > 0) {
      const ruled = ruledTables(page, rows, lines, options);
      if (ruled.length > 0) {
        tables.push(...ruled);
        remaining = dropRowsInside(rows, ruled);
      }
    }

    for (const block of splitBlocks(remaining, options.tolerance)) {
      const table = whitespaceTable(page, block, options);
      if (table) tables.push(table);
    }
  }
  return tables.sort((a, b) => a.page - b.page || a.rect.y - b.rect.y);
}

/** Every table in one RFC 4180 document: CRLF endings, tables split by a blank line. */
export function tablesToCsv(tables: DetectedTable[], delimiter = ','): string {
  return tables
    .map((table) => table.rows.map((row) => rowToCsv(row, delimiter)).join('\r\n'))
    .filter((chunk) => chunk.length > 0)
    .join('\r\n\r\n');
}

/** Array-of-arrays per table, which is what the spreadsheet writers want. */
export function tablesToAoa(tables: DetectedTable[]): string[][][] {
  return tables.map((table) => table.rows.map((row) => [...row]));
}

/**
 * RFC 4180 field escaping: quote when the field contains the delimiter, a
 * double quote, CR or LF; double every inner quote.
 */
export function csvEscapeField(value: string, delimiter = ','): string {
  const field = value ?? '';
  const mustQuote =
    field.includes(delimiter) ||
    field.includes('"') ||
    field.includes('\n') ||
    field.includes('\r');
  const escaped = field.replace(/"/g, '""');
  return mustQuote ? `"${escaped}"` : escaped;
}

/** Escape one row. Trailing cells are not trimmed: tables must stay rectangular. */
export function rowToCsv(row: string[], delimiter = ','): string {
  return row.map((cell) => csvEscapeField(cell, delimiter)).join(delimiter);
}

/**
 * Group runs into visual rows by baseline (`y + height`) within `tolerance`,
 * sorted top-to-bottom, each row's items sorted left-to-right.
 */
export function clusterRows(
  items: ExtractedTextItem[],
  tolerance: number = DEFAULTS.tolerance,
): TextRow[] {
  const rows: { baseline: number; items: ExtractedTextItem[] }[] = [];
  for (const item of items) {
    if (!isVisibleText(item)) continue;
    const baseline = Math.round((item.y + item.h) * 100) / 100;
    const match = rows.find((row) => Math.abs(row.baseline - baseline) <= tolerance);
    if (match) match.items.push(item);
    else rows.push({ baseline, items: [item] });
  }
  return rows
    .map((row) => {
      const sorted = [...row.items].sort((a, b) => a.x - b.x || a.y - b.y);
      const tops = sorted.map((i) => i.y);
      const bottoms = sorted.map((i) => i.y + i.h);
      return {
        baseline: row.baseline,
        top: Math.min(...tops),
        bottom: Math.max(...bottoms),
        items: sorted,
      };
    })
    .sort((a, b) => a.top - b.top || a.baseline - b.baseline);
}

/** True for runs that carry visible glyphs. Invisible runs are OCR layers. */
export function isVisibleText(item: ExtractedTextItem): boolean {
  return !item.isInvisible && typeof item.str === 'string' && item.str.trim().length > 0;
}

/**
 * x-gap projection histogram: bins the block's x-span, marks the bins covered
 * by any item, and returns the covered runs separated by at least `minGap`.
 */
export function columnsFromRows(
  rows: TextRow[],
  opts: { minColGap?: number; xBinSize?: number } = {},
): ColumnRange[] {
  const minGap = opts.minColGap ?? DEFAULTS.minColGap;
  const binSize = Math.max(0.05, opts.xBinSize ?? DEFAULTS.xBinSize);
  const items = rows.flatMap((row) => row.items);
  if (items.length === 0) return [];
  const minX = Math.min(...items.map((i) => i.x));
  const maxX = Math.max(...items.map((i) => i.x + i.w));
  if (!(maxX > minX)) return [];

  const bins = Math.max(1, Math.ceil((maxX - minX) / binSize));
  const covered = new Uint8Array(bins);
  for (const item of items) {
    const from = clampIndex(Math.floor((item.x - minX) / binSize), bins);
    const to = clampIndex(Math.ceil((item.x + item.w - minX) / binSize) - 1, bins);
    for (let b = from; b <= to; b++) covered[b] = 1;
  }

  const ranges: ColumnRange[] = [];
  const gapBins = Math.max(1, Math.round(minGap / binSize));
  let start = -1;
  let blank = 0;
  for (let b = 0; b < bins; b++) {
    if (covered[b]) {
      if (start === -1) start = b;
      blank = 0;
    } else if (start !== -1) {
      blank += 1;
      if (blank >= gapBins) {
        ranges.push({ start: minX + start * binSize, end: minX + (b - blank + 1) * binSize });
        start = -1;
        blank = 0;
      }
    }
  }
  if (start !== -1) ranges.push({ start: minX + start * binSize, end: maxX });
  return ranges;
}

/** Rectangular cell matrix for `rows` given fixed `columns` (missing cells ''). */
export function gridRows(rows: TextRow[], columns: ColumnRange[]): string[][] {
  return rows.map((row) => gridRow(row, columns));
}

/** One row as a rectangular cell array (see {@link gridRows}). */
export function gridRow(row: TextRow, columns: ColumnRange[]): string[] {
  const cells: string[][] = columns.map(() => []);
  for (const item of row.items) {
    const center = item.x + item.w / 2;
    const index = columnIndexFor(columns, center, item);
    if (index >= 0) cells[index].push(item.str);
  }
  return cells.map((parts) => parts.join(' ').replace(/\s+/g, ' ').trim());
}

function columnIndexFor(columns: ColumnRange[], center: number, item: ExtractedTextItem): number {
  for (let i = 0; i < columns.length; i++) {
    if (center >= columns[i].start && center <= columns[i].end) return i;
  }
  // Overlapping or slightly-outside runs: pick the column with the biggest
  // horizontal overlap, which is what a human reading the page would say.
  let best = -1;
  let bestOverlap = 0;
  for (let i = 0; i < columns.length; i++) {
    const overlap = Math.min(item.x + item.w, columns[i].end) - Math.max(item.x, columns[i].start);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = i;
    }
  }
  if (best >= 0) return best;
  let nearest = 0;
  let nearestDistance = Infinity;
  columns.forEach((column, i) => {
    const distance = Math.min(Math.abs(center - column.start), Math.abs(center - column.end));
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = i;
    }
  });
  return nearest;
}

/**
 * Whitespace-mode confidence in 0..1: how many rows really span multiple
 * columns (50 %), how well run edges line up with column starts (35 %) and how
 * deep the block is (15 %).
 */
export function scoreTable(rows: string[][], minRows: number = DEFAULTS.minRows): number {
  if (rows.length === 0) return 0;
  const columns = rows[0].length;
  if (columns < 2) return 0;
  const multi = rows.filter((row) => row.filter((cell) => cell.trim() !== '').length >= 2).length;
  const consistency = multi / rows.length;
  const depth = Math.min(1, (rows.length - minRows + 1) / 4);
  const filled = rows.flatMap((row) => row.map((cell, index) => ({ cell, index })));
  const populated = filled.filter((entry) => entry.cell.trim() !== '');
  const density = populated.length / Math.max(1, rows.length * columns);
  return clamp01(0.5 * consistency + 0.3 * density + 0.2 * depth);
}

/**
 * Ruled-mode confidence: a complete grid is trustworthy, and how much of it
 * holds text only nudges the score.
 */
export function ruledConfidence(rows: string[][], columnCount: number): number {
  const cells = Math.max(1, rows.length * columnCount);
  const filled = rows.reduce((n, row) => n + row.filter((c) => c.trim() !== '').length, 0);
  return clamp01(0.7 + 0.3 * (filled / cells));
}

/** Header heuristic: a first row of short non-numeric labels over numeric data. */
export function looksLikeHeader(rows: string[][]): boolean {
  if (rows.length < 2) return false;
  const [first, ...body] = rows;
  if (first.some((cell) => cell.trim() === '')) return false;
  const numeric = (value: string) => /^[-+($]*\d[\d.,\s%)]*[)]?$/.test(value.trim());
  const firstNumeric = first.filter(numeric).length;
  const bodyNumeric = body.reduce((n, row) => n + row.filter(numeric).length, 0);
  const bodyCells = body.reduce((n, row) => n + row.length, 0);
  if (firstNumeric > 0 && firstNumeric >= first.length / 2) return false;
  return bodyNumeric / Math.max(1, bodyCells) >= 0.34;
}

/** Cluster near-coincident rule coordinates (rules are rarely exactly equal). */
export function clusterEdges(values: number[], tolerance: number): number[] {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  const clusters: { mean: number; count: number }[] = [];
  for (const value of sorted) {
    const last = clusters[clusters.length - 1];
    if (!last || Math.abs(last.mean - value) > Math.max(tolerance, 1)) {
      clusters.push({ mean: value, count: 1 });
    } else {
      last.mean = (last.mean * last.count + value) / (last.count + 1);
      last.count += 1;
    }
  }
  return clusters.map((cluster) => round(cluster.mean, 2)).sort((a, b) => a - b);
}

/** Split rules into vertical / horizontal edges, snapping near-duplicates. */
export function ruleEdges(
  lines: VectorLine[],
  opts: { tolerance?: number } = {},
): { vertical: number[]; horizontal: number[] } {
  const tolerance = opts.tolerance ?? 1;
  const vertical: number[] = [];
  const horizontal: number[] = [];
  for (const line of lines) {
    const dx = Math.abs(line.x2 - line.x1);
    const dy = Math.abs(line.y2 - line.y1);
    if (dx + dy === 0) continue;
    if (dx <= dy) vertical.push((line.x1 + line.x2) / 2);
    else horizontal.push((line.y1 + line.y2) / 2);
  }
  return {
    vertical: clusterEdges(vertical, tolerance),
    horizontal: clusterEdges(horizontal, tolerance),
  };
}

/**
 * Bucket `rows` into the rectangle grid defined by `xs` (column edges) and
 * `ys` (row edges). Rows/columns with no edge pair are skipped, so a table with
 * a missing rule still yields a grid rather than nothing.
 */
export function gridFromRules(
  rows: TextRow[],
  xs: number[],
  ys: number[],
): string[][] {
  const columns = Math.max(0, xs.length - 1);
  const rowCount = Math.max(0, ys.length - 1);
  if (columns < 1 || rowCount < 1) return [];
  const cells: string[][][] = Array.from({ length: rowCount }, () =>
    Array.from({ length: columns }, () => [] as string[]),
  );
  const rangeColumns = xs.slice(0, -1).map((start, i) => ({ start, end: xs[i + 1] }));
  for (const row of rows) {
    const centerY = (row.top + row.bottom) / 2;
    const rowIndex = indexOfRange(ys, centerY);
    if (rowIndex < 0) continue;
    for (const item of row.items) {
      const center = item.x + item.w / 2;
      const columnIndex = indexOfRange(xs, center);
      if (columnIndex < 0) continue;
      const assigned = columnIndexFor(rangeColumns, center, item);
      if (assigned >= 0) cells[rowIndex][assigned].push(item.str);
    }
  }
  return cells.map((row) => row.map((parts) => parts.join(' ').replace(/\s+/g, ' ').trim()));
}

function indexOfRange(edges: number[], value: number): number {
  for (let i = 0; i < edges.length - 1; i++) {
    if (value >= edges[i] && value <= edges[i + 1]) return i;
  }
  return -1;
}

function ruledTables(
  page: number,
  rows: TextRow[],
  lines: VectorLine[],
  options: ResolvedOptions,
): DetectedTable[] {
  const { vertical, horizontal } = ruleEdges(lines, { tolerance: options.tolerance });
  if (vertical.length < 2 || horizontal.length < options.minRows + 1) return [];
  // A ruled table needs at least two columns of rules to be a table at all.
  const grid = gridFromRules(rows, vertical, horizontal);
  const widest = Math.max(...grid.map((row) => row.length), 0);
  if (widest < 2) return [];
  const filled = grid.reduce((n, row) => n + row.filter((cell) => cell.trim() !== '').length, 0);
  if (filled < options.minRows * 2) return [];
  const rowsOut = rectangular(grid);
  const table: DetectedTable = {
    page,
    rect: {
      x: vertical[0],
      y: horizontal[0],
      width: vertical[vertical.length - 1] - vertical[0],
      height: horizontal[horizontal.length - 1] - horizontal[0],
    },
    rows: rowsOut,
    confidence: ruledConfidence(rowsOut, widest),
  };
  const header = headerRowOf(rowsOut);
  if (header) table.headerRow = header;
  return [table];
}

/**
 * Whitespace-mode table for one contiguous block of rows, or `null` when the
 * block is really prose (fewer than two columns, or too few rows).
 */
function whitespaceTable(
  page: number,
  rows: TextRow[],
  options: ResolvedOptions,
): DetectedTable | null {
  if (rows.length < options.minRows) return null;
  const columns = columnsFromRows(rows, {
    minColGap: options.minColGap,
    xBinSize: options.xBinSize,
  });
  if (columns.length < 2) return null;
  const grid = rectangular(gridRows(rows, columns));
  const confidence = scoreTable(grid, options.minRows);
  const multi = grid.filter((row) => row.filter((cell) => cell.trim() !== '').length >= 2).length;
  if (confidence < 0.3 || multi < Math.max(options.minRows, Math.ceil(grid.length / 3))) return null;
  const items = rows.flatMap((row) => row.items);
  const table: DetectedTable = {
    page,
    rect: {
      x: Math.min(...items.map((i) => i.x)),
      y: Math.min(...items.map((i) => i.y)),
      width:
        Math.max(...items.map((i) => i.x + i.w)) - Math.min(...items.map((i) => i.x)),
      height:
        Math.max(...items.map((i) => i.y + i.h)) - Math.min(...items.map((i) => i.y)),
    },
    rows: grid,
    confidence,
  };
  const header = headerRowOf(grid);
  if (header) table.headerRow = header;
  return table;
}

function headerRowOf(rows: string[][]): string[] | undefined {
  return rows.length >= 2 && looksLikeHeader(rows) ? [...rows[0]] : undefined;
}

/** Pad every row to the widest one with '' placeholders. */
function rectangular(rows: string[][]): string[][] {
  const width = Math.max(0, ...rows.map((row) => row.length));
  return rows.map((row) => [...row, ...Array.from({ length: width - row.length }, () => '')]);
}

/**
 * Split a page's rows into blocks separated by a vertical gap larger than the
 * text height, so a heading and a table below it are not one table.
 */
function splitBlocks(rows: TextRow[], tolerance: number): TextRow[][] {
  const blocks: TextRow[][] = [];
  let current: TextRow[] = [];
  let previous: TextRow | null = null;
  for (const row of rows) {
    const height = Math.max(1, row.bottom - row.top);
    const gap = previous ? row.top - previous.bottom : 0;
    const startsNew = previous !== null && gap > height * 2.6 + tolerance;
    if (startsNew) {
      blocks.push(current);
      current = [];
    }
    current.push(row);
    previous = row;
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

/** Rows whose vertical centre falls inside one of `tables` (already ruled). */
function dropRowsInside(rows: TextRow[], tables: DetectedTable[]): TextRow[] {
  if (tables.length === 0) return rows;
  return rows.filter((row) => {
    const centerY = (row.top + row.bottom) / 2;
    return !tables.some(
      (table) => centerY >= table.rect.y && centerY <= table.rect.y + table.rect.height,
    );
  });
}

function groupByPage(items: ExtractedTextItem[]): Map<number, ExtractedTextItem[]> {
  const byPage = new Map<number, ExtractedTextItem[]>();
  for (const item of items) {
    const page = item.page;
    const bucket = byPage.get(page);
    if (bucket) bucket.push(item);
    else byPage.set(page, [item]);
  }
  return new Map([...byPage.entries()].sort((a, b) => a[0] - b[0]));
}

function clampIndex(value: number, bins: number): number {
  return Math.min(bins - 1, Math.max(0, value));
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Normalise `/Rotate` to a clockwise multiple of 90 in `[0, 360)`.
 */
export function quarterTurn(rotation: number): 0 | 90 | 180 | 270 {
  const r = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;
  return r as 0 | 90 | 180 | 270;
}

/** Displayed (rotated) size of a page frame, in the frame's own units. */
export function viewerSizeOf(frame: PageFrame): { width: number; height: number } {
  return quarterTurn(frame.rotation) % 180 === 90
    ? { width: frame.height, height: frame.width }
    : { width: frame.width, height: frame.height };
}

/**
 * Map a top-left-origin rect in *rotated viewer* space to unrotated PDF user
 * space with a bottom-left origin.
 *
 * Derived from the four quarter-turn viewer transforms, where `W`/`H` are the
 * unrotated page dimensions, `rx`/`ry` the user coordinates relative to the
 * frame origin, and viewer y grows downwards:
 *
 * | /Rotate | viewer x | viewer y |
 * | ------- | -------- | -------- |
 * | 0       | `rx`     | `H - ry` |
 * | 90      | `ry`     | `rx`     |
 * | 180     | `W - rx` | `ry`     |
 * | 270     | `H - ry` | `W - rx` |
 *
 * The inverse of each is applied to all four corners and the box is re-bound,
 * so any axis-aligned box survives every rotation.
 */
export function viewerRectToUserSpace(rect: TopLeftBox, frame: PageFrame): QuadRect {
  const rot = quarterTurn(frame.rotation);
  const W = frame.width;
  const H = frame.height;
  const map = (px: number, py: number): [number, number] => {
    switch (rot) {
      case 90:
        return [frame.x0 + py, frame.y0 + px];
      case 180:
        return [frame.x0 + (W - px), frame.y0 + py];
      case 270:
        return [frame.x0 + (W - py), frame.y0 + (H - px)];
      default:
        return [frame.x0 + px, frame.y0 + (H - py)];
    }
  };
  const corners = [
    map(rect.x, rect.y),
    map(rect.x + rect.width, rect.y),
    map(rect.x, rect.y + rect.height),
    map(rect.x + rect.width, rect.y + rect.height),
  ];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  return {
    x: round(Math.min(...xs), 4),
    y: round(Math.min(...ys), 4),
    width: round(Math.max(...xs) - Math.min(...xs), 4),
    height: round(Math.max(...ys) - Math.min(...ys), 4),
  };
}

/**
 * The root `<g transform="matrix(...)">` that turns unrotated PDF user space
 * into SVG output space (origin top-left, y down) for a page's `/Rotate`.
 * This is the forward direction of {@link viewerRectToUserSpace}.
 */
export function userSpaceToSvgMatrix(frame: PageFrame): number[] {
  const rot = quarterTurn(frame.rotation);
  const W = frame.width;
  const H = frame.height;
  // [a b c d e f] with u = a·x + c·y + e, v = b·x + d·y + f.
  switch (rot) {
    case 90:
      return [0, 1, 1, 0, -frame.y0, -frame.x0];
    case 180:
      return [-1, 0, 0, 1, W + frame.x0, -frame.y0];
    case 270:
      return [0, -1, -1, 0, H + frame.y0, W + frame.x0];
    default:
      return [1, 0, 0, -1, -frame.x0, H + frame.y0];
  }
}

/**
 * Build a {@link PageFrame} from a pdf.js page proxy's `view` / `rotate` pair.
 * Returns `null` when the view is missing or not four finite numbers, so the
 * caller can substitute geometry from another source (pdf-lib, a viewport).
 */
export function pageFrameOfView(
  view: readonly number[] | undefined,
  rotation: number | undefined,
): PageFrame | null {
  if (!view || view.length !== 4) return null;
  const [x0, y0, x1, y1] = view.map(Number);
  if (![x0, y0, x1, y1].every(Number.isFinite)) return null;
  return {
    x0,
    y0,
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
    rotation: Number.isFinite(rotation as number) ? (rotation as number) : 0,
  };
}

/** Format a pdf-lib/`matrix()` argument list the way SVG expects. */
export function svgMatrix(values: number[], precision = 3): string {
  return values.map((value) => fmtNumber(value, precision)).join(' ');
}

/** Round to `digits` and drop `-0`. */
export function fmtNumber(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = round(value, digits);
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

