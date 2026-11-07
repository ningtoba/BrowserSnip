/**
 * The output page count, per tool family (worker COUNTS).
 *
 * `ToolResult.pages` is filled by whoever holds the document at the moment it is
 * saved (`helpers.pdfResult` did this for years; the hand-written `{ kind: 'pdf',
 * bytes }` returns did not, so those tools printed `20 in · out not counted`).
 * These tests drive **real tools** through the real runner and check the number
 * the result screen ends up with:
 *
 * - one representative producer per owned file reports the count of what it
 *   actually wrote — an 8-page selection out of a 20-page document reports 8,
 *   not 20 and not nothing;
 * - a multi-output run reports the primary file, never a sum;
 * - a run whose output is not a PDF (zip, image) claims no page count;
 * - a run whose bytes came out of an engine it cannot inspect still prints the
 *   honest "out not counted" wording instead of a fabricated number. The
 *   inflate-and-`/Count` fallback stays unbuilt for the reason given in
 *   `docs/tasks/shell3-request.md` §2.
 *
 * The reported count is always cross-checked against the produced bytes, parsed
 * back with pdf-lib: the test asks whether the number is *true*, not whether the
 * same guess appears twice.
 *
 * jsdom has no canvas, so `core/render` is doubled (a page renders as a stub
 * raster) and the CDN engine in `core/engine-ops` is doubled to hand back real
 * PDF bytes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, StandardFonts, rgb } from '@maxwbh/pdf-lib';
import type { PageRender, PdfSession } from '@/lib/pdf/core/render';
import { describePages } from '@/components/tools/pdf/shared/ResultCard';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { runPdfTool, type RunOutcome } from '@/lib/pdf/tools/runner';
import { defaultValues, type ToolFile, type ToolResult, type ToolValues } from '@/lib/pdf/tools/types';

/* ── doubles ──────────────────────────────────────────────────────────────── */

/**
 * The raster bytes a "rendered page" encodes to, per format. Hoisted because a
 * `vi.mock` factory runs before this file's own declarations do.
 */
const doubles = vi.hoisted(() => {
  const jpeg = Uint8Array.from(
    Buffer.from(
      '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDs0NDL/wAALCAABAAEBAREA/8QAFAABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AmAA/9k=',
      'base64',
    ),
  );
  const png = Uint8Array.from(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
  return {
    jpeg,
    png,
    blob: (format: string): Blob =>
      format === 'jpeg'
        ? new Blob([jpeg as BlobPart], { type: 'image/jpeg' })
        : new Blob([png as BlobPart], { type: 'image/png' }),
  };
});

/** How many pages a render session claims, set per test from the input. */
const session = vi.hoisted(() => ({ pages: 1 }));

vi.mock('@/lib/pdf/core/render', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/pdf/core/render')>();
  return {
    ...real,
    openRender: async (): Promise<PdfSession> => {
      const numPages = session.pages;
      return {
        numPages,
        page: async () => ({ getViewport: () => ({ width: 595, height: 842, rotation: 0 }) }),
        renderPage: async (n: number, scale: number): Promise<PageRender> => ({
          canvas: {} as HTMLCanvasElement,
          ctx: {} as CanvasRenderingContext2D,
          width: Math.round(595 * scale),
          height: Math.round(842 * scale),
          unitsPerPixel: 1 / scale,
          pageNumber: n,
          cancel: () => {},
        }),
        textItems: async () => [],
        textContent: async () => ({ items: [] }),
        metadata: async () => ({ numPages, fingerprint: 'pages-out-session', formFields: 0 }),
        attachments: async () => ({}),
        destroy: async () => {},
      } as unknown as PdfSession;
    },
    canvasToBlob: async (_canvas: unknown, format: string) => doubles.blob(format),
  };
});

// `convert-from` reaches for the encoder in `core/raster` directly, while
// `optimize` takes it from `core/render`; both names answer with the same bytes.
vi.mock('@/lib/pdf/core/raster', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/pdf/core/raster')>();
  return {
    ...real,
    canvasToBlob: async (_canvas: unknown, format: string) => doubles.blob(format),
  };
});

/**
 * The CoherentPDF double. It returns a **finished file it wrote elsewhere** and
 * no document, which is exactly the shape that keeps a page count out of reach —
 * so the test can assert the app says "not counted" rather than inventing one.
 */
const engine = vi.hoisted(() => ({
  linearize: null as Uint8Array | null,
}));

vi.mock('@/lib/pdf/core/engine-ops', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/pdf/core/engine-ops')>();
  return {
    ...real,
    linearizeWithCpdf: async () => {
      if (!engine.linearize) throw new Error('test double: no CoherentPDF output configured');
      return engine.linearize;
    },
  };
});

beforeEach(() => {
  session.pages = 1;
  engine.linearize = null;
});

/* ── fixtures ─────────────────────────────────────────────────────────────── */

/** A real PDF with drawn text on every page. */
async function textPdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pages; index++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Page ${index + 1} of the counted fixture`, {
      x: 60,
      y: 700,
      size: 16,
      font,
      color: rgb(0, 0, 0),
    });
  }
  doc.setTitle('Counted fixture');
  doc.setAuthor('pages-out');
  return doc.save({ useObjectStreams: false });
}

function pdfFile(bytes: Uint8Array, name: string): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });
}

async function run(toolId: string, values: ToolValues = {}, files?: File[]): Promise<RunOutcome> {
  return runPdfTool({
    toolId,
    files: files ?? [pdfFile(await textPdf(3), 'fixture.pdf')],
    values,
    onProgress: () => {},
    onLog: () => {},
  });
}

/** Call a tool's `run` with the file list the tool itself accepts, bypassing the
 * runner's one-file gate (the legacy scan pane queues many captures). */
async function directRun(toolId: string, values: ToolValues, files: File[]): Promise<ToolResult> {
  const tool = getPdfTool(toolId);
  expect(tool, `${toolId} is not registered`).toBeTruthy();
  const inputs: ToolFile[] = files.map((file) => ({
    name: file.name,
    size: file.size,
    type: file.type,
    bytes: async () => new Uint8Array(await file.arrayBuffer()),
    blob: () => file.slice(0, file.size, file.type || 'application/octet-stream'),
  }));
  const result = await tool!.run!({
    inputs,
    values: { ...defaultValues(tool!.fields), ...values },
    progress: () => {},
    log: () => {},
    signal: new AbortController().signal,
  });
  expect(result, `${toolId} produced no result`).toBeTruthy();
  return result!;
}

/**
 * The truth about an output: its own page tree, read back with pdf-lib.
 *
 * This is a full parse of the finished bytes — the thing a *producer* must not do
 * for one integer, and the thing a test can afford.
 */
async function realPageCount(blob: Blob): Promise<number> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc.getPageCount();
}

/* ── every family that holds a document counts what it wrote ──────────────── */

describe('the count a producer already holds', () => {
  it('security: metadata removal reports the document it saved', async () => {
    const outcome = await run('remove-metadata', {}, [pdfFile(await textPdf(6), 'notes.pdf')]);
    expect(outcome.outputs).toHaveLength(1);
    expect(outcome.pagesOut).toBe(6);
    expect(outcome.pagesOut).toBe(await realPageCount(outcome.outputs[0].blob));
  });

  it('optimize: rasterising builds a new document and counts it, not the input', async () => {
    session.pages = 3;
    const outcome = await run('rasterize-pdf', { dpi: 96, format: 'png' });
    expect(outcome.pagesOut).toBe(3);
    expect(outcome.pagesOut).toBe(await realPageCount(outcome.outputs[0].blob));
  });

  it('edit: an 8-page selection of a 20-page document reports 8', async () => {
    session.pages = 20;
    const outcome = await run(
      'invert-colors',
      { pages: '1-8', dpi: 96 },
      [pdfFile(await textPdf(20), 'long.pdf')],
    );
    expect(outcome.pagesOut).toBe(8);
    expect(outcome.pagesOut).not.toBe(20);
    expect(outcome.pagesOut).toBe(await realPageCount(outcome.outputs[0].blob));
  });

  it('convert-to: a typeset document reports the pages the layout made', async () => {
    const body = Array.from({ length: 120 }, (_, i) => `Line ${i + 1} of the manuscript, long enough to run over a page edge and force a second sheet.`).join('\n\n');
    const file = new File([body], 'manuscript.txt', { type: 'text/plain' });
    const outcome = await run('txt-to-pdf', {}, [file]);
    const produced = await realPageCount(outcome.outputs[0].blob);
    expect(produced).toBeGreaterThan(1);
    expect(outcome.pagesOut).toBe(produced);
    // The card says `N → M` only because the producer counted M.
    expect(describePages(null, outcome.pagesOut)).toBe(String(produced));
  });

  it('convert-from: greyscale by recolouring keeps and counts every page', async () => {
    const outcome = await run('pdf-to-greyscale', { mode: 'vectors', pages: 'all' }, [
      pdfFile(await textPdf(5), 'colour.pdf'),
    ]);
    expect(outcome.pagesOut).toBe(5);
    expect(outcome.pagesOut).toBe(await realPageCount(outcome.outputs[0].blob));
  });

  it('legacy: a scan of three captures reports three pages', async () => {
    const captures = [1, 2, 3].map(
      (n) => new File([doubles.jpeg], `page-0${n}.jpg`, { type: 'image/jpeg' }),
    );
    const result = await directRun('scan-to-pdf', {}, captures);
    expect(result.kind).toBe('pdf');
    expect(result.pages).toBe(3);
    const bytes = new Uint8Array((result as { bytes: Uint8Array }).bytes);
    expect(await realPageCount(new Blob([bytes as BlobPart], { type: 'application/pdf' }))).toBe(3);
  });
});

/* ── which file a count describes ────────────────────────────────────────── */

describe('the primary output of a multi-file run', () => {
  it('reports the first produced document, never a sum of both', async () => {
    const files = [pdfFile(await textPdf(3), 'a.pdf'), pdfFile(await textPdf(5), 'b.pdf')];
    const outcome = await run('bates-numbering', { format: '{n}', digits: 3, start: 1 }, files);
    expect(outcome.outputs).toHaveLength(2);
    expect(outcome.outputs.map((output) => output.name)).toEqual(['a_bates.pdf', 'b_bates.pdf']);
    expect(outcome.pagesOut).toBe(3);
    expect(outcome.pagesOut).toBe(await realPageCount(outcome.outputs[0].blob));
  });
});

/* ── what must stay uncounted ────────────────────────────────────────────── */

describe('a result that is not a PDF', () => {
  it('claims no page count for a zip of images', async () => {
    session.pages = 3;
    const outcome = await run('pdf-to-image', { format: 'jpeg', dpi: 96, pages: 'all' }, [
      pdfFile(await textPdf(3), 'scan.pdf'),
    ]);
    expect(outcome.outputs).toHaveLength(1);
    expect(outcome.outputs[0].name).toMatch(/\.zip$/);
    expect(outcome.pagesOut).toBeNull();
  });

  it('claims no page count for a single exported image', async () => {
    session.pages = 1;
    const outcome = await run('pdf-to-image', { format: 'png', dpi: 96, pages: '1' }, [
      pdfFile(await textPdf(1), 'one.pdf'),
    ]);
    expect(outcome.outputs[0].name).toMatch(/\.png$/);
    expect(outcome.pagesOut).toBeNull();
    expect(describePages(1, outcome.pagesOut)).toBe('1 in · out not counted');
  });
});

describe('an engine-produced PDF nobody could count', () => {
  it('still prints the honest wording instead of a number it did not read', async () => {
    // CoherentPDF wrote this file; the run holds its bytes and no document, and
    // a cheap inspection of those bytes cannot answer "how many pages" (guard.ts
    // says so). Inventing one here would be the lie this pass exists to remove.
    const written = await textPdf(4);
    engine.linearize = written;
    session.pages = 4;
    const outcome = await run('linearize-pdf', {}, [pdfFile(await textPdf(4), 'read-me.pdf')]);
    expect(outcome.message).toMatch(/CoherentPDF/);
    expect(outcome.outputs).toHaveLength(1);
    expect(outcome.pagesOut).toBeNull();
    expect(describePages(4, outcome.pagesOut)).toBe('4 in · out not counted');
    expect(describePages(4, outcome.pagesOut)).not.toMatch(/→/);
  });

  it('counts the pages a core helper rebuilt from rasterised pages', async () => {
    // `applyColorFilter` builds a new document inside `core/measure` and returns
    // only bytes, so the count comes from the selection it was told to render.
    // The assertion parses the produced file: it must be the same number, not a
    // second copy of the same guess.
    session.pages = 6;
    const outcome = await run('pdf-to-greyscale', { mode: 'raster', pages: '2-4' }, [
      pdfFile(await textPdf(6), 'scan.pdf'),
    ]);
    expect(outcome.pagesOut).toBe(3);
    expect(await realPageCount(outcome.outputs[0].blob)).toBe(3);
    expect(describePages(6, outcome.pagesOut)).toBe('6 → 3');
  });
});

describe('a repaired file', () => {
  it('counts what it just proved opens, instead of contradicting its own message', async () => {
    // The tool's message says "N page(s) readable" from a full inspection of the
    // bytes it wrote, so the result screen had no business printing
    // "out not counted" underneath it.
    const outcome = await run('repair', {}, [pdfFile(await textPdf(3), 'ragged.pdf')]);
    expect(outcome.message).toMatch(/3 page\(s\) readable/);
    expect(outcome.pagesOut).toBe(3);
    expect(await realPageCount(outcome.outputs[0].blob)).toBe(3);
    expect(describePages(3, outcome.pagesOut)).toBe('3 → 3');
  });
});

describe('a compressed file', () => {
  it('reports the pages of the document it rebuilt, cross-checked against the bytes', async () => {
    // `core/compress` used to hand back `{ bytes, report }` and nothing else, so
    // the flagship tool printed "out not counted". It now reads the count while
    // the document is open, including when the rebuild loses to the original on
    // size and the untouched input is returned instead.
    const outcome = await run('pdf-compress', { preset: 'balanced' }, [
      pdfFile(await textPdf(5), 'tight.pdf'),
    ]);
    expect(outcome.outputs).toHaveLength(1);
    expect(outcome.pagesOut).toBe(5);
    expect(await realPageCount(outcome.outputs[0].blob)).toBe(5);
    expect(describePages(5, outcome.pagesOut)).toBe('5 → 5');
  });

  it('still counts pages when the rebuild was discarded for being larger', async () => {
    // E14: a file that cannot be shrunk comes back unchanged and must still say
    // how many pages came out — "not counted" was never true of this path.
    const dense = await textPdf(2);
    const outcome = await run('pdf-compress', { preset: 'extreme' }, [pdfFile(dense, 'tiny.pdf')]);
    expect(outcome.pagesOut).toBe(2);
    expect(await realPageCount(outcome.outputs[0].blob)).toBe(2);
  });
});
