/**
 * Recoverable failure panel.
 *
 * Errors used to land in the "Log" pane as loose text, which read as a crash.
 * This names the file that broke, says what to do, and offers Retry.
 */
export interface ErrorPanelProps {
  message: string;
  /** The input at fault — required for E1/E2/E4 to be actionable. */
  fileName?: string | null;
  /** Concrete next step; the panel falls back to a generic one. */
  hint?: string;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}

/** Does the message read as an encryption/password problem? */
export function isPasswordProblem(message: string): boolean {
  return /password|encrypt|protected|locked/i.test(message);
}

export function ErrorPanel({
  message,
  fileName,
  hint,
  onRetry,
  retryLabel = 'Retry',
  className = '',
}: ErrorPanelProps) {
  const advice = hint ?? (isPasswordProblem(message)
    ? 'Enter the PDF password and run it again.'
    : 'Check the file, adjust the options, then try once more.');
  return (
    <div
      role="alert"
      className={`space-y-2 rounded-doodle-md border border-danger/25 bg-danger/5 p-3 ${className}`}
    >
      <p className="text-[11px] leading-relaxed text-ink">
        {fileName && (
          <span className="mr-1 break-all font-mono text-[10px] uppercase tracking-[0.08em] text-danger">
            {fileName}
          </span>
        )}
        <span className="font-medium">{message}</span>
      </p>
      <p className="text-[10px] leading-relaxed text-ink-muted">{advice}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="doodle-btn doodle-btn-secondary w-auto px-3 py-1.5 text-[11px]">
          {retryLabel}
        </button>
      )}
    </div>
  );
}
