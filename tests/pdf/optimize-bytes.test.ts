/**
 * Byte-level evidence for the Optimize category.
 *
 * `edge-optimize.test.ts` reads what each tool *says*. This file reads what each
 * tool *wrote*: every claimed number is taken a second time out of the output
 * bytes, by a reader that does not share the producer's assumptions — pdf.js for
 * text, pdf-lib for structure, this file's own pixel decoder for images.
 *
 * The claims under test:
 *
 * | claim (`core/…` unless noted)                                | measured by                                    |
 * |--------------------------------------------------------------|------------------------------------------------|
 * | "downsampled this image to N dpi" (`compress`)                | the stored `/Width` and the re-decoded pixels   |
 * | "kept the transparent logo"                                   | the surviving `/SMask` reference                |
 * | "re-encoded as greyscale"                                     | `R == G == B` in the written samples            |
 * | "this browser cannot re-encode images"                        | nothing replaced, and the note says so once     |
 * | "the text under a redaction is gone" (`redact`)                | pdf.js `getTextContent`, plus a painted-over control |
 * | "compressed A → B (-N%)" (`pdf-compress`)                     | the two lengths, counted from the bytes         |
 * | "N page(s) readable of M listed" (`repair`)                   | a fresh parse of the output and the input's `/Count` |
 * | "PDF/A-2b identification"                                     | `/N 0` on the metadata stream and its XMP       |
 * | "rasterised" — no interactive field left (`rasterize-pdf`)    | `/AcroForm`, `/Annots` and text items in the out |
 * | "painted the differences" (`compare`)                         | the marked-pixel count in the overlay's `/SMask` |
 * | "cropped N pt off each side" (`pdf-crop`)                     | the page boxes, before and after                |
 *
 * jsdom has no 2-D raster, so this file installs a small pixel-true canvas (see
 * `installCanvas`): real RGBA buffers, a box-filter resample, source-over
 * compositing and `grayscale(1)`. That is the minimum for "`putImageData` cropped
 * the page instead of shrinking it" to be a *measurable* claim rather than a
 * sentence in a comment. Encoding is a stand-in too — a JPEG container whose
 * comment segments carry deflated RGB, and a real PNG for the alpha path — so the
 * bytes written into the PDF stay parseable by pdf-lib.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as pdfjs from 'pdfjs-dist';
import { GlobalWorkerOptions, OPS } from 'pdfjs-dist';
import { deflateSync, inflateSync } from 'node:zlib';
import { PDFDocument, StandardFonts, rgb } from '@maxwbh/pdf-lib';
import type { PDFPage } from '@maxwbh/pdf-lib';
import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  openPDF,
} from '@/lib/pdf/core/doc';
import { compressPDF } from '@/lib/pdf/core/compress';
import { applyRedactions } from '@/lib/pdf/core/redact';
import { addLayer, listLayers } from '@/lib/pdf/core/layers';
import {
  appendContentOps,
  makeOp,
  operand,
  pageContentOps,
  parseContentStream,
  serialiseContentStream,
  streamBytes,
} from '@/lib/pdf/core/content';
import type { ContentOp } from '@/lib/pdf/core/content';
import { mediaBox } from '@/lib/pdf/core/pages';
import { describeSize } from '@/lib/pdf/core/guard';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import { EngineUnavailable } from '@/lib/pdf/engines/provider';
import {
  defaultValues,
  type ToolFile,
  type ToolResult,
  type ToolValues,
} from '@/lib/pdf/tools/types';

/* ── doubles ──────────────────────────────────────────────────────────────── */

const engine = vi.hoisted(() => ({
  /** When set, `linearizeWithCpdf` returns these bytes instead of refusing. */
  linearized: null as Uint8Array | null,
}));

/**
 * The CDN engines are not the subject here, and a live fetch would make the
 * degraded path depend on the network: every engine call refuses with the error
 * the loader raises offline, except the one switch above.
 */
vi.mock('@/lib/pdf/core/engine-ops', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/pdf/core/engine-ops')>();
  const refuse = (id: 'ghostscript' | 'cpdf' | 'pymupdf'): never => {
    throw new EngineUnavailable(id, 'test double: the CDN is not contacted');
  };
  return {
    ...real,
    engineReady: () => false,
    convertToPdfA: async () => refuse('ghostscript'),
    textToOutlines: async () => refuse('ghostscript'),
    rebuildWithGhostscript: async () => refuse('ghostscript'),
    scrubWithPyMuPDF: async () => refuse('pymupdf'),
    deskewWithPyMuPDF: async () => refuse('pymupdf'),
    openWithPyMuPDF: async () => refuse('pymupdf'),
    readBookmarksWithCpdf: async () => refuse('cpdf'),
    listFontsWithCpdf: async () => refuse('cpdf'),
    compressWithCpdf: async () => refuse('cpdf'),
    linearizeWithCpdf: async () => {
      if (!engine.linearized) refuse('cpdf');
      return engine.linearized;
    },
  };
});

/** How a stubbed page is painted, keyed by the document's `/Title`. */
interface StubPaint {
  /** Size the double reports for every page, in points. */
  size: [number, number];
  paint: Map<string, (ctx: StubContext, width: number, height: number, page: number) => void>;
}

const renders = vi.hoisted((): StubPaint => ({
  size: [595, 842],
  paint: new Map(),
}));

/**
 * Rendering a page needs a raster, which jsdom has to fake anyway; the diff and
 * the overlay logic in `pdf-engine/commands.comparePDFs` stay real.
 */
vi.mock('@/lib/pdf/core/render', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/pdf/core/render')>();
  return {
    ...real,
    openRender: async (bytes: Uint8Array) => {
      const source = await PDFDocument.load(bytes, { updateMetadata: false });
      const title = source.getTitle() ?? '';
      const numPages = source.getPageCount();
      return {
        numPages,
        async renderPage(n: number, scale = 1) {
          const width = Math.max(1, Math.round(renders.size[0] * scale));
          const height = Math.max(1, Math.round(renders.size[1] * scale));
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d') as unknown as StubContext;
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, width, height);
          renders.paint.get(title)?.(ctx, width, height, n);
          return {
            canvas,
            ctx: ctx as unknown as CanvasRenderingContext2D,
            width,
            height,
            unitsPerPixel: 1 / scale,
            pageNumber: n,
            cancel: () => undefined,
          };
        },
        async destroy() {
          /* the sessions this double hands out hold nothing */
        },
      } as unknown as Awaited<ReturnType<typeof real.openRender>>;
    },
  };
});

/* ── a pixel-true canvas for jsdom ────────────────────────────────────────── */

interface Surface {
  width: number;
  height: number;
  /** RGBA, row-major, top row first — the order `getImageData` reports. */
  data: Uint8ClampedArray;
}

const surfaces = new WeakMap<HTMLCanvasElement, Surface>();
/** Flip to false for a browser with no 2-D raster at all. */
let rasterAvailable = true;

function surfaceOf(canvas: HTMLCanvasElement): Surface {
  const width = Math.max(0, Math.trunc(canvas.width) || 0);
  const height = Math.max(0, Math.trunc(canvas.height) || 0);
  const existing = surfaces.get(canvas);
  // Assigning a canvas's width or height resets it to transparent black, which
  // is what a fresh "page render" relies on.
  if (!existing || existing.width !== width || existing.height !== height) {
    const created: Surface = { width, height, data: new Uint8ClampedArray(width * height * 4) };
    surfaces.set(canvas, created);
    return created;
  }
  return existing;
}

function parseColour(input: string): [number, number, number] {
  const hex = /^#?([0-9a-f]{6})$/i.exec(String(input).trim())?.[1];
  if (!hex) return [0, 0, 0];
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

/** CSS `grayscale(1)` applied to 8-bit sRGB values. */
function greyOf(r: number, g: number, b: number): number {
  return Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
}

class StubContext {
  fillStyle = '#000000';
  filter = 'none';
  imageSmoothingEnabled = true;
  imageSmoothingQuality = 'low';
  globalAlpha = 1;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  private get target(): Surface {
    return surfaceOf(this.canvas);
  }

  createImageData(width: number, height: number): ImageData {
    return new ImageData(new Uint8ClampedArray(width * height * 4), width, height);
  }

  getImageData(x: number, y: number, width: number, height: number): ImageData {
    const src = this.target;
    const out = new Uint8ClampedArray(width * height * 4);
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const sx = x + col;
        const sy = y + row;
        if (sx < 0 || sy < 0 || sx >= src.width || sy >= src.height) continue;
        const from = (sy * src.width + sx) * 4;
        const to = (row * width + col) * 4;
        out[to] = src.data[from];
        out[to + 1] = src.data[from + 1];
        out[to + 2] = src.data[from + 2];
        out[to + 3] = src.data[from + 3];
      }
    }
    return new ImageData(out, width, height);
  }

  /**
   * Copy pixels 1:1 and clip to the canvas — no scaling, no blending. This is
   * the operator that silently cropped a scan when it stood in for downsampling.
   */
  putImageData(image: ImageData, x: number, y: number): void {
    const dst = this.target;
    for (let row = 0; row < image.height; row++) {
      for (let col = 0; col < image.width; col++) {
        const tx = x + col;
        const ty = y + row;
        if (tx < 0 || ty < 0 || tx >= dst.width || ty >= dst.height) continue;
        const from = (row * image.width + col) * 4;
        const to = (ty * dst.width + tx) * 4;
        dst.data[to] = image.data[from];
        dst.data[to + 1] = image.data[from + 1];
        dst.data[to + 2] = image.data[from + 2];
        dst.data[to + 3] = image.data[from + 3];
      }
    }
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    const dst = this.target;
    const [r, g, b] = parseColour(this.fillStyle);
    for (let row = Math.round(y); row < Math.round(y + height); row++) {
      for (let col = Math.round(x); col < Math.round(x + width); col++) {
        if (col < 0 || row < 0 || col >= dst.width || row >= dst.height) continue;
        const at = (row * dst.width + col) * 4;
        dst.data[at] = r;
        dst.data[at + 1] = g;
        dst.data[at + 2] = b;
        dst.data[at + 3] = 255;
      }
    }
  }

  clearRect(x: number, y: number, width: number, height: number): void {
    const dst = this.target;
    for (let row = Math.round(y); row < Math.round(y + height); row++) {
      for (let col = Math.round(x); col < Math.round(x + width); col++) {
        if (col < 0 || row < 0 || col >= dst.width || row >= dst.height) continue;
        const at = (row * dst.width + col) * 4;
        dst.data[at] = 0;
        dst.data[at + 1] = 0;
        dst.data[at + 2] = 0;
        dst.data[at + 3] = 0;
      }
    }
  }

  /** Box-filter resample of the whole source, composited source-over. */
  drawImage(
    source: HTMLCanvasElement,
    dx = 0,
    dy = 0,
    dw = source.width,
    dh = source.height,
  ): void {
    const src = surfaceOf(source);
    const dst = this.target;
    const grey = String(this.filter).includes('grayscale');
    const spanX = Math.max(1, Math.round(dw));
    const spanY = Math.max(1, Math.round(dh));
    for (let row = 0; row < spanY; row++) {
      for (let col = 0; col < spanX; col++) {
        const tx = Math.round(dx) + col;
        const ty = Math.round(dy) + row;
        if (tx < 0 || ty < 0 || tx >= dst.width || ty >= dst.height) continue;
        const x0 = Math.floor((col / spanX) * src.width);
        const x1 = Math.max(x0 + 1, Math.ceil(((col + 1) / spanX) * src.width));
        const y0 = Math.floor((row / spanY) * src.height);
        const y1 = Math.max(y0 + 1, Math.ceil(((row + 1) / spanY) * src.height));
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        let n = 0;
        for (let sy = Math.min(y0, src.height - 1); sy < Math.min(y1, src.height); sy++) {
          for (let sx = Math.min(x0, src.width - 1); sx < Math.min(x1, src.width); sx++) {
            const at = (sy * src.width + sx) * 4;
            r += src.data[at];
            g += src.data[at + 1];
            b += src.data[at + 2];
            a += src.data[at + 3];
            n += 1;
          }
        }
        if (n === 0) continue;
        r /= n;
        g /= n;
        b /= n;
        const srcA = (a / n) * this.globalAlpha;
        if (grey) {
          const v = greyOf(r, g, b);
          r = v;
          g = v;
          b = v;
        }
        const to = (ty * dst.width + tx) * 4;
        const da = dst.data[to + 3];
        const outA = srcA + da * (1 - srcA / 255);
        if (outA <= 0) continue;
        dst.data[to] = Math.round((r * srcA + dst.data[to] * da * (1 - srcA / 255)) / outA);
        dst.data[to + 1] = Math.round((g * srcA + dst.data[to + 1] * da * (1 - srcA / 255)) / outA);
        dst.data[to + 2] = Math.round((b * srcA + dst.data[to + 2] * da * (1 - srcA / 255)) / outA);
        dst.data[to + 3] = Math.round(outA);
      }
    }
  }

  save(): void {}
  restore(): void {}
}

/** A JPEG container whose comment segments carry deflated 24-bit RGB rows. */
function encodeStubJpeg(surface: Surface, quality: number): Uint8Array {
  const payload = deflateSync(Buffer.from(rgbOf(surface)));
  const sof = Buffer.alloc(17);
  sof.writeUInt16BE(17, 0);
  sof[2] = 8;
  sof.writeUInt16BE(surface.height, 3);
  sof.writeUInt16BE(surface.width, 5);
  sof[7] = 3;
  sof[8] = 1;
  sof[9] = 0x22;
  sof[12] = 2;
  sof[13] = 0x11;
  sof[16] = 3;
  const parts: number[] = [0xff, 0xd8, 0xff, 0xc0, ...sof];
  for (let at = 0; at < payload.length; at += 60000) {
    const slice = payload.subarray(at, at + 60000);
    const head = Buffer.alloc(2);
    head.writeUInt16BE(slice.length + 2, 0);
    parts.push(0xff, 0xfe, ...head, ...slice);
  }
  const note = Buffer.from(`Q${Math.round(quality * 100)}`, 'latin1');
  const noteHead = Buffer.alloc(2);
  noteHead.writeUInt16BE(note.length + 2, 0);
  parts.push(0xff, 0xfe, ...noteHead, ...note, 0xff, 0xd9);
  return Uint8Array.from(parts);
}

interface StubJpeg {
  width: number;
  height: number;
  rgb: Uint8Array;
  quality: number;
}

function decodeStubJpeg(bytes: Uint8Array): StubJpeg {
  let width = 0;
  let height = 0;
  let quality = 0;
  const chunks: Buffer[] = [];
  for (let i = 2; i < bytes.length - 1; i++) {
    if (bytes[i] !== 0xff) continue;
    const marker = bytes[i + 1];
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker === 0xc0) {
      // Segment: FF C0 <len:2> <precision:1> <height:2> <width:2> …
      height = (bytes[i + 5] << 8) | bytes[i + 6];
      width = (bytes[i + 7] << 8) | bytes[i + 8];
    } else if (marker === 0xfe) {
      const body = Buffer.from(bytes.subarray(i + 4, i + 2 + length));
      const note = /^Q(\d+)$/.exec(body.toString('latin1'));
      if (note) quality = Number(note[1]);
      else chunks.push(body);
    } else if (marker === 0xd9) break;
    i += 1 + length;
  }
  return { width, height, rgb: new Uint8Array(inflateSync(Buffer.concat(chunks))), quality };
}

/** A real RGBA PNG, because pdf-lib has to be able to embed the alpha path. */
function encodeStubPng(surface: Surface): Uint8Array {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  const crc = (buf: Buffer): number => {
    let c = -1;
    for (const byte of buf) c = (c >>> 8) ^ table[(c ^ byte) & 0xff];
    return (c ^ -1) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(surface.width, 0);
  header.writeUInt32BE(surface.height, 4);
  header[8] = 8;
  header[9] = 6; // truecolour with alpha
  const stride = 1 + surface.width * 4;
  const rows = Buffer.alloc(surface.height * stride);
  for (let y = 0; y < surface.height; y++) {
    Buffer
      .from(surface.data.buffer, surface.data.byteOffset + y * surface.width * 4, surface.width * 4)
      .copy(rows, y * stride + 1);
  }
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

/** The same pixels without alpha, the way a JPEG stores them. */
function rgbOf(surface: Surface): Uint8Array {
  const out = new Uint8Array(surface.width * surface.height * 3);
  for (let i = 0; i < surface.width * surface.height; i++) {
    out[i * 3] = surface.data[i * 4];
    out[i * 3 + 1] = surface.data[i * 4 + 1];
    out[i * 3 + 2] = surface.data[i * 4 + 2];
  }
  return out;
}

function installCanvas(): void {
  const proto = HTMLCanvasElement.prototype as unknown as {
    getContext: (kind: string) => unknown;
    toBlob: (cb: (blob: Blob | null) => void, type?: string, quality?: number) => void;
  };
  proto.getContext = function getContext(this: HTMLCanvasElement, kind: string) {
    if (!rasterAvailable || kind !== '2d') return null;
    return new StubContext(this);
  };
  proto.toBlob = function toBlob(
    this: HTMLCanvasElement,
    cb: (blob: Blob | null) => void,
    type?: string,
    quality?: number,
  ): void {
    if (!rasterAvailable) {
      cb(null);
      return;
    }
    const surface = surfaceOf(this);
    const mime = type ?? 'image/png';
    const bytes = mime === 'image/jpeg'
      ? encodeStubJpeg(surface, quality ?? 0.92)
      : encodeStubPng(surface);
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
  // jsdom's `Blob` has no `stream()`, which every real browser has had since
  // 2016 and which `core/compress` uses to inflate a FlateDecode image. Without
  // it the module's own decoder reports "a format this browser cannot decode"
  // and the re-encode path under test never runs.
  const blobs = Blob.prototype as unknown as { stream?: () => ReadableStream<Uint8Array> };
  if (typeof blobs.stream !== 'function') {
    blobs.stream = function stream(this: Blob): ReadableStream<Uint8Array> {
      const blob = this;
      return new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(new Uint8Array(await blob.arrayBuffer()));
          controller.close();
        },
      });
    };
  }
}

/* ── fixtures ─────────────────────────────────────────────────────────────── */

/**
 * Byte-exact latin-1. `new TextDecoder('latin1')` is windows-1252 in Node and in the
 * browser alike, so a file decoded that way and re-encoded with
 * `Buffer.from(…, 'latin1')` comes back with **different bytes** wherever a
 * compressed stream held 0x80-0x9F. A fixture written through that round trip
 * breaks every stream in it while setting out to break one number — which is how
 * this file's `repair` case came to hold three blank sheets under a sentence that
 * called them readable.
 */
const latin1 = { decode: (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1') };

function pdfFile(bytes: Uint8Array, name: string): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });
}

/** Deterministic ±`spread` dither, so an image is not trivially compressible. */
function noiseAt(index: number, spread: number): number {
  const x = Math.sin(index * 12.9898) * 43758.5453;
  return Math.round((x - Math.floor(x)) * spread - spread / 2);
}

type Quadrants = Array<number | [number, number, number]>;

interface RasterOptions {
  /** Pixels per side of the stored image. */
  px: number;
  /** Side of the box it is drawn into, in points. */
  boxPt: number;
  /** Draw the same image on page 2 as well, at this side length. */
  alsoOnPage2At?: number;
  /** Quadrant values, top-left / top-right / bottom-left / bottom-right. */
  quadrants?: Quadrants;
  /** Add a Flate `/SMask` that hides the bottom half. */
  alpha?: 'none' | 'half';
  /** Wrap the placement in a `q … cm` group that scales by this factor. */
  scaleGroup?: number;
}

/**
 * Two pages of text carrying one image XObject each (or the same one twice).
 *
 * The samples are raw (unfiltered) FlateDecode RGB with ±18 dither, so the
 * stored length is close to the pixel count and a downsampled re-encode is
 * honestly smaller — the way a scan is.
 */
async function rasterFixture(options: RasterOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText('Body text that must survive', { x: 60, y: 760, size: 16, font, color: rgb(0, 0, 0) });
  const second = doc.addPage([595, 842]);
  second.drawText('Second page body text', { x: 60, y: 760, size: 16, font });

  const px = options.px;
  const quadrants: Quadrants = options.quadrants ?? [0, 255, 90, 200];
  const samples = new Uint8Array(px * px * 3);
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      const at = (y * px + x) * 3;
      const which = (y < px / 2 ? 0 : 2) + (x < px / 2 ? 0 : 1);
      const value = quadrants[which];
      const channels = Array.isArray(value) ? value : [value, value, value];
      const jitter = noiseAt(y * px + x, 36);
      for (let c = 0; c < 3; c++) {
        samples[at + c] = Math.max(0, Math.min(255, (channels[c] as number) + jitter));
      }
    }
  }
  const dict = doc.context.obj({
    Type: 'XObject',
    Subtype: 'Image',
    Width: px,
    Height: px,
    BitsPerComponent: 8,
    ColorSpace: 'DeviceRGB',
    Filter: 'FlateDecode',
  }) as PDFDict;
  const ref = doc.context.register(
    PDFRawStream.of(dict, new Uint8Array(deflateSync(Buffer.from(samples)))),
  );

  if (options.alpha === 'half') {
    const mask = new Uint8Array(px * px);
    for (let y = 0; y < px; y++) {
      for (let x = 0; x < px; x++) mask[y * px + x] = y < px / 2 ? 255 : 0;
    }
    const maskDict = doc.context.obj({
      Type: 'XObject',
      Subtype: 'Image',
      Width: px,
      Height: px,
      BitsPerComponent: 8,
      ColorSpace: 'DeviceGray',
      Filter: 'FlateDecode',
    }) as PDFDict;
    const maskRef = doc.context.register(
      PDFRawStream.of(maskDict, new Uint8Array(deflateSync(Buffer.from(mask)))),
    );
    dict.set(PDFName.of('SMask'), maskRef);
  }

  placeImage(doc, page, ref, 'Im1', options.boxPt, options.scaleGroup);
  if (options.alsoOnPage2At !== undefined) {
    placeImage(doc, second, ref, 'Im1', options.alsoOnPage2At);
  }  return doc.save({ useObjectStreams: false });
}

/** Register `ref` in the page's resources and paint it into a `size` pt square. */
function placeImage(
  doc: PDFDocument,
  page: PDFPage,
  ref: PDFRef,
  name: string,
  size: number,
  scaleGroup = 1,
): void {
  const resources = page.node.Resources();
  if (!resources) throw new Error('the fixture page has no /Resources to add an image to');
  let xobjects = resources.lookupMaybe(PDFName.of('XObject'), PDFDict);
  if (!xobjects) {
    xobjects = doc.context.obj({}) as PDFDict;
    resources.set(PDFName.of('XObject'), xobjects);
  }
  xobjects.set(PDFName.of(name), ref);
  const number = (value: number) => operand.number(value);
  appendContentOps(page, [
    ...(scaleGroup === 1
      ? []
      : [makeOp('q'), makeOp('cm', [number(scaleGroup), number(0), number(0), number(scaleGroup), number(0), number(0)])]),
    makeOp('q'),
    makeOp('cm', [
      number(size),
      number(0),
      number(0),
      number(size),
      number(60),
      number(60),
    ]),
    makeOp('Do', [operand.name(name)]),
    makeOp('Q'),
    ...(scaleGroup === 1 ? [] : [makeOp('Q')]),
  ]);
}

/* ── fixtures: artwork nested in Form XObjects ────────────────────────────── */

/** The depth `core/compress` stops descending at, spelled out again on this side. */
const WALK_FORM_DEPTH = 6;

interface NestedOptions {
  /** Pixels per side of every stored image. */
  px: number;
  /** Side each image is painted at, in the units of the form that draws it. */
  boxPt: number;
  /** How many Form XObject levels hang off the page. */
  levels: number;
  /** Scale the page's `cm` draws the outermost form with, in points per form unit. */
  formScale: number;
  /** Fraction of its parent's box each nested form is drawn into. */
  perLevelScale?: number;
  /** Where every form's `/BBox` starts, so the walk has to subtract it. */
  bboxOffset?: number;
  /** Have the innermost form draw the outermost one back: a reference cycle. */
  cycle?: boolean;
  /** Give every image a `/SMask` hiding its bottom half, as a logo would have. */
  mask?: boolean;
}

interface NestedFixture {
  bytes: Uint8Array;
  /** The form XObject references, outermost first; each holds its own resources. */
  forms: PDFRef[];
  /** One image per form level, outermost first, with the bytes it was written with. */
  images: Array<{ ref: PDFRef; bytes: Uint8Array }>;
}

/** A Flate RGB image with enough dither that a re-encode has somewhere to go. */
function addDitheredImage(
  doc: PDFDocument,
  px: number,
  mask = false,
): { ref: PDFRef; bytes: Uint8Array } {
  const samples = new Uint8Array(px * px * 3);
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      const at = (y * px + x) * 3;
      const value = [0, 255, 90, 200][(y < px / 2 ? 0 : 2) + (x < px / 2 ? 0 : 1)];
      const jitter = noiseAt(y * px + x, 36);
      for (let c = 0; c < 3; c++) samples[at + c] = Math.max(0, Math.min(255, value + jitter));
    }
  }
  const bytes = new Uint8Array(deflateSync(Buffer.from(samples)));
  const dict = doc.context.obj({
    Type: 'XObject',
    Subtype: 'Image',
    Width: px,
    Height: px,
    BitsPerComponent: 8,
    ColorSpace: 'DeviceRGB',
    Filter: 'FlateDecode',
  }) as PDFDict;
  const ref = doc.context.register(PDFRawStream.of(dict, bytes));
  if (mask) {
    // The top half opaque, the bottom half hidden: painting it onto paper is what
    // makes an unchanged-resolution re-encode worth doing at all.
    const alpha = new Uint8Array(px * px);
    for (let y = 0; y < px; y++) {
      for (let x = 0; x < px; x++) alpha[y * px + x] = y < px / 2 ? 255 : 0;
    }
    const maskRef = doc.context.register(
      PDFRawStream.of(
        doc.context.obj({
          Type: 'XObject',
          Subtype: 'Image',
          Width: px,
          Height: px,
          BitsPerComponent: 8,
          ColorSpace: 'DeviceGray',
          Filter: 'FlateDecode',
        }) as PDFDict,
        new Uint8Array(deflateSync(Buffer.from(alpha))),
      ),
    );
    dict.set(PDFName.of('SMask'), maskRef);
  }
  return { ref, bytes };
}

/**
 * Form XObjects built by hand, the way an illustration export builds them.
 *
 * Every level is its own stream with its own `/Resources /XObject`, holding one
 * image and the next form down; the page draws only the outermost one with `Do`.
 * `/BBox` can start away from the origin, each level can shrink the next, and the
 * innermost form can draw the outermost one back to make a cycle the walk has to
 * survive. A form does not scale its `/BBox` into the box it is drawn in — one
 * form unit becomes `cm`-scale parent units — so an image `boxPt` wide in the
 * form at `level` is
 * `boxPt · formScale · perLevelScale^level` points wide on the page, and every
 * expected size in these tests is computed from the fixture rather than read out
 * of the producer.
 */
async function nestedFixture(options: NestedOptions): Promise<NestedFixture> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText('Page with nested artwork', { x: 60, y: 760, size: 14, font, color: rgb(0, 0, 0) });
  const second = doc.addPage([595, 842]);
  second.drawText('Second page body text', { x: 60, y: 760, size: 14, font });

  const side = 100;
  const offset = options.bboxOffset ?? 0;
  const shrink = options.perLevelScale ?? 1;
  const images: Array<{ ref: PDFRef; bytes: Uint8Array }> = [];
  for (let level = 0; level < options.levels; level++) {
    images.push(addDitheredImage(doc, options.px, options.mask ?? false));
  }

  const forms: PDFRef[] = [];
  const dicts: PDFDict[] = [];
  for (let level = 0; level < options.levels; level++) {
    const dict = doc.context.obj({
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [offset, offset, offset + side, offset + side],
      Resources: { XObject: {} },
    }) as PDFDict;
    dicts.push(dict);
    forms.push(doc.context.register(PDFRawStream.of(dict, new Uint8Array())));
  }

  const number = (value: number) => operand.number(value);
  const place = (size: number, name: string): ContentOp[] => [
    makeOp('q'),
    makeOp('cm', [number(size), number(0), number(0), number(size), number(offset), number(offset)]),
    makeOp('Do', [operand.name(name)]),
    makeOp('Q'),
  ];

  for (let level = 0; level < options.levels; level++) {
    const xobjects = dicts[level].lookup(PDFName.of('Resources'), PDFDict).lookup(PDFName.of('XObject'), PDFDict);
    const own = `Im${level}`;
    xobjects.set(PDFName.of(own), images[level].ref);
    const ops: ContentOp[] = [...place(options.boxPt, own)];
    if (level + 1 < options.levels) {
      xobjects.set(PDFName.of(`F${level + 1}`), forms[level + 1]);
      ops.push(...place(shrink, `F${level + 1}`));
    } else if (options.cycle) {
      xobjects.set(PDFName.of('F0'), forms[0]);
      ops.push(...place(0.5, 'F0'));
    }
    doc.context.assign(forms[level], PDFRawStream.of(dicts[level], serialiseContentStream(ops)));
  }

  placeImage(doc, page, forms[0], 'Art', options.formScale);
  return { bytes: await doc.save({ useObjectStreams: false }), forms, images };
}

/* ── a resource walk that is not the producer's ───────────────────────────── */

interface FoundImage {
  /** Resource path from the page, e.g. `/Art/F2/Im2`. */
  path: string;
  dict: PDFDict;
  /** The bytes the stream stores, encoded as they sit in the file. */
  bytes: Uint8Array;
}

/**
 * Every image in the file, found by walking each page's resource tree by hand.
 *
 * This is the count `report.images.total` has to match and the proof that a
 * stream was actually rewritten: it descends into `/Subtype /Form` XObjects, dedups
 * by reference, guards a form that reaches itself, and stops at the same depth the
 * module does — pass `limit` to see past that bound and count what is really in
 * the file. Written independently of `core/compress` on purpose: the whole point of
 * the check is that the two do not share a mistake.
 */
function walkImageResources(doc: PDFDocument, limit = WALK_FORM_DEPTH): FoundImage[] {
  const found: FoundImage[] = [];
  const seen = new Set<string>();
  const dictFor = (value: unknown): PDFDict | null => {
    const object = value instanceof PDFRef ? doc.context.lookup(value) : value;
    const dict = object instanceof PDFStream ? object.dict : object;
    return dict instanceof PDFDict ? dict : null;
  };
  const subtypeOf = (dict: PDFDict): string => String(dict.get(PDFName.of('Subtype')) ?? '').replace(/^\//, '');
  const walk = (xobjects: PDFDict, depth: number, path: string, visiting: Set<string>): void => {
    for (const [key, value] of xobjects.entries()) {
      const ref = value instanceof PDFRef ? value : null;
      if (!ref) continue;
      const dict = dictFor(value);
      if (!dict) continue;
      const name = String(key).replace(/^\//, '');
      const at = `${path}/${name}`;
      const subtype = subtypeOf(dict);
      if (subtype === 'Image') {
        if (seen.has(ref.toString())) continue;
        seen.add(ref.toString());
        const object = doc.context.lookup(ref);
        found.push({
          path: at,
          dict,
          bytes: object instanceof PDFRawStream ? object.contents : new Uint8Array(),
        });
      } else if (subtype === 'Form' && depth < limit && !visiting.has(ref.toString())) {
        const resources = dictFor(dict.get(PDFName.of('Resources')));
        const nested = resources ? dictFor(resources.get(PDFName.of('XObject'))) : null;
        if (!nested) continue;
        visiting.add(ref.toString());
        walk(nested, depth + 1, at, visiting);
        visiting.delete(ref.toString());
      }
    }
  };
  for (const page of doc.getPages()) {
    const resources = dictFor(page.node.Resources());
    const xobjects = resources ? dictFor(resources.get(PDFName.of('XObject'))) : null;
    if (xobjects) walk(xobjects, 0, '', new Set());
  }
  return found;
}

/** A document of `count` pages, optionally titled for the render double. */
async function textPdf(count = 2, title = ''): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  if (title) doc.setTitle(title);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < count; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Body text page ${i + 1}`, { x: 60, y: 700, size: 16, font, color: rgb(0, 0, 0) });
  }
  return doc.save({ useObjectStreams: false });
}

/* ── readers that are not the producer ────────────────────────────────────── */

beforeAll(() => {
  installCanvas();
  rasterAvailable = true;
  // `core/render` points pdf.js at its worker with a URL Node's loader refuses,
  // and it re-assigns on every open; the setter keeps the on-disk path so real
  // text extraction can run here.
  let workerPath = `file://${process.cwd()}/node_modules/pdfjs-dist/build/pdf.worker.mjs`;
  Object.defineProperty(GlobalWorkerOptions, 'workerSrc', {
    configurable: true,
    get: () => workerPath,
    set: (value: string) => {
      if (value.startsWith('file:') || value.startsWith('data:')) workerPath = value;
    },
  });
}, 120_000);

/** Every string pdf.js can read out of the file — the user's select-all. */
async function extractableText(bytes: Uint8Array): Promise<string[]> {
  // pdf.js transfers the buffer it is handed, so every call gets its own copy.
  // No `standardFontDataUrl`: a `file://` fetch fails here, and text extraction
  // does not need the font programs — only painting would.
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes.slice()),
    isEvalSupported: false,
    disableAutoFetch: true,
  }).promise;
  const pages: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '));
  }
  await doc.destroy();
  return pages;
}

/** The image XObjects of a document, with the bytes each one stores. */function imageObjects(doc: PDFDocument): Array<{ dict: PDFDict; bytes: Uint8Array }> {
  const out: Array<{ dict: PDFDict; bytes: Uint8Array }> = [];
  for (const page of doc.getPages()) {
    const resources = page.node.Resources();
    const map = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    if (!map) continue;
    for (const [, value] of map.entries()) {
      const object = value instanceof PDFRef ? doc.context.lookup(value) : value;
      if (object instanceof PDFRawStream) out.push({ dict: object.dict, bytes: object.contents });
    }
  }
  return out;
}

/**
 * Resolve a reference to a raw stream, or say it is not one.
 *
 * `PDFContext#lookup` is typed against a union of the object classes, so the
 * second argument is easier to express once here than at every call site.
 */
function rawStream(doc: PDFDocument, value: unknown): PDFRawStream | null {
  const object = value instanceof PDFRef ? doc.context.lookup(value) : value;
  return object instanceof PDFRawStream ? object : null;
}

function dictNumber(dict: PDFDict, key: string): number | null {
  const value = dict.get(PDFName.of(key));
  return value instanceof PDFNumber ? Math.trunc(value.asNumber()) : null;
}

function dictName(dict: PDFDict, key: string): string | null {
  const value = dict.get(PDFName.of(key));
  // `PDFName#toString` answers `/Image`; the escape forms (`#20`) do not appear
  // in any of the names measured here.
  return value instanceof PDFName ? String(value).replace(/^\//, '') : null;
}

/**
 * Quadrant means of a re-encoded image, taken from the samples the file carries.
 * PDF stores the top row first, so index order is top-left, top-right,
 * bottom-left, bottom-right.
 */
function quadrantMeans(pixels: Uint8Array, width: number, height: number): number[] {
  const sums = [0, 0, 0, 0];
  const counts = [0, 0, 0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 3;
      const which = (y < height / 2 ? 0 : 2) + (x < width / 2 ? 0 : 1);
      sums[which] += (pixels[at] + pixels[at + 1] + pixels[at + 2]) / 3;
      counts[which] += 1;
    }
  }
  return sums.map((sum, i) => (counts[i] > 0 ? sum / counts[i] : -1));
}

async function runTool(
  id: string,
  values: ToolValues = {},
  files?: File[],
): Promise<{ bytes: Uint8Array; message: string; warnings: string[]; pagesOut: number | null }> {
  const outcome = await runPdfTool({
    toolId: id,
    files: files ?? [pdfFile(await textPdf(), 'fixture.pdf')],
    values,
    onProgress: () => undefined,
    onLog: () => undefined,
  });
  return {
    bytes: new Uint8Array(await outcome.outputs[0].blob.arrayBuffer()),
    message: outcome.message ?? '',
    warnings: outcome.warnings,
    pagesOut: outcome.pagesOut,
  };
}

/** Call a tool's `run` the way a bespoke pane does: no runner, no clamping. */
async function paneRun(id: string, values: ToolValues, files: File[]): Promise<ToolResult> {
  const tool = getPdfTool(id);
  expect(tool, `${id} is not registered`).toBeTruthy();
  const inputs: ToolFile[] = files.map((file) => ({
    name: file.name,
    size: file.size,
    type: file.type,
    bytes: async () => new Uint8Array(await file.arrayBuffer()),
    blob: () => file.slice(0, file.size, file.type || 'application/pdf'),
  }));
  return tool!.run!({
    inputs,
    values: { ...defaultValues(tool!.fields), ...values },
    progress: () => undefined,
    log: () => undefined,
    signal: new AbortController().signal,
  } as never);
}

/**
 * Narrow a pane's result to the PDF arm of `ToolResult`.
 *
 * Only `kind: 'pdf'` carries `bytes`, so this checks rather than casts: a pane
 * that answered with a report or a file list is a wrong answer for these tests,
 * and a cast would have hidden it behind `undefined`.
 */
function asPdf(result: ToolResult): {
  bytes: Uint8Array;
  message: string;
  warnings: string[];
  pages: number | undefined;
} {
  if (result.kind !== 'pdf') {
    throw new Error(`the pane returned kind "${result.kind}", not a PDF`);
  }
  return {
    bytes: result.bytes,
    message: result.message ?? '',
    warnings: result.warnings ?? [],
    pages: result.pages,
  };
}

/* ── core/compress.ts ─────────────────────────────────────────────────────── */

describe('core/compress re-encodes pixels that can be measured', () => {
  beforeEach(() => {
    rasterAvailable = true;
  });

  it('downsamples to the box on the page instead of cropping the pixels', async () => {
    // 64 px drawn 32 pt wide is 144 dpi; the ask is 72, so half the pixels go.
    const bytes = await rasterFixture({ px: 64, boxPt: 32 });
    const { bytes: out, report } = await compressPDF({ bytes }, { preset: 'balanced', maxDpi: 72 });

    const doc = await openPDF(out);
    const [image] = imageObjects(doc);
    expect(dictName(image.dict, 'Filter')).toBe('DCTDecode');
    expect(dictNumber(image.dict, 'Width'), 'stored width should be half of 64').toBe(32);
    expect(dictNumber(image.dict, 'Height')).toBe(32);
    expect(dictNumber(image.dict, 'Length'), 'the stream lies about its length').toBe(
      image.bytes.byteLength,
    );

    const decoded = decodeStubJpeg(image.bytes);
    expect(decoded.width).toBe(32);
    // Top-left, top-right, bottom-left, bottom-right of the *source*. A
    // `putImageData` crop leaves all four at the top-left value: the bottom half
    // of the page would simply be gone.
    const means = quadrantMeans(decoded.rgb, decoded.width, decoded.height);
    expect(Math.round(means[0])).toBeLessThan(30);
    expect(Math.round(means[1])).toBeGreaterThan(220);
    expect(Math.round(means[2])).toBeGreaterThan(70);
    expect(Math.round(means[2])).toBeLessThan(115);
    expect(Math.round(means[3])).toBeGreaterThan(180);

    expect(report.images.replaced).toBe(1);
    expect(report.images.savedBytes).toBeGreaterThan(0);
    expect(out.byteLength).toBeLessThan(bytes.byteLength);
    expect(doc.getPageCount()).toBe(2);
    // The text the tool promises to keep is still text a reader can select.
    expect((await extractableText(out)).join(' ')).toContain('Body text that must survive');
  });

  it('measures the box the image is drawn into, not its stored pixel count', async () => {
    // Reading `/Width` back out again made every image 72 dpi, so a 300 dpi scan
    // survived while the report said the cap had been applied.
    const bytes = await rasterFixture({ px: 64, boxPt: 16 });
    const { report, bytes: out } = await compressPDF({ bytes }, { preset: 'balanced', maxDpi: 72 });
    expect(report.images.replaced).toBe(1);
    expect(dictNumber(imageObjects(await openPDF(out))[0].dict, 'Width')).toBe(16);
  });

  it('keeps enough pixels for the widest placement of a shared image', async () => {
    // The same XObject is drawn 16 pt wide on page 1 and 128 pt wide on page 2:
    // 36 dpi overall, so nothing may go.
    const bytes = await rasterFixture({ px: 64, boxPt: 16, alsoOnPage2At: 128 });
    const { report } = await compressPDF({ bytes }, { preset: 'balanced', maxDpi: 72 });
    expect(report.images.replaced).toBe(0);
  });

  it('keeps the soft mask when asked, and paints paper under it', async () => {
    const bytes = await rasterFixture({ px: 64, boxPt: 64, alpha: 'half' });
    const { bytes: out } = await compressPDF({ bytes }, { preset: 'balanced', keepTransparency: true });
    const doc = await openPDF(out);
    const [image] = imageObjects(doc);
    expect(dictName(image.dict, 'Filter')).toBe('DCTDecode');
    expect(dictName(image.dict, 'ColorSpace')).toBe('DeviceRGB');
    const mask = image.dict.get(PDFName.of('SMask'));
    expect(mask instanceof PDFRef, 'the /SMask reference did not survive').toBe(true);

    // Fully masked pixels composite onto the paper fill rather than onto black:
    // an anti-aliased logo grows a dark halo when the fill is skipped.
    const decoded = decodeStubJpeg(image.bytes);
    const means = quadrantMeans(decoded.rgb, decoded.width, decoded.height);
    expect(Math.round(means[2])).toBeGreaterThan(240);
    expect(Math.round(means[3])).toBeGreaterThan(240);
  });

  it('drops the soft mask when transparency is turned off', async () => {
    const bytes = await rasterFixture({ px: 64, boxPt: 64, alpha: 'half' });
    const { bytes: out } = await compressPDF({ bytes }, { preset: 'balanced', keepTransparency: false });
    const [image] = imageObjects(await openPDF(out));
    expect(image.dict.get(PDFName.of('SMask'))).toBeUndefined();
  });

  it('re-writes the pixels when greyscale is asked for, and counts them', async () => {
    const bytes = await rasterFixture({
      px: 64,
      boxPt: 16,
      quadrants: [
        [230, 20, 20],
        [20, 220, 20],
        [20, 20, 210],
        [240, 240, 240],
      ],
    });
    const { bytes: out, report } = await compressPDF({ bytes }, { preset: 'balanced', grayscale: true });
    expect(report.images.replaced).toBe(1);
    const decoded = decodeStubJpeg(imageObjects(await openPDF(out))[0].bytes);
    for (let i = 0; i < decoded.width * decoded.height; i++) {
      expect(decoded.rgb[i * 3]).toBe(decoded.rgb[i * 3 + 1]);
      expect(decoded.rgb[i * 3 + 1]).toBe(decoded.rgb[i * 3 + 2]);
    }
    // Green carries the most luma, blue the least: the numbers went through a
    // grey transform instead of only being reported as one.
    const means = quadrantMeans(decoded.rgb, decoded.width, decoded.height);
    expect(means[1]).toBeGreaterThan(means[0]);
    expect(means[0]).toBeGreaterThan(means[2]);
    expect(report.notes.join(' ')).toContain(`${report.images.replaced} image re-encoded as greyscale.`);
  });

  it('multiplies the transforms when measuring the box on the page', async () => {
    // The image is drawn 16 pt wide inside a 2× group, so it occupies 32 pt:
    // 144 dpi, halved by the ask. Reading only the innermost `cm` would call it
    // 288 dpi and throw away three quarters of the pixels.
    const bytes = await rasterFixture({ px: 64, boxPt: 16, scaleGroup: 2 });
    const { report, bytes: out } = await compressPDF({ bytes }, { preset: 'balanced', maxDpi: 72 });
    expect(report.images.replaced).toBe(1);
    expect(dictNumber(imageObjects(await openPDF(out))[0].dict, 'Width')).toBe(32);
  });

  it('says the browser cannot re-encode, once, instead of failing per image', async () => {
    const bytes = await rasterFixture({ px: 64, boxPt: 32 });
    rasterAvailable = false;
    const { bytes: out, report } = await compressPDF({ bytes }, { preset: 'balanced', maxDpi: 72 });
    rasterAvailable = true;

    expect(report.images.replaced).toBe(0);
    expect(report.images.skipped).toBe(report.images.total);
    expect(report.notes.filter((note) => /cannot re-encode images/.test(note))).toHaveLength(1);
    // Structure only: the image is the one that went in.
    const [image] = imageObjects(await openPDF(out));
    expect(dictNumber(image.dict, 'Width')).toBe(64);
    expect(dictName(image.dict, 'Filter')).toBe('FlateDecode');
  });

});

/* ── images nested in Form XObjects ───────────────────────────────── */

describe('core/compress reaches images nested in Form XObjects', () => {
  beforeEach(() => {
    rasterAvailable = true;
  });

  /** The one image the resource walk found at `path`, or a failing message. */
  function storedAt(images: FoundImage[], path: string): FoundImage {
    const found = images.find((image) => image.path === path);
    expect(found, `the resource walk found no image at ${path}`).toBeTruthy();
    return found as FoundImage;
  }

  /** The `/XObject` names one form's own content draws. */
  function drawnNames(doc: PDFDocument, ref: PDFRef): string[] {
    const stream = doc.context.lookup(ref);
    expect(stream instanceof PDFStream, `the form ${ref.toString()} is not a stream any more`).toBe(true);
    return parseContentStream(streamBytes(stream as PDFStream))
      .filter((op) => op.name === 'Do')
      .map((op) => String((op.operands[0] as { value?: string }).value ?? ''));
  }

  /** How many rasters a reader's own display list paints on a page. */
  async function paintedImages(bytes: Uint8Array, page = 1): Promise<number> {
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(bytes.slice()),
      isEvalSupported: false,
      disableAutoFetch: true,
    }).promise;
    try {
      const list = await (await doc.getPage(page)).getOperatorList();
      // A form's operators are inlined into the page's list, so a picture inside a
      // form shows up here exactly as a page-level one does.
      const paint = (OPS as unknown as Record<string, number>).paintImageXObject;
      return list.fnArray.filter((id: number) => id === paint).length;
    } finally {
      await doc.destroy();
    }
  }

  it('finds, counts and replaces the image a Form XObject draws', async () => {
    // 8 form units through the page's 2× placement is 16 pt on the page, so 64 px
    // is 288 dpi and the 72 dpi ask halves it.
    const fixture = await nestedFixture({ px: 64, boxPt: 8, levels: 1, formScale: 2 });
    expect(
      walkImageResources(await openPDF(fixture.bytes)),
      'the fixture must really nest its image inside a form',
    ).toHaveLength(1);

    const { bytes: out, report } = await compressPDF(
      { bytes: fixture.bytes },
      { preset: 'balanced', maxDpi: 72 },
    );
    const doc = await openPDF(out);
    const images = walkImageResources(doc);
    expect(report.images.total, 'report.images.total must match an independent resource walk').toBe(
      images.length,
    );
    expect(report.images.total).toBe(1);
    expect(report.images.unmeasured).toBe(0);
    expect(report.images.replaced).toBe(1);

    const [image] = images;
    expect(dictName(image.dict, 'Subtype')).toBe('Image');
    expect(dictName(image.dict, 'Filter'), 'the nested stream was never re-encoded').toBe('DCTDecode');
    expect(dictNumber(image.dict, 'Width'), 'downsampled through the form matrix').toBe(16);
    expect(Array.from(image.bytes)).not.toEqual(Array.from(fixture.images[0].bytes));
    // The form still asks for the picture, under the same resource name.
    expect(drawnNames(doc, fixture.forms[0])).toContain('Im0');
    expect(await paintedImages(out)).toBe(1);
  });

  it('measures a nested image through every matrix that reaches it', async () => {
    // Two levels, each halving: /Im0 is 8 × 2 = 16 pt (288 dpi → 16 px) and /Im1 is
    // 8 × 2 × 0.5 = 8 pt (576 dpi → 8 px). One flat page-level measure would give
    // both of them the same width; the two different numbers are the point.
    const fixture = await nestedFixture({
      px: 64,
      boxPt: 8,
      levels: 2,
      formScale: 2,
      perLevelScale: 0.5,
      bboxOffset: 20,
    });
    const { bytes: out, report } = await compressPDF(
      { bytes: fixture.bytes },
      { preset: 'balanced', maxDpi: 72 },
    );
    const images = walkImageResources(await openPDF(out));
    expect(report.images.total).toBe(images.length);
    expect(report.images.total).toBe(2);
    expect(report.images.replaced).toBe(2);
    expect(report.images.unmeasured).toBe(0);
    expect(dictNumber(storedAt(images, '/Art/Im0').dict, 'Width')).toBe(16);
    expect(dictNumber(storedAt(images, '/Art/F1/Im1').dict, 'Width')).toBe(8);
  });

  it('walks a form that draws itself once, and refuses to resize what it cannot measure', async () => {
    // /F1 draws /F0 back, so one placement of every image in the cycle is always
    // deeper than the walk that is measuring it. Vitest would time out rather than
    // fail if either walk had no cycle guard, so the assertions below are about the
    // report: found, re-encoded, and explicitly not resized.
    const fixture = await nestedFixture({ px: 64, boxPt: 8, levels: 2, formScale: 2, cycle: true, mask: true });
    const { bytes: out, report } = await compressPDF(
      { bytes: fixture.bytes },
      { preset: 'balanced', maxDpi: 72 },
    );
    const images = walkImageResources(await openPDF(out));
    expect(report.images.total).toBe(images.length);
    expect(report.images.total).toBe(2);
    expect(report.images.unmeasured).toBe(2);
    const note = report.notes.join(' ');
    expect(note).toMatch(/could not measure/);
    expect(note).toContain('/Im0');
    // Replacing the stream is safe wherever the image lives, so the artwork still
    // went through a canvas — and it came back the same size it went in.
    expect(report.images.replaced).toBe(2);
    for (const image of images) {
      expect(dictName(image.dict, 'Filter'), 'the stream should still have been replaced').toBe('DCTDecode');
      expect(dictNumber(image.dict, 'Width'), 'resized on a box nobody measured').toBe(64);
      expect(image.dict.get(PDFName.of('SMask')) instanceof PDFRef, 'the soft mask went missing').toBe(true);
    }
  });

  it('stops at the depth it says it stops at, and names the form it left behind', async () => {
    const fixture = await nestedFixture({ px: 64, boxPt: 8, levels: 7, formScale: 2 });
    const before = walkImageResources(await openPDF(fixture.bytes), Number.POSITIVE_INFINITY);
    expect(before, 'the fixture must be seven forms deep').toHaveLength(7);

    const { bytes: out, report } = await compressPDF(
      { bytes: fixture.bytes },
      { preset: 'balanced', maxDpi: 72 },
    );
    const images = walkImageResources(await openPDF(out));
    expect(report.images.total).toBe(images.length);
    // Six levels of form are searched, the seventh is not, and the report says so.
    expect(report.images.total).toBe(6);
    expect(report.images.unmeasured).toBe(0);
    const note = report.notes.find((line) => /was not searched for images/.test(line));
    expect(note, `no note about a skipped form in ${JSON.stringify(report.notes)}`).toBeDefined();
    expect(note).toContain('/F6');

    const deep = storedAt(before, '/Art/F1/F2/F3/F4/F5/F6/Im6');
    const untouched = storedAt(
      walkImageResources(await openPDF(out), Number.POSITIVE_INFINITY),
      deep.path,
    );
    expect(dictName(untouched.dict, 'Filter'), 'past the bound the image was touched anyway').toBe('FlateDecode');
    expect(Array.from(untouched.bytes)).toEqual(Array.from(deep.bytes));
  });

  it('shrinks nested artwork, and the picture is still drawn', async () => {
    // Three levels of 96 px pictures drawn 12 form units wide at 2×: 24 pt, so
    // 288 dpi gives way to the 72 dpi ask and only the pixels go.
    const fixture = await nestedFixture({ px: 96, boxPt: 12, levels: 3, formScale: 2 });
    const { bytes: out, report } = await compressPDF(
      { bytes: fixture.bytes },
      { preset: 'balanced', maxDpi: 72 },
    );
    const doc = await openPDF(out);
    const images = walkImageResources(doc);
    expect(report.images.total, 'report.images.total must match an independent resource walk').toBe(
      images.length,
    );
    expect(report.images.total).toBe(3);
    expect(report.images.replaced).toBe(3);
    expect(out.byteLength, 'nested artwork must still come out smaller').toBeLessThan(
      fixture.bytes.byteLength,
    );
    expect(doc.getPageCount()).toBe(2);
    // The text the tool promises to keep is still text, and the reader still
    // paints three pictures on page 1.
    expect((await extractableText(out)).join(' ')).toContain('Page with nested artwork');
    expect(await paintedImages(out)).toBe(3);
    for (let level = 0; level < 3; level++) {
      expect(drawnNames(doc, fixture.forms[level]), `form ${level} stopped drawing its image`).toContain(
        `Im${level}`,
      );
      const path = `/Art${Array.from({ length: level }, (_, i) => `/F${i + 1}`).join('')}/Im${level}`;
      const image = storedAt(images, path);
      expect(dictNumber(image.dict, 'Width')).toBe(24);
      const decoded = decodeStubJpeg(image.bytes);
      const means = quadrantMeans(decoded.rgb, decoded.width, decoded.height);
      // All four quadrants of the source survived: a blank box, or the top-left
      // corner copied about, fails one of these.
      expect(Math.round(means[0])).toBeLessThan(40);
      expect(Math.round(means[1])).toBeGreaterThan(215);
      expect(means[1] - means[0]).toBeGreaterThan(40);
      expect(means[3] - means[2]).toBeGreaterThan(40);
    }
  });
});

/* ── core/redact.ts ───────────────────────────────────────────────────────── */

describe('core/redact deletes glyphs rather than painting over them', () => {
  async function secretPdf(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([595, 842]);
    page.drawText('SECRET-ACCOUNT 42424242', { x: 60, y: 700, size: 18, font, color: rgb(0, 0, 0) });
    page.drawText('the public line stays here', { x: 60, y: 660, size: 18, font });
    return doc.save({ useObjectStreams: false });
  }
  const overTheSecret = { page: 0, rect: { x: 50, y: 690, width: 320, height: 26 } };

  it('removes the covered text from what a reader can extract', async () => {
    const source = await secretPdf();
    expect((await extractableText(source))[0]).toContain('SECRET-ACCOUNT');

    const doc = await openPDF(source);
    const outcome = applyRedactions(doc, [overTheSecret], { fill: '#000000' });
    expect(outcome.removed).toBeGreaterThan(0);
    const bytes = await doc.save();

    const pages = await extractableText(bytes);
    expect(pages[0], 'the secret survived in the text layer').not.toMatch(/SECRET-ACCOUNT|42424242/);
    expect(pages[0]).toContain('the public line stays here');
    // Nothing else in the file is hiding it either.
    expect(latin1.decode(bytes)).not.toContain('SECRET-ACCOUNT');
    // And the page still looks redacted: a filled rectangle was painted.
    const painted = pageContentOps((await openPDF(bytes)).getPage(0));
    expect(painted.some((op) => op.name === 're')).toBe(true);
    expect(painted.some((op) => op.name === 'f' || op.name === 'F' || op.name === 'f*')).toBe(true);
  });

  it('a painted-over box would have failed the test above (control)', async () => {
    const doc = await openPDF(await secretPdf());
    doc.getPage(0).drawRectangle({ x: 50, y: 690, width: 320, height: 26, color: rgb(0, 0, 0) });
    // The page looks identical to a redaction and hides nothing from a reader:
    // this is the fake the module exists to prevent.
    expect((await extractableText(await doc.save()))[0]).toContain('SECRET-ACCOUNT');
  });

  it('reports that it removed nothing when the rect covers no glyph', async () => {
    const doc = await openPDF(await secretPdf());
    const outcome = applyRedactions(doc, [{ page: 0, rect: { x: 400, y: 200, width: 60, height: 20 } }]);
    expect(outcome.removed).toBe(0);
    const pages = await extractableText(await doc.save());
    expect(pages[0]).toContain('SECRET-ACCOUNT');
    expect(pages[0]).toContain('the public line stays here');
  });
});

/* ── the tools, against their own output ──────────────────────────────────── */

describe('optimize tools print numbers the output bytes agree with', () => {
  it('pdf-compress states the sizes it actually produced', async () => {
    const bytes = await rasterFixture({ px: 64, boxPt: 32 });
    const outcome = await runTool('pdf-compress', { preset: 'balanced', maxDpi: 72 }, [
      pdfFile(bytes, 'scan.pdf'),
    ]);
    expect(outcome.bytes.byteLength).toBeLessThan(bytes.byteLength);
    expect(outcome.message).toContain(describeSize(bytes.byteLength));
    expect(outcome.message).toContain(describeSize(outcome.bytes.byteLength));
    expect(outcome.message).toMatch(/-\d+%/);
    expect(outcome.message).toContain('1 of 1 image(s) re-encoded');
    expect(outcome.pagesOut).toBe(2);
    expect((await openPDF(outcome.bytes)).getPageCount()).toBe(2);
  });

  it('pdf-compress counts the images it found inside forms and names the ones it could not reach', async () => {
    // Seven levels of form: six are searched and re-encoded, the seventh is the
    // case the report has to admit to by name rather than silently skip.
    const fixture = await nestedFixture({ px: 64, boxPt: 8, levels: 7, formScale: 2 });
    const outcome = await runTool('pdf-compress', { preset: 'balanced', maxDpi: 72 }, [
      pdfFile(fixture.bytes, 'artwork.pdf'),
    ]);
    const walked = walkImageResources(await openPDF(outcome.bytes));
    expect(walked).toHaveLength(6);
    // The count in the sentence is the count in the file, and none of it is the
    // "no images" sentence the flat walk used to print over an illustration.
    expect(outcome.message).toContain('6 of 6 image(s) re-encoded');
    expect(outcome.warnings.join(' ')).not.toMatch(/no images/i);
    const note = outcome.warnings.find((line) => /was not searched for images/.test(line));
    expect(note, `no note about the skipped form in ${JSON.stringify(outcome.warnings)}`).toBeDefined();
    expect(note).toContain('/F6');
    expect(outcome.bytes.byteLength).toBeLessThan(fixture.bytes.byteLength);
  });

  it('sanitize-pdf counts the optional content groups it leaves behind', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([595, 842]).drawText('layered drawing', { x: 60, y: 700, size: 14, font });
    addLayer(doc, 'Revision B');
    addLayer(doc, 'Dimensions', { on: false });

    const outcome = await runTool('sanitize-pdf', {}, [pdfFile(await doc.save(), 'layers.pdf')]);
    const note = outcome.warnings.find((line) => /optional content group/.test(line));
    expect(note, `no layer warning in ${JSON.stringify(outcome.warnings)}`).toBeDefined();
    // The count in the sentence is the count in the file it produced.
    const after = await openPDF(outcome.bytes);
    const layers = listLayers(after);
    expect(layers.map((layer) => layer.name).sort()).toEqual(['Dimensions', 'Revision B']);
    expect(note).toContain(`${layers.length} optional content group`);
    expect(note).toContain('1 of them hidden');
    expect(after.getPageCount()).toBe(1);
  });

  it('pdf-to-pdfa writes a metadata stream a validator can type-check', async () => {
    const outcome = await runTool('pdf-to-pdfa', { part: '2b' });
    const doc = await openPDF(outcome.bytes);
    const ref = doc.catalog.get(PDFName.of('Metadata'));
    expect(ref instanceof PDFRef, 'the catalogue lost /Metadata').toBe(true);
    const stream = rawStream(doc, ref);
    expect(stream, 'the metadata stream is not a stream').toBeTruthy();
    // `/N` on a metadata stream is the component count of its own data, and
    // ISO 32000-1 Table 162 says it is 0 there. An array is a type error, and
    // this tool's whole claim is that a validator can read the result.
    const n = stream!.dict.get(PDFName.of('N'));
    expect(n instanceof PDFNumber, `/N was written as a ${n?.constructor.name ?? 'nothing'}`).toBe(true);
    expect((n as PDFNumber).asNumber()).toBe(0);
    expect(dictName(stream!.dict, 'Subtype')).toBe('XML');
    expect(latin1.decode(inflateSync(Buffer.from(stream!.contents)))).toMatch(/pdfaid:part="2"/);
    // The identification is not bought with an unreadable file.
    expect(doc.getPageCount()).toBe(2);
    expect((await extractableText(outcome.bytes)).join(' ')).toContain('Body text page 1');
    expect(outcome.warnings.join(' ')).toMatch(/No conformance check was run/);
  });

  it('repair counts the pages the output really has and admits the lost ones', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 3; i++) {
      doc.addPage([595, 842]).drawText(`page ${i + 1}`, { x: 60, y: 700, size: 16, font });
    }
    // A page tree that claims five children and carries three: the file opens,
    // so the only honest report is "3 of 5".
    const text = latin1.decode(await doc.save({ useObjectStreams: false }));
    expect(text).toContain('/Count 3');
    const lying = new Uint8Array(Buffer.from(text.replace('/Count 3', '/Count 5'), 'latin1'));

    const outcome = await runTool('repair', {}, [pdfFile(lying, 'lies.pdf')]);
    const pages = (await openPDF(outcome.bytes)).getPageCount();
    expect(pages).toBe(3);
    expect(outcome.pagesOut).toBe(pages);
    expect(outcome.message).toContain('3 of 5 page(s) readable');
    expect(outcome.warnings.join(' ')).toContain('2 page(s) could not be recovered');
    expect(outcome.warnings.join(' ')).not.toMatch(/without losing pages/);
  });

  it('repair claims "without losing pages" only when both counts are the same', async () => {
    const outcome = await runTool('repair', {}, [pdfFile(await textPdf(4), 'sound.pdf')]);
    const pages = (await openPDF(outcome.bytes)).getPageCount();
    expect(pages).toBe(4);
    expect(outcome.warnings.join(' ')).toContain(`without losing pages (${pages} in, ${pages} out)`);
    expect(outcome.message).toContain('4 page(s) readable');
  });

  it('rasterize-pdf leaves no interactive field and no live text behind', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([595, 842]).drawText('form to flatten', { x: 60, y: 700, size: 16, font });
    doc.addPage([595, 842]).drawText('second page to flatten', { x: 60, y: 700, size: 16, font });
    doc.getForm().createTextField('applicant.name').setText('Ada Lovelace');
    const source = await doc.save({ useObjectStreams: false });
    expect((await PDFDocument.load(source)).getForm().getFields()).toHaveLength(1);

    const outcome = await runTool('rasterize-pdf', { dpi: 144, format: 'jpeg' }, [
      pdfFile(source, 'form.pdf'),
    ]);
    const flat = await PDFDocument.load(outcome.bytes);
    expect(flat.getPageCount()).toBe(2);
    expect(outcome.pagesOut).toBe(2);
    // No field survives: not through the form API, and not in the catalogue.
    expect(flat.getForm().getFields()).toHaveLength(0);
    const reopened = await openPDF(outcome.bytes);
    expect(reopened.catalog.get(PDFName.of('AcroForm'))).toBeUndefined();
    for (const page of reopened.getPages()) {
      // A fresh pdf-lib page carries an empty `/Annots`; what must not survive is
      // an annotation entry.
      const annots = page.node.get(PDFName.of('Annots'));
      expect(annots instanceof PDFArray ? annots.size() : 0).toBe(0);
    }
    // The pages are pictures at the asked resolution, on the original sheet size.
    const images = imageObjects(reopened);
    expect(images).toHaveLength(2);
    expect(dictNumber(images[0].dict, 'Width')).toBe(Math.round(595 * (144 / 72)));
    expect((await extractableText(outcome.bytes)).join('')).toBe('');
    expect(outcome.warnings.join(' ')).toMatch(/2 of 2 page\(s\) carried text.*selected or searched/);
  });

  it('linearize-pdf does not count pages it never opened', async () => {
    const source = await textPdf(2);
    // A file with a linearization dictionary in its first kilobyte, which is the
    // only thing the tool is allowed to read a verdict from.
    engine.linearized = Uint8Array.from(
      Buffer.concat([
        Buffer.from('%PDF-1.7\n1 0 obj <</Linearized 1>> endobj\n', 'latin1'),
        Buffer.from(source),
      ]),
    );
    const outcome = await runTool('linearize-pdf');
    engine.linearized = null;
    expect(outcome.message).toContain('Linearized with CoherentPDF');
    // The standing ruling: the engine returned bytes, not a document, so the
    // count stays "not counted" — no re-parse, no regex, no invented number.
    expect(outcome.pagesOut).toBeNull();
  });

  it('linearize-pdf says plainly that the local rebuild is not linearized', async () => {
    const outcome = await runTool('linearize-pdf');
    expect(outcome.warnings.join(' ')).toMatch(/CoherentPDF could not be reached/);
    expect(outcome.message).toMatch(/not a conforming linearized PDF/);
    expect(latin1.decode(outcome.bytes.subarray(0, 2048))).not.toMatch(/\/Linearized\s/);
    expect(outcome.pagesOut).toBe(2);
  });
});

/* ── legacy.ts: the panes that write numbers ──────────────────────────────── */

describe('legacy panes measure what they claim', () => {
  /** The comparison's overlay: a marked pixel is an opaque one. */
  async function overlayOf(result: { bytes: Uint8Array }): Promise<{
    marked: number;
    width: number;
    height: number;
    samples: Uint8Array;
    channels: number;
  }> {
    const doc = await openPDF(result.bytes);
    const page = doc.getPage(0);
    const xobjects = page.node.Resources()!.lookupMaybe(PDFName.of('XObject'), PDFDict)!;
    const drawn = pageContentOps(page)
      .filter((op) => op.name === 'Do')
      .map((op) => String((op.operands[0] as { value?: string }).value ?? ''));
    // Draw order is document order: the sheet first, the highlight overlay last.
    const image = rawStream(doc, xobjects.get(PDFName.of(drawn[drawn.length - 1])));
    expect(image, 'the comparison wrote no image').toBeTruthy();
    const width = dictNumber(image!.dict, 'Width') ?? 0;
    const height = dictNumber(image!.dict, 'Height') ?? 0;
    const channels = dictName(image!.dict, 'ColorSpace') === 'DeviceGray' ? 1 : 3;
    const samples = streamBytes(image!);
    const maskRef = image!.dict.get(PDFName.of('SMask'));
    let marked = 0;
    if (maskRef instanceof PDFRef) {
      const mask = rawStream(doc, maskRef);
      expect(mask, 'the overlay has a /SMask reference that leads nowhere').toBeTruthy();
      const alpha = inflateSync(Buffer.from(mask!.contents));
      for (let i = 0; i < width * height; i++) if (alpha[i] > 0) marked += 1;
    }
    return { marked, width, height, samples, channels };
  }

  it('pdf-crop writes the millimetres it was given, in points, and says so', async () => {
    const source = await textPdf(1);
    const before = await openPDF(source);
    const box = mediaBox(before.getPage(0));
    const result = asPdf(await paneRun('pdf-crop', {
      top: 10,
      right: 10,
      bottom: 10,
      left: 10,
      unit: 'mm',
    }, [pdfFile(source, 'sheet.pdf')]));

    const after = await openPDF(result.bytes);
    const cropped = mediaBox(after.getPage(0));
    // 10 mm is 28.3 pt: the boxes must have lost that, not the 10 the user typed.
    const expected = Math.round(10 * (72 / 25.4) * 10) / 10;
    expect((box.width - cropped.width) / 2).toBeCloseTo(expected, 1);
    expect((box.height - cropped.height) / 2).toBeCloseTo(expected, 1);
    expect(cropped.x).toBeCloseTo(box.x + expected, 1);
    expect(cropped.y).toBeCloseTo(box.y + expected, 1);
    // And the sentence names the unit the file is written in, with the typed
    // numbers attributed to the conversion rather than to the page.
    expect(result.message).toContain(`${expected} pt (top/right/bottom/left)`);
    expect(result.message).not.toMatch(/28\.3\/28\.3\/28\.3\/28\.3 mm/);
    expect(result.message).toContain('10/10/10/10 mm you entered, converted');
    expect(after.getPageCount()).toBe(1);
    expect(result.warnings).toEqual([]);
  });

  it('pdf-crop clamps a margin a pane handed it and reports the correction', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([3000, 2500]);
    const result = asPdf(await paneRun('pdf-crop', { top: 9000, right: 0, bottom: 0, left: 0 }, [
      pdfFile(await doc.save(), 'poster.pdf'),
    ]));
    const poster = await openPDF(result.bytes);
    expect(result.warnings.join(' ')).toMatch(/Top margin must be between 0 and 2000: 9000 became 2000/);
    expect(mediaBox(poster.getPage(0)).height).toBeCloseTo(500, 1);
  });

  it('compare marks exactly the pixels that differ', async () => {
    const first = await textPdf(1, 'diff-a');
    const second = await textPdf(1, 'diff-b');
    // Keep the double cheap: 120 × 100 pt at the engine's 2× scale is 240 × 200 px.
    renders.size = [120, 100];
    renders.paint.clear();
    const files = (): File[] => [pdfFile(first, 'a.pdf'), pdfFile(second, 'b.pdf')];

    // Two identical renders first: the honest difference count is zero, and a
    // test that skipped this would pass on an overlay painted everywhere.
    const same = asPdf(await paneRun('compare', { sensitivity: 30 }, files()));
    expect(await overlayOf(same)).toMatchObject({ marked: 0 });
    expect(same.pages).toBe(1);

    // Now page 1 differs in exactly one known way: a 12 × 8 px black square.
    renders.paint.set('diff-b', (ctx) => {
      ctx.fillStyle = '#000000';
      ctx.fillRect(100, 100, 12, 8);
    });
    const diff = asPdf(await paneRun('compare', { sensitivity: 30 }, files()));
    const overlay = await overlayOf(diff);
    expect(overlay.width * overlay.height).toBe(240 * 200);
    expect(overlay.marked, 'the overlay marks a different number of pixels than changed').toBe(96);
    expect(diff.pages).toBe(1);
    expect((await openPDF(diff.bytes)).getPageCount()).toBe(1);

    // E15: 9000 is outside the slider and above the largest distance a pixel
    // pair can produce (765), so an unclamped run would paint nothing at all
    // while still handing back a comparison.
    const wild = asPdf(await paneRun('compare', { sensitivity: 9000 }, files()));
    expect(wild.warnings.join(' ')).toMatch(/Sensitivity must be between 5 and 150: 9000 became 150/);
    expect((await overlayOf(wild)).marked).toBe(96);

    // A colour the diff cannot paint with is refused out loud, and the pixels
    // carry the fallback that was announced.
    const badColour = asPdf(await paneRun('compare', { highlightColor: 'rebecca' }, files()));
    expect(badColour.warnings.join(' ')).toMatch(/not a colour/);
    expect(badColour.warnings.join(' ')).toMatch(/#ff0000/);
    const painted = await overlayOf(badColour);
    const at = (100 * painted.width + 100) * painted.channels;
    expect(Array.from(painted.samples.subarray(at, at + 3))).toEqual([255, 0, 0]);

    renders.size = [595, 842];
    renders.paint.clear();
  });
});
