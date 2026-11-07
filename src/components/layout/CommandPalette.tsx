/**
 * ⌘K / Ctrl-K command palette over the PDF tool registry.
 *
 * This is the shell's only tool list: the left sidebar is gone, so everything
 * the rail used to carry — the category browse, the starred tools and the recent
 * files — arrives here instead, at zero chrome cost. It lists **the catalogue**
 * (`TOOL_CATALOGUE`), one row per job, so a tool that has a second id is not
 * offered twice; a star or a recent file recorded under either spelling resolves
 * to the tool that owns the job. An empty query opens on **Starred**, then
 * **Recent** (the last picked files), then a browse slice of **All tools**.
 * Typing replaces all three with ranked hits, matched fuzzily against **name,
 * keywords and category** — the three things the registry stores for discovery —
 * so `mrg` finds *Merge PDF*, `sign` also finds the editor tools that carry it as
 * a keyword, and `security` finds the whole category.
 *
 * Recents are metadata only (see `lib/recents.ts`): a row names a file and the
 * tool it was opened with, and selecting it re-opens the **tool**, not the
 * document. Nothing here ever reads file contents.
 *
 * Keyboard-first, mouse-safe. `↓`/`↑` (and Home/End) move the active row, `Enter`
 * or a click navigates, `Esc` closes, and typing again resets to the first
 * result. While open, `Tab` cannot escape the dialog, and when it closes focus
 * returns to whatever opened it — the header Search button, or the field that
 * was mid-edit when ⌘K was pressed. A query with no hit says so instead of
 * showing a stale list.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { easeOut, fadeUp, scaleIn } from '@/lib/motion';
import { PDF_CATEGORIES, TOOL_CATALOGUE, canonicalToolId } from '@/lib/pdf/tools/registry';
import type { PdfToolDefinition } from '@/lib/pdf/tools/types';
import { formatFileSize } from '@/lib/utils/download';
import {
  formatRelativeTime,
  useRecentFiles,
  useStarredTools,
  type RecentFileEntry,
} from '@/lib/recents';

/** One registry hit, ranked. Higher score = closer match. */
export interface PaletteHit {
  tool: PdfToolDefinition;
  score: number;
}

/**
 * One selectable row. A remembered pick is still a shortcut to a tool; the
 * `entry` only changes what the row says, so `key` has to name the file too —
 * the same tool can appear twice, starred and as a recent.
 */
export interface PaletteRow {
  key: string;
  tool: PdfToolDefinition;
  entry?: RecentFileEntry;
}

/** A labelled band of rows. `label` is empty for plain search results. */
export interface PaletteGroup {
  label: string;
  /** One muted line on the right of the heading; Recent uses it to state what
   *  is stored, which is the sentence the removed sidebar's empty state carried. */
  hint?: string;
  /** Recent only: the sidebar's "Clear" affordance moved here with the list. */
  canClear?: boolean;
  rows: PaletteRow[];
}

/** Results are capped: a 130-tool registry must not fill the screen. */
export const PALETTE_LIMIT = 12;

/** How much each field is worth when several of them match. */
const FIELD_WEIGHT = { name: 1, keyword: 0.72, category: 0.55 } as const;

const WORD_BOUNDARY = /[\s\-_/·(]/;

/** Candidate tab stops inside the dialog. Rows opt out with `tabIndex={-1}` —
 *  the listbox is driven by `aria-activedescendant`, not by real focus — and the
 *  `tabIndex` filter is what honours that, because a `button[tabindex="-1"]`
 *  still matches the bare `button` part of the selector. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])';

function clean(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Subsequence-aware fuzzy score for one haystack.
 *
 * A contiguous hit outranks a scattered one, a hit at a word boundary outranks
 * one mid-word, and gaps cost — which is what puts "Merge PDF" above
 * "Remove duplicates" for `mrg`. Returns `null` when the characters of the
 * query do not appear in order at all.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = clean(query);
  const t = clean(text);
  if (!q) return 0;
  if (!t) return null;

  const direct = t.indexOf(q);
  if (direct >= 0) {
    const atBoundary = direct === 0 || WORD_BOUNDARY.test(t[direct - 1] ?? '');
    return 100 - direct * 2 + (atBoundary ? 30 : 0);
  }

  let cursor = 0;
  let gaps = 0;
  let boundaries = 0;
  for (const char of q) {
    if (char === ' ') continue;
    const at = t.indexOf(char, cursor);
    if (at < 0) return null;
    gaps += at - cursor;
    if (at === 0 || WORD_BOUNDARY.test(t[at - 1] ?? '')) boundaries += 1;
    cursor = at + 1;
  }
  // Below the contiguous band, but still ordered by tightness.
  return 40 - gaps + boundaries * 4;
}

function categoryLabel(tool: PdfToolDefinition): string {
  return PDF_CATEGORIES.find((entry) => entry.id === tool.category)?.label ?? tool.category;
}

/** Rank the registry for one query. Empty query means "no search yet". */
export function searchPalette(
  query: string,
  tools: readonly PdfToolDefinition[] = TOOL_CATALOGUE,
  limit: number = PALETTE_LIMIT,
): PaletteHit[] {
  const q = clean(query);
  if (!q) return [];

  const hits: PaletteHit[] = [];
  for (const tool of tools) {
    const name = fuzzyScore(q, tool.name);
    const keyword = (tool.keywords ?? [])
      .map((word) => fuzzyScore(q, word))
      .reduce<number | null>((best, score) => (score === null ? best : Math.max(best ?? 0, score)), null);
    const category = fuzzyScore(q, `${categoryLabel(tool)} ${tool.category}`);

    const scores = [
      name === null ? null : name * FIELD_WEIGHT.name,
      keyword === null ? null : keyword * FIELD_WEIGHT.keyword,
      category === null ? null : category * FIELD_WEIGHT.category,
    ].filter((score): score is number => score !== null);
    if (scores.length === 0) continue;
    hits.push({ tool, score: Math.max(...scores) });
  }

  hits.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
  return hits.slice(0, limit);
}

function toolRow(tool: PdfToolDefinition): PaletteRow {
  return { key: `tool:${tool.id}`, tool };
}

function fileRow(entry: RecentFileEntry, tool: PdfToolDefinition): PaletteRow {
  return { key: `file:${entry.toolId}:${entry.name}:${entry.size}`, tool, entry };
}

/**
 * Look up a row's tool by the id something else remembered.
 *
 * Stars and recents were written by whichever URL the visitor used, aliases
 * included, so a remembered `redact` has to surface the tool that owns redaction
 * rather than be dropped as unknown.
 */
function toolById(tools: readonly PdfToolDefinition[]): (id: string) => PdfToolDefinition | undefined {
  const byId = new Map(tools.map((tool) => [tool.id, tool]));
  return (id: string) => byId.get(canonicalToolId(id));
}

/** The last picked files, newest first, one row per file, unknown tools dropped. */
function recentRows(entries: readonly RecentFileEntry[], tools: readonly PdfToolDefinition[]): PaletteRow[] {
  const find = toolById(tools);
  const rows: PaletteRow[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const tool = find(entry.toolId);
    if (!tool) continue;
    const row = fileRow(entry, tool);
    if (seen.has(row.key)) continue;
    seen.add(row.key);
    rows.push(row);
  }
  return rows;
}

/**
 * What an empty query shows: Starred, then Recent, then a browse slice of
 * everything else. The budget is shared and earlier bands win, so a wall of
 * stars cannot push the rest off the screen.
 */
function defaultGroups(
  tools: readonly PdfToolDefinition[],
  starredIds: readonly string[],
  entries: readonly RecentFileEntry[],
  limit: number = PALETTE_LIMIT,
): PaletteGroup[] {
  const find = toolById(tools);
  const starred = starredIds
    .map((id) => find(id))
    .filter((tool): tool is PdfToolDefinition => Boolean(tool))
    .map(toolRow);
  const recent = recentRows(entries, tools);
  const already = new Set([...starred, ...recent].map((row) => row.tool.id));
  const rest = tools
    .filter((tool) => !already.has(tool.id))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(toolRow);

  const groups: PaletteGroup[] = [
    { label: 'Starred', rows: starred },
    { label: 'Recent', hint: 'name + size only, never contents', canClear: true, rows: recent },
    { label: 'All tools', rows: rest },
  ];

  let budget = limit;
  return groups
    .map((group) => {
      const rows = group.rows.slice(0, budget);
      budget -= rows.length;
      return { ...group, rows };
    })
    .filter((group) => group.rows.length > 0);
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  /** Inject the catalogue slice in tests; the app always searches everything it shows. */
  tools?: readonly PdfToolDefinition[];
}

/** The palette dialog. Mounted by the layout so ⌘K works on every route. */
export function CommandPalette({ open, onClose, tools = TOOL_CATALOGUE }: CommandPaletteProps) {
  const navigate = useNavigate();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  // Live views of the shell's two memories, so stars added from a tool header
  // and files picked while the palette is open show up without a reload.
  const { starred, isStarred } = useStarredTools();
  const { recents, clear: clearRecents } = useRecentFiles();

  // `onClose` is an inline arrow at the call site; hold it in a ref so a parent
  // re-render cannot re-run the focus effect (which would steal focus from the
  // row or field the user just moved to).
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  const groups = useMemo<PaletteGroup[]>(() => {
    if (!open) return [];
    if (clean(query)) {
      const hits = searchPalette(query, tools);
      return hits.length === 0 ? [] : [{ label: '', rows: hits.map((hit) => toolRow(hit.tool)) }];
    }
    return defaultGroups(tools, starred, recents);
  }, [open, query, tools, starred, recents]);
  const rows = useMemo(() => groups.flatMap((group) => group.rows), [groups]);

  // A new query means a new first result; a closed palette forgets the old query.
  useEffect(() => {
    setActive(0);
  }, [query, open]);

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  // Open: remember what to give focus back, take focus ourselves, trap Tab.
  // Close (cleanup): hand focus to the opener if it is still on the page.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();

    const onDocKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const stops = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (node) => node.tabIndex >= 0,
      );
      if (stops.length === 0) {
        event.preventDefault();
        return;
      }
      const first = stops[0] as HTMLElement;
      const last = stops[stops.length - 1] as HTMLElement;
      const current = document.activeElement;
      // Inside the panel, let the browser walk normally; at either edge — or
      // outside it entirely — wrap back in.
      if (current === null || !panel.contains(current)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && current === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onDocKey, true);
    return () => {
      window.removeEventListener('keydown', onDocKey, true);
      // `body` is what jsdom and a mouse-less keypress leave behind; focusing it
      // again would land the user at the top of the page rather than on the
      // control they came from.
      if (opener && opener !== document.body && opener.isConnected) opener.focus();
    };
  }, [open]);

  // A band can disappear under the caret — clearing recents while row 7 of 12
  // was active must not leave `aria-activedescendant` pointing at nothing.
  useEffect(() => {
    setActive((i) => Math.min(i, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  // Clearing the Recent band unmounts the button that was clicked; without
  // pulling focus back to the field the keyboard would lose its handle on the
  // palette mid-task.
  const clearFiles = () => {
    clearRecents();
    inputRef.current?.focus();
  };

  // Keep the active row in view when the keyboard walks past the fold.
  useEffect(() => {
    if (!open || typeof HTMLElement === 'undefined') return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-palette-index="${active}"]`);
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [active, open]);

  const choose = (row: PaletteRow | undefined) => {
    if (!row) return;
    navigate(`/tool/${row.tool.id}`);
    closeRef.current();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (rows.length > 0) setActive((i) => (i + 1) % rows.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (rows.length > 0) setActive((i) => (i - 1 + rows.length) % rows.length);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActive(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActive(Math.max(0, rows.length - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(rows[active]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
    }
  };

  let flatIndex = -1;

  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
        >
          <div className="shell-scrim absolute inset-0" onClick={() => closeRef.current()} aria-hidden="true" />
          <motion.div
            ref={panelRef}
            id="command-palette"
            role="dialog"
            aria-modal="true"
            aria-label="Search tools"
            className="palette-panel relative w-full max-w-xl"
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={easeOut}
          >
            <div className="flex items-center gap-2.5 px-3.5 py-3">
              <span aria-hidden="true" className="shell-muted text-sm">
                ⌕
              </span>
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onKeyDown}
                role="combobox"
                aria-expanded="true"
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={rows[active] ? `${listId}-${active}` : undefined}
                placeholder="Search tools by name, keyword or category…"
                autoComplete="off"
                spellCheck={false}
                aria-label="Search tools"
                className="palette-field"
              />
              <span className="shell-kbd hidden sm:inline-flex">esc</span>
            </div>

            <div
              id={listId}
              ref={listRef}
              role="listbox"
              aria-label="Matching tools"
              className="palette-list max-h-80"
            >
              {rows.length === 0 && (
                <p role="status" className="px-4 py-8 text-center text-xs">
                  <span className="shell-title font-semibold">No tools match “{query.trim()}”.</span>{' '}
                  <span className="shell-muted">
                    Try a category — organize, optimize, convert-to, convert-from, edit, security.
                  </span>
                </p>
              )}

              {groups.map((group) => (
                <div key={group.label || 'results'}>
                  {group.label && (
                    <div className="flex items-baseline gap-2 px-3 pb-1 pt-2.5">
                      <p
                        data-palette-group={group.label}
                        className="shell-muted shrink-0 text-[10px] font-semibold uppercase tracking-[0.12em]"
                      >
                        {group.label}
                      </p>
                      {group.hint && <span className="shell-meta min-w-0 truncate">{group.hint}</span>}
                      {group.canClear && (
                        <button
                          type="button"
                          onClick={clearFiles}
                          className="shell-link ml-auto shrink-0 text-[10px]"
                          aria-label="Clear recent files"
                          title="Forget every remembered file name. Stars are a separate decision and stay."
                        >
                          Clear
                        </button>
                      )}
                    </div>
                  )}
                  {group.rows.map((row) => {
                    flatIndex += 1;
                    const index = flatIndex;
                    const isActive = index === active;
                    const isRecent = Boolean(row.entry);
                    return (
                      <motion.button
                        key={row.key}
                        type="button"
                        id={`${listId}-${index}`}
                        data-palette-index={index}
                        role="option"
                        aria-selected={isActive}
                        tabIndex={-1}
                        variants={fadeUp}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => choose(row)}
                        onMouseMove={() => setActive(index)}
                        title={
                          row.entry
                            ? `${row.entry.name} — opens ${row.tool.name} again. Only the name and size are remembered; the file itself is never stored.`
                            : row.tool.description
                        }
                        className={`palette-item ${isActive ? 'palette-item-active' : ''}`}
                      >
                        <span className="palette-icon" aria-hidden="true">
                          {row.tool.icon}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-semibold">
                            {isRecent ? row.entry?.name : row.tool.name}
                          </span>
                          <span className={`block truncate text-[11px] ${isActive ? '' : 'shell-muted'}`}>
                            {isRecent
                              ? `${row.tool.name} · ${formatFileSize(row.entry?.size ?? 0)} · ${formatRelativeTime(row.entry?.at ?? 0)}`
                              : row.tool.description}
                          </span>
                        </span>
                        {!isRecent && isStarred(row.tool.id) && (
                          <span aria-hidden="true" className="shell-accent shrink-0 text-[11px]">
                            ★
                          </span>
                        )}
                        <span className="shell-meta shrink-0">{categoryLabel(row.tool)}</span>
                      </motion.button>
                    );
                  })}
                </div>
              ))}
            </div>

            <div className="shell-hairline-t flex items-center gap-3 px-3.5 py-2">
              <span className="shell-meta flex items-center gap-1">
                <span aria-hidden="true" className="shell-kbd">
                  ↑↓
                </span>
                move
              </span>
              <span className="shell-meta flex items-center gap-1">
                <span aria-hidden="true" className="shell-kbd">
                  ⏎
                </span>
                open
              </span>
              <span className="shell-meta flex items-center gap-1">
                <span aria-hidden="true" className="shell-kbd">
                  esc
                </span>
                close
              </span>
              <span className="flex-1" />
              <motion.span
                aria-hidden
                variants={scaleIn}
                initial="hidden"
                animate="visible"
                className="shell-meta"
              >
                {tools.length} tools
              </motion.span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
