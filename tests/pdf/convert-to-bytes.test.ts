/**
 * What the Convert-to-PDF family actually puts in the file.
 *
 * `edge-convert-to.test.ts` covers the sentences — refusals, warnings, the
 * promise and the notes. This file opens the produced bytes and asks a harder
 * question: is the content in the right place? A page count proves something was
 * written, not that it is correct, so every test here decodes the output and
 * checks where things landed:
 *
 *   - page size and page count, from the page boxes themselves;
 *   - text decoded back through the page's own fonts, in reading order, with the
 *     size each run was drawn at (so a heading is still bigger than a paragraph);
 *   - images with the pixel box they carry and the rectangle they are drawn into;
 *   - tables as a grid: one baseline per row, one `x` per column, the header on
 *     every sheet the table spills onto;
 *   - CJK and accented characters surviving as themselves rather than as boxes.
 *
 * A stub cannot pass this: the assertions are made on bytes the tools produced,
 * decoded by the same rules a viewer uses.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, type PDFPage, PDFRef, PDFStream, StandardFonts, type PDFObject } from '@maxwbh/pdf-lib';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { clearFontCache } from '@/lib/pdf/core/fonts';
import { ToolInputError } from '@/lib/pdf/core/guard';
import { pageContentOps, type ContentOp, type NumberOperand } from '@/lib/pdf/core/content';
import {
  OLE_BYTES,
  PNG_1PX,
  bmpBytes,
  cbzBytes,
  compact,
  docxBytes,
  epubBytes,
  extractText,
  fileFrom,
  firstPdf,
  imagesPerPage,
  installConvertToEnv,
  jpegBytes,
  numberedDocxBytes,
  odpBytes,
  odtBytes,
  pageSizes,
  pdfBytes,
  pptxBytes,
  psdBytes,
  realPng,
  resetConvertToEnv,
  restoreConvertToEnv,
  run,
  squash,
  textRuns,
  tiffBytes,
  workbookBytes,
  webpBytes,
  zipBytes,
  type TextRun,
} from './convert-to-harness';

/** Recogniser output, in the 595 × 842 viewer units `core/ocr` maps from. */
const OCR = {
  words: [] as { text: string; x: number; y: number; width: number; height: number }[],
};

vi.mock('@/lib/pdf/core/render', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/pdf/core/render')>();
  return { ...real, openRender: (bytes: ArrayBuffer | Uint8Array) => openStub(bytes) };
});

vi.mock('@/lib/ocr/engine', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/ocr/engine')>();
  return {
    ...real,
    initOcr: async () => undefined,
    recognizeCanvas: async (canvas: HTMLCanvasElement) => {
      const width = canvas.width || 1785;
      const height = canvas.height || 2526;
      return {
        text: OCR.words.map((row) => row.text).join('\n'),
        results: OCR.words.map((row) => ({
          text: row.text,
          box: {
            x: (row.x / 595) * width,
            y: (row.y / 842) * height,
            width: (row.width / 595) * width,
            height: (row.height / 842) * height,
          },
          confidence: 0.95,
        })),
      };
    },
  };
});

async function openStub(bytes: ArrayBuffer | Uint8Array) {
  const doc = await PDFDocument.load(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const count = doc.getPageCount();
  return {
    numPages: count,
    page: async () => ({ view: [0, 0, 595, 842], rotate: 0 }),
    textItems: async () => [],
    renderPage: async (_n: number, scale: number) => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(595 * scale);
      canvas.height = Math.round(842 * scale);
      return { canvas, width: canvas.width, height: canvas.height, cancel: () => undefined };
    },
    metadata: async () => ({ numPages: count, info: {}, metadata: {} }),
    destroy: async () => undefined,
  } as unknown as Awaited<ReturnType<typeof import('@/lib/pdf/core/render').openRender>>;
}

beforeAll(() => {
  installConvertToEnv();
});

afterEach(() => {
  resetConvertToEnv();
  OCR.words = [];
});

afterAll(() => {
  restoreConvertToEnv();
});

/* ------------------------------------------------------------------ *
 * Reading geometry back out                                          *
 * ------------------------------------------------------------------ */

const round = (value: number) => Math.round(value * 100) / 100;

/** Runs in the order a viewer reads them: top to bottom, then left to right. */
function inOrder(runs: TextRun[]): TextRun[] {
  return [...runs].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
}

/** Distinct baselines, top first — one per visual line of text. */
function baselines(runs: TextRun[]): number[] {
  return [...new Set(runs.map((run) => round(run.y)))].sort((a, b) => b - a);
}

/** Distinct left edges, left first — one per visual column. */
function columns(runs: TextRun[]): number[] {
  return [...new Set(runs.map((run) => round(run.x)))].sort((a, b) => a - b);
}

function runsOn(runs: TextRun[], page: number): TextRun[] {
  return runs.filter((run) => run.page === page);
}

function find(runs: TextRun[], text: string): TextRun[] {
  return runs.filter((run) => run.text.includes(text));
}

/**
 * The gutter `core/layout.ts` `renderList` reserves for a list whose widest marker
 * is `marker`: the renderer measures that marker in the face it draws it in and
 * starts every item at `margin + max(14, 2 + marker + 2)`. The route buys no indent
 * of its own any more, so a pin about where item text starts says it in these units.
 */
async function seamGutter(marker: string, size: number): Promise<number> {
  const face = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
  return Math.max(14, 2 + face.widthOfTextAtSize(marker, size) + 2);
}

/** The band fill `#f1f1ec` and the code ink `rgb(0.15, 0.15, 0.13)` of `renderBlocks`. */
const CODE_BAND = [0xf1 / 255, 0xf1 / 255, 0xec / 255];
const CODE_INK = [0.15, 0.15, 0.13];
const sameColour = (colour: number[], want: number[]) => colour.length === want.length
  && colour.every((value, index) => Math.abs(value - want[index]) <= 0.005);
const numbersOf = (op: ContentOp): number[] => op.operands
  .filter((operand) => operand.kind === 'number')
  .map((operand) => (operand as NumberOperand).value);

interface CodePaint {
  /** Every `#f1f1ec` fill of the page, in stream order — paint order is exactly stream order. */
  bands: { index: number; rect: [number, number, number, number] }[];
  /** Every code-coloured text show, with its stream position and origin. */
  ink: { index: number; x: number; y: number }[];
}

/**
 * The grey code band of a page and the code-coloured runs that sit on it.
 *
 * A band painted *after* its glyphs buries them: the shape `renderBlocks` had when
 * the convert battery filed it (c3 blocker 1), where the page carried the rectangle
 * and 0 dark pixels of code ink while every word still extracted. Returning both
 * stream positions is what lets a pin say the words are actually on the page.
 */
function codePaintOf(page: PDFPage): CodePaint {
  let colour: number[] = [];
  let origin: [number, number] | null = null;
  let spanX = 0;
  let spanY = 0;
  let x = 0;
  let y = 0;
  const bands: CodePaint['bands'] = [];
  const ink: CodePaint['ink'] = [];
  pageContentOps(page).forEach((op, index) => {
    const n = numbersOf(op);
    if (op.name === 'rg' && n.length === 3) colour = n;
    else if (op.name === 'cm' && n.length === 6 && (n[4] !== 0 || n[5] !== 0)) {
      origin = [n[4], n[5]];
      spanX = 0;
      spanY = 0;
    } else if ((op.name === 'm' || op.name === 'l') && n.length >= 2) {
      spanX = Math.max(spanX, n[0]);
      spanY = Math.max(spanY, n[1]);
    } else if (op.name === 'f' && origin) {
      if (sameColour(colour, CODE_BAND)) bands.push({ index, rect: [origin[0], origin[1], spanX, spanY] });
      origin = null;
    } else if ((op.name === 'Td' || op.name === 'TD') && n.length >= 2) {
      x += n[0];
      y += n[1];
    } else if (op.name === 'Tm' && n.length >= 6) {
      x = n[4];
      y = n[5];
    } else if ((op.name === 'Tj' || op.name === 'TJ') && sameColour(colour, CODE_INK)) {
      ink.push({ index, x, y });
    }
  });
  return { bands, ink };
}

/**
 * The fill the code glyphs sit on. A table header is painted in the same grey
 * (`rgb(0.945, 0.945, 0.925)`), so the band of a code block is the one whose
 * rectangle holds a code baseline — not merely the first grey fill on the sheet.
 */
function bandUnder(painted: CodePaint): CodePaint['bands'][number] | null {
  return painted.bands.find((band) => painted.ink.some((run) => run.y >= band.rect[1] - 0.01
    && run.y <= band.rect[1] + band.rect[3] + 0.01)) ?? null;
}

/** The code leading `renderBlocks` draws one line of code at, for 11 pt body text. */
const CODE_LINE_HEIGHT = Math.max(7, 11 * 0.88) * 1.35;

/**
 * A page whose code is really on it: the grey band exists, every glyph of the block
 * was shown *after* that opaque fill, and the rectangle is the one `paintCodeBox`
 * has always computed — column-wide from the 56 pt margin, one code leading per line,
 * each baseline inside it.
 *
 * This is the re-anchored half of c3 blocker 1: the same cases used to be pinned (and
 * measured live, in MuPDF and in ghostscript) as a band with **0** dark pixels in it —
 * the words extracted, nothing painted. `core/layout.ts` now fills first, so an empty
 * band is a regression again, for every route that hands the renderer a `kind:'code'`
 * block: Monospaced text, fenced Markdown, HTML `<pre>`, JSON and XML.
 */
function expectPaintedCode(page: PDFPage, lines: number): void {
  const painted = codePaintOf(page);
  const band = bandUnder(painted);
  expect(band, 'the grey code band').toBeTruthy();
  expect(painted.ink.length, 'the code glyphs painted on it').toBe(lines);
  expect(band!.index, 'the band was painted after its glyphs, which buries them').toBeLessThan(
    Math.min(...painted.ink.map((run) => run.index)),
  );
  const [x, y, width, height] = band!.rect;
  expect(x, 'the band starts at the margin').toBeCloseTo(56, 1);
  expect(width, 'the band spans the text column').toBeCloseTo(595.28 - 112, 1);
  expect(height, 'the band is one code leading per line').toBeCloseTo(lines * CODE_LINE_HEIGHT, 1);
  for (const run of painted.ink) {
    expect(run.y, `the baseline ${run.y} left the band`).toBeGreaterThanOrEqual(y - 0.01);
    expect(run.y, `the baseline ${run.y} left the band`).toBeLessThanOrEqual(y + height + 0.01);
  }
}

/**
 * XObject names a page (or a Form it draws) refers to that the file never wrote.
 *
 * Resolved through the document's own cross-reference table, the way a reader
 * does: an entry whose object is absent is a `Do` for nothing.
 */
async function danglingXObjects(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const dangling: string[] = [];
  const walk = (resources: PDFObject | undefined, page: number, depth: number) => {
    const dict = resources instanceof PDFDict ? resources : undefined;
    const xobjects = dict?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    if (!(xobjects instanceof PDFDict)) return;
    for (const [name, value] of xobjects.entries()) {
      const label = `p${page}:${name.asString().replace(/^\//, '')}`;
      if (value instanceof PDFRef) {
        const target = doc.context.lookup(value);
        if (target === undefined) { dangling.push(label); continue; }
        if (target instanceof PDFStream && depth === 0) {
          walk(target.dict.lookupMaybe(PDFName.of('Resources'), PDFDict), page, depth + 1);
        }
      }
    }
  };
  doc.getPages().forEach((page, index) => walk(page.node.Resources(), index, 0));
  return dangling;
}

/** The `/Image` and `/Form` XObjects a page draws, with their placed boxes. */
async function placedOn(bytes: Uint8Array, page = 0) {
  const perPage = await imagesPerPage(bytes);
  return perPage[page] ?? [];
}

/* ------------------------------------------------------------------ *
 * Images to PDF: the picture is where it was placed                  *
 * ------------------------------------------------------------------ */

describe('image-to-pdf places the picture it was given', () => {
  it('hugs a 300 × 120 PNG: the sheet is the picture plus the margin', async () => {
    const outcome = await run('image-to-pdf', { pageSize: 'fit', margin: 6 }, [
      fileFrom(realPng(300, 120), 'shot.png', 'image/png'),
    ]);
    const bytes = await firstPdf(outcome);
    expect(await pageSizes(bytes)).toEqual([[312, 132]]);
    const [placed] = await placedOn(bytes);
    expect(placed?.pixels).toEqual([300, 120]);
    expect(placed?.box.map(round)).toEqual([6, 6, 300, 120]);
  });

  it('fits a wide picture inside A4 without cropping or distorting it', async () => {
    const outcome = await run('image-to-pdf', { pageSize: 'a4', orientation: 'portrait', fit: 'contain' }, [
      fileFrom(realPng(800, 200), 'banner.png', 'image/png'),
    ]);
    const bytes = await firstPdf(outcome);
    const [[pageW, pageH]] = await pageSizes(bytes);
    const [placed] = await placedOn(bytes);
    expect(placed).toBeTruthy();
    const [, , w, h] = placed!.box;
    // Same aspect ratio as the source, and no larger than the sheet.
    expect(round(w / h)).toBe(round(800 / 200));
    expect(w).toBeLessThanOrEqual(pageW + 0.01);
    expect(h).toBeLessThanOrEqual(pageH + 0.01);
    expect(w).toBeGreaterThan(pageW * 0.9);
  });

  it('fills the sheet under “Fill the page (crop)”, overflowing on one axis', async () => {
    const outcome = await run('image-to-pdf', { pageSize: 'a4', orientation: 'portrait', fit: 'cover' }, [
      fileFrom(realPng(800, 200), 'banner.png', 'image/png'),
    ]);
    const bytes = await firstPdf(outcome);
    const [[pageW, pageH]] = await pageSizes(bytes);
    const [placed] = await placedOn(bytes);
    const [, , w, h] = placed!.box;
    expect(round(w / h)).toBe(round(800 / 200));
    expect(w).toBeGreaterThanOrEqual(pageW - 0.01);
    expect(h).toBeGreaterThanOrEqual(pageH - 0.01);
  });

  it('stretches when Stretch is chosen: the picture takes the whole box', async () => {
    const outcome = await run('image-to-pdf', { pageSize: 'a4', orientation: 'portrait', fit: 'stretch', margin: 0 }, [
      fileFrom(realPng(800, 200), 'banner.png', 'image/png'),
    ]);
    const bytes = await firstPdf(outcome);
    const [[pageW, pageH]] = await pageSizes(bytes);
    const [placed] = await placedOn(bytes);
    const [x, y, w, h] = placed!.box.map(round);
    // The field promises distortion (“the picture is … distorted by stretch”),
    // so the drawn box must be the sheet, not a contain-fitted copy of it.
    expect([x, y]).toEqual([0, 0]);
    expect(w).toBeCloseTo(pageW, 1);
    expect(h).toBeCloseTo(pageH, 1);
  });

  it('puts two pictures on each sheet, side by side and inside it', async () => {
    const outcome = await run(
      'image-to-pdf',
      { onePerSheet: true, pageSize: 'a4', margin: 0 },
      [1, 2, 3, 4].map((n) => fileFrom(realPng(100, 50 * n), `p${n}.png`, 'image/png')),
    );
    const bytes = await firstPdf(outcome);
    const pages = await imagesPerPage(bytes);
    const sheetSizes = await pageSizes(bytes);
    expect(pages.length).toBe(2);
    for (const [index, page] of pages.entries()) {
      expect(page.length).toBe(2);
      const [pageW, pageH] = sheetSizes[index]!;
      const ys = page.map((placed) => round(placed.box[1]));
      const tops = page.map((placed) => round(placed.box[1] + placed.box[3]));
      // One above the other, and neither runs off the sheet.
      expect(new Set(ys).size).toBe(2);
      for (const [position, placed] of page.entries()) {
        expect(placed.box[0]).toBeGreaterThanOrEqual(-0.01);
        expect(placed.box[2]).toBeLessThanOrEqual(pageW + 0.01);
        expect(placed.box[1]).toBeGreaterThanOrEqual(-0.01);
        expect(tops[position]).toBeLessThanOrEqual(pageH + 0.01);
      }
      expect(page[0]!.box[1]).toBeGreaterThan(page[1]!.box[1]);
    }
  });

  it('leaves both pictures reachable in the file when two share a sheet', async () => {
    // A `Do` is not a drawing: the page named `/EmbeddedPdfPage-…` at an object
    // number the finished file never wrote, so a reader painted 0 ink on a sheet
    // that measured two placed images. `placedImages` above reads resource
    // *entries*, so it saw the pair either way — `pixels` falls back to [0, 0]
    // and `kind` to 'Unknown' exactly when the object behind the entry is gone.
    const straight = await firstPdf(await run('image-to-pdf', { pageSize: 'fit', margin: 0 }, [
      fileFrom(realPng(120, 60), 'a.png', 'image/png'),
    ]));
    // Control: the unpaired route already resolves, so a hit below is the pair-up.
    expect(await danglingXObjects(straight)).toEqual([]);

    const outcome = await run('image-to-pdf', { onePerSheet: true, pageSize: 'a4', margin: 0 }, [
      fileFrom(realPng(120, 60), 'a.png', 'image/png'),
      fileFrom(realPng(60, 120), 'b.png', 'image/png'),
    ]);
    const bytes = await firstPdf(outcome);
    expect(await danglingXObjects(bytes)).toEqual([]);
    const pages = await imagesPerPage(bytes);
    expect(pages.length).toBe(1);
    // Each side is an embedded page, so the entry is a Form with the picture's
    // own box inside it — `[0, 0]` again the moment the object is gone.
    expect(pages[0]!.map((placed) => placed.kind)).toEqual(['Form', 'Form']);
    expect(pages[0]!.map((placed) => placed.pixels)).toEqual([[120, 60], [60, 120]]);
  });

  it('hides Fit and Orientation where they cannot move anything', async () => {
    // Measured in a real tab: at the default "Hug each image" the sheet is the
    // picture's own box, and `placeImage` sizes it from the pixels alone — so
    // Fit and Orientation were two controls over nothing on the default path.
    const definition = getPdfTool('image-to-pdf')!;
    for (const key of ['fit', 'orientation']) {
      const field = definition.fields!.find((entry) => entry.key === key)!;
      expect(field.when).toBeDefined();
      expect(field.when!({ pageSize: 'fit' })).toBe(false);
      expect(field.when!({ pageSize: 'a4', onePerSheet: true })).toBe(false);
      expect(field.when!({ pageSize: 'a4' })).toBe(true);
    }
    // The control must still be live wherever it is still shown, or the fix hid
    // a working control instead of a dead one.
    const hugged = await run('image-to-pdf', { pageSize: 'fit', fit: 'stretch', orientation: 'portrait', margin: 0 }, [
      fileFrom(realPng(120, 60), 'a.png', 'image/png'),
    ]);
    expect(await pageSizes(await firstPdf(hugged))).toEqual([[120, 60]]);
    const sheeted = await run('image-to-pdf', { pageSize: 'a4', fit: 'stretch', orientation: 'landscape', margin: 0 }, [
      fileFrom(realPng(120, 60), 'a.png', 'image/png'),
    ]);
    expect(await pageSizes(await firstPdf(sheeted))).toEqual([[841.89, 595.28]]);
  });

  it('follows the EXIF orientation of a phone photo', async () => {
    const outcome = await run('image-to-pdf', { pageSize: 'fit', margin: 0 }, [
      fileFrom(jpegBytes(400, 200, 6), 'shot.jpg', 'image/jpeg'),
    ]);
    // Orientation 6 is “rotate 90°”, so the sheet is portrait even though the
    // stored pixel box is landscape.
    expect(await pageSizes(await firstPdf(outcome))).toEqual([[200, 400]]);
  });

  it('keeps a 100-image batch one page per image, in the order added', async () => {
    const files = Array.from({ length: 12 }, (_, index) =>
      fileFrom(realPng(20 + index, 10), `s${index}.png`, 'image/png'),
    );
    const outcome = await run('image-to-pdf', { pageSize: 'fit', margin: 0 }, files);
    const bytes = await firstPdf(outcome);
    const sizes = await pageSizes(bytes);
    expect(sizes.length).toBe(12);
    expect(sizes.map(([w]) => w)).toEqual(Array.from({ length: 12 }, (_, index) => 20 + index));
    const images = await imagesPerPage(bytes);
    expect(images.map((page) => page[0]?.pixels[0])).toEqual(sizes.map(([w]) => w));
  });
});

/* ------------------------------------------------------------------ *
 * Format-specific routes: the pixels that arrived are the pixels kept *
 * ------------------------------------------------------------------ */

describe('the format-specific image routes keep real dimensions', () => {
  it('png-to-pdf embeds the PNG at its own size on the chosen sheet', async () => {
    const outcome = await run('png-to-pdf', { pageSize: 'a4', margin: 0 }, [
      fileFrom(realPng(240, 120), 'shot.png', 'image/png'),
    ]);
    const bytes = await firstPdf(outcome);
    expect(await pageSizes(bytes)).toEqual([[595.28, 841.89]]);
    const [placed] = await placedOn(bytes);
    expect(placed?.pixels).toEqual([240, 120]);
    expect(round(placed!.box[2] / placed!.box[3])).toBe(2);
  });

  it('jpg-to-pdf keeps the JPEG’s own width and height', async () => {
    const outcome = await run('jpg-to-pdf', { pageSize: 'a4', margin: 0 }, [
      fileFrom(jpegBytes(320, 200), 'photo.jpg', 'image/jpeg'),
    ]);
    const [placed] = await placedOn(await firstPdf(outcome));
    expect(placed?.pixels).toEqual([320, 200]);
  });

  it('jpg-to-pdf makes the page the picture unless a sheet is asked for', async () => {
    // The route opened on A4 with no hug in the list: a 320 x 200 JPEG sat in a
    // 595 x 842 sheet at 161 596 ink px of 501 832. Hugging is now the default,
    // so the sheet is the picture and no sheet has to be named.
    const outcome = await run('jpg-to-pdf', {}, [fileFrom(jpegBytes(320, 200), 'photo.jpg', 'image/jpeg')]);
    const bytes = await firstPdf(outcome);
    expect(await pageSizes(bytes)).toEqual([[320, 200]]);
    const [placed] = await placedOn(bytes);
    expect(placed?.pixels).toEqual([320, 200]);
  });

  it('jpg-to-pdf leaves out a file of another format and converts the rest', async () => {
    // One PNG among the JPEGs used to kill the whole run and hand back nothing,
    // naming only the PNG: a batch is a batch.
    const outcome = await run('jpg-to-pdf', {}, [
      fileFrom(realPng(120, 60), 'shot.png', 'image/png'),
      fileFrom(jpegBytes(320, 200), 'photo.jpg', 'image/jpeg'),
    ]);
    const bytes = await firstPdf(outcome);
    expect(await pageSizes(bytes)).toEqual([[320, 200]]);
    expect(outcome.warnings.join(' ')).toMatch(/shot\.png/);
    expect(outcome.warnings.join(' ')).toMatch(/left out/);
  });

  it('bmp-to-pdf reads the BMP header rather than a fallback size', async () => {
    const outcome = await run('bmp-to-pdf', { pageSize: 'a4', margin: 0 }, [
      fileFrom(bmpBytes(160, 90), 'raw.bmp', 'image/bmp'),
    ]);
    const [placed] = await placedOn(await firstPdf(outcome));
    expect(placed?.pixels).toEqual([160, 90]);
  });

  it('webp-to-pdf reads the VP8 frame header', async () => {
    const outcome = await run('webp-to-pdf', { pageSize: 'a4', margin: 0 }, [
      fileFrom(webpBytes(128, 64), 'still.webp', 'image/webp'),
    ]);
    const [placed] = await placedOn(await firstPdf(outcome));
    expect(placed?.pixels).toEqual([128, 64]);
  });

  it('psd-to-pdf embeds the flattened preview the file carries', async () => {
    const outcome = await run('psd-to-pdf', { pageSize: 'a4', margin: 0 }, [
      fileFrom(psdBytes(120, 60), 'master.psd', 'image/vnd.adobe.photoshop'),
    ]);
    const [placed] = await placedOn(await firstPdf(outcome));
    expect(placed?.pixels).toEqual([120, 60]);
  });

  it('tiff-to-pdf refuses a truncated TIFF instead of padding it white', async () => {
    // UTIF and the canvas pad a short file with white and answer a complete page:
    // a TIFF cut to 40 % embedded as a full 200 x 120 sheet with 72 blank rows
    // and nothing said. The strip table says whether the file is all there.
    const whole = tiffBytes([{ width: 200, height: 120 }]);
    const cut = whole.slice(0, Math.floor(whole.length * 0.4));
    const outcome = await run('tiff-to-pdf', { pageSize: 'fit', margin: 0 }, [
      fileFrom(cut, 'cut.tif', 'image/tiff'),
      fileFrom(tiffBytes([{ width: 40, height: 30 }]), 'ok.tif', 'image/tiff'),
    ]);
    const bytes = await firstPdf(outcome);
    expect(await pageSizes(bytes)).toEqual([[40, 30]]);
    expect(outcome.warnings.join(' ')).toMatch(/cut\.tif.*stops early/);
  });

  it('psd-to-pdf refuses a PSD cut before its composite instead of using a thumbnail', async () => {
    // The composite is the last thing in a PSD. Cut the file and the backwards
    // scan lands on the little thumbnail in the image-resource block: a 200 x 120
    // canvas came out as a 120 x 60 page with half its rows blank, silently.
    const whole = psdBytes(200, 120);
    const cut = whole.slice(0, Math.floor(whole.length * 0.55));
    const outcome = await run('psd-to-pdf', { pageSize: 'fit', margin: 0 }, [
      fileFrom(cut, 'cut.psd', 'image/vnd.adobe.photoshop'),
      fileFrom(psdBytes(40, 30), 'ok.psd', 'image/vnd.adobe.photoshop'),
    ]);
    const bytes = await firstPdf(outcome);
    expect(await pageSizes(bytes)).toEqual([[40, 30]]);
    expect(outcome.warnings.join(' ')).toMatch(/cut\.psd.*stops before the end/);
  });

  it('svg-to-pdf refuses a raster named .svg, naming both formats', async () => {
    // The page size of a painted SVG is a browser measurement (jsdom's canvas
    // mock does not honour the intrinsic size): the dev build gives a 200 x 100
    // drawing a 312 x 212 page at the default margin, colours exact. What can be
    // pinned here is the refusal, which is what a `.svg` holding pixels gets.
    await expect(run('svg-to-pdf', {}, [fileFrom(realPng(20, 10), 'fake.svg', 'image/svg+xml')]))
      .rejects.toThrow(/PNG image, not an SVG drawing/);
  });

  it('tiff-to-pdf gives every frame its own page, in order', async () => {
    const outcome = await run('tiff-to-pdf', { pageSize: 'a4', margin: 0 }, [
      fileFrom(tiffBytes([{ width: 30, height: 40 }, { width: 50, height: 20 }]), 'fax.tif', 'image/tiff'),
    ]);
    const bytes = await firstPdf(outcome);
    const pages = await imagesPerPage(bytes);
    expect(pages.length).toBe(2);
    expect(pages[0]?.[0]?.pixels).toEqual([30, 40]);
    expect(pages[1]?.[0]?.pixels).toEqual([50, 20]);
  });

  it('heic-to-pdf hands the browser the file it was given and pages what comes back', async () => {
    const heic = new Uint8Array([
      0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const outcome = await run('heic-to-pdf', { pageSize: 'a4', margin: 0 }, [
      fileFrom(heic, 'camera.heic', 'image/heic'),
    ]);
    const bytes = await firstPdf(outcome);
    expect((await pageSizes(bytes)).length).toBe(1);
    expect((await placedOn(bytes)).length).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * SVG and CBZ                                                        *
 * ------------------------------------------------------------------ */

describe('svg-to-pdf and cbz-to-pdf put each artefact on its own sheet', () => {
  const svg = fileFrom('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"></svg>', 'mark.svg', 'image/svg+xml');

  it('paints the drawing on a page that hugs it', async () => {
    const outcome = await run('svg-to-pdf', { pageSize: 'fit', margin: 0 }, [svg]);
    const bytes = await firstPdf(outcome);
    const [[pageW, pageH]] = await pageSizes(bytes);
    const [placed] = await placedOn(bytes);
    expect(placed?.kind).toBe('Image');
    expect([round(pageW), round(pageH)]).toEqual(placed?.pixels);
  });

  it('gives a “Square” sheet equal edges', async () => {
    const outcome = await run('svg-to-pdf', { pageSize: 'square', margin: 0 }, [svg]);
    const [size] = await pageSizes(await firstPdf(outcome));
    expect(size?.[0]).toBe(size?.[1]);
  });

  it('reads a CBZ in natural page order, one image per sheet', async () => {
    const zip = await zipBytes([
      { name: 'page1.png', data: realPng(20, 10) },
      { name: 'page2.png', data: realPng(40, 10) },
      { name: 'page10.png', data: realPng(200, 10) },
      { name: 'cover.txt', data: 'not a page' },
    ]);
    const outcome = await run('cbz-to-pdf', {}, [fileFrom(zip, 'comic.cbz')]);
    const bytes = await firstPdf(outcome);
    expect(await pageSizes(bytes)).toEqual([[20, 10], [40, 10], [200, 10]]);
    const pages = await imagesPerPage(bytes);
    expect(pages.map((page) => page[0]?.pixels)).toEqual([[20, 10], [40, 10], [200, 10]]);
    expect(outcome.warnings.join(' ')).toMatch(/Non-image entries/);
  });

  it('finds pages inside a nested folder and skips archive filler', async () => {
    // Real CBZs wrap pages in a folder and carry `__MACOSX` twins; a reader that
    // only looks at the root finds nothing and calls a good comic empty.
    const zip = await zipBytes([
      { name: '__MACOSX/._page1.png', data: realPng(20, 10) },
      { name: 'comic/001.png', data: realPng(30, 10) },
      { name: 'comic/002.png', data: realPng(40, 10) },
    ]);
    const outcome = await run('cbz-to-pdf', {}, [fileFrom(zip, 'nested.cbz')]);
    const bytes = await firstPdf(outcome);
    expect(await pageSizes(bytes)).toEqual([[30, 10], [40, 10]]);
  });

  it('refuses an empty archive and a corrupt one, in words', async () => {
    const empty = await zipBytes([{ name: 'readme.txt', data: 'nothing to draw' }]);
    await expect(run('cbz-to-pdf', {}, [fileFrom(empty, 'empty.cbz')]))
      .rejects.toThrow(/holds no page images/);
    const corrupt = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02]);
    await expect(run('cbz-to-pdf', {}, [fileFrom(corrupt, 'broken.cbz')]))
      .rejects.toThrow(/not a readable ZIP archive/);
  });

  it('keeps the CBZ pictures as pictures: no text is selectable', async () => {
    const outcome = await run('cbz-to-pdf', {}, [fileFrom(await cbzBytes(1), 'one.cbz')]);
    expect(squash(await extractText(await firstPdf(outcome)))).toBe('');
  });
});

/* ------------------------------------------------------------------ *
 * Text routes: reading order, hierarchy, and no lost words           *
 * ------------------------------------------------------------------ */

describe('txt-to-pdf typesets the words in the order they were written', () => {
  it('lays out a pasted page top-down with a footer number', async () => {
    const text = [
      'Chapter one',
      '',
      'First paragraph of the chapter, which is long enough to wrap onto a second line of its own when it reaches the margin.',
      '',
      'Second paragraph follows it.',
    ].join('\n');
    const outcome = await run('txt-to-pdf', { source: 'paste', paste: text, pageNumbers: true });
    const runs = await textRuns(await firstPdf(outcome));
    const ordered = inOrder(runs);
    const words = ordered.map((run) => run.text).join(' ');
    expect(words).toContain('Chapter one');
    expect(words.indexOf('First paragraph')).toBeLessThan(words.indexOf('Second paragraph'));
    // The footer number sits below every line of body text, on its own baseline.
    const body = runs.filter((run) => run.text.includes('paragraph') || run.text.includes('Chapter'));
    const footers = runs.filter((run) => run.text === '1');
    expect(footers.length).toBe(1);
    expect(footers[0]!.y).toBeLessThan(Math.min(...body.map((run) => run.y)));
    // Nothing runs outside the margins the tool was given (56 pt by default).
    expect(Math.min(...runs.map((run) => run.x))).toBeGreaterThanOrEqual(56 - 0.01);
  });

  it('keeps hard line breaks when paragraph folding is off', async () => {
    const text = 'alpha line\nbeta line\ngamma line';
    const folded = await run('txt-to-pdf', { source: 'paste', paste: text, paragraphs: false });
    const runs = await textRuns(await firstPdf(folded));
    expect(baselines(runs).length).toBeGreaterThanOrEqual(3);
    expect(runs.filter((run) => run.text === 'beta line').length).toBe(1);
  });

  it('draws monospaced text in a different face than proportional text, and paints it', async () => {
    const text = 'iiii MMMM 1111';
    const proportional = await run('txt-to-pdf', { source: 'paste', paste: text, monospace: false });
    const mono = await run('txt-to-pdf', { source: 'paste', paste: text, monospace: true });
    const bodyFont = (await textRuns(await firstPdf(proportional)))[0]?.font;
    const monoRuns = await textRuns(await firstPdf(mono));
    expect(monoRuns.length).toBeGreaterThan(0);
    expect(monoRuns[0]?.font).toBeTruthy();
    expect(monoRuns[0]?.font).not.toBe(bodyFont);
    // The Monospaced sheet used to be the one this family could not vouch for: the
    // bytes were right, 17 words extracted, and the grey band buried every glyph of
    // them (c3 blocker 1, live at :5296 — 163 978 px of band, 0 px of ink, the app's
    // own preview showing an empty box). It is now a painted page, same rectangle.
    const doc = await PDFDocument.load(await firstPdf(mono), { updateMetadata: false });
    expectPaintedCode(doc.getPage(0), 1);
    // Control: the proportional setting paints no band for the same words.
    const prose = await PDFDocument.load(await firstPdf(proportional), { updateMetadata: false });
    expect(bandUnder(codePaintOf(prose.getPage(0))), 'prose painted a code band').toBeNull();
  });

  it('spills onto a second sheet without dropping or duplicating a line', async () => {
    const text = Array.from({ length: 60 }, (_, index) => `Line ${index + 1} of the manuscript.`).join('\n\n');
    const outcome = await run('txt-to-pdf', { source: 'paste', paste: text });
    const bytes = await firstPdf(outcome);
    const pages = await pageSizes(bytes);
    expect(pages.length).toBeGreaterThan(1);
    // The number the result screen prints is the number of sheets in the file.
    expect(outcome.pagesOut).toBe(pages.length);
    const runs = await textRuns(bytes);
    for (const index of [1, 30, 60]) {
      expect(find(runs, `Line ${index} of the manuscript.`).length, `Line ${index}`).toBe(1);
    }
    // Page numbers advance with the sheets.
    expect(runsOn(runs, 1).some((run) => run.text === '2')).toBe(true);
  });

  it('keeps accented and non-Latin characters as themselves', async () => {
    const text = 'Café naïve — Ωμέγα — 日本語のテキスト — 한국어';
    const outcome = await run('txt-to-pdf', { source: 'paste', paste: text });
    const words = squash(await extractText(await firstPdf(outcome)));
    expect(words).toContain('Café naïve');
    expect(words).toContain('Ωμέγα');
    expect(words).toContain('日本語のテキスト');
    expect(words).toContain('한국어');
    expect(words).not.toContain('\uFFFD');
  });
});

/* ------------------------------------------------------------------ *
 * txt-to-pdf: the bytes a text file is made of                        *
 *                                                                     *
 * `docs/research/text-tail-rig.test.ts` asks whether long content     *
 * arrives; `txt-enc-rig.test.ts` asks what *is* there once it does,   *
 * with the encodings, line endings, tabs and refusals a real `.txt`   *
 * carries. These are the pins for what that rig measured: a file is   *
 * not always UTF-8, an editor is not always LF, and every one of      *
 * those shapes used to end the run with a library sentence or silently *
 * lose the accented letters.                                          *
 * ------------------------------------------------------------------ */

describe('txt-to-pdf reads the encoding the file is actually in', () => {
  /** Windows-1252: what Notepad and Excel called ANSI. Only the mapped holes differ from Latin-1. */
  const cp1252 = (text: string) => {
    const holes: Record<string, number> = { '\u201c': 0x93, '\u201d': 0x94, '\u2014': 0x97 };
    return Uint8Array.from([...text].map((char) => holes[char] ?? char.codePointAt(0)!));
  };
  const utf16le = (text: string) => Uint8Array.from(Buffer.from(text, 'utf16le'));
  const bytesOf = (prefix: number[], body: Uint8Array) => Uint8Array.from([...prefix, ...body]);
  const file = (bytes: Uint8Array, name = 'doc.txt') => fileFrom(bytes, name, 'text/plain');

  it('keeps the accents of a Windows-1252 file, and names the encoding it used', async () => {
    const outcome = await run('txt-to-pdf', {}, [file(cp1252('Café résumé naïve façade Zürich 1743 ±12° “MKSTART” — MKEND'))]);
    const words = squash(await extractText(await firstPdf(outcome)));
    // Pre-fix, the UTF-8 attempt left a replacement character wherever a high byte
    // sat, and no face draws it as the letter: the sheets read
    // "Caf r sum na ve" for "Café résumé naïve" (38 of 48 characters a reader
    // could extract), under a success count and no warning at all. The curly
    // quotes and the em dash are asserted in `docs/research/txt-enc-after.txt`,
    // where MuPDF reads the WinAnsi bytes back as the characters they mean.
    expect(words).toContain('Café résumé naïve façade Zürich');
    expect(words).not.toContain('\uFFFD');
    expect(outcome.warnings.join(' ')).toMatch(/Windows-1252/);
    expect(outcome.warnings.join(' ')).toMatch(/not valid UTF-8/);
  });

  it('typesets UTF-16 with a mark, little- and big-endian alike', async () => {
    for (const [prefix, body] of [[0xff, 0xfe], [0xfe, 0xff]] as const) {
      const little = utf16le('Café report MKEND');
      const bytes = prefix === 0xff ? little : Uint8Array.from(Buffer.from(little).swap16());
      const outcome = await run('txt-to-pdf', {}, [file(bytesOf([prefix, body], bytes))]);
      const words = squash(await extractText(await firstPdf(outcome)));
      expect(words, prefix === 0xff ? 'UTF-16LE' : 'UTF-16BE').toContain('Café report MKEND');
      expect(outcome.warnings.join(' ')).toMatch(prefix === 0xff ? /decoded from UTF-16LE/ : /decoded from UTF-16BE/);
    }
  });

  it('leaves a UTF-8 file that carries its own replacement character alone', async () => {
    // The control for the fallback above: a file that *is* valid UTF-8, and whose
    // author already wrote the box, must not be re-read as Windows-1252.
    const outcome = await run('txt-to-pdf', {}, [file(new TextEncoder().encode('Café \uFFFD already broken MKEND'))]);
    expect(outcome.warnings.join(' ')).not.toMatch(/Windows-1252/);
    expect(squash(await extractText(await firstPdf(outcome)))).toContain('already broken MKEND');
  });

  it('starts a new line at every line-ending convention the file uses', async () => {
    const outcome = await run('txt-to-pdf', {}, [
      file(new TextEncoder().encode('MKSTART one\r\ntwo\nthree\rMKEND four\n')),
    ]);
    const runs = await textRuns(await firstPdf(outcome));
    const lines = ['MKSTART one', 'two', 'three', 'MKEND four'].map((text) => find(runs, text));
    for (const [index, found] of lines.entries()) {
      expect(found.length, lines[index]![0]!.text).toBe(1);
    }
    // One baseline per source line: the C++ pair, the Unix one and the old-Mac one.
    expect(new Set(lines.map(([found]) => round(found!.y))).size).toBe(4);
  });

  it('breaks the sheet where the manuscript puts a form feed', async () => {
    const outcome = await run('txt-to-pdf', {}, [
      file(new TextEncoder().encode('MKSTART first sheet\nmore of it\n\u000CSecond sheet MKEND\n')),
    ]);
    const bytes = await firstPdf(outcome);
    const runs = await textRuns(bytes);
    expect(await pageSizes(bytes)).toHaveLength(2);
    expect(outcome.pagesOut).toBe(2);
    expect(find(runs, 'first sheet')[0]!.page).toBe(0);
    expect(find(runs, 'Second sheet MKEND')[0]!.page).toBe(1);
    expect(runsOn(runs, 1).some((run) => run.text === '2')).toBe(true);
  });

  it('drops the characters no face can draw, and counts them out loud', async () => {
    const outcome = await run('txt-to-pdf', {}, [
      file(new TextEncoder().encode('MKSTART bell\u0007 escape\u001b delete\u007f MKEND')),
    ]);
    const words = squash(await extractText(await firstPdf(outcome)));
    expect(words).toContain('bell escape delete MKEND');
    expect(outcome.warnings.join(' ')).toMatch(/3 control characters .* left out/);
  });

  it('sends a tab to the next column stop, so tab-indented tables keep their columns', async () => {
    const outcome = await run('txt-to-pdf', { monospace: true, paragraphs: false }, [
      file(new TextEncoder().encode('ID\tNAME\tQTY\n333\tcherry\t5')),
    ]);
    const runs = await textRuns(await firstPdf(outcome));
    // Eight-column stops, the `expand` default: `ID` is two columns deep, so its
    // tab is six spaces, and `NAME` ends at column 12, so its tab is four. Pre-fix
    // both were four, which lands the same field at a different x on every row —
    // measured in the real monospace face at 95.0, 100.8 and 106.6 pt.
    expect(find(runs, 'NAME')[0]!.text).toBe('ID      NAME    QTY');
    expect(find(runs, 'cherry')[0]!.text).toBe('333     cherry  5');
  });

  it('refuses the files that hold nothing to typeset, and says which one', async () => {
    const refusals: [string, Uint8Array, RegExp][] = [
      ['no bytes at all', new Uint8Array(0), /"doc\.txt" is empty \(0 bytes\)/],
      ['only whitespace', new TextEncoder().encode('   \n\t\n \n'), /"doc\.txt" contains no characters to typeset/],
      ['only a mark', bytesOf([0xef, 0xbb, 0xbf], new Uint8Array(0)), /"doc\.txt" contains no characters to typeset/],
      ['only control characters', new TextEncoder().encode('\u0001\u0002\u0003'), /control characters/],
    ];
    for (const [what, bytes, sentence] of refusals) {
      const error = await run('txt-to-pdf', {}, [file(bytes)]).catch((thrown: Error) => thrown);
      expect((error as Error).message, what).toMatch(sentence);
      expect((error as Error).message, what).not.toMatch(/WinAnsi|undefined|at .*\.ts:/);
    }
  });

  it('fetches the one script face a Japanese source needs, from the host the card names', async () => {
    // The network half of the encoding story: a Latin file must ask for nothing
    // off the device, and a Japanese one must ask for exactly the face the card
    // says it will (`cdn.jsdelivr.net`, once, then the browser caches it).
    const asked: string[] = [];
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return inner(input as never);
    }) as typeof fetch;
    try {
      clearFontCache();
      const latin = await run('txt-to-pdf', {}, [file(new TextEncoder().encode('Café report MKEND'))]);
      expect(squash(await extractText(await firstPdf(latin)))).toContain('Café report MKEND');
      expect(asked.filter((url) => /^https?:/.test(url) && !/localhost|127\./.test(url))).toEqual([]);
      asked.length = 0;
      clearFontCache();
      const kana = await run('txt-to-pdf', {}, [file(new TextEncoder().encode('日本語のテキスト café MKEND'))]);
      expect(squash(await extractText(await firstPdf(kana)))).toContain('日本語のテキスト');
      expect(asked.filter((url) => /^https:/.test(url))).toEqual([
        'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-jp/NotoSansJP_400Regular.ttf',
      ]);
      expect(String(getPdfTool('txt-to-pdf')?.notes)).toMatch(/faces are fetched from the CDN/);
    } finally {
      globalThis.fetch = inner;
      clearFontCache();
    }
  });

  it('calls a PNG named .txt a PNG, and UTF-16 without a mark a re-saveable file', async () => {
    const png = await run('txt-to-pdf', {}, [file(PNG_1PX)]).catch((thrown: Error) => thrown);
    expect((png as Error).message).toMatch(/"doc\.txt" is a PNG image, not a plain text file/);
    const noMark = await run('txt-to-pdf', {}, [file(utf16le('café report'))]).catch((thrown: Error) => thrown);
    expect((noMark as Error).message).toMatch(/binary data/);
    // The refusal is right — the bytes are ambiguous — but only useful if it says
    // what to do about it, because UTF-16 without its mark is a text file.
    expect((noMark as ToolInputError).hint).toMatch(/UTF-16 without its byte-order mark/);
    expect((noMark as ToolInputError).hint).toMatch(/re-save it as UTF-8/i);
  });
});

/**
 * The two Markdown spellings `core/layout.ts` hands to its tag stripper, which used
 * to eat them: `<br>` (deleted, gluing the words either side into one) and the
 * autolink `<https://…>` (deleted with its brackets, so the address vanished). Both
 * are fixed in the route, in the source, and only outside fenced blocks — which is
 * what the third pin holds down.
 */
describe('markdown-to-pdf keeps the inline HTML it was promised to', () => {
  const md = (source: string) => fileFrom(source, 'doc.md', 'text/markdown');

  it('ends the line at a <br> instead of welding the words together', async () => {
    const outcome = await run('markdown-to-pdf', {}, [
      md('MKSTART the hard break<br>line three after a br tag MKEND\n'),
    ]);
    const words = squash(await extractText(await firstPdf(outcome)));
    // Pre-fix the sheet read `hard breakline three`: one word, one space missing.
    expect(words).toContain('the hard break');
    expect(words).toContain('line three after a br tag');
    expect(words).not.toContain('breakline');
  });

  it('keeps an autolink’s address in the file', async () => {
    const outcome = await run('markdown-to-pdf', {}, [
      md('MKSTART see <https://autolink.example/x> and [the spec](https://example.com/spec.html) MKEND\n'),
    ]);
    const words = squash(await extractText(await firstPdf(outcome)));
    expect(words).toContain('https://autolink.example/x');
    // An ordinary link keeps its words; the address is not printed and the file
    // carries no /Link annotation, which is what the card now says.
    expect(words).toContain('the spec');
    const doc = await PDFDocument.load(await firstPdf(outcome), { updateMetadata: false });
    const annotated = doc.getPages()[0]!.node.get(PDFName.of('Annots'));
    const marks = annotated instanceof PDFArray ? annotated.size() : 0;
    expect(marks, 'no clickable target is written').toBe(0);
  });

  it('leaves a <br> inside a fenced block exactly as written', async () => {
    const outcome = await run('markdown-to-pdf', {}, [
      md('MKSTART\n\n```html\n<br>\n<div>kept</div>\n```\n\nafter the fence MKEND\n'),
    ]);
    const runs = await textRuns(await firstPdf(outcome));
    const printed = runs.map((run) => run.text).join(' ');
    expect(printed).toContain('<br>');
    expect(printed).toContain('<div>kept</div>');
    const family = (name: string) => name.replace(/-\d+$/, '');
    expect(family(find(runs, '<br>')[0]!.font)).not.toBe(family(find(runs, 'after the fence')[0]!.font));
  });

  it('prints maths and inline code in the body face, as the card now states', async () => {
    const outcome = await run('markdown-to-pdf', {}, [md('MKSTART `$x^2 + y_1 = \\alpha$` and $x^2$ inline MKEND\n')]);
    const runs = await textRuns(await firstPdf(outcome));
    const body = find(runs, 'MKEND')[0]!;
    // The characters arrive exactly as written — that half of the old note was true.
    expect(squash(runs.map((run) => run.text).join(' '))).toContain('$x^2 + y_1 = \\alpha$');
    // …but neither the code span nor the `$…$` maths is set in a code face, which is
    // the half the old note got wrong; `Inline.code` never reaches the writer. Re-measured
    // after seam wave 1 (`72d8faa` painted the code band behind its glyphs, `c5bcf50`
    // sized the list gutter): `spaced code` still draws in 11 pt Helvetica, the body
    // face, so the card sentence stands and this pin still describes the page. It goes
    // red when a seam wave hands `drawLine` the flag it already carries (blocker 9).
    const family = (name: string) => name.replace(/-\d+$/, '');
    expect(family(find(runs, '$x^2')[0]!.font)).toBe(family(body.font));
    expect(family(find(runs, '$x^2')[0]!.font)).not.toBe('JetBrainsMono-Regular');
  });

  it('lays a nested list at its parent’s depth', async () => {
    // Measured behaviour the shared renderer owes a fix for (blocker 5 in
    // `/tmp/lane-convert/report.md`). Seam wave 1 (`c5bcf50`) sized the gutter from
    // the widest marker but left `markdownToBlocks` flattening every nesting level to
    // `level: 0`, so this pin still describes today's page — measured again after the
    // rebase: `level one`, `level two` and `level three` all start at x 70. It goes red
    // when a later wave gives the Markdown walk its depths, and the card note moves
    // with it. (The HTML route, which walks a real DOM, is already pinned at depth.)
    const outcome = await run('markdown-to-pdf', {}, [
      md('MKSTART\n\n- level one\n  - level two\n    - level three MKEND\n'),
    ]);
    const runs = await textRuns(await firstPdf(outcome));
    const one = find(runs, 'level one')[0]!;
    const two = find(runs, 'level two')[0]!;
    const three = find(runs, 'level three')[0]!;
    expect([one.x, two.x, three.x]).toEqual([one.x, one.x, one.x]);
  });

  it('prints a task list as boxes in the marker column, not as bullet text', async () => {
    const outcome = await run('markdown-to-pdf', {}, [
      md('MKSTART\n\n- [x] already finished\n- [ ] not yet done\n- plain item MKEND\n'),
    ]);
    const runs = await textRuns(await firstPdf(outcome));
    // Pre-fix each task printed `• [x] already finished`: an ordinary bullet, with
    // the box as the first words of the item.
    expect(runs.some((run) => run.text === '[x]'), 'a checked box').toBe(true);
    expect(runs.some((run) => run.text === '[ ]'), 'an unchecked box').toBe(true);
    expect(runs.some((run) => run.text.startsWith('[x] already finished'))).toBe(false);
    expect(find(runs, 'already finished')[0]!.text).toBe('already finished');
    // The bullet of the ordinary item survives, and every marker clears its text.
    expect(find(runs, 'plain item').length).toBe(1);
    // The bullet is WinAnsi 0x95 in a standard face, which is what a viewer decodes back.
    expect(runs.some((run) => [0x95, 0x2022].includes(run.text.charCodeAt(0)))).toBe(true);
    const boxes = runs.filter((run) => /^\[[x ]\]$/.test(run.text));
    // The renderer sizes the text gutter from the widest marker the list holds, so
    // the box keeps the marker column (`margin + 2`) and its text starts one measured
    // `[x]` clear of it. The route used to buy the same clearance with a whole extra
    // level of indent, which pushed every item of such a list out to x 84; the
    // measured gutter is 15.6 pt, so the text belongs at 71.6.
    const edge = 56 + (await seamGutter('[x]', boxes[0]!.size));
    expect(edge, 'a three-character box is wider than the old fixed 14 pt gutter').toBeGreaterThan(70);
    for (const box of boxes) {
      expect(box.x, `the box ${box.text}`).toBeCloseTo(58, 1);
      const text = runs.find((run) => run.page === box.page && Math.abs(run.y - (box.y - 5)) < 2 && run.x > box.x);
      expect(text!.x, `box at ${box.x} vs text at ${text!.x}`).toBeCloseTo(edge, 1);
    }
    // One gutter per list, so the ordinary bullet of the same list shares the edge.
    expect(find(runs, 'plain item')[0]!.x).toBeCloseTo(edge, 1);
  });

  it('numbers an ordered list from the number the author wrote', async () => {
    const outcome = await run('markdown-to-pdf', {}, [md('MKSTART\n\n5. five\n6. six\n7. seven MKEND\n')]);
    const runs = await textRuns(await firstPdf(outcome));
    expect(runs.filter((run) => /^\d+\.$/.test(run.text)).map((run) => run.text)).toEqual(['5.', '6.', '7.']);
  });

  it('clears the text when a number grows past one digit', async () => {
    const twelve = Array.from({ length: 12 }, (_, i) => `${i + 1}. step ${i + 1} of the guide`).join('\n');
    const outcome = await run('markdown-to-pdf', {}, [md(`MKSTART\n\n${twelve}\n\nMKEND\n`)]);
    const runs = await textRuns(await firstPdf(outcome));
    const markers = runs.filter((run) => /^\d+\.$/.test(run.text));
    const ten = runs.find((run) => run.text === '10.')!;
    expect(ten, 'the two-digit marker').toBeTruthy();
    // `renderList` measures the widest marker of the list (`12.`) and starts every
    // item at `margin + that gutter`, so the number clears its words without the
    // route reserving an indent of its own. Pre-fix the 14 pt gutter was all a `10.`
    // got: measured on the live README, marker box 58→94.5 pt with the text at 70,
    // which MuPDF extracted as the single word `10.tenth`.
    const edge = 56 + (await seamGutter('12.', ten.size));
    for (const marker of markers) {
      expect(marker.x, `marker ${marker.text}`).toBeCloseTo(58, 1);
      const step = runs.find((run) => run.page === marker.page && run.x > marker.x && Math.abs(run.y - (marker.y - 5)) < 2)!;
      expect(step.x, `${marker.text} and its text`).toBeCloseTo(edge, 1);
    }
    expect(runs.some((run) => run.text.startsWith('10.step'))).toBe(false);
  });

  it('holds a list of one-digit numbers at the 70 pt text edge', async () => {
    const nine = Array.from({ length: 9 }, (_, i) => `${i + 1}. step ${i + 1} of the guide`).join('\n');
    const outcome = await run('markdown-to-pdf', {}, [md(`MKSTART\n\n${nine}\n\nMKEND\n`)]);
    const runs = await textRuns(await firstPdf(outcome));
    const markers = runs.filter((run) => /^\d+\.$/.test(run.text));
    expect(markers.length).toBe(9);
    // The control the gutter is sized against: a marker that fits the old 14 pt
    // gutter must not move, or the measurement would be a re-indent in disguise.
    for (const marker of markers) {
      expect(marker.x, `marker ${marker.text}`).toBeCloseTo(58, 1);
      const step = runs.find((run) => run.page === marker.page && run.x > marker.x && Math.abs(run.y - (marker.y - 5)) < 2)!;
      expect(step.x, `the text of ${marker.text}`).toBeCloseTo(70, 6);
    }
  });

  it('keeps an HTML comment off the page', async () => {
    const outcome = await run('markdown-to-pdf', {}, [md('MKSTART visible <!-- an author note --> text MKEND\n')]);
    const words = squash(await extractText(await firstPdf(outcome)));
    expect(words).toContain('visible text');
    expect(words).not.toContain('<!--');
    expect(words).not.toContain('author note');
  });

  it('decodes character references in prose and leaves them alone in code', async () => {
    const outcome = await run('markdown-to-pdf', {}, [
      md('MKSTART Kate &amp; Co, &copy; 1743, &#8212; &#65; &#x41; and &bareword; MKEND\n\n```text\nfence &amp;decodes &copy;keeps\n```\n\nMKEND\n'),
    ]);
    const words = squash(await extractText(await firstPdf(outcome)));
    // Measured pre-fix: `Kate &amp; Co` came back re-escaped and `&copy;` printed as
    // its name, so the source's ampersand was six characters wide on the page.
    expect(words).toContain('Kate & Co, © 1743,');
    // `&#8212;` is WinAnsi 0x97 and `&#65;`/`&#x41;` are both A; the decoded pair is
    // asserted in `docs/research/md-struct-after.txt` (`entities-md` prints `— A A`).
    expect(words).toContain(' A A');
    expect(words).toContain('&bareword;');
    // A fenced block is literal, except for the five the shared tag stripper decodes
    // before `marked` ever sees the line.
    expect(words).toContain('fence &decodes &copy;keeps');
  });
});

/**
 * The HTML route reads a detached DOM, so its defects are the ones a browser would
 * never show: an `<ol start>` thrown away, a two-digit marker printed on top of its
 * text, a page of unmarked-up words refused as "no readable body content", and a
 * warning that reports skipped `<img>`s to a page that has none.
 */
describe('html-to-pdf keeps the markup it parsed', () => {
  const html = (source: string) => fileFrom(source, 'doc.html', 'text/html');

  it('numbers an ordered list from its start attribute', async () => {
    const outcome = await run('html-to-pdf', {}, [
      html('<p>MKSTART</p><ol start="5"><li>five</li><li>six</li><li>seven MKEND</li></ol>'),
    ]);
    const runs = await textRuns(await firstPdf(outcome));
    expect(runs.filter((run) => /^\d+\.$/.test(run.text)).map((run) => run.text)).toEqual(['5.', '6.', '7.']);
  });

  it('clears the text when a number grows past one digit', async () => {
    const items = Array.from({ length: 12 }, (_, i) => `<li>step ${i + 1} of the guide</li>`).join('');
    const outcome = await run('html-to-pdf', {}, [html(`<p>MKSTART</p><ol>${items}</ol><p>MKEND</p>`)]);
    const runs = await textRuns(await firstPdf(outcome));
    const markers = runs.filter((run) => /^\d+\.$/.test(run.text));
    const ten = runs.find((run) => run.text === '10.')!;
    expect(ten, 'the two-digit marker').toBeTruthy();
    // Same seam gutter as the Markdown route, measured from the widest marker the
    // list holds rather than bought with a route-level indent (which parked these
    // items at x 84). Pre-fix the renderer's single 14 pt gutter could not hold
    // `10.` at all, and the reader saw one word `10.step`.
    const edge = 56 + (await seamGutter('12.', ten.size));
    expect(edge, 'a two-digit marker is wider than the fixed 14 pt gutter').toBeGreaterThan(70);
    for (const marker of markers) {
      expect(marker.x, `marker ${marker.text}`).toBeCloseTo(58, 1);
      const step = runs.find((run) => run.page === marker.page && run.x > marker.x && Math.abs(run.y - (marker.y - 5)) < 2)!;
      expect(step.x, `${marker.text} and its text`).toBeCloseTo(edge, 1);
    }
    expect(runs.some((run) => run.text.startsWith('10.step'))).toBe(false);
  });

  it('lays out a .html file that holds no markup at all', async () => {
    const outcome = await run('html-to-pdf', {}, [html('MKSTART just plain words with no markup\nsecond line MKEND\n')]);
    const words = squash(await extractText(await firstPdf(outcome)));
    // Pre-fix: `REFUSED: That HTML had no readable body content.`
    expect(words).toContain('just plain words with no markup');
    expect(words).toContain('second line MKEND');
  });

  it('says nothing about skipped images when there are none', async () => {
    const outcome = await run('html-to-pdf', { embedImages: false }, [html('<p>no images at all MKEND</p>')]);
    expect(outcome.warnings.join(' ')).not.toMatch(/<img>/);
    const withImages = await run('html-to-pdf', { embedImages: false }, [
      html('<p>MKEND</p><img src="data:image/png;base64,AAA=" alt="a"><img src="data:image/png;base64,AAA=" alt="b">'),
    ]);
    expect(withImages.warnings.join(' ')).toMatch(/all 2 <img>s were skipped/);
  });

  it('keeps nested lists at their own depth and drops comments', async () => {
    const outcome = await run('html-to-pdf', {}, [
      html('<p>MKSTART visible <!-- a note --> words</p><ul><li>one<ul><li>two<ul><li>three MKEND</li></ul></li></ul></li></ul>'),
    ]);
    const runs = await textRuns(await firstPdf(outcome));
    const depth = ['one', 'two', 'three'].map((word) => find(runs, word)[0]!.x);
    expect(depth[0]).toBeLessThan(depth[1]);
    expect(depth[1]).toBeLessThan(depth[2]);
    expect(squash(runs.map((run) => run.text).join(' '))).not.toContain('a note');
  });
});

describe('markdown-to-pdf keeps the structure it read', () => {
  const source = [
    '# Big Heading',
    '',
    'Body paragraph with **bold words** and `code`.',
    '',
    '- first bullet',
    '- second bullet',
    '',
    '| Name | Qty | Price |',
    '| --- | --- | --- |',
    '| Widget | 3 | 9.99 |',
    '| Gizmo | 12 | 4.50 |',
    '',
    '```',
    'const answer = 42;',
    '```',
  ].join('\n');

  it('draws the heading bigger than the body it introduces', async () => {
    const outcome = await run('markdown-to-pdf', { source: 'paste', paste: source });
    const runs = await textRuns(await firstPdf(outcome));
    const heading = find(runs, 'Big Heading')[0];
    const body = find(runs, 'Body paragraph with')[0];
    expect(heading).toBeTruthy();
    expect(body).toBeTruthy();
    expect(heading!.size).toBeGreaterThan(body!.size * 1.5);
    expect(heading!.y).toBeGreaterThan(body!.y);
    expect(heading!.x).toBe(body!.x);
  });

  it('keeps a Markdown table a grid, not a list of words', async () => {
    const outcome = await run('markdown-to-pdf', { source: 'paste', paste: source });
    const runs = await textRuns(await firstPdf(outcome));
    const header = runs.filter((run) => ['Name', 'Qty', 'Price'].includes(run.text));
    const widget = runs.filter((run) => ['Widget', '3', '9.99'].includes(run.text));
    expect(header.length).toBe(3);
    expect(columns(header).length).toBe(3);
    expect(baselines(header).length).toBe(1);
    expect(baselines(widget).length).toBe(1);
    // Same column x for the header and the row under it: the grid did not shift.
    expect(columns(widget)).toEqual(columns(header));
  });

  it('marks list items and indents their text past the marker', async () => {
    const outcome = await run('markdown-to-pdf', { source: 'paste', paste: source });
    const runs = await textRuns(await firstPdf(outcome));
    const item = find(runs, 'first bullet')[0];
    const heading = find(runs, 'Big Heading')[0];
    expect(item).toBeTruthy();
    expect(item!.x).toBeGreaterThan(heading!.x);
    // The bullet is its own run on the item's baseline, to the left of its text.
    // (WinAnsi stores `•` as 0x95, which is what a viewer decodes back.)
    const marker = runs.find((run) => run.x < item!.x && Math.abs(run.y - item!.y) <= item!.size);
    expect(marker).toBeTruthy();
    expect([0x95, 0x2022].includes(marker!.text.charCodeAt(0))).toBe(true);
  });

  it('sets fenced code in the code face, below the prose it follows', async () => {
    const outcome = await run('markdown-to-pdf', { source: 'paste', paste: source });
    const bytes = await firstPdf(outcome);
    const runs = await textRuns(bytes);
    const code = find(runs, 'const answer = 42;')[0];
    const body = find(runs, 'Body paragraph with')[0];
    expect(code).toBeTruthy();
    expect(code!.font).not.toBe(body!.font);
    expect(code!.y).toBeLessThan(body!.y);
    // A code face that paints nothing is not a code block: the re-anchored half of
    // c3 blocker 1. This page used to carry the grey band with 0 dark px of ink in it
    // (`docs/research/md-struct-after.txt` recorded `code_ink: 147` for the band, the
    // 147 being the `MKSTART` line that pokes into the probe, not a glyph), because
    // `renderBlocks` filled the rectangle after drawing the text. The glyphs are now
    // shown after the fill, on the same rectangle.
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    expectPaintedCode(doc.getPage(0), 1);
    // The fence really is literal code, not body copy in a mono face: the same source
    // without the fence puts those words in the body face.
    const prose = await run('markdown-to-pdf', { source: 'paste', paste: 'Body paragraph with **bold words** and `code`.\n\nconst answer = 42;' });
    const proseDoc = await PDFDocument.load(await firstPdf(prose), { updateMetadata: false });
    const prosePainted = codePaintOf(proseDoc.getPage(0));
    expect(prosePainted.ink, 'a paragraph is not a code page').toEqual([]);
    expect(bandUnder(prosePainted), 'a paragraph painted a code band').toBeNull();
  });

  it('does not print raw HTML tags, and keeps an unterminated fence\'s words', async () => {
    const outcome = await run('markdown-to-pdf', {
      source: 'paste',
      paste: '<script>alert(1)</script>\n\nStarts <b>bold</b> here\n\n```\nunclosed code line\nsecond line',
    });
    const runs = await textRuns(await firstPdf(outcome));
    const printed = runs.map((run) => run.text).join(' ');
    expect(printed).not.toContain('<script>');
    expect(printed).toContain('Starts');
    expect(printed).toContain('bold');
    expect(printed).toContain('unclosed code line');
  });

  it('embeds a data-URL image inside the text column', async () => {
    const png = `data:image/png;base64,${Buffer.from(realPng(60, 30)).toString('base64')}`;
    const outcome = await run('markdown-to-pdf', {
      source: 'paste',
      paste: `![a chart](${png})\n\nParagraph under the image.`,
    });
    const bytes = await firstPdf(outcome);
    const [[pageW, pageH]] = await pageSizes(bytes);
    const [placed] = await placedOn(bytes);
    expect(placed?.pixels).toEqual([60, 30]);
    expect(placed!.box[0]).toBeGreaterThanOrEqual(56 - 0.01);
    expect(placed!.box[0] + placed!.box[2]).toBeLessThanOrEqual(pageW - 56 + 0.01);
    expect(placed!.box[3]).toBeLessThanOrEqual(pageH);
    expect(squash(await extractText(bytes))).toContain('Paragraph under the image.');
  });

  it('keeps Chinese chapter text and its heading order on the page', async () => {
    const outcome = await run('markdown-to-pdf', {
      source: 'paste',
      paste: '# 第一章\n\n这是一个段落，里面有标点符号。',
    });
    const bytes = await firstPdf(outcome);
    const runs = await textRuns(bytes);
    const heading = find(runs, '第一章')[0];
    const body = runs.find((run) => run.text.includes('这是一个段落'));
    expect(heading).toBeTruthy();
    expect(body).toBeTruthy();
    expect(heading!.size).toBeGreaterThan(body!.size);
    expect(heading!.y).toBeGreaterThan(body!.y);
  });
});

describe('html-to-pdf lays out markup as structure', () => {
  const page = [
    '<html><head><style>@page { size: A3 landscape; margin: 0 } body { display: grid }</style>',
    '<script>document.body.innerHTML = "<p>made by script</p>";</script></head>',
    '<body><h1>Report title</h1>',
    '<p>Intro paragraph with <strong>important words</strong> and <span style="color:#ff0000">red text</span>.</p>',
    '<table><tr><th>Item</th><th>Qty</th></tr><tr><td>Widget</td><td>3</td></tr></table>',
    '<ul><li>alpha item</li><li>beta item</li></ul>',
    '<p>Trailing paragraph.</p></body></html>',
  ].join('');

  it('keeps the page size the user chose instead of the CSS one', async () => {
    const outcome = await run('html-to-pdf', { source: 'paste', paste: page, pageSize: 'a4', orientation: 'portrait' });
    const bytes = await firstPdf(outcome);
    // There is no CSS engine: `@page { size: A3 landscape }` cannot be honoured,
    // so the sheet is the one the control asked for and the CSS never appears
    // as printed text.
    const [size] = await pageSizes(bytes);
    expect(size).toEqual([595.28, 841.89]);
    const text = squash(await extractText(bytes));
    expect(text).not.toContain('display: grid');
    expect(text).not.toContain('@page');
  });

  it('draws headings, paragraphs and the table in document order', async () => {
    const outcome = await run('html-to-pdf', { source: 'paste', paste: page });
    const runs = await textRuns(await firstPdf(outcome));
    const heading = find(runs, 'Report title')[0];
    const intro = find(runs, 'Intro paragraph with')[0];
    const trailing = find(runs, 'Trailing paragraph.')[0];
    const bold = find(runs, 'important')[0];
    expect([heading, intro, bold, trailing].every(Boolean)).toBe(true);
    expect(heading!.size).toBeGreaterThan(intro!.size);
    expect(heading!.y).toBeGreaterThan(intro!.y);
    expect(intro!.y).toBeGreaterThan(trailing!.y);
    expect(bold!.font).not.toBe(intro!.font);
    const headerCells = runs.filter((run) => ['Item', 'Qty'].includes(run.text));
    const rowCells = runs.filter((run) => ['Widget', '3'].includes(run.text));
    expect(columns(headerCells).length).toBe(2);
    expect(columns(rowCells)).toEqual(columns(headerCells));
    expect(baselines(rowCells).length).toBe(1);
  });

  it('decodes entities, drops comments and breaks a line at <br>', async () => {
    const outcome = await run('html-to-pdf', {
      source: 'paste',
      paste: '<p>Fish &amp; chips &lt;3</p><!-- a note --><p>first<br>second</p>',
    });
    const runs = await textRuns(await firstPdf(outcome));
    const text = runs.map((run) => run.text).join(' ');
    expect(text).toContain('Fish & chips <3');
    expect(text).not.toContain('a note');
    const first = find(runs, 'first')[0]!;
    const second = find(runs, 'second')[0]!;
    expect(baselines([first, second]).length).toBe(2);
    expect(first.y).toBeGreaterThan(second.y);
  });

  it('paints an inline colour rather than flattening it to black', async () => {
    const outcome = await run('html-to-pdf', { source: 'paste', paste: page });
    const doc = await PDFDocument.load(await firstPdf(outcome), { updateMetadata: false });
    const colours = pageContentOps(doc.getPages()[0]!)
      .filter((op) => op.name === 'rg' || op.name === 'scn')
      .map((op) => op.operands.filter((operand) => operand.kind === 'number').map((operand) => round((operand as { value: number }).value)));
    expect(colours.some((c) => c[0] === 1 && c[1] === 0 && c[2] === 0)).toBe(true);
  });

  it('prints an anchor’s text, not its href, and paints a <pre> block on its band', async () => {
    const outcome = await run('html-to-pdf', {
      source: 'paste',
      paste: '<p>See <a href="https://example.org/very/long/path">the docs</a>.</p><pre>col1  col2</pre>',
    });
    const bytes = await firstPdf(outcome);
    const runs = await textRuns(bytes);
    const text = runs.map((run) => run.text).join(' ');
    expect(text).toContain('the docs');
    expect(text).not.toContain('example.org');
    const pre = find(runs, 'col1')[0]!;
    expect(pre.text).toMatch(/col1\s{2}col2/);
    // `pre` is the HTML route's `kind:'code'` page, the same branch that used to
    // download as an empty grey box with the words only in the text layer.
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    expectPaintedCode(doc.getPage(0), 1);
  });

  it('places a data-URL image block and never the script-written content', async () => {
    const png = `data:image/png;base64,${Buffer.from(realPng(50, 50)).toString('base64')}`;
    const outcome = await run('html-to-pdf', {
      source: 'paste',
      paste: `<img src="${png}" alt="chart"><p>Text after the chart.</p>`,
    });
    const bytes = await firstPdf(outcome);
    const [placed] = await placedOn(bytes);
    expect(placed?.pixels).toEqual([50, 50]);
    expect(placed!.box[2]).toBeGreaterThan(0);
    const text = squash(await extractText(bytes));
    expect(text).toContain('Text after the chart.');
    expect(text).not.toContain('made by script');
  });

  it('prints an inline image as its alt text, which is what it admits', async () => {
    const png = `data:image/png;base64,${Buffer.from(realPng(50, 50)).toString('base64')}`;
    const outcome = await run('html-to-pdf', {
      source: 'paste',
      paste: `<p>Sales rose <img src="${png}" alt="chart"> last quarter.</p>`,
    });
    const bytes = await firstPdf(outcome);
    expect((await placedOn(bytes)).length).toBe(0);
    expect(squash(await extractText(bytes))).toContain('[image: chart]');
  });
});

describe('csv-to-pdf keeps the grid and repeats the header', () => {
  const rows = (count: number) =>
    ['name,qty,price'].concat(Array.from({ length: count }, (_, i) => `row${i + 1},${i},${i}.50`)).join('\n');

  it('splits on the delimiter the control names, not only on commas', async () => {
    for (const [delimiter, sample] of [
      [';', 'name;qty;price\nWidget;3;9.99'],
      ['\t', 'name\tqty\tprice\nWidget\t3\t9.99'],
    ] as const) {
      const outcome = await run('csv-to-pdf', { delimiter }, [fileFrom(sample, 'data.csv', 'text/csv')]);
      const runs = await textRuns(await firstPdf(outcome));
      expect(columns(runs.filter((run) => ['name', 'qty', 'price'].includes(run.text))).length, `delimiter ${JSON.stringify(delimiter)}`).toBe(3);
      expect(runs.some((run) => run.text === 'Widget')).toBe(true);
    }
  });

  it('detects the delimiter when asked to', async () => {
    const outcome = await run('csv-to-pdf', { delimiter: 'auto' }, [
      fileFrom('a;b;c\n1;2;3', 'semi.csv', 'text/csv'),
    ]);
    const runs = await textRuns(await firstPdf(outcome));
    expect(runs.some((run) => run.text === 'b')).toBe(true);
  });

  it('holds quoted fields and embedded newlines in one cell', async () => {
    const outcome = await run('csv-to-pdf', {}, [
      fileFrom('name,note\n"Widget, large","line one\nline two"', 'quoted.csv', 'text/csv'),
    ]);
    const bytes = await firstPdf(outcome);
    const runs = await textRuns(bytes);
    expect(runs.some((run) => run.text === 'Widget, large')).toBe(true);
    // The embedded newline belongs to one cell: both halves stay in the second
    // column, and the table is still two columns wide.
    const cell = runs.filter((run) => run.text === 'line one' || run.text === 'line two');
    expect(cell.length).toBeGreaterThan(0);
    expect(columns([...runs.filter((run) => ['name', 'note'].includes(run.text)), ...cell]).length).toBe(2);
    expect(squash(await extractText(bytes))).not.toContain('large"');
  });

  it('steps a wrapping cell down its own baselines instead of overwriting itself', async () => {
    // The row's paint loop used to decrement a local `y` that `drawLine` never
    // read, so every wrapped line of every cell landed on the row's bottom
    // baseline — 73 of them sharing one y on a sheet of the wide CSV in
    // `docs/research/table-list-tail-before.txt`.
    const long = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma';
    const outcome = await run('csv-to-pdf', {}, [fileFrom(`name,qty\n${long},3`, 'wrap.csv', 'text/csv')]);
    const runs = await textRuns(await firstPdf(outcome));
    const cell = runs.filter((run) => !['name', 'qty', '3'].includes(run.text));
    expect(cell.length, 'the cell wraps to several lines').toBeGreaterThan(1);
    expect(baselines(cell).length, 'one baseline per wrapped line').toBe(cell.length);
    // The short cell of the same row stays on the row's first line, not its last.
    expect(find(runs, '3')[0]!.y).toBeCloseTo(Math.max(...cell.map((run) => run.y)), 1);
  });

  it('drops a BOM from the first header and pads ragged rows to the widest', async () => {
    const outcome = await run('csv-to-pdf', {}, [
      fileFrom('\uFEFFname,qty\nWidget,3\nGizmo', 'ragged.csv', 'text/csv'),
    ]);
    const runs = await textRuns(await firstPdf(outcome));
    // A BOM left in place makes the first header cell `\ufeffname`, which is not
    // the word in the file and does not line up with its own column.
    expect(runs.some((run) => run.text === 'name')).toBe(true);
    const shortRow = find(runs, 'Gizmo')[0];
    const fullRow = find(runs, 'Widget')[0];
    expect(shortRow).toBeTruthy();
    // The short row is still one row of its own, in the first column.
    expect(fullRow).toBeTruthy();
    expect(shortRow!.x).toBeCloseTo(fullRow!.x, 1);
    expect(shortRow!.y).toBeLessThan(fullRow!.y);
  });

  it('keeps a twelve-column table inside the margins', async () => {
    const header = Array.from({ length: 12 }, (_, i) => `c${i + 1}`).join(',');
    const row = Array.from({ length: 12 }, (_, i) => `${i + 1}.50`).join(',');
    const outcome = await run('csv-to-pdf', { pageSize: 'a5' }, [
      fileFrom(`${header}\n${row}`, 'wide.csv', 'text/csv'),
    ]);
    const bytes = await firstPdf(outcome);
    const [[pageW]] = await pageSizes(bytes);
    const runs = await textRuns(bytes);
    const cells = runs.filter((run) => /^(c\d+|\d+\.50)$/.test(run.text));
    expect(cells.length).toBeGreaterThan(12);
    // Every cell starts inside the sheet and its own text ends inside it too.
    for (const cell of cells) {
      expect(cell.x).toBeGreaterThan(0);
      expect(cell.x + cell.text.length * cell.size * 0.6).toBeLessThan(pageW);
    }
  });

  it('repeats the header row on every sheet the table spills onto', async () => {
    const outcome = await run('csv-to-pdf', { pageSize: 'a5', fontSize: 12 }, [
      fileFrom(rows(60), 'long.csv', 'text/csv'),
    ]);
    const bytes = await firstPdf(outcome);
    const pages = await pageSizes(bytes);
    expect(pages.length).toBeGreaterThan(1);
    const runs = await textRuns(bytes);
    for (let page = 0; page < pages.length; page++) {
      const on = runsOn(runs, page);
      for (const header of ['name', 'qty', 'price']) {
        expect(find(on, header).length, `${header} on page ${page + 1}`).toBe(1);
      }
    }
    // Rows keep their shape on the continuation sheet: three columns, one baseline.
    const label = runsOn(runs, 1).filter((run) => /^row\d+$/.test(run.text))[0];
    expect(label).toBeTruthy();
    const onRow = runsOn(runs, 1).filter((run) => Math.abs(run.y - label!.y) < 0.01);
    expect(columns(onRow).length).toBe(3);
    expect(onRow.map((run) => run.text)).toEqual([label!.text, String(Number(label!.text.slice(3)) - 1), `${Number(label!.text.slice(3)) - 1}.50`]);
  });

  it('keeps a tab inside a quoted field as aligned spaces, not a crash', async () => {
    // Pre-fix the table branch handed the writer the raw tab and the whole run died
    // with `WinAnsi cannot encode "\t" (0x0009)` — the same reason `csv-tab` still
    // produced no file in `docs/research/table-list-tail-after.txt`.
    const outcome = await run('csv-to-pdf', {}, [
      fileFrom('name,note\n"col1\tcol2",ok MKEND\n', 'tab.csv', 'text/csv'),
    ]);
    const runs = await textRuns(await firstPdf(outcome));
    expect(runs.some((run) => /^col1 {4}col2$/.test(run.text)), 'the tab reached the next 8-column stop').toBe(true);
    expect(find(runs, 'ok MKEND').length).toBe(1);
  });

  it('breaks the cell at a form feed instead of losing the file', async () => {
    const outcome = await run('csv-to-pdf', {}, [
      fileFrom('name,note\n"page one\fpage two",ok MKEND\n', 'ff.csv', 'text/csv'),
    ]);
    const runs = await textRuns(await firstPdf(outcome));
    const both = runs.filter((run) => run.text.startsWith('page '));
    expect(both.map((run) => run.text)).toEqual(['page one', 'page two']);
    expect(new Set(both.map((run) => run.x)).size, 'one column, two lines').toBe(1);
  });

  it('lays several files out one after another, each on its own sheet', async () => {
    // The file control promises "one after another in a single PDF"; the gate said
    // "This tool works on one file at a time" and refused the pair.
    const outcome = await run('csv-to-pdf', {}, [
      fileFrom('a,b\n1,2 MKEND\n', 'one.csv', 'text/csv'),
      fileFrom('c,d,e\n3,4,5 MKEND\n', 'two.csv', 'text/csv'),
    ]);
    const bytes = await firstPdf(outcome);
    expect(String(outcome.message)).toMatch(/Tabulated 2 file\(s\) into 2 page\(s\)/);
    const runs = await textRuns(bytes);
    expect(find(runsOn(runs, 0), 'a').length).toBe(1);
    expect(runsOn(runs, 0).some((run) => run.text === 'c')).toBe(false);
    expect(find(runsOn(runs, 1), 'c').length).toBe(1);
    expect(runsOn(runs, 1).some((run) => run.text === '1'), 'the first file stays on the first sheet').toBe(false);
  });

  it('bolds and repeats the header only while the header row is on', async () => {
    const data = ['name,qty,price'].concat(Array.from({ length: 40 }, (_, i) => `row${i + 1},${i},${i}.50`)).join('\n');
    const on = await textRuns(await firstPdf(await run('csv-to-pdf', { headerRow: true, pageSize: 'a5', fontSize: 12 }, [
      fileFrom(data, 'on.csv', 'text/csv'),
    ])));
    const off = await textRuns(await firstPdf(await run('csv-to-pdf', { headerRow: false, pageSize: 'a5', fontSize: 12 }, [
      fileFrom(data, 'off.csv', 'text/csv'),
    ])));
    // Every sheet of the header-on run repeats and bolds the row; the off run prints
    // it once, as ordinary data.
    expect(runsOn(on, 1).filter((run) => run.text === 'name').length).toBe(1);
    expect(runsOn(off, 1).filter((run) => run.text === 'name').length).toBe(0);
    expect(off.filter((run) => run.text === 'name').length).toBe(1);
    expect(on.filter((run) => run.text === 'name').length).toBe(2);
  });

  it('unescapes doubled quotes and keeps the rest of the field', async () => {
    const outcome = await run('csv-to-pdf', {}, [
      fileFrom('name,note\n"He said ""hi""",ok MKEND\n', 'quotes.csv', 'text/csv'),
    ]);
    const runs = await textRuns(await firstPdf(outcome));
    expect(find(runs, 'He said "hi"').length).toBe(1);
    expect(runs.some((run) => run.text.includes('""'))).toBe(false);
  });

  it('drops the type size instead of printing columns on top of each other', async () => {
    // Measured with 15 columns at 18 pt: the header words shared one baseline at 32 pt
    // per column, so the reader saw a single run `namenotesqty`.
    const header = ['id', 'name', 'notes', 'qty', 'price', ...Array.from({ length: 10 }, (_, i) => `col${i + 1}`)].join(',');
    const row = ['1', 'Widget', 'plain note', '3', '1.50', ...Array.from({ length: 10 }, (_, i) => `v${i + 1}`)].join(',');
    const outcome = await run('csv-to-pdf', { fontSize: 18 }, [
      fileFrom(`${header}\n${row} MKEND\n`, 'wide18.csv', 'text/csv'),
    ]);
    const bytes = await firstPdf(outcome);
    expect(outcome.warnings.join(' ')).toMatch(/Type size dropped from 18 pt/);
    const runs = await textRuns(bytes);
    expect(Math.max(...runs.map((run) => run.size))).toBeLessThanOrEqual(12);
    // No cell's own text reaches into the column to its right.
    const byRow = new Map<number, typeof runs>();
    for (const run of runs.filter((one) => !/^\d+$/.test(one.text))) {
      const key = Math.round(run.y * 10) / 10;
      byRow.set(key, [...(byRow.get(key) ?? []), run]);
    }
    for (const line of byRow.values()) {
      const sorted = [...line].sort((a, b) => a.x - b.x);
      for (const [index, left] of sorted.entries()) {
        const right = sorted[index + 1];
        if (!right) continue;
        // A conservative average advance (0.42 em) has to fit in the space between
        // the two cells, or the left one is printed over the right one.
        expect(right.x - left.x, `${left.text} reaches into ${right.text}`).toBeGreaterThanOrEqual(
          left.text.length * left.size * 0.42,
        );
      }
    }
  });

  it('prints every row once, in file order', async () => {
    const outcome = await run('csv-to-pdf', {}, [fileFrom(rows(9), 'nine.csv', 'text/csv')]);
    const runs = await textRuns(await firstPdf(outcome));
    const ordered = inOrder(runs);
    const seen = ordered.filter((run) => run.text.startsWith('row')).map((run) => run.text);
    expect(seen).toEqual(Array.from({ length: 9 }, (_, i) => `row${i + 1}`));
  });
});

describe('json-to-pdf and xml-to-pdf print nesting as geometry', () => {
  it('gives each nested object its own heading and its own key/value table', async () => {
    const outcome = await run('json-to-pdf', { source: 'paste', paste: '{"order":{"id":"A-7","lines":[{"sku":"X1"}]}}' });
    const runs = await textRuns(await firstPdf(outcome));
    const idKey = runs.filter((run) => run.text === 'id')[0];
    const idValue = find(runs, 'A-7')[0];
    expect(idKey).toBeTruthy();
    expect(idValue).toBeTruthy();
    expect(idValue!.x).toBeGreaterThan(idKey!.x);
    const orderHeading = runs.filter((run) => run.text === 'order' && run.size > idKey!.size)[0];
    expect(orderHeading).toBeTruthy();
    const sku = find(runs, 'X1')[0];
    expect(sku).toBeTruthy();
    expect(sku!.y).toBeLessThan(idValue!.y);
  });

  it('marks the branch the depth control cut, and keeps the rest', async () => {
    const outcome = await run('json-to-pdf', {
      source: 'paste',
      paste: '{"a":{"b":{"c":{"d":"deepestValue"}}}}',
      maxDepth: 2,
    });
    const bytes = await firstPdf(outcome);
    const text = squash(await extractText(bytes));
    expect(text).toContain('(truncated)');
    expect(text).toContain('a');
    // The cut branch is named as cut; its leaf value is not printed as if it were.
    expect(text).not.toContain('deepestValue');
  });

  it('prints an array of objects in order, and a scalar root at all', async () => {
    const outcome = await run('json-to-pdf', {
      source: 'paste',
      paste: JSON.stringify([{ sku: 'AA' }, { sku: 'BB' }, { sku: 'CC' }]),
    });
    const runs = await textRuns(await firstPdf(outcome));
    const ys = ['AA', 'BB', 'CC'].map((sku) => find(runs, sku)[0]?.y ?? -1);
    expect(ys.every((y) => y >= 0)).toBe(true);
    expect(ys[0]).toBeGreaterThan(ys[1]);
    expect(ys[1]).toBeGreaterThan(ys[2]);

    const scalar = await run('json-to-pdf', { source: 'paste', paste: '42' });
    expect(squash(await extractText(await firstPdf(scalar)))).toContain('42');
  });

  it('hangs an array as bullets whose text keeps the 70 pt edge', async () => {
    const outcome = await run('json-to-pdf', {
      source: 'paste',
      paste: JSON.stringify({ items: Array.from({ length: 12 }, (_, i) => `entry number ${i + 1}`) }),
    });
    const runs = await textRuns(await firstPdf(outcome));
    // `jsonToBlocks` hands the renderer a plain bullet list for a scalar array, so
    // every marker is the narrow `•` and the seam keeps it inside its 14 pt floor:
    // the bullet is painted at `margin + 2` and the item text at exactly `margin + 14`.
    // A route that still bought the gutter with an indent of its own moves this number.
    const bullets = runs.filter((run) => Math.abs(run.x - 58) < 0.5 && run.text.length === 1);
    expect(bullets.length).toBe(12);
    for (const bullet of bullets) {
      const item = runs.find((run) => run.page === bullet.page && run.x > bullet.x
        && Math.abs(run.y - (bullet.y - 5)) < 2);
      expect(item, `the item beside the bullet at y ${bullet.y}`).toBeTruthy();
      expect(item!.x, `the text beside ${JSON.stringify(bullet.text)}`).toBeCloseTo(70, 6);
    }
  });

  it('refuses JSON that does not parse, in words', async () => {
    await expect(run('json-to-pdf', { source: 'paste', paste: '{"a": }' }))
      .rejects.toThrow(/JSON|parse/i);
  });

  it('prints attributes but not the XML declaration, and keeps CDATA words', async () => {
    const outcome = await run('xml-to-pdf', {
      source: 'paste',
      paste: '<?xml version="1.0"?><root id="r1"><child lang="en">plain</child><cdata><![CDATA[a < b & c]]></cdata></root>',
    });
    const text = squash(await extractText(await firstPdf(outcome)));
    expect(text).toContain('r1');
    expect(text).toContain('lang="en"');
    expect(text).not.toContain('version="1.0"');
    expect(text).toContain('a < b & c');
  });

  it('prints bad XML as text and says it could not be parsed', async () => {
    // The tool prints a half-tag document rather than losing the words, so the
    // card must say which happened. It used to be silent.
    const outcome = await run('xml-to-pdf', { source: 'paste', paste: '<root><unclosed></root>' });
    expect(squash(await extractText(await firstPdf(outcome)))).toContain('unclosed');
    expect(outcome.warnings.join(' ')).toMatch(/not well-formed XML/);
  });

  it('indents an XML tree one step deeper per level', async () => {
    const outcome = await run('xml-to-pdf', {
      source: 'paste',
      paste: '<feed><entry id="1"><title>First entry</title></entry></feed>',
    });
    const runs = await textRuns(await firstPdf(outcome));
    const depthOf = (needle: string) => {
      const hit = find(runs, needle)[0];
      return hit ? { x: hit.x, y: hit.y } : undefined;
    };
    const root = depthOf('feed');
    const entry = depthOf('<entry id="1">');
    const title = depthOf('<title>');
    expect([root, entry, title].every(Boolean)).toBe(true);
    expect(entry!.x).toBeGreaterThan(root!.x);
    expect(title!.x).toBeGreaterThan(entry!.x);
    expect(squash(await extractText(await firstPdf(outcome)))).toContain('First entry');
  });
});

/**
 * The JSON a JSON file is allowed to hold.
 *
 * RFC 8259 escapes a tab, a form feed and any C0 control into a string value; a file
 * with one bad comma is one document, not three hundred lines of it; and the file
 * control says several files are laid out in the order they were added. Measured
 * before this round, each of those three facts ended the run with the writer's own
 * sentence, blamed the wrong line, or refused the pair outright.
 */
describe('json-to-pdf prints what JSON files are actually made of', () => {
  const json = (text: string, name = 'data.json') => fileFrom(text, name, 'application/json');

  it('keeps a tab inside a value at its column, in one cell', async () => {
    const outcome = await run('json-to-pdf', {}, [json('{"a":"id\\tname\\tqty","b":"333\\tcherry\\t5"}')]);
    const runs = await textRuns(await firstPdf(outcome));
    // Eight-column stops, the `expand` default the text and CSV rounds settled on:
    // `id` is two columns deep so its tab is six spaces, `name` ends at 12 so its tab
    // is four; the second row starts three columns deep, so its fields land on the
    // same stops. Pre-fix the run died with `WinAnsi cannot encode "\t" (0x0009)`.
    const header = find(runs, 'id      name    qty')[0]!;
    const row = find(runs, '333     cherry  5')[0]!;
    expect(header, 'the tabbed header row').toBeTruthy();
    expect(row, 'the tabbed data row').toBeTruthy();
    expect(row.x, 'both values are one column').toBeCloseTo(header.x, 1);
    expect(row.y).toBeLessThan(header.y);
    // The escape never reaches the page as a tab character the writer cannot encode.
    expect(runs.some((run) => run.text.includes('\t'))).toBe(false);
  });

  it('breaks the value at a form feed instead of losing the file', async () => {
    const outcome = await run('json-to-pdf', {}, [json('{"note":"first part\\fsecond part"}')]);
    const runs = await textRuns(await firstPdf(outcome));
    const one = find(runs, 'first part')[0]!;
    const two = find(runs, 'second part')[0]!;
    expect(one, 'the line before the form feed').toBeTruthy();
    expect(two, 'the line after it').toBeTruthy();
    expect(two.x, 'the break stays inside the value column').toBeCloseTo(one.x, 1);
    expect(baselines([one, two]).length).toBe(2);
    expect(outcome.warnings.join(' ')).not.toMatch(/control character/);
  });

  it('leaves out the characters no face can draw, and counts them out loud', async () => {
    const outcome = await run('json-to-pdf', {}, [json('{"a":"x\\u0001y\\u0000z","b":"keep \\u001f me"}')]);
    const text = squash(await extractText(await firstPdf(outcome)));
    expect(text).toContain('xyz');
    expect(text).toContain('keep me');
    // Three of them, in one named file, with the repair already done rather than a
    // library sentence the user cannot act on.
    expect(outcome.warnings.join(' ')).toMatch(/"data\.json" held 3 control characters that no face can draw; they were left out\./);
    expect(outcome.warnings.join(' ')).not.toMatch(/WinAnsi/);
  });

  it('names where in the file the parser stopped', async () => {
    const brace = await run('json-to-pdf', {}, [json('{"a": }', 'brace.json')]).catch((thrown: Error) => thrown);
    // V8 gives this shape no position at all ("Unexpected token '}', "{"a": }" is not
    // valid JSON"), so the column is found from the text it quoted.
    expect((brace as Error).message).toMatch(/^"brace\.json" is not valid JSON: Unexpected token '\}' at line 1, column 7 of the file\.$/);
    expect((brace as Error).message).not.toMatch(/is not valid JSON.*is not valid JSON/);
    expect((brace as ToolInputError).hint).toMatch(/Text to PDF/);

    const pretty = await run('json-to-pdf', {}, [json('{\n  "a": 1,\n  "b": [1, 2, 3,]\n}', 'pretty.json')]).catch((thrown: Error) => thrown);
    // One document with a trailing comma: the line-by-line NDJSON reading blamed
    // "document 1" and pointed at line 1, column 2, where nothing is wrong.
    expect((pretty as Error).message).not.toMatch(/document/);
    expect((pretty as Error).message).toMatch(/at line 3, column 17 of the file\./);

    const ndjson = await run('json-to-pdf', {}, [json('{"a":1}\n{"b":2,}\n{"c":3}', 'events.ndjson')]).catch((thrown: Error) => thrown);
    // A real NDJSON file keeps the document number, and the position is rebased from
    // the line V8 was handed onto the file the user holds.
    expect((ndjson as Error).message).toMatch(/^"events\.ndjson" \(document 2\) is not valid JSON: .* at line 2, column 8 of the file\.$/);
  });

  it('lays several files out one after another, each on its own sheet', async () => {
    const outcome = await run('json-to-pdf', {}, [
      json('{"file":"one","v":1}', 'one.json'),
      json('{"file":"two","v":2}', 'two.json'),
    ]);
    const bytes = await firstPdf(outcome);
    expect((await pageSizes(bytes)).length).toBe(2);
    const runs = await textRuns(bytes);
    // Each file keeps its own grid: sheet 1 has never heard of the second file.
    expect(runsOn(runs, 0).some((run) => run.text === 'one')).toBe(true);
    expect(runsOn(runs, 0).some((run) => run.text === 'two')).toBe(false);
    expect(runsOn(runs, 1).some((run) => run.text === 'two')).toBe(true);
    expect(runsOn(runs, 1).some((run) => run.text === 'one')).toBe(false);
    expect(outcome.message).toMatch(/Reported 2 JSON file\(s\) into 2 page\(s\)/);
    expect(outcome.outputs[0]!.name).toBe('one_from_json.pdf');
  });

  it('paints the branch the depth control cut as a real code band', async () => {
    const outcome = await run('json-to-pdf', {
      source: 'paste',
      paste: '{"a":{"b":{"c":{"d":"deepestValue"}}}}',
      maxDepth: 2,
    });
    const doc = await PDFDocument.load(await firstPdf(outcome), { updateMetadata: false });
    // `jsonToBlocks` marks the cut branch with a `kind:'code'` block, and the code
    // branch is exactly where c3 blocker 1 buried its text: the grey band must sit
    // behind the glyphs, on the rectangle it has always drawn.
    expectPaintedCode(doc.getPage(0), 1);
  });

  it('prints an array twice, and says so on the card', async () => {
    const outcome = await run('json-to-pdf', { source: 'paste', paste: '{"items":["one","two","three"]}' });
    const runs = await textRuns(await firstPdf(outcome));
    const indexed = runs.filter((run) => run.text === 'one');
    // Measured state, filed to the seam: the shared walker emits the bulleted list of
    // the items and then walks each item under its own `[index]` key, so the same word
    // reaches the page twice — once beside a bullet at the list's text edge, once after
    // its index in the paragraph column. The card states it instead of hiding it.
    expect(indexed.length, 'every scalar array item is printed twice').toBe(2);
    expect(Math.min(...indexed.map((run) => run.x))).toBeCloseTo(70, 1);
    expect(runs.some((run) => run.text === '[0]: '), 'the index the item is repeated under').toBe(true);
    expect(String(getPdfTool('json-to-pdf')?.notes)).toMatch(/An array is printed twice/);
  });

  it('spills a long array across sheets and keeps its last item', async () => {
    const list = Array.from({ length: 300 }, (_, i) => `entry ${i + 1} of the long array`);
    const outcome = await run('json-to-pdf', { source: 'paste', paste: JSON.stringify({ list }) });
    const bytes = await firstPdf(outcome);
    const sheets = (await pageSizes(bytes)).length;
    expect(sheets).toBeGreaterThan(1);
    // The number the receipt prints is the number of sheets in the file.
    expect(outcome.pagesOut).toBe(sheets);
    // Items wrap onto more than one baseline, so the phrase is judged out of the text
    // layer, where the wrapped halves join back together.
    const text = squash(await extractText(bytes));
    for (const needle of ['entry 1 of the long array', 'entry 150 of the long array', 'entry 300 of the long array']) {
      expect(text, needle).toContain(needle);
    }
    // Each of them twice — the list and the `[index]` restatement — and nothing outside
    // the sheet it was painted on.
    expect(text.split('entry 300 of the long array').length - 1).toBe(2);
    const runs = await textRuns(bytes);
    const sizes = await pageSizes(bytes);
    for (const run of runs) {
      const [width, height] = sizes[run.page]!;
      expect(run.x, `sheet ${run.page + 1} run ${run.text} left the left edge`).toBeGreaterThanOrEqual(-0.01);
      expect(run.x, `sheet ${run.page + 1} run ${run.text} sits past the sheet`).toBeLessThan(width);
      expect(run.y, `sheet ${run.page + 1} run ${run.text} fell below the sheet`).toBeGreaterThan(-0.01);
      expect(run.y).toBeLessThan(height);
    }
  });

  it('fetches the script faces a Japanese key needs, once each, from the host the card names', async () => {
    const asked: string[] = [];
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      asked.push(url);
      return inner(input as never);
    }) as typeof fetch;
    try {
      clearFontCache();
      const outcome = await run('json-to-pdf', { source: 'paste', paste: '{"状態":"値です"}' });
      const text = squash(await extractText(await firstPdf(outcome)));
      expect(text).toContain('状態');
      expect(text).toContain('値です');
      // 状 and 値 are Han and です is kana, so the document needs two faces. Both come
      // once, from the host the card names, and no bytes of the document go anywhere.
      const remote = asked.filter((url) => /^https:/.test(url));
      expect(new Set(remote).size, JSON.stringify(remote)).toBe(remote.length);
      expect(remote.every((url) => url.startsWith('https://cdn.jsdelivr.net/npm/@expo-google-fonts/'))).toBe(true);
      expect(remote).toContain('https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-jp/NotoSansJP_400Regular.ttf');
      expect(String(getPdfTool('json-to-pdf')?.notes)).toMatch(/faces are fetched from the CDN/);
    } finally {
      globalThis.fetch = inner;
      clearFontCache();
    }
  });
});

/**
 * The XML tree as the page actually holds it.
 *
 * Three things about this route were measured wrong before the round: a literal tab in
 * an element's text — which XML allows anywhere and `&#9;` writes on purpose — ended the
 * run with the writer's own sentence and no file, the leaf of a deep document was placed
 * off the sheet, and the card's promise about entity resolution was simply false. The
 * block pins below also hold down two limits the shared walker owns and this route only
 * discloses: an element with neither attributes nor text prints nothing, and text
 * between two children prints on the parent's line.
 */
describe('xml-to-pdf prints the tree it promises', () => {
  const xml = (text: string, name = 'doc.xml') => fileFrom(text, name, 'application/xml');

  it('keeps a tab in an element’s text at its column instead of losing the file', async () => {
    const outcome = await run('xml-to-pdf', {}, [
      xml('<root><item>MKSTART a\tb</item><item>MKEND c\td</item></root>'),
    ]);
    const runs = await textRuns(await firstPdf(outcome));
    // Pre-fix: `REFUSED: WinAnsi cannot encode "\t" (0x0009)` and no file, for a tab the
    // parser put there legitimately. Now it stops at the next eighth column of the text
    // it sits in: ` MKSTART a` is ten characters deep so six spaces follow, ` MKEND c` is
    // eight so eight more do — and no raw tab reaches the writer anywhere on the sheet.
    expect(runs.filter((run) => run.text === ' MKSTART a      b').length, 'the tabbed first item').toBe(1);
    expect(runs.filter((run) => run.text === ' MKEND c        d').length, 'the tabbed second item').toBe(1);
    expect(runs.some((run) => run.text.includes('\t')), 'a tab survived to the page').toBe(false);
    expect(outcome.message).toMatch(/Printed 1 XML file\(s\)/);
  });

  it('treats a character reference for a tab as the tab it names', async () => {
    const outcome = await run('xml-to-pdf', {}, [xml('<root><a>x&#9;y</a></root>')]);
    const runs = await textRuns(await firstPdf(outcome));
    // `x&#9;y` is the same text written portably: ` x` is two characters deep, so the
    // tab stops at column 8 with six spaces and `y` opens it.
    expect(runs.filter((run) => run.text === ' x      y').length, '&#9; stops at column 8').toBe(1);
    expect(outcome.warnings.join(' ')).not.toMatch(/not well-formed|control character/);
  });

  it('indents one step per level, paid once', async () => {
    const outcome = await run('xml-to-pdf', {}, [xml('<root><a><b><c>deep word</c></b></a></root>')]);
    const runs = await textRuns(await firstPdf(outcome));
    const at = (needle: string) => find(runs, needle)[0]!;
    // `xmlToBlocks` used to buy each level twice — a 12 pt paragraph indent *and* two
    // literal spaces inside the tag text — so the visible step was ~18 pt and the tag a
    // reader searched for began with whitespace. One 12 pt step now, from the margin.
    // `<a>` and `<b>` are pure containers, so the walker gives them no line (pinned
    // below); `<c>`, three levels down, is the one that speaks — and it now sits at
    // exactly `margin + 3 × 12`, not the `+18/level` the doubled spaces produced.
    expect(at('<c>').x).toBeCloseTo(92, 1);
    expect(at('deep word').x).toBeCloseTo(110.35, 1);
    expect(runs.some((run) => /^ {2,}</.test(run.text)), 'a tag still carries its spaces').toBe(false);
  });

  it('keeps the leaf of a sixty-level tree on the sheet', async () => {
    const outcome = await run('xml-to-pdf', {}, [
      xml(`<root>${'<a>'.repeat(60)}<leaf>DEEPEND</leaf>${'</a>'.repeat(60)}</root>`),
    ]);
    const bytes = await firstPdf(outcome);
    const runs = await textRuns(bytes);
    const [[width]] = await pageSizes(bytes);
    // Measured pre-fix at x 788 on a 595.28 pt sheet: in the text layer, off the page.
    expect(Math.max(...runs.map((run) => run.x)), 'the deepest indent').toBeLessThan(width - 56);
    expect(squash(await extractText(bytes))).toContain('DEEPEND');
    expect(String(getPdfTool('xml-to-pdf')?.notes)).toMatch(/stops at half the text column/);
  });

  it('prints an element with nothing of its own as nothing, and says so', async () => {
    const outcome = await run('xml-to-pdf', {}, [
      xml('<rss><channel><item><t>one</t></item></channel><skip/></rss>'),
    ]);
    const text = squash(await extractText(await firstPdf(outcome)));
    // Measured state, filed to the seam (`xmlToBlocks` only emits a line for an element
    // with attributes or text): the containers vanish and the leaf keeps its depth.
    expect(text).toContain('<t> one');
    expect(text).not.toContain('channel');
    expect(text).not.toContain('skip');
    expect(String(getPdfTool('xml-to-pdf')?.notes)).toMatch(/An element gets a line only when/);
  });

  it('resolves the references XML defines and prints the file that does not', async () => {
    const good = await run('xml-to-pdf', {}, [xml('<root><a>&#8212; &#65; &#x41; &amp; &lt;tag&gt;</a></root>')]);
    const text = squash(await extractText(await firstPdf(good)));
    // 0x97 is the em dash's WinAnsi byte in a standard face, what a viewer decodes back
    // as `—`; MuPDF reads it as the dash itself on the same bytes (live half).
    expect(text).toContain('\u0097 A A & <tag>');
    // `&nbsp;` is an HTML entity, undefined in XML: the document is not well-formed, so
    // the whole file reaches the page as text and the run says which happened.
    const nbsp = await run('xml-to-pdf', {}, [xml('<root><a>a&nbsp;b</a></root>')]);
    expect(nbsp.warnings.join(' ')).toMatch(/"doc\.xml" is not well-formed XML, so it was printed as plain text/);
    expect(squash(await extractText(await firstPdf(nbsp)))).toContain('a&nbsp;b');
    // The fallback is a code page, and a code page that paints nothing is no page at all.
    const doc = await PDFDocument.load(await firstPdf(nbsp), { updateMetadata: false });
    expectPaintedCode(doc.getPage(0), 1);
  });

  it('keeps CDATA literal, markup characters and all', async () => {
    const outcome = await run('xml-to-pdf', {}, [
      xml('<root><c><![CDATA[if (a < b && c > d) {\n  keep &amp; literal\n}]]></c><d>after MKEND</d></root>'),
    ]);
    const text = squash(await extractText(await firstPdf(outcome)));
    expect(text).toContain('if (a < b && c > d)');
    // A CDATA section is not parsed, so the entity it holds stays written out — the one
    // place where this route must not resolve a reference.
    expect(text).toContain('keep &amp; literal');
    expect(text).not.toContain('CDATA');
    expect(text).toContain('after MKEND');
  });

  it('prints a namespace declaration as the attribute it is and keeps the prefix', async () => {
    const outcome = await run('xml-to-pdf', {}, [
      xml('<rss xmlns:media="http://m"><channel><media:title>Named title</media:title></channel></rss>'),
    ]);
    const text = squash(await extractText(await firstPdf(outcome)));
    expect(text).toContain('xmlns:media="http://m"');
    expect(text).toContain('<media:title>');
    expect(text).toContain('Named title');
  });

  it('lays several files out one after another, each on its own sheet', async () => {
    const outcome = await run('xml-to-pdf', {}, [
      xml('<feed><f>ONEFILE</f></feed>', 'one.xml'),
      xml('<feed><f>TWOSITE</f></feed>', 'two.xml'),
    ]);
    const bytes = await firstPdf(outcome);
    expect((await pageSizes(bytes)).length).toBe(2);
    const runs = await textRuns(bytes);
    expect(runsOn(runs, 0).some((run) => run.text.includes('ONEFILE'))).toBe(true);
    expect(runsOn(runs, 0).some((run) => run.text.includes('TWOSITE'))).toBe(false);
    expect(runsOn(runs, 1).some((run) => run.text.includes('TWOSITE'))).toBe(true);
    expect(outcome.message).toMatch(/Printed 2 XML file\(s\) into 2 page\(s\)/);
    expect(outcome.outputs[0]!.name).toBe('one_from_xml.pdf');
  });
});

describe('rtf-to-pdf recovers text, size and order', () => {
  const rtf = String.raw`{\rtf1\ansi\ansicpg1252\deff0
{\colortbl ;\red255\green0\blue0;}
\fs28 Big Heading Line\fs22
\par A normal paragraph with \b bold\b0  words and a \'e9 accent.\par
\pard\bullet An itemised line\par}`;

  it('draws the larger run larger, above the body text', async () => {
    const outcome = await run('rtf-to-pdf', { source: 'paste', paste: rtf });
    const runs = await textRuns(await firstPdf(outcome));
    const text = compact(runs.map((run) => run.text).join(''));
    expect(text).toContain('bigheadingline');
    expect(text).toContain('anormalparagraph');
    expect(text).toContain('bold');
    const biggest = runs.reduce((best, run) => (run.size > best.size ? run : best), runs[0]!);
    expect(biggest.size).toBeGreaterThan(11);
    const heading = runs.filter((run) => run.size === biggest.size).map((run) => run.text).join('');
    expect(compact(heading)).toContain('bigheading');
  });

  it('applies the colour table, italic and a \\u escape, and ends a group’s scope', async () => {
    const source = String.raw`{\rtf1\ansi{\colortbl ;\red255\green0\blue0;}\cf1 red words\cf0  plain \i slanted\i0  tail \u233? e-acute\par}`;
    const outcome = await run('rtf-to-pdf', { source: 'paste', paste: source });
    const bytes = await firstPdf(outcome);
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const colours = pageContentOps(doc.getPages()[0]!)
      .filter((op) => op.name === 'rg')
      .map((op) => op.operands.filter((operand) => operand.kind === 'number').map((operand) => round((operand as { value: number }).value)));
    expect(colours.some((c) => c[0] === 1 && c[1] === 0 && c[2] === 0)).toBe(true);
    // Runs are one character each here, so italic is judged on the page's own
    // font resources: `\i` must have selected an oblique face, and the `é` typed
    // after `\i0` must be set in an upright one — that is the scope test.
    const firstPage = doc.getPages()[0]!;
    const fonts = firstPage.node.Resources()?.lookup(PDFName.of('Font'), PDFDict) as PDFDict;
    const names = fonts.keys().map((key) => fonts.lookup(key)?.toString() ?? '');
    expect(names.join(' ')).toMatch(/Oblique|Italic/);
    expect(names.join(' ')).toMatch(/Helvetica(?!-)/);
    const runs = await textRuns(bytes);
    const accent = runs.find((run) => run.text === 'é');
    expect(accent?.font ?? '').not.toMatch(/Italic|Oblique/i);
    expect(squash(await extractText(bytes))).toContain('é');
  });

  it('decodes an RTF escape into the accented character it names', async () => {
    const outcome = await run('rtf-to-pdf', { source: 'paste', paste: rtf });
    const words = squash(await extractText(await firstPdf(outcome)));
    expect(compact(words)).toContain('accent');
    expect(words).toContain('é');
  });
});

/* ------------------------------------------------------------------ *
 * Office documents                                                   *
 * ------------------------------------------------------------------ */

describe('word-to-pdf keeps headings, tables and non-Latin text', () => {
  const headingDocx = docxBytes(
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly Report</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>The body of the report follows here.</w:t></w:r></w:p>'
    + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Item</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Qty</w:t></w:r></w:p></w:tc></w:tr>'
    + '<w:tr><w:tc><w:p><w:r><w:t>Widget</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>3</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
  );

  it('renders the DOCX heading bigger than its body text', async () => {
    const outcome = await run('word-to-pdf', {}, [fileFrom(await headingDocx, 'report.docx')]);
    const runs = await textRuns(await firstPdf(outcome));
    const heading = find(runs, 'Quarterly Report')[0];
    // Body text wraps, so match the first line of the paragraph rather than the
    // whole sentence the fixture started with.
    const body = find(runs, 'The body of the')[0];
    expect(heading).toBeTruthy();
    expect(body).toBeTruthy();
    expect(heading!.size).toBeGreaterThan(body!.size);
    expect(heading!.y).toBeGreaterThan(body!.y);
  });

  it('keeps a DOCX table a table', async () => {
    const outcome = await run('word-to-pdf', {}, [fileFrom(await headingDocx, 'report.docx')]);
    const runs = await textRuns(await firstPdf(outcome));
    const header = runs.filter((run) => ['Item', 'Qty'].includes(run.text));
    const row = runs.filter((run) => ['Widget', '3'].includes(run.text));
    expect(columns(header).length).toBe(2);
    expect(columns(row)).toEqual(columns(header));
    expect(baselines(row).length).toBe(1);
    expect(row[0]!.y).toBeLessThan(header[0]!.y);
  });

  it('keeps bold and strike runs and breaks a line at w:br', async () => {
    const docx = docxBytes(
      '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>loud</w:t></w:r><w:r><w:t xml:space="preserve"> and </w:t></w:r>'
      + '<w:r><w:rPr><w:strike/></w:rPr><w:t>struck</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>one</w:t><w:br/><w:t>two</w:t></w:r></w:p>',
    );
    const outcome = await run('word-to-pdf', {}, [fileFrom(await docx, 'marks.docx')]);
    const bytes = await firstPdf(outcome);
    const runs = await textRuns(bytes);
    const loud = runs.find((run) => run.text.includes('loud'));
    const struck = runs.find((run) => run.text.includes('struck'));
    expect(loud?.font ?? '').toMatch(/Bold/i);
    expect(struck).toBeTruthy();
    // The strike is painted as a rule: the page's content stream carries a thin
    // filled rectangle or a stroked line near the struck word's baseline.
    expect(pageContentOps((await PDFDocument.load(bytes, { updateMetadata: false })).getPages()[0]!)
      .some((op) => ['re', 'S'].includes(op.name))).toBe(true);
    const one = runs.find((run) => run.text === 'one');
    const two = runs.find((run) => run.text === 'two');
    expect(one && two).toBeTruthy();
    expect(one!.y).toBeGreaterThan(two!.y);
  });

  it('refuses a .docx that holds PDF bytes', async () => {
    await expect(run('word-to-pdf', {}, [fileFrom(await pdfBytes(), 'report.docx')]))
      .rejects.toThrow(/PDF/i);
  });

  it('carries Cyrillic and CJK from the document into the PDF', async () => {
    const docx = docxBytes(
      '<w:p><w:r><w:t>Привет мир</w:t></w:r></w:p><w:p><w:r><w:t>中文段落内容</w:t></w:r></w:p>',
    );
    const outcome = await run('word-to-pdf', {}, [fileFrom(await docx, 'intl.docx')]);
    const words = squash(await extractText(await firstPdf(outcome)));
    expect(words).toContain('Привет мир');
    expect(words).toContain('中文段落内容');
    expect(words).not.toContain('\uFFFD');
  });

  it('reads an ODT body in order and typesets it', async () => {
    const outcome = await run('word-to-pdf', {}, [
      fileFrom(await odtBytes(['First ODT paragraph', 'Second ODT paragraph']), 'letter.odt'),
    ]);
    const runs = await textRuns(await firstPdf(outcome));
    const first = find(runs, 'First ODT paragraph')[0];
    const second = find(runs, 'Second ODT paragraph')[0];
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first!.y).toBeGreaterThan(second!.y);
    expect(first!.x).toBe(second!.x);
  });

  it('starts the document on the first sheet, not after a blank one', async () => {
    const outcome = await run('word-to-pdf', {}, [fileFrom(await headingDocx, 'report.docx')]);
    const bytes = await firstPdf(outcome);
    expect((await pageSizes(bytes)).length).toBe(1);
    expect(runsOn(await textRuns(bytes), 0).length).toBeGreaterThan(0);
  });

  it('numbers a DOCX list of twelve without printing on the words', async () => {
    const docx = numberedDocxBytes(Array.from({ length: 12 }, (_, i) => `step ${i + 1} of the guide`));
    const outcome = await run('word-to-pdf', {}, [fileFrom(await docx, 'plan.docx')]);
    const runs = await textRuns(await firstPdf(outcome));
    const markers = runs.filter((run) => /^\d+\.$/.test(run.text));
    expect(markers.map((run) => run.text)).toEqual(
      ['1.', '2.', '3.', '4.', '5.', '6.', '7.', '8.', '9.', '10.', '11.', '12.'],
    );
    // This route hands the renderer Mammoth's `<ol>` with no marker of its own, so
    // the seam numbers the items and measures its own gutter: every item of the list
    // shares `margin + gutter(widest marker)`, and the two-digit ones clear `10.` the
    // same way the Markdown and HTML routes do.
    const edge = 56 + (await seamGutter('12.', markers[0]!.size));
    for (const marker of markers) {
      expect(marker.x, `marker ${marker.text}`).toBeCloseTo(58, 1);
      const step = runs.find((run) => run.page === marker.page && run.x > marker.x && Math.abs(run.y - (marker.y - 5)) < 2)!;
      expect(step.x, `${marker.text} and its text`).toBeCloseTo(edge, 1);
    }
    expect(runs.some((run) => run.text.startsWith('10.step'))).toBe(false);
  });
});

describe('excel-to-pdf prints the cells it was shown', () => {
  it('lays one sheet out as a labelled grid', async () => {
    const outcome = await run('excel-to-pdf', {}, [fileFrom(await workbookBytes(), 'sales.xlsx')]);
    const bytes = await firstPdf(outcome);
    const runs = await textRuns(bytes);
    expect(find(runs, 'Sales').length).toBeGreaterThan(0);
    const header = runs.filter((run) => ['Item', 'Qty', 'Price'].includes(run.text));
    const widget = runs.filter((run) => ['Widget', '3', '9.99'].includes(run.text));
    const gizmo = runs.filter((run) => ['Gizmo', '12', '4.5'].includes(run.text));
    expect(columns(header).length).toBe(3);
    expect(baselines(widget).length).toBe(1);
    expect(columns(widget)).toEqual(columns(header));
    expect(columns(gizmo)).toEqual(columns(header));
    expect(widget[0]!.y).toBeGreaterThan(gizmo[0]!.y);
    expect(header[0]!.y).toBeGreaterThan(widget[0]!.y);
    expect(squash(await extractText(bytes))).toContain('9.99');
  });

  it('lays several workbooks out in the order they were added', async () => {
    const outcome = await run('excel-to-pdf', {}, [
      fileFrom(await workbookBytes(), 'first.xlsx'),
      fileFrom(await workbookBytes(), 'second.xlsx'),
    ]);
    const runs = inOrder(await textRuns(await firstPdf(outcome)));
    const titles = runs.filter((run) => run.text === 'first.xlsx' || run.text === 'second.xlsx');
    expect(titles.map((run) => run.text)).toEqual(['first.xlsx', 'second.xlsx']);
    // Each workbook still gets its own grid of the same shape.
    const headers = runs.filter((run) => run.text === 'Item');
    expect(headers.length).toBe(2);
    expect(columns(runs.filter((run) => ['Widget', '3', '9.99'].includes(run.text))).length).toBe(3);
  });

  it('keeps a merged header on one line and still lays out an empty sheet', async () => {
    const outcome = await run('excel-to-pdf', {}, [fileFrom(await workbookBytes(), 'sales.xlsx')]);
    const bytes = await firstPdf(outcome);
    const runs = await textRuns(bytes);
    // The fixture merges A1:B1 across `Item` and `Qty`: both header cells stay on
    // the header's own baseline rather than being pushed to their own rows.
    const merged = runs.filter((run) => ['Item', 'Qty'].includes(run.text));
    expect(baselines(merged).length).toBe(1);
    // The workbook's second sheet holds no cells: it is skipped, and named in a
    // warning rather than becoming a blank section nobody can tell from a page
    // break.
    expect(outcome.warnings.join(' ')).toMatch(/Sheet "Empty".*skipped/);
  });

  it('prints a boolean cell as a word, not as 1', async () => {
    const XLSX = await import('xlsx');
    const sheet = XLSX.utils.aoa_to_sheet([['flag'], [true], [false]]);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'Flags');
    const bytes = new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
    const text = squash(await extractText(await firstPdf(await run('excel-to-pdf', {}, [fileFrom(bytes, 'flags.xlsx')]))));
    expect(text).toMatch(/TRUE|FALSE/);
  });

  it('refuses a PDF dropped on it instead of printing the wrong thing', async () => {
    const error = await run('excel-to-pdf', {}, [fileFrom(await pdfBytes(), 'doc.pdf')]).catch((err) => err);
    expect((error as Error).message).toMatch(/is a PDF/);
  });
});

describe('powerpoint-to-pdf keeps every slide, even an empty one', () => {
  it('gives a blank slide its own page rather than dropping it', async () => {
    const outcome = await run('powerpoint-to-pdf', {}, [
      fileFrom(await pptxBytes(['First', '', 'Third']), 'deck.pptx'),
    ]);
    // A blank slide is a beat in the deck (a pause before the point); the page
    // count has to match the slide count or the deck drifts out of step.
    expect(outcome.pagesOut).toBe(3);
    const text = squash(await extractText(await firstPdf(outcome)));
    expect(text).toContain('First');
    expect(text).toContain('Third');
  });
});

describe('powerpoint-to-pdf gives each slide its own page', () => {
  it('converts two slides into two pages, not three with a blank leader', async () => {
    const outcome = await run('powerpoint-to-pdf', {}, [
      fileFrom(await pptxBytes(['Opening slide title', 'Closing slide title']), 'deck.pptx'),
    ]);
    const bytes = await firstPdf(outcome);
    const pages = await pageSizes(bytes);
    expect(pages).toEqual([[960, 540], [960, 540]]);
    expect(outcome.pagesOut).toBe(2);
    const runs = await textRuns(bytes);
    const opening = find(runs, 'Opening slide title');
    const closing = find(runs, 'Closing slide title');
    expect(opening.length).toBe(1);
    expect(closing.length).toBe(1);
    expect(opening[0]!.page).toBe(0);
    expect(closing[0]!.page).toBe(1);
  });

  it('honours the 4:3 aspect control on the sheets it writes', async () => {
    const outcome = await run('powerpoint-to-pdf', { slideSize: '4:3' }, [
      fileFrom(await pptxBytes(['One slide only']), 'deck.pptx'),
    ]);
    expect(await pageSizes(await firstPdf(outcome))).toEqual([[720, 540]]);
  });

  it('keeps a slide title bigger than the slide body', async () => {
    const slide = (texts: string[]) =>
      zipBytes([
        {
          name: 'ppt/slides/slide1.xml',
          data:
            '<?xml version="1.0"?>'
            + '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>'
            + texts.map((text) => `<p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`).join('')
            + '</p:spTree></p:cSld></p:sld>',
        },
      ]);
    const outcome = await run('powerpoint-to-pdf', {}, [
      fileFrom(await slide(['Title of the slide', 'Body line of the slide']), 'deck.pptx'),
    ]);
    const runs = await textRuns(await firstPdf(outcome));
    const title = find(runs, 'Title of the slide')[0];
    const body = find(runs, 'Body line of the slide')[0];
    expect(title).toBeTruthy();
    expect(body).toBeTruthy();
    expect(title!.size).toBeGreaterThan(body!.size);
    expect(title!.y).toBeGreaterThan(body!.y);
  });

  it('adds speaker notes below the slide that carries them', async () => {
    const deck = await zipBytes([
      {
        name: 'ppt/slides/slide1.xml',
        data: '<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Slide text</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
      },
      {
        name: 'ppt/notesSlides/notesSlide1.xml',
        data: '<?xml version="1.0"?><p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Remember to mention the roadmap</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>',
      },
    ]);
    const withNotes = await run('powerpoint-to-pdf', { notes: true }, [fileFrom(deck, 'deck.pptx')]);
    const without = await run('powerpoint-to-pdf', { notes: false }, [fileFrom(deck, 'deck.pptx')]);
    expect(squash(await extractText(await firstPdf(withNotes)))).toContain('Remember to mention the roadmap');
    expect(squash(await extractText(await firstPdf(without)))).not.toContain('Remember to mention the roadmap');
  });

  it('gives each ODP draw page its own sheet in order', async () => {
    const outcome = await run('powerpoint-to-pdf', {}, [
      fileFrom(await odpBytes([{ title: 'Alpha slide', body: 'Alpha body' }, { title: 'Beta slide', body: 'Beta body' }]), 'talk.odp'),
    ]);
    const bytes = await firstPdf(outcome);
    const pages = await pageSizes(bytes);
    expect(pages.length).toBe(2);
    const runs = await textRuns(bytes);
    expect(runsOn(runs, 0).some((run) => run.text === 'Alpha slide')).toBe(true);
    expect(runsOn(runs, 0).some((run) => run.text === 'Beta slide')).toBe(false);
    expect(runsOn(runs, 1).some((run) => run.text === 'Beta body')).toBe(true);
  });

  it('does not offer a file it cannot read', async () => {
    const error = await run('powerpoint-to-pdf', {}, [fileFrom(OLE_BYTES, 'deck.ppt')]).catch((err) => err);
    expect((error as Error).message).toMatch(/LibreOffice/);
  });
});

describe('epub-to-pdf follows the spine, not the manifest', () => {
  it('reads the chapters in spine order when the manifest lists them backwards', async () => {
    // Real EPUBs list manifest items in any order and state the reading order in
    // the spine. A reader that walks the manifest prints the book backwards.
    const book = await zipBytes([
      {
        name: 'META-INF/container.xml',
        data: '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      },
      {
        name: 'OEBPS/content.opf',
        data: '<package xmlns="http://www.idpf.org/2007/opf"><manifest>'
          + '<item id="b" href="b.xhtml" media-type="application/xhtml+xml"/>'
          + '<item id="a" href="a.xhtml" media-type="application/xhtml+xml"/>'
          + '</manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>',
      },
      { name: 'OEBPS/a.xhtml', data: '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Chapter A</h1><p>alpha body</p></body></html>' },
      { name: 'OEBPS/b.xhtml', data: '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Chapter B</h1><p>beta body</p></body></html>' },
    ]);
    const runs = await textRuns(await firstPdf(await run('epub-to-pdf', {}, [fileFrom(book, 'book.epub')])));
    expect(runsOn(runs, 0).some((run) => run.text.includes('alpha body'))).toBe(true);
    expect(runsOn(runs, 1).some((run) => run.text.includes('beta body'))).toBe(true);
  });
});

describe('epub-to-pdf reflows a book without losing its order', () => {
  it('puts each chapter on its own sheet, in spine order, numbered', async () => {
    const outcome = await run('epub-to-pdf', {}, [
      fileFrom(await epubBytes(['Alpha chapter body text', 'Beta chapter body text']), 'book.epub'),
    ]);
    const bytes = await firstPdf(outcome);
    const pages = await pageSizes(bytes);
    expect(pages.length).toBe(2);
    const runs = await textRuns(bytes);
    expect(runsOn(runs, 0).some((run) => run.text.includes('Alpha chapter body'))).toBe(true);
    expect(runsOn(runs, 0).some((run) => run.text.includes('Beta chapter'))).toBe(false);
    expect(runsOn(runs, 1).some((run) => run.text.includes('Beta chapter body'))).toBe(true);
    // The chapter heading from the XHTML is a heading, not a paragraph.
    const heading = find(runsOn(runs, 0), 'Chapter 1')[0];
    const body = find(runsOn(runs, 0), 'Alpha chapter body')[0];
    expect(heading!.size).toBeGreaterThan(body!.size);
    // Footer numbers count the sheets this converter made.
    expect(runsOn(runs, 1).some((run) => run.text === '2')).toBe(true);
  });
});

describe('email-to-pdf prints the message, not the MIME plumbing', () => {
  const eml = [
    'Subject: Quarterly results',
    'From: sender@example.com',
    'To: first@example.com, second@example.com',
    'Date: Tue, 1 Jan 2025 09:30:00 +0000',
    'Content-Type: multipart/mixed; boundary="bd"',
    '',
    '--bd',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Revenue grew by 12% in caf=C3=A9 country.',
    'Second paragraph of the body.',
    '--bd',
    'Content-Type: application/pdf; name="deck.pdf"',
    'Content-Disposition: attachment; filename="deck.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    'JVBERi0xLjQK',
    '--bd--',
    '',
  ].join('\r\n');

  it('prints the headers as a two-column table above the body', async () => {
    const outcome = await run('email-to-pdf', {}, [fileFrom(eml, 'mail.eml', 'message/rfc822')]);
    const runs = await textRuns(await firstPdf(outcome));
    const labels = runs.filter((run) => ['From', 'To', 'Date'].includes(run.text));
    expect(labels.length).toBe(3);
    expect(baselines(labels).length).toBe(3);
    const fromValue = find(runs, 'sender@example.com')[0];
    const fromLabel = labels.find((run) => run.text === 'From')!;
    expect(fromValue.x).toBeGreaterThan(fromLabel.x);
    const subject = find(runs, 'Quarterly results')[0];
    expect(subject.size).toBeGreaterThan(fromLabel.size);
    expect(subject.y).toBeGreaterThan(fromLabel.y);
  });

  it('decodes quoted-printable UTF-8 in the body and keeps its order', async () => {
    const outcome = await run('email-to-pdf', {}, [fileFrom(eml, 'mail.eml', 'message/rfc822')]);
    const runs = await textRuns(await firstPdf(outcome));
    const body = inOrder(runs.filter((run) => run.text.includes('paragraph') || run.text.includes('Revenue')));
    expect(body.length).toBe(2);
    expect(body[0]!.y).toBeGreaterThan(body[1]!.y);
    const text = squash(await extractText(await firstPdf(outcome)));
    expect(text).toContain('café country');
    expect(text).not.toContain('=C3=A9');
    expect(text).not.toContain('quoted-printable');
  });

  it('lists an attachment by name, type and size in columns', async () => {
    const outcome = await run('email-to-pdf', {}, [fileFrom(eml, 'mail.eml', 'message/rfc822')]);
    const runs = await textRuns(await firstPdf(outcome));
    expect(find(runs, 'deck.pdf').length).toBeGreaterThan(0);
    expect(squash(runs.map((run) => run.text).join(' '))).toContain('application/pdf');
    const header = runs.filter((run) => ['File', 'Type', 'Size'].includes(run.text));
    expect(columns(header).length).toBe(3);
  });

  it('joins a folded header and prints an HTML body as words', async () => {
    const mail = [
      'Subject: A very long subject that the sender',
      ' wrapped onto a second line',
      'From: sender@example.com',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Hello <b>there</b> &amp; welcome.</p>',
    ].join('\r\n');
    const text = squash(await extractText(await firstPdf(await run('email-to-pdf', {}, [
      fileFrom(mail, 'folded.eml', 'message/rfc822'),
    ]))));
    // A folded header is one value: the newline and the space before the
    // continuation belong to the header, not to the subject.
    expect(text).toContain('long subject that the sender wrapped onto a second line');
    expect(text).toContain('Hello there & welcome.');
    expect(text).not.toContain('<b>');
  });

  it('drops the attachment list when the control is off', async () => {
    const outcome = await run('email-to-pdf', { includeAttachments: false }, [fileFrom(eml, 'mail.eml', 'message/rfc822')]);
    const text = squash(await extractText(await firstPdf(outcome)));
    expect(text).toContain('Quarterly results');
    expect(text).not.toContain('deck.pdf');
  });
});

/* ------------------------------------------------------------------ *
 * Digitize Document: the text layer sits on the picture              *
 * ------------------------------------------------------------------ */

describe('digitize-document writes a layer where the words are', () => {
  it('keeps the scan and hides recognisable words under it', async () => {
    OCR.words = [
      { text: 'INVOICE', x: 60, y: 90, width: 120, height: 20 },
      { text: 'TOTAL', x: 60, y: 700, width: 90, height: 20 },
    ];
    const outcome = await run('digitize-document', {}, [fileFrom(realPng(600, 800), 'scan.png', 'image/png')]);
    const bytes = await firstPdf(outcome);
    const [[pageW, pageH]] = await pageSizes(bytes);
    const [placed] = await placedOn(bytes);
    expect(placed?.pixels).toEqual([600, 800]);
    expect(placed!.box[2]).toBeLessThanOrEqual(pageW);
    expect(placed!.box[3]).toBeLessThanOrEqual(pageH);
    const runs = await textRuns(bytes);
    expect(runs.map((run) => run.text).sort()).toEqual(['INVOICE', 'TOTAL']);
    // The layer is invisible so it never double-prints over the scan.
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const modes = pageContentOps(doc.getPages()[0]!)
      .filter((op) => op.name === 'Tr')
      .map((op) => op.operands.find((operand) => operand.kind === 'number') as { value: number });
    expect(modes.length).toBeGreaterThan(0);
    expect(modes.every((operand) => operand.value === 3)).toBe(true);
    // Reading order follows the page, not the recogniser’s output order: a word
    // near the top is drawn above one near the bottom.
    const invoice = find(runs, 'INVOICE')[0];
    const total = find(runs, 'TOTAL')[0];
    expect(invoice.y).toBeGreaterThan(total.y);
    expect(invoice.x).toBeGreaterThanOrEqual(placed!.box[0]);
    expect(invoice.x).toBeLessThanOrEqual(placed!.box[0] + placed!.box[2]);
    expect(outcome.message).toMatch(/2 recognised words/);
  });

  it('places a word the recogniser put outside the picture back on the page', async () => {
    OCR.words = [
      { text: 'EDGE', x: 640, y: 20, width: 80, height: 18 },
      { text: 'TOP', x: 10, y: 890, width: 60, height: 18 },
    ];
    const outcome = await run('digitize-document', {}, [fileFrom(realPng(600, 800), 'scan.png', 'image/png')]);
    const bytes = await firstPdf(outcome);
    const [[pageW, pageH]] = await pageSizes(bytes);
    const runs = await textRuns(bytes);
    // 640 + 80 runs past a 600 px picture and 890 past an 800 px one; a viewer
    // cannot select text off the sheet, so both must be brought back inside.
    for (const run of runs) {
      expect(run.x).toBeGreaterThanOrEqual(0);
      expect(run.x).toBeLessThanOrEqual(pageW);
      expect(run.y).toBeGreaterThanOrEqual(0);
      expect(run.y).toBeLessThanOrEqual(pageH);
    }
    expect(runs.length).toBe(2);
  });

  it('ships the pages without a layer when OCR is switched off', async () => {
    OCR.words = [{ text: 'SHOULD_NOT_APPEAR', x: 60, y: 90, width: 120, height: 20 }];
    const outcome = await run('digitize-document', { keepImage: false }, [
      fileFrom(realPng(300, 300), 'scan.png', 'image/png'),
    ]);
    const bytes = await firstPdf(outcome);
    expect((await imagesPerPage(bytes)).length).toBe(1);
    expect(squash(await extractText(bytes))).toBe('');
    expect(outcome.warnings.join(' ')).toMatch(/no page has a text layer/i);
  });
});
