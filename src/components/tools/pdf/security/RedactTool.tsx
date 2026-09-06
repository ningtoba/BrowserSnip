/**
 * RedactTool — Sidebar for Redact PDF.
 *
 * Drag on the preview to draw redaction rectangles, then apply
 * to permanently draw opaque rectangles over sensitive areas.
 */
import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { usePDFEngine } from '@/hooks/usePDFEngine';
import { fadeUp, scaleIn, staggerParent } from '@/lib/motion';
import {
  getRedactState, setRedactPage, setRedactColor,
  removeRedaction, selectRedaction, getRedactPageSize, subscribeRedact,
} from './RedactMain';
import type { Redaction } from './RedactMain';

export function RedactTool() {
  const { process } = usePDFEngine();
  const [st, setSt] = useState(getRedactState());

  useEffect(() => subscribeRedact(() => setSt(getRedactState())), []);

  const selected = st.redactions.find((r) => r.id === st.selectedId) ?? null;

  const handleProcess = useCallback(() => {
    const pageSize = getRedactPageSize();
    const redactions = st.redactions.map((r) => ({
      page: r.page,
      x: Math.round(r.x * pageSize.width),
      y: Math.round(r.y * pageSize.height),
      width: Math.round(r.w * pageSize.width),
      height: Math.round(r.h * pageSize.height),
    }));
    if (redactions.length === 0) return;
    process({
      toolId: 'redact',
      params: {
        redactions,
        redactionColor: st.color,
      },
    });
  }, [process, st.redactions, st.color]);

  const pageCounts = new Map<number, number>();
  for (const r of st.redactions) {
    pageCounts.set(r.page, (pageCounts.get(r.page) ?? 0) + 1);
  }

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={staggerParent}
      className="doodle-section space-y-3"
    >
      <motion.p variants={fadeUp} className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Redact PDF</motion.p>

      {/* Warning */}
      <motion.div variants={scaleIn} className="rounded-[12px] border border-danger/25 bg-danger/[0.07] p-2.5 space-y-1">
        <p className="text-[10px] font-semibold text-danger">⚠ Permanent Redaction</p>
        <p className="text-[10px] text-ink-soft leading-relaxed">
          This draws opaque rectangles over sensitive content and flattens the PDF. Redacted data cannot be recovered.
        </p>
      </motion.div>

      {/* Color */}
      <motion.div variants={fadeUp}>
        <label className="block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Redaction Color</label>
        <input type="color" value={st.color}
          onChange={(e) => setRedactColor(e.target.value)}
          className="w-full h-6 rounded-[10px] bg-cream border border-cream-border mt-1 cursor-pointer" />
      </motion.div>

      {/* Instructions */}
      <motion.p variants={scaleIn} className="rounded-[12px] border border-cream-border bg-cream-soft px-3.5 py-2.5 text-[10px] text-ink-muted leading-relaxed">
        <strong>Drag</strong> on the PDF preview to draw redaction rectangles. Click a rectangle to select it, then press <strong>Delete</strong> or use the list below to remove it.
      </motion.p>

      {/* Selected info */}
      {selected && (
        <motion.div variants={scaleIn} className="rounded-[12px] border border-cream-border bg-white p-3 space-y-1 shadow-doodle">
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Selected · Page {selected.page}</p>
          <div className="grid grid-cols-2 gap-1 text-[10px] text-ink-muted font-mono tabular-nums">
            <span>X: {(selected.x * 100).toFixed(0)}%</span>
            <span>Y: {(selected.y * 100).toFixed(0)}%</span>
            <span>W: {(selected.w * 100).toFixed(0)}%</span>
            <span>H: {(selected.h * 100).toFixed(0)}%</span>
          </div>
          <button onClick={() => removeRedaction(selected.id)}
            className="doodle-chip text-[10px] text-danger w-full">
            Remove Selected
          </button>
        </motion.div>
      )}

      {/* Redaction list */}
      {st.redactions.length > 0 && (
        <motion.div variants={fadeUp} className="border-t border-cream-border pt-2">
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted mb-1.5">
            Redactions ({st.redactions.length})
          </p>
          <div className="space-y-1 max-h-36 overflow-y-auto">
            {st.redactions.map((r) => (
              <motion.div key={r.id}
                onClick={() => selectRedaction(r.id)}
                whileHover={{ y: -2 }}
                whileTap={{ scale: 0.97 }}
                transition={{ duration: 0.2 }}
                className={`flex items-center gap-2 p-1.5 rounded-[10px] cursor-pointer text-[10px]
                  ${r.id === st.selectedId ? 'bg-accent/[0.06] border border-accent/60 shadow-glow' : 'bg-white border border-cream-border hover:border-[#D5D5CD]'}`}
              >
                <span className="w-3 h-3 rounded-sm shrink-0" style={{ background: st.color }} />
                <span className="flex-1">p.{r.page} · {(r.w * 100).toFixed(0)}%×{(r.h * 100).toFixed(0)}%</span>
                <button onClick={(e) => { e.stopPropagation(); removeRedaction(r.id); }}
                  className="text-danger hover:text-danger/80 text-xs shrink-0 transition-colors duration-150">✕</button>
              </motion.div>
            ))}
          </div>
        </motion.div>
      )}

      {/* Page summary */}
      {st.redactions.length > 0 && (
        <p className="text-[10px] text-ink-muted font-mono tabular-nums">
          {Array.from(pageCounts.entries()).sort(([a], [b]) => a - b).map(([p, n]) => `p.${p}: ${n}`).join(' · ')}
        </p>
      )}

      <button onClick={handleProcess} id="tool-process-btn" className="doodle-btn-danger"
        disabled={st.redactions.length === 0}>
        Apply {st.redactions.length} Redaction{st.redactions.length !== 1 ? 's' : ''}
      </button>
    </motion.div>
  );
}
