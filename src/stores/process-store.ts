import { create } from 'zustand';
import type { FFmpegProgress, ToolId } from '@/types';
import type { PdfEncryption } from '@/lib/pdf/core/guard';

/** A structured result from a PDF tool that reports rather than produces a file. */
export interface ToolReportSection {
  title: string;
  rows?: { label: string; value: string }[];
  text?: string;
  images?: { label: string; blob: Blob }[];
}

export interface ToolReport {
  sections: ToolReportSection[];
  message?: string;
}

/**
 * Where the current tool stands. `inspecting` covers the gap between "a file
 * was dropped" and "the rail knows what is in it", which is the state the old
 * UI skipped so that empty, loading, ready and done all looked the same.
 */
export type ToolPhase = 'idle' | 'inspecting' | 'ready' | 'running' | 'done' | 'error';

/**
 * What the pre-flight's password check answered for one loaded file.
 *
 * The point of the split is that the two password failures are different asks:
 * `needs-password` is "I need something from you", `wrong-password` is "try
 * again". `unsupported` is neither — the cipher is one this app cannot undo, so
 * typing any secret changes nothing and the row must not offer a box that lies.
 * `opened` is the state in which a run will actually read the pages.
 */
export type FileLockState =
  /** No `/Encrypt` entry at all. */
  | 'none'
  /** Locked, but the **user** password is empty: it opens with nothing typed. */
  | 'opens-empty'
  | 'needs-password'
  | 'wrong-password'
  | 'opened'
  | 'unsupported';

/** Per-input state: progress for this file, and why it failed if it did. */
export interface FileRunState {
  /** 0..100 for this file only. */
  percent: number;
  message?: string;
  /** Named failure (E1/E2/E4) — rendered by `FileQueue`, never buried in a log. */
  error?: string | null;
  /** Page count once the file has been inspected; `null` means unknown. */
  pages?: number | null;
  /** Bytes, kept so a queue can show a size without holding the File. */
  size?: number;
  /**
   * The lock this file carries, read from its own encryption dictionary by
   * `inspectPdf`, and `null` while the file has not been inspected.
   *
   * Carried here rather than re-read by the row: the fact about the file and the
   * secret that opens it belong on the same card, and one parse answers both.
   */
  encryption?: PdfEncryption | null;
  /** Whether that lock needs a secret, and what the secret typed so far did. */
  lock?: FileLockState;
}

interface ProcessSlot {
  isProcessing: boolean;
  progress: number;
  currentProgress: FFmpegProgress | null;
  logs: string[];
  outputBlob: Blob | null;
  outputUrl: string | null;
  outputBlobs: Blob[];
  outputUrls: string[];
  /** Download name per output, so multi-file results keep meaningful names. */
  outputNames: string[];
  error: string | null;
  /** What to do about `error`, straight from the guard layer when it has one. */
  errorHint: string | null;
  label: string;
  suffix: string;
  statusMessage: string;
  /**
   * A short acknowledgement that is neither progress nor an error.
   *
   * A deliberate cancel and a discarded late result (E19) both end a run with
   * nothing produced, which is not a failure — putting them in `error` handed
   * the user a red panel and a Retry button for something they asked for. They
   * land here instead, and the rail reads them to its live region.
   */
  notice: string | null;
  report: ToolReport | null;
  phase: ToolPhase;
  fileStates: Record<string, FileRunState>;
  warnings: string[];
  sizeBefore: number | null;
  sizeAfter: number | null;
  /** See `ProcessState.pagesOut` — the count travels with the slot it belongs to. */
  pagesOut: number | null;
}

interface ProcessState {
  activeTool: ToolId | null;
  sessions: Partial<Record<ToolId, ProcessSlot>>;
  isProcessing: boolean;
  progress: number;
  currentProgress: FFmpegProgress | null;
  logs: string[];
  outputBlob: Blob | null;
  outputUrl: string | null;
  outputBlobs: Blob[];
  outputUrls: string[];
  outputNames: string[];
  error: string | null;
  /** What to do about `error`, from the guard layer when it has one. */
  errorHint: string | null;
  label: string;
  suffix: string;
  /** Current human-readable step, shown under the progress bar. */
  statusMessage: string;
  /** Acknowledgement of a cancel or a discarded late result; never an error. */
  notice: string | null;
  /** Structured result for tools that report rather than produce a file. */
  report: ToolReport | null;
  phase: ToolPhase;
  /** Keyed by file name (or any stable id the surface chooses). */
  fileStates: Record<string, FileRunState>;
  /** Non-fatal honesty notes from the run: degraded engine, skipped pages… */
  warnings: string[];
  /** Input bytes, so the result can report "before → after". */
  sizeBefore: number | null;
  /** Output bytes; larger than `sizeBefore` is reported, not hidden (E14). */
  sizeAfter: number | null;
  /**
   * Pages the run put into the file it produced, for the primary output only.
   *
   * `null` means nobody counted it, and the result card says "out not counted"
   * rather than reusing the input count. Only a producer holding the document can
   * answer this exactly, so the number travels from the runner's outcome.
   */
  pagesOut: number | null;

  setActiveTool: (tool: ToolId | null) => void;
  startProcessing: (label: string, suffix: string) => void;
  setPhase: (phase: ToolPhase) => void;
  setNotice: (message: string | null) => void;
  /** End a run whose result is thrown away: a cancel, or inputs that moved. */
  abandonRun: (notice?: string | null) => void;
  setPercent: (percent: number, message?: string) => void;
  setFileState: (id: string, patch: Partial<FileRunState>) => void;
  addWarning: (warning: string) => void;
  setWarnings: (warnings: string[]) => void;
  setSizeBefore: (bytes: number | null) => void;
  setSizeAfter: (bytes: number | null) => void;
  /** Pages in the produced PDF, as the run reported them. */
  setPagesOut: (pages: number | null) => void;
  setReport: (report: ToolReport | null) => void;
  updateProgress: (p: FFmpegProgress, percent: number) => void;
  appendLog: (line: string) => void;
  setOutput: (blob: Blob, url: string, name?: string) => void;
  addOutput: (blob: Blob, url: string, name?: string) => void;
  /** Mark a run finished without producing a file (report-only tools). */
  complete: (message?: string) => void;
  setError: (error: string, hint?: string | null) => void;
  persistCurrent: () => void;
  reset: () => void;
}

const emptySlot = (): ProcessSlot => ({
  isProcessing: false,
  progress: 0,
  currentProgress: null,
  logs: [],
  outputBlob: null,
  outputUrl: null,
  outputBlobs: [],
  outputUrls: [],
  outputNames: [],
  error: null,
  errorHint: null,
  label: '',
  suffix: '',
  statusMessage: '',
  notice: null,
  report: null,
  phase: 'idle',
  fileStates: {},
  warnings: [],
  sizeBefore: null,
  sizeAfter: null,
  pagesOut: null,
});

/** The live fields a slot owns — the store state plus nothing else. */
type SlotFields = Pick<ProcessState, keyof ProcessSlot>;

/** Snapshot the live fields so a new field cannot be forgotten on save. */
function slotOf(state: SlotFields): ProcessSlot {
  return {
    isProcessing: state.isProcessing,
    progress: state.progress,
    currentProgress: state.currentProgress,
    logs: state.logs,
    outputBlob: state.outputBlob,
    outputUrl: state.outputUrl,
    outputBlobs: state.outputBlobs,
    outputUrls: state.outputUrls,
    outputNames: state.outputNames,
    error: state.error,
    errorHint: state.errorHint,
    label: state.label,
    suffix: state.suffix,
    statusMessage: state.statusMessage,
    notice: state.notice,
    report: state.report,
    phase: state.phase,
    fileStates: state.fileStates,
    warnings: state.warnings,
    sizeBefore: state.sizeBefore,
    sizeAfter: state.sizeAfter,
    pagesOut: state.pagesOut,
  };
}

const clampPercent = (percent: number): number =>
  Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));

/** Fallback download name from the blob's MIME type. */
function deriveName(blob: Blob, label: string): string {
  const base = (label || 'output').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'output';
  const extension = EXTENSIONS_BY_MIME[blob.type] ?? 'bin';
  return `${base}.${extension}`;
}

const EXTENSIONS_BY_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/tiff': 'tif',
  'image/svg+xml': 'svg',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'text/html': 'html',
  'application/json': 'json',
  'application/zip': 'zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'video/mp4': 'mp4',
  'audio/mpeg': 'mp3',
};

export const useProcessStore = create<ProcessState>((set, get) => ({
  activeTool: null,
  sessions: {},
  isProcessing: false,
  progress: 0,
  currentProgress: null,
  logs: [],
  outputBlob: null,
  outputUrl: null,
  outputBlobs: [],
  outputUrls: [],
  outputNames: [],
  error: null,
  errorHint: null,
  label: '',
  suffix: '',
  statusMessage: '',
  notice: null,
  report: null,
  phase: 'idle',
  fileStates: {},
  warnings: [],
  sizeBefore: null,
  sizeAfter: null,
  pagesOut: null,

  setActiveTool: (tool) => {
    const state = get();
    if (state.activeTool && state.activeTool !== tool) {
      set((s) => ({ sessions: { ...s.sessions, [s.activeTool!]: slotOf(s) } }));
    }
    const slot = tool ? state.sessions[tool] : null;
    set({ activeTool: tool ?? undefined, ...slotOf(slot ?? emptySlot()) });
  },

  startProcessing: (label, suffix) =>
    set((state) => ({
      isProcessing: true,
      progress: 0,
      currentProgress: null,
      logs: [],
      outputBlob: null,
      outputUrl: null,
      outputBlobs: [],
      outputUrls: [],
      error: null,
      errorHint: null,
      label,
      suffix,
      statusMessage: '',
      notice: null,
      report: null,
      phase: 'running',
      warnings: [],
      sizeBefore: null,
      sizeAfter: null,
      pagesOut: null,
      // Per-file page counts survive a re-run; progress and errors do not.
      fileStates: Object.fromEntries(
        Object.entries(state.fileStates).map(([id, file]) => [
          id,
          { ...file, percent: 0, error: null, message: undefined },
        ]),
      ),
    })),

  setPhase: (phase) => set({ phase }),

  setNotice: (message) => set({ notice: message || null }),

  /**
   * Stop a run that will not be published, and say why.
   *
   * `reset()` throws away the inspected page counts too, which would leave a
   * five-file queue reading "pages unknown" after one cancel. Abandoning keeps
   * what was learned about the files and drops only the work.
   */
  abandonRun: (notice?: string | null) =>
    set((state) => ({
      isProcessing: false,
      progress: 0,
      currentProgress: null,
      statusMessage: '',
      report: null,
      notice: notice || null,
      phase: 'idle',
      fileStates: Object.fromEntries(
        Object.entries(state.fileStates).map(([id, file]) => [
          id,
          { ...file, percent: 0, error: null, message: undefined },
        ]),
      ),
    })),

  setPercent: (percent, message) =>
    set((state) => ({
      progress: clampPercent(percent),
      statusMessage: message ?? state.statusMessage,
    })),

  setFileState: (id, patch) =>
    set((state) => {
      const current = state.fileStates[id] ?? { percent: 0 };
      const next: FileRunState = { ...current, ...patch };
      if (patch.percent !== undefined) next.percent = clampPercent(patch.percent);
      return { fileStates: { ...state.fileStates, [id]: next } };
    }),

  addWarning: (warning) =>
    set((state) =>
      state.warnings.includes(warning) ? {} : { warnings: [...state.warnings, warning] },
    ),

  setWarnings: (warnings) => set({ warnings }),

  setSizeBefore: (bytes) => set({ sizeBefore: bytes === null ? null : Math.max(0, bytes) }),

  setSizeAfter: (bytes) => set({ sizeAfter: bytes === null ? null : Math.max(0, bytes) }),

  setPagesOut: (pages) =>
    set({ pagesOut: typeof pages === 'number' && pages > 0 ? Math.trunc(pages) : null }),

  setReport: (report) => set({ report }),

  updateProgress: (p, percent) =>
    set({ currentProgress: p, progress: clampPercent(percent) }),

  appendLog: (line) =>
    set((state) => ({ logs: [...state.logs, line] })),

  setOutput: (blob, url, name) => {
    const prev = get().outputUrl;
    if (prev) URL.revokeObjectURL(prev);

    set({
      isProcessing: false,
      progress: 100,
      phase: 'done',
      outputBlob: blob,
      outputUrl: url,
      outputBlobs: [blob],
      outputUrls: [url],
      outputNames: [name ?? deriveName(blob, get().label)],
      sizeAfter: get().sizeAfter === null ? blob.size : (get().sizeAfter ?? 0) + blob.size,
    });
  },

  addOutput: (blob, url, name) =>
    set((state) => ({
      phase: 'done',
      outputBlobs: [...state.outputBlobs, blob],
      outputUrls: [...state.outputUrls, url],
      outputNames: [...state.outputNames, name ?? deriveName(blob, state.label)],
      sizeAfter: (state.sizeAfter ?? 0) + blob.size,
    })),

  complete: (message) =>
    set((state) => ({
      isProcessing: false,
      progress: 100,
      phase: 'done',
      statusMessage: message ?? state.statusMessage,
    })),

  setError: (error, hint) =>
    set({ isProcessing: false, phase: 'error', error, errorHint: hint ?? null }),

  persistCurrent: () => {
    const state = get();
    if (!state.activeTool) return;
    set((s) => ({ sessions: { ...s.sessions, [s.activeTool!]: slotOf(s) } }));
  },

  reset: () => {
    const prevOutputs = get().outputUrls;
    for (const url of prevOutputs) {
      URL.revokeObjectURL(url);
    }

    set(emptySlot());
  },
}));
