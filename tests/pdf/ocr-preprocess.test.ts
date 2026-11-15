/**
 * `preprocessForOcr` on nearly-uniform and uniform sheets.
 *
 * The recogniser path is `preprocessForOcr` → `recognizeCanvas`, and the function
 * stretch-maps every page between its own darkest and lightest pixel. Two
 * canvases can go wrong where an ordinary scan cannot, so both are pinned here
 * against a real measurement (`docs/research/ocr-faint-line-probe.mjs`, which ran
 * ten canvases through the shipped engine in Chromium):
 *
 * - a sheet that is *nearly* uniform with one faint line is read at every
 *   contrast tried, 250/255 (a 2 % difference, invisible to a 243 cutoff) through
 *   180/255: the stretch is what saves it, so a "fix" that skips the stretch on a
 *   low-contrast page would cost the line;
 * - a sheet that is *exactly* uniform comes out solid black, because the divisor
 *   `|| 1` maps a zero span to zero. The model is unharmed — its normalisation
 *   is a fixed mean/std shift, so a constant field is a constant tensor, and the
 *   probe read 0 lines on both a white and a grey sheet — but the trap is real:
 *   the preprocessed bitmap of a blank page is 100 % ink.
 *
 * jsdom has no canvas, so this file installs one: pixels are a tone field and the
 * 2-D context is a buffer in memory. The `contrast(1.15)` sharpen step is a
 * `filter`ed self-draw and is a no-op under that double, so no assertion here
 * depends on it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { preprocessForOcr } from '@/lib/ocr/engine';

interface FakePixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** A context over a pixel buffer; `drawImage` copies a source buffer if it has one. */
function contextFor(pixels: Uint8ClampedArray): Record<string, unknown> {
  return {
    filter: 'none',
    drawImage: (source: { __pixels?: Uint8ClampedArray }) => {
      if (source.__pixels) pixels.set(source.__pixels);
    },
    getImageData: (_x: number, _y: number, w: number, h: number): FakePixels => ({
      data: pixels.slice(0, w * h * 4),
      width: w,
      height: h,
    }),
    putImageData: (image: FakePixels) => pixels.set(image.data),
  };
}

/** A canvas of `tone(x, y)` grey pixels, opaque. */
function sheet(width: number, height: number, tone: (x: number, y: number) => number): HTMLCanvasElement {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const level = tone(x, y);
      const at = (y * width + x) * 4;
      pixels[at] = level;
      pixels[at + 1] = level;
      pixels[at + 2] = level;
      pixels[at + 3] = 255;
    }
  }
  const canvas = { width, height, __pixels: pixels, getContext: () => contextFor(pixels) };
  return canvas as unknown as HTMLCanvasElement;
}

const W = 200;
const H = 100;
/** One 12 px band of `ink` tone across the middle of the sheet. */
const line = (paper: number, ink: number) => sheet(W, H, (_x, y) => (y >= 44 && y < 56 ? ink : paper));

function pixelsOf(canvas: HTMLCanvasElement): Uint8ClampedArray {
  const ctx = canvas.getContext('2d') as unknown as { getImageData: (x: number, y: number, w: number, h: number) => FakePixels };
  return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
}

const luma = (data: Uint8ClampedArray, index: number) =>
  0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2];

/** How many pixels sit at or below `cut`, and what the lightest/darkest are. */
function count(data: Uint8ClampedArray, cut: number): { dark: number; min: number; max: number } {
  let dark = 0;
  let min = 255;
  let max = 0;
  for (let i = 0; i < data.length; i += 4) {
    const value = luma(data, i);
    if (value <= cut) dark += 1;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { dark, min, max };
}

const realGetContext = HTMLCanvasElement.prototype.getContext;
afterEach(() => {
  HTMLCanvasElement.prototype.getContext = realGetContext;
});

/** Every canvas `preprocessForOcr` makes is backed by its own buffer, kept. */
function installCanvas(): void {
  const owned = new WeakMap<HTMLCanvasElement, Record<string, unknown>>();
  HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement) {
    let ctx = owned.get(this);
    if (!ctx) {
      ctx = contextFor(new Uint8ClampedArray(this.width * this.height * 4));
      owned.set(this, ctx);
    }
    return ctx as unknown as CanvasRenderingContext2D;
  } as unknown as HTMLCanvasElement['getContext'];
}

describe('preprocessForOcr on a faint line', () => {
  it('keeps a 2 % line — invisible to any threshold on the raw sheet — at full contrast', () => {
    installCanvas();
    const source = line(255, 250);
    // The instrument first: on the raw sheet a 243 cutoff finds nothing at all.
    expect(count(pixelsOf(source), 243).dark).toBe(0);

    const out = pixelsOf(preprocessForOcr(source));
    const band = W * 12;
    // The stretch puts the paper at white and the line at black, and the number
    // of black pixels is the band's own area (~1 200), not a handful of edges.
    expect(count(out, 245).max).toBe(255);
    expect(count(out, 8).dark).toBeGreaterThan(band * 0.6);
    expect(count(out, 8).dark).toBeLessThan(band * 1.15);
  });

  it('does the same to a clear line, so the reading above is not the paper', () => {
    installCanvas();
    const out = pixelsOf(preprocessForOcr(line(255, 100)));
    expect(count(out, 8).dark).toBeGreaterThan(W * 12 * 0.6);
    // Control on the other axis: only the band is dark, the paper is not — a
    // sheet with no line at all would be dark everywhere (pinned below).
    expect(count(out, 245).dark).toBeLessThan(W * 12 * 1.15);
  });
});

describe('preprocessForOcr on a uniform sheet', () => {
  // Both of these read 0 lines in the probe on the shipped engine — pinned so a
  // later reader change meets the same input, and so that "100 % black" is
  // recorded rather than rediscovered.
  it('maps bare paper to solid black', () => {
    installCanvas();
    const out = pixelsOf(preprocessForOcr(sheet(W, H, () => 255)));
    expect(count(out, 0).dark).toBe(W * H);
  });

  it('maps a uniform grey sheet to solid black too, losing its own tone', () => {
    installCanvas();
    const out = pixelsOf(preprocessForOcr(sheet(W, H, () => 200)));
    expect(count(out, 0).dark).toBe(W * H);
  });
});
