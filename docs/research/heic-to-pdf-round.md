# `heic-to-pdf` — round 071 (out of order)

**Verdict: the refusal was already whole — no invented page, no partial file, exit
clean — and the words, the hint and the card state at the point of refusal were
wrong. Fixed at those causes and pinned; the decode itself is the platform's.**

The tool has no decoder of its own: `decodeImage` sniffs `ftyp` at byte 4, gets
`image/heic`, and asks `createImageBitmap` then `<img>`. On Chrome for Testing
151.0.7922.34 / Linux both refuse, which is a fact about the OS's HEVC stack and
is already stated in the card's long note (commit `18013ff`). So the honest
refusal *is* the feature on this build, and the file half of every case here is
"0 blobs, no PDF", matched against what the surface said.

## Fixtures

`/tmp/round071/`, made with Pillow + `pillow_heif` (both HEIC files decode in
Pillow on this machine, so a refusal here is the browser's, not the file's):

```py
import pillow_heif; from PIL import Image, ImageDraw   # pillow_heif 1.8.1
# real.heic   400x300 RGB 5235 B   ftypheic  (red/green/blue blocks + a disc)
# tiny.heic    64x48  RGB 1486 B   ftypheic
# heic-named.jpg  = real.heic renamed .jpg
# jpeg-named.heic = /tmp/triage/in/photo.jpg renamed .heic
# png-named.heic  = /tmp/triage/in/photo.png renamed .heic
```

## Reproduce

```sh
pkill -9 -f 'debugging-port=98[0-9]'   # the pattern must not match this command line
BASE=http://localhost:5271 SPEC=docs/research/heic-to-pdf-round-spec.json \
  OUTDIR=/tmp/r71 JSONL=/tmp/r71/runs.jsonl PORT=9824 node docs/research/colour-rail.mjs
```

Eight runs, one Chromium, screenshots at `shot: true`. Records kept verbatim:
`heic-to-pdf-round-before.jsonl`, `heic-to-pdf-round-after.jsonl`.

## Before (port 9823) — what the sentences and the cards said

| case | alert | cards | blobs |
|---|---|---|---|
| `real.heic` (5235 B, `ftypheic`) | `"real.heic" could not be decoded: This image could not be opened: this browser has no decoder for HEIC/HEIF (…). Convert the file to PNG or JPEG, or open it in Safari or Chrome 130+.` — hint: `Re-save the file as HEIC, or use Images to PDF, which sniffs the real format.` | STOPPED; **torn-image glyph** in the thumb | 0 |
| `jpeg-named.heic` | `is a JPEG image, not a HEIC/HEIF image or a HEIF image.` | — | 0 |
| `png-named.heic` | `is a PNG image, not a HEIC/HEIF image or a HEIF image.` | — | 0 |
| `heic-named.jpg` on `heic-to-pdf` | refused as undecodable HEIC — sniffed at byte 4, the name did not fool it | — | 0 |
| `heic-named.jpg` on `jpg-to-pdf` | `is a HEIC/HEIF image, not a JPEG image.` | — | 0 |
| `real.heic` + `photo.jpg` (both orders) | both named, one sentence each | first STOPPED, **second still `READING` + `counting pages…`**; its HEIC thumb torn | 0 |

Counts were right in the same run: `2 IN THIS JOB`, `Nothing changed yet · Create a
PDF from one or more HEIC images`, no page count claimed, 0 console errors. The
decoder sentence's `Chrome 130+` is the claim `docs/tasks/heic-decoder-claim-ticket.md`
already has on file: this build is newer than that and has no decoder.

Screenshots, looked at: `shots/heic-071-before-refusal.png`,
`shots/heic-071-before-batch.png`.

## Four causes

1. `unsupported()` / the no-`Image` branch closed with a browser **version**
   (false as advice here). Now: *"…or open it in a browser whose platform can
   decode it."*
2. `decodeImageBatch`'s `hint` is written for the wrong-format case and was reused
   for decode failures, so a HEIC owner was told to `Re-save the file as HEIC` —
   what the file already is. New `decodeHint`, used once a decode has failed
   (including in the raised mixed-batch sentence).
3. `advertisedFormats` joined both HEIC MIME labels, printing `not a HEIC/HEIF
   image or a HEIF image`. A label contained in another (article-stripped) is
   dropped.
4. `FileCards`/`usePdfTool`: an image input always has an object URL, so a failed
   `<img>` painted the browser's torn-image glyph and the card's own placeholder
   was unreachable for every image; only the **first** name in a joined refusal
   got `setFileState`, so the second card kept `READING` over a count that was not
   coming.

## After (port 9824, same spec, same fixtures)

| case | alert | cards | blobs |
|---|---|---|---|
| `real.heic` | `… no decoder for HEIC/HEIF (…). Convert the file to PNG or JPEG, or open it in a browser whose platform can decode it.` — hint: `Re-save the photo as PNG or JPEG, or open this page where the system can decode HEIC (Safari on macOS or iOS), then try again.` | STOPPED; dashed **`HEIC`** placeholder | 0 |
| `jpeg-named.heic` / `png-named.heic` | `not a HEIC/HEIF image.` | — | 0 |
| `heic-named.jpg` (both routes) | unchanged, still sniffed by byte 4 | — | 0 |
| `photo.jpg` + `real.heic` (both orders) | both named, decode hint | **both STOPPED, both `pages unknown`**, JPEG keeps its picture | 0 |

Controls that had to keep passing: a 420 × 300 JPEG's card still renders as an
`<img>` (`data-card-thumb="image"`), the sniffer still answers `image/jpeg` for
JPEG bytes and `image/heic` only for `ftyp` at byte 4, and the wrong-way round
(`jpg-to-pdf` over HEIC bytes) still says `is a HEIC/HEIF image, not a JPEG image`.
Dark mode read, tokens only: `shots/heic-071-after-refusal-dark.png`.
Red without the fix, `src/` stashed: **8 failed / 6 passed**; 14 green with it.
Full suite 3 492 passed / 1 skipped, `tsc -b` 0, `typecheck:tests` 0,
`vite build` 0.

## Left open, measured

- `image-to-pdf` throws on the first undecodable file instead of collecting it
  (family-wide, unchanged by this round; the sentence is right, the batch is not).
- The sniff maps **any** `ftyp` to HEIC/HEIF, so an `.mp4` dropped into either
  tool is named `HEIC/HEIF` (measured, both tools). Narrowing it to the HEIF brand
  list changes what an MP4 does, and the no-brand fallback would then say `PNG`, so
  it is written up rather than guessed at.
- A browser that *does* decode (Safari on macOS) could not be measured here, so
  "every HEIC you add becomes a page" is pinned only by the refusal and the
  conditional note.
- The page-count line on a *successful* image run still reads `counting pages…`
  (the count is never set for image inputs); a stopped card now says `pages unknown`.
