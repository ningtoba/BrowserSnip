import { useState, useCallback } from 'react';
import { useProcessStore } from '@/stores/process-store';
import { useFileStore } from '@/stores/file-store';
import * as renderer from '@/lib/renderer/core';
import type { PDFToImageParams } from '@/types';

export function PDFToImageTool() {
  const file = useFileStore((s) => s.file);
  const store = useProcessStore;
  const [params, setParams] = useState<PDFToImageParams>({
    format: 'jpg',
    quality: 0.9,
    resolution: 150,
    pageRange: 'all',
  });

  const handleProcess = useCallback(async () => {
    if (!file) return;
    store.getState().startProcessing('Converting to images', `.${params.format}`);

    try {
      const buf = await file.arrayBuffer();
      const doc = await renderer.loadDocument(buf);
      const total = doc.numPages;
      const fmt = params.format === 'jpg' ? 'jpeg' : params.format;

      for (let i = 1; i <= total; i++) {
        const blob = await renderer.renderPageToBlob(doc, i, params.resolution / 72, fmt, params.quality);
        const url = URL.createObjectURL(blob);
        store.getState().updateProgress(
          { percent: (i / total) * 100, time: '', frame: i, fps: 0, eta: '' },
          (i / total) * 100,
        );

        if (i === 1) {
          store.getState().setOutput(blob, url);
        } else {
          store.getState().addOutput(blob, url);
        }
      }
    } catch (err) {
      store.getState().setError(err instanceof Error ? err.message : 'Conversion failed');
    }
  }, [file, params]);

  const update = <K extends keyof PDFToImageParams>(key: K, value: PDFToImageParams[K]) =>
    setParams((p) => ({ ...p, [key]: value }));

  return (
    <div className="doodle-section space-y-3">
      <p className="text-xs font-semibold text-ink">PDF to Image</p>

      <div>
        <label className="text-[11px] font-medium text-ink-soft">Format</label>
        <div className="flex gap-1 mt-1 flex-wrap">
          {(['jpg', 'png', 'webp'] as const).map((f) => (
            <button key={f} onClick={() => update('format', f)}
              className={`doodle-chip text-[10px] ${params.format === f ? 'doodle-chip-active' : 'doodle-chip-inactive'}`}>
              {f.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="text-[11px] font-medium text-ink-soft">
          Quality: {Math.round(params.quality * 100)}%
        </label>
        <input type="range" min={10} max={100} value={Math.round(params.quality * 100)}
          onChange={(e) => update('quality', Number(e.target.value) / 100)} className="mt-1" />
      </div>

      <button onClick={handleProcess} id="tool-process-btn" className="doodle-btn">
        Convert to Images
      </button>
    </div>
  );
}
