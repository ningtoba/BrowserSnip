import type { ToolDefinition } from '@/types';

interface Props {
  tool: ToolDefinition;
  onClick: () => void;
}

export function ToolCard({ tool, onClick }: Props) {
  return (
    <button
      onClick={onClick}
      className="tool-card group cursor-pointer text-left"
    >
      <div className="mb-3 text-2xl">{tool.icon}</div>
      <h3 className="mb-1 text-sm font-semibold text-zinc-200 group-hover:text-indigo-300 transition-colors">
        {tool.name}
      </h3>
      <p className="text-xs leading-relaxed text-zinc-500">{tool.description}</p>
    </button>
  );
}
