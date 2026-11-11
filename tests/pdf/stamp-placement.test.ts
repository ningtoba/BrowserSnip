/**
 * `add-stamps`: one mark per page counted, in the corner aimed at, on pages that
 * differ in size *and* in rotation.
 *
 * The triage never reached this tool because in its own surface a stamp has to be
 * placed with a click before the button wakes; the pane was driven separately
 * (`docs/research/verify-stamps-pane.mjs`, log `stamps-deployed.log`) and did put one
 * `/Stamp` with `/S /Draft` on each of four pages, where they were clicked. What was
 * never pinned is the half of the card that reads "or per page you list", and the half
 * that reads "on a rotated page it sits in the corner you see": a mark painted against
 * unrotated geometry lands in a different corner than the one named, and a count of
 * four says nothing about that. So every assertion here is about position, converted
 * back into the space a person is looking at.
 */
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, degrees, decodePDFRawStream } from '@maxwbh/pdf-lib';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import type { ToolValues } from '@/lib/pdf/tools/types';

/** Displayed width/height and `/Rotate`, as the four sheets were built. */
const SHEETS: Array<[number, number, 0 | 90 | 180 | 270]> = [
  [595, 842, 0],
  [595, 842, 90],
  [400, 300, 0],
  [500, 700, 180],
  [450, 600, 270],
];

async function fixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const [index, [width, height, rotation]] of SHEETS.entries()) {
    const page = doc.addPage([width, height]);
    page.drawText(`PAGE ${index + 1}`, { x: 30, y: height / 2, size: 12 });
    page.setRotation(degrees(rotation));
  }
  return doc.save({ useObjectStreams: false });
}

const pdfFile = (bytes: Uint8Array, name: string) =>
  new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });

interface Placed {
  /** Displayed-space rect: origin top-left of the sheet as it is shown. */
  x: number;
  y: number;
  width: number;
  height: number;
  name: string;
  opacity: number;
}

/**
 * Every `/Stamp` on a page, in the space the viewer shows.
 *
 * `/Rect` is stored in unrotated user space with a bottom-left origin; a quarter turn
 * swaps the axes, which is exactly the conversion a stamp can get wrong.
 */
function stampsOn(doc: PDFDocument, index: number): Placed[] {
  const page = doc.getPage(index);
  const [width, height, rotation] = SHEETS[index];
  const annots = page.node.lookup(PDFName.of('Annots'), PDFArray);
  if (!annots) return [];
  const out: Placed[] = [];
  for (const entry of annots.asArray()) {
    const dict = doc.context.lookup(entry) as PDFDict;
    if (String(dict.get(PDFName.of('Subtype'))) !== '/Stamp') continue;
    const [x0, y0, x1, y1] = (dict.lookup(PDFName.of('Rect'), PDFArray)).asArray()
      .map((n) => Number(String(n)));
    let left = x0;
    let top = height - y1;
    let boxW = x1 - x0;
    let boxH = y1 - y0;
    /*
     * Where a `/Rect` shows up on the sheet a person is looking at. These four rows are
     * not derived from a convention: each one was confirmed against the pixels MuPDF
     * paints for the same file (`docs/research/stamps-readers.log`), which is the
     * only judge of "the corner as it is displayed". A stamp whose rendered ink is
     * 18 pt from the top and 19 pt from the right on all four sheets is in the corner
     * the tool named, whatever the numbers in the dictionary look like.
     */
    if (rotation === 90) {
      left = y0;
      top = x0;
      boxW = y1 - y0;
      boxH = x1 - x0;
    } else if (rotation === 180) {
      left = width - x1;
      top = y0;
    } else if (rotation === 270) {
      left = height - y1;
      top = width - x1;
      boxW = y1 - y0;
      boxH = x1 - x0;
    }
    out.push({
      x: left,
      y: top,
      width: boxW,
      height: boxH,
      name: String(dict.get(PDFName.of('S')) ?? ''),
      opacity: Number(String(dict.get(PDFName.of('CA')) ?? '1')),
    });
  }
  return out;
}

async function stamp(values: ToolValues): Promise<{ bytes: Uint8Array; message: string }> {
  const outcome = (await runPdfTool({
    toolId: 'add-stamps',
    files: [pdfFile(await fixture(), 'sheets.pdf')],
    values: { stamp: 'CONFIDENTIAL', position: 'top-right', width: 160, opacity: 1, regions: '', ...values },
    onProgress: () => {},
    onLog: () => {},
  })) as unknown as { outputs: { blob: Blob }[]; message?: string };
  expect(outcome.outputs.length, 'add-stamps produced no file').toBeGreaterThan(0);
  return {
    bytes: new Uint8Array(await outcome.outputs[0].blob.arrayBuffer()),
    message: outcome.message ?? '',
  };
}

describe('a stamp lands on every page counted, in the corner named', () => {
  it('places one per listed page and says so in the same numbers', async () => {
    const { bytes, message } = await stamp({ pages: '1-5' });
    expect(message).toMatch(/Placed 5 stamps on 5 pages/);
    const doc = await PDFDocument.load(bytes);
    for (const [index, [width, height]] of SHEETS.entries()) {
      const marks = stampsOn(doc, index);
      expect(marks, `page ${index + 1} got no stamp`).toHaveLength(1);
      const [mark] = marks;
      const displayW = SHEETS[index][2] === 90 || SHEETS[index][2] === 270 ? height : width;
      const displayH = SHEETS[index][2] === 90 || SHEETS[index][2] === 270 ? width : height;
      // The name this app writes is the word from the picker, upper-cased. PDF's own
      // standard appearance names are spelled `/Confidential` (32000 Table 265), so
      // the key is present but is not the canonical token — pinned as the truth here,
      // and written up rather than changed, because `/S` and the drawn label share one
      // string in `core/annotations.ts`.
      expect(mark.name, `page ${index + 1} carries no /S stamp name`).toBe('/CONFIDENTIAL');
      expect(mark.opacity, `page ${index + 1} ignored the opacity`).toBeCloseTo(1, 3);
      // Inside the sheet as shown, and in the top-right of it.
      expect([mark.x >= 0, mark.y >= 0, mark.x + mark.width <= displayW + 0.5, mark.y + mark.height <= displayH + 0.5],
        `page ${index + 1}: the mark is off the visible page: ${JSON.stringify(mark)} in ${displayW}x${displayH}`)
        .toEqual([true, true, true, true]);
      expect(mark.x + mark.width, `page ${index + 1}: not against the right edge`).toBeGreaterThan(displayW * 0.7);
      expect(mark.y, `page ${index + 1}: not near the top`).toBeLessThan(displayH * 0.3);
      expect(mark.width, `page ${index + 1}: the requested width was not honoured on a turned page`)
        .toBeCloseTo(Math.min(160, displayW * 0.9), 1);
    }
  });

  it('leaves the pages that were not listed alone', async () => {
    const { bytes, message } = await stamp({ pages: '2,4-5' });
    expect(message).toMatch(/Placed 3 stamps on 3 pages/);
    const doc = await PDFDocument.load(bytes);
    expect(stampsOn(doc, 0)).toHaveLength(0);
    expect(stampsOn(doc, 1)).toHaveLength(1);
    expect(stampsOn(doc, 2)).toHaveLength(0);
    expect(stampsOn(doc, 3)).toHaveLength(1);
    expect(stampsOn(doc, 4)).toHaveLength(1);
  });

  it('follows a different corner when a different corner is named', async () => {
    const { bytes } = await stamp({ pages: '1', position: 'bottom-left' });
    const doc = await PDFDocument.load(bytes);
    const [mark] = stampsOn(doc, 0);
    expect(mark.x).toBeLessThan(80);
    expect(mark.y + mark.height).toBeGreaterThan(842 * 0.7);
  });

  it('shrinks a stamp wider than the sheet instead of painting past the edge', async () => {
    // 600 pt on a 400 pt page.
    const { bytes, message } = await stamp({ pages: '3', width: 600 });
    const doc = await PDFDocument.load(bytes);
    const [mark] = stampsOn(doc, 2);
    expect(mark.x + mark.width).toBeLessThanOrEqual(400.5);
    expect(message).toMatch(/Placed 1 stamp on 1 page/);
  });

  it('keeps the label readable: the appearance draws text into the annotation', async () => {
    const { bytes } = await stamp({ pages: '1' });
    const doc = await PDFDocument.load(bytes);
    const annots = doc.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
    const dict = doc.context.lookup(annots!.asArray()[0]) as PDFDict;
    const ap = dict.lookup(PDFName.of('AP'), PDFDict).get(PDFName.of('N'));
    const stream = doc.context.lookup(ap) as { getContentsString?: () => string } & Record<string, unknown>;
    expect(stream, 'the stamp has no /AP /N appearance').toBeTruthy();
    const decoded = new TextDecoder().decode(decodePDFRawStream(stream as never).decode());
    expect(decoded).toMatch(/Tj|TJ/);
    // The label is drawn as a text run, so it is selectable and extractable rather
    // than baked into a picture; `Tj` operands are either literal or hex.
    const words = [...decoded.matchAll(/(?:\((.*?)\)|<([0-9A-Fa-f]+)>)\s*Tj/g)].map((match) => {
      if (match[1] !== undefined) return match[1];
      const hex = match[2];
      let out = '';
      for (let i = 0; i + 1 < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
      return out;
    }).join('');
    expect(words, `no readable label in the appearance: ${decoded.slice(0, 160)}`).toMatch(/CONFIDENTIAL/i);
  });
});
