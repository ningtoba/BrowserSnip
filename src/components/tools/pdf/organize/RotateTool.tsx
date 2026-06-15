import { useState, useCallback } from 'react';
import { usePDFEngine } from '@/hooks/usePDFEngine';

export function RotateTool() {
  const { process } = usePDFEngine();
  const [degrees, setDegrees] = useState<90 | 180 | 270>(90);
  const [applyToAll, setApplyToAll] = useState(true);
  const [pagesInput, setPagesInput] = useState('');

  const handleProcess = useCallback(() => {
    const pages = applyToAll ? [] : pagesInput.split(',').map((s) => parseInt(s.trim())).filter((n) => !isNaN(n));
    process({ toolId: 'rotate', params: { degrees, applyToAll, pages } });
  }, [process, degrees, applyToAll, pagesInput]);

  return (
    <div className="doodle-section space-y-3">
      <p className="text-xs font-semibold text-ink">Rotate Pages</p>

      <div>
        <label className="text-[11px] font-medium text-ink-soft">Rotation</label>
        <div className="flex gap-1 mt-1">
          {[90, 180, 270].map((d) => (
            <button
              key={d}
              onClick={() => setDegrees(d as 90 | 180 | 270)}
              className={`doodle-chip ${degrees === d ? 'doodle-chip-active' : 'doodle-chip-inactive'}`}
            >
              {d}°
            </button>
          ))}
        </div>
      </div>

      <label className="flex items-center gap-2 text-[11px] text-ink-soft cursor-pointer">
        <input type="checkbox" checked={applyToAll} onChange={(e) => setApplyToAll(e.target.checked)} />
        Apply to all pages
      </label>

      {!applyToAll && (
        <input
          type="text" value={pagesInput}
          onChange={(e) => setPagesInput(e.target.value)}
          placeholder="e.g. 1,3,5-7"
          className="doodle-input"
        />
      )}

      <button onClick={handleProcess} id="tool-process-btn" className="doodle-btn">
        Rotate PDF
      </button>
    </div>
  );
}
