/**
 * svg-to-pdf refuses and explains in the browser's own words — measured ones.
 *
 * The malformed file (`sv-broken.svg`, an unclosed `<rect>`) used to be answered
 * by the decode route with "this browser has no decoder for SVG+XML": the file
 * needs a `</rect>`, not a different format. The run now asks the DOM parser
 * first, and that sentence is the file's own parse error named with the file.
 *
 * The two card sentences fixed here were measured against at :5296
 * (docs/research/convert-psd-svg-spec.json, runs8/9, convert-sp-measure.py):
 * a viewBox-only SVG with no `width`/`height` does not lay out "at 300 × 150" —
 * the 300 × 150 box is kept to the drawing's aspect (square viewBox → 150 × 150,
 * 2:1 → 300 × 150, page boxes measured); and the blanket "animations, filters
 * and external references are not reproduced" was wrong in both directions —
 * an `feGaussianBlur` rect arrives blurred (edge pixel 139 grey, core black), a
 * `data:` image arrives painted, while the SMIL animation is indeed frozen and
 * the missing external `<image href>` really is absent (0 non-white px).
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { CANVAS, fileFrom, firstPdf, installConvertToEnv, pageSizes, resetConvertToEnv, run } from './convert-to-harness';

// jsdom cannot measure an SVG box (the existing svg pins compare page to placed
// pixels for the same reason); the harness canvas reports these fixed dims for
// anything its header readers do not know, which is enough to prove the good
// file still reaches the painter whole.
const PAINTED = [[CANVAS.width, CANVAS.height]];

beforeAll(() => installConvertToEnv());
afterEach(() => resetConvertToEnv());

const GOOD = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"></svg>';
const BROKEN = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="5" height="5">';

describe('a broken SVG is refused as a broken SVG', () => {
  it('names the file and says the XML does not parse, not that the decoder is missing', async () => {
    const error = await run('svg-to-pdf', {}, [fileFrom(BROKEN, 'diagram.svg', 'image/svg+xml')])
      .catch((err) => err);
    const text = `${(error as Error).message} ${(error as { hint?: string }).hint ?? ''}`;
    // Red without the parser check: the only words this file got were
    // "this browser has no decoder for SVG+XML".
    expect(text).toMatch(/"diagram\.svg" is not well-formed XML/);
    expect(text).toMatch(/mismatched|unclosed|parser stopped|Line Number/i);
    expect(text).not.toMatch(/no decoder for SVG/);
  });

  it('converts the good file and names the broken one in the same batch', async () => {
    const outcome = await run('svg-to-pdf', { pageSize: 'fit', margin: 0 }, [
      fileFrom(GOOD, 'ok.svg', 'image/svg+xml'),
      fileFrom(BROKEN, 'diagram.svg', 'image/svg+xml'),
    ]);
    expect(await pageSizes(await firstPdf(outcome))).toEqual(PAINTED);
    expect(outcome.warnings.join(' ')).toMatch(/Skipped 1 file\(s\): "diagram\.svg" is not well-formed XML/);
  });

  it('keeps the control: well-formed markup still reaches the painter untouched', async () => {
    const outcome = await run('svg-to-pdf', { pageSize: 'fit', margin: 0 }, [
      fileFrom(GOOD, 'ok.svg', 'image/svg+xml'),
    ]);
    expect(await pageSizes(await firstPdf(outcome))).toEqual(PAINTED);
  });
});

describe('the SVG card states what the browser was measured doing', () => {
  it('sizes the no-width case by aspect, not by a flat 300 × 150', () => {
    const note = (getPdfTool('svg-to-pdf')?.notes ?? []).join(' ');
    expect(note).toMatch(/300 × 150 box, kept to the drawing’s aspect/);
    expect(note).toMatch(/square .* measures 150 × 150|square one 150 × 150/);
    // The old flat sentence, kept alone, promised a size no square drawing got.
    expect(note).not.toMatch(/laid out at the browser default 300 × 150, because/);
  });

  it('credits filters and data URLs and stops at animations and externals', () => {
    const note = (getPdfTool('svg-to-pdf')?.notes ?? []).join(' ');
    expect(note).toMatch(/SVG filter effects do paint/);
    expect(note).toMatch(/`data:` URL is kept/);
    expect(note).toMatch(/Animations never play/);
    expect(note).not.toMatch(/Animations, filters and external references .* are not reproduced/);
  });
});
