# Segment requests — annotation editor (worker, audit #3 verification pass)

Three things the verification pass in `docs/research/edit-pdf-audit.md` found and
did not change, because they are outside `editor/**`, `core/annotations.ts` and
the three annotation test files. None blocks the fixes in `a8e0d09`, `1851dfc`
and `3736594`.

## 1. `HANDLE_HIT_PX` is 22 px; UX-BRIEF asks for ~28 px click targets

`docs/UX-BRIEF.md:204` — "No click target under ~28 px; adjacent targets are
separated." `specs.ts:719` sets `HANDLE_HIT_PX = 22`, and that is the slop for a
resize grip and for the rotate knob (a circle of radius 11 px, so ~22 px across).

`1851dfc` did not touch the number: it changed *when* the grips take a press at
all — only under Select, because a grip that eats the tool in the hand is worse
than a small grip. The size question is the brief's owner's, and it is not free:
two grips on a short mark are 22 px apart, so widening the slop makes adjacent
handles overlap and the corner you get depends on paint order. Either raise the
brief's number to what the editor ships, or raise the slop and add the rule for
what happens when two grips collide on a small mark.

## 2. The shared result screen leaves no way to read the exported bytes

Exporting from the editor replaces the whole tool view with the result screen:
the page canvas is unmounted, the editor's own `[data-*]` hooks are gone, and the
only affordances are a **Download** button and **Do another** (`ResultCard.tsx`).

Two consequences for any harness that has to check the file rather than the
canvas — which is the only check that counts on this screen:

- *Download* is a button that calls `downloadBlob`, not an `<a download href>`, so
  `a[download]` matches nothing and CDP `Browser.setDownloadBehavior` produced no
  file either way this pass ran it. The bytes were read by hooking
  `URL.createObjectURL` at document start and fetching the recorded blob URL.
- Nothing unmounts back to the editor in place, so a per-tool sweep must reload
  the document between tools; a sweep that exports mid-run and then keeps
  dragging reports "the tool created nothing" for every tool after the export.

Requested: a stable hook on the primary download control
(`data-output-download="0"`), and — if it is cheap — keep the URL reachable
through an `<a download>` so both a11y tooling and a headless harness can find
the file without patching `URL`.

## 3. `[data-page-extent]` reads like the page's box and is not

`AnnotationEditor.tsx:2428` puts it on a 72 × 15 px `<span>` in the page toolbar
that formats as `595 × 842 pt`, and the attribute's *value* is
`width×height@rotation`. An audit hook list that names it next to
`[data-zoom]` and `[data-mark]` invites a harness to drag relative to
`getBoundingClientRect()` of it — which is a drag across the toolbar, and reads
back as a broken tool. It cost the first probe of audit #3 exactly that.

The attribute itself is honest (it *is* the page extent, as text), and it is
inside the editor's ownership, so this pass left it alone rather than rename a
hook other agents' scripts may already read. If a second geometry hook is ever
wanted, the page's box is already in the DOM as `[data-tool-gesture]` (the
overlay) and the canvas underneath it; documenting those two as *the* geometry
anchors in the brief's audit section would be cheaper than a third attribute.
