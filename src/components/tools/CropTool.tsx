import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import type { CropParams } from '@/types';
import { useFFmpeg } from '@/hooks/useFFmpeg';
import { cropCommand } from '@/lib/ffmpeg/commands';
import { useFileStore } from '@/stores/file-store';
import { fadeUp, scaleIn, staggerParent } from '@/lib/motion';

const ASPECT_RATIOS: { value: CropParams['aspectRatio']; label: string }[] = [
  { value: '9:16', label: '9:16 (TikTok / Reels)' },
  { value: '1:1', label: '1:1 (Square)' },
  { value: '21:9', label: '21:9 (Cinematic)' },
];

const DEFAULT_PARAMS: CropParams = { aspectRatio: '9:16' };

export function CropTool() {
  const { process } = useFFmpeg();
  const file = useFileStore((s) => s.file);
  const storeParams = useFileStore((s) => s.params);
  const setStoreParams = useFileStore((s) => s.setParams);

  const [params, setParams] = useState<CropParams>(
    (storeParams.aspectRatio
      ? storeParams
      : DEFAULT_PARAMS) as CropParams
  );

  useEffect(() => {
    setStoreParams(params as unknown as Record<string, unknown>);
  }, [params, setStoreParams]);

  const [running, setRunning] = useState(false);

  const handleProcess = async () => {
    if (!file) return;
    setRunning(true);
    try {
      const args = cropCommand('input.mp4', 'output.mp4', params);
      const slug = `cropped_${params.aspectRatio.replace(':', 'x')}`;
      await process(args, file, 'output.mp4', {
        duration: 60,
        width: 1920,
        height: 1080,
        codec: 'h264',
        fileSize: file.size,
        fileName: file.name,
      }, `Cropped to ${params.aspectRatio}`, slug);
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
        <label className="mb-2 block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Aspect Ratio</label>
        <div className="flex gap-1">
          {ASPECT_RATIOS.map((ar) => (
            <button
              key={ar.value}
              onClick={() => setParams({ aspectRatio: ar.value })}
              className={`doodle-chip text-xs ${
                params.aspectRatio === ar.value
                  ? 'doodle-chip-active'
                  : 'doodle-chip-inactive'
              }`}
            >
              {ar.label}
            </button>
          ))}
        </div>
      </motion.section>

      <motion.p
        variants={scaleIn}
        className="rounded-[12px] border border-cream-border bg-cream-soft px-3.5 py-2.5 text-xs leading-relaxed text-ink-soft"
      >
        Crops the video to the selected aspect ratio, centered on the original frame.
      </motion.p>

      <button onClick={handleProcess} disabled={running} className="doodle-btn">
        {running ? 'Processing...' : 'Crop Video'}
      </button>
    </motion.div>
  );
}
