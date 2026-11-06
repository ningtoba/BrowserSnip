/**
 * Edge cases on the editing surfaces (brief section A4).
 *
 * jsdom has no canvas, so nothing here paints: what is asserted is the model, the
 * geometry, the routing and the history invariants the editors are built on, plus a
 * handful of mounts that prove the decisions reach the DOM (quick-mode chips, the
 * grouped inspector, the keyboard, and a primary action that is disabled before the
 * click rather than after a broken file).
 *
 * Groups follow the matrix rows they answer: E6 single page, E8 mixed sizes, E9
 * rotated pages, E10 no text layer, E11 CJK/RTL, E13 zero results, E15 out of range,
 * E18 nothing selected, E19 switching documents, E20 missing engine.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import AnnotationEditor from '@/components/tools/pdf/editor/AnnotationEditor';
import CropTool from '@/components/tools/pdf/edit/CropTool';
import { ScanTool } from '@/components/tools/pdf/scan/ScanTool';
import { RedactTool } from '@/components/tools/pdf/security/RedactTool';
import {
  QUICK_MODES,
  adoptedFile,
  clearEditorIntent,
  defaultToolForToolId,
  peekEditorIntent,
  planQuickMode,
  quickModeById,
  requestQuickMode,
  takeEditorIntent,
  toolIdFromLocation,
  DROP_REASSURANCE,
} from '@/components/tools/pdf/editor/quickModes';
import {
  EDITOR_SHORTCUTS,
  SHORTCUT_GROUP_LABELS,
  TOOL_SHORTCUT_KEYS,
  groupsIn,
  historyCommandForKey,
  isTypingTarget,
  keyForTool,
  toolForKey,
} from '@/components/tools/pdf/editor/shortcuts';
import { GROUP_FOR_TOOL, TOOLS, TOOL_GROUPS, paletteIsGrouped, toolGroupById, toolsOfGroup } from '@/components/tools/pdf/editor/tools';
import {
  WorkCache,
  clampPageIndex,
  createWork,
  documentKey,
  formatPageExtent,
  isUnsaved,
  pageContextNotes,
  switchNotice,
} from '@/components/tools/pdf/editor/workspace';
import { clampPageNumber, fitMarkToPage, fractionToPoints, reportMarks } from '@/components/tools/pdf/editor/placement';
import { clampSensitivity, compareReport, sensitivityWords } from '@/components/tools/pdf/editor/documentFacts';
import { emptyMarks, dropEmptyMarks, marksSummary } from '@/components/tools/pdf/editor/specs';
import type { EditorAnnotation, EditorToolId } from '@/components/tools/pdf/editor/types';
import {
  MARGIN_MAX,
  MARGIN_MIN,
  clampMargin,
  scanPlanReport,
} from '@/components/tools/pdf/scan/ScanTool';
import { adviceActionLabel, blockCensus, pageAdvice, scriptsIn } from '@/components/tools/pdf/text-editor/pageAdvice';
import { TEXT_EDITOR_SHORTCUTS, TEXT_MODE_KEYS, keyForMode, textModeForKey } from '@/components/tools/pdf/text-editor/keys';
import {
  defaultPlan,
  parsePageOrder,
  planWarnings,
  pageItem,
  type Plan,
  type PlanSource,
} from '@/components/tools/pdf/organize/PageOrganizer';
import {
  clampFractions,
  describeCrop,
  distinctBoxes,
  marginsInPoints,
  resolveTargets,
  storedEdgeFor,
  targetPage,
  type CropFractions,
  type CropTargetPage,
} from '@/components/tools/pdf/edit/cropModel';

/* ------------------------------------------------------------------ *
 * Fixtures                                                           *
 * ------------------------------------------------------------------ */

const A4: CropTargetPage = targetPage(0, 595, 842, 0);
const A4_LANDSCAPE: CropTargetPage = targetPage(0, 595, 842, 90);
const NO_CROP: CropFractions = { top: 0, right: 0, bottom: 0, left: 0 };
const TOP_TEN: CropFractions = { top: 0.1, right: 0, bottom: 0, left: 0 };

function mark(overrides: Partial<EditorAnnotation> = {}): EditorAnnotation {
  return {
    id: overrides.id ?? `m-${Math.random().toString(36).slice(2, 8)}`,
    tool: (overrides.tool ?? 'highlight') as EditorToolId,
    kind: overrides.kind ?? ('Highlight' as EditorAnnotation['kind']),
    page: overrides.page ?? 0,
    rect: overrides.rect ?? { x: 10, y: 10, width: 100, height: 12 },
    color: '#FFEE58',
    borderWidth: 1,
    opacity: 1,
    createdAt: 0,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * Quick-mode routing (defect 5: editors with no routing)             *
 * ------------------------------------------------------------------ */

beforeEach(() => {
  clearEditorIntent();
  window.location.hash = '#/tool/edit-pdf';
});

afterEach(() => {
  cleanup();
  clearEditorIntent();
});

describe('quick modes', () => {
  it('offers exactly the three jobs the brief names', () => {
    expect(QUICK_MODES.map((mode) => mode.id)).toEqual(['sign', 'editText', 'annotate']);
    for (const mode of QUICK_MODES) {
      expect(mode.label.length).toBeGreaterThan(0);
      expect(mode.blurb.length).toBeGreaterThan(10);
      // A chip that routes nowhere is a dead button.
      expect(getPdfTool(mode.toolId), `tool ${mode.toolId} must exist`).toBeDefined();
    }
  });

  it('routes Sign off the annotation editor, carrying the open document', () => {
    const file = new File(['%PDF-1.4'], 'contract.pdf', { type: 'application/pdf' });
    const plan = planQuickMode(quickModeById('sign')!, { currentToolId: 'edit-pdf', file });
    expect(plan.navigate).toBe(true);
    expect(plan.path).toBe('/tool/sign');
    expect(plan.intent.toolId).toBe('sign');
    expect(plan.intent.panel).toBe('draw');
    expect(plan.intent.file).toBe(file);
    expect(plan.intent.note).toMatch(/sign/i);
  });

  it('keeps Annotate where it already is and arms the highlighter instead', () => {
    const plan = planQuickMode(quickModeById('annotate')!, { currentToolId: 'edit-pdf', file: null });
    expect(plan.navigate).toBe(false);
    expect(plan.intent.armTool).toBe('highlight');
    expect(plan.intent.file).toBeNull();
    expect(plan.intent.note).toBeNull();
  });

  it('hands the intent over exactly once', () => {
    const mode = quickModeById('editText')!;
    requestQuickMode(mode, { currentToolId: 'edit-pdf' });
    expect(peekEditorIntent()?.toolId).toBe('edit-pdf-text');
    expect(window.location.hash).toBe('#/tool/edit-pdf-text');
    expect(takeEditorIntent('sign')).toBeNull();
    const taken = takeEditorIntent('edit-pdf-text');
    expect(taken?.panel).toBe('text');
    expect(takeEditorIntent('edit-pdf-text')).toBeNull();
  });

  it('carries the document across exactly once (the store keeps a slot per tool)', () => {
    const file = new File(['%PDF-1.4'], 'quote.pdf', { type: 'application/pdf' });
    const intent = planQuickMode(quickModeById('sign')!, { currentToolId: 'edit-pdf', file }).intent;
    expect(adoptedFile(intent, [])).toBe(file);
    // Already open here: adopting it again would give one document two tabs (E16).
    expect(adoptedFile(intent, [{ name: file.name }])).toBeNull();
    expect(adoptedFile(null, [])).toBeNull();
    const stayed = planQuickMode(quickModeById('annotate')!, { currentToolId: 'edit-pdf', file }).intent;
    expect(adoptedFile(stayed, [])).toBeNull();
  });

  it('reads the route out of the hash, and nothing else', () => {
    expect(toolIdFromLocation('#/tool/add-stamps')).toBe('add-stamps');
    expect(toolIdFromLocation('#/pdf')).toBeNull();
    expect(toolIdFromLocation('')).toBeNull();
    expect(defaultToolForToolId('add-stamps')).toBe('stamp');
    expect(defaultToolForToolId('redact-pdf')).toBe('redact');
    expect(defaultToolForToolId('edit-pdf-text')).toBeNull();
  });

  it('carries the document across once, and never doubles it (E16, E19)', () => {
    const file = new File(['%PDF-1.4'], 'quote.pdf', { type: 'application/pdf' });
    const intent = planQuickMode(quickModeById('sign')!, { currentToolId: 'edit-pdf', file }).intent;
    expect(adoptedFile(intent, [])).toBe(file);
    // The target tool already has it: adopting again would give one document two tabs.
    expect(adoptedFile(intent, [{ name: file.name }])).toBeNull();
    expect(adoptedFile(null, [])).toBeNull();
    expect(adoptedFile(peekEditorIntent(), [])).toBeNull();
    // A chip that stayed put carries nothing.
    const stayed = planQuickMode(quickModeById('annotate')!, { currentToolId: 'edit-pdf', file }).intent;
    expect(adoptedFile(stayed, [])).toBeNull();
  });

  it('promises only what the code can keep', () => {
    expect(DROP_REASSURANCE.join(' ')).toMatch(/never leaves this device/i);
    expect(DROP_REASSURANCE.join(' ')).toMatch(/until you press Export/i);
  });
});

/* ------------------------------------------------------------------ *
 * Keyboard vocabulary                                                *
 * ------------------------------------------------------------------ */

describe('shortcuts', () => {
  it('binds V H T P to the four tools the brief names', () => {
    expect(toolForKey('v')).toBe('select');
    expect(toolForKey('h')).toBe('highlight');
    expect(toolForKey('t')).toBe('freetext');
    expect(toolForKey('p')).toBe('ink');
    expect(toolForKey('H')).toBe('highlight');
    expect(toolForKey('x')).toBeNull();
    expect(toolForKey('')).toBeNull();
    expect(TOOL_SHORTCUT_KEYS.q).toBeUndefined();
  });

  it('decodes the history keys with their modifiers', () => {
    expect(historyCommandForKey('z', { ctrl: true })).toBe('undo');
    expect(historyCommandForKey('z', { meta: true })).toBe('undo');
    expect(historyCommandForKey('Z', { ctrl: true, shift: true })).toBe('redo');
    expect(historyCommandForKey('y', { ctrl: true })).toBe('redo');
    expect(historyCommandForKey('z', {})).toBeNull();
  });

  it('loses to the caret, so typing never changes the pen', () => {
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(textarea)).toBe(true);
    expect(isTypingTarget(editable)).toBe(true);
    expect(isTypingTarget(document.createElement('select'))).toBe(true);
    const notEditable = document.createElement('div');
    notEditable.setAttribute('contenteditable', 'false');
    expect(isTypingTarget(notEditable)).toBe(false);
    expect(isTypingTarget(document.createElement('div'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it('documents every bound key, including the ones the brief lists', () => {
    const printed = EDITOR_SHORTCUTS.map((row) => row.keys.join('+'));
    for (const wanted of ['V', 'H', 'T', 'P', 'Esc', 'Delete', 'Ctrl+Z', 'Ctrl+Y']) {
      expect(printed, `shortcut list must document ${wanted}`).toContain(wanted);
    }
    for (const row of EDITOR_SHORTCUTS) expect(SHORTCUT_GROUP_LABELS[row.group]).toBeTruthy();
    // The badge on a palette button is the reverse of the same table.
    expect(keyForTool('highlight')).toBe('H');
    expect(keyForTool('square')).toBeNull();
  });

  it('gives the text editor its own table, generated from its own bindings', () => {
    expect(textModeForKey('v')).toBe('edit');
    expect(textModeForKey('t')).toBe('add-text');
    expect(textModeForKey('i')).toBe('add-image');
    expect(textModeForKey('h')).toBeNull();
    expect(keyForMode('add-image')).toBe('I');
    expect(Object.keys(TEXT_MODE_KEYS).sort()).toEqual(['i', 't', 'v']);
    const printed = TEXT_EDITOR_SHORTCUTS.map((row) => row.keys.join('+'));
    for (const wanted of ['V', 'T', 'I', 'Esc', 'Delete', 'Ctrl+Z', 'Ctrl+Y']) {
      expect(printed, `text editor must document ${wanted}`).toContain(wanted);
    }
    expect(groupsIn(TEXT_EDITOR_SHORTCUTS)).toContain('blocks');
    expect(SHORTCUT_GROUP_LABELS.blocks).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ *
 * Inspector: grouped palette (defect 5: a wall of tools)             *
 * ------------------------------------------------------------------ */

describe('inspector grouping', () => {
  it('puts every palette entry in exactly one named group', () => {
    expect(paletteIsGrouped()).toBe(true);
    expect(TOOL_GROUPS.length).toBeGreaterThan(1);
    for (const group of TOOL_GROUPS) {
      expect(group.label.length).toBeGreaterThan(2);
      expect(toolsOfGroup(group).map((meta) => meta.id)).toEqual(group.tools);
    }
    expect(GROUP_FOR_TOOL.highlight).toBe('markup');
    expect(GROUP_FOR_TOOL.freetext).toBe('words');
    expect(GROUP_FOR_TOOL.ink).toBe('draw');
    expect(toolGroupById('page')?.label).toMatch(/page/i);
    expect(toolGroupById('nope')).toBeUndefined();
    expect(toolGroupById(null)).toBeUndefined();
  });

  it('has an inspector section shell for the options and the keys', () => {
    render(createElement(AnnotationEditor));
    const aside = document.querySelector('[data-editor-palette]');
    expect(aside).not.toBeNull();
    const sections = aside!.querySelectorAll('[data-inspector-section]');
    const ids = Array.from(sections).map((node) => node.getAttribute('data-inspector-section'));
    expect(ids).toEqual(expect.arrayContaining(['tools', 'options', 'keys']));
    // The shortcut list is the real table, not a picture of one.
    const keys = aside!.querySelectorAll('[data-inspector-section="keys"] kbd');
    expect(keys.length).toBeGreaterThanOrEqual(
      EDITOR_SHORTCUTS.reduce((total, row) => total + row.keys.length, 0),
    );
  });
});

/* ------------------------------------------------------------------ *
 * Per-document work, page context (E6, E8, E9, E19)                  *
 * ------------------------------------------------------------------ */

describe('workspace model', () => {
  it('identifies a document by more than its name', () => {
    const a = { name: 'scan.pdf', size: 100, lastModified: 1 };
    const b = { name: 'scan.pdf', size: 200, lastModified: 1 };
    expect(documentKey(a)).not.toBe(documentKey(b));
    expect(documentKey(a)).toBe(documentKey({ ...b, size: 100 }));
    expect(documentKey(null)).toBe('');
  });

  it('bounds the page index for a one-page document and an empty one', () => {
    expect(clampPageIndex(0, 0)).toBe(0);
    expect(clampPageIndex(4, 1)).toBe(0);
    expect(clampPageIndex(99, 5)).toBe(4);
    expect(clampPageIndex(-3, 5)).toBe(0);
    expect(clampPageIndex(Number.NaN, 5)).toBe(0);
  });

  it('keeps one workspace per document, and stays bounded', () => {
    const cache = new WorkCache<number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
    expect(new WorkCache(2).get('missing')).toBeUndefined();
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('reports unsaved work only when there is work', () => {
    const work = createWork();
    expect(isUnsaved(work)).toBe(false);
    expect(isUnsaved(null)).toBe(false);
    expect(isUnsaved(work, [mark()])).toBe(true);
    const exported = { ...work, exportedSignature: 'x' };
    expect(isUnsaved(exported, [])).toBe(false);
  });

  it('says what a single-page, rotated, mixed-size page means for the marks', () => {
    const lone = pageContextNotes({ index: 0, total: 1, rotation: 0, widthPt: 595, heightPt: 842 });
    expect(lone.map((note) => note.text).join(' ')).toMatch(/one page/i);

    const turned = pageContextNotes({ index: 2, total: 9, rotation: 450, widthPt: 595, heightPt: 842 });
    const turnedText = turned.map((note) => note.text).join(' ');
    expect(turnedText).toMatch(/rotated 90°/);
    expect(turnedText).toMatch(/stay where you drew them/);

    const mixed = pageContextNotes({
      index: 1,
      total: 9,
      rotation: 0,
      widthPt: 612,
      heightPt: 792,
      distinctSizes: 3,
    });
    expect(mixed.some((note) => note.tone === 'warn' && /612 × 792 pt/.test(note.text))).toBe(true);
    expect(pageContextNotes({ index: 0, total: 9, rotation: 0, widthPt: 595, heightPt: 842, distinctSizes: 1 })).toHaveLength(0);
    expect(formatPageExtent(595.4, 841.8)).toBe('595 × 842 pt');
  });

  it('explains a document switch that kept work, and one that dropped a draft', () => {
    expect(switchNotice({ fileName: 'b.pdf', kept: 3, discardedPending: false })).toMatch(/3 marks kept on the other document/);
    expect(switchNotice({ fileName: 'b.pdf', kept: 1, discardedPending: false })).toMatch(/1 mark kept/);
    expect(switchNotice({ fileName: 'b.pdf', kept: 0, discardedPending: true })).toMatch(/Switched to b\.pdf\./);
    expect(switchNotice({ fileName: 'b.pdf', kept: 0, discardedPending: true })).toMatch(/half-drawn/);
  });
});

/* ------------------------------------------------------------------ *
 * Marks that would change nothing (E13)                              *
 * ------------------------------------------------------------------ */

describe('empty marks', () => {
  it('names a redaction that covers no area and a note with no text', () => {
    const found = emptyMarks([
      mark({ id: 'r1', tool: 'redact', kind: 'Redact', rect: { x: 0, y: 0, width: 0, height: 0 } }),
      mark({ id: 't1', tool: 'note', kind: 'Text', contents: '   ' }),
      mark({ id: 'f1', tool: 'freetext', kind: 'FreeText', text: '' }),
      mark({ id: 'i1', tool: 'ink', kind: 'Ink', inkPath: [[[1, 1]]] }),
      mark({ id: 'g1', tool: 'square', kind: 'Square', rect: { x: 0, y: 0, width: Number.NaN, height: 4 } }),
      mark({ id: 'ok', tool: 'highlight', kind: 'Highlight' }),
    ]);
    expect(found.map((entry) => entry.id).sort()).toEqual(['f1', 'g1', 'i1', 'r1', 't1']);
    expect(found.find((entry) => entry.id === 'r1')?.reason).toMatch(/covers no area/);
    expect(found.find((entry) => entry.id === 't1')?.reason).toMatch(/no comment text/);
    expect(found.find((entry) => entry.id === 'g1')?.reason).toMatch(/no usable geometry/);
    expect(found.every((entry) => /page \d/.test(entry.reason))).toBe(true);
  });

  it('drops exactly the marks it reported', () => {
    const list = [
      mark({ id: 'keep', tool: 'highlight', kind: 'Highlight' }),
      mark({ id: 'speck', tool: 'redact', kind: 'Redact', rect: { x: 0, y: 0, width: 0, height: 0 } }),
      mark({ id: 'quiet', tool: 'note', kind: 'Text', contents: '' }),
    ];
    const kept = dropEmptyMarks(list);
    expect(kept.map((entry) => entry.id)).toEqual(['keep']);
    // Nothing reported means the same list, so undo keeps a clean step.
    expect(dropEmptyMarks(kept)).toBe(kept);
    expect(dropEmptyMarks([])).toEqual([]);
  });

  it('summarises the page for the export button', () => {
    expect(marksSummary([])).toMatch(/Nothing on the page yet/);
    expect(marksSummary([mark()])).toMatch(/1 mark on 1 page/);
    expect(marksSummary([mark(), mark({ id: 'b', page: 1 })])).toMatch(/2 marks on 2 page/);
    expect(marksSummary([mark({ tool: 'redact', kind: 'Redact' })])).toMatch(/delete text on export/);
  });
});

/* ------------------------------------------------------------------ *
 * Placing marks on pages that are not the expected size (E8, E13, E19) *
 * ------------------------------------------------------------------ */

describe('placement', () => {
  it('refuses a page the document does not have', () => {
    expect(clampPageNumber(1, 1)).toBe(1);
    expect(clampPageNumber(2, 1)).toBeNull();
    expect(clampPageNumber(0, 5)).toBeNull();
    expect(clampPageNumber(3, 0)).toBeNull();
  });

  it('shrinks an oversized mark and keeps the rest untouched', () => {
    const big = fitMarkToPage({ page: 1, x: 0.9, y: 0.9, w: 2, h: 1 }, { page: 1, widthPt: 300, heightPt: 200 });
    expect(big.scaled).toBe(true);
    expect(big.mark.w * 300).toBeLessThanOrEqual(300);
    expect(big.mark.h * 200).toBeLessThanOrEqual(200);
    expect(big.mark.x).toBeLessThanOrEqual(1 - big.mark.w);
    expect(big.reason).toMatch(/fitted to page 1/);

    const fine = fitMarkToPage({ page: 1, x: 0.2, y: 0.2, w: 0.3, h: 0.2 }, { page: 1, widthPt: 595, heightPt: 842 });
    expect(fine.fitted).toBe(false);
    expect(fine.reason).toBeNull();
  });

  it('converts page fractions to points for the engine', () => {
    expect(fractionToPoints({ x: 0.5, y: 0.25, w: 0.1, h: 0.5 }, { page: 3, widthPt: 600, heightPt: 800 })).toEqual({
      x: 300,
      y: 200,
      width: 60,
      height: 400,
    });
  });

  it('splits redaction boxes into what will be written and what will not', () => {
    const report = reportMarks(
      [
        { id: 'speck', page: 1, x: 0.1, y: 0.1, w: 0.0005, h: 0.0005 },
        { id: 'ghost', page: 9, x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        { id: 'real', page: 2, x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
      ],
      {
        numPages: 3,
        page: { page: 1, widthPt: 595, heightPt: 842 },
        describe: (box) => `box ${box.id} on page ${box.page}`,
      },
    );
    expect(report.usable.map((entry) => entry.id)).toEqual(['real']);
    expect(report.empty.map((entry) => entry.id)).toEqual(['speck']);
    expect(report.offPage.map((entry) => entry.id)).toEqual(['ghost']);
    expect(report.notes.join(' ')).toMatch(/page 9/);
    expect(report.notes.join(' ')).toMatch(/belong to the document that was open before/);
    expect(report.valid).toBe(true);
    expect(
      reportMarks([report.empty[0]], {
        numPages: 3,
        page: { page: 1, widthPt: 595, heightPt: 842 },
        describe: () => 'box',
      }).valid,
    ).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Crop: geometry, clamping, honesty (E6, E9, E13, E15, E18)          *
 * ------------------------------------------------------------------ */

describe('crop model', () => {
  it('clamps fractions into the page instead of trusting the overlay', () => {
    expect(clampFractions({ top: -0.4, right: 2, bottom: Number.NaN, left: 0.25 })).toEqual({
      top: 0,
      right: 1,
      bottom: 0,
      left: 0.25,
    });
  });

  it('re-aims the margins at the stored box when the page is rotated', () => {
    // A4 portrait: 595 wide, 842 tall. Trim 10% off the displayed top.
    expect(marginsInPoints(TOP_TEN, A4)).toEqual({ left: 0, right: 0, top: 84.2, bottom: 0 });
    const turned = marginsInPoints(TOP_TEN, A4_LANDSCAPE);
    expect(turned.left).toBeCloseTo(59.5, 1);
    expect(turned.top).toBe(0);
    expect(storedEdgeFor(90, 'top')).toBe('left');
    expect(storedEdgeFor(180, 'top')).toBe('bottom');
    expect(storedEdgeFor(270, 'top')).toBe('right');
    expect(storedEdgeFor(0, 'top')).toBe('top');
    expect(marginsInPoints(TOP_TEN, targetPage(0, 595, 842, 180)).bottom).toBeCloseTo(84.2, 1);
    expect(marginsInPoints(TOP_TEN, targetPage(0, 595, 842, 270)).right).toBeCloseTo(59.5, 1);
  });

  it('says when a crop would keep nothing, or nothing at all', () => {
    const greedy = describeCrop({
      rect: { top: 0.6, bottom: 0.5, left: 0, right: 0 },
      preview: A4,
      targets: [1],
      numPages: 4,
      allPages: false,
    });
    expect(greedy.valid).toBe(false);
    expect(greedy.tone).toBe('danger');
    expect(greedy.notes.join(' ')).toMatch(/removes the whole page/);

    const none = describeCrop({ rect: NO_CROP, preview: A4, targets: [1, 2], numPages: 4, allPages: true });
    expect(none.valid).toBe(true);
    expect(none.notes.join(' ')).toMatch(/all four margins are zero/);

    const sliver = describeCrop({
      rect: { top: 0.49, bottom: 0.49, left: 0, right: 0 },
      preview: A4,
      targets: [1],
      numPages: 4,
      allPages: false,
    });
    expect(sliver.valid).toBe(true);
    expect(sliver.tone).toBe('warn');
    expect(sliver.notes.join(' ')).toMatch(/sliver, not a margin/);

    const clipped = describeCrop({
      rect: { top: 0.4995, bottom: 0.4995, left: 0, right: 0 },
      preview: A4,
      targets: [1],
      numPages: 4,
      allPages: false,
    });
    expect(clipped.valid).toBe(false);
    expect(clipped.notes.join(' ')).toMatch(/narrower than 8 pt/);
  });

  it('states the rotation it compensated for and the mixed sizes it cannot', () => {
    const rotated = describeCrop({
      rect: TOP_TEN,
      preview: A4_LANDSCAPE,
      targets: [1],
      numPages: 2,
      allPages: false,
    });
    expect(rotated.notes.join(' ')).toMatch(/rotated 90°/);
    expect(rotated.notes.join(' ')).toMatch(/top → left/);

    const many = describeCrop({ rect: TOP_TEN, preview: A4, targets: [1, 2, 3], numPages: 3, allPages: true });
    expect(many.notes.join(' ')).toMatch(/same margins in points are applied to all 3 pages/);

    const lone = describeCrop({ rect: TOP_TEN, preview: A4, targets: [1], numPages: 1, allPages: true });
    expect(lone.notes.join(' ')).toMatch(/one page/i);
  });

  it('requires a page to crop (E18)', () => {
    const noDoc = describeCrop({ rect: TOP_TEN, preview: null, targets: [], numPages: 0, allPages: false });
    expect(noDoc.valid).toBe(false);
    expect(noDoc.notes.join(' ')).toMatch(/Open a PDF first/);
    const noTarget = describeCrop({ rect: TOP_TEN, preview: A4, targets: [], numPages: 4, allPages: false });
    expect(noTarget.valid).toBe(false);
    expect(noTarget.notes.join(' ')).toMatch(/No page is selected/);
  });

  it('resolves page targets against the real page count', () => {
    expect(resolveTargets('1-3,5', 3).pages).toEqual([1, 2, 3]);
    expect(resolveTargets('1-3,5', 3).refused.map((entry) => entry.token)).toEqual(['1-3,5'.split(',')[1]]);
    expect(resolveTargets('2,2-4,1', 4).pages).toEqual([2, 3, 4, 1]);
    expect(resolveTargets('all', 3).pages).toEqual([1, 2, 3]);
    expect(resolveTargets('5-2', 6).refused[0].reason).toMatch(/counts backwards/);
    expect(resolveTargets('0', 6).refused[0].reason).toMatch(/numbered from 1/);
    expect(resolveTargets('9', 6).refused[0].reason).toMatch(/has 6 pages/);
    expect(resolveTargets('one', 6).refused[0].reason).toMatch(/not a page number/);
    expect(resolveTargets('', 6).pages).toEqual([]);
    expect(resolveTargets('1,3', 1).pages).toEqual([1]);
  });

  it('counts distinct page boxes', () => {
    expect(distinctBoxes([A4, targetPage(1, 595, 842, 90), targetPage(2, 612, 792, 0)])).toEqual(['595x842', '612x792']);
    const swapped = targetPage(0, 595, 842, 270);
    expect(swapped.displayWidthPt).toBe(842);
    expect(swapped.displayHeightPt).toBe(595);
  });
});

/* ------------------------------------------------------------------ *
 * Text editor: a page with nothing to edit (E10, E11, E20)           *
 * ------------------------------------------------------------------ */

describe('page advice', () => {
  const base = {
    hasDocument: true,
    opening: false,
    numPages: 4,
    page: 2,
    imageCount: 0,
    engineAvailable: false,
  };

  it('calls a scan a scan and offers OCR', () => {
    const advice = pageAdvice({ ...base, blocks: [], imageCount: 1 })!;
    expect(advice.kind).toBe('no-text');
    expect(advice.tone).toBe('warn');
    expect(advice.headline).toMatch(/page 2 has no text layer/i);
    expect(advice.actions).toContain('run-ocr');
    expect(advice.actions).toContain('add-text');
  });

  it('does not claim a blank page is broken', () => {
    expect(pageAdvice({ ...base, blocks: [], imageCount: 0 })!.kind).toBe('blank-page');
  });

  it('is honest about an invisible OCR layer, with and without the engine', () => {
    const blocks = [{ invisible: true, direction: 'rtl' as const, text: 'שלום' }];
    const offline = pageAdvice({ ...base, blocks })!;
    expect(offline.kind).toBe('ocr-layer');
    expect(offline.actions).toEqual(expect.arrayContaining(['run-ocr', 'open-engine']));
    expect(offline.detail).toMatch(/doubled text/);
    const online = pageAdvice({ ...base, blocks, engineAvailable: true })!;
    expect(online.detail).toMatch(/optional engine is reachable/);
    expect(online.actions).not.toContain('open-engine');
  });

  it('warns about CJK and right-to-left re-wrap before the commit', () => {
    const cjk = pageAdvice({ ...base, blocks: [{ invisible: false, direction: 'ltr', text: '中文段落' }] })!;
    expect(cjk.kind).toBe('script-notice');
    expect(cjk.headline).toMatch(/CJK/);
    const rtl = pageAdvice({ ...base, blocks: [{ invisible: false, direction: 'rtl', text: 'مرحبا' }] })!;
    expect(rtl.kind).toBe('script-notice');
    expect(rtl.headline).toMatch(/right-to-left/);
    expect(pageAdvice({ ...base, blocks: [{ invisible: false, direction: 'ltr', text: 'plain words' }] })).toBeNull();
  });

  it('says something useful for a one-page document, and nothing while opening', () => {
    expect(pageAdvice({ ...base, numPages: 1, page: 1, blocks: [{ invisible: false, direction: 'ltr', text: 'hi' }] })!.kind).toBe(
      'single-page',
    );
    expect(pageAdvice({ ...base, opening: true, blocks: [] })).toBeNull();
    expect(pageAdvice({ ...base, hasDocument: false, blocks: [] })).toBeNull();
  });

  it('names the action it offers', () => {
    expect(adviceActionLabel('run-ocr')).toMatch(/OCR/i);
    expect(adviceActionLabel('add-text')).toMatch(/text box/i);
    expect(adviceActionLabel('open-engine')).toMatch(/engine/i);
    expect(adviceActionLabel('next-page')).toMatch(/next page/i);
  });

  it('counts scripts and the invisible layer', () => {
    expect(scriptsIn(['hello 世界'])).toEqual(expect.arrayContaining(['cjk', 'latin']));
    expect(scriptsIn(['مرحبا'])).toEqual(['rtl']);
    expect(scriptsIn([''])).toEqual([]);
    expect(blockCensus([{ invisible: true, direction: 'ltr', text: 'a' }, { invisible: false, direction: 'ltr', text: 'b' }])).toEqual({
      total: 2,
      visible: 1,
      invisible: 1,
    });
  });
});

/* ------------------------------------------------------------------ *
 * Compare: what two documents can be promised (E6, E13, E15, E18)    *
 * ------------------------------------------------------------------ */

describe('document facts', () => {
  it('needs two measurable documents before it can run', () => {
    const one = compareReport({ a: { name: 'a.pdf', pages: 3 }, b: null, filesLoaded: 1, previewPages: 1, diffPercent: 4 });
    expect(one.valid).toBe(false);
    expect(one.notes[0]).toMatch(/second document/i);
    const broken = compareReport({
      a: { name: 'a.pdf', pages: 0, error: 'it is encrypted' },
      b: { name: 'b.pdf', pages: 2 },
      filesLoaded: 2,
      previewPages: 2,
      diffPercent: 0,
    });
    expect(broken.valid).toBe(false);
    expect(broken.notes.join(' ')).toMatch(/encrypted/);
  });

  it('names the pages that will not be compared', () => {
    const report = compareReport({
      a: { name: 'a.pdf', pages: 5 },
      b: { name: 'b.pdf', pages: 2 },
      filesLoaded: 2,
      previewPages: 2,
      diffPercent: 1.5,
    });
    expect(report.comparedPages).toBe(2);
    expect(report.notes.join(' ')).toMatch(/3 more pages/);
    expect(report.notes.join(' ')).toMatch(/1\.5% of the compared pixels/);
    const same = compareReport({
      a: { name: 'a.pdf', pages: 1 },
      b: { name: 'b.pdf', pages: 1 },
      filesLoaded: 2,
      previewPages: 1,
      diffPercent: 2,
    });
    expect(same.notes.join(' ')).toMatch(/single page/i);
  });

  it('does not sell an empty comparison as a result', () => {
    const equal = compareReport({
      a: { name: 'a.pdf', pages: 3 },
      b: { name: 'b.pdf', pages: 3 },
      filesLoaded: 2,
      previewPages: 3,
      diffPercent: 0,
    });
    expect(equal.tone).toBe('warn');
    expect(equal.notes.join(' ')).toMatch(/No pixels differ/);
  });

  it('keeps the threshold inside the range the diff loop means', () => {
    expect(clampSensitivity(0)).toBe(5);
    expect(clampSensitivity(999)).toBe(150);
    expect(clampSensitivity(Number.NaN)).toBe(5);
    expect(sensitivityWords(10)).toMatch(/antialiasing/);
    expect(sensitivityWords(120)).toMatch(/only large changes/);
  });
});

/* ------------------------------------------------------------------ *
 * Organize: clamping and the empty plan (E6, E13, E18, E19)          *
 * ------------------------------------------------------------------ */

describe('organize plan', () => {
  const sources: PlanSource[] = [{ name: 'a.pdf', pages: 3 }];

  it('refuses a page the document does not have, naming the count', () => {
    expect(() => parsePageOrder('4', sources)).toThrow(/has 3 pages/);
    expect(() => parsePageOrder('2', [{ name: 'a.pdf', pages: 1 }])).toThrow(/has 1 page/);
    expect(() => parsePageOrder('f2:1', sources)).toThrow(/1 PDF is open/);
    expect(() => parsePageOrder('nope', sources)).toThrow(/not a page token/);
    expect(() => parsePageOrder('3', [])).toThrow(/0 PDFs are open/);
    expect(() => parsePageOrder('1', [{ name: 'a.pdf', pages: 0 }])).toThrow(/has 0 pages/);
    expect(parsePageOrder('2r45', sources)[0]).toEqual(pageItem(0, 1, 90));
    expect(defaultPlan(sources, 0)).toHaveLength(3);
    expect(defaultPlan([{ name: 'a.pdf', pages: 0 }], 0)).toEqual([]);
  });

  it('warns before saving a plan that outputs nothing', () => {
    const empty = planWarnings([], sources);
    expect(empty[0].tone).toBe('danger');
    expect(empty[0].text).toMatch(/0 output pages/);
    const blanks: Plan = [{ kind: 'blank' }, { kind: 'blank' }];
    expect(planWarnings(blanks, sources)[0].text).toMatch(/blank sheet/);
    const stale: Plan = [pageItem(0, 7)];
    expect(planWarnings(stale, sources).some((note) => /changed/.test(note.text))).toBe(true);
    const locked = planWarnings(defaultPlan(sources, 0), sources, { statuses: ['locked'] });
    expect(locked.some((note) => /password locked/.test(note.text))).toBe(true);
    const doubled = planWarnings([pageItem(0, 0), pageItem(0, 0), pageItem(0, 1)], sources);
    expect(doubled.some((note) => /duplicate/.test(note.text))).toBe(true);
    expect(
      planWarnings([pageItem(0, 0)], [{ name: 'a.pdf', pages: 1 }]).some((note) => /one page/i.test(note.text)),
    ).toBe(true);
    expect(planWarnings(defaultPlan(sources, 0), sources, { statuses: ['ready'] })).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * Scan: nothing captured, out-of-range margin (E13, E15, E18, E20)   *
 * ------------------------------------------------------------------ */

describe('scan plan', () => {
  it('will not build a PDF from zero pages', () => {
    const empty = scanPlanReport({ pages: 0, pageSize: 'a4', orientation: 'portrait', margin: 10 });
    expect(empty.valid).toBe(false);
    expect(empty.notes[0]).toMatch(/Nothing has been captured/);
  });

  it('states the paper it is about to make', () => {
    const plan = scanPlanReport({ pages: 3, pageSize: 'letter', orientation: 'landscape', margin: 12 });
    expect(plan.valid).toBe(true);
    expect(plan.notes[0]).toMatch(/3 pages on US Letter landscape, 12 pt border/);
    expect(scanPlanReport({ pages: 1, pageSize: 'fit', orientation: 'portrait', margin: 0 }).notes.join(' ')).toMatch(
      /exactly the picture/,
    );
    expect(scanPlanReport({ pages: 1, pageSize: 'original', orientation: 'portrait', margin: 30 }).notes.join(' ')).toMatch(
      /page grows/,
    );
    expect(scanPlanReport({ pages: 2, pageSize: 'a4', orientation: 'portrait', margin: MARGIN_MAX }).notes.join(' ')).toMatch(
      /largest margin/,
    );
  });

  it('clamps a typed margin instead of rejecting the run', () => {
    expect(clampMargin(-5)).toBe(MARGIN_MIN);
    expect(clampMargin(120)).toBe(MARGIN_MAX);
    expect(clampMargin(17.6)).toBe(18);
    expect(clampMargin(Number.NaN)).toBe(MARGIN_MIN);
  });
});

/* ------------------------------------------------------------------ *
 * The editor surface itself (routing, inspector, keyboard)           *
 * ------------------------------------------------------------------ */

describe('annotation editor surface', () => {
  it('opens on a chooser that routes, not a wall of tools', () => {
    render(createElement(AnnotationEditor));
    const group = screen.getByRole('group', { name: 'Editor quick modes' });
    expect(within(group).getByRole('button', { name: /Sign/ })).toBeTruthy();
    expect(within(group).getByRole('button', { name: /Edit text/ })).toBeTruthy();
    expect(within(group).getByRole('button', { name: /Annotate/ })).toBeTruthy();
    expect(screen.getByText(/never leaves this device/i)).toBeTruthy();
    expect(document.querySelectorAll('[data-tool]')).toHaveLength(TOOLS.length);
    for (const group_ of TOOL_GROUPS) {
      expect(document.querySelector(`[data-tool-group="${group_.id}"]`)).not.toBeNull();
    }
  });

  it('hands the document to the sign tool instead of reloading it', () => {
    render(createElement(AnnotationEditor));
    fireEvent.click(document.querySelector('[data-quick-mode="sign"]') as Element);
    expect(window.location.hash).toBe('#/tool/sign');
    const intent = peekEditorIntent();
    expect(intent?.toolId).toBe('sign');
    expect(intent?.panel).toBe('draw');
  });

  it('arms the highlighter in place when the chip is already the current route', () => {
    render(createElement(AnnotationEditor));
    fireEvent.click(document.querySelector('[data-tool="square"]') as Element);
    expect((document.querySelector('[data-tool="square"]') as HTMLElement).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(document.querySelector('[data-quick-mode="annotate"]') as Element);
    expect(window.location.hash).toBe('#/tool/edit-pdf');
    const pressed = document.querySelector('[data-tool="highlight"]') as HTMLElement;
    expect(pressed.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('[data-focused-group="markup"]')).not.toBeNull();
    expect(screen.getByText(/already does/i)).toBeTruthy();
  });

  it('arms tools from the keyboard and loses to a focused field', () => {
    render(createElement(AnnotationEditor));
    fireEvent.keyDown(window, { key: 'p' });
    expect((document.querySelector('[data-tool="ink"]') as HTMLElement).getAttribute('aria-pressed')).toBe('true');
    const box = document.createElement('input');
    document.body.appendChild(box);
    fireEvent.keyDown(box, { key: 'h' });
    expect((document.querySelector('[data-tool="highlight"]') as HTMLElement).getAttribute('aria-pressed')).toBe('false');
    // Ctrl+P is the browser's print dialog, not the pen.
    fireEvent.keyDown(window, { key: 't', ctrlKey: true });
    expect((document.querySelector('[data-tool="freetext"]') as HTMLElement).getAttribute('aria-pressed')).toBe('false');
    box.remove();
  });

  it('lists the shortcut table it actually implements', () => {
    render(createElement(AnnotationEditor));
    const section = document.querySelector('[data-inspector-section="keys"]') as HTMLElement;
    expect(within(section).getByText('Arm the pen')).toBeTruthy();
    expect(within(section).getByText('Remove the selected mark')).toBeTruthy();
    const printed = Array.from(section.querySelectorAll('kbd')).map((node) => node.textContent);
    expect(printed).toEqual(expect.arrayContaining(['V', 'H', 'T', 'P', 'Esc', 'Delete', 'Ctrl', 'Z', 'Y']));
    expect(screen.getByText(/ignored while a field has the caret/i)).toBeTruthy();
  });

  it('prints the bound key on the tool it binds', () => {
    render(createElement(AnnotationEditor));
    expect((document.querySelector('[data-tool="ink"]') as Element).getAttribute('aria-keyshortcuts')).toBe('P');
    expect((document.querySelector('[data-tool="square"]') as Element).hasAttribute('aria-keyshortcuts')).toBe(false);
    expect(document.querySelector('[data-inspector-section="tools"][open]')).not.toBeNull();
  });

  it('will not export a page that has nothing on it', () => {
    render(createElement(AnnotationEditor));
    const button = document.getElementById('tool-process-btn') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/Nothing on the page yet\./)).toBeTruthy();
  });
});

describe('crop and redact panels with nothing selected', () => {
  it('tells a camera-less context the truth instead of a spinner', () => {
    // jsdom has no `navigator.mediaDevices`, which is also what an http origin
    // hands the app — the panel must name the cause and offer the way around it.
    render(createElement(ScanTool));
    expect(screen.getByText(/No camera in this context/i)).toBeTruthy();
    expect(screen.getByText(/Add photos instead/)).toBeTruthy();
    expect(screen.queryByText(/Camera ready/)).toBeNull();
  });
  it('refuses to crop until a document is measured', () => {
    render(createElement(CropTool));
    const button = document.getElementById('tool-process-btn') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/No PDF is loaded/i)).toBeTruthy();
    expect(document.querySelector('[data-crop-notes]')).not.toBeNull();
  });

  it('refuses to redact boxes that cover nothing', () => {
    render(createElement(RedactTool));
    const button = document.getElementById('tool-process-btn') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toMatch(/Apply 0 Redactions/);
    // The panel explains itself before the click, not after a broken file.
    expect(button.getAttribute('title')).toMatch(/Drag a rectangle on the preview first/);
    expect(screen.getByText(/Permanent Redaction/i)).toBeTruthy();
    expect(screen.getByText(/cannot be recovered/i)).toBeTruthy();
  });
});
