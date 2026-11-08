/**
 * Edge cases for the Optimize & legacy category.
 *
 * This is where a fake success hurts most: the user pressed "Compress", got a
 * download, and the file is the same size — or the "linearized" PDF is not
 * linearized, or the "PDF/A" archive fails validation a year later. Every test
 * here therefore reads the bytes that came back and checks them against the
 * sentence the tool printed, rather than trusting the sentence.
 *
 * Matrix rows covered: E1 (0-byte), E2 (mislabelled file), E3 (truncated,
 * including the repair tool that exists for it), E6 (page numbers outside the
 * document), E9 (rotation values stay legal), E10 (pages with and without a text
 * layer), E12 (no base64 detour), E13 (nothing to do), E14 (output larger than
 * input), E15 (dpi/quality/angle out of range, clamped *and* announced),
 * E16 (a page listed twice), E20 (Ghostscript / CoherentPDF unreachable).
 *
 * jsdom has no canvas, so the two tools that render pages drive a stubbed
 * pdf.js session; the assertions are about the file each one writes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, StandardFonts, degrees, rgb } from '@maxwbh/pdf-lib';
import type { PageRender, PdfSession } from '@/lib/pdf/core/render';
import { describeSize, inspectPdf, isToolInputError } from '@/lib/pdf/core/guard';
import { openPDF, PDFName, PDFDict, PDFRawStream, PDFRef, PDFStream } from '@/lib/pdf/core/doc';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { fileProblem, runPdfTool } from '@/lib/pdf/tools/runner';
import { defaultValues, type ToolFile, type ToolResult, type ToolValues } from '@/lib/pdf/tools/types';
import { isLinearized, srgbIccProfile } from '@/lib/pdf/tools/optimize';

/** ── engine doubles ─────────────────────────────────────────────────────── */

/**
 * The CDN engines cannot be fetched from a test, and "engine unreachable" is
 * itself one of the rows under test, so `core/engine-ops` is replaced with a
 * switchboard: each call can succeed with given bytes, or fail with a reason.
 */
const engine = vi.hoisted(() => ({
  ready: true,
  failure: null as string | null,
  linearize: null as ((bytes: Uint8Array) => Uint8Array) | null,
  pdfa: null as ((bytes: Uint8Array, part: string) => Uint8Array) | null,
  pdfaLog: [] as string[],
  /** Every PDF/A level the tools asked Ghostscript for, in call order. */
  pdfaParts: [] as string[],
  outline: null as ((bytes: Uint8Array) => Uint8Array) | null,
  rebuild: null as ((bytes: Uint8Array) => Uint8Array) | null,
}));

vi.mock('@/lib/pdf/core/engine-ops', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/pdf/core/engine-ops')>();
  const guard = (what: string): void => {
    if (engine.failure) throw new Error(`${what}: ${engine.failure}`);
  };
  return {
    ...real,
    engineReady: () => engine.ready,
    linearizeWithCpdf: async (bytes: Uint8Array) => {
      guard('could not load CoherentPDF');
      if (!engine.linearize) throw new Error('test double: CoherentPDF result not configured');
      return engine.linearize(bytes);
    },
    convertToPdfA: async (bytes: Uint8Array, part: string) => {
      guard('could not load Ghostscript');
      if (!engine.pdfa) throw new Error('test double: Ghostscript result not configured');
      // The part is forwarded: a double that dropped it could not tell the test
      // which PDF/A level the tool actually asked Ghostscript for.
      engine.pdfaParts.push(part);
      return { bytes: engine.pdfa(bytes, part), log: engine.pdfaLog };
    },
    textToOutlines: async (bytes: Uint8Array) => {
      guard('could not load Ghostscript');
      if (!engine.outline) throw new Error('test double: Ghostscript result not configured');
      return { bytes: engine.outline(bytes), log: [] as string[] };
    },
    rebuildWithGhostscript: async (bytes: Uint8Array) => {
      guard('could not load Ghostscript');
      if (!engine.rebuild) throw new Error('test double: Ghostscript result not configured');
      return { bytes: engine.rebuild(bytes), log: [] as string[] };
    },
  };
});

/** Tilt each test wants reported per page, in degrees, plus its confidence. */
const skew = vi.hoisted(() => ({ angles: [] as { angle: number; confidence: number }[], failures: new Set<number>() }));

vi.mock('@/lib/pdf/core/measure', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/pdf/core/measure')>();
  return {
    ...real,
    detectSkew: async (_session: unknown, page: number) => {
      if (skew.failures.has(page)) throw new Error('this browser cannot rasterise the page');
      const found = skew.angles[page - 1] ?? { angle: 0, confidence: 1 };
      return { angle: found.angle, confidence: found.confidence, direction: found.angle };
    },
  };
});

/** A 1×1 JPEG and PNG, so the rasterised output embeds real image bytes. */
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

/** What each stubbed page renders as, in pixels: `[widthPt, heightPt]` per page. */
const session = vi.hoisted(() => ({
  pages: [] as Array<[number, number]>,
  rendered: 0,
  aborted: false,
}));

vi.mock('@/lib/pdf/core/render', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/pdf/core/render')>();
  return {
    ...real,
    openRender: async (): Promise<PdfSession> => {
      const numPages = session.pages.length;
      return {
        numPages,
        page: async () => ({ getViewport: () => ({ width: 595, height: 842 }) }),
        renderPage: async (n: number, scale: number): Promise<PageRender> => {
          session.rendered += 1;
          const [widthPt, heightPt] = session.pages[n - 1] ?? [595, 842];
          const width = Math.round(widthPt * scale);
          const height = Math.round(heightPt * scale);
          return {
            canvas: {} as HTMLCanvasElement,
            ctx: {} as CanvasRenderingContext2D,
            width,
            height,
            unitsPerPixel: 1 / scale,
            pageNumber: n,
            cancel: () => {},
          };
        },
        textItems: async () => [],
        textContent: async () => ({ items: [] }),
        metadata: async () => ({ numPages, fingerprint: 'stub', formFields: 0 }),
        attachments: async () => ({}),
        destroy: async () => {},
      } as unknown as PdfSession;
    },
    canvasToBlob: async (_canvas: unknown, format: 'jpeg' | 'png') =>
      new Blob([format === 'jpeg' ? TINY_JPEG : TINY_PNG], {
        type: format === 'jpeg' ? 'image/jpeg' : 'image/png',
      }),
  };
});

/** Every double is reset between tests: one leaked flag hid the next result. */
beforeEach(() => {
  engine.ready = true;
  engine.failure = null;
  engine.linearize = null;
  engine.pdfa = null;
  engine.pdfaLog = [];
  engine.pdfaParts = [];
  engine.outline = null;
  engine.rebuild = null;
  skew.angles = [];
  skew.failures = new Set();
  session.pages = [[595, 842]];
  session.rendered = 0;
});

/** ── fixtures ───────────────────────────────────────────────────────────── */

function pdfFile(bytes: Uint8Array, name: string): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });
}

/** A real PDF with drawn text on every page, which is what these tools chew on. */
async function textPdf(pages = 3, options: { objectStreams?: boolean; sizes?: Array<[number, number]> } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const [width, height] = options.sizes?.[i] ?? [595, 842];
    const page = doc.addPage([width, height]);
    page.drawText(`Page ${i + 1} body text for edge tests`, { x: 50, y: height - 90, size: 16, font, color: rgb(0, 0, 0) });
    page.drawText(`Second line on page ${i + 1}`, { x: 50, y: height - 130, size: 11, font });
  }
  doc.setTitle('Edge fixture');
  doc.setAuthor('B2');
  return doc.save({ useObjectStreams: options.objectStreams ?? false });
}

/** A page drawn with paths only: no `Tj`, so no text layer (E10). */
async function imageOnlyPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.drawRectangle({ x: 40, y: 40, width: 300, height: 400, color: rgb(0.4, 0.4, 0.4) });
  const second = doc.addPage([612, 792]);
  second.drawText('this one does have glyphs', { x: 40, y: 700, size: 14, font: await doc.embedFont(StandardFonts.Helvetica) });
  return doc.save({ useObjectStreams: false });
}

/**
 * A PDF stored with **uncompressed** page content, the way a scanner driver
 * writes one, so structure-only work has something real to shrink.
 */
async function rawContentPdf(pages = 3): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Raw page ${i + 1}`, { x: 60, y: 700, size: 18, font, color: rgb(0, 0, 0) });
    const body = `${'% filler filler filler filler filler filler filler\n'.repeat(120)}BT /F1 18 Tf 60 640 Td (RAW PAGE ${i + 1}) Tj ET\n`;
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(body)));
  }
  return doc.save({ useObjectStreams: false });
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * A page whose only picture lives inside a Form XObject with its own resources,
 * built the way an illustration export builds one: the page draws `/Art`, and
 * `/Art` draws `/Im1`. The image is stored unfiltered, which is legal and keeps the
 * fixture free of a compressor.
 */
async function nestedFormPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const px = 16;
  const content = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'latin1'));
  const imageRef = doc.context.register(
    PDFRawStream.of(
      doc.context.obj({
        Type: 'XObject',
        Subtype: 'Image',
        Width: px,
        Height: px,
        BitsPerComponent: 8,
        ColorSpace: 'DeviceRGB',
      }) as PDFDict,
      new Uint8Array(px * px * 3).fill(180),
    ),
  );
  const formRef = doc.context.register(
    PDFRawStream.of(
      doc.context.obj({
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 100, 100],
        Resources: { XObject: { Im1: imageRef } },
      }) as PDFDict,
      content('q 8 0 0 8 0 0 cm /Im1 Do Q'),
    ),
  );
  const resources = page.node.Resources();
  if (!resources) throw new Error('the fixture page has no /Resources to add a form to');
  resources.set(PDFName.of('XObject'), doc.context.obj({ Art: formRef }) as PDFDict);
  page.node.set(
    PDFName.of('Contents'),
    doc.context.register(PDFRawStream.of(doc.context.obj({}), content('q 2 0 0 2 60 60 cm /Art Do Q'))),
  );
  return doc.save({ useObjectStreams: false });
}

async function run(id: string, values: ToolValues = {}, files?: File[]) {
  const outcome = await runPdfTool({
    toolId: id,
    files: files ?? [pdfFile(await textPdf(), 'fixture.pdf')],
    values,
    onProgress: () => {},
    onLog: () => {},
  });
  return { ...outcome, bytes: await bytesOf(outcome.outputs[0].blob) };
}

/** Call a tool's `run` the way the legacy engine hook does: no runner, no clamping. */
async function directRun(id: string, values: ToolValues, files: File[]): Promise<ToolResult> {
  const tool = getPdfTool(id);
  expect(tool, `${id} is not registered`).toBeTruthy();
  const inputs: ToolFile[] = files.map((file) => ({
    name: file.name,
    size: file.size,
    type: file.type,
    bytes: async () => new Uint8Array(await file.arrayBuffer()),
    blob: () => file.slice(0, file.size, file.type || 'application/octet-stream'),
  }));
  return (await tool!.run!({
    inputs,
    values: { ...defaultValues(tool!.fields), ...values },
    progress: () => {},
    log: () => {},
    signal: new AbortController().signal,
  }))!;
}

/**
 * The printed numbers must be the real ones (E14).
 *
 * `X → Y` is checked byte-for-byte, and the sign in front of the percentage must
 * match which of the two is bigger — the defect this pass removes is a message
 * that reads like a saving when the file grew.
 */
function expectMeasuredSizes(text: string, before: number, after: number): void {
  expect(text, `message should name the real input size: ${text}`).toContain(describeSize(before));
  expect(text, `message should name the real output size: ${text}`).toContain(describeSize(after));
  if (after > before) {
    expect(text).toMatch(/\+\d+%/);
    expect(text).not.toMatch(/saved/i);
  }
}

/* ── E1 / E2: nothing reaches the parser ─────────────────────────────────── */

const SINGLE_INPUT_TOOLS = [
  'pdf-compress',
  'optimize-pdf',
  'rasterize-pdf',
  'repair',
  'sanitize-pdf',
  'linearize-pdf',
  'pdf-to-pdfa',
  'font-to-outline',
  'deskew-pdf',
];

describe('optimize tools reject unusable inputs before any work (E1, E2)', () => {
  it('names the empty file, per tool', async () => {
    for (const id of SINGLE_INPUT_TOOLS) {
      await expect(
        runPdfTool({ toolId: id, files: [new File([], 'blank.pdf', { type: 'application/pdf' })], values: {} }),
      ).rejects.toThrow(/blank\.pdf.*empty|empty \(0 bytes\)/is);
    }
  });

  it('names the real format of a mislabelled file, per tool', async () => {
    const jpeg = new File([TINY_JPEG], 'invoice.pdf', { type: 'application/pdf' });
    for (const id of SINGLE_INPUT_TOOLS) {
      let caught: unknown;
      try {
        await runPdfTool({ toolId: id, files: [jpeg], values: {} });
      } catch (error) {
        caught = error;
      }
      const message = caught instanceof Error ? caught.message : '';
      expect(isToolInputError(caught), `${id} must refuse with a typed error`).toBe(true);
      expect(message, `${id} should refuse a JPEG wearing a .pdf name`).toMatch(/not a PDF/i);
      expect(message).toMatch(/JPEG|RENAMING/i);
      expect((caught as { code?: string }).code).toBe('NOT_A_PDF');
    }
  });
});

/* ── pdf-compress ────────────────────────────────────────────────────────── */

describe('pdf-compress reports the sizes it measured', () => {
  it('prints the real before and after when the file shrinks', async () => {
    const source = await textPdf(4);
    const outcome = await run('pdf-compress', { preset: 'balanced' }, [pdfFile(source, 'report.pdf')]);
    expect(outcome.bytes.byteLength).toBeLessThan(source.byteLength);
    expectMeasuredSizes(outcome.message ?? '', source.byteLength, outcome.bytes.byteLength);
    // No images in the fixture: the tool must say so instead of implying it
    // re-encoded something.
    expect(outcome.warnings.join(' ')).toMatch(/no images/i);
    expect(outcome.message).not.toMatch(/NaN|undefined|Infinity/);
    const reopened = await inspectPdf(outcome.bytes, 'out');
    expect(reopened.pages).toBe(4);
  });

  it('counts the picture a Form XObject draws instead of saying there are none', async () => {
    // The gap this closes: artwork inside a form used to make a file look
    // image-free, because only page-level resources were walked.
    const source = await nestedFormPdf();
    const outcome = await run('pdf-compress', { preset: 'balanced' }, [pdfFile(source, 'artwork.pdf')]);
    const joined = outcome.warnings.join(' ');
    expect(joined, `the nested image was not counted: ${outcome.message}`).not.toMatch(/no images/i);
    expect(outcome.message).toContain('0 of 1 image(s) re-encoded, 1 left untouched.');
    // jsdom has no 2-D raster, so the honest sentence is the one about the browser —
    // and it has to talk about the one image the nested walk found.
    expect(joined).toMatch(/cannot re-encode images.*its one image/);
    expect((await openPDF(outcome.bytes)).getPageCount()).toBe(1);
  });

  it('says "nothing to save" rather than "-0%" when the rebuild is not smaller (E14)', async () => {
    // Already object-stream packed and deflated: there is nothing left to take.
    const tight = await textPdf(1, { objectStreams: true });
    const outcome = await run('pdf-compress', { preset: 'lossless' }, [pdfFile(tight, 'tight.pdf')]);
    expect(outcome.bytes.byteLength).toBe(tight.byteLength);
    const text = `${outcome.message} ${outcome.warnings.join(' ')}`;
    expect(text).toMatch(/nothing to save|unchanged|original/i);
    expect(text).not.toMatch(/−0%|-0%/);
    expectMeasuredSizes(outcome.message ?? '', tight.byteLength, outcome.bytes.byteLength);
  });

  it('clamps an out-of-range quality or dpi and says why (E15)', async () => {
    const source = await textPdf(2);
    const result = await directRun(
      'pdf-compress',
      { preset: 'balanced', jpegQuality: 200, maxDpi: 4000, targetEnabled: false },
      [pdfFile(source, 'clamp.pdf')],
    );
    expect(result.kind).toBe('pdf');
    const warnings = result.warnings ?? [];
    expect(warnings.join(' ')).toMatch(/JPEG quality override must be between 0 and 0\.95: 200 became 0\.95\./);
    expect(warnings.join(' ')).toMatch(/Maximum image resolution must be between 0 and 600 dpi: 4000 became 600\./);
  });

  it('states plainly when a size target is missed', async () => {
    // Big enough that even the `extreme` rung of the ladder cannot reach 0.05 MB.
    const source = await rawContentPdf(14);
    const outcome = await run(
      'pdf-compress',
      { targetEnabled: true, targetMB: 0.0001 },
      [pdfFile(source, 'target.pdf')],
    );
    // E15: 0.0001 MB is below the field's minimum, so it is clamped and said.
    expect(outcome.warnings.join(' ')).toMatch(/Target size must be between 0\.05 and 200 MB: 0\.0001 became 0\.05\./);
    expect(outcome.message).toMatch(/Target 0\.05 MB not met/i);
    expect(outcome.warnings.join(' ')).toMatch(/was not reached/i);
  });
});

/* ── optimize-pdf ────────────────────────────────────────────────────────── */

describe('optimize-pdf does only what it can prove it did', () => {
  it('really deflates the uncompressed streams it counted', async () => {
    const source = await rawContentPdf(3);
    const outcome = await run('optimize-pdf', {}, [pdfFile(source, 'raw.pdf')]);
    expect(outcome.bytes.byteLength).toBeLessThan(source.byteLength);
    expectMeasuredSizes(outcome.message ?? '', source.byteLength, outcome.bytes.byteLength);
    expect(outcome.message).toMatch(/3 stream\(s\) gained Flate compression/);
    // The claim has to survive a re-open: pages intact, streams compressed.
    const doc = await openPDF(outcome.bytes, { ignoreEncryption: true });
    expect(doc.getPageCount()).toBe(3);
    const streams = doc.getPage(0).node.get(PDFName.of('Contents'));
    // `PDFStream`, not the `PDFRawStream` subclass: pdf-lib's typed lookups only
    // name the base class, and a compressed stream is a `PDFFlateStream`.
    const stream = doc.context.lookup(streams as PDFRef, PDFStream);
    expect(String(stream.dict.get(PDFName.of('Filter')))).toBe('/FlateDecode');
  });

  it('keeps the original bytes and says so when the rebuild would add size (E14)', async () => {
    // A minimal hand-written PDF: pdf-lib cannot help but add an info
    // dictionary and a longer xref table, so this rebuild is guaranteed larger.
    const tiny = linearizedFixture(1);
    const outcome = await run(
      'optimize-pdf',
      { compressStreams: false, objectStreams: true, dropOrphans: false, stripMetadata: false },
      [pdfFile(tiny, 'tiny.pdf')],
    );
    expect(outcome.bytes.byteLength).toBe(tiny.byteLength);
    expect(outcome.message).toMatch(/already tight/i);
    expect(outcome.message).toMatch(/larger|would give/i);
    expect(outcome.warnings.join(' ')).toMatch(/larger than the input, so the original bytes are returned/i);
    expect(outcome.warnings.join(' ')).not.toMatch(/saved/i);
    expectMeasuredSizes(outcome.message ?? '', tiny.byteLength, outcome.bytes.byteLength);
  });

  it('keeps every page when it drops unreferenced objects (E3 regression)', async () => {
    // Orphan-dropping used to mark only what the catalog named directly, so it
    // deleted the page tree itself and returned a few hundred triumphant bytes
    // with nothing readable inside.
    const source = await rawContentPdf(3);
    const outcome = await run('optimize-pdf', { stripMetadata: true }, [pdfFile(source, 'pages.pdf')]);
    const after = await inspectPdf(outcome.bytes, 'pages.pdf');
    expect(after.error, after.message).toBeNull();
    expect(after.pages).toBe(3);
    const doc = await openPDF(outcome.bytes, { ignoreEncryption: true });
    expect(doc.getPages().map((page) => page.getSize().width)).toEqual([595, 595, 595]);
  });

  it('names the version mismatch when it packs a 1.4 file into object streams', async () => {
    const old = linearizedFixture(1, '1.4');
    const outcome = await run(
      'optimize-pdf',
      { compressStreams: false, dropOrphans: false, objectStreams: true, stripMetadata: false },
      [pdfFile(old, 'old.pdf')],
    );
    expect(outcome.warnings.join(' ')).toMatch(/declares PDF 1\.4, but object streams need 1\.5/);
  });

  it('returns the input untouched and warns when nothing was selected (E13)', async () => {
    const source = await textPdf(2);
    const outcome = await run(
      'optimize-pdf',
      { compressStreams: false, objectStreams: false, dropOrphans: false, stripMetadata: false },
      [pdfFile(source, 'noop.pdf')],
    );
    expect(outcome.bytes.byteLength).toBe(source.byteLength);
    expect(outcome.warnings.join(' ')).toMatch(/nothing was changed/i);
  });

  it('clears the XMP packet as well as the info dictionary when asked', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([595, 842]).drawText('metadata carrier', { x: 60, y: 700 });
    doc.setTitle('keep me? no');
    const withXmp = await doc.save({ useObjectStreams: false });
    const outcome = await run('optimize-pdf', { stripMetadata: true }, [pdfFile(withXmp, 'meta.pdf')]);
    const after = await openPDF(outcome.bytes, { ignoreEncryption: true });
    expect(after.catalog.get(PDFName.of('Metadata'))).toBeUndefined();
    expect(after.getTitle() ?? '').toBe('');
  });
});

/* ── rasterize-pdf ───────────────────────────────────────────────────────── */

describe('rasterize-pdf keeps the geometry it promises (E9, E10, E12, E15)', () => {
  it('draws each page at the original page size by default', async () => {
    const source = await textPdf(2, { sizes: [[595, 842], [400, 300]] });
    session.pages = [[595, 842], [400, 300]];
    const outcome = await run('rasterize-pdf', { dpi: 150, format: 'png' }, [pdfFile(source, 'pages.pdf')]);
    const doc = await openPDF(outcome.bytes, { ignoreEncryption: true });
    expect(doc.getPageCount()).toBe(2);
    // The bug this fixes: "keep the original page size" was wired the wrong way
    // round, so the default produced a 23-inch page holding a postage stamp.
    expect(doc.getPage(0).getSize()).toEqual({ width: 595, height: 842 });
    expect(doc.getPage(1).getSize()).toEqual({ width: 400, height: 300 });
    expect(doc.getPage(0).getRotation().angle).toBe(0);
    expect(outcome.message).toMatch(/Rasterised 2 page\(s\) to PNG at 150 dpi/i);
    expectMeasuredSizes(outcome.message ?? '', source.byteLength, outcome.bytes.byteLength);
  });

  it('honours a rotated page and the pixel-size mode when asked', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    page.setRotation(degrees(90));
    page.drawText('rotated scan', { x: 60, y: 700 });
    const source = await doc.save({ useObjectStreams: false });
    // A 90° page renders as its displayed size, not its stored box.
    session.pages = [[842, 595]];
    const kept = await run('rasterize-pdf', { dpi: 72, format: 'png', keepPageSize: true }, [pdfFile(source, 'rot.pdf')]);
    const keptDoc = await openPDF(kept.bytes, { ignoreEncryption: true });
    expect(keptDoc.getPage(0).getSize()).toEqual({ width: 842, height: 595 });

    session.pages = [[842, 595]];
    const pixels = await run('rasterize-pdf', { dpi: 144, format: 'png', keepPageSize: false }, [pdfFile(source, 'rot.pdf')]);
    const pixelDoc = await openPDF(pixels.bytes, { ignoreEncryption: true });
    expect(pixelDoc.getPage(0).getSize()).toEqual({ width: 1684, height: 1190 });
    expect(pixels.warnings.join(' ')).toMatch(/one point per pixel|595 pt page becomes 1190 pt/i);
  });

  it('tells a scanned document from one with text (E10)', async () => {
    const mixed = await imageOnlyPdf();
    session.pages = [[612, 792], [612, 792]];
    const outcome = await run('rasterize-pdf', { dpi: 96, format: 'png' }, [pdfFile(mixed, 'mixed.pdf')]);
    expect(outcome.warnings.join(' ')).toMatch(/1 of 2 page\(s\) carried text/i);

    const scanned = await imageOnlyPdf();
    const single = await PDFDocument.create();
    single.addPage([612, 792]).drawRectangle({ x: 10, y: 10, width: 100, height: 100 });
    session.pages = [[612, 792]];
    const flat = await run('rasterize-pdf', { dpi: 96, format: 'png' }, [pdfFile(await single.save(), 'scan.pdf')]);
    expect(flat.warnings.join(' ')).toMatch(/no page carried a text layer/i);
    void scanned;
  });

  it('refuses a dpi outside the slider and announces the correction (E15)', async () => {
    const source = await textPdf(1);
    session.pages = [[595, 842]];
    const result = await directRun('rasterize-pdf', { dpi: 0, format: 'png', quality: 3 }, [pdfFile(source, 'dpi.pdf')]);
    const warnings = (result.warnings ?? []).join(' ');
    expect(warnings).toMatch(/Resolution must be between 72 and 600 dpi: 0 became 72\./);
    expect(warnings).toMatch(/JPEG quality must be between 0\.3 and 1: 3 became 1\./);
    expect(result.kind).toBe('pdf');
  });

  it('renders every page once, through the real render path (E7, E12)', async () => {
    const source = await textPdf(3);
    session.pages = [[595, 842], [595, 842], [595, 842]];
    session.rendered = 0;
    await run('rasterize-pdf', { dpi: 72, format: 'png' }, [pdfFile(source, 'three.pdf')]);
    expect(session.rendered).toBe(3);
    expect(new TextDecoder('latin1').decode(source).length).toBe(source.byteLength);
  });
});

/* ── repair ──────────────────────────────────────────────────────────────── */

describe('repair opens the files the normal gate refuses (E3)', () => {
  it('recovers the pages that survived a truncation', async () => {
    const full = await rawContentPdf(3);
    const cut = full.subarray(0, Math.floor(full.byteLength * 0.7));
    // The premise: the shared guard will not open this file at all.
    expect((await inspectPdf(cut, 'cut.pdf')).error).toBe('CORRUPT');
    const outcome = await run('repair', {}, [pdfFile(cut, 'cut.pdf')]);
    const after = await inspectPdf(outcome.bytes, 'repaired.pdf');
    expect(after.error).toBeNull();
    expect(after.pages).toBeGreaterThan(0);
    expect(after.pages).toBeLessThan(3);
    expect(outcome.message).toMatch(new RegExp(`${after.pages} page\\(s\\) readable`));
    expect(outcome.warnings.join(' ')).toMatch(/would not open/i);
  });

  it('re-writes a file that already opens, and admits that is all it did', async () => {
    const source = await textPdf(2);
    const outcome = await run('repair', {}, [pdfFile(source, 'fine.pdf')]);
    const after = await inspectPdf(outcome.bytes, 'fine.pdf');
    expect(after.pages).toBe(2);
    expect(outcome.warnings.join(' ')).toMatch(/already opened/i);
  });

  it('refuses a file with nothing recoverable in it, naming the file', async () => {
    const junk = new Uint8Array(Buffer.from('%PDF-1.7\n\u0000\u0001\u0002 total nonsense \u00ff\n', 'latin1'));
    let caught: unknown;
    try {
      await runPdfTool({ toolId: 'repair', files: [pdfFile(junk, 'junk.pdf')], values: {} });
    } catch (error) {
      caught = error;
    }
    expect(isToolInputError(caught)).toBe(true);
    const described = caught as { code: string; message: string; hint?: string };
    expect(described.code).toBe('CORRUPT');
    expect(described.message).toContain('junk.pdf');
    expect(described.message).not.toMatch(/at .*\(.*:\d+:\d+\)/);
    expect(described.hint).toMatch(/download|truncat/i);
  });

  it('asks Ghostscript only when the local parser gave up (E20)', async () => {
    const junk = new Uint8Array(Buffer.from('%PDF-1.7\n\u0000\u0001\u0002 nonsense \u00ff\n', 'latin1'));
    engine.rebuild = () => {
      throw new Error('gs exited 1');
    };
    await expect(runPdfTool({ toolId: 'repair', files: [pdfFile(junk, 'broken.pdf')], values: {} }))
      .rejects.toThrow(/Ghostscript said: gs exited 1/);

    // The engine could not be fetched: the refusal must say what to do next.
    engine.rebuild = null;
    engine.ready = false;
    const result = await directRun('repair', {}, [pdfFile(junk, 'broken.pdf')]).catch((error) => error);
    engine.ready = true;
    expect(isToolInputError(result)).toBe(true);
    const caught = result as { code: string; hint?: string };
    expect(caught.code).toBe('CORRUPT');
    // The engine is fetched, not enabled: the hint points at the network and a
    // repeat run, because there is no settings screen to send anyone to.
    expect(caught.hint).toMatch(/download it again|while online/i);
  });
});

/* ── sanitize-pdf ────────────────────────────────────────────────────────── */

describe('sanitize-pdf counts what it removed and no more', () => {
  it('strips scripts, attachments, XMP, info and annotations, and proves it', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    page.drawText('a page with optional parts', { x: 60, y: 700 });
    const context = doc.context;
    const js = context.register(context.obj({ Type: 'Action', S: 'JavaScript', JS: context.obj('app.alert(1)') }));
    page.node.set(PDFName.of('Annots'), context.obj([
      context.register(context.obj({ Type: 'Annot', Subtype: 'Widget', Rect: [0, 0, 40, 20], Parent: js, A: js })),
    ]));
    doc.catalog.set(PDFName.of('AcroForm'), context.obj({ Fields: context.obj([js]), NeedAppearances: context.obj(true) }));
    doc.catalog.set(PDFName.of('Names'), context.obj({ JavaScript: context.obj({ Names: context.obj([]) }) }));
    doc.catalog.set(
      PDFName.of('Metadata'),
      context.register(context.flateStream('<?xpacket begin=""?><x:xmpmeta/>', { Type: 'Metadata', Subtype: 'XML' })),
    );
    doc.setTitle('sanitizer fixture');
    const source = await doc.save({ useObjectStreams: false });

    const outcome = await run(
      'sanitize-pdf',
      { javascript: true, attachments: true, metadata: true, info: true, annotations: true },
      [pdfFile(source, 'busy.pdf')],
    );
    const after = await openPDF(outcome.bytes, { ignoreEncryption: true });
    expect(after.catalog.get(PDFName.of('Metadata'))).toBeUndefined();
    expect(after.catalog.get(PDFName.of('AcroForm'))).toBeUndefined();
    expect(after.getPageCount()).toBe(1);
    expect(outcome.message).toMatch(/script reference\(s\) removed/);
    expect(outcome.message).toMatch(/1 annotation\(s\) including 1 form field\(s\) removed/);
    expect(outcome.message).toMatch(/XMP metadata removed/);
    expect(outcome.warnings.join(' ')).toMatch(/form field value\(s\) were removed/i);
    expectMeasuredSizes(outcome.message ?? '', source.byteLength, outcome.bytes.byteLength);
  });

  it('says "nothing to remove" for a clean file instead of implying work (E13)', async () => {
    const source = await textPdf(2);
    const outcome = await run(
      'sanitize-pdf',
      { javascript: true, attachments: true, metadata: true, info: false, annotations: true },
      [pdfFile(source, 'clean.pdf')],
    );
    expect(outcome.message).toMatch(/nothing to remove/i);
    expect(outcome.message).toMatch(/no script references were present/);
    expect(outcome.message).toMatch(/there was no XMP packet to remove/);
    expect(outcome.warnings.join(' ')).not.toMatch(/survived in a place/i);
  });

  it('no longer claims an engine it never calls', async () => {
    expect(getPdfTool('sanitize-pdf')?.engines ?? []).toEqual([]);
    expect((getPdfTool('sanitize-pdf')?.notes ?? []).join(' ')).toMatch(/does not redact/i);
  });
});

/* ── linearize-pdf ───────────────────────────────────────────────────────── */

/** A hand-built PDF whose first object declares `/Linearized`. */
function linearizedFixture(pageCount = 1, version = '1.5'): Uint8Array {
  const objects = [
    '<< /Linearized 1 /L 700 /O 3 /H [ 15 5 ] /T 600 >>',
    '<< /Type /Catalog /Pages 3 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, i) => `${4 + i} 0 R`).join(' ')}] /Count ${pageCount} >>`,
  ];
  for (let i = 0; i < pageCount; i++) {
    objects.push('<< /Type /Page /Parent 3 0 R /MediaBox [0 0 595 842] >>');
  }
  let body = `%PDF-${version}\n%\xE2\xE3\xCF\xD3\n`;
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const start = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 2 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body, 'latin1'));
}

describe('linearize-pdf says which kind of file it produced (E20)', () => {
  it('reports a conforming result from the engine', async () => {
    const source = await textPdf(2);
    engine.linearize = () => linearizedFixture(2);
    const outcome = await run('linearize-pdf', {}, [pdfFile(source, 'lin.pdf')]);
    expect(isLinearized(outcome.bytes)).toBe(true);
    expect(outcome.message).toMatch(/Linearized with CoherentPDF/);
    expect(outcome.warnings).toEqual([]);
    expectMeasuredSizes(outcome.message ?? '', source.byteLength, outcome.bytes.byteLength);
    engine.linearize = null;
  });

  it('does not call a result linearized when the dictionary is missing', async () => {
    const source = await textPdf(2);
    engine.linearize = (bytes) => bytes;
    const outcome = await run('linearize-pdf', {}, [pdfFile(source, 'lin.pdf')]);
    expect(isLinearized(outcome.bytes)).toBe(false);
    expect(outcome.message).toMatch(/but not linearized/i);
    expect(outcome.warnings.join(' ')).toMatch(/without a \/Linearized dictionary/i);
    engine.linearize = null;
  });

  it('degrades to a local rebuild, loudly, when the engine cannot be reached', async () => {
    const source = await textPdf(2);
    engine.failure = 'Failed to load CoherentPDF from https://cdn.invalid/ (HTTP 404)';
    const outcome = await run('linearize-pdf', {}, [pdfFile(source, 'offline.pdf')]);
    expect(outcome.warnings.join(' ')).toMatch(/CoherentPDF could not be reached/i);
    expect(outcome.message).toMatch(/is not a conforming linearized PDF/i);
    const after = await inspectPdf(outcome.bytes, 'offline.pdf');
    expect(after.pages).toBe(2);
    expectMeasuredSizes(outcome.message ?? '', source.byteLength, outcome.bytes.byteLength);
    engine.failure = null;
  });

  it('names the engine it could not fetch, and still delivers a file', async () => {
    const source = await textPdf(1);
    // There is no engine setting left to leave off: a tool that declares an
    // engine always tries it, through the runner or straight from a caller.
    engine.failure = 'no address answered';
    const result = (await directRun('linearize-pdf', {}, [pdfFile(source, 'noengine.pdf')]))!;
    expect((result.warnings ?? []).join(' ')).toMatch(/CoherentPDF could not be reach.*no address answered/i);
    expect(result.message).toMatch(/not a conforming linearized PDF/i);
    const outcome = await runPdfTool({
      toolId: 'linearize-pdf',
      files: [pdfFile(source, 'noengine.pdf')],
      values: {},
    });
    expect(outcome.outputs).toHaveLength(1);
    expect(outcome.warnings.join(' ')).toMatch(/CoherentPDF could not be reach/i);
    expect(`${outcome.message} ${outcome.warnings.join(' ')}`).not.toMatch(/settings|enable/i);
    engine.failure = null;
  });
});

/* ── pdf-to-pdfa ─────────────────────────────────────────────────────────── */

describe('pdf-to-pdfa states what it actually did', () => {
  it('writes an identification an archive tool can read, and admits what is missing', async () => {
    const source = await textPdf(2);
    engine.failure = 'Failed to load Ghostscript from https://cdn.invalid/ (offline)';
    const outcome = await run('pdf-to-pdfa', { part: '2b' }, [pdfFile(source, 'archive.pdf')]);
    engine.failure = null;

    const doc = await openPDF(outcome.bytes, { ignoreEncryption: true });
    const metadata = doc.catalog.get(PDFName.of('Metadata'));
    const stream = doc.context.lookup(metadata as PDFRef, PDFStream);
    // The /Length must match the stored bytes, or every reader disagrees with it.
    const declaredLength = Number(String(stream.dict.get(PDFName.of('Length'))));
    expect(declaredLength).toBe(stream.getContents().byteLength);
    const xml = Buffer.from(
      (await import('@/lib/pdf/core/content')).streamBytes(stream),
    ).toString('latin1');
    expect(xml).toMatch(/pdfaid:part="2"/);
    expect(xml).toMatch(/pdfaid:conformance="B"/);

    const intents = doc.catalog.get(PDFName.of('OutputIntents'));
    const array = doc.context.lookup(intents as PDFRef, (await import('@/lib/pdf/core/doc')).PDFArray);
    const intentRef = array.get(0) as PDFRef;
    const intent = doc.context.lookup(intentRef, PDFDict);
    expect(String(intent.get(PDFName.of('S')))).toBe('/GTS_PDFA1');
    const profileRef = intent.get(PDFName.of('DestOutputProfile')) as PDFRef;
    const profile = doc.context.lookup(profileRef, PDFStream);
    const icc = Buffer.from((await import('@/lib/pdf/core/content')).streamBytes(profile));
    expect(icc.readUInt32BE(0)).toBe(icc.byteLength);
    expect(icc.toString('latin1', 12, 16)).toBe('mntr');
    expect(icc.toString('latin1', 36, 40)).toBe('acsp');
    expect(icc.readUInt32BE(128)).toBeGreaterThan(0);

    expect(outcome.warnings.join(' ')).toMatch(/Ghostscript could not be reached/i);
    expect(outcome.warnings.join(' ')).toMatch(/No conformance check was run/i);
    expect(outcome.message).toMatch(/pdfaid:part=2, conformance=B/);
    expectMeasuredSizes(outcome.message ?? '', source.byteLength, outcome.bytes.byteLength);
  });

  it('reports the fonts it could not embed (E11-adjacent honesty)', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    page.drawText('Helvetica without an embedded face', { x: 40, y: 700, size: 12 });
    doc.context.trailerInfo.Info = undefined as never;
    const source = await doc.save({ useObjectStreams: false });
    engine.failure = 'offline';
    const outcome = await run('pdf-to-pdfa', { part: '1b' }, [pdfFile(source, 'plain.pdf')]);
    engine.failure = null;
    const text = `${outcome.message} ${outcome.warnings.join(' ')}`;
    expect(text).toMatch(/font|font\(s\)/i);
    expect(outcome.warnings.join(' ')).toMatch(/not embedded|will reject/i);
  });

  it('passes Ghostscript’s own warnings through as warnings, not prose', async () => {
    const source = await textPdf(2);
    engine.pdfa = (bytes) => bytes;
    engine.pdfaLog = ['cannot convert colour space', 'font subsystem degraded'];
    const outcome = await run('pdf-to-pdfa', { part: '3b' }, [pdfFile(source, 'gs.pdf')]);
    engine.pdfaLog = [];
    engine.pdfa = null;
    // The level the user picked has to be the level Ghostscript was asked for;
    // a warning sentence alone would also print when the tool asked for 2b.
    expect(engine.pdfaParts, 'the selected PDF/A level reached the engine').toEqual(['3b']);
    expect(outcome.warnings).toContain('Ghostscript: cannot convert colour space');
    expect(outcome.warnings).toContain('Ghostscript: font subsystem degraded');
    expect(outcome.message).toMatch(/2 conformance warning\(s\) reported/);
    expect(outcome.message).toMatch(/0 of \d+ font\(s\) embedded|embedded/);
  });

  it('keeps its own sRGB profile structurally readable', () => {
    const icc = srgbIccProfile();
    expect(new DataView(icc.buffer).getUint32(0)).toBe(icc.byteLength);
    const view = new DataView(icc.buffer);
    const count = view.getUint32(128);
    const signatures: string[] = [];
    for (let i = 0; i < count; i++) {
      const entry = 132 + i * 12;
      signatures.push(String.fromCharCode(view.getUint8(entry), view.getUint8(entry + 1), view.getUint8(entry + 2), view.getUint8(entry + 3)));
      const offset = view.getUint32(entry + 4);
      const size = view.getUint32(entry + 8);
      expect(offset + size, `${signatures[i]} must fit inside the profile`).toBeLessThanOrEqual(icc.byteLength);
    }
    for (const required of ['desc', 'wtpt', 'rXYZ', 'gXYZ', 'bXYZ', 'rTRC', 'gTRC', 'bTRC']) {
      expect(signatures, `ICC profile is missing the ${required} tag`).toContain(required);
    }
  });
});

/* ── font-to-outline ─────────────────────────────────────────────────────── */

describe('font-to-outline refuses instead of faking (E20)', () => {
  it('the runner surfaces the tool’s refusal instead of an empty outline', async () => {
    const source = await textPdf(1);
    // The runner no longer gates on a setting: the run starts, the engine is
    // fetched, and the failure comes back as the tool’s own refusal.
    let caught: unknown;
    try {
      await runPdfTool({ toolId: 'font-to-outline', files: [pdfFile(source, 'type.pdf')], values: {} });
    } catch (error) {
      caught = error;
    }
    expect(isToolInputError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe('NEEDS_ENGINE');
    expect((caught as Error).message).toMatch(/Ghostscript/);
  });

  it('the tool itself refuses when called without the runner, and names the alternative', async () => {
    const source = await textPdf(1);
    engine.ready = false;
    let caught: unknown;
    try {
      await directRun('font-to-outline', {}, [pdfFile(source, 'type.pdf')]);
    } catch (error) {
      caught = error;
    }
    engine.ready = true;
    expect((caught as { code: string }).code).toBe('NEEDS_ENGINE');
    expect((caught as Error).message).toMatch(/Ghostscript/);
    expect((caught as { hint?: string }).hint).toMatch(/Rasterize PDF/i);
  });

  it('refuses when the engine cannot be downloaded', async () => {
    const source = await textPdf(1);
    engine.failure = 'Failed to load Ghostscript (network unavailable)';
    await expect(runPdfTool({ toolId: 'font-to-outline', files: [pdfFile(source, 'type.pdf')], values: {} }))
      .rejects.toThrow(/could not be reached/i);
    engine.failure = null;
  });

  it('says when the engine left fonts behind', async () => {
    const source = await textPdf(2);
    engine.outline = (bytes) => bytes;
    const outcome = await run('font-to-outline', {}, [pdfFile(source, 'type.pdf')]);
    engine.outline = null;
    expect(outcome.warnings.join(' ')).toMatch(/still referenced/i);
    expect(outcome.message).toMatch(/1 font reference\(s\) left|font reference\(s\) left/);
    expectMeasuredSizes(outcome.message ?? '', source.byteLength, outcome.bytes.byteLength);
  });
});

/* ── deskew-pdf ──────────────────────────────────────────────────────────── */

describe('deskew-pdf turns the page without breaking it (E6, E9, E15, E16)', () => {
  it('corrects the content and keeps /Rotate legal', async () => {
    const source = await textPdf(3);
    session.pages = [[595, 842], [595, 842], [595, 842]];
    skew.angles = [
      { angle: 2.5, confidence: 0.9 },
      { angle: 0.05, confidence: 0.9 },
      { angle: 45, confidence: 0.9 },
    ];
    const outcome = await run('deskew-pdf', { maxAngle: 10, threshold: 0.35, pages: 'all' }, [pdfFile(source, 'scan.pdf')]);
    const doc = await openPDF(outcome.bytes, { ignoreEncryption: true });
    expect(doc.getPageCount()).toBe(3);
    // The old code wrote `/Rotate 87.5`, which the spec forbids: viewers rounded
    // it away and the page stayed crooked while the tool reported success.
    for (const page of doc.getPages()) {
      expect(Math.abs(page.getRotation().angle) % 90).toBe(0);
    }
    const box = doc.getPage(0).getSize();
    expect(box.width).toBeGreaterThan(595);
    expect(box.height).toBeGreaterThan(842);
    const { pageContentStreams } = await import('@/lib/pdf/core/content');
    const content = pageContentStreams(doc.getPage(0))
      .map((stream) => Buffer.from(stream.bytes).toString('latin1'))
      .join('\n');
    expect(content).toMatch(/^q\s+0\.999/);
    expect(content).toMatch(/cm/);
    expect(content).toMatch(/Q/);
    expect(outcome.message).toMatch(/Straightened 1 page\(s\): 1 \(2\.50°\)/);
    expect(outcome.warnings.join(' ')).toMatch(/page 3 \(45\.00° is past the 10° limit\)/);
    expect(doc.getPage(1).getSize()).toEqual({ width: 595, height: 842 });
  });

  it('refuses a page range that runs off the end of the document (E6)', async () => {
    const source = await textPdf(2);
    session.pages = [[595, 842], [595, 842]];
    skew.angles = [];
    await expect(
      runPdfTool({ toolId: 'deskew-pdf', files: [pdfFile(source, 'two.pdf')], values: { pages: '1-9' } }),
    ).rejects.toThrow(/page 9, but this document has 2 pages/i);
  });

  it('straightens a page listed twice only once, and says so (E16)', async () => {
    const source = await textPdf(2);
    session.pages = [[595, 842], [595, 842]];
    skew.angles = [{ angle: -3, confidence: 0.8 }];
    const outcome = await run('deskew-pdf', { pages: '1,1' }, [pdfFile(source, 'dupes.pdf')]);
    expect(outcome.warnings.join(' ')).toMatch(/1 page\(s\) were listed more than once/i);
    const doc = await openPDF(outcome.bytes, { ignoreEncryption: true });
    // One 3° pass turns 595×842 into this box; a second pass would grow it again.
    const radians = (3 * Math.PI) / 180;
    const once = 595 * Math.cos(radians) + 842 * Math.sin(radians);
    const twice = once * Math.cos(radians) + (595 * Math.sin(radians) + 842 * Math.cos(radians)) * Math.sin(radians);
    const grown = doc.getPage(0).getSize().width;
    expect(Math.abs(grown - once)).toBeLessThan(0.5);
    expect(grown).toBeLessThan(twice - 5);
  });

  it('clamps an angle or confidence typed out of range (E15)', async () => {
    const source = await textPdf(1);
    session.pages = [[595, 842]];
    skew.angles = [{ angle: 3.4, confidence: 0.5 }];
    const result = await directRun('deskew-pdf', { maxAngle: 90, threshold: 0.01, pages: 'all' }, [pdfFile(source, 'clamped.pdf')]);
    const warnings = (result.warnings ?? []).join(' ');
    expect(warnings).toMatch(/Largest angle to correct must be between 1 and 30 °: 90 became 30\./);
    expect(warnings).toMatch(/Confidence needed before turning a page must be between 0\.05 and 0\.9: 0\.01 became 0\.05\./);
  });

  it('warns that annotations keep their old coordinates, and reports a page it could not measure (E10, E20)', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    page.drawText('marked up page', { x: 60, y: 700 });
    page.node.set(PDFName.of('Annots'), doc.context.obj([
      doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [50, 50, 70, 70] })),
    ]));
    const source = await doc.save({ useObjectStreams: false });
    session.pages = [[595, 842]];
    skew.angles = [{ angle: 4, confidence: 0.7 }];
    skew.failures = new Set([1]);
    const outcome = await run('deskew-pdf', {}, [pdfFile(source, 'marks.pdf')]);
    skew.failures = new Set();
    expect(outcome.warnings.join(' ')).toMatch(/page 1 could not be measured/i);
    expect(outcome.message).toMatch(/Nothing to do/i);

    skew.angles = [{ angle: 4, confidence: 0.7 }];
    const marked = await run('deskew-pdf', {}, [pdfFile(source, 'marks.pdf')]);
    expect(marked.warnings.join(' ')).toMatch(/1 annotation\(s\) kept their old coordinates/i);
  });
});

/* ── legacy bespoke panes ────────────────────────────────────────────────── */

describe('legacy pane tools stay honest about what they are (E2, E18)', () => {
  it('refuses to run from the Run button instead of emitting a file the pane never asked for', async () => {
    const source = await textPdf(1);
    for (const id of ['sign', 'pdf-crop', 'scan-to-pdf', 'compare']) {
      await expect(runPdfTool({ toolId: id, files: [pdfFile(source, 'x.pdf')], values: {} }))
        .rejects.toThrow(/own editor pane/i);
    }
  });

  it('offers Scan to PDF an image drop zone, not a PDF demand (E2)', async () => {
    const tool = getPdfTool('scan-to-pdf');
    expect(tool?.inputKind).toBe('image');
    expect(tool?.accept).toMatch(/image\/\*|jpg/);
    const jpeg = new File([TINY_JPEG], 'photo-01.jpg', { type: 'image/jpeg' });
    expect(fileProblem(tool!, [jpeg])).toBeNull();
    expect(fileProblem(tool!, [])?.message).toMatch(/Add a file first/i);
    // A photograph is not a PDF, and the guard says so rather than "failed".
    expect((await inspectPdf(TINY_JPEG, 'photo-01.jpg')).error).toBe('NOT_A_PDF');
  });

  it('says what each bespoke tool will not do', async () => {
    const notes = (id: string) => (getPdfTool(id)?.notes ?? []).join(' ');
    expect(notes('sign')).toMatch(/not a cryptographic signature/i);
    expect(notes('sign')).toMatch(/Digital sign PDF/i);
    expect(notes('pdf-crop')).toMatch(/hidden, not deleted/i);
    expect(notes('pdf-crop')).toMatch(/[Rr]edaction/);
    expect(notes('scan-to-pdf')).toMatch(/no text layer/i);
    expect(notes('scan-to-pdf')).toMatch(/OCR/);
    expect(notes('scan-to-pdf')).toMatch(/does not find the edges/i);
    expect(notes('compare')).toMatch(/pixels/i);
    expect(notes('compare')).toMatch(/shorter/i);
  });

  it('requires two files to compare and no more (E18)', async () => {
    const source = await textPdf(1);
    const tool = getPdfTool('compare')!;
    expect(fileProblem(tool, [pdfFile(source, 'a.pdf')])?.message).toMatch(/at least 2 files/i);
    expect(fileProblem(tool, [pdfFile(source, 'a.pdf'), pdfFile(source, 'b.pdf'), pdfFile(source, 'c.pdf')])?.message)
      .toMatch(/at most 2 files/i);
    expect(fileProblem(tool, [])?.message).toMatch(/Add a PDF first/i);
  });
});
