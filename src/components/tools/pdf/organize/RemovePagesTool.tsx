import { useState, useCallback } from 'react';
import { usePDFEngine } from '@/hooks/usePDFEngine';

export function RemovePagesTool() {
  const { process } = usePDFEngine();
  const [pagesInput, setPagesInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  const parsePages = (input: string): number[] => {
    const pages: number[] = [];
    const parts = input.split(',').map((s) => s.trim()).filter(Boolean);
    for (const part of parts) {
      if (part.includes('-')) {
        const [start, end] = part.split('-').map(Number);
        if (isNaN(start) || isNaN(end)) throw new Error('Invalid range');
        for (let i = start; i <= end; i++) pages.push(i);
      } else {
        const n = Number(part);
        if (isNaN(n)) throw new Error('Invalid page number');
        pages.push(n);
      }
    }
    return [...new Set(pages)].sort((a, b) => a - b);
  };

  const handleProcess = useCallback(() => {
    try {
      const pages = parsePages(pagesInput);
      if (pages.length === 0) {
        setError('Enter at least one page number');
        return;
      }
      setError(null);
      process({ toolId: 'remove-pages', params: { pages } });
    } catch {
      setError('Invalid page numbers. Use format: 1,3,5-7');
    }
  }, [process, pagesInput]);

  return (
    <div className="doodle-section space-y-3">
      <p className="text-xs font-semibold text-ink">Remove Pages</p>

      <div>
        <label className="text-[11px] font-medium text-ink-soft">Pages to Remove</label>
        <input
          type="text"
          value={pagesInput}
          onChange={(e) => { setPagesInput(e.target.value); setError(null); }}
          placeholder="e.g. 2,4,6-8"
          className="doodle-input mt-1"
        />
        <p className="text-[10px] text-ink-muted mt-1">
          Enter page numbers and ranges separated by commas.
        </p>
        {error && <p className="text-[10px] text-danger mt-1">{error}</p>}
      </div>

      <button onClick={handleProcess} id="tool-process-btn" className="doodle-btn">
        Remove Selected Pages
      </button>
    </div>
  );
}
