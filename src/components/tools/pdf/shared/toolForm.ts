/**
 * Pure logic behind the tool rail.
 *
 * No React here, so the validity rules, the group ordering and the verb table
 * can be unit-tested — and reused by bespoke surfaces — without rendering.
 *
 * What a value is *allowed* to be is decided by `core/guard.ts` (A1); this
 * module only adapts those answers into per-field messages the rail can print
 * beside the input that caused them.
 */
import { clampFields, validateFields } from '@/lib/pdf/core/guard';
import type { ToolPhase } from '@/stores/process-store';
import type {
  PdfToolCategory,
  PdfToolDefinition,
  ToolField,
  ToolValues,
} from '@/lib/pdf/tools/types';

/** A definition may name its own "what you get" line; the rail falls back per category. */
/** `promise` and the field bounds moved onto `PdfToolDefinition` / `ToolField`
 * when the guard layer landed, so the rail reads the same type the registry
 * writes. This alias only names the role the component plays. */
export type PanelTool = PdfToolDefinition;

export interface FieldCheck {
  /** Values after clamping — what the tool is actually given. */
  values: ToolValues;
  /** Blocking messages, keyed by field key. */
  issues: Record<string, string>;
  /** Non-blocking messages: the value was changed to something usable (E15). */
  notices: Record<string, string>;
}

export interface FieldCheckContext {
  /** Page count of the loaded document, when known — enables E6 range checks. */
  pageCount?: number | null;
}

/**
 * Validate and clamp a form bag in one pass.
 *
 * Clamping runs first so an out-of-range number becomes a notice ("we set it to
 * 300") rather than a dead end; whatever is left is genuinely unusable and is
 * reported as an issue that keeps the primary action off.
 */
export function checkFields(
  fields: readonly ToolField[] | undefined,
  values: ToolValues,
  context: FieldCheckContext = {},
): FieldCheck {
  const clamped = clampFields(fields, values);

  const bag: ToolValues = { ...clamped.values };
  // `guard` reads the document size out of the bag to reject page 9 of a 3-page
  // file; it is validation context, not a tool parameter.
  if (typeof context.pageCount === 'number' && context.pageCount > 0) bag.pageTotal = context.pageCount;

  const notices: Record<string, string> = {};
  const issues: Record<string, string> = {};
  for (const change of clamped.changes) notices[change.key] = change.message;

  for (const issue of validateFields(fields, bag)) {
    issues[issue.key] = issue.message;
  }
  return { values: clamped.values, issues, notices };
}

export interface FieldGroup {
  title: string;
  fields: ToolField[];
}

/** Group fields under their `group` heading, in first-appearance order. */
export function groupFields(fields: ToolField[] = []): FieldGroup[] {
  const groups: FieldGroup[] = [];
  const byTitle = new Map<string, FieldGroup>();
  for (const field of fields) {
    const title = field.group ?? '';
    let group = byTitle.get(title);
    if (!group) {
      group = { title, fields: [] };
      byTitle.set(title, group);
      groups.push(group);
    }
    group.fields.push(field);
  }
  return groups;
}

/**
 * Action verbs per capability.
 *
 * A generic "Run" told the user nothing. The id map covers techniques whose
 * names are not verbs ("Posterize PDF" would otherwise read as a conversion);
 * the pattern table handles the rest, first hit wins, so specific rules come
 * before general ones.
 */
const VERB_TABLE: [RegExp, string][] = [
  [/unlock|decrypt|remove-(password|protection|restrictions)/, 'Unlock'],
  [/encrypt|protect|permission|restrict|certif/, 'Protect'],
  [/merge|combine|append|assemble/, 'Merge'],
  [/zip|archive|bundle/, 'Zip'],
  [/split|burst|separate|stitch/, 'Split'],
  [/extract/, 'Extract'],
  [/delete|remove|omit/, 'Remove'],
  [/reorder|organize|arrange|shuffle|move/, 'Save order'],
  [/rotate/, 'Rotate'],
  [/crop|trim|guides/, 'Crop'],
  [/page-number|bates|number/, 'Add numbers'],
  [/watermark/, 'Add watermark'],
  [/stamp/, 'Add stamp'],
  [/header|footer/, 'Add'],
  [/sign|signature|initials/, 'Sign'],
  [/redact|sanitis|blur/, 'Redact'],
  [/flatten/, 'Flatten'],
  [/compress|optimi[sz]|reduce|shrink|lineariz|downsample/, 'Compress'],
  [/repair|recover|fix/, 'Repair'],
  [/compare|diff/, 'Compare'],
  [/ocr|recogni[sz]|searchable/, 'Run OCR'],
  [/metadata/, 'Save metadata'],
  [/bookmark|outline|table-of-contents|toc/, 'Save bookmarks'],
  [/form/, 'Save form'],
  [/(^|[^a-z0-9])(image|jpg|jpeg|png|webp|heic|bmp|tiff|tif|psd|svg|cbz|zip|txt|md|markdown|html|csv|json|xml|rtf|word|docx|excel|xlsx|powerpoint|pptx|epub|email|odt|ods|odp|xps|fb2|url|audio|font|office|text|scan|blank|file)-to-pdf|to-pdf|create/, 'Create PDF'],
  [/pdf-to|to-(png|jpg|jpeg|webp|gif|tiff|txt|md|csv|json|xml|html|docx|xlsx|pptx|epub|svg|zip|audio|cbz|greyscale)|convert|export|import/, 'Convert'],
  [/annotate|highlight|pen|note|ink|edit|draw|insert|replace|text/, 'Apply'],
  [/rename|prefix|suffix/, 'Rename'],
];

const VERB_BY_ID: Record<string, string> = {
  'reverse-pages': 'Reverse',
  'add-blank-page': 'Add page',
  'duplex-collate': 'Collate',
  'overlay-pdf': 'Overlay',
  'n-up': 'Lay out',
  booklet: 'Build booklet',
  posterize: 'Posterize',
  'divide-pages': 'Divide',
  'rasterize-pdf': 'Rasterize',
  'sanitize-pdf': 'Sanitize',
  'deskew-pdf': 'Deskew',
  'add-page-labels': 'Add labels',
  'invert-colors': 'Invert',
  'adjust-colors': 'Adjust',
  'background-color': 'Set background',
  'text-color': 'Adjust',
  'scanner-effect': 'Apply effect',
  'pdf-layers': 'Edit layers',
  'digitize-document': 'Digitize',
  'prepare-pdf-for-ai': 'Prepare for AI',
  'page-dimensions': 'Report',
  'font-to-outline': 'Convert fonts',
  'pdf-to-pdfa': 'Convert to PDF/A',
  'timestamp-pdf': 'Timestamp',
  'add-attachments': 'Add attachments',
  'edit-attachments': 'Manage attachments',
  'extract-attachments': 'Extract attachments',
  'view-metadata': 'Show metadata',
};

/** The primary-action label for a tool: its own, else a verb for its job. */
export function verbFor(tool: PdfToolDefinition): string {
  const own = tool.actionLabel;
  if (typeof own === 'string' && own.trim() !== '') return own.trim();
  const byId = VERB_BY_ID[tool.id];
  if (byId) return byId;
  const haystack = `${tool.id} ${tool.name}`.toLowerCase();
  for (const [pattern, verb] of VERB_TABLE) {
    if (pattern.test(haystack)) return verb;
  }
  return 'Run';
}

const PROMISE_BY_CATEGORY: Record<PdfToolCategory, string> = {
  organize: 'Rebuilds a new PDF in the order you set — your file is never modified.',
  optimize: 'Rewrites the file smaller, and shows the exact size before and after.',
  'convert-to': 'Produces an editable PDF, entirely inside this browser tab.',
  'convert-from': 'Turns your file into a PDF, entirely inside this browser tab.',
  edit: 'Changes a copy and hands it back for download — the original stays intact.',
  security: 'Works on this device only: no upload, and the output is a separate file.',
};

/** One honest line about what pressing the primary action will produce. */
export function promiseFor(tool: PanelTool): string {
  const own = tool.promise;
  if (typeof own === 'string' && own.trim() !== '') return own.trim();
  return PROMISE_BY_CATEGORY[tool.category] ?? 'Runs on this device; the result is ready to download.';
}

export interface RunStatusInput {
  phase: ToolPhase;
  /** What the tool calls this job, e.g. `"Merge PDFs"`. */
  label: string;
  /** 0..100 for the whole job. */
  percent: number;
  /** The stage the runner named, if it named one. */
  message?: string | null;
  /** A cancel or a discarded late result; it outranks everything else. */
  notice?: string | null;
  /** Files the finished run produced. */
  outputs?: number;
}

/**
 * The one sentence the rail reads to its live region.
 *
 * Kept out of the component so the wording is testable, and so a screen-reader
 * user and a sighted user are told the same thing from the same source: a stage
 * name while there is one, "no time estimate yet" when there is no denominator,
 * and a number of files rather than a bare "Done" when the work is over.
 */
export function runStatusText(input: RunStatusInput): string {
  if (input.notice) return input.notice;
  const stage = input.message?.trim();
  switch (input.phase) {
    case 'running':
      // Percent 0 while running means the tool has not reported a denominator
      // yet; claiming "0%" would be a determinate bar built on nothing.
      if (!(input.percent > 0)) return `${stage || 'Working'} — no time estimate yet`;
      return `${stage || 'Working'} — ${Math.round(input.percent)}% of ${input.label || 'this run'}`;
    case 'done': {
      const count = input.outputs ?? 0;
      if (count > 1) return `Finished — ${count} files ready to download`;
      if (count === 1) return 'Finished — one file ready to download';
      return 'Finished — nothing to download, the answer is in the report';
    }
    default:
      // `error` already speaks through a `role="alert"` panel; repeating it here
      // would make assistive tech say the same failure twice.
      return '';
  }
}
