import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import type { SpeedParams } from '@/types';
import { useFFmpeg } from '@/hooks/useFFmpeg';
import { speedCommand } from '@/lib/ffmpeg/commands';
import { useFileStore } from '@/stores/file-store';
import { fadeUp, scaleIn, staggerParent } from '@/lib/motion';

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
    <motion.div
      initial="hidden"
      animate="visible"
      variants={staggerParent}
      className="mt-4 space-y-4"
    >
      <motion.section variants={fadeUp} className="rounded-[14px] border border-cream-border bg-white p-4 shadow-doodle">
        <label className="mb-2 block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Playback Speed</label>
        <div className="grid grid-cols-3 gap-1.5">
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

        <div className="mt-3 flex gap-2 text-xs font-bold">
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
      </motion.section>

      {params.speed !== 1 && (
        <motion.div
          variants={scaleIn}
          className="flex items-center justify-between rounded-[12px] border border-cream-border bg-white px-3.5 py-2.5 shadow-doodle"
        >
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Selected</span>
          <span className="font-mono text-xs font-semibold tabular-nums text-accent">{params.speed}x</span>
        </motion.div>
      )}

      <button
        onClick={handleProcess}
        disabled={running || params.speed === 1.0}
        className="doodle-btn"
      >
        {running ? 'Processing...' : 'Apply Speed Change'}
      </button>
    </motion.div>
  );
}
