/**
 * Tests for `src/lib/pdf/core/convert.ts`.
 *
 * Everything here runs in jsdom without a canvas: the JSON/Markdown/text/HTML
 * writers take plain data, `documentToJson` runs against a real pdf-lib
 * document plus a stubbed `PdfSession`, and the SVG builder takes a synthesised
 * operator list with the operator codes read out of the installed pdf.js.
 */
import { describe, expect, it } from 'vitest';
import { PDFDict, PDFDocument, PDFName, PDFString, decodePDFRawStream } from '@maxwbh/pdf-lib';
import type { PdfSession } from '@/lib/pdf/core/render';
import type { ExtractedTextItem } from '@/lib/pdf/core/render';
import { clusterRows, viewerRectToUserSpace } from '@/lib/pdf/core/tables';
import {
  REQUIRED_OP_NAMES,
  applyMatrix,
  blocksFromItems,
  blocksWithTables,
  countImages,
  covers,
  detectHeadingHeights,
  documentToJson,
  documentToSvg,
  escapeHtml,
  headingLevelFor,
  jsonToHtml,
  jsonToLlamaIndex,
  jsonToMarkdown,
  jsonToText,
  markdownTable,
  maxFontHeight,
  multiplyMatrices,
  opCodesFrom,
  operatorListToSvg,
  pageLinks,
  rowText,
} from '@/lib/pdf/core/convert';
import type {
  PdfJsonBlock,
  PdfJsonPage,
  SvgOpCodes,
  SvgOperatorList,
} from '@/lib/pdf/core/convert';

const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wD/7AAAAABJRU5ErkJggg==';

/**
 * The operator codes as they exist in the installed `pdfjs-dist` (verified
 * against `node_modules/pdfjs-dist/types/src/shared/util.d.ts`). The test below
 * asserts these still match the real table, so a rename can only ever fail
 * loudly here — never silently in the browser.
 */
const CODES: Record<string, number> = {
  dependency: 1,
  setLineWidth: 2,
  setLineCap: 3,
  setLineJoin: 4,
  setMiterLimit: 5,
  setDash: 6,
  setGState: 9,
  save: 10,
  restore: 11,
  transform: 12,
  moveTo: 13,
  lineTo: 14,
  curveTo: 15,
  curveTo2: 16,
  curveTo3: 17,
  closePath: 18,
  rectangle: 19,
  stroke: 20,
  closeStroke: 21,
  fill: 22,
  eoFill: 23,
  fillStroke: 24,
  eoFillStroke: 25,
  closeFillStroke: 26,
  closeEOFillStroke: 27,
  endPath: 28,
  clip: 29,
  eoClip: 30,
  beginText: 31,
  endText: 32,
  setCharSpacing: 33,
  setWordSpacing: 34,
  setHScale: 35,
  setLeading: 36,
  setFont: 37,
  setTextRenderingMode: 38,
  setTextRise: 39,
  moveText: 40,
  setLeadingMoveText: 41,
  setTextMatrix: 42,
  nextLine: 43,
  showText: 44,
  showSpacedText: 45,
  setStrokeColorSpace: 50,
  setFillColorSpace: 51,
  setStrokeColorN: 53,
  setFillColorN: 55,
  setStrokeRGBColor: 58,
  setFillRGBColor: 59,
  setStrokeCMYKColor: 60,
  setFillCMYKColor: 61,
  shadingFill: 62,
  paintXObject: 66,
  paintFormXObjectBegin: 74,
  paintFormXObjectEnd: 75,
  paintImageMaskXObject: 83,
  paintImageXObject: 85,
  paintInlineImageXObject: 86,
  paintImageXObjectRepeat: 88,
  paintSolidColorImageMask: 90,
  constructPath: 91,
  setStrokeTransparent: 92,
  setFillTransparent: 93,
};

const OPS = opCodesFrom(CODES) as SvgOpCodes;

/** `q`/`Q` and colour codes are the only extras some tests need by name. */
function list(pairs: [number, readonly unknown[]][]): SvgOperatorList {
  return { fnArray: pairs.map(([fn]) => fn), argsArray: pairs.map(([, args]) => args) };
}

const noResources = { font: () => undefined };

function item(
  str: string,
  x: number,
  y: number,
  w: number,
  h = 10,
  page = 1,
): ExtractedTextItem {
  return {
    str,
    transform: [h / 1.15, 0, 0, h / 1.15, x, 841.89 - y],
    width: w,
    height: h,
    fontName: 'F0',
    dir: 'ltr',
    page,
    x,
    y,
    w,
    h,
    hasEOL: false,
    isInvisible: false,
  };
}

function page(
  overrides: Partial<PdfJsonPage> & { page: number },
): PdfJsonPage {
  return {
    width: 595.28,
    height: 841.89,
    rotation: 0,
    text: '',
    blocks: [],
    images: 0,
    links: [],
    ...overrides,
  };
}

function textBlock(text: string, fontHeight: number, y = 100): PdfJsonBlock {
  return {
    type: 'text',
    rect: { x: 50, y, width: 300, height: fontHeight },
    text,
    lines: [{ text, bbox: { x: 50, y, width: 300, height: fontHeight }, fontHeight }],
  };
}

describe('opCodesFrom — the pdf.js contract', () => {
  it('accepts every name the installed pdf.js publishes, with the same numbers', async () => {
    const mod = (await import('pdfjs-dist')) as unknown as { OPS: Record<string, number> };
    const missing = REQUIRED_OP_NAMES.filter((name) => typeof mod.OPS[name] !== 'number');
    expect(missing).toEqual([]);
    for (const name of REQUIRED_OP_NAMES) {
      expect(mod.OPS[name], name).toBe(CODES[name]);
    }
  });

  it('refuses a build without the operators it needs, naming them', () => {
    expect(() => opCodesFrom({ ...CODES, constructPath: undefined })).toThrow(/constructPath/);
    expect(() => opCodesFrom(undefined)).toThrow(/does not expose/);
  });
});

describe('matrix maths', () => {
  it('applies the second matrix first, the way a `cm` operator does', () => {
    // local (1,1) → scale 2 → translate (5,7)
    const composed = multiplyMatrices([1, 0, 0, 1, 5, 7], [2, 0, 0, 2, 0, 0]);
    expect(composed).toEqual([2, 0, 0, 2, 5, 7]);
    expect(applyMatrix(composed, 1, 1)).toEqual([7, 9]);
    // The same composition the interpreter does for `cm` after a scale.
    expect(multiplyMatrices([2, 0, 0, 2, 0, 0], [1, 0, 0, 1, 3, 4])).toEqual([2, 0, 0, 2, 6, 8]);
    expect(multiplyMatrices([1, 0, 0, 1, 0, 0], [1, 0, 0, -1, 0, 842])).toEqual([1, 0, 0, -1, 0, 842]);
  });
});

describe('operatorListToSvg', () => {
  it('transforms path coordinates with the CTM at construction time', () => {
    const { body, stats } = operatorListToSvg(
      list([
        [OPS.transform, [2, 0, 0, 2, 10, 10]],
        [OPS.constructPath, [[CODES.rectangle], [0, 0, 10, 10]]],
        [OPS.fill, []],
      ]),
      OPS,
      noResources,
    );
    expect(body).toBe('<path d="M10 10 L30 10 L30 30 L10 30 Z" fill="#000000"/>');
    expect(stats.paths).toBe(1);
  });

  it('honours fill, stroke and transparency colour operators', () => {
    const { body } = operatorListToSvg(
      list([
        [OPS.setFillRGBColor, [255, 0, 0]],
        [OPS.constructPath, [[CODES.rectangle], [0, 0, 4, 4]]],
        [OPS.fill, []],
        [OPS.setStrokeCMYKColor, [0, 1, 1, 0]],
        [OPS.setLineWidth, [1]],
        [OPS.moveTo, [0, 0]],
        [OPS.lineTo, [8, 0]],
        [OPS.stroke, []],
        [OPS.setFillTransparent, []],
        [OPS.constructPath, [[CODES.rectangle], [1, 1, 2, 2]]],
        [OPS.fill, []],
      ]),
      OPS,
      noResources,
    );
    expect(body).toContain('fill="#ff0000"');
    expect(body).toContain('stroke="#ff0000" stroke-width="1"');
    expect(body).toContain('fill="none"');
  });

  it('scales the stroke width by the CTM and reads line width from /GS', () => {
    const { body } = operatorListToSvg(
      list([
        [OPS.save, []],
        [OPS.setGState, [[['LW', 4], ['CA', 0.5], ['ca', 0.5]]]],
        [OPS.transform, [2, 0, 0, 2, 0, 0]],
        [OPS.moveTo, [0, 0]],
        [OPS.lineTo, [10, 0]],
        [OPS.stroke, []],
        [OPS.constructPath, [[CODES.rectangle], [0, 0, 2, 2]]],
        [OPS.fill, []],
        [OPS.restore, []],
        [OPS.setLineWidth, [1]],
        [OPS.moveTo, [0, 0]],
        [OPS.lineTo, [10, 0]],
        [OPS.stroke, []],
      ]),
      OPS,
      noResources,
    );
    expect(body).toContain('stroke-width="8"');
    expect(body).toContain('stroke-opacity="0.5"');
    expect(body).toContain('fill-opacity="0.5"');
    // After `Q` the CTM and line width are back to their outer values.
    expect(body.endsWith('<path d="M0 0 L10 0" fill="none" stroke="#000000" stroke-width="1" stroke-linecap="0" stroke-linejoin="0" stroke-miterlimit="10"/>')).toBe(true);
  });

  it('curves: curveTo, curveTo2 and curveTo3 all reach cubic segments', () => {
    const { body } = operatorListToSvg(
      list([
        [OPS.moveTo, [0, 0]],
        [OPS.curveTo, [1, 2, 3, 4, 5, 6]],
        [OPS.curveTo2, [7, 8, 9, 10]],
        [OPS.curveTo3, [11, 12, 13, 14]],
        [OPS.closePath, []],
        [OPS.stroke, []],
      ]),
      OPS,
      noResources,
    );
    expect(body).toContain('M0 0 C1 2 3 4 5 6 C5 6 7 8 9 10 C11 12 13 14 13 14 Z');
  });

  it('consumes a clip path instead of pretending it can mask', () => {
    const { body, stats } = operatorListToSvg(
      list([
        [OPS.constructPath, [[CODES.rectangle], [0, 0, 100, 100]]],
        [OPS.clip, []],
        [OPS.endPath, []],
        [OPS.constructPath, [[CODES.rectangle], [0, 0, 5, 5]]],
        [OPS.fill, []],
      ]),
      OPS,
      noResources,
    );
    expect(stats.clips).toBe(1);
    expect(stats.paths).toBe(1);
    expect(body).toBe('<path d="M0 0 L5 0 L5 5 L0 5 Z" fill="#000000"/>');
  });

  it('emits live text with the flipped local matrix pdf.js uses', () => {
    const { body, stats } = operatorListToSvg(
      list([
        [OPS.beginText, []],
        [OPS.setFont, ['g_d0_f1', 12]],
        [OPS.setTextMatrix, [1, 0, 0, 1, 50, 700]],
        [OPS.showText, [[{ fontChar: 'Hi', width: 600, isSpace: false }]]],
        [OPS.endText, []],
      ]),
      OPS,
      noResources,
    );
    expect(body).toBe(
      '<text transform="matrix(1 0 0 -1 50 700)" font-family="sans-serif" font-size="12" x="0" y="0" fill="#000000">Hi</text>',
    );
    expect(stats.textRuns).toBe(1);
  });

  it('advances the text position between show-text runs and honours kerning', () => {
    const { body } = operatorListToSvg(
      list([
        [OPS.beginText, []],
        [OPS.setFont, ['g_d0_f1', 10]],
        [OPS.setTextMatrix, [1, 0, 0, 1, 0, 0]],
        [OPS.showText, [[{ fontChar: 'A', width: 500 }, -200, { fontChar: 'B', width: 500 }]]],
        [OPS.endText, []],
      ]),
      OPS,
      noResources,
    );
    // 500 × 0.001 × 10 = 5, then a −200/1000 em kern adds +2 → 7 for the second run.
    expect(body).toContain('matrix(1 0 0 -1 0 0)" font-family="sans-serif" font-size="10"');
    expect(body).toContain('>A</text>');
    expect(body).toContain('matrix(1 0 0 -1 7 0)"');
    expect(body).toContain('>B</text>');
  });

  it('skips invisible (render mode 3) runs but still advances the cursor', () => {
    const { body, stats } = operatorListToSvg(
      list([
        [OPS.beginText, []],
        [OPS.setFont, ['g_d0_f1', 10]],
        [OPS.setTextMatrix, [1, 0, 0, 1, 0, 0]],
        [OPS.setTextRenderingMode, [3]],
        [OPS.showText, [[{ fontChar: 'ghost', width: 500 }]]],
        [OPS.setTextRenderingMode, [0]],
        [OPS.showText, [[{ fontChar: 'real', width: 500 }]]],
        [OPS.endText, []],
      ]),
      OPS,
      noResources,
    );
    expect(body).not.toContain('ghost');
    expect(body).toContain('>real</text>');
    // The skipped run still advanced by its own glyph width: 500 × 0.001 × 10.
    expect(body).toContain('matrix(1 0 0 -1 5 0)"');
    expect(stats.textRuns).toBe(1);
  });

  it('uses the font family pdf.js loaded, and squeezes advances with Tz', () => {
    const { body } = operatorListToSvg(
      list([
        [OPS.beginText, []],
        [OPS.setHScale, [90]],
        [OPS.setFont, ['g_d0_f1', 11]],
        [OPS.setTextMatrix, [1, 0, 0, 1, 20, 30]],
        [OPS.showText, [[{ fontChar: 'x', width: 500 }]]],
        [OPS.showText, [[{ fontChar: 'y', width: 500 }]]],
        [OPS.endText, []],
      ]),
      OPS,
      {
        font: (name) => (name === 'g_d0_f1' ? { loadedName: 'g_d0_f1', fallbackName: 'sans-serif' } : undefined),
      },
    );
    expect(body).toContain('font-family="g_d0_f1"');
    // `Tz` lands in the run matrix …
    expect(body).toContain('matrix(0.9 0 0 -1 20 30)');
    // … and in the advance of the next run: 500 × 0.001 × 11 × 0.9 = 4.95.
    expect(body).toContain('matrix(0.9 0 0 -1 24.95 30)');
  });

  it('places images in the unit square and can skip them entirely', () => {
    const withImage = operatorListToSvg(
      list([
        [OPS.transform, [4, 0, 0, 3, 10, 10]],
        [OPS.paintImageXObject, ['img_0']],
      ]),
      OPS,
      { ...noResources, image: (id) => (id === 'img_0' ? 'data:image/png;base64,AA==' : undefined) },
    );
    expect(withImage.body).toBe(
      '<image href="data:image/png;base64,AA==" width="1" height="1" preserveAspectRatio="none" transform="matrix(4 0 0 -3 10 13)"/>',
    );
    expect(withImage.stats.images).toBe(1);

    const skipped = operatorListToSvg(
      list([[OPS.paintImageXObject, ['img_0']]]),
      OPS,
      { ...noResources, image: () => 'data:,x' },
      { embedImages: false },
    );
    expect(skipped.body).toBe('');
    expect(skipped.stats.skippedOps).toBe(1);
  });

  it('paints a solid-colour mask as a unit rect and respects floatPrecision', () => {
    const { body } = operatorListToSvg(
      list([
        [OPS.transform, [1.234567, 0, 0, 1, 0, 0]],
        [OPS.paintSolidColorImageMask, []],
      ]),
      OPS,
      noResources,
      { floatPrecision: 0 },
    );
    expect(body).toBe('<rect x="0" y="0" width="1" height="1" transform="matrix(1 0 0 1 0 0)" fill="#000000"/>');
  });

  it('inlines form XObjects between paintFormXObjectBegin/End', () => {
    const { body } = operatorListToSvg(
      list([
        [OPS.transform, [2, 0, 0, 2, 0, 0]],
        [OPS.paintFormXObjectBegin, [[1, 0, 0, 1, 3, 4], null]],
        [OPS.constructPath, [[CODES.rectangle], [0, 0, 1, 1]]],
        [OPS.fill, []],
        [OPS.paintFormXObjectEnd, []],
        [OPS.constructPath, [[CODES.rectangle], [0, 0, 1, 1]]],
        [OPS.fill, []],
      ]),
      OPS,
      noResources,
    );
    // Outer scale 2 applies *after* the form's own translate: (3,4) → (6,8).
    expect(body).toContain('<path d="M6 8 L8 8 L8 10 L6 10 Z" fill="#000000"/>');
    expect(body.endsWith('<path d="M0 0 L2 0 L2 2 L0 2 Z" fill="#000000"/>')).toBe(true);
  });

  it('counts pattern and shading operators as skipped, not silently dropped', () => {
    const { stats } = operatorListToSvg(
      list([
        [OPS.setFillColorN, [['TilingPattern', [0, 0, 0]]]],
        [OPS.shadingFill, ['sh0']],
        [OPS.dependency, [['g_d0_f1']]],
      ]),
      OPS,
      noResources,
    );
    expect(stats.skippedOps).toBe(2);
  });
});

describe('documentToSvg', () => {
  function stubSession(fnArray: number[], argsArray: unknown[][]): PdfSession {
    const proxy = {
      view: [0, 0, 595.28, 841.89],
      rotate: 0,
      objs: { has: () => false, get: (_id: string, cb?: (v: unknown) => void) => cb?.(undefined) },
      commonObjs: { has: () => false, get: () => undefined },
      getOperatorList: async () => ({ fnArray, argsArray }),
    };
    return {
      numPages: 1,
      page: async () => proxy,
    } as unknown as PdfSession;
  }

  it('wraps the body in the page flip and reports the geometry', async () => {
    const created = await PDFDocument.create();
    created.addPage([595.28, 841.89]);
    const svg = await documentToSvg(
      created,
      stubSession([OPS.transform, OPS.constructPath, OPS.fill], [
        [1, 0, 0, 1, 0, 0],
        [[CODES.rectangle], [10, 20, 30, 40]],
        [],
      ]),
      1,
      { embedImages: false },
    );
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('width="595.28" height="841.89"');
    expect(svg).toContain('viewBox="0 0 595.28 841.89"');
    expect(svg).toContain('<g transform="matrix(1 0 0 -1 0 841.89)">');
    expect(svg).toContain('<path d="M10 20 L40 20 L40 60 L10 60 Z"');
    expect(svg.endsWith('</svg>')).toBe(true);
  });

  it('rejects a page the document does not have', async () => {
    const created = await PDFDocument.create();
    created.addPage([200, 200]);
    await expect(documentToSvg(created, stubSession([], []), 3)).rejects.toThrow(
      /Page 3 is outside this document/,
    );
  });
});

describe('documentToJson', () => {
  const heading = item('Quarterly Report', 50, 50, 160, 18);
  const paragraph = [
    item('The quarter closed above plan, with every region contributing', 50, 120, 350),
    item('to the improvement in gross margin.', 50, 132, 210),
  ];
  const table = [
    item('Item', 50, 220, 30),
    item('Qty', 200, 220, 25),
    item('Price', 320, 220, 40),
    item('Widget', 50, 240, 45),
    item('3', 200, 240, 8),
    item('$1.50', 320, 240, 35),
    item('Total', 50, 260, 35),
    item('10', 200, 260, 12),
    item('$10.50', 320, 260, 45),
  ];
  const allItems = [heading, ...paragraph, ...table];

  function fakeSession(items: ExtractedTextItem[], numPages = 1): PdfSession {
    return {
      numPages,
      textItems: async () => items,
      metadata: async () => ({
        numPages,
        fingerprint: 'abc',
        formFields: 0,
        title: 'Invoice',
      }),
    } as unknown as PdfSession;
  }

  async function fixture(rotation = 0) {
    const created = await PDFDocument.create();
    created.setTitle('Invoice');
    const png = await created.embedPng(new Uint8Array(Buffer.from(PNG_1PX, 'base64')));
    const drawn = created.addPage([595.28, 841.89]);
    drawn.drawImage(png, { x: 0, y: 0, width: 50, height: 50 });
    drawn.node.set(
      PDFName.of('Annots'),
      created.context.obj([
        created.context.register(
          created.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [0, 0, 50, 10],
            A: created.context.obj({ S: 'URI', URI: PDFString.of('https://example.com/') }),
          }),
        ),
      ]),
    );
    if (rotation) {
      drawn.node.set(PDFName.of('Rotate'), created.context.obj(rotation));
    }
    const doc = await PDFDocument.load(await created.save());
    return doc;
  }

  it('exports geometry, prose blocks, a table, images and links', async () => {
    const doc = await fixture();
    const json = await documentToJson(doc, fakeSession(allItems));
    expect(json.meta).toMatchObject({ pageCount: 1, title: 'Invoice', fingerprint: 'abc' });
    expect(json.pages).toHaveLength(1);
    const [first] = json.pages;
    expect(first.page).toBe(1);
    expect(first.width).toBeCloseTo(595.28, 2);
    expect(first.height).toBeCloseTo(841.89, 2);
    expect(first.rotation).toBe(0);
    expect(first.images).toBe(1);
    expect(first.links).toEqual(['https://example.com/']);

    const kinds = first.blocks.map((block) => block.type);
    expect(kinds).toContain('table');
    expect(kinds.filter((kind) => kind === 'text').length).toBeGreaterThanOrEqual(2);

    const tableBlock = first.blocks.find((block) => block.type === 'table')!;
    expect(tableBlock.rows).toEqual([
      ['Item', 'Qty', 'Price'],
      ['Widget', '3', '$1.50'],
      ['Total', '10', '$10.50'],
    ]);

    // The table's own runs must not also survive as prose.
    expect(
      first.blocks
        .filter((block) => block.type === 'text')
        .some((block) => (block.text ?? '').includes('Widget')),
    ).toBe(false);
    expect(first.text).toContain('Quarterly Report');
    expect(first.text).toContain('gross margin');
  });

  it('reports the rotated display size of a /Rotate 90 page', async () => {
    const doc = await fixture(90);
    const json = await documentToJson(doc, fakeSession([heading]));
    expect(json.pages[0].rotation).toBe(90);
    expect(json.pages[0].width).toBeCloseTo(841.89, 2);
    expect(json.pages[0].height).toBeCloseTo(595.28, 2);
  });

  it('accepts an explicit page list and refuses pages that do not exist', async () => {
    const doc = await fixture();
    const json = await documentToJson(doc, fakeSession(allItems, 1), [1]);
    expect(json.pages.map((p) => p.page)).toEqual([1]);
    await expect(documentToJson(doc, fakeSession(allItems, 1), [2])).rejects.toThrow(
      /Page 2 is outside this document/,
    );
  });

  it('countImages and pageLinks tolerate a page with neither', async () => {
    const created = await PDFDocument.create();
    const bare = created.addPage([200, 200]);
    expect(countImages(bare)).toBe(0);
    expect(pageLinks(bare)).toEqual([]);
  });
});

describe('blocksFromItems', () => {
  it('merges close lines and splits on paragraph gaps', () => {
    const blocks = blocksFromItems([
      item('Alpha line one', 50, 100, 120),
      item('Alpha line two', 50, 112, 118),
      item('Beta line one', 50, 300, 120),
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toBe('Alpha line one\nAlpha line two');
    expect(blocks[0].lines).toHaveLength(2);
    expect(blocks[1].text).toBe('Beta line one');
    expect(blocks[0].rect).toEqual({ x: 50, y: 100, width: 120, height: 22 });
    expect(blocks[0].lines![0].fontHeight).toBe(10);
  });

  it('starts a new block when the indent jumps', () => {
    const blocks = blocksFromItems([
      item('Intro paragraph that wraps across two lines of body text here', 50, 100, 400),
      item('and continues at the same margin.', 50, 112, 200),
      item('• a bullet far to the right', 260, 126, 160),
    ]);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
  });

  it('rowText joins a visual line the way a reader would read it', () => {
    const [row] = clusterRows([
      item('The', 50, 100, 20),
      item('quick', 75, 100, 30),
      item('fox', 110, 100, 20),
    ]);
    expect(rowText(row)).toBe('The quick fox');
    const blocks = blocksFromItems([
      item('The', 50, 100, 20),
      item('quick', 75, 100, 30),
      item('fox', 110, 100, 20),
    ]);
    expect(blocks[0].text).toBe('The quick fox');
  });
});

describe('blocksWithTables', () => {
  it('keeps prose and tables side by side', () => {
    const blocks = blocksWithTables([
      item('Notes', 50, 100, 40, 12),
      item('Widget', 50, 220, 45),
      item('3', 200, 220, 8),
      item('$1.50', 320, 220, 35),
      item('Gizmo', 50, 240, 40),
      item('7', 200, 240, 8),
      item('$2.00', 320, 240, 35),
      item('Total', 50, 260, 35),
      item('10', 200, 260, 12),
      item('$3.50', 320, 260, 40),
    ]);
    expect(blocks.map((block) => block.type)).toEqual(['text', 'table']);
    expect(blocks[1].text).toBe('Widget\t3\t$1.50\nGizmo\t7\t$2.00\nTotal\t10\t$3.50');
  });

  it('covers() decides by overlap ratio', () => {
    const outer = { x: 0, y: 0, width: 100, height: 100 };
    expect(covers(outer, { x: 10, y: 10, width: 20, height: 20 })).toBe(true);
    expect(covers(outer, { x: 90, y: 90, width: 40, height: 40 })).toBe(false);
    expect(covers(outer, { x: 0, y: 0, width: 0, height: 0 })).toBe(false);
  });
});

describe('jsonToMarkdown', () => {
  const json = {
    pages: [
      page({
        page: 1,
        blocks: [
          textBlock('Quarterly Report', 18, 50),
          textBlock('Body copy that goes on for a while.', 10, 120),
          {
            type: 'table' as const,
            rect: { x: 50, y: 200, width: 300, height: 40 },
            rows: [
              ['Item', 'Note'],
              ['Widget', 'a | b'],
            ],
          },
        ],
      }),
      page({ page: 2, blocks: [textBlock('Second page heading', 15, 50)] }),
    ],
  };

  it('clusters heading heights and writes heading levels', () => {
    expect(detectHeadingHeights(json)).toEqual([18, 15]);
    const md = jsonToMarkdown(json);
    expect(md).toContain('# Quarterly Report');
    expect(md).toContain('## Second page heading');
    expect(md).toContain('Body copy that goes on for a while.');
  });

  it('renders tables with escaped pipes and a divider row', () => {
    const md = jsonToMarkdown(json);
    expect(md).toContain('| Item | Note |\n| --- | --- |\n| Widget | a \\| b |');
  });

  it('honours explicit headingHeights, and can drop tables and page breaks', () => {
    const md = jsonToMarkdown(json, { headingHeights: [18], tables: false, pageBreaks: false });
    expect(md).toContain('# Quarterly Report');
    expect(md).toContain('Body copy that goes on for a while.');
    expect(md).not.toContain('| Item |');
    expect(md).not.toContain('---');
  });

  it('markdownTable pads ragged rows', () => {
    expect(markdownTable([['a'], ['b', 'c']])).toBe('| a |  |\n| --- | --- |\n| b | c |');
  });

  it('headingLevelFor matches within a tolerance only', () => {
    expect(headingLevelFor(18, [18, 15])).toBe(1);
    expect(headingLevelFor(15.3, [18, 15])).toBe(2);
    expect(headingLevelFor(10, [18, 15])).toBe(0);
    expect(headingLevelFor(0, [18])).toBe(0);
  });

  it('maxFontHeight prefers the line data and ignores non-text blocks', () => {
    expect(maxFontHeight(textBlock('x', 12))).toBe(12);
    expect(maxFontHeight({ type: 'text', rect: { x: 0, y: 0, width: 10, height: 7 } })).toBe(7);
    expect(maxFontHeight({ type: 'table', rect: { x: 0, y: 0, width: 10, height: 40 } })).toBe(0);
  });
});

describe('jsonToText / jsonToLlamaIndex / jsonToHtml', () => {
  const json = {
    meta: { title: 'Report' },
    pages: [
      page({ page: 1, text: 'First page', blocks: [textBlock('First page', 10)] }),
      page({
        page: 2,
        text: 'Second page',
        blocks: [{ type: 'image' as const, rect: { x: 0, y: 0, width: 10, height: 10 } }],
        links: ['https://example.com/?a=1&b=2'],
      }),
    ],
  };

  it('separates pages with a form feed by default', () => {
    expect(jsonToText(json)).toBe('First page\f\nSecond page\n');
  });

  it('can drop the form feed and add page markers', () => {
    const text = jsonToText(json, { formFeed: false, pageMarkers: true });
    expect(text).toBe('--- page 1 ---\nFirst page\n\n--- page 2 ---\nSecond page\n');
  });

  it('writes the LlamaIndex ref_doc_info record', () => {
    const llama = jsonToLlamaIndex(json, { extraMetadata: { source: 'upload.pdf' } });
    const [id, record] = Object.entries(llama.ref_doc_info)[0];
    expect(id).toBe('Report');
    expect(record.metadata).toEqual({
      title: 'Report',
      num_pages: 2,
      source: 'upload.pdf',
    });
    expect(record.text).toContain('First page');
    expect(record.text).toContain('\f');
  });

  it('falls back to a neutral id and keeps an explicit title', () => {
    const llama = jsonToLlamaIndex({ pages: [] }, { title: 'Custom' });
    expect(Object.keys(llama.ref_doc_info)).toEqual(['Custom']);
  });

  it('escapes author text instead of injecting it', () => {
    const hostile = {
      pages: [
        page({
          page: 1,
          blocks: [textBlock('<img src=x onerror="alert(1)"> & friends', 10)],
        }),
      ],
    };
    const html = jsonToHtml(hostile);
    expect(html).toContain(
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; friends',
    );
    expect(html).not.toContain('<img');
    expect(escapeHtml(`"'&<>`)).toBe('&quot;&#39;&amp;&lt;&gt;');
  });

  it('emits real tables, links and page sections', () => {
    const html = jsonToHtml({
      meta: { title: 'T' },
      pages: [
        page({
          page: 1,
          blocks: [
            { type: 'table', rect: { x: 0, y: 0, width: 10, height: 10 }, rows: [['a'], ['b']] },
          ],
          links: ['https://example.com/?a=1&b=2'],
        }),
      ],
    });
    expect(html).toContain('<table class="pdf-table"');
    expect(html).toContain('<th>a</th>');
    expect(html).toContain('<td>b</td>');
    expect(html).toContain('href="https://example.com/?a=1&amp;b=2"');
    expect(html).toContain('<section class="pdf-page" data-page="1"');
  });
});

// ---------------------------------------------------------------------------
// The pure halves of ./measure and ./ocr. The §5 task budgets exactly two test
// files, so these blocks live here rather than in tests/pdf/measure.test.ts;
// every function below is canvas-free, which is what makes that possible.
// ---------------------------------------------------------------------------

describe('§5 module load in jsdom (no canvas)', () => {
  it('imports measure and ocr without touching a 2D context', async () => {
    const measure = await import('@/lib/pdf/core/measure');
    for (const name of [
      'isBlankPage',
      'detectSkew',
      'pageSizeReport',
      'rasterizeWithOptions',
      'applyColorFilter',
      'scannerEffect',
      'compressionPresets',
      'skewFromProjectionProfile',
    ]) {
      expect(typeof (measure as Record<string, unknown>)[name], name).toBe('function');
    }
    const ocr = await import('@/lib/pdf/core/ocr');
    for (const name of ['ocrDocument', 'addSearchableTextLayer', 'getOcrStatus', 'destroyOcr']) {
      expect(typeof (ocr as Record<string, unknown>)[name], name).toBe('function');
    }
    // The OCR layer must reuse the shared geometry, not a second copy of it.
    expect(ocr.viewerRectToUserSpace).toBe(viewerRectToUserSpace);
  });
});

describe('measure.ts — pure pixel maths', () => {
  const rgba = (pixels: [number, number, number, number][]) =>
    new Uint8ClampedArray(pixels.flat());

  it('measures the ink fraction and ignores transparent pixels', async () => {
    const { inkRatio, isBlankFromRatio } = await import('@/lib/pdf/core/measure');
    const mixed = rgba([
      [255, 255, 255, 255],
      [255, 255, 255, 255],
      [0, 0, 0, 255],
      [0, 0, 0, 255],
    ]);
    expect(inkRatio(mixed)).toBeCloseTo(0.5, 6);
    expect(inkRatio(rgba([[10, 10, 10, 0]]))).toBe(0);
    expect(inkRatio(new Uint8ClampedArray(0))).toBe(0);
    expect(isBlankFromRatio(0.0005, 0.001)).toBe(true);
    expect(isBlankFromRatio(0.02, 0.001)).toBe(false);
    // The luma this metric uses is the app's one shared rule, not a copy owned by
    // whichever module happens to count ink.
    const { luma255 } = await import('@/lib/pdf/core/colour');
    expect(luma255(255, 255, 255)).toBeCloseTo(255, 0);
  });

  it('builds the ink mask the skew search consumes', async () => {
    const { alphaMaskFromPixels } = await import('@/lib/pdf/core/measure');
    const mask = alphaMaskFromPixels(rgba([[0, 0, 0, 255], [255, 255, 255, 255]]), 2, 1);
    expect([...mask]).toEqual([1, 0]);
  });

  it('recovers a synthetic tilt from the projection profile', async () => {
    const { skewFromProjectionProfile } = await import('@/lib/pdf/core/measure');
    const width = 200;
    const height = 120;
    const tilt = (degreesValue: number) => {
      const mask = new Uint8Array(width * height);
      const slope = Math.tan((degreesValue * Math.PI) / 180);
      for (let line = 0; line < 6; line++) {
        for (let x = 0; x < width; x++) {
          const y = Math.round(20 + line * 18 + (x - width / 2) * slope);
          if (y >= 0 && y < height) mask[y * width + x] = 1;
        }
      }
      return mask;
    };
    const skewed = skewFromProjectionProfile(tilt(3), width, height, 5);
    expect(skewed.angle).toBeCloseTo(3, 1);
    expect(skewed.confidence).toBeGreaterThan(0.3);
    expect(skewFromProjectionProfile(tilt(0), width, height, 5).angle).toBeCloseTo(0, 1);
    // Nothing to lock onto: a blank page reports no correction.
    expect(skewFromProjectionProfile(new Uint8Array(width * height), width, height, 5)).toEqual({
      angle: 0,
      confidence: 0,
    });
    expect(skewFromProjectionProfile(tilt(3), 4, 4, 5)).toEqual({ angle: 0, confidence: 0 });
    expect(skewFromProjectionProfile(tilt(3), width, height, 0)).toEqual({ angle: 0, confidence: 0 });
  });

  it('thresholds, whitens and sharpens in place', async () => {
    const { thresholdPixels, whitenPixels, sharpenPixels, deskewAngleFor } =
      await import('@/lib/pdf/core/measure');
    const bilevel = rgba([[10, 10, 10, 255], [250, 250, 250, 255]]);
    thresholdPixels(bilevel, 128);
    expect([...bilevel]).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);

    const paper = rgba([[128, 128, 128, 255]]);
    expect(whitenPixels(paper, 0)).toEqual(rgba([[128, 128, 128, 255]]));
    whitenPixels(paper, 0.6);
    expect(paper[0]).toBeGreaterThan(128);

    // A dim pixel ringed by paper gets dimmer; alpha is never touched.
    const w = 3;
    const h = 3;
    const grey = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      grey[i * 4] = grey[i * 4 + 1] = grey[i * 4 + 2] = 255;
      grey[i * 4 + 3] = 255;
    }
    const centre = (1 * w + 1) * 4;
    grey[centre] = grey[centre + 1] = grey[centre + 2] = 100;
    sharpenPixels(grey, w, h, 0);
    expect(grey[centre]).toBe(100);
    sharpenPixels(grey, w, h, 1);
    expect(grey[centre]).toBeLessThan(100);
    expect(grey[centre + 3]).toBe(255);

    expect(deskewAngleFor({ angle: 3, confidence: 1 }, 5)).toBe(-3);
    expect(deskewAngleFor({ angle: 20, confidence: 1 }, 5)).toBe(-5);
  });

  it('composes one CSS filter string', async () => {
    const { cssFilterString, dpiToScale } = await import('@/lib/pdf/core/measure');
    expect(
      cssFilterString({
        brightness: 1.1,
        contrast: 1.2,
        saturation: 0.5,
        hue: 90,
        invert: true,
        grayscale: true,
      }),
    ).toBe('grayscale(1) invert(1) brightness(1.1) contrast(1.2) saturate(0.5) hue-rotate(90deg)');
    expect(cssFilterString({ brightness: 1, contrast: 1, saturation: 1, hue: 0, invert: false, grayscale: false })).toBe('');
    expect(dpiToScale(300)).toBeCloseTo(300 / 72, 6);
  });

  it('names standard page sizes within a point, either orientation', async () => {
    const { pageSizeName, compressionPresets, PAGE_NAME_TOLERANCE_PT } =
      await import('@/lib/pdf/core/measure');
    expect(PAGE_NAME_TOLERANCE_PT).toBe(1);
    expect(pageSizeName(595.28, 841.89)).toBe('A4');
    expect(pageSizeName(841.89, 595.28)).toBe('A4');
    expect(pageSizeName(595.9, 841.89)).toBe('A4');
    expect(pageSizeName(612, 792)).toBe('Letter');
    expect(pageSizeName(612, 1008)).toBe('Legal');
    expect(pageSizeName(841.89, 1190.55)).toBe('A3');
    expect(pageSizeName(792, 1224)).toBe('Tabloid');
    expect(pageSizeName(419.53, 595.28)).toBe('A5');
    expect(pageSizeName(311.81, 623.62)).toBe('DL');
    expect(pageSizeName(500, 700)).toBe('Custom');
    // A3 is the nearest 1-pt-or-less match for a page between A3 and A4 sizes.
    expect(pageSizeName(600, 850)).toBe('Custom');

    const presets = compressionPresets();
    expect(new Set(presets.map((preset) => preset.id)).size).toBe(presets.length);
    expect(presets.map((preset) => preset.dpi)).toEqual([...presets.map((p) => p.dpi)].sort((a, b) => a - b));
    for (const preset of presets) {
      expect(preset.quality).toBeGreaterThan(0);
      expect(preset.quality).toBeLessThanOrEqual(1);
      expect(preset.label.length).toBeGreaterThan(0);
      expect(preset.description.length).toBeGreaterThan(0);
    }
  });
});

describe('ocr.ts — word boxes and searchable-page detection', () => {
  const run = (
    str: string,
    x: number,
    y: number,
    w: number,
    opts: { invisible?: boolean; page?: number } = {},
  ): ExtractedTextItem => ({
    str,
    transform: [10, 0, 0, 10, x, 841.89 - y],
    width: w,
    height: 10,
    fontName: 'F0',
    dir: 'ltr',
    page: opts.page ?? 1,
    x,
    y,
    w,
    h: 10,
    hasEOL: false,
    isInvisible: opts.invisible ?? false,
  });

  it('counts only visible characters when deciding a page is searchable', async () => {
    const { isPageSearchable } = await import('@/lib/pdf/core/ocr');
    expect(isPageSearchable([run('the quick brown fox jumps over the lazy dog', 50, 100, 300)])).toBe(true);
    expect(isPageSearchable([run('short', 50, 100, 40)])).toBe(false);
    expect(
      isPageSearchable([run('the quick brown fox jumps over the lazy dog', 50, 100, 300, { invisible: true })]),
    ).toBe(false);
    expect(isPageSearchable([run('a'.repeat(30), 50, 100, 300)], { minChars: 10 })).toBe(true);
  });

  it('splits a recognised line into word boxes that tile the line', async () => {
    const { wordBoxesFromLines } = await import('@/lib/pdf/core/ocr');
    const words = wordBoxesFromLines([
      { text: 'Hello World', box: { x: 0, y: 10, width: 110, height: 10 }, confidence: 0.9123 },
      { text: '   ', box: { x: 0, y: 40, width: 10, height: 10 }, confidence: 0.5 },
    ]);
    expect(words.map((word) => word.text)).toEqual(['Hello', 'World']);
    expect(words[0].rect.y).toBe(10);
    expect(words[0].rect.height).toBe(10);
    expect(words[0].rect.x).toBe(0);
    expect(words[1].rect.x).toBeGreaterThan(words[0].rect.x + words[0].rect.width);
    expect(words[0].confidence).toBe(0.9123);
    const right = words[0].rect.x + words[0].rect.width;
    expect(right).toBeLessThanOrEqual(words[1].rect.x + 0.001);
    expect(words[1].rect.x + words[1].rect.width).toBeCloseTo(110, 1);
  });

  it('summarises what the pass actually did', async () => {
    const { ocrCounts } = await import('@/lib/pdf/core/ocr');
    expect(
      ocrCounts([
        { page: 1, text: '', width: 0, height: 0, blocks: [], words: [{} as never], alreadySearchable: false },
        { page: 2, text: '', width: 0, height: 0, blocks: [], words: [], alreadySearchable: true },
      ]),
    ).toEqual({ pages: 2, recognised: 1, alreadySearchable: 1, words: 1 });
  });
});

describe('ocr.ts — the searchable text layer it writes', () => {
  const results = [
    {
      page: 1,
      text: 'Hello World',
      width: 600,
      height: 800,
      alreadySearchable: false,
      blocks: [
        {
          text: 'Hello World',
          rect: { x: 50, y: 700, width: 110, height: 12 },
          confidence: 0.9,
        },
      ],
      words: [
        { text: 'Hello', rect: { x: 50, y: 700, width: 55, height: 12 }, confidence: 0.9 },
        { text: 'World', rect: { x: 110, y: 700, width: 55, height: 12 }, confidence: 0.88 },
      ],
    },
    {
      page: 2,
      text: 'already fine',
      width: 600,
      height: 800,
      alreadySearchable: true,
      blocks: [],
      words: [],
    },
  ];

  async function contentOf(doc: PDFDocument): Promise<string> {
    const reloaded = await PDFDocument.load(await doc.save({ useObjectStreams: false }));
    const contents = reloaded.getPage(0).node.Contents();
    const chunks: string[] = [];
    const arrayLike = contents as unknown as { size?(): number; get(i: number): unknown };
    const streams: unknown[] = [];
    if (arrayLike && typeof arrayLike.size === 'function') {
      // A page may carry several content streams, referenced or inline.
      for (let i = 0; i < arrayLike.size(); i++) {
        streams.push(reloaded.context.lookup(arrayLike.get(i) as never));
      }
    } else if (contents) {
      streams.push(contents);
    }
    for (const stream of streams) {
      const candidate = stream as { dict?: unknown; contents?: unknown };
      if (!candidate || candidate.dict === undefined || candidate.contents === undefined) continue;
      const bytes = (decodePDFRawStream(stream as never) as { decode(): Uint8Array }).decode();
      chunks.push(new TextDecoder('latin1').decode(bytes));
    }
    return chunks.join('\n');
  }

  it('writes real, invisible text with the fork operator helpers', async () => {
    const { addSearchableTextLayer } = await import('@/lib/pdf/core/ocr');
    const doc = await PDFDocument.create();
    doc.addPage([595.28, 841.89]);
    doc.addPage([595.28, 841.89]);

    const counts = await addSearchableTextLayer(doc, results as never);
    expect(counts).toEqual({ words: 2, pages: 1, skipped: 1 });

    const content = await contentOf(doc);
    expect(content).toContain('BT');
    expect(content).toContain('ET');
    expect(content).toContain('3 Tr'); // TextRenderingMode.Invisible
    // pdf-lib keys the font resource by its base font name, the same way its own
    // `drawText` does (`newFontDictionary(font.name, font.ref)`).
    const fontMatch = content.match(/\/([\w.-]+) (\d+(?:\.\d+)?) Tf/);
    expect(fontMatch, content).not.toBeNull();
    expect(fontMatch![2]).toBe('10.2'); // 0.85 × the 12 pt box height
    expect(content).toMatch(/Tm/);
    // Words are encoded for the embedded font, not written as literal text.
    expect(content).toContain('Tj');
    expect(content).not.toContain('(Hello)');

    const reloaded = await PDFDocument.load(await doc.save());
    const fonts = reloaded
      .getPage(0)
      .node.Resources()!
      .lookupMaybe(PDFName.of('Font'), PDFDict)!;
    expect(fonts.keys().length).toBe(1);
    const [key, value] = fonts.entries()[0];
    expect(key.asString()).toBe(`/${fontMatch![1]}`);
    const first = reloaded.context.lookup(value) as PDFDict;
    expect(first.lookupMaybe(PDFName.of('BaseFont'), PDFName)?.asString()).toBe('/Helvetica');
  });

  it('paints visible text when the caller asks for an overlay', async () => {
    const { addSearchableTextLayer } = await import('@/lib/pdf/core/ocr');
    const doc = await PDFDocument.create();
    doc.addPage([595.28, 841.89]);
    doc.addPage([595.28, 841.89]);
    await addSearchableTextLayer(doc, results as never, { invisible: false });
    const content = await contentOf(doc);
    expect(content).toContain('0 Tr');
    expect(content).toContain('0 0 0 rg');
    expect(content).not.toContain('3 Tr');
  });

  it('refuses to write a layer onto a page the document does not have', async () => {
    const { addSearchableTextLayer } = await import('@/lib/pdf/core/ocr');
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    await expect(
      addSearchableTextLayer(doc, [{ ...results[0], page: 4 }] as never),
    ).rejects.toThrow(/page 4, but this document has 1 page/);
  });

  it('reports the engine status it exposes from src/lib/ocr/engine', async () => {
    const { getOcrStatus } = await import('@/lib/pdf/core/ocr');
    expect(getOcrStatus()).toEqual({ status: 'idle', message: '' });
  });
});
