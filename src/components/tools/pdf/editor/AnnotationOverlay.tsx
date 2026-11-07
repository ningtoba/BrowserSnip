/**
 * The annotation overlay.
 *
 * An absolutely-positioned SVG plus a thin HTML layer over the page canvas.
 * Every annotation is stored in PDF user space, so the only thing this
 * component does is convert with `geometry.pdfToScreen*` at the current zoom —
 * the inverse of the render scale, which is what keeps marks glued to the page
 * when the user zooms.
 *
 * It owns no editing state: pointer events are reported as page-relative CSS
 * points and the editor decides what a drag means.
 */
import { useRef } from 'react';
import type { EditorAnnotation, EditorToolId } from './types';
import type { CssRect, PageGeom, Point } from './geometry';
import { markScreenRotation, pdfToScreenPoint, pdfToScreenRect, quadsToPoints } from './geometry';
import { TOOL_BY_ID } from './tools';
import {
  HANDLE_HIT_PX,
  HANDLE_SIZE_PX,
  RESIZE_HANDLES,
  handleScreenPoints,
  rotateHandlePoint,
  rotatedHandleCursor,
  selectionScreenBounds,
  type ResizeHandle,
} from './specs';

export interface OverlayProps {
  geom: PageGeom;
  /** Annotations on the visible page only. */
  annotations: EditorAnnotation[];
  /** The gesture being drawn, already built into an annotation shape. */
  draft: EditorAnnotation | null;
  /** Rubber-band for the vertex tools: committed points plus the cursor. */
  vertices: { points: Point[]; cursor: Point | null } | null;
  tool: EditorToolId;
  /** Whether the armed tool is pinned; it only changes the hint text. */
  pinned: boolean;
  /**
   * The selected ids, oldest first. One id is the selection the editor has
   * always shown; two or more draw a group, which is a different thing to draw
   * and a different thing to grab.
   */
  selection: string[];
  editingId: string | null;
  /** The marquee being dragged out of empty paper, in screen pixels. */
  marquee: CssRect | null;
  onSurfacePointerDown: (point: Point, additive: boolean) => void;
  onAnnotationPointerDown: (id: string, point: Point, additive: boolean) => void;
  onAnnotationDoubleClick: (id: string) => void;
  /** Grabbing a resize handle, whatever tool is armed. */
  onHandlePointerDown: (id: string, handle: ResizeHandle, point: Point) => void;
  /** Grabbing the rotate handle above the selection. */
  onRotatePointerDown: (point: Point) => void;
  /** Double-click on the page while a vertex tool is armed. */
  onFinishVertices: () => void;
  onTextDraft: (id: string, text: string) => void;
  onTextCommit: (id: string) => void;
}

/** Where a sticky note's body is shown next to its icon. */
const NOTE_CARD_PX = 190;

/**
 * The CSS/SVG transform that turns one mark's drawing about its own centre.
 *
 * The geometry is drawn unrotated because that is how it is stored, and the
 * browser then rotates the picture — and, with it, the pointer's idea of what it
 * is over. That is what makes a hit test on a turned mark exact rather than an
 * approximation of its bounding box.
 */
function turn(annotation: EditorAnnotation, geom: PageGeom): { transform?: string } {
  const angle = annotation.rotation ?? 0;
  if (!angle) return {};
  const { centre, degrees } = markScreenRotation(annotation.rect, angle, geom);
  return { transform: `rotate(${round(degrees)} ${round(centre.x)} ${round(centre.y)})` };
}

/** The same turn for an HTML layer, which measures its origin in its own box. */
function turnStyle(annotation: EditorAnnotation, geom: PageGeom): React.CSSProperties {
  const angle = annotation.rotation ?? 0;
  if (!angle) return {};
  const { centre, degrees } = markScreenRotation(annotation.rect, angle, geom);
  return { transform: `rotate(${degrees}deg)`, transformOrigin: `${centre.x}px ${centre.y}px` };
}

export function AnnotationOverlay({
  geom,
  annotations,
  draft,
  vertices,
  tool,
  pinned,
  selection,
  editingId,
  marquee,
  onSurfacePointerDown,
  onAnnotationPointerDown,
  onAnnotationDoubleClick,
  onHandlePointerDown,
  onRotatePointerDown,
  onFinishVertices,
  onTextDraft,
  onTextCommit,
}: OverlayProps) {
  const host = useRef<HTMLDivElement>(null);

  const localPoint = (event: { clientX: number; clientY: number }): Point => {
    const box = host.current?.getBoundingClientRect();
    if (!box) return { x: event.clientX, y: event.clientY };
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  const toolMeta = TOOL_BY_ID[tool];
  const selectable = tool === 'select';
  const selectedMarks = annotations.filter((a) => selection.includes(a.id));
  /**
   * Corner handles belong to one mark. A group gets an outline and a rotate
   * handle instead, because four handles on four marks is a wall of squares and
   * scaling a whole group is not a command this editor offers yet.
   */
  const handleMark = selectedMarks.length === 1 ? selectedMarks[0] : null;
  const group = selectedMarks.length > 1 ? selectionScreenBounds(selectedMarks, geom) : null;
  const textLayers = annotations.filter((a) => a.kind === 'FreeText');

  return (
    <div
      ref={host}
      className="absolute inset-0"
      style={{ touchAction: 'none', cursor: selectable ? 'default' : 'crosshair' }}
      data-tool-gesture={toolMeta.gesture}
      data-armed-pinned={pinned ? 'true' : 'false'}
      data-selection={selection.join(' ')}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        onSurfacePointerDown(localPoint(event), event.shiftKey);
      }}
      onDoubleClick={() => {
        if (tool === 'polygon' || tool === 'polyline') onFinishVertices();
      }}
    >
      <svg
        width={geom.cssWidth}
        height={geom.cssHeight}
        className="absolute inset-0 overflow-visible"
        style={{ pointerEvents: 'none' }}
      >
        {annotations.map((annotation) => (
          <g key={annotation.id} {...turn(annotation, geom)}>
            <Mark annotation={annotation} geom={geom} />
          </g>
        ))}
        {draft ? (
          <g {...turn(draft, geom)}>
            <Mark annotation={draft} geom={geom} draft />
          </g>
        ) : null}

        {vertices && vertices.points.length > 0 ? (
          <g>
            <polyline
              points={[...vertices.points, ...(vertices.cursor ? [vertices.cursor] : [])]
                .map((p) => `${round(p.x)},${round(p.y)}`)
                .join(' ')}
              fill="none"
              stroke="#2563EB"
              strokeWidth={1.5}
              strokeDasharray="4 3"
            />
            {vertices.points.map((p, index) => (
              <circle key={index} cx={p.x} cy={p.y} r={3.5} fill="#2563EB" stroke="#fff" strokeWidth={1} />
            ))}
          </g>
        ) : null}

        {selectable
          ? annotations.map((annotation) => {
              const box = pdfToScreenRect(annotation.rect, geom);
              const pad = Math.max(6 - box.width / 2, 0);
              return (
                // The same turn as the drawing, so the grab area is the shape the
                // user sees — not the box around it.
                <g key={`hit-${annotation.id}`} {...turn(annotation, geom)}>
                  <rect
                    x={box.x - pad}
                    y={box.y}
                    width={box.width + pad * 2}
                    height={Math.max(box.height, 10)}
                    fill="transparent"
                    style={{ pointerEvents: 'all', cursor: 'move' }}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      event.stopPropagation();
                      onAnnotationPointerDown(annotation.id, localPoint(event), event.shiftKey);
                    }}
                    onDoubleClick={(event) => {
                      event.stopPropagation();
                      onAnnotationDoubleClick(annotation.id);
                    }}
                  />
                </g>
              );
            })
          : null}

        {/* Every selected mark keeps its outline, whatever tool is armed. */}
        {selectedMarks.map((annotation) => {
          const box = pdfToScreenRect(annotation.rect, geom);
          return (
            <g key={`sel-${annotation.id}`} {...turn(annotation, geom)}>
              <rect
                x={box.x - 1}
                y={box.y - 1}
                width={box.width + 2}
                height={box.height + 2}
                fill="none"
                stroke="#2563EB"
                strokeWidth={1.5}
                strokeDasharray="4 3"
                style={{ pointerEvents: 'none' }}
              />
            </g>
          );
        })}

        {/*
           A group also gets one box around the whole set, so it is visible what
           the rotate handle and a drag will act on. Handles are omitted: see
           `handleMark`.
        */}
        {group ? (
          <rect
            data-selection-group="true"
            x={group.x - 3}
            y={group.y - 3}
            width={group.width + 6}
            height={group.height + 6}
            fill="none"
            stroke="#2563EB"
            strokeWidth={1}
            strokeDasharray="2 3"
            opacity={0.8}
            style={{ pointerEvents: 'none' }}
          />
        ) : null}

        {handleMark
          ? RESIZE_HANDLES.map((handle) => {
              const corner = handleScreenPoints(handleMark.rect, handleMark.rotation ?? 0, geom)[handle];
              return (
                <g key={`handle-${handle}`}>
                  <rect
                    data-resize-hit={handle}
                    x={corner.x - HANDLE_HIT_PX / 2}
                    y={corner.y - HANDLE_HIT_PX / 2}
                    width={HANDLE_HIT_PX}
                    height={HANDLE_HIT_PX}
                    fill="transparent"
                    style={{
                      pointerEvents: 'all',
                      cursor: rotatedHandleCursor(handle, handleMark.rotation ?? 0),
                    }}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      event.stopPropagation();
                      onHandlePointerDown(handleMark.id, handle, localPoint(event));
                    }}
                  />
                  <rect
                    data-resize-handle={handle}
                    x={corner.x - HANDLE_SIZE_PX / 2}
                    y={corner.y - HANDLE_SIZE_PX / 2}
                    width={HANDLE_SIZE_PX}
                    height={HANDLE_SIZE_PX}
                    fill="#FFFFFF"
                    stroke="#2563EB"
                    strokeWidth={1.5}
                    pointerEvents="none"
                    aria-label={`Resize ${handleMark.tool} ${handle}`}
                  />
                </g>
              );
            })
          : null}

        {/*
           The rotate handle hangs above whatever is selected — one mark above its
           own top edge, a group above the group's box — and drags freely; the
           editor snaps it to 15° unless Shift is held.
        */}
        {(() => {
          if (selectedMarks.length === 0) return null;
          // A single mark turns with its own top edge, so its handle rides that
          // edge; a group's handle sits over the box that holds them all.
          const box = handleMark ? pdfToScreenRect(handleMark.rect, geom) : group;
          if (!box) return null;
          const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
          const corners = handleMark
            ? handleScreenPoints(handleMark.rect, handleMark.rotation ?? 0, geom)
            : null;
          const knob = corners
            ? rotateHandlePoint(corners.nw, corners.ne, centre)
            : rotateHandlePoint({ x: box.x, y: box.y }, { x: box.x + box.width, y: box.y }, centre);
          return (
            <g data-rotate-handle="true">
              <line
                x1={centre.x}
                y1={box.y}
                x2={knob.x}
                y2={knob.y}
                stroke="#2563EB"
                strokeWidth={1}
                strokeDasharray="2 2"
              />
              <circle
                data-rotate-hit="true"
                cx={knob.x}
                cy={knob.y}
                r={HANDLE_HIT_PX / 2}
                fill="transparent"
                style={{ pointerEvents: 'all', cursor: 'grab' }}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  event.stopPropagation();
                  onRotatePointerDown(localPoint(event));
                }}
              />
              <circle
                cx={knob.x}
                cy={knob.y}
                r={HANDLE_SIZE_PX / 2}
                fill="#FFFFFF"
                stroke="#2563EB"
                strokeWidth={1.5}
                pointerEvents="none"
                aria-label="Rotate the selection"
              />
            </g>
          );
        })()}

        {marquee ? (
          <rect
            data-marquee="true"
            x={marquee.x}
            y={marquee.y}
            width={marquee.width}
            height={marquee.height}
            fill="rgba(37, 99, 235, 0.08)"
            stroke="#2563EB"
            strokeWidth={1}
            strokeDasharray="4 3"
            style={{ pointerEvents: 'none' }}
          />
        ) : null}
      </svg>

      {/* FreeText is live DOM so wrapping matches what the box will hold. */}
      {textLayers.map((annotation) => {
        const box = pdfToScreenRect(annotation.rect, geom);
        const editing = annotation.id === editingId;
        if (editing) {
          return (
            <textarea
              key={`edit-${annotation.id}`}
              autoFocus
              value={annotation.text ?? ''}
              onChange={(event) => onTextDraft(annotation.id, event.target.value)}
              onBlur={() => onTextCommit(annotation.id)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  onTextCommit(annotation.id);
                }
              }}
              onPointerDown={(event) => event.stopPropagation()}
              className="absolute resize-none rounded border border-accent bg-white/95 p-1 outline-none shadow-doodle-focus"
              style={{
                left: box.x,
                top: box.y,
                width: Math.max(box.width, 60),
                height: Math.max(box.height, 24),
                color: annotation.color,
                fontSize: Math.max((annotation.fontSize ?? 12) * geom.zoom, 8),
                lineHeight: 1.25,
                ...turnStyle(annotation, geom),
              }}
            />
          );
        }
        return (
          <div
            key={`text-${annotation.id}`}
            className="absolute overflow-hidden whitespace-pre-wrap break-words"
            style={{
              left: box.x + 2,
              top: box.y + 1,
              width: Math.max(box.width - 4, 1),
              height: Math.max(box.height - 2, 1),
              color: annotation.color,
              fontSize: Math.max((annotation.fontSize ?? 12) * geom.zoom, 6),
              lineHeight: 1.25,
              opacity: annotation.opacity,
              pointerEvents: 'none',
              ...turnStyle(annotation, geom),
            }}
          >
            {annotation.text ?? ''}
          </div>
        );
      })}

      {annotations
        .filter((a) => a.kind === 'Text' && selection.includes(a.id) && a.id !== editingId && a.contents)
        .map((a) => {
          const box = pdfToScreenRect(a.rect, geom);
          return (
            <div
              key={`note-${a.id}`}
              className="absolute max-w-[240px] rounded-doodle-md border border-cream-border bg-white p-2 text-[11px] leading-relaxed text-ink shadow-doodle-card"
              style={{ left: box.x + box.width + 6, top: box.y, width: NOTE_CARD_PX, pointerEvents: 'none' }}
            >
              {a.contents}
            </div>
          );
        })}

      {annotations
        .filter((a) => a.kind === 'Text' && a.id === editingId)
        .map((a) => {
          const box = pdfToScreenRect(a.rect, geom);
          return (
            <textarea
              key={`note-edit-${a.id}`}
              autoFocus
              value={a.contents ?? ''}
              placeholder="Note text"
              onChange={(event) => onTextDraft(a.id, event.target.value)}
              onBlur={() => onTextCommit(a.id)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  onTextCommit(a.id);
                }
              }}
              onPointerDown={(event) => event.stopPropagation()}
              className="doodle-input absolute text-[11px] leading-relaxed"
              style={{
                left: box.x + box.width + 6,
                top: box.y,
                width: NOTE_CARD_PX,
                height: 74,
                resize: 'none',
                padding: 6,
              }}
            />
          );
        })}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * One annotation, in screen space                                     *
 * ------------------------------------------------------------------ */

function Mark({
  annotation,
  geom,
  draft = false,
}: {
  annotation: EditorAnnotation;
  geom: PageGeom;
  draft?: boolean;
}) {
  const box = pdfToScreenRect(annotation.rect, geom);
  const opacity = draft ? Math.min(annotation.opacity, 0.7) : annotation.opacity;
  const stroke = annotation.borderColor ?? annotation.color;
  const strokeWidth = Math.max(annotation.borderWidth * geom.zoom, 0.5);
  const common = { opacity };

  switch (annotation.kind) {
    case 'Highlight':
    case 'Underline':
    case 'StrikeOut':
    case 'Squiggly': {
      const quads = chunkQuads(annotation.quadPoints ?? flatRect(annotation.rect), geom);
      return (
        <g {...common}>
          {quads.map((quad, index) =>
            annotation.kind === 'Highlight' ? (
              <polygon
                key={index}
                points={quad.map((p) => `${round(p.x)},${round(p.y)}`).join(' ')}
                fill={annotation.color}
                stroke="none"
              />
            ) : (
              <line
                key={index}
                {...baseline(quad, annotation.kind === 'Underline' ? 0.85 : 0.5)}
                stroke={stroke}
                strokeWidth={strokeWidth}
                strokeLinecap="round"
              />
            ),
          )}
        </g>
      );
    }
    case 'Text': {
      const w = Math.max(box.width, 6);
      const h = Math.max(box.height, 6);
      const foldX = box.x + w * 0.68;
      const foldY = box.y + h - h * 0.68;
      const outline = [
        `${round(box.x)},${round(box.y + h)}`,
        `${round(box.x + w)},${round(box.y + h)}`,
        `${round(box.x + w)},${round(foldY)}`,
        `${round(foldX)},${round(box.y)}`,
        `${round(box.x)},${round(box.y)}`,
      ].join(' ');
      return (
        <g {...common}>
          <polygon points={outline} fill={annotation.fillColor ?? annotation.color} stroke="#1B1B18" strokeWidth={0.8} />
          <polygon
            points={`${round(foldX)},${round(box.y)} ${round(box.x + w)},${round(foldY)} ${round(box.x + w)},${round(box.y)}`}
            fill="#1B1B18"
            opacity={0.35}
          />
        </g>
      );
    }
    case 'FreeText':
      return (
        <g {...common}>
          <rect
            x={box.x}
            y={box.y}
            width={box.width}
            height={box.height}
            fill={annotation.fillColor ?? 'none'}
            stroke={annotation.borderColor ?? 'none'}
            strokeWidth={strokeWidth}
          />
        </g>
      );
    case 'Square':
      return (
        <rect
          x={box.x}
          y={box.y}
          width={box.width}
          height={box.height}
          fill={annotation.fillColor ?? 'none'}
          fillOpacity={annotation.fillColor ? opacity : 0}
          stroke={stroke}
          strokeWidth={strokeWidth}
          opacity={opacity}
        />
      );
    case 'Circle':
      return (
        <ellipse
          cx={box.x + box.width / 2}
          cy={box.y + box.height / 2}
          rx={Math.max(box.width / 2, 0.5)}
          ry={Math.max(box.height / 2, 0.5)}
          fill={annotation.fillColor ?? 'none'}
          fillOpacity={annotation.fillColor ? opacity : 0}
          stroke={stroke}
          strokeWidth={strokeWidth}
          opacity={opacity}
        />
      );
    case 'Ink':
    case 'Polygon':
    case 'PolyLine': {
      const points = (annotation.inkPath?.[0] ?? []).map(([x, y]) =>
        pdfToScreenPoint({ x, y }, geom),
      );
      if (points.length === 0) return null;
      const asString = points.map((p) => `${round(p.x)},${round(p.y)}`).join(' ');
      return annotation.kind === 'Ink' || annotation.kind === 'PolyLine' ? (
        <polyline
          points={asString}
          fill="none"
          stroke={stroke}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={opacity}
        />
      ) : (
        <polygon
          points={asString}
          fill={annotation.fillColor ?? 'none'}
          fillOpacity={annotation.fillColor ? opacity : 0}
          stroke={stroke}
          strokeWidth={strokeWidth}
          strokeLinejoin="round"
          opacity={opacity}
        />
      );
    }
    case 'Line':
    case 'Arrow': {
      const ends = annotation.lineEnds ?? [
        annotation.rect.x,
        annotation.rect.y,
        annotation.rect.x + annotation.rect.width,
        annotation.rect.y + annotation.rect.height,
      ];
      const from = pdfToScreenPoint({ x: ends[0], y: ends[1] }, geom);
      const to = pdfToScreenPoint({ x: ends[2], y: ends[3] }, geom);
      const head = annotation.kind === 'Arrow' || annotation.lineArrow === 'end' || annotation.lineArrow === 'both';
      return (
        <g opacity={opacity}>
          <line
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            stroke={stroke}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
          />
          {head ? (
            <polygon points={arrowHead(from, to)} fill={stroke} opacity={0.9} />
          ) : null}
        </g>
      );
    }
    case 'Stamp': {
      if (annotation.imageUrl) {
        return (
          <image
            href={annotation.imageUrl}
            x={box.x}
            y={box.y}
            width={box.width}
            height={box.height}
            preserveAspectRatio="xMidYMid meet"
            opacity={opacity}
            style={{ mixBlendMode: 'multiply' }}
          />
        );
      }
      const label = annotation.stampName ?? 'Stamp';
      const size = Math.max(Math.min(box.height * 0.55, (box.width / Math.max(label.length, 1)) * 1.6, 28), 7);
      return (
        <g opacity={opacity}>
          <rect
            x={box.x}
            y={box.y}
            width={box.width}
            height={box.height}
            fill="none"
            stroke={annotation.color}
            strokeWidth={Math.max(strokeWidth, 1)}
          />
          <text
            x={box.x + box.width / 2}
            y={box.y + box.height / 2 + size * 0.35}
            textAnchor="middle"
            fontFamily="'Space Grotesk', Inter, sans-serif"
            fontWeight={700}
            fontSize={size}
            fill={annotation.color}
          >
            {label}
          </text>
        </g>
      );
    }
    case 'Link':
      return (
        <g opacity={opacity}>
          <rect
            x={box.x}
            y={box.y}
            width={box.width}
            height={box.height}
            fill="rgba(37, 99, 235, 0.08)"
            stroke={annotation.color}
            strokeWidth={1}
            strokeDasharray="5 3"
          />
          <text
            x={box.x + 2}
            y={box.y - 3}
            fontSize={10}
            fontFamily="'JetBrains Mono', monospace"
            fill={annotation.color}
          >
            {linkLabel(annotation)}
          </text>
        </g>
      );
    case 'Redact':
      return (
        <rect
          x={box.x}
          y={box.y}
          width={box.width}
          height={box.height}
          fill={annotation.fillColor ?? annotation.color}
          opacity={draft ? 0.75 : 1}
        />
      );
    default:
      return (
        <rect
          x={box.x}
          y={box.y}
          width={box.width}
          height={box.height}
          fill="none"
          stroke={stroke}
          strokeWidth={strokeWidth}
          opacity={opacity}
        />
      );
  }
}

/* ------------------------------------------------------------------ *
 * Geometry helpers used only by the overlay                           *
 * ------------------------------------------------------------------ */

/** The quad order written by `geometry.pdfQuadFromViewportBox`: UL, UR, LL, LR. */
function chunkQuads(points: number[], geom: PageGeom): Point[][] {
  const screen = quadsToPoints(points).map((p) => pdfToScreenPoint(p, geom));
  const out: Point[][] = [];
  for (let i = 0; i + 3 < screen.length; i += 4) out.push(screen.slice(i, i + 4));
  return out;
}

function flatRect(rect: { x: number; y: number; width: number; height: number }): number[] {
  return [
    rect.x,
    rect.y + rect.height,
    rect.x + rect.width,
    rect.y + rect.height,
    rect.x,
    rect.y,
    rect.x + rect.width,
    rect.y,
  ];
}

/** A line across a quad at `t` (0 = top edge, 1 = bottom), in screen space. */
function baseline(quad: Point[], t: number) {
  const [ul, ur, ll, lr] = quad;
  const mix = (a: Point, b: Point): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const left = mix(ul, ll);
  const right = mix(ur, lr);
  return { x1: left.x, y1: left.y, x2: right.x, y2: right.y };
}

function arrowHead(from: Point, to: Point): string {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const size = Math.min(Math.max(length * 0.22, 6), 26);
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const spread = Math.PI / 7;
  const wing = (offset: number): Point => ({
    x: to.x - size * Math.cos(angle + offset),
    y: to.y - size * Math.sin(angle + offset),
  });
  const a = wing(spread);
  const b = wing(-spread);
  const notch = { x: to.x - size * 0.35 * Math.cos(angle), y: to.y - size * 0.35 * Math.sin(angle) };
  return [`${round(to.x)},${round(to.y)}`, `${round(a.x)},${round(a.y)}`, `${round(notch.x)},${round(notch.y)}`, `${round(b.x)},${round(b.y)}`].join(' ');
}

const round = (value: number): number => Math.round(value * 10) / 10;

const clip = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

/** What a link annotation says it does, drawn above its box. */
function linkLabel(annotation: EditorAnnotation): string {
  const link = annotation.link;
  if (!link) return 'link';
  return link.type === 'uri' ? clip(link.uri, 34) : `→ p.${link.page + 1}`;
}
