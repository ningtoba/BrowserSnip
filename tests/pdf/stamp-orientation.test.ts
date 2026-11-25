/**
 * `add-stamps`: a stamp on a turned sheet is *upright*, and its `/S` is a name a
 * reader recognises.
 *
 * Both halves were measured on the dev build before this file existed. On
 * `/tmp/triage/colour.pdf` sheet 4 (`595×420 /Rotate 90`) a placed stamp measured
 * 44 pt wide × 140 pt tall on the displayed sheet, with its label running down that
 * 44 pt edge and crossing the border by 9 pt (the box drawn `140x44` in unrotated
 * space is a different box once the page turn is applied — the same trap the n-up
 * and page-number rounds found). The rail route wrote `/S /ASIS` and `/NOTAPPROVED`
 * where PDF 32000-1 Table 265 says `/AsIs` and `/NotApproved`, so the card's promise
 * that "other readers recognise it" was false for every value with a space in it.
 *
 * Everything asserted here is in the produced bytes: the appearance stream's own
 * matrix, font size and border, and the annotation dictionary. `stamp-round.mjs`
 * plus `stamps-check.py` judge the same file's pixels in the live round.
 */
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, decodePDFRawStream, degrees } from '@maxwbh/pdf-lib';
import { addAnnotation } from '@/lib/pdf/core/annotations';
import { rectFromDrag } from '@/components/tools/pdf/editor/specs';
import { defaultStyleFor } from '@/components/tools/pdf/editor/tools';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import type { ToolValues } from '@/lib/pdf/tools/types';

const pdfFile = (bytes: Uint8Array, name: string) =>
  new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });

/** A one-page document whose page is turned the way the fixture's sheet 4 is. */
async function turnedSheet(rotation: 0 | 90 | 180 | 270): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([420, 595]);
  page.drawText('PAGE 1', { x: 30, y: 300, size: 12 });
  page.setRotation(degrees(rotation));
  return doc.save({ useObjectStreams: false });
}

interface Drawn {
  /** The wrapping `cm` the appearance starts with, or the identity. */
  matrix: number[];
  size: number;
  /** Text origin as drawn inside the appearance. */
  at: { x: number; y: number };
  /** Border rectangle, width × height, from the `re` before the text. */
  border: { x: number; y: number; width: number; height: number };
  /** `Tj` operand, decoded. */
  words: string;
}

function readAppearance(doc: PDFDocument, pageIndex = 0): Drawn {
  const annots = doc.getPage(pageIndex).node.lookup(PDFName.of('Annots'), PDFArray);
  expect(annots, 'the page carries no /Annots').toBeTruthy();
  const dict = doc.context.lookup(annots!.asArray()[0]) as PDFDict;
  const ap = dict.lookup(PDFName.of('AP'), PDFDict).get(PDFName.of('N'));
  const stream = doc.context.lookup(ap) as unknown as { getContentsString?: () => string };
  const decoded = new TextDecoder().decode(decodePDFRawStream(stream as never).decode());
  const cm = decoded.match(/([-0-9. ]+) cm/);
  const tf = decoded.match(/\/F1 ([-0-9.]+) Tf/);
  const tm = decoded.match(/1 0 0 1 ([-0-9.]+) ([-0-9.]+) Tm/);
  const re = decoded.match(/([-0-9.]+) ([-0-9.]+) ([-0-9.]+) ([-0-9.]+) re/);
  expect(tm, `no text origin in the appearance: ${decoded}`).toBeTruthy();
  expect(re, `no border rect in the appearance: ${decoded}`).toBeTruthy();
  const literal = decoded.match(/\((.*?)\) Tj/);
  const hex = decoded.match(/<([0-9A-Fa-f]+)> Tj/);
  const words = literal
    ? literal[1]
    : (hex?.[1] ?? '').replace(/../g, (pair) => String.fromCharCode(parseInt(pair, 16)));
  return {
    matrix: cm ? cm[1].trim().split(/\s+/).map(Number) : [1, 0, 0, 1, 0, 0],
    size: Number(tf?.[1] ?? 0),
    at: { x: Number(tm![1]), y: Number(tm![2]) },
    border: { x: Number(re![1]), y: Number(re![2]), width: Number(re![3]), height: Number(re![4]) },
    words,
  };
}

/** Where a text advance pointing right inside the appearance ends up once the
 * appearance's own `cm` has been applied — the direction a reader paints it in. */
function paintedRun(drawn: Drawn, advance: number): { x: number; y: number } {
  const [a, b] = drawn.matrix;
  return { x: a * advance, y: b * advance };
}

/** A stamp placing 140 × 44 pt on the displayed sheet, stored the way the editor
 * stores it on a quarter-turned page: axes swapped. */
function placeUpright(doc: PDFDocument, rotation: 0 | 90 | 180 | 270, stampName: string, x = 20, y = 20) {
  const swap = rotation === 90 || rotation === 270;
  addAnnotation(doc, {
    kind: 'Stamp',
    page: 0,
    rect: { x, y, width: swap ? 44 : 140, height: swap ? 140 : 44 },
    stampName,
    contents: stampName,
  });
}

describe('a stamp drawn on a turned sheet still reads in the corner', () => {
  it('turns the label back upright for the page turn instead of leaving it on its side', async () => {
    const source = await PDFDocument.load(await turnedSheet(90));
    placeUpright(source, 90, 'Draft');
    const doc = await PDFDocument.load(await source.save({ useObjectStreams: false }));
    const drawn = readAppearance(doc);
    // The box the type is set in is the box the reader sees: 140 wide, not 44.
    // The border is inset half a point at each edge, so 139 × 43 is a full box.
    expect(drawn.border.width, `border drew ${drawn.border.width}×${drawn.border.height}`).toBeCloseTo(139, 0);
    expect(drawn.border.height).toBeCloseTo(43, 0);
    // The run was drawn 140 pt wide in that frame, and the frame cancels the turn:
    // painted out, the advance is straight up in unrotated space, which is
    // straight *across* the sheet as it is displayed.
    const run = paintedRun(drawn, 1);
    expect(Math.abs(run.x), `the run still runs down the edge: cm ${drawn.matrix.join(' ')}`).toBeLessThan(0.01);
    expect(run.y).toBeGreaterThan(0.99);
    expect(drawn.words).toBe('Draft');
  });

  it('an upright page keeps the identity matrix, so nothing else moved', async () => {
    const source = await PDFDocument.load(await turnedSheet(0));
    placeUpright(source, 0, 'Draft');
    const doc = await PDFDocument.load(await source.save({ useObjectStreams: false }));
    const drawn = readAppearance(doc);
    expect(drawn.matrix).toEqual([1, 0, 0, 1, 0, 0]);
    expect(drawn.border.width).toBeCloseTo(139, 0);
    expect(drawn.border.height).toBeCloseTo(43, 0);
    const run = paintedRun(drawn, 1);
    expect(run.x).toBeGreaterThan(0.99);
    expect(Math.abs(run.y)).toBeLessThan(0.01);
  });

  it('turns by exactly the page angle, all the way round', async () => {
    for (const [rotation, x, y] of [[180, -1, 0], [270, 0, -1]] as const) {
      const source = await PDFDocument.load(await turnedSheet(rotation));
      placeUpright(source, rotation, 'Draft');
      const doc = await PDFDocument.load(await source.save({ useObjectStreams: false }));
      const run = paintedRun(readAppearance(doc), 1);
      expect([Math.sign(run.x), Math.sign(run.y)], `rotation ${rotation} painted no turn`).toEqual([x, y]);
      expect(readAppearance(doc).border.width).toBeCloseTo(139, 0);
    }
  });

  it('shrinks a long label to the displayed width, not the stored one', async () => {
    const source = await PDFDocument.load(await turnedSheet(90));
    placeUpright(source, 90, 'PRELIMINARY RESULTS');
    const doc = await PDFDocument.load(await source.save({ useObjectStreams: false }));
    const drawn = readAppearance(doc);
    // Fitted to the 134 pt of usable *displayed* width this lands near 11 pt; the
    // 44 pt stored width would have set it near 3 pt.
    expect(drawn.size, 'the label was shrunk to the stored width, not the displayed one').toBeGreaterThan(8);
    expect(drawn.size).toBeLessThan(22);
    expect(drawn.size * drawn.words.length * 0.62).toBeLessThan(drawn.border.width);
  });

  it('places a click-made stamp 140 pt wide on the displayed sheet, not 140 pt tall', async () => {
    for (const rotation of [90, 270] as const) {
      const rect = rectFromDrag({
        tool: 'stamp',
        page: 0,
        style: defaultStyleFor('stamp'),
        drag: { x: 100, y: 100, width: 0, height: 0 },
        geom: { zoom: 1, cssWidth: 595, cssHeight: 420, x0: 0, y0: 0, rotation },
      });
      expect(rect, `no box at rotation ${rotation}`).toBeTruthy();
      expect(rect!.width, `rotation ${rotation}: stored width is the displayed height`).toBeCloseTo(44, 0);
      expect(rect!.height).toBeCloseTo(140, 0);
    }
    // A click a few points from the edge still lands wholly on the paper: the box
    // is clamped in the stored space, so the displayed box is clamped too.
    const edge = rectFromDrag({
      tool: 'stamp',
      page: 0,
      style: defaultStyleFor('stamp'),
      drag: { x: 592, y: 2, width: 0, height: 0 },
      geom: { zoom: 1, cssWidth: 595, cssHeight: 420, x0: 0, y0: 0, rotation: 90 },
    });
    expect(edge!.x).toBeGreaterThanOrEqual(0);
    expect(edge!.y).toBeGreaterThanOrEqual(0);
    expect(edge!.x + edge!.width).toBeLessThanOrEqual(420);
    expect(edge!.y + edge!.height).toBeLessThanOrEqual(595);
    const flat = rectFromDrag({
      tool: 'stamp',
      page: 0,
      style: defaultStyleFor('stamp'),
      drag: { x: 100, y: 100, width: 0, height: 0 },
      geom: { zoom: 1, cssWidth: 420, cssHeight: 595, x0: 0, y0: 0, rotation: 0 },
    });
    expect([flat!.width, flat!.height]).toEqual([140, 44]);
  });
});

describe('the stamp name the rail offers is the name the file gets', () => {
  const stampWith = async (stamp: string) => {
    const outcome = (await runPdfTool({
      toolId: 'add-stamps',
      files: [pdfFile(await turnedSheet(0), 'sheet.pdf')],
      values: { stamp, position: 'top-right', width: 160, opacity: 1, regions: '', pages: '1' } as ToolValues,
      onProgress: () => {},
      onLog: () => {},
    })) as unknown as { outputs: { blob: Blob }[] };
    expect(outcome.outputs.length).toBeGreaterThan(0);
    return PDFDocument.load(new Uint8Array(await outcome.outputs[0].blob.arrayBuffer()));
  };

  it('writes the Table 265 token for a spaced picker value', async () => {
    const doc = await stampWith('AS IS');
    const dict = stampsOf(doc);
    expect(String(dict.get(PDFName.of('S')))).toBe('/AsIs');
  });

  it('writes NotApproved and draws the words with the space in them', async () => {
    const doc = await stampWith('NOT APPROVED');
    const dict = stampsOf(doc);
    expect(String(dict.get(PDFName.of('S')))).toBe('/NotApproved');
    expect(readAppearance(doc).words).toBe('Not approved');
  });

  it('keeps a non-standard name as given, so a custom stamp is not renamed', async () => {
    const doc = await stampWith('EXPRESS');
    expect(String(stampsOf(doc).get(PDFName.of('S')))).toBe('/EXPRESS');
    expect(readAppearance(doc).words).toBe('EXPRESS');
  });
});

describe('the opacity reaches the ink, not just the dictionary', () => {
  const faded = async (opacity: number) => {
    const source = await PDFDocument.load(await turnedSheet(0));
    addAnnotation(source, {
      kind: 'Stamp',
      page: 0,
      rect: { x: 20, y: 20, width: 140, height: 44 },
      stampName: 'Draft',
      opacity,
    });
    const doc = await PDFDocument.load(await source.save({ useObjectStreams: false }));
    const dict = stampsOf(doc);
    const ap = doc.context.lookup(dict.lookup(PDFName.of('AP'), PDFDict).get(PDFName.of('N'))) as unknown as { dict?: PDFDict };
    const decoded = new TextDecoder().decode(decodePDFRawStream(ap as never).decode());
    return { dict, doc, ap, decoded };
  };

  it('puts a below-one opacity in the appearance as a constant alpha', async () => {
    const { dict, doc, decoded } = await faded(0.4);
    // MuPDF and poppler both painted a Form `/AP` at full strength from `/CA`
    // alone, so the alpha has to be in the stream. They also *do* honour `/CA`,
    // which is why the dictionary value stays at 1: 0.4 written in both places
    // rendered at 0.16.
    expect(String(dict.get(PDFName.of('CA')))).toBe('1');
    const form = doc_lookup(doc, dict);
    expect(decoded, `no alpha in the appearance: ${decoded}`).toMatch(/\/GS1 gs/);
    expect(form).toMatch(/\/CA 0\.4/);
    expect(form).toMatch(/\/ca 0\.4/);
  });

  it('leaves a fully opaque stamp without an alpha state', async () => {
    const { decoded } = await faded(1);
    expect(decoded).not.toMatch(/gs/);
  });
});

/** The appearance form's own `/ExtGState`, as text, for the alpha assertions. */
function doc_lookup(doc: PDFDocument, dict: PDFDict): string {
  const stream = doc.context.lookup(dict.lookup(PDFName.of('AP'), PDFDict).get(PDFName.of('N'))) as unknown as { dict: PDFDict };
  const resources = stream.dict.lookup(PDFName.of('Resources'), PDFDict);
  const states = resources?.lookup(PDFName.of('ExtGState'), PDFDict);
  const state = states?.lookup(PDFName.of('GS1'), PDFDict);
  return String(state ?? '');
}

function stampsOf(doc: PDFDocument): PDFDict {
  const annots = doc.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
  expect(annots, 'no /Annots').toBeTruthy();
  return doc.context.lookup(annots!.asArray()[0]) as PDFDict;
}
