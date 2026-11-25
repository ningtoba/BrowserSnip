#!/usr/bin/env bash
# invert-colors audit: the sheets colour-measure.sh does not invert (the two whole-tone
# ends, the landscape-stored turn, the cropped sheet), the dpi control, the page picker,
# and the promises about metadata, annotations and selectable text.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2   # worktree root
D=${D:-/tmp/lane-edit/c6}
BASE=${BASE:-http://localhost:5291}
PDF=$D/colour.pdf
PORT=${PORT:-9975}
FAILED=0

run() { # run <tool> <label> <out> <fields> <pdf>
  PORT=$((PORT + 1))
  local tool=$1 label=$2 out=$3 fields=$4 pdf=${5:-$PDF}
  echo "--- run $tool [$fields]"
  BASE=$BASE TOOL=$tool LABEL="$label" PDF=$pdf OUT=$D/$out FIELDS="$fields" \
    RUN_TIMEOUT=240000 PORT=$PORT timeout 420 node docs/research/colour-rail.mjs \
    >$D/$out.rail.log 2>&1
  grep -E '^(fields|output|network|console errors)' -A2 $D/$out.rail.log | tr '\n' ' ' | cut -c1-260
  sed -n '/^report line/,/^Download/p' $D/$out.rail.log | tr '\n' ' ' | cut -c1-260; echo
}

check() { # check <want> <label> <args…>
  local want=$1 label=$2; shift 2
  if python3 docs/research/colour-ink.py --src "$PDF" --out-page 1 "$@" >$D/last-inv-check.txt 2>&1; then got=OK; else got=FAIL; fi
  echo "--- check [$label] → $got"
  sed -n '2,3p;/predicted (\|POLARITY\|VACUOUS\|mid tones\|^  - /p' $D/last-inv-check.txt | head -8
  [ "$got" = "$want" ] || { echo "   *** wanted $want"; FAILED=$((FAILED + 1)); }
}

# The two whole-tone sheets: a black sheet inverts to paper, a paper sheet to solid black.
run invert-colors Invert inv-p5.pdf "pages=5"
run invert-colors Invert inv-p6.pdf "pages=6"
# The other turn (stored landscape, displayed portrait) and the cropped sheet.
run invert-colors Invert inv-p7.pdf "pages=7"
run invert-colors Invert inv-p8.pdf "pages=8"
# The dpi control, at both ends of its own range.
run invert-colors Invert inv-dpi96.pdf  "dpi=96 pages=2"
run invert-colors Invert inv-dpi400.pdf "dpi=400 pages=2"
# The page picker, and what the output does with the pages it did not render.
run invert-colors Invert inv-range.pdf "pages=2-4"
# A real annotated file: the card promises links and annotations are NOT carried.
run invert-colors Invert inv-annot.pdf "pages=all" /tmp/triage/in/annot.pdf

echo
echo "═══ every region predicted through the CSS filter, on sheets the main rig skips"
check OK "p5 black sheet → paper"   --page 5 --out $D/inv-p5.pdf --ask invert=1 --solid
check OK "p6 paper sheet → black"   --page 6 --out $D/inv-p6.pdf --ask invert=1 --solid
check OK "p7 turn the other way"    --page 7 --out $D/inv-p7.pdf --ask invert=1 --polarity
check OK "p8 cropped sheet"         --page 8 --out $D/inv-p8.pdf --ask invert=1 --polarity
check OK "p2 at dpi 96"             --page 2 --out $D/inv-dpi96.pdf  --ask invert=1 --tol 10
check OK "p2 at dpi 400"            --page 2 --out $D/inv-dpi400.pdf --ask invert=1 --tol 6
check OK "range output 2 = sheet 3" --page 3 --out-page 2 --out $D/inv-range.pdf --ask invert=1 --solid
echo "invert-extra: $FAILED failed"
[ $FAILED -eq 0 ]
