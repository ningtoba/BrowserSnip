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
  required?: boolean;
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

export interface ToolOutputFile {
  blob: Blob;
  name?: string;
}

/**
 * Caveats from a run that had to compromise — "OCR skipped on page 4",
 * "Ghostscript unavailable, used the core path". `message` is the outcome, so
 * these belong in their own field: the result card renders them as warnings
 * rather than burying an admission in a log pane.
 */
type ToolResultCommon = { warnings?: string[] };

export type ToolResult =
  | ({ kind: 'pdf'; bytes: Uint8Array; message?: string } & ToolResultCommon)
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
  /** Engines that must be reachable before the tool can run. */
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
