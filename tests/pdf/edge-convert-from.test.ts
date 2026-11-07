/**
 * Edge cases for the Convert-from-PDF family (refinement brief §B6, 17 tools).
 *
 * Every one of these tools can fail in the same two ways: it reports success on
 * a result that contains nothing (E13), or it mangles the bytes / the file name
 * on the way out (E11, E17). The previous pass on this category claimed both
 * were fixed but never landed a test file, so every claim is checked here
 * against **produced bytes**, not against a log line.
 *
 * What is real:
 * - The parser. Documents are built with `@maxwbh/pdf-lib` (plus one hand-written
 *   Type0/CID fixture so CJK is exercised without a CJK face on disk) and read
 *   back through the real `pdf.js`: `documentToJson`, `detectTables`,
 *   `extractPageImages`, `pageSizeReport` and the ZIP/xlsx/docx writers all run.
 *   `core/render` is **not** mocked away — only `renderPage` is, see below.
 * - The BMP/TIFF encoders, the alpha-flatten path and `concatTiffs`, which are
 *   fed real pixel buffers and whose output is decoded again (own PNG/BMP
 *   readers, `utif` for TIFF) — so "the download decodes back to the page" is a
 *   byte-level assertion.
 *
 * What is stubbed, and why: jsdom has no 2-D raster. `PdfSession.renderPage`
 * keeps pdf.js's real, rotation-aware viewport for its geometry and returns a
 * canvas painted with a per-page signature colour. A blob that wrapped its
 * bytes twice, a page swapped with another, or a size that ignored `/Rotate`
 * all still fail here.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { PDFDocument, StandardFonts, degrees, rgb } from '@maxwbh/pdf-lib';
import UTIF from 'utif';
import * as pdfjs from 'pdfjs-dist';
import { convertFromTools } from '@/lib/pdf/tools/convert-from';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { runPdfTool, type RunOutcome } from '@/lib/pdf/tools/runner';
import { readZip } from '@/lib/pdf/core/archive';
import { ToolInputError } from '@/lib/pdf/core/guard';
import type { PageRender } from '@/lib/pdf/core/render';
import type { ToolFile, ToolResult, ToolRunContext, ToolValues } from '@/lib/pdf/tools/types';

/* ── pdf.js in jsdom ──────────────────────────────────────────────────────── */

const require = createRequire(import.meta.url);
/**
 * `core/render` derives `workerSrc` from `import.meta.url`, which Vitest serves
 * over `http:`; the ESM loader refuses that protocol, so pdf.js cannot start its
 * fake worker. Pin the real file instead of stubbing the parser away.
 */
const WORKER_SRC = pathToFileURL(require.resolve('pdfjs-dist/build/pdf.worker.mjs')).href;
Object.defineProperty(pdfjs.GlobalWorkerOptions, 'workerSrc', {
  configurable: true,
  get: () => WORKER_SRC,
  set: () => undefined,
});

/** Which pages were rasterised, in call order — the cancel and progress checks. */
const RASTER = vi.hoisted(() => ({ pages: [] as number[] }));

vi.mock('@/lib/pdf/core/render', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/pdf/core/render')>();
  const openReal = real.openRender;
  return {
    ...real,
    openRender: async (bytes: ArrayBuffer | Uint8Array, options?: Parameters<typeof openReal>[1]) => {
      const session = await openReal(bytes, options);
      // Everything pdf.js can do headless (parse, text layer, viewport maths,
      // operator lists) stays real; only the painting is replaced.
      session.renderPage = async (n: number, scale: number): Promise<PageRender> => {
        RASTER.pages.push(n);
        const proxy = await session.page(n);
        const viewport = proxy.getViewport({ scale, rotation: proxy.rotate });
        const canvas = paintPage(n, Math.max(1, Math.floor(viewport.width)), Math.max(1, Math.floor(viewport.height)));
        return {
          canvas,
          ctx: canvas.getContext('2d') as CanvasRenderingContext2D,
          width: canvas.width,
          height: canvas.height,
          unitsPerPixel: 1 / scale,
          pageNumber: n,
          cancel: () => proxy.cleanup(),
        };
      };
      return session;
    },
  } as typeof real;
});

/* ── a canvas that holds real pixels ──────────────────────────────────────── */

interface Surface {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

const surfaces = new WeakMap<HTMLCanvasElement, Surface>();

function surfaceOf(canvas: HTMLCanvasElement): Surface {
  const width = Math.max(1, canvas.width | 0);
  const height = Math.max(1, canvas.height | 0);
  let surface = surfaces.get(canvas);
  if (!surface || surface.width !== width || surface.height !== height) {
    surface = { width, height, data: new Uint8ClampedArray(width * height * 4) };
    surfaces.set(canvas, surface);
  }
  return surface;
}

/** Colour a page paints with, so a decode can say *which* page it came from. */
function pageColour(page: number): [number, number, number] {
  return [(page * 37) % 251 + 2, (page * 79) % 241 + 3, (page * 101) % 247 + 4];
}

function paintPage(page: number, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const surface = surfaceOf(canvas);
  const [r, g, b] = pageColour(page);
  for (let i = 0; i < width * height; i++) {
    surface.data[i * 4] = r;
    surface.data[i * 4 + 1] = g;
    surface.data[i * 4 + 2] = b;
    surface.data[i * 4 + 3] = 255;
  }
  return canvas;
}

const NOOP = () => undefined;

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const read = (x: number, y: number, w: number, h: number, target: Uint8ClampedArray) => {
    const source = surfaceOf(canvas);
    for (let row = 0; row < h; row++) {
      for (let column = 0; column < w; column++) {
        const sx = x + column;
        const sy = y + row;
        const inside = sx >= 0 && sy >= 0 && sx < source.width && sy < source.height;
        const from = inside ? (sy * source.width + sx) * 4 : 0;
        const to = (row * w + column) * 4;
        target[to] = inside ? source.data[from] : 0;
        target[to + 1] = inside ? source.data[from + 1] : 0;
        target[to + 2] = inside ? source.data[from + 2] : 0;
        target[to + 3] = inside ? source.data[from + 3] : 0;
      }
    }
  };
  const state: Record<string, unknown> = {
    canvas,
    fillStyle: '#000000',
    strokeStyle: '#000000',
    globalAlpha: 1,
    getImageData: (x: number, y: number, w: number, h: number) => {
      const data = new Uint8ClampedArray(w * h * 4);
      read(x, y, w, h, data);
      return { data, width: w, height: h };
    },
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData: (image: { data: Uint8ClampedArray; width: number; height: number }, dx: number, dy: number) => {
      const target = surfaceOf(canvas);
      for (let row = 0; row < image.height; row++) {
        for (let column = 0; column < image.width; column++) {
          const sx = dx + column;
          const sy = dy + row;
          if (sx < 0 || sy < 0 || sx >= target.width || sy >= target.height) continue;
          const from = (row * image.width + column) * 4;
          const to = (sy * target.width + sx) * 4;
          target.data[to] = image.data[from];
          target.data[to + 1] = image.data[from + 1];
          target.data[to + 2] = image.data[from + 2];
          target.data[to + 3] = image.data[from + 3];
        }
      }
    },
    drawImage: (source: HTMLCanvasElement, dx = 0, dy = 0) => {
      const from = surfaces.get(source);
      const target = surfaceOf(canvas);
      if (!from) return;
      for (let row = 0; row < from.height; row++) {
        for (let column = 0; column < from.width; column++) {
          const sx = dx + column;
          const sy = dy + row;
          if (sx < 0 || sy < 0 || sx >= target.width || sy >= target.height) continue;
          const src = (row * from.width + column) * 4;
          const dst = (sy * target.width + sx) * 4;
          target.data[dst] = from.data[src];
          target.data[dst + 1] = from.data[src + 1];
          target.data[dst + 2] = from.data[src + 2];
          target.data[dst + 3] = from.data[src + 3];
        }
      }
    },
    createLinearGradient: () => ({ addColorStop: NOOP }),
    createRadialGradient: () => ({ addColorStop: NOOP }),
    createPattern: () => null,
    measureText: (text: string) => ({ width: String(text).length * 6 }),
    getTransform: () => new DOMMatrix(),
  };
  return new Proxy(state, {
    get: (target, key: string) => (key in target ? target[key] : NOOP),
    set: (target, key: string, value: unknown) => {
      target[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function installCanvasShim(): void {
  const proto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
  proto.getContext = function (this: HTMLCanvasElement) {
    return context2d(this);
  };
  // jsdom only ships `ImageData` when node-canvas is installed, and
  // `core/images-out` builds one to paint raw samples onto a canvas. The real
  // browser has it; this is the same object with the same two constructors.
  if (typeof globalThis.ImageData === 'undefined') {
    class ShimImageData {
      width: number;

      height: number;

      data: Uint8ClampedArray;

      constructor(a: Uint8ClampedArray | number, b: number, c?: number) {
        if (typeof a === 'number') {
          this.width = a;
          this.height = b;
          this.data = new Uint8ClampedArray(a * b * 4);
        } else {
          this.data = a;
          this.width = b;
          this.height = c ?? Math.max(1, Math.floor(a.length / 4 / b));
        }
      }
    }
    Object.defineProperty(globalThis, 'ImageData', {
      value: ShimImageData,
      writable: true,
      configurable: true,
    });
  }
  // The browser would hand back JPEG or WebP here; the shim hands PNG bytes with
  // the requested mime type, so the tool's mime/name path still runs and the
  // payload stays decodable.
  proto.toBlob = function (
    this: HTMLCanvasElement,
    callback: (blob: Blob | null) => void,
    type?: string,
  ) {
    const surface = surfaceOf(this);
    callback(new Blob([encodePng(surface.width, surface.height, surface.data)], { type: type ?? 'image/png' }));
  };
  proto.toDataURL = function (this: HTMLCanvasElement) {
    const surface = surfaceOf(this);
    return `data:image/png;base64,${Buffer.from(encodePng(surface.width, surface.height, surface.data)).toString('base64')}`;
  };
}

/* ── tiny image codecs (test-side, independent of the app's) ──────────────── */

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)) >>> 0);
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function encodePng(width: number, height: number, rgba: Uint8ClampedArray): Uint8Array {
  const stride = width * 4 + 1;
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * stride + 1);
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  return concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

interface DecodedImage {
  width: number;
  height: number;
  /** RGBA, row-major, top-down. */
  data: Uint8ClampedArray;
}

function decodePng(bytes: Uint8Array): DecodedImage {
  for (let i = 0; i < 8; i++) expect(bytes[i]).toBe(PNG_SIGNATURE[i]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 4;
  const idat: Uint8Array[] = [];
  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      const depth = bytes[offset + 16];
      const colour = bytes[offset + 17];
      expect(depth, 'only 8-bit fixtures are decoded here').toBe(8);
      channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colour] ?? 0;
      expect(channels, `unsupported PNG colour type ${colour}`).toBeGreaterThan(0);
    } else if (type === 'IDAT') {
      idat.push(Uint8Array.from(body));
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  expect(channels, 'the PNG carried no IHDR').toBeGreaterThan(0);
  const raw = new Uint8Array(inflateSync(Buffer.concat(idat.map((part) => Buffer.from(part)))));
  const stride = width * channels;
  const out = new Uint8ClampedArray(width * height * 4);
  const previous = new Uint8Array(stride);
  const current = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    current.set(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? current[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      const value = raw[y * (stride + 1) + 1 + x];
      current[x] = (value + reconstruction(filter, value, left, up, upLeft)) & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const to = (y * width + x) * 4;
      const from = x * channels;
      const grey = channels < 3;
      out[to] = current[from];
      out[to + 1] = grey ? current[from] : current[from + 1];
      out[to + 2] = grey ? current[from] : current[from + 2];
      out[to + 3] = alpha(current, from, channels);
    }
    previous.set(current);
  }
  return { width, height, data: out };
}

/** How much to add to a filtered byte, per PNG filter type. */
function reconstruction(
  filter: number,
  value: number,
  left: number,
  up: number,
  upLeft: number,
): number {
  if (filter === 0) return 0;
  if (filter === 1) return left;
  if (filter === 2) return up;
  if (filter === 3) return Math.floor((left + up) / 2);
  return paeth(left, up, upLeft);
}

function alpha(row: Uint8Array, from: number, channels: number): number {
  if (channels === 4) return row[from + 3];
  if (channels === 2) return row[from + 1];
  return 255;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** 24-bit, bottom-up, **BGR** BMP, matching `core/raster`'s encoder. */
function decodeBmp(bytes: Uint8Array): DecodedImage {
  expect(String.fromCharCode(bytes[0], bytes[1])).toBe('BM');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = view.getUint32(10, true);
  const width = view.getInt32(18, true);
  const height = view.getInt32(22, true);
  expect(view.getUint16(28, true), 'only 24-bit BMPs are decoded here').toBe(24);
  const rowBytes = Math.ceil((width * 3) / 4) * 4;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) {
    const from = offset + (height - 1 - row) * rowBytes;
    for (let column = 0; column < width; column++) {
      const to = (row * width + column) * 4;
      // Blue first: reading the triple as RGB is exactly the mistake a viewer
      // makes, and every colour in the page comes back inverted.
      data[to] = bytes[from + column * 3 + 2];
      data[to + 1] = bytes[from + column * 3 + 1];
      data[to + 2] = bytes[from + column * 3];
      data[to + 3] = 255;
    }
  }
  return { width, height, data };
}

/** Every page of a (possibly multi-page) TIFF, decoded by the app's own dep. */
async function decodeTiff(blob: Blob): Promise<DecodedImage[]> {
  const buffer = await blob.arrayBuffer();
  const ifds = UTIF.decode(buffer);
  return ifds.map((ifd) => {
    UTIF.decodeImage(buffer, ifd);
    const rgba = UTIF.toRGBA8(ifd);
    // The size comes from the raw `ImageWidth`/`ImageLength` tags rather than
    // `ifd.width`: `decodeImage` derives those fields from the same two tags, and
    // the ambient `UtifIFD` type keeps the derived ones off the handle on purpose
    // (see `src/types/utif.d.ts`) — reading a field UTIF happens not to set, like
    // `ifd.w`, is what used to decode every imported TIFF to a 0 × 0 canvas (E12).
    // This is the independent oracle, so it goes to the file itself.
    const tags = ifd as unknown as { t256?: number[]; t257?: number[] };
    const width = tags.t256?.[0] ?? 0;
    const height = tags.t257?.[0] ?? 0;
    expect(width, 'the TIFF states its page width').toBeGreaterThan(0);
    expect(height, 'the TIFF states its page height').toBeGreaterThan(0);
    return { width, height, data: new Uint8ClampedArray(rgba) };
  });
}

function pixelAt(image: DecodedImage, x: number, y: number): number[] {
  const at = (y * image.width + x) * 4;
  return [image.data[at], image.data[at + 1], image.data[at + 2], image.data[at + 3]];
}

function solidPng(width: number, height: number, colour: [number, number, number, number]): Uint8Array {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = colour[0];
    data[i * 4 + 1] = colour[1];
    data[i * 4 + 2] = colour[2];
    data[i * 4 + 3] = colour[3];
  }
  return encodePng(width, height, data);
}

/** A 1×1 baseline JPEG: `extractPageImages` must hand these back untouched. */
const TINY_JPEG = Uint8Array.from(
  Buffer.from(
    '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDs0NDL/wAALCAABAAEBAREA/8QAFAABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AmAA/9k=',
    'base64',
  ),
);

/* ── fixtures ─────────────────────────────────────────────────────────────── */

function fileOf(bytes: Uint8Array, name = 'annual report.pdf'): File {
  // SAFETY: a copy of the bytes is a valid BlobPart.
  return new File([Buffer.from(bytes)], name, { type: 'application/pdf' });
}

/** Four text pages, the shape most of these tools are pointed at. */
async function textPdf(pages = 4): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(`Heading for page ${i + 1}`, { x: 60, y: 760, size: 22, font, color: rgb(0, 0, 0) });
    page.drawText(`Body text number ${i + 1}: the quick brown fox jumps.`, { x: 60, y: 700, size: 11, font });
    page.drawText(`Accents café, naïve, Zürich — Ü ß Ñ.`, { x: 60, y: 660, size: 11, font });
  }
  doc.setTitle('Annual Report');
  return doc.save({ useObjectStreams: false });
}

/** A4 portrait, Letter landscape and a `/Rotate 90` page (E8, E9). */
async function mixedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const a4 = doc.addPage([595.28, 841.89]);
  a4.drawText('portrait page', { x: 40, y: 700, size: 14, font });
  const letter = doc.addPage([792, 612]);
  letter.drawText('landscape page', { x: 40, y: 500, size: 14, font });
  const turned = doc.addPage([400, 300]);
  turned.setRotation(degrees(90));
  turned.drawText('rotated page', { x: 20, y: 200, size: 14, font });
  const upside = doc.addPage([400, 300]);
  upside.setRotation(degrees(180));
  upside.drawText('upside down page', { x: 20, y: 200, size: 14, font });
  return doc.save({ useObjectStreams: false });
}

/** Image-only pages: a scan has pixels and no text layer (E10). */
async function scanPdf(pages = 2): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([595.28, 841.89]);
    const image = await doc.embedPng(solidPng(40, 24, [200, 30 + i * 9, 40, 255]));
    page.drawImage(image, { x: 60, y: 600, width: 300, height: 180 });
  }
  return doc.save({ useObjectStreams: false });
}

/** Two empty pages — no text, no images. */
async function blankPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([300, 200]);
  doc.addPage([300, 200]);
  return doc.save({ useObjectStreams: false });
}

/** Text plus one scanned page, the partially-honest case (E10, E7). */
async function halfScannedPdf(scans = 1, text = 2): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < scans; i++) {
    const page = doc.addPage([595.28, 841.89]);
    const image = await doc.embedPng(solidPng(24, 24, [10, 200, 30, 255]));
    page.drawImage(image, { x: 60, y: 600, width: 300, height: 300 });
  }
  for (let i = 0; i < text; i++) {
    doc.addPage([595.28, 841.89]).drawText(`Readable page ${i + 1}`, { x: 60, y: 700, size: 16, font });
  }
  return doc.save({ useObjectStreams: false });
}

/** A ruled-free grid that `core/tables` reads as a table. */
async function tablePdf(rows = 5): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595.28, 841.89]);
  const header = ['Item', 'Quantity', 'Price'];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < header.length; c++) {
      const text = r === 0 ? header[c] : `row ${r} col ${c + 1}`;
      page.drawText(text, { x: 60 + c * 140, y: 760 - r * 22, size: 11, font });
    }
  }
  const second = doc.addPage([595.28, 841.89]);
  second.drawText('No grid here, just prose about the quarter and how it went.', { x: 60, y: 700, size: 11, font });
  return doc.save({ useObjectStreams: false });
}

/**
 * The same grid, behind a cover page that carries real large type (E10, headings).
 *
 * `tablePdf` draws every cell at 11 pt, so it cannot demonstrate heading
 * promotion at all — there is no height above the body size to promote, and an
 * assertion that a header cell becomes `# Item` was only ever testing a shape
 * the exporter does not produce. The heading sits on its own page so the grid
 * stays a clean 5-row table for the CSV, XLSX and Markdown table assertions.
 */
async function headingGridPdf(): Promise<Uint8Array> {
  return cached('heading-grid', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const cover = doc.addPage([595.28, 841.89]);
    cover.drawText('Quarterly Prices', { x: 60, y: 760, size: 26, font, color: rgb(0, 0, 0) });
    cover.drawText('Prepared from the ledger, with the totals below.', { x: 60, y: 700, size: 11, font });
    const page = doc.addPage([595.28, 841.89]);
    const header = ['Item', 'Quantity', 'Price'];
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < header.length; c++) {
        page.drawText(r === 0 ? header[c] : `row ${r} col ${c + 1}`, {
          x: 60 + c * 140,
          y: 760 - r * 22,
          size: 11,
          font,
        });
      }
    }
    return doc.save({ useObjectStreams: false });
  });
}

/**
 * One page holding twelve images plus eleven pages holding one each, so both
 * zero-padded counters (page and index) are exercised by a single run (E17).
 */
async function manyImagesPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const crowded = doc.addPage([595.28, 841.89]);
  for (let i = 0; i < 12; i++) {
    const image = await doc.embedPng(solidPng(16, 12, [10 + i, 200 - i * 7, 40 + i * 3, 255]));
    crowded.drawImage(image, { x: 40 + (i % 4) * 60, y: 600 - Math.floor(i / 4) * 60, width: 40, height: 30 });
  }
  for (let page = 2; page <= 12; page++) {
    const alone = doc.addPage([595.28, 841.89]);
    const image = await doc.embedPng(solidPng(20 + page, 14, [page * 5, 90, 130, 255]));
    alone.drawImage(image, { x: 60, y: 600, width: 100, height: 70 });
  }
  return doc.save({ useObjectStreams: false });
}

async function jpegImagePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const image = await doc.embedJpg(TINY_JPEG);
  page.drawImage(image, { x: 60, y: 600, width: 60, height: 60 });
  return doc.save({ useObjectStreams: false });
}

/** 500 small pages with text, the "did it drop the tail" case (E7). */
async function bigTextPdf(pages = 500): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    doc.addPage([120, 90]).drawText(`Page ${i + 1} of five hundred`, { x: 6, y: 60, size: 8, font });
  }
  return doc.save({ useObjectStreams: false });
}

/**
 * A page written as CID text with a `/ToUnicode` CMap — real CJK through the
 * real parser, without needing a CJK face installed.
 */
function cjkPdf(): Uint8Array {
  const toUnicode = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    '2 beginbfchar',
    '<4E2D> <4E2D>',
    '<6587> <6587>',
    'endbfchar',
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n');
  const content = 'BT /F1 24 Tf 72 700 Td <4E2D6587> Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /TestCJK /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 6 0 R >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /TestCJK /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 8 0 R /DW 1000 >>',
    `<< /Length ${toUnicode.length} >>\nstream\n${toUnicode}\nendstream`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /FontDescriptor /FontName /TestCJK /Flags 4 /FontBBox [-1000 -1000 1000 1000] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>',
  ];
  let pdf = '%PDF-1.7\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const start = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

/* ── run helpers ──────────────────────────────────────────────────────────── */

/** Ids this suite actually executed, asserted at the end so no tool hides. */
const COVERED = new Set<string>();
const CONVERT_FROM_IDS = convertFromTools
  .filter((tool) => tool.category === 'convert-from' && tool.run)
  .map((tool) => tool.id);

async function run(
  id: string,
  values: ToolValues = {},
  files?: File[],
): Promise<RunOutcome> {
  const inputs = files ?? [fileOf(await textPdfCached())];
  COVERED.add(id);
  const outcome = await runPdfTool({
    toolId: id,
    files: inputs,
    values,
    onProgress: () => undefined,
    onLog: () => undefined,
  });
  expect(outcome, `${id} produced no outcome`).toBeTruthy();
  return outcome;
}

/**
 * `tool.run` directly, which is how E15 is checked honestly: the rail clamps an
 * out-of-range number before the tool sees it, so the refusal path is only
 * reachable through this seam (a sidecar, another UI, a bad preset).
 */
async function runRaw(
  id: string,
  values: ToolValues = {},
  files?: File[],
  signal: AbortSignal = new AbortController().signal,
): Promise<ToolResult> {
  const inputFiles = files ?? [fileOf(await textPdfCached())];
  COVERED.add(id);
  const tool = getPdfTool(id);
  expect(tool, `${id} is not registered`).toBeTruthy();
  const inputs: ToolFile[] = inputFiles.map((file) => ({
    name: file.name,
    size: file.size,
    type: file.type,
    bytes: async () => new Uint8Array(await file.arrayBuffer()),
    blob: () => file.slice(0, file.size, file.type),
  }));
  const context: ToolRunContext = {
    inputs,
    values,
    progress: () => undefined,
    log: () => undefined,
    signal,
  };
  return (await tool!.run!(context))!;
}

async function failures(id: string, values: ToolValues, files: File[]): Promise<string> {
  try {
    await run(id, values, files);
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  throw new Error(`${id} succeeded where it was expected to refuse`);
}

async function textOf(outcome: RunOutcome, index = 0): Promise<string> {
  const output = outcome.outputs[index];
  expect(output, `${index} was not in the output list`).toBeTruthy();
  // `ignoreBOM` because the CSV tools write a UTF-8 BOM on purpose and the test
  // has to be able to see it: the default decoder silently eats those three
  // bytes, which made "Excel needs the BOM" unassertable.
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(
    new Uint8Array(await output.blob.arrayBuffer()),
  );
}

function reportText(outcome: RunOutcome): string {
  const sections = outcome.report?.sections ?? [];
  return sections
    .map((section) => [section.title, section.text ?? '', ...(section.rows ?? []).map((row) => `${row.label}: ${row.value}`)].join('\n'))
    .join('\n');
}

async function zipEntries(outcome: RunOutcome, index = 0) {
  const output = outcome.outputs[index];
  expect(output, 'expected a zip output').toBeTruthy();
  return readZip(await output.blob.arrayBuffer());
}

/** Cached so a 500-page fixture is built once per suite, not once per test. */
const cache = new Map<string, Uint8Array>();
async function cached(key: string, build: () => Promise<Uint8Array>): Promise<Uint8Array> {
  const hit = cache.get(key);
  if (hit) return hit;
  const bytes = await build();
  cache.set(key, bytes);
  return bytes;
}
function textPdfCached(): Promise<Uint8Array> {
  return cached('text', () => textPdf());
}

beforeAll(() => {
  installCanvasShim();
});

/* ── single-page and coloured fixtures used by a few groups ───────────────── */

async function singlePagePdf(): Promise<Uint8Array> {
  return cached('single', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([400, 300]).drawText('Only page', { x: 40, y: 200, size: 14, font });
    return doc.save({ useObjectStreams: false });
  });
}

async function colouredPdf(): Promise<Uint8Array> {
  return cached('coloured', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([400, 300]);
    page.drawRectangle({ x: 40, y: 160, width: 200, height: 80, color: rgb(0.9, 0.2, 0.1) });
    page.drawText('Colour heading', { x: 40, y: 60, size: 16, font, color: rgb(0.1, 0.4, 0.9) });
    return doc.save({ useObjectStreams: false });
  });
}

/**
 * A page whose text layer carries the invisible junk a broken glyph map leaves.
 *
 * Written by hand rather than with pdf-lib: `drawText` refuses to put U+0000 in
 * a WinAnsi string ("WinAnsi cannot encode"), so the fixture builds a Type0 font
 * whose `/ToUnicode` CMap maps codes onto NUL, SOH and BEL — the real defect, a
 * subset font with a nonsense Unicode map, and pdf.js faithfully returns it.
 */
function controlCharPdf(): Uint8Array {
  const toUnicode = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    '10 beginbfchar',
    '<0001> <006C>', '<0002> <0065>', '<0003> <0061>', '<0004> <0064>',
    '<0005> <0000>', '<0006> <0001>', '<0007> <0007>', '<0008> <0020>',
    '<0009> <0074>', '<000A> <0069>',
    'endbfchar',
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n');
  // lead\0\x01\x07 tail
  const content = 'BT /F1 14 Tf 30 200 Td <0001000200030004000500060007000800090003000A0001> Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 8 0 R >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /Broken /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 6 0 R >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /Broken /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 7 0 R /DW 500 >>',
    `<< /Length ${toUnicode.length} >>\nstream\n${toUnicode}\nendstream`,
    '<< /Type /FontDescriptor /FontName /Broken /Flags 4 /FontBBox [-1000 -1000 1000 1000] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  return assemblePdf(objects);
}

/** Minimal valid xref PDF from a list of already-serialised bodies (E10 fixtures). */
function assemblePdf(objects: string[]): Uint8Array {
  let pdf = '%PDF-1.7\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const start = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

function expectPageSignature(image: DecodedImage, page: number, label: string): void {
  const [r, g, b] = pageColour(page);
  const pixel = pixelAt(image, Math.floor(image.width / 2), Math.floor(image.height / 2));
  // `expect(value, message)` — the value comes first, which the original order
  // had backwards, so every call was comparing a label string to a colour.
  expect(pixel.slice(0, 3), `${label} pixel`).toEqual([r, g, b]);
  expect(pixel[3], `${label} must stay opaque`).toBe(255);
}

/* ── the family as a whole ────────────────────────────────────────────────── */

describe('convert-from family', () => {
  it('registers seventeen runnable convert-from tools', () => {
    expect([...CONVERT_FROM_IDS].sort()).toEqual([
      'extract-images',
      'extract-tables',
      'pdf-to-bmp',
      'pdf-to-csv',
      'pdf-to-excel',
      'pdf-to-greyscale',
      'pdf-to-image',
      'pdf-to-jpg',
      'pdf-to-json',
      'pdf-to-markdown',
      'pdf-to-png',
      'pdf-to-svg',
      'pdf-to-text',
      'pdf-to-tiff',
      'pdf-to-webp',
      'pdf-to-word',
      'prepare-pdf-for-ai',
    ]);
    expect(CONVERT_FROM_IDS).toHaveLength(17);
    // The claim this suite had to check: there is no PDF→PPTX and no PDF→HTML
    // tool in this category (or anywhere in the registry) — `html-to-pdf` and
    // `powerpoint-to-pdf` in `convert-to` run the other way.
    expect(getPdfTool('pdf-to-pptx')).toBeUndefined();
    expect(getPdfTool('pdf-to-html')).toBeUndefined();
  });

  it('refuses an empty file and a mislabelled image by name (E1, E2)', async () => {
    const empty = new File([], 'empty.pdf', { type: 'application/pdf' });
    await expect(run('pdf-to-text', {}, [empty])).rejects.toThrow(/empty\.pdf/);
    const mislabelled = new File([Buffer.from(TINY_JPEG)], 'scan.pdf', { type: 'application/pdf' });
    const message = await failures('pdf-to-text', {}, [mislabelled]);
    expect(message).toMatch(/scan\.pdf/);
    expect(message).toMatch(/not a PDF|PDF/i);
  });
});

/* ── pdf-to-text ──────────────────────────────────────────────────────────── */

describe('pdf-to-text', () => {
  it('extracts every page and counts what it read (E7 message honesty)', async () => {
    const outcome = await run('pdf-to-text');
    const body = await textOf(outcome);
    expect(outcome.outputs[0].name).toBe('annual report.txt');
    expect(body).toContain('Heading for page 1');
    expect(body).toContain('Body text number 4');
    expect(outcome.message).toMatch(/4 page\(s\)/);
    expect(outcome.message).not.toMatch(/\b0 words\b/);
  });

  it('separates pages with a form feed and adds markers only when asked', async () => {
    const plain = await run('pdf-to-text', { pages: 'all' });
    expect(await textOf(plain)).toContain('\f');
    const marked = await run('pdf-to-text', { pages: 'all', pageMarkers: true, layout: false });
    const body = await textOf(marked);
    expect(body).toContain('--- page 3 ---');
    expect(body).not.toContain('\f');
  });

  it('accepts page 1 of a one-page document and refuses page 2 (E6)', async () => {
    const one = [fileOf(await singlePagePdf(), 'only.pdf')];
    const outcome = await run('pdf-to-text', { pages: '1' }, one);
    expect(await textOf(outcome)).toContain('Only page');
    const message = await failures('pdf-to-text', { pages: '2' }, one);
    expect(message).toMatch(/1-1|outside/);
  });

  it('calls a scan a scan instead of reporting zero words (E10, E13)', async () => {
    const outcome = await run('pdf-to-text', { pages: 'all' }, [fileOf(await scanPdf(2), 'scan.pdf')]);
    expect(outcome.outputs).toHaveLength(0);
    expect(outcome.report).toBeTruthy();
    expect(reportText(outcome)).toMatch(/no text layer|images but no text/i);
    expect(reportText(outcome) + (outcome.warnings ?? []).join(' ')).toMatch(/OCR/i);
    expect(outcome.warnings.join(' ')).toMatch(/text layer|OCR/i);
  });

  it('keeps the readable pages of a half-scanned file and names the lost ones (E10)', async () => {
    const outcome = await run('pdf-to-text', { pages: 'all' }, [
      fileOf(await halfScannedPdf(3, 2), 'mixed.pdf'),
    ]);
    const body = await textOf(outcome);
    expect(body).toContain('Readable page 1');
    expect(body).toContain('Readable page 2');
    expect(outcome.outputs).toHaveLength(1);
    expect(outcome.warnings.join(' ')).toMatch(/no text layer/i);
    expect(outcome.warnings.join(' ')).toMatch(/1-3/);
  });

  it('says the pages are blank instead of downloading an empty file (E13)', async () => {
    const outcome = await run('pdf-to-text', { pages: 'all' }, [fileOf(await blankPdf(), 'blank.pdf')]);
    expect(outcome.outputs).toHaveLength(0);
    expect(reportText(outcome)).toMatch(/blank/i);
  });

  it('extracts CJK written as CID text with a /ToUnicode map (E11)', async () => {
    const outcome = await run('pdf-to-text', { pages: 'all' }, [fileOf(cjkPdf(), '报告.pdf')]);
    const body = await textOf(outcome);
    expect(body).toContain('中文');
    expect(outcome.outputs[0].name).toBe('报告.txt');
    expect(outcome.message).toMatch(/1 word|words/);
    expect(outcome.message).not.toMatch(/\b0 words\b/);
  });

  it('keeps accented Latin intact in the file and in the name (E11, E17)', async () => {
    const outcome = await run('pdf-to-text', { pages: '2' }, [
      fileOf(await textPdfCached(), 'Ünïcødé 报告 (draft v2).pdf'),
    ]);
    const body = await textOf(outcome);
    expect(body).toContain('café');
    expect(body).toContain('Zürich');
    expect(body).toContain('Ü ß Ñ');
    expect(outcome.outputs[0].name).toBe('Ünïcødé 报告 (draft v2).txt');
  });

  it('strips invisible glyph-map junk instead of faking a word count (E10)', async () => {
    const outcome = await run('pdf-to-text', { pages: 'all' }, [
      fileOf(controlCharPdf(), 'junk.pdf'),
    ]);
    const body = await textOf(outcome);
    expect(body).not.toMatch(/[\u0000-\u0008]/);
    expect(body).toContain('lead');
    expect(body).toContain('tail');
  });

  it('extracts all 500 pages of a long document without dropping the tail (E7)', async () => {
    const outcome = await run('pdf-to-text', { pages: 'all' }, [
      fileOf(await bigTextPdf(500), 'long.pdf'),
    ]);
    const body = await textOf(outcome);
    expect(body).toContain('Page 1 of five hundred');
    expect(body).toContain('Page 500 of five hundred');
    expect((body.match(/of five hundred/g) ?? [])).toHaveLength(500);
    expect(outcome.message).toMatch(/500 page\(s\)/);
  }, 120_000);

  it('never reports a truncated document as a clean extraction (E3)', async () => {
    const full = await textPdfCached();
    const damaged = full.subarray(0, Math.floor(full.length * 0.75));
    let warnings = '';
    let rejection = '';
    try {
      const outcome = await run('pdf-to-text', { pages: 'all' }, [fileOf(damaged, 'broken.pdf')]);
      warnings = outcome.warnings.join(' ');
    } catch (error) {
      rejection = error instanceof Error ? error.message : String(error);
    }
    const honest = rejection !== '' ? /broken\.pdf/.test(rejection) : /damag|recover|short/i.test(warnings);
    expect({ rejection, warnings, honest }).toMatchObject({ honest: true });
  });

  it('sanitises archive-hostile characters out of the download name (E17)', async () => {
    const outcome = await run('pdf-to-text', { pages: 'all' }, [
      fileOf(await textPdfCached(), 'a/b:c*e?.pdf'),
    ]);
    expect(outcome.outputs[0].name).toBe('a-b-c-e.txt');
  });

  it('refuses a page selection that matches nothing instead of an empty file (E13)', async () => {
    const outcome = await run('pdf-to-text', { pages: [] }, [fileOf(await textPdfCached())]);
    expect(outcome.outputs).toHaveLength(0);
    expect(reportText(outcome)).toMatch(/page/i);
  });
});

/* ── pdf-to-markdown ──────────────────────────────────────────────────────── */

describe('pdf-to-markdown', () => {
  it('promotes large type to headings and rebuilds the grid as a table', async () => {
    const outcome = await run('pdf-to-markdown', { pages: 'all' }, [
      fileOf(await headingGridPdf(), 'prices.pdf'),
    ]);
    const body = await textOf(outcome);
    // The 26 pt line on the cover page is the only heading-sized type there is;
    // the grid's own header row stays a header row, which is what a table is.
    expect(body).toMatch(/^#{1,3} Quarterly Prices/m);
    expect(body).toContain('| Item | Quantity | Price |');
    expect(body).toContain('| --- ');
    expect(body).toContain('row 1 col 1');

    // The toggle has to be able to switch promotion off, too — passing `[]`
    // downstream used to mean "detect it yourself", so off was the same as on.
    const flat = await run('pdf-to-markdown', { pages: 'all', headings: false }, [
      fileOf(await headingGridPdf(), 'prices.pdf'),
    ]);
    expect(await textOf(flat)).not.toMatch(/^#{1,6} /m);
  });

  it('leaves tables out when the toggle is off', async () => {
    const outcome = await run('pdf-to-markdown', { pages: 'all', tables: false }, [
      fileOf(await tablePdf(5), 'prices.pdf'),
    ]);
    const body = await textOf(outcome);
    expect(body).not.toContain('| --- ');
    expect(body).toContain('row 1 col 1');
  });

  it('separates pages with a rule when asked', async () => {
    const outcome = await run('pdf-to-markdown', { pages: 'all', pageBreaks: true });
    expect(await textOf(outcome)).toContain('\n---\n');
  });

  it('reports a scan instead of writing an empty .md (E10, E13)', async () => {
    const outcome = await run('pdf-to-markdown', { pages: 'all' }, [
      fileOf(await scanPdf(1), 'scan.pdf'),
    ]);
    expect(outcome.outputs).toHaveLength(0);
    expect(reportText(outcome)).toMatch(/text layer|OCR/i);
  });
});

/* ── pdf-to-json ──────────────────────────────────────────────────────────── */

describe('pdf-to-json', () => {
  it('emits geometry, blocks, image counts and rotation for every page (E8, E9)', async () => {
    const outcome = await run('pdf-to-json', { pages: 'all' }, [
      fileOf(await mixedPdf(), 'sizes.pdf'),
    ]);
    const json = JSON.parse(await textOf(outcome)) as {
      meta: Record<string, unknown>;
      pages: { page: number; width: number; height: number; rotation: number; text: string; images: number }[];
    };
    expect(json.pages).toHaveLength(4);
    expect(json.pages[0].width).toBeCloseTo(595.28, 1);
    expect(json.pages[1].width).toBeGreaterThan(json.pages[1].height);
    // A 400×300 page turned by 90° displays as 300×400.
    expect(json.pages[2].rotation).toBe(90);
    expect(json.pages[2].width).toBeLessThan(json.pages[2].height);
    expect(json.pages[3].rotation).toBe(180);
    expect(json.meta.pageCount).toBe(4);
  });

  it('says which pages have no text layer instead of shipping silent JSON (E10)', async () => {
    const outcome = await run('pdf-to-json', { pages: 'all' }, [
      fileOf(await halfScannedPdf(2, 1), 'mixed.pdf'),
    ]);
    const json = JSON.parse(await textOf(outcome)) as { pages: { images: number; text: string }[] };
    expect(json.pages).toHaveLength(3);
    expect(json.pages[0].images).toBeGreaterThan(0);
    expect(json.pages[0].text).toBe('');
    expect(outcome.warnings.join(' ')).toMatch(/no text layer/i);
  });

  it('reports a document with no content at all instead of an empty skeleton (E13)', async () => {
    const outcome = await run('pdf-to-json', { pages: 'all' }, [fileOf(await blankPdf(), 'blank.pdf')]);
    expect(outcome.outputs).toHaveLength(0);
    expect(reportText(outcome)).toMatch(/blank/i);
  });
});

/* ── prepare-pdf-for-ai ───────────────────────────────────────────────────── */

describe('prepare-pdf-for-ai', () => {
  it('chunks the document and merges the metadata it was given', async () => {
    const outcome = await run('prepare-pdf-for-ai', {
      pages: 'all',
      title: 'annual-report',
      extra: '{"source":"contracts"}',
    });
    const doc = JSON.parse(await textOf(outcome)) as {
      ref_doc_info: Record<string, { metadata: Record<string, unknown>; text: string }>;
    };
    expect(Object.keys(doc.ref_doc_info)).toEqual(['annual-report']);
    const record = doc.ref_doc_info['annual-report'];
    expect(record.metadata.source).toBe('contracts');
    expect(record.metadata.num_pages).toBe(4);
    expect(record.text).toContain('Body text number 4');
    expect(outcome.outputs[0].name).toBe('annual report-llamaindex.json');
  });

  it('refuses metadata that is not JSON, with a reason (E15)', async () => {
    const message = await failures('prepare-pdf-for-ai', { extra: 'not json' }, [
      fileOf(await textPdfCached()),
    ]);
    expect(message).toMatch(/valid JSON/i);
  });

  it('says so when there is nothing to chunk (E13)', async () => {
    const outcome = await run('prepare-pdf-for-ai', { pages: 'all' }, [
      fileOf(await scanPdf(1), 'scan.pdf'),
    ]);
    expect(outcome.outputs).toHaveLength(0);
    expect(reportText(outcome)).toMatch(/text layer|OCR|blank/i);
  });
});

/* ── the table trio ───────────────────────────────────────────────────────── */

describe('pdf-to-csv', () => {
  it('writes the detected grid with its header row, and a BOM for Excel (E11)', async () => {
    const outcome = await run('pdf-to-csv', { pages: 'all' }, [fileOf(await tablePdf(5), 'prices.pdf')]);
    const csv = await textOf(outcome);
    expect(csv.startsWith('\uFEFF'), 'Excel needs the UTF-8 BOM').toBe(true);
    const body = csv.replace(/^\uFEFF/, '');
    expect(body.split('\r\n')[0]).toContain('Item');
    expect(body).toContain('Quantity');
    expect(body).toContain('row 4 col 3');
    expect(outcome.outputs[0].name).toBe('prices.csv');
    expect(outcome.message).toMatch(/5 rows|4 rows/);
  });

  it('honours the delimiter choice', async () => {
    const outcome = await run('pdf-to-csv', { pages: 'all', delimiter: ';' }, [
      fileOf(await tablePdf(5), 'prices.pdf'),
    ]);
    const csv = (await textOf(outcome)).replace(/^\uFEFF/, '');
    expect(csv.split('\r\n')[0]).toContain(';');
  });

  it('says there are no tables instead of shipping a 0-row file (E13)', async () => {
    const outcome = await run('pdf-to-csv', { pages: 'all' }, [fileOf(await textPdfCached(), 'prose.pdf')]);
    expect(outcome.outputs).toHaveLength(0);
    expect(reportText(outcome)).toMatch(/no table/i);
    expect(reportText(outcome)).toMatch(/minimum rows|PDF to Text/i);
  });

  it('reports a scan as a scan, not as an empty spreadsheet (E10, E13)', async () => {
    const outcome = await run('pdf-to-csv', { pages: 'all' }, [fileOf(await scanPdf(1), 'scan.pdf')]);
    expect(outcome.outputs).toHaveLength(0);
    expect(reportText(outcome)).toMatch(/text layer|OCR/i);
  });

  it('respects the minimum row count in both directions', async () => {
    const strict = await run('pdf-to-csv', { pages: 'all', minRows: 10 }, [
      fileOf(await tablePdf(5), 'prices.pdf'),
    ]);
    expect(strict.outputs).toHaveLength(0);
    const lenient = await run('pdf-to-csv', { pages: 'all', minRows: 2 }, [
      fileOf(await tablePdf(5), 'prices.pdf'),
    ]);
    expect(lenient.outputs).toHaveLength(1);
  });
});

describe('extract-tables', () => {
  it('writes JSON, CSV and Markdown views of the same grid', async () => {
    const json = await run('extract-tables', { pages: 'all', format: 'json' }, [
      fileOf(await tablePdf(5), 'prices.pdf'),
    ]);
    const parsed = JSON.parse(await textOf(json)) as {
      tables: { page: number; rows: string[][]; headerRow?: string[] }[];
    };
    expect(parsed.tables.length).toBeGreaterThan(0);
    expect(parsed.tables[0].rows.length).toBeGreaterThanOrEqual(4);
    expect(parsed.tables[0].rows.flat()).toContain('row 1 col 1');
    expect(json.outputs[0].name).toBe('prices-tables.json');

    const csv = await run('extract-tables', { pages: 'all', format: 'csv' }, [
      fileOf(await tablePdf(5), 'prices.pdf'),
    ]);
    expect(await textOf(csv)).toContain('row 1 col 1');

    const markdown = await run('extract-tables', { pages: 'all', format: 'md' }, [
      fileOf(await tablePdf(5), 'prices.pdf'),
    ]);
    const md = await textOf(markdown);
    expect(md).toContain('## Table 1');
    expect(md).toContain('| --- ');
    expect(md.split('\n')[0]).toMatch(/^# /);
  });

  it('reports no tables rather than an empty archive of nothing (E13)', async () => {
    const outcome = await run('extract-tables', { pages: 'all' }, [
      fileOf(await blankPdf(), 'blank.pdf'),
    ]);
    expect(outcome.outputs).toHaveLength(0);
    expect(reportText(outcome)).toMatch(/no table|blank/i);
  });
});

describe('pdf-to-excel', () => {
  it('produces a real workbook: a zip of sheet XML carrying the cell text', async () => {
    const outcome = await run('pdf-to-excel', { pages: 'all' }, [
      fileOf(await tablePdf(5), 'prices.pdf'),
    ]);
    expect(outcome.outputs[0].name).toBe('prices.xlsx');
    const entries = await readZip(await outcome.outputs[0].blob.arrayBuffer());
    const names = entries.map((entry) => entry.name);
    expect(names).toContain('[Content_Types].xml');
    expect(names.some((name) => /^xl\/worksheets\/sheet1\.xml$/.test(name))).toBe(true);
    const cells = entries
      .filter((entry) => entry.name.startsWith('xl/'))
      .map((entry) => new TextDecoder().decode(entry.bytes))
      .join('\n');
    expect(cells).toContain('row 1 col 1');
    expect(cells).toContain('Quantity');
  });

  it('collapses every table onto one sheet when asked', async () => {
    const outcome = await run('pdf-to-excel', { pages: 'all', oneSheet: true }, [
      fileOf(await tablePdf(5), 'prices.pdf'),
    ]);
    expect(outcome.message).toMatch(/1 worksheet/);
    const entries = await readZip(await outcome.outputs[0].blob.arrayBuffer());
    expect(entries.map((entry) => entry.name)).toContain('xl/worksheets/sheet1.xml');
  });

  it('refuses to build a workbook out of nothing (E13)', async () => {
    const outcome = await run('pdf-to-excel', { pages: 'all' }, [
      fileOf(await textPdfCached(), 'prose.pdf'),
    ]);
    expect(outcome.outputs).toHaveLength(0);
    expect(reportText(outcome)).toMatch(/no table/i);
  });
});

/* ── pdf-to-word ──────────────────────────────────────────────────────────── */

/** Concatenated text inside a WordprocessingML part, tags removed. */
async function documentXml(outcome: RunOutcome): Promise<string> {
  const entries = await readZip(await outcome.outputs[0].blob.arrayBuffer());
  const part = entries.find((entry) => entry.name === 'word/document.xml');
  expect(part, `word/document.xml missing from ${entries.map((e) => e.name).join(', ')}`).toBeTruthy();
  return new TextDecoder().decode(part!.bytes).replace(/<[^>]+>/g, '');
}

describe('pdf-to-word', () => {
  it('writes selectable text runs, not a picture of the page (E10, E13)', async () => {
    const outcome = await run('pdf-to-word', { pages: 'all' }, [fileOf(await textPdfCached(), 'report.pdf')]);
    const xml = await documentXml(outcome);
    expect(xml).toContain('Heading for page 1');
    expect(xml).toContain('Body text number 4');
    const entries = await readZip(await outcome.outputs[0].blob.arrayBuffer());
    expect(entries.some((entry) => entry.name.startsWith('word/media/'))).toBe(false);
    expect(outcome.outputs[0].name).toBe('report.docx');
  });

  it('maps large type to heading styles and rebuilds the grid as a Word table', async () => {
    const outcome = await run('pdf-to-word', { pages: 'all' }, [
      fileOf(await headingGridPdf(), 'prices.pdf'),
    ]);
    const entries = await readZip(await outcome.outputs[0].blob.arrayBuffer());
    const raw = new TextDecoder().decode(entries.find((entry) => entry.name === 'word/document.xml')!.bytes);
    expect(raw).toContain('Heading1');
    expect(raw).toContain('<w:tbl>');
    expect(await documentXml(outcome)).toContain('row 1 col 1');
  });

  it('reports a scan instead of an empty document (E10, E13)', async () => {
    const outcome = await run('pdf-to-word', { pages: 'all' }, [fileOf(await scanPdf(1), 'scan.pdf')]);
    expect(outcome.outputs).toHaveLength(0);
    expect(reportText(outcome)).toMatch(/text layer|OCR/i);
  });
});

/* ── pdf-to-svg ───────────────────────────────────────────────────────────── */

describe('pdf-to-svg', () => {
  it('vectorises text as <text>, not as an image wrapper (E10)', async () => {
    const outcome = await run('pdf-to-svg', { pages: '1' }, [fileOf(await textPdfCached(), 'report.pdf')]);
    const svg = await textOf(outcome);
    expect(svg).toContain('<svg');
    expect(svg).toContain('Heading for page 1');
    expect(svg).not.toContain('<image');
  });

  it('writes one page per file with padded numbers, and zips on request (E17)', async () => {
    const many = await run('pdf-to-svg', { pages: 'all', asOne: false }, [
      fileOf(await textPdf(12), 'twelve.pdf'),
    ]);
    expect(many.outputs).toHaveLength(12);
    const names = many.outputs.map((output) => output.name);
    expect(names).toContain('twelve-page-010.svg');
    expect([...names].sort()).toEqual(names);
    const zipped = await run('pdf-to-svg', { pages: 'all', asOne: true }, [
      fileOf(await textPdf(12), 'twelve.pdf'),
    ]);
    expect(zipped.outputs[0].name).toBe('twelve-svg.zip');
    expect((await zipEntries(zipped)).map((entry) => entry.name)).toContain('twelve-page-010.svg');
  }, 120_000);
});

/* ── extract-images ───────────────────────────────────────────────────────── */

describe('extract-images', () => {
  it('zero-pads page and index numbers so 20+ files sort correctly (E17)', async () => {
    const outcome = await run('extract-images', { pages: 'all', smallest: 0 }, [
      fileOf(await manyImagesPdf(), 'shots.pdf'),
    ]);
    const entries = await zipEntries(outcome);
    expect(entries).toHaveLength(23);
    const names = entries.map((entry) => entry.name);
    expect(names).toContain('shots-p001-010.png');
    expect(names).toContain('shots-p012-001.png');
    expect([...names].sort()).toEqual(names);
    // Every page number carries the same width, so a file manager sorts p2 last.
    expect(names.every((name) => /-p\d{3}-\d{3}\.png$/.test(name))).toBe(true);
  });

  it('round-trips pixels: the extracted PNG decodes to what was drawn (E12)', async () => {
    const single = await run('extract-images', { pages: '1', smallest: 0 }, [
      fileOf(await jpegImagePdf(), 'photo.pdf'),
    ]);
    expect(single.outputs).toHaveLength(1);
    expect(single.outputs[0].name).toBe('photo-p001-001.jpg');
    // A JPEG stream is handed back untouched, at its original resolution.
    const kept = new Uint8Array(await single.outputs[0].blob.arrayBuffer());
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.subarray(0, 2)).toEqual(TINY_JPEG.subarray(0, 2));
    expect(kept).toEqual(TINY_JPEG);

    const painted = await run('extract-images', { pages: 'all', smallest: 0 }, [
      fileOf(await scanPdf(1), 'stamp.pdf'),
    ]);
    const image = decodePng(new Uint8Array(await painted.outputs[0].blob.arrayBuffer()));
    expect([image.width, image.height]).toEqual([40, 24]);
    expect(pixelAt(image, 5, 5)).toEqual([200, 30, 40, 255]);
  });

  it('reports a document with no images instead of an empty zip (E13)', async () => {
    const outcome = await run('extract-images', { pages: 'all' }, [
      fileOf(await textPdfCached(), 'prose.pdf'),
    ]);
    expect(outcome.outputs).toHaveLength(0);
    expect(outcome.report).toBeTruthy();
    expect(reportText(outcome)).toMatch(/no embedded images/i);
  });

  it('honours the size floor and says when that emptied the result (E13, E15)', async () => {
    const filtered = await run('extract-images', { pages: 'all', smallest: 200 }, [
      fileOf(await manyImagesPdf(), 'shots.pdf'),
    ]);
    expect(filtered.outputs).toHaveLength(0);
    expect(reportText(filtered)).toMatch(/no embedded images|size limit/i);
  });

  it('keeps a source name with spaces and unicode usable in every entry (E17)', async () => {
    const outcome = await run('extract-images', { pages: 'all', smallest: 0 }, [
      fileOf(await manyImagesPdf(), 'Q4 报告 (final).pdf'),
    ]);
    const names = (await zipEntries(outcome)).map((entry) => entry.name);
    expect(names.every((name) => name.startsWith('Q4 报告 (final)-p'))).toBe(true);
    expect(names.every((name) => !/[\\/:*?"<>|]/.test(name.replace(/\.png$/, '')))).toBe(true);
  });
});

/* ── raster export: pdf-to-image + the five format tools ──────────────────── */

const FORMAT_TOOLS: { id: string; extension: string }[] = [
  { id: 'pdf-to-png', extension: 'png' },
  { id: 'pdf-to-jpg', extension: 'jpg' },
  { id: 'pdf-to-webp', extension: 'webp' },
  { id: 'pdf-to-bmp', extension: 'bmp' },
  { id: 'pdf-to-tiff', extension: 'tif' },
];

/** Pulls the single raster payload out of a run, unzipping when needed. */
async function rasterPages(outcome: RunOutcome): Promise<{ name: string; bytes: Uint8Array }[]> {
  if (outcome.outputs.length === 1 && outcome.outputs[0].name.endsWith('.zip')) {
    const entries = await zipEntries(outcome);
    return entries.map((entry) => ({ name: entry.name, bytes: entry.bytes }));
  }
  expect(outcome.outputs.length, 'expected at least one raster output').toBeGreaterThan(0);
  return outcome.outputs.map((output) => ({ name: output.name, bytes: new Uint8Array(0) }));
}

function decodeRaster(bytes: Uint8Array, extension: string): DecodedImage {
  if (extension === 'bmp') return decodeBmp(bytes);
  // The shim encodes PNG for every browser-side format; BMP and TIFF are the
  // app's own encoders and are decoded by `decodeBmp` / `utif` above.
  return decodePng(bytes);
}

describe('raster export', () => {
  it('renders every page at its own size and rotation (E8, E9)', async () => {
    const outcome = await run('pdf-to-image', { pages: 'all', format: 'png', dpi: 72 }, [
      fileOf(await mixedPdf(), 'sizes.pdf'),
    ]);
    const files = await zipEntries(outcome);
    expect(files.map((file) => file.name)).toEqual([
      'sizes-page-001.png',
      'sizes-page-002.png',
      'sizes-page-003.png',
      'sizes-page-004.png',
    ]);
    const sizes = files.map((file) => {
      const image = decodePng(file.bytes);
      return [image.width, image.height] as [number, number];
    });
    expect(sizes).toEqual([
      [595, 841],
      [792, 612],
      [300, 400],
      [400, 300],
    ]);
    files.forEach((file, index) => expectPageSignature(decodePng(file.bytes), index + 1, file.name));
    expect(outcome.warnings.join(' ')).not.toMatch(/wrong way round/);
    expect(outcome.message).toMatch(/4 PNG images at 72 dpi/);
  });

  it('produces bytes that decode back for every format (E12, E17)', async () => {
    for (const { id, extension } of FORMAT_TOOLS) {
      const outcome = await run(id, { dpi: 72, pages: '1-2' }, [fileOf(await mixedPdf(), 'sizes.pdf')]);
      expect(outcome.outputs.length, `${id} produced no download`).toBeGreaterThan(0);
      if (extension === 'tif') {
        // Multi-page TIFF is one file, not a zip: decode it with the app's own dep.
        expect(outcome.outputs[0].name).toBe('sizes.tif');
        const pages = await decodeTiff(outcome.outputs[0].blob);
        expect(pages).toHaveLength(2);
        expect([pages[0].width, pages[0].height]).toEqual([595, 841]);
        expect([pages[1].width, pages[1].height]).toEqual([792, 612]);
        expectPageSignature(pages[0], 1, 'tiff page 1');
        expectPageSignature(pages[1], 2, 'tiff page 2');
        continue;
      }
      const files = await rasterPages(outcome);
      expect(files, id).toHaveLength(2);
      expect(files.every((file) => file.name.endsWith(`.${extension}`)), `${id} extension`).toBe(true);
      const first = decodeRaster(files[0].bytes, extension);
      expect([first.width, first.height], `${id} page 1 size`).toEqual([595, 841]);
      expectPageSignature(first, 1, `${id} page 1`);
      expectPageSignature(decodeRaster(files[1].bytes, extension), 2, `${id} page 2`);
    }
  });

  /**
   * The three format tools that are only `pdf-to-image` with the format preset
   * fixed (`pdf-to-jpg`, `pdf-to-webp`, `pdf-to-tiff`) get their own run, because
   * sharing `exportPages` with PNG is exactly the kind of claim that needs
   * proving once per id: each one has to refuse 0 dpi (E15), respect a document
   * that mixes page sizes (E8) and `/Rotate` (E9), and hand back bytes that
   * decode to the page they came from (E12).
   */
  it('runs every preset format tool end to end (E8, E9, E12, E15)', async () => {
    const presets: { id: string; extension: string }[] = FORMAT_TOOLS.filter(
      (tool) => tool.id !== 'pdf-to-png' && tool.id !== 'pdf-to-bmp',
    );
    expect(presets.map((tool) => tool.id)).toEqual(['pdf-to-jpg', 'pdf-to-webp', 'pdf-to-tiff']);
    const expected: [number, number][] = [
      [595, 841],
      [792, 612],
      [300, 400],
      [400, 300],
    ];

    for (const { id, extension } of presets) {
      // E15, straight to `tool.run`: the rail clamps the slider, so only this
      // seam proves the tool itself refuses a resolution it cannot render.
      await expect(
        runRaw(id, { dpi: 0, pages: '1' }, [fileOf(await mixedPdf(), 'sizes.pdf')]),
      ).rejects.toThrow(/cannot be rendered/);

      const outcome = await run(id, { dpi: 72, pages: 'all' }, [fileOf(await mixedPdf(), 'sizes.pdf')]);
      expect(outcome.outputs.length, `${id} produced no download`).toBeGreaterThan(0);
      // E8/E9 are said out loud rather than smoothed over.
      expect(outcome.message, id).toMatch(/4 different page sizes/);
      expect(outcome.warnings.join(' '), id).not.toMatch(/wrong way round/);

      if (extension === 'tif') {
        // Multi-page TIFF is one file, not a zip, and `utif` is the app's own
        // dependency — so this is the byte-level round trip for that encoder.
        expect(outcome.outputs[0].name).toBe('sizes.tif');
        const pages = await decodeTiff(outcome.outputs[0].blob);
        expect(pages.map((page) => [page.width, page.height] as [number, number])).toEqual(expected);
        pages.forEach((page, index) => expectPageSignature(page, index + 1, `${id} page ${index + 1}`));
        continue;
      }

      const files = await rasterPages(outcome);
      expect(files.map((file) => file.name), id).toEqual([
        `sizes-page-001.${extension}`,
        `sizes-page-002.${extension}`,
        `sizes-page-003.${extension}`,
        `sizes-page-004.${extension}`,
      ]);
      const sizes = files.map((file) => {
        const image = decodePng(file.bytes);
        return [image.width, image.height] as [number, number];
      });
      expect(sizes, id).toEqual(expected);
      files.forEach((file, index) => expectPageSignature(decodePng(file.bytes), index + 1, file.name));
    }
  });

  it('keeps BMP honest: the app writes the 24-bit header and pixels itself (E12)', async () => {
    const outcome = await run('pdf-to-bmp', { dpi: 72, pages: '1' }, [fileOf(await mixedPdf(), 'sizes.pdf')]);
    expect(outcome.outputs).toHaveLength(1);
    expect(outcome.outputs[0].name).toBe('sizes-page-001.bmp');
    const bytes = new Uint8Array(await outcome.outputs[0].blob.arrayBuffer());
    const image = decodeBmp(bytes);
    expect([image.width, image.height]).toEqual([595, 841]);
    expectPageSignature(image, 1, 'bmp');
    expect(bytes.length).toBeGreaterThanOrEqual(54 + 595 * 841 * 3);
  });

  it('hands a single page back without a zip and honours zip=false (E13, E18)', async () => {
    const single = await run('pdf-to-image', { pages: '3', format: 'png', dpi: 72 }, [
      fileOf(await mixedPdf(), 'sizes.pdf'),
    ]);
    expect(single.outputs).toHaveLength(1);
    expect(single.outputs[0].name).toBe('sizes-page-003.png');
    const loose = await run('pdf-to-image', { pages: 'all', format: 'png', dpi: 72, zip: false }, [
      fileOf(await mixedPdf(), 'sizes.pdf'),
    ]);
    expect(loose.outputs).toHaveLength(4);
    expect(loose.outputs.map((output) => output.name)[3]).toBe('sizes-page-004.png');
  });

  it('exports all 500 pages without dropping any (E7)', async () => {
    RASTER.pages.length = 0;
    const outcome = await run('pdf-to-image', { pages: 'all', format: 'png', dpi: 72 }, [
      fileOf(await bigTextPdf(500), 'long.pdf'),
    ]);
    const files = await zipEntries(outcome);
    expect(files).toHaveLength(500);
    expect(RASTER.pages).toHaveLength(500);
    expect(new Set(files.map((file) => file.name)).size).toBe(500);
    expect(files[0].name).toBe('long-page-001.png');
    expect(files[499].name).toBe('long-page-500.png');
    const last = decodePng(files[499].bytes);
    expect([last.width, last.height]).toEqual([120, 90]);
    expectPageSignature(last, 500, 'page 500');
    expect(outcome.message).toMatch(/500 PNG images/);
  }, 180_000);

  it('refuses a resolution of zero with a reason (E15)', async () => {
    let caught: unknown;
    try {
      await runRaw('pdf-to-image', { dpi: 0, format: 'png', pages: '1', zip: true }, [
        fileOf(await mixedPdf(), 'sizes.pdf'),
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ToolInputError);
    const error = caught as ToolInputError;
    expect(error.code).toBe('OUT_OF_RANGE');
    expect(error.message).toMatch(/cannot be rendered|positive/i);
    expect(error.hint).toMatch(/24|3600/);
  });

  it('clamps an out-of-band resolution and says so (E15)', async () => {
    const outcome = await run('pdf-to-image', { dpi: 10, format: 'png', pages: '1' }, [
      fileOf(await mixedPdf(), 'sizes.pdf'),
    ]);
    expect(outcome.warnings.join(' ')).toMatch(/Resolution must be|72 became 10|10 became 72/i);
    const image = decodePng(new Uint8Array(await outcome.outputs[0].blob.arrayBuffer()));
    expect([image.width, image.height]).toEqual([595, 841]);
  });

  it('stops at a cancellation and downloads nothing stale (E19)', async () => {
    const controller = new AbortController();
    const files = [fileOf(await textPdf(6), 'six.pdf')];
    RASTER.pages.length = 0;
    let seen = 0;
    COVERED.add('pdf-to-image');
    const tool = getPdfTool('pdf-to-image')!;
    const inputs: ToolFile[] = files.map((file) => ({
      name: file.name,
      size: file.size,
      type: file.type,
      bytes: async () => new Uint8Array(await file.arrayBuffer()),
      blob: () => file.slice(0, file.size, file.type),
    }));
    await expect(
      tool.run!({
        inputs,
        values: { dpi: 72, format: 'png', pages: 'all', zip: true, quality: 0.92 },
        progress: () => {
          seen += 1;
          if (seen === 2) controller.abort();
        },
        log: () => undefined,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancel/i);
    expect(RASTER.pages.length).toBeLessThanOrEqual(2);
  });

  it('reports the page selection that matches nothing instead of an empty zip (E13)', async () => {
    const outcome = await run('pdf-to-image', { pages: 'odd', format: 'png', dpi: 72 }, [
      fileOf(await blankPdf(), 'two.pdf'),
    ]);
    expect(outcome.outputs).toHaveLength(1);
    expect(outcome.outputs[0].name).toBe('two-page-001.png');
  });
});

/* ── pdf-to-greyscale ─────────────────────────────────────────────────────── */

describe('pdf-to-greyscale', () => {
  it('recolours the content streams and keeps the text selectable', async () => {
    const outcome = await run('pdf-to-greyscale', { mode: 'vectors', pages: 'all' }, [
      fileOf(await colouredPdf(), 'colour.pdf'),
    ]);
    const doc = await PDFDocument.load(new Uint8Array(await outcome.outputs[0].blob.arrayBuffer()));
    expect(doc.getPageCount()).toBe(1);
    expect(outcome.message).toMatch(/colour operation|Text stays selectable/i);
    expect(outcome.outputs[0].name).toBe('colour_greyscale.pdf');
  });

  it('admits when the document had no colour to convert (E13)', async () => {
    const outcome = await run('pdf-to-greyscale', { mode: 'vectors', pages: 'all' }, [
      fileOf(await blankPdf(), 'blank.pdf'),
    ]);
    expect(outcome.message).toMatch(/already had no colour/i);
  });

  it('re-renders to images when that method is chosen, and says so (E9)', async () => {
    // The raster counter is shared by the whole file, so it has to be zeroed
    // before a test asserts on it — the 500-page export ran first.
    RASTER.pages.length = 0;
    const outcome = await run(
      'pdf-to-greyscale',
      { mode: 'raster', dpi: 96, pages: 'all' },
      [fileOf(await mixedPdf(), 'sizes.pdf')],
    );
    const doc = await PDFDocument.load(new Uint8Array(await outcome.outputs[0].blob.arrayBuffer()));
    expect(doc.getPageCount()).toBe(4);
    expect(outcome.message).toMatch(/Re-rendered|Text is now part of the image/i);
    expect(RASTER.pages).toEqual([1, 2, 3, 4]);
  });
});

/* ── page-dimensions ──────────────────────────────────────────────────────── */

describe('page-dimensions', () => {
  it('names the size, orientation and rotation of every page (E6, E8, E9)', async () => {
    const outcome = await run('page-dimensions', {}, [fileOf(await mixedPdf(), 'sizes.pdf')]);
    const rows = outcome.report!.sections.flatMap((section) => section.rows ?? []);
    const page3 = rows.find((row) => row.label === 'Page 3')!.value;
    expect(page3).toContain('300.0 × 400.0 pt');
    expect(page3).toContain('portrait');
    expect(page3).toContain('rotated 90');
    expect(outcome.message).toMatch(/4 page\(s\), \d distinct size/);
    const summary = outcome.report!.sections[0].rows!.map((row) => `${row.label}=${row.value}`).join(', ');
    expect(summary).toMatch(/A4|Letter|Custom/);
  });

  it('reports every page of a 500-page document (E7)', async () => {
    const outcome = await run('page-dimensions', {}, [fileOf(await bigTextPdf(500), 'long.pdf')]);
    const listed = outcome.report!.sections.flatMap((section) => section.rows ?? []);
    expect(listed.filter((row) => /^Page \d+$/.test(row.label))).toHaveLength(500);
    expect(outcome.message).toMatch(/500 page\(s\)/);
  }, 60_000);
});

/* ── coverage gate (must stay last: it reads what the run helpers recorded) ── */

describe('suite coverage', () => {
  it('actually ran every convert-from tool', () => {
    const untested = CONVERT_FROM_IDS.filter((id) => !COVERED.has(id));
    expect(untested, `these tools were never exercised: ${untested.join(', ')}`).toEqual([]);
    // `page-dimensions` ships in this module but is categorised `organize`, so it
    // is exercised here without being one of the seventeen. Comparing the raw set
    // size counted it as a missing tool.
    expect(CONVERT_FROM_IDS.filter((id) => COVERED.has(id))).toEqual(CONVERT_FROM_IDS);
    expect([...COVERED].every((id) => getPdfTool(id) !== undefined), 'every covered id is registered').toBe(true);
  });
});
