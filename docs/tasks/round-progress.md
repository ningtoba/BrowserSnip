# Round progress — every PDF id, catalogue order

Resume state: rounds 001-007 done and verified (each commit re-run by the parent:
tsc, typecheck:tests, full suite). Continue at the first `[ ]` — but not past a `[ ]` before a `[x]`: 026 `sanitize-pdf`
was skipped when the dispatcher lost the file's order and must be taken before 028
(025 `repair` is done, re-settled out of order at round 025).

One line per tool. `[ ]` queued, `[x]` round done (see the row in `docs/TOOL-CAMPAIGN.md`).

```text
001 [x] merge
002 [x] split
003 [x] extract-pages
004 [x] remove-pages
005 [x] organize
006 [x] rotate
007 [x] rotate-custom
008 [x] reverse-pages
009 [x] add-blank-page
010 [x] alternate-merge
011 [x] duplex-collate
012 [x] overlay-pdf
013 [x] n-up
014 [x] booklet
015 [x] combine-single-page
016 [x] posterize
017 [x] divide-pages
018 [x] fix-page-size
019 [x] remove-blank-pages
020 [x] pdfs-to-zip
021 [x] pdf-to-cbz
022 [x] pdf-compress
023 [x] optimize-pdf
024 [x] rasterize-pdf
025 [x] repair
026 [x] sanitize-pdf
027 [x] linearize-pdf
028 [x] pdf-to-pdfa
029 [x] font-to-outline
030 [x] deskew-pdf
031 [x] edit-pdf
032 [x] edit-pdf-text
033 [x] page-numbers
034 [x] watermark
035 [x] header-footer
036 [x] bates-numbering
037 [x] add-page-labels
038 [x] bookmarks
039 [x] table-of-contents
040 [x] add-stamps
041 [x] background-color
042 [x] text-color
043 [x] invert-colors
044 [x] adjust-colors
045 [x] scanner-effect
046 [x] ocr-pdf
047 [x] form-filler
048 [x] form-creator
049 [x] pdf-layers
050 [ ] remove-annotations
051 [ ] protect
052 [ ] unlock
053 [ ] change-permissions
054 [ ] remove-restrictions
055 [ ] flatten-pdf
056 [ ] redact-pdf
057 [ ] compare-pdfs
058 [ ] view-metadata
059 [ ] edit-metadata
060 [ ] remove-metadata
061 [ ] add-attachments
062 [ ] extract-attachments
063 [ ] edit-attachments
064 [ ] digital-sign-pdf
065 [ ] validate-signature-pdf
066 [ ] timestamp-pdf
067 [ ] image-to-pdf
068 [ ] jpg-to-pdf
069 [ ] png-to-pdf
070 [ ] webp-to-pdf
071 [ ] heic-to-pdf
072 [ ] bmp-to-pdf
073 [ ] tiff-to-pdf
074 [ ] psd-to-pdf
075 [ ] svg-to-pdf
076 [ ] cbz-to-pdf
077 [ ] txt-to-pdf
078 [ ] markdown-to-pdf
079 [ ] html-to-pdf
080 [ ] csv-to-pdf
081 [ ] json-to-pdf
082 [ ] xml-to-pdf
083 [ ] rtf-to-pdf
084 [ ] word-to-pdf
085 [ ] excel-to-pdf
086 [ ] powerpoint-to-pdf
087 [ ] epub-to-pdf
088 [ ] email-to-pdf
089 [ ] digitize-document
090 [ ] pdf-to-text
091 [ ] pdf-to-markdown
092 [ ] pdf-to-json
093 [ ] prepare-pdf-for-ai
094 [ ] pdf-to-csv
095 [ ] extract-tables
096 [ ] pdf-to-excel
097 [ ] pdf-to-word
098 [ ] pdf-to-svg
099 [ ] extract-images
100 [ ] pdf-to-image
101 [ ] pdf-to-png
102 [ ] pdf-to-jpg
103 [ ] pdf-to-webp
104 [ ] pdf-to-bmp
105 [ ] pdf-to-tiff
106 [ ] pdf-to-greyscale
107 [ ] page-dimensions
108 [ ] odt-to-pdf
109 [ ] ods-to-pdf
110 [ ] odp-to-pdf
111 [ ] xps-to-pdf
112 [ ] fb2-to-pdf
113 [ ] mobi-to-pdf
114 [ ] pages-to-pdf
115 [ ] pub-to-pdf
116 [ ] vsd-to-pdf
117 [ ] wpd-to-pdf
118 [ ] wps-to-pdf
119 [ ] odg-to-pdf
120 [ ] sign
121 [ ] pdf-crop
122 [ ] scan-to-pdf
```text
