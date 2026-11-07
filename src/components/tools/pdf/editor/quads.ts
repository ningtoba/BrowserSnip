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
}

export interface SnapOptions {
  /** Grow the drag band this many points before testing for a hit. */
  tolerance?: number;
  /** Runs whose bottoms are this close are the same visual line. */
  baselineTolerance?: number;
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
  return { x0: x, y0: y, x1: x + w, y1: y + h, bottom: y + h, text: item.str };
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
    .map((group, index) => {
      const isEdge = index === 0 || index === touched.length - 1;
      const words = touched.length > 2 && !isEdge ? group.line : group.hits;
      const x0 = Math.min(...words.map((b) => b.x0));
      const x1 = Math.max(...words.map((b) => b.x1));
      // Every run on the line sits on (within tolerance of) the same baseline,
      // so the lowest box bottom is the line's baseline and the tallest box is
      // the line's em.
      const baseline = Math.max(...words.map((b) => b.bottom));
      const em = baseline - Math.min(...words.map((b) => b.y0));
      const y0 = baseline - TEXT_BASELINE_SHARE * em;
      const y1 = baseline + (1 - TEXT_BASELINE_SHARE) * em;
      const text = words
        .slice()
        .sort((a, b) => a.x0 - b.x0)
        .map((b) => b.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      return { x0, y0, x1, y1, text };
    })
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
}

/** The text a set of snapped lines covers, for the layer list and hints. */
export function joinSnappedText(lines: SnappedLine[]): string {
  return lines
    .map((line) => line.text)
    .filter(Boolean)
    .join(' ')
    .trim();
}
