import { useState, useCallback } from 'react';
import { useFileStore } from '@/stores/file-store';
import { usePDFEngine } from '@/hooks/usePDFEngine';

type PageSize = 'a4' | 'letter' | 'original' | 'fit';
type Orientation = 'portrait' | 'landscape';

export function ScanTool() {
  const files = useFileStore((s) => s.files);
  const { process } = usePDFEngine();
  const [pageSize, setPageSize] = useState<PageSize>('a4');
  const [orientation, setOrientation] = useState<Orientation>('portrait');
  const [margin, setMargin] = useState(10);

  const imageCount = files.length;

  const handleProcess = useCallback(() => {
    process({
      toolId: 'scan-to-pdf',
      params: {
        pageSize,
        orientation,
        margin,
        fitMode: 'contain' as const,
      },
    });
  }, [process, pageSize, orientation, margin]);

  if (imageCount === 0) {
    return (
      <div className="doodle-section">
        <p className="text-xs font-semibold text-ink mb-1">Scan to PDF</p>
        <p className="text-[11px] text-ink-muted">
          Use your camera to scan document pages. Captured images will appear here.
        </p>
        <div className="mt-3 flex items-center gap-2 text-[10px] text-ink-muted">
          <span className="w-2 h-2 rounded-full bg-success animate-pulse" />
          Camera ready — tap the button below the preview to capture
        </div>
      </div>
    );
  }

  return (
    <div className="doodle-section space-y-3">
      <div>
        <p className="text-xs font-semibold text-ink">Scan to PDF</p>
        <p className="text-[11px] text-ink-muted mt-0.5">
          {imageCount} page{imageCount !== 1 ? 's' : ''} captured
        </p>
      </div>

      {/* Page size */}
      <div>
        <label className="text-[11px] font-medium text-ink-soft">Page Size</label>
        <select
          value={pageSize}
          onChange={(e) => setPageSize(e.target.value as PageSize)}
          className="doodle-input mt-1 text-[11px]"
        >
          <option value="a4">A4</option>
          <option value="letter">Letter</option>
          <option value="fit">Fit to image</option>
          <option value="original">Original size</option>
        </select>
      </div>

      {/* Orientation */}
      <div>
        <label className="text-[11px] font-medium text-ink-soft">Orientation</label>
        <select
          value={orientation}
          onChange={(e) => setOrientation(e.target.value as Orientation)}
          className="doodle-input mt-1 text-[11px]"
        >
          <option value="portrait">Portrait</option>
          <option value="landscape">Landscape</option>
        </select>
      </div>

      {/* Margin */}
      <div>
        <label className="text-[11px] font-medium text-ink-soft">
          Margin: {margin}px
        </label>
        <input
          type="range"
          min={0}
          max={40}
          value={margin}
          onChange={(e) => setMargin(Number(e.target.value))}
          className="w-full mt-1"
        />
      </div>

      <button onClick={handleProcess} id="tool-process-btn" className="doodle-btn w-full">
        Generate PDF
      </button>
    </div>
  );
}
