/**
 * Seam wave 2E / census #8 — the annotation editor's coordinate tables dropped
 * the page's box origin, so every mark drifted across a cropped sheet by the
 * offset between the CropBox and the MediaBox corner.
 *
 * `geometry.ts` owns the one place the editor maps screen pixels to PDF user
 * space. Its quarter-turn tables were correct relative to the page's own extent
 * but added nothing for the extent's **position**: `pdfToScreenRect` /
 * `screenToPdfRect` assumed user space starts at (0, 0). On the census fixture —
 * a page whose CropBox starts at (30, 45) — pdf.js `getViewport` numbers that
 * sheet from (30, 45), so a mark the user sees at the top-left was stored at
 * (0, 0), off by exactly the origin (measured pre-fix: 45 pt of drift at /Rotate
 * 0, and the crop offset on every turn).
 *
 * pdf.js is the mapper the pane renders through (`page.view`, `convertToPdfPoint`,
 * `convertToViewportRectangle`), so it is the ground truth here. The pin builds a
 * real cropped + turned page, opens it with pdf.js, and requires `geometry.ts` to
 * agree with pdf.js's own viewport for every quarter turn, in both directions and
 * at a zoom ≠ 1 — the exact contract the acceptance states (annotation rect ==
 * pdf.js viewport rect). An uncropped page is the control: pdf.js and geometry
 * still agree, and the numbers are the same as the origin-less tables produced.
 *
 * `@vitest-environment node`: pdf.js's worker needs a DOM under jsdom it does not
 * get (the same reason `edge-organize` doubles `core/render`); the real library
 * runs headless in node, so the ground truth here is pdf.js itself, not a copy.
 */
// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument, degrees } from '@maxwbh/pdf-lib';
import { pdfToScreenRect, screenToPdfRect } from '@/components/tools/pdf/editor/geometry';
import type { PageGeom } from '@/components/tools/pdf/editor/geometry';
import { viewerRectToUserSpace } from '@/lib/pdf/core/tables';
import type { QuadRect } from '@/lib/pdf/core/annotations';

const OFFSET = { x: 30, y: 45, width: 400, height: 600 };
const ROTATIONS = [0, 90, 180, 270] as const;

/** The three pdf.js values the pin compares `geometry.ts` against. */
interface PdfjsSheet {
  geom: PageGeom;
  /** `page.getViewport({ scale: zoom })` — the mapper the pane renders through. */
  vp: {
    width: number;
    height: number;
    convertToPdfPoint: (x: number, y: number) => [number, number, number, number, number];
    convertToViewportRectangle: (rect: [number, number, number, number]) => [number, number, number, number];
  };
}

/** Open a page with pdf.js and read the geometry the pane would build from it. */
async function pdfjsGeom(bytes: Uint8Array, zoom: number): Promise<PdfjsSheet> {
  // pdf.js ships no public types for the legacy `.mjs` build's viewport proxy;
  // these are the only members the pin touches, asserted once at the boundary.
  const doc = (await getDocument({ data: bytes.slice(0), isEvalSupported: false }).promise) as unknown as {
    getPage: (n: number) => Promise<{
      rotate: number;
      view: [number, number, number, number];
      getViewport: (o: { scale: number }) => PdfjsSheet['vp'];
    }>;
  };
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: zoom });
  const geom: PageGeom = {
    zoom,
    cssWidth: vp.width,
    cssHeight: vp.height,
    x0: page.view[0],
    y0: page.view[1],
    rotation: (((page.rotate % 360) + 360) % 360) as PageGeom['rotation'],
  };
  return { geom, vp };
}

/** A cropped, turned page written by pdf-lib and read back through pdf.js. */
async function offsetPage(rotation: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([OFFSET.x + OFFSET.width + 30, OFFSET.y + OFFSET.height + 45]);
  page.setCropBox(OFFSET.x, OFFSET.y, OFFSET.width, OFFSET.height);
  page.setRotation(degrees(rotation));
  return doc.save({ useObjectStreams: false });
}

/** A page whose CropBox is the MediaBox corner: the uncropped control. */
async function plainPage(rotation: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([OFFSET.width, OFFSET.height]);
  page.setRotation(degrees(rotation));
  return doc.save({ useObjectStreams: false });
}

const RECT: QuadRect = { x: 120, y: 500, width: 80, height: 40 };

describe('geometry.ts maps user space through the page box origin (#8)', () => {
  for (const rotation of ROTATIONS) {
    it(`/Rotate ${rotation}: pdfToScreenRect matches pdf.js convertToViewportRectangle on an offset crop`, async () => {
      const { geom, vp } = await pdfjsGeom(await offsetPage(rotation), 1);
      const [a1, b1, a2, b2] = vp.convertToViewportRectangle([RECT.x, RECT.y, RECT.x + RECT.width, RECT.y + RECT.height]);
      const truth = {
        x: Math.min(a1, a2), y: Math.min(b1, b2),
        width: Math.abs(a2 - a1), height: Math.abs(b2 - b1),
      };
      const got = pdfToScreenRect(RECT, geom);
      const drift = Math.max(
        Math.abs(got.x - truth.x), Math.abs(got.y - truth.y),
        Math.abs(got.width - truth.width), Math.abs(got.height - truth.height),
      );
      expect(drift, `rot ${rotation}: geometry ${JSON.stringify(got)} vs pdf.js ${JSON.stringify(truth)}`).toBeLessThan(0.5);
    });

    it(`/Rotate ${rotation}: screenToPdfRect matches pdf.js convertToPdfPoint (round-trips)`, async () => {
      const { geom, vp } = await pdfjsGeom(await offsetPage(rotation), 1);
      const storedAgain = screenToPdfRect(pdfToScreenRect(RECT, geom), geom);
      const drift = Math.max(
        Math.abs(storedAgain.x - RECT.x), Math.abs(storedAgain.y - RECT.y),
        Math.abs(storedAgain.width - RECT.width), Math.abs(storedAgain.height - RECT.height),
      );
      expect(drift, `round-trip drift ${drift}`).toBeLessThan(0.5);
      // …and the top-left corner specifically maps where pdf.js says it does.
      const corner = vp.convertToPdfPoint(0, 0);
      const mine = screenToPdfRect({ x: 0, y: 0, width: 0, height: 0 }, geom);
      expect(Math.abs(mine.x - corner[0]) < 0.5 && Math.abs(mine.y - corner[1]) < 0.5,
        `screen(0,0) → ${JSON.stringify([mine.x, mine.y])}, pdf.js → ${JSON.stringify(corner)}`).toBe(true);
    });
  }

  it('agrees at a zoom ≠ 1 (the pane default is never 1)', async () => {
    for (const zoom of [0.75, 1.5, 2]) {
      const { geom, vp } = await pdfjsGeom(await offsetPage(90), zoom);
      const [a1, b1, a2, b2] = vp.convertToViewportRectangle([RECT.x, RECT.y, RECT.x + RECT.width, RECT.y + RECT.height]);
      const truth = { x: Math.min(a1, a2), y: Math.min(b1, b2), width: Math.abs(a2 - a1), height: Math.abs(b2 - b1) };
      const got = pdfToScreenRect(RECT, geom);
      expect(Math.max(Math.abs(got.x - truth.x), Math.abs(got.y - truth.y)), `zoom ${zoom}`).toBeLessThan(0.5);
    }
  });

  it('is unchanged on an uncropped page (control): origin (0,0), still matches pdf.js', async () => {
    for (const rotation of ROTATIONS) {
      const { geom, vp } = await pdfjsGeom(await plainPage(rotation), 1);
      expect([geom.x0, geom.y0], 'uncropped page should have a zero origin').toEqual([0, 0]);
      const [a1, b1, a2, b2] = vp.convertToViewportRectangle([RECT.x, RECT.y, RECT.x + RECT.width, RECT.y + RECT.height]);
      const truth = { x: Math.min(a1, a2), y: Math.min(b1, b2), width: Math.abs(a2 - a1), height: Math.abs(b2 - b1) };
      expect(pdfToScreenRect(RECT, geom)).toMatchObject({ x: expect.closeTo(truth.x, 3), y: expect.closeTo(truth.y, 3) });
    }
  });

  it('the origin shift equals the shared viewer→user table on a cropped page', async () => {
    // geometry's screenToPdfRect must agree with core/tables.viewerRectToUserSpace
    // (the canonical mapper, proven by wave 2B) once the origin is folded in.
    const frame = { x0: OFFSET.x, y0: OFFSET.y, width: OFFSET.width, height: OFFSET.height, rotation: 180 };
    const { geom } = await pdfjsGeom(await offsetPage(180), 1);
    // viewport-space top-left of the whole displayed sheet → the user rect tables
    // say the crop covers.
    const sheet = { x: 0, y: 0, width: OFFSET.width, height: OFFSET.height };
    const tables = viewerRectToUserSpace(sheet, frame);
    const mine = screenToPdfRect({ x: 0, y: 0, width: geom.cssWidth, height: geom.cssHeight }, geom);
    const drift = Math.max(
      Math.abs(mine.x - tables.x), Math.abs(mine.y - tables.y),
      Math.abs(mine.width - tables.width), Math.abs(mine.height - tables.height),
    );
    expect(drift, `whole-sheet map ${JSON.stringify(mine)} vs tables ${JSON.stringify(tables)}`).toBeLessThan(0.5);
  });

  it('reads the census fixture itself: crop offset survives to pdf.js', async () => {
    const bytes = new Uint8Array(readFileSync('/tmp/triage/in/annot.pdf'));
    const doc = (await getDocument({ data: bytes, isEvalSupported: false }).promise) as unknown as {
      getPage: (n: number) => Promise<{
        rotate: number;
        view: [number, number, number, number];
        getViewport: (o: { scale: number }) => PdfjsSheet['vp'];
      }>;
    };
    const page = await doc.getPage(8); // the CropBox-offset page
    // pdf.js numbers user space from the CropBox's own lower-left. MuPDF reports
    // the same box as (42, 59.5 …) **y-down from the top**; in the bottom-left
    // frame geometry works in that corner is (42, 464.1) — the value that matters
    // here, and the one an annotation `/Rect` is stored against.
    expect(page.view[0]).toBeCloseTo(42, 1);
    expect(page.view[1]).toBeCloseTo(464.1, 1);
    const vp = page.getViewport({ scale: 1 });
    const geom: PageGeom = { zoom: 1, cssWidth: vp.width, cssHeight: vp.height, x0: page.view[0], y0: page.view[1], rotation: 0 };
    // The viewer's bottom-left pixel stores at the crop's own lower-left corner,
    // (view[0], view[1]) — not at (0, 0) the way the origin-less tables claimed.
    const atOrigin = screenToPdfRect({ x: 0, y: vp.height - 1, width: 1, height: 1 }, geom);
    expect(atOrigin.x).toBeCloseTo(page.view[0], 0);
    expect(atOrigin.y).toBeCloseTo(page.view[1], 0);
  });
});
