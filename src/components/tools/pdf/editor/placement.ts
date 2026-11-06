/**
 * Placing a mark on a page that may not be the size you expect.
 *
 * The annotation editor stores geometry in PDF user space, but the sign, redact
 * and crop panels inherit theirs from overlay components that store *fractions of
 * the displayed page* plus, for signatures, a size in points. Those two frames
 * meet at one place: the moment the panel turns what is on screen into numbers for
 * the engine. Three failures live there, and all three are in the matrix:
 *
 * * E8/E6 — mixed and single page sizes. A 400 pt signature on a 300 pt page, or
 *   a redaction drawn against A4 then applied to a Label sheet, must be fitted or
 *   refused, not written off the edge of the paper where no viewer shows it.
 * * E13 — a mark that selects nothing. A drag of two pixels is a redaction that
 *   redacts nothing; a signature with no text, no picture and no stroke is an
 *   empty thing the tool would happily "succeed" at.
 * * E19 — marks that outlived their document. Pages are 1-based here because both
 *   overlay components count them that way, so a redaction on page 9 of a document
 *   that has been swapped for a 3-page one points at nothing.
 *
 * Pure, because every function here is a decision the panel has to explain.
 */

/** A page, in points, with the 1-based number the overlay components use. */
export interface PageSizePt {
  /** 1-based page number. */
  page: number;
  widthPt: number;
  heightPt: number;
}

/** A box in points, origin bottom-left (PDF user space). */
export interface BoxPt {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A box in fractions of the page, origin top-left (overlay space). */
export interface FractionBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function finite(value: number | undefined, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A page number the document actually has; `null` when it does not (E6, E19). */
export function clampPageNumber(page: number, numPages: number): number | null {
  const total = Math.floor(finite(numPages));
  const wanted = Math.round(finite(page));
  if (total < 1) return null;
  if (wanted < 1 || wanted > total) return null;
  return wanted;
}

/**
 * Shrink and slide a mark until it sits inside the page (E8).
 *
 * Returns the same shape it was given so the caller can hand it straight back to
 * the overlay state, plus a reason when the mark could not be honoured at the size
 * it was made — a signature wider than the page is scaled, and saying so beats the
 * user finding a stamp the width of a Post-it.
 */
export function fitMarkToPage<
  T extends { x: number; y: number; w: number; h: number; page: number },
>(mark: T, page: PageSizePt): { mark: T; fitted: boolean; scaled: boolean; reason: string | null } {
  const widthPt = Math.max(1, finite(page.widthPt));
  const heightPt = Math.max(1, finite(page.heightPt));
  let w = Math.max(0, finite(mark.w));
  let h = Math.max(0, finite(mark.h));
  let scaled = false;
  let reason: string | null = null;

  // `w`/`h` are fractions of the page, so "wider than the page" is `> 1`, not a
  // comparison against the point size. Mixing those two frames is the exact bug
  // this module exists to prevent.
  if (w > 1 || h > 1) {
    const ratio = Math.min(1 / Math.max(w, 1e-6), 1 / Math.max(h, 1e-6), 1);
    w = w * ratio;
    h = h * ratio;
    scaled = true;
    reason = `fitted to page ${page.page} (${Math.round(widthPt)} × ${Math.round(heightPt)} pt) by shrinking it to ${Math.round(
      ratio * 100,
    )}%`;
  }

  let x = Math.min(Math.max(finite(mark.x), 0), Math.max(0, 1 - w));
  let y = Math.min(Math.max(finite(mark.y), 0), Math.max(0, 1 - h));
  const moved = scaled || x !== finite(mark.x) || y !== finite(mark.y);
  if (!reason && moved) reason = `kept inside page ${page.page} by moving it onto the paper`;

  return {
    mark: { ...mark, x, y, w, h },
    fitted: moved || scaled,
    scaled,
    reason,
  };
}

/** Fractions of a page → points, the conversion both overlay panels do at run. */
export function fractionToPoints(box: FractionBox, page: PageSizePt): BoxPt {
  const widthPt = Math.max(0, finite(page.widthPt));
  const heightPt = Math.max(0, finite(page.heightPt));
  return {
    x: finite(box.x) * widthPt,
    y: finite(box.y) * heightPt,
    width: finite(box.w) * widthPt,
    height: finite(box.h) * heightPt,
  };
}

/** Area below which a rectangle is a mis-drag rather than a redaction. */
export const MIN_MARK_AREA_PT2 = 4;

export interface MarkReport<T> {
  /** Marks the engine can honour. */
  usable: T[];
  /** Marks that would write something that changes nothing (E13). */
  empty: T[];
  /** Marks on a page this document no longer has (E19). */
  offPage: T[];
  /** One sentence per problem, ready to render. */
  notes: string[];
  /** True when at least one mark would be written. */
  valid: boolean;
}

/**
 * Split a list of fractional marks into what will work and what will not.
 *
 * `describe` turns a mark into a page-qualified phrase so the panel can name the
 * offending mark instead of counting it.
 */
export function reportMarks<T extends { page: number } & FractionBox>(
  marks: readonly T[],
  options: { numPages: number; page: PageSizePt; describe: (mark: T) => string },
): MarkReport<T> {
  const empty: T[] = [];
  const offPage: T[] = [];
  const usable: T[] = [];
  const notes: string[] = [];
  for (const mark of marks) {
    const page = clampPageNumber(mark.page, options.numPages);
    if (page === null) {
      offPage.push(mark);
      continue;
    }
    const box = fractionToPoints(mark, { ...options.page, page });
    if (box.width * box.height < MIN_MARK_AREA_PT2) {
      empty.push(mark);
      continue;
    }
    usable.push(mark);
  }
  if (empty.length > 0) {
    notes.push(
      `${empty.length} ${empty.length === 1 ? 'box covers' : 'boxes cover'} less than ${MIN_MARK_AREA_PT2} pt², so ${
        empty.length === 1 ? 'it would' : 'they would'
      } write a mark that changes nothing. ${empty.map(options.describe).join('; ')}.`,
    );
  }
  if (offPage.length > 0) {
    const pages = [...new Set(offPage.map((mark) => mark.page))].sort((a, b) => a - b);
    notes.push(
      `${offPage.length} mark${offPage.length === 1 ? '' : 's'} sit${offPage.length === 1 ? 's' : ''} on page${
        pages.length === 1 ? '' : 's'
      } ${pages.join(', ')} — this document has ${options.numPages} page${options.numPages === 1 ? '' : 's'}, so they were left out. They belong to the document that was open before.`,
    );
  }
  if (marks.length > 0 && usable.length === 0) {
    notes.push('Nothing here can be written to the file, so the primary action is disabled until you add or fix a mark.');
  }
  return { usable, empty, offPage, notes, valid: usable.length > 0 };
}
