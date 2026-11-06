/**
 * The editors' keyboard vocabulary.
 *
 * Two rules keep the table and the handlers from drifting apart:
 *
 * 1. A key only reaches a command when the user is *not* typing. `isTypingTarget`
 *    is the single test for that, shared by both editors, because "press T and
 *    the pen changes" must not fire while a sticky note is being written.
 * 2. `EDITOR_SHORTCUTS` is the data behind the shortcut list in the inspector,
 *    so what is displayed is what is bound. The rows are phrased as actions
 *    ("Arm the highlighter") rather than tool labels, so a screen reader does
 *    not hear "Highlight, Highlight" and a `getByText('Highlight')` query in the
 *    palette stays unambiguous.
 */
import type { EditorToolId } from './types';

export type ShortcutGroup = 'tools' | 'marks' | 'blocks' | 'pages';

export interface Shortcut {
  /** Display form, one entry per key — `['Ctrl', 'Z']` renders as Ctrl Z. */
  keys: string[];
  /** What the key does, phrased as an action. */
  label: string;
  group: ShortcutGroup;
}

/**
 * Single-key tool arms. Letters spell the tool where English allows it
 * (V select, H highlight, T text, P pen) and match the ink/mouse/paper icons the
 * palette shows.
 */
export const TOOL_SHORTCUT_KEYS: Record<string, EditorToolId> = {
  v: 'select',
  h: 'highlight',
  t: 'freetext',
  p: 'ink',
};

/** The tool a bare key arms, or `null` when the key arms nothing. */
export function toolForKey(key: string): EditorToolId | null {
  if (typeof key !== 'string') return null;
  const normalised = key.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(TOOL_SHORTCUT_KEYS, normalised)
    ? TOOL_SHORTCUT_KEYS[normalised]
    : null;
}

/** Reverse of `toolForKey`, for the badge drawn on a palette button. */
export function keyForTool(tool: EditorToolId): string | null {
  for (const [key, value] of Object.entries(TOOL_SHORTCUT_KEYS)) {
    if (value === tool) return key.toUpperCase();
  }
  return null;
}

/** Every bound key, in the order the inspector lists them. */
export const EDITOR_SHORTCUTS: Shortcut[] = [
  { keys: ['V'], label: 'Pick the selection arrow', group: 'tools' },
  { keys: ['H'], label: 'Arm the highlighter', group: 'tools' },
  { keys: ['T'], label: 'Arm the text box', group: 'tools' },
  { keys: ['P'], label: 'Arm the pen', group: 'tools' },
  { keys: ['Esc'], label: 'Drop the mark being drawn', group: 'marks' },
  { keys: ['Enter'], label: 'Close a clicked shape or freeform line', group: 'marks' },
  { keys: ['Delete'], label: 'Remove the selected mark', group: 'marks' },
  { keys: ['Ctrl', 'Z'], label: 'Undo the last change', group: 'marks' },
  { keys: ['Ctrl', 'Shift', 'Z'], label: 'Re-apply the change just undone', group: 'marks' },
  { keys: ['Ctrl', 'Y'], label: 'Redo, the Windows way', group: 'marks' },
  { keys: ['←', '→'], label: 'Previous / next page', group: 'pages' },
  { keys: ['↑', '↓'], label: 'Previous / next page, the other axis', group: 'pages' },
];

export const SHORTCUT_GROUP_LABELS: Record<ShortcutGroup, string> = {
  tools: 'Tools',
  marks: 'Marks and history',
  blocks: 'Blocks and history',
  pages: 'Pages',
};

export function shortcutsFor(group: ShortcutGroup): Shortcut[] {
  return shortcutsIn(EDITOR_SHORTCUTS, group);
}

/** Same, for another surface's table: the text editor documents its own keys. */
export function shortcutsIn(rows: readonly Shortcut[], group: ShortcutGroup): Shortcut[] {
  return rows.filter((shortcut) => shortcut.group === group);
}

/** Groups present in `rows`, in table order — this is what the list renders. */
export function groupsIn(rows: readonly Shortcut[]): ShortcutGroup[] {
  const seen: ShortcutGroup[] = [];
  for (const row of rows) if (!seen.includes(row.group)) seen.push(row.group);
  return seen;
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = ['tools', 'marks', 'pages'];

/** One row of the shortcut list, as screen text: `Ctrl + Shift + Z  Re-apply…`. */
export function formatShortcutKeys(shortcut: Shortcut): string {
  return shortcut.keys.join(' + ');
}

/**
 * True when the event target owns the caret, so a shortcut must lose to the
 * user's typing. `contenteditable` covers the in-place paragraph editor; the
 * attribute is read as well because jsdom does not implement `isContentEditable`,
 * and a test that silently fails open would hide a real stuck-key bug.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as (HTMLElement & { tagName?: string }) | null;
  if (!element || typeof element.tagName !== 'string') return false;
  const tag = element.tagName.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (element.isContentEditable === true) return true;
  const attribute = typeof element.getAttribute === 'function' ? element.getAttribute('contenteditable') : null;
  return attribute !== null && !/^(false|null)$/i.test(attribute);
}

/** Modifier-aware decode of the history keys, shared by both editors' handlers. */
export function historyCommandForKey(
  key: string,
  modifiers: { ctrl?: boolean; meta?: boolean; shift?: boolean },
): 'undo' | 'redo' | null {
  const combo = Boolean(modifiers.ctrl || modifiers.meta);
  if (!combo) return null;
  const normalised = key.trim().toLowerCase();
  if (normalised === 'y') return 'redo';
  if (normalised === 'z') return modifiers.shift ? 'redo' : 'undo';
  return null;
}
