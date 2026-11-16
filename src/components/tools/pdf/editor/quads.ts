/**
 * Text-markup snapping.
 *
 * A highlight is only useful if it lands on a real text line, so the drag band
 * is turned into per-line quads taken from `PdfSession.textItems()` output —
 * the user never traces a rectangle by hand. The work happens in *viewport
 * space* (PDF points, top-left origin, page rotation applied), which is exactly
 * the space `ExtractedTextItem.x/y/w/h` are reported in, and which
 * `geometry.pdfQuadFromViewportBox` later maps into PDF user space.
 */
import type { ExtractedTextItem } from '@/lib/pdf/core/render';
import { TEXT_BASELINE_SHARE } from '@/lib/pdf/core/annotations';
import type { ViewportBox } from './geometry';

/** One visual line of text, boxed in viewport space. */
export interface SnappedLine extends ViewportBox {
  text: string;
}

interface ItemBox extends ViewportBox {
  text: string;
  /** The baseline: the bottom edge of the box the text layer reports. */
  bottom: number;
  /** Glyph size, which is the run's own em — not the box, whose height is its length. */
  em: number;
  /** Unit vector from the baseline towards the ascenders, in viewport space. */
  ux: number;
  uy: number;
}

/**
 * Re-anchor one run on its ink, along the em the run actually stands up in.
 *
 * `render.toExtractedItems` reports a run as one em of box stacked on the
 * *ascender* side of the baseline, so as it comes the box has a quarter-em of
 * air above the tallest letter and stops at the feet of the text: a highlight
 * misses the tails of `g`, `p`, `q` and `y`, and anything placed as a share of
 * that box sits high by the same amount. The box keeps its extent along the line
 * and moves `TEXT_BASELINE_SHARE` of the way down its own em, which is where
 * `markupRule` in `core/annotations` strokes from — the same fraction on the
 * screen and in the file.
 *
 * "The way down" is the run's own `ux`/`uy`, not the viewer's y. On a `/Rotate 90`
 * sheet the em lies horizontally and the box's height is the run's *length*, so
 * an anchor taken from the height pushed a 163 pt line 33 pt sideways off its
 * words and left them outside the mark.
 */
function anchorOnInk(run: ItemBox[]): ViewportBox {
  const em = Math.max(...run.map((b) => b.em));
  const ux = run[0].ux;
  const uy = run[0].uy;
  const x0 = Math.min(...run.map((b) => b.x0));
  const x1 = Math.max(...run.map((b) => b.x1));
  const y0 = Math.min(...run.map((b) => b.y0));
  const y1 = Math.max(...run.map((b) => b.y1));
  // The baseline edge is the one furthest along -u; the anchored box spans
  // `em` from there, `TEXT_BASELINE_SHARE` of it towards the ascenders.
  const towards = (t: number): [number, number] => [
    (TEXT_BASELINE_SHARE - t) * em * ux,
    (TEXT_BASELINE_SHARE - t) * em * uy,
  ];
  const vertical = Math.abs(uy) >= Math.abs(ux);
  // t = 0 is the ascender edge, t = 1 the feet edge.
  const [ax, ay] = towards(0);
  const [bx, by] = towards(1);
  if (vertical) {
    // The baseline is at the bottom when the text stands up, at the top when it
    // hangs upside down.
    const base = uy < 0 ? y1 : y0;
    return { x0, x1, y0: Math.min(base + ay, base + by), y1: Math.max(base + ay, base + by) };
  }
  const base = ux > 0 ? x0 : x1;
  return { y0, y1, x0: Math.min(base + ax, base + bx), x1: Math.max(base + ax, base + bx) };
}

export interface SnapOptions {
  /** Grow the drag band this many points before testing for a hit. */
  tolerance?: number;
  /** Runs whose bottoms are this close are the same visual line. */
  baselineTolerance?: number;
  /** Break the line into another quad when the whitespace between runs passes this many ems. */
  gapEm?: number;
}

/**
 * The whitespace that ends a run group, in ems of the taller of the two runs.
 *
 * A text layer starts a new run wherever the content stream moved the pen, so a
 * gap *is* the layout: one space is 0.278 em in Helvetica and 0.25 em in Times,
 * and a justified line stretches a space to roughly 1.5× that. Half an em is
 * therefore wider than any space the fonts of a normal paragraph draw and far
 * narrower than the tab- or column-wide gaps this rule exists to leave alone —
 * the header row of the test CV measures its name-to-date whitespace at 18 em.
 */
export const RUN_GAP_EM = 0.5;

/**
 * How far past the drag band a markup tool reaches, in CSS pixels.
 *
 * A highlighter grip that grazes a line should still mark it. The built-in
 * `tolerance` is 2 PDF *points*, which at 100 % is 2 screen pixels: a band drawn
 * a few pixels above the words creates nothing and the user drags the same line
 * a second time. Measuring the slop on screen keeps the reach the same physical
 * distance at every zoom, and it stays well under the leading of a paragraph so
 * a near miss cannot reach the line above.
 */
export const MARKUP_SNAP_SLOP_PX = 4;

/** The `snapTextLines` tolerance for a drag at this zoom, never below its 2 pt default. */
export function markupSnapTolerance(zoom: number): number {
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return Math.max(2, MARKUP_SNAP_SLOP_PX / scale);
}

/** True when the page carries any selectable text at all. */
export function pageHasText(items: ExtractedTextItem[]): boolean {
  return items.some((item) => typeof item.str === 'string' && item.str.trim().length > 0);
}

function toBox(item: ExtractedTextItem): ItemBox | null {
  if (typeof item.str !== 'string' || item.str.trim().length === 0) return null;
  const { x, y, w, h } = item;
  if (![x, y, w, h].every((n) => Number.isFinite(n))) return null;
  if (w <= 0 || h <= 0) return null;
  return {
    x0: x,
    y0: y,
    x1: x + w,
    y1: y + h,
    bottom: y + h,
    text: item.str,
    em: Number.isFinite(item.fontSize) && item.fontSize > 0 ? item.fontSize : h,
    // An older caller (or a test double) may not carry a vector: upright text is
    // the case every reader means, so that is the fallback.
    ux: Number.isFinite(item.ux) ? item.ux : 0,
    uy: Number.isFinite(item.uy) ? item.uy : -1,
  };
}

function hits(box: ItemBox, region: ViewportBox, tolerance: number): boolean {
  return (
    box.x1 + tolerance >= region.x0 &&
    box.x0 - tolerance <= region.x1 &&
    box.y1 + tolerance >= region.y0 &&
    box.y0 - tolerance <= region.y1
  );
}

/**
 * Turn a drag band into the text lines it touches.
 *
 * Words are the unit of selection, and the words that share a baseline are merged
 * into one quad that spans them and uses the tallest glyph box in the line — that
 * is what makes a mark cover the words instead of the leading above them.
 *
 * The merged box is then re-anchored on the ink. `render.toExtractedItems`
 * reports a run as one em of box stacked *above* the baseline (its `y` is
 * `viewportHeight - (baseline + fontSize)`), so as it comes the box has a
 * quarter-em of air above the tallest letter and stops at the feet of the text:
 * a highlight misses the tails of `g`, `p`, `q` and `y`, and anything placed as
 * a share of that box sits high by the same amount. The box keeps its height and
 * moves down until the baseline is `TEXT_BASELINE_SHARE` of the way down it,
 * which is where `markupRule` in `core/annotations` strokes from — the same
 * fraction on the screen and in the file. On the CV's 20pt heading the ink
 * measured 14.7pt above the baseline and 3.9pt below it: the re-anchored box
 * spans 16pt, and the original one spanned 20pt ending at the baseline.
 *
 * Runs that are not contiguous are not one selection. PDF 32000-1 Table 171
 * allows *n* quadrilaterals, each covering "a word or group of contiguous
 * words", so a line whose runs are separated by more than `RUN_GAP_EM` of their
 * own em becomes one quad per run group: a row that carries a name at the left
 * margin and a date at the right is highlighted, underlined and struck twice,
 * and the empty space between them is painted by nothing. (Before that split the
 * strike ran the full width of the page through thin air, which is what a
 * screenshot of the CV's header row showed and no written report had.)
 *
 * A drag across several lines is *text*, not a rectangle: the first and last lines
 * stop where the drag stops, but a line in the middle is covered end to end,
 * because the selection continues past the drag's x-range there. Skipping that
 * step is how a 3-line highlight loses its middle line (the trap recorded in
 * `docs/research/ux-references-commercial.md` §2.4).
 *
 * Invisible runs (`isInvisible`, i.e. an OCR text layer) are kept, because a
 * searchable scan is exactly the case where snapping should work.
 */
export function snapTextLines(
  items: ExtractedTextItem[],
  region: ViewportBox,
  options: SnapOptions = {},
): SnappedLine[] {
  const tolerance = options.tolerance ?? 2;
  const baselineTolerance = options.baselineTolerance ?? 3;
  const gapEm = options.gapEm ?? RUN_GAP_EM;

  const boxes = items.map(toBox).filter((box): box is ItemBox => box !== null);
  if (boxes.length === 0) return [];

  // Group every run into visual lines first, so a middle line can be widened to
  // words the drag band itself never reached.
  const ordered = [...boxes].sort((a, b) => a.bottom - b.bottom || a.x0 - b.x0);
  const lines: ItemBox[][] = [];
  for (const box of ordered) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(box.bottom - line[line.length - 1].bottom) <= baselineTolerance) {
      line.push(box);
    } else {
      lines.push([box]);
    }
  }

  const touched = lines
    .map((line) => ({ line, hits: line.filter((box) => hits(box, region, tolerance)) }))
    .filter((group) => group.hits.length > 0);

  return touched
    .flatMap((group, index) => {
      const isEdge = index === 0 || index === touched.length - 1;
      const words = touched.length > 2 && !isEdge ? group.line : group.hits;
      return runGroups(words, gapEm).map((run) => {
        const box = anchorOnInk(run);
        const { x0, x1, y0, y1 } = box;
        const text = run
          .slice()
          .sort((a, b) => a.x0 - b.x0)
          .map((b) => b.text)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        return { x0, y0, x1, y1, text };
      });
    })
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
}

/**
 * The contiguous run groups of one visual line, left to right.
 *
 * A new group opens when the whitespace between two runs passes `gapEm` ems of
 * the taller run — see `RUN_GAP_EM`. Runs that overlap (a kerned pair, a
 * bold-and-regular heading) are one group whatever the gap, since nothing
 * separates them.
 */
function runGroups(words: ItemBox[], gapEm: number): ItemBox[][] {
  const orderedWords = [...words].sort((a, b) => a.x0 - b.x0);
  const groups: ItemBox[][] = [];
  let run: ItemBox[] = [];
  let right = Number.NEGATIVE_INFINITY;
  for (const box of orderedWords) {
    if (run.length > 0) {
      const em = Math.max(box.y1 - box.y0, ...run.map((b) => b.y1 - b.y0));
      if (box.x0 - right > gapEm * em) {
        groups.push(run);
        run = [];
      }
    }
    run.push(box);
    right = Math.max(right, box.x1);
  }
  if (run.length > 0) groups.push(run);
  return groups;
}

/** The text a set of snapped lines covers, for the layer list and hints. */
export function joinSnappedText(lines: SnappedLine[]): string {
  return lines
    .map((line) => line.text)
    .filter(Boolean)
    .join(' ')
    .trim();
}
