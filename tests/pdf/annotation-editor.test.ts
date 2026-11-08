/**
 * Annotation editor — the pure half.
 *
 * jsdom has no canvas, so these tests cover exactly what the brief calls out:
 * the screen↔PDF coordinate transforms, the undo/redo stack, building an
 * `AnnotationSpec` from a drag gesture, and snapping a drag band to text lines
 * from synthetic `ExtractedTextItem[]`. The last two blocks are still
 * canvas-free: one hands the built specs to the real `addAnnotations` /
 * `applyRedactions` so the geometry the overlay draws is the geometry the file
 * carries, the other mounts the component to prove an empty document is real UI
 * and that the export path is reachable only with work on the page.
 *
 * Pointer interaction, page rasterising, the signature pad and the stamp
 * preview need a real browser and are checked by hand.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { render, screen } from '@testing-library/react';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream } from '@maxwbh/pdf-lib';
import {
  addAnnotations,
  annotationCount,
  applyRedactions,
  listAnnotations,
  markupRule,
  quadRing,
  STRIKE_ABOVE_BASELINE_EM,
  TEXT_BASELINE_SHARE,
  UNDERLINE_BELOW_BASELINE_EM,
  type AnnotationSpec,
} from '@/lib/pdf/core/annotations';
import type { ExtractedTextItem } from '@/lib/pdf/core/render';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  centeredRect,
  markScreenRotation,
  normaliseAngle,
  rectCentre,
  rotatePointAbout,
  rotatedBounds,
  rotationForDrag,
  screenAngle,
  snapAngle,
  clampZoom,
  fitRectInBox,
  fitWidthZoom,
  normaliseDrag,
  pdfQuadFromViewportBox,
  pdfToScreenPoint,
  pdfToScreenRect,
  pageSize,
  screenToPdfPoint,
  screenToPdfRect,
  translateQuads,
  unrotateDelta,
  type PageGeom,
} from '@/components/tools/pdf/editor/geometry';
import { pageHasText, RUN_GAP_EM, snapTextLines } from '@/components/tools/pdf/editor/quads';
import {
  MAX_HISTORY,
  canRedo,
  canUndo,
  createHistory,
  liveHistory,
  pushHistory,
  redoHistory,
  settleHistory,
  undoHistory,
} from '@/components/tools/pdf/editor/history';
import {
  annotationRotation,
  annotationToSpec,
  buildAnnotation,
  describeAnnotation,
  exportPlan,
  moveAnnotation,
  redactionNeedsRasterising,
  workSignature,
  withText,
} from '@/components/tools/pdf/editor/specs';
import {
  TOOLS,
  TOOL_BY_ID,
  defaultStyleFor,
} from '@/components/tools/pdf/editor/tools';
import AnnotationEditor from '@/components/tools/pdf/editor/AnnotationEditor';
import type { EditorAnnotation, EditorToolId, PlacedRaster, ToolStyle } from '@/components/tools/pdf/editor/types';

/* ------------------------------------------------------------------ *
 * Fixtures                                                            *
 * ------------------------------------------------------------------ */

const PAGE_W = 612;
const PAGE_H = 792;

/** A US-letter page drawn at 1 CSS px per point, not rotated. */
const flat: PageGeom = { zoom: 1, cssWidth: PAGE_W, cssHeight: PAGE_H, rotation: 0 };

const geomAt = (zoom: number, rotation: PageGeom['rotation'] = 0): PageGeom => {
  const swap = rotation === 90 || rotation === 270;
  return {
    zoom,
    cssWidth: (swap ? PAGE_H : PAGE_W) * zoom,
    cssHeight: (swap ? PAGE_W : PAGE_H) * zoom,
    rotation,
  };
};

function word(
  str: string,
  x: number,
  yTop: number,
  w: number,
  h: number,
  extra: Partial<ExtractedTextItem> = {},
): ExtractedTextItem {
  return {
    str,
    transform: [h, 0, 0, h, x, yTop],
    width: w,
    height: h,
    fontName: 'F1',
    dir: 'ltr',
    page: 1,
    x,
    y: yTop,
    w,
    h,
    hasEOL: false,
    isInvisible: false,
    ...extra,
  };
}

/** Two lines of body text plus a tall descender, in viewport space. */
function pageText(): ExtractedTextItem[] {
  return [
    word('The', 70, 100, 22, 11),
    word('quick', 96, 100, 34, 11),
    word('brown', 134, 100, 36, 11),
    word('fox', 174, 98, 26, 15, { hasEOL: true }),
    word('jumps', 70, 120, 38, 11),
    word('over', 112, 120, 28, 11),
    word('the', 144, 120, 20, 11),
    word('lazy', 168, 118, 24, 14),
    word('   ', 70, 140, 40, 11),
  ];
}

/**
 * The CV's header row as `pdf.js` reports it: a name at the left margin and a
 * date at the right, one baseline, 180 pt of empty paper between the two runs.
 */
function headerRow(): ExtractedTextItem[] {
  return [
    word('Muhammad Luqman Hakim Razlan', 50, 111, 156.7, 10),
    word('Submitted May 18, 2026 · 04:12 PM', 386.7, 111, 159.5, 10, { hasEOL: true }),
  ];
}

const raster = (over: Partial<PlacedRaster> = {}): PlacedRaster => ({
  bytes: new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]),
  url: 'data:image/jpeg;base64,/9j/',
  width: 200,
  height: 100,
  ...over,
});

function build(
  tool: EditorToolId,
  over: Partial<Parameters<typeof buildAnnotation>[0]> = {},
  style: Partial<ToolStyle> = {},
): EditorAnnotation | null {
  return buildAnnotation({
    tool,
    page: 0,
    style: { ...defaultStyleFor(tool), ...style },
    geom: flat,
    ...over,
  });
}

/* ------------------------------------------------------------------ *
 * 1. Coordinate transforms                                            *
 * ------------------------------------------------------------------ */

describe('screen ↔ PDF coordinate transforms', () => {
  it('flips a point about the page height at 100%', () => {
    expect(screenToPdfPoint({ x: 10, y: 20 }, flat)).toEqual({ x: 10, y: PAGE_H - 20 });
  });

  it('divides by the zoom before flipping', () => {
    const zoomed = geomAt(2);
    expect(screenToPdfPoint({ x: 20, y: 40 }, zoomed)).toEqual({ x: 10, y: PAGE_H - 20 });
  });

  it('maps a drag rectangle to a bottom-left rect', () => {
    expect(screenToPdfRect({ x: 100, y: 100, width: 200, height: 80 }, flat)).toEqual({
      x: 100,
      y: PAGE_H - 100 - 80,
      width: 200,
      height: 80,
    });
  });

  it('round-trips a rect through the screen space at any zoom', () => {
    for (const zoom of [0.5, 1, 1.75, 4]) {
      const geom = geomAt(zoom);
      const rect = { x: 12, y: 34, width: 56, height: 78 };
      const back = pdfToScreenRect(screenToPdfRect(rect, geom), geom);
      expect(back.x).toBeCloseTo(rect.x, 6);
      expect(back.y).toBeCloseTo(rect.y, 6);
      expect(back.width).toBeCloseTo(rect.width, 6);
      expect(back.height).toBeCloseTo(rect.height, 6);
    }
  });

  it('reports the unrotated page size for every rotation', () => {
    for (const rotation of [0, 90, 180, 270] as const) {
      const size = pageSize(geomAt(1, rotation));
      expect(size).toEqual({ width: PAGE_W, height: PAGE_H });
    }
  });

  it('rotates screen points into PDF space the way a viewer displays them', () => {
    // 90° clockwise: the page's lower-left corner appears at the viewport's
    // top-left, so a point near the top-left lands at low x, low y in PDF space.
    expect(screenToPdfPoint({ x: 100, y: 50 }, geomAt(1, 90))).toEqual({ x: 50, y: 100 });
    expect(screenToPdfPoint({ x: 0, y: 0 }, geomAt(1, 180))).toEqual({ x: PAGE_W, y: 0 });
    expect(screenToPdfPoint({ x: 0, y: 0 }, geomAt(1, 270))).toEqual({ x: PAGE_W, y: PAGE_H });
    expect(screenToPdfPoint({ x: 0, y: 0 }, geomAt(1, 90))).toEqual({ x: 0, y: 0 });
    expect(screenToPdfPoint({ x: 700, y: 500 }, geomAt(1, 90))).toEqual({ x: 500, y: 700 });
  });

  it('keeps the point mapping invertible on a rotated page', () => {
    for (const rotation of [0, 90, 180, 270] as const) {
      const geom = geomAt(1.5, rotation);
      const screen = { x: 250, y: 120 };
      const pdf = screenToPdfPoint(screen, geom);
      const back = pdfToScreenPoint(pdf, geom);
      expect(back.x).toBeCloseTo(screen.x, 6);
      expect(back.y).toBeCloseTo(screen.y, 6);
    }
  });

  it('bounds a rotated rect on screen instead of shearing it', () => {
    const rect = { x: 100, y: 200, width: 150, height: 40 };
    const screen = pdfToScreenRect(screenToPdfRect(rect, geomAt(1, 90)), geomAt(1, 90));
    expect(screen.width).toBeCloseTo(150, 6);
    expect(screen.height).toBeCloseTo(40, 6);
  });

  it('writes quads in PDF order (upper-left, upper-right, lower-left, lower-right)', () => {
    const quad = pdfQuadFromViewportBox({ x0: 70, y0: 100, x1: 200, y1: 112 }, flat);
    expect(quad).toEqual([70, PAGE_H - 100, 200, PAGE_H - 100, 70, PAGE_H - 112, 200, PAGE_H - 112]);
  });

  it('turns two screen corners into a normalised drag rect', () => {
    expect(normaliseDrag({ x: 80, y: 60 }, { x: 20, y: 10 })).toEqual({ x: 20, y: 10, width: 60, height: 50 });
  });

  it('clamps zoom to 50–400% and fits a page to the pane width', () => {
    expect(clampZoom(0.1)).toBe(MIN_ZOOM);
    expect(clampZoom(99)).toBe(MAX_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(fitWidthZoom(1224, PAGE_W)).toBeCloseTo((1224 - 48) / PAGE_W, 6);
    // A pane narrower than the minimum zoom still lands inside the range.
    expect(fitWidthZoom(100, PAGE_W)).toBe(MIN_ZOOM);
    expect(fitWidthZoom(6000, 60)).toBe(MAX_ZOOM);
    expect(fitWidthZoom(0, PAGE_W)).toBe(1);
  });

  it('centres a default box on a click and preserves a raster aspect ratio', () => {
    expect(centeredRect({ x: 300, y: 400 }, 26, 26)).toEqual({ x: 287, y: 387, width: 26, height: 26 });
    const placed = fitRectInBox({ width: 200, height: 100 }, { x: 0, y: 0, width: 100, height: 100 });
    expect(placed.width).toBeCloseTo(100, 6);
    expect(placed.height).toBeCloseTo(50, 6);
    expect(placed.y).toBeCloseTo(25, 6);
  });

  it('translates every point list of an annotation together', () => {
    const annotation: EditorAnnotation = {
      id: 'a',
      kind: 'Highlight',
      tool: 'highlight',
      page: 1,
      rect: { x: 10, y: 20, width: 30, height: 8 },
      color: '#000000',
      borderWidth: 1,
      opacity: 1,
      createdAt: 0,
      quadPoints: [10, 28, 40, 28, 10, 20, 40, 20],
      inkPath: [[[10, 20], [40, 28]]],
      lineEnds: [10, 20, 40, 28],
    };
    const moved = moveAnnotation(annotation, 5, -3);
    expect(moved.rect).toEqual({ x: 15, y: 17, width: 30, height: 8 });
    expect(moved.quadPoints).toEqual([15, 25, 45, 25, 15, 17, 45, 17]);
    expect(moved.inkPath).toEqual([[[15, 17], [45, 25]]]);
    expect(moved.lineEnds).toEqual([15, 17, 45, 25]);
    expect(translateQuads([1, 2, 3, 4], 1, -1)).toEqual([2, 1, 4, 3]);
    // Moving by zero must not clone, or React would re-render on every hover.
    expect(moveAnnotation(annotation, 0, 0)).toBe(annotation);
  });
});

/* ------------------------------------------------------------------ *
 * 2. Undo / redo                                                      *
 * ------------------------------------------------------------------ */

describe('undo/redo stack', () => {
  const list = (...ids: string[]) => ids.map((id) => ({ id }));

  it('walks backwards and forwards without losing a branch', () => {
    let history = createHistory<ReturnType<typeof list>>(list('a'));
    expect(canUndo(history)).toBe(false);
    expect(canRedo(history)).toBe(false);

    history = pushHistory(history, list('a', 'b'));
    history = pushHistory(history, list('a', 'b', 'c'));
    expect(history.present.map((i) => i.id)).toEqual(['a', 'b', 'c']);

    history = undoHistory(history);
    expect(history.present.map((i) => i.id)).toEqual(['a', 'b']);
    history = undoHistory(history);
    expect(history.present.map((i) => i.id)).toEqual(['a']);
    expect(canUndo(history)).toBe(false);
    expect(undoHistory(history)).toBe(history);

    history = redoHistory(history);
    expect(history.present.map((i) => i.id)).toEqual(['a', 'b']);
    history = redoHistory(history);
    expect(history.present.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(redoHistory(history)).toBe(history);
  });

  it('drops the redo branch when a new edit follows an undo', () => {
    let history = pushHistory(pushHistory(createHistory(list('a')), list('b')), list('c'));
    history = undoHistory(history);
    expect(canRedo(history)).toBe(true);
    history = pushHistory(history, list('d'));
    expect(canRedo(history)).toBe(false);
    expect(undoHistory(history).present).toEqual(list('b'));
  });

  it('records one undo step per drag, not one per pointer move', () => {
    const before = list('a');
    let history = pushHistory(createHistory<ReturnType<typeof list>>(before), list('a', 'b'));
    const selected = history.present;
    for (const dx of [1, 2, 3, 4, 5]) {
      history = liveHistory(history, selected.map((item) => ({ id: `${item.id}-${dx}` })));
    }
    // Live moves never grow the undo stack…
    expect(history.past.length).toBe(1);
    history = settleHistory(history, before);
    // …and closing the gesture adds exactly one entry.
    expect(history.past.length).toBe(2);
    expect(undoHistory(history).present).toEqual(before);
  });

  it('treats settling onto the same value as a no-op', () => {
    const history = createHistory(list('a'));
    expect(settleHistory(history, history.present)).toBe(history);
    expect(pushHistory(history, history.present)).toBe(history);
  });

  it('keeps one undo entry per keystroke', () => {
    const empty = build('freetext', { drag: { x: 10, y: 10, width: 200, height: 40 } })!;
    let history = createHistory<EditorAnnotation[]>([empty]);
    for (const char of 'hello') {
      const text = (history.present[0].text ?? '') + char;
      history = pushHistory(
        history,
        history.present.map((a) => withText(a, text)),
      );
    }
    expect(history.present[0].text).toBe('hello');
    expect(history.past.length).toBe(5);
    expect(undoHistory(undoHistory(history)).present[0].text).toBe('hel');
  });

  it('bounds the stack so a long session cannot grow without end', () => {
    let history = createHistory<number>(0);
    for (let i = 1; i <= MAX_HISTORY + 60; i += 1) history = pushHistory(history, i);
    expect(history.past.length).toBe(MAX_HISTORY);
    expect(history.present).toBe(MAX_HISTORY + 60);
  });
});

/* ------------------------------------------------------------------ *
 * 3. Snapping a drag to text lines                                    *
 * ------------------------------------------------------------------ */

describe('quad snapping from ExtractedTextItem[]', () => {
  it('detects whether a page carries selectable text', () => {
    expect(pageHasText(pageText())).toBe(true);
    expect(pageHasText([word('  ', 10, 10, 5, 5), word('', 20, 10, 5, 5)])).toBe(false);
    expect(pageHasText([])).toBe(false);
    // An invisible OCR layer is still selectable text.
    expect(pageHasText([word('scanned', 10, 10, 40, 8, { isInvisible: true })])).toBe(true);
  });

  it('merges the words of one line into a single spanning quad', () => {
    const lines = snapTextLines(pageText(), { x0: 96, y0: 99, x1: 110, y1: 111 });
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('quick');
    // A drag that starts mid-word takes that word, not the whole line.
    const whole = snapTextLines(pageText(), { x0: 70, y0: 99, x1: 200, y1: 111 });
    expect(whole).toHaveLength(1);
    expect(whole[0]).toMatchObject({ x0: 70, x1: 200, text: 'The quick brown fox' });
  });

  it('uses the tallest glyph box on the line so descenders are covered', () => {
    const [line] = snapTextLines(pageText(), { x0: 60, y0: 116, x1: 200, y1: 135 });
    // The runs on this line report one em of box *above* their baseline — `jumps`
    // is 11 pt tall standing on 131, `lazy` is 14 pt tall standing on 132 — so the
    // line takes the taller em and is re-anchored to put the baseline
    // TEXT_BASELINE_SHARE of the way down the box. That is what keeps the tails of
    // `j` and `y` inside the mark instead of under it; the box the text layer
    // reports ends at the feet of the letters.
    const baseline = 132;
    const em = 14;
    expect(line.y0).toBeCloseTo(baseline - TEXT_BASELINE_SHARE * em, 6);
    expect(line.y1).toBeCloseTo(baseline + (1 - TEXT_BASELINE_SHARE) * em, 6);
    expect(line.y1).toBeGreaterThan(baseline);
    expect(line.text).toBe('jumps over the lazy');
  });

  it('returns one quad per line, top to bottom, for a multi-line drag', () => {
    const lines = snapTextLines(pageText(), { x0: 60, y0: 95, x1: 210, y1: 140 });
    expect(lines.map((l) => l.text)).toEqual(['The quick brown fox', 'jumps over the lazy']);
    expect(lines[0].y0).toBeLessThan(lines[1].y0);
  });

  it('snaps a click to the line under it', () => {
    const lines = snapTextLines(pageText(), { x0: 150, y0: 104, x1: 150, y1: 104 });
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toContain('brown');
  });

  it('ignores whitespace-only runs and reports a miss', () => {
    expect(snapTextLines(pageText(), { x0: 300, y0: 400, x1: 340, y1: 420 })).toEqual([]);
    expect(snapTextLines(pageText(), { x0: 60, y0: 138, x1: 120, y1: 150 })).toEqual([]);
  });

  it('skips degenerate boxes that carry no geometry', () => {
    const items = [word('ok', 10, 10, 0, 8), word('ok2', 10, 10, 8, 0), word('real', 20, 30, 20, 9)];
    const lines = snapTextLines(items, { x0: 0, y0: 0, x1: 300, y1: 300 });
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('real');
  });

  it('splits one baseline into one quad per contiguous run group', () => {
    // The bug a screenshot caught and no user reported: on a row that carries a
    // name at the left margin and a date at the right, one box meant a mark
    // painted across 180 pt of empty paper. PDF 32000-1 Table 171 allows n
    // quadrilaterals each covering "a word or group of contiguous words", so this
    // is one annotation with one quad per run group.
    const lines = snapTextLines(headerRow(), { x0: 40, y0: 108, x1: 560, y1: 124 });
    expect(lines.map((line) => line.text)).toEqual([
      'Muhammad Luqman Hakim Razlan',
      'Submitted May 18, 2026 · 04:12 PM',
    ]);
    expect(lines[0]).toMatchObject({ x0: 50, x1: 206.7 });
    expect(lines[1]).toMatchObject({ x0: 386.7, x1: 546.2 });
    // The whitespace between them belongs to neither quad …
    expect(lines[0].x1).toBeLessThan(lines[1].x0);
    // … while both are still the same visual line: one baseline, one vertical box.
    expect(lines[0].y0).toBeCloseTo(lines[1].y0, 6);
    expect(lines[0].y1).toBeCloseTo(lines[1].y1, 6);
    // The threshold is measured against the runs' own em, so ordinary word spacing
    // (4 pt at an 11 pt em in `pageText`) stays one group — see `RUN_GAP_EM`.
    expect(RUN_GAP_EM).toBeGreaterThan(4 / 11);
    expect(snapTextLines(pageText(), { x0: 70, y0: 99, x1: 200, y1: 111 })).toHaveLength(1);
  });

  it('takes only the run groups a drag reaches', () => {
    const label = snapTextLines(headerRow(), { x0: 40, y0: 108, x1: 220, y1: 124 });
    expect(label.map((line) => line.text)).toEqual(['Muhammad Luqman Hakim Razlan']);
    const date = snapTextLines(headerRow(), { x0: 400, y0: 108, x1: 500, y1: 124 });
    expect(date.map((line) => line.text)).toEqual(['Submitted May 18, 2026 · 04:12 PM']);
  });

  it('widens a middle line into its run groups, not across the gap', () => {
    // A narrow band crossing three lines: the middle line is still covered past the
    // drag's x-range (the selection continues there) but it is covered as its two
    // run groups, so the empty column inside the line stays paper.
    const items = [
      word('first line', 70, 100, 50, 11, { hasEOL: true }),
      word('Middle label', 60, 120, 60, 11),
      word('value', 300, 120, 40, 11, { hasEOL: true }),
      word('last line', 70, 140, 50, 11),
    ];
    const lines = snapTextLines(items, { x0: 95, y0: 98, x1: 105, y1: 150 });
    expect(lines.map((line) => line.text)).toEqual(['first line', 'Middle label', 'value', 'last line']);
    expect(lines[1]).toMatchObject({ x0: 60, x1: 120 });
    expect(lines[2]).toMatchObject({ x0: 300, x1: 340 });
    // Both runs of the middle line keep that line's baseline.
    expect(lines[1].y1).toBeCloseTo(lines[2].y1, 6);
    // Reading order top to bottom, and left to right within one baseline.
    for (let i = 1; i < lines.length; i += 1) expect(lines[i].y0).toBeGreaterThanOrEqual(lines[i - 1].y0);
  });
});

/* ------------------------------------------------------------------ *
 * 4. Spec construction from a gesture                                 *
 * ------------------------------------------------------------------ */

describe('building annotations from gestures', () => {
  it('snaps markup to text and records the covered words', () => {
    const lines = snapTextLines(pageText(), { x0: 60, y0: 95, x1: 210, y1: 140 });
    const highlight = build('highlight', { drag: { x: 60, y: 95, width: 150, height: 45 }, lines })!;
    expect(highlight.kind).toBe('Highlight');
    expect(highlight.quadPoints).toHaveLength(16);
    expect(highlight.snapText).toBe('The quick brown fox jumps over the lazy');
    // /Rect must contain every quad. Line one stands on 113 with a 15 pt em and
    // line two on 132 with a 14 pt one, so the re-anchored union is 101..134.8.
    expect(highlight.rect.x).toBeCloseTo(70, 0);
    expect(highlight.rect.width).toBeGreaterThanOrEqual(130);
    expect(highlight.rect.y).toBeCloseTo(PAGE_H - 134.8, 1);
    expect(highlight.rect.y + highlight.rect.height).toBeCloseTo(PAGE_H - 101, 1);
    expect(annotationToSpec(highlight).quadPoints).toHaveLength(16);

    const underline = build('underline', { drag: { x: 60, y: 95, width: 150, height: 45 }, lines })!;
    expect(underline.kind).toBe('Underline');
    expect(underline.borderWidth).toBeGreaterThanOrEqual(0.6);
    expect(build('strike', { drag: { x: 60, y: 95, width: 150, height: 45 }, lines })!.kind).toBe('StrikeOut');
  });

  it('refuses markup with no text to sit on', () => {
    expect(build('highlight', { drag: { x: 60, y: 95, width: 150, height: 45 }, lines: [] })).toBeNull();
    expect(build('underline', { drag: { x: 60, y: 95, width: 150, height: 45 } })).toBeNull();
  });

  it('builds a rectangle from a drag, filled only when the toggle is on', () => {
    const stroke = build('square', { drag: { x: 100, y: 100, width: 200, height: 80 } })!;
    expect(stroke.kind).toBe('Square');
    expect(stroke.rect).toEqual({ x: 100, y: 612, width: 200, height: 80 });
    expect(stroke.fillColor).toBeUndefined();
    expect(stroke.borderColor).toBe(stroke.color);

    const filled = build('square', { drag: { x: 100, y: 100, width: 200, height: 80 } }, { filled: true })!;
    expect(filled.fillColor).toBe(defaultStyleFor('square').fillColor);
    expect(annotationToSpec(filled).fillColor).toBe(filled.fillColor);

    expect(build('circle', { drag: { x: 10, y: 10, width: 50, height: 50 } })!.kind).toBe('Circle');
  });

  it('falls back to a per-tool default box when the gesture is a click', () => {
    const note = build('note', { drag: { x: 300, y: 400, width: 0, height: 0 } })!;
    expect(note.kind).toBe('Text');
    expect(note.rect).toEqual({ x: 287, y: PAGE_H - 413, width: 26, height: 26 });
    expect(annotationToSpec(note).contents).toBeUndefined();

    const box = build('freetext', { drag: { x: 100, y: 100, width: 1, height: 1 }, text: 'hi' })!;
    expect(box.rect.width).toBe(240);
    expect(annotationToSpec(box).freeText).toMatchObject({ text: 'hi', fontSize: 12, background: '#FFFFFF' });
  });

  it('gives a free text box a border only when the stroke is visible', () => {
    const plain = build('freetext', { drag: { x: 10, y: 10, width: 200, height: 40 } }, { strokeWidth: 0 })!;
    expect(plain.borderColor).toBeUndefined();
    expect(annotationToSpec(plain).freeText?.border).toBe(false);
    const drawn = build('freetext', { drag: { x: 10, y: 10, width: 200, height: 40 } }, { strokeWidth: 2 })!;
    expect(annotationToSpec(drawn).freeText?.border).toBe(true);
  });

  it('draws a freehand stroke into a padded rect', () => {
    const ink = build('ink', { points: [{ x: 100, y: 200 }, { x: 120, y: 210 }, { x: 140, y: 190 }] }, { strokeWidth: 4 })!;
    expect(ink.kind).toBe('Ink');
    expect(ink.inkPath?.[0]).toHaveLength(3);
    expect(ink.rect.x).toBeLessThan(100);
    expect(ink.rect.x + ink.rect.width).toBeGreaterThan(140);
    // Every stored point has to fall inside /Rect, or the appearance clips it.
    for (const [x, y] of ink.inkPath![0]) {
      expect(x).toBeGreaterThanOrEqual(ink.rect.x);
      expect(x).toBeLessThanOrEqual(ink.rect.x + ink.rect.width);
      expect(y).toBeGreaterThanOrEqual(ink.rect.y);
      expect(y).toBeLessThanOrEqual(ink.rect.y + ink.rect.height);
    }
    expect(build('ink', { points: [{ x: 10, y: 10 }] })).toBeNull();
  });

  it('needs three corners for a closed shape and two for a freeform line', () => {
    const two = [
      { x: 10, y: 10 },
      { x: 50, y: 40 },
    ];
    expect(build('polygon', { points: two })).toBeNull();
    expect(build('polygon', { points: [...two, { x: 90, y: 10 }] })!.kind).toBe('Polygon');
    expect(build('polyline', { points: two })!.kind).toBe('PolyLine');
  });

  it('builds a line with its ends and an arrow with a head', () => {
    const line = build('line', { points: [{ x: 10, y: 20 }, { x: 110, y: 120 }] })!;
    expect(line.kind).toBe('Line');
    expect(line.lineEnds).toEqual([10, PAGE_H - 20, 110, PAGE_H - 120]);
    expect(annotationToSpec(line).lineArrow).toBe('none');

    const arrow = build('arrow', { points: [{ x: 10, y: 20 }, { x: 110, y: 120 }] })!;
    expect(arrow.kind).toBe('Arrow');
    expect(annotationToSpec(arrow).lineArrow).toBe('end');
    // The head is drawn inside the appearance box, so the rect grows around it.
    expect(arrow.rect.width).toBeGreaterThan(100);

    expect(build('arrow', { points: [{ x: 10, y: 20 }, { x: 10.5, y: 20.5 }] })).toBeNull();
  });

  it('places stamps, images and signatures as /Stamp with an appearance', () => {
    const stamp = build('stamp', { drag: { x: 50, y: 50, width: 140, height: 40 } }, { stampName: 'Confidential' })!;
    expect(stamp.kind).toBe('Stamp');
    expect(annotationToSpec(stamp).stampName).toBe('Confidential');
    expect(annotationToSpec(stamp).stampImage).toBeUndefined();

    const image = build('image', { drag: { x: 0, y: 0, width: 100, height: 100 }, raster: raster() })!;
    expect(image.rect.width).toBeCloseTo(100, 3);
    expect(image.rect.height).toBeCloseTo(50, 3);
    expect(annotationToSpec(image).stampImage).toBeInstanceOf(Uint8Array);

    // Image and signature tools have nothing to place until a raster exists.
    expect(build('image', { drag: { x: 0, y: 0, width: 100, height: 100 } })).toBeNull();
    expect(build('signature', { drag: { x: 0, y: 0, width: 100, height: 100 } })).toBeNull();
    const signed = build('signature', {
      drag: { x: 0, y: 0, width: 200, height: 80 },
      raster: raster({ width: 400, height: 100 }),
    })!;
    expect(signed.rect.height).toBeCloseTo(50, 3);
  });

  it('needs a target before a link can exist', () => {
    const drag = { x: 10, y: 20, width: 60, height: 12 };
    expect(build('link', { drag })).toBeNull();
    const uri = build('link', { drag, link: { type: 'uri', uri: 'https://example.com' } })!;
    expect(uri.kind).toBe('Link');
    expect(annotationToSpec(uri).link).toEqual({ type: 'uri', uri: 'https://example.com' });
    const jump = build('link', { drag, link: { type: 'goTo', page: 3 } })!;
    expect(annotationToSpec(jump).link).toEqual({ type: 'goTo', page: 3 });
  });

  it('burns redactions at full opacity and pairs them for applyRedactions', () => {
    const redact = build('redact', { drag: { x: 70, y: 98, width: 130, height: 38 } }, { color: '#000000', opacity: 0.4 })!;
    expect(redact.kind).toBe('Redact');
    expect(redact.opacity).toBe(1);
    expect(redact.fillColor).toBe('#000000');

    const plan = exportPlan([redact, build('square', { drag: { x: 1, y: 1, width: 20, height: 20 } })!]);
    expect(plan.specs).toHaveLength(2);
    expect(plan.redactions).toEqual([{ page: 0, rect: redact.rect }]);
    expect(plan.counts).toMatchObject({ total: 2, redactions: 1 });
    expect(plan.counts.byKind).toEqual([
      { kind: 'Redact', count: 1 },
      { kind: 'Square', count: 1 },
    ]);
    expect(annotationToSpec(redact).redact).toBe(true);
  });

  it('describes an annotation for the layer list', () => {
    const highlight = build(
      'highlight',
      {
        drag: { x: 60, y: 95, width: 150, height: 45 },
        lines: snapTextLines(pageText(), { x0: 60, y0: 95, x1: 210, y1: 140 }),
      },
    )!;
    expect(describeAnnotation(highlight)).toContain('Highlight');
    expect(describeAnnotation(highlight)).toContain('p.1');
    expect(describeAnnotation(highlight)).toContain('quick');
    expect(describeAnnotation(build('note', { drag: { x: 1, y: 1, width: 20, height: 20 } })!)).toContain('Note');
    expect(describeAnnotation(build('link', { drag: { x: 1, y: 1, width: 20, height: 20 }, link: { type: 'uri', uri: 'https://a.b' } })!)).toContain('https://a.b');
  });

  it('tracks unsaved work through geometry and text edits only', () => {
    const one = build('square', { drag: { x: 10, y: 10, width: 40, height: 40 } })!;
    const two = build('square', { drag: { x: 90, y: 90, width: 40, height: 40 } })!;
    expect(workSignature([])).toBe(workSignature([]));
    expect(workSignature([one])).not.toBe(workSignature([]));
    expect(workSignature([one, two])).toBe(workSignature([two, one]));
    expect(workSignature([one])).not.toBe(workSignature([moveAnnotation(one, 1, 0)]));
    expect(workSignature([one])).not.toBe(workSignature([{ ...one, color: '#123456' }]));
    const text = build('freetext', { drag: { x: 1, y: 1, width: 100, height: 20 }, text: 'a' })!;
    expect(workSignature([text])).not.toBe(workSignature([withText(text, 'ab')]));
    // A different raster (by encoded size) is a real change; a re-created
    // preview URL or timestamp is not.
    const picture = build('image', {
      drag: { x: 1, y: 1, width: 100, height: 20 },
      raster: raster(),
    })!;
    expect(workSignature([picture])).toBe(
      workSignature([{ ...picture, imageUrl: 'blob:other', createdAt: picture.createdAt + 1000 }]),
    );
    expect(workSignature([picture])).not.toBe(
      workSignature([{ ...picture, imageBytes: new Uint8Array(99) }]),
    );
  });

  it('maps every palette entry onto a real annotation subtype', () => {
    const produced = TOOLS.filter((meta) => meta.gesture !== 'none');
    expect(produced.map((meta) => meta.id)).not.toContain('select');
    for (const meta of produced) {
      expect(ANNOTATION_KIND_NAMES).toContain(meta.kind);
    }
    // The three text-markup tools are the only ones that need /QuadPoints.
    expect(produced.filter((meta) => meta.gesture === 'markup').map((meta) => meta.kind).sort()).toEqual([
      'Highlight',
      'StrikeOut',
      'Underline',
    ]);
    // Image, signature and stamp all share the /Stamp subtype and appearance.
    for (const id of ['stamp', 'image', 'signature'] as const) {
      expect(TOOL_BY_ID[id].kind).toBe('Stamp');
      expect(defaultStyleFor(id).opacity).toBeGreaterThan(0);
    }
  });
});

const ANNOTATION_KIND_NAMES: string[] = [
  'Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Text', 'FreeText', 'Ink', 'Square',
  'Circle', 'Line', 'Arrow', 'Polygon', 'PolyLine', 'Stamp', 'Caret', 'Popup', 'Link',
  'Redact', 'Widget',
];

/* ------------------------------------------------------------------ *
 * 5. The built specs against the real writer                          *
 * ------------------------------------------------------------------ */

describe('export compatibility with core/annotations', () => {
  async function annotated(): Promise<{ doc: PDFDocument; specs: AnnotationSpec[] }> {
    const doc = await PDFDocument.create();
    doc.addPage([PAGE_W, PAGE_H]);
    doc.addPage([PAGE_W, PAGE_H]);
    const lines = snapTextLines(pageText(), { x0: 60, y0: 95, x1: 210, y1: 140 });
    const specs = [
      build('highlight', { page: 1, drag: { x: 60, y: 95, width: 150, height: 45 }, lines })!,
      build('underline', { page: 1, drag: { x: 60, y: 118, width: 140, height: 16 }, lines: snapTextLines(pageText(), { x0: 60, y0: 118, x1: 200, y1: 134 }) })!,
      build('strike', { page: 1, drag: { x: 60, y: 118, width: 140, height: 16 }, lines: snapTextLines(pageText(), { x0: 60, y0: 118, x1: 200, y1: 134 }) })!,
      build('note', { page: 1, drag: { x: 300, y: 300, width: 0, height: 0 }, text: 'check this' })!,
      build('freetext', { page: 1, drag: { x: 70, y: 300, width: 200, height: 40 }, text: 'typed here' })!,
      build('ink', { page: 1, points: [{ x: 100, y: 400 }, { x: 130, y: 430 }, { x: 160, y: 400 }] })!,
      build('square', { page: 1, drag: { x: 50, y: 500, width: 120, height: 60 } })!,
      build('circle', { page: 1, drag: { x: 200, y: 500, width: 80, height: 80 } })!,
      build('line', { page: 1, points: [{ x: 60, y: 600 }, { x: 300, y: 640 }] })!,
      build('arrow', { page: 1, points: [{ x: 60, y: 660 }, { x: 300, y: 700 }] })!,
      build('polygon', { page: 1, points: [{ x: 60, y: 200 }, { x: 160, y: 220 }, { x: 120, y: 260 }] })!,
      build('polyline', { page: 1, points: [{ x: 200, y: 200 }, { x: 260, y: 260 }, { x: 320, y: 210 }] })!,
      build('stamp', { page: 1, drag: { x: 400, y: 100, width: 140, height: 40 } })!,
      build('link', { page: 1, drag: { x: 70, y: 95, width: 100, height: 14 }, link: { type: 'goTo', page: 0 } })!,
      build('link', { page: 1, drag: { x: 70, y: 118, width: 100, height: 14 }, link: { type: 'uri', uri: 'https://example.com' } })!,
      build('redact', { page: 1, drag: { x: 70, y: 95, width: 150, height: 45 } })!,
    ].map(annotationToSpec);
    return { doc, specs };
  }

  it('writes every kind the palette can produce', async () => {
    const { doc, specs } = await annotated();
    expect(specs).toHaveLength(16);
    expect(() => addAnnotations(doc, specs)).not.toThrow();
    expect(annotationCount(doc)).toBe(16);

    const bytes = await doc.save({ useObjectStreams: false });
    const reloaded = await PDFDocument.load(bytes);
    const listed = listAnnotations(reloaded);
    const kinds = listed.map((a) => a.kind).sort();
    expect(kinds).toEqual(
      [
        'Arrow', 'Circle', 'FreeText', 'Highlight', 'Ink', 'Line', 'Link', 'Link',
        'Polygon', 'PolyLine', 'Redact', 'Square', 'Stamp', 'StrikeOut', 'Text', 'Underline',
      ].sort(),
    );
    // An arrow round-trips as /Line with /LE heads, which the reader reports back
    // as `Arrow`, so the two must not be confused with one another.
    expect(kinds.filter((k) => k === 'Arrow')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'Line')).toHaveLength(1);
    // Annotations landed on page index 1, and the highlight kept its quads.
    expect(new Set(listed.map((a) => a.page))).toEqual(new Set([1]));
    const highlight = listed.find((a) => a.kind === 'Highlight')!;
    expect(highlight.rect.x).toBeCloseTo(70, 0);
    expect(highlight.rect.width).toBeGreaterThanOrEqual(130);
  });

  it('carries every run group of one line into /QuadPoints', async () => {
    // The overlay and the file have to be one system: a mark over the CV's
    // name+date row is ONE annotation carrying TWO quads, so a viewer paints the
    // words and leaves the 180 pt of paper between them alone.
    const doc = await PDFDocument.create();
    doc.addPage([PAGE_W, PAGE_H]);
    const lines = snapTextLines(headerRow(), { x0: 40, y0: 108, x1: 560, y1: 124 });
    const mark = build('highlight', { page: 0, drag: { x: 40, y: 108, width: 520, height: 16 }, lines })!;
    expect(mark.quadPoints).toHaveLength(16);
    addAnnotations(doc, [annotationToSpec(mark)]);
    expect(annotationCount(doc)).toBe(1);

    const bytes = await doc.save({ useObjectStreams: false });
    const reloaded = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const annots = reloaded.getPage(0).node.Annots();
    expect(annots).toBeTruthy();
    const dict = reloaded.context.lookupMaybe(annots!.get(0), PDFDict);
    expect(dict, 'the annotation did not round-trip as a dictionary').toBeTruthy();
    const flat = (key: string): number[] =>
      (((dict as PDFDict).get(PDFName.of(key)) ?? undefined) as PDFArray)
        .asArray()
        .map((entry) => {
          const value = entry instanceof PDFRef ? reloaded.context.lookup(entry) : entry;
          return (value as PDFNumber).asNumber();
        });
    const points = flat('QuadPoints');
    expect(points).toHaveLength(16);
    // Quad one is the name, quad two the date: the whitespace between them is
    // inside /Rect (which must contain every quad) and inside neither quad.
    const left = (at: number) => Math.min(points[at], points[at + 4]);
    const right = (at: number) => Math.max(points[at + 2], points[at + 6]);
    expect(left(0)).toBeCloseTo(50, 1);
    expect(right(0)).toBeCloseTo(206.7, 1);
    expect(left(8)).toBeCloseTo(386.7, 1);
    expect(right(8)).toBeCloseTo(546.2, 1);
    expect(right(0)).toBeLessThan(left(8));
    const rect = flat('Rect');
    expect(rect[0]).toBeLessThanOrEqual(left(0) + 0.01);
    expect(rect[2]).toBeGreaterThanOrEqual(right(8) - 0.01);
  });

  it('applies the redaction rects it was handed', async () => {
    const { doc, specs } = await annotated();
    const redactions = specs.filter((s) => s.redact).map((s) => ({ page: s.page, rect: s.rect }));
    expect(redactions).toHaveLength(1);
    const outcome = applyRedactions(doc, redactions);
    expect(outcome.rasterised).toBe(false);
    // A blank generated page has no text to delete; the box is still burned in.
    expect(outcome.removed).toBe(0);
    addAnnotations(doc, specs);
    const bytes = await doc.save({ useObjectStreams: false });
    const reloaded = await PDFDocument.load(bytes);
    expect(reloaded.getPageCount()).toBe(2);
    expect(listAnnotations(reloaded).some((a) => a.kind === 'Redact')).toBe(true);
  });

  it('keeps /Rect inside the page it annotates', async () => {
    const { doc, specs } = await annotated();
    addAnnotations(doc, specs);
    for (const annotation of listAnnotations(doc)) {
      expect(annotation.rect.x).toBeGreaterThanOrEqual(0);
      expect(annotation.rect.y).toBeGreaterThanOrEqual(0);
      expect(annotation.rect.x + annotation.rect.width).toBeLessThanOrEqual(PAGE_W + 0.001);
      expect(annotation.rect.y + annotation.rect.height).toBeLessThanOrEqual(PAGE_H + 0.001);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 5b. Winding a quad, and where a rule crosses it                      *
 * ------------------------------------------------------------------ */

describe('painting one markup quad', () => {
  const box = { x0: 40, y0: 100, x1: 200, y1: 114 };
  const numbers = pdfQuadFromViewportBox(box, flat);
  const stored = [
    { x: numbers[0], y: numbers[1] },
    { x: numbers[2], y: numbers[3] },
    { x: numbers[4], y: numbers[5] },
    { x: numbers[6], y: numbers[7] },
  ];

  /** Signed area by the shoelace formula: a rectangle keeps its whole area, a
   * self-intersecting bowtie cancels itself to about nothing. */
  const area = (points: { x: number; y: number }[]): number => {
    let sum = 0;
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      sum += a.x * b.y - b.x * a.y;
    }
    return sum / 2;
  };

  it('stores upper-left, upper-right, lower-left, lower-right — the file order', () => {
    // The order PDF 32000-1 Table 171 wants, and the order `/QuadPoints` is
    // written with. PDF user space grows upward, so the "upper" corners carry the
    // larger y. Painting *this* order is what made the bowtie; see the next test.
    expect(stored.map((p) => [p.x, p.y])).toEqual([[40, 692], [200, 692], [40, 678], [200, 678]]);
    expect(Math.abs(area(stored))).toBeLessThan(1);
  });

  it('walks the ring when it paints, so the quad is a rectangle again', () => {
    const ring = quadRing(stored);
    expect(ring.map((p) => [p.x, p.y])).toEqual([[40, 692], [200, 692], [200, 678], [40, 678]]);
    expect(Math.abs(area(ring))).toBeCloseTo(160 * 14, 6);
    // Every edge of a painted ring runs along one axis: no diagonal, so no bowtie.
    for (let i = 0; i < ring.length; i += 1) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      expect(a.x === b.x || a.y === b.y).toBe(true);
    }
  });

  it('puts the underline under the letter feet and the strike through the bodies', () => {
    const top = stored[0].y;
    const em = top - stored[2].y;
    // The baseline is where `snapTextLines` put it: this far down the quad.
    const baseline = top - TEXT_BASELINE_SHARE * em;
    const under = markupRule(stored, 'Underline', 1);
    const strike = markupRule(stored, 'StrikeOut', 1);
    // Below the baseline (smaller y in PDF space) by the offset plus half the
    // stroke, so the stroke hangs under the line rather than across it.
    expect(under.y1).toBeCloseTo(baseline - (UNDERLINE_BELOW_BASELINE_EM * em + 0.5), 6);
    expect(strike.y1).toBeCloseTo(baseline + STRIKE_ABOVE_BASELINE_EM * em, 6);
    // Both stay inside the quad, which is what keeps the appearance stream from
    // clipping the mark at the edge of its own /Rect.
    for (const rule of [under, strike]) {
      expect(rule.y1).toBeLessThanOrEqual(top + 1e-6);
      expect(rule.y1).toBeGreaterThanOrEqual(top - em - 1e-6);
    }
    // And they are well apart: the complaint this answers was an underline that
    // read as a second strike-through.
    expect(strike.y1 - under.y1).toBeGreaterThan(0.3 * em);
  });

  it('gives the same mark in PDF space and on the screen at any zoom or page turn', () => {
    const geometries: PageGeom[] = [
      flat,
      { ...flat, zoom: 2.5 },
      { ...flat, rotation: 90, cssWidth: flat.cssHeight, cssHeight: flat.cssWidth },
    ];
    const inPdf = markupRule(stored, 'Underline', 1);
    for (const geom of geometries) {
      // The overlay maps the stored corners to pixels first, the writer strokes
      // in points: affine maths means both are the same line, which is the
      // fidelity claim, so check it instead of trusting the comment.
      const onScreen = markupRule(stored.map((p) => pdfToScreenPoint(p, geom)), 'Underline', geom.zoom);
      const from = pdfToScreenPoint({ x: inPdf.x1, y: inPdf.y1 }, geom);
      const to = pdfToScreenPoint({ x: inPdf.x2, y: inPdf.y2 }, geom);
      expect([onScreen.x1, onScreen.y1, onScreen.x2, onScreen.y2]).toEqual([
        expect.closeTo(from.x, 6),
        expect.closeTo(from.y, 6),
        expect.closeTo(to.x, 6),
        expect.closeTo(to.y, 6),
      ]);
    }
  });

  it('keeps one quad per line in a multi-line mark, in the order the file wants', () => {    const lines = snapTextLines(pageText(), { x0: 60, y0: 95, x1: 210, y1: 140 });
    const mark = build('highlight', { drag: { x: 60, y: 95, width: 150, height: 45 }, lines })!;
    const quads = mark.quadPoints!;
    expect(quads).toHaveLength(16);
    for (let at = 0; at < quads.length; at += 8) {
      const q = quads.slice(at, at + 8);
      // UL then UR share the upper edge, LL then LR share the lower one, and the
      // upper pair carry the *larger* y because PDF user space grows upward. That
      // is the stored order, not a ring: `quadRing` is what turns it into one.
      expect(q[1]).toBeCloseTo(q[3], 6);
      expect(q[5]).toBeCloseTo(q[7], 6);
      expect(q[0]).toBeCloseTo(q[4], 6);
      expect(q[2]).toBeCloseTo(q[6], 6);
      expect(q[0]).toBeLessThan(q[2]);
      expect(q[1]).toBeGreaterThan(q[5]);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 5b. A mark turned to an angle                                       *
 * ------------------------------------------------------------------ *
 *
 * A mark is stored unrotated and turned about the centre of its rect, so the
 * overlay, the hit test and the writer all read the same number. These are the
 * seams that claim is checked at: the maths, the spec handed to the writer, and
 * the bytes the writer puts in the file.
 */

/* ------------------------------------------------------------------ *
 * 5a. The ink in the bytes                                            *
 * ------------------------------------------------------------------ *
 *
 * The mark count only says a record was written. What the user sees is the
 * appearance stream, so this decodes it and measures the area it lays down: a
 * rule of no length, a stroke of no width, a path of one point — all of them
 * pass a count test and all of them print an empty page.
 */

/**
 * The appearance operators of a saved annotation — what a viewer paints.
 *
 * Read from the reloaded bytes, not from the object the builder made, and
 * decompressed the way `tests/pdf/annotations.test.ts` does it: a saved stream
 * is a `PDFRawStream` and its `contents` are flated.
 */
function appearanceText(stream: PDFStream): string {
  expect(stream, 'the appearance is not a raw stream in the file').toBeInstanceOf(PDFRawStream);
  return new TextDecoder().decode(decodePDFRawStream(stream as PDFRawStream).decode());
}

/**
 * The area of ink an appearance stream paints, in pt².
 *
 * Strokes count as length × line width, fills as the shoelace area of the path.
 * That is what a viewer puts on paper, and it is the number that must never be
 * zero for a mark the user drew.
 */
function streamPaintedArea(stream: string): number {
  let width = 1;
  let path: { x: number; y: number }[] = [];
  let stack: number[] = [];
  let area = 0;
  const closePath = () => {
    path = [];
    stack = [];
  };
  for (const token of stream.replace(/\n/g, ' ').split(/\s+/)) {
    if (token === '') continue;
    const number = Number(token);
    if (Number.isFinite(number)) {
      stack.push(number);
      continue;
    }
    const point = (at: number) => ({ x: stack[stack.length + at - 1], y: stack[stack.length + at] });
    switch (token) {
      case 'w':
        width = stack[stack.length - 1] || 0;
        break;
      case 'm':
      case 'l':
        if (stack.length >= 2) path.push(point(-1));
        break;
      case 'c':
        // Two control points and the end; the end is the one that extends the path.
        if (stack.length >= 6) path.push(point(-1));
        break;
      case 'v':
      case 'y':
        if (stack.length >= 4) path.push(point(-1));
        break;
      case 'S': {
        let length = 0;
        for (let i = 1; i < path.length; i += 1) {
          length += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
        }
        area += length * Math.max(width, 0.2);
        closePath();
        break;
      }
      case 'f':
      case 'f*':
      case 'B': {
        let twice = 0;
        for (let i = 0; i < path.length; i += 1) {
          const a = path[i];
          const b = path[(i + 1) % path.length];
          twice += a.x * b.y - b.x * a.y;
        }
        area += Math.abs(twice / 2);
        closePath();
        break;
      }
      default:
        stack = [];
    }
  }
  return area;
}

describe('every mark paints an area in the file', () => {
  /** The appearance streams of the annotations, in the order they were written. */
  async function areasOf(marks: EditorAnnotation[]): Promise<number[]> {
    const doc = await PDFDocument.create();
    doc.addPage([PAGE_W, PAGE_H]);
    addAnnotations(doc, marks.map(annotationToSpec));
    const bytes = await doc.save({ useObjectStreams: false });
    const reloaded = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const annots = reloaded.getPage(0).node.Annots();
    expect(annots).toBeTruthy();
    const out: number[] = [];
    for (let i = 0; i < annots!.size(); i += 1) {
      const dict = reloaded.context.lookupMaybe(annots!.get(i), PDFDict);
      expect(dict, `annotation ${i} did not round-trip as a dictionary`).toBeTruthy();
      const ap = (dict as PDFDict).get(PDFName.of('AP'));
      const apDict = reloaded.context.lookupMaybe(ap, PDFDict);
      const streamRef = apDict?.get(PDFName.of('N'));
      const stream = reloaded.context.lookupMaybe(streamRef, PDFStream);
      expect(stream, `annotation ${i} has no /AP /N stream`).toBeTruthy();
      out.push(streamPaintedArea(appearanceText(stream as PDFStream)));
    }
    return out;
  }

  it.each([
    ['highlight', 'Highlight'],
    ['underline', 'Underline'],
    ['strike', 'StrikeOut'],
    ['squiggly', 'Squiggly'],
  ] as const)('%s strokes or fills a real area', async (tool, kind) => {
    const lines = snapTextLines(pageText(), { x0: 60, y0: 118, x1: 200, y1: 134 });
    const base = build(tool === 'squiggly' ? 'underline' : tool, {
      drag: { x: 60, y: 118, width: 140, height: 16 },
      lines,
    })!;
    const mark: EditorAnnotation = kind === base.kind ? base : { ...base, kind };
    const [area] = await areasOf([mark]);
    // The quad spans ~140 pt of a text line; an area this small means the rule
    // collapsed onto itself, which is what "the mark is there but invisible"
    // looks like from the outside.
    expect(area, `${kind} painted ${area}pt² of ink`).toBeGreaterThan(50);
  });

  it('strokes a rule across the whole quad, not a point on it', async () => {
    // The regression this catches: a markup quad whose top and bottom edges were
    // made to coincide puts both ends of `markupRule` on the same spot, and the
    // mark then paints 0pt² while still counting as created.
    const lines = snapTextLines(pageText(), { x0: 60, y0: 118, x1: 200, y1: 134 });
    const mark = build('underline', { drag: { x: 60, y: 118, width: 140, height: 16 }, lines })!;
    const quad = mark.quadPoints!;
    expect(quad[1] - quad[5]).toBeGreaterThan(1); // the quad has a height to mix over
    const rule = markupRule(
      [
        { x: quad[0], y: quad[1] },
        { x: quad[2], y: quad[3] },
        { x: quad[4], y: quad[5] },
        { x: quad[6], y: quad[7] },
      ],
      'Underline',
      mark.borderWidth,
    );
    expect(Math.hypot(rule.x2 - rule.x1, rule.y2 - rule.y1)).toBeGreaterThan(50);
    const areas = await areasOf([mark]);
    expect(areas[0]).toBeGreaterThan(Math.hypot(rule.x2 - rule.x1, rule.y2 - rule.y1) * 0.5);
  });

  it.each([
    ['line', 'Line'],
    ['arrow', 'Arrow'],
  ] as const)('%s keeps a drag end to end and paints it', async (tool, kind) => {
    // A segment tool is armed by a drag, and a drag has a press and a release;
    // the file has to carry the whole distance between them, not a stub.
    const mark = build(tool, {
      points: [{ x: 60, y: 600 }, { x: 300, y: 640 }],
    })!;
    expect(mark.kind).toBe(kind);
    const length = Math.hypot(mark.lineEnds![2] - mark.lineEnds![0], mark.lineEnds![3] - mark.lineEnds![1]);
    expect(length).toBeGreaterThan(200);
    expect(mark.rect.width * mark.rect.height).toBeGreaterThan(200);
    const [area] = await areasOf([mark]);
    expect(area, `${kind} painted ${area}pt² of ink`).toBeGreaterThan(100);
  });
});

describe('a turned mark', () => {
  const rect = { x: 100, y: 200, width: 120, height: 40 };

  it('folds an angle into [0, 360) and snaps a drag to 15°', () => {
    expect(normaliseAngle(-90)).toBe(270);
    expect(normaliseAngle(450)).toBe(90);
    expect(normaliseAngle(Number.NaN)).toBe(0);
    expect(snapAngle(37)).toBe(30);
    expect(snapAngle(7)).toBe(0);
    expect(snapAngle(8)).toBe(15);
    expect(rotationForDrag(37)).toBe(30);
    expect(rotationForDrag(37, true)).toBe(37);
  });

  it('turns a point clockwise about the centre of its own box', () => {
    const centre = rectCentre(rect);
    expect(centre).toEqual({ x: 160, y: 220 });
    // The lower-left corner is west-and-south of the pivot; a clockwise quarter
    // turn (in +y-up user space) brings it north.
    const turned = rotatePointAbout({ x: 100, y: 200 }, centre, 90);
    expect(turned.x).toBeCloseTo(centre.x - 20, 6);
    expect(turned.y).toBeCloseTo(centre.y + 60, 6);
    expect(rotatePointAbout(centre, centre, 37)).toEqual(centre);
    expect(rotatePointAbout({ x: 1, y: 2 }, centre, 0)).toEqual({ x: 1, y: 2 });
  });

  it('bounds the turned shape, and pulls a page delta back into its frame', () => {
    // A wide flat mark swept 45° gets taller and *narrower*; the only honest
    // claim is that /Rect is the corners' bounding box, centred where it was.
    const box = rotatedBounds(rect, 45);
    expect(box.x).toBeCloseTo(103.4315, 3);
    expect(box.width).toBeCloseTo(113.1371, 3);
    expect(box.height).toBeCloseTo(113.1371, 3);
    expect(rectCentre(box).x).toBeCloseTo(rectCentre(rect).x, 6);
    expect(rectCentre(box).y).toBeCloseTo(rectCentre(rect).y, 6);
    // A right angle is exact, because a rect turned 90° is still a rect.
    expect(rotatedBounds(rect, 90)).toEqual({ x: 140, y: 160, width: 40, height: 120 });
    expect(rotatedBounds(rect, 0)).toEqual(rect);
    // A mark turned 90° has its local +y along the page's +x.
    expect(unrotateDelta(10, 0, 90).x).toBeCloseTo(0, 6);
    expect(unrotateDelta(10, 0, 90).y).toBeCloseTo(10, 6);
    expect(unrotateDelta(10, 0, 0)).toEqual({ x: 10, y: 0 });
  });

  it('derives the screen turn from the page axes instead of assuming a sign', () => {
    const straight = markScreenRotation(rect, 0, flat);
    expect(straight.degrees).toBe(0);
    expect(straight.centre).toEqual(pdfToScreenPoint(rectCentre(rect), flat));
    // The angle is measured off the mapped page axes, so the page's own /Rotate
    // shifts every one of them: the same mark reads a quarter turn differently on
    // a turned page, which is what stops the overlay spinning marks the wrong way.
    expect([0, 90, 180, 270].map((deg) => markScreenRotation(rect, deg, flat).degrees)).toEqual([
      0, 90, 180, -90,
    ]);
    expect([0, 90, 180, 270].map((deg) => markScreenRotation(rect, deg, geomAt(1, 90)).degrees)).toEqual([
      0, 180, -90, 0,
    ]);
    expect(markScreenRotation(rect, 90, flat).centre).toEqual(pdfToScreenPoint(rectCentre(rect), flat));
    // The arc a rotate handle reads is the screen angle of the pointer.
    expect(screenAngle({ x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(0, 6);
    expect(screenAngle({ x: 0, y: 0 }, { x: 0, y: 10 })).toBeCloseTo(90, 6);
  });

  it('carries the angle to the writer rather than pre-turning the geometry', () => {
    const square = build('square', { drag: { x: 50, y: 500, width: 120, height: 60 } })!;
    expect(annotationToSpec(square).rotation).toBeUndefined();
    expect(annotationToSpec({ ...square, rotation: 0 }).rotation).toBeUndefined();
    const spec = annotationToSpec({ ...square, rotation: 45 });
    expect(spec.rotation).toBe(45);
    // The shape still travels exactly as drawn: /Rect, the quads and the stream
    // are turned by the writer, which is the only place that can keep them in step.
    expect(spec.rect).toEqual(square.rect);
    expect(spec.quadPoints).toEqual(square.quadPoints);
    expect(annotationRotation({ ...square, rotation: 405 })).toBe(45);
  });

  it('writes the turned box the overlay drew, into the file', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([PAGE_W, PAGE_H]);
    const square = build('square', { drag: { x: 50, y: 500, width: 120, height: 60 } })!;
    addAnnotations(doc, [annotationToSpec({ ...square, rotation: 45 })]);
    const reloaded = await PDFDocument.load(await doc.save({ useObjectStreams: false }));
    const [written] = listAnnotations(reloaded);
    const box = rotatedBounds(square.rect, 45);
    expect(written.rect.x).toBeCloseTo(box.x, 1);
    expect(written.rect.y).toBeCloseTo(box.y, 1);
    expect(written.rect.width).toBeCloseTo(box.width, 1);
    expect(written.rect.height).toBeCloseTo(box.height, 1);
    // And the same mark with no angle is untouched by any of this: that is the
    // regression this whole path has to avoid.
    const plain = await PDFDocument.create();
    plain.addPage([PAGE_W, PAGE_H]);
    addAnnotations(plain, [annotationToSpec(square)]);
    const [straight] = listAnnotations(plain);
    expect(straight.rect).toEqual(square.rect);
    expect(straight.rotation).toBe(0);
  });

  it('burns a turned redaction by pixels instead of cutting a box that is too big', () => {
    const burn = build('redact', { drag: { x: 70, y: 95, width: 150, height: 45 } })!;
    expect(redactionNeedsRasterising(burn)).toBe(false);
    expect(exportPlan([burn]).redactions).toHaveLength(1);
    expect(exportPlan([burn]).rasterisations).toHaveLength(0);
    const turned = exportPlan([{ ...burn, rotation: 30 }]);
    expect(turned.redactions).toHaveLength(0);
    expect(turned.rasterisations).toHaveLength(1);
    expect(turned.rasterisations[0].quad).toHaveLength(8);
    expect(turned.rasterisations[0].rect).toEqual(rotatedBounds(burn.rect, 30));
    // A right angle still cuts: a rect turned 90° is still a rect.
    expect(exportPlan([{ ...burn, rotation: 90 }]).redactions).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * 6. The component contract (no canvas needed for the empty pane)     * 
 * ------------------------------------------------------------------ */

describe('AnnotationEditor component', () => {
  it('exports itself the way registry.ts lazy-imports it', async () => {
    const module = await import('@/components/tools/pdf/editor/AnnotationEditor');
    expect(typeof module.default).toBe('function');
    expect(module.default).toBe(module.AnnotationEditor);
  });

  it('shows a real empty state, the full palette and an in-memory notice', () => {
    render(createElement(AnnotationEditor));
    expect(screen.getByText('Annotate, highlight, redact, comment')).toBeInTheDocument();
    expect(screen.getByText('In memory only — nothing is saved automatically')).toBeInTheDocument();
    // Every creating tool is reachable before a file is even loaded.
    for (const meta of TOOLS) {
      expect(screen.getByTitle(meta.hint)).toBeInTheDocument();
      expect(screen.getByText(meta.label)).toBeInTheDocument();
    }
    // Export exists but cannot run against an empty document.
    expect(screen.getByRole('button', { name: /Export annotated PDF/ })).toBeDisabled();
  });
});
