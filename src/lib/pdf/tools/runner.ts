/**
 * The PDF tool runner.
 *
 * Turns a `PdfToolDefinition` plus the user's files and form values into
 * downloadable outputs. This replaces the old `executeToolCommand` switch,
 * which had to be edited for every tool and wrapped every result as
 * `application/pdf` — so a `.docx` or `.xlsx` needed a special case list.
 */
import type { PdfToolDefinition, ToolFile, ToolReportSection, ToolResult, ToolValues } from './types';
import { getPdfTool } from './registry';
import { engineReady, enginePurpose } from '../core/engine-ops';
import { defaultValues } from './types';

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

/** Reject obviously wrong inputs before a tool spends minutes on them. */
function validateFiles(tool: PdfToolDefinition, files: File[]): string | null {
  if (files.length === 0) {
    return tool.accept && !/pdf/.test(tool.accept)
      ? 'Add a file first.'
      : 'Add a PDF first.';
  }
  if (!tool.multiFile && files.length > 1) {
    return `This tool works on one file at a time. It will use "${files[0].name}".`;
  }
  if (tool.minFiles && files.length < tool.minFiles) {
    return `This tool needs at least ${tool.minFiles} files — ${files.length} added.`;
  }
  if (tool.maxFiles && files.length > tool.maxFiles) {
    return `This tool takes at most ${tool.maxFiles} files — ${files.length} added.`;
  }
  return null;
}

export async function runPdfTool(request: RunRequest): Promise<RunOutcome> {
  const tool = getPdfTool(request.toolId);
  if (!tool) throw new Error(`Unknown tool "${request.toolId}".`);
  if (tool.unavailable) throw new Error(tool.unavailable);
  if (!tool.run) {
    throw new Error(`${tool.name} runs inside its own editor pane rather than from the Run button.`);
  }

  const fileProblem = validateFiles(tool, request.files);
  if (fileProblem) throw new Error(fileProblem);

  const missing = (tool.engines ?? []).filter((id) => !engineReady(id));
  if (missing.length > 0) {
    throw new Error(
      `${tool.name} needs the optional ${missing.join(' and ')} module. ${missing
        .map((id) => enginePurpose(id))
        .join(' ')} Open WASM settings to enable it.`,
    );
  }

  const values = { ...defaultValues(tool.fields), ...(request.values ?? {}) };
  const validation = tool.validate?.(values, { fileCount: request.files.length });
  if (validation) throw new Error(validation);

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
      log: (line) => request.onLog?.(line),
      signal: controller.signal,
      password: effectivePassword,
    });
    results.push(...collect(result, inputs[0].name, tool.outputSuffix));
    return {
      outputs: results,
      report: result.kind === 'report' ? { sections: result.sections, message: result.message } : undefined,
      message: result.message,
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
