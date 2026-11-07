/**
 * Pure model behind BrowserSnip's in-place PDF text editor.
 *
 * Everything in this file is arithmetic over plain objects — no React, no
 * canvas, no pdf.js, no `pdf-lib` — so the hard parts (paragraph clustering,
 * reflow, the style model, find/replace, undo) are unit-testable, and
 * `TextEditor.tsx` owns the pixels and the bytes.
 *
 * Coordinate spaces (the same four the `src/lib/pdf/core` modules use):
 *
 * 1. **Viewer space** — rotated page, origin top-left, y down, one unit per PDF
 *    point. This is what `ExtractedTextItem.x/y/w/h` reports (see
 *    `core/render.toExtractedItems`) and therefore what the DOM overlay uses.
 * 2. **User space** — unrotated page, origin bottom-left, y up. This is what
 *    `core/redact.applyRedactions` deletes in, and what the text/image
 *    operators the editor emits are written in.
 *
 * `viewerToUserMatrix` is the matrix form of `core/tables.viewerRectToUserSpace`
 * (the two are cross-checked in `tests/pdf/text-editor.test.ts`) because rect
 * corner mapping cannot express a rotated or mirrored image placement.
 */
import type { ExtractedTextItem } from '@/lib/pdf/core/render';
import type { PageFrame, TopLeftBox } from '@/lib/pdf/core/tables';

/* ------------------------------------------------------------------ *
 * Matrices and geometry                                               *
 * ------------------------------------------------------------------ */

/** PDF matrix in `[a b c d e f]` order: `u = a·x + c·y + e`, `v = b·x + d·y + f`. */
export type Matrix6 = [number, number, number, number, number, number];

export interface Point {
  x: number;
  y: number;
}

export const identityMatrix = (): Matrix6 => [1, 0, 0, 1, 0, 0];

export function multiplyMatrices(a: Matrix6, b: Matrix6): Matrix6 {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

export const translationMatrix = (x: number, y: number): Matrix6 => [1, 0, 0, 1, x, y];
export const scaleMatrix = (sx: number, sy: number): Matrix6 => [sx, 0, 0, sy, 0, 0];

/**
 * Rotation by `degrees` **clockwise as drawn on screen**. Viewer space has y
 * growing downwards, so the ordinary counter-clockwise math rotation is the
 * visual clockwise one there; composing with `viewerToUserMatrix` (a reflection,
 * determinant −1) is what turns it back into the angle PDF expects.
 */
export function rotationMatrix(degrees: number): Matrix6 {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.round(Math.cos(rad) * 1e9) / 1e9;
  const sin = Math.round(Math.sin(rad) * 1e9) / 1e9;
  return [cos, sin, -sin, cos, 0, 0];
}

/** Round to `digits` and drop `-0`, so serialised geometry stays tidy. */
function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  const scaled = Math.round(value * factor) / factor;
  return Object.is(scaled, -0) ? 0 : scaled;
}

export function applyMatrix(m: Matrix6, p: Point): Point {
  return {
    x: round(m[0] * p.x + m[2] * p.y + m[4], 6),
    y: round(m[1] * p.x + m[3] * p.y + m[5], 6),
  };
}

/** Direction only: the same matrix without its translation. */
export function mapVector(m: Matrix6, v: Point): Point {
  return { x: round(m[0] * v.x + m[2] * v.y, 6), y: round(m[1] * v.x + m[3] * v.y, 6) };
}

/** Normalise `/Rotate` (and any object angle) to a clockwise multiple of 90. */
export function quarterTurn(rotation: number): 0 | 90 | 180 | 270 {
  const r = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;
  return r as 0 | 90 | 180 | 270;
}

/**
 * Affine transform from **viewer** coordinates to **user** coordinates: the
 * inverse of the per-quarter-turn table in `core/tables.viewerRectToUserSpace`.
 * Unit scale in every case, so point sizes stay in PDF points.
 */
export function viewerToUserMatrix(frame: PageFrame): Matrix6 {
  const { x0, y0, width: W, height: H } = frame;
  switch (quarterTurn(frame.rotation)) {
    case 90:
      return [0, 1, 1, 0, x0, y0];
    case 180:
      return [-1, 0, 0, 1, x0 + W, y0];
    case 270:
      return [0, -1, -1, 0, x0 + W, y0 + H];
    default:
      return [1, 0, 0, -1, x0, y0 + H];
  }
}

/** Map a viewer-space box into user space (same result as the `core/tables` helper). */
export function viewerBoxToUserSpace(box: TopLeftBox, frame: PageFrame) {
  const m = viewerToUserMatrix(frame);
  const corners = [
    applyMatrix(m, { x: box.x, y: box.y }),
    applyMatrix(m, { x: box.x + box.width, y: box.y }),
    applyMatrix(m, { x: box.x, y: box.y + box.height }),
    applyMatrix(m, { x: box.x + box.width, y: box.y + box.height }),
  ];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  return {
    x: round(Math.min(...xs), 4),
    y: round(Math.min(...ys), 4),
    width: round(Math.max(...xs) - Math.min(...xs), 4),
    height: round(Math.max(...ys) - Math.min(...ys), 4),
  };
}

/** Determinant of the linear part: negative means the transform mirrors. */
export function matrixDeterminant(m: Matrix6): number {
  return m[0] * m[3] - m[1] * m[2];
}

/** Inverse of a non-degenerate affine matrix. */
export function invertMatrix(m: Matrix6): Matrix6 {
  const det = matrixDeterminant(m);
  if (det === 0) return identityMatrix();
  const [a, b, c, d, e, f] = m;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/**
 * Viewer → user transform with the object's own clockwise turn applied about the
 * centre of `box`. Used for points, images and rules; text needs
 * {@link textMatrixForRun} instead, because a `Tm` may not mirror glyphs.
 */
export function objectMatrix(box: TopLeftBox, rotation = 0, frame?: PageFrame): Matrix6 {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const local = multiplyMatrices(
    multiplyMatrices(translationMatrix(cx, cy), rotationMatrix(rotation)),
    translationMatrix(-cx, -cy),
  );
  return frame ? multiplyMatrices(viewerToUserMatrix(frame), local) : local;
}

/** Where a viewer-space point of an object lands in user space. */
export function pointInObject(
  box: TopLeftBox,
  rotation: number,
  frame: PageFrame,
  point: Point,
): Point {
  return applyMatrix(objectMatrix(box, rotation, frame), point);
}

/**
 * `Tm` for one text run: the baseline starts at `anchor` (viewer space) and the
 * object is turned `rotation` degrees clockwise on screen.
 *
 * Page `/Rotate` and the object turn are added as screen rotations and then
 * negated into the counter-clockwise sense PDF uses, so the linear part is
 * always a pure rotation (determinant +1). Folding `viewerToUserMatrix` into
 * `Tm` instead would mirror every glyph on a `/Rotate 0` page. Font size stays
 * in `Tf` and `Tm` keeps unit scale, so `Tc`/`Tw`/`Ts` remain point values.
 */
export function textMatrixForRun(
  anchor: Point,
  rotation: number,
  frame: PageFrame,
  box?: TopLeftBox,
): Matrix6 {
  const origin = box
    ? pointInObject(box, rotation, frame, anchor)
    : applyMatrix(viewerToUserMatrix(frame), anchor);
  const angle = ((quarterTurn(frame.rotation) - rotation) * Math.PI) / 180;
  const cos = Math.round(Math.cos(angle) * 1e9) / 1e9;
  const sin = Math.round(Math.sin(angle) * 1e9) / 1e9;
  return [cos, sin, -sin, cos, origin.x, origin.y];
}

/**
 * `cm` that lands the PDF unit square on `box` (viewer space), rotated
 * `degrees` clockwise on screen and mirrored by the flip flags.
 */
export function imageMatrix(
  box: TopLeftBox,
  transform: { degrees?: number; flipH?: boolean; flipV?: boolean } = {},
  frame?: PageFrame,
): Matrix6 {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const place = multiplyMatrices(
    multiplyMatrices(
      translationMatrix(cx, cy),
      scaleMatrix((transform.flipH ? -1 : 1) * box.width, (transform.flipV ? 1 : -1) * box.height),
    ),
    translationMatrix(-0.5, -0.5),
  );
  return multiplyMatrices(objectMatrix(box, transform.degrees ?? 0, frame), place);
}

/** Axis-aligned viewer box after rotating `box` about its centre. */
export function rotateBoxAboutCenter(box: TopLeftBox, degrees: number): TopLeftBox {
  const turn = quarterTurn(degrees);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  if (turn === 90 || turn === 270) {
    return { x: cx - box.height / 2, y: cy - box.width / 2, width: box.height, height: box.width };
  }
  return { ...box };
}

export function unionBoxes(boxes: TopLeftBox[]): TopLeftBox {
  if (boxes.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const x1 = Math.min(...boxes.map((b) => b.x));
  const y1 = Math.min(...boxes.map((b) => b.y));
  const x2 = Math.max(...boxes.map((b) => b.x + b.width));
  const y2 = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export function padBox(box: TopLeftBox, padX: number, padY = padX): TopLeftBox {
  return {
    x: box.x - padX,
    y: box.y - padY,
    width: box.width + padX * 2,
    height: box.height + padY * 2,
  };
}

export function boxContains(outer: TopLeftBox, p: Point): boolean {
  return p.x >= outer.x && p.x <= outer.x + outer.width && p.y >= outer.y && p.y <= outer.y + outer.height;
}

/**
 * Selection handles.
 *
 * Eight, in reading order (top-left, top-middle, … clockwise) so the tab order
 * follows the visual order the way pdf.js orders its resizers. `left`/`top` are
 * fractions of the box, which is what the DOM layer needs to anchor a handle;
 * `cursor` is the direction-correct CSS resize cursor the checklist asks for.
 */
export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export interface HandleSpec {
  id: ResizeHandle;
  label: string;
  cursor: string;
  left: number;
  top: number;
}

/** A block never shrinks below this, in points — smaller and the text is gone. */
export const MIN_BLOCK_SIZE = 8;

export const RESIZE_HANDLES: HandleSpec[] = [
  { id: 'nw', label: 'Top left corner', cursor: 'nwse-resize', left: 0, top: 0 },
  { id: 'n', label: 'Top edge', cursor: 'ns-resize', left: 0.5, top: 0 },
  { id: 'ne', label: 'Top right corner', cursor: 'nesw-resize', left: 1, top: 0 },
  { id: 'e', label: 'Right edge', cursor: 'ew-resize', left: 1, top: 0.5 },
  { id: 'se', label: 'Bottom right corner', cursor: 'nwse-resize', left: 1, top: 1 },
  { id: 's', label: 'Bottom edge', cursor: 'ns-resize', left: 0.5, top: 1 },
  { id: 'sw', label: 'Bottom left corner', cursor: 'nesw-resize', left: 0, top: 1 },
  { id: 'w', label: 'Left edge', cursor: 'ew-resize', left: 0, top: 0.5 },
];

/**
 * Drag a handle. The opposite edge (or the top-left corner for an edge handle)
 * stays where it was, and a squeeze past `MIN_BLOCK_SIZE` stops there instead of
 * flipping the box inside out.
 */
export function resizeBox(
  box: TopLeftBox,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  min = MIN_BLOCK_SIZE,
): TopLeftBox {
  const west = handle === 'w' || handle === 'nw' || handle === 'sw';
  const east = handle === 'e' || handle === 'ne' || handle === 'se';
  const north = handle === 'n' || handle === 'nw' || handle === 'ne';
  const south = handle === 's' || handle === 'sw' || handle === 'se';
  let { x, y, width, height } = box;
  if (east) width = Math.max(min, box.width + dx);
  if (west) {
    const growth = Math.min(dx, box.width - min);
    x = box.x + growth;
    width = box.width - growth;
  }
  if (south) height = Math.max(min, box.height + dy);
  if (north) {
    const growth = Math.min(dy, box.height - min);
    y = box.y + growth;
    height = box.height - growth;
  }
  return { x, y, width, height };
}

/* ------------------------------------------------------------------ *
 * Paragraph clustering from extracted text runs                       *
 * ------------------------------------------------------------------ */

/** One visual line of a paragraph, in viewer space. */
export interface ExtractedLine {
  text: string;
  box: TopLeftBox;
  /** Glyph size in points, from the tallest item on the line. */
  size: number;
  /** Char offset of this line inside `ExtractedParagraph.text`. */
  start: number;
  end: number;
  items: ExtractedTextItem[];
}

export interface ExtractedParagraph {
  id: string;
  /** 1-based page, as pdf.js reports it. */
  page: number;
  text: string;
  lines: ExtractedLine[];
  box: TopLeftBox;
  /** Body glyph size in points — the initial edit size. */
  size: number;
  /** Every run is render mode 3, i.e. this is an invisible OCR layer. */
  invisible: boolean;
  direction: 'ltr' | 'rtl';
}

export interface ClusterOptions {
  /** Baseline tolerance for row grouping, points. Default 3. */
  tolerance?: number;
  /** Intra-row gap, in em, that separates two columns. Default 0.6. */
  columnGapEm?: number;
  /** Inter-line distance, in multiples of the size, that still joins lines. Default 2.2. */
  lineHeightFactor?: number;
  /** Size ratio two lines may differ by and still share a paragraph. Default 1.35. */
  sizeRatio?: number;
  /** Left-edge jitter, in em, still treated as the same margin. Default 0.9. */
  marginJitterEm?: number;
}

const DEFAULT_CLUSTER: Required<ClusterOptions> = {
  tolerance: 3,
  columnGapEm: 0.6,
  lineHeightFactor: 2.2,
  sizeRatio: 1.35,
  marginJitterEm: 0.9,
};

function isUsable(item: ExtractedTextItem): boolean {
  return typeof item.str === 'string' && item.str.length > 0;
}

/**
 * Group runs into visual lines (by baseline), then split every row wherever the
 * horizontal gap is wide enough to be a column gutter or a table cell.
 */
export function clusterLines(items: ExtractedTextItem[], options: ClusterOptions = {}): ExtractedLine[] {
  const opts = { ...DEFAULT_CLUSTER, ...options };
  const rows: { baseline: number; items: ExtractedTextItem[] }[] = [];
  for (const item of items) {
    if (!isUsable(item)) continue;
    const baseline = Math.round((item.y + item.h) * 100) / 100;
    const match = rows.find((row) => Math.abs(row.baseline - baseline) <= opts.tolerance);
    if (match) match.items.push(item);
    else rows.push({ baseline, items: [item] });
  }

  const lines: ExtractedLine[] = [];
  for (const row of rows) {
    const sorted = [...row.items].sort((a, b) => a.x - b.x || a.y - b.y);
    let group: ExtractedTextItem[] = [];
    const flush = () => {
      const line = lineFromItems(group);
      group = [];
      if (line) lines.push(line);
    };
    for (const item of sorted) {
      const previous = group[group.length - 1];
      if (previous) {
        const size = Math.max(previous.h, item.h, 1);
        if (item.x - (previous.x + previous.w) > opts.columnGapEm * size) flush();
      }
      group.push(item);
    }
    flush();
  }
  return lines.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
}

function lineFromItems(items: ExtractedTextItem[]): ExtractedLine | null {
  const kept = items.filter(isUsable);
  if (kept.length === 0) return null;
  const size = Math.max(...kept.map((i) => Math.abs(i.h) || Math.abs(i.height) || 0), 1);
  let raw = '';
  for (let i = 0; i < kept.length; i += 1) {
    const item = kept[i];
    if (i > 0) {
      const previous = kept[i - 1];
      const gap = item.x - (previous.x + previous.w);
      // pdf.js splits a word whenever the font or the kerning changes; only a
      // gap about as wide as a space is a real word boundary.
      if (gap > 0.18 * size && !/\s$/.test(raw) && !/^\s/.test(item.str)) raw += ' ';
    }
    raw += item.str;
  }
  const box = unionBoxes(kept.map((i) => ({ x: i.x, y: i.y, width: i.w, height: i.h })));
  const text = raw.replace(/\s+/g, ' ').trim();
  if (text.length === 0) return null;
  return {
    text,
    box: { ...box, height: Math.max(box.height, size) },
    size,
    start: 0,
    end: 0,
    items: kept,
  };
}

/**
 * Cluster a page's text runs into paragraph blocks: same column, same size,
 * consecutive baselines. This is the click target the editor shows and the unit
 * that gets deleted and rewritten on commit.
 */
export function clusterParagraphs(items: ExtractedTextItem[], options: ClusterOptions = {}): ExtractedParagraph[] {
  const opts = { ...DEFAULT_CLUSTER, ...options };
  const blocks: ExtractedLine[][] = [];
  for (const line of clusterLines(items, opts)) {
    const previous = blocks[blocks.length - 1];
    if (previous && continuesBlock(previous, line, opts)) previous.push(line);
    else blocks.push([line]);
  }
  return blocks.map((block) => paragraphFromLines(block));
}

function continuesBlock(block: ExtractedLine[], line: ExtractedLine, opts: Required<ClusterOptions>): boolean {
  const last = block[block.length - 1];
  const size = Math.max(last.size, line.size, 1);

  // Line distance: close enough to be the next line of the same block.
  const gap = line.box.y - (last.box.y + last.box.height);
  if (gap > opts.lineHeightFactor * size) return false;
  if (gap < -size) return false;

  // A different size is a heading, a caption or a footnote, not a wrap.
  if (Math.max(last.size, line.size) / Math.min(last.size, line.size) > opts.sizeRatio) return false;

  // Must overlap horizontally, or it is the next column.
  const overlap =
    Math.min(last.box.x + last.box.width, line.box.x + line.box.width) - Math.max(last.box.x, line.box.x);
  const narrower = Math.min(last.box.width, line.box.width);
  if (narrower <= 0 || overlap / narrower < 0.35) return false;

  // A left margin that jumps by more than a few characters starts a new block,
  // unless the previous line ran to the right edge (so this is a soft wrap).
  const blockBox = unionBoxes(block.map((l) => l.box));
  const previousIsFull = blockBox.x + blockBox.width - (last.box.x + last.box.width) < size * 0.5;
  if (Math.abs(line.box.x - last.box.x) > opts.marginJitterEm * size && !previousIsFull) return false;
  return true;
}

export interface JoinedLine {
  text: string;
  start: number;
  end: number;
}

export interface JoinResult {
  /** The paragraph text, with soft hyphens undone. */
  text: string;
  lines: JoinedLine[];
}

/**
 * Join wrapped lines into one paragraph string, undoing the soft hyphen most
 * producers insert at a break, and reporting where every source line landed so
 * search hits can be mapped back onto on-screen boxes.
 */
export function joinLines(lines: string[]): JoinResult {
  const out: JoinedLine[] = [];
  let text = '';
  lines.forEach((raw, index) => {
    const line = raw.trim();
    let prefix = '';
    if (index > 0) {
      if (/[-\u00ad\u2010]\s*$/.test(text) && /^[a-z]/.test(line)) text = text.replace(/[-\u00ad\u2010]\s*$/, '');
      else if (!/\s$/.test(text) && !/^\s/.test(line)) prefix = ' ';
    }
    const start = text.length + prefix.length;
    text += prefix + line;
    out.push({ text: line, start, end: text.length });
  });
  return { text: text.replace(/\s+/g, ' ').trim(), lines: out };
}

/** Build one paragraph from its lines. */
export function paragraphFromLines(lines: ExtractedLine[], page?: number): ExtractedParagraph {
  const body = lines.filter((l) => l.text.trim().length > 0);
  const sizes = body.map((l) => l.size).sort((a, b) => a - b);
  const median = sizes.length > 0 ? sizes[Math.floor(sizes.length / 2)] : 12;
  const joined = joinLines(body.map((l) => l.text));
  const box = unionBoxes(body.map((l) => l.box));

  const laid: ExtractedLine[] = body.map((line, index) => ({
    ...line,
    text: joined.lines[index]?.text ?? line.text,
    start: joined.lines[index]?.start ?? 0,
    end: joined.lines[index]?.end ?? 0,
  }));

  const rtlLines = body.filter((l) => l.items.some((i) => i.dir === 'rtl')).length;
  const page1 = page ?? body[0]?.items[0]?.page ?? 1;
  return {
    id: `p${page1}-${Math.round(box.x)}-${Math.round(box.y)}`,
    page: page1,
    text: joined.text,
    lines: laid,
    box: { ...box, height: Math.max(box.height, median) },
    size: median,
    invisible: body.length > 0 && body.every((l) => l.items.every((i) => i.isInvisible)),
    direction: rtlLines * 2 > body.length ? 'rtl' : 'ltr',
  };
}

/* ------------------------------------------------------------------ *
 * Style model                                                         *
 * ------------------------------------------------------------------ */

export type TextAlign = 'left' | 'center' | 'right' | 'justify';
export type ListKind = 'none' | 'bullet' | 'number';
export type BulletMarker = 'dot' | 'circle' | 'square' | 'dash' | 'arrow';
export type NumberMarker = 'decimal' | 'lower-alpha' | 'upper-alpha' | 'lower-roman' | 'upper-roman';
export type TextDirection = 'auto' | 'ltr' | 'rtl';

/** Inline (per-run) styling. Everything else in `EditorStyle` is block-level. */
export interface InlineStyle {
  /** `''` = auto (standard 14 / bundled Noto / script fallback). */
  fontFamily: string;
  size: number;
  color: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  superscript: boolean;
  subscript: boolean;
}

export interface EditorStyle extends InlineStyle {
  align: TextAlign;
  list: ListKind;
  bulletMarker: BulletMarker;
  numberMarker: NumberMarker;
  /** Left indent of the whole block, points. */
  indent: number;
  /** Extra indent of the first line; negative hangs it into the margin. */
  firstLineIndent: number;
  /** Line height as a multiple of the size. */
  lineSpacing: number;
  /** Space above / below each paragraph, points. */
  spaceBefore: number;
  spaceAfter: number;
  /** Tracking added after every glyph, points. */
  charSpacing: number;
  /** Tracking added at every word break, points. */
  wordSpacing: number;
  /** `Tz`, percent. 100 = normal width. */
  horizontalScale: number;
  outlineColor: string;
  outlineWidth: number;
  opacity: number;
  direction: TextDirection;
  listLevel: number;
}

/**
 * A run's style with the block-level tracking, direction and script shift
 * resolved, ready for measuring and writing. Everything on `EditorStyle` is
 * inherited by the run; the per-run overrides are the inline ones.
 */
export interface ResolvedInline extends EditorStyle {
  /** Baseline shift in points, positive = up the page. */
  rise: number;
}

export const DEFAULT_STYLE: EditorStyle = {
  fontFamily: '',
  size: 12,
  color: '#000000',
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  superscript: false,
  subscript: false,
  align: 'left',
  list: 'none',
  bulletMarker: 'dot',
  numberMarker: 'decimal',
  indent: 0,
  firstLineIndent: 0,
  lineSpacing: 1.2,
  spaceBefore: 0,
  spaceAfter: 4,
  charSpacing: 0,
  wordSpacing: 0,
  horizontalScale: 100,
  outlineColor: '#000000',
  outlineWidth: 0,
  opacity: 1,
  direction: 'auto',
  listLevel: 0,
};

export const BULLET_GLYPHS: Record<BulletMarker, string> = {
  dot: '\u2022',
  circle: '\u25E6',
  square: '\u25AA',
  dash: '\u2013',
  arrow: '\u25B8',
};

const NUMERAL_ALPHABET = 'abcdefghijklmnopqrstuvwxyz';
const ROMAN_TABLE: [number, string][] = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
  [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
];

/** Marker text for a list item: `•`, `3.`, `iv.` … */
export function listMarker(kind: ListKind, index: number, style: EditorStyle): string | null {
  if (kind === 'none') return null;
  const n = Math.max(1, Math.floor(index) + 1);
  if (kind === 'bullet') return BULLET_GLYPHS[style.bulletMarker];
  switch (style.numberMarker) {
    case 'lower-alpha':
      return `${alphaOf(n)}.`;
    case 'upper-alpha':
      return `${alphaOf(n).toUpperCase()}.`;
    case 'lower-roman':
      return `${romanOf(n).toLowerCase()}.`;
    case 'upper-roman':
      return `${romanOf(n).toUpperCase()}.`;
    default:
      return `${n}.`;
  }
}

function alphaOf(n: number): string {
  let out = '';
  let value = n;
  while (value > 0) {
    value -= 1;
    out = NUMERAL_ALPHABET[value % 26] + out;
    value = Math.floor(value / 26);
  }
  return out || 'a';
}

export function romanOf(n: number): string {
  let value = Math.max(1, Math.floor(n));
  let out = '';
  for (const [amount, symbol] of ROMAN_TABLE) {
    while (value >= amount) {
      out += symbol;
      value -= amount;
    }
  }
  return out;
}

const STYLE_RANGES: Partial<Record<keyof EditorStyle, [number, number]>> = {
  size: [1, 400],
  lineSpacing: [0.5, 6],
  horizontalScale: [20, 300],
  opacity: [0, 1],
  indent: [-500, 500],
  firstLineIndent: [-500, 500],
  charSpacing: [-10, 100],
  wordSpacing: [-10, 200],
  outlineWidth: [0, 20],
  spaceBefore: [-200, 400],
  spaceAfter: [-200, 400],
  listLevel: [0, 8],
};

/** Keep a numeric style field inside the range the writer can render. */
export function clampStyle<K extends keyof EditorStyle>(key: K, value: number): number {
  const range = STYLE_RANGES[key];
  // Not a clamped numeric field: leave it alone.
  if (!range) return value;
  if (!Number.isFinite(value)) return DEFAULT_STYLE[key] as number;
  return Math.min(range[1], Math.max(range[0], value));
}

/** Initial style for an extracted block: size, colour and direction of the source. */
export function styleFromExtraction(
  paragraph: ExtractedParagraph,
  options: { color?: string; pageWidth?: number } = {},
): EditorStyle {
  return {
    ...DEFAULT_STYLE,
    size: clampStyle('size', paragraph.size),
    color: options.color ?? DEFAULT_STYLE.color,
    direction: paragraph.direction === 'rtl' ? 'rtl' : 'auto',
    align: guessAlignment(paragraph, options.pageWidth),
    spaceAfter: 0,
  };
}

/**
 * Alignment of the source block, inferred from where its lines sit inside the
 * block box — the only evidence text extraction leaves. A single line can only
 * be judged against the page width.
 */
export function guessAlignment(paragraph: ExtractedParagraph, pageWidth?: number): TextAlign {
  const lines = paragraph.lines;
  const box = paragraph.box;
  if (lines.length === 1) {
    if (!(pageWidth && pageWidth > 0)) return 'left';
    const left = box.x;
    const right = pageWidth - (box.x + box.width);
    const centred = Math.abs(left - right) < pageWidth * 0.06 && left > pageWidth * 0.1;
    return centred ? 'center' : 'left';
  }
  const lefts = lines.map((l) => l.box.x - box.x);
  const rights = lines.map((l) => l.box.x + l.box.width - (box.x + box.width));
  const centres = lines.map((l) => l.box.x + l.box.width / 2 - (box.x + box.width / 2));
  const spread = (values: number[]) => Math.max(...values) - Math.min(...values);
  const tolerance = Math.max(2, box.width * 0.04);
  // Both edges flush means every line was stretched: justified.
  if (spread(lefts) <= tolerance && spread(rights) <= tolerance) return 'justify';
  if (spread(lefts) <= tolerance) return 'left';
  if (spread(rights) <= tolerance) return 'right';
  if (spread(centres) <= tolerance) return 'center';
  return 'left';
}

/* ------------------------------------------------------------------ *
 * Rich-text document                                                  *
 * ------------------------------------------------------------------ */

export interface Run {
  text: string;
  style: Partial<InlineStyle>;
}

export type ParagraphStyle = Partial<
  Pick<EditorStyle, 'align' | 'indent' | 'firstLineIndent' | 'spaceBefore' | 'spaceAfter' | 'lineSpacing'>
>;

export interface DocParagraph {
  runs: Run[];
  style: ParagraphStyle;
  list: ListKind;
  listLevel: number;
}

export function resolveRun(run: Run, base: EditorStyle): InlineStyle {
  return { ...base, ...run.style };
}

/** `run` in the context of `base`, with script shift and tracking resolved. */
export function inlineFor(run: Run, base: EditorStyle): ResolvedInline {
  const resolved = resolveRun(run, base);
  const raised = Boolean(run.style.superscript ?? base.superscript);
  const lowered = Boolean(run.style.subscript ?? base.subscript);
  return {
    ...base,
    ...resolved,
    size: clampStyle('size', resolved.size * (raised || lowered ? 0.58 : 1)),
    rise: raised ? resolved.size * 0.42 : lowered ? -resolved.size * 0.18 : 0,
  };
}

export function baseInline(base: EditorStyle): ResolvedInline {
  return { ...base, rise: 0 };
}

export function paragraphsFromText(text: string, list: ListKind = 'none'): DocParagraph[] {
  const lines = text.length === 0 ? [''] : text.split(/\r?\n/);
  return lines.map((line) => ({
    runs: [{ text: line, style: {} }],
    style: {},
    list,
    listLevel: 0,
  }));
}

export function textOfParagraphs(paragraphs: DocParagraph[]): string {
  return paragraphs.map((paragraph) => plainTextOfRuns(paragraph.runs)).join('\n');
}

export function plainTextOfRuns(runs: Run[]): string {
  return runs.map((run) => run.text).join('');
}

/**
 * The DOM-lite shape `TextEditor.tsx` builds from a `contentEditable` subtree.
 * Keeping the shape here means HTML → styled runs — the step that quietly eats
 * formatting in a naive editor — is unit-testable.
 */
export interface DomNode {
  /** `p` / `div` / `li` / `br` / `#text`. */
  tag: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  superscript?: boolean;
  subscript?: boolean;
  color?: string;
  size?: number;
  fontFamily?: string;
  /** Block-level values the editor box carries on its wrapper element. */
  align?: TextAlign;
  indent?: number;
  list?: ListKind;
  listLevel?: number;
  text?: string;
  children?: DomNode[];
}

/** Fold a DOM-lite tree into styled paragraphs. */
export function paragraphsFromDom(nodes: DomNode[]): DocParagraph[] {
  const paragraphs: DocParagraph[] = [];
  let current: Run[] = [];

  const flush = () => {
    if (current.length === 0) return;
    paragraphs.push({ runs: normaliseRuns(current), style: {}, list: 'none', listLevel: 0 });
    current = [];
  };

  const walk = (node: DomNode, inherited: Partial<InlineStyle>): DocParagraph | null => {
    if (node.tag === 'br') {
      flush();
      return null;
    }
    const style: Partial<InlineStyle> = { ...inherited };
    for (const key of ['bold', 'italic', 'underline', 'strike', 'superscript', 'subscript'] as const) {
      if (node[key]) style[key] = true;
    }
    if (node.color) style.color = node.color;
    if (typeof node.size === 'number' && node.size > 0) style.size = node.size;
    if (node.fontFamily) style.fontFamily = node.fontFamily;

    if (node.tag === '#text') {
      if (node.text) current.push({ text: node.text, style: { ...style } });
      return null;
    }
    const isBlock = node.tag === 'p' || node.tag === 'div' || node.tag === 'li';
    let block: DocParagraph | null = null;
    for (const child of node.children ?? []) block = walk(child, style) ?? block;
    if (isBlock && current.length > 0) {
      const paragraph = {
        runs: normaliseRuns(current),
        style: {
          ...(node.align ? { align: node.align } : {}),
          ...(typeof node.indent === 'number' && node.indent > 0 ? { indent: node.indent } : {}),
        },
        list: node.list ?? 'none',
        listLevel: node.listLevel ?? 0,
      } satisfies DocParagraph;
      paragraphs.push(paragraph);
      current = [];
      return paragraph;
    }
    return block;
  };

  for (const node of nodes) walk(node, {});
  if (current.length > 0) flush();
  if (paragraphs.length === 0) {
    paragraphs.push({ runs: [{ text: '', style: {} }], style: {}, list: 'none', listLevel: 0 });
  }
  return paragraphs;
}

/** Merge neighbours that carry the same formatting, so the writer stays cheap. */
export function normaliseRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    if (run.text.length === 0) continue;
    const last = out[out.length - 1];
    if (last && sameInlineStyle(last.style, run.style)) {
      out[out.length - 1] = { text: last.text + run.text, style: last.style };
      continue;
    }
    out.push({ text: run.text, style: { ...run.style } });
  }
  return out.length > 0 ? out : [{ text: '', style: {} }];
}

const INLINE_KEYS: (keyof InlineStyle)[] = [
  'fontFamily', 'size', 'color', 'bold', 'italic', 'underline', 'strike', 'superscript', 'subscript',
];

/**
 * The editor box's initial HTML for a block: escaped, inline-styled, and the
 * inverse of {@link paragraphsFromDom} for the tags this editor emits, so what
 * the user sees is what the writer receives back.
 */
export function paragraphsToHtml(paragraphs: DocParagraph[], base: EditorStyle): string {
  return paragraphs
    .map((paragraph) => {
      const style = { ...base, ...paragraph.style };
      const body = paragraph.runs
        .map((run) => {
          const resolved = resolveRun(run, style);
          let html = escapeHtml(run.text).replace(/\n/g, '<br>');
          if (resolved.subscript) html = `<sub>${html}</sub>`;
          if (resolved.superscript) html = `<sup>${html}</sup>`;
          const decorations = [resolved.underline ? 'underline' : '', resolved.strike ? 'line-through' : ''].filter(Boolean);
          if (decorations.length > 0) html = `<u style="text-decoration:${decorations.join(' ')}">${html}</u>`;
          if (resolved.italic) html = `<i>${html}</i>`;
          if (resolved.bold) html = `<b>${html}</b>`;
          const inline: string[] = [];
          if (resolved.color !== base.color) inline.push(`color:${resolved.color}`);
          if (resolved.size !== base.size) inline.push(`font-size:${round(resolved.size, 2)}s`);
          if (inline.length === 0) return html;
          return `<span data-size="${resolved.size}" style="${inline.join(';')}">${html}</span>`;
        })
        .join('');
      const box: string[] = [`text-align:${paragraphAlign(paragraph, base)}`];
      const indent = Math.max(0, (paragraph.style.indent ?? base.indent) + paragraph.listLevel * 14);
      if (indent) box.push(`margin-left:${round(indent, 2)}s`);
      if (base.firstLineIndent) box.push(`text-indent:${round(base.firstLineIndent, 2)}s`);
      return `<div data-paragraph="1" style="${box.join(';')}">${body || '<br>'}</div>`;
    })
    .join('');
}

function paragraphAlign(paragraph: DocParagraph, base: EditorStyle): string {
  return paragraph.style.align ?? base.align;
}

/** Escape the characters that can break out of an attribute or a text node. */
export function escapeHtml(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sameInlineStyle(a: Partial<InlineStyle>, b: Partial<InlineStyle>): boolean {
  return INLINE_KEYS.every((key) => (a[key] ?? undefined) === (b[key] ?? undefined));
}

/* ------------------------------------------------------------------ *
 * Reflow                                                              *
 * ------------------------------------------------------------------ */

/**
 * Advance of `text` in points, tracking and horizontal scale included.
 * `sourceText` is the whole run `text` came from, so a writer can pick the same
 * face it measured with even when a line broke the run in the middle.
 */
export type Measure = (text: string, run: ResolvedInline, sourceText: string) => number;

/** Advance a `pdf-lib` face produces for `text`, plus the model's tracking. */
export function advanceOf(
  glyphWidth: number,
  text: string,
  run: ResolvedInline,
): number {
  const characters = [...text].length;
  const spaces = (text.match(/\s/g) ?? []).length;
  return (
    glyphWidth * (run.horizontalScale / 100) +
    run.charSpacing * characters +
    run.wordSpacing * spaces
  );
}

/** Monospace measurer for tests and for pages whose font could not be embedded. */
export function monospaceMeasure(advanceEm = 0.5): Measure {
  return (text, run) => advanceOf([...text].length * advanceEm * run.size, text, run);
}

/** Where a token came from, so the writer can look its face up again. */
export interface RunSource {
  paragraph: number;
  run: number;
}

interface Token {
  text: string;
  run: ResolvedInline;
  width: number;
  isSpace: boolean;
  source: RunSource;
  /** Full text of the run this token came from; selects the face. */
  sourceText: string;
}

export interface LayoutPiece {
  text: string;
  run: ResolvedInline;
  /** Left edge, block-relative, points. */
  x: number;
  /** Advance of the piece, points. */
  width: number;
  source: RunSource;
}

export interface LayoutLine {
  pieces: LayoutPiece[];
  /** Flattened text of the line. */
  text: string;
  marker: string | null;
  /** Left edge of the marker column, block-relative. */
  indent: number;
  /** Box top relative to the block origin, y down, points. */
  y: number;
  /** Baseline relative to the block origin, points. */
  baseline: number;
  height: number;
  width: number;
  spaceBefore: number;
  spaceAfter: number;
  /** Extra `Tw` that justifies this line across the block width. */
  extraWordSpacing: number;
}

export interface LayoutResult {
  lines: LayoutLine[];
  /** Total block height including paragraph spacing, points. */
  height: number;
  /** Widest line including its indent, so callers can grow the box. */
  width: number;
}

export interface LayoutOptions {
  measure: Measure;
  /** Usable width of the block in points. */
  width: number;
  /** Baseline offset as a fraction of the size. Default 0.8. */
  ascent?: number;
}

const WHITESPACE = /\s/;

/**
 * Lay a rich-text block out into PDF lines. The same call sizes the on-screen
 * editor box and places the glyphs on commit, which is what keeps the preview
 * and the exported file telling the same story.
 */
export function layoutBlock(
  paragraphs: DocParagraph[],
  base: EditorStyle,
  options: LayoutOptions,
): LayoutResult {
  const ascentRatio = options.ascent ?? 0.8;
  const lines: LayoutLine[] = [];
  let cursorY = 0;
  let widest = 0;

  // One counter per contiguous list, the way a `<ol>` restarts.
  let counter = -1;
  let previousKind: ListKind = 'none';

  paragraphs.forEach((paragraph, pIndex) => {
    const style: EditorStyle = { ...base, ...paragraph.style };    const isList = paragraph.list !== 'none';
    if (isList) counter = paragraph.list === previousKind ? counter + 1 : 0;
    else counter = -1;
    previousKind = paragraph.list;

    const marker = isList ? listMarker(paragraph.list, Math.max(0, counter), style) : null;
    const levelIndent = Math.max(0, style.indent) + paragraph.listLevel * 14;
    const markerRun = baseInline(style);
    const markerWidth = marker ? options.measure(`${marker} `, markerRun, marker) : 0;    const contentLeft = levelIndent + markerWidth;
    const firstLeft = Math.max(0, contentLeft + (marker ? 0 : style.firstLineIndent));
    const textLeft = (index: number) => (index === 0 ? firstLeft : contentLeft);

    const tokens = tokenizeParagraph(paragraph, style, options.measure, pIndex);
    const chunks = breakTokens(
      tokens,
      Math.max(8, options.width - firstLeft),
      Math.max(8, options.width - contentLeft),
      options.measure,
    );

    const spaceBefore = pIndex === 0 ? 0 : Math.max(0, style.spaceBefore);
    const spaceAfter = Math.max(0, style.spaceAfter);
    cursorY += spaceBefore;

    chunks.forEach((chunk, chunkIndex) => {
      const size = Math.max(style.size, ...chunk.map((token) => token.run.size));
      const lineHeight = Math.max(size * style.lineSpacing, size + 1);
      const natural = chunk.reduce((sum, token) => sum + token.width, 0);
      const spaces = chunk.filter((token) => token.isSpace).length;
      const left = textLeft(chunkIndex);
      const measureWidth = Math.max(8, options.width - left);
      const isLast = chunkIndex === chunks.length - 1;
      const justify = style.align === 'justify' && !isLast && spaces > 0 && natural < measureWidth;
      const extra = justify ? (measureWidth - natural) / spaces : 0;
      const drawn = natural + extra * spaces;
      // Justification already stretched the line to the measure; centring and
      // right-aligning apply to every line, the last one included.
      const shift = justify ? 0 : alignOffset(style.align, drawn, measureWidth);

      let x = left + shift;
      const pieces: LayoutPiece[] = [];
      for (const token of chunk) {
        const width = token.width + (token.isSpace ? extra : 0);
        pieces.push({ text: token.text, run: token.run, x, width, source: token.source });
        x += width;
      }

      const top = cursorY;
      lines.push({
        pieces,
        text: chunk.map((token) => token.text).join(''),
        marker: chunkIndex === 0 ? marker : null,
        indent: levelIndent,
        y: top,
        baseline: top + size * ascentRatio,
        height: lineHeight,
        width: Math.max(0, x - left),
        spaceBefore: chunkIndex === 0 ? spaceBefore : 0,
        spaceAfter: isLast ? spaceAfter : 0,
        extraWordSpacing: extra,
      });
      cursorY = top + lineHeight;
      widest = Math.max(widest, left + drawn);
    });
  });

  return { lines, height: cursorY, width: widest };
}

function tokenizeParagraph(
  paragraph: DocParagraph,
  base: EditorStyle,
  measure: Measure,
  paragraphIndex: number,
): Token[] {
  const tokens: Token[] = [];
  paragraph.runs.forEach((run, runIndex) => {
    const style = inlineFor(run, base);
    for (const piece of run.text.split(/(\s+)/)) {
      if (piece.length === 0) continue;
      tokens.push({
        text: piece,
        run: style,
        width: measure(piece, style, run.text),
        isSpace: WHITESPACE.test(piece),
        source: { paragraph: paragraphIndex, run: runIndex },
        sourceText: run.text,
      });
    }
  });
  return tokens;
}

/**
 * Greedy line breaking. `firstWidth` applies to the first line only (first-line
 * and hanging indents); an oversized word is hard-broken by character so nothing
 * can overflow the block.
 */
export function breakTokens(
  tokens: Token[],
  firstWidth: number,
  restWidth: number,
  measure: Measure,
): Token[][] {
  const lines: Token[][] = [];
  let line: Token[] = [];
  let used = 0;
  let limit = Math.max(1, firstWidth);

  const closeLine = () => {
    // A line never ends in the space that pushed the next word over.
    while (line.length > 0 && line[line.length - 1].isSpace) line.pop();
    if (line.length > 0) lines.push(line);
    line = [];
    used = 0;
    limit = Math.max(1, restWidth);
  };

  for (const token of tokens) {
    let current = token;
    for (;;) {
      const empty = line.length === 0;
      // A line never starts with the whitespace that ended the previous one.
      if (empty && current.isSpace) break;
      if (empty && current.width > limit) {
        const { head, tail } = splitToken(current, limit, measure);
        if (head.text.length === 0) break;
        line.push(head);
        used += head.width;
        closeLine();
        current = tail;
        continue;
      }
      if (used + current.width > limit) {
        closeLine();
        continue;
      }
      line.push(current);
      used += current.width;
      break;
    }
  }
  closeLine();
  return lines.length > 0 ? lines : [[]];
}

function splitToken(token: Token, width: number, measure: Measure): { head: Token; tail: Token } {
  const characters = [...token.text];
  let taken = '';
  for (const char of characters) {
    const candidate = taken + char;
    if (measure(candidate, token.run, token.sourceText) > width && taken.length > 0) break;
    taken = candidate;
  }
  if (taken.length === 0) taken = characters[0] ?? '';
  const rest = characters.slice(taken.length).join('');
  return {
    head: { ...token, text: taken, width: measure(taken, token.run, token.sourceText) },
    tail: { ...token, text: rest, width: measure(rest, token.run, token.sourceText) },
  };
}

/** x offset of a line inside its measure for the block alignment. */
export function alignOffset(align: TextAlign, lineWidth: number, boxWidth: number): number {
  const slack = Math.max(0, boxWidth - lineWidth);
  if (align === 'center') return slack / 2;
  if (align === 'right') return slack;
  return 0;
}

/* ------------------------------------------------------------------ *
 * Edit objects                                                        *
 * ------------------------------------------------------------------ */

export type ObjectKind = 'text' | 'image' | 'shape';
export type EditScope = 'text' | 'image' | 'shape' | 'all';
export type ToolMode = 'edit' | 'add-text' | 'add-image';

/** How far the commit got; drives the badges in the objects list. */
export type CommitState = 'draft' | 'queued' | 'written' | 'needs-engine' | 'failed';

export interface BaseObject {
  id: string;
  /** 1-based page. */
  page: number;
  kind: ObjectKind;
  /** Viewer-space box, points at scale 1. */
  box: TopLeftBox;
  /** Clockwise quarter turn applied on screen. */
  rotation: number;
  flipH: boolean;
  flipV: boolean;
  /** Paint order among the editor's own objects; the page stays underneath. */
  z: number;
  alt: string;
  state: CommitState;
  note?: string;
}

export interface TextObject extends BaseObject {
  kind: 'text';
  paragraphs: DocParagraph[];
  style: EditorStyle;
  /** Viewer-space boxes of the source runs this object replaces. */
  deletion: TopLeftBox[];
  /** Colour sampled from behind the block, used for the on-screen patch. */
  paperColor: string;
  /** Source paragraph id, so find & replace edits the same block twice. */
  sourceId: string;
  /** Source paragraph was an invisible OCR layer. */
  fromInvisibleLayer: boolean;
}

export interface ImageObject extends BaseObject {
  kind: 'image';
  bytes: Uint8Array;
  mime: string;
  /** Natural pixel size, so "replace image keeping placement" can rescale. */
  intrinsic?: { width: number; height: number };
}

/**
 * A flat rectangle painted over page content.
 *
 * This is what "delete this page image" means with a client-only engine: the
 * producer's pixels stay in the file, covered by a patch in the page's own
 * colour. Only a raster pass (`core/render` + `core/raster`, or the optional
 * PyMuPDF engine) removes them, and the UI says so.
 */
export interface PatchObject extends BaseObject {
  kind: 'shape';
  color: string;
}

export type EditObject = TextObject | ImageObject | PatchObject;

export function scopeAllows(kind: ObjectKind, scope: EditScope): boolean {
  return scope === 'all' || scope === kind;
}

/** Objects of one page in paint order. */
export function objectsForPage(objects: EditObject[], page: number): EditObject[] {
  return objects
    .filter((object) => object.page === page)
    .sort((a, b) => a.z - b.z || a.box.y - b.box.y || a.box.x - b.box.x);
}

/** Top-most object of the allowed scope under a viewer-space point. */
export function objectAtPoint(
  objects: EditObject[],
  page: number,
  point: Point,
  scope: EditScope,
): EditObject | null {
  const hits = objectsForPage(objects, page).filter(
    (object) => scopeAllows(object.kind, scope) && boxContains(object.box, point),
  );
  return hits.length > 0 ? hits[hits.length - 1] : null;
}

export type AlignMode = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
export type DistributeAxis = 'horizontal' | 'vertical';

/** Move selected boxes onto a shared edge / centre line. */
export function alignBoxes(boxes: TopLeftBox[], mode: AlignMode): TopLeftBox[] {
  if (boxes.length === 0) return [];
  const union = unionBoxes(boxes);
  return boxes.map((box) => {
    switch (mode) {
      case 'left':
        return { ...box, x: union.x };
      case 'center':
        return { ...box, x: union.x + (union.width - box.width) / 2 };
      case 'right':
        return { ...box, x: union.x + union.width - box.width };
      case 'top':
        return { ...box, y: union.y };
      case 'middle':
        return { ...box, y: union.y + (union.height - box.height) / 2 };
      default:
        return { ...box, y: union.y + union.height - box.height };
    }
  });
}

/** Even gaps along one axis, first and last staying put. */
export function distributeBoxes(boxes: TopLeftBox[], axis: DistributeAxis): TopLeftBox[] {
  const out = boxes.map((box) => ({ ...box }));
  if (boxes.length < 3) return out;
  const start = (box: TopLeftBox) => (axis === 'horizontal' ? box.x : box.y);
  const size = (box: TopLeftBox) => (axis === 'horizontal' ? box.width : box.height);
  const order = boxes.map((box, index) => ({ box, index })).sort((a, b) => start(a.box) - start(b.box));
  const first = order[0].box;
  const last = order[order.length - 1].box;
  const free = start(last) - (start(first) + size(first));
  const middles = order.slice(1, -1);
  const occupied = middles.reduce((sum, entry) => sum + size(entry.box), 0);
  const gap = (free - occupied) / (middles.length + 1);
  let cursor = start(first) + size(first) + gap;
  for (const entry of middles) {
    const placed = { ...entry.box };
    if (axis === 'horizontal') placed.x = cursor;
    else placed.y = cursor;
    out[entry.index] = placed;
    cursor += size(entry.box) + gap;
  }
  return out;
}

export type ZOrder = 'front' | 'back' | 'forward' | 'backward';

/** Reassign `z` so the chosen objects move through the paint order. */
export function reorderZ(objects: EditObject[], ids: string[], order: ZOrder): EditObject[] {
  const sorted = [...objects].sort((a, b) => a.z - b.z);
  const chosen = sorted.filter((object) => ids.includes(object.id));
  if (chosen.length === 0) return objects;
  const rest = sorted.filter((object) => !ids.includes(object.id));
  let next: EditObject[];
  if (order === 'front') next = [...rest, ...chosen];
  else if (order === 'back') next = [...chosen, ...rest];
  else {
    next = [...sorted];
    const direction = order === 'forward' ? 1 : -1;
    const scan = next.map((_, index) => index);
    if (direction > 0) scan.reverse();
    for (const index of scan) {
      const swap = index + direction;
      if (swap < 0 || swap >= next.length) continue;
      if (ids.includes(next[swap].id)) continue;
      const moving = ids.includes(next[index].id);
      if (!moving) continue;
      const other = next[index];
      next[index] = next[swap];
      next[swap] = other;
    }
  }
  return next.map((object, index) => ({ ...object, z: index }));
}

/* ------------------------------------------------------------------ *
 * Object reducer                                                      *
 * ------------------------------------------------------------------ */

export type EditorAction =
  | { type: 'add'; object: EditObject }
  | { type: 'add-many'; objects: EditObject[] }
  | { type: 'replace'; id: string; object: EditObject }
  | { type: 'remove'; ids: string[] }
  | { type: 'move'; ids: string[]; dx: number; dy: number }
  | { type: 'set-box'; id: string; box: TopLeftBox }
  | { type: 'transform'; ids: string[]; rotation?: number; flipH?: boolean; flipV?: boolean }
  | { type: 'style'; ids: string[]; patch: Partial<EditorStyle> }
  | { type: 'inline-style'; ids: string[]; patch: Partial<InlineStyle> }
  | { type: 'paragraph-style'; id: string; patch: ParagraphStyle }
  | { type: 'list'; ids: string[]; list: ListKind }
  | { type: 'text'; id: string; paragraphs: DocParagraph[] }
  | { type: 'align'; ids: string[]; mode: AlignMode }
  | { type: 'distribute'; ids: string[]; axis: DistributeAxis }
  | { type: 'zorder'; ids: string[]; order: ZOrder }
  | { type: 'alt'; ids: string[]; alt: string }
  | { type: 'duplicate'; ids: string[]; clone: (object: EditObject) => EditObject }
  | { type: 'replace-image'; id: string; bytes: Uint8Array; mime: string; intrinsic?: { width: number; height: number } }
  | { type: 'commit-state'; ids: string[]; state: CommitState; note?: string };

function mapSelected(objects: EditObject[], ids: string[], fn: (object: EditObject) => EditObject): EditObject[] {
  return objects.map((object) => (ids.includes(object.id) ? fn(object) : object));
}

function withBlockStyle(object: EditObject, patch: Partial<EditorStyle>): EditObject {
  if (object.kind !== 'text') return object;
  const style: EditorStyle = { ...object.style };
  for (const [key, value] of Object.entries(patch) as [keyof EditorStyle, unknown][]) {
    if (typeof value === 'number') {
      (style[key] as number) = clampStyle(key, value);
    } else if (value !== undefined) {
      (style[key] as never) = value as never;
    }
  }
  return { ...object, style };
}

/**
 * The single place edit-object state changes. Total (never throws) because it
 * runs on every keystroke and every drag; undo/redo replays its output.
 */
export function editObjects(objects: EditObject[], action: EditorAction): EditObject[] {
  switch (action.type) {
    case 'add':
      return [...objects, action.object];
    case 'add-many':
      return [...objects, ...action.objects];
    case 'replace':
      return objects.map((object) => (object.id === action.id ? action.object : object));
    case 'remove':
      return objects.filter((object) => !action.ids.includes(object.id));
    case 'move':
      return mapSelected(objects, action.ids, (object) => ({
        ...object,
        box: { ...object.box, x: object.box.x + action.dx, y: object.box.y + action.dy },
      }));
    case 'set-box':
      return objects.map((object) => (object.id === action.id ? { ...object, box: action.box } : object));
    case 'transform':
      return mapSelected(objects, action.ids, (object) => ({
        ...object,
        rotation: action.rotation ?? object.rotation,
        flipH: action.flipH ?? object.flipH,
        flipV: action.flipV ?? object.flipV,
      }));
    case 'style':
      return mapSelected(objects, action.ids, (object) => withBlockStyle(object, action.patch));
    case 'inline-style':
      return mapSelected(objects, action.ids, (object) => {
        if (object.kind !== 'text') return object;
        const patch = withSizeClamped(object, action.patch);
        return {
          ...object,
          style: { ...object.style, ...patch },
          paragraphs: object.paragraphs.map((paragraph) => ({
            ...paragraph,
            runs: paragraph.runs.map((run) => ({ ...run, style: { ...run.style, ...patch } })),
          })),
        };
      });
    case 'paragraph-style':
      return objects.map((object) =>
        object.id === action.id && object.kind === 'text'
          ? {
              ...object,
              paragraphs: object.paragraphs.map((paragraph) => ({
                ...paragraph,
                style: { ...paragraph.style, ...action.patch },
              })),
            }
          : object,
      );
    case 'list':
      return mapSelected(objects, action.ids, (object) => {
        if (object.kind !== 'text') return object;
        const list = object.paragraphs.every((p) => p.list === action.list) && action.list !== 'none' ? 'none' : action.list;
        return {
          ...object,
          style: { ...object.style, list },
          paragraphs: object.paragraphs.map((paragraph) => ({ ...paragraph, list })),
        };
      });
    case 'text':
      return objects.map((object) =>
        object.id === action.id && object.kind === 'text'
          ? { ...object, paragraphs: action.paragraphs, state: 'draft' }
          : object,
      );
    case 'align': {
      const selected = objects.filter((object) => action.ids.includes(object.id));
      const boxes = alignBoxes(selected.map((object) => object.box), action.mode);
      return objects.map((object) => {
        const index = selected.indexOf(object);
        return index >= 0 ? { ...object, box: boxes[index] } : object;
      });
    }
    case 'distribute': {
      const selected = objects.filter((object) => action.ids.includes(object.id));
      const boxes = distributeBoxes(selected.map((object) => object.box), action.axis);
      return objects.map((object) => {
        const index = selected.indexOf(object);
        return index >= 0 ? { ...object, box: boxes[index] } : object;
      });
    }
    case 'zorder':
      return reorderZ(objects, action.ids, action.order);
    case 'alt':
      return mapSelected(objects, action.ids, (object) => ({ ...object, alt: action.alt }));
    case 'duplicate': {
      const copies = objects.filter((object) => action.ids.includes(object.id)).map(action.clone);
      return [...objects, ...copies];
    }
    case 'replace-image':
      return objects.map((object) =>
        object.id === action.id && object.kind === 'image'
          ? {
              ...object,
              bytes: action.bytes,
              mime: action.mime,
              intrinsic: action.intrinsic ?? object.intrinsic,
              state: 'draft',
            }
          : object,
      );
    case 'commit-state':
      return mapSelected(objects, action.ids, (object) => ({
        ...object,
        state: action.state,
        note: action.note,
      }));
    default:
      return objects;
  }
}

/**
 * Inline patches apply to the whole object *and* every run, because the writer
 * reads runs first. A run that explicitly disagrees keeps its own value only
 * when the patch does not mention the key — the reducer is last-write-wins.
 */
function withSizeClamped(object: TextObject, patch: Partial<InlineStyle>): Partial<InlineStyle> {
  const out: Partial<InlineStyle> = { ...patch };
  if (typeof out.size === 'number') out.size = clampStyle('size', out.size);
  void object;
  return out;
}

/* ------------------------------------------------------------------ *
 * Undo / redo                                                         *
 * ------------------------------------------------------------------ */

export const HISTORY_LIMIT = 60;

export interface HistoryState<T> {
  past: T[];
  present: T;
  future: T[];
}

export function createHistory<T>(initial: T): HistoryState<T> {
  return { past: [], present: initial, future: [] };
}

/** Record a new value; a fresh edit always drops the redo branch. */
export function pushHistory<T>(history: HistoryState<T>, next: T): HistoryState<T> {
  if (history.present === next) return history;
  const past = [...history.past, history.present];
  while (past.length > HISTORY_LIMIT) past.shift();
  return { past, present: next, future: [] };
}

/** Replace the tip without growing the stack (live drags, keystrokes). */
export function amendHistory<T>(history: HistoryState<T>, next: T): HistoryState<T> {
  return { ...history, present: next };
}

export function undoHistory<T>(history: HistoryState<T>): HistoryState<T> {
  if (history.past.length === 0) return history;
  const past = [...history.past];
  const present = past.pop() as T;
  return { past, present, future: [history.present, ...history.future] };
}

export function redoHistory<T>(history: HistoryState<T>): HistoryState<T> {
  if (history.future.length === 0) return history;
  const [present, ...future] = history.future;
  return { past: [...history.past, history.present], present: present as T, future };
}

export const canUndo = (history: HistoryState<unknown>): boolean => history.past.length > 0;
export const canRedo = (history: HistoryState<unknown>): boolean => history.future.length > 0;

/**
 * What assistive tech hears after an undo or redo, computed from the history
 * *before* the step runs. A silent undo is indistinguishable from a dead key,
 * so the sentence names the remaining depth in both directions.
 */
export function historyReport(history: HistoryState<unknown>, action: 'undo' | 'redo'): string {
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  if (action === 'undo') {
    if (history.past.length === 0) return 'Nothing to undo.';
    const left = history.past.length - 1;
    const redoable = history.future.length + 1;
    return left === 0
      ? `Undid the last change. Nothing left to undo, ${plural(redoable, 'redo')} available.`
      : `Undid the last change. ${plural(left, 'undo')} left, ${plural(redoable, 'redo')} available.`;
  }
  if (history.future.length === 0) return 'Nothing to redo.';
  const left = history.future.length - 1;
  const undoable = history.past.length + 1;
  return left === 0
    ? `Redid the change. Nothing left to redo, ${plural(undoable, 'undo')} available.`
    : `Redid the change. ${plural(left, 'redo')} left, ${plural(undoable, 'undo')} available.`;
}

/** Ids that still name a live object — after an undo, selections can dangle. */
export function pruneSelection(objects: EditObject[], selection: string[]): string[] {
  const alive = new Set(objects.map((object) => object.id));
  return selection.filter((id) => alive.has(id));
}

/* ------------------------------------------------------------------ *
 * Find & replace                                                      *
 * ------------------------------------------------------------------ */

export interface FindOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  ignoreAccents?: boolean;
}

export interface TextRange {
  start: number;
  end: number;
}

/**
 * Fold text for matching: `folded` is what the needle is compared against, and
 * `start`/`end` map every folded index back onto the UTF-16 offsets of the
 * original, so an accent- or case-insensitive hit can still be replaced and
 * highlighted in the source text.
 */
export function foldForSearch(
  text: string,
  options: FindOptions = {},
): { folded: string; start: number[]; end: number[] } {
  const folded: string[] = [];
  const start: number[] = [];
  const end: number[] = [];
  const strip = options.ignoreAccents === true;
  const lower = options.caseSensitive !== true;

  for (let index = 0; index < text.length; index += 1) {
    let char = text[index];
    let charStart = index;
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      char = text.slice(index, index + 2);
      index += 1;
    }
    let out = char;
    if (strip) out = out.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (lower) out = out.toLowerCase();
    // One mapping entry per UTF-16 unit of the folded output, because
    // `indexOf` reports unit offsets and an astral character is two of them.
    for (let unit = 0; unit < out.length; unit += 1) {
      folded.push(out[unit]);
      start.push(charStart);
      end.push(index + 1);
    }
  }
  return { folded: folded.join(''), start, end };
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** Every occurrence of `query` in `text`, honouring the find options. */
export function findRanges(text: string, query: string, options: FindOptions = {}): TextRange[] {
  if (query.length === 0 || text.length === 0) return [];
  const source = foldForSearch(text, options);
  const needle = foldForSearch(query, options).folded;
  if (needle.length === 0) return [];
  const ranges: TextRange[] = [];
  for (let at = source.folded.indexOf(needle); at >= 0; at = source.folded.indexOf(needle, at + 1)) {
    const lastIndex = at + needle.length - 1;
    const startAt = source.start[at] ?? 0;
    const endAt = source.end[lastIndex] ?? text.length;
    if (options.wholeWord) {
      const before = startAt > 0 ? text[startAt - 1] : '';
      const after = endAt < text.length ? text[endAt] : '';
      if (WORD_CHAR.test(before) || WORD_CHAR.test(after)) continue;
    }
    const duplicate = ranges.some((range) => range.start === startAt && range.end === endAt);
    if (!duplicate) ranges.push({ start: startAt, end: endAt });
  }
  return ranges;
}

/** Replace every match, or only the ranges handed in. */
export function replaceInText(
  text: string,
  query: string,
  replacement: string,
  options: FindOptions = {},
  only?: TextRange[],
): { text: string; count: number } {
  const ranges = (only ?? findRanges(text, query, options)).slice().sort((a, b) => a.start - b.start);
  if (ranges.length === 0) return { text, count: 0 };
  let out = '';
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    out += text.slice(cursor, range.start) + replacement;
    cursor = range.end;
  }
  out += text.slice(cursor);
  return { text: out, count: ranges.length };
}

/** A search hit, positioned in viewer space for scrolling and highlighting. */
export interface SearchHit {
  id: string;
  /** Source block the hit was found in. */
  sourceId: string;
  page: number;
  range: TextRange;
  /** Line boxes the hit touches. */
  boxes: TopLeftBox[];
  preview: string;
}

export interface SearchableBlock {
  id: string;
  page: number;
  text: string;
  lines: { box: TopLeftBox; start: number; end: number }[];
}

/** Blocks from clustered paragraphs — the index find & replace works over. */
export function searchableBlocks(paragraphs: ExtractedParagraph[]): SearchableBlock[] {
  return paragraphs.map((paragraph) => ({
    id: paragraph.id,
    page: paragraph.page,
    text: paragraph.text,
    lines: paragraph.lines.map((line) => ({ box: line.box, start: line.start, end: line.end })),
  }));
}

/**
 * Find `query` in every block of every page. Text the user already edited is
 * searched in its edited form, so Replace All stays idempotent.
 */
export function searchBlocks(blocks: SearchableBlock[], query: string, options: FindOptions = {}): SearchHit[] {
  if (query.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const block of blocks) {
    for (const range of findRanges(block.text, query, options)) {
      hits.push({
        id: `${block.id}:${range.start}`,
        sourceId: block.id,
        page: block.page,
        range,
        boxes: block.lines
          .filter((line) => line.end > range.start && line.start < range.end)
          .map((line) => line.box),
        preview: contextOf(block.text, range),
      });
    }
  }
  return hits;
}

function contextOf(text: string, range: TextRange, radius = 24): string {
  const start = Math.max(0, range.start - radius);
  const end = Math.min(text.length, range.end + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${end < text.length ? '…' : ''}`;
}

/**
 * The subset of `ranges` that still lands on `query` in `text`.
 *
 * A hit list is a snapshot; the block underneath it is not. Replacing a stale
 * offset would edit whatever characters now sit there, which is the definition
 * of a silent wrong answer, so the caller refuses those ranges instead.
 */
export function liveRanges(
  text: string,
  query: string,
  options: FindOptions,
  ranges: TextRange[],
): TextRange[] {
  const fresh = findRanges(text, query, options);
  return ranges.filter((range) => fresh.some((entry) => entry.start === range.start && entry.end === range.end));
}

/**
 * Re-point a search block at text the user has already retyped.
 *
 * Find and replace must run over what is on the page *now*, or a replacement
 * quietly throws away the edit made a moment ago. Line offsets cannot survive a
 * rewrite, so the block keeps one line spanning its whole box.
 */
export function retextBlock(block: SearchableBlock, text: string): SearchableBlock {
  if (block.text === text) return block;
  if (text.length === 0 || block.lines.length === 0) return { ...block, text, lines: [] };
  return {
    ...block,
    text,
    lines: [{ box: unionBoxes(block.lines.map((line) => line.box)), start: 0, end: text.length }],
  };
}

/* ------------------------------------------------------------------ *
 * Colour sampling                                                     *
 * ------------------------------------------------------------------ */

export interface Palette {
  /** The ink colour of the block, `#rrggbb`. */
  color: string;
  /** The colour to paint over the deleted runs. */
  background: string;
}

/**
 * Guess a block's ink and paper colours from rendered pixels.
 *
 * pdf.js extraction carries no colour, and reading the `rg`/`g` operators needs
 * the content stream (a PyMuPDF / PDFium job). Sampling the page image the
 * viewer already painted is what non-PDFium editors do, and it is exact for the
 * flat-background case that dominates real documents: the majority cluster is
 * the paper, the strongest luma outlier is the ink.
 */
export function samplePalette(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  box: TopLeftBox,
  scale = 1,
): Palette {
  const x1 = clamp(Math.floor(box.x * scale), 0, Math.max(0, width - 1));
  const y1 = clamp(Math.floor(box.y * scale), 0, Math.max(0, height - 1));
  const x2 = clamp(Math.ceil((box.x + box.width) * scale), x1 + 1, width);
  const y2 = clamp(Math.ceil((box.y + box.height) * scale), y1 + 1, height);

  const buckets = new Map<string, { count: number; r: number; g: number; b: number }>();
  let total = 0;
  for (let y = y1; y < y2; y += 1) {
    for (let x = x1; x < x2; x += 1) {
      const at = (y * width + x) * 4;
      if (at + 3 >= rgba.length) continue;
      if (rgba[at + 3] < 8) continue;
      total += 1;
      // 4 bits per channel: fine enough to separate paper from ink, coarse
      // enough that anti-aliased glyph edges do not smear the histogram.
      const key = `${rgba[at] >> 4},${rgba[at + 1] >> 4},${rgba[at + 2] >> 4}`;
      const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
      bucket.count += 1;
      bucket.r += rgba[at];
      bucket.g += rgba[at + 1];
      bucket.b += rgba[at + 2];
      buckets.set(key, bucket);
    }
  }
  if (total === 0) return { color: '#000000', background: '#ffffff' };

  const ranked = [...buckets.values()]
    .map((bucket) => ({
      count: bucket.count,
      color: [
        Math.round(bucket.r / bucket.count),
        Math.round(bucket.g / bucket.count),
        Math.round(bucket.b / bucket.count),
      ] as [number, number, number],
    }))
    .sort((a, b) => b.count - a.count);

  const background = ranked[0];
  const backgroundLuma = luma(background.color);
  const candidates = ranked.slice(1).filter((bucket) => bucket.count >= Math.max(3, total * 0.003));
  const ink = candidates
    .map((bucket) => ({ bucket, distance: Math.abs(luma(bucket.color) - backgroundLuma) }))
    .sort((a, b) => b.distance - a.distance)[0];
  const color: [number, number, number] =
    ink && ink.distance > 40
      ? ink.bucket.color
      : backgroundLuma > 128
        ? [0, 0, 0]
        : [255, 255, 255];

  return { color: toHex(color), background: toHex(background.color) };
}

function luma(rgb: readonly number[]): number {
  const [r, g, b] = rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function toHex(rgb: readonly number[]): string {
  return `#${rgb.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('')}`;
}

export function hexToRgb(hex: string): [number, number, number] {
  const clean = String(hex ?? '').trim().replace(/^#/, '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return [0, 0, 0];
  const int = Number.parseInt(full, 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

export function isHexColor(value: string): boolean {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(value ?? '').trim());
}

export const SWATCH_COLORS = [
  '#000000', '#434343', '#666666', '#999999', '#ffffff',
  '#ea4335', '#fbbc04', '#34a853', '#4285f4', '#8e24aa',
  '#f4511e', '#6aa84f', '#0b5394', '#a142f4', '#38761d',
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/* ------------------------------------------------------------------ *
 * Zoom, rulers, ids                                                   *
 * ------------------------------------------------------------------ */

export const ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;

export type FitMode = 'width' | 'page';

/** Scale that fits a page into a viewport for a fit mode. */
export function fitScale(
  page: { width: number; height: number },
  viewport: { width: number; height: number },
  mode: FitMode,
  padding = 32,
): number {
  if (!(page.width > 0) || !(page.height > 0)) return 1;
  const available = Math.max(40, viewport.width - padding);
  const availableHeight = Math.max(40, viewport.height - padding);
  const ratio =
    mode === 'page'
      ? Math.min(available / page.width, availableHeight / page.height)
      : available / page.width;
  return Math.min(8, Math.max(0.05, ratio));
}

export interface RulerTick {
  position: number;
  label: string;
}

/**
 * Ruler graduations in CSS pixels for a page drawn at `scale` (1 = 1 pt/px).
 * The step is the smallest of 10/20/50/100 pt that stays legible.
 */
export function rulerTicks(lengthPoints: number, scale: number, minSpacingPx = 48): RulerTick[] {
  const steps = [10, 20, 50, 100, 200];
  const step = steps.find((candidate) => candidate * scale >= minSpacingPx) ?? 500;
  const out: RulerTick[] = [];
  for (let value = 0; value <= lengthPoints; value += step) {
    out.push({ position: value * scale, label: String(value) });
  }
  return out;
}

let idCounter = 0;

/** Short unique ids, so the object list, the log and the DOM agree. */
export function nextObjectId(prefix: 'text' | 'image'): string {
  idCounter += 1;
  return `${prefix}-${idCounter.toString(36)}`;
}

/** Reset the id counter. Only tests need this. */
export function resetObjectIds(): void {
  idCounter = 0;
}

/** Deletion boxes for a source paragraph: one padded box per line. */
export function deletionBoxes(paragraph: ExtractedParagraph, padding = 0.6): TopLeftBox[] {
  return paragraph.lines.map((line) => padBox(line.box, padding, padding * 0.6));
}

/** Page-level boxes for an object list header / status line. */
export function objectsSummary(objects: EditObject[]): { text: number; images: number; pending: number } {
  return {
    text: objects.filter((object) => object.kind === 'text').length,
    images: objects.filter((object) => object.kind === 'image').length,
    pending: objects.filter((object) => object.state === 'draft' || object.state === 'queued').length,
  };
}

/**
 * Where a point of an object lands after the object is turned `degrees`
 * clockwise about its own centre (viewer space).
 */
export function rotatePointAboutCenter(box: TopLeftBox, degrees: number, point: Point): Point {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const m = multiplyMatrices(
    multiplyMatrices(translationMatrix(cx, cy), rotationMatrix(degrees)),
    translationMatrix(-cx, -cy),
  );
  return applyMatrix(m, point);
}

/**
 * The subset of pdf.js's `OPS` table {@link detectPageObjects} reads. Codes are
 * numbers that differ between pdf.js releases, so the caller passes the table it
 * loaded rather than the editor hard-coding them.
 */
export interface OperatorCodes {
  save: number;
  restore: number;
  transform: number;
  paintImageXObject: number;
  paintImageXObjectRepeat: number;
  paintInlineImageXObject: number;
  paintImageMaskXObject: number;
  paintSolidColorImageMask: number;
  constructPath: number;
  fill: number;
  stroke: number;
  fillStroke: number;
  endPath: number;
}

export interface DetectedPageObject {
  kind: 'image' | 'shape';
  box: TopLeftBox;
}

/**
 * Raster and vector placements on one page, from pdf.js's flattened operator
 * list, in viewer space at one unit per point.
 *
 * pdf.js resolves XObject `Do` calls and page rotation into the list it hands
 * over, so the current transform is all this needs: an image paints the unit
 * square, `constructPath` arrives as a flat `[x, y, …]` array. A repeated image
 * is reported once, at its first placement.
 */
export function detectPageObjects(
  fnArray: ArrayLike<number>,
  argsArray: readonly (readonly unknown[] | null)[],
  codes: OperatorCodes,
  limits: { width: number; height: number },
): DetectedPageObject[] {
  const imageCodes = new Set([codes.paintImageXObject, codes.paintImageXObjectRepeat, codes.paintInlineImageXObject, codes.paintImageMaskXObject]);
  const paintCodes = new Set([codes.fill, codes.stroke, codes.fillStroke]);
  const out: DetectedPageObject[] = [];
  const stack: Matrix6[] = [];
  let ctm = identityMatrix();
  let path: TopLeftBox | null = null;

  const pushBox = (kind: 'image' | 'shape', box: TopLeftBox) => {
    if (!(box.width > 0.5) || !(box.height > 0.5)) return;
    if (box.x > limits.width || box.y > limits.height) return;
    if (box.x + box.width < 0 || box.y + box.height < 0) return;
    out.push({ kind, box });
  };

  for (let index = 0; index < fnArray.length; index += 1) {
    const fn = fnArray[index];
    const args = (argsArray[index] ?? []) as readonly unknown[];
    if (fn === codes.save) {
      stack.push(ctm);
      continue;
    }
    if (fn === codes.restore) {
      ctm = stack.pop() ?? identityMatrix();
      continue;
    }
    if (fn === codes.transform && args.length >= 6) {
      const m = args.slice(0, 6).map(Number) as Matrix6;
      if (m.every(Number.isFinite)) ctm = multiplyMatrices(ctm, m);
      continue;
    }
    if (imageCodes.has(fn)) {
      const corners = [
        applyMatrix(ctm, { x: 0, y: 0 }),
        applyMatrix(ctm, { x: 1, y: 0 }),
        applyMatrix(ctm, { x: 1, y: 1 }),
        applyMatrix(ctm, { x: 0, y: 1 }),
      ];
      pushBox('image', boxOf(corners));
      continue;
    }
    if (fn === codes.constructPath) {
      const coords = (args[0] ?? []) as readonly unknown[];
      const points: Point[] = [];
      for (let i = 0; i + 1 < coords.length; i += 2) {
        const x = Number(coords[i]);
        const y = Number(coords[i + 1]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        points.push(applyMatrix(ctm, { x, y }));
      }
      path = points.length > 0 ? boxOf(points) : null;
      continue;
    }
    if (paintCodes.has(fn)) {
      if (path) pushBox('shape', path);
      continue;
    }
    if (fn === codes.endPath) path = null;
  }
  return out;
}

function boxOf(points: Point[]): TopLeftBox {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export type { QuadRect } from '@/lib/pdf/core/tables';
