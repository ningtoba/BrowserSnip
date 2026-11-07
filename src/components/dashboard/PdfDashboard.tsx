/**
 * The PDF dashboard: the page a visitor lands on when they want a job done.
 *
 * It used to read like a dense app screen — an eyebrow, a count, six shelves
 * named after the source folders (`Convert to PDF`, `Optimize PDF`), a small
 * monospace filter box — which is the catalogue's internal shape rather than
 * anything the visitor is thinking. The comparison that matters is a site where
 * the first screen asks one question and answers one doubt: what do I want to do,
 * and can I trust this with the file.
 *
 * So this page now owns three things:
 *   - a search field big enough to be the first thing you reach for, matched by
 *     job words and plain-English phrases (`toolJobs.ts`), not just by names;
 *   - the catalogue grouped by the job it does, with a one-line outcome per tool
 *     taken from the registry definition, so the copy cannot drift from the page
 *     the card opens;
 *   - the "nothing is uploaded" assurance sitting next to the search, which is
 *     exactly where the decision to trust the site is made.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { PDF_TOOL_COUNT } from '@/lib/constants';
import { ToolCard, CategoryHeading } from './ToolCard';
import { TOOL_JOBS, popularEntries, searchJobs, type DashboardEntry, type ToolJob } from './toolJobs';
import { fadeUp, staggerParent, viewportOnce } from '@/lib/motion';

/** The shelf heading colour: one accent for the page, not one per category. */
const HEADING = { hex: 'var(--accent)', tint: 'var(--accent-tint)' };

/** Said once, near the search, where the trust decision actually happens. */
const ASSURANCE = [
  'No upload — the file is read in this tab',
  'No account, nothing stored',
  'Works with the tab closed after load',
];

export function PdfDashboard() {
  const navigate = useNavigate();
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const q = query.trim();

  const entries = useMemo(() => searchJobs(q), [q]);
  const popular = useMemo(() => popularEntries(), []);

  const grouped = useMemo(() => {
    const byJob = new Map<string, DashboardEntry[]>();
    for (const entry of entries) byJob.set(entry.job.id, [...(byJob.get(entry.job.id) ?? []), entry]);
    return TOOL_JOBS.map((job) => ({ job, tools: byJob.get(job.id) ?? [] })).filter((group) => group.tools.length > 0);
  }, [entries]);

  // `/` is the "find the tool" key on every site in this category; the palette
  // keeps ⌘K, which also covers the shell.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && /^(input|textarea|select)$/i.test(target.tagName);
      if (event.key === '/' && !typing) {
        event.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="bg-cream bg-grid">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
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

          <motion.header variants={fadeUp} className="mb-8">
            <h1 className="font-display text-4xl font-semibold tracking-[-0.03em] text-ink sm:text-5xl">
              What do you want to do with this PDF?
            </h1>
            <p className="mt-4 max-w-2xl text-base leading-relaxed text-ink-soft">
              {PDF_TOOL_COUNT} tools that run on your own computer. Pick a file, get the
              result back — the document is never sent anywhere.
            </p>

            <ul className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2">
              {ASSURANCE.map((line) => (
                <li key={line} className="inline-flex items-center gap-2 text-[13px] font-medium text-ink-soft">
                  <span aria-hidden="true" className="flex h-4 w-4 items-center justify-center rounded-full bg-success/15 text-[10px] text-success">
                    ✓
                  </span>
                  {line}
                </li>
              ))}
            </ul>
          </motion.header>

          {/* Search is the primary affordance, so it is sized like one. */}
          <motion.div variants={fadeUp} className="mb-4">
            <div className="relative flex w-full max-w-2xl items-center">
              <label htmlFor="tool-search" className="sr-only">
                Search the PDF tools
              </label>
              <span
                aria-hidden="true"
                className="pointer-events-none absolute left-5 text-lg text-ink-muted"
              >
                ⌕
              </span>
              <input
                id="tool-search"
                ref={search}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search: merge, split, make smaller, sign, convert to Word…"
                autoComplete="off"
                className="w-full rounded-doodle-lg border border-cream-border bg-cream-light py-4 pl-12 pr-32 text-base text-ink shadow-doodle-card outline-none transition-all duration-200 placeholder:text-ink-muted focus:border-accent focus:shadow-doodle-focus"
              />
              <span className="pointer-events-none absolute right-4 flex items-center gap-2">
                {q !== '' ? (
                  <>
                    <span className="font-mono text-[11px] tabular-nums text-ink-muted">
                      {entries.length} match{entries.length === 1 ? '' : 'es'}
                    </span>
                    <button
                      type="button"
                      onClick={() => setQuery('')}
                      className="pointer-events-auto rounded-doodle border border-cream-border px-2 py-1 text-[11px] font-semibold text-ink-muted transition-colors hover:text-ink"
                    >
                      Clear
                    </button>
                  </>
                ) : (
                  <kbd className="hidden rounded border border-cream-border px-1.5 py-0.5 font-mono text-[10px] text-ink-muted sm:inline">
                    /
                  </kbd>
                )}
              </span>
            </div>
          </motion.div>

          {/* The jobs people actually arrive with, one click from the search box. */}
          {!q && (
            <motion.nav
              variants={fadeUp}
              aria-label="Popular tools"
              className="mb-12 flex flex-wrap items-center gap-2"
            >
              {popular.map((entry) => (
                <button
                  key={entry.tool.id}
                  type="button"
                  onClick={() => navigate(`/tool/${entry.tool.id}`)}
                  className="rounded-full border border-cream-border bg-cream-light px-3.5 py-1.5 text-[12px] font-medium text-ink-soft shadow-doodle-card transition-colors hover:border-accent hover:text-accent"
                >
                  {entry.tool.name}
                </button>
              ))}
            </motion.nav>
          )}

          {q !== '' && entries.length === 0 ? (
            <motion.div variants={fadeUp} className="rounded-doodle-lg border border-cream-border bg-cream-light p-10 text-center shadow-doodle-card">
              <p className="text-sm font-semibold text-ink">Nothing matches “{q}”.</p>
              <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">
                Try what you want to end up with — “smaller”, “Word”, “password”, “black out” — or
                press <kbd className="rounded border border-cream-border px-1 font-mono text-[11px]">⌘K</kbd> to
                search every tool.
              </p>
              <button
                type="button"
                onClick={() => {
                  setQuery('');
                  search.current?.focus();
                }}
                className="mt-4 rounded-doodle border border-cream-border bg-cream-soft px-4 py-2 text-[12px] font-semibold text-ink-soft transition-colors hover:text-ink"
              >
                Clear search
              </button>
            </motion.div>
          ) : q !== '' ? (
            <motion.div
              key={q}
              initial="hidden"
              animate="visible"
              variants={staggerParent}
              className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
            >
              {entries.map(({ tool }) => (
                <ToolCard key={tool.id} tool={tool} onClick={() => navigate(`/tool/${tool.id}`)} />
              ))}
            </motion.div>
          ) : (
            <div className="space-y-12">
              {grouped.map(({ job, tools }) => (
                <JobShelf key={job.id} job={job} tools={tools} onOpen={(id) => navigate(`/tool/${id}`)} />
              ))}
            </div>
          )}
        </motion.div>
      </div>
    </div>
  );
}

/** A shelf of the catalogue: the job, what it is for, and the tools that do it. */
function JobShelf({ job, tools, onOpen }: { job: ToolJob; tools: DashboardEntry[]; onOpen: (id: string) => void }) {
  return (
    <motion.section
      initial="hidden"
      whileInView="visible"
      viewport={viewportOnce}
      variants={staggerParent}
      aria-labelledby={`job-${job.id}`}
    >
      <CategoryHeading
        icon={job.icon}
        label={job.label}
        headingId={`job-${job.id}`}
        accent={HEADING}
        count={tools.length}
        blurb={job.blurb}
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {tools.map((entry) => (
          <ToolCard key={entry.tool.id} tool={entry.tool} onClick={() => onOpen(entry.tool.id)} />
        ))}
      </div>
    </motion.section>
  );
}
