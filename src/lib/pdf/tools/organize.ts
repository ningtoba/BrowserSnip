/**
 * Organize PDF — page-order, page-geometry and imposition tools.
 *
 * Everything here is pure `pdf-lib`: page copying, form-XObject imposition and
 * page-box edits. No optional engine is required, so these tools work with the
 * network unplugged — what they cannot do is carry page furniture (links, form
 * fields, bookmarks) across a rebuild, and every tool that has to rebuild says
 * so through `result.warnings` rather than only in the log pane.
 *
 * The rules this module follows for each tool (`docs/REFINEMENT-BRIEF.md`):
 *
 * - inputs come from `openInputs`, i.e. the guard's gate — an empty file, a
 *   renamed JPEG, a locked document and a pageless PDF never reach a tool body
 *   (E1–E6);
 * - a "which pages" answer is resolved by `selection()`: `pageRangeProblem`
 *   first, so page 9 of a 3-page file names the real page count instead of
 *   being skipped (E6, E15);
 * - every numeric field declares its bounds once, on the field itself, and
 *   `numberOf()` re-applies them at the point of use and reports the
 *   correction (E15) — so the rail can block before the click;
 * - a 0-page plan or an empty selection is refused with what to do next, never
 *   saved as a one-blank-page PDF (E13, E18 — pdf-lib quietly *adds* a page to
 *   an empty document on save, which is exactly the plausible-looking lie);
 * - a page's own `/Rotate` and `CropBox` are honoured through `stamp()`,
 *   because `embedPage` captures pre-rotation MediaBox content (E8, E9);
 * - anything that had to compromise lands in `result.warnings` (E5, E14, E20).
 */
import type { PDFDocument, PDFEmbeddedPage, PDFPage } from '@maxwbh/pdf-lib';
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFRef,
  degrees,
  rgb,
} from '../core/doc';
import { collectPages, newPDF, openPDF, savePDF } from '../core/doc';
import { PAGE_SIZES, cropBox, formatPages, mediaBox, normaliseRotation, pageSize as resolvePageSize, resolvePages } from '../core/pages';
import { findBlankPages } from '../core/blank';
import { createZip } from '../core/archive';
import {
  ToolInputError,
  clampNumber,
  describeSize,
  downloadStem,
  fieldBounds,
  openInputs,
  pageRangeProblem,
  pagesField,
  pdfResult,
  rebuildDocument,
  throwIfAborted,
  withRender,
  filesResult,
  type OpenedInput,
} from './helpers';
import {
  booleanValue,
  numberValue,
  stringValue,
  type PdfToolDefinition,
  type ToolField,
  type ToolResult,
  type ToolValues,
} from './types';

/* ── run plumbing ─────────────────────────────────────────────────────────── */

/** The compromises one run had to make, in the order they were noticed. */
interface Notes {
  readonly warnings: string[];
  add(message: string): void;
}

function createNotes(): Notes {
  const warnings: string[] = [];
  return {
    warnings,
    add: (message: string) => {
      if (!warnings.includes(message)) warnings.push(message);
    },
  };
}

/** A `{ kind: 'pdf' }` result that carries its warnings to the result card. */
async function pdfOut(doc: PDFDocument, notes: Notes, message: string): Promise<ToolResult> {
  const result = await pdfResult(doc, { message });
  return notes.warnings.length > 0 ? { ...result, warnings: notes.warnings } : result;
}

/**
 * A multi-file result.
 *
 * `filesResult` throws a bare `Error` on an empty list; refusing here instead
 * keeps E13's "honest empty state" a `ToolInputError` the rail can act on.
 */
function filesOut(files: { blob: Blob; name: string }[], notes: Notes, message: string): ToolResult {
  if (files.length === 0) {
    throw new ToolInputError('NO_PAGES', 'Nothing was produced.', {
      hint: 'Widen the page selection, or pick a different split mode.',
    });
  }
  const result = filesResult(files, message);
  return notes.warnings.length > 0 ? { ...result, warnings: notes.warnings } : result;
}

/** `between 1 and 500 pages`, `at least 0.05`, … — from the field's own bounds. */
function boundsSentence(field: ToolField): string {
  const bounds = fieldBounds(field);
  if (!bounds) return '';
  const unit = bounds.unit ? ` ${bounds.unit}` : '';
  const hasMin = Number.isFinite(bounds.min);
  const hasMax = Number.isFinite(bounds.max);
  if (hasMin && hasMax) return `between ${bounds.min} and ${bounds.max}${unit}`;
  if (hasMin) return `at least ${bounds.min}${unit}`;
  if (hasMax) return `at most ${bounds.max}${unit}`;
  return '';
}

/**
 * Read a numeric field through the bounds it declares (E15).
 *
 * `runPdfTool` clamps before a tool starts, so this is the same rule applied a
 * second time for callers that reach `run()` directly — and the place where a
 * correction becomes a warning the user actually sees.
 */
function numberOf(values: ToolValues, field: ToolField, notes: Notes): number {
  const fallback = typeof field.default === 'number' ? field.default : 0;
  const raw = numberValue(values, field.key, fallback);
  const bounds = fieldBounds(field);
  if (!bounds) return raw;
  const fixed = clampNumber(raw, bounds.min, bounds.max, { integer: bounds.integer });
  if (fixed !== raw) {
    notes.add(`${field.label} must be ${boundsSentence(field)}: ${raw} became ${fixed}.`);
  }
  return fixed;
}

/**
 * Bound a page-number field against the document in hand (E6).
 *
 * The rail cannot know the page count when the field is drawn, so this is the
 * half of E15 that has to happen in the tool — and it names the real count.
 */
function clampToPage(label: string, value: number, total: number, notes: Notes): number {
  const fixed = clampNumber(value, 1, Math.max(1, total), { integer: true });
  if (fixed !== value) {
    notes.add(
      `${label} must be a page between 1 and ${total}: ${value} became ${fixed}.`,
    );
  }
  return fixed;
}

/** A number of pages, phrased the same way everywhere in this module. */
function pageCountLabel(n: number): string {
  return `${n} page${n === 1 ? '' : 's'}`;
}

/**
 * Resolve a "which pages" field into 0-based indices (E6, E13, E15, E18).
 *
 * Blank is *not* "all": a cleared field means the user did not choose, which is
 * refused before any work. `all`/`odd`/`even` and the `1,3,5-7` grammar still
 * work, and a repeated page is applied once — rotating page 2 twice by 90° is
 * never what a selection that lists it twice means.
 */
function selection(
  values: ToolValues,
  total: number,
  options: { key?: string; fallback?: string | null; verb?: string } = {},
): number[] {
  const key = options.key ?? 'pages';
  const verb = options.verb ?? 'run this on';
  const raw = values[key];
  const hint = `Pick pages between 1 and ${total}, or leave it as "all".`;

  if (Array.isArray(raw)) {
    const given = raw.filter((n): n is number => typeof n === 'number');
    if (given.length === 0) {
      throw new ToolInputError('NO_PAGES', `Nothing is selected — choose the pages to ${verb}.`, { hint });
    }
    const asText = given.join(',');
    const problem = pageRangeProblem(asText, total);
    if (problem) throw new ToolInputError('OUT_OF_RANGE', problem, { hint });
    return dedupe(resolvePages(given, total));
  }

  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') {
    if (options.fallback === undefined || options.fallback === null) {
      throw new ToolInputError(
        'NO_PAGES',
        `No pages chosen — the ${key === 'pages' ? 'page list' : key} is empty, so there is nothing to ${verb}.`,
        { hint },
      );
    }
    return dedupe(resolvePages(options.fallback, total));
  }
  const problem = pageRangeProblem(text, total);
  if (problem) throw new ToolInputError('OUT_OF_RANGE', problem, { hint });
  let pages: number[];
  try {
    pages = resolvePages(text, total);
  } catch (error) {
    throw new ToolInputError('OUT_OF_RANGE', error instanceof Error ? error.message : String(error), { hint });
  }
  const unique = dedupe(pages);
  if (unique.length === 0) {
    throw new ToolInputError('NO_PAGES', `"${text}" matched no page in this document.`, { hint });
  }
  return unique;
}

function dedupe(pages: number[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const page of pages) {
    if (seen.has(page)) continue;
    seen.add(page);
    out.push(page);
  }
  return out;
}

/* ── geometry (E8, E9) ────────────────────────────────────────────────────── */

/** A page's own `/Rotate`, as a clockwise multiple of 90. */
function rotationOf(page: PDFPage): number {
  return ((page.getRotation().angle % 360) + 360) % 360;
}

/** The visible box in the page's own, pre-rotation coordinates. */
function sourceBox(page: PDFPage): { x: number; y: number; width: number; height: number } {
  return cropBox(page);
}

/** What a viewer shows: the visible box with `/Rotate` applied. */
function visibleBox(page: PDFPage): { width: number; height: number } {
  const box = sourceBox(page);
  return rotationOf(page) % 180 === 90
    ? { width: box.height, height: box.width }
    : { width: box.width, height: box.height };
}

/** How many different displayed sizes these pages have (E8). */
function distinctSizes(doc: PDFDocument, indices: number[]): number {
  const sizes = new Set<string>();
  for (const index of indices) {
    const page = doc.getPages()[index];
    if (!page) continue;
    const box = visibleBox(page);
    sizes.add(`${Math.round(box.width)}x${Math.round(box.height)}`);
  }
  return sizes.size;
}

function noteMixedSizes(subject: string, doc: PDFDocument, indices: number[], notes: Notes): void {
  const variants = distinctSizes(doc, indices);
  if (variants > 1) {
    notes.add(
      `${subject}: this selection holds ${variants} different page sizes, so each page is scaled to fit its own cell — the printed sizes will differ.`,
    );
  }
}

interface Box { x: number; y: number; width: number; height: number }

/**
 * Draw a region of `source` into `page`, centred in `dest`.
 *
 * `pdf-lib`'s `embedPage` captures the content stream in pre-rotation page
 * space and clips to the MediaBox, so a page that *displays* as portrait comes
 * out sideways and a page with an offset box comes out shifted unless the stamp
 * undoes both. `angle` is the caller's extra turn, clockwise, which is how
 * `/Rotate`, the UI and the help text describe rotation (E8, E9).
 */
async function stamp(
  target: PDFDocument,
  page: PDFPage,
  source: PDFPage,
  dest: Box,
  options: {
    region?: Box;
    /** Extra clockwise turn on top of the page's own `/Rotate`. */
    angle?: number;
    opacity?: number;
    /**
     * `contain` (default) shrinks to fit the destination; `exact` draws at
     * 1:1 so an oversized destination crops; `stretch` fills non-uniformly and
     * changes the aspect ratio.
     */
    fit?: 'contain' | 'exact' | 'stretch';
  } = {},
): Promise<boolean> {
  const region = options.region ?? sourceBox(source);
  if (region.width <= 0 || region.height <= 0 || dest.width <= 0 || dest.height <= 0) return false;
  let embedded: PDFEmbeddedPage;
  try {
    embedded = await target.embedPage(source, {
      left: region.x,
      bottom: region.y,
      right: region.x + region.width,
      top: region.y + region.height,
    });
  } catch {
    // A page with no content stream cannot be stamped; the cell stays blank.
    return false;
  }
  const clockwise = normalise360(rotationOf(source) + (options.angle ?? 0));
  // `/Rotate` turns the sheet clockwise; the content-matrix turns counter-clockwise.
  const radians = (-clockwise * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const corners = [
    [0, 0],
    [region.width, 0],
    [0, region.height],
    [region.width, region.height],
  ].map(([x, y]) => [x * cos - y * sin, x * sin + y * cos] as const);
  const minX = Math.min(...corners.map((c) => c[0]));
  const maxX = Math.max(...corners.map((c) => c[0]));
  const minY = Math.min(...corners.map((c) => c[1]));
  const maxY = Math.max(...corners.map((c) => c[1]));
  const drawnWidth = maxX - minX;
  const drawnHeight = maxY - minY;
  if (drawnWidth <= 0 || drawnHeight <= 0) return false;
  const uniform = Math.min(dest.width / drawnWidth, dest.height / drawnHeight);
  const fit = options.fit ?? 'contain';
  const xScale = fit === 'stretch' ? dest.width / drawnWidth : fit === 'exact' ? 1 : uniform;
  const yScale = fit === 'stretch' ? dest.height / drawnHeight : fit === 'exact' ? 1 : uniform;
  page.drawPage(embedded, {
    x: dest.x + (dest.width - drawnWidth * xScale) / 2 - minX * xScale,
    y: dest.y + (dest.height - drawnHeight * yScale) / 2 - minY * yScale,
    xScale,
    yScale,
    rotate: degrees(-clockwise),
    opacity: options.opacity,
  });
  return true;
}

/** The bounding box a `width × height` sheet needs after a clockwise turn. */
function rotatedBoxSize(width: number, height: number, clockwise: number): {
  width: number;
  height: number;
} {
  const radians = (normalise360(clockwise) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  return { width: width * cos + height * sin, height: width * sin + height * cos };
}

function normalise360(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

/**
 * A tile of the page as a viewer shows it (origin top-left) converted to the
 * page's own pre-rotation coordinates, so cutting a `/Rotate 90` page in half
 * follows the line the user sees rather than the raw MediaBox (E9).
 */
function displayRegion(page: PDFPage, tile: { x: number; y: number; width: number; height: number }): Box {
  const box = sourceBox(page);
  const width = box.width;
  const height = box.height;
  const at = (x: number, y: number, w: number, h: number): Box => ({
    x: box.x + x,
    y: box.y + y,
    width: w,
    height: h,
  });
  const rotation = rotationOf(page);
  if (rotation === 90) return at(tile.y, tile.x, tile.height, tile.width);
  if (rotation === 180) return at(width - tile.x - tile.width, height - tile.y - tile.height, tile.width, tile.height);
  if (rotation === 270) return at(width - tile.y - tile.height, height - tile.x - tile.width, tile.height, tile.width);
  return at(tile.x, height - tile.y - tile.height, tile.width, tile.height);
}

/* ── document facts worth admitting ───────────────────────────────────────── */

function hasOutlines(doc: PDFDocument): boolean {
  return doc.catalog.get(PDFName.of('Outlines')) !== undefined;
}

/**
 * Count page-level annotations (links, form fields, stamps).
 *
 * `/Annots` is a `PDFArray` or a reference to one depending on the producer, so
 * it is read and narrowed rather than passed to `lookupMaybe` (E3).
 */
function annotationCount(doc: PDFDocument, indices: number[]): number {
  let total = 0;
  for (const index of indices) {
    const page = doc.getPages()[index];
    if (!page) continue;
    // SAFETY: `PDFPageLeaf.Annots()` returns the array (or throws when the
    // inherited value is not one); only `size` is used, so the narrow structural
    // view is sound.
    const node = page.node as unknown as { Annots?: () => { size(): number } | null };
    try {
      total += node.Annots?.()?.size() ?? 0;
    } catch {
      total += 0;
    }
  }
  return total;
}

/**
 * Say out loud what a form-XObject rebuild leaves behind (E13, E20).
 *
 * Imposition keeps the *ink* — text stays vector and selectable — but page
 * furniture lives on the page object, and a rebuilt page has new content with
 * none of it. That is a compromise, so it is a warning, not a log line.
 */
function noteRebuildLoss(subject: string, doc: PDFDocument, indices: number[], notes: Notes): void {
  const annots = annotationCount(doc, indices);
  if (annots > 0) {
    notes.add(
      `${subject} drew the pages into new ones, so ${annots} link${annots === 1 ? '' : 's'} or annotation${annots === 1 ? '' : 's'} could not come along.`,
    );
  }
  if (hasOutlines(doc)) {
    notes.add(
      `${subject} rebuilt the pages, so this document's bookmarks are not in the output — the optional CoherentPDF engine edits bookmarks without a rebuild.`,
    );
  }
}

/**
 * A document that is safe to save.
 *
 * `pdf-lib` writes the `/Encrypt` trailer entry back for a document that was
 * *loaded* with a password, so handing the input straight back gives the user a
 * file that still asks for one (E5). Copying the pages into a fresh document is
 * the only reliable way to drop the protection.
 */
async function savable(input: OpenedInput, notes: Notes): Promise<PDFDocument> {
  if (!input.inspection?.encrypted) return input.doc;
  const outlines = hasOutlines(input.doc);
  const rebuilt = await rebuildDocument(input.doc);
  notes.add(
    `"${input.name}" is password protected, so the pages were copied into a new file — the output opens without a password.`,
  );
  if (outlines) {
    notes.add(`The copy does not carry "${input.name}"'s bookmarks across.`);
  }
  return rebuilt;
}

/* ── names (E17) ──────────────────────────────────────────────────────────── */

/**
 * A stem that survives a download: the shared E17 rule from `helpers`, so the
 * split files, ZIP entries and per-page outputs of every tool are named the
 * same way the runner names a single output.
 */
const safeStem = downloadStem;

/** Make `name` unique within `used` by suffixing `-2`, `-3`, … */
function uniqueName(used: Set<string>, name: string): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  let n = 2;
  while (used.has(`${name.replace(/\.pdf$/i, '')}-${n}.pdf`)) n += 1;
  const candidate = `${name.replace(/\.pdf$/i, '')}-${n}.pdf`;
  used.add(candidate);
  return candidate;
}

const PAGE_SIZE_OPTIONS = [
  { value: 'same', label: 'Same as source page' },
  { value: 'a4', label: 'A4 (210 × 297 mm)' },
  { value: 'letter', label: 'Letter (8.5 × 11 in)' },
  { value: 'legal', label: 'Legal (8.5 × 14 in)' },
  { value: 'a3', label: 'A3 (297 × 420 mm)' },
  { value: 'tabloid', label: 'Tabloid (11 × 17 in)' },
];

/** The largest page edge a conforming PDF may carry. */
const PDF_MAX_EDGE = 14400;
const MAX_EDGE_TEXT = '14 400 pt';

/**
 * What a page-tree copy costs. Every tool that rebuilds the document rather than
 * editing it in place loses the outline, and the run only says so when the file
 * happened to have one — so the standing disclosure belongs on the tool.
 */
const PAGE_COPY_NOTE =
  'The pages are copied into a new file, so this document’s own bookmarks are not in the output; page content, links and form fields travel with the pages.';

const FLATTEN_NOTE =
  'Imposition draws each page as vector content inside a new page: text stays selectable, but links, form fields and bookmarks on those pages do not survive the rebuild. The optional CoherentPDF engine edits a file without rebuilding it.';

/* ── shared fields ────────────────────────────────────────────────────────── */

const ALL_PAGES: ToolField = pagesField();

const CHUNK_SIZE: ToolField = {
  key: 'chunkSize',
  label: 'Pages per file',
  type: 'number',
  default: 2,
  min: 1,
  max: 500,
  step: 1,
  integer: true,
  group: 'Split by',
  help: 'Used by the fixed-chunks mode only: pages 1-N go in the first file, and a short final file is allowed.',
};

const ANCHOR: ToolField = {
  key: 'anchor',
  label: 'Page number',
  type: 'number',
  default: 1,
  min: 1,
  // A page number can only be bounded to the open document, so the rail gets a
  // generous ceiling and `clampToPage` names the real last page at run time (E6).
  max: 5000,
  step: 1,
  integer: true,
  group: 'Position',
  help: 'Counted in the document you dropped in. Clamped to its last page.',
};

const BLANK_COUNT: ToolField = {
  key: 'count',
  label: 'How many',
  type: 'number',
  default: 1,
  min: 1,
  max: 200,
  step: 1,
  integer: true,
  group: 'Position',
  help: 'Inserted as one run at the chosen position, not spread through the document.',

};

const OPACITY: ToolField = {
  key: 'opacity',
  label: 'Opacity',
  type: 'slider',
  default: 1,
  min: 0.05,
  max: 1,
  step: 0.05,
  group: 'Placement',
  help: 'Below 1 both layers stay legible; at 1 the overlay hides whatever is under it.',

};

const SCALE: ToolField = {
  key: 'scale',
  label: 'Stamp scale',
  type: 'slider',
  default: 1,
  min: 0.1,
  max: 3,
  step: 0.05,
  group: 'Placement',
  help: '1 draws the stamp page at its own size. Larger than 1 can push it past the edge of the base page.',

};

const GUTTER: ToolField = {
  key: 'gutter',
  label: 'Gutter',
  type: 'slider',
  default: 8,
  min: 0,
  max: 72,
  step: 1,
  unit: 'pt',
  group: 'Spacing',
  help: 'Extra space down the middle of the sheet, for a fold or a binder.',

};

const MARGIN: ToolField = {
  key: 'margin',
  label: 'Margin',
  type: 'slider',
  default: 18,
  min: 0,
  max: 72,
  step: 1,
  unit: 'pt',
  group: 'Spacing',
  help: 'Space kept around the whole grid, at the sheet edge.',

};

const ANGLE: ToolField = {
  key: 'angle',
  label: 'Angle',
  type: 'slider',
  default: 2,
  min: -180,
  max: 180,
  step: 0.1,
  unit: '°',
  group: 'Rotation',
  help: 'Positive turns clockwise. Any angle that is not a 90° step re-lays the page as vector content.',
};

const DPI: ToolField = {
  key: 'dpi',
  label: 'Resolution',
  type: 'slider',
  default: 200,
  min: 72,
  max: 400,
  step: 1,
  integer: true,
  unit: 'dpi',
  group: 'Images',
  help: 'Higher means a bigger archive and more memory in this tab.',
};

/* ── tools ────────────────────────────────────────────────────────────────── */

export const organizeTools: PdfToolDefinition[] = [
  {
    id: 'merge',
    name: 'Merge PDF',
    description: 'Combine multiple PDFs into one file, with bookmarks for each source',
    icon: '📑',
    category: 'organize',
    keywords: ['combine', 'join', 'append', 'stitch'],
    multiFile: true,
    minFiles: 1,
    outputSuffix: '_merged.pdf',
    actionLabel: 'Merge',
    promise: 'One PDF with every file’s pages in your order, plus a bookmark to each source.',
    notes: [
      'Pages are copied rather than flattened, so links and form fields inside them keep working and the source files are untouched.',
      'A bookmark is written for the first page of each file. Bookmarks *inside* a source file are not carried over — use the bookmark editor for those.',
    ],
    fields: [
      {
        key: 'bookmarks',
        label: 'Add a bookmark for each file',
        type: 'toggle',
        default: true,
        group: 'Output',
        help: 'Creates a top-level outline entry pointing at the first page of every merged file.',
      },
      {
        key: 'blankBetween',
        label: 'Blank page between files',
        type: 'toggle',
        default: false,
        group: 'Output',
        help: 'The spacer takes the size and orientation of the page before it, so mixed-size files still print correctly.',
      },
    ],
    validate: (_values, { fileCount }) =>
      fileCount < 2 ? 'Add at least two PDF files to merge.' : null,
    async run(context) {
      const inputs = await openInputs(context);
      const notes = createNotes();
      noteRepeated(inputs, notes);
      const target = await newPDF();
      const marks: { title: string; page: number }[] = [];
      const sheetSizes = new Set<string>();
      for (let i = 0; i < inputs.length; i++) {
        throwIfAborted(context.signal);
        const input = inputs[i];
        const start = target.getPageCount();
        marks.push({ title: input.name, page: start });
        const copied = await target.copyPages(input.doc, resolvePages('all', input.pageCount));
        for (const page of copied) {
          target.addPage(page);
          const box = visibleBox(page);
          sheetSizes.add(`${Math.round(box.width)}x${Math.round(box.height)}`);
        }
        if (booleanValue(context.values, 'blankBetween') && i < inputs.length - 1) {
          const size = visibleBox(target.getPage(start));
          target.addPage([size.width, size.height]);
        }
        context.progress((i + 1) / inputs.length, `Added ${input.name}`);
      }
      if (target.getPageCount() === 0) {
        throw new ToolInputError('NO_PAGES', 'None of the files you added has a page.', {
          hint: 'Check the queue — a damaged file can lose every page.',
        });
      }
      if (sheetSizes.size > 1) {
        notes.add(
          `The merged file keeps ${sheetSizes.size} different page sizes, because each source page kept its own. Choose "Fix page size" afterwards if you need one size.`,
        );
      }
      const outlineSource = inputs.find((input) => hasOutlines(input.doc));
      if (outlineSource) {
        notes.add(
          `"${outlineSource.name}" already had bookmarks: only the new per-file entries were written, and ${outlineSource.name}’s own tree was left behind.`,
        );
      }
      if (booleanValue(context.values, 'bookmarks', true)) {
        const written = writeFlatOutline(target, marks);
        if (written === 0) {
          notes.add('Bookmarks could not be written for these files, so the merge continued without them.');
        }
      }
      target.setProducer('BrowserSnip');
      return pdfOut(
        target,
        notes,
        `Merged ${inputs.length} files into ${target.getPageCount()} pages.`,
      );
    },
  },

  {
    id: 'split',
    name: 'Split PDF',
    description: 'Split into ranges, every page, odd/even, or fixed-size chunks',
    icon: '✂️',
    category: 'organize',
    keywords: ['divide', 'separate', 'extract', 'ranges'],
    outputSuffix: '_split',
    actionLabel: 'Split',
    promise: 'Separate PDFs — one per range, page, side or chunk — downloaded together.',
    notes: [PAGE_COPY_NOTE],
    fields: [
      {
        key: 'mode',
        label: 'Split by',
        type: 'segmented',
        default: 'ranges',
        group: 'Split by',
        options: [
          { value: 'ranges', label: 'Ranges' },
          { value: 'every', label: 'Every page' },
          { value: 'oddEven', label: 'Odd / even' },
          { value: 'chunks', label: 'Fixed chunks' },
        ],
      help: 'Choose how the file is cut. Every mode produces separate PDFs; none of them edits the original file.',
    },
      {
        key: 'ranges',
        label: 'Page ranges',
        type: 'text',
        default: '',
        placeholder: '1-3, 5, 8-10',
        group: 'Split by',
        help: 'Each range becomes its own PDF. Page numbers are checked against this document.',
        when: (v) => v.mode === 'ranges',
      },
      CHUNK_SIZE,
      {
        key: 'oddEven',
        label: 'Which side',
        type: 'select',
        default: 'both',
        group: 'Split by',
        options: [
          { value: 'both', label: 'Two files (odd and even)' },
          { value: 'odd', label: 'Odd pages only' },
          { value: 'even', label: 'Even pages only' },
        ],
        when: (v) => v.mode === 'oddEven',
        help: 'Two files is what a manual duplex printer needs; one file is for printing only one side first.',
      },
    ],
    validate(values) {
      const mode = stringValue(values, 'mode', 'ranges');
      if (mode === 'ranges' && stringValue(values, 'ranges').trim() === '') {
        return 'Enter at least one page range, for example 1-3, or choose a different split mode.';
      }
      return null;
    },
    async run(context) {
      const [input] = await openInputs(context);
      const notes = createNotes();
      const mode = stringValue(context.values, 'mode', 'ranges');
      const total = input.pageCount;
      const groups: { name: string; pages: number[] }[] = [];

      if (mode === 'every') {
        for (let i = 0; i < total; i++) groups.push({ name: `page-${i + 1}`, pages: [i] });
      } else if (mode === 'oddEven') {
        const which = stringValue(context.values, 'oddEven', 'both');
        const sides = [
          { key: 'odd', file: 'odd-pages', pages: resolvePages('odd', total) },
          { key: 'even', file: 'even-pages', pages: resolvePages('even', total) },
        ];
        for (const side of sides) {
          if (which !== 'both' && which !== side.key) continue;
          if (side.pages.length === 0) {
            // E13: a one-page document has no even side. Say so instead of
            // shipping a PDF whose only content is pdf-lib's filler page.
            notes.add(`This document has no ${side.key} pages, so no ${side.file} file was made.`);
            continue;
          }
          groups.push({ name: side.file, pages: side.pages });
        }
      } else if (mode === 'chunks') {
        const size = numberOf(context.values, CHUNK_SIZE, notes);
        if (size >= total) {
          notes.add(`The chunk size (${size}) is at least the document's length, so all ${pageCountLabel(total)} land in one file.`);
        }
        for (let i = 0; i < total; i += size) {
          const pages: number[] = [];
          for (let p = i; p < Math.min(i + size, total); p++) pages.push(p);
          groups.push({
            name: `pages-${pages[0] + 1}-${pages[pages.length - 1] + 1}`,
            pages,
          });
        }
      } else {
        const spec = stringValue(context.values, 'ranges');
        for (const chunk of spec.split(/[,\n;]+/)) {
          const trimmed = chunk.trim();
          if (!trimmed) continue;
          // Per-chunk so the refusal names the range that is wrong *and* the
          // page count that makes it wrong (E6, E15).
          const pages = selection({ pages: trimmed }, total, { verb: 'split out' });
          const first = pages[0] + 1;
          const last = pages[pages.length - 1] + 1;
          groups.push({ name: `pages-${first}-${last}`, pages });
        }
        if (groups.length === 0) {
          throw new ToolInputError('NO_PAGES', `"${spec}" did not contain a usable page range.`, {
            hint: `Write ranges like 1-3, 5, ${total}- using page numbers up to ${total}.`,
          });
        }
        const covered = new Set(groups.flatMap((group) => group.pages));
        if (covered.size < total) {
          notes.add(
            `These ranges cover ${pageCountLabel(covered.size)} of the document's ${pageCountLabel(total)}; the pages not listed (${formatPages(resolvePages('all', total).filter((p) => !covered.has(p)))}) are not in any output file.`,
          );
        }
      }

      if (groups.length === 0) {
        throw new ToolInputError('NO_PAGES', 'This split would produce no files at all.', {
          hint: `Pick a range inside 1-${total}, or switch to "Every page".`,
        });
      }

      const files: { blob: Blob; name: string }[] = [];
      const used = new Set<string>();
      const stem = safeStem(input.name);
      for (let i = 0; i < groups.length; i++) {
        throwIfAborted(context.signal);
        const group = groups[i];
        const doc = await collectPages([{ doc: input.doc, pages: group.pages }]);
        const bytes = await savePDF(doc.doc);
        files.push({
          blob: new Blob([bytes], { type: 'application/pdf' }),
          name: uniqueName(used, `${stem}_${group.name}.pdf`),
        });
        context.progress((i + 1) / groups.length, `Wrote ${group.name}`);
      }
      return filesOut(files, notes, `Created ${files.length} file${files.length === 1 ? '' : 's'} from ${pageCountLabel(total)}.`);
    },
  },

  {
    id: 'extract-pages',
    name: 'Extract Pages',
    description: 'Pull selected pages out as a new PDF, or one PDF per page',
    icon: '📤',
    category: 'organize',
    keywords: ['keep', 'separate', 'pull'],
    outputSuffix: '_extracted.pdf',
    surface: 'pages',
    actionLabel: 'Extract',
    promise: 'A new PDF with only the pages you picked, in the order you typed them.',
    notes: [PAGE_COPY_NOTE],
    fields: [
      ALL_PAGES,
      {
        key: 'mergeIntoOne',
        label: 'Combine into a single PDF',
        type: 'toggle',
        default: true,
        group: 'Output',
        help: 'Turn this off to get one separate file per selected page.',
      },
    ],
    validate(values) {
      if (stringValue(values, 'pages', '').trim() === '') return 'Choose which pages to extract.';
      return null;
    },
    async run(context) {
      const [input] = await openInputs(context);
      const notes = createNotes();
      const pages = selection(context.values, input.pageCount, { verb: 'extract' });
      if (pages.length === input.pageCount && pages.every((p, i) => p === i)) {
        notes.add(`You selected every page, so the extracted file matches the original's content (${pageCountLabel(pages.length)}).`);
      }
      if (booleanValue(context.values, 'mergeIntoOne', true)) {
        const doc = await collectPages([{ doc: input.doc, pages }]);
        return pdfOut(
          doc.doc,
          notes,
          `Extracted ${pageCountLabel(pages.length)} of ${pageCountLabel(input.pageCount)}.`,
        );
      }
      const stem = safeStem(input.name);
      const used = new Set<string>();
      const files: { blob: Blob; name: string }[] = [];
      for (let i = 0; i < pages.length; i++) {
        throwIfAborted(context.signal);
        const doc = await collectPages([{ doc: input.doc, pages: [pages[i]] }]);
        const bytes = await savePDF(doc.doc);
        files.push({
          blob: new Blob([bytes], { type: 'application/pdf' }),
          name: uniqueName(used, `${stem}_page-${pages[i] + 1}.pdf`),
        });
        context.progress((i + 1) / pages.length, `Page ${pages[i] + 1}`);
      }
      return filesOut(files, notes, `Created ${files.length} single-page files.`);
    },
  },

  {
    id: 'remove-pages',
    name: 'Delete Pages',
    description: 'Remove the pages you pick and keep everything else',
    icon: '🗑️',
    category: 'organize',
    keywords: ['delete', 'drop', 'discard'],
    outputSuffix: '_trimmed.pdf',
    surface: 'pages',
    actionLabel: 'Delete pages',
    promise: 'Your PDF with the chosen pages taken out; every other page untouched.',
    notes: [PAGE_COPY_NOTE],
    fields: [ALL_PAGES],
    validate(values) {
      const spec = stringValue(values, 'pages', '').trim();
      if (spec === '') return 'Choose the pages to delete, or the whole document disappears.';
      if (spec.toLowerCase() === 'all') {
        return 'Choose the pages to delete — deleting every page would leave an empty PDF.';
      }
      return null;
    },
    async run(context) {
      const [input] = await openInputs(context);
      const notes = createNotes();
      const drop = new Set(selection(context.values, input.pageCount, { verb: 'delete' }));
      const keep = resolvePages('all', input.pageCount).filter((p) => !drop.has(p));
      if (keep.length === 0) {
        throw new ToolInputError(
          'NO_PAGES',
          `Deleting pages ${formatPages([...drop])} would remove all ${pageCountLabel(input.pageCount)}, leaving an empty PDF.`,
          { hint: 'Keep at least one page, or use "Extract Pages" to save just the others.' },
        );
      }
      const doc = await collectPages([{ doc: input.doc, pages: keep }]);
      return pdfOut(
        doc.doc,
        notes,
        `Removed ${pageCountLabel(drop.size)}, kept ${pageCountLabel(keep.length)}.`,
      );
    },
  },

  {
    id: 'organize',
    name: 'Organize PDF',
    description: 'Drag to reorder, then rotate, duplicate, delete or insert blank pages',
    icon: '📋',
    category: 'organize',
    keywords: ['reorder', 'arrange', 'move', 'duplicate'],
    outputSuffix: '_organized.pdf',
    surface: 'custom',
    actionLabel: 'Apply order',
    promise: 'A rebuilt PDF in the order, rotation and duplication you set. The original file is never modified.',
    notes: [
      'Pages are copied, so a page can appear more than once in the output.',
      'A page with no `r90`/`r180`/`r270` keeps the rotation it already had; `r0` straightens it.',
      'The page grid writes this plan for you. Type it only if you want to.',
    ],
    fields: [
      {
        key: 'pageOrder',
        label: 'Page order',
        type: 'text',
        default: '',
        placeholder: 'auto from the page grid',
        group: 'Plan',
        help: 'Comma-separated source page numbers, optionally suffixed with r90/r180/r270 to rotate, a range like 2-5, or "blank".',
      },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const notes = createNotes();
      const raw = context.values.pageOrder;
      const plan = planFromValues(raw, input.pageCount, notes);
      const target = await newPDF();
      let planIndex = 0;
      let stamped = 0;
      for (const item of plan) {
        throwIfAborted(context.signal);
        if (item.blank) {
          const neighbour =
            planIndex > 0
              ? target.getPage(planIndex - 1)
              : input.doc.getPage(Math.max(0, Math.min(input.pageCount - 1, plan.find((p) => !p.blank)?.page ?? 0)));
          const size = neighbour ? visibleBox(neighbour) : { width: 595.28, height: 841.89 };
          target.insertPage(planIndex, [size.width, size.height]);
        } else {
          const [page] = await target.copyPages(input.doc, [item.page]);
          // Only re-set the rotation when the plan says so, so a `/Rotate 90`
          // page is not silently flattened to 0 by being reordered (E9).
          if (item.rotate !== null) page.setRotation(degrees(normaliseRotation(item.rotate)));
          target.insertPage(planIndex, page);
        }
        planIndex += 1;
        stamped += 1;
        context.progress(
          stamped / plan.length,
          item.blank ? 'Inserted a blank page' : `Placed source page ${item.page + 1}`,
        );
      }
      if (target.getPageCount() === 0) {
        throw new ToolInputError('NO_PAGES', 'The new page order is empty.', {
          hint: 'Add at least one page token (for example 1) or drag a tile back into the grid.',
        });
      }
      const blanksOnly = plan.every((item) => item.blank);
      if (blanksOnly) {
        notes.add(`The output holds only the ${plan.length} blank sheets you asked for; none of this document’s pages are in it.`);
      }
      if (distinctSizes(input.doc, resolvePages('all', input.pageCount)) > 1) {
        notes.add('This document mixes page sizes; every page kept its own size and each blank matches the page beside it.');
      }
      const isIdentity =
        plan.length === input.pageCount &&
        plan.every((item, index) => !item.blank && item.page === index && (item.rotate === null || item.rotate === rotationOf(input.doc.getPage(index))));
      if (isIdentity) {
        notes.add('The order you set matches the document as it is, so the output is a copy rather than a rearrangement.');
      }
      noteRebuildLoss('Reordering', input.doc, resolvePages('all', input.pageCount), notes);
      return pdfOut(target, notes, `Rebuilt the document with ${pageCountLabel(target.getPageCount())}.`);
    },
  },

  {
    id: 'rotate',
    name: 'Rotate PDF',
    description: 'Turn pages by 90°, 180° or 270° — whole document or a selection',
    icon: '🔄',
    category: 'organize',
    keywords: ['turn', 'landscape', 'portrait', 'orientation'],
    outputSuffix: '_rotated.pdf',
    surface: 'pages',
    actionLabel: 'Rotate',
    promise: 'The same pages turned by a quarter turn. Only the orientation changes — nothing is redrawn.',
    notes: [
      'Rotation is stored on the page, so text, links and bookmarks stay exactly where they were.',
      'The turn is added to each page’s existing rotation: a page already at 90° ends at 180°.',
    ],
    fields: [
      {
        key: 'degrees',
        label: 'Rotation',
        type: 'segmented',
        default: 90,
        group: 'Rotation',
        options: [
          { value: 90, label: '90° →' },
          { value: 180, label: '180°' },
          { value: 270, label: '270° ←' },
        ],
      help: 'Added to each page’s existing rotation, so 90° four times returns a page to where it started.',
    },
      ALL_PAGES,
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const notes = createNotes();
      const asked = numberValue(context.values, 'degrees', 90);
      const delta = normaliseRotation(asked);
      if (delta !== normalise180(asked)) {
        notes.add(`Rotation must be 90°, 180° or 270°: ${asked}° became ${delta}°.`);
      }
      if (delta === 0) {
        notes.add('A 0° or 360° turn leaves every page where it was, so the output is a copy.');
      }
      const pages = selection(context.values, input.pageCount, { verb: 'rotate' });
      const all = input.doc.getPages();
      let straightened = 0;
      for (let i = 0; i < pages.length; i++) {
        throwIfAborted(context.signal);
        const page = all[pages[i]];
        const before = rotationOf(page);
        page.setRotation(degrees(normaliseRotation(before + delta)));
        if (rotationOf(page) === 0 && before !== 0) straightened += 1;
        context.progress((i + 1) / pages.length, `Rotated page ${pages[i] + 1}`);
      }
      if (straightened > 0) {
        notes.add(`${straightened} of the selected ${pageCountLabel(pages.length)} were upside-down or sideways before this turn and are now upright.`);
      }
      const doc = await savable(input, notes);
      const untouched = input.pageCount - pages.length;
      return pdfOut(doc, notes, `Rotated ${pageCountLabel(pages.length)} by ${delta}°${untouched > 0 ? `, left ${pageCountLabel(untouched)} alone` : ''}.`);
    },
  },

  {
    id: 'rotate-custom',
    name: 'Rotate by Custom Degrees',
    description: 'Rotate page content by any angle, not just 90° steps',
    icon: '↩️',
    category: 'organize',
    keywords: ['skew', 'straighten', 'angle', 'de-angle'],
    outputSuffix: '_rotated.pdf',
    actionLabel: 'Turn',
    promise: 'Pages turned by any angle as vector content — text stays selectable, nothing is rasterised.',
    notes: [
      'The page box is rewritten, so the stored /Rotate is set to 0 and the turn is baked into the content.',
      FLATTEN_NOTE,
    ],
    fields: [
      ANGLE,
      {
        key: 'fit',
        label: 'Page size',
        type: 'select',
        default: 'grow',
        group: 'Rotation',
        options: [
          { value: 'grow', label: 'Grow the page so nothing is cut' },
          { value: 'keep', label: 'Keep the original page size (may crop corners)' },
        ],
      help: 'An angle that is not a right angle turns the corners outside the original sheet.',
    },
      ALL_PAGES,
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const notes = createNotes();
      const angle = numberOf(context.values, ANGLE, notes);
      const grow = stringValue(context.values, 'fit', 'grow') === 'grow';
      const chosen = new Set(selection(context.values, input.pageCount, { verb: 'turn' }));
      // The turn is baked into a freshly sized page instead of added to the old
      // one, so a `/Rotate 90` sheet still displays the way it did before the
      // extra angle (E9) and the pages that were not chosen are copied verbatim.
      const target = await newPDF();
      let cut = 0;
      for (let index = 0; index < input.pageCount; index++) {
        throwIfAborted(context.signal);
        const source = input.doc.getPage(index);
        if (!chosen.has(index)) {
          const [copy] = await target.copyPages(input.doc, [index]);
          target.addPage(copy);
          continue;
        }
        const shown = visibleBox(source);
        const needed = rotatedBoxSize(shown.width, shown.height, angle);
        const size = grow ? needed : shown;
        const page = target.addPage([size.width, size.height]);
        await stamp(
          target,
          page,
          source,
          { x: 0, y: 0, width: size.width, height: size.height },
          { angle, fit: 'exact' },
        );
        if (needed.width > size.width + 0.5 || needed.height > size.height + 0.5) cut += 1;
        context.progress((index + 1) / input.pageCount, `Turned page ${index + 1}`);
      }
      if (cut > 0) {
        notes.add(`Keeping the original page size cut the corners off ${pageCountLabel(cut)} after the turn. Choose "Grow the page" to keep everything.`);
      }
      if (normalise360(angle) % 90 !== 0) {
        noteRebuildLoss('A custom-angle turn', input.doc, [...chosen], notes);
      }
      const left = input.pageCount - chosen.size;
      return pdfOut(
        target,
        notes,
        `Turned ${pageCountLabel(chosen.size)} by ${angle}° clockwise${left > 0 ? `, left ${pageCountLabel(left)} as they were` : ''}.`,
      );
    },
  },

  {
    id: 'reverse-pages',
    name: 'Reverse Pages',
    description: 'Flip the page order of the whole document',
    icon: '🔃',
    category: 'organize',
    keywords: ['invert order', 'backwards', 'descending'],
    outputSuffix: '_reversed.pdf',
    notes: [PAGE_COPY_NOTE],
    actionLabel: 'Reverse',
    promise: 'The same pages in the opposite order, as a new PDF.',
    async run(context) {
      const [input] = await openInputs(context);
      const notes = createNotes();
      const pages = resolvePages('all', input.pageCount);
      if (input.pageCount < 2) {
        notes.add(`This document has ${pageCountLabel(input.pageCount)}, so reversing changes nothing — the output is a copy.`);
      }
      if (hasOutlines(input.doc)) {
        notes.add('Bookmarks were written for the original order, so they are not carried into the reversed file.');
      }
      const doc = await collectPages([{ doc: input.doc, pages: [...pages].reverse() }]);
      return pdfOut(doc.doc, notes, `Reversed ${pageCountLabel(pages.length)}.`);
    },
  },

  {
    id: 'add-blank-page',
    name: 'Add Blank Page',
    description: 'Insert blank pages at the start, end, or after any page',
    icon: '📄',
    category: 'organize',
    keywords: ['insert', 'empty', 'spacer', 'sheet'],
    outputSuffix: '_with_blanks.pdf',
    actionLabel: 'Add blanks',
    promise: 'Your PDF with blank sheets inserted where you choose, sized to the page beside them.',
    notes: [PAGE_COPY_NOTE],
    fields: [
      {
        key: 'position',
        label: 'Position',
        type: 'select',
        default: 'end',
        group: 'Position',
        options: [
          { value: 'start', label: 'Before the first page' },
          { value: 'end', label: 'After the last page' },
          { value: 'after', label: 'After a specific page' },
          { value: 'before', label: 'Before a specific page' },
        ],
      help: 'Two blanks after page 3 inserts them between pages 3 and 4, counted in the document you dropped in.',
    },
      ANCHOR,
      BLANK_COUNT,
      { key: 'size', label: 'Size', type: 'select', default: 'same', options: PAGE_SIZE_OPTIONS, group: 'Size', help: 'Same as source matches the page beside it, which is what keeps a mixed-size document printing squarely.' },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const notes = createNotes();
      const count = numberOf(context.values, BLANK_COUNT, notes);
      const position = stringValue(context.values, 'position', 'end');
      const total = input.pageCount;
      const usesAnchor = position === 'after' || position === 'before';
      const anchor = usesAnchor
        ? clampToPage('Page number', numberValue(context.values, 'anchor', 1), total, notes)
        : position === 'start'
          ? 1
          : total;
      const sizeSpec = stringValue(context.values, 'size', 'same');
      // A blank belongs with the sheet beside it, so mixed-size documents keep
      // making sense and the inserted page is not always page 1's size (E8).
      const neighbourIndex = Math.max(0, Math.min(total - 1, position === 'before' ? anchor - 2 : anchor - 1));
      const neighbour = visibleBox(input.doc.getPage(neighbourIndex));
      const size: [number, number] =
        sizeSpec === 'same' ? [neighbour.width, neighbour.height] : resolvePageSize(sizeSpec);
      const target = await newPDF();
      const all = await target.copyPages(input.doc, resolvePages('all', total));
      for (const page of all) target.addPage(page);
      const insertAt = insertPosition(position, target.getPageCount(), anchor);
      for (let i = 0; i < count; i++) {
        throwIfAborted(context.signal);
        target.insertPage(insertAt + i, size);
        context.progress((i + 1) / count, `Inserted blank page ${i + 1}`);
      }
      if (sizeSpec === 'same' && distinctSizes(input.doc, resolvePages('all', total)) > 1) {
        notes.add(`This document mixes page sizes, so the blank sheets match page ${neighbourIndex + 1} beside them.`);
      }
      return pdfOut(
        target,
        notes,
        `Inserted ${pageCountLabel(count)} at position ${insertAt + 1} — the file now has ${pageCountLabel(target.getPageCount())}.`,
      );
    },
  },

  {
    id: 'alternate-merge',
    name: 'Alternate & Mix Pages',
    description: 'Merge PDFs by taking pages in rotation from each file',
    icon: '🎲',
    category: 'organize',
    keywords: ['interleave', 'shuffle', 'zip', 'round robin'],
    multiFile: true,
    minFiles: 2,
    outputSuffix: '_alternated.pdf',
    actionLabel: 'Mix pages',
    promise: 'One PDF that takes pages from each file in turn until they run out.',
    notes: [PAGE_COPY_NOTE],
    fields: [
      {
        key: 'pattern',
        label: 'Pattern',
        type: 'select',
        default: '1-1',
        group: 'Pattern',
        options: [
          { value: '1-1', label: 'One page from each file in turn' },
          { value: '2-2', label: 'Two pages from each file in turn' },
          { value: 'reverse-alternate', label: 'Alternate, second file reversed' },
        ],
        help: 'Files are used in the order they appear in the queue.',
      },
    ],
    validate: (_v, { fileCount }) =>
      fileCount < 2 ? 'Add at least two PDF files to alternate between.' : null,
    async run(context) {
      const inputs = await openInputs(context);
      const notes = createNotes();
      noteRepeated(inputs, notes);
      const pattern = stringValue(context.values, 'pattern', '1-1');
      const runLength = pattern === '2-2' ? 2 : 1;
      const queues = inputs.map((input) => {
        const pages = resolvePages('all', input.pageCount);
        return pattern === 'reverse-alternate' ? [...pages].reverse() : pages;
      });
      const plan: { source: number; page: number }[] = [];
      const cursors = queues.map(() => 0);
      const longest = Math.max(...queues.map((queue) => queue.length));
      while (cursors.some((cursor, index) => cursor < queues[index].length)) {
        queues.forEach((queue, index) => {
          for (let k = 0; k < runLength && cursors[index] < queue.length; k++) {
            plan.push({ source: index, page: queue[cursors[index]] });
            cursors[index] += 1;
          }
        });
      }
      if (plan.length === 0) {
        throw new ToolInputError('NO_PAGES', 'None of the files you added has a page to mix.', {
          hint: 'Check the queue — a damaged file can lose every page.',
        });
      }
      if (queues.some((queue) => queue.length !== longest)) {
        const detail = inputs
          .map((input, index) => `"${input.name}" ${queues[index].length}`)
          .join(', ');
        notes.add(
          `The files are unequal (pages per file: ${detail}), so the tail of the mix comes from the longer file${longest === 1 ? '' : 's'} only.`,
        );
      }
      const target = await newPDF();
      for (let i = 0; i < plan.length; i++) {
        if (i % 25 === 0) throwIfAborted(context.signal);
        const item = plan[i];
        // A copied PDFPage can only be attached once, so each output page is
        // copied fresh rather than reused from a cache.
        const [page] = await target.copyPages(inputs[item.source].doc, [item.page]);
        target.addPage(page);
        context.progress((i + 1) / plan.length, `Page ${i + 1}`);
      }
      if (distinctSizes(target, resolvePages('all', target.getPageCount())) > 1) {
        notes.add('Each page kept its own size, so the mixed file has mixed page sizes. "Fix page size" can even them out afterwards.');
      }
      return pdfOut(target, notes, `Mixed ${pageCountLabel(plan.length)} from ${inputs.length} files.`);
    },
  },

  {
    id: 'duplex-collate',
    name: 'Duplex Collate',
    description: 'Reorder front/back scan blocks into printing order',
    icon: '🗂️',
    category: 'organize',
    keywords: ['collate', 'scanner', 'simplex', 'back side'],
    outputSuffix: '_collated.pdf',
    actionLabel: 'Collate',
    promise: 'A re-ordered PDF where each front page is followed by its own back page.',
    notes: [PAGE_COPY_NOTE],
    fields: [
      {
        key: 'backReversed',
        label: 'Second half was scanned in reverse',
        type: 'toggle',
        default: true,
        group: 'Scan order',
        help: 'Most single-pass duplex scanners output the back side upside-down and last-page-first.',
      },
      {
        key: 'offset',
        label: 'Back-side page offset',
        type: 'number',
        default: 0,
        min: 0,
        max: 500,
        step: 1,
        integer: true,
        group: 'Scan order',
        help: 'Use this when the back-side block starts a page later than half the document.',
      },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const notes = createNotes();
      const total = input.pageCount;
      if (total < 2) {
        notes.add(`A ${pageCountLabel(total)} document cannot be collated — there is no back block to interleave, so the output is a copy.`);
      }
      const offsetField = { ...OFFSET, max: Math.max(1, Math.ceil(total / 2)) };
      const offset = numberOf(context.values, offsetField, notes);
      const half = Math.ceil(total / 2);
      const all = resolvePages('all', total);
      const front = all.slice(0, half);
      const back = all.slice(Math.min(total, half + offset));
      if (booleanValue(context.values, 'backReversed', true)) back.reverse();
      const interleaved: number[] = [];
      for (let i = 0; i < Math.max(front.length, back.length); i++) {
        if (i < front.length) interleaved.push(front[i]);
        if (i < back.length) interleaved.push(back[i]);
      }
      const seen = new Set<number>();
      const duplicates = new Set<number>();
      for (const page of interleaved) {
        if (seen.has(page)) duplicates.add(page);
        seen.add(page);
      }
      const missing = all.filter((page) => !seen.has(page));
      if (missing.length > 0) {
        notes.add(
          `This collation leaves ${pageCountLabel(missing.length)} out (${formatPages(missing)}): an offset of ${offset} drops the pages between the two blocks.`,
        );
      }
      if (duplicates.size > 0) {
        notes.add(`The plan repeats ${pageCountLabel(duplicates.size)} (${formatPages([...duplicates])}) — reduce the offset if that is not what you meant.`);
      }
      if (total % 2 === 1) {
        notes.add(`An odd ${pageCountLabel(total)} scan splits ${half} + ${total - half}, so the last sheet has no back page.`);
      }
      const doc = await collectPages([{ doc: input.doc, pages: interleaved }]);
      return pdfOut(
        doc.doc,
        notes,
        `Collated ${pageCountLabel(interleaved.length)} from a ${front.length} + ${back.length} scan.`,
      );
    },
  },

  {
    id: 'overlay-pdf',
    name: 'PDF Overlay',
    description: 'Stamp or underlay one PDF onto another',
    icon: '🎭',
    category: 'organize',
    keywords: ['stamp', 'letterhead', 'watermark file', 'underlay'],
    multiFile: true,
    minFiles: 2,
    maxFiles: 2,
    outputSuffix: '_overlaid.pdf',
    actionLabel: 'Overlay',
    promise: 'The base PDF with a page from the second file stamped over — or behind — every sheet.',
    notes: [
      'The first file in the queue is the base; the second is the stamp.',
      FLATTEN_NOTE,
    ],
    fields: [
      {
        key: 'mode',
        label: 'Mode',
        type: 'segmented',
        default: 'overlay',
        group: 'Placement',
        options: [
          { value: 'overlay', label: 'On top (overlay)' },
          { value: 'underlay', label: 'Behind (underlay)' },
        ],
      help: 'On top covers the page beneath it. Behind puts the stamp under the existing ink, where only transparent areas show it.',
    },
      {
        key: 'mapping',
        label: 'Which stamp page for each base page',
        type: 'select',
        default: 'same',
        group: 'Placement',
        options: [
          { value: 'same', label: 'Same page number' },
          { value: 'first', label: 'Always the first stamp page' },
          { value: 'last', label: 'Always the last stamp page' },
        ],
      help: 'When the stamp file is shorter than the base, its last page is reused for the rest.',
    },
      OPACITY,
      SCALE,
    ],
    validate: (_v, { fileCount }) =>
      fileCount === 2 ? null : 'Add exactly two PDFs: the base document first, then the one to overlay.',
    async run(context) {
      const inputs = await openInputs(context);
      const notes = createNotes();
      const [base, stampDoc] = inputs;
      if (inputs.length > 2) {
        throw new ToolInputError('OUT_OF_RANGE', `Overlay takes exactly two files; ${inputs.length} were added.`, {
          hint: 'Remove the extra files, or merge them into the base first.',
        });
      }
      if (base.name === stampDoc.name && base.bytes.length === stampDoc.bytes.length) {
        notes.add(`"${base.name}" was added twice, so it is being stamped onto itself.`);
      }
      context.log(`Overlaying "${stampDoc.name}" onto "${base.name}" (${stringValue(context.values, 'mode', 'overlay')}).`);
      const target = await cloneForOutput(base.doc);
      const pages = target.getPages();
      const mode = stringValue(context.values, 'mode', 'overlay');
      const mapping = stringValue(context.values, 'mapping', 'same');
      const opacity = numberOf(context.values, OPACITY, notes);
      const scale = numberOf(context.values, SCALE, notes);
      const stampTotal = stampDoc.pageCount;
      let shortBy = 0;
      let skipped = 0;
      for (let i = 0; i < pages.length; i++) {
        throwIfAborted(context.signal);
        const page = pages[i];
        const stampIndex = stampPageIndex(mapping, i, stampTotal);
        if (mapping === 'same' && i >= stampTotal) shortBy += 1;
        const source = stampDoc.doc.getPage(stampIndex);
        // The box is in the base page's own space: a `/Rotate 90` sheet is
        // centred on what the viewer sees, not on the raw MediaBox (E9).
        const box = sourceBox(page);
        const width = box.width * scale;
        const height = box.height * scale;
        const dest: Box = {
          x: box.x + (box.width - width) / 2,
          y: box.y + (box.height - height) / 2,
          width,
          height,
        };
        const drew = mode === 'underlay'
          ? await stampBehind(target, page, () => stamp(target, page, source, dest, { opacity }))
          : await stamp(target, page, source, dest, { opacity });
        if (!drew) skipped += 1;
        context.progress((i + 1) / pages.length, `Page ${i + 1}`);
      }
      if (shortBy > 0) {
        notes.add(
          `The stamp has ${pageCountLabel(stampTotal)} and the base has ${pageCountLabel(pages.length)}, so the last ${pageCountLabel(shortBy)} reused stamp page ${stampTotal}. Choose "Always the first stamp page" to make that deliberate.`,
        );
      }
      if (skipped === pages.length && pages.length > 0) {
        notes.add('None of the stamp pages had drawable content, so the output is the base document unchanged.');
      }
      if (opacity < 1) {
        notes.add(`The stamp was drawn at ${Math.round(opacity * 100)}% opacity — a viewer prints it lighter, it is not baked in.`);
      }
      noteMixedSizes('Overlay', base.doc, resolvePages('all', base.pageCount), notes);
      return pdfOut(target, notes, `${mode === 'underlay' ? 'Underlaid' : 'Overlaid'} ${pageCountLabel(pages.length)} with "${stampDoc.name}".`);
    },
  },

  {
    id: 'n-up',
    name: 'N-Up PDF',
    description: 'Put 2, 4, 6 or 9 pages on one sheet',
    icon: '🗞️',
    category: 'organize',
    keywords: ['multiple pages per sheet', 'shrink', 'handout', 'imposition'],
    outputSuffix: '_nup.pdf',
    actionLabel: 'Lay out',
    promise: 'A new PDF with 2, 4, 6 or 9 source pages scaled into cells on each sheet.',
    notes: [FLATTEN_NOTE],
    fields: [
      {
        key: 'perSheet',
        label: 'Pages per sheet',
        type: 'segmented',
        default: 2,
        group: 'Layout',
        options: [
          { value: 2, label: '2' },
          { value: 4, label: '4' },
          { value: 6, label: '6' },
          { value: 9, label: '9' },
        ],
      help: 'Pages are scaled down to fit the cells, so small print on a dense layout gets genuinely smaller.',
    },
      { key: 'sheetSize', label: 'Sheet size', type: 'select', default: 'a4', options: PAGE_SIZE_OPTIONS.slice(1), group: 'Layout', help: 'Big enough that the reduced pages stay readable: two-up A4 on A4 halves the type size.' },
      { key: 'landscape', label: 'Landscape sheet', type: 'toggle', default: true, group: 'Layout',
        help: 'Rotates the sheet, which changes how the cells are arranged rather than how the pages are ordered.',
      },
      {
        key: 'order',
        label: 'Fill order',
        type: 'segmented',
        default: 'across',
        group: 'Layout',
        options: [
          { value: 'across', label: 'Across then down' },
          { value: 'down', label: 'Down then across' },
        ],
      help: 'Across fills left to right along a row; down fills each column first. Pick whichever matches how you will cut the sheet.',
    },
      GUTTER,
      MARGIN,
      { key: 'border', label: 'Hairline around each page', type: 'toggle', default: false, group: 'Spacing', help: 'A thin rule at each cell edge, so a trimmed layout still shows where each page ended.' },
      ALL_PAGES,
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const notes = createNotes();
      const source = selection(context.values, input.pageCount, { fallback: 'all', verb: 'lay out' });
      const perSheet = numberValue(context.values, 'perSheet', 2);
      const [columns, rows] = gridFor(perSheet);
      const sheet = resolvePageSize(stringValue(context.values, 'sheetSize', 'a4'), booleanValue(context.values, 'landscape', true));
      const across = stringValue(context.values, 'order', 'across') === 'across';
      const gutter = numberOf(context.values, GUTTER, notes);
      const margin = numberOf(context.values, MARGIN, notes);
      const border = booleanValue(context.values, 'border');
      const box = gridBox(sheet[0], sheet[1], columns, rows, gutter, margin);
      const first = box(0);
      if (first.width <= 0 || first.height <= 0) {
        throw new ToolInputError(
          'OUT_OF_RANGE',
          `A ${Math.round(margin)} pt margin and ${Math.round(gutter)} pt gutter leave no room for ${columns} × ${rows} cells on a ${Math.round(sheet[0])} × ${Math.round(sheet[1])} pt sheet.`,
          { hint: 'Lower the margin or gutter, or choose a bigger sheet.' },
        );
      }
      const cells: { sheet: number; cell: number; page: number }[] = [];
      source.forEach((page, index) => {
        const cell = across ? index : (index % rows) * columns + Math.floor(index / rows);
        cells.push({ sheet: Math.floor(index / perSheet), cell, page });
      });
      const target = await sheetDocument(input.doc, sheet, cells, perSheet, box, notes);
      if (border) {
        const grey = rgb(0.8, 0.8, 0.8);
        for (let i = 0; i < target.getPageCount(); i++) {
          const page = target.getPage(i);
          for (let c = 0; c < perSheet; c++) {
            const cell = box(c);
            page.drawRectangle({
              x: cell.x,
              y: cell.y,
              width: cell.width,
              height: cell.height,
              borderColor: grey,
              borderWidth: 0.5,
            });
          }
        }
      }
      noteMixedSizes('N-up', input.doc, source, notes);
      noteRebuildLoss('N-up', input.doc, source, notes);
      const sheets = target.getPageCount();
      const emptyCells = sheets * perSheet - source.length;
      return pdfOut(
        target,
        notes,
        `Placed ${pageCountLabel(source.length)} on ${sheets} sheet${sheets === 1 ? '' : 's'} (${perSheet} per sheet${emptyCells > 0 ? `, ${emptyCells} empty cell${emptyCells === 1 ? '' : 's'} on the last` : ''}).`,
      );
    },
  },

  {
    id: 'booklet',
    name: 'PDF Booklet',
    description: 'Reorder and impose pages for double-sided saddle-stitch printing',
    icon: '📖',
    category: 'organize',
    keywords: ['saddle stitch', 'fold', 'zine', 'imposition', 'print'],
    outputSuffix: '_booklet.pdf',
    actionLabel: 'Build booklet',
    promise: 'Fold-ready sheets in saddle-stitch order, padded to a whole number of sheets.',
    notes: [
      'Print duplex, flip on the long edge, then fold in half.',
      FLATTEN_NOTE,
    ],
    fields: [
      { key: 'sheetSize', label: 'Sheet size', type: 'select', default: 'a4', options: PAGE_SIZE_OPTIONS.slice(1), group: 'Sheet', help: 'The finished sheet, before folding: an A4 booklet is imposed two-up on A3 landscape.' },
      { key: 'landscape', label: 'Landscape sheet', type: 'toggle', default: true, group: 'Sheet', help: 'Saddle-stitch sheets are landscape by definition; portrait here prints a booklet that folds the wrong way.' },
      {
        key: 'gutter',
        label: 'Gutter',
        type: 'slider',
        default: 12,
        min: 0,
        max: 72,
        step: 1,
        unit: 'pt',
        group: 'Sheet',
      help: 'Extra space at the fold, so binding does not swallow text. Add half the spine thickness.',
    },
      {
        key: 'margin',
        label: 'Margin',
        type: 'slider',
        default: 12,
        min: 0,
        max: 72,
        step: 1,
        unit: 'pt',
        group: 'Sheet',
      help: 'Space at the outer edge of each sheet, which becomes the trim edge when you fold.',
    },
      {
        key: 'blankFill',
        label: 'Add blank pages to complete the last sheet',
        type: 'toggle',
        default: true,
        group: 'Sheet',
      help: 'A booklet must fill a whole number of sheets, so the last one is padded with blanks.',
    },
      ALL_PAGES,
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const notes = createNotes();
      const source = selection(context.values, input.pageCount, { fallback: 'all', verb: 'make into a booklet' });
      const sheet = resolvePageSize(stringValue(context.values, 'sheetSize', 'a4'), booleanValue(context.values, 'landscape', true));
      const gutter = numberOf(context.values, { ...GUTTER, label: 'Gutter', default: 12 }, notes);
      const margin = numberOf(context.values, { ...MARGIN, label: 'Margin', default: 12 }, notes);
      const fill = booleanValue(context.values, 'blankFill', true);
      const pages = [...source];
      // A saddle-stitched sheet carries four pages, so a booklet that is short
      // of a multiple of four has to be padded — with or without the toggle,
      // otherwise the odd pages would silently disappear from the print run.
      const padTo = Math.ceil(pages.length / 4) * 4;
      while (pages.length < padTo) pages.push(-1);
      const blanks = pages.length - source.length;
      if (blanks > 0 && !fill) {
        notes.add(`A booklet needs whole sheets, so ${pageCountLabel(blanks)} were padded in even though blank pages were switched off.`);
      }
      if (source.length < input.pageCount) {
        const left = resolvePages('all', input.pageCount).filter((page) => !source.includes(page));
        notes.add(
          `A booklet imposes whole sheets, so it carries ${pageCountLabel(source.length)} of this document's ${pageCountLabel(input.pageCount)} — pages ${formatPages(left)} are not in the print run.`,
        );
      }
      const box = (cell: number): Box => {
        const half = sheet[0] / 2;
        const inset = cell === 0 ? margin : gutter;
        const rightInset = cell === 0 ? gutter : margin;
        return {
          x: cell === 0 ? inset : half + rightInset,
          y: margin,
          width: half - inset - rightInset,
          height: sheet[1] - margin * 2,
        };
      };
      if (box(0).width <= 0 || box(0).height <= 0) {
        throw new ToolInputError(
          'OUT_OF_RANGE',
          `A ${Math.round(margin)} pt margin plus a ${Math.round(gutter)} pt fold allowance leaves no printable width on a ${Math.round(sheet[0])} pt sheet.`,
          { hint: 'Reduce the margin or the fold allowance, or pick a larger sheet.' },
        );
      }
      const total = pages.length;
      const cells: { sheet: number; cell: number; page: number }[] = [];
      for (let i = 0; i < total / 4; i++) {
        cells.push({ sheet: i, cell: 0, page: pages[total - 1 - 2 * i] });
        cells.push({ sheet: i, cell: 1, page: pages[2 * i] });
        cells.push({ sheet: i, cell: 0, page: pages[2 * i + 1] });
        cells.push({ sheet: i, cell: 1, page: pages[total - 2 - 2 * i] });
      }
      const target = await sheetDocument(input.doc, sheet, cells, 2, box, notes);
      noteMixedSizes('The booklet', input.doc, source, notes);
      noteRebuildLoss('The booklet', input.doc, source, notes);
      return pdfOut(
        target,
        notes,
        `Imposed ${pageCountLabel(source.length)} onto ${target.getPageCount()} booklet sheets${blanks > 0 ? ` with ${pageCountLabel(blanks)} added` : ''}. Print duplex, flip on long edge.`,
      );
    },
  },

  {
    id: 'combine-single-page',
    name: 'Combine to Single Page',
    description: 'Stitch every page into one continuous scroll',
    icon: '🧵',
    category: 'organize',
    keywords: ['long image', 'continuous', 'concatenate', 'scroll'],
    outputSuffix: '_combined.pdf',
    actionLabel: 'Stitch',
    promise: 'One long page (or a few, at the PDF height limit) with every page scaled to the same width.',
    notes: [FLATTEN_NOTE],
    fields: [
      { key: 'gap', label: 'Gap between pages', type: 'slider', default: 12, min: 0, max: 120, step: 1, unit: 'pt', group: 'Layout', help: 'Space between the joined pages, drawn as blank rather than as a hairline.' },
      {
        key: 'width',
        label: 'Target width',
        type: 'select',
        default: 'widest',
        group: 'Layout',
        options: [
          { value: 'widest', label: 'Widest source page' },
          { value: 'a4', label: 'A4 width' },
          { value: 'letter', label: 'Letter width' },
        ],
      help: 'Everything is scaled to this width, so pages narrower than it gain side margins rather than stretching.',
    },
      {
        key: 'splitOverflow',
        label: 'Start a new page when the PDF height limit is reached',
        type: 'toggle',
        default: true,
        group: 'Layout',
        help: 'A PDF page edge cannot exceed 14 400 units. Switching this off lets the scroll run off the bottom instead.',
      },
      ALL_PAGES,
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const notes = createNotes();
      const gap = numberOf(context.values, { ...GUTTER, key: 'gap', label: 'Gap between pages', default: 12, max: 120 }, notes);
      const widthMode = stringValue(context.values, 'width', 'widest');
      const split = booleanValue(context.values, 'splitOverflow', true);
      const source = selection(context.values, input.pageCount, { fallback: 'all', verb: 'stitch' });
      const boxes = source.map((index) => visibleBox(input.doc.getPage(index)));
      const widest = Math.max(...boxes.map((box) => box.width));
      const width = widthMode === 'widest' ? widest : resolvePageSize(widthMode)[0];
      if (width < widest) {
        notes.add(`Every page is scaled down to ${Math.round(width)} pt wide, so text that was ${Math.round(widest)} pt is now smaller on the sheet.`);
      }
      // A PDF page edge may not exceed 14 400 units, so a long scroll has to
      // overflow onto another sheet — or say plainly that it was cut.
      const maxHeight = split ? PDF_MAX_EDGE : Infinity;
      const target = await newPDF();
      let current: PDFPage | null = null;
      let yFromTop = 0;
      let sheets = 0;
      let blank = 0;
      let clipped = 0;
      for (let i = 0; i < source.length; i++) {
        throwIfAborted(context.signal);
        const box = boxes[i];
        const scale = width / box.width;
        const drawHeight = box.height * scale;
        if (!current || yFromTop + drawHeight > maxHeight) {
          // Each sheet is exactly as tall as the content it carries, capped at
          // the PDF limit; leaving it any taller would print blank paper.
          sheets += 1;
          current = target.addPage([width, Math.min(maxHeight, Math.max(drawHeight, yFromTop - gap))]);
          yFromTop = 0;
        }
        const page = current;
        page.setSize(width, Math.min(maxHeight, Math.max(page.getHeight(), yFromTop + drawHeight)));
        // `yFromTop` is measured down the sheet, and the sheet grows as the
        // scroll goes, so the box is recomputed on every stitch.
        const ok = await stamp(target, page, input.doc.getPage(source[i]), {
          x: 0,
          y: page.getHeight() - yFromTop - drawHeight,
          width,
          height: drawHeight,
        });
        if (!ok) blank += 1;
        if (page.getHeight() < yFromTop + drawHeight - 0.5) clipped += 1;
        yFromTop += drawHeight + gap;
        context.progress((i + 1) / source.length, `Stitched page ${source[i] + 1}`);
      }
      if (target.getPageCount() === 0) {
        throw new ToolInputError('NO_PAGES', 'There was nothing to stitch together.', {
          hint: `Choose pages between 1 and ${input.pageCount}.`,
        });
      }
      if (blank > 0) {
        notes.add(`${pageCountLabel(blank)} of the stitched pages had no content to draw, so those strips are blank.`);
      }
      if (clipped > 0) {
        notes.add(
          `A PDF page edge cannot exceed ${MAX_EDGE_TEXT}: ${pageCountLabel(clipped)} ran past it and ${clipped === 1 ? 'is' : 'are'} cut off — a narrower target width would fit more on each sheet.`,
        );
      } else if (sheets > 1) {
        notes.add(`The scroll is ${sheets} sheets long because of the ${MAX_EDGE_TEXT} page limit; print them in order and trim the joins.`);
      } else if (!split && target.getPage(0).getHeight() > PDF_MAX_EDGE) {
        notes.add(
          `The sheet is ${Math.round(target.getPage(0).getHeight())} pt tall, past the ${MAX_EDGE_TEXT} limit some viewers enforce — switch on "start a new page" if part of it disappears.`,
        );
      }
      if (source.length === 1) {
        notes.add('One page cannot be stitched to anything, so the output is that page scaled to the chosen width.');
      }
      noteMixedSizes('Stitching', input.doc, source, notes);
      noteRebuildLoss('Stitching', input.doc, source, notes);
      return pdfOut(
        target,
        notes,
        `Combined ${pageCountLabel(source.length)} into ${target.getPageCount()} long page${target.getPageCount() === 1 ? '' : 's'}.`,
      );
    },
  },

  {
    id: 'posterize',
    name: 'Posterize PDF',
    description: 'Split each page into a grid of overlapping tiles for large-format printing',
    icon: '🖼️',
    category: 'organize',
    keywords: ['tiled', 'banner', 'large format', 'split pages'],
    outputSuffix: '_poster.pdf',
    actionLabel: 'Make poster',
    promise: 'A grid of printable tiles with the overlap you set at their edges, ready to trim and paste.',
    notes: [FLATTEN_NOTE],
    fields: [
      { key: 'columns', label: 'Tiles across', type: 'number', default: 2, min: 1, max: 12, step: 1, integer: true, half: true, group: 'Grid', help: 'How many tiles the page is cut into horizontally; with tiles down this sets the size of each piece.' },
      { key: 'rows', label: 'Tiles down', type: 'number', default: 2, min: 1, max: 12, step: 1, integer: true, half: true, group: 'Grid', help: 'How many tiles the page is cut into vertically; with tiles across this sets the size of each piece.' },
      { key: 'bleed', label: 'Overlap for trimming', type: 'slider', default: 10, min: 0, max: 100, step: 1, unit: 'pt', group: 'Grid', help: 'How much neighbouring tiles repeat, so a small cutting error still meets up.' },
      ALL_PAGES,
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const notes = createNotes();
      const columns = numberOf(context.values, { ...TILES, key: 'columns', label: 'Tiles across' }, notes);
      const rows = numberOf(context.values, { ...TILES, key: 'rows', label: 'Tiles down' }, notes);
      const bleed = numberOf(context.values, { ...GUTTER, key: 'bleed', label: 'Overlap for trimming', default: 10, max: 100 }, notes);
      const source = selection(context.values, input.pageCount, { fallback: 'all', verb: 'posterize' });
      if (columns === 1 && rows === 1) {
        notes.add('One tile across and one down copies each page rather than splitting it — raise one of them to make a poster.');
      }
      const target = await newPDF();
      for (let p = 0; p < source.length; p++) {
        throwIfAborted(context.signal);
        const page = input.doc.getPage(source[p]);
        const size = visibleBox(page);
        if (bleed >= Math.min(size.width / columns, size.height / rows)) {
          notes.add(
            `A ${bleed} pt overlap is as wide as the tiles themselves at ${columns} × ${rows} on this page, so tiles repeat the same strip. Lower the overlap or use more tiles.`,
          );
        }
        const tileWidth = size.width / columns;
        const tileHeight = size.height / rows;
        for (let row = 0; row < rows; row++) {
          for (let col = 0; col < columns; col++) {
            const newPage = target.addPage([tileWidth + bleed, tileHeight + bleed]);
            // Tiles are chosen in the *displayed* frame, then converted to the
            // page's own coordinates, so a rotated page splits the way it looks (E9).
            const region = displayRegion(page, {
              x: Math.max(0, col * tileWidth - (col > 0 ? bleed : 0)),
              y: Math.max(0, row * tileHeight - (row < rows - 1 ? bleed : 0)),
              width: Math.min(tileWidth + bleed, size.width - Math.max(0, col * tileWidth - (col > 0 ? bleed : 0))),
              height: Math.min(tileHeight + bleed, size.height - Math.max(0, row * tileHeight - (row < rows - 1 ? bleed : 0))),
            });
            await stamp(target, newPage, page, { x: 0, y: 0, width: tileWidth + bleed, height: tileHeight + bleed }, { region });
          }
        }
        context.progress((p + 1) / source.length, `Tiled page ${source[p] + 1}`);
      }
      if (target.getPageCount() > 500) {
        notes.add(`${target.getPageCount()} tiles is a lot of sheets — check the grid before printing.`);
      }
      noteMixedSizes('Posterizing', input.doc, source, notes);
      noteRebuildLoss('Posterizing', input.doc, source, notes);
      return pdfOut(
        target,
        notes,
        `Split ${pageCountLabel(source.length)} into ${columns * rows} tiles each — ${pageCountLabel(target.getPageCount())} total.`,
      );
    },
  },

  {
    id: 'divide-pages',
    name: 'Divide Pages',
    description: 'Cut every page in half, into thirds, or into a grid',
    icon: '➗',
    category: 'organize',
    keywords: ['split page', 'halve', 'crop regions', 'cut'],
    outputSuffix: '_divided.pdf',
    actionLabel: 'Divide',
    promise: 'A new PDF where each page is cut into halves, thirds or a grid, one piece per page.',
    notes: [FLATTEN_NOTE],
    fields: [
      {
        key: 'axis',
        label: 'Direction',
        type: 'segmented',
        default: 'vertical',
        group: 'Cut',
        options: [
          { value: 'vertical', label: 'Vertically (left/right)' },
          { value: 'horizontal', label: 'Horizontally (top/bottom)' },
          { value: 'grid', label: 'Grid' },
        ],
        help: 'Measured as the page is displayed, so a rotated page is cut along the line you see.',
      },
      { key: 'parts', label: 'Number of parts', type: 'number', default: 2, min: 2, max: 9, step: 1, integer: true, group: 'Cut', when: (v) => v.axis !== 'grid', help: 'How many strips the page is cut into along the chosen direction.' },
      { key: 'columns', label: 'Columns', type: 'number', default: 2, min: 1, max: 9, step: 1, integer: true, half: true, group: 'Cut', when: (v) => v.axis === 'grid', help: 'Cells across the page in grid mode.' },
      { key: 'rows', label: 'Rows', type: 'number', default: 2, min: 1, max: 9, step: 1, integer: true, half: true, group: 'Cut', when: (v) => v.axis === 'grid', help: 'Cells down the page in grid mode.' },
      ALL_PAGES,
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const notes = createNotes();
      const axis = stringValue(context.values, 'axis', 'vertical');
      const parts = numberOf(context.values, { ...TILES, key: 'parts', label: 'Number of parts', default: 2, min: 2 }, notes);
      const columns = axis === 'grid'
        ? numberOf(context.values, { ...TILES, key: 'columns', label: 'Columns' }, notes)
        : axisParts(axis, parts, 'vertical');
      const rows = axis === 'grid'
        ? numberOf(context.values, { ...TILES, key: 'rows', label: 'Rows' }, notes)
        : axisParts(axis, parts, 'horizontal');
      if (columns === 1 && rows === 1) {
        notes.add('One column and one row copies each page instead of dividing it — set at least two parts.');
      }
      const source = selection(context.values, input.pageCount, { fallback: 'all', verb: 'divide' });
      const target = await newPDF();
      let produced = 0;
      for (const index of source) {
        throwIfAborted(context.signal);
        const page = input.doc.getPage(index);
        // Cut in the displayed frame (E8/E9): the previous version used the raw
        // MediaBox, so a `/Rotate 90` page split along the wrong axis and a
        // cropped page lost its offset.
        const size = visibleBox(page);
        const tileWidth = size.width / columns;
        const tileHeight = size.height / rows;
        for (let row = 0; row < rows; row++) {
          for (let col = 0; col < columns; col++) {
            const newPage = target.addPage([tileWidth, tileHeight]);
            const region = displayRegion(page, { x: col * tileWidth, y: row * tileHeight, width: tileWidth, height: tileHeight });
            const ok = await stamp(target, newPage, page, { x: 0, y: 0, width: tileWidth, height: tileHeight }, { region });
            produced += ok ? 1 : 0;
            if (!ok) notes.add(`A page had no drawable content, so ${pageCountLabel(source.length * columns * rows - produced)} of the planned pieces are missing from the output.`);
          }
        }
        context.progress(produced / (source.length * columns * rows || 1), `Page ${index + 1}`);
      }
      if (produced === 0) {
        throw new ToolInputError('NO_PAGES', 'Dividing these pages produced nothing.', {
          hint: 'The pages have no visible content; try "Extract Pages" instead.',
        });
      }
      noteRebuildLoss('Dividing', input.doc, source, notes);
      return pdfOut(target, notes, `Divided ${pageCountLabel(source.length)} into ${pageCountLabel(produced)}.`);
    },
  },

  {
    id: 'fix-page-size',
    name: 'Fix Page Size',
    description: 'Standardise every page to one size and orientation',
    icon: '📐',
    category: 'organize',
    keywords: ['uniform', 'normalise', 'resize', 'same size', 'a4'],
    outputSuffix: '_resized.pdf',
    actionLabel: 'Resize pages',
    promise: 'A PDF where every sheet is the size you chose, with each page scaled and positioned the way you set.',
    notes: [FLATTEN_NOTE],
    fields: [
      {
        key: 'size',
        label: 'Target size',
        type: 'select',
        default: 'most-common',
        group: 'Target',
        options: [
          { value: 'most-common', label: 'Most common size in this file' },
          { value: 'largest', label: 'Largest page in this file' },
          ...PAGE_SIZE_OPTIONS.slice(1),
        ],
      help: 'Most common keeps the file as it already is and fixes the odd pages out; largest avoids shrinking anything.',
    },
      {
        key: 'orientation',
        label: 'Orientation',
        type: 'select',
        default: 'keep',
        group: 'Target',
        options: [
          { value: 'keep', label: 'Keep each page’s own' },
          { value: 'portrait', label: 'Force portrait' },
          { value: 'landscape', label: 'Force landscape' },
        ],
      help: 'Force turns every sheet the same way, which re-frames pages that were scanned the other way up.',
    },
      {
        key: 'fit',
        label: 'Scaling',
        type: 'select',
        default: 'contain',
        group: 'Scaling',
        options: [
          { value: 'contain', label: 'Fit inside (letterbox)' },
          { value: 'cover', label: 'Fill the page (may crop)' },
          { value: 'stretch', label: 'Stretch to exactly fit' },
        ],
      help: 'Fit inside leaves margins and keeps everything; fill crops what will not fit; stretch changes the proportions.',
    },
      ALL_PAGES,
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const notes = createNotes();
      const sizeMode = stringValue(context.values, 'size', 'most-common');
      const orientation = stringValue(context.values, 'orientation', 'keep');
      const fit = stringValue(context.values, 'fit', 'contain');
      const source = selection(context.values, input.pageCount, { fallback: 'all', verb: 'resize' });
      const boxes = source.map((index) => visibleBox(input.doc.getPage(index)));
      let base: [number, number];
      if (sizeMode === 'most-common') base = modalSize(boxes);
      else if (sizeMode === 'largest') base = [Math.max(...boxes.map((b) => b.width)), Math.max(...boxes.map((b) => b.height))];
      else base = resolvePageSize(sizeMode);
      const target = await newPDF();
      let cropped = 0;
      let stretched = 0;
      let worstLoss = 0;
      for (let i = 0; i < source.length; i++) {
        throwIfAborted(context.signal);
        const pageBox = boxes[i];
        let [width, height] = base;
        if (orientation === 'portrait' && width > height) [width, height] = [height, width];
        if (orientation === 'landscape' && height > width) [width, height] = [height, width];
        const page = target.addPage([width, height]);
        const uniform =
          fit === 'cover'
            ? Math.max(width / pageBox.width, height / pageBox.height)
            : Math.min(width / pageBox.width, height / pageBox.height);
        const xScale = fit === 'stretch' ? width / pageBox.width : uniform;
        const yScale = fit === 'stretch' ? height / pageBox.height : uniform;
        // The source is drawn through `stamp`, which applies the page's own
        // /Rotate — scaling a `/Rotate 90` page by its stored box instead would
        // swap the axes and spill the content off the sheet (E9).
        const ok = await stamp(target, page, input.doc.getPage(source[i]), {
          x: (width - pageBox.width * xScale) / 2,
          y: (height - pageBox.height * yScale) / 2,
          width: pageBox.width * xScale,
          height: pageBox.height * yScale,
        });
        if (!ok) notes.add('A page had no content to draw, so its new sheet is blank.');
        if (fit === 'cover') {
          const loss = 1 - (pageBox.width * pageBox.height) / (width * height);
          if (loss > 0.005) {
            cropped += 1;
            worstLoss = Math.max(worstLoss, loss);
          }
        }
        if (fit === 'stretch' && Math.abs(xScale - yScale) > 0.01) stretched += 1;
        context.progress((i + 1) / source.length, `Page ${source[i] + 1}`);
      }
      const already = boxes.filter((b) => Math.abs(b.width - base[0]) <= 1 && Math.abs(b.height - base[1]) <= 1).length;
      if (already === source.length) {
        notes.add(`Every selected page is already ${Math.round(base[0])} × ${Math.round(base[1])} pt, so only the rebuild changed.`);
      }
      if (cropped > 0) {
        notes.add(`"Fill the page" runs content off the edge on ${pageCountLabel(cropped)} — up to ${Math.round(worstLoss * 100)}% of the sheet. Choose "Fit inside" to keep all of it.`);
      }
      if (stretched > 0) {
        notes.add(`"Stretch to exactly fit" changed the aspect ratio of ${pageCountLabel(stretched)}; circles become ovals.`);
      }
      noteRebuildLoss('Resizing', input.doc, source, notes);
      return pdfOut(
        target,
        notes,
        `${already === source.length ? 'Every page already matched' : `Normalised ${pageCountLabel(source.length - already)} to`} ${Math.round(base[0])} × ${Math.round(base[1])} pt (${(base[0] * 25.4 / 72).toFixed(0)} × ${(base[1] * 25.4 / 72).toFixed(0)} mm).`,
      );
    },
  },

  {
    id: 'remove-blank-pages',
    name: 'Remove Blank Pages',
    description: 'Detect and delete pages that contain no ink, text or images',
    icon: '🧹',
    category: 'organize',
    keywords: ['empty', 'scrub', 'clean', 'detect'],
    outputSuffix: '_no_blanks.pdf',
    actionLabel: 'Remove blanks',
    promise: 'Your PDF with the pages that paint nothing deleted, and a list of which ones went.',
    notes: [
      'Detection reads each page’s display list, so a scanned image or a signature counts as ink.',
    ],
    fields: [
      {
        key: 'keepAnnotated',
        label: 'Keep pages that only hold annotations',
        type: 'toggle',
        default: true,
        group: 'Detection',
        help: 'A page carrying a link, a form field or a stamp is kept even when nothing prints on it.',
      },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const notes = createNotes();
      const { session } = await withRender(input, context);
      try {
        const found = await findBlankPages(
          session,
          input.doc,
          { keepAnnotated: booleanValue(context.values, 'keepAnnotated', true) },
          (done, total) => context.progress((done / total) * 0.8, `Scanning page ${done} of ${total}`),
          () => context.signal.aborted,
        );
        // A cancelled scan returns a partial list; deleting on the strength of
        // it would drop the wrong pages (E19).
        throwIfAborted(context.signal);
        const blank = found.blank;
        const keep = resolvePages('all', input.pageCount).filter((p) => !blank.includes(p + 1));
        const ocrOnly = found.profiles.filter((profile) => profile.blankByAppearance && profile.invisibleTextItems > 0);
        if (ocrOnly.length > 0) {
          notes.add(
            `${pageCountLabel(ocrOnly.length)} (${formatPages(ocrOnly.map((profile) => profile.page - 1))}) hold only invisible OCR text — they look blank but are searchable, and were treated as blank.`,
          );
        }
        if (blank.length === 0) {
          const doc = await savable(input, notes);
          return pdfOut(
            doc,
            notes,
            `No blank pages were found in ${pageCountLabel(input.pageCount)} — nothing was removed.`,
          );
        }
        if (keep.length === 0) {
          throw new ToolInputError(
            'NO_PAGES',
            `All ${pageCountLabel(input.pageCount)} look blank, and deleting every one would leave an empty PDF.`,
            { hint: 'Keep the pages, or use "Extract Pages" to pull out the ones that have content.' },
          );
        }
        const doc = await collectPages([{ doc: input.doc, pages: keep }]);
        return pdfOut(
          doc.doc,
          notes,
          `Removed ${pageCountLabel(blank.length)} (${formatPages(blank.map((b) => b - 1))}), kept ${pageCountLabel(keep.length)}.`,
        );
      } finally {
        await session.destroy();
      }
    },
  },

  {
    id: 'pdfs-to-zip',
    name: 'PDFs to ZIP',
    description: 'Package several PDFs into one archive',
    icon: '🗜️',
    category: 'organize',
    keywords: ['archive', 'bundle', 'compress container'],
    multiFile: true,
    minFiles: 1,
    surface: 'none',
    outputSuffix: '.zip',
    actionLabel: 'Pack ZIP',
    promise: 'One ZIP archive holding every file byte-for-byte, with a text manifest of what is inside unless you switch it off.',
    notes: [
      'Files are stored byte-for-byte: this is a container, not a compressor, and a password-protected PDF stays protected inside it.',
    ],
    fields: [
      {
        key: 'includeReport',
        label: 'Add a text manifest of the contents',
        type: 'toggle',
        default: true,
        group: 'Archive',
      help: 'A short manifest of the files, their sizes and page counts, so an archive can be checked without opening it.',
    },
    ],
    validate: (_v, { fileCount }) => (fileCount < 1 ? 'Add at least one PDF.' : null),
    async run(context) {
      const inputs = await openInputs(context);
      const notes = createNotes();
      if (inputs.length === 1) {
        notes.add('You packed a single PDF — the archive is the same file plus a manifest.');
      }
      const protectedFiles = inputs.filter((input) => input.inspection?.encrypted);
      if (protectedFiles.length > 0) {
        const names = protectedFiles.map((input) => `"${input.name}"`).join(', ');
        notes.add(
          `Every file is stored byte-for-byte, so ${names} ${protectedFiles.length === 1 ? 'is' : 'are'} still password protected inside the archive. Unlock them first if the archive is for someone without the password.`,
        );
      }
      const used = new Set<string>();
      const entries = [];
      const stem = safeStem(inputs[0].name);
      for (const input of inputs) {
        throwIfAborted(context.signal);
        const leaf = (input.name.split(/[\\/]/).pop() ?? input.name).trim() || 'document.pdf';
        const name = uniqueNameIn(used, /\.pdf$/i.test(leaf) ? leaf : `${leaf}.pdf`);
        if (name !== leaf) notes.add(`Two files share the name "${leaf}"; the second was stored as "${name}".`);
        entries.push({ name, data: input.bytes.slice() });
      }
      const total = inputs.reduce((sum, input) => sum + input.bytes.length, 0);
      if (booleanValue(context.values, 'includeReport', true)) {
        const manifest = [
          'BrowserSnip archive',
          `Created ${new Date().toISOString()}`,
          '',
          ...inputs.map(
            (input, i) => `${i + 1}. ${input.name} — ${pageCountLabel(input.pageCount)} — ${describeSize(input.bytes)}`,
          ),
          '',
          `${pageCountLabel(inputs.reduce((sum, input) => sum + input.pageCount, 0))} in ${inputs.length} files, ${describeSize(total)} before compression.`,
        ].join('\n');
        entries.push({ name: 'manifest.txt', data: manifest });
      }
      const blob = await createZip(entries, {
        compression: 'DEFLATE',
        onProgress: (name, done, total2) => context.progress(done / total2, `Adding ${name}`),
      });
      if (blob.size >= total) {
        notes.add(`The archive (${describeSize(blob.size)}) is no smaller than the files (${describeSize(total)}): PDFs are already compressed.`);
      }
      return filesOut(
        [{ blob, name: uniqueName(new Set([`${stem}-bundle.zip`]), `${stem}-bundle.zip`) }],
        notes,
        `Packed ${inputs.length} PDFs (${describeSize(total)}) into one ZIP.`,
      );
    },
  },

  {
    id: 'pdf-to-cbz',
    name: 'PDF to CBZ',
    description: 'Turn a comic or scan into a CBZ archive for comic readers',
    icon: '📚',
    category: 'organize',
    keywords: ['comic', 'cbz', 'manga reader'],
    surface: 'none',
    outputSuffix: '.cbz',
    actionLabel: 'Make CBZ',
    promise: 'A comic-book archive: every page rendered to an image, numbered in reading order.',
    notes: [
      'A CBZ is a ZIP archive of page images: comic readers open it directly, and nothing in it is selectable or searchable.',
    ],
    fields: [
      {
        key: 'format',
        label: 'File format',
        type: 'segmented',
        default: 'jpg',
        group: 'Images',
        options: [
          { value: 'jpg', label: 'JPG' },
          { value: 'png', label: 'PNG' },
        ],
      help: 'PNG keeps line art and speech bubbles crisp at the cost of a much bigger archive; JPG is what most comic readers expect.',
    },
      DPI,
      ALL_PAGES,
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const notes = createNotes();
      const dpi = numberOf(context.values, DPI, notes);
      const pages = selection(context.values, input.pageCount, { fallback: 'all', verb: 'convert' });
      // A rough uncompressed pixel budget: this tab holds every rasterised page
      // in memory before the archive is written (E7, E12).
      const boxes = pages.map((index) => visibleBox(input.doc.getPage(index)));
      const pixels = boxes.reduce((sum, box) => sum + (box.width * dpi / 72) * (box.height * dpi / 72), 0);
      const estimate = pixels * 3;
      if (estimate > 400 * 1024 * 1024) {
        notes.add(
          `${pageCountLabel(pages.length)} at ${dpi} dpi is roughly ${describeSize(estimate)} of pixels in this tab. Lower the resolution, or convert in smaller page ranges.`,
        );
      }
      const { session } = await withRender(input, context);
      try {
        const { rasterizePages } = await import('../core/render');
        const format = stringValue(context.values, 'format', 'jpg') === 'png' ? 'png' : 'jpeg';
        const rendered = await rasterizePages(session, {
          format,
          scale: dpi / 72,
          onProgress: (done, total) => context.progress(done / total, `Rendered page ${done}`),
        });
        if (rendered.length === 0) {
          throw new ToolInputError('NO_PAGES', 'No page could be rendered.', {
            hint: 'Try a lower resolution, or check the file with a repair tool.',
          });
        }
        const stem = safeStem(input.name);
        const width = String(rendered.length).length;
        const blob = await createZip(
          rendered.map((page, i) => ({
            name: `${stem}/${String(i + 1).padStart(Math.max(3, width), '0')}.${page.name.split('.').pop()}`,
            data: page.blob,
            store: format === 'png',
          })),
          { compression: format === 'png' ? 'STORE' : 'DEFLATE' },
        );
        if (pages.length !== input.pageCount) {
          notes.add(`Only the ${pageCountLabel(pages.length)} you selected were rendered; the archive has ${pageCountLabel(rendered.length)}.`);
        }
        const raw = rendered.reduce((sum, page) => sum + page.blob.size, 0);
        if (blob.size >= raw) {
          notes.add(`The archive (${describeSize(blob.size)}) is not smaller than the images (${describeSize(raw)}).`);
        }
        return filesOut(
          [{ blob, name: `${stem}.cbz` }],
          notes,
          `${pageCountLabel(rendered.length)} rendered at ${dpi} dpi into ${describeSize(blob.size)}.`,
        );
      } finally {
        await session.destroy();
      }
    },
  },
];

/* ── helpers shared by this group ─────────────────────────────────────────── */

const OFFSET: ToolField = {
  key: 'offset',
  label: 'Back-side page offset',
  type: 'number',
  default: 0,
  min: 0,
  max: 500,
  step: 1,
  integer: true,
};

const TILES: ToolField = {
  key: 'columns',
  label: 'Tiles',
  type: 'number',
  default: 2,
  min: 1,
  max: 12,
  step: 1,
  integer: true,
};

/** Files added twice by accident (E16) — kept, because a repeat is work. */
function noteRepeated(inputs: OpenedInput[], notes: Notes): void {
  const seen = new Map<string, number>();
  for (const input of inputs) {
    const key = `${input.name}:${input.bytes.length}`;
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count === 2) {
      notes.add(
        `"${input.name}" appears twice in the queue, so its ${pageCountLabel(input.pageCount)} are used twice. Remove the repeat if that is not what you meant.`,
      );
    }
  }
}

/** `used` variant for arbitrary extensions (the ZIP entry names). */
function uniqueNameIn(used: Set<string>, name: string): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let n = 2;
  while (used.has(`${stem}-${n}${ext}`)) n += 1;
  const candidate = `${stem}-${n}${ext}`;
  used.add(candidate);
  return candidate;
}

/** 90° and 270° are turns; 0/180/360 are not. Used to report a snapped angle. */
function normalise180(degrees: number): number {
  return ((Math.round(degrees / 180) * 180) % 360 + 360) % 360;
}

/**
 * Where a blank sheet goes for the chosen position, as a 0-based insert index.
 * `after` the last page appends; `before` page 1 prepends.
 */
function insertPosition(position: string, pageCount: number, anchor: number): number {
  if (position === 'start') return 0;
  if (position === 'end') return pageCount;
  if (position === 'after') return Math.min(pageCount, anchor);
  return Math.max(0, anchor - 1);
}

/** Which stamp page serves base page `index` (0-based, in both documents). */
function stampPageIndex(mapping: string, index: number, stampTotal: number): number {
  if (mapping === 'first') return 0;
  if (mapping === 'last') return Math.max(0, stampTotal - 1);
  return Math.min(index, Math.max(0, stampTotal - 1));
}

/** One axis of a cut becomes columns or rows depending on the direction. */
function axisParts(axis: string, parts: number, along: 'vertical' | 'horizontal'): number {
  return axis === along ? parts : 1;
}

/** Rebuild a document as `count` blank sheets of `size`, then stamp sources. */
async function sheetDocument(
  source: PDFDocument,
  size: [number, number],
  cells: { sheet: number; cell: number; page: number }[],
  cellsPerSheet: number,
  cellBox: (cell: number) => Box,
  notes: Notes,
): Promise<PDFDocument> {
  const sheetCount = Math.max(1, Math.ceil(cells.length / cellsPerSheet));
  const target = await newPDF();
  const blank = new Array(sheetCount).fill(0).map(() => target.addPage(size));
  let missing = 0;
  for (const item of cells) {
    const page = blank[item.sheet];
    if (!page) continue;
    if (item.page < 0 || item.page >= source.getPageCount()) {
      missing += 1;
      continue;
    }
    const ok = await stamp(target, page, source.getPage(item.page), cellBox(item.cell));
    if (!ok) missing += 1;
  }
  if (missing > 0) {
    notes.add(`${pageCountLabel(missing)} of the planned cells stayed blank: the source page was empty or had no content to draw.`);
  }
  return target;
}

function gridBox(
  sheetWidth: number,
  sheetHeight: number,
  columns: number,
  rows: number,
  gutter: number,
  margin: number,
) {
  const usableWidth = sheetWidth - margin * 2 - gutter * (columns - 1);
  const usableHeight = sheetHeight - margin * 2 - gutter * (rows - 1);
  const cellWidth = usableWidth / columns;
  const cellHeight = usableHeight / rows;
  return (cell: number) => {
    const col = cell % columns;
    const row = Math.floor(cell / columns);
    return {
      x: margin + col * (cellWidth + gutter),
      // Rows are laid out top-down in the UI, but PDF y grows upward.
      y: sheetHeight - margin - (row + 1) * cellHeight - row * gutter,
      width: cellWidth,
      height: cellHeight,
    };
  };
}

/**
 * Draw a stamp *behind* a page's own content.
 *
 * `pdf-lib` appends new operators into the page's last content stream, which is
 * the topmost thing drawn, so there is nothing to re-order afterwards. The page
 * is snapshotted as a form XObject, its content is cleared, the stamp is drawn,
 * and the snapshot goes back on top. The page object itself survives, so its
 * `/Rotate`, crop box and annotations keep working (E9).
 */
async function stampBehind(
  target: PDFDocument,
  page: PDFPage,
  draw: () => Promise<boolean>,
): Promise<boolean> {
  const media = mediaBox(page);
  let snapshot: PDFEmbeddedPage | null = null;
  try {
    snapshot = await target.embedPage(page, {
      left: media.x,
      bottom: media.y,
      right: media.x + media.width,
      top: media.y + media.height,
    });
  } catch {
    // A page with no content stream: an underlay on it is just the stamp.
    snapshot = null;
  }
  page.node.set(PDFName.of('Contents'), target.context.obj([]) as PDFArray);
  const drew = await draw();
  if (snapshot) page.drawPage(snapshot, { x: media.x, y: media.y, xScale: 1, yScale: 1 });
  return drew;
}

/**
 * Write a flat bookmark tree directly into `/Outlines`.
 *
 * The pdf-lib fork this app uses exposes no outline API, and merging only
 * needs top-level entries, so they are written here. Full outline editing
 * (nested trees, import/export, round-tripping foreign documents) lives in
 * `core/bookmarks`.
 */
function writeFlatOutline(
  doc: PDFDocument,
  marks: { title: string; page: number }[],
): number {
  if (marks.length === 0) return 0;
  const context = doc.context;
  const pages = doc.getPages();
  const outlines = context.obj({ Type: 'Outlines' }) as PDFDict;
  const outlinesRef = context.register(outlines);

  let firstRef: PDFRef | null = null;
  let previousRef: PDFRef | null = null;
  let written = 0;

  for (const mark of marks) {
    const page = pages[mark.page];
    if (!page) continue;
    // `/Title` must be a text string, not a name. `context.obj` turns a plain
    // JS string into a PDFName, so the hex string is built explicitly — that
    // also keeps non-ASCII filenames intact via a UTF-16BE byte-order mark.
    const item = context.obj({
      Title: PDFHexString.fromText(mark.title),
      Parent: outlinesRef,
      Dest: [page.ref, PDFName.of('Fit')],
    }) as PDFDict;
    const itemRef = context.register(item);
    if (previousRef) {
      item.set(PDFName.of('Prev'), previousRef);
      context.lookup(previousRef, PDFDict)?.set(PDFName.of('Next'), itemRef);
    } else {
      firstRef = itemRef;
    }
    previousRef = itemRef;
    written += 1;
  }
  if (!firstRef || !previousRef || written === 0) return 0;
  outlines.set(PDFName.of('First'), firstRef);
  outlines.set(PDFName.of('Last'), previousRef);
  outlines.set(PDFName.of('Count'), context.obj(written));
  doc.catalog.set(PDFName.of('Outlines'), outlinesRef);
  return written;
}

async function cloneForOutput(doc: PDFDocument): Promise<PDFDocument> {
  const bytes = await savePDF(doc, { useObjectStreams: false });
  // The round-trip is also what drops `/Encrypt`: a document loaded with a
  // password keeps its encryption dictionary on save (E5).
  return openPDF(bytes, { ignoreEncryption: true });
}

interface PlanItem { page: number; rotate: number | null; blank: boolean }

/**
 * The plan, whichever shape the surface handed over: the page grid's 0-based
 * index array, a typed `pageOrder` string, or nothing (the document as it is).
 */
function planFromValues(raw: unknown, total: number, notes: Notes): PlanItem[] {
  if (Array.isArray(raw)) return planFromIndices(raw, total);
  const spec = typeof raw === 'string' ? raw.trim() : '';
  return spec === '' ? defaultPlan(total) : parsePlan(spec, total, notes);
}

function defaultPlan(total: number): PlanItem[] {
  return Array.from({ length: total }, (_, i) => ({ page: i, rotate: null, blank: false }));
}

/**
 * The page grid's legacy value shape: 0-based source indices.
 *
 * `PageOrganizer` writes the string grammar below; the older `OrganizeMain`
 * pane writes an array. Both mean the same plan, and an array that is silently
 * ignored would reorder nothing.
 */
function planFromIndices(raw: unknown[], total: number): PlanItem[] {
  const plan: PlanItem[] = [];
  for (const value of raw) {
    if (value === -1) {
      plan.push({ page: -1, rotate: null, blank: true });
      continue;
    }
    const index = Number(value);
    if (!Number.isInteger(index) || index < 0 || index >= total) {
      throw new ToolInputError(
        'OUT_OF_RANGE',
        `Page index ${String(value)} is outside this document of ${pageCountLabel(total)}.`,
        { hint: `Valid positions are 0 to ${total - 1} for this grid.` },
      );
    }
    plan.push({ page: index, rotate: null, blank: false });
  }
  if (plan.length === 0) {
    throw new ToolInputError('NO_PAGES', 'The page order is empty.', {
      hint: 'Drag at least one page into the grid, or type 1,2,3.',
    });
  }
  return plan;
}

/**
 * Parse the plan grammar the page grid writes: `3`, `3r90`, `2-5`, `blank`.
 *
 * A page outside the document is refused with the real page count (E6), and an
 * inverted range says which way round it should be.
 */
function parsePlan(spec: string, total: number, notes: Notes): PlanItem[] {
  const out: PlanItem[] = [];
  for (const raw of spec.split(/[,\s]+/)) {
    const token = raw.trim();
    if (!token) continue;
    if (/^blank$/i.test(token)) {
      out.push({ page: -1, rotate: null, blank: true });
      continue;
    }
    const fromOtherFile = /^f(\d+):/i.exec(token);
    if (fromOtherFile) {
      throw new ToolInputError(
        'UNSUPPORTED',
        `"${token}" refers to page ${token.split(':')[1]} of file ${fromOtherFile[1]}, but organizing works on one document at a time.`,
        { hint: 'Merge the files first, or drop back to the single-document plan.' },
      );
    }
    const match = /^(\d+)(?:-(\d+))?(?:r(\d{1,3}))?$/i.exec(token);
    if (!match) {
      throw new ToolInputError('OUT_OF_RANGE', `"${token}" is not a page token.`, {
        hint: 'Use 3, 3r90, 2-5 or blank.',
      });
    }
    const first = Number(match[1]);
    const last = match[2] === undefined ? first : Number(match[2]);
    for (const page of [first, last]) {
      if (page === 0) {
        throw new ToolInputError('OUT_OF_RANGE', `Page 0 does not exist — pages are numbered from 1.`, {
          hint: `This document has ${pageCountLabel(total)}.`,
        });
      }
      if (page > total) {
        throw new ToolInputError(
          'OUT_OF_RANGE',
          `"${token}" refers to page ${page}, but this document has ${pageCountLabel(total)}.`,
          { hint: `Re-order within 1-${total}, or remove the token.` },
        );
      }
    }
    if (last < first) {
      throw new ToolInputError('OUT_OF_RANGE', `"${token}" runs backwards — page ${first} comes after page ${last}.`, {
        hint: `Write ${last}-${first} to go forwards, or ${first}-${last}r0.`,
      });
    }
    const rotate = match[3] === undefined ? null : normaliseRotation(Number(match[3]));
    if (match[3] !== undefined && Number(match[3]) % 90 !== 0) {
      notes.add(`r${match[3]} is not a quarter turn: a stored /Rotate must be 0, 90, 180 or 270, so those pages were turned to ${rotate}° instead.`);
    }
    for (let page = first; page <= last; page++) {
      out.push({ page: page - 1, rotate, blank: false });
    }
  }
  if (out.length === 0) {
    throw new ToolInputError('NO_PAGES', 'The page order was empty.', {
      hint: `List at least one page between 1 and ${total}, or "blank".`,
    });
  }
  return out;
}

function gridFor(perSheet: number): [number, number] {
  if (perSheet <= 1) return [1, 1];
  if (perSheet === 2) return [2, 1];
  if (perSheet === 4) return [2, 2];
  if (perSheet === 6) return [3, 2];
  if (perSheet === 9) return [3, 3];
  const columns = Math.ceil(Math.sqrt(perSheet));
  return [columns, Math.ceil(perSheet / columns)];
}

function modalSize(sizes: { width: number; height: number }[]): [number, number] {
  const counts = new Map<string, { size: [number, number]; n: number }>();
  for (const size of sizes) {
    const key = `${Math.round(size.width)}x${Math.round(size.height)}`;
    const found = counts.get(key);
    if (found) found.n += 1;
    else counts.set(key, { size: [size.width, size.height], n: 1 });
  }
  let best: [number, number] = [
    sizes[0]?.width ?? PAGE_SIZES.a4[0],
    sizes[0]?.height ?? PAGE_SIZES.a4[1],
  ];
  let bestCount = -1;
  for (const entry of counts.values()) {
    if (entry.n > bestCount) {
      bestCount = entry.n;
      best = entry.size;
    }
  }
  return best;
}
