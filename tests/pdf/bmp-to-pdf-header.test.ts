/**
 * The BMP *header* as a contract, and the two places a BMP lies about it.
 *
 * A BMP header states, in bytes, exactly how much pixel array the file must
 * carry (`biSizeImage`, `biBitCount`, the row stride) and where it starts
 * (`bfOffBits`). Chrome does not check: handed a 243 x 160 file cut after 10
 * rows it paints the ten rows it has, invents 150 white ones, and reports
 * nothing — measured on the dev build, where that file embedded as a complete
 * 243 x 160 page and the card said `5 BMP image(s) → 5 page(s)` with no warning.
 * Pillow calls the same file `truncated`.
 *
 * So the reader refuses a short BMP by name, and — the other half of the pin —
 * keeps accepting the three ways a *valid* BMP's numbers can look odd: a zero
 * `bfSize`, a zero `biSizeImage` and appended bytes. A reader that refuses on
 * "the numbers do not add up" instead of "the file is short" would fail those.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { bmpBytes, bmpTruncate, fileFrom, firstPdf, installConvertToEnv, pageSizes, resetConvertToEnv, run } from './convert-to-harness';

beforeAll(() => installConvertToEnv());
afterEach(() => resetConvertToEnv());

/** Move a header field without changing the pixel array. */
function patch(bytes: Uint8Array, at: number, value: number, width = 4): Uint8Array {
  const copy = bytes.slice();
  const view = new DataView(copy.buffer);
  if (width === 4) view.setUint32(at, value, true);
  else view.setUint16(at, value, true);
  return copy;
}

describe('bmp-to-pdf reads the header rather than trusting the decoder', () => {
  it('places a complete bottom-up BMP at its own pixel size', async () => {
    const outcome = await run('bmp-to-pdf', { pageSize: 'fit' }, [
      fileFrom(bmpBytes(40, 24), 'whole.bmp', 'image/bmp'),
    ]);
    expect(await pageSizes(await firstPdf(outcome))).toEqual([[40, 24]]);
  });

  it('places a top-down BMP the same size, not upside down in the header read', async () => {
    const outcome = await run('bmp-to-pdf', { pageSize: 'fit' }, [
      fileFrom(bmpBytes(40, 24, true), 'down.bmp', 'image/bmp'),
    ]);
    expect(await pageSizes(await firstPdf(outcome))).toEqual([[40, 24]]);
  });

  it('refuses a BMP that ends before the rows its header describes, and converts the rest', async () => {
    const outcome = await run('bmp-to-pdf', { pageSize: 'fit' }, [
      fileFrom(bmpTruncate(bmpBytes(40, 24), 6), 'cut.bmp', 'image/bmp'),
      fileFrom(bmpBytes(40, 24), 'whole.bmp', 'image/bmp'),
    ]);
    // The refusal is the sentence, not a count: it names the file, both numbers,
    // and the band the user would have got.
    const said = outcome.warnings.join(' ');
    expect(said).toMatch(/cut\.bmp/);
    expect(said).toMatch(/18 row\(s\) at its top would come out blank/);
    expect(said).toMatch(/left out/);
    // Once, not twice: the runner promotes a logged line containing "could not"
    // into warnings, so a refusal that was also logged reached the card in both
    // forms — the pushed sentence and `cut.bmp was left out: <the same sentence>`.
    expect(outcome.warnings.filter((line) => line.includes('cut.bmp'))).toHaveLength(1);
    // ...and the batch-mate still lands, alone.
    expect(await pageSizes(await firstPdf(outcome))).toEqual([[40, 24]]);
  });

  it('says "bottom" for a top-down file cut short', async () => {
    const outcome = await run('bmp-to-pdf', { pageSize: 'fit' }, [
      fileFrom(bmpTruncate(bmpBytes(40, 24, true), 6), 'down.bmp', 'image/bmp'),
      fileFrom(bmpBytes(40, 24), 'whole.bmp', 'image/bmp'),
    ]);
    expect(outcome.warnings.join(' ')).toMatch(/18 row\(s\) at its bottom/);
  });

  it('refuses a single cut BMP by name, with no page at all', async () => {
    await expect(run('bmp-to-pdf', { pageSize: 'fit' }, [
      fileFrom(bmpTruncate(bmpBytes(40, 24), 6), 'only.bmp', 'image/bmp'),
    ])).rejects.toThrow(/only\.bmp.*would come out blank/s);
  });

  it('refuses a header that points the pixels past the end of the file', async () => {
    const outcome = await run('bmp-to-pdf', { pageSize: 'fit' }, [
      fileFrom(patch(bmpBytes(40, 24), 10, 4000), 'offset.bmp', 'image/bmp'),
      fileFrom(bmpBytes(40, 24), 'whole.bmp', 'image/bmp'),
    ]);
    expect(outcome.warnings.join(' ')).toMatch(/points the pixels at byte 4000, past the \d+ byte\(s\)/);
  });

  it('refuses a header that points the pixels inside the header itself', async () => {
    const outcome = await run('bmp-to-pdf', { pageSize: 'fit' }, [
      fileFrom(patch(bmpBytes(40, 24), 10, 18), 'inside.bmp', 'image/bmp'),
      fileFrom(bmpBytes(40, 24), 'whole.bmp', 'image/bmp'),
    ]);
    expect(outcome.warnings.join(' ')).toMatch(/header and palette alone run to byte 54/);
  });

  it('keeps a complete BMP whose bfSize is left at zero', async () => {
    const outcome = await run('bmp-to-pdf', { pageSize: 'fit' }, [
      fileFrom(patch(bmpBytes(40, 24), 2, 0), 'nobfsize.bmp', 'image/bmp'),
    ]);
    expect(await pageSizes(await firstPdf(outcome))).toEqual([[40, 24]]);
  });

  it('keeps a complete BMP whose biSizeImage is left at zero', async () => {
    const outcome = await run('bmp-to-pdf', { pageSize: 'fit' }, [
      fileFrom(patch(bmpBytes(40, 24), 34, 0), 'noimage.bmp', 'image/bmp'),
    ]);
    expect(await pageSizes(await firstPdf(outcome))).toEqual([[40, 24]]);
  });

  it('keeps a complete BMP with bytes appended after the pixels', async () => {
    const bytes = bmpBytes(40, 24);
    const padded = new Uint8Array([...bytes, ...new Uint8Array(1024)]);
    const outcome = await run('bmp-to-pdf', { pageSize: 'fit' }, [
      fileFrom(padded, 'padded.bmp', 'image/bmp'),
    ]);
    expect(await pageSizes(await firstPdf(outcome))).toEqual([[40, 24]]);
  });

  it('keeps a BMP this app wrote itself', async () => {
    // `pdf-to-bmp` writes through `encodeBmp`; the reader's stride has to agree
    // with the writer's or a round trip fails on its own output.
    const canvas = { width: 3, height: 2, getContext: () => (globalThis.document.createElement('canvas')).getContext('2d') } as unknown as HTMLCanvasElement;
    const bytes = new Uint8Array(await (await import('@/lib/pdf/core/raster')).encodeBmp(canvas).arrayBuffer());
    const outcome = await run('bmp-to-pdf', { pageSize: 'fit' }, [fileFrom(bytes, 'own.bmp', 'image/bmp')]);
    expect(await pageSizes(await firstPdf(outcome))).toEqual([[3, 2]]);
  });

  it('keeps a 32-bit BMP, whose header carries three colour masks before the pixels', async () => {
    // BI_BITFIELDS keeps its masks between the 40-byte header and the pixels, so
    // the offset is 66 here, not 54. A reader that assumed 54 would refuse it.
    const width = 4;
    const stride = 16;
    const bytes = new Uint8Array(66 + stride * 2);
    bytes.set([0x42, 0x4d], 0);
    const view = new DataView(bytes.buffer);
    view.setUint32(2, bytes.length, true);
    view.setUint32(10, 66, true);
    view.setUint32(14, 40, true);
    view.setInt32(18, width, true);
    view.setInt32(22, 2, true);
    view.setUint16(26, 1, true);
    view.setUint16(28, 32, true);
    view.setUint32(30, 3, true);
    view.setUint32(34, stride * 2, true);
    const outcome = await run('bmp-to-pdf', { pageSize: 'fit' }, [fileFrom(bytes, 'mask.bmp', 'image/bmp')]);
    expect(await pageSizes(await firstPdf(outcome))).toEqual([[4, 2]]);
  });

  it('leaves a header it does not model to the browser instead of guessing', async () => {
    // BITMAPCOREHEADER (12 bytes) puts every field somewhere else; the reader
    // says nothing about it rather than measuring it with the wrong offsets.
    const bytes = bmpBytes(40, 24);
    const core = patch(bytes, 14, 12);
    const outcome = await run('bmp-to-pdf', { pageSize: 'fit' }, [fileFrom(core, 'core.bmp', 'image/bmp')]);
    expect(await pageSizes(await firstPdf(outcome))).toEqual([[40, 24]]);
  });
});

describe('the card says so before the run', () => {
  it('warns that a cut BMP is refused, and only on the BMP card', () => {
    const notes = (id: string) => (getPdfTool(id)?.notes ?? []).join(' ');
    expect(notes('bmp-to-pdf')).toMatch(/checked against it/);
    expect(notes('bmp-to-pdf')).toMatch(/cut short/);
    expect(notes('jpg-to-pdf')).not.toMatch(/BMP header states/);
  });
});

describe('the refusal is the reader’s, so every tool that decodes a BMP gets it', () => {
  it('image-to-pdf names a cut BMP too', async () => {
    // That route throws on the first undecodable file instead of collecting it
    // (it is a batch tool, and a separate open item), so the pin is the sentence.
    expect(getPdfTool('image-to-pdf')).toBeTruthy();
    await expect(run('image-to-pdf', { pageSize: 'fit' }, [
      fileFrom(bmpTruncate(bmpBytes(40, 24), 6), 'cut.bmp', 'image/bmp'),
    ])).rejects.toThrow(/cut\.bmp.*would come out blank/s);
  });
});
