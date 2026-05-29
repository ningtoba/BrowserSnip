import type { ToolDefinition } from '@/types';

interface Props {
  tool: ToolDefinition;
  onClick: () => void;
}

const TOOL_META: Record<string, { color: string; bg: string }> = {
  trim: { color: '#1d1836', bg: '#ffef9f' },
  resize: { color: '#1d1836', bg: '#e8f4f8' },
  crop: { color: '#1d1836', bg: '#f0e6ff' },
  compress: { color: '#1d1836', bg: '#e6f7ee' },
  gif: { color: '#1d1836', bg: '#ffe6e6' },
  audio: { color: '#1d1836', bg: '#f5eccd' },
  speed: { color: '#1d1836', bg: '#e6f0ff' },
  metadata: { color: '#1d1836', bg: '#ffe6f0' },
};

export function ToolCard({ tool, onClick }: Props) {
  const meta = TOOL_META[tool.id] ?? { color: '#1d1836', bg: '#ffef9f' };

  return (
    <button
      onClick={onClick}
      className="tool-card group cursor-pointer text-left h-full flex flex-col"
    >
      <div
        className="mb-4 flex h-14 w-14 items-center justify-center rounded-doodle-lg text-2xl"
        style={{ backgroundColor: meta.bg, color: meta.color }}
      >
        {tool.icon}
      </div>
      <h3 className="mb-1.5 text-base font-extrabold text-ink group-hover:text-accent transition-colors">
        {tool.name}
      </h3>
      <p className="text-sm leading-relaxed text-ink-soft">{tool.description}</p>
      <div className="mt-auto pt-4">
        <span className="inline-flex items-center gap-1 text-xs font-bold text-accent opacity-0 group-hover:opacity-100 transition-opacity">
          Open tool <span className="text-base">→</span>
        </span>
      </div>
    </button>
  );
}
