/**
 * M1 — the annotation editor's interaction model (docs/UX-BRIEF.md).
 *
 * jsdom has no canvas, so this file never looks at pixels. It checks the three
 * things the brief rules on, all of which are pure state, geometry or DOM:
 *
 * 1. `afterCreate` is a *declared* property of each tool, the pin overrides it in
 *    either direction, and Escape unwinds exactly one level.
 * 2. A markup drag becomes text geometry — one annotation, one quad per real line
 *    box — never a rectangle; a drag over no words builds nothing; a click on an
 *    existing mark resolves to that mark.
 * 3. The palette DOM carries the accessibility contract: `role="toolbar"`,
 *    `aria-pressed` on tools and pins, a permanent live region, and a focus ring
 *    on every control the pointer can reach.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ExtractedTextItem } from '@/lib/pdf/core/render';
import {
  TOOLS,
  TOOL_BY_ID,
  defaultPinState,
  effectiveAfterCreate,
  isPlacementTool,
  pinLabel,
} from '@/components/tools/pdf/editor/tools';
import {
  EDITOR_SHORTCUTS,
  NUDGE_COARSE_PX,
  NUDGE_PX,
  escapeLevelNotice,
  isDuplicateKey,
  isTypeToEditKey,
  nextEscapeLevel,
  nudgeStep,
} from '@/components/tools/pdf/editor/shortcuts';
import { snapTextLines } from '@/components/tools/pdf/editor/quads';
import {
  RESIZE_HANDLES,
  buildAnnotation,
  duplicateAnnotation,
  handleCursor,
  markAtPoint,
  resizeAnnotation,
} from '@/components/tools/pdf/editor/specs';
import { screenToPdfPoint } from '@/components/tools/pdf/editor/geometry';
import { applyWorkStep, createWork, historyNotice } from '@/components/tools/pdf/editor/workspace';
import { pushHistory } from '@/components/tools/pdf/editor/history';
import AnnotationEditor from '@/components/tools/pdf/editor/AnnotationEditor';
import type { EditorAnnotation, EditorToolId, ToolStyle } from '@/components/tools/pdf/editor/types';
import { defaultStyleFor } from '@/components/tools/pdf/editor/tools';

/* ------------------------------------------------------------------ *
 * Fixtures                                                            *
 * ------------------------------------------------------------------ */

const PAGE_W = 612;
const PAGE_H = 792;
const flat = { zoom: 1, cssWidth: PAGE_W, cssHeight: PAGE_H, rotation: 0 as const };

function word(str: string, x: number, y: number, w: number, h: number): ExtractedTextItem {
  return {
    str,
    transform: [h, 0, 0, h, x, y],
    width: w,
    height: h,
    fontName: 'F1',
    dir: 'ltr',
    page: 1,
    x,
    y,
    w,
    h,
    hasEOL: false,
    isInvisible: false,
  };
}

/**
 * Three body lines with a wide left margin and ragged right edge, plus a
 * descender line, in viewport space (top-left origin).
 */
function threeLines(): ExtractedTextItem[] {
  return [
    word('Callout', 70, 100, 40, 11),
    word('text', 114, 100, 26, 11),
    word('here', 144, 100, 30, 11),
    word('second', 70, 120, 44, 11),
    word('line', 118, 120, 26, 11),
    word('of', 148, 120, 14, 11),
    word('copy', 166, 120, 30, 11),
    word('third', 70, 140, 34, 11),
    word('line', 108, 140, 26, 11),
    word('', 70, 160, 40, 11),
  ];
}

function build(
  tool: EditorToolId,
  over: Partial<Parameters<typeof buildAnnotation>[0]> = {},
  style: Partial<ToolStyle> = {},
): EditorAnnotation | null {
  return buildAnnotation({
    tool,
    page: 0,
    style: { ...defaultStyleFor(tool), ...style },
    geom: flat,
    ...over,
  });
}

/* ------------------------------------------------------------------ *
 * 1. Sticky vs one-shot is declared, and the pin overrides it         *
 * ------------------------------------------------------------------ */

const RULED_ONESHOT: EditorToolId[] = ['note', 'freetext', 'stamp', 'image', 'signature', 'link'];
const RULED_STICKY: EditorToolId[] = [
  'ink',
  'highlight',
  'underline',
  'strike',
  'square',
  'circle',
  'line',
  'arrow',
  'polyline',
];

describe('afterCreate policy', () => {
  it('declares the ruled one-shot and sticky tools, and nothing else is one-shot', () => {
    for (const tool of RULED_ONESHOT) expect(TOOL_BY_ID[tool].afterCreate).toBe('default');
    for (const tool of RULED_STICKY) expect(TOOL_BY_ID[tool].afterCreate).toBe('stay');
    expect(TOOLS.filter((meta) => isPlacementTool(meta.id) && meta.afterCreate === 'default').map((m) => m.id).sort())
      .toEqual([...RULED_ONESHOT].sort());
  });

  it('Select is the resting tool and is never itself a placement tool', () => {
    expect(isPlacementTool('select')).toBe(false);
    expect(TOOL_BY_ID.select.gesture).toBe('none');
    expect(effectiveAfterCreate('select', true)).toBe('stay');
  });

  it('gives every placement tool a pin, and seeds the pin from the declared default', () => {
    const pins = defaultPinState();
    for (const meta of TOOLS) {
      if (!isPlacementTool(meta.id)) continue;
      expect(pins[meta.id]).toBe(meta.afterCreate === 'stay');
    }
    // Select carries no pin state, so Esc can never "unpin" the cursor.
    expect(pins.select ?? false).toBe(false);
  });

  it('lets the pin override the default in both directions', () => {
    // Pinned text box keeps placing; unpinned pen hands control back.
    expect(effectiveAfterCreate('freetext', true)).toBe('stay');
    expect(effectiveAfterCreate('freetext', undefined)).toBe('default');
    expect(effectiveAfterCreate('ink', false)).toBe('default');
    expect(effectiveAfterCreate('highlight', true)).toBe('stay');
  });

  it('says on the button what the next click will do', () => {
    expect(pinLabel('freetext', false)).toMatch(/returns to Select after one placement/);
    expect(pinLabel('freetext', true)).toMatch(/stays armed after each placement/);
    expect(pinLabel('highlight', false)).toMatch(/Highlight/);
  });
});

/* ------------------------------------------------------------------ *
 * 2. Escape unwinds exactly one level                                 *
 * ------------------------------------------------------------------ */

describe('the Escape ladder', () => {
  it('takes the deepest level only, in the ruled order', () => {
    const full = { editing: true, selected: true, pinned: true, armed: true };
    expect(nextEscapeLevel(full)).toBe('dismiss');
    expect(nextEscapeLevel({ ...full, editing: false })).toBe('selection');
    expect(nextEscapeLevel({ ...full, editing: false, selected: false })).toBe('unpin');
    expect(nextEscapeLevel({ ...full, editing: false, selected: false, pinned: false })).toBe('disarm');
    expect(
      nextEscapeLevel({ editing: false, selected: false, pinned: false, armed: false }),
    ).toBe('none');
  });

  it('never claims to have done something it did not', () => {
    expect(escapeLevelNotice('none')).toBe('');
    expect(escapeLevelNotice('unpin')).toMatch(/Unpinned/);
    expect(escapeLevelNotice('disarm')).toMatch(/Select is armed/);
    for (const level of ['dismiss', 'selection', 'unpin', 'disarm'] as const) {
      expect(escapeLevelNotice(level).length).toBeGreaterThan(0);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 3. Keyboard reachability of the pointer-only actions                *
 * ------------------------------------------------------------------ */

describe('selection keyboard', () => {
  it('nudges 1 px, or 10 px with Shift, in the pressed direction', () => {
    expect(nudgeStep('ArrowLeft', false)).toEqual({ dx: -NUDGE_PX, dy: 0 });
    expect(nudgeStep('ArrowDown', true)).toEqual({ dx: 0, dy: NUDGE_COARSE_PX });
    expect(NUDGE_COARSE_PX).toBe(10);
    expect(nudgeStep('Enter', true)).toBeNull();
  });

  it('binds Cmd/Ctrl-D and refuses the modifier combinations it does not own', () => {
    expect(isDuplicateKey('d', { ctrl: true })).toBe(true);
    expect(isDuplicateKey('D', { meta: true })).toBe(true);
    expect(isDuplicateKey('d', {})).toBe(false);
    expect(isDuplicateKey('d', { ctrl: true, shift: true })).toBe(false);
  });

  it('gives the typed character to a selected text mark, not to the tool arm', () => {
    expect(isTypeToEditKey('p', {})).toBe(true);
    expect(isTypeToEditKey(' ', {})).toBe(false);
    expect(isTypeToEditKey('p', { meta: true })).toBe(false);
    expect(isTypeToEditKey('Enter', {})).toBe(false);
  });

  it('documents the keyboard route to every pointer-only action on the selection', () => {
    const printed = EDITOR_SHORTCUTS.map((row) => row.keys.join('+'));
    for (const wanted of ['Esc', 'Delete', 'Ctrl+D', '←+→+↑+↓', 'Alt+←', 'Type']) {
      expect(printed, `the shortcut list must document ${wanted}`).toContain(wanted);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 4. A markup drag is text, not a rectangle                           *
 * ------------------------------------------------------------------ */

describe('highlight geometry', () => {
  it('snaps a drag to the real line boxes it crosses, one quad per line', () => {
    const lines = snapTextLines(threeLines(), { x0: 60, y0: 95, x1: 210, y1: 155 });
    expect(lines.map((line) => line.text)).toEqual([
      'Callout text here',
      'second line of copy',
      'third line',
    ]);
    const highlight = build('highlight', {
      drag: { x: 60, y: 95, width: 150, height: 60 },
      lines,
    })!;
    // One annotation carrying three quads — not three annotations, not one box.
    expect(highlight.quadPoints).toHaveLength(24);
    expect(highlight.quadPoints).toBeDefined();
    expect(highlight.kind).toBe('Highlight');
  });

  it('covers the words and not the leading between the lines', () => {
    const lines = snapTextLines(threeLines(), { x0: 60, y0: 95, x1: 210, y1: 155 });
    expect(lines[0].y0).toBe(100);
    expect(lines[0].y1).toBe(111);
    expect(lines[1].y0).toBe(120);
    // The gap between two lines belongs to neither mark.
    expect(lines[0].y1).toBeLessThan(lines[1].y0);
  });

  it('spans a middle line end to end while the first and last stop at the drag', () => {
    // A narrow band that clips all three lines vertically: the middle line is
    // still fully covered, which is what a text selection does.
    const lines = snapTextLines(threeLines(), { x0: 120, y0: 98, x1: 130, y1: 152 });
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatchObject({ x0: 70, x1: 196 });
    expect(lines[0].x0).toBeGreaterThan(70);
    expect(lines[2].x1).toBeLessThan(196);
  });

  it('underline and strike share the path and the quads', () => {
    const lines = snapTextLines(threeLines(), { x0: 60, y0: 95, x1: 210, y1: 155 });
    const drag = { x: 60, y: 95, width: 150, height: 60 };
    const underline = build('underline', { drag, lines })!;
    const strike = build('strike', { drag, lines })!;
    expect(underline.quadPoints).toEqual(strike.quadPoints);
    expect(underline.quadPoints).toHaveLength(24);
    expect(underline.kind).toBe('Underline');
    expect(strike.kind).toBe('StrikeOut');
  });

  it('builds nothing when the drag touches no words', () => {
    const miss = snapTextLines(threeLines(), { x0: 400, y0: 400, x1: 480, y1: 430 });
    expect(miss).toEqual([]);
    expect(build('highlight', { drag: { x: 400, y: 400, width: 80, height: 30 }, lines: miss })).toBeNull();
  });

  it('reports the text it covers so the layer list can name the mark', () => {
    const lines = snapTextLines(threeLines(), { x0: 60, y0: 95, x1: 210, y1: 155 });
    const highlight = build('highlight', { drag: { x: 60, y: 95, width: 150, height: 60 }, lines })!;
    expect(highlight.snapText).toBe('Callout text here second line of copy third line');
    // /Rect bounds every quad, and is not itself the shape that is painted.
    expect(highlight.rect.y + highlight.rect.height).toBeCloseTo(PAGE_H - 100, 0);
  });
});

/* ------------------------------------------------------------------ *
 * 5. Clicking an existing mark selects it                             *
 * ------------------------------------------------------------------ */

describe('hit-testing a markup mark', () => {
  const lines = snapTextLines(threeLines(), { x0: 60, y0: 95, x1: 210, y1: 155 });
  const highlight = build('highlight', { drag: { x: 60, y: 95, width: 150, height: 60 }, lines })!;
  const square = build('square', { drag: { x: 60, y: 95, width: 150, height: 60 } })!;

  it('finds the mark under a point that sits on one of its lines', () => {
    const onLine = screenToPdfPoint({ x: 80, y: 105 }, flat);
    expect(markAtPoint([highlight, square], 0, onLine)?.id).toBe(highlight.id);
  });

  it('ignores the leading between lines and non-markup marks', () => {
    const inGap = screenToPdfPoint({ x: 80, y: 115 }, flat);
    expect(markAtPoint([highlight], 0, inGap)).toBeNull();
    expect(markAtPoint([square], 0, screenToPdfPoint({ x: 80, y: 105 }, flat))).toBeNull();
  });

  it('prefers the most recently created mark, which is the one on top', () => {
    const later: EditorAnnotation = {
      ...highlight,
      id: 'later',
      quadPoints: highlight.quadPoints?.slice(),
      rect: { ...highlight.rect },
    };
    const point = screenToPdfPoint({ x: 80, y: 105 }, flat);
    expect(markAtPoint([highlight, later], 0, point)?.id).toBe('later');
  });

  it('stays on its own page', () => {
    const point = screenToPdfPoint({ x: 80, y: 105 }, flat);
    expect(markAtPoint([{ ...highlight, page: 1 }], 0, point)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 6. Handles, nudge and duplicate geometry                            *
 * ------------------------------------------------------------------ */

describe('editing the selection', () => {
  const lines = snapTextLines(threeLines(), { x0: 60, y0: 95, x1: 210, y1: 155 });
  const highlight = build('highlight', { drag: { x: 60, y: 95, width: 150, height: 60 }, lines })!;

  it('resizes from a corner without splitting the mark back into rectangles', () => {
    const grown = resizeAnnotation(highlight, 'se', 20, -10);
    expect(grown.quadPoints).toHaveLength(highlight.quadPoints!.length);
    expect(grown.rect.width).toBeCloseTo(highlight.rect.width + 20, 0);
    expect(grown.rect.x).toBeCloseTo(highlight.rect.x, 0);
    // Still one quad per line, each scaled with the box instead of being
    // replaced by the box: the west edge is the anchor for a `se` drag.
    expect(grown.quadPoints!.slice(2, 4)[0]).toBeCloseTo(
      grown.rect.x + grown.rect.width * ((highlight.quadPoints![2] - highlight.rect.x) / highlight.rect.width),
      1,
    );
    expect(grown.quadPoints![0]).toBeCloseTo(highlight.quadPoints![0], 1);
    expect(grown.rect.height).toBeCloseTo(highlight.rect.height + 10, 0);
  });

  it('keeps a minimum size so a corner cannot cross its opposite', () => {
    const tiny = resizeAnnotation(highlight, 'se', -500, -500);
    expect(tiny.rect.width).toBeGreaterThanOrEqual(1);
    expect(tiny.rect.height).toBeGreaterThanOrEqual(1);
  });

  it('drags the endpoints of a line with the box', () => {
    const arrow = build('arrow', { points: [{ x: 60, y: 100 }, { x: 200, y: 160 }] })!;
    const grown = resizeAnnotation(arrow, 'se', 40, 0);
    expect(grown.lineEnds).toHaveLength(4);
    expect(grown.lineEnds![2]).toBeGreaterThan(arrow.lineEnds![2]);
  });

  it('names a direction-correct cursor for every handle', () => {
    expect(RESIZE_HANDLES).toEqual(['nw', 'ne', 'sw', 'se']);
    expect(handleCursor('nw')).toBe('nwse-resize');
    expect(handleCursor('ne')).toBe('nesw-resize');
    expect(handleCursor('sw')).toBe('nesw-resize');
    expect(handleCursor('se')).toBe('nwse-resize');
  });

  it('duplicates into a distinct object the user can see is distinct', () => {
    const copy = duplicateAnnotation(highlight);
    expect(copy.id).not.toBe(highlight.id);
    expect(copy.rect.x).toBeCloseTo(highlight.rect.x + 10, 0);
    expect(copy.quadPoints).toHaveLength(highlight.quadPoints!.length);
    expect(copy.quadPoints).not.toEqual(highlight.quadPoints);
  });
});

/* ------------------------------------------------------------------ *
 * 7. Undo and redo are reportable                                     *
 * ------------------------------------------------------------------ */

describe('history reporting', () => {
  it('says when there was nothing to take back', () => {
    expect(historyNotice({ action: 'undo', changed: false })).toMatch(/Nothing left to undo/);
    expect(historyNotice({ action: 'redo', changed: false })).toMatch(/Nothing to redo/);
  });

  it('reports the step it actually took, with the resulting mark count', () => {
    let work = createWork();
    const square = build('square', { drag: { x: 10, y: 10, width: 60, height: 40 } })!;
    const note = build('note', { drag: { x: 90, y: 90, width: 20, height: 20 }, text: 'check' })!;
    work = { ...work, history: pushHistory(pushHistory(work.history, [square]), [...[square], note]) };

    const undone = applyWorkStep(work, 'undo');
    expect(undone.work?.history.present).toHaveLength(1);
    expect(undone.notice).toMatch(/Undid the last change · 1 mark/);

    const redone = applyWorkStep(undone.work, 'redo');
    expect(redone.work?.history.present).toHaveLength(2);
    expect(redone.notice).toMatch(/Redid the last change · 2 marks/);

    const fresh = applyWorkStep(createWork(), 'undo');
    expect(fresh.notice).toMatch(/Nothing left to undo/);
    // A refused step leaves the stack exactly where it was, so the notice cannot
    // claim a change that did not happen.
    expect(fresh.work?.history.present).toHaveLength(0);
    expect(applyWorkStep(null, 'undo')).toEqual({ work: null, notice: null });
  });
});

/* ------------------------------------------------------------------ *
 * 8. The palette DOM: toolbar, pins, live region, focus               *
 * ------------------------------------------------------------------ */

describe('annotation palette DOM', () => {
  it('exposes the ruled stickiness through aria-pressed on a pin per tool', () => {
    render(createElement(AnnotationEditor));
    const boxes = (tool: EditorToolId) =>
      Array.from(document.querySelectorAll(`button[data-tool-pin="${tool}"]`)) as HTMLButtonElement[];
    // Every placement tool has exactly one pin; Select has none.
    for (const meta of TOOLS) {
      expect(boxes(meta.id)).toHaveLength(isPlacementTool(meta.id) ? 1 : 0);
    }
    expect(boxes('freetext')[0].getAttribute('aria-pressed')).toBe('false');
    expect(boxes('highlight')[0].getAttribute('aria-pressed')).toBe('true');
    expect(boxes('ink')[0].getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps the pin state when another object or tool takes the focus', () => {
    render(createElement(AnnotationEditor));
    const pin = document.querySelector('button[data-tool-pin="freetext"]') as HTMLButtonElement;
    fireEvent.click(pin);
    expect(pin.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(document.querySelector('button[data-tool="highlight"]') as HTMLButtonElement);
    expect((document.querySelector('[data-editor-palette]') as HTMLElement).dataset.armedTool).toBe('highlight');
    const still = document.querySelector('button[data-tool-pin="freetext"]') as HTMLButtonElement;
    expect(still.getAttribute('aria-pressed')).toBe('true');
  });

  it('announces the armed tool, its pin state and every history step through one live region', () => {
    render(createElement(AnnotationEditor));
    // Select is the resting tool, so nothing is armed and no pin applies yet.
    expect((document.querySelector('[data-editor-palette]') as HTMLElement).dataset.armedTool).toBe('select');
    fireEvent.click(document.querySelector('button[data-tool="freetext"]') as HTMLButtonElement);
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.getAttribute('aria-atomic')).toBe('true');
    expect(status.textContent).toMatch(/Text box.*returns to Select after one placement/s);
    // Flipping the pin is a state change, so the live region says so.
    fireEvent.click(document.querySelector('button[data-tool-pin="freetext"]') as HTMLButtonElement);
    expect(screen.getByRole('status').textContent).toMatch(/Text box: stays armed after each placement/);
    // Undo with no document open must not invent a change; the hint stays.
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(screen.getByRole('status').textContent).not.toMatch(/Undid|Redid/);
  });

  it('marks the palette and the page controls as toolbars, and gives every tool an aria-pressed', () => {
    render(createElement(AnnotationEditor));
    const toolbars = screen.getAllByRole('toolbar');
    expect(toolbars.length).toBeGreaterThanOrEqual(2);
    for (const meta of TOOLS) {
      const button = document.querySelector(`button[data-tool="${meta.id}"]`) as HTMLButtonElement;
      expect(button.getAttribute('aria-pressed')).toBe(String(meta.id === 'select'));
      expect(button.className).toMatch(/focus-visible:ring-2/);
    }
  });

  it('reaches a pin from the keyboard as a real button', () => {
    render(createElement(AnnotationEditor));
    const pin = document.querySelector('button[data-tool-pin="stamp"]') as HTMLButtonElement;
    expect(pin.getAttribute('aria-label')).toMatch(/returns to Select/);
    fireEvent.click(pin);
    expect(pin.getAttribute('aria-pressed')).toBe('true');
    expect(pin.getAttribute('aria-label')).toMatch(/stays armed/);
    expect(screen.getByRole('status').textContent).toMatch(/Stamp: stays armed/);
  });
});

/* ------------------------------------------------------------------ *
 * 9. The old palette expectations still hold next to the pins         *
 * ------------------------------------------------------------------ */

describe('palette regression guards', () => {
  it('unwinds the armed sticky tool one level per Escape, through the DOM', () => {
    render(createElement(AnnotationEditor));
    fireEvent.keyDown(window, { key: 'h' });
    const toolButton = () => document.querySelector('[data-tool="highlight"]') as HTMLButtonElement;
    const pinButton = () => document.querySelector('button[data-tool-pin="highlight"]') as HTMLButtonElement;
    expect(toolButton().getAttribute('aria-pressed')).toBe('true');
    expect(pinButton().getAttribute('aria-pressed')).toBe('true');

    // Pinning is not arming: a pin click changes the policy, never the tool.
    fireEvent.click(document.querySelector('button[data-tool-pin="freetext"]') as HTMLButtonElement);
    expect((document.querySelector('[data-editor-palette]') as HTMLElement).dataset.armedTool).toBe('highlight');

    // 1. unpin  2. disarm  3. nothing left, and no claim that something happened.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(pinButton().getAttribute('aria-pressed')).toBe('false');
    expect(toolButton().getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('status').textContent).toMatch(/Unpinned the tool/);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect((document.querySelector('[data-editor-palette]') as HTMLElement).dataset.armedTool).toBe('select');
    expect(screen.getByRole('status').textContent).toMatch(/Put the tool down/);

    const statusAfter = screen.getByRole('status').textContent;
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('status').textContent).toBe(statusAfter);
  });

  it('still lists the shortcut table it implements, with the new keys in it', () => {
    render(createElement(AnnotationEditor));
    const section = document.querySelector('[data-inspector-section="keys"]') as HTMLElement;
    expect(within(section).getByText('Arm the pen')).toBeTruthy();
    expect(within(section).getByText('Remove the selected mark')).toBeTruthy();
    expect(within(section).getByText(/Nudge the selected mark 1 px/)).toBeTruthy();
    expect(within(section).getByText(/Duplicate the selected mark/)).toBeTruthy();
    expect(section.querySelectorAll('kbd').length).toBeGreaterThanOrEqual(
      EDITOR_SHORTCUTS.reduce((total, row) => total + row.keys.length, 0),
    );
  });
});
