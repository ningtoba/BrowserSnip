import { Outlet, Link, useLocation } from 'react-router-dom';
import { useState } from 'react';

export function AppLayout() {
  const { pathname } = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  const isVideoActive = pathname.startsWith('/video');
  const isPdfActive = pathname.startsWith('/pdf');

  const closeMobile = () => setMobileOpen(false);

  const navLinkClass = (active: boolean) =>
    `text-xs font-medium transition-colors duration-200 px-1 h-full flex items-center ${
      active
        ? 'text-accent border-b-2 border-accent'
        : 'text-ink-muted hover:text-ink-soft border-b-2 border-transparent'
    }`;

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-cream">
      {/* ── Top Navigation ── */}
      <header className="sticky top-0 z-30 h-12 border-b border-cream-border bg-cream-light/90 backdrop-blur-subtle">
        <div className="mx-auto flex h-full max-w-6xl items-center gap-4 px-4 sm:px-6 lg:px-8">
          {/* Left: Logo */}
          <Link
            to="/"
            className="flex shrink-0 items-center gap-2 font-display text-sm font-bold text-ink"
            onClick={closeMobile}
          >
            <img src="/logo.png" alt="" className="h-6 w-6" />
            Browser<span className="text-accent">Snip</span>
          </Link>

          {/* Center: Desktop nav links */}
          <nav className="hidden sm:flex h-full items-center gap-1">
            <Link to="/video" className={navLinkClass(isVideoActive)}>
              Video Tools
            </Link>
            <Link to="/pdf" className={navLinkClass(isPdfActive)}>
              PDF Tools
            </Link>
          </nav>

          <div className="flex-1" />

          {/* Right: GitHub icon (desktop) */}
          <a
            href="https://github.com/ningtoba/BrowserSnip"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="View source on GitHub"
            className="hidden sm:inline-flex items-center justify-center rounded-doodle border border-cream-border bg-cream-light px-2 py-1.5 transition-all duration-200 hover:border-accent/40 hover:bg-accent/10"
          >
            <svg className="h-4 w-4 text-ink-soft" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.341-3.369-1.341-.454-1.155-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.268 2.75 1.026A9.578 9.578 0 0 1 12 6.836a9.59 9.59 0 0 1 2.504.337c1.909-1.294 2.747-1.026 2.747-1.026.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.161 22 16.416 22 12c0-5.523-4.477-10-10-10z" />
            </svg>
          </a>

          {/* Mobile: Hamburger */}
          <button
            onClick={() => setMobileOpen((prev) => !prev)}
            aria-label="Toggle mobile menu"
            className="sm:hidden inline-flex h-8 w-8 items-center justify-center rounded-doodle border border-cream-border bg-cream-light text-ink-soft hover:text-ink transition-colors"
          >
            {mobileOpen ? (
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            ) : (
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                <path d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            )}
          </button>
        </div>
      </header>

      {/* ── Mobile slide-in panel ── */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 sm:hidden">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-cream/70 backdrop-blur-sm"
            onClick={closeMobile}
          />
          {/* Panel */}
          <div className="absolute left-0 top-0 bottom-0 w-64 bg-cream-light border-r border-cream-border shadow-doodle-card p-6 flex flex-col gap-6 animate-slide-in-left">
            {/* Logo */}
            <Link
              to="/"
              className="font-display text-base font-bold text-ink"
              onClick={closeMobile}
            >
              Browser<span className="text-accent">Snip</span>
            </Link>

            <nav className="flex flex-col gap-1">
              <Link
                to="/video"
                onClick={closeMobile}
                className={`rounded-doodle-md px-3 py-2 text-sm font-medium transition-colors duration-200 ${
                  isVideoActive
                    ? 'text-accent bg-accent/10'
                    : 'text-ink-soft hover:text-ink hover:bg-cream-soft'
                }`}
              >
                🎬 Video Tools
              </Link>
              <Link
                to="/pdf"
                onClick={closeMobile}
                className={`rounded-doodle-md px-3 py-2 text-sm font-medium transition-colors duration-200 ${
                  isPdfActive
                    ? 'text-accent bg-accent/10'
                    : 'text-ink-soft hover:text-ink hover:bg-cream-soft'
                }`}
              >
                📄 PDF Tools
              </Link>
            </nav>

            <div className="flex-1" />

            <a
              href="https://github.com/ningtoba/BrowserSnip"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-doodle-md border border-cream-border px-3 py-2 text-xs font-medium text-ink-soft hover:text-ink hover:border-accent/40 transition-colors duration-200"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.341-3.369-1.341-.454-1.155-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.268 2.75 1.026A9.578 9.578 0 0 1 12 6.836a9.59 9.59 0 0 1 2.504.337c1.909-1.294 2.747-1.026 2.747-1.026.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.161 22 16.416 22 12c0-5.523-4.477-10-10-10z" />
              </svg>
              GitHub
            </a>
          </div>
        </div>
      )}

      {/* ── Page Content ── */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <Outlet />
      </div>
    </div>
  );
}
