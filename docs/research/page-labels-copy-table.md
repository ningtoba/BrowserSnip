# Page numbering across the page copy, judged by readers that did not write it

Inputs are in `tests/fixtures/readers/`, written by MuPDF 1.28.2 / libqpdf
12.3.2 / pypdf 6.14.2 by `scripts/readers-foreign-fixtures.py`; outputs are the
shipped `runPdfTool` over those bytes. `this app asserted` is the column
`tests/pdf/page-labels-copy.test.ts` fails on, so the two outside columns are
an independent answer to the same question, sheet by sheet.

| row | the copy | this app asserted | MuPDF 1.28.2 | pypdf 6.14.2 | the file's own store |
| --- | --- | --- | --- | --- | --- |
| `copy-blank-between` | `add-blank-page` position="after" anchor=1 count=1 size="same" on `labels-kids-mixed.pdf` | ['i', '2', 'ii', 'I', 'II', 'c', 'xA'] | in ['i', 'ii', 'I', 'II', 'c', 'xA'] → out ['i', '2', 'ii', 'I', 'II', 'c', 'xA']; **yes** | in ['i', 'ii', 'I', '4', 'c', 'xA'] → out ['i', '2', 'ii', 'I', 'II', 'c', 'xA']; **yes** | `/Kids x2` → `/Nums x6` |
| `copy-full` | `extract-pages` pages="all" mergeIntoOne=true on `labels-kids-mixed.pdf` | ['i', 'ii', 'I', 'II', 'c', 'xA'] | in ['i', 'ii', 'I', 'II', 'c', 'xA'] → out ['i', 'ii', 'I', 'II', 'c', 'xA']; **yes** | in ['i', 'ii', 'I', '4', 'c', 'xA'] → out ['i', 'ii', 'I', 'II', 'c', 'xA']; **yes** | `/Kids x2` → `/Nums x4` |
| `copy-prefix-only` | `extract-pages` pages="1-2" mergeIntoOne=true on `labels-nums-prefix-only.pdf` | ['Cover ', 'Cover '] | in ['Cover ', 'Cover ', 'of i', 'of ii'] → out ['Cover ', 'Cover ']; **yes** | in ['Cover ', 'Cover ', 'of i', 'of ii'] → out ['Cover ', 'Cover ']; **yes** | `/Nums x2` → `/Nums x1` |
| `copy-range-discarded` | `extract-pages` pages="1-2,6" mergeIntoOne=true on `labels-kids-mixed.pdf` | ['i', 'ii', 'xA'] | in ['i', 'ii', 'I', 'II', 'c', 'xA'] → out ['i', 'ii', 'xA']; **yes** | in ['i', 'ii', 'I', '4', 'c', 'xA'] → out ['i', 'ii', 'xA']; **yes** | `/Kids x2` → `/Nums x2` |
| `copy-reorder-duplicate` | `organize` pageOrder="4,1,2,2,6" on `labels-kids-mixed.pdf` | ['II', 'i', 'ii', 'ii', 'xA'] | in ['i', 'ii', 'I', 'II', 'c', 'xA'] → out ['II', 'i', 'ii', 'ii', 'xA']; **yes** | in ['i', 'ii', 'I', '4', 'c', 'xA'] → out ['II', 'i', 'ii', 'ii', 'xA']; **yes** | `/Kids x2` → `/Nums x4` |
| `copy-subset` | `extract-pages` pages="4-6" mergeIntoOne=true on `labels-kids-mixed.pdf` | ['II', 'c', 'xA'] | in ['i', 'ii', 'I', 'II', 'c', 'xA'] → out ['II', 'c', 'xA']; **yes** | in ['i', 'ii', 'I', '4', 'c', 'xA'] → out ['II', 'c', 'xA']; **yes** | `/Kids x2` → `/Nums x3` |
| `copy-subset-prefix` | `extract-pages` pages="2-4" mergeIntoOne=true on `labels-kids-prefix.pdf` | ['§II', 'A-21', 'A-22'] | in ['<A7>I', '<A7>II', 'A-21', 'A-22'] → out ['<A7>II', 'A-21', 'A-22']; **sheet 1: '<A7>II' not '§II'** | in ['§I', '2', 'A-21', '4'] → out ['§II', 'A-21', 'A-22']; **yes** | `/Kids x2` → `/Nums x2` |
| `copy-unknown-style` | `extract-pages` pages="all" mergeIntoOne=true on `labels-nums-unknown-style.pdf` | ['2', '3', '4', '5'] | in ['', '', '', ''] → out ['', '', '', '']; **sheet 1: '' not '2'; sheet 2: '' not '3'; sheet 3: '' not '4'; sheet 4: '' not '5'** | in ['1', '2', '3', '4'] → out ['1', '2', '3', '4']; **sheet 1: '1' not '2'; sheet 2: '2' not '3'; sheet 3: '3' not '4'; sheet 4: '4' not '5'** | `/Nums x1` → `/Nums x1` |
| `copy-unlabelled` | `extract-pages` pages="all" mergeIntoOne=true on `labels-absent.pdf` | ['1', '2', '3', '4'] | in ['', '', '', ''] → out ['', '', '', '']; **sheet 1: '' not '1'; sheet 2: '' not '2'; sheet 3: '' not '3'; sheet 4: '' not '4'** | in ['1', '2', '3', '4'] → out ['1', '2', '3', '4']; **yes** | `absent` → `absent` |
| `merge-labelled-with-plain` | `merge` bookmarks=false on `labels-kids-mixed.pdf` + `labels-absent.pdf` | ['i', 'ii', 'I', 'II', 'c', 'xA', '7', '8', '9', '10'] | in ['i', 'ii', 'I', 'II', 'c', 'xA', '', '', '', ''] → out ['i', 'ii', 'I', 'II', 'c', 'xA', '7', '8', '9', '10']; **yes** | in ['i', 'ii', 'I', '4', 'c', 'xA', '1', '2', '3', '4'] → out ['i', 'ii', 'I', 'II', 'c', 'xA', '7', '8', '9', '10']; **yes** | `/Kids x2 + absent` → `/Nums x5` |
| `merge-two-labelled` | `merge` bookmarks=false on `labels-kids-mixed.pdf` + `labels-nums-r.pdf` | ['i', 'ii', 'I', 'II', 'c', 'xA', 'i', 'ii', 'iii', 'iv'] | in ['i', 'ii', 'I', 'II', 'c', 'xA', 'i', 'ii', 'iii', 'iv'] → out ['i', 'ii', 'I', 'II', 'c', 'xA', 'i', 'ii', 'iii', 'iv']; **yes** | in ['i', 'ii', 'I', '4', 'c', 'xA', 'i', 'ii', 'iii', 'iv'] → out ['i', 'ii', 'I', 'II', 'c', 'xA', 'i', 'ii', 'iii', 'iv']; **yes** | `/Kids x2 + /Nums x1` → `/Nums x5` |
| `writer-after-copy` | `add-page-labels` ranges="1-2 roman 1" on `copy-subset` | ['i', 'ii', 'iii'] | in ['II', 'c', 'xA'] → out ['i', 'ii', 'iii']; **yes** | in ['II', 'c', 'xA'] → out ['i', 'ii', 'iii']; **yes** | `/Nums x3` → `/Nums x1` |

## What the readers complained about, verbatim

pypdf logs these instead of raising, so they belong with the table.

```
  2 × Could not reliably determine page label for 1.
 16 × Could not reliably determine page label for 3.
 16 × Ignoring unknown page label numbering style '/G' in /Nums.
```


## Every row, and what it is the evidence for

- **`copy-blank-between`** — the inserted sheet comes from no page of the source, so it has no label of its own; the run it split opens again on the next sheet with the number that sheet carried (`/St 2`, still `ii`).
- **`copy-full`** — a full copy in order leaves every range where it was — the case a carry-across also gets right, which is what makes it the control rather than the fix
- **`copy-prefix-only`** — §12.4.2 Table 160 makes `/S` optional and both outside readers then show the prefix alone, which is also the shape `add-page-labels` writes for its `none` style. A copy that gave these sheets a number would be adding content the file does not hold.
- **`copy-range-discarded`** — the ranges on pages 3-4 and 5 numbered nothing that survived, so both leave the file. Shifted or clamped instead, the third sheet would read `I` or `c` — a number it never had.
- **`copy-reorder-duplicate`** — one source range splits over non-adjacent sheets, and a page copied twice repeats its own label rather than taking the next number — §12.4.2 increments per sheet, which only matches the source while both indices step by one
- **`copy-subset`** — the first surviving range’s `/Start` becomes 0 — the destination index of that page — and its `/St` becomes 2, the number the sheet actually carried. Left at 4 and 1, the first two sheets name no range at all and read `1, 2`.
- **`copy-subset-prefix`** — a `/P` prefix and a mid-range offset have to survive the move together: `/St 21` at a `/Start` of 0 prints A-21 on the wrong sheet, and `/Start 2` with `/St 1` prints nothing on any of them.
- **`copy-unknown-style`** — the range is `/S /G` with `/St 2` — a style the format does not define, which MuPDF, pypdf and this app answer three ways. A copy is not choosing between them: it writes the name it was given. `addPageLabels`, which is a user typing a style, still refuses one it cannot format.
- **`copy-unlabelled`** — the negative control: a document with no `/PageLabels` comes back with no `/PageLabels`. Every reader numbers it by position, so a copy that reported the numbering "preserved" here would have had to invent a dictionary first.
- **`merge-labelled-with-plain`** — a range runs to the end of the document unless another one starts, so the plain file’s sheets would otherwise continue `vii, viii, ix, x` in the middle of somebody else’s front matter. Writing their position out loud is what keeps them reading what a file with no numbering reads.
- **`merge-two-labelled`** — each file’s ranges are shifted to where its own sheets landed and concatenated, exactly as the bookmarks already are: the second file restarts its numbering instead of continuing the first’s, and neither overwrites the other.
- **`writer-after-copy`** — the answer to “do the label writers fight this”: no. `add-page-labels` replaces the dictionary — which is what its promise says it does, and its note already says a line runs to the next line or the end of the document — and it now replaces a numbering the copy carried instead of one it wrote itself.

## The disagreements, named instead of adjudicated

- **MuPDF escapes a non-ASCII `/P` prefix instead of printing it.** `copy-subset-prefix`'s sheet 1 is `§II` here and under pypdf, and `<A7>II` under MuPDF — and the *input* reads `<A7>I`, `§I` under pypdf. Same escaping on both sides of the copy, so nothing moved: what the verdict column flags is MuPDF's rendering of byte `A7`, not a different label. This is why the prefix is written single-byte where PDFDocEncoding can spell it (see `prefixString` in `core/bookmarks.ts`): MuPDF's page-label reader copies the string's bytes into the label without looking for the UTF-16BE BOM, so the BOM spelling comes back as `<FEFF00A7>`.
- **A range with `/P` and no `/S` carries no number.** §12.4.2 Table 160 makes /S optional, and `copy-prefix-only` measures it: both readers say `Cover ` on both sides, which is the shape `add-page-labels` itself writes for its `none` style. A copy that appended a number to those sheets would be adding content the file does not hold.
- **A style the format does not define.** `labels-nums-unknown-style.pdf` names `/S /G` with `/St 2`. MuPDF shows no label at all, pypdf counts from 1 and ignores `/St`, this app counts from `/St` in decimal — three answers, each the same before and after the copy. The copy writes the `/G` back verbatim, because a copy that rewrote it would be settling that argument.
- **`absent` and `''` are the same fact seen from two sides.** For `labels-absent.pdf` MuPDF answers `''` for every sheet, which is its way of saying "this sheet has no label"; pypdf and this app print the position, `1, 2, 3, 4`. Both columns are unchanged by the copy, and the store column says `absent → absent`: no dictionary was written for a file that had none.
- **A `/Kids` range past its own first page.** pypdf stops each range at its `/Start`, which is why the `before` column of the two `/Kids` fixtures reads `i, ii, I, 4, c, xA` there and `i, ii, I, II, c, xA` under MuPDF. Every *output* of this table is a flat `/Nums` tree, where all three agree — so the disagreement is confined to the before columns, and the after columns are the ones that say what the copy did.
- **MuPDF's binding cannot number a sheet before the first range** (it raises `IndexError`), and pypdf invents one: measured on a scratch file whose only range starts at page 3, MuPDF raised and pypdf answered `['cmxcix', '', 'i', '21']`. That is why no fixture here has that shape — an outside reader cannot adjudicate it, so it could not carry a row of this table.
