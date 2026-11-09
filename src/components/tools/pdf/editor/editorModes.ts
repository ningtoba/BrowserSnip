/**
 * The modes of the one PDF editor.
 *
 * `edit-pdf` and `edit-pdf-text` used to be two catalogue entries for the same
 * sentence — "change what is on this page" — and choosing between them asked the
 * visitor a question about our internals. One tool owns the job now, and these
 * are the three things it can be doing. A mode is *not* a route: the document,
 * the page and every half-finished piece of work belong to the surface, and
 * switching modes must not touch them.
 *
 * The URL still carries a mode, for two reasons: `#/tool/edit-pdf-text` is a
 * bookmark that means "the text half", and the address bar should say what the
 * page is showing. `TOOL_ALIAS_ENTRIES` in the registry names the token and
 * `aliasEntryFor` is the only writer (the shell puts it in the redirect); this
 * module's `editorModeFromSearch` is the only reader, so the two ends cannot drift
 * apart silently — an unknown token falls back to the default mode rather than to
 * a blank pane.
 */
import type { EditorToolId } from './types';

/** The three jobs the merged editor offers. */
export type EditorModeId = 'annotate' | 'text' | 'sign';

/** Which pane a mode shows. The two annotation modes share one pane and differ only in pen. */
export type EditorPaneId = 'annotate' | 'text';

export interface EditorMode {
  id: EditorModeId;
  label: string;
  icon: string;
  /** One line beside the chooser: what this mode does to the page. */
  blurb: string;
  pane: EditorPaneId;
  /**
   * The palette pen the mode asks for, or `null` to leave the pen alone.
   *
   * `text` has none because the pen belongs to the other pane, which stays
   * mounted underneath; an arming request there would silently replace the pen
   * the user was holding when they came back.
   */
  armTool: EditorToolId | null;
}

/** Display order: mark the page, rewrite the page, sign the page. */
export const EDITOR_MODES: EditorMode[] = [
  {
    id: 'annotate',
    label: 'Annotate',
    icon: '🖍️',
    blurb: 'Highlight, comment, draw, stamp and redact — marks a PDF reader can show again',
    pane: 'annotate',
    armTool: 'highlight',
  },
  {
    id: 'text',
    label: 'Edit text',
    icon: '🔤',
    blurb: 'Retype the words already in the page: the old glyphs are removed and the block redrawn',
    pane: 'text',
    armTool: null,
  },
  {
    id: 'sign',
    label: 'Sign',
    icon: '✍️',
    blurb: 'Draw a signature, then drop it where it belongs',
    pane: 'annotate',
    armTool: 'signature',
  },
];

/** The mode a route with no `?mode=` opens on. */
export const DEFAULT_EDITOR_MODE: EditorModeId = 'annotate';

/** The query parameter that names a mode. */
export const MODE_PARAM = 'mode';

export function editorModeById(id: EditorModeId | string | null | undefined): EditorMode | undefined {
  return EDITOR_MODES.find((mode) => mode.id === id);
}

/** The mode record for an id, falling back to the default rather than to nothing. */
export function editorMode(id: EditorModeId | string | null | undefined): EditorMode {
  return editorModeById(id) ?? EDITOR_MODES.find((mode) => mode.id === DEFAULT_EDITOR_MODE)!;
}

/** The pane a mode shows. */
export function editorPaneFor(id: EditorModeId | string | null | undefined): EditorPaneId {
  return editorMode(id).pane;
}

/** `?mode=text`, the query string a route carries for a mode. */
export function modeSearch(mode: EditorModeId): string {
  return `${MODE_PARAM}=${mode}`;
}

/**
 * The mode a location asks for, or `null` when it asks for none.
 *
 * Anything unrecognised answers `null` rather than guessing, so the caller can
 * tell "the URL named a mode" from "the URL is silent" — the second is the state
 * a chip press replaces, and the first is a route that must be honoured.
 */
export function editorModeFromSearch(search: string | null | undefined): EditorModeId | null {
  const raw = readParam(search ?? '', MODE_PARAM);
  return editorModeById(raw) ? (raw as EditorModeId) : null;
}

function readParam(search: string, key: string): string | null {
  const trimmed = search.replace(/^[?#&]+/, '');
  if (!trimmed) return null;
  for (const chunk of trimmed.split('&')) {
    const [name, value = ''] = chunk.split('=');
    if (name !== key) continue;
    try {
      return decodeURIComponent(value.replace(/\+/g, ' '));
    } catch {
      return value;
    }
  }
  return null;
}

/**
 * The pen a mode asks the annotation pane to hold.
 *
 * Exposed as a function of the id so the surface, its tests and the quick-mode
 * chips ask the same question and get the same answer.
 */
export function armedToolForMode(id: EditorModeId | string | null | undefined): EditorToolId | null {
  return editorModeById(id)?.armTool ?? null;
}

/**
 * Which mode the chooser should read as pressed.
 *
 * `annotate` and `sign` are the same pane, so the pen the pane is actually
 * holding decides between them: a pressed `Sign` chip beside a Select cursor
 * would be a control describing a state the canvas is not in. After a signature
 * lands, the settled-tool rule hands the pen back to Select and the pressed chip
 * moves to `Annotate` on its own.
 */
export function pressedMode(pane: EditorPaneId, armedTool: EditorToolId | null): EditorModeId {
  if (pane === 'text') return 'text';
  return armedTool === 'signature' ? 'sign' : 'annotate';
}
