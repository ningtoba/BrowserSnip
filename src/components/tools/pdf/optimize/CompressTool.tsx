import { useState, useCallback } from 'react';
import { usePDFEngine } from '@/hooks/usePDFEngine';

const PRESETS = [
  { level: 'low', label: 'Low', quality: 0.85, dpi: 200, desc: 'Metadata only' },
  { level: 'medium', label: 'Medium', quality: 0.5, dpi: 144, desc: 'Reduced images' },
  { level: 'high', label: 'High', quality: 0.3, dpi: 100, desc: 'Maximum shrink' },
];

export function CompressTool() {
  const { process } = usePDFEngine();
  const [preset, setPreset] = useState('medium');

  const handleProcess = useCallback(() => {
    const p = PRESETS.find((pr) => pr.level === preset) ?? PRESETS[1];
    process({
      toolId: 'pdf-compress',
      params: {
        level: p.level,
        imageQuality: p.quality,
        imageMaxDPI: p.dpi,
        useGhostscript: false,
      },
    });
  }, [process, preset]);

  return (
    <div className="doodle-section space-y-3">
      <p className="text-xs font-semibold text-ink">Compress PDF</p>

      <div>
        <label className="text-[11px] font-medium text-ink-soft">Compression Level</label>
        <div className="flex gap-1 mt-1">
          {PRESETS.map((p) => (
            <button
              key={p.level}
              onClick={() => setPreset(p.level)}
              className={`doodle-chip ${preset === p.level ? 'doodle-chip-active' : 'doodle-chip-inactive'}`}
            >
              <div className="text-[11px] font-semibold">{p.label}</div>
              <div className="text-[9px] opacity-60">{p.desc}</div>
            </button>
          ))}
        </div>
      </div>

      <p className="text-[10px] text-ink-muted">
        Compresses embedded images at the target DPI and JPEG quality.
        Text and vector graphics are preserved unchanged.
      </p>

      <button onClick={handleProcess} id="tool-process-btn" className="doodle-btn">
        Compress PDF
      </button>
    </div>
  );
}
