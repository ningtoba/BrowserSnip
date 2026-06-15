import { useState, useCallback } from 'react';
import { usePDFEngine } from '@/hooks/usePDFEngine';
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
    <div className="doodle-section space-y-3">
      <p className="text-xs font-semibold text-ink">Split PDF</p>

      <div className="space-y-2">
        <label className="text-[11px] font-medium text-ink-soft">Split Mode</label>
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
            <label className="text-[11px] font-medium text-ink-soft">Page Ranges</label>
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
      </div>

      <button onClick={handleProcess} id="tool-process-btn" className="doodle-btn">
        Split PDF
      </button>
    </div>
  );
}
