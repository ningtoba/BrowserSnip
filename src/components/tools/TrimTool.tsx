import { useState, useEffect, useCallback } from 'react';
import type { TrimParams } from '@/types';
import { useFFmpeg } from '@/hooks/useFFmpeg';
import { trimCommand } from '@/lib/ffmpeg/commands';
import { useFileStore } from '@/stores/file-store';
import { TrimScrubber } from '@/components/player/TrimScrubber';
import { formatDisplayTime } from '@/lib/utils/time';

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

  const clamp = useCallback(
    (value: number, min: number, max: number) => Math.max(min, Math.min(max, value)),
    []
  );

  const handleStartInput = useCallback(
    (value: number) => {
      const t = clamp(value, 0, params.endTime - 0.001);
      setParams({ ...params, startTime: t });
    },
    [params, clamp]
  );

  const handleEndInput = useCallback(
    (value: number) => {
      const t = clamp(value, params.startTime + 0.001, duration);
      setParams({ ...params, endTime: t });
    },
    [params, duration, clamp]
  );

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
      {/* Time inputs */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs font-medium text-zinc-400">Start Time</label>
          <input
            type="number"
            min={0}
            max={params.endTime - 0.001}
            step={0.001}
            value={params.startTime.toFixed(3)}
            onChange={(e) => handleStartInput(parseFloat(e.target.value) || 0)}
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 font-mono text-sm text-zinc-200 focus:border-indigo-500 focus:outline-none"
          />
          <p className="font-mono text-xs text-zinc-600">
            {formatDisplayTime(params.startTime)}
          </p>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-zinc-400">End Time</label>
          <input
            type="number"
            min={params.startTime + 0.001}
            max={duration}
            step={0.001}
            value={params.endTime.toFixed(3)}
            onChange={(e) => handleEndInput(parseFloat(e.target.value) || duration)}
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 font-mono text-sm text-zinc-200 focus:border-indigo-500 focus:outline-none"
          />
          <p className="font-mono text-xs text-zinc-600">
            {formatDisplayTime(params.endTime)}
          </p>
        </div>
      </div>

      {/* Duration readout */}
      <div className="flex justify-between rounded-md border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-xs">
        <span className="text-zinc-500">Selected Duration</span>
        <span className="font-mono text-indigo-300">
          {(params.endTime - params.startTime).toFixed(3)}s
        </span>
      </div>

      {/* Scrubber */}
      <TrimScrubber
        duration={duration}
        startTime={params.startTime}
        endTime={params.endTime}
        onStartChange={(t) => setParams({ ...params, startTime: t })}
        onEndChange={(t) => setParams({ ...params, endTime: t })}
      />

      {/* Mode */}
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
            Lossless
          </button>
          <button
            onClick={() => setParams({ ...params, mode: 'accurate' })}
            className={`flex-1 rounded-md px-3 py-2 text-xs font-medium transition-colors ${
              params.mode === 'accurate'
                ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/40'
                : 'bg-zinc-800 text-zinc-500 border border-zinc-700 hover:text-zinc-300'
            }`}
          >
            Accurate
          </button>
        </div>
        <p className="text-xs text-zinc-600">
          {params.mode === 'lossless'
            ? 'Stream copy — instant but cuts at nearest keyframes.'
            : 'Re-encode — frame-precise but slower.'}
        </p>
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
