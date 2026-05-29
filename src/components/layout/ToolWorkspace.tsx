import { useEffect } from 'react';
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
import { StitchTool } from '@/components/tools/StitchTool';
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
  stitch: StitchTool,
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

  // Switch to this tool's session on mount / tool change.
  // Cleanup saves the session before navigating away or unmounting.
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
      <div className="flex h-screen items-center justify-center">
        <div className="text-center">
          <p className="mb-4 text-zinc-500">Tool not found.</p>
          <button
            onClick={() => navigate('/')}
            className="text-sm text-indigo-400 hover:text-indigo-300"
          >
            &larr; Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col lg:flex-row">
      {/* Sidebar */}
      <aside className="flex w-full shrink-0 flex-col border-b border-zinc-800 bg-zinc-900/50 lg:w-80 lg:border-b-0 lg:border-r">
        <div className="flex items-center gap-3 border-b border-zinc-800 px-5 py-4">
          <button
            onClick={() => navigate('/')}
            className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            &larr; Tools
          </button>
          <span className="text-zinc-700">/</span>
          <span className="text-sm font-medium text-zinc-200">
            {tool.icon} {tool.name}
          </span>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          <p className="mb-4 text-xs text-zinc-500">{tool.description}</p>

          <FileDropZone />

          {isLargeFile && <MemoryWarning />}
          {codecWarning && (
            <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
              <p className="text-xs text-amber-300">{codecWarning}</p>
            </div>
          )}

          {file && ToolComponent && <ToolComponent />}
        </div>

        <div className="border-t border-zinc-800 p-5">
          <button
            onClick={() => useUIStore.getState().toggleLogMonitor()}
            className="w-full text-left text-xs font-medium text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            {showLogs ? 'Hide' : 'Show'} FFmpeg Log Monitor
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex flex-1 flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto p-6">
          {file && (
            <VideoPreview />
          )}

          {!file && !isProcessing && (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <div className="mb-3 text-5xl">{tool.icon}</div>
                <p className="text-zinc-600">
                  Import a video file to start using {tool.name}
                </p>
              </div>
            </div>
          )}

          {isProcessing && (
            <div className="mx-auto mt-8 max-w-md">
              <ProgressBar />
            </div>
          )}

          {error && (
            <div className="mx-auto mt-8 max-w-md rounded-lg border border-red-500/30 bg-red-500/10 p-4">
              <p className="text-sm font-medium text-red-400">Processing Error</p>
              <p className="mt-1 text-xs text-red-300/80">{error}</p>
            </div>
          )}

          {outputUrl && outputBlob && !isProcessing && (
            <div className="mx-auto mt-8 max-w-md">
              <OutputActions />
            </div>
          )}
        </div>

        {showLogs && (
          <div className="h-48 shrink-0 border-t border-zinc-800">
            <LogMonitor />
          </div>
        )}
      </main>
    </div>
  );
}
