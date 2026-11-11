/**
 * RGB → grey, spelled once.
 *
 * The coefficients are **Rec. 709 luma** — the same weighting the CSS
 * `grayscale(1)` filter uses, which is what a canvas paint, and therefore the
 * preview the user approves, is actually made of. They are also the weights sRGB's
 * own `Y` channel uses, whose primaries `core/metadata.ts` writes into the PDF/A
 * output intent as `rXYZ`/`gXYZ`/`bXYZ`.
 *
 * This module exists because the app ran **two** standards side by side: the
 * vector path (`core/content.ts:luminance`) recoloured with BT.601
 * (`0.299/0.587/0.114`) while every canvas path recoloured with `grayscale(1)`
 * (Rec. 709). The same document printed a different grey depending on which button
 * produced it. Measured on the campaign fixture's red `rgb(230, 26, 26)`: **87**
 * through Recolour, **69** through Re-render — eighteen units apart, on a page
 * whose preview showed 69 whichever method the user picked. The table for every
 * swatch, before and after, is `docs/research/greyscale-standard-decision.md`.
 *
 * The rule this enforces: **every** place that turns colour into grey calls in
 * here. A second copy of the triple is how the divergence was born, and neither
 * copy was wrong on its own — the same lesson `core/tree.ts` (one name-tree walk)
 * teaches.
 *
 * Two scales are exported rather than one, because the two families of caller are
 * fixed by their format, not by taste: canvas and image bytes are 0..255, PDF
 * colour operands are 0..1 (§8.6.3). The arithmetic is the same triple.
 */

/** Rec. 709 luma weights. The only place in the app they are written. */
export const LUMA_COEFFICIENTS = { r: 0.2126, g: 0.7152, b: 0.0722 } as const;

/**
 * Perceived luminance of one 0..255 pixel, unrounded, on the same 0..255 scale.
 *
 * Deliberately not rounded here: `inkRatio` compares against a fractional cutoff
 * and `thresholdPixels` rounds to a two-tone decision, so rounding at two different
 * points would hand the callers two different greys for one pixel.
 *
 * Grey is a fixed point of this function: the three weights sum to **exactly** 1 in
 * IEEE-754, so `luma255(v, v, v)` returns `v` for every tone. That is what lets
 * `pdf-to-greyscale` and `invert-colors` promise a second pass changes nothing on a
 * page that is already grey. It is not true by inspection of the old coefficients —
 * `0.299 + 0.587 + 0.114` evaluates to `0.9999999999999999` — so the property is
 * pinned over all 256 tones in `tests/pdf/greyscale-standard.test.ts`, not assumed.
 */
export function luma255(r: number, g: number, b: number): number {
  return LUMA_COEFFICIENTS.r * r + LUMA_COEFFICIENTS.g * g + LUMA_COEFFICIENTS.b * b;
}

/**
 * Perceived luminance of one PDF colour-operand triple (each channel 0..1), on the
 * same 0..1 scale, clamped into range so a caller can write it straight into a
 * `g` / `G` operator.
 */
export function luma01(r: number, g: number, b: number): number {
  const value = LUMA_COEFFICIENTS.r * r + LUMA_COEFFICIENTS.g * g + LUMA_COEFFICIENTS.b * b;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
