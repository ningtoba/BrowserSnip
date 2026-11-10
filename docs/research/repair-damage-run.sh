#!/usr/bin/env bash
# Re-measure the `repair` damage corpus, in the order the evidence needs.
#
#   1 corpus    — one known-good 4-sheet document, damaged one structural way at a
#                 time (`tests/pdf/repair-damage-corpus.ts`, written to disk by
#                 `repair-damage-corpus.mjs`);
#   2 the app   — the shipped `repair` tool over every case, its sentence and its
#                 warnings recorded, every produced file dumped to `<dir>/out/`;
#   3 outsiders— MuPDF, qpdf, poppler, pypdf and Ghostscript judge the input and the
#                 output: pages, ink per sheet, extracted words;
#   4 our own  — pdf.js, the engine the app renders with, reads the same two files.
#
# Step 2 imports `src/`, so it runs the tool rather than a re-implementation of it.
# Nothing in `src/` is changed by this script: it is an evidence pass. Step 2 also
# needs the repo's `@` alias for its probe, which is why the bundle is built here.
#
#   docs/research/repair-damage-run.sh [outdir]      # default /tmp/rd
set -euo pipefail

DIR="${1:-/tmp/rd}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
cd "$REPO"

mkdir -p "$DIR"
rm -rf "$DIR/corpus" "$DIR/out"

node docs/research/repair-damage-corpus.mjs --dir "$DIR"
node docs/research/repair-damage-measure.mjs --dir "$DIR" | tee "$HERE/repair-damage-app.log"
python3 docs/research/repair-damage-readers.py "$DIR" | tee "$HERE/repair-damage-readers.log"
node docs/research/repair-damage-pdfjs.mjs "$DIR" | tee "$HERE/repair-damage-pdfjs.log"

echo
echo "logs: docs/research/repair-damage-{app,readers,pdfjs}.log — files kept in $DIR"
