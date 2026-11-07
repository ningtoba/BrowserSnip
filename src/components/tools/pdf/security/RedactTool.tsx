/**
 * RedactTool — Sidebar for Redact PDF.
 *
 * Drag on the preview to draw redaction rectangles, then apply: the boxes go to
 * the registry's `redact` tool as `regions`, so the guard pre-flight, the
 * warnings and the progress rail are the same ones every other tool uses. The
 * text under each box is deleted from the page's content stream — not painted
 * over — and a box that caught nothing is reported instead of counted as a win.
 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import { motion } from 'framer-motion';
import { usePdfTool } from '@/hooks/usePdfTool';
import { useProcessStore } from '@/stores/process-store';
import { fadeUp, scaleIn, staggerParent } from '@/lib/motion';
import { reportMarks } from '@/components/tools/pdf/editor/placement';
import {
  getRedactState, setRedactColor,
  removeRedaction, selectRedaction, getRedactPageSize, subscribeRedact,
} from './RedactMain';

export function RedactTool() {
  const { run, isRunning } = usePdfTool('redact');
  const warnings = useProcessStore((s) => s.warnings);
  const [st, setSt] = useState(getRedactState());

  useEffect(() => subscribeRedact(() => setSt(getRedactState())), []);

  const selected = st.redactions.find((r) => r.id === st.selectedId) ?? null;

  /**
   * E13 and E19, before the click: a box the size of a stray mouse-twitch covers no
   * glyphs, so it would draw a speck and still report a redaction; a box on page 9
   * of a document that now has 3 pages belongs to the file that was open before.
   * Both are counted, named and left out of the run instead of smuggled through.
   */
  const report = useMemo(() => {
    const pageSize = getRedactPageSize();
    return reportMarks(st.redactions, {
      numPages: st.totalPages,
      page: { page: st.page, widthPt: pageSize.width, heightPt: pageSize.height },
      describe: (redaction) =>
        `${Math.round(redaction.w * 100)}% × ${Math.round(redaction.h * 100)}% on page ${redaction.page}`,
    });
  }, [st.page, st.redactions, st.totalPages]);

  const handleProcess = useCallback(() => {
    if (!report.valid) return;
    const pageSize = getRedactPageSize();
    void run({
      // The registry's region list: 0-based page, points in PDF user space with
      // `y` measured from the bottom — the frame the pane already stores.
      regions: report.usable.map((r) => ({
        page: r.page - 1,
        x: Math.round(r.x * pageSize.width),
        y: Math.round(r.y * pageSize.height),
        width: Math.round(r.w * pageSize.width),
        height: Math.round(r.h * pageSize.height),
      })),
      fill: st.color,
    });
  }, [report.usable, run, st.color]);

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

      {/* What the run had to admit: skipped boxes, raster fallback, clamped input. */}
      {warnings.length > 0 && (
        <motion.ul
          variants={scaleIn}
          role="status"
          data-redact-warnings={warnings.length}
          className="space-y-1 rounded-[12px] border border-warn/25 bg-warn/[0.07] p-2.5"
        >
          {warnings.map((warning) => (
            <li key={warning} className="text-[10px] leading-relaxed text-ink-soft">· {warning}</li>
          ))}
        </motion.ul>
      )}

      {/* Boxes that will not survive the run */}
      {report.empty.length + report.offPage.length > 0 && (
        <motion.div variants={scaleIn} className="rounded-[12px] border border-warn/25 bg-warn/[0.07] p-2.5 space-y-1">
          <p className="text-[10px] font-semibold text-warn">
            {report.empty.length + report.offPage.length} of {st.redactions.length} box{st.redactions.length === 1 ? '' : 'es'} will not be written
          </p>
          <ul className="space-y-0.5">
            {report.notes.map((note) => (
              <li key={note} className="text-[10px] leading-relaxed text-ink-soft">· {note}</li>
            ))}
          </ul>
          <button
            onClick={() => {
              for (const r of [...report.empty, ...report.offPage]) removeRedaction(r.id);
            }}
            className="doodle-chip text-[10px] doodle-chip-inactive"
          >
            Remove them
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
        disabled={!report.valid || isRunning}
        title={
          st.redactions.length === 0
            ? 'Drag a rectangle on the preview first — there is nothing to redact yet'
            : !report.valid
              ? 'None of the boxes covers anything this document has'
              : undefined
        }>
        {isRunning ? 'Redacting…' : `Apply ${report.usable.length} Redaction${report.usable.length !== 1 ? 's' : ''}`}
      </button>
    </motion.div>
  );
}
