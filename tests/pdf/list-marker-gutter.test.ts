/**
 * Ordered-list markers must not print over their item text.
 *
 * `core/layout.ts` `renderList` painted every marker at `columnX + 2` and started
 * the item text at a fixed `14 + level*14` indent — without ever measuring the
 * marker. A one-digit marker fits that 14 pt gutter; a two-digit `10.` (≈ 15.3 pt
 * wide at 11 pt) does not, so the number printed *into* the word. Measured by the
 * convert battery on the live Markdown download (marker bbox 58.0→94.5 vs text
 * start x 70.0, MuPDF extracting the pair as the single word `10.tenth`).
 *
 * The gutter is now sized from the widest marker the list actually holds, so
 * one-digit lists keep the exact old geometry (`x = 70`) — that is pinned too.
 * Reported by the convert lane; lives here because `renderList` does.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from '@maxwbh/pdf-lib';
import {
  fileFrom,
  firstPdf,
  installConvertToEnv,
  resetConvertToEnv,
  restoreConvertToEnv,
  run,
  textRunsOf,
} from './convert-to-harness';

async function markdown(text: string): Promise<PDFDocument> {
  const outcome = await run('markdown-to-pdf', {}, [fileFrom(text, 'notes.md', 'text/markdown')]);
  return PDFDocument.load(await firstPdf(outcome));
}

const ordered = (count: number) =>
  Array.from({ length: count }, (_, i) => `${i + 1}. item number ${i + 1}`).join('\n');

/** Marker runs and the text run that follows them, in stream order. */
function markerPairs(doc: PDFDocument) {
  const runs = textRunsOf(doc);
  const pairs: { marker: string; markerX: number; text: string; textX: number }[] = [];
  for (let i = 0; i < runs.length; i += 1) {
    if (!/^\d+\.$/.test(runs[i].text)) continue;
    const next = runs[i + 1];
    if (next && next.page === runs[i].page) {
      pairs.push({ marker: runs[i].text, markerX: runs[i].x, text: next.text, textX: next.x });
    }
  }
  return pairs;
}

beforeAll(() => installConvertToEnv());
afterEach(() => resetConvertToEnv());
afterAll(() => restoreConvertToEnv());

describe('ordered-list marker gutter (convert battery, c3 seam)', () => {
  it('a two-digit marker no longer intersects its item text', async () => {
    const doc = await markdown(ordered(12));
    const pairs = markerPairs(doc);
    expect(pairs.length).toBe(12);
    const face = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    for (const pair of pairs) {
      // The marker itself never moves: it starts in the gutter at columnX + 2.
      expect(pair.markerX).toBeCloseTo(58, 1);
      const markerEnd = pair.markerX + face.widthOfTextAtSize(pair.marker, 11);
      expect(pair.textX, `“${pair.marker}” overlaps “${pair.text.slice(0, 20)}”`).toBeGreaterThanOrEqual(
        markerEnd + 1,
      );
    }
    // The wide items really are the ones that moved.
    const wide = pairs.filter((p) => Number.parseInt(p.marker, 10) >= 10);
    expect(wide.length).toBe(3);
    for (const pair of wide) expect(pair.textX).toBeGreaterThan(70.1);
  });

  it('control: a one-digit list keeps the old 14 pt gutter exactly', async () => {
    const doc = await markdown(ordered(9));
    const pairs = markerPairs(doc);
    expect(pairs.length).toBe(9);
    for (const pair of pairs) {
      expect(pair.markerX).toBeCloseTo(58, 1);
      expect(pair.textX).toBeCloseTo(70, 1);
    }
  });

  it('control: bullet lists keep the old gutter too', async () => {
    const doc = await markdown(['- one', '- two', '  - nested'].join('\n'));
    const pairs = markerPairs(doc);
    expect(pairs.length).toBe(0);
    const runs = textRunsOf(doc).filter((r) => r.text.trim() === 'one' || r.text.trim() === 'two' || r.text.trim() === 'nested');
    expect(runs.length).toBe(3);
    const top = runs.filter((r) => ['one', 'two'].includes(r.text.trim()));
    for (const run of top) expect(run.x).toBeCloseTo(70, 1);
  });
});
