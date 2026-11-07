/**
 * Shared vocabulary for the annotation editor.
 *
 * Two coordinate spaces appear over and over here and must not be confused:
 *
 * * **screen space** — CSS pixels over the rendered page, origin at the page's
 *   *top-left*. Everything the pointer reports lives here.
 * * **PDF user space** — points, origin at the page's *bottom-left*, before the
 *   page's `/Rotate` (`QuadRect` in `core/annotations.ts`). `addAnnotations` and
 *   `applyRedactions` only accept this space, so an annotation stores its
 *   geometry here and `geometry.ts` converts on the way in and out.
 */
import type { AnnotationKind, QuadRect } from '@/lib/pdf/core/annotations';

/** Every palette entry. `select` edits existing marks; the rest create them. */
export type EditorToolId =
  | 'select'
  | 'highlight'
  | 'underline'
  | 'strike'
  | 'note'
  | 'freetext'
  | 'ink'
  | 'square'
  | 'circle'
  | 'line'
  | 'arrow'
  | 'polygon'
  | 'polyline'
  | 'stamp'
  | 'image'
  | 'signature'
  | 'link'
  | 'redact';

/**
 * How a tool collects geometry from the pointer:
 * * `markup`   drag a band, snapped to the text lines it crosses
 * * `box`      drag a rectangle (or click for a default-sized one)
 * * `segment`  drag from one point to another
 * * `path`     freehand stroke
 * * `vertices` click points, finish with Enter / double click
 * * `place`    position a raster (stamp, image, signature)
 * * `none`     no geometry (`select`)
 */
export type ToolGesture = 'none' | 'markup' | 'box' | 'segment' | 'path' | 'vertices' | 'place';

export interface ToolMeta {
  id: EditorToolId;
  label: string;
  icon: string;
  /** Shown in the footer while the tool is armed. */
  hint: string;
  gesture: ToolGesture;
  /** PDF annotation subtype this tool produces. */
  kind: AnnotationKind;
}

/** Per-tool appearance, kept so switching tools does not reset a user's pen. */
export interface ToolStyle {
  /** Ink / text colour, `#rrggbb`. For redactions this is the burn-in fill. */
  color: string;
  /** Interior colour used when `filled` is on. */
  fillColor: string;
  filled: boolean;
  /** Stroke width in PDF points. */
  strokeWidth: number;
  /** 0..1, written to `/CA`. */
  opacity: number;
  /** FreeText size in points. */
  fontSize: number;
  /** Built-in stamp `/S` value for the Stamp tool. */
  stampName: string;
}

/**
 * One annotation as the editor holds it. `rect` and every point list are in PDF
 * user space, so an export never re-measures the page and zoom changes cannot
 * drift the geometry.
 */
export interface EditorAnnotation {
  id: string;
  kind: AnnotationKind;
  tool: EditorToolId;
  /** 0-based page index. */
  page: number;
  rect: QuadRect;
  /**
   * Degrees clockwise relative to the page, turned about the centre of `rect`.
   *
   * Stored geometry stays unrotated on purpose: `rect`, `quadPoints`, `inkPath`
   * and `lineEnds` describe the mark as it was drawn, and every consumer —
   * overlay, hit test, handles, export — applies the same turn. Export writes
   * `/Rect` as the bounding box of the *rotated* geometry, never as `rect`.
   * Absent means 0°.
   */
  rotation?: number;
  color: string;
  fillColor?: string;
  borderColor?: string;
  borderWidth: number;
  opacity: number;
  /** Sticky-note body (PDF `/Contents`). */
  contents?: string;
  /** FreeText body. */
  text?: string;
  fontSize?: number;
  /** Strokes of `[x, y]` pairs for Ink / Polygon / PolyLine. */
  inkPath?: number[][][];
  /** `[x1, y1, x2, y2]` for Line / Arrow. */
  lineEnds?: [number, number, number, number];
  lineArrow?: 'none' | 'start' | 'end' | 'both';
  /** 8 numbers per quad, PDF order (UL, UR, LL, LR) — text markup. */
  quadPoints?: number[];
  /** Text the markup covers, kept for the layer list and hints. */
  snapText?: string;
  stampName?: string;
  /** Raster placed by Stamp / Image / Signature (JPEG bytes). */
  imageBytes?: Uint8Array;
  /** Preview URL for the same raster (never exported). */
  imageUrl?: string;
  imageWidth?: number;
  imageHeight?: number;
  link?: { type: 'goTo'; page: number } | { type: 'uri'; uri: string };
  createdAt: number;
}

/** A raster the user has chosen and that is waiting to be placed on a page. */
export interface PlacedRaster {
  bytes: Uint8Array;
  url: string;
  /** Natural size in pixels, so placement can keep the aspect ratio. */
  width: number;
  height: number;
}

/** Documents the tab strip will show at once (BentoPDF's `maxDocuments: 10`). */
export const MAX_DOCUMENTS = 10;
