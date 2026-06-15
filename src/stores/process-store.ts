import { create } from 'zustand';
import type { FFmpegProgress, ToolId } from '@/types';

interface ProcessSlot {
  isProcessing: boolean;
  progress: number;
  currentProgress: FFmpegProgress | null;
  logs: string[];
  outputBlob: Blob | null;
  outputUrl: string | null;
  outputBlobs: Blob[];
  outputUrls: string[];
  error: string | null;
  label: string;
  suffix: string;
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
  error: string | null;
  label: string;
  suffix: string;

  setActiveTool: (tool: ToolId | null) => void;
  startProcessing: (label: string, suffix: string) => void;
  updateProgress: (p: FFmpegProgress, percent: number) => void;
  appendLog: (line: string) => void;
  setOutput: (blob: Blob, url: string) => void;
  addOutput: (blob: Blob, url: string) => void;
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
  error: null,
  label: '',
  suffix: '',
});

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
  error: null,
  label: '',
  suffix: '',

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
            error: s.error,
            label: s.label,
            suffix: s.suffix,
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
      error: slot?.error ?? null,
      label: slot?.label ?? '',
      suffix: slot?.suffix ?? '',
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
    }),

  updateProgress: (p, percent) =>
    set({ currentProgress: p, progress: percent }),

  appendLog: (line) =>
    set((state) => ({ logs: [...state.logs, line] })),

  setOutput: (blob, url) => {
    const prev = get().outputUrl;
    if (prev) URL.revokeObjectURL(prev);

    set({
      isProcessing: false,
      progress: 100,
      outputBlob: blob,
      outputUrl: url,
      outputBlobs: [blob],
      outputUrls: [url],
    });
  },

  addOutput: (blob, url) =>
    set((state) => ({
      outputBlobs: [...state.outputBlobs, blob],
      outputUrls: [...state.outputUrls, url],
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
          error: s.error,
          label: s.label,
          suffix: s.suffix,
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
