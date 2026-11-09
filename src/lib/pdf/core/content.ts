/**
 * PDF content-stream surgery.
 *
 * Everything in this module works on **real operators**, not screenshots:
 * `parseContentStream` is a hand-written tokenizer over the bytes of a page
 * content stream (numbers, names, literal/hex strings, arrays, dictionaries,
 * indirect references, keywords, operators, comments and inline images), and
 * every helper here re-emits those operators so the output stays vector,
 * selectable and searchable.
 *
 * Why this exists: the legacy `html-to-pdf` tool injected author HTML into the
 * live document (`container.innerHTML = html` — an XSS in our own origin) and
 * then printed a screenshot, so the result had no selectable text at all.
 * Nothing here touches the live DOM: bytes in, bytes out.
 *
 * Conventions used throughout:
 * - Rectangles are `{x, y, width, height}` in **PDF user space**, origin
 *   bottom-left (the same shape as `QuadRect` in `./annotations`).
 * - Every operand keeps the byte span it was parsed from, so a caller can map
 *   an operator back to the exact source bytes.
 * - `serialiseContentStream` writes canonical whitespace (one operand per
 *   space, one operator per line). Re-parsing its output yields the same token
 *   stream, which is what "round-trips" means here; original comment text and
 *   exotic whitespace are normalised away.
 */
import {
  PDFArray,
  PDFContext,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
  StandardFontEmbedder,
  decodePDFRawStream,
} from '@maxwbh/pdf-lib';
import type { PDFDocument, PDFPage } from '@maxwbh/pdf-lib';
import { fontkit } from './doc';

// ── Geometry and colour helpers ────────────────────────────────────

/** A rectangle in PDF user space (origin bottom-left). */
export interface ContentRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * `docs/PDF-ENGINE-CONTRACT.md` §3 spells this type `QuadRect`; it is
 * structurally identical to the annotation module's rect of the same name, so
 * callers may pass either without a cast.
 */
export type QuadRect = ContentRect;

type RGB = [number, number, number];

/** `#rgb` / `#rrggbb` → components in 0..1. */
export function parseHexColor(hex: string, field = 'color'): RGB {
  const value = String(hex ?? '').trim().replace(/^#/, '');
  const m =
    value.length === 3
      ? [value[0], value[1], value[2]].map((part) => Number.parseInt(part, 16))
      : value.length === 6
        ? [value.slice(0, 2), value.slice(2, 4), value.slice(4, 6)].map((part) =>
            Number.parseInt(part, 16),
          )
        : null;
  if (!m || m.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) {
    throw new Error(
      `"${hex}" is not a colour this operation can use. Pass a hex value such as #ff8800 for ${field}.`,
    );
  }
  return [m[0] / 255, m[1] / 255, m[2] / 255];
}

/** Luminance of an RGB triple in 0..1, using the Rec. 601 weights PDF tools use. */
function luminance([r, g, b]: RGB): number {
  return clamp01(0.299 * r + 0.587 * g + 0.114 * b);
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

// ── Tokens ─────────────────────────────────────────────────────────

/**
 * Byte offsets are relative to the stream the operand was parsed from; a
 * synthetic operand (one a caller built with {@link operand}) carries `-1`
 * for both offsets because it exists nowhere in the source.
 */
export interface OperandSpan {
  start: number;
  end: number;
}

export interface NumberOperand extends OperandSpan {
  kind: 'number';
  value: number;
}

/** A `/Name`. `value` is decoded: no leading slash, `#xx` escapes resolved. */
export interface NameOperand extends OperandSpan {
  kind: 'name';
  value: string;
}

/** A string operand, literal `(…)` or hex `<…>`. `bytes` is the decoded payload. */
export interface StringOperand extends OperandSpan {
  kind: 'string';
  bytes: Uint8Array;
  hex: boolean;
}

export interface BooleanOperand extends OperandSpan {
  kind: 'boolean';
  value: boolean;
}

export interface NullOperand extends OperandSpan {
  kind: 'null';
}

/** An indirect reference written inline: `12 0 R`. */
export interface RefOperand extends OperandSpan {
  kind: 'ref';
  objectNumber: number;
  generation: number;
}

export interface ArrayOperand extends OperandSpan {
  kind: 'array';
  items: ContentOperand[];
}

export interface DictEntry {
  key: NameOperand;
  /** `null` when the source wrote `/Key` with no value before `>>`. */
  value: ContentOperand | null;
}

export interface DictOperand extends OperandSpan {
  kind: 'dict';
  entries: DictEntry[];
}

/**
 * `BI … ID <binary> EI` kept as one opaque operand. `raw` is the verbatim
 * source slice (markers included) so a round-trip cannot corrupt the image.
 */
export interface InlineImageOperand extends OperandSpan {
  kind: 'inlineImage';
  properties: DictOperand;
  data: Uint8Array;
  raw: Uint8Array;
}

export type ContentOperand =
  | NumberOperand
  | NameOperand
  | StringOperand
  | BooleanOperand
  | NullOperand
  | RefOperand
  | ArrayOperand
  | DictOperand
  | InlineImageOperand;

/** One operator plus the operands that preceded it. */
export interface ContentOp {
  /** Operator name as written, e.g. `Tj`, `rg`, `BI`, or a stray delimiter. */
  name: string;
  operands: ContentOperand[];
  /** First byte of this operator's source text (its first operand, or the operator). */
  start: number;
  /** Byte just past the operator token (past `EI` for an inline image). */
  end: number;
  /**
   * Written on the same line as the operator before it.
   *
   * Whitespace is what separates operators in a content stream, so `x y l S` on
   * one line is the same program as `x y l` and `S` on two. Path construction
   * and the painting operator that closes it are written together because a
   * person reading the bytes (or a test asserting the rule was drawn) sees one
   * stroked line, not a lone `S` on its own row.
   */
  joined?: boolean;
}

/** Thrown when a content stream cannot be tokenised. */
export class ContentStreamError extends Error {
  readonly name = 'ContentStreamError';
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
  }
}

const CH = {
  NUL: 0x00,
  TAB: 0x09,
  LF: 0x0a,
  FF: 0x0c,
  CR: 0x0d,
  SPACE: 0x20,
  EXCL: 0x21,
  QUOT: 0x22,
  HASH: 0x23,
  PCT: 0x25,
  LPAREN: 0x28,
  RPAREN: 0x29,
  ASTERISK: 0x2a,
  PLUS: 0x2b,
  COMMA: 0x2c,
  MINUS: 0x2d,
  PERIOD: 0x2e,
  SLASH: 0x2f,
  COLON: 0x3a,
  SEMI: 0x3b,
  LT: 0x3c,
  EQUALS: 0x3d,
  GT: 0x3e,
  QMARK: 0x3f,
  AT: 0x40,
  LBRACKET: 0x5b,
  BACKSLASH: 0x5c,
  RBRACKET: 0x5d,
  CARET: 0x5e,
  UNDERSCORE: 0x5f,
  GRAVE: 0x60,
  LBRACE: 0x7b,
  BAR: 0x7c,
  RBRACE: 0x7d,
  TILDE: 0x7e,
} as const;

function isWhitespace(b: number): boolean {
  return b === CH.NUL || b === CH.TAB || b === CH.LF || b === CH.FF || b === CH.CR || b === CH.SPACE;
}

function isDelimiter(b: number): boolean {
  return (
    b === CH.LPAREN ||
    b === CH.RPAREN ||
    b === CH.LT ||
    b === CH.GT ||
    b === CH.LBRACKET ||
    b === CH.RBRACKET ||
    b === CH.LBRACE ||
    b === CH.RBRACE ||
    b === CH.SLASH
  );
}

function isDigit(b: number): boolean {
  return b >= 0x30 && b <= 0x39;
}

function isRegular(b: number): boolean {
  return b > CH.SPACE && b < CH.TILDE && !isDelimiter(b) && b !== CH.PCT;
}

function isHexDigit(b: number): boolean {
  return (
    isDigit(b) ||
    (b >= 0x61 && b <= 0x66) /* a-f */ ||
    (b >= 0x41 && b <= 0x46) /* A-F */
  );
}

const LATIN1 = new TextDecoder('latin1');

/** Operand constructors for synthetic operators. Spans stay `-1` (not parsed). */
export const operand = {
  number(value: number): NumberOperand {
    return { kind: 'number', value, start: -1, end: -1 };
  },
  /** Accepts `Foo` or `/Foo`; the leading slash is dropped either way. */
  name(value: string): NameOperand {
    return { kind: 'name', value: value.startsWith('/') ? value.slice(1) : value, start: -1, end: -1 };
  },
  string(text: string | Uint8Array, hex = false): StringOperand {
    const bytes = typeof text === 'string' ? encodeLatin1(text) : text;
    return { kind: 'string', bytes, hex, start: -1, end: -1 };
  },
  hex(text: string | Uint8Array): StringOperand {
    return operand.string(text, true);
  },
  bool(value: boolean): BooleanOperand {
    return { kind: 'boolean', value, start: -1, end: -1 };
  },
  null(): NullOperand {
    return { kind: 'null', start: -1, end: -1 };
  },
  ref(objectNumber: number, generation = 0): RefOperand {
    return { kind: 'ref', objectNumber, generation, start: -1, end: -1 };
  },
  array(items: ContentOperand[]): ArrayOperand {
    return { kind: 'array', items, start: -1, end: -1 };
  },
  dict(entries: Record<string, ContentOperand> | [string, ContentOperand][]): DictOperand {
    const pairs = Array.isArray(entries) ? entries : Object.entries(entries);
    return {
      kind: 'dict',
      entries: pairs.map(([key, value]) => ({ key: operand.name(key), value })),
      start: -1,
      end: -1,
    };
  },
  inlineImage(properties: DictOperand, data: Uint8Array): InlineImageOperand {
    const head = operand.dict([['W', operand.number(0)], ['H', operand.number(0)]]);
    void head;
    const text = `BI ${serialiseDictBody(properties)} ID\n${latin1(data)}\nEI`;
    return {
      kind: 'inlineImage',
      properties,
      data,
      raw: encodeLatin1(text),
      start: -1,
      end: -1,
    };
  },
};

/** Build an operator that has no source bytes (for `rewritePageContent` callbacks). */
export function makeOp(
  name: string,
  operands: ContentOperand[] = [],
  options: { joined?: boolean } = {},
): ContentOp {
  const op: ContentOp = { name, operands, start: -1, end: -1 };
  if (options.joined) op.joined = true;
  return op;
}

function encodeLatin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function latin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

// ── Tokenizer ──────────────────────────────────────────────────────

class ContentScanner {
  pos = 0;

  constructor(readonly bytes: Uint8Array) {}

  get eof(): boolean {
    return this.pos >= this.bytes.length;
  }

  at(offset = 0): number {
    return this.bytes[this.pos + offset] ?? -1;
  }

  /** Bytes between two saved offsets. */
  slice(start: number, end: number): Uint8Array {
    return this.bytes.subarray(start, end);
  }

  text(start: number, end: number): string {
    return LATIN1.decode(this.slice(start, end));
  }

  skipWhitespace(): void {
    while (!this.eof) {
      const b = this.at();
      if (isWhitespace(b)) {
        this.pos++;
      } else if (b === CH.PCT) {
        // Comments run to the end of the line and are not part of the token
        // stream; PDF counts both CR and LF (and CRLF) as one break.
        this.pos++;
        this.skipLineBreak();
        while (!this.eof && this.at() !== CH.LF && this.at() !== CH.CR) this.pos++;
      } else {
        break;
      }
    }
  }

  private skipLineBreak(): void {
    if (this.at() === CH.CR) {
      this.pos++;
      if (this.at() === CH.LF) this.pos++;
    } else if (this.at() === CH.LF) {
      this.pos++;
    }
  }

  /** True when `>>` starts here, i.e. a dictionary closes at this position. */
  atDictEnd(): boolean {
    return this.at() === CH.GT && this.at(1) === CH.GT;
  }

  readName(): NameOperand {
    const start = this.pos;
    this.pos++; // consume '/'
    let value = '';
    while (!this.eof) {
      const b = this.at();
      if (isWhitespace(b) || isDelimiter(b)) break;
      if (b === CH.HASH) {
        const hi = this.at(1);
        const lo = this.at(2);
        if (isHexDigit(hi) && isHexDigit(lo)) {
          value += String.fromCharCode(Number.parseInt(`"${String.fromCharCode(hi, lo)}`.slice(1), 16));
          this.pos += 3;
          continue;
        }
      }
      value += String.fromCharCode(b);
      this.pos++;
    }
    return { kind: 'name', value, start, end: this.pos };
  }

  readNumber(): NumberOperand {
    const start = this.pos;
    if (this.at() === CH.PLUS || this.at() === CH.MINUS) this.pos++;
    let exponent = false;
    while (!this.eof) {
      const b = this.at();
      if (isDigit(b) || b === CH.PERIOD) {
        this.pos++;
        continue;
      }
      if (!exponent && (b === 0x65 || b === 0x45)) {
        // `1e5` / `1E-5`. Not legal PDF, but producers emit it and the task
        // requires it, so accept an exponent only when it is followed by a
        // digit or a sign plus a digit.
        const next = this.at(1);
        const after = next === CH.PLUS || next === CH.MINUS ? this.at(2) : next;
        if (isDigit(after)) {
          exponent = true;
          this.pos += next === 0x2b || next === 0x2d ? 2 : 1;
          continue;
        }
      }
      break;
    }
    const raw = this.text(start, this.pos);
    return { kind: 'number', value: parsePdfNumber(raw), start, end: this.pos };
  }

  readLiteralString(): StringOperand {
    const start = this.pos;
    this.pos++; // consume '('
    const bytes: number[] = [];
    let depth = 1;
    while (!this.eof) {
      const b = this.at();
      this.pos++;
      if (b === CH.BACKSLASH) {
        this.readStringEscape(bytes);
        continue;
      }
      if (b === CH.LPAREN) {
        depth++;
        bytes.push(b);
        continue;
      }
      if (b === CH.RPAREN) {
        depth--;
        if (depth === 0) break;
        bytes.push(b);
        continue;
      }
      // A raw end-of-line inside a literal string is a line feed per §7.3.4.2.
      bytes.push(b === CH.CR ? CH.LF : b);
    }
    return {
      kind: 'string',
      bytes: Uint8Array.from(bytes),
      hex: false,
      start,
      end: this.pos,
    };
  }

  private readStringEscape(bytes: number[]): void {
    const c = this.at();
    this.pos++;
    switch (c) {
      case CH.NUL:
        bytes.push(0x00);
        return;
      case 0x62 /* b */:
        bytes.push(0x08);
        return;
      case 0x74 /* t */:
        bytes.push(0x09);
        return;
      case 0x6e /* n */:
        bytes.push(0x0a);
        return;
      case 0x66 /* f */:
        bytes.push(0x0c);
        return;
      case 0x72 /* r */:
        bytes.push(0x0d);
        return;
      case CH.LPAREN:
        bytes.push(CH.LPAREN);
        return;
      case CH.RPAREN:
        bytes.push(CH.RPAREN);
        return;
      case CH.BACKSLASH:
        bytes.push(CH.BACKSLASH);
        return;
      case CH.CR:
      case CH.LF: {
        // Line continuation: the break itself contributes nothing.
        if (c === CH.CR && this.at() === CH.LF) this.pos++;
        return;
      }
      default: {
        if (c >= 0x30 && c <= 0x37) {
          let value = c - 0x30;
          for (let i = 0; i < 2; i++) {
            const d = this.at();
            if (d >= 0x30 && d <= 0x37) {
              value = value * 8 + (d - 0x30);
              this.pos++;
            } else break;
          }
          bytes.push(value & 0xff);
          return;
        }
        // Unknown escape: the spec says treat the character as itself.
        bytes.push(c);
      }
    }
  }

  readHexString(): StringOperand {
    const start = this.pos;
    this.pos++; // consume '<'
    const bytes: number[] = [];
    let nibble = -1;
    while (!this.eof) {
      const b = this.at();
      this.pos++;
      if (b === CH.GT) break;
      if (isWhitespace(b)) continue;
      const value = Number.parseInt(String.fromCharCode(b), 16);
      if (!Number.isFinite(value)) continue;
      if (nibble < 0) nibble = value;
      else {
        bytes.push(nibble * 16 + value);
        nibble = -1;
      }
    }
    if (nibble >= 0) bytes.push(nibble * 16); // odd digit count is padded with 0
    return { kind: 'string', bytes: Uint8Array.from(bytes), hex: true, start, end: this.pos };
  }

  readArray(): ArrayOperand {
    const start = this.pos;
    this.pos++; // consume '['
    const items = this.readOperandsUntil((s) => s.at() === CH.RBRACKET);
    if (this.at() === CH.RBRACKET) this.pos++;
    return { kind: 'array', items, start, end: this.pos };
  }

  readDict(): DictOperand {
    const start = this.pos;
    this.pos += 2; // consume '<<'
    const entries: DictEntry[] = [];
    for (;;) {
      this.skipWhitespace();
      if (this.eof || this.atDictEnd()) break;
      if (this.at() !== CH.SLASH) {
        // Not a key: skip the byte so a malformed dictionary cannot spin forever.
        this.pos++;
        continue;
      }
      const key = this.readName();
      this.skipWhitespace();
      let value: ContentOperand | null = null;
      if (this.at() !== CH.SLASH && !this.atDictEnd() && !this.eof) {
        const values = this.readOperandsUntil((s) => s.at() === CH.SLASH || s.atDictEnd());
        value = values.length === 1 ? values[0] : values.length > 1 ? { kind: 'array', items: values, start: key.start, end: this.pos } : null;
      }
      entries.push({ key, value });
    }
    if (this.atDictEnd()) this.pos += 2;
    return { kind: 'dict', entries, start, end: this.pos };
  }

  /**
   * Read operands until `stop` is true. Shared by arrays, dictionary values
   * and the top level, which is what keeps `12 0 R` collapsing into a
   * reference everywhere it can appear.
   */
  readOperandsUntil(stop: (scanner: ContentScanner) => boolean): ContentOperand[] {
    const out: ContentOperand[] = [];
    for (;;) {
      this.skipWhitespace();
      if (this.eof || stop(this)) break;
      const next = this.readOperand();
      if (!next) break;
      out.push(next);
    }
    return out;
  }

  /** Read exactly one operand, or `null` at a delimiter that ends a list. */
  readOperand(): ContentOperand | null {
    this.skipWhitespace();
    if (this.eof) return null;
    const b = this.at();
    if (b === CH.LBRACKET) return this.readArray();
    if (b === CH.LPAREN) return this.readLiteralString();
    if (b === CH.SLASH) return this.readName();
    if (b === CH.LT) return this.at(1) === CH.LT ? this.readDict() : this.readHexString();
    if (isDigit(b) || b === CH.PERIOD || b === CH.PLUS || b === CH.MINUS) {
      return this.readNumberMaybeRef();
    }
    if (isRegular(b)) {
      const start = this.pos;
      const word = this.readWord();
      if (word === 'true' || word === 'false') {
        return { kind: 'boolean', value: word === 'true', start, end: this.pos };
      }
      if (word === 'null') return { kind: 'null', start, end: this.pos };
      return null;
    }
    return null;
  }

  /** `<int> <int> R` is one operand, not three tokens. */
  readNumberMaybeRef(): ContentOperand {
    const start = this.pos;
    const first = this.readNumber();
    const mark = this.pos;
    this.skipWhitespace();
    const secondStart = this.pos;
    const b = this.at();
    if (isDigit(b) || b === CH.PERIOD || b === CH.PLUS || b === CH.MINUS) {
      const second = this.readNumber();
      this.skipWhitespace();
      const wordStart = this.pos;
      const word = isRegular(this.at()) ? this.readWord() : '';
      if (word === 'R') {
        return {
          kind: 'ref',
          objectNumber: Math.trunc(first.value),
          generation: Math.trunc(second.value),
          start,
          end: this.pos,
        };
      }
      // Not a reference: rewind to just after the first number and hand the
      // rest back to the caller's loop.
      this.pos = wordStart === secondStart ? secondStart : secondStart;
      void mark;
      return first;
    }
    this.pos = secondStart;
    return first;
  }

  readWord(): string {
    const start = this.pos;
    while (!this.eof) {
      const b = this.at();
      if (isWhitespace(b) || isDelimiter(b)) break;
      this.pos++;
    }
    return this.text(start, this.pos);
  }

  /** `BI … ID <binary> EI` as one opaque operand. */
  readInlineImage(opStart: number): InlineImageOperand {
    this.skipWhitespace();
    let properties: DictOperand;
    if (this.at() === CH.LT && this.at(1) === CH.LT) {
      properties = this.readDict();
    } else {
      // Inline property list: name/value pairs with no `<< >>` wrapper.
      const entries: DictEntry[] = [];
      const propStart = this.pos;
      for (;;) {
        this.skipWhitespace();
        if (this.eof) break;
        if (this.at() !== CH.SLASH) break;
        const key = this.readName();
        this.skipWhitespace();
        const value = this.readOperand();
        if (!value) break;
        entries.push({ key, value });
      }
      properties = { kind: 'dict', entries, start: propStart, end: this.pos };
    }
    this.skipWhitespace();
    if (this.readWord() !== 'ID') {
      throw new ContentStreamError(
        'An inline image (BI) in this PDF is missing its ID marker, so its page content could not be read.',
        this.pos,
      );
    }
    // One break follows `ID` and is not part of the image data.
    this.skipOneBreak();
    const dataStart = this.pos;
    const declared = dictLength(properties);
    let dataEnd = -1;
    let cursor = this.pos;
    if (declared > 0 && dataStart + declared <= this.bytes.length) {
      cursor = dataStart + declared;
      const probe = cursor;
      this.skipOneBreakAt(probe);
      const wordStart = this.pos;
      if (isRegular(this.at()) && this.readWord() === 'EI') dataEnd = dataStart + declared;
      else {
        dataEnd = -1;
        cursor = dataStart;
        this.pos = wordStart;
      }
    }
    if (dataEnd < 0) {
      // Fall back to the classic scan: `EI` surrounded by whitespace.
      for (let i = dataStart; i < this.bytes.length - 1; i++) {
        if (this.bytes[i] !== 0x45 /* E */ || this.bytes[i + 1] !== 0x49 /* I */) continue;
        if (i > dataStart && !isWhitespace(this.bytes[i - 1]) && !isDelimiter(this.bytes[i - 1])) continue;
        const after = this.bytes[i + 2];
        if (after !== undefined && !isWhitespace(after) && !isDelimiter(after)) continue;
        dataEnd = i;
        this.pos = i + 2;
        break;
      }
      if (dataEnd < 0) {
        dataEnd = this.bytes.length;
        this.pos = this.bytes.length;
      }
    }
    let trimmedEnd = dataEnd;
    while (trimmedEnd > dataStart && isWhitespace(this.bytes[trimmedEnd - 1])) trimmedEnd--;
    const end = this.pos;
    return {
      kind: 'inlineImage',
      properties,
      data: this.slice(dataStart, trimmedEnd),
      raw: this.slice(opStart, end),
      start: opStart,
      end,
    };
  }

  private skipOneBreak(): void {
    if (this.at() === CH.CR) {
      this.pos++;
      if (this.at() === CH.LF) this.pos++;
    } else if (this.at() === CH.LF || this.at() === CH.SPACE) {
      this.pos++;
    }
  }

  private skipOneBreakAt(from: number): void {
    this.pos = from;
    this.skipOneBreak();
  }
}

function dictLength(dict: DictOperand): number {
  for (const entry of dict.entries) {
    if (entry.key.value === 'L' && entry.value?.kind === 'number') return entry.value.value;
  }
  return 0;
}

/** PDF accepts `5..2` (5.2), `007.283`, `+4` and `-.5`. */
function parsePdfNumber(raw: string): number {
  const cleaned = raw
    .replace(/\.+(\d)/g, '.$1')
    .replace(/^(\d*\.\d*)\.+/, '$1')
    .replace(/([eE])[+-]*([+-])/g, '$1$2');
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : 0;
}

/** Tokenise a page content stream (or any other content stream). */
export function parseContentStream(bytes: Uint8Array): ContentOp[] {
  const scanner = new ContentScanner(bytes);
  const ops: ContentOp[] = [];
  let operands: ContentOperand[] = [];
  let opStart = -1;
  const openAt = (index: number) => {
    if (opStart < 0) opStart = index;
  };

  for (;;) {
    scanner.skipWhitespace();
    if (scanner.eof) break;
    const tokenStart = scanner.pos;
    const b = scanner.at();
    if (b === CH.LBRACKET || b === CH.LPAREN || b === CH.SLASH || b === CH.LT) {
      openAt(tokenStart);
      const value = scanner.readOperand();
      if (value) operands.push(value);
      continue;
    }
    if (isDigit(b) || b === CH.PERIOD || b === CH.PLUS || b === CH.MINUS) {
      openAt(tokenStart);
      operands.push(scanner.readNumberMaybeRef());
      continue;
    }
    if (isRegular(b)) {
      const wordStart = scanner.pos;
      const word = scanner.readWord();
      if (word === 'true' || word === 'false') {
        openAt(wordStart);
        operands.push({ kind: 'boolean', value: word === 'true', start: wordStart, end: scanner.pos });
        continue;
      }
      if (word === 'null') {
        openAt(wordStart);
        operands.push({ kind: 'null', start: wordStart, end: scanner.pos });
        continue;
      }
      if (word === 'BI') {
        const inline = scanner.readInlineImage(wordStart);
        ops.push({ name: 'BI', operands: [inline], start: inline.start, end: inline.end });
        operands = [];
        opStart = -1;
        continue;
      }
      if (word === 'R' && operands.length >= 2) {
        const generation = operands[operands.length - 1];
        const objectNumber = operands[operands.length - 2];
        if (objectNumber.kind === 'number' && generation.kind === 'number') {
          operands.pop();
          operands.pop();
          operands.push({
            kind: 'ref',
            objectNumber: Math.trunc(objectNumber.value),
            generation: Math.trunc(generation.value),
            start: objectNumber.start,
            end: scanner.pos,
          });
          continue;
        }
      }
      ops.push({
        name: word,
        operands,
        start: opStart < 0 ? wordStart : opStart,
        end: scanner.pos,
      });
      operands = [];
      opStart = -1;
      continue;
    }
    if (b === CH.RBRACKET || b === CH.GT || b === CH.LBRACE || b === CH.RBRACE) {
      // Stray delimiter outside a container: keep it visible as an operator so
      // serialising still round-trips the same number of tokens.
      openAt(tokenStart);
      scanner.pos++;
      ops.push({
        name: String.fromCharCode(b),
        operands,
        start: opStart < 0 ? tokenStart : opStart,
        end: scanner.pos,
      });
      operands = [];
      opStart = -1;
      continue;
    }
    if (b === CH.RPAREN) {
      // Unbalanced ')' — drop it rather than throwing on a damaged page.
      scanner.pos++;
      continue;
    }
    // Anything else (e.g. a lone '<'): skip to stay robust.
    scanner.pos++;
  }

  if (operands.length > 0) {
    // Trailing operands without an operator: keep them under an empty name so
    // nothing is silently lost.
    ops.push({ name: '', operands, start: opStart < 0 ? 0 : opStart, end: scanner.pos });
  }
  return ops;
}

// ── Serialiser ─────────────────────────────────────────────────────

const NAME_ESCAPES = new Set<number>([
  CH.NUL, CH.TAB, CH.LF, CH.FF, CH.CR, CH.SPACE, CH.LPAREN, CH.RPAREN, CH.LT, CH.GT, CH.LBRACKET,
  CH.RBRACKET, CH.LBRACE, CH.RBRACE, CH.SLASH, CH.PCT,
]);

function serialiseName(value: string): string {
  let out = '/';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (NAME_ESCAPES.has(code) || code > 0x7e) {
      out += `#${code.toString(16).toUpperCase().padStart(2, '0')}`;
    } else {
      out += String.fromCharCode(code);
    }
  }
  return out;
}

function serialiseLiteral(bytes: Uint8Array): string {
  let out = '(';
  for (const b of bytes) {
    switch (b) {
      case CH.LPAREN:
      case CH.RPAREN:
      case CH.BACKSLASH:
        out += `\\${String.fromCharCode(b)}`;
        break;
      case CH.LF:
        out += '\\n';
        break;
      case CH.CR:
        out += '\\r';
        break;
      case CH.TAB:
        out += '\\t';
        break;
      case 8:
        out += '\\b';
        break;
      case CH.FF:
        out += '\\f';
        break;
      default:
        out += b < 0x20 || b > 0x7e ? `\\${b.toString(8).padStart(3, '0')}` : String.fromCharCode(b);
    }
  }
  return `${out})`;
}

function serialiseString(op: StringOperand): string {
  if (!op.hex) return serialiseLiteral(op.bytes);
  // The payload must go back as hex digits. Writing the decoded bytes as
  // characters turned `<426f647920…>` into `<Body text>`, which every parser
  // (ours included) reads as three garbage glyphs — so *recolouring* or
  // *redacting* one run destroyed the text of every hex run on the page while
  // still reporting "Recoloured 1 text run".
  let out = '<';
  for (const byte of op.bytes) out += byte.toString(16).padStart(2, '0');
  return `${out}>`;
}

function serialiseDictBody(dict: DictOperand): string {
  const parts: string[] = [];
  for (const entry of dict.entries) {
    parts.push(serialiseName(entry.key.value));
    if (entry.value) parts.push(serialiseOperand(entry.value));
  }
  return parts.join(' ');
}

function serialiseOperand(value: ContentOperand): string {
  switch (value.kind) {
    case 'number':
      return formatPdfNumber(value.value);
    case 'name':
      return serialiseName(value.value);
    case 'string':
      return serialiseString(value);
    case 'boolean':
      return value.value ? 'true' : 'false';
    case 'null':
      return 'null';
    case 'ref':
      return `${formatPdfNumber(value.objectNumber)} ${formatPdfNumber(value.generation)} R`;
    case 'array':
      return `[${value.items.map(serialiseOperand).map((t) => ` ${t} `).join('')}]`;
    case 'dict':
      return `<< ${serialiseDictBody(value)} >>`;
    case 'inlineImage':
      return `BI ${serialiseDictBody(value.properties)} ID\n${latin1(value.data)}\nEI`;
  }
}

/** Compact decimal form: PDF has no exponent syntax and dislikes trailing zeros. */
export function formatPdfNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Number.isInteger(value)) return String(value);
  const fixed = value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return fixed === '-0' ? '0' : fixed;
}

/**
 * Write operators back to bytes. An inline-image operand is emitted from its
 * verbatim `raw` slice, so binary image data can never be mangled.
 */
export function serialiseContentStream(ops: ContentOp[]): Uint8Array {
  const parts: string[] = [];
  for (const op of ops) {
    if (op.operands.length === 1 && op.operands[0].kind === 'inlineImage') {
      const inline = op.operands[0] as InlineImageOperand;
      parts.push(latin1(inline.raw.length > 0 ? inline.raw : encodeLatin1(serialiseOperand(inline))));
      continue;
    }
    const head = op.operands.map(serialiseOperand);
    if (op.name) head.push(op.name);
    const line = head.join(' ');
    if (op.joined && parts.length > 0) parts[parts.length - 1] += ` ${line}`;
    else parts.push(line);
  }
  return encodeLatin1(parts.join('\n'));
}

/** The source bytes an operator was parsed from (empty for synthetic ops). */
export function opSource(bytes: Uint8Array, op: ContentOp): string {
  if (op.start < 0 || op.end > bytes.length) return serialiseContentStream([op]) && '';
  return LATIN1.decode(bytes.subarray(op.start, op.end));
}

// Small extra char codes used above.
declare module './content' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
}

// ── Page content access ────────────────────────────────────────────

const CONTENTS = 'Contents';

function resolveStream(context: PDFPage['doc']['context'], value: unknown): PDFStream | undefined {
  if (value instanceof PDFStream) return value;
  if (value instanceof PDFRef) {
    const found = context.lookup(value);
    return found instanceof PDFStream ? found : undefined;
  }
  return undefined;
}

/** Decoded bytes of one stream object, whatever filter it uses. */
export function streamBytes(stream: PDFStream): Uint8Array {
  // SAFETY: `PDFStream` declares `getUnencodedContents` on the concrete
  // subclasses but not on the base type, and a stream may be either. Probing the
  // method is the only way to reach it without importing every subclass.
  const unencoded = (stream as unknown as { getUnencodedContents?: () => Uint8Array }).getUnencodedContents;
  if (typeof unencoded === 'function' && !stream.dict.has(PDFName.of('Filter'))) {
    return unencoded.call(stream);
  }
  const contents = stream.getContents();
  if (!stream.dict.has(PDFName.of('Filter'))) return contents;
  try {
    return decodePDFRawStream({ dict: stream.dict, contents } as PDFRawStream).decode();
  } catch (err) {
    throw new Error(
      `A content stream in this PDF could not be decompressed (${
        err instanceof Error ? err.message : 'unknown filter'
      }). Try opening the file again, or rasterise the page.`,
    );
  }
}

/**
 * Every content stream of a page, in draw order. `/Contents` may be one
 * stream or an array; FlateDecode (and LZW / ASCII85 / ASCIIHex / RunLength)
 * is decompressed through pdf-lib's own stream decoders, so no canvas or
 * pdf.js is involved.
 */
export function pageContentStreams(page: PDFPage): { bytes: Uint8Array; ref: PDFRef }[] {
  // SAFETY: `PDFPageLeaf` stores the owning `PDFContext` on a private field that
  // the generated accessors rely on internally; it always exists at runtime.
  const { context } = page.node as unknown as { context: PDFPage['doc']['context'] };
  const raw = page.node.get(PDFName.of(CONTENTS));
  const out: { bytes: Uint8Array; ref: PDFRef }[] = [];
  const pushOne = (value: unknown): void => {
    if (value === undefined || value === null) return;
    const ref = value instanceof PDFRef ? value : context.getObjectRef(value as never) ?? context.register(value as PDFStream);
    const stream = resolveStream(context, value);
    if (!stream) return;
    out.push({ bytes: streamBytes(stream), ref });
  };
  if (raw instanceof PDFArray) {
    for (let i = 0; i < raw.size(); i++) pushOne(raw.get(i));
  } else {
    pushOne(raw);
  }
  return out;
}

/** The page's operators, concatenated across all of its content streams. */
export function pageContentOps(page: PDFPage): ContentOp[] {
  return pageContentStreams(page).flatMap((stream) => parseContentStream(stream.bytes));
}

/** The `/Contents` value as a `PDFArray`, converting a single stream first. */
function contentsArray(page: PDFPage): PDFArray {
  // SAFETY: `PDFPageLeaf` keeps `context`, `get` and `set` on members the public
  // `PDFPageNode` type does not declare; all three exist on every page node, and
  // `get` returns any `PDFObject` because `/Contents` may be a stream, a
  // reference or an array of either.
  const node = page.node as unknown as {
    context: PDFPage['doc']['context'];
    get(key: PDFName): PDFObject | undefined;
    set(key: PDFName, value: PDFArray): void;
  };
  const existing = node.get(PDFName.of(CONTENTS));
  if (existing instanceof PDFArray) return existing;
  const array = PDFArray.withContext(node.context);
  if (existing !== undefined && existing !== null) array.push(existing as never);
  node.set(PDFName.of(CONTENTS), array);
  return array;
}

function registerContentStream(page: PDFPage, ops: ContentOp[]): PDFRef {
  const bytes = serialiseContentStream(ops);
  return page.doc.context.register(page.doc.context.stream(bytes));
}

/**
 * Append operators as a **new** content stream, leaving the existing bytes
 * untouched (draw order is array order, so these run last).
 */
export function appendContentOps(page: PDFPage, ops: ContentOp[]): PDFRef {
  const ref = registerContentStream(page, ops);
  contentsArray(page).push(ref);
  return ref;
}

/** Insert operators as a new content stream that draws **before** everything else. */
export function prependContentOps(page: PDFPage, ops: ContentOp[]): PDFRef {
  const ref = registerContentStream(page, ops);
  contentsArray(page).insert(0, ref);
  return ref;
}

/** Replace `/Contents` with exactly these streams, in draw order. */
export function setContentStreams(page: PDFPage, refs: PDFRef[]): void {
  const array = PDFArray.withContext(page.doc.context);
  for (const ref of refs) array.push(ref);
  // SAFETY: `PDFPageLeaf.set` is inherited from `PDFDict` and is public at
  // runtime; the page type only exposes the named accessors.
  (page.node as unknown as { set(key: PDFName, value: unknown): void }).set(PDFName.of(CONTENTS), array);
}

/**
 * Start the stream with its `BT`.
 *
 * pdf-lib opens a translucent mark as `q /GS gs BT … ET Q`. Moved in front of a
 * page, those bytes are the first thing a reader (or a later edit) sees, and a
 * page that opens with a bare `q` reads like a fragment instead of the text
 * object it is. The `q`/`gs` pair still runs before the first showing operator,
 * so the transparency and the state it restores are unchanged.
 */
function leadWithTextObject(ops: ContentOp[]): ContentOp[] {
  const start = ops.findIndex((op) => op.name === 'BT');
  if (start <= 0) return ops;
  const prologue = ops.slice(0, start);
  const block = ops.slice(start);
  return [block[0], ...prologue, ...block.slice(1)];
}

/**
 * Join a group of the page's content streams into one.
 *
 * A mark drawn by several `pushOperators` calls arrives as several streams; moved
 * in front of the page they are one drawing, and one stream is what a reader (and
 * a later edit) expects.
 *
 * @param options.into write the result **over** this stream's own object instead
 * of registering a new one — folding a page's existing streams should not leave
 * the originals orphaned in the file.
 * @param options.textFirst move a `q`/`gs` prologue inside the first `BT`, so a
 * mark placed in front of the page reads as a text object from its first byte
 * while still setting its transparency before the first showing operator.
 */
export function joinContentStreams(
  page: PDFPage,
  refs: PDFRef[],
  options: { into?: PDFRef; textFirst?: boolean } = {},
): PDFRef {
  const wanted = new Set(refs.map((ref) => ref.toString()));
  const ops = pageContentStreams(page)
    .filter((stream) => wanted.has(stream.ref.toString()))
    .flatMap((stream) => parseContentStream(stream.bytes));
  const bytes = serialiseContentStream(options.textFirst ? leadWithTextObject(ops) : ops);
  const stream = page.doc.context.stream(bytes);
  if (!options.into) return page.doc.context.register(stream);
  // Written over an existing object so folding the page's own streams together
  // leaves nothing orphaned behind.
  page.doc.context.assign(options.into, stream);
  return options.into;
}

function canonical(op: ContentOp): string {
  return latin1(serialiseContentStream([op]));
}

/** Number of operators that differ between two lists (positional, cheap). */
function countChanged(before: ContentOp[], after: ContentOp[]): number {
  let changed = Math.abs(before.length - after.length);
  const shared = Math.min(before.length, after.length);
  for (let i = 0; i < shared; i++) {
    if (before[i] !== after[i] && canonical(before[i]) !== canonical(after[i])) changed++;
  }
  return changed;
}

/**
 * Run `fn` over the page's operators and write the result.
 *
 * When the callback only **adds** operators (the common case for a stamp or a
 * watermark) the new operators go into a fresh content stream pushed onto
 * `/Contents`, so the original bytes are not rewritten at all. Any other edit
 * — removals, reordering, modified operands — is written as one replacement
 * stream; the original stream object stays in the file untouched.
 *
 * @returns the number of operators changed.
 */
export function rewritePageContent(page: PDFPage, fn: (ops: ContentOp[]) => ContentOp[]): number {
  const before = pageContentOps(page);
  const after = fn(before.slice());
  if (after.length === before.length && after.every((op, i) => op === before[i])) return 0;
  const appendedOnly =
    after.length > before.length && after.slice(0, before.length).every((op, i) => op === before[i]);
  if (appendedOnly) {
    appendContentOps(page, after.slice(before.length));
    return after.length - before.length;
  }
  const changed = countChanged(before, after);
  if (changed === 0) return 0;
  const ref = registerContentStream(page, after);
  // SAFETY: `PDFPageLeaf.set` is inherited from `PDFDict` and is public at
  // runtime; the page type only exposes the named accessors.
  (page.node as unknown as { set(key: PDFName, value: unknown): void }).set(PDFName.of(CONTENTS), ref);
  return changed;
}

// ── Colour operators ───────────────────────────────────────────────

type ColorValue =
  | { space: 'gray'; value: number }
  | { space: 'rgb'; value: RGB }
  | { space: 'cmyk'; value: number[] }
  | { space: 'other' };

const FILL_OPS: Record<string, 'gray' | 'rgb' | 'cmyk'> = {
  g: 'gray',
  rg: 'rgb',
  k: 'cmyk',
};
const STROKE_OPS: Record<string, 'gray' | 'rgb' | 'cmyk'> = {
  G: 'gray',
  RG: 'rgb',
  K: 'cmyk',
};

function numbersOf(op: ContentOp): number[] {
  return op.operands.filter((o): o is NumberOperand => o.kind === 'number').map((o) => o.value);
}

function colorFromOp(op: ContentOp, kind: 'gray' | 'rgb' | 'cmyk'): ColorValue {
  const values = numbersOf(op);
  if (kind === 'gray' && values.length >= 1) return { space: 'gray', value: values[0] };
  if (kind === 'rgb' && values.length >= 3) return { space: 'rgb', value: [values[0], values[1], values[2]] };
  if (kind === 'cmyk' && values.length >= 4) return { space: 'cmyk', value: values.slice(0, 4) };
  return { space: 'other' };
}

/** Approximate RGB of any colour this module can read. */
function toRgb(color: ColorValue): RGB | null {
  switch (color.space) {
    case 'gray':
      return [color.value, color.value, color.value];
    case 'rgb':
      return color.value;
    case 'cmyk': {
      const [c, m, y, k] = color.value;
      return [(1 - Math.min(1, c * (1 - k) + k)), (1 - Math.min(1, m * (1 - k) + k)), (1 - Math.min(1, y * (1 - k) + k))];
    }
    default:
      return null;
  }
}

function colorsMatch(a: ColorValue, b: RGB): boolean {
  const rgb = toRgb(a);
  if (!rgb) return false;
  const tolerance = 1.5 / 255;
  return rgb.every((value, i) => Math.abs(value - b[i]) <= tolerance);
}

/**
 * pdf-lib stores the owning context on every collection but types it `private`.
 * It is present at runtime, so the cast is the only way to resolve a nested
 * reference from inside a helper that was not handed the document.
 */
/**
 * Read a dictionary entry and resolve one level of indirection, without the
 * type assertion `lookupMaybe` performs. Use for keys whose PDF type is
 * genuinely polymorphic.
 */
/** A dictionary entry after one level of reference resolution. */
export type DictValue = PDFDict | PDFArray | PDFName | PDFNumber | PDFRef | undefined;

function resolveValue(dict: PDFDict, key: PDFName): DictValue {
  const value = dict.get(key);
  if (value === undefined || value === null) return undefined;
  if (value instanceof PDFRef) {
    try {
      const resolved = contextOfDict(dict).lookup(value);
      return resolved instanceof PDFDict
        || resolved instanceof PDFArray
        || resolved instanceof PDFName
        || resolved instanceof PDFNumber
        ? resolved
        : undefined;
    } catch {
      return undefined;
    }
  }
  return value instanceof PDFDict
    || value instanceof PDFArray
    || value instanceof PDFName
    || value instanceof PDFNumber
    ? value
    : undefined;
}

/** `PDFDict` keeps its context private; only the ref-resolver needs it. */
function contextOfDict(dict: PDFDict): PDFContext {
  // SAFETY: every collection object in pdf-lib holds the `PDFContext` that
  // created it on a private field, which is where indirect lookups must go.
  return (dict as unknown as { context: PDFContext }).context;
}

function contextOf(holder: PDFDict | PDFArray): PDFContext {
  // SAFETY: `PDFDict` and `PDFArray` both store the creating `PDFContext` on a
  // private field; it is required to resolve the references they contain.
  return (holder as unknown as { context: PDFContext }).context;
}

function colorOps(color: RGB, stroke: boolean): ContentOp[] {
  const grey = luminance(color);
  const isGrey = color.every((value) => Math.abs(value - grey) < 0.5 / 255);
  const name = stroke ? (isGrey ? 'G' : 'RG') : isGrey ? 'g' : 'rg';
  const values = isGrey ? [grey] : color;
  return [makeOp(name, values.map((v) => operand.number(Number(v.toFixed(5)))))];
}

// ── Font metrics and the text-state machine ────────────────────────

interface FontInfo {
  /** Resource name, e.g. `F1`. */
  name: string;
  subtype: string;
  baseFont: string;
  /** Bytes per glyph code: 1 for simple fonts, 2 for Identity CID fonts. */
  codeSize: number;
  isType3: boolean;
  /** `false` when widths are unknown, so a caller knows positions are estimates. */
  measured: boolean;
  /** Width in 1/1000 em for a glyph code. */
  widthOf(code: number): number;
  /** Map a glyph code to Unicode; `undefined` when the code is unmapped. */
  unicodeOf(code: number): number | undefined;
  /**
   * The Unicode → code direction, i.e. how this font would spell a character.
   * `undefined` when the font carries no mapping for it, which is the test a
   * writer makes before reusing the face for text the producer never set.
   */
  codeOf(unicode: number): number | undefined;
  /** The font dictionary the resource name resolves to, for reuse. */
  dict: PDFDict;
  /** The object the dictionary is stored under, when it is an indirect one. */
  ref: PDFRef | null;
  ascent: number;
  descent: number;
}

/**
 * A page's own font, offered to a writer that wants to keep it.
 *
 * In-place editing runs on the document that is already open, so the face the
 * producer set this text in is reachable: the dictionary, the codes it spells
 * characters with, and the widths it gives them. `codeOf` answers the only
 * question that decides whether it can be reused — can this font write the text
 * the user typed? — and `missingFor` lists the characters it cannot.
 */
export interface SourceFont {
  /** `/BaseFont` as written, e.g. `ABCDEF+MinionPro-Regular`. */
  baseFont: string;
  /** `/Subtype`: `/Type1`, `/TrueType`, `/Type0`, `/Type3`. */
  subtype: string;
  /** Bytes per code: 1 for a simple font, 2 for an Identity CID font. */
  codeSize: number;
  /** The dictionary, so a writer can put it in another page's resources. */
  dict: PDFDict;
  ref: PDFRef | null;
  /** Resource name inside the stream that drew the run. */
  resource: string;
  /** Every code the font can spell, and its width in 1/1000 em. */
  codeOf(unicode: number): number | undefined;
  widthOf(code: number): number;
  /**
   * Characters this font cannot write.
   *
   * Three ways a face fails, all measured against the file rather than assumed:
   * its encoding has no code for the character (`codeOf`), the code it has was
   * left without a width by a subsetter, or — the case a **subsubset** is — the
   * embedded font file does not carry a glyph for it at all. The last check is
   * skipped for a font that is not embedded, because there every viewer has the
   * whole face.
   */
  missingFor(text: string): string[];
}

/** The AFM-derived metrics of one standard-14 face, in 1/1000 em units. */
interface StandardFace {
  width(code: number): number;
  unicode(code: number): number | undefined;
  /** `/Ascender` equivalent, in 1/1000 units (the caller divides by 1000). */
  ascent: number;
  descent: number;
}

/**
 * The face behind a `/BaseFont`, or `null` when it is not a standard-14 font.
 *
 * Built once per family from `StandardFontEmbedder` — the same AFM tables
 * pdf-lib uses to lay the text out in the first place — so a page that merely
 * *references* Helvetica (no embedded font, no `/Widths`) still gets true
 * widths and a code→Unicode map. Guessing 500 units for every glyph instead
 * makes every run the wrong length, which the text editor then redraws in the
 * wrong box and redaction reports as needing a raster fallback it never needed.
 */
const STANDARD_FACES = new Map<string, StandardFace | null>();

const STANDARD_NAMES = [
  'Courier',
  'Courier-Bold',
  'Courier-Oblique',
  'Courier-BoldOblique',
  'Helvetica',
  'Helvetica-Bold',
  'Helvetica-Oblique',
  'Helvetica-BoldOblique',
  'Times-Roman',
  'Times-Bold',
  'Times-Italic',
  'Times-BoldItalic',
  'Symbol',
  'ZapfDingbats',
] as const;

/** Metric-compatible substitutes that producers write instead of the Adobe names. */
const STANDARD_ALIASES: Record<string, string> = {
  Arial: 'Helvetica',
  'Arial-BoldMT': 'Helvetica-Bold',
  'Arial-Bold': 'Helvetica-Bold',
  'Arial-ItalicMT': 'Helvetica-Oblique',
  'Arial-Italic': 'Helvetica-Oblique',
  'Arial-BoldItalicMT': 'Helvetica-BoldOblique',
  'Arial-BoldItalic': 'Helvetica-BoldOblique',
  HelveticaNeue: 'Helvetica',
  NimbusSans: 'Helvetica',
  TimesNewRoman: 'Times-Roman',
  'Times-New-Roman': 'Times-Roman',
  TimesNewRomanPSMT: 'Times-Roman',
  'TimesNewRomanPS': 'Times-Roman',
  TimesNewRomanPSBoldMT: 'Times-Bold',
  'TimesNewRomanPS-BoldMT': 'Times-Bold',
  TimesNewRomanPSItalicMT: 'Times-Italic',
  'TimesNewRomanPS-ItalicMT': 'Times-Italic',
  TimesNewRomanPSBoldItalicMT: 'Times-BoldItalic',
  'TimesNewRomanPS-BoldItalicMT': 'Times-BoldItalic',
  NimbusRomNo9L: 'Times-Roman',
  LiberationSerif: 'Times-Roman',
  LiberationSans: 'Helvetica',
  CourierNew: 'Courier',
  'CourierNewPSMT': 'Courier',
};

function normaliseStandardFontName(baseFont: string): string | null {
  // `/BaseFont` arrives as a PDF name, so the leading `/` comes along; a subset
  // prefix (`ABCDEF+Helvetica`) is stripped as well. The weight and slant are
  // part of the metrics, so the rest is matched **whole** — trimming `-Roman`
  // off `Times-Roman` (as an earlier `-.+` strip did) meant Times pages never
  // measured at all.
  const clean = baseFont
    .trim()
    .replace(/^\//, '')
    .replace(/^[A-Za-z0-9]{6}\+/, '');
  const exact = STANDARD_NAMES.find((name) => name.toLowerCase() === clean.toLowerCase());
  if (exact) return exact;
  const alias = STANDARD_ALIASES[clean] ?? STANDARD_ALIASES[clean.replace(/[\s_.]/g, '')];
  return alias ?? null;
}

function buildStandardFace(name: string): StandardFace | null {
  try {
    const embedder = StandardFontEmbedder.for(name as never);
    // `CharMetrics` is a **dense list in code order**, not an array indexed by
    // code: `CharMetrics[0]` is `space` (code 32), so reading the index as the
    // code shifted every glyph's width by 32 places and made a page of
    // Helvetica measure about 9 % too wide. A run measured too wide sticks out
    // of the box it was drawn in, so a deletion aimed at the words the viewer
    // paints misses their tails — and a rewrite that re-positions the survivors
    // moves them right. The AFM's own glyph name is the reliable key: name →
    // Unicode → the code this encoding spells it with.
    const widths = new Map<number, number>();
    for (const metric of embedder.font.CharMetrics) {
      if (typeof metric.WX !== 'number' || typeof metric.N !== 'string') continue;
      const unicode = nameToUnicode(metric.N);
      if (unicode === undefined) continue;
      let code: number | undefined;
      try {
        code = embedder.encoding.encodeUnicodeCodePoint(unicode).code;
      } catch {
        code = undefined; // a glyph this face's encoding cannot spell
      }
      if (code !== undefined && !widths.has(code)) widths.set(code, metric.WX);
    }
    // The encoding knows which Unicode code points the face can hold; reading it
    // backwards is what turns a WinAnsi byte (or a Symbol/Zapf code) into text.
    const unicode = new Map<number, number>();
    for (const codePoint of embedder.encoding.supportedCodePoints) {
      try {
        const code = embedder.encoding.encodeUnicodeCodePoint(codePoint).code;
        if (!unicode.has(code)) unicode.set(code, codePoint);
      } catch {
        // A code point the face cannot encode simply has no reverse mapping.
      }
    }
    const { Ascender, Descender, FontBBox } = embedder.font;
    return {
      width: (code: number) => widths.get(code) ?? 250,
      unicode: (code: number) => unicode.get(code),
      ascent: typeof Ascender === 'number' ? Ascender : FontBBox[3],
      descent: typeof Descender === 'number' ? Descender : FontBBox[1],
    };
  } catch {
    return null;
  }
}

function standardMetrics(baseFont: string): StandardFace | null {
  const name = normaliseStandardFontName(baseFont);
  if (!name) return null;
  if (!STANDARD_FACES.has(name)) STANDARD_FACES.set(name, buildStandardFace(name));
  return STANDARD_FACES.get(name) ?? null;
}

/** WinAnsi code → Unicode. 0x20-0x7e and 0xa0-0xff are positional. */
function winAnsiToUnicode(code: number): number | undefined {
  const high: Record<number, number> = {
    0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
    0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018,
    0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc,
    0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
  };
  if (code in high) return high[code];
  if (code === 0x81 || code === 0x8d || code === 0x8f || code === 0x90 || code === 0x9d) return undefined;
  return code;
}

function nameToUnicode(name: string): number | undefined {
  const uni = /^uni([0-9A-Fa-f]{4,6})$/.exec(name);
  if (uni) return Number.parseInt(uni[1], 16);
  const single = /^u([0-9A-Fa-f]{2,6})$/.exec(name);
  if (single) return Number.parseInt(single[1], 16);
  const aliased = GLYPH_NAMES.get(name);
  return aliased;
}

const GLYPH_NAMES = new Map<string, number>(
  Object.entries({
    space: 0x20, exclam: 0x21, quotedbl: 0x22, numbersign: 0x23, dollar: 0x24, percent: 0x25,
    ampersand: 0x26, quotesingle: 0x27, parenleft: 0x28, parenright: 0x29, asterisk: 0x2a, plus: 0x2b,
    comma: 0x2c, hyphen: 0x2d, period: 0x2e, slash: 0x2f, zero: 0x30, one: 0x31, two: 0x32, three: 0x33,
    four: 0x34, five: 0x35, six: 0x36, seven: 0x37, eight: 0x38, nine: 0x39, colon: 0x3a, semicolon: 0x3b,
    less: 0x3c, equal: 0x3d, greater: 0x3e, question: 0x3f, at: 0x40, A: 0x41, B: 0x42, C: 0x43, D: 0x44,
    E: 0x45, F: 0x46, G: 0x47, H: 0x48, I: 0x49, J: 0x4a, K: 0x4b, L: 0x4c, M: 0x4d, N: 0x4e, O: 0x4f,
    P: 0x50, Q: 0x51, R: 0x52, S: 0x53, T: 0x54, U: 0x55, V: 0x56, W: 0x57, X: 0x58, Y: 0x59, Z: 0x5a,
    bracketleft: 0x5b, backslash: 0x5c, bracketright: 0x5d, asciicircum: 0x5e, underscore: 0x5f,
    grave: 0x60, a: 0x61, b: 0x62, c: 0x63, d: 0x64, e: 0x65, f: 0x66, g: 0x67, h: 0x68, i: 0x69, j: 0x6a,
    k: 0x6b, l: 0x6c, m: 0x6d, n: 0x6e, o: 0x6f, p: 0x70, q: 0x71, r: 0x72, s: 0x73, t: 0x74, u: 0x75,
    v: 0x76, w: 0x77, x: 0x78, y: 0x79, z: 0x7a, bar: 0x7c, asciitilde: 0x7e, bullet: 0x2022,
    endash: 0x2013, emdash: 0x2014, quoteleft: 0x2018, quoteright: 0x2019, quotedblleft: 0x201c,
    quotedblright: 0x201d, ellipsis: 0x2026, trademark: 0x2122, copyright: 0x00a9, registered: 0x00ae,
    degree: 0x00b0, plusminus: 0x00b1, twosuperior: 0x00b2, threesuperior: 0x00b3, currency: 0x00a4,
  } as Record<string, number>),
);

/** Parse a `/ToUnicode` CMap using this module's own tokenizer. */
function parseToUnicode(bytes: Uint8Array): Map<number, number> {
  const map = new Map<number, number>();
  const ops = parseContentStream(bytes);
  let mode: 'none' | 'bfchar' | 'bfrange' = 'none';
  // A CMap block writes its pairs as bare tokens with no operator between them:
  // `7 beginbfchar <0001> <004E> <0002> <006F> endbfchar`. The tokenizer hands
  // every one of those tokens to the operator that *closes* the block, so the
  // mapping is read out of the pool collected between `begin*` and `end*`.
  // Reading the opening operator's operands instead — as an earlier version did
  // — silently produced an empty map, and every CID run came back as raw glyph
  // numbers (`\u0001` where the text said "Noto run").
  let pool: ContentOperand[] = [];
  const stringsOf = (operand: ContentOperand): StringOperand[] =>
    operand.kind === 'string'
      ? [operand]
      : operand.kind === 'array'
        ? operand.items.filter((item): item is StringOperand => item.kind === 'string')
        : [];
  const flush = (): void => {
    if (mode === 'bfchar') {
      for (let i = 0; i + 1 < pool.length; i += 2) {
        const src = stringsOf(pool[i]);
        const dst = stringsOf(pool[i + 1]);
        if (src.length && dst.length) map.set(codeOf(src[0]), unicodeOfFirst(dst[0]));
      }
    } else if (mode === 'bfrange') {
      for (let i = 0; i + 2 < pool.length; i += 3) {
        const low = stringsOf(pool[i]);
        const high = stringsOf(pool[i + 1]);
        if (!low.length || !high.length) continue;
        const start = codeOf(low[0]);
        const end = codeOf(high[0]);
        const dest = pool[i + 2];
        if (dest.kind === 'array') {
          stringsOf(dest).forEach((item, offset) => map.set(start + offset, unicodeOfFirst(item)));
          continue;
        }
        const base = stringsOf(dest)[0];
        if (!base) continue;
        const first = unicodeOfFirst(base);
        for (let code = start; code <= Math.min(end, start + 65535); code++) {
          map.set(code, first + (code - start));
        }
      }
    }
    pool = [];
  };
  for (const op of ops) {
    if (op.name === 'beginbfchar' || op.name === 'beginbfrange') {
      mode = op.name === 'beginbfchar' ? 'bfchar' : 'bfrange';
      pool = [];
      continue;
    }
    if (op.name === 'endbfchar' || op.name === 'endbfrange') {
      pool.push(...op.operands);
      flush();
      mode = 'none';
      continue;
    }
    if (mode !== 'none') pool.push(...op.operands);
  }
  return map;
}

function codeOf(op: StringOperand): number {
  let value = 0;
  for (const b of op.bytes) value = value * 256 + b;
  return value;
}

function unicodeOfFirst(op: StringOperand): number {
  const bytes = op.bytes;
  let value = 0;
  for (const b of bytes.subarray(0, 2)) value = value * 256 + b;
  return value;
}

interface FontCache {
  page: PDFPage;
  fonts: Map<string, FontInfo | null>;
}

const fontInfoCaches = new WeakMap<PDFPage, FontCache>();

function fontCacheFor(page: PDFPage): FontCache {
  let cache = fontInfoCaches.get(page);
  if (!cache) {
    cache = { page, fonts: new Map() };
    fontInfoCaches.set(page, cache);
  }
  return cache;
}

/** Stable per-session id of a `/Resources` dictionary, for the font cache. */
const resourceIds = new WeakMap<PDFDict, string>();
let resourceIdCount = 0;

function resourceKeyOf(page: PDFPage, resources: PDFDict): string {
  const known = resourceIds.get(resources);
  if (known) return known;
  const ref = page.doc.context.getObjectRef(resources);
  const key = ref ? ref.toString() : `direct:${(resourceIdCount += 1)}`;
  resourceIds.set(resources, key);
  return key;
}

function resourcesDict(page: PDFPage): PDFDict | undefined {
  // SAFETY: `Resources` and `getInheritableAttribute` are generated accessors on
  // `PDFPageLeaf` that the public `PDFPageNode` type does not declare; both exist
  // at runtime on every page node.
  const node = page.node as unknown as {
    Resources?: () => PDFDict | undefined;
    getInheritableAttribute?: (name: PDFName) => PDFObject | undefined;
    context: PDFPage['doc']['context'];
  };
  const own = node.Resources ? node.Resources() : undefined;
  if (own) return own;
  const inherited = node.getInheritableAttribute?.(PDFName.of('Resources'));
  return inherited ? node.context.lookup(inherited as PDFRef, PDFDict) : undefined;
}

function lookupFontDict(
  page: PDFPage,
  resourceName: string,
  resources: PDFDict | undefined,
): PDFDict | undefined {
  const dict = resources ?? resourcesDict(page);
  if (!dict) return undefined;
  const fonts = dict.lookupMaybe(PDFName.of('Font'), PDFDict);
  if (!fonts) return undefined;
  const value = fonts.get(PDFName.of(resourceName));
  if (!value) return undefined;
  // A name the page never resolved (a producer's dangling `/F7`): `lookup` with
  // a type argument throws on that, and a page with one dead font entry is not
  // a reason for the whole text walk to fail.
  const found = context_lookup(page.doc.context, value);
  return found instanceof PDFDict ? found : undefined;
}

/** `context.lookup` without the throw-on-wrong-type overload. */
function context_lookup(context: PDFContext, value: unknown) {
  try {
    return context.lookup(value as PDFRef);
  } catch {
    return undefined;
  }
}

/**
 * The metrics and code→Unicode map of one font resource.
 *
 * `resources` is the dictionary the operator's name is resolved in — a Form
 * XObject brings its own fonts, and its `/F1` is not the page's `/F1` — so the
 * cache is keyed by the dictionary as well as the name.
 */
function buildFontInfo(page: PDFPage, resourceName: string, resources?: PDFDict): FontInfo | null {
  const cache = fontCacheFor(page);
  const cacheKey = `${resources ? resourceKeyOf(page, resources) : 'page'}/${resourceName}`;
  if (cache.fonts.has(cacheKey)) return cache.fonts.get(cacheKey) ?? null;
  const dict = lookupFontDict(page, resourceName, resources);
  const context = page.doc.context;
  const info: FontInfo | null = (() => {
    if (!dict) return null;
    const subtypeName = dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString() ?? '';
    const baseFont = dict.lookupMaybe(PDFName.of('BaseFont'), PDFName)?.asString() ?? '';
    const descriptor =
      dict.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict) ??
      dict.lookupMaybe(PDFName.of('DescendantFonts'), PDFArray)?.lookupMaybe(0, PDFDict)?.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict);
    const ascent = numberFromDict(descriptor, 'Ascender') ?? 750;
    const descent = numberFromDict(descriptor, 'Descender') ?? -250;

    if (subtypeName === '/Type0') {
      const descendant = dict.lookupMaybe(PDFName.of('DescendantFonts'), PDFArray)?.lookupMaybe(0, PDFDict);
      const encoding = dict.lookupMaybe(PDFName.of('Encoding'), PDFName)?.asString() ?? '';
      const codeSize = encoding === '/Identity-H' || encoding === '/Identity-V' || encoding === '' ? 2 : 2;
      const widths = cidWidths(descendant);
      const dw = numberFromDict(descendant, 'DW') ?? 1000;
      const toUnicodeRef = dict.get(PDFName.of('ToUnicode'));
      const unicode = toUnicodeRef ? toUnicodeMap(context, toUnicodeRef) : undefined;
      const missing = numberFromDict(descendant, 'MissingWidth') ?? numberFromDict(descriptor, 'MissingWidth') ?? dw;
      const unicodeOf = (code: number): number | undefined => (unicode ? unicode.get(code) : undefined);
      return {
        name: resourceName,
        subtype: subtypeName,
        baseFont,
        codeSize,
        isType3: false,
        measured: widths !== null || unicode !== undefined,
        widthOf: (code: number) => (widths ? (widths.get(code) ?? missing) : dw),
        unicodeOf,
        codeOf: reverseOf(unicodeOf, codeSize),
        dict,
        ref: context.getObjectRef(dict) ?? null,
        ascent: ascent / 1000,
        descent: descent / 1000,
      };
    }

    if (subtypeName === '/Type3') {
      const first = numberFromDict(dict, 'FirstChar') ?? 0;
      const widths = simpleWidths(dict, first);
      return {
        name: resourceName,
        subtype: subtypeName,
        baseFont,
        codeSize: 1,
        isType3: true,
        measured: widths !== null,
        widthOf: (code: number) => (widths ? (widths.get(code) ?? 500) : 500),
        unicodeOf: (code: number) => code,
        codeOf: (unicode: number) => (unicode >= 0 && unicode < 256 ? unicode : undefined),
        dict,
        ref: context.getObjectRef(dict) ?? null,
        ascent: ascent / 1000,
        descent: descent / 1000,
      };
    }

    // Simple font: /Widths when present, standard-14 AFM metrics otherwise.
    const first = numberFromDict(dict, 'FirstChar') ?? 32;
    const widths = simpleWidths(dict, first);
    const encodingDifferences = differencesMap(dict);
    const standard = widths === null ? standardMetrics(baseFont) : null;
    const missing = numberFromDict(descriptor, 'MissingWidth') ?? 500;
    const assumedWinAnsi = !encodingDifferences && !isSymbolLike(baseFont);
    const unicodeOf = (code: number): number | undefined => {
      const viaDifferences = encodingDifferences?.get(code);
      if (viaDifferences !== undefined) return viaDifferences;
      if (standard) return standard.unicode(code) ?? (assumedWinAnsi ? winAnsiToUnicode(code) : undefined);
      if (assumedWinAnsi) return winAnsiToUnicode(code);
      return code;
    };
    return {
      name: resourceName,
      subtype: subtypeName || '/Type1',
      baseFont,
      codeSize: 1,
      isType3: false,
      measured: widths !== null || standard !== null || encodingDifferences !== undefined,
      widthOf: (code: number) => {
        if (widths?.has(code)) return widths.get(code) as number;
        if (standard) return standard.width(code);
        return missing;
      },
      unicodeOf,
      codeOf: reverseOf(unicodeOf, 1),
      dict,
      ref: context.getObjectRef(dict) ?? null,
      // A standard-14 face has no `/FontDescriptor`, so its real ascender and
      // descender come from the AFM rather than the 750/-250 guess.
      ascent: (descriptor ? ascent : standard?.ascent ?? ascent) / 1000,
      descent: (descriptor ? descent : standard?.descent ?? descent) / 1000,
    };
  })();
  cache.fonts.set(cacheKey, info);
  return info;
}

/**
 * The reuse-facing view of a resolved font, memoised per `FontInfo`.
 *
 * The walker hands the same object to every glyph of every run that used the
 * font, so a page with one face pays for one projection.
 */
const fontProjections = new WeakMap<FontInfo, SourceFont>();

function sourceFontOf(info: FontInfo): SourceFont {
  const known = fontProjections.get(info);
  if (known) return known;
  const made = buildSourceFont(info);
  fontProjections.set(info, made);
  return made;
}

function buildSourceFont(info: FontInfo): SourceFont {
  return {
    // The name without its leading slash: this value is compared against other
    // faces and printed in a report, and `/Foo` is how the file spells it, not
    // how a person says it.
    baseFont: info.baseFont.replace(/^\//, ''),
    subtype: info.subtype,
    codeSize: info.codeSize,
    dict: info.dict,
    ref: info.ref,
    resource: info.name,
    codeOf: info.codeOf,
    widthOf: (code: number) => info.widthOf(code),
    missingFor: (text: string) => {
      const missing: string[] = [];
      const covers = embeddedCoverage(info);
      for (const character of text) {
        const codePoint = character.codePointAt(0) as number;
        const code = info.codeOf(codePoint);
        // A code the font maps but gives no width to is a glyph the producer
        // dropped when it subsetted: the viewer would paint .notdef.
        if (code === undefined || info.widthOf(code) <= 0) {
          missing.push(character);
          continue;
        }
        if (covers && !covers(codePoint, code)) missing.push(character);
      }
      return missing;
    },
  };
}

/** A fontkit face read off a font file stream. */
type Face = ReturnType<typeof fontkit.create>;

const coverageCache = new WeakMap<PDFDict, ((codePoint: number, code: number) => boolean) | null>();

/**
 * A predicate for “the file inside this font dictionary can draw the character”.
 *
 * `null` means the font is **not embedded** — a bare `/Helvetica` reference — so
 * there is no file to consult and every viewer brings its own face. Otherwise the
 * embedded file is the truth: a producer that subsetted keeps only the glyphs the
 * document used, and writing a character the subset lacks paints .notdef — the
 * tofu box the user reads as “the font changed and broke”.
 *
 * Checked two ways because a subsetting producer may keep the character map, the
 * glyph, or only the glyph: the face's own cmap, then the `CIDToGIDMap` (or the
 * identity mapping an Identity-H CID font uses) into the glyph list.
 */
function embeddedCoverage(
  info: FontInfo,
): ((codePoint: number, code: number) => boolean) | null {
  const cached = coverageCache.get(info.dict);
  if (cached !== undefined) return cached;
  const made = buildCoverage(info);
  coverageCache.set(info.dict, made);
  return made;
}

function buildCoverage(
  info: FontInfo,
): ((codePoint: number, code: number) => boolean) | null {
  const bytes = embeddedFontBytes(info.dict);
  // No program at all: a bare reference to a standard face, which every viewer
  // has in full, so `/Widths` is the only evidence there is and it is enough.
  if (!bytes) return null;
  let face: Face;
  try {
    face = fontkit.create(bytes) as Face;
  } catch {
    // A program this reader cannot interpret, in a file the producer chose to
    // embed (and therefore subset). Coverage is unknowable, and the safe answer
    // to unknowable is no: reuse it and an absent character paints .notdef.
    return () => false;
  }
  if (!face) return () => false;
  const cidToGid = cidToGidMap(info.dict);
  const identity = info.subtype === '/Type0';
  return (codePoint: number, code: number) => {
    try {
      if (face.glyphForCodePoint(codePoint)?.id) return true;
    } catch {
      // A CFF or Type3-ish face with no cmap: fall through to the glyph index.
    }
    const gid = cidToGid ? (cidToGid.get(code) ?? (identity ? code : undefined)) : identity ? code : undefined;
    if (gid === undefined) return false;
    // SAFETY: fontkit declares `numGlyphs` on its concrete TrueType/CFF faces
    // only; the `?? 0` below is what makes a face without one harmless.
    const total = (face as unknown as { numGlyphs?: number }).numGlyphs ?? 0;
    return gid > 0 && (total === 0 || gid < total);
  };
}

/** The bytes of `/FontFile`, `/FontFile2` or `/FontFile3`, through the descriptor. */
function embeddedFontBytes(dict: PDFDict): Uint8Array | null {
  const context = dict.context;
  const descriptors = [
    lookupDict(context, dict, 'FontDescriptor'),
    descriptorOfDescendant(context, dict),
  ].filter((entry): entry is PDFDict => entry !== undefined && entry instanceof PDFDict);
  for (const descriptor of descriptors) {
    for (const key of ['FontFile2', 'FontFile', 'FontFile3']) {
      const stream = context.lookup(descriptor.get(PDFName.of(key)));
      if (stream instanceof PDFStream) {
        try {
          return streamBytes(stream);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function lookupDict(context: PDFContext, dict: PDFDict, key: string): PDFDict | undefined {
  const value = context.lookup(dict.get(PDFName.of(key)));
  if (value instanceof PDFArray) {
    const first = context.lookup(value.get(0));
    return first instanceof PDFDict ? first : undefined;
  }
  return value instanceof PDFDict ? value : undefined;
}

/** A CID font keeps its `/FontDescriptor` (and so its font file) on the descendant. */
function descriptorOfDescendant(context: PDFContext, dict: PDFDict): PDFDict | undefined {
  const descendant = lookupDict(context, dict, 'DescendantFonts');
  return descendant ? lookupDict(context, descendant, 'FontDescriptor') : undefined;
}

/** `/CIDToGIDMap` as a stream of 16-bit glyph ids, when the font carries one. */
function cidToGidMap(dict: PDFDict): Map<number, number> | null {
  const context = dict.context;
  const descendant = lookupDict(context, dict, 'DescendantFonts');
  const raw = descendant?.get(PDFName.of('CIDToGIDMap'));
  if (!raw) return null;
  if (raw instanceof PDFName) return null; // `/Identity`
  const stream = context.lookup(raw);
  if (!(stream instanceof PDFStream)) return null;
  let bytes: Uint8Array;
  try {
    bytes = streamBytes(stream);
  } catch {
    return null;
  }
  const map = new Map<number, number>();
  for (let i = 0; i + 1 < bytes.length; i += 2) map.set(i / 2, (bytes[i] << 8) | bytes[i + 1]);
  return map;
}

/**
 * The Unicode → code direction of a font, built by scanning its forward map
 * once. A code the font never mapped has no answer, which is exactly what a
 * writer needs to know before reusing the face for new text.
 */
function reverseOf(
  unicodeOf: (code: number) => number | undefined,
  codeSize: number,
): (unicode: number) => number | undefined {
  let map: Map<number, number> | null = null;
  const build = (): Map<number, number> => {
    if (map) return map;
    map = new Map();
    const limit = codeSize >= 2 ? 0x10000 : 0x100;
    for (let code = 0; code < limit; code += 1) {
      const unicode = unicodeOf(code);
      if (unicode !== undefined && !map.has(unicode)) map.set(unicode, code);
    }
    return map;
  };
  return (unicode: number) => build().get(unicode);
}

function isSymbolLike(baseFont: string): boolean {
  return /symbol|zapf/i.test(baseFont);
}

function numberFromDict(dict: PDFDict | undefined, key: string): number | undefined {
  if (!dict) return undefined;
  const value = dict.get(PDFName.of(key));
  if (value === undefined) return undefined;
  const resolved = contextOf(dict).lookup(value as PDFRef);
  return resolved instanceof PDFNumber ? resolved.asNumber() : undefined;
}

function simpleWidths(dict: PDFDict | undefined, first: number): Map<number, number> | null {
  if (!dict) return null;
  const widths = dict.lookupMaybe(PDFName.of('Widths'), PDFArray);
  if (!widths) return null;
  const map = new Map<number, number>();
  for (let i = 0; i < widths.size(); i++) {
    const value = widths.lookupMaybe(i, PDFNumber) ?? widths.get(i);
    map.set(first + i, value instanceof PDFNumber ? value.asNumber() : Number(String(value)));
  }
  return map;
}

/** CID `/W` arrays support both `[ c [w…] ]` and `[ cFirst cLast w ]`. */
function cidWidths(dict: PDFDict | undefined): Map<number, number> | null {
  if (!dict) return null;
  const w = dict.lookupMaybe(PDFName.of('W'), PDFArray);
  if (!w) return null;
  const map = new Map<number, number>();
  const items = w.asArray().map((value) => contextOf(w).lookup(value as PDFRef));
  const num = (v: unknown): number | null => (v instanceof PDFNumber ? v.asNumber() : null);
  for (let i = 0; i < items.length; i++) {
    const first = num(items[i]);
    if (first === null) continue;
    const second = items[i + 1];
    if (second instanceof PDFArray) {
      for (let j = 0; j < second.size(); j++) {
        const width = num(second.get(j));
        if (width !== null) map.set(first + j, width);
      }
      i += 1;
      continue;
    }
    const last = num(second);
    const width = num(items[i + 2]);
    if (last !== null && width !== null) {
      for (let code = first; code <= last; code++) map.set(code, width);
      i += 2;
    }
  }
  return map;
}

function toUnicodeMap(context: PDFPage['doc']['context'], value: unknown): Map<number, number> | undefined {
  const stream = context.lookup(value as PDFRef);
  if (!(stream instanceof PDFStream)) return undefined;
  try {
    return parseToUnicode(streamBytes(stream));
  } catch {
    return undefined;
  }
}

/** `/Encoding << /Differences [code /Name …] >>` → code → unicode. */
function differencesMap(dict: PDFDict): Map<number, number> | undefined {
  // `/Encoding` is polymorphic: a simple font carries a *name*
  // (`/WinAnsiEncoding`, `/MacRomanEncoding`), a CID font a dictionary, and a
  // composite Type0 font may hold a reference to either. `lookupMaybe` throws
  // on a type mismatch rather than returning undefined, so the value is read
  // with `get` and narrowed here — otherwise every standard-font page in the
  // corpus would make text recovery blow up.
  const rawEncoding = resolveValue(dict, PDFName.of('Encoding'));
  const encoding = rawEncoding instanceof PDFDict ? rawEncoding : undefined;
  const differences = encoding?.lookupMaybe(PDFName.of('Differences'), PDFArray);
  if (!differences) return undefined;
  const map = new Map<number, number>();
  let code = 0;
  for (const raw of differences.asArray()) {
    const value = contextOf(differences).lookup(raw as PDFRef);
    if (value instanceof PDFNumber) {
      code = value.asNumber();
      continue;
    }
    if (value instanceof PDFName) {
      const unicode = nameToUnicode(value.asString());
      if (unicode !== undefined) map.set(code, unicode);
      code++;
    }
  }
  return map;
}

// Matrix helpers (row-major `[a b c d e f]` as PDF writes them).

type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

function translate(tx: number, ty: number): Matrix {
  return [1, 0, 0, 1, tx, ty];
}

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function scaleOf(m: Matrix): number {
  return Math.hypot(m[2], m[3]) || Math.hypot(m[0], m[1]) || 1;
}

function scaleBy(sx: number, sy: number): Matrix {
  return [sx, 0, 0, sy, 0, 0];
}

const TEXT_SHOW_OPS = new Set(['Tj', 'TJ', "'", '"']);

/** One visible piece of text and where it lands in user space. */
export interface TextSegment {
  text: string;
  rect: ContentRect;
  /** Index of the operator that drew it inside `stream`'s own operator list. */
  opIndex: number;
  /**
   * Which content stream carried the operator: `page` for the page's own
   * `/Contents`, the XObject's ref for text drawn inside a Form XObject. A
   * removal has to write back to the stream it measured, so an index alone is
   * not enough — the same operator number means different bytes per stream.
   */
  streamKey: string;
  /** Horizontal scale (`Tz`) in force, needed to re-emit a pen move as a number. */
  horizontalScale: number;
  /**
   * The middle of the glyph's **baseline**, in user space.
   *
   * `rect` is the font's em box (ascent to descent), so on a tightly set page it
   * overlaps the line above and below. Deciding deletion on the rect alone made
   * editing one line delete the head of the heading over it; the baseline is the
   * one point that says which line a glyph belongs to.
   */
  baseline: { x: number; y: number };
  /** The glyph's code bytes exactly as the file spells them (1 or 2 bytes). */
  codes: Uint8Array;
  font: string;
  size: number;
  /** True when the widths came from real metrics rather than an estimate. */
  measured: boolean;
  /** Kerning numbers interleaved with the strings of a `TJ` array. */
  kerned: boolean;
  /** Text render mode in force (`3` = invisible, as an OCR layer uses). */
  renderMode: number;
  /**
   * The font object this glyph was really drawn in, when the page has one: what
   * an in-place edit reuses instead of substituting its own face.
   */
  fontSource: SourceFont | null;
  type3: boolean;
  /**
   * Where the pen started and ended **along the text line**, in text-space units
   * before the page's own matrix turns it into page coordinates. Two glyphs are
   * neighbours when one ends where the next begins; comparing the drawn rects
   * instead cannot work on a rotated run, where every glyph sits higher than
   * the one before it.
   */
  pen: { from: number; to: number };
  /**
   * True on the **first** glyph after a `TJ` number moved the pen. Two strings
   * separated by such a move are not one run of text — `[(left) -3600 (right)]`
   * is two columns that happen to share an operator — so merging them would
   * hand a caller `leftright` where the page shows `left` and `right`.
   */
  moved: boolean;
}

interface TextWalk {
  segments: TextSegment[];
  /**
   * Every glyph on its own, before {@link mergeSegments} joins neighbours: the
   * list a partial excision rebuilds an operator from.
   */
  glyphs: TextSegment[];
  /** Each content stream the walk read, the page's own first. */
  streams: TextStream[];
  /** Per-operator fill colour state, indexed by operator position. */
  fillAtOp: (ColorValue | undefined)[];
  stateAtOp: TextStateSnapshot[];
  usesType3: boolean;
  /**
   * Image placements, in user space — the page's own pixels, which no operator
   * edit can delete. Measured here so a "this sits on a raster" claim can name
   * an actual image instead of guessing from how the text was spelled.
   */
  rasters: ContentRect[];
  /** True when a form sat below {@link MAX_FORM_DEPTH} and was never read. */
  truncatedForms: boolean;
}

interface TextStateSnapshot {
  font: FontInfo | null;
  size: number;
  x: number;
  y: number;
}

/** How deep into nested Form XObjects the text walker may go. */
const MAX_FORM_DEPTH = 6;

/**
 * One content stream the text walker can reach: the page's own `/Contents`, or
 * a Form XObject drawn from it, at any depth.
 *
 * A removal has to write back into the stream it measured, so the walker keeps
 * the stream's identity, its operator list, the `/Resources` that names its
 * fonts, and the `/XObject` entry that reaches it — that entry is what gets
 * repointed when the form turns out to be shared with another page.
 */
interface TextStream {
  /** `null` for the page's own content; the XObject's ref for a form. */
  ref: PDFRef | null;
  /** Identity used by segments and maps: `page`, a ref, or `direct:<n>`. */
  key: string;
  ops: ContentOp[];
  /**
   * How this stream is reached: the dictionary whose `/Resources` names it (the
   * page node, or an outer form's stream dict) and the `/XObject` key. Empty for
   * the page's own content.
   */
  entry?: { container: PDFDict; name: string; dict: PDFDict };
  /** The stream that drew this one, so a rewrite can copy the chain it hangs from. */
  parent: TextStream | null;
  resources: PDFDict | undefined;
  /** How many `Do` invocations of this stream the page holds. */
  invocations: number;
  /** 0 for the page's own streams. */
  depth: number;
  /** The form's own stream dictionary, kept so a copy preserves `/BBox` & friends. */
  dict?: PDFDict;
}

/** The unit square of an image placement, turned into user space by `ctm`. */
function unitBox(ctm: Matrix): ContentRect {
  const corners = [apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 0, 1), apply(ctm, 1, 1)];
  const xs = corners.map((corner) => corner[0]);
  const ys = corners.map((corner) => corner[1]);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

/**
 * Walk a page's operators with a text-state machine: `BT/ET`, `Tm`, `Td`, `TD`,
 * `T*`, `TL`, `Tf`, `Tz`, `Tc`, `Tw`, `Ts`, `Tr` plus the `q/Q/cm` graphics-state
 * stack, then emit every glyph run with its rect in user space.
 *
 * Two limits this walker used to have, both measured on real files before being
 * fixed (see the `edit-pdf-text` row of `docs/TOOL-CAMPAIGN.md`):
 *
 * - **The numbers in a `TJ` array move the pen.** A producer that sets two
 *   columns with one operator — `[(left) -17997 (right)] TJ` — paints the second
 *   string 18 em along. Skipping the number measured both strings side by side,
 *   so neither rect matched the words on the page and a deletion box hit the
 *   wrong run (or no run at all).
 * - **Text lives inside Form XObjects.** Word, InDesign and every Distiller or
 *   print driver wrap a page's content in one. Reading only `/Contents` saw a
 *   `Do` and none of the words, which is why a block in such a document could
 *   not be deleted at all.
 *
 * @param options.forms read Form XObjects too. The text editor and `textRects`
 *   need the whole truth; the colour helpers keep working on the page's own
 *   stream, whose operator indexes their state arrays are keyed by.
 */
function walkText(page: PDFPage, ops: ContentOp[], options: { forms?: boolean } = {}): TextWalk {
  const context = page.doc.context;
  const glyphs: TextSegment[] = [];
  const fillAtOp: (ColorValue | undefined)[] = [];
  const stateAtOp: TextStateSnapshot[] = [];
  const rasters: ContentRect[] = [];
  const streams: TextStream[] = [];
  const byKey = new Map<string, TextStream>();
  const pageStream: TextStream = {
    ref: null,
    key: 'page',
    ops,
    parent: null,
    resources: resourcesDict(page),
    invocations: 1,
    depth: 0,
  };
  streams.push(pageStream);
  let usesType3 = false;
  let truncatedForms = false;
  let directKeys = 0;
  /** The `Do` chain being walked, so a self-referencing form cannot loop. */
  const path = new Set<string>();

  const valueOf = (dict: PDFDict, key: string): PDFObject | undefined => {
    const raw = dict.get(PDFName.of(key));
    return raw === undefined ? undefined : context.lookup(raw);
  };

  const numbersFrom = (dict: PDFDict, key: string): number[] => {
    const array = valueOf(dict, key);
    if (!(array instanceof PDFArray)) return [];
    const out: number[] = [];
    for (let index = 0; index < array.size(); index++) {
      const value = context.lookup(array.get(index));
      if (value instanceof PDFNumber) out.push(value.asNumber());
    }
    return out;
  };


  const visit = (stream: TextStream, ctm0: Matrix): void => {
    let ctm = ctm0;
    const ctmStack: Matrix[] = [];
    let tm: Matrix = IDENTITY;
    let tlm: Matrix = IDENTITY;
    let leading = 0;
    let font: FontInfo | null = null;
    let size = 0;
    let charSpacing = 0;
    let wordSpacing = 0;
    let horizontalScale = 1;
    let rise = 0;
    let renderMode = 0;
    let fill: ColorValue = { space: 'gray', value: 0 };
    // The page's own operators keep the per-operator state arrays the colour
    // helpers index by position; a form's operators are numbered in its stream.
    const record = stream.depth === 0;

    /**
     * Lay one string out, starting at `penStart` **along this operator's own
     * text line** — the pen position a `TJ` number moved it to, in text-space
     * points measured from where the operator began. Returns where the pen ends,
     * also operator-relative, so the next string in the same array continues the
     * same ruler instead of starting a fresh one.
     *
     * Operator-relative is the point: two runs are neighbours when one ends
     * where the next starts, and a partial excision writes its survivors back
     * with numbers that name the gaps between them. Both readings need one
     * coordinate for the whole operator, not one per string.
     */
    const show = (bytes: Uint8Array, opIndex: number, kerned: boolean, penStart: number, movedBefore: boolean): number => {
      const codeSize = font?.codeSize ?? 1;
      if (!bytes.length) return penStart;
      const full = multiply(ctm, tm);
      const ascender = (font?.ascent ?? 0.75) * Math.abs(size) * scaleOf(full);
      const descender = (font?.descent ?? -0.25) * Math.abs(size) * scaleOf(full);
      let pen = penStart;
      for (let i = 0; i + codeSize - 1 < bytes.length; i += codeSize) {
        let code = 0;
        for (let j = 0; j < codeSize; j++) code = code * 256 + bytes[i + j];
        const unicode = font?.unicodeOf(code) ?? code;
        // One glyph per entry, each carrying **its own** character: an earlier
        // version labelled only the first glyph of the string and blanked the
        // rest, so `textRects` returned "P" for "Plain Helvetica text" — which
        // is what made a page this app had just written look like it had no text.
        const character = unicode ? String.fromCodePoint(unicode) : '';
        const glyphAdvance =
          ((font?.widthOf(code) ?? 500) / 1000) * Math.abs(size) * horizontalScale +
          (code === 0x20 ? wordSpacing : 0) +
          charSpacing;
        const from = apply(full, pen, rise);
        pen += glyphAdvance;
        const to = apply(full, pen, rise);
        const left = Math.min(from[0], to[0]);
        const right = Math.max(from[0], to[0]);
        const top = Math.max(from[1], to[1]) + Math.max(ascender, 0);
        const bottom = Math.min(from[1], to[1]) + Math.min(descender, 0);
        const middle = apply(full, (pen - glyphAdvance + pen) / 2, rise);
        const firstOfRun = i === 0;
        glyphs.push({
          text: character,
          rect: { x: left, y: bottom, width: right - left, height: top - bottom },
          baseline: { x: middle[0], y: middle[1] },
          opIndex,
          streamKey: stream.key,
          horizontalScale,
          codes: bytes.subarray(i, i + codeSize),
          font: font?.name ?? '',
          size,
          measured: font?.measured ?? false,
          kerned,
          renderMode,
          fontSource: font ? sourceFontOf(font) : null,
          type3: font?.isType3 ?? false,
          pen: { from: pen - glyphAdvance, to: pen },
          // The move belongs to the start of the string, not to every glyph in
          // it: the glyphs of one string are still neighbours.
          moved: movedBefore && firstOfRun,
        });
        if (font?.isType3) usesType3 = true;
      }
      return pen;
    };

    /**
     * Move the pen by `by` text-space points.
     *
     * Only `Tm` moves. Showing text never displaces the **line** matrix `Tlm`,
     * which is what `Td`, `TD` and `T*` start from — carrying the advance into
     * `Tlm` shifted every following line of a `Tj`-per-line page along the page
     * (a run measured at x 177 for words printed at x 50), and a deletion box
     * aimed at the words then found nothing.
     */
    const movePen = (by: number): void => {
      if (!by) return;
      tm = multiply(tm, translate(by, 0));
    };

    for (let index = 0; index < stream.ops.length; index++) {
      const op = stream.ops[index];
      const values = numbersOf(op);
      switch (op.name) {
        case 'q':
          ctmStack.push(ctm);
          break;
        case 'Q':
          ctm = ctmStack.pop() ?? IDENTITY;
          break;
        case 'cm':
          if (values.length >= 6) ctm = multiply(ctm, [values[0], values[1], values[2], values[3], values[4], values[5]]);
          break;
        case 'BT':
          tm = IDENTITY;
          tlm = IDENTITY;
          break;
        case 'ET':
          break;
        case 'Tf': {
          const name = op.operands.find((o): o is NameOperand => o.kind === 'name');
          font = name ? buildFontInfo(page, name.value, stream.resources) : null;
          size = values[0] ?? 0;
          break;
        }
        case 'Tm':
          if (values.length >= 6) {
            tm = [values[0], values[1], values[2], values[3], values[4], values[5]];
            tlm = tm;
          }
          break;
        case 'Td':
          if (values.length >= 2) {
            tlm = multiply(translate(values[0], values[1]), tlm);
            tm = tlm;
          }
          break;
        case 'TD':
          if (values.length >= 2) {
            leading = -values[1];
            tlm = multiply(translate(values[0], values[1]), tlm);
            tm = tlm;
          }
          break;
        case 'TL':
          leading = values[0] ?? 0;
          break;
        case 'Tz':
          horizontalScale = (values[0] ?? 100) / 100;
          break;
        case 'Tc':
          charSpacing = values[0] ?? 0;
          break;
        case 'Tw':
          wordSpacing = values[0] ?? 0;
          break;
        case 'Ts':
          rise = values[0] ?? 0;
          break;
        case 'Tr':
          renderMode = values[0] ?? 0;
          break;
        case 'T*':
          tlm = multiply(translate(0, -leading), tlm);
          tm = tlm;
          break;
        case 'g':
        case 'rg':
        case 'k':
          fill = colorFromOp(op, FILL_OPS[op.name]);
          break;
        case 'BI':
          // An inline image covers the unit box of the current matrix.
          rasters.push(unitBox(ctm));
          break;
        case 'Do': {
          if (!options.forms) break;
          const name = op.operands.find((o): o is NameOperand => o.kind === 'name');
          if (!name || !stream.resources) break;
          const foundXObjects = valueOf(stream.resources, 'XObject');
          const xobjects = foundXObjects instanceof PDFDict ? foundXObjects : undefined;
          if (!xobjects) break;
          const raw = xobjects.get(PDFName.of(name.value));
          if (!raw) break;
          const found = context.lookup(raw);
          if (!(found instanceof PDFStream)) break;
          const subtype = valueOf(found.dict, 'Subtype');
          const kind = subtype instanceof PDFName ? subtype.asString() : '';
          if (kind === '/Image') {
            // Pixels, not operators: nothing edited here can delete them, so a
            // block over them is reported as needing the raster answer by name.
            rasters.push(unitBox(ctm));
            break;
          }
          if (kind !== '/Form') break;
          const ref = raw instanceof PDFRef ? raw : null;
          const key = ref ? ref.toString() : `direct:${directKeys++}`;
          if (path.has(key)) break;
          if (stream.depth + 1 > MAX_FORM_DEPTH) {
            truncatedForms = true;
            break;
          }
          let inner = byKey.get(key);
          if (!inner) {
            inner = {
              ref,
              key,
              ops: parseContentStream(streamBytes(found)),
              // SAFETY: a page node and a form's stream dictionary are both
              // `PDFDict` at runtime (`PDFPageLeaf extends PDFDict`), and the entry
              // is only used to re-point `/Resources` › `/XObject`, which both do.
              entry: {
                // SAFETY: both candidates are `PDFDict` at runtime, as above.
                container: (stream.ref === null ? page.node : stream.dict) as unknown as PDFDict,
                name: name.value,
                dict: xobjects,
              },
              parent: stream,
              dict: found.dict,
              resources: (() => {
                const own = valueOf(found.dict, 'Resources');
                return own instanceof PDFDict ? own : stream.resources;
              })(),
              invocations: 0,
              depth: stream.depth + 1,
            };
            byKey.set(key, inner);
            streams.push(inner);
          }
          inner.invocations += 1;
          const matrixValues = numbersFrom(found.dict, 'Matrix');
          const matrix: Matrix =
            matrixValues.length === 6
              ? [
                  matrixValues[0],
                  matrixValues[1],
                  matrixValues[2],
                  matrixValues[3],
                  matrixValues[4],
                  matrixValues[5],
                ]
              : IDENTITY;
          path.add(key);
          visit(inner, multiply(ctm, matrix));
          path.delete(key);
          break;
        }
        default:
          break;
      }
      if (record) {
        fillAtOp[index] = fill;
        stateAtOp[index] = { font, size, x: tm[4], y: tm[5] };
      }

      if (op.name === 'Tj' || op.name === "'" || op.name === '"') {
        if (op.name !== 'Tj') {
          tlm = multiply(translate(0, -leading), tlm);
          tm = tlm;
        }
        const value = op.operands.find((o): o is StringOperand => o.kind === 'string');
        if (value) movePen(show(value.bytes, index, false, 0, false));
        continue;
      }
      if (op.name === 'TJ') {
        const array = op.operands.find((o): o is ArrayOperand => o.kind === 'array');
        if (!array) continue;
        const kerned = array.items.some((i) => i.kind === 'number' && i.value !== 0);
        // Each string is its own run, starting where the numbers before it moved
        // the pen. A number after the last string still moves the pen, so the
        // text that follows in the same block keeps its place.
        let pen = 0;
        let moved = false;
        for (const item of array.items) {
          if (item.kind === 'number') {
            if (item.value !== 0) moved = true;
            pen -= (item.value / 1000) * Math.abs(size) * horizontalScale;
            continue;
          }
          if (item.kind !== 'string') continue;
          pen = show(item.bytes, index, kerned, pen, moved);
          moved = false;
        }
        movePen(pen);
      }
    }
  };

  visit(pageStream, IDENTITY);
  // Merge consecutive one-character segments from the same operator: the
  // per-glyph rects above are needed to decide what to remove, but callers
  // want readable runs.
  return {
    segments: mergeSegments(glyphs),
    glyphs,
    streams,
    fillAtOp,
    stateAtOp,
    usesType3,
    rasters,
    truncatedForms,
  };
}

function mergeSegments(segments: TextSegment[]): TextSegment[] {
  const out: TextSegment[] = [];
  for (const segment of segments) {
    const previous = out[out.length - 1];
    if (
      previous &&
      previous.opIndex === segment.opIndex &&
      previous.streamKey === segment.streamKey &&
      previous.font === segment.font &&
      previous.size === segment.size &&
      previous.renderMode === segment.renderMode &&
      !segment.moved &&
      Math.abs(previous.pen.to - segment.pen.from) < 0.01
    ) {
      // One operator, one line: the glyphs are neighbours by construction, so
      // the merged rect is the box around both — which is a diagonal band when
      // the run was turned (a watermark at 45°, a folio on a rotated page).
      const left = Math.min(previous.rect.x, segment.rect.x);
      const bottom = Math.min(previous.rect.y, segment.rect.y);
      const right = Math.max(previous.rect.x + previous.rect.width, segment.rect.x + segment.rect.width);
      const top = Math.max(previous.rect.y + previous.rect.height, segment.rect.y + segment.rect.height);
      const codes = new Uint8Array(previous.codes.length + segment.codes.length);
      codes.set(previous.codes, 0);
      codes.set(segment.codes, previous.codes.length);
      out[out.length - 1] = {
        ...previous,
        text: previous.text + segment.text,
        // Same line by construction: `pen` is contiguous along it.
        baseline: {
          x: (previous.baseline.x + segment.baseline.x) / 2,
          y: (previous.baseline.y + segment.baseline.y) / 2,
        },
        codes,
        rect: { x: left, y: bottom, width: right - left, height: top - bottom },
        kerned: previous.kerned || segment.kerned,
        pen: { from: previous.pen.from, to: segment.pen.to },
      } satisfies TextSegment;
      continue;
    }
    out.push({ ...segment });
  }
  return out;
}

/**
 * The distinct faces a page's own text is set in, including inside forms.
 *
 * `edit-pdf-text` reads these to keep a block in the font the producer used:
 * in-place editing runs on the document that is open, so its font dictionaries —
 * encodings, widths, embedded (often subsetted) files — are all available, and a
 * rewrite that consults them looks like the page instead of like the editor.
 */
export function pageTextFaces(page: PDFPage): SourceFont[] {
  const out: SourceFont[] = [];
  for (const glyph of walkText(page, pageContentOps(page), { forms: true }).glyphs) {
    const source = glyph.fontSource;
    if (source && !out.some((face) => face.dict === source.dict)) out.push(source);
  }
  return out;
}

/**
 * The runs a page paints **inside** `rects`, by the same rule a deletion uses:
 * a glyph belongs to a box when its baseline is in the box, not merely when its
 * em box grazes it. Exported because a leftover check and a deletion have to
 * agree on what "inside this rectangle" means, or a tool reports text it never
 * saw.
 */
export function textInRects(page: PDFPage, rects: ContentRect[]): { rect: ContentRect; text: string }[] {
  const targets = rects.filter((r) => r.width > 0 || r.height > 0);
  if (targets.length === 0) return [];
  const walk = walkText(page, pageContentOps(page), { forms: true });
  const byOp = new Map<string, { texts: string[]; rect: ContentRect }>();
  // One group per contiguous run: a `TJ` number that moved the pen starts a new
  // one, because those glyphs are a different column, not a longer word.
  let runCounter = 0;
  for (const glyph of walk.glyphs) {
    if (!targets.some((rect) => ownsGlyph(glyph, rect))) continue;
    if (glyph.moved) runCounter += 1;
    const key = `${glyph.streamKey}|${glyph.opIndex}|${runCounter}`;
    const known = byOp.get(key);
    if (known) {
      known.texts.push(glyph.text);
      const x0 = Math.min(known.rect.x, glyph.rect.x);
      const y0 = Math.min(known.rect.y, glyph.rect.y);
      known.rect = {
        x: x0,
        y: y0,
        width: Math.max(known.rect.x + known.rect.width, glyph.rect.x + glyph.rect.width) - x0,
        height: Math.max(known.rect.y + known.rect.height, glyph.rect.y + glyph.rect.height) - y0,
      };
      continue;
    }
    byOp.set(key, { texts: [glyph.text], rect: { ...glyph.rect } });
  }
  return [...byOp.values()].map((entry) => ({ rect: entry.rect, text: entry.texts.join('') }));
}

/**
 * Every piece of selectable text on a page with the rectangle it occupies,
 * recovered from `Tm`/`Td`/`TD`/`T*`/`TL`/`Tz` plus `TJ` arrays and the font
 * widths in the page's own resources.
 */
export function textRects(page: PDFPage): { rect: ContentRect; text: string }[] {
  return walkText(page, pageContentOps(page), { forms: true })
    .segments.filter((s) => s.text.length > 0)
    .map(({ rect, text }) => ({ rect, text }));
}

function intersects(a: ContentRect, b: ContentRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/**
 * True when `glyph` is one of the glyphs *of* `rect`: it is painted inside the
 * box horizontally, and its baseline lies within the box's vertical span (plus
 * half a point, because the two come from different measurements of the same
 * line). A run merely passing *through* the box with its baseline in another
 * line is not the box's text, and deleting it would take a neighbour's words.
 */
function ownsGlyph(glyph: TextSegment, rect: ContentRect): boolean {
  const eps = 0.5;
  const inX =
    glyph.rect.x + glyph.rect.width > rect.x &&
    glyph.rect.x < rect.x + rect.width;
  const inY =
    glyph.baseline.y >= rect.y - eps &&
    glyph.baseline.y <= rect.y + rect.height + eps;
  return inX && inY;
}

/**
 * Why a deletion was not a plain, complete one — named, so the caller can say
 * it. `docs/TOOL-CAMPAIGN.md`'s standing rule is that a tool never claims what
 * the bytes contradict, and "covered" is not "removed".
 */
export type RemovalReason =
  /** The run is set in a Type3 font: its glyphs can be dropped, its face cannot be reused. */
  | 'type3-font'
  /** The font carries no widths, so the glyph boxes measured here are estimates. */
  | 'unmeasured-widths'
  /** A real image placement overlaps the region; no operator edit clears pixels. */
  | 'image-behind'
  /** The words live in a Form XObject this page draws more than once. */
  | 'form-reused'
  /** A form sat below the walker's depth limit, so its words were never read. */
  | 'form-too-deep'
  /** A rect matched no text in this page's content at all. */
  | 'nothing-at-rect'
  /** The words are in a form the engine cannot copy without editing others. */
  | 'form-not-copied';

export interface TextRemoval {
  /** Text-showing operators that lost at least one glyph, page and forms alike. */
  removedGlyphRuns: number;
  /** Individual glyph codes dropped. */
  removedGlyphs: number;
  /** Codes kept and re-emitted so their neighbours stay where they were. */
  keptGlyphs: number;
  /** Glyphs still inside the rects afterwards. `0` is the answer that means success. */
  leftover: number;
  /** Rects that found no text in this page's content. */
  unmatchedRects: number;
  /** Forms rewritten in addition to the page's own stream. */
  formsRewritten: number;
  /** True only when measured pixels overlap the region — see `RemovalReason`. */
  needsRasterFallback: boolean;
  reasons: RemovalReason[];
  /**
   * Rects of the glyphs still inside the target after the rewrite, per owner —
   * the exact area a caller must cover when it cannot remove them. Sized to the
   * glyphs, never to the block's box, so a patch hides the words and not the
   * line around them.
   */
  leftoverRects: Record<string, ContentRect[]>;
  /**
   * The faces the deleted runs were set in, per owner.
   *
   * `owners` labels each rect (the text editor names a rect with the block it
   * came from), and an in-place rewrite wants to continue in the document's own
   * font rather than substituting one — the font object is right there in the
   * file being edited, so this is how it reaches the writer.
   */
  faces: Record<string, SourceFont[]>;
}

const NO_REMOVAL: TextRemoval = {
  removedGlyphRuns: 0,
  removedGlyphs: 0,
  keptGlyphs: 0,
  leftover: 0,
  unmatchedRects: 0,
  formsRewritten: 0,
  needsRasterFallback: false,
  reasons: [],
  faces: {},
  leftoverRects: {},
};

/**
 * Permanently delete the glyphs inside `rects`, including words spread across
 * several `BT … ET` blocks and words drawn inside Form XObjects.
 *
 * Kept neighbours survive: a partially covered `Tj` is rewritten as a `TJ`
 * array whose numbers skip the excised glyphs, so the rest of the line stays
 * exactly where it was. Dropping the whole operator instead — which is what this
 * function used to do — is how editing one column silently deleted the column
 * beside it, and how a block that shared an operator with its neighbour came
 * back with both of them missing.
 *
 * A form that another page reaches as well is copied before it is rewritten, so
 * removing a word here does not remove it there.
 */
export function removeTextInRects(
  page: PDFPage,
  rects: ContentRect[],
  options: { owners?: string[] } = {},
): TextRemoval {
  const targets = rects.filter((r) => r.width > 0 || r.height > 0);
  const owners = rects
    .map((rect, index) => ({ rect, owner: options.owners?.[index] ?? '' }))
    .filter((entry) => entry.rect.width > 0 || entry.rect.height > 0);
  if (targets.length === 0) return { ...NO_REMOVAL };
  const walk = walkText(page, pageContentOps(page), { forms: true });
  const streams = new Map(walk.streams.map((stream) => [stream.key, stream]));
  const hits = walk.glyphs.filter((glyph) => owners.some((entry) => ownsGlyph(glyph, entry.rect)));
  // The face each owner's runs were drawn in, so a rewrite can keep it.
  const faces: Record<string, SourceFont[]> = {};
  for (const glyph of hits) {
    const owner = owners.find((entry) => ownsGlyph(glyph, entry.rect))?.owner;
    const source = glyph.fontSource;
    if (!owner || !source) continue;
    const list = faces[owner] ?? (faces[owner] = []);
    if (!list.some((face) => face.dict === source.dict)) list.push(source);
  }
  const reasons = new Set<RemovalReason>();
  if (walk.rasters.some((box) => targets.some((rect) => intersects(box, rect)))) {
    reasons.add('image-behind');
  }
  if (walk.truncatedForms) reasons.add('form-too-deep');
  const unmatchedRects = targets.filter((rect) => !hits.some((glyph) => intersects(glyph.rect, rect))).length;
  if (unmatchedRects > 0) reasons.add('nothing-at-rect');
  if (hits.length === 0) {
    return {
      ...NO_REMOVAL,
      leftover: walk.glyphs.filter(
        (glyph) => glyph.text.trim().length > 0 && targets.some((rect) => ownsGlyph(glyph, rect)),
      ).length,
      unmatchedRects,
      needsRasterFallback: reasons.has('image-behind'),
      reasons: [...reasons],
      faces,
      leftoverRects: rectsByOwner(hits, owners),
    };
  }

  // Every glyph of each affected operator, so a partial cover can be rebuilt.
  const affectedKeys = new Set(hits.map((glyph) => `${glyph.streamKey}|${glyph.opIndex}`));
  const byOp = new Map<string, TextSegment[]>();
  for (const glyph of walk.glyphs) {
    const key = `${glyph.streamKey}|${glyph.opIndex}`;
    if (!affectedKeys.has(key)) continue;
    const list = byOp.get(key);
    if (list) list.push(glyph);
    else byOp.set(key, [glyph]);
  }

  const edits = new Map<string, Map<number, ContentOp[] | null>>();
  const dropped = new Set<TextSegment>();
  for (const glyph of hits) dropped.add(glyph);
  let removedGlyphRuns = 0;
  for (const [key] of byOp) {
    const [streamKey, index] = key.split('|');
    const opIndex = Number(index);
    const stream = streams.get(streamKey);
    const op = stream?.ops[opIndex];
    if (!stream || !op || !TEXT_SHOW_OPS.has(op.name)) continue;
    const rebuild = rebuildShow(op, byOp.get(key) as TextSegment[], dropped);
    removedGlyphRuns += 1;
    const perStream = edits.get(streamKey) ?? new Map<number, ContentOp[] | null>();
    perStream.set(opIndex, rebuild.ops);
    edits.set(streamKey, perStream);
  }

  let keptGlyphs = 0;
  const nextOps = new Map<string, ContentOp[]>();
  for (const [streamKey, perStream] of edits) {
    const stream = streams.get(streamKey) as TextStream;
    const next = stream.ops.flatMap((op, index): ContentOp[] =>
      perStream.has(index) ? (perStream.get(index) ?? []) : [op],
    );
    if (stream.depth === 0) rewritePageContent(page, () => next);
    else {
      nextOps.set(streamKey, next);
      if (stream.invocations > 1) reasons.add('form-reused');
    }
  }
  const forms = commitFormStreams(page, walk.streams, nextOps);
  if (forms.uncopyable.size > 0) reasons.add('form-not-copied');
  const formsRewritten = forms.rewritten;
  const removedGlyphs = dropped.size;
  for (const list of byOp.values()) keptGlyphs += list.filter((glyph) => !dropped.has(glyph)).length;
  if (hits.some((glyph) => glyph.type3)) reasons.add('type3-font');
  if (hits.some((glyph) => !glyph.measured)) reasons.add('unmeasured-widths');

  // Verify against the bytes that were just written, the way `core/redact` does:
  // a leftover count is the difference between "removed" and "claimed removed".
  const after = walkText(page, pageContentOps(page), { forms: true });
  const leftover = after.glyphs.filter(
    (glyph) => glyph.text.trim().length > 0 && owners.some((entry) => ownsGlyph(glyph, entry.rect)),
  ).length;

  return {
    removedGlyphRuns,
    removedGlyphs,
    keptGlyphs,
    leftover,
    unmatchedRects,
    formsRewritten,
    needsRasterFallback: reasons.has('image-behind'),
    reasons: [...reasons],
    faces,
    leftoverRects: rectsByOwner(after.glyphs, owners),
  };
}

/** Union of each owner's leftover glyph rects, for a patch sized to the words. */
function rectsByOwner(
  glyphs: TextSegment[],
  owners: { rect: ContentRect; owner: string }[],
): Record<string, ContentRect[]> {
  const out: Record<string, ContentRect[]> = {};
  for (const glyph of glyphs) {
    if (glyph.text.trim().length === 0) continue;
    const owner = owners.find((entry) => ownsGlyph(glyph, entry.rect))?.owner;
    if (!owner) continue;
    const list = out[owner] ?? (out[owner] = []);
    const rect = glyph.rect;
    // Grow the owner's box when this glyph touches it: a line of leftover words
    // is one patch, not twenty-two, and the patch still only covers glyphs.
    const known = list.find((entry) => boxesTouch(entry, rect));
    if (known) {
      const x0 = Math.min(known.x, rect.x);
      const y0 = Math.min(known.y, rect.y);
      known.x = x0;
      known.y = y0;
      known.width = Math.max(known.x + known.width, rect.x + rect.width) - x0;
      known.height = Math.max(known.y + known.height, rect.y + rect.height) - y0;
      continue;
    }
    list.push({ ...rect });
  }
  return out;
}

/** Two glyph boxes on the same line, close enough to hide with one patch. */
function boxesTouch(a: ContentRect, b: ContentRect): boolean {
  const rowsOverlap = a.y < b.y + b.height && b.y < a.y + a.height;
  if (!rowsOverlap) return false;
  const gapX = Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width));
  return gapX < Math.max(2, Math.min(a.height, b.height) * 0.5);
}

/**
 * Rebuild one text-showing operator after dropping `dropped` of its glyphs.
 *
 * The survivors are re-emitted as a `TJ` array whose numbers carry every pen
 * move the excision opened up, measured from the glyphs' own pen positions — so
 * the original kerning between kept glyphs, and the displacement a producer used
 * to place a second column, both survive the edit.
 *
 * @returns the operators that replace this one, or `null` for "delete it".
 */
function rebuildShow(op: ContentOp, glyphs: TextSegment[], dropped: Set<TextSegment>): {
  ops: ContentOp[] | null;
} {
  const kept = glyphs.filter((glyph) => !dropped.has(glyph));
  // `'` and `"` move to the next line before showing; the move belongs to the
  // text object, not to the glyphs, so it is kept even when the words are not.
  const lead: ContentOp[] = op.name === "'" || op.name === '"' ? [makeOp('T*')] : [];
  if (glyphs.length === 0) return { ops: lead.length ? lead : null };
  if (kept.length === 0) return { ops: lead.length ? lead : null };
  const items: ContentOperand[] = [];
  let cursor = 0;
  let index = 0;
  while (index < glyphs.length) {
    const glyph = glyphs[index];
    if (dropped.has(glyph)) {
      index += 1;
      continue;
    }
    const gap = glyph.pen.from - cursor;
    if (gap > 0.01) items.push(operand.number(penNumber(gap, glyph.size, glyph.horizontalScale)));
    let bytes: number[] = [];
    let last = glyph;
    while (index < glyphs.length && !dropped.has(glyphs[index])) {
      for (const byte of Array.from(glyphs[index].codes)) bytes.push(byte);
      last = glyphs[index];
      index += 1;
    }
    items.push(operand.hex(new Uint8Array(bytes)));
    cursor = last.pen.to;
  }
  const tail = (glyphs[glyphs.length - 1].pen.to ?? 0) - cursor;
  if (tail > 0.01) {
    const last = glyphs[glyphs.length - 1];
    items.push(operand.number(penNumber(tail, last.size, last.horizontalScale)));
  }
  return { ops: [...lead, makeOp('TJ', [operand.array(items)])] };
}

/**
 * The `TJ` number that moves the pen by `shift` points at this size.
 *
 * `walkText` reads a number as `-n/1000 × Tf × Tz`, so this is that formula
 * inverted; writing anything else would shift the kept words on the next read.
 */
function penNumber(shift: number, size: number, horizontalScale: number): number {
  const em = Math.abs(size) * (horizontalScale || 1);
  if (!(em > 0)) return 0;
  return -Math.round((shift * 1000) / em);
}

/**
 * Copy every form the rewrite touched — and every ancestor it hangs from — and
 * point the page at the copies.
 *
 * The original objects are left alone: a form another page (or another `Do` on
 * this one) draws keeps its own bytes, so removing a word here cannot remove it
 * there. Ancestors are copied because the `/XObject` entry naming a nested form
 * lives in the parent's `/Resources`, and that is the dictionary being repointed.
 *
 * @param nextOps the rewritten operator list per stream, `key` by `streamKey`.
 * @returns the number of streams that carried an edit.
 */
function commitFormStreams(
  page: PDFPage,
  streams: TextStream[],
  nextOps: Map<string, ContentOp[]>,
): { rewritten: number; uncopyable: Set<string> } {
  const context = page.doc.context;
  const copies = new Map<string, PDFRef>();
  const uncopyable = new Set<string>();

  const ensureCopy = (stream: TextStream): PDFRef | null => {
    const known = copies.get(stream.key);
    if (known) return known;
    const source = stream.ref ? context.lookup(stream.ref) : null;
    if (!(source instanceof PDFStream)) {
      // A form written as a direct object: the page names it, but there is no
      // object to copy, so rewriting it would rewrite every other user too.
      uncopyable.add(stream.key);
      return null;
    }
    const ref = context.nextRef();
    const bytes = serialiseContentStream(nextOps.get(stream.key) ?? stream.ops);
    context.assign(ref, formStream(page, source.dict, bytes));
    copies.set(stream.key, ref);
    // The dictionary that names this stream: the page node for a page-level
    // form, or the *copy* of the outer form's dictionary for a nested one, so
    // the repoint never disturbs a form another page still draws.
    const parent = stream.parent && stream.parent.depth > 0 ? stream.parent : null;
    if (stream.parent && stream.parent.depth > 0 && !ensureCopy(stream.parent)) {
      uncopyable.add(stream.key);
      return null;
    }
    const holder = parent ? context.lookup(copies.get(parent.key) as PDFRef) : null;
    // SAFETY: `PDFPageLeaf extends PDFDict`, so the page node answers `get`/`set`
    // for `/Resources` exactly as a form's own dictionary does.
    const container = parent
      ? holder instanceof PDFStream
        ? holder.dict
        : null
      : (page.node as unknown as PDFDict);
    if (container && stream.entry) repointXObject(context, container, stream.entry.name, ref);
    return ref;
  };

  let rewritten = 0;
  for (const stream of streams) {
    if (stream.depth === 0 || !nextOps.has(stream.key)) continue;
    if (ensureCopy(stream)) rewritten += 1;
  }
  return { rewritten, uncopyable };
}

/**
 * A copy of `dict`'s stream holding `bytes`, minus the keys that describe the
 * old encoding (`/Length`, `/Filter`, `/DecodeParms`) so the new ones rule.
 */
function formStream(page: PDFPage, dict: PDFDict, bytes: Uint8Array): PDFRawStream {
  const context = page.doc.context;
  const stream = context.flateStream(bytes, {});
  for (const [key, value] of dict.entries()) {
    if (MECHANICAL_STREAM_KEYS.has(key.asString())) continue;
    stream.dict.set(key, value);
  }
  stream.dict.set(PDFName.of('Length'), PDFNumber.of(stream.contents.length));
  return stream;
}

const MECHANICAL_STREAM_KEYS = new Set(['/Length', '/Filter', '/DecodeParms', '/F', '/FFilter']);

/**
 * Name `ref` at `/XObject` › `name` inside `container`'s `/Resources`, copying
 * `/Resources` and `/XObject` first so a dictionary shared with another page or
 * form is not disturbed.
 */
function repointXObject(context: PDFContext, container: PDFDict, name: string, ref: PDFRef): void {
  const deref = (dict: PDFDict | undefined, key: string): PDFDict | undefined => {
    const raw = dict?.get(PDFName.of(key));
    const value = raw === undefined ? undefined : context.lookup(raw);
    return value instanceof PDFDict ? value : undefined;
  };
  const resources = deref(container, 'Resources');
  const copy = context.obj({});
  if (resources) for (const [key, value] of resources.entries()) copy.set(key, value);
  const xobjects = deref(resources, 'XObject');
  const newXobjects = context.obj({});
  if (xobjects) for (const [key, value] of xobjects.entries()) newXobjects.set(key, value);
  newXobjects.set(PDFName.of(name), ref);
  copy.set(PDFName.of('XObject'), newXobjects);
  container.set(PDFName.of('Resources'), copy);
}

/** A font a page can draw with, as its resources name it. */
export interface PageFontName {
  /** Resource key inside `/Resources/Font`. */
  resource: string;
  /** `/BaseFont`, without the leading slash. */
  baseFont: string;
  /** `/Subtype`: `/Type1`, `/TrueType`, `/Type0`, `/Type3`. */
  subtype: string;
  /** True when a font program travels with the face (embedded, maybe subset). */
  embedded: boolean;
}

/**
 * Every font the page's own resources name, including inherited ones.
 *
 * `edit-pdf-text` reports against this list: a block said to be rewritten "in the
 * document's font" has to appear here, and a face that only the editor could have
 * added shows up as exactly that.
 */
export function pageFontNames(page: PDFPage): PageFontName[] {
  const context = page.doc.context;
  const out: PageFontName[] = [];
  const resources = resourcesDict(page);
  const fonts = resources ? context.lookup(resources.get(PDFName.of('Font'))) : undefined;
  if (!(fonts instanceof PDFDict)) return out;
  for (const [key, value] of fonts.entries()) {
    const dict = context.lookup(value);
    if (!(dict instanceof PDFDict)) continue;
    const descriptor =
      context.lookup(dict.get(PDFName.of('FontDescriptor'))) instanceof PDFDict
        ? (context.lookup(dict.get(PDFName.of('FontDescriptor'))) as PDFDict)
        : undefined;
    const descendant = context.lookup(dict.get(PDFName.of('DescendantFonts')));
    const descendantDict =
      descendant instanceof PDFArray ? (context.lookup(descendant.get(0)) as PDFDict | undefined) : undefined;
    const descendantDescriptor =
      descendantDict && context.lookup(descendantDict.get(PDFName.of('FontDescriptor'))) instanceof PDFDict
        ? (context.lookup(descendantDict.get(PDFName.of('FontDescriptor'))) as PDFDict)
        : undefined;
    const fileKeys = ['FontFile', 'FontFile2', 'FontFile3'] as const;
    const embedded = [descriptor, descendantDescriptor].some(
      (entry) => entry !== undefined && fileKeys.some((key) => entry.get(PDFName.of(key)) !== undefined),
    );
    out.push({
      resource: (key instanceof PDFName ? key.asString() : String(key)).replace(/^\//, ''),
      baseFont: (dict.lookupMaybe(PDFName.of('BaseFont'), PDFName)?.asString() ?? '').replace(/^\//, ''),
      subtype: dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString() ?? '',
      embedded,
    });
  }
  return out;
}

/** A flat filled rectangle the page paints, with the colour it fills. */
export interface PaintedRect {
  rect: ContentRect;
  /** `#rrggbb`, or `null` when the colour space is not one this reads. */
  color: string | null;
}

/**
 * The filled rectangles a page paints, in user space.
 *
 * This is how a cover patch is recognised from the file rather than from intent:
 * `re` followed by a fill operator, with the `rg`/`g`/`k` colour in force and the
 * CTM composed the way a viewer composes it. Text drawn by the editor is not in
 * this list, so "no rectangle was painted over the block" is a claim about bytes.
 */
export function pagePatches(page: PDFPage): PaintedRect[] {
  const out: PaintedRect[] = [];
  const walk = (ops: ContentOp[]) => {
    let ctm: Matrix = IDENTITY;
    const stack: Matrix[] = [];
    let pending: ContentRect[] = [];
    let fill: ColorValue = { space: 'gray', value: 0 };
    for (const op of ops) {
      const values = numbersOf(op);
      switch (op.name) {
        case 'q':
          stack.push(ctm);
          break;
        case 'Q':
          ctm = stack.pop() ?? IDENTITY;
          break;
        case 'cm':
          if (values.length >= 6) ctm = multiply(ctm, [values[0], values[1], values[2], values[3], values[4], values[5]]);
          break;
        case 're':
          if (values.length >= 4) {
            const corners = [
              apply(ctm, values[0], values[1]),
              apply(ctm, values[0] + values[2], values[1]),
              apply(ctm, values[0], values[1] + values[3]),
              apply(ctm, values[0] + values[2], values[1] + values[3]),
            ];
            const xs = corners.map((c) => c[0]);
            const ys = corners.map((c) => c[1]);
            pending.push({ x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) });
          }
          break;
        case 'f':
        case 'f*':
        case 'B':
        case 'B*': {
          const rgbColor = toRgb(fill);
          for (const rect of pending) out.push({ rect, color: rgbColor ? toHex(rgbColor) : null });
          pending = [];
          break;
        }
        case 'S':
        case 'n':
          pending = [];
          break;
        case 'g':
        case 'rg':
        case 'k':
          fill = colorFromOp(op, FILL_OPS[op.name]);
          pending = [];
          break;
        default:
          break;
      }
    }
  };
  walk(pageContentOps(page));
  return out;
}

function toHex(color: RGB): string {
  return `#${color.map((channel) => Math.round(channel * 255).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Reword the colour operators that paint text.
 *
 * @param from `#rrggbb` to match the current colour, or `'any'`.
 * @param to   `#rrggbb` to write.
 * @returns the number of operators changed.
 */
export function recolourText(
  page: PDFPage,
  from: string | 'any',
  to: string,
  opts: { bold?: boolean } = {},
): number {
  const target = parseHexColor(to, 'to');
  const match = from === 'any' ? null : parseHexColor(from, 'from');
  const ops = pageContentOps(page);
  const walk = walkText(page, ops);
  const shows: number[] = [];
  ops.forEach((op, index) => {
    if (TEXT_SHOW_OPS.has(op.name)) shows.push(index);
  });
  if (shows.length === 0) return 0;

  // A colour operator paints text when the next text-showing operator comes
  // before any path-painting operator (which would have consumed it).
  const PATH_PAINT = new Set(['f', 'f*', 'F', 'B', 'B*', 'S', 's', 'n', 'W', 'W*']);
  const textColourOps = new Set<number>();
  ops.forEach((op, index) => {
    const isFill = op.name in FILL_OPS;
    const isStroke = op.name in STROKE_OPS;
    if (!isFill && !isStroke) return;
    if (match !== null && !colorsMatch(colorFromOp(op, (isFill ? FILL_OPS : STROKE_OPS)[op.name]), match)) return;
    for (let i = index + 1; i < ops.length; i++) {
      const later = ops[i];
      if (later.name in FILL_OPS || later.name in STROKE_OPS) break;
      if (PATH_PAINT.has(later.name)) break;
      if (isFill && TEXT_SHOW_OPS.has(later.name)) {
        textColourOps.add(index);
        break;
      }
      if (isStroke && TEXT_SHOW_OPS.has(later.name) && walk.segments.some((s) => s.opIndex === i && s.renderMode >= 1)) {
        textColourOps.add(index);
        break;
      }
    }
  });

  const changed = new Set<number>();
  ops.forEach((op, index) => {
    if (!textColourOps.has(index)) return;
    const stroke = op.name in STROKE_OPS;
    ops[index] = colorOps(target, stroke)[0];
    changed.add(index);
  });

  if (opts.bold && changed.size > 0) {
    // Faux bold: fill then stroke the same colour. `Tr` is text state, so it
    // goes inside the text block, right after the colour operator.
    const insertions: { at: number; op: ContentOp }[] = [];
    for (const index of changed) {
      const snapshot = walk.stateAtOp[index];
      const width = Math.max(0.15, (snapshot?.size ?? 10) * 0.02);
      insertions.push({ at: index + 1, op: makeOp('w', [operand.number(Number(width.toFixed(3)))]) });
      insertions.push({ at: index + 2, op: makeOp('Tr', [operand.number(2)]) });
    }
    insertions.sort((a, b) => b.at - a.at);
    for (const insertion of insertions) ops.splice(insertion.at, 0, insertion.op);
  }

  if (changed.size === 0) return 0;
  const before = pageContentOps(page);
  return rewritePageContent(page, () => ops.map((op, i) => (i < before.length ? op : op)).concat(ops.length > before.length ? [] : []));
}

/** Convert every colour operator on a page to DeviceGray. */
export function greyscalePage(page: PDFPage): number {
  const before = pageContentOps(page);
  return rewritePageContent(page, (ops) => {
    let converted = 0;
    const out = ops.map((op) => {
      const fillKind = FILL_OPS[op.name];
      const strokeKind = STROKE_OPS[op.name];
      const kind = fillKind ?? strokeKind;
      if (!kind || kind === 'gray') return op;
      const rgbValue = toRgb(colorFromOp(op, kind));
      if (!rgbValue) return op;
      converted++;
      const grey = luminance(rgbValue);
      return makeOp(fillKind ? 'g' : 'G', [operand.number(Number(grey.toFixed(5)))]);
    });
    return converted > 0 ? out : before;
  });
}

/** True when the page paints with a colour that is not already grey. */
export function pageUsesColor(page: PDFPage): boolean {
  for (const op of pageContentOps(page)) {
    const fillKind = FILL_OPS[op.name];
    const strokeKind = STROKE_OPS[op.name];
    const kind = fillKind ?? strokeKind;
    if (!kind || kind === 'gray') continue;
    const rgbValue = toRgb(colorFromOp(op, kind));
    if (!rgbValue) continue;
    if (!rgbValue.every((value) => Math.abs(value - rgbValue[0]) < 0.5 / 255)) return true;
    if (kind === 'cmyk') {
      const [c, m, y] = numbersOf(op);
      if ((c ?? 0) > 0 || (m ?? 0) > 0 || (y ?? 0) > 0) return true;
    }
  }
  return false;
}

/**
 * Paint `color` over the whole of `rect` **before** the page's own content, as
 * a tagged background artifact so assistive technology and reflow tools ignore
 * it. The original content streams are not rewritten: the artifact goes into
 * a new stream at the head of `/Contents`.
 */
export function prependBackground(page: PDFPage, rect: ContentRect, color: string): void {
  const rgbValue = parseHexColor(color, 'color');
  const bbox = [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height].map((n) => Number(n.toFixed(4)));
  const properties = operand.dict([
    ['Type', operand.name('Artifact')],
    ['Subtype', operand.name('Background')],
    ['BBox', operand.array(bbox.map((n) => operand.number(n)))],
    ['Attached', operand.array(['/Top', '/Bottom', '/Left', '/Right'].map((n) => operand.name(n)))],
  ]);
  const grey = luminance(rgbValue);
  const isGrey = rgbValue.every((value) => Math.abs(value - grey) < 0.5 / 255);
  const colourOps: ContentOp[] = isGrey
    ? [makeOp('g', [operand.number(Number(grey.toFixed(5)))])]
    : [makeOp('rg', rgbValue.map((value) => operand.number(Number(value.toFixed(5)))))];

  const ops: ContentOp[] = [
    // Acrobat's own artifact streams put the tag name first; viewers accept
    // either order, and the contract specifies this one verbatim.
    makeOp('BDC', [operand.name('Artifact'), properties]),
    makeOp('q'),
    ...colourOps,
    makeOp('re', [
      operand.number(Number(rect.x.toFixed(4))),
      operand.number(Number(rect.y.toFixed(4))),
      operand.number(Number(rect.width.toFixed(4))),
      operand.number(Number(rect.height.toFixed(4))),
    ]),
    makeOp('f'),
    makeOp('Q'),
    makeOp('EMC'),
  ];

  const clean: ContentOp[] = [];
  for (const op of ops) if (op.name) clean.push(op);
  prependContentOps(page, clean.length ? clean : [makeOp('noop')]);
}

/**
 * Paint one straight, stroked rule on the page in its own coordinates.
 *
 * Written as `x y m` followed by `x y l S` — a real path with a stroke width and
 * colour, so the line survives a save, a print and a re-read by another viewer.
 * `@param from`/`@param to` are page-space points; a caller that places by what
 * the reader sees has to turn them first.
 */
export function strokeLine(
  page: PDFPage,
  from: { x: number; y: number },
  to: { x: number; y: number },
  options: { thickness: number; color: string },
): void {
  const rgbValue = parseHexColor(options.color, 'color');
  const width = Math.max(0.02, options.thickness);
  const point = (value: { x: number; y: number }): ContentOperand[] => [
    operand.number(Number(value.x.toFixed(4))),
    operand.number(Number(value.y.toFixed(4))),
  ];
  appendContentOps(page, [
    makeOp('q'),
    makeOp('w', [operand.number(Number(width.toFixed(4)))]),
    makeOp('RG', rgbValue.map((value) => operand.number(Number(value.toFixed(5))))),
    makeOp('m', point(from)),
    makeOp('l', point(to)),
    makeOp('S', [], { joined: true }),
    makeOp('Q'),
  ]);
}

// ── Document level edits ───────────────────────────────────────────

/** Which resource dictionary an operator's names are looked up in. */
const RESOURCE_OF_OPERATOR: Record<string, 'Font' | 'ExtGState' | 'XObject' | 'ColorSpace' | 'Pattern' | 'Shading'> = {
  Tf: 'Font',
  gs: 'ExtGState',
  Do: 'XObject',
  sc: 'ColorSpace',
  SC: 'ColorSpace',
  scn: 'ColorSpace',
  SCN: 'ColorSpace',
  sh: 'Shading',
};

/**
 * The resource kinds a baked form may use, and how the page adopts one.
 *
 * Colour spaces, patterns and shadings have no `new…` accessor on the page node,
 * so a form that paints with one is left as a real XObject rather than inlined
 * with a name nobody can resolve.
 */
const ADOPTABLE_RESOURCES: Record<string, (page: PDFPage, tag: string, ref: PDFRef) => PDFName> = {
  Font: (page, tag, ref) => page.node.newFontDictionary(tag, ref),
  ExtGState: (page, tag, ref) => page.node.newExtGState(tag, ref),
  XObject: (page, tag, ref) => page.node.newXObject(tag, ref),
};

function bare(value: string): string {
  return value.replace(/^\//, '');
}

/** Move the resources a copied form used onto the page, and say what each became. */
function adoptFormResources(
  page: PDFPage,
  formDict: PDFDict,
  ops: ContentOp[],
): Map<string, string> | undefined {
  const context = page.doc.context;
  const declared = resolveValue(formDict, PDFName.of('Resources'));
  // With no resources of its own a form already drew with the page's names, which
  // stay exactly as valid where the operators are copied to.
  if (!(declared instanceof PDFDict)) return new Map();
  const used = new Set<string>();
  for (const op of ops) {
    const category = RESOURCE_OF_OPERATOR[op.name];
    if (category) used.add(category);
  }
  const renamed = new Map<string, string>();
  for (const category of used) {
    const dict = resolveValue(declared, PDFName.of(category));
    if (!(dict instanceof PDFDict)) continue;
    const adopt = ADOPTABLE_RESOURCES[category];
    if (!adopt) return undefined;
    for (const [name, value] of dict.entries()) {
      const ref = value instanceof PDFRef ? value : context.register(value as PDFObject);
      renamed.set(`${category}/${bare(name.asString())}`, bare(adopt(page, bare(name.asString()), ref).asString()));
    }
  }
  return renamed;
}

/** Rewrite the resource names of an operator list through `renamed`. */
function renameResourceOperands(ops: ContentOp[], renamed: Map<string, string>): ContentOp[] {
  if (renamed.size === 0) return ops;
  return ops.map((op) => {
    const category = RESOURCE_OF_OPERATOR[op.name];
    if (!category) return op;
    let touched = false;
    const operands = op.operands.map((value) => {
      if (value.kind !== 'name') return value;
      const replacement = renamed.get(`${category}/${value.value}`);
      if (!replacement || replacement === value.value) return value;
      touched = true;
      return operand.name(replacement);
    });
    return touched ? makeOp(op.name, operands) : op;
  });
}

/** The numbers of an array entry that may be written directly or indirectly. */
function arrayNumbers(dict: PDFDict, key: string): number[] | undefined {
  const value = resolveValue(dict, PDFName.of(key));
  if (!(value instanceof PDFArray)) return undefined;
  const out: number[] = [];
  for (const entry of value.asArray()) {
    if (!(entry instanceof PDFNumber)) return undefined;
    out.push(entry.asNumber());
  }
  return out;
}

/** Turn the four quarter turns into the matrix pdf-lib's `rotateInPlace` writes. */
function rotateInPlaceMatrix(width: number, height: number, rotation: number): Matrix {
  const angle = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;
  if (angle === 90) return [0, 1, -1, 0, width, 0];
  if (angle === 180) return [-1, 0, 0, -1, width, height];
  if (angle === 270) return [0, -1, 1, 0, 0, height];
  return IDENTITY;
}

/**
 * Copy a form XObject's operators into `page`, drawing what the form drew.
 *
 * A form's operators live in the form's own coordinate system: a viewer moves its
 * `/BBox` to the origin, shrinks it to the unit square, applies `/Matrix`, and
 * then the transform in force where `Do` appears. Baking a field means those
 * words have to end up in the page's own content — selectable, searchable,
 * redactable — so the whole mapping is written as one `cm` that fits the box into
 * `rect`, exactly as a viewer fits an appearance into an annotation `/Rect`.
 *
 * @returns false when the reference is not a form this can copy, so the caller
 * keeps drawing the XObject itself.
 */
export function inlineFormXObject(
  page: PDFPage,
  formRef: PDFRef,
  options: { rect: ContentRect; rotation?: number },
): boolean {
  const context = page.doc.context;
  const stream = context.lookupMaybe(formRef, PDFStream);
  if (!stream) return false;
  if (stream.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString() !== '/Form') return false;
  const ops = parseContentStream(streamBytes(stream));
  if (ops.length === 0) return false;
  const matrix = arrayNumbers(stream.dict, 'Matrix') ?? [1, 0, 0, 1, 0, 0];
  const box = arrayNumbers(stream.dict, 'BBox');
  if (matrix.length !== 6) return false;
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = box ?? [];
  if (box && (box.length !== 4 || x1 <= x0 || y1 <= y0)) return false;
  const renamed = adoptFormResources(page, stream.dict, ops);
  if (!renamed) return false;

  const { rect, rotation = 0 } = options;
  // form space → unit square → the box it is drawn into → turned in place → its
  // corner on the page. `multiply(m, n)` applies `m` first, as a viewer does.
  let placed = multiply(matrix as Matrix, scaleBy(rect.width, rect.height));
  if (box) {
    placed = multiply(multiply(translate(-x0, -y0), scaleBy(1 / (x1 - x0), 1 / (y1 - y0))), placed);
  }
  placed = multiply(placed, rotateInPlaceMatrix(rect.width, rect.height, rotation));
  placed = multiply(placed, translate(rect.x, rect.y));

  appendContentOps(page, [
    makeOp('q'),
    makeOp('cm', placed.map((value) => operand.number(Number(value.toFixed(5))))),
    ...renameResourceOperands(ops, renamed),
    makeOp('Q'),
  ]);
  return true;
}

function dropJavaScriptKeys(dict: PDFDict): number {
  let removed = 0;
  if (dict.has(PDFName.of('AA'))) {
    dict.delete(PDFName.of('AA'));
    removed++;
  }
  if (dict.has(PDFName.of('JavaScript'))) {
    dict.delete(PDFName.of('JavaScript'));
    removed++;
  }
  if (dict.has(PDFName.of('JS'))) {
    // A `/JS` entry only ever lives inside a JavaScript action; drop `/S` with
    // it so no half-an-action dictionary is left behind.
    dict.delete(PDFName.of('JS'));
    if (dict.lookupMaybe(PDFName.of('S'), PDFName)?.asString() === '/JavaScript') dict.delete(PDFName.of('S'));
    removed++;
  }
  return removed;
}

function stripNamesTree(tree: PDFDict | undefined, name: string): number {
  if (!tree) return 0;
  let removed = 0;
  const names = tree.lookupMaybe(PDFName.of('Names'), PDFArray);
  if (names) {
    for (let i = names.size() - 2; i >= 0; i -= 2) {
      const key = names.lookupMaybe(i, PDFName) ?? names.get(i);
      const text = key ? String((key as PDFName).asString?.() ?? (key as { toString(): string }).toString()) : '';
      if (text.replace(/^\//, '') === name) {
        names.remove(i + 1);
        names.remove(i);
        removed++;
      }
    }
  }
  const kids = tree.lookupMaybe(PDFName.of('Kids'), PDFArray);
  if (kids) {
    for (let i = 0; i < kids.size(); i++) {
      const kid = contextOf(kids).lookup(kids.get(i), PDFDict);
      removed += stripNamesTree(kid, name);
    }
  }
  return removed;
}

/**
 * Remove document-level JavaScript: `/JavaScript` and `/JS` in the catalog,
 * `/AA` automatic actions on pages and annotations, and the `/JavaScript`
 * entries of the `/Names` tree. Returns the number of entries removed.
 */
export function stripJavaScript(doc: PDFDocument): number {
  let removed = 0;
  removed += dropJavaScriptKeys(doc.catalog);
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (object instanceof PDFDict) removed += dropJavaScriptKeys(object);
    else if (object instanceof PDFStream) removed += dropJavaScriptKeys(object.dict);
  }
  const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  removed += stripNamesTree(names, 'JavaScript');
  // A name tree whose `Names` array is now empty is dead weight.
  if (names?.get(PDFName.of('JavaScript'))) {
    names.delete(PDFName.of('JavaScript'));
    removed++;
  }
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const annot = contextOf(annots).lookup(annots.get(i), PDFDict);
      if (annot) removed += dropJavaScriptKeys(annot);
    }
  }
  return removed;
}

function countNameTreeEntries(tree: PDFDict | undefined): number {
  if (!tree) return 0;
  const names = tree.lookupMaybe(PDFName.of('Names'), PDFArray);
  if (names) return Math.floor(names.size() / 2);
  const kids = tree.lookupMaybe(PDFName.of('Kids'), PDFArray);
  if (!kids) return 0;
  let total = 0;
  for (let i = 0; i < kids.size(); i++) {
    total += countNameTreeEntries(contextOf(kids).lookup(kids.get(i), PDFDict));
  }
  return total;
}

/**
 * Remove embedded files (`/EmbeddedFiles` name tree and per-page attachments).
 * Returns the number of attachment entries that went away.
 */
export function stripEmbeddedFiles(doc: PDFDocument): number {
  let removed = 0;
  const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  const tree = names?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict);
  if (tree) {
    removed += countNameTreeEntries(tree);
    names?.delete(PDFName.of('EmbeddedFiles'));
    if (names && names.entries().length === 0) doc.catalog.delete(PDFName.of('Names'));
  }
  for (const page of doc.getPages()) {
    const perPage = page.node.get(PDFName.of('EmbeddedFiles'));
    if (perPage) {
      const dict = page.doc.context.lookup(perPage as PDFRef, PDFDict);
      removed += Math.max(1, countNameTreeEntries(dict));
      // SAFETY: `delete` is inherited from `PDFDict` on the page node.
      (page.node as unknown as { delete(key: PDFName): boolean }).delete(PDFName.of('EmbeddedFiles'));
    }
  }
  return removed;
}

const VIEWER_PREF_KEYS = [
  'HideToolbar',
  'HideMenubar',
  'HideWindowUI',
  'FitWindow',
  'CenterWindow',
  'DisplayDocTitle',
  'NonFullScreenPageMode',
  'Direction',
  'ViewThumbnail',
  'ViewCL',
  'PrintScaling',
  'Duplex',
  'PickTrayByPDFSize',
  'PrintPageRange',
  'NumCopies',
  'Enforce',
] as const;

/**
 * Write document-level viewer preferences onto the catalog. Booleans stay
 * booleans, numbers stay numbers, and a string becomes a PDF name (so
 * `{ Direction: 'R2L' }` writes `/Direction /R2L`).
 */
export function setViewerPreferences(doc: PDFDocument, prefs: Record<string, unknown>): void {
  const known = new Set<string>(VIEWER_PREF_KEYS);
  const context = doc.context;
  let dict = doc.catalog.lookupMaybe(PDFName.of('ViewerPreferences'), PDFDict);
  if (!dict) {
    dict = PDFDict.withContext(context);
    doc.catalog.set(PDFName.of('ViewerPreferences'), dict);
  }
  for (const [key, value] of Object.entries(prefs ?? {})) {
    if (!known.has(key)) {
      throw new Error(
        `"${key}" is not a PDF viewer preference. Use one of: ${VIEWER_PREF_KEYS.join(', ')}.`,
      );
    }
    if (typeof value === 'boolean') dict.set(PDFName.of(key), context.obj(value));
    else if (typeof value === 'number') dict.set(PDFName.of(key), context.obj(value));
    else if (typeof value === 'string') dict.set(PDFName.of(key), PDFName.of(value.replace(/^\//, '')));
    else if (Array.isArray(value)) {
      const array = PDFArray.withContext(context);
      for (const item of value) {
        if (typeof item === 'number') array.push(context.obj(item));
        else if (typeof item === 'string') array.push(PDFName.of(item.replace(/^\//, '')));
        else if (typeof item === 'boolean') array.push(context.obj(item));
      }
      dict.set(PDFName.of(key), array);
    } else if (value === null || value === undefined) dict.delete(PDFName.of(key));
    else throw new Error(`"${key}" needs a boolean, a number, a name or a list of them.`);
  }
  if (dict.entries().length === 0) doc.catalog.delete(PDFName.of('ViewerPreferences'));
}

/**
 * Count what a document is made of, with **decoded** stream sizes so a caller
 * can tell a big file from a badly compressed one.
 */
export function objectAudit(doc: PDFDocument): {
  objects: number;
  streams: number;
  images: number;
  fonts: number;
  uncompressedBytes: number;
} {
  let objects = 0;
  let streams = 0;
  let images = 0;
  let fonts = 0;
  let uncompressedBytes = 0;
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    objects++;
    if (object instanceof PDFStream) {
      streams++;
      const subtype = object.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString();
      if (subtype === '/Image') images++;
      let bytes: Uint8Array;
      try {
        bytes = streamBytes(object);
      } catch {
        bytes = object.getContents();
      }
      uncompressedBytes += bytes.length;
      continue;
    }
    if (object instanceof PDFDict && object.lookupMaybe(PDFName.of('Type'), PDFName)?.asString() === '/Font') fonts++;
    uncompressedBytes += object.sizeInBytes();
  }
  return { objects, streams, images, fonts, uncompressedBytes };
}

/** Every operator name this module treats as showing text. */
export const TEXT_OPERATORS = [...TEXT_SHOW_OPS];
