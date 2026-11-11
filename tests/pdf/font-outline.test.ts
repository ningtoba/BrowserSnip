/**
 * `font-to-outline` — the command line Ghostscript is handed, and the bytes that
 * come back.
 *
 * Triage item 3 (`docs/TOOL-TRIAGE.md`) caught this tool producing no file at all
 * with *"GPL Ghostscript 10.06.0: Device 'pdfwrite' requires an output file but
 * no file was specified."* — the engine loaded, ran, and was handed a malformed
 * vector: `-sOutputFile` in its own argument slot sets the parameter to the empty
 * string, so `pdfwrite` opens with nowhere to write and quits before page one.
 *
 * This file pins the two things that measurement could not settle.
 *
 *   1. **The argv** each `core/engine-ops` Ghostscript helper builds, checked
 *      against the sandbox paths `runGhostscript` writes the input to and reads
 *      the output back from. Offline, no wasm, no network.
 *   2. **The produced bytes**, run through the published `@bentopdf/gs-wasm`
 *      build over the app's own loader, so "outlined" is a measurement: text an
 *      outside reader could extract before and cannot after, glyphs that arrive
 *      as path operators, page count and page size intact, no font resource
 *      left behind — and, as the inverse case, a text-free page that keeps the
 *      picture and the vector art it started with.
 *
 * (2) needs the 15 MB engine, which the rest of the suite deliberately never
 * fetches. It is cached under `node_modules/.browsersnip-gs`; when it cannot be
 * downloaded the real-engine block says why and skips, and everything else here
 * still runs. `BROWSERSNIP_GS=off` skips it on purpose.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as pdfjs from 'pdfjs-dist';
import { GlobalWorkerOptions, OPS } from 'pdfjs-dist';
import { PDFDocument, StandardFonts, rgb } from '@maxwbh/pdf-lib';
import { PDFDict, PDFName, PDFRef, openPDF } from '@/lib/pdf/core/doc';
import { mediaBox } from '@/lib/pdf/core/pages';
import { describeSize, isToolInputError } from '@/lib/pdf/core/guard';
import { resetEngines } from '@/lib/pdf/engines/auto';
import { ENGINE_DEFAULTS } from '@/lib/pdf/engines/provider';
import { convertToPdfA, rebuildWithGhostscript, textToOutlines } from '@/lib/pdf/core/engine-ops';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { runPdfTool, type RunOutcome } from '@/lib/pdf/tools/runner';

/** ── the Ghostscript edge ────────────────────────────────────────────────── */

const gs = vi.hoisted(() => {
  return {
    /** Where the published WASM build is cached for the real-engine block. */
    dir: `${process.cwd()}/node_modules/.browsersnip-gs`,
    /** Every Ghostscript invocation, in call order. */
    calls: [] as Array<{ args: string[]; inputs: string[]; outputs: string[] }>,
    /** Set to make provisioning fail, exactly as an offline tab does. */
    unavailable: null as string | null,
    /** Set to make the run fail the way `engines/ghostscript.ts` reports it. */
    failWith: null as string | null,
    /** Canned bytes for the run to hand back, instead of the input unchanged. */
    replyWith: null as Uint8Array | null,
    /** Force the stand-in run even with a live engine: the card's sentences. */
    stub: false,
    /** True when the real WASM build is in place and a run really converts. */
    live: false,
    /** Why the real-engine block is skipping, in the sentence it prints. */
    skipped: '',
  };
});

// `auto.ts` provisions through the `ghostscript` export; the `run` double below
// still reaches the real loader, so a live run is the app's own fetch → FS →
// `callMain` → read-back, with only the two browser edges replaced.
vi.mock('@/lib/pdf/engines/ghostscript', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/pdf/engines/ghostscript')>();
  return {
    ...real,
    ghostscript: async () => {
      if (gs.unavailable) throw new Error(gs.unavailable);
      return {};
    },
    run: async (
      args: string[],
      files: Record<string, Uint8Array>,
      options: { outputs?: string[] } = {},
    ) => {
      const inputs = Object.keys(files);
      const outputs = options.outputs ?? [];
      // Copy before delegating: Emscripten's `callMain` prepends its own program
      // name to the array it is handed, and the recorded vector has to be the one
      // the app built.
      gs.calls.push({ args: args.slice(), inputs, outputs });
      if (gs.failWith) {
        throw new Error(
          `Ghostscript stopped with exit code 1: ${gs.failWith}. The PDF was not converted; ` +
            'try the tool again, or simplify the document (fonts and colour spaces are the usual causes).',
        );
      }
      if (!gs.live || gs.stub) {
        // argv-only mode: the command line is the subject, so hand the caller
        // something to read back — the input, like a device that wrote nothing
        // new would.
        return { exitCode: 0, outputs: { [outputs[0]]: gs.replyWith ?? files[inputs[0]] }, log: [] };
      }
      return real.run(args, files, options);
    },
  };
});

vi.mock('@/lib/pdf/engines/provider', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/pdf/engines/provider')>();
  return {
    ...real,
    engines: {
      ...real.engines,
      // A directory, not a URL: a tab fetches `gs.js` and imports the blob it
      // made, which Node's module loader cannot do. `beforeAll` replaces those
      // two edges, so the address in use becomes a path on disk.
      getUrl: () => process.env.BROWSERSNIP_GS_DIR ?? `${gs.dir}${path.sep}`,
    },
  };
});

/** Any bytes will do for an argv pin: the double never lets Ghostscript see them. */
const SAMPLE = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);

/** Every Ghostscript call site in `core/engine-ops`, named by the tool that makes it. */
const VECTORS: Array<[string, () => Promise<unknown>]> = [
  ['textToOutlines (font-to-outline)', () => textToOutlines(SAMPLE, {})],
  ['convertToPdfA (pdf-to-pdfa)', () => convertToPdfA(SAMPLE, '2b', {})],
  ['rebuildWithGhostscript (repair)', () => rebuildWithGhostscript(SAMPLE, {})],
];

const lastCall = () => gs.calls[gs.calls.length - 1];

/* ── fixtures ───────────────────────────────────────────────────────────── */

/** Two pages of drawn text at two different sizes — outlining must not move them. */
async function typePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const sizes: Array<[number, number]> = [
    [595.28, 841.89],
    [612, 792],
  ];
  sizes.forEach(([width, height], index) => {
    const page = doc.addPage([width, height]);
    for (let row = 1; row <= 4; row++) {
      page.drawText(`OUTLINEPROBE page ${index + 1} line ${row}`, {
        x: 54,
        y: height - 90 - (row - 1) * 22,
        size: 14,
        font,
        color: rgb(0, 0, 0),
      });
    }
  });
  return doc.save({ useObjectStreams: false });
}

/** A page with a picture and vector art and no text at all: the inverse case. */
async function artPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const png = Uint8Array.from(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
  const image = await doc.embedPng(png);
  page.drawImage(image, { x: 60, y: 500, width: 200, height: 200 });
  page.drawRectangle({ x: 320, y: 520, width: 180, height: 160, color: rgb(0.2, 0.6, 0.2) });
  page.drawLine({ start: { x: 60, y: 300 }, end: { x: 500, y: 120 }, thickness: 4, color: rgb(0, 0, 0.8) });
  return doc.save({ useObjectStreams: false });
}

const pdfFileOf = (bytes: Uint8Array, name: string): File =>
  new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });

const bytesOf = async (blob: Blob): Promise<Uint8Array> =>
  new Uint8Array(await blob.arrayBuffer());

/* ── readers that are not the producer ──────────────────────────────────── */

let workerPath = `file://${process.cwd()}/node_modules/pdfjs-dist/build/pdf.worker.mjs`;

/**
 * pdf.js is the outside reader here: it is neither the producer (pdf-lib, then
 * Ghostscript) nor the app's own code, and it parses the file from disk bytes.
 */
async function withPdfJS<T>(bytes: Uint8Array, read: (doc: pdfjs.PDFDocumentProxy) => Promise<T>): Promise<T> {
  // pdf.js transfers the buffer it is handed, so every call gets its own copy.
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes.slice()),
    isEvalSupported: false,
    disableAutoFetch: true,
  }).promise;
  try {
    return await read(doc);
  } finally {
    await doc.destroy();
  }
}

/** Every string pdf.js can read out of each page — the user's select-all. */
async function extractableText(bytes: Uint8Array): Promise<string[]> {
  return withPdfJS(bytes, async (doc) => {
    const pages: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const content = await (await doc.getPage(n)).getTextContent();
      pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(''));
    }
    return pages;
  });
}

interface PaintCount {
  /** Glyph outlines and art: path construction followed by a paint. */
  paths: number;
  /** `Tj`/`TJ` — text still shown through a font. */
  text: number;
  images: number;
}

/** How each page is painted, from the operator list pdf.js builds for it. */
async function paintOps(bytes: Uint8Array): Promise<PaintCount[]> {
  const ops = OPS as unknown as Record<string, number>;
  return withPdfJS(bytes, async (doc) => {
    const rows: PaintCount[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const { fnArray } = await (await doc.getPage(n)).getOperatorList();
      const count = (op: number) => fnArray.filter((fn) => fn === op).length;
      rows.push({
        paths: count(ops.constructPath) + count(ops.fill) + count(ops.stroke),
        text: count(ops.showText) + count(ops.showTextSpace) + count(ops.showTextAdvanceLine),
        images: count(ops.paintImageXObject),
      });
    }
    return rows;
  });
}

/** `[width, height]` of every page, in points, off the page boxes. */
async function pageSizes(bytes: Uint8Array): Promise<Array<[number, number]>> {
  const doc = await openPDF(bytes, { ignoreEncryption: true, updateMetadata: false });
  return doc.getPages().map((page) => {
    const box = mediaBox(page);
    return [Math.round(box.width * 100) / 100, Math.round(box.height * 100) / 100] as [number, number];
  });
}

/** Distinct font and image resources the document still resolves. */
async function resources(bytes: Uint8Array): Promise<{ fonts: number; images: number }> {
  const doc = await openPDF(bytes, { ignoreEncryption: true, updateMetadata: false });
  const fonts = new Set<string>();
  const images = new Set<string>();
  const resolve = (value: unknown): PDFDict | undefined => {
    const object = value instanceof PDFRef ? doc.context.lookup(value) : value;
    return object instanceof PDFDict ? object : undefined;
  };
  for (const page of doc.getPages()) {
    const holder = resolve(page.node.Resources());
    const fontMap = resolve(holder?.get(PDFName.of('Font')));
    for (const [, value] of fontMap?.entries() ?? []) {
      const dict = resolve(value);
      if (dict) fonts.add(String(dict.get(PDFName.of('BaseFont'))));
    }
    const xobjects = resolve(holder?.get(PDFName.of('XObject')));
    for (const [, value] of xobjects?.entries() ?? []) {
      const dict = resolve(value);
      if (dict?.get(PDFName.of('Subtype')) === PDFName.of('Image')) {
        images.add(`${dict.get(PDFName.of('Width'))}x${dict.get(PDFName.of('Height'))}`);
      }
    }
  }
  return { fonts: fonts.size, images: images.size };
}

/* ── the real engine ────────────────────────────────────────────────────── */

const createObjectURL = URL.createObjectURL;

beforeAll(async () => {
  // `core/render` repoints the worker on every open; keep the on-disk path so
  // pdf.js can really parse these files here.
  Object.defineProperty(GlobalWorkerOptions, 'workerSrc', {
    configurable: true,
    get: () => workerPath,
    set: (value: string) => {
      if (value.startsWith('file:') || value.startsWith('data:')) workerPath = value;
    },
  });

  if (process.env.BROWSERSNIP_GS === 'off') {
    gs.skipped = 'BROWSERSNIP_GS=off';
    return;
  }
  try {
    fs.mkdirSync(gs.dir, { recursive: true });
    for (const file of ['gs.js', 'gs.wasm']) {
      const target = path.join(gs.dir, file);
      if (fs.existsSync(target) && fs.statSync(target).size > 0) continue;
      const response = await fetch(`${ENGINE_DEFAULTS.ghostscript}${file}`);
      if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
      fs.writeFileSync(target, new Uint8Array(await response.arrayBuffer()));
    }
  } catch (error) {
    gs.skipped = `the Ghostscript WASM build is not on disk here (${error instanceof Error ? error.message : String(error)})`;
    return;
  }

  // The two edges a browser provides and Node does not: fetching the module
  // text, and importing the blob URL made from it.
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const requested = String(input).replace(/^https?:\/\/[^/]+/, '');
    return new Response(fs.readFileSync(path.join(gs.dir, path.basename(requested))));
  });
  URL.createObjectURL = (() => `file://${path.join(gs.dir, 'gs.js')}`) as typeof URL.createObjectURL;
  gs.live = true;
}, 240_000);

afterAll(() => {
  URL.createObjectURL = createObjectURL;
  vi.unstubAllGlobals();
});

/* ── 1. the command line ────────────────────────────────────────────────── */

describe('the Ghostscript command line each tool builds', () => {
  it('names the output file to the device that requires one', async () => {
    expect(VECTORS.length).toBe(3);
    // Capture everything first, then assert: the proof rig wants the vectors a
    // broken build produced too, not only the ones that pass.
    const captured = [];
    const rejected: Array<[string, unknown]> = [];
    for (const [name, invoke] of VECTORS) {
      gs.calls.length = 0;
      try {
        await invoke();
      } catch (error) {
        // A malformed vector makes Ghostscript exit 1 before the promise settles.
        // The command line is already recorded, so dump and assert it, then fail.
        rejected.push([name, error]);
      }
      captured.push({ tool: name, ...lastCall() });
    }
    const dump = process.env.BROWSERSNIP_GS_DUMP;
    if (dump) {
      // `docs/research/font-outline-wasm.mjs` runs these exact vectors through
      // the published build, so the quoted command line comes out of the source
      // rather than being retyped into a proof script.
      fs.writeFileSync(
        dump,
        `${JSON.stringify(captured.map(({ tool, args }) => ({ tool, args })), null, 2)}\n`,
      );
    }

    for (const call of captured) {
      const name = call.tool;
      // The defect, per vector: `-sOutputFile` alone sets the parameter to the
      // empty string and `pdfwrite` refuses to start.
      const outputArgs = call.args.filter((arg) => arg.startsWith('-sOutputFile'));
      expect(outputArgs, `${name} must pass -sOutputFile exactly once`).toHaveLength(1);
      expect(outputArgs[0], `${name} must glue the path to the switch: ${JSON.stringify(call.args)}`)
        .toBe(`-sOutputFile=${call.outputs[0]}`);
      expect(call.args[call.args.length - 1], `${name} must name the file it wrote as the input`)
        .toBe(call.inputs[0]);
      // The class rule: no string parameter is ever handed over without its value.
      expect(call.args.filter((arg) => /^-s[^=]+$/.test(arg)), `${name}: ${JSON.stringify(call.args)}`)
        .toEqual([]);
      expect(call.args.every((arg) => arg.length > 0 && !arg.includes('\n'))).toBe(true);
    }
    if (rejected.length) {
      throw new Error(`${rejected[0][0]}: ${String((rejected[0][1] as Error)?.message ?? rejected[0][1])}`);
    }
  });

  it('asks the outline run for outlines, and for all of the pages', async () => {
    gs.calls.length = 0;
    await textToOutlines(SAMPLE, {});
    const args = lastCall().args;
    // `-dNoOutputFonts` is the mechanism behind the tool's whole claim.
    expect(args).toContain('-dNoOutputFonts');
    expect(args).toContain('-sDEVICE=pdfwrite');
    expect(args).toContain('-dAutoRotatePages=/None');
    // Nothing may narrow the job to part of the document.
    expect(args.filter((arg) => arg.startsWith('-dFirstPage') || arg.startsWith('-dLastPage'))).toEqual([]);
  });
});

/* ── 2. the bytes a real Ghostscript run produces ───────────────────────── */

describe('font-to-outline over the published Ghostscript build', () => {
  it('turns drawn text into paths a reader can see but cannot read', async (ctx) => {
    if (!gs.live) ctx.skip(gs.skipped || 'the real Ghostscript build was not loaded');
    const source = await typePdf();
    const before = await extractableText(source);
    const beforePaint = await paintOps(source);
    expect(before.join(' ')).toContain('OUTLINEPROBE page 1 line 1');
    expect(before.reduce((sum, page) => sum + page.length, 0)).toBeGreaterThan(40);

    const outcome = await runPdfTool({
      toolId: 'font-to-outline',
      files: [pdfFileOf(source, 'type.pdf')],
      values: {},
    });
    const bytes = await bytesOf(outcome.outputs[0].blob);

    // 1. The words are gone from the text layer, on every page — that is what
    //    outlining means. A file that came back unchanged fails here.
    const after = await extractableText(bytes);
    expect(after).toHaveLength(before.length);
    expect(after.join('').trim()).toBe('');

    // 2. They are gone because the glyphs became geometry, not because the page
    //    stopped being painted: path operators appear where text operators were.
    const painted = await paintOps(bytes);
    painted.forEach((page, index) => {
      expect(page.text, `page ${index + 1} still shows text through a font`).toBe(0);
      expect(page.paths, `page ${index + 1} paints no paths`).toBeGreaterThan(beforePaint[index].paths);
    });

    // 3. Same pages, same boxes: an outline run rewrites, it does not re-impose.
    expect(outcome.pagesOut).toBe(before.length);
    expect(await pageSizes(bytes)).toEqual(await pageSizes(source));

    // 4. Nothing survives that could substitute or reflow.
    expect((await resources(bytes)).fonts).toBe(0);

    // 5. The card says what those bytes do.
    const said = `${outcome.message ?? ''} ${outcome.warnings.join(' ')}`;
    expect(said).not.toMatch(/still referenced/i);
    expect(said).toMatch(/path/i);
    expect(said).toContain(describeSize(bytes.byteLength));
    expect(said).not.toMatch(/NaN|undefined|Infinity/);
  }, 240_000);

  it('keeps the picture and the art on a page with no text at all', async (ctx) => {
    if (!gs.live) ctx.skip(gs.skipped || 'the real Ghostscript build was not loaded');
    const source = await artPdf();
    expect((await extractableText(source)).join('').trim()).toBe('');
    const beforePaint = await paintOps(source);
    expect(beforePaint[0].images).toBe(1);
    expect(beforePaint[0].paths).toBeGreaterThan(0);

    const outcome = await runPdfTool({
      toolId: 'font-to-outline',
      files: [pdfFileOf(source, 'artwork.pdf')],
      values: {},
    });
    const bytes = await bytesOf(outcome.outputs[0].blob);
    const afterPaint = await paintOps(bytes);

    // The same failure family in reverse: a page with nothing to outline must
    // come back with everything it had, not a blank sheet.
    expect(afterPaint[0].images).toBe(1);
    expect(afterPaint[0].paths).toBeGreaterThanOrEqual(beforePaint[0].paths);
    expect((await resources(bytes)).images).toBe((await resources(source)).images);
    expect(await pageSizes(bytes)).toEqual(await pageSizes(source));
    expect(outcome.pagesOut).toBe(1);
    // And it must not claim to have converted type that was never there.
    expect(outcome.message).toMatch(/no page draws text|nothing to outline/i);
    expect(outcome.message).not.toMatch(/vector paths|all \d+ page\(s\)/i);
  }, 240_000);

  it('hands back a file that reopens, and counts it from the producer', async (ctx) => {
    if (!gs.live) ctx.skip(gs.skipped || 'the real Ghostscript build was not loaded');
    const source = await typePdf();
    const outcome = await runPdfTool({
      toolId: 'font-to-outline',
      files: [pdfFileOf(source, 'type.pdf')],
      values: {},
    });
    const bytes = await bytesOf(outcome.outputs[0].blob);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(bytes.byteLength).not.toBe(source.byteLength);
    const reopened = await openPDF(bytes, { ignoreEncryption: true, updateMetadata: false });
    expect(reopened.getPageCount()).toBe(2);
    expect(outcome.outputs[0].name).toMatch(/_outlined\.pdf$/);
  }, 240_000);
});

/* ── 3. what the card may claim ─────────────────────────────────────────── */

describe('font-to-outline describes the run it actually had', () => {
  // These rows are about the sentences, not the conversion: the stand-in answers
  // with the bytes each scenario says Ghostscript handed back.
  beforeEach(() => {
    gs.stub = true;
    // `auto.ts` memoises a provisioned engine, and one row needs the loader to
    // be asked again so it can fail.
    resetEngines();
  });
  afterEach(() => {
    gs.stub = false;
    resetEngines();
  });

  const outline = async (source: Uint8Array, name = 'type.pdf'): Promise<RunOutcome> =>
    runPdfTool({ toolId: 'font-to-outline', files: [pdfFileOf(source, name)], values: {} });

  it('calls a refused conversion a refusal, not a missing download', async () => {
    // The engine is loaded — this is the shape of the triage's run.
    gs.failWith = "GPL Ghostscript 10.06.0: Device 'pdfwrite' requires an output file but no file was specified.";
    let caught: unknown;
    try {
      await outline(await typePdf());
    } catch (error) {
      caught = error;
    } finally {
      gs.failWith = null;
    }
    expect(isToolInputError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe('NEEDS_ENGINE');
    const said = (caught as Error).message;
    expect(said).toMatch(/exit code 1/);
    expect(said).toMatch(/nothing was outlined/i);
    // Ghostscript *was* reached: telling the user it could not be fetched sends
    // them to check a connection that is fine.
    expect(said).not.toMatch(/could not be reached/i);
  });

  it('still calls a missing download a missing download', async () => {
    gs.unavailable = 'Failed to fetch';
    let caught: unknown;
    try {
      await outline(await typePdf());
    } catch (error) {
      caught = error;
    } finally {
      gs.unavailable = null;
    }
    const said = `${(caught as Error).message} ${(caught as { hint?: string }).hint ?? ''}`;
    expect(said).toMatch(/could not be reached/i);
    expect(said).toMatch(/Rasterize PDF/i);
    expect(said).not.toMatch(/settings|enable|configure/i);
  });

  it('does not claim a vector path for bytes that still draw text', async () => {
    const source = await typePdf();
    // The silent failure of the same family: the engine returns, and nothing changed.
    gs.replyWith = source;
    const outcome = await outline(source);
    gs.replyWith = null;
    const said = `${outcome.message ?? ''} ${outcome.warnings.join(' ')}`;
    expect(said).toMatch(/still draw text/i);
    expect(outcome.message).not.toMatch(/vector paths|no font resource is left|nothing to outline/i);
  });

  it('says there was nothing to outline when no page draws text', async () => {
    const blank = await artPdf();
    gs.replyWith = blank;
    const outcome = await outline(blank, 'artwork.pdf');
    gs.replyWith = null;
    expect(outcome.message).toMatch(/no page draws text|nothing to outline/i);
    expect(outcome.message).not.toMatch(/every glyph/i);
  });

  it('promises only what it can do, and admits it has no fallback', () => {
    const tool = getPdfTool('font-to-outline');
    expect(tool?.engines).toEqual(['ghostscript']);
    expect(tool?.notes?.join(' ')).toMatch(/no degraded path/i);
    // The promise covers both ways the run can end without a file.
    expect(tool?.promise).toMatch(/could not be fetched|refus/i);
  });
});
