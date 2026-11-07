/**
 * App shell affordances: ⌘K palette, the memory it carries, dark mode.
 *
 * The left sidebar is gone — its category tree, starred list and recent-files
 * list now live as the first two bands of the palette (see the "sidebar rail is
 * gone" block, which is a ratchet, not a smoke test). What is asserted hardest
 * here is what the removal put at risk: that the palette is reachable by pointer
 * *and* key, that it behaves like a dialog (Tab cannot escape, Escape closes and
 * hands focus back), that stars and recents still survive a reload, and that no
 * control anywhere opens something that no longer exists.
 *
 * Nothing in this file needs canvas or a real viewport; `matchMedia` is stubbed
 * only to prove the layout no longer branches on it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { PALETTE_LIMIT, fuzzyScore, searchPalette } from '@/components/layout/CommandPalette';
import { PDF_CATEGORIES, PDF_TOOLS, getPdfTool } from '@/lib/pdf/tools/registry';
import { ResultCard } from '@/components/tools/pdf/shared/ResultCard';
import {
  RECENT_FILES_CAP,
  RECENT_FILES_KEY,
  STARRED_TOOLS_KEY,
  clearRecentFiles,
  readRecentFiles,
  readStarredTools,
  recordRecentFiles,
  toggleStarredTool,
} from '@/lib/recents';
import { DARK_CLASS, THEME_STORAGE_KEY } from '@/hooks/useTheme';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove('dark');
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.classList.remove('dark');
});

/**
 * Install a `matchMedia` that answers the old rail query.
 *
 * The shell used to swap the rail for a drawer at 1024px. It does not read
 * `matchMedia` at all any more, so both settings must produce the same controls
 * — which is what the width-independence test asserts.
 */
function stubMatchMedia({ wide }: { wide: boolean }) {
  window.matchMedia = ((query: string) => ({
    media: query,
    matches: wide && query === '(min-width: 1024px)',
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function renderShell(at = '/pdf') {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/" element={<p>landing</p>} />
          <Route path="/pdf" element={<p>pdf dashboard</p>} />
          <Route path="/tool/:toolId" element={<p data-testid="tool-page">tool page</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

/** The shell root, so a "does not exist anywhere" assertion has a scope. */
function shellRoot(): HTMLElement {
  const root = document.querySelector<HTMLElement>('.shell-app');
  if (!root) throw new Error('the shell did not render');
  return root;
}

function openPalette() {
  fireEvent.keyDown(window, { key: 'k', metaKey: true });
  return screen.findByRole('dialog', { name: 'Search tools' });
}

function searchField() {
  return screen.findByRole('combobox', { name: 'Search tools' });
}

/** Group headings in render order — the assertion the "first two sections" tests use. */
function groupLabels(): string[] {
  return [...document.querySelectorAll('[data-palette-group]')].map((node) =>
    node.getAttribute('data-palette-group'),
  ) as string[];
}

const options = () => within(screen.getByRole('listbox', { name: 'Matching tools' })).getAllByRole('option');
const selectedIndex = () => options().findIndex((node) => node.getAttribute('aria-selected') === 'true');
const rowByText = (text: string) => options().find((node) => (node.textContent ?? '').includes(text));

describe('palette search', () => {
  it('matches on name, on keywords and on category', () => {
    expect(searchPalette('merge')[0]?.tool.id).toBe('merge');
    // "combine" is a keyword of Merge PDF, not part of its name.
    expect(searchPalette('combine').map((hit) => hit.tool.id)).toContain('merge');
    const security = searchPalette('security');
    expect(security.length).toBeGreaterThan(0);
    expect(security.every((hit) => hit.tool.category === 'security')).toBe(true);
  });

  it('scores a fuzzy subsequence below the real word and rejects impossible queries', () => {
    const exact = fuzzyScore('merge', 'Merge PDF');
    const scattered = fuzzyScore('mrg', 'Merge PDF');
    expect(exact).not.toBeNull();
    expect(scattered).not.toBeNull();
    expect(exact!).toBeGreaterThan(scattered!);
    expect(fuzzyScore('zxqv', 'Merge PDF')).toBeNull();
    // A gap-riddled query still finds the tool, which is the point of fuzzy.
    expect(searchPalette('mrg').map((hit) => hit.tool.id)).toContain('merge');
  });

  it('caps the result list', () => {
    expect(searchPalette('pdf', PDF_TOOLS, PALETTE_LIMIT).length).toBeLessThanOrEqual(PALETTE_LIMIT);
  });
});

describe('command palette', () => {
  it('opens on ⌘K, filters while typing and closes on Esc', async () => {
    renderShell();

    await openPalette();
    const field = await searchField();

    fireEvent.change(field, { target: { value: 'merge' } });
    await waitFor(() => {
      expect(rowByText('Merge PDF')).toBeTruthy();
    });

    fireEvent.keyDown(field, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('opens on Ctrl-K as well as ⌘K, and toggles closed on the second press', async () => {
    renderShell();

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(await screen.findByRole('dialog', { name: 'Search tools' })).toBeTruthy();

    fireEvent.keyDown(window, { key: 'K', ctrlKey: true });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('opens from the visible Search button, which is the pointer route to every tool', async () => {
    renderShell();

    const trigger = screen.getByRole('button', { name: /Search tools/ });
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(trigger);
    await screen.findByRole('dialog', { name: 'Search tools' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    // Every one of the ~124 registry tools is reachable from here.
    fireEvent.change(await searchField(), { target: { value: 'linearize' } });
    await waitFor(() => expect(rowByText('Linearize PDF')).toBeTruthy());
  });

  it('moves the selection with the arrow keys and opens with Enter', async () => {
    renderShell();

    await openPalette();
    const field = await searchField();
    fireEvent.change(field, { target: { value: 'convert' } });

    await waitFor(() => expect(options().length).toBeGreaterThan(1));
    expect(selectedIndex()).toBe(0);
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    expect(selectedIndex()).toBe(1);
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    expect(selectedIndex()).toBe(2);
    fireEvent.keyDown(field, { key: 'ArrowUp' });
    expect(selectedIndex()).toBe(1);

    // Typing a new query must not leave the caret pointing at a stale row.
    fireEvent.change(field, { target: { value: 'merge' } });
    expect(selectedIndex()).toBe(0);

    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('tool-page')).toBeTruthy());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('closes on a click of the row, not only on Enter', async () => {
    renderShell();

    await openPalette();
    const field = await searchField();
    fireEvent.change(field, { target: { value: 'merge' } });
    await waitFor(() => expect(rowByText('Merge PDF')).toBeTruthy());

    fireEvent.click(rowByText('Merge PDF') as HTMLElement);
    await waitFor(() => expect(screen.getByTestId('tool-page')).toBeTruthy());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('says so when nothing matches', async () => {
    renderShell();

    await openPalette();
    const field = await searchField();
    fireEvent.change(field, { target: { value: 'qqqzzzxxx' } });

    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('No tools match');
    expect(screen.queryByRole('option')).toBeNull();
  });

  it('holds focus in the dialog and gives it back to whatever opened it', async () => {
    renderShell();
    recordRecentFiles([{ name: 'a.pdf', size: 10 }], 'split', Date.now());

    const trigger = screen.getByRole('button', { name: /Search tools/ });
    trigger.focus();
    fireEvent.click(trigger);

    const field = await searchField();
    // Opening takes the caret to the query; the rows are not tab stops.
    expect(document.activeElement).toBe(field);

    const clear = screen.getByRole('button', { name: 'Clear recent files' });
    // Last stop → first, first → last, and anything outside is pulled back in.
    clear.focus();
    fireEvent.keyDown(clear, { key: 'Tab' });
    expect(document.activeElement).toBe(field);
    fireEvent.keyDown(field, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(clear);
    const outside = screen.getByRole('button', { name: 'Switch to dark mode' });
    outside.focus();
    fireEvent.keyDown(outside, { key: 'Tab' });
    expect(document.activeElement).toBe(field);

    fireEvent.keyDown(field, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Escape closes *and* releases: the opener has the caret again.
    expect(document.activeElement).toBe(trigger);
  });

  it('leaves the caret on a real control after it closes on a selection', async () => {
    renderShell();
    const trigger = screen.getByRole('button', { name: /Search tools/ });
    trigger.focus();
    fireEvent.click(trigger);
    const field = await searchField();
    fireEvent.change(field, { target: { value: 'merge' } });
    await waitFor(() => expect(rowByText('Merge PDF')).toBeTruthy());

    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByTestId('tool-page')).toBeTruthy();
    // The header survives the navigation, so focus is not stranded on `body`.
    expect(document.activeElement).toBe(trigger);
  });
});

describe('palette memory bands', () => {
  it('puts Starred first and Recent second on an empty query', async () => {
    toggleStarredTool('split');
    recordRecentFiles([{ name: 'Quarterly Report.pdf', size: 2_500_000 }], 'merge', Date.now());
    renderShell();

    await openPalette();
    await waitFor(() => expect(groupLabels()).toEqual(['Starred', 'Recent', 'All tools']));

    const starred = options()[0];
    expect(starred.textContent).toContain('Split PDF');
    // A row is worth nothing if you cannot tell what it does: name, one-line
    // promise and category are all on it.
    expect(starred.textContent).toContain(String(getPdfTool('split')?.description));
    expect(starred.textContent).toContain('Organize PDF');

    const recent = rowByText('Quarterly Report.pdf');
    expect(recent).toBeTruthy();
    expect(recent?.textContent).toContain('Merge PDF');
    expect(recent?.textContent).toContain('MB');
    // Metadata only — the row never looks like a session restore.
    expect(recent?.getAttribute('title')).toMatch(/never stored/i);
  });

  it('walks to a recent row with the arrows and opens its tool on Enter', async () => {
    recordRecentFiles([{ name: 'scan-me.pdf', size: 1200 }], 'split', Date.now());
    renderShell();

    await openPalette();
    const field = await searchField();
    await waitFor(() => expect(rowByText('scan-me.pdf')).toBeTruthy());
    const target = options().indexOf(rowByText('scan-me.pdf') as HTMLElement);
    for (let step = 0; step < target; step += 1) {
      fireEvent.keyDown(field, { key: 'ArrowDown' });
    }
    expect(selectedIndex()).toBe(target);

    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('tool-page')).toBeTruthy());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('opens the tool again when a recent row is clicked', async () => {
    recordRecentFiles([{ name: 'a.pdf', size: 10 }], 'split', Date.now());
    renderShell();

    await openPalette();
    fireEvent.click(await waitFor(() => rowByText('a.pdf') as HTMLElement));
    expect(await screen.findByTestId('tool-page')).toBeTruthy();
  });

  it('drops rows whose tool no longer exists instead of dead-ending', async () => {
    recordRecentFiles([{ name: 'gone.pdf', size: 10 }], 'not-a-real-tool', Date.now());
    toggleStarredTool('not-a-real-tool');
    renderShell();

    await openPalette();
    await waitFor(() => expect(groupLabels()).toEqual(['All tools']));
    expect(screen.queryByText('gone.pdf')).toBeNull();
  });

  it('Clear forgets the files and keeps the stars', async () => {
    toggleStarredTool('merge');
    recordRecentFiles([{ name: 'a.pdf', size: 10 }], 'split', Date.now());
    renderShell();

    await openPalette();
    const field = await searchField();
    fireEvent.click(screen.getByRole('button', { name: 'Clear recent files' }));

    await waitFor(() => expect(localStorage.getItem(RECENT_FILES_KEY)).toBeNull());
    expect(readStarredTools()).toContain('merge');
    await waitFor(() => expect(groupLabels()).toEqual(['Starred', 'All tools']));
    // The palette stays open, and the caret stays where the keyboard work happens.
    expect(screen.getByRole('dialog', { name: 'Search tools' })).toBeTruthy();
    expect(document.activeElement).toBe(field);
  });

  it('shows a file picked while a tool is open, without a reload', async () => {
    renderShell('/tool/merge');
    await openPalette();
    await searchField();

    const store = (await import('@/stores/file-store')).useFileStore;
    store.getState().setActiveTool('merge');
    store.getState().setFile(new File(['%PDF-1.7'], 'dropped.pdf', { type: 'application/pdf' }));
    await waitFor(() => expect(readRecentFiles().map((e) => e.name)).toContain('dropped.pdf'));

    // The band the user is already looking at grows; no close-and-reopen needed.
    await waitFor(() => expect(rowByText('dropped.pdf')).toBeTruthy());
    store.getState().clearCurrent();
    store.getState().setFile(null);
  });
});

describe('sidebar rail is gone', () => {
  it('renders no rail, no category tree and no drawer button at any width', () => {
    for (const wide of [true, false]) {
      stubMatchMedia({ wide });
      renderShell('/tool/merge');
      const shell = shellRoot();

      // Scoped to the shell: the stubbed outlet renders no tool workspace, so any
      // rail-shaped column here is the app's own. A tool page keeps its *control*
      // rail (`ToolWorkspace`'s aside) — that one was never in question.
      // The rail, its collapse chevrons and the 16rem column are all gone.
      expect(shell.querySelector('aside')).toBeNull();
      expect(shell.querySelector('.shell-rail')).toBeNull();
      expect(shell.querySelector('[class*="w-64"]')).toBeNull();
      expect(shell.querySelector('[class*="w-72"]')).toBeNull();
      // Nothing may open a drawer that no longer exists.
      expect(screen.queryByRole('button', { name: /tools menu/i })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Close tools menu' })).toBeNull();
      // And the category tree is not reprinted in the shell; the dashboard owns it.
      for (const category of PDF_CATEGORIES) {
        expect(
          screen.queryByRole('button', { name: new RegExp(`^${category.label} \\(`) }),
        ).toBeNull();
      }
      expect(screen.queryByText('Recent files')).toBeNull();

      cleanup();
    }
    window.matchMedia = ((query: string) => ({
      media: query,
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
  });

  it('offers no engine affordance anywhere on a tool page', () => {
    // Ratchet, not a leftover check: the engines are resolved silently, so a
    // chip, a badge or a settings entry point must not come back.
    renderShell('/tool/linearize-pdf');
    expect((getPdfTool('linearize-pdf')?.engines ?? []).length).toBeGreaterThan(0);

    const shell = shellRoot();
    expect(shell.textContent).not.toMatch(/engine/i);
    expect(shell.textContent).not.toMatch(/PyMuPDF|Ghostscript|CoherentPDF/);
    expect(screen.queryByRole('button', { name: /engine/i })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('recent files', () => {
  it('caps the list, keeps the newest first and folds a repeat to the front', () => {
    for (let i = 0; i < RECENT_FILES_CAP + 3; i += 1) {
      recordRecentFiles([{ name: `file-${i}.pdf`, size: 1000 + i }], 'merge', 1_700_000_000_000 + i * 1000);
    }
    const capped = readRecentFiles();
    expect(capped).toHaveLength(RECENT_FILES_CAP);
    expect(capped[0].name).toBe(`file-${RECENT_FILES_CAP + 2}.pdf`);
    expect(capped[capped.length - 1].name).toBe('file-3.pdf');

    // Re-opening something already listed moves it, it does not duplicate.
    const again = recordRecentFiles([{ name: 'file-5.pdf', size: 1005 }], 'split', 1_900_000_000_000);
    expect(again).toHaveLength(RECENT_FILES_CAP);
    expect(again.filter((entry) => entry.name === 'file-5.pdf')).toHaveLength(1);
    expect(again[0]).toMatchObject({ name: 'file-5.pdf', toolId: 'split' });
  });

  it('stores metadata only — never file contents', () => {
    const big = new File([new Uint8Array(4096).fill(7)], 'scan with spaces.pdf', { type: 'application/pdf' });
    recordRecentFiles([big], 'scan-to-pdf');

    const raw = localStorage.getItem(RECENT_FILES_KEY) ?? '';
    const stored = JSON.parse(raw) as Record<string, unknown>[];
    expect(Object.keys(stored[0]).sort()).toEqual(['at', 'name', 'size', 'toolId']);
    expect(stored[0]).toMatchObject({ name: 'scan with spaces.pdf', size: 4096, toolId: 'scan-to-pdf' });
    expect(raw).not.toMatch(/content|base64|dataUrl|bytes|blob/i);
    expect(raw.length).toBeLessThan(200);
  });

  it('drops a malformed entry instead of throwing, and survives missing storage', () => {
    localStorage.setItem(RECENT_FILES_KEY, 'not json');
    expect(readRecentFiles()).toEqual([]);
    localStorage.setItem(
      RECENT_FILES_KEY,
      JSON.stringify([{ name: 'ok.pdf', size: 1, toolId: 'merge', at: 2 }, { nope: true }]),
    );
    expect(readRecentFiles()).toHaveLength(1);
  });

  it('records a file chosen while a tool is open', async () => {
    clearRecentFiles();
    renderShell('/tool/merge');

    const picked = new File(['%PDF-1.7'], 'dropped.pdf', { type: 'application/pdf' });
    const store = (await import('@/stores/file-store')).useFileStore;
    store.getState().setActiveTool('merge');
    store.getState().setFile(picked);

    await waitFor(() => expect(readRecentFiles().map((e) => e.name)).toContain('dropped.pdf'));
    expect(readRecentFiles()[0]).toMatchObject({ size: 8, toolId: 'merge' });
    store.getState().clearCurrent();
    store.getState().setFile(null);
  });
});

describe('starred tools', () => {
  it('toggles and persists under the namespaced key', () => {
    expect(toggleStarredTool('merge')).toEqual(['merge']);
    expect(localStorage.getItem(STARRED_TOOLS_KEY)).toContain('merge');
    expect(toggleStarredTool('sign')).toEqual(['merge', 'sign']);
    expect(toggleStarredTool('merge')).toEqual(['sign']);
    expect(readStarredTools()).toEqual(['sign']);
  });

  it('is set from the tool header and read back as the palette’s first band', async () => {
    renderShell('/tool/merge');

    const star = screen.getByRole('button', { name: 'Star Merge PDF' });
    expect(star.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(star);
    await waitFor(() => expect(readStarredTools()).toContain('merge'));

    const unstar = screen.getByRole('button', { name: 'Unstar Merge PDF' });
    expect(unstar.getAttribute('aria-pressed')).toBe('true');

    await openPalette();
    await waitFor(() => expect(groupLabels()[0]).toBe('Starred'));
    expect(options()[0].textContent).toContain('Merge PDF');

    // Unstarring from the header empties the band on the next open.
    fireEvent.keyDown(await searchField(), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Unstar Merge PDF' }));
    await waitFor(() => expect(readStarredTools()).toEqual([]));

    await openPalette();
    await waitFor(() => expect(groupLabels()).not.toContain('Starred'));
  });
});

describe('dark mode', () => {
  it('starts light and toggles the class on the document element', async () => {
    renderShell();

    expect(document.documentElement.classList.contains(DARK_CLASS)).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark mode' }));
    expect(document.documentElement.classList.contains(DARK_CLASS)).toBe(true);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    fireEvent.click(screen.getByRole('button', { name: 'Switch to light mode' }));
    expect(document.documentElement.classList.contains(DARK_CLASS)).toBe(false);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('restores the stored preference on the next load', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');

    const view = renderShell();
    await waitFor(() => expect(document.documentElement.classList.contains(DARK_CLASS)).toBe(true));
    expect(screen.getByRole('button', { name: 'Switch to light mode' })).toBeTruthy();
    view.unmount();
  });

  it('ignores a stored value it does not understand', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'sepia');
    renderShell();
    expect(document.documentElement.classList.contains(DARK_CLASS)).toBe(false);
  });
});

describe('tool page header', () => {
  it('shows the breadcrumb and the tool promise', () => {
    renderShell('/tool/linearize-pdf');

    const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    const crumbs = within(breadcrumb)
      .getAllByRole('listitem')
      .map((node) => node.textContent?.trim())
      .filter(Boolean);
    expect(crumbs[0]).toBe('BrowserSnip');
    expect(crumbs).toContain('PDF Tools');
    expect(crumbs).toContain('Optimize PDF');
    expect(crumbs).toContain('Linearize PDF');

    const tool = getPdfTool('linearize-pdf');
    const header = breadcrumb.closest('header');
    expect(header?.textContent).toContain(String(tool?.description));
  });

  it('names a video tool from the shared catalogue, not by its id', () => {
    renderShell('/tool/trim');
    // Regression: video tools are not in the PDF registry, so the header used to
    // print the raw id and point the breadcrumb at /pdf for a video page.
    expect(screen.getByTestId('tool-page')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Video Tools' })).toBeTruthy();
    // Named in the breadcrumb; the workspace keeps a screen-reader-only copy.
    expect(screen.getAllByText('Trim & Cut').length).toBeGreaterThan(0);
  });

  it('still names the page when nothing knows the id', () => {
    renderShell('/tool/not-a-real-tool');
    expect(screen.getByTestId('tool-page')).toBeTruthy();
    expect(screen.getAllByText(/not-a-real-tool/i).length).toBeGreaterThan(0);
  });
});

describe('degraded runs still speak', () => {
  it('names a skipped optional engine in the result surface', () => {
    // The engine chip is gone from the shell, so this is where "less happened"
    // has to be said. S2 owns the wording; the shell test only pins that the
    // surface can carry the sentence at all.
    const item = { name: 'linearized.pdf', blob: new Blob(['%PDF-1.7'], { type: 'application/pdf' }) };
    render(
      <ResultCard
        outputs={[item]}
        engine="cpdf"
        degraded
        warnings={['CoherentPDF was unreachable, so the file was rebuilt instead of linearized.']}
      />,
    );

    const card = screen.getByRole('region', { name: 'Result' });
    expect(card.textContent).toContain('degraded');
    expect(within(card).getByRole('listitem').textContent).toContain('was unreachable');
  });
});
