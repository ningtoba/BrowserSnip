/**
 * The alias rails' Page controls reach the bytes on `png-to-pdf`.
 *
 * `png-to-pdf-alpha.test.ts` pins what transparency does and sizes an A4 sheet
 * incidentally; the alias's own three controls — Page size, Margin, Orientation
 * — had never been checked against the boxes they are supposed to write. On the
 * parent, `convert-to-bytes` pins hug-plus-margin and the sheet arithmetic, but
 * the aliases run their own `run()` with their own field defaults (`fit`, zero
 * margin, portrait — the shared 56 pt default would pad every picture page),
 * and a fixed default or a dropped value on that path changes the box without
 * touching a single parent test.
 *
 * Live rail, 2026-11-25 (:5296, `docs/research/convert-raster-spec.json`):
 * alpha.png on `Page size=Match each image` landed 120 × 90 pt exactly; on
 * A4 + Landscape + Margin 18 the box measured 841.89 × 595.28 with the picture
 * drawn inside [48.09 … 793.8] × [18 … 577.28] — contain-scaled, centred, and
 * never closer than the 18 pt asked for. These are those numbers, at fixture
 * scale.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument } from '@maxwbh/pdf-lib';
import {
  fileFrom,
  firstPdf,
  imagesPerPage,
  installConvertToEnv,
  pageSizes,
  realPng,
  resetConvertToEnv,
  restoreConvertToEnv,
  run,
} from './convert-to-harness';

beforeAll(() => {
  installConvertToEnv();
});
afterEach(() => {
  resetConvertToEnv();
});
afterAll(() => {
  restoreConvertToEnv();
});

const png = () => fileFrom(realPng(30, 20), 'shot.png', 'image/png');

describe('the picture rail sizes the page the way its help says', () => {
  it('hugs the picture: one point per pixel, margin added all round', async () => {
    const bytes = await firstPdf(await run('png-to-pdf', { pageSize: 'fit', margin: 0 }, [png()]));
    expect(await pageSizes(bytes)).toEqual([[30, 20]]);
    const padded = await firstPdf(await run('png-to-pdf', { pageSize: 'fit', margin: 6 }, [png()]));
    // "Each page is the size of its own picture … plus the margin."
    expect(await pageSizes(padded)).toEqual([[42, 32]]);
  });

  it('puts the sheet on the paper the select names, and swaps it when asked', async () => {
    const a4 = await firstPdf(await run('png-to-pdf', { pageSize: 'a4', margin: 0 }, [png()]));
    expect(await pageSizes(a4)).toEqual([[595.28, 841.89]]);
    const letter = await firstPdf(await run('png-to-pdf', { pageSize: 'letter', margin: 0 }, [png()]));
    expect(await pageSizes(letter)).toEqual([[612, 792]]);
    const swapped = await firstPdf(await run('png-to-pdf', { pageSize: 'letter', orientation: 'landscape', margin: 0 }, [png()]));
    expect(await pageSizes(swapped)).toEqual([[792, 612]]);
    // Control: hugging never swaps, whatever the orientation says it cannot do.
    const hugged = await firstPdf(await run('png-to-pdf', { pageSize: 'fit', orientation: 'landscape', margin: 0 }, [png()]));
    expect(await pageSizes(hugged)).toEqual([[30, 20]]);
  });

  it('scales the picture into the sheet without crossing the margin', async () => {
    const bytes = await firstPdf(await run('png-to-pdf', { pageSize: 'a4', margin: 24 }, [png()]));
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const [placed] = await imagesPerPage(bytes);
    expect(placed.length).toBe(1);
    const [x, y, width, height] = placed[0].box;
    // Contain on the 547.28 × 793.89 usable box: the long edge touches both margins.
    expect(width).toBeCloseTo(547.28, 1);
    expect(x).toBeGreaterThanOrEqual(24 - 0.01);
    expect(x + width).toBeLessThanOrEqual(595.28 - 24 + 0.01);
    expect(y).toBeGreaterThanOrEqual(24 - 0.01);
    expect(y + height).toBeLessThanOrEqual(841.89 - 24 + 0.01);
    expect(doc.getPageCount()).toBe(1);
  });
});
