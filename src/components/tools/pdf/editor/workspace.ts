/**
 * Per-document editor work, and the page-context notes the editor shows.
 *
 * The annotation editor keeps one undo stack per open document so that switching
 * tabs — or stepping out to check the exported file — never throws work away.
 * That cache has two failure modes this module removes:
 *
 * * keying by file *name*. Two different scans called `scan.pdf` shared one
 *   stack, so marks drawn on one appeared on the other. `documentKey` includes
 *   size and `lastModified`, which is the cheapest identity that survives a
 *   re-download of the same file and still separates two different files.
 * * forgetting that a page is geometry. `clampPageIndex` and
 *   `pageContextNotes` are where the single-page / mixed-size / rotated cases
 *   (E6, E8, E9) get stated out loud instead of being silently absorbed.
 */
import type { EditorAnnotation } from './types';
import { workSignature } from './specs';
import { canRedo, canUndo, createHistory, redoHistory, undoHistory, type HistoryState } from './history';
import { normaliseRotation } from '@/lib/pdf/core/pages';

export interface DocWork {
  history: HistoryState<EditorAnnotation[]>;
  /** 0-based page index the document was last left on. */
  page: number;
  /**
   * The selection set, ordered oldest-first. It replaces the single id the
   * editor used to hold: every old one-mark command now runs over this list,
   * so a one-element selection behaves exactly as that id did.
   *
   * Ids only ever name marks on `page` — a selection is per-page, because a
   * mark's geometry lives in one page's user space and cannot be nudged into
   * another's.
   */
  selection: string[];
  /** `workSignature` of the list that was last exported; drives "unsaved". */
  exportedSignature: string | null;
}

export function createWork(): DocWork {
  return { history: createHistory<EditorAnnotation[]>([]), page: 0, selection: [], exportedSignature: null };
}

/* ------------------------------------------------------------------ *
 * The selection set                                                   *
 * ------------------------------------------------------------------ */

/** The whole selection, as a fresh array — an empty selection is `[]`. */
export function selectOnly(id: string | null | undefined): string[] {
  return id ? [id] : [];
}

/** Add `id` if it is out, drop it if it is in; Shift+click's whole meaning. */
export function toggleSelected(selection: readonly string[], id: string): string[] {
  return selection.includes(id) ? selection.filter((entry) => entry !== id) : [...selection, id];
}

/** Every id in `ids` that is not already selected, appended in list order. */
export function addToSelection(selection: readonly string[], ids: readonly string[]): string[] {
  const next = [...selection];
  for (const id of ids) if (!next.includes(id)) next.push(id);
  return next;
}

/**
 * Drop selected ids that no longer name a mark on `page`.
 *
 * Undo, a delete from the layer list and turning the page all take marks out
 * from under the selection; a stale id would make the inspector claim a mark is
 * selected that the canvas no longer shows.
 */
export function pruneSelection(
  selection: readonly string[],
  annotations: readonly { id: string; page: number }[],
  page: number | null = null,
): string[] {
  const alive = new Set(annotations.filter((a) => (page === null || a.page === page)).map((a) => a.id));
  return selection.filter((id) => alive.has(id));
}

/**
 * What turning the page does to a selection, and what the editor says about it.
 *
 * A selection cannot travel: marks are geometry in one page's user space, so
 * page N's set is simply left behind. Returning the reason is the point — the
 * alternative is marks that look unselected because the user turned over, with
 * no explanation of where they went.
 */
export function transferSelectionToPage(
  selection: readonly string[],
  fromPage: number,
  toPage: number,
): { selection: string[]; notice: string | null } {
  if (toPage === fromPage) return { selection: [...selection], notice: null };
  if (selection.length === 0) return { selection: [], notice: null };
  return {
    selection: [],
    notice:
      `Left ${selection.length} selected mark${selection.length === 1 ? '' : 's'} on page ${fromPage + 1} — ` +
      `a selection belongs to one page and cannot move to page ${toPage + 1}.`,
  };
}

/**
 * Sentence for the live region after a selection change.
 *
 * Multi-select is otherwise invisible feedback: nothing on the page announces
 * that the target of the keyboard commands just changed from one mark to four.
 */
export function selectionNotice(
  count: number,
  page: number,
  marks?: { tool?: string }[],
): string {
  if (count === 0) return 'Cleared the selection.';
  if (count === 1) {
    const label = marks?.[0]?.tool ?? 'mark';
    return `Selected the ${label} on page ${page + 1}.`;
  }
  return `Selected ${count} marks on page ${page + 1} — commands now act on the set.`;
}

/** What a marquee took, or failed to take. */
export function marqueeNotice(count: number, page: number): string {
  return count === 0
    ? `That band crossed no marks on page ${page + 1}.`
    : `Selected ${count} mark${count === 1 ? '' : 's'} the band touched on page ${page + 1}.`;
}

/** What `Cmd/Ctrl-A` took — and it never takes another page's marks. */
export function selectAllNotice(count: number, page: number): string {
  return count === 0
    ? `Page ${page + 1} has no marks to select.`
    : `Selected all ${count} mark${count === 1 ? '' : 's'} on page ${page + 1} — other pages keep their own.`;
}

/** What a delete took. */
export function deleteNotice(count: number): string {
  return count === 1
    ? 'Removed the selected mark.'
    : `Removed ${count} marks in one step — one undo brings them all back.`;
}

/** What a group drag did, said once at the end of the drag. */
export function moveSelectionNotice(count: number, dx: number, dy: number): string {
  const axis = Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'up' : 'down';
  return `Moved ${count} mark${count === 1 ? '' : 's'} ${axis} as one selection.`;
}

/** Names of the shared properties the inspector just changed. */
const STYLE_LABELS: Record<string, string> = {
  color: 'colour',
  opacity: 'opacity',
  strokeWidth: 'stroke width',
  fontSize: 'text size',
};

/** What a style edit did to the set. */
export function sharedStyleNotice(changed: string[], count: number): string {
  const what = changed.map((key) => STYLE_LABELS[key] ?? key).join(' and ');
  return count === 1
    ? `Set the ${what} of the selected mark.`
    : `Set the ${what} of all ${count} selected marks in one step.`;
}

/**
 * What a rotation did.
 *
 * A right angle is said as a quarter turn because that is what the user asked
 * for; any other angle is said in degrees because that is what they dialled in.
 */
export function rotationNotice(count: number, degrees: number, snapped: boolean): string {
  const whose = count === 1 ? 'mark' : 'marks';
  const turned = `Turned the selected ${whose} to ${Math.round(degrees)}\u00b0`;
  return snapped ? `${turned} — snapped to 15\u00b0; hold Shift for a free angle.` : `${turned}.`;
}

/** Why a rotation did nothing to a mark that cannot carry one. */
export function rotationRefusedNotice(label: string): string {
  return `${label} marks a region of the page rather than a shape on it, so it cannot be turned.`;
}

/** Identity of a file for the work cache: same bytes → same workspace. */
export function documentKey(file: { name: string; size: number; lastModified?: number } | null | undefined): string {
  if (!file) return '';
  const stamp = Number.isFinite(file.lastModified) ? file.lastModified : 0;
  return `${file.name}::${file.size}::${stamp}`;
}

/** True when the on-screen list is not what the last export contained. */
export function isUnsaved(
  work: DocWork | null | undefined,
  annotations: EditorAnnotation[] = work?.history.present ?? [],
): boolean {
  if (!work) return false;
  if (annotations.length === 0) return false;
  return workSignature(annotations) !== work.exportedSignature;
}

/** Bounded in-memory map of per-document work (nothing is persisted to disk). */
export class WorkCache<T> {
  private readonly entries = new Map<string, T>();

  constructor(private readonly limit = 10) {}

  get(key: string): T | undefined {
    return this.entries.get(key);
  }

  set(key: string, value: T): void {
    if (!key) return;
    this.entries.set(key, value);
    // Oldest first: dropping the least recently touched document bounds memory
    // when a user keeps adding tabs.
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/** The live cache for the annotation editor. */
export const docWork = new WorkCache<DocWork>();

/** Page index inside `total`, with the single-page case handled by the maths. */
export function clampPageIndex(value: number, total: number): number {
  const count = Math.max(0, Math.floor(total));
  if (count === 0) return 0;
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.round(value), 0), count - 1);
}

/** `595 × 842 pt`, the size shown next to the page controls. */
export function formatPageExtent(widthPt: number, heightPt: number): string {
  return `${Math.round(widthPt)} × ${Math.round(heightPt)} pt`;
}

export interface PageContextInput {
  /** 0-based index of the page being shown. */
  index: number;
  total: number;
  /** Page `/Rotate`, any multiple of 90. */
  rotation: number;
  widthPt: number;
  heightPt: number;
  /** How many distinct page sizes this document has shown so far (E8). */
  distinctSizes?: number;
}

export interface ContextNote {
  tone: 'info' | 'warn';
  text: string;
}

/**
 * What the editor can honestly say about the page under the pen.
 *
 * E6, E8 and E9 are all "did the mark land where I drew it?" fears. The answers
 * are cheap to state and belong next to the page controls, not in a README.
 */
export function pageContextNotes(input: PageContextInput): ContextNote[] {
  const notes: ContextNote[] = [];
  const total = Math.max(0, Math.floor(input.total));
  const rotation = normaliseRotation(input.rotation);
  if (total === 1) {
    notes.push({
      tone: 'info',
      text: 'This document has one page, so page controls stay on page 1.',
    });
  }
  if (rotation !== 0) {
    notes.push({
      tone: 'info',
      text: `This page is rotated ${rotation}°. Marks are stored in the page's own space, so they stay where you drew them.`,
    });
  }
  if ((input.distinctSizes ?? 1) > 1) {
    notes.push({
      tone: 'warn',
      text: `Mixed page sizes in this document — this page is ${formatPageExtent(input.widthPt, input.heightPt)}. Each page keeps its own marks, so nothing shifts when you move pages.`,
    });
  }
  return notes;
}

/**
 * Sentence for the live region after an undo or redo attempt.
 *
 * Undo and redo are the two commands whose whole effect is invisible-adjacent —
 * something stopped being there, or started being there again — so the editor
 * says which happened, and says so honestly when history had nothing to give.
 */
export function historyNotice(input: {
  action: 'undo' | 'redo';
  changed: boolean;
  marks?: number;
}): string {
  if (!input.changed) {
    return input.action === 'undo'
      ? 'Nothing left to undo — this is the oldest state of this document.'
      : 'Nothing to redo — you are already at the newest state.';
  }
  const count =
    typeof input.marks === 'number'
      ? ` · ${input.marks} mark${input.marks === 1 ? '' : 's'} in this document`
      : '';
  return `${input.action === 'undo' ? 'Undid' : 'Redid'} the last change${count}.`;
}

/**
 * Take one step through the history of a document, and report it.
 *
 * The step and its announcement come from the same place so the live region
 * cannot claim an undo that the stack refused. A missing workspace (no document
 * open yet) is a no-op that says nothing rather than a confident lie.
 */
export function applyWorkStep(
  work: DocWork | null | undefined,
  action: 'undo' | 'redo',
): { work: DocWork | null; notice: string | null } {
  if (!work) return { work: null, notice: null };
  const changed = action === 'undo' ? canUndo(work.history) : canRedo(work.history);
  if (!changed) return { work, notice: historyNotice({ action, changed: false }) };
  const history = action === 'undo' ? undoHistory(work.history) : redoHistory(work.history);
  return {
    work: { ...work, history },
    notice: historyNotice({ action, changed: true, marks: history.present.length }),
  };
}

/**
 * Sentence shown after a document switch that kept unsent work (E19). Keeping
 * the count is the point: "your work is still there" has to be checkable.
 */
export function switchNotice(input: {
  fileName: string;
  kept: number;
  discardedPending: boolean;
}): string {
  const parts = [
    input.kept > 0
      ? `Switched to ${input.fileName} — ${input.kept} mark${input.kept === 1 ? '' : 's'} kept on the other document.`
      : `Switched to ${input.fileName}.`,
  ];
  if (input.discardedPending) {
    parts.push('The mark that was half-drawn was dropped; it belonged to the previous page.');
  }
  return parts.join(' ');
}
