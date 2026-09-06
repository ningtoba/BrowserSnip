import { useState } from 'react';
import { motion } from 'framer-motion';
import { useFFmpeg } from '@/hooks/useFFmpeg';
import { metadataCommand } from '@/lib/ffmpeg/commands';
import { useFileStore } from '@/stores/file-store';
import { fadeUp, scaleIn, staggerParent } from '@/lib/motion';

export function MetadataTool() {
  const { process } = useFFmpeg();
  const file = useFileStore((s) => s.file);
  const [running, setRunning] = useState(false);

  const handleStrip = async () => {
    if (!file) return;
    setRunning(true);
    try {
      const args = metadataCommand('input.mp4', 'output.mp4');
      await process(args, file, 'output.mp4', {
        duration: 60,
        width: 1920,
        height: 1080,
        codec: 'h264',
        fileSize: file.size,
        fileName: file.name,
      }, 'Metadata stripped', 'stripped');
    } finally {
      setRunning(false);
    }
  };

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={staggerParent}
      className="mt-4 space-y-3"
    >
      <motion.button
        variants={fadeUp}
        onClick={handleStrip}
        disabled={running}
        className="w-full rounded-doodle border border-success/30 bg-success hover:bg-success/90
                   px-4 py-3 text-sm font-bold text-white
                   shadow-doodle hover:shadow-doodle-hover
                   transition-all duration-200
                   active:scale-[0.98] active:shadow-none
                   disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100"
      >
        {running ? 'Stripping...' : 'Strip Metadata'}
      </motion.button>
      <motion.p
        variants={scaleIn}
        className="rounded-[12px] border border-cream-border bg-cream-soft px-3.5 py-2.5 text-xs leading-relaxed text-ink-soft"
      >
        Removes all EXIF data, location tags, creation markers, and hidden
        metadata tracks. Uses stream copy for near-instant execution.
      </motion.p>
    </motion.div>
  );
}
