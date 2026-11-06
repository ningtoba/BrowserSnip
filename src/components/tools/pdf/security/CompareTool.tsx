/**
 * CompareTool — sidebar for Compare PDF.
 *
 * Adjust sensitivity and highlight colour, then generate a comparison PDF with
 * differences highlighted.
 *
 * The diff itself is computed by the preview (`CompareMain`), page by page, over
 * as many pages as both documents have. This panel's job is to state that scope
 * before the run: which two files, how many pages actually get compared, what the
 * threshold catches, and what "0% differ" means (E6, E13, E15, E18). The wording
 * lives in `editor/documentFacts` so the sentence is testable without a canvas.
 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import { motion } from 'framer-motion';
import { useFileStore } from '@/stores/file-store';
import { usePDFEngine } from '@/hooks/usePDFEngine';
import { fadeUp, scaleIn, staggerParent } from '@/lib/motion';
import { openPDF } from '@/lib/pdf/core/doc';
import {
  clampSensitivity,
  compareReport,
  sensitivityWords,
  type DocPageCount,
} from '@/components/tools/pdf/editor/documentFacts';
import {
  getCompareState, setCompareSensitivity, setCompareHighlightColor,
  subscribeCompare,
} from './CompareMain';

export function CompareTool() {
  const files = useFileStore((s) => s.files);
  const { process } = usePDFEngine();
  const [st, setSt] = useState(getCompareState());
  const [counts, setCounts] = useState<{ a: DocPageCount | null; b: DocPageCount | null }>({ a: null, b: null });

  useEffect(() => subscribeCompare(() => setSt(getCompareState())), []);

  // The preview knows the minimum of the two page counts; the panel measures both,
  // because "pages 6–9 of the longer file were not compared" is the sentence that
  // decides whether the output can be trusted.
  useEffect(() => {
    let disposed = false;
    const pair = [files[0], files[1]];
    if (!pair[0] && !pair[1]) {
      setCounts({ a: null, b: null });
      return () => {
        disposed = true;
      };
    }
    void (async () => {
      const measured = await Promise.all(
        pair.map(async (entry): Promise<DocPageCount | null> => {
          if (!entry) return null;
          try {
            const doc = await openPDF(new Uint8Array(await entry.arrayBuffer()), {
              ignoreEncryption: true,
              updateMetadata: false,
            });
            return { name: entry.name, pages: doc.getPageCount() };
          } catch (error) {
            return {
              name: entry.name,
              pages: 0,
              error: error instanceof Error ? error.message : 'it could not be opened for measuring.',
            };
          }
        }),
      );
      if (!disposed) setCounts({ a: measured[0], b: measured[1] });
    })();
    return () => {
      disposed = true;
    };
  }, [files]);

  const report = useMemo(
    () =>
      compareReport({
        a: counts.a,
        b: counts.b,
        filesLoaded: files.length,
        previewPages: st.totalPages,
        diffPercent: st.diffPercent,
      }),
    [counts.a, counts.b, files.length, st.diffPercent, st.totalPages],
  );

  const handleProcess = useCallback(() => {
    if (!report.valid) return;
    // SAFETY: the legacy panel API takes a loose param bag; `compare` reads only
    // these two keys out of it.
    process({
      toolId: 'compare',
      params: {
        highlightColor: st.highlightColor,
        sensitivity: clampSensitivity(st.sensitivity),
      } as unknown as Record<string, unknown>,
    });
  }, [process, report.valid, st.highlightColor, st.sensitivity]);

  if (files.length < 2) {
    return (
      <motion.div
        initial="hidden"
        animate="visible"
        variants={staggerParent}
        className="doodle-section space-y-3"
      >
        <motion.p variants={fadeUp} className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Compare PDFs</motion.p>
        <p className="text-[11px] text-ink-muted leading-relaxed">
          Add 2 PDF files to compare them. Differences will be highlighted on the preview and in the output.
        </p>
        <motion.div variants={scaleIn} className="p-3 rounded-[12px] border border-cream-border bg-cream-soft">
          <p className="text-[10px] text-ink-muted">
            {files.length === 0 ? 'No files loaded.' : `${files.length} file(s) loaded — need 2.`}
          </p>
          <p className="mt-1 text-[10px] leading-relaxed text-ink-muted">{report.notes[0]}</p>
        </motion.div>
        {files.length > 2 && (
          <p className="text-[10px] leading-relaxed text-warn">
            {files.length} documents are open; only the first two are ever compared, so close the others to be sure which
            pair you mean.
          </p>
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
      <motion.p variants={fadeUp} className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Compare PDFs</motion.p>

      {/* File info */}
      <motion.div variants={fadeUp} className="p-3 rounded-[12px] border border-cream-border bg-white space-y-1 shadow-doodle">
        <p className="text-[10px] text-ink-muted font-mono truncate">
          A: {files[0]?.name}{counts.a ? ` · ${counts.a.pages} page${counts.a.pages === 1 ? '' : 's'}` : ''}
        </p>
        <p className="text-[10px] text-ink-muted font-mono truncate">
          B: {files[1]?.name}{counts.b ? ` · ${counts.b.pages} page${counts.b.pages === 1 ? '' : 's'}` : ''}
        </p>
        {files.length > 2 && (
          <p className="text-[10px] leading-relaxed text-warn">
            {files.length - 2} more document{files.length - 2 === 1 ? ' is' : 's are'} open and ignored — a comparison is
            always the first pair.
          </p>
        )}
      </motion.div>

      {/* Diff stats */}
      <motion.div variants={scaleIn} className="rounded-[12px] border border-cream-border bg-white p-3 text-center shadow-doodle">
        <p className="text-2xl font-bold text-accent tabular-nums" data-compare-diff={st.diffPercent}>
          {st.diffPercent}%
        </p>
        <p className="text-[10px] text-ink-muted">
          of pixels differ on {report.comparedPages} compared page{report.comparedPages === 1 ? '' : 's'}
        </p>
      </motion.div>

      {/* What will be written, in words (E6, E13) */}
      <motion.ul
        variants={scaleIn}
        data-compare-report={report.notes.length}
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

      {/* Sensitivity */}
      <motion.div variants={fadeUp}>
        <label className="block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
          Sensitivity: <span className="tabular-nums">{clampSensitivity(st.sensitivity)}</span>
        </label>
        <input type="range" min={5} max={150} value={clampSensitivity(st.sensitivity)}
          onChange={(e) => setCompareSensitivity(clampSensitivity(Number(e.target.value)))}
          className="w-full" />
        <div className="flex justify-between text-[8px] text-ink-muted/50">
          <span>More sensitive</span>
          <span>Less sensitive</span>
        </div>
        <p className="mt-1 text-[10px] leading-relaxed text-ink-muted">{sensitivityWords(st.sensitivity)}.</p>
      </motion.div>

      {/* Highlight color */}
      <motion.div variants={fadeUp}>
        <label className="block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Highlight Color</label>
        <input type="color" value={st.highlightColor}
          onChange={(e) => setCompareHighlightColor(e.target.value)}
          className="w-full h-6 rounded-[10px] bg-cream border border-cream-border mt-1 cursor-pointer" />
      </motion.div>

      {/* Info */}
      <motion.p variants={scaleIn} className="rounded-[12px] border border-cream-border bg-cream-soft px-3.5 py-2.5 text-[10px] text-ink-muted leading-relaxed">
        Differences are computed pixel-by-pixel. Lower sensitivity catches more subtle changes. The output PDF shows
        document A with differences from B highlighted.
      </motion.p>

      <button
        onClick={handleProcess}
        id="tool-process-btn"
        className="doodle-btn disabled:opacity-50"
        disabled={!report.valid}
        title={report.valid ? undefined : report.headline}
      >
        Generate Comparison PDF
      </button>
    </motion.div>
  );
}

export default CompareTool;
