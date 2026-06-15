import { useNavigate, Link } from 'react-router-dom';
import { TOOLS, TOOL_CATEGORIES } from '@/lib/constants';
import { ToolCard } from './ToolCard';
import type { ToolId } from '@/types';

export function PdfDashboard() {
  const navigate = useNavigate();
  const pdfCategories = TOOL_CATEGORIES.filter((c) => c.id !== 'video');

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
            <span className="text-2xl">📄</span>
            <h1 className="text-2xl sm:text-3xl font-bold text-ink font-display tracking-tight">
              PDF Tools
            </h1>
          </div>
          <p className="text-sm text-ink-muted">
            26 client-side PDF tools across 6 categories. No uploads, no servers.
          </p>
        </div>

        <div className="space-y-10">
          {pdfCategories.map((category) => {
            const categoryTools = TOOLS.filter((t) => t.category === category.id);
            if (categoryTools.length === 0) return null;

            return (
              <section key={category.id} className="animate-slide-up">
                <div className="mb-4 flex items-center gap-2">
                  <span className="text-lg">{category.icon}</span>
                  <h2 className="text-sm font-semibold text-ink-soft uppercase tracking-wider">
                    {category.label}
                  </h2>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
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
