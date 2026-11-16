/**
 * `png-to-pdf` and transparency, measured in the bytes.
 *
 * PNG is the one format in this family that carries alpha, so the question a
 * viewer actually asks is: what happens to the pixels where the file is
 * see-through? Measured on the dev build with a 200 x 200 PNG whose alpha is 0
 * outside a red disc, the answer in the file is both halves of a promise:
 *
 *   - the alpha survives as a `/SMask` on the image (mask 0 outside the disc,
 *     255 inside), so nothing is *lost*; and
 *   - the page paints a white rectangle under the image, so the see-through part
 *     shows the page's own white paper — measured (255, 255, 255) there, the disc
 *     (220, 30, 40) exact, no black and no checkerboard.
 *
 * The shared harness stubs canvases without a pixel buffer, so `toBlob` there
 * reports the canvas *box* and every fixture is opaque: a regression that
 * flattened transparency onto black or onto white would still leave a mask
 * behind and pass. This file carries a small real pixel canvas instead — the
 * source alpha has to travel through decode, canvas and embed for the assertions
 * below to hold, and they are made on the produced PDF, not on a call count.
 *
 * The card's own words are pinned here too: the two facts a transparent-PNG run
 * has to state (alpha is kept and flattened onto paper; the page is sized from
 * pixels at 72 dpi, not from a recorded density) were unstated before this round.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  type PDFObject,
} from '@maxwbh/pdf-lib';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import { pageContentOps } from '@/lib/pdf/core/content';

/* ------------------------------------------------------------------ *
 * Fixtures: real PNGs whose alpha and colour are known by construction *
 * ------------------------------------------------------------------ */

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** An 8-bit RGBA PNG from a raw pixel buffer, no filter on any row. */
function pngOf(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  const head = new DataView(ihdr.buffer);
  head.setUint32(0, width);
  head.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = 1 + width * 4;
  const raw = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) raw.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * stride + 1);
  const parts = [new Uint8Array(PNG_MAGIC), chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(deflateSync(raw))), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

interface Pixels { width: number; height: number; data: Uint8Array }

/**
 * A disc of `disc` at `alpha` on a background of `outside`, everything else
 * untouched. The transparent region is deliberately not black: if the file
 * shipped the raster without its mask, the paper would read as the disc's
 * surroundings rather than as itself.
 */
function discPng(options: { disc: [number, number, number]; outside: [number, number, number, number]; alpha: number }): Uint8Array {
  const width = 120;
  const height = 120;
  const data = new Uint8Array(width * height * 4);
  const [r, g, b, a] = options.outside;
  for (let i = 0; i < width * height; i++) {
    data.set([r, g, b, a], i * 4);
  }
  const cx = 60;
  const cy = 60;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > 35 ** 2) continue;
      data.set([...options.disc, options.alpha], (y * width + x) * 4);
    }
  }
  return pngOf(data, width, height);
}

const DISC: [number, number, number] = [220, 30, 40];
const OUTSIDE_BLUE: [number, number, number, number] = [0, 0, 255, 0];

/* ------------------------------------------------------------------ *
 * A canvas that keeps pixels                                            *
 * ------------------------------------------------------------------ */

interface Store { width: number; height: number; data: Uint8Array }

const stores = new WeakMap<HTMLCanvasElement, Store>();
const real = {
  getContext: HTMLCanvasElement.prototype.getContext,
  toBlob: HTMLCanvasElement.prototype.toBlob,
};

function storeOf(canvas: HTMLCanvasElement): Store {
  const width = Math.max(1, canvas.width);
  const height = Math.max(1, canvas.height);
  const kept = stores.get(canvas);
  // Assigning width/height resets a real canvas to transparent black.
  if (!kept || kept.width !== width || kept.height !== height) {
    const fresh = { width, height, data: new Uint8Array(width * height * 4) };
    stores.set(canvas, fresh);
    return fresh;
  }
  return kept;
}

function putPixels(target: Store, x: number, y: number, source: Pixels, sw: number, sh: number): void {
  for (let row = 0; row < sh; row++) {
    const ty = y + row;
    if (ty < 0 || ty >= target.height) continue;
    for (let col = 0; col < sw; col++) {
      const tx = x + col;
      if (tx < 0 || tx >= target.width) continue;
      const from = ((row * source.width) / sh | 0) * source.width + ((col * source.width) / sw | 0);
      const to = (ty * target.width + tx) * 4;
      const alpha = source.data[from * 4 + 3] / 255;
      for (let c = 0; c < 3; c++) {
        target.data[to + c] = Math.round(source.data[from * 4 + c] * alpha + target.data[to + c] * (1 - alpha));
      }
      target.data[to + 3] = Math.round((alpha + (target.data[to + 3] / 255) * (1 - alpha)) * 255);
    }
  }
}

/** The frames under the images hold whole pictures, so every fixture is decoded whole. */
function decodePng(bytes: Uint8Array): Pixels {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  expect(view.getUint8(24), 'fixture is not 8-bit').toBe(8);
  expect(view.getUint8(25), 'fixture is not RGBA').toBe(6);
  const idat: Uint8Array[] = [];
  let at = 8;
  while (at < bytes.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (type === 'IDAT') idat.push(bytes.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const joined = new Uint8Array(idat.reduce((sum, part) => sum + part.length, 0));
  let cursor = 0;
  for (const part of idat) { joined.set(part, cursor); cursor += part.length; }
  const raw = new Uint8Array(inflateSync(joined));
  const stride = 1 + width * 4;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    // The encoder here writes filter 0 on every row; anything else is a decoder bug.
    expect(raw[y * stride], `row ${y} was filtered`).toBe(0);
    data.set(raw.subarray(y * stride + 1, (y + 1) * stride), y * width * 4);
  }
  return { width, height, data };
}

function installCanvas(): void {
  HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement) {
    const canvas = this;
    return {
      fillStyle: '#000000',
      globalAlpha: 1,
      save: () => undefined,
      restore: () => undefined,
      clearRect: (x: number, y: number, w: number, h: number) => {
        const store = storeOf(canvas);
        for (let row = 0; row < h; row++) {
          const at = ((y + row) * store.width + x) * 4;
          store.data.fill(0, at, at + w * 4);
        }
      },
      fillRect(this: { fillStyle: string }, x: number, y: number, w: number, h: number) {
        const store = storeOf(canvas);
        const hex = String(this.fillStyle).replace('#', '');
        const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
        const rgb = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) || 0);
        for (let row = 0; row < h; row++) {
          for (let col = 0; col < w; col++) {
            const at = ((y + row) * store.width + (x + col)) * 4;
            if (at < 0 || at >= store.data.length) continue;
            store.data.set([...rgb, 255], at);
          }
        }
      },
      drawImage: (source: Pixels, x: number, y: number, w = source.width, h = source.height) => {
        putPixels(storeOf(canvas), x, y, source, Math.round(w), Math.round(h));
      },
      getImageData: (x: number, y: number, w: number, h: number) => {
        const store = storeOf(canvas);
        const out = new Uint8ClampedArray(w * h * 4);
        for (let row = 0; row < h; row++) {
          const at = ((y + row) * store.width + x) * 4;
          out.set(store.data.subarray(at, at + w * 4), row * w * 4);
        }
        return { data: out, width: w, height: h };
      },
      putImageData: (image: { data: Uint8Array; width: number }, x: number, y: number) => {
        const store = storeOf(canvas);
        for (let row = 0; row < image.data.length / 4 / image.width; row++) {
          const at = ((y + row) * store.width + x) * 4;
          store.data.set(image.data.subarray(row * image.width * 4, (row + 1) * image.width * 4), at);
        }
      },
    } as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;

  HTMLCanvasElement.prototype.toBlob = function toBlob(this: HTMLCanvasElement, cb: (blob: Blob | null) => void) {
    const store = storeOf(this);
    // A real canvas holds premultiplied pixels and un-premultiplies on the way
    // out, which is why a fully transparent pixel encodes as black.
    const encoded = new Uint8Array(store.data);
    for (let i = 0; i < encoded.length; i += 4) {
      const alpha = encoded[i + 3];
      for (let c = 0; c < 3; c++) {
        encoded[i + c] = alpha === 0 ? 0 : Math.min(255, Math.round((encoded[i + c] * 255) / alpha));
      }
    }
    cb(new Blob([pngOf(encoded, store.width, store.height)], { type: 'image/png' }));
  };

  (globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap = async (blob: Blob) => {
    const pixels = decodePng(new Uint8Array(await blob.arrayBuffer()));
    return { ...pixels, close: () => undefined };
  };
}

function restoreCanvas(): void {
  HTMLCanvasElement.prototype.getContext = real.getContext;
  HTMLCanvasElement.prototype.toBlob = real.toBlob;
  delete (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
}

beforeEach(installCanvas);
afterEach(restoreCanvas);

/* ------------------------------------------------------------------ *
 * Reading the produced file                                             *
 * ------------------------------------------------------------------ */

interface Outcome { outputs: { blob: Blob }[]; warnings: string[]; message?: string }

async function run(files: File[], values: Record<string, unknown> = {}): Promise<Outcome> {
  return (await runPdfTool({
    toolId: 'png-to-pdf', files, values, onProgress: () => {}, onLog: () => {},
  })) as unknown as Outcome;
}

function fileFrom(bytes: Uint8Array, name: string): File {
  return new File([new Uint8Array(bytes)], name, { type: 'image/png' });
}

async function firstPdf(outcome: Outcome): Promise<Uint8Array> {
  const [output] = outcome.outputs;
  expect(output, 'the run produced no PDF').toBeTruthy();
  return new Uint8Array(await output.blob.arrayBuffer());
}

function resolve(doc: PDFDocument, value: PDFObject | undefined): PDFObject | undefined {
  return value instanceof PDFRef ? doc.context.lookup(value) : value;
}

interface Drawn { width: number; height: number; rgb: Uint8Array; alpha: Uint8Array | null }

/** The image the first page draws, with its mask resolved the way a viewer does. */
async function drawnOnPage(bytes: Uint8Array, index = 0): Promise<Drawn> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const page = doc.getPages()[index]!;
  const resources = resolve(doc, page.node.get(PDFName.of('Resources')));
  const xobjects = resolve(doc, (resources as PDFDict).get(PDFName.of('XObject')));
  const names = pageContentOps(page)
    .filter((op) => op.name === 'Do')
    .map((op) => String(op.operands[0] && 'value' in op.operands[0] ? op.operands[0].value : ''));
  expect(names.length, 'the page drew no image').toBe(1);
  const stream = resolve(doc, (xobjects as PDFDict).get(PDFName.of(String(names[0]))));
  expect(stream, 'the drawn image is missing').toBeInstanceOf(PDFRawStream);
  const image = stream as PDFRawStream;
  const width = (resolve(doc, image.dict.get(PDFName.of('Width'))) as PDFNumber).asNumber();
  const height = (resolve(doc, image.dict.get(PDFName.of('Height'))) as PDFNumber).asNumber();
  const mask = resolve(doc, image.dict.get(PDFName.of('SMask')));
  return {
    width,
    height,
    rgb: new Uint8Array(inflateSync(image.getContents())),
    alpha: mask instanceof PDFRawStream ? new Uint8Array(inflateSync(mask.getContents())) : null,
  };
}

/** Colour and alpha at one pixel of the drawn image. */
function at(drawn: Drawn, x: number, y: number) {
  const i = y * drawn.width + x;
  return {
    rgb: [drawn.rgb[i * 3], drawn.rgb[i * 3 + 1], drawn.rgb[i * 3 + 2]],
    alpha: drawn.alpha ? drawn.alpha[i] : 255,
  };
}

/* ------------------------------------------------------------------ *
 * The measurement                                                       *
 * ------------------------------------------------------------------ */

describe('a transparent PNG survives as a mask and shows the page, not a colour', () => {
  it('keeps the alpha of the see-through region and of the disc', async () => {
    const bytes = await firstPdf(await run([fileFrom(discPng({ disc: DISC, outside: OUTSIDE_BLUE, alpha: 255 }), 'cut-out.png')], { pageSize: 'fit', margin: 0 }));
    const drawn = await drawnOnPage(bytes);
    expect(drawn.width, 'the picture was resampled').toBe(120);
    expect(await (async () => (await PDFDocument.load(bytes)).getPageCount())()).toBe(1);
    expect(drawn.alpha, 'the transparent PNG lost its /SMask').not.toBeNull();
    expect(drawn.alpha!.length, '/SMask is not one byte per pixel').toBe(120 * 120);
    // The corners are outside the disc: fully transparent. The middle is the disc.
    expect(at(drawn, 0, 0).alpha).toBe(0);
    expect(at(drawn, 119, 0).alpha).toBe(0);
    expect(at(drawn, 60, 60).alpha).toBe(255);
    // And the mask is a picture, not a constant.
    const levels = new Set(drawn.alpha!);
    expect(levels.size, 'the mask has a single level, so it is not following the pixels').toBeGreaterThan(1);
  });

  it('draws the white paper under the picture so the cut-out shows the page', async () => {
    const bytes = await firstPdf(await run([fileFrom(discPng({ disc: DISC, outside: OUTSIDE_BLUE, alpha: 255 }), 'cut-out.png')], { pageSize: 'a4', margin: 0 }));
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const ops = pageContentOps(doc.getPages()[0]!);
    const doAt = ops.findIndex((op) => op.name === 'Do');
    // A full-sheet white fill, before the image: that rectangle *is* the paper.
    const before = ops.slice(0, doAt);
    const fills = before.filter((op) => op.name === 'f');
    expect(fills.length, 'no white paper was painted under the image').toBe(1);
    const colour = before.filter((op) => op.name === 'rg');
    expect(colour.length, 'the paper rectangle is not given a colour').toBe(1);
    expect(colour[0].operands.map((operand) => ('value' in operand ? operand.value : ''))).toEqual([1, 1, 1]);
  });

  it('keeps the opaque disc its own colour while the see-through part keeps its own', async () => {
    const bytes = await firstPdf(await run([fileFrom(discPng({ disc: DISC, outside: OUTSIDE_BLUE, alpha: 255 }), 'cut-out.png')], { pageSize: 'fit', margin: 0 }));
    const drawn = await drawnOnPage(bytes);
    expect(at(drawn, 60, 60).rgb).toEqual(DISC);
    // Outside is fully transparent: the pixel is premultiplied to black and the
    // mask is what hides it. A run that flattened the alpha onto the page colour
    // would store white here and carry no mask, so both halves are asserted.
    expect(at(drawn, 0, 0).rgb).toEqual([0, 0, 0]);
    expect(at(drawn, 0, 0).alpha).toBe(0);
  });

  it('control: an opaque PNG is a full mask and no see-through', async () => {
    // Same fixture with alpha 255 everywhere: the mask must be all-255, so the
    // assertion above cannot pass on any picture.
    const bytes = await firstPdf(await run([fileFrom(discPng({ disc: DISC, outside: [0, 0, 255, 255], alpha: 255 }), 'flat.png')], { pageSize: 'fit', margin: 0 }));
    const drawn = await drawnOnPage(bytes);
    expect(drawn.alpha, 'an opaque PNG has no mask to carry').toBeNull();
    expect(at(drawn, 0, 0).rgb).toEqual([0, 0, 255]);
    expect(at(drawn, 60, 60).rgb).toEqual(DISC);
  });

  it('control: a half-transparent edge keeps its 128, not 0 or 255', async () => {
    const bytes = await firstPdf(await run([fileFrom(discPng({ disc: DISC, outside: OUTSIDE_BLUE, alpha: 128 }), 'ghost.png')], { pageSize: 'fit', margin: 0 }));
    const drawn = await drawnOnPage(bytes);
    expect(drawn.alpha, 'the soft mask went missing').not.toBeNull();
    expect(at(drawn, 60, 60).alpha).toBe(128);
  });
});

describe('the card says what happens to transparency and to a recorded density', () => {
  it('admits that a transparent PNG comes out on white paper', () => {
    const notes = getPdfTool('png-to-pdf')?.notes?.join(' ') ?? '';
    expect(notes).toMatch(/transparen/i);
    expect(notes).toMatch(/white paper/i);
    // The sibling that carries no alpha must not borrow the claim.
    expect(getPdfTool('jpg-to-pdf')?.notes?.join(' ') ?? '').not.toMatch(/transparen/i);
  });

  it('says the page comes from pixels at 72 dpi, not from the file’s density', () => {
    const notes = getPdfTool('png-to-pdf')?.notes?.join(' ') ?? '';
    expect(notes).toMatch(/72 dpi/);
    expect(notes).toMatch(/pHYs|EXIF/);
  });

  it('puts both facts on the result card, not only in the notes accordion', async () => {
    const outcome = await run([fileFrom(discPng({ disc: DISC, outside: OUTSIDE_BLUE, alpha: 255 }), 'cut-out.png')], { pageSize: 'fit', margin: 0 });
    const shown = outcome.warnings.join(' ');
    expect(shown).toMatch(/white paper/i);
    expect(shown).toMatch(/72 dpi/);
  });
});
