#!/usr/bin/env bash
# VERIFICATION HARNESS - the whole matrix against ONE tree.
#
#   REPO=/root/muxterm-base  TAG=base  bash tools/cos-repro/matrix.sh
#   REPO=/root/muxterm-fixed TAG=fixed bash tools/cos-repro/matrix.sh
#   ONLY=histcap REPO=... TAG=... bash tools/cos-repro/matrix.sh   # one cell
#
# One server per run: a fresh server per scenario is what keeps a 4MB run from
# poisoning the next one's subscriber queue. Artifacts land in
# $ROOT/<TAG>/<id>/, which is what report.py reads.
set -uo pipefail

REPO=${REPO:-$PWD}
TAG=${TAG:-$(basename "$REPO")}
ROOT=${ROOT:-/tmp/cos-repro}/$TAG
ONLY=${ONLY:-}
mkdir -p "$ROOT"

# id | mode | timeout_ms | settle_ms | prompt
CASES=(
  "stream|plain|120000|30000|s6-stream"
  "nostream|plain|120000|30000|s6-nostream"
  "big|plain|600000|300000|s6-stream size:4194304"
  "empty|plain|120000|30000|s6-empty"
  "histcap|s1|120000|30000|s6-histcap slow"
  "s1|s1|120000|30000|s6-stream slow"
  "s3|s3|120000|30000|s6-stream slow"
  "s4|s4|120000|30000|s6-stream slow"
  "s5|s5|120000|30000|s6-stream slow"
)

for c in "${CASES[@]}"; do
  IFS='|' read -r id mode tmo settle prompt <<< "$c"
  [ -n "$ONLY" ] && [ "$ONLY" != "$id" ] && continue
  out="$ROOT/$id"
  rm -rf "$out"
  printf '\n\n########## %s / %s  mode=%s  prompt=%q ##########\n' "$TAG" "$id" "$mode" "$prompt"
  REPO="$REPO" MODE="$mode" OUT="$out" TIMEOUT_MS="$tmo" SETTLE_MS="$settle" \
    bash "$REPO/tools/cos-repro/run.sh" "$prompt"
  echo "### rc=$? ###"
done

echo
echo "artifacts under $ROOT; summarise with:"
echo "    python3 $REPO/tools/cos-repro/report.py $ROOT"
