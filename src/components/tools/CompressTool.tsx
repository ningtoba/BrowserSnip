import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import type { CompressParams } from '@/types';
import { useFFmpeg } from '@/hooks/useFFmpeg';
import { compressCommand } from '@/lib/ffmpeg/commands';
import { useFileStore } from '@/stores/file-store';
import { calculateBitrate } from '@/lib/utils/bitrate';
import { fadeUp, staggerParent } from '@/lib/motion';

const PCT_PRESETS = [25, 50, 75];

export function CompressTool() {
  const { process } = useFFmpeg();
  const file = useFileStore((s) => s.file);
  const storeParams = useFileStore((s) => s.params);
  const setStoreParams = useFileStore((s) => s.setParams);

  const [params, setParams] = useState<CompressParams>(() => {
    const p = storeParams as unknown as CompressParams;
    if (p.targetSizeMB) return p;
    return { targetSizeMB: 10 };
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
  const targetBitrate = calculateBitrate(params.targetSizeMB, duration);
  const pct = originalSizeMB > 0
    ? Math.round((params.targetSizeMB / originalSizeMB) * 100)
    : 100;

  const handlePctPreset = useCallback((p: number) => {
    const size = Math.max(1, Math.round((originalSizeMB * p) / 100));
    setParams({ targetSizeMB: size });
  }, [originalSizeMB]);

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

  if (!file || originalSizeMB === 0) return null;

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={staggerParent}
      className="mt-4 space-y-4"
    >
      <motion.section variants={fadeUp} className="space-y-2 rounded-[14px] border border-cream-border bg-white p-4 shadow-doodle">
        <div className="flex justify-between text-xs">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Target Size</span>
          <span className="font-mono font-bold tabular-nums text-accent">
            {params.targetSizeMB} MB ({pct}% of original)
          </span>
        </div>

        <input
          type="range"
          min={Math.max(1, Math.round(originalSizeMB * 0.05))}
          max={Math.round(originalSizeMB * 0.95)}
          step={1}
          value={params.targetSizeMB}
          onChange={(e) => setParams({ targetSizeMB: parseInt(e.target.value) })}
          className="w-full"
        />
        <div className="flex justify-between font-mono text-xs tabular-nums text-ink-muted">
          <span>~{Math.max(1, Math.round(originalSizeMB * 0.05))} MB</span>
          <span>~{Math.round(originalSizeMB * 0.95)} MB</span>
        </div>
      </motion.section>

      <motion.div variants={fadeUp} className="flex gap-1">
        {PCT_PRESETS.map((p) => {
          const size = Math.max(1, Math.round((originalSizeMB * p) / 100));
          const active = params.targetSizeMB === size;
          return (
            <button
              key={p}
              onClick={() => handlePctPreset(p)}
              className={`doodle-chip ${
                active ? 'doodle-chip-active' : 'doodle-chip-inactive'
              }`}
            >
              {p}% (~{size} MB)
            </button>
          );
        })}
      </motion.div>

      <motion.section variants={fadeUp} className="doodle-section space-y-2">
        <div className="flex justify-between text-xs">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Original</span>
          <span className="font-mono tabular-nums text-ink">{originalSizeMB.toFixed(1)} MB</span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Duration</span>
          <span className="font-mono tabular-nums text-ink">{duration.toFixed(1)}s</span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Target bitrate</span>
          <span className="font-mono font-extrabold tabular-nums text-accent">{targetBitrate} kbps</span>
        </div>
      </motion.section>

      <button onClick={handleProcess} disabled={running} className="doodle-btn">
        {running ? 'Compressing...' : 'Compress Video'}
      </button>
    </motion.div>
  );
}
