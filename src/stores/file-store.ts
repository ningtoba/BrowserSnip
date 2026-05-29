import { create } from 'zustand';
import type { VideoMetadata, ToolId } from '@/types';

interface ToolSlot {
  file: File | null;
  files: File[];
  metadata: VideoMetadata | null;
  isLargeFile: boolean;
  params: Record<string, unknown>;
}

interface FileState {
  activeTool: ToolId | null;
  sessions: Partial<Record<ToolId, ToolSlot>>;
  file: File | null;
  files: File[];
  metadata: VideoMetadata | null;
  isLargeFile: boolean;
  params: Record<string, unknown>;

  setActiveTool: (tool: ToolId | null) => void;
  setFile: (file: File | null) => void;
  addFile: (file: File) => void;
  removeFile: (index: number) => void;
  reorderFiles: (from: number, to: number) => void;
  setMetadata: (meta: VideoMetadata | null) => void;
  setParams: (params: Record<string, unknown>) => void;
  clearCurrent: () => void;
}

const emptySlot = (): ToolSlot => ({
  file: null,
  files: [],
  metadata: null,
  isLargeFile: false,
  params: {},
});

export const useFileStore = create<FileState>((set, get) => ({
  activeTool: null,
  sessions: {},
  file: null,
  files: [],
  metadata: null,
  isLargeFile: false,
  params: {},

  setActiveTool: (tool) => {
    const state = get();
    if (state.activeTool && state.activeTool !== tool) {
      set((s) => ({
        sessions: {
          ...s.sessions,
          [state.activeTool!]: {
            file: s.file,
            files: s.files,
            metadata: s.metadata,
            isLargeFile: s.isLargeFile,
            params: s.params,
          },
        },
      }));
    }
    const slot = tool ? state.sessions[tool] : null;
    set({
      activeTool: tool ?? undefined,
      file: slot?.file ?? null,
      files: slot?.files ?? [],
      metadata: slot?.metadata ?? null,
      isLargeFile: slot?.isLargeFile ?? false,
      params: slot?.params ?? {},
    });
  },

  setFile: (file) =>
    set({
      file,
      isLargeFile: (file?.size ?? 0) > 500 * 1024 * 1024,
      metadata: null,
    }),

  addFile: (file) =>
    set((state) => ({ files: [...state.files, file] })),

  removeFile: (index) =>
    set((state) => ({ files: state.files.filter((_, i) => i !== index) })),

  reorderFiles: (from, to) =>
    set((state) => {
      const files = [...state.files];
      const [moved] = files.splice(from, 1);
      files.splice(to, 0, moved);
      return { files };
    }),

  setMetadata: (meta) => set({ metadata: meta }),

  setParams: (params) => set({ params }),

  clearCurrent: () => set({ file: null, files: [], metadata: null, isLargeFile: false, params: {} }),
}));
