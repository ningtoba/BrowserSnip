/**
 * `pdf-to-greyscale`, Method = **Re-render** — the page it hands back is the page
 * it photographed, in grey.
 *
 * The tool has two methods and the rail picks one with a segmented control whose
 * default is `vectors`. Every probe the campaign ran before this row clicked the
 * rail with default values, so the raster branch — `core/measure.ts`'s
 * `applyColorFilter`, a rasteriser separate from `RenderOptions.filter`'s callers —
 * had literally never been exercised. Measured on the deployed site it shipped
 * **one 1166×1652 image XObject at 0.00 % non-white px where its own source sheet
 * measures 19.50 %** (`docs/TOOL-CAMPAIGN.md`, the `pdf-to-greyscale` row): paper
 * under a plausible file name, because `applyColorFilter` encoded `render.canvas`
 * before `render.finished` resolved, and the filter it passes lands on the
 * *finished* bitmap — so it was a filter applied to nothing.
 *
 * What is asserted here, and why each half is needed:
 *
 * 1. **The paint is awaited.** `held.earlyReads` counts every read of a page
 *    canvas taken before its paint landed (standing rule 1 — the double below
 *    hands out background-fill pixels until `finished` and inked ones in a later
 *    task). Zero is the fix; the reverted run reports the exact number.
 * 2. **The ink is compared with the source sheet's own measurement**, not with a
 *    threshold this file invents: the count of non-white pixels in the produced
 *    page must equal the count in the bitmap `finished` settled with, pushed
 *    through the same grey formula.
 * 3. **Colour actually becomes grey** — per region the channel spread collapses to
 *    0 and the Rec.709 luma survives. Ink presence alone cannot show this: a page
 *    of paper has spread 0 and passes, which is why the region's own luma is the
 *    second half of the pair.
 * 4. **The filter runs once per page.** `grayscale(1)` is idempotent, so a doubled
 *    pass is invisible in the pixels; the count of filter applications the canvas
 *    recorded is what catches it, and the achromatic sheet must be **pixel-equal to
 *    a plain `rasterize-pdf` of itself** (standing rule 4 — the pair these two
 *    shipped tools can form).
 * 5. **The page selection is the pages asked for.** `2-4` yields three sheets that
 *    match source pages 2, 3 and 4 — not pages 1-3, not one sheet three times — and
 *    an empty control sheet stays empty, so nothing is invented by the pass.
 * 6. **Vector mode still works**, so the await cannot have moved the defect into
 *    the other branch: the default method recolours the operators, keeps every
 *    page, and never renders a canvas at all.
 *
 * jsdom has no 2-D raster, so this file installs a pixel-true canvas and a pdf.js
 * double, and leaves the shipped `applyColorFilter` → `canvasToBlob` → `embedJpg`
 * path real: what is measured is the image the produced file carries.
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
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { pageUsesColor } from '@/lib/pdf/core/content';
import { defaultValues, type ToolFile, type ToolValues } from '@/lib/pdf/tools/types';

/* ── the sheet: named regions of known colour, five distinct pages ─────────── */

/** Points. Small on purpose: every pixel of every sheet is walked. */
const SHEET: [number, number] = [200, 260];

/** Fractions of the displayed sheet from its top-left — the `colour-fixture` spelling. */
const REGIONS = {
  bar: { x0: 0.08, y0: 0.06, x1: 0.92, y1: 0.16 },
  red: { x0: 0.08, y0: 0.22, x1: 0.38, y1: 0.38 },
  green: { x0: 0.44, y0: 0.22, x1: 0.74, y1: 0.38 },
  blue: { x0: 0.08, y0: 0.44, x1: 0.38, y1: 0.60 },
  grey: { x0: 0.44, y0: 0.44, x1: 0.74, y1: 0.60 }, // 89: achromatic, dark
  wash: { x0: 0.08, y0: 0.66, x1: 0.92, y1: 0.80 }, // 166: achromatic, light
} as const;

type RegionName = keyof typeof REGIONS;

const INK: Record<RegionName, [number, number, number]> = {
  bar: [0, 0, 0],
  red: [230, 26, 26],
  green: [26, 178, 51],
  blue: [26, 51, 230],
  grey: [89, 89, 89],
  wash: [166, 166, 166],
};

/**
 * Each page holds a different set, so a produced sheet can be traced back to the
 * source page it came from — the instrument the selection assertions read.
 * Page 3 is achromatic (the identity case) and page 5 is empty (the control).
 */
const PAGES: RegionName[][] = [
  ['bar', 'red', 'green', 'blue', 'grey', 'wash'],
  ['red', 'blue'],
  ['grey', 'wash'],
  ['bar'],
  [],
];

const COLOUR_PAGE = 1;
const GREY_PAGE = 3;
const EMPTY_PAGE = 5;

interface Bitmap {
  width: number;
  height: number;
  /** RGBA, row-major, top row first — the order `getImageData` reports. */
  data: Uint8ClampedArray;
}

const held = vi.hoisted(() => {
  const scope = globalThis as unknown as {
    __greyscale?: {
      /** Reads of a *page* canvas taken before its paint had landed. */
      earlyReads: number;
      /** The bitmap each page held when its task settled: the known-good side. */
      painted: (Bitmap | null)[];
      /** Every filter string that reached a canvas draw, with the page it touched. */
      applied: { page: number; filter: string }[];
    };
  };
  scope.__greyscale ??= { earlyReads: 0, painted: [], applied: [] };
  return scope.__greyscale;
});

/* ── the grey maths, spelled once ───────────────────────────────────────────── */

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
/** Rec.709 luma — the coefficient set the CSS `grayscale` filter uses. */
const recLuma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
/** The BT.601 luma `core/measure` and `colour-ink.py` count ink with. */
const lumaOf = (p: [number, number, number]) => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];
const spreadOf = (p: [number, number, number]) => Math.max(...p) - Math.min(...p);

/**
 * `grayscale(1)` per the filter-effects reference: every channel becomes the
 * Rec.709 luma. `applyColorFilter` composes this exact string for the tool's
 * greyscale switch (`cssFilterString`), and nothing else — an empty string here
 * would mean the switch reached no paint at all.
 */
function greyOf([r, g, b]: [number, number, number]): [number, number, number] {
  const l = clamp255(recLuma(r, g, b));
  return [l, l, l];
}

function applyGrayscale(bitmap: Bitmap): Bitmap {
  const data = new Uint8ClampedArray(bitmap.data.length);
  for (let i = 0; i + 3 < data.length; i += 4) {
    const [r, g, b] = greyOf([bitmap.data[i], bitmap.data[i + 1], bitmap.data[i + 2]]);
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = bitmap.data[i + 3];
  }
  return { width: bitmap.width, height: bitmap.height, data };
}

/* ── a pixel-true canvas, because jsdom has no raster ──────────────────────── */

const surfaces = new WeakMap<HTMLCanvasElement, Bitmap>();
/** Canvases the pdf.js double handed out as pages, and which of them have been painted. */
const pageCanvases = new WeakMap<HTMLCanvasElement, number>();
const landed = new WeakSet<HTMLCanvasElement>();

function surfaceOf(canvas: HTMLCanvasElement): Bitmap {
  const width = Math.max(0, Math.trunc(canvas.width) || 0);
  const height = Math.max(0, Math.trunc(canvas.height) || 0);
  const existing = surfaces.get(canvas);
  // Assigning width or height resets a canvas to transparent black — the state an
  // unawaited `renderPage` leaves behind, which is what `earlyReads` counts.
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

/** The one filter this tool composes, applied to a bitmap on its way to a canvas. */
function filterSurface(bitmap: Bitmap, filter: string): Bitmap {
  const parts = [...filter.matchAll(/([a-z-]+)\(([-0-9.]+)\)/g)];
  for (const part of parts) {
    if (part[1] !== 'grayscale' || Number(part[2]) !== 1) {
      throw new Error(`the stub canvas cannot apply ${part[0]}`);
    }
  }
  return parts.length > 0 ? applyGrayscale(bitmap) : bitmap;
}

class StubContext {
  filter = 'none';
  fillStyle = '#000000';
  globalAlpha = 1;
  globalCompositeOperation = 'source-over';
  ctm: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];

  private stack: {
    filter: string;
    fillStyle: string;
    globalAlpha: number;
    globalCompositeOperation: string;
    ctm: StubContext['ctm'];
  }[] = [];

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

  /** Only the scale-and-translate case, which is all pdf.js's viewport matrix is. */
  setTransform(a: number, _b: number, _c: number, d: number, e: number, f: number): void {
    this.ctm = [a, 0, 0, d, e, f];
  }

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
    const surface: Bitmap = {
      width: Math.round(width * a),
      height: Math.round(height * d),
      data: new Uint8ClampedArray(Math.round(width * a) * Math.round(height * d) * 4),
    };
    for (let i = 0; i + 3 < surface.data.length; i += 4) {
      surface.data[i] = r;
      surface.data[i + 1] = g;
      surface.data[i + 2] = b;
      surface.data[i + 3] = 255;
    }
    // A fill is a draw operation, so the context's filter applies to it — the one
    // behaviour of pdf.js's background fill a pre-paint `ctx.filter` ever reached.
    this.blit(filterSurface(surface, this.filter), Math.round(x + tx), Math.round(y + ty));
  }

  /** Copy 1:1 through this context's transform, filter, alpha and composite mode. */
  drawImage(source: HTMLCanvasElement, dx = 0, dy = 0): void {
    reading(source);
    const [a, , , d, tx, ty] = this.ctm;
    const src = surfaceOf(source);
    let bitmap: Bitmap = src;
    if (this.filter !== 'none') {
      if (pageCanvases.has(source)) held.applied.push({ page: pageCanvases.get(source)!, filter: this.filter });
      bitmap = filterSurface(src, this.filter);
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

function rgbOf(bitmap: Bitmap): Uint8Array {
  const out = new Uint8Array(bitmap.width * bitmap.height * 3);
  for (let i = 0; i < bitmap.width * bitmap.height; i++) {
    for (let c = 0; c < 3; c++) out[i * 3 + c] = bitmap.data[i * 4 + c];
  }
  return out;
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
    // A lossless container wearing a JPEG's clothes, the same one
    // `colour-tools-ink.test.ts` writes: `applyColorFilter` always embeds `jpeg`,
    // and pdf-lib refuses a `/DCTDecode` it cannot parse a `/SOF0` out of. A real
    // encoder could only move the answer towards "less ink", never invent some.
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
      const head = Buffer.alloc(2);
      head.writeUInt16BE(slice.length + 2, 0);
      parts.push(0xff, 0xfe, ...head, ...slice);
    }
    parts.push(0xff, 0xd9);
    queueMicrotask(() => cb(new Blob([Uint8Array.from(parts) as BlobPart], { type: type ?? 'image/jpeg' })));
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

/* ── the pdf.js double: paper until `finished`, ink in a later task ─────────── */

vi.mock('pdfjs-dist', () => {
  let requestedPage = 1;
  const doc = {
    // Read when the proxy is asked, not when this factory runs: `PAGES` is still in
    // its TDZ there, and a mock factory is hoisted above the module's consts.
    get numPages() {
      return PAGES.length;
    },
    fingerprints: ['greyscale-fixture'],
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
         * pdf.js's own order: the background fill honours whatever `ctx.filter` the
         * caller set, then `resetCtxToDefault` writes `filter = 'none'` over it, then
         * the viewport matrix goes on the context, then the page paints on a later
         * frame. The tool cannot lose that frame by encoding early — but a caller
         * that does not await `finished` does exactly that, which is this defect.
         */
        render: ({ canvasContext }: { canvasContext: StubContext }) => {
          const canvas = canvasContext.canvas;
          pageCanvases.set(canvas, requestedPage);
          canvasContext.fillStyle = '#ffffff';
          canvasContext.fillRect(0, 0, canvas.width, canvas.height);
          canvasContext.save();
          canvasContext.filter = 'none';
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

/** Flat named regions plus anti-aliased body copy, the way pdf.js lays them down. */
function paintPage(canvas: HTMLCanvasElement): void {
  const surface = surfaceOf(canvas);
  for (const name of PAGES[pageCanvases.get(canvas)! - 1] ?? []) {
    paintRegion(surface, name, INK[name]);
  }
  // The `bar` sheet also carries a couple of glyph rows so the ink is not made
  // only of solid blocks: 1 px at 0 with 128 below and 200 above.
  if (!(PAGES[pageCanvases.get(canvas)! - 1] ?? []).includes('bar')) return;
  const top = Math.round(0.10 * surface.height);
  for (let line = 0; line < 3; line++) {
    const y = top + 4 + line * 5;
    putRow(surface, Math.round(0.1 * surface.width), Math.round(0.9 * surface.width), y, 0);
    putRow(surface, Math.round(0.1 * surface.width), Math.round(0.9 * surface.width), y + 1, 128);
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

/* ── the document the tool opens ───────────────────────────────────────────── */

async function greyscaleFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const names of PAGES) {
    const page = doc.addPage(SHEET);
    for (const name of names) {
      const region = REGIONS[name];
      page.drawRectangle({
        x: region.x0 * SHEET[0],
        y: SHEET[1] - region.y1 * SHEET[1],
        width: (region.x1 - region.x0) * SHEET[0],
        height: (region.y1 - region.y0) * SHEET[1],
        color: rgb(INK[name][0] / 255, INK[name][1] / 255, INK[name][2] / 255),
      });
    }
    if (names.includes('bar')) {
      for (let line = 0; line < 3; line++) {
        page.drawText(`selectable line ${line + 1}`, {
          x: 20,
          y: SHEET[1] - 40 - line * 10,
          size: 8,
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

/** Runs a shipped tool and hands back its produced document. */
async function runTool(id: string, values: ToolValues) {
  const tool = getPdfTool(id);
  expect(tool, `${id} is not registered`).toBeTruthy();
  const result = (await tool!.run!({
    inputs: [fileOf(await greyscaleFixture())],
    values: { ...defaultValues(tool!.fields), ...values },
    progress: () => {},
    log: () => {},
    signal: new AbortController().signal,
  }))!;
  expect(result.kind, `${id} returned ${result.kind}, not a PDF`).toBe('pdf');
  const doc = await openPDF((result as { bytes: Uint8Array }).bytes);
  return { result: result as Extract<typeof result, { kind: 'pdf' }>, doc };
}

/** The raster method of this tool, at 72 dpi so a page is 200 × 260 px. */
async function runRaster(values: ToolValues = {}) {
  const before = held.applied.length;
  const out = await runTool('pdf-to-greyscale', { mode: 'raster', dpi: 72, ...values });
  return { ...out, rasters: out.doc.getPages().map((page) => embeddedRaster(out.doc, page)), passes: held.applied.slice(before) };
}

/* ── reading a produced page back ──────────────────────────────────────────── */

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
  // The tool's promise is one picture per page; a second would turn every figure
  // below into a sum rather than a measurement.
  expect(images, 'exactly one image XObject per rasterised page').toHaveLength(1);
  const stream = images[0];
  const width = numberAt(stream.dict, 'Width');
  const height = numberAt(stream.dict, 'Height');
  const raw = `${stream.dict.get(PDFName.of('Filter'))}` === '/FlateDecode'
    ? new Uint8Array(inflateSync(Buffer.from(stream.contents)))
    : new Uint8Array(stream.contents);
  const samples = `${stream.dict.get(PDFName.of('Filter'))}` === '/DCTDecode' ? decodeStubJpeg(raw) : raw;
  expect(samples.length, 'the stored samples are not Width×Height×3').toBe(width * height * 3);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    for (let c = 0; c < 3; c++) data[i * 4 + c] = samples[i * 3 + c];
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

/* ── measuring ─────────────────────────────────────────────────────────────── */

/** Non-white pixels, counted the way `colour-ink.py` and `rail-measure.py` count them. */
function inkPixels(bitmap: Bitmap): number {
  let dark = 0;
  for (let i = 0; i + 3 < bitmap.data.length; i += 4) {
    if (bitmap.data[i + 3] === 0) continue;
    if (lumaOf([bitmap.data[i], bitmap.data[i + 1], bitmap.data[i + 2]]) < 245) dark += 1;
  }
  return dark;
}

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
  expect(px.length, `region ${name} covers no pixel at this size`).toBeGreaterThan(0);
  const total = [0, 0, 0];
  for (const p of px) for (let i = 0; i < 3; i++) total[i] += p[i];
  return [total[0] / px.length, total[1] / px.length, total[2] / px.length];
}

function samplesEqual(a: Bitmap, b: Bitmap): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  for (let i = 0; i < a.data.length; i += 4) {
    for (let c = 0; c < 3; c++) if (a.data[i + c] !== b.data[i + c]) return false;
  }
  return true;
}

/** The known-good side: the unfiltered paint this page's `finished` settled with. */
function painted(page: number): Bitmap {
  const bitmap = held.painted[page - 1];
  expect(bitmap, `the double recorded no paint for page ${page}`).not.toBeNull();
  return bitmap!;
}

function sheetOf(value: number, tone: number): Bitmap {
  const data = new Uint8ClampedArray(SHEET[0] * SHEET[1] * 4);
  for (let i = 0; i + 3 < data.length; i += 4) {
    for (let c = 0; c < 3; c++) data[i + c] = tone;
    data[i + 3] = 255;
  }
  return { width: SHEET[0], height: SHEET[1], data };
}

/* ── tests ─────────────────────────────────────────────────────────────────── */

beforeAll(() => {
  installCanvas();
});

beforeEach(() => {
  held.earlyReads = 0;
  held.painted = [];
  held.applied = [];
});

describe('the pdf.js double keeps the ordering the defect turned on', () => {
  it('hands out paper until the task settles and ink in a later frame', async () => {
    const { openRender } = await import('@/lib/pdf/core/render');
    const session = await openRender(await greyscaleFixture());
    const render = await session.renderPage(COLOUR_PAGE, 1);
    const early = render.ctx.getImageData(0, 0, render.width, render.height);
    expect(held.earlyReads, 'a read of an unpainted page went uncounted').toBe(1);
    await render.finished;
    const late = render.ctx.getImageData(0, 0, render.width, render.height);
    expect(held.earlyReads, 'the awaited paint still cost an early read').toBe(1);
    const size = { width: render.width, height: render.height };
    expect(inkPixels({ ...size, data: new Uint8ClampedArray(early.data) }), 'the unpainted canvas holds ink').toBe(0);
    expect(inkPixels({ ...size, data: new Uint8ClampedArray(late.data) }), 'the painted canvas holds no ink').toBeGreaterThan(0);
    await session.destroy();
  });
});

describe('pdf-to-greyscale, Method = Re-render: the paint is awaited', () => {
  it('encodes no canvas that pdf.js has not painted', async () => {
    const { rasters } = await runRaster({ pages: 'all' });
    expect(held.earlyReads, `the helper read a page canvas ${held.earlyReads}× before its paint landed`).toBe(0);
    expect(rasters).toHaveLength(PAGES.length);
  });

  it('carries the source sheet’s own ink, page by page', async () => {
    const { rasters } = await runRaster({ pages: 'all' });
    for (const [index, raster] of rasters.entries()) {
      const source = inkPixels(applyGrayscale(painted(index + 1)));
      expect(raster.width, `page ${index + 1} was rendered at the asked scale`).toBe(SHEET[0]);
      expect(
        inkPixels(raster),
        `page ${index + 1}: the file carries ${inkPixels(raster)} non-white px, its own sheet ${source}`,
      ).toBe(source);
      // The empty control pins the instrument at 0, so the other four cannot pass
      // by counting something that is always there.
      if (index + 1 === EMPTY_PAGE) expect(source).toBe(0);
      else expect(source, `page ${index + 1} of the fixture has no ink to measure`).toBeGreaterThan(0);
    }
  });

  it('is not the page of paper the deployed site shipped', async () => {
    const { rasters } = await runRaster({ pages: String(COLOUR_PAGE) });
    expect(inkPixels(rasters[0]), '0 non-white px is the defect: paper under a plausible file name').toBeGreaterThan(0);
    // The shape the defect produced: a full sheet of paper at the right size.
    expect(
      samplesEqual(rasters[0], applyGrayscale(sheetOf(1, 255))),
      'the output is a plain sheet of paper again',
    ).toBe(false);
  });
});

describe('pdf-to-greyscale, Method = Re-render: colour becomes grey', () => {
  it('drives every region’s chroma to 0 and keeps its luma', async () => {
    const { rasters } = await runRaster({ pages: String(COLOUR_PAGE) });
    const raster = rasters[0];
    for (const name of ['red', 'green', 'blue', 'grey', 'wash'] as RegionName[]) {
      const before = regionMean(painted(COLOUR_PAGE), name);
      const after = regionMean(raster, name);
      expect(spreadOf(after), `${name} is still chromatic (spread ${spreadOf(after)})`).toBe(0);
      // Achromatic in, unchanged out: the grey is the source’s own luma, not a
      // threshold, not a wash, not the average of the page.
      expect(
        Math.abs(after[0] - clamp255(recLuma(...before))),
        `${name}: grey ${after[0]} is not the source luma ${recLuma(...before).toFixed(1)}`,
      ).toBeLessThanOrEqual(1);
    }
  });

  it('applies the greyscale operator exactly once per rendered page', async () => {
    const { passes, rasters } = await runRaster({ pages: 'all' });
    expect(passes.map((p) => p.page).sort((a, b) => a - b), 'one filter pass per page').toEqual([1, 2, 3, 4, 5]);
    for (const pass of passes) expect(pass.filter, `page ${pass.page} got the wrong filter`).toBe('grayscale(1)');
    // `grayscale(1)` is idempotent, so the pixels cannot show a doubled pass; the
    // count above is the instrument, and this is what it is for.
    expect(samplesEqual(rasters[0], applyGrayscale(applyGrayscale(painted(COLOUR_PAGE))))).toBe(true);
  });

  it('on an already-grey sheet is pixel-equal to a plain rasterisation of itself', async () => {
    const grey = await runRaster({ pages: String(GREY_PAGE) });
    const plain = await runTool('rasterize-pdf', { dpi: 72, format: 'jpeg' });
    const plainRaster = embeddedRaster(plain.doc, plain.doc.getPages()[GREY_PAGE - 1]);
    expect(
      samplesEqual(grey.rasters[0], plainRaster),
      'the grey tool moved pixels a plain rasterisation left alone — or filtered twice',
    ).toBe(true);
    expect(inkPixels(plainRaster), 'the achromatic sheet has no ink to compare').toBeGreaterThan(0);
  });

  it('invents nothing on the empty control', async () => {
    const { rasters } = await runRaster({ pages: String(EMPTY_PAGE) });
    expect(inkPixels(rasters[0]), 'the empty sheet came back with structure').toBe(0);
    expect(samplesEqual(rasters[0], applyGrayscale(painted(EMPTY_PAGE)))).toBe(true);
  });
});

describe('pdf-to-greyscale, Method = Re-render: the page selection is the pages asked for', () => {
  it('yields three sheets for 2-4, and each one is its own source page', async () => {
    // Every sheet is rendered once for the comparison to be read against, so
    // page 1's own pixels exist to be ruled out.
    const all = await runRaster({ pages: 'all' });
    const { result, rasters } = await runRaster({ pages: '2-4' });
    expect(rasters, 'a request for 2-4 did not yield three pages').toHaveLength(3);
    expect(result.pages).toBe(3);
    expect(result.message).toMatch(/Re-rendered 3 page/);
    rasters.forEach((raster, index) => {
      expect(
        samplesEqual(raster, all.rasters[index + 1]),
        `output sheet ${index + 1} is not source page ${index + 2}`,
      ).toBe(true);
    });
    // The two shapes a broken selection takes: start at page 1, or repeat one
    // page. Both are excluded, sheet by sheet.
    expect(samplesEqual(rasters[0], all.rasters[0]), 'the selection started at page 1, not page 2').toBe(false);
    expect(samplesEqual(rasters[1], rasters[0]), 'one page was written three times').toBe(false);
    expect(samplesEqual(rasters[2], rasters[1]), 'one page was written three times').toBe(false);
  });

  it('renders the pages the user named, in the order they named them', async () => {
    // `core/pages` keeps the written order, so `4,2` must come out 4 then 2 — the
    // same claim the `pdf-to-image` row measures on the rail, made here against
    // this helper's own raster.
    const { rasters } = await runRaster({ pages: '4,2' });
    expect(rasters).toHaveLength(2);
    expect(samplesEqual(rasters[0], applyGrayscale(painted(4))), 'the first sheet is not page 4').toBe(true);
    expect(samplesEqual(rasters[1], applyGrayscale(painted(2))), 'the second sheet is not page 2').toBe(true);
  });

  it('keeps the page count and the report line honest for a one-page selection', async () => {
    const { result, rasters } = await runRaster({ pages: String(COLOUR_PAGE) });
    expect(rasters).toHaveLength(1);
    expect(result.pages).toBe(1);
    expect(result.message).toMatch(/Re-rendered 1 page\(s\) at 72 dpi/);
  });
});

describe('pdf-to-greyscale, Method = Recolour (the default) still works', () => {
  it('rewrites the colour operators, keeps every page, and never renders a canvas', async () => {
    const source = await openPDF(await greyscaleFixture());
    expect(pageUsesColor(source.getPage(0)), 'the fixture no longer paints with colour').toBe(true);

    const before = held.applied.length + held.earlyReads;
    const { result, doc } = await runTool('pdf-to-greyscale', { mode: 'vectors', pages: 'all', dpi: 72 });
    expect(doc.getPageCount(), 'the operator path does not drop pages').toBe(PAGES.length);
    for (const [index, page] of doc.getPages().entries()) {
      expect(pageUsesColor(page), `page ${index + 1} still paints with colour`).toBe(false);
    }
    expect(result.message).toMatch(/colour operation|Text stays selectable/i);
    expect(result.pages).toBe(PAGES.length);
    expect(
      held.applied.length + held.earlyReads - before,
      'the default method started rendering canvases',
    ).toBe(0);
  });

  it('the two methods produce different bytes for the same page', async () => {
    const raster = await runRaster({ pages: String(COLOUR_PAGE) });
    const vectors = await runTool('pdf-to-greyscale', { mode: 'vectors', pages: String(COLOUR_PAGE), dpi: 72 });
    const rasterPage = raster.doc.getPage(0);
    const vectorPage = vectors.doc.getPage(0);
    const images = (page: PDFPage) => {
      const resources = dictOf(raster.doc, page.node.Resources());
      const xobjects = dictOf(raster.doc, resources?.get(PDFName.of('XObject')));
      return xobjects ? [...xobjects.entries()].filter(([, v]) => streamOf(raster.doc, v)).length : 0;
    };
    expect(images(rasterPage), 'the raster method wrote no image').toBeGreaterThan(0);
    expect(images(vectorPage), 'the operator path wrote an image: the segment did not switch').toBe(0);
  });
});
