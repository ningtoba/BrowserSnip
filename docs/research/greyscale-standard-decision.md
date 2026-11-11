# The greyscale standard: one luma, measured

## The decision

**Rec. 709 luma (`0.2126 R + 0.7152 G + 0.0722 B`), in one function, called by every path
that turns colour into grey.** Implemented in `src/lib/pdf/core/colour.ts` (`bf21dc1`),
measured on `docs/research/greyscale-chart.pdf` (`a0ac5c9` + this change).

The app was running two standards at once:

| path | code | standard | `rgb(230, 26, 26)` → |
|---|---|---|---|
| `pdf-to-greyscale`, Method = **Recolour** | `core/content.ts:luminance` → `g`/`G` operators | BT.601 `0.299/0.587/0.114` | **87** |
| `pdf-to-greyscale`, Method = **Re-render** | `core/measure.ts:applyColorFilter` → CSS `grayscale(1)` | Rec.709 | **69** |
| `adjust-colors`, `scanner-effect` | `tools/edit.ts:rerasterise` → CSS `grayscale(1)` | Rec.709 | 69 |
| `compress-pdf` "Greyscale" | `core/compress.ts:782` → CSS `grayscale(1)` | Rec.709 | 69 |
| the preview the user approves | canvas paint of the produced file | Rec.709 | 69 |
| ink metric, bilevel cutoff | `core/measure.ts:lumaOf` → `inkRatio`, `alphaMaskFromPixels`, `thresholdPixels` | BT.601 | — |

Same document, two greys eighteen units apart at the fixture red and **thirty-three** at
saturated magenta and pure green, differing by which half of one segmented control the
user clicked.

709 was chosen over 601 for one reason: the preview is a canvas paint, and CSS
`grayscale(1)` *is* Rec.709. Standardising on 601 would not have fixed greyscale, it would
have moved the error into the preview and broken the promise-equals-output guarantee the
styling work established — the user would approve one grey and download another. Choosing
709 makes the operator path match the picture, and costs nothing on the raster side
because the raster side already lived there.

## How it was measured

`docs/research/greyscale-chart.mjs` builds a 24-swatch sheet **with the campaign's own
swatch generator** — `colour-fixture.mjs`'s `BOX` / `rectOf`, plus a new `drawSwatchSheet`
that returns the fractions it used, written out to `greyscale-chart.json`. Sheet 1 is the
sheet as stored; sheet 2 is the same sheet carrying `/Rotate 90` with its ink placed
*through* the turn, because the raster paths photograph a page as displayed while the
vector path rewrites the operators as stored.

Consumers, all reading the one JSON table:

- `tests/pdf/greyscale-standard.test.ts` — the three operator/raster paths in jsdom over a
  pixel-true canvas whose `grayscale(1)` is literalled from the Filter Effects reference,
  independent of the app's own triple, so the check is against the browser's spec rather
  than against the app quoting itself.
- `docs/research/greyscale-chart-read.py` — loads `colour-ink.py` by path and rebinds its
  `REGIONS`, so the rasterisation, the region inset that keeps a JPEG ring out of a mean,
  and the strided sampling are the campaign's own code. This is the live/deployed rig.
- `docs/research/greyscale-ink-delta.py` — the ink-metric blast radius, below.

The swatches are not invented: the annotation red `#DC2626`, green `#059669`, blue
`#2563EB`, highlighter `#FFEB3B`, the text-marker wash `#FFF3A3` and the pen's `#1B1B18`
come from `components/tools/pdf/editor/tools.ts:SWATCHES` and its style defaults; the
`fixture-*` triple is `colour-fixture.mjs` sheet 2; `grey-89` / `grey-166` are that file's
`grey` and `wash`; plus flat 128, near-black at 10 and 0, near-white at 250, paper, a
saturated cyan/magenta pair and the pure primaries.

## The chart table, before and after

All numbers are greys on the 0..255 scale, measured out of the produced file. "Recolour
before" is the same test run in a worktree at `32c6ada`, i.e. BT.601 through the operator
path; the two raster columns were already Rec.709 there, which is the whole defect.

| swatch | source rgb | Recolour **before** (BT.601) | Re-render before | adjust-colors before | **all three after** | shared grey (Rec.709) | retired (BT.601) |
|---|---|---|---|---|---|---|---|
| `red-ink` | 220,38,38 | 92.4 | 77.0 | 77.0 | 76.7 / 77.0 / 77.0 ✓ | 76.7 | 92.4 |
| `green-ink` | 5,150,105 | 101.5 | 116.0 | 116.0 | 115.9 / 116.0 / 116.0 ✓ | 115.9 | 101.5 |
| `highlight` | 255,235,59 | 220.9 | 227.0 | 227.0 | 226.5 / 227.0 / 227.0 ✓ | 226.5 | 220.9 |
| `marker-wash` | 255,243,163 | 237.5 | 240.0 | 240.0 | 239.8 / 240.0 / 240.0 ✓ | 239.8 | 237.5 |
| `orange` | 255,152,0 | 165.5 | 163.0 | 163.0 | 162.9 / 163.0 / 163.0 ✓ | 162.9 | 165.5 |
| `pink` | 233,30,99 | 98.6 | 78.0 | 78.0 | 78.1 / 78.0 / 78.0 ✓ | 78.1 | 98.6 |
| `violet` | 139,92,246 | 123.6 | 113.0 | 113.0 | 113.1 / 113.0 / 113.0 ✓ | 113.1 | 123.6 |
| `blue-ink` | 37,99,235 | 96.0 | 96.0 | 96.0 | 95.6 / 96.0 / 96.0 ✓ | 95.6 | 96.0 |
| `pen-ink` | 27,27,24 | 26.7 | 27.0 | 27.0 | 26.8 / 27.0 / 27.0 ✓ | 26.8 | 26.7 |
| `fixture-red` | 230,26,26 | 87.0 | 69.0 | 69.0 | 69.4 / 69.0 / 69.0 ✓ | 69.4 | 87.0 |
| `fixture-green` | 26,178,51 | 118.1 | 137.0 | 137.0 | 136.5 / 137.0 / 137.0 ✓ | 136.5 | 118.1 |
| `fixture-blue` | 26,51,230 | 63.9 | 59.0 | 59.0 | 58.6 / 59.0 / 59.0 ✓ | 58.6 | 63.9 |
| `pure-red` | 255,0,0 | 76.2 | 54.0 | 54.0 | 54.2 / 54.0 / 54.0 ✓ | 54.2 | 76.2 |
| `pure-green` | 0,255,0 | 149.7 | 182.0 | 182.0 | 182.4 / 182.0 / 182.0 ✓ | 182.4 | 149.7 |
| `cyan` | 0,255,255 | 178.8 | 201.0 | 201.0 | 200.8 / 201.0 / 201.0 ✓ | 200.8 | 178.8 |
| `magenta` | 255,0,255 | 105.3 | 73.0 | 73.0 | 72.6 / 73.0 / 73.0 ✓ | 72.6 | 105.3 |
| `grey-89` | 89,89,89 | 89.0 | 89.0 | 89.0 | 89.0 / 89.0 / 89.0 ✓ | 89.0 | 89.0 |
| `grey-128` | 128,128,128 | 128.0 | 128.0 | 128.0 | 128.0 / 128.0 / 128.0 ✓ | 128.0 | 128.0 |
| `grey-166` | 166,166,166 | 166.0 | 166.0 | 166.0 | 166.0 / 166.0 / 166.0 ✓ | 166.0 | 166.0 |
| `near-white` | 250,250,250 | 250.0 | 250.0 | 250.0 | 250.0 / 250.0 / 250.0 ✓ | 250.0 | 250.0 |
| `paper` | 255,255,255 | 255.0 | 255.0 | 255.0 | 255.0 / 255.0 / 255.0 ✓ | 255.0 | 255.0 |
| `near-black` | 10,10,10 | 10.0 | 10.0 | 10.0 | 10.0 / 10.0 / 10.0 ✓ | 10.0 | 10.0 |
| `text-black` | 0,0,0 | 0.0 | 0.0 | 0.0 | 0.0 / 0.0 / 0.0 ✓ | 0.0 | 0.0 |
| `cmyk-look-red` | 181,21,28 | 69.6 | 56.0 | 56.0 | 55.5 / 56.0 / 56.0 ✓ | 55.5 | 69.6 |

**Verdict: 24 of 24 swatches agree across all three paths within one 8-bit unit** (the
operator path is exact to the tenth; the raster paths land on the integer the CSS formula
rounds to). **24 of 24 have channel spread exactly 0.** **No two swatches collapse to the
same grey in any path, before or after** — 24 distinct colours, 24 distinct greys,
counted by the test and printed by `greyscale-chart-read.py compare`. The seven achromatic
swatches are untouched at their own value by both standards, which is the fixed-point
property, not a coincidence: both coefficient sets sum to 1.

The `scanner-effect` path is measured separately: at defaults its contrast, whitening and
sharpen passes move the *look*, so the assertion it carries is that every swatch comes back
with spread 0 and in the same **order** as the shared luma (no swatch darker than another
comes back lighter), and that with every pass off it is exactly the plain grey within one
unit. `compress-pdf`'s image greyscale goes through CSS `grayscale(1)` and is already
pinned pixel-wise by `tests/pdf/optimize-bytes.test.ts`.

## The counter-evidence

Red-vs-green did improve, as expected — but it is not the whole story, and three pairs got
*worse*. Both columns are measured on the same chart:

| pair | gap under BT.601 | gap under Rec.709 | |
|---|---|---|---|
| `pure-red` / `cmyk-look-red` | 6.6 | **1.3** | narrowed — two reds are now 1 unit apart |
| `red-ink` / `pink` | 6.1 | **1.4** | narrowed — the palette's red and pink are 1 unit apart |
| `green-ink` / `violet` | 22.1 | **2.8** | narrowed hard — a green and a violet, 22 → 3 |
| `red-ink` / `green-ink` | 9.1 | **39.2** | improved |
| `fixture-red` / `fixture-green` | 31.1 | **67.1** | improved |
| `pure-red` / `pure-green` | 73.4 | **128.2** | improved |
| `fixture-red` / `grey-89` | 2.0 | 19.6 | improved |
| `pink` / `blue-ink` | 2.6 | 17.5 | improved |
| `orange` / `grey-166` | **0.5** | 3.1 | improved, and this was 601's worst merge: a saturated orange and a flat 166 grey were half a unit apart |

Counted honestly: pairs closer than 4 units, **7 under BT.601 → 6 under Rec.709**. Nothing
merges under either (zero exact collisions in 276 pairs). But the tightest pair got
tighter — 0.5 became 1.3 — and the *kind* of tightness changed. Under 601 the risk was a
chromatic colour sitting on top of a flat grey, which destroys the legibility of a greyscale
page: an orange block was indistinguishable from a 166 grey. Under 709 the risk is two
saturated colours of similar hue sitting close to each other (`red-ink`/`pink`,
`pure-red`/`cmyk-look-red`) or, less acceptably, `green-ink` against `violet` at 2.8.

**Flagged for revisit, not special-cased:** `green-ink` (#059669) vs `violet` (#8B5CF6) at
2.8 units is the one pair in this chart where the decision costs real separation, because
those are two separate palette entries a user picks for two different marks and 2.8 units
will not survive being printed. `red-ink` vs `pink` at 1.4 is the same class of loss but
between two colours that already mean nearly the same thing. No special case was added for
either; a hue-dependent tiebreak would be a third standard, which is what this change
removed. If it matters in practice the fix is the palette, not the luma.

**Red-without-fix count: 4 tests** in `tests/pdf/greyscale-standard.test.ts` are red at
`32c6ada` and green now — each failing on its first bad assertion: the cross-path agreement
test (`red-ink` through Recolour measured 92.4 against the standard's 76.7, **15.7 units**
off), both "one triple" tests, and the bilevel-cutoff test (a pixel at `#DC2626` with
cutoff 85 lands on the wrong side of the cut). 10 of 14 passed in both states: those are
the controls — the 256-tone fixed point, spread 0, no-collapse, second-pass idempotence,
"the filter reaches the paint once" — deliberately chosen so they cannot be the ones that
"prove" the fix.

## What changes for existing users

**The grey changes for anyone who used `pdf-to-greyscale` with Method = Recolour** (which
is the default), and for anyone who used `adjust-colors`'s "Make black and white" — that
slider drives `thresholdPixels`, which cut on BT.601, so a coloured pixel near the cutoff
flips tone.

- **`pdf-to-greyscale`, Recolour: greys get darker wherever red or magenta dominates and
  lighter wherever green or cyan dominates.** Measured shifts on the chart: fixture red
  87 → 69, red ink 92 → 77, pink 99 → 78, magenta 105 → 73, pure red 76 → 54, print red
  70 → 56 (darker); fixture green 118 → 137, green ink 102 → 116, pure green 150 → 182,
  cyan 179 → 201, highlighter yellow 221 → 227 (lighter). Up to **33 units** either way,
  on 8-bit grey.
- **`pdf-to-greyscale`, Re-render: nothing changes.** It was already Rec.709 through CSS
  `grayscale(1)`.
- **`adjust-colors` Greyscale, `scanner-effect`, `compress-pdf` Greyscale: nothing changes
  in the grey itself** — same filter, same result (`scanner-effect` has no threshold field
  on its rail; its own greyscale pass was already Rec.709). What changes for the threshold
  control is which side of the cutoff a coloured pixel falls on; a document whose ink is
  black needs no re-download, because a grey pixel's luma is identical under both triples.
- **`remove-blank-pages` and `deskew-pdf`: no decision changed** on the 406-page corpus
  measured below. The metric moved, its verdicts did not.

**The honest part: a user's earlier download was inconsistent with its own preview.** If
they picked Recolour and the page's colour was red-dominant, the file they got was
**lighter** — up to 33 units lighter on a saturated red or magenta — than the picture the
result screen showed them before they pressed Download, because the preview was a canvas
paint of a path that had already chosen 709. This change does not alter what the preview
promises; it makes the second half of the app keep that promise. Anyone who greys an
existing greyscale document again gets the identical file: the seven achromatic swatches
are bit-exact under both standards.

## The measurement blast radius

`inkRatio` (blank-page test, cutoff 220), `alphaMaskFromPixels` (the deskew input,
cutoff 200) and `thresholdPixels` (the bilevel cut, default 128) all counted with
BT.601 and now count with Rec.709, so their numbers had to be re-run rather than argued
about. `docs/research/greyscale-ink-delta.py` rasterises every readable PDF in the repo and
applies each metric's own sampling and cutoff with both triples, page by page:

**812 page-metric rows over 406 pages in 143 files** (6 unreadable, all password-only
fixtures under `tests/fixtures/encrypted/`).

| measure | result |
|---|---|
| pages carrying **no** chromatic pixel | **389 of 406** — ink % is bit-identical, and provably so: both coefficient sets sum to 1, so `R=G=B` is a fixed point of each |
| pages carrying any chromatic pixel | 17 |
| `inkRatio` rows whose ink % moved at all | **1 of 406**, by **0.0239 pp** (`tests/fixtures/foreign/annotations.pdf` [1]: 1.9138 % → 1.8899 %) |
| `alphaMaskFromPixels` rows whose ink population moved | 3 of 406: the chart's two sheets (−2.49 / −2.51 pp, 44 % chroma — an extreme by construction) and `annotations.pdf` (−0.0041 pp) |
| largest ink-% move on any row | 2.5136 pp, on the chart itself (sheet 2, deskew mask) |
| **`blank` / not-blank decisions that changed** | **0** |
| bilevel pixels flipping side | 3068 across 6 pages; **16** on all non-chart pages combined |

**No threshold was retuned.** `inkThreshold 0.001`, the ink cutoff 220, the deskew mask
cutoff 200 and the bilevel 128 are all unchanged, and `tests/pdf/deskew.test.ts`,
`colour-tools-ink.test.ts`, `edge-convert-from.test.ts`, `convert.test.ts`,
`greyscale-ink.test.ts`, `edge-optimize.test.ts` and `optimize-bytes.test.ts` pass on
their original assertions (183 + 103 tests green). The one number a ledger row quotes as
an ink percentage — `pdf-to-greyscale`'s "1166×1652 image at **0.00 %** non-white px where
its own sheet measures **19.50 %**" — is **luma-free**: `rail-measure.py` and
`colour-ink.py` count a pixel as ink when any channel is below 245, so no campaign or
triage percentage moves with this change. That is the reason it did not need re-measuring,
and it is stated so nobody re-measures it by reflex.

The remaining honest exposure is deskew on **colourful** input: a page like the chart, where
44 % of pixels are chromatic, loses 2.5 pp of mask population, which is a real change to
the projection profile. The direction is that Rec.709 reads saturated greens/cyans as
*brighter* than BT.601 did, so a green-inked scan sheds mask pixels; the estimator then
has fewer ink pixels to align and its confidence can drop. Not observed on any page in
this corpus that is not the chart itself, and `deskew.test.ts` still passes untouched.

## On the deployed site

`www.browsersnip.com` was driven from real Chromium with the chart as input
(`docs/research/colour-rail.mjs`, values written as a user's event and read back out of the
DOM), and the two downloads measured swatch by swatch with `colour-ink.py`'s own raster and
region maths via `greyscale-chart-read.py`. Full table:
`docs/research/greyscale-deployed.log`.

The bundle those runs came from is `assets/index-D8Az52Yr.js`, **byte-identical** to the
local `npx vite build` at this commit (`cmp` clean), so the claim is about the deployed
build and not about a local one: it carries `core/colour.ts` — one occurrence of the shared
triple, and the retired triple surviving only as the excluded OCR pre-pass.

**24 of 24 swatches agree between the two deployed methods within one 8-bit unit** (widest
disagreement exactly 1.0000), **no two swatches collapse to one grey in either**, and every
swatch sits on the Rec.709 value: `red-ink` 76 / 77 not 92, `fixture-red` 69 / 69 not 87,
`magenta` 72 / 73 not 105, `pure-green` 182 / 182 not 150. No console errors on either run.

The residual is systematic, not noise, and it is worth naming: the vector path writes the
operator at full precision (`0.29902 g` → 76.25) while the canvas rounds the filtered pixel
to an integer before encoding (77). So Recolour reads at most one unit **below** Re-render
on every chromatic swatch, which is the same distance the ticket's tolerance allows and the
same distance two neighbouring swatches can be. It is not a second standard — one triple
produces both numbers — but a chart where two colours sat 1 unit apart would be decided by
this rounding, which is a further reason the near-merge pairs above are reported rather
than smoothed over.

The result screen's own preview was screenshotted and counted (`docs/research/shots/`), and
it corroborates: 373–471 flat pixels at each Rec.709 grey against 4–92 at the retired BT.601
value for the 14 swatches where the UI palette does not itself use that grey. That count is
**not** the evidence — the poster shares the page with cream and ink chrome whose greys collide
with `cmyk-look-red`'s two candidates (450 px at 56 against 385 px at 70), so the deployed
claim rests on the two measured downloads, and the screenshot is recorded as corroboration
with its one ambiguous row named.

## Coefficient-site ledger

Every hit for `0.299 / 0.587 / 0.114` and `0.2126 / 0.7152 / 0.0722`, and what happened:

| site | was | now |
|---|---|---|
| `core/colour.ts:30` | — | **the only definition**: `LUMA_COEFFICIENTS`, `luma255`, `luma01` |
| `core/content.ts:84 luminance()` | BT.601, its own copy | delegates to `luma01`. Reaches `greyscalePage` (Recolour), `colorOps`, `prependBackground` |
| `core/measure.ts:38 lumaOf()` | BT.601, exported | **removed**; the three call sites (`inkRatio`, `alphaMaskFromPixels`, `thresholdPixels`) call `luma255` directly |
| `tools/convert-from.ts` `pdf-to-greyscale`, `tools/edit.ts` `invert-colors` / `adjust-colors` / `scanner-effect`, `tools/optimize.ts` `rasterize-pdf` | — | **no edit needed**: none of them spells a coefficient, they call the shared helpers. `applyColorFilter` / `rerasterise` reach grey through `cssFilterString` |
| `core/metadata.ts` PDF/A ICC | checked, **bakes no luma matrix** — `rXYZ`/`gXYZ`/`bXYZ` carry the sRGB primaries from the standard, which Rec.709 luma is derived from. Left alone | |
| `core/compress.ts:782` | CSS `grayscale(1)` | unchanged, already the standard |
| `lib/ocr/engine.ts:55` | BT.601 | **deliberately excluded**: OCR preprocessing on pixels that never reach a download; retuning it would move a recognition threshold that has its own evidence base |
| `components/tools/pdf/scan/ScanMain.tsx:142` | BT.601 | **deliberately excluded**: camera enhancement's own look, with a contrast stretch welded to it; not a document colour conversion |
| `tools/security.ts:2445` | BT.601 | **deliberately excluded**: the faded background of the `compare-pdfs` overlay, a UI tone, not a greyscale output |
| `components/tools/pdf/text-editor/model.ts:1959` | Rec.709 | left: picks a legible text colour, already the same weights; it is now coincidentally rather than structurally consistent — a candidate to route at `./colour` when that file is next open |
| `tests/pdf/ocr.test.ts:193`, `colour-tools-ink.test.ts:709`, `text-paint.test.ts:323`, `optimize-bytes.test.ts:203`, `greyscale-ink.test.ts:133-135` | local copies | the test-side Rec.709 copies are the **independent spec witness** and stay literals on purpose (an app-supplied triple would make the cross-check circular); `greyscale-ink.test.ts:135`'s `lumaOf` is BT.601 used only to count ink on already-grey pixels, where the two agree exactly |
| `docs/research/colour-ink.py:66 luma()` | BT.601 | **left, with a reason**: it is the campaign's ink-counting weight and every historical ink percentage in `docs/TOOL-CAMPAIGN.md` was counted with it. It is used on grey rasters, where 601 and 709 agree to the unit. Moving it would rewrite history rather than code. `colour-ink.py:85,102` are the CSS grayscale/saturate formulas and were already Rec.709 |

`tests/pdf/greyscale-standard.test.ts` asserts the `src/` list as a set, so a new copy in a
new file fails the suite rather than joining the ledger unnoticed.

`core/measure.ts:scannerEffect` has no caller in `src/` — the `scanner-effect` tool goes
through `tools/edit.ts:rerasterise`. It was routed at the shared luma anyway (it composes
its filter with `cssFilterString` and calls `thresholdPixels`), but it is dead surface and
recorded here rather than quietly deleted, since deleting an exported core function is a
different ticket's call.
