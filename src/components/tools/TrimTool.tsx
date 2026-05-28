import { useState, useEffect } from 'react';
import type { TrimParams } from '@/types';
import { useFFmpeg } from '@/hooks/useFFmpeg';
import { trimCommand } from '@/lib/ffmpeg/commands';
import { useFileStore } from '@/stores/file-store';
import { TrimScrubber } from '@/components/player/TrimScrubber';

export function TrimTool() {
  const { process } = useFFmpeg();
  const file = useFileStore((s) => s.file);
  const [duration, setDuration] = useState(60);
  const [params, setParams] = useState<TrimParams>({
    startTime: 0,
    endTime: 60,
    mode: 'lossless',
  });
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!file) return;
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      setDuration(video.duration);
      setParams((p) => ({ ...p, endTime: video.duration }));
      URL.revokeObjectURL(video.src);
    };
    video.src = URL.createObjectURL(file);
  }, [file]);

  const handleProcess = async () => {
    if (!file) return;
    setRunning(true);
    try {
      const args = trimCommand('input.mp4', 'output.mp4', params);
      await process(args, file, 'output.mp4', {
        duration,
        width: 1920,
        height: 1080,
        codec: 'h264',
        fileSize: file.size,
        fileName: file.name,
      });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="mt-4 space-y-4">
      <TrimScrubber
        duration={duration}
        startTime={params.startTime}
        endTime={params.endTime}
        onStartChange={(t) => setParams({ ...params, startTime: t })}
        onEndChange={(t) => setParams({ ...params, endTime: t })}
      />

      <div className="space-y-2">
        <label className="text-xs font-medium text-zinc-400">Cut Mode</label>
        <div className="flex gap-1">
          <button
            onClick={() => setParams({ ...params, mode: 'lossless' })}
            className={`flex-1 rounded-md px-3 py-2 text-xs font-medium transition-colors ${
              params.mode === 'lossless'
                ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/40'
                : 'bg-zinc-800 text-zinc-500 border border-zinc-700 hover:text-zinc-300'
            }`}
          >
            Lossless (Fast, keyframe-accurate)
          </button>
          <button
            onClick={() => setParams({ ...params, mode: 'accurate' })}
            className={`flex-1 rounded-md px-3 py-2 text-xs font-medium transition-colors ${
              params.mode === 'accurate'
                ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/40'
                : 'bg-zinc-800 text-zinc-500 border border-zinc-700 hover:text-zinc-300'
            }`}
          >
            Accurate (Re-encode, frame-precise)
          </button>
        </div>
      </div>

      <button
        onClick={handleProcess}
        disabled={running}
        className="w-full rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-4 py-2.5 text-sm font-medium text-indigo-300 hover:bg-indigo-500/20 transition-colors disabled:opacity-50"
      >
        {running ? 'Cutting...' : 'Trim Video'}
      </button>
    </div>
  );
}
