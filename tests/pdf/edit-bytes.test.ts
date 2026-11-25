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
import { pageContentStreams, recolourText, textRects } from '@/lib/pdf/core/content';
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

/** `/Contents`, the key these tests read and write directly. */
const CONTENTS_NAME = PDFName.of('Contents');

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

  it('replaces every {total} and {page} the suffix holds, not just the first', async () => {
    // Measured on the shipped build: a suffix of `X{total}/{total}` wrote
    // "Page 001X002/{total}" into the page while the card reported the numbers.
    const outcome = await runPdf('page-numbers', { pages: '1-2', prefix: '', suffix: 'X{total}/{total}/{page}' }, [
      { text: 'a' },
      { text: 'b' },
    ]);
    const doc = await reopen(outcome);
    const texts = await Promise.all(doc.getPages().map(pageText));
    expect(texts.map((text) => text.replace(/^[ab]/, '')).map((text) => text.trim())).toEqual(['1X2/2/1', '2X2/2/2']);
  });

  it('pads to the width the picker shows, not to a hard-coded three digits', async () => {
    // The option reads "01, 02, 03"; the shipped build wrote "Page 001 of 004".
    const outcome = await runPdf('page-numbers', { pages: 'all', style: 'padded', prefix: '', suffix: '' }, [
      { text: 'a' },
      { text: 'b' },
      { text: 'c' },
      { text: 'd' },
    ]);
    const doc = await reopen(outcome);
    const texts = await Promise.all(doc.getPages().map(pageText));
    expect(texts.map((text) => text.replace(/^[abcd]/, '').trim())).toEqual(['01', '02', '03', '04']);
  });

  it('widens the padding when the last number needs the room', async () => {
    // Reaching 100 makes the width three, so the whole run is written 098–100
    // rather than a two-digit 98 next to a three-digit 100.
    const outcome = await runPdf('page-numbers', { pages: 'all', style: 'padded', prefix: '', suffix: '', startAt: 98 }, [
      { text: 'a' },
      { text: 'b' },
      { text: 'c' },
    ]);
    const doc = await reopen(outcome);
    const texts = await Promise.all(doc.getPages().map(pageText));
    expect(texts.map((text) => text.replace(/^[abc]/, '').trim())).toEqual(['098', '099', '100']);
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

  it('floors roman and letter folios at one and admits it', async () => {
    // Measured on the shipped build: `First number: 0` with Roman numerals drew
    // "Page 0 of IV" next to "Page I", and the letter run stamped two pages "A".
    // Those styles carry no zero, so the floor is 1 — said in the same admitted-
    // clamp voice as every other numeric field, and proven in the bytes.
    const letters = await runPdf('page-numbers', { pages: 'all', style: 'letters', prefix: '', suffix: '', startAt: 0 }, [
      { text: 'a' },
      { text: 'b' },
      { text: 'c' },
    ]);
    expect(letters.warnings.join(' ')).toMatch(/First number must be 1 or more for letter folios, which start at A: 0 became 1\./);
    const ldoc = await reopen(letters);
    const ltexts = (await Promise.all(ldoc.getPages().map(pageText))).map((t, i) => t.replace('abc'[i], '').trim());
    expect(ltexts).toEqual(['A', 'B', 'C']);
    const roman = await runPdf('page-numbers', { pages: 'all', style: 'roman-upper', prefix: 'Page ', suffix: '', startAt: 0 }, [
      { text: 'a' },
      { text: 'b' },
    ]);
    expect(roman.warnings.join(' ')).toMatch(/roman numerals, which have no zero: 0 became 1/);
    const rdoc = await reopen(roman);
    const rtexts = (await Promise.all(rdoc.getPages().map(pageText))).map((t, i) => t.replace('ab'[i], '').trim());
    expect(rtexts).toEqual(['Page I', 'Page II']);
    // Control: decimal genuinely may start at zero — no clamp, no warning there.
    const dec = await runPdf('page-numbers', { pages: 'all', prefix: '', suffix: '', startAt: 0 }, [
      { text: 'a' },
      { text: 'b' },
    ]);
    expect(dec.warnings).toEqual([]);
    const ddoc = await reopen(dec);
    const dtexts = (await Promise.all(ddoc.getPages().map(pageText))).map((t, i) => t.replace('ab'[i], '').trim());
    expect(dtexts).toEqual(['0', '1']);
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

  it('stamps roman past 3999 in the one spelling its page labels use', async () => {
    // The folio and `/PageLabels` used to carry private copies of the romaniser, so
    // the same number could be spelled two ways in one document — the label preview
    // stopped at decimal over 3999 while the sheet kept stamping additive M. Both
    // now call core's `toRoman`, and this pins the strings against each other.
    const four = [
      { text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' },
    ];
    const folios = await runPdf('page-numbers', {
      pages: 'all', style: 'roman-upper', prefix: '', suffix: '', startAt: 3998,
    }, four);
    const doc = await reopen(folios);
    const stamped = (await Promise.all(doc.getPages().map(pageText)))
      .map((text, index) => text.replace('abcd'[index], '').trim());
    expect(stamped).toEqual(['MMMCMXCVIII', 'MMMCMXCIX', 'MMMM', 'MMMMI']);
    expect(folios.message).toMatch(/MMMCMXCVIII to MMMMI/u);

    const labels = await runPdf('add-page-labels', { ranges: '1-4 Roman 3998' }, four);
    expect(labels.message).toMatch(/now read: MMMCMXCVIII, MMMCMXCIX, MMMM, MMMMI/u);
    // Control: the lower-case folio is the same tree's other spelling, not a third.
    const lower = await runPdf('page-numbers', {
      pages: 'all', style: 'roman-lower', prefix: '', suffix: '', startAt: 3998,
    }, four);
    const lowerDoc = await reopen(lower);
    expect((await Promise.all(lowerDoc.getPages().map(pageText)))
      .map((text, index) => text.replace('abcd'[index], '').trim()))
      .toEqual(stamped.map((text) => text.toLowerCase()));
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

  it('paints the rule in the colour it gives the text', async () => {
    // The colour help promises it is "Applied to the text and to the rule
    // together"; the live tab measured #aa0000 in the run fill and in the rule
    // stroke (0.667, 0, 0). The style-diff suite proves the run changes but not
    // the line, so the stroke colour gets its own byte pin here.
    const outcome = await runPdf(
      'header-footer',
      {
        headerLeft: '',
        headerCenter: 'RED',
        headerRight: '',
        footerLeft: '',
        footerCenter: '',
        footerRight: '',
        color: '#aa0000',
        rule: true,
      },
      [{ text: 'a' }],
    );
    const doc = await reopen(outcome);
    const stream = streamText(doc.getPages()[0]);
    const stroke = /([\d.]+) ([\d.]+) ([\d.]+) RG[\s\S]{0,80}l S/.exec(stream);
    expect(stroke, 'the rule drew no stroke colour').toBeTruthy();
    expect(Number(stroke![1])).toBeCloseTo(170 / 255, 3);
    expect(Number(stroke![2])).toBe(0);
    expect(Number(stroke![3])).toBe(0);
    // And the text of the same page carries the identical fill triple (written
    // with the writer's own precision, so compare the numbers, not the string).
    const fills = [...stream.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) rg/g)]
      .map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
    expect(fills.some(([r, g, b]) => Math.abs(r - 170 / 255) < 1e-3 && g === 0 && b === 0), 'no run shares the rule colour').toBe(true);
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

  /** Eight sheets, the length every sentence below was measured against. */
  const eight = Array.from({ length: 8 }, (_unused, index) => ({ text: `page ${index + 1}` }));

  it('names the thing that actually ended a range (E15)', async () => {
    // Two of the four shapes used to name the other shape's cause: a last line cut
    // short by the document was blamed on "the next range", and a line the next
    // range stopped early was blamed on the document's length.
    const tooLong = await runPdf('add-page-labels', { ranges: '1-3 roman 1\n4-99 decimal 1' }, eight);
    expect(tooLong.warnings.join(' '))
      .toMatch(/The labels from page 4 run to page 8, not page 99: this document has 8 pages\./u);
    expect(tooLong.warnings.join(' ')).not.toMatch(/last until the next range/u);

    const overshoot = await runPdf('add-page-labels', { ranges: '1-2 roman 1\n5-8 decimal 1' }, eight);
    expect(overshoot.warnings.join(' '))
      .toMatch(/The labels from page 1 run to page 4, not page 2: PDF labels last until the next range starts, at page 5\./u);
    expect(overshoot.warnings.join(' ')).not.toMatch(/not page 2: this document has 8 pages/u);
    // And the overshoot is what the file holds, not just what the note says.
    expect(await labelRanges(overshoot)).toMatchObject([
      { start: 0, style: '/r' },
      { start: 4, style: '/D' },
    ]);

    const cutShort = await runPdf('add-page-labels', { ranges: '1-5 decimal 1\n3-8 roman 1' }, eight);
    expect(cutShort.warnings.join(' '))
      .toMatch(/The labels from page 1 run to page 2, not page 5: the next range starts at page 3\./u);

    const runsToEnd = await runPdf('add-page-labels', { ranges: '1-1 decimal' }, eight);
    expect(runsToEnd.warnings.join(' '))
      .toMatch(/The labels from page 1 run to page 8, not page 1: nothing starts after it, so it lasts to the end of the document, page 8\./u);

    // Control: lines whose typed ends land exactly say nothing about ends.
    const exact = await runPdf('add-page-labels', { ranges: '1-2 Roman\n3-4 alpha\n5-5 Alpha\n6-8 decimal 7' }, eight);
    expect(exact.warnings.join(' ')).not.toMatch(/run to page/u);
    expect(exact.message).toMatch(/now read: I, II, a, b, A, 7, 8, 9/u);
  });

  it('refuses page 0 by name instead of throwing core\'s validation text', async () => {
    await expect(runPdf('add-page-labels', { ranges: '0-3 roman 1' }, eight))
      .rejects.toThrow(/"0-3 roman 1" starts at page 0, but the first page of this document is page 1\./u);
    await expect(runPdf('add-page-labels', { ranges: '0-3 roman 1' }, eight))
      .rejects.not.toThrow(/non-negative start page/u);

    // The point of refusing the line here: one page-0 typo used to take the legal
    // lines in the same box down with it, and no file came back at all.
    const mixed = await runPdf('add-page-labels', { ranges: '0-2 roman\n4-6 decimal 1' }, eight);
    expect(mixed.warnings.join(' ')).toMatch(/"0-2 roman" starts at page 0/u);
    expect(await labelRanges(mixed)).toMatchObject([
      { start: 0, style: '/D', first: undefined },
      { start: 3, style: '/D', first: undefined },
    ]);
  });

  it('refuses a start number no reader can hold, and keeps the largest one that survives', async () => {
    // 1e22 written into `/St`: qpdf hands back a catalogue with no `/PageLabels`,
    // MuPDF reads 1864712049423024128, and this app previewed every sheet as `1e+22`.
    await expect(runPdf('add-page-labels', { ranges: '1-8 decimal 9999999999999999999999' }, eight))
      .rejects.toThrow(/starts at 9999999999999999999999, but a page label holds at most 2147483647/u);

    const held = await runPdf('add-page-labels', { ranges: '1-8 decimal 2147483647' }, eight);
    expect(held.warnings.join(' ')).not.toMatch(/holds at most/u);
    expect((await labelRanges(held))[0]).toMatchObject({ start: 0, style: '/D', first: 2147483647 });
    expect(held.message).toMatch(/now read: 2147483647, 2147483648, 2147483649/u);
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
    expect(appended.message).toMatch(/after the 1 bookmark already in the document/u);
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

  it('lays the contents inside the visible box of the sheet it copies', async () => {
    // A page whose visible box is inset — the shape a scan with a black margin
    // has. The sheet written for a contents page carries no `/CropBox` of its
    // own, so a layout measured in crop coordinates but drawn from the media
    // origin lands 40 pt right and 40 pt up, on a sheet 80 pt wider than the
    // page it was copied from.
    const { writeOutline } = await import('@/lib/pdf/core/bookmarks');
    const src = await PDFDocument.create();
    src.addPage([420, 595]);
    src.addPage([420, 595]).setCropBox(40, 40, 340, 515);
    writeOutline(src, [{ title: 'One', page: 0 }, { title: 'Two', page: 1 }]);
    const outcome = await run('table-of-contents', { insertAt: 2, title: 'Contents' }, [
      pdfFile(await src.save({ useObjectStreams: false }), 'cropped.pdf'),
    ]);
    const doc = await reopen(outcome);
    const toc = doc.getPage(1);
    const { width, height } = toc.getSize();
    expect([width, height]).toEqual([340, 515]);
    const runs = pageRuns(toc);
    expect(runs.map((run) => run.text)).toContain('One');
    expect(Math.min(...runs.map((run) => run.rect.x))).toBeCloseTo(48, 5);
    const numbers = runs.filter((run) => /^\d+$/u.test(run.text));
    expect(numbers).toHaveLength(2);
    expect(Math.max(...numbers.map((run) => run.rect.x + run.rect.width))).toBeCloseTo(340 - 48, 5);
    expect(Math.max(...runs.map((run) => run.rect.y + run.rect.height))).toBeLessThanOrEqual(height);
    expect(Math.min(...runs.map((run) => run.rect.y))).toBeGreaterThanOrEqual(0);
  });

  it('makes the whole row the link, so the leader and the number answer a click', async () => {
    const fixture = pdfFile(await pdfFixture([{ text: 'a' }, { text: 'b' }]), 'fixture.pdf');
    const marked = await run('bookmarks', { outline: 'Alpha :: 2', replace: true }, [fixture]);
    const outcome = await run('table-of-contents', { insertAt: 1, title: 'Contents' }, [
      pdfFile(await outBytes(marked), 'fixture.pdf'),
    ]);
    const doc = await reopen(outcome);
    const toc = doc.getPages()[0];
    const annots = arrayOf(doc, toc.node.get(PDFName.of('Annots')));
    expect(annots?.size()).toBe(1);
    const rect = arrayOf(doc, dictOf(doc, annots?.get(0))?.get(PDFName.of('Rect')));
    const [x0, y0, x1, y1] = (rect?.asArray() ?? []).map((value) => Number(value.toString()));
    const runs = pageRuns(toc);
    const title = runs.find((run) => run.text === 'Alpha');
    const number = runs.find((run) => run.text === '3');
    expect(title && number).toBeTruthy();
    // The rect starts where the words do and reaches past the number at the
    // right margin — not the title's own width, which left 255 pt of dead row.
    expect(x0).toBeCloseTo(title!.rect.x, 1);
    expect(x1).toBeGreaterThanOrEqual(number!.rect.x + number!.rect.width - 0.5);
    // A row, not the page: the height stays one line.
    expect(y1 - y0).toBeLessThan(20);
    expect(y0).toBeLessThan(title!.rect.y);
    expect(y1).toBeGreaterThan(title!.rect.y);
  });
  it('says how many entries have no target, in a sentence that agrees with itself', async () => {
    // Measured on the card: "2 entries has no page target, so it is listed without
    // a number." The headings really are listed without numbers — the sentence was
    // the only thing wrong.
    const fixture = pdfFile(await pdfFixture([{ text: 'a' }, { text: 'b' }, { text: 'c' }]), 'fixture.pdf');
    const marked = await run('bookmarks', { outline: 'Front matter\n  Alpha :: 2\n  Beta :: 3\nBack matter' }, [fixture]);
    const outcome = await run('table-of-contents', { insertAt: 1, title: 'Contents' }, [
      pdfFile(await outBytes(marked), 'fixture.pdf'),
    ]);
    const warnings = outcome.warnings.join(' ');
    expect(warnings).toMatch(/2 entries have no page target, so they are listed without a number\./u);
    expect(warnings).not.toMatch(/entries has|it is listed without a number\.\s*$/u);

    const doc = await reopen(outcome);
    const runs = pageRuns(doc.getPages()[0]);
    const texts = runs.map((item) => item.text);
    expect(texts).toEqual(expect.arrayContaining(['Front matter', 'Back matter']));
    // Only the two entries that name a page get a number, and both name page 2 and 3
    // of the finished four-page file.
    expect(texts.filter((text) => /^\d+$/u.test(text))).toEqual(['3', '4']);

    // Control: a single missing target reads in the singular.
    const one = await run('bookmarks', { outline: 'Front matter\n  Alpha :: 2' }, [fixture]);
    const tocOne = await run('table-of-contents', { insertAt: 1, title: 'Contents' }, [
      pdfFile(await outBytes(one), 'fixture.pdf'),
    ]);
    expect(tocOne.warnings.join(' ')).toMatch(/1 entry has no page target, so it is listed without a number\./u);
  });

  it('lands every entry of a spilling list inside the sheet it was drawn on', async () => {
    // The spill class, byte-wise: 60 entries over a four-page fixture, at a size that
    // forces more than one contents page. The card counts what the paper holds.
    const fixture = pdfFile(await pdfFixture([{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }]), 'fixture.pdf');
    const outline = Array.from({ length: 60 }, (_unused, index) => `Entry ${index + 1} :: ${(index % 4) + 1}`).join('\n');
    const marked = await run('bookmarks', { outline }, [fixture]);
    const outcome = await run('table-of-contents', { insertAt: 1, title: 'Contents' }, [
      pdfFile(await outBytes(marked), 'fixture.pdf'),
    ]);
    const doc = await reopen(outcome);
    const inserted = doc.getPageCount() - 4;
    expect(inserted).toBeGreaterThan(1);
    expect(outcome.message).toBe(
      `Inserted a ${inserted} pages table of contents at page 1, listing 60 entries from the outline.`,
    );

    let listed = 0;
    let links = 0;
    for (let index = 0; index < inserted; index++) {
      const page = doc.getPages()[index];
      const { width, height } = page.getSize();
      const runs = pageRuns(page);
      for (const run of runs) {
        // On the paper, every time: nothing drawn at or below the sheet's edge.
        expect(run.rect.y).toBeGreaterThanOrEqual(0);
        expect(run.rect.y + run.rect.height).toBeLessThanOrEqual(height);
        expect(run.rect.x).toBeGreaterThanOrEqual(0);
        expect(run.rect.x + run.rect.width).toBeLessThanOrEqual(width);
      }
      listed += runs.filter((run) => /^Entry \d+$/u.test(run.text)).length;
      links += arrayOf(doc, page.node.get(PDFName.of('Annots')))?.size() ?? 0;
    }
    expect(listed).toBe(60);
    expect(links).toBe(60);

    // And the number beside a row is that sheet's position in the finished file.
    const first = pageRuns(doc.getPages()[0]);
    const title = first.find((run) => run.text === 'Entry 1')!;
    const beside = first.filter((run) => /^\d+$/u.test(run.text)
      && Math.abs(run.rect.y - title.rect.y) < 2);
    expect(beside.map((run) => run.text)).toEqual([String(1 + inserted)]);
  });

  it('leaves every entry off a sheet too short to hold them — blocker, core layout', async () => {
    // Measured live (`toc-append-back.pdf`: insert at page 8 of a mixed-size file
    // whose eighth sheet is 336 × 71.4 pt): the inserted sheet takes that strip for
    // its size, its usable band is `height - 48 = 23.4` above a `bottom` of 48, so
    // the heading prints and each entry is placed at a negative y — below the paper.
    // Four pages were inserted, each holding a `Contents` heading and no entry, while
    // the card read "Inserted a 4 pages table of contents at page 8, listing 3
    // entries from the outline." The layout is `generateTocPage`
    // (src/lib/pdf/core/bookmarks.ts), outside this lane; flip this pin to the
    // assertion it wants to be (every entry inside its sheet) when that lands.
    const fixture = pdfFile(await pdfFixture([
      { text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd', size: [336, 71.4] },
    ]), 'mixed.pdf');
    const marked = await run('bookmarks', { outline: 'Alpha :: 1\nBeta :: 2\nGamma :: 4' }, [fixture]);
    const outcome = await run('table-of-contents', { insertAt: 4, title: 'Contents' }, [
      pdfFile(await outBytes(marked), 'mixed.pdf'),
    ]);
    const doc = await reopen(outcome);
    const inserted = doc.getPageCount() - 4;
    expect(inserted).toBeGreaterThan(1);
    expect(outcome.message).toMatch(/listing 3 entries from the outline\./u);

    const titles = ['Alpha', 'Beta', 'Gamma'];
    let onPaper = 0;
    let headings = 0;
    // `insertAt: 4` puts the contents at index 3, ahead of the strip it copied.
    for (let index = 3; index < 3 + inserted; index++) {
      const page = doc.getPages()[index];
      const { height } = page.getSize();
      expect(height).toBeCloseTo(71.4, 1);
      for (const run of pageRuns(page)) {
        if (run.text === 'Contents') headings += 1;
        if (titles.includes(run.text) && run.rect.y >= 0 && run.rect.y + run.rect.height <= height) onPaper += 1;
      }
    }
    expect(headings).toBe(inserted);
    expect(onPaper).toBe(0);
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
    // The artifact **type** is `Background`. `/Artifact` is the tag of the marked
    // content sequence, not a value the property list may carry: ISO 32000-1
    // §14.8.2.2.1 Table 331 allows Pagination / Layout / Page / Background, and
    // ISO 32000-2 Table 363 keeps `/Subtype` for Pagination only. The stream used
    // to say `/Type /Artifact /Subtype /Background`, which no consumer that reads
    // `Type` recognises.
    expect(head).toContain('/Type /Background');
    expect(head).not.toContain('/Type /Artifact');
    expect(head).not.toContain('/Subtype');
    expect(head).toContain(' BDC');
    expect(head).toContain('EMC');
    expect(head).toMatch(/[\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+ re/);
    // The claim in the promise: extraction still sees the page's own words.
    expect(await pageText(page)).toContain('Body text');
    expect(outcome.message).toMatch(/Painted a #f7f7f4 background/u);
  });

  it('keeps a page whose /Contents is an indirect array, and fills it', async () => {
    // Acrobat writes `/Contents 12 0 R` where 12 is an array of streams. Treated
    // as a single stream it resolved to nothing, so the page was read as empty and
    // four things went wrong at once: the fill became `/Contents`'s only entry and
    // every stream of the page's own drawing was orphaned behind a nested array —
    // measured on the dev server, that page lost **all** its text (1779 chars → 0,
    // 14.81 % dark px → 0.00 %) and the app's own preview drew a flat rectangle.
    const source = await openPDF(await pdfFixture([{ text: 'Body text' }]));
    const page = source.getPages()[0];
    const own = arrayOf(source, page.node.get(CONTENTS_NAME));
    expect(own, 'the fixture should carry a /Contents array').toBeTruthy();
    const indirect = source.context.register(PDFArray.withContext(source.context));
    for (const entry of own!.asArray()) (source.context.lookup(indirect) as PDFArray).push(entry);
    page.node.set(CONTENTS_NAME, indirect);
    const edited = await outBytes(await run('background-color', { pages: '1' }, [
      pdfFile(await source.save({ useObjectStreams: false }), 'indirect.pdf'),
    ]));
    const reloaded = await openPDF(edited);
    const outPage = reloaded.getPages()[0];
    // `/Contents` is still an array of streams — never an array holding an array.
    for (const entry of arrayOf(reloaded, outPage.node.get(CONTENTS_NAME))!.asArray()) {
      expect(reloaded.context.lookup(entry), 'a /Contents entry resolved to a non-stream').toBeInstanceOf(PDFStream);
    }
    expect(await pageText(outPage)).toContain('Body text');
    const streams = pageContentStreams(outPage);
    expect(streams.length).toBe(2);
    expect(Buffer.from(streams[0].bytes).toString('latin1')).toContain('/Type /Background');
    // The control: the page's own stream is still there, and still draws its text.
    expect(Buffer.from(streams[1].bytes).toString('latin1')).toContain('Tj');
  });

  it('fills a page that had no /Contents at all', async () => {
    const source = await openPDF(await pdfFixture([{}]));
    const edited = await outBytes(await run('background-color', { color: '#3366ff', pages: '1' }, [
      pdfFile(await source.save({ useObjectStreams: false }), 'empty.pdf'),
    ]));
    const stream = streamText((await openPDF(edited)).getPages()[0]);
    // Not white paper: the empty sheet becomes the fill, and only the fill.
    expect(stream).toContain('0.2 0.4 1 rg');
    expect(stream.match(/ re/g)?.length).toBe(1);
  });

  it('lays the fill down semi-transparent only when opacity asks for it', async () => {
    const opaque = streamText((await reopen(await runPdf('background-color', { pages: '1' }))).getPages()[0]);
    expect(opaque).not.toMatch(/gs\b/);
    const outcome = await runPdf('background-color', { color: '#3366ff', opacity: 0.4, pages: '1' });
    const doc = await reopen(outcome);
    const page = doc.getPages()[0];
    const stream = streamText(page);
    // A fill at 1 turned the page into a repaint; at 0.4 the paper has to keep
    // showing through, which is a `/ca` graphics state on the fill alone.
    const states = dictOf(doc, page.node.get(PDFName.of('Resources')))?.lookup(PDFName.of('ExtGState'), PDFDict);
    const name = stream.match(/\/(\S+) gs/)?.[1];
    expect(name, 'the fill should reference a named graphics state').toBeTruthy();
    const state = states && dictOf(doc, states.get(PDFName.of(name!)));
    expect(state?.lookupMaybe(PDFName.of('ca'), PDFNumber)?.asNumber()).toBe(0.4);
    // Inside the `q Q` pair XObject-style fills are wrapped in, so it cannot leak.
    expect(stream.indexOf('gs')).toBeLessThan(stream.indexOf(' re'));
    expect(outcome.message).toMatch(/40 % opacity/u);
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

/* ── text-color: which run changed, and what did not ──────────────────────── */

/**
 * A page whose content stream is the test's own text, so every operator sits
 * exactly where the case needs it. `/F1` in the body is the fixture's own face;
 * `form`/`pattern` add the resource the case is about.
 */
interface RawPage {
  rotation?: number;
  /** Operators for a Form XObject, registered as `/Fx1`. */
  form?: string;
  /** Operators for a tiling pattern, registered as `/P1`. */
  pattern?: string;
}

async function rawPage(body: string, options: RawPage = {}): Promise<Uint8Array> {
  const doc = await openPDF(await pdfFixture([{ text: 'seed', rotation: options.rotation }]));
  const page = doc.getPages()[0];
  const resources = dictOf(doc, page.node.get(PDFName.of('Resources')));
  const fonts = resources?.lookup(PDFName.of('Font'), PDFDict);
  const face = fonts && [...fonts.keys()][0]?.asString();
  if (!resources || !face) throw new Error('the fixture page carries no font resource');
  const fill = (text: string) => text.split('/F1').join(face);
  if (options.pattern) {
    resources.set(PDFName.of('Pattern'), doc.context.obj({
      P1: doc.context.register(doc.context.stream(options.pattern, {
        Type: 'Pattern', PatternType: 1, PaintType: 1, TilingType: 1,
        BBox: [0, 0, 300, 20], XStep: 300, YStep: 20,
      })),
    }));
  }
  if (options.form) {
    resources.set(PDFName.of('XObject'), doc.context.obj({
      Fx1: doc.context.register(doc.context.stream(fill(options.form), {
        Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 400, 20],
      })),
    }));
  }
  page.node.set(CONTENTS_NAME, doc.context.register(doc.context.stream(fill(body))));
  return doc.save({ useObjectStreams: false });
}

/**
 * The fill and stroke colour in force at every text-showing operator, replayed
 * from the produced stream with `q`/`Q` restored — the state a viewer would be
 * in, so an assertion here is about what the file draws, not about which
 * operator a helper chose to look at.
 */
function coloursAtShows(stream: string): { fill: string; stroke: string }[] {
  let fill = 'default';
  let stroke = 'default';
  const stack: [string, string][] = [];
  const out: { fill: string; stroke: string }[] = [];
  for (const line of stream.split('\n').map((entry) => entry.trim()).filter(Boolean)) {
    const parts = line.split(' ');
    const op = parts[parts.length - 1] ?? '';
    const saved = stack[stack.length - 1];
    switch (op) {
      case 'q': stack.push([fill, stroke]); break;
      case 'Q':
        if (saved) [fill, stroke] = saved;
        stack.pop();
        break;
      case 'g': case 'rg': case 'k': case 'sc': case 'scn': fill = line; break;
      case 'G': case 'RG': case 'K': case 'SC': case 'SCN': stroke = line; break;
      case 'cs': fill = `space ${line}`; break;
      case 'CS': stroke = `space ${line}`; break;
      case 'Tj': case 'TJ': case "'": case '"': out.push({ fill, stroke }); break;
      default: break;
    }
  }
  return out;
}

describe('text-color recolours the run, and nothing else', () => {
  it('recolours a run that inherits the colour a rule was painted with', async () => {
    // Word and every print driver write a ruled line this way: set the colour,
    // paint the rule, then show the run with no colour of its own. Reading the
    // colour off the operator before the run saw the rule's `f` and gave up, so
    // the run stayed black while the card said it had been recoloured.
    const bytes = await rawPage('q\n0 0 0 rg\n40 470 300 3 re\nf\nBT\n/F1 12 Tf\n72 450 Td\n(Ruled) Tj\nET\nQ\n');
    const outcome = await run('text-color', { from: 'any', to: '#ff0000', pages: 'all' }, [pdfFile(bytes, 'rule.pdf')]);
    const page = (await reopen(outcome)).getPages()[0];
    const stream = streamText(page);
    // The control: the rule keeps the black it was painted with.
    expect(stream).toMatch(/0 0 0 rg\n40 470 300 3 re/);
    expect(coloursAtShows(stream).map((show) => show.fill)).toEqual(['1 0 0 rg']);
    expect(await pageText(page)).toContain('Ruled');
  });

  it('recolours a run set through a pattern space and puts the space back', async () => {
    // `/Pattern cs /P1 scn` is a colour, but `scn` is not a `rg`: the run was
    // skipped, and a plain `rg` written into a pattern space is ignored by a
    // reader, so the colour has to be stated in a DeviceRGB space and restored.
    const bytes = await rawPage(
      '/Pattern cs\n/P1 scn\nBT\n/F1 12 Tf\n72 500 Td\n(Pat) Tj\nET\nq\n0 0 0 rg\n40 470 300 3 re\nf\nQ\n',
      { pattern: '0 0 300 20 re f' },
    );
    const outcome = await run('text-color', { from: 'any', to: '#ff0000', pages: 'all' }, [pdfFile(bytes, 'pat.pdf')]);
    const stream = streamText((await reopen(outcome)).getPages()[0]);
    // Stated in a DeviceRGB space, and closed again straight after the show.
    expect(stream).toMatch(/q\n\/DeviceRGB cs\n1 0 0 scn\n\(Pat\) Tj\nQ/);
    // Restored before the rule, so the rule is not painted inside the wrapper.
    expect(stream.indexOf('Q', stream.indexOf('scn'))).toBeLessThan(stream.match(/^f$/mu)?.[0] ? stream.indexOf('\nf\n') : -1);
    expect(stream).toMatch(/0 0 0 rg\n40 470 300 3 re/);
  });

  it('counts the runs it recoloured, not the colour operators', async () => {
    // One `rg` in front of two shows used to count 1 for 2 changed runs.
    const bytes = await rawPage('BT\n/F1 12 Tf\n0 0 0 rg\n72 500 Td\n(One) Tj\n(Two) Tj\nET\n');
    const outcome = await run('text-color', { from: 'any', to: '#ff0000', pages: 'all' }, [pdfFile(bytes, 'two.pdf')]);
    expect(outcome.message).toMatch(/Recoloured 2 text runs to #ff0000/u);
    expect(coloursAtShows(streamText((await reopen(outcome)).getPages()[0]))).toHaveLength(2);
  });

  it('leaves an image and a Form XObject to themselves', async () => {
    const form = 'BT\n/F1 12 Tf\n0 0 0 rg\n10 5 Td\n(In form) Tj\nET\n';
    const bytes = await rawPage('q\n40 0 0 40 40 280 cm\n/Im1 Do\nQ\nq\n1 0 0 1 0 370 cm\n/Fx1 Do\nQ\n', { form });
    const doc = await openPDF(bytes);
    const resources = dictOf(doc, doc.getPages()[0].node.get(PDFName.of('Resources')))!;
    const xobjects = resources.lookup(PDFName.of('XObject'), PDFDict)!;
    xobjects.set(PDFName.of('Im1'), doc.context.register(
      doc.context.stream(JPEG_1PX, { Type: 'XObject', Subtype: 'Image', Width: 1, Height: 1 }),
    ));
    const before = await doc.save({ useObjectStreams: false });

    const outcome = await run('text-color', { from: 'any', to: '#ff0000', pages: 'all' }, [pdfFile(before, 'form.pdf')]);
    // The page's own stream holds no text, so there is nothing to recolour and
    // the count must not be invented from the words the XObject draws.
    expect(outcome.outputs).toHaveLength(0);
    expect(outcome.message).toMatch(/file is unchanged/u);
    const reloaded = await openPDF(before);
    const page = reloaded.getPages()[0];
    const outXObjects = dictOf(reloaded, page.node.get(PDFName.of('Resources')))?.lookup(PDFName.of('XObject'), PDFDict);
    const formStream = reloaded.context.lookup(outXObjects?.get(PDFName.of('Fx1'))!);
    expect(formStream).toBeInstanceOf(PDFStream);
    // The XObject's own operators still say black (the documented limit)…
    expect(Buffer.from((formStream as PDFStream).getContents()).toString('latin1')).toContain('0 0 0 rg');
    // …while the image is still an image, not a repainted operator.
    const image = dictOf(reloaded, outXObjects?.get(PDFName.of('Im1')));
    expect(image?.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString()).toBe('/Image');
  });

  it('paints a stroke-only run with the stroke colour, not the fill', async () => {
    const bytes = await rawPage('BT\n/F1 12 Tf\n1 Tr\n0 0 0 RG\n72 480 Td\n(Outline) Tj\nET\n');
    const outcome = await run('text-color', { from: 'any', to: '#ff0000', pages: 'all' }, [pdfFile(bytes, 'stroke.pdf')]);
    const shows = coloursAtShows(streamText((await reopen(outcome)).getPages()[0]));
    expect(shows).toHaveLength(1);
    expect(shows[0].stroke).toBe('1 0 0 RG');
    expect(shows[0].fill).not.toBe('1 0 0 rg');
  });

  it('gives a faux bold the stroke colour it strokes with', async () => {
    // `opts.bold` strokes the glyph, so it has to set the stroke as well as the
    // fill, and the width has to be in force before the show.
    const bytes = await rawPage('BT\n/F1 12 Tf\n0 0 0 rg\n72 500 Td\n(Bold) Tj\nET\n');
    const doc = await openPDF(bytes);
    recolourText(doc.getPages()[0], 'any', '#ff0000', { bold: true });
    const stream = streamText(doc.getPages()[0]);
    expect(stream).toMatch(/1 0 0 rg\n1 0 0 RG\n[\d.]+ w\n\(Bold\) Tj\n2 Tr/);
  });

  it('reports the run even when the text is already the chosen colour', async () => {
    const bytes = await rawPage('BT\n/F1 12 Tf\n0 0 0 rg\n72 500 Td\n(Same) Tj\nET\n');
    const outcome = await run('text-color', { from: 'any', to: '#000000', pages: 'all' }, [pdfFile(bytes, 'same.pdf')]);
    expect(outcome.outputs).toHaveLength(1);
    expect(outcome.message).toMatch(/Recoloured 1 text run to #000000/u);
    expect(await pageText((await reopen(outcome)).getPages()[0])).toContain('Same');
  });

  it('recolours a turned sheet and a /Contents that is an indirect array', async () => {
    const source = await openPDF(await rawPage('BT\n/F1 12 Tf\n0 0 0 rg\n72 200 Td\n(Turned) Tj\nET\n', { rotation: 90 }));
    const page = source.getPages()[0];
    // `/Contents 12 0 R` where 12 is an array of streams — what Acrobat writes.
    const own = page.node.get(CONTENTS_NAME)!;
    const indirect = source.context.register(source.context.obj([own]));
    page.node.set(CONTENTS_NAME, indirect);
    const outcome = await run('text-color', { from: 'any', to: '#ff0000', pages: 'all' }, [
      pdfFile(await source.save({ useObjectStreams: false }), 'turned.pdf'),
    ]);
    const reloaded = await reopen(outcome);
    const outPage = reloaded.getPages()[0];
    expect(outPage.getRotation().angle).toBe(90);
    expect(await pageText(outPage)).toContain('Turned');
    expect(coloursAtShows(streamText(outPage)).map((show) => show.fill)).toEqual(['1 0 0 rg']);
    // Never an array nested inside `/Contents`: every entry resolves to a stream.
    for (const entry of arrayOf(reloaded, outPage.node.get(CONTENTS_NAME))?.asArray() ?? []) {
      expect(reloaded.context.lookup(entry)).toBeInstanceOf(PDFStream);
    }
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

  /** A two-sheet form: one text field on each page, built by pdf-lib's own form code. */
  async function twoFieldForm(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    for (const label of ['first sheet', 'second sheet']) {
      const page = doc.addPage(A4);
      await drawTextU(page, { text: label, x: 40, y: A4[1] - 60, size: 14 });
    }
    const form = doc.getForm();
    form.createTextField('first.name').addToPage(doc.getPages()[0], { x: 40, y: 700, width: 200, height: 20 });
    form.createTextField('second.name').addToPage(doc.getPages()[1], { x: 40, y: 700, width: 200, height: 20 });
    return doc.save({ useObjectStreams: false });
  }

  /** The `/AcroForm /Fields` entries, and whether each still resolves to a field. */
  function fieldTree(doc: PDFDocument): { names: string[]; dangling: number } {
    // `lookup(..., PDFDict)` throws on a missing key, and the fix removes the
    // whole `/AcroForm` when it has no fields left.
    const acroForm = doc.catalog.get(PDFName.of('AcroForm'));
    if (!acroForm) return { names: [], dangling: 0 };
    const resolvedForm = doc.context.lookup(acroForm) as PDFDict | undefined;
    const fields = resolvedForm?.get(PDFName.of('Fields'));
    if (!fields) return { names: [], dangling: 0 };
    const array = doc.context.lookup(fields) as PDFArray | undefined;
    if (!array) return { names: [], dangling: 0 };
    const names: string[] = [];
    let dangling = 0;
    const walk = (list: PDFArray, prefix: string): void => {
    for (let i = 0; i < list.size(); i += 1) {
      const entry = list.get(i);
      // A deleted object leaves a ref that no longer resolves: the written file
      // then names a field no page draws (pypdf refuses it outright).
      const dict = doc.context.lookup(entry) as PDFDict | undefined;
      if (!dict) {
        dangling += 1;
        continue;
      }
      const name = dict.get(PDFName.of('T'));
      const text = name && 'decodeText' in name ? (name as { decodeText: () => string }).decodeText() : '?';
      const kids = dict.get(PDFName.of('Kids'));
      const kidArray = kids ? (doc.context.lookup(kids) as PDFArray | undefined) : undefined;
      if (kidArray) walk(kidArray, `${prefix}${text}.`);
      // A widget merged into its field carries no `/T` of its own.
      else names.push(text === '?' ? prefix.replace(/\.$/, '') : `${prefix}${text}`);
    }
    };
    walk(array, '');
    return { names, dangling };
  }

  it('takes the removed widgets out of /AcroForm so no field ref dangles', async () => {
    const bytes = await twoFieldForm();
    const outcome = await run('remove-annotations', { pages: 'all' }, [pdfFile(bytes, 'form.pdf')]);
    expect(outcome.message).toMatch(/Removed 2 annotations from 2 pages/u);
    expect(outcome.warnings.join('\n')).toMatch(/2 form fields went with their widgets/u);
    const cleared = await reopen(outcome);
    expect(fieldTree(cleared)).toEqual({ names: [], dangling: 0 });
    // An `/AcroForm` with nothing left is an empty shell; the catalog says so.
    expect(cleared.catalog.get(PDFName.of('AcroForm'))).toBeUndefined();
  });

  it('keeps the fields on pages it did not touch, and only those', async () => {
    const bytes = await twoFieldForm();
    const outcome = await run('remove-annotations', { pages: '1' }, [pdfFile(bytes, 'form.pdf')]);
    const cleared = await reopen(outcome);
    // The dotted name is a parent field with a widget kid; both survive, and the
    // kid still resolves (a dangling one is counted, not read).
    expect(fieldTree(cleared)).toEqual({ names: ['second.name'], dangling: 0 });
    expect(await pageText(cleared.getPages()[1])).toContain('second sheet');
  });

  it('strips a link that is the only mark a page carries', async () => {
    const bytes = await pdfFixture([{ text: 'link only' }]);
    const doc = await openPDF(bytes);
    addAnnotations(doc, [
      { kind: 'Link', page: 0, rect: { x: 40, y: 700, width: 160, height: 16 }, link: { type: 'uri', uri: 'https://example.test/x' } },
    ] as never);
    const marked = await doc.save({ useObjectStreams: false });
    const outcome = await run('remove-annotations', { pages: 'all' }, [pdfFile(marked, 'link.pdf')]);
    expect(outcome.message).toMatch(/Removed 1 annotation from 1 page/u);
    const cleared = await reopen(outcome);
    expect(listAnnotations(cleared)).toHaveLength(0);
    expect(await pageText(cleared.getPages()[0])).toContain('link only');
  });

  it('does not add the note pop-up to the annotations it counts outside the selection', async () => {
    // Page 1 carries a sticky note and its `/Popup`: two entries in `/Annots`,
    // one mark. The report has always split them; the "outside" sentence did not.
    const bytes = await pdfFixture([{ text: 'noted' }, { text: 'untouched' }]);
    const doc = await openPDF(bytes);
    addAnnotations(doc, [
      { kind: 'Text', page: 0, rect: { x: 40, y: 700, width: 20, height: 20 }, contents: 'a note' },
      { kind: 'Popup', page: 0, rect: { x: 62, y: 690, width: 120, height: 70 } },
    ] as never);
    const note = listAnnotations(doc).find((mark) => mark.kind === 'Text')!;
    const popup = listAnnotations(doc).find((mark) => mark.kind === 'Popup')!;
    (doc.context.lookup(popup.ref, PDFDict) as PDFDict).set(PDFName.of('Parent'), note.ref);
    (doc.context.lookup(note.ref, PDFDict) as PDFDict).set(PDFName.of('Popup'), popup.ref);
    const marked = await doc.save({ useObjectStreams: false });
    const outcome = await run('remove-annotations', { pages: '2' }, [pdfFile(marked, 'noted.pdf')]);
    expect(outcome.outputs).toHaveLength(0);
    expect(outcome.report?.sections?.[0]?.text).toMatch(/^What this document carries sits outside the 1 page you selected: 1 annotation and 1 note pop-up\./u);
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
