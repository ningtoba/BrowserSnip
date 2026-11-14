# `alternate-merge` — measured, one defect, fixed and pinned

Probe: `docs/research/alternate-merge-round.mjs` (two documents into the rail, tray
order read out of the DOM and shifted with the cards' own `Move … earlier` button,
the `pattern` select written the way a user's `change` reaches React and read back
out of the DOM before the click, the download taken through the result card's own
button, a screenshot of the pane and of the card). Reader:
`docs/research/alternate-merge-bytes.py` — PyMuPDF, and it **identifies** every output
sheet against the sources (width, height, `/Rotate`, non-white pixels at 50 dpi,
characters, images, annotations, links, first text line), compares the resulting
sequence with an expected one token by token, and compares `/Info` and the XMP packet
with the file the user put first. Chromium headless at 1440×1100, dev server
`http://localhost:5271`, one port per case.

Instrument control, run first: the same checker against the same file with a **plain
stack** expectation (`c1,c2,c3,c4,s1..s5`) fails — `alternate-merge-round-before.log`,
first case, exit 1. A green on an interleave is therefore a measurement and not a page
count.

## What was already right (measured, kept)

* **The rotation the label promises, both directions.** `1-1` on `colour.pdf` (4
  sheets) + `sheets.pdf` (5) is exactly `c1,s1,c2,s2,c3,s3,c4,s4,s5` — the longer
  file's spare sheet `s5` in order at the tail, nothing dropped and nothing
  duplicated. `2-2` is `c1,c2,s1,s2,c3,c4,s3,s4,s5`, so the run length reaches the
  bytes. `reverse-alternate` is `c1,s5,c2,s4,c3,s3,c4,s2,s1`: the front file keeps
  top-to-bottom and only the later one is turned back-to-front, which is the help
  text and the duplex-scan shape; its tail is the reverse block's last sheet, `s1`.
* **The file order is the queue order, and the control reaches the bytes.** `Move
  sheets.pdf earlier` reverses the tray and the output (`s1,c1,s2,c2,s3,c3,s4,c4,s5`)
  and the download name (`sheets_alternated.pdf`).
* **Boxes and `/Rotate` survive the interleave**: `sheets.pdf`'s `640×360` sheet stays
  `640×360` with its image XObject, its `500×500` sheet stays `500×500`, and
  `colour.pdf`'s `595×420 /Rotate 90` sheet comes out `595×420 /Rotate 90` with its
  own `69335` ink.
* **The card counts each file, not a total**: `colour.pdf 3.8 KB · 4 pages`,
  `sheets.pdf 5.2 KB · 5 pages` (shots 1, 5), and the result card's thumbnail strip
  agrees with the file sheet for sheet (shot 2 vs the sequence above).
* **Annotations, links and the outline are carried and re-pointed**: `annot.pdf`'s 3
  annotations and 1 link come out as 3 and 1 on output sheet 2; `bookmarked.pdf`'s
  `Chapter One 1 / Section One.A 2 / Chapter Two 4` come out `2 / 4 / 8`, the mixed
  sheet each page became.
* **Refusals are true**: one file, the run button `disabled` + *Still needed: This
  tool needs at least 2 files — 1 added. · 1 more after that.* (shot 6); a zero-page
  file, *"zero.pdf" has no pages.* (shot 7); the same file twice runs, and the card
  says *'"colour.pdf" appears twice in the queue, so its 4 pages are used twice.'*
* **Dark mode**: tokens only, queue, select and CTA legible (shot 8).

## The defect — the file's identity was thrown away, silently

`pdf-lib` copies pages and nothing else, so `/Info` and the XMP packet sat above the
page tree and stayed behind: on `colour.pdf` the title
`colour-tool fixture: bar + copy + band, colour squares, empty` came out `""`, the
creator was replaced by pdf-lib's own name, the producer was pdf-lib's, and the card
said nothing — under a promise that the output is those files' pages. Measured on all
five produced files (`alternate-merge-round-before.log`, one `FAIL info title:` per
case). `carryDocInfo` (the helper `merge`, `remove-pages`, `reverse-pages` and
`add-blank-page` already use) now carries the first file's title, author, subject,
keywords, creator and packet, `setProducer('BrowserSnip')` claims the bytes, and the
card names whose info was left behind — *Only "meta.pdf"’s document info travelled:
its title, author, subject and keywords are the mixed file’s, and 1 other file’s was
left behind.* (shot 4). An untitled first file invents nothing and says to put the
wanted file first (control, in `tests/pdf/edge-organize.test.ts`). The shared
sentence is parameterised (`noun = 'merged'`) so `merge`'s words do not move.

## Second defect — the unequal-files note counted the wrong noun

The plural was taken from the longest run length, so two files where one is longer —
the ordinary case, including this row's own fixture — read *"the tail of the mix comes
from the longer file**s** only"*. It counts the files that reach the tail now:
`the longer file only` (shot 2/3), and still `the longer files only` with two long
files against a short one.

## Red without the fix

`npx vitest run tests/pdf/edge-organize.test.ts` with `src/lib/pdf/tools/organize.ts`
at `HEAD`: **3 failed / 121 passed** — `expected undefined to be 'First'` (no title on
the output), `expected '' to match /has no document info…/`, and `expected 'The files
are unequal… to match /the tail of the mix comes from the longer file only/i`; with
the fix **124 passed**, and 145 green across it plus `page-copy-fidelity`.

## Left open, measured

1. **A zero-page file leaves its row on `READING` forever** — `counting pages…` and
   *READING PAGES…* still on screen after 30 s while the run button is enabled and
   the job refuses with the true sentence (*has no pages*). Reproduced identically on
   `merge` on the same build, so it is the shared `FileCards` status, not this tool.
2. **The same file twice logs React's duplicate-key warning** (the queue is keyed by
   name). Bytes right, warning present; `merge`'s row records the same.
3. **Keywords come back space-separated** (`alpha beta gamma` for
   `alpha, beta, gamma`) because `setKeywords` takes a list — `merge`'s row, unfixed.
4. **The `pattern` select clips its own option label** to "One page from each file"
   in both themes: the control is narrower than the option text. Cosmetic, shared
   `FieldControls.tsx`, the full labels are in the open list.
