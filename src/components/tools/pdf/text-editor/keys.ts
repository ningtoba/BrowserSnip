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

/** Mode keys first (generated), then the fixed bindings of this editor. */
export const TEXT_EDITOR_SHORTCUTS: Shortcut[] = [
  ...(Object.keys(TEXT_MODE_KEYS) as (keyof typeof TEXT_MODE_KEYS)[]).map((key) => ({
    keys: [key.toUpperCase()],
    label: MODE_LABELS[TEXT_MODE_KEYS[key]],
    group: 'tools' as const,
  })),
  { keys: ['Ctrl', 'F'], label: 'Find and replace across pages', group: 'blocks' },
  { keys: ['Esc'], label: 'Stop editing, close Find, drop the selection', group: 'blocks' },
  { keys: ['Delete'], label: 'Remove the selected block', group: 'blocks' },
  { keys: ['Ctrl', 'Z'], label: 'Undo the last edit', group: 'blocks' },
  { keys: ['Ctrl', 'Shift', 'Z'], label: 'Re-apply the edit just undone', group: 'blocks' },
  { keys: ['Ctrl', 'Y'], label: 'Redo, the Windows way', group: 'blocks' },
  { keys: ['←', '→'], label: 'Nudge the selected block 1 pt (Shift: 10 pt)', group: 'blocks' },
  { keys: ['Ctrl', 'S'], label: 'Export the edited PDF', group: 'pages' },
];
