/**
 * Blank-page detection and page-content measurement.
 *
 * A page is blank when it paints nothing a reader can see: no image, no mark,
 * no visible text, no visible annotation. Testing only for text would wrongly
 * drop a page holding a scanned image or a signature; testing only for *runs* of
 * anything wrongly keeps a sheet of paper, because a white glyph on white paper
 * and an invisible OCR layer both put nothing on the screen.
 *
 * Both halves of that need the display list's graphics state, not only its
 * operator ids: the render mode says whether a text run is drawn at all, and the
 * fill/stroke colour says whether what it draws is white. Nothing here renders a
 * pixel, so the answer is exact per operator and cheap per page.
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
  /** Paint operators that laid down a colour — the ones a viewer can see. */
  inkOps: number;
  /** Paint operators that laid down white, so they show nothing on paper. */
  whitePaintOps: number;
  images: number;
  annotationRects: number;
  /**
   * `/Subtype` of every annotation counted in `annotationRects`, in `/Annots`
   * order — the names a result card spells out when it says *what* kept a
   * page that paints nothing (link, form field, mark). Empty when the count
   * is zero, which includes every scan made with `keepAnnotated` off.
   */
  annotationKinds: string[];
  inkArea: number;
  blankByContent: boolean;
  /** True when the page draws only things that show nothing (see above). */
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

/** Operators that paint raster — a scanned page is ink, not a blank sheet. */
const IMAGE_OPS: Set<number> = operatorIds([
  'paintXObject', 'beginInlineImage', 'paintImageXObject', 'paintInlineImageXObject',
  'paintImageMaskXObject', 'paintImageXObjectRepeat', 'paintInlineImageXObjectGroup',
  'paintImageMaskXObjectGroup', 'paintImageMaskXObjectRepeat', 'paintSolidColorImageMask',
]);

/** Text-showing operators: the ones a render mode decides the visibility of. */
const TEXT_OPS: Set<number> = operatorIds([
  'showText', 'showSpacedText', 'nextLineShowText', 'nextLineSetSpacingShowText',
]);

/** The halves of `fillStroke` and its variants, so each reads its own colour. */
const FILL_OPS: Set<number> = operatorIds([
  'fill', 'eoFill', 'fillStroke', 'eoFillStroke', 'closeFillStroke', 'closeEOFillStroke',
]);
const STROKE_OPS: Set<number> = operatorIds(['stroke', 'closeStroke']);

/**
 * The graphics state the walk below reads each paint operator through.
 *
 * `fill`/`stroke` are "this colour is white", so an op that paints a colour a
 * viewer cannot see it is not ink. The render mode is `ISO 32000-1` Table 106:
 * 3 and 7 show nothing, and the rest split into fill, stroke or both.
 */
interface PaintState {
  fill: boolean;
  stroke: boolean;
  mode: number;
}

const initialPaintState = (): PaintState => ({ fill: false, stroke: false, mode: 0 });

/**
 * The ones `OPS` ids the walk needs. `OPS` is the table the *worker* builds the
 * display list from, so a name here is the id that arrives in `fnArray`.
 */
const SAVE_STATE = OPS.save;
const RESTORE_STATE = OPS.restore;
const SHADING_FILL = OPS.shadingFill;
/**
 * The display-list markers around one annotation's stored appearance. pdf.js
 * emits a span for every annotation it paints, and it paints flagged-away
 * ones: the worker suppresses only `Hidden`/`NoView`, and it *strips* the
 * `Invisible` bit for every typed annotation (`Annotation.setFlags`) —
 * so a `/Invisible` sticky note reaches the page operator list with real
 * paint operators inside its span. Measured on 4.10.38: a note flagged 25
 * contributes its fill, a note flagged 2 or 32 contributes nothing.
 */
const ANNOTATION_BEGIN = OPS.beginAnnotation;
const ANNOTATION_END = OPS.endAnnotation;
/**
 * Every colour operator the worker normalises to. `rg`/`RG`, `g`/`G`,
 * `k`/`K`, `sc`/`scn` and a bare colour array all arrive as one of these two
 * ids with three `0`–`255` components (`PartialEvaluator` calls `getRgb`), so a
 * DeviceN or ICC space is already resolved by the time the list is handed over.
 * A tiling pattern keeps `setFillColorN` and counts as ink, which is right: a
 * pattern is a texture, not paper.
 */
const SET_FILL_WHITE = OPS.setFillRGBColor;
const SET_STROKE_WHITE = OPS.setStrokeRGBColor;
const SET_RENDER_MODE = OPS.setTextRenderingMode;

/**
 * Three sRGB components at or above paper: a white fill or stroke.
 *
 * The components are a `Uint8ClampedArray`, not a JS array — the worker builds
 * them with `getRgb` into a typed buffer and the display list carries it as one
 * (measured). `Array.isArray` answers false for it, so a rule written against
 * arrays alone read every colour as "not white" and kept the white-on-white
 * sheet in the browser while the test's plain-array double said it went.
 */
function isWhite(value: unknown): boolean {
  const channels = value as ArrayLike<number> | null | undefined;
  if (!channels || channels.length !== 3) return false;
  for (let i = 0; i < 3; i++) {
    if (typeof channels[i] !== 'number' || channels[i] < 254.5) return false;
  }
  return true;
}

/**
 * Profile one page from pdf.js. `getOperatorList` gives the display list the
 * renderer consumes, so inline images, XObjects and every fill/stroke operator
 * are counted without decoding the stream by hand.
 */
export async function profilePage(
  session: PdfSession,
  page: number,
  options: {
    annotationRects?: number;
    annotationKinds?: string[];
    /**
     * Rects of the annotations `isHiddenAnnotation` keeps from the reader.
     * Their stored appearances ride the display list anyway (see
     * `ANNOTATION_BEGIN`); the walk below refuses to count them as ink, so
     * the flag answers exactly one question across both halves of the rule.
     */
    hiddenAnnotationRects?: number[][];
  } = {},
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
    const seen = readDisplayList(
      operators.fnArray,
      operators.argsArray,
      viewport,
      options.hiddenAnnotationRects ?? [],
    );
    invisible += seen.invisibleTextOps;
    const annotationRects = options.annotationRects ?? 0;
    profile = {
      page,
      textItems,
      invisibleTextItems: invisible,
      paintOps: seen.paintOps,
      inkOps: seen.inkOps,
      whitePaintOps: seen.whitePaintOps,
      images: seen.images,
      annotationRects,
      annotationKinds: options.annotationKinds ?? [],
      inkArea: seen.inkArea,
      // `inkOps` is the whole answer: it counts what a reader can see, so a page
      // of painting operators that are all invisible or all white is as blank as
      // one that runs none. Before it, "runs a painting operator" was read as
      // "is inked", and two sheets of the eight-page fixture came back as blank
      // paper under a success line (measured, both kept: 0 non-white px each).
      blankByContent: seen.inkOps === 0 && annotationRects === 0,
      // Kept as its own field because the result card's sentences key on it —
      // "looks blank but is searchable" is this predicate plus invisible text.
      blankByAppearance: seen.inkOps === 0 && annotationRects === 0,
    };
  } finally {
    proxy.cleanup();
  }
  return profile;
}

/**
 * The `/Rect` an annotation span carries. `beginAnnotation`'s args are
 * `[id, rect, transform, matrix, hasOwnCanvas]` (measured on 4.10.38);
 * anything else is a span this rule cannot place, and an unplaceable span
 * counts as the ink the page really drew — the conservative direction.
 */
function spanRect(args: unknown): number[] | null {
  const list = args as unknown[] | null;
  if (!Array.isArray(list) || !Array.isArray(list[1])) return null;
  return canonicalRect(list[1]);
}

/**
 * `[llx, lly, urx, ury]`, or `null` unless the four corners are numbers.
 * The worker reorders `/Rect` before putting it on the display list, so a
 * dictionary written top-left-first has to meet its span in the middle.
 */
function canonicalRect(rect: unknown): number[] | null {
  const list = rect as unknown[] | null;
  if (!Array.isArray(list) || list.length !== 4) return null;
  const n = list.map(Number);
  if (!n.every(Number.isFinite)) return null;
  return [
    Math.min(n[0], n[2]),
    Math.min(n[1], n[3]),
    Math.max(n[0], n[2]),
    Math.max(n[1], n[3]),
  ];
}

function estimateImageArea(args: unknown, fallbackW: number, fallbackH: number): number {
  const record = args as Record<string, unknown> | undefined;
  const width = typeof record?.width === 'number' ? record.width : fallbackW;
  const height = typeof record?.height === 'number' ? record.height : fallbackH;
  return width * height;
}

/** What a page's display list does to a reader, counted operator by operator. */
interface DisplayListInk {
  paintOps: number;
  inkOps: number;
  whitePaintOps: number;
  invisibleTextOps: number;
  images: number;
  inkArea: number;
}

/**
 * Walk a display list through its graphics state and count only what shows.
 *
 * The state is the point. A page is not inked because it *runs* a paint operator:
 * a `1 1 1 rg` fill and a `3 Tr` glyph both run one and lay down nothing a
 * reader can see. The colour arrives as three sRGB components the worker already
 * resolved (see `SET_FILL_WHITE`), and the render mode as a number, so both the
 * white question and the invisible one are answered exactly, per operator, with
 * no raster in sight.
 *
 * `q`/`Q` are followed because readability is per operator: a document that
 * sets white inside a `q … Q` and paints black after it is not white. `sh`
 * (shading) and every raster count as ink unconditionally — a gradient is a
 * texture and a scan is a photograph of paper, so neither can be judged by a
 * single colour. An operator whose colour is a pattern keeps `setFillColorN`,
 * which is not one of the two white-capable ids, so it counts as ink too.
 *
 * The `hiddenAnnotationRects` half is the same promise read off the other
 * side. `isHiddenAnnotation` already refuses a flagged mark as counted
 * content; pdf.js, though, paints a `/Invisible` annotation's stored
 * appearance into the display list anyway (only `Hidden`/`NoView` are
 * suppressed there), so the appearance's operators used to sneak the page
 * back in as `inkOps` — one flag, two answers, and the sheet a user got was
 * paper. A `beginAnnotation` span whose rect matches a flagged annotation
 * (consumed one-to-one, `/Rect` canonicalised like the worker canonicalises
 * it) paints nothing here: its operators count for neither ink, white, nor
 * raster. The rescue promise chooses this direction — "the pages that paint
 * nothing" are deleted, and a mark flagged away from the reader holds
 * nothing the reader asked to keep, which is the same reason its rect never
 * counts. Hidden and NoView spans do not reach the list at all; matching
 * them too costs nothing and keeps one predicate where two used to guess.
 */
function readDisplayList(
  ops: number[],
  args: unknown[],
  viewport: { width: number; height: number },
  hiddenAnnotationRects: number[][] = [],
): DisplayListInk {
  const seen: DisplayListInk = {
    paintOps: 0, inkOps: 0, whitePaintOps: 0, invisibleTextOps: 0, images: 0, inkArea: 0,
  };
  // A page's initial state is black fill, black stroke, render mode 0
  // (`ISO 32000-1` 8.4, Table 106), so an operator that sets no colour is ink.
  let paint = initialPaintState();
  const saved: PaintState[] = [];
  // The flagged marks' rects, waiting to be matched one-for-one against the
  // spans the list carries; `spans` then holds one entry per open
  // `beginAnnotation`, true when its appearance is flagged away from the
  // reader and nothing inside it may count.
  const annotationPool = hiddenAnnotationRects
    .map(canonicalRect)
    .filter((rect): rect is number[] => rect !== null);
  const spans: boolean[] = [];
  for (let i = 0; i < ops.length; i++) {
    const id = ops[i];
    const arg = args[i];
    if (id === ANNOTATION_BEGIN) {
      const rect = spanRect(arg);
      const at =
        rect === null ? -1 : annotationPool.findIndex((held) => held.every((v, j) => v === rect[j]));
      if (at >= 0) annotationPool.splice(at, 1);
      spans.push(at >= 0);
      continue;
    }
    if (id === ANNOTATION_END) {
      spans.pop();
      continue;
    }
    // Inside a flagged mark's appearance every operator is invisible, its
    // colour setters with it: the whole span is skipped, not just its paint.
    if (spans.includes(true)) continue;
    if (id === SAVE_STATE) {
      saved.push(paint);
      paint = { ...paint };
      continue;
    }
    if (id === RESTORE_STATE) {
      // An unbalanced `Q` keeps the state it had: the file is malformed, and the
      // colours already read are better evidence than a reset to black.
      paint = saved.pop() ?? paint;
      continue;
    }
    if (id === SET_FILL_WHITE) paint.fill = isWhite(arg);
    else if (id === SET_STROKE_WHITE) paint.stroke = isWhite(arg);
    else if (id === SET_RENDER_MODE) paint.mode = Number(arg) || 0;
    if (PAINTING_OPS.has(id)) seen.paintOps += 1;
    if (IMAGE_OPS.has(id)) {
      // A raster is ink whatever its colours: a white scan still shows the paper
      // it photographed, which the tool's own note promises.
      seen.inkOps += 1;
      seen.images += 1;
      seen.inkArea += estimateImageArea(arg, viewport.width, viewport.height);
      continue;
    }
    if (id === SHADING_FILL) {
      seen.inkOps += 1;
      continue;
    }
    if (TEXT_OPS.has(id)) {
      // Modes 3 and 7 lay no ink at all; the rest paint with the fill colour,
      // the stroke colour, or both — `ISO 32000-1` Table 106.
      if (paint.mode === 3 || paint.mode === 7) {
        seen.invisibleTextOps += 1;
        continue;
      }
      const fills = paint.mode === 0 || paint.mode === 2 || paint.mode === 4 || paint.mode === 6;
      const strokes = paint.mode === 1 || paint.mode === 2 || paint.mode === 5 || paint.mode === 6;
      if ((fills && !paint.fill) || (strokes && !paint.stroke)) seen.inkOps += 1;
      else if (fills || strokes) seen.whitePaintOps += 1;
      continue;
    }
    if (FILL_OPS.has(id) || STROKE_OPS.has(id)) {
      if ((FILL_OPS.has(id) && !paint.fill) || (STROKE_OPS.has(id) && !paint.stroke)) seen.inkOps += 1;
      else seen.whitePaintOps += 1;
    }
  }
  return seen;
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

/**
 * What a sheet's verdict comes from, one class per page: the way the display
 * list answers "does this page paint anything a reader can see", spelled out so
 * a result card can say *why*, not only *that*. `pageBlankness` produces these;
 * the classes mirror the sentences `remove-blank-pages` already speaks, so any
 * tool reporting a blank sheet through the judge words it the same way.
 */
export type PageBlankReason =
  /** Something a reader can see paints: `inkOps > 0`. */
  | 'inked'
  /** Paints nothing; a live link, field or mark holds the page (`keepAnnotated`). */
  | 'held-by-annotations'
  /** Ran paint operators and every colour was paper-white. */
  | 'painted-white'
  /** Ran text only in invisible render modes — an OCR layer. */
  | 'invisible-text'
  /** Ran no paint operator at all: no `/Contents`, an empty stream, or `q Q`. */
  | 'nothing-drawn';

/** One page's display-list verdict, as the exported judge answers it. */
export interface PageBlankness {
  page: number;
  /** The same predicate `findBlankPages` deletes on. */
  blank: boolean;
  reason: PageBlankReason;
  profile: PageContentProfile;
}

/**
 * The class behind one sheet's verdict. A blank page that both washed white
 * and carried invisible text classifies as `painted-white` — the wash is the
 * louder half — and the raw counts ride on the profile for a tool that needs
 * both sentences.
 */
function classifyProfile(profile: PageContentProfile): PageBlankReason {
  if (!profile.blankByAppearance) {
    return profile.inkOps > 0 ? 'inked' : 'held-by-annotations';
  }
  if (profile.whitePaintOps > 0) return 'painted-white';
  if (profile.invisibleTextItems > 0) return 'invisible-text';
  return 'nothing-drawn';
}

/**
 * Judge one page exactly as a blank-page scan would: the same annotation walk
 * `findBlankPages` feeds `profilePage`, the same operator walk, the same
 * delete predicate. Tools that name blank sheets (posterize, divide-pages,
 * fix-page-size) call this so every card answers from one judge, not one per
 * file — the campaign measured four different tools disagreeing about the
 * same twenty sheets.
 */
export async function pageBlankness(
  session: PdfSession,
  doc: PDFDocument,
  page: number,
  options: BlankPageOptions = {},
): Promise<PageBlankness> {
  const keepAnnotated = options.keepAnnotated ?? true;
  const { kinds, hiddenRects } = pageAnnotations(doc, page - 1);
  const profile = await profilePage(
    session,
    page,
    keepAnnotated
      ? { annotationRects: kinds.length, annotationKinds: kinds, hiddenAnnotationRects: hiddenRects }
      : { hiddenAnnotationRects: hiddenRects },
  );
  return { page, blank: profile.blankByAppearance, reason: classifyProfile(profile), profile };
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
    const { kinds, hiddenRects } = pageAnnotations(doc, page - 1);
    const profile = await profilePage(
      session,
      page,
      keepAnnotated
        ? { annotationRects: kinds.length, annotationKinds: kinds, hiddenAnnotationRects: hiddenRects }
        : { hiddenAnnotationRects: hiddenRects },
    );
    profiles.push(profile);
    if (profile.blankByAppearance) blank.push(page);
    onProgress?.(page, session.numPages);
  }
  return { blank, profiles };
}

/**
 * One walk of `/Annots` answering both annotation halves of the judge: the
 * `/Subtype` names of the marks `isLiveAnnotation` counts as content, and the
 * canonical rects of the marks `isHiddenAnnotation` keeps from the reader —
 * whose stored appearance the renderer paints anyway, and the operator walk
 * therefore has to refuse by rect.
 */
interface PageAnnotationVerdict {
  kinds: string[];
  hiddenRects: number[][];
}

function pageAnnotations(doc: PDFDocument, pageIndex: number): PageAnnotationVerdict {
  const page = doc.getPage(pageIndex);
  const kinds: string[] = [];
  const hiddenRects: number[][] = [];
  const annots = readAnnotsArray(page);
  if (!annots) return { kinds, hiddenRects };
  const context = pdfContext(doc);
  const box = cropBox(page);
  for (let i = 0; i < annots.size(); i++) {
    const resolved = resolveAnnotation(doc, annots.get(i));
    if (!resolved) continue;
    if (isHiddenAnnotation(resolved)) {
      const rect = canonicalRect(readRect(context, resolved));
      if (rect) hiddenRects.push(rect);
      continue;
    }
    if (isLiveAnnotation(context, resolved, box)) {
      kinds.push(readName(resolved, 'Subtype') ?? 'Annotation');
    }
  }
  return { kinds, hiddenRects };
}

/**
 * An annotation counts as content only where a reader can meet it: the
 * invisible / hidden / no-view flags are off **and** `/Rect` lands on the page.
 *
 * A `Popup` is judged with its parent: the window of a mark flagged away
 * from the reader is itself never opened — measured on `blankfix.pdf` p16,
 * where the `/Invisible` note's own rect was refused while its satellite
 * popup, flags clean, still held the paper sheet. One promise, one
 * predicate: the pair is hidden together.
 *
 * The second half is what stops `keepAnnotated` degrading into "keep
 * everything". A mark parked at `[900 900 940 920]` on a 200 × 100 sheet is
 * clipped away by every viewer, so a sheet whose only annotation is off-page
 * is still blank; a rect that merely hangs over the edge is not, because part
 * of it draws. `/Rect` is in default user space, so the crop box is the right
 * frame whether or not the page carries `/Rotate`.
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
  if (readName(dict, 'Subtype') === 'Popup') {
    const parent = context.lookup(dictGet(dict, 'Parent'));
    if (isAnnotationDict(parent) && isHiddenAnnotation(parent)) return false;
  }
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
  // narrower structural view is sound. pdf-lib exposes `/Annots` as a
  // `PDFArray | PDFRef | undefined` through a generated accessor whose public
  // type is an opaque `PDFObject` union, so the array is narrowed here once
  // instead of at every call site.
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
  // SAFETY: every PDF object implements `toString()` as the PDF source text it
  // would be written with, which is all the helpers below parse; an absent key
  // is the only `null`.
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
