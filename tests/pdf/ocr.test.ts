/**
 * `core/ocr.ts` — what the recogniser is fed, and what a page may be claimed to
 * contain.
 *
 * Two defects live here and each has a test that cannot pass without its fix:
 *
 * 1. **The paint race.** `renderPage` settles when pdf.js has *scheduled* the
 *    paint; the pixels land on `render.finished`. Reading the canvas on the
 *    statement after `renderPage` handed the recogniser a sheet of paper, which
 *    is how `ocr-pdf` answered "Nothing was recognised" about a legible scan.
 *    Measured in Chromium for real (`docs/research/ocr-cause-probe.mjs`): 0
 *    non-white px at the settle, 94 145 (2.17 %) after `finished`.
 * 2. **The vendor image cache.** `ppu-paddle-ocr` keys its result cache on the
 *    buffer's byte length plus its **first 1024 bytes** — the top-left corner of
 *    the page. Two same-size pages that both begin with paper collide, so page 2
 *    is answered with page 1's words: a *fabricated* result, not a weaker one.
 *    `recognizeCanvas(canvas, { noCache: true })` is what keeps them apart, so
 *    the double below implements the vendor key over a pair of pages that collide
 *    by construction.
 *
 * The engine is mocked — its models are a network fetch and this sandbox may
 * have none — but the *branch selection* is asserted against the real module: an
 * engine that never loaded, a page read that holds ink but no letters, and a page
 * read that holds no ink are three different answers and are tested as three. The
 * real engine, the real raster and the real words meet in
 * `docs/research/ocr-round-trip.mjs` + `ocr-check.py`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PdfSession } from '@/lib/pdf/core/render';
import type { OcrDocumentOptions, OcrPageResult } from '@/lib/pdf/core/ocr';
// The class under its own name is the runtime value a test needs for `instanceof`;
// `…Error` is the same class as a type, so the checks agree on one spelling.
import type { OcrEngineUnavailable as OcrEngineUnavailableError } from '@/lib/pdf/core/ocr';

const RUN = vi.hoisted(() => ({
  /** Per-page sheet: how much ink the paint lands, and what the reader finds. */
  pages: [] as { page: number; lines: string[]; inkRows: number }[],
  /** Existing text layer per page — what makes `ocrDocument` skip a page. */
  textLayers: {} as Record<number, string>,
  initFails: null as string | null,
  recogniseFails: null as string | null,
  /** Every `recognizeCanvas` call, as the caller made it. */
  calls: [] as { page: number; noCache: unknown; inkPct: number; argCount: number }[],
  /** Vendor-style cache hits that answered one page from another's pixels. */
  collisions: [] as { page: number; servedFor: number }[],
  scales: [] as number[],
  rendered: [] as number[],
  statuses: [] as string[],
  cancelled: [] as number[],
}));

/**
 * A page bitmap in the shape pdf.js produces: a synchronous white fill when the
 * render task is created, the glyph rows in a *later* task, and `finished`
 * resolving only once they are down. `cancel()` rejects `finished`, as the real
 * `RenderingCancelledException` does.
 */
class FakeRender {
  readonly width: number;
  readonly height: number;
  painted = false;
  cancelled = false;
  readonly finished: Promise<void>;
  readonly ctx: { getImageData: () => { data: Uint8ClampedArray } };
  readonly canvas: HTMLCanvasElement;
  private settle!: () => void;
  private reject!: (error: unknown) => void;

  constructor(readonly page: number, inkRows: number, scale: number) {
    this.width = Math.round(595 * scale);
    this.height = Math.round(842 * scale);
    this.canvas = { width: this.width, height: this.height } as unknown as HTMLCanvasElement;
    this.finished = new Promise<void>((resolve, reject) => {
      this.settle = resolve;
      this.reject = reject;
    });
    // An unobserved rejection is the cancellation path; mark it handled so the
    // run does not fail on a promise nobody was waiting on.
    this.finished.catch(() => undefined);
    this.ctx = { getImageData: () => ({ data: this.pixels(inkRows) }) };
  }

  /** RGBA rows: paper always, plus this page's ink rows once painted. */
  pixels(inkRows: number): Uint8ClampedArray {
    const data = new Uint8ClampedArray(this.width * this.height * 4).fill(255);
    if (this.painted) {
      for (let row = 0; row < inkRows; row++) {
        const y = Math.floor(this.height / 2) + row;
        for (let x = 0; x < this.width; x++) {
          const at = (y * this.width + x) * 4;
          data[at] = 20;
          data[at + 1] = 20;
          data[at + 2] = 20;
        }
      }
    }
    return data;
  }

  /** pdf.js paints in a task after `renderPage` settles — never in this one. */
  paint(inkRows: number): void {
    this.painted = true;
    this.pixelsNow = this.pixels(inkRows);
    this.settle();
  }

  pixelsNow: Uint8ClampedArray = new Uint8ClampedArray(0);

  cancel(): void {
    this.cancelled = true;
    if (!this.painted) this.reject(new Error('RenderingCancelledException'));
  }
}

let renders: FakeRender[] = [];

vi.mock('@/lib/pdf/core/render', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pdf/core/render')>();
  const session = {
    doc: {},
    get numPages() {
      return RUN.pages.length;
    },
    fingerprint: 'ocr-test-session',
    page: async () => ({
      view: [0, 0, 595, 842],
      rotate: 0,
      getViewport: ({ scale = 1 }: { scale?: number } = {}) => ({ width: 595 * scale, height: 842 * scale }),
    }),
    textItems: async (n: number) => {
      const str = RUN.textLayers[n] ?? '';
      return str ? [{ str, isTransformed: false, isInvisible: false, fontName: 'F1' }] : [];
    },
    textContent: async () => ({ items: [] }),
    renderPage: async (n: number, scale: number) => {
      const spec = RUN.pages.find((page) => page.page === n)!;
      const render = new FakeRender(n, spec.inkRows, scale);
      renders.push(render);
      RUN.rendered.push(n);
      RUN.scales.push(scale);
      setTimeout(() => render.paint(spec.inkRows), 0);
      return {
        canvas: render.canvas,
        ctx: render.ctx as unknown as CanvasRenderingContext2D,
        width: render.width,
        height: render.height,
        unitsPerPixel: 1 / scale,
        pageNumber: n,
        finished: render.finished,
        cancel: () => {
          RUN.cancelled.push(n);
          render.cancel();
        },
      };
    },
    metadata: async () => ({ numPages: RUN.pages.length }),
    attachments: async () => ({}),
    destroy: async () => undefined,
  };
  return { ...actual, openRender: async () => session };
});

/**
 * The recogniser, with the vendor's cache rule modelled honestly.
 *
 * `node_modules/ppu-paddle-ocr/core/image-cache.js` keys on
 * `${hash(first 1024 bytes)}_${byteLength}` — reproduced below — so two sheets of
 * the same size that both begin with paper share a key. What saves the second
 * page is the caller passing `noCache`, which is the thing under test.
 */
vi.mock('@/lib/ocr/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ocr/engine')>();
  let cache = new Map<string, unknown>();

  /** The vendor rule, byte for byte. */
  const vendorKey = (pixels: Uint8ClampedArray): string => {
    let hash = 0;
    const len = Math.min(pixels.length, 1024);
    for (let i = 0; i < len; i++) {
      hash = (hash << 5) - hash + pixels[i];
      hash &= hash;
    }
    return `${hash}_${pixels.length}`;
  };

  /** Same ink rule the tests assert with: non-white, alpha-aware. */
  const inkPct = (pixels: Uint8ClampedArray): number => {
    let dark = 0;
    let sampled = 0;
    for (let i = 0; i + 3 < pixels.length; i += 4) {
      if (pixels[i + 3] === 0) continue;
      sampled += 1;
      if (0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2] < 220) dark += 1;
    }
    return sampled === 0 ? 0 : Math.round((dark / sampled) * 10000) / 100;
  };

  return {
    ...actual,
    initOcr: async () => {
      if (RUN.initFails) throw new Error(RUN.initFails);
    },
    // Deliberately `(canvas, ...rest)`: `argCount` is how the language-hint test
    // knows nothing but the canvas and its flags ever reach the reader.
    recognizeCanvas: async (canvas: HTMLCanvasElement, ...rest: unknown[]) => {
      const render = renders[renders.length - 1];
      if (!render || render.canvas !== canvas) {
        throw new Error('recognizeCanvas was handed a canvas this session never rendered');
      }
      const opts = rest[0] as { noCache?: boolean } | undefined;
      const pixels = render.ctx.getImageData().data;
      RUN.calls.push({
        page: render.page,
        noCache: opts?.noCache,
        inkPct: inkPct(pixels),
        argCount: 1 + rest.length,
      });
      if (RUN.recogniseFails) throw new Error(RUN.recogniseFails);
      const key = vendorKey(pixels);
      if (opts?.noCache !== true) {
        const hit = cache.get(key);
        if (hit) {
          RUN.collisions.push({ page: render.page, servedFor: (hit as { page: number }).page });
          return hit;
        }
      }
      const spec = RUN.pages.find((page) => page.page === render.page)!;
      const lineTop = Math.floor(render.height * 0.3);
      const result = {
        page: render.page,
        text: spec.lines.join('\n'),
        confidence: spec.lines.length > 0 ? 0.9 : 0,
        results: spec.lines.map((text, index) => ({
          text,
          confidence: 0.9,
          box: { x: 10, y: lineTop + index * 30, width: render.width - 20, height: 24 },
        })),
      };
      cache.set(key, result);
      return result;
    },
    __resetOcrDouble: () => {
      cache = new Map();
    },
  };
});

async function runOcr(options: OcrDocumentOptions): Promise<OcrPageResult[]> {
  const { ocrDocument } = await import('@/lib/pdf/core/ocr');
  const { openRender } = await import('@/lib/pdf/core/render');
  const session = (await openRender(new Uint8Array())) as unknown as PdfSession;
  return ocrDocument(session, options);
}

const byPage = (results: OcrPageResult[]) => new Map(results.map((result) => [result.page, result]));

beforeEach(async () => {
  RUN.pages = [];
  RUN.textLayers = {};
  RUN.initFails = null;
  RUN.recogniseFails = null;
  RUN.calls = [];
  RUN.collisions = [];
  RUN.scales = [];
  RUN.rendered = [];
  RUN.statuses = [];
  RUN.cancelled = [];
  renders = [];
  const engine = (await import('@/lib/ocr/engine')) as unknown as { __resetOcrDouble?: () => void };
  engine.__resetOcrDouble?.();
});

// ── 1. the paint must land before the canvas is read ─────────────────────────

describe('ocrDocument reads the painted page', () => {
  it('hands the recogniser the inked bitmap, not the white fill', async () => {
    RUN.pages = [{ page: 1, lines: ['PLANTED WORDS'], inkRows: 40 }];
    const results = await runOcr({ dpi: 300, onStatus: (status) => RUN.statuses.push(status) });

    // The one number that separates the two halves of the defect: the canvas the
    // reader was given carries the page's ink, not 0 %.
    expect(RUN.calls).toHaveLength(1);
    expect(RUN.calls[0]!.inkPct).toBeGreaterThan(1);
    expect(results[0]!.text).toBe('PLANTED WORDS');
    expect(results[0]!.words.map((word) => word.text)).toEqual(['PLANTED', 'WORDS']);
  });

  it('measures the ink it read, so "blank" is a measurement and not a guess', async () => {
    RUN.pages = [
      { page: 1, lines: ['SOMETHING'], inkRows: 40 },
      { page: 2, lines: [], inkRows: 0 },
      { page: 3, lines: [], inkRows: 8 },
    ];
    const read = byPage(await runOcr({ dpi: 200 }));

    // 40 inked rows over an 842 pt sheet is ~4.75 % of the bitmap.
    expect(read.get(1)!.ink!.ratio).toBeGreaterThan(0.01);
    expect(read.get(1)!.ink!.blank).toBe(false);
    // A painted sheet with nothing on it: measured, therefore called blank.
    expect(read.get(2)!.ink).toMatchObject({ ratio: 0, blank: true });
    // A sheet with ink but no letters is a *different* finding from a blank one.
    expect(read.get(3)!.ink!.ratio).toBeGreaterThan(0);
    expect(read.get(3)!.ink!.blank).toBe(false);
    expect(read.get(3)!.text).toBe('');
    expect(read.get(3)!.words).toEqual([]);
    expect(read.get(3)!.ink!.sampled).toBeGreaterThan(0);
  });

  it('cancels the render only after the page has been read', async () => {
    RUN.pages = [{ page: 1, lines: ['ONE'], inkRows: 20 }];
    await runOcr({ dpi: 150 });
    expect(RUN.cancelled).toEqual([1]);
    expect(renders[0]!.cancelled).toBe(true);
    // A cancellation that arrived before the paint would have rejected `finished`
    // and cost the run its pixels; the read happened on a painted sheet.
    expect(renders[0]!.painted).toBe(true);
  });
});

// ── 2. the vendor cache must not answer for a different page ─────────────────

describe('each page is recognised on its own pixels', () => {
  it('passes noCache so two same-size pages cannot share one answer', async () => {
    // Both sheets are 595 × 842 at the same dpi and both begin with paper, so the
    // vendor key — byte length plus the first 1024 bytes — is identical.
    RUN.pages = [
      { page: 1, lines: ['FIRST PAGE COPY'], inkRows: 30 },
      { page: 2, lines: ['SECOND PAGE COPY'], inkRows: 30 },
    ];
    const results = await runOcr({ dpi: 200 });

    for (const call of RUN.calls) expect(call.noCache).toBe(true);
    expect(RUN.collisions).toEqual([]);
    expect(results.map((result) => result.text)).toEqual(['FIRST PAGE COPY', 'SECOND PAGE COPY']);
    // And the boxes stay on their own page: no words inherited from sheet 1.
    expect(results[1]!.words.map((word) => word.text)).toEqual(['SECOND', 'PAGE', 'COPY']);
  });
});

// ── 3. the three outcomes stay three ─────────────────────────────────────────

describe('engine failure is never reported as an empty page', () => {
  it('names the engine, and reads nothing, when the models never arrived', async () => {
    RUN.initFails = 'Failed to fetch resource from https://models.invalid/det.ort';
    RUN.pages = [{ page: 1, lines: ['WILL NOT BE READ'], inkRows: 30 }];
    const { ocrDocument, OcrEngineUnavailable } = await import('@/lib/pdf/core/ocr');
    const { openRender } = await import('@/lib/pdf/core/render');
    const session = (await openRender(new Uint8Array())) as unknown as PdfSession;
    const failure = await ocrDocument(session, { dpi: 200 }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OcrEngineUnavailable);
    expect((failure as OcrEngineUnavailableError).phase).toBe('load');
    expect((failure as OcrEngineUnavailableError).detail).toMatch(/Failed to fetch/u);
    // Nothing was rendered and nothing was recognised: the file was not read,
    // which is a different sentence from "the pages hold no text".
    expect(RUN.rendered).toEqual([]);
    expect(RUN.calls).toEqual([]);
  });

  it('names the engine and the page when it stops answering mid-document', async () => {
    RUN.pages = [{ page: 1, lines: ['ONE LINE'], inkRows: 30 }];
    RUN.recogniseFails = 'onnx runtime trapped';
    const results = await runOcr({ dpi: 200 }).catch((error: unknown) => error);
    const { OcrEngineUnavailable } = await import('@/lib/pdf/core/ocr');
    expect(results).toBeInstanceOf(OcrEngineUnavailable);
    expect((results as OcrEngineUnavailableError).phase).toBe('recognise');
    expect((results as OcrEngineUnavailableError).page).toBe(1);
    expect((results as OcrEngineUnavailableError).detail).toBe('onnx runtime trapped');
  });

  it('leaves a skipped page without an ink reading, so it cannot be called blank', async () => {
    RUN.pages = [{ page: 1, lines: [], inkRows: 0 }];
    RUN.textLayers[1] = 'twenty-four chars minimum for the skip rule';
    const results = await runOcr({ dpi: 200 });
    expect(results[0]).toMatchObject({
      page: 1,
      alreadySearchable: true,
      text: 'twenty-four chars minimum for the skip rule',
    });
    // Never rendered, so no claim about its ink is available — or allowed.
    expect(results[0]!.ink).toBeUndefined();
    expect(RUN.rendered).toEqual([]);
  });

  it('reads a page that already has text when the user asks for a fresh pass', async () => {
    RUN.pages = [{ page: 1, lines: ['FRESH READ'], inkRows: 30 }];
    RUN.textLayers[1] = 'twenty-four chars minimum for the skip rule';
    const skipped = await runOcr({ dpi: 200 });
    const forced = await runOcr({ dpi: 200, force: true });
    expect(skipped[0]!.alreadySearchable).toBe(true);
    expect(forced[0]!.alreadySearchable).toBe(false);
    expect(forced[0]!.text).toBe('FRESH READ');
    // `force` is the only difference, and it is the only page the second read took.
    expect(forced[0]!.ink!.ratio).toBeGreaterThan(0);
  });
});

// ── 4. what the rail asks for is what the run does ───────────────────────────

describe('page selection, dpi and the language hint', () => {
  it('renders only the selected pages, in the order written, at the dpi asked for', async () => {
    RUN.pages = [
      { page: 1, lines: ['A'], inkRows: 20 },
      { page: 2, lines: ['B'], inkRows: 20 },
      { page: 3, lines: ['C'], inkRows: 20 },
    ];
    const results = await runOcr({ dpi: 300, pages: '3,1' });
    expect(RUN.rendered).toEqual([3, 1]);
    expect(results.map((result) => result.page)).toEqual([3, 1]);
    // dpi → scale is `dpiToScale`: 300 dpi is 300/72 of the point-space sheet.
    expect(RUN.scales).toEqual([300 / 72, 300 / 72]);
    expect(results[0]!.width).toBe(Math.round(595 * (300 / 72)));
    expect(results.map((result) => result.text)).toEqual(['C', 'A']);
  });

  it('honours a range and reports progress per page', async () => {
    RUN.pages = [
      { page: 1, lines: ['A'], inkRows: 20 },
      { page: 2, lines: ['B'], inkRows: 20 },
      { page: 3, lines: ['C'], inkRows: 20 },
    ];
    const seen: [number, number, number][] = [];
    const results = await runOcr({
      dpi: 150,
      pages: '2-3',
      onProgress: (done, total, page) => seen.push([done, total, page]),
    });
    expect(results.map((result) => result.page)).toEqual([2, 3]);
    expect(seen).toEqual([[1, 2, 2], [2, 2, 3]]);
    expect(RUN.scales).toEqual([150 / 72, 150 / 72]);
  });

  it('logs the language as a hint and hands the reader nothing else', async () => {
    RUN.pages = [{ page: 1, lines: ['TEXT'], inkRows: 20 }];
    await runOcr({ dpi: 200, lang: 'de', onStatus: (status) => RUN.statuses.push(status) });
    expect(RUN.statuses).toContain('Language hint: de');
    // The capability gap, pinned: the hint never reaches the engine, so no
    // language choice can change what is recognised. `recognizeCanvas` is called
    // with the canvas and the cache flag and nothing more.
    expect(RUN.calls[0]!.argCount).toBe(2);
    expect(RUN.calls[0]!.noCache).toBe(true);
  });
});
