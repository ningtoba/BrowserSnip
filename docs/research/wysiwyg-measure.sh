#!/usr/bin/env bash
# One run of the WYSIWYG text-style proof, over every surface that sets type.
#
#   BASE=http://localhost:5281 OUTDIR=/tmp/wysiwyg/after  bash docs/research/wysiwyg-measure.sh
#   BASE=http://localhost:5282 OUTDIR=/tmp/wysiwyg/before bash docs/research/wysiwyg-measure.sh
#
# Four surfaces are editors — the annotation editor's text box, stamp and note, and
# the in-place text editor — and are driven by `wysiwyg-rig.mjs`. Four are rail forms
# — header/footer, page numbers, watermark, add-stamps — and are driven by
# `colour-rail.mjs`, the campaign's own rail probe, so the rail half of this proof uses
# the same code path the colour and deskew rows used: open the collapsed options, write
# each control the way a user's event reaches React, read it back out of the DOM, run.
#
# Neither probe decides whether the style worked. Both leave files in $OUTDIR and take
# their screenshots; `wysiwyg-bytes.py` reads the answers out of the bytes and exits 1
# when a produced file contradicts what its surface claimed.
set -uo pipefail

BASE=${BASE:-http://localhost:5281}
OUTDIR=${OUTDIR:-/tmp/wysiwyg/after}
PDF=${PDF:-/tmp/sample.pdf}
# The rail's action button is matched by the words on it (`colour-rail.mjs`'s LABEL).
SHOTS=${SHOTS:-docs/research/shots}
PORT=${PORT:-9731}

mkdir -p "$OUTDIR" "$SHOTS"
# A stale file from an earlier run reads like a success: the first version of this
# script measured yesterday's watermark output and called it page numbers.
rm -f "$OUTDIR"/*.pdf "$OUTDIR"/*.json
[ -f "$PDF" ] || { echo "no fixture at $PDF (see docs/research/text-edit-fixture.py)"; exit 2; }

echo "### editors on $BASE"
BASE="$BASE" OUTDIR="$OUTDIR" PDF="$PDF" SHOTS="$SHOTS" node docs/research/wysiwyg-rig.mjs \
  >"$OUTDIR/editors.log" 2>&1 || echo "  (rig exited $?)"

# Each row: out-name | tool id | the words on its run button | the values to write,
# by the rail's own field keys. The labels are the tool's `actionLabel`, because that
# is what a person reads and clicks.
echo "### rail forms on $BASE"
rail() {
  local name="$1" tool="$2" label="$3" fields="$4"
  BASE="$BASE" TOOL="$tool" LABEL="$label" PDF="$PDF" OUT="$OUTDIR/$name.pdf" FIELDS="$fields" \
    PORT="$PORT" node docs/research/colour-rail.mjs >"$OUTDIR/$name.log" 2>&1
  local code=$?
  local read
  read=$(grep -o '"after":"[^"]*"' "$OUTDIR/$name.log" | head -6 | tr '\n' ' ')
  printf '  %-13s exit=%s  %s\n' "$name" "$code" "${read:0:150}"
  PORT=$((PORT + 1))
}

rail headerfooter header-footer 'Add header and footer' 'headerLeft=Quarterly font=std:times bold=1 fontSize=16 color=#0000ff'
rail pagenumbers   page-numbers  'Add numbers'           'font=std:times italic=1 fontSize=22 color=#ff0000 prefix=Page suffix=of1'
rail watermark     watermark     'Add watermark'         'text=Draft font=std:courier bold=1 fontSize=48 color=#008000 opacity=1'
# `add-stamps` mounts the page editor as its *surface*, so the button that runs it is
# the surface's own "Stamp" control rather than the rail's action button.
rail addstamps     add-stamps    'Stamp'                 'stamp=APPROVED font=std:times italic=1 fontSize=18 color=#8B5CF6 opacity=1'

echo
echo "### bytes"
python3 docs/research/wysiwyg-bytes.py "$OUTDIR" --source "$PDF"
