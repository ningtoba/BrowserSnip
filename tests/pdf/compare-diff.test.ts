/**
 * `compare-pdfs`, measured over a planted difference — both answers it gives.
 *
 * The tool has three render paths, and the campaign row for
 * `pdf-engine/commands.ts:442` had to say which one produces what:
 *
 * 1. **the pane's verdict** — `CompareMain.renderPagePair`, which awaits
 *    `page.render().promise` correctly, and so was never suspected. Measured on the
 *    deployed site it still reported *nothing*: its canvases are unmounted while the
 *    pane's own loading state is up, so the first comparison threw on a null canvas
 *    inside a `catch {}`, and 0 was published as "Nothing differs on the page in
 *    view". A page turn re-ran it against mounted canvases, and the same pair
 *    measured `13,600 of 249,900 pixels`.
 * 2. **the panel that prints that sentence** — `CompareTool`, which subscribed with
 *    `setSt(getCompareState())`. `_state` is one mutable object, so React compared a
 *    value with itself and the card never re-rendered: it read `0 %` beside a pane
 *    holding 13,600 changed pixels.
 * 3. **the exported file** — `CompareTool`'s button runs the `compare` definition in
 *    `tools/legacy.ts`, whose `comparePDFs` read both page canvases the moment
 *    `renderPage` settled. That is the campaign's unawaited paint, eighth copy: the
 *    audit measured **0.13 % ink on every output page, including the one the source
 *    leaves empty**, two image XObjects per page, nothing marked anywhere.
 *
 * So the fix is not "await the legacy one": the verdict and the export were wrong in
 * different ways, and both had to be measured. Everything below therefore asserts
 * *where*, not merely *whether*:
 *
 * · **positive** — a rectangle planted at a known 20–100 × 40–80 pt must come back
 *   at 20–100 × 40–80 pt, in the pane's points and in the exported file's own pixels;
 * · **negative** — A versus A must report no difference *after a comparison that
 *   ran*, with the page image still carrying the source's ink, so a zero cannot be
 *   the silence of a canvas nobody painted;
 * · **blank** — two empty sheets are not a difference, and stay empty (0 ink) in the
 *   export, so nothing is invented out of paper;
 * · **the controls** — `sensitivity` and the highlight colour are read back out of
 *   the produced bytes, because a control that changes the form and not the pixels is
 *   this campaign's favourite defect (standing rule 5).
 *
 * jsdom has no raster, so this file installs a pixel-true canvas and a pdf.js double
 * that models the *ordering* (standing rule 1: paper when `renderPage` settles, ink
 * in a later task) and counts every read of a page canvas taken before the paint
 * landed. The exported page is measured out of its own image XObjects, `/SMask`
 * composited the way a viewer shows it.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { createElement, StrictMode } from 'react';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  PDFArray,
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
import { defaultValues, type ToolFile, type ToolValues } from '@/lib/pdf/tools/types';
import { useFileStore } from '@/stores/file-store';

/* ── the pair: three sheets, one planted difference ────────────────────────── */

const SHEET: [number, number] = [120, 160];

/**
 * The planted difference, in points from the **top-left of the displayed sheet**
 * (x right, y down) — the space the pane quotes areas in and the space
 * `docs/research/compare-measure.py` reads the exported marks back in.
 *
 * Whole points and even edges, so at the export's 2 device px per point the expected
 * box is exact: an equality here is a measurement, not a tolerance.
 */
const PLANTED = { page: 1, x0: 20, y0: 40, x1: 100, y1: 80 };
const PLANTED_INK: [number, number, number] = [0, 0, 0];
const PLANTED_AREA = (PLANTED.x1 - PLANTED.x0) * (PLANTED.y1 - PLANTED.y0);

/** Three lines of "copy" both files carry, as the ink of sheet 1. */
const COPY = [0, 1, 2].map((line) => ({
  x0: 10,
  y0: 100 + line * 8,
  x1: 110,
  y1: 104 + line * 8,
  colour: [0, 0, 0] as [number, number, number],
}));
const COPY_AREA = COPY.reduce((sum, r) => sum + (r.x1 - r.x0) * (r.y1 - r.y0), 0);

/** Sheet 2 differs from sheet 1 and from nothing else: both files carry it as is. */
const SECOND = [{ x0: 15, y0: 20, x1: 60, y1: 45, colour: [200, 30, 30] as [number, number, number] }];
const SECOND_AREA = (SECOND[0].x1 - SECOND[0].x0) * (SECOND[0].y1 - SECOND[0].y0);

interface InkRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  colour: [number, number, number];
}

interface SheetModel {
  box: [number, number];
  ink: InkRect[];
  /** The page's extractable text, as `getTextContent` would report it. */
  text?: string;
}

const SHEETS_A: SheetModel[] = [
  { box: SHEET, ink: COPY },
  { box: SHEET, ink: SECOND },
  { box: SHEET, ink: [] },
];

const SHEETS_B: SheetModel[] = [
  { box: SHEET, ink: [...COPY, plantedRect()] },
  { box: SHEET, ink: SECOND },
  { box: SHEET, ink: [] },
];

/** The planted block, in the model's own top-left space. */
function plantedRect(): InkRect {
  return { x0: PLANTED.x0, y0: PLANTED.y0, x1: PLANTED.x1, y1: PLANTED.y1, colour: PLANTED_INK };
}

/** The per-pixel distance a black block over white paper is worth: 3 × 255. */
const BLACK_ON_WHITE = 255 * 3;

const rig = vi.hoisted(() => ({
  /** Reads of a *page* canvas taken before its paint had landed. */
  earlyReads: 0,
  /** How many page renders the double was asked for, so a slider move can be shown
   *  to re-answer from pixels rather than by rendering again. */
  renders: 0,
  /** Render tasks alive right now, and the most that ever overlapped: one page
   *  canvas cannot be photographed while a second task is still painting into it,
   *  which is what a torn verdict looks like in the browser. */
  inFlight: 0,
  maxInFlight: 0,
  /** Document bytes (FNV-1a) → the sheets that document stands for. */
  models: new Map<number, { box: [number, number]; ink: InkRect[] }[]>(),
}));

function fnv1a(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * A real PDF whose pages carry exactly the model's rectangles.
 *
 * The tool opens these bytes with pdf-lib (`openInputs`) and the double renders them
 * from the same table, so the file the tool read and the pixels it was shown cannot
 * drift apart — which is the whole point of a fixture the assertions measure against.
 */
async function docBytes(sheets: SheetModel[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const sheet of sheets) {
    const page = doc.addPage(sheet.box);
    for (const rect of sheet.ink) {
      page.drawRectangle({
        x: rect.x0,
        y: sheet.box[1] - rect.y1,
        width: rect.x1 - rect.x0,
        height: rect.y1 - rect.y0,
        color: rgb(rect.colour[0] / 255, rect.colour[1] / 255, rect.colour[2] / 255),
      });
    }
    page.drawText('sheet', { x: 4, y: 4, size: 6, font, color: rgb(0, 0, 0) });
    // The text layer is written into the bytes as well, so two sheets with the same
    // ink and different words are two different documents to the double.
    if (sheet.text) page.drawText(sheet.text, { x: 4, y: 20, size: 6, font, color: rgb(0, 0, 0) });
  }
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

async function register(sheets: SheetModel[]): Promise<Uint8Array> {
  const bytes = await docBytes(sheets);
  rig.models.set(fnv1a(bytes), sheets);
  return bytes;
}

/* ── a pixel-true canvas, because jsdom has no raster ──────────────────────── */

interface Surface {
  width: number;
  height: number;
  /** RGBA, row-major, top row first — the order `getImageData` reports. */
  data: Uint8ClampedArray;
}

const surfaces = new WeakMap<HTMLCanvasElement, Surface>();
const pageCanvas = new WeakMap<HTMLCanvasElement, SheetModel>();
const landed = new WeakSet<HTMLCanvasElement>();

function surfaceOf(canvas: HTMLCanvasElement): Surface {
  const width = Math.max(0, Math.trunc(canvas.width) || 0);
  const height = Math.max(0, Math.trunc(canvas.height) || 0);
  const existing = surfaces.get(canvas);
  // Assigning width or height resets a canvas to transparent black: the state an
  // unawaited `renderPage` leaves behind, and what `earlyReads` counts.
  if (!existing || existing.width !== width || existing.height !== height) {
    const created: Surface = { width, height, data: new Uint8ClampedArray(width * height * 4) };
    surfaces.set(canvas, created);
    return created;
  }
  return existing;
}

function reading(canvas: HTMLCanvasElement): void {
  if (pageCanvas.has(canvas) && !landed.has(canvas)) rig.earlyReads += 1;
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

  constructor(readonly canvas: HTMLCanvasElement) {}

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

  createImageData(width: number, height: number): ImageData {
    return new ImageData(new Uint8ClampedArray(width * height * 4), width, height);
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
    const [r, g, b] = parseColour(this.fillStyle);
    const dst = surfaceOf(this.canvas);
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

  /**
   * Both spellings this seam uses: 1:1 at a point (`drawImage(c, dx, dy)`) and the
   * nine-argument source-rectangle form `CompareMain` uses to bottom-align a sheet
   * inside the compared frame.
   */
  drawImage(source: HTMLCanvasElement, ...args: number[]): void {
    reading(source);
    const src = surfaceOf(source);
    const bitmap: Surface = { width: src.width, height: src.height, data: src.data };
    if (args.length <= 4) {
      const [dx = 0, dy = 0] = args;
      this.blit(bitmap, Math.round(dx), Math.round(dy));
      return;
    }
    const [sx, sy, sw, sh, dx, dy, dw, dh] = args;
    const scaled: Surface = { width: Math.round(dw), height: Math.round(dh), data: new Uint8ClampedArray(Math.round(dw) * Math.round(dh) * 4) };
    for (let row = 0; row < scaled.height; row++) {
      for (let col = 0; col < scaled.width; col++) {
        const fromX = Math.min(src.width - 1, Math.round(sx + (col * sw) / Math.max(1, scaled.width)));
        const fromY = Math.min(src.height - 1, Math.round(sy + (row * sh) / Math.max(1, scaled.height)));
        if (fromX < sx || fromY < sy || fromX >= sx + sw || fromY >= sy + sh) continue;
        const from = (fromY * src.width + fromX) * 4;
        const to = (row * scaled.width + col) * 4;
        for (let c = 0; c < 4; c++) scaled.data[to + c] = bitmap.data[from + c];
      }
    }
    this.blit(scaled, Math.round(dx), Math.round(dy));
  }

  private blit(source: Surface, dx: number, dy: number): void {
    const dst = surfaceOf(this.canvas);
    for (let row = 0; row < source.height; row++) {
      const ty = dy + row;
      if (ty < 0 || ty >= dst.height) continue;
      for (let col = 0; col < source.width; col++) {
        const tx = dx + col;
        if (tx < 0 || tx >= dst.width) continue;
        const from = (row * source.width + col) * 4;
        const to = (ty * dst.width + tx) * 4;
        for (let c = 0; c < 4; c++) dst.data[to + c] = source.data[from + c];
      }
    }
  }

  save(): void {}
  restore(): void {}
  clearRect(x: number, y: number, width: number, height: number): void {
    const dst = surfaceOf(this.canvas);
    for (let row = Math.round(y); row < Math.round(y + height); row++) {
      for (let col = Math.round(x); col < Math.round(x + width); col++) {
        if (col < 0 || row < 0 || col >= dst.width || row >= dst.height) continue;
        const at = (row * dst.width + col) * 4;
        dst.data[at + 3] = 0;
      }
    }
  }
}

/** Real PNG with alpha: signature, IHDR, one filter-0 IDAT stream, IEND. */
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
  header[8] = 8;
  header[9] = 6; // truecolour + alpha
  const parts = [
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
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
    const bytes = encodePng(surface);
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
    Object.defineProperty(globalThis, 'ImageData', { value: ShimImageData, configurable: true, writable: true });
  }
}

/* ── the pdf.js double: paper when the task settles, ink in a later task ───── */

/** Paint the sheet's rectangles into a canvas surface, top-left origin like a page. */
function paintInk(canvas: HTMLCanvasElement, sheet: SheetModel): void {
  const surface = surfaceOf(canvas);
  const perPoint = canvas.width / sheet.box[0];
  for (const rect of sheet.ink) {
    const [r, g, b] = rect.colour;
    for (let y = Math.round(rect.y0 * perPoint); y < Math.round(rect.y1 * perPoint); y++) {
      for (let x = Math.round(rect.x0 * perPoint); x < Math.round(rect.x1 * perPoint); x++) {
        if (x < 0 || y < 0 || x >= surface.width || y >= surface.height) continue;
        const at = (y * surface.width + x) * 4;
        surface.data[at] = r;
        surface.data[at + 1] = g;
        surface.data[at + 2] = b;
        surface.data[at + 3] = 255;
      }
    }
  }
}

vi.mock('pdfjs-dist', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pdfjs-dist')>();

  function pageFor(sheet: SheetModel) {
    return {
      rotate: 0,
      getViewport: ({ scale }: { scale: number }) => ({
        width: Math.floor(sheet.box[0] * scale),
        height: Math.floor(sheet.box[1] * scale),
        scale,
      }),
      getTextContent: async () => ({
        items: (sheet.text ?? '').split(/\s+/).filter(Boolean).map((str) => ({ str })),
      }),
      cleanup: () => {},
      render: ({ canvasContext }: { canvasContext: StubContext }) => {
        rig.renders += 1;
        rig.inFlight += 1;
        rig.maxInFlight = Math.max(rig.maxInFlight, rig.inFlight);
        const canvas = canvasContext.canvas;
        let finished = false;
        const leave = () => {
          if (finished) return;
          finished = true;
          rig.inFlight -= 1;
        };
        pageCanvas.set(canvas, sheet);
        // pdf.js paints its background synchronously and the page on a later frame,
        // which is exactly the gap a caller can fall into.
        canvasContext.fillStyle = '#ffffff';
        canvasContext.fillRect(0, 0, canvas.width, canvas.height);
        let settle: () => void = () => {};
        const promise = new Promise<void>((resolve) => {
          settle = resolve;
        });
        const timer = setTimeout(() => {
          leave();
          paintInk(canvas, sheet);
          landed.add(canvas);
          settle();
        }, 0);
        promise.catch(() => undefined);
        return {
          promise,
          cancel: () => {
            leave();
            clearTimeout(timer);
          },
        };
      },
    };
  }

  return {
    ...actual,
    GlobalWorkerOptions: { workerSrc: '' },
    getDocument: (source: { data: Uint8Array | ArrayBuffer }) => {
      // pdf.js takes either spelling of "the file's bytes", and `CompareMain` hands
      // it an `ArrayBuffer` while `core/render` hands it a `Uint8Array`.
      const bytes = source.data instanceof Uint8Array ? source.data : new Uint8Array(source.data);
      const sheets = rig.models.get(fnv1a(bytes));
      if (!sheets) {
        throw new Error('the pdf.js double was handed a document no fixture modelled');
      }
      const proxy = {
        numPages: sheets.length,
        fingerprints: ['compare-diff'],
        getPage: async (n: number) => pageFor(sheets[n - 1]),
        destroy: async () => {},
      };
      return { promise: Promise.resolve(proxy) };
    },
  };
});

/* ── reading the exported page back out of its own bytes ───────────────────── */

interface Raster {
  width: number;
  height: number;
  rgb: Uint8Array;
  alpha: Uint8Array;
}

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

/** The page's own content stream, however pdf-lib stored it. */
function contentText(doc: PDFDocument, page: PDFPage): string {
  const direct = page.node.Contents();
  const resolved = direct instanceof PDFRef ? doc.context.lookup(direct) : direct;
  const items = resolved instanceof PDFArray
    ? resolved.asArray()
    : resolved instanceof PDFRawStream
      ? [resolved]
      : [];
  return items
    .map((item) => streamOf(doc, item))
    .map((stream) => (stream ? Buffer.from(samplesOf(stream)).toString('latin1') : ''))
    .join('\n');
}

/** The page's image XObjects, in the order its content stream draws them. */
function drawnImages(doc: PDFDocument, page: PDFPage): Raster[] {
  const resources = dictOf(doc, page.node.Resources());
  const xobjects = dictOf(doc, resources?.get(PDFName.of('XObject')));
  expect(xobjects, 'the exported page drew no image at all').not.toBeNull();
  const names = [...contentText(doc, page).matchAll(/\/([A-Za-z0-9._-]+)\s+Do\b/g)].map((m) => m[1]);
  return names
    .map((name) => streamOf(doc, xobjects!.get(PDFName.of(name))))
    .filter((s): s is PDFRawStream => s !== null)
    .map((s) => {
      const width = numberAt(s.dict, 'Width');
      const height = numberAt(s.dict, 'Height');
      const stored = samplesOf(s);
      expect(`${s.dict.get(PDFName.of('ColorSpace'))}`, 'the comparison image is not DeviceRGB').toBe('/DeviceRGB');
      const mask = streamOf(doc, s.dict.get(PDFName.of('SMask')));
      const alpha = mask ? samplesOf(mask) : new Uint8Array(width * height).fill(255);
      expect(stored.length, 'stored samples are not Width×Height×3').toBe(width * height * 3);
      expect(alpha.length, '/SMask is not one byte per pixel').toBe(width * height);
      return { width, height, rgb: stored, alpha };
    });
}

/** Non-white pixels of an image as it *shows* over paper. */
function inkOf(raster: Raster): number {
  let dark = 0;
  for (let i = 0; i < raster.width * raster.height; i++) {
    if (raster.rgb[i * 3] < 245 || raster.rgb[i * 3 + 1] < 245 || raster.rgb[i * 3 + 2] < 245) dark += 1;
  }
  return dark;
}

/**
 * The marked box of an overlay, in page points from its top-left.
 *
 * A marked pixel is one the overlay paints with any alpha: the diff writes the
 * highlight only where the two pages differ, so this is the tool's own claim about
 * where the change is, read out of the file it handed the user. `null` when the
 * overlay covers nothing.
 */
function markedBox(raster: Raster, pageBox: [number, number]): [number, number, number, number] | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let y = 0; y < raster.height; y++) {
    for (let x = 0; x < raster.width; x++) {
      if (raster.alpha[y * raster.width + x] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  const perPointX = raster.width / pageBox[0];
  const perPointY = raster.height / pageBox[1];
  return [x0 / perPointX, y0 / perPointY, (x1 + 1) / perPointX, (y1 + 1) / perPointY];
}

function markedPixels(raster: Raster): number {
  let n = 0;
  for (let i = 0; i < raster.width * raster.height; i++) if (raster.alpha[i] !== 0) n += 1;
  return n;
}

/* ── driving the shipped tools ─────────────────────────────────────────────── */

function fileOf(name: string, bytes: Uint8Array): ToolFile {
  return {
    name,
    size: bytes.byteLength,
    type: 'application/pdf',
    bytes: async () => new Uint8Array(bytes),
    blob: () => new Blob([bytes], { type: 'application/pdf' }),
  };
}

interface RunReport {
  message: string;
  warnings: string[];
  pages: PDFPage[];
  doc: PDFDocument;
  bytes: Uint8Array;
  kind: string;
  rows: { label: string; value: string }[];
  files: unknown;
}

async function runCompare(id: string, pairs: Uint8Array[], values: ToolValues = {}): Promise<RunReport> {
  const tool = getPdfTool(id);
  expect(tool, `${id} is not registered`).toBeTruthy();
  const result = (await tool!.run!({
    inputs: pairs.map((bytes, index) => fileOf(index === 0 ? 'a.pdf' : 'b.pdf', bytes)),
    values: { ...defaultValues(tool!.fields), ...values },
    progress: () => {},
    log: () => {},
    signal: new AbortController().signal,
  }))!;
  const pdf = result.kind === 'pdf'
    ? await openPDF((result as { bytes: Uint8Array }).bytes)
    : null;
  const report = result as unknown as {
    message?: string;
    warnings?: string[];
    sections?: { rows?: { label: string; value: string }[] }[];
    files?: unknown;
  };
  return {
    kind: result.kind,
    message: report.message ?? '',
    warnings: report.warnings ?? [],
    rows: (report.sections ?? []).flatMap((section) => section.rows ?? []),
    files: report.files,
    doc: pdf ?? (await PDFDocument.create()),
    pages: pdf ? pdf.getPages() : [],
    bytes: (result as { bytes?: Uint8Array }).bytes ?? new Uint8Array(0),
  };
}

/**
 * Device pixels per point, in both halves.
 *
 * The panel's resolution box defaults to 144 dpi — exactly two device px per point —
 * and the export is written at the same density, so one number covers the verdict and
 * the file and every count below is exact rather than a tolerance.
 */
const EXPORT_SCALE = 2;
const PANE_SCALE = 2;
const EXPORTED_AREA = (ptArea: number) => ptArea * EXPORT_SCALE * EXPORT_SCALE;
const PANE_AREA = (ptArea: number) => ptArea * PANE_SCALE * PANE_SCALE;

let bytesA: Uint8Array;
let bytesB: Uint8Array;
let bytesBlank: Uint8Array;

beforeAll(async () => {
  installCanvas();
  bytesA = await register(SHEETS_A);
  bytesB = await register(SHEETS_B);
  bytesBlank = await register([{ box: SHEET, ink: [] }]);
});

afterEach(() => {
  cleanup();
  useFileStore.getState().setFiles([]);
});

beforeEach(() => {
  rig.earlyReads = 0;
  rig.renders = 0;
  rig.inFlight = 0;
  rig.maxInFlight = 0;
});

/* ══ 1. the exported file: the difference, painted where it was planted ═════ */

describe('the exported comparison', () => {
  it('marks the planted difference at the place it was planted', async () => {
    const out = await runCompare('compare', [bytesA, bytesB]);
    expect(out.kind, 'compare should still write a PDF').toBe('pdf');
    expect(out.pages, 'one output page per page both files have').toHaveLength(3);
    expect(out.message).toMatch(/Compared 3 pages/);
    expect(rig.earlyReads, 'the export read a page canvas before its paint landed').toBe(0);

    const page = out.pages[PLANTED.page - 1];
    const images = drawnImages(out.doc, page);
    expect(images, 'the export writes the page and its overlay, two images').toHaveLength(2);
    const [sheet, overlay] = images;
    const box = markedBox(overlay, SHEET);
    expect(
      box,
      'the exported copy marks nothing, so the difference is invisible in the file',
    ).toEqual([PLANTED.x0, PLANTED.y0, PLANTED.x1, PLANTED.y1]);
    // The mark is the difference and not the page: 3 200 pt² of 19 200 pt².
    expect(markedPixels(overlay)).toBe(EXPORTED_AREA(PLANTED_AREA));
    expect(
      markedPixels(overlay) / (sheet.width * sheet.height),
      'the overlay covers more of the sheet than the planted block does',
    ).toBeLessThan(0.2);
  });

  it('exports the page it photographed, not paper under a mark', async () => {
    const out = await runCompare('compare', [bytesA, bytesB]);
    const inked = out.pages.map((page) => drawnImages(out.doc, page)[0]);
    expect(inked.map(inkOf)).toEqual([
      EXPORTED_AREA(COPY_AREA),
      EXPORTED_AREA(SECOND_AREA),
      0,
    ]);
  });

  it('reports no difference for A against A — and keeps the page inked while doing so', async () => {
    const out = await runCompare('compare', [bytesA, bytesA]);
    // An equal page has no overlay to draw, so the export holds **one** image per
    // page instead of a second, fully transparent one: measured before this, 2 image
    // XObjects per page on all three sheets of an A-against-A download (85 247 bytes,
    // 0 of 999 600 alpha bytes set), i.e. bytes for nothing on every page.
    const images = out.pages.map((page) => drawnImages(out.doc, page));
    expect(images.map((pair) => pair.length), 'an equal page still got an overlay').toEqual([1, 1, 1]);
    // The zero has to be earned: the page image still carries the copy, so "nothing
    // differs" is a measurement and not a canvas nobody painted.
    expect(inkOf(images[0][0])).toBe(EXPORTED_AREA(COPY_AREA));
    expect(rig.earlyReads).toBe(0);
  });

  it('does not call two empty sheets a difference, and invents nothing on them', async () => {
    const out = await runCompare('compare', [bytesBlank, bytesBlank]);
    const images = out.pages.map((page) => drawnImages(out.doc, page));
    expect(images.every((pair) => pair.length === 1), 'blank versus blank is not a change').toBe(true);
    expect(images.every((pair) => inkOf(pair[0]) === 0), 'a blank sheet must stay blank in the file').toBe(true);
  });

  it('leaves the page both files share untouched, and marks only the one that changed', async () => {
    const out = await runCompare('compare', [bytesA, bytesB]);
    const images = out.pages.map((page) => drawnImages(out.doc, page));
    expect(markedPixels(images[PLANTED.page - 1][1]!), 'the page with the planted block is not marked')
      .toBe(EXPORTED_AREA(PLANTED_AREA));
    // The unchanged sheet and the empty one carry the page and no overlay at all.
    expect(images.slice(1).map((pair) => pair.length), 'a page nobody changed came back with an overlay')
      .toEqual([1, 1]);
  });

  it('marks only what the sensitivity catches, in the colour that was chosen', async () => {
    const above = await runCompare('compare', [bytesA, bytesB], { sensitivity: 150 });
    expect(markedPixels(drawnImages(above.doc, above.pages[0])[1])).toBe(EXPORTED_AREA(PLANTED_AREA));

    // The field's ceiling (150) is far below the 765 a black block over paper is
    // worth, so the same pair at a threshold the clamp refuses is still marked —
    // and the clamp itself is announced rather than silently applied.
    const pushed = await runCompare('compare', [bytesA, bytesB], { sensitivity: 9000 });
    expect(markedPixels(drawnImages(pushed.doc, pushed.pages[0])[1])).toBe(EXPORTED_AREA(PLANTED_AREA));
    expect(pushed.warnings.join(' ')).toMatch(/sensitivity/i);

    const blue = await runCompare('compare', [bytesA, bytesB], { highlightColor: '#0000ff' });
    const overlay = drawnImages(blue.doc, blue.pages[0])[1];
    const at = (PLANTED.y0 * EXPORT_SCALE) * overlay.width + PLANTED.x0 * EXPORT_SCALE;
    expect([overlay.rgb[at * 3], overlay.rgb[at * 3 + 1], overlay.rgb[at * 3 + 2]]).toEqual([0, 0, 255]);
  });

  it('reports the pages only one document has instead of diffing them', async () => {
    const short = await register([SHEETS_B[0]]);
    const out = await runCompare('compare', [bytesA, short]);
    expect(out.pages).toHaveLength(1);
    expect(out.message).toMatch(/Compared 1 page/);
    expect(out.warnings.join(' ')).toMatch(/2 more pages? the other does not|extra page/i);
  });
});

/* ══ 2. the rail's own report: the same pixels, the other path ══════════════ */

describe('compare-pdfs as a report (the path the route never reaches)', () => {
  it('reads the planted difference instead of calling every page a match', async () => {
    const out = await runCompare('compare-pdfs', [bytesA, bytesB], { mode: 'visual', dpi: 72 });
    expect(out.kind).toBe('report');
    expect(out.rows.map((row) => row.value)).toEqual([
      `${((PLANTED_AREA / (SHEET[0] * SHEET[1])) * 100).toFixed(2)}% of pixels differ`,
      'no visible difference',
      'no visible difference',
    ]);
    expect(out.message).toMatch(/1 of 3 page\(s\) differ/);
    expect(rig.earlyReads, 'the report read a page canvas before its paint landed').toBe(0);
  });

  it('calls an equal pair equal, and two empty sheets equal too', async () => {
    const same = await runCompare('compare-pdfs', [bytesA, bytesA], { mode: 'visual', dpi: 72 });
    expect(same.message).toMatch(/No differences found across 3 page/);
    const blank = await runCompare('compare-pdfs', [bytesBlank, bytesBlank], { mode: 'visual', dpi: 72 });
    expect(blank.message).toMatch(/No differences found across 1 page/);
  });

  it('throws the pictures it makes away, which is why its copy may not promise them', async () => {
    const out = await runCompare('compare-pdfs', [bytesA, bytesB], { mode: 'visual', dpi: 72 });
    expect(out.files, 'the report never returns the per-page overlay it encoded').toBeUndefined();
  });
});

/* ══ 3. the pane: the verdict the user reads, and where it says the change is */

const { CompareMain, getCompareState, setCompareMode, setCompareResolution, setCompareSensitivity } = await import(
  '@/components/tools/pdf/security/CompareMain'
);
const { CompareTool } = await import('@/components/tools/pdf/security/CompareTool');

function pdfFile(name: string, bytes: Uint8Array): File {
  return new File([bytes], name, { type: 'application/pdf' });
}

/** Clears the module state the pane publishes, so a stale verdict cannot pass. */
function startFresh(): void {
  const state = getCompareState();
  state.compared = false;
  state.diffPixels = 0;
  state.diffRegions = 0;
  state.diffAreas = [];
  state.diffPercent = 0;
  state.totalPixels = 0;
  state.page = 1;
  state.sensitivity = 30;
  state.highlightColor = '#ff0000';
}

async function loadPair(left: Uint8Array, right: Uint8Array) {
  startFresh();
  useFileStore.getState().setFiles([pdfFile('a.pdf', left), pdfFile('b.pdf', right)]);
  const view = render(createElement('div', null, [
    createElement(CompareMain, { key: 'pane' }),
    createElement(CompareTool, { key: 'panel' }),
  ]));
  await waitFor(() => expect(getCompareState().compared).toBe(true), { timeout: 20_000 });
  return view;
}

function sheetCanvases(): HTMLCanvasElement[] {
  const box = document.querySelector('[data-compare-scroll]');
  const all = box ? [...box.querySelectorAll('canvas')] : [];
  const overlay = all.find((c) => c.hasAttribute('data-compare-overlay'));
  return all.filter((c) => c !== overlay);
}

function overlayCanvas(): HTMLCanvasElement | undefined {
  return document.querySelector<HTMLCanvasElement>('[data-compare-scroll] canvas[data-compare-overlay]')
    ?? undefined;
}

describe('the pane’s verdict', () => {
  it('paints both sheets on load instead of reporting an all-clear over nothing', async () => {
    await loadPair(bytesA, bytesB);
    const sizes = sheetCanvases().map((c) => [c.width, c.height]);
    // 300×150 is the size of a canvas nobody ever drew into, which is what the
    // first render used to leave behind while its own loading state held the DOM.
    expect(sizes).toEqual([[SHEET[0] * PANE_SCALE, SHEET[1] * PANE_SCALE], [SHEET[0] * PANE_SCALE, SHEET[1] * PANE_SCALE]]);
    const state = getCompareState();
    expect(state.compared, 'no comparison ran').toBe(true);
    expect(state.diffPixels).toBe(PANE_AREA(PLANTED_AREA));
    expect(state.diffRegions).toBe(1);
    expect(state.diffAreas[0]).toEqual({
      x0: PLANTED.x0,
      y0: PLANTED.y0,
      x1: PLANTED.x1,
      y1: PLANTED.y1,
    });
    expect(state.diffPercent).toBe(Math.round((PLANTED_AREA / (SHEET[0] * SHEET[1])) * 1000) / 10);
  });

  it('says where the change is, in the page’s own points, in both panels', async () => {
    const view = await loadPair(bytesA, bytesB);
    const status = view.container.querySelector('[role=status][data-compare-counts]');
    expect(status?.textContent).toMatch(new RegExp(`x ${PLANTED.x0}–${PLANTED.x1} · y ${PLANTED.y0}–${PLANTED.y1} pt`));
    expect(status?.getAttribute('data-compare-area')).toBe(
      `${PLANTED.x0},${PLANTED.y0},${PLANTED.x1},${PLANTED.y1}`,
    );
    const listed = [...view.container.querySelectorAll('[data-compare-area]')];
    expect(listed.length, 'the card beside the pages does not list the changed area').toBeGreaterThan(0);
    expect(listed[listed.length - 1]?.getAttribute('data-compare-area')).toBe(
      `${PLANTED.x0},${PLANTED.y0},${PLANTED.x1},${PLANTED.y1}`,
    );
  });

  it('reports the same number in the card as on the strip above the pages', async () => {
    const view = await loadPair(bytesA, bytesB);
    const percent = Math.round((PLANTED_AREA / (SHEET[0] * SHEET[1])) * 1000) / 10;
    const card = view.container.querySelector('[data-compare-diff]');
    expect(
      card?.textContent?.trim(),
      'the card is showing its own initial state rather than the verdict',
    ).toBe(`${percent}%`);
    // The strip above the pages and the card beside them must publish one number:
    // the deployed pair showed 13,600 changed pixels on the strip under a card that
    // still read 0 %, because the card re-rendered for some other reason or not at
    // all.
    const strip = view.container.querySelector('[data-compare-counts]');
    expect(strip?.getAttribute('data-compare-percent')).toBe(card?.getAttribute('data-compare-diff'));
    expect(view.container.querySelector('[data-compare-areas]')?.getAttribute('data-compare-areas')).toBe('1');
    expect(
      [...view.container.querySelectorAll('p')].some((p) => /Nothing differs on the page in view/.test(p.textContent ?? '')),
      'the all-clear line is still up over a measured difference',
    ).toBe(false);
  });

  it('calls A against A no different — after a comparison that ran', async () => {
    await loadPair(bytesA, bytesA);
    const state = getCompareState();
    expect(state.compared).toBe(true);
    expect(state.diffPixels).toBe(0);
    expect(state.diffRegions).toBe(0);
    expect(state.diffAreas).toEqual([]);
    expect(markedPixels(surfaceAsRaster(overlayCanvas()))).toBe(0);
  });

  it('does not call two empty sheets different, and paints no marks on them', async () => {
    await loadPair(bytesBlank, bytesBlank);
    const state = getCompareState();
    expect(sheetCanvases().map((c) => [c.width, c.height]))
      .toEqual([[SHEET[0] * PANE_SCALE, SHEET[1] * PANE_SCALE], [SHEET[0] * PANE_SCALE, SHEET[1] * PANE_SCALE]]);
    expect(state.compared).toBe(true);
    expect(state.diffPixels, 'an empty sheet is not a difference').toBe(0);
    expect(state.diffRegions).toBe(0);
  });

  it('re-answers from the pixels it read when the sensitivity moves', async () => {
    await loadPair(bytesA, bytesB);
    const rendered = rig.renders;
    act(() => setCompareSensitivity(BLACK_ON_WHITE));
    expect(getCompareState().diffPixels, 'the threshold did not reach the verdict').toBe(0);
    act(() => setCompareSensitivity(30));
    expect(getCompareState().diffPixels, 'the verdict did not come back').toBe(PANE_AREA(PLANTED_AREA));
    expect(rig.renders, 'the slider re-rendered both pages instead of reusing the pixels').toBe(rendered);
  });

  it('refuses to photograph a sheet another render task is still painting', async () => {
    // React's StrictMode runs the load effect twice, which is how the dev server
    // reached the race the deployed page can also reach by turning a pair over
    // while it is still painting: two `page.render()` tasks on one canvas. Measured
    // there, a pair of byte-identical documents answered 13,998 changed pixels in
    // two areas, over a canvas that read `opaque 2.98 %` instead of 100 %.
    startFresh();
    useFileStore.getState().setFiles([pdfFile('a.pdf', bytesA), pdfFile('b.pdf', bytesB)]);
    render(createElement(StrictMode, null, createElement(CompareMain)));
    await waitFor(() => expect(getCompareState().compared).toBe(true), { timeout: 20_000 });
    expect(rig.maxInFlight, 'two render tasks were on one canvas at once').toBeLessThanOrEqual(1);
    const state = getCompareState();
    expect(state.diffPixels).toBe(PANE_AREA(PLANTED_AREA));
    expect(state.diffAreas[0]).toEqual({ x0: PLANTED.x0, y0: PLANTED.y0, x1: PLANTED.x1, y1: PLANTED.y1 });
    // Both sheets are paper under their ink: a torn canvas has ink floating on
    // transparency, which is what turned A-versus-A into a difference.
    for (const canvas of sheetCanvases()) {
      const raster = surfaceAsRaster(canvas);
      let transparent = 0;
      for (let i = 0; i < raster.alpha.length; i++) if (raster.alpha[i] === 0) transparent += 1;
      expect(transparent, 'a photographed sheet is not fully painted').toBe(0);
    }
  });

  it('marks the overlay in the frame the sheet is drawn in', async () => {
    await loadPair(bytesA, bytesB);
    const overlay = overlayCanvas();
    expect(overlay, 'no overlay canvas is mounted').toBeTruthy();
    expect([overlay!.width, overlay!.height]).toEqual([SHEET[0] * PANE_SCALE, SHEET[1] * PANE_SCALE]);
    const raster = surfaceAsRaster(overlay);
    expect(markedPixels(raster)).toBe(PANE_AREA(PLANTED_AREA));
    const at = (PLANTED.y0 * PANE_SCALE + 1) * raster.width + PLANTED.x0 * PANE_SCALE + 1;
    expect([raster.rgb[at * 3], raster.rgb[at * 3 + 1], raster.rgb[at * 3 + 2]]).toEqual([255, 0, 0]);
  });
});

/* ══ 4. one alignment, one reading: a pair that differs in page height ══════ */

/**
 * The same copy and the same block on two sheets of *different heights*.
 *
 * The pane used to bottom-align the pair inside the union frame while the export
 * painted it top-aligned, so on this pair — where nothing differs but the height —
 * the pane answered **1 changed area at `y -29–103`** (negative, i.e. above the
 * page) over **7 248 changed pixels** while the export of the same pair marked
 * **0 px**. Top-aligned, both halves compare the same rows and the only differences
 * left are the two sheets' own footers, each at its own bottom.
 */
const FOOTER_A: SheetModel[] = [{ box: [120, 120], ink: [{ x0: 10, y0: 110, x1: 60, y1: 114, colour: [0, 0, 0] }] }];
const FOOTER_TALL: SheetModel[] = [
  { box: [120, 160], ink: [{ x0: 10, y0: 150, x1: 60, y1: 154, colour: [0, 0, 0] }] },
];

describe('a pair that differs in page height', () => {
  it('measures the verdict on the sheet in view, never above it', async () => {
    const short = await register(FOOTER_A);
    const tall = await register(FOOTER_TALL);
    const view = await loadPair(short, tall);
    const state = getCompareState();
    expect(state.compared).toBe(true);
    // Two differences, and both are *on* the page: each sheet's own footer, where
    // that sheet puts it. Bottom-aligned, A's footer was compared against B's rows
    // 40 px further down and came back at y -30 with a second area beside it.
    const rows = state.diffAreas.map((area) => area.y0).sort((x, y) => x - y);
    expect(rows, 'a changed area was reported above the top of the page').toEqual([110, 150]);
    expect(state.diffAreas.find((area) => area.y0 === 110)).toEqual({ x0: 10, y0: 110, x1: 60, y1: 114 });
    expect(state.areasOnPage, 'the areas no longer name a spot on the page').toBe(true);
    expect(view.container.querySelector('[data-compare-counts]')?.textContent).not.toMatch(/compared sheet/);
  });

  it('marks the same band in the export, and nothing above the page', async () => {
    const short = await register(FOOTER_A);
    const tall = await register(FOOTER_TALL);
    const out = await runCompare('compare', [short, tall]);
    const box = markedBox(drawnImages(out.doc, out.pages[0])[1]!, [120, 160]);
    expect(box, 'the export marks nothing on a pair that differs only in height').not.toBeNull();
    // The same two bands the pane found, on the produced page: nothing at the top.
    expect(box![1]).toBeGreaterThanOrEqual(110);
    expect(box![3]).toBeLessThanOrEqual(160);
  });
});

/* ══ 5. the mode segment and the resolution box, on the page ════════════════ */

/** Same ink on both sheets, different text: the change only the text layer holds. */
const WORDS_A: SheetModel[] = [{ box: SHEET, ink: COPY, text: 'the quick brown fox' }];
const WORDS_B: SheetModel[] = [{ box: SHEET, ink: COPY, text: 'the quick brown cat' }];

function modeButton(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === label);
  expect(found, `the panel renders no "${label}" control`).toBeTruthy();
  return found as HTMLButtonElement;
}

describe('the mode segment and the resolution box', () => {
  it('renders the three modes the definition declares, and one of them is pressed', async () => {
    const view = await loadPair(bytesA, bytesB);
    const pressed = ['Pixels', 'Text content', 'Both'].filter((label) => modeButton(view.container, label).getAttribute('aria-pressed') === 'true');
    expect(pressed, 'exactly one mode is the current one').toEqual(['Pixels']);
    // Both of these used to be declared on the definition, printed in the promise and
    // rendered nowhere: the page's only controls were Prev/Next and the run button.
    expect(view.container.querySelector('#compare-dpi'), 'the resolution box is missing').toBeTruthy();
  });

  it('reports a text change the renderings hide, and stops calling the page equal', async () => {
    const a = await register(WORDS_A);
    const b = await register(WORDS_B);
    const view = await loadPair(a, b);
    const strip = view.container.querySelector('[data-compare-counts]');
    // Pixels: identical ink, so nothing to mark and nothing to report.
    expect(getCompareState().diffPixels).toBe(0);
    expect(strip?.getAttribute('data-compare-identical')).toBe('true');

    act(() => modeButton(view.container, 'Text content').click());
    expect(modeButton(view.container, 'Text content').getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(strip?.getAttribute('data-compare-text')).toBe('differs'), { timeout: 20_000 });
    expect(strip?.textContent).toMatch(/text differs \(1 word\(s\) removed, 1 added\)/);
    expect(strip?.getAttribute('data-compare-identical'), 'a text change was published as an all-clear').toBe('false');
    expect(view.container.querySelector('[data-compare-text="differs"]'), 'the card does not carry the finding').toBeTruthy();
    // The marks are the pixel answer and stay absent: the copy is a pixel comparison.
    expect(getCompareState().diffPixels).toBe(0);
  }, 60_000);

  it('renders both sheets at the resolution the box asks for, and still reports in points', async () => {
    await loadPair(bytesA, bytesB);
    act(() => setCompareResolution(72));
    await waitFor(() => expect(sheetCanvases()[0]?.width).toBe(SHEET[0]), { timeout: 20_000 });
    expect(sheetCanvases().map((c) => [c.width, c.height])).toEqual([SHEET, SHEET]);
    // The unit does not follow the zoom: an area is in the page's own points, which
    // is where the export puts the mark.
    expect(getCompareState().diffAreas[0]).toEqual({ x0: PLANTED.x0, y0: PLANTED.y0, x1: PLANTED.x1, y1: PLANTED.y1 });
  });
});

/* ══ 6. two diffs, one opacity and one threshold ════════════════════════════ */

/** The faint change: 20 per channel, a sum of 60 — over 30, under 3 × 30. */
const FAINT: InkRect = { x0: 20, y0: 40, x1: 100, y1: 80, colour: [235, 235, 235] };
const FAINT_A: SheetModel[] = [{ box: SHEET, ink: COPY }];
const FAINT_B: SheetModel[] = [{ box: SHEET, ink: [...COPY, FAINT] }];

/** Encode-time capture of every canvas the run hands `toBlob`, i.e. its overlays. */
async function captureEncoded<T>(fn: () => Promise<T>): Promise<{ result: T; surfaces: Surface[] }> {
  const proto = HTMLCanvasElement.prototype as unknown as {
    toBlob: (cb: (blob: Blob | null) => void, type?: string) => void;
  };
  const real = proto.toBlob;
  const surfaces: Surface[] = [];
  proto.toBlob = function toBlob(this: HTMLCanvasElement, cb, type) {
    surfaces.push(surfaceOf(this));
    return real.call(this, cb, type);
  };
  try {
    const result = await fn();
    return { result, surfaces };
  } finally {
    proto.toBlob = real;
  }
}

/** The alpha the overlay paints at a point 1 px inside the faint block's corner. */
function alphaAt(surface: Surface, x: number, y: number): number {
  return surface.data[(y * surface.width + x) * 4 + 3];
}

describe('the two pixel diffs the tool carries', () => {
  it('paints one change at one opacity, whichever path reached it', async () => {
    const a = await register(FAINT_A);
    const b = await register(FAINT_B);
    // The exported copy writes its overlay through `toBlob`; so does the report path.
    const { surfaces, result } = await captureEncoded(async () => {
      const exported = await runCompare('compare', [a, b]);
      const reported = await runCompare('compare-pdfs', [a, b], { mode: 'visual', dpi: 144 });
      return { exported, reported };
    });
    const at = (surface: Surface) => alphaAt(surface, FAINT.x0 * EXPORT_SCALE + 1, FAINT.y0 * EXPORT_SCALE + 1);
    // Two different spellings of "how much": distance × 1.5, clamped. The report path
    // used a flat 200, so the same change painted at 90 in the file and 200 on the
    // page the report describes.
    const inner = (surface: Surface) => (FAINT.y0 * EXPORT_SCALE + 1) * surface.width + FAINT.x0 * EXPORT_SCALE + 1;
    /** Whether this surface carries the report path's own highlight colour, 225/29/72. */
    const isReportOverlay = (surface: Surface) => {
      const at = inner(surface) * 4;
      return surface.data[at] === 225 && surface.data[at + 1] === 29 && surface.data[at + 2] === 72;
    };
    const exportOverlay = surfaces.find((surface) => at(surface) === 90 && !isReportOverlay(surface));
    expect(exportOverlay, 'the export no longer paints the faint change at distance × 1.5').toBeTruthy();
    const reportOverlay = surfaces.find(isReportOverlay);
    expect(reportOverlay, 'the report wrote no highlight-coloured overlay').toBeTruthy();
    expect(at(reportOverlay!), 'the report path paints the same change at another opacity').toBe(90);
    // And the threshold is the slider's own unit, not a mean channel distance: the
    // faint block's sum is 60, over 30, so the report has to find it.
    expect(result.reported.rows[0]?.value).toMatch(/% of pixels differ/);
    expect(result.exported.pages).toHaveLength(1);
  });
});

/* ══ 7. one field name, one number ═════════════════════════════════════════ */

describe('the sensitivity setting', () => {
  it('is the slider’s number on every surface that names it', () => {
    const field = (getPdfTool('compare-pdfs')!.fields ?? []).find((entry) => entry.key === 'sensitivity');
    expect(field, 'the definition declares no sensitivity field').toBeTruthy();
    // 24 out of 120 on the definition, 30 out of 150 on the slider: the same field
    // name asked for two different settings depending on which surface stood behind
    // it, and neither range could reach the other's default.
    expect(field!.default).toBe(30);
    expect([field!.min, field!.max]).toEqual([5, 150]);
    expect(getCompareState().sensitivity).toBe(field!.default);
  });
});

/** The live bitmap of a canvas the stub is holding, as RGB + alpha. */
function surfaceAsRaster(canvas: HTMLCanvasElement | undefined | null): Raster {
  expect(canvas, 'expected a canvas that is not in the DOM').toBeTruthy();
  const surface = surfaceOf(canvas!);
  const rgbBytes = new Uint8Array(surface.width * surface.height * 3);
  const alpha = new Uint8Array(surface.width * surface.height);
  for (let i = 0; i < surface.width * surface.height; i++) {
    for (let c = 0; c < 3; c++) rgbBytes[i * 3 + c] = surface.data[i * 4 + c];
    alpha[i] = surface.data[i * 4 + 3];
  }
  return { width: surface.width, height: surface.height, rgb: rgbBytes, alpha };
}

/* ── 5. the card may only clear the half the mode was asked about ─────────── */

// Measured live (`docs/research/compare-rail.mjs MODESHOT=1` at :5294) over a pair
// whose one difference is text the rendering does not show: the panel printed `0%`
// and “Page 1 matches at this sensitivity — 1 page in common are being checked”
// directly above its own next line, “The text of page 1 differs: 0 word(s) removed,
// 4 added.” An all-clear headline over a found difference — and `sensitivity` is a
// pixel control the text answer never consults.
const HIDTEXT_A = 'bay four signed in';
const HIDTEXT_B = 'bay four signed out';
const WORDY_A: SheetModel[] = [{ box: SHEET, ink: COPY, text: HIDTEXT_A }];
const WORDY_B: SheetModel[] = [{ box: SHEET, ink: COPY, text: HIDTEXT_B }];

/** Everything the card beside the pages says, headline included. */
function cardCopy(view: { container: HTMLElement }): string {
  return view.container.querySelector('[data-compare-diff]')?.parentElement?.textContent ?? '';
}

describe('the card only clears the half the mode compared', () => {
  it('refuses to say it matches at this sensitivity over differing text', async () => {
    setCompareMode('text');
    try {
      const view = await loadPair(await register(WORDY_A), await register(WORDY_B));
      const state = getCompareState();
      expect(state.diffPixels, 'the double paints from ink, so the pixels agree').toBe(0);
      expect(state.textChanged, 'the fixture lost its text difference').toBe(true);
      const headline = cardCopy(view);
      expect(headline, 'the card prints an all-clear over a real difference').not.toMatch(/matches at this sensitivity/);
      expect(headline).toMatch(/differs in its text/);
      expect(headline).toMatch(/comparing the 1 page both files have/);
      // The loudest figure answers the question this mode asked, while the pixel
      // number it replaced stays published on the same element for the strip match.
      const figure = view.container.querySelector('[data-compare-diff]');
      expect(figure?.textContent?.trim()).toBe('DIFFERS');
      expect(figure?.getAttribute('data-compare-diff')).toBe('0');
    } finally {
      setCompareMode('visual');
    }
  });

  it('says word for word when text mode really finds nothing', async () => {
    setCompareMode('text');
    try {
      const view = await loadPair(await register(WORDY_A), await register(WORDY_A));
      expect(getCompareState().textChanged).toBe(false);
      const headline = cardCopy(view);
      expect(headline).toMatch(/matches word for word/);
      expect(view.container.querySelector('[data-compare-diff]')?.textContent?.trim()).toBe('MATCHES');
      expect(headline, 'a pixel control named as the reason a text answer is clean')
        .not.toMatch(/matches at this sensitivity/);
    } finally {
      setCompareMode('visual');
    }
  });

  it('agrees with itself about a single page: “the 1 page both files have”', async () => {
    const view = await loadPair(await register(WORDY_A), await register(WORDY_A));
    const headline = cardCopy(view);
    expect(headline).toMatch(/comparing the 1 page both files have/);
    expect(headline, 'a singular count carrying a plural verb').not.toMatch(/1 page in common are being checked/);
  });
});
