import { useCallback } from 'react';
import { motion } from 'framer-motion';
import { fadeUp, scaleIn, staggerParent } from '@/lib/motion';
import { usePDFEngine } from '@/hooks/usePDFEngine';

export function RepairTool() {
  const { process } = usePDFEngine();

  const handleProcess = useCallback(() => {
    process({ toolId: 'repair', params: {} });
  }, [process]);

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={staggerParent}
      className="doodle-section space-y-3"
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Repair PDF</p>

      <motion.p variants={fadeUp} className="text-[11px] text-ink-muted leading-relaxed">
        Rebuilds the PDF structure by copying all pages into a fresh
        document. This fixes broken cross-reference tables, corrupted
        page trees, and invalid object references.
      </motion.p>

      <motion.ul variants={fadeUp} className="text-[10px] text-ink-muted space-y-1 list-disc list-inside">
        <li>Rebuilds xref table and object graph</li>
        <li>Strips broken encryption and annotations</li>
        <li>Preserves all readable page content</li>
        <li>Metadata is kept when readable</li>
      </motion.ul>

      <motion.div
        variants={scaleIn}
        className="rounded-[12px] border border-warn/20 bg-warn/[0.06] p-2.5"
      >
        <p className="text-[10px] text-warn">
          Severely corrupted files where the PDF parser fails entirely
          cannot be recovered in the browser.
        </p>
      </motion.div>

      <button onClick={handleProcess} id="tool-process-btn" className="doodle-btn">
        Repair PDF
      </button>
    </motion.div>
  );
}
