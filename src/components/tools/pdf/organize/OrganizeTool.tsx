import { useCallback } from 'react';
import { motion } from 'framer-motion';
import { useFileStore } from '@/stores/file-store';
import { usePDFEngine } from '@/hooks/usePDFEngine';
import { fadeUp, scaleIn, staggerParent } from '@/lib/motion';

export function OrganizeTool() {
  const file = useFileStore((s) => s.file);
  const params = useFileStore((s) => s.params);
  const setParams = useFileStore((s) => s.setParams);
  const { process } = usePDFEngine();

  const pageOrder = (params.pageOrder as number[]) ?? [];
  const pageCount = pageOrder.length;
  const isDefaultOrder = pageOrder.every((p: number, i: number) => p === i);

  const handleProcess = useCallback(() => {
    if (pageOrder.length === 0) return;
    process({ toolId: 'organize', params: { pageOrder } });
  }, [process, pageOrder]);

  const handleReset = useCallback(() => {
    setParams({ ...params, pageOrder: Array.from({ length: pageCount }, (_, i) => i) });
  }, [params, setParams, pageCount]);

  if (!file) {
    return (
      <motion.div
        initial="hidden"
        animate="visible"
        variants={staggerParent}
        className="doodle-section"
      >
        <motion.p variants={fadeUp} className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted mb-1">Organize Pages</motion.p>
        <p className="text-[11px] text-ink-muted">
          Import a PDF to reorder, rotate, or delete pages.
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
      <motion.div variants={fadeUp} className="flex items-center justify-between">
        <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
          Organize {pageCount} Page{pageCount !== 1 ? 's' : ''}
        </p>
        {!isDefaultOrder && (
          <button
            onClick={handleReset}
            className="text-[10px] font-medium text-ink-muted hover:text-ink transition-colors duration-150"
          >
            Reset order
          </button>
        )}
      </motion.div>

      <motion.p variants={scaleIn} className="text-[10px] text-ink-muted leading-relaxed">
        Drag page thumbnails in the main area to reorder them.
        {!isDefaultOrder && (
          <span className="block mt-1 text-accent font-medium">
            Custom order active — {pageCount} pages will be rearranged.
          </span>
        )}
      </motion.p>

      <button onClick={handleProcess} id="tool-process-btn" className="doodle-btn w-full">
        Reorder Pages
      </button>
    </motion.div>
  );
}
