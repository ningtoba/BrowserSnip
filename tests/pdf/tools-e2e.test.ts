/**
 * End-to-end tool execution.
 *
 * These drive the same path the UI drives — registry lookup → `runPdfTool` →
 * tool `run()` → `core/helpers` → `@maxwbh/pdf-lib` — against a real PDF built
 * with pdf-lib, and then re-open the returned bytes. `tsc` and the unit suites
 * cannot catch a tool whose `run` is wired to the wrong helper or whose output
 * never parses, so this asserts the produced file, not the function's return.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts, rgb } from '@maxwbh/pdf-lib';
// Type only: the value `PDFDict` is loaded lazily below with the rest of
// `core/doc`, and a type predicate needs the type meaning of that name.
import type { PDFDict } from '@/lib/pdf/core/doc';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { runPdfTool } from '@/lib/pdf/tools/runner';

function pdfFile(bytes: Uint8Array, name: string): File {
  // SAFETY: a `Uint8Array` view is a valid `BlobPart`; the DOM lib types the
  // array-buffer branch as `ArrayBufferView<ArrayBuffer>` and `bytes.buffer`
  // is `ArrayBufferLike`, so the copy passed here is the narrowest sound form.
  return new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });
}

/**
 * The decoded content streams of every page, in draw order.
 *
 * Content streams live on the page (`/Contents` may be absent, a direct
 * stream, a reference, or an array of references) and are Flate-compressed, so
 * neither a regex over the file nor a walk of the indirect objects finds them.
 * `pageContentStreams` is the same reader the text-colour and redaction tools
 * use, so this asserts the real path.
 *
 * Note the drawn text itself is *not* searchable as ASCII here: the fork of
 * pdf-lib this app uses embeds a real font even for the standard-14 names, so a
 * `Tj` operand is a hex string of glyph ids. Assertions therefore look at
 * structure — which streams exist, how many, and what operators they run — and
 * the human-readable text is verified through the app's own extractor below.
 */
async function pageStreams(bytes: Uint8Array): Promise<string[]> {
  const { openPDF } = await import('@/lib/pdf/core/doc');
  const { pageContentStreams } = await import('@/lib/pdf/core/content');
  const doc = await openPDF(bytes, { ignoreEncryption: true });
  return doc.getPages().map(
    (page) => pageContentStreams(page).map((stream) => Buffer.from(stream.bytes).toString('latin1')).join('\n'),
  );
}

/**
 * True when every font the page draws with carries a `/ToUnicode` CMap.
 *
 * Text stamped by this app is written as glyph ids, so it is only selectable
 * and searchable in a viewer if the embedded font ships that CMap. Checking it
 * here is the useful assertion — a home-grown decoder round-trip would only
 * prove the decoder agrees with the writer.
 */
async function embeddedFontsHaveToUnicode(bytes: Uint8Array): Promise<boolean> {
  const { openPDF, PDFName, PDFDict, PDFRef } = await import('@/lib/pdf/core/doc');
  const doc = await openPDF(bytes, { ignoreEncryption: true });
  const page = doc.getPages()[0];
  const resources = page.node.Resources();
  if (!(resources instanceof PDFDict)) return false;
  const fonts = resources.get(PDFName.of('Font'));
  const fontDict = fonts instanceof PDFRef ? doc.context.lookup(fonts, PDFDict) : fonts;
  if (!(fontDict instanceof PDFDict)) return false;
  const entries = fontDict.entries();
  if (entries.length === 0) return false;
  // Only *embedded* fonts need a /ToUnicode CMap. A standard-14 font declares
  // /WinAnsiEncoding and a viewer maps its bytes natively, so requiring
  // /ToUnicode there would be wrong.
  return entries
    .map(([, value]) => (value instanceof PDFRef ? doc.context.lookup(value, PDFDict) : value))
    .filter((font): font is PDFDict => font instanceof PDFDict)
    .filter((font) => ['FontFile', 'FontFile2', 'FontFile3'].some((key) => font.get(PDFName.of(key)) !== undefined))
    .every((font) => font.get(PDFName.of('ToUnicode')) !== undefined);
}

async function sample(pages = 4): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(`Sample page ${i + 1}`, { x: 60, y: 700, size: 22, font, color: rgb(0, 0, 0) });
    page.drawText('Confidential draft body text for redaction tests.', {
      x: 60,
      y: 640,
      size: 12,
      font,
    });
  }
  doc.setTitle('BrowserSnip fixture');
  doc.setAuthor('Test Harness');
  return doc.save({ useObjectStreams: false });
}

let source: Uint8Array;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  source = await sample();
  // `core/fonts` lazily fetches the bundled Unicode faces by URL. jsdom has no
  // static server, so serve the real files from `public/` — that keeps this a
  // test of the embedding path rather than a stub of it.
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  // Vitest runs from the repository root, and Vite rewrites `import.meta.url`
  // to a non-file value, so resolve the bundled faces from the working directory.
  const face = (file: string): Uint8Array =>
    new Uint8Array(readFileSync(join(process.cwd(), 'public', 'fonts', file)));
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const match = /NotoSans-(Regular|Bold)\.ttf$/.exec(url);
    if (!match) return new Response('not found', { status: 404 });
    return new Response(face(`NotoSans-${match[1]}.ttf`), { headers: { 'content-type': 'font/ttf' } });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

async function run(id: string, values: Record<string, unknown> = {}, files: File[] = [pdfFile(source, 'fixture.pdf')]) {
  const tool = getPdfTool(id);
  expect(tool, `tool "${id}" is not registered`).toBeTruthy();
  const outcome = await runPdfTool({
    toolId: id,
    files,
    values,
    onProgress: () => {},
    onLog: () => {},
  });
  expect(outcome, `${id} produced no outcome`).toBeTruthy();
  return outcome!;
}

async function firstPdf(outcome: { outputs: { blob: Blob; name: string }[] }): Promise<Uint8Array> {
  expect(outcome.outputs.length).toBeGreaterThan(0);
  return new Uint8Array(await outcome.outputs[0].blob.arrayBuffer());
}

describe('pdf tools end to end', () => {
  it('merges two documents and reports the combined page count', async () => {
    const outcome = await run('merge', { bookmarks: false }, [
      pdfFile(source, 'a.pdf'),
      pdfFile(source, 'b.pdf'),
    ]);
    const bytes = await firstPdf(outcome);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(8);
    expect(outcome.outputs[0].name).toBe('a_merged.pdf');
  });

  it('rejects a merge with a single file before doing any work', async () => {
    await expect(
      runPdfTool({ toolId: 'merge', files: [pdfFile(source, 'only.pdf')], values: {} }),
    ).rejects.toThrow(/at least two/i);
  });

  it('deletes pages and keeps the rest', async () => {
    const outcome = await run('remove-pages', { pages: '2,4' });
    const doc = await PDFDocument.load(await firstPdf(outcome));
    expect(doc.getPageCount()).toBe(2);
    expect(outcome.message).toMatch(/Removed 2 pages/i);
  });

  it('refuses to delete every page', async () => {
    await expect(
      runPdfTool({ toolId: 'remove-pages', files: [pdfFile(source, 'x.pdf')], values: { pages: 'all' } }),
    ).rejects.toThrow(/every page|delete every/i);
  });

  it('extracts a range into one document', async () => {
    const outcome = await run('extract-pages', { pages: '2-3', mergeIntoOne: true });
    const doc = await PDFDocument.load(await firstPdf(outcome));
    expect(doc.getPageCount()).toBe(2);
  });

  it('splits into one downloadable file per range', async () => {
    const outcome = await run('split', { mode: 'ranges', ranges: '1-2, 3-4' });
    expect(outcome.outputs).toHaveLength(2);
    for (const output of outcome.outputs) {
      const doc = await PDFDocument.load(new Uint8Array(await output.blob.arrayBuffer()));
      expect(doc.getPageCount()).toBe(2);
      expect(output.name).toMatch(/_split.*\.pdf$|\.pdf$/);
    }
  });

  it('splits every page into separate named files', async () => {
    const outcome = await run('split', { mode: 'every' });
    expect(outcome.outputs).toHaveLength(4);
    const counts = await Promise.all(
      outcome.outputs.map(async (output) => (await PDFDocument.load(new Uint8Array(await output.blob.arrayBuffer()))).getPageCount()),
    );
    expect(counts).toEqual([1, 1, 1, 1]);
  });

  it('rejects an empty range instead of silently copying the document', async () => {
    await expect(
      runPdfTool({ toolId: 'split', files: [pdfFile(source, 'x.pdf')], values: { mode: 'ranges', ranges: '   ' } }),
    ).rejects.toThrow(/range/i);
  });

  it('rotates the selected pages only', async () => {
    const outcome = await run('rotate', { degrees: 90, pages: '1,3' });
    const doc = await PDFDocument.load(await firstPdf(outcome));
    const rotations = doc.getPages().map((page) => page.getRotation().angle);
    expect(rotations).toEqual([90, 0, 90, 0]);
  });

  it('reverses the page order', async () => {
    const bytes = await firstPdf(await run('reverse-pages'));
    const [before, after] = await Promise.all([pageStreams(source), pageStreams(bytes)]);
    expect(after).toHaveLength(4);
    // Page 1 of the output must be the page that was last in the input.
    expect(after[0]).toBe(before[3]);
    expect(after[3]).toBe(before[0]);
    expect(after[0]).not.toBe(before[0]);
  });

  it('imposes a booklet with padded sheets in saddle-stitch order', async () => {
    const outcome = await run('booklet', { sheetSize: 'a4', landscape: true, blankFill: true });
    const doc = await PDFDocument.load(await firstPdf(outcome));
    // 4 pages → 1 sheet front + 1 sheet back, each 2-up on a landscape A4.
    expect(doc.getPageCount()).toBe(2);
    const size = doc.getPage(0).getSize();
    expect(size.width).toBeGreaterThan(size.height);
  });

  it('places two source pages on one sheet with N-up', async () => {
    const outcome = await run('n-up', { perSheet: 2, sheetSize: 'a4', landscape: true });
    const doc = await PDFDocument.load(await firstPdf(outcome));
    expect(doc.getPageCount()).toBe(2);
  });

  it('inserts blank pages at the chosen position', async () => {
    const outcome = await run('add-blank-page', { position: 'after', anchor: 1, count: 2, size: 'same' });
    const doc = await PDFDocument.load(await firstPdf(outcome));
    expect(doc.getPageCount()).toBe(6);
  });

  it('reorders pages from a plan string and rotates within it', async () => {
    const outcome = await run('organize', { pageOrder: '3, 1r90, blank, 2' });
    const doc = await PDFDocument.load(await firstPdf(outcome));
    expect(doc.getPageCount()).toBe(4);
    expect(doc.getPages()[1].getRotation().angle).toBe(90);
  });

  it('adds page numbers that end up in the content stream', async () => {
    const outcome = await run('page-numbers', {
      position: 'bottom-center',
      fontSize: 11,
      startAt: 1,
      prefix: 'Page ',
      suffix: ' of {total}',
      style: 'decimal',
      skip: 0,
      step: 1,
      pages: 'all',
      margin: 24,
      color: '#1b1b18',
      bold: false,
      font: 'std:helvetica',
    });
    const streams = await pageStreams(await firstPdf(outcome));
    // Every page gained exactly one extra content stream that shows text.
    const original = await pageStreams(source);
    for (let i = 0; i < streams.length; i++) {
      expect(streams[i].length).toBeGreaterThan(original[i].length);
      expect(streams[i]).toMatch(/BT[\s\S]*Tj|TJ[\s\S]*ET/);
    }
    const outputBytes = await firstPdf(outcome);
    // Four pages × one stamp, and the stamp adds a text-showing operator.
    const stamped = await pageStreams(outputBytes);
    expect(stamped.filter((stream) => /Tj|TJ/.test(stream))).toHaveLength(4);
    expect(await embeddedFontsHaveToUnicode(outputBytes)).toBe(true);
  });

  it('stamps Cyrillic text instead of throwing the old WinAnsi error', async () => {
    // The whole app used to draw text with pdf-lib's standard fonts, so any
    // non-WinAnsi character raised `WinAnsi cannot encode "…"`. Every text tool
    // now routes through core/fonts, which embeds a Unicode face.
    const outcome = await run('watermark', {
      type: 'text',
      text: 'Согласовано ✔',
      opacity: 0.25,
      rotation: 30,
      fontSize: 48,
      layer: 'over',
      position: 'center',
      tile: false,
      tileGap: 1.5,
      bold: false,
      scale: 0.3,
      color: '#444444',
      pages: 'all',
    });
    const bytes = await firstPdf(outcome);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(4);
    const streams = await pageStreams(bytes);
    expect(streams.every((stream) => /<([0-9A-Fa-f]{4,})>\s*Tj/.test(stream.replace(/\s+/g, ' ')))).toBe(true);
    // An embedded subset must be reversible to text for viewers and search.
    expect(await embeddedFontsHaveToUnicode(bytes)).toBe(true);
  });

  it('watermarks every page and fails clearly with no text', async () => {
    const outcome = await run('watermark', {
      type: 'text',
      text: 'DRAFT',
      opacity: 0.3,
      rotation: 45,
      fontSize: 64,
      layer: 'over',
      position: 'center',
      tile: false,
      tileGap: 1.5,
      bold: true,
      scale: 0.35,
      color: '#888888',
      pages: 'all',
    });
    const streams = await pageStreams(await firstPdf(outcome));
    expect(streams).toHaveLength(4);
    // Every page must carry the watermark as a glyph-id show operation.
    expect(streams.every((stream) => /<([0-9A-Fa-f]{2,})>\s*Tj/.test(stream.replace(/\s+/g, ' ')))).toBe(true);
    const original = await pageStreams(source);
    expect(streams.every((stream, i) => stream.length > original[i].length)).toBe(true);

    await expect(
      runPdfTool({
        toolId: 'watermark',
        files: [pdfFile(source, 'x.pdf')],
        values: { type: 'text', text: '   ', pages: 'all' },
      }),
    ).rejects.toThrow(/watermark text/i);
  });

  it('protects with a password and unlocks again', async () => {
    const protectedOutcome = await run('protect', {
      mode: 'both',
      userPassword: 'hunter2',
      ownerPassword: '',
      allowPrinting: true,
      printLevel: 'high',
      allowModifying: false,
      allowCopying: false,
      allowAnnotating: false,
      allowFillingForms: false,
      allowAccessibility: true,
      allowAssembling: false,
    });
    const protectedBytes = await firstPdf(protectedOutcome);
    // The gate is what this browser writes; a strength name here would be the
    // claim the triage measured against the bytes and found absent.
    expect(protectedOutcome.message).toMatch(/open password/);
    expect(protectedOutcome.message).toMatch(/no crypt filter/);
    expect(Buffer.from(protectedBytes).toString('latin1')).toMatch(/\/Encrypt/);

    // Reading it without the password must fail, and the error must say why.
    await expect(
      runPdfTool({ toolId: 'rotate', files: [pdfFile(protectedBytes, 'locked.pdf')], values: { degrees: 90, pages: 'all' } }),
    ).rejects.toThrow(/password/i);

    const unlocked = await run('unlock', { password: 'hunter2' }, [pdfFile(protectedBytes, 'locked.pdf')]);
    const doc = await PDFDocument.load(await firstPdf(unlocked));
    expect(doc.getPageCount()).toBe(4);
  });

  it('rejects a wrong password rather than producing a blank document', async () => {
    const protectedOutcome = await run('protect', {
      mode: 'user',
      userPassword: 'correct-horse',
      ownerPassword: '',
      allowPrinting: true,
      printLevel: 'high',
      allowModifying: true,
      allowCopying: true,
      allowAnnotating: true,
      allowFillingForms: true,
      allowAccessibility: true,
      allowAssembling: true,
    });
    const locked = await firstPdf(protectedOutcome);
    await expect(
      runPdfTool({
        toolId: 'unlock',
        files: [pdfFile(locked, 'locked.pdf')],
        values: { password: 'wrong-saddle' },
      }),
    ).rejects.toThrow(/not correct|password/i);
  });

  it('reports a helpful message when a non-PDF is dropped on a PDF tool', async () => {
    const text = new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16])], 'notes.txt', {
      type: 'text/plain',
    });
    await expect(
      runPdfTool({ toolId: 'rotate', files: [text], values: { degrees: 90, pages: 'all' } }),
    ).rejects.toThrow(/not a PDF/i);
  });

  it('names the offending file when one of several inputs is broken', async () => {
    await expect(
      runPdfTool({
        toolId: 'merge',
        files: [pdfFile(source, 'good.pdf'), pdfFile(new Uint8Array(32), 'corrupt.pdf')],
        values: {},
      }),
    ).rejects.toThrow(/corrupt\.pdf/);
  });

  it('produces a report instead of a file for metadata inspection', async () => {
    const outcome = await run('view-metadata');
    expect(outcome.report).toBeTruthy();
    expect(outcome.report!.sections.length).toBeGreaterThan(0);
    const rows = outcome.report!.sections.flatMap((section) => section.rows ?? []);
    expect(rows.some((row) => row.value === 'BrowserSnip fixture')).toBe(true);
  });

  it('rewrites metadata and reads it back', async () => {
    const outcome = await run('edit-metadata', {
      title: 'Renamed by test',
      author: 'Harness',
      subject: '',
      keywords: 'alpha, beta',
      creator: '',
      producer: '',
      language: '',
      syncXmp: false,
      touchDates: true,
    });
    const doc = await PDFDocument.load(await firstPdf(outcome));
    expect(doc.getTitle()).toBe('Renamed by test');
    expect(doc.getAuthor()).toBe('Harness');
  });

  it('refuses a protect run with no password at all', async () => {
    await expect(
      runPdfTool({
        toolId: 'protect',
        files: [pdfFile(source, 'x.pdf')],
        values: { mode: 'both', userPassword: '', ownerPassword: '' },
      }),
    ).rejects.toThrow(/password/i);
  });
});
