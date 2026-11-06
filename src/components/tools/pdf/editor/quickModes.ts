/**
 * Quick modes — the routing the empty editors promise.
 *
 * The editors are three separate tools (`edit-pdf`, `edit-pdf-text`, `sign`), so
 * a user who arrives on "Edit PDF" and wants a signature has to know that the
 * signature tool lives elsewhere. The chips in the empty state say it out loud
 * and move the user there, with the right sub-panel already open and the current
 * document carried over — otherwise a chip would just mean re-picking the file.
 *
 * Two constraints shape the implementation:
 *
 * * Routing is `window.location.hash`, because the app runs on a `HashRouter`
 *   (see `src/AppRoot.tsx`). Using `useNavigate()` here would work in the app but
 *   make every editor mount require a `<Router>` wrapper in tests; the hash is
 *   the same navigation with one less dependency.
 * * The hand-off is a single module-level intent, consumed once by the target.
 *   It holds a `File` reference, never file contents, and lives only as long as
 *   the tab — same rule as the annotation workspaces.
 */
import type { EditorToolId } from './types';

export type QuickModeId = 'sign' | 'editText' | 'annotate';

export interface QuickMode {
  id: QuickModeId;
  label: string;
  /** One line under the chip: what this mode is actually for. */
  blurb: string;
  icon: string;
  /** Route id the mode lands on (`/tool/<toolId>`). */
  toolId: string;
  /**
   * Sub-panel to preselect on arrival. Opaque to this module: `SignTool` reads
   * `'draw' | 'text' | 'image'`, the editors read `'markup' | 'text' | …`.
   */
  panel: string;
  /** Annotation palette entry to arm on arrival. */
  armTool?: EditorToolId;
}

/** Order is display order: the three things people come to an editor for. */
export const QUICK_MODES: QuickMode[] = [
  {
    id: 'sign',
    label: 'Sign',
    blurb: 'Draw or type a signature, then drop it on the page',
    icon: '✍️',
    toolId: 'sign',
    panel: 'draw',
  },
  {
    id: 'editText',
    label: 'Edit text',
    blurb: 'Retype the words already in the page',
    icon: '🔤',
    toolId: 'edit-pdf-text',
    panel: 'text',
  },
  {
    id: 'annotate',
    label: 'Annotate',
    blurb: 'Highlight, comment, stamp, redact',
    icon: '🖍️',
    toolId: 'edit-pdf',
    panel: 'markup',
    armTool: 'highlight',
  },
];

export function quickModeById(id: QuickModeId | string | null | undefined): QuickMode | undefined {
  return QUICK_MODES.find((mode) => mode.id === id);
}

/**
 * The palette entry each editor route implies, so arriving from a tool card or
 * a chip never opens on a tool the user did not ask for.
 */
const ARM_BY_TOOL_ID: Record<string, EditorToolId> = {
  'edit-pdf': 'highlight',
  annotate: 'highlight',
  'add-stamps': 'stamp',
  redact: 'redact',
  'redact-pdf': 'redact',
};

export function defaultToolForToolId(toolId: string | null | undefined): EditorToolId | null {
  if (!toolId) return null;
  return ARM_BY_TOOL_ID[toolId] ?? null;
}

export function toolPath(toolId: string): string {
  return `/tool/${toolId}`;
}

/** Route id currently in the address bar, or `null` when the hash is not a tool. */
export function toolIdFromLocation(hash: string = readHash()): string | null {
  const match = /#\/tool\/([^/?#]+)/.exec(hash ?? '');
  return match ? decodeURIComponent(match[1]) : null;
}

function readHash(): string {
  try {
    return typeof window === 'undefined' ? '' : window.location.hash;
  } catch {
    return '';
  }
}

/** One pending hand-off between editor surfaces. */
export interface EditorIntent {
  toolId: string;
  panel: string | null;
  armTool: EditorToolId | null;
  /** Document to adopt so the chip does not mean "pick the file again". */
  file: File | null;
  /** Sentence the target shows so the arrival explains itself. */
  note: string | null;
}

let pending: EditorIntent | null = null;

export function setEditorIntent(intent: EditorIntent): void {
  pending = intent;
}

/** Read the intent, and clear it — a hand-off is applied exactly once. */
export function takeEditorIntent(toolId: string): EditorIntent | null {
  if (!pending || pending.toolId !== toolId) return null;
  const intent = pending;
  pending = null;
  return intent;
}

export function peekEditorIntent(): EditorIntent | null {
  return pending;
}

export function clearEditorIntent(): void {
  pending = null;
}

export interface QuickModePlan {
  /** Whether the caller has to change route at all. */
  navigate: boolean;
  path: string;
  intent: EditorIntent;
}

/**
 * Decide what a chip does from the mode, the route we are on and the document in
 * hand. Staying put is deliberate: `Annotate` on `/tool/edit-pdf` should arm the
 * highlighter, not reload the editor the user is already looking at.
 */
export function planQuickMode(
  mode: QuickMode,
  options: { currentToolId?: string | null; file?: File | null } = {},
): QuickModePlan {
  const current = options.currentToolId ?? null;
  const navigate = current !== mode.toolId;
  return {
    navigate,
    path: toolPath(mode.toolId),
    intent: {
      toolId: mode.toolId,
      panel: mode.panel,
      armTool: mode.armTool ?? defaultToolForToolId(mode.toolId),
      file: navigate ? (options.file ?? null) : null,
      note: navigate ? `Opened ${mode.label.toLowerCase()} from the editor chooser.` : null,
    },
  };
}

/** Assigning to `location.hash` is what a `HashRouter` link does. */
export function navigateToTool(toolId: string): void {
  const path = toolPath(toolId);
  try {
    if (typeof window !== 'undefined') window.location.hash = `#${path}`;
  } catch {
    /* a non-browser caller (unit test of the pure half) simply does not move */
  }
}

/**
 * Do the whole hand-off: stash the intent, then route. Exported so both editors
 * and the chips stay one line each at the call site.
 */
export function requestQuickMode(
  mode: QuickMode,
  options: { currentToolId?: string | null; file?: File | null } = {},
): QuickModePlan {
  const plan = planQuickMode(mode, options);
  setEditorIntent(plan.intent);
  if (plan.navigate) navigateToTool(mode.toolId);
  return plan;
}

/**
 * The document a chip promised to carry, if the target should take it.
 *
 * `useFileStore` keeps a slot per tool (`setActiveTool` swaps `file`/`files` out of
 * `sessions`), so arriving at `/tool/sign` from the editor really does land on an
 * empty tool: the hand-off is the only reason the chip means “keep working on this
 * file” rather than “pick the file again”. Nothing is adopted twice — a document
 * already open here, or one already named here, wins.
 */
export function adoptedFile(intent: EditorIntent | null, current: readonly { name: string }[]): File | null {
  const file = intent?.file ?? null;
  if (!file) return null;
  if (current.some((entry) => entry.name === file.name)) return null;
  return file;
}

/**
 * Reassurance shown on every editor drop card. These are claims the code can
 * keep: nothing is posted anywhere, the source file is never mutated, and no
 * write happens until Export.
 */
export const DROP_REASSURANCE: string[] = [
  'It never leaves this device — no upload, no queue, no account.',
  'Your file is copied and the copy is edited; the original stays untouched.',
  'Nothing is written until you press Export.',
];
