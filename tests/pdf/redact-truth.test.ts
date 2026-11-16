/**
 * What a redaction must be true of, measured off the bytes it writes.
 *
 * Four separate claims, one per defect this round found in the shipped pane and
 * engine — each of them green in the round before it:
 *
 *  1. CID text. `/W` has two spellings and the `cFirst cLast w` triple was read
 *     as `cFirst w cLast` and stepped by four, so every width in the array after
 *     the first range desynchronised. A 14 pt DejaVu glyph came back 0.63 pt
 *     wide: the boxes covered a fourteenth of each advance and a rect drawn over
 *     a word deleted nothing, while the card said "covered, not gone".
 *  2. A drag is a *selection*, not a line. The snap works on text runs and a run
 *     is usually a whole line, so one word dragged over deleted its neighbours.
 *  3. A mark's fractions are fractions of the sheet they were drawn on. The size
 *     they were turned back with was the *first* page's, so on a `/Rotate 90`
 *     sheet — whose displayed width is the page's height — the bar landed in
 *     another band entirely.
 *  4. A viewer paints annotations above page content, so a comment under the box
 *     was drawn over the fill and stayed in `/Annots`.
 */
import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, StandardFonts, degrees, rgb } from '@maxwbh/pdf-lib';
import { applyRedactions } from '@/lib/pdf/core/redact';
import { pageContentStreams } from '@/lib/pdf/core/content';
import { addAnnotation, listAnnotations } from '@/lib/pdf/core/annotations';
import { toExtractedItems } from '@/lib/pdf/core/render';
import { snapTextLines } from '@/components/tools/pdf/editor/quads';
import { clipLinesToDrag, redactionRegions } from '@/components/tools/pdf/security/RedactMain';
import type { Redaction } from '@/components/tools/pdf/security/RedactMain';

const latin1 = new TextDecoder('latin1');

/** Every page stream, inflated: what a text extractor can actually reach. */
function streams(doc: PDFDocument): string {
  return doc
    .getPages()
    .map((page) => pageContentStreams(page).map((stream) => {
      try {
        return latin1.decode(inflateSync(Buffer.from(stream.bytes)));
      } catch {
        return latin1.decode(stream.bytes);
      }
    }).join('\n'))
    .join('\n');
}

/* ── 1. CID widths ──────────────────────────────────────────────────────── */

/**
 * A page of text in a Type0/Identity-H font whose `/W` uses the triple form.
 *
 * pdf-lib's own embedder writes the array form, and every pdf-lib fixture in the
 * suite therefore missed the branch. Five glyphs, codes 36–40, all the same
 * 0.6 em advance by `/W [ 36 40 600 ]`; the drawing is placed so the first
 * glyph's box is 72…79.2 at 12 pt.
 */
async function cidPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([420, 595]);
  const context = doc.context;
  const descriptor = context.obj({
    Type: '/FontDescriptor', FontName: '/Fake', Flags: 4,
    FontBBox: [-200, -200, 1000, 1000], ItalicAngle: 0, Ascent: 900, Descent: -200, StemV: 80,
  });
  const cid = context.obj({
    Type: '/Font', Subtype: '/CIDFontType2', BaseFont: '/Fake', DW: 1000,
    CIDSystemInfo: context.obj({ Registry: 'Adobe', Ordering: 'Identity', Supplement: 0 }),
    FontDescriptor: descriptor,
  });
  cid.set(PDFName.of('W'), context.obj([36, 40, 600]));
  const type0 = context.obj({
    Type: '/Font', Subtype: '/Type0', BaseFont: '/Fake', Encoding: '/Identity-H',
    DescendantFonts: context.obj([cid]),
  });
  const fontRef = context.register(type0);
  const content = context.flateStream('BT /F1 12 Tf 1 0 0 1 72 500 Tm [<00240025002600270028>] TJ ET\n');
  page.node.set(PDFName.of('Resources'), context.obj({ Font: context.obj({ F1: fontRef }) }));
  page.node.set(PDFName.of('Contents'), context.register(content));
  return doc.save({ useObjectStreams: false });
}

const FIRST_GLYPH = { x: 72, y: 500, width: 7.2, height: 12 };

describe('a CID font’s /W is read the way Table 169 writes it', () => {
  it('deletes the one glyph under the box and keeps the four beside it', async () => {
    const doc = await PDFDocument.load(await cidPdf(), { updateMetadata: false });
    const outcome = applyRedactions(doc, [{ page: 0, rect: FIRST_GLYPH }], { fill: '#000000' });
    const text = streams(doc);
    expect(outcome.removed, 'exactly one run lost a glyph').toBe(1);
    // Codes 36…40, written as single-glyph hex strings once the run is rewritten.
    expect(text, 'the covered glyph is gone').not.toContain('<0024>');
    expect(text, 'its neighbours are not — a 0.48 pt advance would take all five').toContain('<0025>');
    expect(text).toContain('<0028>');
  }, 60_000);

  it('reads the array form and the triple form as the same advance', async () => {
    // The control: `/W [ 36 [600 600 600 600 600] ]` is the spelling pdf-lib and
    // pymupdf write. It has to give the identical answer, or the fix traded one
    // spelling for the other.
    const source = await cidPdf();
    const doc = await PDFDocument.load(source, { updateMetadata: false });
    const cid = doc.context.lookup(
      doc.context.lookup((doc.getPage(0).node.Resources()!.lookup(PDFName.of('Font')) as PDFDict).lookup(PDFName.of('F1')) as never) && (doc.getPage(0).node.Resources()!.lookup(PDFName.of('Font')) as PDFDict).lookup(PDFName.of('F1')) as PDFDict,
    ) as PDFDict;
    expect(cid).toBeTruthy();
    const descendant = doc.context.lookup(cid.get(PDFName.of('DescendantFonts')) as never) as PDFArray | undefined;
    const cidFont = descendant ? (doc.context.lookup(descendant.get(0)) as PDFDict) : undefined;
    cidFont!.set(PDFName.of('W'), doc.context.obj([36, [600, 600, 600, 600, 600]]));
    const outcome = applyRedactions(doc, [{ page: 0, rect: FIRST_GLYPH }], { fill: '#000000' });
    expect(outcome.removed).toBe(1);
    expect(streams(doc)).not.toContain('<0024>');
    expect(streams(doc)).toContain('<0028>');
  }, 60_000);
});

/* ── 2. the drag is the selection ───────────────────────────────────────── */

const RUN = {
  str: 'ALPHA BRAVO CHARLIE DELTA',
  transform: [12, 0, 0, 12, 40, 500],
  width: 190,
  height: 12,
  fontName: 'F1',
  dir: 'ltr',
  page: 1,
  x: 40, y: 95, w: 190, h: 12,
  hasEOL: false,
  fontSize: 12,
  isInvisible: false,
  ux: 0, uy: -1,
};

describe('a one-word drag is a one-word redaction', () => {
  it('keeps the words either side of the one dragged over', () => {
    // The band a person drags across "CHARLIE": x 120…165 of the run above.
    const drag = { x0: 120, y0: 96, x1: 165, y1: 104 };
    const snapped = snapTextLines([RUN], drag, { tolerance: 2 });
    const clipped = clipLinesToDrag(snapped, drag);
    expect(clipped).toHaveLength(1);
    // Without the clip the line box runs 40…230 and deletes ALPHA, BRAVO and
    // DELTA too; with it the box is bounded by the drag.
    expect(snapped[0].x1 - snapped[0].x0).toBeGreaterThan(180);
    expect(clipped[0].x0).toBeGreaterThanOrEqual(120);
    expect(clipped[0].x1).toBeLessThanOrEqual(165);
  });

  it('drops a line the drag never reaches', () => {
    const drag = { x0: 300, y0: 96, x1: 340, y1: 104 };
    expect(clipLinesToDrag(snapTextLines([RUN], drag), drag)).toEqual([]);
  });
});

/* ── 3. the sheet the mark was drawn on ─────────────────────────────────── */

describe('a mark is scaled by the sheet it was drawn on', () => {
  it('a turned sheet puts the bar back on the words it was drawn over', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([595, 842]);
    page.drawText('VICTOR WHISKEY XRAY', { x: 60, y: 500, size: 18, font, color: rgb(0, 0, 0) });
    page.setRotation(degrees(90));
    const bytes = await doc.save({ useObjectStreams: false });
    const reloaded = await PDFDocument.load(bytes, { updateMetadata: false });
    const viewport = { width: 842, height: 595 };            // the displayed sheet
    const stale = { width: 595, height: 842 };               // the first page's

    // The run as the text layer reports it on the turned sheet, and the band a
    // drag over it produces.
    const items = toExtractedItems(
      { items: [{ ...RUN, str: 'VICTOR WHISKEY XRAY' }] } as never,
      1,
      { transform: [0, 1, 1, 0, 0, 0], ...viewport },
    );
    const drag = { x0: items[0].x - 4, y0: items[0].y + 20, x1: items[0].x + items[0].w + 4, y1: items[0].y + 120 };
    const line = snapTextLines(items, drag)[0];
    expect(line, 'the drag caught the run').toBeTruthy();
    const mark = {
      id: 'r-1', page: 1, free: false,
      x: line.x0 / viewport.width, y: (viewport.height - line.y1) / viewport.height,
      w: (line.x1 - line.x0) / viewport.width, h: (line.y1 - line.y0) / viewport.height,
    } as unknown as Redaction;

    const right = redactionRegions(mark, viewport as never)[0];
    const wrong = redactionRegions(mark, stale as never)[0];
    // Along the turned page the run is *vertical*, so its length is the mark's
    // height: the right sheet reproduces the ink's 190 pt, the first page's 842
    // stretches the same fraction to 269.
    expect(Math.abs(right.height - items[0].h)).toBeLessThan(4);
    expect(Math.abs(wrong.height - right.height)).toBeGreaterThan(40);
    // The anchored box covers the run's ink band: the baseline is the run's own
    // left edge, so the box has to sit within a couple of points of it.
    const barTop = viewport.height - (right.y + right.height);
    const inkTop = items[0].y;
    expect(Math.abs(barTop - inkTop)).toBeLessThan(4);
  });
});

/* ── 4. comments under the box ──────────────────────────────────────────── */

async function annotPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([420, 595]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('PAPA OSCAR', { x: 40, y: 500, size: 12, font, color: rgb(0, 0, 0) });
  addAnnotation(doc, { kind: 'FreeText', page: 0, rect: { x: 60, y: 300, width: 200, height: 30 }, contents: 'inside the box' });
  addAnnotation(doc, { kind: 'Highlight', page: 0, rect: { x: 60, y: 120, width: 200, height: 20 }, contents: 'outside it' });
  doc.getForm().createTextField('reference').addToPage(page, { x: 60, y: 250, width: 120, height: 20 });
  return doc.save({ useObjectStreams: false });
}

describe('an annotation under the box goes with the text', () => {
  it('drops the comment and its entry, and leaves the widget to its field', async () => {
    const doc = await PDFDocument.load(await annotPdf(), { updateMetadata: false });
    const before = listAnnotations(doc).map((mark) => mark.kind);
    expect(before).toEqual(expect.arrayContaining(['FreeText', 'Highlight', 'Widget']));

    // A box over the free text and the widget, nowhere near the highlight.
    const outcome = applyRedactions(doc, [{ page: 0, rect: { x: 55, y: 245, width: 215, height: 95 } }], { fill: '#000000' });
    expect(outcome.marksRemoved, 'the free text went').toBe(1);
    expect(outcome.widgetsLeft, 'the field was left live and counted').toBe(1);
    const after = listAnnotations(doc).map((mark) => mark.kind);
    expect(after, 'nothing is drawn over the fill but the field').toEqual(['Highlight', 'Widget']);
    expect(after, 'the comment object is out of the page').toHaveLength(2);
  }, 60_000);

  it('leaves a comment whose centre is outside the box', async () => {
    const doc = await PDFDocument.load(await annotPdf(), { updateMetadata: false });
    // Only the free text's left third: its centre stays outside.
    const outcome = applyRedactions(doc, [{ page: 0, rect: { x: 200, y: 300, width: 60, height: 30 } }], { fill: '#000000' });
    expect(outcome.marksRemoved).toBe(0);
    expect(listAnnotations(doc).map((mark) => mark.kind)).toContain('FreeText');
  }, 60_000);
});

/* ── the panels's own conversion, still in one piece ────────────────────── */

describe('a mark on a page with no annotations', () => {
  it('reports nothing removed and paints anyway', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([420, 595]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('SIERRA', { x: 40, y: 500, size: 12, font, color: rgb(0, 0, 0) });
    const outcome = applyRedactions(doc, [{ page: 0, rect: { x: 35, y: 495, width: 100, height: 20 } }], { fill: '#000000' });
    expect(outcome).toMatchObject({ marksRemoved: 0, widgetsLeft: 0 });
    const objects = doc.context.enumerateIndirectObjects().filter(([, object]) => object instanceof PDFRawStream);
    expect(objects.length).toBeGreaterThan(0);
  });
});
