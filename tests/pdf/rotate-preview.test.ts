/**
 * The thumbnail rasteriser can be asked for a turn.
 *
 * A preview of a rotation has to be the same angle a viewer would show, so the
 * page's own `/Rotate` and the requested turn go to `pdf.js` as one `rotation`
 * — and the bitmap that comes back is sized for that angle, which is what makes
 * this a preview and not the source picture under a caption.
 *
 * The output is compared with the page itself, never with a guess: the control
 * for every turned reading is the same page with no turn, whose viewport must
 * stay exactly as `pdf.js` builds it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { thumbnails } from '@/lib/pdf/core/render';

interface FakePage {
  rotate: number;
  asked: number[];
  viewportWidth: number;
  viewportHeight: number;
  getViewport(args: { scale: number; rotation?: number }): { width: number; height: number };
  render(): { promise: Promise<void> };
  cleanup(): void;
}

/**
 * A page 300 × 200 with its own `/Rotate`. `getViewport` answers like pdf.js:
 * a quarter turn swaps the box, and an omitted rotation means the page's own.
 */
function fakePage(rotate: number): FakePage {
  const page: FakePage = {
    rotate,
    asked: [],
    viewportWidth: 0,
    viewportHeight: 0,
    getViewport({ scale, rotation }) {
      page.asked.push(rotation === undefined ? -1 : rotation);
      const angle = ((rotation ?? rotate) % 360 + 360) % 360;
      const swap = angle === 90 || angle === 270;
      page.viewportWidth = Math.round((swap ? 200 : 300) * scale);
      page.viewportHeight = Math.round((swap ? 300 : 200) * scale);
      return { width: page.viewportWidth, height: page.viewportHeight };
    },
    render: () => ({ promise: Promise.resolve() }),
    cleanup: () => {},
  };
  return page;
}

function sessionOf(pages: FakePage[]) {
  return {
    numPages: pages.length,
    fingerprint: 'rotate-preview',
    doc: { getPage: async (n: number) => pages[n - 1] },
  } as unknown as Parameters<typeof thumbnails>[0];
}

const canvases: HTMLCanvasElement[] = [];

beforeEach(() => {
  canvases.length = 0;
  const proto = HTMLCanvasElement.prototype as unknown as {
    getContext: (kind: string) => unknown;
    toDataURL: () => string;
  };
  // jsdom has no raster: a stub context is enough for the URL, and the canvas
  // *sizes* — the thing a rotated viewport decides — are real properties.
  proto.getContext = function getContext(this: HTMLCanvasElement, kind: string) {
    if (kind !== '2d') return null;
    canvases.push(this);
    return {} as unknown as CanvasRenderingContext2D;
  };
  proto.toDataURL = function toDataURL(this: HTMLCanvasElement) {
    return `data:image/jpeg;${this.width}x${this.height}`;
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('thumbnails under a turn', () => {
  it('adds the turn to a page that carries none', async () => {
    const page = fakePage(0);
    const urls = await thumbnails(sessionOf([page]), { maxSide: 96, rotateBy: 90 });

    // The whole angle, in one number: pdf.js takes the viewport's rotation, not a
    // delta, and 90 on a level page is 90.
    expect(page.asked).toEqual([90, 90]);
    // A quarter turn of a 300 × 200 sheet is a 200 × 300 raster — the picture is
    // turned, not the source picture beside a label.
    expect(canvases).toHaveLength(1);
    expect(canvases[0].width).toBeLessThan(canvases[0].height);
    expect(urls[0]).toMatch(/;.*x.*$/);
  });

  it('composes with the page’s own /Rotate instead of replacing it', async () => {
    const page = fakePage(90);
    await thumbnails(sessionOf([page]), { maxSide: 96, rotateBy: 90 });

    // 90 + 90 = 180. The bug this pins: a call site that hands pdf.js the delta
    // alone paints the sheet 90 while the run writes 180.
    expect(page.asked).toEqual([180, 180]);
    expect(canvases[0].width).toBeGreaterThan(canvases[0].height);
  });

  it('wraps a quarter turn past a straighten back to level', async () => {
    const page = fakePage(270);
    await thumbnails(sessionOf([page]), { maxSide: 96, rotateBy: 90 });

    // 270 + 90 = 360 → 0, the angle the file is written with. `PageViewport`
    // throws on anything that is not a multiple of 90, so the wrap has to happen
    // here rather than at the renderer.
    expect(page.asked).toEqual([0, 0]);
    expect(canvases[0].width).toBeGreaterThan(canvases[0].height);
  });

  it('leaves the page exactly as it stands when no turn is asked for', async () => {
    const page = fakePage(90);
    const urls = await thumbnails(sessionOf([page]), { maxSide: 96 });

    // The control: no turn hands over the page's own angle unchanged, so a strip
    // with no preview paints what it painted before. A call site that added a
    // stray 90 here would pass the two turned tests and fail this one.
    expect(page.asked).toEqual([90, 90]);
    // A 90° page is a 200 × 300 sheet and stays one.
    expect(canvases[0].width).toBeLessThan(canvases[0].height);
    expect(urls[0]).toContain('x');
  });
});
