#!/usr/bin/env bash
# Colour-tool measurement — the four consumers of `RenderOptions.filter`, in real
# Chromium, measured out of the downloaded file.
#
#   BASE=http://localhost:5291        bash docs/research/colour-measure.sh
#   BASE=https://www.browsersnip.com  bash docs/research/colour-measure.sh
#
# Every case writes the rail's own fields (so `brightness=1.6` is a number the app
# held, read back off the DOM, not an assumption), downloads the result and measures
# it per region against the source sheet's own colour pushed through the CSS filter
# formula. `--ask` prints the distance from three predictions at once: the ask, doing
# nothing, and the ask backwards — a control that moved the wrong way scores as well
# as one that worked under a test that only compares before with after.
#
# The last block is the point of the whole script: the same assertions, run against
# files that should NOT satisfy them. A polarity check that passes on a plain
# rasterisation, or a brightness check that passes on a page where brightness was
# never set, is measuring nothing.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2

BASE=${BASE:-http://localhost:5291}
DIR=${DIR:-/tmp/colour}
PDF=$DIR/colour.pdf
PORT=${PORT:-9870}
FAILED=0
CONTROLS_BROKEN=0

mkdir -p "$DIR"
node docs/research/colour-fixture.mjs --dir "$DIR" || exit 2

# run <tool> <button label> <out name> <fields>
run() {
  local tool=$1 label=$2 out=$3 fields=$4
  PORT=$((PORT + 1))
  echo "--- run $tool ${fields:+[$fields]}"
  BASE=$BASE TOOL=$tool LABEL="$label" PDF=$PDF OUT=$DIR/$out FIELDS="$fields" PORT=$PORT \
    timeout 600 node docs/research/colour-rail.mjs 2>&1 | grep -E '^(fields|output|report line|console errors)'
}

# check <expect-pass> <label> <colour-ink args…>
#
# Every run above selects exactly one page (`pages=N`), so the produced file holds
# one sheet however many the source has; the reader is always pointed at it.
check() {
  local want=$1 label=$2; shift 2
  echo "--- check [$label]"
  if python3 docs/research/colour-ink.py --src "$PDF" --out-page 1 "$@" > "$DIR/last-check.txt" 2>&1; then got=OK; else got=FAIL; fi
  sed -n '2,3p;/POLARITY\|BILEVEL\|ACHROMATIC\|VACUOUS\|vs plain\|same as\|predicted (\|^  - /p' "$DIR/last-check.txt"
  if [ "$want" = OPEN ]; then
    # A defect this campaign measured in a file it does not own. Its failure is the
    # expected result; the line that prints when it passes is the point, because a
    # ledger row cannot quietly stay open after somebody awaits the paint under it.
    if [ "$got" = OK ]; then
      echo "   *** THIS OPEN CASE NOW PASSES: the row that records it can be closed"
      FAILED=$((FAILED + 1))
    else
      echo "   (open, as its ledger row records — not this campaign's file)"
    fi
    return
  fi
  if [ "$got" != "$want" ]; then
    if [ "${CONTROL:-}" = "1" ]; then
      echo "   *** CONTROL BROKEN: the [$label] assertions passed on a file that must fail them"
      CONTROLS_BROKEN=$((CONTROLS_BROKEN + 1))
    else
      echo "   *** FAILED: wanted $want, got $got"
      FAILED=$((FAILED + 1))
    fi
  fi
}

INVERT_PAGE=1
COLOUR_PAGE=2
EMPTY_PAGE=3
TURNED_PAGE=4

run invert-colors Invert post-invert-p1.pdf "pages=$INVERT_PAGE"
run invert-colors Invert post-invert-p2.pdf "pages=$COLOUR_PAGE"
run invert-colors Invert post-invert-p3.pdf "pages=$EMPTY_PAGE"
run adjust-colors 'Adjust colors' post-adjust-identity.pdf "pages=$COLOUR_PAGE"
run adjust-colors 'Adjust colors' post-adjust-bright.pdf "brightness=1.6 pages=$COLOUR_PAGE"
run adjust-colors 'Adjust colors' post-adjust-contrast.pdf "contrast=2 pages=$COLOUR_PAGE"
run adjust-colors 'Adjust colors' post-adjust-sat.pdf "saturation=0 pages=$COLOUR_PAGE"
run adjust-colors 'Adjust colors' post-adjust-hue.pdf "hue=180 pages=$COLOUR_PAGE"
run adjust-colors 'Adjust colors' post-adjust-gray.pdf "grayscale=1 pages=$COLOUR_PAGE"
run adjust-colors 'Adjust colors' post-adjust-thresh.pdf "threshold=0.5 pages=$INVERT_PAGE"
run scanner-effect 'Apply scan effect' post-scanner-p1.pdf "pages=$INVERT_PAGE"
run scanner-effect 'Apply scan effect' post-scanner-p2.pdf "pages=$COLOUR_PAGE"
run scanner-effect 'Apply scan effect' post-scanner-flat.pdf "whitening=0 sharpen=0 grayscale=0 contrast=1 pages=$INVERT_PAGE"
run invert-colors Invert post-invert-p4.pdf "pages=$TURNED_PAGE"
run adjust-colors 'Adjust colors' post-adjust-identity-p4.pdf "pages=$TURNED_PAGE"
# `rasterize-pdf` has no page picker, so these baselines hold all three sheets and
# the checks name the index they read.
run rasterize-pdf Rasterize post-plain-p1.pdf ""
run rasterize-pdf Rasterize post-plain-p2.pdf ""
# The fourth consumer of `RenderOptions.filter`: its raster method is a segment the
# default-clicking probe cannot reach, so this one clicks it.
run pdf-to-greyscale 'Convert to greyscale' post-greyscale-raster.pdf "mode=Re-render pages=$COLOUR_PAGE"

echo
echo "═══ invert-colors: polarity, per region, and the sheet that has no ink to swap"
check OK "invert p1" --page $INVERT_PAGE --out $DIR/post-invert-p1.pdf --ask invert=1 --polarity \
  --label "invert-colors p1: the bar is ink and the band is paper"
check OK "invert p2" --page $COLOUR_PAGE --out $DIR/post-invert-p2.pdf --ask invert=1 \
  --label "invert-colors p2: colour inverts too"
check OK "invert p3" --page $EMPTY_PAGE --out $DIR/post-invert-p3.pdf --ask invert=1 \
  --label "invert-colors p3: an empty sheet becomes solid dark paper, inventing nothing"

echo
echo "═══ adjust-colors: every control the rail offers, measured where it must move"
check OK "identity" --page $COLOUR_PAGE --out $DIR/post-adjust-identity.pdf \
  --same-as $DIR/post-plain-p2.pdf --base-page $COLOUR_PAGE \
  --label "adjust-colors at defaults = a plain rasterisation"
for ask in brightness=1.6 contrast=2 saturation=0 hue=180 grayscale=1; do
  name=post-adjust-${ask%%=*}
  case $ask in
    brightness*) name=post-adjust-bright.pdf ;;
    contrast*) name=post-adjust-contrast.pdf ;;
    saturation*) name=post-adjust-sat.pdf ;;
    hue*) name=post-adjust-hue.pdf ;;
    grayscale*) name=post-adjust-gray.pdf ;;
  esac
  check OK "$ask" --page $COLOUR_PAGE --out $DIR/$name --ask "$ask" --label "adjust-colors $ask"
done
check OK "threshold" --page $INVERT_PAGE --out $DIR/post-adjust-thresh.pdf --bilevel \
  --label "adjust-colors threshold=0.5: a real cutoff"
check OK "grayscale wins" --page $COLOUR_PAGE --out $DIR/post-adjust-gray.pdf --achromatic \
  --label "adjust-colors grayscale: the switch the help line promises"

echo
echo "═══ scanner-effect: distinguishable from a plain rasterisation, on both sheets"
check OK "scanner p1" --page $INVERT_PAGE --out $DIR/post-scanner-p1.pdf \
  --ask contrast=1.35,grayscale=1,whitening=1 --not-plain $DIR/post-plain-p1.pdf --base-page 1 \
  --label "scanner-effect p1 vs rasterize-pdf p1"
check OK "scanner p2" --page $COLOUR_PAGE --out $DIR/post-scanner-p2.pdf \
  --ask contrast=1.35,grayscale=1,whitening=1 --achromatic --not-plain $DIR/post-plain-p2.pdf \
  --base-page $COLOUR_PAGE --label "scanner-effect p2 vs rasterize-pdf p2"
check OK "passes off = a plain rasterisation" --page $INVERT_PAGE --out $DIR/post-scanner-flat.pdf \
  --same-as $DIR/post-plain-p1.pdf --base-page 1 --label "scanner-effect with every pass off"
check OK "the passes move the file" --page $INVERT_PAGE --out $DIR/post-scanner-p1.pdf \
  --not-plain $DIR/post-scanner-flat.pdf --label "scanner-effect defaults against the same run with whitening, sharpen, greyscale and contrast off"

echo
echo "═══ controls: the same assertions must FAIL on files that earned them"
CONTROL=1 check FAIL "invert polarity on a plain page" --page $INVERT_PAGE \
  --out $DIR/post-plain-p1.pdf --polarity --label "CONTROL: plain rasterisation, asked to be a negative"
CONTROL=1 check FAIL "brightness=1.6 on a page that never asked for it" --page $COLOUR_PAGE \
  --out $DIR/post-adjust-identity.pdf --ask brightness=1.6 \
  --label "CONTROL: identity file, asked to be brighter"
CONTROL=1 check FAIL "contrast=2 the other way round" --page $COLOUR_PAGE \
  --out $DIR/post-adjust-contrast.pdf --ask contrast=0.5 \
  --label "CONTROL: the contrast=2 file, asked to have been flattened"
CONTROL=1 check FAIL "threshold on an unthresholded page" --page $INVERT_PAGE \
  --out $DIR/post-plain-p1.pdf --bilevel --label "CONTROL: plain rasterisation, asked to be bilevel"
CONTROL=1 check FAIL "the effect on itself" --page $COLOUR_PAGE \
  --out $DIR/post-scanner-p2.pdf --not-plain $DIR/post-scanner-p2.pdf \
  --label "CONTROL: scanner output compared with itself"
CONTROL=1 check FAIL "polarity on a turned sheet that was not inverted" --page $TURNED_PAGE \
  --out $DIR/post-plain-p1.pdf --out-page $TURNED_PAGE --polarity \
  --label "CONTROL: rasterize-pdf of the /Rotate 90 sheet, asked to be a negative"

echo
echo "═══ the fourth consumer of RenderOptions.filter, reached through another helper"
# `pdf-to-greyscale` with Method = Re-render goes through `core/measure.ts`'s
# `applyColorFilter`, which reads the canvas without awaiting `finished`. The segment
# is clicked here and read back out of `aria-pressed`, so "reached, not yet driven" is
# no longer an excuse for not knowing its number: it is paper, 0 non-white px, where
# its own source sheet measures 19.50 %.
check OPEN "greyscale re-render (core/measure.ts owns the await)" --page $COLOUR_PAGE \
  --out $DIR/post-greyscale-raster.pdf --ask grayscale=1 --inked \
  --label "pdf-to-greyscale, Method = Re-render"

echo
echo "═══ the turned sheet: the same displayed regions on a page carrying /Rotate 90"
# A raster colour tool photographs the page *as displayed*, and the fixture's fractions are
# displayed fractions, so this case is what says the checker and the tool agree about which
# feature is which. Sheet 4 stores a portrait box, displays landscape, and its ink was placed
# through the turn — an un-inverted mapping would read paper where the bar should be, and the
# box check below is the tool's half of the same claim.
check OK "identity on a turned sheet" --page $TURNED_PAGE --out $DIR/post-adjust-identity-p4.pdf \
  --same-as $DIR/post-plain-p1.pdf --base-page $TURNED_PAGE \
  --label "adjust-colors at defaults, /Rotate 90"
check OK "invert on a turned sheet" --page $TURNED_PAGE --out $DIR/post-invert-p4.pdf \
  --ask invert=1 --polarity --label "invert-colors, /Rotate 90"

echo
if [ $FAILED -eq 0 ] && [ $CONTROLS_BROKEN -eq 0 ]; then
  echo "colour-measure: every case measured as asked, and every control failed as asked."
  exit 0
fi
echo "colour-measure: $FAILED case(s) failed, $CONTROLS_BROKEN control(s) did not fail."
exit 1
