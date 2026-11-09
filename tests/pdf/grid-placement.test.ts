/**
 * Every grid tool: does the content it lays out land **on the paper**?
 *
 * `n-up` numbered its cells from the start of the run instead of the start of the
 * sheet (`cells.push({ cell })` against `gridBox`, which derives
 * `row = floor(cell / columns)` from a within-sheet cell), so a 4-up of an 8-page
 * document produced sheet 1 correctly and then drew sheet 2 one row **below** the
 * media box, sheet 3 two rows below. Measured at `63df7d4` on the bytes this file
 * builds — 8 inked sheets, `perSheet: 4`, A4 landscape, no gutter, no margin
 * (`/MediaBox [0 0 841.89 595.28]`, so the paper runs y 0 → 595.28):
 *
 * | output sheet | the `cm` each placed page runs under                                                          | where that is  |
 * | ------------ | ------------------------------------------------------------------------------------------------------------- | -------------- |
 * | 1            | `… 95.99 297.64 cm`, `… 511.21 297.64 cm`, `… 84.54 0 cm`, `… 499.76 0 cm`                                     | on the paper   |
 * | 2            | `… 73.10 -297.64 cm`, `… 488.32 -297.64 cm`, `… 61.65 -595.28 cm`, `… 476.87 -595.28 cm`                       | below it       |
 *
 * Nothing throws: a form placed at y ∈ [-297.64, 0] is legal PDF, it is simply
 * outside the visible page, which is why the page count (2 sheets, correct) and
 * the run's own sentence ("Placed 8 pages on 2 sheets") both said nothing, and why
 * the live proof measured `0.000 %` ink on every sheet after the first. Rasterised
 * the way this file rasterises, sheet 2 of that run measures **0 px of ink inside
 * the page box and 1 079 px under it**, while the same tool asked for a hairline
 * border draws its four rules *on* the paper (31 439 px) over four empty cells.
 *
 * So the assertions here are geometry and pixels, never counts:
 *
 * 1. every form a sheet draws has to **overlap that sheet's own `/MediaBox` with
 *    positive area** — touching an edge is not visible;
 * 2. rasterising the sheet has to find **ink inside** the media box and **none
 *    outside** it. The raster is a pixel grid over the page's user space: content
 *    operators walked through the graphics state, recursing into form XObjects and
 *    clipped to their `/BBox`, which is the clipping a viewer applies and the only
 *    reason off-page content is invisible rather than merely misplaced. jsdom has
 *    no 2-D canvas, so this is the render available here — a gate (some ink versus
 *    none, on the page versus off it) in the spirit of
 *    `tests/pdf/appearance-harness.ts`, and deliberately blind to glyph advances
 *    and colour, neither of which can move ink across a page edge;
 * 3. for `n-up`, each cell's expected rect is recomputed **here** from the sheet
 *    size, so a regression that keeps content on the paper but in the wrong cell
 *    does not pass.
 *
 * The same predicate then runs over every neighbour that lays out a grid —
 * `booklet`, `posterize`, `divide-pages`, `combine-single-page` — because "off the
 * page" is invisible to any count-based assertion; and over one shared primitive
 * (`drawPageInto` in `core/doc.ts`, the twin of `stamp` in `tools/organize.ts`)
 * that had the same confusion on its **target** side: it read the caller's box as
 * user-space coordinates, so a sheet whose `/MediaBox` starts at (36, 36) took a
 * cell aimed at its own bottom-left corner and drew it 36 pt off the page —
 * measured before the fix as `q 1 0 0 1 0 1.8 cm … Do` on that very sheet.
 */
import { describe, expect, it } from 'vitest';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFStream,
  StandardFonts,
  rgb,
} from '@maxwbh/pdf-lib';
import type { PDFPage } from '@maxwbh/pdf-lib';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { runPdfTool, type RunOutcome } from '@/lib/pdf/tools/runner';
import { pageContentStreams, parseContentStream, streamBytes } from '@/lib/pdf/core/content';
import { cropBox, mediaBox } from '@/lib/pdf/core/pages';
import { drawPageInto, newPDF, openPDF, savePDF } from '@/lib/pdf/core/doc';

/* ── the input: sheets that can be told apart by their own bytes ──────────── */

/**
 * `count` inked sheets, each a **different width** (200 + 10·i pt) and each with
 * real content — a text run plus a filled square in each quadrant.
 *
 * The width is the page's identity: the form XObject a grid tool writes carries
 * the source sheet in its `/BBox`, so a test can say "page 5 landed in cell 1 of
 * sheet 2" out of the file without trusting any bookkeeping.
 */
async function inkedSheets(count: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < count; index++) {
    const width = 200 + index * 10;
    const height = 260;
    const page = doc.addPage([width, height]);
    page.drawText(`page ${index + 1} ink`, { x: 20, y: height * 0.7, size: 18, font, color: rgb(0, 0, 0) });
    // One mark in each quadrant, so a tool that cuts the sheet in four has ink to
    // show for every piece — an empty tile cannot tell "clipped away" from "gone".
    for (const [fx, fy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]] as const) {
      page.drawRectangle({ x: width * fx - 10, y: height * fy - 10, width: 20, height: 20, color: rgb(0, 0, 0) });
    }
  }
  return doc.save({ useObjectStreams: false });
}

const asFile = (bytes: Uint8Array): File =>
  new File([new Uint8Array(bytes) as BlobPart], 'sheets.pdf', { type: 'application/pdf' });

async function runTool(toolId: string, bytes: Uint8Array, values: Record<string, unknown>): Promise<RunOutcome> {
  const tool = getPdfTool(toolId);
  expect(tool, `tool "${toolId}" is not registered`).toBeTruthy();
  return runPdfTool({
    toolId: tool!.id,
    files: [asFile(bytes)],
    values,
    onProgress: () => undefined,
    onLog: () => undefined,
  });
}

/** Runs the tool, re-opens what it wrote, and pins the sheet count first. */
async function produce(toolId: string, bytes: Uint8Array, values: Record<string, unknown>, sheets: number) {
  const outcome = await runTool(toolId, bytes, values);
  expect(outcome.outputs.length, `${toolId} wrote no file`).toBeGreaterThan(0);
  const out = await openPDF(new Uint8Array(await outcome.outputs[0].blob.arrayBuffer()));
  expect(out.getPageCount(), `${toolId} sheet count`).toBe(sheets);
  return out;
}

/* ── matrices, rects, and what a page actually draws ─────────────────────── */

type Matrix = [number, number, number, number, number, number];
interface Rect { x: number; y: number; width: number; height: number }

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `a` then `b`; PDF's `cm` post-multiplies, which is the order this composes in. */
function compose(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function mapPoint(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** The axis-aligned device-space box of a user-space rect turned by `m`. */
function mapRect(m: Matrix, rect: Rect): Rect {
  const corners = [
    mapPoint(m, rect.x, rect.y),
    mapPoint(m, rect.x + rect.width, rect.y),
    mapPoint(m, rect.x, rect.y + rect.height),
    mapPoint(m, rect.x + rect.width, rect.y + rect.height),
  ];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Overlap of two rects; `null` when they only touch along an edge. */
function overlap(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const top = Math.min(a.y + a.height, b.y + b.height);
  if (right - x <= 1e-6 || top - y <= 1e-6) return null;
  return { x, y, width: right - x, height: top - y };
}

const round = (value: number): number => Math.round(value * 100) / 100;
const fmtRect = (rect: Rect): string =>
  `[${round(rect.x)}, ${round(rect.y)} ${round(rect.width)}×${round(rect.height)}]`;

const numbersOf = (operands: { kind: string; value?: unknown }[]): number[] =>
  operands.filter((o) => o.kind === 'number').map((o) => Number(o.value));

const nameOf = (operands: { kind: string; value?: unknown }[]): string | null => {
  const first = operands.find((o) => o.kind === 'name');
  return first ? String(first.value) : null;
};

/** Follows a dictionary value (inline or referenced) to the dictionary itself. */
function asDict(doc: PDFDocument, value: unknown): PDFDict | null {
  if (value === undefined || value === null) return null;
  const found = value instanceof PDFDict ? value : doc.context.lookup(value as never);
  return found instanceof PDFDict ? found : null;
}

/** The dictionary under `/key` of `owner`, or null when the key is absent. */
function dictAt(doc: PDFDocument, owner: PDFDict | null, key: string): PDFDict | null {
  return asDict(doc, owner?.get(PDFName.of(key)));
}

/** The `/XObject` map a `Do` in this stream's resources resolves against. */
function xobjectsOf(doc: PDFDocument, owner: PDFPage | PDFStream): PDFDict | null {
  const resources = owner instanceof PDFStream
    ? dictAt(doc, owner.dict, 'Resources')
    : asDict(doc, owner.node.Resources());
  return dictAt(doc, resources, 'XObject');
}

/** A stream's `/BBox` and `/Matrix`, the two numbers that place it. */
function formGeometry(doc: PDFDocument, object: PDFStream): { box: Rect; matrix: Matrix } | null {
  const box = object.dict.get(PDFName.of('BBox'));
  if (!(box instanceof PDFArray)) return null;
  const [bx = 0, by = 0, bw = 0, bh = 0] = coordsOf(box);
  const raw = object.dict.get(PDFName.of('Matrix'));
  const matrix = raw instanceof PDFArray ? (coordsOf(raw).slice(0, 6) as Matrix) : IDENTITY;
  return { box: { x: bx, y: by, width: bw - bx, height: bh - by }, matrix };
}

function coordsOf(array: PDFArray): number[] {
  return Array.from({ length: array.size() }, (_, i) => Number(array.get(i).toString()));
}

const isForm = (object: PDFStream): boolean =>
  String(object.dict.get(PDFName.of('Subtype')) ?? '').includes('Form');

interface Placed {
  /** The name the page draws it under, in draw order. */
  name: string;
  /** The source sheet's own size, read from the form's `/BBox`. */
  source: { width: number; height: number };
  /** Where the form lands in the page's user space, through `/Matrix` and the CTM. */
  rect: Rect;
}

/**
 * Everything the page itself places: each `Do` of a form XObject, resolved to the
 * device-space rect it occupies.
 *
 * These tools impose pages as forms, so this is *the* placement record — what a
 * viewer clips to the media box and shows.
 */
function placedOn(doc: PDFDocument, index: number): Placed[] {
  const page = doc.getPages()[index];
  const forms = xobjectsOf(doc, page);
  if (!forms) return [];
  const out: Placed[] = [];
  for (const stream of pageContentStreams(page)) {
    let ctm: Matrix = IDENTITY;
    const stack: Matrix[] = [];
    for (const op of parseContentStream(stream.bytes)) {
      if (op.name === 'q') stack.push(ctm);
      else if (op.name === 'Q') ctm = stack.pop() ?? IDENTITY;
      else if (op.name === 'cm') ctm = compose(ctm, numbersOf(op.operands) as Matrix);
      else if (op.name === 'Do') {
        const name = nameOf(op.operands);
        const object = name ? formNamed(doc, forms, name) : null;
        if (!object || !isForm(object)) continue;
        const geometry = formGeometry(doc, object);
        if (!geometry) continue;
        out.push({
          name: name!,
          source: { width: geometry.box.width, height: geometry.box.height },
          rect: mapRect(compose(ctm, geometry.matrix), geometry.box),
        });
      }
    }
  }
  return out;
}

/** Resolves one `/XObject` name. */
function formNamed(doc: PDFDocument, forms: PDFDict, name: string): PDFStream | null {
  const found = doc.context.lookup(forms.get(PDFName.of(name))!);
  return found instanceof PDFStream ? found : null;
}

/* ── the raster: pixels a viewer would find inside the page's own box ─────── */

/** Coarse on purpose: the gate is "some ink", and every sheet is a few hundred pt. */
const PX_PER_PT = 0.25;
/** How far past the media box the grid reaches, to see ink drawn off the paper. */
const PAD_PT = 500;

interface Raster {
  /** Painted pixels **inside** the media box. */
  inside: number;
  /** Painted pixels **outside** it — content on its way off the page. */
  outside: number;
}

/**
 * Rasterises a page onto a pixel grid covering its media box plus `PAD_PT` on
 * every side, and counts the painted pixels either side of the page edge.
 *
 * Form `/BBox` clipping is applied, because a viewer applies it; the media box is
 * **not** a clip here but the window being measured, since a page can legally hold
 * operators the paper never shows.
 */
function rasterise(doc: PDFDocument, index: number): Raster {
  const page = doc.getPages()[index];
  const box = mediaBox(page);
  const left = box.x - PAD_PT;
  const bottom = box.y - PAD_PT;
  const columns = Math.ceil((box.width + PAD_PT * 2) * PX_PER_PT);
  const rows = Math.ceil((box.height + PAD_PT * 2) * PX_PER_PT);
  const grid = new Uint8Array(columns * rows);
  const columnOf = (x: number) => Math.floor((x - left) * PX_PER_PT);
  const rowOf = (y: number) => rows - 1 - Math.floor((y - bottom) * PX_PER_PT);
  const edgeLeft = columnOf(box.x);
  const edgeRight = columnOf(box.x + box.width);
  const edgeTop = rowOf(box.y + box.height);
  const edgeBottom = rowOf(box.y);
  for (const mark of paintedRects(doc, index)) {
    const x0 = clamp(columnOf(mark.x), 0, columns - 1);
    const x1 = clamp(columnOf(mark.x + mark.width), 0, columns - 1);
    const y0 = clamp(rowOf(mark.y + mark.height), 0, rows - 1);
    const y1 = clamp(rowOf(mark.y), 0, rows - 1);
    for (let row = y0; row <= y1; row++) {
      const onPaperRow = row >= edgeTop && row <= edgeBottom;
      for (let column = x0; column <= x1; column++) {
        const onPaper = onPaperRow && column >= edgeLeft && column <= edgeRight;
        grid[row * columns + column] = onPaper ? 1 : 2;
      }
    }
  }
  let inside = 0;
  let outside = 0;
  for (const value of grid) {
    if (value === 1) inside += 1;
    else if (value === 2) outside += 1;
  }
  return { inside, outside };
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/**
 * Every rect the page's content paints, in user space, clipped to the form each
 * one lives in.
 *
 * Walks the operators with the graphics state (`q`/`Q`/`cm`), recurses through
 * `Do` into form XObjects — a placed sheet's ink lives one level down — and takes
 * a shown text run as `0.5 em` per character at the active size, because advances
 * live in a font program this does not open and no glyph of a legible run sits at
 * zero width. A path is measured as the box its points enclose. Neither shortcut
 * can put ink where the file drew none.
 */
function paintedRects(doc: PDFDocument, index: number): Rect[] {
  const marks: Rect[] = [];
  const walk = (
    streams: { bytes: Uint8Array }[],
    ctm: Matrix,
    forms: PDFDict | null,
    clip: Rect | null,
    depth: number,
  ): void => {
    if (depth > 4) return;
    const plot = (rect: Rect): void => {
      const visible = clip ? overlap(rect, clip) : rect;
      if (visible) marks.push(visible);
    };
    for (const stream of streams) {
      let state = ctm;
      const stack: Matrix[] = [];
      let path: Rect[] = [];
      let fontSize = 0;
      let textLine = 0;
      let text = IDENTITY;
      for (const op of parseContentStream(stream.bytes)) {
        const args = numbersOf(op.operands);
        switch (op.name) {
          case 'q':
            stack.push(state);
            break;
          case 'Q':
            state = stack.pop() ?? ctm;
            break;
          case 'cm':
            if (args.length === 6) state = compose(state, args as Matrix);
            break;
          case 're':
            if (args.length === 4) {
              const [x, y, w, h] = args;
              path.push(mapRect(state, { x, y, width: w, height: h }));
            }
            break;
          case 'm':
          case 'l':
            if (args.length === 2) {
              const [x, y] = mapPoint(state, args[0], args[1]);
              path.push({ x, y, width: 0, height: 0 });
            }
            break;
          case 'c':
          case 'v':
          case 'y':
            for (let i = 0; i + 1 < args.length; i += 2) {
              const [x, y] = mapPoint(state, args[i], args[i + 1]);
              path.push({ x, y, width: 0, height: 0 });
            }
            break;
          case 'f':
          case 'f*':
          case 'B':
          case 'B*':
          case 'b':
          case 'b*':
          case 'S':
          case 's': {
            const painted = pathBox(path);
            if (painted) plot(painted);
            path = [];
            break;
          }
          case 'n':
            path = [];
            break;
          case 'BT':
            text = state;
            textLine = 0;
            break;
          case 'Tf':
            if (args.length) fontSize = args[args.length - 1];
            break;
          case 'Tm':
            if (args.length === 6) text = compose(state, args as Matrix);
            break;
          case 'TL':
            if (args.length) textLine = args[0];
            break;
          case 'Td':
            if (args.length === 2) text = compose(text, [1, 0, 0, 1, args[0], args[1]]);
            break;
          case 'TD':
            if (args.length === 2) {
              textLine = -args[1];
              text = compose(text, [1, 0, 0, 1, args[0], args[1]]);
            }
            break;
          case 'T*':
            text = compose(text, [1, 0, 0, 1, 0, -textLine]);
            break;
          case 'Tj':
          case 'TJ':
          case "'":
          case '"': {
            if (op.name === "'" || op.name === '"') text = compose(text, [1, 0, 0, 1, 0, -textLine]);
            const chars = glyphsOf(op.operands);
            if (chars > 0 && fontSize > 0) {
              plot(mapRect(text, { x: 0, y: 0, width: 0.5 * fontSize * chars, height: fontSize }));
            }
            break;
          }
          case 'Do': {
            const name = nameOf(op.operands);
            const object = name && forms ? formNamed(doc, forms, name) : null;
            if (!object) break;
            const geometry = formGeometry(doc, object);
            const box = geometry?.box ?? { x: 0, y: 0, width: 1, height: 1 };
            const inner = geometry ? compose(state, geometry.matrix) : state;
            const device = mapRect(inner, box);
            if (!isForm(object)) {
              // An image fills the unit square the caller placed it in.
              plot(device);
              break;
            }
            const nested = xobjectsOf(doc, object);
            const parentClip = clip ? overlap(clip, device) : device;
            if (parentClip) walk([{ bytes: streamBytes(object) }], inner, nested, parentClip, depth + 1);
            break;
          }
          default:
            break;
        }
      }
    }
  };
  walk(pageContentStreams(doc.getPages()[index]), IDENTITY, xobjectsOf(doc, doc.getPages()[index]), null, 0);
  return marks;
}

/** The box enclosing a path's points; a lone move point paints nothing. */
function pathBox(path: Rect[]): Rect | null {
  if (path.length === 0) return null;
  const boxes = path.filter((p) => p.width !== 0 || p.height !== 0);
  const nodes = boxes.length ? boxes : path;
  const xs = nodes.flatMap((p) => [p.x, p.x + p.width]);
  const ys = nodes.flatMap((p) => [p.y, p.y + p.height]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Characters a show operator runs through; `TJ` kerning numbers are not glyphs. */
function glyphsOf(operands: { kind: string; bytes?: Uint8Array; items?: { kind: string; bytes?: Uint8Array }[] }[]): number {
  let total = 0;
  for (const operand of operands) {
    if (operand.kind === 'string') total += operand.bytes?.length ?? 0;
    if (operand.kind === 'array') {
      for (const item of operand.items ?? []) if (item.kind === 'string') total += item.bytes?.length ?? 0;
    }
  }
  return total;
}

/** The `re` rectangles a page's own stream draws, in user space. */
function drawnRules(doc: PDFDocument, index: number): Rect[] {
  const out: Rect[] = [];
  for (const stream of pageContentStreams(doc.getPages()[index])) {
    let state: Matrix = IDENTITY;
    const stack: Matrix[] = [];
    for (const op of parseContentStream(stream.bytes)) {
      if (op.name === 'q') stack.push(state);
      else if (op.name === 'Q') state = stack.pop() ?? IDENTITY;
      else if (op.name === 'cm') state = compose(state, numbersOf(op.operands) as Matrix);
      else if (op.name === 're') {
        const [x, y, w, h] = numbersOf(op.operands);
        out.push(mapRect(state, { x, y, width: w, height: h }));
      }
    }
  }
  return out;
}

/* ── the rule every sheet of every grid tool has to satisfy ──────────────── */

function expectOnThePaper(doc: PDFDocument, toolId: string) {
  doc.getPages().forEach((page, index) => {
    const sheet = mediaBox(page);
    const placed = placedOn(doc, index);
    expect(placed.length, `${toolId}: ${sheetLabel(index)} places nothing at all`).toBeGreaterThan(0);
    const ink = rasterise(doc, index);
    const offSheet = placed.filter((form) => !overlap(form.rect, sheet));
    expect(
      offSheet.map((form) => `${round(form.source.width)}×${round(form.source.height)} pt sheet at ${fmtRect(form.rect)}`),
      `${toolId}: ${sheetLabel(index)} draws ${offSheet.length} page(s) outside its own media box ${fmtRect(sheet)} `
        + `— it rasterises to ${ink.inside} px of ink on the paper and ${ink.outside} px off it`,
    ).toEqual([]);
    expect(ink.inside, `${toolId}: ${sheetLabel(index)} rasterises to no ink inside the page box`).toBeGreaterThan(0);
    expect(ink.outside, `${toolId}: ${sheetLabel(index)} paints ${ink.outside} px off the page`).toBe(0);
  });
}

const sheetLabel = (index: number): string => `sheet ${index + 1}`;

/* ── n-up: the defect ────────────────────────────────────────────────────── */

/** A4 landscape, the sheet `n-up` defaults to. */
const A4_LANDSCAPE = { width: 841.89, height: 595.28 };

/** `perSheet: 4`, full bleed, of eight sheets → two output sheets of four cells. */
const FOUR_UP = { perSheet: 4, sheetSize: 'a4', landscape: true, gutter: 0, margin: 0 };

/**
 * The cell a `columns` × `rows` grid of a full-bleed sheet gives cell `c`.
 *
 * Recomputed here rather than imported from the tool, so this file cannot agree
 * with a wrong implementation by sharing its arithmetic.
 */
function cellOf(sheet: { width: number; height: number }, columns: number, rows: number, c: number): Rect {
  const cellWidth = sheet.width / columns;
  const cellHeight = sheet.height / rows;
  const col = c % columns;
  const row = Math.floor(c / columns);
  return { x: col * cellWidth, y: sheet.height - (row + 1) * cellHeight, width: cellWidth, height: cellHeight };
}

describe('n-up keeps every sheet on its own paper', () => {
  it('places sheet 2 in the cells of sheet 2, not below the media box', async () => {
    const doc = await produce('n-up', await inkedSheets(8), { ...FOUR_UP, order: 'across' }, 2);
    expectOnThePaper(doc, 'n-up');
    const first = placedOn(doc, 0);
    const second = placedOn(doc, 1);
    expect(first.map((form) => round(form.source.width)), 'sheet 1 carries the first four sheets').toEqual([200, 210, 220, 230]);
    expect(second.map((form) => round(form.source.width)), 'sheet 2 carries the last four').toEqual([240, 250, 260, 270]);
    // Cell 2 of a 2 × 2 grid is the bottom-left of the *same* sheet. Before the fix
    // it was read as row 1 of a run-long grid, one whole cell below y = 0 — and the
    // cell above it, row 2, is entirely off the page.
    [...first, ...second].forEach((form, flat) => {
      const cell = cellOf(A4_LANDSCAPE, 2, 2, flat % 4);
      expect(
        overlap(form.rect, cell),
        `the ${round(form.source.width)} pt page had to land in ${fmtRect(cell)}, and landed in ${fmtRect(form.rect)}`,
      ).not.toBeNull();
      expect(form.rect.x, 'never left of its cell').toBeGreaterThanOrEqual(cell.x - 0.01);
      expect(form.rect.x + form.rect.width, 'never right of its cell').toBeLessThanOrEqual(cell.x + cell.width + 0.01);
      expect(form.rect.y, 'never below its cell').toBeGreaterThanOrEqual(cell.y - 0.01);
      expect(form.rect.y + form.rect.height, 'never above its cell').toBeLessThanOrEqual(cell.y + cell.height + 0.01);
    });
  });

  it('keeps the sheet-2 ink on the page where sheet 1 has it', async () => {
    const doc = await produce('n-up', await inkedSheets(8), { ...FOUR_UP, order: 'across' }, 2);
    const first = rasterise(doc, 0);
    const second = rasterise(doc, 1);
    expect(second.outside, 'nothing is drawn under the paper').toBe(0);
    // Both sheets hold four inked pages of the same make, so the second cannot be
    // blank paper — the defect left exactly 0 px inside and 1 079 px below it.
    expect(second.inside, 'sheet 2 has ink on it').toBeGreaterThan(0);
    expect(second.inside).toBeGreaterThan(first.inside * 0.9);
    expect(second.inside).toBeLessThan(first.inside * 1.1);
  });

  it('numbers the cells within the sheet for down-then-across too', async () => {
    const doc = await produce('n-up', await inkedSheets(8), { ...FOUR_UP, order: 'down' }, 2);
    expectOnThePaper(doc, 'n-up');
    // Column-first fill, restarted on every sheet: cells 0, 2, 1, 3 of the grid.
    const cells = [0, 2, 1, 3].map((c) => fmtRect(cellOf(A4_LANDSCAPE, 2, 2, c)));
    expect(placedOn(doc, 0).map((form) => fmtRect(centre(form.rect)))).toEqual(cells);
    expect(placedOn(doc, 1).map((form) => fmtRect(centre(form.rect)))).toEqual(cells);
  });

  it('holds every sheet of a run that overflows by one page', async () => {
    // Five sheets, two per page: three output sheets, the last one cell short.
    const doc = await produce('n-up', await inkedSheets(5), { perSheet: 2, sheetSize: 'a4', landscape: true, gutter: 0, margin: 0 }, 3);
    expectOnThePaper(doc, 'n-up');
    expect(doc.getPages().map((_, index) => placedOn(doc, index).length), 'the last sheet has one page short')
      .toEqual([2, 2, 1]);
  });

  it('sends its hairline rules and its content to the same cells', async () => {
    const doc = await produce('n-up', await inkedSheets(8), { ...FOUR_UP, order: 'across', border: true }, 2);
    expectOnThePaper(doc, 'n-up');
    // The border loop always counted cells per sheet (`for c in 0 … perSheet`), so
    // before the fix the rules drew on the paper over four empty cells.
    const rules = drawnRules(doc, 1);
    expect(rules.length, 'four rules on sheet 2').toBe(4);
    const cells = [0, 1, 2, 3].map((c) => cellOf(A4_LANDSCAPE, 2, 2, c));
    for (const rule of rules) {
      expect(
        cells.some((cell) => Math.abs(rule.x - cell.x) < 0.01 && Math.abs(rule.y - cell.y) < 0.01),
        `the rule at ${fmtRect(rule)} marks a cell of this sheet`,
      ).toBe(true);
    }
    // Every ruled cell holds a page.
    for (const cell of cells) {
      expect(
        placedOn(doc, 1).some((form) => overlap(form.rect, cell)),
        `the cell at ${fmtRect(cell)} is filled, not just ruled`,
      ).toBe(true);
    }
  });
});

const centre = (rect: Rect): Rect => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: 0, height: 0 });

/* ── the neighbours, measured by the same predicate ──────────────────────── */

describe('the other grid tools keep their content on the page', () => {
  it('booklet: every printed side of a two-sheet saddle', async () => {
    const doc = await produce('booklet', await inkedSheets(8), { sheetSize: 'a4', landscape: true, gutter: 0, margin: 0 }, 4);
    expectOnThePaper(doc, 'booklet');
    // Booklet already numbers within a side (cells 0 and 1), so this records the
    // pairing beside the geometry: half = sheet[0] / 2 on both sides of every sheet.
    const sides = doc.getPages().map((_, index) => placedOn(doc, index).map((form) => round(form.source.width)));
    expect(sides).toEqual([[270, 200], [210, 260], [250, 220], [230, 240]]);
  });

  it('posterize: every tile of a two-page run, overlap included', async () => {
    const doc = await produce('posterize', await inkedSheets(2), { columns: 2, rows: 2, bleed: 6 }, 8);
    expectOnThePaper(doc, 'posterize');
    doc.getPages().forEach((_, index) => {
      const placed = placedOn(doc, index);
      expect(placed.length, `tile ${index + 1} holds one page`).toBe(1);
      const sheet = mediaBox(doc.getPages()[index]);
      // A tile sheet is a quarter of its own page plus the overlap: 200/2 + 6 for
      // the first page's four tiles, 210/2 + 6 for the second's.
      const source = index < 4 ? 200 : 210;
      expect(round(sheet.width), 'the sheet is one tile wide').toBe(source / 2 + 6);
      expect(round(placed[0].rect.width), 'and the crop fills it edge to edge').toBe(source / 2 + 6);
    });
  });

  it('divide-pages: every piece of a grid cut', async () => {
    const doc = await produce('divide-pages', await inkedSheets(2), { axis: 'grid', columns: 2, rows: 2 }, 8);
    expectOnThePaper(doc, 'divide-pages');
    const pieces = doc.getPages().map((_, index) => round(mediaBox(doc.getPages()[index]).width));
    expect(pieces).toEqual([100, 100, 100, 100, 105, 105, 105, 105]);
  });

  it('combine-single-page: every strip of the scroll', async () => {
    const doc = await produce('combine-single-page', await inkedSheets(8), { gap: 12, width: 'widest' }, 1);
    expectOnThePaper(doc, 'combine-single-page');
    expect(placedOn(doc, 0).map((form) => round(form.source.width)), 'the scroll runs in page order')
      .toEqual([200, 210, 220, 230, 240, 250, 260, 270]);
  });
});

/* ── the shared primitive: drawPageInto, on the target side ──────────────── */

describe('drawPageInto places into the sheet’s own box', () => {
  /**
   * Stamps one sheet into the cell `{0, 0, 288, 378}`… of a page whose `/MediaBox`
   * starts at `mediaOrigin` — what a trimmed scan carries, and the reason this
   * function measures its **source** by `cropBox`. Reading the destination box as
   * user-space coordinates, the same global-for-local mistake `n-up` made with its
   * cell index, moved every cell 36 pt off the corner it was aimed at.
   */
  async function stampOnto(mediaOrigin: [number, number], box: Rect): Promise<PDFDocument> {
    const source = await openPDF(await inkedSheets(1));
    const target = await newPDF();
    const page = target.addPage([576, 756]);
    page.setMediaBox(mediaOrigin[0], mediaOrigin[1], 576, 756);
    await drawPageInto(target, page, source.getPage(0), box);
    return openPDF(await savePDF(target, { compress: false }));
  }

  it('honours a target /MediaBox that starts away from (0, 0)', async () => {
    const doc = await stampOnto([36, 36], { x: 0, y: 0, width: 288, height: 378 });
    const sheet = cropBox(doc.getPages()[0]);
    expect(sheet).toEqual({ x: 36, y: 36, width: 576, height: 756 });
    const placed = placedOn(doc, 0);
    expect(placed.length).toBe(1);
    // The 200 × 260 source fills the 288-wide cell at 1.44, and centring inside the
    // 378-tall cell leaves 1.8 pt: the cell's own corner, not the page's.
    expect(fmtRect(placed[0].rect)).toBe('[36, 37.8 288×374.4]');
    expect(overlap(placed[0].rect, sheet), 'the page is on the paper').not.toBeNull();
    const ink = rasterise(doc, 0);
    expect(ink.outside, 'nothing spills past the visible box').toBe(0);
    expect(ink.inside).toBeGreaterThan(0);
  });

  it('is unchanged for a sheet that does start at the origin', async () => {
    const doc = await stampOnto([0, 0], { x: 0, y: 0, width: 288, height: 378 });
    expect(fmtRect(placedOn(doc, 0)[0].rect)).toBe('[0, 1.8 288×374.4]');
    expect(rasterise(doc, 0).outside).toBe(0);
  });

  it('keeps a cell named in the middle of the sheet there', async () => {
    const doc = await stampOnto([36, 36], { x: 288, y: 378, width: 288, height: 378 });
    const placed = placedOn(doc, 0);
    expect(fmtRect(placed[0].rect)).toBe('[324, 415.8 288×374.4]');
    expect(round(overlap(placed[0].rect, mediaBox(doc.getPages()[0]))!.width)).toBe(288);
    expect(rasterise(doc, 0).outside).toBe(0);
  });
});
