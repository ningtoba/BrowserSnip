import { useState } from 'react';
import { downloadBlob, formatFileSize } from '@/lib/utils/download';
import type { ByteSource } from '@/lib/pdf/tools/types';
import { splitFileName } from './toolForm';
import { EmptyState } from './EmptyState';
import { FOCUS_RING } from './focusRing';

/** One produced file. */
export interface ResultItem {
  name: string;
  blob: Blob;
  /** Pages in this output, when the tool knows (E6/E7 reporting). */
  pages?: number | null;
  /**
   * Who wrote *these* bytes, said by the code that wrote them.
   *
   * `null`/omitted means the producer did not claim one, which the card reports as
   * "not reported" wherever an engine was expected rather than guessing from the
   * tool's declaration.
   */
  producedBy?: ByteSource | null;
}

export interface ResultCardProps {
  outputs: ResultItem[];
  /** Total input bytes, so the card can show before → after (E14). */
  sizeBefore?: number | null;
  /**
   * Pages in the primary output, as the producer reported them
   * (`RunOutcome.pagesOut`). Wins over the sum of `outputs`, which most tools
   * leave blank because they hand back bytes rather than a per-file breakdown.
   */
  pages?: number | null;
  /**
   * Pages the run started with. Reported next to the output count so "Split 12
   * pages" is a number the user can check rather than a claim (research §4).
   */
  pagesIn?: number | null;
  /**
   * The engines this tool declares, for one purpose only: admitting that a run
   * reported no producer. It is never printed as the answer — that was the bug
   * (`tool.engines[0]` stood in for the engine that ran).
   */
  declared?: readonly string[];
  warnings?: string[];
  /** The tool's own summary line, when it has one. */
  message?: string | null;
  /** Untouched input, offered when "optimising" made the file bigger. */
  original?: ResultItem | null;
  onDownload?: (item: ResultItem) => void;
  onDownloadAll?: (items: ResultItem[]) => void;
  onZip?: (items: ResultItem[]) => void;
  emptyTitle?: string;
  emptyBody?: string;
  /**
   * Full-page treatment: the success screen makes the download the biggest
   * thing on the page, while a card inside an editor's rail stays compact.
   */
  hero?: boolean;
  className?: string;
}

const ENGINE_LABELS: Record<string, string> = {
  pymupdf: 'PyMuPDF',
  ghostscript: 'Ghostscript',
  cpdf: 'cpdf',
};

/**
 * The `Engine` row's answer for one file: who wrote these bytes.
 *
 * A fallback names the engine that did *not* produce the file, because that is the
 * sentence the card used to get backwards — `pdf-to-pdfa` printed "Ghostscript" over
 * a file `bestEffortPdfA` wrote, and the label is the only reason nobody noticed for
 * a session (`docs/research/pdfa-attribution-recheck.md`).
 */
export function describeSource(source: ByteSource): { text: string; warn: boolean } {
  switch (source.via) {
    case 'engine':
      return { text: ENGINE_LABELS[source.engine] ?? source.engine, warn: false };
    case 'fallback':
      return {
        text: `local path · ${ENGINE_LABELS[source.engine] ?? source.engine} not used`,
        warn: true,
      };
    case 'core':
      return { text: 'local path · no engine', warn: false };
  }
}

/** What the card would say about each file on its own, in order. */
function sourceLabels(outputs: ResultItem[]): Array<{ text: string; warn: boolean }> {
  return outputs.map((item) =>
    item.producedBy ? describeSource(item.producedBy) : { text: 'not reported', warn: true },
  );
}

/**
 * The batch's provenance, per run rather than per declaration.
 *
 * One answer when every file agrees; `mixed` when they do not, with each file's own
 * label beside it in the list below. Silence is only allowed for a tool that has no
 * engine to speak of — where one is declared and the run said nothing, the row says
 * "not reported" instead of lending the engine a run it did not have.
 */
export function describeProvenance(
  outputs: ResultItem[],
  declared: readonly string[],
): { text: string; warn: boolean } | null {
  if (outputs.length === 0) return null;
  const labels = sourceLabels(outputs);
  const distinct = [...new Set(labels.map((label) => label.text))];
  const warn = labels.some((label) => label.warn);
  if (distinct.length > 1) return { text: 'mixed · see the list below', warn };
  if (distinct[0] === 'not reported') {
    return declared.length > 0 ? { text: 'not reported', warn: true } : null;
  }
  return { text: distinct[0], warn };
}

/** `2.4 MB → 1.1 MB · 54% smaller`, honest about growth too. */
export function describeDelta(before: number | null | undefined, after: number | null | undefined): string | null {
  if (after == null || after <= 0) return null;
  if (before == null || before <= 0) return formatFileSize(after);
  const pct = Math.round(((after - before) / before) * 100);
  const head = `${formatFileSize(before)} → ${formatFileSize(after)}`;
  if (pct <= -1) return `${head} · ${Math.abs(pct)}% smaller`;
  if (pct >= 1) return `${head} · ${pct}% larger`;
  return `${head} · unchanged`;
}

/**
 * `12 → 4`, or the one side that was actually counted.
 *
 * A tool that hands back images has no page count, and inventing one would be
 * the same lie as "Done" for a run that did nothing (E13).
 */
export function describePages(
  pagesIn: number | null | undefined,
  pagesOut: number | null | undefined,
): string | null {
  const hasIn = typeof pagesIn === 'number' && pagesIn > 0;
  const hasOut = typeof pagesOut === 'number' && pagesOut > 0;
  if (hasIn && hasOut) return `${pagesIn} → ${pagesOut}`;
  if (hasOut) return String(pagesOut);
  if (hasIn) return `${pagesIn} in · out not counted`;
  return null;
}

/** Words a summary uses to promise the file got smaller. */
const SHRINK_CLAIM = /smaller|compress|shrink|reduc|slim|optimi[sz]|saved|lighter/i;

/**
 * Never repeat a promise the numbers contradict (E14).
 *
 * The optimize tools return a line like "Compressed to 1.2 MB" built from their
 * own intent, not from the result. When the file came out bigger, that sentence
 * is false the moment it is printed, and the card already says the truth in the
 * size row and the growth note — so the claim is dropped, not rephrased.
 */
export function honestSummary(
  message: string | null | undefined,
  grew: boolean,
): string | null {
  const text = message?.trim();
  if (!text) return message ?? null;
  if (grew && SHRINK_CLAIM.test(text)) return null;
  return text;
}

/**
 * The result summary every tool surface shares: what it is called, what it
 * weighs now, how many pages, which engine made it, what went sideways, and
 * the download affordances.
 */
export function ResultCard({
  outputs,
  sizeBefore,
  pages,
  pagesIn,
  declared = [],
  warnings = [],
  message,
  original,
  onDownload,
  onDownloadAll,
  onZip,
  emptyTitle = 'Nothing produced yet',
  emptyBody = 'Set the options and run the tool — the result lands here.',
  hero = false,
  className = '',
}: ResultCardProps) {
  const [zipping, setZipping] = useState(false);
  if (outputs.length === 0) {
    return <EmptyState className={className} icon="📦" title={emptyTitle} body={emptyBody} />;
  }

  const sizeAfter = outputs.reduce((sum, item) => sum + item.blob.size, 0);
  const delta = describeDelta(sizeBefore, sizeAfter);
  const grew = sizeBefore != null && sizeBefore > 0 && sizeAfter > sizeBefore;
  const pageTotal = pages ?? outputs.reduce((sum, item) => sum + (item.pages ?? 0), 0);
  const pageCount = describePages(pagesIn, pageTotal);
  const summary = honestSummary(message, grew);
  const multi = outputs.length > 1;
  // Who wrote the bytes, per file, and whether the batch has more than one answer.
  const provenance = describeProvenance(outputs, declared);
  const labels = sourceLabels(outputs);
  const mixed = new Set(labels.map((label) => label.text)).size > 1;

  const grab = (item: ResultItem) => (onDownload ? onDownload(item) : downloadBlob(item.blob, item.name));

  /** The produced name, with its extension and trailing digits kept reachable. */
  const primaryName = splitFileName(multi ? `${outputs.length} files` : outputs[0].name);

  /** Compact in a rail, dominant on the success screen. */
  const primary = hero
    ? 'doodle-btn w-auto flex-1 min-h-[56px] min-w-[220px] px-6 text-[15px]'
    : 'doodle-btn w-auto flex-1 px-3 py-1.5 text-[11px]';
  const secondary = hero
    ? 'doodle-btn doodle-btn-secondary w-auto min-h-[48px] px-5 text-[13px]'
    : 'doodle-btn doodle-btn-secondary w-auto px-3 py-1.5 text-[11px]';

  const grabAll = () => {
    if (onDownloadAll) return onDownloadAll(outputs);
    outputs.forEach((item, index) => {
      // Staggered: browsers drop simultaneous programmatic downloads.
      window.setTimeout(() => grab(item), index * 220);
    });
  };

  const zip = async () => {
    if (onZip) return onZip(outputs);
    setZipping(true);
    try {
      const { default: JSZip } = await import('jszip');
      const archive = new JSZip();
      for (const item of outputs) archive.file(item.name, item.blob);
      const blob = await archive.generateAsync({ type: 'blob', compression: 'DEFLATE' });
      const stem = (outputs[0]?.name ?? 'browsersnip').replace(/\.[^.]+$/, '') || 'browsersnip';
      downloadBlob(blob, `${stem}-results.zip`);
    } finally {
      setZipping(false);
    }
  };

  return (
    <section
      className={`space-y-2 rounded-doodle-md border border-success/25 bg-success/5 ${
        hero ? 'p-5' : 'p-3'
      } ${className}`}
      aria-label="Result"
    >
      <div className="flex items-baseline justify-between gap-2">
        <p
          className={`min-w-0 font-display font-semibold text-ink ${hero ? 'text-[16px]' : 'text-[12px]'}`}
          title={outputs[0].name}
          data-output-name={primaryName.tail ? 'split' : 'whole'}
        >
          <span className="line-clamp-2 break-words">{primaryName.head}</span>
          {primaryName.tail && (
            <span
              data-output-tail
              className={`block break-all font-mono font-normal text-ink-muted ${hero ? 'text-[12px]' : 'text-[10px]'}`}
            >
              {primaryName.tail}
            </span>
          )}
        </p>
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.08em] text-success">
          Ready
        </span>
      </div>

      <dl className={`space-y-0.5 font-mono text-ink-soft ${hero ? 'text-[12px]' : 'text-[10px]'}`}>
        {delta && (
          <div className="flex items-baseline justify-between gap-2">
            <dt className="uppercase tracking-[0.08em] text-ink-muted">Size</dt>
            <dd className={`tabular-nums ${grew ? 'text-warn' : 'text-ink-soft'}`}>{delta}</dd>
          </div>
        )}
        {pageCount && (
          <div className="flex items-baseline justify-between gap-2">
            <dt className="uppercase tracking-[0.08em] text-ink-muted">Pages</dt>
            <dd className="tabular-nums">{pageCount}</dd>
          </div>
        )}
        {provenance && (
          <div className="flex items-baseline justify-between gap-2">
            <dt className="uppercase tracking-[0.08em] text-ink-muted">Engine</dt>
            <dd className={provenance.warn ? 'text-warn' : 'text-ink-soft'}>{provenance.text}</dd>
          </div>
        )}
      </dl>

      {summary && (
        <p className={`leading-relaxed text-ink ${hero ? 'text-[13px]' : 'text-[11px]'}`}>{summary}</p>
      )}

      {grew && (
        <p className="rounded-doodle border border-warn/25 bg-warn/5 px-2 py-1 text-[10px] leading-relaxed text-warn">
          The file came out bigger than the one you started with. Nothing was
          overwritten — download the original unless you need this variant.
        </p>
      )}

      {warnings.length > 0 && (
        <>
          <p className="font-mono text-[9px] uppercase tracking-[0.08em] text-ink-muted">
            What you should know ({warnings.length})
          </p>
          <ul className="space-y-1">
            {warnings.map((warning) => (
              <li
                key={warning}
                className="rounded-doodle border border-warn/25 bg-cream-light/70 px-2 py-1 text-[10px] leading-relaxed text-warn"
              >
                {warning}
              </li>
            ))}
          </ul>
        </>
      )}

      {multi && (
        <ul className="space-y-1">
          {outputs.map((item, index) => (
            <li
              key={`${item.name}-${index}`}
              className="flex items-center justify-between gap-2 rounded-doodle border border-cream-border bg-cream-light px-2 py-1"
            >
              <span className="min-w-0 break-words text-[10px] text-ink line-clamp-2" title={item.name}>
                {item.name}
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                <span className="font-mono text-[10px] text-ink-muted tabular-nums">
                  {formatFileSize(item.blob.size)}
                </span>
                {item.pages != null && (
                  <span className="font-mono text-[10px] text-ink-muted tabular-nums">{item.pages}p</span>
                )}
                {mixed && (
                  // A mixed batch cannot be answered by one label, so each file says
                  // for itself which path wrote it.
                  <span
                    className={`font-mono text-[10px] ${labels[index].warn ? 'text-warn' : 'text-ink-muted'}`}
                  >
                    {labels[index].text}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => grab(item)}
                  aria-label={`Download ${item.name}`}
                  title={`Download ${item.name}`}
                  className={`flex h-7 w-7 items-center justify-center rounded border border-cream-border text-[11px] text-ink-muted hover:border-accent hover:text-accent ${FOCUS_RING}`}
                >
                  ↓
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className={`flex flex-wrap items-center gap-1.5 ${hero ? 'gap-2.5 pt-1' : ''}`}>
        {!multi && (
          <button type="button" onClick={() => grab(outputs[0])} className={`${primary} ${FOCUS_RING}`}>
            Download
          </button>
        )}
        {multi && (
          <button type="button" onClick={grabAll} className={`${primary} ${FOCUS_RING}`}>
            Download all
          </button>
        )}
        {multi && (
          <button
            type="button"
            onClick={() => void zip()}
            disabled={zipping}
            className={`${secondary} disabled:opacity-50 ${FOCUS_RING}`}
          >
            {zipping ? 'Zipping…' : 'Download as zip'}
          </button>
        )}
        {grew && original && (
          <button type="button" onClick={() => grab(original)} className={`${secondary} ${FOCUS_RING}`}>
            Keep original
          </button>
        )}
      </div>
    </section>
  );
}
