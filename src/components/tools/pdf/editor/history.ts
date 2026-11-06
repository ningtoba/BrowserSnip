/**
 * The editor's undo/redo stack.
 *
 * It stores whole annotation lists rather than deltas: the list is small, the
 * edits are varied (geometry, per-keystroke text, image payloads), and a
 * snapshot stack cannot drift the way per-field inverse operations do.
 *
 * Two entry points matter for gestures:
 * * `pushHistory` — one discrete edit (draw, delete, one keystroke).
 * * `liveHistory` + `settleHistory` — a drag updates `present` without writing
 *   history, and the pre-drag list is recorded once on mouse-up, so a 200px
 *   drag is a single undo step instead of 200.
 */

export interface HistoryState<T> {
  /** Older states, oldest first. */
  past: T[];
  present: T;
  /** Redo branch, next state first. */
  future: T[];
}

/** Bound the stack so a long typing session cannot grow memory without end. */
export const MAX_HISTORY = 120;

export function createHistory<T>(present: T): HistoryState<T> {
  return { past: [], present, future: [] };
}

/** Record `present` as an undo point and make `next` current. */
export function pushHistory<T>(history: HistoryState<T>, next: T): HistoryState<T> {
  if (Object.is(next, history.present)) return history;
  return {
    past: [...history.past, history.present].slice(-MAX_HISTORY),
    present: next,
    future: [],
  };
}

/** In-progress value: no undo point yet, and a new edit drops the redo branch. */
export function liveHistory<T>(history: HistoryState<T>, next: T): HistoryState<T> {
  return { past: history.past, present: next, future: [] };
}

/** Close a live gesture by recording the state it started from. */
export function settleHistory<T>(history: HistoryState<T>, before: T): HistoryState<T> {
  if (Object.is(before, history.present)) return history;
  return {
    past: [...history.past, before].slice(-MAX_HISTORY),
    present: history.present,
    future: [],
  };
}

export function undoHistory<T>(history: HistoryState<T>): HistoryState<T> {
  if (history.past.length === 0) return history;
  const present = history.past[history.past.length - 1];
  return {
    past: history.past.slice(0, -1),
    present,
    future: [history.present, ...history.future].slice(0, MAX_HISTORY),
  };
}

export function redoHistory<T>(history: HistoryState<T>): HistoryState<T> {
  if (history.future.length === 0) return history;
  const present = history.future[0];
  return {
    past: [...history.past, history.present].slice(-MAX_HISTORY),
    present,
    future: history.future.slice(1),
  };
}

export function canUndo<T>(history: HistoryState<T>): boolean {
  return history.past.length > 0;
}

export function canRedo<T>(history: HistoryState<T>): boolean {
  return history.future.length > 0;
}
