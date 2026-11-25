/**
 * A CID-keyed CFF script face embeds its program whole.
 *
 * fontkit's CFF encoder — the subsetter `core/fonts.ts` used for every fetched
 * face — rewrites charstrings the live jsDelivr Noto Sans JP cannot survive:
 * measured on the pre-fix build at :5293, two of the 27 non-Latin characters a
 * Japanese page drew came back with zero ink (MuPDF logs
 * `FT_Load_Glyph(<subset>, 33/35): broken file → cannot render glyph` for those
 * two glyph programs) while every `/ToUnicode` pair stayed perfect — the text
 * extracted and searched fine, the page simply showed blanks. The decision
 * taken from that measurement: a CID-keyed CFF program is no longer subsetted
 * at all. Its `CFF ` table is embedded byte for byte and the codes written are
 * the face's own CIDs, which is exactly how a `/CIDFontType0` looks a glyph up
 * — through the program's `charset`.
 *
 * The fixture is a real slice of that face: 58 glyphs, ROS (Adobe, Identity, 0),
 * 6 font dicts, the source's CID numbering kept (the `、`/`じ`/`日`/`続` CIDs
 * below are fontTools' read of the same charset, and they match the 4.5 MB
 * face's). The full face is too big to commit and its encoder damage needs the
 * full subr structure, so this file pins the DECISION (whole program, CID-keyed
 * codes) — the ink half of the re-measurement is live and reported.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFStream } from '@maxwbh/pdf-lib';
import { fontkit } from '@/lib/pdf/core/doc';
import { streamBytes } from '@/lib/pdf/core/content';
import { embedUnicodeFace } from '@/lib/pdf/core/fonts';

const FIXTURE = new Uint8Array(readFileSync(join(process.cwd(), 'tests/fixtures/cjk-cid-cff.otf')));

/** The fixture's own `CFF ` table, sliced from its sfnt directory. */
function cffTableOf(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < view.getUint16(4); i += 1) {
    const at = 12 + i * 16;
    if (String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]) === 'CFF ') {
      return bytes.subarray(view.getUint32(at + 8), view.getUint32(at + 8) + view.getUint32(at + 12));
    }
  }
  throw new Error('the fixture has no CFF table');
}

const CHARS = '、。かきこしじすでにのはまらキステト先同変換日本続行語';
/** fontTools' read of the fixture's charset: the CID each of these must be coded by. */
const CID_OF: Record<string, number> = { '、': 1397, じ: 1483, 日: 20220, 続: 31112 };

/** Embed the face, show every character on its own row, and hand back the saved doc. */
async function savedWithRange(): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  const font = await embedUnicodeFace(doc, FIXTURE);
  const page = doc.addPage([200, 20 + 16 * [...CHARS].length]);
  [...CHARS].forEach((character, i) => {
    page.drawText(character, { x: 20, y: 10 + i * 16, size: 12, font });
  });
  return PDFDocument.load(await doc.save({ useObjectStreams: false }));
}

interface EmbeddedFace {
  program: Uint8Array;
  programLength1: number;
  descendantSubtype: string;
  cidSystemInfo: string;
  /** code → code point, from `/ToUnicode` */
  codePoints: Map<number, number>;
  /** code → advance, from the descendant's `/W` (any `[first [w…]]` runs) */
  widths: Map<number, number>;
}

function embeddedFace(doc: PDFDocument): EmbeddedFace {
  const context = doc.context;
  const num = (value: unknown): number => {
    const object = value as { number?: unknown; toString?(): string };
    if (typeof object?.number === 'number') return object.number;
    return Number(object?.toString?.() ?? value);
  };
  for (const [, object] of context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) continue;
    if (object.get(PDFName.of('Subtype')) !== PDFName.of('Type0')) continue;
    const descendants = object.get(PDFName.of('DescendantFonts'));
    const descendant = context.lookup((descendants instanceof PDFArray ? descendants.get(0) : descendants) as never) as PDFDict;
    const descriptor = context.lookup(descendant.get(PDFName.of('FontDescriptor')) as never) as PDFDict;
    const fileRef = descriptor.get(PDFName.of('FontFile3'));
    const stream = context.lookup(fileRef as never);
    if (!(stream instanceof PDFStream)) continue;
    const widths = new Map<number, number>();
    const w = descendant.get(PDFName.of('W'));
    if (w instanceof PDFArray) {
      for (let i = 0; i < w.size(); i += 1) {
        const start = num(w.get(i));
        const entry = w.get(i + 1);
        if (!(entry instanceof PDFArray)) continue;
        entry.asArray().forEach((value, k) => widths.set(start + k, num(value)));
        i += 1;
      }
    }
    const codePoints = new Map<number, number>();
    const toUnicode = object.get(PDFName.of('ToUnicode'));
    const cmapStream = context.lookup(toUnicode as never);
    if (cmapStream instanceof PDFStream) {
      const cmap = new TextDecoder('latin1').decode(streamBytes(cmapStream));
      for (const [, from, to] of cmap.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        codePoints.set(parseInt(from, 16), parseInt(to.slice(0, 4), 16));
      }
    }
    return {
      program: streamBytes(stream),
      programLength1: num(stream.dict.get(PDFName.of('Length1'))),
      descendantSubtype: String(descendant.get(PDFName.of('Subtype')) ?? ''),
      cidSystemInfo: String(descendant.get(PDFName.of('CIDSystemInfo')) ?? ''),
      codePoints,
      widths,
    };
  }
  throw new Error('the document embeds no CFF face');
}

/** The embedded program put back into a face-shaped sfnt, the way a reader opens it. */
function programFace(program: Uint8Array): unknown {
  const view = new DataView(FIXTURE.buffer, FIXTURE.byteOffset, FIXTURE.byteLength);
  const entries: { tag: string; data: Uint8Array }[] = [];
  for (let i = 0; i < view.getUint16(4); i += 1) {
    const at = 12 + i * 16;
    const tag = String.fromCharCode(FIXTURE[at], FIXTURE[at + 1], FIXTURE[at + 2], FIXTURE[at + 3]);
    const offset = view.getUint32(at + 8);
    const length = view.getUint32(at + 12);
    entries.push({ tag, data: tag === 'CFF ' ? program : FIXTURE.subarray(offset, offset + length) });
  }
  let size = 12 + entries.length * 16;
  const placed = entries.map((entry) => {
    const at = size;
    size += entry.data.length + ((4 - (entry.data.length % 4)) % 4);
    return { ...entry, offset: at };
  });
  const out = new Uint8Array(size);
  const out32 = new DataView(out.buffer);
  out32.setUint32(0, 0x4f54544f);
  out32.setUint16(4, placed.length);
  placed.forEach((entry, i) => {
    const at = 12 + i * 16;
    for (let k = 0; k < 4; k += 1) out[at + k] = entry.tag.charCodeAt(k);
    out32.setUint32(at + 8, entry.offset);
    out32.setUint32(at + 12, entry.data.length);
    out.set(entry.data, entry.offset);
  });
  return fontkit.create(out);
}

function outlineOf(font: unknown, glyphId: number): string {
  const glyph = (font as { getGlyph(id: number): { path: { commands: unknown[] } } }).getGlyph(glyphId);
  return glyph.path.commands
    .map((command) => {
      const c = command as { command: string; args: number[] };
      return `${c.command}(${(c.args ?? []).map((n) => Math.round(n * 1000) / 1000).join(',')})`;
    })
    .join(' ');
}

describe('a CID-keyed CFF face embeds whole (c3 blocker 2)', () => {
  it('ships the program byte for byte, not a fontkit subset', async () => {
    const face = embeddedFace(await savedWithRange());
    const source = cffTableOf(FIXTURE);
    expect(face.programLength1, 'the stream advertises the whole table').toBe(source.length);
    expect(face.program.length, 'the program is the source table').toBe(source.length);
    expect(Buffer.from(face.program).equals(Buffer.from(source)), 'program bytes differ from the source table').toBe(true);
  });

  it('codes every character with the face’s own CID', async () => {
    const face = embeddedFace(await savedWithRange());
    const byCodePoint = new Map<number, number>();
    for (const [code, codePoint] of face.codePoints) if (!byCodePoint.has(codePoint)) byCodePoint.set(codePoint, code);
    for (const [character, cid] of Object.entries(CID_OF)) {
      const code = byCodePoint.get(character.codePointAt(0) as number);
      expect(code, `${character} was coded`).toBeTypeOf('number');
      // The exact CIDs fontTools reads from this charset (and from the 4.5 MB
      // face it was cut from) — the off-by-one convention of the parsed
      // charset table is pinned here so a future fontkit cannot shift it quietly.
      expect(code, `${character} must be coded by its CID ${cid}`).toBe(cid);
      expect(face.widths.has(cid), `code ${cid} has no width`).toBe(true);
    }
  });

  it('paints the glyph the face holds, for all 27 characters', async () => {
    const face = embeddedFace(await savedWithRange());
    const embedded = programFace(face.program) as { getGlyph(id: number): unknown };
    const source = fontkit.create(FIXTURE) as {
      glyphForCodePoint(cp: number): { id: number };
      getGlyph(id: number): unknown;
      'CFF '?: { topDict?: { charset?: { glyphs?: number[] } } };
    };
    const charset = source['CFF ']?.topDict?.charset?.glyphs;
    expect(charset, 'the fixture is CID-keyed').toBeTruthy();
    for (const character of CHARS) {
      const codePoint = character.codePointAt(0) as number;
      const gid = source.glyphForCodePoint(codePoint).id;
      // The code the page carries is the CID (pinned by the previous test),
      // which a viewer resolves back to this glyph through the program's own
      // charset. With the table embedded untouched that resolution is the
      // face's own, so the outline for the character is the outline the
      // source holds at the same glyph id.
      expect(outlineOf(embedded, gid), character).toBe(outlineOf(source, gid));
    }
  });

  it('labels the descendant as the program’s flavour, with the face’s ROS', async () => {
    const face = embeddedFace(await savedWithRange());
    expect(face.descendantSubtype).toBe('/CIDFontType0');
    expect(face.cidSystemInfo).toContain('Adobe');
    expect(face.cidSystemInfo).toContain('Identity');
  });
});
