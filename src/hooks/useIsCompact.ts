/**
 * The breakpoint hooks for the shell and the workspace.
 *
 * `ToolWorkspace` used to render the mobile branch and the desktop branch at the
 * same time, separated only by `sm:hidden` CSS. Every mounted tool therefore had
 * two sets of React state, two DOM ids, two pdf.js documents and two global
 * keydown listeners — which is why one Backspace in the redaction editor deleted
 * two boxes, and why the header "Process" button (a `getElementById` proxy)
 * always used the hidden sidebar's parameters. Rendering one branch fixes all of
 * that at once.
 *
 * `useMediaQuery` is the shared primitive: one listener per query, a value that
 * is correct on the first render, and a safe `false` when the host has no
 * `matchMedia` (jsdom without a stub, a worker, a server render) so a component
 * never crashes just to ask how wide it is.
 */
import { useEffect, useState } from 'react';

/** Phone-width layout: one pane, controls stacked under the preview. */
export const COMPACT_QUERY = '(max-width: 639px)';

/** Wide enough for the persistent tool rail (categories, recents, stars). */
export const RAIL_QUERY = '(min-width: 1024px)';

function matches(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

export function useMediaQuery(query: string): boolean {
  const [active, setActive] = useState(() => matches(query));

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    // The viewport can change between the first render and this effect.
    setActive(list.matches);
    const onChange = (event: MediaQueryListEvent) => setActive(event.matches);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);

  return active;
}

export function useIsCompact(): boolean {
  return useMediaQuery(COMPACT_QUERY);
}

/** Whether there is room for the sidebar rail instead of the drawer. */
export function useHasRail(): boolean {
  return useMediaQuery(RAIL_QUERY);
}
