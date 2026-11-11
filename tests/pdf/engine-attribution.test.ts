/**
 * Who wrote these bytes? (the `ENGINE` row's attribution)
 *
 * The result card printed `tool.engines[0]` — the engine a tool is *configured* to
 * use — so `pdf-to-pdfa` displayed a Ghostscript attribution while
 * `bestEffortPdfA` wrote the file, and a completely dead engine invocation stayed
 * invisible for a whole debugging session (`docs/TOOL-TRIAGE.md` §3, re-measured in
 * `docs/research/pdfa-attribution-recheck.md`). Every measurement of "did the engine
 * work?" that day was partly answered by reading that row, so the row is an
 * instrument, not decoration.
 *
 * What is pinned here, in both directions, because a provenance assertion that
 * passes in both states is worthless:
 *
 *   1. the seam stamps `{ via: 'engine' }` on bytes it produced, and the file the
 *      user is handed is byte-for-byte the one the engine wrote;
 *   2. an engine that never arrived, that ran and produced nothing, or whose file the
 *      tool discarded, gives `{ via: 'fallback' }` — and the card then refuses to
 *      print the engine's name at all;
 *   3. attribution is per output, so a mixed run cannot be answered by one label;
 *   4. a tool with two declared engines prints the one that ran, not `engines[0]`;
 *   5. a run that says nothing prints "not reported" rather than borrowing a name;
 *   6. the hard cases speak: an engine that refused outright produces no file and so
 *      claims nothing, and `repair` — which declares no engine yet escalates to
 *      Ghostscript — is credited when Ghostscript does the work.
 *
 * The Ghostscript and CoherentPDF *loaders* are doubled at the module edge, so the
 * real `core/engine-ops` seam and the real tools run; only the binaries are stand-ins.
 * The last block runs the published `@bentopdf/gs-wasm` build when it is on disk
* (`BROWSERSNIP_GS=live`, skipped on CI) and asserts the finding the label hid: the
 * engine's file carries Ghostscript's producer and **no** `/OutputIntents`, and the
 * fallback's file is the one that has an output intent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { render, screen, within } from '@testing-library/react';
import { PDFDocument, StandardFonts, rgb } from '@maxwbh/pdf-lib';
import { openPDF, PDFName } from '@/lib/pdf/core/doc';
import { resetEngines } from '@/lib/pdf/engines/auto';
import { runPdfTool, type RunOutcome } from '@/lib/pdf/tools/runner';
import type { ByteSource, PdfToolDefinition } from '@/lib/pdf/tools/types';
import { useProcessStore } from '@/stores/process-store';
import {
  ResultCard,
  describeProvenance,
  describeSource,
  type ResultItem,
} from '@/components/tools/pdf/shared/ResultCard';

/* ── doubles ──────────────────────────────────────────────────────────────── */

/** What the stand-in engines do, per case. Hoisted: `vi.mock` factories run first. */
const gs = vi.hoisted(() => ({
  /** Bytes the stand-in Ghostscript writes to its sandbox output path. */
  reply: null as Uint8Array | null,
  /** Set to make provisioning fail the way an offline tab does. */
  unreachable: null as string | null,
  /**
   * Force the stand-in even where the real engine is on disk. The sentences and the
   * attribution are offline properties of the code, so every case outside the live
   * block answers from `reply`; the live block flips this and measures bytes.
   */
  stub: true,
  /** Every argument vector the source built, in call order. */
  calls: [] as string[][],
  dir: `${process.cwd()}/node_modules/.browsersnip-gs`,
  live: false,
}));

const cpdfDouble = vi.hoisted(() => ({
  api: null as null | {
    fromMemory(bytes: Uint8Array, password: string): object;
    toMemory(doc: object, linearize: boolean, compress: boolean): Uint8Array;
    deletePdf(doc: object): void;
  },
  unreachable: null as string | null,
}));

const repair = vi.hoisted(() => ({ throws: false }));

vi.mock('@/lib/pdf/engines/ghostscript', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/pdf/engines/ghostscript')>();
  return {
    ...real,
    ghostscript: async () => {
      if (gs.unreachable) throw new Error(gs.unreachable);
      return gs.live && !gs.stub
        ? real.ghostscript()
        : ({} as Awaited<ReturnType<typeof real.ghostscript>>);
    },
    run: async (
      args: string[],
      files: Record<string, Uint8Array>,
      options: { outputs?: string[] } = {},
    ) => {
      gs.calls.push(args.slice());
      if (gs.unreachable) throw new Error(gs.unreachable);
      if (gs.live && !gs.stub) return real.run(args, files, options);
      const out = options.outputs?.[0] ?? '/tmp/output.pdf';
      return {
        exitCode: 0,
        outputs: gs.reply ? { [out]: gs.reply } : {},
        log: [] as string[],
      };
    },
  };
});

vi.mock('@/lib/pdf/engines/provider', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/pdf/engines/provider')>();
  return {
    ...real,
    engines: {
      ...real.engines,
      // A directory, not a URL: the live block below loads `gs.js` through a
      // fetch stub and `gs.wasm` through Emscripten's own file read, and both
      // need the address in use to be a path (same trick as
      // `font-outline.test.ts`). The stand-in cases never touch it.
      getUrl: () => `${gs.dir}${path.sep}`,
    },
  };
});

vi.mock('@/lib/pdf/engines/cpdf', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/pdf/engines/cpdf')>();
  return {
    ...real,
    cpdf: async () => {
      if (cpdfDouble.unreachable) throw new Error(cpdfDouble.unreachable);
      if (!cpdfDouble.api) throw new Error('test double: no CoherentPDF api configured');
      return cpdfDouble.api;
    },
  };
});

vi.mock('@/lib/pdf-engine/commands', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/pdf-engine/commands')>();
  return {
    ...real,
    repairPDF: async (bytes: ArrayBuffer) => {
      if (repair.throws) throw new Error('test double: the local parser gave up');
      return real.repairPDF(bytes);
    },
  };
});

/**
 * A second catalogue, so the multi-file and two-engine shapes have a producer that
 * can be pointed at each file separately. The real registry is spread underneath, so
 * every other case in this file drives the shipped tool.
 */
const STANDS: Record<string, PdfToolDefinition> = {
  /** Two files out of one run: one from the engine, one from the local path. */
  'attr-mixed': {
    id: 'attr-mixed',
    name: 'Attribution Mixed Run',
    description: 'Two files, two producers',
    icon: '🧪',
    category: 'optimize',
    multiFile: true,
    engines: ['ghostscript', 'cpdf'],
    outputSuffix: '_mixed.pdf',
    async run() {
      const engine = await pdfBytes(2, 'from the engine');
      const local = await pdfBytes(2, 'from the local path');
      return {
        kind: 'files',
        files: [
          { blob: new Blob([engine as BlobPart], { type: 'application/pdf' }), producedBy: { via: 'engine', engine: 'cpdf' } },
          { blob: new Blob([local as BlobPart], { type: 'application/pdf' }), producedBy: { via: 'fallback', engine: 'ghostscript' } },
        ],
      };
    },
  },
  /** Declares two engines and uses the second one — what `engines[0]` could never say. */
  'attr-second-engine': {
    id: 'attr-second-engine',
    name: 'Attribution Second Engine',
    description: 'Uses the engine that is not first',
    icon: '🧪',
    category: 'optimize',
    engines: ['ghostscript', 'cpdf'],
    outputSuffix: '_second.pdf',
    async run() {
      return {
        kind: 'pdf',
        bytes: await pdfBytes(1, 'written by cpdf'),
        producedBy: { via: 'engine', engine: 'cpdf' },
      };
    },
  },
  /** Declares an engine, produces a file, and never says who wrote it. */
  'attr-silent': {
    id: 'attr-silent',
    name: 'Attribution Silent Run',
    description: 'Reports no producer',
    icon: '🧪',
    category: 'optimize',
    engines: ['ghostscript'],
    outputSuffix: '_silent.pdf',
    async run() {
      return { kind: 'pdf', bytes: await pdfBytes(1, 'nobody said') };
    },
  },
};

vi.mock('@/lib/pdf/tools/registry', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/pdf/tools/registry')>();
  return {
    ...real,
    getPdfTool: (id?: string | null) => (id && STANDS[id] ? STANDS[id] : real.getPdfTool(id)),
  };
});

/* ── fixtures ─────────────────────────────────────────────────────────────── */

/** A real, reopenable PDF with drawn text on every page. */
async function pdfBytes(pages: number, title: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pages; index++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`${title} — page ${index + 1} of the attribution fixture`, {
      x: 60,
      y: 700,
      size: 14,
      font,
      color: rgb(0, 0, 0),
    });
  }
  doc.setTitle(title);
  return doc.save({ useObjectStreams: false });
}

function pdfFileOf(bytes: Uint8Array, name: string): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });
}

async function run(toolId: string, files: File[], values: Record<string, unknown> = {}): Promise<RunOutcome> {
  return runPdfTool({ toolId, files, values, onProgress: () => {}, onLog: () => {} });
}

const enginePdf = () => pdfBytes(2, 'the engine wrote this');
/** Bytes that are not a PDF at all: the tool must refuse to keep them. */
const junkPdf = () => new TextEncoder().encode('%PDF-1.7\nnot really a document\n%%EOF');

beforeEach(() => {
  gs.reply = null;
  gs.unreachable = null;
  gs.calls = [];
  cpdfDouble.api = null;
  cpdfDouble.unreachable = null;
  repair.throws = false;
  gs.stub = true;
  resetEngines();
  useProcessStore.getState().reset();
});

afterEach(() => {
  resetEngines();
});

/* ── 1. the engine ran, and says so ───────────────────────────────────────── */

describe('an engine run credits itself, in bytes', () => {
  it('stamps the attribution on the file the engine wrote', async () => {
    const reply = await enginePdf();
    gs.reply = reply;
    const outcome = await run('pdf-to-pdfa', [pdfFileOf(await pdfBytes(2, 'input'), 'doc.pdf')], { part: '2b' });

    expect(outcome.outputs[0].producedBy).toEqual({ via: 'engine', engine: 'ghostscript' });
    // The claim is about *these* bytes: the file handed over is the one the engine
    // produced, not a re-save that quietly replaced it.
    const handed = new Uint8Array(await outcome.outputs[0].blob.arrayBuffer());
    expect(Buffer.from(handed).equals(Buffer.from(reply))).toBe(true);
    expect(outcome.message).toMatch(/with Ghostscript/);
  });

  it('says which engine ran when a tool declares two and uses the second', async () => {
    const outcome = await run('attr-second-engine', [pdfFileOf(await pdfBytes(1, 'in'), 'doc.pdf')]);
    expect(outcome.outputs[0].producedBy).toEqual({ via: 'engine', engine: 'cpdf' });
    const card = render(h(ResultCard, { outputs: items(outcome), declared: ['ghostscript', 'cpdf'] }));
    expect(card.getByText('cpdf')).toBeInTheDocument();
    // `engines[0]` was 'ghostscript': the old row printed that name for this run.
    expect(card.queryByText('Ghostscript')).not.toBeInTheDocument();
  });

  it('credits Ghostscript for the repair it actually did', async () => {
    // `repair` declares no engine — Ghostscript is its escalation, not its
    // requirement — so this is the one place the fact can come from.
    repair.throws = true;
    gs.reply = await enginePdf();
    const outcome = await run('repair', [pdfFileOf(new TextEncoder().encode('%PDF-1.7 broken'), 'broken.pdf')]);
    expect(outcome.outputs[0].producedBy).toEqual({ via: 'engine', engine: 'ghostscript' });
    expect(outcome.warnings.join(' ')).toMatch(/Ghostscript rebuilt this file/);
  });
});

/* ── 2. the engine did not, and the card stops saying it did ─────────────── */

describe('a fallback run refuses the engine’s name', () => {
  it('reports the local path when the engine never arrived', async () => {
    gs.unreachable = 'Failed to load Ghostscript: no address answered';
    const outcome = await run('pdf-to-pdfa', [pdfFileOf(await pdfBytes(2, 'input'), 'doc.pdf')], { part: '2b' });

    expect(outcome.outputs[0].producedBy).toEqual({ via: 'fallback', engine: 'ghostscript' });
    const card = render(
      h(ResultCard, { outputs: items(outcome), declared: ['ghostscript'], warnings: outcome.warnings }),
    );
    expect(card.getByText(/local path · Ghostscript not used/)).toBeInTheDocument();
    expect(card.queryByText('Ghostscript')).not.toBeInTheDocument();
    expect(outcome.message).not.toMatch(/with Ghostscript/);
    expect(outcome.message).toMatch(/this app’s own path, not Ghostscript/);
  });

  it('reports the local path when the engine ran and produced nothing', async () => {
    gs.reply = new Uint8Array(0);
    const outcome = await run('pdf-to-pdfa', [pdfFileOf(await pdfBytes(2, 'input'), 'doc.pdf')]);
    expect(gs.calls.length).toBe(1);
    expect(outcome.outputs[0].producedBy).toEqual({ via: 'fallback', engine: 'ghostscript' });
  });

  it('reports the local path when the tool discarded the engine’s file', async () => {
    // The honest hard case: Ghostscript ran and handed back bytes that do not
    // reopen, so the card may not call the output its work.
    gs.reply = await junkPdf();
    const outcome = await run('pdf-to-pdfa', [pdfFileOf(await pdfBytes(2, 'input'), 'doc.pdf')]);
    expect(outcome.outputs[0].producedBy).toEqual({ via: 'fallback', engine: 'ghostscript' });
    expect(outcome.warnings.join(' ')).toMatch(/does not reopen cleanly/);
    const local = new Uint8Array(await outcome.outputs[0].blob.arrayBuffer());
    expect(Buffer.from(local).equals(Buffer.from(gs.reply!))).toBe(false);
  });

  it('says the same thing for a CoherentPDF run that had to be rebuilt', async () => {
    cpdfDouble.api = fakeCpdf(await junkPdf());
    const outcome = await run('linearize-pdf', [pdfFileOf(await pdfBytes(2, 'input'), 'doc.pdf')]);
    expect(outcome.outputs[0].producedBy).toEqual({ via: 'fallback', engine: 'cpdf' });
    expect(outcome.warnings.join(' ')).toMatch(/does not reopen cleanly/);

    cpdfDouble.unreachable = 'Failed to load CoherentPDF: 404';
    const offline = await run('linearize-pdf', [pdfFileOf(await pdfBytes(2, 'input'), 'doc.pdf')]);
    expect(offline.outputs[0].producedBy).toEqual({ via: 'fallback', engine: 'cpdf' });
  });

  it('keeps an engine run credited when its file is kept but not linearized', async () => {
    // CoherentPDF ran, the file reopens, and `/Linearized` is simply absent: the
    // engine still wrote the bytes the user is handed, and the sentence says which.
    const kept = await enginePdf();
    cpdfDouble.api = fakeCpdf(kept);
    const outcome = await run('linearize-pdf', [pdfFileOf(await pdfBytes(2, 'input'), 'doc.pdf')]);
    expect(outcome.outputs[0].producedBy).toEqual({ via: 'engine', engine: 'cpdf' });
    expect(outcome.message).toMatch(/Rewritten by CoherentPDF/);
    expect(outcome.message).not.toMatch(/Linearized with CoherentPDF/);
  });

  it('claims nothing for a tool that refused outright', async () => {
    // `font-to-outline` has no degraded path: an engine that refuses ends the run
    // with no output, so there is no card to mislabel — and nothing may imply one.
    gs.unreachable = 'Failed to load Ghostscript: no address answered';
    let caught: unknown;
    try {
      await run('font-to-outline', [pdfFileOf(await pdfBytes(2, 'input'), 'doc.pdf')]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/could not be reached, so nothing was outlined/);
  });

  it('reports the engine for the outline it really drew', async () => {
    const reply = await enginePdf();
    gs.reply = reply;
    const outcome = await run('font-to-outline', [pdfFileOf(await pdfBytes(2, 'input'), 'doc.pdf')]);
    expect(outcome.outputs[0].producedBy).toEqual({ via: 'engine', engine: 'ghostscript' });
  });

  it('says core for a repair the local parser finished', async () => {
    const outcome = await run('repair', [pdfFileOf(await pdfBytes(2, 'input'), 'doc.pdf')]);
    expect(outcome.outputs[0].producedBy).toEqual({ via: 'core' });
    expect(gs.calls).toHaveLength(0);
  });
});

/* ── 3. per file, not per batch ───────────────────────────────────────────── */

describe('attribution is per output', () => {
  it('carries a different answer for each file of one run', async () => {
    const outcome = await run('attr-mixed', [
      pdfFileOf(await pdfBytes(1, 'a'), 'a.pdf'),
      pdfFileOf(await pdfBytes(1, 'b'), 'b.pdf'),
    ]);
    expect(outcome.outputs.map((output) => output.producedBy)).toEqual([
      { via: 'engine', engine: 'cpdf' },
      { via: 'fallback', engine: 'ghostscript' },
    ]);
    const summary = describeProvenance(items(outcome), ['ghostscript', 'cpdf']);
    expect(summary?.text).toMatch(/mixed/);
    const card = render(h(ResultCard, { outputs: items(outcome), declared: ['ghostscript', 'cpdf'] }));
    const rows = within(card.getByRole('region', { name: 'Result' })).getAllByRole('listitem');
    // Each file names its own producer beside its size; one label for the batch
    // would have to be wrong about at least one of them.
    expect(rows.map((row) => row.textContent).join(' ')).toMatch(/cpdf/);
    expect(rows.map((row) => row.textContent).join(' ')).toMatch(/local path · Ghostscript not used/);
  });

  it('says it was not told where a declared engine met a silent producer', async () => {
    const outcome = await run('attr-silent', [pdfFileOf(await pdfBytes(1, 'a'), 'a.pdf')]);
    expect(outcome.outputs[0].producedBy).toBeNull();
    const card = render(h(ResultCard, { outputs: items(outcome), declared: ['ghostscript'] }));
    expect(card.getByText('not reported')).toBeInTheDocument();
  });

  it('prints no row at all for a tool that has no engine to speak of', () => {
    const outputs = [resultItem('plain.pdf', { via: 'core' })];
    const card = render(h(ResultCard, { outputs }));
    expect(card.queryByText('not reported')).not.toBeInTheDocument();
    expect(describeProvenance([resultItem('plain.pdf', null)], [])).toBeNull();
  });
});

/* ── 4. the plumbing that carries it ──────────────────────────────────────── */

describe('the run’s answer reaches the screen as data', () => {
  it('travels beside each output through the process store', async () => {
    gs.reply = await enginePdf();
    const outcome = await run('pdf-to-pdfa', [pdfFileOf(await pdfBytes(2, 'input'), 'doc.pdf')]);
    const store = useProcessStore.getState();
    outcome.outputs.forEach((output, index) => {
      store.setOutput(output.blob, `blob:${index}`, output.name, output.producedBy);
    });
    const live = useProcessStore.getState();
    expect(live.outputSources).toEqual([{ via: 'engine', engine: 'ghostscript' }]);
    live.addOutput(outcome.outputs[0].blob, 'blob:extra', 'second.pdf', { via: 'fallback', engine: 'ghostscript' });
    expect(useProcessStore.getState().outputSources).toEqual([
      { via: 'engine', engine: 'ghostscript' },
      { via: 'fallback', engine: 'ghostscript' },
    ]);
    // A new run starts with no answers, not with the last file’s.
    useProcessStore.getState().startProcessing('Next', '_next.pdf');
    expect(useProcessStore.getState().outputSources).toEqual([]);
  });

  it('words each producer, and marks only the fallback as a warning', () => {
    expect(describeSource({ via: 'engine', engine: 'ghostscript' })).toEqual({ text: 'Ghostscript', warn: false });
    expect(describeSource({ via: 'core' })).toEqual({ text: 'local path · no engine', warn: false });
    expect(describeSource({ via: 'fallback', engine: 'cpdf' })).toEqual({
      text: 'local path · cpdf not used',
      warn: true,
    });
  });

  it('leaves no engine-backed tool guessing', async () => {
    // The four tools whose bytes can come from an engine, in both states each of
    // them can reach. A tool that answers `null` here is a tool whose card would
    // read "not reported", and that is the regression this file exists to stop.
    const source = await pdfBytes(2, 'input');
    gs.reply = await enginePdf();
    const engineRun = await run('pdf-to-pdfa', [pdfFileOf(source, 'doc.pdf')]);
    const outlineRun = await run('font-to-outline', [pdfFileOf(source, 'doc.pdf')]);
    cpdfDouble.api = fakeCpdf(await enginePdf());
    const linearRun = await run('linearize-pdf', [pdfFileOf(source, 'doc.pdf')]);
    const repairRun = await run('repair', [pdfFileOf(source, 'doc.pdf')]);
    expect([
      engineRun.outputs[0].producedBy,
      outlineRun.outputs[0].producedBy,
      linearRun.outputs[0].producedBy,
      repairRun.outputs[0].producedBy,
    ]).toEqual([
      { via: 'engine', engine: 'ghostscript' },
      { via: 'engine', engine: 'ghostscript' },
      { via: 'engine', engine: 'cpdf' },
      { via: 'core' },
    ]);

    gs.unreachable = 'Failed to load Ghostscript: no address answered';
    cpdfDouble.unreachable = 'Failed to load CoherentPDF: no address answered';
    resetEngines();
    const offline = await run('pdf-to-pdfa', [pdfFileOf(source, 'doc.pdf')]);
    const offlineLinear = await run('linearize-pdf', [pdfFileOf(source, 'doc.pdf')]);
    expect(offline.outputs[0].producedBy).toEqual({ via: 'fallback', engine: 'ghostscript' });
    expect(offlineLinear.outputs[0].producedBy).toEqual({ via: 'fallback', engine: 'cpdf' });
  });
});

/* ── 5. the published engine, when it is on disk ──────────────────────────── */

beforeAll(async () => {
  // Same gating as `font-outline.test.ts`: a 15 MB download belongs where a person
  // is, and on CI only when asked for with `BROWSERSNIP_GS=live`.
  const wanted = process.env.BROWSERSNIP_GS === 'live' || (process.env.BROWSERSNIP_GS !== 'off' && !process.env.CI);
  if (!wanted) return;
  try {
    for (const file of ['gs.js', 'gs.wasm']) {
      if (!fs.existsSync(path.join(gs.dir, file))) return;
    }
  } catch {
    return;
  }
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const requested = String(input).replace(/^https?:\/\/[^/]+/, '');
    return new Response(fs.readFileSync(path.join(gs.dir, path.basename(requested))));
  });
  URL.createObjectURL = (() => `file://${path.join(gs.dir, 'gs.js')}`) as typeof URL.createObjectURL;
  gs.live = true;
}, 240_000);

afterAll(() => {
  gs.live = false;
  vi.unstubAllGlobals();
});

describe('pdf-to-pdfa over the published Ghostscript build', () => {
  it('hands over the engine’s file and prints the catalogue it carries', async (ctx) => {
    if (!gs.live) ctx.skip('the Ghostscript WASM build is not cached here; run with BROWSERSNIP_GS=live');
    gs.stub = false;
    const source = await pdfBytes(2, 'the live attribution probe');
    const outcome = await run('pdf-to-pdfa', [pdfFileOf(source, 'type.pdf')], { part: '2b' });
    const bytes = new Uint8Array(await outcome.outputs[0].blob.arrayBuffer());
    expect(outcome.outputs[0].producedBy).toEqual({ via: 'engine', engine: 'ghostscript' });
    // Ghostscript wrote this file: its producer string is in it, and the tool says so.
    expect(Buffer.from(bytes).toString('latin1')).toMatch(/GPL Ghostscript [0-9.]+/);
    // …and the finding the label used to hide is measured, not quoted: this build's
    // `-dPDFA=2` run identifies the file without giving it the output intent PDF/A
    // asks for, so the card may not lean on the word "converted" alone.
    const doc = await openPDF(bytes, { ignoreEncryption: true, updateMetadata: false });
    expect(doc.catalog.get(PDFName.of('OutputIntents'))).toBeUndefined();
    expect(outcome.message).toMatch(/no output intent in the catalogue/);
    console.log(`[attribution] engine ${bytes.byteLength} B, producer GPL Ghostscript, /OutputIntents absent`);
    fs.writeFileSync('/tmp/attr-live-engine.pdf', bytes);
  }, 240_000);

  it('prints a different file, and a different answer, when the engine is refused', async (ctx) => {
    if (!gs.live) ctx.skip('the Ghostscript WASM build is not cached here; run with BROWSERSNIP_GS=live');
    gs.stub = false;
    const source = await pdfBytes(2, 'the live attribution probe');
    gs.unreachable = 'Failed to load Ghostscript: the CDN is not contacted from this rig';
    resetEngines();
    const outcome = await run('pdf-to-pdfa', [pdfFileOf(source, 'type.pdf')], { part: '2b' });
    const bytes = new Uint8Array(await outcome.outputs[0].blob.arrayBuffer());
    expect(outcome.outputs[0].producedBy).toEqual({ via: 'fallback', engine: 'ghostscript' });
    expect(Buffer.from(bytes).toString('latin1')).not.toMatch(/GPL Ghostscript/);
    const doc = await openPDF(bytes, { ignoreEncryption: true, updateMetadata: false });
    expect(doc.catalog.get(PDFName.of('OutputIntents'))).toBeDefined();
    console.log(`[attribution] fallback ${bytes.byteLength} B, /OutputIntents present`);
    fs.writeFileSync('/tmp/attr-live-fallback.pdf', bytes);
  }, 240_000);
});

/* ── helpers ──────────────────────────────────────────────────────────────── */

function resultItem(name: string, producedBy: ByteSource | null): ResultItem {
  return { name, blob: new Blob(['%PDF-1.7'], { type: 'application/pdf' }), producedBy };
}

function items(outcome: RunOutcome): ResultItem[] {
  return outcome.outputs.map((output) => ({ name: output.name, blob: output.blob, producedBy: output.producedBy }));
}

/** A stand-in for `window.coherentpdf`, holding only what `linearizeWithCpdf` calls. */
function fakeCpdf(reply: Uint8Array) {
  const handle = { cpdf: true };
  return {
    fromMemory: () => handle,
    toMemory: () => reply,
    deletePdf: () => {},
  } as unknown as NonNullable<typeof cpdfDouble.api>;
}
