/**
 * psd-to-pdf converts previews, never layers — and says so truthfully.
 *
 * Measured at :5296 (docs/research/convert-psd-svg-spec.json, runs8, bytes by
 * convert-sp-measure.py): a JPEG-coded composite (compression 5) and an appended
 * PNG convert pixel-exact (maxdiff 0 against the embedded preview; 16-bit and
 * CMYK documents among them, because their previews carry 8-bit RGB), while the
 * raw/RLE/ZIP composites Photoshop itself writes were being refused with
 * "That PSD has no flattened preview embedded" — a sentence the file disproves,
 * since the flattened preview IS embedded, only in a coding this page cannot
 * open. The gate now walks the file's own section lengths and compression word
 * and refuses with the coding named; anything it cannot parse cleanly defers to
 * the old path, so the refusal only ever rests on stated facts.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { concat, fileFrom, firstPdf, installConvertToEnv, jpegBytes, pageSizes, psdBytes, resetConvertToEnv, run } from './convert-to-harness';

beforeAll(() => installConvertToEnv());
afterEach(() => resetConvertToEnv());

/** A PSD v1 with the given mode/depth, layer-section size and composite. */
function psd(channels: number, rows: number, cols: number, depth: number, mode: number, composite: Uint8Array): Uint8Array {
  const header = new Uint8Array(26);
  header.set([0x38, 0x42, 0x50, 0x53]);
  const view = new DataView(header.buffer);
  view.setUint16(4, 1, false);
  view.setUint16(12, channels, false);
  view.setUint32(14, rows, false);
  view.setUint32(18, cols, false);
  view.setUint16(22, depth, false);
  view.setUint16(24, mode, false);
  const empty = (n: number) => concat(new Uint8Array([0, 0, 0, n]), new Uint8Array(n));
  return concat(header, empty(0), empty(0), empty(0), composite);
}

const coded = (compression: number, payload: Uint8Array): Uint8Array =>
  concat(new Uint8Array([0, 0, compression >> 8, compression & 0xff]), payload);

const RLE_PAYLOAD = new Uint8Array(16 * 24 * 3).fill(0x5a); // no JPEG/PNG magic inside

describe('a PSD whose preview exists but cannot be opened says the true cause', () => {
  it('names the run-length coding instead of denying the preview exists', async () => {
    const error = await run('psd-to-pdf', { pageSize: 'fit' }, [
      fileFrom(psd(3, 16, 24, 8, 3, coded(1, RLE_PAYLOAD)), 'artwork.psd', 'image/vnd.adobe.photoshop'),
    ]).catch((err) => err);
    const text = (error as Error).message;
    // Red without the gate: this file was refused as having "no flattened
    // preview embedded" — the composite section right there says otherwise.
    expect(text).toMatch(/"artwork\.psd" keeps its flattened picture as run-length encoded/);
    expect(text).toMatch(/cannot open/);
    expect(text).not.toMatch(/no flattened preview embedded/);
    expect((error as { hint?: string }).hint ?? '').toMatch(/flattened PNG or JPEG/);
  });

  it('says 16-bit and CMYK in the refusal when the header says them', async () => {
    const raw = (n: number) => coded(0, new Uint8Array(16 * 24 * n).fill(0x11));
    const deep = await run('psd-to-pdf', {}, [
      fileFrom(psd(3, 16, 24, 16, 3, raw(3)), 'deep.psd', 'image/vnd.adobe.photoshop'),
    ]).catch((err) => err);
    expect((deep as Error).message).toMatch(/uncompressed 16-bit channel data/);
    const cmyk = await run('psd-to-pdf', {}, [
      fileFrom(psd(4, 16, 24, 8, 4, raw(4)), 'press.psd', 'image/vnd.adobe.photoshop'),
    ]).catch((err) => err);
    expect((cmyk as Error).message).toMatch(/uncompressed CMYK channel data/);
  });

  it('converts the previews that do open, pixel-box exact, and leaves the rest refused in a batch', async () => {
    const outcome = await run('psd-to-pdf', { pageSize: 'fit' }, [
      fileFrom(psd(3, 16, 24, 8, 3, coded(5, jpegBytes(24, 16))), 'compat.psd', 'image/vnd.adobe.photoshop'),
      fileFrom(psd(3, 16, 24, 8, 3, coded(2, RLE_PAYLOAD)), 'zipped.psd', 'image/vnd.adobe.photoshop'),
    ]);
    expect(await pageSizes(await firstPdf(outcome))).toEqual([[24, 16]]);
    expect(outcome.message).toMatch(/1 PSD image\(s\) → 1 page\(s\)\. 1 file\(s\) left out\./);
    expect(outcome.warnings.join(' ')).toMatch(/"zipped\.psd" keeps its flattened picture as ZIP.*left out/s);
  });

  it('keeps the appended-PNG route of the header guard working', async () => {
    // The harness's own PSD (header + PNG bytes) is the long-standing accepted
    // shape; the gate must not touch it: 0x8950 is not a PSD compression code,
    // so the file defers to the reader, which finds its PNG.
    const outcome = await run('psd-to-pdf', { pageSize: 'fit' }, [
      fileFrom(psdBytes(30, 20), 'legacy.psd', 'image/vnd.adobe.photoshop'),
    ]);
    expect(await pageSizes(await firstPdf(outcome))).toEqual([[30, 20]]);
  });

  it('says on the card what converts and what is refused, parent included', () => {
    const notes = (getPdfTool('psd-to-pdf')?.notes ?? []).join(' ');
    expect(notes).toMatch(/never re-composed here/);
    expect(notes).toMatch(/run-length or ZIP-coded .* is refused by name with its coding named/);
    expect(notes).toMatch(/16-bit and CMYK documents among them/);
    expect((getPdfTool('image-to-pdf')?.notes ?? []).join(' ')).toMatch(/flattened preview the file itself carries/);
  });
});
