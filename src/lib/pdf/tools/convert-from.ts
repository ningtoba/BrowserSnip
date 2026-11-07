/**
 * Convert from PDF.
 *
 * Every extraction path is built on pdf.js text runs plus `core/convert` and
 * `core/tables`, so the output is real, selectable data rather than a
 * screenshot. The old `pdf-to-word` and `pdf-to-excel` forced every run to
 * Calibri and treated "items on the same line" as a table; both are replaced.
 */
import { savePDF } from '../core/doc';
import { PageSpecError, resolvePages, type PageSpec } from '../core/pages';
import { pageSizeReport } from '../core/measure';
import {
  countImages,
  documentToJson,
  jsonToLlamaIndex,
  jsonToMarkdown,
  jsonToText,
  detectHeadingHeights,
  type PdfJsonDocument,
} from '../core/convert';
import { detectTables, tablesToCsv, type DetectedTable } from '../core/tables';
import { canvasToBlob, concatTiffs } from '../core/raster';
import type { ExtractedImage } from '../core/images-out';
import {
  ToolInputError,
  downloadStem,
  filesResult,
  openInputs,
  pagesField,
  qualityField,
  reportResult,
  resolutionField,
  throwIfAborted,
  withRender,
  type OpenedInput,
} from './helpers';
import {
  booleanValue,
  numberValue,
  stringValue,
  type PdfToolDefinition,
  type ToolReportSection,
  type ToolResult,
  type ToolRunContext,
  type ToolValues,
} from './types';

/* ── naming (E17) ─────────────────────────────────────────────────────────── */

/**
 * A safe stem for downloads and archive entries.
 *
 * The rules live in `helpers.downloadStem` so the runner, the archive exporters
 * and every per-tool name in this module sanitise the same way (E17).
 */
const outputStem = downloadStem;

/** `007`, `0007` — wide enough for the page numbers the document really has. */
function pageNumber(value: number, total: number): string {
  return String(value).padStart(Math.max(3, String(Math.max(1, total)).length), '0');
}

/* ── what a page actually gave us (E10, E13) ──────────────────────────────── */

/** NUL and the other invisible control characters a broken glyph map leaves. */
const CONTROL_JUNK = /[\u0000-\u0008\u000B\u000E-\u001F\u007F-\u009F]/g;

/**
 * Strip characters no reader can see.
 *
 * A subset font with a missing `/ToUnicode` map, or a sparse OCR layer, hands
 * back runs full of NULs. Left in, the page *looks* extracted — the file is
 * non-empty and the word count is up — while reading it shows nothing (E10).
 * Tab, newline and form feed survive because they are the layout.
 */
function tidy(text: string): string {
  return text.replace(CONTROL_JUNK, '');
}

/** Characters a reader could actually see — the honest "did this work?" test. */
function readableChars(text: string): number {
  return Array.from(tidy(text).replace(/\s+/g, '')).length;
}

interface ExtractionFacts {
  /** Visible characters per selected page, in page order. */
  pages: { page: number; chars: number; images: number; tables: number }[];
  /** Selected pages that produced at least one visible character. */
  withText: number[];
  /** Selected pages that hold images but no text layer: scans (E10). */
  scanned: number[];
  /** Selected pages with neither text nor images. */
  blank: number[];
  chars: number;
  tables: number;
  images: number;
}

/** What one sweep over the selected pages turned up: grids and the truth. */
interface TableHaul {
  input: OpenedInput;
  tables: DetectedTable[];
  facts: ExtractionFacts;
}

function factsFromPages(
  pages: ExtractionFacts['pages'],
): ExtractionFacts {
  const empty = pages.filter((item) => item.chars === 0);
  return {
    pages,
    withText: pages.filter((item) => item.chars > 0).map((item) => item.page),
    scanned: empty.filter((item) => item.images > 0).map((item) => item.page),
    blank: empty.filter((item) => item.images === 0).map((item) => item.page),
    chars: pages.reduce((sum, item) => sum + item.chars, 0),
    tables: pages.reduce((sum, item) => sum + item.tables, 0),
    images: pages.reduce((sum, item) => sum + item.images, 0),
  };
}

function extractionFacts(json: PdfJsonDocument): ExtractionFacts {
  return factsFromPages(
    json.pages.map((item) => ({
      page: item.page,
      chars: readableChars(item.text || item.blocks.map((block) => block.text ?? '').join(' ')),
      images: item.images,
      tables: item.blocks.filter((block) => block.type === 'table').length,
    })),
  );
}

/** `2, 4-6, 9` — a wall of 480 page numbers tells nobody anything (E7). */
function listPages(pages: readonly number[], limit = 10): string {
  const groups: string[] = [];
  let start: number | null = null;
  let last = 0;
  const flush = () => {
    if (start === null) return;
    groups.push(start === last ? `${start}` : last - start === 1 ? `${start}, ${last}` : `${start}-${last}`);
    start = null;
  };
  for (const page of pages) {
    if (start !== null && page === last + 1) {
      last = page;
      continue;
    }
    flush();
    start = page;
    last = page;
  }
  flush();
  if (groups.length === 0) return 'no page';
  if (groups.length <= limit) return groups.join(', ');
  return `${groups.slice(0, limit).join(', ')} and ${groups.length - limit} more`;
}

const singular = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

const ofPages = (facts: ExtractionFacts): string =>
  `Page ${listPages(facts.scanned)} of the ${facts.pages.length} selected`;

/** Zero readable characters on every selected page: a report, never a download. */
function nothingToRead(
  input: OpenedInput,
  facts: ExtractionFacts,
  unit: string,
): ToolResult | null {
  if (facts.pages.length === 0) return noPagesSelected(input);
  if (facts.chars > 0) return null;
  return nothingFound('Nothing to extract', emptyReason(facts, unit), emptyAdvice(facts));
}

/**
 * A "nothing found" outcome that is not a download.
 *
 * An empty file is a lie twice over: the user opens a zero-byte .txt or a ZIP
 * with nothing in it, and the log says "done" (E13). A report names what was
 * searched, why it came up empty and what to press instead.
 */
function nothingFound(title: string, detail: string, suggestions: string[] = []): ToolResult {
  const sections: ToolReportSection[] = [{ title, text: detail }];
  if (suggestions.length > 0) {
    sections.push({
      title: 'What to try instead',
      rows: suggestions.map((line, index) => ({ label: `Option ${index + 1}`, value: line })),
    });
  }
  return { kind: 'report', sections, message: title, warnings: [detail] };
}

/**
 * The `pages` field as a spec `core/pages` can resolve (E6).
 *
 * The rail sends a string — `all`, `1-3,7` — but the field type also allows a
 * list of numbers, and reading that with `stringValue` fell back to `all`. An
 * empty selection then exported the whole document instead of admitting that
 * nothing was picked.
 */
function pageSpec(values: ToolValues): PageSpec {
  const raw = values.pages;
  if (Array.isArray(raw)) {
    return raw
      .map((item) => (typeof item === 'number' ? item : Number(String(item).trim())))
      .filter((item) => Number.isFinite(item));
  }
  return typeof raw === 'string' && raw.trim() !== '' ? raw : 'all';
}

/**
 * The page selection as 1-based page numbers, or a sentence (E6).
 *
 * `core/pages` throws `PageSpecError`, and its class name was reaching the user
 * as `PageSpecError: "2" refers to page 2 …` — a stack trace where a sentence
 * belongs. The tool layer owns what the rail prints, so the spec failure is
 * translated into the same `ToolInputError` shape every other refusal uses and
 * the valid range is spelled out instead of left to be inferred.
 */
function pageSelection(input: OpenedInput, spec: PageSpec): number[] {
  try {
    return resolvePages(spec, input.pageCount).map((index) => index + 1);
  } catch (error) {
    if (!(error instanceof PageSpecError)) throw error;
    throw new ToolInputError(
      'OUT_OF_RANGE',
      `The page selection is outside "${input.name}" — ${error.message} Valid range: 1-${input.pageCount}.`,
      { fileName: input.name, hint: 'Use "all", or list pages the way 1-3,7.' },
    );
  }
}

/** E18's honest cousin: a selection that matched no page is a report, not a file. */
function noPagesSelected(input: OpenedInput): ToolResult {
  return nothingFound(
    'No page selected',
    `"${input.name}" has ${singular(input.pageCount, 'page')} and the selection matched none of them.`,
    ['Use "all", or list pages the way 1-3,7.'],
  );
}

/** Why nothing readable was found — a scan and a blank page are different news. */
function emptyReason(facts: ExtractionFacts, unit: string): string {
  if (facts.scanned.length > 0 && facts.withText.length === 0) {
    return `${ofPages(facts)} page(s) hold images but no text layer, so they read as pictures. There is no ${unit} in them until the page has been OCR'd.`;
  }
  if (facts.scanned.length > 0) {
    return `Only ${singular(facts.scanned.length, 'page')} (${listPages(facts.scanned)}) had no text layer, and the rest held no ${unit} either.`;
  }
  if (facts.chars === 0 && facts.images > 0) {
    return `The ${facts.pages.length} selected page(s) are drawings and images with no text at all, so there is no ${unit} to read.`;
  }
  if (facts.chars === 0) {
    return `The ${facts.pages.length} selected page(s) are blank — no text, no images, nothing to write into ${unit}.`;
  }
  return `No ${unit} was found on ${facts.pages.length} page(s), although they do contain text.`;
}

function emptyAdvice(facts: ExtractionFacts): string[] {
  const advice: string[] = [];
  if (facts.scanned.length > 0) {
    advice.push('Run OCR (Searchable PDF) on this file first, then extract again.');
    advice.push('Or export the pages with PDF to Image and work from the pictures.');
  } else {
    advice.push('Widen the page selection — the content may be on a page that was left out.');
    advice.push('Check the file with View metadata or Page Dimensions to see what it holds.');
  }
  return advice;
}

/**
 * Partial successes, phrased for `result.warnings`: three good pages and one
 * scan must never be reported as a clean run (E10, E7).
 */
function degradedPages(facts: ExtractionFacts, consequence: string): string[] {
  const warnings: string[] = [];
  if (facts.scanned.length > 0) {
    warnings.push(
      `${ofPages(facts)} page(s) have no text layer (image only — a scan). ${consequence}`,
    );
  }
  if (facts.blank.length > 0) {
    warnings.push(`Page ${listPages(facts.blank)} is blank — no text and no images.`);
  }
  return warnings;
}

/** Anything the input guard already admitted (E3) rides along with the result. */
function inputNotices(input: OpenedInput): string[] {
  const seen = input.inspection;
  if (!seen?.recovered) return [];
  return [
    `"${seen.name}" is damaged: ${seen.pages} of ${seen.declaredPages ?? 'its'} page(s) could be read, so the output may be short.`,
  ];
}

function withWarnings<T extends ToolResult>(result: T, warnings: readonly string[]): T {
  const merged = [...new Set([...(result.warnings ?? []), ...warnings.filter(Boolean)])];
  return merged.length === 0 ? result : ({ ...result, warnings: merged } as T);
}

/* ── resolution (E15) ─────────────────────────────────────────────────────── */

const DPI_FLOOR = 24;
const DPI_CEILING = 3600;

/**
 * A resolution the renderer can act on.
 *
 * `0` is refused rather than clamped: at 0 dpi every page becomes a 1×1 pixel,
 * so the tool would "succeed" and hand back a handful of blank thumbnails. A
 * value that is merely outside the useful band is moved onto it and said out
 * loud, which is the other half of E15.
 */
function resolveDpi(value: number): { dpi: number; notice?: string } {
  if (!Number.isFinite(value) || value <= 0) {
    const shown = Number.isFinite(value) ? value : 'blank';
    throw new ToolInputError(
      'OUT_OF_RANGE',
      `A resolution of ${shown} dpi cannot be rendered: an image needs a positive number of dots per inch.`,
      { hint: `Use between ${DPI_FLOOR} and ${DPI_CEILING} dpi — 200 for screen, 300 for print.` },
    );
  }
  if (value < DPI_FLOOR) {
    return {
      dpi: DPI_FLOOR,
      notice: `Resolution raised from ${value} dpi to ${DPI_FLOOR} dpi, the smallest value that still renders a legible page.`,
    };
  }
  if (value > DPI_CEILING) {
    return {
      dpi: DPI_CEILING,
      notice: `Resolution lowered from ${value} dpi to ${DPI_CEILING} dpi so one page still fits in memory.`,
    };
  }
  return { dpi: Math.round(value) };
}

/* ── raster export (E7, E8, E9, E15, E17) ─────────────────────────────────── */

/** Extract → render → download helper shared by the image exporters. */
async function exportPages(
  context: ToolRunContext,
  options: {
    format: 'png' | 'jpeg' | 'webp' | 'bmp' | 'tiff';
    extension: string;
    dpi: number;
    quality: number;
    pages: PageSpec;
    zipWhenMany?: boolean;
  },
) {
  const [input] = await openInputs(context);
  const { session } = await withRender(input, context);
  try {
    const indices = pageSelection(input, options.pages);
    if (indices.length === 0) {
      return noPagesSelected(input);
    }
    const { dpi, notice } = resolveDpi(options.dpi);
    const scale = dpi / 72;
    const stem = outputStem(input.name);
    // Rotation-aware geometry, page by page: a document may mix A4, Letter and
    // landscape scans, and each image has to match its own page (E8, E9).
    const boxes = pageSizeReport(input.doc);
    const warnings: string[] = [...(notice ? [notice] : []), ...inputNotices(input)];
    const sizes = new Set<string>();
    let rotated = 0;
    const sideways: string[] = [];
    const files: { blob: Blob; name: string }[] = [];
    for (let i = 0; i < indices.length; i++) {
      const page = indices[i];
      throwIfAborted(context.signal);
      const box = boxes[page - 1];
      if (box) {
        sizes.add(`${box.widthPt}x${box.heightPt}`);
        if (box.rotation % 180 !== 0) rotated += 1;
      }
      const render = await session.renderPage(page, scale, { background: '#ffffff' });
      if (box && box.widthPt !== box.heightPt) {
        const wideOut = render.width > render.height;
        const wantWide = box.widthPt > box.heightPt;
        if (wideOut !== wantWide) {
          sideways.push(`${page} (image ${render.width}×${render.height} px, page shows as ${box.widthPt}×${box.heightPt} pt)`);
        }
      }
      const blob = await canvasToBlob(render.canvas, options.format, options.quality, { background: '#ffffff' });
      files.push({ blob, name: `${stem}-page-${pageNumber(page, input.pageCount)}.${options.extension}` });
      render.cancel();
      context.progress((i + 1) / indices.length, `Exported page ${page} of ${indices.length}`);
    }
    if (sideways.length > 0) {
      warnings.push(`Page ${sideways.join('; ')} came out the wrong way round: its /Rotate value was not applied.`);
    }
    if (files.length !== indices.length) {
      warnings.push(`${indices.length - files.length} selected page(s) produced no image and were skipped.`);
    }
    const summary = [
      `${singular(files.length, `${options.format.toUpperCase()} image`)} at ${dpi} dpi`,
      sizes.size > 1 ? `${sizes.size} different page sizes` : 'one page size',
      rotated > 0 ? `${rotated} rotated page(s) kept upright` : null,
    ]
      .filter(Boolean)
      .join(' · ')
      + '.';
    if (options.format === 'tiff' && files.length > 1) {
      const merged = await concatTiffs(files.map((file) => file.blob));
      return withWarnings(
        filesResult(
          [{ blob: merged, name: `${stem}.tif` }],
          `${summary} Written as ${files.length} pages in one multi-page TIFF.`,
        ),
        warnings,
      );
    }
    if (files.length > 1 && options.zipWhenMany !== false) {
      const { createZip } = await import('../core/archive');
      const blob = await createZip(files.map((file) => ({ name: file.name, data: file.blob })));
      return withWarnings(
        filesResult([{ blob, name: `${stem}-images.zip` }], `${summary} Packaged as one .zip.`),
        warnings,
      );
    }
    return withWarnings(filesResult(files, summary), warnings);
  } finally {
    await session.destroy();
  }
}

const RESOLUTION_FIELD = resolutionField({
  min: 72,
  max: 600,
  group: 'Output',
  help: '200 dpi is fine for screen, 300 for print. Higher is sharper and heavier, and every page is rendered in this tab.',
});

const PAGES_FIELD = pagesField();

/** The disclosure every page-to-picture exporter owes the user (E10, E13). */
const RASTER_OUT_NOTES = [
  'A rendered page is a picture: the text layer does not travel with it, so the images cannot be searched or copied.',
  'More than one page is packaged as a single ZIP; a one-page selection downloads on its own.',
];

/** Shared by the text exporters: what a page with nothing to read costs. */
function textOutNotes(what: string): string[] {
  return [
    `Pages with no text layer contribute nothing to the ${what}, and the result names them instead of reporting a silent success.`,
    'A scan needs a text layer before it can be extracted: run OCR first if the output comes back empty.',
  ];
}

/**
 * Read the selected pages once, for every text-shaped exporter.
 *
 * `facts` is the honest answer to "did this work?": it counts the characters a
 * reader can actually see, per page, so a scan, a blank page and a page of
 * glyph-map noise are told apart instead of all reporting success (E10, E13).
 */
async function buildJson(context: ToolRunContext) {
  const [input] = await openInputs(context);
  const { session } = await withRender(input, context);
  try {
    const indices = pageSelection(input, pageSpec(context.values));
    if (indices.length === 0) {
      const json = { meta: {}, pages: [] } as PdfJsonDocument;
      return { input, json, facts: factsFromPages([]) };
    }
    const json = await documentToJson(input.doc, session, indices);
    context.progress(0.9, `Read ${json.pages.length} page(s)`);
    return { input, json, facts: extractionFacts(json) };
  } finally {
    await session.destroy();
  }
}

const TEXT_MIME: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
};

/**
 * One text download.
 *
 * CSV gets a UTF-8 byte-order mark because Excel and Sheets both assume a
 * legacy codepage without it, which turns CJK and accented output into mojibake
 * the moment the file is opened (E11).
 */
function textFiles(name: string, extension: string, content: string) {
  const body = extension === 'csv' ? `\uFEFF${content}` : content;
  return [{
    blob: new Blob([body], { type: TEXT_MIME[extension] ?? `text/${extension}` }),
    name: `${outputStem(name)}.${extension}`,
  }];
}

function jsonFile(name: string, suffix: string, value: unknown, options: { pretty?: boolean } = {}) {
  const body = typeof value === 'string' ? value : JSON.stringify(value, null, options.pretty === false ? undefined : 2);
  return [{
    blob: new Blob([body], { type: TEXT_MIME.json }),
    name: `${outputStem(name)}${suffix}`,
  }];
}

/**
 * A font height no text on earth is drawn at, which is how heading promotion
 * is switched **off**: `jsonToMarkdown` and friends read an empty
 * `headingHeights` list as "work the heights out yourself", so `[]` meant the
 * rail's "Detect headings" toggle could never actually be turned off.
 */
const NO_HEADING_HEIGHT = 0.01;

export const convertFromTools: PdfToolDefinition[] = [
  {
    id: 'pdf-to-text',
    name: 'PDF to Text',
    description: 'Extract the text of every page as a plain .txt file',
    icon: '📃',
    category: 'convert-from',
    keywords: ['extract text', 'copy text', 'plain text', 'readability'],
    surface: 'none',
    outputSuffix: '.txt',
    promise: 'A .txt file holding the words from the pages you picked, with a word count you can check against the original.',
    actionLabel: 'Extract text',
    notes: textOutNotes('text file'),
    fields: [
      PAGES_FIELD,
      { key: 'layout', label: 'Keep line layout', type: 'toggle', default: true, group: 'Output', help: 'Off joins wrapped lines into flowing paragraphs, which reads better and rewraps in any editor.' },
      { key: 'pageMarkers', label: 'Insert page break markers', type: 'toggle', default: false, group: 'Output', help: 'Writes a form feed between pages so a text editor or `cat` can find the page boundaries again.' },
    ],
    async run(context) {
      const { input, json, facts } = await buildJson(context);
      const blocker = nothingToRead(input, facts, 'text');
      if (blocker) return blocker;
      const text = tidy(jsonToText(json, {
        pageMarkers: booleanValue(context.values, 'pageMarkers'),
        formFeed: booleanValue(context.values, 'layout', true),
      }));
      const words = text.split(/\s+/).filter(Boolean).length;
      return withWarnings(
        filesResult(
          textFiles(input.name, 'txt', text),
          `Extracted ${words.toLocaleString()} words from ${json.pages.length} page(s).`,
        ),
        [...degradedPages(facts, 'They contributed no text to the file.'), ...inputNotices(input)],
      );
    },
  },

  {
    id: 'pdf-to-markdown',
    name: 'PDF to Markdown',
    description: 'Convert headings, lists and tables to Markdown with a live preview',
    icon: '📝',
    category: 'convert-from',
    keywords: ['md', 'readme', 'llm', 'notes'],
    surface: 'none',
    outputSuffix: '.md',
    promise: 'A Markdown file with real headings, lists and tables — not a flat dump of every line.',
    actionLabel: 'Convert to Markdown',
    notes: textOutNotes('Markdown'),
    fields: [
      PAGES_FIELD,
      { key: 'tables', label: 'Rebuild tables as Markdown tables', type: 'toggle', default: true, group: 'Structure', help: 'Off keeps a table as plain lines, because a wide table becomes unreadable in a pipe grid.' },
      { key: 'headings', label: 'Detect headings from font sizes', type: 'toggle', default: true, group: 'Structure', help: 'A large run of text becomes `##`. Turn it off when the document uses size for emphasis rather than structure.' },
      { key: 'pageBreaks', label: 'Separate pages with a rule', type: 'toggle', default: false, group: 'Structure', help: 'Adds a horizontal rule where each page ended, so slide decks keep their shape.' },
    ],
    async run(context) {
      const { input, json, facts } = await buildJson(context);
      const blocker = nothingToRead(input, facts, 'Markdown');
      if (blocker) return blocker;
      const markdown = jsonToMarkdown(json, {
        headingHeights: booleanValue(context.values, 'headings', true)
          ? detectHeadingHeights(json)
          : [NO_HEADING_HEIGHT],
        tables: booleanValue(context.values, 'tables', true),
        pageBreaks: booleanValue(context.values, 'pageBreaks'),
      });
      return withWarnings(
        filesResult(
          textFiles(input.name, 'md', markdown),
          `Wrote ${markdown.split('\n').length} lines of Markdown from ${json.pages.length} page(s).`,
        ),
        [...degradedPages(facts, 'Those pages became a comment, not prose.'), ...inputNotices(input)],
      );
    },
  },

  {
    id: 'pdf-to-json',
    name: 'PDF to JSON',
    description: 'Structured blocks with bounding boxes, fonts and table grids',
    icon: '🧩',
    category: 'convert-from',
    keywords: ['data', 'api', 'structured', 'parsing'],
    surface: 'none',
    outputSuffix: '.json',
    promise: 'A JSON file with every block, its text, bounding box and fonts, plus the tables the grid implies.',
    actionLabel: 'Export JSON',
    notes: textOutNotes('JSON'),
    fields: [
      PAGES_FIELD,
      { key: 'tables', label: 'Detect tables', type: 'toggle', default: true, group: 'Content', help: 'Off returns the raw text runs only, which is faster and never guesses a grid that is not there.' },
    ],
    async run(context) {
      const { input, json, facts } = await buildJson(context);
      // A page of pictures only is still worth describing, so the empty-result
      // report is reserved for a selection with no text *and* no images and no
      // tables (E13) — the scan case keeps its file and gains a warning.
      const blocker = nothingToRead(input, facts, 'content');
      if (blocker && facts.images + facts.tables === 0) return blocker;
      const body = JSON.stringify(json, null, 2);
      return withWarnings(
        filesResult(
          [{ blob: new Blob([body], { type: 'application/json' }), name: `${outputStem(input.name)}.json` }],
          `${json.pages.length} page(s), ${json.pages.reduce((n, page) => n + page.blocks.length, 0)} block(s).`,
        ),
        [
          ...degradedPages(facts, 'Their JSON carries an empty "text" field.'),
          ...inputNotices(input),
        ],
      );
    },
  },

  {
    id: 'prepare-pdf-for-ai',
    name: 'Prepare PDF for AI',
    description: 'Chunk the document into LlamaIndex-compatible JSON for RAG',
    icon: '🤖',
    category: 'convert-from',
    keywords: ['rag', 'llm', 'embedding', 'chunks', ' llamaindex'],
    surface: 'none',
    outputSuffix: '-llamaindex.json',
    promise: 'One chunked, referenced JSON file an embedding pipeline can index without another pass.',
    actionLabel: 'Chunk for AI',
    notes: textOutNotes('chunks'),
    fields: [
      PAGES_FIELD,
      { key: 'title', label: 'Document id', type: 'text', group: 'Index', placeholder: 'The file name, if left blank', help: 'Every chunk points back at this id, so changing it later orphans the rows already in your index.' },
      { key: 'extra', label: 'Extra metadata (JSON)', type: 'textarea', default: '', group: 'Index', placeholder: '{ "source": "contracts" }', help: 'One flat object of strings and numbers, copied onto every chunk. Anything nested is rejected before the run.' },
    ],
    async run(context) {
      const { input, json, facts } = await buildJson(context);
      const blocker = nothingToRead(input, facts, 'text to chunk');
      if (blocker) return blocker;
      const extra = stringValue(context.values, 'extra').trim();
      let parsed: Record<string, unknown> | undefined;
      if (extra) {
        try {
          parsed = JSON.parse(extra) as Record<string, unknown>;
        } catch {
          throw new ToolInputError(
            'OUT_OF_RANGE',
            'The extra metadata must be valid JSON, for example {"source": "contracts"}.',
            { hint: 'One flat object of strings and numbers, which is what an index stores.' },
          );
        }
      }
      const doc = jsonToLlamaIndex(json, {
        title: stringValue(context.values, 'title') || input.name,
        extraMetadata: parsed,
      });
      const chunks = Object.keys(doc.ref_doc_info).length;
      return withWarnings(
        filesResult(
          jsonFile(input.name, '-llamaindex.json', doc, { pretty: false }),
          `Produced ${chunks} reference document(s) from ${json.pages.length} page(s), ready for an index.`,
        ),
        [...degradedPages(facts, 'They became an empty chunk in the index.'), ...inputNotices(input)],
      );
    },
  },

  {
    id: 'pdf-to-csv',
    name: 'PDF to CSV',
    description: 'Detect tables and export them as CSV',
    icon: '🗃️',
    category: 'convert-from',
    keywords: ['spreadsheet', 'rows', 'extract table'],
    surface: 'none',
    outputSuffix: '.csv',
    promise: 'A CSV file with one row per detected table row — or an honest report when the pages hold no table at all.',
    actionLabel: 'Export CSV',
    notes: [
      'The file is written as UTF-8 with a byte-order mark, because Excel and Sheets both assume a legacy codepage without it and turn accented cells into mojibake.',
      'A block of prose is not a table: when nothing is detected you get a report naming the pages it looked at, not an empty download.',
    ],
    fields: [
      PAGES_FIELD,
      { key: 'minRows', label: 'Minimum rows', type: 'number', default: 3, min: 2, max: 20, step: 1, integer: true, half: true, group: 'Tables', help: 'A block of text needs this many aligned rows before it counts as a table. Raise it when column headings keep being read as tables.' },
      { key: 'delimiter', label: 'Delimiter', type: 'select', default: ',', group: 'CSV file', options: [
        { value: ',', label: 'Comma' }, { value: ';', label: 'Semicolon' }, { value: '\t', label: 'Tab' },
      ], help: 'Semicolon or tab survives being opened in a European-locale spreadsheet, where a comma is a decimal point.' },
    ],
    async run(context) {
      const { input, tables, facts } = await collectTables(context);
      if (tables.length === 0) return noTablesFound(input, facts, numberValue(context.values, 'minRows', 3));
      const csv = tablesToCsv(tables, stringValue(context.values, 'delimiter', ','));
      return withWarnings(
        filesResult(
          textFiles(input.name, 'csv', csv),
          `Extracted ${tables.length} table(s) totalling ${tables.reduce((n, table) => n + table.rows.length, 0)} rows.`,
        ),
        [...degradedPages(facts, 'No rows could be read from them, so they are missing from the CSV.'), ...inputNotices(input)],
      );
    },
  },

  {
    id: 'extract-tables',
    name: 'Extract Tables',
    description: 'Find tables and export them as CSV, JSON or Markdown',
    icon: '📊',
    category: 'convert-from',
    keywords: ['table detection', 'rows', 'columns', 'data'],
    surface: 'none',
    outputSuffix: '-tables.json',
    promise: 'Every table on the selected pages, as one file in the format you choose, with the page it came from.',
    actionLabel: 'Extract tables',
    notes: [
      'Tables are found from ruled lines and aligned columns, so a table drawn as free text with no gaps can be missed — the report says which pages were checked.',
    ],
    fields: [
      PAGES_FIELD,
      { key: 'format', label: 'File format', type: 'segmented', default: 'json', group: 'Output', options: [
        { value: 'json', label: 'JSON' }, { value: 'csv', label: 'CSV' }, { value: 'md', label: 'Markdown' },
      ], help: 'JSON keeps the page and cell coordinates; CSV and Markdown are for reading, so they flatten them away.' },
      { key: 'minRows', label: 'Minimum rows', type: 'number', default: 2, min: 2, max: 20, step: 1, integer: true, group: 'Tables', help: 'A block of text needs this many aligned rows before it counts as a table.' },
    ],
    async run(context) {
      const { input, tables, facts } = await collectTables(context);
      if (tables.length === 0) return noTablesFound(input, facts, numberValue(context.values, 'minRows', 2));
      const format = stringValue(context.values, 'format', 'json');
      const notices = [...degradedPages(facts, 'They held no table, so nothing was written for them.'), ...inputNotices(input)];
      if (format === 'csv') {
        return withWarnings(
          filesResult(textFiles(input.name, 'csv', tablesToCsv(tables)), `${tables.length} table(s).`),
          notices,
        );
      }
      if (format === 'md') {
        // A Markdown file needs a level-1 title before the per-table `##` ones,
        // or the first line is a section heading with no document heading.
        const body = [
          `# Tables from ${outputStem(input.name)}`,
          '',
          `Extracted from ${facts.pages.length} page(s); ${tables.length} table(s).`,
          ...tables.map((table, index) => `\n## Table ${index + 1}\n\n${toMarkdownTable(table)}`),
        ].join('\n');
        return withWarnings(
          filesResult(textFiles(input.name, 'md', body), `${tables.length} table(s).`),
          notices,
        );
      }
      return withWarnings(
        filesResult(
          jsonFile(input.name, '-tables.json', { tables }),
          `${tables.length} table(s) with ${tables.reduce((n, table) => n + table.rows.length, 0)} rows.`,
        ),
        notices,
      );
    },
  },

  {
    id: 'pdf-to-excel',
    name: 'PDF to Excel',
    description: 'Each detected table becomes a worksheet in a real .xlsx',
    icon: '📈',
    category: 'convert-from',
    keywords: ['xlsx', 'workbook', 'spreadsheet', 'sheets'],
    surface: 'none',
    outputSuffix: '.xlsx',
    promise: 'A real .xlsx workbook with one worksheet per detected table, columns already widened.',
    actionLabel: 'Export spreadsheet',
    notes: [
      'Cells arrive as text plus whatever number the text clearly was; a table drawn without a text layer cannot become a workbook, and the result says so.',
    ],
    fields: [
      PAGES_FIELD,
      { key: 'oneSheet', label: 'Put everything on one sheet', type: 'toggle', default: false, group: 'Workbook', help: 'Off keeps one worksheet per detected table, which is what you want before pivoting; on stacks them with a blank row between.' },
      { key: 'minRows', label: 'Minimum rows', type: 'number', default: 2, min: 2, max: 20, step: 1, integer: true, group: 'Workbook', help: 'A block of text needs this many aligned rows before it counts as a table.' },
    ],
    async run(context) {
      const { input, tables, facts } = await collectTables(context);
      if (tables.length === 0) {
        return noTablesFound(input, facts, numberValue(context.values, 'minRows', 2));
      }
      const XLSX = await import('xlsx');
      const workbook = XLSX.utils.book_new();
      if (booleanValue(context.values, 'oneSheet')) {
        const rows = tables.flatMap((table) => [...table.rows, []]);
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Tables');
      } else {
        tables.forEach((table, index) => {
          const sheet = XLSX.utils.aoa_to_sheet(table.rows);
          const widths = (table.rows[0] ?? []).map((_, column) => ({
            wch: Math.min(60, Math.max(8, ...tables[index].rows.map((row) => (row[column] ?? '').length))),
          }));
          sheet['!cols'] = widths;
          XLSX.utils.book_append_sheet(workbook, sheet, `Table ${index + 1}`.slice(0, 31));
        });
      }
      const out: Uint8Array = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
      return withWarnings(
        filesResult(
          [{
            blob: new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
            name: `${outputStem(input.name)}.xlsx`,
          }],
          `${tables.length} table(s) across ${workbook.SheetNames.length} worksheet(s).`,
        ),
        [
          ...degradedPages(facts, 'They are not in the workbook.'),
          ...inputNotices(input),
        ],
      );
    },
  },

  {
    id: 'pdf-to-word',
    name: 'PDF to Word',
    description: 'Rebuild the document as an editable .docx with headings, lists and tables',
    icon: '📄',
    category: 'convert-from',
    keywords: ['docx', 'editable', 'office', 'rewrite'],
    surface: 'none',
    outputSuffix: '.docx',
    promise: 'An editable .docx rebuilt from the text, headings and tables — content you can rewrite, not a picture of the page.',
    actionLabel: 'Convert to Word',
    notes: [
      'Word re-flows the page, so line breaks, column positions and the original font are not preserved; anything that must land exactly where it was should stay a PDF.',
    ],
    fields: [
      PAGES_FIELD,
      { key: 'headings', label: 'Map font sizes to Word heading styles', type: 'toggle', default: true, group: 'Structure', help: 'Heading styles make a navigable document; positions and the original typeface do not survive the mapping.' },
      { key: 'tables', label: 'Rebuild tables as Word tables', type: 'toggle', default: true, group: 'Structure', help: 'Off pastes the rows as plain paragraphs, which is safer for a table with merged or empty cells.' },
      { key: 'pageBreaks', label: 'Start a new page for each PDF page', type: 'toggle', default: false, group: 'Structure', help: 'On keeps the pagination you printed with; off lets Word re-flow, so page numbers will not match the original.' },
    ],
    async run(context) {
      const { input, json, facts } = await buildJson(context);
      const blocker = nothingToRead(input, facts, 'text');
      if (blocker) return blocker;
      const { buildDocx } = await import('../core/docx-out');
      const blob = await buildDocx(json, {
        headings: booleanValue(context.values, 'headings', true),
        tables: booleanValue(context.values, 'tables', true),
        pageBreaks: booleanValue(context.values, 'pageBreaks'),
      });
      return withWarnings(
        filesResult(
          [{ blob, name: `${outputStem(input.name)}.docx` }],
          `Wrote a Word document from ${json.pages.length} page(s). Text is editable; original positions are not preserved.`,
        ),
        [...degradedPages(facts, 'They reached the document as an empty paragraph.'), ...inputNotices(input)],
      );
    },
  },

  {
    id: 'pdf-to-svg',
    name: 'PDF to SVG',
    description: 'Vector export — paths and text stay sharp at any size',
    icon: '🧷',
    category: 'convert-from',
    keywords: ['vector', 'illustrator', 'scale', 'svg'],
    surface: 'none',
    outputSuffix: '.svg',
    promise: 'Vector pages that stay sharp at any zoom, with the text left as text wherever the page allows it.',
    actionLabel: 'Export SVG',
    notes: [
      'Fonts are referenced, not embedded, so an SVG opened without the original font installed is redrawn with a substitute.',
    ],
    fields: [
      PAGES_FIELD,
      { key: 'embedImages', label: 'Embed raster images as data URIs', type: 'toggle', default: true, group: 'Output', help: 'Off leaves the photos out of the file, which keeps it small but means opening it somewhere else shows blank frames.' },
      { key: 'asOne', label: 'One SVG per document instead of per page', type: 'toggle', default: false, group: 'Output', help: 'Off gives you one SVG per page. On packs them into a ZIP, since a single SVG can only carry one page.' },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const { session } = await withRender(input, context);
      try {
        const { documentToSvg } = await import('../core/convert');
        const indices = pageSelection(input, pageSpec(context.values));
        if (indices.length === 0) {
          return noPagesSelected(input);
        }
        const stem = outputStem(input.name);
        const files: { blob: Blob; name: string }[] = [];
        for (let i = 0; i < indices.length; i++) {
          const svg = await documentToSvg(input.doc, session, indices[i], {
            embedImages: booleanValue(context.values, 'embedImages', true),
          });
          files.push({
            blob: new Blob([svg], { type: 'image/svg+xml' }),
            name: `${stem}-page-${pageNumber(indices[i], input.pageCount)}.svg`,
          });
          context.progress((i + 1) / indices.length, `Vectorised page ${indices[i]}`);
        }
        if (files.length === 1 || !booleanValue(context.values, 'asOne')) return filesResult(files);
        const { createZip } = await import('../core/archive');
        const blob = await createZip(files.map((file) => ({ name: file.name, data: file.blob })));
        return filesResult([{ blob, name: `${stem}-svg.zip` }], `${files.length} SVG pages zipped.`);
      } finally {
        await session.destroy();
      }
    },
  },

  {
    id: 'extract-images',
    name: 'Extract Images',
    description: 'Pull the embedded images out of a PDF at their original resolution',
    icon: '🖼️',
    category: 'convert-from',
    keywords: ['photos', 'unembed', 'gallery', 'assets'],
    surface: 'none',
    outputSuffix: '-images.zip',
    promise: 'The original image bytes, page by page — no re-encoding, so what you get is what the file held.',
    actionLabel: 'Extract images',
    notes: [
      'Only images actually stored in the file can be pulled out: a page drawn from text and vector shapes has none, and a scanned page has one image of the whole sheet (use PDF to Image for that).',
      'More than one image arrives as a single ZIP; a lone image downloads on its own.',
    ],
    fields: [
      PAGES_FIELD,
      { key: 'smallest', label: 'Ignore images smaller than', type: 'number', default: 64, min: 0, max: 2000, step: 8, integer: true, unit: 'px', group: 'Filter', help: 'Icons, bullet glyphs and 1 px masks are usually not the artwork. Set 0 to take every image the page carries.' },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const { extractPageImages } = await import('../core/images-out');
      const indices = pageSelection(input, pageSpec(context.values));
      const smallest = numberValue(context.values, 'smallest', 64);
      const stem = outputStem(input.name);
      const found: { name: string; blob: Blob }[] = [];
      for (let i = 0; i < indices.length; i++) {
        // The rail's own floor is the only size filter. The core helper also
        // drops anything 2 px or under as a decorative tile, which hid a real
        // 1x1 thumbnail the user had never asked to skip (E15).
        const images = await extractPageImages(input.doc, indices[i], {
          minSide: smallest,
          skipMasks: false,
        });
        images.forEach((image: ExtractedImage, index: number) => {
          found.push({
            // Both counters are padded from the start: `shots-p2-9.png` sorts
            // after `shots-p12-1.png` in every file manager (E17).
            name: `${stem}-p${pageNumber(indices[i], input.pageCount)}-${String(index + 1).padStart(3, '0')}.${image.extension}`,
            blob: new Blob([image.bytes], { type: image.mime }),
          });
        });
        context.progress((i + 1) / indices.length, `Scanned page ${indices[i]}`);
        throwIfAborted(context.signal);
      }
      if (found.length === 0) {
        return withWarnings(reportResult([{
          title: 'No embedded images',
          text: `No embedded image was found on the ${indices.length} selected page(s)${smallest > 0 ? ` at or above the ${smallest} px size limit` : ' at all'}. A page drawn from vectors and text has nothing to pull out; a scanned page has one image of the whole sheet, which PDF to Image renders better.`,
        }, {
          title: 'What to try instead',
          rows: [
            { label: 'Option 1', value: smallest > 0 ? `Lower "Ignore images smaller than" (now ${smallest} px).` : 'This document holds no images; try PDF to Text.' },
            { label: 'Option 2', value: 'Use PDF to Image to rasterise the pages themselves.' },
          ],
        }], {
          message: 'No extractable images.',
        }), inputNotices(input));
      }
      if (found.length === 1) return filesResult(found);
      const { createZip } = await import('../core/archive');
      const blob = await createZip(found.map((file) => ({ name: file.name, data: file.blob })));
      return filesResult(
        [{ blob, name: `${stem}-images.zip` }],
        `Extracted ${found.length} image(s) from ${indices.length} page(s).`,
      );
    },
  },

  {
    id: 'pdf-to-image',
    name: 'PDF to Image',
    description: 'Render pages as JPG, PNG, WEBP, BMP or TIFF',
    icon: '🖼️',
    category: 'convert-from',
    keywords: ['jpg', 'png', 'webp', 'bmp', 'tiff', 'screenshot'],
    surface: 'none',
    outputSuffix: '_images',
    promise: 'One image per selected page in the format you choose, zipped when the selection runs to more than one page.',
    actionLabel: 'Export images',
    notes: [
      'A rendered page is a picture: the text layer does not travel with it, so the images cannot be searched or copied.',
      'More than one page is packaged as a single ZIP; a one-page selection downloads on its own. TIFF ignores this and carries every page in one file.',
    ],
    multiFile: false,
    fields: [
      {
        key: 'format',
        label: 'File format',
        type: 'segmented',
        default: 'png',
        group: 'Output',
        options: [
          { value: 'png', label: 'PNG' }, { value: 'jpeg', label: 'JPG' },
          { value: 'webp', label: 'WEBP' }, { value: 'bmp', label: 'BMP' }, { value: 'tiff', label: 'TIFF' },
        ],
        help: 'BMP and TIFF are uncompressed, so a whole document in either is many times the size of the PDF.',
      },
      RESOLUTION_FIELD,
      qualityField('jpeg', {
        default: 0.92,
        step: 0.02,
        group: 'Output',
        help: 'Applies to JPG and WebP, the two lossy formats above. Lower saves space and adds blockiness around small text.',
        when: (v) => v.format === 'jpeg' || v.format === 'webp',
      }),
      PAGES_FIELD,
      { key: 'zip', label: 'Zip when there is more than one page', type: 'toggle', default: true, group: 'Output', help: 'Several pages are otherwise many separate downloads. TIFF ignores this: it carries every page in one file.' },
    ],
    async run(context) {
      const format = stringValue(context.values, 'format', 'png') as 'png' | 'jpeg' | 'webp' | 'bmp' | 'tiff';
      return exportPages(context, {
        format,
        extension: format === 'jpeg' ? 'jpg' : format === 'tiff' ? 'tif' : format,
        dpi: numberValue(context.values, 'dpi', 200),
        quality: numberValue(context.values, 'quality', 0.92),
        pages: pageSpec(context.values),
        zipWhenMany: booleanValue(context.values, 'zip', true),
      });
    },
  },

  ...(['pdf-to-png', 'pdf-to-jpg', 'pdf-to-webp', 'pdf-to-bmp', 'pdf-to-tiff'] as const).map((id): PdfToolDefinition => {
    const format = id === 'pdf-to-jpg' ? 'jpeg' : id.replace('pdf-to-', '') as 'png' | 'webp' | 'bmp' | 'tiff';
    const label = format === 'jpeg' ? 'JPG' : format.toUpperCase();
    return {
      id,
      name: `PDF to ${label}`,
      description: `Convert each PDF page into a ${label} image`,
      icon: '🖼️',
      category: 'convert-from',
      keywords: ['image', label.toLowerCase(), 'raster', 'export'],
      group: 'Convert from PDF',
      surface: 'none',
      outputSuffix: `_${format}s`,
      promise:
        format === 'tiff'
          ? 'Every selected page as a TIFF, several pages written into one multi-page file.'
          : `Every selected page as its own ${label} image, packaged as one ZIP when there is more than one.`,
      actionLabel: `Export ${label}`,
      notes:
        format === 'tiff'
          ? ['A rendered page is a picture: the text layer does not travel with it.', 'Several pages are written into one multi-page TIFF rather than a ZIP.']
          : RASTER_OUT_NOTES,
      fields: [RESOLUTION_FIELD, PAGES_FIELD],
      async run(context) {
        return exportPages(context, {
          format,
          extension: format === 'jpeg' ? 'jpg' : format === 'tiff' ? 'tif' : format,
          dpi: numberValue(context.values, 'dpi', 200),
          quality: 0.92,
          pages: pageSpec(context.values),
          zipWhenMany: true,
        });
      },
    };
  }),

  {
    id: 'pdf-to-greyscale',
    name: 'PDF to Greyscale',
    description: 'Convert every colour space in the document to black and white',
    icon: '⚪',
    category: 'convert-from',
    keywords: ['black and white', 'monochrome', 'print cheaper', 'desaturate'],
    outputSuffix: '_greyscale.pdf',
    promise: 'A black-and-white copy of the pages you choose, recoloured so the text stays selectable unless you ask for a re-render.',
    actionLabel: 'Convert to greyscale',
    notes: [
      'Recolouring changes the colour operators only; a page whose grey already equals black, or whose colour lives inside an image, comes out unchanged and the result says how much was converted.',
      'Re-render mode photographs the selected pages and writes only those into the result: their text becomes pixels and the pages you left out are not carried over.',
    ],
    fields: [
      { key: 'mode', label: 'Method', type: 'segmented', default: 'vectors', group: 'Method', options: [
        { value: 'vectors', label: 'Recolour (keeps text selectable)' },
        { value: 'raster', label: 'Re-render (guaranteed, larger)' },
      ], help: 'Recolour rewrites the colour operators and loses nothing you can select. Re-render photographs the page, which catches colour that recolouring cannot reach — and throws away the text layer.' },
      resolutionField({
        key: 'dpi',
        group: 'Method',
        max: 400,
        when: (v) => v.mode === 'raster',
        help: 'Only used by re-render. Higher is sharper and heavier, and the text is already gone either way.',
      }),
      PAGES_FIELD,
    ],
    async run(context) {
      const [input] = await openInputs(context);
      if (stringValue(context.values, 'mode', 'vectors') === 'raster') {
        // Checked here, in words a user can read: `applyColorFilter` resolves the
        // same spec against the render session, where an unknown page surfaces
        // as a raw `PageSpecError` (E6).
        const wanted = pageSelection(input, pageSpec(context.values));
        const { dpi } = resolveDpi(numberValue(context.values, 'dpi', 200));
        const { applyColorFilter } = await import('../core/measure');
        const { session } = await withRender(input, context);
        try {
          const bytes = await applyColorFilter(session, input.doc, {
            grayscale: true,
            brightness: 1,
            contrast: 1,
            saturation: 1,
            hue: 0,
            invert: false,
            pages: wanted.join(','),
            dpi,
            progress: context.progress,
            signal: context.signal,
          });
          return withWarnings(
            {
              kind: 'pdf',
              bytes,
              message: `Re-rendered ${wanted.length} page(s) at ${dpi} dpi. Text is now part of the image and can no longer be selected or searched.`,
            },
            inputNotices(input),
          );
        } finally {
          await session.destroy();
        }
      }
      const { greyscalePage } = await import('../core/content');
      const indices = pageSelection(input, pageSpec(context.values)).map((page) => page - 1);
      let changed = 0;
      for (let i = 0; i < indices.length; i++) {
        changed += greyscalePage(input.doc.getPage(indices[i]));
        context.progress((i + 1) / indices.length, `Page ${indices[i] + 1}`);
      }
      const bytes = await savePDF(input.doc);
      return {
        kind: 'pdf',
        bytes,
        message: changed > 0
          ? `Converted ${changed} colour operation(s) to grey across ${indices.length} page(s). Text stays selectable.`
          : 'This document already had no colour operations to convert.',
      };
    },
  },

  {
    id: 'page-dimensions',
    name: 'Page Dimensions',
    description: 'Report the size, orientation and named format of every page',
    icon: '📐',
    category: 'organize',
    keywords: ['measure', 'a4', 'letter', 'audit', 'size'],
    surface: 'none',
    outputSuffix: '_dimensions.txt',
    promise: 'A report of every page’s size in points and millimetres, its orientation, named format and rotation.',
    actionLabel: 'Measure pages',
    notes: [
      'Sizes are read from each page’s own crop box as a viewer displays it, so a page carrying /Rotate is reported the way it prints.',
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const rows = pageSizeReport(input.doc);
      const distinct = new Map<string, number>();
      for (const row of rows) distinct.set(row.name, (distinct.get(row.name) ?? 0) + 1);
      return reportResult(
        [
          {
            title: 'Summary',
            rows: [...distinct.entries()].map(([name, count]) => ({ label: name, value: `${count} page(s)` })),
          },
          {
            title: 'Every page',
            rows: rows.map((row) => ({
              label: `Page ${row.page}`,
              value: `${row.widthPt.toFixed(1)} × ${row.heightPt.toFixed(1)} pt · ${row.widthMm.toFixed(0)} × ${row.heightMm.toFixed(0)} mm · ${row.orientation}${row.rotation ? ` · rotated ${row.rotation}°` : ''}`,
            })),
          },
        ],
        { message: `${rows.length} page(s), ${distinct.size} distinct size(s).` },
      );
    },
  },
];

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Every table in the selection, plus what the pages actually gave up.
 *
 * The facts are collected on the same pass as the tables because "no tables
 * were found" is two different pieces of news (E10, E13): the page is prose,
 * or the page is a scan with no text layer at all. Only the second one wants
 * OCR.
 */
async function collectTables(context: ToolRunContext): Promise<TableHaul> {
  const [input] = await openInputs(context);
  const { session } = await withRender(input, context);
  try {
    const indices = pageSelection(input, pageSpec(context.values));
    const minRows = numberValue(context.values, 'minRows', 3);
    const out: DetectedTable[] = [];
    const pages: ExtractionFacts['pages'] = [];
    for (let i = 0; i < indices.length; i++) {
      const items = await session.textItems(indices[i]);
      const found = detectTables(items, { minRows }).map((table) => ({ ...table, page: indices[i] }));
      out.push(...found);
      pages.push({
        page: indices[i],
        chars: readableChars(items.map((item) => item.str).join(' ')),
        images: countImages(input.doc.getPage(indices[i] - 1)),
        tables: found.length,
      });
      context.progress((i + 1) / indices.length, `Looked for tables on page ${indices[i]}`);
    }
    return {
      input,
      tables: out.sort((a, b) => a.page - b.page),
      facts: factsFromPages(pages),
    };
  } finally {
    await session.destroy();
  }
}

/** E13 for the table trio, phrased for what the pages really were (E10). */
function noTablesFound(input: OpenedInput, facts: ExtractionFacts, minRows: number): ToolResult {
  if (facts.pages.length === 0) {
    return noPagesSelected(input);
  }
  const scanned = facts.chars === 0 && facts.images > 0;
  return nothingFound(
    'No tables found',
    scanned
      ? `${ofPages(facts)} page(s) hold images but no text layer, so there is no grid of cells to read — the page is a scan, not a table.`
      : `No grid of aligned columns was found on ${facts.pages.length} page(s), so there is nothing to put in a table.`,
    scanned
      ? ['Run OCR (Searchable PDF) on this file first, then extract the table again.', 'Or export the pages with PDF to Image and read the figures off the picture.']
      : [`Lower the minimum rows setting (now ${minRows}) — a short block still counts.`, 'Use PDF to Text when the page is prose: it keeps the words in reading order.'],
  );
}

function toMarkdownTable(table: DetectedTable): string {
  const header = table.headerRow ?? table.rows[0] ?? [];
  const body = table.headerRow ? table.rows : table.rows.slice(1);
  const line = (cells: string[]) => `| ${cells.map((cell) => cell.replace(/\|/g, '\\|')).join(' | ')} |`;
  if (header.length === 0) return line(body[0] ?? []);
  return [
    line(header),
    `|${header.map(() => ' --- ').join('|')}|`,
    ...body.map(line),
  ].join('\n');
}

