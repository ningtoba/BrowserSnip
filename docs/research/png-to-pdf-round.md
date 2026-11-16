# Round 069 — `png-to-pdf`: transparency, density and the two refusals

PNG is the one format in this family that carries alpha, so the round asked the
question a cut-out logo actually poses: what does the *page* do where the file is
see-through? Measured first on the dev build (`:5271`), on a real Chromium tab,
with the same fixture read back out of the produced PDF by PyMuPDF.

Probe: `node docs/research/png-to-pdf-round.mjs` (multi-file upload, whole
`innerText` off the card, every created blob captured, screenshots). Fixtures
built with Pillow: `alpha.png` (200 × 200, alpha 0 outside a red disc, RGBA),
`opaque.png` (same geometry, solid), `palette.png` (8-bit palette, index 9
transparent), `bit16.png` (16-bit grey ramp), `dpi300.png` (300 × 150 with
`pHYs` 300 dpi), `ghost.png` (alpha 128), `actually-jpeg.png` (a JPEG named
`.png`).

## What the file does — before, unchanged after

| case | measured in the file |
| --- | --- |
| transparent PNG | image carries `/SMask`, mask **0** at the corners and **255** in the disc; page paints a full-sheet white `1 1 1 rg … f` **before** the `Do`. Rendered at 72 dpi: corner `(255,255,255)`, disc `(220,30,40)` exact. No black, no checkerboard, also on a dark surround |
| opaque PNG | 200 × 200 stored RGB **byte-identical** to the source, page 200 × 200 `pt`, no `/SMask` |
| palette PNG | every opaque pixel identical to the source, transparent index honoured by an `/SMask`; the 0-alpha field is premultiplied black (as Chrome encodes it) |
| 16-bit PNG | decodes; ramp monotonic 0 → 128 → 255, max deviation from the correctly scaled source **1** level (rounding) |
| 300 dpi `pHYs` | page box **300 × 150 pt** (4.17 × 2.08 in) — from pixels at 72 dpi, the `pHYs` density is not applied |
| JPEG named `.png` | refused by name: `"actually-jpeg.png" is a JPEG image, not a PNG image.` |
| PNG named `.jpg` on `jpg-to-pdf` | refused by name: `"actually-png.jpg" is a PNG image, not a JPEG image.` |
| PNG + JPEG in one batch | `1 PNG image(s) → 1 page(s). 1 file(s) left out.` + the sentence naming the JPEG; the PNG converts |

So the behaviour was already right; the file keeps the alpha and the page keeps
its paper. What was missing was the card saying either thing: the notes were
silent on transparency and on density, and the `72 dpi` fact lived only in a
field `help` line that the rail's bar layout does not render.

Controls: an opaque PNG has **no** `/SMask`; a 1-file run of only a JPEG is
refused with the single-file sentence and produces no PDF; the rendered
transparent page over white and over `#181a1e` shows the same white field.

## The fix, and its pins

Two notes (and the same lines on the result card): the alpha is kept in the file
and flattened onto the page's white paper, and the page is sized from pixels at
72 dpi rather than from a recorded density. No byte changes — pages 1–5 of the
6-page before/after run are pixel-identical.

`tests/pdf/png-to-pdf-alpha.test.ts` carries a real pixel canvas (the shared
harness stubs canvases without a pixel buffer and every fixture there is opaque,
so a flattening regression left a mask behind and passed). Red without the fix:
`git stash` the notes → **3 failed / 5 passed**; pass `background: '#ffffff'` to
the decoder → **3 failed / 5 passed**; default `pack.ts` to `'transparent'` →
**1 failed / 7 passed**. Green with it: **8 passed**.

## Left open

* Nothing applies `pHYs`/EXIF density to the page box. Applying it is a
  behaviour change for all six raster presets (`fit` would stop being
  one-point-per-pixel), so it is stated rather than built.
* A run's `SIZE` row compares the output against **every** uploaded byte,
  refused files included: a 73 KB JPEG left out of a 2-file run printed
  `73.4 KB → 1.9 KB · 97% smaller` for a PNG that grew. Shared component.
* The file cards keep the label `counting pages…` under their own `READING` /
  `STOPPED` badge.
* The file picker advertises `image/*`, so a JPEG is selectable on this card and
  then refused by name. Kept: the refusal is the honest answer.
