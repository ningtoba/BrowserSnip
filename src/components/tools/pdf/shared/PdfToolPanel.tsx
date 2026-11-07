/**
 * The generated tool page.
 *
 * `PdfToolPanel` is the adapter between a `PdfToolDefinition` and the page
 * shape in `ToolSurface`: it gathers the tool's state through `usePdfTool` and
 * hands the surface everything the states need — intake, cards, options, run,
 * result. A tool that only needs controls writes no component at all.
 *
 * The controls themselves live in `FieldControls`, the file cards in
 * `FileCards`, and the drop-first empty state in `FileIntake`; this file keeps
 * only what is genuinely per-tool, plus the report view that reporting tools
 * produce instead of a file.
 */
import { useFileStore } from '@/stores/file-store';
import { useProcessStore, type ToolReport } from '@/stores/process-store';
import { usePdfTool } from '@/hooks/usePdfTool';
import type { PdfToolDefinition } from '@/lib/pdf/tools/types';
import { ToolSurface } from './ToolSurface';

export interface PdfToolPanelProps {
  toolId: string;
  /** Extra controls rendered above the generated form (editor state, etc.). */
  before?: React.ReactNode;
  /** Render the page but keep it out of sight; the caller owns the visible run. */
  hidden?: boolean;
  /** Called after a successful run with the produced outputs. */
  onDone?: () => void;
}

/** One tool's page, driven entirely by its registry definition. */
export function PdfToolPanel({ toolId, before, hidden, onDone }: PdfToolPanelProps) {
  const file = useFileStore((s) => s.file);
  const metadata = useFileStore((s) => s.metadata);
  const report = useProcessStore((s) => s.report);
  // A page count is only usable for validation while it describes this file.
  const pageCount =
    metadata && 'pageCount' in metadata && metadata.pageCount > 0 && (!file || metadata.fileName === file.name)
      ? metadata.pageCount
      : null;
  const api = usePdfTool(toolId, { pageCount });

  const panel = (
    <ToolSurface
      api={api}
      before={before}
      onDone={onDone}
      report={report ? <ReportView report={report} /> : null}
    />
  );

  if (hidden) {
    return (
      <div className="hidden" aria-hidden>
        {panel}
      </div>
    );
  }
  return panel;
}

// ── report view ─────────────────────────────────────────────────────────────

/** Renders a `kind: 'report'` result — metadata, comparisons, page sizes. */
export function ReportView({ report }: { report: ToolReport | null }) {
  if (!report) return null;
  return (
    <div className="space-y-4">
      {report.message && (
        <p className="rounded-doodle-md border border-accent/20 bg-accent/5 p-3 text-[12px] leading-relaxed text-ink">
          {report.message}
        </p>
      )}
      {report.sections.map((section) => (
        <section
          key={section.title}
          className="overflow-hidden rounded-doodle-md border border-cream-border bg-cream-light"
        >
          <h3 className="border-b border-cream-border px-4 py-2 font-display text-[13px] font-semibold text-ink">
            {section.title}
          </h3>
          {section.rows && (
            <dl className="divide-y divide-cream-border">
              {section.rows.map((row, index) => (
                <div
                  key={`${row.label}-${index}`}
                  className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] gap-3 px-4 py-1.5"
                >
                  <dt className="truncate font-mono text-[10px] uppercase tracking-[0.08em] text-ink-muted">
                    {row.label}
                  </dt>
                  <dd className="break-words font-mono text-[11px] text-ink-soft">{row.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {section.text && (
            <pre className="whitespace-pre-wrap px-4 py-3 font-mono text-[11px] leading-relaxed text-ink-soft">
              {section.text}
            </pre>
          )}
          {section.images && section.images.length > 0 && (
            <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3">
              {section.images.map((image, index) => (
                <figure key={`${image.label}-${index}`} className="space-y-1">
                  <img
                    src={URL.createObjectURL(image.blob)}
                    alt={image.label}
                    className="w-full rounded border border-cream-border"
                  />
                  <figcaption className="text-[10px] text-ink-muted">{image.label}</figcaption>
                </figure>
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

/** The generated field control, reused by bespoke surfaces. */
export { FieldControl } from './FieldControls';

/** Exposed so bespoke editors can reuse the same page chrome. */
export type { PdfToolDefinition };
