import { useState, useEffect } from 'react';
import type { CropParams } from '@/types';
import { useFFmpeg } from '@/hooks/useFFmpeg';
import { cropCommand } from '@/lib/ffmpeg/commands';
import { useFileStore } from '@/stores/file-store';

const ASPECT_RATIOS: { value: CropParams['aspectRatio']; label: string }[] = [
  { value: '9:16', label: '9:16 (TikTok / Reels)' },
  { value: '1:1', label: '1:1 (Square)' },
  { value: '21:9', label: '21:9 (Cinematic)' },
];

const DEFAULT_PARAMS: CropParams = { aspectRatio: '9:16' };

export function CropTool() {
  const { process } = useFFmpeg();
  const file = useFileStore((s) => s.file);
  const storeParams = useFileStore((s) => s.params);
  const setStoreParams = useFileStore((s) => s.setParams);

  const [params, setParams] = useState<CropParams>(
    (storeParams.aspectRatio
      ? storeParams
      : DEFAULT_PARAMS) as CropParams
  );

  // Sync local params to store whenever they change
  useEffect(() => {
    setStoreParams(params as unknown as Record<string, unknown>);
  }, [params, setStoreParams]);

  const [running, setRunning] = useState(false);

  const handleProcess = async () => {
    if (!file) return;
    setRunning(true);
    try {
      const args = cropCommand('input.mp4', 'output.mp4', params);
      const slug = `cropped_${params.aspectRatio.replace(':', 'x')}`;
      await process(args, file, 'output.mp4', {
        duration: 60,
        width: 1920,
        height: 1080,
        codec: 'h264',
        fileSize: file.size,
        fileName: file.name,
      }, `Cropped to ${params.aspectRatio}`, slug);
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
              onClick={() => setParams({ aspectRatio: ar.value })}
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

      <p className="text-xs text-zinc-600">
        Crops the video to the selected aspect ratio, centered on the original frame.
      </p>

      <button
        onClick={handleProcess}
        disabled={running}
        className="w-full rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-4 py-2.5 text-sm font-medium text-indigo-300 hover:bg-indigo-500/20 transition-colors disabled:opacity-50"
      >
        {running ? 'Processing...' : 'Crop Video'}
      </button>
    </div>
  );
}
