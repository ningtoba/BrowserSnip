import { useCallback } from 'react';
import { usePDFEngine } from '@/hooks/usePDFEngine';

export function PDFToWordTool() {
  const { process } = usePDFEngine();

  const handleProcess = useCallback(() => {
    process({ toolId: 'pdf-to-word', params: {} });
  }, [process]);

  return (
    <div className="doodle-section space-y-3">
      <p className="text-xs font-semibold text-ink">PDF to Word</p>
      <p className="text-[10px] text-ink-muted leading-relaxed">
        Extracts text with formatting (bold, italic, font sizes) and produces
        a proper .docx file that opens in Word, Google Docs, or LibreOffice.
      </p>
      <button onClick={handleProcess} id="tool-process-btn" className="doodle-btn">
        Extract Text
      </button>
    </div>
  );
}
