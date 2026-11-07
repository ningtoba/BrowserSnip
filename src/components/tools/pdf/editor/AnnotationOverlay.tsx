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
import {
  FREE_TEXT_LINE_EM,
  freeTextInset,
  markupRule,
  quadRing,
} from '@/lib/pdf/core/annotations';
import { TOOL_BY_ID } from './tools';
import {
  HANDLE_HIT_PX,
  HANDLE_SIZE_PX,
  RESIZE_HANDLES,
  carriedAngle,
  handleScreenPoints,
  markBounds,
  noteCardBox,
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
/** How tall the note card is measured — the type-in surface and the card share it. */
const NOTE_CARD_H_PX = 74;

/**
 * The CSS/SVG transform that turns one mark's drawing about its own centre.
 *
 * The geometry is drawn unrotated because that is how it is stored, and the
 * browser then rotates the picture — and, with it, the pointer's idea of what it
 * is over. That is what makes a hit test on a turned mark exact rather than an
 * approximation of its bounding box.
 *
 * The angle comes from `carriedAngle` rather than `rotation`: a subtype whose
 * picture cannot turn — a note's icon, a link's click area — is painted straight
 * here too, so the overlay never shows a lean the exported file will not carry.
 */
function turn(annotation: EditorAnnotation, geom: PageGeom): { transform?: string } {
  const angle = carriedAngle(annotation);
  if (!angle) return {};
  const { centre, degrees } = markScreenRotation(annotation.rect, angle, geom);
  return { transform: `rotate(${round(degrees)} ${round(centre.x)} ${round(centre.y)})` };
}

/**
 * The same turn for an HTML layer.
 *
 * CSS measures `transform-origin` inside the element's own border box, so the
 * pivot is the mark's centre *minus* the offset the element was given — not the
 * page coordinate, which would swing the text around a point off the box and
 * make a turned mark look like it jumped. The element covers the mark's rect, so
 * its own middle is the pivot every other consumer turns about.
 */
function turnStyle(annotation: EditorAnnotation, geom: PageGeom): React.CSSProperties {
  const angle = carriedAngle(annotation);
  if (!angle) return {};
  const { degrees } = markScreenRotation(annotation.rect, angle, geom);
  return { transform: `rotate(${degrees}deg)`, transformOrigin: 'center' };
}

export function AnnotationOverlay({
  geom,
  annotations,
  draft,
  vertices,
  tool,
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
   * Which marks wear the selection chrome.
   *
   * One rule, so a mark never shows two boundaries at once: the mark the caret
   * is inside is being *edited*, and it wears only the type-in surface; the rest
   * of the selection is being *looked at*, and it wears the outline, the handles
   * and the rotate knob. Handles belong to one mark — a group gets an outline
   * and a rotate handle instead, because four handles on four marks is a wall of
   * squares and scaling a whole group is not a command this editor offers yet.
   */
  const chromeMarks = selectedMarks.filter((annotation) => annotation.id !== editingId);
  const handleMark = chromeMarks.length === 1 ? chromeMarks[0] : null;
  const group = chromeMarks.length > 1 ? selectionScreenBounds(chromeMarks, geom) : null;
  const textLayers = annotations.filter((a) => a.kind === 'FreeText');

  return (
    <div
      ref={host}
      className="absolute inset-0"
      style={{ touchAction: 'none', cursor: selectable ? 'default' : 'crosshair' }}
      data-tool-gesture={toolMeta.gesture}
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
          <g key={annotation.id} data-mark={annotation.id} {...turn(annotation, geom)}>
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

        {/* The selection's own outline: drawn on the mark's geometry, not
            around it, so a selected box never looks like two boxes. */}
        {chromeMarks.map((annotation) => {
          const box = pdfToScreenRect(annotation.rect, geom);
          return (
            <g key={`sel-${annotation.id}`} {...turn(annotation, geom)}>
              <rect
                data-selection-outline={annotation.id}
                x={box.x}
                y={box.y}
                width={box.width}
                height={box.height}
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
              const corner = handleScreenPoints(handleMark.rect, carriedAngle(handleMark), geom)[handle];
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
                      cursor: rotatedHandleCursor(handle, carriedAngle(handleMark)),
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
          if (chromeMarks.length === 0) return null;
          // A single mark turns with its own top edge, so its handle rides that
          // edge; a group's handle sits over the box that holds them all.
          const box = handleMark ? pdfToScreenRect(handleMark.rect, geom) : group;
          if (!box) return null;
          const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
          const corners = handleMark
            ? handleScreenPoints(handleMark.rect, carriedAngle(handleMark), geom)
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

      {/*
         FreeText is live DOM so wrapping matches what the box will hold.

         Both surfaces sit on `pdfToScreenRect(rect)` — the mark's own geometry,
         the one the border is stroked on and the one the file writes — and keep
         their text clear of the edges by the padding and leading the appearance
         stream uses. Neither is clamped to a minimum size: a type-in surface
         wider than the mark it stands for is a second box, and the box the user
         dragged is the box they get.
      */}
      {textLayers.map((annotation) => {
        const box = pdfToScreenRect(annotation.rect, geom);
        const size = annotation.fontSize ?? 12;
        const surface: React.CSSProperties = {
          left: box.x,
          top: box.y,
          width: Math.max(box.width, 1),
          height: Math.max(box.height, 1),
          boxSizing: 'border-box',
          padding: freeTextInset(size) * geom.zoom,
          color: annotation.color,
          fontSize: Math.max(size * geom.zoom, 6),
          lineHeight: FREE_TEXT_LINE_EM,
        };
        const editing = annotation.id === editingId;
        if (editing) {
          return (
            <textarea
              key={`edit-${annotation.id}`}
              data-editing-surface={annotation.id}
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
              className="absolute resize-none overflow-hidden bg-transparent outline-none"
              style={{
                ...surface,
                // Inside the edge, so the focus shows on the boundary the mark
                // already has instead of drawing another one around it.
                boxShadow: 'inset 0 0 0 1px var(--accent-line)',
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
              ...surface,
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
          // Anchored on the box the icon really occupies and kept on the paper,
          // so a note near the right edge still has a card the user can read.
          const card = noteCardBox(
            pdfToScreenRect(markBounds(a), geom),
            { width: geom.cssWidth, height: geom.cssHeight },
            { width: NOTE_CARD_PX, height: NOTE_CARD_H_PX },
          );
          return (
            <div
              key={`note-${a.id}`}
              data-note-card={a.id}
              className="absolute max-w-[240px] rounded-doodle-md border border-cream-border bg-white p-2 text-[11px] leading-relaxed text-ink shadow-doodle-card"
              style={{ left: card.x, top: card.y, width: card.width, pointerEvents: 'none' }}
            >
              {a.contents}
            </div>
          );
        })}

      {annotations
        .filter((a) => a.kind === 'Text' && a.id === editingId)
        .map((a) => {
          // The same box as the read-only card, so the caret cannot appear
          // somewhere the icon is not.
          const card = noteCardBox(
            pdfToScreenRect(markBounds(a), geom),
            { width: geom.cssWidth, height: geom.cssHeight },
            { width: NOTE_CARD_PX, height: NOTE_CARD_H_PX },
          );
          return (
            <textarea
              key={`note-edit-${a.id}`}
              data-note-editor={a.id}
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
                left: card.x,
                top: card.y,
                width: card.width,
                height: card.height,
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
      /**
       * The stored order of `/QuadPoints` is data, not winding. A quad is filled
       * through `quadRing` and stroked through `markupRule` — the same two
       * functions the appearance stream in `core/annotations` uses — so the mark
       * on the page cannot stop being the mark in the file.
       */
      const quads = chunkQuads(annotation.quadPoints ?? flatRect(annotation.rect));
      // Read here rather than inside the map: a callback body does not inherit
      // the narrowing the switch above worked out for `annotation.kind`.
      const ruleKind =
        annotation.kind === 'Underline'
        || annotation.kind === 'StrikeOut'
        || annotation.kind === 'Squiggly'
          ? annotation.kind
          : null;
      return (
        <g {...common}>
          {quads.map((quad, index) => {
            const corners = quadsToPoints(quad);
            if (ruleKind) {
              // In PDF space, with the stroke width in points: the same call the
              // writer makes, then mapped to pixels, so screen and file agree by
              // construction rather than by two copies of a formula.
              const rule = markupRule(corners, ruleKind, annotation.borderWidth);
              const from = pdfToScreenPoint({ x: rule.x1, y: rule.y1 }, geom);
              const to = pdfToScreenPoint({ x: rule.x2, y: rule.y2 }, geom);
              return (
                <line
                  key={index}
                  data-markup-rule={ruleKind}
                  x1={round(from.x)}
                  y1={round(from.y)}
                  x2={round(to.x)}
                  y2={round(to.y)}
                  stroke={stroke}
                  strokeWidth={strokeWidth}
                  strokeLinecap="round"
                />
              );
            }
            return (
              <polygon
                key={index}
                points={quadRing(corners)
                  .map((p) => paintedPoint(pdfToScreenPoint(p, geom)))
                  .join(' ')}
                fill={annotation.color}
                stroke="none"
              />
            );
          })}
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
    case 'FreeText': {
      /**
       * The border is stroked *inside* the rect, half a stroke width off the
       * edge, because that is what `textBlockOps` writes into the appearance
       * stream. Centred on the geometry — SVG's default — it stood half outside
       * the box the file draws, which is the offset that reads as a second,
       * slightly misplaced rectangle around a selected text box.
       */
      const inset = Math.min(strokeWidth / 2, Math.min(box.width, box.height) / 4);
      return (
        <g {...common}>
          <rect
            x={box.x + inset}
            y={box.y + inset}
            width={Math.max(box.width - inset * 2, 0.1)}
            height={Math.max(box.height - inset * 2, 0.1)}
            fill={annotation.fillColor ?? 'none'}
            stroke={annotation.borderColor ?? 'none'}
            strokeWidth={strokeWidth}
          />
        </g>
      );
    }
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

/** One stored quad (8 numbers) painted as a `<polygon points>` string. */
const paintedPoint = (point: Point): string => `${round(point.x)},${round(point.y)}`;

/** The stored quads of a markup mark, eight numbers at a time. */
function chunkQuads(points: number[]): number[][] {
  const out: number[][] = [];
  for (let i = 0; i + 7 < points.length; i += 8) out.push(points.slice(i, i + 8));
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
