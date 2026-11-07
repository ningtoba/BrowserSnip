/**
 * Recent files and starred tools — the shell's two pieces of memory.
 *
 * Both live in `localStorage` under namespaced keys (`browsersnip:…`, matching
 * `ENGINE_STORAGE_KEY` in `engines/provider.ts`) and both hold **metadata only**:
 * a recent entry is a name, a byte count, the tool it was opened with and a
 * timestamp. File contents never enter storage, because the whole promise of the
 * app is that a document stays inside this tab — serialising bytes here would
 * silently turn a 40 MB scan into a base64 string in persistent storage and put
 * the document on disk for anyone with the machine.
 *
 * Everything is defensive on read: a malformed, hand-edited or older-shaped
 * entry is dropped rather than thrown on, and both lists are re-capped on the
 * way out so a bloated store cannot make the palette's Recent band unscrollable.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

/** Namespaced storage keys. */
export const RECENT_FILES_KEY = 'browsersnip:recent-files:v1';
export const STARRED_TOOLS_KEY = 'browsersnip:starred-tools:v1';

/** How many files the palette remembers before the oldest falls off. */
export const RECENT_FILES_CAP = 12;

/** How many tools may be starred; the oldest entries stop being recorded past this. */
export const STARRED_TOOLS_CAP = 24;

/** One remembered pick. Deliberately has no way to carry file contents. */
export interface RecentFileEntry {
  name: string;
  size: number;
  toolId: string;
  /** `Date.now()` at the moment it was recorded. */
  at: number;
}

/**
 * The minimum a caller must offer. A real `File` satisfies it, and so does a
 * plain object — nothing here ever reads `File.text()`, `arrayBuffer()` or
 * `stream()`, which is what keeps contents out of storage.
 */
export interface FileMetadataSource {
  name: string;
  size: number;
}

type Listener = () => void;

const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** Re-render whenever recents or stars change, here or in another tab. */
export function subscribeShellMemory(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Private mode / blocked storage: the shell still works, it just forgets.
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {
    // Quota exceeded is not worth surfacing for a convenience list.
  }
}

function readList(key: string): unknown[] {
  const raw = storage()?.getItem(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isEntry(value: unknown): value is RecentFileEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<RecentFileEntry>;
  return (
    typeof entry.name === 'string' &&
    entry.name !== '' &&
    typeof entry.size === 'number' &&
    Number.isFinite(entry.size) &&
    entry.size >= 0 &&
    typeof entry.toolId === 'string' &&
    typeof entry.at === 'number' &&
    Number.isFinite(entry.at)
  );
}

/** Newest first, capped, malformed entries dropped. */
export function readRecentFiles(): RecentFileEntry[] {
  return readList(RECENT_FILES_KEY)
    .filter(isEntry)
    .map(({ name, size, toolId, at }) => ({ name, size, toolId, at }))
    .sort((a, b) => b.at - a.at)
    .slice(0, RECENT_FILES_CAP);
}

/**
 * Record the files just picked for `toolId`.
 *
 * The same file re-opened moves to the front instead of taking a second slot —
 * otherwise the list fills with repeats of whatever is being worked on.
 */
export function recordRecentFiles(
  files: readonly FileMetadataSource[],
  toolId: string,
  at: number = Date.now(),
): RecentFileEntry[] {
  const existing = readRecentFiles();
  const added: RecentFileEntry[] = [];
  for (const file of files) {
    if (!file || typeof file.name !== 'string' || file.name === '') continue;
    const size = Number.isFinite(file.size) ? file.size : 0;
    added.push({ name: file.name, size, toolId, at });
  }
  if (added.length === 0) return existing;

  const fresh = new Set(added.map((entry) => `${entry.name}::${entry.size}`));
  const merged = [...added.reverse(), ...existing.filter((e) => !fresh.has(`${e.name}::${e.size}`))];
  const next = merged.slice(0, RECENT_FILES_CAP);
  write(RECENT_FILES_KEY, next);
  emit();
  return next;
}

/** Drop every remembered file. Stars are a separate decision and stay. */
export function clearRecentFiles(): RecentFileEntry[] {
  try {
    storage()?.removeItem(RECENT_FILES_KEY);
  } catch {
    // Nothing to clear if storage is unreachable.
  }
  emit();
  return [];
}

/** Tool ids the user starred, in the order they were starred. */
export function readStarredTools(): string[] {
  return readList(STARRED_TOOLS_KEY)
    .filter((value): value is string => typeof value === 'string' && value !== '')
    .slice(0, STARRED_TOOLS_CAP);
}

export function isToolStarred(toolId: string): boolean {
  return readStarredTools().includes(toolId);
}

/** Add or remove a tool id; returns the list after the change. */
export function toggleStarredTool(toolId: string): string[] {
  const current = readStarredTools();
  const next = current.includes(toolId)
    ? current.filter((id) => id !== toolId)
    : [...current, toolId].slice(0, STARRED_TOOLS_CAP);
  write(STARRED_TOOLS_KEY, next);
  emit();
  return next;
}

/** `5 min ago` / `3 days ago` — the palette's recent rows show age, not a wall of timestamps. */
export function formatRelativeTime(at: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} mo ago`;
  return `${Math.round(months / 12)} yr ago`;
}

/** Live view of recent files, for the palette's Recent band and its Clear button. */
export function useRecentFiles(): {
  recents: RecentFileEntry[];
  clear: () => void;
} {
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const refresh = () => setRevision((r) => r + 1);
    const unsubscribe = subscribeShellMemory(refresh);
    // Another tab writing the same key is the other way this can change.
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === RECENT_FILES_KEY) refresh();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      unsubscribe();
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const recents = useMemo(() => readRecentFiles(), [revision]);
  const clear = useCallback(() => clearRecentFiles(), []);

  return { recents, clear };
}

/** Live view of starred tools, with the toggle the palette and the tool header share. */
export function useStarredTools(): {
  starred: string[];
  isStarred: (toolId: string) => boolean;
  toggle: (toolId: string) => void;
} {
  const [revision, setRevision] = useState(0);

  useEffect(() => subscribeShellMemory(() => setRevision((r) => r + 1)), []);

  const starred = useMemo(() => readStarredTools(), [revision]);
  const isStarred = useCallback((toolId: string) => starred.includes(toolId), [starred]);
  const toggle = useCallback((toolId: string) => {
    toggleStarredTool(toolId);
  }, []);

  return { starred, isStarred, toggle };
}
