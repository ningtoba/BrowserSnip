#!/bin/bash
# rotate — the byte half of the round: every angle and every selection the rail can
# express, driven through real Chromium on the dev server, one case per process so a
# refusal cannot poison the next run. Each case writes a download into $BYTES/<dir>
# and a log into $LOGS, and every field is written as a user event and read back out
# of the DOM before the click (that read-back is what proves `Rotation=4` never
# reaches a segmented control and the run went ahead on 90).
#
#   BASE=http://localhost:5292 PORT=9842 \
#     BYTES=/tmp/rb LOGS=/tmp/rb/logs bash docs/research/rotate-round.sh
#
# Judge the downloads with `docs/research/rotate-round-bytes.py` (its EXPECT table is
# this script's case list), and the pane — the angle the strip announces — with
# `docs/research/rotate-pane.mjs`. `docs/research/net-check.mjs` covers the network
# half; the campaign's own record of this round is
# `docs/research/rotate-round-{bytes,pane,net}.log`.
cd "${REPO:-.}" || exit 1
: "${BASE:=http://localhost:5292}"
: "${PORT:=9842}"
: "${BYTES:=/tmp/rb}"
: "${LOGS:=$BYTES/logs}"
mkdir -p "$LOGS" "$BYTES/colour" "$BYTES/annot" "$BYTES/rot90"
CO=${CO:-/tmp/triage/colour.pdf}
AN=${AN:-/tmp/triage/in/annot.pdf}
R9=${R9:-/tmp/triage/rot90.pdf}

run() { # name pdf fields outdir [shot]
  local name=$1 pdf=$2 fields=$3 dir=$4 shot=$5
  local -a envs=(PORT="$PORT" BASE="$BASE" "PDF=$pdf" "OUT=$dir/$name.pdf" 'LABEL=^Rotate$' TOOL=rotate)
  [ -n "$fields" ] && envs+=("FIELDS=$fields")
  [ -n "$shot" ] && envs+=("SHOT=$shot")
  echo "=== $name [$fields]"
  env "${envs[@]}" node docs/research/colour-rail.mjs >"$LOGS/$name.log" 2>&1
  echo "rc=$?"
  grep -E '"label"|^fields:|output |report line|^NO OUTPUT|^screen says|^network:' "$LOGS/$name.log" | head -12
  sleep 1
}

run r90all  "$CO" 'pages=all'                "$BYTES/colour"
run r180all "$CO" 'Rotation=180 pages=all'   "$BYTES/colour"
run r270all "$CO" 'Rotation=270 pages=all'   "$BYTES/colour"
run r90p4   "$CO" 'Rotation=90 pages=4'      "$BYTES/colour"
run r180p4  "$CO" 'Rotation=180 pages=4'     "$BYTES/colour"
run r270p4  "$CO" 'Rotation=270 pages=4'     "$BYTES/colour"
run r270p7  "$CO" 'Rotation=270 pages=7'     "$BYTES/colour"
run r90p8   "$CO" 'Rotation=90 pages=8'      "$BYTES/colour"
run r90list "$CO" 'Rotation=90 pages=1,3,6'  "$BYTES/colour"
run r180rng "$CO" 'Rotation=180 pages=2-4'   "$BYTES/colour"
run r90odd  "$CO" 'Rotation=90 pages=odd'    "$BYTES/colour"
run r270evn "$CO" 'Rotation=270 pages=even'  "$BYTES/colour"
run r4chip  "$CO" 'Rotation=4 pages=all'     "$BYTES/colour"
run r360    "$CO" 'Rotation=360 pages=all'   "$BYTES/colour"
run roob    "$CO" 'Rotation=90 pages=99'     "$BYTES/colour" "$LOGS/roob.png"
run rnone   "$CO" 'Rotation=90 pages=none'   "$BYTES/colour" "$LOGS/rnone.png"
run a90p1   "$AN" 'Rotation=90 pages=1'      "$BYTES/annot"
run a270p1  "$AN" 'Rotation=270 pages=1'     "$BYTES/annot"
run a90all  "$AN" 'Rotation=90 pages=all'    "$BYTES/annot"
run z90all  "$R9" 'Rotation=90 pages=all'    "$BYTES/rot90"
# The two straighten runs, again: the card sentence is the only thing that differs
# between the before and after copies of these files.
run r270p7-afterfix  "$CO" 'Rotation=270 pages=7'   "$BYTES/colour"
run r270p47-afterfix "$CO" 'Rotation=270 pages=4,7' "$BYTES/colour"
echo ALL DONE
