/**
 * M1 — the annotation editor's interaction model (docs/UX-BRIEF.md).
 *
 * jsdom has no canvas, so this file never looks at pixels. It checks the three
 * things the brief rules on, all of which are pure state, geometry or DOM:
 *
 * 1. One rule after a gesture, for every tool and with no pin to set: a created
 *    mark hands control back to Select, a gesture that made nothing does not —
 *    and Escape unwinds exactly one level.
 * 2. A markup drag becomes text geometry — one annotation, one quad per real line
 *    box — never a rectangle; a drag over no words builds nothing; a click on an
 *    existing mark resolves to that mark. A quad is painted as a ring and stroked
 *    by the shared markup rule, so the mark on screen is the mark in the file.
 * 3. The palette and overlay DOM carry the rest of the contract: `role="toolbar"`,
 *    `aria-pressed` on tools, a permanent live region, a focus ring on every
 *    control the pointer can reach, and exactly one boundary on a mark — edit
 *    chrome while it is being typed into, selection chrome when it is only picked.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ExtractedTextItem } from '@/lib/pdf/core/render';
import {
  AFTER_CREATE_NOTE,
  TOOLS,
  TOOL_BY_ID,
  isPlacementTool,
  toolAfterGesture,
} from '@/components/tools/pdf/editor/tools';
import {
  EDITOR_SHORTCUTS,
  ESCAPE_LEVELS,
  NUDGE_COARSE_PX,
  NUDGE_PX,
  escapeLevelNotice,
  goesToTheCaret,
  isDuplicateKey,
  isSelectAllKey,
  isTypeToEditKey,
  nextEscapeLevel,
  nudgeStep,
  rotationStepForKey,
} from '@/components/tools/pdf/editor/shortcuts';
import { snapTextLines } from '@/components/tools/pdf/editor/quads';
import {
  FREE_TEXT_LINE_EM,
  LINK_BORDER_DASH,
  LINK_WASH_ALPHA,
  TEXT_BASELINE_SHARE,
  freeTextInset,
  hexToRgb01,
  markupRule,
} from '@/lib/pdf/core/annotations';
import { AnnotationOverlay } from '@/components/tools/pdf/editor/AnnotationOverlay';
import {
  RESIZE_HANDLES,
  annotationRotation,
  annotationToSpec,
  buildAnnotation,
  canRotate,
  carriedAngle,
  duplicateAnnotation,
  duplicateMarks,
  dragGesturePayload,
  handleCursor,
  markAtPoint,
  markBounds,
  marksInMarquee,
  moveMarks,
  noteCardBox,
  pageSelection,
  removeMarks,
  resizeAnnotation,
  selectedMarks,
  selectionBounds,
  selectionSummary,
  setAnnotationRotation,
  setMarksRotation,
  styleMarks,
  turnMarks,
  withText,
  workSignature,
  HANDLE_HIT_PX,
} from '@/components/tools/pdf/editor/specs';
import {
  pdfToScreenPoint,
  pdfToScreenRect,
  rotationForDrag,
  screenToPdfPoint,
  type PageGeom,
} from '@/components/tools/pdf/editor/geometry';
import {
  addToSelection,
  applyWorkStep,
  createWork,
  deleteNotice,
  historyNotice,
  marqueeNotice,
  pruneSelection,
  rotationRefusedNotice,
  selectAllNotice,
  selectionNotice,
  selectOnly,
  sharedStyleNotice,
  toggleSelected,
  transferSelectionToPage,
} from '@/components/tools/pdf/editor/workspace';
import {
  createHistory,
  liveHistory,
  pushHistory,
  settleHistory,
  undoHistory,
} from '@/components/tools/pdf/editor/history';
import AnnotationEditor from '@/components/tools/pdf/editor/AnnotationEditor';
import type { EditorAnnotation, EditorToolId, PlacedRaster, ToolStyle } from '@/components/tools/pdf/editor/types';
import { defaultStyleFor } from '@/components/tools/pdf/editor/tools';
import { fakeJpeg, inkOfSpecs } from './appearance-harness';

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

/**
 * A row that carries two runs on one baseline with a column of empty paper
 * between them — the shape of the CV's header row that broke the markup.
 */
function nameAndDate(): ExtractedTextItem[] {
  return [
    word('Ada Lovelace', 50, 111, 90, 10),
    word('Submitted 18 May 2026', 400, 111, 130, 10),
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
 * 1. One rule after a gesture, for every tool, with nothing to pin    *
 * ------------------------------------------------------------------ */

/** Every tool that puts something on the page. `select` is the resting tool. */
const PLACEMENT_TOOLS: EditorToolId[] = TOOLS.filter((meta) => isPlacementTool(meta.id)).map((m) => m.id);

const CREATED_TOOLS: EditorToolId[] = [
  'highlight',
  'underline',
  'strike',
  'ink',
  'square',
  'circle',
  'line',
  'arrow',
  'polygon',
  'polyline',
  'note',
  'freetext',
  'stamp',
  'image',
  'signature',
  'link',
  'redact',
];

describe('the rule after a gesture', () => {
  it('covers every tool that can create, and there are no exceptions left over', () => {
    expect(PLACEMENT_TOOLS.slice().sort()).toEqual([...CREATED_TOOLS].sort());
    expect(isPlacementTool('select')).toBe(false);
    expect(TOOL_BY_ID.select.gesture).toBe('none');
  });

  it('hands control back to Select after a create, for every tool alike', () => {
    // The tools that used to be sticky by ruling — pen, highlight, underline,
    // strike, the shapes, redact — step aside now exactly like the one-shot ones.
    for (const tool of CREATED_TOOLS) expect(toolAfterGesture(tool, true)).toBe('select');
  });

  it('leaves the tool in the hand when the gesture created nothing', () => {
    for (const tool of CREATED_TOOLS) expect(toolAfterGesture(tool, false)).toBe(tool);
    // A drag that caught no words builds no mark, so it cannot move the user off
    // the tool they armed: this is the pair of assertions that keeps that true.
    const miss = snapTextLines(threeLines(), { x0: 400, y0: 400, x1: 480, y1: 430 });
    const built = build('highlight', { drag: { x: 400, y: 400, width: 80, height: 30 }, lines: miss });
    expect(built).toBeNull();
    expect(toolAfterGesture('highlight', built !== null)).toBe('highlight');
    const real = build('highlight', {
      drag: { x: 60, y: 95, width: 150, height: 60 },
      lines: snapTextLines(threeLines(), { x0: 60, y0: 95, x1: 210, y1: 155 }),
    });
    expect(real).not.toBeNull();
    expect(toolAfterGesture('highlight', real !== null)).toBe('select');
  });

  it('says the rule once, in the palette, instead of per-tool pin affordances', () => {
    expect(AFTER_CREATE_NOTE).toMatch(/hands control back to Select/);
    render(createElement(AnnotationEditor));
    const explained = document.querySelector('[data-after-create-explained]');
    expect(explained?.textContent).toMatch(/hands control back to Select/);
    // The pin is gone: no button, no lock glyph anywhere in the palette.
    expect(document.querySelector('button[data-tool-pin]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/\u{1F512}|\u{1F513}/u);
  });
});

/* ------------------------------------------------------------------ *
 * 2. Escape unwinds exactly one level                                 *
 * ------------------------------------------------------------------ */

describe('the Escape ladder', () => {
  it('takes the deepest level only, in the ruled order', () => {
    const full = { editing: true, selected: true, armed: true };
    expect(nextEscapeLevel(full)).toBe('dismiss');
    expect(nextEscapeLevel({ ...full, editing: false })).toBe('selection');
    expect(nextEscapeLevel({ ...full, editing: false, selected: false })).toBe('disarm');
    expect(nextEscapeLevel({ editing: false, selected: false, armed: false })).toBe('none');
  });

  it('has no pin rung left to unwind', () => {
    // The ladder used to be four levels deep and the third one existed only to
    // undo a lock the palette no longer offers.
    expect(ESCAPE_LEVELS).toEqual(['dismiss', 'selection', 'disarm']);
    expect(nextEscapeLevel({ editing: false, selected: false, armed: true })).toBe('disarm');
  });

  it('never claims to have done something it did not', () => {
    expect(escapeLevelNotice('none')).toBe('');
    expect(escapeLevelNotice('disarm')).toMatch(/Select is armed/);
    for (const level of ['dismiss', 'selection', 'disarm'] as const) {
      expect(escapeLevelNotice(level).length).toBeGreaterThan(0);
    }
  });

  it('documents the ladder it walks, in the shortcut list too', () => {
    const row = EDITOR_SHORTCUTS.find((shortcut) => shortcut.keys.includes('Esc'));
    expect(row?.label).toMatch(/half-drawn mark.*selection.*tool/s);
    expect(row?.label).not.toMatch(/pin/i);
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

  it('gives `R` to the caret only in the mark the caret is inside', () => {
    // The collision, resolved out loud: `r` is both a letter and the turn key.
    // A mark that is merely selected has no caret to feed, so `R` belongs to the
    // keyboard; the mark being typed into owns every letter the user presses.
    expect(goesToTheCaret('r', {}, false)).toBe(false);
    expect(goesToTheCaret('R', { shift: true }, false)).toBe(false);
    expect(goesToTheCaret('r', {}, true)).toBe(true);
    expect(goesToTheCaret('R', { shift: true }, true)).toBe(true);
    // Any other letter still starts the edit, so type-to-edit keeps working.
    expect(goesToTheCaret('p', {}, false)).toBe(true);
    // And a key that is neither — a modifier combo, a space — belongs to neither.
    expect(goesToTheCaret('r', { ctrl: true }, true)).toBe(false);
    expect(goesToTheCaret(' ', {}, true)).toBe(false);
    // Both directions, at the model the handler drives.
    const box = build('freetext', { drag: { x: 80, y: 300, width: 200, height: 40 }, text: 'already' })!;
    // 1. selected, not editing: `r` is the command, and it turns the mark.
    const selected = ['r', 'e', 'd'].filter((key) => goesToTheCaret(key, {}, false));
    expect(selected).toEqual(['e', 'd']);
    const turned = turnMarks([box], [box.id], rotationStepForKey('r', {})!);
    expect(annotationRotation(turned[0])).toBe(90);
    expect(turned[0].text).toBe('already');
    // 2. typing "red" into the caret: three letters, no turn.
    let typing = box;
    for (const key of 'red') {
      expect(goesToTheCaret(key, {}, true)).toBe(true);
      typing = withText(typing, (typing.text ?? '') + key);
    }
    expect(typing.text).toBe('alreadyred');
    expect(annotationRotation(typing)).toBe(0);
  });

  it('documents the keyboard route to every pointer-only action on the selection', () => {
    const printed = EDITOR_SHORTCUTS.map((row) => row.keys.join('+'));
    for (const wanted of ['Esc', 'Delete', 'Ctrl+D', '←+→+↑+↓', 'Alt+←', 'Type']) {
      expect(printed, `the shortcut list must document ${wanted}`).toContain(wanted);
    }
    // And says which side `R` is on, because the list is the only place a user
    // can read it from inside the surface.
    const turn = EDITOR_SHORTCUTS.find((row) => row.keys.includes('R'))!;
    expect(turn.label).toMatch(/typing/i);
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
    // Each line reports its box as 11 pt standing on a baseline 11 pt below the
    // top of that box, and the mark re-anchors the same 11 pt so 0.8 of it is
    // above the baseline: the top comes down off the leading, the bottom reaches
    // past the feet of the letters to hold the descenders.
    expect(lines[0].y0).toBeCloseTo(111 - TEXT_BASELINE_SHARE * 11, 6);
    expect(lines[0].y1).toBeCloseTo(111 + (1 - TEXT_BASELINE_SHARE) * 11, 6);
    expect(lines[1].y0).toBeCloseTo(131 - TEXT_BASELINE_SHARE * 11, 6);
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
    expect(highlight.rect.y + highlight.rect.height).toBeCloseTo(PAGE_H - (111 - TEXT_BASELINE_SHARE * 11), 1);
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
 * 7. The selection is a set                                          *
 * ------------------------------------------------------------------ *
 *
 * Multi-select is a property of the model, not of a click handler: every
 * command the editor offers runs over `selection: string[]`, so "one drag is one
 * undo step for the whole set" and "a style change hits every mark" are testable
 * here, without a canvas.
 */

/** Three squares on page 1 and one on page 2, in creation order. */
function markList(): EditorAnnotation[] {
  const at = (x: number, page = 0) => build('square', { page, drag: { x, y: 100, width: 40, height: 24 } })!;
  return [at(40), at(120), at(200), at(40, 1)];
}

const group = (marks: EditorAnnotation[], count = 3) => marks.slice(0, count).map((m) => m.id);

describe('the selection is a set', () => {
  it('Shift+click adds a mark and takes it back out, oldest first', () => {
    const [a, b, c] = group(markList());
    expect(selectOnly(a)).toEqual([a]);
    expect(selectOnly(null)).toEqual([]);
    expect(toggleSelected([], a)).toEqual([a]);
    expect(toggleSelected([a], b)).toEqual([a, b]);
    expect(toggleSelected([a, b], a)).toEqual([b]);
    expect(addToSelection([a], [b, c, a])).toEqual([a, b, c]);
  });

  it('announces that the target of the keyboard changed, and drops ids that died', () => {
    const marks = markList();
    const [a, b] = group(marks);
    expect(selectionNotice(0, 0)).toBe('Cleared the selection.');
    expect(selectionNotice(1, 0, [marks[0]])).toBe('Selected the square on page 1.');
    expect(selectionNotice(3, 0)).toContain('commands now act on the set');
    // A stale id, and another page's mark, both fail to survive a prune.
    expect(pruneSelection([a, b, 'gone'], marks, 0)).toEqual([a, b]);
    expect(pruneSelection([a, marks[3].id], marks, 1)).toEqual([marks[3].id]);
    const moved = transferSelectionToPage([a, b], 0, 1);
    expect(moved.selection).toEqual([]);
    expect(moved.notice).toContain('page 1');
    expect(transferSelectionToPage([a], 0, 0)).toEqual({ selection: [a], notice: null });
  });

  it('moves the whole set as one drag and settles as ONE undo step', () => {
    const marks = markList();
    const ids = group(marks);
    // A drag paints `present` live and records the pre-drag list once on release.
    let live = createHistory(marks);
    for (const step of [2, 5, 9, 14]) live = liveHistory(live, moveMarks(marks, ids, step, 0));
    expect(live.past).toHaveLength(0);
    const settled = settleHistory(live, marks);
    expect(settled.past).toHaveLength(1);
    const moved = selectedMarks(settled.present, ids);
    expect(moved.map((m) => m.rect.x)).toEqual([54, 134, 214]);
    // The unselected mark on the other page was never a target.
    expect(settled.present[3].rect.x).toBe(marks[3].rect.x);
    expect(undoHistory(settled).present).toEqual(marks);
  });

  it('removes the whole selection as one edit, so one undo brings them all back', () => {
    const marks = markList();
    const history = pushHistory(createHistory(marks), removeMarks(marks, group(marks)));
    expect(history.present).toHaveLength(1);
    expect(history.present[0].page).toBe(1);
    expect(undoHistory(history).present).toHaveLength(4);
    expect(deleteNotice(3)).toContain('one undo');
    expect(deleteNotice(1)).toBe('Removed the selected mark.');
  });

  it('applies one style change to every mark in the set, and to nothing else', () => {
    const marks = markList();
    const ids = group(marks);
    const alt = defaultStyleFor('ink').color;
    const styled = styleMarks(marks, ids, { color: alt, opacity: 0.25, strokeWidth: 4 });
    expect(styled.slice(0, 3).every((m) => m.color === alt)).toBe(true);
    expect(styled.slice(0, 3).every((m) => m.opacity === 0.25)).toBe(true);
    expect(styled.slice(0, 3).every((m) => m.borderWidth === 4)).toBe(true);
    expect(styled[3]).toEqual(marks[3]);
    expect(sharedStyleNotice(['color'], 3)).toContain('all 3 selected marks');
    expect(sharedStyleNotice(['color'], 1)).toBe('Set the colour of the selected mark.');
    // A redaction is burned in: a translucent burn would promise a visible page.
    const burn = build('redact', { drag: { x: 20, y: 20, width: 60, height: 12 } })!;
    expect(styleMarks([burn], [burn.id], { opacity: 0.2 })[0].opacity).toBe(burn.opacity);
  });

  it('says what a group is instead of inventing a value it does not share', () => {
    const marks = markList();
    const ids = group(marks);
    const mismatched = marks.map((m, i) => (i === 1 ? { ...m, borderWidth: m.borderWidth + 2 } : m));
    const summary = selectionSummary(mismatched, ids);
    expect(summary.count).toBe(3);
    expect(summary.pages).toEqual([0]);
    expect(summary.shared.color).toBe(mismatched[0].color);
    expect(summary.mixed).toContain('strokeWidth');
    expect(summary.text).toContain('3 marks selected on page 1');
    expect(selectionSummary(mismatched, []).text).toBe('Nothing selected.');
    expect(selectionSummary(mismatched, [marks[3].id]).pages).toEqual([1]);
  });

  it('duplicates the set as one edit and selects the copies', () => {
    const marks = markList();
    const ids = group(marks, 2);
    const { marks: copies, ids: copyIds } = duplicateMarks(marks, ids);
    expect(copies).toHaveLength(2);
    expect(new Set(copyIds).has(ids[0])).toBe(false);
    const history = pushHistory(createHistory(marks), [...marks, ...copies]);
    expect(history.present).toHaveLength(6);
    expect(undoHistory(history).present).toHaveLength(4);
  });

  it('Cmd/Ctrl+A takes this page only, and never another page\'s marks', () => {
    const marks = markList();
    expect(pageSelection(marks, 0)).toEqual(group(marks));
    expect(pageSelection(marks, 1)).toEqual([marks[3].id]);
    expect(pageSelection(marks, 7)).toEqual([]);
    expect(isSelectAllKey('a', { ctrl: true })).toBe(true);
    expect(isSelectAllKey('A', { meta: true })).toBe(true);
    expect(isSelectAllKey('a', { ctrl: true, alt: true })).toBe(false);
    expect(isSelectAllKey('a', {})).toBe(false);
    expect(selectAllNotice(0, 0)).toContain('no marks to select');
    expect(selectAllNotice(3, 0)).toContain('other pages keep their own');
  });

  it('a band drawn on empty paper takes the marks it touches, on its page only', () => {
    const marks = markList();
    // Screen space: the squares sit at x 40–80, 120–160, 200–240, y 100–124.
    expect(marksInMarquee(marks, 0, { x: 30, y: 90, width: 145, height: 45 }, flat)).toEqual([
      marks[0].id,
      marks[1].id,
    ]);
    expect(marksInMarquee(marks, 0, { x: 0, y: 0, width: PAGE_W, height: PAGE_H }, flat)).toHaveLength(3);
    expect(marksInMarquee(marks, 1, { x: 0, y: 0, width: PAGE_W, height: PAGE_H }, flat)).toEqual([marks[3].id]);
    expect(marqueeNotice(0, 0)).toContain('crossed no marks');
    expect(marqueeNotice(2, 0)).toContain('2 marks');
  });

  it('Escape takes the selection off as one level, counting what it dropped', () => {
    expect(nextEscapeLevel({ editing: false, selected: true, armed: true })).toBe('selection');
    expect(escapeLevelNotice('selection', 3)).toContain('3 selected marks');
    expect(escapeLevelNotice('selection')).toBe('Cleared the selection; the tool is still armed.');
    expect(escapeLevelNotice('selection', 1)).toBe('Cleared the selection; the tool is still armed.');
  });

  it('turns the set about the middle of the group, not each mark in its place', () => {
    const marks = markList().slice(0, 2);
    const ids = group(marks, 2);
    const before = selectionBounds(marks, ids)!;
    const turned = turnMarks(marks, ids, 90);
    expect(turned.every((m) => annotationRotation(m) === 90)).toBe(true);
    const after = selectionBounds(turned, ids)!;
    // The group's box swaps its extents: the set turned, not two separate marks.
    expect(after.width).toBeCloseTo(before.height, 3);
    expect(after.height).toBeCloseTo(before.width, 3);
    // Each mark kept its own drawn size and travelled along the arc instead.
    expect(turned[0].rect.width).toBe(marks[0].rect.width);
    expect(turned[0].rect.x).not.toBe(marks[0].rect.x);
    // One step back is one undo, however many marks swung.
    const history = pushHistory(createHistory(marks), turned);
    expect(undoHistory(history).present).toEqual(marks);
  });

  it('sets an absolute angle from the inspector and a right angle from R', () => {
    const marks = markList().slice(0, 2);
    const ids = group(marks, 2);
    expect(annotationRotation(marks[0])).toBe(0);
    expect(setMarksRotation(marks, ids, 45).every((m) => annotationRotation(m) === 45)).toBe(true);
    expect(setMarksRotation(marks, ids, -90).every((m) => annotationRotation(m) === 270)).toBe(true);
    expect(rotationStepForKey('r', {})).toBe(90);
    expect(rotationStepForKey('R', { shift: true })).toBe(-90);
    expect(rotationStepForKey('r', { ctrl: true })).toBe(null);
    expect(rotationForDrag(37)).toBe(30);
    expect(rotationForDrag(37, true)).toBe(37);
  });

  it('refuses to turn a link, because nothing about a link is drawn', () => {
    const link = build('link', { drag: { x: 70, y: 95, width: 100, height: 14 }, link: { type: 'goTo', page: 0 } })!;
    expect(canRotate(link)).toBe(false);
    expect(rotationRefusedNotice('Link')).toContain('cannot be turned');
    const drawn = [
      build('square', { drag: { x: 70, y: 95, width: 100, height: 14 } })!,
      build('freetext', { drag: { x: 70, y: 95, width: 100, height: 30 }, text: 'x' })!,
      build('ink', { points: [{ x: 60, y: 100 }, { x: 90, y: 130 }, { x: 120, y: 100 }] })!,
      build('line', { points: [{ x: 60, y: 100 }, { x: 160, y: 130 }] })!,
      build('redact', { drag: { x: 70, y: 95, width: 100, height: 14 } })!,
    ];
    expect(drawn).toHaveLength(5);
    expect(drawn.every(canRotate)).toBe(true);
  });

  it('refuses to turn a note, whose icon readers paint upright', () => {
    // The old expectation here was that a note turns like any other mark. It was
    // wrong in a way the file shows: a `/Text` annotation is a fixed-size marker
    // chosen by name (PDF 32000-1 §12.4.3) and `/Rotate` (§12.5.5) belongs to the
    // annotations whose geometry can turn, so a lean baked into our own stream is
    // a picture a viewer drawing its own icon will not repeat. The mark that was
    // tilted in the editor came out straight in Acrobat.
    const note = build('note', { drag: { x: 70, y: 95, width: 60, height: 20 }, text: 'x' })!;
    expect(note.kind).toBe('Text');
    expect(canRotate(note)).toBe(false);
    expect(rotationRefusedNotice('Note', 'Text')).toContain('cannot be turned');
    // So no route to an angle leaves one on it: the key, the inspector's field,
    // and the exported spec all agree with the upright picture.
    expect(annotationRotation(setAnnotationRotation(note, 90))).toBe(0);
    expect(annotationRotation(setMarksRotation([note], [note.id], 45)[0])).toBe(0);
    expect(carriedAngle({ ...note, rotation: 120 })).toBe(0);
    expect(annotationToSpec({ ...note, rotation: 120 }).rotation).toBeUndefined();
    // And the box it occupies is the icon's own box, not a bounding box grown
    // around a turn the file will not carry.
    expect(markBounds({ ...note, rotation: 120 })).toEqual(note.rect);
    expect(workSignature([note])).toBe(workSignature([{ ...note, rotation: 120 }]));
  });

  it('carries a note along a group turn without leaning it', () => {
    const square = build('square', { drag: { x: 40, y: 100, width: 40, height: 24 } })!;
    const note = build('note', { drag: { x: 200, y: 100, width: 40, height: 24 }, text: 'x' })!;
    const ids = [square.id, note.id];
    const turned = turnMarks([square, note], ids, 90);
    // The shape takes the angle and the note travels instead of taking one: the
    // pivot is the middle of the set, so the note's centre swings along the arc.
    expect(annotationRotation(turned[0])).toBe(90);
    expect(annotationRotation(turned[1])).toBe(0);
    expect(turned[1].rect.x).not.toBe(note.rect.x);
    expect(turned[1].rect.width).toBe(note.rect.width);
  });

  it('a turned mark really does occupy a bigger box, and counts as unsaved work', () => {
    const square = markList()[0];
    expect(markBounds(square)).toEqual(square.rect);
    const turned = markBounds({ ...square, rotation: 45 });
    expect(turned.width).toBeGreaterThan(square.rect.width);
    expect(turned.x).toBeLessThan(square.rect.x);
    expect(workSignature([square])).not.toBe(workSignature([{ ...square, rotation: 45 }]));
  });
});

/* ------------------------------------------------------------------ *
 * 8. Undo and redo are reportable                                     *
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
 * 9. The palette DOM: toolbar, live region, focus                     *
 * ------------------------------------------------------------------ */

describe('annotation palette DOM', () => {
  it('offers one control per tool and no pin anywhere', () => {
    render(createElement(AnnotationEditor));
    for (const meta of TOOLS) {
      expect(document.querySelectorAll(`button[data-tool="${meta.id}"]`)).toHaveLength(1);
    }
    expect(document.querySelectorAll('button[data-tool-pin]')).toHaveLength(0);
    // No lock glyph in the palette, and no per-tool sentence about stickiness.
    expect(document.querySelector('[data-editor-palette]')?.textContent).not.toMatch(/\u{1F512}|\u{1F513}/u);
    expect(document.querySelector('[data-editor-palette]')?.textContent).not.toMatch(/stays armed/i);
  });

  it('announces the armed tool and every history step through one live region', () => {
    render(createElement(AnnotationEditor));
    expect((document.querySelector('[data-editor-palette]') as HTMLElement).dataset.armedTool).toBe('select');
    fireEvent.click(document.querySelector('button[data-tool="freetext"]') as HTMLButtonElement);
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.getAttribute('aria-atomic')).toBe('true');
    // The footer states the one rule instead of a pin state, and it is the armed
    // tool's own hint that carries it.
    expect(status.textContent).toMatch(/Text box|type into it/);
    expect(status.textContent).toMatch(/hands control back to Select/);
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
});

/* ------------------------------------------------------------------ *
 * 10. The old palette expectations still hold without the pins         *
 * ------------------------------------------------------------------ */

describe('palette regression guards', () => {
  it('unwinds the armed tool one level per Escape, through the DOM', () => {
    render(createElement(AnnotationEditor));
    fireEvent.keyDown(window, { key: 'h' });
    const toolButton = () => document.querySelector('[data-tool="highlight"]') as HTMLButtonElement;
    const armedTool = () => (document.querySelector('[data-editor-palette]') as HTMLElement).dataset.armedTool;
    expect(toolButton().getAttribute('aria-pressed')).toBe('true');

    // 1. disarm  2. nothing left, and no claim that something happened. There is
    // no pin rung between them any more, so two presses reach the cursor.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(armedTool()).toBe('select');
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

/* ------------------------------------------------------------------ *
 * 11. What the overlay paints, and what it wears                      *
 * ------------------------------------------------------------------ *
 *
 * jsdom lays nothing out and draws no canvas, but it does keep the SVG
 * attributes the browser would paint from. That is enough to hold the two
 * claims that matter here: a quad is painted as a ring (the bowtie was a
 * painting-order bug, invisible to every model-level test), and a mark wears
 * one boundary at a time.
 */

const overlayGeom: PageGeom = { zoom: 2, cssWidth: PAGE_W * 2, cssHeight: PAGE_H * 2, rotation: 0 };

function renderOverlay(over: Partial<Parameters<typeof AnnotationOverlay>[0]> = {}) {
  const noop = () => {};
  return render(
    createElement(AnnotationOverlay, {
      geom: overlayGeom,
      annotations: [],
      draft: null,
      vertices: null,
      tool: 'select' as EditorToolId,
      selection: [],
      editingId: null,
      marquee: null,
      onSurfacePointerDown: noop,
      onAnnotationPointerDown: noop,
      onAnnotationDoubleClick: noop,
      onHandlePointerDown: noop,
      onRotatePointerDown: noop,
      onFinishVertices: noop,
      onTextDraft: noop,
      onTextCommit: noop,
      ...over,
    }),
  );
}

const markupMarks = () => {
  const lines = snapTextLines(threeLines(), { x0: 60, y0: 95, x1: 210, y1: 155 });
  const drag = { x: 60, y: 95, width: 150, height: 60 };
  return {
    highlight: build('highlight', { drag, lines })!,
    underline: build('underline', { drag, lines })!,
    strike: build('strike', { drag, lines })!,
  };
};

/** `<polygon points>` → the corners the browser will connect in order. */
function polygonCorners(element: SVGPolygonElement): { x: number; y: number }[] {
  return (element.getAttribute('points') ?? '')
    .trim()
    .split(/\s+/)
    .map((pair) => {
      const [x, y] = pair.split(',').map(Number);
      return { x, y };
    });
}

/** The corners of any painted ring: `<polygon points>` or a `<path d="M … L … Z">`. */
function shapeCorners(element: Element): { x: number; y: number }[] {
  const raw = element.tagName.toLowerCase() === 'polygon'
    ? (element.getAttribute('points') ?? '').replace(/\s+/g, ' ').trim()
    : (element.getAttribute('d') ?? '')
        .replace(/[MLZ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
  return raw
    .split(' ')
    .filter(Boolean)
    .map((pair) => {
      const [x, y] = pair.split(',').map(Number);
      return { x, y };
    });
}

/** Area of a closed ring (shoelace), the way the browser would fill it. */
function ringArea(corners: { x: number; y: number }[]): number {
  let twice = 0;
  for (let i = 0; i < corners.length; i += 1) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    twice += a.x * b.y - b.x * a.y;
  }
  return Math.abs(twice / 2);
}

/**
 * How much paper one painted overlay element covers, in CSS px².
 *
 * A filled ring is its own area; a stroked rule is length × stroke width, which
 * is the ink the stroke lays down. jsdom lays nothing out and draws no canvas,
 * so `line` and `path` carry the same information the browser paints from — the
 * coordinates and the stroke width.
 *
 * Measure the ink, never the element's box: `getBoundingClientRect()` of a
 * horizontal `<line>` is zero tall however thick the stroke, so a box-based
 * audit reads `area=0px` on an underline that plainly paints. That artifact cost
 * two rounds of "the markup is invisible" reports, one of them answered by
 * rebuilding the renderer for nothing.
 */
function elementPaintedArea(element: Element): number {
  const tag = element.tagName.toLowerCase();
  const stroke = Number(element.getAttribute('stroke-width') ?? 0);
  if (tag === 'line') {
    const from = { x: Number(element.getAttribute('x1')), y: Number(element.getAttribute('y1')) };
    const to = { x: Number(element.getAttribute('x2')), y: Number(element.getAttribute('y2')) };
    return Math.hypot(to.x - from.x, to.y - from.y) * Math.max(stroke, 0.5);
  }
  if (tag === 'polyline' || tag === 'path') {
    const filled = (element.getAttribute('fill') ?? 'none') !== 'none';
    const corners = shapeCorners(element);
    if (filled && corners.length >= 3) return ringArea(corners);
    let length = 0;
    const points = tag === 'polyline' ? polygonCorners(element as SVGPolylineElement) : corners;
    for (let i = 1; i < points.length; i += 1) {
      length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    }
    return length * Math.max(stroke, 0.5);
  }
  if (tag === 'rect' || tag === 'image') {
    return Number(element.getAttribute('width')) * Number(element.getAttribute('height'));
  }
  /**
   * An `<ellipse>` has no box of its own in the DOM either — its geometry is two
   * radii — and every circle the palette draws is one. Measure the paper it
   * covers: the enclosed area when it is filled, the ring around it when it is
   * stroked (Ramanujan's perimeter, which is within a percent of the true one at
   * any aspect a mouse can drag).
   */
  if (tag === 'ellipse' || tag === 'circle') {
    const rx = Number(element.getAttribute(tag === 'circle' ? 'r' : 'rx'));
    const ry = Number(tag === 'circle' ? element.getAttribute('r') : element.getAttribute('ry'));
    const filled = (element.getAttribute('fill') ?? 'none') !== 'none';
    if (filled) return Math.PI * rx * ry;
    const h = ((rx - ry) ** 2) / ((rx + ry) ** 2 || 1);
    return Math.PI * (rx + ry) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h))) * Math.max(stroke, 0.5);
  }
  const corners = shapeCorners(element);
  return corners.length >= 3 ? ringArea(corners) : 0;
}

/** The painted area of a whole mark: every element inside `[data-mark]`. */
function markPaintedArea(id: string): number {
  const group = document.querySelector(`[data-mark="${id}"]`);
  expect(group, `mark ${id} is not on the page`).toBeTruthy();
  const children = Array.from(
    group!.querySelectorAll('polygon, path, line, polyline, rect, image, ellipse, circle'),
  );
  expect(children.length).toBeGreaterThan(0);
  return children.reduce((total, element) => total + elementPaintedArea(element), 0);
}

describe('the overlay paints a quad as a ring', () => {
  it('draws one closed rectangle per line, with no diagonal edge', () => {
    const { highlight } = markupMarks();
    renderOverlay({ annotations: [highlight] });
    const polygons = Array.from(document.querySelectorAll('polygon'));
    // Three lines, three quads, one annotation — and nothing is merged into a
    // box across the leading.
    expect(polygons).toHaveLength(3);
    for (const polygon of polygons) {
      const corners = polygonCorners(polygon);
      expect(corners).toHaveLength(4);
      for (let i = 0; i < corners.length; i += 1) {
        const a = corners[i];
        const b = corners[(i + 1) % corners.length];
        expect(a.x === b.x || a.y === b.y).toBe(true);
      }
      // A ring over the same corners as the stored quad, so no area is lost to a
      // self-intersection: the shoelace area is the box's own area.
      let twice = 0;
      for (let i = 0; i < corners.length; i += 1) {
        const a = corners[i];
        const b = corners[(i + 1) % corners.length];
        twice += a.x * b.y - b.x * a.y;
      }
      expect(Math.abs(twice / 2)).toBeGreaterThan(1);
    }
  });

  it('paints one quad per run group, so the gap between them stays paper', () => {
    // One line, two run groups, one annotation. Before the split this was one
    // polygon 350 pt wide, which read as a strike through thin air.
    const lines = snapTextLines(nameAndDate(), { x0: 40, y0: 108, x1: 560, y1: 124 });
    expect(lines).toHaveLength(2);
    const mark = build('highlight', { drag: { x: 40, y: 108, width: 520, height: 16 }, lines })!;
    expect(mark.quadPoints).toHaveLength(16);
    renderOverlay({ annotations: [mark] });
    const polygons = Array.from(document.querySelectorAll('polygon'));
    expect(polygons).toHaveLength(2);
    const spans = polygons.map((p) => polygonCorners(p).map((c) => c.x)).map((xs) => [Math.min(...xs), Math.max(...xs)]);
    // A hole between them: nothing is painted across the column.
    expect(spans[0][1]).toBeLessThan(spans[1][0]);
    expect(spans[1][0] - spans[0][1]).toBeGreaterThan(100);
  });

  it('strokes the rule where the shared function puts it', () => {
    // One line, one quad, so the painted `<line>` can be compared with the
    // number `markupRule` — the very function `core/annotations` strokes the
    // appearance stream with — without guessing which element is which.
    const lines = snapTextLines(threeLines(), { x0: 60, y0: 95, x1: 210, y1: 155 });
    const mark = build('underline', { drag: { x: 70, y: 98, width: 40, height: 8 }, lines: [lines[0]] })!;
    expect(mark.quadPoints).toHaveLength(8);
    renderOverlay({ annotations: [mark] });
    const painted = document.querySelector('[data-markup-rule="Underline"]')!;
    expect(painted).toBeTruthy();
    const quad = mark.quadPoints!;
    const rule = markupRule(
      [
        { x: quad[0], y: quad[1] },
        { x: quad[2], y: quad[3] },
        { x: quad[4], y: quad[5] },
        { x: quad[6], y: quad[7] },
      ],
      'Underline',
      mark.borderWidth,
    );
    const from = pdfToScreenPoint({ x: rule.x1, y: rule.y1 }, overlayGeom);
    const to = pdfToScreenPoint({ x: rule.x2, y: rule.y2 }, overlayGeom);
    const at = (name: string) => Number(painted.getAttribute(name));
    expect(at('x1')).toBeCloseTo(Math.round(from.x * 10) / 10, 6);
    expect(at('y1')).toBeCloseTo(Math.round(from.y * 10) / 10, 6);
    expect(at('x2')).toBeCloseTo(Math.round(to.x * 10) / 10, 6);
    expect(at('y2')).toBeCloseTo(Math.round(to.y * 10) / 10, 6);
    // And that is under the feet of the letters, not through them: the rule sits
    // below the baseline the quad was anchored on.
    const baselineTop = pdfToScreenPoint({ x: quad[0], y: quad[1] }, overlayGeom).y;
    const quadBottom = pdfToScreenPoint({ x: quad[4], y: quad[5] }, overlayGeom).y;
    const baseline = baselineTop + (quadBottom - baselineTop) * TEXT_BASELINE_SHARE;
    expect(at('y1')).toBeGreaterThan(baseline);
    expect(at('y1')).toBeLessThan(quadBottom);
  });
});

/* ------------------------------------------------------------------ *
 * 11b. Every mark paints an area, at any zoom and on a turned page     *
 * ------------------------------------------------------------------ *
 *
 * "It created a mark" is not the claim a user makes when they say the underline
 * is missing. These cases ask the overlay's own DOM how much paper each mark
 * covers — the same question an audit asks with `getBoundingClientRect()`, which
 * is why a rule used to be painted as a bar with area instead of a stroke whose
 * box is zero tall — and refuse any tool that answers with nothing.
 */

describe('every markup and segment tool paints an area', () => {
  const markupCases = [
    ['highlight', 'Highlight'],
    ['underline', 'Underline'],
    ['strike', 'StrikeOut'],
    ['squiggly', 'Squiggly'],
  ] as const;

  function markupMark(tool: string, kind: string, geom: PageGeom): EditorAnnotation {
    const lines = snapTextLines(threeLines(), { x0: 60, y0: 95, x1: 210, y1: 116 });
    const drag = { x: 62, y: 98, width: 108, height: 12 };
    const built = build(tool === 'squiggly' ? 'underline' : (tool as EditorToolId), { geom, drag, lines })!;
    return built.kind === kind ? built : { ...built, kind: kind as EditorAnnotation['kind'] };
  }

  function segmentMark(tool: EditorToolId, geom: PageGeom): EditorAnnotation {
    // The gesture the editor sends for a drag: the press, then the release.
    return build(tool, { geom, points: [{ x: 60, y: 400 }, { x: 220, y: 460 }] })!;
  }

  const geometryAt = (zoom: number, rotation: 0 | 90): PageGeom => ({
    zoom,
    cssWidth: (rotation === 90 ? PAGE_H : PAGE_W) * zoom,
    cssHeight: (rotation === 90 ? PAGE_W : PAGE_H) * zoom,
    rotation,
  });

  for (const zoom of [1, 1.4, 2]) {
    for (const rotation of [0, 90] as const) {
      for (const [tool, kind] of markupCases) {
        it(`${tool} covers paper at ${Math.round(zoom * 100)} % zoom on a ${rotation}° page`, () => {
          const geom = geometryAt(zoom, rotation);
          const mark = markupMark(tool, kind, geom);
          renderOverlay({ geom, annotations: [mark] });
          const area = markPaintedArea(mark.id);
          // A 108 pt run of text at this zoom, stroked at the mark's own width:
          // the bar is the whole run, so anything near zero is a collapsed rule.
          expect(area, `${kind} painted ${area} px² at ${zoom}x / ${rotation}°`).toBeGreaterThan(10 * zoom);
        });
      }
      for (const tool of ['line', 'arrow'] as const) {
        it(`${tool} covers paper at ${Math.round(zoom * 100)} % zoom on a ${rotation}° page`, () => {
          const geom = geometryAt(zoom, rotation);
          const mark = segmentMark(tool, geom);
          renderOverlay({ geom, annotations: [mark] });
          const area = markPaintedArea(mark.id);
          // The drag was 160 × 60 points; its diagonal is ~171 pt long.
          expect(area, `${tool} painted ${area} px² at ${zoom}x / ${rotation}°`).toBeGreaterThan(100 * zoom);
        });
      }
    }
  }

  it('keeps the rule as wide as the quad it underlines', () => {
    // The measured failure was a rule with no length: the endpoints of
    // `markupRule` sat on top of each other because the box they were mixed from
    // had no height. Compare the painted rule with the quad it belongs to.
    const geom = geometryAt(1, 0);
    const mark = markupMark('underline', 'Underline', geom);
    renderOverlay({ geom, annotations: [mark] });
    const quad = mark.quadPoints!;
    const quadWidth = Math.abs(quad[2] - quad[0]) * geom.zoom;
    const rule = document.querySelector('[data-markup-rule="Underline"]')!;
    const paintedWidth = Math.abs(Number(rule.getAttribute('x2')) - Number(rule.getAttribute('x1')));
    expect(paintedWidth).toBeGreaterThanOrEqual(quadWidth * 0.95);
    expect(paintedWidth).toBeGreaterThan(50);
    // The quad still has a height for the rule to be mixed over — the number the
    // `TEXT_BASELINE_SHARE` re-anchoring depends on.
    expect(Math.abs(quad[1] - quad[5])).toBeGreaterThan(1);
  });
});

/* ------------------------------------------------------------------ *
 * 11c. What the release of a drag hands the builder                    *
 * ------------------------------------------------------------------ *
 *
 * A builder test can hand `points` in by hand and stay green while the pointer
 * path never sends any, which is exactly how Line and Arrow shipped with a drag
 * that created nothing and a status line blaming the user for it. The release
 * rule lives in `dragGesturePayload` so the one decision a segment depends on —
 * the two ends, not the box around them — is testable and shared with the
 * rubber band.
 */
describe('the release of a drag', () => {
  const press = { x: 60, y: 400 };
  const release = { x: 220, y: 460 };
  const segmentTools = ['line', 'arrow'] as const;

  it('keeps the two ends of a segment, in the order they were drawn', () => {
    for (const tool of segmentTools) {
      const payload = dragGesturePayload(tool, press, release);
      expect(payload.points, `${tool} was released without endpoints`).toEqual([press, release]);
      // The box is still there: the mark's rect is built from the ends plus the
      // stroke, but a segment tool that lost the box would lose its hit target.
      expect(payload.drag).toEqual({ x: 60, y: 400, width: 160, height: 60 });
    }
  });

  it('hands every other drag tool the box and no endpoints', () => {
    for (const tool of ['square', 'circle', 'redact', 'highlight', 'select'] as const) {
      expect(dragGesturePayload(tool, press, release).points, tool).toBeUndefined();
    }
  });

  it('builds a segment that covers paper', () => {
    for (const tool of segmentTools) {
      const mark = build(tool, dragGesturePayload(tool, press, release));
      expect(mark, `${tool} built nothing from its own release`).not.toBeNull();
      renderOverlay({ annotations: [mark!] });
      const area = markPaintedArea(mark!.id);
      // The diagonal is 171 pt at 1x, 342 px at the overlay's 2x, and it is
      // stroked: anything near zero means the ends never reached the builder.
      expect(area, `${tool} painted ${area} px²`).toBeGreaterThan(300);
    }
  });

  it('is the whole difference between a mark and silence', () => {
    // The shipped wiring: the box alone. `buildSegment` has nothing to read, so
    // the gesture creates no annotation and the tool stays armed.
    for (const tool of segmentTools) {
      const box = dragGesturePayload(tool, press, release).drag!;
      expect(build(tool, { drag: box }), `${tool} was built from a box`).toBeNull();
    }
  });

  it('points the arrow head at the end the pointer left from', () => {
    const mark = build('arrow', dragGesturePayload('arrow', press, release))!;
    expect(mark.lineArrow).toBe('end');
    renderOverlay({ annotations: [mark] });
    const head = document.querySelector('[data-mark] polygon');
    expect(head, 'the arrow painted no head').toBeTruthy();
    const corners = shapeCorners(head!);
    const centre = {
      x: corners.reduce((t, c) => t + c.x, 0) / corners.length,
      y: corners.reduce((t, c) => t + c.y, 0) / corners.length,
    };
    const end = pdfToScreenPoint({ x: mark.lineEnds![2], y: mark.lineEnds![3] }, overlayGeom);
    const start = pdfToScreenPoint({ x: mark.lineEnds![0], y: mark.lineEnds![1] }, overlayGeom);
    expect(Math.hypot(centre.x - end.x, centre.y - end.y)).toBeLessThan(
      Math.hypot(centre.x - start.x, centre.y - start.y),
    );
    // And the ends are the gesture, not the sorted corners of its bounding box.
    expect(end.x).toBeCloseTo(release.x * overlayGeom.zoom, 1);
    expect(end.y).toBeCloseTo(release.y * overlayGeom.zoom, 1);
  });
});

/* ------------------------------------------------------------------ *
 * 11d. What the overlay paints has to be in the file                  *
 * ------------------------------------------------------------------ *
 *
 * Audit #3 measured every tool twice — the area a real browser painted, and the
 * area the exported annotation covers — and found one number nobody had ever
 * compared. Link came back 3 726 px² against 0 pt²: a mark you could see, move
 * and delete that a viewer painting `/AP` would never draw. The table below is
 * that comparison kept as a test, one row per tool the palette can create: the
 * canvas side read out of the overlay's own DOM, the byte side read out of the
 * saved file's `/AP /N`.
 *
 * Two traps the rows are built to survive:
 *
 * - *A rule has no height.* `<line>` and `m … l S` enclose nothing, so both sides
 *   price a stroke as length × width. A box-based measure reported underline and
 *   strike-out as invisible and they were fine; the canvas assertion here refuses
 *   a 0 px² row outright, so that artifact cannot quietly turn a row into a
 *   tautology.
 * - *One green assertion is not a table.* A check that only ever looked at a
 *   highlight could not have caught a link, and the fix for one subtype must not
 *   hide a mark that loses its ink next week. Hence one `it` per tool, and the
 *   empty-stream cases in `annotations.test.ts` that prove the measure can say 0.
 */

describe('what the overlay paints is in the file', () => {
  /** The gesture each tool really makes, in the shape the pointer path hands it over. */
  function gestureFor(tool: EditorToolId): Parameters<typeof build>[1] {
    const drag = { x: 60, y: 500, width: 160, height: 60 };
    switch (TOOL_BY_ID[tool].gesture) {
      case 'markup':
        return {
          drag: { x: 62, y: 98, width: 108, height: 12 },
          lines: snapTextLines(threeLines(), { x0: 60, y0: 95, x1: 210, y1: 116 }),
        };
      case 'segment':
        return dragGesturePayload(tool, { x: 60, y: 400 }, { x: 220, y: 460 });
      case 'path':
      case 'vertices':
        return { points: [{ x: 60, y: 400 }, { x: 120, y: 440 }, { x: 190, y: 400 }] };
      case 'place': {
        // A stamp writes its label; an image and a signature write their raster.
        if (tool === 'stamp') return { drag };
        const raster: PlacedRaster = { bytes: fakeJpeg(80, 40), url: 'blob:ink-table', width: 80, height: 40 };
        return { drag, raster };
      }
      case 'box':
      default:
        break;
    }
    switch (TOOL_BY_ID[tool].kind) {
      case 'Link':
        // Drag the clickable area, then name the target in the dialog that opens.
        return {
          drag: { x: 70, y: 95, width: 148, height: 12 },
          link: { type: 'uri', uri: 'https://example.com/audit' },
        };
      case 'Text':
        return { drag: { x: 300, y: 300, width: 0, height: 0 }, text: 'Audit note' };
      case 'FreeText':
        return { drag: { x: 70, y: 620, width: 200, height: 40 }, text: 'Audit text box' };
      default:
        return { drag };
    }
  }

  const rows = CREATED_TOOLS.map((tool) => ({
    tool,
    kind: TOOL_BY_ID[tool].kind,
    mark: build(tool, gestureFor(tool)),
  }));

  it('paints a link in the colour and at the size the file will write', async () => {
    // The audit's number for a link was 3 726 px² of canvas against 0 pt² of file.
    // Both sides now come from the same two numbers, in the mark's own colour, so
    // a link recoloured in the inspector cannot look right here and print blue.
    const geom: PageGeom = { zoom: 2, cssWidth: PAGE_W * 2, cssHeight: PAGE_H * 2, rotation: 0 };
    const mark = build(
      'link',
      { drag: { x: 70, y: 95, width: 148, height: 12 }, link: { type: 'uri', uri: 'https://example.com/audit' } },
      { color: '#DC2626' },
    )!;
    const view = renderOverlay({ geom, annotations: [mark] });
    const box = document.querySelector('[data-link-box]')!;
    view.unmount();
    // jsdom keeps attribute strings; a browser resolves them to `rgb(…)`. What is
    // worth holding here is that both come from the mark's colour, not from a
    // literal blue: the wash is the same ink at `LINK_WASH_ALPHA`.
    expect(box.getAttribute('stroke')).toBe('#DC2626');
    expect(box.getAttribute('fill')).toBe(`rgba(220, 38, 38, ${LINK_WASH_ALPHA})`);
    // The rule and the dash are the mark's points, drawn at the page's scale.
    expect(box.getAttribute('stroke-width')).toBe('2');
    expect(box.getAttribute('stroke-dasharray')).toBe('10 6');
    // Half the rule off each edge — 1 pt in the file, 1 px here at 2× — because
    // the appearance stream is clipped to `/Rect` and SVG is not.
    expect(box.getAttribute('x')).toBe('141');
    expect(box.getAttribute('width')).toBe('294');

    const [file] = await inkOfSpecs([{ spec: annotationToSpec(mark), tool: 'link' }]);
    expect(file.rect).toEqual([70, 685, 218, 697]);
    expect(hexToRgb01('#DC2626').every((v) => file.ops.includes(String(Math.round(v * 1000) / 1000)))).toBe(true);
    expect(file.borderWidth).toBe(mark.borderWidth);
    expect(file.borderDash).toEqual([...LINK_BORDER_DASH]);
    expect(file.ops).toContain(`[${LINK_BORDER_DASH.join(' ')}] 0 d`);
    expect(file.inkPt2).toBeGreaterThan(0);
  });

  it('is one row per creating tool, and names the subtype each one exports', () => {
    expect(rows.map((row) => `${row.tool}→${row.kind}`).sort()).toEqual(
      TOOLS.filter((meta) => isPlacementTool(meta.id))
        .map((meta) => `${meta.id}→${meta.kind}`)
        .sort(),
    );
    // 15 subtypes: the palette's 17 tools share Stamp between stamp, image and
    // signature and nothing else collapses. `Caret`, `Popup`, `Widget` and
    // `Squiggly` are kinds the writer knows and no tool makes, so they are not
    // rows here.
    expect(new Set(rows.map((row) => row.kind)).size).toBe(15);
  });

  for (const row of rows) {
    it(`${row.tool} writes the ink it paints`, async () => {
      expect(row.mark, `${row.tool} builds no mark from its own gesture`).not.toBeNull();
      const view = renderOverlay({ annotations: [row.mark!] });
      const paintedPx = markPaintedArea(row.mark!.id);
      view.unmount();
      // A blind row would pass the gate below by never reaching it.
      expect(paintedPx, `${row.tool} paints nothing on the overlay`).toBeGreaterThan(0);

      const [file] = await inkOfSpecs([{ spec: annotationToSpec(row.mark!), tool: row.tool }]);
      expect(file.kind).toBe(row.kind);
      expect(file.ops.trim(), `${row.tool} exports an empty appearance stream`).not.toBe('q Q');
      expect(
        file.inkPt2,
        `${row.tool} (${row.kind}) covers ${paintedPx} px² on the canvas and nothing in the file:\n${file.ops}`,
      ).toBeGreaterThan(0);
    });
  }
});

describe('a mark wears one boundary at a time', () => {
  const box = () =>
    build('freetext', { drag: { x: 80, y: 300, width: 240, height: 56 }, text: '' })!;

  it('shows selection chrome on a selected mark that is not being typed into', () => {
    const mark = box();
    renderOverlay({ annotations: [mark], selection: [mark.id] });
    expect(document.querySelector('[data-selection-outline]')).toBeTruthy();
    expect(document.querySelectorAll('[data-resize-handle]')).toHaveLength(RESIZE_HANDLES.length);
    expect(document.querySelector('[data-rotate-handle]')).toBeTruthy();
    expect(document.querySelector('textarea')).toBeNull();
  });

  /**
   * The grips belong to Select, not to whoever is holding a pen.
   *
   * `[data-resize-hit]` and the rotate knob are 22 px targets sitting on the
   * selection, and they took the press before the page did. So the second Line —
   * started near the corner of the first, which is where a user who has just
   * drawn a line puts the pointer — resized the first mark and painted nothing,
   * with the tool still armed: the measurement that reads as “Line creates no
   * mark”. The outline stays under a pen because it reports the selection; a grip
   * that will not answer must not be painted, and must not be grabbable.
   */
  it('leaves the page to the tool in the hand', () => {
    const mark = box();
    for (const tool of ['line', 'arrow', 'highlight', 'ink', 'square', 'redact'] as EditorToolId[]) {
      const view = renderOverlay({ annotations: [mark], selection: [mark.id], tool });
      expect(document.querySelectorAll('[data-resize-hit]'), tool).toHaveLength(0);
      expect(document.querySelectorAll('[data-resize-handle]'), tool).toHaveLength(0);
      expect(document.querySelector('[data-rotate-handle]'), tool).toBeNull();
      // Still visible as the selection, so Delete and the inspector are not a lie.
      expect(document.querySelector('[data-selection-outline]'), tool).toBeTruthy();
      view.unmount();
    }
    // A group under a pen loses the knob the same way and keeps its outlines.
    const pair = [box(), box()];
    const grouped = renderOverlay({ annotations: pair, selection: pair.map((m) => m.id), tool: 'line' });
    expect(document.querySelector('[data-rotate-handle]')).toBeNull();
    expect(document.querySelectorAll('[data-selection-outline]')).toHaveLength(2);
    grouped.unmount();
    // The arrow gets every grip back.
    renderOverlay({ annotations: [mark], selection: [mark.id], tool: 'select' });
    expect(document.querySelectorAll('[data-resize-hit]')).toHaveLength(RESIZE_HANDLES.length);
    expect(document.querySelectorAll('[data-resize-handle]')).toHaveLength(RESIZE_HANDLES.length);
    expect(document.querySelector('[data-rotate-handle]')).toBeTruthy();
  });

  it('shows edit chrome only, on the mark the caret is inside', () => {
    const mark = box();
    renderOverlay({ annotations: [mark], selection: [mark.id], editingId: mark.id });
    const surface = document.querySelector('textarea');
    expect(surface).toBeTruthy();
    // No second rectangle: no outline, no handles, no rotate knob.
    expect(document.querySelector('[data-selection-outline]')).toBeNull();
    expect(document.querySelector('[data-resize-handle]')).toBeNull();
    expect(document.querySelector('[data-rotate-handle]')).toBeNull();
  });

  it('puts the type-in surface on the mark geometry, not on a clamped box of its own', () => {
    const mark = box();
    renderOverlay({ annotations: [mark], selection: [mark.id], editingId: mark.id });
    const surface = document.querySelector('textarea') as HTMLTextAreaElement;
    const rect = pdfToScreenRect(mark.rect, overlayGeom);
    const style = surface.style;
    const px = (value: string): number => parseFloat(value);
    expect(px(style.left)).toBeCloseTo(rect.x, 3);
    expect(px(style.top)).toBeCloseTo(rect.y, 3);
    expect(px(style.width)).toBeCloseTo(rect.width, 3);
    expect(px(style.height)).toBeCloseTo(rect.height, 3);
    // The inset comes from the writer and the leading from the mark's own style, so
    // what is typed wraps the way the page will print — and there is no border of
    // its own to read as a second rectangle around the box.
    expect(px(style.padding)).toBeCloseTo(freeTextInset(mark.fontSize ?? 12) * overlayGeom.zoom, 3);
    expect(px(style.lineHeight)).toBeCloseTo(mark.textStyle?.lineSpacing ?? 0, 6);
    expect(style.boxSizing).toBe('border-box');
    expect(style.border).toBe('');
  });

  /**
   * The type-in surface wears the style model, not a guess at it.
   *
   * A box typed into at 24 pt bold centred Times has to look like that while the
   * caret is in it. `FREE_TEXT_LINE_EM` survives only as the fallback for a mark
   * that carries no style.
   */
  it('wears the mark’s family, weight, alignment and line height while it is typed into', () => {
    const mark = {
      ...box(),
      textStyle: {
        fontFamily: 'std:times',
        size: 24,
        color: '#8B5CF6',
        bold: true,
        italic: false,
        align: 'center' as const,
        lineSpacing: 2,
      },
      fontSize: 24,
      color: '#8B5CF6',
    };
    renderOverlay({ annotations: [mark], selection: [mark.id], editingId: mark.id });
    const style = (document.querySelector('textarea') as HTMLTextAreaElement).style;
    expect(style.fontFamily).toContain('Times New Roman');
    expect(style.fontWeight).toBe('700');
    expect(style.fontStyle).toBe('normal');
    expect(style.textAlign).toBe('center');
    expect(parseFloat(style.fontSize)).toBeCloseTo(24 * overlayGeom.zoom, 3);
    expect(parseFloat(style.lineHeight)).toBeCloseTo(2, 6);
    expect(parseFloat(style.padding)).toBeCloseTo(freeTextInset(24) * overlayGeom.zoom, 3);
  });

  it('falls back to the writer’s leading for a mark with no style of its own', () => {
    const mark = { ...box(), textStyle: undefined };
    renderOverlay({ annotations: [mark], selection: [mark.id], editingId: mark.id });
    const style = (document.querySelector('textarea') as HTMLTextAreaElement).style;
    expect(parseFloat(style.lineHeight)).toBeCloseTo(FREE_TEXT_LINE_EM, 6);
  });

  it('turns the text about the middle of its own box, so the mark stays put', () => {
    const mark = { ...box(), rotation: 90 };
    renderOverlay({ annotations: [mark], selection: [mark.id], editingId: mark.id });
    const surface = document.querySelector('textarea') as HTMLTextAreaElement;
    // `center` of the element, which is the mark's rect: a page-space origin
    // would swing the text around a point off the box and the box would appear to
    // jump when it turned.
    expect(surface.style.transformOrigin).toBe('center');
    expect(surface.style.transform).toMatch(/rotate\(/);
  });

  it('puts the handles on the turned corners, not on the axis-aligned box', () => {
    const mark = { ...box(), rotation: 90 };
    renderOverlay({ annotations: [mark], selection: [mark.id] });
    const centres = Array.from(document.querySelectorAll('[data-resize-hit]')).map((handle) => ({
      x: Number((handle as SVGRectElement).getAttribute('x')) + HANDLE_HIT_PX / 2,
      y: Number((handle as SVGRectElement).getAttribute('y')) + HANDLE_HIT_PX / 2,
    }));
    expect(centres).toHaveLength(RESIZE_HANDLES.length);
    const boxOnScreen = pdfToScreenRect(mark.rect, overlayGeom);
    const axisAligned = [
      { x: boxOnScreen.x, y: boxOnScreen.y },
      { x: boxOnScreen.x + boxOnScreen.width, y: boxOnScreen.y },
      { x: boxOnScreen.x + boxOnScreen.width, y: boxOnScreen.y + boxOnScreen.height },
      { x: boxOnScreen.x, y: boxOnScreen.y + boxOnScreen.height },
    ];
    // A quarter turn moves every corner off the box the mark was drawn in, so a
    // handle set that matched `axisAligned` would be the unrotated one.
    const onAxisCorner = centres.filter((c) =>
      axisAligned.some((p) => Math.abs(p.x - c.x) < 1 && Math.abs(p.y - c.y) < 1),
    );
    expect(onAxisCorner).toHaveLength(0);
    // And they are the same distance from the middle: the box turned, it did not
    // travel.
    const middle = { x: boxOnScreen.x + boxOnScreen.width / 2, y: boxOnScreen.y + boxOnScreen.height / 2 };
    const radii = centres.map((c) => Math.hypot(c.x - middle.x, c.y - middle.y));
    for (const radius of radii) expect(radius).toBeCloseTo(radii[0], 3);
  });
});

/* ------------------------------------------------------------------ *
 * 12. A sticky note stays upright, and its card stays with it          *
 * ------------------------------------------------------------------ *
 *
 * Two claims, both checked without a canvas: the note's icon is painted straight
 * (so the editor never shows a lean the exported file will not carry), and the
 * card hangs off the icon's own box and is kept on the paper, so the popup is
 * where the mark is and the caret inside it can be reached.
 */

describe('a sticky note and its card', () => {
  const noteAt = (x: number, y: number, over: Record<string, unknown> = {}) => ({
    ...build('note', { drag: { x, y, width: 26, height: 26 }, text: 'a pinned thought' })!,
    ...over,
  });
  const px = (element: Element | null, prop: string): number =>
    parseFloat(((element as HTMLElement)?.style as CSSStyleDeclaration)[prop as any] ?? 'NaN');

  it('hangs the card beside the icon, and flips it onto the paper', () => {
    const page = { width: 1000, height: 800 };
    const card = { width: 190, height: 74 };
    const room = noteCardBox({ x: 100, y: 200, width: 26, height: 26 }, page, card);
    expect(room).toMatchObject({ x: 132, y: 200, width: 190, height: 74 });
    // An icon against the right edge: the card moves to its left rather than
    // hanging half off the page, and it never leaves the paper at the bottom.
    const flipped = noteCardBox({ x: 950, y: 200, width: 26, height: 26 }, page, card);
    expect(flipped.x).toBe(950 - 190 - 6);
    expect(flipped.x + flipped.width).toBeLessThan(950);
    const low = noteCardBox({ x: 100, y: 780, width: 26, height: 26 }, page, card);
    expect(low.y + low.height).toBeLessThanOrEqual(page.height);
  });

  it('paints the icon upright, whatever angle it carries', () => {
    // A note loaded from a file that declared one, or work saved before the note
    // was refused an angle: the marker is the same upright glyph the viewer will
    // draw, not a tilted picture.
    const note = noteAt(200, 300, { rotation: 45 });
    renderOverlay({ annotations: [note], selection: [note.id] });
    expect(document.querySelector(`[data-mark="${note.id}"]`)?.getAttribute('transform')).toBeNull();
    // A shape at the same angle is turned, so this is a rule about notes, not a
    // transform that stopped being applied at all.
    const square = build('square', { drag: { x: 200, y: 300, width: 80, height: 40 } })!;
    renderOverlay({ annotations: [{ ...square, rotation: 45 }] });
    expect(document.querySelector(`[data-mark="${square.id}"]`)?.getAttribute('transform')).toMatch(/rotate\(/);
  });

  it('anchors the card on the icon it belongs to, and keeps the caret hittable', () => {
    const note = noteAt(200, 300, { rotation: 45 });
    renderOverlay({ annotations: [note], selection: [note.id] });
    const card = document.querySelector(`[data-note-card="${note.id}"]`);
    const icon = pdfToScreenRect(markBounds(note), overlayGeom);
    expect(card).toBeTruthy();
    expect(px(card, 'left')).toBeCloseTo(icon.x + icon.width + 6, 3);
    expect(px(card, 'top')).toBeCloseTo(icon.y, 3);
    // The card is a read-out: the pointer goes through it to the page beneath.
    expect((card as HTMLElement).style.pointerEvents).toBe('none');

    // Typing into the same note: the surface takes the card's box, so the caret
    // cannot appear somewhere the icon is not, and it keeps its pointer events.
    renderOverlay({ annotations: [note], selection: [note.id], editingId: note.id });
    const editor = document.querySelector(`[data-note-editor="${note.id}"]`);
    expect(editor).toBeTruthy();
    expect(px(editor, 'left')).toBeCloseTo(px(card, 'left'), 3);
    expect(px(editor, 'top')).toBeCloseTo(px(card, 'top'), 3);
    expect((editor as HTMLElement).style.pointerEvents).not.toBe('none');
  });

  it('keeps a card by the page edge on the paper', () => {
    // The bug the flip exists for: a note in the right margin used to push its
    // 190 px card off the page, where the caret could not be clicked at all.
    const note = noteAt(PAGE_W - 40, 300);
    renderOverlay({ annotations: [note], selection: [note.id] });
    const card = document.querySelector(`[data-note-card="${note.id}"]`) as HTMLElement;
    const left = parseFloat(card.style.left);
    const width = parseFloat(card.style.width);
    expect(left + width).toBeLessThanOrEqual(overlayGeom.cssWidth);
    expect(left).toBeLessThan(pdfToScreenRect(note.rect, overlayGeom).x);
  });
});
