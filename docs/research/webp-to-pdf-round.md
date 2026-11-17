# round 070 — webp-to-pdf

Round out of order (the dispatcher skipped it); the family had just been settled
by `f02af67` (raster defaults, refusals) and `4b754b6` (BMP header validation), so
this round did not redo either.

Probe: `node docs/research/webp-to-pdf-round.mjs` (`CASES=decode,cut,anim,fake,pad,cross`,
`PORT=9870`, blobs captured through a `URL.createObjectURL` wrapper, whole
`document.body.innerText` read off the card, screenshots looked at). Fixtures in
`/tmp/r70w/`: `lossy.webp` and `lossless.webp` (400 x 240, Pillow), `alpha.webp`
(200 x 200, lossless, alpha 0 outside a red disc), `anim.webp` (4 frames, 200 x
120), `cut.webp` (the lossy file at 40 % of its bytes), `padded.webp` (lossy + 64
appended bytes), `png-in.webp` / `jpg-in.webp` (another container under the name).
Judged by PyMuPDF on the produced pages against the same fixture decoded by
Pillow.

## The reader, before (dev build `:5271`)

| question | measured |
| --- | --- |
| lossy + lossless decode | **0 mismatched pixels** against Pillow's decode of the same files (`>2` on any channel), page = pixels at `400.0 x 240.0 pt` — already right |
| alpha | `/SMask` present, mask **0** at the corners and **255** in the disc, `1 1 1 rg … f` paper before the `Do`; the page renders `(255,255,255)` outside and `(220,30,40)` in the disc — 0 mismatched against the source composited over white. **Already right, and the card said nothing about it** |
| animated 4-frame WebP | **one page, first frame only** (0 mismatched against frame 0, 9 262 / 9 569 / 9 449 against frames 1-3), card `1 WEBP image(s) -> 1 page(s)`, no note — the promise says "every WEBP … becomes its own page" and the frames vanished unmentioned |
| truncated WebP | **converted anyway as a blank page**: a full 400 x 240 page, **96 000 of 96 000 pixels white**, card `2 WEBP image(s) -> 2 page(s)`, no warning. `createImageBitmap` answered a complete bitmap of nothing; Pillow refuses the same file (`could not create decoder object`) |
| `.webp` holding PNG / JPEG bytes | refused by name, once each, the real WebP beside them still converted — already right |

Cause of the truncation: nothing read the RIFF `File Size` at byte 4 or the chunk
sizes, both of which state — in the file's own bytes — how long it must be. The
cause of the silence on animation: nothing counted `ANMF` frames.

## After

`core/images.ts` grows `webpShortfall` (only `RIFF`/`WEBP` files judged; only the
file's own numbers used) behind an `image/webp` case in `decodeImage`, alongside
the BMP guard, and `webpFrameCount`. The webp preset passes a `notices` collector
into `decodeImageBatch` and adds two notes (header checked; first frame only) plus
the PNG transparency note it now earns.

* `"cut.webp" could not be decoded: its header says the file is 1428 byte(s) long,
  but the file stops after 571 — 857 byte(s) of the picture are missing — left
  out.` The page count drops to the one good file (400 x 240, 96 000 inked px,
  pixel-identical to the lossy control), the card counts `1 file(s) left out.`
* `"anim.webp" is an animated WebP with 4 frames — only the first one is on its
  page, and the PDF will not play the rest.` Page is still frame 0 exactly.
* Controls that must NOT be refused: a chunk that overruns a rewritten header is
  refused by the chunk sentence (isolates the walk from the length check); 64
  appended bytes are accepted (`1 WEBP image(s) -> 1 page(s)`, 400 x 240, all
  inked — the spec says a reader MAY ignore trailing data); a still WebP gets no
  animation line; a complete file converts at its own size.
* Unchanged: lossy and lossless still 0 mismatched pixels; the alpha page still
  SMask 0/255 over white paper.

Screenshots looked at: `before-decode-card.png` (3 thumbnails, third = red disc
on white), `before-cut-card.png` (thumbnail 1 a blank white rectangle, "2 WEBP
image(s) -> 2 page(s)"), `before-anim-card.png`, `before-fake-card.png`,
`after-decode-card.png`, `after-cut-card.png`, `after-anim-card.png`,
`after-pad-card.png` (dark), `after-alpha-page.png` (the alpha page composited
over a dark surround: white paper square, red disc — the transparency is the
file's, the white is the page's).

Pinned by `tests/pdf/webp-to-pdf-reader.test.ts` (13): **6 failed / 7 passed**
with `core/images.ts` and `tools/convert-to.ts` stashed; 13 green with them.

## Left open, measured

* `image-to-pdf` receives the same refusal (its `decodeImage` call is the same)
  but still throws on the first undecodable file instead of collecting it, and it
  gets no animation line — it does not pass `notices`.
* One page per frame for an animation would need `ImageDecoder` and the spec's
  canvas assembly (frame rects, blend and disposal); this round states the
  first-frame behaviour instead.
* A `VP8X` canvas larger than the frames' rectangles is not cross-checked; only
  the length and chunk bounds are.
