import { useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { useFileStore } from '@/stores/file-store';
import { usePDFEngine } from '@/hooks/usePDFEngine';
import { fadeUp, staggerParent } from '@/lib/motion';

export function MergeTool() {
  const files = useFileStore((s) => s.files);
  const reorderFiles = useFileStore((s) => s.reorderFiles);
  const { process } = usePDFEngine();
  const [order, setOrder] = useState<number[]>([]);

  const handleProcess = useCallback(() => {
    process({
      toolId: 'merge',
      params: { fileOrder: order },
    });
  }, [process, order]);

  if (files.length < 2) {
    return (
      <motion.div
        initial="hidden"
        animate="visible"
        variants={staggerParent}
        className="doodle-section"
      >
        <motion.p variants={fadeUp} className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted mb-1">Merge PDF</motion.p>
        <p className="text-[11px] text-ink-muted">
          Add at least 2 PDF files to merge them into a single document.
        </p>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={staggerParent}
      className="doodle-section space-y-3"
    >
      <motion.p variants={fadeUp} className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
        Merge {files.length} PDFs
      </motion.p>

      <div className="space-y-1.5">
        {files.map((f, i) => (
          <motion.div
            key={`${f.name}-${i}`}
            variants={fadeUp}
            transition={{ delay: Math.min(i, 8) * 0.03 }}
            className="flex items-center gap-2 p-2 rounded-[10px] bg-cream border border-cream-border"
          >
            <span className="text-[10px] font-mono text-ink-muted w-5 text-center">
              {i + 1}
            </span>
            <span className="text-[11px] text-ink truncate flex-1">{f.name}</span>
            <div className="flex gap-1">
              <button
                onClick={() => reorderFiles(i, i - 1)}
                disabled={i === 0}
                className="text-[10px] text-ink-muted hover:text-ink disabled:opacity-20 px-1"
              >
                ↑
              </button>
              <button
                onClick={() => reorderFiles(i, i + 1)}
                disabled={i === files.length - 1}
                className="text-[10px] text-ink-muted hover:text-ink disabled:opacity-20 px-1"
              >
                ↓
              </button>
            </div>
          </motion.div>
        ))}
      </div>

      <button onClick={handleProcess} id="tool-process-btn" className="doodle-btn">
        Merge {files.length} Files
      </button>
    </motion.div>
  );
}
