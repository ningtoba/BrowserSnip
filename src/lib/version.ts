/**
 * Reload an open tab when a newer build is deployed.
 *
 * GitHub Pages serves the shell with `cache-control: max-age=600`, so for up to
 * ten minutes after a deploy the CDN hands out the old `index.html` — a hard
 * reload does not help, because the stale copy is not the browser's. The build
 * writes `version.json` beside the assets and bakes the same id into the bundle;
 * comparing the two is the only way a running page can know it is old.
 *
 * One reload per build, recorded in `sessionStorage`, so a page that keeps
 * failing to match cannot loop.
 */
const CHECK_AFTER_MS = 0;
const CHECK_EVERY_MS = 60_000;
const KEY = 'browsersnip.build.reloaded';

declare const __BUILD_ID__: string | undefined;

async function check(): Promise<void> {
  const mine = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : '';
  if (!mine) return;
  try {
    const answer = await fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!answer.ok) return;
    const { id } = (await answer.json()) as { id?: string };
    if (!id || id === mine) return;
    // Already reloaded for this id and still running it? Leave the tab alone;
    // something else is wrong and a reload loop would hide it.
    reloadForBuild(id);
  } catch {
    // Offline, or a host without the file: the page keeps working as it is.
  }
}

/**
 * Reload once for a build id, or report that this one already reloaded.
 *
 * Shared by the watcher below and the error boundary's stale-chunk path so the
 * two cannot fight: whoever gets there first marks the id, and a page that keeps
 * failing leaves the tab alone instead of spinning.
 */
export function reloadForBuild(id: string): boolean {
  try {
    if (id && sessionStorage.getItem(KEY) === id) return false;
    if (id) sessionStorage.setItem(KEY, id);
  } catch { /* private mode */ }
  location.reload();
  return true;
}

/** Start watching, once per document. */
export function watchForNewBuild(): void {
  if (typeof window === 'undefined' || !import.meta.env.PROD) return;
  window.setTimeout(() => {
    void check();
    window.setInterval(() => void check(), CHECK_EVERY_MS);
  }, CHECK_AFTER_MS);
  // Coming back to the tab is the moment someone would look at a fix: ask again
  // rather than wait for the next interval.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void check();
  });
  window.addEventListener('focus', () => void check());
}
