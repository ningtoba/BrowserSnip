/**
 * `heic-to-pdf`, measured where it can only be measured: in a browser.
 *
 * Two real HEIC files — `tiny.heic` (32 KB, 356x356) and `ios.heic` (472 B, 12x7), both
 * `ftypheic` + `hvc1`, both decoded without complaint by Pillow/pi_heif on this
 * machine — were handed to Chrome for Testing 151. `createImageBitmap` threw
 * `InvalidStateError`, `<img>` fired `onerror`, and the tool run produced **no PDF at
 * all** while naming the reason per file: *"\"tiny.heic\" could not be decoded: this
 * browser has no decoder for HEIC/HEIF … Convert the file to PNG or JPEG"*
 * (`docs/research/heic-deployed.log`, reproduced by
 * `node docs/research/verify-heic-run.mjs`).
 *
 * So HEIC support here is a fact about the platform, not about this app: the page owns
 * no decoder and cannot be made to have one. What this app does own is whether that is
 * said out loud, which is what the cases below pin — the card's wording, and the
 * refusal of bytes that are not what the extension claims. The over-reach it found in
 * `core/images.ts` ("or open it in Safari or Chrome 130+", measured false on Chrome 151
 * on Linux) belongs to that module and is written up in
 * `docs/tasks/heic-decoder-claim-ticket.md`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import { sniffImageMime } from '@/lib/pdf/core/images';

const JPEG_UNDER_HEIC = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  ...new Array(20).fill(0x20),
  0xff, 0xd9,
]);

const HEIC_MAGIC = new Uint8Array([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0x00, 0x00, 0x00, 0x00,
  0x6d, 0x69, 0x66, 0x31, 0x68, 0x65, 0x69, 0x63,
]);

/**
 * Fail both decode routes on the next task instead of waiting out the deadline.
 *
 * jsdom has no `createImageBitmap` and never fires `load` or `error` on an `<img>`,
 * so the real refusal takes the whole 30 s bound. Both routes are modelled the way
 * a decoder-less engine behaves: the bitmap API rejects and the element errors.
 */
function refuseEveryDecoder(): void {
  vi.stubGlobal('createImageBitmap', () => Promise.reject(new Error('The source image could not be decoded.')));
  class RefusingImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) {
      setTimeout(() => this.onerror?.(), 0);
    }
  }
  vi.stubGlobal('Image', RefusingImage);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function run(id: string, files: File[], values: Record<string, unknown> = {}) {
  return (await runPdfTool({
    toolId: id, files, values, onProgress: () => {}, onLog: () => {},
  })) as unknown as { outputs: unknown[]; message?: string; warnings: string[] };
}

describe('a HEIC run says what this browser cannot do', () => {
  it('qualifies its own promise on the card that makes it', () => {
    const heic = getPdfTool('heic-to-pdf');
    expect(heic, 'heic-to-pdf is not registered').toBeTruthy();
    const notes = `${heic?.promise} ${(heic?.notes ?? []).join(' ')}`;
    expect(notes).toMatch(/decoded by the browser and the operating system|browser decoder/i);
    expect(notes).toMatch(/no PDF is produced|refused by name/i);
    // The card that says "Every HEIC you add becomes a PDF page" must be the one that
    // also says when it does not, or the promise is the bytes' to contradict.
    expect(heic?.promise).toMatch(/Every HEIC you add becomes its own PDF page, the size of the picture/);
    expect((getPdfTool('image-to-pdf')?.notes ?? []).join(' '))
      .toMatch(/HEIC.*browser decoder/i);
  });

  it('refuses bytes that are a JPEG wearing a .heic name, by name', async () => {
    const failure = await run('heic-to-pdf', [
      new File([JPEG_UNDER_HEIC], 'photo.heic', { type: 'image/heic' }),
    ]).catch((error: unknown) => error);
    const text = failure instanceof Error ? failure.message : JSON.stringify(failure);
    expect(text).toMatch(/photo\.heic/);
    expect(text).toMatch(/JPEG/i);
    expect(text).toMatch(/not a HEIC|not a HEIC\/HEIF|Re-save|convert/i);
  });

  it('names the file rather than guessing when decoding is impossible', async () => {
    // The 472-byte iOS sample: real `ftypheic` bytes, which no decoder in jsdom (or in
    // this Chrome) can open, so the run must say which file failed and produce nothing.
    const heicMagic = new Uint8Array([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0x00, 0x00, 0x00, 0x00,
      0x6d, 0x69, 0x66, 0x31, 0x68, 0x65, 0x69, 0x63,
    ]);
    const failure = await run('heic-to-pdf', [
      new File([heicMagic], 'tiny.heic', { type: 'image/heic' }),
    ]).catch((error: unknown) => error);
    const text = failure instanceof Error ? failure.message : JSON.stringify(failure);
    expect(text).toMatch(/tiny\.heic/);
    expect(text).toMatch(/could not be decoded|no decoder|could not be opened/i);
    expect(text).toMatch(/PNG or JPEG/i);
    // The decoder is bounded on purpose (`core/images` never waits on an image event
    // that may not fire), so the refusal arrives even for a truncated HEIC; it must
    // arrive inside that bound rather than as a spinner the user escapes by reload.
  }, 40_000);
});

/**
 * Round 071: the sentences and the detection the refusal rests on.
 *
 * Every case here failed on the build before the round: the hint sent a HEIC owner
 * to "re-save it as HEIC", the format list printed one format twice, and the
 * closing advice named a browser version that the bytes on this machine contradict.
 */
describe('the refusal says the true thing about HEIC', () => {
  it('reads `ftyp` at byte 4, both directions, so a HEIC under any name is sniffed', () => {
    // A `ftyp` box starts with its own length (bytes 0-3), so the brand begins at 4.
    // A sniffer that looked at 0 sees nothing; one that looks at 4 cannot be fooled by
    // a name either way.
    expect(sniffImageMime(HEIC_MAGIC)).toBe('image/heic');
    expect(sniffImageMime(JPEG_UNDER_HEIC)).toBe('image/jpeg');
  });

  it('refuses HEIC bytes wearing a .jpg name as the HEIC they are', async () => {
    const failure = await run('jpg-to-pdf', [
      new File([HEIC_MAGIC], 'renamed.jpg', { type: 'image/jpeg' }),
    ]).catch((error: unknown) => error);
    const text = failure instanceof Error ? failure.message : JSON.stringify(failure);
    expect(text).toMatch(/renamed\.jpg/);
    expect(text).toMatch(/is a HEIC\/HEIF image, not a JPEG image/);
  });

  it('names one format once, not "a HEIC/HEIF image or a HEIF image"', async () => {
    const failure = await run('heic-to-pdf', [
      new File([JPEG_UNDER_HEIC], 'photo.heic', { type: 'image/heic' }),
    ]).catch((error: unknown) => error);
    const text = failure instanceof Error ? failure.message : JSON.stringify(failure);
    expect(text).toMatch(/not a HEIC\/HEIF image\./);
    expect(text).not.toMatch(/or a HEIF image/);
  });

  it('tells a HEIC owner to change container, not to re-save the HEIC as HEIC', async () => {
    refuseEveryDecoder();
    const failure = await run('heic-to-pdf', [
      new File([HEIC_MAGIC], 'tiny.heic', { type: 'image/heic' }),
    ]).catch((error: unknown) => error);
    const hint = (failure as { hint?: string }).hint ?? '';
    expect(hint, 'a HEIC refused without a route out of HEIC').toMatch(/PNG or JPEG/);
    expect(hint).not.toMatch(/Re-save the file as HEIC/);
    // The same remedy reaches a mixed batch, where the decode failure is the one a
    // rename cannot cure.
    const mixed = await run('heic-to-pdf', [
      new File([JPEG_UNDER_HEIC], 'wrong.heic', { type: 'image/heic' }),
      new File([HEIC_MAGIC], 'real.heic', { type: 'image/heic' }),
    ]).catch((error: unknown) => error);
    expect((mixed as { hint?: string }).hint ?? '').toMatch(/PNG or JPEG/);
    expect((mixed as Error).message).toMatch(/wrong\.heic.*real\.heic/s);
  });

  it('does not attribute the decoder to a browser version the bytes contradict', async () => {
    refuseEveryDecoder();
    const failure = await run('image-to-pdf', [
      new File([HEIC_MAGIC], 'tiny.heic', { type: 'image/heic' }),
    ]).catch((error: unknown) => error);
    const text = failure instanceof Error ? failure.message : JSON.stringify(failure);
    // Measured: Chrome for Testing 151 on Linux has no HEIC decoder, so "Chrome 130+"
    // sent a reader back to the same refusal. The platform owns the codec.
    expect(text).not.toMatch(/Chrome 130/);
    expect(text).toMatch(/browser whose platform can decode/i);
  });

  it('qualifies the "files beside it are still converted" line with a decoder', () => {
    const notes = (getPdfTool('heic-to-pdf')?.notes ?? []).join(' ');
    expect(notes).toMatch(/where a decoder exists, the HEIC files beside it/);
  });
});
