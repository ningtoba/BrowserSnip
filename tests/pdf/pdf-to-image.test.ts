/**
 * `pdf-to-image` — one file per selected page, and each file holds that page.
 *
 * The caller audit (`docs/TOOL-CAMPAIGN.md`) measured the deployed export as a
 * zip of **four identical 44 128-byte PNGs at 0.00 % non-white ink** under a line
 * reading "Export images". That sentence has two causes and they are different
 * bugs:
 *
 * 1. every page is blank, so four sheets of one size compress to one length; or
 * 2. the loop exports the *same* page N times — a stale index, a hoisted canvas,
 *    or one promise awaited once and reused.
 *
 * An ink assertion alone passes (2) and ships a tool that ignores the page the
 * user picked, so this file pins both halves with a fixture whose five sheets
 * differ in **size as well as ink**: a dark block, a light block, body copy, a
 * photograph, and an empty control.
 *
 * · Every output decodes to the pixel size of the page its own name names, and
 *   the five are pairwise distinct in size, byte length and SHA-256 — one sheet
 *   cannot stand in for five.
 * · Each output's non-white count **equals** the count taken off the same canvas
 *   the moment `render.finished` resolved. That is the comparison the deskew and
 *   rasterize passes settled on: measured against the source, never against an
 *   invented threshold. The empty sheet pins the instrument at 0 so the other
 *   four figures cannot be a constant.
 * · `renderPage` is asked for exactly the selected pages, in order (the
 *   structural witness for the same claim), and no page canvas is read before
 *   its paint lands.
 *
 * Standing rule 1 binds the double below: it applies only the synchronous
 * `background` fill when `renderPage` settles and lands the ink in a **later
 * task**, so an unawaited paint encodes paper. `finished: Promise.resolve()` is
 * what the older double in `edge-convert-from.test.ts` returns, and it is the
 * reason 80 green tests here never saw the defect. Geometry stays real pdf.js —
 * the wrapper patches `renderPage` on a session built by the real `openRender`,
 * so "dpi sets the pixel dimensions" is measured rather than asserted about a
 * stub.
 *
 * What jsdom cannot do is compress: `toBlob` is a pixel-true shim whose PNG is
 * real (filter 0 + zlib) and whose JPEG is a JPEG container carrying the same
 * samples deflated. That makes the ink comparison exact on both branches and
 * leaves "a lower JPEG quality makes a smaller file" to the Chromium half of this
 * row (`docs/research/pdf-to-image-controls.mjs`), which this file does not claim.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import * as pdfjs from 'pdfjs-dist';
import { PDFDict, PDFDocument, PDFName, PDFRawStream, StandardFonts, rgb } from '@maxwbh/pdf-lib';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { readZip } from '@/lib/pdf/core/archive';
import type { PageRender } from '@/lib/pdf/core/render';
import { defaultValues, type ToolFile, type ToolResult, type ToolValues } from '@/lib/pdf/tools/types';

const require = createRequire(import.meta.url);
/**
 * `core/render` derives `workerSrc` from `import.meta.url`, which Vitest serves
 * over `http:` and the ESM loader refuses; pin the real worker file so pdf.js's
 * viewport maths (the geometry this file measures) runs for real.
 */
const WORKER_SRC = pathToFileURL(require.resolve('pdfjs-dist/build/pdf.worker.mjs')).href;
Object.defineProperty(pdfjs.GlobalWorkerOptions, 'workerSrc', {
  configurable: true,
  get: () => WORKER_SRC,
  set: () => undefined,
});

/* ── the fixture: five sheets, five sizes, five amounts of ink ─────────────── */

type SheetKind = 'dark' | 'light' | 'text' | 'photo' | 'empty';

const SHEETS: { kind: SheetKind; size: [number, number] }[] = [
  { kind: 'dark', size: [200, 260] },
  { kind: 'light', size: [240, 300] },
  { kind: 'text', size: [180, 240] },
  { kind: 'photo', size: [260, 200] },
  { kind: 'empty', size: [220, 220] },
];

const double = vi.hoisted(() => ({
  /** Page numbers handed to `renderPage`, in call order. */
  requested: [] as number[],
  /** The scale each of those calls was asked for. */
  scales: [] as number[],
  /** The bitmap as it stood when `finished` resolved — the known-good reading. */
  painted: new Map<number, { data: Uint8ClampedArray; width: number; height: number }>(),
  /** Reads of a *page* canvas taken before its paint had landed. */
  readsBeforePaint: 0,
  /** Every `finished` handed out, so a test can wait for the paints it skipped. */
  settles: [] as Promise<void>[],
  /** What each `toBlob` call was asked for, in encoder order. */
  encodes: [] as { mime: string; quality: number | undefined; width: number; height: number }[],
}));
/* ── a pixel-true canvas for jsdom ────────────────────────────────────────── */

interface Surface {
  width: number;
  height: number;
  /** RGBA, row-major, top row first — the order `getImageData` reports. */
  data: Uint8ClampedArray;
}

const surfaces = new WeakMap<HTMLCanvasElement, Surface>();
const pageCanvases = new WeakSet<HTMLCanvasElement>();
const landed = new WeakSet<HTMLCanvasElement>();

function surfaceOf(canvas: HTMLCanvasElement): Surface {
  const width = Math.max(0, Math.trunc(canvas.width) || 0);
  const height = Math.max(0, Math.trunc(canvas.height) || 0);
  const existing = surfaces.get(canvas);
  // Assigning width/height resets a canvas to transparent black, which is the
  // state an unawaited `renderPage` leaves behind on the PNG branch.
  if (!existing || existing.width !== width || existing.height !== height) {
    const created: Surface = { width, height, data: new Uint8ClampedArray(width * height * 4) };
    surfaces.set(canvas, created);
    return created;
  }
  return existing;
}

/** A read of an unpainted page canvas is the defect; count it wherever it happens. */
function reading(canvas: HTMLCanvasElement): void {
  if (pageCanvases.has(canvas) && !landed.has(canvas)) double.readsBeforePaint += 1;
}

function parseColour(input: string): [number, number, number, number] {
  const text = String(input).trim();
  const hex = /^#?([0-9a-f]{6})$/i.exec(text)?.[1];
  if (hex) {
    return [
      Number.parseInt(hex.slice(0, 2), 16),
      Number.parseInt(hex.slice(2, 4), 16),
      Number.parseInt(hex.slice(4, 6), 16),
      255,
    ];
  }
  const named: Record<string, [number, number, number, number]> = {
    white: [255, 255, 255, 255],
    black: [0, 0, 0, 255],
  };
  return named[text.toLowerCase()] ?? [0, 0, 0, 255];
}

class StubContext {
  fillStyle = '#000000';
  filter = 'none';
  globalAlpha = 1;

  constructor(private readonly canvas: HTMLCanvasElement) {}

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
        for (let channel = 0; channel < 4; channel++) out[to + channel] = src.data[from + channel];
      }
    }
    return new ImageData(out, width, height);
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    const dst = surfaceOf(this.canvas);
    const [r, g, b, a] = parseColour(this.fillStyle);
    for (let row = Math.round(y); row < Math.round(y + height); row++) {
      for (let col = Math.round(x); col < Math.round(x + width); col++) {
        if (col < 0 || row < 0 || col >= dst.width || row >= dst.height) continue;
        const at = (row * dst.width + col) * 4;
        dst.data[at] = r;
        dst.data[at + 1] = g;
        dst.data[at + 2] = b;
        dst.data[at + 3] = a;
      }
    }
  }

  /** Copy 1:1 with clipping — the operator `flattenIfNeeded` uses. */
  drawImage(source: HTMLCanvasElement, dx = 0, dy = 0): void {
    reading(source);
    const src = surfaceOf(source);
    const dst = surfaceOf(this.canvas);
    for (let row = 0; row < src.height; row++) {
      for (let col = 0; col < src.width; col++) {
        const tx = Math.round(dx) + col;
        const ty = Math.round(dy) + row;
        if (tx < 0 || ty < 0 || tx >= dst.width || ty >= dst.height) continue;
        const from = (row * src.width + col) * 4;
        const to = (ty * dst.width + tx) * 4;
        for (let channel = 0; channel < 4; channel++) dst.data[to + channel] = src.data[from + channel];
      }
    }
  }

  save(): void {}
  restore(): void {}
}

/** Real PNG: signature, IHDR, one filter-0 IDAT stream, IEND. */
function encodePng(surface: Surface): Uint8Array {
  const stride = 1 + surface.width * 4;
  const raw = new Uint8Array(stride * surface.height);
  for (let y = 0; y < surface.height; y++) {
    raw.set(surface.data.subarray(y * surface.width * 4, (y + 1) * surface.width * 4), y * stride + 1);
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, surface.width);
  view.setUint32(4, surface.height);
  header[8] = 8; // bit depth
  header[9] = 6; // truecolour + alpha
  const parts = [
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function pngChunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

let CRC_TABLE: Int32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = -1;
  for (const byte of bytes) c = (c >>> 8) ^ CRC_TABLE[(c ^ byte) & 0xff];
  return (c ^ -1) >>> 0;
}

/**
 * A JPEG container whose comment segments carry the deflated samples.
 *
 * Lossless on purpose: the question this file asks is *which pixels were in the
 * canvas when it was encoded*, and a lossy model could only move that answer
 * towards "less ink". That the real encoder shrinks with a lower quality is
 * measured in Chromium, not here.
 */
function encodeJpeg(surface: Surface): Uint8Array {
  const samples = new Uint8Array(surface.width * surface.height * 3);
  for (let i = 0; i < surface.width * surface.height; i++) {
    samples[i * 3] = surface.data[i * 4];
    samples[i * 3 + 1] = surface.data[i * 4 + 1];
    samples[i * 3 + 2] = surface.data[i * 4 + 2];
  }
  const payload = deflateSync(Buffer.from(samples));
  const sof = new Uint8Array(17);
  const view = new DataView(sof.buffer);
  view.setUint16(0, 17);
  sof[2] = 8;
  view.setUint16(3, surface.height);
  view.setUint16(5, surface.width);
  sof[7] = 3;
  const parts: number[] = [0xff, 0xd8, 0xff, 0xc0, ...sof];
  for (let at = 0; at < payload.length; at += 60000) {
    const slice = payload.subarray(at, at + 60000);
    const head = new Uint8Array(2);
    new DataView(head.buffer).setUint16(0, slice.length + 2);
    parts.push(0xff, 0xfe, ...head, ...slice);
  }
  parts.push(0xff, 0xd9);
  return Uint8Array.from(parts);
}

function decodeJpeg(bytes: Uint8Array): Uint8Array {
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

interface Decoded {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Reads back exactly what `encodePng` writes; anything else fails loudly. */
function decodePng(bytes: Uint8Array): Decoded {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) expect(bytes[i], 'not a PNG').toBe(signature[i]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      expect(bytes[offset + 16], 'only 8-bit PNGs are decoded here').toBe(8);
      expect(bytes[offset + 17], 'only RGBA PNGs are decoded here').toBe(6);
    } else if (type === 'IDAT') {
      idat.push(Uint8Array.from(bytes.subarray(offset + 8, offset + 8 + length)));
    } else if (type === 'IEND') break;
    offset += 12 + length;
  }
  const raw = new Uint8Array(inflateSync(Buffer.concat(idat.map((part) => Buffer.from(part)))));
  const stride = width * 4;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    // `encodePng` writes filter 0 for every row; a different byte here means the
    // encoder changed and this decoder would silently return wrong pixels.
    expect(raw[y * (stride + 1)], `PNG row ${y} uses an unhandled filter`).toBe(0);
    out.set(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), y * stride);
  }
  return { width, height, data: out };
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
    quality?: number,
  ): void {
    reading(this);
    const surface = surfaceOf(this);
    const mime = type ?? 'image/png';
    double.encodes.push({ mime, quality, width: surface.width, height: surface.height });
    const bytes = mime === 'image/jpeg' ? encodeJpeg(surface) : encodePng(surface);
    queueMicrotask(() => cb(new Blob([bytes as BlobPart], { type: mime })));
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

/* ── the paint: fraction-of-sheet, so it scales with dpi like a real page ───── */

/**
 * Fill the sheet with paper, then the ink its fixture content rasterises to.
 * Every shape is placed as a fraction of the page, because the same sheet
 * rendered at 72 and at 216 dpi has to carry the same *proportion* of ink —
 * that is what makes the cross-dpi figures comparable.
 */
function paintSheet(canvas: HTMLCanvasElement, kind: SheetKind): void {
  const surface = surfaceOf(canvas);
  surface.data.fill(255); // the opaque white page background pdf.js paints
  const w = surface.width;
  const h = surface.height;
  const rect = (x0: number, y0: number, x1: number, y1: number, value: number) => {
    for (let y = Math.round(y0 * h); y < Math.round(y1 * h); y++) {
      for (let x = Math.round(x0 * w); x < Math.round(x1 * w); x++) {
        const at = (y * w + x) * 4;
        surface.data[at] = value;
        surface.data[at + 1] = value;
        surface.data[at + 2] = value;
        surface.data[at + 3] = 255;
      }
    }
  };
  if (kind === 'dark') rect(0.1, 0.15, 0.7, 0.75, 12);
  else if (kind === 'light') rect(0.2, 0.1, 0.6, 0.8, 205);
  else if (kind === 'text') {
    const thickness = Math.max(1, Math.round(0.012 * h));
    for (let line = 0; line < 12; line++) {
      const top = Math.round((0.08 + line * 0.07) * h);
      for (let row = 0; row < thickness; row++) {
        for (let x = Math.round(0.1 * w); x < Math.round(0.9 * w); x++) {
          if ((x - Math.round(0.1 * w)) % 9 >= 6) continue; // word gaps
          const at = ((top + row) * w + x) * 4;
          surface.data[at] = 20;
          surface.data[at + 1] = 20;
          surface.data[at + 2] = 20;
          surface.data[at + 3] = 255;
        }
      }
    }
  } else if (kind === 'photo') {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const at = (y * w + x) * 4;
        const tone = (x * 7 + y * 13) % 256;
        surface.data[at] = tone;
        surface.data[at + 1] = tone;
        surface.data[at + 2] = tone;
        surface.data[at + 3] = 255;
      }
    }
  }
}

/**
 * The source measurement: a sheet's own ink at the pixel size the page was
 * rendered to.
 *
 * This is what the produced files are compared against — not a guessed
 * threshold. It is the same `paintSheet` the render double lands into the canvas,
 * applied to a scratch canvas of the measured size, so a cancelled paint (which is
 * what the unfixed code does: encode, then `cancel()`) cannot leave the comparison
 * without a reference. The double's own honesty test ties the landed canvas to it.
 */
function sheetBitmap(kind: SheetKind, width: number, height: number): Decoded {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  paintSheet(canvas, kind);
  const surface = surfaceOf(canvas);
  return { width: surface.width, height: surface.height, data: new Uint8ClampedArray(surface.data) };
}

/* ── the render double: real geometry, the paint lands in a later task ─────── */

vi.mock('@/lib/pdf/core/render', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/pdf/core/render')>();
  const openReal = real.openRender;
  return {
    ...real,
    openRender: async (bytes: ArrayBuffer | Uint8Array, options?: Parameters<typeof openReal>[1]) => {
      const session = await openReal(bytes, options);
      // Everything pdf.js can do headless (parse, viewport maths, /Rotate) stays
      // real; only the painting is replaced, and it is replaced with a race.
      session.renderPage = async (n: number, scale: number, renderOptions = {}): Promise<PageRender> => {
        double.requested.push(n);
        double.scales.push(scale);
        const proxy = await session.page(n);
        const viewport = proxy.getViewport({ scale, rotation: proxy.rotate });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        pageCanvases.add(canvas);
        const ctx = new StubContext(canvas);
        // The one thing the real `renderPage` does before it returns: the
        // synchronous background fill. Nothing else is on the canvas yet.
        if (renderOptions.background) {
          ctx.fillStyle = renderOptions.background;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        const sheet = SHEETS[n - 1]?.kind ?? 'empty';
        let settle: () => void = () => {};
        let abort: (reason: Error) => void = () => {};
        let settled = false;
        const finished = new Promise<void>((resolve, reject) => {
          settle = resolve;
          abort = reject;
        });
        // The ink lands in a **later task**, the way pdf.js does it: a caller
        // that encodes the canvas without waiting gets the background only.
        const timer = setTimeout(() => {
          settled = true;
          paintSheet(canvas, sheet);
          landed.add(canvas);
          const surface = surfaceOf(canvas);
          double.painted.set(n, { data: surface.data.slice(), width: surface.width, height: surface.height });
          settle();
        }, 0);
        finished.catch(() => undefined);
        double.settles.push(finished);
        proxy.cleanup();
        return {
          canvas,
          ctx: ctx as unknown as CanvasRenderingContext2D,
          width: canvas.width,
          height: canvas.height,
          unitsPerPixel: 1 / scale,
          pageNumber: n,
          finished,
          cancel: () => {
            if (!settled) {
              clearTimeout(timer);
              abort(new real.RenderCancelled('test render cancelled'));
            }
            try {
              proxy.cleanup();
            } catch {
              /* the document is already torn down */
            }
          },
        };
      };
      return session;
    },
  } as typeof real;
});

/* ── the PDF itself ───────────────────────────────────────────────────────── */

/**
 * A real document whose pages carry the same five cases the double paints, at
 * the same sizes, so the bytes and the paint describe one file.
 */
async function inkFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const { kind, size } of SHEETS) {
    const [width, height] = size;
    const page = doc.addPage([width, height]);
    const box = (x0: number, y0: number, x1: number, y1: number, tone: number) => {
      page.drawRectangle({
        x: x0 * width,
        y: y0 * height,
        width: (x1 - x0) * width,
        height: (y1 - y0) * height,
        color: rgb(tone / 255, tone / 255, tone / 255),
      });
    };
    if (kind === 'dark') box(0.1, 0.25, 0.7, 0.85, 12 / 255);
    else if (kind === 'light') box(0.2, 0.2, 0.6, 0.9, 205 / 255);
    else if (kind === 'text') {
      for (let line = 0; line < 12; line++) {
        page.drawText(`body copy line ${line + 1} of the inked sheet`, {
          x: 0.1 * width,
          y: height - (0.08 + line * 0.07) * height - 8,
          size: Math.max(4, 0.02 * height),
          font,
          color: rgb(0, 0, 0),
        });
      }
    } else if (kind === 'photo') {
      // A full-bleed RGB image XObject, so the sheet really is a scan: one
      // `cm … Do` painting 48×48 halftone samples over the whole box.
      const px = 48;
      const samples = new Uint8Array(px * px * 3);
      for (let i = 0; i < px * px; i++) {
        samples[i * 3] = (i * 5) % 256;
        samples[i * 3 + 1] = (i * 11) % 256;
        samples[i * 3 + 2] = (i * 23) % 256;
      }
      const ref = doc.context.register(
        PDFRawStream.of(
          doc.context.obj({
            Type: 'XObject',
            Subtype: 'Image',
            Width: px,
            Height: px,
            BitsPerComponent: 8,
            ColorSpace: 'DeviceRGB',
            Filter: 'FlateDecode',
          }),
          new Uint8Array(deflateSync(Buffer.from(samples))),
        ),
      );
      const resources = page.node.Resources() as PDFDict;
      resources.set(PDFName.of('XObject'), doc.context.obj({ Im9: ref }) as never);
      page.node.set(
        PDFName.of('Contents'),
        doc.context.register(
          doc.context.stream(`q ${width} 0 0 ${height} 0 0 cm /Im9 Do Q`),
        ),
      );
    }
  }
  return doc.save({ useObjectStreams: false });
}

function fileOf(bytes: Uint8Array, name: string): ToolFile {
  return {
    name,
    size: bytes.byteLength,
    type: 'application/pdf',
    bytes: async () => new Uint8Array(bytes),
    blob: () => new Blob([bytes as BlobPart], { type: 'application/pdf' }),
  };
}

/* ── running the tool ─────────────────────────────────────────────────────── */

interface Exported {
  message: string;
  warnings: string[];
  files: { name: string; bytes: Uint8Array }[];
}

async function exportImages(values: ToolValues, pages = SHEETS.length): Promise<Exported> {  const tool = getPdfTool('pdf-to-image');
  expect(tool, 'pdf-to-image is not registered').toBeTruthy();
  const result = (await tool!.run!({
    inputs: [fileOf(await inkFixture(), 'ink.pdf')],
    values: { ...defaultValues(tool!.fields ?? []), pages: `1-${pages}`, ...values },
    progress: () => {},
    log: () => {},
    signal: new AbortController().signal,
  })) as ToolResult;
  await flushPaints();
  expect(result, 'pdf-to-image produced no result').toBeTruthy();
  expect(result.kind, `pdf-to-image returned ${result.kind}, not files`).toBe('files');
  const files = (result as Extract<ToolResult, { kind: 'files' }>).files;
  // `ToolOutputFile.name` is optional in the type; a file that does not name its
  // page is caught below by `namedPage`, which requires the `-page-NNN.` token.
  const produced = files.map((file) => ({ name: file.name ?? '', blob: file.blob }));
  expect(produced.length, 'the export produced no file').toBeGreaterThan(0);
  const entries = produced[0].name.endsWith('.zip')
    ? (await readZip(produced[0].blob)).map((entry) => ({
      name: entry.name,
      blob: new Blob([entry.bytes as BlobPart]),
    }))
    : produced;
  return {
    message: result.message ?? '',
    warnings: result.warnings ?? [],
    files: await Promise.all(
      entries.map(async (entry) => ({ name: entry.name, bytes: new Uint8Array(await entry.blob.arrayBuffer()) })),
    ),
  };
}

/**
 * Wait for every paint the run started.
 *
 * A tool that encodes without awaiting `finished` returns *while the pages are
 * still unpainting*, so the known-good readings have to be collected before they
 * are compared with — otherwise the test fails on an empty map instead of on the
 * ink that never arrived. Post-fix this is a no-op; the awaits already landed it.
 */
async function flushPaints(): Promise<void> {
  await Promise.allSettled(double.settles.slice());
}

/* ── measuring an exported image ──────────────────────────────────────────── */

function readImage(bytes: Uint8Array, name: string): Decoded {
  if (name.endsWith('.jpg')) {
    expect(bytes[0], `${name} is not a JPEG`).toBe(0xff);
    expect(bytes[1], `${name} is not a JPEG`).toBe(0xd8);
    const samples = decodeJpeg(bytes);
    // SOI, COM/SOF marker, length, precision, then height and width big-endian:
    // the container's own claim, so a file whose header disagrees with its
    // payload cannot pass for the page it names.
    const height = (bytes[7] << 8) | bytes[8];
    const width = (bytes[9] << 8) | bytes[10];
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      data[i * 4] = samples[i * 3];
      data[i * 4 + 1] = samples[i * 3 + 1];
      data[i * 4 + 2] = samples[i * 3 + 2];
      data[i * 4 + 3] = 255;
    }
    return { width, height, data };
  }
  return decodePng(bytes);
}

/** Non-white pixels, counted the way `rail-measure.py` counts them — where a
 * canvas is still transparent the viewer shows paper, so that is what is counted
 * (an unpainted page then reads 0, which is the deployed 0.00 %, not 100 %). */
function nonWhite(image: Decoded): number {
  let dark = 0;
  for (let i = 0; i < image.width * image.height; i++) {
    const a = image.data[i * 4 + 3] / 255;
    const r = Math.round(255 * (1 - a) + image.data[i * 4] * a);
    const g = Math.round(255 * (1 - a) + image.data[i * 4 + 1] * a);
    const b = Math.round(255 * (1 - a) + image.data[i * 4 + 2] * a);
    if (r < 245 || g < 245 || b < 245) dark += 1;
  }
  return dark;
}

function inkOf(bitmap: { data: Uint8ClampedArray; width: number; height: number }): number {
  return nonWhite(bitmap);
}

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

/** The page a produced file names, read out of its own name. */
function namedPage(name: string): number {
  const match = /-page-(\d+)\./.exec(name);
  expect(match, `${name} does not name a page`).not.toBeNull();
  return Number(match![1]);
}

/* ── tests ────────────────────────────────────────────────────────────────── */

beforeAll(() => {
  installCanvas();
});

beforeEach(() => {
  double.requested.length = 0;
  double.scales.length = 0;
  double.painted.clear();
  double.readsBeforePaint = 0;
  double.settles.length = 0;
  double.encodes.length = 0;
});

describe('the render double keeps the paint race honest', () => {
  it('hands out paper until finished resolves and ink afterwards', async () => {
    const { openRender } = await import('@/lib/pdf/core/render');
    const session = await openRender(await inkFixture());
    const render = await session.renderPage(1, 1);
    const early = render.ctx.getImageData(0, 0, render.width, render.height);
    expect(double.readsBeforePaint, 'a read of an unpainted page went uncounted').toBe(1);
    await render.finished;
    const lateRead = render.ctx.getImageData(0, 0, render.width, render.height);
    const lateImage = {
      width: render.width,
      height: render.height,
      data: new Uint8ClampedArray(lateRead.data),
    };
    expect(double.readsBeforePaint, 'the awaited paint still cost a read').toBe(1);
    expect(nonWhite(early), 'the unawaited canvas already carried ink').toBe(0);
    const late = nonWhite(lateImage);
    expect(late, 'the awaited canvas carries no ink').toBeGreaterThan(0);
    // The reference the other tests compare against is the paint this double
    // actually lands, not a number the file happens to agree with.
    expect(late, 'the landed paint is not the sheet\'s own ink').toBe(
      nonWhite(sheetBitmap('dark', render.width, render.height)),
    );
    await session.destroy();
  });
});

describe('which of the two causes the deployed 44 128-byte zip was', () => {
  it('asks pdf.js for every selected page, in order, once each', async () => {
    await exportImages({ format: 'png', dpi: 72 });
    expect(double.requested, 'the loop did not walk the selection').toEqual([1, 2, 3, 4, 5]);
  });

  it('produces five files whose sizes are the five pages, not one page five times', async () => {
    const { files } = await exportImages({ format: 'png', dpi: 72 });
    expect(files.map((file) => file.name)).toEqual([
      'ink-page-001.png',
      'ink-page-002.png',
      'ink-page-003.png',
      'ink-page-004.png',
      'ink-page-005.png',
    ]);
    // Each file's pixel size is the size of the page its name names: a stale
    // index, a hoisted canvas or one reused promise cannot produce this table.
    const seen = files.map((file) => {
      const image = readImage(file.bytes, file.name);
      const size = SHEETS[namedPage(file.name) - 1].size;
      expect([image.width, image.height], `${file.name} is not its own page's size`).toEqual(size);
      return [image.width, image.height].join('x');
    });
    expect(new Set(seen).size, 'every output is the same sheet').toBe(SHEETS.length);
  });

  it('hands back pairwise distinct bytes — ink alone would not have caught a reused page', async () => {
    const { files } = await exportImages({ format: 'png', dpi: 72 });
    const digests = files.map((file) => sha(file.bytes));
    expect(new Set(digests).size, `outputs repeat: ${digests.join(' ')}`).toBe(files.length);
    const lengths = files.map((file) => file.bytes.length);
    expect(new Set(lengths).size, `output lengths repeat: ${lengths.join(' ')}`).toBe(files.length);
    const inks = files.map((file) => nonWhite(readImage(file.bytes, file.name)));
    expect(new Set(inks).size, `ink counts repeat: ${inks.join(' ')}`).toBe(files.length);
  });
});

describe('pdf-to-image paints the page it exports', () => {
  it.each(SHEETS.map((sheet, index) => [index + 1, sheet.kind] as const))(
    'page %i (%s) carries exactly the ink its sheet was painted with',
    async (page, kind) => {
      const { files } = await exportImages({ format: 'png', dpi: 72 });
      const file = files[page - 1];
      const image = readImage(file.bytes, file.name);
      const source = nonWhite(sheetBitmap(kind, image.width, image.height));
      const landed = double.painted.get(page);
      if (kind === 'empty') {
        // The control: the instrument reads 0 where nothing is drawn, so the
        // four figures below it are measurements and not a constant.
        expect(source, 'the empty sheet carries ink by construction').toBe(0);
        expect(landed ? inkOf(landed) : 0, 'the empty sheet painted something').toBe(0);
      } else {
        expect(source, `the ${kind} sheet carries no ink by construction`).toBeGreaterThan(0);
      }
      const inFile = nonWhite(image);
      expect(
        inFile,
        `page ${page} (${kind}): ${inFile} non-white px in the file against ${source} in the source page `
        + `at ${image.width}×${image.height} — the canvas was encoded before pdf.js had painted it`,
      ).toBe(source);
      if (landed) {
        // The canvas as it stood when `finished` resolved is the same figure:
        // the file copies the paint, and nothing else.
        expect(inkOf(landed), `page ${page}: the awaited canvas disagrees with the sheet`).toBe(source);
      }
    },
  );

  it('never encodes a page canvas that has not been painted', async () => {
    await exportImages({ format: 'png', dpi: 72 });
    // The structural twin of the ink check: every read of a page canvas happened
    // after the paint landed. Without `await render.finished` this is the count
    // of background-fill/`toBlob` reads of five unpainted canvases.
    expect(double.readsBeforePaint).toBe(0);
  });

  it('reports the export it actually made', async () => {
    const { message, warnings, files } = await exportImages({ format: 'png', dpi: 72 });
    expect(message).toMatch(/5 PNG images at 72 dpi/);
    expect(files).toHaveLength(5);
    expect(warnings.join(' ')).not.toMatch(/wrong way round|produced no image/);
  });
});

describe('the controls do what their fields promise', () => {
  it.each([72, 144, 216] as const)('dpi %i sets the pixel dimensions exactly', async (dpi) => {
    const { files } = await exportImages({ format: 'png', dpi }, 1);
    expect(double.scales).toEqual([dpi / 72]);
    const image = readImage(files[0].bytes, files[0].name);
    expect([image.width, image.height]).toEqual([
      Math.floor(SHEETS[0].size[0] * dpi / 72),
      Math.floor(SHEETS[0].size[1] * dpi / 72),
    ]);
    expect(nonWhite(image)).toBe(nonWhite(sheetBitmap('dark', image.width, image.height)));
  });

  it('grows the file as dpi grows, and keeps the same share of ink', async () => {
    const runs: { dpi: number; bytes: number; pixels: number; ink: number }[] = [];
    for (const dpi of [72, 144, 216]) {
      const { files } = await exportImages({ format: 'png', dpi }, 1);
      const image = readImage(files[0].bytes, files[0].name);
      runs.push({ dpi, bytes: files[0].bytes.length, pixels: image.width * image.height, ink: nonWhite(image) });
    }
    // Monotonic in both, and the pixel count tracks dpi², which is the ratio
    // the field asks for: 144 dpi is 4× the samples of 72, 216 dpi is 9×.
    expect(runs.map((run) => run.bytes)).toEqual([...runs.map((run) => run.bytes)].sort((a, b) => a - b));
    expect(runs[1].pixels / runs[0].pixels).toBeCloseTo(4, 1);
    expect(runs[2].pixels / runs[0].pixels).toBeCloseTo(9, 1);
    const fractions = runs.map((run) => run.ink / run.pixels);
    for (const fraction of fractions) {
      expect(
        fraction,
        `a dark block covers the same share of the sheet at every dpi, got ${fractions.join(', ')}`,
      ).toBeCloseTo(fractions[0], 2);
    }
  });

  it('writes a genuinely different encoding for PNG and JPG, of the same pixels', async () => {
    const png = await exportImages({ format: 'png', dpi: 72 }, 2);
    const jpg = await exportImages({ format: 'jpeg', dpi: 72 }, 2);
    expect(png.files.map((file) => file.name)).toEqual(['ink-page-001.png', 'ink-page-002.png']);
    expect(jpg.files.map((file) => file.name)).toEqual(['ink-page-001.jpg', 'ink-page-002.jpg']);
    expect(double.encodes.map((encode) => encode.mime)).toEqual([
      'image/png',
      'image/png',
      'image/jpeg',
      'image/jpeg',
    ]);
    for (let page = 1; page <= 2; page++) {
      const pngBytes = png.files[page - 1].bytes;
      const jpgBytes = jpg.files[page - 1].bytes;
      expect(sha(pngBytes), `page ${page}: PNG and JPG are the same bytes`).not.toBe(sha(jpgBytes));
      expect(pngBytes.length, `page ${page}: the two encodings are the same length`).not.toBe(jpgBytes.length);
      const pngImage = readImage(pngBytes, `p${page}.png`);
      const jpgImage = readImage(jpgBytes, `p${page}.jpg`);
      // Same picture, two containers: the pixels have to agree sample for sample,
      // and both have to agree with the sheet they were painted from.
      expect(Array.from(jpgImage.data)).toEqual(Array.from(pngImage.data));
      const source = nonWhite(sheetBitmap(SHEETS[page - 1].kind, pngImage.width, pngImage.height));
      expect(nonWhite(pngImage), `page ${page} PNG is not its sheet's ink`).toBe(source);
      expect(nonWhite(jpgImage), `page ${page} JPG is not its sheet's ink`).toBe(source);
    }
  });

  it.each([0.3, 0.6, 0.95])('passes JPEG quality %f to the encoder', async (quality) => {
    await exportImages({ format: 'jpeg', dpi: 72, quality }, 1);
    expect(double.encodes).toHaveLength(1);
    expect(double.encodes[0].mime).toBe('image/jpeg');
    expect(double.encodes[0].quality).toBe(quality);
  });

  // `core/pages` keeps the order the user wrote (and its duplicates), so "in
  // order" means in the selection's order, not ascending — measured, not assumed.
  it.each([
    ['2', [2]],
    ['1-3', [1, 2, 3]],
    ['4,2', [4, 2]],
    ['odd', [1, 3, 5]],
  ] as const)('a selection of %s exports exactly those pages, in that order', async (spec, expected) => {
    const { files } = await exportImages({ format: 'png', dpi: 72, pages: spec });
    expect(double.requested).toEqual(expected);
    expect(files.map((file) => namedPage(file.name))).toEqual(expected);
    expect(files).toHaveLength(expected.length);
    for (const [index, page] of expected.entries()) {
      const image = readImage(files[index].bytes, files[index].name);
      const size = SHEETS[page - 1].size;
      expect([image.width, image.height], `${files[index].name} is not page ${page}`).toEqual(size);
      expect(
        nonWhite(image),
        `${files[index].name} is not page ${page}'s ink`,
      ).toBe(nonWhite(sheetBitmap(SHEETS[page - 1].kind, image.width, image.height)));
    }
  });

  it('downloads a one-page selection without a zip and honours zip=false', async () => {
    const single = await exportImages({ format: 'png', dpi: 72, pages: '2' });
    expect(single.files).toHaveLength(1);
    expect(single.files[0].name).toBe('ink-page-002.png');
    const loose = await exportImages({ format: 'png', dpi: 72, pages: 'all', zip: false });
    expect(loose.files.map((file) => file.name)).toEqual([
      'ink-page-001.png',
      'ink-page-002.png',
      'ink-page-003.png',
      'ink-page-004.png',
      'ink-page-005.png',
    ]);
  });
});
