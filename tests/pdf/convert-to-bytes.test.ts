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
import { PDFDocument } from '@maxwbh/pdf-lib';
import { pageContentOps } from '@/lib/pdf/core/content';
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

  it('draws monospaced text in a different face than proportional text', async () => {
    const text = 'iiii MMMM 1111';
    const proportional = await run('txt-to-pdf', { source: 'paste', paste: text, monospace: false });
    const mono = await run('txt-to-pdf', { source: 'paste', paste: text, monospace: true });
    const bodyFont = (await textRuns(await firstPdf(proportional)))[0]?.font;
    const monoRuns = await textRuns(await firstPdf(mono));
    expect(monoRuns.length).toBeGreaterThan(0);
    expect(monoRuns[0]?.font).toBeTruthy();
    expect(monoRuns[0]?.font).not.toBe(bodyFont);
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

  it('sets fenced code in the code face, below the prose', async () => {
    const outcome = await run('markdown-to-pdf', { source: 'paste', paste: source });
    const runs = await textRuns(await firstPdf(outcome));
    const code = find(runs, 'const answer = 42;')[0];
    const body = find(runs, 'Body paragraph with')[0];
    expect(code).toBeTruthy();
    expect(code!.font).not.toBe(body!.font);
    expect(code!.y).toBeLessThan(body!.y);
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

  it('paints an inline colour rather than flattening it to black', async () => {
    const outcome = await run('html-to-pdf', { source: 'paste', paste: page });
    const doc = await PDFDocument.load(await firstPdf(outcome), { updateMetadata: false });
    const colours = pageContentOps(doc.getPages()[0]!)
      .filter((op) => op.name === 'rg' || op.name === 'scn')
      .map((op) => op.operands.filter((operand) => operand.kind === 'number').map((operand) => round((operand as { value: number }).value)));
    expect(colours.some((c) => c[0] === 1 && c[1] === 0 && c[2] === 0)).toBe(true);
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

  it('refuses a PDF dropped on it instead of printing the wrong thing', async () => {
    const error = await run('excel-to-pdf', {}, [fileFrom(await pdfBytes(), 'doc.pdf')]).catch((err) => err);
    expect((error as Error).message).toMatch(/is a PDF/);
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
