/**
 * PDF annotations (§2 of `docs/PDF-ENGINE-CONTRACT.md`).
 *
 * `@maxwbh/pdf-lib` has no high-level Highlight/Ink/FreeText API — the only
 * annotation support it ships is the widget plumbing behind AcroForms. Every
 * dictionary here is therefore written by hand through `doc.context` /
 * `PDFPageLeaf.addAnnot`, and every annotation carries a real appearance
 * stream so that Okular, Acrobat, pdfium (Chrome) and pdf.js all paint it: a
 * viewer that understands the dictionary uses `/C`, `/BS`, `/IC`; a viewer that
 * only draws appearances still sees the ink.
 *
 * Coordinate convention — read this before touching `/Rect`
 * ---------------------------------------------------------
 * `QuadRect` is **PDF default user space**: the origin is the page's
 * *lower-left* corner, +x runs right and +y runs up — the same space
 * `cropBox`/`mediaBox` in `core/pages.ts` report. The app's pointer/overlay
 * layer tracks CSS rectangles whose origin is the page's *upper-left* corner,
 * so a UI rect is flipped exactly once, in the component that owns the DOM,
 * before it reaches this module:
 *
 *     pdfRect.x = cssRect.x
 *     pdfRect.y = pageHeight - cssRect.y - cssRect.height   // top-left → bottom-left
 *
 * (That is the flip the legacy `redactPDF` performed inline as
 * `canvasY = (viewport.height - r.y - r.height) * scale`.)
 *
 * Appearance streams live in their *own* space: `/BBox [0 0 w h]` where `w`/`h`
 * are the annotation rect's size, so stream content is written relative to the
 * rect's lower-left corner and the viewer scales it onto `/Rect`. Everything
 * that turns a user-space point into stream space subtracts the rect origin
 * (`localQuads`, `lineEndsOf`, `strokesOf`).
 *
 * Redaction: §2 declares `applyRedactions` as part of this module's API; the
 * permanent content rewrite lives in `./redact.ts` (it needs a content-stream
 * tokenizer plus a text-state machine) and is re-exported below, so callers
 * only ever import from `core/annotations`.
 */
import { PDFString, type PDFObject } from '@maxwbh/pdf-lib';
import {
  PDFArray,
  PDFContext,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFRef,
  StandardFonts,
} from './doc';
import type { PDFDocument, PDFPage, PDFFont } from './doc';
import { isWinAnsiSafe } from './fonts';

export type AnnotationKind =
  | 'Highlight' | 'Underline' | 'StrikeOut' | 'Squiggly'
  | 'Text' | 'FreeText' | 'Ink' | 'Square' | 'Circle' | 'Line' | 'Arrow'
  | 'Polygon' | 'PolyLine' | 'Stamp' | 'Caret' | 'Popup' | 'Link' | 'Redact' | 'Widget';

export const ANNOTATION_KINDS: AnnotationKind[] = [
  'Highlight', 'Underline', 'StrikeOut', 'Squiggly',
  'Text', 'FreeText', 'Ink', 'Square', 'Circle', 'Line', 'Arrow',
  'Polygon', 'PolyLine', 'Stamp', 'Caret', 'Popup', 'Link', 'Redact', 'Widget',
];

/**
 * A rectangle in PDF default user space (origin = page lower-left).
 * Negative `width`/`height` are accepted and normalised on the way in.
 */
export interface QuadRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/* ------------------------------------------------------------------ *
 * Rotation maths — the one place PDF-space turns are defined          *
 * ------------------------------------------------------------------ *
 *
 * The editor's overlay needs the same numbers to draw a turned mark, so these
 * live in the layer that writes the dictionary and are re-exported from
 * `components/tools/pdf/editor/geometry.ts`: one rule for `/Rect`, one rule for
 * the pixels on screen.
 *
 * Angles are **clockwise as the page is read** — the direction PDF's `/Rotate`
 * entry means. User space has +y up, so a clockwise turn is the negative of the
 * textbook counter-clockwise rotation.
 */

/** Degrees folded into `[0, 360)`. A non-number is straight. */
export function normaliseAngle(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0;
  return ((degrees % 360) + 360) % 360;
}

/** The pivot a mark turns about. */
export function rectCentre(rect: QuadRect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** Turn a point clockwise about `centre`. */
export function rotatePointAbout(
  point: { x: number; y: number },
  centre: { x: number; y: number },
  degrees: number,
): { x: number; y: number } {
  const angle = normaliseAngle(degrees);
  if (angle === 0) return { x: point.x, y: point.y };
  const rad = (angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = point.x - centre.x;
  const dy = point.y - centre.y;
  return { x: centre.x + dx * cos + dy * sin, y: centre.y - dx * sin + dy * cos };
}

function rectCorners(rect: QuadRect): { x: number; y: number }[] {
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
}

/**
 * The axis-aligned box that contains `rect` turned about its own centre.
 *
 * A rotated annotation always writes this as `/Rect`, never the pre-rotation
 * box: a viewer that ignores our appearance stream, and anything that clips or
 * prints by `/Rect`, then cannot crop the mark.
 */
export function rotatedRectBounds(rect: QuadRect, degrees: number): QuadRect {
  const angle = normaliseAngle(degrees);
  if (angle === 0) return { ...rect };
  const centre = rectCentre(rect);
  const turned = rectCorners(rect).map((corner) => rotatePointAbout(corner, centre, angle));
  const xs = turned.map((corner) => corner.x);
  const ys = turned.map((corner) => corner.y);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

/* ------------------------------------------------------------------ *
 * What one text-markup quad means                                     *
 * ------------------------------------------------------------------ *
 *
 * `/QuadPoints` is four points per line, and both the appearance stream below
 * and the editor's SVG overlay have to agree about two things or the mark on
 * the screen is not the mark in the file: which order the four points are
 * stored in, and where across the box a rule is drawn. Both rules live here.
 */

/** A corner of a quad, in whichever space the caller holds the quad in. */
export interface QuadCorner {
  x: number;
  y: number;
}

/**
 * The share of a markup quad's height that sits above the text baseline.
 *
 * A markup quad is one em tall and the baseline runs through it rather than
 * along an edge, so *where the baseline is* is the number every mark position
 * is measured from. pdf.js cannot hand ascent and descent to
 * `render.toExtractedItems` (a v4 `TextItem` carries neither), and its own text
 * layer therefore splits the em with a fallback ratio — `DEFAULT_FONT_ASCENT`,
 * 0.8 — which is the split used here too. It agrees with the documents this
 * editor sees: `getTextContent().styles` reports 0.718 over 0.207 for the
 * Helvetica faces of the test CV, and its ink measured 14.7pt above the
 * baseline and 3.9pt below on a 20pt line.
 */
export const TEXT_BASELINE_SHARE = 0.8;

/**
 * An underline, in ems below the baseline, measured to the *top* of the stroke:
 * clear of the feet of the letters and above the bottom of the descenders, so
 * it reads as an underline and not as a second strike-through. The stroke is
 * then hung below this line, which is why `markupRule` adds half of it.
 */
export const UNDERLINE_BELOW_BASELINE_EM = 0.05;

/** A strike-out, in ems above the baseline: the middle of a Latin glyph body
 * (x-height about 0.5 em), which is lower than the middle of the em box. */
export const STRIKE_ABOVE_BASELINE_EM = 0.3;

/**
 * What a link paints inside its own rectangle.
 *
 * PDF treats `/Link` as invisible furniture — the rect is the click target and a
 * viewer may draw its own highlight — so an empty appearance stream is legal.
 * It is not honest here: the editor shows a dashed box over the area the user
 * dragged, and a file that paints nothing disagrees with the page that was
 * marked. These two numbers describe that box and are shared with the overlay,
 * so the rectangle on screen is the rectangle in the bytes. The colour is the
 * mark's own (`/C`), never a constant: a link recoloured in the inspector has to
 * come out that way.
 */
export const LINK_WASH_ALPHA = 0.08;
/** Dash of the link's border, in points: on, off. Written to `/BS /D` as well. */
export const LINK_BORDER_DASH: readonly number[] = [5, 3];

/* FreeText layout, in fractions of the font size. `textLayout` below is the
 * authority for what gets written; the editor's type-in surface imports these
 * numbers instead of inventing its own, so the text the user watches is laid
 * out the way the page will be printed. The leading assumes the standard 14
 * Helvetica the FreeText tool embeds: `heightAtSize(size)` is 0.925 em for it,
 * plus the 0.15 em of gap added below. */
export const FREE_TEXT_INSET_EM = 0.15;
export const FREE_TEXT_INSET_MIN_PT = 1;
export const FREE_TEXT_LINE_EM = 1.075;

/** The left/right (and top) padding FreeText keeps its text away by, in points. */
export function freeTextInset(size: number): number {
  return Math.max(Math.max(size, 1) * FREE_TEXT_INSET_EM, FREE_TEXT_INSET_MIN_PT);
}

/**
 * The four corners of one quad in the order a shape has to be walked: upper-
 * left, upper-right, lower-right, lower-left.
 *
 * `/QuadPoints` stores upper-left, upper-right, lower-left, lower-right (PDF
 * 32000-1 Table 171), and that order is correct *as data* — it is how Acrobat
 * and pdf.js write it. Painted as given, though, the path runs along the top
 * edge, diagonally down to the lower-left, along the bottom edge and diagonally
 * back up: a bowtie of two triangles meeting at the centre. The appearance
 * stream and the overlay both fill through this function so the winding cannot
 * drift apart between the file and the screen.
 */
export function quadRing<T extends QuadCorner>(corners: readonly T[]): T[] {
  const [upperLeft, upperRight, lowerLeft, lowerRight] = corners;
  return [upperLeft, upperRight, lowerRight, lowerLeft];
}

/** One rule of a text mark: the two ends of the line to stroke across a quad. */
export interface MarkupRule {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * The line an Underline, StrikeOut or Squiggly strokes across one quad.
 *
 * `corners` are the quad's four points in the order they are *stored* (UL, UR,
 * LL, LR) and in whatever space the caller works — PDF points when writing the
 * appearance stream, screen pixels when painting the overlay — and
 * `strokeWidth` is in that space too. Every step is a proportion between the
 * stored corners and the stroke, so one call gives one mark in either space and
 * the picture on screen cannot stop being the picture in the file.
 *
 * The height of the quad is one em, which is what turns the em-relative
 * offsets above into a position: `TEXT_BASELINE_SHARE` of the way down is where
 * the letters stand, so an underline goes a little further down and a
 * strike-out a good deal further up.
 */
export function markupRule(
  corners: readonly QuadCorner[],
  kind: 'Underline' | 'StrikeOut' | 'Squiggly',
  strokeWidth = 0,
): MarkupRule {
  const [upperLeft, upperRight, lowerLeft, lowerRight] = corners;
  const em = Math.hypot(lowerLeft.x - upperLeft.x, lowerLeft.y - upperLeft.y) || 1;
  // Measured down from the quad's top edge, which is the text's top edge.
  const down =
    kind === 'StrikeOut'
      ? TEXT_BASELINE_SHARE - STRIKE_ABOVE_BASELINE_EM
      : TEXT_BASELINE_SHARE + UNDERLINE_BELOW_BASELINE_EM + strokeWidth / 2 / em;
  const at = (top: QuadCorner, bottom: QuadCorner): QuadCorner => ({
    x: top.x + (bottom.x - top.x) * down,
    y: top.y + (bottom.y - top.y) * down,
  });
  const left = at(upperLeft, lowerLeft);
  const right = at(upperRight, lowerRight);
  return { x1: left.x, y1: left.y, x2: right.x, y2: right.y };
}

/**
 * A `/QuadPoints` list (8 numbers per quad, UL UR LL LR) turned as one unit
 * about the centre of `about`.
 *
 * A quadrilateral is four free points, so a rotated line of highlighted text is
 * still exactly one quad — the mark keeps one quad per line however it is
 * turned, and the set of lines turns together rather than line by line.
 */
export function rotateQuadPoints(quads: number[], about: QuadRect, degrees: number): number[] {
  const angle = normaliseAngle(degrees);
  if (angle === 0) return quads.slice();
  const centre = rectCentre(about);
  const out: number[] = [];
  for (let i = 0; i + 1 < quads.length; i += 2) {
    const turned = rotatePointAbout({ x: quads[i], y: quads[i + 1] }, centre, angle);
    out.push(turned.x, turned.y);
  }
  return out;
}

import type { FaceStyle } from './text-style';

/**
 * One line of a laid-out text mark, in the mark's own appearance space.
 *
 * The annotation editor lays a mark's text out with `model.layoutBlock` and the
 * faces the file will really carry, then hands the result here — so the lines on
 * screen are the lines in the file rather than two wrap implementations that
 * happen to agree.
 */
export interface LaidOutLine {
  /** The line's text, exactly as the file shows it. */
  text: string;
  /** Left edge, points from the left of the mark's own box. */
  x: number;
  /** Baseline, points up from the bottom of the mark's own box. */
  baseline: number;
  /** Points; the size the line was measured and drawn at. */
  size: number;
}

/**
 * The shared text style, with the face and the line breaks resolved for it.
 *
 * `addAnnotation` is synchronous (contract §2), so it cannot fetch and embed a
 * Unicode face itself. A caller that wants a family past the standard-14 names
 * embeds it first (`faces.resolveFace`) and passes it in `font`; a caller that has
 * also laid the text out passes `lines`, and the appearance draws exactly those.
 * With neither, this module answers from the standard-14 faces and wraps the text
 * itself — still with the face it writes, never a guess.
 */
export interface StyledText {
  style: FaceStyle;
  /** A face the caller embedded for `style`, in the document being written. */
  font?: PDFFont;
  /** Lines the caller laid out; when absent this module wraps the text. */
  lines?: LaidOutLine[];
}

export interface AnnotationSpec {
  kind: AnnotationKind;
  /** 0-based page index. */
  page: number;
  rect: QuadRect;
  color?: string;
  fillColor?: string;
  borderColor?: string;
  borderWidth?: number;
  /** 0..1, written to `/CA`. */
  opacity?: number;
  contents?: string;
  author?: string;
  createdAt?: Date;
  /**
   * The text style, face and laid-out lines for a mark that draws words —
   * `FreeText` and a labelled `Stamp`. `freeText.text` / `stampName` stay the body;
   * this is how it is set. Named apart from a spec's loose `text` string, which
   * some callers already use for the body.
   */
  textStyle?: StyledText;
  freeText?: {
    text: string;
    fontSize: number;
    fontFamily?: string;
    bold?: boolean;
    italic?: boolean;
    align?: 'left' | 'center' | 'right';
    background?: string;
    border?: boolean;
  };
  /** Strokes of `[x, y]` pairs in default user space. */
  inkPath?: number[][][];
  /** `[x1, y1, x2, y2]` in default user space. */
  lineEnds?: [QuadRect['x'], number, number, number];
  lineArrow?: 'none' | 'start' | 'end' | 'both';
  /** 8 numbers per quad line, in PDF order (UL, UR, LL, LR). */
  quadPoints?: number[];
  /**
   * Degrees clockwise relative to the page, turned about the centre of `rect`.
   *
   * `rect` and the geometry fields stay **as drawn**: the writer turns them.
   * `/Rect` becomes the axis-aligned bounding box of the rotated shape, the
   * appearance stream bakes the turn with a `cm` about the shape's centre, and
   * `/Rotate` carries the angle only where PDF allows it (see `declaredRotation`).
   */
  rotation?: number;
  /** Rasterised stamp appearance (JPEG, or 8-bit non-interlaced grey/RGB/palette PNG). */
  stampImage?: Uint8Array;
  /**
   * A stamp image the caller already embedded.
   *
   * Preferred over `stampImage`, which can only carry a raster this module can
   * splice into the file without decoding it: an RGBA PNG has an alpha channel no
   * PDF image can hold as a fourth colour component, and embedding it is the
   * caller's job (`PDFDocument#embedPng` writes the stencil mask for it).
   */
  stampXObject?: EmbeddedRaster;
  /** Built-in stamp name, written to `/S` and drawn when no image is supplied. */
  stampName?: string;
  link?: { type: 'goTo'; page: number } | { type: 'uri'; uri: string };
  /** Marks the annotation for `applyRedactions` (writes `/Redact true`). */
  redact?: boolean;
  /** `/F` flag names, e.g. `['Print', 'ReadOnly']`. */
  flags?: string[];
}

export interface ExistingAnnotation {
  kind: AnnotationKind;
  page: number;
  rect: QuadRect;
  /**
   * The annotation's declared `/Rotate`, 0 when the entry is absent. Only a
   * multiple of 90 can be written there, so a mark turned to any other angle
   * round-trips as 0 while its `/Rect` and appearance keep the turn.
   */
  rotation: number;
  contents?: string;
  color?: string;
  readonly: boolean;
  flags: number;
  ref: PDFRef;
}

/** Kinds whose geometry is a set of text quads (`/QuadPoints`). */
const MARKUP_KINDS: AnnotationKind[] = ['Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Caret'];
/** Kinds that carry an interior colour in `/IC`. */
const INTERIOR_KINDS: AnnotationKind[] = ['Ink', 'Square', 'Circle', 'Polygon', 'PolyLine', 'FreeText', 'Redact'];

/** PDF 32000-1 Table 165 (the fork does not re-export its own enum). */
const FLAG_BITS: Record<string, number> = {
  Invisible: 1,
  Hidden: 2,
  Print: 4,
  NoZoom: 8,
  NoRotate: 16,
  NoView: 32,
  ReadOnly: 64,
  Locked: 128,
  ToggleNoView: 256,
  LockedContents: 512,
};
const PRINT_FLAG = FLAG_BITS.Print;

const DEFAULT_COLOR: Partial<Record<AnnotationKind, string>> = {
  Highlight: '#FFFF00',
  Underline: '#000000',
  StrikeOut: '#000000',
  Squiggly: '#000000',
  Caret: '#000000',
  Text: '#FFFF66',
  FreeText: '#000000',
  Ink: '#000000',
  Square: '#000000',
  Circle: '#000000',
  Line: '#000000',
  Arrow: '#000000',
  Polygon: '#000000',
  PolyLine: '#000000',
  Stamp: '#AA0000',
  Popup: '#000000',
  Redact: '#000000',
  Widget: '#000000',
};

/**
 * Shape accepted by `PDFContext.obj`. Strings become **PDF names** there, so
 * any real text has to be wrapped in `PDFString` / `PDFHexString` first.
 */
type ObjValue = number | boolean | string | null | PDFObject | ObjValue[] | { [key: string]: ObjValue };
type ObjDict = { [key: string]: ObjValue };

/* ------------------------------------------------------------------ *
 * Public API                                                          *
 * ------------------------------------------------------------------ */

/**
 * Append one annotation to `spec.page` and return its 0-based index in that
 * page's `/Annots` array, so a caller can address it again without re-listing.
 */
export function addAnnotation(doc: PDFDocument, spec: AnnotationSpec): number {
  if (!spec || typeof spec !== 'object') {
    throw new Error('Pass an annotation description object to addAnnotation.');
  }
  if (!ANNOTATION_KINDS.includes(spec.kind)) {
    throw new Error(
      `"${String(spec.kind)}" is not an annotation type. Use one of: ${ANNOTATION_KINDS.join(', ')}.`,
    );
  }

  const context = doc.context;
  const page = resolvePage(doc, spec.page);
  // The shape as it was drawn, and the box that same shape occupies once its
  // own rotation is applied. Everything written about position uses `bounds`;
  // everything drawn inside the appearance starts from `shape` and is turned.
  const shape = normaliseRect(spec.rect, spec.kind);
  const angle = normaliseAngle(spec.rotation ?? 0);
  const bounds = rotatedRectBounds(shape, angle);
  // Exactly one reader applies the turn. Where PDF has an entry that can carry
  // it, the angle is *declared* and the geometry and stream stay in the shape's
  // own frame (centred inside the wider /Rect); everywhere else the writer has
  // to bake it, or the mark would come out straight. Both paths agree on /Rect,
  // which is always the box the turned shape occupies.
  const declared = declaredRotation(spec.kind, angle);
  const baked = declared === 0 ? angle : 0;
  const color = colorOf(spec.color, spec.kind);
  const fill = spec.fillColor ? hexToRgb01(spec.fillColor, 'fillColor') : null;
  const stroke = spec.borderColor ? hexToRgb01(spec.borderColor, 'borderColor') : color;
  const strokeWidth = spec.borderWidth ?? defaultStrokeWidth(spec.kind, shape);

  const appearanceRef = appearance(context, doc, spec, shape, bounds, baked, color, fill, stroke, strokeWidth);

  const entries: ObjDict = {
    // Names are written without the leading slash: `PDFName.of` only unescapes
    // `#hh`, so `'/Annot'` would encode as `/#2FAnnot`.
    Type: 'Annot',
    Subtype: dictSubtype(spec.kind),
    // /Rect is [llx lly urx ury] in default user space. For a rotated mark it is
    // the bounding box of the *turned* shape, never the pre-rotation rect, so a
    // viewer that ignores our appearance stream — and anything that clips or
    // prints by /Rect — cannot crop the mark.
    Rect: [round(bounds.x), round(bounds.y), round(bounds.x + bounds.width), round(bounds.y + bounds.height)],
    // PDF 2.0 annotation/page association: the page this annotation belongs
    // to. The geometry stays in /Rect (default user space, lower-left origin),
    // and PDF 1.7 viewers keep using the page's /Annots array, so this is a
    // redundant-but-allowed pointer that our own listAnnotations() prefers
    // when it resolves.
    P: context.getObjectRef(page.node) ?? context.obj([round(bounds.x), round(bounds.y)]),
    C: stroke,
    CA: clamp01(spec.opacity ?? 1),
    BM: 'Normal',
    NM: context.addRandomSuffix('snip', 8),
    F: flagsValue(spec.flags),
    BS: borderStyle(spec.kind, strokeWidth),
    AP: { N: appearanceRef },
  };

  if (spec.author) entries.T = textString(spec.author);
  const created = spec.createdAt instanceof Date ? spec.createdAt : new Date();
  entries.CreationDate = PDFString.fromDate(created);
  entries.M = PDFString.fromDate(created);
  if (spec.contents) entries.Contents = textString(spec.contents);

  if (MARKUP_KINDS.includes(spec.kind)) {
    // /Rect has to contain the quads, so a turned highlight writes them already
    // rotated — unless the angle is declared in /Rotate, where the reader is the
    // one that turns them. Either way it is one quad per line, never one box
    // across the lines.
    entries.QuadPoints = rotateQuadPoints(quadPoints(spec, shape), shape, baked);
  }
  if (INTERIOR_KINDS.includes(spec.kind)) {
    const interior = fill ?? (spec.kind === 'Ink' ? color : null);
    if (interior) entries.IC = interior.map(round);
  }
  if (spec.kind === 'Line' || spec.kind === 'Arrow') {
    entries.LE = lineArrowHeads(spec);
    // /L is the line's geometry, so it follows the same rule as the quads above:
    // turned by the writer when the angle is baked, left straight for the reader
    // when the angle is declared in /Rotate. A line is one of the subtypes PDF
    // allows /Rotate on, so writing the endpoints also writes the mark's shape
    // into the dictionary rather than only into the appearance stream.
    entries.L = rotatedLineEnds(spec, shape, baked);
  }
  if (spec.kind === 'FreeText' || spec.kind === 'Widget') {
    const style = freeTextStyle(doc, spec);
    entries.DA = PDFString.of(style.da);
    entries.DR = { Font: { [style.resourceKey]: style.font.ref } };
  }
  if (spec.kind === 'Stamp' && spec.stampName) {
    entries.S = sanitizeName(spec.stampName);
  }
  if (spec.redact) entries.Redact = true;
  if (declared) entries.Rotate = declared;

  const action = linkAction(doc, spec);
  if (action) {
    entries.A = action.dict;
    if (action.dest) entries.Dest = action.dest;
  }

  const ref = context.register(context.obj(entries));
  page.node.addAnnot(ref);
  const annots = page.node.Annots();
  return annots ? annots.size() - 1 : 0;
}

/** Append many annotations; see [[addAnnotation]]. */
export function addAnnotations(doc: PDFDocument, specs: AnnotationSpec[]): void {
  for (const spec of specs ?? []) addAnnotation(doc, spec);
}

/**
 * Read every annotation the document carries, including on foreign files:
 * page `/Annots` arrays, `/Annots` left on an ancestor of the page tree,
 * indirect *and* direct array entries, indirect `/Rect` numbers, and an
 * annotation's own `/P` page pointer.
 *
 * A subtype this module does not know (e.g. `/FileAttachment` from another
 * editor) is reported verbatim so callers can still filter and remove it.
 */
export function listAnnotations(doc: PDFDocument): ExistingAnnotation[] {
  const context = doc.context;
  const pages = doc.getPages();
  const pageIndexByNode = new Map<PDFObject, number>();
  pages.forEach((page, index) => {
    pageIndexByNode.set(page.node, index);
    const ref = context.getObjectRef(page.node);
    if (ref) {
      const resolved = context.lookup(ref);
      if (resolved) pageIndexByNode.set(resolved, index);
    }
  });

  const out: ExistingAnnotation[] = [];
  pages.forEach((page, index) => {
    for (const { dict, ref } of pageAnnotations(page)) {
      const rect = readRect(dict);
      if (!rect) continue;
      // /P (PDF 2.0) wins over the array the entry was found in when it
      // resolves to a page of this document.
      const pointer = deref(context, dict.get(PDFName.of('P')));
      const pointedPage =
        pointer instanceof PDFDict ? pageIndexByNode.get(pointer) : undefined;
      const contents = readText(dict, PDFName.of('Contents'));
      const color = readColor(dict, PDFName.of('C'));
      const flags = readInt(dict, PDFName.of('F'));
      out.push({
        kind: readKind(readName(dict, PDFName.of('Subtype')), readNames(dict, PDFName.of('LE'))),
        page: pointedPage ?? index,
        rect,
        rotation: normaliseAngle(readInt(dict, PDFName.of('Rotate'))),
        ...(contents !== undefined ? { contents } : {}),
        ...(color !== undefined ? { color } : {}),
        readonly: (flags & FLAG_BITS.ReadOnly) !== 0,
        flags,
        ref,
      });
    }
  });
  return out;
}

/**
 * Delete annotations from every page they appear on and drop their objects.
 * `pages` are 0-based; `kinds` whitelists and `except` blacklists by kind.
 * With no filter at all nothing is removed — that is almost always a bug in
 * the caller rather than an intent to nuke the document.
 */
export function removeAnnotations(
  doc: PDFDocument,
  filter: { pages?: number[]; kinds?: AnnotationKind[]; except?: AnnotationKind[] },
): number {
  const options = filter ?? {};
  if (!options.pages && !options.kinds && !options.except) return 0;

  const wanted = options.kinds ? new Set<AnnotationKind>(options.kinds) : null;
  const banned = options.except ? new Set<AnnotationKind>(options.except) : null;
  const pagesWanted = options.pages ? new Set(options.pages) : null;

  const context = doc.context;
  let removed = 0;
  const handled = new Set<string>();

  doc.getPages().forEach((page, index) => {
    if (pagesWanted && !pagesWanted.has(index)) return;
    for (const array of annotationArrays(page)) {
      // One ancestor array is shared by every page beneath it: visit it once.
      const identityOf = context.getObjectRef(array)?.toString() ?? context.getObjectRef(page.node)!.toString();
      if (handled.has(identityOf)) continue;
      handled.add(identityOf);
      for (let i = array.size() - 1; i >= 0; i -= 1) {
        const entry = array.get(i);
        const dict = deref(context, entry);
        if (!(dict instanceof PDFDict)) continue;
        const kind = readKind(readName(dict, PDFName.of('Subtype')), readNames(dict, PDFName.of('LE')));
        if (wanted && !wanted.has(kind)) continue;
        if (banned && banned.has(kind)) continue;
        array.remove(i);
        if (entry instanceof PDFRef) context.delete(entry);
        removed += 1;
      }
    }
  });
  return removed;
}

/** Number of annotations in the document; see [[listAnnotations]]. */
export function annotationCount(doc: PDFDocument): number {
  return listAnnotations(doc).length;
}

/* ------------------------------------------------------------------ *
 * Geometry + dictionary value helpers                                 *
 * ------------------------------------------------------------------ */

function resolvePage(doc: PDFDocument, index: number): PDFPage {
  const total = doc.getPageCount();
  if (!Number.isInteger(index) || index < 0 || index >= total) {
    throw new Error(
      `That annotation targets page ${(Number.isInteger(index) ? index : 0) + 1}, but this document has ${total} page${total === 1 ? '' : 's'}. Pick a page inside the document.`,
    );
  }
  return doc.getPage(index);
}

function normaliseRect(rect: QuadRect, kind: AnnotationKind): QuadRect {
  if (!rect) throw new Error(`The ${kind} annotation needs a rect ({ x, y, width, height }).`);
  const { x, y, width, height } = rect;
  if (![x, y, width, height].every(Number.isFinite)) {
    throw new Error(`The ${kind} annotation rect has a non-numeric value; pass plain numbers in PDF points.`);
  }
  return {
    x: width < 0 ? x + width : x,
    y: height < 0 ? y + height : y,
    width: Math.abs(width),
    height: Math.abs(height),
  };
}

/**
 * Whether PDF lets this subtype declare its own rotation, and what it may say.
 *
 * PDF 32000-1 §12.5.6.5 gives `/Rotate` to text markup annotations **except**
 * Highlight, and to line annotations, and only ever in steps of 90°. Anywhere
 * else, or at any other angle, the turn is not the reader's to apply: it lives
 * in `/Rect`, in the rotated quads, and in the appearance stream, and claiming it
 * here would tell a conforming reader to turn the mark a second time.
 */
function declaredRotation(kind: AnnotationKind, degrees: number): number {
  const angle = normaliseAngle(degrees);
  if (angle === 0 || angle % 90 !== 0) return 0;
  if (kind === 'Line' || kind === 'Arrow') return angle;
  return MARKUP_KINDS.includes(kind) && kind !== 'Highlight' ? angle : 0;
}

/**
 * The `cm` that turns a shape drawn in its own box into the appearance space of
 * the rotated `/Rect`.
 *
 * Stream coordinates normally start at the rect's lower-left, and the `/BBox`
 * is the size of the rotated bounds, so the matrix has to do both jobs: rotate
 * about the centre of the shape's own box, then slide the turned box until it
 * sits centred inside the axis-aligned bounds. With `degrees` at 0 it degenerates
 * to that translation alone, which is what a `/Rotate`-declared annotation needs
 * — the reader supplies the turn, the stream supplies the centring.
 */
function rotationMatrix(shape: QuadRect, bounds: QuadRect, degrees: number): number[] {
  const rad = (normaliseAngle(degrees) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = shape.width / 2;
  const cy = shape.height / 2;
  return [
    round(cos),
    round(-sin),
    round(sin),
    round(cos),
    round(cx - (cos * cx + sin * cy) + (shape.x - bounds.x)),
    round(cy - (-sin * cx + cos * cy) + (shape.y - bounds.y)),
  ];
}

/** PDF has no `Arrow` subtype — an arrow is a `/Line` with an arrow head in `/LE`. */
function dictSubtype(kind: AnnotationKind): string {
  return kind === 'Arrow' ? 'Line' : kind;
}

function defaultStrokeWidth(kind: AnnotationKind, rect: QuadRect): number {
  if (kind === 'Highlight' || kind === 'Redact' || kind === 'Popup') return 0;
  // A link's box is drawn with a fixed rule rather than a pen the user chose, and
  // `/BS` has to describe the stroke the appearance stream lays down.
  if (kind === 'Link') return 1;
  if (MARKUP_KINDS.includes(kind)) return clamp(Math.min(Math.max(rect.height * 0.06, 0.6), 2), 0.2, 12);
  return 1;
}

/**
 * `/BS` — the border a viewer draws when it paints the dictionary instead of
 * `/AP`. A link is dashed here and in its appearance stream, so the two cannot
 * tell two stories about the same box.
 */
function borderStyle(kind: AnnotationKind, strokeWidth: number): ObjDict {
  const border: ObjDict = { W: round(strokeWidth), S: 'S' };
  if (kind === 'Link') border.D = [...LINK_BORDER_DASH];
  return border;
}

function flagsValue(names: string[] | undefined): number {
  if (!names || names.length === 0) return PRINT_FLAG;
  let value = 0;
  for (const raw of names) {
    const bit = FLAG_BITS[String(raw).trim()];
    if (!bit) {
      throw new Error(`"${raw}" is not an annotation flag. Use one of: ${Object.keys(FLAG_BITS).join(', ')}.`);
    }
    value |= bit;
  }
  return value;
}

/**
 * Quad areas for text markup. `spec.quadPoints` wins (8 numbers per quad in
 * default user space, ordered upper-left, upper-right, lower-left,
 * lower-right — PDF 32000-1 Table 171). Otherwise the annotation rect becomes
 * a single quad.
 */
function quadPoints(spec: AnnotationSpec, rect: QuadRect): number[] {
  const given = spec.quadPoints;
  if (given && given.length >= 8 && given.length % 8 === 0 && given.every(Number.isFinite)) {
    return given.map((v) => round(clamp(v, -1e6, 1e6)));
  }
  const { x, y, width: w, height: h } = rect;
  return [round(x), round(y + h), round(x + w), round(y + h), round(x), round(y), round(x + w), round(y)];
}

/** The same quads, translated into the appearance stream's local space. */
function localQuads(spec: AnnotationSpec, rect: QuadRect): number[][] {
  return chunkQuads(quadPoints(spec, rect)).map((q) =>
    q.map((v, i) => round(v - (i % 2 === 0 ? rect.x : rect.y))),
  );
}

function chunkQuads(points: number[]): number[][] {
  const quads: number[][] = [];
  for (let i = 0; i + 7 < points.length; i += 8) quads.push(points.slice(i, i + 8));
  return quads;
}

/** The four corners of one flat quad, in the order `/QuadPoints` stores them. */
function quadStored(q: number[]): QuadCorner[] {
  return [
    { x: q[0], y: q[1] },
    { x: q[2], y: q[3] },
    { x: q[4], y: q[5] },
    { x: q[6], y: q[7] },
  ];
}

/** Corner points of a quad in ring order (UL → UR → LR → LL). */
function quadCorners(q: number[]): QuadCorner[] {
  return quadRing(quadStored(q));
}

function quadHeight(q: number[]): number {
  const p = quadCorners(q);
  return Math.hypot(p[0].x - p[3].x, p[0].y - p[3].y) || 1;
}

function lineEndsOf(
  spec: AnnotationSpec,
  rect: QuadRect,
  local: boolean,
): [number, number, number, number] {
  const raw = spec.lineEnds;
  const ends: [number, number, number, number] =
    raw && raw.every(Number.isFinite) ? [raw[0], raw[1], raw[2], raw[3]] : [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height];
  if (!local) return ends;
  return [ends[0] - rect.x, ends[1] - rect.y, ends[2] - rect.x, ends[3] - rect.y];
}

/** The `/L` array: the endpoints, turned by whatever the writer is baking. */
function rotatedLineEnds(spec: AnnotationSpec, shape: QuadRect, degrees: number): number[] {
  const [x1, y1, x2, y2] = lineEndsOf(spec, shape, false);
  if (normaliseAngle(degrees) === 0) return [x1, y1, x2, y2].map(round);
  const centre = rectCentre(shape);
  const from = rotatePointAbout({ x: x1, y: y1 }, centre, degrees);
  const to = rotatePointAbout({ x: x2, y: y2 }, centre, degrees);
  return [from.x, from.y, to.x, to.y].map(round);
}

function lineArrowHeads(
  spec: AnnotationSpec,
): ('None' | 'OpenArrow' | 'ClosedArrow')[] {
  const choice = spec.lineArrow ?? (spec.kind === 'Arrow' ? 'end' : 'none');
  // `Line` honours an explicit `lineArrow` with the hollow PDF arrow heads;
  // the dedicated `Arrow` kind uses the filled variant most viewers prefer.
  const head: 'OpenArrow' | 'ClosedArrow' = spec.kind === 'Line' ? 'OpenArrow' : 'ClosedArrow';
  switch (choice) {
    case 'start':
      return [head, 'None'];
    case 'both':
      return [head, head];
    case 'end':
      return ['None', head];
    default:
      return ['None', 'None'];
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const clamp01 = (v: number) => (Number.isFinite(v) ? clamp(v, 0, 1) : 1);
const round = (v: number) => Math.round(v * 1000) / 1000;

/** `#rgb` / `#rrggbb` → `[r, g, b]` in 0..1. */
export function hexToRgb01(hex: string, field = 'color'): [number, number, number] {
  const value = String(hex ?? '').trim().replace(/^#/, '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(
      `"${hex}" is not a colour this annotation can use. Pass a hex value such as #ff8800 in ${field}.`,
    );
  }
  const int = Number.parseInt(full, 16);
  return [round(((int >> 16) & 255) / 255), round(((int >> 8) & 255) / 255), round((int & 255) / 255)];
}

function rgb01ToHex(rgb: readonly number[]): string {
  const part = (v: number) => Math.round(clamp01(Number.isFinite(v) ? v : 0) * 255).toString(16).padStart(2, '0');
  return `#${part(rgb[0])}${part(rgb[1])}${part(rgb[2])}`;
}

function colorOf(hex: string | undefined, kind: AnnotationKind): [number, number, number] {
  if (hex) return hexToRgb01(hex, 'color');
  return hexToRgb01(DEFAULT_COLOR[kind] ?? '#000000', 'color');
}

/**
 * PDF text strings are never plain JS strings: a literal string is single-byte,
 * so anything outside WinAnsi would be mangled. Write UTF-16BE with a
 * byte-order mark (PDF 32000-1 §7.9.2.2), which every viewer accepts.
 */
function textString(text: string): PDFHexString {
  const bytes: number[] = [0xfe, 0xff];
  for (const char of String(text ?? '')) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp > 0xffff) {
      const c = cp - 0x10000;
      const hi = 0xd800 + (c >> 10);
      const lo = 0xdc00 + (c & 0x3ff);
      bytes.push(hi >> 8, hi & 255, lo >> 8, lo & 255);
    } else {
      bytes.push(cp >> 8, cp & 255);
    }
  }
  return PDFHexString.of(bytes.map((b) => b.toString(16).padStart(2, '0')).join(''));
}

/**
 * The text operand of a `Tj`: `PDFHexString` prints upper-case digits, and the
 * streams written here stay lower-case so the same byte pairs can be read back
 * out of them (a hex string is case-insensitive, PDF 32000-1 §7.3.4.3).
 */
function showOperand(font: PDFFont, text: string): string {
  return `<${font.encodeText(text).asString().toLowerCase()}>`;
}

/* Readers tolerant of indirect values, which is how most producers write. */

/**
 * Resolve one level of indirection without throwing: in `@maxwbh/pdf-lib`
 * `lookupMaybe` raises `UnexpectedObjectTypeError` when the target exists but
 * is of another type — precisely what a foreign document can put behind any
 * given key.
 */
function deref(context: PDFContext, value: unknown): PDFObject | undefined {
  if (value === undefined || value === null || value === PDFNull) return undefined;
  return value instanceof PDFRef ? context.lookup(value) : (value as PDFObject);
}

function readNames(dict: PDFDict, key: PDFName): string[] {
  const context = dict.context;
  const resolved = deref(context, dict.get(key));
  const names: string[] = [];
  const collect = (entry: unknown) => {
    const object = deref(context, entry);
    if (object instanceof PDFName) names.push(decodeName(object.asString().replace(/^\//, '')));
  };
  if (resolved instanceof PDFArray) {
    for (let i = 0; i < resolved.size(); i += 1) collect(resolved.get(i));
  } else if (resolved) {
    collect(resolved);
  }
  return names;
}

function readName(dict: PDFDict, key: PDFName): string | null {
  return readNames(dict, key)[0] ?? null;
}

function readInt(dict: PDFDict, key: PDFName): number {
  const value = deref(dict.context, dict.get(key));
  return value instanceof PDFNumber ? value.asNumber() : 0;
}

function readText(dict: PDFDict, key: PDFName): string | undefined {
  const value = deref(dict.context, dict.get(key));
  if (!(value instanceof PDFString) && !(value instanceof PDFHexString)) return undefined;
  try {
    return value.decodeText();
  } catch {
    return value.asString();
  }
}

function readColor(dict: PDFDict, key: PDFName): string | undefined {
  const array = deref(dict.context, dict.get(key));
  if (!(array instanceof PDFArray) || array.size() < 3) return undefined;
  const parts: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const component = deref(dict.context, array.get(i));
    if (!(component instanceof PDFNumber)) return undefined;
    parts.push(component.asNumber());
  }
  return rgb01ToHex(parts);
}

function readRect(dict: PDFDict): QuadRect | null {
  const array = deref(dict.context, dict.get(PDFName.of('Rect')));
  if (!(array instanceof PDFArray) || array.size() < 4) return null;
  const numbers: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const corner = deref(dict.context, array.get(i));
    if (!(corner instanceof PDFNumber)) return null;
    numbers.push(corner.asNumber());
  }
  const [a, b, c, d] = numbers;
  return { x: Math.min(a, c), y: Math.min(b, d), width: Math.abs(c - a), height: Math.abs(d - b) };
}

/** Undo `#hh` escapes and drop the leading slash. */
function decodeName(encoded: string): string {
  return encoded.replace(/#([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/** Map a stored dictionary back onto an `AnnotationKind`. */
function readKind(subtype: string | null, lineEnds: string[]): AnnotationKind {
  if (!subtype) return 'Popup';
  // An arrow round-trips as `Arrow` even though its /Subtype is `/Line`.
  if (subtype === 'Line') return lineEnds.some((head) => head && head !== 'None') ? 'Arrow' : 'Line';
  return subtype as AnnotationKind;
}

/**
 * A page's annotation dictionaries. Handles an indirect `/Annots` array, direct
 * and indirect entries (direct entries are made indirect so the returned `ref`
 * is authoritative and removable), and `/Annots` parked on an ancestor of the
 * page tree — not inheritable per PDF 1.7, but written by some producers, and
 * only consulted when the page itself has none.
 */
function pageAnnotations(page: PDFPage): { dict: PDFDict; ref: PDFRef; array: PDFArray; slot: number }[] {
  const context = page.doc.context;
  const out: { dict: PDFDict; ref: PDFRef; array: PDFArray; slot: number }[] = [];
  for (const array of annotationArrays(page)) {
    for (let i = 0; i < array.size(); i += 1) {
      const entry = array.get(i);
      const dict = deref(context, entry);
      if (!(dict instanceof PDFDict)) continue;
      let ref = entry instanceof PDFRef ? entry : context.getObjectRef(dict);
      if (!ref) {
        // Direct entries cannot be addressed later, so make them indirect.
        ref = context.register(dict);
        array.set(i, ref);
      }
      out.push({ dict, ref, array, slot: i });
    }
  }
  return out;
}

/**
 * The `/Annots` arrays a page draws its annotations from: its own, or — only
 * when it has none — one left on an ancestor of the page tree by producers that
 * treat `/Annots` as inheritable (it is not, per PDF 1.7, but viewers tolerate
 * it). A shared ancestor array is reported once per page, which is what the
 * viewers show.
 */
function annotationArrays(page: PDFPage): PDFArray[] {
  const context = page.doc.context;
  const own = deref(context, page.node.get(PDFName.of('Annots')));
  if (own instanceof PDFArray) return [own];
  const inherited: PDFArray[] = [];
  page.node.ascend((node) => {
    if (node === page.node) return;
    const candidate = deref(context, node.get(PDFName.of('Annots')));
    if (candidate instanceof PDFArray && !inherited.includes(candidate)) inherited.push(candidate);
  });
  return inherited;
}

/* ------------------------------------------------------------------ *
 * Appearance streams                                                  *
 * ------------------------------------------------------------------ */

interface Appearance {
  /** Operators in the appearance's own space (origin = rect lower-left). */
  ops: string;
  fonts?: Record<string, PDFFont>;
  images?: Record<string, PDFRef>;
  extGState?: Record<string, PDFRef>;
}

const FONT_KEY = 'F1';
const IMAGE_KEY = 'Im0';
const GS_KEY = 'GS1';

/**
 * Register a self-contained Form XObject and return its reference.
 * `/Length` must be the length of the *encoded* bytes, so the stream is built
 * first and patched afterwards — pdf-lib does not compute it for raw streams.
 * `/Font`, `/XObject` and `/ExtGState` are only declared when the operators
 * actually reference them.
 */
function registerAppearance(
  context: PDFContext,
  ap: Appearance,
  rect: QuadRect,
  matrix: number[] = [1, 0, 0, 1, 0, 0],
): PDFRef {
  const resources: ObjDict = {};
  const fontEntries: ObjDict = {};
  const imageEntries: ObjDict = {};
  const stateEntries: ObjDict = {};
  for (const [key, font] of Object.entries(ap.fonts ?? {})) fontEntries[key] = font.ref;
  for (const [key, ref] of Object.entries(ap.images ?? {})) imageEntries[key] = ref;
  for (const [key, ref] of Object.entries(ap.extGState ?? {})) stateEntries[key] = ref;
  if (Object.keys(fontEntries).length > 0) resources.Font = fontEntries;
  if (Object.keys(imageEntries).length > 0) resources.XObject = imageEntries;
  if (Object.keys(stateEntries).length > 0) resources.ExtGState = stateEntries;

  // A turn is baked in rather than left to `/Matrix` so that a viewer painting
  // the stream sees exactly the mark the overlay drew, whatever it makes of the
  // dictionary around it.
  const turned = matrix.join(' ') !== '1 0 0 1 0 0';
  const ops = turned ? `q\n${matrix.join(' ')} cm\n${ap.ops}\nQ` : ap.ops;
  const stream = context.flateStream(`${ops}\n`, {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: [0, 0, round(rect.width), round(rect.height)],
    Matrix: [1, 0, 0, 1, 0, 0],
    Resources: resources,
  });
  stream.dict.set(PDFName.of('Length'), PDFNumber.of(stream.contents.length));
  return context.register(stream);
}

/** `/Type /ExtGState /BM /Multiply` — highlight ink must darken, not cover. */
function multiplyState(context: PDFContext): PDFRef {
  return context.register(context.obj({ Type: 'ExtGState', BM: 'Multiply' }));
}

const paint = (rgb: readonly number[], fill: boolean): string =>
  `${rgb.map(round).join(' ')} ${fill ? 'rg' : 'RG'}`;

function appearance(
  context: PDFContext,
  doc: PDFDocument,
  spec: AnnotationSpec,
  shape: QuadRect,
  bounds: QuadRect,
  degrees: number,
  color: [number, number, number],
  fill: [number, number, number] | null,
  stroke: [number, number, number],
  strokeWidth: number,
): PDFRef {
  const rect = shape;
  const w = round(rect.width);
  const h = round(rect.height);
  const ap: Appearance = { ops: 'q Q' };

  switch (spec.kind) {
    case 'Highlight':
    case 'Underline':
    case 'StrikeOut':
    case 'Squiggly':
    case 'Caret':
      ap.ops = markupOps(spec, rect, color, stroke, strokeWidth);
      if (spec.kind === 'Highlight') ap.extGState = { [GS_KEY]: multiplyState(context) };
      break;
    case 'Text':
      ap.ops = noteOps(rect, fill ?? color, stroke);
      break;
    case 'Popup':
      // Viewers draw their own pop-up chrome; this keeps the box printable.
      ap.ops = [
        'q',
        '1 1 1 rg',
        rectPath(0, 0, w, h),
        'f',
        '0.6 0.6 0.6 RG',
        '0.5 w',
        rectPath(0.25, 0.25, Math.max(w - 0.5, 0.5), Math.max(h - 0.5, 0.5)),
        'S',
        'Q',
      ].join('\n');
      break;
    case 'Link':
      // See `LINK_WASH_ALPHA`: a link is a click target *and* the box the editor
      // drew over it, so the stream paints that box.
      ap.ops = linkOps(shape, stroke, strokeWidth);
      ap.extGState = { [GS_KEY]: linkWashState(context) };
      break;
    case 'Redact':
      ap.ops = ['q', paint(fill ?? color, true), rectPath(0, 0, w, h), 'f', 'Q'].join('\n');
      break;
    case 'FreeText':
      ap.ops = freeTextOps(doc, spec, rect, color, fill, stroke, strokeWidth, ap);
      break;
    case 'Widget':
      ap.ops = widgetOps(doc, spec, rect, color, fill, stroke, strokeWidth, ap);
      break;
    case 'Ink':
      ap.ops = inkOps(spec, rect, fill ?? color, strokeWidth);
      break;
    case 'Square':
      ap.ops = shapeOps('rect', spec, rect, fill, stroke, strokeWidth);
      break;
    case 'Circle':
      ap.ops = shapeOps('ellipse', spec, rect, fill, stroke, strokeWidth);
      break;
    case 'Polygon':
      ap.ops = shapeOps('polygon', spec, rect, fill, stroke, strokeWidth);
      break;
    case 'PolyLine':
      ap.ops = shapeOps('polyline', spec, rect, fill, stroke, strokeWidth);
      break;
    case 'Line':
    case 'Arrow':
      ap.ops = lineOps(spec, rect, stroke, strokeWidth);
      break;
    case 'Stamp':
      ap.ops = stampOps(doc, spec, rect, fill ?? color, stroke, ap);
      break;
  }

  return registerAppearance(context, ap, bounds, rotationMatrix(shape, bounds, degrees));
}

function markupOps(
  spec: AnnotationSpec,
  rect: QuadRect,
  color: [number, number, number],
  stroke: [number, number, number],
  strokeWidth: number,
): string {
  const quads = localQuads(spec, rect);
  const parts: string[] = ['q'];
  switch (spec.kind) {
    case 'Highlight':
      parts.push(`/${GS_KEY} gs`, paint(color, true));
      for (const q of quads) parts.push(`${polygonPath(quadCorners(q).map((p) => [p.x, p.y]))} h`, 'f');
      break;
    case 'Caret': {
      const q = quads[0] ?? [0, rect.height, rect.width, rect.height, 0, 0, rect.width, 0];
      const corners = quadCorners(q);
      const stem = clamp(quadHeight(q) * 0.1, 0.8, 3);
      const cap = stem * 2.4;
      const x = clamp(corners[0].x + stem / 2, cap / 2, Math.max(rect.width - cap / 2, cap / 2));
      const top = Math.max(corners[0].y, corners[1].y);
      const bottom = Math.min(corners[2].y, corners[3].y);
      parts.push(paint(stroke, true));
      parts.push(rectPath(x - cap / 2, top - stem, cap, stem), 'f');
      parts.push(rectPath(x - cap / 2, bottom, cap, stem), 'f');
      parts.push(rectPath(x - stem / 2, bottom, stem, Math.max(top - bottom - 2 * stem, 0)), 'f');
      break;
    }
    default: {
      // The rule's height comes from the shared markup rule, so the line in the
      // file is the line the overlay drew.
      const width = round(Math.max(strokeWidth, 0.2));
      parts.push(paint(stroke, false), `${width} w`, '1 J', '1 j');
      for (const q of quads) {
        const line = markupRule(quadStored(q), spec.kind as 'Underline' | 'StrikeOut' | 'Squiggly', width);
        if (spec.kind === 'Squiggly') {
          parts.push(squigglePath(line, quadHeight(q), width), 'S');
        } else {
          parts.push(`${f(line.x1)} ${f(line.y1)} m`, `${f(line.x2)} ${f(line.y2)} l`, 'S');
        }
      }
      break;
    }
  }
  parts.push('Q');
  return parts.join('\n');
}

/**
 * The link's box: a translucent wash over the click area and a dashed rule on
 * its edge, both in the mark's colour.
 *
 * The rule is stroked *inside* the rect because an appearance is clipped to its
 * own `/BBox`, which is the size of `/Rect` — centred on the geometry, half the
 * stroke would be cut off and the box would read thinner than the one on screen.
 */
function linkOps(
  rect: QuadRect,
  color: [number, number, number],
  strokeWidth: number,
): string {
  const w = round(rect.width);
  const h = round(rect.height);
  const width = round(Math.max(strokeWidth, 0.2));
  const inset = Math.min(width / 2, Math.min(w, h) / 2);
  return [
    'q',
    `/${GS_KEY} gs`,
    paint(color, true),
    rectPath(0, 0, w, h),
    'f',
    paint(color, false),
    `${f(width)} w`,
    `[${LINK_BORDER_DASH.join(' ')}] 0 d`,
    rectPath(inset, inset, w - inset * 2, h - inset * 2),
    'S',
    'Q',
  ].join('\n');
}

/** Fill alpha only, so the link's wash is see-through and its rule is not. */
function linkWashState(context: PDFContext): PDFRef {
  return context.register(context.obj({ Type: 'ExtGState', ca: LINK_WASH_ALPHA }));
}

/** Sticky-note icon: body with the top-right corner folded over. */
function noteOps(rect: QuadRect, body: [number, number, number], edge: [number, number, number]): string {
  const w = round(rect.width);
  const h = round(rect.height);
  const foldX = round(w * 0.68);
  const foldY = round(h * 0.68);
  const outline = `0 0 m ${w} 0 l ${w} ${foldY} l ${foldX} ${h} l 0 ${h} l h`;
  return [
    'q',
    paint(body, true),
    outline,
    'f',
    paint(edge, true),
    `${foldX} ${h} m ${w} ${foldY} l ${w} ${h} l h`,
    'f',
    paint(edge, false),
    '0.5 w',
    outline,
    'S',
    'Q',
  ].join('\n');
}

function inkOps(
  spec: AnnotationSpec,
  rect: QuadRect,
  color: [number, number, number],
  strokeWidth: number,
): string {
  const parts: string[] = ['q', paint(color, false), `${round(Math.max(strokeWidth, 0.2))} w`, '1 J', '1 j'];
  for (const stroke of strokesOf(spec, rect)) parts.push(openPath(stroke), 'S');
  parts.push('Q');
  return parts.join('\n');
}

function shapeOps(
  shape: 'rect' | 'ellipse' | 'polygon' | 'polyline',
  spec: AnnotationSpec,
  rect: QuadRect,
  fill: [number, number, number] | null,
  stroke: [number, number, number],
  strokeWidth: number,
): string {
  const sw = Math.max(strokeWidth, 0);
  const parts: string[] = ['q'];
  let path: string;
  if (shape === 'rect') {
    path = rectPath(sw / 2, sw / 2, Math.max(rect.width - sw, 0.1), Math.max(rect.height - sw, 0.1));
  } else if (shape === 'ellipse') {
    path = ellipsePath(sw / 2, sw / 2, Math.max(rect.width - sw, 0.1), Math.max(rect.height - sw, 0.1));
  } else {
    const points = strokesOf(spec, rect)[0];
    path = shape === 'polygon' ? `${polygonPath(points)} h` : openPath(points);
  }
  if (fill && shape !== 'polyline') parts.push(paint(fill, true), path, 'f');
  if (sw > 0 || shape === 'polyline' || !fill) {
    parts.push(paint(stroke, false), `${round(sw || 1)} w`, '1 j', '1 J', path, 'S');
  }
  parts.push('Q');
  return parts.join('\n');
}

function lineOps(
  spec: AnnotationSpec,
  rect: QuadRect,
  stroke: [number, number, number],
  strokeWidth: number,
): string {
  const [x1, y1, x2, y2] = lineEndsOf(spec, rect, true).map(round);
  const sw = round(Math.max(strokeWidth, 0.2));
  const parts: string[] = ['q', paint(stroke, false), `${sw} w`, '1 J', '1 j', `${x1} ${y1} m`, `${x2} ${y2} l`, 'S'];
  const [startHead, endHead] = lineArrowHeads(spec);
  const head = clamp(Math.hypot(x2 - x1, y2 - y1) * 0.22, 4, Math.max(rect.width, rect.height) * 0.5);
  if (endHead !== 'None') parts.push(arrowPath(x1, y1, x2, y2, head, endHead));
  if (startHead !== 'None') parts.push(arrowPath(x2, y2, x1, y1, head, startHead));
  parts.push('Q');
  return parts.join('\n');
}

/** Arrow head with its tip at (`tipX`,`tipY`), pointing away from (`fromX`,`fromY`). */
function arrowPath(
  fromX: number,
  fromY: number,
  tipX: number,
  tipY: number,
  length: number,
  style: 'OpenArrow' | 'ClosedArrow',
): string {
  const angle = Math.atan2(tipY - fromY, tipX - fromX);
  const spread = Math.PI / 7;
  const wing = (offset: number) => ({
    x: round(tipX - length * Math.cos(angle + offset)),
    y: round(tipY - length * Math.sin(angle + offset)),
  });
  const a = wing(spread);
  const b = wing(-spread);
  if (style === 'OpenArrow') {
    return [`${a.x} ${a.y} m`, `${round(tipX)} ${round(tipY)} l`, `${b.x} ${b.y} l`, 'S'].join(' ');
  }
  const notch = {
    x: round(tipX - length * 0.35 * Math.cos(angle)),
    y: round(tipY - length * 0.35 * Math.sin(angle)),
  };
  return [
    `${round(tipX)} ${round(tipY)} m`,
    `${a.x} ${a.y} l`,
    `${notch.x} ${notch.y} l`,
    `${b.x} ${b.y} l`,
    'h f',
  ].join(' ');
}

function stampOps(
  doc: PDFDocument,
  spec: AnnotationSpec,
  rect: QuadRect,
  body: [number, number, number],
  edge: [number, number, number],
  ap: Appearance,
): string {
  if (spec.stampXObject) {
    ap.images = { [IMAGE_KEY]: spec.stampXObject.ref };
    // Image space is the unit square; scale it onto the whole rect.
    return [
      'q',
      `${round(rect.width)} 0 0 ${round(rect.height)} 0 0 cm`,
      `/${IMAGE_KEY} Do`,
      'Q',
    ].join('\n');
  }
  if (spec.stampImage && spec.stampImage.length > 0) {
    const image = embedRasterImage(doc, spec.stampImage);
    ap.images = { [IMAGE_KEY]: image.ref };
    // Image space is the unit square; scale it onto the whole rect.
    return [
      'q',
      `${round(rect.width)} 0 0 ${round(rect.height)} 0 0 cm`,
      `/${IMAGE_KEY} Do`,
      'Q',
    ].join('\n');
  }
  const font = textFace(doc, spec);
  const shared = spec.textStyle?.style;
  const label = textForFace(font, spec.stampName ?? 'Stamp');
  ap.fonts = { [FONT_KEY]: font };
  const box = Math.max(rect.width - 6, 1);
  // The size the label fits at, and the size the style asked for. A stamp box is
  // the rectangle the user dragged, so a label that would run past it is shrunk to
  // fit — and `fitStampSize` is the same answer the overlay drew, so the shrink is
  // on the screen before it is in the file rather than a surprise after.
  const fitted = fitSize(font, label, box, Math.max(rect.height * 0.5, 1));
  const size = shared ? fitStampSize(shared.size, fitted) : fitted;
  const textWidth = font.widthOfTextAtSize(label, size);
  const inset = round(freeTextInset(size));
  const first = spec.textStyle?.lines?.[0];
  const x = first ? round(first.x) : round(stampLabelX(spec, rect, textWidth, inset));
  const y = first ? round(first.baseline) : round(Math.max(rect.height / 2 - size / 2, 2));
  const ink = shared?.color ? hexToRgb01(shared.color, 'text.style.color') : body;
  return [
    'q',
    paint(edge, false),
    '1 w',
    rectPath(0.5, 0.5, Math.max(rect.width - 1, 0.5), Math.max(rect.height - 1, 0.5)),
    'S',
    paint(ink, true),
    'BT',
    `/${FONT_KEY} ${round(size)} Tf`,
    `1 0 0 1 ${x} ${y} Tm`,
    `${showOperand(font, label)} Tj`,
    'ET',
    'Q',
  ].join('\n');
}

/**
 * Where a stamp label starts, horizontally, at the alignment the style carries.
 *
 * Centred is the format's own convention for a stamp, so that is what a mark with
 * no style on it gets; left and right keep the same inset the text box uses.
 */
function stampLabelX(
  spec: AnnotationSpec,
  rect: QuadRect,
  textWidth: number,
  inset: number,
): number {
  const align = spec.textStyle?.style?.align ?? 'center';
  if (align === 'left') return Math.max(inset, 2);
  if (align === 'right') return Math.max(rect.width - inset - textWidth, inset);
  return Math.max((rect.width - textWidth) / 2, 2);
}

/**
 * The size a stamp label is drawn at: what the style asked for, never more than
 * the box holds.
 *
 * Exported because the overlay and the appearance stream must shrink the same way;
 * a preview that shows 24 pt and a file that writes 14 pt is the drift this
 * campaign keeps calling out.
 */
export function fitStampSize(wanted: number, fitted: number): number {
  return round(Math.max(Math.min(wanted, fitted), 1));
}

/* ------------------------------------------------------------------ *
 * FreeText                                                            *
 * ------------------------------------------------------------------ */

interface TextLayout {
  font: PDFFont;
  resourceKey: string;
  size: number;
  /** Lines this module wrapped itself, in text order, top line first. */
  lines: string[];
  /**
   * Lines the caller laid out with the faces the file gets, already in this
   * appearance's own space. When present they win over `lines`, because they are
   * the same line breaks the overlay drew.
   */
  prepared?: LaidOutLine[];
  ascent: number;
  lineHeight: number;
  inset: number;
  textColor: [number, number, number];
  align: 'left' | 'center' | 'right';
}

/**
 * The standard-14 faces, keyed by the family ids `core/text-style` registers.
 */
const STANDARD_FACES: Record<string, Record<string, StandardFonts>> = {
  'std:helvetica': {
    '': StandardFonts.Helvetica,
    b: StandardFonts.HelveticaBold,
    i: StandardFonts.HelveticaOblique,
    bi: StandardFonts.HelveticaBoldOblique,
  },
  'std:times': {
    '': StandardFonts.TimesRoman,
    b: StandardFonts.TimesRomanBold,
    i: StandardFonts.TimesRomanItalic,
    bi: StandardFonts.TimesRomanBoldItalic,
  },
  'std:courier': {
    '': StandardFonts.Courier,
    b: StandardFonts.CourierBold,
    i: StandardFonts.CourierOblique,
    bi: StandardFonts.CourierBoldOblique,
  },
};

/** The bare spellings older callers and stored parameters used for the same three. */
const LEGACY_STANDARD_IDS: Record<string, string> = {
  helvetica: 'std:helvetica',
  times: 'std:times',
  courier: 'std:courier',
};

const embeddedFonts = new WeakMap<PDFDocument, Map<string, PDFFont>>();

/**
 * The standard-14 face for a style: **the real face for each posture**, never a
 * synthesised one. `Helvetica-Bold` and `Helvetica-Oblique` are separate fonts a
 * reader owns, so a slant named here is a slant in the file.
 *
 * Standard-14 faces only: `addAnnotation` is synchronous (contract §2), so the
 * script-font path in `core/fonts.ts` — which fetches a Unicode face — is not
 * reachable from here. A caller that wants the bundled Noto, a fetched script face
 * or a device font embeds it first and passes it on `spec.textStyle.font`; what it
 * passes is what this module writes, and characters the face cannot encode are
 * replaced by a close WinAnsi lookalike, then `?`.
 */
function standardFont(
  doc: PDFDocument,
  style: { fontFamily?: string; bold?: boolean; italic?: boolean; monospace?: boolean },
): PDFFont {
  const family = pickFamily(style);
  const variant = `${style.bold ? 'b' : ''}${style.italic ? 'i' : ''}`;
  const face = `${family}:${variant}`;
  let perDoc = embeddedFonts.get(doc);
  if (!perDoc) {
    perDoc = new Map();
    embeddedFonts.set(doc, perDoc);
  }
  let font = perDoc.get(face);
  if (!font) {
    font = doc.embedStandardFont(STANDARD_FACES[family][variant]);
    perDoc.set(face, font);
  }
  return font;
}

function pickFamily(style: { fontFamily?: string; monospace?: boolean }): string {
  const name = String(style.fontFamily ?? '').trim().toLowerCase();
  const id = LEGACY_STANDARD_IDS[name] ?? (name.startsWith('std:') ? name : '');
  if (id && STANDARD_FACES[id]) return id;
  // A family the synchronous writer has no face for lands on the sans default,
  // and on the monospace one where the caller asked for a field's fixed-pitch
  // caption. `auto`, `noto`, `script:…` and `local:…` all arrive here when the
  // caller did not embed a face — the caller is responsible for saying so.
  if (style.monospace) return 'std:courier';
  return 'std:helvetica';
}

/** The face the mark writes with: the caller's embedded one, else a named face. */
function textFace(
  doc: PDFDocument,
  spec: AnnotationSpec,
  monospace = false,
): PDFFont {
  return spec.textStyle?.font ?? standardFont(doc, {
    fontFamily: spec.textStyle?.style.fontFamily ?? spec.freeText?.fontFamily,
    bold: spec.textStyle?.style.bold ?? spec.freeText?.bold,
    italic: spec.textStyle?.style.italic ?? spec.freeText?.italic,
    monospace,
  });
}

const LITERAL_FALLBACKS: Record<string, string> = {
  '\u2018': "'", '\u2019': "'", '\u201a': "'",
  '\u201c': '"', '\u201d': '"', '\u201e': '"',
  '\u2013': '-', '\u2014': '-', '\u2212': '-',
  '\u2022': '\u00b7', '\u2026': '...', '\u00a0': ' ',
};

function winAnsiFallback(char: string): string {
  const stripped = char.normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (stripped.length === 1 && isWinAnsiSafe(stripped)) return stripped;
  if (LITERAL_FALLBACKS[char]) return LITERAL_FALLBACKS[char];
  return isWinAnsiSafe(char) ? char : '?';
}

function toWinAnsi(text: string): string {
  return Array.from(String(text ?? ''))
    .map((char) => (isWinAnsiSafe(char) ? char : winAnsiFallback(char)))
    .join('');
}

/**
 * `text` as this face can show it.
 *
 * A standard-14 face throws on a character outside WinAnsi, so the mark folds
 * (accent stripped, then a close lookalike, then `?`). An embedded Unicode face —
 * the bundled Noto, a fetched script face, a device font's bytes — encodes the
 * text it was chosen for, and folding it here is what turned a Japanese text box
 * into a row of question marks.
 */
function textForFace(font: PDFFont, text: string): string {
  try {
    font.encodeText(text);
    return text;
  } catch {
    // The fold below is the per-character version of the same question.
  }
  let out = '';
  for (const char of String(text ?? '')) {
    if (isWinAnsiSafe(char)) out += char;
    else {
      try {
        font.encodeText(char);
        out += char;
      } catch {
        out += winAnsiFallback(char);
      }
    }
  }
  return out;
}

function wrapLines(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of toWinAnsi(text).split(/\r?\n/)) {
    if (paragraph === '') {
      lines.push('');
      continue;
    }
    let current = '';
    for (const piece of paragraph.split(/(\s+)/)) {
      if (piece === '') continue;
      const attempt = current + piece;
      if (font.widthOfTextAtSize(attempt, size) <= maxWidth || current.trim() === '') {
        current = attempt;
      } else {
        lines.push(current.replace(/\s+$/, ''));
        current = piece.replace(/^\s+/, '');
      }
    }
    lines.push(current.replace(/\s+$/, ''));
  }
  return lines;
}

function fitSize(font: PDFFont, text: string, maxWidth: number, maxHeight: number): number {
  let size = Math.max(maxHeight, 1);
  while (size > 1 && font.widthOfTextAtSize(text, size) > maxWidth) {
    size -= Math.max(0.25, size * 0.05);
  }
  return round(Math.max(size, 1));
}

/**
 * FreeText needs `/DA` — the default appearance string a viewer applies when
 * the user edits the text — *and* a baked `/AP`. Both use the same font
 * resource name, and `/DR` publishes that font on the annotation, so the
 * dictionary and the stream can never disagree.
 */
function freeTextStyle(
  doc: PDFDocument,
  spec: AnnotationSpec,
): { font: PDFFont; resourceKey: string; da: string } {
  const style = spec.freeText;
  const font = textFace(doc, spec, spec.kind === 'Widget');
  const size = round(Math.max(spec.textStyle?.style.size ?? style?.fontSize ?? 12, 1));
  const color = spec.textStyle?.style.color ? hexToRgb01(spec.textStyle.style.color, 'textStyle.style.color') : colorOf(spec.color, spec.kind);
  return {
    font,
    resourceKey: FONT_KEY,
    da: `/${FONT_KEY} ${size} Tf ${color.map(round).join(' ')} rg`,
  };
}

function textLayout(
  doc: PDFDocument,
  spec: AnnotationSpec,
  rect: QuadRect,
  textColor: [number, number, number],
  align: 'left' | 'center' | 'right',
  monospace: boolean,
): TextLayout {
  const style = spec.freeText;
  const shared = spec.textStyle?.style;
  const font = textFace(doc, spec, monospace);
  const size = round(Math.max(shared?.size ?? style?.fontSize ?? 12, 1));
  const inset = round(freeTextInset(size));
  const text = style?.text ?? spec.contents ?? '';
  const prepared = spec.textStyle?.lines;
  return {
    font,
    resourceKey: FONT_KEY,
    size,
    // A caller that laid the block out has already decided where the lines break;
    // this module wraps only for the callers that did not.
    lines: prepared
      ? []
      : wrapLines(font, textForFace(font, text), size, Math.max(rect.width - inset * 2, 1)),
    prepared,
    ascent: round(font.heightAtSize(size, { descender: false })),
    // The shared model's line height is a multiple of the size, which is also what
    // the overlay sets in CSS — one number, both places. With no model on the spec
    // the mark keeps the leading the standard faces were measured at.
    lineHeight: shared
      ? round(size * shared.lineSpacing)
      : round(font.heightAtSize(size) + size * FREE_TEXT_INSET_EM),
    inset,
    textColor: shared?.color ? hexToRgb01(shared.color, 'text.style.color') : textColor,
    // `justify` belongs to the block editor, which stretches a line across a
    // measure; a single-run mark falls back to flush-left rather than lying.
    align: shared && shared.align !== 'justify' ? shared.align : align,
  };
}

function freeTextOps(
  doc: PDFDocument,
  spec: AnnotationSpec,
  rect: QuadRect,
  color: [number, number, number],
  fill: [number, number, number] | null,
  stroke: [number, number, number],
  strokeWidth: number,
  ap: Appearance,
): string {
  const layout = textLayout(doc, spec, rect, color, spec.freeText?.align ?? 'left', false);
  ap.fonts = { [layout.resourceKey]: layout.font };
  const background = spec.freeText?.background ? hexToRgb01(spec.freeText.background, 'freeText.background') : fill;
  const showBorder = spec.freeText?.border !== false;
  return textBlockOps(layout, rect, background, stroke, showBorder ? Math.max(strokeWidth, 0.5) : 0);
}

function widgetOps(
  doc: PDFDocument,
  spec: AnnotationSpec,
  rect: QuadRect,
  color: [number, number, number],
  fill: [number, number, number] | null,
  stroke: [number, number, number],
  strokeWidth: number,
  ap: Appearance,
): string {
  // Real field states (/On, /Off, the value appearance) belong to `forms.ts`
  // (§4); a generic widget draws its box and caption like FreeText.
  const layout = textLayout(doc, spec, rect, color, 'left', true);
  ap.fonts = { [layout.resourceKey]: layout.font };
  return textBlockOps(layout, rect, fill ?? [1, 1, 1], stroke, Math.max(strokeWidth, 0.5));
}

function textBlockOps(
  layout: TextLayout,
  rect: QuadRect,
  fill: [number, number, number] | null,
  stroke: [number, number, number],
  strokeWidth: number,
): string {
  const w = round(rect.width);
  const h = round(rect.height);
  const parts: string[] = ['q'];
  if (fill) parts.push(paint(fill, true), rectPath(0, 0, w, h), 'f');
  if (strokeWidth > 0) {
    parts.push(
      paint(stroke, false),
      `${round(strokeWidth)} w`,
      rectPath(strokeWidth / 2, strokeWidth / 2, Math.max(w - strokeWidth, 0.1), Math.max(h - strokeWidth, 0.1)),
      'S',
    );
  }
  const { font, size, inset, ascent, lineHeight } = layout;
  parts.push('BT', `/${layout.resourceKey} ${round(size)} Tf`, paint(layout.textColor, true));
  if (layout.prepared) {
    // Every line is at the place the layout put it: the same coordinates the
    // overlay painted, in the mark's own space.
    for (const line of layout.prepared) {
      if (line.text === '') continue;
      parts.push(
        `1 0 0 1 ${round(line.x)} ${round(line.baseline)} Tm`,
        `${showOperand(font, textForFace(font, line.text))} Tj`,
      );
    }
    parts.push('ET', 'Q');
    return parts.join('\n');
  }
  let baseline = round(h - inset - ascent);
  for (const line of layout.lines) {
    // Stop rather than draw a half line below the box.
    if (baseline - (font.heightAtSize(size) - ascent) < -size) break;
    const textWidth = font.widthOfTextAtSize(line, size);
    const x =
      layout.align === 'center'
        ? round(inset + Math.max(rect.width - inset * 2 - textWidth, 0) / 2)
        : layout.align === 'right'
          ? round(Math.max(rect.width - inset - textWidth, inset))
          : round(inset);
    if (line !== '') parts.push(`${x} ${baseline} Td`, `${showOperand(font, line)} Tj`);
    baseline = round(baseline - lineHeight);
  }
  parts.push('ET', 'Q');
  return parts.join('\n');
}

/* ------------------------------------------------------------------ *
 * Path helpers                                                        *
 * ------------------------------------------------------------------ */

const f = (v: number): string => {
  const r = round(v);
  return Object.is(r, -0) ? '0' : String(r);
};

function rectPath(x: number, y: number, w: number, h: number): string {
  return `${f(x)} ${f(y)} ${f(Math.max(w, 0.01))} ${f(Math.max(h, 0.01))} re`;
}

function polygonPath(points: number[][]): string {
  if (points.length === 0) return '0 0 m';
  const [first, ...rest] = points;
  return [`${f(first[0])} ${f(first[1])} m`, ...rest.map((p) => `${f(p[0])} ${f(p[1])} l`)].join(' ');
}

function openPath(points: number[][]): string {
  if (points.length < 2) {
    const only = points[0] ?? [0, 0];
    return `${f(only[0])} ${f(only[1])} m ${f(only[0] + 0.01)} ${f(only[1])} l`;
  }
  return polygonPath(points);
}

/** Ellipse inscribed in (`x`, `y`, `w`, `h`), built from four bézier arcs. */
function ellipsePath(x: number, y: number, w: number, h: number): string {
  const k = 0.5523;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rx = w / 2;
  const ry = h / 2;
  const at = (px: number, py: number) => `${f(px)} ${f(py)}`;
  return [
    at(cx - rx, cy),
    'm',
    at(cx - rx, cy + ry * k), at(cx - rx * k, cy + ry), at(cx, cy + ry), 'c',
    at(cx + rx * k, cy + ry), at(cx + rx, cy + ry * k), at(cx + rx, cy), 'c',
    at(cx + rx, cy - ry * k), at(cx + rx * k, cy - ry), at(cx, cy - ry), 'c',
    at(cx - rx * k, cy - ry), at(cx - rx, cy - ry * k), at(cx - rx, cy), 'c',
  ].join(' ');
}

/** Zig-zag underline for `Squiggly`, standing off the baseline of a quad. */
function squigglePath(
  line: { x1: number; y1: number; x2: number; y2: number },
  height: number,
  width: number,
): string {
  const dx = line.x2 - line.x1;
  const dy = line.y2 - line.y1;
  const length = Math.hypot(dx, dy) || 1;
  const step = Math.max(width * 2.2, height * 0.4, 2);
  const amplitude = Math.max(height * 0.12, width);
  const ux = dx / length;
  const uy = dy / length;
  const nx = -uy;
  const ny = ux;
  const segments = Math.max(Math.floor(length / step), 2);
  const parts: string[] = [`${f(line.x1)} ${f(line.y1)} m`];
  for (let i = 1; i <= segments; i += 1) {
    const along = (length * i) / segments;
    const side = i % 2 === 0 ? 0 : i % 4 === 1 ? 1 : -1;
    const cx = line.x1 + ux * (along - step / 2) + nx * amplitude;
    const cy = line.y1 + uy * (along - step / 2) + ny * amplitude;
    const ex = line.x1 + ux * along + nx * side * amplitude * 0.4;
    const ey = line.y1 + uy * along + ny * side * amplitude * 0.4;
    parts.push(`${f(cx)} ${f(cy)} ${f(ex)} ${f(ey)} ${f(ex)} ${f(ey)} c`);
  }
  return parts.join(' ');
}

/** Ink/polygon vertices in appearance-local space, falling back to the rect. */
function strokesOf(spec: AnnotationSpec, rect: QuadRect): number[][][] {
  const given = (spec.inkPath ?? [])
    .map((stroke) => stroke.map((p) => [p[0] - rect.x, p[1] - rect.y]))
    .filter(
      (stroke) =>
        stroke.length > 0 &&
        stroke.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])),
    );
  if (given.length > 0) return given;
  return [[[0, 0], [rect.width, 0], [rect.width, rect.height], [0, rect.height]]];
}

function sanitizeName(name: string): string {
  return String(name ?? '').replace(/[^\x21-\x7e]/g, '').replace(/[#%()/<>[\]{}]/g, '') || 'Stamp';
}

/* ------------------------------------------------------------------ *
 * Links and raster stamps                                             *
 * ------------------------------------------------------------------ */

function linkAction(doc: PDFDocument, spec: AnnotationSpec): { dict: ObjDict; dest?: ObjValue[] } | null {
  const link = spec.link;
  if (!link) return null;
  const context = doc.context;
  if (link.type === 'uri') {
    const uri = String(link.uri ?? '').trim();
    if (!uri) throw new Error('Give the link a URL, for example https://example.com, or remove the link.');
    return { dict: { S: 'URI', URI: PDFString.of(uri) } };
  }
  const target = resolvePage(doc, link.page);
  const ref = context.getObjectRef(target.node);
  if (!ref) {
    throw new Error('The link target page is not an indirect object; copy the pages into a new document before linking to it.');
  }
  return { dict: { S: 'GoTo', D: [ref, 'Fit'] }, dest: [ref, 'Fit'] };
}

export interface EmbeddedRaster {
  ref: PDFRef;
  width: number;
  height: number;
}

/**
 * Synchronous, canvas-free image embedding for stamp appearances.
 *
 * JPEG bytes go in as-is under `/DCTDecode`; 8-bit non-interlaced PNG data goes
 * in as `/FlateDecode` with `/DecodeParms << /Predictor 15 >>`, because a PNG
 * `IDAT` stream is exactly the row-filtered layout that predictor describes.
 * Anything needing real pixel decoding (16-bit, interlaced, or an alpha
 * channel, which a PDF image cannot pair with a fourth `/Colors` entry) is
 * rejected with an actionable message — `core/images.ts` is the place to
 * convert it asynchronously.
 */
export function embedRasterImage(doc: PDFDocument, bytes: Uint8Array): EmbeddedRaster {
  const context = doc.context;
  const info = describeRaster(bytes);
  const dict: ObjDict = {
    Type: 'XObject',
    Subtype: 'Image',
    Width: info.width,
    Height: info.height,
    BitsPerComponent: 8,
    ColorSpace: info.colorSpace,
    Filter: info.filter,
  };
  if (info.decodeParms) dict.DecodeParms = info.decodeParms;
  const stream = context.stream(bytes.subarray(info.dataStart, info.dataEnd), dict);
  stream.dict.set(PDFName.of('Length'), PDFNumber.of(stream.contents.length));
  return { ref: context.register(stream), width: info.width, height: info.height };
}

interface RasterInfo {
  width: number;
  height: number;
  colorSpace: 'DeviceGray' | 'DeviceRGB';
  filter: 'DCTDecode' | 'FlateDecode';
  decodeParms?: ObjDict;
  dataStart: number;
  dataEnd: number;
}

function rejectRaster(): never {
  throw new Error(
    'That stamp image is neither a JPEG nor an 8-bit non-interlaced grey, RGB or palette PNG, so it cannot be placed without re-encoding. Save the image as a JPEG (or flatten its alpha channel) and try again.',
  );
}

function describeRaster(bytes: Uint8Array): RasterInfo {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return describeJpeg(bytes);
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return describePng(bytes);
  }
  return rejectRaster();
}

function describeJpeg(bytes: Uint8Array): RasterInfo {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (isStartOfFrame) {
      const precision = bytes[offset + 4];
      const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
      const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
      const components = bytes[offset + 9];
      if (precision !== 8 || (components !== 1 && components !== 3)) rejectRaster();
      return {
        width,
        height,
        colorSpace: components === 1 ? 'DeviceGray' : 'DeviceRGB',
        filter: 'DCTDecode',
        dataStart: 0,
        dataEnd: bytes.length,
      };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9) break;
    offset += 2 + Math.max(length, 2);
  }
  return rejectRaster();
}

function describePng(bytes: Uint8Array): RasterInfo {
  if (bytes.length < 33) rejectRaster();
  const read32 = (at: number) =>
    ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
  let offset = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let interlace = 0;
  let idatChunks = 0;
  let idatStart = -1;
  let idatEnd = -1;
  while (offset + 8 <= bytes.length) {
    const length = read32(offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const dataAt = offset + 8;
    if (type === 'IHDR') {
      width = read32(dataAt);
      height = read32(dataAt + 4);
      depth = bytes[dataAt + 8];
      colorType = bytes[dataAt + 9];
      interlace = bytes[dataAt + 12];
    } else if (type === 'IDAT') {
      if (idatStart < 0) idatStart = dataAt;
      idatEnd = dataAt + length;
      idatChunks += 1;
    } else if (type === 'IEND') {
      break;
    }
    offset = dataAt + length + 4;
  }
  // Only one contiguous IDAT can be pasted without re-deflating the stream.
  if (idatChunks !== 1 || idatStart < 0) rejectRaster();
  if (depth !== 8 || interlace !== 0) rejectRaster();
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : 0;
  if (!channels) rejectRaster();
  return {
    width,
    height,
    colorSpace: channels === 1 ? 'DeviceGray' : 'DeviceRGB',
    filter: 'FlateDecode',
    decodeParms: { Predictor: 15, Colors: channels, BitsPerComponent: 8, Columns: width },
    dataStart: idatStart,
    dataEnd: idatEnd,
  };
}

/**
 * Replace a page's content with one picture of it: how a turned redaction is
 * burned rather than pretended about.
 *
 * The vector text engine deletes glyphs inside an **axis-aligned** box. A
 * redaction turned to an angle that is not a right one covers a parallelogram,
 * so cutting by its bounding box would delete whole words the user never marked
 * — a redaction that takes the wrong text is worse than one that has to wait.
 * Rasterising is the honest answer: the page becomes ink, and nothing under the
 * turn survives as extractable content.
 *
 * `image` is rendered elsewhere (a canvas cannot exist in every caller), and is
 * drawn across the page's own box, honouring the page's `/Rotate` the way the
 * renderer that produced it did. Annotations live in `/Annots`, not in the
 * content stream, so marks written after this call — including the axis-aligned
 * redactions of the same page — survive the burn.
 */
export function rasterisePageToImage(
  doc: PDFDocument,
  page: number,
  image: Uint8Array,
  options: { rotation?: number } = {},
): { width: number; height: number } {
  const target = resolvePage(doc, page);
  const context = doc.context;
  const raster = embedRasterImage(doc, image);
  // Read the page's own `/Rotate` rather than the API's typed accessor, which
  // also admits radians; a burned page must be put back the way it was turned.
  const turned = target.node.Rotate();
  const rotation = normaliseAngle(options.rotation ?? (turned ? turned.asNumber() : 0));
  // The picture holds the page as it is *displayed*, so the box it is drawn
  // into is the turned one: `/MediaBox` stays as it was and the CTM does the
  // rotating, which is also what a viewer does with the content this replaces.
  const { width, height } = target.getSize();
  const swap = rotation === 90 || rotation === 270;
  const boxWidth = swap ? height : width;
  const boxHeight = swap ? width : height;
  const key = target.node.newXObject('Burn', raster.ref);
  const stream = context.flateStream(
    [
      'q',
      rotation === 0 ? null : `${rotationMatrixForImage(rotation, boxWidth, boxHeight).join(' ')} cm`,
      `${round(boxWidth)} 0 0 ${round(boxHeight)} 0 0 cm`,
      `/${key.asString().slice(1)} Do`,
      'Q',
    ]
      .filter((line): line is string => line !== null)
      .join('\n') + '\n',
    {},
  );
  stream.dict.set(PDFName.of('Length'), PDFNumber.of(stream.contents.length));
  target.node.set(PDFName.of('Contents'), context.register(stream));
  return { width, height };
}

/**
 * The matrix that turns a displayed page picture back into user space.
 *
 * A renderer hands back the page as the reader sees it, so at `/Rotate 90` the
 * image's own axes are the page's turned ones; this maps it back so the burned
 * page lines up with the box every viewer still measures in user space.
 */
function rotationMatrixForImage(rotation: number, width: number, height: number): number[] {
  // Rotate clockwise about the page centre, then slide it back into the box.
  const rad = (normaliseAngle(rotation) * Math.PI) / 180;
  const cos = round(Math.cos(rad));
  const sin = round(Math.sin(rad));
  const cx = width / 2;
  const cy = height / 2;
  return [cos, -sin, sin, cos, round(cx - (cos * cx + sin * cy)), round(cy - (-sin * cx + cos * cy))];
}

/* ------------------------------------------------------------------ *
 * Redaction re-export (implementation lives in ./redact.ts)           *
 * ------------------------------------------------------------------ */

export { applyRedactions } from './redact';
export type { RedactOptions, RedactionRect } from './redact';
