import { Outlet, Link, useLocation } from 'react-router-dom';
import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { easeOut, tapDown } from '@/lib/motion';
import { EngineSettingsDialog, useEngineStatus } from '@/lib/pdf/engines/EngineGate';
import { ErrorBoundary } from '@/components/ErrorBoundary';

export function AppLayout() {
  const { pathname } = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [enginesOpen, setEnginesOpen] = useState(false);
  const engineStatus = useEngineStatus();
  const engineCount = Object.values(engineStatus).filter((entry) => entry.configured).length;

  const isVideoActive = pathname.startsWith('/video');
  const isPdfActive = pathname.startsWith('/pdf');

  const closeMobile = () => setMobileOpen(false);

  const navLinkClass = (active: boolean) =>
    `relative flex h-full items-center px-3 text-xs transition-colors duration-200 ${
      active
        ? 'font-display font-semibold text-accent'
        : 'font-medium text-ink-muted hover:text-ink-soft'
    }`;

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-cream">
      {/* ── Top Navigation — glass sticky header ── */}
      <header className="sticky top-0 z-30 h-14 border-b border-cream-border bg-glass">
        <div className="mx-auto flex h-full max-w-6xl items-center gap-4 px-4 sm:px-6 lg:px-8">
          {/* Left: Logo lockup (Space Grotesk) */}
          <Link
            to="/"
            className="flex shrink-0 items-center gap-2 font-display text-sm font-semibold tracking-tight text-ink"
            onClick={closeMobile}
          >
            <img src="/logo.png" alt="" className="h-6 w-6" />
            Browser<span className="text-accent">Snip</span>
          </Link>

          {/* Center: Desktop nav links with sliding layoutId underline */}
          <nav className="hidden sm:flex h-full items-center gap-1">
            {[
              { to: '/video', label: 'Video', active: isVideoActive },
              { to: '/pdf', label: 'PDF', active: isPdfActive },
            ].map((tab) => (
              <Link key={tab.to} to={tab.to} className={navLinkClass(tab.active)}>
                {tab.label}
                {tab.active && (
                  <motion.span
                    layoutId="nav-underline"
                    className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent"
                    transition={easeOut}
                  />
                )}
              </Link>
            ))}
          </nav>

          <div className="flex-1" />

          {/* Right: optional WASM engines, then GitHub */}
          <motion.button
            onClick={() => setEnginesOpen(true)}
            whileTap={tapDown}
            title="Optional advanced PDF engines"
            className="hidden items-center gap-1.5 rounded-full border border-cream-border bg-cream-light px-3 py-1.5 text-[11px] font-medium text-ink-muted transition-colors hover:border-accent/30 hover:text-ink sm:inline-flex"
          >
            <span
              aria-hidden
              className={`h-1.5 w-1.5 rounded-full ${engineCount > 0 ? 'bg-success' : 'bg-cream-border'}`}
            />
            Engines
            <span className="font-mono text-[10px] text-ink-muted/70">{engineCount}/3</span>
          </motion.button>
          <button
            onClick={() => setEnginesOpen(true)}
            className="inline-flex items-center rounded-full border border-cream-border bg-cream-light px-2.5 py-1.5 text-[11px] font-medium text-ink-muted sm:hidden"
            aria-label="Advanced PDF engines"
          >
            ⚙
          </button>

          {/* Right: GitHub button (desktop) */}
          <motion.a
            href="https://github.com/ningtoba/BrowserSnip"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="View source on GitHub"
            whileTap={tapDown}
            className="hidden sm:inline-flex items-center gap-2 rounded-doodle border border-cream-border bg-cream-light px-3 py-1.5 text-xs font-medium text-ink-soft shadow-doodle-card transition-colors duration-200 hover:bg-cream-soft hover:text-ink"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.341-3.369-1.341-.454-1.155-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.268 2.75 1.026A9.578 9.578 0 0 1 12 6.836a9.59 9.59 0 0 1 2.504.337c1.909-1.294 2.747-1.026 2.747-1.026.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.161 22 16.416 22 12c0-5.523-4.477-10-10-10z" />
            </svg>
            <span className="hidden md:inline">GitHub</span>
          </motion.a>

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

      {/* ── Mobile slide-in panel (AnimatePresence) ── */}
      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            className="fixed inset-0 z-40 sm:hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            {/* Backdrop */}
            <div
              className="absolute inset-0 bg-cream/70 backdrop-blur-sm"
              onClick={closeMobile}
            />
            {/* Panel */}
            <motion.div
              className="absolute left-0 top-0 bottom-0 w-64 bg-cream-light border-r border-cream-border shadow-doodle-card p-6 flex flex-col gap-6"
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={easeOut}
            >
              {/* Logo */}
              <Link
                to="/"
                className="font-display text-base font-semibold tracking-tight text-ink"
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
                      ? 'text-acc-blue bg-acc-blue-tint'
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
                      ? 'text-acc-violet bg-acc-violet-tint'
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
                className="inline-flex items-center gap-2 rounded-doodle-md border border-cream-border bg-cream-light px-3 py-2 text-xs font-medium text-ink-soft hover:text-ink hover:bg-cream-soft transition-colors duration-200"
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.341-3.369-1.341-.454-1.155-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.268 2.75 1.026A9.578 9.578 0 0 1 12 6.836a9.59 9.59 0 0 1 2.504.337c1.909-1.294 2.747-1.026 2.747-1.026.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.161 22 16.416 22 12c0-5.523-4.477-10-10-10z" />
                </svg>
                GitHub
              </a>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Page Content ── */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* Keyed by route, so walking to another tool clears a crash by itself. */}
        <ErrorBoundary label="page" resetKey={pathname}>
          <Outlet />
        </ErrorBoundary>
      </div>
      {enginesOpen && (
        <EngineSettingsDialog open={enginesOpen} onClose={() => setEnginesOpen(false)} />
      )}
    </div>
  );
}
