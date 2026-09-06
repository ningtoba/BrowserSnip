import { useNavigate, Link } from 'react-router-dom';
import { TOOLS, TOOL_CATEGORIES } from '@/lib/constants';
import { ToolCard } from './ToolCard';
import type { ToolId } from '@/types';

export function PdfDashboard() {
  const navigate = useNavigate();
  const pdfCategories = TOOL_CATEGORIES.filter((c) => c.id !== 'video');

  return (
    <div className="bg-cream bg-grid">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8 py-10 sm:py-16">
        <Link
          to="/"
          className="inline-flex items-center gap-1 text-xs font-medium text-ink-muted hover:text-ink-soft transition-colors mb-8"
        >
          <span className="text-sm leading-none">&larr;</span>
          Home
        </Link>

        <div className="mb-12 animate-fade-in">
          <p className="eyebrow mb-2">Client-side · No uploads</p>
          <div className="flex items-center gap-3 mb-3">
            <span className="text-2xl">📄</span>
            <h1 className="text-2xl sm:text-3xl font-bold text-ink font-display tracking-tight">
              PDF Tools
            </h1>
          </div>
          <p className="text-sm text-ink-soft">
            26 client-side PDF tools across 6 categories. No uploads, no servers.
          </p>
          <div className="mt-6 border-b border-cream-border" />
        </div>

        <div className="space-y-12">
          {pdfCategories.map((category) => {
            const categoryTools = TOOLS.filter((t) => t.category === category.id);
            if (categoryTools.length === 0) return null;

            return (
              <section key={category.id} className="animate-slide-up">
                <div className="mb-5 flex items-baseline gap-2.5">
                  <span className="text-base leading-none self-center">{category.icon}</span>
                  <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-muted">
                    {category.label}
                  </h2>
                </div>
                <div className="border-t border-cream-border pt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {categoryTools.map((tool) => (
                    <ToolCard
                      key={tool.id}
                      tool={tool}
                      onClick={() => navigate(`/tool/${tool.id}`)}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
