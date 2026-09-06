import { useMemo, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { TOOLS, TOOL_CATEGORIES } from '@/lib/constants';
import { ToolCard, CategoryHeading, CATEGORY_ACCENTS } from './ToolCard';
import { fadeUp, staggerParent, viewportOnce } from '@/lib/motion';

const PDF_CATEGORIES = TOOL_CATEGORIES.filter((c) => c.id !== 'video');
const PDF_TOOLS = TOOLS.filter((t) => t.category && t.category !== 'video');

export function PdfDashboard() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');

  const q = query.trim().toLowerCase();

  const groups = useMemo(() => {
    return PDF_CATEGORIES.map((category) => {
      const tools = PDF_TOOLS.filter((t) => t.category === category.id).filter(
        (t) =>
          q === '' ||
          t.name.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q) ||
          category.label.toLowerCase().includes(q),
      );
      return { category, tools };
    }).filter((g) => g.tools.length > 0);
  }, [q]);

  const matchCount = groups.reduce((n, g) => n + g.tools.length, 0);

  return (
    <div className="bg-cream bg-grid">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8 py-10 sm:py-16">
        <motion.div initial="hidden" animate="visible" variants={staggerParent}>
          <motion.div variants={fadeUp}>
            <Link
              to="/"
              className="group mb-8 inline-flex items-center gap-1.5 text-xs font-medium text-ink-muted transition-colors hover:text-ink"
            >
              <span
                aria-hidden="true"
                className="text-sm leading-none transition-transform duration-200 group-hover:-translate-x-0.5"
              >
                &larr;
              </span>
              Home
            </Link>
          </motion.div>

          <motion.header variants={fadeUp} className="mb-10">
            <p
              className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em]"
              style={{ color: CATEGORY_ACCENTS.organize.hex }}
            >
              Client-side · no uploads
            </p>
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
              <h1 className="font-display text-4xl font-semibold tracking-[-0.03em] text-ink sm:text-5xl">
                PDF Tools
              </h1>
              <span className="font-mono text-xs tabular-nums text-ink-muted">
                {String(PDF_TOOLS.length).padStart(2, '0')} tools ·{' '}
                {String(PDF_CATEGORIES.length)} categories
              </span>
            </div>
            <p className="mt-4 max-w-xl text-sm leading-relaxed text-ink-soft">
              Merge, split, convert, sign and redact — every page parsed by
              pdf-lib and pdf.js inside this tab. Nothing is ever uploaded.
            </p>
            <div className="mt-6 h-px w-full bg-cream-border" />
          </motion.header>

          {/* Local quick-search — filters cards in this component only. */}
          <motion.div variants={fadeUp} className="mb-10">
            <label className="relative block max-w-sm">
              <span className="sr-only">Search PDF tools</span>
              <span
                aria-hidden="true"
                className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 font-mono text-xs text-ink-muted"
              >
                ⌕
              </span>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="filter tools…"
                autoComplete="off"
                className="w-full rounded-full border border-cream-border bg-cream-light py-2.5 pl-9 pr-12 font-mono text-xs text-ink shadow-doodle-card outline-none transition-all duration-200 placeholder:text-ink-muted focus:border-accent focus:shadow-doodle-focus"
              />
              {q !== '' && (
                <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 font-mono text-[10px] tabular-nums text-ink-muted">
                  {matchCount}
                </span>
              )}
            </label>
          </motion.div>

          {groups.length === 0 ? (
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="py-16 text-center font-mono text-xs text-ink-muted"
            >
              no tools match “{query.trim()}” — everything still runs offline, try “merge” or “sign”
            </motion.p>
          ) : (
            <motion.div initial="hidden" animate="visible" variants={staggerParent} className="space-y-12">
              {groups.map(({ category, tools }) => {
                const accent = CATEGORY_ACCENTS[category.id] ?? CATEGORY_ACCENTS.organize;
                return (
                  <section key={category.id}>
                    <CategoryHeading
                      icon={category.icon}
                      label={category.label}
                      accent={accent}
                      count={tools.length}
                    />
                    <motion.div
                      initial="hidden"
                      whileInView="visible"
                      viewport={viewportOnce}
                      variants={staggerParent}
                      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
                    >
                      {tools.map((tool) => (
                        <ToolCard
                          key={tool.id}
                          tool={tool}
                          onClick={() => navigate(`/tool/${tool.id}`)}
                        />
                      ))}
                    </motion.div>
                  </section>
                );
              })}
            </motion.div>
          )}
        </motion.div>
      </div>
    </div>
  );
}
