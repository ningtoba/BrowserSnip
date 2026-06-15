import { useCallback } from 'react';
import { usePDFEngine } from '@/hooks/usePDFEngine';

export function PDFToPdfATool() {
  const { process } = usePDFEngine();

  const handleProcess = useCallback(() => {
    process({ toolId: 'pdf-to-pdfa', params: {} });
  }, [process]);

  return (
    <div className="doodle-section space-y-3">
      <p className="text-xs font-semibold text-ink">PDF to PDF/A</p>
      <p className="text-[10px] text-ink-muted leading-relaxed">
        Converts your PDF to PDF/A-2b archival format. Strips JavaScript,
        encryption, and interactive features. Adds XMP metadata and conformance
        markers for long-term preservation.
      </p>
      <button onClick={handleProcess} id="tool-process-btn" className="doodle-btn">
        Convert to PDF/A
      </button>
    </div>
  );
}
