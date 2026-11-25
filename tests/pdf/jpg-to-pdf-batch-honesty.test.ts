/**
 * `jpg-to-pdf`'s batch card promises what the batch really does.
 *
 * Measured on the live rail (:5296, `docs/research/convert-raster-spec.json`):
 * a batch of [photo.jpg, fake.jpg (text), second.jpg] on JPG to PDF stopped
 * the whole run — alert `"fake.jpg" is a text file, not a picture.` — while
 * a batch of [photo.png among jpgs] named the PNG, left it out and shipped
 * the JPEG page ("1 JPG image(s) → 1 page(s). 1 file(s) left out."). Two
 * different files, two different outcomes, and the card promised the second
 * one for both: "A file that is not really a JPG is named and left out; the
 * JPG files beside it are still converted." For a text file beside two real
 * JPEGs that sentence is false — nothing is converted.
 *
 * The behaviour itself is defensible and lives in the shared runner
 * (`tools/runner.ts:inputKindProblem`, which refuses provable non-pictures
 * before any tool sees them), so the words move to meet the bytes, the same
 * way the HEIC tail of the same note was qualified when its mixed batch was
 * measured to convert nothing.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  fileFrom,
  firstPdf,
  installConvertToEnv,
  jpegBytes,
  pageSizes,
  realPng,
  resetConvertToEnv,
  restoreConvertToEnv,
  run,
} from './convert-to-harness';
import { getPdfTool } from '@/lib/pdf/tools/registry';

beforeAll(() => {
  installConvertToEnv();
});
afterEach(() => {
  resetConvertToEnv();
});
afterAll(() => {
  restoreConvertToEnv();
});

const FORMATS = ['jpg', 'png', 'webp', 'bmp', 'tiff', 'psd'];

describe('the family batch note says what the batch does', () => {
  it.each(FORMATS)('%s-to-pdf distinguishes a wrong picture from a non-picture', (format) => {
    const notes = getPdfTool(`${format}-to-pdf`)?.notes?.join(' ') ?? '';
    // A picture of another format: named, left out, the rest converts.
    expect(notes).toMatch(/is named and left out/);
    expect(notes).toMatch(/still converted/);
    // A file that is no picture at all: named, and the run stops. Red before
    // this round: the flat sentence promised the continue for text files too,
    // and the live batch proved the stop.
    expect(notes, 'the non-picture stop is not on the card').toMatch(/not a picture at all[\s\S]*stops/su);
  });

  it('names a file that is not a picture and produces no output at all', async () => {
    const error = await run(
      'jpg-to-pdf',
      { pageSize: 'fit', margin: 0 },
      [fileFrom(jpegBytes(30, 20), 'photo.jpg', 'image/jpeg'), fileFrom('just words wearing a .jpg name', 'fake.jpg', 'image/jpeg')],
    ).catch((err: unknown) => err);
    const message = error instanceof Error ? error.message : JSON.stringify(error);
    expect(message).toMatch(/fake\.jpg/);
    expect(message).toMatch(/not a picture/);
  });

  it('control: a real picture of the wrong format is named, left out, and the JPEG beside it ships', async () => {
    const outcome = await run(
      'jpg-to-pdf',
      { pageSize: 'fit', margin: 0 },
      [fileFrom(realPng(12, 9), 'x.jpg', 'image/jpeg'), fileFrom(jpegBytes(30, 20), 'y.jpg', 'image/jpeg')],
    );
    expect(outcome.message).toMatch(/1 file\(s\) left out/);
    expect(outcome.warnings?.join(' ')).toMatch(/"x\.jpg" is a PNG image, not a JPEG image — left out\./);
    // The page that shipped is the JPEG's, at the JPEG's own size.
    expect(await pageSizes(await firstPdf(outcome))).toEqual([[30, 20]]);
  });
});
