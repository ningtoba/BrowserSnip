/**
 * `image-to-pdf` is the parent: every format the alias routes take, it takes too,
 * and its card promises two of those routes outright — "Multi-page TIFFs become
 * multiple pages" and one page per image at the size you pick. The alias tools
 * have byte-level files of their own (`png-to-pdf-alpha`, `webp-to-pdf-reader`,
 * `bmp-to-pdf-header`); the parent's cross-format promises were only measured on
 * the live rail, never pinned here. This file pins what the rail measured on
 * 2026-11-25 (dev :5296, `docs/research/colour-rail.mjs`, specs in
 * `/tmp/lane-convert/spec.json`; every produced page matched its source pixels
 * with PyMuPDF at max channel difference ≤ 1):
 *
 *   - a two-frame TIFF gives two pages, in file order, each hugging its frame;
 *   - an animated WebP gives one page, not one per frame;
 *   - a file that is provably not a picture is named and the whole run stops —
 *     the parent has no "the files beside it are still converted" promise, and
 *     the refusal at the gate is the shipped, honest contract.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { webpFrameCount } from '@/lib/pdf/core/images';
import {
  concat,
  firstPdf,
  installConvertToEnv,
  pageSizes,
  realPng,
  resetConvertToEnv,
  restoreConvertToEnv,
  run,
  tiffBytes,
  uint32le,
  fileFrom,
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

/** A WebP carrying the animation flag and `frames` ANMF chunks (same builder as `webp-to-pdf-reader`). */
function chunk(type: string, payload: Uint8Array): Uint8Array {
  const padded = payload.length % 2 === 0 ? payload : concat(payload, new Uint8Array(1));
  return concat(new TextEncoder().encode(type), uint32le(padded.length), padded);
}
function riff(...chunks: Uint8Array[]): Uint8Array {
  const body = concat(new TextEncoder().encode('WEBP'), ...chunks);
  return concat(new TextEncoder().encode('RIFF'), uint32le(body.length), body);
}
function animatedWebp(frames: number, width = 24, height = 16): Uint8Array {
  const canvas = new Uint8Array(10);
  canvas[0] = 0x02; // the Animation flag
  const view = new DataView(canvas.buffer);
  view.setUint8(4, width - 1);
  view.setUint8(5, 0);
  view.setUint8(6, 0);
  view.setUint8(7, height - 1);
  const anim = new Uint8Array(6);
  const anmf = () => {
    const head = new Uint8Array(16);
    new DataView(head.buffer).setUint8(6, width - 1);
    new DataView(head.buffer).setUint8(9, height - 1);
    return chunk('ANMF', concat(head, chunk('VP8 ', new Uint8Array(10).fill(1))));
  };
  return riff(chunk('VP8X', canvas), chunk('ANIM', anim), ...Array.from({ length: frames }, anmf));
}

describe('the parent takes the formats its card names', () => {
  it('gives a two-frame TIFF one page per frame, in order, each hugging it', async () => {
    // The card: "Multi-page TIFFs become multiple pages." The alias pins this for
    // `tiff-to-pdf`; the parent carries the same sentence and had no pin.
    const bytes = await firstPdf(await run(
      'image-to-pdf',
      { pageSize: 'fit', margin: 0 },
      [fileFrom(tiffBytes([{ width: 30, height: 40 }, { width: 50, height: 20 }]), 'fax.tif', 'image/tiff')],
    ));
    expect(await pageSizes(bytes)).toEqual([[30, 40], [50, 20]]);
  });

  it('gives an animated WebP one page, not one per frame', async () => {
    // The fixture is honestly animated by its own container — `webpFrameCount`
    // reads four ANMF chunks, the same reader the notice on the alias cards uses.
    expect(webpFrameCount(animatedWebp(4))).toBe(4);
    const bytes = await firstPdf(await run(
      'image-to-pdf',
      { pageSize: 'fit', margin: 0 },
      [fileFrom(animatedWebp(4), 'walk.webp', 'image/webp')],
    ));
    // Four frames, one page. (The shared stub sizes a VP8X canvas from the
    // fallback box rather than the extended header; the count is the promise.
    // Which frame the browser paints — the first, and never a blend — was
    // measured off the live rail: a red/green/blue file landed red, pixel-exact.)
    expect(await pageSizes(bytes)).toHaveLength(1);
  });

  it('names a file that is provably not a picture and stops with no output', async () => {
    // Honest stop, named: the parent makes no per-file-continues promise (the
    // aliases do), and the gate refuses before anything is decoded (E2).
    const error = await run(
      'image-to-pdf',
      { pageSize: 'fit', margin: 0 },
      [fileFrom(realPng(12, 9), 'good.png'), fileFrom('just words wearing a .jpg name', 'fake.jpg')],
    ).catch((err: unknown) => err);
    const message = error instanceof Error ? error.message : JSON.stringify(error);
    expect(message).toMatch(/fake\.jpg/);
    expect(message).toMatch(/not a picture/);
  });

  it('control: the same batch with no impostor produces its pages', async () => {
    const bytes = await firstPdf(await run(
      'image-to-pdf',
      { pageSize: 'fit', margin: 0 },
      [fileFrom(realPng(12, 9), 'good.png')],
    ));
    expect(await pageSizes(bytes)).toEqual([[12, 9]]);
  });
});
