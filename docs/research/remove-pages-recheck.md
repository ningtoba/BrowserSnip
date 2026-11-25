# `remove-pages` (Delete Pages) — re-audited on this build (sweep/organize, `:5292`, 2026-11-25)

Probe: `docs/research/remove-pages-round.mjs` — 14 runs, the sheet list typed the
way a user's event reaches React and read back out of the DOM before the click (or
the picker's own tile / `all` chip pressed), the download taken through the result
card's own button, and the panes and cards screenshotted. Reader:
`docs/research/remove-pages-bytes.py SRC OUT KEPT`, which measures every output
sheet the same way as the source sheet it should be — first text line, non-white
pixels at 72 dpi, displayed box, `/MediaBox`, `/CropBox`, `/Rotate`, `/Annots`,
links, images — and then the parts that outlive a page: `/Info`, XMP, outline,
page-label ranges, embedded files. 11 of those runs were judged; **all 11 returned
`VERDICT: OK — the kept sheets are the source sheets, in order`.**

Kept, measured on `colour.pdf` (8 sheets, ink `61153 / 49569 / 0 / 142563 /
249900 / 0 / 24192 / 24192` at 72 dpi, sheet 4 a `595×420 /Rotate 90`, sheet 8 the
`336×71` slip with `/CropBox [42 59.5 378 130.9]`):

| typed | card said | bytes said |
| --- | --- | --- |
| `2` | *"Removed 1 page, kept 7 pages."* | sheets `1,3,4,5,6,7,8` — ink `61153 / 0 / 142563 / 249900 / 0 / 24192 / 24192`, the quarter-turn and the slip's crop intact |
| `3,6` (the two blank sheets) | *"Removed 2 pages, kept 6 pages."* | `1,2,4,5,7,8`, the text sheet still `61153`, the turned one still `/Rotate 90` |
| `4` | 1 removed, 7 kept | the landscape sheet is the one that is gone |
| `8` | 1 removed, 7 kept | the `336×71` slip is gone, the `420×595 /Rotate 90` sheet kept |
| `1,3` | 2 removed, 6 kept | `2,4,5,6,7,8` |
| `odd` | 4 removed, 4 kept | `2,4,6,8` |
| `all` (chip) | button disabled, *"Still needed: Choose the pages to delete — deleting every page would leave an empty PDF."* | nothing written (`all-pane.png`: 8 of 8 tiles outlined, the sentence under the CTA, no clip) |
| `9` | button disabled with the count named | — |
| `1` of a 1-page file | alert *"Deleting pages 1 would remove all 1 page, leaving an empty PDF."* + *"Keep at least one page, or use 'Extract Pages'…"* | nothing written |

Everything that is not a sheet, against the same measurement of the source:
`meta.pdf` → title, author, subject, **keywords `alpha, beta, gamma` with its
separators** and the 233-byte XMP packet all still in the trimmed file while the
producer became `BrowserSnip` (the separators are this lane's `merge` fix landing
in the shared `carryDocInfo`; the previous build rewrote that value as
`alpha beta gamma`, against the tool's own note that the info "stays with the
file"); `attach.pdf` → `note.txt` still embedded; `bookmarked.pdf` `4` → the two
bookmarks pointing at kept sheets re-pointed onto their new numbers, the third
named on the card as dropped; `labels-kids-mixed.pdf` `1` → the numbering shifts
from `i ii I II c xA` to `ii I II c xA`, i.e. re-pointed rather than restarted;
`form.pdf` → the three field boxes keep painting while the card says the fields
stopped being editable; `annot.pdf` `2` → the 3 annotations + 1 link of the kept
first sheet travel, and `1` → they leave with the sheet they were on.

Screen half (`drop2-pane.png`, `drop2-card.png`, `all-pane.png`, read by eye): the
picker paints real ink per tile (text sheet, colour squares, green band, blank
sheets), the typed list reads back before the click, the card previews exactly the
7 kept sheets in order with the turned and slipped ones looking like themselves,
and the refusal prints its sentence instead of a bare disabled button. Dark run
(`dark-pane.png`, `dark-card.png`, plan `1,4`) legible on tokens.
Network half (`net-check.mjs`, live run, field read back `pages=2` → `2`):
`biggestForeignUpload: 0` over 158 same-origin requests; the only foreign traffic
is the shell's Google Fonts CSS/woff2, and the card prints *"Delete Pages finished
in this tab — nothing was uploaded."*

Verdict: **verified-good** on this build — no behaviour changed in this round
beyond the shared keyword carry named above; every clause of the tool's two notes
and its promise was measured, not assumed.
