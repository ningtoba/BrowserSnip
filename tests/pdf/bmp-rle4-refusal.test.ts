/**
 * RLE4 is the one BMP coding this browser answers with NOTHING.
 *
 * Measured at :5296 (`docs/research/convert-bmp-tiff-spec.json`, runs6/7, bytes
 * by `docs/research/convert-bt-measure.py`): both encodings the SDK documents
 * for 4-bit run-length produced a fully transparent bitmap from Chrome for
 * Testing 151 — an all-white page under a card reading `1 BMP image(s) →
 * 1 page(s)` — while 8-bit RLE (`c2-rle8`) and every plain depth converted
 * pixel-exact. The refusal therefore fires on the compression word the header
 * states (comp=2), before the decoder is asked; comp=1 keeps its way through.
 * The companion gate and card lines are the tiff file's (`tiff-variants`).
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { ToolInputError } from '@/lib/pdf/core/guard';
import {
  bmpBytes, fileFrom, firstPdf, installConvertToEnv, pageSizes, resetConvertToEnv, run,
} from './convert-to-harness';

beforeAll(() => installConvertToEnv());
afterEach(() => resetConvertToEnv());

/** The same for the one BMP header word the gate reads. */
function patchBmpCompression(bytes: Uint8Array, value: number): Uint8Array {
  const copy = bytes.slice();
  new DataView(copy.buffer).setUint32(30, value, true);
  return copy;
}

describe('a BMP this browser paints empty is refused, not blanked', () => {
  it('refuses an RLE4 BMP naming the coding and the blank page it would make', async () => {
    const error = await run('bmp-to-pdf', { pageSize: 'fit' }, [
      fileFrom(patchBmpCompression(bmpBytes(40, 24), 2), 'dos.bmp', 'image/bmp'),
    ]).catch((err) => err);
    expect((error as Error).message).toMatch(/"dos\.bmp" is a 4-bit run-length BMP/);
    expect((error as Error).message).toMatch(/would come out blank/);
    expect((error as ToolInputError).hint ?? '').toMatch(/uncompressed BMP, or as PNG or JPEG/);
  });

  it('converts an RLE8 BMP (comp 1) exactly where RLE4 is refused', async () => {
    // The control that keeps the gate honest: 8-bit run-length measured
    // pixel-exact at the dev build (maxdiff 0), so only comp=2 is refused.
    const outcome = await run('bmp-to-pdf', { pageSize: 'fit' }, [
      fileFrom(patchBmpCompression(bmpBytes(40, 24), 1), 'rle8.bmp', 'image/bmp'),
    ]);
    expect(await pageSizes(await firstPdf(outcome))).toEqual([[40, 24]]);
  });

  it('says the refusal on the bmp card too', () => {
    const notes = (getPdfTool('bmp-to-pdf')?.notes ?? []).join(' ');
    expect(notes).toMatch(/4-bit run-length BMP \(RLE4\) is refused by name/);
    expect(notes).toMatch(/8-bit run-length BMPs convert exactly/);
  });
});
