import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { TOOLS } from '@/lib/constants';
import { FileDropZone } from '@/components/ui/FileDropZone';
import { VideoPreview } from '@/components/player/VideoPreview';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { LogMonitor } from '@/components/ui/LogMonitor';
import { OutputActions } from '@/components/ui/OutputActions';
import { MemoryWarning } from '@/components/ui/MemoryWarning';
import { TrimTool } from '@/components/tools/TrimTool';
import { ResizeTool } from '@/components/tools/ResizeTool';
import { CropTool } from '@/components/tools/CropTool';
import { CompressTool } from '@/components/tools/CompressTool';
import { GifTool } from '@/components/tools/GifTool';
import { AudioTool } from '@/components/tools/AudioTool';
import { SpeedTool } from '@/components/tools/SpeedTool';
import { MetadataTool } from '@/components/tools/MetadataTool';
import { useFileStore } from '@/stores/file-store';
import { useProcessStore } from '@/stores/process-store';
import { useUIStore } from '@/stores/ui-store';
import type { ToolId } from '@/types';

const TOOL_COMPONENTS: Record<string, React.ComponentType> = {
  trim: TrimTool,
  resize: ResizeTool,
  crop: CropTool,
  compress: CompressTool,
  gif: GifTool,
  audio: AudioTool,
  speed: SpeedTool,
  metadata: MetadataTool,
};

export function ToolWorkspace() {
  const { toolId } = useParams<{ toolId: string }>();
  const navigate = useNavigate();
  const file = useFileStore((s) => s.file);
  const isLargeFile = useFileStore((s) => s.isLargeFile);
  const codecWarning = useFileStore((s) => s.codecWarning);
  const { isProcessing, outputUrl, outputBlob, error } = useProcessStore();
  const showLogs = useUIStore((s) => s.showLogMonitor);

  const setFileSession = useFileStore((s) => s.setActiveTool);
  const setProcessSession = useProcessStore((s) => s.setActiveTool);
  const persistFile = useFileStore((s) => s.persistCurrent);
  const persistProcess = useProcessStore((s) => s.persistCurrent);

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    const id = (toolId as ToolId) ?? null;
    setFileSession(id);
    setProcessSession(id);
    return () => {
      persistFile();
      persistProcess();
    };
  }, [toolId, setFileSession, setProcessSession, persistFile, persistProcess]);

  const closeMobileMenu = useCallback(() => setMobileMenuOpen(false), []);

  const tool = TOOLS.find((t) => t.id === toolId);
  const ToolComponent = toolId ? TOOL_COMPONENTS[toolId] : null;

  if (!tool) {
    return (
      <div className="flex h-screen items-center justify-center bg-cream">
        <div className="text-center animate-doodle-pop">
          <p className="mb-4 text-ink-soft text-base">Tool not found.</p>
          <button
            onClick={() => navigate('/')}
            className="text-sm font-medium text-accent hover:text-accent-hover transition-colors"
          >
            &larr; Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-cream overflow-hidden">
      {/* Top header bar */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-cream-border bg-cream-light/80 backdrop-blur-subtle px-4 z-20">
        <button
          onClick={() => navigate('/')}
          className="flex items-center gap-1.5 text-xs font-medium text-ink-muted hover:text-ink transition-colors shrink-0"
        >
          <span className="text-base leading-none">&larr;</span>
          <span className="hidden sm:inline">Dashboard</span>
        </button>
        <span className="text-cream-border text-xs font-bold">/</span>
        <span className="flex items-center gap-1.5 text-xs font-semibold text-ink truncate">
          <span className="text-sm">{tool.icon}</span>
          <span className="truncate">{tool.name}</span>
        </span>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Process button (desktop) */}
        {file && ToolComponent && (
          <div className="hidden lg:block">
            <button
              onClick={() => {
                const toolEl = document.getElementById('tool-process-btn');
                if (toolEl) toolEl.click();
              }}
              className="text-[11px] font-semibold text-accent hover:text-accent-hover transition-colors px-3 py-1 rounded-doodle bg-accent/5 border border-accent/20"
            >
              Process
            </button>
          </div>
        )}

        {/* Mobile menu toggle */}
        <button
          onClick={() => setMobileMenuOpen((v) => !v)}
          className="lg:hidden flex items-center gap-1 text-xs font-medium text-ink-muted hover:text-ink transition-colors"
        >
          <span className="text-sm leading-none">{mobileMenuOpen ? '✕' : '☰'}</span>
          <span>{mobileMenuOpen ? 'Close' : 'Options'}</span>
        </button>
      </header>

      <div className="flex flex-1 overflow-hidden relative">
        {/* Sidebar — desktop always visible, mobile slides in */}
        <aside
          className={`
            absolute inset-y-0 left-0 z-10 w-72 lg:w-80
            flex shrink-0 flex-col border-r border-cream-border bg-cream-light
            transform transition-transform duration-300 ease-in-out
            lg:relative lg:translate-x-0 lg:z-auto
            ${mobileMenuOpen ? 'translate-x-0' : '-translate-x-full'}
          `}
        >
          {/* Sidebar scroll area */}
          <div className="flex-1 overflow-y-auto p-4">
            <p className="mb-4 text-xs text-ink-soft leading-relaxed">{tool.description}</p>

            <FileDropZone />

            {isLargeFile && <MemoryWarning />}
            {codecWarning && (
              <div className="mt-3 rounded-doodle-md border border-warn/20 bg-warn/5 p-3">
                <p className="text-[11px] font-medium text-warn leading-relaxed">{codecWarning}</p>
              </div>
            )}

            {file && ToolComponent && (
              <div className="mt-4" onClick={closeMobileMenu}>
                <ToolComponent />
              </div>
            )}
          </div>

          <div className="border-t border-cream-border p-4">
            <button
              onClick={() => {
                useUIStore.getState().toggleLogMonitor();
                closeMobileMenu();
              }}
              className="w-full text-left text-[11px] font-medium text-ink-muted hover:text-accent transition-colors"
            >
              {showLogs ? 'Hide' : 'Show'} FFmpeg Log Monitor
            </button>
          </div>
        </aside>

        {/* Mobile overlay backdrop */}
        {mobileMenuOpen && (
          <div
            className="fixed inset-0 z-[5] bg-black/50 lg:hidden"
            onClick={closeMobileMenu}
          />
        )}

        {/* Main content */}
        <main className="flex flex-1 flex-col overflow-hidden min-w-0">
          <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
            {file && (
              <VideoPreview />
            )}

            {!file && !isProcessing && (
              <div className="flex h-full items-center justify-center">
                <div className="text-center animate-doodle-pop">
                  <div className="mb-4 text-5xl opacity-30">{tool.icon}</div>
                  <p className="text-sm font-medium text-ink-soft">
                    Import a video to get started
                  </p>
                  <p className="mt-1.5 text-xs text-ink-muted">
                    Drag and drop a file or use the upload area
                    <span className="lg:hidden"> in the options panel</span>
                  </p>
                </div>
              </div>
            )}

            {isProcessing && (
              <div className="mx-auto mt-8 max-w-md animate-fade-in">
                <ProgressBar />
              </div>
            )}

            {error && (
              <div className="mx-auto mt-8 max-w-md rounded-doodle-md border border-danger/20 bg-danger/5 p-4 animate-fade-in">
                <p className="text-xs font-semibold text-danger">Processing Error</p>
                <p className="mt-1 text-[11px] text-danger/80 leading-relaxed">{error}</p>
              </div>
            )}

            {outputUrl && outputBlob && !isProcessing && (
              <div className="mx-auto mt-8 max-w-lg animate-slide-up">
                <OutputActions />
              </div>
            )}
          </div>

          {/* Log monitor */}
          {showLogs && (
            <div className="h-44 shrink-0 border-t border-cream-border bg-cream-light/60">
              <LogMonitor />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
