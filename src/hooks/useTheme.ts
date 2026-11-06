/**
 * Class-based dark mode for the shell.
 *
 * `tailwind.config.js` already sets `darkMode: 'class'`, and `index.css` carries
 * a dark value for every token the shell touches, so all this hook has to do is
 * keep `html.dark` in step with a stored preference. Two rules are deliberate:
 *
 * - **Light is the default.** Nothing is read from `prefers-color-scheme`; a
 *   first-time visitor gets the doodle palette the design was reviewed in, and
 *   dark only appears after an explicit toggle.
 * - **The class is the source of truth on screen.** Applying it here rather than
 *   in each component means a lazily-mounted panel inherits the theme, and the
 *   preference survives a reload by re-reading storage on mount.
 */
import { useCallback, useEffect, useState } from 'react';

export type ThemeMode = 'light' | 'dark';

/** Namespaced so it cannot collide with the engine config or session stores. */
export const THEME_STORAGE_KEY = 'browsersnip:theme';

export const DARK_CLASS = 'dark';

type Listener = (mode: ThemeMode) => void;

const listeners = new Set<Listener>();

function emit(mode: ThemeMode): void {
  for (const listener of [...listeners]) listener(mode);
}

/** Subscribe to theme changes made anywhere in the app. Returns an unsubscribe. */
export function subscribeTheme(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // A storage-disabled or partitioned context still gets a working light mode.
    return null;
  }
}

/** The saved preference, or `light` when nothing valid was stored. */
export function readTheme(): ThemeMode {
  const raw = storage()?.getItem(THEME_STORAGE_KEY);
  return raw === 'dark' ? 'dark' : 'light';
}

/** Add or remove `html.dark` and persist the choice. */
export function applyTheme(mode: ThemeMode): ThemeMode {
  try {
    storage()?.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Full or blocked storage: the class still changes for this session.
  }
  if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle(DARK_CLASS, mode === 'dark');
  }
  emit(mode);
  return mode;
}

export function toggleTheme(): ThemeMode {
  return applyTheme(readTheme() === 'dark' ? 'light' : 'dark');
}

export interface UseTheme {
  theme: ThemeMode;
  isDark: boolean;
  setTheme: (mode: ThemeMode) => void;
  toggle: () => void;
}

/** Current theme plus the controls, kept in sync across every mounted consumer. */
export function useTheme(): UseTheme {
  const [theme, setThemeState] = useState<ThemeMode>(() =>
    typeof document === 'undefined' ? 'light' : readTheme(),
  );

  useEffect(() => {
    // Re-assert on mount: a component mounting after a theme change, or after
    // the document element was replaced, must not leave the wrong class behind.
    setThemeState(applyTheme(readTheme()));
    return subscribeTheme(setThemeState);
  }, []);

  const setTheme = useCallback((mode: ThemeMode) => {
    setThemeState(applyTheme(mode));
  }, []);

  const toggle = useCallback(() => {
    setThemeState(toggleTheme());
  }, []);

  return { theme, isDark: theme === 'dark', setTheme, toggle };
}
