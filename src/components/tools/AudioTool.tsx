import { useState } from 'react';
import type { AudioParams } from '@/types';
import { useFFmpeg } from '@/hooks/useFFmpeg';
import { audioCommand } from '@/lib/ffmpeg/commands';
import { useFileStore } from '@/stores/file-store';

export function AudioTool() {
  const { process } = useFFmpeg();
  const file = useFileStore((s) => s.file);
  const [params, setParams] = useState<AudioParams>({ mode: 'mute', volume: 1.0 });
  const [running, setRunning] = useState(false);

  const handleProcess = async () => {
    if (!file) return;
    setRunning(true);
    try {
      const ext = params.mode === 'extract' ? 'mp3' : 'mp4';
      const outName = `output.${ext}`;
      const args = audioCommand('input.mp4', outName, params);
      await process(args, file, outName, {
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
        <label className="text-xs font-medium text-zinc-400">Mode</label>
        <div className="flex gap-1">
          {(['mute', 'extract', 'volume'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setParams({ ...params, mode })}
              className={`flex-1 rounded-md px-3 py-2 text-xs font-medium transition-colors ${
                params.mode === mode
                  ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/40'
                  : 'bg-zinc-800 text-zinc-500 border border-zinc-700 hover:text-zinc-300'
              }`}
            >
              {mode === 'mute' ? 'Mute' : mode === 'extract' ? 'Extract MP3' : 'Volume'}
            </button>
          ))}
        </div>
      </div>

      {params.mode === 'volume' && (
        <div className="space-y-2">
          <div className="flex justify-between text-xs text-zinc-500">
            <span>Volume</span>
            <span className="font-mono">{(params.volume * 100).toFixed(0)}%</span>
          </div>
          <input
            type="range"
            min="0"
            max="3"
            step="0.1"
            value={params.volume}
            onChange={(e) => setParams({ ...params, volume: parseFloat(e.target.value) })}
            className="w-full"
          />
          <div className="flex justify-between text-xs text-zinc-700">
            <span>0%</span>
            <span>100%</span>
            <span>300%</span>
          </div>
        </div>
      )}

      <button
        onClick={handleProcess}
        disabled={running}
        className="w-full rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-4 py-2.5 text-sm font-medium text-indigo-300 hover:bg-indigo-500/20 transition-colors disabled:opacity-50"
      >
        {running ? 'Processing...' : 'Apply Audio Changes'}
      </button>
    </div>
  );
}
