import { useState, useCallback } from 'react';
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
    <div className="doodle-section space-y-3">
      <p className="text-xs font-semibold text-ink">Add Page Numbers</p>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] text-ink-muted">Start At</label>
          <input type="number" min={1} value={params.startAt}
            onChange={(e) => update('startAt', Number(e.target.value))} className="doodle-input text-center" />
        </div>
        <div>
          <label className="text-[10px] text-ink-muted">Font Size: {params.fontSize}</label>
          <input type="range" min={8} max={36} value={params.fontSize}
            onChange={(e) => update('fontSize', Number(e.target.value))} />
        </div>
      </div>

      <div>
        <label className="text-[11px] font-medium text-ink-soft">Position</label>
        <div className="grid grid-cols-3 gap-1 mt-1">
          {(['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'] as const).map((p) => (
            <button key={p} onClick={() => update('position', p)}
              className={`doodle-chip text-[10px] ${params.position === p ? 'doodle-chip-active' : 'doodle-chip-inactive'}`}>
              {p.replace('-', ' ')}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <input type="text" value={params.prefix} onChange={(e) => update('prefix', e.target.value)}
          placeholder="Prefix" className="doodle-input" />
        <input type="text" value={params.suffix} onChange={(e) => update('suffix', e.target.value)}
          placeholder="Suffix" className="doodle-input" />
      </div>

      <p className="text-[10px] text-ink-muted font-mono">
        Preview: {params.prefix}{params.startAt}{params.suffix}
      </p>

      <button onClick={handleProcess} id="tool-process-btn" className="doodle-btn">
        Add Page Numbers
      </button>
    </div>
  );
}
