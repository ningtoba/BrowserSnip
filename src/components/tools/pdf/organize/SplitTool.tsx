import { useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { usePDFEngine } from '@/hooks/usePDFEngine';
import { fadeUp, staggerParent } from '@/lib/motion';
import type { SplitParams } from '@/types';

export function SplitTool() {
  const { process } = usePDFEngine();
  const [params, setParams] = useState<SplitParams>({
    mode: 'ranges',
    ranges: '',
    removeSplitPages: false,
  });

  const handleProcess = useCallback(() => {
    process({ toolId: 'split', params: params as unknown as Record<string, unknown> });
  }, [process, params]);

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={staggerParent}
      className="doodle-section space-y-3"
    >
      <motion.p variants={fadeUp} className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Split PDF</motion.p>

      <motion.div variants={fadeUp} className="space-y-2">
        <label className="block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Split Mode</label>
        <div className="flex gap-1">
          {(['ranges', 'every-page', 'odd-even'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setParams((p) => ({ ...p, mode }))}
              className={`doodle-chip ${params.mode === mode ? 'doodle-chip-active' : 'doodle-chip-inactive'}`}
            >
              {mode === 'ranges' ? 'By Ranges' : mode === 'every-page' ? 'Every Page' : 'Odd/Even'}
            </button>
          ))}
        </div>

        {params.mode === 'ranges' && (
          <div>
            <label className="block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Page Ranges</label>
            <input
              type="text"
              value={params.ranges}
              onChange={(e) => setParams((p) => ({ ...p, ranges: e.target.value }))}
              placeholder="e.g. 1-5,7,9-12"
              className="doodle-input mt-1"
            />
            <p className="text-[10px] text-ink-muted mt-1">
              Each range becomes a separate PDF. Use commas to separate ranges.
            </p>
          </div>
        )}
      </motion.div>

      <button onClick={handleProcess} id="tool-process-btn" className="doodle-btn">
        Split PDF
      </button>
    </motion.div>
  );
}
