/**
 * What an embedded face actually holds, read back out of the produced bytes.
 *
 * The subsets this module emitted used to carry glyph data that MuPDF, pdf.js
 * and fontTools all failed to read past the second included glyph: `#`, `A` and
 * `4` painted and `B`, `—` and `Z` painted nothing, while the text still
 * extracted normally. The four CJK faces, which are CFF-flavoured, painted
 * nothing at all in MuPDF. Copy-paste, `extractText` and "the file opens" are all
 * blind to that, so every test here asks questions of the saved file:
 *
 *   1. is the program in the slot that names its flavour,
 *   2. is the glyph a viewer is told to paint the glyph the source face holds,
 *      for every character drawn — the headless stand-in for per-glyph ink,
 *   3. do `/W` and `/ToUnicode` cover every code that was written.
 *
 * The failure surface behind these was measured face by face and reader by
 * reader by `docs/research/font-subset-build.mjs` + `-measure.py` + `-pdfjs.mjs`;
 * the numbers are committed as `docs/research/font-subset-before.txt` and
 * `font-subset-after.txt`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFStream } from '@maxwbh/pdf-lib';
import { fontkit } from '@/lib/pdf/core/doc';
import { streamBytes } from '@/lib/pdf/core/content';
import {
  alignTrueTypeGlyphs,
  drawTextU,
  embedUnicodeFace,
  getFont,
  needsUnicodeFont,
} from '@/lib/pdf/core/fonts';

const asset = (path: string): Uint8Array => new Uint8Array(readFileSync(join(process.cwd(), path)));

const NOTO = asset('public/fonts/NotoSans-Regular.ttf');
const NOTO_BOLD = asset('public/fonts/NotoSans-Bold.ttf');
const MONO = asset('public/fonts/jetbrains-mono-400.ttf');
/**
 * A CFF-flavoured OpenType face, built with fontTools and small enough to
 * commit: the four faces the app fetches for CJK are all `OTTO`, and this is the
 * only CFF bytes a test can reach without the network.
 */
const CFF_FACE = asset('tests/fixtures/cff-face.otf');

/** Every face comes off disk; nothing in this file reaches the network. */
const realFetch = globalThis.fetch;

const serveFace: typeof fetch = (async (input: RequestInfo | URL) => {
  const base = decodeURIComponent(String(input).split('/').pop() ?? '');
  const bytes = base.includes('Bold') ? NOTO_BOLD : base.includes('mono') ? MONO : NOTO;
  return new Response(bytes as unknown as BodyInit, { headers: { 'content-type': 'font/ttf' } });
}) as typeof fetch;

beforeAll(() => {
  globalThis.fetch = serveFace;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

/** Punctuation, digits, letters and the accented/Greek/Cyrillic text watermarks use. */
const LATIN_RANGE = [...' ABZ#—0123xyz.,;:/()-+%=@', 'À', 'é', 'ñ', 'ö', 'Š', 'ž', 'Ω', 'Σ', 'α', 'п', 'Ф', 'ю'].join('');
/** The characters `tests/fixtures/cff-face.otf` really holds, plus one it does not. */
const CFF_RANGE = 'AB中Z';

interface FaceSpec {
  id: string;
  bytes: Uint8Array;
  chars: string;
  cff: boolean;
}

const FACES: FaceSpec[] = [
  { id: 'Noto Sans regular', bytes: NOTO, chars: LATIN_RANGE, cff: false },
  { id: 'Noto Sans bold', bytes: NOTO_BOLD, chars: LATIN_RANGE, cff: false },
  { id: 'JetBrains Mono', bytes: MONO, chars: LATIN_RANGE, cff: false },
  { id: 'the CFF fixture', bytes: CFF_FACE, chars: CFF_RANGE, cff: true },
];

/* ── the face, as a reader sees it in the file ─────────────────────────────── */

interface Type0Face {
  baseFont: string;
  descendantSubtype: string;
  programKey: string;
  /** the stream dictionary's `/Subtype`, which is how a CFF program is labelled */
  programSubtype: string;
  program: Uint8Array;
  /** code → glyph id, from `/CIDToGIDMap`; null when the font is Identity */
  cidToGid: ((code: number) => number) | null;
  /** code → code point, from `/ToUnicode` */
  codePoints: Map<number, number>;
  /** code → advance in 1/1000 em, from the descendant's `/W` */
  widths: Map<number, number>;
}

/** Every composite (Type0) font written into a saved document. */
function type0Faces(doc: PDFDocument): Type0Face[] {
  const context = doc.context;
  const streamOf = (value: unknown): PDFStream | undefined => {
    const found = value instanceof PDFName || value === undefined ? undefined : context.lookup(value as never);
    return found instanceof PDFStream ? found : undefined;
  };
  const out: Type0Face[] = [];
  for (const [, object] of context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) continue;
    if (object.get(PDFName.of('Type')) !== PDFName.of('Font')) continue;
    if (object.get(PDFName.of('Subtype')) !== PDFName.of('Type0')) continue;
    const descendants = object.get(PDFName.of('DescendantFonts'));
    const descendantRef = descendants instanceof PDFArray ? descendants.get(0) : descendants;
    const descendant = context.lookup(descendantRef as never) as PDFDict;
    const descriptor = context.lookup(descendant.get(PDFName.of('FontDescriptor')) as never) as PDFDict;
    let programKey = '';
    let programStream: PDFStream | undefined;
    for (const key of ['FontFile2', 'FontFile3', 'FontFile']) {
      const candidate = streamOf(descriptor.get(PDFName.of(key)));
      if (candidate) {
        programKey = key;
        programStream = candidate;
        break;
      }
    }
    if (!programStream) continue;

    const toUnicode = streamOf(object.get(PDFName.of('ToUnicode')));
    const cidToGidStream = streamOf(descendant.get(PDFName.of('CIDToGIDMap')));
    const w = descendant.get(PDFName.of('W'));
    out.push({
      baseFont: String(descendant.get(PDFName.of('BaseFont')) ?? ''),
      descendantSubtype: String(descendant.get(PDFName.of('Subtype')) ?? ''),
      programKey,
      programSubtype: String(programStream.dict.get(PDFName.of('Subtype')) ?? ''),
      program: streamBytes(programStream),
      codePoints: toUnicode ? parseToUnicode(toUnicodeText(toUnicode)) : new Map(),
      widths: w instanceof PDFArray ? parseW(w) : new Map(),
      cidToGid: cidToGidStream
        ? (code: number) => {
            const bytes = streamBytes(cidToGidStream);
            return code * 2 + 1 < bytes.length ? (bytes[code * 2] << 8) | bytes[code * 2 + 1] : 0;
          }
        : null,
    });
  }
  return out;
}

function toUnicodeText(stream: PDFStream): string {
  return new TextDecoder('latin1').decode(streamBytes(stream));
}

/** `<code> <target>` pairs; a target of more than four digits is a UTF-16 pair. */
function parseToUnicode(cmap: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const [, src, dst] of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const bytes = new Uint8Array(dst.length / 2);
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(dst.slice(i * 2, i * 2 + 2), 16);
      const decoded = new TextDecoder('utf-16be').decode(bytes);
      const codePoint = decoded.codePointAt(0);
      if (codePoint !== undefined) out.set(parseInt(src, 16), codePoint);
    }
  }
  return out;
}

/** `/W [ c [ w… ] c2 [ w ] … ]` → code → width. */
function parseW(w: PDFArray): Map<number, number> {
  const num = (value: unknown): number => Number(contextNumber(value));
  const out = new Map<number, number>();
  for (let i = 0; i < w.size(); i += 1) {
    const first = w.get(i);
    const start = num(first);
    const entry = w.get(i + 1);
    if (!(entry instanceof PDFArray)) {
      // The `/DW` form, which this writer does not use; skip the stray number.
      continue;
    }
    for (let k = 0; k < entry.size(); k += 1) out.set(start + k, num(entry.get(k)));
    i += 1;
  }
  return out;
}

function contextNumber(value: unknown): number {
  const object = value as { value?: number; number?: unknown };
  if (typeof object?.value === 'number') return object.value;
  return Number(object);
}

/* ── the glyph a viewer would paint ───────────────────────────────────────── */

/**
 * The outline of one glyph, as the commands and coordinates a viewer draws.
 *
 * Coordinates are what matter, so a composite counts as the paths its components
 * leave on the page, which is what both the subset and the source face resolve.
 */
function outlineOf(font: unknown, glyphId: number): string {
  const glyph = (font as { getGlyph(id: number): { path: { commands: unknown[] } } }).getGlyph(glyphId);
  return glyph.path.commands
    .map((command) => {
      const c = command as { command: string; args: number[] };
      return `${c.command}(${(c.args ?? []).map((n) => Math.round(n * 1000) / 1000).join(',')})`;
    })
    .join(' ');
}

function sourceFace(bytes: Uint8Array): unknown {
  return fontkit.create(bytes) as unknown;
}

/**
 * A subset CFF, put back into a face-shaped sfnt.
 *
 * A `/FontFile3` `/CIDFontType0C` program is a bare CFF table, which no font
 * reader opens on its own — fontkit answers `Unknown font format`. The fixture's
 * own metric tables are kept and only its `CFF ` table is replaced, so the
 * charstrings being read are the subset's.
 */
function faceWithCff(program: Uint8Array): unknown {
  const directory = (bytes: Uint8Array) => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tables = new Map<string, [number, number]>();
    for (let i = 0; i < view.getUint16(4); i += 1) {
      const at = 12 + i * 16;
      tables.set(
        String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]),
        [view.getUint32(at + 8), view.getUint32(at + 12)],
      );
    }
    return tables;
  };
  const entries = [...directory(CFF_FACE).entries()].map(([tag, [offset, length]]) => ({
    tag,
    data: tag === 'CFF ' ? program : CFF_FACE.subarray(offset, offset + length),
  }));
  let size = 12 + entries.length * 16;
  for (const entry of entries) {
    entry.data = entry.data.slice();
    size += entry.data.length + ((4 - (entry.data.length % 4)) % 4);
  }
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x4f54544f);
  view.setUint16(4, entries.length);
  let at = 12 + entries.length * 16;
  entries.forEach((entry, i) => {
    const record = 12 + i * 16;
    for (let k = 0; k < 4; k += 1) out[record + k] = entry.tag.charCodeAt(k);
    view.setUint32(record + 8, at);
    view.setUint32(record + 12, entry.data.length);
    out.set(entry.data, at);
    at += entry.data.length + ((4 - (entry.data.length % 4)) % 4);
  });
  return fontkit.create(out) as unknown;
}

/** The embedded program as a face: a subset TTF opens directly, a subset CFF needs the wrapper. */
function programFace(program: Uint8Array, cff: boolean): unknown {
  return cff ? faceWithCff(program) : sourceFace(program);
}

/** Draw a face's range one character per row and hand back the saved document. */
async function saveRange(spec: FaceSpec): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  const font = await embedUnicodeFace(doc, spec.bytes);
  const page = doc.addPage([300, 30 + 20 * [...spec.chars].length]);
  const chars = [...spec.chars];
  for (let i = 0; i < chars.length; i += 1) {
    page.drawText(chars[i], { x: 20, y: 20 + i * 20, size: 16, font });
  }
  return PDFDocument.load(await doc.save({ useObjectStreams: false }));
}

/* ── the tests ────────────────────────────────────────────────────────────── */

describe('an embedded face, read back out of the file', () => {
  it('puts each flavour in the slot that names it', async () => {
    for (const spec of FACES) {
      const faces = type0Faces(await saveRange(spec));
      expect(faces, spec.id).toHaveLength(1);
      const face = faces[0];
      if (spec.cff) {
        expect(face.programKey, spec.id).toBe('FontFile3');
        expect(face.programSubtype, spec.id).toBe('/CIDFontType0C');
        expect(face.descendantSubtype, spec.id).toBe('/CIDFontType0');
        expect(face.cidToGid, `${spec.id} maps CIDs through its own charset`).toBeNull();
      } else {
        expect(face.programKey, spec.id).toBe('FontFile2');
        expect(face.descendantSubtype, spec.id).toBe('/CIDFontType2');
        expect(face.cidToGid, `${spec.id} needs a CID-to-GID map`).not.toBeNull();
      }
    }
  });

  it('paints the glyph the source face holds, for every character drawn', async () => {
    for (const spec of FACES) {
      const face = type0Faces(await saveRange(spec))[0];
      const subset = programFace(face.program, spec.cff);
      const source = sourceFace(spec.bytes);
      const codesForCp = new Map<number, number>();
      for (const [code, codePoint] of face.codePoints) {
        if (!codesForCp.has(codePoint)) codesForCp.set(codePoint, code);
      }
      for (const character of spec.chars) {
        const codePoint = character.codePointAt(0) as number;
        const code = codesForCp.get(codePoint);
        expect(code, `${spec.id}: ${character} was given no code`).toBeTypeOf('number');
        const glyphId = face.cidToGid ? face.cidToGid(code as number) : (code as number);
        const drawn = outlineOf(subset, glyphId);
        const held = outlineOf(source, (source as { glyphForCodePoint(cp: number): { id: number } })
          .glyphForCodePoint(codePoint).id);
        // A character the face does not hold lands on `.notdef` in both, so this
        // single comparison covers the missing case as well.
        expect(drawn, `${spec.id}: ${character} is not the glyph the face holds`).toBe(held);
      }
    }
  });

  it('carries ink for every character the source face has ink for', async () => {
    for (const spec of FACES) {
      const face = type0Faces(await saveRange(spec))[0];
      const subset = programFace(face.program, spec.cff);
      const source = sourceFace(spec.bytes) as { glyphForCodePoint(cp: number): { id: number; path: { commands: unknown[] } } };
      const codes = new Map<number, number>();
      for (const [code, codePoint] of face.codePoints) if (!codes.has(codePoint)) codes.set(codePoint, code);
      for (const character of spec.chars) {
        if (character === ' ') continue;
        const codePoint = character.codePointAt(0) as number;
        const held = source.glyphForCodePoint(codePoint);
        if (held.path.commands.length === 0) continue;
        const glyphId = face.cidToGid ? face.cidToGid(codes.get(codePoint) as number) : (codes.get(codePoint) as number);
        const drawn = (subset as { getGlyph(id: number): { path: { commands: unknown[] } } }).getGlyph(glyphId);
        // An empty outline here is the blank-page report: text that extracts and
        // paints nothing.
        expect(
          drawn.path.commands.length,
          `${spec.id}: ${character} paints nothing although the face holds it`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('starts every subset glyph record on a long word', async () => {
    for (const spec of FACES.filter((entry) => !entry.cff)) {
      const face = type0Faces(await saveRange(spec))[0];
      const subset = sourceFace(face.program) as {
        loca: { offsets: number[] };
        head: { indexToLocFormat: number };
      };
      const unaligned = subset.loca.offsets.filter((offset) => offset % 4 !== 0);
      expect(unaligned, `${spec.id}: ${unaligned.length} glyph offsets are not a multiple of 4`).toEqual([]);
    }
  });

  it('points the CFF header at the index that is really there', async () => {
    const face = type0Faces(await saveRange(FACES.find((spec) => spec.cff) as FaceSpec))[0];
    const program = face.program;
    expect(program[0], 'a CFF program starts with its major version').toBe(1);
    const hdrSize = program[2];
    // `firstOffset` is the absolute position of the Name INDEX, and the INDEX
    // follows the header. fontkit's subsetter used to write 24 here, which is
    // what made MuPDF answer `unknown file format` for every CJK page.
    expect(program[3], 'firstOffset').toBe(hdrSize);
    const count = (program[hdrSize] << 8) | program[hdrSize + 1];
    const offsetSize = program[hdrSize + 2];
    expect(count, 'the Name INDEX holds the font').toBeGreaterThan(0);
    expect(offsetSize).toBeGreaterThanOrEqual(1);
    expect(offsetSize).toBeLessThanOrEqual(4);
  });

  it('gives every code it wrote a width and a `/ToUnicode` entry', async () => {
    for (const spec of FACES) {
      const face = type0Faces(await saveRange(spec))[0];
      const drawn = [...spec.chars].map((character) => character.codePointAt(0) as number);
      const mapped = new Set(face.codePoints.values());
      for (const codePoint of drawn) {
        expect(mapped.has(codePoint), `${spec.id}: ${String.fromCodePoint(codePoint)} cannot be extracted`).toBe(true);
      }
      for (const code of face.codePoints.keys()) {
        expect(face.widths.has(code), `${spec.id}: code ${code} has no width`).toBe(true);
      }
    }
  });

  it('measures a run with the widths it wrote', async () => {
    for (const spec of FACES) {
      const doc = await PDFDocument.create();
      const font = await embedUnicodeFace(doc, spec.bytes);
      const text = [...spec.chars].slice(0, 12).join('');
      const measured = font.widthOfTextAtSize(text, 14);
      const face = type0Faces(await saveRange(spec))[0];
      const codes = new Map<number, number>();
      for (const [code, codePoint] of face.codePoints) if (!codes.has(codePoint)) codes.set(codePoint, code);
      let fromFile = 0;
      for (const character of text) {
        fromFile += (face.widths.get(codes.get(character.codePointAt(0) as number) as number) ?? 0) * (14 / 1000);
      }
      expect(measured, spec.id).toBeCloseTo(fromFile, 1);
    }
  });
});

describe('alignTrueTypeGlyphs', () => {
  it('moves the bundled faces onto long words', () => {
    for (const bytes of [NOTO, NOTO_BOLD, MONO]) {
      const aligned = alignTrueTypeGlyphs(bytes);
      const font = sourceFace(aligned) as {
        loca: { offsets: number[] };
        head: { indexToLocFormat: number };
        numGlyphs: number;
      };
      expect(font.head.indexToLocFormat, 'the rewritten loca is the long form').toBe(1);
      expect(font.loca.offsets.every((offset) => offset % 4 === 0)).toBe(true);
      const before = sourceFace(bytes) as { numGlyphs: number };
      expect(font.numGlyphs).toBe(before.numGlyphs);
    }
  });

  it('leaves the outlines where it found them', () => {
    const aligned = alignTrueTypeGlyphs(NOTO);
    const before = sourceFace(NOTO) as { glyphForCodePoint(cp: number): { id: number } };
    const after = sourceFace(aligned) as { getGlyph(id: number): unknown };
    for (const codePoint of [...LATIN_RANGE].map((c) => c.codePointAt(0) as number)) {
      const id = before.glyphForCodePoint(codePoint).id;
      expect(outlineOf(after, id), String.fromCodePoint(codePoint)).toBe(
        outlineOf(sourceFace(NOTO) as never, id),
      );
    }
  });

  it('is a no-op on a face that is already aligned, and on a CFF face', () => {
    const once = alignTrueTypeGlyphs(NOTO);
    expect(alignTrueTypeGlyphs(once), 'aligning twice changes nothing').toBe(once);
    expect(alignTrueTypeGlyphs(CFF_FACE), 'a CFF face has no glyph table to move').toBe(CFF_FACE);
  });

  it('keeps every table of the face it rewrites', () => {
    const tags = (bytes: Uint8Array): string[] => {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const out: string[] = [];
      for (let i = 0; i < view.getUint16(4); i += 1) {
        const at = 12 + i * 16;
        out.push(String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]));
      }
      return out.sort();
    };
    expect(tags(alignTrueTypeGlyphs(NOTO))).toEqual(tags(NOTO));
  });
});

describe('which face a run gets', () => {
  it('sends text the standard 14 cannot spell to an embedded Unicode face', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 200]);
    expect(needsUnicodeFont('Страница 1')).toBe(true);
    await drawTextU(page, { text: 'Страница 1 — §', x: 10, y: 100, size: 12 });
    const saved = await PDFDocument.load(await doc.save({ useObjectStreams: false }));
    const faces = type0Faces(saved);
    expect(faces).toHaveLength(1);
    const face = faces[0];
    expect(face.baseFont).toContain('NotoSans');
    // This module hands out its own codes and points them at the subset through a
    // `/CIDToGIDMap` **stream**; pdf-lib's embedder uses `/Identity` and takes its
    // codes from `font.layout()`, which is how a character the face lacks lands on
    // `.notdef` with nothing to extract. The stream is the signature that the run
    // went the way that keeps it readable.
    expect(face.cidToGid, 'the run did not go through this module').not.toBeNull();
    const extracted = new Set(face.codePoints.values());
    for (const character of 'Страница1—§') {
      expect(extracted.has(character.codePointAt(0) as number), character).toBe(true);
    }
    const subset = programFace(face.program, false);
    const source = sourceFace(NOTO) as { glyphForCodePoint(cp: number): { id: number } };
    const byCodePoint = new Map<number, number>();
    for (const [code, codePoint] of face.codePoints) {
      if (!byCodePoint.has(codePoint)) byCodePoint.set(codePoint, code);
    }
    for (const character of 'Страница1—§') {
      const codePoint = character.codePointAt(0) as number;
      const code = byCodePoint.get(codePoint) as number;
      expect(
        outlineOf(subset, face.cidToGid ? face.cidToGid(code) : code),
        `${character} is not the glyph Noto Sans holds`,
      ).toBe(outlineOf(source, source.glyphForCodePoint(codePoint).id));
    }
  });

  it('leaves WinAnsi-safe text on a standard 14 font, which carries no program', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 200]);
    await drawTextU(page, { text: 'Page 1 of 9', x: 10, y: 100, size: 12 });
    const saved = await PDFDocument.load(await doc.save({ useObjectStreams: false }));
    expect(type0Faces(saved)).toEqual([]);
  });

  it('fetches the face a script needs, and fetches it by that script\'s url', async () => {
    const asked: string[] = [];
    const spy = (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return serveFace(input as RequestInfo, undefined);
    }) as typeof fetch;
    globalThis.fetch = spy;
    try {
      const doc = await PDFDocument.create();
      const font = await getFont(doc, { text: 'الصفحة', size: 12 });
      const page = doc.addPage([300, 200]);
      page.drawText('الصفحة', { x: 10, y: 100, size: 12, font });
      const saved = await PDFDocument.load(await doc.save({ useObjectStreams: false }));
      const face = type0Faces(saved)[0];
      expect(asked.some((url) => url.includes('noto-sans-arabic')), `fetched ${asked.join(', ')}`).toBe(true);
      expect(face.programKey).toBe('FontFile2');
      // A face fetched from the network goes through the same alignment as the
      // bundled ones, so its subset cannot inherit the halved-`loca` defect.
      const subset = sourceFace(face.program) as { loca: { offsets: number[] } };
      expect(subset.loca.offsets.every((offset) => offset % 4 === 0)).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
