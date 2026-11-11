/**
 * Bookmarks (the outline tree), page labels, generated contents pages and
 * Bates numbering.
 *
 * `@maxwbh/pdf-lib` 1.18.1 has **no outline API at all** — `getOutline`,
 * `getOutlineCount`, `removeOutline` and `insertOutlineEntry` do not exist in
 * `cjs/api/PDFDocument.d.ts` or anywhere in the package. The few helpers it
 * ships (`PDFLinkAnnotation`, `page.drawLink`) only cover link annotations. So
 * this module writes and reads the ISO 32000-1 §12.3.3 outline dictionaries
 * directly: a `/Outlines` root in the catalog plus one dictionary per item with
 * `/Title /Parent /First /Last /Next /Prev /Count /C /F` and a `/Dest` (or a
 * `/A` `/GoTo` action, which is what Acrobat writes).
 *
 * `readOutline` is deliberately paranoid: foreign PDFs contain indirect
 * destinations, name-string destinations, wrong `/Count` values, UTF-16BE
 * titles and `/Next` chains that loop back on themselves. A malformed item is
 * skipped, never fatal, because a broken bookmark panel is worse than a short
 * one.
 */
import type { PDFDocument, PDFFont, PDFObject, PDFPage } from '@maxwbh/pdf-lib';
// `PDFString` is the one object-model class `./doc` does not re-export.
import { PDFString } from '@maxwbh/pdf-lib';
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  context,
  rgb,
} from './doc';
import { asDict, collectTreePairs, dictAt, followRef } from './tree';
import { cropBox, displayedSize, resolvePages, PAGE_SIZES } from './pages';
import { getFont, measureText, drawTextU } from './fonts';
import { readInfo } from './metadata';

/** Standard 0.5in inset used when a stamp position carries no offsets. */
const DEFAULT_STAMP_MARGIN = 36;

// ---------------------------------------------------------------------------
// Outline model
// ---------------------------------------------------------------------------

export interface OutlineNode {
  title: string;
  /** 0-based destination page, or `null` for a grouping-only bookmark. */
  page: number | null;
  children?: OutlineNode[];
  /** `#rrggbb`. */
  color?: string;
  /** Encoded with the PDF 1.7 `NoBold` flag — see `writeOutline`. */
  bold?: boolean;
  /** Encoded with the PDF 1.7 `NoItalic` flag — see `writeOutline`. */
  italic?: boolean;
  /**
   * How the viewer should position the page. Omitted means "just go to the
   * page", which every reader honours; `xyz` carries coordinates in PDF user
   * space (origin bottom-left) and a zoom multiplier (`1` = 100 %).
   */
  destination?: { kind: 'fit' | 'xyz'; x?: number; y?: number; zoom?: number };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function pageIndexOf(doc: PDFDocument): (ref: unknown) => number | null {
  const index = new Map<string, number>();
  doc.getPages().forEach((page, i) => index.set(page.ref.toString(), i));
  return (ref) => (ref instanceof PDFRef ? index.get(ref.toString()) ?? null : null);
}

function textOf(value: unknown): string | undefined {
  if (value instanceof PDFString || value instanceof PDFHexString) {
    return value.decodeText();
  }
  return undefined;
}

function nameOf(value: unknown): string | undefined {
  // `decodeText()` is the accessor that yields `GoTo`/`Fit`; `asString()` keeps
  // the leading slash of the PDF name.
  return value instanceof PDFName ? value.decodeText() : undefined;
}

/**
 * Every place this document may keep named destinations.
 *
 * `/Dests` on the catalogue is the PDF 1.1 spelling; from PDF 1.4 a producer that has a
 * name dictionary puts the same tree under `/Names → /Dests` instead, and files carry
 * one, the other, or — seen in the wild with a half-migrated catalogue — both. Looking
 * at only the first is how a bookmark written by a modern tool read as "no page".
 */
function namedDestinationStores(doc: PDFDocument): PDFDict[] {
  const found: PDFDict[] = [];
  const catalog = doc.catalog;
  const direct = dictAt(doc, catalog, 'Dests');
  if (direct) found.push(direct);
  const underNames = dictAt(doc, dictAt(doc, catalog, 'Names'), 'Dests');
  if (underNames && !found.includes(underNames)) found.push(underNames);
  return found;
}

/**
 * Resolve anything a destination may be written as into the destination array itself.
 *
 * ISO 32000-1 §12.3.2 allows four spellings where this app used to accept one, and
 * foreign producers do use all of them:
 *
 *   [ page /Fit ]                       the array, inline
 *   12 0 R                              that array behind a reference
 *   << /S /GoTo /D [ … ] >>             a destination *dictionary* (§12.3.2.2),
 *                                       which is what pypdf files under `/Dests`
 *   (name) / name                       a key into the named-destination tree
 *
 * `depth` bounds the walk: a dictionary's `/D` may name another entry, and a broken
 * file can name itself.
 */
function destinationArray(
  doc: PDFDocument,
  raw: PDFObject | undefined,
  depth = 0,
): PDFArray | undefined {
  if (raw === undefined || depth > 3) return undefined;
  const value = followRef(doc, raw);
  if (value instanceof PDFArray) return value.size() === 0 ? undefined : value;
  if (value instanceof PDFDict) {
    const inner = value.has(PDFName.of('D')) ? value.get(PDFName.of('D')) : undefined;
    return inner === undefined ? undefined : destinationArray(doc, inner, depth + 1);
  }
  const key = textOf(value) ?? nameOf(value);
  if (key === undefined) return undefined;
  for (const store of namedDestinationStores(doc)) {
    for (const pair of collectTreePairs(doc, store)) {
      const name = textOf(followRef(doc, pair.key)) ?? nameOf(followRef(doc, pair.key));
      if (name !== key) continue;
      const found = destinationArray(doc, pair.value, depth + 1);
      if (found) return found;
    }
    // Documents with no tree at all keep a flat dictionary of name → destination.
    const direct = store.get(PDFName.of(key));
    if (direct !== undefined) {
      const found = destinationArray(doc, direct, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

function destinationFrom(
  doc: PDFDocument,
  item: PDFDict,
  indexOf: (ref: unknown) => number | null,
): { page: number | null; destination?: OutlineNode['destination'] } {
  // `/Dest` first, then a `/GoTo` action's `/D`: an entry may carry both, and this app
  // follows `/Dest` — the answer MuPDF gives. pypdf prefers the action; the row in
  // `docs/research/readers-foreign-repro.md` records the two readers disagreeing.
  const action = item.lookupMaybe(PDFName.of('A'), PDFDict);
  const raw = item.get(PDFName.of('Dest'))
    ?? (action && nameOf(action.lookupMaybe(PDFName.of('S'), PDFName)) === 'GoTo'
      ? action.get(PDFName.of('D'))
      : undefined);
  if (raw === undefined) return { page: null };
  const array = destinationArray(doc, raw);
  if (!array) return { page: null };

  const page = indexOf(array.get(0));
  if (page === null) return { page: null };

  const kind = nameOf(array.get(1));
  if (kind === 'XYZ') {
    const number = (index: number): number | undefined => array.lookupMaybe(index, PDFNumber)?.asNumber();
    const destination: NonNullable<OutlineNode['destination']> = { kind: 'xyz' };
    const x = number(2);
    const y = number(3);
    const zoom = number(4);
    if (x !== undefined) destination.x = x;
    if (y !== undefined) destination.y = y;
    if (zoom !== undefined) destination.zoom = zoom;
    return { page, destination };
  }
  if (kind === 'Fit') return { page, destination: { kind: 'fit' } };
  return { page };
}

function colourOf(item: PDFDict): string | undefined {
  const array = item.lookupMaybe(PDFName.of('C'), PDFArray);
  if (!array || array.size() < 3) return undefined;
  const channels = [0, 1, 2].map((i) => {
    const value = array.lookupMaybe(i, PDFNumber)?.asNumber();
    return Math.round(Math.min(1, Math.max(0, value ?? 0)) * 255);
  });
  return `#${channels.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

function styleOf(item: PDFDict): { bold: boolean; italic: boolean } {
  const flags = item.lookupMaybe(PDFName.of('F'), PDFNumber)?.asNumber();
  // Absent `/F` means plain text; when present, bits 1 and 2 are PDF 1.7
  // `NoBold` / `NoItalic`, so a *cleared* bit is the styled case.
  if (flags === undefined) return { bold: false, italic: false };
  return { bold: (flags & 1) === 0, italic: (flags & 2) === 0 };
}

function readSiblings(
  doc: PDFDocument,
  first: PDFDict | undefined,
  indexOf: (ref: unknown) => number | null,
): OutlineNode[] {
  const nodes: OutlineNode[] = [];
  const visited = new Set<PDFDict>();
  let item = first;
  while (item && !visited.has(item)) {
    visited.add(item);
    const next = item.lookupMaybe(PDFName.of('Next'), PDFDict);
    try {
      const title = textOf(item.get(PDFName.of('Title')))?.trim();
      const target = destinationFrom(doc, item, indexOf);
      const node: OutlineNode = { title: title ?? '', page: target.page };
      const style = styleOf(item);
      const color = colourOf(item);
      if (title) node.title = title;
      if (color) node.color = color;
      if (style.bold) node.bold = true;
      if (style.italic) node.italic = true;
      if (target.destination) node.destination = target.destination;
      const children = readSiblings(
        doc,
        item.lookupMaybe(PDFName.of('First'), PDFDict),
        indexOf,
      );
      if (children.length > 0) node.children = children;
      // Items with no title and no destination carry nothing the UI can show.
      if (node.title || node.page !== null) nodes.push(node);
    } catch {
      // Malformed entry: skip it, keep walking the chain.
    }
    item = next;
  }
  return nodes;
}

/** Read the document's bookmarks, skipping anything unparseable. */
export function readOutline(doc: PDFDocument): OutlineNode[] {
  const root = doc.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict);
  if (!root) return [];
  return readSiblings(doc, root.lookupMaybe(PDFName.of('First'), PDFDict), pageIndexOf(doc));
}

// ---------------------------------------------------------------------------
// Carrying an outline across a page copy
// ---------------------------------------------------------------------------

export interface RemappedOutline {
  /** The bookmarks the copy can write into the new document. */
  nodes: OutlineNode[];
  /** How many were dropped because their destination page is not in the copy. */
  dropped: number;
}

/** Every node in a bookmark tree, headings included. */
export function countOutlineNodes(nodes: OutlineNode[]): number {
  return nodes.reduce((sum, node) => sum + 1 + countOutlineNodes(node.children ?? []), 0);
}

/**
 * Re-point a document's bookmarks at the pages a copy placed in a new document.
 *
 * `mapping` is *source* page index → *destination* page index, exactly as the
 * page copy produced it. Where one source page was copied twice it maps to its
 * **first** copy: a bookmark names a place in the reading order, and the first
 * sheet is where a reader following it expects to land.
 *
 * A bookmark whose own destination did not travel is **dropped**, not snapped to
 * the nearest copied page — "Chapter 3" opening on page 2 points at the wrong
 * section with a confident title, which is worse than one entry fewer. Leaving
 * it on its old page number is not an option either: `writeOutline` throws for a
 * destination the output has no sheet for, so a stale bookmark would either lie
 * or abort the run. Its children keep their own destinations and are re-parented
 * into the heading's place.
 *
 * A heading (`page === null`) carries no destination of its own, so it always
 * travels — even emptied, which is how it stood in the source.
 */
export function remapOutline(
  nodes: OutlineNode[],
  mapping: Map<number, number>,
): RemappedOutline {
  const walk = (level: OutlineNode[]): OutlineNode[] => {
    const kept: OutlineNode[] = [];
    for (const node of level) {
      const children = node.children ? walk(node.children) : [];
      if (node.page === null || node.page === undefined) {
        const heading: OutlineNode = { ...node, page: null };
        if (children.length > 0) heading.children = children;
        else delete heading.children;
        kept.push(heading);
        continue;
      }
      const page = mapping.get(node.page);
      if (page === undefined) {
        kept.push(...children);
        continue;
      }
      const next: OutlineNode = { ...node, page };
      if (children.length > 0) next.children = children;
      else delete next.children;
      kept.push(next);
    }
    return kept;
  };
  const carried = walk(nodes);
  return {
    nodes: carried,
    dropped: countOutlineNodes(nodes) - countOutlineNodes(carried),
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function parseHexColor(value: string | undefined): ReturnType<typeof rgb> | undefined {
  if (!value) return undefined;
  const hex = value.trim().replace(/^#/, '');
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return undefined;
  const channel = (i: number) => Number.parseInt(full.slice(i, i + 2), 16) / 255;
  return rgb(channel(0), channel(2), channel(4));
}

function destinationValue(
  doc: PDFDocument,
  node: OutlineNode,
): PDFArray | undefined {
  if (node.page === null || node.page === undefined) return undefined;
  const pages = doc.getPages();
  if (!Number.isInteger(node.page) || node.page < 0 || node.page >= pages.length) {
    throw new Error(
      `Bookmark "${node.title}" points at page ${node.page + 1}, but this document has ${pages.length} page${pages.length === 1 ? '' : 's'}.`,
    );
  }
  const target = pages[node.page];
  const dest = node.destination;
  const ctx = context(doc);
  if (dest?.kind === 'xyz') {
    const value = (n: number | undefined) => (n === undefined ? ctx.obj(null) : PDFNumber.of(n));
    return ctx.obj([
      target.ref,
      PDFName.of('XYZ'),
      value(dest.x),
      value(dest.y),
      value(dest.zoom),
    ]);
  }
  if (dest?.kind === 'fit') return ctx.obj([target.ref, PDFName.of('Fit')]);
  // No explicit destination: `/Fit` is the most universally supported form.
  return ctx.obj([target.ref, PDFName.of('Fit')]);
}

interface BuiltLevel {
  refs: PDFRef[];
  /** Total number of items in this level **and** everything under it. */
  total: number;
}

function buildLevel(
  doc: PDFDocument,
  nodes: OutlineNode[],
  parentRef: PDFRef,
): BuiltLevel {
  const ctx = context(doc);
  const refs = nodes.map(() => ctx.nextRef());
  let total = 0;

  nodes.forEach((node, i) => {
    const dict = ctx.obj({});
    dict.set(PDFName.of('Title'), PDFHexString.fromText(node.title ?? ''));
    dict.set(PDFName.of('Parent'), parentRef);
    if (i > 0) dict.set(PDFName.of('Prev'), refs[i - 1]);
    if (i < refs.length - 1) dict.set(PDFName.of('Next'), refs[i + 1]);

    const dest = destinationValue(doc, node);
    if (dest) dict.set(PDFName.of('Dest'), dest);

    const color = parseHexColor(node.color);
    if (color) {
      dict.set(
        PDFName.of('C'),
        ctx.obj([color.red, color.green, color.blue].map((c) => Number(c.toFixed(4)))),
      );
    }

    // PDF 1.7 §12.3.4.3 Table 156: bit 1 = NoBold, bit 2 = NoItalic. Writing
    // the flags explicitly (instead of omitting `/F`) keeps a round-trip
    // through `readOutline` faithful for the unstyled case as well.
    let flags = 0;
    if (!node.bold) flags |= 1;
    if (!node.italic) flags |= 2;
    dict.set(PDFName.of('F'), PDFNumber.of(flags));

    const children = node.children ?? [];
    if (children.length > 0) {
      const built = buildLevel(doc, children, refs[i]);
      dict.set(PDFName.of('First'), built.refs[0]);
      dict.set(PDFName.of('Last'), built.refs[built.refs.length - 1]);
      // `/Count` of a non-leaf item is the number of its descendants.
      dict.set(PDFName.of('Count'), PDFNumber.of(built.total));
      total += built.total;
    }
    ctx.assign(refs[i], dict);
    total += 1;
  });

  return { refs, total };
}

/** Drop the previous outline's objects so a replace does not bloat the file. */
function deleteOutline(rootRef: PDFRef | undefined, doc: PDFDocument): void {
  if (!rootRef) return;
  const ctx = context(doc);
  const visited = new Set<string>();
  const queue: PDFRef[] = [rootRef];
  while (queue.length > 0) {
    const ref = queue.pop() as PDFRef;
    const tag = ref.toString();
    if (visited.has(tag)) continue;
    visited.add(tag);
    const dict = ctx.lookup(ref, PDFDict);
    if (dict instanceof PDFDict) {
      for (const key of ['First', 'Last', 'Next', 'Prev', 'Parent']) {
        const value = dict.get(PDFName.of(key));
        if (value instanceof PDFRef) queue.push(value);
      }
    }
    ctx.delete(ref);
  }
}

/** Replace the whole bookmark tree (an empty array removes it). */
export function writeOutline(doc: PDFDocument, nodes: OutlineNode[]): void {
  const ctx = context(doc);
  const existing = doc.catalog.get(PDFName.of('Outlines'));
  const existingRef = existing instanceof PDFRef ? existing : undefined;
  doc.catalog.delete(PDFName.of('Outlines'));
  deleteOutline(existingRef, doc);

  if (nodes.length === 0) return;

  const root = ctx.obj({});
  const rootRef = ctx.register(root);
  root.set(PDFName.of('Type'), PDFName.of('Outlines'));

  const built = buildLevel(doc, nodes, rootRef);
  root.set(PDFName.of('First'), built.refs[0]);
  root.set(PDFName.of('Last'), built.refs[built.refs.length - 1]);
  root.set(PDFName.of('Count'), PDFNumber.of(built.total));
  doc.catalog.set(PDFName.of('Outlines'), rootRef);
}

// ---------------------------------------------------------------------------
// Import / export of the tree as text
// ---------------------------------------------------------------------------

function normaliseNode(value: unknown): OutlineNode | undefined {
  if (typeof value === 'string') {
    const title = value.trim();
    return title ? { title, page: null } : undefined;
  }
  if (Array.isArray(value)) {
    // `[title, page]` and `[title, [children]]` are both seen in the wild.
    const title = typeof value[0] === 'string' ? value[0] : '';
    const node: OutlineNode = { title, page: null };
    const second = value[1];
    if (typeof second === 'number' || typeof second === 'string') {
      const page = Number(second);
      if (Number.isFinite(page)) node.page = Math.max(0, Math.round(page) - 1);
    } else if (Array.isArray(second)) {
      const children = second
        .map(normaliseNode)
        .filter((child): child is OutlineNode => child !== undefined);
      if (children.length > 0) node.children = children;
    }
    return node.title ? node : undefined;
  }
  if (!value || typeof value !== 'object') return undefined;

  const source = value as Record<string, unknown>;
  const rawTitle = source.title ?? source.text ?? source.name ?? source.TEXT;
  const title = typeof rawTitle === 'string' ? rawTitle.trim() : '';
  if (!title) return undefined;

  const node: OutlineNode = { title, page: null };
  const rawPage = source.page ?? source.Page ?? source.p ?? source.destination;
  if (typeof rawPage === 'number' && Number.isFinite(rawPage)) {
    node.page = Math.max(0, Math.round(rawPage));
  } else if (typeof rawPage === 'string' && /^\d+$/.test(rawPage.trim())) {
    node.page = Math.max(0, Number.parseInt(rawPage, 10));
  } else if (rawPage === null || rawPage === undefined) {
    node.page = null;
  }
  if (typeof source.color === 'string') node.color = source.color;
  if (source.bold === true || source.bold === 1) node.bold = true;
  if (source.italic === true || source.italic === 1) node.italic = true;
  const dest = source.destination;
  if (dest && typeof dest === 'object' && !Array.isArray(dest)) {
    const d = dest as Record<string, unknown>;
    if (d.kind === 'fit' || d.kind === 'xyz') {
      node.destination = { kind: d.kind };
      for (const key of ['x', 'y', 'zoom'] as const) {
        if (typeof d[key] === 'number') node.destination[key] = d[key] as number;
      }
    }
  }
  const kids = source.children ?? source.node ?? source.outline ?? source.N;
  if (Array.isArray(kids)) {
    const children = kids
      .map(normaliseNode)
      .filter((child): child is OutlineNode => child !== undefined);
    if (children.length > 0) node.children = children;
  }
  return node;
}

interface LiteLine {
  depth: number;
  title: string;
  /** Human (1-based) page number when the line carried one. */
  page?: number;
}

/**
 * Parse the indentation form used by FreeMind exports and hand-written outline
 * files:
 *
 * ```text
 * Chapter 1 ................ 3
 *   1.1 Background | 4
 *     - Deep detail         #6
 * ```
 *
 * Depth comes from the leading whitespace (two spaces or one tab per level),
 * list markers (`-`, `*`, `•`) are ignored, and the page number is the trailing
 * integer after `|`, `:`, `#`, `p.`/`page`, or a dot leader. Those numbers are
 * the **1-based** ones the author wrote and are converted to 0-based here.
 */
function parseOutlineText(text: string): OutlineNode[] {
  const lines: LiteLine[] = [];
  const indents: number[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    if (/^\s*(#|\/\/|;)/.test(rawLine)) continue;
    const leading = /^[\t ]*/.exec(rawLine)?.[0] ?? '';
    const width = leading.replace(/\t/g, '  ').length;
    if (indents.length === 0 || width > indents[indents.length - 1]) indents.push(width);
    while (indents.length > 1 && width < indents[indents.length - 1]) indents.pop();
    const depth = Math.max(0, indents.indexOf(width));

    const body = rawLine.slice(leading.length).replace(/^\s*[-*•]\s*/, '').trim();
    if (!body) continue;
    const match = /^(.*?)\s*(?:\.{2,}|\s{2,}|[|:#]|\b(?:p|page|S\.|p\.)\s*)\s*(\d{1,5})\s*\*?\s*$/i.exec(
      body,
    );
    if (match && match[1].trim()) {
      lines.push({ depth, title: match[1].trim(), page: Number(match[2]) });
    } else {
      lines.push({ depth, title: body });
    }
  }

  const roots: OutlineNode[] = [];
  const stack: { node: OutlineNode; depth: number }[] = [];
  for (const line of lines) {
    const node: OutlineNode = { title: line.title, page: line.page ? line.page - 1 : null };
    while (stack.length > 0 && stack[stack.length - 1].depth >= line.depth) stack.pop();
    if (stack.length === 0) roots.push(node);
    else {
      const parent = stack[stack.length - 1].node;
      (parent.children ??= []).push(node);
    }
    stack.push({ node, depth: line.depth });
  }
  return roots;
}

function parseOutlineXml(text: string): OutlineNode[] {
  if (typeof DOMParser === 'undefined') return [];
  let xml: Document;
  try {
    xml = new DOMParser().parseFromString(text, 'application/xml');
  } catch {
    return [];
  }
  if (xml.getElementsByTagName('parsererror').length > 0) return [];

  const convert = (element: Element): OutlineNode | undefined => {
    const raw =
      element.getAttribute('TEXT') ??
      element.getAttribute('text') ??
      element.getAttribute('title') ??
      '';
    const title = raw.trim();
    if (!title) return undefined;
    const node: OutlineNode = { title, page: null };
    const page = element.getAttribute('page') ?? element.getAttribute('PAGEREF');
    if (page && /^\d+$/.test(page.trim())) node.page = Number(page.trim()) - 1;
    const color = element.getAttribute('COLOR');
    if (color) node.color = color.trim();
    const style = element.getAttribute('STYLE');
    if (style) {
      node.bold = /bold/i.test(style);
      node.italic = /italic/i.test(style);
    }
    const children: OutlineNode[] = [];
    for (let i = 0; i < element.children.length; i++) {
      const child = element.children[i];
      if (child.tagName !== 'node' && child.tagName !== 'outline') continue;
      const converted = convert(child);
      if (converted) children.push(converted);
    }
    if (children.length > 0) node.children = children;
    return node;
  };

  const roots: OutlineNode[] = [];
  const candidates = Array.from(xml.getElementsByTagName('*')).filter(
    (element) => element.tagName === 'node' || element.tagName === 'outline',
  );
  for (const element of candidates) {
    const parentTag = element.parentElement?.tagName ?? '';
    const isTop = !['node', 'outline'].includes(parentTag.toLowerCase());
    if (!isTop) continue;
    const converted = convert(element);
    if (converted) roots.push(converted);
  }
  return roots;
}

/**
 * Accept an outline from a file or a textarea:
 *
 * * JSON — `[{ title, page, children, color, bold, italic, destination }]`
 *   (page is 0-based, matching `OutlineNode`), also `{text|name, children|node}`
 *   as produced by FreeMind/OPML JSON exporters, nested `[title, page]` tuples
 *   and plain strings;
 * * FreeMind `.mm` / OPML XML, using a `page="N"` attribute (1-based) when the
 *   author added one;
 * * indentation text — see `parseOutlineText`.
 */
export function outlineFromJson(json: string): OutlineNode[] {
  const text = (json ?? '').trim();
  if (!text) return [];
  if (text.startsWith('<')) return parseOutlineXml(text);
  if (!/^[{[]/.test(text)) return parseOutlineText(text);
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed
        .map(normaliseNode)
        .filter((node): node is OutlineNode => node !== undefined);
    }
    if (parsed && typeof parsed === 'object') {
      const root = normaliseNode(parsed);
      if (!root) return [];
      return root.children && root.children.length > 0 ? root.children : [root];
    }
    return [];
  } catch {
    // Truncated clipboard JSON is common; the indentation parser is forgiving.
    return parseOutlineText(text);
  }
}

/** Canonical JSON for the bookmark editor; `page` stays 0-based. */
export function outlineToJson(nodes: OutlineNode[]): string {
  const clean = (list: OutlineNode[]): Record<string, unknown>[] =>
    list.map((node) => {
      const out: Record<string, unknown> = {
        title: node.title ?? '',
        page: node.page === undefined ? null : node.page,
      };
      if (node.color) out.color = node.color;
      if (node.bold) out.bold = true;
      if (node.italic) out.italic = true;
      if (node.destination) out.destination = { ...node.destination };
      const children = node.children ?? [];
      if (children.length > 0) out.children = clean(children);
      return out;
    });
  return `${JSON.stringify(clean(nodes), null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Generated contents page
// ---------------------------------------------------------------------------

export interface TocOptions {
  nodes: OutlineNode[];
  /**
   * Heading printed above the entries. Defaults to `Contents`; an empty string
   * prints no heading.
   */
  title?: string;
  fontSize?: number;
  leader?: 'dots' | 'none';
  /**
   * Right-align the page numbers against the right margin, with the leader
   * filling the gap (true by default — the alternative leaves one space after
   * the title).
   */
  rightAlignPageNumbers?: boolean;
  /**
   * 0-based index the new pages are inserted **at** (`doc.insertPage`), so `0`
   * puts the contents at the very front and `1` puts it after an existing cover
   * page. Defaults to 0.
   */
  startPage?: number;
  /**
   * How many pages of front matter the **printed** numbering has to carry: the
   * offset is the larger of this and the number of contents pages inserted
   * ahead of an entry, so `pagesBefore` declares the front matter (which the
   * generated pages are part of) instead of stacking on top of it. Use it for
   * matter that lives outside this document, or to continue numbering from a
   * printed volume. Defaults to 0.
   */
  pagesBefore?: number;
}

interface TocRow {
  title: string;
  level: number;
  page: number | null;
}

function flattenOutline(nodes: OutlineNode[], level = 0, out: TocRow[] = []): TocRow[] {
  for (const node of nodes) {
    out.push({ title: node.title ?? '', level, page: node.page ?? null });
    if (node.children?.length) flattenOutline(node.children, level + 1, out);
  }
  return out;
}

/** Truncate on a code-point boundary so emoji and CJK never split badly. */
function clip(
  title: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string {
  const ellipsis = '\u2026';
  if (font.widthOfTextAtSize(title, size) <= maxWidth) return title;
  const characters = [...title];
  let text = '';
  for (const character of characters) {
    if (font.widthOfTextAtSize(text + character + ellipsis, size) > maxWidth) break;
    text += character;
  }
  return `${text}${ellipsis}`;
}

/**
 * Build a real contents page: pages are inserted into `doc`, entries are laid
 * out with a dot leader, page numbers are right-aligned, and each row that has
 * a destination carries one `/Link` annotation that jumps to the bookmarked
 * page.
 *
 * An entry's number is its 1-based position in the **finished** document: a
 * target behind the insertion point has moved down by the number of pages
 * generated ahead of it. `pagesBefore` replaces that shift when the caller
 * declares more front matter than the contents pages themselves; the document's
 * page-label dictionary is not consulted.
 */
export async function generateTocPage(
  doc: PDFDocument,
  opts: TocOptions,
): Promise<PDFPage[]> {
  const rows = flattenOutline(opts.nodes ?? []);
  const pageCount = doc.getPageCount();
  const startPage = Math.min(Math.max(0, Math.trunc(opts.startPage ?? 0)), pageCount);
  const fontSize = opts.fontSize ?? 11;
  const leader = opts.leader ?? 'dots';
  const rightAlign = opts.rightAlignPageNumbers ?? true;
  const heading = opts.title === undefined ? 'Contents' : opts.title;
  const template = doc.getPage(Math.min(startPage, Math.max(0, pageCount - 1)));
  const box = template ? cropBox(template) : { x: 0, y: 0, width: PAGE_SIZES.a4[0], height: PAGE_SIZES.a4[1] };
  const width = template?.getWidth() ?? PAGE_SIZES.a4[0];
  const height = template?.getHeight() ?? PAGE_SIZES.a4[1];

  const allText = `${rows.map((row) => row.title).join('\n')}\n${heading}`;
  const [bodyFont, headFont] = await Promise.all([
    getFont(doc, { text: allText, size: fontSize }),
    getFont(doc, { text: heading || 'Contents', size: fontSize * 1.6, bold: true }),
  ]);

  const margin = 48;
  const left = box.x + margin;
  const right = box.x + Math.max(margin * 2, box.width - margin);
  const top = box.y + box.height - margin;
  const bottom = box.y + margin;
  const lineHeight = Math.max(fontSize * 1.8, 16);
  const indent = fontSize * 1.4;
  const gap = fontSize * 0.6;

  const pages: PDFPage[] = [];
  let y = 0;
  const openPage = (): PDFPage => {
    const fresh = doc.insertPage(startPage + pages.length, [width, height]);
    pages.push(fresh);
    y = top;
    if (heading) {
      y -= fontSize * 1.6;
      fresh.drawText(heading, {
        x: left,
        y,
        size: fontSize * 1.6,
        font: headFont,
      });
      y -= lineHeight;
    } else {
      y -= lineHeight * 0.5;
    }
    return fresh;
  };

  // `pagesBefore` plus the pages being inserted is the shift every target page
  // sees, and that total is unknown until the last row is laid out — so rows
  // are positioned first and drawn once the page count is final.
  const drawn: { page: PDFPage; row: TocRow; y: number }[] = [];
  let current = openPage();
  for (const row of rows) {
    if (y - lineHeight < bottom) current = openPage();
    y -= lineHeight;
    drawn.push({ page: current, row, y });
  }

  const inserted = pages.length;
  const declaredBefore = Math.max(0, Math.trunc(opts.pagesBefore ?? 0));
  // Only the generated pages that land ahead of a target move it; an entry
  // pointing at the cover page in front of `startPage` keeps its position.
  const shiftedBy = (page: number): number => (page < startPage ? 0 : inserted);
  const displayedPage = (page: number): number =>
    page + 1 + Math.max(declaredBefore, shiftedBy(page));

  for (const item of drawn) {
    const node = item.page;
    const row = item.row;
    const x = left + row.level * indent;
    const label = row.page === null ? '' : String(displayedPage(row.page));
    const labelWidth = label ? bodyFont.widthOfTextAtSize(label, fontSize) : 0;
    const available = Math.max(fontSize, right - x - (label ? labelWidth + gap : 0));
    const title = clip(row.title, bodyFont, fontSize, available);
    const titleWidth = bodyFont.widthOfTextAtSize(title, fontSize);

    await drawTextU(node, {
      text: title,
      x,
      y: item.y,
      size: fontSize,
      color: rgb(0, 0, 0),
    });

    if (label) {
      const labelX = rightAlign ? right - labelWidth : x + titleWidth + gap;
      if (leader === 'dots') {
        const leaderStart = x + titleWidth + gap / 2;
        const leaderEnd = Math.max(leaderStart, labelX - gap / 2);
        node.drawLine({
          start: { x: leaderStart, y: item.y + fontSize * 0.28 },
          end: { x: leaderEnd, y: item.y + fontSize * 0.28 },
          thickness: 0.4,
          color: rgb(0.55, 0.55, 0.55),
          dashArray: [1, 2.5],
        });
      }
      await drawTextU(node, {
        text: label,
        x: labelX,
        y: item.y,
        size: fontSize,
        color: rgb(0, 0, 0),
      });
    }

    if (row.page !== null) {
      const target = row.page + shiftedBy(row.page);
      if (target >= 0 && target < doc.getPageCount()) {
        const targetRef = doc.context.getObjectRef(doc.getPage(target).node);
        const link = node.drawLink({
          x,
          y: item.y - fontSize * 0.25,
          width: Math.max(titleWidth, 1),
          height: lineHeight * 0.8,
          pageNumber: target,
        });
        // The destination is written as a `/GoTo` action on top of the `/Dest`
        // entry: where a reader understands both, `/A` is the one it obeys, and
        // both name the same page — not two guesses at it.
        if (targetRef) {
          doc.context.lookupMaybe(link, PDFDict)?.set(
            PDFName.of('A'),
            doc.context.obj({ S: 'GoTo', D: [targetRef, 'XYZ', null, null, null] }),
          );
        }
      }
    }
  }

  return pages;
}

// ---------------------------------------------------------------------------
// Page labels
// ---------------------------------------------------------------------------

export interface PageLabelRange {
  /** 0-based index of the first page this range covers. */
  start: number;
  /**
   * The `/S` name: `D` decimal, `R`/`r` roman, `A`/`a` letters, `''` for no `/S` at
   * all (§12.4.2 makes the style optional, and a range with only a `/P` shows the
   * prefix and no number).
   *
   * It is a plain string rather than the six names `add-page-labels` offers because
   * a **page copy** carries whatever the file stored. `/S /G` is not a style the
   * format defines, and MuPDF, pypdf and this app already give it three different
   * answers (see `docs/research/readers-foreign-repro.md`); a copy that rewrote it
   * would be taking a side in that disagreement, so it keeps the name and formats
   * it the way this app formats any style it does not know: decimal.
   */
  style: string;
  prefix?: string;
  /** Number shown on `start` itself (1-based, PDF `/St`). Defaults to 1. */
  firstPageNumber?: number;
}

export interface PageLabel {
  page: number;
  label: string;
}

/** One sheet a page copy placed: where it came from, and where it landed. */
export interface PagePlacement {
  /** Page index in the document the sheet was copied **from**. */
  source: number;
  /** Page index of that sheet in the document the copy is building. */
  dest: number;
}

const ROMAN: [number, string][] = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
  [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
];

function toRoman(value: number): string {
  if (value <= 0 || value >= 4000) return String(value);
  let rest = value;
  let out = '';
  for (const [amount, symbol] of ROMAN) {
    while (rest >= amount) {
      out += symbol;
      rest -= amount;
    }
  }
  return out;
}

/** Bijective base 26: 1 → A, 26 → Z, 27 → AA. */
function toLetters(value: number): string {
  if (value <= 0) return String(value);
  let rest = value;
  let out = '';
  while (rest > 0) {
    rest--;
    out = String.fromCharCode(65 + (rest % 26)) + out;
    rest = Math.floor(rest / 26);
  }
  return out;
}

function formatLabelNumber(style: PageLabelRange['style'], value: number): string {
  switch (style) {
    case 'R':
      return toRoman(value);
    case 'r':
      return toRoman(value).toLowerCase();
    case 'A':
      return toLetters(value);
    case 'a':
      return toLetters(value).toLowerCase();
    case 'D':
    case '':
    default:
      return String(value);
  }
}

function labelDict(doc: PDFDocument, range: PageLabelRange): PDFDict {
  const ctx = context(doc);
  const dict = ctx.obj({});
  if (range.prefix) dict.set(PDFName.of('P'), PDFHexString.fromText(range.prefix));
  if (range.style !== '') dict.set(PDFName.of('S'), PDFName.of(range.style));
  if (range.firstPageNumber !== undefined && range.firstPageNumber !== 1) {
    dict.set(PDFName.of('St'), PDFNumber.of(Math.max(1, Math.trunc(range.firstPageNumber))));
  }
  return dict;
}

/**
 * Write the catalog `/PageLabels` number tree, replacing any existing one.
 * Passing an empty array removes page labels altogether.
 *
 * This is the validating front door — what `add-page-labels` uses. The copy path
 * calls `writePageLabelRanges` instead, because a range it read out of a foreign
 * file may name a style this app would refuse to *invent*.
 */
export function addPageLabels(
  doc: PDFDocument,
  ranges: PageLabelRange[],
): void {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const starts = new Set<number>();
  for (const range of sorted) {
    if (!Number.isInteger(range.start) || range.start < 0) {
      throw new Error('Page-label ranges need a whole, non-negative start page.');
    }
    if (starts.has(range.start)) {
      throw new Error(`Two page-label ranges start at page ${range.start + 1}.`);
    }
    starts.add(range.start);
    if (!['D', 'R', 'r', 'A', 'a', ''].includes(range.style)) {
      throw new Error(
        `"${range.style}" is not a page-number style. Use D, R, r, A, a, or leave it empty.`,
      );
    }
  }
  writePageLabelRanges(doc, sorted);
}

/**
 * Write the catalog `/PageLabels` as a flat `/Nums` number tree, replacing any
 * existing one. An empty list removes the entry rather than writing an empty tree.
 *
 * A flat array is one of the two shapes §7.9.7 allows and the one every reader met
 * here accepts; the `/Kids` form a producer may use on the way *in* is why reading
 * goes through `core/tree.ts` rather than through this writer.
 */
export function writePageLabelRanges(
  doc: PDFDocument,
  ranges: PageLabelRange[],
): void {
  const ctx = context(doc);
  const existing = doc.catalog.get(PDFName.of('PageLabels'));
  const existingRef = existing instanceof PDFRef ? existing : undefined;
  doc.catalog.delete(PDFName.of('PageLabels'));
  if (existingRef) ctx.delete(existingRef);
  if (ranges.length === 0) return;

  const nums = ctx.obj([]);
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    nums.push(PDFNumber.of(range.start));
    nums.push(labelDict(doc, range));
  }
  const tree = ctx.obj({});
  tree.set(PDFName.of('Nums'), nums);
  doc.catalog.set(PDFName.of('PageLabels'), ctx.register(tree));
}

/**
 * The `/PageLabels` ranges a document stores, in page order.
 *
 * `[]` for "no numbering", which covers both an absent `/PageLabels` and a tree
 * with no pairs in it; a caller that has to keep an unlabelled file unlabelled
 * (`core/doc.ts:carryPageFurniture`) can therefore test the one answer it cares
 * about instead of reaching for the catalogue.
 */
export function readPageLabelRanges(doc: PDFDocument): PageLabelRange[] {
  const tree = dictAt(doc, doc.catalog, 'PageLabels');
  const ranges: PageLabelRange[] = [];
  for (const pair of collectTreePairs(doc, tree)) {
    const start = followRef(doc, pair.key);
    const dict = asDict(followRef(doc, pair.value));
    if (!(start instanceof PDFNumber) || !dict) continue;
    const offset = followRef(doc, dict.get(PDFName.of('St')));
    // An empty `/S` name (`/S /`) is not a style, so it reads as no `/S`: the same
    // answer `labelDict` gives when it writes this range back out.
    const style = nameOf(followRef(doc, dict.get(PDFName.of('S')))) ?? '';
    ranges.push({
      start: Math.max(0, Math.trunc(start.asNumber())),
      style,
      prefix: textOf(followRef(doc, dict.get(PDFName.of('P')))) ?? '',
      firstPageNumber: offset instanceof PDFNumber ? offset.asNumber() : 1,
    });
  }
  ranges.sort((a, b) => a.start - b.start);
  return ranges;
}

/** The range in force on `page`: the last one starting at or before it. */
function coveringRange(
  ranges: PageLabelRange[],
  page: number,
): PageLabelRange | undefined {
  let range: PageLabelRange | undefined;
  for (const candidate of ranges) {
    if (candidate.start <= page) range = candidate;
    else break;
  }
  return range;
}

/**
 * Expand `/PageLabels` into one label per page (decimal when none are set).
 *
 * The store is a **number tree** (§7.9.7): `/Nums` pairs, `/Kids` subtrees, or both at
 * once, with each value either a range dictionary or a reference to one. Reading the
 * root's `/Nums` and nothing else is what made a labelled document look unlabelled —
 * `docs/research/readers-foreign-repro.md` has the per-shape table.
 *
 * A range with **no `/S`** contributes its prefix and no number, which is what §12.4.2
 * Table 160 says and what both MuPDF and pypdf answer — and it is the shape this app's
 * own `add-page-labels` writes for its `none` style, so an answer that added a number
 * here would contradict the file this app wrote.
 */
export function readPageLabels(doc: PDFDocument): PageLabel[] {
  const ranges = readPageLabelRanges(doc);
  const labels: PageLabel[] = [];
  const total = doc.getPageCount();
  for (let page = 0; page < total; page++) {
    const range = coveringRange(ranges, page);
    if (!range) {
      labels.push({ page, label: String(page + 1) });
      continue;
    }
    const value = (range.firstPageNumber ?? 1) + (page - range.start);
    labels.push({
      page,
      label: range.style !== ''
        ? `${range.prefix ?? ''}${formatLabelNumber(range.style, Math.max(1, value))}`
        : (range.prefix ?? ''),
    });
  }
  return labels;
}

/** What a page copy did with a document's page numbering. */
export interface RemappedLabels {
  /** Ranges addressed in the **destination** document, in page order. */
  ranges: PageLabelRange[];
  /** Ranges the copy left with no sheet to number. */
  dropped: number;
}

/**
 * Re-point `/PageLabels` ranges at the pages a copy placed in a new document.
 *
 * A range is a statement about **source page indices**: `/Start` says where it begins
 * and `/St` says what number is printed there, and §12.4.2 runs it to the next range
 * or the end of the file. Carrying those two numbers across unchanged is the naive
 * answer, and it is wrong in the way that looks right: extract pages 4-6 of a book and
 * the output has three sheets whose ranges start at 2, 4 and 5, so the first two sheets
 * name no range at all and the numbering that survives is the fallback — `1, 2` where
 * the file said `II, c`.
 *
 * So each **destination** sheet is asked which source range covered it, and a range is
 * opened again whenever the answer changes shape. Two sheets share one output range
 * only while *both* indices step by one: `12.4.2` gives every sheet after a range's
 * `/Start` the next number, which is true of the copy only if its sheets come from
 * consecutive pages of the source. That is what makes a reorder, a duplicate, a blank
 * inserted between two labelled sheets, and a subset whose first sheet is the middle of
 * a range all come out right, one label per sheet, instead of merely legal.
 *
 * A range whose pages were **all** discarded disappears (§12.4.2 gives it nowhere to
 * start), and it is counted so the tool can say so. A document with no numbering
 * contributes nothing: `writePageLabelRanges` is only called when something came back,
 * so an unlabelled file stays unlabelled rather than being given one this app invented.
 */
export function remapPageLabelRanges(
  sources: { ranges: PageLabelRange[]; placed: PagePlacement[] }[],
  destinationPages: number,
): RemappedLabels {
  const carried: PageLabelRange[] = [];
  /** Destination sheets that came out of some source range. */
  const claimed = new Set<number>();
  let dropped = 0;

  for (const { ranges, placed } of sources) {
    const ordered = [...ranges].sort((a, b) => a.start - b.start);
    const used = new Set<PageLabelRange>();
    let previous: { range: PageLabelRange; source: number; dest: number } | undefined;
    for (const { source, dest } of [...placed].sort((a, b) => a.dest - b.dest)) {
      const range = coveringRange(ordered, source);
      if (!range) continue;
      used.add(range);
      claimed.add(dest);
      // Two neighbouring sheets share a range only while **both** indices step by one:
      // §12.4.2 hands the next number to the next page, which is the same sheet's
      // successor only if the copy did not reorder, duplicate or space them out.
      const continues = previous !== undefined
        && previous.range === range
        && previous.source + 1 === source
        && previous.dest + 1 === dest;
      previous = { range, source, dest };
      if (continues) continue;
      carried.push({
        start: dest,
        style: range.style,
        prefix: range.prefix ?? '',
        // The number this sheet carried in the source, printed at the sheet's new
        // address: `/Start` moves, and `/St` moves with it.
        firstPageNumber: (range.firstPageNumber ?? 1) + (source - range.start),
      });
    }
    dropped += ordered.length - used.size;
  }

  // A sheet with no range of its own — a blank the tool inserted, or the pages of a
  // merged file that numbers nothing — still falls under the last range that started
  // above it, because §12.4.2 runs a range to the end of the document. Naming its
  // position out loud is what keeps such a sheet reading `7` where it read `7` at home,
  // rather than continuing somebody else's roman numerals.
  for (let dest = 1; dest < destinationPages; dest++) {
    if (!claimed.has(dest) && claimed.has(dest - 1)) {
      carried.push({ start: dest, style: 'D', prefix: '', firstPageNumber: dest + 1 });
    }
  }
  carried.sort((a, b) => a.start - b.start);
  return { ranges: carried, dropped };
}

// ---------------------------------------------------------------------------
// Bates numbering
// ---------------------------------------------------------------------------

export interface BatesOptions {
  /**
   * Stamp text with tokens: `{n}` sequence number, `{org}` organisation,
   * `{page}`/`{total}` page position, `{date}`/`{time}` stamp time. An
   * unrecognised token is left in the output verbatim and reported in
   * `unknownTokens`.
   */
  format: string;
  start: number;
  increment: number;
  sequenceDigits: number;
  prefix?: string;
  suffix?: string;
  fontFamily?: string;
  fontSize: number;
  /** `#rgb` / `#rrggbb`. */
  color: string;
  /**
   * One of nine anchors — `top-left`, `top-center`, `top-right`, `middle-left`,
   * `center`, `middle-right`, `bottom-left`, `bottom-center`, `bottom-right` —
   * case, space and dash insensitive, with `left`/`right`/`top`/`bottom` as
   * aliases for the edge midpoints. Append `,x,y` for explicit margins in
   * points, e.g. `bottom-right,72,36`. Anchors are measured against the visible
   * page (crop box, after `/Rotate`). Defaults to `bottom-right`.
   */
  position: string;
  /** `resolvePages` grammar: `'1,3,5-7'`, `'odd'`, `'all'`, … */
  pages: string | 'all';
  /** Pages that share one sequence number (Bates "unit" size). Defaults to 1. */
  unitOffset?: number;
  /**
   * Take `{n}` from the page's position in the **whole document** — page 1 gets
   * `start` — instead of from the first page of the selection. Unselected pages
   * always consume their own numbers, so a batch stamped in pieces keeps one
   * sequence; this only decides where `start` sits.
   */
  crossDocument?: boolean;
}

export interface BatesResult {
  stamped: number;
  /** Tokens like `{foo}` that this function does not know, deduplicated. */
  unknownTokens: string[];
}

type Anchor = [
  horizontal: 'left' | 'center' | 'right',
  vertical: 'top' | 'middle' | 'bottom',
];

const POSITION_WORDS: Record<string, Anchor> = {
  'topleft': ['left', 'top'],
  'topcenter': ['center', 'top'],
  'top': ['center', 'top'],
  'topright': ['right', 'top'],
  'middleleft': ['left', 'middle'],
  'left': ['left', 'middle'],
  'center': ['center', 'middle'],
  'middle': ['center', 'middle'],
  'centremiddle': ['center', 'middle'],
  'middleright': ['right', 'middle'],
  'right': ['right', 'middle'],
  'bottomleft': ['left', 'bottom'],
  'bottomcenter': ['center', 'bottom'],
  'bottom': ['center', 'bottom'],
  'bottomright': ['right', 'bottom'],
};

function parsePosition(position: string): { anchor: Anchor; offsets: [number, number] } {
  const parts = (position ?? '').split(',').map((p) => p.trim());
  const word = (parts[0] ?? 'bottom-right').toLowerCase().replace(/[\s_-]+/g, '');
  const anchor = POSITION_WORDS[word] ?? (['right', 'bottom'] as Anchor);
  const dx = Number.parseFloat(parts[1]);
  const dy = Number.parseFloat(parts[2]);
  return {
    anchor,
    offsets: [
      Number.isFinite(dx) ? Math.max(0, dx) : DEFAULT_STAMP_MARGIN,
      Number.isFinite(dy) ? Math.max(0, dy) : DEFAULT_STAMP_MARGIN,
    ],
  };
}

/**
 * Where a stamp's text origin sits in user space, given an anchor measured on
 * the **visible** page (crop box, after `/Rotate`).
 *
 * Rotating a page clockwise by 90° maps user `(x, y)` to display `(y, W - x)`,
 * so the inverse turns a visible anchor back into content coordinates, and text
 * that reads level on screen is drawn at the same angle as the page rotation.
 */
function stampOrigin(
  page: PDFPage,
  displayX: number,
  displayY: number,
): { x: number; y: number; rotation: number } {
  const box = cropBox(page);
  const rotation = ((((page.getRotation().angle % 360) + 360) % 360)) as 0 | 90 | 180 | 270;
  const user =
    rotation === 90
      ? { x: box.width - displayY, y: displayX }
      : rotation === 180
        ? { x: box.width - displayX, y: box.height - displayY }
        : rotation === 270
          ? { x: displayY, y: box.height - displayX }
          : { x: displayX, y: displayY };
  return { x: box.x + user.x, y: box.y + user.y, rotation };
}

function padSequence(value: number, digits: number): string {
  const sign = value < 0 ? '-' : '';
  return sign + Math.abs(value).toString().padStart(Math.max(1, digits), '0');
}

function two(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Stamp Bates numbers (or any production code) onto pages with full Unicode
 * support — the text goes through `drawTextU`, so `{org}` may be Cyrillic, CJK
 * or emoji without the `WinAnsi cannot encode` crash the standard fonts give.
 *
 * `{n}` steps with the document's page order, not with the count of pages
 * stamped: an unselected page still consumes its number, so a production
 * stamped in batches ends up matching its physical pages. `start` belongs to
 * the first page of the selection unless `crossDocument` counts from page 1.
 *
 * `{org}` resolves from the document information dictionary: `Author`, then
 * `Creator`, then `Title`, then empty — a Bates stamp has no other place to
 * learn the organisation.
 */
export async function addBatesNumbers(
  doc: PDFDocument,
  opts: BatesOptions,
): Promise<BatesResult> {
  const total = doc.getPageCount();
  const targets = resolvePages(opts.pages ?? 'all', total);
  const format = opts.format ?? '{n}';
  const { anchor, offsets } = parsePosition(opts.position);
  const color = parseHexColor(opts.color) ?? rgb(0, 0, 0);
  const fontSize = opts.fontSize > 0 ? opts.fontSize : 9;
  const unitSize = Math.max(1, Math.trunc(opts.unitOffset ?? 1));
  const now = new Date();
  const stampDate = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
  const stampTime = `${two(now.getHours())}:${two(now.getMinutes())}`;

  const info = readInfo(doc);
  const organisation = info.author ?? info.creator ?? info.title ?? '';
  // `{n}` steps with the document's page order, so an unselected page still
  // consumes its own number. `start` then belongs to page 1 of the document
  // when `crossDocument` is set, and to the first page of the selection when
  // it is not.
  const numberingBase = opts.crossDocument ? 0 : (targets[0] ?? 0);

  const unknown = new Set<string>();
  for (const match of format.matchAll(/\{\s*([^{}]+?)\s*\}/g)) {
    const token = match[1];
    if (!['n', 'org', 'page', 'total', 'date', 'time'].includes(token)) {
      unknown.add(`{${token}}`);
    }
  }

  const stampText = (position: number, absoluteIndex: number): string =>
    format.replace(/\{\s*(n|org|page|total|date|time)\s*\}/g, (whole, token: string) => {
      switch (token) {
        case 'n':
          return padSequence(
            (opts.start ?? 0) + (opts.increment ?? 1) * Math.floor(position / unitSize),
            opts.sequenceDigits ?? 6,
          );
        case 'org':
          return organisation;
        case 'page':
          return String(absoluteIndex + 1);
        case 'total':
          return String(total);
        case 'date':
          return stampDate;
        case 'time':
          return stampTime;
        default:
          return whole;
      }
    });

  const stampLine = (absoluteIndex: number): string =>
    `${opts.prefix ?? ''}${stampText(absoluteIndex - numberingBase, absoluteIndex)}${opts.suffix ?? ''}`;

  const [horizontal, vertical] = anchor;
  const jobs = targets.map((absoluteIndex) => {
    const page = doc.getPage(absoluteIndex);
    const text = stampLine(absoluteIndex);
    return measureText(doc, { text, size: fontSize, x: 0, y: 0, fontFamily: opts.fontFamily }).then(
      ({ width }) => {
        const displayed = displayedSize(page);
        const displayX =
          horizontal === 'left'
            ? offsets[0]
            : horizontal === 'center'
              ? (displayed.width - width) / 2
              : displayed.width - offsets[0] - width;
        const displayY =
          vertical === 'top'
            ? displayed.height - offsets[1] - fontSize
            : vertical === 'middle'
              ? (displayed.height - fontSize) / 2
              : offsets[1];
        const origin = stampOrigin(page, displayX, displayY);
        return drawTextU(page, {
          text,
          x: origin.x,
          y: origin.y,
          size: fontSize,
          color,
          fontFamily: opts.fontFamily,
          rotation: origin.rotation === 0 ? undefined : origin.rotation,
        });
      },
    );
  });

  await Promise.all(jobs);
  return { stamped: jobs.length, unknownTokens: [...unknown] };
}
