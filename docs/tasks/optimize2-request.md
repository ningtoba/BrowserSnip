# optimize2 → owners: two capabilities the Optimize catalogue does not have

Context: the byte-level audit of `src/lib/pdf/tools/optimize.ts` (9 tools:
pdf-compress, optimize-pdf, rasterize-pdf, repair, sanitize-pdf, linearize-pdf,
pdf-to-pdfa, font-to-outline, deskew-pdf) and `src/lib/pdf/tools/legacy.ts`
(sign, pdf-crop, scan-to-pdf, compare) is now evidenced in
`tests/pdf/optimize-bytes.test.ts` — every claimed number is re-measured from the
output bytes with pdf.js / pdf-lib rather than taken from the report.

That audit turned up one defect and two gaps. The defect is fixed in
`core/compress.ts` and is stated here only because it changes what the two
proposals cost: `collectImages` tested its XObjects with `instanceof PDFDict`,
which an image *stream* is not, so no image was ever collected and every
"N image(s) re-encoded" / "maximum image resolution" claim was vacuous. Images are
now found, downsampled and measured.

Nothing below invents a second id for a job another file already owns. Where a
proposal could live in an existing tool, that tool is named.

## 1. Nothing can remove hidden optional-content content

A CAD or GIS export with twelve switched-off layers ships every one of them: the
drawings are in the file, only the default view hides them.

- `sanitize-pdf` (optimize.ts) now *warns* — `${n} optional content group(s) …
  their content is still in the file` — and touches nothing, because optional
  content is neither a script, an annotation nor an attachment.
- `pdf-layers` (edit.ts) edits the default viewing configuration and deletes group
  *definitions*; its own help says "Hiding a layer turns it off in the layers
  panel; it does not delete the content", and deleting a group makes its content
  **fall back to visible** in most readers — the opposite of what is wanted.
- `flatten-pdf` (security.ts) is forms and annotations, not OCGs.
- `rasterize-pdf` does remove the hidden ink, by removing the text layer with it.

So the user with a 40 MB export whose visible page is 2 MB has no path. The
capability is: drop the content marked by `/OC /Rp <xref>` (BDC…EMC spans, and the
Form XObjects whose `/OC` is that group) plus the group definitions, keeping the
visible page identical, and report how many bytes and how many groups went.

Suggested home: a field on `optimize-pdf` ("Discard layers that are hidden in the
default view", off by default) rather than a new tool — the tool is already the
"lossless tidy-up, reports what it actually did" entry, and the field fits its
existing `did[]` reporting. The implementation belongs in `core/layers.ts`
alongside `deleteLayer`, which already knows how to find a group in every
configuration list but currently stops at the definition.

Acceptance, in the same style as the rest of this category: the output's page
count and visible text are unchanged (pdf.js extraction), the group is gone from
`/OCProperties /OCGs`, no `BDC` operand references it any more, and the size
difference printed is the difference of the two byte lengths.

## 2. Images nested in Form XObjects are never compressed

`collectImages` walks page-level `/Resources /XObject` only, so a picture inside a
Form XObject — the normal shape of an InDesign or Illustrator export, and of every
embedded page from the merge path — is neither found nor resized. The file is
reported as having no images at all, which is now a measurable statement rather
than a guess: `report.images.total` is compared against a hand-written resource
walk in `tests/pdf/optimize-bytes.test.ts`.

The proposal is to recurse into `/Subtype /Form` XObjects (deduplicating by
reference, as page-level images already do, and carrying the form's own BBox/Matrix
into the effective-size calculation so the "widest placement wins" rule in
`displayedImageBoxes` still holds). Two consequences need deciding before anyone
codes it, because both change reported numbers rather than bytes:

- A form is often shared between pages, so one re-encode can affect several
  placements; the effective DPI must be the widest placement *through every matrix
  that reaches it*, not the widest page-level box.
- `optimize-pdf`'s "lossless" label survives (re-encoding is `pdf-compress`'s job),
  but `pdf-compress`'s promise sentence should then say images inside forms are
  included, since a user comparing two runs of the same export will otherwise see
  a different image count with the same visible result.
