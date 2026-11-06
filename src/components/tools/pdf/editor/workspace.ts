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
import { createHistory, type HistoryState } from './history';
import { normaliseRotation } from '@/lib/pdf/core/pages';

export interface DocWork {
  history: HistoryState<EditorAnnotation[]>;
  /** 0-based page index the document was last left on. */
  page: number;
  selectedId: string | null;
  /** `workSignature` of the list that was last exported; drives "unsaved". */
  exportedSignature: string | null;
}

export function createWork(): DocWork {
  return { history: createHistory<EditorAnnotation[]>([]), page: 0, selectedId: null, exportedSignature: null };
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
