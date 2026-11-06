/**
 * Shared plumbing for tool implementations.
 *
 * Every tool repeats the same three steps — open the input(s) with the
 * password the gate collected, do the work, save — so they live here rather
 * than being copy-pasted into ninety modules.
 */
import type { PDFDocument, PDFPage } from '@maxwbh/pdf-lib';
import {
  openPDF,
  newPDF as createPdf,
  savePDF,
  saveEncrypted,
  rgb,
  type PasswordOptions,
} from '../core/doc';
import { resolvePages, resolvePageSet, type PageSpec } from '../core/pages';
import { openRender, type PdfSession, type RenderMetadata } from '../core/render';
import type { ToolResult, ToolRunContext } from './types';

export interface OpenedInput {
  doc: PDFDocument;
  bytes: Uint8Array;
  name: string;
  session?: PdfSession;
  pageCount: number;
}

/**
 * Open one document per input file, in the order the user supplied them.
 * A wrong or missing password is reported with the offending filename, which
 * the old pipeline never did — it showed one generic red banner.
 */
export async function openInputs(context: ToolRunContext): Promise<OpenedInput[]> {
  if (context.inputs.length === 0) {
    throw new Error('Add at least one file first.');
  }
  const out: OpenedInput[] = [];
  for (const file of context.inputs) {
    const bytes = await file.bytes();
    assertPdf(file.name, bytes);
    let doc: PDFDocument;
    try {
      doc = await openPDF(bytes, { password: context.password });
    } catch (err) {
      throw annotate(err, file.name);
    }
    out.push({ doc, bytes, name: file.name, pageCount: doc.getPageCount() });
    context.progress(0.05 * (out.length / context.inputs.length), `Read ${file.name}`);
  }
  return out;
}

/** The first input, which is what single-document tools operate on. */
export async function openPrimary(context: ToolRunContext): Promise<OpenedInput> {
  const [first] = await openInputs(context);
  return first;
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

const PDF_MAGIC = '%PDF';

export function assertPdf(name: string, bytes: Uint8Array): void {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  if (!head.includes(PDF_MAGIC)) {
    throw new Error(
      `"${name}" is not a PDF. Add a file whose contents start with %PDF — renaming a ${guessFromName(name)} file to .pdf is not enough.`,
    );
  }
}

function guessFromName(name: string): string {
  const ext = name.split('.').pop()?.toUpperCase();
  return ext && ext.length <= 4 ? ext : 'non-PDF';
}

function annotate(err: unknown, name: string): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (/password/i.test(message)) {
    return new Error(
      `"${name}" is password protected. Enter its password above and run again. (${message})`,
    );
  }
  if (message.includes(name)) return err instanceof Error ? err : new Error(message);
  return new Error(`"${name}" could not be opened: ${message}`);
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

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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
