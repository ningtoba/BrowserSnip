/**
 * Structured exports: PDF → JSON, Markdown, plain text, LlamaIndex JSON,
 * HTML and SVG.
 *
 * Two halves live here. `documentToJson` plus the four `jsonTo*` writers are
 * pure string/JSON work over `ExtractedTextItem[]` and a pdf-lib document, so
 * they are fully unit-testable in jsdom. `documentToSvg` is a small interpreter
 * over pdf.js's `page.getOperatorList()`; the interpreter itself
 * ({@link operatorListToSvg}) is pure — it takes the operator list, the numeric
 * `OPS` table and lookup callbacks — so it is testable too, and only the
 * surrounding glue touches pdf.js objects.
 *
 * Honest limitations, all of which are also reported in the SVG output:
 *
 * - **Text is emitted as live `<text>`, not glyph outlines.** `fontToPath: true`
 *   asks for outlines and gets them only where pdf.js actually transferred the
 *   glyph path data for a character (it builds those lazily, and
 *   `core/render.openRender` does not request them); every other run stays live
 *   text and is counted in `stats.liveTextRuns`. Live text needs the page's
 *   fonts available to the SVG viewer.
 * - **Clip paths are consumed, not emitted**: a `W`/`W*` still swallows the
 *   path the way PDF does, but nothing is masked, so art that relies on a clip
 *   can bleed.
 * - **Shading / tiling patterns** (`sh` and the `scn`/`SCN` pattern forms) have
 *   no SVG equivalent here and are skipped.
 * - `pdfjs-dist` is loaded with a dynamic `import()` inside
 *   {@link documentToSvg} so importing this module in jsdom never pulls the
 *   pdf.js display bundle in.
 *
 * Coordinate contract for the JSON: block and line rects are in **rotated
 * viewer space with a top-left origin, in PDF points** — identical to
 * `ExtractedTextItem.x/y/w/h` from `core/render`, and therefore directly
 * usable on top of a page rendered at scale 1. (`core/ocr` uses unrotated
 * bottom-left user space instead, because it writes real PDF text; the two
 * conversions are both in `core/tables`.)
 */
import { PDFName } from '@maxwbh/pdf-lib';
import type { PDFDict, PDFDocument, PDFObject, PDFPage } from '@maxwbh/pdf-lib';
import type { ExtractedTextItem, PdfSession } from './render';
import type { QuadRect } from './annotations';
import {
  clusterRows,
  detectTables,
  fmtNumber,
  pageFrameOfView,
  quarterTurn,
  svgMatrix,
  userSpaceToSvgMatrix,
  viewerSizeOf,
} from './tables';
import type { PageFrame, TextRow } from './tables';

export type { QuadRect } from './annotations';

// ---------------------------------------------------------------------------
// JSON model
// ---------------------------------------------------------------------------

export interface PdfJsonLine {
  text: string;
  bbox: QuadRect;
  /** Glyph height of the tallest run on the line, in points. */
  fontHeight: number;
}

export interface PdfJsonBlock {
  type: 'text' | 'image' | 'table';
  rect: QuadRect;
  text?: string;
  lines?: PdfJsonLine[];
  /** Present for `type: 'table'`; rectangular, `''` for empty cells. */
  rows?: string[][];
}

export interface PdfJsonPage {
  /** 1-based, matching `PdfSession`. */
  page: number;
  /** Displayed size after `/Rotate`, in points. */
  width: number;
  height: number;
  rotation: number;
  text: string;
  blocks: PdfJsonBlock[];
  images: number;
  links: string[];
}

export interface PdfJsonDocument {
  meta: Record<string, unknown>;
  pages: PdfJsonPage[];
}

export interface BlockOptions {
  /** Baseline clustering tolerance in points. Default 3 (as `core/render`). */
  tolerance?: number;
  /** A vertical gap larger than `lineHeight × factor` starts a new block. */
  paragraphGapFactor?: number;
  /** Extra options forwarded to {@link detectTables}. */
  minRows?: number;
  minColGap?: number;
}

/** Visible text of one clustered row: runs left to right, single-spaced. */
export function rowText(row: TextRow): string {
  return row.items
    .map((item) => item.str)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Bounding box of a row (or any run list) in the item space. */
export function itemsRect(items: readonly ExtractedTextItem[]): QuadRect {
  const xs = items.map((i) => i.x);
  const ys = items.map((i) => i.y);
  const x2 = items.map((i) => i.x + i.w);
  const y2 = items.map((i) => i.y + i.h);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x: round(x, 3),
    y: round(y, 3),
    width: round(Math.max(...x2) - x, 3),
    height: round(Math.max(...y2) - y, 3),
  };
}

/** One {@link PdfJsonLine} per visual row. */
export function linesFromRows(rows: TextRow[]): PdfJsonLine[] {
  return rows.map((row) => ({
    text: rowText(row),
    bbox: itemsRect(row.items),
    fontHeight: round(Math.max(...row.items.map((i) => Math.abs(i.h))), 3),
  }));
}

/**
 * Merge rows into paragraph blocks. A new block starts when the vertical gap
 * to the previous row exceeds the text height times `paragraphGapFactor`, or
 * when the horizontal indent changes abruptly (a list item, a hanging block).
 */
export function blocksFromItems(items: ExtractedTextItem[], opts: BlockOptions = {}): PdfJsonBlock[] {
  const rows = clusterRows(items, opts.tolerance ?? 3);
  const gapFactor = opts.paragraphGapFactor ?? 1.7;
  const blocks: PdfJsonBlock[] = [];
  let current: TextRow[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const lines = linesFromRows(current);
    blocks.push({
      type: 'text',
      rect: itemsRect(current.flatMap((row) => row.items)),
      text: lines.map((line) => line.text).join('\n'),
      lines,
    });
    current = [];
  };

  let previous: TextRow | null = null;
  for (const row of rows) {
    const height = Math.max(1, row.bottom - row.top);
    const gap = previous ? row.top - previous.bottom : 0;
    const indentShift = previous ? Math.abs(row.items[0].x - previous.items[0].x) : 0;
    const breaks =
      previous !== null &&
      (gap > height * gapFactor || (gap > height * 0.35 && indentShift > height * 2));
    if (breaks) flush();
    current.push(row);
    previous = row;
  }
  flush();
  return blocks;
}

/**
 * True when `outer` contains most of `inner`, which is how a detected table
 * claims the paragraph blocks that overlap it (60 % of the area by default).
 */
export function covers(outer: QuadRect, inner: QuadRect, ratio = 0.6): boolean {
  const area = Math.max(0, inner.width) * Math.max(0, inner.height);
  if (area <= 0) return false;
  const overlapX = Math.max(0, Math.min(outer.x + outer.width, inner.x + inner.width) - Math.max(outer.x, inner.x));
  const overlapY = Math.max(0, Math.min(outer.y + outer.height, inner.y + inner.height) - Math.max(outer.y, inner.y));
  return (overlapX * overlapY) / area >= ratio;
}

/** Text blocks with detected tables spliced in (table area removed from prose). */
export function blocksWithTables(items: ExtractedTextItem[], opts: BlockOptions = {}): PdfJsonBlock[] {
  const tables = detectTables(items, {
    minRows: opts.minRows,
    tolerance: opts.tolerance,
    minColGap: opts.minColGap,
  });
  const blocks = blocksFromItems(items, opts);
  if (tables.length === 0) return blocks;
  const kept = blocks.filter((block) => !tables.some((table) => covers(table.rect, block.rect)));
  const tableBlocks: PdfJsonBlock[] = tables.map((table) => ({
    type: 'table',
    rect: table.rect,
    rows: table.rows,
    text: table.rows.map((row) => row.join('\t')).join('\n'),
  }));
  return [...kept, ...tableBlocks].sort((a, b) => a.rect.y - b.rect.y);
}

/**
 * Structured export of the document (or the listed 1-based pages): metadata,
 * per-page display geometry, paragraph/table/image blocks with bboxes, the
 * embedded-image count and every link URI.
 */
export async function documentToJson(
  doc: PDFDocument,
  session: PdfSession,
  pages?: number[],
): Promise<PdfJsonDocument> {
  const wanted = pages && pages.length > 0 ? [...pages] : sequential(1, session.numPages);
  const out: PdfJsonPage[] = [];

  for (const pageNumber of wanted) {
    if (pageNumber < 1 || pageNumber > session.numPages) {
      throw new Error(
        `Page ${pageNumber} is outside this document, which has ${session.numPages} page(s).`,
      );
    }
    const items = await session.textItems(pageNumber);
    const lib = doc.getPage(pageNumber - 1);
    const size = lib.getSize();
    const rotation = quarterTurn(lib.getRotation().angle);
    const displayed = viewerSizeOf({ x0: 0, y0: 0, width: size.width, height: size.height, rotation });
    const blocks = blocksWithTables(items);
    out.push({
      page: pageNumber,
      width: round(displayed.width, 3),
      height: round(displayed.height, 3),
      rotation,
      text: pageText(blocks),
      blocks,
      images: countImages(lib),
      links: pageLinks(lib),
    });
  }

  return { meta: await documentMeta(doc, session), pages: out };
}

function pageText(blocks: readonly PdfJsonBlock[]): string {
  return blocks
    .slice()
    .sort((a, b) => a.rect.y - b.rect.y)
    .map((block) => block.text ?? '')
    .filter((text) => text.trim() !== '')
    .join('\n\n');
}

async function documentMeta(
  doc: PDFDocument,
  session: PdfSession,
): Promise<Record<string, unknown>> {
  const meta: Record<string, unknown> = {
    pageCount: doc.getPageCount(),
    title: doc.getTitle() ?? undefined,
    author: doc.getAuthor() ?? undefined,
    subject: doc.getSubject() ?? undefined,
    keywords: doc.getKeywords() ?? undefined,
    creator: doc.getCreator() ?? undefined,
    producer: doc.getProducer() ?? undefined,
    creationDate: doc.getCreationDate()?.toISOString(),
    modificationDate: doc.getModificationDate()?.toISOString(),
  };
  try {
    const rendered = await session.metadata();
    meta.fingerprint = rendered.fingerprint;
    meta.formFields = rendered.formFields;
    if (!meta.title && rendered.title) meta.title = rendered.title;
    if (!meta.producer && rendered.producer) meta.producer = rendered.producer;
    if (!meta.creator && rendered.creator) meta.creator = rendered.creator;
    if (!meta.creationDate && rendered.creationDate) meta.creationDate = rendered.creationDate;
    if (!meta.modificationDate && rendered.modDate) meta.modificationDate = rendered.modDate;
  } catch {
    // Metadata is optional decoration on the JSON; never fail the export for it.
  }
  return dropUndefined(meta);
}

function dropUndefined(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** `/Resources /XObject` entries with `/Subtype /Image`. */
export function countImages(page: PDFPage): number {
  const resources = pageResources(page);
  const xobjects = dictAt(page.doc.context, resources, 'XObject');
  if (!xobjects) return 0;
  let count = 0;
  for (const [, value] of xobjects.entries()) {
    const dict = streamDictOf(resolveValue(page.doc.context, value));
    if (nameOf(dict, 'Subtype') === 'Image') count += 1;
  }
  return count;
}

/** Link URIs in annotation order, resolving `/A /URI` and `/Action /URI`. */
export function pageLinks(page: PDFPage): string[] {
  // /Annots is declared as an array but may arrive as a reference.
  const annots = resolveValue(page.doc.context, page.node.Annots());
  // A malformed /Annots (a dict instead of an array, say) must not throw.
  if (!isPdfArrayLike(annots)) return [];
  const out: string[] = [];
  for (let i = 0; i < annots.size(); i++) {
    const entry = dictLike(page.doc.context, annots.get(i));
    if (!entry || nameOf(entry, 'Subtype') !== 'Link') continue;
    const action =
      dictAt(page.doc.context, entry, 'A') ?? dictAt(page.doc.context, entry, 'Action');
    const uri = textOf(action, 'URI');
    if (uri) out.push(uri);
  }
  return out;
}

function pageResources(page: PDFPage): DictLike | undefined {
  try {
    // `Resources()` walks the inheritable tree for us; the value it hands back
    // can still be a reference rather than the dictionary itself.
    return dictLike(page.doc.context, page.node.Resources());
  } catch {
    return undefined;
  }
}

/**
 * Object readers below are duck-typed rather than `instanceof`-based: pdf-lib's
 * typed `lookupMaybe(ref, PDFStream)` throws on a mismatching entry, and a
 * malformed or foreign object must degrade to “no image here”, never abort an
 * export.
 */
interface DictLike {
  get(key: PDFName): PDFObject | undefined;
  entries(): [PDFName, PDFObject][];
}

interface PdfArrayLike {
  size(): number;
  get(index: number): PDFObject | undefined;
}

interface NameLike {
  asString(): string;
}

interface StringLike {
  decodeText(): string;
}

function hasMethod(value: unknown, name: string): boolean {
  return typeof (value as Record<string, unknown> | undefined)?.[name] === 'function';
}

function isDictLike(value: unknown): value is PDFObject & DictLike {
  return hasMethod(value, 'get') && hasMethod(value, 'entries');
}

function isPdfArrayLike(value: unknown): value is PDFObject & PdfArrayLike {
  return hasMethod(value, 'get') && hasMethod(value, 'size');
}

function isNameLike(value: unknown): value is PDFObject & NameLike {
  return hasMethod(value, 'asString');
}

function isStringLike(value: unknown): value is PDFObject & StringLike {
  return hasMethod(value, 'decodeText');
}

/** Any stream object (raw, flate, DCT…) carries its dictionary on `dict`. */
function streamDictOf(value: unknown): DictLike | undefined {
  if (!value || typeof value !== 'object' || !('dict' in value)) return undefined;
  return isDictLike(value.dict) ? value.dict : undefined;
}

/** Resolve a value that may be a reference and keep it only if it is a dict. */
function dictLike(
  context: PDFDocument['context'],
  value: PDFObject | undefined,
): DictLike | undefined {
  const resolved = resolveValue(context, value);
  return isDictLike(resolved) ? resolved : undefined;
}

function dictAt(
  context: PDFDocument['context'],
  owner: PDFDict | DictLike | undefined,
  key: string,
): DictLike | undefined {
  return dictLike(context, owner?.get(PDFName.of(key)));
}

function resolveValue(
  context: PDFDocument['context'],
  value: PDFObject | undefined,
): PDFObject | undefined {
  return context.lookup(value);
}

function nameOf(dict: DictLike | undefined, key: string): string | undefined {
  const raw = dict?.get(PDFName.of(key));
  if (!isNameLike(raw)) return undefined;
  // `PDFName.asString()` is the *encoded* form, leading slash included.
  return raw.asString().replace(/^\//, '');
}

function textOf(dict: DictLike | undefined, key: string): string | undefined {
  const raw = dict?.get(PDFName.of(key));
  if (isStringLike(raw)) return raw.decodeText();
  // Some producers write `/URI /https://…` (a name) instead of a string.
  return nameOf(dict, key);
}

// ---------------------------------------------------------------------------
// Markdown / text / LlamaIndex / HTML writers
// ---------------------------------------------------------------------------

export interface MarkdownOptions {
  /**
   * Font heights that mean heading level 1, 2, 3 … in order. When omitted the
   * heights are clustered out of the document itself (see
   * {@link detectHeadingHeights}).
   */
  headingHeights?: number[];
  /** Render `type: 'table'` blocks as GitHub-flavoured tables. Default true. */
  tables?: boolean;
  /** Emit a `---` thematic break between pages. Default true. */
  pageBreaks?: boolean;
}

export function jsonToMarkdown(
  json: { pages: PdfJsonPage[] },
  opts: MarkdownOptions = {},
): string {
  const explicit = opts.headingHeights && opts.headingHeights.length > 0;
  const headingHeights = explicit ? [...opts.headingHeights!] : detectHeadingHeights(json);
  const body = bodyFontHeight(json);
  const chunks: string[] = [];

  json.pages.forEach((page, index) => {
    if (index > 0 && opts.pageBreaks !== false) chunks.push('---\n');
    for (const block of [...page.blocks].sort((a, b) => a.rect.y - b.rect.y)) {
      if (block.type === 'table' && block.rows?.length) {
        chunks.push(opts.tables === false ? `${block.text ?? ''}\n` : `${markdownTable(block.rows)}\n`);
        continue;
      }
      if (block.type === 'image') {
        chunks.push(
          `<!-- image ${fmt(block.rect.width, 0)}x${fmt(block.rect.height, 0)} at ` +
            `${fmt(block.rect.x, 0)},${fmt(block.rect.y, 0)} -->\n`,
        );
        continue;
      }
      const text = (block.text ?? '').trim();
      if (!text) continue;
      const level = explicit
        ? headingLevelFor(maxFontHeight(block), headingHeights)
        : headingLevelFor(maxFontHeight(block), headingHeights, body);
      const single = text.replace(/\s*\n\s*/g, ' ');
      chunks.push(level > 0 ? `${'#'.repeat(level)} ${single}\n` : `${single}\n`);
    }
  });

  return chunks.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd().concat('\n');
}

/**
 * Font heights worth treating as headings: every cluster more than 12 % above
 * the modal (body) height, largest first, capped at six levels.
 */
export function detectHeadingHeights(json: { pages: PdfJsonPage[] }): number[] {
  const heights = blockFontHeights(json);
  if (heights.length === 0) return [];
  const body = bodyFontHeight(json);
  const clusters = new Map<number, number>();
  for (const height of heights) {
    const key = round(height, 1);
    let matched = false;
    for (const existing of clusters.keys()) {
      if (Math.abs(existing - key) <= 0.6) {
        clusters.set(existing, (clusters.get(existing) ?? 0) + 1);
        matched = true;
        break;
      }
    }
    if (!matched) clusters.set(key, 1);
  }
  return [...clusters.entries()]
    .filter(([height]) => height > body * 1.12)
    .sort((a, b) => b[0] - a[0])
    .slice(0, 6)
    .map(([height]) => height);
}

/** The most common block font height — the body text size. */
export function bodyFontHeight(json: { pages: PdfJsonPage[] }): number {
  const counts = new Map<number, number>();
  for (const height of blockFontHeights(json)) {
    const key = round(height, 0);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = 0;
  let bestCount = -1;
  for (const [height, count] of counts) {
    if (count > bestCount || (count === bestCount && height < best)) {
      best = height;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Heading level for a font height: 0 means body text, otherwise the 1-based
 * index in `headingHeights` (tolerance 0.6 pt, or 4 % when larger).
 */
export function headingLevelFor(height: number, headingHeights: readonly number[], body = 0): number {
  if (!Number.isFinite(height) || height <= 0) return 0;
  for (let i = 0; i < headingHeights.length; i++) {
    const target = headingHeights[i];
    const tolerance = Math.max(0.6, Math.abs(target) * 0.04, Math.abs(body) * 0.04);
    if (Math.abs(height - target) <= tolerance) return i + 1;
  }
  return 0;
}

/** GitHub-flavoured table; `rows` is padded to a rectangle and pipes escaped. */
export function markdownTable(rows: readonly string[][]): string {
  const width = Math.max(1, ...rows.map((row) => row.length));
  const grid = rows.map((row) => [
    ...row.slice(0, width),
    ...Array.from({ length: width - row.length }, () => ''),
  ]);
  const header = grid[0] ?? [];
  const body = grid.slice(1);
  const line = (cells: readonly string[]) =>
    `| ${cells.map((cell) => escapeMarkdownCell(cell)).join(' | ')} |`;
  const divider = `| ${header.map(() => '---').join(' | ')} |`;
  return [line(header), divider, ...body.map(line)].join('\n');
}

/** Escape the characters that would otherwise restructure a Markdown cell. */
export function escapeMarkdownCell(cell: string): string {
  return (cell ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, '<br>');
}

export interface TextOptions {
  /** Separate pages with a form feed. Default true. */
  formFeed?: boolean;
  /** Prefix every page with `--- page N ---`. Default false. */
  pageMarkers?: boolean;
}

export function jsonToText(
  json: { pages: PdfJsonPage[] },
  opts: TextOptions = {},
): string {
  const separator = opts.formFeed === false ? '\n\n' : '\f\n';
  return json.pages
    .map((page) => {
      const body =
        page.text ||
        page.blocks
          .map((block) => block.text ?? '')
          .filter((text) => text.trim() !== '')
          .join('\n\n');
      const marker = opts.pageMarkers ? `--- page ${page.page} ---\n` : '';
      return `${marker}${body}`;
    })
    .join(separator)
    .trimEnd()
    .concat('\n');
}

/**
 * LlamaIndex `ref_doc_info` document JSON: one record whose text is the whole
 * document split by form feeds, which is what the Python readers expect.
 */
export function jsonToLlamaIndex(
  json: { pages: PdfJsonPage[]; meta?: Record<string, unknown> },
  opts: { title?: string; extraMetadata?: Record<string, unknown> } = {},
): { ref_doc_info: Record<string, { metadata: unknown; text: string }> } {
  const meta = json.meta ?? {};
  const title = opts.title ?? (typeof meta.title === 'string' && meta.title ? meta.title : 'document');
  const metadata: Record<string, unknown> = {
    title,
    num_pages: json.pages.length,
    ...pickDefined(meta, ['author', 'subject', 'keywords', 'creator', 'producer']),
    ...opts.extraMetadata,
  };
  return {
    ref_doc_info: {
      [title]: { metadata, text: jsonToText(json, { formFeed: true }) },
    },
  };
}

/**
 * Standalone HTML fragment: real headings, paragraphs and tables, with the
 * source rects preserved as `data-rect` for overlays. Author text is escaped,
 * never injected.
 */
export function jsonToHtml(json: { pages: PdfJsonPage[]; meta?: Record<string, unknown> }): string {
  const title = escapeHtml(
    typeof json.meta?.title === 'string' && json.meta.title ? json.meta.title : 'PDF export',
  );
  const pages = json.pages.map((page) => {
    const blocks = [...page.blocks]
      .sort((a, b) => a.rect.y - b.rect.y)
      .map((block) => blockToHtml(block));
    const links = page.links.length
      ? `<nav class="pdf-links">${page.links
          .map((uri) => `<a href="${escapeHtml(uri)}">${escapeHtml(uri)}</a>`)
          .join(' ')}</nav>`
      : '';
    return [
      `<section class="pdf-page" data-page="${page.page}" data-width="${fmt(page.width, 2)}" data-height="${fmt(page.height, 2)}" data-rotation="${page.rotation}">`,
      ...blocks,
      links,
      '</section>',
    ].join('\n');
  });
  return [
    `<article class="pdf-json" title="${title}">`,
    ...pages,
    '</article>',
  ].join('\n');
}

function blockToHtml(block: PdfJsonBlock): string {
  const rect = `data-rect="${fmt(block.rect.x, 2)},${fmt(block.rect.y, 2)},${fmt(block.rect.width, 2)},${fmt(block.rect.height, 2)}"`;
  if (block.type === 'table' && block.rows?.length) {
    const [head, ...body] = block.rows;
    const thead = `<thead><tr>${head.map((cell) => `<th>${escapeHtml(cell)}</th>`).join('')}</tr></thead>`;
    const tbody = body.length
      ? `<tbody>${body
          .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
          .join('')}</tbody>`
      : '';
    return `<table class="pdf-table" ${rect}>${thead}${tbody}</table>`;
  }
  if (block.type === 'image') {
    return `<figure class="pdf-image" ${rect}><figcaption>image ${fmt(block.rect.width, 0)}×${fmt(block.rect.height, 0)}</figcaption></figure>`;
  }
  const text = escapeHtml(block.text ?? '').replace(/\n/g, '<br>');
  if (!text) return '';
  return `<p class="pdf-paragraph" ${rect}>${text}</p>`;
}

/** HTML-escape the five XML-significant characters. */
export function escapeHtml(value: string): string {
  return (value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function blockFontHeights(json: { pages: PdfJsonPage[] }): number[] {
  const out: number[] = [];
  for (const page of json.pages) {
    for (const block of page.blocks) {
      // A table or image rect height says nothing about the type size.
      if (block.type !== 'text') continue;
      const height = maxFontHeight(block);
      if (height > 0) out.push(height);
    }
  }
  return out;
}

/** Tallest line in a text block, or the height derived from its single line. */
export function maxFontHeight(block: PdfJsonBlock): number {
  if (block.type !== 'text') return 0;
  if (block.lines?.length) return Math.max(...block.lines.map((line) => line.fontHeight));
  if (block.rect.height > 0) return block.rect.height;
  return 0;
}

function pickDefined(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (record[key] !== undefined) out[key] = record[key];
  return out;
}

// ---------------------------------------------------------------------------
// SVG export
// ---------------------------------------------------------------------------

/**
 * The pdf.js operator names this interpreter handles. Verified against
 * `node_modules/pdfjs-dist/types/src/shared/util.d.ts` for the installed
 * version — note that `paintType3Char`, `paintChar`, `paintType6Char` and
 * `addImagePath` no longer exist as operator codes: Type3 glyphs and image
 * paths are folded into `showText` / `paintImageXObject` by the worker.
 */
export const REQUIRED_OP_NAMES = [
  'dependency',
  'setLineWidth',
  'setLineCap',
  'setLineJoin',
  'setMiterLimit',
  'setDash',
  'setGState',
  'save',
  'restore',
  'transform',
  'moveTo',
  'lineTo',
  'curveTo',
  'curveTo2',
  'curveTo3',
  'closePath',
  'rectangle',
  'stroke',
  'closeStroke',
  'fill',
  'eoFill',
  'fillStroke',
  'eoFillStroke',
  'closeFillStroke',
  'closeEOFillStroke',
  'endPath',
  'clip',
  'eoClip',
  'beginText',
  'endText',
  'setCharSpacing',
  'setWordSpacing',
  'setHScale',
  'setLeading',
  'setFont',
  'setTextRenderingMode',
  'setTextRise',
  'moveText',
  'setLeadingMoveText',
  'setTextMatrix',
  'nextLine',
  'showText',
  'showSpacedText',
  'setStrokeColorSpace',
  'setFillColorSpace',
  'setStrokeColorN',
  'setFillColorN',
  'setStrokeRGBColor',
  'setFillRGBColor',
  'setStrokeCMYKColor',
  'setFillCMYKColor',
  'setFillTransparent',
  'setStrokeTransparent',
  'shadingFill',
  'paintImageXObject',
  'paintImageXObjectRepeat',
  'paintInlineImageXObject',
  'paintImageMaskXObject',
  'paintSolidColorImageMask',
  'paintXObject',
  'paintFormXObjectBegin',
  'paintFormXObjectEnd',
  'constructPath',
] as const;

export type SvgOpName = (typeof REQUIRED_OP_NAMES)[number];
export type SvgOpCodes = Record<SvgOpName, number>;

/**
 * Type a pdf.js `OPS` table into the subset this module needs, refusing an
 * unknown build with a message that names the missing operators.
 */
export function opCodesFrom(table: Partial<Record<string, number>> | undefined): SvgOpCodes {
  const source = table ?? {};
  const missing = REQUIRED_OP_NAMES.filter((name) => typeof source[name] !== 'number');
  if (missing.length > 0) {
    throw new Error(
      `This pdf.js build does not expose the operators ${missing.join(', ')}; ` +
        'PDF to SVG needs pdfjs-dist 4.x. Reload the page after updating the app.',
    );
  }
  const codes = {} as SvgOpCodes;
  for (const name of REQUIRED_OP_NAMES) codes[name] = source[name] as number;
  return codes;
}

/** `[a b c d e f]` with `u = a·x + c·y + e`, `v = b·x + d·y + f` (pdf.js order). */
export type SvgMatrix = [number, number, number, number, number, number];

export const SVG_IDENTITY: SvgMatrix = [1, 0, 0, 1, 0, 0];

/**
 * Concatenate two matrices the way PDF and canvas do: `second` is applied to
 * the point first, then `first`. So `multiplyMatrices(ctm, cm)` is the CTM
 * after a `cm` operator, and `applyMatrix` matches pdf.js's `applyTransform`.
 */
export function multiplyMatrices(first: readonly number[], second: readonly number[]): SvgMatrix {
  const [a1, b1, c1, d1, e1, f1] = first;
  const [a2, b2, c2, d2, e2, f2] = second;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

/** Transform one point. */
export function applyMatrix(m: readonly number[], x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export interface SvgOperatorList {
  readonly fnArray: readonly number[];
  readonly argsArray: readonly (readonly unknown[] | null)[];
}

/** The slice of a pdf.js `FontFaceObject` that affects SVG text. */
export interface SvgFontInfo {
  loadedName?: string;
  /** PostScript name, the best `font-family` guess when there is no CSS name. */
  name?: string;
  fallbackName?: string;
  cssFontInfo?: { fontFamily?: string };
  fontMatrix?: readonly number[];
  vertical?: boolean;
}

export interface SvgResources {
  font(name: string): SvgFontInfo | undefined;
  /** Resolved image → `href` value (usually a data URL). */
  image?(objId: string): string | undefined;
  /** Glyph outline (SVG path data) for `char` of `loadedName`, if available. */
  glyphPath?(loadedName: string, char: string): string | undefined;
}

export interface SvgStats {
  paths: number;
  textRuns: number;
  images: number;
  /** Glyph runs that were converted to outlines because `fontToPath` was set. */
  glyphPaths: number;
  /** Runs left as live `<text>` even though `fontToPath` was requested. */
  liveTextRuns: number;
  clips: number;
  skippedOps: number;
}

export interface SvgBuildResult {
  body: string;
  stats: SvgStats;
}

export interface SvgBuildOptions {
  /** Decimals kept in path/transform numbers. Default 2. */
  floatPrecision?: number;
  /** Embed raster images as `href` data URLs. Default true. */
  embedImages?: boolean;
  /** Prefer glyph outlines where pdf.js supplied them (see the header note). */
  fontToPath?: boolean;
}

interface GraphicsState {
  ctm: SvgMatrix;
  lineWidth: number;
  lineCap: number;
  lineJoin: number;
  miterLimit: number;
  dash: number[];
  dashPhase: number;
  fill: string;
  stroke: string;
  fillAlpha: number;
  strokeAlpha: number;
}

interface TextState {
  tm: SvgMatrix;
  x: number;
  y: number;
  lineX: number;
  lineY: number;
  rise: number;
  fontSize: number;
  fontName: string;
  direction: number;
  hScale: number;
  charSpacing: number;
  wordSpacing: number;
  leading: number;
  mode: number;
}

const INITIAL_GRAPHICS: GraphicsState = {
  ctm: SVG_IDENTITY,
  lineWidth: 1,
  lineCap: 0,
  lineJoin: 0,
  miterLimit: 10,
  dash: [],
  dashPhase: 0,
  fill: '#000000',
  stroke: '#000000',
  fillAlpha: 1,
  strokeAlpha: 1,
};

const INITIAL_TEXT: TextState = {
  tm: SVG_IDENTITY,
  x: 0,
  y: 0,
  lineX: 0,
  lineY: 0,
  rise: 0,
  fontSize: 0,
  fontName: '',
  direction: 1,
  hScale: 1,
  charSpacing: 0,
  wordSpacing: 0,
  leading: 0,
  mode: 0,
};

/**
 * Turn one page's operator list into SVG body markup.
 *
 * Coordinates are accumulated in PDF user space and emitted as is; the caller
 * wraps the body in `userSpaceToSvgMatrix(frame)` to flip y and apply `/Rotate`.
 * Path coordinates are transformed by the CTM **at construction time**, as PDF
 * requires, so later `cm`/`q`/`Q` cannot move an already-built path.
 */
export function operatorListToSvg(
  list: SvgOperatorList,
  ops: SvgOpCodes,
  res: SvgResources,
  opts: SvgBuildOptions = {},
): SvgBuildResult {
  const precision = opts.floatPrecision ?? 2;
  const number = (value: unknown, fallback = 0): number => {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  const argsOf = (index: number): readonly unknown[] => list.argsArray[index] ?? [];

  const body: string[] = [];
  const stats: SvgStats = {
    paths: 0,
    textRuns: 0,
    images: 0,
    glyphPaths: 0,
    liveTextRuns: 0,
    clips: 0,
    skippedOps: 0,
  };
  const stack: GraphicsState[] = [];
  let g: GraphicsState = { ...INITIAL_GRAPHICS };
  let t: TextState = { ...INITIAL_TEXT };

  // Current path, in user space (already CTM-transformed).
  let d: string[] = [];
  let curX = 0;
  let curY = 0;
  let startX = 0;
  let startY = 0;
  let pendingClip = false;

  const fmt = (value: number) => fmtNumber(value, precision);

  const point = (x: number, y: number): [number, number] => applyMatrix(g.ctm, x, y);
  const addMove = (x: number, y: number) => {
    const [u, v] = point(x, y);
    d.push(`M${fmt(u)} ${fmt(v)}`);
    curX = u;
    curY = v;
    if (d.length === 1) {
      startX = u;
      startY = v;
    }
  };
  const addLine = (x: number, y: number) => {
    const [u, v] = point(x, y);
    d.push(d.length === 0 ? `M${fmt(u)} ${fmt(v)}` : `L${fmt(u)} ${fmt(v)}`);
    curX = u;
    curY = v;
  };
  const addCurve = (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x3: number,
    y3: number,
  ) => {
    const [u1, v1] = point(x1, y1);
    const [u2, v2] = point(x2, y2);
    const [u3, v3] = point(x3, y3);
    d.push(`C${fmt(u1)} ${fmt(v1)} ${fmt(u2)} ${fmt(v2)} ${fmt(u3)} ${fmt(v3)}`);
    curX = u3;
    curY = v3;
  };
  const addRectangle = (x: number, y: number, w: number, h: number) => {
    const [x0, y0] = point(x, y);
    const [x1, y1] = point(x + w, y);
    const [x2, y2] = point(x + w, y + h);
    const [x3, y3] = point(x, y + h);
    d.push(
      `M${fmt(x0)} ${fmt(y0)}`,
      `L${fmt(x1)} ${fmt(y1)}`,
      `L${fmt(x2)} ${fmt(y2)}`,
      `L${fmt(x3)} ${fmt(y3)}`,
      'Z',
    );
    curX = x0;
    curY = y0;
    startX = x0;
    startY = y0;
  };
  const addClose = () => {
    if (d.length === 0) return;
    d.push('Z');
    curX = startX;
    curY = startY;
  };

  const strokeScale = () =>
    (Math.hypot(g.ctm[0], g.ctm[1]) + Math.hypot(g.ctm[2], g.ctm[3])) / 2;

  const styleAttrs = (wantFill: boolean, wantStroke: boolean): string => {
    const parts: string[] = [];
    if (wantFill) {
      parts.push(`fill="${g.fill}"`);
      if (g.fillAlpha !== 1) parts.push(`fill-opacity="${fmt(g.fillAlpha)}"`);
    } else {
      parts.push('fill="none"');
    }
    if (wantStroke) {
      parts.push(`stroke="${g.stroke}"`);
      parts.push(`stroke-width="${fmt(Math.max(0.01, g.lineWidth * strokeScale()))}"`);
      if (g.strokeAlpha !== 1) parts.push(`stroke-opacity="${fmt(g.strokeAlpha)}"`);
      parts.push(`stroke-linecap="${g.lineCap}"`, `stroke-linejoin="${g.lineJoin}"`);
      parts.push(`stroke-miterlimit="${fmt(g.miterLimit)}"`);
      if (g.dash.length > 0) {
        parts.push(`stroke-dasharray="${g.dash.map((value) => fmt(value * strokeScale())).join(' ')}"`);
        parts.push(`stroke-dashoffset="${fmt(g.dashPhase * strokeScale())}"`);
      }
    }
    return parts.join(' ');
  };

  const consumePath = () => {
    if (pendingClip) {
      // The path was installed as a clip: PDF discards it there, and so do we —
      // the count is what the caller reports to the user.
      stats.clips += 1;
      pendingClip = false;
    }
    d = [];
  };

  const paint = (mode: 'fill' | 'stroke' | 'both', evenOdd = false, close = false) => {
    if (close) addClose();
    if (d.length === 0) return;
    if (pendingClip) {
      consumePath();
      return;
    }
    const wantFill = mode !== 'stroke';
    const wantStroke = mode !== 'fill';
    const attrs = [`d="${d.join(' ')}"`, styleAttrs(wantFill, wantStroke)];
    if (evenOdd && wantFill) attrs.push('fill-rule="evenodd"');
    body.push(`<path ${attrs.join(' ')}/>`);
    stats.paths += 1;
    consumePath();
  };

  const colorFromRgb = (args: readonly unknown[]): string =>
    `#${args
      .slice(0, 3)
      .map((value) => Math.round(Math.min(255, Math.max(0, number(value)))))
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('')}`;

  const colorFromCmyk = (args: readonly unknown[]): string => {
    const [c, m, y, k] = [0, 1, 2, 3].map((i) => number(args[i]));
    const channel = (value: number) => Math.round(255 * (1 - value) * (1 - k));
    return `#${[channel(c), channel(m), channel(y)]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('')}`;
  };

  const fontInfo = (): SvgFontInfo | undefined => (t.fontName ? res.font(t.fontName) : undefined);

  const textVisible = () => t.mode !== 3 && t.mode !== 5 && t.mode !== 7 && t.fontSize > 0;

  const emitRun = (runStart: number, text: string) => {
    if (text.trim() === '') return;
    const info = fontInfo();
    const family =
      info?.cssFontInfo?.fontFamily ?? info?.loadedName ?? info?.name ?? info?.fallbackName ?? 'sans-serif';
    const matrix = multiplyMatrices(
      multiplyMatrices(
        multiplyMatrices(g.ctm, t.tm),
        [1, 0, 0, 1, t.x + runStart, t.y + t.rise],
      ),
      [t.hScale * t.direction, 0, 0, -t.direction, 0, 0],
    );
    const outlineOnly = t.mode === 1;
    const strokeText = outlineOnly || t.mode === 2;
    body.push(
      `<text transform="matrix(${svgMatrix(matrix, precision)})" font-family="${escapeXmlAttribute(family)}" ` +
        `font-size="${fmt(t.fontSize)}" x="0" y="0" ${styleAttrs(!outlineOnly, strokeText)}>`,
      `${escapeXmlText(text)}</text>`,
    );
    stats.textRuns += 1;
    stats.liveTextRuns += 1;
  };

  const emitGlyphOutlines = (
    runStart: number,
    glyphs: readonly { char: string; advance: number }[],
  ): boolean => {
    if (!res.glyphPath || glyphs.length === 0) return false;
    const info = fontInfo();
    if (!info?.loadedName) return false;
    const paths: string[] = [];
    let cursor = runStart;
    for (const item of glyphs) {
      const path = res.glyphPath(info.loadedName, item.char);
      if (path === undefined) return false;
      paths.push(
        `<path d="${path}" transform="matrix(${svgMatrix(
          multiplyMatrices(
            multiplyMatrices(multiplyMatrices(g.ctm, t.tm), [
              1, 0, 0, 1, t.x + cursor, t.y + t.rise,
            ]),
            [t.fontSize, 0, 0, t.fontSize, 0, 0],
          ),
          precision,
        )})" ${styleAttrs(true, false)}/>`,
      );
      cursor += item.advance;
    }
    body.push(...paths);
    stats.glyphPaths += paths.length;
    return true;
  };

  const showText = (args: readonly unknown[]) => {
    const items = (args[0] ?? []) as readonly (Record<string, unknown> | number)[];
    const info = fontInfo();
    const widthScale = info?.fontMatrix?.[0] ?? 0.001;
    const vertical = Boolean(info?.vertical);
    const spacingDir = vertical ? 1 : -1;
    let local = 0;
    let runStart = 0;
    let run: { char: string; advance: number }[] = [];

    const flush = () => {
      if (run.length === 0) return;
      const glyphs = run;
      run = [];
      const text = glyphs.map((entry) => entry.char).join('');
      if (text.trim() === '' || !textVisible()) return;
      if (opts.fontToPath && emitGlyphOutlines(runStart, glyphs)) return;
      emitRun(runStart, text);
    };

    for (const glyph of items) {
      if (typeof glyph === 'number') {
        // A bare number in a `TJ` array is a kerning adjustment in 1/1000 em.
        flush();
        local += spacingDir * glyph * t.fontSize * 0.001;
        runStart = local;
        continue;
      }
      const char = typeof glyph.fontChar === 'string' ? glyph.fontChar : '';
      const width = number(glyph.width);
      const isSpace = Boolean(glyph.isSpace);
      const spacing = (isSpace ? t.wordSpacing : 0) + t.charSpacing;
      const advance = width * widthScale * t.fontSize + spacing * t.direction;
      if (char) {
        if (run.length === 0) runStart = local;
        run.push({ char, advance });
      } else {
        flush();
      }
      local += advance;
    }
    flush();

    if (vertical) t = { ...t, y: t.y - local };
    else t = { ...t, x: t.x + local * t.hScale };
  };

  const paintImage = (href: string | undefined) => {
    if (!href) {
      stats.skippedOps += 1;
      return;
    }
    // PDF paints an image into the unit square; SVG draws `<image>` downwards
    // from its origin, so the local space needs one y flip before the CTM.
    const matrix = multiplyMatrices(
      multiplyMatrices(g.ctm, [1, 0, 0, 1, 0, 1]),
      [1, 0, 0, -1, 0, 0],
    );
    body.push(
      `<image href="${escapeXmlAttribute(href)}" width="1" height="1" preserveAspectRatio="none" ` +
        `transform="matrix(${svgMatrix(matrix, precision)})"${g.fillAlpha !== 1 ? ` opacity="${fmt(g.fillAlpha)}"` : ''}/>`,
    );
    stats.images += 1;
  };

  const applyGState = (states: readonly unknown[]) => {
    for (const entry of states) {
      if (!Array.isArray(entry)) continue;
      const [key, value] = entry as [string, unknown];
      switch (key) {
        case 'LW':
          g.lineWidth = number(value, 1);
          break;
        case 'LC':
          g.lineCap = number(value);
          break;
        case 'LJ':
          g.lineJoin = number(value);
          break;
        case 'ML':
          g.miterLimit = number(value, 10);
          break;
        case 'D': {
          const dash = value as { array?: unknown[]; phase?: number } | undefined;
          g.dash = (dash?.array ?? []).map((item) => number(item));
          g.dashPhase = number(dash?.phase);
          break;
        }
        case 'ca':
          g.fillAlpha = clamp01(number(value, 1));
          break;
        case 'CA':
          g.strokeAlpha = clamp01(number(value, 1));
          break;
        case 'Font': {
          const pair = value as [string, number];
          if (Array.isArray(pair)) {
            t.fontName = String(pair[0] ?? '');
            const size = number(pair[1]);
            t.fontSize = Math.abs(size);
            t.direction = size < 0 ? -1 : 1;
          }
          break;
        }
        default:
          break;
      }
    }
  };

  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i];
    const args = argsOf(i);
    switch (fn) {
      case ops.save:
        stack.push({ ...g, ctm: g.ctm });
        break;
      case ops.restore: {
        const popped = stack.pop();
        if (popped) g = popped;
        break;
      }
      case ops.transform:
        g = { ...g, ctm: multiplyMatrices(g.ctm, [0, 1, 2, 3, 4, 5].map((k) => number(args[k])) as SvgMatrix) };
        break;
      case ops.constructPath: {
        const subOps = (args[0] ?? []) as readonly number[];
        const values = (args[1] ?? []) as readonly number[];
        let cursor = 0;
        for (const sub of subOps) {
          switch (sub) {
            case ops.rectangle:
              addRectangle(number(values[cursor]), number(values[cursor + 1]), number(values[cursor + 2]), number(values[cursor + 3]));
              cursor += 4;
              break;
            case ops.moveTo:
              addMove(number(values[cursor]), number(values[cursor + 1]));
              cursor += 2;
              break;
            case ops.lineTo:
              addLine(number(values[cursor]), number(values[cursor + 1]));
              cursor += 2;
              break;
            case ops.curveTo:
              addCurve(
                number(values[cursor]), number(values[cursor + 1]),
                number(values[cursor + 2]), number(values[cursor + 3]),
                number(values[cursor + 4]), number(values[cursor + 5]),
              );
              cursor += 6;
              break;
            case ops.curveTo2:
              addCurve(curX, curY, number(values[cursor]), number(values[cursor + 1]), number(values[cursor + 2]), number(values[cursor + 3]));
              cursor += 4;
              break;
            case ops.curveTo3:
              addCurve(number(values[cursor]), number(values[cursor + 1]), number(values[cursor + 2]), number(values[cursor + 3]), number(values[cursor + 2]), number(values[cursor + 3]));
              cursor += 4;
              break;
            case ops.closePath:
              addClose();
              break;
            default:
              break;
          }
        }
        break;
      }
      case ops.moveTo:
        addMove(number(args[0]), number(args[1]));
        break;
      case ops.lineTo:
        addLine(number(args[0]), number(args[1]));
        break;
      case ops.curveTo:
        addCurve(number(args[0]), number(args[1]), number(args[2]), number(args[3]), number(args[4]), number(args[5]));
        break;
      case ops.curveTo2:
        addCurve(curX, curY, number(args[0]), number(args[1]), number(args[2]), number(args[3]));
        break;
      case ops.curveTo3:
        addCurve(number(args[0]), number(args[1]), number(args[2]), number(args[3]), number(args[2]), number(args[3]));
        break;
      case ops.rectangle:
        addRectangle(number(args[0]), number(args[1]), number(args[2]), number(args[3]));
        break;
      case ops.closePath:
        addClose();
        break;
      case ops.fill:
        paint('fill');
        break;
      case ops.eoFill:
        paint('fill', true);
        break;
      case ops.stroke:
        paint('stroke');
        break;
      case ops.closeStroke:
        paint('stroke', false, true);
        break;
      case ops.fillStroke:
        paint('both');
        break;
      case ops.eoFillStroke:
        paint('both', true);
        break;
      case ops.closeFillStroke:
        paint('both', false, true);
        break;
      case ops.closeEOFillStroke:
        paint('both', true, true);
        break;
      case ops.clip:
      case ops.eoClip:
        pendingClip = true;
        break;
      case ops.endPath:
        consumePath();
        break;
      case ops.setLineWidth:
        g = { ...g, lineWidth: number(args[0], 1) };
        break;
      case ops.setLineCap:
        g = { ...g, lineCap: number(args[0]) };
        break;
      case ops.setLineJoin:
        g = { ...g, lineJoin: number(args[0]) };
        break;
      case ops.setMiterLimit:
        g = { ...g, miterLimit: number(args[0], 10) };
        break;
      case ops.setDash:
        g = { ...g, dash: ((args[0] ?? []) as readonly unknown[]).map((value) => number(value)), dashPhase: number(args[1]) };
        break;
      case ops.setGState:
        applyGState((args[0] ?? []) as readonly unknown[]);
        break;
      case ops.setFillRGBColor:
        g = { ...g, fill: colorFromRgb(args) };
        break;
      case ops.setStrokeRGBColor:
        g = { ...g, stroke: colorFromRgb(args) };
        break;
      case ops.setFillCMYKColor:
        g = { ...g, fill: colorFromCmyk(args) };
        break;
      case ops.setStrokeCMYKColor:
        g = { ...g, stroke: colorFromCmyk(args) };
        break;
      case ops.setFillTransparent:
        g = { ...g, fill: 'none' };
        break;
      case ops.setStrokeTransparent:
        g = { ...g, stroke: 'none' };
        break;
      case ops.beginText:
        t = { ...t, x: 0, y: 0, lineX: 0, lineY: 0, rise: 0, tm: SVG_IDENTITY };
        break;
      case ops.endText:
        break;
      case ops.setFont:
        t = {
          ...t,
          fontName: String(args[0] ?? ''),
          fontSize: Math.abs(number(args[1])),
          direction: number(args[1]) < 0 ? -1 : 1,
        };
        break;
      case ops.setTextMatrix:
        t = {
          ...t,
          tm: [0, 1, 2, 3, 4, 5].map((k) => number(args[k])) as SvgMatrix,
          x: 0,
          y: 0,
          lineX: 0,
          lineY: 0,
        };
        break;
      case ops.setLeadingMoveText: {
        const lineX = t.lineX + number(args[0]);
        const lineY = t.lineY + number(args[1]);
        t = { ...t, leading: -number(args[1]), lineX, lineY, x: lineX, y: lineY };
        break;
      }
      case ops.nextLine: {
        const lineY = t.lineY + t.leading;
        t = { ...t, lineY, y: lineY };
        break;
      }
      case ops.moveText: {
        const lineX = t.lineX + number(args[0]);
        const lineY = t.lineY + number(args[1]);
        t = { ...t, lineX, lineY, x: lineX, y: lineY };
        break;
      }
      case ops.setLeading:
        t = { ...t, leading: -number(args[0]) };
        break;
      case ops.setTextRise:
        t = { ...t, rise: number(args[0]) };
        break;
      case ops.setCharSpacing:
        t = { ...t, charSpacing: number(args[0]) };
        break;
      case ops.setWordSpacing:
        t = { ...t, wordSpacing: number(args[0]) };
        break;
      case ops.setHScale:
        t = { ...t, hScale: number(args[0], 100) / 100 };
        break;
      case ops.setTextRenderingMode:
        t = { ...t, mode: number(args[0]) };
        break;
      case ops.showText:
      case ops.showSpacedText:
        showText(args);
        break;
      case ops.paintImageXObject:
      case ops.paintInlineImageXObject:
      case ops.paintImageMaskXObject:
      case ops.paintImageXObjectRepeat:
        if (opts.embedImages === false) {
          stats.skippedOps += 1;
        } else {
          paintImage(res.image?.(String(args[0] ?? '')));
        }
        break;
      case ops.paintSolidColorImageMask:
        body.push(
          `<rect x="0" y="0" width="1" height="1" transform="matrix(${svgMatrix(g.ctm, precision)})" ${styleAttrs(true, false)}/>`,
        );
        break;
      case ops.paintFormXObjectBegin: {
        stack.push({ ...g });
        const matrix = args[0] as readonly number[] | null;
        if (Array.isArray(matrix) && matrix.length === 6) {
          g = { ...g, ctm: multiplyMatrices(g.ctm, matrix) };
        }
        break;
      }
      case ops.paintFormXObjectEnd: {
        const popped = stack.pop();
        if (popped) g = popped;
        break;
      }
      case ops.dependency:
      case ops.setFillColorSpace:
      case ops.setStrokeColorSpace:
      case ops.paintXObject:
        // `dependency` only names the resources the worker transferred, colour
        // spaces are resolved into the concrete `…Color` ops before they reach
        // us, and form XObjects arrive inlined between
        // `paintFormXObjectBegin`/`End`.
        break;
      case ops.setFillColorN:
      case ops.setStrokeColorN:
      case ops.shadingFill:
        // Pattern / shading fills have no cheap SVG equivalent here.
        stats.skippedOps += 1;
        break;
      default:
        stats.skippedOps += 1;
        break;
    }
  }

  return { body: body.join(''), stats };
}

/**
 * Rebuild one page as standalone SVG from pdf.js's operator list.
 *
 * `doc` supplies the page box when pdf.js has not resolved `view` yet; the
 * visual content comes from `session`.
 */
export async function documentToSvg(
  doc: PDFDocument,
  session: PdfSession,
  page: number,
  opts: SvgBuildOptions = {},
): Promise<string> {
  if (!Number.isInteger(page) || page < 1 || page > session.numPages) {
    throw new Error(
      `Page ${page} is outside this document, which has ${session.numPages} page(s).`,
    );
  }
  const ops = opCodesFrom(await loadOpsTable());
  const proxy = await session.page(page);
  const frame = pageFrameOfView(proxy.view, proxy.rotate) ?? libFrame(doc, page);
  const list = await proxy.getOperatorList();

  const images = new Map<string, string>();
  if (opts.embedImages !== false) {
    await collectImages(proxy, list, ops, images);
  }

  const resources: SvgResources = {
    font: (name: string) => readFontInfo(proxy, name),
    image: (id: string) => images.get(id),
    glyphPath: (loadedName: string, char: string) => readGlyphPath(proxy, loadedName, char),
  };
  const { body, stats } = operatorListToSvg(list, ops, resources, opts);

  const size = viewerSizeOf(frame);
  const precision = opts.floatPrecision ?? 2;
  const notes: string[] = [];
  if (stats.clips > 0) notes.push(`${stats.clips} clip path(s) consumed, not emitted`);
  if (stats.skippedOps > 0) notes.push(`${stats.skippedOps} operator(s) skipped`);
  if (opts.fontToPath && stats.liveTextRuns > 0) {
    notes.push(`${stats.liveTextRuns} text run(s) left live (no glyph outline data available)`);
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
      `width="${fmt(size.width, precision)}" height="${fmt(size.height, precision)}" ` +
      `viewBox="0 0 ${fmt(size.width, precision)} ${fmt(size.height, precision)}">`,
    `<title>Page ${page}</title>`,
    notes.length > 0 ? `<!-- ${notes.join('; ')} -->` : '',
    `<g transform="matrix(${svgMatrix(userSpaceToSvgMatrix(frame), precision)})">${body}</g>`,
    '</svg>',
  ]
    .filter((part) => part !== '')
    .join('\n');
}

// ---------------------------------------------------------------------------
// SVG glue: the only part that touches pdf.js objects
// ---------------------------------------------------------------------------

/**
 * Whatever pdf.js stores under an `objs` / `commonObjs` id: a font descriptor,
 * a raster payload, or the SVG path text of a single glyph.
 */
export type PdfObjectValue = string | SvgFontInfo | PdfImagePayload | undefined;

/** A raster handed over by the pdf.js worker. */
export interface PdfImagePayload {
  data?: Uint8Array | Uint8ClampedArray | Blob | HTMLCanvasElement | ImageBitmap;
  width?: number;
  height?: number;
}

/** The transfer-store shape used by `PDFPageProxy`. */
interface PdfObjectStore {
  has(id: string): boolean;
  get(id: string): PdfObjectValue;
  get(id: string, callback: (value: PdfObjectValue) => void): void;
}

/** Minimal surface of `PDFPageProxy` that the SVG glue needs. */
interface ProxyWithObjects {
  view?: number[];
  rotate?: number;
  objs?: PdfObjectStore;
  commonObjs?: PdfObjectStore;
  getOperatorList(): Promise<SvgOperatorList>;
}

/** `OPS` without importing pdf.js at module load (keeps jsdom tests light). */
async function loadOpsTable(): Promise<Record<string, number>> {
  // SAFETY: `pdfjs-dist` types the module namespace, but the build under test
  // exposes `OPS` as a plain name → code map; only that one field is read.
  const mod = (await import('pdfjs-dist')) as unknown as { OPS?: Record<string, number> };
  if (!mod.OPS) {
    throw new Error(
      'pdf.js did not expose its operator table, so this PDF cannot be converted to SVG. Reload the page and try again.',
    );
  }
  return mod.OPS;
}

function libFrame(doc: PDFDocument, page: number): PageFrame {
  const lib = doc.getPage(page - 1);
  const box = lib.getMediaBox();
  return { x0: box.x, y0: box.y, width: box.width, height: box.height, rotation: lib.getRotation().angle };
}

function readFontInfo(proxy: ProxyWithObjects, name: string): SvgFontInfo | undefined {
  const store = proxy.commonObjs;
  if (!store || !name) return undefined;
  try {
    if (!store.has(name)) return undefined;
    const value = store.get(name);
    return typeof value === 'string' || value === undefined ? undefined : (value as SvgFontInfo);
  } catch {
    return undefined;
  }
}

/** pdf.js transfers glyph outlines as `"<loadedName>_path_<char>"` objects. */
function readGlyphPath(proxy: ProxyWithObjects, loadedName: string, char: string): string | undefined {
  const store = proxy.commonObjs;
  const id = `${loadedName}_path_${char}`;
  if (!store || !store.has(id)) return undefined;
  try {
    const value = store.get(id);
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

async function collectImages(
  proxy: ProxyWithObjects,
  list: SvgOperatorList,
  ops: SvgOpCodes,
  into: Map<string, string>,
): Promise<void> {
  const ids = new Set<string>();
  const imageOps = new Set([
    ops.paintImageXObject,
    ops.paintImageXObjectRepeat,
    ops.paintInlineImageXObject,
    ops.paintImageMaskXObject,
  ]);
  list.fnArray.forEach((fn, index) => {
    if (!imageOps.has(fn)) return;
    const arg = list.argsArray[index]?.[0];
    if (typeof arg === 'string') ids.add(arg);
  });
  for (const id of ids) {
    const data = await resolveObject(proxy.objs, id);
    if (data === undefined) continue;
    const url = await imageDataUrl(data);
    if (url) into.set(id, url);
  }
}

/** `objs.get(id, cb)` fires as soon as the worker has delivered the object. */
function resolveObject(store: PdfObjectStore | undefined, id: string): Promise<PdfObjectValue> {
  if (!store) return Promise.resolve(undefined);
  if (store.has(id)) {
    try {
      return Promise.resolve(store.get(id));
    } catch {
      return Promise.resolve(undefined);
    }
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: PdfObjectValue) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      store.get(id, (value: PdfObjectValue) => finish(value));
    } catch {
      finish(undefined);
    }
    // A page that never finishes streaming must not hang the export.
    setTimeout(() => finish(undefined), 2000);
  });
}

/**
 * pdf.js hands over raw RGBA, a `Blob` (JPEG/PNG passes), a canvas or an
 * `ImageBitmap`; all four become data URLs. Returns `undefined` when this
 * environment cannot encode (jsdom has no canvas), which the caller reports as
 * a skipped operator instead of guessing.
 */
async function imageDataUrl(payload: PdfObjectValue): Promise<string | undefined> {
  if (!payload || typeof payload === 'string') return undefined;
  if (!('data' in payload) || !('width' in payload)) return undefined;
  const record = payload as PdfImagePayload;
  const width = Math.max(0, Math.floor(Number(record.width ?? 0)));
  const height = Math.max(0, Math.floor(Number(record.height ?? 0)));
  const raw = record.data;
  if (typeof Blob !== 'undefined' && raw instanceof Blob) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : undefined);
      reader.onerror = () => resolve(undefined);
      reader.readAsDataURL(raw);
    });
  }
  if (typeof document === 'undefined' || width === 0 || height === 0) return undefined;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    if (raw instanceof Uint8ClampedArray || raw instanceof Uint8Array) {
      const bytes = toRgba(raw, width, height);
      if (!bytes) return undefined;
      ctx.putImageData(new ImageData(bytes, width, height), 0, 0);
      return canvas.toDataURL('image/png');
    }
    if (typeof HTMLCanvasElement !== 'undefined' && raw instanceof HTMLCanvasElement) {
      ctx.drawImage(raw, 0, 0, width, height);
      return canvas.toDataURL('image/png');
    }
    if (typeof ImageBitmap !== 'undefined' && raw instanceof ImageBitmap) {
      ctx.drawImage(raw, 0, 0, width, height);
      return canvas.toDataURL('image/png');
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function toRgba(bytes: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8ClampedArray | undefined {
  const pixels = width * height;
  if (pixels === 0 || bytes.length < pixels * 3) return undefined;
  if (bytes.length >= pixels * 4 && bytes instanceof Uint8ClampedArray) return bytes;
  const out = new Uint8ClampedArray(pixels * 4);
  if (bytes.length >= pixels * 4) {
    out.set(bytes.subarray(0, pixels * 4));
    return out;
  }
  for (let i = 0, j = 0; i < pixels; i++) {
    out[i * 4] = bytes[j++];
    out[i * 4 + 1] = bytes[j++];
    out[i * 4 + 2] = bytes[j++];
    out[i * 4 + 3] = 255;
  }
  return out;
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, '&quot;');
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function sequential(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

function fmt(value: number, digits: number): string {
  return fmtNumber(value, digits);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
