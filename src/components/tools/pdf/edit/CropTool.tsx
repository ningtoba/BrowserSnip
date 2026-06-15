import { useState, useCallback, useEffect } from 'react';
import { usePDFEngine } from '@/hooks/usePDFEngine';
import { getCropRect, getPageSizePt, subscribeCrop } from './CropMain';
import type { PdfCropParams } from '@/types';

export function CropTool() {
  const { process } = usePDFEngine();
  const [params, setParams] = useState<PdfCropParams>({
    pages: [1],
    top: 0, right: 0, bottom: 0, left: 0,
    unit: 'px',
    allPages: true,
    uniform: false,
  });

  // Sync crop rect from visual overlay (fractions → user-selected unit for display)
  const syncFromOverlay = useCallback(() => {
    const r = getCropRect();
    const page = getPageSizePt();
    // Convert fraction to PDF points, then to display unit
    const toUnit = params.unit === 'pt' ? 1
      : params.unit === 'in' ? 1 / 72
      : params.unit === 'mm' ? 25.4 / 72
      : 1 / 0.75; // px
    const round = (v: number) => Math.round(v * 10) / 10;
    setParams((p) => ({
      ...p,
      top: round(r.top * page.height * toUnit),
      right: round(r.right * page.width * toUnit),
      bottom: round(r.bottom * page.height * toUnit),
      left: round(r.left * page.width * toUnit),
    }));
  }, [params.unit]);

  useEffect(() => {
    syncFromOverlay();
    return subscribeCrop(() => syncFromOverlay());
  }, [syncFromOverlay]);

  const update = <K extends keyof PdfCropParams>(key: K, value: PdfCropParams[K]) =>
    setParams((p) => ({ ...p, [key]: value }));

  const handleProcess = useCallback(() => {
    const r = getCropRect();
    const page = getPageSizePt();
    // Convert fractions directly to PDF points — no unit conversion
    process({
      toolId: 'pdf-crop',
      params: {
        pages: params.pages,
        top: Math.round(r.top * page.height * 10) / 10,
        right: Math.round(r.right * page.width * 10) / 10,
        bottom: Math.round(r.bottom * page.height * 10) / 10,
        left: Math.round(r.left * page.width * 10) / 10,
        allPages: params.allPages,
        unit: 'pt',
      } as unknown as Record<string, unknown>,
    });
  }, [process, params]);

  return (
    <div className="doodle-section space-y-3">
      <p className="text-xs font-semibold text-ink">Crop Pages</p>

      <p className="text-[10px] leading-relaxed text-ink-muted">
        Drag the blue handles on the preview to adjust the crop area.
      </p>

      {/* Toggles */}
      <div className="flex gap-1 flex-wrap">
        <button
          onClick={() => update('allPages', !params.allPages)}
          className={`doodle-chip text-[10px] ${params.allPages ? 'doodle-chip-active' : 'doodle-chip-inactive'}`}
        >
          {params.allPages ? 'All Pages' : 'This Page'}
        </button>
      </div>

      {/* Crop values (display only, converted from fractions) */}
      <div className="grid grid-cols-2 gap-2">
        {(['top', 'bottom', 'left', 'right'] as const).map((side) => (
          <div key={side}>
            <label className="text-[10px] text-ink-muted capitalize">{side}</label>
            <div className="doodle-input text-center text-[11px] font-mono tabular-nums py-1.5 bg-cream">
              {params[side]}{params.unit === 'px' ? '' : params.unit}
            </div>
          </div>
        ))}
      </div>

      {/* Unit selector */}
      <div className="flex gap-1 flex-wrap">
        {(['px', 'pt', 'in', 'mm'] as const).map((u) => (
          <button key={u} onClick={() => update('unit', u)}
            className={`doodle-chip text-[10px] ${params.unit === u ? 'doodle-chip-active' : 'doodle-chip-inactive'}`}>
            {u}
          </button>
        ))}
      </div>

      <button onClick={handleProcess} id="tool-process-btn" className="doodle-btn">
        Apply Crop
      </button>
    </div>
  );
}
