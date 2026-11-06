/**
 * Convert from PDF.
 *
 * Every extraction path is built on pdf.js text runs plus `core/convert` and
 * `core/tables`, so the output is real, selectable data rather than a
 * screenshot. The old `pdf-to-word` and `pdf-to-excel` forced every run to
 * Calibri and treated "items on the same line" as a table; both are replaced.
 */
import { savePDF } from '../core/doc';
import { resolvePages } from '../core/pages';
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
  baseName,
  filesResult,
  openInputs,
  reportResult,
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
} from './types';

/* ── naming (E17) ─────────────────────────────────────────────────────────── */

/** Longest stem kept for a download or an archive entry. */
const STEM_LIMIT = 120;

/**
 * A file stem that survives spaces, unicode and the characters Windows, macOS
 * and ZIP refuse in a name (E17).
 *
 * Extraction output is usually several files at once — one image per page, one
 * entry per table — all named from the source document, so a stray `/`, a NUL
 * or a trailing dot yields an entry some unzippers reject and a download the
 * browser silently renames. Unicode (CJK, RTL marks, accents) is preserved on
 * purpose: transliterating `报告` to `baogao` would misreport which file the
 * user actually picked.
 */
function outputStem(name: string): string {
  const cleaned = baseName(name ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/[<>:"/\\|?*]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.-]+|[\s.-]+$/g, '');
  const clipped = Array.from(cleaned)
    .slice(0, STEM_LIMIT)
    .join('')
    .replace(/[\s.-]+$/, '');
  return clipped === '' ? 'document' : clipped;
}

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

function extractionFacts(json: PdfJsonDocument): ExtractionFacts {
  const pages = json.pages.map((item) => ({
    page: item.page,
    chars: readableChars(item.text || item.blocks.map((block) => block.text ?? '').join(' ')),
    images: item.images,
    tables: item.blocks.filter((block) => block.type === 'table').length,
  }));
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
    pages: string;
    zipWhenMany?: boolean;
  },
) {
  const [input] = await openInputs(context);
  const { session } = await withRender(input, context);
  try {
    const indices = resolvePages(options.pages, input.pageCount).map((p) => p + 1);
    if (indices.length === 0) {
      return nothingFound(
        'No page selected',
        `"${input.name}" has ${singular(input.pageCount, 'page')} and the selection matched none of them.`,
        ['Use "all", or list pages the way 1-3,7.'],
      );
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
      `${files.length} ${options.format.toUpperCase()} image(s) at ${dpi} dpi`,
      sizes.size > 1 ? `${sizes.size} different page sizes` : 'one page size',
      rotated > 0 ? `${rotated} rotated page(s) kept upright` : null,
    ]
      .filter(Boolean)
      .join(' · ')
      + '.';
    if (options.format === 'tiff' && files.length > 1) {
      const merged = await concatTiffs(files.map((file) => file.blob));
      return withWarnings(
        filesResult([{ blob: merged, name: `${stem}.tif` }], `${files.length} pages in one multi-page TIFF.`),
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

const RESOLUTION_FIELD = {
  key: 'dpi',
  label: 'Resolution',
  type: 'slider' as const,
  default: 200,
  min: 72,
  max: 600,
  step: 1,
  unit: 'dpi',
  help: 'Higher means sharper and bigger. 200 dpi is fine for screen, 300 for print.',
};

const PAGES_FIELD = { key: 'pages', label: 'Pages', type: 'pages' as const, default: 'all' };

async function buildJson(context: ToolRunContext) {
  const [input] = await openInputs(context);
  const { session } = await withRender(input, context);
  try {
    const indices = resolvePages(stringValue(context.values, 'pages', 'all'), input.pageCount).map((p) => p + 1);
    if (indices.length === 0) {
      return { input, json: { meta: {}, pages: [] } as PdfJsonDocument, empty: true };
    }
    const json = await documentToJson(input.doc, session, indices);
    context.progress(0.9, `Read ${json.pages.length} page(s)`);
    return { input, json, empty: false };
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
    fields: [
      PAGES_FIELD,
      { key: 'layout', label: 'Keep line layout', type: 'toggle', default: true, help: 'Off joins wrapped lines into flowing paragraphs.' },
      { key: 'pageMarkers', label: 'Insert page break markers', type: 'toggle', default: false },
    ],
    async run(context) {
      const { json } = await buildJson(context);
      const text = jsonToText(json, {
        pageMarkers: booleanValue(context.values, 'pageMarkers'),
        formFeed: booleanValue(context.values, 'layout', true),
      });
      const words = text.split(/\s+/).filter(Boolean).length;
      return filesResult(
        textFiles(context.inputs[0].name, 'txt', text),
        `Extracted ${words.toLocaleString()} words from ${json.pages.length} page(s).`,
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
    fields: [
      PAGES_FIELD,
      { key: 'tables', label: 'Rebuild tables as Markdown tables', type: 'toggle', default: true },
      { key: 'headings', label: 'Detect headings from font sizes', type: 'toggle', default: true },
      { key: 'pageBreaks', label: 'Separate pages with a rule', type: 'toggle', default: false },
    ],
    async run(context) {
      const { json } = await buildJson(context);
      const markdown = jsonToMarkdown(json, {
        headingHeights: booleanValue(context.values, 'headings', true) ? detectHeadingHeights(json) : [],
        tables: booleanValue(context.values, 'tables', true),
        pageBreaks: booleanValue(context.values, 'pageBreaks'),
      });
      return filesResult(
        textFiles(context.inputs[0].name, 'md', markdown),
        `Wrote ${markdown.split('\n').length} lines of Markdown.`,
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
    fields: [PAGES_FIELD, { key: 'tables', label: 'Detect tables', type: 'toggle', default: true }],
    async run(context) {
      const { json } = await buildJson(context);
      const body = JSON.stringify(json, null, 2);
      return filesResult(
        [{ blob: new Blob([body], { type: 'application/json' }), name: `${baseName(context.inputs[0].name)}.json` }],
        `${json.pages.length} page(s), ${json.pages.reduce((n, page) => n + page.blocks.length, 0)} block(s).`,
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
    fields: [
      PAGES_FIELD,
      { key: 'title', label: 'Document id', type: 'text', help: 'Defaults to the file name.' },
      { key: 'extra', label: 'Extra metadata (JSON)', type: 'textarea', default: '' },
    ],
    async run(context) {
      const { json } = await buildJson(context);
      const extra = stringValue(context.values, 'extra').trim();
      let parsed: Record<string, unknown> | undefined;
      if (extra) {
        try {
          parsed = JSON.parse(extra) as Record<string, unknown>;
        } catch {
          throw new Error('The extra metadata must be valid JSON, for example {"source": "contracts"}.');
        }
      }
      const doc = jsonToLlamaIndex(json, {
        title: stringValue(context.values, 'title') || context.inputs[0].name,
        extraMetadata: parsed,
      });
      const chunks = Object.keys(doc.ref_doc_info).length;
      return filesResult(
        [{ blob: new Blob([JSON.stringify(doc)], { type: 'application/json' }), name: `${baseName(context.inputs[0].name)}-llamaindex.json` }],
        `Produced ${chunks} reference document(s) ready for an index.`,
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
    fields: [
      PAGES_FIELD,
      { key: 'minRows', label: 'Minimum rows to count as a table', type: 'number', default: 3, min: 2, max: 20, half: true },
      { key: 'delimiter', label: 'Delimiter', type: 'select', default: ',', options: [
        { value: ',', label: 'Comma' }, { value: ';', label: 'Semicolon' }, { value: '\t', label: 'Tab' },
      ] },
    ],
    async run(context) {
      const tables = await collectTables(context);
      if (tables.length === 0) {
        throw new Error('No table-like structure was found. Lower the minimum row count, or use PDF to Text.');
      }
      const csv = tablesToCsv(tables, stringValue(context.values, 'delimiter', ','));
      return filesResult(
        textFiles(context.inputs[0].name, 'csv', csv),
        `Extracted ${tables.length} table(s) totalling ${tables.reduce((n, table) => n + table.rows.length, 0)} rows.`,
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
    fields: [
      PAGES_FIELD,
      { key: 'format', label: 'Format', type: 'segmented', default: 'json', options: [
        { value: 'json', label: 'JSON' }, { value: 'csv', label: 'CSV' }, { value: 'md', label: 'Markdown' },
      ] },
      { key: 'minRows', label: 'Minimum rows', type: 'number', default: 2, min: 2, max: 20 },
    ],
    async run(context) {
      const tables = await collectTables(context);
      if (tables.length === 0) throw new Error('No tables were found in the selected pages.');
      const format = stringValue(context.values, 'format', 'json');
      const name = baseName(context.inputs[0].name);
      if (format === 'csv') {
        return filesResult(textFiles(context.inputs[0].name, 'csv', tablesToCsv(tables)), `${tables.length} table(s).`);
      }
      if (format === 'md') {
        const body = tables.map((table, index) => `## Table ${index + 1}\n\n${toMarkdownTable(table)}`).join('\n\n');
        return filesResult(textFiles(context.inputs[0].name, 'md', body), `${tables.length} table(s).`);
      }
      return filesResult(
        [{ blob: new Blob([JSON.stringify({ tables }, null, 2)], { type: 'application/json' }), name: `${name}-tables.json` }],
        `${tables.length} table(s) with ${tables.reduce((n, table) => n + table.rows.length, 0)} rows.`,
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
    fields: [
      PAGES_FIELD,
      { key: 'oneSheet', label: 'Put everything on one sheet', type: 'toggle', default: false },
      { key: 'minRows', label: 'Minimum rows', type: 'number', default: 2, min: 2, max: 20 },
    ],
    async run(context) {
      const tables = await collectTables(context);
      if (tables.length === 0) throw new Error('No tables were detected, so there is nothing to put in a workbook.');
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
      return filesResult(
        [{
          blob: new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
          name: `${baseName(context.inputs[0].name)}.xlsx`,
        }],
        `${tables.length} table(s) across ${workbook.SheetNames.length} worksheet(s).`,
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
    fields: [
      PAGES_FIELD,
      { key: 'headings', label: 'Map font sizes to Word heading styles', type: 'toggle', default: true },
      { key: 'tables', label: 'Rebuild tables as Word tables', type: 'toggle', default: true },
      { key: 'pageBreaks', label: 'Start a new page for each PDF page', type: 'toggle', default: false },
    ],
    async run(context) {
      const { json } = await buildJson(context);
      const { buildDocx } = await import('../core/docx-out');
      const blob = await buildDocx(json, {
        headings: booleanValue(context.values, 'headings', true),
        tables: booleanValue(context.values, 'tables', true),
        pageBreaks: booleanValue(context.values, 'pageBreaks'),
      });
      return filesResult(
        [{ blob, name: `${baseName(context.inputs[0].name)}.docx` }],
        `Wrote a Word document from ${json.pages.length} page(s). Text is editable; original positions are not preserved.`,
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
    fields: [
      PAGES_FIELD,
      { key: 'embedImages', label: 'Embed raster images as data URIs', type: 'toggle', default: true },
      { key: 'asOne', label: 'One SVG per document instead of per page', type: 'toggle', default: false },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const { session } = await withRender(input, context);
      try {
        const { documentToSvg } = await import('../core/convert');
        const indices = resolvePages(stringValue(context.values, 'pages', 'all'), input.pageCount).map((p) => p + 1);
        const files: { blob: Blob; name: string }[] = [];
        for (let i = 0; i < indices.length; i++) {
          const svg = await documentToSvg(input.doc, session, indices[i], {
            embedImages: booleanValue(context.values, 'embedImages', true),
          });
          files.push({
            blob: new Blob([svg], { type: 'image/svg+xml' }),
            name: `${baseName(input.name)}-page-${String(indices[i]).padStart(3, '0')}.svg`,
          });
          context.progress((i + 1) / indices.length, `Vectorised page ${indices[i]}`);
        }
        if (files.length === 1 || !booleanValue(context.values, 'asOne')) return filesResult(files);
        const { createZip } = await import('../core/archive');
        const blob = await createZip(files.map((file) => ({ name: file.name, data: file.blob })));
        return filesResult([{ blob, name: `${baseName(input.name)}-svg.zip` }], `${files.length} SVG pages zipped.`);
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
    fields: [
      PAGES_FIELD,
      { key: 'smallest', label: 'Ignore images smaller than', type: 'number', default: 64, min: 0, max: 2000, step: 8, unit: 'px' },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const { extractPageImages } = await import('../core/images-out');
      const indices = resolvePages(stringValue(context.values, 'pages', 'all'), input.pageCount).map((p) => p + 1);
      const smallest = numberValue(context.values, 'smallest', 64);
      const found: { name: string; blob: Blob }[] = [];
      for (let i = 0; i < indices.length; i++) {
        const images = await extractPageImages(input.doc, indices[i], { minSide: smallest });
        images.forEach((image: ExtractedImage, index: number) => {
          found.push({
            name: `${baseName(input.name)}-p${indices[i]}-${String(index + 1).padStart(2, '0')}.${image.extension}`,
            blob: new Blob([image.bytes], { type: image.mime }),
          });
        });
        context.progress((i + 1) / indices.length, `Scanned page ${indices[i]}`);
      }
      if (found.length === 0) {
        return reportResult([{ title: 'Images', text: 'No embedded images were found above the size limit. If the pages are scans, use PDF to PNG instead.' }], {
          message: 'No extractable images.',
        });
      }
      if (found.length === 1) return filesResult(found);
      const { createZip } = await import('../core/archive');
      const blob = await createZip(found.map((file) => ({ name: file.name, data: file.blob })));
      return filesResult([{ blob, name: `${baseName(input.name)}-images.zip` }], `Extracted ${found.length} image(s).`);
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
    multiFile: false,
    fields: [
      {
        key: 'format',
        label: 'Format',
        type: 'segmented',
        default: 'png',
        options: [
          { value: 'png', label: 'PNG' }, { value: 'jpeg', label: 'JPG' },
          { value: 'webp', label: 'WEBP' }, { value: 'bmp', label: 'BMP' }, { value: 'tiff', label: 'TIFF' },
        ],
      },
      RESOLUTION_FIELD,
      { key: 'quality', label: 'Quality', type: 'slider', default: 0.92, min: 0.3, max: 1, step: 0.02, when: (v) => v.format === 'jpeg' || v.format === 'webp' },
      PAGES_FIELD,
      { key: 'zip', label: 'Zip when there is more than one page', type: 'toggle', default: true },
    ],
    async run(context) {
      const format = stringValue(context.values, 'format', 'png') as 'png' | 'jpeg' | 'webp' | 'bmp' | 'tiff';
      return exportPages(context, {
        format,
        extension: format === 'jpeg' ? 'jpg' : format === 'tiff' ? 'tif' : format,
        dpi: numberValue(context.values, 'dpi', 200),
        quality: numberValue(context.values, 'quality', 0.92),
        pages: stringValue(context.values, 'pages', 'all'),
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
      surface: 'none',
      outputSuffix: `_${format}s`,
      fields: [RESOLUTION_FIELD, PAGES_FIELD],
      async run(context) {
        return exportPages(context, {
          format,
          extension: format === 'jpeg' ? 'jpg' : format === 'tiff' ? 'tif' : format,
          dpi: numberValue(context.values, 'dpi', 200),
          quality: 0.92,
          pages: stringValue(context.values, 'pages', 'all'),
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
    fields: [
      { key: 'mode', label: 'Method', type: 'segmented', default: 'vectors', options: [
        { value: 'vectors', label: 'Recolour (keeps text selectable)' },
        { value: 'raster', label: 'Re-render (guaranteed, larger)' },
      ] },
      { key: 'dpi', label: 'Re-render resolution', type: 'slider', default: 200, min: 96, max: 400, step: 1, unit: 'dpi', when: (v) => v.mode === 'raster' },
      PAGES_FIELD,
    ],
    async run(context) {
      const [input] = await openInputs(context);
      if (stringValue(context.values, 'mode', 'vectors') === 'raster') {
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
            pages: stringValue(context.values, 'pages', 'all'),
            dpi: numberValue(context.values, 'dpi', 200),
            progress: context.progress,
            signal: context.signal,
          });
          return { kind: 'pdf', bytes, message: 'Re-rendered every page in greyscale. Text is now part of the image.' };
        } finally {
          await session.destroy();
        }
      }
      const { greyscalePage } = await import('../core/content');
      const indices = resolvePages(stringValue(context.values, 'pages', 'all'), input.pageCount);
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
          ? `Converted ${changed} colour operation(s) to grey. Text stays selectable.`
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

async function collectTables(context: ToolRunContext): Promise<DetectedTable[]> {
  const [input] = await openInputs(context);
  const { session } = await withRender(input, context);
  try {
    const indices = resolvePages(stringValue(context.values, 'pages', 'all'), input.pageCount).map((p) => p + 1);
    const minRows = numberValue(context.values, 'minRows', 3);
    const out: DetectedTable[] = [];
    for (let i = 0; i < indices.length; i++) {
      const items = await session.textItems(indices[i]);
      for (const table of detectTables(items, { minRows })) {
        out.push({ ...table, page: indices[i] });
      }
      context.progress((i + 1) / indices.length, `Looked for tables on page ${indices[i]}`);
    }
    return out.sort((a, b) => a.page - b.page);
  } finally {
    await session.destroy();
  }
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

