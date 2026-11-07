/**
 * The tool page's shape (worker SHELL-2).
 *
 * The user's verdict was that the tool pages "do not seem enhanced at all" next
 * to iLovePDF, and the reason was the page *shape*: a 320 px settings rail with
 * a small drop box beside a large preview pane, where the target is one oversized
 * button that is also the drop zone, then cards, then a result screen. These
 * tests pin that order, because it is the part a first impression judges:
 *
 * - the empty page is one centred title, one promise and one oversized button —
 *   no fields, no action, no preview, no rail;
 * - a drop anywhere on the tab is accepted, including outside the button;
 * - the loaded page is horizontal file cards (name, size, page count, remove,
 *   reorder, add more) with the options in a bottom bar and one big verb at its
 *   right edge;
 * - a run is centred progress that names the file and can be cancelled;
 * - the result is a screen of its own — checkmark, output name, size before →
 *   after, warnings, a dominant download, and two quiet ways onward;
 * - a failure prints its reason once, names the file, and offers Retry.
 *
 * jsdom has no canvas and no layout, so sizing is asserted through the classes
 * that ask for it (`min-h-[88px]`) and images through the `data-*` state markers,
 * never through pixels.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { useFileStore } from '@/stores/file-store';
import { useProcessStore } from '@/stores/process-store';
import { PdfToolPanel } from '@/components/tools/pdf/shared/PdfToolPanel';
import { ToolWorkspace } from '@/components/layout/ToolWorkspace';
import { describeOptions, verbFor } from '@/components/tools/pdf/shared/toolForm';
import { intakeCopy } from '@/components/tools/pdf/shared/FileIntake';
import { surfaceState } from '@/components/tools/pdf/shared/ToolSurface';
import type { PdfToolDefinition, ToolField } from '@/lib/pdf/tools/types';

// ── module mocks ────────────────────────────────────────────────────────────

/** Thumbnail rasters are pumped by hand: jsdom has no 2-D context. */
vi.mock('@/lib/pdf/core/render', () => ({
  openRender: vi.fn(async () => ({
    numPages: 2,
    fingerprint: 'shell-session',
    page: async () => ({ getViewport: () => ({ width: 612, height: 792, rotation: 0 }), cleanup() {} }),
    renderToCanvas: async () => ({}),
    destroy: async () => {},
  })),
  thumbnails: vi.fn(async (_session: unknown, options: { pages?: number[] }) =>
    (options?.pages ?? []).map(() => ''),
  ),
}));

const CUSTOM_VIEWS: Record<string, () => JSX.Element> = {
  organize: () => <div data-organizer="true">The organizer</div>,
};

// The real catalogue is spread in so `TOOLS`, `PDF_TOOLS` and the bespoke-view
// map keep working; only the tools these tests drive are replaced.
vi.mock('@/lib/pdf/tools/registry', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/pdf/tools/registry')>();
  return {
    ...real,
    getPdfTool: (id?: string | null) => (id && STANDS[id] ? STANDS[id] : real.getPdfTool(id)),
    hasCustomMainView: (id: string) => id in CUSTOM_VIEWS || real.hasCustomMainView(id),
    mainViewFor: (id: string) => CUSTOM_VIEWS[id] ?? real.mainViewFor(id),
  };
});

// ── fixtures ────────────────────────────────────────────────────────────────

const ownerField: ToolField = { key: 'owner', label: 'Owner name', type: 'text', required: true, group: 'Marks' };
const dpiField: ToolField = {
  key: 'dpi',
  label: 'Resolution',
  type: 'number',
  unit: 'dpi',
  min: 72,
  max: 300,
  default: 150,
  group: 'Quality',
};

/** What the last fake run was given, and the gate that lets it finish. */
const live: { release: (() => void) | null } = { release: null };

function bytes(size: number): Uint8Array {
  return new TextEncoder().encode('x'.repeat(size));
}

function heldRun(result: { size: number; message: string }) {
  return async (context: { progress: (fraction: number, message?: string) => void }) => {
    context.progress(0, 'Reading the file');
    await new Promise<void>((resolve) => {
      live.release = resolve;
    });
    return { kind: 'pdf' as const, bytes: bytes(result.size), message: result.message };
  };
}

const STANDS: Record<string, PdfToolDefinition> = {
  'shell-compress': {
    id: 'shell-compress',
    name: 'Compress Shell',
    description: 'Shrink the file',
    icon: '🗜',
    category: 'optimize',
    outputSuffix: '_compressed.pdf',
    promise: 'Rewrites the file smaller, and shows the exact size before and after.',
    fields: [dpiField, ownerField],
    notes: ['Recompression is lossy: text stays sharp, photos blur.'],
    run: heldRun({ size: 400, message: 'Smaller now.' }),
  },
  'shell-merge': {
    id: 'shell-merge',
    name: 'Merge Shell',
    description: 'Combine PDFs in order',
    icon: '🧩',
    category: 'organize',
    multiFile: true,
    outputSuffix: '_merged.pdf',
    run: heldRun({ size: 200, message: 'One file now.' }),
  },
  'shell-repair': {
    id: 'shell-repair',
    name: 'Repair Shell',
    description: 'Fix a broken file',
    icon: '🔧',
    category: 'optimize',
    outputSuffix: '_repaired.pdf',
    run: heldRun({ size: 100, message: 'Rebuilt.' }),
  },
  'shell-broken': {
    id: 'shell-broken',
    name: 'Convert Shell',
    description: 'Refuse a file that is not a PDF',
    icon: '🛡',
    category: 'convert-from',
    outputSuffix: '_converted.pdf',
    run: async () => {
      throw new Error('"scan.jpg" is not a PDF.');
    },
  },
  'shell-images': {
    id: 'shell-images',
    name: 'Images Shell',
    description: 'Turn photos into a PDF',
    icon: '🖼',
    category: 'convert-to',
    inputKind: 'image',
    multiFile: true,
    accept: '.jpg,.jpeg,.png,image/*',
    outputSuffix: '_from_images.pdf',
    run: heldRun({ size: 100, message: 'Pages added.' }),
  },
};

/** A real 2-page PDF, so the pre-flight can read the page count out of it. */
async function realPdf(name = 'shell.pdf'): Promise<File> {
  const { PDFDocument } = await import('@maxwbh/pdf-lib');
  const doc = await PDFDocument.create();
  doc.addPage([300, 200]);
  doc.addPage([300, 200]);
  const saved = await doc.save();
  return new File([saved as unknown as BlobPart], name, { type: 'application/pdf' });
}

function loadFiles(files: File[]): void {
  act(() => {
    useFileStore.setState({ file: files[0] ?? null, files, metadata: null });
  });
}

function surface(): Element | null {
  return document.querySelector('[data-surface]');
}

/** A file drag over the tab, with the shape the browser actually delivers. */
function dispatchDrag(type: string, target: Window | Element, files: File[]): void {
  const dataTransfer = { files, types: files.length > 0 ? ['Files'] : [], dropEffect: '', effectAllowed: '' };
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  target.dispatchEvent(event);
}

function dropFiles(files: File[], target: Window | Element = window): void {
  // Not `fireEvent`: the listener lives on `window`, and the store write it makes
  // has to land inside the same act() as the re-render it causes.
  act(() => {
    dispatchDrag('dragenter', target, files);
    dispatchDrag('dragover', target, files);
    dispatchDrag('drop', target, files);
  });
}

/**
 * One step of a card-to-card reorder drag.
 *
 * `fireEvent` drops `clientX` from a drag event in jsdom, and the landing gap is
 * decided from the pointer's x against the card's middle, so the event is built
 * by hand.
 */
function dragCard(type: string, node: Element, clientX: number): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX });
  Object.defineProperty(event, 'dataTransfer', {
    value: { setData: () => {}, getData: () => '', dropEffect: '', effectAllowed: 'move' },
  });
  act(() => {
    node.dispatchEvent(event);
  });
}

/** Let the held run finish, flushing the work its continuation queues. */
async function release(): Promise<void> {
  await waitFor(() => expect(live.release).toBeTypeOf('function'));
  await act(async () => {
    live.release?.();
    live.release = null;
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeAll(() => {
  URL.createObjectURL = vi.fn(() => 'blob:shell') as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  live.release = null;
  useProcessStore.getState().reset();
  useProcessStore.setState({ activeTool: null, sessions: {}, notice: null });
  useFileStore.setState({ file: null, files: [], metadata: null, activeTool: null, sessions: {} });
});

// ── the machine ─────────────────────────────────────────────────────────────

describe('surfaceState', () => {
  it('holds the action back until a file exists', () => {
    expect(surfaceState({ hasFiles: false, phase: 'idle', isProcessing: false, outputs: 0 })).toBe('intake');
    expect(surfaceState({ hasFiles: true, phase: 'ready', isProcessing: false, outputs: 0 })).toBe('ready');
  });

  it('puts a run in flight, and its result, above everything else', () => {
    expect(
      surfaceState({ hasFiles: true, phase: 'running', isProcessing: true, outputs: 0 }),
    ).toBe('running');
    expect(surfaceState({ hasFiles: true, phase: 'done', isProcessing: false, outputs: 2 })).toBe('result');
    // A report is an answer, so it earns the result screen too.
    expect(
      surfaceState({ hasFiles: true, phase: 'done', isProcessing: false, outputs: 0, hasReport: true }),
    ).toBe('result');
    // Nothing produced and nothing reported is not a success screen (E13).
    expect(surfaceState({ hasFiles: true, phase: 'done', isProcessing: false, outputs: 0 })).toBe('ready');
    expect(surfaceState({ hasFiles: true, phase: 'error', isProcessing: false, outputs: 0 })).toBe('error');
    // A cancel leaves the files where they are, so the page is the loaded one.
    expect(surfaceState({ hasFiles: true, phase: 'idle', isProcessing: false, outputs: 0 })).toBe('ready');
  });
});

// ── the empty page ──────────────────────────────────────────────────────────

describe('the empty page', () => {
  it('is one oversized drop button and nothing else', async () => {
    render(<PdfToolPanel toolId="shell-compress" />);
    expect(surface()).toHaveAttribute('data-surface', 'intake');

    const pick = await screen.findByRole('button', { name: /^Select PDF file/ });
    // The button is the drop zone, and it is the size of a primary action.
    expect(pick).toHaveAttribute('data-drop-target', 'true');
    expect(pick).toHaveClass('min-h-[88px]');
    expect(screen.getByText('or drop a PDF here')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Compress Shell' })).toBeInTheDocument();
    expect(screen.getByText(/size before and after/)).toBeInTheDocument();

    // No rail, no fields, no action, no preview, no progress.
    expect(document.querySelector('aside')).toBeNull();
    expect(document.getElementById('tool-process-btn')).toBeNull();
    expect(screen.queryByLabelText('Owner name')).toBeNull();
    expect(screen.queryByLabelText('Resolution')).toBeNull();
    expect(document.querySelector('[data-run-bar]')).toBeNull();
    expect(document.querySelector('[role="progressbar"]')).toBeNull();
    expect(document.querySelector('[data-options-panel]')).toBeNull();
  });

  it('names the format the tool actually takes', () => {
    expect(intakeCopy(undefined, false)).toEqual({
      pick: 'Select PDF file',
      drop: 'or drop a PDF here',
      noun: 'a PDF',
      many: 'PDFs',
    });
    expect(intakeCopy('.pdf,application/pdf', true).pick).toBe('Select PDF files');
    expect(intakeCopy('.jpg,.jpeg,.png,image/*', true)).toEqual({
      pick: 'Select images',
      drop: 'or drop images here',
      noun: 'images',
      many: 'images',
    });
    expect(intakeCopy('.docx', false).pick).toBe('Select file');
  });

  it('accepts a drop released anywhere on the tab', async () => {
    render(<PdfToolPanel toolId="shell-compress" />);
    await screen.findByRole('button', { name: /^Select PDF file/ });

    // The drop lands on `window`, well outside the button, and is still taken.
    dropFiles([await realPdf()]);

    expect(useFileStore.getState().files.map((file) => file.name)).toEqual(['shell.pdf']);
    expect(surface()).toHaveAttribute('data-surface', 'ready');
  });

  it('ignores an in-app drag that carries no files', async () => {
    render(<PdfToolPanel toolId="shell-merge" />);
    await screen.findByRole('button', { name: /^Select PDF files/ });
    dropFiles([]);
    expect(useFileStore.getState().files).toHaveLength(0);
    expect(surface()).toHaveAttribute('data-surface', 'intake');
  });

  it('takes one file for a one-document tool and says which it kept', async () => {
    render(<PdfToolPanel toolId="shell-compress" />);
    await screen.findByRole('button', { name: /^Select PDF file/ });
    dropFiles([await realPdf('a.pdf'), await realPdf('b.pdf')]);
    expect(useFileStore.getState().files.map((file) => file.name)).toEqual(['a.pdf']);
    expect(useProcessStore.getState().notice).toMatch(/one file at a time.*"a\.pdf"/);
  });

  it('adds to the queue for a multi-document tool', async () => {
    loadFiles([await realPdf('one.pdf')]);
    render(<PdfToolPanel toolId="shell-merge" />);
    await screen.findByText('one.pdf');
    dropFiles([await realPdf('two.pdf')]);
    expect(useFileStore.getState().files.map((file) => file.name)).toEqual(['one.pdf', 'two.pdf']);
  });
});

// ── the loaded page ─────────────────────────────────────────────────────────

describe('the loaded page', () => {
  it('shows a card per file with the numbers that identify it', async () => {
    loadFiles([await realPdf('shell.pdf')]);
    render(<PdfToolPanel toolId="shell-compress" />);

    const card = await screen.findByText('shell.pdf');
    const list = card.closest('ol') as HTMLElement;
    expect(list).toHaveAttribute('aria-label', 'Files in this job');
    // The page count comes from the pre-flight, not from a guess (E6/E7).
    await waitFor(() => expect(list.textContent).toContain('2 pages'));
    expect(list.textContent).toMatch(/\d+(\.\d+)? (B|KB|MB)/);
    expect(screen.getByRole('button', { name: 'Remove shell.pdf' })).toBeInTheDocument();
    // One document: nothing to reorder, so no position controls.
    expect(screen.queryByLabelText('Move shell.pdf later')).toBeNull();
  });

  it('brings the options, and only the options, out when a file exists', async () => {
    loadFiles([await realPdf()]);
    render(<PdfToolPanel toolId="shell-compress" />);

    const bar = await waitFor(() => {
      const node = document.querySelector('[data-run-bar]');
      if (!node) throw new Error('the bottom bar never mounted');
      return node as HTMLElement;
    });
    expect(screen.getByLabelText('Owner name')).toBeInTheDocument();
    expect(screen.getByLabelText('Resolution')).toBeInTheDocument();
    // The honesty panel is part of the loaded page too.
    expect(within(bar).getByRole('button', { name: /Honest notes/ })).toBeInTheDocument();
    // A collapsed panel still names what is set.
    fireEvent.click(within(bar).getByRole('button', { name: /Hide options/ }));
    expect(screen.queryByLabelText('Owner name')).toBeNull();
    expect(within(bar).getByRole('status').textContent).not.toMatch(/Owner name/);
  });

  it('pins one giant verb to the right of the bar', async () => {
    loadFiles([await realPdf()]);
    render(<PdfToolPanel toolId="shell-compress" />);
    const button = await screen.findByRole('button', { name: 'Compress' });
    expect(button).toHaveClass('min-h-[72px]');
    expect(button.closest('[data-run-bar]')).not.toBeNull();
    // The CTA is last in the bar, so it sits at the right edge.
    const actions = button.parentElement?.querySelectorAll('button') ?? [];
    expect(actions[actions.length - 1]).toBe(button);
  });

  it('reorders by drag and by key for a multi-file tool', async () => {
    loadFiles([await realPdf('one.pdf'), await realPdf('two.pdf')]);
    render(<PdfToolPanel toolId="shell-merge" />);
    await screen.findByText('one.pdf');

    fireEvent.click(screen.getByLabelText('Move two.pdf earlier'));
    expect(useFileStore.getState().files.map((file) => file.name)).toEqual(['two.pdf', 'one.pdf']);

    // The same gesture with the pointer: grab the first card, drop it after the
    // second, and the queue flips back. (jsdom measures every card at 0×0, so any
    // positive x is past its middle.)
    const cards = [...document.querySelectorAll('[data-card]')];
    dragCard('dragstart', cards[0], 10);
    expect(document.querySelectorAll('[data-drop-gap]').length).toBeGreaterThan(0);
    dragCard('dragover', cards[1], 500);
    dragCard('drop', cards[1], 500);
    expect(useFileStore.getState().files.map((file) => file.name)).toEqual(['one.pdf', 'two.pdf']);

    // A drag let go outside a card changes nothing.
    dragCard('dragstart', cards[0], 10);
    dragCard('dragend', cards[0], 900);
    expect(useFileStore.getState().files.map((file) => file.name)).toEqual(['one.pdf', 'two.pdf']);
  });

  it('offers an add-more card that reopens the picker', async () => {
    loadFiles([await realPdf('one.pdf')]);
    render(<PdfToolPanel toolId="shell-merge" />);
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    fireEvent.click(await screen.findByRole('button', { name: /Add more/ }));
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });

  it('keeps the space under the queue a drop target for a multi-file tool', async () => {
    loadFiles([await realPdf('one.pdf')]);
    render(<PdfToolPanel toolId="shell-merge" />);
    const zone = await screen.findByRole('button', { name: /Drop more PDFs here/ });
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    fireEvent.click(zone);
    expect(click).toHaveBeenCalled();
    click.mockRestore();

    // A one-document tool has nothing to add, so it does not pretend otherwise.
    cleanup();
    loadFiles([await realPdf('one.pdf')]);
    render(<PdfToolPanel toolId="shell-compress" />);
    await screen.findByText('one.pdf');
    expect(screen.queryByRole('button', { name: /Drop more/ })).toBeNull();
  });

  it('removes the last file back to the drop zone', async () => {
    loadFiles([await realPdf('shell.pdf')]);
    render(<PdfToolPanel toolId="shell-compress" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove shell.pdf' }));
    expect(useFileStore.getState().files).toHaveLength(0);
    expect(surface()).toHaveAttribute('data-surface', 'intake');
  });
});

// ── a run, and what it leaves behind ────────────────────────────────────────

describe('the run', () => {
  it('centres the progress, names the file and keeps cancel in reach', async () => {
    loadFiles([await realPdf('shell.pdf')]);
    render(<PdfToolPanel toolId="shell-repair" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Repair' }));

    await waitFor(() => expect(surface()).toHaveAttribute('data-surface', 'running'));
    const pane = document.querySelector('[data-running]') as HTMLElement;
    expect(within(pane).getByText(/shell\.pdf/)).toBeInTheDocument();
    // Stage, share and denominator are said once, by one live region and one bar.
    expect(pane.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(pane.querySelectorAll('[role="progressbar"]')).toHaveLength(1);
    await waitFor(() => expect(pane.textContent).toContain('Reading the file'));
    expect(within(pane).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();

    fireEvent.click(within(pane).getByRole('button', { name: 'Cancel' }));
    expect(useProcessStore.getState().notice).toBe('Cancelled — nothing was saved.');
    // A cancel is not a failure: no alert, and the page is back on the cards.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(surface()).toHaveAttribute('data-surface', 'ready');
    await release();
  });

  it('ends on a success screen that proves what happened', async () => {
    const input = await realPdf('shell.pdf');
    loadFiles([input]);
    render(<PdfToolPanel toolId="shell-compress" />);
    fireEvent.change(await screen.findByLabelText('Owner name'), { target: { value: 'ACME' } });
    fireEvent.click(screen.getByRole('button', { name: 'Compress' }));
    await release();

    await waitFor(() => expect(surface()).toHaveAttribute('data-surface', 'result'));
    const pane = document.querySelector('[data-result]') as HTMLElement;
    expect(pane.querySelector('[data-checkmark]')).not.toBeNull();
    expect(within(pane).getByRole('heading', { level: 1 })).toHaveTextContent('Your file is ready');

    const card = await screen.findByRole('region', { name: 'Result' });
    expect(card.textContent).toContain('shell_compressed.pdf');
    // Bytes in, bytes out, and the difference stated as a difference (E14).
    expect(card.textContent).toMatch(/\d+(\.\d+)? (B|KB) → \d+(\.\d+)? (B|KB) · \d+% smaller/);
    expect(card.textContent).toContain('2 in · out not counted');
    expect(card.textContent).toContain('Smaller now.');

    const download = within(card).getByRole('button', { name: 'Download' });
    expect(download).toHaveClass('min-h-[56px]');

    // Two quiet ways onward, and the drop zone is gone: nobody wonders if it worked.
    expect(within(pane).getByRole('button', { name: 'Do another' })).toBeInTheDocument();
    expect(within(pane).getByRole('link', { name: 'Back to all tools' })).toHaveAttribute('href', '#/pdf');
  });

  it('prints what the run could not do beside the download', async () => {
    loadFiles([await realPdf('shell.pdf')]);
    render(<PdfToolPanel toolId="shell-compress" />);
    fireEvent.change(await screen.findByLabelText('Owner name'), { target: { value: 'ACME' } });
    fireEvent.click(screen.getByRole('button', { name: 'Compress' }));
    await release();
    // A run that had to compromise says so on the screen that claims success.
    act(() =>
      useProcessStore.getState().addWarning('Ghostscript could not be reached — the core path was degraded.'),
    );
    const card = await screen.findByRole('region', { name: 'Result' });
    expect(card.textContent).toContain('Ghostscript could not be reached');
    expect(card.textContent).toMatch(/degraded/);
  });

  it('starts a new job from the success screen', async () => {
    loadFiles([await realPdf('shell.pdf')]);
    render(<PdfToolPanel toolId="shell-repair" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Repair' }));
    await release();
    await waitFor(() => expect(surface()).toHaveAttribute('data-surface', 'result'));

    fireEvent.click(screen.getByRole('button', { name: 'Do another' }));
    expect(useFileStore.getState().files).toHaveLength(0);
    expect(useProcessStore.getState().outputBlobs).toHaveLength(0);
    expect(surface()).toHaveAttribute('data-surface', 'intake');
    expect(screen.getByRole('button', { name: /^Select PDF file/ })).toBeInTheDocument();
  });

  it('names the file that broke, once, with a way back in', async () => {
    loadFiles([await realPdf('shell.pdf')]);
    render(<PdfToolPanel toolId="shell-broken" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Convert' }));

    await waitFor(() => expect(surface()).toHaveAttribute('data-surface', 'error'));
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].textContent).toContain('shell.pdf');
    expect(alerts[0].textContent).toContain('is not a PDF');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    // The card and the CTA stay, so the file can be swapped without hunting.
    expect(document.querySelectorAll('[data-card]')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Convert' })).toBeInTheDocument();
  });
});

// ── bespoke surfaces keep their editors ─────────────────────────────────────

describe('ToolWorkspace', () => {
  function page(toolId: string): void {
    render(
      <MemoryRouter initialEntries={[`/tool/${toolId}`]}>
        <Routes>
          <Route path="/tool/:toolId" element={<ToolWorkspace />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('gives a generated tool the whole page, with no rail', async () => {
    page('merge');
    expect(await screen.findByRole('button', { name: /^Select PDF file/ })).toBeInTheDocument();
    expect(document.querySelector('aside')).toBeNull();
    expect(document.querySelector('[data-options-panel]')).toBeNull();
  });

  it('opens a bespoke surface on the same drop zone, not on its canvas', async () => {
    page('organize');
    expect(await screen.findByRole('button', { name: /^Select PDF file/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Organize PDF' })).toBeInTheDocument();
    expect(document.querySelector('[data-organizer]')).toBeNull();
    expect(document.querySelector('aside')).toBeNull();
  });

  it('hands an image-input surface its own pane, which works with nothing loaded', async () => {
    page('image-to-pdf');
    expect(await screen.findByRole('button', { name: /^Select images/ })).toBeInTheDocument();
  });
});

// ── the vocabulary the page is built from ───────────────────────────────────

describe('toolForm', () => {
  it('names what is set when the options are collapsed', () => {
    expect(
      describeOptions([dpiField, ownerField, { key: 'on', label: 'Greyscale', type: 'toggle', default: false }], {
        dpi: 150,
        owner: '',
        on: false,
      }),
    ).toBe('Resolution: 150 dpi · Owner name: none · Greyscale: off');
    // A password never echoes back.
    expect(
      describeOptions([{ key: 'password', label: 'Current password', type: 'password' }], { password: 'hunter2' }),
    ).toBe('');
  });

  it('keeps the verb a giant button wears in the imperative', () => {
    expect(verbFor(STANDS['shell-compress'])).toBe('Compress');
    expect(verbFor(STANDS['shell-merge'])).toBe('Merge');
  });
});
