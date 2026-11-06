import type { ReactNode } from 'react';

/**
 * The honest "nothing yet" panel.
 *
 * E13 — a tool that found no forms, tables or images used to hand back an empty
 * download. Surfaces render this instead so "nothing to show" is a state with
 * words and a next step, not a blank rectangle.
 */
export interface EmptyStateProps {
  title: string;
  body?: string;
  /** Emoji-free glyph slot; the app's icon language is text + emoji tiles. */
  icon?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ title, body, icon = '◇', action, className = '' }: EmptyStateProps) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-2 rounded-doodle-md border border-dashed border-cream-border bg-cream-soft/60 p-6 text-center ${className}`}
    >
      <span aria-hidden className="text-[20px] text-ink-muted">
        {icon}
      </span>
      <p className="font-display text-[13px] font-semibold text-ink">{title}</p>
      {body && <p className="max-w-[34ch] text-[11px] leading-relaxed text-ink-muted">{body}</p>}
      {action}
    </div>
  );
}
