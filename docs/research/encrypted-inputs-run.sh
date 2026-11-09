#!/usr/bin/env bash
# Re-measure the `encrypted-inputs` row, in the order the evidence needs.
#
#   1 fixtures   — qpdf and MuPDF lock one countable document; each file is
#                  verified by the tool that wrote it before this app sees it;
#   2 the rig    — the shipped runner, guard and pdf.js path answer 11 questions
#                  per document and dump every produced file;
#   3 the readers— MuPDF, qpdf, poppler, pypdf and Ghostscript judge those bytes;
#   4 the tables — the ledger's tables are rendered out of the two logs.
#
# Step 2 needs this repo's alias, React plugin and jsdom setup, so it runs on its
# own vitest config rather than CI's (`test.include` is `tests/**`, and this rig
# lives in docs/research). Nothing in `src/` is touched: this is an evidence pass.
#
#   docs/research/encrypted-inputs-run.sh [outdir]        # default /tmp/einp
set -euo pipefail

DIR="${1:-/tmp/einp}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
cd "$REPO"

mkdir -p "$DIR"
python3 "$HERE/encrypted-inputs-fixtures.py" "$DIR" > "$HERE/encrypted-inputs-fixtures.log"
echo "fixtures: $DIR ($(find "$DIR" -maxdepth 1 -name '*.pdf' | wc -l) files)"

rm -rf "$DIR/out"
ENCRYPTED_INPUTS_DIR="$DIR" npx vitest run \
  --config "$HERE/encrypted-inputs.vitest.config.ts" --disableConsoleIntercept \
  > "$HERE/encrypted-inputs-app.log"
echo "app probe: $(grep -c '^###' "$HERE/encrypted-inputs-app.log") documents, \
$(find "$DIR/out" -name '*.pdf' | wc -l) produced files"

python3 "$HERE/encrypted-inputs-readers.py" "$DIR" > "$HERE/encrypted-inputs-readers.log"
python3 "$HERE/encrypted-inputs-table.py" "$DIR" > "$HERE/encrypted-inputs-table.md"
# Tallied out of readers.json rather than grepped out of the log: a verdict word
# appears in the detail line, the summary line and the column header, and counting
# those as measurements is how a log starts lying.
python3 - "$DIR/readers.json" <<'PY'
import collections
import json
import sys

items = json.load(open(sys.argv[1], encoding="utf-8"))
produced = [item for item in items if item["file"].startswith("out/")]
inputs = [item for item in items if not item["file"].startswith("out/")]
kinds = collections.Counter(item["verdict"].split(":")[0] for item in produced)
input_kinds = collections.Counter(item["verdict"].split(":")[0] for item in inputs)
print(f"readers, {len(produced)} produced files: " + ", ".join(f"{count} {kind}" for kind, count in sorted(kinds.items())))
print(f"readers, {len(inputs)} input files (the fixtures and the controls): "
      + ", ".join(f"{count} {kind}" for kind, count in sorted(input_kinds.items())))
PY
echo "logs: $HERE/encrypted-inputs-{fixtures,app,readers}.log and -table.md"
