/**
 * Flatten annotations and form fields into the page content.
 *
 * A PDF annotation is a separate object with its own appearance stream (`/AP`).
 * Flattening means drawing that appearance into the page's content stream so it
 * becomes part of the page and can no longer be moved, edited or hidden.
 *
 * This is done structurally, without rasterising, whenever the annotation
 * already carries an appearance stream — which keeps text selectable and the
 * file the same size. An annotation with no appearance to draw, or one a viewer
 * never paints (`Invisible`, `Hidden`, `NoView`), is left exactly where it is and
 * counted, because inventing ink or deleting a comment's text are both worse
 * than admitting the mark stayed live.
 *
 * Baking is only half of it: the annotation object has to leave the page's
 * `/Annots` array, or the mark is still selectable, still editable and still
 * read back as a comment by every other reader. Its `/Popup` goes with it.
 *
 * The appearance's operators are copied into the page's own content stream
 * wherever they parse (`inlineFormXObject`, the same seam the form bake uses),
 * so a flattened signature or stamp is searchable and redactable page text. Only
 * a form this module cannot copy is drawn as a positioned XObject instead, which
 * still puts the ink on the page.
 */
import {
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  rotateInPlace,
  scale,
  setGraphicsState,
  translate,
} from '@maxwbh/pdf-lib';
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFObject, PDFRef, PDFStream } from './doc';
import type { PDFDocument, PDFPage } from './doc';
import { inlineFormXObject } from './content';
import type { AnnotationKind } from './annotations';

export interface FlattenOptions {
  /** Only flatten these kinds. Omit to flatten everything except links. */
  kinds?: AnnotationKind[];
  /** Kinds to leave as live annotations even when `kinds` includes them. */
  except?: AnnotationKind[];
  /** Keep `/Link` annotations interactive. Default true. */
  keepLinks?: boolean;
  /** Only touch these 0-based pages. */
  pages?: number[];
  onProgress?: (fraction: number, message?: string) => void;
}

export interface FlattenOutcome {
  /** Annotations whose appearance was drawn into page content and which were then removed. */
  flattened: number;
  /** In-scope annotations left live because they carry no appearance to draw. */
  skippedNoAppearance: number;
  /**
   * In-scope annotations left live because a viewer does not paint them
   * (`Invisible`, `Hidden`, `NoView`). Baking one would put ink on a page the
   * user never saw it on.
   */
  skippedUnpainted: number;
  /**
   * Entries still listed in `AcroForm /Fields` after this pass. This module
   * bakes no field — `flattenForm` does — so a non-zero count here is a form
   * this run left interactive.
   */
  fields: number;
  pagesTouched: number;
}

/** Kinds that are interactive behaviour rather than visible marks. */
const INTERACTIVE: AnnotationKind[] = ['Link', 'Popup'];
/**
 * The form pass owns widgets: baking one here would drop it from `/Annots`
 * while `AcroForm /Fields` still named it, leaving a field with no box to type
 * in — a file that is neither interactive nor flattened.
 */
const FORM_OWNED: AnnotationKind[] = ['Widget'];

/** `/F` bits (PDF 32000-1 Table 165): three of them keep a mark off the page. */
const FLAG_INVISIBLE = 1;
const FLAG_HIDDEN = 2;
const FLAG_NO_VIEW = 32;

export async function flattenAnnotations(
  doc: PDFDocument,
  options: FlattenOptions = {},
): Promise<FlattenOutcome> {
  const outcome: FlattenOutcome = {
    flattened: 0,
    skippedNoAppearance: 0,
    skippedUnpainted: 0,
    fields: 0,
    pagesTouched: 0,
  };
  const pages = options.pages ?? doc.getPages().map((_, i) => i);
  const keepLinks = options.keepLinks ?? true;

  for (let index = 0; index < pages.length; index++) {
    const pageNumber = pages[index];
    const page = doc.getPage(pageNumber);
    // A page with no `/Annots` at all is the common case, and it is legal: PDF
    // writes a blank sheet with no key, so an absent entry is skipped rather
    // than looked up (`context.lookup(undefined, PDFArray)` throws).
    const list = resolveArray(doc, page.node.Annots?.());
    if (!list || list.size() === 0) continue;

    let drew = false;
    const remaining = doc.context.obj([]) as PDFArray;
    const baked = new Set<string>();
    for (let i = 0; i < list.size(); i++) {
      const ref = list.get(i);
      const annotation = doc.context.lookupMaybe(ref, PDFDict);
      if (!annotation) {
        // Keep unresolved entries rather than silently deleting content.
        (remaining as PDFArray).push(ref);
        continue;
      }
      const kind = String(annotation.get(PDFName.of('Subtype')) ?? '').replace(/^\//, '');
      if (!shouldFlatten(kind, options, keepLinks)) {
        (remaining as PDFArray).push(ref);
        continue;
      }
      if (!isPainted(annotation)) {
        outcome.skippedUnpainted += 1;
        (remaining as PDFArray).push(ref);
        continue;
      }
      if (drawAppearance(doc, page, annotation)) {
        outcome.flattened += 1;
        drew = true;
        baked.add(entryKey(doc, ref));
        const popup = annotation.get(PDFName.of('Popup'));
        if (popup) baked.add(entryKey(doc, popup));
      } else {
        outcome.skippedNoAppearance += 1;
        (remaining as PDFArray).push(ref);
      }
    }

    if (drew) {
      // A popup belongs to a mark that is page content now; left behind it is an
      // orphan a reader still lists as a comment on the page.
      const kept = doc.context.obj([]) as PDFArray;
      for (let i = 0; i < remaining.size(); i++) {
        const entry = remaining.get(i);
        const annotation = doc.context.lookupMaybe(entry, PDFDict);
        const isPopup = annotation && nameOf(annotation.get(PDFName.of('Subtype'))) === 'Popup';
        const parentGone =
          isPopup && annotation && baked.has(entryKey(doc, annotation.get(PDFName.of('Parent'))));
        if (parentGone) {
          baked.add(entryKey(doc, entry));
        } else {
          (kept as PDFArray).push(entry);
        }
      }
      page.node.set(PDFName.of('Annots'), kept);
      if (kept.size() === 0) page.node.delete(PDFName.of('Annots'));
      outcome.pagesTouched += 1;
    }
    options.onProgress?.((index + 1) / pages.length, `Flattened page ${pageNumber + 1}`);
  }

  // Read, never written: this pass draws no field appearance, so it has no
  // business clearing `/NeedAppearances` for a form it left interactive.
  // `doc.getForm()` is not called here either — on a document with no
  // `AcroForm` it registers an empty one.
  const acroDict = resolveDict(doc, doc.catalog.get(PDFName.of('AcroForm')));
  outcome.fields = resolveArray(doc, acroDict?.get(PDFName.of('Fields')))?.size() ?? 0;
  return outcome;
}

function nameOf(value: unknown): string {
  return value instanceof PDFName ? value.asString().replace(/^\//, '') : '';
}

/**
 * The identity of one `/Annots` entry: the object number of the annotation, whether
 * the array holds a reference or a direct dictionary. `/Parent` and `/Popup` point
 * with a reference, so an entry written inline has no key to match and simply
 * stays where it is.
 */
function entryKey(doc: PDFDocument, value: unknown): string {
  if (value instanceof PDFRef) return value.toString();
  const ref = value instanceof PDFDict ? doc.context.getObjectRef(value) : undefined;
  return ref ? ref.toString() : '';
}

function resolveRef(doc: PDFDocument, value: unknown): PDFObject | undefined {
  return value instanceof PDFRef ? doc.context.lookup(value) : (value as PDFObject | undefined);
}

function resolveDict(doc: PDFDocument, value: unknown): PDFDict | undefined {
  const resolved = resolveRef(doc, value);
  return resolved instanceof PDFDict ? resolved : undefined;
}

function resolveArray(doc: PDFDocument, value: unknown): PDFArray | undefined {
  const resolved = resolveRef(doc, value);
  return resolved instanceof PDFArray ? resolved : undefined;
}

/** Whether a viewer paints this annotation at all. */
function isPainted(annotation: PDFDict): boolean {
  const flags = annotation.get(PDFName.of('F'));
  if (!(flags instanceof PDFNumber)) return true;
  const value = flags.asNumber();
  return (value & (FLAG_INVISIBLE | FLAG_HIDDEN | FLAG_NO_VIEW)) === 0;
}

function shouldFlatten(
  kind: string,
  options: FlattenOptions,
  keepLinks: boolean,
): boolean {
  if (kind === 'Link' && keepLinks) return false;
  if (FORM_OWNED.includes(kind as AnnotationKind)) return false;
  if (options.kinds && !options.kinds.includes(kind as AnnotationKind)) return false;
  if (options.except?.includes(kind as AnnotationKind)) return false;
  if (!options.kinds && keepLinks && INTERACTIVE.includes(kind as AnnotationKind)) return false;
  return true;
}

/**
 * Draw one annotation's appearance into the page, in the same space a viewer
 * would use: the appearance's `/BBox` is fitted to the annotation `/Rect`, `/Matrix`
 * is applied between them, and a turn the annotation declares in `/Rotate` is
 * re-applied to the copied content.
 *
 * @returns false when there is nothing this can draw — no `/AP`, an appearance
 * that is not a form, a box with no area — so the caller leaves the mark live and
 * says so rather than reporting a bake that did not happen.
 */
function drawAppearance(doc: PDFDocument, page: PDFPage, annotation: PDFDict): boolean {
  const appearanceRef = normalAppearanceRef(doc, annotation);
  if (!appearanceRef) return false;
  const rect = readRect(annotation.get(PDFName.of('Rect')));
  if (!rect || rect.width <= 0 || rect.height <= 0) return false;
  const rotation = quarterTurn(annotation.get(PDFName.of('Rotate')));
  const state = paintState(doc, page, annotation);
  if (state) page.pushOperators(pushGraphicsState(), setGraphicsState(state));
  // Inlining the operators is the promise made literal: the mark's own words land
  // in the page content, where search, copy and redaction still reach them. A form
  // this module cannot copy (a resource it does not adopt) is drawn as a
  // positioned XObject instead, which still puts the ink on the page.
  const baked =
    inlineFormXObject(page, appearanceRef, { rect, rotation }) ||
    drawAppearanceObject(doc, page, appearanceRef, rect, rotation);
  if (state) page.pushOperators(popGraphicsState());
  return baked;
}

/**
 * The normal appearance's reference, resolved through the three shapes PDF writes:
 * an indirect stream, a stream inlined in the annotation, or — for a mark with
 * more than one visual state — a dictionary of streams keyed by `/AS`.
 *
 * The old code asked for this object as a `PDFDict`. An appearance is a **stream**
 * (`PDFRawStream`, which extends `PDFStream`, not `PDFDict`), and the fork's
 * `lookup` throws on a class mismatch rather than answering undefined, so the
 * whole flatten pass died on the first annotation and nothing was drawn.
 */
function normalAppearanceRef(doc: PDFDocument, annotation: PDFDict): PDFRef | undefined {
  const ap = resolveDict(doc, annotation.get(PDFName.of('AP')));
  if (!ap) return undefined;
  const normal = ap.get(PDFName.of('N'));
  if (normal === undefined) return undefined;
  const direct = resolveRef(doc, normal);
  if (direct instanceof PDFStream) {
    return normal instanceof PDFRef ? normal : doc.context.register(direct);
  }
  if (!(direct instanceof PDFDict)) return undefined;
  // A state table (`/N << /Yes ref /Off ref >>`): `/AS` names the entry a viewer
  // paints, and a table with a single entry can only mean that entry.
  const keyed = annotation.get(PDFName.of('AS'));
  const entries = direct.entries();
  const chosen =
    (keyed instanceof PDFName ? direct.get(keyed) : undefined) ?? (entries.length === 1 ? entries[0][1] : undefined);
  if (chosen === undefined) return undefined;
  if (chosen instanceof PDFRef) {
    return doc.context.lookupMaybe(chosen, PDFStream) ? chosen : undefined;
  }
  return chosen instanceof PDFStream ? doc.context.register(chosen) : undefined;
}

/** Draw the appearance stream as a Form XObject fitted to `rect`. */
function drawAppearanceObject(
  doc: PDFDocument,
  page: PDFPage,
  appearanceRef: PDFRef,
  rect: { x: number; y: number; width: number; height: number },
  rotation: 0 | 90 | 180 | 270,
): boolean {
  if (!(doc.context.lookupMaybe(appearanceRef, PDFStream) instanceof PDFStream)) return false;
  const key = page.node.newXObject('Flat', appearanceRef);
  page.pushOperators(
    pushGraphicsState(),
    translate(rect.x, rect.y),
    ...rotateInPlace({ width: rect.width, height: rect.height, rotation }),
    // A form XObject paints the unit square; without this the appearance lands on
    // the page as a one-point speck.
    scale(rect.width, rect.height),
    drawObject(key),
    popGraphicsState(),
  );
  return true;
}

/**
 * An annotation's `/CA` (opacity) and `/BM` (blend) belong to the annotation, not
 * to its appearance stream, so a viewer applies them while painting the mark and
 * a bake that ignored them would change what the page looks like: a 40 % highlight
 * would come back solid.
 */
function paintState(doc: PDFDocument, page: PDFPage, annotation: PDFDict): PDFName | undefined {
  const opacity = readNumber(annotation.get(PDFName.of('CA')));
  const blend = annotation.get(PDFName.of('BM'));
  const blended = blend instanceof PDFName && blend.asString() !== '/Normal';
  const translucent = opacity !== undefined && opacity >= 0 && opacity < 1;
  if (!translucent && !blended) return undefined;
  const state = doc.context.obj({ Type: 'ExtGState' }) as PDFDict;
  if (translucent) {
    state.set(PDFName.of('CA'), PDFNumber.of(opacity));
    state.set(PDFName.of('ca'), PDFNumber.of(opacity));
  }
  if (blended) state.set(PDFName.of('BM'), blend);
  return page.node.newExtGState('Flat', state);
}

/** `/Rotate` as a quarter turn; anything else is not a turn PDF allows here. */
function quarterTurn(value: unknown): 0 | 90 | 180 | 270 {
  const angle = readNumber(value);
  if (angle === undefined) return 0;
  return (((Math.round(angle / 90) * 90) % 360 + 360) % 360) as 0 | 90 | 180 | 270;
}

function readRect(value: unknown): { x: number; y: number; width: number; height: number } | null {
  const array = toArray(value);
  if (!array || array.length < 4) return null;
  const [x1, y1, x2, y2] = array;
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

function readNumber(value: unknown): number | undefined {
  return value instanceof PDFNumber && Number.isFinite(value.asNumber()) ? value.asNumber() : undefined;
}

function toArray(value: unknown): number[] | null {
  const array = value instanceof PDFArray ? value : undefined;
  if (!array) return null;
  return array
    .asArray()
    .map((item) => (item instanceof PDFNumber ? item.asNumber() : Number(String(item))))
    .filter(Number.isFinite);
}

/**
 * Remove every annotation without drawing anything.
 *
 * No shipped tool reaches this today — `remove-annotations` deletes through
 * `removeAnnotations` in `./annotations`, which also drops the objects
 * themselves — so it carries no test of its own; it is here for the cleaner that
 * would hide marks rather than delete them.
 */
export function stripAllAnnotations(doc: PDFDocument, keep: AnnotationKind[] = []): number {
  let removed = 0;
  for (const page of doc.getPages()) {
    const list = resolveArray(doc, page.node.Annots?.());
    if (!list) continue;
    const remaining = doc.context.obj([]) as PDFArray;
    for (let i = 0; i < list.size(); i++) {
      const annotation = doc.context.lookupMaybe(list.get(i), PDFDict);
      const kind = annotation ? String(annotation.get(PDFName.of('Subtype')) ?? '').replace(/^\//, '') : '';
      if (keep.includes(kind as AnnotationKind)) {
        (remaining as PDFArray).push(list.get(i));
      } else {
        removed += 1;
      }
    }
    page.node.set(PDFName.of('Annots'), remaining);
  }
  return removed;
}
