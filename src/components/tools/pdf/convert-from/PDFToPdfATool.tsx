import { useCallback } from 'react';
import { motion } from 'framer-motion';
import { staggerParent } from '@/lib/motion';
import { usePDFEngine } from '@/hooks/usePDFEngine';

export function PDFToPdfATool() {
  const { process } = usePDFEngine();

  const handleProcess = useCallback(() => {
    process({ toolId: 'pdf-to-pdfa', params: {} });
  }, [process]);

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={staggerParent}
      className="doodle-section space-y-3"
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">PDF to PDF/A</p>
      <p className="text-[10px] text-ink-muted leading-relaxed">
        Converts your PDF to PDF/A-2b archival format. Strips JavaScript,
        encryption, and interactive features. Adds XMP metadata and conformance
        markers for long-term preservation.
      </p>
      <button onClick={handleProcess} id="tool-process-btn" className="doodle-btn">
        Convert to PDF/A
      </button>
    </motion.div>
  );
}
