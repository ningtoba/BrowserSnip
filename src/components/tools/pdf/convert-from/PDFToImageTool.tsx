import { useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { fadeUp, staggerParent } from '@/lib/motion';
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
    <motion.div
      initial="hidden"
      animate="visible"
      variants={staggerParent}
      className="doodle-section space-y-3"
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">PDF to Image</p>

      <motion.section variants={fadeUp} className="rounded-[14px] border border-cream-border bg-white p-4 shadow-doodle">
        <label className="mb-2 block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Format</label>
        <div className="flex gap-1 flex-wrap">
          {(['jpg', 'png', 'webp'] as const).map((f) => (
            <button key={f} onClick={() => update('format', f)}
              className={`doodle-chip text-[10px] ${params.format === f ? 'doodle-chip-active' : 'doodle-chip-inactive'}`}>
              {f.toUpperCase()}
            </button>
          ))}
        </div>
      </motion.section>

      <motion.section variants={fadeUp} className="rounded-[14px] border border-cream-border bg-white p-4 shadow-doodle">
        <label className="mb-2 block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
          Quality: <span className="tabular-nums text-accent">{Math.round(params.quality * 100)}%</span>
        </label>
        <input type="range" min={10} max={100} value={Math.round(params.quality * 100)}
          onChange={(e) => update('quality', Number(e.target.value) / 100)} className="mt-1 w-full" />
      </motion.section>

      <button onClick={handleProcess} id="tool-process-btn" className="doodle-btn">
        Convert to Images
      </button>
    </motion.div>
  );
}
