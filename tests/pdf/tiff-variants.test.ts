/**
 * Codings that decode *wrong* rather than loudly, and the gates that refuse them.
 *
 * Measured at :5296 (`docs/research/convert-bmp-tiff-spec.json`, runs6, bytes
 * compared by `docs/research/convert-bt-measure.py`):
 *
 * - a JPEG-compressed TIFF and a planar-configuration-2 RGB TIFF both came back
 *   as *successful* one-page PDFs whose pixels disagreed with the same files
 *   opened by Pillow/libjpeg (max channel diff 255 on every pixel measured);
 * - a 4-bit run-length BMP (both encodings the SDK documents) was answered by
 *   Chrome for Testing 151 with a fully transparent bitmap — a blank page
 *   printed under the card's own `1 BMP image(s) → 1 page(s)`;
 * - while none, LZW, Deflate, palette, 1-bit Group 4, 16-bit (exact high byte)
 *   and 8-bit RLE all matched their source pixel for pixel.
 *
 * A wrong page is worse than no page, so the first three are refused on the
 * file's own header words, before the decoder is asked, and the cards say which
 * codings convert and which are refused.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { ToolInputError } from '@/lib/pdf/core/guard';
import {
  bmpBytes, fileFrom, firstPdf, installConvertToEnv, pageSizes, resetConvertToEnv, run, tiffBytes,
} from './convert-to-harness';

beforeAll(() => installConvertToEnv());
afterEach(() => resetConvertToEnv());

/** Set a SHORT-valued IFD entry (inline, count 1) on every page of a TIFF. */
function patchTiffTag(bytes: Uint8Array, tag: number, value: number): Uint8Array {
  const copy = bytes.slice();
  const view = new DataView(copy.buffer);
  // The harness builds its TIFFs with UTIF, which encodes big-endian; PIL and
  // most files on disk are little-endian. Read whichever the file declares.
  const le = copy[0] === 0x49 && copy[1] === 0x49;
  const u16 = (at: number) => view.getUint16(at, le);
  const u32 = (at: number) => view.getUint32(at, le);
  let at = u32(4);
  for (let guard = 0; guard < 64 && at; guard += 1) {
    const count = u16(at);
    for (let i = 0; i < count; i += 1) {
      const entry = at + 2 + i * 12;
      if (u16(entry) === tag && u16(entry + 2) === 3) {
        view.setUint16(entry + 8, value, le);
      }
    }
    at = u32(at + 2 + count * 12);
  }
  return copy;
}

/** The same for the one BMP header word the gate reads. */
function patchBmpCompression(bytes: Uint8Array, value: number): Uint8Array {
  const copy = bytes.slice();
  new DataView(copy.buffer).setUint32(30, value, true);
  return copy;
}

const TIFF_40x24 = () => tiffBytes([{ width: 40, height: 24 }]);

describe('a TIFF the reader colours wrongly is refused, not shipped', () => {
  it('refuses a JPEG-compressed TIFF by name and keeps its remedy in the hint', async () => {
    const error = await run('tiff-to-pdf', { pageSize: 'fit' }, [
      fileFrom(patchTiffTag(TIFF_40x24(), 259, 7), 'scan.tif', 'image/tiff'),
    ]).catch((err) => err);
    expect((error as Error).message).toMatch(/"scan\.tif" keeps its picture as JPEG inside the TIFF/);
    expect((error as ToolInputError).hint ?? '').toMatch(/uncompressed or with LZW\/Deflate/);
  });

  it('refuses a planar-2 TIFF on the tag the file states', async () => {
    const error = await run('tiff-to-pdf', { pageSize: 'fit' }, [
      fileFrom(patchTiffTag(TIFF_40x24(), 284, 2), 'planes.tif', 'image/tiff'),
    ]).catch((err) => err);
    expect((error as Error).message).toMatch(/planar configuration 2/);
    expect((error as Error).message).toMatch(/reassembles wrongly/);
  });

  it('leaves the codings that measure exact alone — planar 1 and LZW convert', async () => {
    // Controls: the gate may only fire on what it measured wrong. A plain
    // multi-page TIFF (compression 1, planar 1) still produces its pages.
    const outcome = await run('tiff-to-pdf', { pageSize: 'fit' }, [
      fileFrom(TIFF_40x24(), 'plain.tif', 'image/tiff'),
    ]);
    expect(await pageSizes(await firstPdf(outcome))).toEqual([[40, 24]]);
  });

  it('names the refused variant beside a good page and still converts the rest', async () => {
    const outcome = await run('tiff-to-pdf', { pageSize: 'fit' }, [
      fileFrom(patchTiffTag(TIFF_40x24(), 259, 6), 'old-jpeg.tif', 'image/tiff'),
      fileFrom(tiffBytes([{ width: 30, height: 20 }]), 'plain.tif', 'image/tiff'),
    ]);
    expect(await pageSizes(await firstPdf(outcome))).toEqual([[30, 20]]);
    expect(outcome.warnings.join(' ')).toMatch(/"old-jpeg\.tif" keeps its picture as JPEG.*left out/);
  });

  it('refuses the same file on the parent route, which shares the reader', async () => {
    const error = await run('image-to-pdf', {}, [
      fileFrom(patchTiffTag(TIFF_40x24(), 284, 2), 'planes.tif', 'image/tiff'),
    ]).catch((err) => err);
    expect((error as Error).message).toMatch(/"planes\.tif" keeps its colour planes in separate strips/);
  });

  it('tells the tiff card which codings convert and which are refused', () => {
    const notes = (getPdfTool('tiff-to-pdf')?.notes ?? []).join(' ');
    expect(notes).toMatch(/planar configuration 2\), is named and refused/);
    expect(notes).toMatch(/16-bit TIFF keeps its 8-bit high byte, pixel-exact/);
    // The parent shares the reader, so the parent card owes the same sentence.
    expect((getPdfTool('image-to-pdf')?.notes ?? []).join(' '))
      .toMatch(/A TIFF stores its pixels in one of many codings/);
  });
});

