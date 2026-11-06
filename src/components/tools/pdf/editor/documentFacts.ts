/**
 * Claims a panel makes about the document(s) that are open.
 *
 * Tools that show one page at a time (compare, crop, scan) inherit their page
 * counts from the preview component, which knows only what it drew. The panels
 * still have to answer the matrix questions about the *documents*: E6 (a
 * one-page file has nothing to page through), E7 (a 500-page file is not compared
 * page by page without saying so), E13 (a comparison that found no difference) and
 * E18 (a run with nothing in front of it). Keeping those sentences in one pure
 * module is what stops three panels from writing three different versions of
 * "both files were measured".
 */

export interface DocPageCount {
  name: string;
  pages: number;
  /** Set when the file could not be opened, so the panel can name the reason. */
  error?: string;
}

export const SENSITIVITY_MIN = 5;
export const SENSITIVITY_MAX = 150;

/** Keep a threshold inside the range the diff loop can actually mean (E15). */
export function clampSensitivity(value: number): number {
  const n = Number.isFinite(value) ? Math.round(value) : SENSITIVITY_MIN;
  return Math.min(SENSITIVITY_MAX, Math.max(SENSITIVITY_MIN, n));
}

/** What a threshold catches, in the words a user can act on. */
export function sensitivityWords(value: number): string {
  const n = clampSensitivity(value);
  if (n <= 15) return 'catches antialiasing and sub-pixel shifts, so equal pages can still report a few percent';
  if (n <= 45) return 'the default: ignores rendering noise, catches changed words and moved blocks';
  if (n <= 90) return 'only clearly different pixels count, so small edits can be missed';
  return 'only large changes are caught — use this for a moved paragraph, not for a typo';
}

export interface CompareReport {
  valid: boolean;
  tone: 'info' | 'warn' | 'danger';
  headline: string;
  notes: string[];
  /** Pages that will actually be compared. */
  comparedPages: number;
}

/**
 * What "compare these two PDFs" can honestly promise before it runs.
 *
 * The pixel diff walks both documents together, so the answer is bounded by the
 * shorter file; the surplus pages of the longer one are reported rather than
 * silently skipped, which is the difference between a review tool and a shrug.
 */export function compareReport(input: {
  a: DocPageCount | null;
  b: DocPageCount | null;
  filesLoaded: number;
  /** The page count the preview measured (its own minimum). */
  previewPages: number;
  diffPercent: number;
}): CompareReport {
  const notes: string[] = [];
  const { a, b } = input;

  if (input.filesLoaded < 2 || !a || !b) {
    return {
      valid: false,
      tone: 'warn',
      headline: 'Two PDFs are needed',
      notes: [
        `Add a second document in the left panel — a comparison is a claim about two files, not one.`,
      ],
      comparedPages: 0,
    };
  }

  if (a.error || b.error) {
    return {
      valid: false,
      tone: 'danger',
      headline: 'One of the two files could not be measured',
      notes: [a.error ? `${a.name}: ${a.error}` : '', b.error ? `${b.name}: ${b.error}` : ''].filter(Boolean),
      comparedPages: 0,
    };
  }

  const comparedPages = Math.max(0, Math.min(a.pages, b.pages, Math.max(input.previewPages, 1)));
  let tone: CompareReport['tone'] = 'info';

  if (a.pages === 0 || b.pages === 0) {
    return {
      valid: false,
      tone: 'danger',
      headline: 'One of the documents has no pages',
      notes: [`${a.pages === 0 ? a.name : b.name} contains no page to compare.`],
      comparedPages: 0,
    };
  }

  if (a.pages === 1 && b.pages === 1) {
    notes.push('Both documents have a single page, so the comparison is that one page.');
  } else if (a.pages !== b.pages) {
    const longer = a.pages > b.pages ? a : b;
    const surplus = Math.abs(a.pages - b.pages);
    tone = 'warn';
    notes.push(
      `${longer.name} has ${surplus} more page${surplus === 1 ? '' : 's'} than the other file. Those pages have nothing to be compared against, so they are reported here and not in the output.`,
    );
  } else {
    notes.push(`Both documents have ${a.pages} page${a.pages === 1 ? '' : 's'}; every page is compared.`);
  }

  if (a.pages !== b.pages || (comparedPages > 0 && comparedPages < Math.min(a.pages, b.pages))) {
    notes.push(`Comparing ${comparedPages} of ${Math.max(a.pages, b.pages)} pages.`);
  }

  if (input.diffPercent <= 0) {
    tone = tone === 'info' ? 'warn' : tone;
    notes.push(
      'No pixels differ at the current sensitivity, so the output would look exactly like the first document. Lower the threshold if you expect a small change.',
    );
  } else {
    notes.push(`${input.diffPercent.toFixed(1)}% of the compared pixels differ.`);
  }

  return {
    valid: comparedPages > 0,
    tone,
    headline: comparedPages > 0 ? `${a.name} against ${b.name}` : 'Nothing to compare yet',
    notes,
    comparedPages,
  };
}
