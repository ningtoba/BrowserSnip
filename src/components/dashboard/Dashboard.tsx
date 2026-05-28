import { useNavigate } from 'react-router-dom';
import { TOOLS } from '@/lib/constants';
import { ToolCard } from './ToolCard';

export function Dashboard() {
  const navigate = useNavigate();

  return (
    <div className="mx-auto max-w-6xl px-6 py-12">
      <header className="mb-12 text-center">
        <h1 className="mb-3 font-mono text-4xl font-bold tracking-tight">
          <span className="text-indigo-400">Browser</span>
          <span className="text-zinc-100">Snip</span>
        </h1>
        <p className="text-zinc-500">
          100% client-side video utility sandbox. No uploads, no servers, total privacy.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {TOOLS.map((tool) => (
          <ToolCard
            key={tool.id}
            tool={tool}
            onClick={() => navigate(`/tool/${tool.id}`)}
          />
        ))}
      </div>

      <footer className="mt-16 text-center text-xs text-zinc-600">
        <p>All processing runs locally in your browser via WebAssembly.</p>
        <p className="mt-1">
          No video data ever leaves your device.
        </p>
      </footer>
    </div>
  );
}
