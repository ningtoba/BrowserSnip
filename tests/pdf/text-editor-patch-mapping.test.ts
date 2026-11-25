/**
 * Seam wave 2E / census #14 — the cover patch has to land on the word.
 *
 * `draw.ts` hides a word the built-in deletion could not reach by mapping the
 * survivor's **user-space** rect back to a viewer-space box (`userRectToBox`,
 * used at :708), which pass 2 then re-maps to user space (`viewerBoxToUserSpace`,
 * :731) before drawing the paper rectangle. The two mappings are only correct if
 * `userRectToBox` is the true inverse of the deletion map.
 *
 * Pre-fix it applied `viewerToUserMatrix` — the *forward* viewer→user map — as if
 * it were its own inverse. That holds only at `x0 = y0 = 0` with
 * `/Rotate ∈ {0, 90, 180}` (measured this pass: the forward map composed with
 * itself is identity on those sheets, drift < 0.01 pt, and up to 215 pt off on a
 * `/Rotate 270` page or any page whose CropBox origin is not the MediaBox origin).
 * The cure inverts the map with the `invertMatrix` the model already exports but
 * nothing called.
 *
 * The first block is the rotation battery on the exported mapping; the second
 * drives the real `applyEdits` path on an undeletable word (text in a *direct*
 * Form XObject, which `commitFormStreams` refuses to rewrite in place) and reads
 * the painted rectangle back off the produced bytes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PDFArray,
  PDFName,
  PDFRawStream,
  PDFDocument,
  StandardFonts,
  degrees,
} from '@maxwbh/pdf-lib';
import type { PDFPage, PDFRef } from '@maxwbh/pdf-lib';
import { openPDF, savePDF } from '@/lib/pdf/core/doc';
import { pageContentStreams, textRects } from '@/lib/pdf/core/content';
import { applyEdits, frameOfPage, userRectToBox } from '@/components/tools/pdf/text-editor/draw';
import {
  DEFAULT_STYLE,
  paragraphsFromText,
  viewerBoxToUserSpace,
  type TextObject,
} from '@/components/tools/pdf/text-editor/model';
import type { PageFrame, TopLeftBox } from '@/lib/pdf/core/tables';

const box = (x: number, y: number, width: number, height: number): TopLeftBox => ({ x, y, width, height });

/* ── the model's own matrix pair, so the battery has no fixture to doubt ────── */

const SHEET = { x0: 0, y0: 0, width: 400, height: 600 };
/** The undeletable word's own rect, in the page's user space (bottom-left origin). */
const WORD = { x: 310, y: 520, width: 42, height: 12 };
const ORIGINS: [number, number][] = [[0, 0], [30, 45]];
const ROTATIONS: (0 | 90 | 180 | 270)[] = [0, 90, 180, 270];

function drift(back: TopLeftBox): number {
  return Math.max(
    Math.abs(back.x - WORD.x),
    Math.abs(back.y - WORD.y),
    Math.abs(back.width - WORD.width),
    Math.abs(back.height - WORD.height),
  );
}

describe('userRectToBox is the exact inverse of the deletion mapping (#14)', () => {
  for (const rotation of ROTATIONS) {
    for (const [x0, y0] of ORIGINS) {
      const frame: PageFrame = { ...SHEET, x0, y0, rotation };
      // Where the paper patch is really drawn: box back into user space, exactly
      // as `draw.ts:731` does before `drawRectangle`.
      const painted = viewerBoxToUserSpace(userRectToBox(WORD, frame), frame);
      it(`/Rotate ${rotation}, origin (${x0},${y0}) — patch lands within ${drift(painted).toFixed(2)} pt of the word`, () => {
        expect(drift(painted)).toBeLessThan(0.01);
      });
    }
  }
});

/* ── the same claim end-to-end, off the produced bytes ─────────────────────── */

const realFetch = globalThis.fetch;
beforeAll(() => {
  const face = new Uint8Array(readFileSync(join(process.cwd(), 'public', 'fonts', 'NotoSans-Regular.ttf')));
  globalThis.fetch = (async () =>
    new Response(face as unknown as BodyInit, { headers: { 'content-type': 'font/ttf' } })) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

/**
 * A page whose only text lives in a **direct** (inline, not `/`-registered) Form
 * XObject. A direct form has no object for the walker to copy, so the word cannot
 * be rewritten away — `applyEdits` therefore covers it with a paper patch, which is
 * the exact code path `userRectToBox` feeds. The page carries a non-zero CropBox
 * origin and a `/Rotate`, the two conditions the pre-fix map broke on.
 */
async function uncuttableSheet(
  rotation: 0 | 90 | 180 | 270,
  origin: [number, number],
): Promise<{ doc: Awaited<ReturnType<typeof openPDF>>; page: PDFPage }> {
  const [ox, oy] = origin;
  const built = await PDFDocument.create();
  const font = await built.embedFont(StandardFonts.Helvetica);
  const fontRef = (font as unknown as { ref: PDFRef }).ref;
  // MediaBox holds the crop box with room around it, so the crop origin is (ox,oy).
  const page = built.addPage([ox + SHEET.width + 20, oy + SHEET.height + 20]);
  page.setCropBox(ox, oy, SHEET.width, SHEET.height);
  page.setRotation(degrees(rotation));
  const ctx = built.context;
  const faceResources = ctx.obj({});
  const faceFonts = ctx.obj({});
  faceFonts.set(PDFName.of('F1'), fontRef);
  faceResources.set(PDFName.of('Font'), faceFonts);
  const word = 'BT /F1 12 Tf 60 300 Td (SURVIVOR) Tj ET\n';
  const formDict = ctx.obj({});
  const inlineForm = PDFRawStream.of(formDict, new TextEncoder().encode(word));
  formDict.set(PDFName.of('Type'), PDFName.of('XObject'));
  formDict.set(PDFName.of('Subtype'), PDFName.of('Form'));
  formDict.set(PDFName.of('BBox'), ctx.obj([0, 0, SHEET.width + ox + 20, SHEET.height + oy + 20]));
  formDict.set(PDFName.of('Resources'), faceResources);
  const pageResources = ctx.obj({});
  const xobjects = ctx.obj({});
  xobjects.set(PDFName.of('Fx'), inlineForm); // direct object: uncopyable
  pageResources.set(PDFName.of('XObject'), xobjects);
  pageResources.set(PDFName.of('Font'), faceFonts);
  page.node.set(PDFName.of('Resources'), pageResources);
  const content = ctx.register(PDFRawStream.of(ctx.obj({}), new TextEncoder().encode('q /Fx Do Q\n')));
  page.node.set(PDFName.of('Contents'), content);
  const doc = await openPDF(await built.save({ useObjectStreams: false }));
  return { doc, page: doc.getPages()[0] };
}

/**
 * Every white paper patch the produced page paints, as a user-space rect.
 *
 * `drawRectangle` emits `… rg … 1 0 0 1 tx ty cm` then a four-point path; the
 * corners are in the translated frame, so the real rect is `tx+minX, ty+minY` to
 * `tx+maxX, ty+maxY`. Reading the bytes is the file's truth, not the model's claim.
 */
function paintedPatches(page: PDFPage): TopLeftBox[] {
  const out: TopLeftBox[] = [];
  for (const stream of pageContentStreams(page)) {
    const text = new TextDecoder('latin1').decode(stream.bytes);
    for (const block of text.split(/\bq\b/)) {
      if (!/\b1 1 1 rg\b/.test(block) || !/\bh\s*f\b/.test(block)) continue;
      let tx = 0;
      let ty = 0;
      for (const cm of block.matchAll(/1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm/g)) {
        tx += Number(cm[1]);
        ty += Number(cm[2]);
      }
      const points = [...block.matchAll(/(-?[\d.]+) (-?[\d.]+) [ml]/g)]
        .map((m) => [Number(m[1]), Number(m[2])]);
      if (points.length === 0) continue;
      const xs = points.map((p) => p[0]);
      const ys = points.map((p) => p[1]);
      out.push(box(
        tx + Math.min(...xs), ty + Math.min(...ys),
        Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys),
      ));
    }
  }
  return out;
}

describe('the export paints the patch over the word it cannot delete (#14)', () => {
  for (const rotation of [90, 180, 270] as const) {
    for (const origin of ORIGINS) {
      it(`/Rotate ${rotation}, CropBox origin (${origin[0]},${origin[1]}): a patch rectangle sits on the surviving word`, async () => {
        const { doc, page } = await uncuttableSheet(rotation, origin);
        const frame = frameOfPage(page);
        const survivor = textRects(page).find((run) => run.text.includes('SURVIVOR'));
        expect(survivor, 'the fixture lost its undeletable word').toBeDefined();

        const edit: TextObject = {
          id: `edit-${rotation}-${origin.join('_')}`,
          page: 1,
          kind: 'text',
          box: box(0, 0, frame.width, frame.height),
          rotation: 0,
          flipH: false,
          flipV: false,
          z: 0,
          alt: '',
          state: 'queued',
          paragraphs: paragraphsFromText('kept word'),
          style: { ...DEFAULT_STYLE, size: 12, color: '#000000' },
          deletion: [box(0, 0, frame.width, frame.height)],
          paperColor: '#ffffff',
          sourceId: 'p-SURVIV',
          fromInvisibleLayer: false,
        };
        const outcome = await applyEdits(doc, [edit]);
        const covered = outcome.covered.find((entry) => entry.id === edit.id);
        expect(covered, `expected a cover patch, got failed=${JSON.stringify(outcome.failed)}`).toBeDefined();

        // The file, not the model: reopen and read the patch it really painted.
        const reread = await openPDF(await savePDF(doc));
        const rects = paintedPatches(reread.getPages()[0]);
        expect(rects.length, 'the export painted no paper patch').toBeGreaterThan(0);
        const hides = rects.some((rect) =>
          rect.x <= survivor!.rect.x + 0.5
          && rect.y <= survivor!.rect.y + 0.5
          && rect.x + rect.width >= survivor!.rect.x + survivor!.rect.width - 0.5
          && rect.y + rect.height >= survivor!.rect.y + survivor!.rect.height - 0.5,
        );
        expect(
          hides,
          `patch ${JSON.stringify(rects)} misses the word ${JSON.stringify(survivor!.rect)}`,
        ).toBe(true);
      });
    }
  }
});
