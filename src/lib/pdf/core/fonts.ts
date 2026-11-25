/**
 * Unicode-aware text for PDF output.
 *
 * Every text-drawing path in the previous implementation used pdf-lib's
 * WinAnsi standard fonts, so a Cyrillic watermark or a CJK page number threw
 * `WinAnsi cannot encode "…"`. This module picks an embedded font from the
 * script of the text, using the script→font mapping observed in BentoPDF's
 * shipped `freetext-script` chunk, and synthesises bold/italic when the face
 * does not carry the style.
 *
 * Latin / Greek / Cyrillic / Latin-Extended are covered by the Noto Sans TTF
 * vendored in `public/fonts/`, so the common case never needs the network.
 * CJK, Arabic, Hebrew, Thai and Indic faces are fetched lazily from jsDelivr
 * the first time a document actually contains that script, and cached.
 */
import { StandardFonts } from '@maxwbh/pdf-lib';
import type { Color, PDFDocument, PDFFont, PDFPage } from '@maxwbh/pdf-lib';
import { CustomFontEmbedder, PDFFont as PDFFontClass, degrees, rgb } from '@maxwbh/pdf-lib';
import { PDFHexString, PDFContext, PDFRef, PDFString, fontkit, withFontkit } from './doc';

/**
 * The fontkit face behind an embedder. pdf-lib does not export its `Font` and
 * `Subset` types, so they are read off the embedder that holds them.
 */
type Face = CustomFontEmbedder['font'];
type FaceSubset = ReturnType<Face['createSubset']>;

export type RGBColor = ReturnType<typeof rgb>;

export interface TextStyle {
  size: number;
  color?: Color;
  bold?: boolean;
  italic?: boolean;
  fontFamily?: string;
  /** Force a bundled/standard family and skip script detection. */
  exact?: boolean;
}

export interface TextPlacement {
  x: number;
  y: number;
  align?: 'left' | 'center' | 'right';
  width?: number;
  rotation?: number;
  opacity?: number;
  maxWidth?: number;
  lineHeight?: number;
}

interface ScriptFont {
  id: string;
  test: RegExp;
  /** jsDelivr `@expo-google-fonts` TrueType URLs, verified during design. */
  url: string;
  label: string;
}

/**
 * Derived from BentoPDF's shipped `freetext-script-*.js`, which pairs Unicode
 * ranges with platform font stacks. The ranges are reused verbatim; the faces
 * are the subsetted TrueType builds that `@pdf-lib/fontkit` can embed.
 */
export const SCRIPT_FONTS: ScriptFont[] = [
  { id: 'arabic', test: /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/, url: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-arabic/NotoSansArabic_400Regular.ttf', label: 'Noto Sans Arabic' },
  { id: 'hebrew', test: /[\u0590-\u05FF\uFB1D-\uFB4F]/, url: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-hebrew/NotoSansHebrew_400Regular.ttf', label: 'Noto Sans Hebrew' },
  { id: 'devanagari', test: /[\u0900-\u097F]/, url: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-devanagari/NotoSansDevanagari_400Regular.ttf', label: 'Noto Sans Devanagari' },
  { id: 'bengali', test: /[\u0980-\u09FF]/, url: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-bengali/NotoSansBengali_400Regular.ttf', label: 'Noto Sans Bengali' },
  { id: 'tamil', test: /[\u0B80-\u0BFF]/, url: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-tamil/NotoSansTamil_400Regular.ttf', label: 'Noto Sans Tamil' },
  { id: 'telugu', test: /[\u0C00-\u0C7F]/, url: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-telugu/NotoSansTelugu_400Regular.ttf', label: 'Noto Sans Telugu' },
  { id: 'kannada', test: /[\u0C80-\u0CFF]/, url: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-kannada/NotoSansKannada_400Regular.ttf', label: 'Noto Sans Kannada' },
  { id: 'malayalam', test: /[\u0D00-\u0D7F]/, url: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-malayalam/NotoSansMalayalam_400Regular.ttf', label: 'Noto Sans Malayalam' },
  { id: 'thai', test: /[\u0E00-\u0E7F]/, url: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-thai/NotoSansThai_400Regular.ttf', label: 'Noto Sans Thai' },
  { id: 'lao', test: /[\u0E80-\u0EFF]/, url: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-lao/NotoSansLao_400Regular.ttf', label: 'Noto Sans Lao' },
  { id: 'khmer', test: /[\u1780-\u17FF]/, url: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-khmer/NotoSansKhmer_400Regular.ttf', label: 'Noto Sans Khmer' },
  { id: 'myanmar', test: /[\u1000-\u109F]/, url: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-myanmar/NotoSansMyanmar_400Regular.ttf', label: 'Noto Sans Myanmar' },
  { id: 'georgian', test: /[\u10A0-\u10FF]/, url: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-georgian/NotoSansGeorgian_400Regular.ttf', label: 'Noto Sans Georgian' },
  { id: 'armenian', test: /[\u0530-\u058F]/, url: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-armenian/NotoSansArmenian_400Regular.ttf', label: 'Noto Sans Armenian' },
  { id: 'ethiopic', test: /[\u1200-\u137F]/, url: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-ethiopic/NotoSansEthiopic_400Regular.ttf', label: 'Noto Sans Ethiopic' },
  { id: 'jp', test: /[\u3040-\u30FF\u31F0-\u31FF\uFF66-\uFF9F]/, url: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-jp/NotoSansJP_400Regular.ttf', label: 'Noto Sans JP' },
  { id: 'kr', test: /[\uAC00-\uD7AF\u1100-\u11FF]/, url: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-kr/NotoSansKR_400Regular.ttf', label: 'Noto Sans KR' },
  { id: 'sc', test: /[\u4E00-\u9FFF\u3400-\u4DBF]/, url: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-sc/NotoSansSC_400Regular.ttf', label: 'Noto Sans SC' },
  { id: 'tc', test: /[\u3105-\u312F\u31A0-\u31BF]/, url: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-tc/NotoSansTC_400Regular.ttf', label: 'Noto Sans TC' },
];

/** Characters that WinAnsi (the standard PDF fonts) cannot encode. */
const WINANSI_SAFE = /^[\u0000-\u007F\u00A0-\u00FF\u0152\u0153\u0160\u0161\u0178\u017D\u017E\u0192\u02C6\u02DC\u2013\u2014\u2018\u2019\u201A\u201C\u201D\u201E\u2020\u2021\u2022\u2026\u2030\u2039\u203A\u20AC\u2122]*$/;

export function isWinAnsiSafe(text: string): boolean {
  return WINANSI_SAFE.test(text ?? '');
}

/** True when the text needs an embedded Unicode face. */
export function needsUnicodeFont(text: string): boolean {
  return !isWinAnsiSafe(text ?? '');
}

/**
 * The `/Flags` bits of an embedded face.
 *
 * The same reading pdf-lib applies: a viewer uses these to fake a weight or a
 * slant the face does not carry, and to decide whether to substitute it.
 */
function faceFlags(font: Face): number {
  const familyClass = font['OS/2'] ? font['OS/2'].sFamilyClass : 0;
  return (font.post && font.post.isFixedPitch ? 1 : 0)
    | (familyClass >= 1 && familyClass <= 7 ? 2 : 0)
    | 4 // symbolic: an embedded Unicode face may hold characters outside Latin
    | (familyClass === 10 ? 8 : 0)
    | (font.head && font.head.macStyle.italic ? 64 : 0);
}

/** Four hex digits, the width a CID takes in a `/ToUnicode` CMap. */
function cmapHex(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, '0');
}

/** A code point as the UTF-16 units a CMap maps to. */
function utf16Hex(codePoint: number): string {
  if (codePoint <= 0xffff) return cmapHex(codePoint);
  const shifted = codePoint - 0x10000;
  return `${cmapHex(0xd800 + (shifted >> 10))}${cmapHex(0xdc00 + (shifted & 0x3ff))}`;
}

/**
 * A `/ToUnicode` CMap for the codes this module handed out.
 *
 * Blocks are capped at 100 pairs, the most a conforming CMap may put in one
 * `beginbfchar`, and a code is entered once: a CFF face has no map of its own,
 * so every character it cannot spell shares the `.notdef` code and only the first
 * of them can claim it.
 */
function toUnicodeCmap(codes: Map<number, number>): string {
  const byCode = new Map<number, number>();
  for (const [codePoint, code] of codes) if (!byCode.has(code)) byCode.set(code, codePoint);
  const pairs = [...byCode.entries()].map(([code, codePoint]) => `<${cmapHex(code)}> <${utf16Hex(codePoint)}>`);
  const blocks: string[] = [];
  for (let i = 0; i < pairs.length; i += 100) {
    const block = pairs.slice(i, i + 100);
    blocks.push(`${block.length} beginbfchar\n${block.join('\n')}\nendbfchar`);
  }
  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000><FFFF>',
    'endcodespacerange',
    ...blocks,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n');
}

/**
 * The face's outline flavour.
 *
 * pdf-lib and this module used to test `font.cff`, and that property does not
 * exist on the fontkit build `@pdf-lib/fontkit` ships: a face's tables hang off
 * their four-character tags, so the guard never fired and a CFF face was handed
 * to the TrueType path — its charstrings written into `/FontFile2` under a
 * `/CIDFontType2`, which MuPDF refuses outright (`FT_New_Memory_Face: unknown
 * file format`) so a page of Japanese printed nothing while still extracting.
 * All four faces the app fetches for CJK are CFF-flavoured (`OTTO`).
 */
function faceIsCff(font: Face): boolean {
  // SAFETY: fontkit hangs a face's decoded tables off the instance under their
  // four-character tags; pdf-lib's published `Font` type names none of them.
  const tables = font as unknown as { 'CFF '?: unknown; loca?: unknown };
  return Boolean(tables['CFF ']) && !tables.loca;
}

/**
 * Point a subset's CFF header at the index that is really there.
 *
 * A CFF header is four bytes: major, minor, `hdrSize`, then `firstOffset` — the
 * absolute position of the Name INDEX. fontkit's CFF encoder writes `hdrSize = 4`
 * and then a `firstOffset` of 24, while its Name INDEX begins at byte 4: the
 * subset of Noto Sans JP measured `01 00 04 18 00 01 01 01 13 4e 6f 74 6f …`, and
 * the source face it was cut from reads `01 00 04 04` with the same nine bytes
 * after it. FreeType believes the header and rejects the program; fontTools walks
 * the indexes and never looks, which is why a fontTools-clean subset is still an
 * invisible page. Only the fourth byte is touched.
 */
function repairCffHeader(program: Uint8Array): Uint8Array {
  if (program.length < 8 || program[0] !== 1) return program;
  const hdrSize = program[2];
  const firstOffset = program[3];
  if (hdrSize < 4 || hdrSize > 255 || firstOffset === hdrSize) return program;
  // An INDEX is a 16-bit count, then a one-byte offset size in 1..4. The Name
  // INDEX of a font holds at least one name, so that shape at `hdrSize` says
  // where the data begins whatever the header claims.
  const count = (program[hdrSize] << 8) | program[hdrSize + 1];
  const offsetSize = program[hdrSize + 2];
  if (count < 1 || offsetSize < 1 || offsetSize > 4) return program;
  program[3] = hdrSize;
  return program;
}

/** A CID-keyed CFF program ready to embed, and the glyph-id-to-CID map it carries. */
interface WholeCffProgram {
  program: Uint8Array;
  cidOf: (glyphId: number) => number;
  ros: [string, string, number] | null;
}

/**
 * The whole CFF program of a CID-keyed face, with its own CID map.
 *
 * fontkit's CFF encoder rewrites charstrings it cannot round-trip: measured on
 * the live jsDelivr Noto Sans JP, two of the 27 kanji a Japanese page drew came
 * back with **zero ink** — MuPDF's own reader logs
 * `FT_Load_Glyph(<subset>, 33/35): broken file → cannot render glyph` for their
 * subset programs — while most of the rest drifted off the source outline at
 * 150 dpi; every `/ToUnicode` pair stayed perfect, so the text extracted and
 * search found what the page could not show. A CID-keyed CFF is therefore
 * embedded as it stands — the `CFF ` table byte for byte — and the codes
 * written are the face's own CIDs, which is exactly how a `/CIDFontType0`
 * says to look a glyph up: through the program's `charset`. The map is taken
 * from fontkit's own parse (`topDict.charset.glyphs`), which holds one CID
 * per glyph id starting at GID 1 — `.notdef`'s CID 0 is implied — verified
 * against fontTools' read of the same charset for `日`/`じ`/`続`/`、`
 * (20220/1483/31112/1397) and pinned in `tests/pdf/cjk-cff-whole-face.test.ts`.
 * Anything this walk does not fully understand (a non-CID-keyed program, a
 * face whose tables lie) returns null and falls back to the subsetter.
 */
function wholeCffProgram(font: Face, fontData: Uint8Array): WholeCffProgram | null {
  const entry = sfntTables(fontData)?.find((table) => table.tag === 'CFF ');
  if (!entry || entry.length < 4 || entry.offset + entry.length > fontData.length) return null;
  const program = fontData.subarray(entry.offset, entry.offset + entry.length);
  if (program[0] !== 1) return null;
  // SAFETY: fontkit hangs a face's decoded tables and glyph count off the
  // instance under their four-character tags; pdf-lib's published types name
  // none of them, and `string` resolves the SIDs the `ROS` names come from.
  const tables = font as unknown as {
    numGlyphs?: number;
    'CFF '?: {
      isCIDFont?: boolean;
      string?: (sid: number) => string;
      topDict?: { charset?: { glyphs?: number[] }; ROS?: number[] };
    };
  };
  const cff = tables['CFF '];
  const charset = cff?.isCIDFont ? cff.topDict?.charset?.glyphs : undefined;
  const numGlyphs = tables.numGlyphs ?? 0;
  if (!Array.isArray(charset) || charset.length + 1 !== numGlyphs) return null;
  let ros: [string, string, number] | null = null;
  const raw = cff?.topDict?.ROS;
  if (Array.isArray(raw) && raw.length === 3 && cff?.string) {
    try {
      const registry = cff.string(raw[0]);
      const ordering = cff.string(raw[1]);
      if (registry && ordering) ros = [registry, ordering, raw[2]];
    } catch {
      ros = null;
    }
  }
  return {
    program,
    cidOf: (glyphId: number) => (glyphId > 0 ? (charset[glyphId - 1] ?? 0) : 0),
    ros,
  };
}

/** A table record from an sfnt's directory. */
interface SfntTable {
  tag: string;
  offset: number;
  length: number;
}

/** The directory of an uncompressed sfnt, or null when this is not one. */
function sfntTables(bytes: Uint8Array): SfntTable[] | null {
  if (bytes.length < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(0);
  // `ttcf`, `wOFF` and `wOF2` are their own layouts; leave them as they came.
  if (version !== 0x00010000 && version !== 0x74727565 && version !== 0x4f54544f) return null;
  const numTables = view.getUint16(4);
  const tables: SfntTable[] = [];
  for (let i = 0; i < numTables; i += 1) {
    const at = 12 + i * 16;
    if (at + 16 > bytes.length) return null;
    tables.push({
      tag: String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]),
      offset: view.getUint32(at + 8),
      length: view.getUint32(at + 12),
    });
  }
  return tables;
}

/** The checksum an sfnt directory records for a run of bytes, padded to 32 bits. */
function sfntChecksum(bytes: Uint8Array, offset: number, length: number): number {
  let sum = 0;
  for (let i = 0; i < length; i += 4) {
    const at = offset + i;
    const word =
      ((bytes[at] ?? 0) << 24) | ((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0);
    sum = (sum + (word >>> 0)) >>> 0;
  }
  return sum >>> 0;
}

/**
 * Move every glyph record of a TrueType face onto a 4-byte boundary.
 *
 * fontkit's TrueType subsetter copies glyph records verbatim and writes the
 * subset's `loca` in the short form whenever the table fits under 64 KB, which is
 * `loca.preEncode` doing `offsets[i] >>>= 1` — half the byte offset, rounded
 * down. A face whose glyph records start at odd bytes therefore loses one at each
 * of them, and every glyph after the first odd offset is read from the wrong
 * place. Both bundled Noto Sans faces are such a font: `NotoSans-Regular.ttf`
 * holds 2 149 odd glyph offsets (glyph 37 begins at byte 2 641), and its subset
 * came out with `loca[3] = 216` where the `B` record begins at 217 — invisible in
 * MuPDF, pdf.js and fontTools alike, while the text still extracted.
 *
 * Padding the records once, on the way in, is what makes the subsetter's halving
 * exact: every copied length is then a multiple of four, so every subset offset
 * is too. The work is per face and cached with its bytes, and a face that is
 * already aligned — every face this app fetches on demand — is returned as it
 * came.
 */
export function alignTrueTypeGlyphs(bytes: Uint8Array): Uint8Array {
  const tables = sfntTables(bytes);
  if (!tables) return bytes;
  const find = (tag: string) => tables.find((t) => t.tag === tag);
  const head = find('head');
  const maxp = find('maxp');
  const loca = find('loca');
  const glyf = find('glyf');
  if (!head || !maxp || !loca || !glyf) return bytes;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numGlyphs = view.getUint16(maxp.offset + 4);
  const shortLoca = view.getInt16(head.offset + 50) === 0;
  const entries = Math.min(numGlyphs + 1, Math.floor(loca.length / (shortLoca ? 2 : 4)));
  const offsets: number[] = [];
  for (let i = 0; i < entries; i += 1) {
    offsets.push(shortLoca ? view.getUint16(loca.offset + i * 2) * 2 : view.getUint32(loca.offset + i * 4));
  }
  if (offsets.every((offset) => offset % 4 === 0)) return bytes;

  // Rebuild `glyf` with each record padded out to a long word, and `loca` beside
  // it in the long form, which can carry any offset without halving it.
  const records: Uint8Array[] = [];
  const newOffsets: number[] = [];
  let at = 0;
  for (let i = 0; i < numGlyphs; i += 1) {
    const from = offsets[i] ?? glyf.length;
    const to = offsets[i + 1] ?? glyf.length;
    const record = bytes.subarray(glyf.offset + from, glyf.offset + Math.max(from, to));
    newOffsets.push(at);
    records.push(record);
    at += record.length;
    const pad = (4 - (at % 4)) % 4;
    if (pad) {
      records.push(new Uint8Array(pad));
      at += pad;
    }
  }
  newOffsets.push(at);
  const newGlyf = new Uint8Array(at);
  let write = 0;
  for (const record of records) {
    newGlyf.set(record, write);
    write += record.length;
  }
  const newLoca = new Uint8Array(newOffsets.length * 4);
  const locaView = new DataView(newLoca.buffer);
  newOffsets.forEach((offset, i) => locaView.setUint32(i * 4, offset));
  // `head` carries both `indexToLocFormat` (byte 50) and `checkSumAdjustment`
  // (byte 8); the adjustment is recomputed over the whole font at the end.
  const newHead = bytes.slice(head.offset, head.offset + head.length);
  newDataView(newHead).setInt16(50, 1);
  newDataView(newHead).setUint32(8, 0);

  const replaced = new Map<string, Uint8Array>([
    ['glyf', newGlyf],
    ['loca', newLoca],
    ['head', newHead],
  ]);
  const out: { tag: string; data: Uint8Array }[] = tables.map((table) => ({
    tag: table.tag,
    data: replaced.get(table.tag) ?? bytes.subarray(table.offset, table.offset + table.length),
  }));

  let size = 12 + out.length * 16;
  const placed = out.map((entry) => {
    const at = size;
    size += entry.data.length + ((4 - (entry.data.length % 4)) % 4);
    return { ...entry, offset: at };
  });
  const font = new Uint8Array(size);
  const font32 = newDataView(font);
  font32.setUint32(0, view.getUint32(0));
  font32.setUint16(4, placed.length);
  const power = Math.floor(Math.log2(placed.length));
  font32.setUint16(6, 2 ** power * 16);
  font32.setUint16(8, power);
  font32.setUint16(10, placed.length * 16 - 2 ** power * 16);
  placed.forEach((entry, i) => {
    const at = 12 + i * 16;
    for (let k = 0; k < 4; k += 1) font[at + k] = entry.tag.charCodeAt(k);
    font32.setUint32(at + 4, sfntChecksum(entry.data, 0, entry.data.length));
    font32.setUint32(at + 8, entry.offset);
    font32.setUint32(at + 12, entry.data.length);
    font.set(entry.data, entry.offset);
  });
  const head32 = newDataView(placed.find((e) => e.tag === 'head')!.data);
  head32.setUint32(8, (0xb1b0afba - sfntChecksum(font, 0, font.length)) >>> 0);
  return font;
}

/** A `DataView` over a whole `Uint8Array`. */
function newDataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Read a subset out of fontkit's evented stream. */
function encodeSubset(subset: FaceSubset): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const parts: Uint8Array[] = [];
    const stream = subset.encodeStream();
    stream.on('data', (bytes: Uint8Array) => parts.push(bytes));
    stream.on('end', () => {
      let size = 0;
      for (const part of parts) size += part.length;
      const out = new Uint8Array(size);
      let at = 0;
      for (const part of parts) {
        out.set(part, at);
        at += part.length;
      }
      resolve(out);
    });
    // `encodeStream` reports a failed encode on `error`; with no listener that
    // would die as an unhandled event rather than as a message the user sees.
    // SAFETY: fontkit's stream is an event emitter; only the `error` channel is
    // missing from the type pdf-lib publishes for it.
    (stream as unknown as { on(event: 'error', cb: (error: unknown) => void): void })
      .on('error', (error: unknown) => reject(error instanceof Error ? error : new Error(String(error))));
  });
}

/**
 * An embedded face whose codes, widths and `/ToUnicode` map are written here.
 *
 * pdf-lib's own embedder asks fontkit to lay the string out and uses the glyph
 * numbers that come back, so a character the fetched face does not contain lands
 * on glyph 0 (`.notdef`) with no `/ToUnicode` entry at all: the page shows a
 * blank *and* a reader who selects or searches it gets a blank. That is the
 * failure this module exists to prevent, and nothing in the output reveals it.
 *
 * So each code point gets a code of its own, the program goes into the slot its
 * flavour belongs in — `/FontFile2` under a `/CIDToGIDMap`-equipped
 * `/CIDFontType2` for TrueType glyph records, `/FontFile3` `/CIDFontType0C` under
 * a `/CIDFontType0` for CFF charstrings — and the `/ToUnicode` CMap says what
 * every code means. A TrueType code is this font's own number, pointed at the real
 * glyph in the subset or at `.notdef` when the face has none; a CFF code is a CID,
 * because a `/CIDFontType0` reads CIDs through the program's own `charset` and
 * offers nothing to rewrite — in the subset this module builds that charset is
 * spelled identity, and in the whole CID-keyed program it is read from the face
 * (see `wholeCffProgram`). Extraction then returns the text that was drawn
 * whatever the face happened to cover, and the widths come from the same table the
 * viewer paints with.
 */
class UnicodeFaceEmbedder extends CustomFontEmbedder {
  static create(font: Face, fontData: Uint8Array): UnicodeFaceEmbedder {
    return new UnicodeFaceEmbedder(font, fontData);
  }

  /** code point → the character code this font gives it */
  private readonly codes = new Map<number, number>();

  /** character code → the glyph id the embedded program holds for it; index 0 is `.notdef` */
  private readonly glyphs: number[] = [0];

  /** character code → advance width in 1/1000 em */
  private readonly advances: number[] = [0];

  /** fontkit's subsetter, used for TrueType faces and any CFF this module cannot read whole */
  private readonly subset: FaceSubset | null;

  /**
   * A CID-keyed CFF face embeds its program whole, mapped through the program's
   * own `charset` (see `wholeCffProgram`): fontkit's CFF encoder rewrote
   * charstrings FreeType itself refuses — a live Japanese page lost two of its
   * 27 kanji outright (`FT_Load_Glyph … broken file`, zero ink, text still
   * extracting) and most of the rest drifted off the source outline. `null`
   * leaves the face on the subsetter path.
   */
  private readonly whole: WholeCffProgram | null;

  /**
   * Whether the outlines are CFF charstrings rather than TrueType glyph records.
   * It decides which slot the program goes into and what a code means: a
   * `/CIDFontType2` is told by `/CIDToGIDMap`, a `/CIDFontType0` by its own
   * charset, which a subset spells as an identity map.
   */
  private readonly cff: boolean;

  private constructor(font: Face, fontData: Uint8Array) {
    super(font, fontData);
    this.cff = faceIsCff(font);
    this.whole = this.cff ? wholeCffProgram(font, fontData) : null;
    this.subset = this.whole ? null : font.createSubset();
  }

  /** The codes for every character of `text`, allocating the ones it needs. */
  private codesFor(text: string): number[] {
    const out: number[] = [];
    for (const character of text) {
      const codePoint = character.codePointAt(0) as number;
      let code = this.codes.get(codePoint);
      if (code === undefined) {
        // `glyphForCodePoint` answers with `.notdef` when the face has nothing
        // for the character; the code is allocated either way, which is the
        // point of the class.
        const glyph = this.font.glyphForCodePoint(codePoint);
        if (this.whole) {
          code = this.whole.cidOf(glyph.id);
          this.glyphs[code] = glyph.id;
        } else {
          // SAFETY: the constructor builds a subset exactly when there is no whole program.
          const glyphId = (this.subset as FaceSubset).includeGlyph(glyph);
          code = this.cff ? glyphId : this.glyphs.length;
          this.glyphs[code] = glyphId;
        }
        this.advances[code] = glyph.advanceWidth * this.scale;
        this.codes.set(codePoint, code);
      }
      out.push(code);
    }
    return out;
  }

  override encodeText(text: string): PDFHexString {
    return PDFHexString.of(this.codesFor(text).map((code) => cmapHex(code)).join(''));
  }

  override widthOfTextAtSize(text: string, size: number): number {
    let total = 0;
    for (const code of this.codesFor(text)) total += this.advances[code] ?? 0;
    return (total / 1000) * size;
  }

  /**
   * The descendant's `/W`. For a whole CFF the codes are CIDs — sparse, up to
   * 65535 — so only the runs actually assigned are emitted, as PDF's
   * `[ first [ w… ] first2 [ w… ] … ]` form. TrueType and subset-CFF codes are
   * dense from the first allocation, so one contiguous range covers them.
   */
  private widthsArray(): (number | number[])[] {
    if (this.whole) {
      const codes = [...new Set(this.codes.values())].sort((a, b) => a - b);
      const out: (number | number[])[] = [];
      if (codes.length === 0) return [0, []];
      let start = codes[0];
      let run: number[] = [];
      let prev = start - 1;
      for (const code of codes) {
        if (code !== prev + 1) {
          out.push(start, run);
          start = code;
          run = [];
        }
        run.push(Number((this.advances[code] ?? 0).toFixed(3)));
        prev = code;
      }
      if (run.length) out.push(start, run);
      return out;
    }
    return [this.cff ? 0 : 1, this.advances.slice(this.cff ? 0 : 1).map((width) => Number(width.toFixed(3)))];
  }

  override async embedIntoContext(context: PDFContext, ref?: PDFRef): Promise<PDFRef> {
    this.baseFontName = context.addRandomSuffix(this.fontName);
    const target = ref ?? context.nextRef();
    // SAFETY: the constructor builds a subset exactly when there is no whole program.
    const encoded = this.whole
      ? this.whole.program
      : this.cff
        ? repairCffHeader(await encodeSubset(this.subset as FaceSubset))
        : await encodeSubset(this.subset as FaceSubset);
    const { bbox, ascent, descent, capHeight, xHeight, italicAngle } = this.font;
    const fontFileRef = context.register(context.flateStream(encoded, {
      Length1: encoded.length,
      // The program's own type, which is what tells a viewer how to read it.
      ...(this.cff ? { Subtype: 'CIDFontType0C' } : {}),
    }));
    // Two bytes per code: the glyph id the viewer should paint for it. Only a
    // TrueType subset has a map to write; a CFF one is read through its charset.
    let cidToGidRef: PDFRef | undefined;
    if (!this.cff) {
      const cidToGid = new Uint8Array(this.glyphs.length * 2);
      this.glyphs.forEach((glyphId, code) => {
        cidToGid[code * 2] = (glyphId >> 8) & 0xff;
        cidToGid[code * 2 + 1] = glyphId & 0xff;
      });
      cidToGidRef = context.register(context.flateStream(cidToGid));
    }
    const descriptorRef = context.register(context.obj({
      Type: 'FontDescriptor',
      FontName: this.baseFontName,
      Flags: faceFlags(this.font),
      FontBBox: [bbox.minX * this.scale, bbox.minY * this.scale, bbox.maxX * this.scale, bbox.maxY * this.scale],
      ItalicAngle: italicAngle ?? 0,
      Ascent: ascent * this.scale,
      Descent: descent * this.scale,
      CapHeight: (capHeight || ascent) * this.scale,
      XHeight: (xHeight || 0) * this.scale,
      // pdf-lib's own guess: nobody can derive it from the outlines cheaply.
      StemV: 0,
      [this.cff ? 'FontFile3' : 'FontFile2']: fontFileRef,
    }));
    const descendantRef = context.register(context.obj({
      Type: 'Font',
      Subtype: this.cff ? 'CIDFontType0' : 'CIDFontType2',
      BaseFont: this.baseFontName,
      CIDSystemInfo: {
        // The whole program carries its own registry-ordering-supplement; a
        // subset this module writes is Identity by construction.
        Registry: PDFString.of(this.whole?.ros?.[0] ?? 'Adobe'),
        Ordering: PDFString.of(this.whole?.ros?.[1] ?? 'Identity'),
        Supplement: this.whole?.ros?.[2] ?? 0,
      },
      FontDescriptor: descriptorRef,
      // A CFF carries its own CID-to-glyph charset; only TrueType takes the map.
      ...(cidToGidRef ? { CIDToGIDMap: cidToGidRef } : {}),
      W: this.widthsArray(),
    }));
    const toUnicodeRef = context.register(context.flateStream(toUnicodeCmap(this.codes)));
    context.assign(target, context.obj({
      Type: 'Font',
      Subtype: 'Type0',
      BaseFont: this.baseFontName,
      Encoding: 'Identity-H',
      DescendantFonts: [descendantRef],
      ToUnicode: toUnicodeRef,
    }));
    return target;
  }
}

/**
 * Put an embedded face on pdf-lib's list of things to embed when the document is
 * written.
 *
 * `PDFDocument#fonts` is private, and writing to it is the only way to join that
 * pass without re-implementing `embedFont` — which builds its own embedder. The
 * timing matters: by save, every character the document drew has been given a
 * code, so the font is written once with the whole alphabet it needs.
 */
function trackFont(doc: PDFDocument, font: PDFFont): void {
  // SAFETY: `PDFDocument#fonts` is a private field of the class at runtime; this
  // is the list `save()` walks to embed everything the document drew.
  (doc as unknown as { fonts: PDFFont[] }).fonts.push(font);
}

export function detectScript(text: string): ScriptFont | null {
  for (const s of SCRIPT_FONTS) if (s.test.test(text)) return s;
  return null;
}

/** Right-to-left scripts we handle by visual reordering. */
const RTL = /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;

export function isRightToLeft(text: string): boolean {
  return RTL.test(text ?? '');
}

const LOCAL_FACES: Record<string, string> = {
  regular: '/fonts/NotoSans-Regular.ttf',
  bold: '/fonts/NotoSans-Bold.ttf',
};

const fontCache = new Map<string, Promise<Uint8Array>>();
const embeddedCache = new WeakMap<PDFDocument, Map<string, Promise<PDFFont>>>();

/**
 * Resolve a face URL relative to the app base so the GitHub Pages subpath and
 * the custom domain both work (`base: './'` in vite.config.ts).
 */
function assetUrl(path: string): string {
  if (/^https?:/.test(path)) return path;
  const marker = document.baseURI ?? location.href;
  const clean = path.replace(/^\.\//, '').replace(/^\//, '');
  // Local faces live at the site root, not next to the hashed JS bundle.
  try {
    const base = new URL(marker);
    return new URL(`/${clean}`, base).href;
  } catch {
    return clean;
  }
}

/**
 * Why a face file did not arrive, in words the export surface can show as-is:
 * which file, from where, and what the user can actually do. A script face is
 * a one-time CDN download — the sentence says so, and says Latin text never
 * needs it, instead of leaving "Failed to fetch" as the whole diagnosis.
 */
export function fontFetchFailure(url: string, reason: string): string {
  const file = url.split('/').pop() || 'font file';
  let host = '';
  try {
    host = new URL(assetUrl(url)).host;
  } catch {
    host = '';
  }
  const remote = /^https?:/.test(url);
  return (
    `Could not load the ${file} font file${host ? ` from ${host}` : ''} (${reason}). ` +
    (remote
      ? 'This writing system needs one internet connection to fetch its face — once, then the browser caches it; ' +
        'Latin text is written from faces bundled with the app and works offline.'
      : 'The bundled face is missing from the app files; reload the page.')
  );
}

let faceFetchNotice: ((line: string) => void) | null = null;

/**
 * Say what is about to be downloaded, before the wait — the engine path has
 * `engineFetchLine` for exactly this, and a script rewrite that must fetch a
 * multi-megabyte CDN face must not look like a hung tab. The UI installs the
 * sink around an export; `null` takes it away. The document itself never
 * leaves the device, and the line says which direction the bytes go.
 */
export function setFaceFetchNotice(fn: ((line: string) => void) | null): void {
  faceFetchNotice = fn;
}

/** The notice for one fetch attempt of `url`, in the words the log shows. */
export function announceFaceFetch(url: string): void {
  if (!faceFetchNotice) return;
  const label = SCRIPT_FONTS.find((script) => script.url === url)?.label ?? url.split('/').pop() ?? 'font';
  let host = 'the font host';
  try {
    host = new URL(assetUrl(url)).host;
  } catch {
    /* the sentence keeps a generic host when the URL has none */
  }
  faceFetchNotice(
    `Downloading the ${label} face from ${host} — once, then your browser caches it. Your PDF stays on this device.`,
  );
}

async function fetchFontBytes(url: string): Promise<Uint8Array> {
  const key = url;
  let pending = fontCache.get(key);
  if (!pending) {
    announceFaceFetch(url);
    pending = (async () => {
      let res: Response;
      try {
        res = await fetch(assetUrl(url));
      } catch (err) {
        throw new Error(fontFetchFailure(url, err instanceof Error ? err.message : String(err)));
      }
      if (!res.ok) {
        throw new Error(fontFetchFailure(url, `HTTP ${res.status}`));
      }
      // See `alignTrueTypeGlyphs`: the faces this module ships are not aligned the
      // way fontkit's subsetter assumes, and the bytes it is handed are the only
      // place left to say so before the damage is done.
      return alignTrueTypeGlyphs(new Uint8Array(await res.arrayBuffer()));
    })();
    // Drop failures from the cache so a later retry can succeed.
    pending.catch(() => fontCache.delete(key));
    fontCache.set(key, pending);
  }
  return pending;
}

/**
 * Forget the face bytes this module downloaded.
 *
 * A CJK face is several megabytes and the cache holds it for the life of the tab,
 * so this is the one way to hand that memory back. It is also how a test can watch
 * which URLs a conversion really asks for, instead of inheriting a fetch from the
 * run before it.
 */
export function clearFontCache(): void {
  fontCache.clear();
}

export interface FontRequest extends TextStyle {
  text: string;
}

const STANDARD_HELVETICA: Record<string, StandardFonts> = {
  '': StandardFonts.Helvetica,
  b: StandardFonts.HelveticaBold,
  i: StandardFonts.HelveticaOblique,
  bi: StandardFonts.HelveticaBoldOblique,
};

function standardFontFor(bold: boolean, italic: boolean): StandardFonts {
  return STANDARD_HELVETICA[`${bold ? 'b' : ''}${italic ? 'i' : ''}`];
}

/**
 * Embed the font that can render `text`. Standard 14 fonts are preferred for
 * WinAnsi-safe strings because they cost zero bytes in the output file.
 */
export async function getFont(
  doc: PDFDocument,
  request: FontRequest,
): Promise<PDFFont> {
  withFontkit(doc);
  const { text, bold, italic, fontFamily } = request;

  const script = detectScript(text);
  const unicodeNeeded = needsUnicodeFont(text);

  if (!unicodeNeeded && !script && !fontFamily) {
    return doc.embedFont(standardFontFor(Boolean(bold), Boolean(italic)));
  }

  let perDoc = embeddedCache.get(doc);
  if (!perDoc) {
    perDoc = new Map();
    embeddedCache.set(doc, perDoc);
  }

  const faceKey = script
    ? `${script.id}:${bold ? 'b' : ''}${italic ? 'i' : ''}`
    : `noto:${bold ? 'b' : ''}${italic ? 'i' : ''}`;

  const scriptUrl = script ? script.url : bold ? LOCAL_FACES.bold : LOCAL_FACES.regular;
  let pending = perDoc.get(faceKey);
  if (!pending) {
    pending = (async () => {
      const bytes = await fetchFontBytes(scriptUrl);
      return embedUnicodeFace(doc, bytes);
    })();
    pending.catch(() => perDoc?.delete(faceKey));
    perDoc.set(faceKey, pending);
  }
  return pending;
}

/**
 * Embed a face from its bytes through this module's writer, not pdf-lib's.
 *
 * pdf-lib's own embedder asks fontkit to lay the string out (so a character the
 * face lacks silently becomes `.notdef` with nothing in `/ToUnicode`), and
 * `CustomFontEmbedder.isCFF()` tests the same `font.cff` property that does not
 * exist here — hand it a CFF face and it writes one into the TrueType slot. Any
 * caller holding face bytes of unknown flavour should come through this function
 * instead of `doc.embedFont(bytes, { subset: true })`.
 *
 * @param bytes the face as it was fetched; a TrueType face is aligned on the way
 * in, so the subsetter's halved `loca` cannot land a glyph inside the wrong record
 */
export function embedUnicodeFace(doc: PDFDocument, bytes: Uint8Array): Promise<PDFFont> {
  withFontkit(doc);
  const faceBytes = alignTrueTypeGlyphs(bytes);
  const face = fontkit.create(faceBytes) as Face;
  const embedder = UnicodeFaceEmbedder.create(face, faceBytes);
  const font = PDFFontClass.of(doc.context.nextRef(), doc, embedder);
  trackFont(doc, font);
  return Promise.resolve(font);
}

/**
 * Bi-directional text is stored logically in PDF; most viewers do not shape
 * it. For the simple RTL case we reverse the run so it reads correctly in
 * viewers without an ICU bidi engine, matching what lightweight editors do.
 * Base characters and their combining marks stay clustered.
 */
const GRAPHEME_CLUSTER = /\P{M}\p{M}*/gu;

export function prepareTextForDirection(text: string, direction?: 'auto' | 'ltr' | 'rtl'): string {
  const rtl = direction === 'rtl' || (direction !== 'ltr' && isRightToLeft(text));
  if (!rtl) return text;
  const clusters = [...text.matchAll(GRAPHEME_CLUSTER)].map((m) => m[0]);
  return [...clusters].reverse().join('');
}

export interface DrawTextOptions extends TextStyle, TextPlacement {
  text: string;
  direction?: 'auto' | 'ltr' | 'rtl';
  outline?: { color?: Color; width?: number };
  charSpacing?: number;
}

/** Measure a string in points using the font that will actually render it. */
export async function measureText(
  doc: PDFDocument,
  options: DrawTextOptions,
): Promise<{ width: number; font: PDFFont; text: string }> {
  const text = prepareTextForDirection(options.text, options.direction);
  const font = await getFont(doc, { ...options, text });
  return { width: font.widthOfTextAtSize(text, options.size), font, text };
}

/**
 * Draw text with automatic font selection, alignment and optional outline.
 * Returns the advance width so callers can chain runs on the same line.
 */
export async function drawTextU(
  page: PDFPage,
  options: DrawTextOptions,
): Promise<number> {
  const doc = page.doc;
  const { width, font, text } = await measureText(doc, options);
  const size = options.size;
  const align = options.align ?? 'left';
  const boxWidth = options.width ?? width;
  const x =
    align === 'center'
      ? options.x + (boxWidth - width) / 2
      : align === 'right'
        ? options.x + boxWidth - width
        : options.x;

  page.drawText(text, {
    x,
    y: options.y,
    size,
    font,
    color: options.color ?? rgb(0, 0, 0),
    rotate: options.rotation != null ? degrees(options.rotation) : undefined,
    opacity: options.opacity,
    maxWidth: options.maxWidth,
    lineHeight: options.lineHeight,
  });

  if (options.outline && options.outline.width && options.outline.width > 0) {
    page.drawText(text, {
      x,
      y: options.y,
      size,
      font,
      color: options.outline.color ?? rgb(0, 0, 0),
      rotate: options.rotation != null ? degrees(options.rotation) : undefined,
      opacity: options.opacity,
      maxWidth: options.maxWidth,
      lineHeight: options.lineHeight,
    });
  }
  return width;
}

/** Word-wrap `text` into lines that fit `maxWidth`, using the chosen font. */
export async function wrapText(
  doc: PDFDocument,
  text: string,
  style: TextStyle & { maxWidth: number; direction?: 'auto' | 'ltr' | 'rtl' },
): Promise<{ line: string; width: number }[]> {
  const font = await getFont(doc, { ...style, text });
  const lines: { line: string; width: number }[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    if (paragraph === '') {
      lines.push({ line: '', width: 0 });
      continue;
    }
    let current = '';
    for (const word of paragraph.split(/(\s+)/)) {
      const attempt = current + word;
      if (font.widthOfTextAtSize(attempt, style.size) <= style.maxWidth || current === '') {
        current = attempt;
      } else {
        // The whitespace that caused the break belongs to neither line: left at
        // the end of this one it widens the run past the text it shows, and two
        // runs read back as one string come out with a double space in them.
        const line = current.replace(/\s+$/, '');
        lines.push({ line, width: font.widthOfTextAtSize(line, style.size) });
        current = word.replace(/^\s+/, '');
      }
    }
    lines.push({ line: current, width: font.widthOfTextAtSize(current, style.size) });
  }
  return lines;
}

export type { PDFFont };
export const defaultTextColor: RGBColor = rgb(0, 0, 0);