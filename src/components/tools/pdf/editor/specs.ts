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
  centeredRect,
  clampRectToPage,
  fitRectInBox,
  isMeaningfulDrag,
  normaliseDrag,
  pdfQuadFromViewportBox,
  pdfRectFromViewportBox,
  pointsToPairList,
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
  if (annotation.kind === 'Redact') spec.redact = true;
  return spec;
}

export interface ExportPlan {
  /** Every annotation, in creation order. */
  specs: AnnotationSpec[];
  /** Redaction regions: the same geometry `applyRedactions` must cut out. */
  redactions: { page: number; rect: QuadRect }[];
  counts: { total: number; redactions: number; byKind: { kind: AnnotationKind; count: number }[] };
}

export function exportPlan(annotations: EditorAnnotation[]): ExportPlan {
  const specs = annotations.map(annotationToSpec);
  const redactions = annotations
    .filter((a) => a.kind === 'Redact')
    .map((a) => ({ page: a.page, rect: a.rect }));
  const byKind = new Map<AnnotationKind, number>();
  for (const a of annotations) byKind.set(a.kind, (byKind.get(a.kind) ?? 0) + 1);
  return {
    specs,
    redactions,
    counts: {
      total: annotations.length,
      redactions: redactions.length,
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
