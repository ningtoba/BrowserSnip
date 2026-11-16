# Round 070 — `bmp-to-pdf`: what the reader does with a BMP that lies

BMP is the raster format with the most places to get a decode wrong, so the round
was ordered as a list of traps and measured one at a time on the dev build
(`:5271`), in one Chromium tab, with the produced pages read back by PyMuPDF.

Probe: `node docs/research/bmp-to-pdf-round.mjs` (multi-file upload, the whole
`innerText` off the card, every created blob captured through
`URL.createObjectURL`, screenshots). Fixtures built by hand with `struct`
(`/tmp/r70/make-fixtures.py`, no image library in the writer): 243 × 160 with a
white block in the top-left corner and red / green / blue horizontal bands — a
shape where a vertical mirror or a one-row shift is visible in the pixels — as
24-bit bottom-up, 24-bit top-down (negative height), 8-bit palette (colours, no
grey), and 1-bit. The same file cut after 10 rows and after 100 rows, a header
whose `bfOffBits` points past the end, one pointing inside its own header, and
three controls that look wrong but are legal: `bfSize` 0, `biSizeImage` 0, 1 024
bytes appended. Plus a JPEG body and a PNG body named `.bmp`.

Every number below is a render comparison against the *same fixture* decoded by
Pillow, mismatched pixels counted at 72 dpi, not a count of objects.

## What the reader already did right — before, unchanged after

| case | measured |
| --- | --- |
| 24-bit bottom-up | 0 mismatched pixels, right way up (white block and red band at the **top**), page `243.0 × 160.0 pt` |
| top-down (height −160) | 0 mismatched pixels, **not** flipped twice, page `243.0 × 160.0 pt` |
| 8-bit palette | 0 mismatched pixels: red `220,30,40`, green `30,160,60`, blue `30,60,200` — the palette is applied, not read as grey |
| 1-bit | black and white as stored |
| JPEG body named `.bmp` | `"actually-jpeg.bmp" is a JPEG image, not a BMP image — left out.` — the batch still converts |
| PNG body named `.bmp` | the same sentence with PNG |
| a real BMP on `jpg-to-pdf` | `"photo.bmp" is a BMP image, not a JPEG image.` |

## What it got wrong — the header was never read

`cut.bmp` (243 × 160, header intact, 10 of 160 rows present) embedded as a
**complete 243 × 160 page**: the ten real rows pixel-exact at the bottom, **150
white rows Chrome invented** above them, and the card said
`5 BMP image(s) → 5 page(s)` with no warning. `cut10` at 100 rows of 160 behaved
the same way (60 invented rows). Pillow calls both files `truncated`; Blink does
not care, and nothing in the pipeline compared the header with the file.

The BMP header states, byte for byte, how much pixel array the file must carry —
`bfOffBits` + stride × rows, with the stride derived from `biBitCount` × width.
`core/images.ts` now reads it (`bmpPixelArray`) before the decoder is asked and
refuses a file that stops short, points its pixels past its own end, or points
them inside its own header:

> `"cut.bmp" could not be decoded: its header describes 117174 byte(s) of pixels
> for a 243 x 160 picture but the file stops after 73254 — the 60 row(s) at its
> top would come out blank`

(said at the top for a bottom-up file, at the bottom for a top-down one).

## Controls — the refusal must not eat valid files

Still accepted, page pixel-exact: `bfSize` 0, `biSizeImage` 0, appended bytes, a
32-bit BI_BITFIELDS file whose pixels start at 66 rather than 54, a
BITMAPCOREHEADER (a header shape the reader does not model is left to the
browser), and a BMP `encodeBmp` writes itself. Only the INFO family (40 bytes and
up), BI_RGB/BI_BITFIELDS, planes = 1 and 1/4/8/16/24/32 bpp are measured; RLE is
left to the decoder because no stride applies to it.

## One more defect, found on the card

Every refusal printed twice — `"cut.bmp" could not be decoded: … — left out.`
under `cut.bmp was left out: "cut.bmp" could not be decoded: …` — because the
runner promotes any logged line containing "could not" into `warnings` and the
refusal path both pushed and logged. A wrong-format refusal, whose sentence has
no such word, printed once, which is why it was invisible before. The two
refusal paths no longer log; the progress line still names the file.

## Pins

`tests/pdf/bmp-to-pdf-header.test.ts`, 15 cases. Red without the fix: 6 failed /
79 passed with `core/images.ts` stashed; the note pin 1 failed / 14 passed and the
duplicate pin 1 failed / 14 passed, measured separately, on their own reverts.
`tests/pdf/convert-to-harness.ts` grew an honest fixture: `bmpBytes` used to be a
54-byte header with no pixels — itself a truncated file, which the old reader
accepted — and now writes the pixel array, `bfSize` and `biSizeImage`; signed
height so a top-down file keeps its size.

## Left open, measured

* `image-to-pdf` throws on the first undecodable file instead of collecting it,
  so a cut BMP in that route's batch ends the run. The sentence is right; the
  batch behaviour is a separate, pre-existing defect.
* A palette index past the end of a palette is still whatever Chrome invents.
* `bfSize` is never trusted, so a file declaring a *smaller* `bfSize` than its
  pixels is not flagged.
* Pixel density in a BMP header (pixels per metre) is stated on the card, not
  applied — the same open item as the PNG round's `pHYs`.
