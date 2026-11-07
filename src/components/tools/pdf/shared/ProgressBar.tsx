/**
 * Determinate/ineterminate progress for the rail and the workspace.
 *
 * `src/components/ui/ProgressBar.tsx` is bound to the media pipeline; this one
 * is presentational so a per-file row, a tool rail and a result panel can all
 * show the same honest bar without touching the store.
 */
export interface ProgressBarProps {
  /** 0..100. Values outside the range are clamped, never wrapped. */
  percent: number;
  /** Current step, e.g. "Compressing page 4 of 12". */
  message?: string | null;
  /** Leading label; defaults to the percentage so the row is never blank. */
  label?: string;
  tone?: 'accent' | 'success' | 'warn' | 'danger';
  /** No known denominator — animate the track instead of claiming a number. */
  indeterminate?: boolean;
  className?: string;
}

const TONE_FILL: Record<NonNullable<ProgressBarProps['tone']>, string> = {
  accent: 'bg-accent',
  success: 'bg-success',
  warn: 'bg-warn',
  danger: 'bg-danger',
};

export function ProgressBar({
  percent,
  message,
  label,
  tone = 'accent',
  indeterminate = false,
  className = '',
}: ProgressBarProps) {
  const value = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  // Assistive tech reads `aria-valuetext`, not the styled numbers next to the
  // track, so the stage name has to be in here too — otherwise a screen-reader
  // user hears "40%" with no idea 40 of what.
  const valueText = indeterminate
    ? message ?? 'Working, no time estimate yet'
    : `${Math.round(value)}%${message ? ` — ${message}` : ''}`;
  return (
    <div className={`space-y-1 ${className}`} data-progress={indeterminate ? 'unknown' : Math.round(value)}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-muted">
          {label ?? (indeterminate ? 'Working' : `${Math.round(value)}%`)}
        </span>
        {!indeterminate && (
          <span className="font-mono text-[10px] tabular-nums text-ink-soft">{Math.round(value)}%</span>
        )}
      </div>
      <div
        role="progressbar"
        aria-valuenow={indeterminate ? undefined : Math.round(value)}
        aria-valuemin={indeterminate ? undefined : 0}
        aria-valuemax={indeterminate ? undefined : 100}
        aria-valuetext={valueText}
        aria-busy={indeterminate || undefined}
        aria-label={label ?? 'Progress'}
        data-indeterminate={indeterminate || undefined}
        className="h-1.5 w-full overflow-hidden rounded-full bg-cream-border"
      >
        <div
          className={`h-full rounded-full transition-[width] duration-200 ${TONE_FILL[tone]} ${
            indeterminate ? 'w-1/3 animate-pulse' : ''
          }`}
          style={indeterminate ? undefined : { width: `${value}%` }}
        />
      </div>
      {message && <p className="text-[10px] leading-relaxed text-ink-soft">{message}</p>}
    </div>
  );
}
