/**
 * `heic-to-pdf`, chunk c2: what a batch of refusals says, and what it never does.
 *
 * Measured on the dev build at :5296 (`docs/research/convert-heic-spec.json`,
 * records `/tmp/lane-convert/runs4.jsonl`, screenshots under
 * `/tmp/lane-convert/out/`): every file whose bytes are a picture of another
 * format is named and refused (`c2-allwrong`), every file whose bytes open in no
 * decoder of this browser is named and refused (`c2-single`, `c2-batch2`,
 * `c2-mixed`), and no such run produced a PDF — not even a blank page. The card's
 * standing note still claimed the gentle story ("named and left out") for a file
 * that is **not a picture at all**, but such a file is stopped by the shared gate
 * before the tool decodes anything: measured with an 8-byte `ftyp` stub named
 * `tiny.heic`, the run answered *"is binary data this converter cannot read"* and
 * produced no file — the same over-reach round c2 settled for the other six
 * routes, now closed for HEIC too.
 *
 * The video case is pinned as it behaves, not as it should: `sniffImageMime`
 * labels every ISO-BMFF file `image/heic` from its `ftyp` box alone, so an MP4
 * named `.heic` passes the format gate and is refused with the sentence about a
 * missing HEIC/HEIF decoder (`c2-mp4`). The refusal itself — named, no output —
 * is right; the reason clause misnames the format, and its cause is the shared
 * sniffer (`core/images.ts`, MAGIC_TABLE), which this lane may not edit.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { runPdfTool } from '@/lib/pdf/tools/runner';

const JPEG_UNDER_HEIC = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  ...new Array(20).fill(0x20),
  0xff, 0xd9,
]);

const PNG_UNDER_HEIC = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(24).fill(0x30),
]);

// `ftyp` at byte 4, brand `isom`: an MP4 container, named `.heic`.
const MP4_BYTES = new Uint8Array([
  0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
  0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
  0x61, 0x76, 0x63, 0x31, 0x6d, 0x70, 0x34, 0x31,
]);

// Too short for the sniffer's 12-byte window, and not a picture by any read.
const BINARY_STUB = new Uint8Array([0x00, 0x00, 0x00, 0x08, 0x66, 0x74, 0x79, 0x70]);

function file(bytes: Uint8Array, name: string): File {
  return new File([bytes], name, { type: 'image/heic' });
}

/**
 * Fail both decode routes on the next task, the way this Chrome for Testing 151
 * fails on real `ftypheic` bytes (measured: `createImageBitmap` rejects, `<img>`
 * errors — `/tmp/lane-convert/runs4.jsonl`, every `c2-*` record).
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

async function failure(files: File[]) {
  return (await runPdfTool({
    toolId: 'heic-to-pdf', files, values: {}, onProgress: () => {}, onLog: () => {},
  }).then((result) => result, (error: unknown) => error)) as {
    outputs?: unknown[]; message?: string; hint?: string;
  } & Error;
}

describe('the HEIC card discloses every way its batch stops', () => {
  it('says a non-picture names itself and stops the run (measured: c2-tiny)', () => {
    const note = (getPdfTool('heic-to-pdf')?.notes ?? [])[0] ?? '';
    // Red without the c2 copy fix: the HEIC note used to stop at "never silently
    // re-encoded." while a text file named `.heic` in fact halts the whole run
    // at the shared gate (`tools/runner.ts:inputKindProblem`, no PDF).
    expect(note).toMatch(/not a picture at all.*run stops before any page is made/s);
    // The example list is measured: a video named `.heic` is NOT a gate case —
    // the sniffer books it as HEIC and the decoder sentence refuses it (c2-mp4),
    // so the stop clause must not claim one.
    expect(note).toMatch(/text, a PDF, a ZIP, an MP3/);
    expect(note).not.toMatch(/MP4/);
    // And the decoder qualification the round-071 pin guards must survive.
    expect(note).toMatch(/where a decoder exists, the HEIC files beside it are still converted/);
  });
});

describe('a batch of refusals names every file and never prints a page', () => {
  it('names both wrong-format pictures and sends them to the HEIC remedy', async () => {
    // Measured c2-allwrong: the alert quoted both names with their real formats
    // and the hint was the format one — "Re-save the file as HEIC" — because a
    // batch with no failed decode is cured by renaming.
    const failureResult = await failure([file(JPEG_UNDER_HEIC, 'a.heic'), file(PNG_UNDER_HEIC, 'b.heic')]);
    const text = `${failureResult.message} ${failureResult.hint ?? ''}`;
    expect(text).toMatch(/"a\.heic" is a JPEG image, not a HEIC\/HEIF image\..*"b\.heic" is a PNG image, not a HEIC\/HEIF image\./s);
    expect(failureResult.hint ?? '').toMatch(/Re-save the file as HEIC/);
    expect(failureResult.hint ?? '').not.toMatch(/Safari/);
    expect(failureResult.outputs ?? [], 'a refused batch must not download a PDF').toEqual([]);
  });

  it('refuses an MP4 named .heic by name, with no PDF — the reason clause naming HEIC is a shared-seam defect (blocker: core/images.ts sniffImageMime)', async () => {
    refuseEveryDecoder();
    const failureResult = await failure([file(MP4_BYTES, 'clip.heic')]);
    const text = `${failureResult.message} ${failureResult.hint ?? ''}`;
    expect(text).toMatch(/"clip\.heic" could not be decoded/);
    // The sentence calls it HEIC/HEIF although the brand is `isom`: the catch-all
    // in `MAGIC_TABLE` labels every `ftyp` box `image/heic`. Pinned as measured
    // (c2-mp4) so a seam fix has to visit this file on purpose.
    expect(text).toMatch(/no decoder for HEIC\/HEIF/);
    expect(failureResult.hint ?? '').toMatch(/Re-save the photo as PNG or JPEG/);
    expect(failureResult.outputs ?? [], 'a refused video must not download a blank page').toEqual([]);
  });

  it('stops a file too short to sniff at the gate, naming it, before any decode', async () => {
    // Measured c2-tiny: `is binary data this converter cannot read, not one or
    // more HEIC images.` — no decoder stub needed; nothing reaches `decodeImage`.
    const failureResult = await failure([file(BINARY_STUB, 'tiny.heic')]);
    expect(failureResult.message).toMatch(/"tiny\.heic" is binary data this converter cannot read/);
    expect(failureResult.hint ?? '').toMatch(/Re-save the file as HEIC/);
    expect(failureResult.outputs ?? []).toEqual([]);
  });
});
