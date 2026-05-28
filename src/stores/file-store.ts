import { create } from 'zustand';
import type { VideoMetadata } from '@/types';

interface FileState {
  file: File | null;
  files: File[];
  metadata: VideoMetadata | null;
  isLargeFile: boolean;
  setFile: (file: File | null) => void;
  addFile: (file: File) => void;
  removeFile: (index: number) => void;
  reorderFiles: (from: number, to: number) => void;
  setMetadata: (meta: VideoMetadata | null) => void;
  clearFiles: () => void;
}

export const useFileStore = create<FileState>((set) => ({
  file: null,
  files: [],
  metadata: null,
  isLargeFile: false,

  setFile: (file) =>
    set({
      file,
      isLargeFile: (file?.size ?? 0) > 500 * 1024 * 1024,
      metadata: null,
    }),

  addFile: (file) =>
    set((state) => ({
      files: [...state.files, file],
    })),

  removeFile: (index) =>
    set((state) => ({
      files: state.files.filter((_, i) => i !== index),
    })),

  reorderFiles: (from, to) =>
    set((state) => {
      const files = [...state.files];
      const [moved] = files.splice(from, 1);
      files.splice(to, 0, moved);
      return { files };
    }),

  setMetadata: (meta) => set({ metadata: meta }),

  clearFiles: () => set({ file: null, files: [], metadata: null, isLargeFile: false }),
}));
