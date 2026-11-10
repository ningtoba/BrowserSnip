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
 * * The unit — the margins are typed in the unit the definition's own `unit` select
 *   holds, and the panel prints the points that will be written beside them. The
 *   select used to exist only on a rail this page never mounts, while the card said
 *   "type exact margins in points, mm or inches": see `tests/pdf/crop-units.test.ts`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { fadeUp, scaleIn, staggerParent } from '@/lib/motion';
import { useFileStore } from '@/stores/file-store';
import { useProcessStore } from '@/stores/process-store';
import { usePdfTool } from '@/hooks/usePdfTool';
import { openPDF } from '@/lib/pdf/core/doc';
import { describeUnit, displayedSize, fromPoints, mediaBox } from '@/lib/pdf/core/pages';
import type { LengthUnit } from '@/lib/pdf/core/pages';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { marginPoints } from '@/lib/pdf/tools/legacy';
import { FieldControl } from '../shared/FieldControls';
import { getCropRect, getPageSizePt, setCropRect, subscribeCrop } from './CropMain';
import {
  describeCrop,
  distinctBoxes,
  edgeExtentPt,
  resolveTargets,
  setEdgeMargin,
  targetPage,
  type CropEdge,
  type CropFractions,
  type CropTargetPage,
} from './cropModel';

/** Geometry is read for at most this many pages; a 500-page scan need not wait. */
const GEOMETRY_LIMIT = 60;

const CROP_EDGES: CropEdge[] = ['top', 'right', 'bottom', 'left'];

/** The margins are typed, so the unit is whatever the definition's select holds. */
const DEFAULT_UNIT: LengthUnit = 'pt';

interface DocumentGeometry {
  name: string;
  numPages: number;
  pages: CropTargetPage[];
  inspected: number;
}

export function CropTool() {
  const file = useFileStore((s) => s.file);
  const { run, isRunning, values, setValue } = usePdfTool('pdf-crop');
  const warnings = useProcessStore((s) => s.warnings);

  const [rect, setRect] = useState<CropFractions>(getCropRect());
  /**
   * What the boxes hold while a person is typing.
   *
   * The displayed value is derived from the crop rectangle, so a keystroke that has
   * not landed yet ("0.", or a value the page is too small for) would be overwritten
   * mid-entry by the number it rounds to. The draft is dropped on blur, which is
   * when the derived value becomes the honest one.
   */
  const [draft, setDraft] = useState<Partial<Record<CropEdge, string>>>({});
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
  /** The sheet the margins are measured against: the one the preview shows. */
  const previewPage: CropTargetPage | null =
    preview ??
    (getPageSizePt().width > 0
      ? targetPage(0, getPageSizePt().width, getPageSizePt().height, 0)
      : null);
  const targets = useMemo(
    () => (allPages ? { pages: range(1, numPages), refused: [] } : resolveTargets(pageSpec, numPages)),
    [allPages, numPages, pageSpec],
  );
  const report = useMemo(
    () =>
      describeCrop({
        rect,
        preview: previewPage,
        targets: targets.pages,
        refused: targets.refused,
        numPages,
        allPages,
      }),
    [allPages, numPages, previewPage, rect, targets],
  );

  const sizes = useMemo(() => (geometry ? distinctBoxes(geometry.pages) : []), [geometry]);
  const rotated = useMemo(() => (geometry ? geometry.pages.filter((page) => page.rotation !== 0) : []), [geometry]);

  /**
   * The unit the four boxes are read in — the tool's own field, not a copy.
   *
   * Rendering the definition's field is what keeps this panel's label, help line and
   * option list tied to `pdf-crop.fields`, and writing `unit` through the value bag
   * is what stops the panel pinning `unit: 'pt'` over a control it shows. `run`
   * converts the number it is given (`marginPoints`, imported here so the prediction
   * below and the file cannot disagree), so declaring the same edge in pt, mm, cm or
   * in lands one `/MediaBox` — measured in `tests/pdf/crop-units.test.ts`.
   */
  const unitField = useMemo(
    () => (getPdfTool('pdf-crop')?.fields ?? []).find((field) => field.key === 'unit'),
    [],
  );
  const unit: LengthUnit = typeof values.unit === 'string' ? (values.unit as LengthUnit) : DEFAULT_UNIT;

  /** The margin this displayed edge currently takes off the page, in points. */
  const displayedMarginPt = useCallback(
    (edge: CropEdge): number => (previewPage ? rect[edge] * edgeExtentPt(previewPage, edge) : 0),
    [previewPage, rect],
  );

  /** What the box shows while the field is not being typed in. */
  const shownMargin = useCallback(
    (edge: CropEdge): string => {
      const points = displayedMarginPt(edge);
      const value = unit === 'pt' ? points : fromPoints(points, unit);
      return String(Number(value.toFixed(unit === 'pt' ? 1 : 4)));
    },
    [displayedMarginPt, unit],
  );

  const typeMargin = useCallback(
    (edge: CropEdge, raw: string) => {
      setDraft((current) => ({ ...current, [edge]: raw }));
      const parsed = raw.trim() === '' ? 0 : Number(raw);
      if (!previewPage || !Number.isFinite(parsed)) return;
      setCropRect(setEdgeMargin(rect, previewPage, edge, parsed, unit));
    },
    [previewPage, rect, unit],
  );

  /**
   * The four numbers handed to the tool, in the unit the select holds.
   *
   * `report.marginsPt` are already stored-box margins — the rotation re-aim happened
   * in the model, and the note above says which displayed edge became which — so the
   * conversion here is unit only, never geometry.
   */
  const outbound = useMemo(() => {
    const out: Record<string, number> = {};
    for (const edge of CROP_EDGES) {
      const points = report.marginsPt[edge];
      out[edge] = unit === 'pt' ? round(points) : Math.round(fromPoints(points, unit) * 10000) / 10000;
    }
    return out;
  }, [report.marginsPt, unit]);

  /** The points each page's own box will lose: the tool's own rounding, not a nicer number. */
  const writtenPt = CROP_EDGES.map((edge) => marginPoints(outbound[edge] ?? 0, unit)).join('/');

  const applyCrop = useCallback(() => {
    if (!report.valid) return;
    void run({
      // 1-based pages the panel resolved from the typed spec, and the margins in the
      // unit the select holds — `unit` itself arrives with the field's own value, so
      // nothing here overrides the control the person just used.
      pages: targets.pages,
      ...outbound,
      allPages,
    });
  }, [allPages, outbound, report, run, targets.pages]);

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
        Drag the blue handles on the preview, or type an exact margin below. The boxes are in the unit chosen here; the
        line under them is what the file will hold, in points of each page's own box.
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

      {/* The unit the margins are typed in, from the definition that converts it */}
      {unitField && (
        <motion.div
          variants={fadeUp}
          data-crop-unit={unit}
          className="rounded-[14px] border border-cream-border bg-white p-3 shadow-doodle"
        >
          <FieldControl
            field={unitField}
            values={values}
            onChange={(_key, value) => {
              // The typed boxes are about to mean something else, so drop the
              // in-flight text and let them re-derive in the new unit.
              setDraft({});
              setValue('unit', String(value));
            }}
          />
        </motion.div>
      )}

      {/* Crop values: typed here, painted on the preview, written by the tool */}
      <motion.section variants={fadeUp} className="space-y-2 rounded-[14px] border border-cream-border bg-white p-4 shadow-doodle">
        {/*
          Two across, not four: a millimetre entry is "15.24" and an inch entry is
          "0.6", and a box that clips the digits it was typed into is worse than no
          box at all. The old read-only grid could afford four because it printed
          nothing wider than three digits.
        */}
        <div className="grid grid-cols-2 gap-2">
          {CROP_EDGES.map((side) => (
            <div key={side}>
              <label
                htmlFor={`crop-margin-${side}`}
                className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted"
              >
                {side}
                {/* The unit each box is read in, spelled where the number is typed. */}
                <span className="ml-1 opacity-70">· {unit}</span>
              </label>
              <input
                id={`crop-margin-${side}`}
                data-crop-margin={side}
                data-crop-unit={unit}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
                value={draft[side] ?? shownMargin(side)}
                aria-label={`${side} margin, in ${describeUnit(unit)}`}
                onChange={(event) => typeMargin(side, event.target.value)}
                onBlur={() =>
                  setDraft((current) => {
                    const next = { ...current };
                    delete next[side];
                    return next;
                  })
                }
                className="doodle-input text-center text-[11px] font-mono tabular-nums py-1.5 bg-cream"
              />
              <p className="mt-0.5 text-center font-mono text-[8px] tabular-nums text-ink-muted">
                {(rect[side] * 100).toFixed(0)}%
              </p>
            </div>
          ))}
        </div>
        <p className="text-center font-mono text-[10px] tabular-nums text-ink-soft" data-crop-written-pt={writtenPt}>
          writes {writtenPt} pt (top/right/bottom/left) to each page's own box
        </p>
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

      {warnings.length > 0 && (
        <motion.ul
          variants={scaleIn}
          role="status"
          data-crop-warnings={warnings.length}
          className="space-y-1 rounded-[12px] border border-warn/25 bg-warn/[0.07] px-3 py-2.5 text-[10px] leading-relaxed text-warn"
        >
          {warnings.map((warning) => (
            <li key={warning}>· {warning}</li>
          ))}
        </motion.ul>
      )}

      <button
        type="button"
        onClick={applyCrop}
        id="tool-process-btn"
        disabled={!report.valid || !file || isRunning}
        title={report.valid ? 'Write the cropped PDF' : 'Fix the crop first — it would not produce a page.'}
        className="doodle-btn disabled:opacity-50"
      >
        {isRunning
          ? 'Cropping…'
          : `Apply crop${report.valid && targets.pages.length > 0 ? ` (${targets.pages.length} page${targets.pages.length === 1 ? '' : 's'})` : ''}`}
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
