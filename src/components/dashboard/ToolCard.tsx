import type { ToolDefinition } from '@/types';

interface Props {
  tool: ToolDefinition;
  onClick: () => void;
}

const TOOL_ACCENT: Record<string, string> = {
  trim: '#2563EB',
  resize: '#7C3AED',
  crop: '#059669',
  compress: '#D97706',
  gif: '#DB2777',
  audio: '#0891B2',
  speed: '#EA580C',
  metadata: '#DC2626',
};

const TOOL_BG: Record<string, string> = {
  trim: 'rgba(37, 99, 235, 0.08)',
  resize: 'rgba(124, 58, 237, 0.08)',
  crop: 'rgba(5, 150, 105, 0.08)',
  compress: 'rgba(217, 119, 6, 0.08)',
  gif: 'rgba(219, 39, 119, 0.08)',
  audio: 'rgba(8, 145, 178, 0.08)',
  speed: 'rgba(234, 88, 12, 0.08)',
  metadata: 'rgba(220, 38, 38, 0.08)',
};

export function ToolCard({ tool, onClick }: Props) {
  const accent = TOOL_ACCENT[tool.id] ?? '#2563EB';
  const accentBg = TOOL_BG[tool.id] ?? 'rgba(37, 99, 235, 0.08)';

  return (
    <button onClick={onClick} className="tool-card group text-left w-full">
      <div
        className="mb-4 flex h-11 w-11 items-center justify-center rounded-doodle-md text-xl transition-transform duration-300 group-hover:scale-110"
        style={{ background: accentBg, color: accent }}
      >
        {tool.icon}
      </div>
      <h3 className="mb-1.5 text-sm font-semibold text-ink transition-colors duration-200 group-hover:text-accent">
        {tool.name}
      </h3>
      <p className="text-xs leading-relaxed text-ink-muted">{tool.description}</p>
      <div className="mt-auto pt-4">
        <span
          className="inline-flex items-center gap-1.5 text-[11px] font-medium opacity-0 group-hover:opacity-100 transition-all duration-200"
          style={{ color: accent }}
        >
          Open tool
          <span className="text-sm leading-none transition-transform duration-200 group-hover:translate-x-0.5">→</span>
        </span>
      </div>
    </button>
  );
}
