/**
 * Pure-logic tests for the in-place PDF text editor model.
 *
 * No canvas and no pdf.js at runtime: `ExtractedTextItem` is a plain object, so
 * the fixtures below are synthesised in the same space pdf.js reports text in
 * (rotated viewer space, origin top-left, one unit per PDF point at scale 1).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ExtractedTextItem } from '@/lib/pdf/core/render';
import { viewerRectToUserSpace, type PageFrame } from '@/lib/pdf/core/tables';
import {
  alignBoxes,
  boxContains,
  canRedo,
  canUndo,
  clampStyle,
  clusterLines,
  clusterParagraphs,
  createHistory,
  DEFAULT_STYLE,
  deletionBoxes,
  distributeBoxes,
  editObjects,
  findRanges,
  fitScale,
  foldForSearch,
  guessAlignment,
  hexToRgb,
  imageMatrix,
  inlineFor,
  joinLines,
  layoutBlock,
  listMarker,
  monospaceMeasure,
  nextObjectId,
  normaliseRuns,
  objectAtPoint,
  paragraphsFromDom,
  paragraphsFromText,
  pushHistory,
  redoHistory,
  replaceInText,
  resetObjectIds,
  rotateBoxAboutCenter,
  rulerTicks,
  samplePalette,
  scopeAllows,
  searchBlocks,
  searchableBlocks,
  textMatrix,
  textOfParagraphs,
  undoHistory,
  unionBoxes,
  viewerBoxToUserSpace,
  viewerToUserMatrix,
  type DocParagraph,
  type EditObject,
  type ExtractedParagraph,
  type TextObject,
} from '@/components/tools/pdf/text-editor/model';

/* ------------------------------------------------------------------ *
 * Fixtures                                                            *
 * ------------------------------------------------------------------ */

function item(overrides: Partial<ExtractedTextItem> & { str: string }): ExtractedTextItem {
  const size = overrides.h ?? 10;
  return {
    transform: [1, 0, 0, 1, overrides.x ?? 0, 0],
    width: overrides.w ?? overrides.str.length * size * 0.5,
    height: size,
    fontName: 'F1',
    dir: 'ltr',
    page: 1,
    x: 0,
    y: 0,
    w: overrides.str.length * size * 0.5,
    h: size,
    hasEOL: false,
    isInvisible: false,
    ...overrides,
  };
}

/** Two wrapped lines of the same paragraph, 10 pt text at the 72 pt margin. */
function wrappedLines(): ExtractedTextItem[] {
  return [
    item({ str: 'The quick brown fox jumps over the lazy dog and', x: 72, y: 100, w: 300, h: 10 }),
    item({ str: 'keeps running to the next line here', x: 72, y: 112, w: 200, h: 10 }),
  ];
}

function textObject(overrides: Partial<TextObject> = {}): TextObject {
  return {
    id: overrides.id ?? nextObjectId('text'),
    page: 1,
    kind: 'text',
    box: { x: 72, y: 100, width: 300, height: 40 },
    rotation: 0,
    flipH: false,
    flipV: false,
    z: 0,
    alt: '',
    state: 'draft',
    paragraphs: paragraphsFromText('hello'),
    style: { ...DEFAULT_STYLE },
    deletion: [],
    patchColor: '#ffffff',
    fromInvisibleLayer: false,
    ...overrides,
  };
}

const frames: PageFrame[] = [
  { x0: 0, y0: 0, width: 612, height: 792, rotation: 0 },
  { x0: 0, y0: 0, width: 612, height: 792, rotation: 90 },
  { x0: 0, y0: 0, width: 612, height: 792, rotation: 180 },
  { x0: 0, y0: 0, width: 612, height: 792, rotation: 270 },
  { x0: 20, y0: 30, width: 400, height: 500, rotation: 0 },
];

beforeEach(() => resetObjectIds());

/* ------------------------------------------------------------------ *
 * Paragraph clustering                                                *
 * ------------------------------------------------------------------ */

describe('paragraph clustering', () => {
  it('joins soft-wrapped lines into one paragraph and rebuilds the text', () => {
    const paragraphs = clusterParagraphs(wrappedLines());
    expect(paragraphs).toHaveLength(1);
    const paragraph = paragraphs[0];
    expect(paragraph.lines).toHaveLength(2);
    expect(paragraph.text).toBe(
      'The quick brown fox jumps over the lazy dog and keeps running to the next line here',
    );
    expect(paragraph.size).toBe(10);
    expect(paragraph.page).toBe(1);
  });

  it('records line offsets inside the paragraph text so hits can be located', () => {
    const [paragraph] = clusterParagraphs(wrappedLines());
    expect(paragraph.lines[0].start).toBe(0);
    expect(paragraph.lines[0].end).toBe(47);
    expect(paragraph.text.slice(paragraph.lines[1].start, paragraph.lines[1].end)).toBe(
      'keeps running to the next line here',
    );
  });

  it('splits two columns of the same row into two paragraphs', () => {
    const items = [
      item({ str: 'left column text', x: 72, y: 100, w: 150, h: 10 }),
      item({ str: 'right column text', x: 320, y: 100, w: 150, h: 10 }),
    ];
    const lines = clusterLines(items);
    expect(lines).toHaveLength(2);
    const paragraphs = clusterParagraphs(items);
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs.map((p) => p.text)).toEqual(['left column text', 'right column text']);
  });

  it('keeps a heading out of the body block below it', () => {
    const items = [
      item({ str: 'Chapter One', x: 72, y: 60, w: 120, h: 24 }),
      item({ str: 'Body text starts here and is much smaller than the heading.', x: 72, y: 96, w: 340, h: 10 }),
    ];
    const paragraphs = clusterParagraphs(items);
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0].size).toBe(24);
    expect(paragraphs[1].size).toBe(10);
  });

  it('splits paragraphs on a blank gap larger than the line pitch', () => {
    const items = [
      item({ str: 'First paragraph body.', x: 72, y: 100, w: 160, h: 10 }),
      item({ str: 'Second paragraph body.', x: 72, y: 160, w: 160, h: 10 }),
    ];
    expect(clusterParagraphs(items)).toHaveLength(2);
  });

  it('treats an indented first line as the same paragraph', () => {
    const items = [
      item({ str: 'The indented opening line of the paragraph runs long', x: 96, y: 100, w: 376, h: 10 }),
      item({ str: 'and the flush-left continuation wraps under it.', x: 72, y: 112, w: 340, h: 10 }),
    ];
    expect(clusterParagraphs(items)).toHaveLength(1);
  });

  it('flags an invisible OCR layer and reports no usable text otherwise', () => {
    const ocr = clusterParagraphs([
      item({ str: 'scanned words', x: 72, y: 100, w: 120, h: 10, isInvisible: true }),
    ]);
    expect(ocr).toHaveLength(1);
    expect(ocr[0].invisible).toBe(true);
    expect(clusterParagraphs([item({ str: '   ' })])).toHaveLength(0);
  });

  it('rebuilds words split across font runs without inventing spaces', () => {
    const items = [
      item({ str: 'hyp', x: 72, y: 100, w: 15, h: 10 }),
      item({ str: 'hen', x: 87.5, y: 100, w: 15, h: 10 }),
      item({ str: 'ated', x: 103, y: 100, w: 20, h: 10 }),
    ];
    expect(clusterParagraphs(items)[0].text).toBe('hyphenated');
  });

  it('undoes a soft hyphen when joining lines', () => {
    expect(joinLines(['Hyphenated exam-', 'ple text']).lines.map((l) => l.text)).toEqual([
      'Hyphenated exam-',
      'ple text',
    ]);
    const [paragraph] = clusterParagraphs([
      item({ str: 'Hyphenated exam-', x: 72, y: 100, w: 120, h: 10 }),
      item({ str: 'ple text continues', x: 72, y: 112, w: 130, h: 10 }),
    ]);
    expect(paragraph.text).toBe('Hyphenated example text continues');
  });

  it('keeps a real hyphen that is followed by a capital', () => {
    const joined = joinLines(['e-', 'Mail']);
    expect(joined.text).toBe('e- Mail');
    expect(joined.lines[1].start).toBe(3);
  });

  it('emits one padded deletion box per line', () => {
    const [paragraph] = clusterParagraphs(wrappedLines());
    const boxes = deletionBoxes(paragraph, 1);
    expect(boxes).toHaveLength(2);
    expect(boxes[0].x).toBeCloseTo(71, 6);
    expect(boxes[0].width).toBeCloseTo(302, 6);
  });
});

/* ------------------------------------------------------------------ *
 * Geometry: viewer space <-> user space                               *
 * ------------------------------------------------------------------ */

describe('page geometry', () => {
  it('agrees with core/tables.viewerRectToUserSpace for every quarter turn', () => {
    const box = { x: 100, y: 200, width: 120, height: 24 };
    for (const frame of frames) {
      expect(viewerBoxToUserSpace(box, frame)).toEqual(viewerRectToUserSpace(box, frame));
    }
  });

  it('maps a viewer point to the bottom-left-origin space redaction needs', () => {
    const frame: PageFrame = { x0: 0, y0: 0, width: 612, height: 792, rotation: 0 };
    const m = viewerToUserMatrix(frame);
    expect(m[0]).toBe(1);
    expect(m[5]).toBeCloseTo(792, 6);
    const rotated: PageFrame = { ...frame, rotation: 90 };
    // Paper bottom-left is the top-left of a 90° page, so the viewer origin maps
    // to the raw user-space origin.
    expect(viewerBoxToUserSpace({ x: 0, y: 0, width: 0, height: 0 }, rotated)).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
  });

  it('runs text along viewer +x for every page rotation', () => {
    const anchor = { x: 100, y: 200 };
    for (const frame of frames) {
      const m = textMatrix(anchor, 0, frame);
      const origin = viewerBoxToUserSpace({ x: anchor.x, y: anchor.y, width: 0, height: 0 }, frame);
      expect([m[4], m[5]]).toEqual([origin.x, origin.y]);
      // Advance one unit along the baseline and compare with the mapped point.
      const ahead = viewerBoxToUserSpace(
        { x: anchor.x + 1, y: anchor.y, width: 0, height: 0 },
        frame,
      );
      expect(Math.hypot(ahead.x - m[4], ahead.y - m[5])).toBeCloseTo(1, 4);
      expect(Math.hypot(m[0], m[1])).toBeCloseTo(1, 6);
    }
  });

  it('places the unit square on the requested box', () => {
    const box = { x: 50, y: 60, width: 200, height: 100 };
    const frame: PageFrame = { x0: 0, y0: 0, width: 612, height: 792, rotation: 0 };
    const m = imageMatrix(box, {}, frame);
    const corner = (u: number, v: number) => ({
      x: m[0] * u + m[2] * v + m[4],
      y: m[1] * u + m[3] * v + m[5],
    });
    // PDF unit square (0,0) is the image's bottom-left; in viewer space that is
    // the box's bottom-left, i.e. user space y = 792 - (60 + 100).
    expect(corner(0, 0)).toEqual({ x: 50, y: 632 });
    expect(corner(1, 1)).toEqual({ x: 250, y: 732 });
  });

  it('mirrors an image without moving its box', () => {
    const box = { x: 50, y: 60, width: 200, height: 100 };
    const frame: PageFrame = { x0: 0, y0: 0, width: 612, height: 792, rotation: 0 };
    const plain = imageMatrix(box, {}, frame);
    const flipped = imageMatrix(box, { flipH: true }, frame);
    expect(flipped[0]).toBeCloseTo(-plain[0], 6);
    expect(flipped[4]).toBeCloseTo(plain[4] + box.width, 6);
  });

  it('swaps width and height on a quarter turn of the box', () => {
    const rotated = rotateBoxAboutCenter({ x: 100, y: 100, width: 60, height: 20 }, 90);
    expect(rotated).toEqual({ x: 120, y: 80, width: 20, height: 60 });
    expect(rotateBoxAboutCenter(rotated, 180)).toEqual(rotated);
  });

  it('unions and hit-tests boxes', () => {
    expect(unionBoxes([{ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 20, width: 5, height: 5 }])).toEqual({
      x: 0,
      y: 0,
      width: 10,
      height: 25,
    });
    expect(boxContains({ x: 0, y: 0, width: 10, height: 10 }, { x: 9, y: 9 })).toBe(true);
    expect(boxContains({ x: 0, y: 0, width: 10, height: 10 }, { x: 11, y: 1 })).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Alignment inference                                                 *
 * ------------------------------------------------------------------ */

describe('alignment inference', () => {
  function block(edges: { x: number; width: number }[]): ExtractedParagraph {
    return {
      id: 'x',
      page: 1,
      text: '',
      size: 10,
      invisible: false,
      direction: 'ltr',
      box: unionBoxes(edges.map((e) => ({ x: e.x, y: 0, width: e.width, height: 10 }))),
      lines: edges.map((e) => ({
        text: '',
        box: { x: e.x, y: 0, width: e.width, height: 10 },
        size: 10,
        start: 0,
        end: 0,
        items: [],
      })),
    };
  }

  it('reads left, right, justify and centre from the edges', () => {
    expect(guessAlignment(block([{ x: 0, width: 300 }, { x: 0, width: 210 }]))).toBe('left');
    expect(guessAlignment(block([{ x: 90, width: 210 }, { x: 0, width: 300 }]))).toBe('right');
    expect(guessAlignment(block([{ x: 0, width: 300 }, { x: 0, width: 300 }]))).toBe('justify');
    expect(guessAlignment(block([{ x: 50, width: 200 }, { x: 20, width: 260 }]))).toBe('center');
    expect(guessAlignment(block([{ x: 256, width: 100 }]), 612)).toBe('center');
    expect(guessAlignment(block([{ x: 72, width: 300 }]), 612)).toBe('left');
  });
});

/* ------------------------------------------------------------------ *
 * Reflow                                                              *
 * ------------------------------------------------------------------ */

describe('reflow', () => {
  const measure = monospaceMeasure(0.5);
  const base: typeof DEFAULT_STYLE = { ...DEFAULT_STYLE, size: 10, spaceAfter: 0 };

  it('breaks a paragraph at the measure and drops the trailing space', () => {
    const result = layoutBlock(paragraphsFromText('a bb ccc dddd eeeee'), base, {
      measure,
      width: 40,
    });
    expect(result.lines.map((line) => line.text)).toEqual(['a bb ccc', 'dddd', 'eeeee']);
    expect(result.lines.every((line) => line.width <= 40)).toBe(true);
  });

  it('hard-breaks a word wider than the whole block', () => {
    const result = layoutBlock(paragraphsFromText('supercalifragilistic'), base, {
      measure,
      width: 25,
    });
    expect(result.lines.length).toBeGreaterThan(1);
    expect(result.lines.map((line) => line.text).join('')).toBe('supercalifragilistic');
    expect(result.lines.every((line) => line.width <= 25)).toBe(true);
  });

  it('advances the pen by the line pitch and the paragraph spacing', () => {
    const paragraphs = [...paragraphsFromText('one'), ...paragraphsFromText('two')];
    const result = layoutBlock(paragraphs, { ...base, lineSpacing: 1.5, spaceBefore: 6 }, {
      measure,
      width: 200,
    });
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0].y).toBe(0);
    expect(result.lines[0].baseline).toBeCloseTo(8, 6);
    expect(result.lines[1].y).toBeCloseTo(15 + 6, 6);
    expect(result.height).toBeCloseTo(21 + 15, 6);
  });

  it('honours left indent and a hanging first line', () => {
    const paragraphs: DocParagraph[] = [
      { runs: [{ text: 'text', style: {} }], style: {}, list: 'none', listLevel: 0 },
    ];
    const indented = layoutBlock(paragraphs, { ...base, indent: 20 }, { measure, width: 200 });
    expect(indented.lines[0].pieces[0].x).toBe(20);
    const hanging = layoutBlock(paragraphs, { ...base, indent: 20, firstLineIndent: -10 }, {
      measure,
      width: 200,
    });
    expect(hanging.lines[0].pieces[0].x).toBe(10);
  });

  it('numbers and bullets every item with the chosen marker', () => {
    const items = paragraphsFromText('alpha', 'number').concat(
      paragraphsFromText('beta', 'number'),
      paragraphsFromText('gamma', 'number'),
    );
    const result = layoutBlock(items, { ...base, numberMarker: 'lower-roman' }, { measure, width: 200 });
    expect(result.lines.map((line) => line.marker)).toEqual(['i.', 'ii.', 'iii.']);
    expect(result.lines[1].pieces[0].x).toBeGreaterThan(result.lines[1].indent);
  });

  it('restarts numbering when the list kind changes', () => {
    const bullets = paragraphsFromText('one', 'bullet');
    const numbers = paragraphsFromText('two', 'number');
    const result = layoutBlock([...bullets, ...numbers], base, { measure, width: 200 });
    expect(result.lines.map((line) => line.marker)).toEqual(['•', '1.']);
  });

  it('stretches word spacing to justify a line', () => {
    const result = layoutBlock(paragraphsFromText('aa bb cc dd ee ff'), { ...base, align: 'justify' }, {
      measure,
      width: 60,
    });
    expect(result.lines).toHaveLength(2);
    const line = result.lines[0];
    expect(line.extraWordSpacing).toBeGreaterThan(0);
    // The stretched line fills the measure; the last one keeps its natural width.
    expect(line.pieces[0].x + line.width).toBeCloseTo(60, 6);
    expect(result.lines[1].extraWordSpacing).toBe(0);
  });

  it('centres and right-aligns the last line too', () => {
    const centred = layoutBlock(paragraphsFromText('ab'), { ...base, align: 'center' }, {
      measure,
      width: 100,
    });
    expect(centred.lines[0].pieces[0].x).toBeCloseTo((100 - 10) / 2, 6);
    const right = layoutBlock(paragraphsFromText('ab'), { ...base, align: 'right' }, {
      measure,
      width: 100,
    });
    expect(right.lines[0].pieces[0].x).toBeCloseTo(90, 6);
  });

  it('shrinks and raises superscripts', () => {
    const runs = [{ text: 'x', style: { superscript: true } }];
    const resolved = inlineFor(runs[0], base);
    expect(resolved.size).toBeCloseTo(5.8, 6);
    expect(resolved.rise).toBeGreaterThan(0);
    const sub = inlineFor({ text: 'y', style: { subscript: true } }, base);
    expect(sub.rise).toBeLessThan(0);
  });

  it('applies tracking and horizontal scale to the measured advance', () => {
    const tracked = { ...base, charSpacing: 1, wordSpacing: 2, horizontalScale: 200 };
    const result = layoutBlock(paragraphsFromText('ab cd'), tracked, { measure, width: 500 });
    // 'ab' = 10·2 + 2·1 = 22, the space = 5·2 + 1 + 2 = 13, 'cd' = 22.
    expect(result.lines[0].width).toBeCloseTo(57, 6);
  });
});

/* ------------------------------------------------------------------ *
 * Find & replace                                                      *
 * ------------------------------------------------------------------ */

describe('find and replace', () => {
  const text = 'Report of the REPORT. Reporting again, reported.\nSecond line report.';

  it('matches case-insensitively by default', () => {
    expect(findRanges(text, 'report').length).toBe(5);
    expect(findRanges(text, 'report', { caseSensitive: true }).length).toBe(2);
  });

  it('respects whole-word boundaries', () => {
    expect(findRanges(text, 'report', { wholeWord: true })).toEqual([
      { start: 0, end: 6 },
      { start: 14, end: 20 },
      { start: 61, end: 67 },
    ]);
  });

  it('ignores accents and maps hits back onto the source offsets', () => {
    const accented = 'Crème brûlée — CREME brûlée';
    const hits = findRanges(accented, 'creme', { ignoreAccents: true });
    expect(hits).toHaveLength(2);
    expect(accented.slice(hits[0].start, hits[0].end)).toBe('Crème');
    expect(accented.slice(hits[1].start, hits[1].end)).toBe('CREME');
  });

  it('folds combining marks away when accents are ignored', () => {
    const decomposed = 'Crè\u0308me';
    const { folded } = foldForSearch(decomposed, { ignoreAccents: true });
    expect(folded).toBe('creme');
    expect(findRanges(decomposed, 'creme', { ignoreAccents: true })).toHaveLength(1);
  });

  it('keeps astral-plane characters aligned', () => {
    const emoji = 'a😀b report';
    const hits = findRanges(emoji, 'report');
    expect(emoji.slice(hits[0].start, hits[0].end)).toBe('report');
  });

  it('replaces everything, or just the requested range', () => {
    expect(replaceInText(text, 'report', 'memo').count).toBe(5);
    expect(
      replaceInText(text, 'report', 'memo', { caseSensitive: true }, [{ start: 14, end: 20 }]).text,
    ).toBe('Report of the memo. Reporting again, reported.\nSecond line report.');
  });

  it('does nothing on an empty needle or a missing match', () => {
    expect(findRanges(text, '')).toEqual([]);
    expect(replaceInText(text, 'zzz', 'x')).toEqual({ text, count: 0 });
  });

  it('indexes hits across pages with their line boxes', () => {
    const first: ExtractedParagraph = clusterParagraphs([
      item({ str: 'invoice number 12', x: 72, y: 100, w: 160, h: 10 }),
    ])[0];
    const second: ExtractedParagraph = {
      ...clusterParagraphs([item({ str: 'invoice number 13', x: 72, y: 100, w: 160, h: 10 })])[0],
      id: 'p2-72-100',
      page: 2,
    };
    const hits = searchBlocks([...searchableBlocks([first, second])], 'INVOICE', {
      caseSensitive: true,
    });
    expect(hits).toHaveLength(0);
    const found = searchBlocks([...searchableBlocks([first, second])], 'invoice');
    expect(found.map((hit) => hit.page)).toEqual([1, 2]);
    expect(found[1].boxes[0].y).toBe(100);
    expect(found[0].preview).toContain('invoice number 12');
  });
});

/* ------------------------------------------------------------------ *
 * Style model and object reducer                                      *
 * ------------------------------------------------------------------ */

describe('style model', () => {
  it('clamps numeric style fields into the writable range', () => {
    expect(clampStyle('size', 5_000)).toBe(400);
    expect(clampStyle('size', 0.1)).toBe(1);
    expect(clampStyle('horizontalScale', 1_000)).toBe(300);
    expect(clampStyle('opacity', -3)).toBe(0);
    expect(clampStyle('lineSpacing', Number.NaN)).toBe(DEFAULT_STYLE.lineSpacing);
    expect(clampStyle('align', 7)).toBe(7);
  });

  it('lists markers cover decimal, alpha and roman numbering', () => {
    const style = { ...DEFAULT_STYLE };
    expect(listMarker('number', 0, style)).toBe('1.');
    expect(listMarker('number', 9, { ...style, numberMarker: 'lower-alpha' })).toBe('j.');
    expect(listMarker('number', 3, { ...style, numberMarker: 'upper-roman' })).toBe('IV.');
    expect(listMarker('bullet', 2, { ...style, bulletMarker: 'square' })).toBe('▪');
    expect(listMarker('none', 0, style)).toBeNull();
  });

  it('merges runs that share formatting', () => {
    expect(
      normaliseRuns([
        { text: 'a', style: { bold: true } },
        { text: 'b', style: { bold: true } },
        { text: 'c', style: { bold: false } },
        { text: '', style: {} },
      ]),
    ).toEqual([
      { text: 'ab', style: { bold: true } },
      { text: 'c', style: { bold: false } },
    ]);
  });

  it('folds a contentEditable tree into styled paragraphs', () => {
    const paragraphs = paragraphsFromDom([
      {
        tag: 'div',
        children: [
          { tag: '#text', text: 'plain ' },
          { tag: 'strong', bold: true, children: [{ tag: '#text', text: 'bold' }] },
        ],
      },
      { tag: 'div', children: [{ tag: '#text', text: 'second line' }] },
    ]);
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0].runs).toEqual([
      { text: 'plain ', style: {} },
      { text: 'bold', style: { bold: true } },
    ]);
    expect(textOfParagraphs(paragraphs)).toBe('plain bold\nsecond line');
  });

  it('starts a new paragraph at every <br>', () => {
    const paragraphs = paragraphsFromDom([
      {
        tag: 'div',
        children: [
          { tag: '#text', text: 'one' },
          { tag: 'br' },
          { tag: '#text', text: 'two' },
        ],
      },
    ]);
    expect(paragraphs.map((p) => p.runs.map((r) => r.text).join(''))).toEqual(['one', 'two']);
  });

  it('returns one empty paragraph for cleared content', () => {
    expect(paragraphsFromDom([])).toHaveLength(1);
    expect(textOfParagraphs(paragraphsFromDom([]))).toBe('');
  });
});

describe('object reducer', () => {
  const start: EditObject[] = [
    textObject({ id: 'a', box: { x: 0, y: 0, width: 10, height: 10 }, z: 0 }),
    textObject({ id: 'b', box: { x: 20, y: 0, width: 10, height: 10 }, z: 1 }),
    textObject({ id: 'c', box: { x: 40, y: 0, width: 10, height: 10 }, z: 2 }),
  ];

  it('adds, removes and replaces', () => {
    const added = editObjects([], { type: 'add', object: start[0] });
    expect(added).toHaveLength(1);
    expect(editObjects(added, { type: 'remove', ids: ['a'] })).toHaveLength(0);
    const replaced = editObjects(added, { type: 'replace', id: 'a', object: start[1] });
    expect(replaced[0].id).toBe('b');
  });

  it('moves only the selection', () => {
    const moved = editObjects(start, { type: 'move', ids: ['a', 'c'], dx: 5, dy: -2 });
    expect(moved.map((object) => object.box.x)).toEqual([5, 20, 45]);
    expect(moved[0].box.y).toBe(-2);
  });

  it('applies a clamped block style to text objects only', () => {
    const styled = editObjects(start, { type: 'style', ids: ['a', 'b'], patch: { size: 9999, align: 'center' } });
    expect((styled[0] as TextObject).style.size).toBe(400);
    expect((styled[0] as TextObject).style.align).toBe('center');
    expect((styled[2] as TextObject).style.size).toBe(12);
  });

  it('applies inline style to the block and every run', () => {
    const styled = editObjects([textObject({ id: 'a' })], {
      type: 'inline-style',
      ids: ['a'],
      patch: { bold: true, italic: true },
    });
    const object = styled[0] as TextObject;
    expect(object.style.bold).toBe(true);
    expect(object.paragraphs[0].runs[0].style.bold).toBe(true);
  });

  it('toggles a list off when the same kind is requested again', () => {
    const one = editObjects([textObject({ id: 'a' })], { type: 'list', ids: ['a'], list: 'bullet' });
    expect((one[0] as TextObject).paragraphs[0].list).toBe('bullet');
    const two = editObjects(one, { type: 'list', ids: ['a'], list: 'bullet' });
    expect((two[0] as TextObject).paragraphs[0].list).toBe('none');
  });

  it('aligns and distributes a multi-selection', () => {
    const aligned = editObjects(start, { type: 'align', ids: ['a', 'b', 'c'], mode: 'left' });
    expect(aligned.map((object) => object.box.x)).toEqual([0, 0, 0]);
    const centred = editObjects(start, { type: 'align', ids: ['a', 'b', 'c'], mode: 'center' });
    // Union spans 0..50, so every 10 pt box lands on x = 20 with its centre at 25.
    expect(centred.map((object) => object.box.x)).toEqual([20, 20, 20]);
    const spaced = editObjects(
      [
        textObject({ id: 'a', box: { x: 0, y: 0, width: 10, height: 10 } }),
        textObject({ id: 'b', box: { x: 30, y: 0, width: 10, height: 10 } }),
        textObject({ id: 'c', box: { x: 100, y: 0, width: 10, height: 10 } }),
      ],
      { type: 'distribute', ids: ['a', 'b', 'c'], axis: 'horizontal' },
    );
    expect(spaced.map((object) => object.box.x)).toEqual([0, 55, 100]);
    expect(distributeBoxes([], 'horizontal')).toEqual([]);
  });

  it('keeps a two-item distribute unchanged and aligns to the union box', () => {
    const two = alignBoxes(
      [
        { x: 0, y: 0, width: 10, height: 10 },
        { x: 0, y: 40, width: 10, height: 10 },
      ],
      'bottom',
    );
    expect(two.map((box) => box.y)).toEqual([40, 40]);
  });

  it('reorders paint order', () => {
    const front = editObjects(start, { type: 'zorder', ids: ['a'], order: 'front' });
    expect(front.map((object) => object.id)).toEqual(['b', 'c', 'a']);
    const back = editObjects(start, { type: 'zorder', ids: ['c'], order: 'back' });
    expect(back.map((object) => object.id)).toEqual(['c', 'a', 'b']);
    const forward = editObjects(start, { type: 'zorder', ids: ['a'], order: 'forward' });
    expect(forward.map((object) => object.id)).toEqual(['b', 'a', 'c']);
    const backward = editObjects(start, { type: 'zorder', ids: ['c'], order: 'backward' });
    expect(backward.map((object) => object.id)).toEqual(['a', 'c', 'b']);
    expect(front.map((object) => object.z)).toEqual([0, 1, 2]);
  });

  it('rotates, flips, sets alt text and records commit state', () => {
    const turned = editObjects(start, { type: 'transform', ids: ['a'], rotation: 90, flipH: true });
    expect(turned[0].rotation).toBe(90);
    expect(turned[0].flipH).toBe(true);
    expect(turned[1].rotation).toBe(0);
    const alt = editObjects(start, { type: 'alt', ids: ['a', 'b'], alt: 'Chart of sales' });
    expect(alt[0].alt).toBe('Chart of sales');
    expect(alt[2].alt).toBe('');
    const committed = editObjects(start, {
      type: 'commit-state',
      ids: ['a'],
      state: 'needs-engine',
      note: 'Block sits on an image.',
    });
    expect(committed[0].state).toBe('needs-engine');
    expect(committed[0].note).toBe('Block sits on an image.');
  });

  it('duplicates through the caller-provided clone so ids stay unique', () => {
    const duplicated = editObjects([start[0]], {
      type: 'duplicate',
      ids: ['a'],
      clone: (object) => ({
        ...object,
        id: `${object.id}-copy`,
        box: { ...object.box, x: object.box.x + 10, y: object.box.y + 10 },
        z: 9,
      }),
    });
    expect(duplicated).toHaveLength(2);
    expect(duplicated[1].box.x).toBe(10);
  });

  it('replaces an image payload without moving its placement', () => {
    const image: EditObject = {
      id: 'i',
      page: 1,
      kind: 'image',
      box: { x: 10, y: 10, width: 40, height: 20 },
      rotation: 0,
      flipH: false,
      flipV: false,
      z: 0,
      alt: '',
      state: 'written',
      bytes: new Uint8Array([1, 2, 3]),
      mime: 'image/png',
    };
    const replaced = editObjects([image], {
      type: 'replace-image',
      id: 'i',
      bytes: new Uint8Array([9]),
      mime: 'image/jpeg',
      intrinsic: { width: 9, height: 9 },
    });
    expect(Array.from(replaced[0].kind === 'image' ? replaced[0].bytes : [])).toEqual([9]);
    expect(replaced[0].state).toBe('draft');
    expect(replaced[0].box).toEqual({ x: 10, y: 10, width: 40, height: 20 });
  });

  it('selects the top-most object of the allowed scope', () => {
    const overlap = objectAtPoint(start, 1, { x: 5, y: 5 }, 'text');
    expect(overlap?.id).toBe('a');
    expect(objectAtPoint(start, 1, { x: 25, y: 5 }, 'image')).toBeNull();
    expect(scopeAllows('image', 'all')).toBe(true);
    expect(scopeAllows('image', 'text')).toBe(false);
  });

  it('is total: unknown ids and unmatched actions leave state alone', () => {
    expect(editObjects(start, { type: 'remove', ids: ['nope'] })).toHaveLength(3);
    expect(editObjects(start, { type: 'move', ids: [], dx: 100, dy: 100 })).toEqual(start);
  });
});

/* ------------------------------------------------------------------ *
 * Undo / redo                                                         *
 * ------------------------------------------------------------------ */

describe('undo and redo', () => {
  it('walks back and forth over the object list', () => {
    let history = createHistory<EditObject[]>([]);
    expect(canUndo(history)).toBe(false);
    history = pushHistory(history, [textObject({ id: 'a' })]);
    history = pushHistory(history, [textObject({ id: 'a' }), textObject({ id: 'b' })]);
    expect(canUndo(history)).toBe(true);
    const undone = undoHistory(history);
    expect(undone.present.map((object) => object.id)).toEqual(['a']);
    expect(canRedo(undone)).toBe(true);
    const redone = redoHistory(undone);
    expect(redone.present.map((object) => object.id)).toEqual(['a', 'b']);
    expect(canRedo(redone)).toBe(false);
  });

  it('drops the redo branch when a fresh edit arrives', () => {
    let history = createHistory<number>(0);
    history = pushHistory(history, 1);
    history = pushHistory(history, 2);
    history = undoHistory(history);
    expect(history.future).toHaveLength(1);
    history = pushHistory(history, 9);
    expect(history.future).toHaveLength(0);
    expect(undoHistory(history).present).toBe(1);
  });

  it('amends the tip without growing the stack, for live drags', () => {
    let history = createHistory<number>(0);
    history = pushHistory(history, 1);
    history = amendTwice(history);
    expect(history.past).toHaveLength(1);
    expect(history.present).toBe(3);
  });

  it('ignores a push of the identical value', () => {
    const present: EditObject[] = [textObject({ id: 'a' })];
    const history = createHistory<EditObject[]>(present);
    expect(pushHistory(history, present)).toBe(history);
  });

  it('caps the past at HISTORY_LIMIT steps', () => {
    let history = createHistory<number>(0);
    for (let i = 1; i <= 200; i += 1) history = pushHistory(history, i);
    expect(history.past.length).toBeLessThanOrEqual(60);
  });

  it('undo of the oldest state is a no-op', () => {
    const history = pushHistory(createHistory<number>(0), 1);
    const bottom = undoHistory(history);
    expect(undoHistory(bottom).present).toBe(0);
    expect(canUndo(bottom)).toBe(false);
    expect(redoHistory(bottom).present).toBe(1);
  });
});

function amendTwice(history: ReturnType<typeof createHistory<number>>) {
  const once = { ...history, present: 2 };
  return { ...once, present: 3 };
}

/* ------------------------------------------------------------------ *
 * Palette sampling, zoom, rulers                                      *
 * ------------------------------------------------------------------ */

describe('colour sampling', () => {
  function pixels(width: number, height: number, paint: (x: number, y: number) => [number, number, number, number]) {
    const buffer = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const at = (y * width + x) * 4;
        const [r, g, b, a] = paint(x, y);
        buffer[at] = r;
        buffer[at + 1] = g;
        buffer[at + 2] = b;
        buffer[at + 3] = a;
      }
    }
    return buffer;
  }

  it('separates black ink from white paper', () => {
    const rgba = pixels(40, 10, (x) => (x % 6 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const palette = samplePalette(rgba, 40, 10, { x: 0, y: 0, width: 40, height: 10 });
    expect(palette.background).toBe('#ffffff');
    expect(palette.color).toBe('#000000');
  });

  it('reads coloured ink on a coloured patch', () => {
    const rgba = pixels(40, 20, (x, y) => (x < 20 || y < 18 ? [234, 67, 53, 255] : [255, 255, 255, 255]));
    const palette = samplePalette(rgba, 40, 20, { x: 0, y: 0, width: 40, height: 20 });
    expect(palette.background).toBe('#ea4335');
    expect(hexToRgb(palette.color)).toEqual([255, 255, 255]);
  });

  it('degrades to black on white for an empty box', () => {
    const rgba = new Uint8ClampedArray(4 * 4 * 4);
    expect(samplePalette(rgba, 4, 4, { x: 0, y: 0, width: 4, height: 4 })).toEqual({
      color: '#000000',
      background: '#ffffff',
    });
  });
});

describe('zoom and rulers', () => {
  it('fits a page by width or entirely', () => {
    const page = { width: 612, height: 792 };
    const viewport = { width: 644, height: 824 };
    expect(fitScale(page, viewport, 'width')).toBeCloseTo(612 / 612, 6);
    expect(fitScale(page, viewport, 'page')).toBeCloseTo(1, 6);
    expect(fitScale(page, { width: 300, height: 300 }, 'page')).toBeLessThan(0.4);
    expect(fitScale({ width: 0, height: 0 }, viewport, 'width')).toBe(1);
  });

  it('picks a legible ruler step', () => {
    expect(rulerTicks(100, 1)).toEqual([]);
    expect(rulerTicks(250, 1).length).toBeGreaterThan(1);
    expect(rulerTicks(612, 2).map((tick) => tick.label)).toEqual(['0', '50', '100', '150', '200', '250', '300', '350', '400', '450', '500', '550', '600']);
  });

  it('generates unique object ids', () => {
    const ids = new Set([nextObjectId('text'), nextObjectId('text'), nextObjectId('image')]);
    expect(ids.size).toBe(3);
  });
});

describe('line helpers', () => {
  it('clusters rows by baseline and orders them top to bottom', () => {
    const lines = clusterLines([
      item({ str: 'beta', x: 72, y: 132, w: 40, h: 10 }),
      item({ str: 'alpha', x: 72, y: 100, w: 40, h: 10 }),
      item({ str: 'gamma', x: 200, y: 101, w: 40, h: 10 }),
    ]);
    expect(lines.map((line) => line.text)).toEqual(['alpha', 'gamma', 'beta']);
  });
});
