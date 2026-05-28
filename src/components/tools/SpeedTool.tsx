import { useState } from 'react';
import type { SpeedParams } from '@/types';
import { useFFmpeg } from '@/hooks/useFFmpeg';
import { speedCommand } from '@/lib/ffmpeg/commands';
import { useFileStore } from '@/stores/file-store';

const PRESETS = [0.25, 0.5, 1.0, 1.5, 2.0, 4.0];

export function SpeedTool() {
  const { process } = useFFmpeg();
  const file = useFileStore((s) => s.file);
  const [params, setParams] = useState<SpeedParams>({ speed: 1.0 });
  const [running, setRunning] = useState(false);

  const handleProcess = async () => {
    if (!file || params.speed === 1.0) return;
    setRunning(true);
    try {
      const args = speedCommand('input.mp4', 'output.mp4', params);
      await process(args, file, 'output.mp4', {
        duration: 60,
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
      <div className="space-y-2">
        <label className="text-xs font-medium text-zinc-400">Playback Speed</label>
        <div className="grid grid-cols-3 gap-1">
          {PRESETS.map((speed) => (
            <button
              key={speed}
              onClick={() => setParams({ speed })}
              className={`rounded-md px-3 py-2 text-xs font-medium transition-colors ${
                params.speed === speed
                  ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/40'
                  : 'bg-zinc-800 text-zinc-500 border border-zinc-700 hover:text-zinc-300'
              }`}
            >
              {speed}x
            </button>
          ))}
        </div>

        <div className="flex gap-2 text-xs text-zinc-500">
          <span className={params.speed < 1 ? 'text-cyan-400' : ''}>
            {params.speed < 1 ? 'Slow motion' : ''}
          </span>
          <span className={params.speed > 1 ? 'text-amber-400' : ''}>
            {params.speed > 1 ? 'Timelapse' : ''}
          </span>
          {params.speed === 1 && <span>Normal speed (no change)</span>}
        </div>
      </div>

      <button
        onClick={handleProcess}
        disabled={running || params.speed === 1.0}
        className="w-full rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-4 py-2.5 text-sm font-medium text-indigo-300 hover:bg-indigo-500/20 transition-colors disabled:opacity-50"
      >
        {running ? 'Processing...' : 'Apply Speed Change'}
      </button>
    </div>
  );
}
