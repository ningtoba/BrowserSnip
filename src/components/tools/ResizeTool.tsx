import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import type { ResizeParams } from '@/types';
import { useFFmpeg } from '@/hooks/useFFmpeg';
import { resizeCommand } from '@/lib/ffmpeg/commands';
import { useFileStore } from '@/stores/file-store';
import { PRESETS, calculateHeight } from '@/lib/utils/aspect-ratio';
import { fadeUp, staggerParent } from '@/lib/motion';

const PRESET_OPTIONS = ['1080p', '720p', '480p', '360p', 'custom'] as const;

export function ResizeTool() {
  const { process } = useFFmpeg();
  const file = useFileStore((s) => s.file);
  const storeParams = useFileStore((s) => s.params);
  const setStoreParams = useFileStore((s) => s.setParams);

  const [params, setParams] = useState<ResizeParams>(() => {
    const p = storeParams as unknown as ResizeParams;
    if (p.preset) return p;
    return { width: 1920, height: 1080, lockAspectRatio: true, preset: '1080p' };
  });
  const [running, setRunning] = useState(false);

  useEffect(() => {
    setStoreParams(params as unknown as Record<string, unknown>);
  }, [params, setStoreParams]);

  const handlePreset = (preset: ResizeParams['preset']) => {
    if (preset === 'custom') {
      setParams({ ...params, preset });
      return;
    }
    const dims = PRESETS[preset];
    setParams({ ...params, preset, width: dims.width, height: dims.height });
  };

  const handleWidth = (w: number) => {
    setParams({
      ...params,
      width: w,
      height: params.lockAspectRatio ? calculateHeight(w, 1920, 1080) : params.height,
      preset: 'custom',
    });
  };

  const handleHeight = (h: number) => {
    setParams({
      ...params,
      height: h,
      width: params.lockAspectRatio ? Math.round(h * (1920 / 1080)) : params.width,
      preset: 'custom',
    });
  };

  const handleProcess = async () => {
    if (!file) return;
    setRunning(true);
    try {
      const args = resizeCommand('input.mp4', 'output.mp4', params);
      const resolution = params.preset === 'custom'
        ? `${params.width}x${params.height}`
        : params.preset;
      await process(args, file, 'output.mp4', {
        duration: 60,
        width: 1920,
        height: 1080,
        codec: 'h264',
        fileSize: file.size,
        fileName: file.name,
      }, `Resized to ${resolution}`, `resized_${resolution}`);
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
        <label className="mb-2 block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Preset</label>
        <div className="flex gap-1">
          {PRESET_OPTIONS.map((p) => (
            <button
              key={p}
              onClick={() => handlePreset(p)}
              className={`doodle-chip ${
                params.preset === p ? 'doodle-chip-active' : 'doodle-chip-inactive'
              }`}
            >
              {p}
            </button>
          ))}
        </div>
      </motion.section>

      <motion.section variants={fadeUp} className="grid grid-cols-2 gap-3 rounded-[14px] border border-cream-border bg-white p-4 shadow-doodle">
        <div className="space-y-1">
          <label className="block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Width</label>
          <input
            type="number"
            value={params.width}
            onChange={(e) => handleWidth(parseInt(e.target.value) || 0)}
            className="doodle-input font-mono tabular-nums"
          />
        </div>
        <div className="space-y-1">
          <label className="block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Height</label>
          <input
            type="number"
            value={params.height}
            onChange={(e) => handleHeight(parseInt(e.target.value) || 0)}
            className="doodle-input font-mono tabular-nums"
          />
        </div>
      </motion.section>

      <motion.label
        variants={fadeUp}
        className="flex items-center gap-2 text-xs font-bold text-ink-soft cursor-pointer"
      >
        <input
          type="checkbox"
          checked={params.lockAspectRatio}
          onChange={(e) => setParams({ ...params, lockAspectRatio: e.target.checked })}
          className="h-4 w-4 rounded border-2 border-cream-border accent-accent"
        />
        Lock aspect ratio
      </motion.label>

      <button onClick={handleProcess} disabled={running} className="doodle-btn">
        {running ? 'Processing...' : 'Resize Video'}
      </button>
    </motion.div>
  );
}
