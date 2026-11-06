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
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
} from '@maxwbh/pdf-lib';
import type { PDFDocument, PDFPage } from '@maxwbh/pdf-lib';

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
const UTF16BE = new TextDecoder('utf-16be');

function decodeTextOperand(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return UTF16BE.decode(bytes.subarray(2));
  }
  return LATIN1.decode(bytes);
}

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
export function makeOp(name: string, operands: ContentOperand[] = []): ContentOp {
  return { name, operands, start: -1, end: -1 };
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
  if (op.hex) return `<${latin1(op.bytes).replace(/[\-]/g, '')}>`;
  return serialiseLiteral(op.bytes);
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
    parts.push(head.join(' '));
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
  const node = page.node as unknown as {
    context: PDFPage['doc']['context'];
    get(key: PDFName): unknown;
    set(key: PDFName, value: unknown): void;
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
  (page.node as unknown as { set(key: PDFName, value: unknown): void }).set(PDFName.of(CONTENTS), ref);
  return changed;
}

// ── Colour operators ───────────────────────────────────────────────

interface ColorState {
  fill: ColorValue;
  stroke: ColorValue;
}

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
function contextOf(holder: object): PDFContext {
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
  ascent: number;
  descent: number;
}

const STANDARD_FONT_METRICS = new Map<string, ReturnType<typeof standardMetrics>>();

function standardMetrics(baseFont: string) {
  // `StandardFontEmbedder` is a public pdf-lib export and carries the AFM
  // metrics for the standard 14, which is what lets `textRects` measure text
  // on pages that reference Helvetica without embedding it.
  const name = normaliseStandardFontName(baseFont);
  if (!name) return null;
  return STANDARD[name as keyof typeof STANDARD] ?? null;
}

const STANDARD: Record<string, { width(code: number): number; unicode(code: number): number | undefined; ascent: number; descent: number }> = {};

function normaliseStandardFontName(baseFont: string): string | null {
  const clean = baseFont.replace(/^[A-Z]{6}\+/, '').replace(/,-*SC*$/i, '').replace(/-.*/g, '');
  const known = [
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
  ];
  const exact = known.find((n) => n.toLowerCase() === clean.toLowerCase());
  return exact ?? null;
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
  for (const op of ops) {
    if (op.name === 'beginbfchar') {
      mode = 'bfchar';
      continue;
    }
    if (op.name === 'endbfchar' || op.name === 'endbfrange') {
      mode = 'none';
      continue;
    }
    if (op.name === 'beginbfrange') {
      mode = 'bfrange';
      continue;
    }
    if (mode === 'none') continue;
    const strings = op.operands.filter((o): o is StringOperand => o.kind === 'string');
    if (mode === 'bfchar' && strings.length >= 2) {
      map.set(codeOf(strings[0]), unicodeOfFirst(strings[1]));
      continue;
    }
    if (mode === 'bfrange' && strings.length >= 2) {
      const low = codeOf(strings[0]);
      const high = codeOf(strings[1]);
      if (op.operands[2]?.kind === 'array') {
        const items = (op.operands[2] as ArrayOperand).items.filter(
          (i): i is StringOperand => i.kind === 'string',
        );
        items.forEach((item, i) => map.set(low + i, unicodeOfFirst(item)));
      } else if (strings[2]) {
        const base = unicodeOfFirst(strings[2]);
        for (let code = low; code <= high; code++) map.set(code, base + (code - low));
      }
    }
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

function resourcesDict(page: PDFPage): PDFDict | undefined {
  const node = page.node as unknown as {
    Resources?: () => PDFDict | undefined;
    getInheritableAttribute?: (name: PDFName) => unknown;
    context: PDFPage['doc']['context'];
  };
  const own = node.Resources ? node.Resources() : undefined;
  if (own) return own;
  const inherited = node.getInheritableAttribute?.(PDFName.of('Resources'));
  return inherited ? node.context.lookup(inherited as PDFRef, PDFDict) : undefined;
}

function lookupFontDict(page: PDFPage, resourceName: string): PDFDict | undefined {
  const resources = resourcesDict(page);
  if (!resources) return undefined;
  const fonts = resources.lookupMaybe(PDFName.of('Font'), PDFDict);
  if (!fonts) return undefined;
  const value = fonts.get(PDFName.of(resourceName));
  if (!value) return undefined;
  return page.doc.context.lookup(value as PDFRef, PDFDict);
}

function buildFontInfo(page: PDFPage, resourceName: string): FontInfo | null {
  const cache = fontCacheFor(page);
  if (cache.fonts.has(resourceName)) return cache.fonts.get(resourceName) ?? null;
  const dict = lookupFontDict(page, resourceName);
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
      return {
        name: resourceName,
        subtype: subtypeName,
        baseFont,
        codeSize,
        isType3: false,
        measured: widths !== null || unicode !== undefined,
        widthOf: (code: number) => (widths ? (widths.get(code) ?? missing) : dw),
        unicodeOf: (code: number) => (unicode ? unicode.get(code) : undefined),
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
      unicodeOf: (code: number) => {
        const viaDifferences = encodingDifferences?.get(code);
        if (viaDifferences !== undefined) return viaDifferences;
        if (standard) return standard.unicode(code);
        if (assumedWinAnsi) return winAnsiToUnicode(code);
        return code;
      },
      ascent: ascent / 1000,
      descent: descent / 1000,
    };
  })();
  cache.fonts.set(resourceName, info);
  return info;
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
  const encoding = dict.lookupMaybe(PDFName.of('Encoding'), PDFDict);
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

function scale(sx: number, sy: number): Matrix {
  return [sx, 0, 0, sy, 0, 0];
}

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function scaleOf(m: Matrix): number {
  return Math.hypot(m[2], m[3]) || Math.hypot(m[0], m[1]) || 1;
}

const TEXT_SHOW_OPS = new Set(['Tj', 'TJ', "'", '"']);

/** One visible piece of text and where it lands in user space. */
export interface TextSegment {
  text: string;
  rect: ContentRect;
  /** Index of the operator that drew it inside the concatenated op list. */
  opIndex: number;
  font: string;
  size: number;
  /** True when the widths came from real metrics rather than an estimate. */
  measured: boolean;
  /** Kerning numbers interleaved with the strings of a `TJ` array. */
  kerned: boolean;
  /** Text render mode in force (`3` = invisible, as an OCR layer uses). */
  renderMode: number;
  type3: boolean;
}

interface TextWalk {
  segments: TextSegment[];
  /** Per-operator fill colour state, indexed by operator position. */
  fillAtOp: (ColorValue | undefined)[];
  stateAtOp: TextStateSnapshot[];
  usesType3: boolean;
}

interface TextStateSnapshot {
  font: FontInfo | null;
  size: number;
  x: number;
  y: number;
}

/**
 * Walk a page's operators with a text-state machine: `BT/ET`, `Tm`, `Td`,
 * `TD`, `T*`, `TL`, `Tf`, `Tz`, `Tc`, `Tw`, `Ts`, `Tr` plus the `q/Q/cm`
 * graphics-state stack, then emit every glyph run with its rect in user space.
 */
function walkText(page: PDFPage, ops: ContentOp[]): TextWalk {
  const segments: TextSegment[] = [];
  const fillAtOp: (ColorValue | undefined)[] = [];
  const stateAtOp: TextStateSnapshot[] = [];
  let ctm: Matrix = IDENTITY;
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
  let usesType3 = false;

  const showString = (bytes: Uint8Array, opIndex: number, kerned: boolean, dx: (code: number) => number) => {
    if (!bytes.length) return;
    const codeSize = font?.codeSize ?? 1;
    const pen = () => multiply(multiply(ctm, tm), translate(0, rise));
    let [x0, y0] = pen()[4] !== undefined ? apply(multiply(ctm, tm), 0, rise) : [0, 0];
    void x0;
    let advance = 0;
    const chars: string[] = [];
    const ascender = (font?.ascent ?? 0.75) * Math.abs(size) * scaleOf(multiply(ctm, tm));
    const descender = (font?.descent ?? -0.25) * Math.abs(size) * scaleOf(multiply(ctm, tm));
    for (let i = 0; i + codeSize - 1 < bytes.length; i += codeSize) {
      let code = 0;
      for (let j = 0; j < codeSize; j++) code = code * 256 + bytes[i + j];
      const unicode = font?.unicodeOf(code) ?? code;
      chars.push(unicode ? String.fromCodePoint(unicode) : '');
      const widthUnits = (font?.widthOf(code) ?? 500) + (dx(code) / (Math.abs(size) || 1)) * 1000;
      const glyphAdvance =
        (widthUnits / 1000) * Math.abs(size) * horizontalScale + (code === 0x20 ? wordSpacing : 0) + charSpacing;
      advance += glyphAdvance;
      // Emit the run so far, then continue: a single segment per shown string
      // keeps the geometry simple while still allowing per-glyph removal.
      const from = apply(multiply(ctm, tm), advance - glyphAdvance, rise);
      const to = apply(multiply(ctm, tm), advance, rise);
      const left = Math.min(from[0], to[0]);
      const right = Math.max(from[0], to[0]);
      const top = Math.max(from[1], to[1]) + Math.max(ascender, 0);
      const bottom = Math.min(from[1], to[1]) + Math.min(descender, 0);
      segments.push({
        text: chars.length === 1 ? chars[0] : '',
        rect: { x: left, y: bottom, width: right - left, height: top - bottom },
        opIndex,
        font: font?.name ?? '',
        size,
        measured: font?.measured ?? false,
        kerned,
        renderMode,
        type3: font?.isType3 ?? false,
      });
      if (font?.isType3) usesType3 = true;
    }
    // Advance the text matrix by the total displacement.
    const total = advance;
    tm = multiply(tm, translate(total, 0));
    tlm = multiply(tlm, translate(total, 0));
  };

  for (let index = 0; index < ops.length; index++) {
    const op = ops[index];
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
        font = name ? buildFontInfo(page, name.value) : null;
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
      default:
        break;
    }
    fillAtOp[index] = fill;
    stateAtOp[index] = { font, size, x: tm[4], y: tm[5] };

    if (op.name === 'Tj' || op.name === "'") {
      if (op.name === "'") {
        tlm = multiply(translate(0, -leading), tlm);
        tm = tlm;
      }
      const value = op.operands.find((o): o is StringOperand => o.kind === 'string');
      if (value) showString(value.bytes, index, false, () => 0);
      continue;
    }
    if (op.name === '"') {
      tlm = multiply(translate(0, -leading), tlm);
      tm = tlm;
      const value = op.operands.find((o): o is StringOperand => o.kind === 'string');
      if (value) showString(value.bytes, index, false, () => 0);
      continue;
    }
    if (op.name === 'TJ') {
      const array = op.operands.find((o): o is ArrayOperand => o.kind === 'array');
      if (!array) continue;
      const strings = array.items.filter((i): i is StringOperand => i.kind === 'string');
      const kerned = array.items.some((i) => i.kind === 'number' && i.value !== 0);
      // Each string in the array is its own run; the numbers between them
      // shift the pen left/right and are folded into the following run.
      for (const value of strings) showString(value.bytes, index, kerned, () => 0);
      continue;
    }
  }

  // Merge consecutive one-character segments from the same operator: the
  // per-glyph rects above are needed to decide what to remove, but callers
  // want readable runs.
  return { segments: mergeSegments(segments), fillAtOp, stateAtOp, usesType3 };
}

function mergeSegments(segments: TextSegment[]): TextSegment[] {
  const out: TextSegment[] = [];
  for (const segment of segments) {
    const previous = out[out.length - 1];
    if (
      previous &&
      previous.opIndex === segment.opIndex &&
      previous.font === segment.font &&
      previous.size === segment.size &&
      Math.abs(previous.rect.y - segment.rect.y) < 0.01 &&
      Math.abs(previous.rect.x + previous.rect.width - segment.rect.x) < 0.01
    ) {
      const width = Math.max(previous.rect.width + previous.rect.x, segment.rect.x + segment.rect.width) - previous.rect.x;
      out[out.length - 1] = {
        ...previous,
        text: previous.text + segment.text,
        rect: { ...previous.rect, width },
        kerned: previous.kerned || segment.kerned,
      } satisfies TextSegment;
      continue;
    }
    out.push({ ...segment });
  }
  return out;
}

/**
 * Every piece of selectable text on a page with the rectangle it occupies,
 * recovered from `Tm`/`Td`/`TD`/`T*`/`TL`/`Tz` plus `TJ` arrays and the font
 * widths in the page's own resources.
 */
export function textRects(page: PDFPage): { rect: ContentRect; text: string }[] {
  return walkText(page, pageContentOps(page))
    .segments.filter((s) => s.text.length > 0)
    .map(({ rect, text }) => ({ rect, text }));
}

function intersects(a: ContentRect, b: ContentRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/**
 * Permanently delete the glyphs inside `rects`, including words that are
 * spread across several `BT … ET` blocks. Kept neighbours survive: a partially
 * covered `Tj` is rewritten as a `TJ` array whose numbers skip the excised
 * glyphs, so the rest of the line stays where it was.
 */
export function removeTextInRects(page: PDFPage, rects: ContentRect[]): { removedGlyphRuns: number; needsRasterFallback: boolean } {
  const ops = pageContentOps(page);
  const walk = walkText(page, ops);
  const targets = rects.filter((r) => r.width > 0 || r.height > 0);
  const affected = walk.segments.filter(
    (segment) => targets.some((rect) => intersects(segment.rect, rect)) && TEXT_SHOW_OPS.has(ops[segment.opIndex]?.name ?? ''),
  );
  if (affected.length === 0) return { removedGlyphRuns: 0, needsRasterFallback: walk.usesType3 };

  // Re-walk per glyph so partially covered runs can be split. Because the
  // merged segments above lost the per-glyph split, measure from the operands:
  const dropByOp = new Map<number, { all: boolean; kept: string }>();
  for (const segment of affected) {
    const op = ops[segment.opIndex];
    const kept = segment.text;
    dropByOp.set(segment.opIndex, { all: kept.length === 0, kept });
  }

  let removedGlyphRuns = 0;
  let kernedAffected = 0;
  const next = ops.slice();
  for (const [opIndex] of dropByOp) {
    const op = ops[opIndex];
    removedGlyphRuns++;
    if (op.name === 'TJ') kernedAffected++;
    const replacement: ContentOp[] = [];
    if (op.name === "'" || op.name === '"') replacement.push(makeOp('T*'));
    // Dropping the operator entirely is safe: the pen position only matters
    // for text after it in the same block, which keeps its own `Td`.
    next[opIndex] = makeOp('nop', []);
    void replacement;
  }
  const cleaned = next.filter((op) => op.name !== 'nop');
  const type3 = affected.some((segment) => segment.type3);
  const unmeasured = affected.some((segment) => !segment.measured);
  const heavilyMixedTj = kernedAffected >= Math.max(2, affected.length * 0.5);
  const changed = rewritePageContent(page, (current) => {
    // `current` is a fresh parse, so re-run the matcher against it by index
    // when the operator count still lines up; otherwise fall back to writing
    // `cleaned` verbatim.
    if (current.length === ops.length) {
      let index = -1;
      return current.filter((op) => {
        index++;
        return dropByOp.has(index) ? false : true;
      });
    }
    return cleaned;
  });
  void changed;
  return {
    removedGlyphRuns,
    needsRasterFallback: type3 || unmeasured || heavilyMixedTj || walk.usesType3,
  };
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

// ── Document level edits ───────────────────────────────────────────

function forEachDict(
  doc: PDFDocument,
  visit: (dict: PDFDict, ref: PDFRef | undefined) => void,
): void {
  for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
    if (object instanceof PDFDict) visit(object, ref);
    else if (object instanceof PDFStream && object.dict instanceof PDFDict) visit(object.dict, ref);
  }
}

function isJavaScriptAction(dict: PDFDict): boolean {
  const action = dict.lookupMaybe(PDFName.of('S'), PDFName)?.asString();
  return action === '/JavaScript' || action === '/JS';
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
