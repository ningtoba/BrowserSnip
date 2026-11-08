#!/usr/bin/env bash
# compare-pdfs measurement — the verdict the pane publishes and the file it exports,
# both read out of a planted difference at a known place.
#
#   BASE=http://localhost:5291        bash docs/research/compare-measure.sh
#   BASE=https://www.browsersnip.com  bash docs/research/compare-measure.sh
#
# The tool gives two answers, and the campaign row had to say which is which: the
# strip above the pages (computed by `CompareMain`, which awaits `page.render()`) and
# the downloaded PDF (written by `pdf-engine/commands.ts` `comparePDFs`, which did
# not). This script drives both from one run, and asserts *where* each says the
# change is — `docs/research/compare-fixture.mjs` plants one solid 340×40 pt block at
# 40,60 on sheet 1 of a three-sheet pair whose sheets 2 and 3 are identical, so:
#
#   · the positive control is a coordinate, not a feeling: sheet 1 must come back
#     40,60 → 380,100 in the verdict and in the exported overlay;
#   · the negative controls are A-against-A and the blank sheet, which must report
#     *no* difference **with the page still inked** — a tool that says "everything
#     differs" is as wrong as one that says "nothing differs", and a fix that only
#     swaps which of the two it gets wrong is not a fix;
#   · the last block runs the same assertions against files that must NOT satisfy
#     them, and says `CONTROL BROKEN` if one does.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2

BASE=${BASE:-http://localhost:5291}
DIR=${DIR:-/tmp/compare}
PORT=${PORT:-9860}
RECT=${RECT:-40,60,380,100}
TOL=${TOL:-2}
FAILED=0
CONTROLS_BROKEN=0

mkdir -p "$DIR"
node docs/research/compare-fixture.mjs --dir "$DIR" || exit 2

# run <name> <case> <page> [SHOT=…]
run() {
  local name=$1 case=$2 page=$3
  shift 3
  PORT=$((PORT + 1))
  echo "--- run $name (case=$case page=$page)"
  BASE=$BASE DIR=$DIR CASE=$case PAGE=$page VERDICT=$DIR/$name.json \
    OUT=$DIR/$name.pdf PORT=$PORT "$@" \
    timeout 900 node docs/research/compare-rail.mjs 2>&1 \
    | grep -E '^(verdict|export|warm|console errors|screenshot|NO OUTPUT)' \
    | cut -c1-420
}

# check <OK|FAIL> <label> <compare-measure args…>
check() {
  local want=$1 label=$2; shift 2
  echo "--- check [$label]"
  if python3 docs/research/compare-measure.py --tol "$TOL" "$@" > "$DIR/last-check.txt" 2>&1; then got=OK; else got=FAIL; fi
  sed -n '1p;/verdict:/p;/^   /p;/^   FAIL/p' "$DIR/last-check.txt" | sed -n '1,12p'
  if [ "$got" != "$want" ]; then
    if [ "${CONTROL:-}" = "1" ]; then
      echo "   *** CONTROL BROKEN: [$label] passed on a file that must fail it"
      CONTROLS_BROKEN=$((CONTROLS_BROKEN + 1))
    else
      echo "   *** FAILED: wanted $want, got $got"
      FAILED=$((FAILED + 1))
    fi
  fi
}

# ── the runs ─────────────────────────────────────────────────────────────────
# The pair, read on the page the difference was planted on. `pair-warm` turns to
# page 2 and back first, which is how the deployed pre-fix build was made to show
# its two paths disagreeing: the page-turn repaints and measures 13,600 changed
# pixels while the card beside it stays on 0 %.
run pair-cold  pair  1
run pair-warm  pair  1 WARM=1
run pair-page2 pair  2
run pair-page3 pair  3
run same       same  1
run blanks     blank 1

echo
echo "═══ the exported file: the difference, marked where it was planted"
check OK "pair, sheet 1 — verdict and bytes, both localised" \
  --src "$DIR/a.pdf" --out "$DIR/pair-cold.pdf" --page 1 --rect "$RECT" \
  --verdict "$DIR/pair-cold.json" --label "export p1"
check OK "pair, sheet 1 after a page turn — the same marks" \
  --src "$DIR/a.pdf" --out "$DIR/pair-warm.pdf" --page 1 --rect "$RECT" \
  --verdict "$DIR/pair-warm.json" --label "export p1 (warm)"
# A page both files carry unchanged still has to be the page, and still has to be
# unmarked: this is the half that catches a tool that paints the whole document.
check OK "pair, sheet 2 — no marks, all of its own ink" \
  --src "$DIR/a.pdf" --out "$DIR/pair-cold.pdf" --page 2 --no-rect \
  --verdict "$DIR/pair-page2.json" --label "export p2"
# The empty sheet: no marks, and nothing invented on it either.
check OK "pair, sheet 3 — blank against blank is not a difference" \
  --src "$DIR/a.pdf" --out "$DIR/pair-cold.pdf" --page 3 --no-rect --blank \
  --verdict "$DIR/pair-page3.json" --label "export p3"
check OK "A against A — no marks anywhere, and the page is still inked" \
  --src "$DIR/a.pdf" --out "$DIR/same.pdf" --page 1 --no-rect \
  --verdict "$DIR/same.json" --label "A vs A p1"
check OK "blank against blank — empty, and called empty" \
  --src "$DIR/blank.pdf" --out "$DIR/blanks.pdf" --page 1 --no-rect --blank \
  --verdict "$DIR/blanks.json" --label "blank pair p1"

echo
echo "═══ controls: the same assertions must FAIL on files that earned them"
CONTROL=1 check FAIL "a mark asked for on the unchanged sheet" \
  --src "$DIR/a.pdf" --out "$DIR/pair-cold.pdf" --page 2 --rect "$RECT" --label "CONTROL: p2, asked to be marked"
CONTROL=1 check FAIL "a mark asked for on a pair that is the same file" \
  --src "$DIR/a.pdf" --out "$DIR/same.pdf" --page 1 --rect "$RECT" --label "CONTROL: A vs A, asked to be marked"
CONTROL=1 check FAIL "no-mark asked for on the sheet that really changed" \
  --src "$DIR/a.pdf" --out "$DIR/pair-cold.pdf" --page 1 --no-rect --label "CONTROL: p1, asked to be clean"
CONTROL=1 check FAIL "ink asked for from a blank sheet" \
  --src "$DIR/a.pdf" --out "$DIR/pair-cold.pdf" --page 3 --min-ink-frac 1.5 --label "CONTROL: blank sheet, asked for ink"

echo
if [ $FAILED -eq 0 ] && [ $CONTROLS_BROKEN -eq 0 ]; then
  echo "compare-measure: every case measured as asked, and every control failed as asked."
  exit 0
fi
echo "compare-measure: $FAILED case(s) failed, $CONTROLS_BROKEN control(s) did not fail."
exit 1
