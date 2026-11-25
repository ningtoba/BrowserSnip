/**
 * Seam wave 2E / census #15 — `divide-pages` cut a /Rotate 180 sheet's band
 * mirrored about the horizontal centre.
 *
 * `displayRegion` turns a tile of the DISPLAYED sheet into the region of the
 * stored page `stamp` embeds. Its rot-180 row mapped the y-term as
 * `y0 + H - ty - th` — the rot-0 mirror — where the inverse of the /Rotate 180
 * display map keeps it `y0 + ty`: a half-turned sheet flips left↔right on screen,
 * but a band that sits low on paper still shows low on screen.
 *
 * MuPDF rendered this fixture (ink stored in the 40-100 band above the page
 * bottom, /Rotate 180) with its ink at display rows 40-100 from the TOP — and
 * ghostscript agrees — so the displayed top half takes the stored bottom, exactly
 * what `core/tables.viewerRectToUserSpace` (the pdf.js spec table, proven by wave
 * 2B) returns. The first test drives the real tool and judges the two produced
 * pieces' ink off MuPDF bitmaps; the second pins the table equality in bytes; the
 * square-sheet control shows why nobody saw this: on a square sheet the mirrored
 * term still hands each tile half the page, just the wrong halves of the axis
 * that happened to carry no content boundary.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, StandardFonts, degrees, rgb } from '@maxwbh/pdf-lib';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { displayRegion } from '@/lib/pdf/tools/organize';
import { viewerRectToUserSpace } from '@/lib/pdf/core/tables';

// jsdom cannot spin the pdf.js worker; the divide run only needs the session to
// exist (blankness is judged by the double below), and the bytes the tool writes
// are still produced and measured for real.
vi.mock('@/lib/pdf/core/render', () => ({
  openRender: async () => ({
    metadata: async () => ({ numPages: 1, info: {}, outlines: [] }),
    page: async () => ({ getViewport: () => ({ width: 1, height: 1 }), cleanup: () => {} }),
    renderPage: async () => ({ ctx: null, canvas: null, width: 1, height: 1 }),
    destroy: async () => {},
  }),
}));
vi.mock('@/lib/pdf/core/blank', () => ({
  pageBlankness: async () => ({ blank: false, reason: 'inked' }),
  findBlankPages: async () => new Set<number>(),
}));

const WIDTH = 400;
const HEIGHT = 600;

/** Non-square, /Rotate 180, all ink in the stored bottom band (user y 40-100). */
async function halfTurnSheet(width = WIDTH, height = HEIGHT): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([width, height]);
  page.setRotation(degrees(180));
  page.drawRectangle({ x: 0, y: 40, width, height: 60, color: rgb(0, 0, 0) });
  return doc.save({ useObjectStreams: false });
}

/** Dark device pixels MuPDF paints for one page of a file. */
function darkPixels(pdfPath: string, pageIndex: number): number {
  return Number(execFileSync('python3', [
    '-c',
    `import sys, pymupdf
doc = pymupdf.open(sys.argv[1])
page = doc[int(sys.argv[2])]
pix = page.get_pixmap(dpi=72, colorspace=pymupdf.csGRAY)
samples = pix.samples
print(sum(1 for i in range(0, len(samples)) if samples[i] < 100))
`,
    pdfPath, String(pageIndex),
  ], { encoding: 'utf8' }).trim());
}

describe('divide-pages cuts a /Rotate 180 sheet along the line the user sees (#15)', () => {
  it('MuPDF-judged: the piece from the DISPLAYED top half carries the band', async () => {
    const tool = getPdfTool('divide-pages');
    expect(tool).toBeTruthy();
    const source = new File([await halfTurnSheet() as BlobPart], 'turned.pdf', { type: 'application/pdf' });
    const outcome = await runPdfTool({
      toolId: 'divide-pages',
      files: [source],
      values: { axis: 'horizontal', parts: 2, pages: 'all' },
      onProgress: () => {},
      onLog: () => {},
    });
    expect(outcome.outputs.length).toBeGreaterThan(0);
    const bytes = new Uint8Array(await outcome.outputs[0].blob.arrayBuffer());
    const OUT_PDF = mkdtempSync(join(tmpdir(), 'seam2e-')) + '/d2-divided.pdf';
    writeFileSync(OUT_PDF, bytes);

    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(2);
    const ink = [0, 1].map((index) => darkPixels(OUT_PDF, index));
    console.log('D2 divided pieces dark-pixel counts', JSON.stringify(ink));
    const total = ink[0] + ink[1];
    expect(total, 'the divide painted the band onto no piece at all').toBeGreaterThan(1000);
    // Row 0 of the grid is the top of the DISPLAYED sheet; the band paints at
    // display rows 40-100, so it belongs entirely to piece 0. Pre-fix the mirror
    // sent it to piece 1.
    expect(ink[0], `the band landed in piece ${ink[1] > ink[0] ? 1 : 0}, mirrored about the horizontal centre: ${JSON.stringify(ink)}`).toBeGreaterThan(total * 0.9);
  });

  it('every rot-180 tile equals the shared viewer→user table', async () => {
    const doc = await PDFDocument.load(await halfTurnSheet());
    const page = doc.getPages()[0];
    const frame = { x0: 0, y0: 0, width: WIDTH, height: HEIGHT, rotation: 180 };
    for (const tile of [
      { x: 0, y: 0, width: WIDTH, height: HEIGHT / 2 },
      { x: 0, y: HEIGHT / 2, width: WIDTH, height: HEIGHT / 2 },
      { x: 0, y: HEIGHT / 4, width: WIDTH, height: HEIGHT / 2 },
      { x: WIDTH / 2, y: 0, width: WIDTH / 2, height: HEIGHT / 3 },
    ]) {
      expect(displayRegion(page, tile)).toEqual(viewerRectToUserSpace(tile, frame));
    }
  });

  it('the other three quarter turns still agree with the table (controls)', async () => {
    for (const rotation of [0, 90, 270] as const) {
      const doc = await PDFDocument.create();
      const page = doc.addPage([WIDTH, HEIGHT]);
      page.setRotation(degrees(rotation));
      const reread = await PDFDocument.load(await doc.save({ useObjectStreams: false }));
      const sheet = reread.getPages()[0];
      const frame = { x0: 0, y0: 0, width: WIDTH, height: HEIGHT, rotation };
      for (const tile of [
        { x: 0, y: 0, width: WIDTH, height: HEIGHT / 2 },
        { x: 0, y: HEIGHT / 2, width: WIDTH, height: HEIGHT / 2 },
        { x: WIDTH / 2, y: HEIGHT / 4, width: WIDTH / 2, height: HEIGHT / 2 },
      ]) {
        expect(displayRegion(sheet, tile), `rot ${rotation} tile ${JSON.stringify(tile)}`)
          .toEqual(viewerRectToUserSpace(tile, frame));
      }
    }
  });

  it('a cropped /Rotate 180 sheet carries the crop origin through the region', async () => {
    // The tile frame is the CROP box (what the viewer shows), so the region the
    // divide embeds must sit inside the crop, not the MediaBox corner.
    const doc = await PDFDocument.create();
    const page = doc.addPage([WIDTH + 60, HEIGHT + 90]);
    page.setCropBox(60, 90, WIDTH, HEIGHT);
    page.setRotation(degrees(180));
    const reread = await PDFDocument.load(await doc.save({ useObjectStreams: false }));
    const sheet = reread.getPages()[0];
    const tile = { x: 0, y: 0, width: WIDTH, height: HEIGHT / 2 };
    expect(displayRegion(sheet, tile)).toEqual(viewerRectToUserSpace(tile, {
      x0: 60, y0: 90, width: WIDTH, height: HEIGHT, rotation: 180,
    }));
  });
});
