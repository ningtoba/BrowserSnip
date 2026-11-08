/**
 * Edge cases for the edit tools (worker B3).
 *
 * These tools write *into* the page, so every assertion is made against real
 * output bytes: fixtures are PDFs built with pdf-lib, each run goes through
 * `runPdfTool` (the same path the rail uses, including the guard, the field
 * clamps and the `warnings` channel), and the result is re-opened and read back
 * out of its content streams and annotation dictionaries.
 *
 * The rows that matter most for this category:
 * - E9 — a `/Rotate 90/180/270` page must not move or tilt a folio, watermark,
 *   header rule or stamp. The tests draw the same mark on a flat page and on its
 *   rotated twin and require the same place *as the reader sees it*, upright.
 * - E8 — a mixed-size document is measured per page, never from page 1.
 * - E11 — drawn text always goes through `core/fonts`; a Latin-only pick is
 *   substituted and admitted rather than crashing or printing blanks.
 * - E13/E15/E6/E7 — nothing to act on is a report, out-of-range values are
 *   clamped with a reason, a 1-page document rejects page 2, and 500 pages
 *   finish without repeating the same admission 500 times.
 *
 * No canvas is needed: the raster tools' session comes from a stubbed
 * `core/render`, and `core/fonts` is served the real vendored Noto faces from
 * `public/fonts/`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFStream,
  StandardFonts,
  degrees,
  rgb,
} from '@maxwbh/pdf-lib';
import type { PDFPage } from '@maxwbh/pdf-lib';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import type { RunOutcome } from '@/lib/pdf/tools/runner';
import { openPDF } from '@/lib/pdf/core/doc';
import { pageContentStreams, streamBytes } from '@/lib/pdf/core/content';
import { listAnnotations } from '@/lib/pdf/core/annotations';
import type { OcrPageResult } from '@/lib/pdf/core/ocr';

// ── stubs: jsdom has no canvas and no OCR model ─────────────────────────────

/** 1×1 black JPEG, embedded by the raster tools' output path. */
const JPEG_1PX =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
  + 'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA'
  + 'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==';
/** 1×1 black PNG, used as an image watermark and stamp. */
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function base64(data: string): Uint8Array {
  const raw = atob(data);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

interface RenderCall {
  page: number;
  scale: number;
  filter?: string;
}

/**
 * Sinks for calls the mocked modules receive. They live on `globalThis` because
 * a `vi.mock` factory is hoisted above this file's own declarations.
 */
function sink<T>(key: string): T[] {
  const scope = globalThis as unknown as Record<string, T[]>;
  return (scope[key] ??= []);
}

const renderCalls = (): RenderCall[] => sink<RenderCall>('__editRenders');
const fontRequests = (): string[] => sink<string>('__editFonts');

interface OcrCall {
  options: { pages?: string; dpi?: number; force?: boolean; lang?: string };
}

const ocrCalls = (): OcrCall[] => sink<OcrCall>('__editOcr');

/** Reads of a page canvas taken before pdf.js had painted it — see the double below. */
const earlyReads = (): number[] => sink<number>('__editEarlyReads');

vi.mock('@/lib/pdf/core/render', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pdf/core/render')>();
  // Standing rule 1: this double used to answer `getImageData` from one shared array
  // with no `finished` at all, so a caller that encoded the canvas before the paint
  // landed could not be told from one that waited — which is how three shipped tools
  // handed back a page of paper with 1,400 tests green. It now models the ordering:
  // background-fill pixels until the task settles, ink afterwards, in a later task.
  const paper = new Uint8ClampedArray(4 * 4 * 4).fill(255);
  const inked = new Uint8ClampedArray(paper);
  inked[0] = 0;
  inked[1] = 0;
  inked[2] = 0;
  let painted = false;
  const readCanvas = (where: string): void => {
    if (!painted) earlyReads().push(...(where === 'encode' ? [1, 1] : [1]));
  };
  const ctx = {
    getImageData: () => {
      readCanvas('read');
      return { data: new Uint8ClampedArray(painted ? inked : paper), width: 4, height: 4 };
    },
    putImageData: () => {},
  } as unknown as CanvasRenderingContext2D;
  const canvas = {} as HTMLCanvasElement;
  const session = {
    doc: {},
    numPages: 1,
    fingerprint: 'edit-edge-session',
    page: async () => ({ getViewport: () => ({ width: 595, height: 842, rotation: 0 }) }),
    renderToCanvas: async () => ({ width: 4, height: 4 }),
    renderPage: async (n: number, scale: number, opts: { filter?: string } = {}) => {
      renderCalls().push({ page: n, scale, filter: opts.filter });
      painted = false;
      let settle: () => void = () => {};
      let abort: (reason: Error) => void = () => {};
      const finished = new Promise<void>((resolve, reject) => {
        settle = resolve;
        abort = reject;
      });
      finished.catch(() => undefined);
      const timer = setTimeout(() => {
        painted = true;
        settle();
      }, 0);
      return {
        canvas,
        ctx,
        width: 4,
        height: 4,
        unitsPerPixel: 1 / scale,
        pageNumber: n,
        finished,
        cancel: () => {
          if (painted) return;
          clearTimeout(timer);
          abort(new actual.RenderCancelled('test render cancelled'));
        },
      };
    },
    textContent: async () => ({ items: [] }),
    textItems: async () => [],
    metadata: async () => ({ numPages: 1 }),
    attachments: async () => ({}),
    destroy: async () => {},
  };
  return {
    ...actual,
    openRender: async () => session,
    canvasToBlob: async () => {
      // Encoding is the read that matters: it is what copies the bitmap into the file.
      readCanvas('encode');
      return new Blob([base64(JPEG_1PX) as BlobPart], { type: 'image/jpeg' });
    },
  };
});

/**
 * `ocrDocument` is replaced with whatever the current test installs; the text
 * layer writer stays real, because that is the part that touches the PDF.
 */
vi.mock('@/lib/pdf/core/ocr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pdf/core/ocr')>();
  return {
    ...actual,
    ocrDocument: async (_session: unknown, options: OcrCall['options']) => {
      ocrCalls().push({ options });
      const next = (globalThis as unknown as { __editOcrResult?: () => OcrPageResult[] }).__editOcrResult;
      if (!next) throw new Error('no OCR result installed for this test');
      return next();
    },
  };
});

function giveOcrPages(pages: OcrPageResult[]): void {
  (globalThis as unknown as { __editOcrResult?: () => OcrPageResult[] }).__editOcrResult = () => pages;
}

/** Make `ocrDocument` throw the error the real module would throw. */
function failOcr(error: Error): void {
  (globalThis as unknown as { __editOcrResult?: () => OcrPageResult[] }).__editOcrResult = () => {
    throw error;
  };
}

// ── fixtures ────────────────────────────────────────────────────────────────

const A4: [number, number] = [595.28, 841.89];
const CARD: [number, number] = [105, 60];
const LANDSCAPE: [number, number] = [841.89, 595.28];

interface PageSpec {
  size: [number, number];
  rotation?: number;
  text?: string;
}

async function fixture(pages: PageSpec[] = [{ size: A4, text: 'Fixture body' }], title = 'Edge fixture'): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const spec of pages) {
    const page = doc.addPage(spec.size);
    if (spec.rotation) page.setRotation(degrees(spec.rotation));
    if (spec.text) {
      page.drawText(spec.text, { x: 40, y: spec.size[1] - 60, size: 14, font, color: rgb(0, 0, 0) });
    }
  }
  doc.setTitle(title);
  return doc.save({ useObjectStreams: false });
}

function pdfFile(bytes: Uint8Array, name: string): File {
  return new File([new Uint8Array(bytes) as BlobPart], name, { type: 'application/pdf' });
}

async function files(...specs: [Uint8Array, string][]): Promise<File[]> {
  return specs.map(([bytes, name]) => pdfFile(bytes, name));
}

async function run(
  id: string,
  values: Record<string, unknown> = {},
  inputs?: Uint8Array[],
  names = ['fixture.pdf'],
): Promise<RunOutcome> {
  expect(getPdfTool(id), `tool "${id}" is not registered`).toBeTruthy();
  const bytes = inputs ?? [await fixture()];
  const outcome = await runPdfTool({
    toolId: id,
    files: bytes.map((source, index) => pdfFile(source, names[index] ?? `file-${index + 1}.pdf`)),
    values,
    onProgress: () => {},
    onLog: () => {},
  });
  expect(outcome, `${id} produced no outcome`).toBeTruthy();
  return outcome!;
}

async function outputBytes(outcome: RunOutcome, index = 0): Promise<Uint8Array> {
  expect(outcome.outputs.length, 'expected a downloadable output').toBeGreaterThan(index);
  return new Uint8Array(await outcome.outputs[index]!.blob.arrayBuffer());
}

// ── reading drawn text back ─────────────────────────────────────────────────

interface FontText {
  /** Identity-H: the content stream holds 2-byte glyph ids. */
  composite: boolean;
  unicode: Map<number, string>;
}

interface DrawnRun {
  text: string;
  /** Bytes or glyph ids shown by the run, as the content stream holds them. */
  codes: number[];
  /** One entry per glyph: Identity-H runs pair the bytes up first. */
  glyphs: number[];
  /** Glyph origin in unrotated PDF user space. */
  x: number;
  y: number;
  /** Text rotation in degrees, in PDF user space. */
  angle: number;
  size: number;
}

function decodeHexPairs(hex: string): string {
  const bytes = (hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16));
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
  return out;
}

/** The `bfchar` and `bfrange` forms of a `/ToUnicode` CMap. */
function parseToUnicode(text: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const section of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const entry of section[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(parseInt(entry[1]!, 16), decodeHexPairs(entry[2]!));
    }
  }
  for (const section of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const entry of section[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const low = parseInt(entry[1]!, 16);
      const high = parseInt(entry[2]!, 16);
      const first = parseInt(entry[3]!, 16);
      for (let code = low; code <= high; code++) map.set(code, String.fromCharCode(first + code - low));
    }
  }
  return map;
}

function pageFonts(page: PDFPage): Map<string, FontText> {
  const doc = page.doc;
  const fonts = new Map<string, FontText>();
  const resources = doc.context.lookupMaybe(page.node.get(PDFName.of('Resources')), PDFDict);
  const fontDict = resources && doc.context.lookupMaybe(resources.get(PDFName.of('Font')), PDFDict);
  if (!fontDict) return fonts;
  for (const [name, value] of fontDict.entries()) {
    const dict = doc.context.lookupMaybe(value, PDFDict);
    if (!dict) continue;
    const stream = doc.context.lookupMaybe(dict.get(PDFName.of('ToUnicode')), PDFStream);
    fonts.set(name.decodeText(), {
      composite: dict.get(PDFName.of('DescendantFonts')) !== undefined,
      unicode: stream ? parseToUnicode(new TextDecoder('latin1').decode(streamBytes(stream))) : new Map(),
    });
  }
  return fonts;
}

const MATRIX = /((?:[-\d.e+]+\s+){5}[-\d.e+]+)\s+Tm/g;
const SELECT_FONT = /\/([\w.-]+)\s+([\d.]+)\s+Tf/g;
const SHOW = /<([0-9A-Fa-f]+)>\s*Tj/g;

/**
 * Every text run on the page, decoded through the fonts' own `/ToUnicode` maps,
 * with the matrix it was drawn in — the only way to assert both *what* a tool
 * wrote and *where* it wrote it.
 */
function drawnRuns(page: PDFPage): DrawnRun[] {
  const fonts = pageFonts(page);
  const runs: DrawnRun[] = [];
  for (const { bytes } of pageContentStreams(page)) {
    const stream = Buffer.from(bytes).toString('latin1');
    const marks = [
      ...[...stream.matchAll(SELECT_FONT)].map((match) => ({ at: match.index!, kind: 'font' as const, match })),
      ...[...stream.matchAll(MATRIX)].map((match) => ({ at: match.index!, kind: 'matrix' as const, match })),
      ...[...stream.matchAll(SHOW)].map((match) => ({ at: match.index!, kind: 'show' as const, match })),
    ].sort((a, b) => a.at - b.at);
    let font: FontText = { composite: false, unicode: new Map() };
    let size = 0;
    let matrix: number[] | null = null;
    for (const mark of marks) {
      if (mark.kind === 'font') {
        font = fonts.get(mark.match[1]!) ?? font;
        size = Number(mark.match[2]);
      } else if (mark.kind === 'matrix') {
        matrix = mark.match[1]!.trim().split(/\s+/).map(Number);
      } else if (mark.kind === 'show' && matrix) {
        const codes = (mark.match[1]!.match(/../g) ?? []).map((hex) => parseInt(hex, 16));
        let text: string;
        if (font.composite) {
          text = '';
          for (let i = 0; i + 1 < codes.length; i += 2) text += font.unicode.get((codes[i]! << 8) | codes[i + 1]!) ?? '';
        } else {
          text = new TextDecoder('latin1').decode(Uint8Array.from(codes));
        }
        runs.push({
          text,
          codes,
          glyphs: font.composite ? codes.filter((_, i) => i % 2 === 1).map((_, i) => codes[2 * i]! << 8 | codes[2 * i + 1]!) : codes,
          x: matrix[4]!,
          y: matrix[5]!,
          angle: Math.round((Math.atan2(matrix[1]!, matrix[0]!) * 180) / Math.PI),
          size,
        });
      }
    }
  }
  return runs;
}

/** The page's crop box, its normalised `/Rotate`, and the size a viewer shows. */
function geometry(page: PDFPage) {
  const box = page.node.lookupMaybe(PDFName.of('CropBox'), PDFArray)
    ?? page.node.lookupMaybe(PDFName.of('MediaBox'), PDFArray);
  const values = (box?.asArray() ?? []).map((value) => (value instanceof PDFNumber ? value.asNumber() : 0));
  const [left = 0, bottom = 0, right = 0, top = 0] = values;
  const width = right - left;
  const height = top - bottom;
  const rotation = (((Math.round(page.getRotation().angle / 90) * 90) % 360) + 360) % 360;
  const quarter = rotation === 90 || rotation === 270;
  return {
    x: left,
    y: bottom,
    width,
    height,
    rotation,
    viewWidth: quarter ? height : width,
    viewHeight: quarter ? width : height,
  };
}

/**
 * A page-space point in the coordinates a viewer shows, origin bottom-left of
 * the *displayed* page. Written out here independently of `tools/edit.ts`, so a
 * shared mistake in the module's maths cannot make its own test pass.
 */
function viewPoint(page: PDFPage, px: number, py: number): { x: number; y: number } {
  const box = geometry(page);
  if (box.rotation === 90) return { x: py - box.y, y: box.x + box.width - px };
  if (box.rotation === 180) return { x: box.x + box.width - px, y: box.y + box.height - py };
  if (box.rotation === 270) return { x: box.y + box.height - py, y: px - box.x };
  return { x: px - box.x, y: py - box.y };
}

/** The mark the tool just added: the last text run painted on the page. */
function stampedRun(page: PDFPage): DrawnRun {
  const runs = drawnRuns(page);
  expect(runs.length, 'the tool drew no text').toBeGreaterThan(0);
  return runs[runs.length - 1]!;
}

const angleError = (run: DrawnRun, page: PDFPage): number =>
  (((run.angle - geometry(page).rotation) % 360) + 360) % 360;

// ── tests ───────────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;

beforeAll(() => {
  // `core/fonts` fetches the face it needs by URL. Serve the vendored Latin one
  // for every request, and record the URLs: a CJK string must ask for a script
  // face, which is the part the app controls.
  const face = (file: string): Uint8Array => new Uint8Array(readFileSync(join(process.cwd(), 'public', 'fonts', file)));
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    fontRequests().push(url);
    const local = /NotoSans-(Regular|Bold)\.ttf$/.exec(url);
    return new Response(face(local ? local[0] : 'NotoSans-Regular.ttf'), { headers: { 'content-type': 'font/ttf' } });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  delete (globalThis as unknown as Record<string, unknown>).__editOcrResult;
});

describe('page numbers (E6, E7, E8, E9, E11, E13, E15)', () => {
  it('puts the folio in the same visual corner on every rotated page', async () => {
    const bytes = await fixture([
      { size: A4 },
      { size: A4, rotation: 90 },
      { size: A4, rotation: 180 },
      { size: A4, rotation: 270 },
    ], 'rotated');
    const outcome = await run('page-numbers', { position: 'bottom-left', margin: 24, fontSize: 11, pages: 'all' }, [bytes]);
    const doc = await openPDF(await outputBytes(outcome));
    expect(doc.getPageCount()).toBe(4);
    doc.getPages().forEach((page) => {
      const mark = stampedRun(page);
      const point = viewPoint(page, mark.x, mark.y);
      expect(point.x, `rotation ${geometry(page).rotation}`).toBeCloseTo(24, 1);
      expect(point.y, `rotation ${geometry(page).rotation}`).toBeCloseTo(24, 1);
      expect(angleError(mark, page), `rotation ${geometry(page).rotation}`).toBeCloseTo(0, 3);
    });
  });

  it('measures each page on its own instead of trusting page 1 (E8)', async () => {
    const bytes = await fixture([{ size: A4 }, { size: CARD }, { size: LANDSCAPE }], 'mixed');
    const outcome = await run('page-numbers', { position: 'bottom-center', margin: 8, fontSize: 40, pages: 'all' }, [bytes]);
    const doc = await openPDF(await outputBytes(outcome));
    const marks = doc.getPages().map((page) => {
      const mark = stampedRun(page);
      return { page, point: viewPoint(page, mark.x, mark.y), view: geometry(page) };
    });
    // Centred means "half of *that* page": three widths, three positions.
    expect(marks[1]!.point.x).toBeLessThan(marks[0]!.point.x);
    expect(marks[2]!.point.x).toBeGreaterThan(marks[0]!.point.x);
    for (const mark of marks) {
      expect(mark.point.y, `rotation ${geometry(mark.page).rotation}`).toBeCloseTo(8, 1);
    }
    for (const mark of [marks[0]!, marks[2]!]) {
      expect(mark.point.x).toBeGreaterThanOrEqual(0);
      expect(mark.point.x).toBeLessThan(mark.view.viewWidth);
    }
    // The card's folio is wider than the sheet, so it hangs off evenly.
    expect(marks[1]!.point.x).toBeLessThan(0);
    // The business card cannot hold the folio and says so.
    expect(outcome.warnings.join('\n')).toMatch(/does not fit inside a 105×60 pt page/i);
  });

  it('accepts page 1 of a single-page document and refuses page 2 (E6)', async () => {
    const single = [await fixture([{ size: A4 }], 'one page')];
    const ok = await run('page-numbers', { pages: '1' }, single);
    expect(ok.message).toMatch(/Numbered 1 page/i);
    await expect(run('page-numbers', { pages: '2' }, single)).rejects.toThrow(/has 1 page/i);
    await expect(run('add-stamps', { pages: '2' }, single)).rejects.toThrow(/has 1 page/i);
    await expect(run('watermark', { type: 'text', text: 'X', pages: '2' }, single)).rejects.toThrow(/has 1 page/i);
  });

  it('numbers from the value asked for and ends where the last folio is', async () => {
    const outcome = await run('page-numbers', { startAt: 7, prefix: 'Page ', suffix: ' of {total}' });
    const doc = await openPDF(await outputBytes(outcome));
    expect(stampedRun(doc.getPage(0)).text).toBe('Page 7 of 7');
  });

  it('restarts the count on the first numbered page, not mid-sequence', async () => {
    const bytes = await fixture(Array.from({ length: 4 }, () => ({ size: A4 })), 'four');
    const outcome = await run('page-numbers', { pages: 'all', skip: 1, step: 2, startAt: 1, prefix: '', suffix: '/{total}' }, [bytes]);
    expect(outcome.message).toMatch(/Numbered 2 pages/i);
    const doc = await openPDF(await outputBytes(outcome));
    expect(doc.getPages().map((page) => drawnRuns(page).map((run) => run.text).join('|'))).toEqual(['', '1/2', '', '2/2']);
  });

  it('says so when the options leave nothing to number (E13)', async () => {
    const outcome = await run('page-numbers', { pages: 'all', skip: 9 });
    expect(outcome.outputs).toHaveLength(0);
    expect(outcome.message).toMatch(/no page was numbered/i);
    expect(outcome.report?.sections?.[0]?.text).toMatch(/skip first 1/i);
    expect(outcome.warnings.join('\n')).toMatch(/Skip first N pages must be between 0 and 1: 9 became 1/i);
  });

  it('clamps nonsense values, reports each, and draws with the fixed ones (E15)', async () => {
    const outcome = await run('page-numbers', { fontSize: 0, margin: -40, step: 1.6, startAt: -5 });
    const joined = outcome.warnings.join('\n');
    expect(joined).toMatch(/Font size must be between 5 and 72 pt: 0 became 5/i);
    expect(joined).toMatch(/Margin must be between 0 and 200 pt: -40 became 0/i);
    expect(joined).toMatch(/First number must be between 0 and 100000: -5 became 0/i);
    const doc = await openPDF(await outputBytes(outcome));
    expect(stampedRun(doc.getPage(0)).size).toBeCloseTo(5, 3);
  });

  it('renders CJK, accents and emoji instead of crashing (E11)', async () => {
    const outcome = await run('page-numbers', { prefix: '第 ', suffix: ' ページ ✔ café' });
    const doc = await openPDF(await outputBytes(outcome));
    expect(stampedRun(doc.getPage(0)).text).toContain('café');
    // A subset font without a `/ToUnicode` CMap would copy out as noise.
    expect([...pageFonts(doc.getPage(0)).values()].every((font) => !font.composite || font.unicode.size > 0)).toBe(true);
    expect(fontRequests().join(' ')).toMatch(/noto-sans-jp/i);
  });

  it('substitutes a Unicode face when a Latin-only typeface cannot encode the text (E11)', async () => {
    const outcome = await run('page-numbers', { font: 'helvetica', prefix: '承认 ' });
    expect(outcome.warnings.join('\n')).toMatch(/cannot render/i);
    const doc = await openPDF(await outputBytes(outcome));
    expect(stampedRun(doc.getPage(0)).text.length).toBeGreaterThan(0);
  });

  it('keeps a Latin folio in the standard face that was asked for (E11)', async () => {
    const outcome = await run('page-numbers', { font: 'helvetica', prefix: 'Page ' });
    expect(outcome.warnings).toEqual([]);
    const doc = await openPDF(await outputBytes(outcome));
    expect(stampedRun(doc.getPage(0)).text).toBe('Page 1 of 1');
  });

  it('handles a 500-page document without freezing or repeating itself (E7)', async () => {
    const many = await fixture(Array.from({ length: 500 }, () => ({ size: A4 })), 'deep');
    const started = Date.now();
    let lastProgress = 0;
    const outcome = await runPdfTool({
      toolId: 'page-numbers',
      files: [pdfFile(many, 'deep.pdf')],
      values: { pages: 'all', margin: 400 },
      onProgress: (fraction) => { lastProgress = fraction; },
      onLog: () => {},
    });
    expect(Date.now() - started).toBeLessThan(120_000);
    expect(lastProgress).toBe(1);
    const doc = await openPDF(await outputBytes(outcome!));
    expect(doc.getPageCount()).toBe(500);
    for (const page of doc.getPages().slice(0, 8)) expect(drawnRuns(page)).toHaveLength(1);
    expect(outcome!.message).toMatch(/Numbered 500 pages/i);
    // One admission per distinct problem, not one per page.
    expect(outcome!.warnings).toHaveLength(1);
    expect(outcome!.warnings[0]).toMatch(/Margin must be between 0 and 200 pt: 400 became 200/i);
  });
});

describe('watermark (E9, E11, E13, E15, E18)', () => {
  const mark = { type: 'text', text: 'DRAFT', fontSize: 40, rotation: 0, position: 'center' };

  it('marks the same view the same way, whether the sheet is turned or stored that way (E9)', async () => {
    // Page 1 is a portrait sheet shown sideways; page 2 is the same view stored
    // as landscape. If geometry honoured /Rotate the two marks must coincide.
    const bytes = await fixture([{ size: A4, rotation: 90 }, { size: LANDSCAPE }], 'twin');
    const outcome = await run('watermark', { ...mark, rotation: 45 }, [bytes]);
    const doc = await openPDF(await outputBytes(outcome));
    const [turned, stored] = doc.getPages().map((page) => {
      const drawn = stampedRun(page);
      return { page, point: viewPoint(page, drawn.x, drawn.y), angle: drawn.angle, rotation: geometry(page).rotation };
    });
    expect(turned!.point.x).toBeCloseTo(stored!.point.x, 1);
    expect(turned!.point.y).toBeCloseTo(stored!.point.y, 1);
    // 45° to the reader is 45° plus the page's own turn, in PDF user space.
    expect(((turned!.angle - 45 - turned!.rotation) % 360 + 360) % 360).toBeCloseTo(0, 3);
    expect(((stored!.angle - 45) % 360 + 360) % 360).toBeCloseTo(0, 3);
  });

  it('paints "behind content" in front of the page operators (E13)', async () => {
    const bytes = await fixture([{ size: A4, text: 'Body text that must stay on top' }], 'order');
    const behind = await run('watermark', { ...mark, layer: 'under' }, [bytes]);
    const over = await run('watermark', { ...mark, layer: 'over' }, [bytes]);
    const streamsOf = async (outcome: RunOutcome): Promise<string[]> => {
      const doc = await openPDF(await outputBytes(outcome));
      return pageContentStreams(doc.getPage(0)).map(({ bytes: raw }) => Buffer.from(raw).toString('latin1'));
    };
    // The mark is drawn at 40 pt, the fixture body at 14 pt, so the two streams
    // are recognisable: /Contents is painted in order, front to back.
    const order = async (outcome: RunOutcome): Promise<[number, number]> => {
      const streams = await streamsOf(outcome);
      return [streams.findIndex((text) => /\b40 Tf\b/.test(text)), streams.findIndex((text) => /\b14 Tf\b/.test(text))];
    };
    const [underMark, underBody] = await order(behind);
    const [overMark, overBody] = await order(over);
    expect(underMark, 'the watermark stream was not found').toBeGreaterThanOrEqual(0);
    expect(underMark).toBeLessThan(underBody);
    expect(overMark).toBeGreaterThan(overBody);
    expect(behind.message).toMatch(/behind the page content/i);
  });

  it('offers a way to supply the image it asks for (E13)', async () => {
    const tool = getPdfTool('watermark')!;
    expect(tool.fields!.find((field) => field.key === 'image'), 'the image watermark had no file field')
      .toMatchObject({ type: 'file', accept: 'image/*' });

    const bytes = await fixture([{ size: A4 }], 'logo');
    const outcome = await run('watermark', {
      type: 'image',
      image: { name: 'logo.png', mimeType: 'image/png', bytes: base64(PNG_1PX), size: 70 },
      scale: 0.5,
      position: 'top-left',
      opacity: 1,
    }, [bytes]);
    expect(outcome.message).toMatch(/with your image/i);
    const doc = await openPDF(await outputBytes(outcome));
    const stream = pageContentStreams(doc.getPage(0)).map(({ bytes: raw }) => Buffer.from(raw).toString('latin1')).join('\n');
    expect(stream).toMatch(/\/Im?\d*[A-Za-z0-9_-]*\s+Do/);
  });

  it('refuses the inputs it cannot honour (E18)', async () => {
    await expect(run('watermark', { type: 'text', text: '   ' })).rejects.toThrow(/enter the watermark text/i);
    await expect(run('watermark', { type: 'image' })).rejects.toThrow(/choose the image/i);
  });

  it('clamps opacity, angle, size and spacing and says so (E15)', async () => {
    const outcome = await run('watermark', {
      type: 'text', text: 'X', opacity: 0, rotation: 999, fontSize: 900, tile: true, tileGap: 0.01,
    });
    const joined = outcome.warnings.join('\n');
    expect(joined).toMatch(/Opacity must be between 0.02 and 1: 0 became 0.02/i);
    expect(joined).toMatch(/Angle must be between -180 and 180 °: 999 became 180/i);
    expect(joined).toMatch(/Font size must be between 6 and 400 pt: 900 became 400/i);
    expect(joined).toMatch(/Pattern spacing must be between 0.2 and 5: 0.01 became 0.2/i);
  });

  it('caps a pattern that would repeat forever on a big sheet (E7)', async () => {
    const bytes = await fixture([{ size: A4 }], 'tile');
    const outcome = await run('watermark', { type: 'text', text: 'AB', fontSize: 6, tile: true, tileGap: 0.2 }, [bytes]);
    expect(outcome.warnings.join('\n')).toMatch(/limited to 400 repeats/i);
    const doc = await openPDF(await outputBytes(outcome));
    expect(drawnRuns(doc.getPage(0))).toHaveLength(400);
  });

  it('writes a CJK watermark as embedded glyphs, not blanks (E11)', async () => {
    const outcome = await run('watermark', { type: 'text', text: '承認済み', fontSize: 48 });
    const doc = await openPDF(await outputBytes(outcome));
    // Four characters became four glyph ids in an embedded subset face; the
    // subset maps back to Unicode so a viewer can still select them.
    const mark = stampedRun(doc.getPage(0));
    expect(mark.glyphs).toHaveLength(4);
    expect(fontRequests().some((url) => /noto-sans-(jp|sc)/i.test(url))).toBe(true);
  });

  it('places middle-left and middle-right where they say they go', async () => {
    const bytes = await fixture([{ size: A4 }, { size: A4 }], 'sides');
    const outcome = await run('watermark', { type: 'text', text: 'SIDE', fontSize: 10, rotation: 0, tile: false }, [bytes]);
    void outcome;
    const left = await run('watermark', { type: 'text', text: 'SIDE', fontSize: 10, rotation: 0, position: 'center-left', tile: false }, [bytes]);
    const right = await run('watermark', { type: 'text', text: 'SIDE', fontSize: 10, rotation: 0, position: 'center-right', tile: false }, [bytes]);
    const firstDoc = await openPDF(await outputBytes(left));
    const lastDoc = await openPDF(await outputBytes(right));
    const a = viewPoint(firstDoc.getPage(0), stampedRun(firstDoc.getPage(0)).x, stampedRun(firstDoc.getPage(0)).y);
    const b = viewPoint(lastDoc.getPage(0), stampedRun(lastDoc.getPage(0)).x, stampedRun(lastDoc.getPage(0)).y);
    expect(a.x).toBeLessThan(b.x);
    expect(Math.abs(a.x - 0)).toBeLessThan(1);
  });
});

describe('headers and footers (E8, E9, E13)', () => {
  it('draws the slots and the rule where the reader sees them, on a turned page', async () => {
    const bytes = await fixture([{ size: A4 }, { size: A4, rotation: 270 }], 'hf');
    const outcome = await run('header-footer', {
      headerLeft: 'HEAD',
      headerCenter: '',
      headerRight: '',
      footerLeft: '',
      footerCenter: '',
      footerRight: '',
      margin: 30,
      fontSize: 9,
      rule: true,
      pages: 'all',
    }, [bytes]);
    const doc = await openPDF(await outputBytes(outcome));
    for (const page of doc.getPages()) {
      const view = geometry(page);
      const mark = stampedRun(page);
      const point = viewPoint(page, mark.x, mark.y);
      expect(point.x, `rotation ${view.rotation}`).toBeCloseTo(30, 1);
      expect(point.y, `rotation ${view.rotation}`).toBeCloseTo(view.viewHeight - 30 - 9, 1);
      expect(angleError(mark, page), `rotation ${view.rotation}`).toBeCloseTo(0, 3);

      const stream = pageContentStreams(page).map(({ bytes: raw }) => Buffer.from(raw).toString('latin1')).join('\n');
      const corners = [...stream.matchAll(/([-\d.]+) ([-\d.]+) (?:m|l)/g)].map((m) => [Number(m[1]), Number(m[2])]);
      expect(corners.length, 'the hairline rule was not drawn').toBeGreaterThan(1);
      for (const [x, y] of corners) {
        // A rule drawn in page space instead of view space lands outside the
        // sheet on a quarter-turned page.
        expect(x, `rotation ${view.rotation}`).toBeGreaterThanOrEqual(view.x - 0.01);
        expect(x, `rotation ${view.rotation}`).toBeLessThanOrEqual(view.x + view.width + 0.01);
        expect(y, `rotation ${view.rotation}`).toBeGreaterThanOrEqual(view.y - 0.01);
        expect(y, `rotation ${view.rotation}`).toBeLessThanOrEqual(view.y + view.height + 0.01);
      }
    }
  });

  it('warns when the three slots cannot share one line on a narrow page (E8)', async () => {
    const bytes = await fixture([{ size: CARD }, { size: A4 }], 'narrow');
    const outcome = await run('header-footer', {
      headerLeft: 'left text',
      headerCenter: 'middle text',
      headerRight: 'right text',
      footerLeft: '',
      footerCenter: '',
      footerRight: '',
      fontSize: 9,
      margin: 4,
      rule: false,
    }, [bytes]);
    expect(outcome.warnings.join('\n')).toMatch(/header text is wider than a 105 pt page/i);
  });

  it('refuses to run with nothing to draw (E13)', async () => {
    await expect(run('header-footer', {
      headerLeft: '',
      headerCenter: '',
      headerRight: '',
      footerLeft: '',
      footerCenter: '',
      footerRight: '  ',
    })).rejects.toThrow(/nothing to add/i);
  });

  it('fills the page fields in per page', async () => {
    const bytes = await fixture([{ size: A4 }, { size: A4 }], 'Deep fixture');
    const outcome = await run('header-footer', {
      headerLeft: '',
      headerCenter: '{title}',
      headerRight: '',
      footerLeft: '',
      footerCenter: 'page {page}/{total}',
      footerRight: '',
      rule: false,
    }, [bytes]);
    const doc = await openPDF(await outputBytes(outcome));
    const texts = doc.getPages().map((page) => drawnRuns(page).map((run) => run.text).join(' '));
    expect(texts[0]).toContain('Deep fixture');
    expect(texts[1]).toContain('page 2/2');
  });
});

describe('Bates numbering (E9, E15, E16)', () => {
  it('counts the numbers it actually wrote, restarting per file when asked', async () => {
    const two = await fixture([{ size: A4 }, { size: A4 }], 'one');
    const inputs = await files([two, 'a.pdf'], [two, 'b.pdf']);
    const across = await runPdfTool({ toolId: 'bates-numbering', files: inputs, values: { format: '{n}', digits: 3, start: 1 } });
    expect(across!.message).toMatch(/Applied 4 Bates numbers across 2 files/i);
    const secondFile = await openPDF(await outputBytes(across!, 1));
    expect(drawnRuns(secondFile.getPage(0)).map((run) => run.text)).toEqual(['003']);

    const restarted = await runPdfTool({ toolId: 'bates-numbering', files: inputs, values: { format: '{n}', digits: 3, start: 1, perFile: true } });
    expect(restarted!.message).toMatch(/restarting at each file/i);
    const second = await openPDF(await outputBytes(restarted!, 1));
    expect(drawnRuns(second.getPage(0)).map((run) => run.text)).toEqual(['001']);
  });

  it('clamps a number width of zero and stamps a rotated page upright (E9, E15)', async () => {
    const bytes = await fixture([{ size: A4, rotation: 90 }], 'turn');
    const outcome = await run('bates-numbering', { format: '{prefix}-{n}', digits: 0, start: 5 }, [bytes]);
    expect(outcome.warnings.join('\n')).toMatch(/Number width must be between 1 and 12: 0 became 1/i);
    const doc = await openPDF(await outputBytes(outcome));
    const page = doc.getPage(0);
    const mark = stampedRun(page);
    expect(mark.text).toBe('DOC-5');
    expect(angleError(mark, page)).toBeCloseTo(0, 3);
    const point = viewPoint(page, mark.x, mark.y);
    expect(point.x).toBeGreaterThanOrEqual(0);
    expect(point.y).toBeGreaterThanOrEqual(0);
  });

  it('names a duplicate document instead of stamping it silently twice (E16)', async () => {
    const bytes = await fixture([{ size: A4 }], 'same');
    const outcome = await runPdfTool({
      toolId: 'bates-numbering',
      files: [pdfFile(bytes, 'same.pdf'), pdfFile(bytes, 'same.pdf')],
      values: { format: '{n}' },
    });
    expect(outcome!.warnings.join('\n')).toMatch(/both were stamped/i);
    expect(outcome!.outputs).toHaveLength(2);
  });
});

describe('page labels, bookmarks and contents (E6, E13, E15)', () => {
  it('reports every range it could not use, and every range that runs longer than typed (E15)', async () => {
    const outcome = await run('add-page-labels', { ranges: '1-2 alpha\n9-11 roman 1\nnonsense line\n1-1 decimal' });
    const joined = outcome.warnings.join('\n');
    expect(joined).toMatch(/"9-11 roman 1" starts at page 9/i);
    expect(joined).toMatch(/"nonsense line" was not read/i);
    expect(joined).toMatch(/Two ranges start at page 1/i);
    const doc = await openPDF(await outputBytes(outcome));
    expect(doc.getPageCount()).toBe(1);
  });

  it('refuses a document with no usable range instead of saving it unchanged (E13)', async () => {
    await expect(run('add-page-labels', { ranges: '40-50 roman' })).rejects.toThrow(/starts at page 40, but this document has 1 page/i);
  });

  it('labels a single-page document from page 1 (E6)', async () => {
    const outcome = await run('add-page-labels', { ranges: '1-1 roman 1' });
    expect(outcome.message).toMatch(/now read: i\b/i);
    expect(outcome.warnings).toEqual([]);
  });

  it('appends instead of replacing when asked, and admits dead links (E15)', async () => {
    const { writeOutline, readOutline } = await import('@/lib/pdf/core/bookmarks');
    const doc = await openPDF(await fixture([{ size: A4 }, { size: A4 }], 'seeded'));
    writeOutline(doc, [{ title: 'Existing', page: 0 }]);
    const bytes = await doc.save({ useObjectStreams: false });

    const appended = await run('bookmarks', { outline: 'New chapter :: 2\nGhost :: 9', replace: false }, [bytes]);
    expect(appended.warnings.join('\n')).toMatch(/1 entry named a page outside this 2-page document/i);
    const after = await openPDF(await outputBytes(appended));
    expect(readOutline(after).map((node) => node.title)).toEqual(['Existing', 'New chapter', 'Ghost']);

    const replaced = await run('bookmarks', { outline: 'Only this :: 1', replace: true }, [bytes]);
    expect(replaced.message).toMatch(/replacing the 1 bookmark already in the document/i);
    const afterReplace = await openPDF(await outputBytes(replaced));
    expect(readOutline(afterReplace).map((node) => node.title)).toEqual(['Only this']);
  });

  it('says so when there are no bookmarks and nothing was typed (E13)', async () => {
    const outcome = await run('bookmarks', { outline: '' });
    expect(outcome.outputs).toHaveLength(0);
    expect(outcome.message).toMatch(/no bookmarks found/i);
  });

  it('inserts the contents page inside the document and says where (E6, E15)', async () => {
    const { writeOutline } = await import('@/lib/pdf/core/bookmarks');
    const doc = await openPDF(await fixture([{ size: A4 }, { size: A4 }], 'toc'));
    writeOutline(doc, [{ title: 'Start', page: 0 }, { title: 'Later', page: 1 }]);
    const bytes = await doc.save({ useObjectStreams: false });

    const outcome = await run('table-of-contents', { insertAt: 99, title: 'Contents' }, [bytes]);
    expect(outcome.warnings.join('\n')).toMatch(/Insert at page must be between 1 and 2: 99 became 2/i);
    const after = await openPDF(await outputBytes(outcome));
    expect(after.getPageCount()).toBe(3);
    expect(outcome.message).toMatch(/table of contents at page 2, listing 2 entries/i);
    expect(drawnRuns(after.getPage(1)).map((run) => run.text).join(' ')).toContain('Contents');
  });

  it('refuses to invent a contents page for a document with no outline (E13)', async () => {
    await expect(run('table-of-contents', {})).rejects.toThrow(/no bookmarks to build/i);
  });
});

describe('stamps, annotations and redaction (E9, E13, E15)', () => {
  it('puts a stamp in the corner the reader sees, not the corner PDF stores (E9)', async () => {
    const bytes = await fixture([{ size: A4, rotation: 90 }, { size: LANDSCAPE }], 'stamp');
    const outcome = await run('add-stamps', { stamp: 'APPROVED', position: 'top-right', width: 140, pages: 'all' }, [bytes]);
    expect(outcome.message).toMatch(/Placed 2 stamps on 2 pages/i);
    const doc = await openPDF(await outputBytes(outcome));
    const marks = listAnnotations(doc).filter((entry) => entry.kind === 'Stamp');
    expect(marks).toHaveLength(2);
    const corners = marks.map((entry) => {
      const page = doc.getPage(entry.page);
      const view = geometry(page);
      const centre = viewPoint(page, entry.rect.x + entry.rect.width / 2, entry.rect.y + entry.rect.height / 2);
      return { ...centre, view, rotation: view.rotation };
    });
    for (const corner of corners) {
      // Top right of the *displayed* sheet, whichever way it is stored.
      expect(corner.x, `rotation ${corner.rotation}`).toBeGreaterThan(corner.view.viewWidth / 2);
      expect(corner.y, `rotation ${corner.rotation}`).toBeGreaterThan(corner.view.viewHeight / 2);
    }
    expect(corners[0]!.x).toBeCloseTo(corners[1]!.x, 0);
    expect(corners[0]!.y).toBeCloseTo(corners[1]!.y, 0);
  });

  it('shrinks a stamp wider than its page and says so (E8, E15)', async () => {
    const bytes = await fixture([{ size: CARD }], 'card');
    const outcome = await run('add-stamps', { stamp: 'SOLD', width: 900, pages: 'all' }, [bytes]);
    expect(outcome.warnings.join('\n')).toMatch(/600 pt stamp does not fit a 105 pt wide page/i);
    const doc = await openPDF(await outputBytes(outcome));
    const mark = listAnnotations(doc)[0]!;
    expect(Math.max(mark.rect.width, mark.rect.height)).toBeLessThanOrEqual(105);
  });

  it('explains regions it had to trim or ignore (E15)', async () => {
    // The fixture writes its body text at y=782, so these boxes land on it.
    const bytes = await fixture([
      { size: A4, text: 'Fixture body one' },
      { size: A4, text: 'Fixture body two' },
    ], 'redact');
    const outcome = await run('redact', { regions: '1:40,770,600,24;2:20,770,200,24;3:0,0,10,10;garbage' }, [bytes]);
    const joined = outcome.warnings.join('\n');
    expect(joined).toMatch(/A box on page 1 hung past the edge of the page/i);
    expect(joined).toMatch(/1 box named a page outside this 2-page document/i);
    expect(joined).toMatch(/1 entry could not be read/i);
    expect(outcome.message).toMatch(/Redacted 2 boxes, deleting \d+ text runs?/i);
    const doc = await openPDF(await outputBytes(outcome));
    expect(drawnRuns(doc.getPage(0)).map((entry) => entry.text).join(' ')).not.toMatch(/Fixture body/);
  });

  it('refuses to redact nothing at all (E13)', async () => {
    await expect(run('redact', { regions: '' })).rejects.toThrow(/draw at least one redaction box/i);
    const empty = await run('redact', { regions: '1:20,20,40,20' });
    expect(empty.outputs).toHaveLength(0);
    expect(empty.message).toMatch(/no region removed anything/i);
  });

  it('reports an empty annotation hunt instead of shipping the file back (E13)', async () => {
    const outcome = await run('remove-annotations', { pages: 'all' });
    expect(outcome.outputs).toHaveLength(0);
    expect(outcome.message).toMatch(/no annotations to remove/i);
    expect(outcome.report?.sections?.[0]?.text).toMatch(/no annotations at all/i);
  });

  it('removes real annotations and mentions the ones left behind (E13)', async () => {
    const doc = await openPDF(await fixture([{ size: A4 }, { size: A4 }], 'marked'));
    const { addAnnotations } = await import('@/lib/pdf/core/annotations');
    addAnnotations(doc, [
      { kind: 'Highlight', page: 0, rect: { x: 40, y: 700, width: 120, height: 14 } },
      { kind: 'Text', page: 1, rect: { x: 40, y: 700, width: 20, height: 20 }, contents: 'later' },
    ]);
    const bytes = await doc.save({ useObjectStreams: false });

    const outcome = await run('remove-annotations', { pages: '1' }, [bytes]);
    expect(outcome.message).toMatch(/Removed 1 annotation from 1 page/i);
    expect(outcome.warnings.join('\n')).toMatch(/1 annotation on the pages you did not select is still there/i);
    const after = await openPDF(await outputBytes(outcome));
    expect(listAnnotations(after).map((entry) => entry.kind)).toEqual(['Text']);
  });

  it('says when no text matched a recolour instead of claiming success (E13)', async () => {
    const outcome = await run('text-color', { from: '#0000ff', to: '#00ff00' });
    expect(outcome.outputs).toHaveLength(0);
    expect(outcome.message).toMatch(/no text matched/i);
    expect(outcome.report?.sections?.[0]?.text).toMatch(/No text painted in #0000ff/i);
  });

  it('recolours real text and reports the runs it changed', async () => {
    const outcome = await run('text-color', { from: 'any', to: '#ff0000' });
    expect(outcome.message).toMatch(/Recoloured \d+ text runs? to #ff0000/i);
  });
});

describe('layers, forms and OCR options (E10, E13, E18, E20)', () => {
  it('names the layer instructions it could not carry out (E13)', async () => {
    const outcome = await run('pdf-layers', { hide: ['Ghost'], add: 'Revision B' });
    expect(outcome.warnings.join('\n')).toMatch(/No layer is named "Ghost"/i);
    expect(outcome.message).toMatch(/Added "Revision B"/i);
    const { listLayers } = await import('@/lib/pdf/core/layers');
    const doc = await openPDF(await outputBytes(outcome));
    // `core/layers` escapes the space into the PDF name; see docs/tasks/b3-request.md.
    expect(listLayers(doc).map((layer) => layer.name.replace(/#20/g, ' ')).join(' ')).toMatch(/Revision B/i);
  });

  it('refuses to run with nothing asked (E18)', async () => {
    await expect(run('pdf-layers', {})).rejects.toThrow(/nothing would change/i);
  });

  it('hides a layer without deleting its ink, and names the tool that does (E13)', async () => {
    const { addLayer, listLayers } = await import('@/lib/pdf/core/layers');
    const source = await PDFDocument.create();
    const font = await source.embedFont(StandardFonts.Helvetica);
    const page = source.addPage(A4);
    const xref = addLayer(source, 'Revision B', { on: false });
    // The layer's own ink, guarded the way a CAD export guards it.
    page.node.set(PDFName.of('Resources'), source.context.obj({ Font: source.context.obj({ F1: font.ref }) }));
    page.node.set(
      PDFName.of('Contents'),
      source.context.register(
        source.context.flateStream(
          [`/OC ${xref} 0 R BDC`, 'BT /F1 14 Tf 60 700 Td (REVISION-B-INK) Tj ET', 'EMC'].join('\n'),
          {},
        ),
      ),
    );
    const bytes = await source.save({ useObjectStreams: false });

    const outcome = await run('pdf-layers', { hide: ['Revision B'] }, [bytes]);
    const doc = await openPDF(await outputBytes(outcome));
    const content = pageContentStreams(doc.getPage(0))
      .map((stream) => new TextDecoder('latin1').decode(stream.bytes))
      .join('\n');
    // This entry edits the default view: switched off, and still in the file.
    expect(content).toContain('REVISION-B-INK');
    expect(listLayers(doc).map((layer) => [layer.name, layer.on])).toEqual([['Revision B', false]]);
    // The definition has to survive too: deleting it is what makes the ink show.
    expect(outcome.message).toMatch(/1 layer/i);

    const notes = (getPdfTool('pdf-layers')?.notes ?? []).join(' ');
    expect(notes).toMatch(/Sanitize PDF with "Remove hidden layer content"/);
  });

  it('does not claim fields were created when none could be placed (E13, E15)', async () => {
    await expect(run('form-creator', { fieldSpecs: [] })).rejects.toThrow(/drag at least one field/i);
    const outcome = await run('form-creator', {
      fieldSpecs: [{ type: 'text', name: 'moved', label: 'Moved field', rect: { x: 40, y: 700, width: 120, height: 20 }, page: 40 }],
    });
    expect(outcome.warnings.join('\n')).toMatch(/1 field was dropped on a page outside this document/i);
    const doc = await openPDF(await outputBytes(outcome));
    const { listFormFields } = await import('@/lib/pdf/core/forms');
    expect(listFormFields(doc).map((field) => field.name)).toEqual(['moved']);
  });

  it('admits when a form answer reached nothing (E13)', async () => {
    const doc = await openPDF(await fixture([{ size: A4 }], 'form'));
    const { createFormField } = await import('@/lib/pdf/core/forms');
    expect(createFormField(doc, 0, { type: 'text', name: 'q1', label: 'Question 1', rect: { x: 40, y: 700, width: 120, height: 20 } }))
      .toBeGreaterThanOrEqual(0);
    const bytes = await doc.save({ useObjectStreams: false });

    const quiet = await run('form-filler', { fieldValues: {} }, [bytes]);
    expect(quiet.warnings.join('\n')).toMatch(/No value reached any of the 1 field/i);
    const filled = await run('form-filler', { fieldValues: { q1: 'hello' } }, [bytes]);
    expect(filled.message).toMatch(/Filled 1 field/i);
  });

  it('refuses a PDF with nothing to fill (E13)', async () => {
    await expect(run('form-filler', { fieldValues: { a: 'b' } })).rejects.toThrow(/no fillable form fields/i);
  });

  it('honours "skip pages that already have text" (E10, E13)', async () => {
    ocrCalls().length = 0;
    giveOcrPages([
      { page: 1, text: 'already here', width: 10, height: 10, blocks: [], words: [], alreadySearchable: true },
    ]);
    const bytes = await fixture([{ size: A4 }], 'scanned');
    const outcome = await run('ocr-pdf', { mode: 'searchable', pages: 'all', skipSearchable: true }, [bytes]);
    expect(ocrCalls()[0]!.options).toMatchObject({ force: false, pages: 'all' });
    expect(outcome.outputs).toHaveLength(0);
    // A skipped page was never analysed, so the line may not claim the reader
    // looked and found nothing — that is a different, truer sentence.
    expect(outcome.message).toMatch(/Nothing was read/i);
    expect(outcome.message).toMatch(/already has a text layer/i);
    expect(outcome.message).not.toMatch(/was recognised/i);
    expect(outcome.warnings.join('\n')).toMatch(/1 page already had a text layer/i);

    await run('ocr-pdf', { mode: 'searchable', pages: 'all', skipSearchable: false }, [bytes]);
    expect(ocrCalls()[1]!.options).toMatchObject({ force: true });
  });

  it('writes a real text layer when the recogniser finds words', async () => {
    ocrCalls().length = 0;
    giveOcrPages([{
      page: 1,
      text: 'RECOGNISED',
      width: 100,
      height: 40,
      blocks: [],
      words: [{ text: 'RECOGNISED', rect: { x: 20, y: 20, width: 90, height: 12 }, confidence: 0.9 }],
      alreadySearchable: false,
    }]);
    const outcome = await run('ocr-pdf', { mode: 'searchable' });
    expect(outcome.message).toMatch(/Added 1 recognised word to 1 page/i);
    const doc = await openPDF(await outputBytes(outcome));
    expect(drawnRuns(doc.getPage(0)).map((run) => run.text).join('')).toContain('RECOGNISED');
  });

  it('tells a scan with no readable text what to do next (E10)', async () => {
    giveOcrPages([{
      page: 1, text: '', width: 10, height: 10, blocks: [], words: [], alreadySearchable: false,
      ink: { sampled: 4338250, ratio: 0.3535, blank: false },
    }]);
    const outcome = await run('ocr-pdf', { mode: 'report' });
    expect(outcome.message).toMatch(/Read nothing/i);
    // The measured figure is in the sentence, and it says the sheet is not blank.
    expect(outcome.message).toMatch(/35\.35 % of the rendered sheet is not paper/i);
    expect(outcome.message).not.toMatch(/blank/i);
    expect(outcome.warnings.join('\n')).toMatch(/too faint to read|higher Resolution/i);
  });

  /**
   * The three silences are three claims, and the campaign's rule is that a page
   * nobody analysed must never be described as an empty one. Each row asserts
   * its own sentence appears and the *other two* do not.
   */
  it('separates a blank sheet, an unreadable sheet and a sheet never read (E10)', async () => {
    const blank = { page: 1, text: '', width: 10, height: 10, blocks: [], words: [], alreadySearchable: false,
      ink: { sampled: 4338250, ratio: 0, blank: true } };
    const unreadable = { page: 2, text: '', width: 10, height: 10, blocks: [], words: [], alreadySearchable: false,
      ink: { sampled: 4338250, ratio: 0.0217, blank: false } };
    const neverRead = { page: 3, text: '', width: 10, height: 10, blocks: [], words: [], alreadySearchable: false };
    giveOcrPages([blank, unreadable, neverRead]);
    const outcome = await run('ocr-pdf', { mode: 'report' });
    const warnings = outcome.warnings.join('\n');

    expect(warnings).toMatch(/page 1 at 0\.00 % of the rendered sheet is ink/i);
    expect(warnings).toMatch(/page 2 at 2\.17 %/i);
    expect(warnings).toMatch(/1 page was never analysed by this run \(page 3\)/i);
    // Report mode names the reason on the page it belongs to, not in one blur.
    const text = JSON.stringify(outcome.report ?? outcome);
    expect(text).toMatch(/Page 1[\s\S]*blank — the rendered sheet measures 0\.00 % ink/i);
    expect(text).toMatch(/Page 2[\s\S]*no letters found, and it is not a blank sheet: 2\.17 %/i);
    expect(text).toMatch(/Page 3[\s\S]*not analysed by this run/i);
  });

  it('refuses to call a blank document recognised, and keeps the file unchanged', async () => {
    giveOcrPages([{
      page: 1, text: '', width: 10, height: 10, blocks: [], words: [], alreadySearchable: false,
      ink: { sampled: 4338250, ratio: 0, blank: true },
    }, {
      page: 2, text: 'its own words', width: 10, height: 10, blocks: [], words: [], alreadySearchable: true,
    }]);
    const outcome = await run('ocr-pdf', { mode: 'searchable' });
    expect(outcome.outputs).toHaveLength(0);
    expect(outcome.message).toMatch(/No text was recognised — the file is unchanged/i);
    const text = JSON.stringify(outcome.report ?? outcome);
    expect(text).toMatch(/blank — the rendered sheet measures 0\.00 % ink/i);
    // "Nothing was recognised" is only true of a page that was read; the note
    // says which of the two it was.
    expect(outcome.warnings.join('\n')).toMatch(/yielded no text at all because there is nothing on it/i);
    // In the browser the refusal is read off this card alone — the report surface
    // does not paint `warnings` — so the line has to separate the page the
    // recogniser read from the page it left alone.
    expect(text).toMatch(/the 1 page the recogniser read, and 1 page already had its own text layer/i);

    const rebuilt = await run('ocr-pdf', { mode: 'replace' });
    expect(rebuilt.outputs).toHaveLength(0);
    expect(rebuilt.message).toMatch(/Nothing was written — the file is unchanged/i);
  });

  it('names the recogniser when OCR cannot run, instead of a fake success (E20)', async () => {
    const { OcrEngineUnavailable } = await import('@/lib/pdf/core/ocr');
    failOcr(new OcrEngineUnavailable('load', 'Failed to fetch resource from https://models.invalid/det.ort'));
    const outcome = await run('ocr-pdf', {}).catch((error: unknown) => error as Error);
    expect(outcome).toBeInstanceOf(Error);
    const message = (outcome as Error).message;
    // Three claims, all required: what failed, that the file was not read, and
    // what would fix it. None of them may be a statement about the pages.
    expect(message).toMatch(/recogniser could not run in this tab/iu);
    expect(message).toMatch(/nothing in .* was read/iu);
    expect(message).toMatch(/check the connection/iu);
    expect(message).toMatch(/Failed to fetch resource/iu);
    expect(message).not.toMatch(/no text|blank|nothing was recognised/iu);
  });

  it('names the page and the retry when the engine stops mid-document (E20)', async () => {
    const { OcrEngineUnavailable } = await import('@/lib/pdf/core/ocr');
    failOcr(new OcrEngineUnavailable('recognise', 'onnx runtime trapped', 2));
    const message = await run('ocr-pdf', {}).catch((error: unknown) => (error as Error).message);
    expect(message).toMatch(/could not run past page 2/iu);
    expect(message).toMatch(/the file was not read/iu);
    expect(message).toMatch(/onnx runtime trapped/iu);
    expect(message).toMatch(/Resolution/iu);
  });

  it('does not blame the recogniser for a failure that is not the engine’s', async () => {
    failOcr(new Error('This PDF is encrypted'));
    const message = await run('ocr-pdf', {}).catch((error: unknown) => (error as Error).message);
    expect(message).toMatch(/OCR could not run on/iu);
    expect(message).toMatch(/This PDF is encrypted/iu);
    expect(message).not.toMatch(/check the connection/iu);
  });
});

describe('raster colour tools (E7, E8, E9, E15)', () => {
  // The structural twin of `tests/pdf/colour-tools-ink.test.ts`, and the reason this
  // file's double had to stop being generous: all three tools reach `rerasterise`, and
  // a double whose `renderPage` returned no `finished` could not tell a caller that
  // waited for the paint from one that encoded a page of paper.
  it.each(['invert-colors', 'adjust-colors', 'scanner-effect'])(
    '%s encodes each page only after pdf.js has painted it',
    async (id) => {
      earlyReads().length = 0;
      const bytes = await fixture([{ size: A4 }, { size: A4 }], 'inked pair');
      const outcome = await run(id, { dpi: 150, pages: 'all' }, [bytes]);
      await outputBytes(outcome);
      expect(earlyReads(), `${id} copied a page canvas that had not been painted`).toEqual([]);
    },
  );

  it('rebuilds every page at its own displayed size, rotated pages included (E8, E9)', async () => {
    renderCalls().length = 0;
    const bytes = await fixture([{ size: A4 }, { size: CARD }, { size: A4, rotation: 90 }], 'mixed');
    const outcome = await run('invert-colors', { dpi: 150, pages: 'all' }, [bytes]);
    expect(outcome.message).toMatch(/Inverted 3 pages at 150 dpi/i);
    const doc = await openPDF(await outputBytes(outcome));
    expect(doc.getPages().map((page) => page.getSize())).toEqual([
      { width: A4[0], height: A4[1] },
      { width: CARD[0], height: CARD[1] },
      // The turned sheet comes out the shape the reader saw, not the stored one.
      { width: A4[1], height: A4[0] },
    ]);
    for (const page of doc.getPages()) {
      const { width, height } = page.getSize();
      const stream = pageContentStreams(page).map(({ bytes: raw }) => Buffer.from(raw).toString('latin1')).join('\n');
      // The raster fills the whole page: a unit square scaled to the box.
      expect(stream).toMatch(new RegExp(`${String(width).replace('.', '\\.')} 0 0 ${String(height).replace('.', '\\.')} 0 0 cm`));
    }
    expect(renderCalls().map((call) => call.scale)).toEqual([150 / 72, 150 / 72, 150 / 72]);
    expect(renderCalls().every((call) => call.filter === 'invert(1)')).toBe(true);
  });

  it('clamps the resolution and warns that unselected pages are not in the output (E7, E15)', async () => {
    const bytes = await fixture([{ size: A4 }, { size: A4 }, { size: A4 }], 'three');
    const outcome = await run('adjust-colors', { dpi: 12, pages: '1-2', threshold: 0.5, grayscale: true }, [bytes]);
    expect(outcome.warnings.join('\n')).toMatch(/Resolution must be between 96 and 400 dpi: 12 became 96/i);
    expect(outcome.warnings.join('\n')).toMatch(/1 page outside your selection is not in the output/i);
    expect(outcome.message).toMatch(/Adjusted and binarised 2 pages at 96 dpi/i);
    const doc = await openPDF(await outputBytes(outcome));
    expect(doc.getPageCount()).toBe(2);
  });

  it('runs the pixel passes the scanner effect advertises', async () => {
    renderCalls().length = 0;
    const outcome = await run('scanner-effect', { dpi: 300, whitening: true, sharpen: true, grayscale: true, contrast: 1.4 });
    expect(outcome.message).toMatch(/Applied the scanner effect to 1 page at 300 dpi/i);
    const last = renderCalls()[renderCalls().length - 1]!;
    expect(last.filter).toContain('grayscale(1)');
    expect(last.filter).toContain('contrast(1.4)');
    expect(last.scale).toBeCloseTo(300 / 72, 6);
    const doc = await openPDF(await outputBytes(outcome));
    expect(doc.getPageCount()).toBe(1);
  });
});
