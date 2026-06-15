import { useState, useCallback } from 'react';
import { usePDFEngine } from '@/hooks/usePDFEngine';

export function ExtractPagesTool() {
  const { process } = usePDFEngine();
  const [pagesInput, setPagesInput] = useState('');
  const [mergeIntoOne, setMergeIntoOne] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const parsePages = (input: string): number[] => {
    const pages: number[] = [];
    const parts = input.split(',').map((s) => s.trim()).filter(Boolean);
    for (const part of parts) {
      if (part.includes('-')) {
        const [start, end] = part.split('-').map(Number);
        for (let i = start; i <= end; i++) pages.push(i);
      } else {
        pages.push(Number(part));
      }
    }
    return [...new Set(pages)].sort((a, b) => a - b);
  };

  const handleProcess = useCallback(() => {
    try {
      const pages = parsePages(pagesInput);
      if (pages.length === 0) { setError('Enter at least one page'); return; }
      setError(null);
      process({ toolId: 'extract-pages', params: { pages, mergeIntoOne } });
    } catch { setError('Invalid format'); }
  }, [process, pagesInput, mergeIntoOne]);

  return (
    <div className="doodle-section space-y-3">
      <p className="text-xs font-semibold text-ink">Extract Pages</p>
      <div>
        <label className="text-[11px] font-medium text-ink-soft">Pages to Extract</label>
        <input
          type="text" value={pagesInput}
          onChange={(e) => { setPagesInput(e.target.value); setError(null); }}
          placeholder="e.g. 1,3,5-7"
          className="doodle-input mt-1"
        />
      </div>
      <label className="flex items-center gap-2 text-[11px] text-ink-soft cursor-pointer">
        <input type="checkbox" checked={mergeIntoOne} onChange={(e) => setMergeIntoOne(e.target.checked)} />
        Merge extracted pages into one PDF
      </label>
      {error && <p className="text-[10px] text-danger">{error}</p>}
      <button onClick={handleProcess} id="tool-process-btn" className="doodle-btn">
        Extract Pages
      </button>
    </div>
  );
}
