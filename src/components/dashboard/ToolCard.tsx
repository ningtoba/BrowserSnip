import { motion } from 'framer-motion';
import type { ToolCategory, ToolDefinition } from '@/types';
import { cardHover, fadeUp, tapDown } from '@/lib/motion';

interface Props {
  tool: ToolDefinition;
  onClick: () => void;
  /** Bento hero tile — larger icon + title. Optional; defaults off. */
  featured?: boolean;
}

/**
 * v3 §1 category accent set. Raw hex values (arbitrary-value safe) until the
 * `acc` tailwind tokens land — inline styles keep dynamic colors JIT-safe.
 */
export const CATEGORY_ACCENTS: Record<ToolCategory, { hex: string; tint: string }> = {
  video:          { hex: '#2563EB', tint: 'rgba(37, 99, 235, 0.08)' },
  organize:       { hex: '#7C3AED', tint: 'rgba(124, 58, 237, 0.08)' },
  optimize:       { hex: '#059669', tint: 'rgba(5, 150, 105, 0.08)' },
  'convert-to':   { hex: '#7C3AED', tint: 'rgba(124, 58, 237, 0.08)' },
  'convert-from': { hex: '#7C3AED', tint: 'rgba(124, 58, 237, 0.08)' },
  edit:           { hex: '#2563EB', tint: 'rgba(37, 99, 235, 0.08)' },
  security:       { hex: '#059669', tint: 'rgba(5, 150, 105, 0.08)' },
};

export const DEFAULT_ACCENT = CATEGORY_ACCENTS.video;

/** Spec §1 maps 'scan' to amber; scan-to-pdf is the one tool that breaks category tint. */
export const AMBER_ACCENT = { hex: '#D97706', tint: 'rgba(217, 119, 6, 0.08)' };
/** Rose stays rare: creative + warning-adjacent tools only. */
const ROSE_ACCENT = { hex: '#E11D48', tint: 'rgba(225, 29, 72, 0.07)' };

const TOOL_ACCENT_OVERRIDE: Partial<Record<string, { hex: string; tint: string }>> = {
  'scan-to-pdf': AMBER_ACCENT,
  gif: ROSE_ACCENT,
  redact: ROSE_ACCENT,
  'redact-pdf': ROSE_ACCENT,
};

/**
 * One card, one job.
 *
 * The line under the title is the registry `description`, which every definition
 * has to carry and which states what the user ends up holding. It used to be a
 * hand-written tagline for 35 tools and the description for the other 89, so the
 * catalogue read as two different products depending on which shelf you were on.
 */
export function ToolCard({ tool, onClick, featured = false }: Props) {
  const categoryAccent = (tool.category && CATEGORY_ACCENTS[tool.category]) || DEFAULT_ACCENT;
  const accent = TOOL_ACCENT_OVERRIDE[tool.id] ?? categoryAccent;

  return (
    <motion.article
      variants={fadeUp}
      whileHover={cardHover}
      whileTap={tapDown}
      className="group h-full"
    >
      <button
        type="button"
        data-tool={tool.id}
        onClick={onClick}
        aria-label={tool.name}
        className="tool-card flex flex-col text-left w-full h-full"
      >
        <div
          className={`mb-4 flex items-center justify-center rounded-[10px] transition-transform duration-300 group-hover:scale-105 ${
            featured ? 'h-14 w-14 text-2xl' : 'h-11 w-11 text-xl'
          }`}
          style={{ background: accent.tint, color: accent.hex }}
          aria-hidden="true"
        >
          {tool.icon}
        </div>
        <h3
          className={`mb-1.5 font-display font-semibold text-ink ${
            featured ? 'text-lg' : 'text-sm'
          }`}
        >
          {tool.name}
        </h3>
        <p className="text-xs leading-relaxed text-ink-muted">{tool.description.trim()}</p>
        <div className="mt-auto flex items-center justify-between pt-4">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted transition-colors duration-200 group-hover:text-ink-soft">
            Open
          </span>
          <span
            aria-hidden="true"
            className="translate-y-1 text-sm leading-none opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:translate-y-0 group-hover:opacity-100"
            style={{ color: accent.hex }}
          >
            ↗
          </span>
        </div>
      </button>
    </motion.article>
  );
}

/**
 * Shelf identity row: accent bar, icon, the job in plain words, how many tools
 * are under it, and one line saying what the shelf is for.
 *
 * The blurb is the part that makes a grouped catalogue readable — a heading that
 * says "Shrink, repair & archive" still leaves the visitor guessing whether the
 * four cards under it are the ones they meant.
 */
export function CategoryHeading({
  icon,
  label,
  accent,
  count,
  blurb,
  headingId,
}: {
  icon: string;
  label: string;
  accent: { hex: string; tint: string };
  count: number;
  /** One line under the heading, in the visitor's words. */
  blurb?: string;
  /** Sets `id` on the heading so the section can be labelled by it. */
  headingId?: string;
}) {
  return (
    <div className="mb-5">
      <div className="flex items-center gap-3">
        <span className="h-8 w-1 shrink-0 rounded-full" style={{ background: accent.hex }} aria-hidden="true" />
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] text-base"
          style={{ background: accent.tint, color: accent.hex }}
          aria-hidden="true"
        >
          {icon}
        </span>
        <h2
          id={headingId}
          className="font-display text-[15px] font-semibold tracking-[-0.01em] text-ink sm:text-[16px]"
        >
          {label}
        </h2>
        <span className="font-mono text-[10px] tabular-nums text-ink-muted">{count}</span>
        <span
          className="h-px min-w-6 flex-1"
          style={{ background: `linear-gradient(90deg, ${accent.tint}, var(--hairline) 60%)` }}
          aria-hidden="true"
        />
      </div>
      {blurb && <p className="mt-2 pl-5 text-[12px] leading-relaxed text-ink-muted">{blurb}</p>}
    </div>
  );
}
