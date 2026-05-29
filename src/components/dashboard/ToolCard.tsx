import type { ToolDefinition } from '@/types';

interface Props {
  tool: ToolDefinition;
  onClick: () => void;
}

const TOOL_ACCENT: Record<string, string> = {
  trim: '#6366f1',
  resize: '#a78bfa',
  crop: '#34d399',
  compress: '#fbbf24',
  gif: '#f472b6',
  audio: '#38bdf8',
  speed: '#fb923c',
  metadata: '#f87171',
};

const TOOL_BG: Record<string, string> = {
  trim: 'rgba(99, 102, 241, 0.12)',
  resize: 'rgba(167, 139, 250, 0.12)',
  crop: 'rgba(52, 211, 153, 0.12)',
  compress: 'rgba(251, 191, 36, 0.12)',
  gif: 'rgba(244, 114, 182, 0.12)',
  audio: 'rgba(56, 189, 248, 0.12)',
  speed: 'rgba(251, 146, 60, 0.12)',
  metadata: 'rgba(248, 113, 113, 0.12)',
};

export function ToolCard({ tool, onClick }: Props) {
  const accent = TOOL_ACCENT[tool.id] ?? '#6366f1';
  const accentBg = TOOL_BG[tool.id] ?? 'rgba(99, 102, 241, 0.12)';

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
