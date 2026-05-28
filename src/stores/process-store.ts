import { create } from 'zustand';
import type { FFmpegProgress } from '@/types';

interface ProcessState {
  isProcessing: boolean;
  progress: number;
  currentProgress: FFmpegProgress | null;
  logs: string[];
  outputBlob: Blob | null;
  outputUrl: string | null;
  error: string | null;

  startProcessing: () => void;
  updateProgress: (p: FFmpegProgress, percent: number) => void;
  appendLog: (line: string) => void;
  setOutput: (blob: Blob, url: string) => void;
  setError: (error: string) => void;
  reset: () => void;
}

export const useProcessStore = create<ProcessState>((set, get) => ({
  isProcessing: false,
  progress: 0,
  currentProgress: null,
  logs: [],
  outputBlob: null,
  outputUrl: null,
  error: null,

  startProcessing: () =>
    set({
      isProcessing: true,
      progress: 0,
      currentProgress: null,
      logs: [],
      outputBlob: null,
      outputUrl: null,
      error: null,
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
    });
  },

  setError: (error) =>
    set({ isProcessing: false, error }),

  reset: () => {
    const prev = get().outputUrl;
    if (prev) URL.revokeObjectURL(prev);

    set({
      isProcessing: false,
      progress: 0,
      currentProgress: null,
      logs: [],
      outputBlob: null,
      outputUrl: null,
      error: null,
    });
  },
}));
