/**
 * A canvas that records what pdf.js asks for.
 *
 * jsdom has no 2-D raster, so this environment cannot report the *percentage of
 * ink* the other campaign rigs measure off a bitmap; it can report whether real
 * pdf.js ran a page's paint program to completion and how many drawing calls it
 * issued. `thumbnails()` in `core/render` bails to an empty string when
 * `getContext('2d')` answers null, so without this shim the thumbnail probe
 * would measure jsdom rather than the app.
 *
 * The pixel buffer is honest about its own limits: `fillRect` and `putImageData`
 * land in it, glyph paths and `fillText` do not, so the count it yields is a
 * lower bound and the draw-call tally is the reported number. The file side —
 * what the produced bytes actually rasterise to — is measured by
 * `docs/research/encrypted-inputs-readers.py` with MuPDF.
 */

const DRAW_CALLS = [
  'fill', 'stroke', 'fillRect', 'strokeRect', 'clearRect', 'fillText', 'strokeText',
  'drawImage', 'putImageData', 'clip',
];

export interface Recorder {
  /** Drawing calls issued since the last `reset`, by method name. */
  tally: Record<string, number>;
  /** True once a `render()` settled without throwing. */
  painted: boolean;
  /** The one error a paint run threw, if any. */
  failure: string | null;
}

export function createRecorder(): Recorder {
  const tally: Record<string, number> = {};
  for (const name of DRAW_CALLS) tally[name] = 0;
  return { tally, painted: false, failure: null };
}

/** Install `getContext`/`toDataURL` on jsdom's canvas element. */
export function installCanvas(recorder: Recorder): void {
  const surfaces = new WeakMap<HTMLCanvasElement, { width: number; height: number; data: Uint8ClampedArray }>();
  const surfaceOf = (canvas: HTMLCanvasElement) => {
    const width = Math.max(1, canvas.width | 0);
    const height = Math.max(1, canvas.height | 0);
    let surface = surfaces.get(canvas);
    if (!surface || surface.width !== width || surface.height !== height) {
      surface = { width, height, data: new Uint8ClampedArray(width * height * 4) };
      surfaces.set(canvas, surface);
    }
    return surface;
  };

  // SAFETY: jsdom declares no `getContext`/`toDataURL` on its canvas prototype
  // (they exist only when node-canvas is installed), so the two members this shim
  // replaces are written through a record of the prototype's own shape.
  installPath2D(recorder);
  const proto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
  proto.getContext = function getContext(this: HTMLCanvasElement, kind: string) {
    if (kind !== '2d') return null;
    const canvas = this;
    const state: Record<string, unknown> = {
      canvas,
      getImageData: (x: number, y: number, w: number, h: number) => {
        const source = surfaceOf(canvas);
        const data = new Uint8ClampedArray(w * h * 4);
        for (let row = 0; row < h; row++) {
          for (let column = 0; column < w; column++) {
            const sx = x + column;
            const sy = y + row;
            if (sx < 0 || sy < 0 || sx >= source.width || sy >= source.height) continue;
            const from = (sy * source.width + sx) * 4;
            const to = (row * w + column) * 4;
            for (let channel = 0; channel < 4; channel++) data[to + channel] = source.data[from + channel];
          }
        }
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
            for (let channel = 0; channel < 4; channel++) target.data[to + channel] = image.data[from + channel];
          }
        }
      },
      drawImage: (..._args: unknown[]) => { recorder.tally.drawImage = (recorder.tally.drawImage ?? 0) + 1; },
      createLinearGradient: () => ({ addColorStop: NOOP }),
      createRadialGradient: () => ({ addColorStop: NOOP }),
      createPattern: () => null,
      measureText: (text: string) => ({
        width: String(text).length * 6,
        actualBoundingBoxAscent: 8,
        actualBoundingBoxDescent: 2,
      }),
      getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, is2D: true, isIdentity: true }),
      getLineDash: () => [],
    };
    return new Proxy(state, {
      get: (target, key: string) => {
        if (key in target) return target[key];
        if (DRAW_CALLS.includes(key)) {
          return (..._args: unknown[]) => {
            recorder.tally[key] = (recorder.tally[key] ?? 0) + 1;
          };
        }
        return (..._args: unknown[]) => undefined;
      },
      set: (target, key: string, value: unknown) => {
        target[key] = value;
        return true;
      },
    });
  };

  proto.toDataURL = function toDataURL(this: HTMLCanvasElement, type?: string): string {
    const source = surfaceOf(this);
    let dark = 0;
    for (let i = 0; i < source.data.length; i += 4) {
      if (source.data[i + 3] !== 0 && (source.data[i] < 250 || source.data[i + 1] < 250 || source.data[i + 2] < 250)) dark += 1;
    }
    // A one-line summary is all this environment can offer for a bitmap: the
    // buffer exists so the call above (`getImageData`) is real, not so pixels
    // can be compared. Non-zero `dark` here means a fill or an image landed.
    const note = `${type ?? 'image/png'} ${source.width}x${source.height} dark=${dark}`;
    return `data:text/plain;base64,${Buffer.from(note).toString('base64')}`;
  };

  if (typeof globalThis.ImageData === 'undefined') {
    class ShimImageData {
      data: Uint8ClampedArray;

      width: number;

      height: number;

      constructor(data: Uint8ClampedArray | number, width: number, height?: number) {
        if (typeof data === 'number') {
          this.width = data;
          this.height = width;
          this.data = new Uint8ClampedArray(data * width * 4);
        } else {
          this.data = data;
          this.width = width;
          this.height = height ?? Math.max(1, Math.floor(data.length / 4 / width));
        }
      }
    }
    Object.defineProperty(globalThis, 'ImageData', { value: ShimImageData, configurable: true, writable: true });
  }
}

const NOOP = (..._args: unknown[]): undefined => undefined;

/**
 * pdf.js builds its glyph and clip paths through `Path2D` when the global exists.
 * jsdom has none, so the class it needs is a recorder with the same eight calls
 * and no geometry: the drawing tally is the measurement, the raster is not.
 */
class StubPath2D {
  private readonly recorder: Recorder;

  constructor(recorder: Recorder, source?: string | Path2D) {
    this.recorder = recorder;
    if (typeof source === 'string') {
      // The SVG-path-string form: one `Path2D(d)` per clipped region.
      this.recorder.tally.path2d = (this.recorder.tally.path2d ?? 0) + 1;
    }
  }

  fill(): void { this.recorder.tally.fill = (this.recorder.tally.fill ?? 0) + 1; }

  stroke(): void { this.recorder.tally.stroke = (this.recorder.tally.stroke ?? 0) + 1; }

  addPath(): void { /* the point of this shim is the call count, not the geometry */ }

  closePath(): void {}

  moveTo(): void {}

  lineTo(): void {}

  bezierCurveTo(): void {}

  quadraticCurveTo(): void {}

  arc(): void {}

  arcTo(): void {}

  rect(): void {}

  roundRect(): void {}

  ellipse(): void {}
}

/** Install `Path2D` once, bound to the recorder currently in use. */
export function installPath2D(recorder: Recorder): void {
  const scope = globalThis as unknown as { Path2D?: new (source?: string | Path2D) => Path2D };
  scope.Path2D = function Path2D(this: unknown, source?: string | Path2D) {
    return new StubPath2D(recorder, source) as unknown as Path2D;
  } as unknown as new (source?: string | Path2D) => Path2D;
}

/** The recorded draws, in one line. */
export function drawSummary(recorder: Recorder): string {
  const parts = Object.entries(recorder.tally)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${name} ${count}`);
  return parts.length ? parts.join(', ') : 'no drawing calls at all';
}
