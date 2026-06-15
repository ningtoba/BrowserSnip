import { useState, useCallback } from 'react';
import { usePDFEngine } from '@/hooks/usePDFEngine';
import type { DigitizeDocumentParams } from '@/types';

export function DigitizeDocumentTool() {
  const { process } = usePDFEngine();
  const [params, setParams] = useState<DigitizeDocumentParams>({
    pageSize: 'a4',
    orientation: 'portrait',
    margin: 20,
  });

  const handleProcess = useCallback(() => {
    process({ toolId: 'digitize-document', params: params as unknown as Record<string, unknown> });
  }, [process, params]);

  const update = <K extends keyof DigitizeDocumentParams>(key: K, value: DigitizeDocumentParams[K]) =>
    setParams((p) => ({ ...p, [key]: value }));

  return (
    <div className="doodle-section space-y-3">
      <p className="text-xs font-semibold text-ink">Digitize Document</p>

      <p className="text-[10px] text-ink-muted leading-relaxed">
        Upload a photo of a document. OCR extracts the text and produces a
        clean digital PDF with text positioned to match the original layout.
      </p>

      <div className="space-y-2.5">
        <div>
          <label className="text-[11px] font-medium text-ink-soft">Page Size</label>
          <div className="flex gap-1 mt-1 flex-wrap">
            {(['a4', 'letter', 'original'] as const).map((s) => (
              <button key={s} onClick={() => update('pageSize', s)}
                className={`doodle-chip text-[10px] ${params.pageSize === s ? 'doodle-chip-active' : 'doodle-chip-inactive'}`}>
                {s === 'a4' ? 'A4' : s === 'letter' ? 'Letter' : 'Original'}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="text-[11px] font-medium text-ink-soft">Orientation</label>
          <div className="flex gap-1 mt-1">
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
        Digitize
      </button>

      <p className="text-[10px] text-ink-muted leading-relaxed">
        OCR runs on-device — no data leaves your browser. First use downloads
        ~5MB of recognition models (cached for future use).
      </p>
    </div>
  );
}
