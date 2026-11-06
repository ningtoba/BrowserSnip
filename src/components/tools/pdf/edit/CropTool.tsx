/**
 * CropTool — sidebar for `pdf-crop`.
 *
 * The preview (`CropMain`) drags a rectangle and shares it as fractions of the
 * displayed page; the engine writes absolute points of the page's stored box and
 * applies one margin set to every target page. The panel is where those two meet,
 * so it is also where the matrix cases get answered instead of being discovered
 * in the download:
 *
 * * E9 — a `/Rotate 90` page is displayed sideways, so the strip you trimmed off
 *   the top is a strip of the stored *left* edge. `cropModel.marginsInPoints` does
 *   the re-aim and the notes say which edge became which.
 * * E8 — one margin set on mixed page sizes crops the small pages proportionally
 *   harder; the panel states the sizes it found.
 * * E6 — a one-page document says so, because "all pages" is then a no-op toggle.
 * * E13/E18 — a crop that removes everything (or nothing) is reported and the
 *   primary action is disabled before the click, not after a broken file.
 * * E15 — out-of-range target pages and inverted ranges are refused by name.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { fadeUp, scaleIn, staggerParent } from '@/lib/motion';
import { useFileStore } from '@/stores/file-store';
import { usePDFEngine } from '@/hooks/usePDFEngine';
import { openPDF } from '@/lib/pdf/core/doc';
import { displayedSize, mediaBox } from '@/lib/pdf/core/pages';
import { getCropRect, getPageSizePt, subscribeCrop } from './CropMain';
import {
  describeCrop,
  distinctBoxes,
  resolveTargets,
  targetPage,
  type CropFractions,
  type CropTargetPage,
} from './cropModel';

/** Geometry is read for at most this many pages; a 500-page scan need not wait. */
const GEOMETRY_LIMIT = 60;

interface DocumentGeometry {
  name: string;
  numPages: number;
  pages: CropTargetPage[];
  inspected: number;
}

export function CropTool() {
  const file = useFileStore((s) => s.file);
  const { process } = usePDFEngine();

  const [rect, setRect] = useState<CropFractions>(getCropRect());
  const [allPages, setAllPages] = useState(true);
  const [pageSpec, setPageSpec] = useState('1');
  const [geometry, setGeometry] = useState<DocumentGeometry | null>(null);
  const [geometryError, setGeometryError] = useState<string | null>(null);

  useEffect(() => {
    const sync = () => setRect({ ...getCropRect() });
    sync();
    return subscribeCrop(sync);
  }, []);

  // The preview only knows the page it drew; the panel needs the document, because
  // "page 9 of 3" and "half of these pages are landscape" are claims about files.
  useEffect(() => {
    let disposed = false;
    if (!file) {
      setGeometry(null);
      setGeometryError(null);
      return () => {
        disposed = true;
      };
    }
    setGeometryError(null);
    (async () => {
      try {
        const doc = await openPDF(new Uint8Array(await file.arrayBuffer()), {
          ignoreEncryption: true,
          updateMetadata: false,
        });
        const numPages = doc.getPageCount();
        const inspected = Math.min(numPages, GEOMETRY_LIMIT);
        const pages: CropTargetPage[] = [];
        for (let index = 0; index < inspected; index += 1) {
          const page = doc.getPage(index);
          const box = mediaBox(page);
          const display = displayedSize(page);
          pages.push({
            ...targetPage(index, box.width, box.height, page.getRotation().angle),
            displayWidthPt: display.width,
            displayHeightPt: display.height,
          });
        }
        if (!disposed) {
          setGeometry({ name: file.name, numPages, pages, inspected });
          if (numPages === 1) setAllPages(true);
        }
      } catch (error) {
        if (!disposed) {
          setGeometry(null);
          setGeometryError(
            error instanceof Error
              ? `${file.name}: ${error.message}`
              : `${file.name} could not be read to measure its pages.`,
          );
        }
      }
    })();
    return () => {
      disposed = true;
    };
  }, [file]);

  const numPages = geometry?.numPages ?? 0;
  const preview: CropTargetPage | null = geometry?.pages[0] ?? null;
  const targets = useMemo(
    () => (allPages ? { pages: range(1, numPages), refused: [] } : resolveTargets(pageSpec, numPages)),
    [allPages, numPages, pageSpec],
  );
  const report = useMemo(
    () =>
      describeCrop({
        rect,
        preview:
          preview ??
          (getPageSizePt().width > 0
            ? targetPage(0, getPageSizePt().width, getPageSizePt().height, 0)
            : null),
        targets: targets.pages,
        refused: targets.refused,
        numPages,
        allPages,
      }),
    [allPages, numPages, preview, rect, targets],
  );

  const sizes = useMemo(() => (geometry ? distinctBoxes(geometry.pages) : []), [geometry]);
  const rotated = useMemo(() => (geometry ? geometry.pages.filter((page) => page.rotation !== 0) : []), [geometry]);

  const applyCrop = useCallback(() => {
    if (!report.valid) return;
    // SAFETY: `process` takes the loose param bag every legacy panel uses; the
    // keys and the `unit: 'pt'` discriminator are exactly what
    // `pdf-engine/commands.cropPages` reads out of it.
    process({
      toolId: 'pdf-crop',
      params: {
        pages: targets.pages,
        top: round(report.marginsPt.top),
        right: round(report.marginsPt.right),
        bottom: round(report.marginsPt.bottom),
        left: round(report.marginsPt.left),
        allPages,
        // The margins are already points of the stored page box, so the engine
        // must not convert them again.
        unit: 'pt',
      } as unknown as Record<string, unknown>,
    });
  }, [allPages, process, report, targets]);

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={staggerParent}
      className="doodle-section space-y-3"
    >
      <motion.p variants={fadeUp} className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
        Crop pages
      </motion.p>

      <motion.p variants={fadeUp} className="text-[10px] leading-relaxed text-ink-muted">
        Drag the blue handles on the preview. The numbers below are what will be written to the file, in points of each
        page's own box.
      </motion.p>

      {/* What was actually measured */}
      <motion.div variants={fadeUp} className="space-y-1 rounded-[14px] border border-cream-border bg-white p-3 shadow-doodle">
        <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Document</p>
        {!file && <p className="text-[10px] text-ink-muted">No PDF is loaded, so there is nothing to measure or crop.</p>}
        {geometryError && <p className="text-[10px] leading-relaxed text-danger">{geometryError}</p>}
        {geometry && (
          <p className="text-[10px] leading-relaxed text-ink-soft" data-crop-doc-pages={geometry.numPages}>
            {geometry.name} · {geometry.numPages} page{geometry.numPages === 1 ? '' : 's'} ·{' '}
            {sizes.length === 1
              ? `all ${sizes[0]} pt`
              : `${sizes.length} page sizes (${sizes.slice(0, 3).join(', ')}${sizes.length > 3 ? ', …' : ''})`}
            {rotated.length > 0
              ? ` · ${rotated.length} rotated page${rotated.length === 1 ? '' : 's'} (${rotated
                  .slice(0, 4)
                  .map((page) => `${page.index + 1}:${page.rotation}°`)
                  .join(', ')}${rotated.length > 4 ? ', …' : ''})`
              : ''}
            {geometry.numPages > geometry.inspected ? ` · measured the first ${geometry.inspected} pages` : ''}
          </p>
        )}
      </motion.div>

      {/* Which pages */}
      <motion.section variants={fadeUp} className="space-y-2 rounded-[14px] border border-cream-border bg-white p-4 shadow-doodle">
        <div className="flex gap-1 flex-wrap">
          <button
            type="button"
            onClick={() => setAllPages(true)}
            aria-pressed={allPages}
            className={`doodle-chip text-[10px] ${allPages ? 'doodle-chip-active' : 'doodle-chip-inactive'}`}
          >
            All pages{numPages > 0 ? ` (${numPages})` : ''}
          </button>
          <button
            type="button"
            onClick={() => setAllPages(false)}
            aria-pressed={!allPages}
            className={`doodle-chip text-[10px] ${!allPages ? 'doodle-chip-active' : 'doodle-chip-inactive'}`}
          >
            Chosen pages
          </button>
        </div>
        {!allPages && (
          <label className="block space-y-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
              Pages{numPages > 0 ? ` (1–${numPages})` : ''}
            </span>
            <input
              type="text"
              value={pageSpec}
              spellCheck={false}
              onChange={(event) => setPageSpec(event.target.value)}
              placeholder="1, 3-5"
              className="doodle-input text-[11px]"
              aria-label="Pages to crop"
            />
            <span className="block text-[10px] leading-relaxed text-ink-muted">
              {targets.pages.length > 0
                ? `Cropping ${targets.pages.length} page${targets.pages.length === 1 ? '' : 's'}: ${targets.pages
                    .slice(0, 12)
                    .join(', ')}${targets.pages.length > 12 ? ', …' : ''}.`
                : 'No page selected yet.'}
            </span>
          </label>
        )}
      </motion.section>

      {/* Crop values, from the same model that builds the params */}
      <motion.section variants={fadeUp} className="space-y-2 rounded-[14px] border border-cream-border bg-white p-4 shadow-doodle">
        <div className="grid grid-cols-4 gap-2">
          {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
            <div key={side}>
              <label className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">{side}</label>
              <div className="doodle-input text-center text-[11px] font-mono tabular-nums py-1.5 bg-cream">
                {round(report.marginsPt[side])}
              </div>
              <p className="mt-0.5 text-center font-mono text-[8px] tabular-nums text-ink-muted">
                {(rect[side] * 100).toFixed(0)}%
              </p>
            </div>
          ))}
        </div>
        <p className="text-center font-mono text-[10px] tabular-nums text-ink-soft" data-crop-kept>
          keeps {Math.round(report.keptWidthPt)} × {Math.round(report.keptHeightPt)} pt
        </p>
      </motion.section>

      {report.notes.length > 0 && (
        <motion.ul
          variants={scaleIn}
          data-crop-notes={report.notes.length}
          className={`space-y-1 rounded-[12px] border px-3 py-2.5 text-[10px] leading-relaxed ${
            report.tone === 'danger'
              ? 'border-danger/25 bg-danger/[0.07] text-danger'
              : report.tone === 'warn'
                ? 'border-warn/25 bg-warn/[0.07] text-warn'
                : 'border-cream-border bg-cream-soft text-ink-muted'
          }`}
        >
          {report.notes.map((note) => (
            <li key={note}>· {note}</li>
          ))}
        </motion.ul>
      )}

      <button
        type="button"
        onClick={applyCrop}
        id="tool-process-btn"
        disabled={!report.valid || !file}
        title={report.valid ? 'Write the cropped PDF' : 'Fix the crop first — it would not produce a page.'}
        className="doodle-btn disabled:opacity-50"
      >
        Apply crop
        {report.valid && targets.pages.length > 0 ? ` (${targets.pages.length} page${targets.pages.length === 1 ? '' : 's'})` : ''}
      </button>
    </motion.div>
  );
}

function range(from: number, to: number): number[] {
  if (to < from) return [];
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

export default CropTool;
