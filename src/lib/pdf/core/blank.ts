/**
 * Blank-page detection and page-content measurement.
 *
 * A page is blank when it paints nothing: no text runs, no image or path
 * operators, no visible annotations. Testing only for text would wrongly drop
 * a page holding a scanned image or a signature.
 */
import type { PDFDocument, PDFPage } from '@maxwbh/pdf-lib';
import { OPS } from 'pdfjs-dist';
import { cropBox, mediaBox } from './pages';
import type { PdfSession } from './render';

export interface PageContentProfile {
  page: number;
  textItems: number;
  /** Text runs with an invisible render mode (an existing OCR layer). */
  invisibleTextItems: number;
  paintOps: number;
  images: number;
  annotationRects: number;
  inkArea: number;
  blankByContent: boolean;
  /** True when the page holds only invisible OCR text. */
  blankByAppearance: boolean;
}

/**
 * The display-list operators that put ink on a page.
 *
 * pdf.js numbers its operator list with `OPS`, whose keys are *semantic* names
 * (`showText`), not the mnemonics a content stream uses (`Tj`). This module used
 * to compare mnemonics against a reverse lookup of `operators.ops` — a property
 * `getOperatorList()` never returns — so nothing ever matched, `paintOps` was
 * always 0 and every page without annotations was called blank: "Remove blank
 * pages" would have deleted a text document's pages, and a scan, while claiming
 * they painted nothing (E13). The ids are resolved once from the same table the
 * renderer works from.
 */
const PAINTING_OPS: Set<number> = operatorIds([
  'stroke', 'closeStroke', 'fill', 'eoFill', 'fillStroke', 'eoFillStroke',
  'closeFillStroke', 'closeEOFillStroke', 'shadingFill', 'paintXObject',
  'beginInlineImage',
  'showText', 'showSpacedText', 'nextLineShowText', 'nextLineSetSpacingShowText',
]);

/** Operators that paint raster — a scanned page is ink, not a blank sheet. */
const IMAGE_OPS: Set<number> = operatorIds([
  'paintXObject', 'beginInlineImage', 'paintImageXObject', 'paintInlineImageXObject',
  'paintImageMaskXObject', 'paintImageXObjectRepeat', 'paintInlineImageXObjectGroup',
  'paintImageMaskXObjectGroup', 'paintImageMaskXObjectRepeat', 'paintSolidColorImageMask',
]);

/**
 * Profile one page from pdf.js. `getOperatorList` gives the display list the
 * renderer consumes, so inline images, XObjects and every fill/stroke operator
 * are counted without decoding the stream by hand.
 */
export async function profilePage(
  session: PdfSession,
  page: number,
  options: { annotationRects?: number } = {},
): Promise<PageContentProfile> {
  const proxy = await session.page(page);
  let profile: PageContentProfile;
  try {
    const viewport = proxy.getViewport({ scale: 1 });
    const [content, operators] = await Promise.all([
      proxy.getTextContent(),
      proxy.getOperatorList(),
    ]);
    let textItems = 0;
    let invisible = 0;
    for (const item of content.items) {
      if (!('str' in item)) continue;
      if (item.str.trim() === '') continue;
      textItems += 1;
      const size = Math.hypot(item.transform[0], item.transform[1]);
      if (size === 0) invisible += 1;
    }
    let paintOps = 0;
    let images = 0;
    let inkArea = 0;
    const ops = operators.fnArray;
    for (let i = 0; i < ops.length; i++) {
      const id = ops[i];
      if (PAINTING_OPS.has(id)) paintOps += 1;
      if (IMAGE_OPS.has(id)) {
        images += 1;
        const args = operators.argsArray[i];
        inkArea += estimateImageArea(args, viewport.width, viewport.height);
      }
    }
    const annotationRects = options.annotationRects ?? 0;
    const visibleText = textItems - invisible;
    profile = {
      page,
      textItems,
      invisibleTextItems: invisible,
      paintOps,
      images,
      annotationRects,
      inkArea,
      blankByContent: paintOps === 0 && visibleText === 0 && annotationRects === 0,
      blankByAppearance:
        (paintOps === 0 || (images === 0 && visibleText === 0)) && annotationRects === 0,
    };
  } finally {
    proxy.cleanup();
  }
  return profile;
}

function estimateImageArea(args: unknown, fallbackW: number, fallbackH: number): number {
  const record = args as Record<string, unknown> | undefined;
  const width = typeof record?.width === 'number' ? record.width : fallbackW;
  const height = typeof record?.height === 'number' ? record.height : fallbackH;
  return width * height;
}

/**
 * Resolve names to pdf.js's numeric operator ids.
 *
 * SAFETY: `OPS` is the frozen name → id table the renderer and the worker are
 * both built from, so reading it by name is the same mapping the display list is
 * encoded with; the index signature is only how TypeScript is told that.
 */
function operatorIds(names: string[]): Set<number> {
  const table = OPS as unknown as Record<string, number>;
  const ids = new Set<number>();
  for (const name of names) {
    const id = table[name];
    if (typeof id === 'number') ids.add(id);
  }
  return ids;
}

export interface BlankPageOptions {
  /** Fraction of the page area that may hold ink before it counts as used. */
  inkThreshold?: number;
  /** Treat a page carrying only annotations as non-blank. */
  keepAnnotated?: boolean;
}

/** Identify blank pages. Returns 1-based page numbers. */
export async function findBlankPages(
  session: PdfSession,
  doc: PDFDocument,
  options: BlankPageOptions = {},
  onProgress?: (done: number, total: number) => void,
  shouldAbort?: () => boolean,
): Promise<{ blank: number[]; profiles: PageContentProfile[] }> {
  const keepAnnotated = options.keepAnnotated ?? true;
  const blank: number[] = [];
  const profiles: PageContentProfile[] = [];
  for (let page = 1; page <= session.numPages; page++) {
    if (shouldAbort?.()) break;
    const annotationRects = keepAnnotated ? countVisibleAnnotations(doc, page - 1) : 0;
    const profile = await profilePage(session, page, { annotationRects });
    profiles.push(profile);
    if (profile.blankByAppearance) blank.push(page);
    onProgress?.(page, session.numPages);
  }
  return { blank, profiles };
}

function countVisibleAnnotations(doc: PDFDocument, pageIndex: number): number {
  const page = doc.getPage(pageIndex);
  const annots = readAnnotsArray(page);
  if (!annots) return 0;
  let count = 0;
  for (let i = 0; i < annots.size(); i++) {
    const resolved = resolveAnnotation(doc, annots.get(i));
    if (resolved && !isHiddenAnnotation(resolved)) count += 1;
  }
  return count;
}

/**
 * pdf-lib exposes `/Annots` as a `PDFArray | PDFRef | undefined` through a
 * generated accessor whose public type is an opaque `PDFObject` union, so the
 * array is narrowed here once instead of at every call site.
 */
/**
 * A PDF object reference or inline dictionary, as returned by the generated
 * `/Annots` accessor.
 */
type AnnotationEntry = { toString(): string } | AnnotationDict;

interface MaybePdfArray {
  size(): number;
  get(index: number): AnnotationEntry;
}

interface PdfPageNodeWithAnnots {
  Annots?: () => MaybePdfArray | null;
}

function readAnnotsArray(page: PDFPage): MaybePdfArray | null {
  // SAFETY: `PDFPageLeaf.Annots()` always returns a `PDFArray` (or throws when
  // the inherited value is not an array); only `size`/`get` are used, so the
  // narrower structural view is sound.
  const node = page.node as unknown as PdfPageNodeWithAnnots;
  try {
    return node.Annots?.() ?? null;
  } catch {
    return null;
  }
}

interface AnnotationDict {
  lookup?: (key: string) => unknown;
  get?: (key: string) => unknown;
  has?: (key: string) => boolean;
}

/** Indirect annotation references must be resolved through the context. */
interface PdfContextLookup {
  lookup: (ref: unknown) => unknown;
  obj: (num: number, gen: number) => unknown;
}

function pdfContext(doc: PDFDocument): PdfContextLookup {
  // SAFETY: `PDFContext` always exposes `obj(num, gen)` and `lookup(ref)`; the
  // public class declares them but the union returned by `get`/`lookup` is
  // typed as `PDFObject`, so only the two methods needed here are named.
  return doc.context as unknown as PdfContextLookup;
}

function isAnnotationDict(value: AnnotationEntry): value is AnnotationDict {
  const candidate = value as AnnotationDict;
  return typeof candidate.get === 'function' || typeof candidate.lookup === 'function';
}

function resolveAnnotation(doc: PDFDocument, ref: AnnotationEntry): AnnotationDict | null {
  if (!ref) return null;
  if (isAnnotationDict(ref) && readName(ref, 'Subtype')) return ref;
  const text = ref.toString?.() ?? String(ref);
  const match = /^(\d+)\s+0\s+R$/.exec(text.trim());
  if (!match) return null;
  const context = pdfContext(doc);
  const resolved = context.lookup(context.obj(Number(match[1]), Number(match[2])));
  return resolved && isAnnotationDict(resolved as AnnotationEntry) ? (resolved as AnnotationDict) : null;
}

function readName(dict: AnnotationDict, key: string): string | null {
  const raw = dict.get?.(key) ?? dict.lookup?.(key);
  if (raw === undefined || raw === null) return null;
  const text = String((raw as { toString?: () => string }).toString?.() ?? raw);
  return text ? text.replace(/^\//, '') : null;
}

function readNumber(dict: AnnotationDict, key: string): number {
  const raw = dict.get?.(key) ?? dict.lookup?.(key);
  if (raw === undefined || raw === null) return 0;
  const text = String((raw as { toString?: () => string }).toString?.() ?? raw);
  const value = Number(text.trim());
  return Number.isFinite(value) ? value : 0;
}

/** Annotation flag bits 2 (Invisible), 4 (Hidden) and 128 (NoView). */
function isHiddenAnnotation(dict: AnnotationDict): boolean {
  const flags = readNumber(dict, 'F');
  const INVISIBLE = 1 << 1;
  const HIDDEN = 1 << 7;
  const NO_VIEW = 1 << 2;
  return (flags & (INVISIBLE | HIDDEN | NO_VIEW)) !== 0;
}

/** Effective drawn area of a page in square points, after /Rotate. */
export function pageArea(page: PDFPage): number {
  const box = cropBox(page);
  const media = mediaBox(page);
  const area = (box.width || media.width) * (box.height || media.height);
  return Number.isFinite(area) ? area : 0;
}
