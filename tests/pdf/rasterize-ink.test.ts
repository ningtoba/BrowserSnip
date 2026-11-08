/**
 * `rasterize-pdf` — the picture it hands back carries the sheet's ink.
 *
 * The tool embeds `render.canvas` from inside its rasterise loop
 * (`src/lib/pdf/tools/optimize.ts`), and `renderPage` settles when the paint is
 * *scheduled*: the pixels arrive on `render.finished`. Measured on the deployed
 * site (`docs/research/rasterize-fixture.mjs` → `rail-tool-bytes.mjs` →
 * `rail-measure.py`), a text page at **13.88 %** ink came back as one image
 * XObject at **0.00 % non-white** under a line that read *"Rasterised 1 page(s)
 * to JPEG at 200 dpi. 7.0 KB → 24.1 KB (+242 %)"* — a sentence true about
 * everything except the pixels.
 *
 * Both standing rules of `docs/TOOL-CAMPAIGN.md` bind this file:
 *
 * 1. **A double has to model the ordering.** The render double below applies only
 *    the synchronous background fill when `renderPage` settles and lands the ink
 *    in a *later task*, so an unawaited paint encodes paper. A
 *    `finished: Promise.resolve()` hands the ink over in a microtask the awaiting
 *    caller cannot lose to — generous, and blind.
 * 2. **The assertion reads the produced file, against a known-good measurement
 *    rather than a guessed threshold.** Each page's embedded image is decoded
 *    back to RGB — its `/SMask` composited over paper, the way a viewer shows it,
 *    which is the reading `rail-measure.py` takes — and compared with the count
 *    taken off the same bitmap at the moment `finished` resolved. The four sheets
 *    (body text, a photograph, one thin vector stroke, an empty page) carry
 *    different amounts of ink by construction, and the empty one pins the
 *    instrument at 0 so the other three cannot pass by counting something that is
 *    always there.
 *
 * jsdom has no 2-D raster, so this file installs a small pixel-true canvas
 * (`installCanvas`) and leaves the shipped `canvasToBlob` → `embedJpg`/`embedPng`
 * path real: what is measured is the bytes the tool wrote.
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
import type { PageRender, PdfSession } from '@/lib/pdf/core/render';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { defaultValues, type ToolFile, type ToolValues } from '@/lib/pdf/tools/types';

/* ── the fixture: four sheets, four amounts of ink ────────────────────────── */

type PaintKind = 'text' | 'photo' | 'stroke' | 'empty';

/** The campaign's fixture cases, in page order. */
const SHEETS: PaintKind[] = ['text', 'photo', 'stroke', 'empty'];

/** Small on purpose: every pixel of every sheet is walked, twice per format. */
const SHEET: [number, number] = [200, 260];

const double = vi.hoisted(() => ({
  /** What each page is painted with; index = page − 1, set with the fixture. */
  paints: [] as PaintKind[],
  /** The bitmap as it stood when `finished` resolved — the known-good reading. */
  painted: [] as Array<{ data: Uint8ClampedArray; width: number; height: number } | null>,
  /** Reads of a *page* canvas taken before its paint had landed. */
  readsBeforePaint: 0,
}));

/* ── a pixel-true canvas for jsdom ────────────────────────────────────────── */

interface Surface {
  width: number;
  height: number;
  /** RGBA, row-major, top row first — the order `getImageData` reports. */
  data: Uint8ClampedArray;
}

const surfaces = new WeakMap<HTMLCanvasElement, Surface>();
/** Canvases handed out by the render double, and which of them have been painted. */
const pageCanvases = new WeakSet<HTMLCanvasElement>();
const landed = new WeakSet<HTMLCanvasElement>();

function surfaceOf(canvas: HTMLCanvasElement): Surface {
  const width = Math.max(0, Math.trunc(canvas.width) || 0);
  const height = Math.max(0, Math.trunc(canvas.height) || 0);
  const existing = surfaces.get(canvas);
  // Assigning a canvas's width or height resets it to transparent black, which is
  // exactly the state an unawaited `renderPage` leaves behind on the PNG branch.
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
        out[to] = src.data[from];
        out[to + 1] = src.data[from + 1];
        out[to + 2] = src.data[from + 2];
        out[to + 3] = src.data[from + 3];
      }
    }
    return new ImageData(out, width, height);
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    const dst = surfaceOf(this.canvas);
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
        for (let c = 0; c < 4; c++) dst.data[to + c] = src.data[from + c];
      }
    }
  }

  save(): void {}
  restore(): void {}
}

/**
 * A JPEG container whose comment segments carry deflated 24-bit RGB.
 *
 * Lossless on purpose: the question this file asks is *which pixels were in the
 * canvas when it was encoded*, and a real JPEG encoder could only move that
 * answer towards "less ink", never invent some.
 */
function encodeStubJpeg(surface: Surface): Uint8Array {
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
  return Uint8Array.from(parts);
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

/** A real RGBA PNG, so pdf-lib's own decoder is what produces the stored samples. */
function encodeStubPng(surface: Surface): Uint8Array {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
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
    const mime = type ?? 'image/png';
    const bytes = mime === 'image/jpeg' ? encodeStubJpeg(surface) : encodeStubPng(surface);
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

/* ── the render double: the paint lands in a later task ────────────────────── */

vi.mock('@/lib/pdf/core/render', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/pdf/core/render')>();
  return {
    ...real,
    openRender: async (bytes: Uint8Array): Promise<PdfSession> => {
      const source = await PDFDocument.load(bytes, { updateMetadata: false });
      const pages = source.getPages();
      return {
        numPages: pages.length,
        async renderPage(
          n: number,
          scale: number,
          options: { background?: string; filter?: string } = {},
        ): Promise<PageRender> {
          const size = pages[n - 1].getSize();
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.floor(size.width * scale));
          canvas.height = Math.max(1, Math.floor(size.height * scale));
          pageCanvases.add(canvas);
          const ctx = canvas.getContext('2d') as unknown as StubContext;
          // The one thing the real `renderPage` does before it returns: the
          // synchronous background fill. Nothing else is on the canvas yet.
          if (options.background) {
            ctx.fillStyle = options.background;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
          }
          let settle: () => void = () => {};
          let abort: (reason: Error) => void = () => {};
          let settled = false;
          const finished = new Promise<void>((resolve, reject) => {
            settle = resolve;
            abort = reject;
          });
          // The ink lands in a **later task**, the way pdf.js does it: a caller
          // that reads the canvas without waiting gets the background only.
          const timer = setTimeout(() => {
            settled = true;
            paintPage(canvas, double.paints[n - 1] ?? 'empty');
            landed.add(canvas);
            const surface = surfaceOf(canvas);
            double.painted[n - 1] = {
              data: surface.data.slice(),
              width: surface.width,
              height: surface.height,
            };
            settle();
          }, 0);
          finished.catch(() => undefined);
          return {
            canvas,
            ctx: ctx as unknown as CanvasRenderingContext2D,
            width: canvas.width,
            height: canvas.height,
            unitsPerPixel: 1 / scale,
            pageNumber: n,
            finished,
            cancel: () => {
              if (settled) return;
              clearTimeout(timer);
              abort(new real.RenderCancelled('test render cancelled'));
            },
          };
        },
        async destroy() {
          /* this double holds nothing that outlives the run */
        },
      } as unknown as PdfSession;
    },
  };
});

/** Fill the sheet with paper, then the ink its fixture content rasterises to. */
function paintPage(canvas: HTMLCanvasElement, kind: PaintKind): void {
  const surface = surfaceOf(canvas);
  surface.data.fill(255); // the opaque white page background pdf.js paints
  const put = (x: number, y: number, value: number) => {
    if (x < 0 || y < 0 || x >= surface.width || y >= surface.height) return;
    const at = (y * surface.width + x) * 4;
    surface.data[at] = value;
    surface.data[at + 1] = value;
    surface.data[at + 2] = value;
    surface.data[at + 3] = 255;
  };
  if (kind === 'text') {
    // Body copy: 3 px glyphs on a 16 px pitch, as the fixture's 11 pt lines land
    // at 72 dpi — about 12 % of the sheet, the same order as the deployed 13.88 %.
    for (let y = 24; y < surface.height - 24; y += 16) {
      for (let x = 20; x < surface.width - 20; x++) {
        for (let row = 0; row < 3; row++) put(x, y + row, 0);
      }
    }
  } else if (kind === 'photo') {
    // Full-bleed halftone: every pixel a tone, the way a photograph rasterises.
    for (let y = 0; y < surface.height; y++) {
      for (let x = 0; x < surface.width; x++) put(x, y, (x * 7 + y * 13) % 256);
    }
  } else if (kind === 'stroke') {
    // One hairline across the sheet: the campaign's "the only ink is a vector
    // stroke" page, which a coarse threshold would call blank.
    for (let x = 10; x < surface.width - 10; x++) put(x, Math.floor(surface.height / 2), 0);
  }
}

/* ── fixtures ─────────────────────────────────────────────────────────────── */

/**
 * A real PDF whose four pages carry the four fixture cases: live text, an
 * embedded photograph, one 0.5 pt vector line, and nothing. The render double is
 * handed the same `SHEETS` list, so the bytes and the paint describe one file.
 */
async function inkFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const kind of SHEETS) {
    const page = doc.addPage(SHEET);
    if (kind === 'text') {
      for (let line = 0; line < 12; line++) {
        page.drawText(`body copy line ${line + 1}`, {
          x: 20,
          y: SHEET[1] - 30 - line * 16,
          size: 11,
          font,
          color: rgb(0, 0, 0),
        });
      }
    } else if (kind === 'photo') {
      const px = 40;
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
        doc.context.register(doc.context.stream(`q ${SHEET[0]} 0 0 ${SHEET[1]} 0 0 cm /Im9 Do Q`)),
      );
    } else if (kind === 'stroke') {
      page.drawLine({
        start: { x: 10, y: SHEET[1] / 2 },
        end: { x: SHEET[0] - 10, y: SHEET[1] / 2 },
        thickness: 0.5,
        color: rgb(0, 0, 0),
      });
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
    blob: () => new Blob([bytes], { type: 'application/pdf' }),
  };
}

async function runRasterize(values: ToolValues, bytes: Uint8Array) {
  const tool = getPdfTool('rasterize-pdf');
  expect(tool, 'rasterize-pdf is not registered').toBeTruthy();
  const result = (await tool!.run!({
    inputs: [fileOf(bytes, 'ink.pdf')],
    values: { ...defaultValues(tool!.fields), ...values },
    progress: () => {},
    log: () => {},
    signal: new AbortController().signal,
  }))!;
  expect(result.kind, `the tool returned ${result.kind}, not a PDF`).toBe('pdf');
  const pdf = (result as { bytes: Uint8Array }).bytes;
  return { result: result as Extract<typeof result, { kind: 'pdf' }>, doc: await openPDF(pdf) };
}

/* ── measuring the produced file ──────────────────────────────────────────── */

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

/** The single image a rasterised page draws. */
function embeddedImage(doc: PDFDocument, page: PDFPage): PDFRawStream {
  const resources = dictOf(doc, page.node.Resources());
  const xobjects = dictOf(doc, resources?.get(PDFName.of('XObject')));
  expect(xobjects, 'the rasterised page drew no image').not.toBeNull();
  const images = [...xobjects!.entries()]
    .map(([, value]) => streamOf(doc, value))
    .filter((stream): stream is PDFRawStream => stream !== null);
  // The tool's promise is one picture per page; a second would make the figure
  // below a sum rather than a measurement.
  expect(images, 'exactly one image XObject per rasterised page').toHaveLength(1);
  return images[0];
}

/**
 * The embedded image as it *shows*: RGB with its `/SMask` composited over paper.
 *
 * A PDF draws nothing where alpha is 0 — the page background shows through — so
 * counting the stored samples without the mask would call an all-transparent
 * image "black", where the deployed bug measures white.
 */
function embeddedRaster(doc: PDFDocument, page: PDFPage): { width: number; height: number; rgb: Uint8Array } {
  const stream = embeddedImage(doc, page);
  const width = numberAt(stream.dict, 'Width');
  const height = numberAt(stream.dict, 'Height');
  const colorSpace = `${stream.dict.get(PDFName.of('ColorSpace'))}`;
  const stored = samplesOf(stream);
  const rgbBytes
    = `${stream.dict.get(PDFName.of('Filter'))}` === '/DCTDecode'
      ? decodeStubJpeg(stored)
      : stored;
  expect(colorSpace, `the page image is stored in ${colorSpace}`).toBe('/DeviceRGB');
  expect(rgbBytes.length, 'the stored samples are not Width×Height×3').toBe(width * height * 3);
  const mask = streamOf(doc, stream.dict.get(PDFName.of('SMask')));
  if (mask) {
    const alpha = samplesOf(mask);
    expect(alpha.length, '/SMask is not one byte per pixel').toBe(width * height);
    for (let i = 0; i < width * height; i++) {
      const a = alpha[i] / 255;
      for (let c = 0; c < 3; c++) {
        const at = i * 3 + c;
        rgbBytes[at] = Math.round(255 * (1 - a) + rgbBytes[at] * a);
      }
    }
  }
  return { width, height, rgb: rgbBytes };
}

/** Non-white pixels, counted the way `rail-measure.py` counts them. */
function nonWhite(raster: { width: number; height: number; rgb: Uint8Array }): number {
  let dark = 0;
  for (let i = 0; i < raster.width * raster.height; i++) {
    if (raster.rgb[i * 3] < 245 || raster.rgb[i * 3 + 1] < 245 || raster.rgb[i * 3 + 2] < 245) dark += 1;
  }
  return dark;
}

/** The same count off an RGBA bitmap — the known-good side of the comparison. */
function paintedRaster(bitmap: { data: Uint8ClampedArray; width: number; height: number }) {
  const out = new Uint8Array(bitmap.width * bitmap.height * 3);
  for (let i = 0; i < bitmap.width * bitmap.height; i++) {
    // Paper is what a viewer shows where the bitmap is transparent.
    for (let c = 0; c < 3; c++) {
      const a = bitmap.data[i * 4 + 3] / 255;
      out[i * 3 + c] = Math.round(255 * (1 - a) + bitmap.data[i * 4 + c] * a);
    }
  }
  return { width: bitmap.width, height: bitmap.height, rgb: out };
}

/* ── tests ────────────────────────────────────────────────────────────────── */

beforeAll(() => {
  installCanvas();
});

beforeEach(() => {
  double.paints = [...SHEETS];
  double.painted = [];
  double.readsBeforePaint = 0;
});

describe('the render double keeps the paint race honest', () => {
  it('hands out paper until finished resolves and ink afterwards', async () => {
    const { openRender } = await import('@/lib/pdf/core/render');
    const session = await openRender(await inkFixture());
    const render = await session.renderPage(1, 1);
    const early = render.ctx.getImageData(0, 0, render.width, render.height);
    expect(double.readsBeforePaint, 'a read of an unpainted page went uncounted').toBe(1);
    await render.finished;
    const late = render.ctx.getImageData(0, 0, render.width, render.height);
    expect(double.readsBeforePaint, 'the awaited paint still cost a read').toBe(1);
    expect(nonWhite(paintedRaster(early))).toBe(0);
    expect(nonWhite(paintedRaster(late))).toBeGreaterThan(0);
    await session.destroy();
  });
});

// Both branches have to be measured: `jpeg` is the deployed default and gets a
// synchronous white background fill, while `png` leaves the canvas transparent
// until pdf.js paints, so the two fail in different ways without the await.
describe.each(['jpeg', 'png'] as const)('rasterize-pdf to %s', (format) => {
  it.each(SHEETS.map((kind, index) => [kind, index + 1] as const))(
    'page %i (%s) comes back with the ink it was painted with',
    async (kind, page) => {
      const { doc } = await runRasterize({ format, dpi: 72 }, await inkFixture());
      expect(doc.getPageCount()).toBe(SHEETS.length);
      const knownGood = double.painted[page - 1];
      expect(knownGood, 'the double recorded no paint for this page').not.toBeNull();
      const painted = nonWhite(paintedRaster(knownGood!));
      const inFile = nonWhite(embeddedRaster(doc, doc.getPage(page - 1)));
      if (kind === 'empty') {
        // The control: the instrument reads 0 where nothing is drawn, so the
        // three figures above it are measurements and not a constant.
        expect(painted, 'the empty sheet painted something').toBe(0);
        expect(inFile, 'the empty sheet is not paper in the file').toBe(0);
      } else {
        expect(painted, `the ${kind} sheet painted nothing`).toBeGreaterThan(0);
      }
      expect(
        inFile,
        `page ${page} (${kind}): ${inFile} non-white px in the file against ${painted} painted — `
        + 'the canvas was encoded before pdf.js had painted it',
      ).toBe(painted);
    },
  );

  it('never encodes a page canvas that has not been painted', async () => {
    await runRasterize({ format, dpi: 72 }, await inkFixture());
    // The structural twin of the ink check: every read of a page canvas happened
    // after the paint landed. Without `await render.finished` this is the count
    // of `hasAlpha`/`toBlob` reads of four canvases that held only their
    // background — the exact shape of the deployed defect.
    expect(double.readsBeforePaint).toBe(0);
  });

  it('describes the file it produced', async () => {
    const { result, doc } = await runRasterize({ format, dpi: 72 }, await inkFixture());
    expect(result.message).toMatch(
      new RegExp(`Rasterised ${SHEETS.length} page\\(s\\) to ${format.toUpperCase()} at 72 dpi`),
    );
    expect(result.pages).toBe(doc.getPageCount());
    const inked = doc.getPages().filter((page) => nonWhite(embeddedRaster(doc, page)) > 0).length;
    expect(inked, 'three of the four sheets carry ink').toBe(3);
    expect(result.warnings?.join(' ')).toMatch(/1 of 4 page\(s\) carried text/);
    expect((await import('@/lib/pdf/core/content')).pageContentOps(doc.getPage(0)))
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Do' })]));
  });
});
