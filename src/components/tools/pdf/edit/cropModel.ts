/**
 * Crop geometry for the crop panel.
 *
 * The visual overlay (`CropMain`) stores the crop as *fractions of the displayed
 * page*, because fractions survive zoom. The engine that writes the file
 * (`pdf-engine/commands.cropPages`) takes *absolute points of the stored page
 * box* and applies the same numbers to every target page. Those two frames only
 * agree when the page is unrotated — and `/Rotate 90` swaps them, which is the
 * matrix's E9: a crop that looked right in the preview cut a different strip out
 * of the file.
 *
 * So the panel does the conversion itself and says what it did. Everything here
 * is pure: `CropTool.tsx` feeds it the overlay rect plus the page facts it read
 * from the document, and renders the report.
 */
import { normaliseRotation } from "@/lib/pdf/core/pages";

export type CropRotation = 0 | 90 | 180 | 270;

/** Fractions (0–1) of the **displayed** page, as the overlay drags them. */
export interface CropFractions {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** One page of the open document, in both frames at once. */
export interface CropTargetPage {
  /** 0-based index. */
  index: number;
  /** MediaBox size — the frame the engine writes. */
  boxWidthPt: number;
  boxHeightPt: number;
  /** Size after `/Rotate`, the frame the preview shows. */
  displayWidthPt: number;
  displayHeightPt: number;
  rotation: CropRotation;
}

export interface CropMarginsPt extends CropFractions {}

/** A page cropped to less than this on a side is a mistake, not a crop. */
export const MIN_KEPT_PT = 8;

const SIDES = ["top", "right", "bottom", "left"] as const;

/** Every fraction inside 0–1, `NaN` treated as 0. E15 without rejecting the run. */
export function clampFractions(rect: Partial<CropFractions>): CropFractions {
  const out: CropFractions = { top: 0, right: 0, bottom: 0, left: 0 };
  for (const side of SIDES) {
    const value = rect[side];
    out[side] = Number.isFinite(value)
      ? Math.min(1, Math.max(0, Number(value)))
      : 0;
  }
  return out;
}

/**
 * Displayed fractions → point margins in the page's own (unrotated) box.
 *
 * The four cases are the corner map of a page turned 0/90/180/270° clockwise:
 * with `/Rotate 90` the displayed top edge *is* the stored left edge, and so on.
 */
export function marginsInPoints(
  rect: CropFractions,
  page: CropTargetPage,
): CropMarginsPt {
  // Each displayed edge is measured in the displayed extent, then handed to the
  // stored edge it lands on for this `/Rotate` value.
  const t = rect.top * page.displayHeightPt;
  const b = rect.bottom * page.displayHeightPt;
  const l = rect.left * page.displayWidthPt;
  const r = rect.right * page.displayWidthPt;
  switch (page.rotation) {
    case 90:
      return { left: t, right: b, top: r, bottom: l };
    case 180:
      return { left: r, right: l, top: b, bottom: t };
    case 270:
      return { left: b, right: t, top: l, bottom: r };
    case 0:
    default:
      return { left: l, right: r, top: t, bottom: b };
  }
}

/** The stored edge a displayed edge becomes, for the honesty sentence. */
const DISPLAYED_TO_STORED: Record<
  CropRotation,
  Record<keyof CropFractions, keyof CropFractions>
> = {
  0: { top: "top", right: "right", bottom: "bottom", left: "left" },
  90: { top: "left", right: "top", bottom: "right", left: "bottom" },
  180: { top: "bottom", right: "left", bottom: "top", left: "right" },
  270: { top: "right", right: "bottom", bottom: "left", left: "top" },
};

export function storedEdgeFor(
  rotation: CropRotation,
  displayed: keyof CropFractions,
): keyof CropFractions {
  return DISPLAYED_TO_STORED[rotation][displayed];
}

export interface CropReport {
  /** Point margins for the engine, from the previewed page. */
  marginsPt: CropMarginsPt;
  keptWidthPt: number;
  keptHeightPt: number;
  /** Whether anything at all would survive the crop. */
  valid: boolean;
  tone: "info" | "warn" | "danger";
  /** One sentence per finding, shown in the panel. */
  notes: string[];
}

export interface CropReportInput {
  rect: Partial<CropFractions>;
  /** The page the preview shows; the margins are computed from it. */
  preview: CropTargetPage | null;
  /** Pages the crop will be applied to (already resolved against the document). */
  targets: number[];
  /** Pages it could not resolve, with the reason each was refused. */
  refused?: { token: string; reason: string }[];
  numPages: number;
  allPages: boolean;
}

/**
 * The whole crop decision: geometry, plus what the panel owes the user about it.
 *
 * E13 (crop nothing away), E15 (out-of-range margins), E6 (one page), E8 (mixed
 * sizes) and E9 (rotation) are all reported here rather than discovered in the
 * downloaded file.
 */
export function describeCrop(input: CropReportInput): CropReport {
  const rect = clampFractions(input.rect);
  const notes: string[] = [];
  const page = input.preview;

  if (!page) {
    return {
      marginsPt: rect,
      keptWidthPt: 0,
      keptHeightPt: 0,
      valid: false,
      tone: "warn",
      notes: [
        "Open a PDF first — there is no page to crop until one is loaded.",
      ],
    };
  }

  const margins = marginsInPoints(rect, page);
  const keptWidthPt = page.boxWidthPt - margins.left - margins.right;
  const keptHeightPt = page.boxHeightPt - margins.top - margins.bottom;
  const horizontal = rect.left + rect.right;
  const vertical = rect.top + rect.bottom;
  const area = (1 - horizontal) * (1 - vertical);
  let tone: CropReport["tone"] = "info";
  let valid = true;

  if (area <= 0) {
    valid = false;
    tone = "danger";
    notes.push(
      `The crop removes the whole page — top and bottom alone take ${(vertical * 100).toFixed(0)}% of its height, so nothing would be left to save.`,
    );
  } else if (keptWidthPt < MIN_KEPT_PT || keptHeightPt < MIN_KEPT_PT) {
    valid = false;
    tone = "danger";
    notes.push(
      `Only ${Math.round(keptWidthPt)} × ${Math.round(keptHeightPt)} pt would remain — a crop narrower than ${MIN_KEPT_PT} pt is usually a slip of the handle.`,
    );
  } else if (area < 0.05) {
    tone = "warn";
    notes.push(
      `This keeps ${(area * 100).toFixed(1)}% of the page (${Math.round(keptWidthPt)} × ${Math.round(keptHeightPt)} pt). That is a sliver, not a margin.`,
    );
  }

  if (area > 0 && area > 0.999) {
    notes.push(
      "Nothing is being cropped: all four margins are zero, so the output would equal the input.",
    );
  } else if (area > 0) {
    notes.push(
      `Keeps ${Math.round(keptWidthPt)} × ${Math.round(keptHeightPt)} pt of page ${page.index + 1} — that is ${(area * 100).toFixed(0)}% of its area.`,
    );
  }

  if (page.rotation !== 0) {
    const trimmed = (SIDES as readonly (keyof CropFractions)[]).filter(
      (side) => rect[side] > 0,
    );
    const mapping = trimmed
      .map((side) => `${side} → ${storedEdgeFor(page.rotation, side)}`)
      .join(", ");
    notes.push(
      `Page ${page.index + 1} is rotated ${page.rotation}°, so the margins were re-aimed at the stored page box instead of the preview (${mapping}). Without this the crop would cut a different strip out of the file than the one you dragged.`,
    );
  }

  for (const refusal of input.refused ?? []) {
    tone = tone === "danger" ? tone : "warn";
    notes.push(`"${refusal.token}" was ignored — ${refusal.reason}`);
  }

  if (input.numPages === 1) {
    notes.push(
      'This document has one page, so "all pages" and "page 1" are the same crop.',
    );
  } else if (input.allPages) {
    notes.push(
      `The same margins in points are applied to all ${input.numPages} pages. On a page smaller than the preview they crop proportionally more; check the preview after the run.`,
    );
  } else if (input.targets.length === 0) {
    valid = false;
    tone = "danger";
    notes.push("No page is selected, so there is nothing to crop.");
  }

  return { marginsPt: margins, keptWidthPt, keptHeightPt, valid, tone, notes };
}

export interface TargetPagesReport {
  /** 1-based, as the engine wants them. */
  pages: number[];
  refused: { token: string; reason: string }[];
  clampedTo: number;
}

/**
 * Resolve a `1-3,5` style target list against a real page count (E6, E15).
 *
 * Out-of-range numbers are refused by name rather than dropped, and inverted
 * ranges say so — silently truncating to the page count is how a 12-page plan
 * becomes a 5-page file without explanation.
 */
export function resolveTargets(
  spec: string,
  numPages: number,
): TargetPagesReport {
  const pages: number[] = [];
  const refused: TargetPagesReport["refused"] = [];
  const seen = new Set<number>();
  const text = (spec ?? "").trim();
  const total = Math.max(0, Math.floor(numPages));
  if (!text) {
    return {
      pages: [],
      refused: [{ token: "", reason: "no pages were typed" }],
      clampedTo: total,
    };
  }
  for (const raw of text.split(/[,\s]+/)) {
    const token = raw.trim();
    if (!token) continue;
    if (/^(all|\*)$/i.test(token)) {
      for (let page = 1; page <= total; page += 1) {
        if (!seen.has(page)) {
          seen.add(page);
          pages.push(page);
        }
      }
      continue;
    }
    const range = /^(\d+)\s*[-–]\s*(\d+)$/.exec(token);
    const single = /^(\d+)$/.exec(token);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start < 1 || end < 1) {
        refused.push({ token, reason: "pages are numbered from 1" });
        continue;
      }
      if (end < start) {
        refused.push({
          token,
          reason: `it counts backwards from ${start} to ${end}`,
        });
        continue;
      }
      if (end > total) {
        refused.push({
          token,
          reason: `this document has ${total} page${total === 1 ? "" : "s"}, so the range stops at ${total}`,
        });
      }
      for (let page = start; page <= Math.min(end, total); page += 1) {
        if (!seen.has(page)) {
          seen.add(page);
          pages.push(page);
        }
      }
      continue;
    }
    if (single) {
      const page = Number(single[1]);
      if (page < 1) {
        refused.push({ token, reason: "pages are numbered from 1" });
        continue;
      }
      if (page > total) {
        refused.push({
          token,
          reason: `this document has ${total} page${total === 1 ? "" : "s"}`,
        });
        continue;
      }
      if (!seen.has(page)) {
        seen.add(page);
        pages.push(page);
      }
      continue;
    }
    refused.push({
      token,
      reason: 'it is not a page number, a range like 3-5, or "all"',
    });
  }
  return { pages, refused, clampedTo: total };
}

/** Read a page's stored box and rotation into the model's shape. */
export function targetPage(
  index: number,
  boxWidthPt: number,
  boxHeightPt: number,
  rotationDeg: number,
): CropTargetPage {
  const rotation = normaliseRotation(rotationDeg) as CropRotation;
  const turned = rotation === 90 || rotation === 270;
  return {
    index,
    boxWidthPt,
    boxHeightPt,
    displayWidthPt: turned ? boxHeightPt : boxWidthPt,
    displayHeightPt: turned ? boxWidthPt : boxHeightPt,
    rotation,
  };
}

/** Distinct page boxes, for the E8 sentence. */
export function distinctBoxes(pages: readonly CropTargetPage[]): string[] {
  const out = new Set<string>();
  for (const page of pages)
    out.add(`${Math.round(page.boxWidthPt)}x${Math.round(page.boxHeightPt)}`);
  return [...out];
}

/* ── keyboard adjustment ───────────────────────────────────────────────────── */

/** One arrow press moves an edge this much of the page; Shift is ten times more. */
export const NUDGE_FRACTION = 0.005;
export const NUDGE_BIG_FRACTION = 0.05;

/** The smallest kept rectangle the keyboard can push the crop to, as a fraction. */
export const MIN_KEPT_FRAC = 0.02;

export type CropEdge = keyof CropFractions;

/**
 * Move one edge of the kept rectangle, in page fractions.
 *
 * A positive delta always takes *more* off that side, whichever side it is, so
 * the arrow keys can be aimed at the edge the user is looking at instead of at
 * the stored number. The opposite edge is never crossed and the crop never
 * collapses to nothing: this is the clamp the drag handlers promise by hand.
 */
export function nudgeEdge(
  rect: CropFractions,
  edge: CropEdge,
  delta: number,
): CropFractions {
  const next = clampFractions(rect);
  const minimum = MIN_KEPT_FRAC;
  if (edge === "left") {
    next.left = clampValue(next.left + delta, 0, 1 - next.right - minimum);
  } else if (edge === "right") {
    next.right = clampValue(next.right + delta, 0, 1 - next.left - minimum);
  } else if (edge === "top") {
    next.top = clampValue(next.top + delta, 0, 1 - next.bottom - minimum);
  } else {
    next.bottom = clampValue(next.bottom + delta, 0, 1 - next.top - minimum);
  }
  return next;
}

/** Slide the whole kept rectangle by (dx, dy) without changing its size. */
export function slideRect(
  rect: CropFractions,
  dx: number,
  dy: number,
): CropFractions {
  const next = clampFractions(rect);
  // The kept rectangle leaves the page only when a margin runs out, so a shift
  // is bounded by the margins on the two sides it travels between.
  const shiftX = clampValue(dx, -next.left, next.right);
  const shiftY = clampValue(dy, -next.top, next.bottom);
  return {
    left: next.left + shiftX,
    right: next.right - shiftX,
    top: next.top + shiftY,
    bottom: next.bottom - shiftY,
  };
}

function clampValue(value: number, lo: number, hi: number): number {
  if (hi < lo) return Math.max(0, Math.min(1, value));
  return Math.max(lo, Math.min(hi, value));
}
