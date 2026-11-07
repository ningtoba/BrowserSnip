/**
 * The app shell: header, ⌘K palette and tool-page header.
 *
 * Three jobs beyond holding the outlet:
 *
 * - **Find a tool from anywhere.** `⌘K` / `Ctrl-K` — or the Search button in the
 *   header, which is the same door for anyone who will not memorise a shortcut —
 *   opens the palette on every route. The palette carries the tool list, the
 *   starred tools and the recent files, so arriving at `/pdf` is not a
 *   prerequisite for navigating and no column of the viewport is spent on a
 *   second copy of the dashboard.
 * - **Remember what mattered.** Stars and the last picked files are recorded
 *   here and read by the palette. Files are *metadata only* (see
 *   `lib/recents.ts`) — a recent row is a shortcut back to a tool, never a claim
 *   that the document is still loaded.
 * - **Stay legible at 2am.** The theme toggle flips `html.dark`; every colour
 *   this file uses comes from a token in `index.css` that has a dark value, and
 *   no component here names a hex.
 *
 * Colour is therefore class-driven (`shell-*`, `palette-*`) rather than inline,
 * and layout utilities (flex, spacing, type size) stay ordinary Tailwind.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { easeOut, tapDown } from '@/lib/motion';
import { PDF_CATEGORIES, getPdfTool } from '@/lib/pdf/tools/registry';
import { TOOLS as ALL_TOOLS } from '@/lib/constants';
import { useTheme } from '@/hooks/useTheme';
import { useFileStore } from '@/stores/file-store';
import { recordRecentFiles, useStarredTools } from '@/lib/recents';
import { CommandPalette } from './CommandPalette';
import { ErrorBoundary } from '@/components/ErrorBoundary';

/** Tool routes own a header strip; everything else just renders the page. */
const TOOL_PATH = /^\/tool\/([^/]+)/;

function toolIdFromPath(pathname: string): string | null {
  return TOOL_PATH.exec(pathname)?.[1] ?? null;
}

export function AppLayout() {
  const { pathname } = useLocation();

  const [paletteOpen, setPaletteOpen] = useState(false);

  const isVideoActive = pathname.startsWith('/video');
  const isPdfActive = pathname.startsWith('/pdf') || pathname.startsWith('/tool/');
  const toolId = toolIdFromPath(pathname);

  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const openPalette = useCallback(() => setPaletteOpen(true), []);

  // ⌘K / Ctrl-K everywhere, including while a tool is mid-flight.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Remember file *picks* as they happen — the palette's Recent band reads this
  // back. Only name and size are read, which is the whole reason this effect
  // cannot accidentally store contents.
  const file = useFileStore((s) => s.file);
  const files = useFileStore((s) => s.files);
  const activeTool = useFileStore((s) => s.activeTool);
  const picked = useMemo(() => {
    const all = file ? [file, ...files.filter((entry) => entry !== file)] : files;
    return all.map((entry) => ({ name: entry.name, size: entry.size }));
  }, [file, files]);
  const pickSignature = picked.map((entry) => `${entry.name}::${entry.size}`).join('|');
  useEffect(() => {
    if (!activeTool || pickSignature === '') return;
    recordRecentFiles(picked, String(activeTool));
    // `picked` is rebuilt from the signature; depending on the string keeps
    // this from re-recording on unrelated store updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickSignature, activeTool]);

  const navLinkClass = (active: boolean) =>
    `relative flex h-full items-center px-3 text-xs transition-colors duration-200 ${
      active ? 'shell-accent font-display font-semibold' : 'shell-muted font-medium'
    }`;

  return (
    <div className="shell-app flex h-screen flex-col overflow-hidden">
      {/* ── Top navigation — glass sticky header ── */}
      <header className="shell-header sticky top-0 z-30 h-14">
        <div className="mx-auto flex h-full max-w-7xl items-center gap-3 px-4 sm:px-6 lg:px-8">
          <Link
            to="/"
            className="shell-title flex shrink-0 items-center gap-2 font-display text-sm font-semibold tracking-tight"
          >
            <img src="/logo.png" alt="" className="h-6 w-6" />
            Browser<span className="shell-accent">Snip</span>
          </Link>

          <nav className="hidden h-full items-center gap-1 sm:flex">
            {[
              { to: '/video', label: 'Video', active: isVideoActive },
              { to: '/pdf', label: 'PDF', active: isPdfActive },
            ].map((tab) => (
              <Link key={tab.to} to={tab.to} className={navLinkClass(tab.active)}>
                {tab.label}
                {tab.active && (
                  <motion.span
                    layoutId="nav-underline"
                    className="shell-accent absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-current"
                    transition={easeOut}
                  />
                )}
              </Link>
            ))}
          </nav>

          {/* Palette trigger — the pointer route to a list with no rail. */}
          <motion.button
            type="button"
            onClick={openPalette}
            whileTap={tapDown}
            className="shell-btn ml-auto min-w-0"
            aria-haspopup="dialog"
            aria-expanded={paletteOpen}
            aria-controls="command-palette"
            aria-keyshortcuts="Meta+K Control+K"
            title="Search all tools (⌘K)"
          >
            <span aria-hidden="true">⌕</span>
            <span>Search tools</span>
            <span className="shell-kbd hidden lg:inline-flex">⌘K</span>
          </motion.button>

          <ThemeToggle />

          <a
            href="https://github.com/ningtoba/BrowserSnip"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="View source on GitHub"
            className="shell-btn hidden sm:inline-flex"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.341-3.369-1.341-.454-1.155-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.268 2.75 1.026A9.578 9.578 0 0 1 12 6.836a9.59 9.59 0 0 1 2.504.337c1.909-1.294 2.747-1.026 2.747-1.026.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.161 22 16.416 22 12c0-5.523-4.477-10-10-10z" />
            </svg>
            <span className="hidden md:inline">GitHub</span>
          </a>
        </div>
      </header>

      {/* ── Page: the whole viewport below the header belongs to the tool ── */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {toolId && <ToolPageHeader toolId={toolId} />}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* Keyed by route, so walking to another tool clears a crash by itself. */}
          <ErrorBoundary label="page" resetKey={pathname}>
            <Outlet />
          </ErrorBoundary>
        </div>
      </div>

      <CommandPalette open={paletteOpen} onClose={closePalette} />
    </div>
  );
}

/** Light ↔ dark. Applies `html.dark`; the preference is stored, light is default. */
function ThemeToggle() {
  const { isDark, toggle } = useTheme();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={isDark}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={isDark ? 'Light mode' : 'Dark mode'}
      className="shell-icon-btn"
    >
      <span aria-hidden="true">{isDark ? '☾' : '☀'}</span>
    </button>
  );
}

/**
 * Context strip for `/tool/:toolId`: where I am and what I get.
 *
 * The workspace's own bar keeps the actions (Process, Log); this keeps the
 * breadcrumb, the tool name and the star — and nothing else.
 *
 * The one-line promise used to be printed here *and* on the page below it, so a
 * tool page said the same sentence twice in two wordings. It belongs with the
 * action it describes: the generated surface and the bespoke editors print it
 * themselves, beside the drop zone and again above the file cards. There is no
 * engine affordance here either: the optional CDN engines are resolved
 * automatically, and a run that had to do less because an engine was unreachable
 * says so in its own result warnings, not in a badge that asks the user to fix a
 * setting they never chose.
 */
export function ToolPageHeader({ toolId }: { toolId: string }) {
  const definition = getPdfTool(toolId);
  const { isStarred, toggle } = useStarredTools();
  // Video tools are not in the PDF registry. Left as it was, the header fell
  // back to the raw id ("trim") and pointed a video page's breadcrumb at /pdf.
  const video = definition ? undefined : ALL_TOOLS.find((entry) => entry.id === toolId && entry.category === 'video');
  const isVideo = Boolean(video);
  const category = definition ? PDF_CATEGORIES.find((entry) => entry.id === definition.category) : undefined;
  const starred = definition ? isStarred(definition.id) : false;

  const label = definition?.name ?? video?.name ?? toolId;

  return (
    <header className="shell-header shrink-0 border-b px-4 py-2 sm:px-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <nav aria-label="Breadcrumb" className="min-w-0">
          <ol className="flex flex-wrap items-center gap-1.5 text-[11px]">
            <li>
              <Link to="/" className="shell-link">
                BrowserSnip
              </Link>
            </li>
            <li aria-hidden className="shell-rule">
              /
            </li>
            <li>
              <Link to={isVideo ? '/video' : '/pdf'} className="shell-link">
                {isVideo ? 'Video Tools' : 'PDF Tools'}
              </Link>
            </li>
            {category && (
              <>
                <li aria-hidden className="shell-rule">
                  /
                </li>
                <li className="shell-muted">{category.label}</li>
              </>
            )}
            <li aria-hidden className="shell-rule">
              /
            </li>
            <li aria-current="page" className="shell-title truncate font-semibold">
              {label}
            </li>
          </ol>
        </nav>

        <span className="flex-1" />

        {definition && (
          <button
            type="button"
            onClick={() => toggle(definition.id)}
            aria-pressed={starred}
            aria-label={`${starred ? 'Unstar' : 'Star'} ${definition.name}`}
            className={`shell-btn ${starred ? 'shell-btn-active' : ''}`}
          >
            <span aria-hidden="true">{starred ? '★' : '☆'}</span>
            {starred ? 'Starred' : 'Star'}
          </button>
        )}
      </div>
    </header>
  );
}
