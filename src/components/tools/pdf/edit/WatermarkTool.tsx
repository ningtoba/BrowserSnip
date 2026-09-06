import { useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { fadeUp, scaleIn, staggerParent } from '@/lib/motion';
import { usePDFEngine } from '@/hooks/usePDFEngine';
import type { WatermarkParams } from '@/types';

export function WatermarkTool() {
  const { process } = usePDFEngine();
  const [params, setParams] = useState<WatermarkParams>({
    type: 'text',
    text: 'CONFIDENTIAL',
    imageData: null,
    opacity: 0.3,
    rotation: 45,
    fontSize: 48,
    position: 'center',
    color: '#808080',
    pages: 'all',
    bold: true,
    imageScale: 0.3,
    tileSpacing: 1.5,
  });

  const update = <K extends keyof WatermarkParams>(key: K, value: WatermarkParams[K]) =>
    setParams((p) => ({ ...p, [key]: value }));

  const handleProcess = useCallback(() => {
    process({ toolId: 'watermark', params: params as unknown as Record<string, unknown> });
  }, [process, params]);

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={staggerParent}
      className="doodle-section space-y-3"
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Add Watermark</p>

      {/* Type toggle */}
      <motion.section variants={fadeUp} className="rounded-[14px] border border-cream-border bg-white p-4 shadow-doodle">
        <div className="flex gap-1 flex-wrap">
          {(['text', 'image'] as const).map((t) => (
            <button key={t} onClick={() => update('type', t)}
              className={`doodle-chip text-[10px] ${params.type === t ? 'doodle-chip-active' : 'doodle-chip-inactive'}`}>
              {t === 'text' ? 'Text' : 'Image'}
            </button>
          ))}
        </div>
      </motion.section>

      {params.type === 'text' ? (
        <motion.section variants={fadeUp} className="rounded-[14px] border border-cream-border bg-white p-4 shadow-doodle space-y-2.5">
          {/* Text input */}
          <input type="text" value={params.text}
            onChange={(e) => update('text', e.target.value)}
            placeholder="Watermark text" className="doodle-input" />

          {/* Font size + bold */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Font Size: {params.fontSize}</label>
              <input type="range" min={12} max={120} value={params.fontSize}
                onChange={(e) => update('fontSize', Number(e.target.value))} />
            </div>
            <div className="flex items-end pb-0.5">
              <button
                onClick={() => update('bold', !params.bold)}
                className={`doodle-chip text-[10px] w-full ${params.bold ? 'doodle-chip-active font-bold' : 'doodle-chip-inactive'}`}
              >
                B
              </button>
            </div>
          </div>
        </motion.section>
      ) : (
        <motion.section variants={fadeUp} className="rounded-[14px] border border-cream-border bg-white p-4 shadow-doodle space-y-2.5">
          {/* Image upload */}
          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Watermark Image</label>
            <input type="file" accept="image/*"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                // Convert any image to PNG so pdf-lib can embed it
                const blob = new Blob([await f.arrayBuffer()]);
                const img = new Image();
                img.src = URL.createObjectURL(blob);
                await new Promise<void>((resolve, reject) => {
                  img.onload = () => resolve();
                  img.onerror = () => reject(new Error('Failed to load image'));
                });
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                const ctx = canvas.getContext('2d')!;
                ctx.drawImage(img, 0, 0);
                URL.revokeObjectURL(img.src);
                const pngBlob = await new Promise<Blob | null>((resolve) =>
                  canvas.toBlob(resolve, 'image/png'),
                );
                if (pngBlob) {
                  update('imageData', await pngBlob.arrayBuffer());
                }
              }}
              className="doodle-input text-[10px]" />
          </div>
          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Scale: {Math.round((params.imageScale ?? 0.3) * 100)}%</label>
            <input type="range" min={5} max={100} value={Math.round((params.imageScale ?? 0.3) * 100)}
              onChange={(e) => update('imageScale', Number(e.target.value) / 100)} />
          </div>
        </motion.section>
      )}

      {/* Color + Opacity */}
      <motion.section variants={fadeUp} className="rounded-[14px] border border-cream-border bg-white p-4 shadow-doodle">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Color</label>
            <input type="color" value={params.color}
              onChange={(e) => update('color', e.target.value)}
              className="w-full h-6 rounded bg-cream border border-cream-border" />
          </div>
          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Opacity: {Math.round(params.opacity * 100)}%</label>
            <input type="range" min={5} max={100} value={Math.round(params.opacity * 100)}
              onChange={(e) => update('opacity', Number(e.target.value) / 100)} />
          </div>
        </div>
      </motion.section>

      {/* Rotation */}
      <motion.section variants={fadeUp} className="rounded-[14px] border border-cream-border bg-white p-4 shadow-doodle">
        <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Rotation: {params.rotation}°</label>
        <input type="range" min={-90} max={90} value={params.rotation}
          onChange={(e) => update('rotation', Number(e.target.value))} />
      </motion.section>

      {/* Position */}
      <motion.section variants={fadeUp} className="rounded-[14px] border border-cream-border bg-white p-4 shadow-doodle">
        <label className="mb-2 block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Position</label>
        <div className="flex gap-1 flex-wrap">
          {(['center', 'tile', 'diagonal', 'top-left', 'top-right', 'bottom-left', 'bottom-right'] as const).map((pos) => (
            <button key={pos} onClick={() => update('position', pos)}
              className={`doodle-chip text-[10px] ${params.position === pos ? 'doodle-chip-active' : 'doodle-chip-inactive'}`}>
              {pos.replace('-', ' ')}
            </button>
          ))}
        </div>
      </motion.section>

      {/* Tile density — only visible when tile position is selected */}
      {params.position === 'tile' && (
        <motion.div
          variants={scaleIn}
          className="rounded-[12px] border border-cream-border bg-cream-soft px-3.5 py-2.5"
        >
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
            Tile Density: {params.tileSpacing!.toFixed(1)}×
          </label>
          <input type="range" min={1} max={3} step={0.1}
            value={params.tileSpacing ?? 1.5}
            onChange={(e) => update('tileSpacing', Number(e.target.value))} />
          <div className="flex justify-between text-[8px] text-ink-muted/50">
            <span>Tight</span><span>Sparse</span>
          </div>
        </motion.div>
      )}

      {/* Apply */}
      <button onClick={handleProcess} id="tool-process-btn" className="doodle-btn">
        Apply Watermark
      </button>
    </motion.div>
  );
}
