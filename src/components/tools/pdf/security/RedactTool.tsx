/**
 * RedactTool — Sidebar for Redact PDF.
 *
 * Drag on the preview to draw redaction rectangles, then apply
 * to permanently draw opaque rectangles over sensitive areas.
 */
import { useState, useEffect, useCallback } from 'react';
import { usePDFEngine } from '@/hooks/usePDFEngine';
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
    <div className="doodle-section space-y-3">
      <p className="text-xs font-semibold text-ink">Redact PDF</p>

      {/* Warning */}
      <div className="rounded bg-danger/5 border border-danger/20 p-2 space-y-1">
        <p className="text-[10px] font-semibold text-danger">⚠ Permanent Redaction</p>
        <p className="text-[10px] text-ink-soft leading-relaxed">
          This draws opaque rectangles over sensitive content and flattens the PDF. Redacted data cannot be recovered.
        </p>
      </div>

      {/* Color */}
      <div>
        <label className="text-[10px] text-ink-muted">Redaction Color</label>
        <input type="color" value={st.color}
          onChange={(e) => setRedactColor(e.target.value)}
          className="w-full h-6 rounded bg-cream border border-cream-border mt-1 cursor-pointer" />
      </div>

      {/* Instructions */}
      <p className="text-[10px] text-ink-muted leading-relaxed">
        <strong>Drag</strong> on the PDF preview to draw redaction rectangles. Click a rectangle to select it, then press <strong>Delete</strong> or use the list below to remove it.
      </p>

      {/* Selected info */}
      {selected && (
        <div className="border-t border-cream-border pt-2 space-y-1">
          <p className="text-[10px] font-medium text-ink-muted">Selected · Page {selected.page}</p>
          <div className="grid grid-cols-2 gap-1 text-[10px] text-ink-muted">
            <span>X: {(selected.x * 100).toFixed(0)}%</span>
            <span>Y: {(selected.y * 100).toFixed(0)}%</span>
            <span>W: {(selected.w * 100).toFixed(0)}%</span>
            <span>H: {(selected.h * 100).toFixed(0)}%</span>
          </div>
          <button onClick={() => removeRedaction(selected.id)}
            className="doodle-chip text-[10px] text-red-400 w-full">
            Remove Selected
          </button>
        </div>
      )}

      {/* Redaction list */}
      {st.redactions.length > 0 && (
        <div className="border-t border-cream-border pt-2">
          <p className="text-[10px] font-medium text-ink-muted mb-1.5">
            Redactions ({st.redactions.length})
          </p>
          <div className="space-y-1 max-h-36 overflow-y-auto">
            {st.redactions.map((r) => (
              <div key={r.id}
                onClick={() => selectRedaction(r.id)}
                className={`flex items-center gap-2 p-1.5 rounded cursor-pointer text-[10px]
                  ${r.id === st.selectedId ? 'bg-accent/10 border border-accent/30' : 'bg-cream/50 border border-transparent hover:bg-cream'}`}
              >
                <span className="w-3 h-3 rounded-sm shrink-0" style={{ background: st.color }} />
                <span className="flex-1">p.{r.page} · {(r.w * 100).toFixed(0)}%×{(r.h * 100).toFixed(0)}%</span>
                <button onClick={(e) => { e.stopPropagation(); removeRedaction(r.id); }}
                  className="text-red-400 hover:text-red-500 text-xs shrink-0">✕</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Page summary */}
      {st.redactions.length > 0 && (
        <p className="text-[10px] text-ink-muted">
          {Array.from(pageCounts.entries()).sort(([a], [b]) => a - b).map(([p, n]) => `p.${p}: ${n}`).join(' · ')}
        </p>
      )}

      <button onClick={handleProcess} id="tool-process-btn" className="doodle-btn-danger"
        disabled={st.redactions.length === 0}>
        Apply {st.redactions.length} Redaction{st.redactions.length !== 1 ? 's' : ''}
      </button>
    </div>
  );
}
