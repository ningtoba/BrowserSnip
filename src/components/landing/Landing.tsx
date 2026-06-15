import { Link } from 'react-router-dom';

export function Landing() {
  return (
    <div className="bg-cream bg-grid">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        {/* ── Section 1: Hero ── */}
        <section className="py-20 sm:py-28 text-center">
          <div className="mb-6 inline-flex items-center justify-center gap-3">
            <div className="flex h-16 w-16 items-center justify-center rounded-doodle-lg bg-accent/10 ring-1 ring-accent/20">
              <span className="text-3xl">✂</span>
            </div>
          </div>
          <h1 className="font-display text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight text-ink">
            Browser<span className="text-accent">Snip</span>
          </h1>
          <p className="mx-auto mt-4 max-w-lg text-sm sm:text-base text-ink-soft leading-relaxed">
            100% client-side video and PDF tools. No uploads, no servers, total privacy.
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
        </section>

        {/* ── Section 2: Featured — Blur promotion ── */}
        <section className="max-w-3xl mx-auto mb-12">
          <a
            href="https://blur.browsersnip.com"
            target="_blank"
            rel="noopener noreferrer"
            className="block animate-slide-up group"
            style={{ animationFillMode: 'both' }}
          >
            <div className="rainbow-border">
              <div className="rainbow-border-inner p-6 sm:p-8 flex flex-col sm:flex-row items-start sm:items-center gap-5">
                <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-doodle-lg bg-accent/10 text-3xl transition-transform duration-300 group-hover:scale-110">
                  ◎
                </div>
                <div className="flex-1 min-w-0">
                  <h2 className="text-lg sm:text-xl font-bold text-ink mb-1.5">
                    Blur
                  </h2>
                  <p className="text-sm leading-relaxed text-ink-muted">
                    AI-powered face detection and one-click privacy blur. Automatically finds faces in any image and lets you obscure them — no uploads, runs entirely in your browser.
                  </p>
                </div>
                <div className="shrink-0">
                  <span className="inline-flex items-center gap-2 rounded-doodle-md bg-accent/10 px-4 py-2 text-sm font-semibold text-accent transition-all duration-200 group-hover:bg-accent/20 group-hover:gap-2.5">
                    Try it
                    <span className="text-sm leading-none transition-transform duration-200 group-hover:translate-x-0.5">→</span>
                  </span>
                </div>
              </div>
            </div>
          </a>
        </section>

        {/* ── Section 3: Tool Categories ── */}
        <section className="max-w-4xl mx-auto grid grid-cols-1 sm:grid-cols-2 gap-5 mb-12">
          {/* Video Tools card */}
          <div
            className="animate-slide-up"
            style={{ animationDelay: '60ms', animationFillMode: 'both' }}
          >
            <Link to="/video" className="tool-card group h-full !p-6 sm:!p-8">
              <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-doodle-lg bg-accent/10 text-3xl transition-transform duration-300 group-hover:scale-110">
                🎬
              </div>
              <h2 className="mb-2 text-lg font-bold text-ink transition-colors duration-200 group-hover:text-accent">
                Video Tools
              </h2>
              <p className="text-sm leading-relaxed text-ink-muted">
                8 FFmpeg-powered tools. Trim, resize, crop, compress, convert to GIF, extract audio, control speed, and strip metadata — all in your browser.
              </p>
              <div className="mt-auto pt-5">
                <span className="inline-flex items-center gap-2 text-sm font-semibold text-accent transition-all duration-200 group-hover:gap-2.5">
                  Browse Video Tools
                  <span className="text-sm leading-none transition-transform duration-200 group-hover:translate-x-0.5">→</span>
                </span>
              </div>
            </Link>
          </div>

          {/* PDF Tools card */}
          <div
            className="animate-slide-up"
            style={{ animationDelay: '120ms', animationFillMode: 'both' }}
          >
            <Link to="/pdf" className="tool-card group h-full !p-6 sm:!p-8">
              <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-doodle-lg bg-accent/10 text-3xl transition-transform duration-300 group-hover:scale-110">
                📄
              </div>
              <h2 className="mb-2 text-lg font-bold text-ink transition-colors duration-200 group-hover:text-accent">
                PDF Tools
              </h2>
              <p className="text-sm leading-relaxed text-ink-muted">
                26 PDF tools across 6 categories. Merge, split, convert, edit, sign, encrypt, redact, OCR, and more — no uploads required.
              </p>
              <div className="mt-auto pt-5">
                <span className="inline-flex items-center gap-2 text-sm font-semibold text-accent transition-all duration-200 group-hover:gap-2.5">
                  Browse PDF Tools
                  <span className="text-sm leading-none transition-transform duration-200 group-hover:translate-x-0.5">→</span>
                </span>
              </div>
            </Link>
          </div>
        </section>

        {/* ── Section 4: Footer ── */}
        <footer className="mt-16 sm:mt-24 pb-12 text-center">
          <div className="flex flex-wrap items-center justify-center gap-3">
            <div className="inline-flex items-center gap-3 rounded-doodle-lg border border-cream-border bg-cream-light px-5 py-3.5 shadow-doodle-card">
              <div className="flex h-8 w-8 items-center justify-center rounded-doodle bg-success/10">
                <span className="text-sm text-success">🛡</span>
              </div>
              <div className="text-left">
                <p className="text-xs font-semibold text-ink">All processing runs locally</p>
                <p className="text-[11px] text-ink-muted">No data ever leaves your device</p>
              </div>
            </div>
            <a
              href="https://github.com/ningtoba/BrowserSnip"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="View source on GitHub"
              className="inline-flex h-12 w-12 items-center justify-center rounded-doodle-lg border border-cream-border bg-cream-light shadow-doodle-card transition-all duration-200 hover:border-accent/40 hover:bg-accent/10"
            >
              <svg className="h-5 w-5 text-ink-soft" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.341-3.369-1.341-.454-1.155-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.268 2.75 1.026A9.578 9.578 0 0 1 12 6.836a9.59 9.59 0 0 1 2.504.337c1.909-1.294 2.747-1.026 2.747-1.026.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.161 22 16.416 22 12c0-5.523-4.477-10-10-10z" />
              </svg>
            </a>
          </div>
        </footer>
      </div>
    </div>
  );
}
