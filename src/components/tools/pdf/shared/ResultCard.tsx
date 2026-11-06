import { useState } from 'react';
import { downloadBlob, formatFileSize } from '@/lib/utils/download';
import { EmptyState } from './EmptyState';

/** One produced file. */
export interface ResultItem {
  name: string;
  blob: Blob;
  /** Pages in this output, when the tool knows (E6/E7 reporting). */
  pages?: number | null;
}

export interface ResultCardProps {
  outputs: ResultItem[];
  /** Total input bytes, so the card can show before → after (E14). */
  sizeBefore?: number | null;
  /** Total output pages, when they differ from the sum of `outputs`. */
  pages?: number | null;
  /** Engine the run actually used, e.g. `"ghostscript"`; `null` = core only. */
  engine?: string | null;
  /** The optional engine was unreachable, so a degraded path produced this. */
  degraded?: boolean;
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
  className?: string;
}

const ENGINE_LABELS: Record<string, string> = {
  pymupdf: 'PyMuPDF',
  ghostscript: 'Ghostscript',
  cpdf: 'cpdf',
};

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
 * The result summary every tool surface shares: what it is called, what it
 * weighs now, how many pages, which engine made it, what went sideways, and
 * the download affordances.
 */
export function ResultCard({
  outputs,
  sizeBefore,
  pages,
  engine,
  degraded = false,
  warnings = [],
  message,
  original,
  onDownload,
  onDownloadAll,
  onZip,
  emptyTitle = 'Nothing produced yet',
  emptyBody = 'Set the options and run the tool — the result lands here.',
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
  const multi = outputs.length > 1;

  const grab = (item: ResultItem) => (onDownload ? onDownload(item) : downloadBlob(item.blob, item.name));

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
      className={`space-y-2 rounded-doodle-md border border-success/25 bg-success/5 p-3 ${className}`}
      aria-label="Result"
    >
      <div className="flex items-baseline justify-between gap-2">
        <p className="truncate font-display text-[12px] font-semibold text-ink" title={outputs[0].name}>
          {multi ? `${outputs.length} files` : outputs[0].name}
        </p>
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.08em] text-success">
          Ready
        </span>
      </div>

      <dl className="space-y-0.5 font-mono text-[10px] text-ink-soft">
        {delta && (
          <div className="flex items-baseline justify-between gap-2">
            <dt className="uppercase tracking-[0.08em] text-ink-muted">Size</dt>
            <dd className={`tabular-nums ${grew ? 'text-warn' : 'text-ink-soft'}`}>{delta}</dd>
          </div>
        )}
        {pageTotal > 0 && (
          <div className="flex items-baseline justify-between gap-2">
            <dt className="uppercase tracking-[0.08em] text-ink-muted">Pages</dt>
            <dd className="tabular-nums">{pageTotal}</dd>
          </div>
        )}
        {(engine || degraded) && (
          <div className="flex items-baseline justify-between gap-2">
            <dt className="uppercase tracking-[0.08em] text-ink-muted">Engine</dt>
            <dd className={degraded ? 'text-warn' : 'text-ink-soft'}>
              {engine ? ENGINE_LABELS[engine] ?? engine : 'pdf-lib core'}
              {degraded ? ' · degraded' : ''}
            </dd>
          </div>
        )}
      </dl>

      {message && <p className="text-[11px] leading-relaxed text-ink">{message}</p>}

      {grew && (
        <p className="rounded-doodle border border-warn/25 bg-warn/5 px-2 py-1 text-[10px] leading-relaxed text-warn">
          The result is bigger than the input. Keep the original unless you need this
          variant — nothing was overwritten.
        </p>
      )}

      {warnings.length > 0 && (
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
      )}

      {multi && (
        <ul className="space-y-1">
          {outputs.map((item, index) => (
            <li
              key={`${item.name}-${index}`}
              className="flex items-center justify-between gap-2 rounded-doodle border border-cream-border bg-cream-light px-2 py-1"
            >
              <span className="min-w-0 truncate text-[10px] text-ink" title={item.name}>
                {item.name}
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                <span className="font-mono text-[10px] text-ink-muted tabular-nums">
                  {formatFileSize(item.blob.size)}
                </span>
                {item.pages != null && (
                  <span className="font-mono text-[10px] text-ink-muted tabular-nums">{item.pages}p</span>
                )}
                <button
                  type="button"
                  onClick={() => grab(item)}
                  aria-label={`Download ${item.name}`}
                  className="rounded border border-cream-border px-1 text-[10px] text-ink-muted hover:border-accent hover:text-accent"
                >
                  ↓
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {!multi && (
          <button type="button" onClick={() => grab(outputs[0])} className="doodle-btn w-auto flex-1 px-3 py-1.5 text-[11px]">
            Download
          </button>
        )}
        {multi && (
          <button type="button" onClick={grabAll} className="doodle-btn w-auto flex-1 px-3 py-1.5 text-[11px]">
            Download all
          </button>
        )}
        {multi && (
          <button
            type="button"
            onClick={() => void zip()}
            disabled={zipping}
            className="doodle-btn doodle-btn-secondary w-auto px-3 py-1.5 text-[11px] disabled:opacity-50"
          >
            {zipping ? 'Zipping…' : 'Download as zip'}
          </button>
        )}
        {grew && original && (
          <button
            type="button"
            onClick={() => grab(original)}
            className="doodle-btn doodle-btn-secondary w-auto px-3 py-1.5 text-[11px]"
          >
            Keep original
          </button>
        )}
      </div>
    </section>
  );
}
