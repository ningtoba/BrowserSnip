import { create } from 'zustand';
import type { FFmpegProgress, ToolId } from '@/types';

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
  label: string;
  suffix: string;
  statusMessage: string;
  report: ToolReport | null;
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
  label: string;
  suffix: string;
  /** Current human-readable step, shown under the progress bar. */
  statusMessage: string;
  /** Structured result for tools that report rather than produce a file. */
  report: ToolReport | null;

  setActiveTool: (tool: ToolId | null) => void;
  startProcessing: (label: string, suffix: string) => void;
  setPercent: (percent: number, message?: string) => void;
  setReport: (report: ToolReport | null) => void;
  updateProgress: (p: FFmpegProgress, percent: number) => void;
  appendLog: (line: string) => void;
  setOutput: (blob: Blob, url: string, name?: string) => void;
  addOutput: (blob: Blob, url: string, name?: string) => void;
  setError: (error: string) => void;
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
  label: '',
  suffix: '',
  statusMessage: '',
  report: null,
});

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
  label: '',
  suffix: '',
  statusMessage: '',
  report: null,

  setActiveTool: (tool) => {
    const state = get();
    if (state.activeTool && state.activeTool !== tool) {
      set((s) => ({
        sessions: {
          ...s.sessions,
          [state.activeTool!]: {
            isProcessing: s.isProcessing,
            progress: s.progress,
            currentProgress: s.currentProgress,
            logs: s.logs,
            outputBlob: s.outputBlob,
            outputUrl: s.outputUrl,
            outputBlobs: s.outputBlobs,
            outputUrls: s.outputUrls,
            outputNames: s.outputNames,
            error: s.error,
            label: s.label,
            suffix: s.suffix,
            statusMessage: s.statusMessage,
            report: s.report,
          },
        },
      }));
    }
    const slot = tool ? state.sessions[tool] : null;
    set({
      activeTool: tool ?? undefined,
      isProcessing: slot?.isProcessing ?? false,
      progress: slot?.progress ?? 0,
      currentProgress: slot?.currentProgress ?? null,
      logs: slot?.logs ?? [],
      outputBlob: slot?.outputBlob ?? null,
      outputUrl: slot?.outputUrl ?? null,
      outputBlobs: slot?.outputBlobs ?? [],
      outputUrls: slot?.outputUrls ?? [],
      outputNames: slot?.outputNames ?? [],
      error: slot?.error ?? null,
      label: slot?.label ?? '',
      suffix: slot?.suffix ?? '',
      statusMessage: slot?.statusMessage ?? '',
      report: slot?.report ?? null,
    });
  },

  startProcessing: (label, suffix) =>
    set({
      isProcessing: true,
      progress: 0,
      currentProgress: null,
      logs: [],
      outputBlob: null,
      outputUrl: null,
      outputBlobs: [],
      outputUrls: [],
      error: null,
      label,
      suffix,
      statusMessage: '',
      report: null,
    }),

  setPercent: (percent, message) =>
    set((state) => ({
      progress: Math.max(0, Math.min(100, percent)),
      statusMessage: message ?? state.statusMessage,
    })),

  setReport: (report) => set({ report }),

  updateProgress: (p, percent) =>
    set({ currentProgress: p, progress: percent }),

  appendLog: (line) =>
    set((state) => ({ logs: [...state.logs, line] })),

  setOutput: (blob, url, name) => {
    const prev = get().outputUrl;
    if (prev) URL.revokeObjectURL(prev);

    set({
      isProcessing: false,
      progress: 100,
      outputBlob: blob,
      outputUrl: url,
      outputBlobs: [blob],
      outputUrls: [url],
      outputNames: [name ?? deriveName(blob, get().label)],
    });
  },

  addOutput: (blob, url, name) =>
    set((state) => ({
      outputBlobs: [...state.outputBlobs, blob],
      outputUrls: [...state.outputUrls, url],
      outputNames: [...state.outputNames, name ?? deriveName(blob, state.label)],
    })),

  setError: (error) =>
    set({ isProcessing: false, error }),

  persistCurrent: () => {
    const state = get();
    if (!state.activeTool) return;
    set((s) => ({
      sessions: {
        ...s.sessions,
        [state.activeTool!]: {
          isProcessing: s.isProcessing,
          progress: s.progress,
          currentProgress: s.currentProgress,
          logs: s.logs,
          outputBlob: s.outputBlob,
          outputUrl: s.outputUrl,
          outputBlobs: s.outputBlobs,
          outputUrls: s.outputUrls,
          outputNames: s.outputNames,
          error: s.error,
          label: s.label,
          suffix: s.suffix,
          statusMessage: s.statusMessage,
          report: s.report,
        },
      },
    }));
  },

  reset: () => {
    const prevOutputs = get().outputUrls;
    for (const url of prevOutputs) {
      URL.revokeObjectURL(url);
    }

    set(emptySlot());
  },
}));
