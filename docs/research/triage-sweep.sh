#!/usr/bin/env bash
# Whole-catalogue triage sweep — the thin orchestration half of `docs/TOOL-TRIAGE.md`.
#
#   BASE=https://www.browsersnip.com PHASE=base  node_only=… bash docs/research/triage-sweep.sh
#   BASE=https://www.browsersnip.com PHASE=flips bash docs/research/triage-sweep.sh
#
# It decides nothing and measures nothing: the driving lives in `colour-rail.mjs`
# (the same probe `colour-measure.sh` calls for the four colour tools) and the
# measuring lives in `rail-measure.py --triage`. This file only keeps the three
# steps in order — fixtures, spec, runs, measurement — and appends each batch to
# the JSONL so a sweep that dies half way leaves the finished half on disk.
#
#   PHASE=base    one run per tool, with the rail's own default field values
#   PHASE=flips   one extra run per field, that field's value changed and nothing else
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2

BASE=${BASE:-https://www.browsersnip.com}
DIR=${DIR:-/tmp/triage}
PHASE=${PHASE:-base}
PORT=${PORT:-9870}
OUTDIR=$DIR/out
RUNS=$DIR/runs-$PHASE.jsonl
MEASURED=$DIR/measured-$PHASE.jsonl
ONLY=${node_only:-}

mkdir -p "$OUTDIR"

node docs/research/triage-spec.mjs --dir "$DIR" || exit 2
[ "$PHASE" = flips ] && node docs/research/triage-spec.mjs --dir "$DIR" --flips || true

if [ ! -f "$DIR/spec.json" ]; then
  echo "no spec.json in $DIR"; exit 2
fi

echo "sweep: BASE=$BASE PHASE=$PHASE runs→$RUNS port=$PORT"
BASE=$BASE SPEC=$DIR/spec.json OUTDIR=$OUTDIR JSONL=$RUNS PORT=$PORT ONLY=$ONLY \
  timeout "${SWEEP_TIMEOUT:-14400}" node docs/research/colour-rail.mjs
status=$?
echo "sweep exit=$status"

python3 docs/research/rail-measure.py --triage "$RUNS" --fixtures "$DIR" --write "$MEASURED" || exit 2
wc -l "$RUNS" "$MEASURED"
