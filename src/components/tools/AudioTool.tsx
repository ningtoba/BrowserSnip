import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import type { AudioParams } from '@/types';
import { useFFmpeg } from '@/hooks/useFFmpeg';
import { audioCommand } from '@/lib/ffmpeg/commands';
import { useFileStore } from '@/stores/file-store';
import { fadeUp, staggerParent } from '@/lib/motion';

export function AudioTool() {
  const { process } = useFFmpeg();
  const file = useFileStore((s) => s.file);
  const storeParams = useFileStore((s) => s.params);
  const setStoreParams = useFileStore((s) => s.setParams);

  const [params, setParams] = useState<AudioParams>(() => {
    const p = storeParams as unknown as AudioParams;
    if (p.mode) return p;
    return { mode: 'mute', volume: 1.0 };
  });
  const [running, setRunning] = useState(false);

  useEffect(() => {
    setStoreParams(params as unknown as Record<string, unknown>);
  }, [params, setStoreParams]);

  const handleProcess = async () => {
    if (!file) return;
    setRunning(true);
    try {
      const ext = params.mode === 'extract' ? 'mp3' : 'mp4';
      const outName = `output.${ext}`;
      const args = audioCommand('input.mp4', outName, params);
      const label = params.mode === 'mute'
        ? 'Muted video' : params.mode === 'extract'
        ? 'Extracted MP3' : `Volume ${Math.round(params.volume * 100)}%`;
      const slug = params.mode === 'mute'
        ? 'muted' : params.mode === 'extract'
        ? 'audio' : `volume_${Math.round(params.volume * 100)}`;
      await process(args, file, outName, {
        duration: 60,
        width: 1920,
        height: 1080,
        codec: 'h264',
        fileSize: file.size,
        fileName: file.name,
      }, label, slug);
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
        <label className="mb-2 block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Mode</label>
        <div className="flex gap-1">
          {(['mute', 'extract', 'volume'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setParams({ ...params, mode })}
              className={`doodle-chip ${
                params.mode === mode ? 'doodle-chip-active' : 'doodle-chip-inactive'
              }`}
            >
              {mode === 'mute' ? 'Mute' : mode === 'extract' ? 'Extract MP3' : 'Volume'}
            </button>
          ))}
        </div>
      </motion.section>

      {params.mode === 'volume' && (
        <motion.section variants={fadeUp} className="space-y-2 rounded-[14px] border border-cream-border bg-white p-4 shadow-doodle">
          <div className="flex justify-between text-xs">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Volume</span>
            <span className="font-mono tabular-nums text-ink">{(params.volume * 100).toFixed(0)}%</span>
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
          <div className="flex justify-between font-mono text-xs tabular-nums text-ink-muted">
            <span>0%</span>
            <span>100%</span>
            <span>300%</span>
          </div>
        </motion.section>
      )}

      <button onClick={handleProcess} disabled={running} className="doodle-btn">
        {running ? 'Processing...' : 'Apply Audio Changes'}
      </button>
    </motion.div>
  );
}
