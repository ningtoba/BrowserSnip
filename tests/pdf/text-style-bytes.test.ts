/**
 * Every style control, proven against the bytes it writes.
 *
 * This app has already shipped controls that were wired to a form and not to the
 * pixels — a sticky note's "Text size" that reached no mark, a greyscale segment
 * nobody had ever clicked, a link mark with `area=0` under 1,400 green tests. So a
 * control in the shared text-style model earns its place here by **changing the
 * exported file**, in a way read out of the file rather than asserted about an
 * object:
 *
 * * a family or a posture: the `/BaseFont` of the font the saved appearance names;
 * * a size, a colour, an alignment, a line height: the operators of the saved
 *   `/AP /N` stream (`Tf`, `rg`, `Tm`);
 * * a text that needs a face the standard names cannot spell: the shown operand,
 *   which must not be a row of `3F` bytes.
 *
 * Each case goes through `prepareSpecTexts` — the same call `exportPdf` makes on the
 * document it is about to write — because a `PDFFont` belongs to the document that
 * embedded it, and a test that measured with one document and wrote with another
 * would not be testing the export at all. (That is exactly what it caught the first
 * time this file ran.)
 *
 * The last group is the WYSIWYG claim: the same block laid out against two different
 * documents — the scratch one the preview measures with, the copy being exported —
 * must break in the same places, since a second preview layout is what drifts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from '@maxwbh/pdf-lib';
import { addAnnotations, type AnnotationSpec } from '@/lib/pdf/core/annotations';
import { DEFAULT_FACE_STYLE, defaultFaceStyle, type FaceStyle } from '@/lib/pdf/core/text-style';
import { withFontkit } from '@/lib/pdf/core/doc';
import type { QuadRect } from '@/lib/pdf/core/annotations';
import {
  layoutMarkText,
  measureDocument,
  prepareSpecTexts,
  type MarkTextLayout,
} from '@/components/tools/pdf/editor/textLayout';
import { annotationToSpec, buildAnnotation } from '@/components/tools/pdf/editor/specs';
import { defaultStyleFor } from '@/components/tools/pdf/editor/tools';
import { prepareTextObject } from '@/components/tools/pdf/text-editor/draw';
import {
  DEFAULT_STYLE,
  paragraphsFromText,
  type EditorStyle,
  type TextObject,
} from '@/components/tools/pdf/text-editor/model';
import type { EditorAnnotation, EditorToolId } from '@/components/tools/pdf/editor/types';

const NOTO = new Uint8Array(readFileSync(join(process.cwd(), 'public/fonts/NotoSans-Regular.ttf')));
const NOTO_BOLD = new Uint8Array(readFileSync(join(process.cwd(), 'public/fonts/NotoSans-Bold.ttf')));

/** Serve the vendored faces for any URL `core/fonts` asks for: nothing hits the CDN. */
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const bytes = /Bold/.test(String(input)) ? NOTO_BOLD : NOTO;
    return new Response(bytes as unknown as BodyInit, { headers: { 'content-type': 'font/ttf' } });
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

/** Accented Latin and Japanese: the two places a folded or substituted face shows. */
const LATIN = 'Café naïve — ¼ re-measured';
const CJK = '日本語のテキスト';

const rect: QuadRect = { x: 72, y: 700, width: 240, height: 90 };

const GEOM = {
  pageNumber: 1,
  pageIndex: 0,
  rotation: 0,
  cssWidth: 612,
  cssHeight: 792,
  scale: 1,
  xScale: 1,
  yScale: 1,
  viewport: { width: 612, height: 792 },
} as never;

/** A mark of `tool`, styled exactly as the pen would style it. */
function mark(tool: EditorToolId, over: Partial<EditorAnnotation> = {}): EditorAnnotation {
  const pen = defaultStyleFor(tool);
  const built = buildAnnotation({
    tool,
    page: 0,
    style: { ...pen, text: { ...pen.text, ...(over.textStyle ?? {}) } },
    geom: GEOM,
    drag: { x: 72, y: 20, width: rect.width, height: rect.height },
    text: over.text ?? LATIN,
  })!;
  return { ...built, ...over };
}

interface Written {
  /** The saved appearance stream's operators. */
  ops: string;
  /** Every `/BaseFont` the saved file carries. */
  fonts: string[];
  /** What the export said it could not keep exactly. */
  notes: string[];
}

/**
 * Write a styled mark the way the editor exports one: build the spec from the mark,
 * let `prepareSpecTexts` embed the face and lay the block out **in that document**,
 * then save, reload and read the answer back.
 */
async function writeMark(spec: AnnotationSpec): Promise<Written> {
  const doc = await withFontkit(await PDFDocument.create());
  doc.addPage([612, 792]);
  doc.addPage([612, 792]);
  const notes = await prepareSpecTexts(doc, [spec]);
  addAnnotations(doc, [spec]);
  const back = await PDFDocument.load(await doc.save({ useObjectStreams: false }));
  const annots = back.getPage(0).node.Annots();
  const list = annots ? annots.asArray() : [];
  expect(list.length, 'the annotation did not survive the save').toBe(1);
  const dict = back.context.lookup(list[0] as never) as PDFDict;
  const ap = back.context.lookup((dict.get(PDFName.of('AP')) as PDFDict).get(PDFName.of('N'))) as PDFRawStream;
  const fonts: string[] = [];
  for (const [, object] of back.context.enumerateIndirectObjects()) {
    if (object instanceof PDFDict) {
      const base = object.get(PDFName.of('BaseFont'));
      if (base instanceof PDFName) fonts.push(base.decodeText());
    }
  }
  return { ops: new TextDecoder().decode(decodePDFRawStream(ap).decode()), fonts, notes };
}

const textSpec = (style: FaceStyle, body = LATIN): AnnotationSpec =>
  ({ ...annotationToSpec(mark('freetext', { text: body, textStyle: style })), rect }) as AnnotationSpec;

const stampSpec = (style: FaceStyle, label = 'Approved', box = rect): AnnotationSpec =>
  ({
    ...annotationToSpec(mark('stamp', { text: label, textStyle: style })),
    rect: box,
    stampName: label,
  }) as AnnotationSpec;

/** A box small enough that a 40 pt label cannot fit it. */
const tightStamp: QuadRect = { x: 72, y: 730, width: 120, height: 26 };

/** The baseline of each shown line, top line first. */
function baselinesOf(ops: string): number[] {
  return [...ops.matchAll(/1 0 0 1 [-\d.]+ ([-\d.]+) Tm/g)].map((m) => Number(m[1]));
}

function firstXOf(ops: string): number {
  const m = /1 0 0 1 ([-\d.]+) [-\d.]+ Tm/.exec(ops);
  return m ? Number(m[1]) : Number.NaN;
}

const size = (base: Partial<FaceStyle> = {}): FaceStyle => ({ ...DEFAULT_FACE_STYLE, ...base });

/* ── the text box ───────────────────────────────────────────────────────── */

describe('a text box writes the style it was given', () => {
  it('names the family the model picked, at the posture it asked for', async () => {
    const plain = await writeMark(textSpec(size({ fontFamily: 'std:times' })));
    expect(plain.fonts.join(' ')).toMatch(/Times-Roman/);
    const bold = await writeMark(textSpec(size({ fontFamily: 'std:times', bold: true })));
    expect(bold.fonts.join(' ')).toMatch(/Times-Bold/);
    const slanted = await writeMark(textSpec(size({ fontFamily: 'std:times', italic: true })));
    expect(slanted.fonts.join(' ')).toMatch(/Times-Italic/);
    // Both at once is a fourth real face, not a slant drawn over a bold one.
    const both = await writeMark(textSpec(size({ fontFamily: 'std:courier', bold: true, italic: true })));
    expect(both.fonts.join(' ')).toMatch(/Courier-BoldOblique/);
    // A different family with the same name length draws the same *operators*: what
    // differs is which font `/F1` resolves to, and that is the claim above. A test
    // that only diffed the stream text would pass on a control that changed nothing.
    expect(slanted.fonts).not.toEqual(plain.fonts);
  });

  it('embeds the bundled face as a subset, so a machine without Noto still shows it', async () => {
    const out = await writeMark(textSpec(size({ fontFamily: 'noto' })));
    expect(out.fonts.join(' ')).toMatch(/NotoSans-Regular/);
    expect(out.ops).toMatch(/\/F1 \d+(\.\d+)? Tf/);
  });

  it('keeps Japanese and accented Latin as glyphs instead of question marks', async () => {
    const out = await writeMark(textSpec(size({ fontFamily: 'noto' }), CJK));
    expect(out.fonts.join(' ')).toMatch(/NotoSans-Regular/);
    // A WinAnsi fold puts `?????` in the stream, and that is what a text box used to
    // export. An embedded face writes two bytes per code and no `3F` at all.
    const shown = /<([0-9A-Fa-f]+)>\s*Tj/.exec(out.ops);
    expect(shown, out.ops).not.toBeNull();
    const bytes = shown![1]!.match(/../g) ?? [];
    expect(bytes.length % 2, 'a Type0 face writes two bytes per glyph').toBe(0);
    expect(bytes.filter((pair) => pair.toUpperCase() === '3F')).toHaveLength(0);
    // Latin with accents through the same face keeps its characters.
    const accented = await writeMark(textSpec(size({ fontFamily: 'noto' })));
    expect(accented.notes).toEqual([]);
    expect(accented.ops).toMatch(/Tj/);
  });

  it('writes the size, the colour, the alignment and the line height it was handed', async () => {
    const small = await writeMark(textSpec(size({ size: 11 })));
    const big = await writeMark(textSpec(size({ size: 27 })));
    expect(small.ops).toMatch(/\/F1 11 Tf/);
    expect(big.ops).toMatch(/\/F1 27 Tf/);

    const red = await writeMark(textSpec(size({ color: '#FF0000' })));
    const black = await writeMark(textSpec(size({ color: '#000000' })));
    expect(red.ops).toMatch(/1 0 0 rg/);
    expect(black.ops).toMatch(/0 0 0 rg/);

    // The model's line height is the distance between the baselines in the stream.
    // At 1× a 12 pt line sits `max(size × 1, size + 1)` below the last — the floor
    // `layoutBlock` enforces — and at 2.5× it is 30 points down.
    const body = 'first line\nsecond line';
    const tight = await writeMark(textSpec(size({ lineSpacing: 1 }), body));
    const loose = await writeMark(textSpec(size({ lineSpacing: 2.5 }), body));
    const tightLines = baselinesOf(tight.ops);
    const looseLines = baselinesOf(loose.ops);
    expect(tightLines).toHaveLength(2);
    expect(looseLines).toHaveLength(2);
    expect(Math.abs(tightLines[0]! - tightLines[1]!)).toBeCloseTo(13, 1);
    expect(Math.abs(looseLines[0]! - looseLines[1]!)).toBeCloseTo(30, 1);

    const left = await writeMark(textSpec(size({ align: 'left' }), 'abc'));
    const centre = await writeMark(textSpec(size({ align: 'center' }), 'abc'));
    const right = await writeMark(textSpec(size({ align: 'right' }), 'abc'));
    expect(firstXOf(centre.ops)).toBeGreaterThan(firstXOf(left.ops));
    expect(firstXOf(right.ops)).toBeGreaterThan(firstXOf(centre.ops));
  });
});

/* ── the stamp's label is type too ──────────────────────────────────────── */

describe('a stamp label writes the style it was given', () => {
  it('names the family and the weight, and caps the size at the box', async () => {
    const times = await writeMark(stampSpec({ ...defaultFaceStyle('stamp'), fontFamily: 'std:times' }));
    expect(times.fonts.join(' ')).toMatch(/Times-Bold/);
    const courier = await writeMark(stampSpec({ ...defaultFaceStyle('stamp'), fontFamily: 'std:courier' }));
    expect(courier.fonts.join(' ')).toMatch(/Courier-Bold/);

    const small = await writeMark(stampSpec({ ...defaultFaceStyle('stamp'), size: 8 }));
    expect(small.ops).toMatch(/\/F1 8 Tf/);
    // A label asked for bigger than the box holds is shrunk — and the export says
    // so, rather than letting the number in the inspector be a story.
    const big = await writeMark(stampSpec({ ...defaultFaceStyle('stamp'), size: 40 }, 'Approved', tightStamp));
    const written = Number(/\/F1 ([\d.]+) Tf/.exec(big.ops)![1]);
    expect(written).toBeLessThan(40);
    expect(written).toBeGreaterThan(8);
    expect(big.notes.join(' ')).toMatch(/to fit the box/);
  });

  it('moves the label for the alignment and paints it in the colour asked for', async () => {
    const left = await writeMark(stampSpec({ ...defaultFaceStyle('stamp'), align: 'left' }));
    const centre = await writeMark(stampSpec({ ...defaultFaceStyle('stamp'), align: 'center' }));
    expect(firstXOf(left.ops)).toBeLessThan(firstXOf(centre.ops));
    const green = await writeMark(stampSpec({ ...defaultFaceStyle('stamp'), color: '#00FF00' }));
    expect(green.ops).toMatch(/0 1 0 rg/);
  });
});

/* ── the note keeps only what the format carries ────────────────────────── */

describe('a sticky note carries what PDF can hold', () => {
  it('writes colour and opacity, and no font claim at all', async () => {
    const doc = await withFontkit(await PDFDocument.create());
    doc.addPage([612, 792]);
    addAnnotations(doc, [
      {
        kind: 'Text',
        page: 0,
        rect: { x: 72, y: 700, width: 26, height: 26 },
        color: '#059669',
        opacity: 0.5,
        contents: LATIN,
      },
    ]);
    const back = await PDFDocument.load(await doc.save({ useObjectStreams: false }));
    const annots = back.getPage(0).node.Annots()!;
    const dict = back.context.lookup(annots.asArray()[0] as never) as PDFDict;
    const colour = (dict.get(PDFName.of('C')) as PDFArray).asArray().map((value) => Number(String(value)));
    expect(colour[1]).toBeCloseTo(0.588, 2);
    expect(Number(String(dict.get(PDFName.of('CA'))))).toBeCloseTo(0.5, 3);
    // No `/DA`, no `/DR`: a reader paints a note's popup in its own UI font, so a
    // family or a size set here would be a control that changes no glyph. The one
    // that was there — "Text size" — is deleted, and the mark carries no style.
    expect(dict.get(PDFName.of('DA'))).toBeUndefined();
    expect(dict.get(PDFName.of('DR'))).toBeUndefined();
  });

  it('gives a note mark no text style, so the control set has nothing to offer it', () => {
    const note = mark('note', { contents: 'a comment', text: '' });
    expect(note.textStyle).toBeUndefined();
    expect(annotationToSpec(note).textStyle).toBeUndefined();
  });
});

/* ── one layout path, shared by the preview and the export ──────────────── */

describe('the layout does not depend on which document measured it', () => {
  it('breaks the same block in the same places through two documents', async () => {
    const style = size({ fontFamily: 'noto', size: 15, lineSpacing: 1.4 });
    const body = `${LATIN}\n${CJK}\nThe quick brown fox jumps over the lazy dog again and again`;
    const preview = await layoutMarkText(await measureDocument(), {
      kind: 'freetext',
      body,
      style,
      width: rect.width,
      height: rect.height,
    });
    const exportDoc = await withFontkit(await PDFDocument.create());
    exportDoc.addPage([612, 792]);
    const exported = await layoutMarkText(exportDoc, {
      kind: 'freetext',
      body,
      style,
      width: rect.width,
      height: rect.height,
    });
    expect(exported.lines.map((line) => line.text)).toEqual(preview.lines.map((line) => line.text));
    expect(exported.lines.map((line) => [line.x, line.baseline])).toEqual(
      preview.lines.map((line) => [line.x, line.baseline]),
    );
  });

  it('lays a mark out through `layoutBlock`, the call the block editor writes with', async () => {
    const style = size({ fontFamily: 'std:times', size: 13 });
    const doc = await measureDocument();
    const laid: MarkTextLayout = await layoutMarkText(doc, {
      kind: 'freetext',
      body: LATIN,
      style,
      width: 160,
      height: 120,
    });
    const blockStyle: EditorStyle = {
      ...DEFAULT_STYLE,
      fontFamily: style.fontFamily,
      size: style.size,
      color: style.color,
      align: style.align,
      lineSpacing: style.lineSpacing,
      spaceAfter: 0,
    };
    const object = {
      id: 'block',
      page: 1,
      kind: 'text',
      box: { x: 0, y: 0, width: 160, height: 120 },
      rotation: 0,
      flipH: false,
      flipV: false,
      z: 0,
      alt: '',
      state: 'draft',
      paragraphs: paragraphsFromText(LATIN),
      style: blockStyle,
      deletion: [],
      paperColor: '#000000',
      sourceId: '',
      fromInvisibleLayer: false,
    } as TextObject;
    const prepared = await prepareTextObject(doc, object);
    expect(laid.lines.map((line) => line.text)).toEqual(prepared.layout.lines.map((line) => line.text));
  });

  it('shrinks a stamp label the same number of points on screen and in the file', async () => {
    const style = { ...defaultFaceStyle('stamp'), size: 40 };
    const doc = await withFontkit(await PDFDocument.create());
    doc.addPage([612, 792]);
    const laid = await layoutMarkText(doc, {
      kind: 'stamp',
      body: 'Confidential',
      style,
      width: tightStamp.width,
      height: tightStamp.height,
    });
    expect(laid.shrank).toBe(true);
    const out = await writeMark(stampSpec(style, 'Confidential', tightStamp));
    expect(out.ops).toContain(`/F1 ${laid.size} Tf`);
  });
});
