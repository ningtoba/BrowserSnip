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
import type { ViewportBox } from './geometry';

/** One visual line of text, boxed in viewport space. */
export interface SnappedLine extends ViewportBox {
  text: string;
}

interface ItemBox extends ViewportBox {
  text: string;
  /** Baseline proxy: the bottom edge of the glyph box. */
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
 * Words are the unit of selection (a run is only taken when it overlaps the
 * band), and the words that share a baseline are merged into one quad that
 * spans them and uses the tallest glyph box in the line — that is what makes a
 * click anywhere on a line highlight the whole line.
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

  const boxes = items
    .map(toBox)
    .filter((box): box is ItemBox => box !== null && hits(box, region, tolerance));

  if (boxes.length === 0) return [];

  // Group by visual line: sort by bottom edge, then extend the current line
  // while the next run's baseline is close enough to belong to it.
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

  return lines
    .map((line) => {
      const x0 = Math.min(...line.map((b) => b.x0));
      const y0 = Math.min(...line.map((b) => b.y0));
      const x1 = Math.max(...line.map((b) => b.x1));
      const y1 = Math.max(...line.map((b) => b.y1));
      const text = line
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
