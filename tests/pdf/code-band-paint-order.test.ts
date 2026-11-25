/**
 * The code block paints its band BEHIND its text.
 *
 * `core/layout.ts` `renderBlocks` (the `kind:'code'` branch) laid the glyphs
 * down and only then called `paintCodeBox`, so the opaque `… rg … f` rectangle
 * — the very same stream, later — covered every character it sat on. Every
 * `kind:'code'` page therefore downloaded as an empty grey band: measured on
 * the live `txt-to-pdf` + Monospaced build, the produced sheet carried the
 * 163 978-pixel #f1f1ec band (x 56.2→538.6 pt) and **0** dark glyph pixels
 * inside it while 17 words still extracted. Monospaced text-to-PDF, fenced
 * Markdown, HTML `<pre>` and JSON all route through this branch.
 *
 * The fix must keep the band's colour and geometry identical — so these pins
 * assert the rectangle is still the one `paintCodeBox` has always computed
 * (column-wide, exactly `lines × lineHeight` tall), only emitted before the
 * text run, and that non-code pages still carry no band at all.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument } from '@maxwbh/pdf-lib';
import { pageContentOps } from '@/lib/pdf/core/content';
import type { ContentOp, NumberOperand } from '@/lib/pdf/core/content';
import { PDFPage } from '@maxwbh/pdf-lib';
import {
  fileFrom,
  firstPdf,
  installConvertToEnv,
  resetConvertToEnv,
  restoreConvertToEnv,
  run,
} from './convert-to-harness';

/** The band fill `#f1f1ec` and the code ink `rgb(0.15, 0.15, 0.13)`. */
const BAND = [0xf1 / 255, 0xf1 / 255, 0xec / 255];
const INK = [0.15, 0.15, 0.13];
const same = (c: number[], want: number[]) => c.length === want.length && c.every((v, i) => Math.abs(v - want[i]) <= 0.005);

interface BandFill {
  /** Position in the content stream; paint order is exactly this order. */
  index: number;
  color: number[];
  rect: [number, number, number, number];
}
interface Show {
  index: number;
  color: number[];
  x: number;
  y: number;
}

/**
 * Every grey fill rectangle and every shown text run of a page, each with its
 * content-stream position — paint order is exactly that order. pdf-lib lays a
 * `drawRectangle` as a `cm` translation to the corner plus an `m/l/l/l/h`
 * outline and an `f` fill in the current `rg`; text shows as `Tm`/`Td`/`Tj`.
 */
function scanPage(page: PDFPage): { bands: BandFill[]; shows: Show[] } {
  const bands: BandFill[] = [];
  const shows: Show[] = [];
  let color: number[] = [];
  let origin: [number, number] | null = null;
  let spanX = 0;
  let spanY = 0;
  let x = 0;
  let y = 0;
  pageContentOps(page).forEach((op: ContentOp, index: number) => {
    const n = op.operands
      .filter((o) => o.kind === 'number')
      .map((o) => (o as NumberOperand).value);
    if (op.name === 'rg' && n.length === 3) color = n;
    else if (op.name === 'cm' && n.length === 6 && (n[4] !== 0 || n[5] !== 0)) {
      origin = [n[4], n[5]];
      spanX = 0;
      spanY = 0;
    } else if ((op.name === 'm' || op.name === 'l') && n.length >= 2) {
      spanX = Math.max(spanX, n[0]);
      spanY = Math.max(spanY, n[1]);
    } else if (op.name === 'f' && origin) {
      bands.push({ index, color, rect: [origin[0], origin[1], spanX, spanY] });
      origin = null;
    } else if ((op.name === 'Td' || op.name === 'TD') && n.length >= 2) {
      x += n[0];
      y += n[1];
    } else if (op.name === 'Tm' && n.length >= 6) {
      x = n[4];
      y = n[5];
    } else if (op.name === 'Tj' || op.name === 'TJ') {
      shows.push({ index, color, x, y });
    }
  });
  return { bands, shows };
}

async function typeset(text: string, monospace: boolean): Promise<PDFDocument> {
  const outcome = await run('txt-to-pdf', { monospace }, [fileFrom(text, 'code.txt', 'text/plain')]);
  return PDFDocument.load(await firstPdf(outcome));
}

const CODE = 'ID\tNAME\tQTY\n1\tapple\t3\n22\tbanana\t4';
const LINE_HEIGHT = Math.max(7, 11 * 0.88) * 1.35; // code fontSize × leading, as the branch computes it

beforeAll(() => installConvertToEnv());
afterEach(() => resetConvertToEnv());
afterAll(() => restoreConvertToEnv());

describe('code band paint order (c3 blocker 1)', () => {
  it('paints the band before the text it sits behind', async () => {
    const doc = await typeset(CODE, true);
    const { bands, shows } = scanPage(doc.getPage(0));
    const band = bands.find((b) => same(b.color, BAND));
    const ink = shows.filter((s) => same(s.color, INK));
    // The band is still there (colour pinned) and every code line is still shown.
    expect(band, 'the grey code band').toBeTruthy();
    expect(ink.length).toBe(3);
    // …and it is painted before every glyph, not after them.
    expect(band!.index).toBeLessThan(Math.min(...ink.map((s) => s.index)));
  });

  it('keeps the band’s colour and geometry identical', async () => {
    const doc = await typeset(CODE, true);
    const { bands, shows } = scanPage(doc.getPage(0));
    const band = bands.find((b) => same(b.color, BAND))!;
    const [x, y, width, height] = band.rect;
    // A4 hugging the column: margin 56, width 595.28 − 112, height lines × leading.
    expect(x).toBeCloseTo(56, 1);
    expect(width).toBeCloseTo(595.28 - 112, 1);
    expect(height).toBeCloseTo(3 * LINE_HEIGHT, 1);
    // The rectangle still covers exactly the baselines it is meant to sit behind.
    const ink = shows.filter((s) => same(s.color, INK));
    for (const run of ink) {
      expect(run.y).toBeGreaterThanOrEqual(y - 0.01);
      expect(run.y).toBeLessThanOrEqual(y + height + 0.01);
      expect(run.x).toBeGreaterThanOrEqual(x);
      expect(run.x).toBeLessThan(x + width);
    }
  });

  it('paints each page’s band before that page’s text when the block spans pages', async () => {
    const many = Array.from({ length: 80 }, (_, i) => `line ${i + 1} of the long code block`).join('\n');
    const doc = await typeset(many, true);
    expect(doc.getPageCount()).toBeGreaterThan(1);
    let pagesWithCode = 0;
    for (const page of doc.getPages()) {
      const { bands, shows } = scanPage(page);
      const band = bands.find((b) => same(b.color, BAND));
      const ink = shows.filter((s) => same(s.color, INK));
      if (ink.length === 0) continue;
      pagesWithCode += 1;
      expect(band, `a code page (${ink.length} lines) lost its band`).toBeTruthy();
      expect(band!.index).toBeLessThan(Math.min(...ink.map((s) => s.index)));
    }
    expect(pagesWithCode).toBeGreaterThan(1);
  });

  it('control: a prose page carries no code band at all', async () => {
    const doc = await typeset(CODE, false);
    const { bands } = scanPage(doc.getPage(0));
    expect(bands.find((b) => same(b.color, BAND))).toBeUndefined();
  });
});
