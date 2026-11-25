/**
 * cbz-to-pdf counts what it ignores, and the card admits it also enlarges.
 *
 * Measured at :5296 (`/tmp/lane-convert/c2-cbz-spec.json`, runs11, boxes and
 * ink probed from the produced PDFs): an archive of nothing but page images was
 * still told "Non-image entries inside the archive (CBA-style extras, metadata,
 * cover text) were ignored." — a sentence about entries that did not exist —
 * and an archive that did hide extras named neither their number nor their
 * names. The card also promised the picture "is scaled down to fit" a chosen
 * sheet; measured, a 200 × 400 page on A4 comes out at 422 × 842 pt: small art
 * is *enlarged* (contain, centred, never cropped), the rotation for wide art
 * lands exactly as promised (841.89 × 595.28 sheet, ink (0,87)-(842,509)).
 * Natural ordering, nested folders, Mac resource-fork skipping and the corrupt-
 * and-not-a-zip refusals all measured correct and are pinned here too: `../`
 * entry names ride the pages list harmlessly, the output file is named from the
 * archive, never from an entry.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import {
  fileFrom, firstPdf, installConvertToEnv, pageSizes, realPng, resetConvertToEnv, run, zipBytes,
} from './convert-to-harness';

beforeAll(() => installConvertToEnv());
afterEach(() => resetConvertToEnv());

const png = (w: number, h: number) => realPng(w, h);

describe('the ignored entries are counted and named, or not mentioned', () => {
  it('says nothing about non-image entries when the archive holds only pages', async () => {
    const zip = await zipBytes([
      { name: 'p1.png', data: png(12, 8) },
      { name: 'p2.png', data: png(13, 8) },
    ]);
    const outcome = await run('cbz-to-pdf', { pageSize: 'fit' }, [fileFrom(zip, 'clean.cbz')]);
    // Red without the fix: the standing sentence claimed ignored non-image
    // entries for this archive, which has none.
    expect(outcome.warnings.join(' ')).not.toMatch(/Non-image/);
    expect(await pageSizes(await firstPdf(outcome))).toEqual([[12, 8], [13, 8]]);
  });

  it('names the count and the files it skipped, ../ entries included unharmed', async () => {
    const zip = await zipBytes([
      { name: 'page1.png', data: png(20, 10) },
      { name: '../page2.png', data: png(40, 10) },
      { name: 'cover.txt', data: 'text' },
      { name: 'notes.xml', data: '<x/>' },
    ]);
    const outcome = await run('cbz-to-pdf', { pageSize: 'fit' }, [fileFrom(zip, 'odd.cbz')]);
    const said = outcome.warnings.join(' ');
    expect(said).toMatch(/Non-image entries \(2 of 4 files in the archive\) were ignored: cover\.txt, notes\.xml\./);
    // The traversal-prefixed name is a page like any other, and the output is
    // named from the archive — no entry label reaches the download.
    expect(await pageSizes(await firstPdf(outcome))).toEqual([[20, 10], [40, 10]]);
    expect(outcome.message).toMatch(/2 comic pages → 2 PDF page\(s\)/);
  });

  it('keeps the natural numeric order the card promises', async () => {
    const zip = await zipBytes([
      { name: 'page10.png', data: png(60, 10) },
      { name: 'page2.png', data: png(40, 10) },
      { name: 'page1.png', data: png(20, 10) },
    ]);
    const outcome = await run('cbz-to-pdf', { pageSize: 'fit' }, [fileFrom(zip, 'order.cbz')]);
    expect(await pageSizes(await firstPdf(outcome))).toEqual([[20, 10], [40, 10], [60, 10]]);
  });

  it('refuses a corrupt archive naming the file, not the library noise', async () => {
    const zip = await zipBytes([{ name: 'p.png', data: png(4, 4) }]);
    const broken = zip.slice(0, 40); // central directory gone, PK header kept
    const error = await run('cbz-to-pdf', {}, [fileFrom(broken, 'broken.cbz')]).catch((err) => err);
    expect((error as Error).message).toMatch(/"broken\.cbz" is not a readable ZIP archive/);
    expect((error as Error).message).not.toMatch(/https?:|stack|at .*\.js/);
  });

  it('the sheet note tells the truth in both scale directions', () => {
    const note = (getPdfTool('cbz-to-pdf')?.notes ?? []).join(' ');
    expect(note).toMatch(/small art is enlarged/);
    expect(note).not.toMatch(/scaled down to fit inside it rather than cropped/);
  });
});
