import { useState } from 'react';
import type { CropParams } from '@/types';
import { useFFmpeg } from '@/hooks/useFFmpeg';
import { cropCommand } from '@/lib/ffmpeg/commands';
import { useFileStore } from '@/stores/file-store';

const ASPECT_RATIOS: { value: CropParams['aspectRatio']; label: string }[] = [
  { value: '9:16', label: '9:16 (TikTok / Reels)' },
  { value: '1:1', label: '1:1 (Square)' },
  { value: '21:9', label: '21:9 (Cinematic)' },
];

export function CropTool() {
  const { process } = useFFmpeg();
  const file = useFileStore((s) => s.file);
  const [params, setParams] = useState<CropParams>({
    aspectRatio: '9:16',
    mode: 'crop',
  });
  const [running, setRunning] = useState(false);

  const handleProcess = async () => {
    if (!file) return;
    setRunning(true);
    try {
      const args = cropCommand('input.mp4', 'output.mp4', params);
      const desc = params.mode === 'crop'
        ? `Cropped to ${params.aspectRatio}`
        : `Padded to ${params.aspectRatio}`;
      const slug = params.mode === 'crop'
        ? `cropped_${params.aspectRatio.replace(':', 'x')}`
        : `padded_${params.aspectRatio.replace(':', 'x')}`;
      await process(args, file, 'output.mp4', {
        duration: 60,
        width: 1920,
        height: 1080,
        codec: 'h264',
        fileSize: file.size,
        fileName: file.name,
      }, desc, slug);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="mt-4 space-y-4">
      <div className="space-y-2">
        <label className="text-xs font-medium text-zinc-400">Aspect Ratio</label>
        <div className="flex gap-1">
          {ASPECT_RATIOS.map((ar) => (
            <button
              key={ar.value}
              onClick={() => setParams({ ...params, aspectRatio: ar.value })}
              className={`flex-1 rounded-md px-2 py-2 text-xs font-medium transition-colors ${
                params.aspectRatio === ar.value
                  ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/40'
                  : 'bg-zinc-800 text-zinc-500 border border-zinc-700 hover:text-zinc-300'
              }`}
            >
              {ar.label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-xs font-medium text-zinc-400">Mode</label>
        <div className="flex gap-1">
          <button
            onClick={() => setParams({ ...params, mode: 'crop' })}
            className={`flex-1 rounded-md px-3 py-2 text-xs font-medium transition-colors ${
              params.mode === 'crop'
                ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/40'
                : 'bg-zinc-800 text-zinc-500 border border-zinc-700 hover:text-zinc-300'
            }`}
          >
            Direct Crop
          </button>
          <button
            onClick={() => setParams({ ...params, mode: 'pad' })}
            className={`flex-1 rounded-md px-3 py-2 text-xs font-medium transition-colors ${
              params.mode === 'pad'
                ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/40'
                : 'bg-zinc-800 text-zinc-500 border border-zinc-700 hover:text-zinc-300'
            }`}
          >
            Blurred Padding
          </button>
        </div>
        <p className="text-xs text-zinc-600">
          {params.mode === 'crop'
            ? 'Crops the video to fit the target aspect ratio.'
            : 'Adds blurred sidebars to fit the target aspect ratio without losing content.'}
        </p>
      </div>

      <button
        onClick={handleProcess}
        disabled={running}
        className="w-full rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-4 py-2.5 text-sm font-medium text-indigo-300 hover:bg-indigo-500/20 transition-colors disabled:opacity-50"
      >
        {running ? 'Processing...' : 'Apply Crop / Reframe'}
      </button>
    </div>
  );
}
