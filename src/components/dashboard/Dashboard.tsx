import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { TOOLS } from '@/lib/constants';
import { ToolCard, CATEGORY_ACCENTS } from './ToolCard';
import { cardHover, fadeUp, staggerParent, viewportOnce } from '@/lib/motion';

const videoCount = TOOLS.filter((t) => t.category === 'video').length;
const pdfCount = TOOLS.filter((t) => t.category && t.category !== 'video').length;

/** Bento tile shared by internal (Link) and external (a) family cards. */
function FamilyTile({
  accentHex,
  accentTint,
  eyebrow,
  title,
  copy,
  icon,
  big = false,
  href,
  to,
}: {
  accentHex: string;
  accentTint: string;
  eyebrow: string;
  title: string;
  copy: string;
  icon: string;
  big?: boolean;
  href?: string;
  to?: string;
}) {
  const inner = (
    <>
      <div
        className={`flex items-center justify-center rounded-[14px] transition-transform duration-300 group-hover:scale-105 ${
          big ? 'h-14 w-14 text-2xl' : 'h-11 w-11 text-xl'
        }`}
        style={{ background: accentTint, color: accentHex }}
        aria-hidden="true"
      >
        {icon}
      </div>
      <p
        className="mt-5 text-[11px] font-semibold uppercase tracking-[0.12em]"
        style={{ color: accentHex }}
      >
        {eyebrow}
      </p>
      <h2
        className={`mt-1.5 font-display font-semibold tracking-[-0.02em] text-ink ${
          big ? 'text-2xl' : 'text-lg'
        }`}
      >
        {title}
      </h2>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-ink-muted">{copy}</p>
      <span
        aria-hidden="true"
        className="mt-auto inline-block pt-5 text-sm leading-none transition-transform duration-200 group-hover:translate-x-1"
        style={{ color: accentHex }}
      >
        →
      </span>
    </>
  );

  const shell =
    'group flex h-full flex-col rounded-doodle-lg border border-cream-border bg-cream-light p-6 shadow-doodle-card transition-shadow duration-300 hover:shadow-doodle-hover sm:p-8';

  return (
    <motion.div variants={fadeUp} whileHover={cardHover} className={big ? 'sm:col-span-2' : ''}>
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className={shell}>
          {inner}
        </a>
      ) : (
        <Link to={to ?? '/'} className={shell}>
          {inner}
        </Link>
      )}
    </motion.div>
  );
}

export function Dashboard() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-cream bg-grid">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8 py-16 sm:py-20">
        <motion.div initial="hidden" animate="visible" variants={staggerParent}>
          <motion.header variants={fadeUp} className="mb-12 sm:mb-16">
            <p
              className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em]"
              style={{ color: CATEGORY_ACCENTS.video.hex }}
            >
              34 tools · 100% in-browser
            </p>
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
              <h1 className="font-display text-4xl font-semibold tracking-[-0.03em] text-ink sm:text-5xl lg:text-6xl">
                Browser<span className="text-accent">Snip</span>
              </h1>
              <span className="font-mono text-xs tabular-nums text-ink-muted">
                {String(TOOLS.length).padStart(2, '0')} tools · 0 uploads
              </span>
            </div>
            <p className="mt-5 max-w-xl text-sm leading-relaxed text-ink-soft sm:text-base">
              Video, PDF and AI tools that run entirely on your machine. No
              uploads, no servers, no accounts.
            </p>
          </motion.header>

          {/* Bento: family links — two big product families, two external AI tiles. */}
          <motion.div
            initial="hidden"
            whileInView="visible"
            viewport={viewportOnce}
            variants={staggerParent}
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
          >
            <FamilyTile
              big
              to="/video"
              icon="🎬"
              eyebrow="FFmpeg · WebAssembly"
              title={`Video — ${videoCount} tools`}
              copy="Trim, compress, crop, GIF, audio, speed and metadata cleanup, all client-side."
              accentHex={CATEGORY_ACCENTS.video.hex}
              accentTint={CATEGORY_ACCENTS.video.tint}
            />
            <FamilyTile
              big
              to="/pdf"
              icon="📄"
              eyebrow="pdf-lib · pdf.js"
              title={`PDF — ${pdfCount} tools`}
              copy="Organize, optimize, convert, edit and secure documents without a server in sight."
              accentHex={CATEGORY_ACCENTS.organize.hex}
              accentTint={CATEGORY_ACCENTS.organize.tint}
            />
            <FamilyTile
              href="https://blur.browsersnip.com"
              icon="◎"
              eyebrow="AI · subdomain"
              title="Blur"
              copy="One-click face detection and privacy blur on any image."
              accentHex={CATEGORY_ACCENTS.security.hex}
              accentTint={CATEGORY_ACCENTS.security.tint}
            />
            <FamilyTile
              href="https://upscale.browsersnip.com"
              icon="⤢"
              eyebrow="AI · subdomain"
              title="Upscale"
              copy="Real-ESRGAN super-resolution enlarges low-res images up to 4×."
              accentHex={CATEGORY_ACCENTS.edit.hex}
              accentTint={CATEGORY_ACCENTS.edit.tint}
            />
          </motion.div>

          {/* Quick access: every tool, staggered in. */}
          <motion.div variants={fadeUp} className="mt-16 flex items-center gap-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
              All tools
            </p>
            <span className="h-px flex-1 bg-cream-border" aria-hidden="true" />
          </motion.div>

          <motion.div
            initial="hidden"
            whileInView="visible"
            viewport={viewportOnce}
            variants={staggerParent}
            className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
          >
            {TOOLS.map((tool) => (
              <ToolCard
                key={tool.id}
                tool={tool}
                onClick={() => navigate(`/tool/${tool.id}`)}
              />
            ))}
          </motion.div>

          <motion.footer variants={fadeUp} className="mt-20 flex flex-wrap items-center justify-between gap-4">
            <p className="font-mono text-[11px] text-ink-muted">
              All processing runs locally — no data ever leaves your device.
            </p>
            <a
              href="https://github.com/ningtoba/BrowserSnip"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="View source on GitHub"
              className="inline-flex h-11 w-11 items-center justify-center rounded-doodle-md border border-cream-border bg-cream-light shadow-doodle-card transition-colors duration-200 hover:bg-cream-soft"
            >
              <svg className="h-5 w-5 text-ink-soft" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.341-3.369-1.341-.454-1.155-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.268 2.75 1.026A9.578 9.578 0 0 1 12 6.836a9.59 9.59 0 0 1 2.504.337c1.909-1.294 2.747-1.026 2.747-1.026.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.161 22 16.416 22 12c0-5.523-4.477-10-10-10z" />
              </svg>
            </a>
          </motion.footer>
        </motion.div>
      </div>
    </div>
  );
}
