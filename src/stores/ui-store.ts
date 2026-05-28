import { create } from 'zustand';
import type { ToolId } from '@/types';

interface UIState {
  activeTool: ToolId | null;
  sidebarOpen: boolean;
  showLogMonitor: boolean;
  setActiveTool: (tool: ToolId | null) => void;
  toggleSidebar: () => void;
  toggleLogMonitor: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  activeTool: null,
  sidebarOpen: true,
  showLogMonitor: false,

  setActiveTool: (tool) => set({ activeTool: tool }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  toggleLogMonitor: () => set((s) => ({ showLogMonitor: !s.showLogMonitor })),
}));
