import { useNavigate } from 'react-router-dom';
import { TOOLS } from '@/lib/constants';
import { ToolCard } from './ToolCard';

export function Dashboard() {
  const navigate = useNavigate();

  return (
    <div className="mx-auto max-w-6xl px-6 py-16">
      <header className="mb-16 text-center">
        <div className="mb-6 inline-flex items-center gap-3">
          <span className="text-5xl">✂</span>
          <h1 className="font-display text-5xl font-extrabold tracking-tight text-ink">
            Browser<span className="text-accent">Snip</span>
          </h1>
        </div>
        <p className="mx-auto max-w-lg text-lg text-ink-soft leading-relaxed">
          100% client-side video utility sandbox. No uploads, no servers, total privacy.
        </p>
        <div className="mt-6 flex items-center justify-center gap-3">
          <span className="inline-flex items-center gap-1.5 rounded-doodle-lg border-2 border-cream-border bg-cream-light px-4 py-2 text-sm font-bold text-ink-soft">
            <span className="h-2 w-2 rounded-full bg-success animate-pulse" />
            WebAssembly
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-doodle-lg border-2 border-cream-border bg-white px-4 py-2 text-sm font-bold text-ink-soft">
            <span className="text-accent">🔒</span>
            Private
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-doodle-lg border-2 border-cream-border bg-white px-4 py-2 text-sm font-bold text-ink-soft">
            <span className="text-accent">⚡</span>
            Instant
          </span>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {TOOLS.map((tool) => (
          <ToolCard
            key={tool.id}
            tool={tool}
            onClick={() => navigate(`/tool/${tool.id}`)}
          />
        ))}
      </div>

      <footer className="mt-20 text-center">
        <div className="inline-flex items-center gap-2 rounded-doodle border-2 border-cream-border bg-white px-6 py-4 shadow-doodle">
          <span className="text-2xl">🛡</span>
          <div className="text-left">
            <p className="text-sm font-bold text-ink">All processing runs locally</p>
            <p className="text-xs text-ink-muted">No video data ever leaves your device</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
