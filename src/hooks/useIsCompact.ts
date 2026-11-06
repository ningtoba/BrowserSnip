/**
 * The single-pane media query hook.
 *
 * `ToolWorkspace` used to render the mobile branch and the desktop branch at the
 * same time, separated only by `sm:hidden` CSS. Every mounted tool therefore had
 * two sets of React state, two DOM ids, two pdf.js documents and two global
 * keydown listeners — which is why one Backspace in the redaction editor deleted
 * two boxes, and why the header "Process" button (a `getElementById` proxy)
 * always used the hidden sidebar's parameters. Rendering one branch fixes all of
 * that at once.
 */
import { useEffect, useState } from 'react';

export const COMPACT_QUERY = '(max-width: 639px)';

export function useIsCompact(): boolean {
  const [compact, setCompact] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(COMPACT_QUERY).matches,
  );

  useEffect(() => {
    const list = window.matchMedia(COMPACT_QUERY);
    const onChange = (event: MediaQueryListEvent) => setCompact(event.matches);
    setCompact(list.matches);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, []);

  return compact;
}
