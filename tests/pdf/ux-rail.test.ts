/**
 * The rail as the whole chrome (worker M5).
 *
 * With the sidebar gone, this column is the only place a user reads state, so
 * these tests pin the promises the UX brief makes about it:
 *
 * - a disabled primary action is paired with exactly one imperative reason,
 *   attached to the button, not floating in the panel;
 * - the run speaks through one `role="status"` region, in stage names, and
 *   admits when there is no denominator to divide by;
 * - a cancel, and a result that arrives after one, produce nothing (E19);
 * - a result is reported in checkable numbers and never claims a shrink that
 *   did not happen (E14);
 * - previews and thumbnails say what they are doing instead of showing white;
 * - every control in the rail has a keyboard focus ring.
 *
 * jsdom has no canvas, so nothing here asserts on pixels — only on model,
 * state-machine and DOM invariants. The file is `*.test.ts`, so JSX is written
 * with `createElement`, and every fake run waits for an explicit `release()`
 * so a mid-run assertion can never race the timer it is racing.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { createElement as h } from 'react';
import { useProcessStore } from '@/stores/process-store';
import { useFileStore } from '@/stores/file-store';
import { usePdfTool } from '@/hooks/usePdfTool';
import { ToolInputError } from '@/lib/pdf/core/guard';
import * as renderLib from '@/lib/pdf/core/render';
import type { PdfSession } from '@/lib/pdf/core/render';
import {
  OutputPreview,
  PREVIEW_PAGE_LIMIT,
  previewPages,
} from '@/components/tools/pdf/shared/OutputPreview';
import { ErrorPanel, readableMessage } from '@/components/tools/pdf/shared/ErrorPanel';
import { FileQueue, type FileQueueItem } from '@/components/tools/pdf/shared/FileQueue';
import { PageThumbs } from '@/components/tools/pdf/shared/PageThumbs';
import { PreviewPane, zoomAnchorScroll } from '@/components/tools/pdf/shared/PreviewPane';
import { ProgressBar } from '@/components/tools/pdf/shared/ProgressBar';
import { PdfToolPanel } from '@/components/tools/pdf/shared/PdfToolPanel';
import { ResultCard, describePages, honestSummary } from '@/components/tools/pdf/shared/ResultCard';
import { runStatusText } from '@/components/tools/pdf/shared/toolForm';
import type { PdfToolDefinition, ToolField } from '@/lib/pdf/tools/types';

// ── module mocks ────────────────────────────────────────────────────────────

/**
 * The render module, replaced with a hand-pumped queue: every thumbnail and
 * every page paint stays pending until the test resolves it, which is the only
 * way to observe the states between "asked" and "drawn".
 */
const queue: { thumbs: Array<(urls: string[]) => void>; paints: Array<() => void> } = {
  thumbs: [],
  paints: [],
};

vi.mock('@/lib/pdf/core/render', () => ({
  openRender: vi.fn(async () => ({
    numPages: 3,
    fingerprint: 'rail-ux-session',
    page: async () => ({ getViewport: () => ({ width: 612, height: 792, rotation: 0 }), cleanup() {} }),
    renderToCanvas: () => new Promise<void>((resolve) => queue.paints.push(resolve)),
    destroy: async () => {},
  })),
  thumbnails: vi.fn(() => new Promise<string[]>((resolve) => queue.thumbs.push(resolve))),
}));

// ── fixtures ────────────────────────────────────────────────────────────────

const qualityField: ToolField = {
  key: 'dpi',
  label: 'Resolution',
  type: 'number',
  unit: 'dpi',
  min: 72,
  max: 300,
  default: 150,
  group: 'Quality',
};

const ownerField: ToolField = { key: 'owner', label: 'Owner name', type: 'text', required: true, group: 'Marks' };

/** The password field a security tool declares for itself. */
const passwordField: ToolField = { key: 'password', label: 'Current password', type: 'password', group: 'Password' };

const presetField: ToolField = {
  key: 'preset',
  label: 'Preset',
  type: 'segmented',
  default: 'light',
  options: [
    { value: 'light', label: 'Light' },
    { value: 'strong', label: 'Strong', hint: 'Slower, smaller' },
  ],
};

/** What the last fake run reported, and the gate that lets it finish. */
const live: {
  context?: { progress: (fraction: number, message?: string) => void };
  release: (() => void) | null;
} = { context: undefined, release: null };

function pdfBytes(size: number): Uint8Array {
  return new TextEncoder().encode('x'.repeat(size));
}

/**
 * A run that reports one stage with no denominator, then waits to be released.
 * Every assertion about "while it is working" happens in that window.
 */
function heldRun(kind: 'compress' | 'merge' | 'repair') {
  return async (context: { progress: (fraction: number, message?: string) => void }) => {
    live.context = context;
    context.progress(0, kind === 'compress' ? 'Reading the file' : 'Reading 3 files');
    await new Promise<void>((resolve) => {
      live.release = resolve;
    });
    context.progress(0.4, 'Rewriting images');
    const bytes = pdfBytes(kind === 'compress' ? 500 : 200);
    return { kind: 'pdf' as const, bytes, message: kind === 'compress' ? 'Smaller now.' : 'Done.' };
  };
}

const STANDS: Record<string, PdfToolDefinition> = {
  'rail-compress': {
    id: 'rail-compress',
    name: 'Compress Rail',
    description: 'Shrink the file',
    icon: '🗜',
    category: 'optimize',
    outputSuffix: '_compressed.pdf',
    fields: [qualityField, ownerField, presetField],
    run: heldRun('compress'),
  },
  'rail-merge': {
    id: 'rail-merge',
    name: 'Merge Rail',
    description: 'Combine PDFs in order',
    icon: '🧩',
    category: 'organize',
    multiFile: true,
    outputSuffix: '_merged.pdf',
    run: heldRun('merge'),
  },
  'rail-repair': {
    id: 'rail-repair',
    name: 'Repair Rail',
    description: 'Fix a broken file',
    icon: '🔧',
    category: 'optimize',
    outputSuffix: '_repaired.pdf',
    run: heldRun('repair'),
  },
  'rail-engine': {
    id: 'rail-engine',
    name: 'Deskew Rail',
    description: 'Straighten scanned pages',
    icon: '📐',
    category: 'edit',
    outputSuffix: '_deskewed.pdf',
    engines: ['ghostscript'],
    run: async () => ({ kind: 'pdf', bytes: pdfBytes(10), message: 'Straight.' }),
  },
  /**
   * A tool that asks for the password in its own form, and stops at the guard.
   *
   * The two password failures are raised by the fake run so the rail's answer to each
   * can be read without a locked fixture: which ask the notice makes is a property of
   * the chrome, not of the cipher.
   */
  'rail-locked': {
    id: 'rail-locked',
    name: 'Unlock Rail',
    description: 'Remove the password',
    icon: '🔓',
    category: 'security',
    actionLabel: 'Unlock',
    outputSuffix: '_unlocked.pdf',
    fields: [passwordField],
    async run(context: { values: Record<string, unknown> }) {
      const asked = String(context.values.password ?? '');
      throw new ToolInputError(
        asked ? 'BAD_PASSWORD' : 'PASSWORD_REQUIRED',
        asked ? 'That password is not correct for "doc.pdf".' : '"doc.pdf" is password protected.',
        {
          fileName: 'doc.pdf',
          hint: asked
            ? 'Check the password (it is case-sensitive) and try again.'
            : 'Enter the password for "doc.pdf" and run again.',
        },
      );
    },
  },
};

vi.mock('@/lib/pdf/tools/registry', () => ({
  getPdfTool: (id?: string) => (id ? STANDS[id] : undefined),
}));

function fakeSession(pages = 3): PdfSession {
  return {
    numPages: pages,
    fingerprint: `ux-${pages}-${queue.thumbs.length}`,
    page: async () =>
      ({ getViewport: () => ({ width: 612, height: 792, rotation: 0 }), cleanup: () => {} }) as never,
    renderToCanvas: () => new Promise<void>((resolve) => queue.paints.push(resolve)) as never,
    destroy: async () => {},
  } as unknown as PdfSession;
}

/** A real 2-page PDF: the hook reads the page count out of the bytes. */
async function realPdf(name = 'rail.pdf'): Promise<File> {
  const { PDFDocument } = await import('@maxwbh/pdf-lib');
  const doc = await PDFDocument.create();
  doc.addPage([300, 200]);
  doc.addPage([300, 200]);
  const bytes = await doc.save();
  return new File([bytes as unknown as BlobPart], name, { type: 'application/pdf' });
}

function loadFiles(files: File[]) {
  useFileStore.setState({ file: files[0] ?? null, files, metadata: null });
}

function resultItem(name: string, size: number, pages?: number) {
  return { name, blob: new Blob([new Uint8Array(size)], { type: 'application/pdf' }), pages };
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

function runStatus(): Element | null {
  return document.querySelector('[data-run-status]');
}

beforeAll(() => {
  URL.createObjectURL = vi.fn(() => 'blob:ux') as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  queue.thumbs.length = 0;
  queue.paints.length = 0;
  live.context = undefined;
  live.release = null;
  useProcessStore.getState().reset();
  useProcessStore.setState({ activeTool: null, sessions: {}, notice: null });
  useFileStore.setState({ file: null, files: [], metadata: null, activeTool: null, sessions: {} });
});

// ── the copy the rail prints ────────────────────────────────────────────────

describe('runStatusText', () => {
  it('names the stage and the share of the job, in that order', () => {
    expect(
      runStatusText({ phase: 'running', label: 'Compress Rail', percent: 40, message: 'Rewriting images' }),
    ).toBe('Rewriting images — 40% of Compress Rail');
  });

  it('admits there is no denominator instead of claiming 0%', () => {
    expect(runStatusText({ phase: 'running', label: 'Merge Rail', percent: 0, message: 'Reading 3 files' })).toBe(
      'Reading 3 files — no time estimate yet',
    );
    expect(runStatusText({ phase: 'running', label: 'Merge Rail', percent: 0 })).toBe('Working — no time estimate yet');
  });

  it('counts the files a finished run produced rather than saying Done', () => {
    expect(runStatusText({ phase: 'done', label: 'Merge', percent: 100, outputs: 3 })).toBe('Finished — 3 files ready to download');
    expect(runStatusText({ phase: 'done', label: 'Merge', percent: 100, outputs: 1 })).toBe(
      'Finished — one file ready to download',
    );
    expect(runStatusText({ phase: 'done', label: 'Merge', percent: 100, outputs: 0 })).toContain('nothing to download');
  });

  it('stays quiet on an error, because the alert already speaks', () => {
    expect(runStatusText({ phase: 'error', label: 'Merge', percent: 0 })).toBe('');
  });

  it('puts a cancel above everything else', () => {
    expect(
      runStatusText({ phase: 'running', label: 'Merge', percent: 60, notice: 'Cancelled — nothing was saved.' }),
    ).toBe('Cancelled — nothing was saved.');
  });
});

describe('readableMessage', () => {
  it('leaves a sentence a person wrote alone', () => {
    expect(readableMessage('rail.pdf is truncated after the xref table.')).toBe(
      'rail.pdf is truncated after the xref table.',
    );
  });

  it('drops the class name, the undefined and the stack trace', () => {
    const raw = "TypeError: Cannot read properties of undefined (reading 'get')\n    at PDFPageProxy.getViewport";
    expect(readableMessage(raw)).toBe('Something went wrong here, and nothing was saved.');
  });

  it('strips a leading error label from an otherwise good message', () => {
    expect(readableMessage('Error: Page 9 is outside this document.')).toBe('Page 9 is outside this document.');
  });
});

// ── results in checkable numbers ────────────────────────────────────────────

describe('describePages', () => {
  it('reports pages in and pages out when both were counted', () => {
    expect(describePages(12, 4)).toBe('12 → 4');
  });

  it('reports only the side it knows, and says which', () => {
    expect(describePages(null, 4)).toBe('4');
    expect(describePages(12, 0)).toBe('12 in · out not counted');
    expect(describePages(null, null)).toBeNull();
  });
});

describe('honestSummary (E14)', () => {
  it('keeps a promise the numbers support', () => {
    expect(honestSummary('Compressed to 1.2 MB', false)).toBe('Compressed to 1.2 MB');
  });

  it('refuses to say compressed when the file grew', () => {
    expect(honestSummary('Compressed to 1.2 MB', true)).toBeNull();
  });

  it('leaves a claim that never promised a shrink alone', () => {
    expect(honestSummary('Bookmarks copied across.', true)).toBe('Bookmarks copied across.');
  });
});

describe('ResultCard', () => {
  it('states pages in, pages out and the size delta as numbers', () => {
    render(h(ResultCard, { outputs: [resultItem('report_split.pdf', 400, 4)], pagesIn: 12, sizeBefore: 1000 }));
    const card = screen.getByRole('region', { name: 'Result' });
    expect(card.textContent).toContain('12 → 4');
    expect(card.textContent).toMatch(/60% smaller/);
  });

  it('never prints the tool’s shrink claim when the output is bigger', () => {
    render(
      h(ResultCard, {
        outputs: [resultItem('bigger.pdf', 1200)],
        sizeBefore: 1000,
        original: resultItem('rail.pdf', 1000),
        message: 'Compressed to a smaller file.',
      }),
    );
    const card = screen.getByRole('region', { name: 'Result' });
    expect(card.textContent).toMatch(/20% larger/);
    expect(card.textContent).not.toMatch(/Compressed to a smaller file/);
    expect(card.textContent).toMatch(/bigger than the one you started with/);
    expect(within(card).getByRole('button', { name: 'Keep original' })).toBeInTheDocument();
  });

  it('lists what the run did not do, counted', () => {
    render(
      h(ResultCard, {
        outputs: [resultItem('ocr.pdf', 900)],
        warnings: ['OCR skipped on 3 scanned pages.', 'Resolution must be between 72 and 300 dpi: 400 became 300.'],
      }),
    );
    const card = screen.getByRole('region', { name: 'Result' });
    expect(card.textContent).toContain('What you should know (2)');
    expect(within(card).getAllByRole('listitem')).toHaveLength(2);
    expect(card.textContent).toMatch(/OCR skipped on 3 scanned pages/);
  });
});

// ── progress that does not lie ──────────────────────────────────────────────

describe('ProgressBar', () => {
  it('carries the stage name into the accessible value', () => {
    render(h(ProgressBar, { percent: 40, message: 'Rewriting images', label: 'Working' }));
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '40');
    expect(bar).toHaveAttribute('aria-valuetext', '40% — Rewriting images');
  });

  it('drops the number and the denominator when the total is unknown', () => {
    render(h(ProgressBar, { percent: 0, indeterminate: true, label: 'Working' }));
    const bar = screen.getByRole('progressbar');
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(bar).toHaveAttribute('data-indeterminate');
    expect(bar).toHaveAttribute('aria-valuetext', 'Working, no time estimate yet');
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });
});

describe('FileQueue', () => {
  const rows: FileQueueItem[] = [
    { id: 'a.pdf', name: 'a.pdf', size: 2048, pages: 4 },
    { id: 'b.pdf', name: 'b.pdf', size: 4096, pages: 8, busy: true },
    { id: 'c.pdf', name: 'c.pdf', size: 512, pages: 2, busy: true, percent: 60, message: 'Rewriting images' },
    { id: 'd.pdf', name: 'd.pdf', size: 128, pages: 1, error: 'This file is empty (0 bytes).' },
  ];

  it('shows an indeterminate bar, not a fake 0%, for a file that started with nothing measured', () => {
    render(
      h(FileQueue, {
        items: rows,
        progressNote: 'Progress is estimated across the files in this order.',
      }),
    );
    const bars = screen.getAllByRole('progressbar');
    // b: working with no denominator. c: 60%, with the stage the tool named.
    expect(bars).toHaveLength(2);
    expect(bars[0]).toHaveAttribute('data-indeterminate');
    expect(bars[1]).toHaveAttribute('aria-valuenow', '60');
    expect(screen.getByText('Rewriting images')).toBeInTheDocument();
    // The note is a caption, so it must not pose as a fifth file.
    expect(screen.getByText('Progress is estimated across the files in this order.')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
  });

  it('says where each file stands', () => {
    render(h(FileQueue, { items: rows }));
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/a\.pdf.*Waiting/s);
    expect(text).toMatch(/b\.pdf.*Starting/s);
    expect(text).toMatch(/c\.pdf.*Working/s);
    expect(text).toMatch(/d\.pdf.*Stopped/s);
  });

  it('shows the page count it read, so a 500-page job is visible before the click', () => {
    render(h(FileQueue, { items: [{ id: 'big.pdf', name: 'big.pdf', size: 9_000_000, pages: 500 }] }));
    expect(screen.getByText(/500 pages/)).toBeInTheDocument();
  });

  it('explains a disabled position control instead of going dead', () => {
    render(h(FileQueue, { items: rows, onReorder: vi.fn(), onRemove: vi.fn() }));
    const firstUp = screen.getByLabelText('Move a.pdf earlier');
    expect(firstUp).toBeDisabled();
    expect(firstUp).toHaveAttribute('title', 'This file is already first');
    expect(within(firstUp.closest('li') as HTMLElement).getByLabelText('Remove a.pdf')).toBeInTheDocument();
  });
});

// ── honest previews ─────────────────────────────────────────────────────────

describe('PageThumbs placeholders (E7)', () => {
  it('marks a tile as drawing while its raster is in flight, never blank', () => {
    render(h(PageThumbs, { session: fakeSession(3), selected: [], onSelect: () => {} }));
    const first = screen.getByRole('button', { name: 'Page 1' });
    expect(first).toHaveAttribute('data-thumb', 'drawing');
    expect(first.textContent).toContain('1');
    expect(queue.thumbs.length).toBeGreaterThan(0);
  });

  it('admits the browser gave it no image instead of pretending to work', async () => {
    render(h(PageThumbs, { session: fakeSession(2), selected: [], onSelect: () => {} }));
    await act(async () => {
      queue.thumbs.splice(0).forEach((resolve) => resolve(['']));
      await Promise.resolve();
    });
    const cell = screen.getByRole('button', { name: 'Page 1' });
    expect(cell).toHaveAttribute('data-thumb', 'unavailable');
    expect(cell.getAttribute('title')).toMatch(/no image in this browser/);
  });

  it('counts the tiles still rendering, out of the window it shows', async () => {
    render(h(PageThumbs, { session: fakeSession(500), selected: [], onSelect: () => {}, columns: 4 }));
    expect(screen.getByText(/Drawing \d+ of \d+ visible/)).toBeInTheDocument();
    expect(document.querySelector('[aria-label="Pages"]')).toHaveAttribute('aria-busy', 'true');
    await act(async () => {
      queue.thumbs.splice(0).forEach((resolve) => resolve(['data:page']));
      await Promise.resolve();
    });
    expect(screen.queryByText(/Drawing \d+ of \d+ visible/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Page 1' })).toHaveAttribute('data-thumb', 'image');
  });

  it('states the next action while nothing is picked', () => {
    render(h(PageThumbs, { session: fakeSession(6), selected: [], onSelect: () => {}, onRotate: vi.fn() }));
    expect(screen.getByText(/pick pages to rotate or delete/)).toBeInTheDocument();
    const rotate = screen.getByRole('button', { name: 'Rotate' });
    expect(rotate).toBeDisabled();
    expect(rotate).toHaveAttribute('title', 'Pick at least one page to rotate');
  });
});

describe('PreviewPane keyboard, fit and placeholders', () => {
  function stage(): HTMLElement {
    return screen.getByRole('group', { name: 'Page preview' });
  }

  it('turns pages from the keyboard and stops at the ends', () => {
    const onPageChange = vi.fn();
    render(h(PreviewPane, { session: fakeSession(4), page: 2, onPageChange }));
    fireEvent.keyDown(stage(), { key: 'ArrowRight' });
    expect(onPageChange).toHaveBeenLastCalledWith(3);
    fireEvent.keyDown(stage(), { key: 'PageUp' });
    expect(onPageChange).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(stage(), { key: 'End' });
    expect(onPageChange).toHaveBeenLastCalledWith(4);
    fireEvent.keyDown(stage(), { key: 'Home' });
    expect(onPageChange).toHaveBeenLastCalledWith(1);
  });

  it('leaves the arrow keys to the field being typed in', () => {
    const onPageChange = vi.fn();
    render(h(PreviewPane, { session: fakeSession(4), page: 2, onPageChange }));
    const box = screen.getByLabelText('Page number');
    box.focus();
    fireEvent.keyDown(box, { key: 'ArrowRight' });
    expect(onPageChange).not.toHaveBeenCalled();
  });

  it('zooms with the keyboard and refits with 0', () => {
    render(h(PreviewPane, { session: fakeSession(3) }));
    expect(stage()).toHaveAttribute('data-fit', 'width');
    fireEvent.keyDown(stage(), { key: '+' });
    expect(stage()).toHaveAttribute('data-fit', 'custom');
    fireEvent.keyDown(stage(), { key: '0' });
    expect(stage()).toHaveAttribute('data-fit', 'width');
  });

  it('offers fit width and fit page as pressed states', () => {
    render(h(PreviewPane, { session: fakeSession(3) }));
    const width = screen.getByRole('button', { name: 'Fit width' });
    const page = screen.getByRole('button', { name: 'Fit page' });
    expect(width).toHaveAttribute('aria-pressed', 'true');
    expect(page).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(page);
    expect(page).toHaveAttribute('aria-pressed', 'true');
    expect(width).toHaveAttribute('aria-pressed', 'false');
    expect(stage()).toHaveAttribute('data-fit', 'page');
  });

  it('zooms to the cursor on ctrl or cmd scroll, and leaves a plain wheel alone', () => {
    render(h(PreviewPane, { session: fakeSession(3) }));
    const before = Number(stage().getAttribute('data-zoom'));
    fireEvent.wheel(stage(), { ctrlKey: true, deltaY: -100 });
    expect(Number(stage().getAttribute('data-zoom'))).toBeGreaterThan(before);
    expect(stage()).toHaveAttribute('data-fit', 'custom');
    const after = Number(stage().getAttribute('data-zoom'));
    fireEvent.wheel(stage(), { deltaY: 100 });
    expect(Number(stage().getAttribute('data-zoom'))).toBe(after);
  });

  it('keeps the content point that was under the cursor', () => {
    // Doubling the scale with 100 px of scroll and the cursor 50 px into the
    // pane has to double the scroll too, or the page slides sideways.
    expect(zoomAnchorScroll(100, 50, 2)).toBe(250);
    expect(zoomAnchorScroll(100, 50, 1)).toBe(100);
    expect(zoomAnchorScroll(0, 40, 0.5)).toBe(-20);
  });

  it('covers an unpainted page with a stated placeholder, not white', async () => {
    render(h(PreviewPane, { session: fakeSession(2) }));
    expect(screen.getByText('Drawing page 1')).toBeInTheDocument();
    await act(async () => {
      queue.paints.splice(0).forEach((resolve) => resolve());
      await Promise.resolve();
    });
    expect(screen.queryByText('Drawing page 1')).not.toBeInTheDocument();
    expect(document.querySelector('[data-canvas-state="ready"]')).not.toBeNull();
  });

  it('announces which page the pane is on', () => {
    render(h(PreviewPane, { session: fakeSession(5), page: 3 }));
    expect(screen.getByRole('status').textContent).toContain('Page 3 of 5');
  });
});

// ── the result preview: bounded work that knows when to stop ────────────────

describe('OutputPreview as a bounded job', () => {
  /** The mocked `core/render` surface, typed for assertions. */
  const open = renderLib.openRender as unknown as ReturnType<typeof vi.fn>;
  const thumbs = renderLib.thumbnails as unknown as ReturnType<typeof vi.fn>;

  /** A document pdf.js hands back, with a countable teardown. */
  function documentOf(pages: number) {
    const destroy = vi.fn(async () => {});
    return {
      destroy,
      session: {
        numPages: pages,
        fingerprint: `rail-${pages}-${Math.random().toString(36).slice(2)}`,
        page: async () => ({
          getViewport: () => ({ width: 612, height: 792, rotation: 0 }),
          cleanup() {},
        }),
        renderToCanvas: async () => ({}),
        destroy,
      },
    };
  }

  /** A produced file, as the result screen holds it. */
  function produced(): Blob {
    return new Blob([pdfBytes(80)], { type: 'application/pdf' });
  }

  // The rail's own tests above leave thumbnail requests in the mock and in the
  // hand-pumped queue; counting this job's work starts by emptying both.
  beforeEach(() => {
    queue.thumbs.length = 0;
    thumbs.mockClear();
    open.mockClear();
  });

  it('rasterises a bounded set of pages out of five hundred', async () => {
    open.mockResolvedValueOnce(documentOf(500).session);
    render(h(OutputPreview, { items: [{ name: 'merged.pdf', blob: produced() }] }));
    await waitFor(() => expect(thumbs).toHaveBeenCalled());
    // Every tile reports in the same tick it mounts; drain them before counting.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    /** Every raster this screen asked for, as the page and size it asked for. */
    const tiles = thumbs.mock.calls.flatMap((call) => {
      const options = call[1] as { pages: number[]; maxSide: number };
      return options.pages.map((page) => ({ page, maxSide: options.maxSide }));
    });
    // One request per tile — never a batch of 500 — and the tiles are the poster
    // plus the bounded strip. This is the mistake E12 was written about.
    expect(tiles).toHaveLength(thumbs.mock.calls.length);
    expect(tiles.length).toBeLessThanOrEqual(PREVIEW_PAGE_LIMIT + 1);

    const pages = [...new Set(tiles.map((tile) => tile.page))];
    expect(pages).toEqual(previewPages(500));
    expect(pages).toContain(1);
    expect(pages).toContain(500);
    expect(pages).not.toContain(250);
    // The big frame is a bigger raster than the chip it matches, and nothing is
    // drawn at a size the screen never shows.
    expect(new Set(tiles.map((tile) => tile.maxSide))).toEqual(new Set([380, 48]));
  });

  it('destroys the document it opened when the result it belongs to is gone', async () => {
    const first = documentOf(3);
    const second = documentOf(4);
    open.mockResolvedValueOnce(first.session).mockResolvedValueOnce(second.session);
    const { rerender, unmount } = render(
      h(OutputPreview, { items: [{ name: 'a.pdf', blob: produced() }] }),
    );
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(first.destroy).not.toHaveBeenCalled();

    // A new run publishes a different blob: the old document is nobody's business
    // now, and leaving it open is how a preview turns into a memory leak.
    rerender(h(OutputPreview, { items: [{ name: 'b.pdf', blob: produced() }] }));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(first.destroy).toHaveBeenCalledTimes(1));
    expect(second.destroy).not.toHaveBeenCalled();

    unmount();
    expect(second.destroy).toHaveBeenCalledTimes(1);
  });

  it('asks pdf.js for nothing when the screen has folded the preview away', async () => {
    render(h(OutputPreview, { items: [{ name: 'a.pdf', blob: produced() }], mode: 'off' }));
    expect(open).not.toHaveBeenCalled();
    expect(document.querySelector('[data-preview="off"]')).not.toBeNull();
  });
});

// ── the hook: cancel, staleness, and what the rail is told ───────────────────

describe('usePdfTool as the rail’s state machine', () => {
  it('publishes the page count it read into the queue rows', async () => {
    loadFiles([await realPdf('rail.pdf')]);
    const { result } = renderHook(() => usePdfTool('rail-compress'));
    await waitFor(() => expect(result.current.pageCount).toBe(2));
    await waitFor(() => expect(useProcessStore.getState().fileStates['rail.pdf']?.pages).toBe(2));
    expect(useProcessStore.getState().fileStates['rail.pdf'].size).toBeGreaterThan(0);
  });

  it('states a missing engine as an instruction, not a status', async () => {
    loadFiles([await realPdf()]);
    const provider = await import('@/lib/pdf/engines');
    const original = provider.engines.isConfigured;
    provider.engines.isConfigured = (id: string) => (id === 'ghostscript' ? false : original(id as never));
    try {
      const { result } = renderHook(() => usePdfTool('rail-engine'));
      await waitFor(() => expect(result.current.tool).toBeTruthy());
      expect(result.current.canRun).toBe(false);
      expect(result.current.blockers[0]).toMatch(/^Connect to the internet to load Ghostscript/);
      expect(result.current.blockers[0]).not.toMatch(/\[object Object\]|NEEDS_ENGINE/i);
    } finally {
      provider.engines.isConfigured = original;
    }
  });

  it('holds a stage name with no denominator while the tool has not measured anything', async () => {
    loadFiles([await realPdf(), await realPdf('second.pdf')]);
    const { result } = renderHook(() => usePdfTool('rail-merge'));
    await waitFor(() => expect(result.current.tool).toBeTruthy());
    let pending: Promise<unknown> = Promise.resolve(null);
    act(() => {
      pending = result.current.run();
    });
    await waitFor(() => expect(useProcessStore.getState().phase).toBe('running'));
    const running = useProcessStore.getState();
    expect(running.statusMessage).toBe('Reading 3 files');
    expect(running.progress).toBe(0);
    expect(
      runStatusText({
        phase: running.phase,
        label: running.label,
        percent: running.progress,
        message: running.statusMessage,
        notice: running.notice,
      }),
    ).toContain('no time estimate yet');
    await release();
    await act(async () => {
      await pending;
    });
    expect(useProcessStore.getState().phase).toBe('done');
  });

  it('cancels with no output and no error, and says what happened (E19)', async () => {
    loadFiles([await realPdf()]);
    const { result } = renderHook(() => usePdfTool('rail-repair'));
    await waitFor(() => expect(result.current.tool).toBeTruthy());
    let pending: Promise<unknown> = Promise.resolve(null);
    act(() => {
      pending = result.current.run();
    });
    await waitFor(() => expect(useProcessStore.getState().phase).toBe('running'));
    act(() => result.current.cancel());

    const moment = useProcessStore.getState();
    expect(moment.error).toBeNull();
    expect(moment.notice).toBe('Cancelled — nothing was saved.');
    expect(moment.isProcessing).toBe(false);
    expect(result.current.isRunning).toBe(false);
    // The queue keeps what it learned: a cancel is not a reason to forget that
    // this file has 2 pages.
    expect(moment.fileStates['rail.pdf'].pages).toBe(2);
    expect(moment.fileStates['rail.pdf'].percent).toBe(0);

    // The tool did not notice the abort and finished anyway.
    await release();
    await act(async () => {
      expect(await pending).toBeNull();
    });
    const state = useProcessStore.getState();
    expect(state.outputBlobs).toHaveLength(0);
    expect(state.outputUrl).toBeNull();
    expect(state.error).toBeNull();
    expect(state.phase).not.toBe('error');
    expect(state.notice).toBe('Cancelled — nothing was saved.');
  });

  it('throws away progress a cancelled run keeps reporting (E19)', async () => {
    loadFiles([await realPdf()]);
    const { result } = renderHook(() => usePdfTool('rail-repair'));
    await waitFor(() => expect(result.current.tool).toBeTruthy());
    act(() => {
      void result.current.run();
    });
    await waitFor(() => expect(live.context).toBeTruthy());
    const context = live.context!;
    act(() => result.current.cancel());
    act(() => context.progress(0.95, 'too late'));
    expect(useProcessStore.getState().progress).toBe(0);
    expect(useProcessStore.getState().statusMessage).not.toBe('too late');
    await release();
  });

  it('discards a result whose files the user swapped mid-run (E19)', async () => {
    loadFiles([await realPdf('first.pdf')]);
    const { result } = renderHook(() => usePdfTool('rail-repair'));
    await waitFor(() => expect(result.current.tool).toBeTruthy());
    act(() => {
      void result.current.run();
    });
    await waitFor(() => expect(useProcessStore.getState().phase).toBe('running'));

    const second = await realPdf('second.pdf');
    act(() => loadFiles([second]));
    await release();

    const state = useProcessStore.getState();
    expect(state.outputBlobs).toHaveLength(0);
    expect(state.phase).not.toBe('done');
    expect(state.notice).toMatch(/changed the files .* discarded/i);
    // The rail must not stay wedged on "Working…" for a run that was thrown away.
    await waitFor(() => expect(result.current.isRunning).toBe(false));
  });
});

// ── the rail itself ─────────────────────────────────────────────────────────

describe('PdfToolPanel as the whole chrome', () => {
  it('shows a drop zone and no action at all before a file exists', async () => {
    // The rail used to print a disabled primary action plus a reason for a file
    // the user had not chosen yet. The drop-first page offers one oversized button
    // and keeps the fields, the action and the reason back until there is input.
    render(h(PdfToolPanel, { toolId: 'rail-compress' }));
    const pick = await screen.findByRole('button', { name: /^Select PDF file/ });
    expect(pick).toHaveAttribute('data-drop-target', 'true');
    expect(document.getElementById('tool-process-btn')).toBeNull();
    expect(document.getElementById('tool-run-reason')).toBeNull();
    expect(screen.queryByLabelText('Owner name')).toBeNull();
    expect(screen.queryByLabelText('Resolution')).toBeNull();
  });

  it('pairs the disabled action with exactly one reason and points at it', async () => {
    // Two documents for a one-at-a-time tool, so more than one thing is left to
    // fix: exactly one is printed, in the imperative, and the rest are counted.
    loadFiles([await realPdf('one.pdf'), await realPdf('two.pdf')]);
    render(h(PdfToolPanel, { toolId: 'rail-compress' }));
    const button = await screen.findByRole('button', { name: 'Compress' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-describedby', 'tool-run-reason');
    const reason = document.getElementById('tool-run-reason');
    expect(reason?.textContent).toContain('Still needed: ');
    expect(reason?.textContent).toMatch(/works on one file at a time/);
    // The rest are counted, not dumped: a wall of reasons is a wall of text.
    expect(reason?.textContent).toMatch(/more after that/);
    expect(reason?.textContent).not.toMatch(/Owner name is required/);
  });

  it('clears the reason line once the run is available', async () => {
    loadFiles([await realPdf()]);
    render(h(PdfToolPanel, { toolId: 'rail-compress' }));
    fireEvent.change(await screen.findByLabelText('Owner name'), { target: { value: 'ACME' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Compress' })).toBeEnabled());
    expect(document.getElementById('tool-run-reason')).toBeNull();
  });

  it('says which preset is chosen', async () => {
    loadFiles([await realPdf()]);
    render(h(PdfToolPanel, { toolId: 'rail-compress' }));
    await screen.findByLabelText('Owner name');
    // The bar shows one field and folds the rest behind a disclosure, so the
    // preset needs opening first. (It sat in an always-open grid before.)
    fireEvent.click(screen.getByRole('button', { name: /more options/ }));
    const light = screen.getByRole('button', { name: 'Light' });
    const strong = screen.getByRole('button', { name: 'Strong' });
    expect(light).toHaveAttribute('aria-pressed', 'true');
    expect(strong).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(strong);
    expect(strong).toHaveAttribute('aria-pressed', 'true');
  });

  it('announces the run through one live region, in stage names', async () => {
    loadFiles([await realPdf()]);
    render(h(PdfToolPanel, { toolId: 'rail-compress' }));
    fireEvent.change(await screen.findByLabelText('Owner name'), { target: { value: 'ACME' } });
    fireEvent.click(screen.getByRole('button', { name: 'Compress' }));
    await waitFor(() => expect(runStatus()?.textContent).toContain('Reading the file'));
    expect(runStatus()?.textContent).toContain('no time estimate yet');
    expect(screen.getByRole('progressbar')).toHaveAttribute('data-indeterminate');

    await release();
    await waitFor(() => expect(runStatus()?.textContent).toMatch(/Finished — one file/));
    // One region for the surface, so nothing is announced twice.
    expect(document.querySelectorAll('[role="status"]')).toHaveLength(1);
  });

  it('tells a screen reader about the cancel instead of going quiet', async () => {
    loadFiles([await realPdf()]);
    render(h(PdfToolPanel, { toolId: 'rail-repair' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Repair' }));
    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    fireEvent.click(cancel);
    await waitFor(() => expect(runStatus()?.textContent).toBe('Cancelled — nothing was saved.'));
    expect(screen.queryByRole('alert')).toBeNull();
    await release();
  });

  it('reports the finished run in numbers the user can check', async () => {
    loadFiles([await realPdf('rail.pdf')]);
    render(h(PdfToolPanel, { toolId: 'rail-compress' }));
    fireEvent.change(await screen.findByLabelText('Owner name'), { target: { value: 'ACME' } });
    fireEvent.click(screen.getByRole('button', { name: 'Compress' }));
    await release();
    const card = await screen.findByRole('region', { name: 'Result' });
    // Two pages in, and a before → after size: no bare "Done" anywhere.
    expect(card.textContent).toContain('2 in · out not counted');
    expect(card.textContent).toMatch(/\d+% smaller/);
    expect(card.textContent).toContain('Smaller now.');
    expect(card.textContent).not.toBe('Done');
  });

  it('gives every control in the rail a visible focus ring', async () => {
    loadFiles([await realPdf()]);
    render(h(PdfToolPanel, { toolId: 'rail-compress' }));
    await screen.findByLabelText('Owner name');
    const bare = [...document.querySelectorAll('button')].filter(
      (node) => !node.className.includes('focus-visible:outline-2'),
    );
    expect(bare.map((node) => node.textContent || node.getAttribute('aria-label'))).toEqual([]);
  });

  it('keeps a tool that has not arrived honest without a wall of prose', async () => {
    // An unknown id opens on the drop zone like every other page (see the intake
    // test above); the honesty arrives with the reason line, once there is
    // something to run on.
    loadFiles([await realPdf()]);
    render(h(PdfToolPanel, { toolId: 'not-on-the-rack' }));
    const button = await screen.findByRole('button', { name: 'Run' });
    expect(button).toBeDisabled();
    expect(document.getElementById('tool-run-reason')?.textContent).toContain('Wait for this tool to finish loading.');
  });
});

describe('the rail’s one password box', () => {
  /**
   * The generic "PDF password" field used to sit in the options bar for every tool
   * that declared a password field of its own — two inputs writing one secret, with
   * nothing on the page saying which one `unlock` reads. The bar holds none now, and
   * the only box left is the tool's own.
   */
  it('holds no second box beside a tool that asks for a password itself', async () => {
    loadFiles([await realPdf('doc.pdf')]);
    render(h(PdfToolPanel, { toolId: 'rail-locked' }));
    await screen.findByLabelText('Current password');
    expect(document.querySelectorAll('input[type=password]')).toHaveLength(1);
    expect(screen.queryByText('PDF password')).toBeNull();
  });

  it('answers a missing secret and a wrong secret with two different asks', async () => {
    loadFiles([await realPdf('doc.pdf')]);
    render(h(PdfToolPanel, { toolId: 'rail-locked' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Unlock' }));
    const needed = await waitFor(() => {
      const node = document.querySelector('[data-password-notice]');
      if (!node) throw new Error('the notice has not arrived');
      return node;
    });
    expect(needed).toHaveAttribute('data-password-notice', 'needed');
    expect(needed.textContent).toMatch(/needs its password before it can be opened/i);
    expect(needed.textContent).not.toMatch(/did not open/i);

    cleanup();
    loadFiles([await realPdf('doc.pdf')]);
    render(h(PdfToolPanel, { toolId: 'rail-locked' }));
    fireEvent.change(await screen.findByLabelText('Current password'), { target: { value: 'hunter2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    const wrong = await waitFor(() => {
      const node = document.querySelector('[data-password-notice="wrong"]');
      if (!node) throw new Error('the wrong-secret notice has not arrived');
      return node;
    });
    expect(wrong.textContent).toMatch(/did not open this PDF/i);
    expect(wrong.textContent).not.toMatch(/needs its password before/i);
    // The two sentences are not interchangeable, and neither echoes the other.
    expect(wrong.textContent).not.toBe(needed.textContent);
  });
});

describe('the rail’s one password box', () => {
  /**
   * A generic "PDF password" field used to sit in the options bar for every tool that
   * declared a password field of its own — two inputs writing one secret, with nothing
   * on the page saying which one `unlock` reads. The bar holds none now: the tool's own
   * field is the box, and a tool that has none asks on the file's card.
   */
  it('holds no second box beside a tool that asks for a password itself', async () => {
    loadFiles([await realPdf('doc.pdf')]);
    render(h(PdfToolPanel, { toolId: 'rail-locked' }));
    await screen.findByLabelText('Current password');
    expect(document.querySelectorAll('input[type=password]')).toHaveLength(1);
    expect(screen.queryByText('PDF password')).toBeNull();
  });

  it('answers a missing secret and a wrong secret with two different asks', async () => {
    loadFiles([await realPdf('doc.pdf')]);
    render(h(PdfToolPanel, { toolId: 'rail-locked' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Unlock' }));
    const needed = await waitFor(() => {
      const node = document.querySelector('[data-password-notice]');
      if (!node) throw new Error('the notice has not arrived');
      return node;
    });
    expect(needed).toHaveAttribute('data-password-notice', 'needed');
    expect(needed.textContent).toMatch(/needs its password before it can be opened/i);
    expect(needed.textContent).not.toMatch(/did not open/i);

    cleanup();
    loadFiles([await realPdf('doc.pdf')]);
    render(h(PdfToolPanel, { toolId: 'rail-locked' }));
    fireEvent.change(await screen.findByLabelText('Current password'), { target: { value: 'hunter2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    const wrong = await waitFor(() => {
      const node = document.querySelector('[data-password-notice="wrong"]');
      if (!node) throw new Error('the wrong-secret notice has not arrived');
      return node;
    });
    expect(wrong.textContent).toMatch(/did not open this PDF/i);
    expect(wrong.textContent).not.toMatch(/needs its password before/i);
    expect(wrong.textContent).not.toBe(needed.textContent);
  });
});

describe('ErrorPanel copy', () => {
  it('pairs a failure with the next action and names the file', () => {
    render(
      h(ErrorPanel, {
        message: "TypeError: x is undefined\n    at PDFDocument.load",
        fileName: 'rail.pdf',
        onRetry: vi.fn(),
      }),
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('rail.pdf');
    expect(alert.textContent).toContain('Something went wrong here, and nothing was saved.');
    expect(alert.textContent).not.toMatch(/TypeError|undefined|at PDFDocument/);
    expect(alert.textContent).toMatch(/Check the file, adjust the options, then try once more\./);
    expect(screen.getByRole('button', { name: 'Retry' })).toHaveClass('focus-visible:outline-2');
  });
});
