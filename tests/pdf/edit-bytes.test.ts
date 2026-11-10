/**
 * Byte-level proof for every tool in `src/lib/pdf/tools/edit.ts` and
 * `src/lib/pdf/tools/office.ts` (worker B3, refinement pass).
 *
 * The standing complaint about this category is a tool that reports success and
 * ships a file that does not say what was promised. So almost every test here
 * ends the same way: take `outcome.outputs[0]`, reopen **those bytes** with
 * pdf-lib, and read the answer out of the document — the content stream, the
 * `/Outlines` chain, the `/PageLabels` number tree, the `/Annots` array, the
 * `/AcroForm /Fields` tree, the `/EmbeddedFiles` name tree — not out of a
 * message string. `result.message` is checked for the *numbers* it claims, never
 * for a promise it makes.
 *
 * Text is read back with `core/content`'s `textRects`, i.e. through the same
 * decoder the text editor and the redactor use, after the produced file has been
 * re-parsed from bytes. Drawing a run and then "verifying" it from the in-memory
 * document would prove nothing: the bug this file caught first was exactly that
 * — a page this app had just written came back with one character per run.
 *
 * Stubbed seams, and only these:
 * - `core/render` — jsdom has no canvas, so page rasterising is a fixed bitmap;
 *   the JPEG that gets embedded afterwards is a real JPEG.
 * - `@/lib/ocr/engine` — the recogniser is a 15 MB WASM download. Everything
 *   downstream of it (`core/ocr`'s coordinate mapping, `core/fonts` embedding,
 *   the invisible `3 Tr` layer) is the real code path.
 * - `fetch` — `core/fonts` loads its faces by URL; the vendored Latin face is
 *   served from `public/fonts/`, and the URLs asked for are recorded because
 *   "embedded Unicode font, never a WinAnsi-only path" is the project rule.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  StandardFonts,
  degrees,
  rgb,
} from '@maxwbh/pdf-lib';
import type { PDFPage } from '@maxwbh/pdf-lib';
import { pageContentStreams, textRects } from '@/lib/pdf/core/content';
import { addAnnotations, listAnnotations } from '@/lib/pdf/core/annotations';
import { clearFontCache, drawTextU } from '@/lib/pdf/core/fonts';
import { openPDF } from '@/lib/pdf/core/doc';
import { PDF_TOOLS, getPdfTool, hasCustomMainView } from '@/lib/pdf/tools/registry';
import { runPdfTool, type RunOutcome } from '@/lib/pdf/tools/runner';
import { ToolInputError } from '@/lib/pdf/core/guard';
import { editTools } from '@/lib/pdf/tools/edit';
import { legacyOfficeTools, officeTools } from '@/lib/pdf/tools/office';
import type { ToolValues } from '@/lib/pdf/tools/types';

/* ── stubbed seams ────────────────────────────────────────────────────────── */

const OCR_LINES = vi.hoisted(() => ({
  lines: [] as { text: string; y: number }[],
  failWith: null as string | null,
}));

const FONT_URLS = vi.hoisted(() => [] as string[]);

/** The page box the stubbed renderer reports, shared with the fake OCR boxes. */
const SHEET = { width: 595, height: 842 };

function sink<T>(key: string): T[] {
  const scope = globalThis as unknown as Record<string, T[]>;
  return (scope[key] ??= []);
}

const renderJobs = (): { page: number; scale: number; filter?: string }[] =>
  sink<{ page: number; scale: number; filter?: string }>('__editBytesRenders');

/** A real, decodable 1×1 JPEG — what the raster tools embed for every page. */
const JPEG_1PX = Uint8Array.from(
  atob(
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
    + 'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA'
    + 'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
  ),
  (character) => character.charCodeAt(0),
);

vi.mock('@/lib/pdf/core/render', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/pdf/core/render')>();
  const pixels = new Uint8ClampedArray(16);
  return {
    ...real,
    openRender: async (bytes: ArrayBuffer | Uint8Array) => {
      const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const doc = await PDFDocument.load(source, { updateMetadata: false });
      const pages = doc.getPages();
      return {
        doc: {},
        numPages: pages.length,
        fingerprint: 'edit-bytes-session',
        page: async (n: number) => {
          const page = pages[Math.min(Math.max(0, n - 1), pages.length - 1)];
          return {
            view: [0, 0, page?.getWidth() ?? SHEET.width, page?.getHeight() ?? SHEET.height],
            rotate: 0,
            getViewport: ({ scale = 1 }: { scale?: number } = {}) => ({
              width: (page?.getWidth() ?? SHEET.width) * scale,
              height: (page?.getHeight() ?? SHEET.height) * scale,
              scale,
            }),
          };
        },
        // No existing text layer: every page in these fixtures is a scan as far
        // as `core/ocr` is concerned, unless a test says otherwise.
        textItems: async () => [],
        textContent: async () => ({ items: [] }),
        renderPage: async (n: number, scale: number, options: { filter?: string } = {}) => {
          renderJobs().push({ page: n, scale, filter: options.filter });
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(SHEET.width * scale);
          canvas.height = Math.round(SHEET.height * scale);
          return {
            canvas,
            ctx: {
              getImageData: () => ({ data: pixels, width: canvas.width, height: canvas.height }),
              putImageData: () => undefined,
            } as unknown as CanvasRenderingContext2D,
            width: canvas.width,
            height: canvas.height,
            unitsPerPixel: 1 / scale,
            pageNumber: n,
            cancel: () => undefined,
          };
        },
        metadata: async () => ({ numPages: pages.length }),
        attachments: async () => ({}),
        destroy: async () => undefined,
      } as unknown as Awaited<ReturnType<typeof real.openRender>>;
    },
    canvasToBlob: async () => new Blob([JPEG_1PX as BlobPart], { type: 'image/jpeg' }),
  };
});

/** The recogniser: boxes come back in raster pixels, as the engine contract says. */
vi.mock('@/lib/ocr/engine', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/ocr/engine')>();
  return {
    ...real,
    initOcr: async () => {
      if (OCR_LINES.failWith) throw new Error(OCR_LINES.failWith);
    },
    recognizeCanvas: async (canvas: HTMLCanvasElement) => {
      if (OCR_LINES.failWith) throw new Error(OCR_LINES.failWith);
      const width = canvas.width || Math.round(SHEET.width * 4);
      const height = canvas.height || Math.round(SHEET.height * 4);
      return {
        text: OCR_LINES.lines.map((line) => line.text).join('\n'),
        results: OCR_LINES.lines.map((line) => ({
          text: line.text,
          box: {
            x: 0.1 * width,
            y: (line.y / SHEET.height) * height,
            width: 0.7 * width,
            height: (20 / SHEET.height) * height,
          },
          confidence: 0.93,
        })),
      };
    },
  };
});

beforeAll(() => {
  const face = (file: string): Uint8Array =>
    new Uint8Array(readFileSync(join(process.cwd(), 'public', 'fonts', file)));
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    FONT_URLS.push(url);
    const local = /NotoSans-(Regular|Bold)\.ttf$/.exec(url);
    return new Response(face(local ? local[0] : 'NotoSans-Regular.ttf'), {
      headers: { 'content-type': 'font/ttf' },
    });
  }) as typeof fetch;
});

const realFetch = globalThis.fetch;

afterAll(() => {
  globalThis.fetch = realFetch;
});

afterEach(() => {
  OCR_LINES.lines = [];
  OCR_LINES.failWith = null;
  renderJobs().length = 0;
  FONT_URLS.length = 0;
  // The fetched faces are cached for the life of a tab, so without this the first
  // CJK test would answer every later one's "which URL did it ask for" from the
  // cache and record nothing.
  clearFontCache();
});

/* ── fixtures and driving a tool ──────────────────────────────────────────── */

const A4: [number, number] = [595.28, 841.89];

interface PageSpec {
  size?: [number, number];
  rotation?: number;
  /** Written with a standard-14 face, so the text is real, selectable content. */
  text?: string;
  /** The colour the fixture paints that text with; black unless a test says so. */
  color?: string;
}

/** `#rrggbb` for a fixture page's own text. */
function fixtureColor(hex: string | undefined) {
  const parts = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex ?? '');
  if (!parts) return rgb(0, 0, 0);
  return rgb(
    Number.parseInt(parts[1], 16) / 255,
    Number.parseInt(parts[2], 16) / 255,
    Number.parseInt(parts[3], 16) / 255,
  );
}

/**
 * A fixture page, written the way the app writes its own text: a standard-14
 * face when the string fits WinAnsi, an embedded Unicode face when it does not
 * (`内容` cannot be handed to Helvetica at all — `page.drawText` throws).
 */
async function pdfFixture(pages: PageSpec[], title = 'Edit bytes'): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const spec of pages) {
    const size = spec.size ?? A4;
    const page = doc.addPage(size);
    if (spec.rotation) page.setRotation(degrees(spec.rotation));
    if (spec.text) {
      await drawTextU(page, {
        text: spec.text,
        x: 40,
        y: size[1] - 60,
        size: 14,
        color: fixtureColor(spec.color),
      });
    }
  }
  doc.setTitle(title);
  return doc.save({ useObjectStreams: false });
}

function pdfFile(bytes: Uint8Array, name: string): File {
  // SAFETY: a copy of the bytes is a valid BlobPart.
  return new File([new Uint8Array(bytes) as BlobPart], name, { type: 'application/pdf' });
}

function anyFile(bytes: Uint8Array | string, name: string, type: string): File {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  return new File([new Uint8Array(data) as BlobPart], name, { type });
}

async function run(
  id: string,
  values: ToolValues = {},
  files?: File[],
): Promise<RunOutcome> {
  const tool = getPdfTool(id);
  expect(tool, `tool "${id}" is not registered`).toBeTruthy();
  const inputs = files ?? [pdfFile(await pdfFixture([{ text: 'Body text' }]), 'fixture.pdf')];
  const outcome = await runPdfTool({
    toolId: id,
    files: Array.isArray(inputs) ? (inputs as File[]) : [inputs as File],
    values,
    onProgress: () => undefined,
    onLog: () => undefined,
  });
  expect(outcome, `${id} produced no outcome`).toBeTruthy();
  return outcome!;
}

async function runPdf(id: string, values: ToolValues = {}, pages: PageSpec[] = [{ text: 'Body text' }]): Promise<RunOutcome> {
  return run(id, values, [pdfFile(await pdfFixture(pages), 'fixture.pdf')]);
}

async function outBytes(outcome: RunOutcome, index = 0): Promise<Uint8Array> {
  expect(outcome.outputs.length, 'expected a downloadable output').toBeGreaterThan(index);
  return new Uint8Array(await outcome.outputs[index].blob.arrayBuffer());
}

async function reopen(outcome: RunOutcome, index = 0): Promise<PDFDocument> {
  return openPDF(await outBytes(outcome, index));
}

/* ── reading the produced bytes back ──────────────────────────────────────── */

/** Every selectable run on a page, in draw order, decoded from its own bytes. */
function pageRuns(page: PDFPage): { text: string; rect: { x: number; y: number; width: number; height: number } }[] {
  return textRects(page);
}

async function pageText(page: PDFPage): Promise<string> {
  return pageRuns(page).map((run) => run.text).join(' ');
}

function streamText(page: PDFPage): string {
  return pageContentStreams(page)
    .map((stream) => Buffer.from(stream.bytes).toString('latin1'))
    .join('\n');
}

function dictOf(doc: PDFDocument, value: unknown): PDFDict | undefined {
  const resolved = value instanceof PDFRef ? doc.context.lookup(value) : value;
  // A stream object (an image `/XObject`, an appearance, a `/ToUnicode` CMap) is
  // not a `PDFDict` in pdf-lib: the dictionary describing it is `stream.dict`.
  if (resolved instanceof PDFStream) return resolved.dict;
  return resolved instanceof PDFDict ? resolved : undefined;
}

function arrayOf(doc: PDFDocument, value: unknown): PDFArray | undefined {
  const resolved = value instanceof PDFRef ? doc.context.lookup(value) : value;
  return resolved instanceof PDFArray ? resolved : undefined;
}

/** A PDF text string (literal, hex, UTF-16BE or one-byte) decoded to text. */
function decodeTextString(value: unknown): string | undefined {
  if (value && typeof value === 'object' && 'decodeText' in value) {
    return (value as { decodeText: () => string }).decodeText();
  }
  return undefined;
}

/** The index of the page a `/Dest` target refers to, or -1. */
function destPageIndex(doc: PDFDocument, dest: unknown): number {
  const list = arrayOf(doc, dest);
  const first = list ? list.get(0) : undefined;
  if (!(first instanceof PDFRef)) return -1;
  return doc.getPages().findIndex((page) => page.ref.toString() === first.toString());
}

/** `/MediaBox` and `/Rotate`, read from the produced file rather than the live doc. */
function groupBox(page: PDFPage) {
  const box = arrayOf(page.doc, page.node.get(PDFName.of('MediaBox')))
    ?? arrayOf(page.doc, page.node.get(PDFName.of('CropBox')));
  const values = (box?.asArray() ?? []).map((value) => (value instanceof PDFNumber ? value.asNumber() : 0));
  const [left = 0, bottom = 0, right = 0, top = 0] = values;
  return {
    x: left,
    y: bottom,
    width: right - left,
    height: top - bottom,
    rotation: Math.round(page.getRotation().angle),
  };
}

/** Which font each run was drawn with, by resource name. */
function runFonts(page: PDFPage): string[] {
  const doc = page.doc;
  const resources = dictOf(doc, page.node.get(PDFName.of('Resources')));
  const fonts = dictOf(doc, resources?.get(PDFName.of('Font')));
  const base = new Map<string, string>();
  for (const [name, value] of fonts?.entries() ?? []) {
    const dict = dictOf(doc, value);
    const face = dict?.lookupMaybe(PDFName.of('BaseFont'), PDFName)?.asString() ?? '';
    // `/BaseFont` is a name, so the slash comes along; drop it (and any subset
    // prefix) to leave the face a reader would report.
    base.set(name.asString().replace(/^\//, ''), face.replace(/^\//, '').replace(/^[A-Za-z0-9]{6}\+/, ''));
  }
  return [...base.values()];
}

/* ══════════════════════════════════════════════════════════════════════════
 * edit.ts — the marks that are drawn into the page
 * ════════════════════════════════════════════════════════════════════════ */

describe('page-numbers writes real folios', () => {
  it('draws the number on the selected pages and nowhere else', async () => {
    const outcome = await runPdf(
      'page-numbers',
      { pages: '1-2', prefix: '', suffix: '', startAt: 7, position: 'bottom-center' },
      [{ text: 'one' }, { text: 'two' }, { text: 'three' }],
    );
    const doc = await reopen(outcome);
    const folios = await Promise.all(doc.getPages().map(pageText));
    expect(folios[0]).toContain('7');
    expect(folios[1]).toContain('8');
    expect(folios[2]).toBe('three');
    // The original content survives: numbering adds, it does not replace.
    expect(pageRuns(doc.getPages()[0]).length).toBeGreaterThan(1);
  });

  it('expands {page} and {total} against the pages it actually numbered', async () => {
    const outcome = await runPdf('page-numbers', { pages: 'all', prefix: '', suffix: ' of {total}' }, [
      { text: 'a' },
      { text: 'b' },
      { text: 'c' },
    ]);
    const doc = await reopen(outcome);
    const texts = await Promise.all(doc.getPages().map(pageText));
    expect(texts.map((text) => /\d+ of 3/.exec(text)?.[0])).toEqual(['1 of 3', '2 of 3', '3 of 3']);
  });

  it('draws roman and letter styles as text, in the face the picker chose', async () => {
    const outcome = await runPdf('page-numbers', { pages: 'all', style: 'roman-upper', prefix: '', suffix: '', font: 'std:times' }, [
      { text: 'a' },
      { text: 'b' },
      { text: 'c' },
    ]);
    const doc = await reopen(outcome);
    const texts = await Promise.all(doc.getPages().map(pageText));
    // Every page carries its own fixture word as well as the folio, so the word
    // is dropped per page before the folio is read out of the bytes.
    expect(texts.map((text, index) => text.replace('abc'[index], '').trim())).toEqual(['I', 'II', 'III']);
    expect(runFonts(doc.getPages()[0])).toContain('Times-Roman');
  });

  it('keeps CJK folios as embedded glyphs instead of blanks', async () => {
    const outcome = await runPdf('page-numbers', { pages: '1', prefix: '第 ', suffix: ' 頁', font: 'std:helvetica' });
    const doc = await reopen(outcome);
    const text = await pageText(doc.getPages()[0]);
    expect(text).toContain('第 1 頁');
    // Helvetica cannot encode CJK: the run must have gone to the Unicode face.
    expect(FONT_URLS.some((url) => /NotoSans/.test(url))).toBe(true);
    expect(outcome.warnings.join(' ')).toMatch(/Latin-only/u);
  });
});

describe('watermark paints into the page', () => {
  it('stamps the text on every selected page as extractable content', async () => {
    const outcome = await runPdf('watermark', { type: 'text', text: 'CONFIDENTIAL', pages: 'all', tile: false }, [
      { text: 'a' },
      { text: 'b' },
    ]);
    const doc = await reopen(outcome);
    for (const page of doc.getPages()) {
      expect(await pageText(page)).toContain('CONFIDENTIAL');
    }
  });

  it('turns the page content stream into the second draw when placed behind', async () => {
    const outcome = await runPdf('watermark', { type: 'text', text: 'UNDER', layer: 'under', pages: '1' });
    const doc = await reopen(outcome);
    const page = doc.getPages()[0];
    const streams = pageContentStreams(page);
    expect(streams.length).toBeGreaterThan(1);
    const order = streams.map((stream) => Buffer.from(stream.bytes).toString('latin1'));
    expect(order[0]).toContain('UNDER'.length ? 'Tj' : '');
    expect(order[0].indexOf('BT')).toBeLessThan(order[order.length - 1].indexOf('BT'));
    // Both the mark and the original text are still selectable.
    const text = await pageText(page);
    expect(text).toContain('Body text');
  });

  it('embeds an image watermark as a real image XObject', async () => {
    const png = Uint8Array.from(
      atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
      (character) => character.charCodeAt(0),
    );
    const file = pdfFile(await pdfFixture([{ text: 'a' }]), 'doc.pdf');
    const values: ToolValues = {
      type: 'image',
      image: [{ name: 'mark.png', size: png.length, type: 'image/png', bytes: png }],
    };
    const outcome = await run('watermark', values, [file]);
    const doc = await reopen(outcome);
    const resources = dictOf(doc, doc.getPages()[0].node.get(PDFName.of('Resources')));
    const xobjects = dictOf(doc, resources?.get(PDFName.of('XObject')));
    const images = [...(xobjects?.entries() ?? [])].filter(([, value]) => {
      const dict = dictOf(doc, value);
      return dict?.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString() === '/Image';
    });
    expect(images.length).toBe(1);
  });

  it('reports the tile cap instead of drawing forever', async () => {
    const outcome = await runPdf('watermark', { type: 'text', text: 'X', tile: true, tileGap: 0.2, fontSize: 6 });
    const doc = await reopen(outcome);
    const marks = pageRuns(doc.getPages()[0]).filter((run) => run.text === 'X');
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.length).toBeLessThanOrEqual(400);
    expect(outcome.warnings.join(' ')).toMatch(/limited to 400/u);
  });
});

describe('header-footer fills its six slots per page', () => {
  it('expands the tokens and draws the slots it declares', async () => {
    const outcome = await runPdf(
      'header-footer',
      {
        headerLeft: 'ACME',
        headerCenter: '{title}',
        headerRight: '',
        footerLeft: '{author}',
        footerCenter: '',
        footerRight: 'Page {page} of {total}',
        rule: true,
      },
      [{ text: 'a' }, { text: 'b' }],
    );
    const doc = await reopen(outcome);
    const first = await pageText(doc.getPages()[0]);
    const second = await pageText(doc.getPages()[1]);
    expect(first).toContain('ACME');
    expect(first).toContain('Edit bytes');
    expect(first).toContain('Page 1 of 2');
    expect(second).toContain('Page 2 of 2');
    // The hairline rule is a real path operator, drawn once per row per page.
    const stream = streamText(doc.getPages()[0]);
    expect((stream.match(/ m\n?[\d.-]+ [\d.-]+ l S/g) ?? stream.match(/ l S/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('reports a header that cannot fit the page instead of overlapping silently', async () => {
    const outcome = await runPdf(
      'header-footer',
      {
        headerLeft: 'a very long running head that will not fit',
        headerCenter: 'another long block of text',
        headerRight: 'and a third',
        fontSize: 20,
        rule: false,
      },
      [{ size: [200, 120], text: 'card' }],
    );
    expect(outcome.warnings.join(' ')).toMatch(/wider than a 200 pt page/u);
  });
});

describe('bates-numbering counts what it stamped', () => {
  it('runs one sequence across two documents and writes it into both', async () => {
    const files = [
      pdfFile(await pdfFixture([{ text: 'a' }, { text: 'b' }], 'First'), 'first.pdf'),
      pdfFile(await pdfFixture([{ text: 'c' }], 'Second'), 'second.pdf'),
    ];
    const outcome = await run('bates-numbering', { format: '{prefix}-{n}', prefix: 'ACME', digits: 4 }, files);
    expect(outcome.outputs.length).toBe(2);
    const one = await reopen(outcome, 0);
    const two = await reopen(outcome, 1);
    expect(await pageText(one.getPages()[0])).toContain('ACME-0001');
    expect(await pageText(one.getPages()[1])).toContain('ACME-0002');
    expect(await pageText(two.getPages()[0])).toContain('ACME-0003');
  });

  it('restarts inside every file when asked, and admits the last number of each', async () => {
    const files = [
      pdfFile(await pdfFixture([{ text: 'a' }, { text: 'b' }]), 'one.pdf'),
      pdfFile(await pdfFixture([{ text: 'c' }, { text: 'd' }]), 'two.pdf'),
    ];
    const outcome = await run(
      'bates-numbering',
      { format: '{n}', digits: 3, start: 1, perFile: true },
      files,
    );
    const one = await reopen(outcome, 0);
    const two = await reopen(outcome, 1);
    expect(await pageText(one.getPages()[0])).toContain('001');
    expect(await pageText(two.getPages()[0])).toContain('001');
    expect(await pageText(two.getPages()[1])).toContain('002');
    const admitted = outcome.warnings.join(' ');
    // With per-file restarts the last number written is the last page of the
    // last file, not the batch total — the sentence used to claim 004 here.
    expect(admitted).toMatch(/last number written was 002/u);
    expect(admitted).not.toMatch(/last number written was 00[34]/u);
  });
});

describe('add-page-labels writes the /PageLabels dictionary', () => {
  /** The raw `/Nums` pairs of the produced file, decoded. */
  async function labelRanges(outcome: RunOutcome) {
    const doc = await reopen(outcome);
    const root = arrayOf(doc, doc.catalog.lookupMaybe(PDFName.of('PageLabels'), PDFDict)?.get(PDFName.of('Nums')));
    const ranges: { start: number; style?: string; prefix?: string; first?: number }[] = [];
    for (let i = 0; root && i + 1 < root.size(); i += 2) {
      const start = (root.get(i) as PDFNumber).asNumber();
      const dict = dictOf(doc, root.get(i + 1));
      if (!dict) continue;
      ranges.push({
        start,
        style: dict.lookupMaybe(PDFName.of('S'), PDFName)?.asString(),
        prefix: decodeTextString(dict.get(PDFName.of('P'))),
        first: dict.lookupMaybe(PDFName.of('St'), PDFNumber)?.asNumber(),
      });
    }
    return ranges;
  }

  it('keeps the case of the documented style names', async () => {
    const outcome = await runPdf('add-page-labels', { ranges: '1-2 Roman 1\n3-4 Alpha 1' }, [
      { text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' },
    ]);
    const ranges = await labelRanges(outcome);
    expect(ranges.map((range) => range.style)).toEqual(['/R', '/A']);
  });

  it('carries a prefix and a start number into the dictionary', async () => {
    const outcome = await runPdf('add-page-labels', { ranges: '1-4 decimal 5 DOC' }, [{ text: 'a' }, { text: 'b' }]);
    const ranges = await labelRanges(outcome);
    expect(ranges[0]).toMatchObject({ start: 0, style: '/D', first: 5, prefix: 'DOC' });
  });

  it('says when a typed range runs longer than the document', async () => {
    const outcome = await runPdf('add-page-labels', { ranges: '1-3 roman 1' }, [{ text: 'a' }, { text: 'b' }]);
    expect(outcome.warnings.join(' ')).toMatch(/run to page 2, not page 3/u);
  });
});

describe('bookmarks write an outline that lands on the right page', () => {
  /** Walk `/Outlines` from the bytes: titles plus the page each `/Dest` names. */
  async function outlineFromBytes(outcome: RunOutcome) {
    const doc = await reopen(outcome);
    const root = dictOf(doc, doc.catalog.get(PDFName.of('Outlines')));
    expect(root, 'the output carries no /Outlines').toBeTruthy();
    const out: { title: string; page: number; children: number }[] = [];
    const walk = (item: unknown, depth: number): void => {
      const dict = dictOf(doc, item);
      if (!dict) return;
      out.push({
        title: decodeTextString(dict.get(PDFName.of('Title'))) ?? '',
        page: destPageIndex(doc, dict.get(PDFName.of('Dest'))),
        children: depth,
      });
      const first = dict.get(PDFName.of('First'));
      if (!first) return;
      let sibling: unknown = first;
      while (sibling) {
        walk(sibling, depth + 1);
        const next = dictOf(doc, sibling)?.get(PDFName.of('Next'));
        sibling = next;
      }
    };
    const first = root?.get(PDFName.of('First'));
    let node: unknown = first;
    while (node) {
      walk(node, 0);
      node = dictOf(doc, node)?.get(PDFName.of('Next'));
    }
    return out;
  }

  it('writes the titles, nesting and destinations it was given', async () => {
    const outcome = await runPdf(
      'bookmarks',
      { outline: 'Chapter One :: 1\n  Section A :: 2\nChapter Two :: 3', replace: true },
      [{ text: 'a' }, { text: 'b' }, { text: 'c' }],
    );
    const entries = await outlineFromBytes(outcome);
    expect(entries.map((entry) => entry.title)).toEqual(['Chapter One', 'Section A', 'Chapter Two']);
    expect(entries.map((entry) => entry.page)).toEqual([0, 1, 2]);
    expect(entries.map((entry) => entry.children)).toEqual([0, 1, 0]);
  });

  it('appends below the outline that exists when asked to', async () => {
    const fixture = pdfFile(await pdfFixture([{ text: 'a' }, { text: 'b' }]), 'fixture.pdf');
    const first = await run('bookmarks', { outline: 'One :: 1', replace: true }, [fixture]);
    expect((await outlineFromBytes(first)).length).toBe(1);
    const appended = await run('bookmarks', { outline: 'Two :: 2', replace: false }, [
      pdfFile(await outBytes(first), 'fixture.pdf'),
    ]);
    const entries = await outlineFromBytes(appended);
    expect(entries.map((entry) => entry.title)).toEqual(['One', 'Two']);
    expect(entries.map((entry) => entry.page)).toEqual([0, 1]);
    // The report counts every entry it found, not just the top level.
    expect(appended.message).toMatch(/after the 1 existing outline/u);
  });

  it('admits an entry whose page is past the end of the document', async () => {
    const outcome = await runPdf('bookmarks', { outline: 'Real :: 1\nGhost :: 9' });
    const entries = await outlineFromBytes(outcome);
    expect(entries.map((entry) => entry.page)).toEqual([0, -1]);
    expect(outcome.warnings.join(' ')).toMatch(/outside this 1-page document/u);
  });
});

describe('table-of-contents inserts a contents page that still points correctly', () => {
  it('draws the entries, links them, and moves the bookmarks it pushed down', async () => {
    const fixture = pdfFile(await pdfFixture([{ text: 'a' }, { text: 'b' }, { text: 'c' }]), 'fixture.pdf');
    const marked = await run('bookmarks', { outline: 'Alpha :: 2\nBeta :: 3', replace: true }, [fixture]);
    const outcome = await run('table-of-contents', { insertAt: 1, title: 'Contents' }, [
      pdfFile(await outBytes(marked), 'fixture.pdf'),
    ]);
    const doc = await reopen(outcome);
    expect(doc.getPageCount()).toBe(4);
    const toc = doc.getPages()[0];
    const text = await pageText(toc);
    expect(text).toContain('Contents');
    expect(text).toContain('Alpha');
    // With one page inserted ahead of them, Alpha is page 3 and Beta page 4.
    expect(text).toMatch(/Alpha[\s\S]*3/u);
    const annots = arrayOf(doc, toc.node.get(PDFName.of('Annots')));
    expect(annots?.size()).toBe(2);
    const links = (annots?.asArray() ?? []).map((value) => dictOf(doc, value));
    expect(links.every((link) => link?.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString() === '/Link')).toBe(true);
    const targets = links.map((link) => {
      const action = dictOf(doc, link?.get(PDFName.of('A')));
      const dest = action?.get(PDFName.of('D')) ?? action?.get(PDFName.of('Dest'));
      return destPageIndex(doc, dest);
    });
    expect(targets).toEqual([2, 3]);
    // The outline was renumbered with the pages, so bookmarks still land right.
    const root = dictOf(doc, doc.catalog.get(PDFName.of('Outlines')));
    const first = dictOf(doc, root?.get(PDFName.of('First')));
    expect(destPageIndex(doc, first?.get(PDFName.of('Dest')))).toBe(2);
  });

  it('refuses to invent a contents page for a document with no outline', async () => {
    await expect(runPdf('table-of-contents', {})).rejects.toThrow(/no bookmarks/iu);
  });
});

describe('add-stamps writes standard annotations', () => {
  it('places a named Stamp annotation with an appearance on each page', async () => {
    const outcome = await runPdf(
      'add-stamps',
      { stamp: 'APPROVED', pages: '1-2', position: 'top-right', width: 120 },
      [{ text: 'a' }, { text: 'b' }],
    );
    const doc = await reopen(outcome);
    const marks = listAnnotations(doc);
    expect(marks.length).toBe(2);
    for (const mark of marks) {
      expect(mark.kind).toMatch(/stamp/iu);
    }
    const annots = arrayOf(doc, doc.getPages()[0].node.get(PDFName.of('Annots')));
    const first = dictOf(doc, annots?.get(0));
    expect(first?.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString()).toBe('/Stamp');
    expect(dictOf(doc, first?.get(PDFName.of('AP')))).toBeTruthy();
  });

  it('embeds a custom image as the stamp appearance', async () => {
    const png = Uint8Array.from(
      atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
      (character) => character.charCodeAt(0),
    );
    const outcome = await run('add-stamps', {
      stamp: 'custom',
      image: [{ name: 'seal.png', size: png.length, type: 'image/png', bytes: png }],
      pages: '1',
    }, [pdfFile(await pdfFixture([{ text: 'a' }]), 'doc.pdf')]);
    const doc = await reopen(outcome);
    const annots = arrayOf(doc, doc.getPages()[0].node.get(PDFName.of('Annots')));
    const first = dictOf(doc, annots?.get(0));
    const appearance = dictOf(doc, first?.get(PDFName.of('AP')));
    const stream = appearance && doc.context.lookup(appearance.get(PDFName.of('N')));
    expect(stream).toBeTruthy();
    const resources = dictOf(doc, (stream as PDFStream).dict.get(PDFName.of('Resources')));
    const xobjects = dictOf(doc, resources?.get(PDFName.of('XObject')));
    const image = xobjects && dictOf(doc, [...xobjects.entries()][0]?.[1]);
    expect(image?.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString()).toBe('/Image');
  });
});

describe('background-color paints an artifact under the page', () => {
  it('prepends a tagged background without rewriting the page text', async () => {
    const outcome = await runPdf('background-color', { color: '#f7f7f4', pages: '1' });
    const doc = await reopen(outcome);
    const page = doc.getPages()[0];
    const streams = pageContentStreams(page);
    expect(streams.length).toBeGreaterThan(1);
    const head = Buffer.from(streams[0].bytes).toString('latin1');
    expect(head).toContain('/Artifact');
    expect(head).toContain('/Background');
    expect(head).toContain(' BDC');
    expect(head).toContain('EMC');
    expect(head).toMatch(/[\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+ re/);
    // The claim in the promise: extraction still sees the page's own words.
    expect(await pageText(page)).toContain('Body text');
    expect(outcome.message).toMatch(/Painted a #f7f7f4 background/u);
  });

  it('leaves a page with an empty crop box alone and says so', async () => {
    const bytes = await pdfFixture([{ text: 'a' }]);
    const doc = await openPDF(bytes);
    const page = doc.getPages()[0];
    page.node.set(PDFName.of('CropBox'), doc.context.obj([]));
    const edited = await outBytes(await run('background-color', { pages: 'all' }, [pdfFile(await doc.save({ useObjectStreams: false }), 'flat.pdf')]));
    const reloaded = await openPDF(edited);
    const stream = streamText(reloaded.getPages()[0]);
    expect(stream).not.toContain('/Artifact');
  });
});

describe('text-color rewrites colour operators, not pixels', () => {
  it('changes the colour in front of the text and keeps the run selectable', async () => {
    const outcome = await runPdf('text-color', { to: '#ff0000', from: 'any', pages: 'all' }, [
      { text: 'Body text' },
    ]);
    const doc = await reopen(outcome);
    const stream = streamText(doc.getPages()[0]);
    expect(stream).toMatch(/1 0 0 rg/);
    expect(await pageText(doc.getPages()[0])).toContain('Body text');
    expect(outcome.message).toMatch(/Recoloured 1 text run/u);
  });

  it('names the pages where nothing matched when some did', async () => {
    const outcome = await runPdf('text-color', { to: '#0000ff', from: '#000000', pages: 'all' }, [
      { text: 'black words here' },
      // Painted a near-black, which the field help says is not the colour being
      // replaced — that is what makes this a partial match rather than a full one.
      { text: 'another dark line', color: '#1a1a1a' },
    ]);
    const doc = await reopen(outcome);
    expect(streamText(doc.getPages()[0])).toMatch(/0 0 1 rg/);
    expect(outcome.warnings.join(' ')).toMatch(/page 2/u);
  });

  it('reports a scan with no colour operators instead of claiming a change', async () => {
    const outcome = await runPdf('text-color', { to: '#00ff00', from: '#ff0000', pages: 'all' }, [{ text: 'plain' }]);
    expect(outcome.outputs.length).toBe(0);
    expect(outcome.message).toMatch(/file is unchanged/u);
  });
});

describe('the raster colour tools rebuild the pages they render', () => {
  for (const [id, values] of [
    ['invert-colors', { pages: 'all' }] as const,
    ['adjust-colors', { pages: 'all', threshold: 0.5 }] as const,
    ['scanner-effect', { pages: 'all' }] as const,
  ]) {
    it(`${id} writes one image page per selected page and no selectable text`, async () => {
      const outcome = await runPdf(id, values as ToolValues, [{ text: 'a' }, { text: 'b' }]);
      const doc = await reopen(outcome);
      expect(doc.getPageCount()).toBe(2);
      for (const page of doc.getPages()) {
        const box = groupBox(page);
        expect(Math.round(box.width)).toBe(595);
        expect(Math.round(box.height)).toBe(842);
        expect(await pageText(page)).toBe('');
        const resources = dictOf(doc, page.node.get(PDFName.of('Resources')));
        const xobjects = dictOf(doc, resources?.get(PDFName.of('XObject')));
        const images = [...(xobjects?.entries() ?? [])].filter(([, value]) => {
          const dict = dictOf(doc, value);
          return dict?.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString() === '/Image';
        });
        expect(images.length).toBe(1);
      }
      expect(streamText(doc.getPages()[0])).toContain('Do');
    });
  }

  it('passes the pixel passes it advertises down to the canvas', async () => {
    await runPdf('adjust-colors', { pages: '1', grayscale: true, saturation: 2, brightness: 1.4 });
    const job = renderJobs()[0];
    expect(job?.filter).toMatch(/grayscale\(1\)/);
    expect(job?.filter).toMatch(/brightness\(1\.4\)/);
    // Greyscale wins over the saturation slider, exactly as the help says.
    expect(job?.filter).not.toMatch(/saturate\(2\)/);
  });

  it('warns that pages outside the selection are not in the output', async () => {
    const outcome = await runPdf('scanner-effect', { pages: '1' }, [{ text: 'a' }, { text: 'b' }, { text: 'c' }]);
    expect(outcome.warnings.join(' ')).toMatch(/2 pages outside your selection are not in the output/u);
  });
});

describe('ocr-pdf puts the recognised words into the file', () => {
  it('writes an invisible layer whose text reads back from the bytes', async () => {
    OCR_LINES.lines = [
      { text: 'invoice number nine', y: 120 },
      { text: 'total due 42', y: 200 },
    ];
    const scanned = pdfFile(await pdfFixture([{ text: '' }]), 'scan.pdf');
    const outcome = await run('ocr-pdf', { mode: 'searchable', pages: 'all', language: 'en' }, [scanned]);
    const doc = await reopen(outcome);
    const page = doc.getPages()[0];
    const text = await pageText(page);
    expect(text).toContain('invoice');
    expect(text).toContain('number');
    expect(text).toContain('nine');
    expect(text).toContain('total');
    expect(text).toContain('42');
    // Invisible: render mode 3, so the scan looks exactly as it did.
    expect(streamText(page)).toContain('3 Tr');
    expect(outcome.message).toMatch(/invisible layer/u);
  });

  it('honours "replace the page with text" and says the pictures are gone', async () => {
    OCR_LINES.lines = [{ text: 'rebuild me as text', y: 150 }];
    const scanned = pdfFile(await pdfFixture([{ text: '' }, { text: '' }]), 'scan.pdf');
    const outcome = await run('ocr-pdf', { mode: 'replace', pages: 'all' }, [scanned]);
    const doc = await reopen(outcome);
    expect(doc.getPageCount()).toBe(2);
    expect(await pageText(doc.getPages()[0])).toContain('rebuild me as text');
    expect(outcome.message).toMatch(/original page images were replaced/u);
  });

  it('names the recogniser when the engine cannot run, not a fake success', async () => {
    OCR_LINES.failWith = 'the ONNX model could not be fetched';
    await expect(runPdf('ocr-pdf', { pages: '1' })).rejects.toThrow(/recogniser could not run/iu);
  });

  it('says so when nothing was readable instead of shipping the file back', async () => {
    OCR_LINES.lines = [{ text: '   ', y: 100 }];
    const outcome = await run('ocr-pdf', { mode: 'searchable', pages: '1' }, [
      pdfFile(await pdfFixture([{ text: '' }]), 'blank.pdf'),
    ]);
    expect(outcome.outputs.length).toBe(0);
    expect(outcome.message).toMatch(/No text was recognised/u);
    expect(outcome.warnings.join(' ')).toMatch(/yielded no text at all/u);
  });
});

describe('form-creator and form-filler round-trip through a second read', () => {
  const specs = [
    { type: 'text', name: 'applicantName', rect: { x: 60, y: 700, width: 220, height: 20 }, label: 'Applicant name', multiline: true },
    { type: 'checkbox', name: 'agree', rect: { x: 60, y: 660, width: 14, height: 14 } },
    { type: 'dropdown', name: 'country', rect: { x: 60, y: 620, width: 200, height: 20 }, options: ['France', 'Japan'] },
    { type: 'list', name: 'languages', rect: { x: 60, y: 540, width: 200, height: 70 }, options: ['PDF', 'Cairo'] },
    { type: 'radio', name: 'tier', rect: { x: 60, y: 440, width: 16, height: 40 }, options: ['Gold', 'Silver'] },
  ];

  it('writes fields of the right type, with widgets on the right page', async () => {
    const outcome = await runPdf('form-creator', { fieldSpecs: specs });
    const doc = await reopen(outcome);
    const form = doc.getForm();
    expect(form.getFields().map((field) => field.getName())).toEqual(
      specs.map((spec) => spec.name.trim()),
    );
    const kinds = form.getFields().map((field) => field.constructor.name);
    expect(kinds).toEqual(['PDFTextField', 'PDFCheckBox', 'PDFDropdown', 'PDFOptionList', 'PDFRadioGroup']);
    const annots = arrayOf(doc, doc.getPages()[0].node.get(PDFName.of('Annots')));
    // One widget per checkbox/dropdown/list/text, one per radio option.
    expect(annots?.size()).toBe(6);
    const widget = dictOf(doc, annots?.get(0));
    expect(widget?.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString()).toBe('/Widget');
    const rect = arrayOf(doc, widget?.get(PDFName.of('Rect')));
    expect((rect?.get(1) as PDFNumber).asNumber()).toBeCloseTo(700, 3);
  });

  it('keeps the field values, options and flags in the saved file', async () => {
    const created = await runPdf('form-creator', {
      fieldSpecs: [
        // `multiline` is what the flags below read back, so the spec has to ask for it.
        { type: 'text', name: 'notes', rect: { x: 60, y: 700, width: 200, height: 20 }, value: 'typed in', required: true, multiline: true },
        { type: 'checkbox', name: 'sent', rect: { x: 60, y: 660, width: 14, height: 14 }, value: 'true' },
        { type: 'dropdown', name: 'country', rect: { x: 60, y: 620, width: 160, height: 20 }, options: ['France', 'Japan'], value: 'Japan' },
      ],
    });
    const doc = await reopen(created);
    const form = doc.getForm();
    expect((form.getField('notes') as unknown as { getText: () => string }).getText()).toBe('typed in');
    const multilineFlags = dictOf(doc, (form.getField('notes') as unknown as { acroField: { dict: PDFDict } }).acroField.dict)
      ?.lookupMaybe(PDFName.of('Ff'), PDFNumber)?.asNumber() ?? 0;
    expect(multilineFlags & 4096).toBe(4096);
    const dropdown = form.getField('country') as unknown as { getOptions: () => string[]; getSelected: () => string[] };
    expect(dropdown.getOptions()).toEqual(['France', 'Japan']);
    expect(dropdown.getSelected()).toEqual(['Japan']);
    const required = dictOf(doc, (form.getField('notes') as unknown as { acroField: { dict: PDFDict } }).acroField.dict)
      ?.lookupMaybe(PDFName.of('Ff'), PDFNumber)?.asNumber() ?? 0;
    expect(required & 2).toBe(2);
    const sent = form.getField('sent') as unknown as { isChecked: () => boolean };
    expect(sent.isChecked()).toBe(true);
  });

  it('fills a form so that a second read sees the answers', async () => {
    const created = await runPdf('form-creator', { fieldSpecs: specs });
    const filled = await run('form-filler', {
      fieldValues: { applicantName: 'Wang Wei', agree: true, country: 'Japan', tier: 'Silver' },
      flatten: false,
    }, [pdfFile(await outBytes(created), 'form.pdf')]);
    const doc = await reopen(filled);
    const values = new Map(doc.getForm().getFields().map((field) => [field.getName(), field]));
    expect((values.get('applicantName') as unknown as { getText: () => string }).getText()).toBe('Wang Wei');
    expect((values.get('agree') as unknown as { isChecked: () => boolean }).isChecked()).toBe(true);
    expect((values.get('country') as unknown as { getSelected: () => string[] }).getSelected()).toEqual(['Japan']);
    expect((values.get('tier') as unknown as { getSelected: () => string }).getSelected()).toBe('Silver');
    // Still fillable: nothing was flattened.
    expect(doc.getForm().getFields().length).toBe(specs.length);
  });

  it('flattens when asked and reports what became page content', async () => {
    const created = await runPdf('form-creator', {
      fieldSpecs: [{ type: 'text', name: 'name', rect: { x: 60, y: 700, width: 200, height: 20 }, value: 'flattened words' }],
    });
    const filled = await run('form-filler', { fieldValues: { name: 'flattened words' }, flatten: true }, [
      pdfFile(await outBytes(created), 'form.pdf'),
    ]);
    const doc = await reopen(filled);
    expect(doc.getForm().getFields().length).toBe(0);
    expect(await pageText(doc.getPages()[0])).toContain('flattened words');
  });

  it('admits an answer that reached no field instead of saying "filled"', async () => {
    const created = await runPdf('form-creator', { fieldSpecs: [specs[0]] });
    const filled = await run('form-filler', { fieldValues: { ghost: 'nobody' } }, [
      pdfFile(await outBytes(created), 'form.pdf'),
    ]);
    expect(filled.message).toMatch(/no value given for ghost/u);
  });

  it('gives a second field of the same name a distinct one rather than crashing', async () => {
    const outcome = await runPdf('form-creator', {
      fieldSpecs: [
        { type: 'text', name: 'same', rect: { x: 60, y: 700, width: 200, height: 20 } },
        { type: 'text', name: 'same', rect: { x: 60, y: 660, width: 200, height: 20 } },
      ],
    });
    const doc = await reopen(outcome);
    expect(doc.getForm().getFields().length).toBe(2);
    expect(doc.getForm().getFields().map((field) => field.getName())).toEqual(['same', 'same_2']);
    expect(outcome.warnings.join(' ')).toMatch(/already named "same"/u);
  });

  it('says when a radio group has no options and would draw nothing', async () => {
    const outcome = await runPdf('form-creator', {
      fieldSpecs: [{ type: 'radio', name: 'empty', rect: { x: 60, y: 700, width: 20, height: 20 } }],
    });
    expect(outcome.outputs.length).toBe(0);
    expect(outcome.message ?? '').toMatch(/no options|nothing to place/iu);
  });

  it('moves a field dropped past the last page and reports it', async () => {
    const outcome = await runPdf('form-creator', {
      fieldSpecs: [{ type: 'text', name: 'late', page: 4, rect: { x: 60, y: 700, width: 200, height: 20 } }],
    });
    const doc = await reopen(outcome);
    expect(doc.getForm().getFields().length).toBe(1);
    expect(outcome.warnings.join(' ')).toMatch(/nearest page/iu);
  });
});

describe('pdf-layers edits the default viewing configuration', () => {
  async function layerState(outcome: RunOutcome) {
    const doc = await reopen(outcome);
    const properties = dictOf(doc, doc.catalog.get(PDFName.of('OCProperties')));
    const groups = arrayOf(doc, properties?.get(PDFName.of('OCGs'))) ?? [];
    const groupList: unknown[] = Array.isArray(groups) ? groups : groups.asArray();
    const names = groupList.map((value) => decodeTextString(dictOf(doc, value)?.get(PDFName.of('Name'))) ?? '');
    const config = dictOf(doc, properties?.get(PDFName.of('D')));
    const refs = (key: string) =>
      (arrayOf(doc, config?.get(PDFName.of(key)))?.asArray() ?? [])
        .filter((value): value is PDFRef => value instanceof PDFRef)
        .map((value) => value.toString());
    const groupRefs = groupList.map((value) => (value instanceof PDFRef ? value.toString() : ''));
    return {
      names,
      on: refs('ON').map((ref) => names[groupRefs.indexOf(ref)] ?? ref),
      off: refs('OFF').map((ref) => names[groupRefs.indexOf(ref)] ?? ref),
    };
  }

  it('creates a layer with the name the user typed and switches it off', async () => {
    const added = await runPdf('pdf-layers', { add: 'Revision B' });
    const state = await layerState(added);
    expect(state.names).toEqual(['Revision B']);
    expect(state.on).toEqual(['Revision B']);
    const next = await run('pdf-layers', { hide: ['Revision B'] }, [
      pdfFile(await outBytes(added), 'fixture.pdf'),
    ]);
    const hidden = await layerState(next);
    expect(hidden.off).toEqual(['Revision B']);
    expect(hidden.on).toEqual([]);
  });

  it('says which instructions matched nothing, and keeps one name out of both lists', async () => {
    const added = await runPdf('pdf-layers', { add: 'LayerOne' });
    const outcome = await run('pdf-layers', { hide: ['LayerOne'], show: ['LayerOne'], remove: ['Ghost'] }, [
      pdfFile(await outBytes(added), 'fixture.pdf'),
    ]);
    const admitted = outcome.warnings.join(' ');
    expect(admitted).toMatch(/"Ghost"/u);
    expect(admitted).toMatch(/both hide and show/u);
    const state = await layerState(outcome);
    expect(state.off).toEqual(['LayerOne']);
  });

  it('deletes a layer without deleting the content it wrapped', async () => {
    const added = await runPdf('pdf-layers', { add: 'Temp' });
    const removed = await run('pdf-layers', { remove: 'Temp' }, [pdfFile(await outBytes(added), 'fixture.pdf')]);
    const state = await layerState(removed);
    expect(state.names).toEqual([]);
    expect(await pageText((await reopen(removed)).getPages()[0])).toContain('Body text');
  });

  it('reports a document with no layers as a report, not an unchanged download', async () => {
    const outcome = await runPdf('pdf-layers', { hide: ['Whatever'] });
    expect(outcome.outputs.length).toBe(0);
    expect(outcome.message).toMatch(/No layers found|no optional-content groups/iu);
  });
});

describe('remove-annotations and redact delete from the bytes', () => {
  it('removes the marks it finds and leaves the page content intact', async () => {
    const bytes = await pdfFixture([{ text: 'annotated page' }]);
    const doc = await openPDF(bytes);
    addAnnotations(doc, [
      { kind: 'Highlight', page: 0, rect: { x: 40, y: 770, width: 120, height: 16 }, quadPoints: [{ x: 40, y: 770, width: 120, height: 16 }] },
      { kind: 'FreeText', page: 0, rect: { x: 40, y: 700, width: 120, height: 20 }, text: 'note' },
    ] as never);
    const marked = await doc.save({ useObjectStreams: false });
    expect(listAnnotations(await openPDF(marked)).length).toBe(2);
    const outcome = await run('remove-annotations', { pages: 'all' }, [pdfFile(marked, 'marked.pdf')]);
    const cleared = await reopen(outcome);
    expect(listAnnotations(cleared).length).toBe(0);
    expect(await pageText(cleared.getPages()[0])).toContain('annotated page');
  });

  it('deletes the text under a redaction box rather than covering it', async () => {
    // The mark is the band over the fixture's line (user-space y 781.89 of an
    // 841.89 pt sheet) in the frame the redaction pane hands the tool: the page as
    // displayed, origin top-left.
    const outcome = await runPdf('redact-pdf', {
      regions: [{ page: 0, x: 40, y: 52, width: 200, height: 18 }],
      fill: '#000000',
    }, [
      { text: 'secret sentence here' },
    ]);
    const doc = await reopen(outcome);
    const page = doc.getPages()[0];
    const text = await pageText(page);
    expect(text).not.toContain('secret');
    expect(streamText(page)).toMatch(/0 0 0 rg/);
    expect(outcome.warnings.join(' ')).not.toMatch(/re-rendered/u);
  });
});

describe('the editor tools that live in a pane keep their contract', () => {
  it('routes edit-pdf and edit-pdf-text to a bespoke pane', () => {
    for (const id of ['edit-pdf', 'edit-pdf-text']) {
      expect(hasCustomMainView(id), `${id} has no pane`).toBe(true);
      expect(getPdfTool(id)?.run, `${id} should not pretend to have a run`).toBeFalsy();
    }
  });

  it('writes marks as standard annotations another reader can select', async () => {
    const doc = await openPDF(await pdfFixture([{ text: 'page with room for marks' }]));
    addAnnotations(doc, [
      {
        kind: 'Highlight',
        page: 0,
        rect: { x: 40, y: 770, width: 160, height: 16 },
        quadPoints: [
          { x: 40, y: 770, width: 160, height: 16 },
          { x: 40, y: 748, width: 120, height: 16 },
        ],
      },
    ] as never);
    const saved = await doc.save({ useObjectStreams: false });
    const read = await openPDF(saved);
    const marks = listAnnotations(read);
    expect(marks.length).toBe(1);
    const annots = arrayOf(read, read.getPages()[0].node.get(PDFName.of('Annots')));
    const dict = dictOf(read, annots?.get(0));
    expect(dict?.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString()).toBe('/Highlight');
    const quad = arrayOf(read, dict?.get(PDFName.of('QuadPoints')));
    expect(quad?.size()).toBe(8);
  });

  it('removes the glyphs it is told to and keeps their neighbours', async () => {
    const doc = await openPDF(await pdfFixture([{ text: 'Remove this keep that' }]));
    const page = doc.getPages()[0];
    const runs = pageRuns(page);
    expect(runs[0]?.text).toBe('Remove this keep that');
    const outcome = await import('@/lib/pdf/core/content').then((content) =>
      content.removeTextInRects(page, [{ x: 35, y: 775, width: 100, height: 20 }]),
    );
    expect(outcome.removedGlyphRuns).toBe(1);
    // Measured from real metrics, so redaction no longer needs a raster fallback
    // for a page of ordinary selectable text.
    expect(outcome.needsRasterFallback).toBe(false);
    const reloaded = await openPDF(await doc.save({ useObjectStreams: false }));
    expect(await pageText(reloaded.getPages()[0])).not.toContain('Remove');
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * office.ts — the containers that really convert
 * ════════════════════════════════════════════════════════════════════════ */

async function zipBytes(entries: { name: string; data: string }[]): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const entry of entries) zip.file(entry.name, entry.data);
  return new Uint8Array(await zip.generateAsync({ type: 'arraybuffer', compression: 'STORE' }));
}

const ODT_MIMETYPE = 'application/vnd.oasis.opendocument.text';

function odtPackage(paragraphs: string[]): Promise<Uint8Array> {
  return zipBytes([
    { name: 'mimetype', data: ODT_MIMETYPE },
    {
      name: 'content.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
<office:body><office:text>
<h:text>Quarterly Report</h:text>
${paragraphs.map((text) => `<text:p>${text}</text:p>`).join('\n')}
</office:text></office:body></office:document-content>`,
    },
  ]);
}

function odsPackage(rows: string[][]): Promise<Uint8Array> {
  const table = rows
    .map((row) => `<table:table-row>${row.map((cell) => `<table:table-cell office:value-type="string"><text:p>${cell}</text:p></table:table-cell>`).join('')}</table:table-row>`)
    .join('');
  return zipBytes([
    { name: 'mimetype', data: 'application/vnd.oasis.opendocument.spreadsheet' },
    {
      name: 'content.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
<office:body><office:spreadsheet>
<table:table table:name="Budget">${table}</table:table>
</office:spreadsheet></office:body></office:document-content>`,
    },
  ]);
}

/** A deck in the shape this reader walks (`draw:shape`). */
function odpPackage(slides: { title: string; body: string }[]): Promise<Uint8Array> {
  const pages = slides
    .map(
      (slide) => `<draw:page>
<draw:shape draw:presentationclass="title"><draw:text-box><text:h>${slide.title}</text:h></draw:text-box></draw:shape>
<draw:shape><draw:text-box><text:p>${slide.body}</text:p></draw:text-box></draw:shape>
</draw:page>`,
    )
    .join('');
  return zipBytes([
    { name: 'mimetype', data: 'application/vnd.oasis.opendocument.presentation' },
    {
      name: 'content.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
<office:body><office:presentation>${pages}</office:presentation></office:body></office:document-content>`,
    },
  ]);
}

function xpsPackage(runs: string[], tagName = 'glyphs'): Promise<Uint8Array> {
  const body = runs.map((text) => `<${tagName} UnicodeString="${text}" Indices="0"/>`).join('');
  return zipBytes([
    {
      name: 'FixedDoc01/Pages/Page1.fpage',
      data: `<?xml version="1.0" encoding="utf-8"?><FixedPage Width="800" Height="1000" xmlns="http://schemas.microsoft.com/xps/2005/06">${body}</FixedPage>`,
    },
  ]);
}

const FB2_SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">
<description><title-info><book-title>The Long Shelf</book-title></title-info></description>
<body>
<section><title><p>Chapter One</p></title><p>The shelf began to matter again.</p></section>
</body>
</FictionBook>`;

describe('office converters put the source text into selectable PDF text', () => {
  it('odt-to-pdf lays out headings and paragraphs', async () => {
    const outcome = await run('odt-to-pdf', {}, [
      anyFile(await odtPackage(['Revenue rose by twelve percent in Q3.']), 'report.odt', 'application/vnd.oasis.opendocument.text'),
    ]);
    const doc = await reopen(outcome);
    const text = await pageText(doc.getPages()[0]);
    expect(text).toContain('Revenue rose by twelve percent in Q3.');
    expect(text).toContain('Quarterly Report');
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it('ods-to-pdf prints the cell values as a table', async () => {
    const outcome = await run('ods-to-pdf', {}, [
      anyFile(await odsPackage([['Item', 'Cost'], ['Server', '4200'], ['Desk', '180']]), 'sheet.ods', 'application/vnd.oasis.opendocument.spreadsheet'),
    ]);
    const doc = await reopen(outcome);
    const text = (await Promise.all(doc.getPages().map(pageText))).join('\n');
    expect(text).toContain('Server');
    expect(text).toContain('4200');
    expect(text).toContain('Desk');
    expect(text).toContain('Budget');
  });

  it('odp-to-pdf makes one page per slide at the aspect asked for', async () => {
    const outcome = await run('odp-to-pdf', { slideSize: '4:3', margin: 28 }, [
      anyFile(await odpPackage([{ title: 'Open slide', body: 'First bullet point' }, { title: 'Second slide', body: 'More words' }]), 'deck.odp', 'application/vnd.oasis.opendocument.presentation'),
    ]);
    const doc = await reopen(outcome);
    const sizes = doc.getPages().map((page) => groupBox(page));
    expect(sizes.length).toBe(2);
    expect(sizes.every((box) => Math.round(box.width) === 720 && Math.round(box.height) === 540)).toBe(true);
    const text = (await Promise.all(doc.getPages().map(pageText))).join('\n');
    expect(text).toContain('Open slide');
    expect(text).toContain('More words');
  });

  it('xps-to-pdf recovers the text runs of each fixed page', async () => {
    const outcome = await run('xps-to-pdf', {}, [
      anyFile(await xpsPackage(['XPS page one text']), 'print.xps', 'application/vnd.ms-xpsdocument'),
    ]);
    const doc = await reopen(outcome);
    expect(await pageText(doc.getPages()[0])).toContain('XPS page one text');
  });

  it('xps-to-pdf refuses a package whose runs it cannot see instead of shipping blanks', async () => {
    // Real Windows output writes `<t:Glyphs>`; the reader compares lower-case
    // names, so the honest behaviour is a refusal, not blank pages.
    await expect(
      run('xps-to-pdf', {}, [anyFile(await xpsPackage(['Hidden here'], 't:Glyphs'), 'real.xps', 'application/vnd.ms-xpsdocument')]),
    ).rejects.toThrow(/no text runs this reader can recover/iu);
  });

  it('odp-to-pdf refuses a deck whose frames it cannot see', async () => {
    const impress = await zipBytes([
      { name: 'mimetype', data: 'application/vnd.oasis.opendocument.presentation' },
      {
        name: 'content.xml',
        data: `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
<office:body><office:presentation><draw:page><draw:frame><draw:text-box><text:p>Impress title</text:p></draw:text-box></draw:frame></draw:page></office:presentation></office:body></office:document-content>`,
      },
    ]);
    await expect(
      run('odp-to-pdf', {}, [anyFile(impress, 'impress.odp', 'application/vnd.oasis.opendocument.presentation')]),
    ).rejects.toThrow(/no text frames this reader can see/iu);
  });

  it('fb2-to-pdf re-typesets the book title, sections and paragraphs', async () => {
    const outcome = await run('fb2-to-pdf', {}, [anyFile(FB2_SAMPLE, 'book.fb2', 'application/xml')]);
    const doc = await reopen(outcome);
    const text = (await Promise.all(doc.getPages().map(pageText))).join('\n');
    expect(text).toContain('The Long Shelf');
    expect(text).toContain('Chapter One');
    expect(text).toContain('The shelf began to matter again.');
  });

  it('refuses a 0-byte upload and a file renamed from another container', async () => {
    await expect(run('odt-to-pdf', {}, [anyFile(new Uint8Array(0), 'empty.odt', 'application/octet-stream')]))
      .rejects.toThrow(/empty|0 bytes/iu);
    const notAZip = anyFile('%PDF-1.7\nnot a zip at all\n%%EOF', 'truth.odt', 'application/octet-stream');
    await expect(run('odt-to-pdf', {}, [notAZip])).rejects.toThrow(/OpenDocument|zip|not a PDF/iu);
  });

  it('draws converted text with an embedded Unicode face, never a WinAnsi-only path', async () => {
    const outcome = await run('odt-to-pdf', {}, [
      anyFile(await odtPackage(['报告 quarterly 报告']), 'cjk.odt', 'application/vnd.oasis.opendocument.text'),
    ]);
    const doc = await reopen(outcome);
    const text = await pageText(doc.getPages()[0]);
    expect(text).toContain('报告');
    expect(FONT_URLS.some((url) => /NotoSans/i.test(url))).toBe(true);
  });
});

describe('the container family stays honest about being unavailable', () => {
  it('lists exactly the seven legacy containers, each with a run-free refusal', () => {
    expect(legacyOfficeTools.map((tool) => tool.id).sort()).toEqual([
      'mobi-to-pdf', 'odg-to-pdf', 'pages-to-pdf', 'pub-to-pdf', 'vsd-to-pdf', 'wpd-to-pdf', 'wps-to-pdf',
    ]);
    for (const tool of legacyOfficeTools) {
      expect(tool.run, `${tool.id} must not pretend to convert`).toBeFalsy();
      expect(tool.unavailable ?? '', tool.id).toMatch(/LibreOffice|decoder|not available/iu);
    }
  });

  it('refuses every one of them through the runner, naming a format that does convert', async () => {
    const fixtures: Record<string, [string, string]> = {
      'mobi-to-pdf': ['book.mobi', 'application/x-mobipocket-ebook'],
      'pages-to-pdf': ['notes.pages', 'application/octet-stream'],
      'pub-to-pdf': ['flyer.pub', 'application/octet-stream'],
      'vsd-to-pdf': ['plan.vsd', 'application/vnd.visio'],
      'wpd-to-pdf': ['legacy.wpd', 'application/octet-stream'],
      'wps-to-pdf': ['writer.wps', 'application/octet-stream'],
      'odg-to-pdf': ['drawing.odg', 'application/vnd.oasis.opendocument.graphics'],
    };
    for (const [id, [name, type]] of Object.entries(fixtures)) {
      const tool = getPdfTool(id)!;
      const reason = tool.unavailable ?? '';
      let thrown: unknown = null;
      try {
        await run(id, {}, [anyFile(new Uint8Array([1, 2, 3, 4]), name, type)]);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `${id} produced output without an engine`).toBeTruthy();
      expect((thrown as Error).message).toBe(reason);
      // The alternative it points at must be a tool that really converts.
      const pointers = [...reason.matchAll(/\b(epub|docx|svg|png|pdf)\b/gi)].map((match) => match[1].toLowerCase());
      expect(pointers.length, `${id}'s reason names no format`).toBeGreaterThan(0);
      expect(thrown).toBeInstanceOf(ToolInputError);
    }
  });

  it('points at catalogue entries that exist and have a run', () => {
    const alternatives = ['epub-to-pdf', 'word-to-pdf', 'svg-to-pdf', 'image-to-pdf'];
    for (const id of alternatives) {
      const tool = getPdfTool(id);
      expect(tool, `${id} is no longer in the catalogue`).toBeTruthy();
      expect(tool?.run, `${id} cannot actually convert`).toBeTruthy();
      expect(tool?.unavailable, `${id} is itself unavailable`).toBeFalsy();
    }
  });
});

/* ── registry-wide honesty checks for the two files under audit ───────────── */

describe('every tool in these two files is described truthfully', () => {
  const owned = [...editTools, ...officeTools, ...legacyOfficeTools];

  it('is present, so this file has a duty to each one', () => {
    expect(owned.length).toBeGreaterThanOrEqual(30);
    const ids = owned.map((tool) => tool.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const tool of owned) {
      expect(getPdfTool(tool.id), `${tool.id} is not registered`).toBe(tool);
    }
  });

  it('never promises text a WinAnsi-only face could not draw', async () => {
    // A watermark, folio and header are all drawn through `core/fonts`; if any
    // of them fell back to `page.drawText` with a standard font, CJK would come
    // out as boxes rather than throw.
    const outcome = await runPdf(
      'header-footer',
      { headerLeft: '', headerCenter: '文件', headerRight: '', footerLeft: '', footerCenter: '', footerRight: 'ページ {page}', rule: false },
      [{ text: '内容' }],
    );
    const doc = await reopen(outcome);
    const text = await pageText(doc.getPages()[0]);
    expect(text).toContain('文件');
    expect(text).toContain('ページ 1');
    const faces = runFonts(doc.getPages()[0]);
    // Either the standard face (Latin-only, used because it is safe) or an
    // embedded subset — never a standard face asked to draw CJK.
    expect(faces.some((face) => /NotoSans/i.test(face))).toBe(true);
  });

  it('names a promise for every tool, and notes for every tool without fields', () => {
    for (const tool of owned) {
      expect((tool.promise ?? '').trim().length, tool.id).toBeGreaterThan(30);
      if (!tool.fields || tool.fields.length === 0) {
        expect((tool.notes ?? []).length, `${tool.id} has no fields and no notes`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps the catalogue free of duplicated jobs from this file', () => {
    const names = PDF_TOOLS.map((tool) => tool.name.trim().toLowerCase());
    const duplicates = [...new Set(names.filter((name, index) => names.indexOf(name) !== index))];
    expect(duplicates, `duplicate tool names: ${duplicates.join(', ')}`).toEqual([]);
  });
});
