/**
 * Shared plumbing for tool implementations.
 *
 * Every tool repeats the same three steps — open the input(s) with the
 * password the gate collected, do the work, save — so they live here rather
 * than being copy-pasted into ninety modules. Opening is not a `pdf-lib` call:
 * it is `core/guard` deciding whether the bytes are an openable, unlocked, non-
 * empty PDF *before* a tool touches them, which is where the E1–E6 matrix is
 * enforced once instead of per tool.
 *
 * The guard's public surface is re-exported here so a tool module needs one
 * import; `core/guard` stays the definition of every behaviour.
 */
import type { PDFDocument, PDFPage } from '@maxwbh/pdf-lib';
import {
  collectPages,
  newPDF as createPdf,
  savePDF,
  saveEncrypted,
  rgb,
  type PasswordOptions,
} from '../core/doc';
import { resolvePages, resolvePageSet, type PageSpec } from '../core/pages';
import {
  ToolInputError,
  clampNumber,
  emptyFileError,
  looksLikePdf,
  notAPdfError,
  openPdfInput,
  type PdfInspection,
} from '../core/guard';
import { openRender, type PdfSession, type RenderMetadata } from '../core/render';
import type { ToolFile, ToolResult, ToolRunContext } from './types';

export {
  ToolInputError,
  clampFields,
  clampNumber,
  decodePermissions,
  describeSize,
  describeToolError,
  emptyFileError,
  expandPageRanges,
  fieldBounds,
  inspectPdf,
  isPasswordRequired,
  isToolInputError,
  looksLikePdf,
  notAPdfError,
  openPdfInput,
  pageRangeProblem,
  parsePageRanges,
  preflightPdf,
  TOOL_INPUT_ERROR_CODES,
  validateFields,
} from '../core/guard';
export type {
  FieldClamp,
  FieldIssue,
  PageRange,
  PdfInspection,
  PdfPermissions,
  ToolInputErrorCode,
} from '../core/guard';

export interface OpenedInput {
  doc: PDFDocument;
  bytes: Uint8Array;
  name: string;
  session?: PdfSession;
  pageCount: number;
  /** What the guard saw on the way in — encryption, permissions, damage (E3). */
  inspection?: PdfInspection;
}

export interface OpenInputsOptions {
  /** Overrides `context.password` (a tool that collects its own). */
  password?: string;
  /**
   * What to do when the identical file appears twice in the list (E16).
   * `skip` (the default) keeps the first copy and logs the rest, because a
   * merge that silently doubles a document is worse than a merge that says it
   * ignored a repeat. `keep` opens every entry.
   */
  duplicates?: 'skip' | 'keep';
}

/**
 * Open one document per input file, in the order the user supplied them.
 *
 * Every refusal is a `ToolInputError` naming the file, and a locked document
 * arrives as `PASSWORD_REQUIRED` / `BAD_PASSWORD` with `passwordRequired` set,
 * which is what the sidebar gate re-opens on. The old pipeline showed one
 * generic red banner with a pdf-lib stack trace instead.
 *
 * E16, multi-document half: listing the same file twice is what the user asked
 * for — merging `report.pdf` with itself makes a two-part document — so every
 * entry is opened by default. A tool that genuinely wants uniqueness passes
 * `{ duplicates: 'skip' }` and the dropped copies are logged, never swallowed.
 * A single-document tool refuses a repeat up-front instead — see `runPdfTool`.
 */
export async function openInputs(
  context: ToolRunContext,
  options: OpenInputsOptions = {},
): Promise<OpenedInput[]> {
  if (context.inputs.length === 0) {
    throw new ToolInputError('EMPTY_FILE', 'Add at least one file first.');
  }
  const password = options.password ?? context.password;
  const read = new Map<ToolFile, Uint8Array>();
  for (const file of context.inputs) {
    read.set(file, await file.bytes());
  }
  const bytesOf = (file: ToolFile): Uint8Array => read.get(file) ?? new Uint8Array(0);
  const { kept, dropped } =
    options.duplicates === 'skip'
      ? splitDuplicates(context.inputs, bytesOf, (file) => file.name)
      : { kept: context.inputs, dropped: [] as ToolFile[] };
  for (const file of dropped) {
    context.log(`Ignored the second copy of "${file.name}" — it is byte-identical to the first.`);
  }

  const out: OpenedInput[] = [];
  for (const file of kept) {
    const bytes = bytesOf(file);
    // The gate owns every refusal here, so a tool can assume it holds a real,
    // unlocked, non-empty document with at least one page.
    const opened = await openPdfInput(bytes, file.name, { password });
    if (opened.inspection.recovered) {
      // E3: recover, but never quietly — the run log says what was lost.
      context.log(`Recovered "${file.name}": ${opened.inspection.message}`);
    }
    out.push({
      doc: opened.doc,
      bytes,
      name: file.name,
      pageCount: opened.doc.getPageCount(),
      inspection: opened.inspection,
    });
    context.progress(0.05 * (out.length / kept.length), `Read ${file.name}`);
  }
  return out;
}

/** The first input, which is what single-document tools operate on. */
export async function openPrimary(
  context: ToolRunContext,
  options: OpenInputsOptions = {},
): Promise<OpenedInput> {
  const [first] = await openInputs(context, options);
  return first;
}

/**
 * Split a file list into the first copy of each document and the repeats.
 *
 * A repeat is the same name *and* the same bytes: two different files that
 * happen to share a name, or one file added under two names, are both real work
 * the user asked for (E16).
 */
export function splitDuplicates<T>(
  items: readonly T[],
  bytes: (item: T) => Uint8Array,
  name: (item: T) => string,
): { kept: T[]; dropped: T[] } {
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const item of items) {
    const candidate = bytes(item);
    const label = name(item);
    const isRepeat = kept.some((seen) => {
      if (name(seen) !== label) return false;
      const previous = bytes(seen);
      return previous.length === candidate.length && equals(previous, candidate);
    });
    if (isRepeat) dropped.push(item);
    else kept.push(item);
  }
  return { kept, dropped };
}

function equals(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** A live pdf.js session paired with the parsed document. */
export async function withRender(
  input: OpenedInput,
  context: ToolRunContext,
): Promise<{ session: PdfSession; metadata: RenderMetadata }> {
  if (input.session) {
    const metadata = await input.session.metadata();
    return { session: input.session, metadata };
  }
  const session = await openRender(input.bytes, { password: context.password });
  input.session = session;
  return { session, metadata: await session.metadata() };
}

/**
 * The E1/E2 check, for code that has bytes but does not open a document.
 * Delegates to the guard so every "that is not a PDF" message in the app reads
 * the same and carries `NOT_A_PDF`.
 */
export function assertPdf(name: string, bytes: Uint8Array): void {
  if (bytes.length === 0) throw emptyFileError(name);
  if (!looksLikePdf(bytes)) throw notAPdfError(name);
}

export async function newDocument(): Promise<PDFDocument> {
  return createPdf();
}

export function pagesOf(input: OpenedInput): PDFPage[] {
  return input.doc.getPages();
}

/** Resolve a page spec against an input, defaulting to every page. */
export function selectedPages(input: OpenedInput, spec: PageSpec): number[] {
  return resolvePages(spec, input.pageCount);
}

/** Like `selectedPages` but de-duplicated and sorted, for destructive edits. */
export function selectedPageSet(input: OpenedInput, spec: PageSpec): number[] {
  return resolvePageSet(spec, input.pageCount);
}

export interface PdfToolOutputOptions {
  message?: string;
}

export async function pdfResult(
  doc: PDFDocument,
  options: { encrypt?: PasswordOptions; compress?: boolean } & PdfToolOutputOptions,
): Promise<ToolResult> {
  const bytes = options.encrypt
    ? await saveEncrypted(doc, options.encrypt)
    : await savePDF(doc, { useObjectStreams: options.compress ?? true });
  return { kind: 'pdf', bytes, message: options.message };
}

/**
 * Copy a document into a fresh one.
 *
 * `pdf-lib` keeps the `/Encrypt` trailer entry when you save a document that was
 * *loaded* with a password, so "unlock" would hand back a file that still asks
 * for one. Rebuilding through a new `PDFDocument` is the only reliable way to
 * drop protection, and it is also what produces the cleanest cross-reference
 * table for a repaired file.
 */
export async function rebuildDocument(
  doc: PDFDocument,
  options: { password?: string } = {},
): Promise<PDFDocument> {
  const indices = doc.getPages().map((_, index) => index);
  const { doc: target } = await collectPages([{ doc, pages: indices }]);
  const title = doc.getTitle();
  const author = doc.getAuthor();
  const subject = doc.getSubject();
  const keywords = doc.getKeywords();
  const creator = doc.getCreator();
  const producer = doc.getProducer();
  if (title) target.setTitle(title);
  if (author) target.setAuthor(author);
  if (subject) target.setSubject(subject);
  if (keywords) target.setKeywords(keywords.split(',').map((word) => word.trim()).filter(Boolean));
  if (creator) target.setCreator(creator);
  if (producer) target.setProducer(producer);
  void options;
  return target;
}

/** Save without encryption; used by the large majority of tools. */
export async function saved(doc: PDFDocument, compress = true): Promise<Uint8Array> {
  return savePDF(doc, { useObjectStreams: compress });
}

export function filesResult(
  files: { blob: Blob; name: string }[],
  message?: string,
): ToolResult {
  if (files.length === 0) throw new Error('The operation produced no output.');
  return { kind: 'files', files, message };
}

export function reportResult(
  sections: { title: string; rows?: { label: string; value: string }[]; text?: string }[],
  options: { message?: string; files?: { blob: Blob; name: string }[] } = {},
): ToolResult {
  return { kind: 'report', sections, ...options };
}

/** Strip the extension so output names read `report.pdf` not `report.pdf.pdf`. */
export function baseName(name: string): string {
  const withoutPath = name.split(/[\\/]/).pop() ?? name;
  const dot = withoutPath.lastIndexOf('.');
  return dot > 0 ? withoutPath.slice(0, dot) : withoutPath;
}

export function withSuffix(name: string, suffix: string): string {
  if (!suffix) return name;
  const ext = suffix.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  if (!ext) return `${baseName(name)}${suffix}`;
  return `${baseName(name)}${suffix.replace(/\.[a-z0-9]+$/i, '')}.${ext}`;
}

/** Throw a cancellation the harness understands. */
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('The operation was cancelled.', 'AbortError');
  }
}

/** Simple map over pages that reports progress and honours cancellation. */
export async function eachPage<T>(
  items: T[],
  context: ToolRunContext,
  worker: (item: T, index: number) => Promise<void>,
  message: (index: number) => string,
): Promise<void> {
  const total = items.length || 1;
  for (let i = 0; i < items.length; i++) {
    throwIfAborted(context.signal);
    await worker(items[i], i);
    context.progress((i + 1) / total, message(i));
  }
}

/**
 * Bounds already-parsed numbers. `core/guard`'s `clampNumber` is the input-side
 * version: it also treats a non-finite value as the minimum, so an empty number
 * field cannot push `NaN` into a page size.
 */
export function clamp(value: number, min: number, max: number): number {
  return clampNumber(value, min, max);
}

/** Parse `#rgb` / `#rrggbb` / `rgb(a,b,b)` into pdf-lib rgb components. */
export function parseHexColor(hex: string): { r: number; g: number; b: number } {
  const value = hex.trim().toLowerCase();
  const shorthand = value.match(/^#?([0-9a-f])([0-9a-f])([0-9a-f])$/);
  if (shorthand) {
    return {
      r: parseInt(shorthand[1] + shorthand[1], 16) / 255,
      g: parseInt(shorthand[2] + shorthand[2], 16) / 255,
      b: parseInt(shorthand[3] + shorthand[3], 16) / 255,
    };
  }
  const full = value.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/);
  if (!full) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(full[1], 16) / 255,
    g: parseInt(full[2], 16) / 255,
    b: parseInt(full[3], 16) / 255,
  };
}

export function rgbColor(hex: string) {
  const { r, g, b } = parseHexColor(hex);
  return rgb(r, g, b);
}
