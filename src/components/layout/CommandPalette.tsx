/**
 * ⌘K / Ctrl-K command palette over the PDF tool registry.
 *
 * The dashboard's filter box only sees the category it renders; this is the
 * one place that knows every tool. Queries are matched fuzzily against
 * **name, keywords and category** — the three things the registry stores for
 * discovery — so `mrg` finds *Merge PDF*, `sign` also finds the editor tools
 * that carry it as a keyword, and `security` finds the whole category.
 *
 * Keyboard-only by intent: the palette exists so a run does not interrupt
 * typing. `↓`/`↑` (and Home/End) move the active row, `Enter` navigates,
 * `Esc` closes, and typing again resets to the first result. A query with no
 * hit says so instead of showing a stale list.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { easeOut, fadeUp, scaleIn, tapDown } from '@/lib/motion';
import { PDF_CATEGORIES, PDF_TOOLS } from '@/lib/pdf/tools/registry';
import type { PdfToolDefinition } from '@/lib/pdf/tools/types';
import { isToolStarred, readRecentFiles } from '@/lib/recents';

/** One registry hit, ranked. Higher score = closer match. */
export interface PaletteHit {
  tool: PdfToolDefinition;
  score: number;
}

/** Results are capped: a 130-tool registry must not fill the screen. */
export const PALETTE_LIMIT = 12;

/** How much each field is worth when several of them match. */
const FIELD_WEIGHT = { name: 1, keyword: 0.72, category: 0.55 } as const;

const WORD_BOUNDARY = /[\s\-_/·(]/;

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
  tools: readonly PdfToolDefinition[] = PDF_TOOLS,
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

/** Starred first, then the tools behind the last picked files, then the rest. */
function defaultHits(
  tools: readonly PdfToolDefinition[],
  limit: number = PALETTE_LIMIT,
): { label: string; hits: PaletteHit[] }[] {
  const byId = new Map(tools.map((tool) => [tool.id, tool]));
  const take = (ids: string[]) =>
    ids.map((id) => byId.get(id)).filter((tool): tool is PdfToolDefinition => Boolean(tool));

  const starred = tools.filter((tool) => isToolStarred(tool.id));
  const recentToolIds: string[] = [];
  for (const entry of readRecentFiles()) {
    if (!recentToolIds.includes(entry.toolId)) recentToolIds.push(entry.toolId);
  }
  const recent = take(recentToolIds);

  const seen = new Set<string>([...starred, ...recent].map((tool) => tool.id));
  const groups: { label: string; hits: PaletteHit[] }[] = [];
  const push = (label: string, list: PdfToolDefinition[]) => {
    const fresh = list.filter((tool) => !seen.has(tool.id));
    if (fresh.length === 0) return;
    for (const tool of fresh) seen.add(tool.id);
    groups.push({
      label,
      hits: fresh.slice(0, limit).map((tool) => ({ tool, score: 0 })),
    });
  };

  push('Starred', starred);
  push('Recent tools', recent);
  push('All tools', [...tools].sort((a, b) => a.name.localeCompare(b.name)));

  const flat = groups.flatMap((group) => group.hits);
  if (flat.length <= limit) return groups;
  let budget = limit;
  return groups
    .map((group) => {
      const slice = group.hits.slice(0, budget);
      budget -= slice.length;
      return { ...group, hits: slice };
    })
    .filter((group) => group.hits.length > 0);
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  /** Inject the registry slice in tests; the app always searches everything. */
  tools?: readonly PdfToolDefinition[];
}

/** The palette dialog. Mounted by the layout so ⌘K works on every route. */
export function CommandPalette({ open, onClose, tools = PDF_TOOLS }: CommandPaletteProps) {
  const navigate = useNavigate();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const groups = useMemo(
    () => (open ? (clean(query) ? [{ label: '', hits: searchPalette(query, tools) }] : defaultHits(tools)) : []),
    [open, query, tools],
  );
  const items = useMemo(() => groups.flatMap((group) => group.hits), [groups]);

  // A new query means a new first result; a closed palette forgets the old query.
  useEffect(() => {
    setActive(0);
  }, [query, open]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onDocKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onDocKey);
    return () => window.removeEventListener('keydown', onDocKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  useEffect(() => {
    if (!open || typeof HTMLElement === 'undefined') return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-palette-index="${active}"]`);
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [active, open]);

  const choose = (hit: PaletteHit | undefined) => {
    if (!hit) return;
    navigate(`/tool/${hit.tool.id}`);
    onClose();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (items.length > 0) setActive((i) => (i + 1) % items.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (items.length > 0) setActive((i) => (i - 1 + items.length) % items.length);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActive(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActive(Math.max(0, items.length - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(items[active]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
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
          <div className="shell-scrim absolute inset-0" onClick={onClose} aria-hidden="true" />
          <motion.div
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
                aria-activedescendant={items[active] ? `${listId}-${active}` : undefined}
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
              {items.length === 0 && (
                <p role="status" className="px-4 py-8 text-center text-xs">
                  <span className="shell-title font-semibold">No tools match “{query.trim()}”.</span>{' '}
                  <span className="shell-muted">
                    Try a category — organize, optimize, convert-to, convert-from, edit, security.
                  </span>
                </p>
              )}

              {groups.map((group) => (
                <div key={group.label || 'results'}>
                  {group.label && <p className="palette-group">{group.label}</p>}
                  {group.hits.map((hit) => {
                    flatIndex += 1;
                    const index = flatIndex;
                    const isActive = index === active;
                    return (
                      <motion.button
                        key={hit.tool.id}
                        type="button"
                        id={`${listId}-${index}`}
                        data-palette-index={index}
                        role="option"
                        aria-selected={isActive}
                        variants={fadeUp}
                        onClick={() => choose(hit)}
                        onMouseMove={() => setActive(index)}
                        className={`palette-item ${isActive ? 'palette-item-active' : ''}`}
                      >
                        <span className="palette-icon" aria-hidden="true">
                          {hit.tool.icon}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-semibold">{hit.tool.name}</span>
                          <span className={`block truncate text-[11px] ${isActive ? '' : 'shell-muted'}`}>
                            {hit.tool.description}
                          </span>
                        </span>
                        {isToolStarred(hit.tool.id) && (
                          <span aria-hidden="true" className="shell-accent text-[11px]">
                            ★
                          </span>
                        )}
                        <span className="shell-meta shrink-0">{categoryLabel(hit.tool)}</span>
                      </motion.button>
                    );
                  })}
                </div>
              ))}
            </div>

            <div className="shell-hairline-t flex items-center gap-3 px-3.5 py-2">
              <span className="shell-meta flex items-center gap-1">
                <motion.span aria-hidden whileTap={tapDown} className="shell-kbd">
                  ↑↓
                </motion.span>
                move
              </span>
              <span className="shell-meta flex items-center gap-1">
                <motion.span aria-hidden whileTap={tapDown} className="shell-kbd">
                  ⏎
                </motion.span>
                open
              </span>
              <span className="shell-meta flex items-center gap-1">
                <motion.span aria-hidden whileTap={tapDown} className="shell-kbd">
                  esc
                </motion.span>
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
