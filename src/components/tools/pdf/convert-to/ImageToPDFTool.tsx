import { useState, useCallback } from 'react';
import { usePDFEngine } from '@/hooks/usePDFEngine';
import type { ImageToPDFParams } from '@/types';

export function ImageToPDFTool() {
  const { process } = usePDFEngine();
  const [params, setParams] = useState<ImageToPDFParams>({
    pageSize: 'a4',
    orientation: 'portrait',
    margin: 20,
    fitMode: 'contain',
  });

  const handleProcess = useCallback(() => {
    process({ toolId: 'image-to-pdf', params: params as unknown as Record<string, unknown> });
  }, [process, params]);

  const update = <K extends keyof ImageToPDFParams>(key: K, value: ImageToPDFParams[K]) =>
    setParams((p) => ({ ...p, [key]: value }));

  return (
    <div className="doodle-section space-y-3">
      <p className="text-xs font-semibold text-ink">Image to PDF</p>

      <div className="space-y-2.5">
        <div>
          <label className="text-[11px] font-medium text-ink-soft">Page Size</label>
          <div className="flex gap-1 mt-1 flex-wrap">
            {(['a4', 'letter'] as const).map((s) => (
              <button key={s} onClick={() => update('pageSize', s)}
                className={`doodle-chip text-[10px] ${params.pageSize === s ? 'doodle-chip-active' : 'doodle-chip-inactive'}`}>
                {s === 'a4' ? 'A4' : 'Letter'}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="text-[11px] font-medium text-ink-soft">Orientation</label>
          <div className="flex gap-1 mt-1 flex-wrap">
            {(['portrait', 'landscape'] as const).map((o) => (
              <button key={o} onClick={() => update('orientation', o)}
                className={`doodle-chip text-[10px] ${params.orientation === o ? 'doodle-chip-active' : 'doodle-chip-inactive'}`}>
                {o === 'portrait' ? 'Portrait' : 'Landscape'}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div>
        <label className="text-[11px] font-medium text-ink-soft">Fit Mode</label>
        <div className="flex gap-1 mt-1 flex-wrap">
          {(['contain', 'cover', 'stretch'] as const).map((m) => (
            <button key={m} onClick={() => update('fitMode', m)}
              className={`doodle-chip text-[10px] ${params.fitMode === m ? 'doodle-chip-active' : 'doodle-chip-inactive'}`}>
              {m === 'contain' ? 'Contain' : m === 'cover' ? 'Cover' : 'Stretch'}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="text-[11px] font-medium text-ink-soft">
          Margin: {params.margin}px
        </label>
        <input
          type="range" min={0} max={100} value={params.margin}
          onChange={(e) => update('margin', Number(e.target.value))}
          className="mt-1"
        />
      </div>

      <button onClick={handleProcess} id="tool-process-btn" className="doodle-btn">
        Convert to PDF
      </button>
    </div>
  );
}
