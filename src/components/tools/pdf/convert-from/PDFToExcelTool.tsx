import { useCallback } from 'react';
import { usePDFEngine } from '@/hooks/usePDFEngine';

export function PDFToExcelTool() {
  const { process } = usePDFEngine();

  const handleProcess = useCallback(() => {
    process({ toolId: 'pdf-to-excel', params: {} });
  }, [process]);

  return (
    <div className="doodle-section space-y-3">
      <p className="text-xs font-semibold text-ink">PDF to Excel</p>
      <p className="text-[10px] text-ink-muted leading-relaxed">
        Detects table rows and columns from your PDF and produces a proper
        .xlsx workbook that opens directly in Excel or Google Sheets.
      </p>
      <button onClick={handleProcess} id="tool-process-btn" className="doodle-btn">
        Extract Tables
      </button>
    </div>
  );
}
