import { useCallback } from 'react';
import { usePDFEngine } from '@/hooks/usePDFEngine';

export function RepairTool() {
  const { process } = usePDFEngine();

  const handleProcess = useCallback(() => {
    process({ toolId: 'repair', params: {} });
  }, [process]);

  return (
    <div className="doodle-section space-y-3">
      <p className="text-xs font-semibold text-ink">Repair PDF</p>

      <p className="text-[11px] text-ink-muted leading-relaxed">
        Rebuilds the PDF structure by copying all pages into a fresh
        document. This fixes broken cross-reference tables, corrupted
        page trees, and invalid object references.
      </p>

      <ul className="text-[10px] text-ink-muted space-y-1 list-disc list-inside">
        <li>Rebuilds xref table and object graph</li>
        <li>Strips broken encryption and annotations</li>
        <li>Preserves all readable page content</li>
        <li>Metadata is kept when readable</li>
      </ul>

      <div className="rounded bg-warn/5 border border-warn/20 p-2">
        <p className="text-[10px] text-warn">
          Severely corrupted files where the PDF parser fails entirely
          cannot be recovered in the browser.
        </p>
      </div>

      <button onClick={handleProcess} id="tool-process-btn" className="doodle-btn">
        Repair PDF
      </button>
    </div>
  );
}
