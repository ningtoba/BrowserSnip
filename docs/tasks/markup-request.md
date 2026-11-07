# Markup requests — annotation editor (worker, edit-pdf defects pass)

Two changes outside my ownership. Both are follow-ups to the underline/strike
placement fix; neither blocks it.

## 1. `src/lib/pdf/core/render.ts` — carry the font's ascent and descent

`toExtractedItems()` builds `ExtractedTextItem` from `content.items` only and
throws away `content.styles`, which is where pdf.js reports the real per-font
vertical metrics:

    { g_d0_f1: { fontFamily: 'sans-serif', ascent: 0.718, descent: -0.207 } }

Those numbers are exactly what a text mark needs. Measured against the rendered
canvas on the CV (`/tmp/sample.pdf`), a run's reported box is one em tall with
its **bottom edge on the baseline** — its top carries ~0.28 em of air above the
ascenders, and its bottom excludes the ~0.21 em of descenders. So the box the
text layer reports is the wrong box to mark, and `quads.snapTextLines` now
re-anchors it with pdf.js's own fallback em split (`DEFAULT_FONT_ASCENT`, 0.8 /
0.2) instead of the document's real split.

Requested: add `ascent` / `descent` (number, fractions of the em, taken from
`content.styles[item.fontName]`) to `ExtractedTextItem`. With those in place
`snapTextLines` can use `baseline - ascent * em` / `baseline - descent * em`
and drop `TEXT_BASELINE_SHARE`, which is a cited fallback rather than a
measurement. `editor/quads.ts` and `editor/AnnotationOverlay.tsx` are the two
call sites; both already receive `ExtractedTextItem[]`.

## 2. `AnnotationEditor`'s page canvas — a 1 px border offsets the page from the overlay

The canvas is styled `width: geom.cssWidth` with Tailwind's global
`box-sizing: border-box` and a `border border-cream-border`, so the *bitmap*
paints inside a content box 2 px narrower than the CSS box the overlay is
measured from:

    host   { x: 632,   y: 209.5, w: 834,    h: 1179.5 }
    canvas { x: 632,   y: 209.5, w: 834,    h: 1179.5, boxSizing: border-box, borderWidth: 1px }
    bitmap { w: 834,   h: 1179 }

Every mark is therefore ~1 px right-and-down of the pixels it annotates, and
the error grows by ~0.24 % across the page (≈ 0.5 pt at the far edge). Fix:
move the card's edge to `outline`/`box-shadow` (which do not affect layout) or
set `boxSizing: 'content-box'` on the canvas. Owner: `src/components/tools/pdf/
editor/AnnotationEditor.tsx` line ~2484 — that file is mine, but the change is
visual (the doodle card's edge) so it is flagged rather than slipped into this pass.
