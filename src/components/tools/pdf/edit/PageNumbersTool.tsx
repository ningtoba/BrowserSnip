import { useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { fadeUp, scaleIn, staggerParent } from '@/lib/motion';
import { usePDFEngine } from '@/hooks/usePDFEngine';
import type { PageNumbersParams } from '@/types';

export function PageNumbersTool() {
  const { process } = usePDFEngine();
  const [params, setParams] = useState<PageNumbersParams>({
    font: 'Helvetica',
    fontSize: 12,
    position: 'bottom-center',
    startAt: 1,
    prefix: '',
    suffix: '',
    pages: 'all',
  });

  const update = <K extends keyof PageNumbersParams>(key: K, value: PageNumbersParams[K]) =>
    setParams((p) => ({ ...p, [key]: value }));

  const handleProcess = useCallback(() => {
    process({ toolId: 'page-numbers', params: params as unknown as Record<string, unknown> });
  }, [process, params]);

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={staggerParent}
      className="doodle-section space-y-3"
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Add Page Numbers</p>

      <motion.section variants={fadeUp} className="rounded-[14px] border border-cream-border bg-white p-4 shadow-doodle">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Start At</label>
            <input type="number" min={1} value={params.startAt}
              onChange={(e) => update('startAt', Number(e.target.value))} className="doodle-input text-center" />
          </div>
          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Font Size: {params.fontSize}</label>
            <input type="range" min={8} max={36} value={params.fontSize}
              onChange={(e) => update('fontSize', Number(e.target.value))} />
          </div>
        </div>
      </motion.section>

      <motion.section variants={fadeUp} className="rounded-[14px] border border-cream-border bg-white p-4 shadow-doodle">
        <label className="mb-2 block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Position</label>
        <div className="grid grid-cols-3 gap-1">
          {(['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'] as const).map((p) => (
            <button key={p} onClick={() => update('position', p)}
              className={`doodle-chip text-[10px] ${params.position === p ? 'doodle-chip-active' : 'doodle-chip-inactive'}`}>
              {p.replace('-', ' ')}
            </button>
          ))}
        </div>
      </motion.section>

      <motion.section variants={fadeUp} className="rounded-[14px] border border-cream-border bg-white p-4 shadow-doodle">
        <div className="grid grid-cols-2 gap-2">
          <input type="text" value={params.prefix} onChange={(e) => update('prefix', e.target.value)}
            placeholder="Prefix" className="doodle-input" />
          <input type="text" value={params.suffix} onChange={(e) => update('suffix', e.target.value)}
            placeholder="Suffix" className="doodle-input" />
        </div>
      </motion.section>

      <motion.div
        variants={scaleIn}
        className="flex items-center justify-between rounded-[12px] border border-cream-border bg-white px-3.5 py-2.5 shadow-doodle"
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Preview:</span>
        <span className="font-mono text-xs font-semibold tabular-nums text-accent">
          {params.prefix}{params.startAt}{params.suffix}
        </span>
      </motion.div>

      <button onClick={handleProcess} id="tool-process-btn" className="doodle-btn">
        Add Page Numbers
      </button>
    </motion.div>
  );
}
