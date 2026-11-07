/**
 * The in-place text editor's interaction contract (M2 UX pass).
 *
 * `docs/UX-BRIEF.md`'s checklist, applied to the one surface where you click a
 * paragraph, retype it, and the app deletes the original glyph runs and draws the
 * new ones back. Every test below is a behaviour a user hits within seconds of
 * opening a document:
 *
 *   hover says which block is editable and where the box will land · the active
 *   block has visible bounds and handles · double-click enters edit · `Esc` unwinds
 *   one level · typing over a selection edits it instead of firing a shortcut ·
 *   shortcuts lose to the contenteditable · one committed edit is one undo step,
 *   announced · find & replace reports counts and refuses missing targets ·
 *   degraded blocks are named (this surface's `result.warnings`) · a page with no
 *   text layer offers OCR and takes the file with it (E10) · a signed document
 *   says its export is an appended incremental revision.
 *
 * jsdom has no canvas, so nothing asserts pixels: the evidence is DOM invariants
 * (roles, focus, attributes), model geometry, and the history/state machines.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ExtractedTextItem } from '@/lib/pdf/core/render';
import { TextEditor } from '@/components/tools/pdf/text-editor/TextEditor';
import { useFileStore } from '@/stores/file-store';
import {
  DEFAULT_STYLE,
  MIN_BLOCK_SIZE,
  RESIZE_HANDLES,
  canRedo,
  canUndo,
  clusterParagraphs,
  createHistory,
  historyReport,
  liveRanges,
  objectsForPage,
  paragraphsFromText,
  pruneSelection,
  pushHistory,
  retextBlock,
  resizeBox,
  searchableBlocks,
  textOfParagraphs,
  undoHistory,
  type EditObject,
  type ExtractedParagraph,
  type HistoryState,
  type ImageObject,
  type SearchableBlock,
  type TextObject,
} from '@/components/tools/pdf/text-editor/model';
import {
  ESCAPE_STEP_REPORT,
  TEXT_EDITOR_SHORTCUTS,
  nextEscapeStep,
  typingStartsEdit,
} from '@/components/tools/pdf/text-editor/keys';
import { exportReport, type ApplyOutcome } from '@/components/tools/pdf/text-editor/draw';
import { repairWithPyMuPDF, repairEngineNote } from '@/components/tools/pdf/text-editor/engine';
import { MODE_AFTER_CREATE, stepsAside } from '@/components/tools/pdf/text-editor/keys';
import { planHandoff } from '@/components/tools/pdf/text-editor/handoff';
import { focusEditor, mountParagraphs, readParagraphs } from '@/components/tools/pdf/text-editor/editorDom';

/* ------------------------------------------------------------------ *
 * The fake document: a scanned page, or one with three paragraphs     *
 * ------------------------------------------------------------------ */

const harness = vi.hoisted(() => ({
  /** 1-based page → text runs. Empty object means "no text layer". */
  items: {} as Record<number, unknown[]>,
  /** When true the page's operator list yields one raster placement. */
  scanned: false,
  /** `readSignatures` output, which decides the signed copy. */
  signatures: [] as unknown[],
}));

vi.mock('@/lib/pdf/core/render', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/pdf/core/render')>();
  const pdfjs = (await import('pdfjs-dist')) as unknown as { OPS: Record<string, number> };
  const ops = pdfjs.OPS;
  function fakeSession() {
    const page = {
      getViewport: () => ({ width: 595, height: 842, scale: 1 }),
      getOperatorList: async () =>
        harness.scanned
          ? { fnArray: [ops.transform, ops.paintImageXObject], argsArray: [[200, 0, 0, 120, 150, 400], []] }
          : { fnArray: [], argsArray: [] },
      cleanup: () => {},
    };
    return {
      doc: {},
      numPages: 1,
      fingerprint: 'ux-text',
      page: async () => page,
      renderToCanvas: async () => ({ width: 595, height: 842 }),
      renderPage: async () => ({}),
      textContent: async () => ({ items: [] }),
      textItems: async (n: number) => harness.items[n] ?? [],
      metadata: async () => ({}),
      attachments: async () => ({}),
      destroy: async () => {},
    };
  }
  return { ...real, openRender: async () => fakeSession() };
});

vi.mock('@/lib/pdf/core/signature', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/pdf/core/signature')>();
  return { ...real, readSignatures: async () => harness.signatures };
});

// The CDN is unreachable in the suite, which is exactly the state the export path
// has to survive: the built-in file must still come out, named as degraded.
vi.mock('@/lib/pdf/core/engine-ops', () => ({
  engineReady: () => true,
  enginePurpose: () => 'PyMuPDF — high-fidelity text extraction.',
  openWithPyMuPDF: async () => {
    throw new Error('the CDN is unreachable');
  },
  EngineUnavailable: class EngineUnavailable extends Error {},
}));

/* ------------------------------------------------------------------ *
 * Fixtures                                                           *
 * ------------------------------------------------------------------ */

const BOX = { x: 72, y: 100, width: 300, height: 40 };

let sequence = 0;
function nextId(prefix = 'o'): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

function item(overrides: Partial<ExtractedTextItem> & { str: string }): ExtractedTextItem {
  const size = overrides.h ?? 10;
  return {
    transform: [1, 0, 0, 1, overrides.x ?? 0, 0],
    width: overrides.w ?? overrides.str.length * size * 0.5,
    height: size,
    fontName: 'F1',
    dir: 'ltr',
    page: 1,
    x: 0,
    y: 0,
    w: overrides.str.length * size * 0.5,
    h: size,
    hasEOL: false,
    isInvisible: false,
    ...overrides,
  };
}

/** One body paragraph, one heading, and one invisible OCR layer. */
function pageItems(): ExtractedTextItem[] {
  return [
    item({ str: 'The quick brown fox jumps over', x: 72, y: 100, w: 200, h: 10 }),
    item({ str: 'Invoice total', x: 72, y: 200, w: 90, h: 16 }),
    item({ str: 'scanned words', x: 72, y: 300, w: 120, h: 10, isInvisible: true }),
  ];
}

function textObject(overrides: Partial<TextObject> = {}): TextObject {
  return {
    id: nextId('text'),
    page: 1,
    kind: 'text',
    box: { ...BOX },
    rotation: 0,
    flipH: false,
    flipV: false,
    z: 0,
    alt: '',
    state: 'draft',
    paragraphs: paragraphsFromText('hello'),
    style: { ...DEFAULT_STYLE },
    deletion: [],
    paperColor: '#ffffff',
    sourceId: '',
    fromInvisibleLayer: false,
    ...overrides,
  };
}

function imageObject(overrides: Partial<ImageObject> = {}): ImageObject {
  return {
    id: nextId('image'),
    page: 1,
    kind: 'image',
    box: { ...BOX },
    rotation: 0,
    flipH: false,
    flipV: false,
    z: 1,
    alt: '',
    state: 'draft',
    bytes: new Uint8Array([1, 2, 3]),
    mime: 'image/png',
    intrinsic: { width: 10, height: 10 },
    ...overrides,
  };
}

function outcome(overrides: Partial<ApplyOutcome> = {}): ApplyOutcome {
  return { written: 0, failed: [], partial: [], raster: [], ...overrides };
}

function block(overrides: Partial<SearchableBlock> = {}): SearchableBlock {
  return {
    id: 'b1',
    page: 1,
    text: 'The quick brown fox',
    lines: [{ box: { ...BOX }, start: 0, end: 19 }],
    ...overrides,
  };
}

function paragraph(): ExtractedParagraph {
  return {
    id: 'p1',
    page: 1,
    text: 'The quick brown fox',
    lines: [{ text: 'The quick brown fox', box: { ...BOX }, size: 10, start: 0, end: 19, items: [] }],
    box: { ...BOX },
    size: 10,
    invisible: false,
    direction: 'ltr',
  };
}

/* ------------------------------------------------------------------ *
 * Hover: which blocks the editor will offer                          *
 * ------------------------------------------------------------------ */

describe('the blocks the hover affordance is drawn on', () => {
  it('separates body text, a heading and the invisible OCR layer', () => {
    const paragraphs = clusterParagraphs(pageItems());
    expect(paragraphs).toHaveLength(3);
    expect(paragraphs.filter((entry) => entry.invisible)).toHaveLength(1);
    expect(paragraphs[2].text).toBe('scanned words');
  });
});

/* ------------------------------------------------------------------ *
 * The active block: bounds, handles, direction-correct cursors        *
 * ------------------------------------------------------------------ */

describe('selection handles', () => {
  it('are eight, in visual order, each with its resize cursor', () => {
    expect(RESIZE_HANDLES.map((handle) => handle.id)).toEqual(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']);
    const cursors = new Map(RESIZE_HANDLES.map((handle) => [handle.id, handle.cursor]));
    expect(cursors.get('nw')).toBe('nwse-resize');
    expect(cursors.get('se')).toBe('nwse-resize');
    expect(cursors.get('ne')).toBe('nesw-resize');
    expect(cursors.get('sw')).toBe('nesw-resize');
    expect(cursors.get('n')).toBe('ns-resize');
    expect(cursors.get('s')).toBe('ns-resize');
    expect(cursors.get('e')).toBe('ew-resize');
    expect(cursors.get('w')).toBe('ew-resize');
    for (const handle of RESIZE_HANDLES) {
      expect(handle.label).toMatch(/[a-z]/);
      // Anchors are fractions of the box, so handles track zoom and resize.
      expect(handle.left).toBeGreaterThanOrEqual(0);
      expect(handle.left).toBeLessThanOrEqual(1);
      expect(handle.top).toBeGreaterThanOrEqual(0);
      expect(handle.top).toBeLessThanOrEqual(1);
    }
  });

  it('move the dragged edge and hold the opposite one still', () => {
    expect(resizeBox(BOX, 'e', 20, 0)).toEqual({ ...BOX, width: 320 });
    expect(resizeBox(BOX, 'w', 20, 0)).toEqual({ ...BOX, x: 92, width: 280 });
    expect(resizeBox(BOX, 's', 0, -10)).toEqual({ ...BOX, height: 30 });
    expect(resizeBox(BOX, 'n', 0, 10)).toEqual({ ...BOX, y: 110, height: 30 });
    expect(resizeBox(BOX, 'se', 5, 5)).toEqual({ ...BOX, width: 305, height: 45 });
  });

  it('stop at the minimum size instead of inverting the box', () => {
    const squeezed = resizeBox(BOX, 'e', -600, 0);
    expect(squeezed.width).toBe(MIN_BLOCK_SIZE);
    expect(squeezed.x).toBe(BOX.x);
    const fromLeft = resizeBox(BOX, 'nw', 900, 900);
    expect(fromLeft).toEqual({ x: BOX.x + BOX.width - MIN_BLOCK_SIZE, y: BOX.y + BOX.height - MIN_BLOCK_SIZE, width: MIN_BLOCK_SIZE, height: MIN_BLOCK_SIZE });
  });
});

/* ------------------------------------------------------------------ *
 * Undo: one step per committed edit, and it says so                   *
 * ------------------------------------------------------------------ */

describe('undo and redo', () => {
  const empty: HistoryState<EditObject[]> = createHistory<EditObject[]>([]);

  it('reports the depth left in both directions', () => {
    expect(historyReport(empty, 'undo')).toMatch(/nothing to undo/i);
    expect(historyReport(empty, 'redo')).toMatch(/nothing to redo/i);
    const one = pushHistory(empty, [textObject()]);
    expect(historyReport(one, 'undo')).toMatch(/undid the last change/i);
    expect(historyReport(one, 'undo')).toMatch(/nothing left to undo/i);
    expect(canUndo(one)).toBe(true);
    expect(canRedo(one)).toBe(false);
    const two = pushHistory(one, [textObject(), textObject()]);
    expect(historyReport(two, 'undo')).toMatch(/1 undo left/);
    expect(historyReport(two, 'undo')).toMatch(/1 redo available/);
    expect(historyReport(two, 'redo')).toMatch(/nothing to redo/i);
    const stepped = undoHistory(two);
    expect(historyReport(stepped, 'redo')).toMatch(/redid the change/i);
    expect(historyReport(stepped, 'redo')).toMatch(/nothing left to redo/i);
  });

  it('keeps a burst as one step: the tip is amended, not stacked', () => {
    // The shape `TextEditor.applyAll(coalesce)` produces: the first event pushes
    // the before-state, the rest rewrite the tip, so one Undo undoes the drag.
    let state = pushHistory(empty, [textObject({ box: { ...BOX, x: 73 } })]);
    for (let index = 1; index < 6; index += 1) {
      state = { ...state, present: [textObject({ box: { ...BOX, x: 73 + index } })] };
    }
    expect(state.past).toHaveLength(1);
    const back = undoHistory(state);
    expect(back.present).toHaveLength(0);
    expect(back.past).toEqual([]);
  });

  it('drops a selection whose object has gone', () => {
    const a = textObject();
    expect(pruneSelection(objectsForPage([a], 1), [a.id, 'ghost'])).toEqual([a.id]);
    expect(pruneSelection([], [a.id])).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Esc unwinding, and typing over a selection                          *
 * ------------------------------------------------------------------ */

describe('the keyboard contract', () => {
  it('unwinds exactly one level at a time, in the ruled order', () => {
    const full = { editing: true, findOpen: true, selected: 2, pinned: true, mode: 'add-image' as const };
    expect(nextEscapeStep(full)).toBe('commit-edit');
    expect(nextEscapeStep({ ...full, editing: false })).toBe('close-find');
    expect(nextEscapeStep({ ...full, editing: false, findOpen: false })).toBe('clear-selection');
    expect(nextEscapeStep({ ...full, editing: false, findOpen: false, selected: 0 })).toBe('unpin');
    expect(nextEscapeStep({ ...full, editing: false, findOpen: false, selected: 0, pinned: false })).toBe('disarm');
    expect(nextEscapeStep({ ...full, editing: false, findOpen: false, selected: 0, pinned: false, mode: 'edit' as const })).toBe(
      'idle',
    );
    // Every step explains itself to assistive tech.
    for (const step of Object.keys(ESCAPE_STEP_REPORT) as (keyof typeof ESCAPE_STEP_REPORT)[]) {
      expect(ESCAPE_STEP_REPORT[step].length).toBeGreaterThan(8);
    }
  });

  it('hands the caret to a selected block when the user just starts typing', () => {
    // `t` is also the "add text box" key: with a block selected it must type.
    expect(typingStartsEdit('t', {}, { textSelected: true })).toBe(true);
    expect(typingStartsEdit('A', {}, { textSelected: true })).toBe(true);
    expect(typingStartsEdit('t', { ctrl: true }, { textSelected: true })).toBe(false);
    expect(typingStartsEdit('t', { meta: true }, { textSelected: true })).toBe(false);
    expect(typingStartsEdit('t', { alt: true }, { textSelected: true })).toBe(false);
    expect(typingStartsEdit('t', {}, { textSelected: false })).toBe(false);
    expect(typingStartsEdit('t', {}, { textSelected: true, editing: true })).toBe(false);
    expect(typingStartsEdit('Enter', {}, { textSelected: true })).toBe(false);
  });

  it('documents the keys it binds, including the ones this pass added', () => {
    const printed = TEXT_EDITOR_SHORTCUTS.map((row) => row.keys.join('+'));
    for (const wanted of ['V', 'T', 'I', 'Esc', 'Delete', 'Ctrl+Z', 'Ctrl+Y', 'Enter', 'Ctrl+D', 'Double-click']) {
      expect(printed, `the shortcut list must document ${wanted}`).toContain(wanted);
    }
    const escape = TEXT_EDITOR_SHORTCUTS.find((row) => row.keys.join('+') === 'Esc');
    expect(escape?.label).toMatch(/edit/i);
    expect(escape?.label).toMatch(/unpin/i);
    const undo = TEXT_EDITOR_SHORTCUTS.find((row) => row.keys.join('+') === 'Ctrl+Z');
    expect(undo?.label).toMatch(/committed/i);
  });
});

/* ------------------------------------------------------------------ *
 * Find & replace: counts, and refusing what is not there              *
 * ------------------------------------------------------------------ */

describe('find and replace honesty', () => {
  it('refuses ranges that no longer point at the needle', () => {
    const text = 'The quick brown fox';
    expect(liveRanges(text, 'quick', {}, [{ start: 4, end: 9 }])).toEqual([{ start: 4, end: 9 }]);
    // Same offsets, different words: the block was retyped after the search.
    expect(liveRanges('The slow brown fox', 'quick', {}, [{ start: 4, end: 9 }])).toEqual([]);
    // Case-insensitive matching still has to land on the same source offsets.
    expect(liveRanges(text, 'QUICK', {}, [{ start: 4, end: 9 }])).toEqual([{ start: 4, end: 9 }]);
    expect(liveRanges(text, 'fox', {}, [{ start: 0, end: 3 }])).toEqual([]);
  });

  it('re-points a block at its edited text without leaving offsets out of range', () => {
    const retyped = retextBlock(block(), 'Totally different, longer words here');
    expect(retyped.text).toBe('Totally different, longer words here');
    expect(retyped.lines).toHaveLength(1);
    expect(retyped.lines[0].end).toBe(retyped.text.length);
    expect(retyped.lines[0].box).toEqual(BOX);
    // A block whose text did not move is the same object, untouched.
    const same = block();
    expect(retextBlock(same, same.text)).toBe(same);
    expect(retextBlock(block(), '').lines).toEqual([]);
    expect(searchableBlocks([paragraph()]).map((entry) => entry.id)).toEqual(['p1']);
  });
});

/* ------------------------------------------------------------------ *
 * Export: what actually happened, in numbers, kept on screen          *
 * ------------------------------------------------------------------ */

describe('export report', () => {
  it('counts the blocks it wrote and names the ones it skipped', () => {
    const kept = textObject();
    const dropped = imageObject();
    const report = exportReport(
      outcome({ written: 1, failed: [{ id: dropped.id, reason: 'The words live in a form XObject.' }] }),
      [kept, dropped],
      {},
    );
    expect(report.headline).toMatch(/wrote 1 text block on 1 page/i);
    expect(report.headline).toMatch(/skipped 1/i);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toMatch(/^Page 1: skipped/);
    expect(report.warnings[0]).toMatch(/form XObject/);
  });

  it('never calls a rewrite of nothing a save', () => {
    expect(exportReport(outcome({ written: 0 }), [], {}).headline).toMatch(/nothing was written/i);
  });

  it('says the signed file is an appended revision, in the result too', () => {
    const kept = textObject();
    const report = exportReport(
      outcome({ written: 1, partial: [{ id: kept.id, leftover: 3 }], raster: [kept.id] }),
      [kept],
      { signed: true },
    );
    const text = report.warnings.join(' ');
    expect(text).toMatch(/appended incremental revision/i);
    expect(text).toMatch(/signature still verifies/i);
    expect(text).toMatch(/3 text operators survived the deletion/i);
    expect(text).toMatch(/1 block sits on image content/i);
  });

  it('reports engine-repaired blocks as degraded, not as a clean save', () => {
    const kept = textObject();
    const report = exportReport(outcome({ written: 1, failed: [{ id: kept.id, reason: 'form XObject' }] }), [kept], {
      repaired: [kept.id],
    });
    expect(report.headline).toMatch(/wrote 1 text block/i);
    expect(report.warnings.join(' ')).toMatch(/cleaned by the optional PyMuPDF engine/i);
    expect(report.warnings.join(' ')).toMatch(/Helvetica/i);
    // A clean export promises nothing else.
    expect(exportReport(outcome({ written: 1 }), [kept], {}).warnings).toEqual([]);
  });

  it('says when the optional engine itself could not run, without losing the file', async () => {
    // The rail's standing note quotes the download instead of promising a CDN.
    expect(repairEngineNote()).toMatch(/not loaded yet/i);
    expect(repairEngineNote()).toMatch(/54 MB/);
    expect(repairEngineNote()).toMatch(/reported rather than doubled/i);

    const bytes = new Uint8Array([1, 2, 3]);
    const blocked = textObject({ deletion: [{ ...BOX }] });
    const repair = await repairWithPyMuPDF(bytes, [{ object: blocked }], [
      { page: 1, x: 72, y: 110, size: 10, text: 'rewritten', color: '#000000' },
    ]);
    expect(repair?.error).toMatch(/unreachable/i);
    expect(repair?.bytes).toBe(bytes);
    expect(repair?.repaired).toEqual([]);
    const report = exportReport(
      outcome({ written: 0, failed: [{ id: blocked.id, reason: 'form XObject' }] }),
      [blocked],
      { engineError: repair?.error },
    );
    expect(report.warnings[0]).toMatch(/could not run/i);
    expect(report.warnings[0]).toMatch(/unreachable/i);
    expect(report.warnings[0]).toMatch(/rest of the edits are in this file/i);
  });
});

/* ------------------------------------------------------------------ *
 * One-shot by default, sticky only when pinned (the brief's ruling)  * 
 * ------------------------------------------------------------------ */

describe('placement modes', () => {
  it('declare stickiness instead of inheriting it from handler order', () => {
    expect(MODE_AFTER_CREATE).toEqual({ edit: 'stay', 'add-text': 'default', 'add-image': 'default' });
    expect(stepsAside('add-text', false)).toBe(true);
    expect(stepsAside('add-image', false)).toBe(true);
    expect(stepsAside('add-text', true)).toBe(false);
    // Edit is the resting tool, so there is nothing to step back from.
    expect(stepsAside('edit', true)).toBe(false);
    expect(stepsAside('edit', false)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * E10: a page with no text layer offers OCR, and the file follows     *
 * ------------------------------------------------------------------ */

describe('handing the document to OCR', () => {
  beforeEach(() => {
    useFileStore.setState({ activeTool: 'edit-pdf-text', sessions: {}, file: null, files: [] });
  });

  it('seeds the target tool so the route does not lose the document', () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'scan.pdf', { type: 'application/pdf' });
    const plan = planHandoff('ocr-pdf', 'the OCR tool', file);
    expect(plan.carried).toBe(true);
    expect(plan.line).toMatch(/scan\.pdf/);
    expect(plan.line).toMatch(/exports a new PDF/i);
    const slot = useFileStore.getState().sessions['ocr-pdf' as never] as { file: File | null } | undefined;
    expect(slot?.file).toBe(file);
  });

  it('admits it has nothing to carry instead of claiming otherwise', () => {
    const plan = planHandoff('ocr-pdf', 'the OCR tool', null);
    expect(plan.carried).toBe(false);
    expect(plan.line).toMatch(/pick the file again/i);
  });
});

/* ------------------------------------------------------------------ *
 * The editing surface: focus, and the keystroke that started the edit  *
 * ------------------------------------------------------------------ */

describe('the contenteditable surface', () => {
  it('takes the caret and keeps the character that opened it', () => {
    const host = document.createElement('div');
    document.body.append(host);
    host.contentEditable = 'true';
    host.tabIndex = 0;
    mountParagraphs(host, paragraphsFromText('Invoice total'), DEFAULT_STYLE);
    focusEditor(host, '9');
    expect(document.activeElement).toBe(host);
    expect(textOfParagraphs(readParagraphs(host))).toBe('Invoice total9');
    host.remove();
  });
});

/* ------------------------------------------------------------------ *
 * The mounted editor                                                  *
 * ------------------------------------------------------------------ */

function blockNodes(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-editable-block]'));
}

function centreOf(node: HTMLElement): { clientX: number; clientY: number } {
  const number = (value: string) => Number.parseFloat(value || '0');
  return {
    // jsdom reports no layout, so the overlay's rect is all zeroes and a pointer
    // event's client coordinates *are* viewer coordinates at zoom 1.
    clientX: number(node.style.left) + number(node.style.width) / 2,
    clientY: number(node.style.top) + number(node.style.height) / 2,
  };
}

function overlay(): HTMLElement {
  const node = document.querySelector<HTMLElement>('[data-page-overlay]');
  if (!node) throw new Error('The page overlay did not render.');
  return node;
}

function editorBox(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="textbox"]');
}

function liveRegion(): HTMLElement {
  const node = document.querySelector<HTMLElement>('[data-text-live]');
  if (!node) throw new Error('No polite live region for undo/redo, Esc and duplicates.');
  return node;
}

function findStatus(): string {
  return document.querySelector('[data-find-status]')?.textContent ?? '';
}

function editsList(): HTMLElement {
  const node = document.querySelector<HTMLElement>('[data-edit-list]');
  if (!node) throw new Error('The Edits list did not render.');
  return node;
}

function rowsIn(list: HTMLElement): Element[] {
  return Array.from(list.querySelectorAll('li'));
}

/** The geometry inputs in the object panel: X, Y, Width, Height. */
function boxFields(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('[data-object-box] input'));
}

function firstEditableBlock(): HTMLElement {
  const node = blockNodes().find((entry) => entry.dataset.editableBlock === 'yes');
  if (!node) throw new Error('No editable block rendered.');
  return node;
}

async function openDocument(advice = false): Promise<void> {
  render(createElement(TextEditor));
  await waitFor(() =>
    expect(advice ? document.querySelector('[data-page-advice]') : blockNodes()[0]).toBeTruthy(),
  );
}

async function clickBlock(): Promise<void> {
  const target = firstEditableBlock();
  fireEvent.mouseDown(overlay(), centreOf(target));
  fireEvent.mouseUp(overlay());
  await waitFor(() => expect(editorBox()).not.toBeNull());
}

beforeEach(() => {
  window.location.hash = '#/tool/edit-pdf-text';
  harness.items = { 1: pageItems() };
  harness.scanned = false;
  harness.signatures = [];
  const file = new File([new Uint8Array([37, 80, 68, 70])], 'invoice.pdf', { type: 'application/pdf' });
  useFileStore.setState({ activeTool: 'edit-pdf-text', sessions: {}, file, files: [file] });
});

afterEach(() => {
  cleanup();
  useFileStore.setState({ activeTool: null, sessions: {}, file: null, files: [] });
});

describe('the text editor surface', () => {
  it('offers every paragraph as a reachable, named target', async () => {
    await openDocument();
    const blocks = blockNodes();
    expect(blocks).toHaveLength(3);
    const editable = blocks.filter((node) => node.dataset.editableBlock === 'yes');
    expect(editable).toHaveLength(2);
    for (const node of editable) {
      expect(node.getAttribute('role')).toBe('button');
      expect(node.getAttribute('aria-label')).toMatch(/rewrite this paragraph on page 1/i);
      expect(node.tabIndex).toBe(0);
      expect(node.className).toMatch(/cursor-pointer/);
      // Hover or focus says what you get: face size, line count, and the action.
      expect(node.textContent).toMatch(/click to rewrite/i);
      expect(node.textContent).toMatch(/pt ·/);
    }
    const ocr = blocks.find((node) => node.dataset.editableBlock === 'no');
    expect(ocr?.getAttribute('aria-disabled')).toBe('true');
    expect(ocr?.getAttribute('aria-label')).toMatch(/invisible ocr text/i);
    expect(ocr?.className).toMatch(/cursor-not-allowed/);
  });

  it('puts the caret in the block a click opens', async () => {
    await openDocument();
    await clickBlock();
    const box = editorBox() as HTMLElement;
    expect(document.activeElement).toBe(box);
    expect(box.getAttribute('aria-multiline')).toBe('true');
    expect(box.textContent).toMatch(/quick brown fox/i);
  });

  it('draws bounds and eight handles on the active block, and re-enters edit on double-click', async () => {
    await openDocument();
    const target = firstEditableBlock();
    await clickBlock();
    // Leave edit mode: the block stays selected, so the selection chrome shows.
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(editorBox()).toBeNull();
    const frame = document.querySelector('[data-selection-frame]');
    expect(frame).not.toBeNull();
    const handles = Array.from(document.querySelectorAll<HTMLElement>('[data-resize-handle]'));
    expect(handles).toHaveLength(8);
    for (const handle of handles) {
      // Hit area first, then the dot inside it: the checklist wants a handle of
      // at least 8 px *with* slop, and a direction-correct cursor.
      expect(Number.parseFloat(handle.style.width || '0')).toBeGreaterThanOrEqual(16);
      expect(Number.parseFloat(handle.style.height || '0')).toBeGreaterThanOrEqual(16);
      const dot = handle.querySelector<HTMLElement>('[data-resize-dot]');
      expect(dot).not.toBeNull();
      expect(Number.parseFloat(dot!.style.width || '0')).toBeGreaterThanOrEqual(8);
      expect(handle.tabIndex).toBe(0);
      expect(handle.getAttribute('aria-label')).toMatch(/resize/i);
      expect(handle.style.cursor).toMatch(/resize$/);
    }
    expect(document.querySelector('[data-edit-block]')).not.toBeNull();
    // Double-click goes one level deeper: back into the words.
    fireEvent.doubleClick(overlay(), centreOf(target));
    await waitFor(() => expect(editorBox()).not.toBeNull());
    expect(document.activeElement).toBe(editorBox());
  });

  it('resizes by handle with a live size readout, as one undo step', async () => {
    await openDocument();
    await clickBlock();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    const widthBefore = boxFields()[2].valueAsNumber;
    const east = document.querySelector<HTMLElement>('[data-resize-handle="e"]') as HTMLElement;
    fireEvent.mouseDown(east, { clientX: BOX.x + 300, clientY: BOX.y });
    fireEvent.mouseMove(overlay(), { clientX: BOX.x + 348, clientY: BOX.y });
    expect(document.querySelector('[data-size-badge]')?.textContent).toMatch(/×/);
    fireEvent.mouseUp(overlay());
    const grown = boxFields()[2].valueAsNumber;
    expect(grown).toBeGreaterThan(widthBefore);
    // One Undo returns the whole drag, not the last mousemove.
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(boxFields()[2].valueAsNumber).toBeCloseTo(widthBefore, 0);
  });

  it('edits when you type over a selection instead of arming a tool', async () => {
    await openDocument();
    await clickBlock();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(editorBox()).toBeNull();
    fireEvent.keyDown(document.body, { key: 't' });
    await waitFor(() => expect(editorBox()).not.toBeNull());
    // The letter reached the text, and the tool is still Edit (crosshair = armed).
    expect((editorBox() as HTMLElement).textContent).toMatch(/t$/);
    expect(overlay().style.cursor).toBe('default');
  });

  it('loses every shortcut to the contenteditable except Esc', async () => {
    await openDocument();
    await clickBlock();
    const box = editorBox() as HTMLElement;
    fireEvent.keyDown(box, { key: 'v' });
    expect(editorBox()).not.toBeNull();
    fireEvent.keyDown(box, { key: 'Delete' });
    expect(editorBox()).not.toBeNull();
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(editorBox()).toBeNull();
    // Second Esc: the selection goes. Third: nothing left, and it says so.
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(document.querySelector('[data-selection-frame]')).toBeNull();
    expect(liveRegion().textContent).toMatch(/deselected/i);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(liveRegion().textContent).toMatch(/nothing to step back from/i);
  });

  it('commits one edit as one undo step, and announces it', async () => {
    await openDocument();
    await clickBlock();
    const box = editorBox() as HTMLElement;
    box.textContent = 'Rewritten by hand';
    fireEvent.blur(box);
    expect(within(editsList()).getByText(/rewritten by hand/i)).toBeTruthy();
    expect(liveRegion().textContent).toMatch(/one undo step/i);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    // One press is enough: the whole commit, text and box together, steps back.
    expect(within(editsList()).getByText(/quick brown fox/i)).toBeTruthy();
    expect(liveRegion().textContent).toMatch(/undid the last change/i);
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect(within(editsList()).getByText(/rewritten by hand/i)).toBeTruthy();
    expect(liveRegion().textContent).toMatch(/redid the change/i);
  });

  it('duplicates with Ctrl+D and deletes with Delete, both announced', async () => {
    await openDocument();
    await clickBlock();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.keyDown(document.body, { key: 'd', ctrlKey: true });
    expect(rowsIn(editsList())).toHaveLength(2);
    expect(liveRegion().textContent).toMatch(/duplicated 1 object/i);
    fireEvent.keyDown(document.body, { key: 'Delete' });
    expect(liveRegion().textContent).toMatch(/removed 1 object/i);
    expect(rowsIn(editsList())).toHaveLength(1);
  });

  it('refuses to export when nothing has been edited, and says why', async () => {
    await openDocument();
    const exportButton = screen.getByRole('button', { name: 'Export' }) as HTMLButtonElement;
    expect(exportButton.disabled).toBe(true);
    expect(exportButton.title).toMatch(/click a paragraph/i);
    expect(document.querySelector('[data-export-state="waiting"]')).not.toBeNull();
    expect(document.querySelector('[data-format-panel="empty"]')).not.toBeNull();
    // Nothing has been degraded yet, so nothing is claimed; the standing engine
    // note is where the honest limits live.
    expect(document.querySelector('[data-export-warnings]')).toBeNull();
    expect(document.querySelector('[data-engine-note]')?.textContent).toMatch(/reported rather than doubled/i);
  });

  it('finds, counts, and refuses a target that is not there', async () => {
    await openDocument();
    fireEvent.keyDown(document.body, { key: 'f', ctrlKey: true });
    const query = (await screen.findByLabelText('Text to find')) as HTMLInputElement;
    fireEvent.change(query, { target: { value: 'nope' } });
    await waitFor(() => expect(findStatus()).toMatch(/no match for “nope” in 3 text blocks/i));
    const replaceAll = screen.getByRole('button', { name: 'Replace all' }) as HTMLButtonElement;
    expect(replaceAll.disabled).toBe(true);
    expect(replaceAll.title).toMatch(/matched 0 blocks/i);

    fireEvent.change(query, { target: { value: 'quick' } });
    await waitFor(() => expect(findStatus()).toMatch(/1 match on 1 page/i));
    // An empty replacement would silently delete the word: ask for the text.
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    await waitFor(() => expect(liveRegion().textContent).toMatch(/type the new text first/i));
    const replacement = screen.getByLabelText('Replacement text') as HTMLInputElement;
    fireEvent.change(replacement, { target: { value: 'swift' } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    await waitFor(() => expect(findStatus()).toMatch(/1 replacement queued on page 1/i));
    expect(within(editsList()).getByText(/swift brown fox/i)).toBeTruthy();
    // The match list is empty now, and the control says so before the click.
    const replace = screen.getByRole('button', { name: 'Replace' }) as HTMLButtonElement;
    expect(replace.disabled).toBe(true);
    expect(replace.title).toMatch(/matched 0 blocks/i);
  });

  it('keeps a page with no text layer from looking broken (E10)', async () => {
    harness.items = {};
    harness.scanned = true;
    await openDocument(true);
    const advice = document.querySelector('[data-page-advice="no-text"]');
    expect(advice).not.toBeNull();
    expect(advice?.textContent).toMatch(/has no text layer/i);
    expect(advice?.textContent).toMatch(/run ocr/i);
    fireEvent.click(within(advice as HTMLElement).getByRole('button', { name: /run ocr/i }));
    expect(window.location.hash).toBe('#/tool/ocr-pdf');
    const slot = useFileStore.getState().sessions['ocr-pdf' as never] as { file: File | null } | undefined;
    expect(slot?.file?.name).toBe('invoice.pdf');
    expect(liveRegion().textContent).toMatch(/invoice\.pdf/);
  });

  it('tells a signed document its edits export as an appended revision', async () => {
    harness.signatures = [{ field: 'Signature1' }];
    await openDocument();
    const notice = document.querySelector('[data-signed-notice]');
    expect(notice?.textContent).toMatch(/appended incremental revision/i);
    expect(notice?.textContent).toMatch(/signature stays verifiable/i);
    expect(notice?.textContent).toMatch(/not written back over the signed bytes/i);
  });

  it('steps back to Edit after one placement, and stays armed when pinned', async () => {
    await openDocument();
    const place = () => {
      fireEvent.mouseDown(overlay(), { clientX: 400, clientY: 620 });
      fireEvent.mouseMove(overlay(), { clientX: 460, clientY: 660 });
      fireEvent.mouseUp(overlay());
    };
    fireEvent.click(screen.getByRole('button', { name: 'Add text box' }));
    expect(overlay().style.cursor).toBe('crosshair');
    place();
    // Bug 1's class, on this surface: the box is placed, the tool has stepped
    // aside, and the new object is the selection.
    expect(overlay().style.cursor).toBe('default');
    expect(document.querySelector('[role="textbox"]')).not.toBeNull();
    expect(rowsIn(editsList())).toHaveLength(1);
    // Pin overrides the default, and the pin is visible on the control.
    fireEvent.click(screen.getByRole('button', { name: /one-shot/i }));
    expect(document.querySelector('[data-tool-pin="pinned"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add text box' }));
    place();
    expect(overlay().style.cursor).toBe('crosshair');
    expect(rowsIn(editsList())).toHaveLength(2);
    // Esc walks the ladder one level at a time: edit, selection, pin, tool.
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(document.querySelector('[role="textbox"]')).toBeNull();
    expect(document.querySelector('[data-tool-pin="pinned"]')).not.toBeNull();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(document.querySelector('[data-selection-frame]')).toBeNull();
    expect(document.querySelector('[data-tool-pin="pinned"]')).not.toBeNull();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(document.querySelector('[data-tool-pin="one-shot"]')).not.toBeNull();
    expect(overlay().style.cursor).toBe('crosshair');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(overlay().style.cursor).toBe('default');
  });

  it('pins a placement tool so it keeps placing, and unpins on Esc', async () => {
    await openDocument();
    const pin = screen.getByRole('button', { name: /one-shot/i }) as HTMLButtonElement;
    expect(pin.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(pin);
    expect(screen.getByRole('button', { name: /pinned/i }).getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('[data-tool-pin="pinned"]')).not.toBeNull();
    // The pin survives selecting an object, and Esc is what takes it off.
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(document.querySelector('[data-tool-pin="one-shot"]')).not.toBeNull();
    expect(liveRegion().textContent).toMatch(/unpinned/i);
  });
});
