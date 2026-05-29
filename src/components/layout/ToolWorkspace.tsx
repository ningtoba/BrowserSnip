import { useEffect, useState, useCallback, useRef } from 'react';
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

  const [showSideTools, setShowSideTools] = useState(false);
  const mainRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const id = (toolId as ToolId) ?? null;
    setFileSession(id);
    setProcessSession(id);
    return () => {
      persistFile();
      persistProcess();
    };
  }, [toolId, setFileSession, setProcessSession, persistFile, persistProcess]);

  const tool = TOOLS.find((t) => t.id === toolId);
  const ToolComponent = toolId ? TOOL_COMPONENTS[toolId] : null;

  if (!tool) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#0a0b10]">
        <div className="text-center animate-fade-in">
          <p className="mb-4 text-sm text-[#5c6080]">Tool not found.</p>
          <button
            onClick={() => navigate('/')}
            className="text-xs font-medium text-[#6366f1] hover:text-[#818cf8] transition-colors"
          >
            &larr; Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-[#0a0b10] overflow-hidden">
      {/* ── Top bar ── */}
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-[#1e2035] bg-[#0d0f17]/90 backdrop-blur-subtle px-3 sm:px-4 z-20">
        <button
          onClick={() => navigate('/')}
          className="flex items-center gap-1 text-[11px] font-medium text-[#5c6080] hover:text-[#a8adc4] transition-colors shrink-0"
        >
          <span className="text-sm leading-none">&larr;</span>
          <span className="hidden sm:inline">Dashboard</span>
        </button>
        <span className="text-[#1e2035] text-xs font-bold">/</span>
        <span className="flex items-center gap-1.5 text-[11px] font-semibold text-[#eeeff5] truncate">
          <span className="text-sm">{tool.icon}</span>
          <span className="truncate">{tool.name}</span>
        </span>

        <div className="flex-1" />

        {/* Desktop: process quick-action */}
        {file && ToolComponent && (
          <button
            onClick={() => {
              const el = document.getElementById('tool-process-btn');
              if (el) el.click();
            }}
            className="hidden sm:inline-flex items-center gap-1 text-[11px] font-semibold text-[#6366f1] hover:text-[#818cf8] transition-colors px-2.5 py-1 rounded-md bg-[#6366f1]/10 border border-[#6366f1]/20"
          >
            Process
          </button>
        )}

        {/* Log toggle */}
        <button
          onClick={() => useUIStore.getState().toggleLogMonitor()}
          className="text-[11px] font-medium text-[#5c6080] hover:text-[#a8adc4] transition-colors shrink-0"
        >
          {showLogs ? 'Hide Log' : 'Log'}
        </button>

        {/* Mobile: Show tool options toggle (only when file is loaded) */}
        {file && ToolComponent && (
          <button
            onClick={() => setShowSideTools((v) => !v)}
            className="sm:hidden text-[11px] font-semibold text-[#6366f1] hover:text-[#818cf8] transition-colors shrink-0"
          >
            {showSideTools ? 'Done' : 'Options'}
          </button>
        )}
      </header>

      {/* ── Body: desktop has sidebar + main; mobile stacks inline ── */}
      <div className="flex flex-1 overflow-hidden" ref={mainRef}>
        {/* Sidebar — desktop: permanent 320px panel */}
        <aside className="hidden sm:flex w-72 lg:w-80 shrink-0 flex-col border-r border-[#1e2035] bg-[#0d0f17]">
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            <FileDropZone />
            {isLargeFile && <MemoryWarning />}
            {codecWarning && (
              <div className="rounded-md border border-[#f59e0b]/20 bg-[#f59e0b]/5 p-3">
                <p className="text-[11px] font-medium text-[#f59e0b] leading-relaxed">{codecWarning}</p>
              </div>
            )}
            {file && ToolComponent && <ToolComponent />}
          </div>
        </aside>

        {/* Main content area */}
        <main className="flex flex-1 flex-col overflow-hidden min-w-0">
          {/* Mobile: inline upload + tools area (no drawer!) */}
          <div className="sm:hidden flex flex-col flex-1 overflow-hidden min-h-0">
            {/* File drop zone always visible inline */}
            <div className="shrink-0 p-3 pb-0">
              <FileDropZone />
              {isLargeFile && <div className="mt-2"><MemoryWarning /></div>}
              {codecWarning && (
                <div className="mt-2 rounded-md border border-[#f59e0b]/20 bg-[#f59e0b]/5 p-2.5">
                  <p className="text-[10px] font-medium text-[#f59e0b] leading-relaxed">{codecWarning}</p>
                </div>
              )}
            </div>

            {!file && !isProcessing && (
              <div className="flex flex-1 items-center justify-center p-4">
                <div className="text-center opacity-40">
                  <div className="mb-3 text-4xl">{tool.icon}</div>
                  <p className="text-xs font-medium text-[#5c6080]">
                    Import a video to get started
                  </p>
                </div>
              </div>
            )}

            {file && (
              <>
                {/* Video preview — takes remaining space */}
                <div className="flex-1 min-h-0 p-3 flex items-center justify-center overflow-hidden">
                  <VideoPreview />
                </div>

                {/* Tool options — slides up as bottom sheet when toggled */}
                {ToolComponent && (
                  <div className={`shrink-0 border-t border-[#1e2035] bg-[#0d0f17] transition-all duration-300 ${showSideTools ? 'max-h-[60vh] overflow-y-auto' : 'max-h-0 overflow-hidden'}`}>
                    <div className="p-3">
                      <ToolComponent />
                    </div>
                  </div>
                )}
              </>
            )}

            {/* Processing progress */}
            {isProcessing && (
              <div className="shrink-0 p-3 border-t border-[#1e2035]">
                <ProgressBar />
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="shrink-0 p-3 border-t border-[#dc2626]/20">
                <div className="rounded-md border border-[#dc2626]/20 bg-[#dc2626]/5 p-3">
                  <p className="text-[11px] font-semibold text-[#dc2626]">Processing Error</p>
                  <p className="mt-1 text-[11px] text-[#dc2626]/80 leading-relaxed">{error}</p>
                </div>
              </div>
            )}

            {/* Output */}
            {outputUrl && outputBlob && !isProcessing && (
              <div className="shrink-0 p-3 border-t border-[#1e2035] overflow-y-auto max-h-[45vh]">
                <OutputActions />
              </div>
            )}

            {/* Log monitor (compact on mobile) */}
            {showLogs && (
              <div className="h-36 shrink-0 border-t border-[#1e2035] bg-[#0d0f17]">
                <LogMonitor />
              </div>
            )}
          </div>

          {/* Desktop: main content */}
          <div className="hidden sm:flex flex-1 flex-col overflow-hidden">
            <div className="flex-1 overflow-y-auto p-6 lg:p-8">
              {file && <VideoPreview />}

              {!file && !isProcessing && (
                <div className="flex h-full items-center justify-center">
                  <div className="text-center opacity-40">
                    <div className="mb-4 text-5xl">{tool.icon}</div>
                    <p className="text-sm font-medium text-[#5c6080]">
                      Import a video to get started
                    </p>
                    <p className="mt-1.5 text-xs text-[#5c6080]/70">
                      Drag & drop a file or use the upload area on the left
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
                <div className="mx-auto mt-8 max-w-md rounded-md border border-[#dc2626]/20 bg-[#dc2626]/5 p-4 animate-fade-in">
                  <p className="text-xs font-semibold text-[#dc2626]">Processing Error</p>
                  <p className="mt-1 text-[11px] text-[#dc2626]/80 leading-relaxed">{error}</p>
                </div>
              )}

              {outputUrl && outputBlob && !isProcessing && (
                <div className="mx-auto mt-8 max-w-2xl animate-slide-up">
                  <OutputActions />
                </div>
              )}
            </div>

            {showLogs && (
              <div className="h-44 shrink-0 border-t border-[#1e2035] bg-[#0d0f17]/60">
                <LogMonitor />
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
