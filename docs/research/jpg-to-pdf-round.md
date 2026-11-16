# `jpg-to-pdf` — the sheet was A4, and one wrong file killed the batch

Round 068, dev build `:5271`, 2026-11. Raster preset routes share one engine with
`image-to-pdf`; this round is the JPEG one, and both defects are in the route's own
wiring rather than in the engine.

## Why "keep real dimensions" was not the whole story

The existing test named "jpg-to-pdf keeps the JPEG's own width and height" passed on
`pageSize: 'a4'` with `margin: 0`: it proved the *image* kept its 320 × 200 pixels,
not that the page was the picture. A 420 × 300 JPEG in the rail landed 483 × 345 pt
inside a 595.28 × 841.89 sheet — the picture floated in white on a page 2.4 times its
height, and the tool offered no way to say "just the picture": the sheet field's list
opened on A4 with no hug option at all.

## Before → after

Both measured with `docs/research/rail-tool-bytes.mjs`, PyMuPDF on the result.

| read | before | after |
| --- | --- | --- |
| page box for a 420 × 300 JPEG (defaults) | `595.28 × 841.89`, image 420 × 300 inside it | `420.0 × 300.0`, image 420 × 300 filling it |
| `PAGES` / message | `1 JPG image(s) → 1 page(s). 1 file(s) left out.` on one valid file | `1 JPG image(s) → 1 page(s).` |
| orientation control under `fit` | offered, inert (no width/height to swap) | hidden, `when: pageSize !== 'fit'` |
| a PNG dropped beside a JPEG | whole run refused, nothing written | JPEG converted, PNG named and left out |

Roots: the sheet field for every raster preset was the shared `PAGE_FIELD`
(default `a4`, no hug entry, shared 56 pt margin); and `decodeImageBatch`'s collector
was handed the `warnings` array that already started with `RASTER_LOSS`, so
`refused.length` was never zero and every run — including a single good JPEG —
claimed a file left out.

## Pins

`tests/pdf/convert-to-bytes.test.ts`, two cases: the default page is the picture, and
a mixed batch keeps the file it can read while naming the one it cannot.
**Reverting `convert-to.ts` turns both red (2 failed / 1 passed); with it, 3 passed.**

## Left open

Per-file refusal messages are in `warnings`, so a card with 20 files shows 20 lines;
`orientation` is still passed as `'portrait'` under `fit` where nothing reads it.
