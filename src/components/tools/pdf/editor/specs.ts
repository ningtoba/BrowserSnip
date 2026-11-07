/**
 * Turning editor gestures into `AnnotationSpec`s.
 *
 * `buildAnnotation` is the single place a pointer gesture becomes an
 * annotation, and `annotationToSpec` is the single place an annotation becomes
 * the object `addAnnotations` consumes. Keeping them pure means the geometry
 * rules (snap-to-line, padded bounds for stroked paths, aspect-preserving image
 * placement, redaction pairing) are testable without a canvas, and the
 * component only has to collect gestures.
 */
import type { AnnotationKind, AnnotationSpec, QuadRect } from '@/lib/pdf/core/annotations';
import {
  boundsOfPoints,
  boxToMarkFrame,
  centeredRect,
  clampRectToPage,
  fitRectInBox,
  isMeaningfulDrag,
  normaliseAngle,
  normaliseDrag,
  pdfQuadFromViewportBox,
  pdfRectFromViewportBox,
  pdfToScreenPoint,
  pointsToPairList,
  quadsToPoints,
  rectCentre,
  rectCorners,
  rotatePointAbout,
  rotatedBounds,
  screenToPdfPoint,
  screenToPdfRect,
  translateLineEnds,
  translateQuads,
  translateRect,
  translateStrokes,
  type CssRect,
  type PageGeom,
  type Point,
} from './geometry';
import { joinSnappedText, type SnappedLine } from './quads';
import { TOOL_BY_ID } from './tools';
import type { EditorAnnotation, EditorToolId, PlacedRaster, ToolStyle } from './types';

/** Fallback sizes, in PDF points, for a tool used as a single click. */
const DEFAULT_BOX: Partial<Record<EditorToolId, { width: number; height: number }>> = {
  note: { width: 26, height: 26 },
  freetext: { width: 240, height: 56 },
  square: { width: 180, height: 120 },
  circle: { width: 150, height: 150 },
  stamp: { width: 140, height: 44 },
  image: { width: 240, height: 180 },
  signature: { width: 200, height: 70 },
  link: { width: 160, height: 22 },
  redact: { width: 200, height: 16 },
};

let sequence = 0;

/** Monotonic, collision-free ids (also used as React keys). */
export function nextAnnotationId(): string {
  sequence += 1;
  return `a${Date.now().toString(36)}${sequence.toString(36)}`;
}

export interface BuildInput {
  tool: EditorToolId;
  /** 0-based page index. */
  page: number;
  style: ToolStyle;
  geom: PageGeom;
  /** Drag rectangle in screen pixels (box / place / markup tools). */
  drag?: CssRect;
  /** Freehand or vertex path in screen pixels (path / segment / vertices). */
  points?: Point[];
  /** Text lines the band crossed (markup tools). */
  lines?: SnappedLine[];
  text?: string;
  raster?: PlacedRaster;
  link?: EditorAnnotation['link'];
  id?: string;
  createdAt?: number;
}

const round = (value: number): number => Math.round(value * 100) / 100;

/**
 * Build the annotation a gesture describes, or `null` when the gesture is not
 * enough (a stroke with one point, a highlight that crossed no text, an image
 * tool with no image chosen yet). The caller turns `null` into a hint.
 */
export function buildAnnotation(input: BuildInput): EditorAnnotation | null {
  const meta = TOOL_BY_ID[input.tool];
  const base: EditorAnnotation = {
    id: input.id ?? nextAnnotationId(),
    tool: input.tool,
    kind: meta.kind,
    page: input.page,
    rect: { x: 0, y: 0, width: 0, height: 0 },
    color: input.style.color,
    borderWidth: input.style.strokeWidth,
    opacity: clampUnit(input.style.opacity),
    createdAt: input.createdAt ?? Date.now(),
  };

  switch (meta.gesture) {
    case 'markup':
      return buildMarkup(base, input);
    case 'box':
      return buildBox(base, input);
    case 'segment':
      return buildSegment(base, input);
    case 'path':
      return buildPath(base, input, 'Ink');
    case 'vertices':
      return buildPath(base, input, meta.kind);
    case 'place':
      return buildPlaced(base, input);
    case 'none':
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ *
 * Gesture builders                                                    *
 * ------------------------------------------------------------------ */

/** Highlight / Underline / StrikeOut — one quad per snapped text line. */
function buildMarkup(base: EditorAnnotation, input: BuildInput): EditorAnnotation | null {
  const lines = input.lines ?? [];
  if (lines.length === 0) return null;
  const quads = lines.map((line) => pdfQuadFromViewportBox(line, input.geom).map(round));
  const rects = lines.map((line) => pdfRectFromViewportBox(line, input.geom));
  const text = joinSnappedText(lines);
  return {
    ...base,
    rect: roundRect(mergeRects(rects) ?? rects[0]),
    quadPoints: quads.flat(),
    // The mark must not be thinner than the glyphs it covers.
    borderWidth: Math.max(input.style.strokeWidth, 0.6),
    ...(text ? { snapText: text } : {}),
  };
}

/** Rectangle-ish tools: shapes, redaction, link, note, text box. */
function buildBox(base: EditorAnnotation, input: BuildInput): EditorAnnotation | null {
  const rect = rectFromDrag(input);
  if (!rect) return null;
  const style = input.style;
  const fill = style.filled ? style.fillColor : undefined;

  switch (base.kind) {
    case 'Text':
      return {
        ...base,
        rect: roundRect(rect),
        color: style.color,
        contents: input.text ?? '',
        fillColor: style.color,
      };
    case 'FreeText':
      return {
        ...base,
        rect: roundRect(rect),
        color: style.color,
        borderColor: style.strokeWidth > 0 ? style.color : undefined,
        ...(fill ? { fillColor: fill } : {}),
        text: input.text ?? '',
        fontSize: style.fontSize,
      };
    case 'Square':
    case 'Circle':
      return {
        ...base,
        rect: roundRect(rect),
        color: style.color,
        borderColor: style.color,
        ...(fill ? { fillColor: fill } : {}),
      };
    case 'Redact':
      return {
        ...base,
        rect: roundRect(rect),
        color: style.color,
        fillColor: style.color,
        // Redaction boxes are burned in; the pen opacity would only mislead.
        opacity: 1,
        borderWidth: 0,
      };
    case 'Link':
      if (!input.link) return null;
      return { ...base, rect: roundRect(rect), link: input.link };
    default:
      return { ...base, rect: roundRect(rect) };
  }
}

/** Line / Arrow — endpoints plus a rect that contains the whole drawing. */
function buildSegment(base: EditorAnnotation, input: BuildInput): EditorAnnotation | null {
  const from = input.points?.[0];
  const to = input.points?.[input.points.length - 1];
  if (!from || !to) return null;
  if (Math.hypot(to.x - from.x, to.y - from.y) < 2) return null;
  const start = screenToPdfPoint(from, input.geom);
  const end = screenToPdfPoint(to, input.geom);
  const arrow = base.kind === 'Arrow';
  // Arrow heads are drawn inside the appearance box, so leave them room.
  const pad = Math.max(input.style.strokeWidth, 1) / 2 + (arrow ? 8 : 2);
  const rect = boundsOfPoints([start, end], pad);
  return {
    ...base,
    rect: roundRect(rect),
    lineEnds: [round(start.x), round(start.y), round(end.x), round(end.y)],
    lineArrow: arrow ? 'end' : 'none',
    color: input.style.color,
    borderColor: input.style.color,
  };
}

/** Ink (freehand) and Polygon / PolyLine (clicked vertices). */
function buildPath(
  base: EditorAnnotation,
  input: BuildInput,
  kind: AnnotationKind,
): EditorAnnotation | null {
  const raw = input.points ?? [];
  const minimum = kind === 'Polygon' ? 3 : 2;
  if (raw.length < minimum) return null;
  const points = raw.map((p) => screenToPdfPoint(p, input.geom));
  const pad = Math.max(input.style.strokeWidth, 1) / 2 + (kind === 'Ink' ? 1 : 2);
  return {
    ...base,
    kind,
    rect: roundRect(boundsOfPoints(points, pad)),
    inkPath: [pointsToPairList(points).map(([x, y]) => [round(x), round(y)])],
    color: input.style.color,
    borderColor: input.style.color,
    ...(input.style.filled && (kind === 'Polygon' || kind === 'PolyLine')
      ? { fillColor: input.style.fillColor }
      : {}),
  };
}

/** Stamp / Image / Signature — a raster, or a built-in stamp label. */
function buildPlaced(base: EditorAnnotation, input: BuildInput): EditorAnnotation | null {
  const raster = input.raster;
  if (input.tool !== 'stamp' && !raster) return null;
  const wanted = rectFromDrag(input);
  if (!wanted) return null;
  const rect = raster ? fitRectInBox({ width: raster.width, height: raster.height }, wanted) : wanted;
  return {
    ...base,
    rect: roundRect(rect),
    color: input.style.color,
    ...(raster
      ? {
          imageBytes: raster.bytes,
          imageUrl: raster.url,
          imageWidth: raster.width,
          imageHeight: raster.height,
        }
      : { stampName: input.style.stampName || 'Approved' }),
  };
}

/* ------------------------------------------------------------------ *
 * Editing helpers                                                     *
 * ------------------------------------------------------------------ */

/** Move one annotation by a PDF-space delta, carrying every point list. */
export function moveAnnotation(
  annotation: EditorAnnotation,
  dx: number,
  dy: number,
): EditorAnnotation {
  if (dx === 0 && dy === 0) return annotation;
  return {
    ...annotation,
    rect: translateRect(annotation.rect, dx, dy),
    ...(annotation.quadPoints ? { quadPoints: translateQuads(annotation.quadPoints, dx, dy) } : {}),
    ...(annotation.inkPath ? { inkPath: translateStrokes(annotation.inkPath, dx, dy) } : {}),
    ...(annotation.lineEnds ? { lineEnds: translateLineEnds(annotation.lineEnds, dx, dy) } : {}),
  };
}

/** Replace the text of a FreeText / sticky note without touching geometry. */
export function withText(
  annotation: EditorAnnotation,
  text: string,
): EditorAnnotation {
  return annotation.kind === 'Text'
    ? { ...annotation, contents: text }
    : { ...annotation, text };
}

/* ------------------------------------------------------------------ *
 * Rotation                                                            *
 * ------------------------------------------------------------------ *
 *
 * A mark carries its own angle and nothing else changes: the geometry stays
 * unrotated, so nudge, resize, snapping and the text quads keep working, and
 * every consumer applies the same turn about the centre of `rect`.
 */

/** The angle a mark holds, normalised — an unset mark is straight (0°). */
export function annotationRotation(annotation: Pick<EditorAnnotation, 'rotation'>): number {
  return normaliseAngle(annotation.rotation ?? 0);
}

/** Set the angle absolutely, about the mark's own centre. */
export function setAnnotationRotation(
  annotation: EditorAnnotation,
  degrees: number,
): EditorAnnotation {
  const angle = normaliseAngle(degrees);
  if (angle === annotationRotation(annotation)) return annotation;
  return { ...annotation, rotation: angle };
}

/** Add `delta` degrees, about the mark's own centre. */
export function turnAnnotation(annotation: EditorAnnotation, delta: number): EditorAnnotation {
  if (!Number.isFinite(delta) || normaliseAngle(delta) === 0) return annotation;
  return setAnnotationRotation(annotation, annotationRotation(annotation) + delta);
}

/**
 * Turn a mark by `delta` about a point that is not its own centre.
 *
 * This is what a rotate handle on a *group* does: the set swings around the
 * middle of the selection, so every mark moves along the arc and takes the same
 * new angle. Pivoting on the mark's own centre collapses to a pure spin, which
 * is why one function serves both cases.
 */
export function orbitAnnotation(
  annotation: EditorAnnotation,
  pivot: Point,
  delta: number,
): EditorAnnotation {
  const turned = turnAnnotation(annotation, delta);
  const centre = rectCentre(annotation.rect);
  const moved = rotatePointAbout(centre, pivot, delta);
  return moveAnnotation(turned, moved.x - centre.x, moved.y - centre.y);
}

/** The box a mark really occupies on the page: `rect`, turned. */
export function markBounds(annotation: EditorAnnotation): QuadRect {
  return rotatedBounds(annotation.rect, annotationRotation(annotation));
}

/**
 * Whether a mark can carry an angle at all.
 *
 * A link is a clickable rectangle: its dictionary offers nothing but `/Rect`, so a
 * turned link would draw an outline no viewer honours while the click area stayed
 * the axis-aligned box — a difference between the picture and the behaviour. Every
 * other kind paints something the appearance stream can turn, so it can be asked.
 */
export function canRotate(annotation: Pick<EditorAnnotation, 'kind'>): boolean {
  return annotation.kind !== 'Link';
}

/* ------------------------------------------------------------------ *
 * The selection set                                                   *
 * ------------------------------------------------------------------ *
 *
 * Every command the editor offers on a selection runs over these functions, so
 * "one drag is one undo step" and "a style change hits the set" are properties
 * of the model rather than of a click handler.
 */

/** The marks a selection names, in the order the list holds them. */
export function selectedMarks(
  annotations: readonly EditorAnnotation[],
  selection: readonly string[],
): EditorAnnotation[] {
  return annotations.filter((a) => selection.includes(a.id));
}

/** Every mark drawn on one page, in creation order — what Cmd/Ctrl+A selects. */
export function marksOnPage(
  annotations: readonly EditorAnnotation[],
  page: number,
): EditorAnnotation[] {
  return annotations.filter((a) => a.page === page);
}

/** Ids of every mark on `page`; the page boundary is the selection boundary. */
export function pageSelection(
  annotations: readonly EditorAnnotation[],
  page: number,
): string[] {
  return marksOnPage(annotations, page).map((a) => a.id);
}

/** A list with `ids` moved by one delta — one array, so one undo step. */
export function moveMarks(
  annotations: readonly EditorAnnotation[],
  ids: readonly string[],
  dx: number,
  dy: number,
): EditorAnnotation[] {
  if (dx === 0 && dy === 0) return annotations.slice();
  return annotations.map((a) => (ids.includes(a.id) ? moveAnnotation(a, dx, dy) : a));
}

/** A list with `ids` turned about the centre of the selection. */
export function turnMarks(
  annotations: readonly EditorAnnotation[],
  ids: readonly string[],
  delta: number,
  pivot?: Point,
): EditorAnnotation[] {
  const centre = pivot ?? selectionBounds(annotations, ids) ?? null;
  return annotations.map((a) => {
    if (!ids.includes(a.id)) return a;
    return centre ? orbitAnnotation(a, centre, delta) : turnAnnotation(a, delta);
  });
}

/** A list with every mark in `ids` set to the same angle, each about its centre. */
export function setMarksRotation(
  annotations: readonly EditorAnnotation[],
  ids: readonly string[],
  degrees: number,
): EditorAnnotation[] {
  const angle = normaliseAngle(degrees);
  return annotations.map((a) => (ids.includes(a.id) ? setAnnotationRotation(a, angle) : a));
}

/** A list without the marks `ids` names. */
export function removeMarks(
  annotations: readonly EditorAnnotation[],
  ids: readonly string[],
): EditorAnnotation[] {
  return annotations.filter((a) => !ids.includes(a.id));
}

/**
 * The four properties the inspector offers to a group.
 *
 * Deliberately narrow: text, link target and stamp face belong to one object,
 * so a group summary never pretends to edit them.
 */
export interface SharedStyle {
  color?: string;
  opacity?: number;
  strokeWidth?: number;
  fontSize?: number;
}

/**
 * Apply a shared property to every selected mark.
 *
 * A colour rewrites whichever colour fields the mark actually carries, because
 * a note paints its body from `color` while a rectangle strokes it — leaving
 * `fillColor` alone would change one shape and not the other. Opacity is the one
 * property a redaction refuses: it is burned in, so a translucent burn would
 * promise a page that still shows the words.
 */
export function styleMarks(
  annotations: readonly EditorAnnotation[],
  ids: readonly string[],
  style: SharedStyle,
): EditorAnnotation[] {
  return annotations.map((annotation) => {
    if (!ids.includes(annotation.id)) return annotation;
    const next: EditorAnnotation = { ...annotation };
    if (style.color !== undefined) {
      const previous = annotation.color;
      next.color = style.color;
      if (annotation.borderColor === previous || annotation.borderColor !== undefined) {
        next.borderColor = style.color;
      }
      if (annotation.fillColor === previous) next.fillColor = style.color;
    }
    if (style.opacity !== undefined && annotation.kind !== 'Redact') {
      next.opacity = style.opacity;
    }
    if (style.strokeWidth !== undefined) {
      // Markup must stay at least as thick as the glyphs it covers.
      next.borderWidth =
        annotation.quadPoints && annotation.kind !== 'Underline' && annotation.kind !== 'StrikeOut'
          ? Math.max(style.strokeWidth, 0.6)
          : style.strokeWidth;
    }
    if (style.fontSize !== undefined && annotation.fontSize !== undefined) {
      next.fontSize = style.fontSize;
    }
    return next;
  });
}

/** Copies of `ids`, offset so both sets are visible, as one edit. */
export function duplicateMarks(
  annotations: readonly EditorAnnotation[],
  ids: readonly string[],
  offset: { dx?: number; dy?: number } = {},
): { marks: EditorAnnotation[]; ids: string[] } {
  const copies = selectedMarks(annotations, ids).map((a) => duplicateAnnotation(a, offset));
  return { marks: copies, ids: copies.map((a) => a.id) };
}

/** The box that contains a whole selection, or `null` when nothing is picked. */
export function selectionBounds(
  annotations: readonly EditorAnnotation[],
  ids: readonly string[],
): QuadRect | null {
  const marks = selectedMarks(annotations, ids);
  if (marks.length === 0) return null;
  return boundsOfPoints(
    marks.flatMap((mark) => rectCornersOf(markBounds(mark))),
  );
}

function rectCornersOf(rect: QuadRect): Point[] {
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
}

/**
 * What a group is, said honestly.
 *
 * Two selected marks are not one mark with two of everything: the inspector
 * shows the count, the kinds, the pages, and only the properties the whole set
 * already agrees on. `mixed` names what it will not pretend to show.
 */
export interface SelectionSummary {
  count: number;
  pages: number[];
  /** One entry per tool in the set, most used first.
   */
  kinds: { tool: EditorToolId; label: string; count: number }[];
  /** Properties every selected mark shares, ready for the controls to show. */
  shared: Required<Pick<SharedStyle, 'opacity' | 'strokeWidth'>> & {
    color?: string;
    fontSize?: number;
  };
  /** Property names the set disagrees about. */
  mixed: (keyof SharedStyle)[];
  /** True when the set holds a text mark whose body the panel will not show. */
  hasText: boolean;
  /** One line for the panel heading and the live region. */
  text: string;
}

function agrees<T>(values: T[]): { same: true; value: T } | { same: false } {
  if (values.length === 0) return { same: false };
  const first = values[0];
  return values.every((value) => Object.is(value, first)) ? { same: true, value: first } : { same: false };
}

export function selectionSummary(
  annotations: readonly EditorAnnotation[],
  ids: readonly string[],
): SelectionSummary {
  const marks = selectedMarks(annotations, ids);
  const counts = new Map<EditorToolId, number>();
  for (const mark of marks) counts.set(mark.tool, (counts.get(mark.tool) ?? 0) + 1);
  const kinds = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tool, count]) => ({ tool, label: TOOL_BY_ID[tool]?.label ?? tool, count }));
  const pages = [...new Set(marks.map((mark) => mark.page))].sort((a, b) => a - b);

  const mixed: (keyof SharedStyle)[] = [];
  const shared: SelectionSummary['shared'] = {
    opacity: 1,
    strokeWidth: 0,
  };
  const color = agrees(marks.map((mark) => mark.color));
  if (color.same) shared.color = color.value;
  else mixed.push('color');
  const opacity = agrees(marks.map((mark) => mark.opacity));
  if (opacity.same) shared.opacity = opacity.value;
  else mixed.push('opacity');
  const stroke = agrees(marks.map((mark) => mark.borderWidth));
  if (stroke.same) shared.strokeWidth = stroke.value;
  else mixed.push('strokeWidth');
  const sized = marks.filter((mark) => mark.fontSize !== undefined);
  const fontSize = sized.length > 0 ? agrees(sized.map((mark) => mark.fontSize as number)) : { same: false as const };
  if (fontSize.same) shared.fontSize = fontSize.value;
  else if (sized.length > 0) mixed.push('fontSize');

  const hasText = marks.some((mark) => EDITABLE_TEXT_KINDS.has(mark.kind));
  const where = pages.length === 1 ? `page ${pages[0] + 1}` : `${pages.length} pages`;
  const what = kinds.map((kind) => `${kind.label} ×${kind.count}`).join(', ');
  const text =
    marks.length === 0
      ? 'Nothing selected.'
      : `${marks.length} marks selected on ${where}${what ? ` — ${what}` : ''}`;
  return { count: marks.length, pages, kinds, shared, mixed, hasText, text };
}

const EDITABLE_TEXT_KINDS = new Set<AnnotationKind>(['Text', 'FreeText']);

/* ------------------------------------------------------------------ *
 * Nudge, duplicate, resize                                            *
 * ------------------------------------------------------------------ */

/** Corner handles, named by the screen edge they sit on (`nw` = top-left). */
export type ResizeHandle = 'nw' | 'ne' | 'sw' | 'se';

export const RESIZE_HANDLES: ResizeHandle[] = ['nw', 'ne', 'sw', 'se'];

/** Direction-correct cursor, so the pointer says which way the corner pulls. */
export function handleCursor(handle: ResizeHandle): string {
  return handle === 'nw' || handle === 'se' ? 'nwse-resize' : 'nesw-resize';
}

/**
 * Which way each corner pulls, as a screen axis in degrees.
 *
 * `nwse-resize` is the axis that runs from the top-left of the screen to the
 * bottom-right, which is 45° measured clockwise from +x with the y axis down.
 */
const HANDLE_AXIS_DEG: Record<ResizeHandle, number> = { nw: 45, se: 45, ne: 135, sw: 135 };

/** The four resize cursors, at the axes they describe. */
const AXIS_CURSORS = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'];

/**
 * The cursor for one corner of a **turned** mark.
 *
 * Rotating the mark rotates the diagonal it pulls along, and a pointer sitting
 * on a handle whose drag now moves the mark up-and-down has to be told so —
 * `nwse-resize` on a 45°-turned corner would promise a pull that cannot happen.
 */
export function rotatedHandleCursor(handle: ResizeHandle, degrees: number): string {
  const axis = (HANDLE_AXIS_DEG[handle] + normaliseAngle(degrees)) % 180;
  return AXIS_CURSORS[Math.round(axis / 45) % AXIS_CURSORS.length];
}

/** How far above the selection the rotate handle floats, in screen pixels. */
export const ROTATE_HANDLE_OFFSET_PX = 24;

/**
 * Where the rotate handle sits, above the edge the selection points with.
 *
 * Built from the edge's own two corners rather than from an angle, so a mark on
 * a turned page gets its handle on the outside just the same as one on a flat
 * page: the offset points away from the shape's centre, whatever the screen
 * happens to be doing to get there.
 */
export function rotateHandlePoint(
  from: Point,
  to: Point,
  centre: Point,
  offsetPx = ROTATE_HANDLE_OFFSET_PX,
): Point {
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  // Two normals to the edge; keep the one that points away from the centre.
  const first = { x: dy / length, y: -dx / length };
  const away = first.x * (mid.x - centre.x) + first.y * (mid.y - centre.y) >= 0 ? first : { x: -first.x, y: -first.y };
  return { x: mid.x + away.x * offsetPx, y: mid.y + away.y * offsetPx };
}

/** Drawn size and grabbable size, in screen px: small to see, easy to catch. */
export const HANDLE_SIZE_PX = 10;
export const HANDLE_HIT_PX = 22;

/** Screen-space position of one handle for a mark at the current geometry. */
export function handlePoint(rect: QuadRect, handle: ResizeHandle): { x: number; y: number } {
  const west = rect.x;
  const east = rect.x + rect.width;
  // PDF space grows upward, so `n` is the larger y.
  const south = rect.y;
  const north = rect.y + rect.height;
  const x = handle.includes('w') ? west : east;
  const y = handle.includes('n') ? north : south;
  return { x, y };
}

/**
 * Where the four corner handles sit for a mark that may be turned.
 *
 * Handles belong to the corners of the *shape*, so a rotated mark's handles go
 * with it: four squares on the axis-aligned box would let the user grab paper
 * the mark does not cover and pull the wrong corner.
 */
export function handleScreenPoints(
  rect: QuadRect,
  degrees: number,
  geom: PageGeom,
): Record<ResizeHandle, Point> {
  const angle = normaliseAngle(degrees);
  const pivot = rectCentre(rect);
  const points = {} as Record<ResizeHandle, Point>;
  for (const handle of RESIZE_HANDLES) {
    const corner = handlePoint(rect, handle);
    points[handle] = pdfToScreenPoint(angle === 0 ? corner : rotatePointAbout(corner, pivot, angle), geom);
  }
  return points;
}

/** The screen box that holds a whole selection, or `null` for an empty one. */
export function selectionScreenBounds(
  marks: readonly EditorAnnotation[],
  geom: PageGeom,
): CssRect | null {
  const corners = marks.flatMap((mark) =>
    rectCorners(markBounds(mark)).map((corner) => pdfToScreenPoint(corner, geom)),
  );
  if (corners.length === 0) return null;
  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/**
 * Pull one corner of a mark, in PDF user space.
 *
 * Every point list travels with the box: a resized highlight keeps one quad per
 * line (each quad is mapped from the old box onto the new one), so a mark that
 * hugged two text lines still hugs two text lines after a resize instead of
 * collapsing to a rectangle. A corner can never cross its opposite: the box
 * keeps at least `MIN_SIZE_PT` of both extents.
 *
 * `dx`/`dy` live on the mark's own axes. A rotated mark's edges are not the
 * page's, so a pointer delta is un-turned first (`unrotateDelta`); the angle
 * itself survives the resize, which is what keeps a turned mark turned while it
 * is pulled.
 */
export const MIN_SIZE_PT = 1;

export function resizeAnnotation(
  annotation: EditorAnnotation,
  handle: ResizeHandle,
  dx: number,
  dy: number,
): EditorAnnotation {
  const old = annotation.rect;
  let west = old.x;
  let south = old.y;
  let east = old.x + old.width;
  let north = old.y + old.height;
  if (handle.includes('w')) west = Math.min(west + dx, east - MIN_SIZE_PT);
  if (handle.includes('e')) east = Math.max(east + dx, west + MIN_SIZE_PT);
  if (handle.includes('n')) north = Math.max(north + dy, south + MIN_SIZE_PT);
  if (handle.includes('s')) south = Math.min(south + dy, north - MIN_SIZE_PT);
  const next: QuadRect = { x: west, y: south, width: east - west, height: north - south };
  const sx = old.width > 0 ? next.width / old.width : 1;
  const sy = old.height > 0 ? next.height / old.height : 1;
  const mapX = (value: number) => round(next.x + (value - old.x) * sx);
  const mapY = (value: number) => round(next.y + (value - old.y) * sy);
  return {
    ...annotation,
    rect: {
      x: round(next.x),
      y: round(next.y),
      width: round(next.width),
      height: round(next.height),
    },
    ...(annotation.quadPoints
      ? { quadPoints: annotation.quadPoints.map((value, index) => (index % 2 === 0 ? mapX(value) : mapY(value))) }
      : {}),
    ...(annotation.inkPath
      ? { inkPath: annotation.inkPath.map((stroke) => stroke.map(([x, y]) => [mapX(x), mapY(y)])) }
      : {}),
    ...(annotation.lineEnds
      ? {
          lineEnds: [
            mapX(annotation.lineEnds[0]),
            mapY(annotation.lineEnds[1]),
            mapX(annotation.lineEnds[2]),
            mapY(annotation.lineEnds[3]),
          ] as [number, number, number, number],
        }
      : {}),
  };
}

const MARKUP_KINDS = new Set<AnnotationKind>(['Highlight', 'Underline', 'StrikeOut', 'Squiggly']);

/**
 * The topmost text-markup mark covering a PDF-space point, or `null`.
 *
 * A click with a markup tool has two honest readings, and the difference is what
 * the user is complaining about when they say a highlight "starts another box".
 * If the gesture is a click and an existing mark covers that point, the click
 * *selects that mark*; only a click on bare paper starts a new one. Quads are
 * consulted before the bounding rect, so a multi-line highlight is picked up by a
 * line it actually covers rather than by the empty leading between them.
 *
 * A rotated mark is asked in its own frame: the point is turned back by the
 * mark's angle and tested against the stored geometry. Testing the axis-aligned
 * box instead would let a click in the corner of a turned highlight land on
 * paper the mark does not cover.
 */
export function markAtPoint(
  annotations: readonly EditorAnnotation[],
  page: number,
  point: Point,
): EditorAnnotation | null {
  const marks = annotations.filter((a) => a.page === page && MARKUP_KINDS.has(a.kind));
  for (let index = marks.length - 1; index >= 0; index -= 1) {
    const mark = marks[index];
    const local = toMarkFrame(point, mark);
    const quads = mark.quadPoints ?? [];
    if (quads.length >= 8) {
      const boxes: QuadRect[] = [];
      for (let at = 0; at + 7 < quads.length; at += 8) {
        boxes.push(boundsOfPoints(quadsToPoints(quads.slice(at, at + 8))));
      }
      if (boxes.some((box) => containsPoint(box, local))) return mark;
      continue;
    }
    if (containsPoint(mark.rect, local)) return mark;
  }
  return null;
}

/** Bring a page-space point into a mark's unrotated frame. */
function toMarkFrame(point: Point, mark: EditorAnnotation): Point {
  const angle = annotationRotation(mark);
  if (angle === 0) return point;
  return rotatePointAbout(point, rectCentre(mark.rect), -angle);
}

/** Whether one mark's real ink covers a page-space point, rotation included. */
export function markCoversPoint(annotation: EditorAnnotation, point: Point): boolean {
  const local = toMarkFrame(point, annotation);
  const quads = annotation.quadPoints ?? [];
  if (MARKUP_KINDS.has(annotation.kind) && quads.length >= 8) {
    for (let at = 0; at + 7 < quads.length; at += 8) {
      if (containsPoint(boundsOfPoints(quadsToPoints(quads.slice(at, at + 8))), local)) return true;
    }
    return false;
  }
  return containsPoint(annotation.rect, local);
}

/**
 * The marks a marquee takes, as ids in list order.
 *
 * The rule is stated because it is the one thing a marquee user checks: a mark
 * is selected when its drawn area shares any point with the band, **including a
 * mark that only touches an edge**. Touching counts because the alternative —
 * "overlap must have area" — hides a mark the user can plainly see the band
 * reaching, and a marquee is drawn to be swept generously. Text markup answers
 * through its quads, so a band in the leading between two highlighted lines does
 * not take that highlight.
 */
export function marksInMarquee(
  annotations: readonly EditorAnnotation[],
  page: number,
  box: CssRect,
  geom: PageGeom,
): string[] {
  const world = screenToPdfRect(box, geom);
  return annotations
    .filter((a) => a.page === page && markIntersectsBox(a, world))
    .map((a) => a.id);
}

/** Whether a mark — turned, quad-shaped or plain — shares a point with a box. */
export function markIntersectsBox(annotation: EditorAnnotation, box: QuadRect): boolean {
  const local = boxToMarkFrame(box, annotation.rect, annotationRotation(annotation));
  const quads = annotation.quadPoints ?? [];
  if (MARKUP_KINDS.has(annotation.kind) && quads.length >= 8) {
    for (let at = 0; at + 7 < quads.length; at += 8) {
      if (boxesTouch(boundsOfPoints(quadsToPoints(quads.slice(at, at + 8))), local)) return true;
    }
    return false;
  }
  return boxesTouch(annotation.rect, local);
}

/** Overlap that counts, edges included — the rule `marksInMarquee` states. */
function boxesTouch(a: QuadRect, b: QuadRect): boolean {
  return (
    a.x <= b.x + b.width &&
    b.x <= a.x + a.width &&
    a.y <= b.y + b.height &&
    b.y <= a.y + a.height
  );
}

function containsPoint(rect: QuadRect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/** How far a duplicate sits from its original, in PDF points. */
export const DUPLICATE_OFFSET_PT = 10;

/**
 * A copy of a mark, offset so both are visible, carrying a fresh id so undo,
 * the layer list and React keys treat them as the two objects they are.
 */
export function duplicateAnnotation(
  annotation: EditorAnnotation,
  offset: { dx?: number; dy?: number } = {},
): EditorAnnotation {
  const dx = offset.dx ?? DUPLICATE_OFFSET_PT;
  const dy = offset.dy ?? -DUPLICATE_OFFSET_PT;
  const moved = moveAnnotation(annotation, dx, dy);
  return { ...moved, id: nextAnnotationId(), createdAt: Date.now() };
}

/**
 * A rect from a drag, or the tool's default box centred on the click point when
 * the gesture was too small to be a rectangle. The result always stays inside
 * the page, so a click near the edge cannot place a mark off it.
 */
export function rectFromDrag(input: BuildInput): QuadRect | null {
  const { drag, geom, tool } = input;
  if (!drag) return null;
  if (isMeaningfulDrag(drag)) return screenToPdfRect(drag, geom);
  const centre = screenToPdfPoint(
    { x: drag.x + drag.width / 2, y: drag.y + drag.height / 2 },
    geom,
  );
  const size = DEFAULT_BOX[tool] ?? { width: 120, height: 60 };
  return clampRectToPage(centeredRect(centre, size.width, size.height), geom);
}
/** Convenience for the in-progress preview of a drag tool. */
export function dragFromPoints(from: Point, to: Point): CssRect {
  return normaliseDrag(from, to);
}

/* ------------------------------------------------------------------ *
 * Export                                                              *
 * ------------------------------------------------------------------ */

/** The `AnnotationSpec` `core/annotations.ts` needs for one annotation. */
export function annotationToSpec(annotation: EditorAnnotation): AnnotationSpec {
  const spec: AnnotationSpec = {
    kind: annotation.kind,
    page: annotation.page,
    rect: annotation.rect,
    color: annotation.color,
    opacity: annotation.opacity,
    borderWidth: annotation.borderWidth,
    createdAt: new Date(annotation.createdAt),
  };
  // The angle travels with the shape rather than being applied here: the writer
  // owns turning `/Rect`, the quads and the appearance stream, and only it can
  // keep the three in step.
  const rotation = annotationRotation(annotation);
  if (rotation !== 0) spec.rotation = rotation;
  if (annotation.fillColor) spec.fillColor = annotation.fillColor;
  if (annotation.borderColor) spec.borderColor = annotation.borderColor;
  if (annotation.contents) spec.contents = annotation.contents;
  if (annotation.quadPoints) spec.quadPoints = annotation.quadPoints;
  if (annotation.inkPath) spec.inkPath = annotation.inkPath;
  if (annotation.lineEnds) {
    spec.lineEnds = annotation.lineEnds;
    spec.lineArrow = annotation.lineArrow ?? 'none';
  }
  if (annotation.kind === 'FreeText') {
    spec.freeText = {
      text: annotation.text ?? '',
      fontSize: annotation.fontSize ?? 12,
      ...(annotation.fillColor ? { background: annotation.fillColor } : {}),
      border: Boolean(annotation.borderColor),
    };
  }
  if (annotation.stampName) spec.stampName = annotation.stampName;
  if (annotation.imageBytes) spec.stampImage = annotation.imageBytes;
  if (annotation.link) spec.link = annotation.link;
  // A /Redact annotation is what Acrobat lists after the content is rewritten.
  // A redaction that has to be burned is *not* marked that way: its /Rect is a
  // bounding box, and a reader applying the annotation later would clear words
  // the mark never covered.
  if (annotation.kind === 'Redact') spec.redact = !redactionNeedsRasterising(annotation);
  return spec;
}

/**
 * Whether a redaction has to be burned as pixels instead of cut as vectors.
 *
 * The text engine deletes glyphs inside an **axis-aligned** box. A redaction
 * turned to any angle that is not a right one covers a parallelogram, so no
 * axis-aligned box is both honest and useful: the bounding box would take whole
 * words the user did not mark, and a smaller box would leave marked words in the
 * file under the fill. Those redactions rasterise their page instead. A right
 * angle is different — turning a rectangle by 90° leaves a rectangle, and its
 * bounding box is exactly the mark — so it keeps the vector path.
 */
export function redactionNeedsRasterising(annotation: EditorAnnotation): boolean {
  if (annotation.kind !== 'Redact') return false;
  return annotationRotation(annotation) % 90 !== 0;
}

/** The four corners a redaction really covers, as 8 numbers in PDF order. */
export function redactionQuad(annotation: EditorAnnotation): number[] {
  const angle = annotationRotation(annotation);
  const centre = rectCentre(annotation.rect);
  const at = (x: number, y: number) => rotatePointAbout({ x, y }, centre, angle);
  const { x, y, width, height } = annotation.rect;
  const ul = at(x, y + height);
  const ur = at(x + width, y + height);
  const ll = at(x, y);
  const lr = at(x + width, y);
  return [ul.x, ul.y, ur.x, ur.y, ll.x, ll.y, lr.x, lr.y].map(round);
}

export interface ExportPlan {
  /** Every annotation, in creation order. */
  specs: AnnotationSpec[];
  /** Redaction regions: the same geometry `applyRedactions` must cut out. */
  redactions: { page: number; rect: QuadRect }[];
  /**
   * Redactions that cannot be cut: `rect` bounds them, `quad` is the region the
   * user marked. Deliberately absent from `redactions`, so the page is burned by
   * pixels rather than sliced by a box that is too big.
   */
  rasterisations: { page: number; rect: QuadRect; quad: number[] }[];
  counts: {
    total: number;
    redactions: number;
    rasterisations: number;
    byKind: { kind: AnnotationKind; count: number }[];
  };
}

/**
 * Marks that would be written to the file but change nothing in it.
 *
 * E13 in the editor's own words: a redaction with no area burns in a dot, a
 * sticky note with no text is an empty comment. Catching them before Export is
 * the difference between "it said success" and "it did the thing".
 */
export interface EmptyMark {
  id: string;
  /** Human sentence, page-qualified, naming the mark rather than its index. */
  reason: string;
}

/** Smallest area, in square points, that still removes or shows something. */
export const MIN_MARK_AREA_PT2 = 1;

export function emptyMarks(annotations: EditorAnnotation[]): EmptyMark[] {
  const found: EmptyMark[] = [];
  for (const annotation of annotations) {
    const label = TOOL_BY_ID[annotation.tool]?.label ?? annotation.kind;
    const where = `${label} on page ${annotation.page + 1}`;
    const { width, height } = annotation.rect;
    if (![annotation.rect.x, annotation.rect.y, width, height].every((n) => Number.isFinite(n))) {
      found.push({ id: annotation.id, reason: `${where} has no usable geometry.` });
      continue;
    }
    if (annotation.kind === 'Redact' && width * height < MIN_MARK_AREA_PT2) {
      found.push({ id: annotation.id, reason: `${where} covers no area, so it would redact nothing.` });
      continue;
    }
    if (annotation.kind === 'Text' && !(annotation.contents ?? '').trim()) {
      found.push({ id: annotation.id, reason: `${where} has no comment text.` });
      continue;
    }
    if (annotation.kind === 'FreeText' && !(annotation.text ?? '').trim()) {
      found.push({ id: annotation.id, reason: `${where} is an empty text box.` });
      continue;
    }
    if (annotation.kind === 'Ink' && (annotation.inkPath?.[0]?.length ?? 0) < 2) {
      found.push({ id: annotation.id, reason: `${where} has no stroke to draw.` });
      continue;
    }
  }
  return found;
}

/**
 * The same list without the marks `emptyMarks` reported — the edit behind the
 * “Remove them” button, kept here so the promise (what is left is what will be
 * written) is testable next to the rule that found them.
 */
export function dropEmptyMarks(annotations: EditorAnnotation[]): EditorAnnotation[] {
  const ids = new Set(emptyMarks(annotations).map((mark) => mark.id));
  if (ids.size === 0) return annotations;
  return annotations.filter((annotation) => !ids.has(annotation.id));
}

/** One-line honest summary for the export button's neighbour. */
export function marksSummary(annotations: EditorAnnotation[]): string {
  const redactions = annotations.filter((a) => a.kind === 'Redact');
  const burned = redactions.filter(redactionNeedsRasterising).length;
  const total = annotations.length;
  if (total === 0) return 'Nothing on the page yet.';
  const head = `${total} mark${total === 1 ? '' : 's'} on ${new Set(annotations.map((a) => a.page)).size} page(s)`;
  if (redactions.length === 0) return `${head}.`;
  const cut = redactions.length - burned;
  const how =
    burned === 0
      ? `${redactions.length} redaction${redactions.length === 1 ? '' : 's'} delete text on export`
      : `${cut} redaction${cut === 1 ? '' : 's'} delete text and ${burned} turned one${burned === 1 ? '' : 's'} burn their page as pixels on export`;
  return `${head} · ${how}`;
}

export function exportPlan(annotations: EditorAnnotation[]): ExportPlan {
  const specs = annotations.map(annotationToSpec);
  const redactions = annotations
    .filter((a) => a.kind === 'Redact' && !redactionNeedsRasterising(a))
    // The cut box is the turned one: at a right angle it is exactly the mark.
    .map((a) => ({ page: a.page, rect: markBounds(a) }));
  const rasterisations = annotations.filter(redactionNeedsRasterising).map((a) => ({
    page: a.page,
    rect: markBounds(a),
    quad: redactionQuad(a),
  }));
  const byKind = new Map<AnnotationKind, number>();
  for (const a of annotations) byKind.set(a.kind, (byKind.get(a.kind) ?? 0) + 1);
  return {
    specs,
    redactions,
    rasterisations,
    counts: {
      total: annotations.length,
      redactions: redactions.length,
      rasterisations: rasterisations.length,
      byKind: [...byKind.entries()]
        .map(([kind, count]) => ({ kind, count }))
        .sort((a, b) => a.kind.localeCompare(b.kind)),
    },
  };
}

/* ------------------------------------------------------------------ *
 * Presentation helpers                                                *
 * ------------------------------------------------------------------ */

/** One-line label for the layer list and the log. */
export function describeAnnotation(annotation: EditorAnnotation): string {
  const label = TOOL_BY_ID[annotation.tool]?.label ?? annotation.kind;
  const body = annotation.text || annotation.contents || annotation.snapText || annotation.stampName;
  const parts = [`${label} · p.${annotation.page + 1}`];
  if (body) parts.push(`· “${clip(body.replace(/\s+/g, ' ').trim(), 42)}”`);
  if (annotation.link) parts.push(`· ${linkTarget(annotation.link)}`);
  return parts.join(' ');
}

/** Human-readable form of a link target. */
function linkTarget(link: NonNullable<EditorAnnotation['link']>): string {
  return link.type === 'uri' ? link.uri : `p.${link.page + 1}`;
}

/**
 * Fingerprint of the unsaved state: identical output means the exported file
 * still matches what is on screen, so the editor is not "dirty".
 */
export function workSignature(annotations: EditorAnnotation[]): string {
  return annotations
    .map((a) =>
      [
        a.id,
        a.kind,
        a.page,
        round(a.rect.x),
        round(a.rect.y),
        round(a.rect.width),
        round(a.rect.height),
        a.color,
        a.fillColor ?? '',
        a.borderColor ?? '',
        a.borderWidth,
        a.opacity,
        a.fontSize ?? '',
        a.text ?? '',
        a.contents ?? '',
        a.stampName ?? '',
        a.imageBytes?.byteLength ?? 0,
        a.rotation ?? 0,
        a.link ? `${a.link.type}:${linkTarget(a.link)}` : '',
      ].join(''),
    )
    .sort()
    .join('');
}

/* ------------------------------------------------------------------ *
 * Internals                                                           *
 * ------------------------------------------------------------------ */

function mergeRects(rects: (QuadRect | null)[]): QuadRect | null {
  const solid = rects.filter((r): r is QuadRect => Boolean(r && r.width > 0 && r.height > 0));
  if (solid.length === 0) return null;
  const corners = solid.flatMap((r) => [
    { x: r.x, y: r.y },
    { x: r.x + r.width, y: r.y + r.height },
  ]);
  return boundsOfPoints(corners);
}

function roundRect(rect: QuadRect | null | undefined): QuadRect {
  if (!rect) return { x: 0, y: 0, width: 1, height: 1 };
  const x = rect.width < 0 ? rect.x + rect.width : rect.x;
  const y = rect.height < 0 ? rect.y + rect.height : rect.y;
  return {
    x: round(x),
    y: round(y),
    width: Math.max(round(Math.abs(rect.width)), 1),
    height: Math.max(round(Math.abs(rect.height)), 1),
  };
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0.05, value));
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
