/**
 * A *free* angle on a thumbnail — the half `pdf.js` cannot do.
 *
 * `PageViewport` only honours 0/90/180/270: hand it 45 and it falls into its
 * identity branch, so the sheet comes back level. The strip therefore painted
 * the source orientation for every angle a user typed, while `rotate-custom`'s
 * run wrote that angle into the content — measured at 45° on the live pane
 * (`docs/research/rotate-custom-round.mjs`, `pane-45-strip.png`: four upright
 * tiles under a `45°` readout).
 *
 * The turn is now made on the canvas after the raster. These tests read the
 * transform actually applied — the radians handed to `ctx.rotate` and the frame
 * `drawImage` was given — and pit every reading against the same page at a right
 * angle, which must stay on the viewport path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { previewKey, thumbnails } from '@/lib/pdf/core/render';

interface Call {
  op: 'rotate' | 'drawImage' | 'translate' | 'save' | 'restore' | 'fillRect';
  args: number[];
  frame?: [number, number];
}

interface Recorder {
  canvas: HTMLCanvasElement;
  calls: Call[];
}

function contextFor(recorder: Recorder): CanvasRenderingContext2D {
  const record = (call: Call) => recorder.calls.push(call);
  return {
    save: () => record({ op: 'save', args: [] }),
    restore: () => record({ op: 'restore', args: [] }),
    translate: (x: number, y: number) => record({ op: 'translate', args: [x, y] }),
    rotate: (radians: number) => record({ op: 'rotate', args: [radians] }),
    fillRect: (x: number, y: number, w: number, h: number) => record({ op: 'fillRect', args: [x, y, w, h] }),
    drawImage: (image: HTMLCanvasElement, x: number, y: number) =>
      record({ op: 'drawImage', args: [x, y], frame: [image.width, image.height] }),
  } as unknown as CanvasRenderingContext2D;
}

/** A page 300 × 200 with its own `/Rotate`, answering the way `pdf.js` does. */
function fakePage(rotate: number) {
  const page = {
    rotate,
    asked: [] as number[],
    getViewport(args: { scale: number; rotation?: number }) {
      page.asked.push(args.rotation === undefined ? -1 : args.rotation);
      const angle = ((args.rotation ?? rotate) % 360 + 360) % 360;
      // `PageViewport`'s own switch: only a quarter turn swaps the box, and any
      // other angle is painted exactly like a level page.
      const swap = angle === 90 || angle === 270;
      return { width: Math.round((swap ? 200 : 300) * args.scale), height: Math.round((swap ? 300 : 200) * args.scale) };
    },
    render: () => ({ promise: Promise.resolve() }),
    cleanup: () => {},
  };
  return page;
}

const sessionOf = (pages: ReturnType<typeof fakePage>[]) =>
  ({
    numPages: pages.length,
    fingerprint: 'free-angle',
    doc: { getPage: async (n: number) => pages[n - 1] },
  }) as unknown as Parameters<typeof thumbnails>[0];

const recorders: Recorder[] = [];

beforeEach(() => {
  recorders.length = 0;
  const proto = HTMLCanvasElement.prototype as unknown as {
    getContext: (kind: string) => unknown;
    toDataURL: () => string;
  };
  proto.getContext = function getContext(this: HTMLCanvasElement, kind: string) {
    if (kind !== '2d') return null;
    const recorder: Recorder = { canvas: this, calls: [] };
    recorders.push(recorder);
    return contextFor(recorder);
  };
  proto.toDataURL = function toDataURL(this: HTMLCanvasElement) {
    return `data:image/jpeg;${this.width}x${this.height}`;
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a thumbnail at a free angle', () => {
  it('turns the raster by exactly the angle, because pdf.js will not', async () => {
    const page = fakePage(0);
    const [url] = await thumbnails(sessionOf([page]), { maxSide: 96, rotateBy: 45 });

    // Every viewport pdf.js was asked for is a multiple of 90 — 45 never reaches
    // it, which is why the old code came back with the sheet level.
    expect(page.asked.every((angle) => angle % 90 === 0)).toBe(true);
    // Two canvases: the turned one, and the flat raster drawn into it.
    expect(recorders).toHaveLength(2);
    const dest = recorders.find((r) => r.calls.some((call) => call.op === 'drawImage'))!;
    const flat = recorders.find((r) => r !== dest)!;
    const rotate = dest.calls.find((call) => call.op === 'rotate');
    expect(rotate?.args[0]).toBeCloseTo(Math.PI / 4, 6);
    const draw = dest.calls.find((call) => call.op === 'drawImage');
    // The whole flat raster is composited, at its own size, from its middle.
    expect(draw?.frame).toEqual([flat.canvas.width, flat.canvas.height]);
    expect(draw?.args).toEqual([-flat.canvas.width / 2, -flat.canvas.height / 2]);
    // The turned box of a 300 × 200 sheet is 353 × 353, so the picture is square
    // and nothing the turn pushed outward is cropped.
    expect(Math.abs(dest.canvas.width - dest.canvas.height)).toBeLessThanOrEqual(1);
    expect(dest.canvas.width).toBe(96);
    // Paper, not a black square: the corners a turn leaves are transparent and
    // the strip's JPEG flattens them to black unless they are filled white first
    // (measured: four black tiles under a 45° readout, `pane-45-before-fix`).
    const paper = dest.calls.find((call) => call.op === 'fillRect');
    expect(paper?.args).toEqual([0, 0, dest.canvas.width, dest.canvas.height]);
    expect(dest.calls.indexOf(paper!)).toBeLessThan(dest.calls.indexOf(draw!));
    expect(url).toMatch(/x/);
  });

  it('composes the free angle with the page’s own /Rotate', async () => {
    const page = fakePage(90);
    await thumbnails(sessionOf([page]), { maxSide: 96, rotateBy: 30 });

    // The page's own quarter turn stays on the viewport; only the extra 30° is
    // made by hand, and the sum — 90 + 30 = 120 — is what the box is sized for:
    // a 200 × 300 sheet needs 323 × 360.
    expect(page.asked.every((angle) => angle === 90)).toBe(true);
    const dest = recorders.find((r) => r.calls.some((call) => call.op === 'drawImage'))!;
    expect(dest.calls.find((call) => call.op === 'rotate')?.args[0]).toBeCloseTo(Math.PI / 6, 6);
    expect(dest.canvas.width / dest.canvas.height).toBeCloseTo(323 / 360, 2);
  });

  it('leaves a right angle to pdf.js instead of turning it twice', async () => {
    const page = fakePage(0);
    await thumbnails(sessionOf([page]), { maxSide: 96, rotateBy: 90 });

    // The control: one canvas, the swapped 200 × 300 box from the viewport, and
    // no hand-made transform at all.
    expect(page.asked).toEqual([90, 90]);
    expect(recorders).toHaveLength(1);
    expect(recorders[0].calls.some((call) => call.op === 'rotate')).toBe(false);
    // The viewport path paints the paper itself, so nothing is filled by hand.
    expect(recorders[0].calls.some((call) => call.op === 'fillRect')).toBe(false);
    expect(recorders[0].canvas.width).toBeLessThan(recorders[0].canvas.height);
  });

  it('leaves a level page alone when no turn is asked for', async () => {
    const page = fakePage(0);
    await thumbnails(sessionOf([page]), { maxSide: 96 });

    expect(page.asked).toEqual([0, 0]);
    expect(recorders).toHaveLength(1);
    expect(recorders[0].calls.some((call) => call.op === 'rotate')).toBe(false);
    expect(recorders[0].canvas.width).toBeGreaterThan(recorders[0].canvas.height);
  });
});

describe('the id a preview is cached under', () => {
  // Two files that differ only after the first kilobyte — what a tool produces
  // when it rewrites the last sheet of four and copies the rest. Their pdf.js
  // fingerprints are identical, so the cache handed back the other one: measured
  // on the result card of a 0° turn, which painted a 30° page.
  const head = new Uint8Array(2048).fill(0x41);
  const one = Uint8Array.from([...head, 9, 9, 9]);
  const two = Uint8Array.from([...head, 7, 7, 7, 7]);

  it('separates two files whose first kilobyte is the same', () => {
    expect(previewKey(one, 'same')).not.toBe(previewKey(two, 'same'));
  });

  it('is stable for the same bytes and still carries pdf.js’s id', () => {
    expect(previewKey(one, 'same')).toBe(previewKey(Uint8Array.from(one), 'same'));
    expect(previewKey(one, 'same').startsWith('same:')).toBe(true);
  });
});
