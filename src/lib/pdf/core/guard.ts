/**
 * The shared input guard layer.
 *
 * Before this module every tool answered "what is this file?" by itself, so the
 * same five edge cases produced five different messages — an empty file reached
 * a pdf-lib stack trace, a renamed JPEG said "failed", a locked document said
 * "could not open" without ever asking for a password, and `dpi: 0` quietly
 * produced a broken PDF.
 *
 * Two entry points cover the whole app:
 *
 * - `inspectPdf(bytes, name)` *never throws*. It reads the header and trailer,
 *   then tries a parse, and reports what it found (pages, encryption,
 *   permissions, whether the file only parsed in lenient mode). This is what a
 *   file queue or a result card renders.
 * - `openPdfInput(bytes, name, { password })` is the gate. It raises a
 *   `ToolInputError` with a stable code, the offending file name in the message,
 *   and `passwordRequired` set when the UI should re-prompt instead of showing a
 *   red banner.
 *
 * The numeric/page-range/field helpers live here too so that one definition of
 * "valid input" serves both the rail (inline validation, E15) and the runner
 * (clamping before a tool starts work).
 */
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef } from '@maxwbh/pdf-lib';
import { formatBytes } from '@/lib/utils/format';
import { looksEncrypted } from './doc';
import { tryResolvePages } from './pages';
import type { ToolField, ToolValues } from '../tools/types';

/** Every reason the guard can refuse an input. Stable: the UI switches on these. */
export const TOOL_INPUT_ERROR_CODES = [
  'EMPTY_FILE',
  'NOT_A_PDF',
  'CORRUPT',
  'PASSWORD_REQUIRED',
  'BAD_PASSWORD',
  'UNSUPPORTED',
  'NEEDS_ENGINE',
  'OUT_OF_RANGE',
  'NO_PAGES',
] as const;

export type ToolInputErrorCode = (typeof TOOL_INPUT_ERROR_CODES)[number];

export interface ToolInputErrorOptions {
  /** File the failure names, so a queue can highlight the right row. */
  fileName?: string;
  /** What to do about it, shown under the message. */
  hint?: string;
  /** The underlying parse error, kept for the log pane. */
  detail?: unknown;
}

/**
 * A user-facing refusal. `message` always names the file when there is one, and
 * `passwordRequired` lets the UI distinguish "ask again" from "something broke".
 */
export class ToolInputError extends Error {
  override readonly name = 'ToolInputError';
  readonly code: ToolInputErrorCode;
  readonly fileName?: string;
  readonly hint?: string;
  readonly detail?: unknown;
  /** True for `PASSWORD_REQUIRED` and `BAD_PASSWORD`. */
  readonly passwordRequired: boolean;

  constructor(code: ToolInputErrorCode, message: string, options: ToolInputErrorOptions = {}) {
    super(message);
    this.code = code;
    this.fileName = options.fileName;
    this.hint = options.hint;
    this.detail = options.detail;
    this.passwordRequired = code === 'PASSWORD_REQUIRED' || code === 'BAD_PASSWORD';
  }
}

export function isToolInputError(error: unknown): error is ToolInputError {
  return error instanceof ToolInputError;
}

/**
 * Does this failure mean "the document is locked"?
 *
 * Also recognises `PasswordRequiredError` from `core/doc` and the older
 * prose-matching path, so a tool that still throws a plain Error re-prompts
 * rather than showing a stack trace.
 */
export function isPasswordRequired(error: unknown): boolean {
  if (error instanceof ToolInputError) return error.passwordRequired;
  if (error instanceof Error && error.name === 'PasswordRequiredError') return true;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /password|encrypt/i.test(message) && !/not encrypted/i.test(message);
}

/** Flatten any thrown value into the shape the process store logs. */
export function describeToolError(
  error: unknown,
): { code: ToolInputErrorCode; message: string; fileName?: string; hint?: string; passwordRequired: boolean } {
  if (error instanceof ToolInputError) {
    return {
      code: error.code,
      message: error.message,
      fileName: error.fileName,
      hint: error.hint,
      passwordRequired: error.passwordRequired,
    };
  }
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown error.');
  const password = isPasswordRequired(error);
  return {
    code: password ? 'PASSWORD_REQUIRED' : 'CORRUPT',
    message,
    passwordRequired: password,
  };
}

const PDF_MAGIC = '%PDF-';
/** How far in to look for the header: some producers write junk before `%PDF-`. */
const HEADER_WINDOW = 1024;
/** Trailer dictionaries live at the very end of the file. */
const TRAILER_WINDOW = 4096;

function latin1(bytes: Uint8Array): string {
  return new TextDecoder('latin1').decode(bytes);
}

function head(bytes: Uint8Array, length = HEADER_WINDOW): string {
  return latin1(bytes.subarray(0, Math.min(bytes.length, length)));
}

function tail(bytes: Uint8Array, length = TRAILER_WINDOW): string {
  return latin1(bytes.subarray(Math.max(0, bytes.length - length)));
}

/** Cheap content check: a `%PDF-` marker near the start, whatever the name says. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  return head(bytes).includes(PDF_MAGIC);
}

/** Version claimed by the header (`1.4` for `%PDF-1.4`), or `null`. */
export function headerVersion(bytes: Uint8Array): string | null {
  return head(bytes).match(/%PDF-(\d\.\d)/)?.[1] ?? null;
}

/** `%%EOF` within the last 4 KB. False means the file was cut off while saving. */
export function hasEofMarker(bytes: Uint8Array): boolean {
  return tail(bytes).includes('%%EOF');
}

function extensionOf(name: string): string | null {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  if (dot < 0 || dot === base.length - 1) return null;
  const ext = base.slice(dot + 1);
  return ext.length <= 5 ? ext : null;
}

/**
 * Permission flags from the encryption dictionary's `/P` bitfield (ISO 32000
 * Table 22). Values above bit 12 are always set, so the mask is the only safe
 * test — `P` is commonly a negative number.
 */
export interface PdfPermissions {
  /** Raw `/P` value, for round-tripping and the details pane. */
  raw: number;
  printing: boolean;
  printingHighQuality: boolean;
  modifying: boolean;
  copying: boolean;
  annotating: boolean;
  fillingForms: boolean;
  contentAccessibility: boolean;
  documentAssembly: boolean;
}

export function decodePermissions(p: number): PdfPermissions {
  const flags = p | 0;
  const bit = (mask: number) => (flags & mask) !== 0;
  return {
    raw: p,
    printing: bit(4),
    printingHighQuality: bit(2048),
    modifying: bit(8),
    copying: bit(16),
    annotating: bit(32),
    fillingForms: bit(256),
    contentAccessibility: bit(512),
    documentAssembly: bit(1024),
  };
}

/** `AES-256`, `AES-128`, `RC4-128`, `RC4-40` or `unknown`, from `/V` + `/R`. */
function algorithmOf(dict: PDFDict | undefined): string | null {
  if (!dict) return null;
  const version = dict.lookupMaybe(PDFName.of('V'), PDFNumber)?.asNumber();
  const revision = dict.lookupMaybe(PDFName.of('R'), PDFNumber)?.asNumber();
  if (version === 5 || version === 6 || version === 7 || (version === 4 && revision === 5)) {
    return 'AES-256';
  }
  if (version === 4) return 'AES-128';
  const length = dict.lookupMaybe(PDFName.of('Length'), PDFNumber)?.asNumber() ?? 40;
  if (version === 2 || (version === 1 && length > 40)) return 'RC4-128';
  if (version === 1) return 'RC4-40';
  return 'unknown';
}

function encryptDict(doc: PDFDocument): PDFDict | undefined {
  const entry = doc.context.trailerInfo.Encrypt;
  // The trailer may inline the dictionary or point at it; never assume which.
  if (entry instanceof PDFDict) return entry;
  if (entry instanceof PDFRef) return doc.context.lookupMaybe(entry, PDFDict);
  return undefined;
}

/** What `inspectPdf` learned about one file. Always safe to render. */
export interface PdfInspection {
  name: string;
  /** Bytes supplied, so a queue can show `describeSize(size)` without re-reading. */
  size: number;
  /** Header present. `false` means the file is not a PDF whatever its name says. */
  isPdf: boolean;
  /** Pages readable without a password; 0 when nothing could be parsed. */
  pages: number;
  /** `/Count` claimed by the page tree, when it differs from `pages` (E3). */
  declaredPages: number | null;
  encrypted: boolean;
  /** Encryption scheme, e.g. `AES-256`, when the document is protected. */
  algorithm: string | null;
  /** The **user** password is set and none was supplied. Owner-only protection
   * never sets this: see `opensWithEmptyPassword`. */
  needsPassword: boolean;
  /** A password was supplied and it opened the document (E5). */
  passwordAccepted: boolean;
  /**
   * The file opens on the empty password: it is restricted, not locked. Anyone
   * can read it, and the `/P` flags only ask a reader to behave — which is what
   * `unlock`, `change-permissions` and `remove-restrictions` exist for (E4/E5).
   */
  opensWithEmptyPassword: boolean;
  permissions: PdfPermissions | null;
  /** Header version, e.g. `1.7`. */
  version: string | null;
  /** No `%%EOF` — the file was truncated while saving. */
  truncated: boolean;
  /** Only the lenient parser accepted it, so something in it is broken (E3). */
  recovered: boolean;
  /** Why the guard would refuse this input, or `null` when it is usable. */
  error: ToolInputErrorCode | null;
  /** User-facing sentence, naming the file. Never a stack trace. */
  message: string;
  hint?: string;
  /** The parser's own complaint, one line, for the log pane. */
  detail?: string;
}

export interface InspectOptions {
  /** Candidate password, verified against the encryption dictionary (E5). */
  password?: string;
  /**
   * Skip the parse and report header/trailer facts only. Used by the runner's
   * pre-flight so a 500-page document is not read twice (E7).
   */
  cheap?: boolean;
}

/** Out-param so the gate can reuse the document an inspection already parsed. */
interface ParsedSink {
  doc: PDFDocument | null;
}

/**
 * The `/Count` the root page tree claims, or `null` when it cannot be read.
 *
 * A truncated file often keeps a correct `/Count` while the traversal finds
 * fewer leaves, so comparing the two is how E3 reports *which* pages broke
 * rather than shrugging.
 */
function declaredPageCount(doc: PDFDocument): number | null {
  try {
    const count = doc.catalog.Pages().get(PDFName.of('Count'));
    return count instanceof PDFNumber ? Math.trunc(count.asNumber()) : null;
  } catch {
    return null;
  }
}

interface LoadOutcome {
  doc: PDFDocument | null;
  encrypted: boolean;
  passwordAccepted: boolean;
  /** The user password is empty, so the file opens for anyone: `/P` only restricts. */
  opensWithEmptyPassword: boolean;
  refused: ToolInputErrorCode | null;
  detail?: unknown;
}

/**
 * Parse with the same recovery order every tool gets: a lenient
 * `ignoreEncryption` load reads the structure of a protected file, then the
 * *user* password decides whether one is actually needed.
 */
async function load(bytes: Uint8Array, password?: string): Promise<LoadOutcome> {
  let lenient: PDFDocument | null = null;
  try {
    lenient = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A bad password can also surface as a parse failure in the crypto layer.
    const crypto = /encrypt|password|pad|decrypt/i.test(message);
    return {
      doc: null,
      encrypted: looksEncrypted(bytes),
      passwordAccepted: false,
      opensWithEmptyPassword: false,
      refused: crypto && password ? 'BAD_PASSWORD' : crypto ? 'PASSWORD_REQUIRED' : 'CORRUPT',
      detail: err,
    };
  }
  const encrypted = lenient.isEncrypted;
  if (!encrypted) {
    return { doc: lenient, encrypted: false, passwordAccepted: false, opensWithEmptyPassword: false, refused: null };
  }
  // An `/Encrypt` entry is not a lock. Two different passwords protect a PDF: the
  // **user** password gates opening, the owner password only gates permission
  // changes. A permissions-only file hashes the empty user password, so anyone
  // can read it and demanding a password blocks the tools whose job is the
  // restrictions (E4/E5). Loading with `''` is the reader's point of view: the
  // crypto layer checks the empty password before any other, so a supplied
  // password opens such a file too, and nothing here has to guess.
  try {
    const open = await PDFDocument.load(bytes, { password: '', updateMetadata: false });
    return {
      doc: open,
      encrypted: true,
      passwordAccepted: Boolean(password),
      opensWithEmptyPassword: true,
      refused: null,
    };
  } catch {
    /* the user password is real — fall through to it */
  }
  if (!password) {
    return { doc: lenient, encrypted: true, passwordAccepted: false, opensWithEmptyPassword: false, refused: 'PASSWORD_REQUIRED' };
  }
  try {
    const opened = await PDFDocument.load(bytes, { password, updateMetadata: false });
    return { doc: opened, encrypted: true, passwordAccepted: true, opensWithEmptyPassword: false, refused: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const crypto = /encrypt|password/i.test(message);
    return {
      doc: lenient,
      encrypted: true,
      passwordAccepted: false,
      opensWithEmptyPassword: false,
      refused: crypto ? 'BAD_PASSWORD' : 'CORRUPT',
      detail: err,
    };
  }
}

function quote(name: string): string {
  return `"${name}"`;
}

/** E1 — a file with no bytes. One sentence, shared by the inspection and the gate. */
export function emptyFileError(name: string): ToolInputError {
  return new ToolInputError('EMPTY_FILE', `${quote(name)} is empty (0 bytes) — there is nothing to read.`, {
    fileName: name,
    hint: 'Re-export the file, or remove it from the list.',
  });
}

/** E2 — the name says PDF, the bytes say otherwise. */
export function notAPdfError(name: string): ToolInputError {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1) : extensionOf(name);
  const renamed = ext && ext.length <= 5
    ? ` Renaming a ${ext.toUpperCase()} file to .pdf does not convert it.`
    : '';
  return new ToolInputError(
    'NOT_A_PDF',
    `${quote(name)} is not a PDF: its contents do not start with %PDF-1.x.${renamed}`,
    { fileName: name, hint: 'Open it in its real format first, or export it as a PDF.' },
  );
}

/**
 * Report on a file without ever throwing, including on garbage input.
 */
export async function inspectPdf(
  bytes: Uint8Array,
  name: string,
  options: InspectOptions = {},
): Promise<PdfInspection> {
  return probePdf(bytes, name, options, { doc: null });
}

async function probePdf(
  bytes: Uint8Array,
  name: string,
  options: InspectOptions,
  opened: ParsedSink,
): Promise<PdfInspection> {
  const size = bytes.length;
  const isPdf = looksLikePdf(bytes);
  const truncated = size > 0 && !hasEofMarker(bytes);
  const version = headerVersion(bytes);
  const base: PdfInspection = {
    name,
    size,
    isPdf,
    pages: 0,
    declaredPages: null,
    encrypted: false,
    algorithm: null,
    needsPassword: false,
    passwordAccepted: false,
    opensWithEmptyPassword: false,
    permissions: null,
    version,
    truncated,
    recovered: false,
    error: null,
    message: '',
  };

  if (size === 0) {
    const refusal = emptyFileError(name);
    return { ...base, error: refusal.code, message: refusal.message, hint: refusal.hint };
  }
  if (!isPdf) {
    const refusal = notAPdfError(name);
    return { ...base, error: refusal.code, message: refusal.message, hint: refusal.hint };
  }
  if (options.cheap) {
    const encrypted = looksEncrypted(bytes);
    // Without a parse the user-password hash is unreadable, so "encrypted" is
    // all a cheap check can claim; `preflightPdf` re-asks before refusing.
    const locked = encrypted && !options.password;
    return {
      ...base,
      encrypted,
      needsPassword: locked,
      error: locked ? 'PASSWORD_REQUIRED' : null,
      message: locked ? `${quote(name)} is password protected.` : `${quote(name)} looks like a PDF.`,
      hint: locked ? 'Enter its password and run again.' : undefined,
    };
  }

  const outcome = await load(bytes, options.password);
  opened.doc = outcome.doc;
  const dict = outcome.doc ? encryptDict(outcome.doc) : undefined;
  const rawPermission = dict?.lookupMaybe(PDFName.of('P'), PDFNumber)?.asNumber();
  const permissions =
    typeof rawPermission === 'number' ? decodePermissions(rawPermission) : null;
  const encrypted = outcome.encrypted || (outcome.doc?.isEncrypted ?? false);
  const declaredPages = outcome.doc ? declaredPageCount(outcome.doc) : null;
  const pages = outcome.doc ? safePageCount(outcome.doc) : 0;
  const recovered =
    outcome.doc !== null && (truncated || (declaredPages !== null && declaredPages !== pages));

  const info: PdfInspection = {
    ...base,
    pages,
    declaredPages,
    encrypted,
    algorithm: encrypted ? algorithmOf(dict) : null,
    needsPassword: outcome.refused === 'PASSWORD_REQUIRED',
    passwordAccepted: outcome.passwordAccepted,
    opensWithEmptyPassword: outcome.opensWithEmptyPassword,
    permissions,
    truncated,
    recovered,
  };

  if (outcome.refused === 'PASSWORD_REQUIRED') {
    return {
      ...info,
      error: 'PASSWORD_REQUIRED',
      message: `${quote(name)} is password protected.`,
      hint: `Enter the password for ${quote(name)} and run again.`,
    };
  }
  if (outcome.refused === 'BAD_PASSWORD') {
    return {
      ...info,
      needsPassword: true,
      error: 'BAD_PASSWORD',
      message: `That password is not correct for ${quote(name)}.`,
      hint: 'Check the password (it is case-sensitive) and try again.',
    };
  }
  if (!outcome.doc) {
    return {
      ...info,
      error: 'CORRUPT',
      message: `${quote(name)} is damaged: its PDF structure could not be parsed.`,
      hint: truncated
        ? 'The file has no end-of-file marker, so it was probably cut off while saving.'
        : 'Try a repair tool, or re-export the original.',
      detail: detailOf(outcome.detail),
    };
  }
  if (pages === 0) {
    return {
      ...info,
      error: 'NO_PAGES',
      message: `${quote(name)} has no pages.`,
      hint: 'Nothing to convert, and a repair will not add pages.',
    };
  }
  if (recovered) {
    return {
      ...info,
      message: `${quote(name)} is damaged but recoverable: read ${pages} of ${declaredPages ?? 'its'} pages.`,
      hint: 'Pages after the break may be missing from the output.',
    };
  }
  if (info.opensWithEmptyPassword) {
    return {
      ...info,
      message: `${quote(name)}: ${pages} page${pages === 1 ? '' : 's'}. Restricted, not locked — it opens without a password.`,
    };
  }
  return { ...info, message: `${quote(name)}: ${pages} page${pages === 1 ? '' : 's'}.` };
}

function safePageCount(doc: PDFDocument): number {
  try {
    return doc.getPageCount();
  } catch {
    return 0;
  }
}

function detailOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const oneLine = message.split('\n')[0].trim();
  return oneLine ? oneLine : 'the structure could not be parsed';
}

/**
 * The gate. Throws `ToolInputError` for anything a tool cannot honour and hands
 * back a parsed document plus the inspection that justified it — one parse, not
 * two, because a locked or damaged file is decided from the same load.
 *
 * `options.cheap` is ignored: a tool needs the document itself.
 */
export async function openPdfInput(
  bytes: Uint8Array,
  name: string,
  options: Omit<InspectOptions, 'cheap'> = {},
): Promise<{ doc: PDFDocument; inspection: PdfInspection }> {
  const opened: ParsedSink = { doc: null };
  const inspection = await probePdf(bytes, name, { ...options, cheap: false }, opened);
  if (inspection.error || !opened.doc) {
    throw new ToolInputError(inspection.error ?? 'CORRUPT', inspection.message, {
      fileName: name,
      hint: inspection.hint,
    });
  }
  return { doc: opened.doc, inspection };
}

/**
 * Header-and-trailer only, over a `File`-shaped source: reads at most the first
 * 1 KB and last 4 KB so a large document is not copied into memory just to be
 * rejected (E7). Returns the refusal, or `null` when the run may proceed.
 */
export async function preflightPdf(
  source: { name: string; size: number; blob: () => Blob },
  password?: string,
): Promise<ToolInputError | null> {
  const edges = await readEdges(source);
  let inspection = await inspectPdf(edges, source.name, { password, cheap: true });
  // The cheap pass can only see the `/Encrypt` entry, and an entry is not a
  // lock — it cannot read the user-password hash. Before refusing, ask the
  // parser: a restricted-but-open file must reach the tool (E5), and a genuinely
  // locked one is still named here before the tool allocates any work (E4).
  if (inspection.error === 'PASSWORD_REQUIRED') {
    inspection = await inspectPdf(
      new Uint8Array(await source.blob().arrayBuffer()),
      source.name,
      { password },
    );
  }
  if (!inspection.error) return null;
  return new ToolInputError(inspection.error, inspection.message, {
    fileName: source.name,
    hint: inspection.hint,
  });
}

/**
 * Concatenate the two regions a cheap check needs. For files smaller than the
 * windows this is simply the whole file.
 */
async function readEdges(source: { name: string; size: number; blob: () => Blob }): Promise<Uint8Array> {
  if (source.size === 0) return new Uint8Array(0);
  const blob = source.blob();
  const size = Math.max(source.size, blob.size);
  if (size <= HEADER_WINDOW + TRAILER_WINDOW) {
    return new Uint8Array(await blob.arrayBuffer());
  }
  const headPart = new Uint8Array(await blob.slice(0, HEADER_WINDOW).arrayBuffer());
  const tailPart = new Uint8Array(await blob.slice(size - TRAILER_WINDOW, size).arrayBuffer());
  const joined = new Uint8Array(headPart.length + tailPart.length);
  joined.set(headPart, 0);
  joined.set(tailPart, headPart.length);
  return joined;
}

/* ------------------------------------------------------------------ numbers */

/**
 * Clamp into `[min, max]`, order-agnostically. A value that is not a finite
 * number lands on the nearer bound — `NaN` (an empty number input) on `min`,
 * `Infinity` on `max` — so nonsense never reaches pdf-lib as a page size.
 */
export function clampNumber(
  value: number,
  min: number,
  max: number,
  options: { integer?: boolean } = {},
): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  if (!Number.isFinite(value)) {
    const bound = value === Infinity ? hi : lo;
    return options.integer ? Math.round(bound) : bound;
  }
  const bounded = Math.min(hi, Math.max(lo, value));
  return options.integer ? Math.round(bounded) : bounded;
}

/** `1536` → `1.50 KB`, `912` → `912 B`. Used for every size the UI reports. */
export function describeSize(input: number | Uint8Array | ArrayBuffer | Blob): string {
  return formatBytes(
    typeof input === 'number'
      ? input
      : input instanceof Blob
        ? input.size
        : input.byteLength,
  );
}

/* -------------------------------------------------------------------- pages */

/** One inclusive 1-based page range. `to` is `Infinity` for the `7-` form. */
export interface PageRange {
  from: number;
  to: number;
}

export interface ParsePageRangesOptions {
  /** Page count of the target document, for E6 (`1-2` is valid only if it has 2). */
  total?: number;
}

/**
 * Parse the text of a "which pages" field into 1-based ranges.
 *
 * Tolerant of spacing, trailing commas, open ends (`7-`) and the `all`/`*`
 * keywords; strict about the things that silently change a document: `0`,
 * inverted ranges (`5-3`), and pages outside the file are rejected with a
 * reason. `core/pages.resolvePages` deliberately accepts more because it runs
 * after the user has committed; this runs before, and says why it refused.
 *
 * @throws {ToolInputError} with code `OUT_OF_RANGE`.
 */
export function parsePageRanges(
  input: string | null | undefined,
  options: ParsePageRangesOptions = {},
): PageRange[] {
  const total = options.total;
  const text = (input ?? '').trim().toLowerCase();
  if (text === '' || text === 'all' || text === '*') {
    return [{ from: 1, to: total ?? Infinity }];
  }
  if (text === 'odd' || text === 'even') {
    throw outOfRange(`"${text}" needs a page count; list the pages instead (1,3,5-7).`);
  }
  const ranges: PageRange[] = [];
  for (const raw of text.split(/[,;]+/)) {
    const token = raw.replace(/\s+/g, '');
    if (token === '') continue;
    ranges.push(parseToken(token, total));
  }
  if (ranges.length === 0) {
    throw outOfRange(`"${(input ?? '').trim()}" did not name any page.`);
  }
  return ranges;
}

function outOfRange(message: string): ToolInputError {
  return new ToolInputError('OUT_OF_RANGE', message, {
    hint: 'Use page numbers like 1, 3-5 or 7- (open-ended).',
  });
}

function parseToken(token: string, total?: number): PageRange {
  const bounds = token.match(/^(\d+)?(?:-|--|–|to|\.\.)(\d+)?$/);
  if (bounds) {
    const from = bounds[1] === undefined ? 1 : Number(bounds[1]);
    const to = bounds[2] === undefined ? Infinity : Number(bounds[2]);
    checkPage(from, token, total);
    if (Number.isFinite(to)) {
      checkPage(to, token, total);
      if (to < from) {
        throw outOfRange(
          `"${token}" runs backwards — page ${from} comes after page ${to}. Write ${to}-${from}.`,
        );
      }
    }
    return { from, to };
  }
  const single = Number(token);
  if (!/^\d+$/.test(token) || !Number.isInteger(single)) {
    throw outOfRange(`"${token}" is not a page number or a range like 3-5.`);
  }
  checkPage(single, token, total);
  return { from: single, to: single };
}

function checkPage(page: number, token: string, total?: number): void {
  if (page === 0) {
    throw outOfRange(`"${token}" refers to page 0; pages are numbered from 1.`);
  }
  if (total !== undefined && page > total) {
    throw outOfRange(
      `"${token}" refers to page ${page}, but this document has ${total} page${total === 1 ? '' : 's'}.`,
    );
  }
}

/** Expand parsed ranges into 1-based page numbers, in the order typed. */
export function expandPageRanges(
  ranges: readonly PageRange[],
  total: number,
): number[] {
  const out: number[] = [];
  for (const range of ranges) {
    const from = Math.max(1, range.from);
    if (from > total) {
      throw outOfRange(
        `Page ${range.from} is outside this document (1-${total}).`,
      );
    }
    const to = Math.min(total, Number.isFinite(range.to) ? range.to : total);
    for (let page = from; page <= to; page++) out.push(page);
  }
  return out;
}

/**
 * Why a page selection is unusable for a `total`-page document, or `null`.
 * The rail calls this to block the primary action (E6/E15) without a try/catch
 * in the render path.
 */
export function pageRangeProblem(input: unknown, total: number): string | null {
  const text = typeof input === 'string' ? input.trim().toLowerCase() : '';
  if (text === 'odd' || text === 'even') {
    const pages = tryResolvePages(text, total);
    return pages && pages.length > 0
      ? null
      : `This document has no ${text} pages (1-${total}).`;
  }
  try {
    expandPageRanges(parsePageRanges(text, { total }), total);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/* -------------------------------------------------------------------- fields */

/** Bounds a field declares, normalised so `min > max` typos cannot invert. */
export interface FieldBounds {
  min: number;
  max: number;
  integer: boolean;
  step?: number;
  unit?: string;
}

/** Numeric bounds of a field, or `null` when it is not a number field. */
export function fieldBounds(field: ToolField): FieldBounds | null {
  if (field.type !== 'number' && field.type !== 'slider') return null;
  const min = field.min ?? -Infinity;
  const max = field.max ?? Infinity;
  return {
    min: Math.min(min, max),
    max: Math.max(min, max),
    integer: field.integer === true,
    step: field.step,
    unit: field.unit,
  };
}

function rangeSentence(field: ToolField): string {
  const bounds = fieldBounds(field);
  if (!bounds) return '';
  const unit = bounds.unit ? ` ${bounds.unit}` : '';
  const hasMin = Number.isFinite(bounds.min);
  const hasMax = Number.isFinite(bounds.max);
  if (hasMin && hasMax) return bounds.min === bounds.max ? `${bounds.min}${unit}` : `between ${bounds.min} and ${bounds.max}${unit}`;
  if (hasMin) return `at least ${bounds.min}${unit}`;
  if (hasMax) return `at most ${bounds.max}${unit}`;
  return '';
}

/** A field the user must fix before the tool can run. */
export interface FieldIssue {
  key: string;
  label: string;
  code: 'REQUIRED' | 'NOT_A_NUMBER' | 'OUT_OF_RANGE' | 'NOT_INTEGER' | 'BAD_PATTERN' | 'BAD_PAGE_RANGE';
  message: string;
  /** Value that would satisfy the rule, when one exists (E15). */
  suggestion?: number;
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** Fields hidden by a `when` predicate are neither validated nor clamped. */
function isVisible(field: ToolField, values: ToolValues): boolean {
  try {
    return field.when ? field.when(values) : true;
  } catch {
    // A predicate that throws on half-filled state stays visible rather than
    // silently dropping the field's validation.
    return true;
  }
}

/**
 * Every visible field that is wrong, in declaration order. Used by the rail for
 * inline messages and by the runner as a last line of defence (E15/E18).
 */
export function validateFields(
  fields: readonly ToolField[] | undefined,
  values: ToolValues,
): FieldIssue[] {
  const issues: FieldIssue[] = [];
  for (const field of fields ?? []) {
    if (!isVisible(field, values)) continue;
    const value = values[field.key];
    const optional = field.optional === true || field.required === false;
    if (isEmpty(value)) {
      if (!optional && field.required === true) {
        issues.push({
          key: field.key,
          label: field.label,
          code: 'REQUIRED',
          message: `${field.label} is required.`,
        });
      }
      continue;
    }
    const bounds = fieldBounds(field);
    if (bounds) {
      const numeric = typeof value === 'number' ? value : Number(String(value).trim());
      if (!Number.isFinite(numeric)) {
        issues.push({
          key: field.key,
          label: field.label,
          code: 'NOT_A_NUMBER',
          message: `${field.label} must be a number.`,
        });
        continue;
      }
      const rounded = bounds.integer ? Math.round(numeric) : numeric;
      if (numeric < bounds.min || numeric > bounds.max) {
        issues.push({
          key: field.key,
          label: field.label,
          code: 'OUT_OF_RANGE',
          message: `${field.label} must be ${rangeSentence(field)} (got ${numeric}).`,
          suggestion: clampNumber(numeric, bounds.min, bounds.max, { integer: bounds.integer }),
        });
        continue;
      }
      if (bounds.integer && !Number.isInteger(numeric)) {
        issues.push({
          key: field.key,
          label: field.label,
          code: 'NOT_INTEGER',
          message: `${field.label} must be a whole number (got ${numeric}).`,
          suggestion: rounded,
        });
        continue;
      }
    }
    if (field.pattern && typeof value === 'string') {
      const pattern = new RegExp(field.pattern);
      if (!pattern.test(value)) {
        issues.push({
          key: field.key,
          label: field.label,
          code: 'BAD_PATTERN',
          message: `${field.label} does not match the expected format.`,
        });
      }
    }
    if (field.type === 'pages') {
      const total = typeof values.pageTotal === 'number' ? values.pageTotal : undefined;
      const problem = total === undefined ? null : pageRangeProblem(value, total);
      if (problem) {
        issues.push({
          key: field.key,
          label: field.label,
          code: 'BAD_PAGE_RANGE',
          message: problem,
        });
      }
    }
    if (field.options?.length && (field.type === 'select' || field.type === 'segmented')) {
      const allowed = field.options.map((option) => option.value);
      if (!allowed.includes(value as string | number | boolean)) {
        issues.push({
          key: field.key,
          label: field.label,
          code: 'BAD_PATTERN',
          message: `${field.label} must be one of ${allowed.join(', ')}.`,
        });
      }
    }
  }
  return issues;
}

/** One value the runner changed on the user's behalf. */
export interface FieldClamp {
  key: string;
  label: string;
  from: number;
  to: number;
  message: string;
}

export interface ClampFieldsResult {
  values: ToolValues;
  changes: FieldClamp[];
}

/**
 * Fix every out-of-range number instead of failing the run, and report what
 * changed so the tool can say so out loud (E15: "clamped or rejected with a
 * reason" — this is the clamped half, and the reason is in `message`).
 */
export function clampFields(
  fields: readonly ToolField[] | undefined,
  values: ToolValues,
): ClampFieldsResult {
  const next: ToolValues = { ...values };
  const changes: FieldClamp[] = [];
  for (const field of fields ?? []) {
    if (!isVisible(field, values)) continue;
    const bounds = fieldBounds(field);
    if (!bounds) continue;
    const raw = values[field.key];
    const numeric = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    if (!Number.isFinite(numeric)) continue;
    const fixed = clampNumber(numeric, bounds.min, bounds.max, { integer: bounds.integer });
    if (fixed === numeric) continue;
    next[field.key] = fixed;
    changes.push({
      key: field.key,
      label: field.label,
      from: numeric,
      to: fixed,
      message: `${field.label} must be ${rangeSentence(field)}: ${numeric} became ${fixed}.`,
    });
  }
  return { values: next, changes };
}
