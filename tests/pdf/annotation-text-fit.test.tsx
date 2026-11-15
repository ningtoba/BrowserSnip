/**
 * A text box holds more words than its box — where do they go?
 *
 * The answer is in the format, not in a preference: an appearance stream is
 * clipped to its `/BBox`, so a line drawn below the box is in the file and no
 * reader paints it. Round 031 measured the disagreement that followed from the
 * overlay ignoring it — a 120 × 40 box with a sentence typed into it painted **17
 * lines over the page** on screen while the exported page showed **2** (`Alpha`,
 * `beta`; the other fifteen were in the stream at baselines −20 to −490 and clipped
 * at 40).
 *
 * So two things are held here: the painted lines are clipped to the same edge the
 * file clips at, and the editor says the words do not fit rather than leaving the
 * reader to discover it. The control is a box that does fit — it must stay quiet.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from '@testing-library/react';
import { PDFDocument } from '@maxwbh/pdf-lib';
import { AnnotationOverlay, textClipId } from '@/components/tools/pdf/editor/AnnotationOverlay';
import { annotationToSpec } from '@/components/tools/pdf/editor/specs';
import { defaultFaceStyle } from '@/lib/pdf/core/text-style';
import { withFontkit } from '@/lib/pdf/core/doc';
import type { AnnotationSpec } from '@/lib/pdf/core/annotations';
import { prepareSpecTexts, type MarkPreview } from '@/components/tools/pdf/editor/textLayout';
import type { EditorAnnotation, EditorToolId } from '@/components/tools/pdf/editor/types';
import type { PageGeom } from '@/components/tools/pdf/editor/geometry';

const NOTO = new Uint8Array(readFileSync(join(process.cwd(), 'public/fonts/NotoSans-Regular.ttf')));
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async () =>
    new Response(NOTO as unknown as BodyInit, { headers: { 'content-type': 'font/ttf' } })) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

const GEOM: PageGeom = { zoom: 2, cssWidth: 1224, cssHeight: 1584, rotation: 0 };
const BOX = { x: 72, y: 500, width: 240, height: 40 };

/** A text box on the page, styled the way the pen styles one. */
function textBox(over: Partial<EditorAnnotation> = {}): EditorAnnotation {
  return {
    id: 'box-1',
    tool: 'freetext' as EditorToolId,
    kind: 'FreeText',
    page: 0,
    rect: { ...BOX },
    color: '#1B1B18',
    borderColor: '#1B1B18',
    borderWidth: 0.8,
    opacity: 1,
    text: 'Alpha beta gamma delta epsilon zeta eta theta iota',
    textStyle: defaultFaceStyle('freetext'),
    createdAt: 1,
    ...over,
  };
}

/** The lines a full paragraph lays out to, long past the box it lives in. */
function overflowingPreview(over: Partial<MarkPreview> = {}): MarkPreview {
  const line = { text: 'Alpha', x: 4.2, baseline: 30, size: 12 };
  return {
    lines: Array.from({ length: 8 }, (_, i) => ({ ...line, baseline: 30 - i * 16 })),
    size: 12,
    shrank: false,
    contentHeight: 120,
    overflows: true,
    ...over,
  };
}

function renderOverlay(mark: EditorAnnotation, preview: MarkPreview) {
  const noop = () => {};
  return render(
    createElement(AnnotationOverlay, {
      geom: GEOM,
      annotations: [mark],
      draft: null,
      vertices: null,
      tool: 'select' as EditorToolId,
      selection: [],
      editingId: null,
      marquee: null,
      textPreviews: { [mark.id]: preview },
      onSurfacePointerDown: noop,
      onAnnotationPointerDown: noop,
      onAnnotationDoubleClick: noop,
      onHandlePointerDown: noop,
      onRotatePointerDown: noop,
      onFinishVertices: noop,
      onTextDraft: noop,
      onTextCommit: noop,
    }),
  );
}

describe('the painted type is clipped where the file clips it', () => {
  it('clips the laid-out lines to the mark box the appearance is clipped to', () => {
    const mark = textBox();
    const { container } = renderOverlay(mark, overflowingPreview());
    const group = container.querySelector(`[data-text-layout="${mark.id}"]`) as SVGGElement;
    expect(group, 'the mark lost its laid-out type').toBeTruthy();
    expect(group.getAttribute('clip-path')).toBe(`url(#${textClipId(mark.id)})`);
    const clip = container.querySelector(`#${textClipId(mark.id)} rect`) as SVGRectElement;
    expect(clip, 'the clip rectangle was not written').toBeTruthy();
    // geom.zoom is 2 and the page's y runs down, so the box is at 2× and mirrored.
    expect(Number(clip.getAttribute('x'))).toBeCloseTo(BOX.x * 2, 1);
    expect(Number(clip.getAttribute('y'))).toBeCloseTo((792 - BOX.y - BOX.height) * 2, 1);
    expect(Number(clip.getAttribute('width'))).toBeCloseTo(BOX.width * 2, 1);
    expect(Number(clip.getAttribute('height'))).toBeCloseTo(BOX.height * 2, 1);
  });

  it('says on the mark when its words do not fit, and not when they do', () => {
    const over = renderOverlay(textBox(), overflowingPreview());
    expect(
      over.container.querySelector('[data-text-layout]')?.getAttribute('data-text-overflows'),
    ).toBe('true');
    over.unmount();
    const fits = renderOverlay(
      textBox(),
      overflowingPreview({ contentHeight: 30, overflows: false, lines: overflowingPreview().lines.slice(0, 1) }),
    );
    expect(
      fits.container.querySelector('[data-text-layout]')?.getAttribute('data-text-overflows'),
    ).toBe('false');
  });
});

describe('the export names the clip instead of losing words silently', () => {
  const LONG = 'Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron';

  async function noticesFor(height: number, body = LONG): Promise<string[]> {
    const doc = await withFontkit(await PDFDocument.create());
    doc.addPage([612, 792]);
    const mark = textBox({ text: body, rect: { ...BOX, height } });
    const spec = annotationToSpec(mark) as AnnotationSpec;
    return prepareSpecTexts(doc, [spec]);
  }

  /** The height the words themselves need, read out of the tool's own answer. */
  async function neededFor(body = LONG): Promise<number> {
    const notice = (await noticesFor(1, body)).find((n) => /clipped/.test(n)) ?? '';
    return Number(/need ([\d.]+) pt/.exec(notice)?.[1] ?? 0);
  }

  it('names the box height, the height the words need, and what a reader will do', async () => {
    const needed = await neededFor();
    const tight = Math.floor(needed) - 6;
    const notes = await noticesFor(tight);
    const line = notes.find((note) => /clipped at its edge/.test(note));
    expect(line, `no clip notice in ${JSON.stringify(notes)}`).toBeTruthy();
    expect(line).toMatch(new RegExp(`${tight}(\\.\\d)? pt tall`));
    expect(line).toMatch(/need [\d.]+ pt/);
    expect(line).toMatch(/a reader will not show it/);
  });

  it('stays quiet for a box the words fit in, and speaks one point short of it', async () => {
    expect((await noticesFor(400)).filter((n) => /clipped/.test(n))).toEqual([]);
    // The measured height the words need is the boundary: at it, quiet; below, named.
    const needed = await neededFor();
    expect(needed).toBeGreaterThan(20);
    expect((await noticesFor(Math.ceil(needed) + 1)).filter((n) => /clipped/.test(n))).toEqual([]);
    expect((await noticesFor(Math.floor(needed) - 1)).filter((n) => /clipped/.test(n))).toHaveLength(1);
  });

  it('a short box with one word in it is quiet', async () => {
    expect((await noticesFor(40, 'Alpha')).filter((n) => /clipped/.test(n))).toEqual([]);
  });

  it('a text box with no words says nothing about clipping', async () => {
    const doc = await withFontkit(await PDFDocument.create());
    doc.addPage([612, 792]);
    const empty = annotationToSpec(textBox({ text: '' })) as AnnotationSpec;
    expect((await prepareSpecTexts(doc, [empty])).filter((n) => /clipped/.test(n))).toEqual([]);
  });
});
