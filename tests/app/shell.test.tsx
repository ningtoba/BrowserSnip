/**
 * App shell affordances: ⌘K palette, category rail, recents/stars, dark mode.
 *
 * The palette and the rail are only useful if the keyboard works and the state
 * survives a reload, so those are the two things asserted hardest here. Nothing
 * in this file depends on canvas or on a real viewport — `matchMedia` is stubbed,
 * which is also how the rail/drawer split is exercised.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { PALETTE_LIMIT, fuzzyScore, searchPalette } from '@/components/layout/CommandPalette';
import { PDF_CATEGORIES, PDF_TOOLS, getPdfTool, toolsByCategory } from '@/lib/pdf/tools/registry';
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
 * Install a `matchMedia` that answers one query.
 *
 * jsdom always reports "no match", which would silently pin every test to the
 * drawer branch of the layout. `rail: true` is the desktop width the rail was
 * designed for.
 */
function stubMatchMedia({ rail }: { rail: boolean }) {
  window.matchMedia = ((query: string) => ({
    media: query,
    matches: rail && query === '(min-width: 1024px)',
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

function openPalette() {
  fireEvent.keyDown(window, { key: 'k', metaKey: true });
  return screen.findByRole('dialog', { name: 'Search tools' });
}

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
    stubMatchMedia({ rail: true });
    renderShell();

    await openPalette();
    const field = await screen.findByRole('combobox', { name: 'Search tools' });

    fireEvent.change(field, { target: { value: 'merge' } });
    const listbox = screen.getByRole('listbox', { name: 'Matching tools' });
    await waitFor(() => {
      expect(within(listbox).getAllByRole('option').some((node) => (node.textContent ?? '').includes('Merge PDF'))).toBe(true);
    });

    fireEvent.keyDown(field, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('opens on Ctrl-K as well as ⌘K, and toggles closed on the second press', async () => {
    stubMatchMedia({ rail: true });
    renderShell();

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(await screen.findByRole('dialog', { name: 'Search tools' })).toBeTruthy();

    fireEvent.keyDown(window, { key: 'K', ctrlKey: true });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('moves the selection with the arrow keys and opens with Enter', async () => {
    stubMatchMedia({ rail: true });
    renderShell();

    await openPalette();
    const field = await screen.findByRole('combobox', { name: 'Search tools' });
    fireEvent.change(field, { target: { value: 'convert' } });

    const listbox = await waitFor(() => {
      const node = screen.getByRole('listbox', { name: 'Matching tools' });
      expect(within(node).getAllByRole('option').length).toBeGreaterThan(1);
      return node;
    });
    const options = () => within(listbox).getAllByRole('option');
    const selected = () => options().findIndex((node) => node.getAttribute('aria-selected') === 'true');

    expect(selected()).toBe(0);
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    expect(selected()).toBe(1);
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    expect(selected()).toBe(2);
    fireEvent.keyDown(field, { key: 'ArrowUp' });
    expect(selected()).toBe(1);

    // Typing a new query must not leave the caret pointing at a stale row.
    fireEvent.change(field, { target: { value: 'merge' } });
    expect(selected()).toBe(0);

    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('tool-page')).toBeTruthy());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('says so when nothing matches', async () => {
    stubMatchMedia({ rail: true });
    renderShell();

    await openPalette();
    const field = await screen.findByRole('combobox', { name: 'Search tools' });
    fireEvent.change(field, { target: { value: 'qqqzzzxxx' } });

    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('No tools match');
    expect(screen.queryByRole('option')).toBeNull();
  });
});

describe('category rail', () => {
  it('lists every category with a count from the registry and collapses on click', async () => {
    stubMatchMedia({ rail: true });
    renderShell();

    for (const category of PDF_CATEGORIES) {
      const tools = toolsByCategory(category.id);
      const toggle = screen.getByRole('button', { name: `${category.label} (${tools.length} tools)` });
      expect(toggle.textContent).toContain(String(tools.length));
    }

    const mergeToggle = screen.getByRole('button', { name: `Organize PDF (${toolsByCategory('organize').length} tools)` });
    expect(mergeToggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(mergeToggle);
    expect(mergeToggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: 'Merge PDF' })).toBeTruthy();
    fireEvent.click(mergeToggle);
    expect(screen.queryByRole('button', { name: 'Merge PDF' })).toBeNull();
  });

  it('expands the category of the current tool and highlights it', () => {
    stubMatchMedia({ rail: true });
    renderShell('/tool/merge');

    const toggle = screen.getByRole('button', { name: `Organize PDF (${toolsByCategory('organize').length} tools)` });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    const current = screen.getByRole('button', { name: 'Merge PDF' });
    expect(current.getAttribute('aria-current')).toBe('page');
    expect(current.className).toContain('shell-row-active');
  });

  it('stays out of the way on a narrow viewport', () => {
    stubMatchMedia({ rail: false });
    renderShell();

    expect(screen.queryByRole('button', { name: /Organize PDF \(/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Toggle tools menu' })).toBeTruthy();
  });

  it('reaches the rail through the mobile drawer', () => {
    stubMatchMedia({ rail: false });
    renderShell();

    fireEvent.click(screen.getByRole('button', { name: 'Toggle tools menu' }));
    expect(screen.getByRole('button', { name: /Organize PDF \(/ })).toBeTruthy();
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

  it('shows picks in the rail and Clear removes them', async () => {
    stubMatchMedia({ rail: true });
    recordRecentFiles([{ name: 'Quarterly Report.pdf', size: 2_500_000 }], 'merge', Date.now());
    renderShell();

    const section = (await screen.findByText('Quarterly Report.pdf')).closest('button');
    expect(section?.textContent).toContain('Merge PDF');
    expect(section?.textContent).toContain('MB');

    fireEvent.click(screen.getByRole('button', { name: 'Clear recent files' }));
    expect(localStorage.getItem(RECENT_FILES_KEY)).toBeNull();
    await waitFor(() => expect(screen.queryByText('Quarterly Report.pdf')).toBeNull());
  });

  it('records a file chosen while a tool is open', async () => {
    stubMatchMedia({ rail: true });
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

  it('opens the tool again when a recent row is clicked', async () => {
    stubMatchMedia({ rail: true });
    recordRecentFiles([{ name: 'a.pdf', size: 10 }], 'split', Date.now());
    renderShell();

    fireEvent.click(await screen.findByText('a.pdf'));
    expect(await screen.findByTestId('tool-page')).toBeTruthy();
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

  it('pins a tool from the rail and unstars it again', async () => {
    stubMatchMedia({ rail: true });
    renderShell();

    fireEvent.click(screen.getByRole('button', { name: /Organize PDF \(/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Star Merge PDF' }));

    expect(JSON.parse(localStorage.getItem(STARRED_TOOLS_KEY) ?? '[]')).toContain('merge');
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Unstar Merge PDF' })).toHaveLength(2));
    const pinned = screen.getAllByRole('button', { name: 'Unstar Merge PDF' })[0];
    expect(pinned.getAttribute('aria-pressed')).toBe('true');
    // The tool is now listed under Starred as well as inside its own category.
    const starredSection = (screen.getByText('Starred').closest('section') ?? document.body)
      .querySelectorAll('button');
    expect([...starredSection].some((node) => node.getAttribute('aria-label') === 'Unstar Merge PDF')).toBe(true);

    fireEvent.click(
      within(screen.getByText('Starred').closest('section') as HTMLElement).getByRole('button', {
        name: 'Unstar Merge PDF',
      }),
    );
    await waitFor(() => expect(readStarredTools()).toEqual([]));
  });
});

describe('dark mode', () => {
  it('starts light and toggles the class on the document element', async () => {
    stubMatchMedia({ rail: true });
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
    stubMatchMedia({ rail: true });
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');

    const view = renderShell();
    await waitFor(() => expect(document.documentElement.classList.contains(DARK_CLASS)).toBe(true));
    expect(screen.getByRole('button', { name: 'Switch to light mode' })).toBeTruthy();
    view.unmount();
  });

  it('ignores a stored value it does not understand', () => {
    stubMatchMedia({ rail: true });
    localStorage.setItem(THEME_STORAGE_KEY, 'sepia');
    renderShell();
    expect(document.documentElement.classList.contains(DARK_CLASS)).toBe(false);
  });
});

describe('tool page header', () => {
  it('shows a breadcrumb, the tool promise and the engines it needs', () => {
    stubMatchMedia({ rail: true });
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
    expect(header?.textContent).toContain('CoherentPDF');
    expect((tool?.engines ?? []).length).toBeGreaterThan(0);
  });

  it('leaves the engine badge off tools that need nothing optional', () => {
    stubMatchMedia({ rail: true });
    renderShell('/tool/merge');
    const header = screen.getByRole('navigation', { name: 'Breadcrumb' }).closest('header');
    expect(header?.textContent).not.toMatch(/PyMuPDF|Ghostscript|CoherentPDF/);
    expect(header?.textContent).toContain('Merge PDF');
  });

  it('names a video tool from the shared catalogue, not by its id', () => {
    stubMatchMedia({ rail: true });
    renderShell('/tool/trim');
    // Regression: video tools are not in the PDF registry, so the header used to
    // print the raw id and point the breadcrumb at /pdf for a video page.
    expect(screen.getByTestId('tool-page')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Video Tools' })).toBeTruthy();
    // Named in the breadcrumb; the workspace keeps a screen-reader-only copy.
    expect(screen.getAllByText('Trim & Cut').length).toBeGreaterThan(0);
  });

  it('still names the page when nothing knows the id', () => {
    stubMatchMedia({ rail: true });
    renderShell('/tool/not-a-real-tool');
    expect(screen.getByTestId('tool-page')).toBeTruthy();
    expect(screen.getAllByText(/not-a-real-tool/i).length).toBeGreaterThan(0);
  });
});
