/**
 * Permanent redaction (§2 of `docs/PDF-ENGINE-CONTRACT.md`).
 *
 * Painting a black box over text is *not* redaction: the glyphs stay in the
 * content stream and a viewer (or Ctrl-F) hands the secret straight back. This
 * module therefore rewrites the page's content streams with a real text-state
 * machine — `BT`/`ET`, `Tm`/`Td`/`TD`/`T*`, `Tf`, `Tz`, `TL`, `Tc`, `Tw`, `Ts`,
 * `Tj`, `TJ`, `'` and `"` — computes where every glyph actually lands in
 * default user space (font `/Widths` / CID `/W`, `/FontMatrix`, the text matrix
 * and the whole `q`/`Q`/`cm` graphics-state stack), drops the glyphs inside the
 * redaction rects, and only *then* paints the fill rect.
 *
 * Guarantees, in priority order:
 *
 * 1. **Nothing survives inside the rect.** Coverage is decided per glyph: a
 *    glyph is dropped when the centre of its measured box falls inside a rect,
 *    so a glyph sitting exactly on the edge goes and one that only pokes into
 *    the rect stays under the fill that is painted over it. Text nested in Form
 *    XObjects is rewritten as well (shared forms are copied first so other
 *    pages keep their text). A second, read-only verification pass over the
 *    rewritten page must find no covered glyph; if it does, the call throws
 *    instead of returning a document that only *looks* redacted. A "covered but
 *    still selectable" result therefore cannot come out of this API.
 * 2. **Nothing else moves.** Every deleted group of glyphs is replaced by the
 *    equivalent `TJ` displacement, so the remaining characters of the line keep
 *    their exact position and a fully redacted line still advances the text
 *    matrix for the lines after it. Because one removal makes the whole text
 *    object suspect, a `BT … ET` object that lost a glyph has *every* one of
 *    its show operators re-emitted from the measured state — but only when the
 *    font declares real widths; with estimated metrics the producer's bytes are
 *    kept, since re-writing them would move the text.
 * 3. **Images are reported, not faked.** Vector text can be deleted; pixels
 *    cannot. A rect that intersects raster content (an `Image` XObject drawn
 *    with `Do`, an inline `BI … ID … EI` image) sets `rasterised: true` so the
 *    caller can run the raster path (`core/render.ts` + `core/raster.ts`) and
 *    warn the user.
 *
 * Approximations a reviewer should know about: glyph boxes use the embedded
 * font's declared widths (a 0.5 em estimate when a code has none) and the
 * font's own ascent/descent, so coverage is only as good as those metrics; the
 * centre test above is the tie-break, and whatever pokes into the rect without
 * a covered centre is left to the fill painted over it. Text-space displacement
 * from `TJ` numbers and `Tz` follows PDF 32000-1 §9.4.3/§9.4.5, and operators
 * are handed the *last* operands they were given, the way a viewer pops them
 * off the stack (§7.5.4). Word spacing is only attributed to code 32 in simple
 * fonts (a CID font's space CID is not recoverable from `/W`, so those runs are
 * measured without `Tw`).
 *
 * Byte handling: streams are parsed into statements that remember their own
 * byte span, so untouched operators are copied verbatim (separated by a line
 * break, because a span stops at the operator token and `Tf` plus `12` would
 * otherwise fuse into the keyword `Tf12`) and only changed text-showing
 * operators are re-serialised — as a `TJ` array of per-glyph hex strings,
 * which cannot be broken by parenthesis escaping.
 */
import { decodePDFRawStream, PDFStream } from '@maxwbh/pdf-lib';
import type { PDFPageLeaf } from '@maxwbh/pdf-lib';
import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFRawStream,
  PDFRef,
} from './doc';
import type { PDFContext, PDFDocument, PDFPage, PDFObject } from './doc';
import type { QuadRect } from './annotations';

export interface RedactionRect {
  page: number;
  rect: QuadRect;
}

export interface RedactOptions {
  /** Fill colour of the burned-in rectangle, `#rrggbb`. Defaults to black. */
  fill?: string;
  /**
   * What to do where a rect covers raster content.
   * * `blackout` (default) — paint the fill rect anyway *and* report
   *   `rasterised: true`, so the page already looks redacted while the caller
   *   offers the lossless raster pass.
   * * `keep` — remove the text but leave the pixels alone for the caller's
   *   raster pass, so the region is not burned twice.
   */
  onImage?: 'blackout' | 'keep';
}

export interface RedactionResult {
  /**
   * Number of text-showing operations (`Tj`, `TJ`, `'`, `"`) that lost at least
   * one glyph, including inside rewritten Form XObjects.
   */
  removed: number;
  /** True when a rect covered raster content that pdf-lib cannot delete. */
  rasterised: boolean;
}

/* ------------------------------------------------------------------ *
 * Small numeric / geometry primitives                                 *
 * ------------------------------------------------------------------ */

/** How deep into nested Form XObjects the walker may go. */
const MAX_FORM_DEPTH = 6;
/** Fallback advance for a glyph whose font dictionary carries no width. */
const UNKNOWN_GLYPH_EM = 0.5;
/** Fallback vertical box, in em, when a font has no descriptor metrics. */
const UNKNOWN_ASCENT_EM = 0.75;
const UNKNOWN_DESCENT_EM = -0.25;

type Matrix = [number, number, number, number, number, number];
const identity = (): Matrix => [1, 0, 0, 1, 0, 0];

function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Axis-aligned box of a rectangle after a matrix (rotation included). */
function transformBox(m: Matrix, x0: number, y0: number, x1: number, y1: number): QuadRect {
  const corners = [
    applyMatrix(m, x0, y0),
    applyMatrix(m, x1, y0),
    applyMatrix(m, x1, y1),
    applyMatrix(m, x0, y1),
  ];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

function rectOf(box: QuadRect): QuadRect {
  return {
    x: Math.min(box.x, box.x + box.width),
    y: Math.min(box.y, box.y + box.height),
    width: Math.abs(box.width),
    height: Math.abs(box.height),
  };
}

function boxesIntersect(a: QuadRect, b: QuadRect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/**
 * Whether a glyph goes. The middle of its box has to be inside the rect —
 * inclusive, so a glyph sitting exactly on the edge is removed — while a glyph
 * that only pokes into the rect keeps its ink and is covered by the fill that
 * is painted over the region afterwards.
 */
function covered(box: QuadRect, rect: QuadRect): boolean {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return cx >= rect.x && cx <= rect.x + rect.width && cy >= rect.y && cy <= rect.y + rect.height;
}

const num = (v: number): string => {
  const r = Math.round(v * 10000) / 10000;
  return Object.is(r, -0) ? '0' : String(r);
};

/* ------------------------------------------------------------------ *
 * Content-stream tokenizer                                            *
 * ------------------------------------------------------------------ */

type Operand =
  | { kind: 'num'; value: number }
  | { kind: 'name'; value: string }
  | { kind: 'string'; bytes: number[] }
  | { kind: 'array'; items: Operand[] }
  | { kind: 'other' };

interface Statement {
  op: string;
  operands: Operand[];
  /** Byte span of the whole statement in its source stream. */
  start: number;
  end: number;
}

const isWhitespace = (b: number) => b === 0 || (b >= 0x09 && b <= 0x0d) || b === 0x20;
const isDelimiter = (b: number) =>
  b === 0x28 || b === 0x29 || b === 0x3c || b === 0x3e || b === 0x5b || b === 0x5d ||
  b === 0x7b || b === 0x7d || b === 0x2f || b === 0x25 || isWhitespace(b);
const isDigit = (b: number) => b >= 0x30 && b <= 0x39;

/**
 * Split a content stream into operator statements, remembering each
 * statement's byte span so untouched content can be copied verbatim.
 */
export function parseContentStatements(bytes: Uint8Array): Statement[] {
  const statements: Statement[] = [];
  const pending: Operand[] = [];
  const arrays: Operand[][] = [];
  let index = 0;
  let start = 0;

  const push = (operand: Operand) => {
    const open = arrays[arrays.length - 1];
    if (open) open.push(operand);
    else pending.push(operand);
  };

  const skipIgnorable = () => {
    for (;;) {
      while (index < bytes.length && isWhitespace(bytes[index])) index += 1;
      if (index < bytes.length && bytes[index] === 0x25) {
        while (index < bytes.length && bytes[index] !== 0x0a && bytes[index] !== 0x0d) index += 1;
        continue;
      }
      return;
    }
  };

  const readWord = (): string => {
    const from = index;
    while (index < bytes.length && !isDelimiter(bytes[index])) index += 1;
    return latin1(bytes, from, index);
  };

  const readLiteralString = (): number[] => {
    index += 1; // '('
    const out: number[] = [];
    let depth = 1;
    while (index < bytes.length) {
      const b = bytes[index];
      if (b === 0x5c) {
        index += 1;
        const esc = bytes[index];
        index += 1;
        if (esc === 0x6e) out.push(0x0a);
        else if (esc === 0x72) out.push(0x0d);
        else if (esc === 0x74) out.push(0x09);
        else if (esc === 0x62) out.push(0x08);
        else if (esc === 0x66) out.push(0x0c);
        else if (esc === 0x28 || esc === 0x29 || esc === 0x5c) out.push(esc);
        else if (esc === 0x0a) { /* line continuation */ }
        else if (esc === 0x0d) {
          if (bytes[index] === 0x0a) index += 1;
        } else if (isDigit(esc)) {
          let octal = String.fromCharCode(esc);
          while (octal.length < 3 && isDigit(bytes[index])) {
            octal += String.fromCharCode(bytes[index]);
            index += 1;
          }
          out.push(Number.parseInt(octal, 8) & 0xff);
        } else out.push(esc);
        continue;
      }
      if (b === 0x28) depth += 1;
      else if (b === 0x29) {
        depth -= 1;
        if (depth === 0) {
          index += 1;
          return out;
        }
      }
      out.push(b);
      index += 1;
    }
    return out;
  };

  while (index < bytes.length) {
    if (arrays.length === 0 && pending.length === 0) skipIgnorable();
    if (index >= bytes.length) break;
    if (arrays.length === 0 && pending.length === 0) start = index;
    const byte = bytes[index];

    if (byte === 0x5b) {
      arrays.push([]);
      index += 1;
      continue;
    }
    if (byte === 0x5d) {
      const items = arrays.pop();
      index += 1;
      if (items) push({ kind: 'array', items });
      continue;
    }
    if (byte === 0x28) {
      push({ kind: 'string', bytes: readLiteralString() });
      continue;
    }
    if (byte === 0x3c && bytes[index + 1] === 0x3c) {
      index = skipDictionary(bytes, index);
      push({ kind: 'other' });
      continue;
    }
    if (byte === 0x3c) {
      index += 1;
      const from = index;
      while (index < bytes.length && bytes[index] !== 0x3e) index += 1;
      const digits = latin1(bytes, from, index);
      index += 1; // '>'
      push({ kind: 'string', bytes: hexToBytes(digits) });
      continue;
    }
    if (byte === 0x2f) {
      index += 1;
      push({ kind: 'name', value: decodeName(readWord()) });
      continue;
    }
    if (isDigit(byte) || byte === 0x2b || byte === 0x2d || byte === 0x2e) {
      const from = index;
      if (byte === 0x2b || byte === 0x2d) index += 1;
      while (index < bytes.length && (isDigit(bytes[index]) || bytes[index] === 0x2e)) index += 1;
      const value = Number(latin1(bytes, from, index));
      push(Number.isFinite(value) ? { kind: 'num', value } : { kind: 'other' });
      continue;
    }

    const word = readWord();
    if (word.length === 0) {
      // A byte we cannot tokenise (stray brace, malformed stream): skip it so
      // the walk always makes progress.
      index += 1;
      continue;
    }
    if (word === 'true' || word === 'false' || word === 'null') {
      push({ kind: 'other' });
      continue;
    }
    if (word === 'BI') {
      index = skipInlineImage(bytes, index);
      statements.push({ op: 'BI', operands: [], start, end: index });
      pending.length = 0;
      arrays.length = 0;
      continue;
    }
    statements.push({ op: word, operands: pending.slice(), start, end: index });
    pending.length = 0;
  }
  return statements;
}

function latin1(bytes: Uint8Array, from: number, to: number): string {
  let out = '';
  for (let i = from; i < to; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}

/** Position just past a `<< … >>` dictionary, honouring nested dicts/strings. */
function skipDictionary(bytes: Uint8Array, at: number): number {
  let index = at + 2;
  let depth = 1;
  while (index < bytes.length) {
    if (bytes[index] === 0x3c && bytes[index + 1] === 0x3c) {
      depth += 1;
      index += 2;
      continue;
    }
    if (bytes[index] === 0x3e && bytes[index + 1] === 0x3e) {
      depth -= 1;
      index += 2;
      if (depth === 0) return index;
      continue;
    }
    if (bytes[index] === 0x28) {
      index += 1;
      let nested = 1;
      while (index < bytes.length && nested > 0) {
        if (bytes[index] === 0x5c) index += 1;
        else if (bytes[index] === 0x28) nested += 1;
        else if (bytes[index] === 0x29) nested -= 1;
        index += 1;
      }
      continue;
    }
    index += 1;
  }
  return bytes.length;
}

/** Position just past an inline image's `EI` keyword. */
function skipInlineImage(bytes: Uint8Array, at: number): number {
  let index = at; // just after 'BI'
  while (index < bytes.length && !(bytes[index] === 0x49 && bytes[index + 1] === 0x44)) index += 1;
  index += 2; // 'ID'
  if (isWhitespace(bytes[index])) index += 1; // a single EOL may follow ID
  for (;;) {
    const ei = indexOfEi(bytes, index);
    if (ei < 0) return bytes.length;
    return ei + 2;
  }
}

function indexOfEi(bytes: Uint8Array, from: number): number {
  for (let i = Math.max(from, 1); i + 1 < bytes.length; i += 1) {
    if (bytes[i] !== 0x45 || bytes[i + 1] !== 0x49) continue;
    if (!isWhitespace(bytes[i - 1])) continue;
    const after = bytes[i + 2];
    if (after === undefined || isWhitespace(after) || isDelimiter(after)) return i;
  }
  return -1;
}

function hexToBytes(hex: string): number[] {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const padded = clean.length % 2 === 0 ? clean : `${clean}0`;
  const out: number[] = [];
  for (let i = 0; i < padded.length; i += 2) out.push(Number.parseInt(padded.slice(i, i + 2), 16));
  return out;
}

function bytesToHex(bytes: Iterable<number>): string {
  let out = '';
  for (const b of bytes) out += (b & 0xff).toString(16).padStart(2, '0');
  return out;
}

function decodeName(raw: string): string {
  return raw.replace(/#([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/* ------------------------------------------------------------------ *
 * Font metrics, read from the dictionaries the file already has       *
 * ------------------------------------------------------------------ */

interface GlyphMetrics {
  /** Bytes per character code: 2 for Identity-based Type0, 1 for simple fonts. */
  codeBytes: 1 | 2;
  /** Glyph advance in 1/1000 em. */
  widthOf(code: number): number;
  /** Vertical glyph box in 1/1000 em. */
  ascent: number;
  descent: number;
  /** `/FontMatrix` x-scale relative to the 1000-unit em; 1 for ordinary fonts. */
  glyphSpace: number;
  /** False when the advance is a guess, in which case re-written text would move. */
  measured: boolean;
}

const FALLBACK_METRICS: GlyphMetrics = {
  codeBytes: 1,
  widthOf: () => UNKNOWN_GLYPH_EM * 1000,
  ascent: UNKNOWN_ASCENT_EM * 1000,
  descent: UNKNOWN_DESCENT_EM * 1000,
  glyphSpace: 1,
  measured: false,
};

/**
 * Resolve one level of indirection without throwing. `lookupMaybe` in
 * `@maxwbh/pdf-lib` raises `UnexpectedObjectTypeError` when the target exists
 * but has another type, and a foreign document can hide any type behind any
 * key — a redaction pass must degrade, not abort.
 */
function deref(context: PDFContext, value: unknown): PDFObject | undefined {
  if (value === undefined || value === null || value === PDFNull) return undefined;
  return value instanceof PDFRef ? context.lookup(value) : (value as PDFObject);
}

function readFontMetrics(
  context: PDFContext,
  resources: PDFDict | undefined,
  fontName: string,
): GlyphMetrics {
  const fontDictRaw = resources ? deref(context, resources.get(PDFName.of('Font'))) : undefined;
  const fontDict = fontDictRaw instanceof PDFDict ? fontDictRaw : undefined;
  const dict = fontDict ? deref(context, fontDict.get(PDFName.of(fontName))) : undefined;
  if (!(dict instanceof PDFDict)) return FALLBACK_METRICS;
  const subtype = subtypeName(context, dict);
  if (subtype === 'Type0') return compositeMetrics(context, dict);
  return simpleMetrics(context, dict);
}

/** `PDFName.asString()` keeps the leading slash, and a name written by
 * `PDFName.of('/Image')` escapes it as `#2F`; both spellings mean the
 * `/Image` / `/Form` subtype this module branches on. */
function subtypeName(context: PDFContext, dict: PDFDict): string {
  const name = deref(context, dict.get(PDFName.of('Subtype')));
  return name instanceof PDFName ? decodeName(name.asString()).replace(/^\/+/, '') : '';
}

function numbersIn(value: unknown, context: PDFContext): number[] {
  const array = deref(context, value);
  if (!(array instanceof PDFArray)) return [];
  const out: number[] = [];
  for (let i = 0; i < array.size(); i += 1) {
    const number = deref(context, array.get(i));
    out.push(number instanceof PDFNumber ? number.asNumber() : NaN);
  }
  return out;
}

function numberAt(context: PDFContext, dict: PDFDict, key: PDFName): number {
  const number = deref(context, dict.get(key));
  return number instanceof PDFNumber ? number.asNumber() : NaN;
}

function dictAt(context: PDFContext, dict: PDFDict, key: PDFName): PDFDict | undefined {
  const value = deref(context, dict.get(key));
  return value instanceof PDFDict ? value : undefined;
}

function arrayAt(context: PDFContext, dict: PDFDict, key: PDFName): PDFArray | undefined {
  const value = deref(context, dict.get(key));
  return value instanceof PDFArray ? value : undefined;
}

function descriptorOf(context: PDFContext, dict: PDFDict): PDFDict | undefined {
  const direct = dictAt(context, dict, PDFName.of('FontDescriptor'));
  if (direct) return direct;
  const array = arrayAt(context, dict, PDFName.of('FontDescriptor'));
  if (!array || array.size() === 0) return undefined;
  const first = deref(context, array.get(0));
  return first instanceof PDFDict ? first : undefined;
}

function glyphSpaceOf(context: PDFContext, dict: PDFDict): number {
  const matrix = numbersIn(dict.get(PDFName.of('FontMatrix')), context);
  const raw = matrix.length === 6 ? Math.abs(matrix[0]) || Math.abs(matrix[3]) : 0;
  return Number.isFinite(raw) && raw > 0 ? raw / 0.001 : 1;
}

function verticalExtents(context: PDFContext, dict: PDFDict): { ascent: number; descent: number } {
  const descriptor = descriptorOf(context, dict);
  if (descriptor) {
    const ascent = numberAt(context, descriptor, PDFName.of('Ascent'));
    const descent = numberAt(context, descriptor, PDFName.of('Descent'));
    if (Number.isFinite(ascent) || Number.isFinite(descent)) {
      return {
        ascent: Number.isFinite(ascent) ? ascent : UNKNOWN_ASCENT_EM * 1000,
        descent: Number.isFinite(descent) ? descent : UNKNOWN_DESCENT_EM * 1000,
      };
    }
    const bbox = numbersIn(descriptor.get(PDFName.of('FontBBox')), context);
    if (bbox.length === 4 && Number.isFinite(bbox[1]) && Number.isFinite(bbox[3]) && bbox[3] > bbox[1]) {
      return { ascent: bbox[3], descent: bbox[1] };
    }
  }
  return { ascent: UNKNOWN_ASCENT_EM * 1000, descent: UNKNOWN_DESCENT_EM * 1000 };
}

function simpleMetrics(context: PDFContext, dict: PDFDict): GlyphMetrics {
  const widths = numbersIn(dict.get(PDFName.of('Widths')), context);
  const firstChar = numberAt(context, dict, PDFName.of('FirstChar'));
  const base = Number.isFinite(firstChar) ? firstChar : 0;
  const descriptor = descriptorOf(context, dict);
  const missing = descriptor ? numberAt(context, descriptor, PDFName.of('MissingWidth')) : NaN;
  const fallback = Number.isFinite(missing) && missing > 0 ? missing : UNKNOWN_GLYPH_EM * 1000;
  const { ascent, descent } = verticalExtents(context, dict);
  const hasWidths = widths.some((w) => Number.isFinite(w));
  return {
    codeBytes: 1,
    widthOf: (code) => {
      const width = hasWidths ? widths[code - base] : NaN;
      return Number.isFinite(width) ? width : fallback;
    },
    ascent,
    descent,
    glyphSpace: glyphSpaceOf(context, dict),
    measured: hasWidths,
  };
}

function compositeMetrics(context: PDFContext, type0: PDFDict): GlyphMetrics {
  const encodingName = deref(context, type0.get(PDFName.of('Encoding')));
  const codeBytes: 1 | 2 =
    encodingName instanceof PDFName && /OneByte/i.test(encodingName.asString()) ? 1 : 2;
  const descendants = arrayAt(context, type0, PDFName.of('DescendantFonts'));
  const first = descendants && descendants.size() > 0 ? deref(context, descendants.get(0)) : undefined;
  const cid =
    (first instanceof PDFDict ? first : undefined) ?? dictAt(context, type0, PDFName.of('DescendantFonts'));
  const widths = new Map<number, number>();
  let defaultWidth = 1000;
  if (cid) {
    const dw = numberAt(context, cid, PDFName.of('DW'));
    if (Number.isFinite(dw)) defaultWidth = dw;
    const wArray = arrayAt(context, cid, PDFName.of('W'));
    if (wArray) readCidWidths(context, wArray, widths);
  }
  const { ascent, descent } = verticalExtents(context, cid ?? type0);
  const space = cid ? glyphSpaceOf(context, cid) : 1;
  return {
    codeBytes,
    widthOf: (code) => widths.get(code) ?? defaultWidth,
    ascent,
    descent,
    glyphSpace: space,
    measured: widths.size > 0,
  };
}

/** `/W [ c [w…] cFirst cLast w … ]` (PDF 32000-1 Table 169). */
function readCidWidths(context: PDFContext, array: PDFArray, into: Map<number, number>): void {
  const item = (i: number): PDFNumber | PDFArray | undefined => {
    if (i >= array.size()) return undefined;
    const entry = deref(context, array.get(i));
    return entry instanceof PDFNumber || entry instanceof PDFArray ? entry : undefined;
  };
  let i = 0;
  while (i < array.size()) {
    const first = item(i);
    if (!(first instanceof PDFNumber)) {
      i += 1;
      continue;
    }
    const start = first.asNumber();
    const second = item(i + 1);
    if (second instanceof PDFArray) {
      const widths = numbersIn(second, context);
      widths.forEach((w, offset) => {
        if (Number.isFinite(w)) into.set(start + offset, w);
      });
      i += 2;
      continue;
    }
    const last = item(i + 2);
    if (second instanceof PDFNumber && last instanceof PDFNumber) {
      for (let c = start; c <= last.asNumber(); c += 1) into.set(c, second.asNumber());
      i += 4;
      continue;
    }
    i += 2;
  }
}

/* ------------------------------------------------------------------ *
 * Text state                                                          *
 * ------------------------------------------------------------------ */

interface TextState {
  tm: Matrix;
  tlm: Matrix;
  leading: number;
  fontSize: number;
  horizontalScale: number;
  charSpacing: number;
  wordSpacing: number;
  rise: number;
}

const newTextState = (): TextState => ({
  tm: identity(),
  tlm: identity(),
  leading: 0,
  fontSize: 0,
  horizontalScale: 100,
  charSpacing: 0,
  wordSpacing: 0,
  rise: 0,
});

/**
 * A piece of a re-emitted show operator: glyph codes to draw, or a pen
 * displacement in text-space units (positive = to the right).
 */
type ShowItem = { bytes: number[] } | { displacement: number };

/**
 * A show operator inside a `BT … ET` object whose other operators may still
 * turn out to be redacted: either the producer's bytes or the re-measured
 * `TJ` array is kept, and the choice is made when the text object closes.
 */
interface PendingShow {
  bytes: Uint8Array;
  canonical: string;
}

/** One chunk of the rewritten stream. */
type StreamPart = { bytes: Uint8Array } | { text: string } | { pending: PendingShow };

/** The `BT … ET` object being collected, if the walker is inside one. */
interface TextObject {
  /** Index into the parts array of every show operator in the object. */
  shows: number[];
  /** True once any of them lost a glyph, which re-emits all of them. */
  lost: boolean;
}

type WalkMode = 'apply' | 'verify';

interface StreamInput {
  /** Decoded bytes of the stream being walked. */
  bytes: Uint8Array;
  /**
   * The stream's own dictionary; its keys (`/BBox`, `/Matrix`, `/Resources`, …)
   * have to survive the rewrite, which replaces the encoded payload.
   */
  sourceDict: PDFDict;
  /** Dictionary `/Font` and `/XObject` are looked up in. */
  resources: PDFDict | undefined;
  /** Object the stream lives in: the page node, or the parent form's dict. */
  container: PDFDict;
  /** Indirect reference of the stream itself, when it has one. */
  ref: PDFRef | null;
  /** `/Contents` array and slot, for page streams stored as direct objects. */
  contents: PDFArray | null;
  slot: number;
  /** Graphics state in effect at the stream's first operator. */
  ctm: Matrix;
  depth?: number;
}

/* ------------------------------------------------------------------ *
 * The walk                                                            *
 * ------------------------------------------------------------------ */

class RedactionWalk {
  private removedRuns = 0;
  private leftoverRuns = 0;
  private readonly hitImages = new Set<number>();
  /** Forms currently being walked, so a self-referencing XObject cannot loop. */
  private readonly visiting = new Set<string>();

  constructor(
    private readonly doc: PDFDocument,
    private readonly page: PDFPage,
    private readonly rects: QuadRect[],
    private readonly mode: WalkMode,
  ) {}

  get outcome(): { removedRuns: number; leftoverRuns: number; hitImages: Set<number> } {
    return { removedRuns: this.removedRuns, leftoverRuns: this.leftoverRuns, hitImages: this.hitImages };
  }

  /** Walk every content stream of the page, rewriting it in apply mode. */
  run(): void {
    const context = this.doc.context;
    // Normalise first: the page then owns a `/Resources` dictionary instead of
    // an inherited one, so rewriting resource entries cannot leak sideways.
    this.page.node.normalizedEntries();
    const contents = ensureContentsArray(this.doc.context, this.page.node);
    if (!contents) return;

    let ctm = identity();
    for (let i = 0; i < contents.size(); i += 1) {
      const entry = contents.get(i);
      const stream = deref(context, entry);
      if (!(stream instanceof PDFStream)) continue;
      ctm = this.walk({
        bytes: streamBytes(stream),
        sourceDict: stream.dict,
        resources: this.page.node.Resources(),
        container: this.page.node,
        ref: entry instanceof PDFRef ? entry : context.getObjectRef(stream) ?? null,
        contents,
        slot: i,
        ctm,
      });
    }
  }

  /**
   * Walk one content stream. Returns the CTM left at its end so the next stream
   * of the same page/form is interpreted against the same graphics state.
   */
  private walk(input: StreamInput): Matrix {
    const { bytes, sourceDict, resources, container, ref, contents, slot, depth = 0 } = input;
    const context = this.doc.context;
    const statements = parseContentStatements(bytes);
    const parts: StreamPart[] = [];
    let changed = false;
    let ctm = input.ctm;
    const stack: Matrix[] = [];
    let text = newTextState();
    let metrics = FALLBACK_METRICS;
    let object: TextObject | null = null;

    /**
     * Close the text object: once it lost a glyph every show operator it holds
     * is re-emitted from the measured state, so no text can hide in the bytes
     * next to the cut; otherwise the producer's bytes are kept untouched.
     */
    const closeObject = () => {
      const open = object;
      if (!open) return;
      for (const index of open.shows) {
        const part = parts[index];
        if ('pending' in part) {
          parts[index] = open.lost ? { text: part.pending.canonical } : { bytes: part.pending.bytes };
        }
      }
      object = null;
    };

    for (const statement of statements) {
      const original = () => parts.push({ bytes: bytes.subarray(statement.start, statement.end) });
      const numbers = () => numberOperands(statement);
      const nameOperand = () =>
        statement.operands.find((o): o is { kind: 'name'; value: string } => o.kind === 'name')?.value;

      switch (statement.op) {
        case 'q':
          stack.push([...ctm] as Matrix);
          original();
          break;
        case 'Q':
          ctm = stack.pop() ?? identity();
          original();
          break;
        case 'cm': {
          const values = takeLast(numbers(), 6);
          if (values) ctm = multiply(ctm, values as Matrix);
          original();
          break;
        }
        case 'BI':
          // Pixels cannot be cut: report the box so the caller can run the
          // raster path over anything drawn here.
          this.markRaster(imageBox(ctm));
          original();
          break;
        case 'BT':
          closeObject();
          text = newTextState();
          metrics = FALLBACK_METRICS;
          object = { shows: [], lost: false };
          original();
          break;
        case 'ET':
          closeObject();
          original();
          break;
        case 'Tf': {
          const font = nameOperand();
          text.fontSize = takeLast(numbers(), 1)?.[0] ?? 0;
          metrics = font ? readFontMetrics(context, resources, font) : FALLBACK_METRICS;
          original();
          break;
        }
        case 'Td': {
          const [tx = 0, ty = 0] = takeLast(numbers(), 2) ?? [];
          text.tlm = multiply(text.tlm, [1, 0, 0, 1, tx, ty] as Matrix);
          text.tm = [...text.tlm] as Matrix;
          original();
          break;
        }
        case 'TD': {
          const [tx = 0, ty = 0] = takeLast(numbers(), 2) ?? [];
          text.leading = -ty;
          text.tlm = multiply(text.tlm, [1, 0, 0, 1, tx, ty] as Matrix);
          text.tm = [...text.tlm] as Matrix;
          original();
          break;
        }
        case 'Tm': {
          const values = takeLast(numbers(), 6);
          if (values) {
            text.tlm = [...values] as Matrix;
            text.tm = [...values] as Matrix;
          }
          original();
          break;
        }
        case 'TL':
          text.leading = takeLast(numbers(), 1)?.[0] ?? 0;
          original();
          break;
        case 'Tc':
          text.charSpacing = takeLast(numbers(), 1)?.[0] ?? 0;
          original();
          break;
        case 'Tw':
          text.wordSpacing = takeLast(numbers(), 1)?.[0] ?? 0;
          original();
          break;
        case 'Tz':
          text.horizontalScale = takeLast(numbers(), 1)?.[0] ?? 100;
          original();
          break;
        case 'Ts':
          text.rise = takeLast(numbers(), 1)?.[0] ?? 0;
          original();
          break;
        case 'T*':
          this.nextLine(text);
          original();
          break;
        case 'Tj':
        case 'TJ':
        case "'":
        case '"': {
          const run = this.measureShow(statement, text, metrics, ctm);
          const source = bytes.subarray(statement.start, statement.end);
          if (this.mode === 'verify') {
            if (run.lost > 0) this.leftoverRuns += 1;
            parts.push({ bytes: source });
            break;
          }
          if (!run.canonical) {
            parts.push({ bytes: source });
            break;
          }
          if (run.lost > 0) {
            this.removedRuns += 1;
            changed = true;
          }
          if (object) {
            object.shows.push(parts.length);
            if (run.lost > 0) object.lost = true;
            parts.push({ pending: { bytes: source, canonical: run.canonical } });
          } else {
            // A show operator outside any text object (a broken producer, or a
            // `Do` in text space): only its own cut is rewritten.
            parts.push(run.lost > 0 ? { text: run.canonical } : { bytes: source });
          }
          break;
        }
        case 'Do': {
          const name = nameOperand();
          // Redacting inside a form changes the form's own bytes, never this
          // stream, so the `Do` is always copied.
          if (name) this.xObject(name, resources, container, ctm, depth);
          original();
          break;
        }
        default:
          original();
      }
    }
    // An unclosed `BT` still gets its cut: the operators are there either way.
    closeObject();

    if (changed && this.mode === 'apply') {
      this.store({ container, ref, contents, slot }, sourceDict, concatParts(parts));
    }
    return ctm;
  }

  private nextLine(text: TextState): void {
    text.tlm = multiply(text.tlm, [1, 0, 0, 1, 0, -text.leading] as Matrix);
    text.tm = [...text.tlm] as Matrix;
  }

  /**
   * Measure one `Tj` / `TJ` / `'` / `"` operator: how many glyphs a rect
   * removes, the `TJ` array that draws everything which survives, and the pen
   * displacement the operator applies to the text matrix.
   *
   * `canonical` is null when the operator shows nothing measurable, or when it
   * loses nothing and the font's advances are only a guess — re-writing a run
   * against estimated metrics would move text that the redaction does not
   * touch, which is worse than leaving the producer's bytes alone.
   */
  private measureShow(
    statement: Statement,
    text: TextState,
    metrics: GlyphMetrics,
    ctm: Matrix,
  ): { lost: number; canonical: string | null } {
    if (statement.op === '"') {
      const [aw, ac] = takeLast(numberOperands(statement), 2) ?? [];
      // `aw ac string "` leaves both values in force for the rest of the block.
      text.wordSpacing = aw ?? text.wordSpacing;
      text.charSpacing = ac ?? text.charSpacing;
    }
    if (statement.op === "'" || statement.op === '"') this.nextLine(text);

    // §9.4.3: a `TJ` number displaces by -(n/1000) of the current text-space em.
    const unit = text.fontSize * metrics.glyphSpace * (text.horizontalScale / 100);
    const items: ShowItem[] = [];
    let lost = 0;
    // How far the pen has travelled inside this operator; every string operand
    // starts where the previous one stopped (PDF 32000-1 §9.4.1 and §9.4.3: a
    // text-showing operator modifies Tm, but never Tlm).
    let pen = 0;

    const addString = (codes: number[]) => {
      const run = this.measureRun(codes, text, metrics, ctm, pen);
      lost += run.lost;
      items.push(...run.items);
      pen += run.advance;
    };
    for (const operand of statement.operands) {
      if (operand.kind === 'string') addString(operand.bytes);
      else if (operand.kind === 'array') {
        for (const element of operand.items) {
          if (element.kind === 'string') addString(element.bytes);
          else if (element.kind === 'num') {
            const displacement = -(element.value / 1000) * unit;
            items.push({ displacement });
            pen += displacement;
          }
        }
      }
    }
    text.tm = multiply(text.tm, [1, 0, 0, 1, pen, 0] as Matrix);
    if (items.length === 0) {
      return { lost, canonical: lost > 0 ? '[ ] TJ' : null };
    }
    if (lost === 0 && !metrics.measured) return { lost, canonical: null };

    const body = `[ ${mergeItems(items)
      .map((item) =>
        'bytes' in item
          ? `<${bytesToHex(item.bytes)}>`
          : num(unit > 0 ? (-1000 * item.displacement) / unit : 0),
      )
      .join(' ')} ] TJ`;
    const canonical =
      statement.op === '"'
        ? `${num(text.wordSpacing)} Tw ${num(text.charSpacing)} Tc T* ${body}`
        : statement.op === "'"
          ? `T* ${body}`
          : body;
    return { lost, canonical };
  }

  /**
   * Split one string operand into the glyphs a rect removes and the ones that
   * survive, in reading order. Every surviving glyph becomes its own operand,
   * so the displacement in front of it carries exactly the advances that were
   * cut out of the run.
   */
  private measureRun(
    codes: number[],
    text: TextState,
    metrics: GlyphMetrics,
    ctm: Matrix,
    start: number,
  ): { items: ShowItem[]; lost: number; advance: number } {
    const size = metrics.codeBytes;
    const count = Math.floor(codes.length / size);
    if (count === 0) {
      return codes.length > 0
        ? { items: [{ bytes: codes.slice() }], lost: 0, advance: 0 }
        : { items: [], lost: 0, advance: 0 };
    }
    const em = text.fontSize * metrics.glyphSpace;
    const horizontal = text.horizontalScale / 100;
    // Text space -> default user space: Trm = Tfs × Tms × CTM (§9.4.4).
    const trm = multiply(ctm, text.tm);
    const top = text.rise + em * (metrics.ascent / 1000);
    const bottom = text.rise + em * (metrics.descent / 1000);
    const items: ShowItem[] = [];
    let pen = start;
    let skipped = 0;
    let lost = 0;

    for (let i = 0; i < count; i += 1) {
      const chunk = codes.slice(i * size, i * size + size);
      const code = readCode(chunk, size);
      // §9.4.5: t_x = [(w/1000)·T_fs + T_c + T_w·(T_z/100)]·(T_z/100)
      const spacing = text.charSpacing + (size === 1 && chunk[0] === 0x20 ? text.wordSpacing * horizontal : 0);
      const advance = ((metrics.widthOf(code) / 1000) * em + spacing) * horizontal;
      const box = rectOf(transformBox(trm, pen, bottom, pen + Math.max(advance, em * 0.01), top));
      if (this.rects.some((rect) => covered(box, rect))) {
        skipped += advance;
        lost += 1;
      } else {
        if (skipped > 0) {
          items.push({ displacement: skipped });
          skipped = 0;
        }
        items.push({ bytes: chunk });
      }
      pen += advance;
    }
    if (skipped > 0) items.push({ displacement: skipped });
    // A trailing half-code cannot be measured; keep it rather than lose it.
    if (codes.length > count * size) items.push({ bytes: codes.slice(count * size) });
    return { items, lost, advance: pen - start };
  }

  /** Records every rect that covers `box`, so the caller can run the raster path. */
  private markRaster(box: QuadRect): void {
    this.rects.forEach((rect, index) => {
      if (boxesIntersect(box, rect)) this.hitImages.add(index);
    });
  }

  /**
   * Resolve a `Do` name: an image is measured against the rects, a form is
   * walked (and rewritten) recursively. The `Do` operator itself always stays
   * in the caller's content.
   */
  private xObject(
    name: string,
    resources: PDFDict | undefined,
    container: PDFDict,
    ctm: Matrix,
    depth: number,
  ): void {
    const context = this.doc.context;
    const xobjectsRaw = resources ? deref(context, resources.get(PDFName.of('XObject'))) : undefined;
    const xobjects = xobjectsRaw instanceof PDFDict ? xobjectsRaw : undefined;
    if (!xobjects) return;
    const entry = xobjects.get(PDFName.of(name));
    if (!entry) return;
    const stream = deref(context, entry);
    if (!(stream instanceof PDFStream)) return;

    const dict = stream.dict;
    const subtype = subtypeName(context, dict);
    if (subtype === 'Image') {
      this.markRaster(imageBox(ctm));
      return;
    }
    if (subtype !== 'Form' || depth >= MAX_FORM_DEPTH) return;

    const bbox = numbersIn(dict.get(PDFName.of('BBox')), context);
    if (bbox.length !== 4) return;
    const matrixValues = numbersIn(dict.get(PDFName.of('Matrix')), context);
    const matrix: Matrix = matrixValues.length === 6 ? (matrixValues as Matrix) : identity();
    const placed = rectOf(transformBox(multiply(ctm, matrix), bbox[0], bbox[1], bbox[2], bbox[3]));
    if (!this.rects.some((rect) => boxesIntersect(placed, rect))) return;

    let ref = entry instanceof PDFRef ? entry : context.getObjectRef(stream);
    if (!ref) return;
    const key = ref.toString();
    if (this.visiting.has(key)) return;
    this.visiting.add(key);

    // A form another page reaches as well is copied up-front, so the rewrite
    // only ever touches this page's instance (including its nested clones).
    let target = stream;
    if (this.sharedWithOtherPages(ref)) {
      const clone = this.newStream(dict, streamBytes(stream));
      ref = context.register(clone);
      target = clone;
      this.replaceResourceEntry(container, name, ref);
    }

    const formResources = dictAt(context, target.dict, PDFName.of('Resources')) ?? target.dict;
    this.walk({
      bytes: streamBytes(target),
      sourceDict: target.dict,
      resources: formResources,
      container: target.dict,
      ref,
      contents: null,
      slot: 0,
      ctm: multiply(ctm, matrix),
      depth: depth + 1,
    });
    this.visiting.delete(key);
  }

  /** Persist rewritten bytes for a page stream or a form XObject. */
  private store(
    target: { container: PDFDict; ref: PDFRef | null; contents: PDFArray | null; slot: number },
    sourceDict: PDFDict,
    bytes: Uint8Array,
  ): void {
    const context = this.doc.context;
    const stream = this.newStream(sourceDict, bytes);
    if (target.ref) {
      context.assign(target.ref, stream);
      return;
    }
    const registered = context.register(stream);
    if (target.contents) target.contents.set(target.slot, registered);
    else target.container.set(PDFName.of('Contents'), context.obj([registered]));
  }

  /** A flate copy of `dict` + `bytes`, without the old stream mechanics. */
  private newStream(dict: PDFDict, bytes: Uint8Array): PDFRawStream {
    const context = this.doc.context;
    const stream = context.flateStream(bytes, {});
    for (const [key, value] of dict.entries()) {
      if (MECHANICAL_STREAM_KEYS.has(key.asString())) continue;
      stream.dict.set(key, value);
    }
    stream.dict.set(PDFName.of('Length'), PDFNumber.of(stream.contents.length));
    return stream;
  }

  /**
   * Point one `/XObject` entry at `ref`, copying `/Resources` and its
   * `/XObject` sub-dictionary first so a shared dictionary is not disturbed.
   */
  private replaceResourceEntry(container: PDFDict, name: string, ref: PDFRef): void {
    const context = this.doc.context;
    const resources = dictAt(context, container, PDFName.of('Resources'));
    const xobjects = resources ? dictAt(context, resources, PDFName.of('XObject')) : undefined;
    if (!resources || !xobjects) return;
    const newResources = context.obj({});
    for (const [key, value] of resources.entries()) newResources.set(key, value);
    const newXobjects = context.obj({});
    for (const [key, value] of xobjects.entries()) newXobjects.set(key, value);
    newXobjects.set(PDFName.of(name), ref);
    newResources.set(PDFName.of('XObject'), newXobjects);
    container.set(PDFName.of('Resources'), newResources);
  }

  /**
   * True when another page also reaches this object through its resources: it
   * has to be copied before redaction. The scan covers a page's own
   * `/Resources/XObject` entries, which is how producers share forms.
   */
  private sharedWithOtherPages(ref: PDFRef): boolean {
    const context = this.doc.context;
    const target = ref.toString();
    for (const page of this.doc.getPages()) {
      if (page === this.page) continue;
      const resources = page.node.Resources();
      const xobjectsRaw = resources ? context.lookup(resources.get(PDFName.of('XObject'))) : undefined;
      if (!(xobjectsRaw instanceof PDFDict)) continue;
      for (const [, value] of xobjectsRaw.entries()) {
        const entry = value instanceof PDFRef ? value.toString() : context.getObjectRef(value)?.toString();
        if (entry === target) return true;
      }
    }
    return false;
  }
}

const MECHANICAL_STREAM_KEYS = new Set(['/Length', '/Filter', '/DecodeParms', '/F', '/FFilter', '/FStream']);

function readCode(chunk: number[], size: number): number {
  if (size === 2) return ((chunk[0] ?? 0) << 8) | (chunk[1] ?? 0);
  return chunk[0] ?? 0;
}

/** The numeric operands of a statement, in source order. */
function numberOperands(statement: Statement): number[] {
  return statement.operands
    .filter((o): o is { kind: 'num'; value: number } => o.kind === 'num')
    .map((o) => o.value);
}

/**
 * The operands an operator actually consumes: the **last** `count` values it was
 * given. A producer that writes `1 0 0 1 0 150 Td` (a `Tm` line with the wrong
 * mnemonic) has to be read the way a viewer reads it: operators take the
 * operands most recently pushed onto the stack, so a surplus is left over rather
 * than shifted (PDF 32000-1 §7.5.4).
 */
function takeLast(values: number[], count: number): number[] | null {
  return values.length >= count ? values.slice(values.length - count) : null;
}

/**
 * The box an image occupies. Both an `Image` XObject and an inline image fill
 * the *unit square* of the current transformation: the `/W`×`/H` sample array
 * is mapped onto that square before the CTM is applied (PDF 32000-1 §8.9.5.1),
 * which is why producers write `q W 0 0 H x y cm` around a `BI … ID … EI`.
 */
function imageBox(ctm: Matrix): QuadRect {
  return rectOf(transformBox(ctm, 0, 0, 1, 1));
}

function mergeItems(items: ShowItem[]): ShowItem[] {
  const out: ShowItem[] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    if ('displacement' in item && last && 'displacement' in last) {
      out[out.length - 1] = { displacement: last.displacement + item.displacement };
      continue;
    }
    if ('bytes' in item && item.bytes.length === 0) continue;
    out.push(item);
  }
  return out;
}

function streamBytes(stream: PDFStream): Uint8Array {
  if (stream instanceof PDFRawStream) {
    try {
      return decodePDFRawStream(stream).decode();
    } catch {
      return stream.contents;
    }
  }
  try {
    return stream.getContents();
  } catch {
    return new Uint8Array(0);
  }
}

function concatParts(parts: StreamPart[]): Uint8Array {
  const encoder = new TextEncoder();
  // `pending` is resolved when its text object closes; the fallback keeps this
  // total without ever rewriting a run that was never measured.
  const chunkOf = (part: StreamPart): Uint8Array =>
    'bytes' in part ? part.bytes : encoder.encode('text' in part ? part.text : part.pending.canonical);
  // A statement's byte span stops at the operator token, so the whitespace that
  // separated two statements belongs to neither span: re-join the parts with a
  // line break or `Tf` and the next `12` fuse into the keyword `Tf12`.
  const chunks = parts.map(chunkOf);
  const total = chunks.reduce((sum, chunk) => sum + chunk.length + 1, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
    out[offset] = 0x0a;
    offset += 1;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Entry point                                                         *
 * ------------------------------------------------------------------ */

/**
 * Permanently remove everything inside `rects` (0-based page plus a rect in PDF
 * default user space) and burn the fill colour on top.
 *
 * `removed` counts the text-showing operations that lost at least one glyph,
 * including inside rewritten Form XObjects. The module header explains what
 * `rasterised` asks the caller to do, and why a leftover glyph throws rather
 * than returning a page whose text is merely covered.
 */
export function applyRedactions(
  doc: PDFDocument,
  rects: RedactionRect[],
  opts: RedactOptions = {},
): RedactionResult {
  const fill = opts.fill ? parseFill(opts.fill) : ([0, 0, 0] as [number, number, number]);
  const onImage = opts.onImage ?? 'blackout';

  const byPage = new Map<number, QuadRect[]>();
  for (const entry of rects ?? []) {
    if (!entry?.rect) continue;
    const total = doc.getPageCount();
    if (!Number.isInteger(entry.page) || entry.page < 0 || entry.page >= total) {
      throw new Error(
        `A redaction targets page ${(Number.isInteger(entry.page) ? entry.page : 0) + 1}, but this document has ${total} page${total === 1 ? '' : 's'}. Choose pages inside the document.`,
      );
    }
    const box = rectOf(entry.rect);
    if (!(box.width > 0) || !(box.height > 0)) continue;
    const list = byPage.get(entry.page) ?? [];
    list.push(box);
    byPage.set(entry.page, list);
  }
  if (byPage.size === 0) return { removed: 0, rasterised: false };

  let removed = 0;
  let rasterised = false;

  for (const [index, pageRects] of byPage) {
    const page = doc.getPage(index);
    const outcome = walkPage(doc, page, pageRects, 'apply');
    removed += outcome.removedRuns;
    if (outcome.hitImages.size > 0) rasterised = true;

    const painted = pageRects.filter((_, i) => !(onImage === 'keep' && outcome.hitImages.has(i)));
    if (painted.length > 0) paintRects(doc, page, painted, fill);

    const verify = walkPage(doc, page, pageRects, 'verify');
    if (verify.leftoverRuns > 0) {
      throw new Error(
        `Redaction could not remove all the text in the selected area on page ${index + 1} (${verify.leftoverRuns} runs remain). Convert that page to an image and redact the image instead.`,
      );
    }
  }

  return { removed, rasterised };
}

function walkPage(
  doc: PDFDocument,
  page: PDFPage,
  rects: QuadRect[],
  mode: WalkMode,
): { removedRuns: number; leftoverRuns: number; hitImages: Set<number> } {
  const walk = new RedactionWalk(doc, page, rects, mode);
  walk.run();
  return walk.outcome;
}

function paintRects(
  doc: PDFDocument,
  page: PDFPage,
  rects: QuadRect[],
  fill: [number, number, number],
): void {
  const context = doc.context;
  const ops = [
    'q',
    `${fill.map((v) => num(v)).join(' ')} rg`,
    ...rects.flatMap((rect) => [`${num(rect.x)} ${num(rect.y)} ${num(rect.width)} ${num(rect.height)} re`, 'f']),
    'Q',
  ].join('\n');
  const stream = context.flateStream(`${ops}\n`, {});
  stream.dict.set(PDFName.of('Length'), PDFNumber.of(stream.contents.length));

  // Bracket the page's own content with q/Q when the producer left the CTM
  // dangling, so the fill always lands in default user space, then append the
  // paint stream after everything else.
  const contents = ensureContentsArray(context, page.node);
  const push = context.getPushGraphicsStateContentStream();
  const pop = context.getPopGraphicsStateContentStream();
  if (!contents) {
    page.node.set(PDFName.of('Contents'), context.obj([push, pop, context.register(stream)]));
    return;
  }
  const wrapped = contents.size() > 0 && contents.get(contents.size() - 1).toString() === pop.toString();
  if (!wrapped) {
    contents.insert(0, push);
    contents.push(pop);
  }
  contents.push(context.register(stream));
}

/**
 * The page's `/Contents` as a mutable array.
 *
 * `PDFPageLeaf.Contents()` resolves the entry, so a page whose `/Contents` is
 * one reference reports a stream, and `addContentStream` then fails on a page
 * that was already normalised while it had no content. Reading the raw entry
 * and wrapping it in an array here is what makes redaction work on every page,
 * however the producer stored it (`/Contents 5 0 R`, `[5 0 R 6 0 R]`, or a
 * direct stream).
 */
function ensureContentsArray(context: PDFContext, node: PDFPageLeaf): PDFArray | null {
  const raw = node.get(PDFName.of('Contents'));
  if (!raw) return null;
  if (raw instanceof PDFArray) return raw;
  const resolved = deref(context, raw);
  if (resolved instanceof PDFArray) return resolved;
  const array = context.obj([raw]);
  node.set(PDFName.of('Contents'), array);
  return array;
}

function parseFill(hex: string): [number, number, number] {
  const value = String(hex ?? '').trim().replace(/^#/, '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`"${hex}" is not a redaction colour. Pass a hex value such as #000000.`);
  }
  const int = Number.parseInt(full, 16);
  return [((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255];
}
