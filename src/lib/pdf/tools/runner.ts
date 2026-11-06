/**
 * The PDF tool runner.
 *
 * Turns a `PdfToolDefinition` plus the user's files and form values into
 * downloadable outputs. This replaces the old `executeToolCommand` switch,
 * which had to be edited for every tool and wrapped every result as
 * `application/pdf` — so a `.docx` or `.xlsx` needed a special case list.
 */
import { PDFDocument } from '@maxwbh/pdf-lib';
import { saveEncrypted } from '../core/doc';
import type { PdfToolDefinition, ToolFile, ToolReportSection, ToolResult, ToolValues } from './types';
import { getPdfTool } from './registry';
import { engineReady, enginePurpose } from '../core/engine-ops';
import { defaultValues } from './types';
import {
  ToolInputError,
  clampFields,
  inspectPdf,
  preflightPdf,
  validateFields,
  type PdfInspection,
} from '../core/guard';

export interface RunRequest {
  toolId: string;
  files: File[];
  values?: ToolValues;
  password?: string;
  onProgress?: (fraction: number, message?: string) => void;
  onLog?: (line: string) => void;
  signal?: AbortSignal;
}

export interface RunOutput {
  blob: Blob;
  name: string;
}

/** Kept for callers that build outputs without a name. */
export type NamedOutput = RunOutput;

export interface RunOutcome {
  outputs: RunOutput[];
  report?: { sections: ToolReportSection[]; message?: string };
  message?: string;
  /** Clamp notices plus anything the tool admitted — shown, never swallowed. */
  warnings: string[];
}

export class ToolCancelledError extends Error {
  readonly name = 'ToolCancelledError';
  constructor() {
    super('Cancelled.');
  }
}

/** Extension used when a tool produces a single PDF. */
function outputNameFor(name: string, suffix: string, index: number, total: number): string {
  const base = name.replace(/\.[^.]+$/, '') || 'document';
  const numbered = total > 1 ? `-${index + 1}` : '';
  if (suffix.startsWith('.')) return `${base}${numbered}${suffix}`;
  return `${base}${suffix}${numbered}`;
}

function toToolFile(file: File): ToolFile {
  return {
    name: file.name,
    size: file.size,
    type: file.type,
    bytes: async () => new Uint8Array(await file.arrayBuffer()),
    blob: () => file.slice(0, file.size, file.type || 'application/octet-stream'),
  };
}

/**
 * Reject obviously wrong inputs before a tool spends minutes on them.
 *
 * Returns a `ToolInputError` so the rail can disable the action and name the
 * reason instead of throwing a bare sentence at the log pane (E16/E18).
 */
export function fileProblem(tool: PdfToolDefinition, files: File[]): ToolInputError | null {
  if (files.length === 0) {
    const acceptsOther = Boolean(tool.accept && !/pdf/.test(tool.accept));
    return new ToolInputError('EMPTY_FILE', acceptsOther ? 'Add a file first.' : 'Add a PDF first.', {
      hint: 'Pick a file — it is read in this tab, never uploaded.',
    });
  }
  const uniqueNames = new Set(files.map((file) => `${file.name}:${file.size}`));
  if (!tool.multiFile && uniqueNames.size < files.length) {
    // E16, single-document half: a repeat in the list is never work twice, and
    // there is nothing sensible to do with it. Multi-document tools keep one
    // copy and say so — see `openInputs`.
    return new ToolInputError(
      'OUT_OF_RANGE',
      `"${files[0].name}" appears twice in the selection.`,
      { fileName: files[0].name, hint: 'Remove the repeat, or add a different document.' },
    );
  }
  if (!tool.multiFile && files.length > 1) {
    return new ToolInputError(
      'OUT_OF_RANGE',
      `This tool works on one file at a time. It will use "${files[0].name}".`,
      { hint: 'Remove the other files, or choose a tool that merges.' },
    );
  }
  if (tool.minFiles && files.length < tool.minFiles) {
    return new ToolInputError(
      'OUT_OF_RANGE',
      `This tool needs at least ${tool.minFiles} files — ${files.length} added.`,
    );
  }
  if (tool.maxFiles && files.length > tool.maxFiles) {
    return new ToolInputError(
      'OUT_OF_RANGE',
      `This tool takes at most ${tool.maxFiles} files — ${files.length} added.`,
    );
  }
  return null;
}

/**
 * Inspect files without running a tool: the queue rows, the page count on a
 * result card, and the disabled-until-valid check all read this (E1-E4, E18).
 */
export async function inspectFiles(
  files: readonly File[],
  password?: string,
): Promise<PdfInspection[]> {
  const inspections: PdfInspection[] = [];
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    inspections.push(await inspectPdf(bytes, file.name, { password }));
  }
  return inspections;
}

/** Does this tool read PDFs? `inputKind` is only declared by the exceptions. */
function takesPdfInput(tool: PdfToolDefinition): boolean {
  return !tool.inputKind || tool.inputKind === 'pdf';
}

const PROTECTION_VERSION: Record<string, 1 | 2 | 4 | 5> = {
  'RC4-40': 1,
  RC4: 1,
  'RC4-128': 2,
  'AES-128': 4,
  'AES-256': 5,
};

/**
 * Keep a protected document protected.
 *
 * Organize-style tools rebuild the page tree and save, and `pdf-lib` does not
 * carry `/Encrypt` across that — so rotating a password-protected contract used
 * to hand back an open file: the edit the user asked for, plus a loss of
 * protection nobody asked for. Re-applying the password they supplied is the
 * conservative default; tools whose job is removal say so with
 * `stripsProtection`.
 */
async function preserveProtection(
  result: ToolResult,
  source: PdfInspection | undefined,
  password: string | undefined,
): Promise<{ result: ToolResult; note: string | null }> {
  if (result.kind !== 'pdf' || !source?.encrypted) return { result, note: null };
  // If the output carries protection already, the tool set it deliberately
  // (`protect`, `change-permissions action: set`) and knows the owner password
  // we never saw. Layering the reader's password over that would overwrite it.
  const produced = await inspectPdf(result.bytes, source.name, { cheap: true });
  if (produced.encrypted) return { result, note: null };
  const algorithm = source.algorithm ?? 'password';
  if (!password) {
    return { result, note: `The source was protected (${algorithm}); the result opens without a password.` };
  }
  try {
    const doc = await PDFDocument.load(result.bytes, { updateMetadata: false });
    const bytes = await saveEncrypted(doc, {
      userPassword: password,
      ownerPassword: password,
      version: PROTECTION_VERSION[algorithm.toUpperCase()] ?? 4,
      ...(source.permissions ? { permissions: source.permissions } : {}),
    });
    return { result: { ...result, bytes }, note: `Re-applied the source’s ${algorithm} protection with the password you supplied.` };
  } catch {
    return { result, note: 'Could not re-apply the source protection; the result opens without a password.' };
  }
}

export async function runPdfTool(request: RunRequest): Promise<RunOutcome> {
  const tool = getPdfTool(request.toolId);
  if (!tool) throw new Error(`Unknown tool "${request.toolId}".`);
  if (tool.unavailable) {
    throw new ToolInputError('UNSUPPORTED', tool.unavailable, {
      hint: 'The notes on this tool name the format to export instead.',
    });
  }
  if (!tool.run) {
    throw new Error(`${tool.name} runs inside its own editor pane rather than from the Run button.`);
  }

  const problem = fileProblem(tool, request.files);
  if (problem) throw problem;

  const missing = (tool.engines ?? []).filter((id) => !engineReady(id));
  if (missing.length > 0) {
    throw new ToolInputError(
      'NEEDS_ENGINE',
      `${tool.name} needs the optional ${missing.join(' and ')} module. ${missing
        .map((id) => enginePurpose(id))
        .join(' ')} Open WASM settings to enable it.`,
      { hint: 'The built-in tools run without it; this one cannot.' },
    );
  }

  // A tool that admits a compromise in the log ("warning: fonts are degraded")
  // must not have it buried in a pane nobody opens. Structural `result.warnings`
  // is the right channel and Phase B tools are moving to it; this bridge means
  // the ~100 tools that still only `log()` a caveat are honest today.
  const logged: string[] = [];
  const CAVEAT = /(warn|degrad|skipp|fallback|could not|couldn.t|failed to|no text layer|larger than|ignored|became)/i;
  const onLog = (line: string) => {
    logged.push(line);
    request.onLog?.(line);
  };

  const merged = { ...defaultValues(tool.fields), ...(request.values ?? {}) };
  // E15: a number outside its bounds is corrected and announced here, so no
  // tool receives `dpi: 0` and no long run ends in a broken file.
  const clamped = clampFields(tool.fields, merged);
  for (const change of clamped.changes) {
    onLog(change.message);
  }
  const values = clamped.values;
  const validation = tool.validate?.(values, { fileCount: request.files.length });
  if (validation) throw new Error(validation);
  const [issue] = validateFields(tool.fields, values);
  if (issue) {
    throw new ToolInputError('OUT_OF_RANGE', issue.message, {
      hint: 'Fix the highlighted option and run again.',
    });
  }

  // A tool may collect the password in its own form (`Unlock`, `Change
  // permissions`, `Remove restrictions`) or rely on the shared gate in the
  // sidebar. Either source has to reach `openPDF`, otherwise opening the file
  // fails before the tool can use the password it was just given.
  const declared = (tool.fields ?? [])
    .filter((field) => field.type === 'password')
    .map((field) => values[field.key])
    .find((value): value is string => typeof value === 'string' && value.length > 0);
  const effectivePassword = request.password || declared;

  const inputs = request.files.map(toToolFile);
  // One cheap header/trailer pass per file, before any tool allocates work: an
  // empty or mislabelled file, and a document the gate has no password for, are
  // settled here rather than halfway through a 500-page parse (E1, E2, E4, E7).
  if (takesPdfInput(tool)) {
    for (const input of inputs) {
      const refusal = await preflightPdf(input, effectivePassword);
      if (refusal) throw refusal;
    }
  }
  const controller = new AbortController();
  const upstream = request.signal;
  const onUpstreamAbort = () => controller.abort(new ToolCancelledError());
  if (upstream) {
    if (upstream.aborted) onUpstreamAbort();
    else upstream.addEventListener('abort', onUpstreamAbort, { once: true });
  }

  const results: RunOutput[] = [];
  try {
    const result: ToolResult = await tool.run({
      inputs,
      values,
      progress: (fraction, message) => request.onProgress?.(fraction, message),
      log: onLog,
      signal: controller.signal,
      password: effectivePassword,
    });
    // A protected source stays protected unless removing it is the tool's job.
    // Read the source's protection only when it could matter: the pre-flight
    // keeps its inspection cheap (header and trailer) and throws it away.
    let source: PdfInspection | undefined;
    if (!tool.stripsProtection && takesPdfInput(tool) && inputs.length > 0) {
      try {
        const bytes = new Uint8Array(await inputs[0].blob().arrayBuffer());
        source = await inspectPdf(bytes, inputs[0].name, { password: effectivePassword });
      } catch {
        source = undefined;
      }
    }
    const guarded = source
      ? await preserveProtection(result, source, effectivePassword)
      : { result, note: null as string | null };
    const produced = guarded.result;
    results.push(...collect(produced, inputs[0].name, tool.outputSuffix));
    return {
      outputs: results,
      report: produced.kind === 'report' ? { sections: produced.sections, message: produced.message } : undefined,
      message: produced.message,
      // A corrected value is an admission too: the user asked for 0 dpi and got
      // 96, and the result card has to say so (E15).
      warnings: [...new Set([
        ...clamped.changes.map((change) => change.message),
        ...(produced.warnings ?? []),
        ...(guarded.note ? [guarded.note] : []),
        ...logged.filter((line) => CAVEAT.test(line)),
      ])],
    };
  } finally {
    upstream?.removeEventListener('abort', onUpstreamAbort);
  }
}

function collect(result: ToolResult, firstName: string, suffix: string): RunOutput[] {
  if (result.kind === 'pdf') {
    return [{
      blob: new Blob([result.bytes as BlobPart], { type: 'application/pdf' }),
      name: outputNameFor(firstName, suffix, 0, 1),
    }];
  }
  if (result.kind === 'files') {
    return result.files.map((file, index) => ({
      blob: file.blob,
      name: file.name ?? outputNameFor(firstName, suffix, index, result.files.length),
    }));
  }
  return (result.files ?? []).map((file, index) => ({
    blob: file.blob,
    name: file.name ?? outputNameFor(firstName, suffix, index, (result.files ?? []).length),
  }));
}

/** Does this tool need a password prompt before it can run? */
export function takesPasswordInput(tool: PdfToolDefinition | undefined): boolean {
  if (!tool) return false;
  return (tool.fields ?? []).some((field) => field.type === 'password');
}
