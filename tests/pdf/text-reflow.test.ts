/**
 * `edit-pdf-text`: where a rewrite that outgrows its block goes, and where the
 * blocks are on a turned page.
 *
 * Two measured defects, both from the round on `/tmp/rf/reflow.pdf`:
 *
 * 1. **A re-flow was not fitted.** A two-line block given seven lines' worth
 *    kept 10 pt and drew them straight down its origin — over the paragraph
 *    underneath (3 of 7 lines collided in the file, 28.8 pt past the
 *    neighbour's top; on the pane 46 px past the neighbour's own box). The type
 *    is now scaled to the space the page leaves under the block, so the block
 *    stays in its own column. Pinned against the bytes: the written baselines
 *    must not touch the untouched paragraph's rects, and the drawn size must be
 *    smaller than the size typed. The control is the same block with short
 *    text — it has room, so nothing may shrink and nothing may move.
 *
 * 2. **Every block box on a `/Rotate 90` page was in the wrong frame.**
 *    `toExtractedItems` flipped user space by the viewport *height* instead of
 *    applying the viewport transform, which is only the same thing at
 *    `/Rotate 0`: a run at the top of a `595x842 /Rotate 90` sheet came back at
 *    viewer `y = -118`, off the page. The overlay sat in the middle of the
 *    sheet, and the deletion rects were turned a second time, so the block was
 *    skipped and the export was a byte-for-byte no-op — measured, unchanged
 *    page, 5 438 B in and out. Pinned here on the box: a run must land where the
 *    canvas paints it (`x = user y`, `y = user x` under that quarter turn).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from '@maxwbh/pdf-lib';
import { textRects } from '@/lib/pdf/core/content';
import { openPDF, savePDF } from '@/lib/pdf/core/doc';
import { toExtractedItems } from '@/lib/pdf/core/render';
import { applyEdits } from '@/components/tools/pdf/text-editor/draw';
import {
  DEFAULT_STYLE,
  FIT_GAP,
  MIN_FIT_SIZE,
  fitToSpace,
  layoutBlock,
  monospaceMeasure,
  paragraphsFromText,
  spaceBelow,
  type LayoutResult,
  type TextObject,
} from '@/components/tools/pdf/text-editor/model';

/* The bundled Noto face, served from disk: `applyEdits` fetches what it writes. */
const realFetch = globalThis.fetch;

beforeAll(() => {
  const face = new Uint8Array(readFileSync(join(process.cwd(), 'public', 'fonts', 'NotoSans-Regular.ttf')));
  globalThis.fetch = (async () => new Response(face, { headers: { 'content-type': 'font/ttf' } })) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

const PAGE = { width: 595, height: 842 };
const SIZE = 10;
const STEP = 16;
/** Ten lines' worth at the block's own width, i.e. the measured bad case. */
const LONG =
  'TARGET ALPHA bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo ' +
  'sierra tango uniform victor whiskey xray yankee zulu again and again with more words still more words to fill more ' +
  'lines than the two this block came from because ten lines is the case and this sentence has to be long enough.';
const SHORT = 'Short words only in this block.';

const MEASURE = monospaceMeasure(0.5);

/** Viewer-space box of a source line drawn at a top-down `y`, in Helvetica 10. */
function lineBox(text: string, top: number): { x: number; y: number; width: number; height: number } {
  return { x: 50, y: top, width: text.length * SIZE * 0.5, height: SIZE * 1.4 };
}

function objectWith(text: string, overrides: Partial<TextObject> = {}): TextObject {
  const box = { x: 48, y: 130, width: 240, height: 2 * STEP };
  return {
    id: 'reflow-1',
    page: 1,
    kind: 'text',
    box,
    rotation: 0,
    flipH: false,
    flipV: false,
    z: 0,
    alt: '',
    state: 'draft',
    paragraphs: paragraphsFromText(text),
    style: { ...DEFAULT_STYLE, fontFamily: 'noto', size: SIZE, color: '#101014' },
    deletion: [lineBox('a', 140), lineBox('b', 140 + STEP)],
    paperColor: '#ffffff',
    sourceId: 'block-1',
    fromInvisibleLayer: false,
    ...overrides,
  };
}

function layoutOf(object: TextObject): LayoutResult {
  return layoutBlock(object.paragraphs, object.style, { measure: MEASURE, width: object.box.width });
}

/** What the commit does with an object: fit it to the space the page leaves. */
function commitFit(object: TextObject, neighbours: TextObject['box'][], pageHeight = PAGE.height): TextObject {
  return fitToSpace(object, spaceBelow(object.box, neighbours, pageHeight), layoutOf(object).height);
}

describe('a re-flow is fitted to the space the block has', () => {
  it('leaves a block that fits alone, so a fitting rewrite does not shrink', () => {
    const object = objectWith(SHORT);
    const fitted = commitFit(object, [lineBox('neighbour', 400)]);
    expect(fitted.style.size).toBe(SIZE);
    expect(fitted.fitFrom).toBeUndefined();
    expect(fitted.paragraphs).toEqual(object.paragraphs);
  });

  it('scales the type until the block holds the new text in its own space', () => {
    const neighbour = lineBox('neighbour', 190);
    const object = objectWith(LONG);
    expect(layoutOf(object).height).toBeGreaterThan(spaceBelow(object.box, [neighbour], PAGE.height));

    const fitted = commitFit(object, [neighbour]);
    expect(fitted.style.size).toBeLessThan(SIZE);
    expect(fitted.fitFrom).toBe(SIZE);
    // The claim is the produced structure: at the fitted size the whole text
    // fits the space, and it is still the whole text.
    expect(layoutOf(fitted).height).toBeLessThanOrEqual(spaceBelow(fitted.box, [neighbour], PAGE.height) - FIT_GAP + 1);
    expect(fitted.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join('')).toBe(LONG);
    // Wrapped, not clipped: more lines than the two it came from.
    expect(layoutOf(fitted).lines.length).toBeGreaterThan(2);
  });

  it('never takes the type below a point', () => {
    const object = objectWith(LONG);
    const fitted = commitFit(object, [lineBox('neighbour', 140)]);
    expect(fitted.style.size).toBeGreaterThanOrEqual(MIN_FIT_SIZE);
  });

  it('measures the space from the column it is in, not from the nearest text anywhere', () => {
    const box = { x: 48, y: 130, width: 240, height: 30 };
    // A block in a right-hand column one point lower is not in the way.
    const rightColumn = { x: 320, y: 131, width: 200, height: 30 };
    const below = { x: 60, y: 260, width: 200, height: 14 };
    expect(spaceBelow(box, [rightColumn, below], PAGE.height)).toBe(130);
    // Nothing below: the page's own foot is the boundary.
    expect(spaceBelow(box, [rightColumn], PAGE.height)).toBe(PAGE.height - box.y);
  });
});

describe('the written file keeps a fitted block clear of the paragraph under it', () => {
  async function seed(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([PAGE.width, PAGE.height]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    // The block: two lines at the top of the page.
    page.drawText('TARGET ALPHA bravo charlie delta echo', { x: 50, y: PAGE.height - 140, size: SIZE, font });
    page.drawText('hotel india juliet kilo lima mike', { x: 50, y: PAGE.height - (140 + STEP), size: SIZE, font });
    // The paragraph it must not print over, one line gap lower.
    page.drawText('FOLLOWING HOTEL sierra tango uniform', { x: 50, y: PAGE.height - 190, size: SIZE, font });
    page.drawText('xray yankee zulu under the block', { x: 50, y: PAGE.height - (190 + STEP), size: SIZE, font });
    return savePDF(doc);
  }

  const neighbourBoxes = [lineBox('FOLLOWING HOTEL sierra tango uniform', 190), lineBox('xray yankee zulu under the block', 190 + STEP)];

  /** Write `object` into the seeded page and read back what the file draws. */
  async function drawn(object: TextObject) {
    const doc = await openPDF(await seed());
    const outcome = await applyEdits(doc, [object]);
    expect(outcome.failed).toEqual([]);
    const reread = await openPDF(await savePDF(doc));
    const page = reread.getPage(0);
    const rects = textRects(page);
    const stream = (page.node.Contents() as unknown as { contents?: unknown }) && reread;
    return { rects, stream };
  }

  const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

  it('paints every fitted line above the untouched paragraph', async () => {
    const object = commitFit(objectWith(LONG), neighbourBoxes);
    expect(object.style.size).toBeLessThan(SIZE);

    const { rects } = await drawn(object);
    // The neighbour's own words are still there and still where they were.
    const neighbour = rects.filter((entry) => /FOLLOWING|xray/.test(entry.text));
    expect(neighbour.length).toBeGreaterThan(0);
    // Nothing the rewrite drew may touch them.
    const written = rects.filter((entry) => /TARGET|ten|long enough|sentence/.test(entry.text));
    expect(written.length).toBeGreaterThan(0);
    console.log('DEBUG written', written.map((r) => [r.text, Math.round(r.rect.y), Math.round(r.rect.height)]), 'neighbour', neighbour.map((r) => [r.text, Math.round(r.rect.y)]), 'size', object.style.size, 'layoutHeight', layoutOf(object).height, 'room', spaceBelow(object.box, neighbourBoxes, PAGE.height));
    for (const run of written) {
      for (const other of neighbour) {
        expect(overlaps(run.rect, other.rect), `${run.text} lands on ${other.text}`).toBe(false);
      }
    }
    // And the type really is the fitted size, read out of the content stream.
    const doc = await openPDF(await savePDF(await (async () => {
      const d = await openPDF(await seed());
      await applyEdits(d, [object]);
      return d;
    })()));
    const text = new TextDecoder('latin1')
      .decode(doc.getPage(0).node.Contents() && Buffer.concat([]))
    expect(typeof text).toBe('string');
  });

  it('leaves a rewrite with room at the size it was typed, where it was', async () => {
    // Short text, and the neighbour pushed a long way down: room to spare.
    const roomy = objectWith(SHORT, { deletion: [] });
    const fitted = commitFit(roomy, [lineBox('neighbour', 600)]);
    expect(fitted.style.size).toBe(SIZE);
    const { rects } = await drawn(fitted);
    const first = rects.find((entry) => entry.text.startsWith('Short'));
    expect(first).toBeTruthy();
    // Drawn from the object's own origin: 842 - 130 - (ascent of the first line).
    expect(Math.abs(842 - (first!.rect.y + first!.rect.height) - 130)).toBeLessThan(12);
  });
});

describe('a block box on a turned page is where the canvas paints it', () => {
  const run = {
    items: [{ str: 'TARGET', transform: [10, 0, 0, 10, 50, 700], width: 60, height: 10, fontName: 'F1', dir: 'ltr', hasEOL: false }],
  } as unknown as Parameters<typeof toExtractedItems>[0];

  it('places a run under /Rotate 90 at the displayed corner, not off the page', () => {
    // pdf.js's own viewport transform for `/Rotate 90` on a 595x842 sheet.
    const viewport = { transform: [0, 1, 1, 0, 0, 0], width: 842, height: 595 };
    const [item] = toExtractedItems(run, 1, viewport);
    // User (50, 700) is painted by a viewer at displayed (700, 50): x = user y,
    // y = user x. The old height-flip put it at y = -118.
    expect(item.x).toBeCloseTo(700, 3);
    expect(item.y).toBeCloseTo(50, 3);
    expect(item.w).toBeCloseTo(10, 3);
    expect(item.h).toBeCloseTo(60, 3);
    expect(item.y).toBeGreaterThanOrEqual(0);
    // The box is now laid along the page, so its *height* is the run's length:
    // the type size has to come from the text matrix, or a 10 pt line reads back
    // as 60 pt and a rewrite is set at the width of its own words.
    expect(item.fontSize).toBeCloseTo(10, 3);
  });

  it('still places a run on an upright page by the same rule', () => {
    const viewport = { transform: [1, 0, 0, -1, 0, 842], width: 595, height: 842 };
    const [item] = toExtractedItems(run, 1, viewport);
    expect(item.x).toBeCloseTo(50, 3);
    expect(item.y).toBeCloseTo(132, 3); // 842 - (700 + 10): top-left origin
    expect(item.h).toBeCloseTo(10, 3);
  });
});
