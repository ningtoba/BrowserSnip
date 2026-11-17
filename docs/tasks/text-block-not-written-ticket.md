# Ticket — the text editor reports a written block and writes nothing

**Found:** 2026‑11‑18, while re-driving the `edit-pdf-text` surface for the font /
white‑box reports. Reproduces on the **dev server**, not only deployed, and with the
campaign's own CV fixture (`python3 docs/research/text-edit-fixture.py /tmp/tbcv` →
`/tmp/tbcv/sample.pdf`).

## What happens

1. Open `#/tool/edit-pdf-text` with `sample.pdf`.
2. Click the big first block (the one the pane counts as 262 / 292 characters) and
   press the panel's **Edit** chip.
3. Type any characters, press Enter, click **Export**.
4. The card says **“Wrote 1 text block on 1 page.”**
5. The produced file has **no new text** — `ZZEDITEDZZ` is absent, the text is the
   original, and the byte count moves by ~14 bytes (3 607 → 3 621) for a page whose
   font should have been embedded.

A small block on the same page (`Keywords: …`) writes correctly, and the same file
then does contain `ZZEDITEDZZ`. So the failure is tied to the block, not the tool.

## Why it matters

It is the surface behind two user reports: the face substitution and the cover
patch are both *preview* behaviour, so a block that is never written leaves the
user looking at a white box and a wrong font over unchanged words. It also means
“Wrote N text block(s)” is a count of the model, not of the bytes.

## How to reproduce without the browser

`docs/research/text-campaign-repro.mjs` drives it end to end:

```
TYPE=1 BLOCK_TEXT='Built the reporting' OUT=/tmp/x.pdf \
  BASE=http://localhost:5271 node docs/research/text-campaign-repro.mjs
```

Then `p.get_text()` on `/tmp/x.pdf`: `ZZEDITEDZZ` missing, report successful. Change
`BLOCK_TEXT` to `Keywords:` and it appears.

## Where to look

The export path is `AnnotationEditor`'s `exportPdf` → `draw.ts` `writePage` per page
object; `outcome.written` is incremented for shape objects and the text branch, and
the message is built from it. A block whose `prepareTextObject` returns an empty
layout, or whose `pageObjects` entry is in the `skipped` set while still counted,
would produce exactly this. The block is large enough to trigger the reflow note
(“no longer fits the lines they came from and were re-flowed past them”), which the
small block does not.

## Done means

`ZZEDITEDZZ` is in the produced file for both block sizes, and the message counts
what was written rather than what was attempted.
