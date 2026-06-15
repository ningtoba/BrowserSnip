/**
 * CompareTool — Sidebar for Compare PDF.
 *
 * Adjust sensitivity and highlight color, then generate a
 * comparison PDF with differences highlighted.
 */
import { useState, useEffect, useCallback } from 'react';
import { useFileStore } from '@/stores/file-store';
import { usePDFEngine } from '@/hooks/usePDFEngine';
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
      <div className="doodle-section space-y-3">
        <p className="text-xs font-semibold text-ink">Compare PDFs</p>
        <p className="text-[11px] text-ink-muted leading-relaxed">
          Add 2 PDF files to compare them. Differences will be highlighted on the preview and in the output.
        </p>
        <div className="p-3 rounded bg-cream border border-cream-border">
          <p className="text-[10px] text-ink-muted">
            {files.length === 0 ? 'No files loaded.' : `${files.length} file(s) loaded — need 2.`}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="doodle-section space-y-3">
      <p className="text-xs font-semibold text-ink">Compare PDFs</p>

      {/* File info */}
      <div className="p-3 rounded bg-cream border border-cream-border space-y-1">
        <p className="text-[10px] text-ink-muted font-mono truncate">
          A: {files[0]?.name}
        </p>
        <p className="text-[10px] text-ink-muted font-mono truncate">
          B: {files[1]?.name}
        </p>
      </div>

      {/* Diff stats */}
      <div className="p-3 rounded bg-cream border border-cream-border text-center">
        <p className="text-2xl font-bold text-accent tabular-nums">{st.diffPercent}%</p>
        <p className="text-[10px] text-ink-muted">of pixels differ</p>
      </div>

      {/* Sensitivity */}
      <div>
        <label className="text-[10px] text-ink-muted">
          Sensitivity: {st.sensitivity}
        </label>
        <input type="range" min={5} max={150} value={st.sensitivity}
          onChange={(e) => setCompareSensitivity(Number(e.target.value))}
          className="w-full" />
        <div className="flex justify-between text-[8px] text-ink-muted/50">
          <span>More sensitive</span>
          <span>Less sensitive</span>
        </div>
      </div>

      {/* Highlight color */}
      <div>
        <label className="text-[10px] text-ink-muted">Highlight Color</label>
        <input type="color" value={st.highlightColor}
          onChange={(e) => setCompareHighlightColor(e.target.value)}
          className="w-full h-6 rounded bg-cream border border-cream-border mt-1 cursor-pointer" />
      </div>

      {/* Info */}
      <p className="text-[10px] text-ink-muted leading-relaxed">
        Differences are computed pixel-by-pixel. Lower sensitivity catches more subtle changes. The output PDF shows document A with differences from B highlighted.
      </p>

      <button onClick={handleProcess} id="tool-process-btn" className="doodle-btn">
        Generate Comparison PDF
      </button>
    </div>
  );
}
