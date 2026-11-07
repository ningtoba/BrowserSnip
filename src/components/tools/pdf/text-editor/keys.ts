/**
 * The text editor's keyboard vocabulary.
 *
 * The annotation editor arms *pens* with V H T P; this editor has three modes
 * instead (point, place text, place picture), so the same letters cannot mean
 * the same thing on both surfaces. Rather than invent keys, the table below is
 * generated from the map the handler actually consults — `TEXT_MODE_KEYS` — and
 * every other row is a key `TextEditor.tsx` already binds. The shortcut panel
 * prints this table, so a documented key is a bound key.
 *
 * Typing always wins: `TextEditor` runs every one of these through
 * `isTypingTarget` from `editor/shortcuts`, which is also what the in-place
 * `contenteditable` paragraph relies on for "the” key and Ctrl-Z inside a word.
 */
import type { Shortcut } from '@/components/tools/pdf/editor/shortcuts';
import type { ToolMode } from './model';

/** Bare key → mode it arms. `v` is the arrow, `t`/`i` place new content. */
export const TEXT_MODE_KEYS: Record<string, ToolMode> = {
  v: 'edit',
  t: 'add-text',
  i: 'add-image',
};

const MODE_LABELS: Record<ToolMode, string> = {
  edit: 'Point and select',
  'add-text': 'Place a new text box',
  'add-image': 'Place a picture',
};

/** The mode a bare key arms, or `null` when the key arms nothing. */
export function textModeForKey(key: string): ToolMode | null {
  if (typeof key !== 'string') return null;
  const normalised = key.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(TEXT_MODE_KEYS, normalised)
    ? TEXT_MODE_KEYS[normalised]
    : null;
}

/** Reverse lookup for the badge on a mode button. */
export function keyForMode(mode: ToolMode): string | null {
  for (const [key, value] of Object.entries(TEXT_MODE_KEYS)) {
    if (value === mode) return key.toUpperCase();
  }
  return null;
}

/**
 * Whether a mode keeps placing or hands control back, declared per mode —
 * EmbedPDF's `afterCreate` vocabulary, as the brief's pin ruling requires.
 * `edit` is the resting tool, so it "stays"; the two placement modes step aside
 * unless pinned. Sticky-versus-one-shot is never decided by which handler returns
 * first, and `stepsAside` is the only reader.
 */
export const MODE_AFTER_CREATE: Record<ToolMode, 'stay' | 'default'> = {
  edit: 'stay',
  'add-text': 'default',
  'add-image': 'default',
};

export function stepsAside(mode: ToolMode, pinned: boolean): boolean {
  return !pinned && MODE_AFTER_CREATE[mode] === 'default';
}

/** Mode keys first (generated), then the fixed bindings of this editor. */
export const TEXT_EDITOR_SHORTCUTS: Shortcut[] = [
  ...(Object.keys(TEXT_MODE_KEYS) as (keyof typeof TEXT_MODE_KEYS)[]).map((key) => ({
    keys: [key.toUpperCase()],
    label: MODE_LABELS[TEXT_MODE_KEYS[key]],
    group: 'tools' as const,
  })),
  { keys: ['Enter'], label: 'Edit the selected block', group: 'blocks' },
  { keys: ['Double-click'], label: 'Edit the block under the cursor', group: 'blocks' },
  { keys: ['Any', 'letter'], label: 'Type over a selected block to edit it', group: 'blocks' },
  { keys: ['Ctrl', 'D'], label: 'Duplicate the selected block', group: 'blocks' },
  { keys: ['Ctrl', 'F'], label: 'Find and replace across pages', group: 'blocks' },
  { keys: ['Esc'], label: 'Stop editing, then close Find, then deselect, then unpin, then drop the tool', group: 'blocks' },
  { keys: ['Delete'], label: 'Remove the selected block', group: 'blocks' },
  { keys: ['Ctrl', 'Z'], label: 'Undo the last committed edit', group: 'blocks' },
  { keys: ['Ctrl', 'Shift', 'Z'], label: 'Re-apply the edit just undone', group: 'blocks' },
  { keys: ['Ctrl', 'Y'], label: 'Redo, the Windows way', group: 'blocks' },
  { keys: ['←', '→'], label: 'Nudge the selected block 1 pt (Shift: 10 pt)', group: 'blocks' },
  { keys: ['↑', '↓'], label: 'Resize a focused handle 1 pt (Shift: 10 pt)', group: 'blocks' },
  { keys: ['Ctrl', 'S'], label: 'Export the edited PDF, committing the open block first', group: 'pages' },
];

/**
 * The one thing `Esc` does at each level, per the brief: unwind a single step,
 * in the order the pin ruling fixes — dismiss the in-progress edit, then clear
 * the selection, then unpin, then disarm the tool. Find sits between the edit
 * and the selection because an open panel is the more transient layer.
 */
export interface EscapeState {
  editing: boolean;
  findOpen: boolean;
  selected: number;
  pinned: boolean;
  mode: ToolMode;
}

export type EscapeStep = 'commit-edit' | 'close-find' | 'clear-selection' | 'unpin' | 'disarm' | 'idle';

export function nextEscapeStep(state: EscapeState): EscapeStep {
  if (state.editing) return 'commit-edit';
  if (state.findOpen) return 'close-find';
  if (state.selected > 0) return 'clear-selection';
  if (state.pinned) return 'unpin';
  if (state.mode !== 'edit') return 'disarm';
  return 'idle';
}

/** What assistive tech hears for each step, so an unwinding Esc is not silence. */
export const ESCAPE_STEP_REPORT: Record<EscapeStep, string> = {
  'commit-edit': 'Stopped editing; the block keeps what you typed.',
  'close-find': 'Closed Find and replace.',
  'clear-selection': 'Deselected.',
  unpin: 'Unpinned the tool; it steps back to Edit after one placement.',
  disarm: 'Back to the Edit tool.',
  idle: 'Nothing to step back from.',
};

/**
 * Whether a keystroke should hijack a selected block into edit mode instead of
 * reaching the global table. A single printable key with no Ctrl/Alt/Meta is
 * typing; `v`, `t` and `i` must not change the tool while the user is trying to
 * retype the words they just selected.
 */
export function typingStartsEdit(
  key: string,
  modifiers: { ctrl?: boolean; meta?: boolean; alt?: boolean },
  context: { editing?: boolean; textSelected?: boolean } = {},
): boolean {
  if (context.editing || !context.textSelected) return false;
  if (modifiers.ctrl || modifiers.meta || modifiers.alt) return false;
  return typeof key === 'string' && key.length === 1;
}

