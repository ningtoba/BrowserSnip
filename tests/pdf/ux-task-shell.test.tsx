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
 *   no fields, no action, no preview, no rail — plus one line naming the formats
 *   the picker will take, so a tool that wants a `.docx` never just says "Select
 *   file";
 * - the promise is said once, beside the action: the page header keeps the
 *   breadcrumb, the name and the star, and the intake owns the sentence;
 * - the intake is anchored high instead of floating in the middle of a tall
 *   window, its button is capped rather than edge-to-edge, and it scrolls rather
 *   than colliding on a short one;
 * - a drop anywhere on the tab is accepted, including outside the button;
 * - the loaded page is horizontal file cards (name over two lines with the
 *   extension kept reachable, size, page count, remove, reorder, add more) with a
 *   compact options bar — one field, only what the user moved echoed beside it,
 *   the rest behind a disclosure that counts them and flags what needs attention
 *   — and the verb at its right edge, sitting under the queue rather than
 *   floating at the bottom of a page that does not scroll;
 * - a run is centred progress that names the file and can be cancelled;
 * - the result is a screen of its own — checkmark, output name, size before →
 *   after, pages in → out, warnings, the produced file drawn before the user is
 *   asked to take it, a dominant download, and two quiet ways onward; the output
 *   count comes from the producer that held the document, and a run that produced
 *   no PDF says so instead of claiming pages;
 * - a failure prints its reason once, names the file, and offers Retry.
 *
 * jsdom has no canvas and no layout, so sizing is asserted through the classes
 * that ask for it (`min-h-[88px]`, `max-w-[400px]`, `line-clamp-2`) and images
 * through the `data-*` state markers, never through pixels.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { useFileStore } from '@/stores/file-store';
import { useProcessStore } from '@/stores/process-store';
import { PdfToolPanel } from '@/components/tools/pdf/shared/PdfToolPanel';
import { ToolWorkspace } from '@/components/layout/ToolWorkspace';
import { ToolPageHeader } from '@/components/layout/AppLayout';
import { describeOptions, leadField, quietSummary, splitFileName, verbFor } from '@/components/tools/pdf/shared/toolForm';
import { intakeCopy, intakeFootNote, intakeFormats } from '@/components/tools/pdf/shared/FileIntake';
import { surfaceState } from '@/components/tools/pdf/shared/ToolSurface';
import { openRender } from '@/lib/pdf/core/render';
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
const stampField: ToolField = { key: 'stamp', label: 'Stamp text', type: 'text', required: true, group: 'Marks' };

/** What the last fake run was given, and the gate that lets it finish. */
const live: { release: (() => void) | null } = { release: null };

function bytes(size: number): Uint8Array {
  return new TextEncoder().encode('x'.repeat(size));
}

/** A blob that is not a PDF, for a run whose output has no pages. */
function pdfBlob(name: string, size: number): { blob: Blob; name: string } {
  return { blob: new Blob([bytes(size)], { type: 'application/pdf' }), name };
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
  /** Eight pages out of twenty, counted by the producer that held the document. */
  'shell-eight': {
    id: 'shell-eight',
    name: 'Trim Shell',
    description: 'Keep every other page',
    icon: '✂',
    category: 'organize',
    actionLabel: 'Trim',
    outputSuffix: '_trimmed.pdf',
    run: async () => ({ kind: 'pdf', bytes: bytes(300), message: 'Half the file.', pages: 8 }),
  },
  /** Three files out; only the first one's count is on the card. */
  'shell-split': {
    id: 'shell-split',
    name: 'Split Shell',
    description: 'Break the file into parts',
    icon: '🪓',
    category: 'organize',
    actionLabel: 'Split',
    outputSuffix: '_part.pdf',
    run: async () => ({
      kind: 'files',
      files: [pdfBlob('part-1.pdf', 90), pdfBlob('part-2.pdf', 80), pdfBlob('part-3.pdf', 70)],
      message: 'Three parts.',
      pages: 4,
    }),
  },
  /** A zip carries no pages, whatever a careless producer attached to it. */
  'shell-zip': {
    id: 'shell-zip',
    name: 'Archive Shell',
    description: 'Bundle the parts',
    icon: '📦',
    category: 'convert-from',
    actionLabel: 'Zip',
    outputSuffix: '.zip',
    run: async () => ({
      kind: 'files',
      files: [{ blob: new Blob(['pk'], { type: 'application/zip' }), name: 'parts.zip' }],
      message: 'One archive.',
      pages: 12,
    }),
  },
  /** A PDF out of a producer that never counted it. */
  'shell-uncounted': {
    id: 'shell-uncounted',
    name: 'Stamp Shell',
    description: 'Put a stamp on every page',
    icon: '🔖',
    category: 'edit',
    actionLabel: 'Stamp',
    outputSuffix: '_stamped.pdf',
    run: async () => ({ kind: 'pdf', bytes: bytes(50), message: 'Stamped.' }),
  },
  /** Two required options: one is visible, the other hides behind the count. */
  'shell-two': {
    id: 'shell-two',
    name: 'Marks Shell',
    description: 'Write on the file',
    icon: '✍',
    category: 'edit',
    actionLabel: 'Apply',
    outputSuffix: '_marked.pdf',
    fields: [ownerField, stampField, dpiField],
    run: heldRun({ size: 100, message: 'Marked.' }),
  },
  /** A real container: the result screen has to open it and list its entries. */
  'shell-archive': {
    id: 'shell-archive',
    name: 'Bundle Shell',
    description: 'Put the parts in an archive',
    icon: '🗂',
    category: 'convert-from',
    actionLabel: 'Bundle',
    outputSuffix: '.zip',
    run: async () => {
      const { default: JSZip } = await import('jszip');
      const archive = new JSZip();
      archive.file('page-001.png', new Uint8Array(900));
      archive.file('page-002.png', new Uint8Array(800));
      archive.file('notes.txt', 'written in this tab');
      const blob = await archive.generateAsync({ type: 'blob', mimeType: 'application/zip' });
      return {
        kind: 'files',
        files: [{ blob, name: 'bundle.zip' }],
        message: 'One archive.',
        // A careless producer's page count; a zip has none (see the card's row).
        pages: 3,
      };
    },
  },
  /** A format with nothing to draw and nothing to open. */
  'shell-csv': {
    id: 'shell-csv',
    name: 'Table Shell',
    description: 'Write the data out',
    icon: '🧮',
    category: 'convert-to',
    actionLabel: 'Export',
    outputSuffix: '.csv',
    run: async () => ({
      kind: 'files',
      files: [{ blob: new Blob([bytes(20)], { type: 'text/csv' }), name: 'table.csv' }],
      message: 'Tabulated.',
    }),
  },
  /** Several files out, none of them a PDF: an image result. */
  'shell-snapshot': {
    id: 'shell-snapshot',
    name: 'Snapshot Shell',
    description: 'Turn the pages into images',
    icon: '🖼',
    category: 'convert-from',
    actionLabel: 'Snapshot',
    outputSuffix: '.png',
    run: async () => ({
      kind: 'files',
      files: [0, 1, 2].map((index) => ({
        blob: new Blob([bytes(30)], { type: 'image/png' }),
        name: `page-00${index + 1}.png`,
      })),
      message: 'Three images.',
      pages: 3,
    }),
  },
};

/**
 * A stand-in for a document pdf.js handed back.
 *
 * `openRender` is mocked file-wide, so a test that needs a specific page count
 * builds the session itself and pumps the promise by hand — that is the only way
 * to see which document a preview belongs to after two runs have raced.
 */
function documentSession(pages: number, fingerprint = 'late-session') {
  return {
    numPages: pages,
    fingerprint,
    page: async () => ({ getViewport: () => ({ width: 612, height: 792, rotation: 0 }), cleanup() {} }),
    renderToCanvas: async () => ({}),
    destroy: async () => {},
  };
}

/**
 * What the result preview's pdf.js request answers with, for one test.
 *
 * Two callers open a document on a tool page: the loaded-file cards read the
 * input, and the preview reads what the run wrote — and the preview is the only
 * one that asks for the read to be cancellable (E19). Keying the fake on that
 * signal is what stops a card's request from eating the answer a preview test is
 * waiting for. Returns the restore.
 */
function previewAnswers(
  answer: (resolve: (session: unknown) => void, reject: (error: unknown) => void) => void,
): () => void {
  const open = openRender as unknown as ReturnType<typeof vi.fn>;
  const settled = open.getMockImplementation() as ((...args: unknown[]) => unknown) | undefined;
  open.mockImplementation((src: unknown, options?: { signal?: AbortSignal }) => {
    if (!options?.signal) return settled?.(src, options);
    return new Promise((resolve, reject) => answer(resolve, reject));
  });
  return () => {
    if (settled) open.mockImplementation(settled as (...args: unknown[]) => unknown);
  };
}

/** A real PDF, so the pre-flight can read the page count out of it. */
async function realPdf(name = 'shell.pdf', pages = 2): Promise<File> {
  const { PDFDocument } = await import('@maxwbh/pdf-lib');
  const doc = await PDFDocument.create();
  for (let index = 0; index < pages; index += 1) doc.addPage([300, 200]);
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
    // The button is the drop zone, and it is the size of a primary action — but a
    // capped one: at 640 px the solid accent block read heavier than the page
    // around it, and the width was never the point of the affordance.
    expect(pick).toHaveAttribute('data-drop-target', 'true');
    expect(pick).toHaveClass('min-h-[88px]');
    expect(pick).toHaveClass('max-w-[400px]');
    expect(screen.getByText('or drop a PDF here')).toBeInTheDocument();
    // One short line says what belongs in the picker before it opens.
    expect(footNote()).toHaveTextContent('Accepts PDF · one file at a time');
    expect(footNote()).toHaveTextContent('Recompression is lossy');
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

  /** The intake's one format line: the paragraph after "or drop … here". */
  function footNote(): HTMLElement {
    return screen.getByText('or drop a PDF here').nextElementSibling as HTMLElement;
  }

  it('sits high on the page instead of floating in the middle', async () => {
    render(<PdfToolPanel toolId="shell-compress" />);
    const intake = (await screen.findByRole('button', { name: /^Select PDF file/ })).closest('[data-intake]');
    const block = document.querySelector('[data-intake-block]');
    // jsdom does no layout, so the geometry is asserted through the classes that
    // ask for it: the region scrolls rather than centring its child, and the block
    // is pushed down by a share of the viewport so it starts about a quarter of
    // the way in. A short window scrolls instead of colliding with what follows.
    expect(intake!.className).not.toMatch(/items-center/);
    expect(intake).toHaveClass('overflow-y-auto');
    expect(block).toHaveClass('mt-[14vh]');
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

  it('says which formats belong in the picker, and how many files', () => {
    // `accept` is what the browser greys out, so it is the only honest answer to
    // "what goes here" — and a convert-from tool whose button says "Select file"
    // while the page never names `.docx` sends people to the wrong file type.
    expect(intakeFormats(undefined)).toEqual(['PDF']);
    expect(intakeFormats('.pdf,application/pdf')).toEqual(['PDF']);
    expect(intakeFormats('.docx,.doc,.odt,.rtf')).toEqual(['.docx', '.doc', '.odt', '.rtf']);
    // Aliases of one format are named once.
    expect(intakeFormats('.jpg,.jpeg,image/jpeg')).toEqual(['.jpg']);
    // A wildcard is only printed when nothing more specific is on the list.
    expect(intakeFormats('.jpg,.png,image/*')).toEqual(['.jpg', '.png']);
    expect(intakeFormats('image/*')).toEqual(['images']);

    expect(intakeFootNote(undefined, false)).toBe('Accepts PDF · one file at a time');
    expect(intakeFootNote(undefined, true)).toBe('Accepts PDF · any number of files');
    expect(intakeFootNote('.docx,.doc,.odt,.rtf', false)).toBe(
      'Accepts .docx, .doc, .odt, .rtf · one file at a time',
    );
    // Past four formats the line counts the rest rather than running over.
    expect(intakeFootNote('.jpg,.jpeg,.png,.webp,.heic,.heif,image/*', true)).toBe(
      'Accepts .jpg, .png, .webp, .heic +1 more · any number of files',
    );
    // The definition's first note joins the line while it fits, and is cut at a
    // word rather than left to wrap the intake into a paragraph.
    expect(intakeFootNote(undefined, false, ['Text stays selectable in the output.'])).toBe(
      'Accepts PDF · one file at a time · Text stays selectable in the output.',
    );
    const long = intakeFootNote('.docx,.doc,.odt,.rtf', false, [
      'Text is drawn as real, selectable PDF text through the font layer, so the result opens in Word and in a viewer alike.',
    ]);
    expect(long.length).toBeLessThanOrEqual(112);
    expect(long).toMatch(/…$/);
    expect(long).not.toMatch(/through$/);
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
    // The stage word says what the card knows: the file is read and the button is
    // free. "Waiting" here claimed a job that had not been asked for.
    expect(list.textContent).toContain('Ready');
    expect(list.textContent).not.toContain('Waiting');
    expect(screen.getByRole('button', { name: 'Remove shell.pdf' })).toBeInTheDocument();
    // One document: nothing to reorder, so no position controls.
    expect(screen.queryByLabelText('Move shell.pdf later')).toBeNull();
    // A name short enough for one line is printed whole, and the full string is
    // still on the element for the hover.
    const name = card.closest('p') as HTMLElement;
    expect(name).toHaveAttribute('title', 'shell.pdf');
    expect(name).toHaveAttribute('data-file-name', 'whole');
    expect(name.querySelector('span')).toHaveClass('line-clamp-2');
    expect(name.querySelector('[data-file-tail]')).toBeNull();
  });

  it('keeps the end of a long file name reachable', async () => {
    const long = 'quarterly-report-2024-q3-final-draft-signed.pdf';
    loadFiles([await realPdf(long)]);
    render(<PdfToolPanel toolId="shell-compress" />);

    const head = await screen.findByText(/^quarterly-report-2024/);
    const line = head.closest('p') as HTMLElement;
    // One truncated line hid the half of the name that tells files apart. The
    // head may now take two lines and the tail — extension and trailing digits —
    // gets a line of its own, so nothing is cut out of the middle.
    expect(head).toHaveClass('line-clamp-2', 'break-words');
    expect(line).toHaveAttribute('data-file-name', 'split');
    expect(line).toHaveAttribute('title', long);
    expect(line.querySelector('[data-file-tail]')?.textContent).toMatch(/\.pdf$/);
    expect(`${head.textContent}${line.querySelector('[data-file-tail]')?.textContent}`).toBe(long);
  });

  it('keeps the bar to one row and folds the rest behind a count', async () => {
    loadFiles([await realPdf()]);
    render(<PdfToolPanel toolId="shell-compress" />);

    const bar = await waitFor(() => {
      const node = document.querySelector('[data-run-bar]');
      if (!node) throw new Error('the bottom bar never mounted');
      return node as HTMLElement;
    });
    // Collapsed by default, and the field the run is waiting on is the visible
    // one — a disabled button whose cause is folded away is a dead end.
    expect(document.querySelector('[data-options-panel]')).toHaveAttribute('data-options-panel', 'closed');
    expect(screen.getByLabelText('Owner name')).toBeInTheDocument();
    expect(screen.queryByLabelText('Resolution')).toBeNull();

    const disclosure = within(bar).getByRole('button', { name: /1 more option/ });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    expect(disclosure).toHaveAttribute('aria-controls', 'tool-options');
    // A collapsed panel with nothing of the user's to report says what the run
    // will do. Printing every default instead hid the one control that decides
    // the output behind a truncation point, and read as a list nobody chose.
    expect(summaryText()).toBe('Nothing changed yet · Shrink the file');
    expect(summaryText()).not.toContain('Resolution: 150 dpi');
    // Two lines of echo rather than one clipped mid-word: what the row says has
    // to be readable at the bar's width, not only in the hover title.
    const line = document.getElementById('tool-options');
    expect(line).toHaveClass('line-clamp-2');
    expect(line).not.toHaveClass('truncate');
    // Typing into the field the row already shows as a control is a change, so
    // the line may not keep claiming the panel is on its defaults — and it does
    // not echo what is on screen beside it either, so it goes quiet.
    fireEvent.change(screen.getByLabelText('Owner name'), { target: { value: 'ACME' } });
    expect(summaryText()).toBe('');
    // The honesty panel is part of the loaded page too.
    expect(within(bar).getByRole('button', { name: /Honest notes/ })).toBeInTheDocument();

    fireEvent.click(disclosure);
    expect(screen.getByLabelText('Resolution')).toBeInTheDocument();
    fireEvent.click(within(bar).getByRole('button', { name: /Fewer options/ }));
    expect(screen.queryByLabelText('Resolution')).toBeNull();
  });

  it('echoes the option the user moved behind the fold', async () => {
    loadFiles([await realPdf()]);
    render(<PdfToolPanel toolId="shell-compress" />);
    await screen.findByLabelText('Owner name');

    fireEvent.click(screen.getByRole('button', { name: /1 more option/ }));
    fireEvent.change(screen.getByLabelText('Resolution'), { target: { value: '96' } });
    fireEvent.click(screen.getByRole('button', { name: /Fewer options/ }));
    expect(summaryText()).toBe('Resolution: 96 dpi');

    // Moving it back to where it started is still the user's decision: the row
    // tracks what a hand touched, not only what differs from a default.
    fireEvent.click(screen.getByRole('button', { name: /1 more option/ }));
    fireEvent.change(screen.getByLabelText('Resolution'), { target: { value: '150' } });
    fireEvent.click(screen.getByRole('button', { name: /Fewer options/ }));
    expect(summaryText()).toBe('Resolution: 150 dpi');
  });

  /** The collapsed row's echo line, or nothing when the row has no news. */
  function summaryText(): string {
    return document.getElementById('tool-options')?.textContent ?? '';
  }

  it('opens the folded options from the keyboard and takes focus back on collapse', async () => {
    loadFiles([await realPdf()]);
    render(<PdfToolPanel toolId="shell-compress" />);
    const closed = await screen.findByRole('button', { name: /1 more option/ });
    // A native button with no tabindex override, so `Tab` reaches it and
    // Enter/Space activates it — which is the click `.click()` dispatches.
    expect(closed.tagName).toBe('BUTTON');
    expect(closed).not.toHaveAttribute('tabindex');

    closed.focus();
    act(() => closed.click());
    expect(screen.getByRole('button', { name: /Fewer options/ })).toHaveAttribute('aria-expanded', 'true');

    // The user walks into the panel, then closes it from inside it.
    const owner = screen.getByLabelText('Owner name');
    owner.focus();
    expect(document.activeElement).toBe(owner);
    act(() => screen.getByRole('button', { name: /Fewer options/ }).click());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /1 more option/ }));
  });

  it('blocks the action for an option it is not showing, and says so on the count', async () => {
    loadFiles([await realPdf()]);
    render(<PdfToolPanel toolId="shell-two" />);

    const disclosure = await screen.findByRole('button', { name: /2 more options/ });
    expect(disclosure.textContent).toContain('1 needs attention');
    expect(disclosure).toHaveAttribute('data-options-attention', 'true');

    const button = screen.getByRole('button', { name: 'Apply' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-describedby', 'tool-run-reason');
    expect(document.getElementById('tool-run-reason')?.textContent).toContain('Owner name is required.');

    // Fixing the visible field moves the problem into view rather than hiding it.
    fireEvent.change(screen.getByLabelText('Owner name'), { target: { value: 'ACME' } });
    expect(screen.getByLabelText('Stamp text')).toBeInTheDocument();
    expect(button).toBeDisabled();
    expect(document.getElementById('tool-run-reason')?.textContent).toContain('Stamp text is required.');

    // Expanded, the hidden field carries its own complaint beside the input as
    // well: one for the field, one for the button, from the same source.
    fireEvent.click(screen.getByRole('button', { name: /2 more options/ }));
    expect(await screen.findAllByText('Stamp text is required.')).toHaveLength(2);
  });

  it('keeps the file cards as the loud thing in the loaded page', async () => {
    loadFiles([await realPdf('shell.pdf', 6)]);
    render(<PdfToolPanel toolId="shell-merge" />);
    await screen.findByText('shell.pdf');
    // jsdom lays nothing out, so the density contract is asserted as structure:
    // one card, one thin re-add strip, and a bar that holds one row of options.
    expect(document.querySelectorAll('[data-card]')).toHaveLength(1);
    expect(document.querySelector('[data-card-thumb]')).toHaveClass('h-[104px]');
    const more = document.querySelector('[data-drop-more]') as HTMLElement;
    expect(more).toHaveClass('min-h-[96px]');
    expect(document.querySelector('[data-options-panel]')).toHaveAttribute('data-options-panel', 'closed');
  });

  it('puts the verb under the queue, at the right edge of the bar', async () => {
    loadFiles([await realPdf()]);
    render(<PdfToolPanel toolId="shell-compress" />);
    const button = await screen.findByRole('button', { name: 'Compress' });
    expect(button).toHaveClass('min-h-[56px]');
    expect(button.closest('[data-run-bar]')).not.toBeNull();
    // The CTA is last in the bar, so it sits at the right edge.
    const actions = button.parentElement?.querySelectorAll('button') ?? [];
    expect(actions[actions.length - 1]).toBe(button);

    // And the bar is the last thing inside the scroll region, not a second child
    // of the page: pinned to the viewport it sat 401 px below one card at
    // 1440x1000, on a page with nothing to scroll. In flow it lands under the
    // files it acts on and the leftover space collects once, below it; `sticky`
    // is what keeps the verb in reach when a tall page does scroll.
    const bar = button.closest('[data-run-bar]') as HTMLElement;
    expect(bar).toHaveClass('sticky', 'bottom-0');
    expect(bar.parentElement).toHaveClass('overflow-y-auto');
    expect(bar.parentElement?.parentElement).toHaveAttribute('data-surface', 'ready');
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

  it('prints the whole output name on the success screen', async () => {
    const input = await realPdf('quarterly-report-2024-q3-final-draft-signed.pdf');
    loadFiles([input]);
    render(<PdfToolPanel toolId="shell-repair" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Repair' }));
    await release();
    await waitFor(() => expect(surface()).toHaveAttribute('data-surface', 'result'));

    const card = await screen.findByRole('region', { name: 'Result' });
    const line = card.querySelector('[data-output-name]') as HTMLElement;
    const full = 'quarterly-report-2024-q3-final-draft-signed_repaired.pdf';
    // The name the user is about to hand to someone else gets the same treatment
    // as the card: two lines of head, the tail kept, the whole string on hover.
    expect(line).toHaveAttribute('title', full);
    expect(line).toHaveAttribute('data-output-name', 'split');
    expect(line.textContent).toBe(full);
    expect(line.querySelector('span')).toHaveClass('line-clamp-2');
    expect(line.querySelector('[data-output-tail]')?.textContent).toMatch(/_repaired\.pdf$/);
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

// ── the one-line promise ─────────────────────────────────────────────────────

describe('the promise', () => {
  /** The sentence `shell-compress` prints: its own, not its description. */
  const SENTENCE = /size before and after/;

  function page(toolId: string): void {
    render(
      <MemoryRouter initialEntries={[`/tool/${toolId}`]}>
        <ToolPageHeader toolId={toolId} />
        <PdfToolPanel toolId={toolId} />
      </MemoryRouter>,
    );
  }

  it('is said once on an empty page, next to the button it describes', async () => {
    page('shell-compress');
    await screen.findByRole('button', { name: /^Select PDF file/ });
    expect(screen.getAllByText(SENTENCE)).toHaveLength(1);

    // The header keeps the breadcrumb, the tool name and the star — and stops
    // repeating the sentence in its own words.
    const header = document.querySelector('header') as HTMLElement;
    expect(within(header).getByText('Compress Shell')).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: 'Star Compress Shell' })).toBeInTheDocument();
    expect(within(header).queryByText(SENTENCE)).toBeNull();
    expect(within(header).queryByText('Shrink the file')).toBeNull();
  });

  it('is still said once once the file is loaded', async () => {
    loadFiles([await realPdf()]);
    page('shell-compress');
    await screen.findByText('shell.pdf');
    expect(screen.getAllByText(SENTENCE)).toHaveLength(1);
  });

  function bespokePage(toolId: string): void {
    render(
      <MemoryRouter initialEntries={[`/tool/${toolId}`]}>
        <Routes>
          <Route
            path="/tool/:toolId"
            element={
              <>
                <ToolPageHeader toolId={toolId} />
                <ToolWorkspace />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('leaves a bespoke editor holding its own sentence', async () => {
    // The header used to be one place a bespoke pane said anything; taking it out
    // there must not leave the editor mute, before a file or after one.
    bespokePage('organize');
    await screen.findByRole('button', { name: /^Select PDF/ });
    expect(screen.getAllByText(/never modified/)).toHaveLength(1);

    dropFiles([await realPdf('org.pdf')]);
    await waitFor(() => expect(document.querySelector('[data-organizer]')).not.toBeNull());
    expect(screen.getAllByText(/never modified/)).toHaveLength(1);
  });
});

// ── what the run produced ─────────────────────────────────────────────────────

describe('the produced page count', () => {
  /** The card's `Pages` row, exactly as the user reads it. */
  async function pagesRow(toolId: string, input: File, verb: string): Promise<string | null> {
    loadFiles([input]);
    render(<PdfToolPanel toolId={toolId} />);
    fireEvent.click(await screen.findByRole('button', { name: verb }));
    await waitFor(() => expect(surface()).toHaveAttribute('data-surface', 'result'));
    const card = await screen.findByRole('region', { name: 'Result' });
    const row = [...card.querySelectorAll('dt')].find((dt) => dt.textContent === 'Pages');
    return row?.nextElementSibling?.textContent ?? null;
  }

  it('counts the pages that came out, not just the ones that went in', async () => {
    // Twenty pages in, eight out. This line read "20 in · out not counted"
    // because nothing ever reported the produced file.
    expect(await pagesRow('shell-eight', await realPdf('shell.pdf', 20), 'Trim')).toBe('20 → 8');
  });

  it('shows the primary file of a multi-output run', async () => {
    loadFiles([await realPdf('shell.pdf', 6)]);
    render(<PdfToolPanel toolId="shell-split" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Split' }));
    await waitFor(() => expect(surface()).toHaveAttribute('data-surface', 'result'));
    const card = await screen.findByRole('region', { name: 'Result' });
    expect(card.textContent).toContain('3 files');
    // The count belongs to the first produced file; it is not summed or guessed.
    expect(card.textContent).toMatch(/6 → 4/);
  });

  it('claims no page count for a result that is not a PDF', async () => {
    // The archive arrives with `pages: 12` from a careless producer. A zip has no
    // pages, so the number is dropped rather than printed.
    const row = await pagesRow('shell-zip', await realPdf('shell.pdf', 5), 'Zip');
    expect(row).toBe('5 in · out not counted');
    expect(row).not.toMatch(/→ 12/);
  });

  it('carries the count out of the real merge tool', async () => {
    // The production path, not a fixture: merge saves through `helpers.pdfResult`,
    // which is where the number comes off the document while it is still in hand
    // — no second parse of the produced bytes.
    const { runPdfTool } = await import('@/lib/pdf/tools/runner');
    const outcome = await runPdfTool({
      toolId: 'merge',
      files: [await realPdf('a.pdf', 3), await realPdf('b.pdf', 5)],
    });
    expect(outcome.outputs).toHaveLength(1);
    expect(outcome.pagesOut).toBe(8);
  });

  it('leaves a producer that counted nothing honest', async () => {
    const { runPdfTool } = await import('@/lib/pdf/tools/runner');
    const outcome = await runPdfTool({ toolId: 'shell-uncounted', files: [await realPdf('a.pdf', 2)] });
    expect(outcome.outputs).toHaveLength(1);
    expect(outcome.pagesOut).toBeNull();
  });
});

// ── what the result screen shows before it asks for the download ────────────

describe('the produced file, shown', () => {
  /** The preview block of the success screen, when there is one. */
  function preview(): HTMLElement | null {
    const pane = document.querySelector('[data-result]');
    return pane ? pane.querySelector<HTMLElement>('[aria-label="Output preview"]') : null;
  }

  /**
   * Wait for the preview to reach one state, then hand back that node.
   *
   * Asking again each poll matters: the loading frame and the drawn page are
   * different nodes, so a handle taken while the raster is in flight goes stale
   * the moment it lands.
   */
  async function shownAs(state: string): Promise<HTMLElement> {
    await waitFor(() =>
      expect(document.querySelector(`[data-result] [data-preview="${state}"]`)).not.toBeNull(),
    );
    return preview() as HTMLElement;
  }

  /** Run a stand to its result screen and hand back that screen. */
  async function finish(
    toolId: string,
    verb: string,
    options: { input?: File; held?: boolean; owner?: string } = {},
  ): Promise<HTMLElement> {
    loadFiles([options.input ?? (await realPdf('shell.pdf'))]);
    render(<PdfToolPanel toolId={toolId} />);
    if (options.owner !== undefined) {
      fireEvent.change(await screen.findByLabelText('Owner name'), { target: { value: options.owner } });
    }
    fireEvent.click(await screen.findByRole('button', { name: verb }));
    if (options.held !== false) await release();
    await waitFor(() => expect(surface()).toHaveAttribute('data-surface', 'result'));
    return document.querySelector('[data-result]') as HTMLElement;
  }

  it('draws the file it made before offering the download', async () => {
    const pane = await finish('shell-compress', 'Compress', { owner: 'ACME' });
    const frame = await shownAs('pdf');
    const card = within(pane).getByRole('region', { name: 'Result' });

    // The document opened is the OUTPUT, not the input: the caption names the
    // file the run wrote, which is the only handle the screen has on it.
    expect(frame.textContent).toContain('shell_compressed.pdf');
    // And it says what it is, because a raster is not the document.
    expect(frame.textContent).toMatch(/drawn in this tab/);
    expect(frame.textContent).toMatch(/not the file itself/);
    // The page frame exists whether or not this browser can paint into it.
    expect(frame.querySelector('[data-preview-poster]')).not.toBeNull();

    // Preview first, download after: the file is seen before it is taken.
    const download = within(card).getByRole('button', { name: 'Download' });
    expect(frame.compareDocumentPosition(download) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The claims the screen already made are still made.
    expect(card.textContent).toMatch(/\d+% smaller/);
    expect(card.textContent).toContain('2 in · out not counted');
  });

  it('draws a bounded strip — the first pages and the last, never all forty', async () => {
    const restore = previewAnswers((resolve) => resolve(documentSession(40, 'forty-pages')));
    try {
      await finish('shell-repair', 'Repair');
      const frame = await shownAs('pdf');
      expect(frame).toHaveAttribute('data-preview-pages', '40');

      const chips = [...frame.querySelectorAll<HTMLButtonElement>('button[aria-label^="Page "]')];
      // Eleven from the front, plus the last page standing in for the middle: a
      // merge is checked at its end, and 40 rasters nobody scrolls to is not a
      // preview (E12).
      expect(chips).toHaveLength(12);
      expect(chips[0]).toHaveAttribute('aria-label', 'Page 1');
      expect(chips[11]).toHaveAttribute('aria-label', 'Page 40');
      expect(frame.textContent).toContain('Pages 1–11 and 40 are drawn here; the file holds all 40.');

      // Picking a page puts it in the big frame; the bound itself never moves.
      expect(chips[0]).toHaveAttribute('aria-pressed', 'true');
      fireEvent.click(chips[11]);
      await waitFor(() =>
        expect(frame.textContent).toMatch(/Page 40 of 40 of shell_repaired\.pdf/),
      );
      expect(chips[11]).toHaveAttribute('aria-pressed', 'true');
      expect(frame.querySelectorAll('button[aria-label^="Page "]')).toHaveLength(12);
    } finally {
      restore();
    }
  });

  it('lists what is inside an archive, and claims no page count for it', async () => {
    const pane = await finish('shell-archive', 'Bundle', {
      input: await realPdf('shell.pdf', 5),
      held: false,
    });
    const frame = await shownAs('archive');

    expect(frame.textContent).toContain('bundle.zip · 3 files inside');
    expect(frame.textContent).toContain('page-001.png');
    expect(frame.textContent).toContain('notes.txt');
    // An archive has entries, not pages, and the preview says which it shows.
    expect(frame.textContent).toMatch(/the download is the archive itself/);
    expect(frame.querySelector('[data-preview-poster]')).toBeNull();

    const card = within(pane).getByRole('region', { name: 'Result' });
    // The producer handed `pages: 3` for a zip; the card refuses the claim.
    expect(card.textContent).toContain('5 in · out not counted');
    expect(within(card).getByRole('button', { name: 'Download' })).toBeInTheDocument();
  });

  it('shows produced images as thumbnails, with every file still downloadable', async () => {
    const pane = await finish('shell-snapshot', 'Snapshot', { held: false });
    const frame = preview() as HTMLElement;
    expect(frame).toHaveAttribute('data-preview', 'images');
    expect(frame.getAttribute('data-preview-pages')).toBe('3');
    expect(frame.querySelectorAll('img')).toHaveLength(3);
    expect(frame.textContent).toMatch(/3 images/);
    expect(frame.textContent).toMatch(/shown as they are/);

    const card = within(pane).getByRole('region', { name: 'Result' });
    expect(within(card).getByRole('button', { name: 'Download all' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Download page-002.png' })).toBeInTheDocument();
  });

  it('says so when a format has nothing to draw, instead of showing a blank frame', async () => {
    const pane = await finish('shell-csv', 'Export', { held: false });
    const frame = preview() as HTMLElement;
    expect(frame).toHaveAttribute('data-preview', 'none');
    expect(frame.textContent).toMatch(/csv/i);
    expect(frame.textContent).toMatch(/data, not a page/);
    expect(frame.querySelector('img')).toBeNull();
    // The download is the point of this branch.
    const card = within(pane).getByRole('region', { name: 'Result' });
    expect(within(card).getByRole('button', { name: 'Download' })).toBeInTheDocument();
  });

  it('degrades to the download rather than an error screen when the file will not draw', async () => {
    const restore = previewAnswers((_resolve, reject) =>
      reject(new Error('Invalid PDF structure.')),
    );
    try {
      const pane = await finish('shell-repair', 'Repair');
      const frame = await shownAs('none');

      expect(frame.textContent).toMatch(/could not draw shell_repaired\.pdf/);
      expect(frame.textContent).toMatch(/the download is still the file/);
      expect(frame.querySelector('[data-preview-poster]')).toBeNull();
      // A missing picture is not a failed run: no alert, no Retry, no stack trace.
      expect(within(pane).queryByRole('alert')).toBeNull();
      expect(within(pane).queryByRole('button', { name: 'Retry' })).toBeNull();
      expect(frame.textContent).not.toMatch(/Invalid PDF structure/);

      const card = within(pane).getByRole('region', { name: 'Result' });
      expect(within(card).getByRole('button', { name: 'Download' })).toBeInTheDocument();
      expect(card.textContent).toContain('Rebuilt.');
    } finally {
      restore();
    }
  });

  it('throws away a preview that arrives after its run was superseded', async () => {
    const waiting: Array<(session: unknown) => void> = [];
    const restore = previewAnswers((resolve) => {
      waiting.push(resolve);
    });
    try {
      loadFiles([await realPdf('shell.pdf')]);
      render(<PdfToolPanel toolId="shell-repair" />);
      fireEvent.click(await screen.findByRole('button', { name: 'Repair' }));
      await release();
      await waitFor(() => expect(surface()).toHaveAttribute('data-surface', 'result'));
      // The first result screen asks pdf.js for its document; the answer is held.
      await waitFor(() => expect(waiting).toHaveLength(1));

      // A second result replaces it while that request is still in the air.
      act(() => {
        const store = useProcessStore.getState();
        store.reset();
        store.setOutput(new Blob([bytes(70)], { type: 'application/pdf' }), 'blob:second', 'again_repaired.pdf');
        store.complete('Rebuilt again.');
      });
      await waitFor(() => expect(waiting).toHaveLength(2));

      // The current run answers first: nine pages, and its own name.
      act(() => waiting[1](documentSession(9, 'current-run')));
      await waitFor(() => expect(preview()?.textContent).toContain('again_repaired.pdf'));

      // The superseded document arrives late, two pages long.
      act(() => waiting[0](documentSession(2, 'previous-run')));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(preview()).toHaveAttribute('data-preview-pages', '9');
      expect(preview()?.textContent).toContain('again_repaired.pdf');
      expect(preview()?.textContent).not.toContain('shell_repaired.pdf');
    } finally {
      restore();
    }
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
  it('names what the user changed, and only that', () => {
    const grey: ToolField = { key: 'on', label: 'Greyscale', type: 'toggle', default: false };
    const untouched = { dpi: 150, owner: '', on: false };
    // Nothing moved: no echo at all, because a list of defaults is not news.
    expect(describeOptions([dpiField, ownerField, grey], untouched)).toBe('');
    // What the row prints in its place is what the run will do.
    expect(
      describeOptions([dpiField, ownerField, grey], untouched, {
        whenQuiet: quietSummary(STANDS['shell-compress']),
      }),
    ).toBe('Nothing changed yet · Shrink the file');
    // A value the tool actually holds comes back as the words the control used,
    // with its unit, and a blank text field is still named.
    expect(describeOptions([dpiField, ownerField, grey], { dpi: 96, owner: 'ACME', on: true })).toBe(
      'Resolution: 96 dpi · Owner name: ACME · Greyscale: on',
    );
    // Three entries is the cap, and the rest are counted — the deciding control
    // used to be the part that fell past the truncation point.
    const ladder: ToolField[] = Array.from({ length: 6 }, (_, index) => ({
      key: `n${index}`,
      label: `Number ${index}`,
      type: 'number',
      default: 0,
    }));
    expect(describeOptions(ladder, Object.fromEntries(ladder.map((field, index) => [field.key, index + 1])))).toBe(
      'Number 0: 1 · Number 1: 2 · Number 2: 3 · +3 more',
    );
    // A password never echoes back.
    expect(
      describeOptions([{ key: 'password', label: 'Current password', type: 'password' }], { password: 'hunter2' }),
    ).toBe('');
  });

  it('keeps a choice made back to the default in the summary', () => {
    // "Differs from the default" and "a hand moved it" are different questions,
    // and the row answers the second: a preset deliberately re-chosen must not
    // drop out of the line and leave the panel looking untouched.
    expect(describeOptions([dpiField], { dpi: 150 })).toBe('');
    expect(describeOptions([dpiField], { dpi: 150 }, { touched: new Set(['dpi']) })).toBe('Resolution: 150 dpi');
    // The field the row already shows as a control is not echoed beside itself.
    expect(
      describeOptions([dpiField, ownerField], { dpi: 96, owner: 'ACME' }, { shown: ['dpi'] }),
    ).toBe('Owner name: ACME');
    // `leadField` reads the same set, so the visible control follows the choice.
    expect(leadField([dpiField, ownerField], {}, { dpi: 150, owner: 'ACME' }, new Set(['dpi']))).toBe(dpiField);
  });

  it('splits a long file name so its end survives', () => {
    // A card is 212 px wide, and the part that tells two files apart is the end
    // of the name: the version digits and the extension.
    expect(splitFileName('shell.pdf')).toEqual({ head: 'shell.pdf', tail: '' });
    const parts = splitFileName('quarterly-report-2024-q3-final-draft-signed.pdf');
    expect(`${parts.head}${parts.tail}`).toBe('quarterly-report-2024-q3-final-draft-signed.pdf');
    expect(parts.head.length).toBeLessThanOrEqual(40);
    // The cut lands after a separator, never inside a word.
    expect(parts.tail).toBe('draft-signed.pdf');
    // A stem with no separator to cut on keeps just its extension.
    const flat = splitFileName('unbrokenverylongdocumentnamewithoutanybreaksatall.pdf');
    expect(flat.tail).toBe('.pdf');
    expect(flat.head).toBe('unbrokenverylongdocumentnamewithoutanybreaksatall');
  });

  it('keeps the verb a giant button wears in the imperative', () => {
    expect(verbFor(STANDS['shell-compress'])).toBe('Compress');
    expect(verbFor(STANDS['shell-merge'])).toBe('Merge');
  });

  it('picks the option a collapsed bar must show', () => {
    const fields = [dpiField, ownerField, stampField];
    // A blocking field wins, in the order the button lists its reasons, so the
    // visible control and the reason line under the CTA agree.
    expect(leadField(fields, { stamp: 'Stamp text is required.' }, {})).toBe(stampField);
    // Then a required field still empty — the classic dead end — ahead of an
    // optional one the user has already moved.
    expect(leadField(fields, {}, { dpi: 96 })).toBe(ownerField);
    // With the required fields filled, the field the user changed, which a
    // folded panel would otherwise hide.
    expect(leadField(fields, {}, { owner: 'ACME', stamp: 'DRAFT', dpi: 96 })).toBe(dpiField);
    // And with nothing wrong and nothing changed, the first field.
    expect(leadField([dpiField], {}, { dpi: 150 })).toBe(dpiField);
    expect(leadField([], {}, {})).toBeNull();
  });
});
