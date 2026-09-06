import { useMemo } from 'react';
import { motion } from 'framer-motion';
import { useFileStore } from '@/stores/file-store';
import { useProcessStore } from '@/stores/process-store';
import { fadeUp, staggerParent } from '@/lib/motion';

export function VideoPreview() {
  const file = useFileStore((s) => s.file);
  const isProcessing = useProcessStore((s) => s.isProcessing);

  const inputUrl = useMemo(
    () => (file ? URL.createObjectURL(file) : null),
    [file]
  );

  if (!inputUrl) return null;

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={staggerParent}
      className="mx-auto max-w-3xl"
    >
      <motion.div variants={fadeUp} className="overflow-hidden rounded-[14px] border border-cream-border bg-white shadow-doodle">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          src={inputUrl}
          controls
          className={`w-full block ${isProcessing ? 'opacity-40' : ''}`}
        >
          Your browser does not support the video element.
        </video>
      </motion.div>
      <p className="mt-2 text-center font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
        Original source
      </p>
    </motion.div>
  );
}
