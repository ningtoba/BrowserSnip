/**
 * The merged PDF editor: one tool, three modes.
 *
 * `edit-pdf` and `edit-pdf-text` were two catalogue entries for one job, and the
 * user had to know which one they wanted before opening either. These tests pin
 * what replaced that, in the order a visitor meets it:
 *
 * 1. **The catalogue.** One entry, one card, one palette row — and the old id still
 *    answers its own URL, folded into the tool that owns the job.
 * 2. **The route.** `#/tool/edit-pdf-text` lands on `#/tool/edit-pdf?mode=text`, the
 *    header names one tool, and one promise line is printed.
 * 3. **The surface.** Opening the other mode does not throw the first one away: both
 *    panes stay mounted, so the document is never re-parsed and the page and zoom
 *    you left are the page and zoom you come back to.
 * 4. **The keyboard.** The pane that is not showing does not bind `window` keys, so
 *    a shortcut cannot act on a surface nobody is looking at.
 *
 * jsdom has no canvas: nothing here looks at pixels, and the byte half of the claim
 * — the exported file still carries the marks after a mode round trip — is measured
 * in the browser by `docs/research/editor-mode-proof.mjs`.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ToolWorkspace } from '@/components/layout/ToolWorkspace';
import { ToolPageHeader } from '@/components/layout/AppLayout';
import { searchPalette } from '@/components/layout/CommandPalette';
import { AnnotationEditor } from '@/components/tools/pdf/editor/AnnotationEditor';
import {
  EDITOR_MODES,
  armedToolForMode,
  editorMode,
  editorModeFromSearch,
  editorPaneFor,
  pressedMode,
} from '@/components/tools/pdf/editor/editorModes';
import {
  PDF_TOOLS,
  TOOL_CATALOGUE,
  aliasEntryFor,
  canonicalToolId,
  getPdfTool,
  hasCustomMainView,
  isToolAlias,
  mainViewFor,
} from '@/lib/pdf/tools/registry';
import { TOOL_JOBS } from '@/components/dashboard/toolJobs';
import { promiseFor } from '@/components/tools/pdf/shared/toolForm';
import { useFileStore } from '@/stores/file-store';
import { useProcessStore } from '@/stores/process-store';

/* ------------------------------------------------------------------ *
 * A document both editors can open without a canvas                   *
 * ------------------------------------------------------------------ */

const harness = { items: [] as unknown[] };

vi.mock('@/lib/pdf/core/render', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/pdf/core/render')>();
  const page = {
    getViewport: () => ({ width: 595, height: 842, scale: 1, rotation: 0 }),
    render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
    getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
    getTextContent: async () => ({ items: harness.items }),
    cleanup: () => {},
  };
  const session = {
    doc: {},
    numPages: 1,
    fingerprint: 'merged-editor',
    page: async () => page,
    renderToCanvas: async () => ({ width: 595, height: 842 }),
    renderPage: async () => ({ promise: Promise.resolve(), cancel: () => {}, finished: Promise.resolve() }),
    textContent: async () => ({ items: harness.items }),
    textItems: async () => harness.items,
    metadata: async () => ({}),
    attachments: async () => ({}),
    destroy: async () => {},
  };
  return { ...real, openRender: async () => session };
});

vi.mock('@/lib/pdf/core/signature', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/pdf/core/signature')>();
  return { ...real, readSignatures: async () => [] };
});

beforeAll(() => {
  URL.createObjectURL = vi.fn(() => 'blob:merged') as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
});

let sequence = 0;
function editorFile(): File {
  sequence += 1;
  // A header and a unique tail: the store keys a document by name, size and
  // mtime, and the parse itself is mocked out.
  return new File([`%PDF-1.4\n${sequence}`], 'report.pdf', { type: 'application/pdf' });
}

/** Put a document in the merged editor's own session slot, as a drop would. */
function openInEditor(file: File, toolId = 'edit-pdf'): void {
  useFileStore.setState({
    activeTool: null,
    file: null,
    files: [],
    metadata: null,
    sessions: {
      [toolId]: {
        file,
        files: [file],
        metadata: null,
        isLargeFile: false,
        params: {},
        codecWarning: null,
      },
    } as never,
  });
}

function route(path: string): void {
  render(
    createElement(
      MemoryRouter,
      { initialEntries: [path] },
      createElement(
        Routes,
        null,
        createElement(Route, { path: '/tool/:toolId', element: createElement(ToolWorkspace) }),
      ),
    ),
  );
}

/**
 * The same page over a router whose location can be read.
 *
 * `Navigate` moves the router, not `window.location`, and jsdom never fires a
 * hash change for the redirect — so the address a folded bookmark lands on has to
 * be read out of the router state that the redirect actually wrote.
 */
function routedPage(path: string): () => { pathname: string; search: string } {
  const seen = { pathname: '', search: '' };
  function Probe(): null {
    const location = useLocation();
    seen.pathname = location.pathname;
    seen.search = location.search;
    return null;
  }
  render(
    createElement(
      MemoryRouter,
      { initialEntries: [path] },
      createElement(Probe, null),
      createElement(
        Routes,
        null,
        createElement(Route, { path: '/tool/:toolId', element: createElement(ToolWorkspace) }),
      ),
    ),
  );
  return () => ({ ...seen });
}

/** Open the merged editor through its route, with a document already dropped. */
async function openSurface(path = '/tool/edit-pdf?mode=annotate'): Promise<void> {
  openInEditor(editorFile());
  window.location.hash = path;
  route(path);
  await waitFor(() => expect(document.querySelector('[data-editor-surface]')).toBeTruthy(), { timeout: 8000 });
  // The panes are lazy chunks: the surface is on screen before either editor is.
  await waitFor(() => expect(annotationPalette()).toBeTruthy(), { timeout: 8000 });
}

function clickMode(id: string): void {
  const chip = document.querySelector<HTMLButtonElement>(`[data-editor-mode="${id}"]`);
  expect(chip, `the surface never offered a ${id} chip`).toBeTruthy();
  act(() => {
    fireEvent.click(chip!);
  });
}

function annotationPalette(): Element | null {
  return document.querySelector('[data-editor-palette]');
}

/**
 * The text pane's mode, read off the cursor its page overlay asks for.
 *
 * `default` while it rests on Point-and-select, `crosshair` once a placement mode
 * is armed — the same distinction the pane draws for the user, and the only one
 * jsdom can see without a canvas.
 */
function overlayCursor(): string {
  const overlay = document.querySelector('[data-page-overlay]');
  return overlay instanceof HTMLElement ? overlay.style.cursor : '';
}

function press(key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  });
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  window.location.hash = '';
  harness.items = [];
  useProcessStore.getState().reset();
  useProcessStore.setState({ activeTool: null, sessions: {}, notice: null });
  useFileStore.setState({ activeTool: null, sessions: {}, file: null, files: [], metadata: null });
});

/* ------------------------------------------------------------------ *
 * 1. One entry, one card, one row                                     *
 * ------------------------------------------------------------------ */

describe('the catalogue holds one editor', () => {
  it('folds the text id into the editor instead of listing it twice', () => {
    expect(isToolAlias('edit-pdf-text')).toBe(true);
    expect(canonicalToolId('edit-pdf-text')).toBe('edit-pdf');
    expect(canonicalToolId('edit-pdf')).toBe('edit-pdf');
    // The definition survives: bookmarks, the runner and the pane lookup use it.
    expect(getPdfTool('edit-pdf-text')).toBeDefined();
    expect(TOOL_CATALOGUE.some((tool) => tool.id === 'edit-pdf-text')).toBe(false);
    const aliases = PDF_TOOLS.filter((tool) => isToolAlias(tool.id)).map((tool) => tool.id);
    expect(TOOL_CATALOGUE.length).toBe(PDF_TOOLS.length - aliases.length);
  });

  it('answers the folded id with one card and one palette row', () => {
    const shelf = TOOL_JOBS.flatMap((job) => job.toolIds);
    expect(shelf).toContain('edit-pdf');
    expect(shelf.filter((id) => id === 'edit-pdf-text')).toEqual([]);
    expect(shelf.filter((id) => isToolAlias(id))).toEqual([]);

    const rows = searchPalette('pdf editor', TOOL_CATALOGUE).map((hit) => hit.tool.id);
    expect(rows.filter((id) => id === 'edit-pdf')).toHaveLength(1);
    expect(rows).not.toContain('edit-pdf-text');
    // Someone who remembers the old page still finds the tool that owns the job.
    expect(searchPalette('edit-pdf-text', TOOL_CATALOGUE).map((hit) => hit.tool.id)).toContain('edit-pdf');
  });

  it('keeps a pane behind both spellings, and it is the same module', () => {
    expect(hasCustomMainView('edit-pdf')).toBe(true);
    expect(mainViewFor('edit-pdf')).toBeTruthy();
    expect(mainViewFor('edit-pdf-text')).toBeTruthy();
    // `lazy()` mints a fresh object per call, so identity proves nothing here; the
    // registry source does. One editor, one import, whatever the id is spelled as.
    const source = readFileSync(resolve(process.cwd(), 'src/lib/pdf/tools/registry.ts'), 'utf8');
    const panes = [...source.matchAll(/'(edit-pdf|edit-pdf-text)':\s*lazy\(\(\)\s*=>\s*import\('([^']+)'\)/g)]
      .map((match) => ({ id: match[1], module: match[2] }));
    expect(panes.map((pane) => pane.id).sort()).toEqual(['edit-pdf', 'edit-pdf-text']);
    expect(new Set(panes.map((pane) => pane.module)).size, 'the two ids open different editors').toBe(1);
    expect(panes[0].module).toMatch(/PdfEditorSurface$/);
  });

  it('writes one promise for the merged tool', () => {
    const editor = getPdfTool('edit-pdf')!;
    // The promise is the sentence the page prints; it has to cover both halves.
    expect(promiseFor(editor)).toMatch(/mark up/i);
    expect(promiseFor(editor)).toMatch(/retype/i);
    expect(editor.description).toMatch(/rewrite the words/i);
    expect(editor.keywords).toContain('edit-pdf-text');
    expect(editor.notes?.some((note) => /mode/i.test(note))).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 2. The mode is part of the route                                    *
 * ------------------------------------------------------------------ */

describe('the mode the route asks for', () => {
  it('names three modes, in the order a visitor would say them', () => {
    expect(EDITOR_MODES.map((mode) => mode.id)).toEqual(['annotate', 'text', 'sign']);
    expect(EDITOR_MODES.map((mode) => mode.label)).toEqual(['Annotate', 'Edit text', 'Sign']);
    for (const mode of EDITOR_MODES) {
      expect(mode.blurb.length).toBeGreaterThan(20);
      expect(['annotate', 'text']).toContain(mode.pane);
    }
    // Marking up and signing are one pane with two pens; only the text job moves.
    expect(editorPaneFor('annotate')).toBe('annotate');
    expect(editorPaneFor('sign')).toBe('annotate');
    expect(editorPaneFor('text')).toBe('text');
    expect(armedToolForMode('sign')).toBe('signature');
    expect(armedToolForMode('annotate')).toBe('highlight');
    expect(armedToolForMode('text')).toBeNull();
  });

  it('reads the mode out of the address bar, and says nothing when it is silent', () => {
    expect(editorModeFromSearch('?mode=text')).toBe('text');
    expect(editorModeFromSearch('mode=sign')).toBe('sign');
    expect(editorModeFromSearch('?other=1&mode=annotate')).toBe('annotate');
    expect(editorModeFromSearch('')).toBeNull();
    expect(editorModeFromSearch(null)).toBeNull();
    // An unknown token is not a mode; the surface falls back instead of blanking.
    expect(editorModeFromSearch('?mode=drawing')).toBeNull();
    expect(editorMode('drawing').id).toBe('annotate');
    expect(editorMode(null).id).toBe('annotate');
  });

  it('answers the folded bookmark with the canonical route and the mode attached', () => {
    expect(aliasEntryFor('edit-pdf-text')).toBe('text');
    // A folded id that names no entry, and a tool that is not folded at all.
    expect(aliasEntryFor('redact')).toBeUndefined();
    expect(aliasEntryFor('edit-pdf')).toBeUndefined();
    expect(aliasEntryFor('no-such-tool')).toBeUndefined();
  });

  it('presses the chip that matches what the pane is holding', () => {
    expect(pressedMode('text', 'highlight')).toBe('text');
    expect(pressedMode('annotate', 'signature')).toBe('sign');
    // After a signature lands the pen returns to Select, and the pressed chip
    // moves with it: a pressed `Sign` beside a Select cursor would be a lie.
    expect(pressedMode('annotate', 'select')).toBe('annotate');
    expect(pressedMode('annotate', 'highlight')).toBe('annotate');
    expect(pressedMode('annotate', null)).toBe('annotate');
  });

  it('routes the old URL to the merged surface, in the text mode', async () => {
    openInEditor(editorFile());
    const location = routedPage('/tool/edit-pdf-text');
    await waitFor(() => expect(document.querySelector('[data-editor-surface]')).toBeTruthy(), { timeout: 8000 });
    expect(location().pathname).toBe('/tool/edit-pdf');
    expect(location().search).toBe('?mode=text');
    // The session — and so the star and the recents — hang off one id.
    expect(useFileStore.getState().activeTool).toBe('edit-pdf');
    const shown = document.querySelector('[data-editor-pane="text"]');
    expect(shown, 'the text mode never mounted its pane').toBeTruthy();
    expect(shown!.className).not.toContain('hidden');
    expect(document.querySelector('[data-editor-mode="text"]')).toHaveAttribute('aria-pressed', 'true');
  });

  it('names one tool in the header, whichever spelling opened the page', () => {
    render(
      createElement(
        MemoryRouter,
        null,
        createElement(ToolPageHeader, { toolId: 'edit-pdf-text' }),
      ),
    );
    const folded = document.body.textContent ?? '';
    expect(folded).toContain('PDF Editor');
    expect(folded).not.toContain('Edit PDF Text');
    cleanup();

    render(
      createElement(
        MemoryRouter,
        null,
        createElement(ToolPageHeader, { toolId: 'edit-pdf' }),
      ),
    );
    expect(document.body.textContent ?? '').toContain('PDF Editor');
  });

  it('prints one promise line, and it is the merged one', async () => {
    openInEditor(editorFile());
    window.location.hash = '#/tool/edit-pdf?mode=text';
    route('/tool/edit-pdf?mode=text');
    await waitFor(() => expect(document.querySelector('[data-editor-surface]')).toBeTruthy(), { timeout: 8000 });

    const lines = document.querySelectorAll('[data-tool-promise]');
    expect(lines).toHaveLength(1);
    expect(lines[0].textContent).toBe(promiseFor(getPdfTool('edit-pdf')!));
    // The folded entry's own sentence must not appear beside it.
    expect(document.body.textContent).not.toContain('not covered up');
  });
});

/* ------------------------------------------------------------------ *
 * 3. A mode switch costs the work nothing                             *
 * ------------------------------------------------------------------ */

describe('switching modes', () => {
  it('keeps both panes mounted, so nothing is re-opened', async () => {
    await openSurface();
    const paletteBefore = annotationPalette();
    expect(paletteBefore).toBeTruthy();
    // The text pane has not been asked for yet, so its chunk is not even fetched.
    expect(document.querySelector('[data-editor-pane="text"]')).toBeNull();

    clickMode('text');
    await waitFor(() => expect(document.querySelector('[data-page-overlay]')).toBeTruthy(), { timeout: 8000 });
    expect(document.querySelector('[data-editor-pane="annotate"]')?.className).toContain('hidden');
    expect(annotationPalette()).toBe(paletteBefore);

    clickMode('annotate');
    await waitFor(() =>
      expect(document.querySelector('[data-editor-pane="annotate"]')?.className).not.toContain('hidden'),
    );
    // The same DOM nodes: the pane was hidden, never unmounted, so the document it
    // opened, the marks it holds and the page and zoom it was on are still there.
    expect(annotationPalette()).toBe(paletteBefore);
    expect(document.querySelectorAll('[data-editor-pane]')).toHaveLength(2);
  });

  it('says which mode is up, in the surface rather than in the page name', async () => {
    await openSurface();
    expect(document.querySelector('[data-editor-mode-bar]')?.getAttribute('data-editor-mode-bar')).toBe('annotate');
    expect(document.querySelector('[data-editor-mode-note]')?.textContent).toMatch(/Highlight, comment/i);

    clickMode('text');
    await waitFor(() =>
      expect(document.querySelector('[data-editor-mode="text"]')).toHaveAttribute('aria-pressed', 'true'),
    );
    expect(document.querySelector('[data-editor-mode-note]')?.textContent).toMatch(/Retype the words/i);
    expect(document.body.textContent).not.toContain('Edit PDF Text');
  });

  it('moves the document to the text mode without a second pick', async () => {
    await openSurface();
    clickMode('text');
    await waitFor(() => expect(document.querySelector('[data-page-overlay]')).toBeTruthy(), { timeout: 8000 });
    // One file, one tab: the other pane answers to the document already open.
    expect(useFileStore.getState().files).toHaveLength(1);
    expect(document.body.textContent).toContain('report.pdf');
  });

  it('arms Sign with the signature pen, in the pane that is already up', async () => {
    await openSurface();
    clickMode('sign');
    await waitFor(() =>
      expect(document.querySelector('[data-editor-mode="sign"]')).toHaveAttribute('aria-pressed', 'true'),
    );
    expect(annotationPalette()?.getAttribute('data-armed-tool')).toBe('signature');
    // Sign is a mode, not a second page: no new pane was mounted for it.
    expect(document.querySelectorAll('[data-editor-pane]')).toHaveLength(1);
    expect(document.querySelector('[data-editor-pane="annotate"]')?.className).not.toContain('hidden');
  });

  it('arms Sign with the signature pen, in the pane that is already up', async () => {
    await openSurface();
    clickMode('sign');
    await waitFor(() =>
      expect(document.querySelector('[data-editor-mode="sign"]')).toHaveAttribute('aria-pressed', 'true'),
    );
    expect(annotationPalette()?.getAttribute('data-armed-tool')).toBe('signature');
    // Sign is a mode, not a second page: no new pane was mounted for it.
    expect(document.querySelectorAll('[data-editor-pane]')).toHaveLength(1);
    expect(document.querySelector('[data-editor-pane="annotate"]')?.className).not.toContain('hidden');
  });
});

/* ------------------------------------------------------------------ *
 * 4. One pane owns the keyboard                                       *
 * ------------------------------------------------------------------ */

describe('the keyboard', () => {
  it('arms a pen in the showing pane and in that pane only', async () => {
    await openSurface();
    clickMode('text');
    await waitFor(() => expect(document.querySelector('[data-page-overlay]')).toBeTruthy(), { timeout: 8000 });
    clickMode('annotate');
    await waitFor(() => expect(document.querySelector('[data-editor-pane="text"]')?.className).toContain('hidden'));

    // `t` means "text box" to the annotation pane and "place a new text block" to
    // the text pane, so one press shows which of them was listening.
    press('t');
    expect(annotationPalette()?.getAttribute('data-armed-tool')).toBe('freetext');
    expect(overlayCursor()).toBe('default');

    clickMode('text');
    await waitFor(() =>
      expect(document.querySelector('[data-editor-pane="annotate"]')?.className).toContain('hidden'),
    );
    // `h` is the annotation editor's highlighter and nothing here; if the hidden
    // pane were still bound, the palette would have moved off `freetext`.
    press('h');
    expect(annotationPalette()?.getAttribute('data-armed-tool')).toBe('freetext');
    press('t');
    await waitFor(() => expect(overlayCursor()).toBe('crosshair'));
    expect(annotationPalette()?.getAttribute('data-armed-tool')).toBe('freetext');
  });

  it('binds the annotation editor only while its host says it is showing', () => {
    render(<AnnotationEditor active={false} />);
    const palette = document.querySelector('[data-editor-palette]')!;
    press('h');
    expect(palette.getAttribute('data-armed-tool')).toBe('select');
    cleanup();

    // The gate is what silences it: mounted as its own page, the same key arms.
    render(<AnnotationEditor />);
    const live = document.querySelector('[data-editor-palette]')!;
    press('h');
    expect(live.getAttribute('data-armed-tool')).toBe('highlight');
  });

  it('leaves the job chooser to the surface when it is hosted by one', () => {
    render(<AnnotationEditor />);
    expect(document.querySelectorAll('[data-quick-mode]').length).toBeGreaterThan(0);
    cleanup();

    render(<AnnotationEditor active showModeChips={false} />);
    expect(document.querySelector('[data-editor-palette]')).toBeTruthy();
    expect(document.querySelectorAll('[data-quick-mode]')).toHaveLength(0);
  });
});
