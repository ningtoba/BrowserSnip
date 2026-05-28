import { useState } from 'react';
import type { ResizeParams } from '@/types';
import { useFFmpeg } from '@/hooks/useFFmpeg';
import { resizeCommand } from '@/lib/ffmpeg/commands';
import { useFileStore } from '@/stores/file-store';
import { PRESETS, calculateHeight } from '@/lib/utils/aspect-ratio';

const PRESET_OPTIONS = ['1080p', '720p', '480p', '360p', 'custom'] as const;

export function ResizeTool() {
  const { process } = useFFmpeg();
  const file = useFileStore((s) => s.file);
  const [params, setParams] = useState<ResizeParams>({
    width: 1920,
    height: 1080,
    lockAspectRatio: true,
    preset: '1080p',
  });
  const [running, setRunning] = useState(false);

  const handlePreset = (preset: ResizeParams['preset']) => {
    if (preset === 'custom') {
      setParams({ ...params, preset });
      return;
    }
    const dims = PRESETS[preset];
    setParams({ ...params, preset, width: dims.width, height: dims.height });
  };

  const handleWidth = (w: number) => {
    setParams({
      ...params,
      width: w,
      height: params.lockAspectRatio ? calculateHeight(w, 1920, 1080) : params.height,
      preset: 'custom',
    });
  };

  const handleHeight = (h: number) => {
    setParams({
      ...params,
      height: h,
      width: params.lockAspectRatio ? Math.round(h * (1920 / 1080)) : params.width,
      preset: 'custom',
    });
  };

  const handleProcess = async () => {
    if (!file) return;
    setRunning(true);
    try {
      const args = resizeCommand('input.mp4', 'output.mp4', params);
      const resolution = params.preset === 'custom'
        ? `${params.width}x${params.height}`
        : params.preset;
      await process(args, file, 'output.mp4', {
        duration: 60,
        width: 1920,
        height: 1080,
        codec: 'h264',
        fileSize: file.size,
        fileName: file.name,
      }, `Resized to ${resolution}`, `resized_${resolution}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="mt-4 space-y-4">
      <div className="space-y-2">
        <label className="text-xs font-medium text-zinc-400">Preset</label>
        <div className="flex gap-1">
          {PRESET_OPTIONS.map((p) => (
            <button
              key={p}
              onClick={() => handlePreset(p)}
              className={`flex-1 rounded-md px-2 py-2 text-xs font-medium transition-colors ${
                params.preset === p
                  ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/40'
                  : 'bg-zinc-800 text-zinc-500 border border-zinc-700 hover:text-zinc-300'
              }`}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs text-zinc-500">Width</label>
          <input
            type="number"
            value={params.width}
            onChange={(e) => handleWidth(parseInt(e.target.value) || 0)}
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 font-mono focus:border-indigo-500 focus:outline-none"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-zinc-500">Height</label>
          <input
            type="number"
            value={params.height}
            onChange={(e) => handleHeight(parseInt(e.target.value) || 0)}
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 font-mono focus:border-indigo-500 focus:outline-none"
          />
        </div>
      </div>

      <label className="flex items-center gap-2 text-xs text-zinc-500">
        <input
          type="checkbox"
          checked={params.lockAspectRatio}
          onChange={(e) => setParams({ ...params, lockAspectRatio: e.target.checked })}
          className="rounded border-zinc-700 bg-zinc-800 accent-indigo-500"
        />
        Lock aspect ratio
      </label>

      <button
        onClick={handleProcess}
        disabled={running}
        className="w-full rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-4 py-2.5 text-sm font-medium text-indigo-300 hover:bg-indigo-500/20 transition-colors disabled:opacity-50"
      >
        {running ? 'Processing...' : 'Resize Video'}
      </button>
    </div>
  );
}
