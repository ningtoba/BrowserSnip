/**
 * How one planned page is *drawn* in the grid, and how it is written out.
 *
 * Two edge cases live here because the card has to get both right at once:
 *
 * * **E8, mixed page sizes.** A5 inside A4, or a landscape page between two
 *   portrait ones: each thumbnail keeps its own aspect ratio and only the slot
 *   is fixed. Squashing every card to one box is the lie this prevents.
 * * **E9, rotated pages.** `core/render.ts` renders thumbnails through a pdf.js
 *   viewport, which already honours the source page's `/Rotate`. The plan's
 *   `rotate` is an *extra* quarter turn on top of that, so the preview has to
 *   swap width and height for 90°/270° — and the export has to add the two
 *   rotations together instead of overwriting the source's own.
 */
import { normaliseRotation } from '@/lib/pdf/core/pages';
import type { PlanRotation } from './plan';

export interface PageSize {
  width: number;
  height: number;
}

/** Used until the browser reports a thumbnail's intrinsic size (jsdom never
 *  does). Portrait A4-ish, so an unloaded card reserves the same room as a
 *  loaded one instead of jumping the grid. */
export const FALLBACK_PAGE_SIZE: PageSize = { width: 3, height: 4 };

/** The slot a card draws its page into, in CSS pixels. */
export const THUMB_SLOT: PageSize = { width: 132, height: 128 };

/** True when a quarter turn swaps the axes. */
export function swapsAxes(rotation: number): boolean {
  const r = normaliseRotation(rotation);
  return r === 90 || r === 270;
}

export interface PreviewBox {
  /** The room the rotated page occupies — the box the layout must reserve. */
  boxWidth: number;
  boxHeight: number;
  /** The unrotated image size; the card turns it by `rotation` inside the box. */
  imageWidth: number;
  imageHeight: number;
  rotation: PlanRotation;
  /** Whether `natural` was known or the fallback aspect was used. */
  measured: boolean;
}

/**
 * Fit one page into `slot`, accounting for the plan's extra quarter turn.
 *
 * The invariant the tests hold this to: after a 90°/270° turn the box's width
 * equals the image's height and vice versa, so the rotated page always fits its
 * own box exactly — no clipping, no overlap with the neighbouring card.
 */
export function previewBox(
  natural: PageSize | undefined,
  rotation: PlanRotation,
  slot: PageSize = THUMB_SLOT,
): PreviewBox {
  const measured = Boolean(natural && natural.width > 0 && natural.height > 0);
  const src = measured ? (natural as PageSize) : FALLBACK_PAGE_SIZE;
  const turn = swapsAxes(rotation);
  const rotated: PageSize = turn
    ? { width: src.height, height: src.width }
    : { width: src.width, height: src.height };
  const scale = Math.min(slot.width / rotated.width, slot.height / rotated.height);
  return {
    boxWidth: Math.max(1, Math.round(rotated.width * scale)),
    boxHeight: Math.max(1, Math.round(rotated.height * scale)),
    imageWidth: Math.max(1, Math.round(src.width * scale)),
    imageHeight: Math.max(1, Math.round(src.height * scale)),
    rotation,
    measured,
  };
}

/** Inline style for the card's thumbnail wrapper: the outer box reserves the
 *  rotated footprint, the inner element is centred inside it and turned. */
export function previewBoxStyle(box: PreviewBox): {
  outer: { position: 'relative'; width: number; height: number };
  inner: {
    position: 'absolute';
    left: number;
    top: number;
    width: number;
    height: number;
    transformOrigin: string;
    transform: string;
  };
} {
  return {
    outer: { position: 'relative', width: box.boxWidth, height: box.boxHeight },
    inner: {
      position: 'absolute',
      left: Math.round((box.boxWidth - box.imageWidth) / 2),
      top: Math.round((box.boxHeight - box.imageHeight) / 2),
      width: box.imageWidth,
      height: box.imageHeight,
      transformOrigin: 'center center',
      transform: box.rotation ? `rotate(${box.rotation}deg)` : 'none',
    },
  };
}

/**
 * The `/Rotate` to write into the output for one planned page (E9).
 *
 * `item.rotate` is a delta on top of what the source page already says, which is
 * what the preview shows; writing the delta alone would silently un-rotate every
 * page that arrived already sideways.
 */
export function outputRotation(sourceAngle: number, planRotation: PlanRotation): 0 | 90 | 180 | 270 {
  return normaliseRotation(normaliseRotation(sourceAngle) + planRotation);
}

/** Key for the intrinsic-size map: the same source page reused ten times is
 *  measured once. */
export function sizeKey(source: number, page: number): string {
  return `${source}:${page}`;
}
