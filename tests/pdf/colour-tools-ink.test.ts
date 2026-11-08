/**
 * `invert-colors`, `adjust-colors`, `scanner-effect` — ink, polarity and direction,
 * measured off the pixels each tool wrote.
 *
 * All three reach one helper, `rerasterise` (`tools/edit.ts`), and all three shipped a
 * correctly sized, correctly formatted document of nothing: **0 non-white px on every
 * inked sheet** of `docs/research/colour-fixture.mjs`, measured on the deployed site
 * (`docs/TOOL-CAMPAIGN.md`, caller-audit row `tools/edit.ts:1950`). That is the
 * unawaited-`renderPage` family, fifth copy, arriving through a shared caller instead
 * of a single call site — so the caller is proven three times over, not once.
 *
 * Awaiting the paint fixes the blank half and only the blank half. With the await in
 * place and nothing else changed, the same rig measured `invert-colors` returning a
 * page that is **black everywhere** (bar 0.0, copy 0.0, band 0.0 luma; 100 %
 * non-white) and `adjust-colors` answering `brightness=1.6`, `contrast=2`,
 * `saturation=0`, `hue=180`, `grayscale` with five runs whose region means agreed to
 * ±0.1 — the same numbers as doing nothing. Cause: pdf.js's `beginDrawing` calls
 * `resetCtxToDefault`, which writes `filter = 'none'` over anything set on the context
 * before `page.render()`, so `RenderOptions.filter` could reach nothing except pdf.js's
 * own background fill. The double below reproduces both facts, so the pre-paint
 * assignment cannot come back pretending to work.
 *
 * What this file therefore asserts, in the shape the deployed defect slipped past:
 *
 * 1. **Polarity and bimodality, not "something changed."** A uniformly black page has
 *    moved its mean and differs from its input, so `output !== input` passes while the
 *    sheet is unreadable. `invert` must produce two distinct luminance populations with
 *    the roles swapped — the region that was ink now light, the region that was paper
 *    now dark. Ink presence alone cannot judge these tools: a blank page inverts to a
 *    blank page.
 * 2. **Direction per region, not the whole-page mean.** A sheet of greyscale text is
 *    nearly a fixed point of contrast and whitening — 255 and 0 are their fixed points —
 *    so the controls are judged where they must act: two flat greys either side of the
 *    contrast pivot at 128, which must move *apart*, and three colour squares whose
 *    channel spread must collapse or grow.
 * 3. **The identity case is byte-identical.** Every control at its default value composes
 *    an empty filter string, and an empty string must leave the painted bitmap exactly as
 *    pdf.js drew it — the assertion that catches a filter applied twice, which is the
 *    natural failure mode of a post-paint filter pass.
 *
 * The byte-for-byte comparisons are built from the same `applyFilter` this file defines,
 * because jsdom has no raster and the test installs one. They prove *ordering and
 * plumbing* — which pixels a pass touched, how many times, in what order — and not the
 * CSS matrices. Chromium checks those: `docs/research/colour-measure.sh` measures the
 * downloaded file per region against the source sheet's own colour pushed through the
 * reference formulae, independently, in `docs/research/colour-ink.py`.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  StandardFonts,
  openPDF,
  rgb,
} from '@/lib/pdf/core/doc';
import type { PDFPage } from '@/lib/pdf/core/doc';
import { sharpenPixels, thresholdPixels, whitenPixels } from '@/lib/pdf/core/measure';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { defaultValues, type ToolFile, type ToolValues } from '@/lib/pdf/tools/types';

/* ── the sheet: named regions of known colour ───────────────────────────────── */

/** Points. Small on purpose: every pixel of every region is walked per test. */
const SHEET: [number, number] = [200, 260];

/** Fractions of the displayed sheet from its top-left — `colour-fixture.mjs`'s table. */
const REGIONS = {
  bar: { x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.22 },
  copy: { x0: 0.08, y0: 0.26, x1: 0.92, y1: 0.82 },
  band: { x0: 0.1, y0: 0.86, x1: 0.9, y1: 0.97 },
  red: { x0: 0.1, y0: 0.1, x1: 0.32, y1: 0.3 },
  green: { x0: 0.39, y0: 0.1, x1: 0.61, y1: 0.3 },
  blue: { x0: 0.68, y0: 0.1, x1: 0.9, y1: 0.3 },
  grey: { x0: 0.1, y0: 0.36, x1: 0.32, y1: 0.5 },
  wash: { x0: 0.39, y0: 0.36, x1: 0.61, y1: 0.5 },
} as const;

type RegionName = keyof typeof REGIONS;

/** What each of the three fixture sheets carries. */
const PAGES: RegionName[][] = [
  ['bar', 'copy', 'band'],
  ['red', 'green', 'blue', 'grey', 'wash', 'band'],
  ['band'],
];

/** The flat colour each region's ink rasterises to. */
const INK: Record<RegionName, [number, number, number]> = {
  bar: [0, 0, 0],
  copy: [0, 0, 0],
  band: [255, 255, 255],
  red: [230, 26, 26],
  green: [26, 178, 51],
  blue: [26, 51, 230],
  grey: [89, 89, 89],
  wash: [166, 166, 166],
};

interface Bitmap {
  width: number;
  height: number;
  /** RGBA, row-major, top row first — the order `getImageData` reports. */
  data: Uint8ClampedArray;
}

const held = vi.hoisted(() => {
  const scope = globalThis as unknown as {
    __colour?: {
      /** Reads of a *page* canvas taken before its paint had landed. */
      earlyReads: number;
      /** The bitmap each page held when its task settled: the known-good side. */
      painted: (Bitmap | null)[];
      /** Filter strings that reached a canvas draw operation, with the page they touched. */
      applied: { page: number; filter: string }[];
    };
  };
  scope.__colour ??= { earlyReads: 0, painted: [], applied: [] };
  return scope.__colour;
});

/* ── the colour maths: one spelling, shared by the stub canvas and the checks ─── */

type ChannelFn = (r: number, g: number, b: number) => [number, number, number];

/** Round and clamp one channel, the way a canvas writes it back. */
function clamp255(v: number): number {
  if (v < 0) return 0;
  if (v > 255) return 255;
  return Math.round(v);
}
const recLuma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * The CSS filter-functions reference formulae, per channel in 0..255 — the same
 * expressions `docs/research/colour-ink.py` carries, and the two agreeing is the
 * cross-check between this stub and Chromium's real filter implementation.
 */
const FILTER_FN: Record<string, (argument: number) => ChannelFn> = {
  invert: (t) => (r, g, b) => [r + t * (255 - 2 * r), g + t * (255 - 2 * g), b + t * (255 - 2 * b)],
  grayscale: (t) => (r, g, b) => {
    const l = recLuma(r, g, b);
    return [r + t * (l - r), g + t * (l - g), b + t * (l - b)];
  },
  brightness: (k) => (r, g, b) => [r * k, g * k, b * k],
  contrast: (k) => (r, g, b) => [128 + k * (r - 128), 128 + k * (g - 128), 128 + k * (b - 128)],
  saturate: (s) => (r, g, b) => {
    const l = recLuma(r, g, b);
    return [l + s * (r - l), l + s * (g - l), l + s * (b - l)];
  },
  'hue-rotate': (deg) => {
    const a = (deg * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    return (r, g, b) => [
      (0.213 + c * 0.787 - s * 0.213) * r + (0.715 - c * 0.715 - s * 0.715) * g + (0.072 - c * 0.072 + s * 0.928) * b,
      (0.213 - c * 0.213 + s * 0.143) * r + (0.715 + c * 0.285 + s * 0.14) * g + (0.072 - c * 0.072 - s * 0.283) * b,
      (0.213 - c * 0.213 - s * 0.787) * r + (0.715 - c * 0.715 + s * 0.715) * g + (0.072 + c * 0.928 + s * 0.072) * b,
    ];
  },
};

/** `'invert(1) contrast(1.35)'` → the composed per-pixel function, in string order. */
function parseFilter(spec: string): ChannelFn | null {
  const parts = [...spec.matchAll(/([a-z-]+)\(([-0-9.]+)(?:deg)?\)/g)];
  if (parts.length === 0) return null;
  const fns = parts.map((match) => {
    const make = FILTER_FN[match[1]];
    if (!make) throw new Error(`the stub canvas cannot apply ${match[1]}()`);
    return make(Number(match[2]));
  });
  return (r, g, b) => fns.reduce<[number, number, number]>((acc, fn) => fn(...acc), [r, g, b]);
}

function filterPixels(bitmap: Bitmap, spec: string): Bitmap {
  const fn = parseFilter(spec);
  if (!fn) return bitmap;
  return { width: bitmap.width, height: bitmap.height, data: paintWith(bitmap, fn) };
}

function paintWith(bitmap: Bitmap, fn: (r: number, g: number, b: number) => [number, number, number]) {
  const out = new Uint8ClampedArray(bitmap.data.length);
  for (let i = 0; i + 3 < out.length; i += 4) {
    const [r, g, b] = fn(bitmap.data[i], bitmap.data[i + 1], bitmap.data[i + 2]);
    out[i] = clamp255(r);
    out[i + 1] = clamp255(g);
    out[i + 2] = clamp255(b);
    out[i + 3] = bitmap.data[i + 3];
  }
  return out;
}

/* ── a pixel-true canvas, because jsdom has no raster ───────────────────────── */

const surfaces = new WeakMap<HTMLCanvasElement, Bitmap>();
/** Canvases the pdf.js double handed out as pages, and which of them have been painted. */
const pageCanvases = new WeakMap<HTMLCanvasElement, number>();
const landed = new WeakSet<HTMLCanvasElement>();

function surfaceOf(canvas: HTMLCanvasElement): Bitmap {
  const width = Math.max(0, Math.trunc(canvas.width) || 0);
  const height = Math.max(0, Math.trunc(canvas.height) || 0);
  const existing = surfaces.get(canvas);
  // Assigning a canvas's width or height resets it to transparent black, which is the
  // state an unawaited `renderPage` leaves behind.
  if (!existing || existing.width !== width || existing.height !== height) {
    const created: Bitmap = { width, height, data: new Uint8ClampedArray(width * height * 4) };
    surfaces.set(canvas, created);
    return created;
  }
  return existing;
}

function reading(canvas: HTMLCanvasElement): void {
  if (pageCanvases.has(canvas) && !landed.has(canvas)) held.earlyReads += 1;
}

function parseColour(input: string): [number, number, number] {
  const hex = /^#?([0-9a-f]{6})$/i.exec(String(input).trim())?.[1];
  if (!hex) return [0, 0, 0];
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

class StubContext {
  filter = 'none';
  fillStyle = '#000000';
  globalAlpha = 1;
  globalCompositeOperation = 'source-over';
  ctm: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];
  private stack: { filter: string; fillStyle: string; globalAlpha: number; globalCompositeOperation: string; ctm: StubContext['ctm'] }[] = [];

  constructor(readonly canvas: HTMLCanvasElement) {}

  save(): void {
    this.stack.push({
      filter: this.filter,
      fillStyle: this.fillStyle,
      globalAlpha: this.globalAlpha,
      globalCompositeOperation: this.globalCompositeOperation,
      ctm: [...this.ctm] as StubContext['ctm'],
    });
  }

  restore(): void {
    const state = this.stack.pop();
    if (!state) return;
    this.filter = state.filter;
    this.fillStyle = state.fillStyle;
    this.globalAlpha = state.globalAlpha;
    this.globalCompositeOperation = state.globalCompositeOperation;
    this.ctm = state.ctm;
  }

  setTransform(a: number, _b: number, _c: number, d: number, e: number, f: number): void {
    this.ctm = [a, 0, 0, d, e, f];
  }

  /** Only the scale-and-translate case, which is all pdf.js's viewport matrix is. */
  transform(a: number, _b: number, _c: number, d: number, e: number, f: number): void {
    const [ca, , , cd, ce, cf] = this.ctm;
    this.ctm = [ca * a, 0, 0, cd * d, ca * e + ce, cd * f + cf];
  }

  getImageData(x: number, y: number, width: number, height: number): ImageData {
    reading(this.canvas);
    const src = surfaceOf(this.canvas);
    const out = new Uint8ClampedArray(width * height * 4);
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const sx = x + col;
        const sy = y + row;
        if (sx < 0 || sy < 0 || sx >= src.width || sy >= src.height) continue;
        const from = (sy * src.width + sx) * 4;
        const to = (row * width + col) * 4;
        for (let c = 0; c < 4; c++) out[to + c] = src.data[from + c];
      }
    }
    return new ImageData(out, width, height);
  }

  putImageData(image: ImageData, x: number, y: number): void {
    const dst = surfaceOf(this.canvas);
    for (let row = 0; row < image.height; row++) {
      for (let col = 0; col < image.width; col++) {
        const tx = x + col;
        const ty = y + row;
        if (tx < 0 || ty < 0 || tx >= dst.width || ty >= dst.height) continue;
        const from = (row * image.width + col) * 4;
        const to = (ty * dst.width + tx) * 4;
        for (let c = 0; c < 4; c++) dst.data[to + c] = image.data[from + c];
      }
    }
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    const [a, , , d, tx, ty] = this.ctm;
    const [r, g, b] = parseColour(this.fillStyle);
    const surface: Bitmap = { width: Math.round(width * a), height: Math.round(height * d), data: new Uint8ClampedArray(Math.round(width * a) * Math.round(height * d) * 4) };
    for (let i = 0; i + 3 < surface.data.length; i += 4) {
      surface.data[i] = r;
      surface.data[i + 1] = g;
      surface.data[i + 2] = b;
      surface.data[i + 3] = 255;
    }
    // The fill is a draw operation too, so the context's filter applies to it — the
    // one behaviour of pdf.js's background fill that the old code did reach.
    this.blit(filterPixels(surface, this.filter), Math.round(x + tx), Math.round(y + ty));
  }

  /** Copy 1:1, through this context's transform, filter, alpha and composite mode. */
  drawImage(source: HTMLCanvasElement, dx = 0, dy = 0): void {
    reading(source);
    const [a, , , d, tx, ty] = this.ctm;
    const src = surfaceOf(source);
    let bitmap: Bitmap = src;
    if (this.filter !== 'none') {
      if (pageCanvases.has(source)) held.applied.push({ page: pageCanvases.get(source)!, filter: this.filter });
      bitmap = filterPixels(src, this.filter);
    }
    if (a !== 1 || d !== 1) {
      const width = Math.round(src.width * a);
      const height = Math.round(src.height * d);
      const data = new Uint8ClampedArray(width * height * 4);
      for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
          const from = (Math.floor(row / d) * src.width + Math.floor(col / a)) * 4;
          const to = (row * width + col) * 4;
          for (let c = 0; c < 4; c++) data[to + c] = bitmap.data[from + c];
        }
      }
      bitmap = { width, height, data };
    }
    this.blit(bitmap, Math.round(tx + dx * a), Math.round(ty + dy * d));
  }

  private blit(source: Bitmap, dx: number, dy: number): void {
    const dst = surfaceOf(this.canvas);
    const copy = this.globalCompositeOperation === 'copy';
    const alpha = this.globalAlpha;
    for (let row = 0; row < source.height; row++) {
      const ty = dy + row;
      if (ty < 0 || ty >= dst.height) continue;
      for (let col = 0; col < source.width; col++) {
        const tx = dx + col;
        if (tx < 0 || tx >= dst.width) continue;
        const from = (row * source.width + col) * 4;
        const to = (ty * dst.width + tx) * 4;
        const sa = (source.data[from + 3] / 255) * alpha;
        if (copy) {
          for (let c = 0; c < 3; c++) dst.data[to + c] = source.data[from + c];
          dst.data[to + 3] = Math.round(source.data[from + 3] * alpha);
          continue;
        }
        for (let c = 0; c < 3; c++) {
          dst.data[to + c] = Math.round(dst.data[to + c] * (1 - sa) + source.data[from + c] * sa);
        }
        dst.data[to + 3] = Math.min(255, Math.round(dst.data[to + 3] + source.data[from + 3] * alpha));
      }
    }
  }
}

function installCanvas(): void {
  const proto = HTMLCanvasElement.prototype as unknown as {
    getContext: (kind: string) => unknown;
    toBlob: (cb: (blob: Blob | null) => void, type?: string, quality?: number) => void;
  };
  proto.getContext = function getContext(this: HTMLCanvasElement, kind: string) {
    if (kind !== '2d') return null;
    return new StubContext(this);
  };
  proto.toBlob = function toBlob(
    this: HTMLCanvasElement,
    cb: (blob: Blob | null) => void,
    type?: string,
  ): void {
    reading(this);
    const surface = surfaceOf(this);
    const mime = type ?? 'image/jpeg';
    // A lossless container wearing a JPEG's clothes — the same one
    // `tests/pdf/rasterize-ink.test.ts` writes, and it has to be a well-formed SOF0 or
    // pdf-lib's `embedJpg` refuses it and the caller falls back to decoding the image
    // through a canvas, which never finishes in jsdom. The question is which pixels were
    // in the canvas when it was encoded, and a real encoder could only move that answer
    // towards "less ink", never invent some.
    const payload = deflateSync(Buffer.from(rgbOf(surface)));
    const sof = Buffer.alloc(17);
    sof.writeUInt16BE(17, 0);
    sof[2] = 8;
    sof.writeUInt16BE(surface.height, 3);
    sof.writeUInt16BE(surface.width, 5);
    sof[7] = 3;
    const parts: number[] = [0xff, 0xd8, 0xff, 0xc0, ...sof];
    for (let at = 0; at < payload.length; at += 60000) {
      const slice = payload.subarray(at, at + 60000);
      const seg = Buffer.alloc(2);
      seg.writeUInt16BE(slice.length + 2, 0);
      parts.push(0xff, 0xfe, ...seg, ...slice);
    }
    parts.push(0xff, 0xd9);
    queueMicrotask(() => cb(new Blob([Uint8Array.from(parts) as BlobPart], { type: mime })));
  };
  if (typeof globalThis.ImageData === 'undefined') {
    class ShimImageData {
      constructor(
        public data: Uint8ClampedArray,
        public width: number,
        public height: number,
      ) {}
    }
    Object.defineProperty(globalThis, 'ImageData', { value: ShimImageData, configurable: true, writable: true });
  }
}

function rgbOf(bitmap: Bitmap): Uint8Array {
  const out = new Uint8Array(bitmap.width * bitmap.height * 3);
  for (let i = 0; i < bitmap.width * bitmap.height; i++) {
    for (let c = 0; c < 3; c++) out[i * 3 + c] = bitmap.data[i * 4 + c];
  }
  return out;
}

/* ── the pdf.js double: paper until `finished`, and it eats `ctx.filter` ─────── */

vi.mock('pdfjs-dist', () => {
  let requestedPage = 1;
  const doc = {
    // Read when pdf.js's document proxy is asked, not when this factory runs: the
    // consts above are still in their TDZ at that point, and a mock factory is hoisted.
    get numPages() {
      return PAGES.length;
    },
    fingerprints: ['colour-fixture'],
    getPage: async (n: number) => {
      requestedPage = n;
      return {
        rotate: 0,
        getViewport: ({ scale }: { scale: number }) => ({
          width: Math.floor(SHEET[0] * scale),
          height: Math.floor(SHEET[1] * scale),
          scale,
        }),
        getTextContent: async () => ({ items: [] }),
        cleanup: () => {},
        /**
         * The two facts this file exists for, in the order pdf.js really performs them:
         * fill the background honouring whatever `ctx.filter` the caller set, then
         * `resetCtxToDefault` — which writes `filter = 'none'` — and only then paint the
         * page, unfiltered, on a later frame.
         */
        render: ({ canvasContext }: { canvasContext: StubContext }) => {
          const canvas = canvasContext.canvas;
          pageCanvases.set(canvas, requestedPage);
          canvasContext.fillStyle = '#ffffff';
          canvasContext.fillRect(0, 0, canvas.width, canvas.height);
          canvasContext.save();
          canvasContext.filter = 'none';
          // …and `beginDrawing` then puts the viewport matrix on the context — pdf.js
          // 4.10.38, build/pdf.mjs:7705 — where it stays. A caller that draws back into
          // this canvas after the paint has to say what space it means, so the double has
          // to leave the same thing behind or that part of the fix goes untested.
          canvasContext.transform(1, 0, 0, -1, 0, canvas.height);
          let settle: () => void = () => {};
          let fail: (error: Error) => void = () => {};
          const promise = new Promise<void>((resolve, reject) => {
            settle = resolve;
            fail = reject;
          });
          const timer = setTimeout(() => {
            paintPage(canvas);
            landed.add(canvas);
            held.painted[requestedPage - 1] = {
              width: canvas.width,
              height: canvas.height,
              data: surfaceOf(canvas).data.slice(),
            };
            settle();
          }, 0);
          promise.catch(() => undefined);
          return {
            promise,
            cancel: () => {
              clearTimeout(timer);
              fail(new Error('Rendering cancelled by the caller'));
            },
            onContinue: () => {},
          };
        },
      };
    },
    getMetadata: async () => ({ info: {} }),
    getFieldObjects: async () => null,
    getOutline: async () => null,
    destroy: async () => {},
  };
  return {
    GlobalWorkerOptions: { workerSrc: '' },
    OPS: {},
    getDocument: () => ({ promise: Promise.resolve(doc) }),
  };
});

/** Ink the way pdf.js lays it down: flat blocks, plus anti-aliased body copy. */
function paintPage(canvas: HTMLCanvasElement): void {
  const surface = surfaceOf(canvas);
  const names = PAGES[pageCanvases.get(canvas)! - 1] ?? [];
  for (const name of names) {
    // `band` is paper, and paper is the background fill's job — that is the whole point
    // of the test below: a filter set before the paint reaches that fill and nothing else.
    if (name !== 'copy' && name !== 'band') paintRegion(surface, name, INK[name]);
  }
  // Body copy across the `copy` band: a 1 px glyph row at 0 with anti-aliasing at 128
  // below and 200 above. Paper and ink are fixed points of contrast and whitening;
  // these mid rows are the pixels those passes have to move.
  if (!names.includes('copy')) return;
  const copy = REGIONS.copy;
  const top = Math.round(copy.y0 * surface.height);
  const bottom = Math.round(copy.y1 * surface.height);
  const left = Math.round(copy.x0 * surface.width);
  const right = Math.round(copy.x1 * surface.width);
  for (let y = top + 3; y < bottom - 3; y += 8) {
    putRow(surface, left, right, y, 0);
    putRow(surface, left, right, y + 1, 128);
    putRow(surface, left, right, y - 1, 200);
  }
}

function putRow(surface: Bitmap, from: number, to: number, y: number, value: number): void {
  if (y < 0 || y >= surface.height) return;
  for (let x = from; x < to; x++) {
    const at = (y * surface.width + x) * 4;
    for (let c = 0; c < 3; c++) surface.data[at + c] = value;
    surface.data[at + 3] = 255;
  }
}

function paintRegion(surface: Bitmap, name: RegionName, colour: [number, number, number]): void {
  const region = REGIONS[name];
  const x0 = Math.round(region.x0 * surface.width);
  const x1 = Math.round(region.x1 * surface.width);
  const y0 = Math.round(region.y0 * surface.height);
  const y1 = Math.round(region.y1 * surface.height);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const at = (y * surface.width + x) * 4;
      surface.data[at] = colour[0];
      surface.data[at + 1] = colour[1];
      surface.data[at + 2] = colour[2];
      surface.data[at + 3] = 255;
    }
  }
}

/* ── the document the tools open ────────────────────────────────────────────── */

async function colourFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const names of PAGES) {
    const page = doc.addPage(SHEET);
    for (const name of names) {
      if (name === 'band' || name === 'copy') continue;
      const region = REGIONS[name];
      page.drawRectangle({
        x: region.x0 * SHEET[0],
        y: SHEET[1] - region.y1 * SHEET[1],
        width: (region.x1 - region.x0) * SHEET[0],
        height: (region.y1 - region.y0) * SHEET[1],
        color: rgb(INK[name][0] / 255, INK[name][1] / 255, INK[name][2] / 255),
      });
    }
    if (names.includes('copy')) {
      for (let line = 0; line < 12; line++) {
        page.drawText(`body copy line ${line + 1}`, {
          x: 18,
          y: SHEET[1] - 76 - line * 14,
          size: 9,
          font,
          color: rgb(0, 0, 0),
        });
      }
    }
  }
  return doc.save({ useObjectStreams: false });
}

function fileOf(bytes: Uint8Array): ToolFile {
  return {
    name: 'colour.pdf',
    size: bytes.byteLength,
    type: 'application/pdf',
    bytes: async () => new Uint8Array(bytes),
    blob: () => new Blob([bytes], { type: 'application/pdf' }),
  };
}

/** Runs a shipped tool and reads its page 1 back as RGB samples. */
async function runTool(id: string, values: ToolValues) {
  const tool = getPdfTool(id);
  expect(tool, `${id} is not registered`).toBeTruthy();
  const result = (await tool!.run!({
    inputs: [fileOf(await colourFixture())],
    values: { ...defaultValues(tool!.fields), ...values },
    progress: () => {},
    log: () => {},
    signal: new AbortController().signal,
  }))!;
  expect(result.kind, `${id} returned ${result.kind}, not a PDF`).toBe('pdf');
  const pdf = (result as { bytes: Uint8Array }).bytes;
  const doc = await openPDF(pdf);
  return { result: result as Extract<typeof result, { kind: 'pdf' }>, doc, raster: embeddedRaster(doc, doc.getPage(0)) };
}

/* ── reading a produced page back ───────────────────────────────────────────── */

function dictOf(doc: PDFDocument, value: unknown): PDFDict | null {
  const resolved = value instanceof PDFRef ? doc.context.lookup(value) : value;
  return resolved instanceof PDFDict ? resolved : null;
}

function streamOf(doc: PDFDocument, value: unknown): PDFRawStream | null {
  const resolved = value instanceof PDFRef ? doc.context.lookup(value) : value;
  return resolved instanceof PDFRawStream ? resolved : null;
}

function numberAt(dict: PDFDict, key: string): number {
  const value = dict.get(PDFName.of(key));
  return value instanceof PDFNumber ? Math.trunc(value.asNumber()) : NaN;
}

function samplesOf(stream: PDFRawStream): Uint8Array {
  const filter = `${stream.dict.get(PDFName.of('Filter'))}`;
  return filter === '/FlateDecode'
    ? new Uint8Array(inflateSync(Buffer.from(stream.contents)))
    : new Uint8Array(stream.contents);
}

function decodeStubJpeg(bytes: Uint8Array): Uint8Array {
  const chunks: Buffer[] = [];
  for (let i = 2; i < bytes.length - 1; i++) {
    if (bytes[i] !== 0xff) continue;
    const marker = bytes[i + 1];
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker === 0xfe) chunks.push(Buffer.from(bytes.subarray(i + 4, i + 2 + length)));
    else if (marker === 0xd9) break;
    i += 1 + length;
  }
  return new Uint8Array(inflateSync(Buffer.concat(chunks)));
}

/** The single image a rasterised page draws, as a bitmap a viewer would show. */
function embeddedRaster(doc: PDFDocument, page: PDFPage): Bitmap {
  const resources = dictOf(doc, page.node.Resources());
  const xobjects = dictOf(doc, resources?.get(PDFName.of('XObject')));
  expect(xobjects, 'the page drew no image').not.toBeNull();
  const images = [...xobjects!.entries()]
    .map(([, value]) => streamOf(doc, value))
    .filter((stream): stream is PDFRawStream => stream !== null);
  // The tool's promise is one picture per page; a second would turn every figure below
  // into a sum rather than a measurement.
  expect(images, 'exactly one image XObject per rasterised page').toHaveLength(1);
  const stream = images[0];
  const width = numberAt(stream.dict, 'Width');
  const height = numberAt(stream.dict, 'Height');
  const raw = samplesOf(stream);
  const samples = `${stream.dict.get(PDFName.of('Filter'))}` === '/DCTDecode' ? decodeStubJpeg(raw) : raw;
  expect(samples.length, 'the stored samples are not Width×Height×3').toBe(width * height * 3);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    for (let c = 0; c < 3; c++) data[i * 4 + c] = samples[i * 3 + c];
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

/* ── measuring regions ──────────────────────────────────────────────────────── */

function regionPixels(bitmap: Bitmap, name: RegionName): [number, number, number][] {
  const region = REGIONS[name];
  const x0 = Math.round(region.x0 * bitmap.width);
  const x1 = Math.round(region.x1 * bitmap.width);
  const y0 = Math.round(region.y0 * bitmap.height);
  const y1 = Math.round(region.y1 * bitmap.height);
  const out: [number, number, number][] = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const at = (y * bitmap.width + x) * 4;
      out.push([bitmap.data[at], bitmap.data[at + 1], bitmap.data[at + 2]]);
    }
  }
  return out;
}

function regionMean(bitmap: Bitmap, name: RegionName): [number, number, number] {
  const px = regionPixels(bitmap, name);
  const total = [0, 0, 0];
  for (const p of px) for (let i = 0; i < 3; i++) total[i] += p[i];
  return [total[0] / px.length, total[1] / px.length, total[2] / px.length];
}

const lumaOf = (p: [number, number, number]) => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];
const spreadOf = (p: [number, number, number]) => Math.max(...p) - Math.min(...p);

/** The known-good side: the unfiltered paint this page's `finished` settled with. */
function painted(page = 1): Bitmap {
  const bitmap = held.painted[page - 1];
  expect(bitmap, `the double recorded no paint for page ${page}`).not.toBeNull();
  return bitmap!;
}

/** What the tool should have written: the paint, filtered, then the pixel passes. */
function expectedRaster(spec: { filter?: string; whitening?: boolean; threshold?: number; sharpen?: boolean }, page = 1): Bitmap {
  const source = painted(page);
  const bitmap = filterPixels(source, spec.filter ?? '');
  const data = new Uint8ClampedArray(bitmap.data);
  if (spec.whitening) whitenPixels(data, 0.45);
  if (spec.threshold !== undefined) thresholdPixels(data, spec.threshold);
  if (spec.sharpen) sharpenPixels(data, bitmap.width, bitmap.height, 0.7);
  return { width: bitmap.width, height: bitmap.height, data };
}

/**
 * Two luminance populations, and how far apart they are.
 *
 * This is the instrument the deployed defect beat: a page of solid black has moved
 * every pixel and would pass `output !== input`, but it has one population, and a page
 * of paper has one too.
 */
function populations(bitmap: Bitmap): { dark: number; light: number; middle: number; total: number } {
  let dark = 0;
  let light = 0;
  let middle = 0;
  let total = 0;
  for (let i = 0; i + 3 < bitmap.data.length; i += 4) {
    const l = lumaOf([bitmap.data[i], bitmap.data[i + 1], bitmap.data[i + 2]]);
    total += 1;
    if (l <= 32) dark += 1;
    else if (l >= 223) light += 1;
    else middle += 1;
  }
  return { dark, light, middle, total };
}

/** How many distinct luminances the sheet holds — 1 is a flat page, inked or not. */
function distinctTones(bitmap: Bitmap): number {
  const tones = new Set<number>();
  for (let i = 0; i + 3 < bitmap.data.length; i += 4) {
    tones.add(Math.round(lumaOf([bitmap.data[i], bitmap.data[i + 1], bitmap.data[i + 2]])));
  }
  return tones.size;
}

function samplesEqual(a: Bitmap, b: Bitmap): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  for (let i = 0; i < a.data.length; i += 4) {
    for (let c = 0; c < 3; c++) if (a.data[i + c] !== b.data[i + c]) return false;
  }
  return true;
}

/* ── tests ──────────────────────────────────────────────────────────────────── */

beforeAll(() => {
  installCanvas();
});

beforeEach(() => {
  held.earlyReads = 0;
  held.painted = [];
  held.applied = [];
});

describe('the pdf.js double keeps the two facts the fix turns on', () => {
  it('hands out paper until the task settles and ink in a later frame', async () => {
    const { openRender } = await import('@/lib/pdf/core/render');
    const session = await openRender(await colourFixture());
    const render = await session.renderPage(1, 1);
    const early = render.ctx.getImageData(0, 0, render.width, render.height);
    expect(held.earlyReads, 'a read of an unpainted page went uncounted').toBe(1);
    await render.finished;
    const late = render.ctx.getImageData(0, 0, render.width, render.height);
    expect(held.earlyReads, 'the awaited paint still cost an early read').toBe(1);
    const paper = populations({ width: render.width, height: render.height, data: new Uint8ClampedArray(early.data) });
    const inked = populations({ width: render.width, height: render.height, data: new Uint8ClampedArray(late.data) });
    expect(paper.dark, 'the unpainted canvas already holds ink').toBe(0);
    expect(inked.dark, 'the painted canvas holds no ink').toBeGreaterThan(0);
    await session.destroy();
  });

  it('eats a ctx.filter set before the paint: the background fill honours it, the ink does not', async () => {
    const { openRender } = await import('@/lib/pdf/core/render');
    const session = await openRender(await colourFixture());
    const page = await session.page(2);
    const canvas = document.createElement('canvas');
    canvas.width = SHEET[0];
    canvas.height = SHEET[1];
    const ctx = canvas.getContext('2d')!;
    // Exactly what `core/render.ts` used to do — and the shape that shipped black text
    // on black paper, which is why the double has to repeat it.
    ctx.filter = 'invert(1)';
    const task = (page as unknown as { render: (options: unknown) => { promise: Promise<void> } }).render({
      canvasContext: ctx,
      viewport: { width: canvas.width, height: canvas.height },
    });
    await task.promise;
    const bitmap = surfaceOf(canvas);
    expect(lumaOf(regionMean(bitmap, 'band')), 'pdf.js painted the paper white').toBeLessThanOrEqual(8);
    // The ink keeps its own colour: un-inverted blue is dark (luma 55), inverted it
    // would be 200. Black text on black paper is the whole defect in one number.
    expect(lumaOf(regionMean(bitmap, 'blue')), 'pdf.js filtered the ink after all').toBeLessThan(100);
    await session.destroy();
  });
});

describe('RenderOptions.filter lands on the painted page', () => {
  it('inverts paper and ink together, through one pass over the finished bitmap', async () => {
    const { openRender } = await import('@/lib/pdf/core/render');
    const session = await openRender(await colourFixture());
    const render = await session.renderPage(2, 1, { filter: 'invert(1)', background: '#ffffff' });
    await render.finished;
    const bitmap = surfaceOf(render.canvas);
    const paper = regionMean(bitmap, 'band');
    const red = regionMean(bitmap, 'red');
    expect(Math.max(...paper)).toBeLessThanOrEqual(8); // paper went dark
    expect(red[0], 'the red square kept its red dominance').toBeLessThan(60); // ink went light
    // Asked at scale 1 here, so the bitmap is the sheet's own box in points.
    expect(bitmap.width).toBe(SHEET[0]);
    expect(held.applied).toEqual([{ page: 2, filter: 'invert(1)' }]);
    await session.destroy();
  });

  it('is applied once and not twice: a double invert is the page it started with', async () => {
    const { openRender } = await import('@/lib/pdf/core/render');
    const session = await openRender(await colourFixture());
    const render = await session.renderPage(2, 1, { filter: 'invert(1)' });
    await render.finished;
    expect(held.applied.filter((pass) => pass.page === 2)).toHaveLength(1);
    const once = filterPixels(painted(2), 'invert(1)');
    expect(samplesEqual(surfaceOf(render.canvas), once), 'the finished bitmap is one application of the filter').toBe(true);
    expect(samplesEqual(surfaceOf(render.canvas), painted(2)), 'a filter that did nothing would look like this').toBe(false);
    await session.destroy();
  });

  it('leaves the bitmap byte-identical when the filter is empty, `none`, or identity-valued', async () => {
    const { openRender } = await import('@/lib/pdf/core/render');
    const session = await openRender(await colourFixture());
    for (const filter of ['', 'none', 'brightness(1) contrast(1) saturate(1) hue-rotate(0deg)']) {
      held.applied = [];
      const render = await session.renderPage(2, 1, { filter, background: '#ffffff' });
      await render.finished;
      expect(
        samplesEqual(surfaceOf(render.canvas), painted(2)),
        `${filter || '(no filter)'} changed the painted bitmap`,
      ).toBe(true);
      // The two identity-valued strings still run a pass, and it must not double up; the
      // empty and `none` strings must not run one at all.
      expect(held.applied.length, `${filter || '(no filter)'} ran an unexpected number of passes`).toBe(
        filter === '' || filter === 'none' ? 0 : 1,
      );
    }
    await session.destroy();
  });

  it('never filters a page whose paint was cancelled', async () => {
    const { openRender } = await import('@/lib/pdf/core/render');
    const session = await openRender(await colourFixture());
    const render = await session.renderPage(2, 1, { filter: 'invert(1)' });
    render.cancel();
    await expect(render.finished).rejects.toThrow();
    expect(held.applied).toEqual([]);
    await session.destroy();
  });
});

describe('invert-colors: the negative, asserted as two populations with the roles swapped', () => {
  it('writes the page the filter predicts, per region', async () => {
    const { raster } = await runTool('invert-colors', { dpi: 72, pages: '1' });
    expect(samplesEqual(raster, expectedRaster({ filter: 'invert(1)' }))).toBe(true);
  });

  it('swaps ink and paper rather than turning the sheet black', async () => {
    const { raster } = await runTool('invert-colors', { dpi: 72, pages: '1' });
    const before = painted(1);
    expect(lumaOf(regionMean(before, 'bar')), 'the fixture bar is ink').toBeLessThanOrEqual(8);
    expect(lumaOf(regionMean(before, 'band')), 'the fixture band is paper').toBeGreaterThanOrEqual(247);
    const bar = lumaOf(regionMean(raster, 'bar'));
    const band = lumaOf(regionMean(raster, 'band'));
    expect(bar, `the inverted bar reads ${bar} — ink did not become light`).toBeGreaterThanOrEqual(247);
    expect(band, `the inverted band reads ${band} — paper did not become dark`).toBeLessThanOrEqual(8);
    expect(bar - band, 'the two regions did not swap roles').toBeGreaterThan(200);
  });

  it('leaves two distinct luminance populations, so the page is a picture and not a tone', async () => {
    const { raster } = await runTool('invert-colors', { dpi: 72, pages: '1' });
    const { dark, light, total } = populations(raster);
    expect(dark / total, 'a page with no dark population is the black-page defect').toBeGreaterThan(0.1);
    expect(light / total, 'a page with no light population is the paper defect').toBeGreaterThan(0.1);
    // A flat sheet — paper, or the solid black the pre-paint filter produced — has one
    // population. Two tones with glyph edges between them is what a legible page is.
    expect(Math.min(dark, light) / total, 'the sheet has one luminance population').toBeGreaterThan(0.1);
  });

  it('inverts the colour sheet too, and keeps its shape', async () => {
    const { raster } = await runTool('invert-colors', { dpi: 72, pages: '2' });
    const red = regionMean(raster, 'red');
    expect(red[0], 'the red square kept its red dominance').toBeLessThan(60);
    expect(Math.max(red[1], red[2]), 'the red square did not gain in green and blue').toBeGreaterThan(200);
    expect(samplesEqual(raster, expectedRaster({ filter: 'invert(1)' }, 2))).toBe(true);
  });

  it('turns the empty sheet into solid dark paper without inventing structure', async () => {
    const { raster } = await runTool('invert-colors', { dpi: 72, pages: '3' });
    const { middle, total } = populations(raster);
    expect(middle, 'an empty sheet has nothing to invert into a mid tone').toBe(0);
    expect(lumaOf(regionMean(raster, 'band'))).toBeLessThanOrEqual(8);
    expect(total).toBe(raster.width * raster.height);
  });

  it('fails the polarity assertion in both shapes this defect ships', () => {
    const paper = fillSheet(255);
    const black = fillSheet(0);
    // The two ways the tool was broken: nothing painted (paper), and paper inverted but
    // ink left alone (a black sheet, 100 % "ink"). Neither has the roles swapped, so
    // neither can pass what the tests above assert — and the black one passes any test
    // that only asks whether pixels changed.
    for (const [name, bitmap] of [['paper', paper], ['black', black]] as const) {
      const gap = lumaOf(regionMean(bitmap, 'bar')) - lumaOf(regionMean(bitmap, 'band'));
      expect(gap, `the ${name} sheet should not read as a negative`).toBeLessThanOrEqual(0);
      const { dark, light, total } = populations(bitmap);
      expect(Math.min(dark, light) / total, `the ${name} sheet is not bimodal either`).toBe(0);
      expect(total).toBeGreaterThan(0);
    }
  });
});

describe('adjust-colors: every control the rail offers, measured where it must move', () => {
  const COLOUR: ToolValues = { dpi: 72, pages: '2' };

  it('with nothing set, writes the painted page byte for byte', async () => {
    const { raster } = await runTool('adjust-colors', COLOUR);
    expect(samplesEqual(raster, painted(2)), 'the default values changed the pixels').toBe(true);
  });

  it('brightness lifts both flat greys, by the factor the field promises', async () => {
    const { raster } = await runTool('adjust-colors', { ...COLOUR, brightness: 1.6 });
    const before = painted(2);
    for (const name of ['grey', 'wash'] as const) {
      const l0 = lumaOf(regionMean(before, name));
      const l1 = lumaOf(regionMean(raster, name));
      expect(l1, `${name} did not rise with brightness ${1.6}`).toBeGreaterThan(l0);
      expect(Math.abs(l1 - Math.min(255, l0 * 1.6))).toBeLessThanOrEqual(1.5);
    }
    expect(samplesEqual(raster, expectedRaster({ filter: 'brightness(1.6)' }, 2))).toBe(true);
  });

  it('contrast moves the two greys apart, not together', async () => {
    const { raster } = await runTool('adjust-colors', { ...COLOUR, contrast: 2 });
    const before = painted(2);
    const grey = lumaOf(regionMean(raster, 'grey')) - lumaOf(regionMean(before, 'grey'));
    const wash = lumaOf(regionMean(raster, 'wash')) - lumaOf(regionMean(before, 'wash'));
    expect(grey, 'the dark grey should have gone darker').toBeLessThan(-30);
    expect(wash, 'the light grey should have gone lighter').toBeGreaterThan(30);
    expect(Math.sign(grey) === Math.sign(wash), 'both greys moved the same way: that is brightness, not contrast').toBe(false);
  });

  it('saturation 0 removes the colour and keeps the luma', async () => {
    const { raster } = await runTool('adjust-colors', { ...COLOUR, saturation: 0 });
    for (const name of ['red', 'green', 'blue'] as const) {
      expect(spreadOf(regionMean(raster, name)), `${name} is still chromatic`).toBeLessThanOrEqual(1);
      expect(
        Math.abs(lumaOf(regionMean(raster, name)) - recLuma(...INK[name])),
        `${name} lost lightness on the way to grey`,
      ).toBeLessThanOrEqual(2);
    }
  });

  it('hue 180 turns each square round the wheel', async () => {
    const { raster } = await runTool('adjust-colors', { ...COLOUR, hue: 180 });
    const red = regionMean(raster, 'red');
    expect(red[0], 'the red square is still the strongest channel').toBeLessThan(60);
    expect(red[1], 'the red square did not turn towards cyan').toBeGreaterThan(80);
    expect(Math.abs(red[1] - red[2]), 'the turn was not symmetric round the wheel').toBeLessThanOrEqual(4);
  });

  it('the greyscale switch wins over the saturation slider, and removes colour', async () => {
    const { raster } = await runTool('adjust-colors', { ...COLOUR, grayscale: true, saturation: 2 });
    for (const name of ['red', 'green', 'blue'] as const) {
      expect(spreadOf(regionMean(raster, name)), `${name} kept colour`).toBeLessThanOrEqual(1);
    }
  });

  it('the black-and-white cutoff bins the page, and only when asked', async () => {
    const { raster } = await runTool('adjust-colors', { dpi: 72, pages: '1', threshold: 0.5 });
    const tones = new Set<number>();
    for (let i = 0; i + 3 < raster.data.length; i += 4) tones.add(raster.data[i]);
    expect([...tones].sort((a, b) => a - b), 'more than two tones survived the cutoff').toEqual([0, 255]);
    const untouched = await runTool('adjust-colors', { dpi: 72, pages: '1' });
    expect(
      populations(untouched.raster).middle,
      'threshold=0 (the default) binarised anyway',
    ).toBeGreaterThan(0);
  });

  it('the five colour controls produce five different rasters', async () => {
    const settings = [
      {},
      { brightness: 1.6 },
      { contrast: 2 },
      { saturation: 0 },
      { hue: 180 },
    ] as ToolValues[];
    const rasters = [];
    for (const values of settings) rasters.push((await runTool('adjust-colors', { ...COLOUR, ...values })).raster);
    for (let a = 0; a < rasters.length; a++) {
      for (let b = a + 1; b < rasters.length; b++) {
        expect(samplesEqual(rasters[a], rasters[b]), `settings ${a} and ${b} wrote the same pixels`).toBe(false);
      }
    }
  });

  it('refuses to binarise a page into nothing: ink survives the cutoff', async () => {
    const { raster } = await runTool('adjust-colors', { dpi: 72, pages: '1', threshold: 0.5 });
    expect(populations(raster).dark, 'the cutoff left no ink on the page').toBeGreaterThan(0);
    expect(populations(raster).light, 'the cutoff left no paper on the page').toBeGreaterThan(0);
  });
});

describe('scanner-effect: a real pixel pass, not the page re-imaged', () => {
  it('is distinguishable from a plain rasterisation of the same sheet', async () => {
    const plain = await runTool('rasterize-pdf', { dpi: 72, format: 'jpeg', pages: '1' });
    const scanned = await runTool('scanner-effect', { dpi: 72, pages: '1' });
    expect(samplesEqual(plain.raster, scanned.raster), 'the scanner effect is not applied: it is a plain raster').toBe(false);
  });

  it('drops the colour its toggle asks for, and keeps it when the toggle is off', async () => {
    const scanned = await runTool('scanner-effect', { dpi: 72, pages: '2' });
    for (const name of ['red', 'green', 'blue'] as const) {
      expect(spreadOf(regionMean(scanned.raster, name)), `${name} survived greyscale`).toBeLessThanOrEqual(1);
    }
    const colour = await runTool('scanner-effect', { dpi: 72, pages: '2', grayscale: false, whitening: false, sharpen: false, contrast: 1 });
    for (const name of ['red', 'green', 'blue'] as const) {
      expect(spreadOf(regionMean(colour.raster, name)), `greyscale off removed the colour anyway`).toBeGreaterThan(100);
    }
  });

  it('whitens the paper, sharpens the glyph edges, and each toggle moves the file', async () => {
    const both = await runTool('scanner-effect', { dpi: 72, pages: '1' });
    const noWhiten = await runTool('scanner-effect', { dpi: 72, pages: '1', whitening: false });
    const noSharpen = await runTool('scanner-effect', { dpi: 72, pages: '1', sharpen: false });
    expect(samplesEqual(both.raster, noWhiten.raster), 'the whitening toggle moves nothing').toBe(false);
    expect(samplesEqual(both.raster, noSharpen.raster), 'the sharpen toggle moves nothing').toBe(false);
    // The mid rows are what whitening acts on: paper and ink are its fixed points.
    const mid = (bitmap: Bitmap) => regionPixels(bitmap, 'copy').filter(([, , b]) => b > 64 && b < 223).length;
    expect(mid(noWhiten.raster), 'whitening did not lift the anti-aliasing').toBeGreaterThan(mid(both.raster));
  });

  it('writes what the pipeline says it wrote: filter, then whiten, then sharpen', async () => {
    const { raster } = await runTool('scanner-effect', { dpi: 72, pages: '2' });
    expect(
      samplesEqual(raster, expectedRaster({ filter: 'grayscale(1) contrast(1.35)', whitening: true, sharpen: true }, 2)),
      'the scanner pipeline is not the composed pass it claims to be',
    ).toBe(true);
  });

  it('leaves the empty sheet empty of structure', async () => {
    const { raster } = await runTool('scanner-effect', { dpi: 72, pages: '3' });
    expect(populations(raster).middle, 'the passes invented mid tones on a blank sheet').toBe(0);
    expect(lumaOf(regionMean(raster, 'band'))).toBeGreaterThanOrEqual(247);
  });
});

describe('all three tools read the painted page, not the scheduled one', () => {
  it.each([
    ['invert-colors', { pages: '1' }],
    ['adjust-colors', { pages: '1' }],
    ['scanner-effect', { pages: '1' }],
    ['invert-colors', { pages: '2' }],
    ['adjust-colors', { pages: '2', threshold: 0.5 }],
    ['scanner-effect', { pages: '2', grayscale: false }],
  ] as const)('%s (%s) encodes no canvas that pdf.js has not painted', async (id, values) => {
    const { raster } = await runTool(id, { dpi: 72, ...values });
    expect(held.earlyReads, `${id} read a page canvas before its paint landed`).toBe(0);
    // Standing rule 2: an ink assertion in every rasterising tool's test, and it is the
    // sheet's own structure — a page of one flat tone is what both shipped shapes look
    // like, whether the paint never landed (paper) or only the paper was filtered (black).
    expect(populations(raster).total).toBe(raster.width * raster.height);
    expect(distinctTones(raster), `${id} wrote a sheet of one flat tone`).toBeGreaterThan(1);
  });

  it('carries the fixture sheet through all three, page by page', async () => {
    for (const id of ['invert-colors', 'adjust-colors', 'scanner-effect']) {
      const { doc, result } = await runTool(id, { dpi: 72, pages: 'all' });
      expect(doc.getPageCount(), `${id} did not write every page`).toBe(PAGES.length);
      expect(result.pages).toBe(PAGES.length);
      for (const [index, names] of PAGES.entries()) {
        const raster = embeddedRaster(doc, doc.getPage(index));
        const tones = distinctTones(raster);
        // Page 3 is the empty control: one tone in, one tone out, whatever the tool does
        // to it. The other two sheets carry ink, so they must not come out flat.
        if (names.length === 1 && names[0] === 'band') {
          expect(tones, `${id} invented structure on the empty sheet`).toBe(1);
        } else {
          expect(tones, `${id} shipped a flat page ${index + 1}`).toBeGreaterThan(1);
        }
      }
    }
  });
});

function fillSheet(value: number): Bitmap {
  const data = new Uint8ClampedArray(SHEET[0] * SHEET[1] * 4);
  for (let i = 0; i + 3 < data.length; i += 4) {
    for (let c = 0; c < 3; c++) data[i + c] = value;
    data[i + 3] = 255;
  }
  return { width: SHEET[0], height: SHEET[1], data };
}
