import { useState, useEffect } from 'react';
import type { SpeedParams } from '@/types';
import { useFFmpeg } from '@/hooks/useFFmpeg';
import { speedCommand } from '@/lib/ffmpeg/commands';
import { useFileStore } from '@/stores/file-store';

const PRESETS = [0.25, 0.5, 1.0, 1.5, 2.0, 4.0];

export function SpeedTool() {
  const { process } = useFFmpeg();
  const file = useFileStore((s) => s.file);
  const storeParams = useFileStore((s) => s.params);
  const setStoreParams = useFileStore((s) => s.setParams);

  const [params, setParams] = useState<SpeedParams>(() => {
    const p = storeParams as unknown as SpeedParams;
    if (p.speed) return p;
    return { speed: 1.0 };
  });
  const [running, setRunning] = useState(false);

  useEffect(() => {
    setStoreParams(params as unknown as Record<string, unknown>);
  }, [params, setStoreParams]);

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
      }, `Speed ${params.speed}x`, `speed_${params.speed}x`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="mt-4 space-y-4">
      <div className="space-y-2">
        <label className="text-xs font-extrabold text-ink-soft">Playback Speed</label>
        <div className="grid grid-cols-3 gap-1">
          {PRESETS.map((speed) => (
            <button
              key={speed}
              onClick={() => setParams({ speed })}
              className={`doodle-chip ${
                params.speed === speed ? 'doodle-chip-active' : 'doodle-chip-inactive'
              }`}
            >
              {speed}x
            </button>
          ))}
        </div>

        <div className="flex gap-2 text-xs font-bold">
          {params.speed < 1 && (
            <span className="text-accent">🐢 Slow motion</span>
          )}
          {params.speed > 1 && (
            <span className="text-warn">🐇 Timelapse</span>
          )}
          {params.speed === 1 && (
            <span className="text-ink-muted">Normal speed (no change)</span>
          )}
        </div>
      </div>

      <button
        onClick={handleProcess}
        disabled={running || params.speed === 1.0}
        className="doodle-btn"
      >
        {running ? 'Processing...' : 'Apply Speed Change'}
      </button>
    </div>
  );
}
