# Ticket — "or open it in Safari or Chrome 130+" over-promises for HEIC

**Found by:** the `heic-to-pdf` measurement (`docs/research/heic-deployed.log`, from
`node docs/research/verify-heic-run.mjs`).

## The sentence

`src/lib/pdf/core/images.ts:305` and `:325` close every undecodable-image refusal with:

> Convert it to PNG or JPEG, **or open it in Safari or Chrome 130+**.

## What was measured

Two real HEIC files on this machine, in Chrome for Testing **151.0.7922.34**:

| file | bytes | container | Pillow/pi_heif | `createImageBitmap` | `<img>` | the tool |
|------|-------|-----------|----------------|---------------------|---------|----------|
| `tiny.heic` (356x356) | 32,756 | `ftypheic` + `hvc1` | decodes | `InvalidStateError` | `onerror` | refused by name, no PDF |
| `ios.heic` (12x7) | 472 | `ftypheic` + `hvc1` | decodes | `InvalidStateError` | `onerror` | refused by name, no PDF |

So on a browser newer than the version the sentence names, on Linux, HEIC does not
decode. Chrome's HEIC/HEIF support rides on the **platform** decoder (the OS HEVC/HEIF
stack), which is exactly why Apple ships it and many Linux boxes do not. "Chrome 130+"
is a statement about the browser alone, and the bytes here contradict it as advice: a
person following it lands back on the same refusal.

## What to do about it

Say the dependency instead of naming a version — e.g. *"…or open it in a browser whose
platform can decode HEIC (Safari on macOS/iOS; Chrome where the OS provides a HEVC/HEIF
decoder)."* The `heic-to-pdf` card already carries the honest version of this since the
commit that added `docs/research/heic-deployed.log`:

> HEIC is decoded by the browser and the operating system, not by this page. Where that
> decoder is absent — measured on Chrome for Testing 151 on Linux, which has no HEIC
> decoder at all — nothing is converted: every file is refused by name and no PDF is
> produced. Convert the photo to PNG or JPEG first.

`core/images.ts` is not in the `heic-to-pdf` seam, so the sentence was left alone rather
than edited from here.

## Also noticed, not fixed

The same refusal text is shared by every image tool (`AVIF`, `JXL`, `WEBP` on old
engines), so the wording change should be checked against `tests/pdf/convert.test.ts` /
`edge-convert-from.test.ts`, which assert the current phrasing.

## Reproduce

```sh
BASE=https://www.browsersnip.com FILES=/tmp/eight/tiny.heic,/tmp/eight/ios.heic \
  OUT=/tmp/eight/heic.pdf node docs/research/verify-heic-run.mjs
```

The first two lines are the in-page decode probe; the run then refuses with
`exit=2` and writes no file.
