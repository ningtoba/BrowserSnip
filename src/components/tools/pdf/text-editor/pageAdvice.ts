/**
 * What the text editor can honestly say about the page it is showing.
 *
 * The editor's whole promise is "click a paragraph and retype it". When a page
 * has no clickable paragraph the old build simply showed an empty page and looked
 * broken, and when the words were an invisible OCR layer it looked like a promise
 * it had quietly broken. Both are the matrix's E10, and the honest answer is a
 * sentence plus the action that fixes it — route to OCR, or place a text box.
 *
 * E11 lives here too: a page of CJK or right-to-left text edits fine (the export
 * draws through the bundled Unicode font), but the on-screen re-wrap is a browser
 * approximation of that font's metrics, so the user is told before they commit,
 * not after they diff the output.
 *
 * Pure on purpose: `TextEditor.tsx` feeds it page facts and renders the result.
 */

export type ScriptName = 'cjk' | 'rtl' | 'latin';

export interface BlockFact {
  /** Whether every run on the block is render-mode-3 (an OCR layer). */
  invisible: boolean;
  direction: 'ltr' | 'rtl';
  text: string;
}

export interface PageAdviceInput {
  hasDocument: boolean;
  opening: boolean;
  /** Total pages of the open document. */
  numPages: number;
  /** 1-based page on screen. */
  page: number;
  blocks: BlockFact[];
  /** Images the object detector found on this page. */
  imageCount: number;
  /** The optional repair engine is already in this tab: a rewrite is complete. */
  engineLoaded: boolean;
  /** It could still be fetched from the CDN, which is what `open-engine` does. */
  engineFetchable: boolean;
  /** Human size of that fetch, quoted so a 54 MB wait is not a hang. */
  engineSize: string;
}

export type AdviceAction = 'run-ocr' | 'add-text' | 'open-engine' | 'next-page';

export interface PageAdvice {
  kind: 'no-text' | 'blank-page' | 'ocr-layer' | 'script-notice' | 'single-page';
  tone: 'info' | 'warn';
  headline: string;
  detail: string;
  actions: AdviceAction[];
}

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const RTL = /[\u0590-\u05ff\u0600-\u06ff\u0700-\u074f\u0750-\u077f\ufb1d-\ufdff\ufe70-\ufeff]/;

/** Which scripts a piece of page text actually contains. */
export function scriptsIn(texts: readonly string[]): ScriptName[] {
  const joined = texts.join('\n');
  const found: ScriptName[] = [];
  if (CJK.test(joined)) found.push('cjk');
  if (RTL.test(joined)) found.push('rtl');
  if (/[A-Za-z\u00c0-\u024f]/.test(joined)) found.push('latin');
  return found;
}

/** How many blocks a page yielded, splitting the invisible layer out (E10). */
export function blockCensus(blocks: readonly BlockFact[]): {
  total: number;
  visible: number;
  invisible: number;
} {
  const invisible = blocks.filter((block) => block.invisible).length;
  return { total: blocks.length, visible: blocks.length - invisible, invisible };
}

const ACTION_LABELS: Record<AdviceAction, string> = {
  'run-ocr': 'Run OCR to add a text layer',
  'add-text': 'Place a text box instead',
  'open-engine': 'Load the optional engine',
  'next-page': 'Open the next page',
};

export function adviceActionLabel(action: AdviceAction): string {
  return ACTION_LABELS[action];
}

/**
 * One advice object for the page under the cursor, or `null` when there is
 * nothing to warn about. Order matters: a page that cannot be edited at all is
 * more urgent than one whose wrapping will only be approximate.
 */
export function pageAdvice(input: PageAdviceInput): PageAdvice | null {
  if (!input.hasDocument || input.opening) return null;
  const census = blockCensus(input.blocks);

  if (census.total === 0) {
    if (input.imageCount > 0) {
      return {
        kind: 'no-text',
        tone: 'warn',
        headline: `Page ${input.page} has no text layer — it is a scan.`,
        detail:
          'There is nothing to click and retype here: the page is one picture of words, so the text editor would only be able to add new boxes on top of it. Run OCR first and the words become editable blocks.',
        actions: ['run-ocr', 'add-text'],
      };
    }
    return {
      kind: 'blank-page',
      tone: 'info',
      headline: `Page ${input.page} has no text and no pictures.`,
      detail: 'Nothing to rewrite, so the page is blank. A text box or a picture can be placed here.',
      actions: ['add-text'],
    };
  }

  if (census.visible === 0) {
    const detail = input.engineLoaded
      ? 'The text is selectable and searchable, but it sits over a scan. The optional engine is loaded in this tab, so a rewrite here deletes the words underneath as well.'
      : input.engineFetchable
        ? `The text is selectable and searchable, but it sits over a scan: the built-in engine can draw new words but cannot delete the ones underneath, so a rewrite here would leave doubled text. The optional PyMuPDF engine (${input.engineSize}, fetched once, files never leave the tab) closes that gap, and it is fetched the first time an export needs it.`
        : 'The text is selectable and searchable, but it sits over a scan: the built-in engine can draw new words but cannot delete the ones underneath, so a rewrite here would leave doubled text. The optional engine cannot be reached from here right now — re-run OCR instead.';
    return {
      kind: 'ocr-layer',
      tone: 'warn',
      headline: `Page ${input.page}'s words are an invisible OCR layer.`,
      detail,
      actions: input.engineLoaded
        ? ['add-text']
        : input.engineFetchable
          ? ['run-ocr', 'open-engine', 'add-text']
          : ['run-ocr', 'add-text'],
    };
  }

  const scripts = scriptsIn(input.blocks.map((block) => block.text));
  const rightToLeft = input.blocks.some((block) => block.direction === 'rtl');
  if (scripts.includes('cjk') || rightToLeft) {
    const what = rightToLeft
      ? 'right-to-left script'
      : 'CJK text, which has no spaces to break lines on';
    return {
      kind: 'script-notice',
      tone: 'info',
      headline: `This page mixes in ${what}.`,
      detail:
        'The export draws the block with the bundled Unicode font, so the characters are correct. What is approximate is the on-screen re-wrap: the browser uses its own font metrics, so line breaks can shift from the exported page. Reload preview after a commit to see the real layout.',
      actions: ['add-text'],
    };
  }

  if (input.numPages === 1) {
    return {
      kind: 'single-page',
      tone: 'info',
      headline: 'This document has one page.',
      detail: 'Page controls stay on page 1, and Find and Replace only ever searches this page.',
      actions: [],
    };
  }

  return null;
}
