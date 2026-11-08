/**
 * Measuring the ink an exported annotation carries, from the bytes.
 *
 * The audit this answers asked one question of every tool in the palette: the
 * editor painted something, so does the file? Its canvas side is a real browser
 * (`docs/research/audit3-cdp.mjs`); its byte side rendered each page twice with
 * PyMuPDF and diffed the pixels. Neither is available inside vitest — jsdom has
 * no canvas and no PDF renderer — so this harness measures the same thing from
 * the one source that is available: the operators of the `/AP /N` stream, read
 * back out of a saved file.
 *
 * What it counts, in pt²:
 * - a filled path: the polygon its points enclose (`re`, `m`/`l`/`c`, `f`);
 * - a stroked path: length × line width, with the dash's gaps subtracted (`S`);
 * - a placed XObject: the `/BBox` area through the current transform (`Do`);
 * - a shown text run: the glyph boxes it lays out (`Tj`, `TJ`).
 *
 * Curves are measured through their control points, so a bézier reads a little
 * larger than the ink it lays down, and a text run uses half an em per glyph
 * because the advance widths live in a font program this harness does not open.
 * Neither weakens the check: it is used as a gate — *some* ink versus *none* —
 * and an empty stream (`q Q`) measures exactly 0.
 *
 * The alpha that would hide the ink is folded in: the annotation's `/CA` and any
 * `/ExtGState` fill/stroke alpha the stream applies. Ink painted at alpha 0 is
 * not visible, which is the whole finding this harness exists to catch.
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  decodePDFRawStream,
  type PDFContext,
} from '@maxwbh/pdf-lib';
import {
  addAnnotation,
  type AnnotationKind,
  type AnnotationSpec,
} from '@/lib/pdf/core/annotations';

export interface AppearanceInk {
  /** The decoded operators, so a failure can be read rather than guessed at. */
  ops: string;
  /** pt² the file lays down, after every alpha that would hide it. */
  inkPt2: number;
  /** Every painting operator seen, including ones that painted no area. */
  paintOps: string[];
}

const EMPTY: AppearanceInk = { ops: '', inkPt2: 0, paintOps: [] };

interface Point {
  x: number;
  y: number;
}

interface Subpath {
  points: Point[];
  closed: boolean;
}

interface GraphicsState {
  ctm: number[];
  lineWidth: number;
  fillAlpha: number;
  strokeAlpha: number;
  /** The dash array's on/total ratio; 1 for a solid rule. */
  dashOnShare: number;
  fontSize: number;
  /** Text render mode 3 is invisible. */
  renderMode: number;
}

const IDENTITY = [1, 0, 0, 1, 0, 0];

/** A glyph box, as a share of the em: Helvetica averages about half an em wide. */
const GLYPH_BOX_SHARE_OF_EM = 0.5;

/**
 * The normal appearance (`/AP /N`) of one annotation dictionary, as the saved
 * file holds it.
 */
export function normalAppearanceStream(doc: PDFDocument, dict: PDFDict): PDFRawStream | null {
  const resolve = resolverFor(dict.context);
  const ap = asDict(dict.get(PDFName.of('AP')), resolve);
  const normal = ap ? resolve(ap.get(PDFName.of('N'))) : undefined;
  return normal instanceof PDFRawStream ? normal : null;
}

/** Measure one annotation dictionary's appearance. */
export function appearanceInk(doc: PDFDocument, dict: PDFDict): AppearanceInk {
  const stream = normalAppearanceStream(doc, dict);
  if (!stream) return { ...EMPTY };
  const ops = new TextDecoder().decode(decodePDFRawStream(stream).decode());
  const opacity = readNumber(dict.get(PDFName.of('CA')));
  const resources = asDict(stream.dict.get(PDFName.of('Resources')), resolverFor(stream.dict.context));
  const ink = measureOps(ops, resources);
  // `/CA` 0 hides the whole appearance, ink and all. Absent means 1.
  const visible = Number.isFinite(opacity) ? Math.min(Math.max(opacity, 0), 1) : 1;
  return { ops, inkPt2: ink.inkPt2 * visible, paintOps: ink.paintOps };
}

/**
 * Measure one appearance stream's operators.
 *
 * `resources` is the stream's own `/Resources` dict, which is where `/GS1` and
 * `/Im0` resolve to the state and the image they name; without it an alpha or a
 * placed image is a name this harness cannot price, and is counted as solid ink
 * over nothing.
 */
export function measureOps(ops: string, resources: PDFDict | null = null): AppearanceInk {
  const paintOps: string[] = [];
  let area = 0;
  let path: Subpath[] = [];
  let current: Subpath | null = null;
  const states: GraphicsState[] = [];
  let state: GraphicsState = {
    ctm: IDENTITY.slice(),
    lineWidth: 1,
    fillAlpha: 1,
    strokeAlpha: 1,
    dashOnShare: 1,
    fontSize: 0,
    renderMode: 0,
  };

  const moveTo = (x: number, y: number) => {
    current = { points: [{ x, y }], closed: false };
    path.push(current);
  };
  const appendTo = (...points: Point[]) => {
    if (!current) {
      moveTo(points[0].x, points[0].y);
      current = path[path.length - 1];
      for (const point of points.slice(1)) current.points.push(point);
      return;
    }
    for (const point of points) current.points.push(point);
  };
  const fillArea = () => path.reduce((total, sub) => total + (sub.points.length >= 3 ? ringArea(sub.points) : 0), 0);
  const strokeArea = () => {
    let length = 0;
    for (const sub of path) {
      const pts = sub.closed
        ? [...sub.points, sub.points[0]]
        : sub.points;
      for (let i = 1; i < pts.length; i += 1) {
        length += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      }
    }
    return length * Math.max(state.lineWidth, 0) * state.dashOnShare;
  };

  const tokens = tokenize(ops);
  let operands: string[] = [];
  for (const token of tokens) {
    if (!isOperatorToken(token)) {
      operands.push(token);
      continue;
    }
    const numbers = operands.filter((t) => isNumberToken(t)).map(Number);
    switch (token) {
      case 'q':
        states.push({ ...state, ctm: state.ctm.slice() });
        break;
      case 'Q':
        state = states.pop() ?? state;
        break;
      case 'cm':
        if (numbers.length >= 6) state = { ...state, ctm: multiply(state.ctm, numbers.slice(0, 6)) };
        break;
      case 'w':
        if (numbers.length >= 1) state = { ...state, lineWidth: numbers[numbers.length - 1] };
        break;
      case 'd': {
        const dash = dashArray(operands);
        state = { ...state, dashOnShare: dashShare(dash) };
        break;
      }
      case 'gs': {
        // `/GS1 gs` reads its alphas out of `/Resources /ExtGState`, and only the
        // keys the state carries change anything: `/ca` is the fill, `/CA` the
        // stroke, so a wash can be translucent while its rule stays solid ink.
        const ext = resourceEntry(resources, 'ExtGState', lastNamed(operands));
        const ca = ext ? readNumber(ext.get(PDFName.of('ca'))) : Number.NaN;
        const CA = ext ? readNumber(ext.get(PDFName.of('CA'))) : Number.NaN;
        state = {
          ...state,
          fillAlpha: Number.isFinite(ca) ? Math.min(Math.max(ca, 0), 1) : state.fillAlpha,
          strokeAlpha: Number.isFinite(CA) ? Math.min(Math.max(CA, 0), 1) : state.strokeAlpha,
        };
        break;
      }
      case 'Tr':
        if (numbers.length >= 1) state = { ...state, renderMode: numbers[numbers.length - 1] };
        break;
      case 'Tf': {
        const size = numbers[numbers.length - 1] ?? 0;
        state = { ...state, fontSize: operands.some((t) => t.startsWith('/')) ? size : 0 };
        break;
      }
      case 'm':
        if (numbers.length >= 2) moveTo(numbers[numbers.length - 2], numbers[numbers.length - 1]);
        break;
      case 'l':
        if (numbers.length >= 2) appendTo(pointOf(numbers, 2));
        break;
      case 'c':
        if (numbers.length >= 6) appendTo(pointOf(numbers, 6), pointOf(numbers, 4), pointOf(numbers, 2));
        break;
      case 'v':
      case 'y':
        if (numbers.length >= 4) appendTo(pointOf(numbers, 4), pointOf(numbers, 2));
        break;
      case 're':
        if (numbers.length >= 4) {
          const [x, y, w, h] = numbers.slice(-4);
          path.push({
            points: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }],
            closed: true,
          });
          current = null;
        }
        break;
      case 'h':
        if (current) {
          path[path.length - 1] = { ...path[path.length - 1], closed: true };
          current = null;
        }
        break;
      case 'f':
      case 'F':
      case 'f*':
        paintOps.push(token);
        area += fillArea() * state.fillAlpha;
        path = [];
        current = null;
        break;
      case 'S':
      case 's':
        paintOps.push(token);
        if (token === 's' && current) {
          path[path.length - 1] = { ...path[path.length - 1], closed: true };
        }
        area += strokeArea() * state.strokeAlpha;
        path = [];
        current = null;
        break;
      case 'B':
      case 'B*':
      case 'b':
      case 'b*':
        paintOps.push(token);
        area += fillArea() * state.fillAlpha + strokeArea() * state.strokeAlpha;
        path = [];
        current = null;
        break;
      case 'n':
        path = [];
        current = null;
        break;
      case 'Do': {
        paintOps.push(token);
        const name = lastNamed(operands);
        area += xObjectArea(resources, name) * Math.abs(det(state.ctm)) * state.fillAlpha;
        path = [];
        current = null;
        break;
      }
      case 'Tj':
      case 'TJ':
      case "'":
      case '"': {
        paintOps.push(token);
        // A showing operator paints where its glyphs stand; the boxes are the
        // advance widths, which this harness cannot read out of the font.
        const glyphs = shownGlyphCount(operands, token, numbers);
        if (state.renderMode !== 3 && state.fontSize > 0) {
          area += glyphs * GLYPH_BOX_SHARE_OF_EM * state.fontSize * state.fontSize * state.fillAlpha;
        }
        break;
      }
      default:
        break;
    }
    operands = [];
  }

  return { ops, inkPt2: round4(area), paintOps };
}

/* ------------------------------------------------------------------ *
 * One call per subtype: write the spec, read the bytes                *
 * ------------------------------------------------------------------ */

export interface InkReport {
  /** The kind the editor asked for — `Arrow` stays `Arrow` here, not `/Line`. */
  kind: AnnotationKind;
  /** The tool that produced the spec, when the caller passed one. */
  tool: string;
  /** `/Subtype` as the dictionary holds it. */
  subtype: string;
  /** `/Rect` as the file holds it: [llx lly urx ury]. */
  rect: number[];
  /** `/BS`, for the border a viewer draws when it ignores `/AP`. */
  borderWidth: number;
  borderDash: number[];
  /** The normal appearance stream's operators. */
  ops: string;
  /** pt² the saved file lays down for this annotation. */
  inkPt2: number;
}

export interface InkSubject {
  spec: AnnotationSpec;
  /** The palette entry the mark came from, for a readable row. */
  tool?: string;
}

/**
 * The smallest JPEG `embedRasterImage` will accept: SOI, an 8-bit SOF0 that
 * carries the size, and EOI. A placed raster goes into the file as-is, so a
 * table that measures a Stamp's appearance needs bytes, not a description.
 */
export function fakeJpeg(width = 40, height = 20): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11,
    0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9,
  ]);
}
/**
 * Save and reload one page carrying each spec, and report what the file paints.
 *
 * The round trip is the point: an appearance measured off an in-memory document
 * can still be unreadable bytes on disk. Every spec is written to page 0, which
 * still needs two pages because a link may point at the second one, and the
 * reports come back in the order they were sent so a table can address a row by
 * the tool that made it.
 */
export async function inkOfSpecs(
  subjects: (AnnotationSpec | InkSubject)[],
  pageSize: [number, number] = [612, 792],
): Promise<InkReport[]> {
  const rows = subjects.map((entry) =>
    'spec' in entry ? entry : { spec: entry as AnnotationSpec },
  );
  const doc = await PDFDocument.create();
  doc.addPage(pageSize);
  doc.addPage(pageSize);
  for (const row of rows) addAnnotation(doc, { ...row.spec, page: 0 });
  const bytes = await doc.save({ useObjectStreams: false });
  const reloaded = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const annots = reloaded.getPage(0).node.Annots();
  const size = annots ? annots.size() : 0;
  if (size !== rows.length) {
    throw new Error(`wrote ${rows.length} annotations and the page carries ${size}`);
  }
  const reports: InkReport[] = [];
  const resolve = resolverFor(reloaded.context);
  for (let i = 0; i < size; i += 1) {
    const dict = asDict(annots!.get(i), resolve);
    if (!dict) throw new Error(`annotation slot ${i} did not round-trip as a dictionary`);
    const ink = appearanceInk(reloaded, dict);
    if (!normalAppearanceStream(reloaded, dict)) {
      throw new Error(`${nameOf(dict, 'Subtype')} carried no /AP /N stream at all`);
    }
    const border = asDict(dict.get(PDFName.of('BS')), resolve);
    reports.push({
      kind: rows[i].spec.kind,
      tool: rows[i].tool ?? rows[i].spec.kind,
      subtype: nameOf(dict, 'Subtype'),
      rect: numberArray(dict.get(PDFName.of('Rect')), resolve),
      borderWidth: border ? readNumber(border.get(PDFName.of('W'))) : 0,
      borderDash: border ? numberArray(border.get(PDFName.of('D')), resolve) : [],
      ops: ink.ops,
      inkPt2: ink.inkPt2,
    });
  }
  return reports;
}

/* ------------------------------------------------------------------ *
 * Content-stream tokenizer                                            *
 * ------------------------------------------------------------------ */

const DELIMITERS = /[\s/<(){}[\]]/;

/** Split a content stream into operands and operators, in order. */
function tokenize(content: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < content.length) {
    const char = content[i];
    if (/\s/.test(char)) {
      i += 1;
      continue;
    }
    if (char === '%') {
      while (i < content.length && content[i] !== '\n') i += 1;
      continue;
    }
    if (char === '<' && content[i + 1] === '<') {
      out.push('<<');
      i += 2;
      continue;
    }
    if (char === '>' && content[i + 1] === '>') {
      out.push('>>');
      i += 2;
      continue;
    }
    if (char === '<') {
      const end = content.indexOf('>', i);
      const stop = end < 0 ? content.length : end;
      out.push(`<${content.slice(i + 1, stop).replace(/\s+/g, '')}>`);
      i = stop + 1;
      continue;
    }
    if (char === '(') {
      let depth = 1;
      let j = i + 1;
      while (j < content.length && depth > 0) {
        if (content[j] === '\\') j += 2;
        else {
          if (content[j] === '(') depth += 1;
          else if (content[j] === ')') depth -= 1;
          j += 1;
        }
      }
      out.push(`(${content.slice(i + 1, Math.max(j - 1, i + 1))})`);
      i = j;
      continue;
    }
    if (char === '/' ) {
      let j = i + 1;
      while (j < content.length && !DELIMITERS.test(content[j])) j += 1;
      out.push(content.slice(i, j));
      i = j;
      continue;
    }
    if (char === '[' || char === ']' || char === '{' || char === '}') {
      out.push(char);
      i += 1;
      continue;
    }
    if (isNumberStart(char)) {
      let j = i;
      while (j < content.length && /[+\-.eE0-9]/i.test(content[j]) && !DELIMITERS.test(content[j])) j += 1;
      out.push(content.slice(i, j));
      i = j;
      continue;
    }
    let j = i;
    while (j < content.length && !DELIMITERS.test(content[j])) j += 1;
    if (j === i) j = i + 1;
    out.push(content.slice(i, j));
    i = j;
  }
  return out;
}

const isNumberStart = (char: string): boolean => /[0-9.+-]/.test(char);

const isNumberToken = (token: string): boolean =>
  token !== '[' && token !== ']' && token !== '<<' && token !== '>>' && token !== '-' &&
  token !== '+' && token !== '.' && !Number.isNaN(Number(token));

/** Anything that is not an operand is an operator: PDF's keywords are ASCII. */
const isOperatorToken = (token: string): boolean =>
  !isNumberToken(token) &&
  !token.startsWith('/') &&
  !token.startsWith('<') &&
  !token.startsWith('(') &&
  token !== '[' &&
  token !== ']' &&
  token !== '<<' &&
  token !== '>>' &&
  token !== '{' &&
  token !== '}';

const pointOf = (numbers: number[], fromEnd: number): Point => ({
  x: numbers[numbers.length - fromEnd],
  y: numbers[numbers.length - fromEnd + 1],
});

const lastNamed = (operands: string[]): string | null => {
  for (let i = operands.length - 1; i >= 0; i -= 1) {
    if (operands[i].startsWith('/')) return operands[i].slice(1);
  }
  return null;
};

/** The dash array of `[5 3] 0 d`, or `[]` for a solid rule. */
function dashArray(operands: string[]): number[] {
  const open = operands.lastIndexOf('[');
  if (open < 0) return [];
  return operands
    .slice(open + 1, operands.indexOf(']', open))
    .filter(isNumberToken)
    .map(Number);
}

const dashShare = (dash: number[]): number => {
  const total = dash.reduce((sum, length) => sum + Math.max(length, 0), 0);
  if (dash.length < 2 || total <= 0) return 1;
  const on = dash.filter((_, index) => index % 2 === 0).reduce((sum, length) => sum + Math.max(length, 0), 0);
  return Math.min(on / total, 1);
};

/** Glyphs in the strings a showing operator names: two hex digits each. */
function shownGlyphCount(operands: string[], token: string, numbers: number[]): number {
  const strings = operands.filter((t) => t.startsWith('<') || t.startsWith('('));
  let glyphs = 0;
  for (const value of strings) {
    glyphs += value.startsWith('<') ? Math.floor((value.length - 2) / 2) : value.length - 2;
  }
  // `'` and `"` show the string they carry; a `TJ` array may hold only kern
  // adjustments, which is still a run of glyphs on the line.
  if (glyphs === 0 && (token === "'" || token === '"')) return numbers.length > 0 ? 1 : 0;
  return glyphs;
}

/* ------------------------------------------------------------------ *
 * Dictionary reads                                                    *
 * ------------------------------------------------------------------ */

/** One level of indirection: a `/GS1` names a state, an `/Im0` names an image. */
type Resolve = (value: unknown) => unknown;

const resolverFor = (context: PDFContext): Resolve => (value) =>
  value instanceof PDFRef ? context.lookup(value) : value;

const asDict = (value: unknown, resolve: Resolve): PDFDict | null => {
  const resolved = resolve(value);
  return resolved instanceof PDFDict ? resolved : null;
};

/** The resolver a dictionary's own context gives, so refs in that file resolve. */
const contextOf = (dict: PDFDict): Resolve => resolverFor(dict.context);

function nameOf(dict: PDFDict, key: string): string {
  const raw = dict.get(PDFName.of(key));
  if (!(raw instanceof PDFName)) return '';
  return raw
    .asString()
    .replace(/^\//, '')
    .replace(/#([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function readNumber(value: unknown): number {
  if (value instanceof PDFNumber) return value.asNumber();
  if (value instanceof PDFArray && value.size() > 0) return readNumber(value.get(0));
  return Number.NaN;
}

function numberArray(value: unknown, resolve: Resolve): number[] {
  const array = resolve(value);
  if (!(array instanceof PDFArray)) return [];
  return array
    .asArray()
    .map((entry) => readNumber(resolve(entry)))
    .filter((n) => Number.isFinite(n));
}

/**
 * One entry of a stream's `/Resources`: `/ExtGState /GS1`, `/XObject /Im0`.
 *
 * A name in a content stream means nothing on its own — it is a key in a group
 * the stream declares — and an appearance that names no resources paints with
 * the defaults, which is solid ink.
 */
function resourceEntry(resources: PDFDict | null, group: string, key: string | null): PDFDict | null {
  if (!resources || !key) return null;
  const resolve = contextOf(resources);
  const entries = asDict(resources.get(PDFName.of(group)), resolve);
  return entries ? asDict(entries.get(PDFName.of(key)), resolve) : null;
}

/** The area inside an XObject's `/BBox`; 1×1 for an image, which `cm` scales up. */
function xObjectArea(resources: PDFDict | null, key: string | null): number {
  const object = resourceEntry(resources, 'XObject', key);
  if (!object) return 0;
  const box = numberArray(object.get(PDFName.of('BBox')), contextOf(object));
  if (box.length < 4) return 0;
  return Math.abs((box[2] - box[0]) * (box[3] - box[1]));
}

/* ------------------------------------------------------------------ *
 * Small maths                                                         *
 * ------------------------------------------------------------------ */

/** Shoelace area of a closed ring: how much paper a fill covers. */
function ringArea(points: Point[]): number {
  let twice = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    twice += a.x * b.y - b.x * a.y;
  }
  return Math.abs(twice / 2);
}

function multiply(a: number[], b: number[]): number[] {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

const det = (m: number[]): number => m[0] * m[3] - m[1] * m[2];

const round4 = (value: number): number => Math.round(value * 10000) / 10000;
