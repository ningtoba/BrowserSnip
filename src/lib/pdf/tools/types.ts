/**
 * The declarative PDF tool contract.
 *
 * Adding a tool used to mean editing five files (`ToolId` union, `TOOLS`
 * registry, `TOOL_COMPONENTS`, `TOOL_MAIN_COMPONENTS`, the `executeToolCommand`
 * switch) and hand-writing a control panel whose hidden `id="tool-process-btn"`
 * was reached by `document.getElementById` from the header. The contract below
 * collapses that to one module per tool: the id union, the dashboard cards,
 * the sidebar form and the dispatch are all derived from these definitions.
 */
import type { ComponentType } from 'react';

export type PdfToolCategory =
  | 'organize'
  | 'optimize'
  | 'convert-to'
  | 'convert-from'
  | 'edit'
  | 'security';

/** Optional CDN engines, mirroring BentoPDF's `wasm-provider` design. */
export type EngineId = 'pymupdf' | 'ghostscript' | 'cpdf';

export type FieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'slider'
  | 'color'
  | 'select'
  | 'multiselect'
  | 'toggle'
  | 'segmented'
  | 'pages'
  | 'password'
  | 'file'
  | 'dimensions'
  | 'signature-style';

export interface ToolFieldOption {
  value: string | number | boolean;
  label: string;
  hint?: string;
}

export interface ToolField {
  key: string;
  label: string;
  type: FieldType;
  help?: string;
  placeholder?: string;
  default?: string | number | boolean | number[] | null;
  options?: ToolFieldOption[];
  /** Smallest accepted value. `core/guard` clamps or rejects anything below it. */
  min?: number;
  /** Largest accepted value. */
  max?: number;
  /** Slider/stepper granularity. Validation snaps to the bounds, not to this. */
  step?: number;
  /** Reject fractional input (the runner rounds instead, and says so). */
  integer?: boolean;
  /** Regular expression source the value must match. */
  pattern?: string;
  /**
   * Leave the field blank without failing validation — the opposite of
   * `required`, and wins when both are set on a legacy definition.
   */
  optional?: boolean;
  /** Rail section this field belongs to; new sections appear in declaration order. */
  group?: string;
  unit?: string;
  accept?: string;
  /** Let the user pick more than one file for this field. */
  multiple?: boolean;
  maxFiles?: number;
  /** Two-column layout inside the sidebar. */
  half?: boolean;
  /** Hide the field while `when` is false. */
  when?: (values: ToolValues) => boolean;
  /**
   * Refuse an empty value. A predicate makes it conditional, so a field that is
   * only required in one mode is required *there* — inline, on the field itself —
   * instead of via a tool-level `validate` whose message no field owns and no
   * control can point at.
   */
  required?: boolean | ((values: ToolValues) => boolean);
  /**
   * The imperative sentence shown when a required field is empty. The default
   * "<label> is required." is a status report; this is where a tool says what to
   * type and why, which matters most on a form with several look-alike fields.
   */
  missing?: string;
}

/**
 * Form state. Values stay `unknown` at the boundary so a `file` field can hold
 * bytes; every consumer reads them through the typed accessors below.
 */
export type ToolValues = Record<string, unknown>;

/** One picked file, kept in memory only. */
export interface FileValue {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
  size: number;
}

export interface ToolFile {
  name: string;
  size: number;
  type: string;
  bytes: () => Promise<Uint8Array>;
  blob: () => Blob;
}

export interface ToolRunContext {
  /** Ordered inputs. Single-file tools receive exactly one entry. */
  inputs: ToolFile[];
  values: ToolValues;
  /** 0..1. Omit for operations whose duration is unpredictable. */
  progress: (fraction: number, message?: string) => void;
  log: (line: string) => void;
  signal: AbortSignal;
  /** Supplied by the password gate when the document is encrypted. */
  password?: string;
}

/**
 * Which code path wrote the bytes a result hands back, stamped by that path at the
 * moment it wrote them.
 *
 * The result card used to print `tool.engines[0]` — the engine a tool is *configured*
 * to use — so a file that a local fallback produced was credited to Ghostscript for
 * exactly as long as the fallback ran. Measured on `pdf-to-pdfa` in
 * `docs/research/pdfa-attribution-recheck.md`: the label named Ghostscript while
 * `bestEffortPdfA` wrote every byte, and that misattribution is what made a dead
 * engine invocation look like a working conversion.
 *
 * Nothing downstream infers this from a declaration. A tool that runs an engine and
 * keeps its output says `engine`; one that asked, gave up (or threw the engine's file
 * away) and wrote its own says `fallback`, naming the engine that did not produce
 * these bytes; a file with no engine in play at all says `core`.
 */
export type ByteSource =
  | { via: 'engine'; engine: EngineId }
  | { via: 'fallback'; engine: EngineId }
  | { via: 'core' };

export interface ToolOutputFile {
  blob: Blob;
  name?: string;
  /** Who wrote these bytes. Omitted means the producer did not say. */
  producedBy?: ByteSource;
}

/**
 * Caveats from a run that had to compromise — "OCR skipped on page 4",
 * "Ghostscript unavailable, used the core path". `message` is the outcome, so
 * these belong in their own field: the result card renders them as warnings
 * rather than burying an admission in a log pane.
 */
type ToolResultCommon = {
  warnings?: string[];
  /**
   * Pages in the primary output — the first entry of `files`, or the whole PDF
   * for `kind: 'pdf'`.
   *
   * Set it where the document is in hand, at the moment it is saved: reading the
   * number back off the bytes costs a second full parse of a 500-page output,
   * and this repo's saves keep the page tree inside a compressed object stream,
   * so there is no cheap number to find there. Left out, the result screen says
   * the output was not counted instead of guessing.
   */
  pages?: number;
};

export type ToolResult =
  | ({ kind: 'pdf'; bytes: Uint8Array; producedBy?: ByteSource; message?: string } & ToolResultCommon)
  | ({ kind: 'files'; files: ToolOutputFile[]; message?: string } & ToolResultCommon)
  | ({ kind: 'report'; sections: ToolReportSection[]; message?: string; files?: ToolOutputFile[] } & ToolResultCommon);

export interface ToolReportSection {
  title: string;
  rows?: { label: string; value: string }[];
  text?: string;
  /** Inline previews, e.g. per-page differences. */
  images?: { label: string; blob: Blob }[];
}

/**
 * How the workspace should fill the main pane.
 * - `viewer`    generic read-only preview (the default for PDF inputs)
 * - `pages`     interactive page grid used by organize/delete/extract
 * - `surface`   tools that draw onto a page (crop, sign, redact, stamp, form)
 * - `editor`    the annotation editor
 * - `text-editor` the in-place content editor
 * - `compare`   two-document side-by-side
 * - `none`      no preview (converters that emit non-PDF output)
 * - `custom`    the tool supplies `MainView`
 */
export type ToolSurface =
  | 'viewer'
  | 'pages'
  | 'surface'
  | 'editor'
  | 'text-editor'
  | 'compare'
  | 'none'
  | 'custom';

export interface PdfToolDefinition {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: PdfToolCategory;
  /** Extra search terms for the dashboard filter. */
  keywords?: string[];
  /** Accept a non-PDF input (image, text, office document…). */
  accept?: string;
  inputKind?: 'pdf' | 'image' | 'text' | 'office' | 'any';
  multiFile?: boolean;
  minFiles?: number;
  maxFiles?: number;
  /**
   * The CDN engines this tool may call.
   *
   * A capability list, not a result: which engine (if any) wrote a given file is
   * reported per output by `ToolResult.producedBy`, because two of the tools
   * declared here have a local path that writes the file when the engine does not.
   */
  engines?: EngineId[];
  surface?: ToolSurface;
  fields?: ToolField[];
  /** Refuse obviously bad parameter combinations before any work starts. */
  validate?: (values: ToolValues, context: { fileCount: number }) => string | null;
  /** Verb for the primary action (`Merge`, `Compress`); the panel falls back to "Run". */
  actionLabel?: string;
  /** One line under the tool name: what the user gets when they press it. */
  promise?: string;
  /**
   * Set when removing the source's encryption IS the job (`unlock`,
   * `remove-restrictions`). Without it the runner re-applies a protected
   * source's password to the output, which is right for rotate and wrong here.
   */
  stripsProtection?: boolean;
  /**
   * Set when the tool only *reads* the document: its result is text, a picture, an
   * archive of bytes that were already in the file, or a report on the screen
   * (`pdf-to-text`, `extract-attachments`, `page-dimensions`, `compare-pdfs`…).
   *
   * This is the exemption from the shared pre-flight's ciphered-input refusal, and
   * it is declared rather than guessed because the two cases genuinely differ. A
   * tool that rebuilds the page tree copies each page stream through an engine
   * that never decrypts, so a file locked with RC4 or AES comes back with the
   * right page count and blank paper. These tools take their content from pdf.js,
   * which does implement those ciphers, or from the structure alone, and work on a
   * locked file today — refusing them would be its own regression.
   *
   * Unset is the default and means "may write a PDF back out", which is the case
   * the guard exists for.
   */
  readsOnly?: boolean;
  run?: (context: ToolRunContext) => Promise<ToolResult>;
  /** Provided instead of `run` for tools with bespoke execution (editors). */
  mainComponent?: ComponentType<{ context: ToolRunContext }>;
  /** Output filename suffix, e.g. `_merged.pdf`. */
  outputSuffix: string;
  /** Grouping inside the "all tools" list, when different from `category`. */
  group?: string;
  /** Docs shown next to the Run button (e.g. licence notes for engines). */
  notes?: string[];
  /** Set when a capability is intentionally not available offline. */
  unavailable?: string;
}

/** Narrow a `ToolValues` bag into a typed params object. */
export function readValues<T extends ToolValues>(values: ToolValues): T {
  return values as T;
}

export function stringValue(values: ToolValues, key: string, fallback = ''): string {
  const v = values[key];
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback;
}

export function numberValue(values: ToolValues, key: string, fallback: number): number {
  const v = values[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return fallback;
}

export function booleanValue(values: ToolValues, key: string, fallback = false): boolean {
  const v = values[key];
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return fallback;
}

export function arrayValue(values: ToolValues, key: string): number[] {
  const v = values[key];
  if (Array.isArray(v)) return v.filter((n): n is number => typeof n === 'number');
  return [];
}

/** Files chosen for a `file` field, always as an array. */
export function fileValues(values: ToolValues, key: string): FileValue[] {
  const v = values[key];
  if (Array.isArray(v)) return v as FileValue[];
  if (v && typeof v === 'object' && 'bytes' in v) return [v as FileValue];
  return [];
}

/** String list chosen for a `multiselect` field. */
export function stringValues(values: ToolValues, key: string): string[] {
  const v = values[key];
  if (Array.isArray(v)) return v.filter((item): item is string => typeof item === 'string');
  if (typeof v === 'string' && v.trim() !== '') return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

/** Arbitrary structured state written by a bespoke editor pane. */
export function objectValue<T>(values: ToolValues, key: string): T | undefined {
  const v = values[key];
  return v === undefined || v === null ? undefined : (v as T);
}

/** Build the default form state from a field list. */
export function defaultValues(fields: ToolField[] = []): ToolValues {
  const out: ToolValues = {};
  for (const field of fields) out[field.key] = field.default ?? null;
  return out;
}
