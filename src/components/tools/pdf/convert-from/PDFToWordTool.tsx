import { useCallback } from 'react';
import { motion } from 'framer-motion';
import { staggerParent } from '@/lib/motion';
import { usePDFEngine } from '@/hooks/usePDFEngine';

export function PDFToWordTool() {
  const { process } = usePDFEngine();

  const handleProcess = useCallback(() => {
    process({ toolId: 'pdf-to-word', params: {} });
  }, [process]);

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={staggerParent}
      className="doodle-section space-y-3"
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">PDF to Word</p>
      <p className="text-[10px] text-ink-muted leading-relaxed">
        Extracts text with formatting (bold, italic, font sizes) and produces
        a proper .docx file that opens in Word, Google Docs, or LibreOffice.
      </p>
      <button onClick={handleProcess} id="tool-process-btn" className="doodle-btn">
        Extract Text
      </button>
    </motion.div>
  );
}
