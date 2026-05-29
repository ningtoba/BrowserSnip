import { useNavigate } from 'react-router-dom';
import { TOOLS } from '@/lib/constants';
import { ToolCard } from './ToolCard';

export function Dashboard() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-cream bg-grid">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8 py-12 sm:py-20">
        <header className="mb-12 sm:mb-20 text-center">
          <div className="mb-6 inline-flex items-center justify-center gap-3">
            <div className="flex h-14 w-14 items-center justify-center rounded-doodle-lg bg-accent/10 ring-1 ring-accent/20">
              <span className="text-2xl">✂</span>
            </div>
          </div>
          <h1 className="font-display text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight text-ink">
            Browser<span className="text-accent">Snip</span>
          </h1>
          <p className="mx-auto mt-4 max-w-lg text-sm sm:text-base text-ink-soft leading-relaxed">
            100% client-side video utility sandbox. No uploads, no servers, total privacy.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-doodle-lg border border-cream-border bg-cream-light px-3.5 py-2 text-xs font-medium text-ink-soft">
              <span className="h-2 w-2 rounded-full bg-success shadow-[0_0_6px_rgba(52,211,153,0.4)]" />
              WebAssembly
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-doodle-lg border border-cream-border bg-cream-light px-3.5 py-2 text-xs font-medium text-ink-soft">
              <span className="text-accent text-sm">🔒</span>
              Private
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-doodle-lg border border-cream-border bg-cream-light px-3.5 py-2 text-xs font-medium text-ink-soft">
              <span className="text-accent text-sm">⚡</span>
              Instant
            </span>
          </div>
        </header>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {TOOLS.map((tool, i) => (
            <div
              key={tool.id}
              className="animate-slide-up"
              style={{ animationDelay: `${i * 60}ms`, animationFillMode: 'both' }}
            >
              <ToolCard
                tool={tool}
                onClick={() => navigate(`/tool/${tool.id}`)}
              />
            </div>
          ))}
        </div>

        <footer className="mt-16 sm:mt-24 text-center">
          <div className="inline-flex items-center gap-3 rounded-doodle-lg border border-cream-border bg-cream-light px-5 py-3.5 shadow-doodle-card">
            <div className="flex h-8 w-8 items-center justify-center rounded-doodle bg-success/10">
              <span className="text-sm text-success">🛡</span>
            </div>
            <div className="text-left">
              <p className="text-xs font-semibold text-ink">All processing runs locally</p>
              <p className="text-[11px] text-ink-muted">No video data ever leaves your device</p>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
