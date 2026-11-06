import { useState, useCallback, useMemo } from 'react';
import { motion } from 'framer-motion';
import { useFileStore } from '@/stores/file-store';
import { usePDFEngine } from '@/hooks/usePDFEngine';
import { fadeUp, scaleIn, staggerParent } from '@/lib/motion';
import { navigateToTool } from '@/components/tools/pdf/editor/quickModes';

type PageSize = 'a4' | 'letter' | 'original' | 'fit';
type Orientation = 'portrait' | 'landscape';

/** The slider's range; a typed value outside it is clamped, not rejected (E15). */
export const MARGIN_MIN = 0;
export const MARGIN_MAX = 40;

export function clampMargin(value: number): number {
  if (!Number.isFinite(value)) return MARGIN_MIN;
  return Math.min(MARGIN_MAX, Math.max(MARGIN_MIN, Math.round(value)));
}

/** True when this browser context can offer a camera at all (E20). */
export function cameraAvailable(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
}

export interface ScanPlanReport {
  pages: number;
  valid: boolean;
  notes: string[];
}

/**
 * What "Generate PDF" is about to do (E13, E18).
 *
 * Zero captures must never reach the engine, and a fixed paper size with a big
 * margin is worth stating before the download rather than after it.
 */
export function scanPlanReport(input: {
  pages: number;
  pageSize: PageSize;
  orientation: Orientation;
  margin: number;
}): ScanPlanReport {
  const notes: string[] = [];
  const pages = Math.max(0, Math.floor(input.pages));
  if (pages === 0) {
    return {
      pages: 0,
      valid: false,
      notes: ['Nothing has been captured yet, so there is no page to build. Capture a page, or add photos that are already on this device.'],
    };
  }
  notes.push(
    `${pages} page${pages === 1 ? '' : 's'} on ${
      input.pageSize === 'a4' ? 'A4' : input.pageSize === 'letter' ? 'US Letter' : input.pageSize
    } ${input.orientation}, ${input.margin} pt border.`,
  );
  if (input.pageSize === 'fit' && input.margin === 0) {
    notes.push('With “Fit to image” and no margin the page is exactly the picture, bleed included.');
  }
  if (input.pageSize === 'original' && input.margin > MARGIN_MAX / 2) {
    notes.push('“Original size” keeps the photo’s own pixel size, so the margin is added outside it and the page grows.');
  }
  if (input.margin === MARGIN_MAX) {
    notes.push('That is the largest margin this tool offers; on a small photo it eats most of the page.');
  }
  return { pages, valid: true, notes };
}

export function ScanTool() {
  const files = useFileStore((s) => s.files);
  const { process } = usePDFEngine();
  const [pageSize, setPageSize] = useState<PageSize>('a4');
  const [orientation, setOrientation] = useState<Orientation>('portrait');
  const [margin, setMargin] = useState(10);

  const imageCount = files.length;
  const hasCamera = useMemo(() => cameraAvailable(), []);
  const plan = useMemo(
    () => scanPlanReport({ pages: imageCount, pageSize, orientation, margin }),
    [imageCount, margin, orientation, pageSize],
  );

  const handleProcess = useCallback(() => {
    if (!plan.valid) return;
    process({
      toolId: 'scan-to-pdf',
      params: {
        pageSize,
        orientation,
        margin,
        fitMode: 'contain' as const,
      },
    });
  }, [margin, orientation, pageSize, plan.valid, process]);

  if (imageCount === 0) {
    return (
      <motion.div
        initial="hidden"
        animate="visible"
        variants={staggerParent}
        className="doodle-section space-y-2"
      >
        <motion.p variants={fadeUp} className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted mb-1">Scan to PDF</motion.p>
        <p className="text-[11px] text-ink-muted">
          Use your camera to scan document pages. Captured images will appear here.
        </p>
        {hasCamera ? (
          <div className="mt-3 flex items-center gap-2 text-[10px] text-ink-muted">
            <span className="w-2 h-2 rounded-full bg-success animate-pulse" />
            Camera ready — tap the button below the preview to capture
          </div>
        ) : (
          <motion.div variants={scaleIn} className="mt-2 space-y-2 rounded-[12px] border border-warn/25 bg-warn/[0.07] p-3">
            <p className="text-[10px] font-semibold text-warn">No camera in this context</p>
            <p className="text-[10px] leading-relaxed text-ink-soft">
              The browser gives this page no camera API: camera access needs a secure context (https or localhost), and
              some devices have no camera at all. Photos already on this device still work.
            </p>
            <button
              type="button"
              onClick={() => navigateToTool('image-to-pdf')}
              className="doodle-chip text-[10px] doodle-chip-inactive"
            >
              Add photos instead → Image to PDF
            </button>
          </motion.div>
        )}
      </motion.div>
    );
  }

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={staggerParent}
      className="doodle-section space-y-3"
    >
      <motion.div variants={fadeUp}>
        <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Scan to PDF</p>
        <p className="text-[11px] text-ink-muted mt-0.5">
          {imageCount} page{imageCount !== 1 ? 's' : ''} captured
        </p>
      </motion.div>

      {/* Page size */}
      <motion.div variants={fadeUp}>
        <label className="block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Page Size</label>
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
      </motion.div>

      {/* Orientation */}
      <motion.div variants={fadeUp}>
        <label className="block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Orientation</label>
        <select
          value={orientation}
          onChange={(e) => setOrientation(e.target.value as Orientation)}
          className="doodle-input mt-1 text-[11px]"
        >
          <option value="portrait">Portrait</option>
          <option value="landscape">Landscape</option>
        </select>
      </motion.div>

      {/* Margin */}
      <motion.div variants={fadeUp}>
        <label className="block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
          Margin: <span className="tabular-nums">{margin}pt</span>
        </label>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={MARGIN_MIN}
            max={MARGIN_MAX}
            value={margin}
            onChange={(e) => setMargin(clampMargin(Number(e.target.value)))}
            className="w-full mt-1"
          />
          <input
            type="number"
            min={MARGIN_MIN}
            max={MARGIN_MAX}
            step={1}
            value={margin}
            onChange={(e) => setMargin(clampMargin(e.target.valueAsNumber))}
            className="doodle-input w-16 text-center text-[11px] tabular-nums"
            aria-label="Margin in points"
          />
        </div>
      </motion.div>

      <motion.ul
        variants={scaleIn}
        data-scan-plan={plan.notes.length}
        className="space-y-1 rounded-[12px] border border-cream-border bg-cream-soft px-3 py-2 text-[10px] leading-relaxed text-ink-muted"
      >
        {plan.notes.map((note) => (
          <li key={note}>· {note}</li>
        ))}
      </motion.ul>

      <motion.div
        variants={scaleIn}
        className="flex items-center justify-between rounded-[12px] border border-cream-border bg-white px-3.5 py-2.5 shadow-doodle"
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Pages</span>
        <span className="font-mono text-xs font-semibold tabular-nums text-accent">{imageCount}</span>
      </motion.div>

      <button onClick={handleProcess} id="tool-process-btn" className="doodle-btn w-full" disabled={!plan.valid}>
        Generate PDF{plan.valid ? ` (${plan.pages} page${plan.pages === 1 ? '' : 's'})` : ''}
      </button>
    </motion.div>
  );
}
