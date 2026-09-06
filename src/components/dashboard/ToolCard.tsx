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
};

/** Outcome-first one-liners (v3 §4, ≤12 words); falls back to constants copy. */
const TAGLINE: Partial<Record<string, string>> = {
  trim: 'Cut any clip in seconds — no re-encode, zero quality loss.',
  resize: 'Scale to 1080p, 720p or custom sizes with the ratio locked.',
  crop: 'Reframe for 9:16, 1:1 or 21:9 in one pass.',
  compress: 'Hit Discord, Slack or email size limits exactly.',
  gif: 'Turn short clips into crisp, palette-optimized GIFs.',
  audio: 'Mute it, pull the MP3, or push volume to 300%.',
  speed: 'Timelapse or slow-mo, from 0.25× to 4×.',
  metadata: 'Strip GPS, EXIF and device tags before you share.',
  merge: 'Fuse several PDFs into one, in your order.',
  split: 'Break a PDF into ranges, odd/even, or single pages.',
  'remove-pages': 'Drop unwanted pages with a visual picker.',
  'extract-pages': 'Save selected pages as a brand-new PDF.',
  organize: 'Reorder, duplicate, insert or delete pages by drag.',
  rotate: 'Fix page orientation — 90°, 180° or 270°.',
  'scan-to-pdf': 'Camera to clean scan: edge detection, auto-correct.',
  'pdf-compress': 'Shrink heavy PDFs without wrecking the quality.',
  repair: 'Recover data from damaged or corrupted PDFs.',
  'image-to-pdf': 'JPG, PNG, WEBP or TIFF — batched into one PDF.',
  'digitize-document': 'OCR a photo into a clean, searchable PDF.',
  'html-to-pdf': 'Turn HTML into a properly paginated PDF.',
  'pdf-to-image': 'Export pages as sharp JPG, PNG or WEBP.',
  'pdf-to-word': 'Pull editable text and structure out of any PDF.',
  'pdf-to-excel': 'Get PDF tables out and into a spreadsheet.',
  'pdf-to-pdfa': 'Archive documents to the long-term PDF/A standard.',
  'page-numbers': 'Stamp page numbers with font, size and position control.',
  watermark: 'Stamp text or image marks with rotation and opacity.',
  'pdf-crop': 'Trim margins visually or by exact measurements.',
  protect: 'Encrypt with a password and lock down permissions.',
  unlock: 'Remove a password you already own, instantly.',
  sign: 'Sign with a drawing, an image or a typed name.',
  redact: 'Permanently burn sensitive data — not just mask it.',
  compare: 'Spot every difference between two PDFs, side by side.',
};

export function ToolCard({ tool, onClick, featured = false }: Props) {
  const categoryAccent = (tool.category && CATEGORY_ACCENTS[tool.category]) || DEFAULT_ACCENT;
  const accent = TOOL_ACCENT_OVERRIDE[tool.id] ?? categoryAccent;
  const tagline = TAGLINE[tool.id] ?? tool.description;

  return (
    <motion.article
      variants={fadeUp}
      whileHover={cardHover}
      whileTap={tapDown}
      className="group h-full"
    >
      <button type="button" onClick={onClick} className="tool-card flex flex-col text-left w-full h-full">
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
        <p className="text-xs leading-relaxed text-ink-muted">{tagline}</p>
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

/** Category identity row (v3 §2B): accent bar + icon tile + eyebrow + count + rule. */
export function CategoryHeading({
  icon,
  label,
  accent,
  count,
}: {
  icon: string;
  label: string;
  accent: { hex: string; tint: string };
  count: number;
}) {
  return (
    <div className="mb-5 flex items-center gap-3">
      <span className="h-8 w-1 shrink-0 rounded-full" style={{ background: accent.hex }} aria-hidden="true" />
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] text-base"
        style={{ background: accent.tint, color: accent.hex }}
        aria-hidden="true"
      >
        {icon}
      </span>
      <h2
        className="whitespace-nowrap text-[11px] font-semibold uppercase tracking-[0.12em]"
        style={{ color: accent.hex }}
      >
        {label}
      </h2>
      <span className="font-mono text-[10px] tabular-nums text-ink-muted">{count}</span>
      <span
        className="h-px min-w-6 flex-1"
        style={{ background: `linear-gradient(90deg, ${accent.tint}, #E3E3DD 60%)` }}
        aria-hidden="true"
      />
    </div>
  );
}
