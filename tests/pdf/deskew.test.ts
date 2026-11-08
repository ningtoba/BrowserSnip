/**
 * `deskew-pdf`, measured rather than counted.
 *
 * The row in `docs/TOOL-CAMPAIGN.md` records two stacked defects, and the second
 * only becomes visible once the first is gone:
 *
 * 1. `core/measure.ts:detectSkew` read the canvas straight after `renderPage()`
 *    settled — which is after pdf.js has *scheduled* the paint and filled the
 *    background, so the bitmap held nothing, the estimator answered
 *    `{ angle: 0, confidence: 0 }`, and the tool reported "nothing to do" on a
 *    page tilted 6 degrees.
 * 2. With the paint awaited, the tool turned the page the *other* way: the
 *    estimate is a **bitmap** angle (y runs down, so positive text runs downhill
 *    to the right) while `applySkew` wants the counter-rotation. Un-negated, it
 *    doubled the lean — on the deployed build a page turned -6° came back at -12°
 *    (`docs/research/deskew-residual.py` on the download).
 *
 * Two campaign rules therefore bind this file. The double models the
 * **ordering** of the paint, not its shape — a `finished: Promise.resolve()`
 * would leave defect 1 uncatchable — and the assertions read the produced
 * **file**: the rotation its content stream ends up carrying, fed back through
 * the shipped estimator so the instrument that found the tilt is the one that
 * calls the page straight.
 */
import { describe, beforeEach, expect, it, vi } from 'vitest';
import { PDFDocument, PDFName, StandardFonts, rgb } from '@maxwbh/pdf-lib';
import type { PDFPage } from '@maxwbh/pdf-lib';
import type { PageRender, PdfSession } from '@/lib/pdf/core/render';
import { openPDF } from '@/lib/pdf/core/doc';
import { pageContentOps } from '@/lib/pdf/core/content';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import {
  defaultValues,
  type ToolFile,
  type ToolResult,
  type ToolValues,
} from '@/lib/pdf/tools/types';

/** The fixture page, in points: what the fake session rasterises at `scale`. */
const PAGE: [number, number] = [595, 842];

const fake = vi.hoisted(() => ({
  /** Bitmap tilt (y-down degrees) each fake page paints; index = page - 1. */
  tilts: [] as number[],
  /** Reads taken while the canvas was still only its background fill. */
  earlyReads: 0,
}));

/**
 * 40 parallel text lines, tilted `tiltDegrees` in the bitmap convention
 * (positive = downhill to the right). This is what pdf.js paints for a page
 * whose content is turned by `-tiltDegrees` in PDF user space.
 */
function inkMask(width: number, height: number, tiltDegrees: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const rad = (tiltDegrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = width / 2;
  const cy = height / 2;
  const put = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const p = (y * width + x) * 4;
    data[p] = 0;
    data[p + 1] = 0;
    data[p + 2] = 0;
    data[p + 3] = 255;
  };
  for (let line = 0; line < 40; line++) {
    const offset = -height * 0.4 + (line * height * 0.8) / 39;
    for (let along = -width * 0.4; along <= width * 0.4; along += 1) {
      const x = Math.round(cx + along * cos - offset * sin);
      const y = Math.round(cy + along * sin + offset * cos);
      put(x, y);
      put(x, y + 1);
      put(x, y + 2);
    }
  }
  return data;
}

vi.mock('@/lib/pdf/core/render', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/pdf/core/render')>();
  return {
    ...real,
    openRender: async (): Promise<PdfSession> => {
      const renderPage = async (n: number, scale: number): Promise<PageRender> => {
        const width = Math.floor(PAGE[0] * scale);
        const height = Math.floor(PAGE[1] * scale);
        let painted = false;
        let settle: () => void = () => {};
        // The paint lands in a *later task*, the way pdf.js does it: the canvas
        // only holds the background fill until `finished` resolves. A timer is
        // the smallest gap that keeps this double honest — a promise resolved
        // inline would run before the caller's own continuation and hide the
        // missing await entirely.
        const finished = new Promise<void>((resolve) => {
          settle = resolve;
        });
        const timer = setTimeout(() => {
          painted = true;
          settle();
        }, 0);
        const ctx = {
          getImageData: (_x: number, _y: number, w: number, h: number) => {
            if (!painted) fake.earlyReads += 1;
            const data = painted ? inkMask(w, h, fake.tilts[n - 1] ?? 0) : new Uint8ClampedArray(w * h * 4).fill(255);
            return { data, width: w, height: h, colorSpace: 'srgb' };
          },
        };
        return {
          canvas: {} as HTMLCanvasElement,
          ctx: ctx as unknown as CanvasRenderingContext2D,
          width,
          height,
          unitsPerPixel: 1 / scale,
          pageNumber: n,
          finished,
          cancel: () => clearTimeout(timer),
        };
      };
      return {
        numPages: Math.max(1, fake.tilts.length),
        renderPage,
        destroy: async () => {},
      } as unknown as PdfSession;
    },
  };
});

beforeEach(() => {
  fake.tilts = [];
  fake.earlyReads = 0;
});

/** ── fixtures ───────────────────────────────────────────────────────────── */

/**
 * A real PDF whose whole content stream sits inside one rotation, the way a
 * skewed scan is a page fed through a feeder at an angle.
 *
 * `alphaDegrees` is **PDF user space**, positive counterclockwise as the page is
 * viewed — the spelling of `/Rotate`, and the opposite of the bitmap angle the
 * estimator reports. The fake session above is handed `-alphaDegrees` so the
 * bytes and the paint describe the same page.
 */
async function tiltedPdf(alphaDegrees: number, pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const rad = (alphaDegrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  for (let p = 0; p < pages; p++) {
    const page = doc.addPage(PAGE);
    const resources = page.node.Resources();
    if (!resources) throw new Error('the fixture page has no /Resources');
    resources.set(PDFName.of('Font'), doc.context.obj({ F1: font.ref }) as never);
    const lines: string[] = [];
    for (let line = 0; line < 40; line++) {
      const y = PAGE[1] - 70 - line * 16;
      lines.push(`BT /F1 11 Tf 72 ${y.toFixed(2)} Td (Line ${line + 1} of the tilted page) Tj ET`);
    }
    const body = [
      'q',
      `${cos.toFixed(6)} ${sin.toFixed(6)} ${(-sin).toFixed(6)} ${cos.toFixed(6)} 0 0 cm`,
      ...lines,
      'Q',
    ].join('\n');
    page.node.set(
      PDFName.of('Contents'),
      doc.context.register(doc.context.stream(body)),
    );
    page.drawRectangle({ x: 20, y: 20, width: 40, height: 8, color: rgb(0, 0, 0) });
  }
  return doc.save({ useObjectStreams: false });
}

/** Run the shipped tool and hand back the result plus the document it wrote. */
async function runDeskew(bytes: Uint8Array, values: ToolValues = {}) {
  const tool = getPdfTool('deskew-pdf');
  expect(tool, 'deskew-pdf is not registered').toBeTruthy();
  const input: ToolFile = {
    name: 'scan.pdf',
    size: bytes.byteLength,
    type: 'application/pdf',
    bytes: async () => new Uint8Array(bytes),
    blob: () => new Blob([bytes], { type: 'application/pdf' }),
  };
  const result = (await tool!.run!({
    inputs: [input],
    values: { ...defaultValues(tool!.fields), ...values },
    progress: () => {},
    log: () => {},
    signal: new AbortController().signal,
  }))!;
  const pdf = result.kind === 'pdf' ? result.bytes : new Uint8Array();
  const doc = await openPDF(pdf, { ignoreEncryption: true });
  return { result: result as Extract<ToolResult, { kind: 'pdf' }>, pdf, doc };
}

/**
 * The net rotation a page's content actually carries, in user-space degrees:
 * every `cm` multiplied together, reported as an angle. Both the fixture's own
 * tilt and the correction `applySkew` writes live in this sum, so a straightened
 * page is one that measures ~0 — which is the whole point, since a correction of
 * the wrong sign leaves ±2× the tilt behind instead of nothing. Every `cm` here
 * (the fixtures', and the one `applySkew` writes) is a pure rotation, and
 * rotations add.
 */
function contentRotation(page: PDFPage): number {
  let total = 0;
  for (const op of pageContentOps(page)) {
    if (op.name !== 'cm') continue;
    const numbers = op.operands.map((one) => (one.kind === 'number' ? one.value : 0));
    total += (Math.atan2(numbers[1], numbers[0]) * 180) / Math.PI;
  }
  return total;
}

/** ── the paint ordering (defect 1) ──────────────────────────────────────── */

describe('the fake session keeps the paint race honest', () => {
  it('paints nothing until finished resolves, and ink after', async () => {
    const { openRender } = await import('@/lib/pdf/core/render');
    const session = await openRender(new Uint8Array([0]));
    fake.tilts = [-3];
    const render = await session.renderPage(1, 1);
    const before = render.ctx.getImageData(0, 0, render.width, render.height).data;
    await render.finished;
    const after = render.ctx.getImageData(0, 0, render.width, render.height).data;
    expect(fake.earlyReads).toBe(1);
    const white = (buf: Uint8ClampedArray) => {
      let dark = 0;
      for (let i = 0; i < buf.length; i += 4) if (buf[i] < 200) dark += 1;
      return dark;
    };
    expect(white(before)).toBe(0);
    expect(white(after)).toBeGreaterThan(1000);
    await session.destroy();
  });
});

describe('detectSkew measures the painted page', () => {
  it('waits for pdf.js to paint before reading the bitmap', async () => {
    const { detectSkew } = await import('@/lib/pdf/core/measure');
    const { openRender } = await import('@/lib/pdf/core/render');
    const session = await openRender(new Uint8Array([0]));
    fake.tilts = [-3];
    const estimate = await detectSkew(session, 1, { maxAngle: 10 });
    // Reading early is the defect: an awaited paint leaves no early read behind.
    expect(fake.earlyReads).toBe(0);
    expect(estimate.angle).toBeCloseTo(-3, 1);
    expect(estimate.confidence).toBeGreaterThan(0.35);
    await session.destroy();
  });

  it.each([-6, -3, 3, 6])('answers the bitmap angle of a page turned %i°', async (alpha) => {
    const { detectSkew } = await import('@/lib/pdf/core/measure');
    const { openRender } = await import('@/lib/pdf/core/render');
    const session = await openRender(new Uint8Array([0]));
    fake.tilts = [-alpha];
    const estimate = await detectSkew(session, 1, { maxAngle: 10 });
    expect(estimate.angle).toBeCloseTo(-alpha, 1);
    await session.destroy();
  });
});

/** ── the sign convention (defect 2), measured on the produced file ──────── */

describe.each([-6, -3, 3, 6])('deskew-pdf on a page turned %i° in user space', (alpha) => {
  it('leaves a page with no rotation left in its content stream', async () => {
    fake.tilts = [-alpha];
    const source = await tiltedPdf(alpha);
    const { result, doc } = await runDeskew(source, { maxAngle: 10, threshold: 0.35, pages: 'all' });
    const page = doc.getPage(0);
    const residual = contentRotation(page);
    expect(Math.abs(residual), `residual rotation ${residual}°`).toBeLessThan(0.2);
    // The same instrument the tool measures with calls the result straight.
    const { alphaMaskFromPixels, skewFromProjectionProfile } = await import('@/lib/pdf/core/measure');
    const width = 595;
    const height = 842;
    const mask = alphaMaskFromPixels(inkMask(width, height, -residual), width, height);
    const after = skewFromProjectionProfile(mask, width, height, 10);
    expect(Math.abs(after.angle), `residual bitmap angle ${after.angle}°`).toBeLessThan(0.2);
    expect(result.message).toMatch(/Straightened 1 page\(s\)/);
  });

  it('names the tilt it found and turns the page back the other way', async () => {
    fake.tilts = [-alpha];
    const { result } = await runDeskew(await tiltedPdf(alpha));
    const turn = alpha > 0 ? `${Math.abs(alpha).toFixed(2)}° clockwise` : `${Math.abs(alpha).toFixed(2)}° counterclockwise`;
    const tilt = `${alpha > 0 ? '-' : '+'}${Math.abs(alpha).toFixed(2)}°`;
    expect(result.message).toContain(`1 (tilt ${tilt}, turned ${turn})`);
    expect(result.warnings?.join(' ') ?? '').not.toMatch(/Not straightened/);
  });
});

describe('deskew-pdf on a page that is already straight', () => {
  it('writes no correction and says nothing was to do', async () => {
    fake.tilts = [0];
    const before = await tiltedPdf(0);
    const { result, doc } = await runDeskew(before);
    expect(result.message).toMatch(/Nothing to do/);
    expect(contentRotation(doc.getPage(0))).toBeCloseTo(0, 6);
    expect(doc.getPage(0).getSize()).toEqual({ width: PAGE[0], height: PAGE[1] });
  });
});
