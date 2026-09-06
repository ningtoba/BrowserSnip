import { motion } from 'framer-motion';
import { fadeUp, floatLoop } from '@/lib/motion';

export function MemoryWarning() {
  return (
    <motion.div
      variants={fadeUp}
      initial="hidden"
      animate="visible"
      className="mt-3 rounded-doodle-md border border-warn/20 bg-warn/5 p-3"
    >
      <p className="flex items-center gap-1.5 text-[11px] font-semibold text-warn">
        <motion.span aria-hidden {...floatLoop}>⚠️</motion.span>
        Large File Warning
      </p>
      <p className="mt-1 text-[11px] leading-relaxed text-warn/80">
        This file exceeds 500 MB and may cause browser tab crashes due to
        WebAssembly memory limits. Consider using the Compress or Resize tools
        first to reduce the processing load.
      </p>
    </motion.div>
  );
}
