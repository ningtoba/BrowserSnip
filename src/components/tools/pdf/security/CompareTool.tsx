/**
 * CompareTool — Sidebar for Compare PDF.
 *
 * Adjust sensitivity and highlight color, then generate a
 * comparison PDF with differences highlighted.
 */
import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { useFileStore } from '@/stores/file-store';
import { usePDFEngine } from '@/hooks/usePDFEngine';
import { fadeUp, scaleIn, staggerParent } from '@/lib/motion';
import {
  getCompareState, setCompareSensitivity, setCompareHighlightColor,
  subscribeCompare,
} from './CompareMain';

export function CompareTool() {
  const files = useFileStore((s) => s.files);
  const { process } = usePDFEngine();
  const [st, setSt] = useState(getCompareState());

  useEffect(() => subscribeCompare(() => setSt(getCompareState())), []);

  const handleProcess = useCallback(() => {
    process({
      toolId: 'compare',
      params: {
        highlightColor: st.highlightColor,
        sensitivity: st.sensitivity,
      } as unknown as Record<string, unknown>,
    });
  }, [process, st.highlightColor, st.sensitivity]);

  if (files.length < 2) {
    return (
      <motion.div
        initial="hidden"
        animate="visible"
        variants={staggerParent}
        className="doodle-section space-y-3"
      >
        <motion.p variants={fadeUp} className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Compare PDFs</motion.p>
        <p className="text-[11px] text-ink-muted leading-relaxed">
          Add 2 PDF files to compare them. Differences will be highlighted on the preview and in the output.
        </p>
        <motion.div variants={scaleIn} className="p-3 rounded-[12px] border border-cream-border bg-cream-soft">
          <p className="text-[10px] text-ink-muted">
            {files.length === 0 ? 'No files loaded.' : `${files.length} file(s) loaded — need 2.`}
          </p>
        </motion.div>
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
      <motion.p variants={fadeUp} className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Compare PDFs</motion.p>

      {/* File info */}
      <motion.div variants={fadeUp} className="p-3 rounded-[12px] border border-cream-border bg-white space-y-1 shadow-doodle">
        <p className="text-[10px] text-ink-muted font-mono truncate">
          A: {files[0]?.name}
        </p>
        <p className="text-[10px] text-ink-muted font-mono truncate">
          B: {files[1]?.name}
        </p>
      </motion.div>

      {/* Diff stats */}
      <motion.div variants={scaleIn} className="rounded-[12px] border border-cream-border bg-white p-3 text-center shadow-doodle">
        <p className="text-2xl font-bold text-accent tabular-nums">{st.diffPercent}%</p>
        <p className="text-[10px] text-ink-muted">of pixels differ</p>
      </motion.div>

      {/* Sensitivity */}
      <motion.div variants={fadeUp}>
        <label className="block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
          Sensitivity: <span className="tabular-nums">{st.sensitivity}</span>
        </label>
        <input type="range" min={5} max={150} value={st.sensitivity}
          onChange={(e) => setCompareSensitivity(Number(e.target.value))}
          className="w-full" />
        <div className="flex justify-between text-[8px] text-ink-muted/50">
          <span>More sensitive</span>
          <span>Less sensitive</span>
        </div>
      </motion.div>

      {/* Highlight color */}
      <motion.div variants={fadeUp}>
        <label className="block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Highlight Color</label>
        <input type="color" value={st.highlightColor}
          onChange={(e) => setCompareHighlightColor(e.target.value)}
          className="w-full h-6 rounded-[10px] bg-cream border border-cream-border mt-1 cursor-pointer" />
      </motion.div>

      {/* Info */}
      <motion.p variants={scaleIn} className="rounded-[12px] border border-cream-border bg-cream-soft px-3.5 py-2.5 text-[10px] text-ink-muted leading-relaxed">
        Differences are computed pixel-by-pixel. Lower sensitivity catches more subtle changes. The output PDF shows document A with differences from B highlighted.
      </motion.p>

      <button onClick={handleProcess} id="tool-process-btn" className="doodle-btn">
        Generate Comparison PDF
      </button>
    </motion.div>
  );
}
