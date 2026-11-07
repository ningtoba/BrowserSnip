/**
 * Shared harness for the Convert-to-PDF byte tests.
 *
 * Both `edge-convert-to.test.ts` (what the family refuses and admits) and
 * `convert-to-bytes.test.ts` (what the produced bytes actually contain) drive
 * the real tools under jsdom, so they need the same three things: seams for the
 * parts only a browser can do (canvas, image decoding, CDN fonts, pdf.js),
 * fixtures whose dimensions/geometry are real rather than one-pixel, and
 * readers that decode the finished PDF instead of trusting the run summary.
 *
 * Nothing here asserts. A test file that imported this and never looked at the
 * produced bytes would be the exact thing these two files exist to prevent.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import JSZip from 'jszip';
import UTIF from 'utif';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef } from '@maxwbh/pdf-lib';
import type { PDFObject, PDFPage } from '@maxwbh/pdf-lib';
import { pageContentOps, pageContentStreams, streamBytes } from '@/lib/pdf/core/content';
import type { ArrayOperand, NameOperand, NumberOperand, StringOperand } from '@/lib/pdf/core/content';
import { runPdfTool, type RunOutcome } from '@/lib/pdf/tools/runner';
import type { ToolFile, ToolRunContext, ToolValues } from '@/lib/pdf/tools/types';

/* ------------------------------------------------------------------ *
 * Browser seams: the ones jsdom does not provide                     *
 * ------------------------------------------------------------------ */

export const OCR = {
  words: [] as { text: string; x: number; y: number; width: number; height: number }[],
  failWith: null as string | null,
  calls: 0,
};

/** What the canvas shim reports, and how many times white was painted. */
export const CANVAS = { width: 8, height: 10, fills: 0 };

/**
 * The options each `createImageBitmap` call was made with.
 *
 * EXIF orientation is a browser behaviour, so the part this app controls — and
 * the part a test can pin — is that the decoder is explicitly asked for the
 * orientation the photo carries rather than the raw pixel box.
 */
export const DECODE: { calls: ({ imageOrientation?: string } | null)[] } = { calls: [] };

/** A canvas whose box the image routes can measure. */
export function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** The font CDN switches, flipped by the tests that simulate being offline. */
export const FONTS = { cdnReachable: true, monoReachable: true };

const realFetch = globalThis.fetch;

/**
 * Install the canvas, image-decode and font-fetch seams.
 *
 * Called from each file's `beforeAll`; `restoreFetch` belongs in `afterAll` so a
 * later suite in the same worker is not left fetching fixtures.
 */
export function installConvertToEnv(): void {
  const proto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
  proto.getContext = () => ({
    fillStyle: '',
    globalCompositeOperation: '',
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'low',
    filter: 'none',
    globalAlpha: 1,
    save: () => undefined,
    restore: () => undefined,
    clearRect: () => undefined,
    fillRect: () => {
      CANVAS.fills += 1;
    },
    drawImage: () => undefined,
    getImageData: (x: number, y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4),
      width: w,
      height: h,
    }),
    putImageData: () => undefined,
  });
  proto.toBlob = function (this: HTMLCanvasElement, cb: (blob: Blob | null) => void, type?: string) {
    // Report the canvas's own box, so an embedded image can be measured.
    cb(new Blob([realPng(Math.max(1, this.width), Math.max(1, this.height))], { type: type ?? 'image/png' }));
  };
  (globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap = async (
    blob: Blob,
    options?: { imageOrientation?: string },
  ) => {
    DECODE.calls.push(options ?? null);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const dims = readImageDims(bytes) ?? { width: CANVAS.width, height: CANVAS.height, orientation: 1 };
    // What every browser does with `from-image`: hand back the bitmap the way
    // it was shot, not the way the pixels are stored.
    const honour = (options?.imageOrientation ?? 'from-image') === 'from-image';
    const rotated = honour && dims.orientation >= 5 && dims.orientation <= 8;
    return {
      width: rotated ? dims.height : dims.width,
      height: rotated ? dims.width : dims.height,
      close: () => undefined,
    };
  };
  // jsdom only provides `ImageData` alongside a real canvas implementation.
  const images = globalThis as { ImageData?: unknown };
  if (!images.ImageData) {
    class ShimImageData {
      constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
    }
    Object.defineProperty(globalThis, 'ImageData', { value: ShimImageData, configurable: true, writable: true });
  }

  // `core/fonts` fetches faces by URL. Serve the bundled ones from `public/`,
  // and stand in for the script faces so the *embedding* path is exercised
  // rather than stubbed away.
  const face = (file: string) => new Uint8Array(readFileSync(join(process.cwd(), 'public', 'fonts', file)));
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const local = /NotoSans-(Regular|Bold)\.ttf$/.exec(url);
    if (local) return new Response(face(`NotoSans-${local[1]}.ttf`), { headers: { 'content-type': 'font/ttf' } });
    if (/jetbrains-mono/.test(url)) {
      return FONTS.monoReachable
        ? new Response(face('NotoSans-Regular.ttf'), { headers: { 'content-type': 'font/ttf' } })
        : new Response('offline', { status: 404 });
    }
    if (!FONTS.cdnReachable) return new Response('offline', { status: 404 });
    if (/NotoSans(SC|TC|JP|KR)_400Regular\.ttf$/.test(url)) {
      return new Response(face('NotoSans-Regular.ttf'), { headers: { 'content-type': 'font/ttf' } });
    }
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
}

export function resetConvertToEnv(): void {
  OCR.words = [];
  OCR.failWith = null;
  OCR.calls = 0;
  CANVAS.fills = 0;
  FONTS.cdnReachable = true;
  FONTS.monoReachable = true;
  DECODE.calls = [];
}

export function restoreConvertToEnv(): void {
  globalThis.fetch = realFetch;
}

/* ------------------------------------------------------------------ *
 * Real image fixtures                                                  *
 *                                                                      *
 * The converters hand the browser's decoder the bytes it was given, so
 * a fixture that is one pixel wherever it is decoded cannot prove the
 * resolution survived. These builders make small but *valid* PNG, JPEG,
 * BMP, WebP, TIFF and PSD files whose dimensions are the ones the test
 * then looks for in the produced PDF.
 * ------------------------------------------------------------------ */

export const PNG_1PX = realPng(1, 1);

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function crc32(bytes: Uint8Array): number {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (~crc >>> 0) || 0;
}

export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array(4 + data.length);
  for (let i = 0; i < 4; i++) body[i] = type.charCodeAt(i);
  body.set(data, 4);
  const head = new Uint8Array(4);
  new DataView(head.buffer).setUint32(0, data.length);
  return concat(head, body, uint32be(crc32(body)));
}

export function uint32be(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0);
  return bytes;
}

/** An 8-bit RGBA PNG whose IHDR really says `width` × `height`. */
export function realPng(width: number, height: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  const stride = 1 + width * 4;
  const raw = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * stride + 1 + x * 4;
      raw[at] = (x * 31 + y * 7) % 256;
      raw[at + 1] = (y * 13) % 256;
      raw[at + 2] = (x * 5) % 256;
      raw[at + 3] = 255;
    }
  }
  return concat(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', new Uint8Array(deflateSync(raw))),
    pngChunk('IEND', new Uint8Array(0)),
  );
}

/**
 * A JPEG the sniffers and the dimension reader accept, optionally carrying an
 * `Orientation` tag — the EXIF field that says a phone shot it sideways.
 */
export function jpegBytes(width: number, height: number, orientation?: number): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([0xff, 0xd8])];
  if (orientation) {
    const ifd = new Uint8Array(2 + 12 + 4);
    const view = new DataView(ifd.buffer);
    view.setUint16(0, 1, true); // one entry
    view.setUint16(2, 274, true); // Orientation
    view.setUint16(4, 3, true); // SHORT
    view.setUint32(6, 1, true);
    view.setUint16(10, orientation, true);
    view.setUint32(14, 0, true); // no second IFD
    const tiff = concat(
      new Uint8Array([0x49, 0x49, 42, 0, 8, 0, 0, 0]),
      ifd,
    );
    const app1 = concat(new Uint8Array([...Buffer.from('Exif\0', 'latin1'), 0]), tiff);
    const size = new Uint8Array(2);
    new DataView(size.buffer).setUint16(0, app1.length + 2);
    parts.push(new Uint8Array([0xff, 0xe1]), size, app1);
  }
  const sof = new Uint8Array(19);
  const view = new DataView(sof.buffer);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  view.setUint16(2, 17);
  sof[4] = 8; // precision
  view.setUint16(5, height);
  view.setUint16(7, width);
  sof[9] = 1; // one component
  parts.push(sof, new Uint8Array([0xff, 0xd9]));
  return concat(...parts);
}

/** A BMP header with real dimensions (the pixels are not read in jsdom). */
export function bmpBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(54);
  bytes.set(Buffer.from('BM', 'latin1'), 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(18, width, true);
  view.setUint32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  return bytes;
}

/** A lossy WebP (`VP8 ` chunk) whose frame header carries the size. */
export function webpBytes(width: number, height: number): Uint8Array {
  // The chunk payload is a 3-byte frame tag, the `9d 01 2a` start code, then the
  // 14-bit width and height — bytes 6 and 8 of the payload, which is bytes 26
  // and 28 of the file, where `readImageDims` reads them.
  const body = new Uint8Array(10);
  body[3] = 0x9d;
  body[4] = 0x01;
  body[5] = 0x2a;
  const view = new DataView(body.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  const chunk = concat(Buffer.from('VP8 ', 'latin1'), uint32le(body.length), body);
  const riff = concat(Buffer.from('RIFF', 'latin1'), uint32le(4 + chunk.length), Buffer.from('WEBP', 'latin1'), chunk);
  return new Uint8Array(riff);
}

export function uint32le(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
  return bytes;
}

/** A PSD with a flattened PNG preview appended, which is what we read. */
export function psdBytes(width: number, height: number): Uint8Array {
  const header = new Uint8Array(16);
  header.set([0x38, 0x42, 0x50, 0x53]); // `8BPS`
  header[5] = 1; // PSD version 1
  return concat(header, realPng(width, height));
}

/** One raw RGBA frame, packed the way UTIF's own encoder writes it. */
export function tiffFrame(width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  rgba.fill(200);
  return rgba;
}

/** A multi-frame TIFF, built through UTIF so `decodeImagePages` reads it. */
export function tiffBytes(frames: { width: number; height: number }[]): Uint8Array {
  let pixelOffset = 1000;
  const ifds = frames.map((frame) => {
    const offset = pixelOffset;
    pixelOffset += frame.width * frame.height * 4;
    return {
      t256: [frame.width], t257: [frame.height], t258: [8, 8, 8, 8], t259: [1], t262: [2],
      t273: [offset], t277: [4], t278: [frame.height], t279: [frame.width * frame.height * 4],
      t282: [1], t283: [1], t284: [1], t286: [0], t287: [0], t296: [1], t305: ['fixture'], t338: [1],
    };
  });
  const header = new Uint8Array(UTIF.encode(ifds));
  const body = new Uint8Array(pixelOffset);
  body.set(header.subarray(0, Math.min(header.length, pixelOffset)));
  let at = 1000;
  for (const frame of frames) {
    const pixels = tiffFrame(frame.width, frame.height);
    body.set(pixels, at);
    at += pixels.length;
  }
  return body;
}

/** Width, height and EXIF/TIFF orientation of a fixture, read from its bytes. */
export function readImageDims(bytes: Uint8Array): { width: number; height: number; orientation: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // These fixtures are small by construction: a header read that lands outside
  // this window is a parsing mistake in the harness, and handing the canvas shim
  // a 30 000 × 30 000 bitmap would cost gigabytes instead of failing the test.
  const sane = (value: number): number => (value >= 1 && value <= 4096 ? value : NaN);
  const dims = (width: number, height: number, orientation = 1) => {
    const w = sane(width);
    const h = sane(height);
    return Number.isFinite(w) && Number.isFinite(h) ? { width: w, height: h, orientation } : null;
  };
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    return dims(view.getUint32(16), view.getUint32(20));
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return dims(view.getUint32(18, true), view.getUint32(22, true));
  }
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    return dims(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let orientation = 1;
    for (let at = 2; at + 4 < bytes.length;) {
      if (bytes[at] !== 0xff) break;
      const marker = bytes[at + 1];
      const length = view.getUint16(at + 2);
      if (marker === 0xe1 && bytes[at + 4] === 0x45) {
        // `Exif\0\0` then the TIFF block; scan its IFD for tag 274.
        const tiff = at + 10;
        const little = bytes[tiff] === 0x49;
        // Bytes 4..7 of the TIFF block are the offset of the first IFD.
        const ifdAt = tiff + new DataView(bytes.buffer, bytes.byteOffset + tiff + 4, 4).getUint32(0, little);
        const entries = new DataView(bytes.buffer, bytes.byteOffset + ifdAt, 2).getUint16(0, little);
        for (let entry = 0; entry < entries; entry++) {
          const base = ifdAt + 2 + entry * 12;
          const read = new DataView(bytes.buffer, bytes.byteOffset + base, 12);
          if (read.getUint16(0, little) === 274) orientation = read.getUint16(8, little);
        }
      }
      if (marker >= 0xc0 && marker <= 0xc3) {
        // SOF0 from its marker: `ff c0`, 2-byte length, precision, height, width.
        return { width: sane(view.getUint16(at + 7)), height: sane(view.getUint16(at + 5)), orientation };
      }
      at += 2 + length;
    }
    return null;
  }
  return null;
}

/** True when the bytes declare a rotated EXIF orientation (5–8). */
export function exifOrientationOf(bytes: Uint8Array): number {
  return readImageDims(bytes)?.orientation ?? 1;
}

/** RAR magic — the container a `.cbr` really is. */
export const RAR_BYTES = new Uint8Array([...Buffer.from('Rar!\x1a\x07\x01\x00'), 1, 2, 3]);
/** OLE compound-file magic: DOC, XLS, PPT, MSG. */
export const OLE_BYTES = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 1, 2, 3, 4, 5]);
/** A PalmDB header: the `BOOK` type field at offset 60 is what MOBI starts as. */
export function palmBytes(): Uint8Array {
  const bytes = new Uint8Array(256);
  bytes.set(Buffer.from('BOOK'), 60);
  return bytes;
}

/* ------------------------------------------------------------------ *
 * Driving a tool, and reading its output back                        *
 * ------------------------------------------------------------------ */

export function fileFrom(bytes: Uint8Array | string, name: string, type = ''): File {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  // SAFETY: a copy of the bytes is a valid BlobPart.
  return new File([new Uint8Array(data)], name, { type });
}

export async function run(
  id: string,
  values: ToolValues = {},
  files: File[] = [fileFrom('hello', 'source.txt', 'text/plain')],
): Promise<RunOutcome> {
  const outcome = await runPdfTool({ toolId: id, files, values, onProgress: () => {}, onLog: () => {} });
  // A helper does not assert; it hands back the bytes or says why it cannot.
  if (!outcome) throw new Error(`${id} produced no outcome: the runner refused to start the tool.`);
  return outcome;
}

export async function firstPdf(outcome: RunOutcome): Promise<Uint8Array> {
  const [output] = outcome.outputs;
  if (!output) throw new Error('the run reported success but produced no file to open.');
  return new Uint8Array(await output.blob.arrayBuffer());
}

/** A context for the paste path, which the runner still refuses to start (see b5-request R2). */
export function contextFor(values: ToolValues, files: File[] = []): ToolRunContext {
  const inputs: ToolFile[] = files.map((file) => ({
    name: file.name,
    size: file.size,
    type: file.type,
    bytes: async () => new Uint8Array(await file.arrayBuffer()),
    blob: () => file.slice(0, file.size, file.type || 'application/octet-stream'),
  }));
  return {
    inputs,
    values,
    progress: () => undefined,
    log: () => undefined,
    signal: new AbortController().signal,
  };
}

/** The `/ToUnicode` CMap of an embedded face, as glyph code → Unicode. */
export function parseToUnicode(bytes: Uint8Array): Map<number, number> {
  const text = new TextDecoder('latin1').decode(bytes);
  const map = new Map<number, number>();
  const code = (hex: string) => Number.parseInt(hex, 16);
  const asString = (hex: string) => {
    let out = '';
    for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(code(hex.slice(i, i + 4)));
    return out;
  };
  for (const block of text.split(/beginbfchar|endbfchar/)) {
    for (const [, from, to] of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const point = asString(to).codePointAt(0);
      if (point !== undefined) map.set(code(from), point);
    }
  }
  return map;
}

export function pageFonts(doc: PDFDocument, page: PDFPage) {
  const resources = page.node.Resources();
  const fonts = resources instanceof PDFDict ? resources.get(PDFName.of('Font')) : undefined;
  const fontDict = fonts instanceof PDFRef ? doc.context.lookup(fonts, PDFDict) : fonts;
  if (!(fontDict instanceof PDFDict)) return [];
  return fontDict
    .entries()
    .map(([name, value]) => ({
      name: name.asString().replace(/^\//, ''),
      dict: (value instanceof PDFRef ? doc.context.lookup(value, PDFDict) : value) as PDFDict | undefined,
    }))
    .filter((entry): entry is { name: string; dict: PDFDict } => entry.dict instanceof PDFDict)
    .map((entry) => {
      const subtype = entry.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString() ?? '';
      const toUnicode = entry.dict.get(PDFName.of('ToUnicode'));
      const stream = toUnicode instanceof PDFRef ? doc.context.lookup(toUnicode) : toUnicode;
      return {
        name: entry.name,
        dict: entry.dict,
        subtype,
        // Identity CID fonts are two-byte coded; simple fonts one byte.
        codeSize: subtype === '/Type0' ? 2 : 1,
        unicode: stream ? parseToUnicode(streamBytes(stream as never)) : undefined,
      };
    });
}

/** Collapse the run boundaries a writer chooses into readable text. */
export function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Like `squash` with every space removed, for pages whose text is shown one
 * glyph per operator (the RTF route does that), where the gaps between runs are
 * advances rather than spaces.
 */
export function compact(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase();
}

/**
 * The text a viewer can select, with where each run was drawn.
 *
 * Decoded from the page's own content streams through its own font resources,
 * which is the same information a viewer uses. `core/content`'s `textRects` is
 * the in-app reader but reports one glyph per run for text this app wrote
 * (docs/tasks/b5-request.md R3), so it cannot prove selectability here.
 *
 * The position matters as much as the string: two values on the same baseline at
 * different `x` are two table cells, and one `x` is one column.
 */
export interface TextRun {
  page: number;
  x: number;
  y: number;
  text: string;
  /** The font resource the run is drawn with, so a heading can be told from body text. */
  font: string;
  /** Size in points from the same `Tf`, which is what makes a heading bigger. */
  size: number;
  /** True for the first run after a `BT`, which is where a viewer starts a line. */
  startsTextObject: boolean;
}

export function textRunsOf(doc: PDFDocument): TextRun[] {
  const runs: TextRun[] = [];
  doc.getPages().forEach((page, pageIndex) => {
    const fonts = new Map(pageFonts(doc, page).map((font) => [font.name, font]));
    let current: ReturnType<typeof pageFonts>[number] | undefined;
    let currentName = '';
    let size = 0;
    let x = 0;
    let y = 0;
    let leading = 0;
    let starts = true;
    for (const op of pageContentOps(page)) {
      const numbers = op.operands
        .filter((operand): operand is NumberOperand => operand.kind === 'number')
        .map((operand) => operand.value);
      if (op.name === 'BT') {
        starts = true;
        continue;
      }
      if (op.name === 'TL' && numbers.length === 1) leading = numbers[0];
      if (op.name === 'Tm' && numbers.length >= 6) {
        x = numbers[4];
        y = numbers[5];
        continue;
      }
      if ((op.name === 'Td' || op.name === 'TD') && numbers.length >= 2) {
        x += numbers[0];
        y += numbers[1];
        continue;
      }
      if (op.name === 'T*' && leading !== 0) {
        y -= leading;
        continue;
      }
      if (op.name === 'Tf') {
        const name = op.operands.find((operand): operand is NameOperand => operand.kind === 'name');
        current = name ? fonts.get(name.value) : undefined;
        currentName = current?.name ?? '';
        size = numbers[0] ?? 0;
        continue;
      }
      if (!['Tj', 'TJ', "'", '"'].includes(op.name)) continue;
      const strings = op.operands.flatMap((operand) => {
        if (operand.kind === 'string') return [operand as StringOperand];
        if (operand.kind === 'array') {
          return (operand as ArrayOperand).items.filter((item) => item.kind === 'string') as StringOperand[];
        }
        return [];
      });
      for (const value of strings) {
        let text = '';
        if (current?.codeSize === 2) {
          for (let i = 0; i + 1 < value.bytes.length; i += 2) {
            const point = current.unicode?.get((value.bytes[i] << 8) | value.bytes[i + 1]);
            text += point ? String.fromCodePoint(point) : '';
          }
        } else {
          for (const byte of value.bytes) text += String.fromCharCode(byte);
        }
        runs.push({ page: pageIndex, x, y, text, font: currentName, size, startsTextObject: starts });
        starts = false;
      }
    }
  });
  return runs;
}

export async function textRuns(bytes: Uint8Array): Promise<TextRun[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return textRunsOf(doc);
}

export async function extractText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages: string[][] = doc.getPages().map(() => []);
  for (const run of textRunsOf(doc)) {
    pages[run.page]!.push((run.startsTextObject ? '\n' : '') + run.text);
  }
  return pages.map((parts) => parts.join('')).join('\n');
}

/* ------------------------------------------------------------------ *
 * Reading geometry back out of the produced bytes                     *
 * ------------------------------------------------------------------ */

/** Every page box in the file, rounded to hundredths of a point. */
export async function pageSizes(bytes: Uint8Array): Promise<Array<[number, number]>> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc.getPages().map((page) => {
    const { width, height } = page.getSize();
    return [Math.round(width * 100) / 100, Math.round(height * 100) / 100] as [number, number];
  });
}

export interface PlacedImage {
  name: string;
  /** `Image` for a raster, `Form` for an embedded page (two-up sheets). */
  kind: string;
  /** The pixel box stored in the image itself. */
  pixels: [number, number];
  /** Where the page draws it: `[x, y, width, height]` in points. */
  box: [number, number, number, number];
}

/** The raster and form XObjects one page draws, with placed size. */
/**
 * Follow one indirect reference to the dictionary that describes it.
 *
 * An embedded image is a stream object, so its `/Subtype`, `/Width` and `/Height`
 * live on the stream's dictionary rather than on the object a typed lookup of
 * `PDFDict` would return — asking for the wrong type throws instead of reading.
 */
function asDict(doc: PDFDocument, value: PDFObject | undefined): PDFDict | undefined {
  const looked = value instanceof PDFRef ? doc.context.lookup(value) : value;
  const holder = looked instanceof PDFRawStream ? looked.dict : looked;
  return holder instanceof PDFDict ? holder : undefined;
}

export function placedImages(doc: PDFDocument, pageIndex: number): PlacedImage[] {
  const page = doc.getPages()[pageIndex]!;
  const resources = page.node.Resources();
  const dict = asDict(doc, resources instanceof PDFDict ? resources.get(PDFName.of('XObject')) : undefined);
  const stored = new Map<string, [string, [number, number]]>();
  if (dict instanceof PDFDict) {
    for (const [name, value] of dict.entries()) {
      const image = asDict(doc, value);
      if (!(image instanceof PDFDict)) continue;
      const subtype = image.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString().replace(/^\//, '') ?? '';
      if (subtype !== 'Image' && subtype !== 'Form') continue;
      const width = image.lookupMaybe(PDFName.of('Width'), PDFNumber)?.asNumber();
      const height = image.lookupMaybe(PDFName.of('Height'), PDFNumber)?.asNumber();
      const box = image.lookupMaybe(PDFName.of('BBox'), PDFArray);
      const rect = box?.size() === 4 ? box.asRectangle() : undefined;
      const size: [number, number] = width !== undefined && height !== undefined
        ? [width, height]
        : [rect?.width ?? 0, rect?.height ?? 0];
      stored.set(name.asString().replace(/^\//, ''), [subtype, size]);
    }
  }
  const out: PlacedImage[] = [];
  // `drawImage` nests its transform (`translate`, then `scale`), so the placed
  // box is the product of every pending `cm`, not the last one written.
  let matrix = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  const multiply = (m: number[], n: number[]): number[] => [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
  for (const op of pageContentOps(page)) {
    const numbers = op.operands
      .filter((operand): operand is NumberOperand => operand.kind === 'number')
      .map((operand) => operand.value);
    if (op.name === 'q') stack.push([...matrix]);
    if (op.name === 'Q') matrix = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    if (op.name === 'cm' && numbers.length >= 6) matrix = multiply(matrix, numbers.slice(0, 6));
    if (op.name !== 'Do') continue;
    const name = op.operands.find((operand): operand is NameOperand => operand.kind === 'name');
    if (!name) continue;
    const [kind, pixels] = stored.get(name.value) ?? ['Unknown', [0, 0] as [number, number]];
    out.push({
      name: name.value,
      kind,
      pixels,
      box: [matrix[4], matrix[5], matrix[0] || pixels[0], matrix[3] || pixels[1]],
    });
  }
  return out;
}

export async function imagesPerPage(bytes: Uint8Array): Promise<PlacedImage[][]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc.getPages().map((_, index) => placedImages(doc, index));
}

/* ------------------------------------------------------------------ *
 * Fixtures: real containers, built here                              *
 * ------------------------------------------------------------------ */


/**
 * `core/archive`'s `createZip` flattens entry names for download archives, so an
 * OPC package (DOCX/PPTX/EPUB/XPS/ODF) is zipped with JSZip to keep its paths.
 */
export async function zipBytes(entries: { name: string; data: string | Uint8Array }[]): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const entry of entries) zip.file(entry.name, entry.data);
  return new Uint8Array(await zip.generateAsync({ type: 'arraybuffer' }));
}

export const XML = '<?xml version="1.0" encoding="UTF-8"?>';

export function docxBytes(body = '<w:p><w:r><w:t>Quarterly numbers in the body text</w:t></w:r></w:p>'): Promise<Uint8Array> {
  return zipBytes([
    {
      name: '[Content_Types].xml',
      data: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    },
    {
      name: '_rels/.rels',
      data: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    },
    {
      name: 'word/document.xml',
      data: `${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    },
  ]);
}

export const ODF_NS = [
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"',
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"',
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
  'xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"',
].join(' ');

export function odtBytes(paragraphs: string[]): Promise<Uint8Array> {
  return zipBytes([
    {
      name: 'content.xml',
      data:
        `${XML}<office:document-content ${ODF_NS}><office:body><office:text>` +
        paragraphs.map((text) => `<text:p>${text}</text:p>`).join('') +
        '</office:text></office:body></office:document-content>',
    },
  ]);
}

export function odsBytes(rows: string[][]): Promise<Uint8Array> {
  return zipBytes([
    {
      name: 'content.xml',
      data:
        `${XML}<office:document-content ${ODF_NS}><office:body><office:spreadsheet><table:table table:name="Budget">` +
        rows.map((row) => `<table:table-row>${row.map((cell) => `<table:table-cell><text:p>${cell}</text:p></table:table-cell>`).join('')}</table:table-row>`).join('') +
        '</table:table></office:spreadsheet></office:body></office:document-content>',
    },
  ]);
}

/**
 * `draw:shape` rather than the `draw:frame` LibreOffice writes: the reader in
 * `core/office-in` only walks `shape` elements, so a real deck yields no text and
 * the tool refuses instead of shipping blank slides (docs/tasks/b5-request.md R6).
 */
export function odpBytes(slides: { title: string; body: string }[]): Promise<Uint8Array> {
  return zipBytes([
    {
      name: 'content.xml',
      data:
        `${XML}<office:document-content ${ODF_NS}><office:body><office:presentation>` +
        slides
          .map(
            (slide) =>
              '<draw:page>' +
              `<draw:frame><draw:shape presentation:presentationclass="title"><draw:text-box><text:p>${slide.title}</text:p></draw:text-box></draw:shape></draw:frame>` +
              `<draw:frame><draw:shape><draw:text-box><text:p>${slide.body}</text:p></draw:text-box></draw:shape></draw:frame></draw:page>`,
          )
          .join('') +
        '</office:presentation></office:body></office:document-content>',
    },
  ]);
}

export function pptxBytes(slides: string[]): Promise<Uint8Array> {
  return zipBytes(
    slides.map((text, index) => ({
      name: `ppt/slides/slide${index + 1}.xml`,
      data:
        `${XML}<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    })),
  );
}

export function epubBytes(chapters: string[]): Promise<Uint8Array> {
  return zipBytes([
    {
      name: 'META-INF/container.xml',
      data: `${XML}<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    },
    {
      name: 'OEBPS/content.opf',
      data:
        `${XML}<package xmlns="http://www.idpf.org/2007/opf"><manifest>` +
        chapters.map((_, index) => `<item id="c${index}" href="chapter${index + 1}.xhtml" media-type="application/xhtml+xml"/>`).join('') +
        '</manifest><spine>' +
        chapters.map((_, index) => `<itemref idref="c${index}"/>`).join('') +
        '</spine></package>',
    },
    ...chapters.map((text, index) => ({
      name: `OEBPS/chapter${index + 1}.xhtml`,
      data: `${XML}<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Chapter ${index + 1}</h1><p>${text}</p></body></html>`,
    })),
  ]);
}

/** Lowercase `glyphs` for the same reason as the ODP fixture above (R6). */
export function xpsBytes(pages: string[]): Promise<Uint8Array> {
  return zipBytes(
    pages.map((text, index) => ({
      name: `FixedDoc01/Pages/Page${index + 1}.fpage`,
      data: `${XML}<FixedPage xmlns="http://schemas.microsoft.com/xps/2005/06" Width="800" Height="1000"><glyphs UnicodeString="${text}" Indices="0" Size="12" BidiLevel="0"/></FixedPage>`,
    })),
  );
}

export const cbzBytes = (pages: number) =>
  zipBytes(Array.from({ length: pages }, (_, index) => ({ name: `page${index + 1}.png`, data: PNG_1PX })));

export async function workbookBytes(): Promise<Uint8Array> {
  const XLSX = await import('xlsx');
  const sheet = XLSX.utils.aoa_to_sheet([
    ['Item', 'Qty', 'Price'],
    ['Widget', 3, 9.99],
    ['Gizmo', 12, 4.5],
  ]);
  sheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Sales');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([]), 'Empty');
  return new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

export async function pdfBytes(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage();
  return new Uint8Array(await doc.save());
}

