/**
 * Edge cases for the organize category (B1: `src/lib/pdf/tools/organize.ts`).
 *
 * Same discipline as `tools-e2e.test.ts`: real PDF bytes are built here with
 * pdf-lib, the tool is driven through `runPdfTool` (the exact path the rail
 * uses — guard, field clamping, validation, the warnings bridge), and the
 * **returned bytes** are re-opened and measured. Only the pdf.js worker is
 * stood in for, and it is stood in for with the page's real content stream, so a
 * tool that reports a confident sentence over a broken file fails here — which is
 * the whole complaint the refinement pass started from.
 *
 * Matrix rows covered: E1/E2 (the gate names the file), E5 (an unlocked output
 * must not still be encrypted), E6 (page 9 of a 3-page file names the real
 * count), E8 (mixed page sizes), E9 (rotated pages keep their orientation),
 * E12 (a sheet that hits the PDF height limit says so), E13 (nothing to do is
 * not a success), E15 (numbers are bounded, and a correction is announced),
 * E16 (a repeat is handled, not merged twice by accident), E17 (sane download
 * names), E18 (the rail blocks before the click), E19 (a cancelled run leaves
 * nothing behind), E20 (a rebuild that needs an optional engine says so).
 *
 * `remove-blank-pages` and `pdf-to-cbz` are the two tools that need a display
 * list, and jsdom cannot spin the pdf.js worker (`Setting up fake worker
 * failed`). `core/render` is doubled below — each page's actual content stream
 * translated into pdf.js operator ids, and the canvas answered with a real 1×1
 * image — so `core/blank`, the tool bodies, the archive writer and the saved
 * bytes still run for real and are measured here rather than only in the rail
 * contract.
 *
 * The last block drives `core/pages.resolvePages` directly: it is the grammar
 * every field on this list ends up in, and some inputs reach it without passing
 * the rail’s own pre-check.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  StandardFonts,
  degrees,
  rgb,
} from '@maxwbh/pdf-lib';
import { organizeTools } from '@/lib/pdf/tools/organize';
import { resolvePages } from '@/lib/pdf/core/pages';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { runPdfTool, type RunOutcome } from '@/lib/pdf/tools/runner';
import { pageContentStreams, streamBytes } from '@/lib/pdf/core/content';

/* ── fixtures ─────────────────────────────────────────────────────────────── */

interface SheetSpec {
  width: number;
  height: number;
  /** `/Rotate`, clockwise, as a viewer displays it. */
  rotate?: number;
  /** Paint nothing, for the blank-page tests. */
  empty?: boolean;
  /** Paint only a raster image, the way a scan looks (no text, no vector ink). */
  image?: boolean;
}

/**
 * Sheets carrying a black strip down their **left edge in page space** plus a
 * line of text. A stamp that ignores `/Rotate` puts that strip where the fixture
 * never drew it, which is what the geometry assertions below measure.
 */
async function sheets(specs: SheetSpec[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const page = doc.addPage([spec.width, spec.height]);
    if (spec.rotate) page.setRotation(degrees(spec.rotate));
    if (spec.empty) continue;
    if (spec.image) {
      const scan = await doc.embedJpg(TINY_JPEG);
      page.drawImage(scan, { x: 0, y: 0, width: spec.width, height: spec.height });
      continue;
    }
    page.drawRectangle({ x: 0, y: 0, width: 50, height: spec.height, color: rgb(0, 0, 0) });
    page.drawText(`sheet ${i + 1}`, { x: 60, y: spec.height - 24, size: 12, font, color: rgb(0, 0, 0) });
  }
  return doc.save({ useObjectStreams: false });
}

const grid = (
  count: number,
  extra: { width?: number; height?: number; rotate?: number; empty?: boolean } = {},
): SheetSpec[] => Array.from({ length: count }, () => ({ width: 200, height: 100, ...extra }));

/** SAFETY: a fresh `Uint8Array` copy is a valid `BlobPart`. */
const fileOf = (bytes: Uint8Array, name: string): File =>
  new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });

async function run(
  toolId: string,
  values: Record<string, unknown> = {},
  files: File[] = [],
  password?: string,
): Promise<RunOutcome> {
  const tool = getPdfTool(toolId);
  expect(tool, `tool "${toolId}" is not registered`).toBeTruthy();
  const chosen = files.length > 0 ? files : [fileOf(await sheets(grid(4)), 'fixture.pdf')];
  return runPdfTool({
    toolId,
    files: chosen,
    values,
    password,
    onProgress: () => {},
    onLog: () => {},
  });
}

async function bytesOf(outcome: RunOutcome, index = 0): Promise<Uint8Array> {
  expect(outcome.outputs.length, 'expected an output').toBeGreaterThan(index);
  return new Uint8Array(await outcome.outputs[index].blob.arrayBuffer());
}

const open = (bytes: Uint8Array): Promise<PDFDocument> => PDFDocument.load(bytes);

/** Raw file text, for trailer-level claims such as `/Encrypt`. */
const text = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1');

const warn = (outcome: RunOutcome): string => outcome.warnings.join(' ');

/* ── measuring what a tool actually drew ─────────────────────────────────── */

interface Stamp {
  name: string;
  /** The form's `/BBox`: which region of the source page was taken. */
  bbox: number[];
  /** The form's `/Matrix`, then the content-stream CTM at the `Do`. */
  matrix: number[];
  ctm: number[];
}

const IDENTITY = [1, 0, 0, 1, 0, 0];

const multiply = (a: number[], b: number[]): number[] => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];

/**
 * The form XObjects a page draws, in draw order, with the transform in force.
 *
 * Read from the saved file rather than from the tool's own bookkeeping, so the
 * assertion is about the PDF: which region was clipped (`/BBox`) and where it
 * landed (the composed `/Matrix` and `cm` chain).
 */
function stampsOf(doc: PDFDocument, index: number): Stamp[] {
  const page = doc.getPages()[index];
  const resources = page.node.Resources();
  const dict = resources instanceof PDFRef ? doc.context.lookup(resources, PDFDict) : resources;
  const rawForms = dict instanceof PDFDict ? dict.get(PDFName.of('XObject')) : undefined;
  const forms = rawForms instanceof PDFRef ? doc.context.lookup(rawForms, PDFDict) : rawForms;
  if (!(forms instanceof PDFDict)) return [];
  const numbers = (value: unknown): number[] => {
    const array = value instanceof PDFRef ? doc.context.lookup(value, PDFArray) : value;
    if (!(array instanceof PDFArray)) return [];
    return Array.from({ length: array.size() }, (_, i) => Number(array.get(i).toString()));
  };
  const byName = new Map<string, PDFDict>();
  for (const [name, value] of forms.entries()) {
    // A form XObject is a stream: its dictionary is what carries /BBox.
    const object = value instanceof PDFRef ? doc.context.lookup(value) : value;
    const dict = object instanceof PDFRawStream ? object.dict : object;
    if (dict instanceof PDFDict) byName.set(name.toString(), dict);
  }

  const content = pageContentStreams(page)
    .map((stream) => Buffer.from(stream.bytes).toString('latin1'))
    .join('\n');
  const stack: number[][] = [];
  let current = IDENTITY;
  let operands: string[] = [];
  const out: Stamp[] = [];
  for (const token of content.split(/[\s\n]+/)) {
    if (token === '') continue;
    if (token !== 'cm' && token !== 'q' && token !== 'Q' && token !== 'Do') {
      operands.push(token);
      continue;
    }
    if (token === 'q') stack.push(current);
    else if (token === 'Q') current = stack.pop() ?? IDENTITY;
    else if (token === 'cm' && operands.length >= 6) {
      current = multiply(current, operands.slice(-6).map(Number));
      operands = [];
    } else if (token === 'Do') {
      const name = operands[operands.length - 1] ?? '';
      operands = [];
      const form = byName.get(name);
      if (!form) continue;
      out.push({ name, bbox: numbers(form.get(PDFName.of('BBox'))), matrix: numbers(form.get(PDFName.of('Matrix'))), ctm: current });
    } else {
      operands = [];
    }
  }
  return out;
}

/** Where a rectangle in the *source page's own* space lands on the target. */
function mappedBox(
  stamp: Stamp,
  rect: [number, number, number, number],
): { x: number; y: number; width: number; height: number } {
  const [x, y, width, height] = rect;
  const points = [[x, y], [x + width, y], [x, y + height], [x + width, y + height]].map(([px, py]) => {
    const mx = stamp.matrix[0] * px + stamp.matrix[2] * py + stamp.matrix[4];
    const my = stamp.matrix[1] * px + stamp.matrix[3] * py + stamp.matrix[5];
    return [
      stamp.ctm[0] * mx + stamp.ctm[2] * my + stamp.ctm[4],
      stamp.ctm[1] * mx + stamp.ctm[3] * my + stamp.ctm[5],
    ];
  });
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

async function zipEntries(blob: Blob): Promise<string[]> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(new Uint8Array(await blob.arrayBuffer()));
  return Object.keys(zip.files);
}

async function encrypt(bytes: Uint8Array, password = 'hunter2'): Promise<Uint8Array> {
  const doc = await open(bytes);
  return doc.save({
    encrypt: { userPassword: password, ownerPassword: 'owner', version: 4, permissions: {} as never },
  });
}

/* ── reading the words back out of a file ─────────────────────────────────── */

/** A 1×1 JPEG and PNG: the render double hands out real image bytes. */
const TINY_JPEG = Uint8Array.from(
  Buffer.from(
    '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDs0NDL/wAALCAABAAEBAREA/8QAFAABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AmAA/9k=',
    'base64',
  ),
);
const TINY_PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  ),
);

/** A dictionary, whether it is inline or behind a reference. */
function dictOf(doc: PDFDocument, value: unknown): PDFDict | null {
  const resolved = value instanceof PDFRef ? doc.context.lookup(value) : value;
  return resolved instanceof PDFDict ? resolved : null;
}

/** The strings a content stream shows with `Tj`, `TJ`, `'` or `"`. */
function shownStrings(content: string): string[] {
  const decode = (raw: string, hex: boolean): string =>
    hex
      ? Buffer.from(raw.length % 2 === 0 ? raw : `${raw}0`, 'hex').toString('latin1')
      : raw.replace(/\\([()\\])/g, '$1');
  const out: string[] = [];
  for (const match of content.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*(?:Tj|'|")/g)) out.push(decode(match[1], false));
  for (const match of content.matchAll(/<([0-9A-Fa-f\s]*)>\s*(?:Tj|'|")/g)) out.push(decode(match[1].replace(/\s+/g, ''), true));
  for (const array of content.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
    for (const piece of array[1].matchAll(/\(((?:[^()\\]|\\.)*)\)|<([0-9A-Fa-f\s]*)>/g)) {
      out.push(piece[1] !== undefined ? decode(piece[1], false) : decode((piece[2] ?? '').replace(/\s+/g, ''), true));
    }
  }
  return out;
}

/**
 * The text a page shows, read out of the saved bytes.
 *
 * The imposition tools move a page's words into a form XObject, so the walk
 * covers the page's own content *and* every form it draws. A tool that quietly
 * rasterised — while its notes promise the text stays selectable — shows up here
 * as a page with no words at all.
 */
function drawnText(doc: PDFDocument, index: number): string {
  const page = doc.getPages()[index];
  if (!page) return '';
  const parts: string[] = [];
  const seen = new Set<string>();
  const walk = (content: string, resources: unknown): void => {
    parts.push(...shownStrings(content));
    const forms = dictOf(doc, dictOf(doc, resources)?.get(PDFName.of('XObject')));
    if (!forms) return;
    for (const [, value] of forms.entries()) {
      const key = String(value);
      if (seen.has(key)) continue;
      seen.add(key);
      const stream = value instanceof PDFRef ? doc.context.lookup(value) : value;
      if (!(stream instanceof PDFRawStream)) continue;
      walk(
        Buffer.from(streamBytes(stream)).toString('latin1'),
        stream.dict.get(PDFName.of('Resources')),
      );
    }
  };
  walk(
    pageContentStreams(page).map((stream) => Buffer.from(stream.bytes).toString('latin1')).join('\n'),
    page.node.Resources(),
  );
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** What each page of a fixture shows, in document order. */
const pageTexts = (doc: PDFDocument): string[] => doc.getPages().map((_, index) => drawnText(doc, index));

/** The text a PDF string object holds, including the UTF-16BE form. */
function pdfText(value: unknown): string {
  const raw = String(value ?? '');
  const hex = /^<([0-9A-Fa-f\s]*)>$/.exec(raw);
  if (hex) {
    const bytes = Buffer.from(hex[1].replace(/\s+/g, ''), 'hex');
    if (bytes.length >= 2 && bytes.readUInt16BE(0) === 0xfeff) {
      return Buffer.from(bytes.subarray(2)).swap16().toString('utf16le');
    }
    return bytes.toString('latin1');
  }
  const literal = /^\(((?:[^()\\]|\\.)*)\)$/.exec(raw);
  return (literal ? literal[1] : raw).replace(/\\([()\\])/g, '$1');
}


/* ── the pdf.js double ────────────────────────────────────────────────────── */

/**
 * jsdom cannot boot the pdf.js worker ("Only URLs with a scheme in: file and
 * data …"), so `openRender` is answered with a session that translates each
 * page's **real content stream** into the numeric operator ids pdf.js puts on
 * its display list. `core/blank`, the tool body, the archive writer and the
 * saved bytes all run for real.
 *
 * The operator list deliberately carries no `ops` property, because neither does
 * pdf.js's — that is the fact the blank-detection regression test rests on.
 * `renderPage`/`canvasToBlob` stand in for the rasteriser with a real 1×1 image,
 * since jsdom has no canvas (same shape as `edge-optimize.test.ts`).
 */
vi.mock('@/lib/pdf/core/render', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/pdf/core/render')>();
  const { OPS } = await import('pdfjs-dist');
  const { PDFDocument: Loader } = await import('@maxwbh/pdf-lib');
  const { pageContentStreams: streams } = await import('@/lib/pdf/core/content');
  const ids: Record<string, number> = {
    Tj: OPS.showText,
    TJ: OPS.showSpacedText,
    "'": OPS.nextLineShowText,
    '"': OPS.nextLineSetSpacingShowText,
    Do: OPS.paintXObject,
    BI: OPS.beginInlineImage,
    f: OPS.fill,
    'f*': OPS.eoFill,
    B: OPS.fillStroke,
    'B*': OPS.eoFillStroke,
    S: OPS.stroke,
    sh: OPS.shadingFill,
  };
  const paintable = new Set<number>(Object.values(ids));
  return {
    ...real,
    openRender: async (bytes: Uint8Array) => {
      const doc = await Loader.load(bytes, { updateMetadata: false });
      const lists = doc.getPages().map((page) => {
        const content = streams(page)
          .map((stream) => Buffer.from(stream.bytes).toString('latin1'))
          .join('\n');
        const fnArray: number[] = [];
        const argsArray: unknown[] = [];
        for (const token of content.split(/[\s\n]+/)) {
          const id = ids[token];
          if (id === undefined || !paintable.has(id)) continue;
          fnArray.push(id);
          argsArray.push(id === OPS.paintXObject || id === OPS.beginInlineImage ? { width: 100, height: 50 } : undefined);
        }
        const items = shownStrings(content)
          .filter((str) => str.trim() !== '')
          .map((str) => ({ str, transform: [12, 0, 0, 12, 0, 0] }));
        return { fnArray, argsArray, items };
      });
      const numPages = lists.length;
      return {
        numPages,
        page: async (n: number) => ({
          getViewport: ({ scale = 1 }: { scale?: number }) => ({ width: 200 * scale, height: 100 * scale, scale }),
          getTextContent: async () => ({ items: lists[n - 1].items, styles: {}, lang: null }),
          getOperatorList: async () => ({
            fnArray: lists[n - 1].fnArray,
            argsArray: lists[n - 1].argsArray,
            lastChunk: true,
          }),
          cleanup: () => {},
        }),
        renderPage: async (n: number, scale: number) => ({
          canvas: {} as HTMLCanvasElement,
          ctx: {} as CanvasRenderingContext2D,
          width: Math.round(200 * scale),
          height: Math.round(100 * scale),
          unitsPerPixel: 1 / scale,
          pageNumber: n,
          cancel: () => {},
        }),
        metadata: async () => ({ numPages, fingerprint: 'organize-render-double', formFields: 0 }),
        attachments: async () => ({}),
        destroy: async () => {},
      } as unknown as Awaited<ReturnType<typeof real.openRender>>;
    },
  };
});

vi.mock('@/lib/pdf/core/raster', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/pdf/core/raster')>();
  return {
    ...real,
    canvasToBlob: async (_canvas: unknown, format: string) =>
      new Blob([format === 'png' ? TINY_PNG : TINY_JPEG], {
        type: format === 'png' ? 'image/png' : 'image/jpeg',
      }),
  };
});

/* ── the rail contract: E15, E18, E20 before the click ───────────────────── */

describe('organize rail contract', () => {
  it('covers the whole category', () => {
    expect(organizeTools.map((tool) => tool.id)).toHaveLength(21);
  });

  it('says what each tool produces and what its button does', () => {
    for (const tool of organizeTools) {
      const promise = tool.promise ?? '';
      expect(promise.split(/\s+/).length, `${tool.id} has a thin promise`).toBeGreaterThanOrEqual(6);
      expect(
        /pdf|file|pages|sheet|archive|images|copy|booklet|tiles|zip/i.test(promise),
        `${tool.id} promise does not name the output`,
      ).toBe(true);
      expect(tool.actionLabel, `${tool.id} has no actionLabel`).toBeTruthy();
      expect(tool.actionLabel, `${tool.id} still says Run`).not.toBe('Run');
      expect(tool.actionLabel!.length, `${tool.id} verb is a sentence`).toBeLessThanOrEqual(16);
      expect(tool.run ?? tool.mainComponent ?? tool.unavailable, `${tool.id} cannot do anything`).toBeTruthy();
    }
  });

  it('bounds every numeric field and files every field under a heading (E15, E18)', () => {
    const unbounded: string[] = [];
    const ungrouped: string[] = [];
    const notWhole: string[] = [];
    const wholeNumbers = ['chunkSize', 'anchor', 'count', 'offset', 'columns', 'rows', 'parts', 'dpi'];
    for (const tool of organizeTools) {
      for (const field of tool.fields ?? []) {
        if (!field.group) ungrouped.push(`${tool.id}.${field.key}`);
        if (field.type !== 'number' && field.type !== 'slider') continue;
        if (field.min === undefined || field.max === undefined || field.step === undefined) {
          unbounded.push(`${tool.id}.${field.key}`);
        } else if (field.min > field.max) {
          unbounded.push(`${tool.id}.${field.key} inverted`);
        }
        if (wholeNumbers.includes(field.key) && field.integer !== true) notWhole.push(`${tool.id}.${field.key}`);
      }
    }
    expect(unbounded).toEqual([]);
    expect(ungrouped).toEqual([]);
    expect(notWhole).toEqual([]);
  });

  it('warns in the honesty panel when the rebuild needs an engine it does not have (E20)', () => {
    for (const id of ['n-up', 'booklet', 'posterize', 'divide-pages', 'combine-single-page', 'fix-page-size', 'overlay-pdf', 'rotate-custom']) {
      const tool = getPdfTool(id)!;
      const notes = (tool.notes ?? []).join(' ');
      expect(/link|bookmark|annotation/i.test(notes), `${id} hides what it loses`).toBe(true);
      expect(/engine|CoherentPDF|PyMuPDF|Ghostscript/i.test(notes), `${id} does not name the optional engine`).toBe(true);
    }
  });
});

/* ── E6, E13, E15, E18: page lists and numbers ───────────────────────────── */

describe('page selections name the real document', () => {
  it('accepts page 1 and rejects page 2 of a one-page file (E6)', async () => {
    const one = fileOf(await sheets(grid(1)), 'one.pdf');
    const outcome = await run('rotate', { degrees: 90, pages: '1' }, [one]);
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPages()[0].getRotation().angle).toBe(90);

    await expect(run('rotate', { degrees: 90, pages: '2' }, [one])).rejects.toThrow(
      /refers to page 2, but this document has 1 page/i,
    );
    await expect(run('extract-pages', { pages: '9' }, [one])).rejects.toThrow(/has 1 page/i);
  });

  it('quotes the page count of the file actually dropped (E6)', async () => {
    const six = fileOf(await sheets(grid(6)), 'six.pdf');
    await expect(run('extract-pages', { pages: '9' }, [six])).rejects.toThrow(/has 6 pages/i);
  });

  it('rejects an inverted range and page zero with a reason (E15)', async () => {
    await expect(run('extract-pages', { pages: '4-2' })).rejects.toThrow(/runs backwards/i);
    await expect(run('extract-pages', { pages: '0' })).rejects.toThrow(/numbered from 1/i);
  });

  it('rejects an empty selection and says what to do (E13, E18)', async () => {
    await expect(run('extract-pages', { pages: '  ' })).rejects.toThrow(/choose which pages to extract/i);
    await expect(run('remove-pages', { pages: '' })).rejects.toThrow(/choose the pages to delete/i);
    await expect(run('rotate', { degrees: 90, pages: '' })).rejects.toThrow(/no pages chosen/i);
    await expect(run('split', { mode: 'ranges', ranges: '' })).rejects.toThrow(/enter at least one page range/i);
  });

  it('refuses a plan that would delete every page (E13)', async () => {
    await expect(run('remove-pages', { pages: '1-4' })).rejects.toThrow(
      /removing all 4 pages|leaving an empty pdf/i,
    );
  });

  it('applies a page listed twice once only (E16)', async () => {
    const outcome = await run('rotate', { degrees: 90, pages: '2,2' });
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPages().map((page) => page.getRotation().angle)).toEqual([0, 90, 0, 0]);
  });

  it('reads a spaced range in a plan the way the page list does (E15)', async () => {
    const outcome = await run('organize', { pageOrder: '1 - 2, 4' });
    const doc = await open(await bytesOf(outcome));
    expect(pageTexts(doc)).toEqual(['sheet 1', 'sheet 2', 'sheet 4']);

    await expect(run('organize', { pageOrder: '2 - ' })).rejects.toThrow(/is not a page token/i);
  });

  it('copies a page that the plan lists twice', async () => {
    const outcome = await run('organize', { pageOrder: '1,1,2' });
    const doc = await open(await bytesOf(outcome));
    expect(pageTexts(doc)).toEqual(['sheet 1', 'sheet 1', 'sheet 2']);
  });

  it('clamps an out-of-range number and announces the correction (E15)', async () => {
    const outcome = await run('split', { mode: 'chunks', chunkSize: 0 });
    expect(warn(outcome)).toMatch(/pages per file must be between 1 and 500: 0 became 1/i);
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPageCount()).toBe(1);
  });

  it('does not pretend a chunk bigger than the document is several files (E13)', async () => {
    const outcome = await run('split', { mode: 'chunks', chunkSize: 500 });
    expect(outcome.outputs).toHaveLength(1);
    expect(warn(outcome)).toMatch(/at least the document/i);
  });

  it('says which pages its ranges leave out of the download (E13)', async () => {
    const outcome = await run('split', { mode: 'ranges', ranges: '1-2' });
    expect(warn(outcome)).toMatch(/cover 2 pages of the document.s 4 pages/i);
  });

  it('clamps a page-number field to the document it was typed against (E6)', async () => {
    const outcome = await run('add-blank-page', { position: 'after', anchor: 99, count: 1, size: 'same' });
    expect(warn(outcome)).toMatch(/must be a page between 1 and 4: 99 became 4/i);
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPageCount()).toBe(5);
  });
});

/* ── E8, E9: rotation and per-page geometry ──────────────────────────────── */

describe('geometry is respected, not flattened', () => {
  it('keeps a page’s own rotation while reordering (E9)', async () => {
    const source = fileOf(
      await sheets([
        { width: 200, height: 100 },
        { width: 200, height: 100, rotate: 90 },
      ]),
      'two.pdf',
    );
    const outcome = await run('organize', { pageOrder: '2, 1' }, [source]);
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPages().map((page) => page.getRotation().angle)).toEqual([90, 0]);
  });

  it('lets a plan straighten a rotated page with r0, and expands a range (E9)', async () => {
    const source = fileOf(
      await sheets([
        { width: 200, height: 100, rotate: 90 },
        { width: 200, height: 100, rotate: 90 },
      ]),
      'two.pdf',
    );
    const outcome = await run('organize', { pageOrder: '1-2r0' }, [source]);
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPageCount()).toBe(2);
    expect(doc.getPages().map((page) => page.getRotation().angle)).toEqual([0, 0]);
  });

  it('names the real page count when a plan reaches too far (E6)', async () => {
    const source = fileOf(await sheets(grid(3)), 'three.pdf');
    await expect(run('organize', { pageOrder: '9' }, [source])).rejects.toThrow(
      /refers to page 9, but this document has 3 pages/i,
    );
    await expect(run('organize', { pageOrder: '3-1' }, [source])).rejects.toThrow(/runs backwards/i);
    const snapped = await run('organize', { pageOrder: '3r45' }, [source]);
    expect(warn(snapped)).toMatch(/r45 is not a quarter turn.*90° instead/i);
  });

  it('adds the turn to the page’s own rotation instead of overwriting it (E9)', async () => {
    const source = fileOf(await sheets([{ width: 200, height: 100, rotate: 270 }]), 'one.pdf');
    const outcome = await run('rotate', { degrees: 90, pages: 'all' }, [source]);
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPages()[0].getRotation().angle).toBe(0);
    expect(warn(outcome)).toMatch(/now upright/i);
  });

  it('stamps rotated pages upright into an N-up sheet (E9)', async () => {
    // 200 × 100 with /Rotate 90 displays as a portrait sheet. A stamp that
    // ignores /Rotate puts a sideways landscape box in the cell.
    const source = fileOf(await sheets(grid(2, { rotate: 90 })), 'two.pdf');
    const outcome = await run('n-up', { perSheet: 2, sheetSize: 'a4', landscape: false, gutter: 0, margin: 0 }, [source]);
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPageCount()).toBe(1);
    const sheet = doc.getPage(0);
    const drawn = stampsOf(doc, 0).map((stamp) => mappedBox(stamp, [0, 0, 200, 100]));
    expect(drawn).toHaveLength(2);
    for (const box of drawn) {
      expect(box.height, 'a rotated page must occupy a portrait cell').toBeGreaterThan(box.width);
      expect(box.x).toBeGreaterThanOrEqual(-0.5);
      expect(box.y).toBeGreaterThanOrEqual(-0.5);
      expect(box.x + box.width).toBeLessThanOrEqual(sheet.getWidth() + 0.5);
      expect(box.y + box.height).toBeLessThanOrEqual(sheet.getHeight() + 0.5);
    }
  });

  it('cuts a rotated page along the line the viewer sees (E9)', async () => {
    const source = fileOf(await sheets([{ width: 200, height: 100, rotate: 90 }]), 'one.pdf');
    const outcome = await run('divide-pages', { axis: 'vertical', parts: 2 }, [source]);
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPageCount()).toBe(2);
    // Displayed as 100 × 200, a vertical cut halves X — which in the page's own
    // space is a split of Y: two 200 × 50 strips, on two portrait sheets.
    expect(doc.getPages().map((_, index) => stampsOf(doc, index)[0].bbox)).toEqual([
      [0, 0, 200, 50],
      [0, 50, 200, 100],
    ]);
    expect(doc.getPages().map((page) => page.getSize())).toEqual([
      { width: 50, height: 200 },
      { width: 50, height: 200 },
    ]);
  });

  it('bakes the page’s own rotation into a custom-angle turn (E9)', async () => {
    const source = fileOf(await sheets([{ width: 200, height: 100, rotate: 90 }]), 'one.pdf');
    const outcome = await run('rotate-custom', { angle: 0, fit: 'grow', pages: 'all' }, [source]);
    const doc = await open(await bytesOf(outcome));
    const page = doc.getPage(0);
    expect(page.getRotation().angle).toBe(0);
    expect(page.getSize()).toEqual({ width: 100, height: 200 });
    const box = mappedBox(stampsOf(doc, 0)[0], [0, 0, 200, 100]);
    expect(box.height).toBeGreaterThan(box.width);
    expect(box.width).toBeCloseTo(page.getWidth(), 0);
  });

  it('keeps a custom-angle turn as vector content rather than a picture (E12)', async () => {
    const source = fileOf(await sheets(grid(1)), 'one.pdf');
    const outcome = await run('rotate-custom', { angle: 12.5, fit: 'grow', pages: 'all' }, [source]);
    const bytes = await bytesOf(outcome);
    const doc = await open(bytes);
    expect(text(bytes)).toMatch(/\/Subtype\s*\/Form/);
    expect(text(bytes)).not.toMatch(/\/Subtype\s*\/Image/);
    const box = mappedBox(stampsOf(doc, 0)[0], [0, 0, 200, 100]);
    expect(doc.getPage(0).getWidth()).toBeCloseTo(box.width, 0);
    expect(doc.getPage(0).getHeight()).toBeCloseTo(box.height, 0);
  });

  it('reports when keeping the page size crops the turn (E13)', async () => {
    const source = fileOf(await sheets(grid(1)), 'one.pdf');
    const outcome = await run('rotate-custom', { angle: 45, fit: 'keep', pages: 'all' }, [source]);
    expect(warn(outcome)).toMatch(/cut the corners off 1 page/i);
  });

  it('sizes a blank sheet to the page it lands beside (E8)', async () => {
    const source = fileOf(
      await sheets([
        { width: 200, height: 100 },
        { width: 400, height: 300 },
        { width: 400, height: 300 },
        { width: 400, height: 300 },
      ]),
      'mixed.pdf',
    );
    const outcome = await run('add-blank-page', { position: 'end', count: 1, size: 'same' }, [source]);
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPage(doc.getPageCount() - 1).getSize()).toEqual({ width: 400, height: 300 });
    expect(warn(outcome)).toMatch(/mixes page sizes.*page 4 beside them/i);
  });

  it('keeps each page’s own size when merging, and says so (E8)', async () => {
    const small = fileOf(await sheets([{ width: 200, height: 100 }]), 'a.pdf');
    const large = fileOf(await sheets([{ width: 400, height: 300 }]), 'b.pdf');
    const outcome = await run('merge', {}, [small, large]);
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPages().map((page) => page.getSize())).toEqual([
      { width: 200, height: 100 },
      { width: 400, height: 300 },
    ]);
    expect(warn(outcome)).toMatch(/2 different page sizes/i);
  });

  it('standardises a mixed document without losing any page (E8)', async () => {
    const source = fileOf(
      await sheets([
        { width: 200, height: 100 },
        { width: 400, height: 300 },
        { width: 200, height: 100, rotate: 90 },
      ]),
      'mixed.pdf',
    );
    const outcome = await run('fix-page-size', { size: 'a4', orientation: 'portrait', fit: 'contain' }, [source]);
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPageCount()).toBe(3);
    for (const page of doc.getPages()) {
      expect(Math.round(page.getWidth())).toBe(595);
      expect(Math.round(page.getHeight())).toBe(842);
    }
    // The rotated page must still be drawn rotated-correct: its content box is
    // taller than wide before fitting, and it must sit inside the sheet.
    const box = mappedBox(stampsOf(doc, 2)[0], [0, 0, 200, 100]);
    expect(box.y).toBeGreaterThanOrEqual(-0.5);
    expect(box.y + box.height).toBeLessThanOrEqual(842 + 0.5);
  });

  it('says when filling the page runs content off the edge (E13)', async () => {
    const outcome = await run('fix-page-size', { size: 'a4', orientation: 'portrait', fit: 'cover' });
    expect(warn(outcome)).toMatch(/fill the page.*up to \d+% of the sheet/i);
  });
});

/* ── E1, E2, E5, E16, E17: inputs handled honestly ───────────────────────── */

describe('inputs are handled honestly', () => {
  it('names the file when it is empty or not a PDF (E1, E2)', async () => {
    const junk = new File([new Uint8Array(Array.from({ length: 64 }, (_, i) => 65 + (i % 26)))], 'notes.txt', {
      type: 'text/plain',
    });
    await expect(
      runPdfTool({ toolId: 'rotate', files: [junk], values: { degrees: 90, pages: 'all' } }),
    ).rejects.toThrow(/notes\.txt.*not a PDF/i);
    await expect(
      runPdfTool({
        toolId: 'pdfs-to-zip',
        files: [new File([new Uint8Array(0)], 'blank.pdf', { type: 'application/pdf' })],
        values: {},
      }),
    ).rejects.toThrow(/blank\.pdf.*(empty|0 bytes)/i);
  });

  it('unlocks a protected document and does not hand it back still encrypted (E5)', async () => {
    const locked = fileOf(await encrypt(await sheets(grid(4))), 'locked.pdf');
    expect(text(await bytesFrom(locked))).toMatch(/\/Encrypt/);

    const outcome = await run('rotate', { degrees: 90, pages: 'all' }, [locked], 'hunter2');
    const bytes = await bytesOf(outcome);
    // Rotating a protected contract must not quietly un-protect it: the password
    // is re-applied and the run says so. (The runner skips this for tools whose
    // own job is removing protection — see `stripsProtection`.)
    expect(text(bytes)).toMatch(/\/Encrypt/);
    const doc = await PDFDocument.load(bytes, { password: 'hunter2' });
    expect(doc.getPages()[0].getRotation().angle).toBe(90);
    expect(warn(outcome)).toMatch(/re-applied/i);
  });

  it('says when a file was added twice instead of merging it silently (E16)', async () => {
    const source = fileOf(await sheets(grid(4)), 'a.pdf');
    const outcome = await run('merge', {}, [source, source]);
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPageCount()).toBe(8);
    expect(warn(outcome)).toMatch(/"a\.pdf" appears twice in the queue/i);
  });

  it('keeps a sane download name for a spaced, unicode filename (E17)', async () => {
    const source = fileOf(await sheets(grid(4)), '发票 2024 draft.pdf');
    const outcome = await run('split', { mode: 'ranges', ranges: '1-2,1-2' }, [source]);
    expect(outcome.outputs.map((output) => output.name)).toEqual([
      '发票 2024 draft_pages-1-2.pdf',
      '发票 2024 draft_pages-1-2-2.pdf',
    ]);
    for (const output of outcome.outputs) {
      expect(output.name).not.toMatch(/[\\:*?"<>]/);
      const doc = await open(new Uint8Array(await output.blob.arrayBuffer()));
      expect(doc.getPageCount()).toBe(2);
    }
  });

  it('does not overwrite an archive entry when two files share a name (E16, E17)', async () => {
    const a = fileOf(await sheets([{ width: 200, height: 100 }]), 'same.pdf');
    const b = fileOf(await sheets([{ width: 300, height: 100 }]), 'same.pdf');
    const outcome = await run('pdfs-to-zip', {}, [a, b]);
    const entries = await zipEntries(outcome.outputs[0].blob);
    expect(entries.filter((entry) => entry.startsWith('same'))).toEqual(['same.pdf', 'same-2.pdf']);
    expect(warn(outcome)).toMatch(/share the name/i);
  });

  it('says that a protected file is still protected inside the archive (E5)', async () => {
    const openFile = fileOf(await sheets(grid(1)), 'open.pdf');
    const locked = fileOf(await encrypt(await sheets(grid(1))), 'locked.pdf');
    const outcome = await run('pdfs-to-zip', { includeReport: true }, [locked, openFile], 'hunter2');
    expect(warn(outcome)).toMatch(/"locked\.pdf" is still password protected inside the archive/i);
  });
});

async function bytesFrom(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

/* ── E13: nothing to do, and plans that would produce nothing ────────────── */

describe('empty results are reported, not downloaded', () => {
  it('produces no empty even-pages file for a one-page document (E13)', async () => {
    const source = fileOf(await sheets(grid(1)), 'one.pdf');
    const outcome = await run('split', { mode: 'oddEven', oddEven: 'both' }, [source]);
    expect(outcome.outputs).toHaveLength(1);
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPageCount()).toBe(1);
    expect(warn(outcome)).toMatch(/no even pages/i);
  });

  it('does not mention a missing side the user did not ask for (E13)', async () => {
    const source = fileOf(await sheets(grid(1)), 'one.pdf');
    const outcome = await run('split', { mode: 'oddEven', oddEven: 'odd' }, [source]);
    expect(outcome.outputs).toHaveLength(1);
    expect(warn(outcome)).not.toMatch(/no even pages/i);
  });

  it('names a poster grid that only copies the page (E13)', async () => {
    const outcome = await run('posterize', { columns: 1, rows: 1, bleed: 0, pages: 'all' });
    expect(warn(outcome)).toMatch(/copies each page rather than splitting/i);
  });

  it('says when a one-page document cannot be reversed or collated (E13)', async () => {
    const source = fileOf(await sheets(grid(1)), 'one.pdf');
    expect(warn(await run('reverse-pages', {}, [source]))).toMatch(/reversing changes nothing/i);
    expect(warn(await run('duplex-collate', {}, [source]))).toMatch(/cannot be collated/i);
  });

  it('reports the pages a collation plan drops (E13)', async () => {
    const source = fileOf(await sheets(grid(6)), 'six.pdf');
    const outcome = await run('duplex-collate', { backReversed: true, offset: 1 }, [source]);
    expect(warn(outcome)).toMatch(/leaves 1 page out \(4\)/i);
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPageCount()).toBe(5);
  });

  it('bounds the back-side offset to what the scan can hold (E15)', async () => {
    const source = fileOf(await sheets(grid(6)), 'six.pdf');
    const outcome = await run('duplex-collate', { offset: 5 }, [source]);
    expect(warn(outcome)).toMatch(/back-side page offset must be between 0 and 3 pages: 5 became 3/i);
  });

  it('tells you when the stamp ran out of pages (E6)', async () => {
    const base = fileOf(await sheets(grid(4)), 'base.pdf');
    const stamp = fileOf(await sheets([{ width: 300, height: 100 }]), 'stamp.pdf');
    const outcome = await run('overlay-pdf', { mode: 'overlay', mapping: 'same', opacity: 1, scale: 1 }, [base, stamp]);
    expect(warn(outcome)).toMatch(/the last 3 pages reused stamp page 1/i);
  });

  it('accepts a plan of only blank sheets rather than saving an empty PDF (E13)', async () => {
    const source = fileOf(await sheets(grid(1)), 'one.pdf');
    const outcome = await run('organize', { pageOrder: 'blank, blank' }, [source]);
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPageCount()).toBe(2);
    expect(warn(outcome)).toMatch(/only the 2 blank sheets you asked for/i);
  });
});

/* ── the compromises the brief asks to be reported ────────────────────────── */

describe('compromises reach the result card', () => {
  it('really draws an underlay behind the page (E13 honesty)', async () => {
    const base = fileOf(await sheets([{ width: 200, height: 100 }]), 'base.pdf');
    const stamp = fileOf(await sheets([{ width: 300, height: 100 }]), 'stamp.pdf');
    const behind = await run('overlay-pdf', { mode: 'underlay', mapping: 'first', opacity: 1, scale: 1 }, [base, stamp]);
    const inFront = await run('overlay-pdf', { mode: 'overlay', mapping: 'first', opacity: 1, scale: 1 }, [base, stamp]);

    // Underlay: the stamp first, then the page's own content re-laid on top.
    const behindStamps = stampsOf(await open(await bytesOf(behind)), 0).map((s) => s.bbox.join(' '));
    expect(behindStamps).toEqual(['0 0 300 100', '0 0 200 100']);
    // Overlay: the base page keeps its own content and only gains the stamp.
    const frontStamps = stampsOf(await open(await bytesOf(inFront)), 0).map((s) => s.bbox.join(' '));
    expect(frontStamps).toEqual(['0 0 300 100']);
    // And the underlaid page is still the original page object: same rotation.
    const doc = await open(await bytesOf(behind));
    expect(doc.getPageCount()).toBe(1);
  });

  it('admits that a rebuild leaves bookmarks behind (E20)', async () => {
    const merged = await run('merge', {}, [
      fileOf(await sheets(grid(2)), 'a.pdf'),
      fileOf(await sheets(grid(2)), 'b.pdf'),
    ]);
    const bytes = await bytesOf(merged);
    const outlineRef = (await open(bytes)).catalog.get(PDFName.of('Outlines'));
    expect(outlineRef, 'merge should have written per-file bookmarks').toBeTruthy();

    const again = await run('merge', {}, [fileOf(bytes, 'merged.pdf'), fileOf(await sheets(grid(1)), 'c.pdf')]);
    expect(warn(again)).toMatch(/already had bookmarks/i);

    const nup = await run('n-up', { perSheet: 2, sheetSize: 'a4', landscape: false }, [fileOf(bytes, 'merged.pdf')]);
    expect(warn(nup)).toMatch(/bookmarks are not in the output/i);
    expect(warn(nup)).toMatch(/CoherentPDF/i);
  });

  it('fills a booklet to whole sheets instead of dropping the odd pages (E13)', async () => {
    const source = fileOf(
      await sheets(Array.from({ length: 6 }, (_, i) => ({ width: 150 + i * 10, height: 100 }))),
      'six.pdf',
    );
    const outcome = await run('booklet', { sheetSize: 'a4', landscape: true }, [source]);
    const doc = await open(await bytesOf(outcome));
    // 6 pages → 8 cells → 4 PDF pages of two cells each, which is 2 physical
    // sheets printed duplex, and none of the 6 source pages may go missing.
    expect(doc.getPageCount()).toBe(4);
    const seen = doc.getPages().flatMap((_, index) => stampsOf(doc, index).map((stamp) => stamp.bbox.join(' ')));
    expect(new Set(seen).size).toBe(6);
    expect(outcome.message).toMatch(/4 printed sides on 2 double-sided sheets with 2 pages added/i);
    expect(warn(outcome)).toMatch(/sheets of four, so 2 pages were padded in to complete the last sheet/i);
  });

  it('says when the PDF height limit cuts or splits the scroll (E12)', async () => {
    const tall = fileOf(await sheets(grid(3, { height: 6000 })), 'tall.pdf');
    const split = await run('combine-single-page', { gap: 0, width: 'widest', splitOverflow: true }, [tall]);
    expect(warn(split)).toMatch(/scroll is 2 sheets long because of the 14 400 pt page limit/i);
    const doc = await open(await bytesOf(split));
    expect(doc.getPageCount()).toBe(2);
    for (const page of doc.getPages()) expect(page.getHeight()).toBeLessThanOrEqual(14400);

    const single = await run('combine-single-page', { gap: 0, width: 'widest', splitOverflow: false }, [tall]);
    expect(warn(single)).toMatch(/18000 pt tall, past the 14 400 pt limit/i);
  });

  it('leaves nothing behind when the run is cancelled (E19)', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runPdfTool({
        toolId: 'merge',
        files: [fileOf(await sheets(grid(2)), 'a.pdf'), fileOf(await sheets(grid(2)), 'b.pdf')],
        values: {},
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/i);
  });

  it('counts what it did, in the sentence the result card shows', async () => {
    const outcome = await run('extract-pages', { pages: '2-3', mergeIntoOne: true });
    expect(outcome.message).toBe('Extracted 2 pages of 4 pages.');
    const deleted = await run('remove-pages', { pages: '2' });
    expect(deleted.message).toBe('Removed 1 page, kept 3 pages.');
    const rotated = await run('rotate', { degrees: 180, pages: '1,4' });
    expect(rotated.message).toBe('Rotated 2 pages by 180°, left 2 pages alone.');
  });
});

/* ── every tool measured on the bytes it wrote ────────────────────────────── */

/**
 * The bar this block exists to hold: each organize tool runs on a real document
 * and the assertion is about the file that comes back — page count, page sizes,
 * rotation values, the order the words appear in, the image bytes in an archive.
 * A tool whose sentence is right and whose file is wrong fails here.
 */
describe('each tool is checked against its own output file', () => {
  it('extract-pages writes the pages it was asked for, in the order typed', async () => {
    const merged = await run('extract-pages', { pages: '3,1', mergeIntoOne: true });
    const doc = await open(await bytesOf(merged));
    expect(pageTexts(doc)).toEqual(['sheet 3', 'sheet 1']);

    const separate = await run('extract-pages', { pages: '1,3', mergeIntoOne: false });
    expect(separate.outputs.map((output) => output.name)).toEqual([
      'fixture_page-1.pdf',
      'fixture_page-3.pdf',
    ]);
    const each: string[] = [];
    for (const output of separate.outputs) {
      const one = await open(new Uint8Array(await output.blob.arrayBuffer()));
      expect(one.getPageCount()).toBe(1);
      each.push(drawnText(one, 0));
    }
    expect(each).toEqual(['sheet 1', 'sheet 3']);
  });

  it('remove-pages takes out the sheet it names and leaves the rest in order', async () => {
    const outcome = await run('remove-pages', { pages: '2' });
    const doc = await open(await bytesOf(outcome));
    expect(pageTexts(doc)).toEqual(['sheet 1', 'sheet 3', 'sheet 4']);
  });

  it('reverse-pages hands back the last sheet first', async () => {
    const outcome = await run('reverse-pages');
    const doc = await open(await bytesOf(outcome));
    expect(pageTexts(doc)).toEqual(['sheet 4', 'sheet 3', 'sheet 2', 'sheet 1']);
  });

  it('organize writes the order, rotation and blanks the plan describes', async () => {
    const outcome = await run('organize', { pageOrder: '3, 1, blank' });
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPageCount()).toBe(3);
    expect(drawnText(doc, 0)).toBe('sheet 3');
    expect(drawnText(doc, 1)).toBe('sheet 1');
    expect(drawnText(doc, 2), 'the planned blank sheet must hold nothing').toBe('');
    // The blank borrows the size of the sheet before it (E8).
    expect(doc.getPage(2).getSize()).toEqual(doc.getPage(1).getSize());
  });

  it('alternate-merge interleaves, and reverses only the later files', async () => {
    const a = fileOf(await sheets(grid(3)), 'a.pdf');
    const b = fileOf(await sheets(grid(3)), 'b.pdf');

    const oneOne = await open(await bytesOf(await run('alternate-merge', { pattern: '1-1' }, [a, b])));
    expect(oneOne.getPageCount()).toBe(6);

    // Both files say "sheet 1..3", so the order is read from their sizes:
    // `a` is 200 × 100 and `b` is built 300 × 100 wide below.
    const wide = fileOf(
      await sheets(Array.from({ length: 3 }, () => ({ width: 300, height: 100 }))),
      'b.pdf',
    );
    const size = (doc: PDFDocument) => doc.getPages().map((page) => Math.round(page.getWidth()));

    expect(size(oneOne)).toEqual([200, 200, 200, 200, 200, 200]);
    const pair = await open(await bytesOf(await run('alternate-merge', { pattern: '1-1' }, [a, wide])));
    expect(size(pair)).toEqual([200, 300, 200, 300, 200, 300]);

    const twoTwo = await open(await bytesOf(await run('alternate-merge', { pattern: '2-2' }, [a, wide])));
    expect(size(twoTwo)).toEqual([200, 200, 300, 300, 200, 300]);

    // The option says "later files reversed": the first file keeps its order.
    const turned = await open(await bytesOf(await run('alternate-merge', { pattern: 'reverse-alternate' }, [a, wide])));
    expect(size(turned)).toEqual([200, 300, 200, 300, 200, 300]);
    const turnedTexts = turned.getPages().map((_, index) => drawnText(turned, index));
    expect(turnedTexts[0], 'the front block must start at its own page 1').toBe('sheet 1');
    expect(turnedTexts[1], 'the back block starts at the last page of the later file').toBe('sheet 3');
  });

  it('duplex-collate places each back page beside its own front page', async () => {
    const outcome = await run('duplex-collate', { backReversed: true, offset: 0 });
    const doc = await open(await bytesOf(outcome));
    // 4 pages: fronts 1,2 and backs 4,3 → sheets 1|4 and 2|3.
    expect(pageTexts(doc)).toEqual(['sheet 1', 'sheet 4', 'sheet 2', 'sheet 3']);
  });

  it('posterize keeps every tile at one scale and overlaps its neighbour', async () => {
    const one = fileOf(await sheets([{ width: 200, height: 100 }]), 'one.pdf');
    const outcome = await run('posterize', { columns: 2, rows: 2, bleed: 10, pages: 'all' }, [one]);
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPageCount()).toBe(4);
    for (const page of doc.getPages()) {
      expect(page.getSize()).toEqual({ width: 110, height: 60 });
    }
    // Each sheet is the tile plus 10 pt taken from the sheet before it, so the
    // cut lines meet. `/BBox` is `[left, bottom, right, top]` in the source
    // page's own space: x 0-110 / 90-200 and y 40-100 / 0-60.
    const boxes = doc.getPages().map((_, index) => stampsOf(doc, index)[0].bbox);
    expect(boxes).toEqual([
      [0, 40, 110, 100],
      [90, 40, 200, 100],
      [0, 0, 110, 60],
      [90, 0, 200, 60],
    ]);
    // …and nothing is magnified to fill the sheet, which is what used to make the
    // edge tiles print bigger than the middle ones.
    for (const [index, source] of boxes.entries()) {
      const stamp = stampsOf(doc, index)[0];
      const region = [source[0], source[1], source[2] - source[0], source[3] - source[1]] as [
        number,
        number,
        number,
        number,
      ];
      const box = mappedBox(stamp, region);
      expect(box.width, `tile ${index} must be drawn at its own scale`).toBeCloseTo(region[2], 3);
      expect(box.height, `tile ${index} must be drawn at its own scale`).toBeCloseTo(region[3], 3);
    }
  });

  it('divide-pages writes the count of pieces the sentence reports', async () => {
    const outcome = await run('divide-pages', { axis: 'grid', columns: 2, rows: 2, pages: 'all' });
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPageCount()).toBe(16);
    expect(outcome.message).toBe('Divided 4 pages into 16 pages.');
    // Quarter of a 200 × 100 sheet: 100 × 50, and the words survive the cut.
    for (const page of doc.getPages()) expect(page.getSize()).toEqual({ width: 100, height: 50 });
    expect(drawnText(doc, 0)).toContain('sheet 1');
    expect(drawnText(doc, 8)).toContain('sheet 3');
  });

  it('fix-page-size resizes the chosen pages and carries the others through', async () => {
    const source = fileOf(
      await sheets([
        { width: 200, height: 100 },
        { width: 400, height: 300 },
        { width: 200, height: 100 },
      ]),
      'mixed.pdf',
    );
    const outcome = await run('fix-page-size', { size: 'a4', orientation: 'keep', fit: 'contain', pages: '2' }, [source]);
    const doc = await open(await bytesOf(outcome));
    // The pages that were not picked are not pages to delete (E13).
    expect(doc.getPageCount()).toBe(3);
    expect(doc.getPages().map((page) => [Math.round(page.getWidth()), Math.round(page.getHeight())])).toEqual([
      [200, 100],
      [595, 842],
      [200, 100],
    ]);
    expect(warn(outcome)).toMatch(/2 pages you did not select were copied through at their own size/i);
    expect(outcome.message).toMatch(/Normalised 1 page to 595 × 842 pt.*carried 2 pages over unchanged/i);
  });

  it('fix-page-size says so when the selection already matches the target', async () => {
    const letter = fileOf(
      await sheets(Array.from({ length: 3 }, () => ({ width: 612, height: 792 }))),
      'letter.pdf',
    );
    const outcome = await run('fix-page-size', { size: 'letter', orientation: 'keep', fit: 'contain' }, [letter]);
    expect(warn(outcome)).toMatch(/already 612 × 792 pt, so only the rebuild changed/i);
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPageCount()).toBe(3);
    expect(outcome.message).toMatch(/Every selected page already matched 612 × 792 pt/i);
  });

  it('add-blank-page puts an empty sheet where it was told', async () => {
    const source = fileOf(await sheets(grid(3)), 'three.pdf');
    const start = await open(await bytesOf(await run('add-blank-page', { position: 'start', count: 2, size: 'same' }, [source])));
    expect(start.getPageCount()).toBe(5);
    expect([drawnText(start, 0), drawnText(start, 1)]).toEqual(['', '']);
    expect(drawnText(start, 2)).toBe('sheet 1');

    const before = await open(await bytesOf(await run('add-blank-page', { position: 'before', anchor: 2, count: 1, size: 'letter' }, [source])));
    expect(before.getPages().map((page) => Math.round(page.getWidth()))).toEqual([200, 612, 200, 200]);
    // The named sheet was not overwritten on the way (E13).
    expect(pageTexts(before)).toEqual(['sheet 1', '', 'sheet 2', 'sheet 3']);
  });

  it('overlay fits the stamp to the base sheet rather than to its own size', async () => {
    const base = fileOf(await sheets([{ width: 200, height: 100 }]), 'base.pdf');
    const stamp = fileOf(await sheets([{ width: 400, height: 100 }]), 'stamp.pdf');
    const outcome = await run('overlay-pdf', { mode: 'overlay', mapping: 'first', opacity: 1, scale: 1 }, [base, stamp]);
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPageCount()).toBe(1);
    const drawn = mappedBox(stampsOf(doc, 0)[0], [0, 0, 400, 100]);
    // 1× means "cover the base page": the 400 × 100 stamp lands 200 × 50 inside
    // it, which is what the field's help now says.
    expect(drawn.width).toBeCloseTo(200, 3);
    expect(drawn.height).toBeCloseTo(50, 3);
    expect(drawn.x).toBeCloseTo(0, 3);
  });

  it('overlay says when the stamp file has pages the base will never reach', async () => {
    const base = fileOf(await sheets(grid(1)), 'base.pdf');
    const stamp = fileOf(await sheets(grid(3)), 'stamp.pdf');
    const outcome = await run('overlay-pdf', { mode: 'overlay', mapping: 'same', opacity: 1, scale: 1 }, [base, stamp]);
    expect(warn(outcome)).toMatch(/stamp pages 2-3 were never used/i);
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPageCount()).toBe(1);
  });

  it('n-up lays the pages on one sheet and keeps them as text', async () => {
    const outcome = await run('n-up', { perSheet: 4, sheetSize: 'a4', landscape: false, gutter: 0, margin: 0, pages: 'all' });
    const bytes = await bytesOf(outcome);
    const doc = await open(bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(text(bytes), 'N-up must not rasterise').not.toMatch(/\/Subtype\s*\/Image/);
    // All four sheets are still words in the file, just smaller and moved.
    for (const label of ['sheet 1', 'sheet 2', 'sheet 3', 'sheet 4']) {
      expect(drawnText(doc, 0)).toContain(label);
    }
    expect(stampsOf(doc, 0)).toHaveLength(4);
  });

  it('combine-single-page stacks the sheets into one long page', async () => {
    const outcome = await run('combine-single-page', { gap: 0, width: 'widest', splitOverflow: true, pages: 'all' });
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPageCount()).toBe(1);
    const page = doc.getPage(0);
    expect(Math.round(page.getWidth())).toBe(200);
    // Four 200 × 100 sheets, one after another, is 400 pt of content on a
    // 400 pt sheet — and every word is still in the file.
    expect(Math.round(page.getHeight())).toBe(400);
    for (const label of ['sheet 1', 'sheet 4']) expect(drawnText(doc, 0)).toContain(label);
  });

  it('split by page writes one real file per sheet', async () => {
    const outcome = await run('split', { mode: 'every' });
    expect(outcome.outputs).toHaveLength(4);
    const texts: string[] = [];
    for (const output of outcome.outputs) {
      const doc = await open(new Uint8Array(await output.blob.arrayBuffer()));
      expect(doc.getPageCount()).toBe(1);
      texts.push(drawnText(doc, 0));
    }
    expect(texts).toEqual(['sheet 1', 'sheet 2', 'sheet 3', 'sheet 4']);
    expect(outcome.outputs.map((output) => output.name)).toEqual([
      'fixture_page-1.pdf',
      'fixture_page-2.pdf',
      'fixture_page-3.pdf',
      'fixture_page-4.pdf',
    ]);
  });

  it('pdfs-to-zip stores the files byte for byte', async () => {
    const a = fileOf(await sheets(grid(2)), 'first.pdf');
    const b = fileOf(await sheets(grid(2)), 'second.pdf');
    const outcome = await run('pdfs-to-zip', { includeReport: true }, [a, b]);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(new Uint8Array(await outcome.outputs[0].blob.arrayBuffer()));
    expect(Object.keys(zip.files).sort()).toEqual(['first.pdf', 'manifest.txt', 'second.pdf']);
    for (const [name, file] of [['first.pdf', a], ['second.pdf', b]] as [string, File][]) {
      const stored = await zip.file(name)!.async('uint8array');
      expect(Buffer.from(stored).equals(Buffer.from(new Uint8Array(await file.arrayBuffer())))).toBe(true);
    }
    const manifest = await zip.file('manifest.txt')!.async('string');
    expect(manifest).toMatch(/first\.pdf — 2 pages —/);
  });

  it('remove-blank-pages drops the sheet that paints nothing', async () => {
    const source = fileOf(
      await sheets([
        { width: 200, height: 100 },
        { width: 200, height: 100, empty: true },
        { width: 300, height: 150 },
      ]),
      'scan.pdf',
    );
    const outcome = await run('remove-blank-pages', { keepAnnotated: true }, [source]);
    const doc = await open(await bytesOf(outcome));
    expect(pageTexts(doc)).toEqual(['sheet 1', 'sheet 3']);
    expect(outcome.message).toMatch(/Removed 1 page \(2\), kept 2 pages/i);
  });

  it('remove-blank-pages treats a scanned sheet as ink, not as blank', async () => {
    const source = fileOf(
      await sheets([
        { width: 300, height: 150, image: true },
        { width: 200, height: 100, empty: true },
      ]),
      'scan.pdf',
    );
    const outcome = await run('remove-blank-pages', { keepAnnotated: true }, [source]);
    const doc = await open(await bytesOf(outcome));
    // The scan carries no text at all: if the display list were unread, this is
    // the page that would have been thrown away.
    expect(doc.getPages().map((page) => [Math.round(page.getWidth()), Math.round(page.getHeight())])).toEqual([[300, 150]]);
  });

  it('remove-blank-pages keeps a document whose pages all have content', async () => {
    const outcome = await run('remove-blank-pages', { keepAnnotated: true });
    expect(outcome.message).toMatch(/No blank pages were found in 4 pages — nothing was removed/i);
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPageCount()).toBe(4);
  });

  it('remove-blank-pages refuses a file that is nothing but blanks', async () => {
    const source = fileOf(await sheets(grid(2, { empty: true })), 'blank.pdf');
    await expect(run('remove-blank-pages', { keepAnnotated: true }, [source])).rejects.toThrow(
      /look blank, and deleting every one/i,
    );
  });

  it('pdf-to-cbz archives the pages it was given, as real images', async () => {
    const source = fileOf(await sheets(grid(4)), 'comic.pdf');
    const outcome = await run('pdf-to-cbz', { format: 'png', dpi: 96, pages: '2-4' }, [source]);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(new Uint8Array(await outcome.outputs[0].blob.arrayBuffer()));
    const entries = Object.keys(zip.files).sort();
    // Three sheets, not the whole document, numbered in reading order. The
    // archive layer flattens `/` in entry names, so the tool names them flat.
    expect(entries).toEqual(['comic-001.png', 'comic-002.png', 'comic-003.png']);
    for (const entry of entries) {
      const bytes = await zip.file(entry)!.async('uint8array');
      expect([...bytes.slice(0, 4)], `${entry} is not a PNG`).toEqual([0x89, 0x50, 0x4e, 0x47]);
    }
    expect(outcome.outputs[0].name).toBe('comic.cbz');
  });

  it('a spaced page range selects the pages it names, not the document (E15)', async () => {
    const outcome = await run('extract-pages', { pages: '1 - 2', mergeIntoOne: true });
    const doc = await open(await bytesOf(outcome));
    expect(pageTexts(doc)).toEqual(['sheet 1', 'sheet 2']);

    await expect(run('extract-pages', { pages: '-', mergeIntoOne: true })).rejects.toThrow(
      /range with no page numbers/i,
    );
  });

  it('merge writes a bookmark that lands on each file’s own first page', async () => {
    const a = fileOf(await sheets(grid(2)), 'a.pdf');
    const b = fileOf(await sheets([{ width: 300, height: 100 }]), 'b.pdf');
    const outcome = await run('merge', { bookmarks: true }, [a, b]);
    const doc = await open(await bytesOf(outcome));
    expect(pageTexts(doc)).toEqual(['sheet 1', 'sheet 2', 'sheet 1']);

    const outlines = dictOf(doc, doc.catalog.get(PDFName.of('Outlines')));
    expect(outlines, 'merge should have written an outline').not.toBeNull();
    const refs = doc.getPages().map((page) => String(page.ref));
    const titles: [string, number][] = [];
    let item = dictOf(doc, outlines!.get(PDFName.of('First')));
    for (let guard = 0; item && guard < 10; guard++) {
      const dest = doc.context.lookup(item.get(PDFName.of('Dest')));
      const target = dest instanceof PDFArray ? String(dest.get(0)) : '';
      titles.push([pdfText(item.get(PDFName.of('Title'))), refs.indexOf(target)]);
      item = dictOf(doc, item.get(PDFName.of('Next')));
    }
    expect(titles.map(([title]) => title)).toEqual(['a.pdf', 'b.pdf']);
    expect(titles.map(([, page]) => page)).toEqual([0, 2]);
  });

  it('merge leaves the form field list behind, as its note says', async () => {
    const withForm = await PDFDocument.create();
    const page = withForm.addPage([200, 100]);
    withForm.getForm().createTextField('answer').addToPage(page, { x: 20, y: 40, width: 80, height: 20 });
    const form = fileOf(await withForm.save({ useObjectStreams: false }), 'form.pdf');
    const plain = fileOf(await sheets(grid(1)), 'plain.pdf');

    const outcome = await run('merge', {}, [form, plain]);
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPageCount()).toBe(2);
    // The widget annotation is still on the page, but the catalogue's /AcroForm
    // is gone — which is why PAGE_COPY_NOTE says a form stops being editable
    // rather than claiming form fields travel intact.
    const annots = doc.getPages().map((leaf) => {
      const array = doc.context.lookup(leaf.node.get(PDFName.of('Annots')), PDFArray);
      return array instanceof PDFArray ? array.size() : 0;
    });
    expect(annots).toEqual([1, 0]);
    expect(doc.catalog.get(PDFName.of('AcroForm')), 'the field list should be gone').toBeUndefined();

    const notes = (getPdfTool('merge')?.notes ?? []).join(' ');
    expect(notes).toMatch(/form/i);
    expect(notes).not.toMatch(/form fields travel|form fields inside them keep working/i);
  });

  it('rotate turns the pages the field names, and calls nothing a correction it did not make (E15)', async () => {
    const odd = await run('rotate', { degrees: 90, pages: 'odd' });
    expect(odd.warnings, warn(odd)).toEqual([]);
    expect((await open(await bytesOf(odd))).getPages().map((page) => page.getRotation().angle)).toEqual([
      90,
      0,
      90,
      0,
    ]);

    const openEnd = await run('rotate', { degrees: 180, pages: '3-' });
    expect(openEnd.warnings, warn(openEnd)).toEqual([]);
    expect((await open(await bytesOf(openEnd))).getPages().map((page) => page.getRotation().angle)).toEqual([
      0,
      0,
      180,
      180,
    ]);

    // A half turn is a quarter turn twice over: no snapping happened, so the run
    // must not claim one, and the pages must say otherwise too.
    const turned = await run('rotate', { degrees: 270, pages: 'all' });
    expect(turned.warnings, warn(turned)).toEqual([]);
    expect((await open(await bytesOf(turned))).getPages().every((page) => page.getRotation().angle === 270)).toBe(true);
  });

  it('split odd/even puts each side of the sheet in its own file', async () => {
    const five = fileOf(await sheets(grid(5)), 'five.pdf');
    const outcome = await run('split', { mode: 'oddEven', oddEven: 'both' }, [five]);
    expect(outcome.outputs.map((output) => output.name)).toEqual(['five_odd-pages.pdf', 'five_even-pages.pdf']);
    const sides: string[][] = [];
    for (const output of outcome.outputs) {
      sides.push(pageTexts(await open(new Uint8Array(await output.blob.arrayBuffer()))));
    }
    expect(sides).toEqual([
      ['sheet 1', 'sheet 3', 'sheet 5'],
      ['sheet 2', 'sheet 4'],
    ]);
  });

  it('split names a one-page range for the one page it holds (E17)', async () => {
    const outcome = await run('split', { mode: 'ranges', ranges: '2,2,2-3' });
    expect(outcome.outputs.map((output) => output.name)).toEqual([
      'fixture_page-2.pdf',
      'fixture_page-2-2.pdf',
      'fixture_pages-2-3.pdf',
    ]);
    const counts: number[] = [];
    for (const output of outcome.outputs) {
      counts.push((await open(new Uint8Array(await output.blob.arrayBuffer()))).getPageCount());
    }
    expect(counts).toEqual([1, 1, 2]);

    // Chunks cut the same way: whole files first, and the short tail is the one
    // sheet it is, not `pages-5-5`.
    const five = fileOf(await sheets(grid(5)), 'five.pdf');
    const chunks = await run('split', { mode: 'chunks', chunkSize: 2 }, [five]);
    expect(chunks.outputs.map((output) => output.name)).toEqual([
      'five_pages-1-2.pdf',
      'five_pages-3-4.pdf',
      'five_page-5.pdf',
    ]);
    const grouped: string[][] = [];
    for (const output of chunks.outputs) {
      grouped.push(pageTexts(await open(new Uint8Array(await output.blob.arrayBuffer()))));
    }
    expect(grouped).toEqual([
      ['sheet 1', 'sheet 2'],
      ['sheet 3', 'sheet 4'],
      ['sheet 5'],
    ]);
  });

  it('merge’s spacer sheet belongs beside the file it follows, and bookmarks can be switched off', async () => {
    const a = fileOf(await sheets(grid(2)), 'a.pdf');
    const b = fileOf(await sheets(Array.from({ length: 2 }, () => ({ width: 300, height: 200 }))), 'b.pdf');
    const outcome = await run('merge', { blankBetween: true, bookmarks: false }, [a, b]);
    const bytes = await bytesOf(outcome);
    const doc = await open(bytes);
    expect(pageTexts(doc)).toEqual(['sheet 1', 'sheet 2', '', 'sheet 1', 'sheet 2']);
    // The spacer copies the sheet before it — page 3 measures like `a`, not `b`.
    expect(doc.getPages().map((page) => [Math.round(page.getWidth()), Math.round(page.getHeight())])).toEqual([
      [200, 100],
      [200, 100],
      [200, 100],
      [300, 200],
      [300, 200],
    ]);
    expect(text(bytes), 'the toggle says no entries are written when it is off').not.toMatch(/\/Outlines/);
    expect(outcome.message).toBe('Merged 2 files into 5 pages.');
  });

  it('booklet gives every printed side one spread, in saddle-stitch order', async () => {
    const six = fileOf(
      await sheets(Array.from({ length: 6 }, (_, i) => ({ width: 150 + i * 10, height: 100 }))),
      'six.pdf',
    );
    const outcome = await run('booklet', { sheetSize: 'a4', landscape: true, gutter: 0, margin: 0 }, [six]);
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPageCount()).toBe(4);
    const half = doc.getPage(0).getWidth() / 2;
    // A sheet is identified by the width its source page was drawn at, and by
    // which half of the printed side it landed on.
    const sides = doc.getPages().map((_, index) =>
      stampsOf(doc, index)
        .map((stamp) => {
          const box = mappedBox(stamp, [0, 0, stamp.bbox[2], stamp.bbox[3]]);
          return `${box.x + box.width / 2 > half ? 1 : 0}:${Math.round(stamp.bbox[2])}`;
        })
        .sort(),
    );
    // Front of sheet 1: the padded blank at the outer left, page 1 at the right.
    // Back of sheet 1: page 2 with the second blank beside it. Sheet 2 is the
    // inner pair. Four booklet pages per side would mean two sheets of the
    // imposed file printing on top of each other and two printing blank.
    expect(sides).toEqual([['1:150'], ['0:160'], ['0:200', '1:170'], ['0:180', '1:190']]);
    // The padding is the sheets-of-four sentence's business; it is not a page
    // that failed to draw.
    expect(warn(outcome)).toMatch(/sheets of four, so 2 pages were padded in/i);
    expect(warn(outcome)).not.toMatch(/planned cells stayed blank/i);
  });

  it('n-up fills the cells in the order the field names', async () => {
    const varied = fileOf(
      await sheets([
        { width: 100, height: 100 },
        { width: 200, height: 100 },
        { width: 300, height: 100 },
        { width: 400, height: 100 },
      ]),
      'varied.pdf',
    );
    const runOrder = async (order: string): Promise<string[]> => {
      const doc = await open(
        await bytesOf(await run('n-up', { perSheet: 4, order, sheetSize: 'a4', landscape: true, gutter: 0, margin: 0 }, [varied])),
      );
      const sheet = doc.getPage(0);
      const mid = { x: sheet.getWidth() / 2, y: sheet.getHeight() / 2 };
      return stampsOf(doc, 0).map((stamp) => {
        const box = mappedBox(stamp, [0, 0, stamp.bbox[2], stamp.bbox[3]]);
        const col = box.x + box.width / 2 > mid.x ? 1 : 0;
        // PDF y grows upward; row 0 is the top of the sheet as it prints.
        const row = box.y + box.height / 2 > mid.y ? 0 : 1;
        return `${Math.round(stamp.bbox[2])}@${row * 2 + col}`;
      });
    };

    expect(await runOrder('across')).toEqual(['100@0', '200@1', '300@2', '400@3']);
    expect(await runOrder('down')).toEqual(['100@0', '200@2', '300@1', '400@3']);
  });

  it('fix-page-size takes the most common sheet, or the largest, as its target', async () => {
    const mixed = fileOf(
      await sheets([
        { width: 200, height: 100 },
        { width: 200, height: 100 },
        { width: 400, height: 300 },
      ]),
      'mixed.pdf',
    );
    const sizes = (doc: PDFDocument) =>
      doc.getPages().map((page) => [Math.round(page.getWidth()), Math.round(page.getHeight())]);

    const common = await run('fix-page-size', { size: 'most-common', orientation: 'keep', fit: 'contain' }, [mixed]);
    const commonDoc = await open(await bytesOf(common));
    expect(sizes(commonDoc)).toEqual([
      [200, 100],
      [200, 100],
      [200, 100],
    ]);
    expect(common.message).toMatch(/Normalised 1 page to 200 × 100 pt/i);

    const biggest = await run('fix-page-size', { size: 'largest', orientation: 'keep', fit: 'contain' }, [mixed]);
    const bigDoc = await open(await bytesOf(biggest));
    expect(sizes(bigDoc)).toEqual([
      [400, 300],
      [400, 300],
      [400, 300],
    ]);
    // "Largest avoids shrinking anything": the 200 × 100 sheet fills the width.
    expect(Math.round(mappedBox(stampsOf(bigDoc, 0)[0], [0, 0, 200, 100]).width)).toBe(400);
  });

  it('combine-single-page brings every page to one width and keeps the gap between them', async () => {
    const ragged = fileOf(
      await sheets([
        { width: 200, height: 100 },
        { width: 100, height: 100 },
      ]),
      'ragged.pdf',
    );
    const outcome = await run('combine-single-page', { gap: 20, width: 'widest', splitOverflow: true }, [ragged]);
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPageCount()).toBe(1);
    const sheet = doc.getPage(0);
    expect(Math.round(sheet.getWidth())).toBe(200);
    // 100 pt of page, a 20 pt gap, then the 100 pt square blown up to the full
    // 200 pt width — 320 pt of sheet, not the 220 pt a bare-margin reading gives.
    expect(Math.round(sheet.getHeight())).toBe(320);
    const narrow = stampsOf(doc, 0).find((stamp) => Math.round(stamp.bbox[2]) === 100);
    expect(narrow, 'the narrow page must still be in the file').toBeTruthy();
    expect(mappedBox(narrow!, [0, 0, 100, 100]).width).toBeCloseTo(200, 0);
    expect(warn(outcome)).toMatch(/1 page is narrower than 200 pt and scaled up to it/i);
  });

  it('duplex-collate leaves the back block in scan order when it was not reversed', async () => {
    const outcome = await run('duplex-collate', { backReversed: false, offset: 0 });
    expect(pageTexts(await open(await bytesOf(outcome)))).toEqual(['sheet 1', 'sheet 3', 'sheet 2', 'sheet 4']);
  });

  it('pdfs-to-zip repairs a name with no extension without claiming a clash (E16, E17)', async () => {
    const bytes = await sheets(grid(1));
    const odd = new File([new Uint8Array(bytes)], 'scan', { type: 'application/pdf' });
    const single = await run('pdfs-to-zip', { includeReport: false }, [odd]);
    expect(await zipEntries(single.outputs[0].blob)).toEqual(['scan.pdf']);
    expect(warn(single)).not.toMatch(/share the name/i);
    expect(single.outputs[0].name).toBe('scan-bundle.zip');

    const twin = new File([new Uint8Array(bytes)], 'scan', { type: 'application/pdf' });
    const both = await run('pdfs-to-zip', { includeReport: false }, [odd, twin]);
    expect(await zipEntries(both.outputs[0].blob)).toEqual(['scan.pdf', 'scan-2.pdf']);
    expect(warn(both)).toMatch(/Two files share the name "scan\.pdf"; the second was stored as "scan-2\.pdf"/i);
  });

  it('divide-pages cuts strips from the top of the sheet down, and bounds the count it declares (E15)', async () => {
    const one = fileOf(await sheets([{ width: 200, height: 100 }]), 'one.pdf');
    const outcome = await run('divide-pages', { axis: 'horizontal', parts: 3 }, [one]);
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPages().map((page) => [Math.round(page.getWidth()), Math.round(page.getHeight())])).toEqual([
      [200, 33],
      [200, 33],
      [200, 33],
    ]);
    // `/BBox` in the page's own space, where the words sit at the top: the first
    // sheet out is the strip that carries them.
    const strips = doc
      .getPages()
      .map((_, index) => stampsOf(doc, index)[0].bbox.map((n) => Math.round(n) || 0));
    expect(strips).toEqual([
      [0, 67, 200, 100],
      [0, 33, 200, 67],
      [0, 0, 200, 33],
    ]);
    // The fixture writes its line 24 pt below the top of the sheet, so it falls
    // inside the first strip's clipping rectangle and outside the last one's.
    // Which piece *shows* the words is decided by `/BBox`, not by the content
    // stream — the same operators are copied into every piece.
    const line = 76;
    expect(strips.map((box) => box[1] <= line && line <= box[3])).toEqual([true, false, false]);

    // The rail bounds the grid at 9; the run must apply that same ceiling rather
    // than a number written down twice and drifted.
    const wide = await run('divide-pages', { axis: 'grid', columns: 20, rows: 1, pages: '1' });
    expect(warn(wide)).toMatch(/Columns must be between 1 and 9: 20 became 9/i);
    expect((await open(await bytesOf(wide))).getPageCount()).toBe(9);

    // …and a caller that reaches `run()` without the rail’s clamp (a surface,
    // a future tool composing this one) must be corrected the same way, because
    // there is only one declaration of the bounds. This used to cut 12 columns
    // and say “between 1 and 12”.
    const tool = getPdfTool('divide-pages')!;
    const alone = await tool.run!({
      inputs: [
        {
          name: 'one.pdf',
          size: one.size,
          type: 'application/pdf',
          bytes: async () => new Uint8Array(await one.arrayBuffer()),
          blob: () => one,
        },
      ],
      values: { axis: 'grid', columns: 20, rows: 1, pages: 'all' },
      progress: () => {},
      log: () => {},
      signal: new AbortController().signal,
    });
    expect(alone.warnings?.join(' ')).toMatch(/Columns must be between 1 and 9: 20 became 9/i);
    expect(alone.kind).toBe('pdf');
    expect(alone.kind === 'pdf' && (await open(alone.bytes)).getPageCount()).toBe(9);
  });
});

/* ── the page grammar both halves of a selection field share ──────────── */

/**
 * `core/pages.resolvePages` is the parser every "which pages" field in this
 * category ends up in, and `core/guard` re-implements the same grammar to block
 * the click before it. These are the inputs where the two readings differed — a
 * range with the spaces a person types, a bare dash, a number written in a base
 * nobody counts pages in — measured on the parser the tools actually call.
 */
describe('the page-list grammar refuses what it cannot mean', () => {
  it('reads the ranges a person types', () => {
    expect(resolvePages('1 - 3', 6)).toEqual([0, 1, 2]);
    expect(resolvePages('5-', 6)).toEqual([4, 5]);
    expect(resolvePages('odd', 6)).toEqual([0, 2, 4]);
    // A backwards range is the one thing this parser keeps rather than refusing:
    // it means "those pages in that order" to a reordering plan.
    expect(resolvePages('4-2', 6)).toEqual([3, 2, 1]);
  });

  it('refuses a token that names no page instead of reading it as all of them (E15)', () => {
    expect(() => resolvePages('-', 6)).toThrow(/range with no page numbers/i);
    expect(() => resolvePages('to', 6)).toThrow(/range with no page numbers/i);
    expect(() => resolvePages('0x10', 20)).toThrow(/is not a page number or range/i);
    expect(() => resolvePages('1e2', 200)).toThrow(/is not a page number or range/i);
    expect(() => resolvePages('9-4x', 6)).toThrow(/is not a page number or range/i);
    expect(() => resolvePages('7', 6)).toThrow(/has 6 pages/i);
  });
});
