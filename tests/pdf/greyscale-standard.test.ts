/**
 * One greyscale standard, measured on the chart.
 *
 * The app used to run two. `core/content.ts:luminance` recoloured PDF operators with
 * BT.601 while every canvas path recoloured with CSS `grayscale(1)`, which is Rec.709 —
 * so `pdf-to-greyscale` answered a different grey for the same page depending on which
 * half of its own segmented control the user touched, and neither answer was necessarily
 * the one the preview showed. `core/colour.ts` now holds the coefficients once. This file
 * proves that on `docs/research/greyscale-chart.pdf`: 24 swatches of known colour, drawn
 * by the campaign's own fixture generator and measured with the campaign's own
 * region-inset rule.
 *
 * Four claims, each needing a different instrument:
 *
 * 1. **One triple.** `LUMA_COEFFICIENTS` equals the Filter Effects formula, literalled
 *    independently here in the stub canvas as `CSS_GRAY` — so the check is against the
 *    browser's spec, not against the app quoting itself. A walk of `src/` then finds the
 *    coefficient triples in exactly the files the decision accounts for.
 * 2. **Every path agrees, per swatch.** Recolour (operators, `core/content.ts`),
 *    Re-render (`core/measure.ts:applyColorFilter`), `adjust-colors` and `scanner-effect`
 *    (both through `tools/edit.ts:rerasterise`) land on the grey `CSS_GRAY` predicts,
 *    within one 8-bit unit of each other.
 * 3. **Distinct colours do not collapse.** No two swatches of different colour end up on
 *    the same integer grey in any path — the failure mode a luma choice can create, and
 *    the reason the chart carries red-ink against pink, green-ink against violet and
 *    magenta against the fixture red.
 * 4. **Grey is a fixed point.** `luma255(v, v, v) === v` for all 256 tones, produced
 *    greys have channel spread exactly 0, and a second pass moves nothing. Same shape of
 *    property `invert-colors` pins for inversion.
 *
 * jsdom has no 2-D raster, so this file installs a pixel-true canvas and a pdf.js double
 * that paints the chart's own regions from the chart's own JSON table. The shipped
 * tool → `core/measure` → `canvasToBlob` → `embedJpg` chain stays real: what is measured
 * is the image the produced file carries.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  decodePDFRawStream,
  openPDF,
} from '@/lib/pdf/core/doc';
import type { PDFPage } from '@/lib/pdf/core/doc';
import { LUMA_COEFFICIENTS, luma01, luma255 } from '@/lib/pdf/core/colour';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { defaultValues, type ToolFile, type ToolValues } from '@/lib/pdf/tools/types';

/* ── the chart: one artefact, one table, both committed with the generator ─── */

interface Swatch {
  name: string;
  rgb: [number, number, number];
  region: { x0: number; y0: number; x1: number; y1: number };
  grey709: number;
  grey601: number;
}

const CHART_PDF = new Uint8Array(readFileSync('docs/research/greyscale-chart.pdf'));
const CHART = JSON.parse(readFileSync('docs/research/greyscale-chart.json', 'utf8')) as {
  sheet: { widthPt: number; heightPt: number };
  swatches: Swatch[];
};
const SWATCHES = CHART.swatches;
const SHEET: [number, number] = [CHART.sheet.widthPt, CHART.sheet.heightPt];

/* ── the browser's rule, spelled independently of the app's ───────────────── */

/**
 * `grayscale(1)` per the Filter Effects colour-interpolation reference: every channel
 * becomes `0.2126R + 0.7152G + 0.0722B`. Literalled here on purpose — if the stub
 * imported `LUMA_COEFFICIENTS`, claim 1 would be the app agreeing with itself and the
 * browser would get no vote.
 */
const CSS_GRAY: [number, number, number] = [0.2126, 0.7152, 0.0722];
/** `contrast(k)` and `brightness(b)` from the same reference, in 0..255 space. */
const CSS_CONTRAST = (v: number, k: number) => (v / 255 - 0.5) * k * 255 + 127.5;
const CSS_BRIGHTNESS = (v: number, b: number) => (v / 255) * b * 255;

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
const spreadOf = (p: readonly number[]) => Math.max(...p) - Math.min(...p);

/**
 * The two standards, as the chart's own table records them. Used only to print the
 * before/after column pair — never to decide a pass or a fail, so a change to the shared
 * triple cannot quietly move the goalposts with it.
 */

/* ── a pixel-true canvas ──────────────────────────────────────────────────── */

interface Bitmap {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

const surfaces = new WeakMap<HTMLCanvasElement, Bitmap>();
const pageCanvases = new WeakMap<HTMLCanvasElement, number>();
/** Every filter string that reached a real draw, so "the switch reached the paint" is measured. */
const applied = vi.hoisted(() => [] as { page: number; filter: string }[]);

function surfaceOf(canvas: HTMLCanvasElement): Bitmap {
  const width = Math.max(0, Math.trunc(canvas.width) || 0);
  const height = Math.max(0, Math.trunc(canvas.height) || 0);
  const existing = surfaces.get(canvas);
  if (!existing || existing.width !== width || existing.height !== height) {
    const created: Bitmap = { width, height, data: new Uint8ClampedArray(width * height * 4) };
    surfaces.set(canvas, created);
    return created;
  }
  return existing;
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

/** The filter subset these tools compose: grayscale, brightness, contrast, in CSS order. */
function applyFilter(bitmap: Bitmap, filter: string): Bitmap {
  const parts = [...filter.matchAll(/([a-z-]+)\(([-0-9.]+)\)/g)].map(
    (m) => [m[1], Number(m[2])] as const,
  );
  const data = new Uint8ClampedArray(bitmap.data);
  for (let i = 0; i + 3 < data.length; i += 4) {
    const px = [data[i], data[i + 1], data[i + 2]];
    for (const [name, value] of parts) {
      if (name === 'grayscale' && value === 1) {
        const g = CSS_GRAY[0] * px[0] + CSS_GRAY[1] * px[1] + CSS_GRAY[2] * px[2];
        px[0] = px[1] = px[2] = g;
      } else if (name === 'contrast') {
        px[0] = CSS_CONTRAST(px[0], value);
        px[1] = CSS_CONTRAST(px[1], value);
        px[2] = CSS_CONTRAST(px[2], value);
      } else if (name === 'brightness') {
        px[0] = CSS_BRIGHTNESS(px[0], value);
        px[1] = CSS_BRIGHTNESS(px[1], value);
        px[2] = CSS_BRIGHTNESS(px[2], value);
      } else {
        throw new Error(`the stub canvas cannot apply ${name}(${value})`);
      }
    }
    for (let c = 0; c < 3; c++) data[i + c] = clamp255(px[c]);
  }
  return { width: bitmap.width, height: bitmap.height, data };
}

function applyFilterIfAny(bitmap: Bitmap, filter: string): Bitmap {
  return filter && filter !== 'none' ? applyFilter(bitmap, filter) : bitmap;
}

class StubContext {
  filter = 'none';
  fillStyle = '#000000';
  globalAlpha = 1;
  globalCompositeOperation = 'source-over';
  imageSmoothingEnabled = true;
  imageSmoothingQuality: 'low' | 'medium' | 'high' = 'low';
  ctm: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];

  constructor(readonly canvas: HTMLCanvasElement) {}

  save(): void {}
  restore(): void {}
  clearRect(): void {
    const surface = surfaceOf(this.canvas);
    surface.data.fill(0);
  }
  setTransform(a: number, _b: number, _c: number, d: number, e: number, f: number): void {
    this.ctm = [a, 0, 0, d, e, f];
  }
  transform(a: number, _b: number, _c: number, d: number, e: number, f: number): void {
    const [ca, , , cd, ce, cf] = this.ctm;
    this.ctm = [ca * a, 0, 0, cd * d, ca * e + ce, cd * f + cf];
  }

  createImageData(width: number, height: number): ImageData {
    return new ImageData(new Uint8ClampedArray(width * height * 4), width, height);
  }

  getImageData(x: number, y: number, width: number, height: number): ImageData {
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
    const w = Math.round(width * a);
    const h = Math.round(height * d);
    const surface: Bitmap = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    for (let i = 0; i + 3 < surface.data.length; i += 4) {
      surface.data[i] = r;
      surface.data[i + 1] = g;
      surface.data[i + 2] = b;
      surface.data[i + 3] = 255;
    }
    this.blit(applyFilterIfAny(surface, this.filter), Math.round(x + tx), Math.round(y + ty));
  }

  drawImage(source: HTMLCanvasElement, dx = 0, dy = 0): void {
    const [a, , , d, tx, ty] = this.ctm;
    const src = surfaceOf(source);
    let bitmap = src;
    if (this.filter !== 'none') {
      const page = pageCanvases.get(source);
      if (page) applied.push({ page, filter: this.filter });
      bitmap = applyFilterIfAny(src, this.filter);
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
    for (let row = 0; row < source.height; row++) {
      const ty = dy + row;
      if (ty < 0 || ty >= dst.height) continue;
      for (let col = 0; col < source.width; col++) {
        const tx = dx + col;
        if (tx < 0 || tx >= dst.width) continue;
        const from = (row * source.width + col) * 4;
        const to = (ty * dst.width + tx) * 4;
        const sa = (source.data[from + 3] / 255) * this.globalAlpha;
        for (let c = 0; c < 3; c++) {
          dst.data[to + c] = copy
            ? source.data[from + c]
            : Math.round(dst.data[to + c] * (1 - sa) + source.data[from + c] * sa);
        }
        dst.data[to + 3] = Math.min(255, Math.round(dst.data[to + 3] + source.data[from + 3] * this.globalAlpha));
      }
    }
  }
}

/** A lossless container wearing a JPEG's clothes: `embedJpg` needs a parseable `/SOF0`. */
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
    return kind === '2d' ? new StubContext(this) : null;
  };
  proto.toBlob = function toBlob(
    this: HTMLCanvasElement,
    cb: (blob: Blob | null) => void,
    type?: string,
  ): void {
    const surface = surfaceOf(this);
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
    Object.defineProperty(globalThis, 'ImageData', {
      value: ShimImageData,
      configurable: true,
      writable: true,
    });
  }
}

/* ── the pdf.js double: paints the chart's regions, from the chart's own table ── */

vi.mock('pdfjs-dist', () => {
  let requestedPage = 1;
  const doc = {
    get numPages() {
      return 2;
    },
    fingerprints: ['greyscale-chart'],
    getPage: async (n: number) => {
      requestedPage = n;
      const [w, h] = SHEET;
      return {
        rotate: n === 2 ? 90 : 0,
        getViewport: ({ scale }: { scale: number }) => ({
          width: Math.floor((n === 2 ? h : w) * scale),
          height: Math.floor((n === 2 ? w : h) * scale),
          scale,
        }),
        getTextContent: async () => ({ items: [] }),
        cleanup: () => {},
        render: ({ canvasContext }: { canvasContext: StubContext }) => {
          const canvas = canvasContext.canvas;
          pageCanvases.set(canvas, requestedPage);
          canvasContext.fillStyle = '#ffffff';
          canvasContext.fillRect(0, 0, canvas.width, canvas.height);
          canvasContext.save();
          canvasContext.filter = 'none';
          let settle: () => void = () => {};
          const promise = new Promise<void>((resolve) => {
            settle = resolve;
          });
          setTimeout(() => {
            paintSwatches(canvas);
            settle();
          }, 0);
          return { promise, cancel: () => {}, onContinue: () => {} };
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

/**
 * Paint the swatches in **displayed** fractions, y downwards — the same space
 * `colour-ink.py`, `greyscale-chart-read.py` and a viewer use. Sheet 2 carries
 * `/Rotate 90`; the chart generator placed its ink through the turn precisely so the
 * displayed table is identical on both pages, which is what lets this double paint one
 * table and the assertions read one table.
 */
function paintSwatches(canvas: HTMLCanvasElement): void {
  const surface = surfaceOf(canvas);
  surface.data.fill(0);
  for (const swatch of SWATCHES) {
    const { x0, y0, x1, y1 } = swatch.region;
    const ax = Math.round(x0 * surface.width);
    const bx = Math.round(x1 * surface.width);
    const ay = Math.round(y0 * surface.height);
    const by = Math.round(y1 * surface.height);
    for (let y = ay; y < by; y++) {
      for (let x = ax; x < bx; x++) {
        const at = (y * surface.width + x) * 4;
        surface.data[at] = swatch.rgb[0];
        surface.data[at + 1] = swatch.rgb[1];
        surface.data[at + 2] = swatch.rgb[2];
        surface.data[at + 3] = 255;
      }
    }
  }
}

/* ── reading a produced page back ─────────────────────────────────────────── */

function dictOf(doc: PDFDocument, value: unknown): PDFDict | null {
  const resolved = value instanceof PDFRef ? doc.context.lookup(value) : value;
  return resolved instanceof PDFDict ? resolved : null;
}

function streamOf(doc: PDFDocument, value: unknown): PDFRawStream | null {
  let resolved = value instanceof PDFRef ? doc.context.lookup(value) : value;
  if (resolved instanceof PDFArray) {
    // `savePDF` may split a page's content across an array of streams; the greys are
    // written in order, so joining them is the program a viewer runs.
    resolved = doc.context.lookup(resolved.asArray()[0]);
  }
  return resolved instanceof PDFRawStream ? resolved : null;
}

function numberAt(dict: PDFDict, key: string): number {
  const value = dict.get(PDFName.of(key));
  return value instanceof PDFNumber ? Math.trunc(value.asNumber()) : NaN;
}

function decodeStubJpeg(bytes: Uint8Array): Uint8Array {
  const chunks: Buffer[] = [];
  for (let i = 2; i + 3 < bytes.length; i++) {
    if (bytes[i] !== 0xff) continue;
    const marker = bytes[i + 1];
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker === 0xfe) chunks.push(Buffer.from(bytes.subarray(i + 4, i + 2 + length)));
    else if (marker === 0xd9) break;
    i += 1 + length;
  }
  return new Uint8Array(inflateSync(Buffer.concat(chunks)));
}

function embeddedRaster(doc: PDFDocument, page: PDFPage): Bitmap {
  const resources = dictOf(doc, page.node.Resources());
  const xobjects = dictOf(doc, resources?.get(PDFName.of('XObject')));
  expect(xobjects, 'the page drew no image').not.toBeNull();
  const images = [...xobjects!.entries()]
    .map(([, value]) => streamOf(doc, value))
    .filter((stream): stream is PDFRawStream => stream !== null);
  expect(images, 'exactly one image XObject per rasterised page').toHaveLength(1);
  const stream = images[0];
  const width = numberAt(stream.dict, 'Width');
  const height = numberAt(stream.dict, 'Height');
  const filterName = `${stream.dict.get(PDFName.of('Filter'))}`;
  const raw =
    filterName === '/FlateDecode'
      ? new Uint8Array(inflateSync(Buffer.from(stream.contents)))
      : new Uint8Array(stream.contents);
  const samples = filterName === '/DCTDecode' ? decodeStubJpeg(raw) : raw;
  expect(samples.length, 'the stored samples are not Width×Height×3').toBe(width * height * 3);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    for (let c = 0; c < 3; c++) data[i * 4 + c] = samples[i * 3 + c];
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

/** The mean colour of one swatch in a bitmap, inset exactly as `colour-ink.py` insets it. */
function swatchMean(bitmap: Bitmap, swatch: Swatch): [number, number, number] {
  const { x0, y0, x1, y1 } = swatch.region;
  const ax = Math.round(x0 * bitmap.width);
  const bx = Math.round(x1 * bitmap.width);
  const ay = Math.round(y0 * bitmap.height);
  const by = Math.round(y1 * bitmap.height);
  const pad = Math.max(2, Math.round(0.02 * Math.min(bx - ax, by - ay)));
  const total = [0, 0, 0];
  let count = 0;
  for (let y = ay + pad; y < by - pad; y++) {
    for (let x = ax + pad; x < bx - pad; x++) {
      const at = (y * bitmap.width + x) * 4;
      for (let c = 0; c < 3; c++) total[c] += bitmap.data[at + c];
      count += 1;
    }
  }
  expect(count, `swatch ${swatch.name} covers no pixel at this size`).toBeGreaterThan(0);
  return [total[0] / count, total[1] / count, total[2] / count];
}

const swatchGrey = (bitmap: Bitmap, swatch: Swatch): number => swatchMean(bitmap, swatch)[0];

/**
 * The grey the Recolour path wrote, read off the operators rather than recomputed.
 *
 * `drawRectangle` lays a sheet out as `q  <colour> g  …  1 0 0 1 x y cm  0 0 m … f  Q`, so
 * the rectangle's own placement matrix is what identifies it: the `g` / `G` operand ahead
 * of *this* swatch's `cm` is the grey a viewer paints. `x y` are `rectOf`'s lower-left for
 * the chart's displayed fractions, so the pairing is made with the geometry the sheet was
 * drawn with rather than with the order the operators happen to come out in.
 */
function swatchOperatorGrey(doc: PDFDocument, page: PDFPage, swatch: Swatch): number {
  const contents = page.node.Contents();
  const value = contents instanceof PDFRef ? doc.context.lookup(contents) : contents;
  const parts = value instanceof PDFArray ? value.asArray() : [value];
  const text = parts
    .map((part) => streamOf(doc, part))
    .filter((stream): stream is PDFRawStream => stream !== null)
    .map((stream) => new TextDecoder().decode(decodePDFRawStream(stream).decode()))
    .join('\n');
  const [wantX, wantY] = [
    swatch.region.x0 * SHEET[0],
    SHEET[1] - swatch.region.y1 * SHEET[1],
  ];
  let pending: number | null = null;
  for (const line of text.split(/\s*\n\s*/)) {
    const grey = /^([-\d.]+) (?:g|G)$/.exec(line);
    if (grey) {
      pending = Number(grey[1]);
      continue;
    }
    const place = /^1 0 0 1 ([-\d.]+) ([-\d.]+) cm$/.exec(line);
    if (!place || pending === null) continue;
    if (Math.abs(Number(place[1]) - wantX) < 0.6 && Math.abs(Number(place[2]) - wantY) < 0.6) {
      const found = pending * 255;
      pending = null;
      return found;
    }
    pending = null;
  }
  throw new Error(`the recoloured page wrote no grey operator for swatch ${swatch.name}`);
}

/* ── running the shipped tools on the chart ───────────────────────────────── */

function fileOf(bytes: Uint8Array, name = 'greyscale-chart.pdf'): ToolFile {
  return {
    name,
    size: bytes.byteLength,
    type: 'application/pdf',
    bytes: async () => new Uint8Array(bytes),
    blob: () => new Blob([bytes], { type: 'application/pdf' }),
  };
}

async function runTool(id: string, values: ToolValues, bytes: Uint8Array = CHART_PDF) {
  const tool = getPdfTool(id);
  expect(tool, `${id} is not registered`).toBeTruthy();
  const result = (await tool!.run!({
    inputs: [fileOf(bytes)],
    values: { ...defaultValues(tool!.fields), ...values },
    progress: () => {},
    log: () => {},
    signal: new AbortController().signal,
  }))!;
  expect(result.kind, `${id} returned ${result.kind}, not a PDF`).toBe('pdf');
  const produced = (result as { bytes: Uint8Array }).bytes;
  return { result: result as { kind: 'pdf'; bytes: Uint8Array; pages: number; message?: string }, produced, doc: await openPDF(produced) };
}

/**
 * 96 dpi is the lowest resolution these rails allow, and at 96 the chart is 560 × 793
 * px — small enough that every pixel of all 24 swatches is walked by the pure helpers in
 * a second, large enough that the region inset still leaves thousands of samples.
 */
const DPI = 96;

/** Every path that promises "this page, in grey" with nothing else done to the look. */
async function plainGreyPaths() {
  const recolour = await runTool('pdf-to-greyscale', { mode: 'vectors', pages: '1' });
  const render = await runTool('pdf-to-greyscale', { mode: 'raster', pages: '1', dpi: DPI });
  const adjust = await runTool('adjust-colors', { grayscale: true, pages: '1', dpi: DPI });
  const renderRaster = embeddedRaster(render.doc, render.doc.getPage(0));
  const adjustRaster = embeddedRaster(adjust.doc, adjust.doc.getPage(0));
  return {
    'Recolour (operators)': (sw: Swatch) => swatchOperatorGrey(recolour.doc, recolour.doc.getPage(0), sw),
    'Re-render (applyColorFilter)': (sw: Swatch) => swatchGrey(renderRaster, sw),
    'adjust-colors (rerasterise)': (sw: Swatch) => swatchGrey(adjustRaster, sw),
  } as Record<string, (sw: Swatch) => number>;
}

beforeAll(() => {
  installCanvas();
});

/* ── 1. one triple ────────────────────────────────────────────────────────── */

describe('the coefficients exist in exactly one place', () => {
  it('is the Filter Effects formula the browser uses, not a private preference', () => {
    expect([LUMA_COEFFICIENTS.r, LUMA_COEFFICIENTS.g, LUMA_COEFFICIENTS.b]).toEqual(CSS_GRAY);
  });

  it('sums to exactly 1, which is what makes grey a fixed point', () => {
    expect(LUMA_COEFFICIENTS.r + LUMA_COEFFICIENTS.g + LUMA_COEFFICIENTS.b).toBe(1);
  });

  it('has no second copy in the modules that used to own one', async () => {
    const measure = await import('@/lib/pdf/core/measure');
    expect(
      (measure as Record<string, unknown>).lumaOf,
      'core/measure.ts still exports its own luma',
    ).toBeUndefined();
    // The number the decision turned on: the fixture red, on the operator scale the
    // Recolour path writes. 69 under Rec.709, 87 under the retired BT.601.
    expect(luma01(230 / 255, 26 / 255, 26 / 255) * 255).toBeCloseTo(69.37, 1);
  });

  it('is the only coefficient triple left in a greyscale-of-a-document path', async () => {
    const { execFileSync } = await import('node:child_process');
    const pattern = '0\\.299|0\\.587|0\\.114|0\\.2126|0\\.7152|0\\.0722';
    const hits = execFileSync('grep', ['-rl', '--include=*.ts', '--include=*.tsx', '-E', pattern, 'src/'])
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean)
      .sort();
    // Every file here is accounted for in `docs/research/greyscale-standard-decision.md`,
    // and the last four are deliberately excluded with a reason — naming them is what
    // stops a later reader "fixing" them into a third standard.
    expect(hits).toEqual(
      [
        'src/lib/pdf/core/colour.ts', // the definition, and the only one
        'src/lib/ocr/engine.ts', // OCR preprocessing: never a colour the user downloads
        'src/lib/pdf/tools/security.ts', // the compare page's faded background, not a conversion
        'src/components/tools/pdf/scan/ScanMain.tsx', // camera enhancement, its own look
        'src/components/tools/pdf/text-editor/model.ts', // contrast picking, already Rec.709
      ].sort(),
    );
  });
});

/* ── 2+3. every swatch, every path ────────────────────────────────────────── */

describe('every greyscale path lands on the same grey, per swatch', () => {
  it('Recolour, Re-render and adjust-colors agree within one unit', async () => {
    const paths = await plainGreyPaths();
    const names = Object.keys(paths);
    const measured = SWATCHES.map((swatch) => ({
      swatch,
      values: names.map((name) => [name, paths[name](swatch)] as const),
    }));
    // Printed before anything is asserted, so the table lands on a red run too — the
    // number that failed is the number the decision has to quote.
    console.log(
      `\n── the chart table, ${names.length} plain-grey paths × ${SWATCHES.length} swatches\n`
        + `   ${'path'.padEnd(34)}${names.map((n) => n.padStart(12)).join('')}`.padEnd(4)
        + `\n${measured
            .map(
              ({ swatch, values }) =>
                `${swatch.name.padEnd(15)} rgb ${swatch.rgb.join(',').padEnd(11)}`
                + ` 601 ${swatch.grey601.toFixed(1).padStart(6)}`
                + ` 709 ${swatch.grey709.toFixed(1).padStart(6)}`
                + values.map(([, v]) => ` ${v.toFixed(1).padStart(7)}`).join(''),
            )
            .join('\n')}\n`,
    );
    for (const { swatch, values } of measured) {
      const lo = Math.min(...values.map(([, v]) => v));
      const hi = Math.max(...values.map(([, v]) => v));
      for (const [name, v] of values) {
        expect(
          Math.abs(v - swatch.grey709),
          `${swatch.name} through ${name}: ${v.toFixed(1)}, the standard says ${swatch.grey709.toFixed(1)}`,
        ).toBeLessThanOrEqual(1);
      }
      expect(hi - lo, `${swatch.name}: the paths disagree by ${(hi - lo).toFixed(2)}`).toBeLessThanOrEqual(1);
    }
  });

  it('removes the colour completely: channel spread is 0 on every swatch', async () => {
    const { doc } = await runTool('pdf-to-greyscale', { mode: 'raster', pages: '1', dpi: DPI });
    const raster = embeddedRaster(doc, doc.getPage(0));
    for (const swatch of SWATCHES) {
      const mean = swatchMean(raster, swatch);
      expect(spreadOf(mean), `${swatch.name} came back tinted: ${mean.map((v) => v.toFixed(1))}`).toBe(0);
    }
  });

  it('scanner-effect greys with the same standard even though its look moves', async () => {
    // Contrast, whitening and sharpen are the point of that tool, so at defaults the
    // agreement to prove is that the page is grey **and ordered by the shared luma** —
    // not that it equals the plain grey.
    const atDefaults = await runTool('scanner-effect', { pages: '1', dpi: DPI });
    const scanned = embeddedRaster(atDefaults.doc, atDefaults.doc.getPage(0));
    const byDefaults = SWATCHES.map((s) => ({ name: s.name, grey: swatchGrey(scanned, s), luma: s.grey709 }));
    for (const one of byDefaults) {
      expect(spreadOf(swatchMean(scanned, SWATCHES.find((s) => s.name === one.name)!))).toBe(0);
    }
    const sorted = [...byDefaults].sort((a, b) => a.luma - b.luma);
    for (let i = 1; i < sorted.length; i++) {
      expect(
        sorted[i].grey >= sorted[i - 1].grey - 1,
        `${sorted[i].name} (luma ${sorted[i].luma.toFixed(1)}) came back lighter than ${sorted[i - 1].name} (${sorted[i - 1].luma.toFixed(1)})`,
      ).toBe(true);
    }
    // With every look-pass off, the tool is the plain operator: same grey, one unit.
    const flat = await runTool('scanner-effect', {
      pages: '1',
      dpi: DPI,
      whitening: false,
      sharpen: false,
      grayscale: true,
      contrast: 1,
    });
    const flatRaster = embeddedRaster(flat.doc, flat.doc.getPage(0));
    for (const swatch of SWATCHES) {
      expect(
        Math.abs(swatchGrey(flatRaster, swatch) - swatch.grey709),
        `scanner-effect with its passes off is not the shared grey for ${swatch.name}`,
      ).toBeLessThanOrEqual(1);
    }
  });

  it('keeps distinct colours distinct: no two swatches collapse to one grey', async () => {
    const paths = await plainGreyPaths();
    const report: string[] = [];
    for (const [name, read] of Object.entries(paths)) {
      const seen = new Map<number, string>();
      for (const swatch of SWATCHES) {
        const grey = Math.round(read(swatch));
        const clash = seen.get(grey);
        expect(
          clash === undefined,
          `${name}: ${clash} and ${swatch.name} both collapsed to grey ${grey}`,
        ).toBe(true);
        seen.set(grey, swatch.name);
      }
      report.push(`${name}: ${seen.size} distinct greys over ${SWATCHES.length} distinct colours`);
    }
    console.log(`\n── collapse check\n${report.map((r) => `   ${r}`).join('\n')}\n`);
  });

  it('reports the pairs that come closest, rather than hiding them', async () => {
    const paths = await plainGreyPaths();
    const lines: string[] = [];
    for (const [name, read] of Object.entries(paths)) {
      const pairs: [number, string, string][] = [];
      for (let i = 0; i < SWATCHES.length; i++) {
        for (const other of SWATCHES.slice(i + 1)) {
          pairs.push([Math.abs(read(SWATCHES[i]) - read(other)), SWATCHES[i].name, other.name]);
        }
      }
      pairs.sort((a, b) => a[0] - b[0]);
      lines.push(`${name.padEnd(30)} ` + pairs.slice(0, 4).map(([d, x, y]) => `${x}/${y} ${d.toFixed(1)}`).join('  '));
    }
    console.log(
      '\n── closest pairs under the standard now in force (8-bit units apart)\n'
        + lines.map((l) => `   ${l}`).join('\n')
        + '\n',
    );
    // Nothing merges. If a future swatch makes something merge, the collapse check above
    // fails and the pair has to be reported rather than special-cased.
    for (const [name, read] of Object.entries(paths)) {
      const greys = SWATCHES.map(read).map((g) => Math.round(g));
      expect(new Set(greys).size, `${name} collapsed two swatches onto one grey`).toBe(SWATCHES.length);
    }
  });
});

/* ── 4. the greyscale-ness invariant ──────────────────────────────────────── */

describe('grey is a fixed point of the standard', () => {
  it('leaves all 256 tones untouched, on both scales', () => {
    for (let v = 0; v < 256; v++) {
      // Exact after rounding, and within float noise before it: `luma255(144,144,144)`
      // is 144 + 2.8e-14, which is the same grey to a viewer and to every caller here.
      expect(luma255(v, v, v), `tone ${v} moved on the 0..255 scale}`).toBeCloseTo(v, 9);
      expect(Math.round(luma255(v, v, v)), `tone ${v} rounded away`).toBe(v);
      expect(Math.round(luma01(v / 255, v / 255, v / 255) * 255), `tone ${v} moved on the PDF scale`).toBe(v);
    }
  });

  it('does not move a swatch through a second pass of the operator path', async () => {
    const once = await runTool('pdf-to-greyscale', { mode: 'vectors', pages: '1' });
    const twice = await runTool('pdf-to-greyscale', { mode: 'vectors', pages: '1' }, once.produced);
    for (const swatch of SWATCHES) {
      const first = swatchOperatorGrey(once.doc, once.doc.getPage(0), swatch);
      const second = swatchOperatorGrey(twice.doc, twice.doc.getPage(0), swatch);
      expect(
        Math.abs(second - first),
        `${swatch.name}: ${first.toFixed(2)} → ${second.toFixed(2)} on a second pass`,
      ).toBeLessThanOrEqual(0.01);
      expect(spreadOf([second, second, second])).toBe(0);
    }
  });

  it('does not move an already-grey page through the raster path either', async () => {
    const grey = await runTool('pdf-to-greyscale', { mode: 'raster', pages: '1', dpi: DPI });
    const raster = embeddedRaster(grey.doc, grey.doc.getPage(0));
    const again = await runTool('pdf-to-greyscale', { mode: 'raster', pages: '1', dpi: DPI }, grey.produced);
    const againRaster = embeddedRaster(again.doc, again.doc.getPage(0));
    expect(againRaster.width, 'the second pass did not photograph the same sheet').toBe(raster.width);
    for (const swatch of SWATCHES) {
      expect(
        Math.abs(swatchGrey(againRaster, swatch) - swatchGrey(raster, swatch)),
        `${swatch.name} tinted or moved on a second greyscale pass`,
      ).toBeLessThanOrEqual(1);
      expect(spreadOf(swatchMean(againRaster, swatch))).toBe(0);
    }
  });

  it('takes the bilevel cut on the same luma as everything else', async () => {
    const { thresholdPixels } = await import('@/lib/pdf/core/measure');
    // red-ink (220,38,38): Rec.709 says 76.7, the retired BT.601 said 92.4. A cutoff of
    // 85 splits the two answers, so this single pixel is the standard under test.
    const edge = new Uint8ClampedArray([220, 38, 38, 255]);
    thresholdPixels(edge, 85);
    expect(edge[0], 'the cut is not being taken on the shared luma').toBe(0);
    // Achromatic controls: the cut must not invent a tint on a page that has none.
    const grey = new Uint8ClampedArray([200, 200, 200, 255, 10, 10, 10, 255]);
    thresholdPixels(grey, 128);
    expect([grey[0], grey[1], grey[2], grey[4], grey[5], grey[6]]).toEqual([255, 255, 255, 0, 0, 0]);
  });

  it('reaches the paint exactly once per rendered page', async () => {
    applied.length = 0;
    await runTool('pdf-to-greyscale', { mode: 'raster', pages: '1', dpi: DPI });
    expect(applied.map((a) => a.filter)).toEqual(['grayscale(1)']);
    expect(applied.map((a) => a.page)).toEqual([1]);
  });
});
