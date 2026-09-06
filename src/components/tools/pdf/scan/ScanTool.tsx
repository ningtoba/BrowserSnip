import { useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { useFileStore } from '@/stores/file-store';
import { usePDFEngine } from '@/hooks/usePDFEngine';
import { fadeUp, scaleIn, staggerParent } from '@/lib/motion';

type PageSize = 'a4' | 'letter' | 'original' | 'fit';
type Orientation = 'portrait' | 'landscape';

export function ScanTool() {
  const files = useFileStore((s) => s.files);
  const { process } = usePDFEngine();
  const [pageSize, setPageSize] = useState<PageSize>('a4');
  const [orientation, setOrientation] = useState<Orientation>('portrait');
  const [margin, setMargin] = useState(10);

  const imageCount = files.length;

  const handleProcess = useCallback(() => {
    process({
      toolId: 'scan-to-pdf',
      params: {
        pageSize,
        orientation,
        margin,
        fitMode: 'contain' as const,
      },
    });
  }, [process, pageSize, orientation, margin]);

  if (imageCount === 0) {
    return (
      <motion.div
        initial="hidden"
        animate="visible"
        variants={staggerParent}
        className="doodle-section"
      >
        <motion.p variants={fadeUp} className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted mb-1">Scan to PDF</motion.p>
        <p className="text-[11px] text-ink-muted">
          Use your camera to scan document pages. Captured images will appear here.
        </p>
        <div className="mt-3 flex items-center gap-2 text-[10px] text-ink-muted">
          <span className="w-2 h-2 rounded-full bg-success animate-pulse" />
          Camera ready — tap the button below the preview to capture
        </div>
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
      <motion.div variants={fadeUp}>
        <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Scan to PDF</p>
        <p className="text-[11px] text-ink-muted mt-0.5">
          {imageCount} page{imageCount !== 1 ? 's' : ''} captured
        </p>
      </motion.div>

      {/* Page size */}
      <motion.div variants={fadeUp}>
        <label className="block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Page Size</label>
        <select
          value={pageSize}
          onChange={(e) => setPageSize(e.target.value as PageSize)}
          className="doodle-input mt-1 text-[11px]"
        >
          <option value="a4">A4</option>
          <option value="letter">Letter</option>
          <option value="fit">Fit to image</option>
          <option value="original">Original size</option>
        </select>
      </motion.div>

      {/* Orientation */}
      <motion.div variants={fadeUp}>
        <label className="block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Orientation</label>
        <select
          value={orientation}
          onChange={(e) => setOrientation(e.target.value as Orientation)}
          className="doodle-input mt-1 text-[11px]"
        >
          <option value="portrait">Portrait</option>
          <option value="landscape">Landscape</option>
        </select>
      </motion.div>

      {/* Margin */}
      <motion.div variants={fadeUp}>
        <label className="block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
          Margin: <span className="tabular-nums">{margin}px</span>
        </label>
        <input
          type="range"
          min={0}
          max={40}
          value={margin}
          onChange={(e) => setMargin(Number(e.target.value))}
          className="w-full mt-1"
        />
      </motion.div>

      <motion.div
        variants={scaleIn}
        className="flex items-center justify-between rounded-[12px] border border-cream-border bg-white px-3.5 py-2.5 shadow-doodle"
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Pages</span>
        <span className="font-mono text-xs font-semibold tabular-nums text-accent">{imageCount}</span>
      </motion.div>

      <button onClick={handleProcess} id="tool-process-btn" className="doodle-btn w-full">
        Generate PDF
      </button>
    </motion.div>
  );
}
