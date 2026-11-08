/**
 * The surfaces M4 owns, and the two hangs that made them lie.
 *
 * A stalled wait is the worst failure this app can ship: the pane keeps its
 * spinner, says nothing, and the user has no way to tell slow from dead. Both
 * stalls live behind tools a person clicks —
 *  - `core/images.loadBitmap` awaited an `<img>` load that never fires when
 *    `createImageBitmap` is missing, so every image-backed tool hung;
 *  - `engines/auto.ensureEngine` awaited a CDN download with no bound at all,
 *    so every engine-backed tool hung.
 * The scan-to-pdf hang that started this was the first one, reached because the
 * runner let a PDF get as far as the image decoder. A tool now refuses on the
 * *kind* of file, or on the absence of pane state, before it does any work.
 *
 * jsdom has no canvas, so nothing here inspects pixels: the assertions are about
 * settling, geometry, counts and copy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from '@maxwbh/pdf-lib';
import { ToolInputError, inspectPdf } from '@/lib/pdf/core/guard';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import {
  getPdfTool,
  hasCustomMainView,
  mainViewFor,
} from '@/lib/pdf/tools/registry';

/* ── engine doubles: a CDN that answers, and a CDN that never does ─────────── */

const loaders = vi.hoisted(() => ({
  ghostscript: vi.fn<() => Promise<unknown>>(),
  cpdf: vi.fn<() => Promise<unknown>>(),
  pymupdf: vi.fn<() => Promise<unknown>>(),
  /** Stands in for Ghostscript's `run`, so a provisioned engine can "convert". */
  gsRun: vi.fn<
    () => Promise<{
      exitCode: number;
      outputs: Record<string, Uint8Array>;
      log: string[];
    }>
  >(),
}));

vi.mock('@/lib/pdf/engines/ghostscript', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@/lib/pdf/engines/ghostscript')>();
  return { ...real, ghostscript: loaders.ghostscript, run: loaders.gsRun };
});
vi.mock('@/lib/pdf/engines/cpdf', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/pdf/engines/cpdf')>();
  return { ...real, cpdf: loaders.cpdf, loadCpdf: loaders.cpdf };
});
vi.mock('@/lib/pdf/engines/pymupdf', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@/lib/pdf/engines/pymupdf')>();
  return { ...real, pymupdf: loaders.pymupdf };
});

/**
 * The tool's own engine call, with a short bound instead of the default two
 * minutes, so the run under test exercises the real `auto.ts` timeout path
 * rather than a hand-written failure.
 */
vi.mock('@/lib/pdf/core/engine-ops', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@/lib/pdf/core/engine-ops')>();
  const auto = await import('@/lib/pdf/engines/auto');
  const provider = await import('@/lib/pdf/engines/provider');
  const stall = async (engine: 'cpdf' | 'ghostscript') => {
    const provision = await auto.ensureEngine(engine, { timeoutMs: 25 });
    if (!provision.ok)
      throw new provider.EngineUnavailable(engine, provision.reason);
    return provision.module;
  };
  return {
    ...real,
    linearizeWithCpdf: async () => {
      await stall('cpdf');
      return new Uint8Array(0);
    },
  };
});

import {
  ENGINE_PROVISION_TIMEOUT_MS,
  engineLoaded,
  ensureEngine,
  resetEngines,
} from '@/lib/pdf/engines/auto';

/** A promise that never settles, like a request a proxy has swallowed. */
const never = () => new Promise<unknown>(() => {});

async function pdfFile(name = 'contract.pdf', pages = 1): Promise<File> {
  const doc = await PDFDocument.create();
  for (let index = 0; index < pages; index++) doc.addPage([595, 842]);
  const bytes = await doc.save();
  return new File([bytes as BlobPart], name, { type: 'application/pdf' });
}

const TINY_JPEG = Uint8Array.from(
  Buffer.from(
    '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDs0NDL/wAALCAABAAEBAREA/8QAFAABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AmAA/9k=',
    'base64',
  ),
);

beforeEach(() => {
  resetEngines();
  loaders.ghostscript.mockReset();
  loaders.cpdf.mockReset();
  loaders.pymupdf.mockReset();
  loaders.gsRun.mockReset();
});

/* ══ 1. provisioning cannot hang a run ═════════════════════════════════════ */

describe('engine provisioning is bounded', () => {
  it('a loader that never resolves still settles, with a reason that names the engine, the host and the wait', async () => {
    loaders.ghostscript.mockReturnValue(never());
    const provision = await ensureEngine('ghostscript', { timeoutMs: 30 });
    expect(provision.ok).toBe(false);
    if (!provision.ok) {
      expect(provision.reason).toMatch(
        /Ghostscript did not finish loading from .* within 1s/,
      );
      expect(provision.reason).toMatch(/run again/i);
      expect(provision.reason).toMatch(/skipped/i);
    }
    expect(engineLoaded('ghostscript')).toBe(false);
  });

  it('gives up on the wait without starting a second download of the same module', async () => {
    loaders.cpdf.mockReturnValue(never());
    const first = await ensureEngine('cpdf', { timeoutMs: 20 });
    const second = await ensureEngine('cpdf', { timeoutMs: 20 });
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    // One stalled fetch, two honest timeouts — not two 15 MB attempts.
    expect(loaders.cpdf).toHaveBeenCalledTimes(1);
  });

  it('settles at once when the run is cancelled while the engine downloads', async () => {
    loaders.pymupdf.mockReturnValue(never());
    const controller = new AbortController();
    controller.abort();
    const provision = await ensureEngine('pymupdf', {
      signal: controller.signal,
    });
    expect(provision.ok).toBe(false);
    if (!provision.ok) expect(provision.reason).toMatch(/cancelled/i);
  });

  it('defaults to a bound a slow 54 MB fetch can still meet, and never to "forever"', () => {
    expect(ENGINE_PROVISION_TIMEOUT_MS).toBeGreaterThan(0);
    expect(ENGINE_PROVISION_TIMEOUT_MS).toBeLessThan(5 * 60_000);
  });

  it('a run whose engine never arrives comes back degraded and says what was skipped', async () => {
    // `linearize-pdf` has a local fallback, which is exactly the case the brief
    // demands an honest sentence for: the run finishes, and admits what it did
    // not do.
    loaders.cpdf.mockReturnValue(never());
    const outcome = await runPdfTool({
      toolId: 'linearize-pdf',
      files: [await pdfFile()],
      values: {},
    });
    const warnings = outcome.warnings.join(' ');
    expect(warnings).toMatch(/CoherentPDF could not be reached/);
    expect(warnings).toMatch(/did not finish loading from [^ ]+ within \d+s/);
    expect(warnings).toMatch(/not linearized|not a conforming linearized PDF/i);
    expect(outcome.outputs.length).toBe(1);
    expect(loaders.cpdf).toHaveBeenCalledTimes(1);
  }, 30_000);
});

/* ══ 2. an image decode cannot hang a run ══════════════════════════════════ */

describe('image decode always settles', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('a browser without createImageBitmap whose <img> never loads gets a named error, not a spinner', async () => {
    vi.stubGlobal('createImageBitmap', undefined);
    // Never fires `onload` or `onerror`: the case that used to await forever.
    vi.stubGlobal(
      'Image',
      class {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_value: string) {}
      },
    );
    const { decodeImage, ImageDecodeError, IMAGE_DECODE_TIMEOUT_MS } =
      await import('@/lib/pdf/core/images');
    expect(IMAGE_DECODE_TIMEOUT_MS).toBeGreaterThan(0);
    const error = await decodeImage(TINY_JPEG, {
      mime: 'image/webp',
      name: 'fax-01.webp',
      decodeTimeoutMs: 40,
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ImageDecodeError);
    expect((error as Error).message).toContain('fax-01.webp');
    expect((error as Error).message).toMatch(/did not finish decoding after/);
  });

  it('a browser with no image decoder at all refuses by name instead of waiting', async () => {
    vi.stubGlobal('createImageBitmap', undefined);
    vi.stubGlobal('Image', undefined);
    const { decodeImage, ImageDecodeError } =
      await import('@/lib/pdf/core/images');
    const HEIC = Uint8Array.from([
      0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
    ]);
    const error = await decodeImage(HEIC, {
      mime: 'image/heic',
      name: 'holiday.heic',
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ImageDecodeError);
    expect((error as Error).message).toMatch(/no image decoder for HEIC\/HEIF/);
    expect((error as Error).message).toMatch(/PNG or JPEG/);
    expect((error as Error).message).toContain('holiday.heic');
  });

  it('an <img> that answers "no" is reported, not retried into silence', async () => {
    vi.stubGlobal('createImageBitmap', undefined);
    vi.stubGlobal(
      'Image',
      class {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_value: string) {
          // The load event never arrives, only the error event.
          setTimeout(() => this.onerror?.(), 0);
        }
      },
    );
    const { decodeImage, ImageDecodeError } =
      await import('@/lib/pdf/core/images');
    const error = await decodeImage(TINY_JPEG, {
      mime: 'image/webp',
      name: 'meme.webp',
      decodeTimeoutMs: 500,
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ImageDecodeError);
    expect((error as Error).message).toContain('meme.webp');
  });
});

/* ══ 3. refusal comes before the work, in the right words ══════════════════ */

describe('the runner refuses the two different problems separately', () => {
  it('a wrong *format* is named as a format problem, with no pane language, on a plain image tool', async () => {
    const mislabelled = new File(
      [await (await pdfFile()).arrayBuffer()],
      'notes.jpg',
      {
        type: 'image/jpeg',
      },
    );
    const error = (await runPdfTool({
      toolId: 'jpg-to-pdf',
      files: [mislabelled],
      values: {},
    }).catch((err: unknown) => err)) as ToolInputError;
    expect(error).toBeInstanceOf(ToolInputError);
    expect(error.message).toMatch(/"notes\.jpg" is a PDF, not a picture/);
    expect(error.message).not.toMatch(/pane/i);
    expect(error.hint).toMatch(/Add the image you meant/);
  });

  it('a pane tool names its own pane as the remedy, because that is where the fix is', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([595, 842]);
    const bytes = await doc.save();
    const started = Date.now();
    const error = (await runPdfTool({
      toolId: 'scan-to-pdf',
      files: [
        new File([bytes as BlobPart], 'contract.pdf', {
          type: 'application/pdf',
        }),
      ],
      values: {},
    }).catch((err: unknown) => err)) as ToolInputError;
    // The headline defect: this call used to hang forever on the image decoder.
    expect(Date.now() - started).toBeLessThan(2000);
    expect(error.message).toMatch(/is a PDF, not a picture/);
    expect(error.message).toMatch(/its own editor pane/);
    expect(error.hint).toMatch(/Capture a page with the camera/);
  });

  it('a real photograph still reaches the scan path, so the guard is not over-refusing', async () => {
    const outcome = await runPdfTool({
      toolId: 'scan-to-pdf',
      files: [new File([TINY_JPEG], 'photo-01.jpg', { type: 'image/jpeg' })],
      values: {},
    });
    expect(outcome.outputs).toHaveLength(1);
    expect(outcome.message).toMatch(/Built a 1 page PDF/);
  });

  it('right kind of input but no pane state refuses before the tool does anything', async () => {
    const file = await pdfFile();
    const cases: Array<[string, RegExp]> = [
      [
        'sign',
        /Sign PDF needs a signature placed on the page from its own editor pane/,
      ],
      ['pdf-crop', /Crop PDF needs a crop rectangle from its own editor pane/],
    ];
    for (const [id, expected] of cases) {
      const started = Date.now();
      const error = (await runPdfTool({
        toolId: id,
        files: [file],
        values: {},
      }).catch((err: unknown) => err)) as ToolInputError;
      expect(error.message, id).toMatch(expected);
      expect(Date.now() - started, id).toBeLessThan(1500);
    }
  });

  it('too few documents for a pane tool says how many it needs and where they go', async () => {
    const file = await pdfFile();
    const one = runPdfTool({ toolId: 'compare', files: [file], values: {} });
    await expect(one).rejects.toThrow(
      /at least 2 files from its own editor pane — 1 added/,
    );
    const three = runPdfTool({
      toolId: 'compare',
      files: [file, file, file],
      values: {},
    });
    await expect(three).rejects.toThrow(
      /at most 2 files from its own editor pane/,
    );
    // An empty queue still asks for a file, not for a pane.
    expect(
      runPdfTool({ toolId: 'compare', files: [], values: {} }),
    ).rejects.toThrow(/Add a PDF first/);
  });

  it('a mislabelled PDF is still refused by the pre-flight guard (E2)', async () => {
    expect((await inspectPdf(TINY_JPEG, 'photo-01.jpg')).error).toBe(
      'NOT_A_PDF',
    );
  });
});

/* ══ 4. redaction: text geometry, and an empty drag that creates nothing ═══ */

describe('redact marks words, not rectangles', () => {
  it('snaps a drag to the text lines it touched, as one mark carrying one box per line', async () => {
    const { redactionFromLines } =
      await import('@/components/tools/pdf/security/RedactMain');
    const snapped = redactionFromLines(
      [
        { x0: 40, y0: 100, x1: 300, y1: 112, text: 'the account number is' },
        { x0: 40, y0: 120, x1: 210, y1: 132, text: 'hidden from view' },
      ],
      { width: 595, height: 842 },
    );
    expect(snapped).not.toBeNull();
    const lines = snapped!.lines;
    expect(lines).toHaveLength(2);
    // One mark: the bounding box spans both lines and nothing else.
    expect(snapped!.box.y).toBeCloseTo(1 - 132 / 842, 6);
    expect(snapped!.box.h).toBeCloseTo((132 - 100) / 842, 6);
    // Each line keeps its own width, so the leading between them stays visible.
    expect(lines[0].w).toBeGreaterThan(lines[1].w * 1.3);
  });

  it('a drag that caught no words creates nothing at all', async () => {
    const { redactionFromLines } =
      await import('@/components/tools/pdf/security/RedactMain');
    expect(redactionFromLines([], { width: 595, height: 842 })).toBeNull();
    expect(redactionFromLines([], { width: 0, height: 0 })).toBeNull();
  });

  it('writes one region per line, in the engine’s own frame', async () => {
    const { redactionRegions } =
      await import('@/components/tools/pdf/security/RedactMain');
    const regions = redactionRegions(
      {
        id: 'r-1',
        page: 2,
        x: 0.1,
        y: 0.5,
        w: 0.4,
        h: 0.05,
        lines: [
          { x: 0.1, y: 0.5, w: 0.4, h: 0.02 },
          { x: 0.1, y: 0.47, w: 0.25, h: 0.02 },
        ],
      },
      { width: 595, height: 842 },
    );
    expect(regions).toHaveLength(2);
    expect(regions[1]).toEqual({
      page: 1,
      x: 60,
      y: Math.round(0.47 * 842),
      width: Math.round(0.25 * 595),
      height: Math.round(0.02 * 842),
    });
  });

  it('moving a mark takes its lines with it, so the boxes stay on the words', async () => {
    const { translateLines } =
      await import('@/components/tools/pdf/security/RedactMain');
    const moved = translateLines(
      [{ x: 0.9, y: 0.1, w: 0.05, h: 0.02 }],
      0.5,
      0.5,
    );
    expect(moved[0].x).toBeCloseTo(0.95, 6);
    expect(moved[0].y).toBeCloseTo(0.6, 6);
    const clamped = translateLines(
      [{ x: 0.1, y: 0.1, w: 0.9, h: 0.02 }],
      -0.5,
      -0.5,
    );
    expect(clamped[0].x).toBe(0);
    expect(clamped[0].y).toBe(0);
  });

  it('the tool sends the lines it was given and says the text is deleted, not covered', async () => {
    const tool = getPdfTool('redact');
    expect(`${tool?.promise ?? ''} ${tool?.notes?.join(' ') ?? ''}`).toMatch(
      /deleted from the page content/i,
    );
    expect(tool?.fields?.map((field) => field.key)).toContain('regions');
  });
});

/* ══ 5. compare: counts a user can check, and an honest "no differences" ═══ */

describe('compare reports differences as areas', () => {
  const mask = (
    width: number,
    height: number,
    blocks: Array<[number, number]>,
  ) => {
    const flags = new Uint8Array(width * height);
    for (const [x, y] of blocks) flags[y * width + x] = 1;
    return flags;
  };

  it('counts two edits in opposite corners as two areas and one edit as one', async () => {
    const { countDiffRegions } =
      await import('@/components/tools/pdf/security/CompareMain');
    expect(
      countDiffRegions(
        mask(400, 400, [
          [10, 10],
          [12, 12],
        ]),
        400,
        400,
      ),
    ).toBe(1);
    expect(
      countDiffRegions(
        mask(400, 400, [
          [10, 10],
          [380, 380],
        ]),
        400,
        400,
      ),
    ).toBe(2);
    expect(countDiffRegions(mask(400, 400, []), 400, 400)).toBe(0);
  });

  it('keeps the diff mask honest about its own size', async () => {
    const { countDiffRegions } =
      await import('@/components/tools/pdf/security/CompareMain');
    expect(countDiffRegions(new Uint8Array(4), 10, 10)).toBe(0);
  });

  it('no-difference is stated as a result, and the pane still offers the export', async () => {
    const notes = (getPdfTool('compare')?.notes ?? []).join(' ');
    expect(notes).toMatch(/pixels/i);
    expect(notes).toMatch(/shorter/i);
    const source = await import('@/components/tools/pdf/security/CompareTool');
    expect(source.CompareTool).toBeTypeOf('function');
    const text = await import('node:fs').then((fs) =>
      fs.readFileSync(
        'src/components/tools/pdf/security/CompareTool.tsx',
        'utf8',
      ),
    );
    expect(text).toMatch(/will still be written, with no marks on it/);
  });

  it('names a changed area by its own edges, not by the grid that grouped it', async () => {
    const { diffAreasOf } = await import('@/components/tools/pdf/security/CompareMain');
    // A 30×10 block starting at 5,7: joined on a 16 px grid, but bounded exactly.
    const block = new Uint8Array(400 * 400);
    for (let y = 7; y < 17; y++) for (let x = 5; x < 35; x++) block[y * 400 + x] = 1;
    expect(diffAreasOf(block, 400, 400)).toEqual([{ x0: 5, y0: 7, x1: 35, y1: 17 }]);
    // Two blocks sharing a row are two areas: the per-row `break` this function
    // replaced saw only the left one, and reported one.
    const pair = new Uint8Array(400 * 400);
    for (let y = 40; y < 50; y++) {
      for (let x = 10; x < 30; x++) pair[y * 400 + x] = 1;
      for (let x = 200; x < 220; x++) pair[y * 400 + x] = 1;
    }
    expect(diffAreasOf(pair, 400, 400).map((a) => [a.x0, a.x1])).toEqual([[10, 30], [200, 220]]);
  });

  it('keeps both sheets mounted while the pair loads, so a verdict needs pixels', async () => {
    const main = await import('node:fs').then((fs) =>
      fs.readFileSync('src/components/tools/pdf/security/CompareMain.tsx', 'utf8'),
    );
    // The loading state is an overlay inside the scroller. When it *replaced* the
    // sheets, the first comparison reached for a canvas that was not in the DOM,
    // threw inside a `catch {}`, and published 0 changed pixels as an all-clear.
    expect(main).toMatch(/data-compare-loading/);
    expect(main).not.toMatch(/^\s*if \(loading\) \{$/m);
    // And "nothing has been compared" is now a third answer, not a synonym for
    // "the two pages are equal".
    expect(main).toMatch(/Neither page has been read yet/);
    expect(main).toMatch(/data-compare-read=\{st\.compared\}/);
  });

  it('promises only what the shipped compare page demonstrably does', () => {
    const entry = getPdfTool('compare-pdfs');
    const legacy = getPdfTool('compare');
    // The old promise sold "a page-by-page report … with a picture of each changed
    // area when you compare pixels". The route mounts the pane and this entry's own
    // panel — no rail form, so no Pixels / Text segment to set — and the `run` that
    // would write that report collects each overlay into `images` and returns
    // without them. Both halves are pinned in `tests/pdf/compare-diff.test.ts`.
    expect(`${entry?.promise} ${entry?.description}`).not.toMatch(/picture of each changed area/i);
    expect(entry?.promise).toMatch(/side by side/i);
    expect(entry?.promise).toMatch(/points/i);
    expect((entry?.notes ?? []).join(' ')).toMatch(/the page in view/i);
    expect((entry?.notes ?? []).join(' ')).toMatch(/every page both files have/i);
    // "Highlight every difference" is contradicted by the tool's own threshold.
    expect(legacy?.description).not.toMatch(/every difference/i);
    expect(legacy?.description).toMatch(/sensitivity/i);
  });
});

/* ══ 6. crop: keyboard parity, clamps, and a refusal to keep nothing ═══════ */

describe('crop stays inside the page and off the pointer', () => {
  it('an arrow press moves one edge and can never collapse the kept rectangle', async () => {
    const { MIN_KEPT_FRAC, nudgeEdge } =
      await import('@/components/tools/pdf/edit/cropModel');
    const base = { top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 };
    const taken = nudgeEdge(base, 'top', 5);
    expect(taken.top).toBeCloseTo(1 - base.bottom - MIN_KEPT_FRAC, 6);
    expect(taken.top + taken.bottom).toBeLessThan(1);
    expect(nudgeEdge(base, 'left', -5).left).toBe(0);
  });

  it('sliding keeps the size and never leaves the page', async () => {
    const { slideRect } = await import('@/components/tools/pdf/edit/cropModel');
    const rect = { top: 0.2, right: 0.3, bottom: 0.1, left: 0.05 };
    const moved = slideRect(rect, 0.02, 0.01);
    expect(moved.left + moved.right).toBeCloseTo(rect.left + rect.right, 6);
    expect(moved.top + moved.bottom).toBeCloseTo(rect.top + rect.bottom, 6);
    const off = slideRect(rect, -1, -1);
    expect(off.left).toBe(0);
    expect(off.top).toBe(0);
  });

  it('a crop that takes the whole page is refused, and one that takes nothing says so', async () => {
    const { describeCrop, targetPage } =
      await import('@/components/tools/pdf/edit/cropModel');
    const page = targetPage(0, 595, 842, 0);
    const all = describeCrop({
      rect: { top: 0.6, right: 0.1, bottom: 0.6, left: 0.1 },
      preview: page,
      targets: [1],
      numPages: 1,
      allPages: true,
    });
    expect(all.valid).toBe(false);
    expect(all.notes.join(' ')).toMatch(/removes the whole page/);
    const none = describeCrop({
      rect: { top: 0, right: 0, bottom: 0, left: 0 },
      preview: page,
      targets: [1],
      numPages: 1,
      allPages: true,
    });
    expect(none.notes.join(' ')).toMatch(/all four margins are zero/);
  });

  it('the handles are buttons with direction-correct cursors and a grab area over 8 px', async () => {
    const fs = await import('node:fs');
    const text = fs.readFileSync(
      'src/components/tools/pdf/edit/CropMain.tsx',
      'utf8',
    );
    expect(text).toMatch(/data-crop-handle="se"[\s\S]{0,400}nwse-resize/);
    expect(text).toMatch(/data-crop-handle="nw"[\s\S]{0,400}nwse-resize/);
    expect(text).toMatch(/data-crop-handle="n"[\s\S]{0,400}ns-resize/);
    expect(text).toMatch(/data-crop-handle="w"[\s\S]{0,400}ew-resize/);
    expect(text).toMatch(/<button[^>]*data-crop-handle/);
    const slop =
      /const handleSize = (\d+);[\s\S]*?const handleSlop = (\d+);/.exec(text);
    expect(slop).not.toBeNull();
    const [, size, pad] = slop!;
    expect(Number(size) + Number(pad) * 2).toBeGreaterThanOrEqual(20);
  });

  it('the crop pane, not the generic rail, is what renders for pdf-crop', () => {
    expect(hasCustomMainView('pdf-crop')).toBe(true);
    expect(mainViewFor('pdf-crop')).toBeDefined();
  });
});

/* ══ 7. forms: autosave, required feedback, and a form with no fields ══════ */

describe('the form panes keep answers and refuse to fake a result', () => {
  const key = 'browsersnip:form-draft:v1:tax-2025.pdf:20480';

  afterEach(() => {
    localStorage?.removeItem(key);
  });

  it('stores only the answers the file does not already carry, and reads them back', async () => {
    const forms = await import('@/components/tools/pdf/edit/FormFillMain');
    expect(forms.draftKeyFor({ name: 'tax-2025.pdf', size: 20480 })).toBe(key);
    const original = { 'form.name': '', 'form.due': '0' };
    const values = { 'form.name': 'Ada Lovelace', 'form.due': '0' };
    const entries = forms.draftEntries(values, original);
    expect(Object.keys(entries)).toEqual(['form.name']);
    expect(forms.writeDraft(key, entries)).toBe(true);
    expect(forms.readDraft(key)).toEqual(entries);
    expect(forms.mergeDraft(original, forms.readDraft(key))).toEqual(values);
  });

  it('a draft is scoped to this file, survives a reload, and says what it is', async () => {
    const forms = await import('@/components/tools/pdf/edit/FormFillMain');
    forms.writeDraft(key, { 'form.name': 'Ada' });
    expect(forms.readDraft('browsersnip:form-draft:v1:other.pdf:1')).toBeNull();
    expect(forms.draftSummary(2, true)).toMatch(
      /2 answers autosaved in this browser/,
    );
    expect(forms.draftSummary(2, false)).toMatch(/will not keep a draft/);
    forms.removeDraft(key);
    expect(forms.readDraft(key)).toBeNull();
  });

  it('garbage in storage is dropped, and an oversized draft is skipped rather than thrown on', async () => {
    const forms = await import('@/components/tools/pdf/edit/FormFillMain');
    localStorage.setItem(key, '{"broken":');
    expect(forms.readDraft(key)).toBeNull();
    localStorage.setItem(key, '[1,2,3]');
    expect(forms.readDraft(key)).toBeNull();
    expect(
      forms.writeDraft(key, { huge: 'x'.repeat(forms.FORM_DRAFT_BYTE_LIMIT) }),
    ).toBe(false);
  });

  it('required feedback waits for the field to be left, never fires on the first keystroke', async () => {
    const forms = await import('@/components/tools/pdf/edit/FormFillMain');
    const field = {
      name: 'form.sig',
      type: 'text' as const,
      page: 0,
      rect: { x: 0, y: 0, width: 40, height: 12 },
      required: true,
      readOnly: false,
      multiline: false,
      maxLen: 0,
      value: '',
      options: [],
      alternateName: '',
    };
    const touchedEmpty = new Set(['form.sig']);
    expect(forms.showRequired(field, { 'form.sig': '' }, new Set())).toBe(
      false,
    );
    expect(forms.showRequired(field, { 'form.sig': '' }, touchedEmpty)).toBe(
      true,
    );
    expect(
      forms.showRequired(field, { 'form.sig': 'signed' }, touchedEmpty),
    ).toBe(false);
    expect(
      forms.showRequired(
        { ...field, required: false },
        { 'form.sig': '' },
        touchedEmpty,
      ),
    ).toBe(false);
  });

  it('a file with no fields is said out loud, and Save is off rather than exporting a copy', async () => {
    const fs = await import('node:fs');
    const text = fs.readFileSync(
      'src/components/tools/pdf/edit/FormFillMain.tsx',
      'utf8',
    );
    expect(text).toMatch(/no form fields, so there is nothing to fill/);
    expect(text).toMatch(/fillable\.length === 0\}/);
    expect(text).toMatch(/This PDF has no fillable field to write/);
    expect(text).toMatch(/Add fields/);
  });

  it('the creator refuses an unnamed or unusable field before it can write a broken form', async () => {
    const creator = await import('@/components/tools/pdf/edit/FormCreatorMain');
    const draft = {
      id: 'd1',
      page: 0,
      type: 'text' as const,
      rect: { x: 0, y: 0, width: 60, height: 14 },
      name: '  ',
      label: '',
      required: false,
      readOnly: false,
      multiline: false,
      fontSize: 10,
      maxLength: 0,
      options: [],
      value: '',
    };
    expect(creator.validateDrafts([draft], []).map((p) => p.message)).toContain(
      'Give every field a name.',
    );
    expect(
      creator.validateDrafts(
        [{ ...draft, name: 'x', rect: { x: 0, y: 0, width: 1, height: 1 } }],
        [],
      )[0].message,
    ).toMatch(/too small to click/);
    // Tab order is a list the user can reorder, not an accident of creation order.
    const two = [
      { ...draft, name: 'a' },
      { ...draft, name: 'b' },
    ];
    expect(creator.moveInTabOrder(two, 0, 1).map((f) => f.name)).toEqual([
      'b',
      'a',
    ]);
  });
});

/* ══ 8. sign: prepare once, place anywhere, keep the keyboard in the loop ══ */

describe('a signature is a reusable object', () => {
  it('the same prepared signature can be placed on another page', async () => {
    const sign = await import('@/components/tools/pdf/security/SignMain');
    sign.setSignPage({ page: 3, totalPages: 5 });
    const prepared = {
      id: sign.nextSigId(),
      type: 'draw' as const,
      text: '',
      imageDataUrl: 'data:image/png;base64,AAA',
      imageBytes: TINY_JPEG.buffer.slice(0, 8),
      w: 120,
      h: 40,
      color: '#000000',
      fontFamily: 'Helvetica',
    };
    sign.addSigItem(prepared);
    sign.addSigItem({ ...prepared, id: sign.nextSigId() });
    const items = sign.getSignState().items;
    expect(items).toHaveLength(2);
    // Both land on the page in view, which is the whole point of saving one.
    expect(items.every((item) => item.page === 3)).toBe(true);
    expect(items[0].imageBytes).toEqual(items[1].imageBytes);
    expect(sign.nextSigId()).not.toBe(sign.nextSigId());
    sign.removeSigItem(items[0].id);
    sign.removeSigItem(items[1].id);
  });

  it('the panel exposes the placement as accessible controls, not painted divs', async () => {
    const fs = await import('node:fs');
    const tool = fs.readFileSync(
      'src/components/tools/pdf/security/SignTool.tsx',
      'utf8',
    );
    expect(tool).toMatch(/role="tablist"/);
    expect(tool).toMatch(/aria-selected=\{tab === key\}/);
    expect(tool).toMatch(/role="option"/);
    expect(tool).toMatch(/placeAgain/);
    expect(tool).toMatch(/data-sign-blocked/);
    const main = fs.readFileSync(
      'src/components/tools/pdf/security/SignMain.tsx',
      'utf8',
    );
    expect(main).toMatch(/data-sig-handle="se"[\s\S]{0,200}nwse-resize/);
    expect(main).toMatch(/ArrowLeft/);
  });

  it('the sign tool promises a visual mark and admits it is not cryptographic', () => {
    const notes = (getPdfTool('sign')?.notes ?? []).join(' ');
    expect(notes).toMatch(/not a cryptographic signature/i);
  });
});

/* ══ 9. nobody polishes a surface nobody can reach ═════════════════════════ */

describe('the deleted panes stay deleted', () => {
  it('page numbers and watermarks run on the generated rail, so they need no pane', async () => {
    const fs = await import('node:fs');
    for (const id of ['page-numbers', 'watermark']) {
      expect(hasCustomMainView(id), id).toBe(false);
      expect(mainViewFor(id), id).toBeUndefined();
      expect(
        fs.existsSync(
          `src/components/tools/pdf/edit/${id === 'page-numbers' ? 'PageNumbersTool' : 'WatermarkTool'}.tsx`,
        ),
      ).toBe(false);
      expect(getPdfTool(id)?.run, id).toBeTypeOf('function');
    }
  });

  it('every surface this task owns is reachable by tool id', () => {
    for (const id of [
      'sign',
      'redact',
      'compare',
      'pdf-crop',
      'scan-to-pdf',
      'form-filler',
      'form-creator',
    ]) {
      expect(mainViewFor(id), id).toBeDefined();
    }
  });
});
