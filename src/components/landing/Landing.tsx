import { TOOLS } from '@/lib/constants';
import { PDF_TOOLS, PDF_CATEGORIES } from '@/lib/pdf/tools/registry';
import { TOOL_JOBS } from '@/components/dashboard/toolJobs';

const TOOL_COUNT = TOOLS.length;
const PDF_TOOL_COUNT = PDF_TOOLS.length;
const PDF_CATEGORY_COUNT = PDF_CATEGORIES.length;
const VIDEO_TOOL_COUNT = TOOLS.filter((t) => t.category === 'video').length;

import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  fadeUp,
  staggerParent,
  scaleIn,
  cardHover,
  tapDown,
  viewportOnce,
} from '@/lib/motion';

const GITHUB_URL = 'https://github.com/ningtoba/BrowserSnip';

/* ── Small building blocks ─────────────────────────────────────────── */

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.341-3.369-1.341-.454-1.155-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.268 2.75 1.026A9.578 9.578 0 0 1 12 6.836a9.59 9.59 0 0 1 2.504.337c1.909-1.294 2.747-1.026 2.747-1.026.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.161 22 16.416 22 12c0-5.523-4.477-10-10-10z" />
    </svg>
  );
}

/** Sliding arrow, revealed by CSS group-hover (works inside motion tiles). */
function TileArrow({ colorClass }: { colorClass: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-sm font-semibold ${colorClass}`}
    >
      Open
      <span
        aria-hidden="true"
        className="transition-transform duration-200 ease-spring group-hover:translate-x-1"
      >
        →
      </span>
    </span>
  );
}

const linkExternal = { target: '_blank', rel: 'noopener noreferrer' } as const;

/* ── Bento tile data ───────────────────────────────────────────────── */

const smallTiles = [
  {
    href: 'https://blur.browsersnip.com',
    icon: '◎',
    eyebrow: 'AI · Privacy',
    title: 'Blur',
    copy: 'Detect faces and scrub them in one click. On-device models.',
    fg: 'text-acc-violet',
    tileBg: 'bg-acc-violet-tint',
    ring: 'group-hover:border-acc-violet/30',
  },
  {
    href: 'https://chat.browsersnip.com',
    icon: '✦',
    eyebrow: 'AI · Local',
    title: 'Chat',
    copy: 'Talk to your documents with a model running in this tab.',
    fg: 'text-acc-amber',
    tileBg: 'bg-acc-amber-tint',
    ring: 'group-hover:border-acc-amber/30',
  },
  {
    href: 'https://upscale.browsersnip.com',
    icon: '⤢',
    eyebrow: 'AI · Vision',
    title: 'Upscale',
    copy: 'Real-ESRGAN super-resolution, up to 4× larger and sharper.',
    fg: 'text-acc-emerald',
    tileBg: 'bg-acc-emerald-tint',
    ring: 'group-hover:border-acc-emerald/30',
  },
];

const steps = [
  {
    n: '01',
    title: 'Drop your file',
    copy: 'Video, PDF, or image. Picked from disk, never transmitted.',
    accent: 'text-acc-blue',
  },
  {
    n: '02',
    title: 'Your browser does the work',
    copy: 'FFmpeg via WebAssembly, PDF tools, and AI models run on your CPU/GPU.',
    accent: 'text-acc-violet',
  },
  {
    n: '03',
    title: 'Download the result',
    copy: 'Save it and close the tab. Nothing is stored, logged, or remembered.',
    accent: 'text-acc-emerald',
  },
];

/* ── Page ──────────────────────────────────────────────────────────── */

export function Landing() {
  return (
    <div className="relative bg-cream bg-grid">
      {/* Soft drifting blue→violet wash behind the hero (decorative). */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-[720px] overflow-hidden">
        <div className="hero-wash absolute left-1/2 top-[-180px] h-[640px] w-[min(1100px,140vw)] -translate-x-1/2" />
      </div>

      <div className="relative mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        {/* ── Hero ── */}
        <motion.section
          variants={staggerParent}
          initial="hidden"
          animate="visible"
          className="pb-20 pt-20 text-center sm:pb-28 sm:pt-28"
        >
          <motion.div variants={scaleIn} className="mb-8 inline-flex items-center gap-2.5">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl border border-cream-border bg-cream-light shadow-doodle-card">
              <img src="/logo.png" alt="BrowserSnip" className="h-6 w-6" />
            </span>
            <span className="font-display text-lg font-semibold tracking-tight text-ink">
              Browser<span className="text-accent">Snip</span>
            </span>
          </motion.div>

          <motion.p variants={fadeUp} className="eyebrow mb-4 text-accent">
            Private browser studio · {TOOL_COUNT} tools
          </motion.p>

          <motion.h1
            variants={fadeUp}
            className="mx-auto max-w-3xl font-display font-semibold leading-[1.05] tracking-[-0.03em] text-ink"
            style={{ fontSize: 'clamp(2.5rem, 6vw, 4.5rem)' }}
          >
            Your files never leave this tab.
          </motion.h1>

          <motion.p
            variants={fadeUp}
            className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-ink-soft sm:text-lg"
          >
            {TOOL_COUNT} video, PDF, and AI tools that run entirely on your machine.
            No uploads. No servers. No accounts.
          </motion.p>

          <motion.div variants={fadeUp} className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <motion.span whileHover={cardHover} whileTap={tapDown} className="inline-block">
              <Link
                to="/video"
                className="group inline-flex items-center gap-2 rounded-2xl bg-accent px-6 py-3 text-sm font-semibold text-white shadow-doodle-card transition-colors duration-200 hover:bg-accent-hover"
              >
                Open the studio
                <span aria-hidden="true" className="transition-transform duration-200 ease-spring group-hover:translate-x-0.5">→</span>
              </Link>
            </motion.span>
            <motion.span whileTap={tapDown} className="inline-block">
              <Link
                to="/pdf"
                className="inline-flex items-center gap-2 rounded-2xl border border-cream-border bg-cream-light px-6 py-3 text-sm font-semibold text-ink-soft shadow-doodle-card transition-colors duration-200 hover:bg-cream-soft hover:text-ink"
              >
                Explore {PDF_TOOL_COUNT} PDF tools
              </Link>
            </motion.span>
          </motion.div>

          {/* Where the decision is made, so the answer is in the same breath. */}
          <motion.p variants={fadeUp} className="mx-auto mt-5 max-w-md text-[13px] leading-relaxed text-ink-muted">
            Pick a file and it is read by this page — no upload, no queue, no copy of
            your document on somebody’s server.
          </motion.p>

          {/* Trust pills */}
          <motion.div
            variants={staggerParent}
            className="mt-10 flex flex-wrap items-center justify-center gap-2"
          >
            {[
              { dot: 'bg-success', label: '100% in-browser' },
              { dot: 'bg-acc-blue', label: 'No uploads' },
              { dot: 'bg-acc-violet', label: 'No accounts' },
              { dot: 'bg-acc-amber', label: 'WebAssembly + WebGPU' },
            ].map((pill) => (
              <motion.span
                key={pill.label}
                variants={scaleIn}
                className="inline-flex items-center gap-2 rounded-full border border-cream-border bg-cream-light px-3.5 py-1.5 text-xs font-medium text-ink-soft shadow-doodle-card"
              >
                <span className={`h-1.5 w-1.5 rounded-full ${pill.dot}`} />
                {pill.label}
              </motion.span>
            ))}
          </motion.div>

          {/* Faux product mock — pure decorative loop, no real processing */}
          <motion.div
            variants={fadeUp}
            className="mx-auto mt-14 max-w-md"
            aria-hidden="true"
          >
            <div className="rounded-2xl border border-cream-border bg-cream-light p-5 text-left shadow-doodle-hover">
              <div className="mb-4 flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-cream-border" />
                <span className="h-2.5 w-2.5 rounded-full bg-cream-border" />
                <span className="h-2.5 w-2.5 rounded-full bg-cream-border" />
                <span className="ml-2 truncate font-mono text-[11px] text-ink-muted">clip-0421.mp4 → 60%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-cream-soft">
                <div className="mock-progress-fill h-full rounded-full bg-accent" />
              </div>
              <div className="mt-3 flex items-center justify-between font-mono text-[11px] text-ink-muted">
                <span>ffmpeg.wasm · encoding</span>
                <span className="tabular-nums">local only</span>
              </div>
            </div>
          </motion.div>
        </motion.section>

        {/* ── Bento grid ── */}
        <section className="pb-24 sm:pb-32">
          <motion.div
            variants={staggerParent}
            initial="hidden"
            whileInView="visible"
            viewport={viewportOnce}
            className="mb-8 text-center"
          >
            <motion.p variants={fadeUp} className="eyebrow mb-2 text-acc-violet">Capabilities</motion.p>
            <motion.h2
              variants={fadeUp}
              className="font-display text-2xl font-semibold tracking-[-0.02em] text-ink sm:text-3xl"
            >
              One tab. Every format.
            </motion.h2>
          </motion.div>

          <motion.div
            variants={staggerParent}
            initial="hidden"
            whileInView="visible"
            viewport={viewportOnce}
            className="grid grid-cols-1 gap-4 sm:grid-cols-6 lg:grid-cols-12"
          >
            {/* Large: Video (8 cols) */}
            <motion.div variants={fadeUp} whileHover={cardHover} whileTap={tapDown} className="sm:col-span-6 lg:col-span-7">
              <Link to="/video" className="group flex h-full flex-col rounded-[20px] border border-cream-border bg-cream-light p-7 shadow-doodle transition-all duration-200 hover:shadow-card-hover sm:p-9">
                <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-xl bg-acc-blue-tint text-2xl text-acc-blue transition-transform duration-300 group-hover:scale-110">
                  ▶
                </div>
                <p className="eyebrow mb-2 text-acc-blue">{VIDEO_TOOL_COUNT} tools · FFmpeg</p>
                <h3 className="mb-2 font-display text-2xl font-semibold tracking-[-0.02em] text-ink sm:text-[28px]">
                  Video, cut to fit
                </h3>
                <p className="max-w-md text-sm leading-relaxed text-ink-muted">
                  Trim, resize, crop, compress, GIF, extract audio, change speed, strip metadata. FFmpeg compiled to WebAssembly — same engine, zero servers.
                </p>
                <div className="mt-auto pt-6">
                  <TileArrow colorClass="text-acc-blue" />
                </div>
              </Link>
            </motion.div>

            {/* Large: PDF (5 cols) */}
            <motion.div variants={fadeUp} whileHover={cardHover} whileTap={tapDown} className="sm:col-span-6 lg:col-span-5">
              <Link to="/pdf" className="group flex h-full flex-col rounded-[20px] border border-cream-border bg-cream-light p-7 shadow-doodle transition-all duration-200 hover:shadow-card-hover sm:p-9">
                <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-xl bg-acc-violet-tint text-2xl text-acc-violet transition-transform duration-300 group-hover:scale-110">
                  ▤
                </div>
                <p className="eyebrow mb-2 text-acc-violet">{PDF_TOOL_COUNT} tools · {PDF_CATEGORY_COUNT} categories</p>
                <h3 className="mb-2 font-display text-2xl font-semibold tracking-[-0.02em] text-ink sm:text-[28px]">
                  The PDF desk
                </h3>
                <p className="text-sm leading-relaxed text-ink-muted">
                  Merge, split, sign, encrypt, redact, OCR, convert. A whole document pipeline in one page.
                </p>
                {/* The jobs, named the way a visitor names them, so the tile answers
                    “is the thing I need here?” without a click. */}
                <ul className="mt-4 flex flex-wrap gap-1.5">
                  {TOOL_JOBS.map((job) => (
                    <li
                      key={job.id}
                      className="rounded-full border border-cream-border bg-cream-soft px-2.5 py-1 text-[11px] font-medium text-ink-muted"
                    >
                      {job.label}
                    </li>
                  ))}
                </ul>
                <div className="mt-auto pt-6">
                  <TileArrow colorClass="text-acc-violet" />
                </div>
              </Link>
            </motion.div>

            {/* Small: 3 AI subdomains (4 cols each) */}
            {smallTiles.map((t) => (
              <motion.div key={t.title} variants={fadeUp} whileHover={cardHover} whileTap={tapDown} className="sm:col-span-2 lg:col-span-4">
                <a
                  href={t.href}
                  {...linkExternal}
                  className={`group flex h-full flex-col rounded-[20px] border border-cream-border bg-cream-light p-6 shadow-doodle transition-all duration-200 hover:shadow-card-hover ${t.ring}`}
                >
                  <div className={`mb-5 flex h-10 w-10 items-center justify-center rounded-xl text-xl ${t.tileBg} ${t.fg} transition-transform duration-300 group-hover:scale-110`}>
                    {t.icon}
                  </div>
                  <p className={`eyebrow mb-1.5 ${t.fg}`}>{t.eyebrow}</p>
                  <h3 className="mb-1.5 font-display text-lg font-semibold tracking-[-0.02em] text-ink">
                    {t.title}
                  </h3>
                  <p className="mb-5 text-sm leading-relaxed text-ink-muted">{t.copy}</p>
                  <div className="mt-auto">
                    <TileArrow colorClass={t.fg} />
                  </div>
                </a>
              </motion.div>
            ))}
          </motion.div>
        </section>

        {/* ── How it works ── */}
        <section className="pb-24 sm:pb-32">
          <motion.p variants={fadeUp} initial="hidden" whileInView="visible" viewport={viewportOnce} className="eyebrow mb-8 text-acc-emerald">
            How it works
          </motion.p>
          <motion.div
            variants={staggerParent}
            initial="hidden"
            whileInView="visible"
            viewport={viewportOnce}
            className="grid grid-cols-1 gap-10 sm:grid-cols-3 sm:gap-6"
          >
            {steps.map((step, i) => (
              <motion.div key={step.n} variants={fadeUp} className="relative">
                {/* connecting line drawn on scroll (between steps) */}
                {i < steps.length - 1 && (
                  <motion.span
                    aria-hidden="true"
                    className="absolute left-14 top-5 hidden h-px w-[calc(100%-3rem)] origin-left bg-[#C6C6BC] sm:block"
                    initial={{ scaleX: 0 }}
                    whileInView={{ scaleX: 1 }}
                    viewport={viewportOnce}
                    transition={{ duration: 0.6, delay: 0.25 + i * 0.15, ease: [0.16, 1, 0.3, 1] }}
                  />
                )}
                <div className="mb-4 flex items-center gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-cream-border bg-cream-light font-mono text-xs font-semibold text-ink shadow-doodle-card">
                    {step.n}
                  </span>
                </div>
                <h3 className={`mb-1.5 font-display text-base font-semibold tracking-[-0.01em] ${step.accent}`}>
                  {step.title}
                </h3>
                <p className="text-sm leading-relaxed text-ink-muted">{step.copy}</p>
              </motion.div>
            ))}
          </motion.div>
        </section>

        {/* ── Footer ── */}
        <footer className="border-t border-cream-border py-12">
          <div className="flex flex-col items-center justify-between gap-6 sm:flex-row">
            <div className="flex items-center gap-2.5">
              <img src="/logo.png" alt="" className="h-5 w-5" />
              <span className="font-display text-sm font-semibold text-ink">
                Browser<span className="text-accent">Snip</span>
              </span>
              <span className="ml-2 text-xs text-ink-muted">Everything stays on your machine.</span>
            </div>
            <div className="flex items-center gap-5 text-xs font-medium text-ink-muted">
              <a href="https://blur.browsersnip.com" {...linkExternal} className="transition-colors hover:text-ink">Blur</a>
              <a href="https://chat.browsersnip.com" {...linkExternal} className="transition-colors hover:text-ink">Chat</a>
              <a href="https://upscale.browsersnip.com" {...linkExternal} className="transition-colors hover:text-ink">Upscale</a>
              <a
                href={GITHUB_URL}
                {...linkExternal}
                aria-label="View source on GitHub"
                className="inline-flex h-8 w-8 items-center justify-center rounded-doodle border border-cream-border bg-cream-light text-ink-soft shadow-doodle-card transition-colors duration-200 hover:bg-cream-soft hover:text-ink"
              >
                <GitHubIcon className="h-4 w-4" />
              </a>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
