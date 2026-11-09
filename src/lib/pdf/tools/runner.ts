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
import { downloadName } from './helpers';
import { getPdfTool, hasCustomMainView } from './registry';
import { defaultValues } from './types';
import {
  ToolInputError,
  clampFields,
  inspectPdf,
  looksLikePdf,
  preflightPdf,
  validateFields,
  type PdfInspection,
} from '../core/guard';
import { sniffImageMime } from '../core/images';

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
  /**
   * Pages in the first produced file, or `null` when nothing counted them.
   *
   * The result screen prints `in → out`, and "out not counted" was appearing on
   * every run because the number was never carried out of the tool. It comes
   * from the producer, which holds the document at the moment it saves
   * (`ToolResult.pages`); the runner does not re-count the bytes, because that
   * would parse a 500-page output a second time for one integer.
   */
  pagesOut: number | null;
}

export class ToolCancelledError extends Error {
  readonly name = 'ToolCancelledError';
  constructor() {
    super('Cancelled.');
  }
}

/**
 * The download name for one output.
 *
 * Delegates to `helpers.downloadName` so the sanitising (E17) happens once for
 * the runner and for every tool that builds its own file names.
 */
function outputNameFor(name: string, suffix: string, index: number, total: number): string {
  return downloadName(name, suffix, index, total);
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
      `This tool needs at least ${tool.minFiles} ${tool.minFiles === 1 ? 'file' : 'files'}${paneClause(tool)} — ${files.length} added.`,
      { hint: 'Add the missing document — the add-more card sits beside the files.' },
    );
  }
  if (tool.maxFiles && files.length > tool.maxFiles) {
    return new ToolInputError(
      'OUT_OF_RANGE',
      `This tool takes at most ${tool.maxFiles} ${tool.maxFiles === 1 ? 'file' : 'files'}${paneClause(tool)} — ${files.length} added.`,
      { hint: 'Remove the extras so the pair being compared is the pair you mean.' },
    );
  }
  return null;
}

/**
 * For a tool whose queue lives in a bespoke pane, say where the files go.
 * `hasCustomMainView` is the truth of it: the pane is the only place that holds
 * more than one document for these tools.
 */
function paneClause(tool: PdfToolDefinition): string {
  return hasCustomMainView(tool.id) ? ' from its own editor pane' : '';
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

/** Bytes enough to name a container: magic numbers live at offset 0. */
const SNIFF_BYTES = 64;

/**
 * What these bytes *are*, when they are provably not a picture.
 *
 * Deliberately conservative: an unknown binary file (JPEG XL, a RAW format, a
 * camera thumbnail) answers `null` and reaches the browser's own decoder, which
 * may well open it. Only a container this repo can name — a PDF, a ZIP package,
 * an MP3, plain text — is refused on sight.
 */
function notAPictureLabel(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return null;
  if (looksLikePdf(bytes)) return 'a PDF';
  if (sniffImageMime(bytes)) return null;
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return 'a ZIP package (the container used by DOCX, XLSX and EPUB)';
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return 'an audio file';
  const printable = Array.from(bytes.slice(0, 32)).every(
    (byte) => byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte < 0x7f),
  );
  return printable ? 'a text file' : null;
}

/**
 * Refuse the wrong kind of input before the tool spends anything on it.
 *
 * Two different failures get two different sentences. A PDF dropped on an image
 * tool is a *format* problem, so the message names the file, says what it really
 * is, and points at the tool that reads it. Where the input genuinely comes from
 * a bespoke pane — the scan's captures — the pane is named as the remedy, because
 * that is the place the user can fix it. Either way this happens before any
 * decoding, engine fetch or page parse, so a wrong file costs a header read.
 */
async function inputKindProblem(
  tool: PdfToolDefinition,
  files: readonly File[],
): Promise<ToolInputError | null> {
  if (tool.inputKind !== 'image') return null;
  const pane = hasCustomMainView(tool.id);
  for (const file of files) {
    const bytes = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
    const label = notAPictureLabel(bytes);
    if (!label) continue;
    const finding = `"${file.name}" is ${label}, not a picture`;
    return new ToolInputError(
      'UNSUPPORTED',
      pane
        ? `${finding} — ${tool.name} builds its pages from the captures in its own editor pane.`
        : `${finding}.`,
      {
        fileName: file.name,
        hint: pane
          ? 'Capture a page with the camera, or add photos that are already on this device.'
          : 'Add the image you meant, or use a tool that reads PDFs.',
      },
    );
  }
  return null;
}

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
  // Named from the file's own dictionary, so a gate with no cipher is not
  // reported as one (and a foreign AES-256 source still says AES-256).
  const recorded = source.algorithm && source.algorithm !== 'no cipher'
    ? `protected (${source.algorithm})`
    : 'protected by a password';
  if (!password) {
    return { result, note: `The source was ${recorded}; the result opens without one.` };
  }
  try {
    const doc = await PDFDocument.load(result.bytes, { updateMetadata: false });
    const bytes = await saveEncrypted(doc, {
      userPassword: password,
      ownerPassword: password,
      ...(source.permissions ? { permissions: source.permissions } : {}),
    });
    // The gate is re-issued, the cipher is not: what this browser writes carries
    // the crypt filter /None, whatever the source carried.
    return { result: { ...result, bytes }, note: `Re-applied the source's password and /P flags with the password you supplied — a gate, not a cipher: the copy is written with the crypt filter /None.` };
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

  // No engine gate here any more. A tool that needs Ghostscript or CoherentPDF
  // resolves it from `core/engine-ops`, which fetches the default CDN address on
  // first use and logs one honest line while it does; the run is not blocked on
  // a setting the user can no longer see.

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
  // The wrong *kind* of file is refused here, before the tool opens anything:
  // a PDF dropped on the scan pane used to reach the image decoder, which could
  // wait on the browser forever (E2, E20).
  const kindProblem = await inputKindProblem(tool, request.files);
  if (kindProblem) throw kindProblem;
  // One cheap header/trailer pass per file, before any tool allocates work: an
  // empty or mislabelled file, and a document the gate has no password for, are
  // settled here rather than halfway through a 500-page parse (E1, E2, E4, E7).
  //
  // The same pass is where a ciphered input is refused. Every tool below the
  // pre-flight that writes a PDF back out rebuilds it from the source's own page
  // streams, and this app never decrypts one — measured over 18 runs by an
  // outside-locked file, the output kept its page count, kept the user's password
  // and lost every word. A tool that only reads (declared `readsOnly`) takes its
  // content from pdf.js, which does undo these ciphers, and keeps running.
  if (takesPdfInput(tool)) {
    const rejectCiphered = !tool.readsOnly;
    for (const input of inputs) {
      const refusal = await preflightPdf(input, effectivePassword, { rejectCiphered });
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
      pagesOut: pagesOutFor(produced, results),
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

/**
 * Pages in the file the user is being handed, `null` when nobody counted it.
 *
 * Only a report is excluded by shape: its "output" is text on the screen, and a
 * page count would claim a document that does not exist. A produced file that is
 * not a PDF (a zip, a CSV) is excluded by its bytes, so a count attached to the
 * wrong container cannot reach the card either.
 */
function pagesOutFor(result: ToolResult, outputs: RunOutput[]): number | null {
  if (result.kind === 'report') return null;
  const [primary] = outputs;
  if (primary && !isPdfOutput(primary)) return null;
  return typeof result.pages === 'number' && result.pages > 0 ? Math.trunc(result.pages) : null;
}

/** The container the download will actually open as, by MIME or by name. */
function isPdfOutput(output: RunOutput): boolean {
  return /pdf/i.test(output.blob.type) || /\.pdf$/i.test(output.name);
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
