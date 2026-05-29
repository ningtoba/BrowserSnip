import { useState, useEffect } from 'react';
import type { GifParams } from '@/types';
import { useFFmpeg } from '@/hooks/useFFmpeg';
import { gifCommand } from '@/lib/ffmpeg/commands';
import { useFileStore } from '@/stores/file-store';

const MAX_DURATION = 10;

export function GifTool() {
  const { process } = useFFmpeg();
  const file = useFileStore((s) => s.file);
  const storeParams = useFileStore((s) => s.params);
  const setStoreParams = useFileStore((s) => s.setParams);

  const [params, setParams] = useState<GifParams>(() => {
    const p = storeParams as unknown as GifParams;
    if (p.fps) return p;
    return { startTime: 0, duration: 3, fps: 15, width: 480 };
  });
  const [running, setRunning] = useState(false);

  useEffect(() => {
    setStoreParams(params as unknown as Record<string, unknown>);
  }, [params, setStoreParams]);

  const handleProcess = async () => {
    if (!file) return;
    setRunning(true);
    try {
      const args = gifCommand('input.mp4', 'output.gif', params);
      await process(args, file, 'output.gif', {
        duration: Math.min(params.duration, MAX_DURATION),
        width: 1920,
        height: 1080,
        codec: 'h264',
        fileSize: file.size,
        fileName: file.name,
      }, `GIF ${params.width}w ${params.fps}fps`, `gif_${params.width}w`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="mt-4 space-y-4">
      <div className="space-y-2">
        <div className="flex justify-between text-xs">
          <span className="font-extrabold text-ink-soft">Start Time</span>
          <span className="font-mono text-ink">{params.startTime.toFixed(1)}s</span>
        </div>
        <input
          type="range"
          min="0"
          max="60"
          step="0.1"
          value={params.startTime}
          onChange={(e) => setParams({ ...params, startTime: parseFloat(e.target.value) })}
          className="w-full"
        />
      </div>

      <div className="space-y-2">
        <div className="flex justify-between text-xs">
          <span className="font-extrabold text-ink-soft">Duration (max {MAX_DURATION}s)</span>
          <span className="font-mono text-ink">{params.duration.toFixed(1)}s</span>
        </div>
        <input
          type="range"
          min="0.5"
          max={MAX_DURATION}
          step="0.1"
          value={params.duration}
          onChange={(e) => setParams({ ...params, duration: parseFloat(e.target.value) })}
          className="w-full"
        />
      </div>

      <div className="space-y-2">
        <div className="flex justify-between text-xs">
          <span className="font-extrabold text-ink-soft">FPS</span>
          <span className="font-mono text-ink">{params.fps}</span>
        </div>
        <div className="flex gap-1">
          {[10, 15, 20, 30].map((fps) => (
            <button
              key={fps}
              onClick={() => setParams({ ...params, fps })}
              className={`doodle-chip ${
                params.fps === fps ? 'doodle-chip-active' : 'doodle-chip-inactive'
              }`}
            >
              {fps}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex justify-between text-xs">
          <span className="font-extrabold text-ink-soft">Width</span>
          <span className="font-mono text-ink">{params.width}px</span>
        </div>
        <input
          type="range"
          min="240"
          max="720"
          step="10"
          value={params.width}
          onChange={(e) => setParams({ ...params, width: parseInt(e.target.value) })}
          className="w-full"
        />
        <div className="flex justify-between font-mono text-xs text-ink-muted">
          <span>240</span>
          <span>480</span>
          <span>720</span>
        </div>
      </div>

      <button onClick={handleProcess} disabled={running} className="doodle-btn">
        {running ? 'Converting...' : 'Convert to GIF'}
      </button>
    </div>
  );
}
