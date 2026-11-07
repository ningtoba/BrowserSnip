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
  { keys: ['Esc'], label: 'Step back one level: the half-drawn mark, then the selection, then the tool', group: 'marks' },
  { keys: ['Enter'], label: 'Close a clicked shape or freeform line', group: 'marks' },
  { keys: ['Delete'], label: 'Remove the selected mark', group: 'marks' },
  { keys: ['←', '→', '↑', '↓'], label: 'Nudge the selected mark 1 px, or 10 px with Shift', group: 'marks' },
  { keys: ['Alt', '←'], label: 'Move the selected edge instead of the whole mark', group: 'marks' },
  { keys: ['Shift', 'Click'], label: 'Add a mark to the selection, or take it back out', group: 'marks' },
  { keys: ['Drag'], label: 'Draw a band from empty paper to select the marks it touches', group: 'marks' },
  { keys: ['Ctrl', 'A'], label: 'Select every mark on this page', group: 'marks' },
  { keys: ['Ctrl', 'D'], label: 'Duplicate the selected mark', group: 'marks' },
  { keys: ['R'], label: 'Turn the selected mark 90° clockwise, or back with Shift — a letter once you are typing in it', group: 'marks' },
  { keys: ['Ctrl', 'Z'], label: 'Undo the last change', group: 'marks' },
  { keys: ['Ctrl', 'Shift', 'Z'], label: 'Re-apply the change just undone', group: 'marks' },
  { keys: ['Ctrl', 'Y'], label: 'Redo, the Windows way', group: 'marks' },
  { keys: ['Type'], label: 'Start writing in a selected text box or note, except the key that turns it', group: 'marks' },
  { keys: ['←', '→'], label: 'Previous / next page, when nothing is selected', group: 'pages' },
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

/* ------------------------------------------------------------------ *
 * The Escape ladder                                                   *
 * ------------------------------------------------------------------ */

/**
 * How far one `Esc` press reaches.
 *
 * Users accept Esc; what they report as a bug is Esc doing *everything* at once
 * (pdf.js's two-press complaint in the research notes). So the handler resolves
 * exactly one level per press, deepest first, and reports which level it took.
 */
export type EscapeLevel = 'dismiss' | 'selection' | 'disarm' | 'none';

/** The three levels, deepest first — the order the ladder unwinds in. */
export const ESCAPE_LEVELS: Exclude<EscapeLevel, 'none'>[] = ['dismiss', 'selection', 'disarm'];

export interface EscapeInput {
  /** A gesture, a half-written note, or a dialog is open. */
  editing: boolean;
  selected: boolean;
  /** Something other than Select is armed. */
  armed: boolean;
}

/** The one level `Esc` should take from here, or `none` when it is a no-op. */
export function nextEscapeLevel(input: EscapeInput): EscapeLevel {
  for (const level of ESCAPE_LEVELS) {
    if (level === 'dismiss' && input.editing) return 'dismiss';
    if (level === 'selection' && input.selected) return 'selection';
    if (level === 'disarm' && input.armed) return 'disarm';
  }
  return 'none';
}

/** What the status line says after a level was taken. */
export function escapeLevelNotice(level: EscapeLevel, selected?: number): string {
  switch (level) {
    case 'dismiss':
      return 'Dropped the mark that was half-drawn.';
    case 'selection':
      return typeof selected === 'number' && selected > 1
        ? `Cleared the ${selected} selected marks; the tool is still armed.`
        : 'Cleared the selection; the tool is still armed.';
    case 'disarm':
      return 'Put the tool down; Select is armed.';
    default:
      return '';
  }
}

/* ------------------------------------------------------------------ *
 * Nudge and duplicate                                                 *
 * ------------------------------------------------------------------ */

/** Arrow-key step, in CSS pixels on screen (1 px, Shift 10 px). */
export const NUDGE_PX = 1;
export const NUDGE_COARSE_PX = 10;

/** Screen-space delta for an arrow key, or `null` for a key that is not one. */
export function nudgeStep(
  key: string,
  shift: boolean,
): { dx: number; dy: number } | null {
  const step = shift ? NUDGE_COARSE_PX : NUDGE_PX;
  switch (key) {
    case 'ArrowLeft':
      return { dx: -step, dy: 0 };
    case 'ArrowRight':
      return { dx: step, dy: 0 };
    case 'ArrowUp':
      return { dx: 0, dy: -step };
    case 'ArrowDown':
      return { dx: 0, dy: step };
    default:
      return null;
  }
}

/** `Ctrl`/`Cmd` + D, the one duplicate combo the editor claims to support. */
export function isDuplicateKey(
  key: string,
  modifiers: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean },
): boolean {
  if (modifiers.shift || modifiers.alt) return false;
  if (!modifiers.ctrl && !modifiers.meta) return false;
  return key.trim().toLowerCase() === 'd';
}

/**
 * `Ctrl`/`Cmd` + A: select the current page's marks.
 *
 * Shift is accepted (some browsers deliver `A` with it for an upper-case select)
 * but Alt is not, because `Alt+A` belongs to whatever the operating system says.
 */
export function isSelectAllKey(
  key: string,
  modifiers: { ctrl?: boolean; meta?: boolean; alt?: boolean },
): boolean {
  if (modifiers.alt) return false;
  if (!modifiers.ctrl && !modifiers.meta) return false;
  return key.trim().toLowerCase() === 'a';
}

/**
 * How far `R` turns the selection: 90° clockwise, or back with Shift.
 *
 * A right-angle step is the one rotation every keyboard can be trusted with; the
 * finer angles come from the handle or the inspector's number field, because
 * nudging 15° at a time would take a dozen presses to square a mark again.
 */
export function rotationStepForKey(
  key: string,
  modifiers: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean },
): number | null {
  if (modifiers.ctrl || modifiers.meta || modifiers.alt) return null;
  if (key.trim().toLowerCase() !== 'r') return null;
  return modifiers.shift ? -90 : 90;
}

/**
 * Whether a printable key is a letter or a command.
 *
 * `R` is the collision the editor has to break out loud: with the caret inside a
 * text mark the user is writing and `r` is a letter; with the mark merely on the
 * selection there is no caret to feed, so `R` is the turn command. `caretInside`
 * is that one fact, said by the caller that knows it (`editingId`). Every other
 * printable key still starts the edit, which is the type-to-edit affordance the
 * shortcut list documents.
 */
export function goesToTheCaret(
  key: string,
  modifiers: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean },
  caretInside: boolean,
): boolean {
  if (!isTypeToEditKey(key, modifiers)) return false;
  return caretInside || rotationStepForKey(key, modifiers) === null;
}

/**
 * The rotate handle's snapping rule, in one sentence for the shortcut list and
 * the inspector: a drag snaps to 15° and `Shift` breaks the snap. The maths that
 * decides the angle is `rotationForDrag` in `geometry.ts`.
 */
export const ROTATE_SNAP_HINT = 'Drag the round handle to turn the mark; it snaps to 15° unless Shift is held.';


/**
 * True when a bare printable key should go *into* the selected mark instead of
 * arming a tool: the caret belongs to the selection the moment a text mark is
 * selected, which is the part of Bug 1 pdf.js gets right with focus.
 */
export function isTypeToEditKey(
  key: string,
  modifiers: { ctrl?: boolean; meta?: boolean; alt?: boolean },
): boolean {
  if (modifiers.ctrl || modifiers.meta || modifiers.alt) return false;
  return typeof key === 'string' && key.length === 1 && !/\s/.test(key);
}
