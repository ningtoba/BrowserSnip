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
/** A drag smaller than this is treated as a click, not a rectangle. */
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

export function isMeaningfulDrag(rect: CssRect, minPx = MIN_DRAG_PX): boolean {
  return rect.width >= minPx && rect.height >= minPx;
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
