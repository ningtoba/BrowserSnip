/**
 * The PDF dashboard's navigation model.
 *
 * The catalogue is organised internally by *engine* — `organize`, `optimize`,
 * `convert-to`, `convert-from`, `edit`, `security` — which is how the code is
 * split, not how a visitor thinks. Nobody walks in thinking "I need a
 * convert-from operation"; they think "I need this as a Word file". The sidebar
 * that used to print the internal categories is gone, so this module is what
 * stands between 124 tools and the one the visitor came for.
 *
 * Two rules keep it honest, and `tests/pdf/parity-surface.test.ts` enforces both
 * against the live registry:
 *   - every tool belongs to exactly one job, so nothing silently vanishes from
 *     the page when a definition is added;
 *   - one card per job, so the same job never appears twice under two ids.
 */
import { PDF_TOOLS, getPdfTool } from '@/lib/pdf/tools/registry';
import type { PdfToolDefinition } from '@/lib/pdf/tools/types';

export interface ToolJob {
  id: string;
  /** A job the visitor would say out loud, not a module name. */
  label: string;
  /** One line under the heading: what this shelf is for. */
  blurb: string;
  icon: string;
  toolIds: string[];
}

/**
 * Jobs, in the order a person is likely to need them.
 *
 * Order matters more than the labels here: the first shelf is what 80% of
 * visitors want, and everything after it is discoverability for the rest.
 */
export const TOOL_JOBS: ToolJob[] = [
  {
    id: 'pages',
    label: 'Reorder, split & combine',
    blurb: 'Put pages in the order you want, keep the ones you need, drop the rest.',
    icon: '🧩',
    toolIds: [
      'merge',
      'split',
      'extract-pages',
      'remove-pages',
      'organize',
      'rotate',
      'rotate-custom',
      'reverse-pages',
      'add-blank-page',
      'remove-blank-pages',
      'alternate-merge',
      'duplex-collate',
      'overlay-pdf',
      'n-up',
      'booklet',
      'combine-single-page',
      'posterize',
      'divide-pages',
      'fix-page-size',
      'page-dimensions',
    ],
  },
  {
    id: 'make',
    label: 'Make a PDF from anything',
    blurb: 'Photos, office documents, text and email become a normal PDF file.',
    icon: '📥',
    toolIds: [
      'image-to-pdf',
      'jpg-to-pdf',
      'png-to-pdf',
      'webp-to-pdf',
      'heic-to-pdf',
      'bmp-to-pdf',
      'tiff-to-pdf',
      'psd-to-pdf',
      'svg-to-pdf',
      'cbz-to-pdf',
      'scan-to-pdf',
      'digitize-document',
      'txt-to-pdf',
      'markdown-to-pdf',
      'html-to-pdf',
      'csv-to-pdf',
      'json-to-pdf',
      'xml-to-pdf',
      'rtf-to-pdf',
      'word-to-pdf',
      'excel-to-pdf',
      'powerpoint-to-pdf',
      'epub-to-pdf',
      'email-to-pdf',
      'odt-to-pdf',
      'ods-to-pdf',
      'odp-to-pdf',
      'xps-to-pdf',
      'fb2-to-pdf',
      'mobi-to-pdf',
      'pages-to-pdf',
      'pub-to-pdf',
      'vsd-to-pdf',
      'wpd-to-pdf',
      'wps-to-pdf',
      'odg-to-pdf',
    ],
  },
  {
    id: 'extract',
    label: 'Get things out of a PDF',
    blurb: 'Back to Word, Excel, images or plain text — plus the data inside.',
    icon: '📤',
    toolIds: [
      'pdf-to-word',
      'pdf-to-excel',
      'pdf-to-csv',
      'pdf-to-text',
      'pdf-to-markdown',
      'pdf-to-json',
      'pdf-to-image',
      'pdf-to-png',
      'pdf-to-jpg',
      'pdf-to-webp',
      'pdf-to-bmp',
      'pdf-to-tiff',
      'pdf-to-svg',
      'extract-images',
      'extract-tables',
      'extract-attachments',
      'pdf-to-greyscale',
      'prepare-pdf-for-ai',
    ],
  },
  {
    id: 'edit',
    label: 'Change what is on the page',
    blurb: 'Write text, mark it up, stamp it, number it, fill it in.',
    icon: '✏️',
    toolIds: [
      'edit-pdf',
      'edit-pdf-text',
      'pdf-crop',
      'page-numbers',
      'watermark',
      'header-footer',
      'bates-numbering',
      'add-page-labels',
      'add-stamps',
      'bookmarks',
      'table-of-contents',
      'form-filler',
      'form-creator',
      'ocr-pdf',
      'pdf-layers',
      'remove-annotations',
      'background-color',
      'text-color',
      'invert-colors',
      'adjust-colors',
      'scanner-effect',
    ],
  },
  {
    id: 'small',
    label: 'Shrink, repair & archive',
    blurb: 'Smaller files for email, a damaged file rebuilt, a copy that outlives the app.',
    icon: '🗜',
    toolIds: [
      'pdf-compress',
      'optimize-pdf',
      'rasterize-pdf',
      'linearize-pdf',
      'repair',
      'sanitize-pdf',
      'deskew-pdf',
      'font-to-outline',
      'pdf-to-pdfa',
      'pdfs-to-zip',
      'pdf-to-cbz',
    ],
  },
  {
    id: 'trust',
    label: 'Sign, protect & check',
    blurb: 'Passwords, signatures, redaction and the answers before you send it.',
    icon: '🔒',
    toolIds: [
      'sign',
      'digital-sign-pdf',
      'validate-signature-pdf',
      'timestamp-pdf',
      'protect',
      'unlock',
      'change-permissions',
      'remove-restrictions',
      'flatten-pdf',
      'redact-pdf',
      'redact',
      'compare-pdfs',
      'compare',
      'view-metadata',
      'edit-metadata',
      'remove-metadata',
      'add-attachments',
      'edit-attachments',
    ],
  },
];

/**
 * Two ids, one job, kept out of the grid.
 *
 * The registry carries `redact`/`redact-pdf` and `compare`/`compare-pdfs` as
 * separate definitions — the older ids still answer their URLs and other tests
 * drive them — but a shopper looking for "the redact tool" should not have to
 * work out which of two identical cards to trust. The canonical id owns the
 * card; the alias redirects to it.
 */
export const CARD_ALIASES: Record<string, string> = {
  redact: 'redact-pdf',
  compare: 'compare-pdfs',
};

/** The shelf a first visitor sees before they read anything. */
export const POPULAR_TOOL_IDS: string[] = [
  'merge',
  'split',
  'pdf-compress',
  'image-to-pdf',
  'pdf-to-word',
  'rotate',
  'sign',
  'protect',
  'unlock',
  'redact-pdf',
  'ocr-pdf',
  'edit-pdf',
];

/**
 * Words people type that the tool names do not contain.
 *
 * The dashboard search is the only navigation now, so "make this smaller" has to
 * reach Compress. Kept here rather than in each definition's `keywords` because
 * these are phrases, not formats: a keyword list per tool would spread one
 * concern across 124 files.
 */
export const JOB_SYNONYMS: Record<string, string[]> = {
  smaller: ['pdf-compress', 'optimize-pdf'],
  'too big': ['pdf-compress'],
  'reduce size': ['pdf-compress'],
  join: ['merge'],
  together: ['merge', 'alternate-merge'],
  apart: ['split', 'divide-pages'],
  'delete text forever': ['redact-pdf'],
  'black out': ['redact-pdf'],
  pictures: ['extract-images', 'pdf-to-image', 'image-to-pdf'],
  photos: ['image-to-pdf', 'scan-to-pdf'],
  scan: ['scan-to-pdf', 'digitize-document', 'ocr-pdf'],
  searchable: ['ocr-pdf'],
  word: ['pdf-to-word', 'word-to-pdf'],
  excel: ['pdf-to-excel', 'excel-to-pdf'],
  sheet: ['pdf-to-excel', 'csv-to-pdf'],
  lock: ['protect'],
  'open a locked file': ['unlock', 'remove-restrictions'],
  encrypt: ['protect'],
  contract: ['sign', 'digital-sign-pdf'],
  'send safely': ['protect', 'redact-pdf'],
  form: ['form-filler', 'form-creator'],
  pages: ['page-numbers', 'add-page-labels'],
  print: ['n-up', 'booklet', 'duplex-collate', 'fix-page-size'],
  gift: ['pdfs-to-zip'],
  'before i send': ['remove-metadata', 'sanitize-pdf', 'redact-pdf'],
  hidden: ['remove-metadata', 'extract-attachments', 'sanitize-pdf'],
  difference: ['compare-pdfs'],
  version: ['compare-pdfs'],
};

export interface DashboardEntry {
  tool: PdfToolDefinition;
  job: ToolJob;
}

/** Every tool that owns a card, with its job, in registry order. */
export function cardEntries(): DashboardEntry[] {
  const entries: DashboardEntry[] = [];
  for (const tool of PDF_TOOLS) {
    if (CARD_ALIASES[tool.id]) continue;
    const job = TOOL_JOBS.find((candidate) => candidate.toolIds.includes(tool.id));
    if (!job) continue;
    entries.push({ tool, job });
  }
  return entries;
}

/** The card's one line: what the user ends up holding, from the definition. */
export function oneLiner(tool: PdfToolDefinition): string {
  return tool.description.trim();
}

/** Every word a query may match, so the search answers the way people type. */
export function searchEntry(entry: DashboardEntry): string {
  const { tool, job } = entry;
  return [
    tool.name,
    tool.description,
    job.label,
    job.blurb,
    ...tool.keywords ?? [],
  ]
    .join(' ')
    .toLowerCase();
}

/**
 * Filter the catalogue the way a person asks for it.
 *
 * Synonym hits come first — someone who typed "make this smaller" should not have
 * to notice Compress three rows down — then name matches, then everything else
 * the words touch.
 */
export function searchJobs(query: string): DashboardEntry[] {
  const entries = cardEntries();
  const q = query.trim().toLowerCase();
  if (q === '') return entries;
  const boosted = new Set<string>();
  for (const [phrase, ids] of Object.entries(JOB_SYNONYMS)) {
    if (q.includes(phrase)) ids.forEach((id: string) => boosted.add(id));
  }
  const scored = entries
    .map((entry: DashboardEntry) => {
      const haystack = searchEntry(entry);
      const words = q.split(/\s+/).filter(Boolean);
      if (!words.every((word: string) => haystack.includes(word) || fuzzy(haystack, word))) return null;
      const named = entry.tool.name.toLowerCase().includes(q) ? 2 : 0;
      return { entry, score: (boosted.has(entry.tool.id) ? 10 : 0) + named };
    })
    .filter((hit): hit is { entry: DashboardEntry; score: number } => hit !== null);
  return scored
    .sort((a: { entry: DashboardEntry; score: number }, b: { entry: DashboardEntry; score: number }) =>
      b.score - a.score || a.entry.job.label.localeCompare(b.entry.job.label),
    )
    .map((hit: { entry: DashboardEntry; score: number }) => hit.entry);
}

/** Subsequence match, so "cmps" still finds Compress. */
function fuzzy(haystack: string, word: string): boolean {
  if (word.length < 4) return false;
  let index = 0;
  for (const char of word) {
    index = haystack.indexOf(char, index);
    if (index < 0) return false;
    index += 1;
  }
  return true;
}

/** Cards for the popular strip, in the order they were written. */
export function popularEntries(): DashboardEntry[] {
  const entries = cardEntries();
  return POPULAR_TOOL_IDS.map((id: string) => entries.find((entry: DashboardEntry) => entry.tool.id === id)).filter(
    (entry: DashboardEntry | undefined): entry is DashboardEntry => Boolean(entry),
  );
}

/** The tool a card opens, alias folded. */
export function cardIdFor(toolId: string): string {
  return getPdfTool(CARD_ALIASES[toolId] ?? toolId) ? CARD_ALIASES[toolId] ?? toolId : toolId;
}
