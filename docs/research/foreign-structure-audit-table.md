| fixture | structure | reader | outside reader says | this app says |
| --- | --- | --- | --- | --- |
| `outlines.pdf` | /Outlines, 3 entries, one of them a child | `readOutline` | MuPDF get_toc(): 3 entries, 2 levels; pypdf 6.14.2 lists the same 3 | 3 node(s), 2 at the top level, depth 2:
Chapter One
  Section One.A
Chapter Two |
| `outlines-dests-flat-direct.pdf` | /Dests /Names with the destination arrays written inline | `readOutline` | pypdf 6.14.2 resolves both to pages 1 and 2 | 2 node(s), 0 without a page: [{"title":"Chapter One","page":0},{"title":"Chapter Two","page":1}] |
| `outlines-dests-flat-ref.pdf` | /Dests /Names with each destination behind a reference | `readOutline` | pypdf 6.14.2 resolves both to pages 1 and 2 | 2 node(s), 2 without a page: [{"title":"Chapter One","page":null},{"title":"Chapter Two","page":null}] |
| `outlines-dests-tree-ref.pdf` | a /Kids + /Limits /Dests tree, destinations behind references | `readOutline` | pypdf 6.14.2 walks the tree and resolves both to pages 1 and 2 | 2 node(s), 2 without a page: [{"title":"Chapter One","page":null},{"title":"Chapter Two","page":null}] |
| `page-labels.pdf` | /PageLabels as a /Kids number tree (i-1, i-2 roman / arabic ranges) | `readPageLabels` | MuPDF get_page_labels(): 3 ranges — i-1 (decimal), 1..2 (upper roman), 3 (lower alpha) | ["1","2","3"] |
| `page-labels-flat.pdf` | /PageLabels as a flat /Nums array — the control for the row above | `readPageLabels` | MuPDF get_page_labels(): the same three ranges as above | ["i-1","I","c"] |
| `layers.pdf` | two /OCGs, one on and one off, one drawn through | `listLayers` | MuPDF get_ocgs(): 2 groups | 2 layer(s): [{"name":"DrawnLayer","on":true},{"name":"HiddenLayer","on":false}] |
| `annotations.pdf` | note + free-text + highlight + link on one page | `listAnnotations / annotationCount` | MuPDF's annots() lists 3 (Text, FreeText, Highlight; it hides the link and the pop-up); the raw /Annots array holds 5 entries | 5 listed (count 5): ["Text","Popup","FreeText","Highlight","Link"] |
| `form.pdf` | AcroForm with a text field and a checkbox | `listFormFields` | MuPDF widgets(): ['answer', 'tick']; the file stores /V /Yes on `tick` and no /V on `answer` | 2 field(s): [{"name":"answer","type":"text"},{"name":"tick","type":"checkbox","value":"On","checked":true}] |
| `metadata.pdf` | /Info written by MuPDF, XMP packet written beside it | `readInfo / readXmp` | MuPDF metadata.title: "Foreign structures" | title="Foreign structures" author="PyMuPDF 1.28.2" props=5 xmp=2 key(s) |
| `attachment.pdf` | enclosure MuPDF writes into the name tree (the reference case) | `listAttachments` | MuPDF embfile_names(): ["enclosure.txt"], poppler: 1 embedded file | 1 attachment(s): [{"name":"enclosure.txt","bytes":8,"sha256":"492d5ea49605"}] |
