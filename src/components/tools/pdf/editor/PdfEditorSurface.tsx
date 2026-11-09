/**
 * PdfEditorSurface — the one editor `/tool/edit-pdf` owns.
 *
 * `edit-pdf` (annotations) and `edit-pdf-text` (in-place text) were two cards,
 * two palette rows and two promises for one sentence: "change what is on this
 * page". They are one tool now, with three modes — Annotate, Edit text, Sign —
 * and this component is what owns that. It owns exactly three things:
 *
 * 1. **The chooser.** The mode is in the address bar (`?mode=text`), so the old
 *    `#/tool/edit-pdf-text` bookmark, a shared link and a reload all land on the
 *    half the user meant, and the URL keeps saying what the page is doing.
 * 2. **Which pane is up.** Both panes are the editors that already existed; a
 *    pane that has been opened stays mounted, which is what makes a mode switch
 *    free — the document is not re-parsed, the annotations and the unfinished
 *    rewrites are not rebuilt, and the page and zoom are the ones you left.
 * 3. **The keyboard.** Both editors bind `window` `keydown`, and two listeners on
 *    the same target and phase cannot be arbitrated from a parent: `display:none`
 *    hides a pane, it does not unregister anything. So the pane that is not
 *    showing is told not to bind, and one keystroke cannot quietly undo in a
 *    surface nobody is looking at — or export a file from it.
 *
 * Each pane still does its own work, exports its own file and keeps its own undo
 * stack, which is what "per-mode history that survives the trip" means here.
 */
import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  EDITOR_MODES,
  DEFAULT_EDITOR_MODE,
  MODE_PARAM,
  armedToolForMode,
  editorModeFromSearch,
  editorPaneFor,
  modeSearch,
  pressedMode,
  type EditorModeId,
  type EditorPaneId,
} from './editorModes';
import { hasEditorIntent } from './quickModes';
import type { EditorToolId } from './types';

/**
 * The two editors, loaded on demand.
 *
 * They are the heaviest components in the app, and a visitor who arrives to
 * highlight one sentence has no reason to download the text engine — so each
 * pane is fetched the first time its mode is opened, and each keeps its own
 * Suspense boundary so a chunk still in flight cannot unmount the other half.
 */
const AnnotationEditor = lazy(() => import('./AnnotationEditor').then((module) => ({ default: module.AnnotationEditor })));
const TextEditor = lazy(() => import('../text-editor/TextEditor').then((module) => ({ default: module.TextEditor })));

export function PdfEditorSurface(): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();

  /**
   * The mode the address bar asks for. An unknown token is not an error worth a
   * blank page: it answers the default mode, beside a URL the user can see.
   */
  const modeId: EditorModeId = editorModeFromSearch(location.search) ?? DEFAULT_EDITOR_MODE;
  const pane: EditorPaneId = editorPaneFor(modeId);

  /** What the showing pane reports as its pen; it settles the Annotate/Sign tie. */
  const [armed, setArmed] = useState<EditorToolId | null>(null);
  /** The pen the chooser asked for, until the pane reports what it holds. */
  const [requestTool, setRequestTool] = useState<EditorToolId | null>(() => armedToolForMode(modeId));
  /** Panes that have been opened stay mounted: unmounting one throws its work away. */
  const [visited, setVisited] = useState<EditorPaneId[]>(() => openedPanes(pane));

  useEffect(() => {
    setVisited((current) => (current.includes(pane) ? current : [...current, pane]));
  }, [pane]);

  const choose = useCallback(
    (next: EditorModeId) => {
      const asked = armedToolForMode(next);
      // A mode with no pen (`text`) leaves the annotation pane's pen alone, so
      // coming back finds the tool the user was holding, not the one the mode
      // bar names. Switching to `annotate`/`sign` is an explicit ask.
      if (asked) setRequestTool(asked);
      if (editorPaneFor(next) === pane && !asked) return;
      const params = new URLSearchParams(location.search);
      params.set(MODE_PARAM, next);
      // `replace`, because a mode is a state of this page, not a page of its
      // own: Back must not walk the user through every chip they pressed.
      navigate({ pathname: location.pathname, search: `?${params.toString()}` }, { replace: true });
    },
    [location.pathname, location.search, navigate, pane],
  );

  const active = pressedMode(pane, armed ?? requestTool);

  return (
    <div className="flex h-full min-h-0 flex-col bg-cream" data-editor-surface="merged">
      <div
        role="group"
        aria-label="Editor mode"
        data-editor-mode-bar={active}
        className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-cream-border bg-cream-light px-3 py-2"
      >
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
          Mode
        </span>
        {EDITOR_MODES.map((entry) => {
          const pressed = entry.id === active;
          return (
            <button
              key={entry.id}
              type="button"
              data-editor-mode={entry.id}
              aria-pressed={pressed}
              title={entry.blurb}
              onClick={() => choose(entry.id)}
              className={`doodle-chip flex flex-none items-center gap-1.5 whitespace-nowrap px-2.5 py-1 text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                pressed ? 'doodle-chip-active' : 'doodle-chip-inactive'
              }`}
            >
              <span aria-hidden className="text-[13px] leading-none">
                {entry.icon}
              </span>
              <span className="font-medium">{entry.label}</span>
            </button>
          );
        })}
        {/* The mode belongs here, not in the page title: one tool, one name, and
            the sentence beside the chooser says which half is up. */}
        <p
          role="status"
          aria-live="polite"
          data-editor-mode-note={active}
          className="min-w-0 flex-1 basis-full text-[10px] leading-relaxed text-ink-muted lg:basis-auto lg:text-right"
        >
          {EDITOR_MODES.find((entry) => entry.id === active)?.blurb}
        </p>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {visited.includes('annotate') && (
          <div className={pane === 'annotate' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'} data-editor-pane="annotate">
            <Suspense fallback={<PaneLoading label="the markup canvas" />}>
              <AnnotationEditor
                active={pane === 'annotate'}
                showModeChips={false}
                armedTool={requestTool}
                onToolChange={setArmed}
              />
            </Suspense>
          </div>
        )}
        {visited.includes('text') && (
          <div className={pane === 'text' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'} data-editor-pane="text">
            <Suspense fallback={<PaneLoading label="the text editor" />}>
              <TextEditor active={pane === 'text'} />
            </Suspense>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The panes to mount when the surface opens.
 *
 * Only the asked-for one, so arriving to highlight a sentence does not download
 * the text engine — with one exception: a quick-mode chip hands the open document
 * to the annotation pane, which is the only thing that adopts it, and a chip that
 * asked for the text mode must not arrive on an empty drop zone.
 */
function openedPanes(pane: EditorPaneId): EditorPaneId[] {
  if (pane === 'annotate') return ['annotate'];
  return hasEditorIntent('edit-pdf') ? ['annotate', 'text'] : ['text'];
}

/** A pane whose chunk is on its way; say so rather than sit blank. */
function PaneLoading({ label }: { label: string }): JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-6" role="status">
      <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-muted">
        Opening {label}…
      </p>
    </div>
  );
}

/** `#/tool/edit-pdf?mode=<mode>`, for anything outside the router that must link in. */
export function editorModePath(mode: EditorModeId): string {
  return `/tool/edit-pdf?${modeSearch(mode)}`;
}
