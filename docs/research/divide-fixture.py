"""Build the ten-sheet divide fixture: 10 sheets, sheet 4 empty, sheet 6 a
595x420 sheet at `/Rotate 90`, one text line and a stepped marker per sheet."""

import pymupdf
d = pymupdf.open()
tones = [0.85, 0.45, 0.12]
for n in range(1, 11):
    if n == 4:
        d.new_page(width=420, height=595)          # an empty sheet, no content
        continue
    if n == 6:
        p = d.new_page(width=595, height=420)
        p.set_rotation(90)                         # displayed 420x595, portrait
        # displayed-left = light, displayed-right = dark, in the *displayed* frame
        for i, t in enumerate(tones):
            p.draw_rect(pymupdf.Rect(i * 140, 0, (i + 1) * 140, 420), color=None, fill=(t, t, t))
        p.insert_text((20, 40), "SHEET 06 ROT", fontsize=18)
        continue
    p = d.new_page(width=420, height=595)
    for i, t in enumerate(tones):
        p.draw_rect(pymupdf.Rect(i * 140, 0, (i + 1) * 140, 595), color=None, fill=(t, t, t))
    p.insert_text((14, 34), f"SHEET {n:02d}", fontsize=20, color=(0, 0, 0))
    # a marker block whose height steps with the sheet, so a swapped pair shows
    p.draw_rect(pymupdf.Rect(360, 100 + n * 25, 410, 130 + n * 25), color=None, fill=(0, 0, 0))
d.set_metadata({"title": "ten-sheet divide fixture"})
d.save("/tmp/dv/ten.pdf")  # noqa: S108
print("wrote /tmp/dv/ten.pdf", d.page_count)
