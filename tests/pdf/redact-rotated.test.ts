/**
 * `redact-pdf` on a turned sheet — the mark, the words and the card all have to
 * follow the page as it is painted.
 *
 * Reported by the security lane as “a `/Rotate 90` mark lands ~490 pt off, mirrored,
 * and deletes nothing”, blamed on `core/tables.ts` missing a height flip in
 * `viewerRectToUserSpace`. Measured with the reader as the bar, that arm is exact,
 * and the two numbers the report quoted were the report's own units error:
 *
 *   * MuPDF boxes the line `MIKE ten NOVEMBER eleven` (user space, `Tm 1 0 0 1 60 722`,
 *     16 pt Helvetica) at `x 130.3..221.8, y 102.8..124.8` **unrotated**, and its
 *     `rotation_matrix` `[0, 1, -1, 0, 842, 0]` puts that sentence on the painted
 *     842×595 sheet as a vertical strip at `x 717.2..739.2, y 130.3..221.8` — which
 *     is where the ink is (a 72 dpi render of the sheet measures ink columns
 *     `x 687..733`, rows `y 60..272`, 26 columns against 208 rows).
 *   * Dragging across *that* strip and turning the mark back with
 *     `viewerRectToUserSpace` gives user `130 717 222 740` against MuPDF's word box
 *     `130.3 718.7 221.8 733.5`: **0.8 pt**, on the word, not 490 pt off it. The
 *     490 pt was `redact-c3-measure.py` derotating boxes MuPDF had already returned
 *     unrotated, and the drag it aimed by displayed fractions was aimed at blank
 *     paper — so “the pane refuses a turned sheet” was the instrument, and the
 *     refusal it printed was correct.
 *
 * What *was* broken on a turned sheet is the pair of places that treat a run's box
 * as if the characters always run left to right, plus the base-14 metrics that
 * `redact-residue.test.ts` pins:
 *
 *   * `redact-pdf`'s word report shared a run's box out along x, so every word of a
 *     sentence inherited the sentence's centre: a mark over one word named its three
 *     untouched neighbours “still extractable … under the marked areas”, and a
 *     redaction that had worked read as one that had not.
 *   * The pane clipped a snapped line along x as well, so a one-word drag on a
 *     `/Rotate 90` sheet marked the whole line: measured live on this fixture, the
 *     produced content was `[ -13338 ] TJ` — every glyph of the sentence, 213.4 pt
 *     of displacement — with a fill `60 719 213 16 re` over all four words.
 *
 * Both now ask one question of one helper, `advancesAlongYAxis`. The assertions
 * below are on the produced bytes and on the card's own sentence, and the
 * rotate-0 sheet is pinned alongside as the control that the axis test did not
 * simply flip.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import { inflateSync } from 'node:zlib';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFStream, StandardFonts, degrees, rgb } from '@maxwbh/pdf-lib';
import { runPdfTool, type RunOutcome } from '@/lib/pdf/tools/runner';
import type { ToolValues } from '@/lib/pdf/tools/types';
import { advancesAlongYAxis, viewerRectToUserSpace } from '@/lib/pdf/core/tables';
import { clipLinesToDrag } from '@/components/tools/pdf/security/RedactMain';
import type { SnappedLine } from '@/components/tools/pdf/editor/quads';

beforeAll(() => {
  let workerPath = `file://${process.cwd()}/node_modules/pdfjs-dist/build/pdf.worker.mjs`;
  Object.defineProperty(GlobalWorkerOptions, 'workerSrc', {
    configurable: true,
    get: () => workerPath,
    set: (value: string) => {
      if (value.startsWith('file:') || value.startsWith('data:')) workerPath = value;
    },
  });
});

const latin1 = new TextDecoder('latin1');
const PAGE: [number, number] = [595, 842];
/** Where the reader paints the sentence: user space, baseline at y 722. */
const BASELINE = 722;
const SIZE = 16;
const LINE = 'MIKE ten NOVEMBER eleven';

/**
 * One `/Rotate 90` sheet, drawn the way MuPDF draws a turned page: the text matrix
 * stays upright in user space, so on screen the sentence is a vertical strip and
 * every coordinate the pane works in is a quarter turn from the content's.
 */
async function turnedFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage(PAGE);
  page.setRotation(degrees(90));
  page.drawText(LINE, { x: 60, y: BASELINE, size: SIZE, font, color: rgb(0, 0, 0) });
  return doc.save({ useObjectStreams: false });
}

async function flatFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage(PAGE);
  page.drawText(LINE, { x: 60, y: BASELINE, size: SIZE, font, color: rgb(0, 0, 0) });
  return doc.save({ useObjectStreams: false });
}

async function run(values: ToolValues, bytes: Uint8Array): Promise<RunOutcome> {
  const outcome = await runPdfTool({
    toolId: 'redact-pdf',
    files: [new File([new Uint8Array(bytes) as BlobPart], 'turn.pdf', { type: 'application/pdf' })],
    values: { fill: '#000000', alsoMetadata: false, ...values },
    onProgress: () => undefined,
    onLog: () => undefined,
  });
  expect(outcome, 'the run returned nothing').toBeTruthy();
  return outcome!;
}

async function load(outcome: RunOutcome): Promise<PDFDocument> {
  const bytes = new Uint8Array(await outcome.outputs[0].blob.arrayBuffer());
  return PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
}

async function streams(outcome: RunOutcome): Promise<string> {
  const doc = await load(outcome);
  return doc.getPages().map((page) => {
    const contents = page.node.Contents();
    const entries = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
    return entries.map((entry) => {
      const stream = entry instanceof PDFStream ? entry : doc.context.lookupMaybe(entry as never, PDFStream);
      if (!(stream instanceof PDFStream)) return '';
      const raw = stream.getContents();
      try {
        return latin1.decode(inflateSync(raw));
      } catch {
        return latin1.decode(raw);
      }
    }).join('\n');
  }).join('\n');
}

/** The `x y w h` of every fill the run painted, as numbers. */
function painted(stream: string): number[][] {
  return [...stream.matchAll(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) re\s*\n?f/g)]
    .map((m) => m.slice(1, 5).map(Number));
}

/** The hex cells a rewritten `TJ` array still draws. */
function cells(stream: string): string[] {
  return [...stream.matchAll(/<([0-9A-Fa-f]{2})>/g)].map((m) => m[1].toUpperCase());
}

/* ------------------------------------------------------------------ *
 * The mapping, cross-checked against the reader                       *
 * ------------------------------------------------------------------ */

describe('the turned-sheet mark is turned back the way the reader turns it', () => {
  /**
   * MuPDF's own numbers for this fixture (`docs/research/redact-c3-build.py`'s
   * sheet 3, same text, matrix and size), as corners.
   */
  const READER = {
    // unrotated page space, y from the top: what `get_text("words")` answers.
    wordUnrotatedTopLeft: [130.3, 102.8, 221.8, 124.8],
    // the same box after `page.rotation_matrix` = [0, 1, -1, 0, 842, 0].
    wordDisplayed: [717.2, 130.3, 739.2, 221.8],
  } as const;

  it('maps the painted word box to the content stream’s own box', () => {
    const frame = { x0: 0, y0: 0, width: PAGE[0], height: PAGE[1], rotation: 90 };
    const [dx0, dy0, dx1, dy1] = READER.wordDisplayed;
    const user = viewerRectToUserSpace({ x: dx0, y: dy0, width: dx1 - dx0, height: dy1 - dy0 }, frame);
    // A quarter turn swaps the axes: the sentence’s length is the box’s height on
    // screen and its width in the content stream.
    expect(user.width, 'the band does not span the sentence').toBeCloseTo(dy1 - dy0, 1);
    expect(user.height, 'the band is not one line deep').toBeCloseTo(dx1 - dx0, 1);
    // The content stream’s origin is bottom-left; MuPDF’s is top-left of the
    // unrotated sheet, hence the flip on the *page height* of the reported y.
    expect(user.x, 'the mark missed the word along the sentence')
      .toBeCloseTo(READER.wordUnrotatedTopLeft[0], 1);
    expect(PAGE[1] - (user.y + user.height), 'the mark is at the mirrored y')
      .toBeCloseTo(READER.wordUnrotatedTopLeft[1], 1);
    expect(PAGE[1] - user.y).toBeCloseTo(READER.wordUnrotatedTopLeft[3], 1);
  });

  it('would put the band on the mirrored line if case 90 flipped the height', () => {
    // The fix the report asked for — `y0 + (H − px)` in the case-90 arm — moves a
    // correct band onto the line mirrored through the page's middle: 614 pt away
    // here, which is the number the report read as “~490 pt off, mirrored”. Pinned
    // so the arm cannot be "fixed" into the wrong space again.
    const frame = { x0: 0, y0: 0, width: PAGE[0], height: PAGE[1], rotation: 90 };
    const [dx0, , dx1] = READER.wordDisplayed;
    const user = viewerRectToUserSpace({ x: dx0, y: 130.3, width: dx1 - dx0, height: 91.5 }, frame);
    const mirrored = PAGE[1] - dx1;
    expect(Math.abs(user.y - mirrored), 'the case-90 arm is no longer the reader’s own').toBeGreaterThan(600);
  });
});

/* ------------------------------------------------------------------ *
 * The acceptance: one word marked, one word gone                      *
 * ------------------------------------------------------------------ */

describe('a mark over one word of a turned line deletes that word', () => {
  /**
   * The band a live drag across `NOVEMBER` sends: the painted strip, in displayed
   * points on the 842×595 sheet (measured with `docs/research/redact-round.mjs`).
   */
  const NOVEMBER_BAND = { page: 0, x: 717, y: 130, width: 23, height: 92 };

  /** What the bytes have to say, whichever way the sheet is turned. */
  function expectOneWordGone(text: string) {
    const left = cells(text);
    // N O V E M B E R: every letter of the word, and the letters nothing else on
    // the page spells. (`45` E and `4d` M are shared with MIKE, so they are counted,
    // not excluded.)
    for (const cell of ['4E', '4F', '56', '52', '42']) {
      expect(left, `the letter ${cell} of the marked word survived the mark`).not.toContain(cell);
    }
    expect(left.filter((c) => c === '4D'), 'both M’s are still there — one word went, not two')
      .toHaveLength(1);
    // The neighbours, letter for letter: MIKE 4d 49 4b 45, ten 74 65 6e,
    // eleven 65 6c 65 76 65 6e.
    expect(left.filter((c) => c === '49'), 'the I of MIKE went').toHaveLength(1);
    expect(left.filter((c) => c === '6C'), 'the l of eleven went').toHaveLength(1);
    expect(left.filter((c) => c === '76'), 'the v of eleven went').toHaveLength(1);
    // The gap is displaced by the deleted word's real advance — 5.723 em, which is
    // 91.57 pt at 16 pt, what the reader measures for `NOVEMBER` — so the rest of
    // the sentence keeps its place.
    expect(text, 'the survivors were displaced by an estimate, not the advance')
      .toContain('<20> -5723 <20>');
  }

  it('takes the word and leaves its neighbours in the bytes', async () => {
    const outcome = await run({ regions: [NOVEMBER_BAND] }, await turnedFixture());
    const text = await streams(outcome);
    const all = [outcome.message ?? '', ...outcome.warnings].join(' ');
    expect(painted(text), 'the fill is not on the painted word').toEqual([[130, 717, 92, 23]]);
    expectOneWordGone(text);
    // The card: one word was under the mark, one word went, and the three words it
    // did not touch are not named. Before the axis fix they all were — their boxes
    // were slices of the line's width, so they shared the line's centre.
    expect(all).toMatch(/none of the 1 word\(s\) that were under the marks still extracts/);
    expect(all, 'the card still called the neighbours covered').not.toMatch(/still extractable/i);
    expect(all).not.toMatch(/outside the marked areas lost text/i);
    expect(outcome.warnings).toEqual([]);
  });

  it('still clips a horizontal line to the dragged word, unchanged', async () => {
    // The control for the axis test: the same sentence on a rotate-0 sheet, marked
    // with the band the pane would send for the same word, has to produce the same
    // bytes — the axis helper must not have simply inverted the rule.
    const outcome = await run(
      { regions: [{ page: 0, x: 130, y: PAGE[1] - 740, width: 92, height: 23 }] },
      await flatFixture(),
    );
    const text = await streams(outcome);
    const all = [outcome.message ?? '', ...outcome.warnings].join(' ');
    expect(painted(text)).toEqual([[130, 717, 92, 23]]);
    expectOneWordGone(text);
    expect(all).toMatch(/none of the 1 word\(s\) that were under the marks still extracts/);
    expect(outcome.warnings).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * The one axis truth                                                  *
 * ------------------------------------------------------------------ */

describe('advancesAlongYAxis and the pane’s clip agree about which way a line runs', () => {
  it('reads the em axis when it has one and the long edge when it does not', () => {
    // Upright text: the up vector points at the top of the screen (y down space).
    expect(advancesAlongYAxis({ width: 218, height: 22, ux: 0, uy: -1 })).toBe(false);
    // A `/Rotate 90` sheet: the em lies across the page, the sentence runs down it.
    expect(advancesAlongYAxis({ width: 16, height: 213, ux: 1, uy: 0 })).toBe(true);
    // A box with no direction at all is judged by the same fact, its long edge.
    expect(advancesAlongYAxis({ width: 16, height: 213 })).toBe(true);
    expect(advancesAlongYAxis({ width: 213, height: 16 })).toBe(false);
    expect(advancesAlongYAxis({ width: 10, height: 10 })).toBe(false);
  });

  it('clips a snapped vertical line along its own length, not its width', () => {
    const vertical: SnappedLine = { x0: 717.2, y0: 60, x1: 739.2, y1: 273.4, text: LINE };
    const horizontal: SnappedLine = { x0: 60, y0: 102.8, x1: 273.4, y1: 124.8, text: LINE };
    const band = { x0: 717.2, y0: 130.3, x1: 739.2, y1: 221.8 };
    const [clipped] = clipLinesToDrag([vertical], band);
    expect(clipped, 'the vertical line kept its whole length').toEqual({
      ...vertical, y0: 130.3, y1: 221.8,
    });
    // The same band across an upright line trims the length, which is x.
    const [flat] = clipLinesToDrag([horizontal], { x0: 130.3, y0: 100, x1: 221.8, y1: 130 });
    expect(flat).toEqual({ ...horizontal, x0: 130.3, x1: 221.8 });
    // A drag that crosses none of the line leaves nothing to mark.
    expect(clipLinesToDrag([vertical], { x0: 717.2, y0: 400, x1: 739.2, y1: 450 })).toEqual([]);
  });
});

void PDFDict;
void PDFName;
