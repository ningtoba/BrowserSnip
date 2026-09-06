import { useNavigate, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { TOOLS } from '@/lib/constants';
import { ToolCard, CATEGORY_ACCENTS } from './ToolCard';
import { fadeUp, staggerParent, viewportOnce } from '@/lib/motion';

/** First two tools render as wider hero tiles (bento size-as-hierarchy). */
const FEATURED: string[] = ['trim', 'compress'];

export function VideoDashboard() {
  const navigate = useNavigate();
  const videoTools = TOOLS.filter((t) => t.category === 'video');
  const accent = CATEGORY_ACCENTS.video;

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

          <motion.header variants={fadeUp} className="mb-12">
            <p
              className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em]"
              style={{ color: accent.hex }}
            >
              FFmpeg · in your browser
            </p>
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
              <h1 className="font-display text-4xl font-semibold tracking-[-0.03em] text-ink sm:text-5xl">
                Video Tools
              </h1>
              <span className="font-mono text-xs tabular-nums text-ink-muted">
                {String(videoTools.length).padStart(2, '0')} tools · 0 uploads
              </span>
            </div>
            <p className="mt-4 max-w-xl text-sm leading-relaxed text-ink-soft">
              Eight FFmpeg utilities compiled to WebAssembly. Drop a file, get the
              result — every frame is processed on your machine.
            </p>
            <div className="mt-6 h-px w-full bg-cream-border" />
          </motion.header>

          <motion.div
            initial="hidden"
            whileInView="visible"
            viewport={viewportOnce}
            variants={staggerParent}
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
          >
            {videoTools.map((tool) => {
              const featured = FEATURED.includes(tool.id);
              return (
                <div key={tool.id} className={featured ? 'sm:col-span-1 lg:col-span-2' : ''}>
                  <ToolCard
                    tool={tool}
                    featured={featured}
                    onClick={() => navigate(`/tool/${tool.id}`)}
                  />
                </div>
              );
            })}
          </motion.div>
        </motion.div>
      </div>
    </div>
  );
}
