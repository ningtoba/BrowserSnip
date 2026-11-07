/**
 * The one focus-ring spelling for the shared rail.
 *
 * The sidebar is gone, so this column is the whole chrome: every control in it
 * is reached by `Tab` on the way to the primary action. `doodle-btn` and
 * `doodle-chip` only ever had the browser default outline, which is hard to see
 * on a cream panel, and `.doodle-input` replaces its outline with a box-shadow.
 * `outline-*` utilities are used here rather than `ring-*` so the ring never
 * overwrites a component's own `box-shadow`.
 *
 * `focus-visible` only: a mouse click keeps its quiet focus, a keyboard tab
 * does not. The colour is the shell's own `--accent`, which `html.dark` re-points
 * at the brighter blue — so the ring stays visible on a dark panel without a
 * second value here, and no new hex enters the components.
 */
export const FOCUS_RING =
  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)]';
