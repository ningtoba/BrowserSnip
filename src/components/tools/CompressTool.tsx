import { useState, useEffect, useMemo } from 'react';
import type { CompressParams } from '@/types';
import { useFFmpeg } from '@/hooks/useFFmpeg';
import { compressCommand } from '@/lib/ffmpeg/commands';
import { useFileStore } from '@/stores/file-store';
import { calculateBitrate } from '@/lib/utils/bitrate';

const SIZE_PRESETS = [10, 25, 50, 100, 250];

export function CompressTool() {
  const { process } = useFFmpeg();
  const file = useFileStore((s) => s.file);
  const storeParams = useFileStore((s) => s.params);
  const setStoreParams = useFileStore((s) => s.setParams);

  const [params, setParams] = useState<CompressParams>(() => {
    const p = storeParams as unknown as CompressParams;
    if (p.targetSizeMB) return p;
    return { targetSizeMB: 25 };
  });
  const [duration, setDuration] = useState(60);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    setStoreParams(params as unknown as Record<string, unknown>);
  }, [params, setStoreParams]);

  useEffect(() => {
    if (!file) return;
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      setDuration(video.duration);
      URL.revokeObjectURL(video.src);
    };
    video.src = URL.createObjectURL(file);
  }, [file]);

  const originalSizeMB = file ? file.size / 1_000_000 : 0;
  const originalBitrate = duration > 0 ? (originalSizeMB * 8000) / duration : 0;
  const targetBitrate = calculateBitrate(params.targetSizeMB, duration);
  const isLarger = params.targetSizeMB >= originalSizeMB;

  const handleProcess = async () => {
    if (!file) return;
    setRunning(true);
    try {
      const args = compressCommand('input.mp4', 'output.mp4', params, duration);
      await process(args, file, 'output.mp4', {
        duration,
        width: 1920,
        height: 1080,
        codec: 'h264',
        fileSize: file.size,
        fileName: file.name,
      }, `Compressed to ${params.targetSizeMB} MB`, `compressed_${params.targetSizeMB}mb`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="mt-4 space-y-4">
      <div className="space-y-2">
        <label className="text-xs font-medium text-zinc-400">
          Target File Size
        </label>
        <div className="flex gap-1">
          {SIZE_PRESETS.map((size) => {
            const tooBig = size >= originalSizeMB;
            return (
              <button
                key={size}
                onClick={() => setParams({ targetSizeMB: size })}
                disabled={tooBig}
                className={`flex-1 rounded-md px-2 py-2 text-xs font-medium transition-colors ${
                  params.targetSizeMB === size
                    ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/40'
                    : tooBig
                      ? 'bg-zinc-800/30 text-zinc-700 border border-zinc-800 cursor-not-allowed'
                      : 'bg-zinc-800 text-zinc-500 border border-zinc-700 hover:text-zinc-300'
                }`}
              >
                {size}MB
              </button>
            );
          })}
        </div>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 space-y-1">
        <div className="flex justify-between text-xs">
          <span className="text-zinc-500">Original size</span>
          <span className="font-mono text-zinc-200">{originalSizeMB.toFixed(1)} MB</span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-zinc-500">Duration</span>
          <span className="font-mono text-zinc-200">{duration.toFixed(1)}s</span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-zinc-500">Target</span>
          <span className={`font-mono ${isLarger ? 'text-amber-400' : 'text-indigo-300'}`}>
            {targetBitrate} kbps
          </span>
        </div>
      </div>

      {isLarger && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
          <p className="text-xs text-amber-300">
            Target ({params.targetSizeMB} MB) is larger than the original ({originalSizeMB.toFixed(1)} MB).
            Select a smaller target to reduce file size.
          </p>
        </div>
      )}

      <button
        onClick={handleProcess}
        disabled={running || isLarger}
        className="w-full rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-4 py-2.5 text-sm font-medium text-indigo-300 hover:bg-indigo-500/20 transition-colors disabled:opacity-50"
      >
        {running ? 'Compressing...' : 'Compress Video'}
      </button>
    </div>
  );
}
