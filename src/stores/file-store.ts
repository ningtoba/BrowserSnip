import { create } from 'zustand';
import type { VideoMetadata, ToolId } from '@/types';

interface ToolSlot {
  file: File | null;
  files: File[];
  metadata: VideoMetadata | null;
  isLargeFile: boolean;
  params: Record<string, unknown>;
  codecWarning: string | null;
}

interface FileState {
  activeTool: ToolId | null;
  sessions: Partial<Record<ToolId, ToolSlot>>;
  file: File | null;
  files: File[];
  metadata: VideoMetadata | null;
  isLargeFile: boolean;
  params: Record<string, unknown>;
  codecWarning: string | null;
  probing: boolean;

  setActiveTool: (tool: ToolId | null) => void;
  setFile: (file: File | null) => void;
  addFile: (file: File) => void;
  removeFile: (index: number) => void;
  reorderFiles: (from: number, to: number) => void;
  setMetadata: (meta: VideoMetadata | null) => void;
  setParams: (params: Record<string, unknown>) => void;
  setCodecWarning: (warning: string | null) => void;
  setProbing: (probing: boolean) => void;
  persistCurrent: () => void;
  clearCurrent: () => void;
}

const emptySlot = (): ToolSlot => ({
  file: null,
  files: [],
  metadata: null,
  isLargeFile: false,
  params: {},
  codecWarning: null,
});

export const useFileStore = create<FileState>((set, get) => ({
  activeTool: null,
  sessions: {},
  file: null,
  files: [],
  metadata: null,
  isLargeFile: false,
  params: {},
  codecWarning: null,
  probing: false,

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
            codecWarning: s.codecWarning,
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
      codecWarning: slot?.codecWarning ?? null,
    });
  },

  setFile: (file) =>
    set({
      file,
      isLargeFile: (file?.size ?? 0) > 500 * 1024 * 1024,
      metadata: null,
      codecWarning: null,
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

  setCodecWarning: (warning) => set({ codecWarning: warning }),

  setProbing: (probing) => set({ probing }),

  persistCurrent: () => {
    const state = get();
    if (!state.activeTool) return;
    set((s) => ({
      sessions: {
        ...s.sessions,
        [state.activeTool!]: {
          file: s.file,
          files: s.files,
          metadata: s.metadata,
          isLargeFile: s.isLargeFile,
          params: s.params,
          codecWarning: s.codecWarning,
        },
      },
    }));
  },

  clearCurrent: () => set({
    file: null, files: [], metadata: null, isLargeFile: false,
    params: {}, codecWarning: null,
  }),
}));
