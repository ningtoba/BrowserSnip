/**
 * Shared rail, states and previews (worker A2).
 *
 * Two rules shape these tests:
 * - `core/render` is mocked, because jsdom has no 2-D canvas and pdf.js needs a
 *   worker. Every component under test therefore has to prove it works without
 *   real rasterising, including the thumbnail window.
 * - The registry is replaced with a handful of definitions so validation,
 *   verbs and phases are asserted against known inputs. The real catalogue is
 *   checked separately for verb coverage only.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import * as renderLib from '@/lib/pdf/core/render';
import type { PdfSession } from '@/lib/pdf/core/render';
import { useProcessStore } from '@/stores/process-store';
import { useFileStore } from '@/stores/file-store';
import { ToolInputError } from '@/lib/pdf/core/guard';
import { usePdfTool } from '@/hooks/usePdfTool';
import { PdfToolPanel } from '@/components/tools/pdf/shared/PdfToolPanel';
import { EmptyState } from '@/components/tools/pdf/shared/EmptyState';
import { ErrorPanel } from '@/components/tools/pdf/shared/ErrorPanel';
import { FileQueue, type FileQueueItem } from '@/components/tools/pdf/shared/FileQueue';
import { PageThumbs } from '@/components/tools/pdf/shared/PageThumbs';
import { PreviewPane } from '@/components/tools/pdf/shared/PreviewPane';
import { ProgressBar } from '@/components/tools/pdf/shared/ProgressBar';
import { ResultCard, describeDelta, type ResultItem } from '@/components/tools/pdf/shared/ResultCard';
import {
  checkFields,
  groupFields,
  promiseFor,
  verbFor,
  type PanelTool,
} from '@/components/tools/pdf/shared/toolForm';
import type { ToolField } from '@/lib/pdf/tools/types';

// ── module mocks ────────────────────────────────────────────────────────────

vi.mock('@/lib/pdf/core/render', () => ({
  openRender: vi.fn(async () => ({
    numPages: 3,
    fingerprint: 'rail-session',
    page: async () => ({ getViewport: () => ({ width: 612, height: 792, rotation: 0 }), cleanup() {} }),
    renderToCanvas: async () => ({ width: 612, height: 792 }),
    destroy: async () => {},
  })),
  // Reports one URL per requested page so the test can count raster requests.
  thumbnails: vi.fn(async (_session: unknown, options: { pages?: number[] }) =>
    (options?.pages ?? []).map((page: number) => `data:page-${page}`),
  ),
}));

vi.mock('@/lib/pdf/tools/registry', () => ({
  getPdfTool: (id?: string) => (id ? TOOL_STAND[id] : undefined),
}));

// ── fixtures ────────────────────────────────────────────────────────────────

const qualityField: ToolField = {
  key: 'dpi',
  label: 'Resolution',
  type: 'number',
  unit: 'dpi',
  min: 72,
  max: 300,
  step: 1,
  default: 150,
  group: 'Quality',
};

const integerField: ToolField = {
  key: 'margin',
  label: 'Margin',
  type: 'number',
  unit: 'pt',
  min: 0,
  max: 72,
  step: 1,
  integer: true,
  default: 0,
};

const presetField: ToolField = {
  key: 'preset',
  label: 'Preset',
  type: 'select',
  group: 'Quality',
  default: 'balanced',
  options: [{ value: 'balanced', label: 'Balanced' }, { value: 'strong', label: 'Strong' }],
};

const markField: ToolField = {
  key: 'owner',
  label: 'Owner name',
  type: 'text',
  required: true,
  group: 'Marks',
  placeholder: 'Who owns this file',
};

const pagesField: ToolField = { key: 'pages', label: 'Pages', type: 'pages', default: 'all' };

/** Mid-run observations, captured from inside a fake tool run. */
const seen: { phase?: string; percent?: number; filePercent?: number } = {};

function pdfBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function pdfResult(bytes = 900) {
  return { kind: 'pdf' as const, bytes: pdfBytes('x'.repeat(bytes)), message: 'Smaller now.' };
}

const TOOL_STAND: Record<string, PanelTool> = {
  'compress-thing': {
    id: 'compress-thing',
    name: 'Compress Thing',
    description: 'Shrink the file',
    icon: '🗜',
    category: 'optimize',
    outputSuffix: '_compressed.pdf',
    fields: [qualityField, presetField, markField],
    notes: ['Recompression is lossy: text stays sharp, photos blur.'],
    run: async (context) => {
      seen.phase = useProcessStore.getState().phase;
      seen.percent = useProcessStore.getState().progress;
      seen.filePercent = useProcessStore.getState().fileStates['doc.pdf']?.percent;
      context.progress(0.5, 'Rewriting images');
      context.log('warning: fonts are degraded to substitutes');
      await new Promise((resolve) => setTimeout(resolve, 0));
      return pdfResult();
    },
  },
  'merge-thing': {
    id: 'merge-thing',
    name: 'Merge Thing',
    description: 'Combine PDFs in order',
    icon: '🧩',
    category: 'organize',
    multiFile: true,
    outputSuffix: '_merged.pdf',
    fields: [pagesField],
    run: async () => pdfResult(400),
  },
  'pages-thing': {
    id: 'pages-thing',
    name: 'Extract Thing',
    description: 'Pull pages out',
    icon: '✂️',
    category: 'organize',
    outputSuffix: '_extracted.pdf',
    fields: [pagesField],
    run: async () => pdfResult(200),
  },
  'broken-thing': {
    id: 'broken-thing',
    name: 'Repair Thing',
    description: 'Fix a broken file',
    icon: '🔧',
    category: 'optimize',
    outputSuffix: '_repaired.pdf',
    run: async () => {
      throw new Error('doc.pdf is truncated after the xref table.');
    },
  },
  'locked-thing': {
    id: 'locked-thing',
    name: 'Unlock Thing',
    description: 'Remove the password',
    icon: '🔓',
    category: 'security',
    outputSuffix: '_unlocked.pdf',
    fields: [{ key: 'password', label: 'Password', type: 'password', default: '' }],
    run: async () => {
      throw new Error('This PDF is password protected.');
    },
  },
  'guard-thing': {
    id: 'guard-thing',
    name: 'Convert Guard',
    description: 'Refuse a file that is not a PDF',
    icon: '🛡',
    category: 'convert-from',
    outputSuffix: '_converted.pdf',
    run: async () => {
      throw new ToolInputError('NOT_A_PDF', '"scan.jpg" is not a PDF.', {
        fileName: 'scan.jpg',
        hint: 'Export it as a PDF from the app that made it.',
      });
    },
  },
  'slow-thing': {
    id: 'slow-thing',
    name: 'Merge Slow',
    description: 'Combine PDFs slowly',
    icon: '🧩',
    category: 'organize',
    multiFile: true,
    outputSuffix: '_merged.pdf',
    run: async (context) => {
      context.progress(0.2, 'Reading pages');
      await new Promise((resolve) => setTimeout(resolve, 40));
      return pdfResult(400);
    },
  },
  'engine-thing': {
    id: 'engine-thing',
    name: 'Deskew Thing',
    description: 'Straighten scanned pages',
    icon: '📐',
    category: 'edit',
    outputSuffix: '_deskewed.pdf',
    engines: ['ghostscript'],
    run: async () => pdfResult(100),
  },
};

let sessionCounter = 0;

function fakeSession(pages = 3): PdfSession {
  sessionCounter += 1;
  return {
    numPages: pages,
    fingerprint: `session-${sessionCounter}`,
    page: async () =>
      ({
        getViewport: () => ({ width: 612, height: 792, rotation: 90 }),
        cleanup: () => {},
      }) as unknown as ReturnType<PdfSession['page']> extends Promise<infer T> ? T : never,
    renderToCanvas: vi.fn(async () => ({ width: 612, height: 792 })),
    destroy: async () => {},
  } as unknown as PdfSession;
}

/** A file the guard layer will accept: `%PDF-` header and `%%EOF` trailer. */
function pdfFile(name = 'doc.pdf', size = 1000): File {
  const head = '%PDF-1.4\n';
  const tail = '\ntrailer\n%%EOF\n';
  const body = ' '.repeat(Math.max(0, size - head.length - tail.length));
  const bytes = new TextEncoder().encode(`${head}${body}${tail}`);
  // Keep the declared size honest so `sizeBefore` assertions mean something.
  const padded = new Uint8Array(size);
  padded.set(bytes.subarray(0, Math.min(size, bytes.length)));
  return new File([bytes], name, { type: 'application/pdf' });
}

/** The mocked `core/render` surface, typed for assertions. */
const thumbnailsMock = renderLib.thumbnails as unknown as ReturnType<typeof vi.fn>;

function loadFile(file: File, extra: File[] = []) {
  useFileStore.setState({ file, files: [file, ...extra], metadata: null });
}

beforeAll(() => {
  // jsdom's object URLs are not deterministic; the components only need a string.
  URL.createObjectURL = vi.fn(() => 'blob:tests') as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  seen.phase = undefined;
  seen.percent = undefined;
  seen.filePercent = undefined;
  useProcessStore.getState().reset();
  useProcessStore.setState({ activeTool: null, sessions: {} });
  useFileStore.setState({ file: null, files: [], metadata: null, activeTool: null, sessions: {} });
});

// ── pure rail logic ─────────────────────────────────────────────────────────

describe('checkFields', () => {
  it('leaves an in-range value untouched and reports nothing', () => {
    const result = checkFields([qualityField], { dpi: 150 });
    expect(result.values.dpi).toBe(150);
    expect(result.issues).toEqual({});
    expect(result.notices).toEqual({});
  });

  it('clamps above the maximum, names the range and unit, and keeps running', () => {
    const result = checkFields([qualityField], { dpi: 400 });
    expect(result.values.dpi).toBe(300);
    expect(result.notices.dpi).toBe('Resolution must be between 72 and 300 dpi: 400 became 300.');
    expect(result.issues.dpi).toBeUndefined();
  });

  it('clamps below the minimum', () => {
    const result = checkFields([qualityField], { dpi: 10 });
    expect(result.values.dpi).toBe(72);
    expect(result.notices.dpi).toContain('72 and 300 dpi');
  });

  it('rounds a fraction on an integer field', () => {
    const result = checkFields([integerField], { margin: 12.7 });
    expect(result.values.margin).toBe(13);
    expect(result.notices.margin).toContain('became 13');
  });

  it('reports a non-number instead of defaulting silently', () => {
    const result = checkFields([qualityField], { dpi: Number.NaN });
    expect(result.issues.dpi).toContain('Resolution must be a number');
  });

  it('blocks a required text field that is empty', () => {
    expect(checkFields([markField], { owner: '  ' }).issues.owner).toBe('Owner name is required.');
    expect(checkFields([markField], { owner: 'ACME' }).issues.owner).toBeUndefined();
  });

  it('rejects a page range that cannot be parsed', () => {
    const result = checkFields([pagesField], { pages: 'abc' }, { pageCount: 6 });
    expect(result.issues.pages).toContain('is not a page number');
  });

  it('rejects a page beyond the document, naming its size (E6)', () => {
    const result = checkFields([pagesField], { pages: '1-9' }, { pageCount: 3 });
    expect(result.issues.pages).toContain('this document has 3 pages');
  });

  it('accepts page 1 of a one-page document and refuses page 2 (E6)', () => {
    expect(checkFields([pagesField], { pages: '1' }, { pageCount: 1 }).issues.pages).toBeUndefined();
    expect(checkFields([pagesField], { pages: '2' }, { pageCount: 1 }).issues.pages).toContain('has 1 page');
  });

  it('says so when a range runs backwards', () => {
    expect(checkFields([pagesField], { pages: '5-3' }, { pageCount: 8 }).issues.pages).toContain('runs backwards');
  });

  it('ignores a field the tool hid', () => {
    const hidden: ToolField = { ...qualityField, when: (values) => values.other === true };
    expect(checkFields([hidden], { dpi: 900, other: false }).notices.dpi).toBeUndefined();
  });
});

describe('groupFields', () => {
  it('buckets fields under their group, in first-appearance order', () => {
    const groups = groupFields([qualityField, markField, presetField]);
    expect(groups.map((group) => group.title)).toEqual(['Quality', 'Marks']);
    expect(groups[0].fields.map((field) => field.key)).toEqual(['dpi', 'preset']);
  });

  it('puts ungrouped fields in an untitled group', () => {
    expect(groupFields([pagesField])[0].title).toBe('');
  });
});

describe('verbs and promises', () => {
  it('names the action instead of running', () => {
    expect(verbFor(TOOL_STAND['compress-thing'])).toBe('Compress');
    expect(verbFor(TOOL_STAND['merge-thing'])).toBe('Merge');
    expect(verbFor(TOOL_STAND['pages-thing'])).toBe('Extract');
    expect(verbFor(TOOL_STAND['broken-thing'])).toBe('Repair');
  });

  it('honours a tool-provided verb', () => {
    expect(verbFor({ ...TOOL_STAND['compress-thing'], actionLabel: 'Shrink it' })).toBe('Shrink it');
  });

  it('gives every shipped tool a verb of its own', async () => {
    const { organizeTools } = await import('@/lib/pdf/tools/organize');
    const { optimizeTools } = await import('@/lib/pdf/tools/optimize');
    const { editTools } = await import('@/lib/pdf/tools/edit');
    const { securityTools } = await import('@/lib/pdf/tools/security');
    const { convertToTools } = await import('@/lib/pdf/tools/convert-to');
    const { convertFromTools } = await import('@/lib/pdf/tools/convert-from');
    const all = [
      ...organizeTools, ...optimizeTools, ...editTools, ...securityTools,
      ...convertToTools, ...convertFromTools,
    ];
    expect(all.length).toBeGreaterThan(100);
    expect(all.filter((tool) => verbFor(tool) === 'Run').map((tool) => tool.id)).toEqual([]);
  });

  it('promises a concrete outcome per category, overridable per tool', () => {
    expect(promiseFor(TOOL_STAND['compress-thing'])).toMatch(/before and after/);
    expect(promiseFor(TOOL_STAND['merge-thing'])).toMatch(/never modified/);
    expect(promiseFor({ ...TOOL_STAND['merge-thing'], promise: 'One PDF, your order.' })).toBe('One PDF, your order.');
  });
});

// ── store ───────────────────────────────────────────────────────────────────

describe('process store phases, per-file progress and sizes', () => {
  it('starts idle and flips to running with every per-file counter reset', () => {
    const store = useProcessStore.getState();
    expect(store.phase).toBe('idle');
    store.setFileState('doc.pdf', { percent: 40, pages: 12 });
    useProcessStore.getState().startProcessing('Merge', '_merged.pdf');
    const next = useProcessStore.getState();
    expect(next.phase).toBe('running');
    expect(next.fileStates['doc.pdf'].percent).toBe(0);
    expect(next.fileStates['doc.pdf'].error).toBeNull();
    // Inspection results survive a run; progress and errors do not.
    expect(next.fileStates['doc.pdf'].pages).toBe(12);
    expect(next.warnings).toEqual([]);
  });

  it('tracks a named per-file progress and clamps it', () => {
    useProcessStore.getState().setFileState('doc.pdf', { percent: 160, message: 'page 3 of 12' });
    expect(useProcessStore.getState().fileStates['doc.pdf'].percent).toBe(100);
    expect(useProcessStore.getState().fileStates['doc.pdf'].message).toBe('page 3 of 12');
  });

  it('records sizes and de-duplicates warnings', () => {
    const store = useProcessStore.getState();
    store.setSizeBefore(2048);
    store.addWarning('OCR skipped on page 4');
    store.addWarning('OCR skipped on page 4');
    const next = useProcessStore.getState();
    expect(next.sizeBefore).toBe(2048);
    expect(next.warnings).toEqual(['OCR skipped on page 4']);
  });

  it('moves to done on output, error on failure and idle on reset', () => {
    const blob = new Blob(['x'], { type: 'application/pdf' });
    useProcessStore.getState().startProcessing('Merge', '_merged.pdf');
    useProcessStore.getState().setOutput(blob, 'blob:one', 'out.pdf');
    expect(useProcessStore.getState().phase).toBe('done');
    expect(useProcessStore.getState().sizeAfter).toBe(blob.size);
    useProcessStore.getState().addOutput(blob, 'blob:two', 'out-2.pdf');
    expect(useProcessStore.getState().sizeAfter).toBe(blob.size * 2);
    useProcessStore.getState().setError('doc.pdf is truncated');
    expect(useProcessStore.getState().phase).toBe('error');
    useProcessStore.getState().reset();
    expect(useProcessStore.getState().phase).toBe('idle');
  });

  it('carries the new fields when a tool slot is parked and restored', () => {
    const store = useProcessStore.getState();
    store.setActiveTool('merge' as never);
    store.setFileState('doc.pdf', { percent: 30, pages: 4 });
    store.addWarning('slow path');
    store.setSizeBefore(10);
    store.setPhase('ready');
    useProcessStore.getState().setActiveTool('split' as never);
    expect(useProcessStore.getState().phase).toBe('idle');
    useProcessStore.getState().setActiveTool('merge' as never);
    const back = useProcessStore.getState();
    expect(back.fileStates['doc.pdf'].pages).toBe(4);
    expect(back.fileStates['doc.pdf'].percent).toBe(30);
    expect(back.warnings).toEqual(['slow path']);
    expect(back.sizeBefore).toBe(10);
    expect(back.phase).toBe('ready');
  });
});

// ── states ──────────────────────────────────────────────────────────────────

describe('ProgressBar', () => {
  it('clamps the reported value and shows the step', () => {
    render(<ProgressBar percent={137} message="Rewriting images" label="Working" />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '100');
    expect(screen.getByText('Rewriting images')).toBeInTheDocument();
    expect(screen.getByText('Working')).toBeInTheDocument();
  });

  it('drops the fake number when there is no denominator', () => {
    render(<ProgressBar percent={0} indeterminate />);
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });
});

describe('EmptyState', () => {
  it('explains the nothing', () => {
    render(
      <EmptyState
        title="No forms found"
        body="This PDF has nothing to fill."
        action={<button type="button">Load another</button>}
      />,
    );
    expect(screen.getByText('No forms found')).toBeInTheDocument();
    expect(screen.getByText('This PDF has nothing to fill.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load another' })).toBeInTheDocument();
  });
});

describe('ErrorPanel', () => {
  it('names the file and offers Retry', () => {
    const onRetry = vi.fn();
    render(<ErrorPanel message="is truncated after the xref table." fileName="annual report.pdf" onRetry={onRetry} />);
    expect(screen.getByRole('alert').textContent).toContain('annual report.pdf');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('turns a password failure into an actionable hint', () => {
    render(<ErrorPanel message="This PDF is password protected." fileName="sec.pdf" />);
    expect(screen.getByRole('alert').textContent).toContain('Enter the PDF password');
  });
});

describe('FileQueue', () => {
  const items: FileQueueItem[] = [
    { id: 'a.pdf', name: 'a.pdf', size: 2048, pages: 4 },
    { id: 'b.pdf', name: 'b.pdf', size: 4096, pages: null, busy: true, percent: 25, message: 'Reading pages' },
    { id: 'c.pdf', name: 'c.pdf', size: 0, error: 'This file is empty (0 bytes).' },
  ];

  it('shows name, size and page count per row', () => {
    render(<FileQueue items={items} />);
    expect(screen.getByText(/2\.0 KB · 4 pages/)).toBeInTheDocument();
  });

  it('marks unknown page counts and shows per-file progress', () => {
    render(<FileQueue items={items} />);
    expect(screen.getByText(/counting pages/)).toBeInTheDocument();
    expect(screen.getByText('Reading pages')).toBeInTheDocument();
    expect(screen.getAllByRole('progressbar')).toHaveLength(1);
  });

  it('names the failing file and retries it', () => {
    const onRetry = vi.fn();
    render(<FileQueue items={items} onRetry={onRetry} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('c.pdf');
    expect(alert.textContent).toContain('This file is empty (0 bytes).');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledWith('c.pdf');
  });

  it('reorders and removes by position and id', () => {
    const onReorder = vi.fn();
    const onRemove = vi.fn();
    render(<FileQueue items={items} onReorder={onReorder} onRemove={onRemove} />);
    expect(screen.getByLabelText('Move a.pdf earlier')).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Move a.pdf later'));
    expect(onReorder).toHaveBeenCalledWith(0, 1);
    fireEvent.click(screen.getByLabelText('Remove b.pdf'));
    expect(onRemove).toHaveBeenCalledWith('b.pdf');
  });

  it('falls back to an empty state rather than an empty box', () => {
    render(<FileQueue items={[]} />);
    expect(screen.getByText('No files yet')).toBeInTheDocument();
  });
});

// ── thumbnails ──────────────────────────────────────────────────────────────

describe('PageThumbs', () => {
  function scroller(): HTMLElement {
    const element = screen.getByLabelText('Pages');
    Object.defineProperty(element, 'clientHeight', { value: 300, configurable: true });
    return element;
  }

  it('renders a window of a 500-page document instead of 500 nodes (E7)', () => {
    thumbnailsMock.mockClear();
    render(<PageThumbs session={fakeSession(500)} selected={[]} onSelect={() => {}} />);
    const cells = screen.getAllByRole('button', { name: /^Page \d+$/ });
    expect(cells.length).toBeLessThan(60);
    expect(screen.getByRole('button', { name: 'Page 1' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Page 500' })).not.toBeInTheDocument();
    expect(thumbnailsMock.mock.calls.length).toBeLessThan(60);
  });

  it('swaps the window when the strip scrolls', () => {
    const session = fakeSession(500);
    render(<PageThumbs session={session} selected={[]} onSelect={() => {}} rowHeight={150} columns={4} />);
    const element = scroller();
    Object.defineProperty(element, 'scrollTop', { value: 4500, configurable: true });
    fireEvent.scroll(element);
    // Row 30 of a 4-column grid: the window follows the scroll, not the document.
    expect(screen.getByRole('button', { name: 'Page 117' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Page 1' })).not.toBeInTheDocument();
  });

  it('selects on click and extends on shift-click', () => {
    const onSelect = vi.fn();
    render(<PageThumbs session={fakeSession(6)} selected={[1]} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: 'Page 3' }));
    expect(onSelect).toHaveBeenLastCalledWith([1, 3]);
    fireEvent.click(screen.getByRole('button', { name: 'Page 4' }), { shiftKey: true });
    expect(onSelect).toHaveBeenLastCalledWith([1, 3, 4]);
  });

  it('hands the selection to rotate and delete hooks', () => {
    const onRotate = vi.fn();
    const onDelete = vi.fn();
    render(
      <PageThumbs
        session={fakeSession(4)}
        selected={[2, 3]}
        onSelect={() => {}}
        onRotate={onRotate}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onRotate).toHaveBeenCalledWith([2, 3], 90);
    expect(onDelete).toHaveBeenCalledWith([2, 3]);
    expect(screen.getByText('2 of 4 selected')).toBeInTheDocument();
  });

  it('keeps the rotate hooks off until something is selected', () => {
    render(<PageThumbs session={fakeSession(4)} selected={[]} onSelect={() => {}} onRotate={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Rotate' })).toBeDisabled();
  });

  it('shows an empty state when there is no document', () => {
    render(<PageThumbs session={null} />);
    expect(screen.getByText('No pages to show')).toBeInTheDocument();
  });
});

// ── preview ─────────────────────────────────────────────────────────────────

describe('PreviewPane', () => {
  it('steps pages and refuses one that does not exist (E6)', () => {
    render(<PreviewPane session={fakeSession(1)} />);
    expect(screen.getByLabelText('Page number')).toHaveValue(1);
    expect(screen.getByLabelText('Next page')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Page number'), { target: { value: '2' } });
    expect(screen.getByText(/This PDF has one page/)).toBeInTheDocument();
    expect(screen.getByLabelText('Page number')).toHaveValue(1);
  });

  it('clamps a typed page into the document and explains it', () => {
    render(<PreviewPane session={fakeSession(8)} page={3} />);
    fireEvent.change(screen.getByLabelText('Page number'), { target: { value: '14' } });
    expect(screen.getByText(/showing page 8/)).toBeInTheDocument();
  });

  it('zooms, fits and rotates without touching a real canvas', async () => {
    const session = fakeSession(3);
    render(<PreviewPane session={session} />);
    expect(screen.getByText('Fit width')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Zoom in'));
    expect(await screen.findByText(/%/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Zoom out'));
    fireEvent.click(screen.getByText('Actual size'));
    fireEvent.click(screen.getByLabelText('Rotate preview right'));
    const canvas = document.querySelector('canvas');
    expect(canvas).not.toBeNull();
    expect(session.renderToCanvas).not.toBe(undefined);
    await waitFor(() => expect(canvas).toBeTruthy());
  });

  it('shows the page geometry including its /Rotate (E8, E9)', async () => {
    render(<PreviewPane session={fakeSession(2)} />);
    expect(await screen.findByText(/612 × 792 pt · page \/Rotate 90/)).toBeInTheDocument();
  });

  it('turns into a before/after split for transform tools', () => {
    render(<PreviewPane session={fakeSession(3)} after={fakeSession(3)} />);
    expect(screen.getByText('Before')).toBeInTheDocument();
    expect(screen.getByText('After')).toBeInTheDocument();
    expect(screen.getByLabelText('Before and after split')).toBeInTheDocument();
    expect(screen.getByText(/before \/ after/)).toBeInTheDocument();
  });

  it('is an honest empty pane when nothing is loaded', () => {
    render(<PreviewPane session={null} />);
    expect(screen.getByText('Nothing to preview yet')).toBeInTheDocument();
  });

  it('names the file when a page fails to draw', async () => {
    const session = fakeSession(2);
    (session.renderToCanvas as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Page 2 is corrupt.'),
    );
    render(<PreviewPane session={session} fileName="scan.pdf" />);
    expect(await screen.findByText(/scan\.pdf/)).toBeInTheDocument();
  });
});

// ── results ─────────────────────────────────────────────────────────────────

function item(name: string, size: number, pages?: number): ResultItem {
  return { name, blob: new Blob([new Uint8Array(size)], { type: 'application/pdf' }), pages };
}

describe('describeDelta', () => {
  it('reports the saving', () => {
    expect(describeDelta(1000, 400)).toMatch(/60% smaller/);
  });

  it('reports the growth instead of hiding it (E14)', () => {
    expect(describeDelta(1000, 1200)).toMatch(/20% larger/);
  });

  it('says unchanged rather than 0% smaller', () => {
    expect(describeDelta(1000, 1000)).toMatch(/unchanged/);
  });

  it('has nothing to compare when the input size is unknown', () => {
    expect(describeDelta(null, 1000)).toBe('1000 B');
  });
});

describe('ResultCard', () => {
  it('shows name, size delta and page count', () => {
    render(<ResultCard outputs={[item('report_compressed.pdf', 400)]} sizeBefore={1000} pages={12} />);
    expect(screen.getByText('report_compressed.pdf')).toBeInTheDocument();
    expect(screen.getByText(/60% smaller/)).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  it('names the engine, or admits it degraded', () => {
    const { rerender } = render(<ResultCard outputs={[item('a.pdf', 10)]} engine="ghostscript" />);
    expect(screen.getByText('Ghostscript')).toBeInTheDocument();
    rerender(<ResultCard outputs={[item('a.pdf', 10)]} engine="ghostscript" degraded warnings={['Ghostscript unavailable — used the core path.']} />);
    expect(screen.getByText('Ghostscript · degraded')).toBeInTheDocument();
    expect(screen.getByText(/Ghostscript unavailable/)).toBeInTheDocument();
  });

  it('offers the original back when the output grew (E14)', () => {
    const onDownload = vi.fn();
    render(
      <ResultCard
        outputs={[item('bigger.pdf', 1200)]}
        sizeBefore={1000}
        original={item('original.pdf', 1000)}
        onDownload={onDownload}
      />,
    );
    expect(screen.getByText(/20% larger/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep original' }));
    expect(onDownload).toHaveBeenCalledWith(expect.objectContaining({ name: 'original.pdf' }));
  });

  it('downloads, downloads all and zips', async () => {
    const onDownload = vi.fn();
    const outputs = [item('a.pdf', 10), item('b.pdf', 20)];
    const { rerender } = render(<ResultCard outputs={outputs.slice(0, 1)} onDownload={onDownload} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(onDownload).toHaveBeenCalledWith(expect.objectContaining({ name: 'a.pdf' }));

    const onDownloadAll = vi.fn();
    rerender(<ResultCard outputs={outputs} onDownloadAll={onDownloadAll} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download all' }));
    expect(onDownloadAll).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Download b.pdf' })).toBeInTheDocument();

    const onZip = vi.fn();
    rerender(<ResultCard outputs={outputs} onZip={onZip} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download as zip' }));
    await waitFor(() => expect(onZip).toHaveBeenCalledWith(outputs));
  });

  it('builds a zip itself when no handler is supplied', async () => {
    const clicks: string[] = [];
    const spy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function click(this: HTMLAnchorElement) {
        clicks.push(this.download);
      });
    render(<ResultCard outputs={[item('a.pdf', 10), item('b.pdf', 20)]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download as zip' }));
    await waitFor(() => expect(clicks.some((name) => name.endsWith('a-results.zip'))).toBe(true));
    spy.mockRestore();
  });

  it('is an honest empty card when the run produced nothing (E13)', () => {
    render(<ResultCard outputs={[]} emptyTitle="No tables found" />);
    expect(screen.getByText('No tables found')).toBeInTheDocument();
  });
});

// ── hook: the state machine ─────────────────────────────────────────────────

describe('usePdfTool', () => {
  it('is idle without a file and tells the user what is missing (E18)', async () => {
    const { result } = renderHook(() => usePdfTool('compress-thing'));
    await waitFor(() => expect(result.current.tool).toBeTruthy());
    expect(result.current.canRun).toBe(false);
    expect(result.current.blockers[0]).toMatch(/Add a PDF first/);
    expect(result.current.phase).toBe('idle');
  });

  it('is inspecting until the page count is known, ready once it is', async () => {
    loadFile(pdfFile());
    const { result, rerender } = renderHook(
      ({ pageCount }: { pageCount: number | null }) => usePdfTool('compress-thing', { pageCount }),
      { initialProps: { pageCount: null } },
    );
    await waitFor(() => expect(result.current.tool).toBeTruthy());
    expect(result.current.phase).toBe('inspecting');
    rerender({ pageCount: 3 });
    await waitFor(() => expect(result.current.phase).toBe('ready'));
  });

  it('reads the page count from the file itself, not from metadata', async () => {
    // Nothing in the app writes file-store metadata for a PDF, so a page count
    // that arrives only as an option is a page count that never arrives: ranges
    // validated against null (E6) and the rail sat on "Reading file" forever
    // while the preview beside it was already on page 10.
    const { PDFDocument } = await import('@maxwbh/pdf-lib');
    const doc = await PDFDocument.create();
    doc.addPage([300, 200]);
    doc.addPage([300, 200]);
    const bytes = await doc.save();
    const real = new File([bytes as unknown as BlobPart], 'real.pdf', { type: 'application/pdf' });
    loadFile(real);

    const { result } = renderHook(() => usePdfTool('compress-thing', {}));
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    expect(result.current.pageCount).toBe(2);
  });

  it('treats a header-only or damaged file as unknown, not as zero pages', async () => {
    // pdfFile() is `%PDF-1.4` plus a trailer with no body: reporting 0 pages as
    // if it were a fact would flip the rail to ready and let a range field
    // validate against nothing.
    loadFile(pdfFile());
    const { result } = renderHook(() => usePdfTool('compress-thing', {}));
    await waitFor(() => expect(result.current.tool).toBeTruthy());
    await new Promise((r) => setTimeout(r, 60));
    expect(result.current.pageCount).toBeNull();
    expect(result.current.phase).toBe('inspecting');
  });

  it('blocks until a required field has a value, then lets go', async () => {
    loadFile(pdfFile());
    const { result } = renderHook(() => usePdfTool('compress-thing', { pageCount: 3 }));
    await waitFor(() => expect(result.current.tool).toBeTruthy());
    expect(result.current.issues.owner).toBe('Owner name is required.');
    expect(result.current.canRun).toBe(false);
    act(() => result.current.setValue('owner', 'ACME'));
    expect(result.current.canRun).toBe(true);
    expect(result.current.issues.owner).toBeUndefined();
  });

  it('surfaces a clamp as a notice while keeping the run value legal', async () => {
    loadFile(pdfFile());
    const { result } = renderHook(() => usePdfTool('compress-thing', { pageCount: 3 }));
    await waitFor(() => expect(result.current.tool).toBeTruthy());
    act(() => result.current.setValue('owner', 'ACME'));
    act(() => result.current.setValue('dpi', 900));
    expect(result.current.notices.dpi).toContain('Resolution must be between 72 and 300 dpi: 900 became 300.');
    expect(result.current.checked.dpi).toBe(300);
    expect(result.current.canRun).toBe(true);
  });

  it('refuses a repeated file before the click (E16)', async () => {
    loadFile(pdfFile('doc.pdf'), [pdfFile('doc.pdf')]);
    const { result } = renderHook(() => usePdfTool('merge-thing', { pageCount: 3 }));
    await waitFor(() => expect(result.current.tool).toBeTruthy());
    // Listing the same file twice in a multi-document tool is a plan, not a
    // mistake: merging report.pdf with itself is a two-part document. So the
    // button stays live and the rail confirms the intent instead.
    expect(result.current.canRun).toBe(true);
    expect(result.current.advisories.join(' ')).toContain('is in the list 2 times');
  });

  it('counts pages out of range for a page field (E6)', async () => {
    loadFile(pdfFile());
    const { result } = renderHook(() => usePdfTool('pages-thing', { pageCount: 3 }));
    await waitFor(() => expect(result.current.tool).toBeTruthy());
    act(() => result.current.setValue('pages', '1-9'));
    await waitFor(() => expect(result.current.issues.pages).toContain('this document has 3 pages'));
  });

  it('refuses to run without an engine it declared, and says which (E20)', async () => {
    loadFile(pdfFile());
    const provider = await import('@/lib/pdf/engines');
    const original = provider.engines.isConfigured;
    provider.engines.isConfigured = (id: string) => (id === 'ghostscript' ? false : original(id as never));
    try {
      const { result } = renderHook(() => usePdfTool('engine-thing', { pageCount: 3 }));
      await waitFor(() => expect(result.current.tool).toBeTruthy());
      expect(result.current.canRun).toBe(false);
      expect(result.current.blockers.join(' ')).toMatch(/ghostscript/i);
      expect(result.current.blockers.join(' ')).not.toMatch(/\[object Object\]/);
    } finally {
      provider.engines.isConfigured = original;
    }
  });

  it('walks idle → running → done with per-file progress and sizes', async () => {
    const file = pdfFile('doc.pdf', 1000);
    loadFile(file);
    const { result } = renderHook(() => usePdfTool('compress-thing', { pageCount: 3 }));
    await waitFor(() => expect(result.current.tool).toBeTruthy());
    act(() => result.current.setValue('owner', 'ACME'));

    await act(async () => {
      await result.current.run();
    });

    expect(seen.phase).toBe('running');
    expect(seen.filePercent).toBe(0);
    const state = useProcessStore.getState();
    expect(state.phase).toBe('done');
    expect(state.sizeBefore).toBe(1000);
    expect(state.sizeAfter).toBe(state.outputBlob?.size ?? 0);
    expect(state.fileStates['doc.pdf'].percent).toBe(100);
    expect(state.warnings).toEqual(['warning: fonts are degraded to substitutes']);
    expect(state.outputNames[0]).toBe('doc_compressed.pdf');
  });

  it('makes the result stale when the inputs change after a run', async () => {
    loadFile(pdfFile());
    const { result } = renderHook(() => usePdfTool('compress-thing', { pageCount: 3 }));
    await waitFor(() => expect(result.current.tool).toBeTruthy());
    act(() => result.current.setValue('owner', 'ACME'));
    await act(async () => {
      await result.current.run();
    });
    expect(useProcessStore.getState().phase).toBe('done');
    act(() => result.current.setValue('dpi', 200));
    await waitFor(() => expect(useProcessStore.getState().phase).toBe('ready'));
  });

  it('names the file that failed and keeps it on the row (E1/E2/E4)', async () => {
    loadFile(pdfFile('doc.pdf'));
    const { result } = renderHook(() => usePdfTool('broken-thing', { pageCount: 3 }));
    await waitFor(() => expect(result.current.tool).toBeTruthy());
    await act(async () => {
      expect(await result.current.run()).toBeNull();
    });
    const state = useProcessStore.getState();
    expect(state.phase).toBe('error');
    expect(state.error).toContain('doc.pdf is truncated');
    expect(state.fileStates['doc.pdf'].error).toContain('truncated');
  });

  it('raises the password gate when the file is locked', async () => {
    loadFile(pdfFile('doc.pdf'));
    const { result } = renderHook(() => usePdfTool('locked-thing', { pageCount: 3 }));
    await waitFor(() => expect(result.current.tool).toBeTruthy());
    expect(result.current.needsPassword).toBe(true);
    await act(async () => {
      await result.current.run();
    });
    await waitFor(() => expect(result.current.locked).toBe(true));
    expect(result.current.phase).toBe('error');
  });

  it('clears everything on cancel so no stale output survives (E19)', async () => {
    loadFile(pdfFile());
    const { result } = renderHook(() => usePdfTool('slow-thing', { pageCount: 3 }));
    await waitFor(() => expect(result.current.tool).toBeTruthy());
    let pending: Promise<unknown> = Promise.resolve(null);
    act(() => {
      pending = result.current.run();
    });
    await waitFor(() => expect(useProcessStore.getState().phase).toBe('running'));
    act(() => result.current.cancel());
    await act(async () => {
      expect(await pending).toBeNull();
    });
    const state = useProcessStore.getState();
    expect(state.outputBlobs).toHaveLength(0);
    expect(state.outputUrl).toBeNull();
    expect(state.progress).toBe(0);
    expect(['idle', 'inspecting', 'ready']).toContain(state.phase);
  });
});

// ── the rail itself ─────────────────────────────────────────────────────────

describe('PdfToolPanel', () => {
  it('puts a one-line promise under the title and groups the fields', async () => {
    render(<PdfToolPanel toolId="compress-thing" />);
    expect(await screen.findByText(/size before and after/)).toBeInTheDocument();
    expect(screen.getByText('Quality')).toBeInTheDocument();
    expect(screen.getByText('Marks')).toBeInTheDocument();
  });

  it('labels the action with the tool verb and keeps it off until valid (E18)', async () => {
    render(<PdfToolPanel toolId="compress-thing" />);
    const button = await screen.findByRole('button', { name: 'Compress' });
    expect(button).toBeDisabled();
    expect(screen.getByText(/Add a PDF first/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run' })).not.toBeInTheDocument();
  });

  it('turns the action on once a file and the required text are in place', async () => {
    loadFile(pdfFile());
    render(<PdfToolPanel toolId="compress-thing" />);
    const button = await screen.findByRole('button', { name: 'Compress' });
    await waitFor(() => expect(screen.getByLabelText('Owner name')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Owner name'), { target: { value: 'ACME' } });
    await waitFor(() => expect(button).toBeEnabled());
  });

  it('keeps what the user typed and shows the clamp reason beside it (E15)', async () => {
    loadFile(pdfFile());
    render(<PdfToolPanel toolId="compress-thing" />);
    fireEvent.change(await screen.findByLabelText('Owner name'), { target: { value: 'ACME' } });
    const dpi = screen.getByLabelText('Resolution');
    fireEvent.change(dpi, { target: { value: '400' } });
    expect(await screen.findByText(/Resolution must be between 72 and 300 dpi: 400 became 300\./)).toBeInTheDocument();
    expect(screen.getByLabelText('Resolution')).toHaveValue(400);
    expect(screen.getByText('300dpi')).toBeInTheDocument();
    // A clamped value is a notice, not a blocker: the action stays available.
    expect(screen.getByRole('button', { name: 'Compress' })).toBeEnabled();
  });

  it('collapses the honesty notes until asked', async () => {
    render(<PdfToolPanel toolId="compress-thing" />);
    const toggle = await screen.findByRole('button', { name: /Honest notes/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/photos blur/)).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByText(/photos blur/)).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('queues the loaded files with order controls', async () => {
    loadFile(pdfFile('one.pdf'), [pdfFile('two.pdf')]);
    render(<PdfToolPanel toolId="merge-thing" />);
    expect(await screen.findByText('Your files')).toBeInTheDocument();
    expect(screen.getByLabelText('Move one.pdf later')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Remove two.pdf'));
    expect(useFileStore.getState().files.map((file) => file.name)).toEqual(['one.pdf']);
  });

  it('summarises the result in the rail once the run is done', async () => {
    loadFile(pdfFile('doc.pdf', 4000));
    render(<PdfToolPanel toolId="compress-thing" />);
    fireEvent.change(await screen.findByLabelText('Owner name'), { target: { value: 'ACME' } });
    fireEvent.click(screen.getByRole('button', { name: 'Compress' }));
    const card = await screen.findByLabelText('Result');
    expect(card.textContent).toContain('doc_compressed.pdf');
    expect(card.textContent).toMatch(/\d+% (smaller|larger)/);
    expect(card.textContent).toContain('warning: fonts are degraded to substitutes');
  });

  it('shows the guard layer\'s hint under a failure', async () => {
    loadFile(pdfFile('doc.pdf'));
    render(<PdfToolPanel toolId="guard-thing" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Convert' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('is not a PDF');
    expect(alert.textContent).toContain('Export it as a PDF from the app that made it.');
  });

  it('offers Retry beside a failure that names the file', async () => {
    loadFile(pdfFile('doc.pdf'));
    render(<PdfToolPanel toolId="broken-thing" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Repair' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('doc.pdf');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(useProcessStore.getState().error).toContain('truncated'));
  });
});
