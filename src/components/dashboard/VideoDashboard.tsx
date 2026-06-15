import { useNavigate, Link } from 'react-router-dom';
import { TOOLS } from '@/lib/constants';
import { ToolCard } from './ToolCard';
import type { ToolId } from '@/types';

export function VideoDashboard() {
  const navigate = useNavigate();
  const videoTools = TOOLS.filter((t) => t.category === 'video');

  return (
    <div className="bg-cream bg-grid">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
        <Link
          to="/"
          className="inline-flex items-center gap-1 text-xs font-medium text-ink-muted hover:text-ink-soft transition-colors mb-6"
        >
          <span className="text-sm leading-none">&larr;</span>
          Home
        </Link>

        <div className="mb-8 animate-fade-in">
          <div className="flex items-center gap-3 mb-2">
            <span className="text-2xl">🎬</span>
            <h1 className="text-2xl sm:text-3xl font-bold text-ink font-display tracking-tight">
              Video Tools
            </h1>
          </div>
          <p className="text-sm text-ink-muted">
            8 client-side FFmpeg tools. No uploads, no servers.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {videoTools.map((tool, i) => (
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
      </div>
    </div>
  );
}
