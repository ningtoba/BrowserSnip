/**
 * Blank-page detection and page-content measurement.
 *
 * A page is blank when it paints nothing: no text runs, no image or path
 * operators, no visible annotations. Testing only for text would wrongly drop
 * a page holding a scanned image or a signature.
 */
import type { PDFDocument, PDFPage } from '@maxwbh/pdf-lib';
import { PDFName } from '@maxwbh/pdf-lib';
import { OPS } from 'pdfjs-dist';
import { cropBox, mediaBox, type PageBox } from './pages';
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
  // Raster is ink. pdf.js resolves `Do` on an image XObject to
  // `paintImageXObject` — never to `paintXObject`, which is a form's operator —
  // so before these ids a scanned page arrived with `paintOps === 0` and the
  // rule below called a photograph empty. Measured on the deployed build: a
  // 3-page, 2.3 MB scan-only file was refused with "All 3 pages look blank", and
  // in a mixed document the scan was deleted next to the true blanks, against
  // both this module's header note and the tool's own ("a scanned image or a
  // signature counts as ink").
  'paintImageXObject', 'paintInlineImageXObject', 'paintImageMaskXObject',
  'paintImageXObjectRepeat', 'paintInlineImageXObjectGroup',
  'paintImageMaskXObjectGroup', 'paintImageMaskXObjectRepeat',
  'paintSolidColorImageMask',
  'showText', 'showSpacedText', 'nextLineShowText', 'nextLineSetSpacingShowText',
]);

/** Operators that lay down a vector shape — a signature, a rule, a chart line. */
const STROKE_OR_FILL_OPS: Set<number> = operatorIds([
  'stroke', 'closeStroke', 'fill', 'eoFill', 'fillStroke', 'eoFillStroke',
  'closeFillStroke', 'closeEOFillStroke', 'shadingFill',
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
    let strokesOrFills = 0;
    let images = 0;
    let inkArea = 0;
    const ops = operators.fnArray;
    for (let i = 0; i < ops.length; i++) {
      const id = ops[i];
      if (PAINTING_OPS.has(id)) paintOps += 1;
      if (STROKE_OR_FILL_OPS.has(id)) strokesOrFills += 1;
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
      // The second branch is for a page that runs painting operators yet shows
      // nothing a reader would call ink — an existing OCR layer's invisible text
      // is the case it exists for. A stroke or a fill is ink (a signature, a
      // ruled line, a chart), so it now holds that branch shut; without that
      // guard a page whose only content is a 0.1 pt line was deleted.
      blankByAppearance:
        (paintOps === 0 || (images === 0 && visibleText === 0 && strokesOrFills === 0)) &&
        annotationRects === 0,
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
 * A name that no longer exists in `OPS` is skipped silently, which is why the
 * tables above are pinned by the browser measurement in `docs/TOOL-CAMPAIGN.md`
 * rather than trusted.
 */
function operatorIds(names: string[]): Set<number> {
  // SAFETY: `OPS` is the frozen name → id table the renderer and the worker are
  // both built from, so reading it by name is the same mapping the display list
  // is encoded with; the index signature is only how TypeScript is told that.
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
  const context = pdfContext(doc);
  const box = cropBox(page);
  let count = 0;
  for (let i = 0; i < annots.size(); i++) {
    const resolved = resolveAnnotation(doc, annots.get(i));
    if (resolved && isLiveAnnotation(context, resolved, box)) count += 1;
  }
  return count;
}

/**
 * An annotation counts as content only where a reader can meet it: the
 * invisible / hidden / no-view flags are off **and** `/Rect` lands on the page.
 *
 * The second half is what stops `keepAnnotated` degrading into "keep
 * everything". A mark parked at `[900 900 940 920]` on a 200 × 100 sheet is
 * clipped away by every viewer, so a sheet whose only annotation is off-page is
 * still blank; a rect that merely hangs over the edge is not, because part of
 * it draws. `/Rect` is in default user space, so the crop box is the right frame
 * whether or not the page carries `/Rotate`.
 *
 * An unreadable `/Rect` keeps the page. This is a deletion rule, and "I could
 * not place it" is not evidence that nothing is drawn.
 */
function isLiveAnnotation(
  context: PdfContextLookup,
  dict: AnnotationDict,
  box: PageBox,
): boolean {
  if (isHiddenAnnotation(dict)) return false;
  const rect = readRect(context, dict);
  if (!rect) return true;
  const [x1, y1, x2, y2] = rect;
  const left = Math.min(x1, x2);
  const right = Math.max(x1, x2);
  const bottom = Math.min(y1, y2);
  const top = Math.max(y1, y2);
  if (right <= left || top <= bottom) return false;
  return (
    right > box.x &&
    left < box.x + box.width &&
    top > box.y &&
    bottom < box.y + box.height
  );
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
  lookup?: (key: unknown) => unknown;
  get?: (key: unknown) => unknown;
  has?: (key: unknown) => boolean;
}

/** Indirect annotation references must be resolved through the context. */
interface PdfContextLookup {
  lookup: (ref: unknown) => unknown;
}

function pdfContext(doc: PDFDocument): PdfContextLookup {
  // SAFETY: `PDFContext.lookup(ref)` is public and always present; the value it
  // answers is the opaque `PDFObject` union, which is narrowed by
  // `isAnnotationDict` rather than by the return type.
  return doc.context as unknown as PdfContextLookup;
}

function isAnnotationDict(value: unknown): value is AnnotationDict {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AnnotationDict>;
  return typeof candidate.get === 'function' || typeof candidate.lookup === 'function';
}

/**
 * The `/Annots` array holds `PDFRef` objects in the ordinary case, and
 * `PDFContext.lookup(ref)` resolves one directly. This used to round-trip the
 * entry through `toString()` and rebuild it with `context.obj(num, gen)`, but in
 * this fork `obj()` is the *literal* helper — `ctx.obj(20, 0)` answers a
 * `PDFNumber` (measured: `constructor.name === 'PDFNumber'`, `String(...) ===
 * "20"`), which is not a dictionary. Every referenced annotation therefore
 * resolved to nothing, `annotationRects` was always 0, and "keep pages that only
 * hold annotations" was a toggle over nothing.
 */
function resolveAnnotation(doc: PDFDocument, entry: AnnotationEntry): AnnotationDict | null {
  if (!entry) return null;
  if (isAnnotationDict(entry) && readName(entry, 'Subtype')) return entry;
  const resolved = pdfContext(doc).lookup(entry);
  return isAnnotationDict(resolved) ? resolved : null;
}

function readName(dict: AnnotationDict, key: string): string | null {
  const raw = dictGet(dict, key);
  if (!raw) return null;
  return String(raw).replace(/^\//, '') || null;
}

/**
 * `PDFDict` is keyed by `PDFName` *instances*, so a plain string key never hits:
 * `dict.get('Subtype')` answers undefined for every dictionary in the file, and
 * `/Subtype` and `/F` read as absent on annotations that plainly carry them.
 * `lookup` is asked before `get` because it resolves a value parked behind a
 * reference — an annotation dictionary written as `/Rect 12 0 R` is legal.
 */
function dictGet(dict: AnnotationDict, key: string): AnnotationValue | null {
  const name = PDFName.of(key);
  const raw = dict.lookup?.(name) ?? dict.get?.(name);
  return raw === undefined || raw === null ? null : (raw as AnnotationValue);
}

/** Any PDF object value, read as the text these helpers parse. */
type AnnotationValue = { toString(): string };

function readNumber(dict: AnnotationDict, key: string): number {
  const raw = dictGet(dict, key);
  if (!raw) return 0;
  const value = Number(String(raw).trim());
  return Number.isFinite(value) ? value : 0;
}

/**
 * The `/F` bits that keep an annotation from the reader: `Invisible` 0x01,
 * `Hidden` 0x02, `NoView` 0x20 — the masks pdf.js numbers the same flags with
 * (`AnnotationFlag` in `pdfjs-dist`, from ISO 32000-1 Table 165).
 *
 * These read `1 << 1`, `1 << 7`, `1 << 2`, i.e. 2, 128 and 4: Hidden by luck,
 * Invisible and NoView never. It stayed unseen because `resolveAnnotation`
 * returned nothing, so there was never a flag for the test to read.
 */
function isHiddenAnnotation(dict: AnnotationDict): boolean {
  const flags = readNumber(dict, 'F');
  const INVISIBLE = 0x01;
  const HIDDEN = 0x02;
  const NO_VIEW = 0x20;
  return (flags & (INVISIBLE | HIDDEN | NO_VIEW)) !== 0;
}

/**
 * `/Rect` as four numbers, or `null` when the entry is not four readable
 * numbers. Each component is resolved through the context, because a rect is
 * written with indirect numbers as often as with literals.
 */
function readRect(context: PdfContextLookup, dict: AnnotationDict): number[] | null {
  const value = context.lookup(dictGet(dict, 'Rect'));
  // SAFETY: a `/Rect` is a `PDFArray`; only `size`/`get` are used, so the
  // narrower structural view is what the entry has to satisfy to be read.
  const array = value as MaybePdfArray | null;
  if (!array || typeof array.size !== 'function' || array.size() !== 4) return null;
  const out: number[] = [];
  for (let i = 0; i < 4; i++) {
    const n = Number(String(context.lookup(array.get(i))).trim());
    if (!Number.isFinite(n)) return null;
    out.push(n);
  }
  return out;
}

/** Effective drawn area of a page in square points, after /Rotate. */
export function pageArea(page: PDFPage): number {
  const box = cropBox(page);
  const media = mediaBox(page);
  const area = (box.width || media.width) * (box.height || media.height);
  return Number.isFinite(area) ? area : 0;
}
