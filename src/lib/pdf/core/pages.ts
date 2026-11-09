/**
 * Page selection and geometry.
 *
 * Every tool that accepts a "which pages" field previously re-implemented its
 * own parser (`parseInt('5-7')` silently producing `5`, an unparseable string
 * silently meaning "all pages"). `resolvePages` is now the single source of
 * truth and throws typed, user-facing errors instead.
 */
import type { PDFObject, PDFPage } from '@maxwbh/pdf-lib';
import { PDFArray, PDFName, PDFRef, PDFStream } from '@maxwbh/pdf-lib';

export type PageSpec = string | number[] | 'all' | 'odd' | 'even' | undefined | null;

export class PageSpecError extends Error {
  readonly name = 'PageSpecError';
}

/** Parse `1,3,5-7,10-` into 0-based indices. Duplicates are preserved. */
export function resolvePages(spec: PageSpec, total: number): number[] {
  if (spec === undefined || spec === null) return all(total);
  if (typeof spec === 'string') {
    const s = spec.trim().toLowerCase();
    if (s === '' || s === 'all' || s === '*') return all(total);
    if (s === 'odd') return every(0, total, 2);
    if (s === 'even') return every(1, total, 2);
    return parseList(s, total);
  }
  if (Array.isArray(spec)) {
    const out: number[] = [];
    for (const n of spec) {
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        throw new PageSpecError(`"${n}" is not a whole page number.`);
      }
      if (n < 1 || n > total) {
        throw new PageSpecError(`Page ${n} is outside this document (1-${total}).`);
      }
      out.push(n - 1);
    }
    return out;
  }
  throw new PageSpecError('Unsupported page selection.');
}

/** Like `resolvePages` but returns `null` rather than throwing. */
export function tryResolvePages(spec: PageSpec, total: number): number[] | null {
  try {
    return resolvePages(spec, total);
  } catch {
    return null;
  }
}

/**
 * Same grammar as `resolvePages` but collapses ranges and de-duplicates,
 * which is what page-deletion and reordering UIs want.
 */
export function resolvePageSet(spec: PageSpec, total: number): number[] {
  const set = new Set(resolvePages(spec, total));
  return [...set].sort((a, b) => a - b);
}

function parseList(input: string, total: number): number[] {
  const out: number[] = [];
  // `1 - 3` is a range with the spaces a person types. Splitting on whitespace
  // first leaves a bare `-`, which used to read as "every page" — so a
  // three-page request quietly extracted the whole document. The spaces around a
  // range operator go away before the split, and a range with no page numbers in
  // it at all is refused rather than treated as "all" (E15).
  const collapsed = input
    .replace(/\s*(--|-|–|\.\.)\s*/g, '$1')
    .replace(/\s*to\s*/gi, 'to');
  for (const rawChunk of collapsed.split(/[,\s;]+/)) {
    const chunk = rawChunk.trim();
    if (!chunk) continue;
    const range = chunk.match(/^(\d+)?\s*(?:--|-|–|to|\.\.)\s*(\d+)?$/i);
    if (range) {
      if (range[1] === undefined && range[2] === undefined) {
        throw new PageSpecError(`"${chunk}" is a range with no page numbers in it. Write 1-3, 5- or -5.`);
      }
      const from = range[1] ? Number(range[1]) : 1;
      const to = range[2] ? Number(range[2]) : total;
      assertPage(from, total, chunk);
      assertPage(to, total, chunk);
      if (from <= to) {
        for (let i = from; i <= to; i++) out.push(i - 1);
      } else {
        for (let i = from; i >= to; i--) out.push(i - 1);
      }
      continue;
    }
    const step = chunk.match(/^(\d+)\s*\+\s*(\d+)$/);
    if (step) {
      const start = Number(step[1]);
      const interval = Number(step[2]);
      assertPage(start, total, chunk);
      if (interval <= 0) throw new PageSpecError(`"${chunk}" has a zero step.`);
      for (let i = start; i <= total; i += interval) out.push(i - 1);
      continue;
    }
    // Only digits name a page. `Number()` also reads `0x10` as 16 and `1e2` as
    // 100, which would quietly select a page nobody typed; the guard’s parser is
    // this strict already, so the two halves of the grammar now agree (E15).
    const single = /^\d+$/.test(chunk) ? Number(chunk) : Number.NaN;
    if (!Number.isInteger(single)) {
      throw new PageSpecError(`"${chunk}" is not a page number or range (try 1,3,5-7).`);
    }
    assertPage(single, total, chunk);
    out.push(single - 1);
  }
  if (out.length === 0) {
    throw new PageSpecError(`"${input}" did not match any page in this document.`);
  }
  return out;
}

function assertPage(n: number, total: number, chunk: string): void {
  if (!Number.isInteger(n) || n < 1 || n > total) {
    throw new PageSpecError(
      `"${chunk}" refers to page ${n}, but this document has ${total} page${total === 1 ? '' : 's'}.`,
    );
  }
}

function all(total: number): number[] {
  return Array.from({ length: total }, (_, i) => i);
}

function every(offset: number, total: number, step: number): number[] {
  const out: number[] = [];
  for (let i = offset; i < total; i += step) out.push(i);
  return out;
}

/** `5,7-9` style summary used in UI chips and download labels. */
export function formatPages(zeroBased: number[]): string {
  const nums = [...zeroBased].sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < nums.length) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    parts.push(i === j ? `${nums[i] + 1}` : `${nums[i] + 1}-${nums[j] + 1}`);
    i = j + 1;
  }
  return parts.join(',');
}

export interface PageBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** MediaBox as a rect (the fork stores it as `[llx, lly, urx, ury]`). */
export function mediaBox(page: PDFPage): PageBox {
  // SAFETY: `PDFPageNode` always resolves /MediaBox — it inherits from the
  // page tree when missing — and the fork types the accessor's return as a
  // `PDFArray`, so only the numeric projection is declared here.
  const node = page.node as unknown as { MediaBox(): BoxValue };
  const box = normaliseBox(node.MediaBox());
  const [x = 0, y = 0, w = 0, h = 0] = box;
  return { x, y, width: w - x, height: h - y };
}

type BoxValue = number[] | { asArray(): BoxValue };

function normaliseBox(raw: BoxValue | null | undefined): number[] {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : normaliseBox(raw.asArray());
  return arr.map(Number).filter(Number.isFinite);
}

export function cropBox(page: PDFPage): PageBox {
  // SAFETY: /CropBox is optional in the PDF spec; the accessor is probed
  // because the fork's type does not declare it.
  const node = page.node as unknown as { CropBox?: () => BoxValue };
  try {
    const box = node.CropBox ? normaliseBox(node.CropBox()) : [];
    if (box.length === 4) {
      const [x, y, w, h] = box;
      return { x, y, width: w - x, height: h - y };
    }
  } catch {
    /* /CropBox absent — MediaBox is the effective crop */
  }
  return mediaBox(page);
}

/** Visible size after the page's own /Rotate, in viewer space. */
export function displayedSize(page: PDFPage): { width: number; height: number } {
  const { width, height } = page.getSize();
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  return rot % 180 === 90 ? { width: height, height: width } : { width, height };
}

/**
 * What a page holds where its content should be.
 *
 * `/Contents` is **optional** (ISO 32000-1 §14.11.2). A page with no content
 * stream is a blank sheet — which is exactly what this app's own `add-blank-page`
 * writes — and `absent` names that legal shape. `unreadable` is the damage: a
 * `/Contents` that is there but resolves to no stream at all, a dangling
 * reference, a number, an array slot pointing at nothing.
 *
 * The two must not share a code path, because the pdf-lib fork this app stamps
 * pages with answers both with one error: `PDFPageEmbedder.embedIntoContext`
 * throws `Can't embed page with missing Contents`, and throws it at `save()`, long
 * after the call site that queued the embed ever returned.
 *
 * Decoding is deliberately not attempted here. A stream that exists but cannot be
 * inflated reports as `draws` and fails loudly where its bytes are actually read,
 * which keeps this predicate cheap on every page and stops a broken file from being
 * mistaken for a blank one.
 */
export function pageContentsState(page: PDFPage): 'draws' | 'absent' | 'unreadable' {
  const node = pageNode(page);
  const raw = node.get(PDFName.of('Contents'));
  if (raw === undefined || raw === null) return 'absent';
  const { context } = node;
  const value = raw instanceof PDFRef ? context.lookup(raw) : raw;
  if (value instanceof PDFArray) {
    for (let index = 0; index < value.size(); index++) {
      if (!(context.lookup(value.get(index)) instanceof PDFStream)) return 'unreadable';
    }
    return 'draws';
  }
  return value instanceof PDFStream ? 'draws' : 'unreadable';
}

/**
 * Give a page that has no `/Contents` the empty one the embedder accepts.
 *
 * Returns `true` when the entry had to be written, that is, when the page is
 * blank. Only `absent` is ever touched: an empty array already round-trips, and
 * anything present-but-broken is left where the reader can fail on it. A blank page
 * then takes the identical geometry path to an inked one — same box, same rotation,
 * same cell — and draws nothing.
 */
export function ensurePageContents(page: PDFPage): boolean {
  if (pageContentsState(page) !== 'absent') return false;
  const node = pageNode(page);
  node.set(PDFName.of('Contents'), PDFArray.withContext(node.context));
  return true;
}

/**
 * The three page-dictionary members these two readers need.
 *
 * `get` and `set` are inherited from `PDFDict`, and `context` is the leaf's owning
 * `PDFContext`; none of the three is declared on the public `PDFPageNode` type.
 */
type PageContentNode = {
  context: PDFPage['doc']['context'];
  get(key: PDFName): PDFObject | undefined;
  set(key: PDFName, value: PDFArray): void;
};

function pageNode(page: PDFPage): PageContentNode {
  // SAFETY: every page node is a `PDFPageLeaf`, which carries all three at runtime.
  // `/Contents` is not an inheritable entry, so the leaf's own dictionary is the
  // whole answer.
  return page.node as unknown as PageContentNode;
}

export function setMediaAndCrop(page: PDFPage, box: PageBox): void {
  page.setMediaBox(box.x, box.y, box.width, box.height);
  page.setCropBox(box.x, box.y, box.width, box.height);
}

/** Normalise a rotation request into a valid PDF /Rotate value. */
export function normaliseRotation(degrees: number): 0 | 90 | 180 | 270 {
  const r = ((Math.round(degrees / 90) * 90) % 360 + 360) % 360;
  return r as 0 | 90 | 180 | 270;
}

export function rotateBy(current: number, delta: number): 0 | 90 | 180 | 270 {
  return normaliseRotation(current + delta);
}

/** Well-known page sizes in points. */
export const PAGE_SIZES: Record<string, [number, number]> = {
  a3: [841.89, 1190.55],
  a4: [595.28, 841.89],
  a5: [419.53, 595.28],
  letter: [612, 792],
  legal: [612, 1008],
  tabloid: [792, 1224],
  'business-card': [105, 60],
};

const CUSTOM_SIZE = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/;

export function pageSize(name: string, landscape = false): [number, number] {
  const key = name.toLowerCase();
  const preset = PAGE_SIZES[key];
  const size = preset ?? matchCustom(key) ?? PAGE_SIZES.a4;
  return landscape ? [size[1], size[0]] : size;
}

function matchCustom(key: string): [number, number] | null {
  const m = CUSTOM_SIZE.exec(key);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export const PT_PER = { pt: 1, mm: 72 / 25.4, cm: 72 / 2.54, in: 72, px: 0.75, pc: 12 } as const;
export type LengthUnit = keyof typeof PT_PER;

export function toPoints(value: number, unit: LengthUnit = 'pt'): number {
  return value * PT_PER[unit];
}

export function fromPoints(value: number, unit: LengthUnit = 'pt'): number {
  return value / PT_PER[unit];
}

export function describeUnit(unit: LengthUnit): string {
  return { pt: 'points', mm: 'millimetres', cm: 'centimetres', in: 'inches', px: 'CSS pixels', pc: 'picas' }[unit];
}
