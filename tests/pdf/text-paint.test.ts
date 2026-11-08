/**
 * Paint-level proof for the in-place text editor — both halves a user judges.
 *
 * `edit-pdf-text` shipped showing a **blank page whose words were still
 * selectable** (docs/TOOL-CAMPAIGN.md). `core/render`'s `renderToCanvas` copied
 * pdf.js's intermediate canvas into the visible one *before* the render task had
 * painted a single row, then cancelled that task, so the canvas stayed fully
 * transparent over the CSS `bg-white`. Every test around this surface mocked
 * `renderToCanvas` to resolve `{ width, height }` and asserted block counts, so
 * the suite could not see it: a page with zero ink and twenty extracted blocks
 * passed.
 *
 * Nothing here asserts that a block was extracted. It asserts that ink arrives:
 *
 * 1. the visible canvas holds painted pixels by the time `renderToCanvas`
 *    resolves, against a pdf.js double that paints asynchronously exactly like
 *    the real thing;
 * 2. `cancel()` still aborts a render in flight — a cancelled page paints
 *    nothing late, releases its page proxy, and does not leak an unhandled
 *    rejection (the `RenderingCancelledException` in the live console was that);
 * 3. the exported file paints its text: an opaque fill, a render mode that
 *    fills instead of `3 Tr` invisible, and glyph ids drawn through a face that
 *    is really embedded and really has advances.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef } from '@maxwbh/pdf-lib';
import { pageContentStreams, textRects } from '@/lib/pdf/core/content';
import { openPDF, savePDF } from '@/lib/pdf/core/doc';
import { clearFontCache } from '@/lib/pdf/core/fonts';
import { openRender } from '@/lib/pdf/core/render';
import { applyEdits, frameOfPage } from '@/components/tools/pdf/text-editor/draw';
import {
  DEFAULT_STYLE,
  paragraphsFromText,
  type EditObject,
  type TextObject,
} from '@/components/tools/pdf/text-editor/model';

/* ── the pdf.js double ────────────────────────────────────────────────────── */

const held = vi.hoisted(() => {
  const g = globalThis as unknown as {
    __pdfPaint?: {
      /** Painted-pixel count per canvas element, the only "ink" jsdom has. */
      surfaces: WeakMap<object, { painted: number }>;
      /** Pages whose proxy was released. */
      cleanups: number;
      /** Rejections with no observer, i.e. a leaked cancel. */
      unhandled: string[];
    };
  };
  g.__pdfPaint ??= { surfaces: new WeakMap(), cleanups: 0, unhandled: [] };
  return g.__pdfPaint;
});

const PAGE = { width: 595, height: 842 };
/** Every pixel of the page: what a completed pdf.js paint leaves behind. */
const FULL_INK = PAGE.width * PAGE.height;

function surfaceOf(element: object): { painted: number } {
  let surface = held.surfaces.get(element);
  if (!surface) {
    surface = { painted: 0 };
    held.surfaces.set(element, surface);
  }
  return surface;
}

vi.mock('pdfjs-dist', () => {
  // The double implements only the surface `openRender` touches — `getDocument`,
  // `GlobalWorkerOptions`, and the four members of a page proxy this module calls
  // — and replicates the one behaviour the bug turns on: `render()` returns
  // immediately and paints on a later frame.
  /** One in-flight render per page proxy, like pdf.js's own task list. */
  let inFlight: (() => void) | null = null;
  const doc = {
    numPages: 1,
    fingerprints: ['paint-fixture'],
    getPage: async () => ({
      rotate: 0,
      getViewport: ({ scale }: { scale: number }) => ({
        width: Math.round(PAGE.width * scale),
        height: Math.round(PAGE.height * scale),
        scale,
      }),
      getTextContent: async () => ({ items: [] }),
      cleanup: () => {
        held.cleanups += 1;
      },
      render: ({ canvasContext }: { canvasContext: { canvas: HTMLCanvasElement } }) => {
        const surface = surfaceOf(canvasContext.canvas);
        let settle: () => void = () => {};
        let fail: (err: Error) => void = () => {};
        const promise = new Promise<void>((resolve, reject) => {
          settle = resolve;
          fail = reject;
        });
        // pdf.js paints on later frames, never inside `render()`: the ink lands
        // after the call has already returned its task.
        const timer = setTimeout(() => {
          surface.painted = FULL_INK;
          inFlight = null;
          settle();
        }, 0);
        const cancel = () => {
          clearTimeout(timer);
          inFlight = null;
          fail(new Error('Rendering cancelled by the caller'));
        };
        // A render superseded on the same page is cancelled by pdf.js itself.
        inFlight?.();
        inFlight = cancel;
        promise.catch(() => {
          /* observed by the task owner; keeps the double quiet */
        });
        return { promise, cancel, onContinue: () => {} };
      },
    }),
    getMetadata: async () => ({ info: {} }),
    getFieldObjects: async () => null,
    destroy: async () => {},
  };
  return {
    GlobalWorkerOptions: { workerSrc: '' },
    OPS: {},
    getDocument: () => ({ promise: Promise.resolve(doc) }),
  };
});

/** A 2D context that only has to be able to answer "how much ink is here". */
class InkContext {
  filter = 'none';
  fillStyle = '#000';

  constructor(readonly canvas: HTMLCanvasElement) {}

  clearRect(): void {
    surfaceOf(this.canvas).painted = 0;
  }

  fillRect(): void {
    surfaceOf(this.canvas).painted = FULL_INK;
  }

  /** A copy takes what the source holds *right now* — exactly like the real one. */
  drawImage(source: HTMLCanvasElement): void {
    surfaceOf(this.canvas).painted += surfaceOf(source).painted;
  }

  getImageData(_x: number, _y: number, width: number, height: number) {
    const data = new Uint8ClampedArray(Math.max(1, width * height * 4));
    const painted = surfaceOf(this.canvas).painted;
    if (painted > 0) for (let i = 3; i < data.length; i += 4) data[i] = 255;
    return { data, width, height };
  }
}

const contexts = new WeakMap<object, InkContext>();

function contextFor(canvas: HTMLCanvasElement): InkContext {
  let ctx = contexts.get(canvas);
  if (!ctx) {
    ctx = new InkContext(canvas);
    contexts.set(canvas, ctx);
  }
  return ctx;
}

let realGetContext: typeof HTMLCanvasElement.prototype.getContext;

beforeAll(() => {
  realGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function patched(
    this: HTMLCanvasElement,
  ) {
    return contextFor(this) as unknown as ReturnType<typeof realGetContext>;
  } as typeof realGetContext;
  window.addEventListener('unhandledrejection', (event) => {
    held.unhandled.push(String(event.reason));
  });
});

afterAll(() => {
  HTMLCanvasElement.prototype.getContext = realGetContext;
});

/* ── 1 + 2: the on-screen paint ───────────────────────────────────────────── */

describe('the pane paints what it extracted', () => {
  it('puts painted pixels into the visible canvas before renderToCanvas resolves', async () => {
    const session = await openRender(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    const visible = document.createElement('canvas');
    const { width, height } = await session.renderToCanvas(1, visible, 1);

    // The bug copied an empty bitmap: 0 of these pixels existed.
    expect(surfaceOf(visible).painted).toBe(width * height);
    expect(surfaceOf(visible).painted).toBeGreaterThan(0);
    const alpha = visible.getContext('2d')!.getImageData(0, 0, width, height).data;
    let opaque = 0;
    for (let i = 3; i < alpha.length; i += 4) if (alpha[i] > 8) opaque += 1;
    expect(opaque).toBe(width * height);

    await session.destroy();
  });

  it('leaves a superseded page unpainted instead of blanking the new one', async () => {
    const session = await openRender(new Uint8Array([1]));
    const first = document.createElement('canvas');
    const second = document.createElement('canvas');

    const losing = session.renderToCanvas(1, first, 1);
    // The user turns the page while `first` is still in flight.
    const winning = session.renderToCanvas(1, second, 1);
    await expect(losing).rejects.toThrow(/cancel/i);
    await winning;

    expect(surfaceOf(first).painted).toBe(0);
    expect(surfaceOf(second).painted).toBe(FULL_INK);
    await session.destroy();
  });

  it('cancel() stops an in-flight render, releases the page, and leaks no rejection', async () => {
    const session = await openRender(new Uint8Array([2]));
    const render = await session.renderPage(1, 1);
    // The documented contract: the canvas is scheduled, not painted.
    expect(surfaceOf(render.canvas).painted).toBe(0);

    const cleanupsBefore = held.cleanups;
    render.cancel();
    await expect(render.finished).rejects.toThrow(/cancel/i);

    // A cancelled task never paints late.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(surfaceOf(render.canvas).painted).toBe(0);
    expect(held.cleanups).toBeGreaterThan(cleanupsBefore);
    // …and its rejection was observed at creation, so nothing surfaces as an
    // unhandled promise error (the live console noise this bug produced).
    expect(held.unhandled).toEqual([]);
    await session.destroy();
  });

  it('releases the page proxy when the canvas has no 2D context', async () => {
    const session = await openRender(new Uint8Array([3]));
    const broken = document.createElement('canvas');
    const realContext = broken.getContext;
    broken.getContext = (() => null) as typeof realContext;
    const cleanupsBefore = held.cleanups;
    await expect(session.renderToCanvas(1, broken, 1)).rejects.toThrow(/drawing context/i);
    expect(held.cleanups).toBeGreaterThan(cleanupsBefore);
    await session.destroy();
  });
});

/* ── 3: the exported file paints too ──────────────────────────────────────── */

const realFetch = globalThis.fetch;

beforeAll(() => {
  const face = new Uint8Array(readFileSync(join(process.cwd(), 'public', 'fonts', 'NotoSans-Regular.ttf')));
  globalThis.fetch = (async () =>
    new Response(face, { headers: { 'content-type': 'font/ttf' } })) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

const WRITTEN = 'Invisible ink check';

function textObject(overrides: Partial<TextObject> = {}): TextObject {
  return {
    id: 'text-paint-1',
    page: 1,
    kind: 'text',
    box: { x: 60, y: 90, width: 420, height: 30 },
    rotation: 0,
    flipH: false,
    flipV: false,
    z: 0,
    alt: '',
    state: 'written',
    paragraphs: paragraphsFromText(WRITTEN),
    style: { ...DEFAULT_STYLE, fontFamily: 'noto', size: 14, color: '#101014' },
    deletion: [],
    paperColor: '#ffffff',
    sourceId: '',
    fromInvisibleLayer: false,
    ...overrides,
  };
}

describe('the exported file draws the words, not merely stores them', () => {
  it('writes an opaque fill through an embedded face whose glyphs have width', async () => {
    clearFontCache();
    const seed = await PDFDocument.create();
    seed.addPage([PAGE.width, PAGE.height]);
    const doc = await openPDF(await savePDF(seed));
    const objects: EditObject[] = [textObject()];
    const outcome = await applyEdits(doc, objects);
    expect(outcome.written).toBe(1);
    expect(outcome.failed).toEqual([]);

    const bytes = await savePDF(doc);
    const reread = await openPDF(bytes);
    const drawn = reread.getPage(0);

    // The operators the file actually carries.
    const stream = pageContentStreams(drawn)
      .map((entry) => new TextDecoder('latin1').decode(entry.bytes))
      .join('\n');
    const shows = stream.match(/\/[A-Za-z0-9._-]+\s+[\d.]+\s+Tf[\s\S]*?<([0-9A-Fa-f]+)>\s*Tj/g) ?? [];
    expect(shows.length).toBeGreaterThan(0);
    // Render mode must fill. `3 Tr` is selectable-but-invisible text — an OCR
    // layer — and it is the exact failure this test exists to catch.
    expect(stream).not.toMatch(/\b3\s+Tr\b/);
    expect(stream).toMatch(/\b0\s+Tr\b/);
    // A fill that resolves to the paper paints nothing.
    const fills = [...stream.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) rg/g)]
      .map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
    expect(fills.length).toBeGreaterThan(0);
    expect(fills.some(([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5)).toBe(true);

    // The face named by `Tf` is embedded, so a viewer draws these glyphs without
    // substituting anything — and the substitution path is where blank text lives.
    const fontName = /\/([A-Za-z0-9._-]+)\s+[\d.]+\s+Tf/.exec(stream)?.[1];
    expect(fontName).toBeTruthy();
    expect(embeddedFaceBytes(drawn, String(fontName))).toBeTruthy();

    // And the glyphs have real advances. A run is written per word chunk (word
    // spacing is a text-state property), so the whole line is measured as the sum:
    // extraction alone would pass with zero-width notdefs, ink would not.
    const runs = textRects(drawn).filter((entry) => entry.text.trim().length > 0);
    expect(runs.length).toBeGreaterThan(0);
    const words = runs
      .slice()
      .sort((a, b) => a.rect.x - b.rect.x)
      .map((entry) => entry.text.trim())
      .join(' ');
    expect(words).toBe(WRITTEN);
    const lineAdvance = runs.reduce((total, entry) => total + entry.rect.width, 0);
    expect(Math.max(...runs.map((entry) => entry.rect.width))).toBeGreaterThan(0);
    expect(lineAdvance).toBeGreaterThan(WRITTEN.replace(/\s/g, '').length * 14 * 0.3);
  });
});

/** The font file behind one `/Resources /Font` entry, or null when not embedded. */
function embeddedFaceBytes(page: { node: unknown }, name: string): Uint8Array | null {
  // `@maxwbh/pdf-lib` looks up by `(key, type)`, not the order stock pdf-lib uses.
  const dict = page.node as PDFDict;
  const context = (page.node as unknown as { context: PDFDict['context'] }).context;
  const resources = dict.lookupMaybe(PDFName.of('Resources'), PDFDict);
  const fonts = resources?.lookupMaybe(PDFName.of('Font'), PDFDict);
  const font = fonts?.lookupMaybe(PDFName.of(name), PDFDict);
  if (!font) return null;
  const candidates: PDFDict[] = [font];
  const descendants = font.lookupMaybe(PDFName.of('DescendantFonts'), PDFArray);
  if (descendants) {
    for (let i = 0; i < descendants.size(); i += 1) {
      const value = descendants.get(i);
      const resolved = value instanceof PDFRef ? context.lookup(value, PDFDict) : value instanceof PDFDict ? value : undefined;
      if (resolved) candidates.push(resolved);
    }
  }
  for (const candidate of candidates) {
    const descriptor = candidate.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict);
    for (const key of ['FontFile2', 'FontFile3', 'FontFile']) {
      // A face is stored as a raw (usually Flate-compressed) stream object.
      const file = descriptor?.lookup(PDFName.of(key));
      if (file instanceof PDFRawStream) return new Uint8Array(file.getContents());
    }
  }
  return null;
}
