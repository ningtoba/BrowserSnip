/**
 * Coordinate maths for the annotation editor — the only place that knows how
 * screen pixels relate to PDF user space.
 *
 * A page is drawn into a canvas at `zoom` CSS pixels per PDF point, after the
 * page's `/Rotate` has been applied (that is what pdf.js `getViewport` returns).
 * Annotations live in *unrotated* PDF user space because that is what
 * `core/annotations.ts` writes to `/Rect` and what `applyRedactions` cuts with,
 * so every pointer position goes through the rotation-aware pair below:
 *
 *     screen px ──/ zoom──▶ viewport points (top-left origin)
 *                           ──rotation──▶ PDF user space (bottom-left origin)
 *
 * A rect is mapped by its four corners and re-bounded, which is what keeps a
 * drag on a 90°-rotated page from landing sideways or off the page.
 */
import type { QuadRect } from '@/lib/pdf/core/annotations';

export type Rotation = 0 | 90 | 180 | 270;

export interface Point {
  x: number;
  y: number;
}

/** Rectangle in screen space: CSS pixels over the rendered page, top-left origin. */
export interface CssRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Rectangle in viewport space: PDF points, top-left origin, rotation applied. */
export interface ViewportBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PageGeom {
  /** CSS pixels per PDF point (the editor zoom). */
  zoom: number;
  /** Rendered page size in CSS pixels. */
  cssWidth: number;
  cssHeight: number;
  /** Page `/Rotate`, normalised clockwise. */
  rotation: Rotation;
}

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 4;
/** How far the pointer has to move before a press is a drag rather than a click. */
export const MIN_DRAG_PX = 3;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Zoom that fits `pageWidthPt` (PDF points at scale 1) inside a scroll pane. */
export function fitWidthZoom(paneWidthPx: number, pageWidthPt: number, paddingPx = 48): number {
  if (!(pageWidthPt > 0) || !(paneWidthPx > paddingPx)) return 1;
  return clampZoom((paneWidthPx - paddingPx) / pageWidthPt);
}

/**
 * The zoom a freshly-opened document is shown at.
 *
 * `fitWidthZoom` on its own is the wrong first impression twice over: in a pane
 * wider than the page it lands above 100 %, so a portrait page grows until most
 * of it sits below the fold and the reader scrolls to see one line at a time,
 * and in a narrow pane it lands below 100 %, shrinking body text under its real
 * size. A viewer opens a page so the words read, which is the *smaller* of
 * "fit the width" and actual size — never more. A page wider than the pane
 * still fits the pane, and the answer stays inside the range the ＋／− buttons
 * can reach, so the number in the toolbar is always one the user can get back to.
 */
export function readingZoom(paneWidthPx: number, pageWidthPt: number, paddingPx = 48): number {
  return clampZoom(Math.min(fitWidthZoom(paneWidthPx, pageWidthPt, paddingPx), 1));
}

/** A box in CSS pixels, as `getBoundingClientRect` reports it. */
export interface ClientBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The middle of the part of the page the user can actually see, in page-local
 * CSS pixels — the space a pointer position lives in.
 *
 * For a mark that has to land with no pointer to follow, e.g. a picture that
 * arrives after a file dialog. The centre of the *page* is often scrolled away,
 * and a mark the user cannot see reads as a click that did nothing; the middle
 * of what is on screen is always visible. A page fully outside the pane is
 * clamped onto the page rather than placed off its edge.
 */
export function visiblePageCentre(page: ClientBox, pane: ClientBox): Point {
  const overlap = (lo: number, hi: number, from: number, to: number): [number, number] => [
    Math.min(Math.max(lo, from), hi),
    Math.max(Math.min(hi, to), lo),
  ];
  const [left, right] = overlap(page.left, page.left + page.width, pane.left, pane.left + pane.width);
  const [top, bottom] = overlap(page.top, page.top + page.height, pane.top, pane.top + pane.height);
  return {
    x: (left + right) / 2 - page.left,
    y: (top + bottom) / 2 - page.top,
  };
}

/** Page size as drawn, in PDF points (rotation applied). */
function viewportSize(geom: PageGeom): { width: number; height: number } {
  return { width: geom.cssWidth / geom.zoom, height: geom.cssHeight / geom.zoom };
}

/** Page size before `/Rotate`, in PDF points — the extent of PDF user space. */
export function pageSize(geom: PageGeom): { width: number; height: number } {
  const view = viewportSize(geom);
  return geom.rotation === 90 || geom.rotation === 270
    ? { width: view.height, height: view.width }
    : { width: view.width, height: view.height };
}

function screenToViewportPoint(point: Point, geom: PageGeom): Point {
  return { x: point.x / geom.zoom, y: point.y / geom.zoom };
}

function viewportToScreenPoint(point: Point, geom: PageGeom): Point {
  return { x: point.x * geom.zoom, y: point.y * geom.zoom };
}

/** Viewport top-left point → PDF user space point (bottom-left origin). */
function viewportToPdfPoint(point: Point, geom: PageGeom): Point {
  const { width, height } = pageSize(geom);
  switch (geom.rotation) {
    case 90:
      return { x: point.y, y: point.x };
    case 180:
      return { x: width - point.x, y: point.y };
    case 270:
      return { x: width - point.y, y: height - point.x };
    default:
      return { x: point.x, y: height - point.y };
  }
}

/** PDF user space point → viewport top-left point. */
function pdfToViewportPoint(point: Point, geom: PageGeom): Point {
  const { width, height } = pageSize(geom);
  switch (geom.rotation) {
    case 90:
      return { x: point.y, y: point.x };
    case 180:
      return { x: width - point.x, y: point.y };
    case 270:
      return { x: height - point.y, y: width - point.x };
    default:
      return { x: point.x, y: height - point.y };
  }
}

export function screenToPdfPoint(point: Point, geom: PageGeom): Point {
  return viewportToPdfPoint(screenToViewportPoint(point, geom), geom);
}

export function pdfToScreenPoint(point: Point, geom: PageGeom): Point {
  return viewportToScreenPoint(pdfToViewportPoint(point, geom), geom);
}

export function screenToViewportBox(rect: CssRect, geom: PageGeom): ViewportBox {
  const x0 = rect.x / geom.zoom;
  const y0 = rect.y / geom.zoom;
  return {
    x0,
    y0,
    x1: (rect.x + rect.width) / geom.zoom,
    y1: (rect.y + rect.height) / geom.zoom,
  };
}

/** Screen rect → PDF user space rect (axis-aligned bounds of the four corners). */
export function screenToPdfRect(rect: CssRect, geom: PageGeom): QuadRect {
  const box = screenToViewportBox(rect, geom);
  return pdfRectFromCorners(
    [
      viewportToPdfPoint({ x: box.x0, y: box.y0 }, geom),
      viewportToPdfPoint({ x: box.x1, y: box.y0 }, geom),
      viewportToPdfPoint({ x: box.x1, y: box.y1 }, geom),
      viewportToPdfPoint({ x: box.x0, y: box.y1 }, geom),
    ],
  );
}

/** PDF user space rect → screen rect (axis-aligned bounds of the four corners). */
export function pdfToScreenRect(rect: QuadRect, geom: PageGeom): CssRect {
  const corners = pdfRectToScreenCorners(rect, geom);
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function pdfRectToScreenCorners(rect: QuadRect, geom: PageGeom): Point[] {
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ].map((p) => pdfToScreenPoint(p, geom));
}

function pdfRectFromCorners(corners: Point[]): QuadRect {
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/**
 * A text-line box in viewport space (top-left origin) → 8 PDF quad numbers in
 * the order PDF 32000-1 Table 171 wants: upper-left, upper-right, lower-left,
 * lower-right. Mapping the corners individually (instead of assuming a flat
 * page) is what makes a highlight land correctly on a rotated page.
 */
export function pdfQuadFromViewportBox(box: ViewportBox, geom: PageGeom): number[] {
  const ul = viewportToPdfPoint({ x: box.x0, y: box.y0 }, geom);
  const ur = viewportToPdfPoint({ x: box.x1, y: box.y0 }, geom);
  const ll = viewportToPdfPoint({ x: box.x0, y: box.y1 }, geom);
  const lr = viewportToPdfPoint({ x: box.x1, y: box.y1 }, geom);
  return [ul.x, ul.y, ur.x, ur.y, ll.x, ll.y, lr.x, lr.y];
}

export function pdfRectFromViewportBox(box: ViewportBox, geom: PageGeom): QuadRect {
  return pdfRectFromCorners(quadsToPoints(pdfQuadFromViewportBox(box, geom)));
}

/** Two screen points → the axis-aligned drag rectangle they describe. */
export function normaliseDrag(from: Point, to: Point): CssRect {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  };
}

/**
 * Did this gesture describe a box? Both axes must have size, because a rectangle
 * with one flat side is not a shape — see `isClickGesture` for the other question,
 * which is not the same one.
 */
export function isMeaningfulDrag(rect: CssRect, minPx = MIN_DRAG_PX): boolean {
  return rect.width >= minPx && rect.height >= minPx;
}

/**
 * Was this gesture a click — the pointer pressed, sat still, and released?
 *
 * Travel, not area: a drag straight along a line of text covers 140 px of page
 * and has zero height, which is the most natural markup gesture there is, and it
 * is not a click. Asking for size on both axes instead called it one, so a second
 * highlight over words already marked was read as a finger pointing at the first
 * one: the mark was selected, the tool stayed armed, and the page gained nothing.
 */
export function isClickGesture(rect: CssRect, minPx = MIN_DRAG_PX): boolean {
  return rect.width < minPx && rect.height < minPx;
}

/** A box of `width` × `height` points centred on a PDF-space point. */
export function centeredRect(centre: Point, width: number, height: number): QuadRect {
  return { x: centre.x - width / 2, y: centre.y - height / 2, width, height };
}

/** Fit a raster's aspect ratio inside `box`, centred (contain). */
export function fitRectInBox(natural: { width: number; height: number }, box: QuadRect): QuadRect {
  const nw = natural.width > 0 ? natural.width : 1;
  const nh = natural.height > 0 ? natural.height : 1;
  const scale = Math.min(box.width / nw, box.height / nh);
  const width = nw * scale;
  const height = nh * scale;
  return {
    x: box.x + (box.width - width) / 2,
    y: box.y + (box.height - height) / 2,
    width,
    height,
  };
}

export function translateRect(rect: QuadRect, dx: number, dy: number): QuadRect {
  return { ...rect, x: rect.x + dx, y: rect.y + dy };
}

export function translateQuads(quads: number[], dx: number, dy: number): number[] {
  return quads.map((value, index) => (index % 2 === 0 ? value + dx : value + dy));
}

export function translateStrokes(strokes: number[][][], dx: number, dy: number): number[][][] {
  return strokes.map((stroke) => stroke.map(([x, y]) => [x + dx, y + dy]));
}

export function translateLineEnds(
  ends: [number, number, number, number],
  dx: number,
  dy: number,
): [number, number, number, number] {
  return [ends[0] + dx, ends[1] + dy, ends[2] + dx, ends[3] + dy];
}

/** Axis-aligned bounds of PDF-space points, grown by `pad` on every side. */
export function boundsOfPoints(points: Point[], pad = 0): QuadRect {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x0 = Math.min(...xs) - pad;
  const y0 = Math.min(...ys) - pad;
  return {
    x: x0,
    y: y0,
    width: Math.max(...xs) - x0 + pad,
    height: Math.max(...ys) - y0 + pad,
  };
}

/**
 * Keep a PDF-space rect inside the page it belongs to, so a click near the edge
 * cannot place a mark that no viewer will show.
 */
export function clampRectToPage(rect: QuadRect, geom: PageGeom): QuadRect {
  const page = pageSize(geom);
  const width = Math.min(rect.width, page.width);
  const height = Math.min(rect.height, page.height);
  const x = Math.min(Math.max(rect.x, 0), Math.max(page.width - width, 0));
  const y = Math.min(Math.max(rect.y, 0), Math.max(page.height - height, 0));
  return { x, y, width, height };
}

/** `[x, y, …]` flat pairs → `[{x, y}, …]`. */
export function quadsToPoints(quads: number[]): Point[] {
  const points: Point[] = [];
  for (let i = 0; i + 1 < quads.length; i += 2) points.push({ x: quads[i], y: quads[i + 1] });
  return points;
}

export function pointsToPairList(points: Point[]): number[][] {
  return points.map((p) => [p.x, p.y]);
}

/* ------------------------------------------------------------------ *
 * A mark's own rotation                                               *
 * ------------------------------------------------------------------ */

/**
 * A mark is stored *unrotated* — `rect`, `/QuadPoints`, ink and line ends all
 * describe the shape as it was drawn — and turned about the centre of its rect
 * by `EditorAnnotation.rotation`. That is what lets nudge, resize and snap keep
 * working unchanged while the overlay and the export both apply the same turn.
 *
 * Degrees are **clockwise as the page is read**, which is the direction PDF's
 * own `/Rotate` entry means; user space has +y up, so the maths is the negative
 * of the textbook counter-clockwise rotation.
 */
export const ROTATE_SNAP_DEG = 15;

/** Degrees into `[0, 360)`. A non-number is 0, i.e. straight. */
export function normaliseAngle(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0;
  return ((degrees % 360) + 360) % 360;
}

/** Straight when unset, so every existing annotation stays a plain `false`. */
export function isRotated(degrees: number | undefined): boolean {
  return normaliseAngle(degrees ?? 0) !== 0;
}

/** Turn an angle to the nearest multiple of `step`, keeping it inside `[0, 360)`. */
export function snapAngle(degrees: number, step = ROTATE_SNAP_DEG): number {
  if (!Number.isFinite(degrees)) return 0;
  const size = step > 0 ? step : 1;
  return normaliseAngle(Math.round(degrees / size) * size);
}

/** The centre of a rect — the pivot every rotated mark turns about. */
export function rectCentre(rect: QuadRect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** Rotate one PDF-space point clockwise about `centre`. */
export function rotatePointAbout(point: Point, centre: Point, degrees: number): Point {
  const angle = normaliseAngle(degrees);
  if (angle === 0) return { x: point.x, y: point.y };
  const rad = (angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = point.x - centre.x;
  const dy = point.y - centre.y;
  return { x: centre.x + dx * cos + dy * sin, y: centre.y - dx * sin + dy * cos };
}

/** The four corners of a rect, in PDF space, lower-left first, counter-clockwise. */
export function rectCorners(rect: QuadRect): Point[] {
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
 * This is what the exported `/Rect` always holds, never the pre-rotation box:
 * a viewer that ignores our appearance stream, and anything that clips, prints
 * or hit-tests by `/Rect`, then cannot crop a rotated mark.
 */
export function rotatedBounds(rect: QuadRect, degrees: number): QuadRect {
  return rotatedBoundsAbout(rect, rectCentre(rect), degrees);
}

/**
 * The axis-aligned box that contains `rect` turned about any pivot.
 *
 * A mark turns about its own centre; a *query* region is turned about that same
 * centre to be read in the mark's frame, which is why the pivot is a parameter.
 */
export function rotatedBoundsAbout(rect: QuadRect, pivot: Point, degrees: number): QuadRect {
  const angle = normaliseAngle(degrees);
  if (angle === 0) return { ...rect };
  return boundsOfPoints(rectCorners(rect).map((corner) => rotatePointAbout(corner, pivot, angle)));
}

/** A flat quad list (8 numbers per quad) turned about the centre of `rect`. */
export function rotateQuads(quads: number[], rect: QuadRect, degrees: number): number[] {
  const angle = normaliseAngle(degrees);
  if (angle === 0) return quads.slice();
  const centre = rectCentre(rect);
  const out: number[] = [];
  for (let i = 0; i + 1 < quads.length; i += 2) {
    const point = rotatePointAbout({ x: quads[i], y: quads[i + 1] }, centre, angle);
    out.push(point.x, point.y);
  }
  return out;
}

/** Ink strokes turned about the centre of `rect`. */
export function rotateStrokes(strokes: number[][][], rect: QuadRect, degrees: number): number[][][] {
  const angle = normaliseAngle(degrees);
  const centre = rectCentre(rect);
  return strokes.map((stroke) =>
    stroke.map(([x, y]) => {
      if (angle === 0) return [x, y];
      const point = rotatePointAbout({ x, y }, centre, angle);
      return [point.x, point.y];
    }),
  );
}

/** Line endpoints turned about the centre of `rect`. */
export function rotateLineEnds(
  ends: [number, number, number, number],
  rect: QuadRect,
  degrees: number,
): [number, number, number, number] {
  const angle = normaliseAngle(degrees);
  if (angle === 0) return [ends[0], ends[1], ends[2], ends[3]];
  const centre = rectCentre(rect);
  const from = rotatePointAbout({ x: ends[0], y: ends[1] }, centre, angle);
  const to = rotatePointAbout({ x: ends[2], y: ends[3] }, centre, angle);
  return [from.x, from.y, to.x, to.y];
}

/**
 * Bring a PDF-space delta back into the mark's own frame.
 *
 * A pointer or arrow-key delta lives in page space; a rotated mark's edges do
 * not, so resizing pulls along the rotated axes by un-turning the delta first.
 */
export function unrotateDelta(dx: number, dy: number, degrees: number): Point {
  return rotatePointAbout({ x: dx, y: dy }, { x: 0, y: 0 }, -normaliseAngle(degrees));
}

/**
 * Where a rotated mark lands on screen: the pivot in CSS pixels and the angle
 * to hand an SVG or CSS `rotate()`.
 *
 * The angle is measured from the mapped page axes rather than assumed, because
 * the page's own `/Rotate` and the y-flip together decide which way a PDF-clock
 * turn draws. Deriving it keeps the overlay honest on a turned page instead of
 * rotating marks the wrong way there.
 */
export function markScreenRotation(
  rect: QuadRect,
  degrees: number,
  geom: PageGeom,
): { centre: Point; degrees: number } {
  const pivot = rectCentre(rect);
  const centre = pdfToScreenPoint(pivot, geom);
  const angle = normaliseAngle(degrees);
  if (angle === 0) return { centre, degrees: 0 };
  const edge = pdfToScreenPoint(rotatePointAbout({ x: pivot.x + 1, y: pivot.y }, pivot, angle), geom);
  return { centre, degrees: (Math.atan2(edge.y - centre.y, edge.x - centre.x) * 180) / Math.PI };
}

/** The four corners of a rotated mark, in screen pixels — where handles live. */
export function rotatedScreenCorners(
  rect: QuadRect,
  degrees: number,
  geom: PageGeom,
): Point[] {
  const angle = normaliseAngle(degrees);
  const pivot = rectCentre(rect);
  return rectCorners(rect).map((corner) =>
    pdfToScreenPoint(angle === 0 ? corner : rotatePointAbout(corner, pivot, angle), geom),
  );
}

/**
 * Express a page-space box in one mark's own, unrotated frame.
 *
 * Hit tests and marquee selection run against stored (unrotated) geometry, so
 * the query region is turned back about the mark's centre and re-bounded.
 * Doing that instead of testing the axis-aligned box is what stops a marquee
 * from taking a rotated mark it only clips the corner of.
 */
export function boxToMarkFrame(box: QuadRect, rect: QuadRect, degrees: number): QuadRect {
  return rotatedBoundsAbout(box, rectCentre(rect), -normaliseAngle(degrees));
}

/**
 * The clockwise angle of `point` seen from `centre`, in screen degrees.
 *
 * Screen space has +y down, so a rising angle is a turn to the right — the same
 * direction a rotate handle travels, and the reason the drag can be read here
 * without a sign flip.
 */
export function screenAngle(centre: Point, point: Point): number {
  return normaliseAngle((Math.atan2(point.y - centre.y, point.x - centre.x) * 180) / Math.PI);
}

/**
 * The angle a rotate drag asks for.
 *
 * Snapped to 15° because the angles people reach for are square and tidy; `free`
 * (Shift held) is the escape hatch for the mark that has to sit at 12° to line up
 * with a scanned page.
 */
export function rotationForDrag(degrees: number, free = false): number {
  return free ? normaliseAngle(degrees) : snapAngle(degrees);
}
