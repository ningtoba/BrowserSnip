/**
 * The app shell: header, tool rail, ⌘K palette and tool-page header.
 *
 * Three jobs beyond holding the outlet:
 *
 * - **Find a tool from anywhere.** `⌘K` / `Ctrl-K` opens the palette on every
 *   route, and the rail lists every category with a live count from the
 *   registry, so arriving at `/pdf` is not a prerequisite for navigating.
 * - **Remember what mattered.** Starred tools and the last picked files sit in
 *   the rail. Files are *metadata only* (see `lib/recents.ts`) — the list is a
 *   shortcut back to a tool, never a claim that the document is still loaded.
 * - **Stay legible at 2am.** The theme toggle flips `html.dark`; every colour
 *   this file uses comes from a token in `index.css` that has a dark value, and
 *   no component here names a hex.
 *
 * Colour is therefore class-driven (`shell-*`, `palette-*`) rather than inline,
 * and layout utilities (flex, spacing, type size) stay ordinary Tailwind.
 */
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { easeOut, tapDown } from '@/lib/motion';
import { EngineSettingsDialog, useEngineStatus } from '@/lib/pdf/engines/EngineGate';
import { ENGINE_LABELS, type EngineId } from '@/lib/pdf/engines/provider';
import { PDF_CATEGORIES, getPdfTool, toolsByCategory } from '@/lib/pdf/tools/registry';
import { TOOLS as ALL_TOOLS } from '@/lib/constants';
import type { PdfToolDefinition } from '@/lib/pdf/tools/types';
import { useHasRail } from '@/hooks/useIsCompact';
import { useTheme } from '@/hooks/useTheme';
import { useFileStore } from '@/stores/file-store';
import { formatFileSize } from '@/lib/utils/download';
import {
  formatRelativeTime,
  recordRecentFiles,
  useRecentFiles,
  useStarredTools,
  type RecentFileEntry,
} from '@/lib/recents';
import { CommandPalette } from './CommandPalette';
import { ErrorBoundary } from '@/components/ErrorBoundary';

/** Tool routes own a header strip; everything else just renders the page. */
const TOOL_PATH = /^\/tool\/([^/]+)/;

function toolIdFromPath(pathname: string): string | null {
  return TOOL_PATH.exec(pathname)?.[1] ?? null;
}

export function AppLayout() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const hasRail = useHasRail();

  const [mobileOpen, setMobileOpen] = useState(false);
  const [enginesOpen, setEnginesOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const engineStatus = useEngineStatus();
  const engineCount = Object.values(engineStatus).filter((entry) => entry.configured).length;

  const isVideoActive = pathname.startsWith('/video');
  const isPdfActive = pathname.startsWith('/pdf') || pathname.startsWith('/tool/');
  const toolId = toolIdFromPath(pathname);

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

  // Remember file *picks* as they happen. Only name and size are read, which is
  // the whole reason this effect cannot accidentally store contents.
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

  const closeMobile = () => setMobileOpen(false);

  const goTo = (to: string) => {
    closeMobile();
    navigate(to);
  };

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
            onClick={closeMobile}
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

          {/* Palette trigger — the keyboard route is the primary one. */}
          <motion.button
            type="button"
            onClick={() => setPaletteOpen(true)}
            whileTap={tapDown}
            className="shell-btn ml-auto min-w-0 lg:ml-4"
            aria-label="Search tools"
            title="Search all tools (⌘K)"
          >
            <span aria-hidden="true">⌕</span>
            <span className="hidden max-w-28 truncate sm:inline">Search tools</span>
            <span className="shell-kbd hidden lg:inline-flex">⌘K</span>
          </motion.button>

          <ThemeToggle />

          <motion.button
            onClick={() => setEnginesOpen(true)}
            whileTap={tapDown}
            title="Optional advanced PDF engines"
            className="shell-btn hidden sm:inline-flex"
          >
            <span
              aria-hidden
              className={`h-1.5 w-1.5 rounded-full ${engineCount > 0 ? 'shell-dot-ok' : 'shell-dot-idle'}`}
            />
            Engines
            <span className="shell-meta">{engineCount}/3</span>
          </motion.button>
          <button
            onClick={() => setEnginesOpen(true)}
            className="shell-icon-btn sm:hidden"
            aria-label="Advanced PDF engines"
          >
            ⚙
          </button>

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

          {/* The rail replaces the drawer as soon as there is room for it. */}
          {!hasRail && (
            <button
              onClick={() => setMobileOpen((prev) => !prev)}
              aria-label="Toggle tools menu"
              aria-expanded={mobileOpen}
              className="shell-icon-btn"
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
          )}
        </div>
      </header>

      {/* ── Drawer: the same rail, folded, below the rail breakpoint ── */}
      <AnimatePresence>
        {mobileOpen && !hasRail && (
          <motion.div
            className="fixed inset-0 z-40"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <div className="shell-scrim absolute inset-0" onClick={closeMobile} />
            <motion.div
              className="shell-rail absolute bottom-0 left-0 top-0 flex w-72 flex-col overflow-hidden"
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={easeOut}
            >
              <div className="flex items-center justify-between px-4 py-3">
                <Link to="/" className="shell-title font-display text-base font-semibold tracking-tight" onClick={closeMobile}>
                  Browser<span className="shell-accent">Snip</span>
                </Link>
                <button onClick={closeMobile} className="shell-icon-btn" aria-label="Close tools menu">
                  ✕
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
                <ShellRail currentToolId={toolId} onNavigate={goTo} />
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Rail + page ── */}
      <div className="flex min-h-0 flex-1">
        {hasRail && (
          <aside className="shell-rail flex w-64 shrink-0 flex-col overflow-y-auto px-2 py-3">
            <ShellRail currentToolId={toolId} onNavigate={goTo} />
          </aside>
        )}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {toolId && <ToolPageHeader toolId={toolId} />}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {/* Keyed by route, so walking to another tool clears a crash by itself. */}
            <ErrorBoundary label="page" resetKey={pathname}>
              <Outlet />
            </ErrorBoundary>
          </div>
        </div>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      {enginesOpen && (
        <EngineSettingsDialog open={enginesOpen} onClose={() => setEnginesOpen(false)} />
      )}
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
 * The rail: starred tools, the registry by category with live counts, and the
 * recent files. Read-only over the registry — counts come from `toolsByCategory`
 * so a tool added to a definition file appears here without a shell change.
 */
function ShellRail({
  currentToolId,
  onNavigate,
}: {
  currentToolId: string | null;
  onNavigate: (to: string) => void;
}) {
  const { starred, isStarred, toggle } = useStarredTools();
  const { recents, clear } = useRecentFiles();

  const currentCategory = currentToolId ? getPdfTool(currentToolId)?.category : undefined;
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    currentCategory ? { [currentCategory]: true } : {},
  );

  // Landing on a tool reveals its category instead of hiding the highlight.
  useEffect(() => {
    if (!currentCategory) return;
    setOpen((prev) => (prev[currentCategory] ? prev : { ...prev, [currentCategory]: true }));
  }, [currentCategory]);

  const toolsById = useMemo(
    () => new Map(PDF_CATEGORIES.flatMap((category) => toolsByCategory(category.id)).map((tool) => [tool.id, tool])),
    [],
  );

  return (
    <div className="flex flex-col gap-1">
      <RailSection
        title="Starred"
        count={starred.length}
        action={
          starred.length > 0 ? (
            <button
              type="button"
              onClick={clear}
              className="shell-link font-mono text-[10px]"
              aria-label="Unstar every tool"
              title="Click a starred tool again to remove it"
            >
              {starred.length} pinned
            </button>
          ) : undefined
        }
      >
        {starred.length === 0 ? (
          <p className="shell-muted px-2 py-1 text-[11px] leading-relaxed">
            Nothing pinned yet — use the ★ on any tool.
          </p>
        ) : (
          starred.map((id) => {
            const tool = toolsById.get(id);
            if (!tool) return null;
            return (
              <RailToolRow
                key={`starred-${id}`}
                tool={tool}
                active={currentToolId === id}
                starred
                onNavigate={onNavigate}
                onToggleStar={toggle}
              />
            );
          })
        )}
      </RailSection>

      <RailSection title="Categories" count={toolsById.size}>
        {PDF_CATEGORIES.map((category) => {
          const tools = toolsByCategory(category.id);
          const expanded = Boolean(open[category.id]);
          return (
            <div key={category.id}>
              <button
                type="button"
                onClick={() => setOpen((prev) => ({ ...prev, [category.id]: !prev[category.id] }))}
                aria-expanded={expanded}
                aria-label={`${category.label} (${tools.length} tools)`}
                className="shell-row w-full justify-between"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span aria-hidden="true">{category.icon}</span>
                  <span className="truncate">{category.label}</span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <span className="shell-meta">{tools.length}</span>
                  <span aria-hidden="true" className={`text-[10px] transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}>
                    ›
                  </span>
                </span>
              </button>
              {expanded && (
                <div className="shell-nest ml-2 flex flex-col pl-1.5">
                  {tools.map((tool) => (
                    <RailToolRow
                      key={tool.id}
                      tool={tool}
                      active={currentToolId === tool.id}
                      starred={isStarred(tool.id)}
                      onNavigate={onNavigate}
                      onToggleStar={toggle}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </RailSection>

      <RailSection
        title="Recent files"
        count={recents.length}
        action={
          recents.length > 0 ? (
            <button type="button" onClick={clear} className="shell-link font-mono text-[10px]" aria-label="Clear recent files">
              Clear
            </button>
          ) : undefined
        }
      >
        {recents.length === 0 ? (
          <p className="shell-muted px-2 py-1 text-[11px] leading-relaxed">
            Files you open show up here — name, size and tool only. Nothing is uploaded, and no
            file contents are stored.
          </p>
        ) : (
          recents.map((entry) => (
            <RecentFileRow
              key={`${entry.toolId}-${entry.name}-${entry.size}`}
              entry={entry}
              toolName={toolsById.get(entry.toolId)?.name ?? entry.toolId}
              onNavigate={onNavigate}
            />
          ))
        )}
      </RailSection>
    </div>
  );
}

/** Collapsible rail group with an always-visible header row. */
function RailSection({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className="mb-1">
      <div className="flex items-center gap-2 px-2 py-1">
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          aria-expanded={open}
          className="shell-link flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em]"
        >
          <span aria-hidden="true" className={`text-[9px] transition-transform duration-200 ${open ? 'rotate-90' : ''}`}>
            ›
          </span>
          {title}
          <span className="shell-meta normal-case">{count}</span>
        </button>
        <span className="flex-1" />
        {action}
      </div>
      {open && <div className="flex flex-col gap-0.5">{children}</div>}
    </section>
  );
}

function RailToolRow({
  tool,
  active,
  starred,
  onNavigate,
  onToggleStar,
}: {
  tool: PdfToolDefinition;
  active: boolean;
  starred: boolean;
  onNavigate: (to: string) => void;
  onToggleStar: (id: string) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => onNavigate(`/tool/${tool.id}`)}
        aria-current={active ? 'page' : undefined}
        title={tool.description}
        className={`shell-row min-w-0 flex-1 ${active ? 'shell-row-active' : ''}`}
      >
        <span aria-hidden="true" className="shrink-0 text-[13px]">
          {tool.icon}
        </span>
        <span className="truncate">{tool.name}</span>
        {tool.engines?.length ? (
          <span aria-hidden title="Uses an optional engine" className="shell-meta shrink-0">
            ⚙
          </span>
        ) : null}
      </button>
      <button
        type="button"
        onClick={() => onToggleStar(tool.id)}
        aria-pressed={starred}
        aria-label={`${starred ? 'Unstar' : 'Star'} ${tool.name}`}
        title={starred ? 'Remove from starred tools' : 'Pin to starred tools'}
        className={`shell-icon-btn h-6 w-6 shrink-0 text-[11px] ${starred ? 'shell-accent' : 'shell-muted'}`}
      >
        <span aria-hidden="true">{starred ? '★' : '☆'}</span>
      </button>
    </div>
  );
}

/**
 * One remembered pick. Clicking re-opens the *tool*, not the document: only
 * metadata survives the tab, and saying so here is what stops the row from
 * reading like a session restore that does not exist.
 */
function RecentFileRow({
  entry,
  toolName,
  onNavigate,
}: {
  entry: RecentFileEntry;
  toolName: string;
  onNavigate: (to: string) => void;
}) {
  const name = entry.name.length > 22 ? `${entry.name.slice(0, 21)}…` : entry.name;
  return (
    <button
      type="button"
      onClick={() => onNavigate(`/tool/${entry.toolId}`)}
      title={`${entry.name} · ${formatFileSize(entry.size)} · ${toolName} — opens the tool again; the file itself is never stored`}
      className="shell-row flex-col items-start gap-0.5 py-1.5"
    >
      <span className="w-full truncate text-[11px] font-medium">{name}</span>
      <span className="shell-meta w-full truncate">
        {formatFileSize(entry.size)} · {toolName} · {formatRelativeTime(entry.at)}
      </span>
    </button>
  );
}

/**
 * Context strip for `/tool/:toolId`: where I am, what I get, what it needs.
 *
 * The workspace's own bar keeps the actions (Process, Log); this keeps the
 * breadcrumb, the tool's one-line promise from the registry and an engine badge
 * when the tool depends on one of the three optional AGPL engines.
 */
export function ToolPageHeader({ toolId }: { toolId: string }) {
  const definition = getPdfTool(toolId);
  const engineStatus = useEngineStatus();
  const { isStarred, toggle } = useStarredTools();
  // Video tools are not in the PDF registry. Left as it was, the header fell
  // back to the raw id ("trim") and pointed a video page's breadcrumb at /pdf.
  const video = definition ? undefined : ALL_TOOLS.find((entry) => entry.id === toolId && entry.category === 'video');
  const isVideo = Boolean(video);
  const category = definition ? PDF_CATEGORIES.find((entry) => entry.id === definition.category) : undefined;
  const starred = definition ? isStarred(definition.id) : false;

  const label = definition?.name ?? video?.name ?? toolId;
  const promise =
    definition?.description
    ?? video?.description
    ?? 'This tool runs entirely in this tab — nothing is uploaded.';

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
          <>
            {(definition.engines ?? []).map((engine) => (
              <EngineRequirementBadge key={engine} id={engine} status={engineStatus[engine]} />
            ))}
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
          </>
        )}
      </div>

      <p className="shell-soft mt-1 max-w-3xl text-[11px] leading-relaxed">{promise}</p>
    </header>
  );
}

/**
 * Names the optional engine a tool needs and where it would come from. Uses the
 * same three states as `EngineBadge` so a tool page and the settings dialog
 * never disagree about whether an engine is reachable.
 */
function EngineRequirementBadge({
  id,
  status,
}: {
  id: EngineId;
  status: { configured: boolean; url: string; fromUser: boolean } | undefined;
}) {
  const configured = status?.configured ?? false;
  const source = !configured ? 'not configured' : status?.fromUser ? 'your mirror' : 'default CDN';
  return (
    <span
      className={`shell-badge ${configured ? 'shell-badge-ok' : 'shell-badge-warn'}`}
      title={
        configured
          ? `${ENGINE_LABELS[id]} is reachable from ${status?.url}. Optional, AGPL-licensed, downloaded on first use.`
          : `${ENGINE_LABELS[id]} is not reachable. This tool degrades instead of guessing — open Engines to point it somewhere.`
      }
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
      {ENGINE_LABELS[id]} · {source}
    </span>
  );
}
