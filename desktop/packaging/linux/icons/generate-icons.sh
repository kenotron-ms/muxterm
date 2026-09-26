#!/usr/bin/env bash
# Regenerate the Linux app icon PNGs next to this script.
#
# SOURCE OF TRUTH: web/public/favicon.svg -- muxterm's existing brand mark, the
# same one the browser tab shows. This is NOT a placeholder drawn for packaging.
#
# WHY THIS REDRAWS THE MARK INSTEAD OF RASTERISING THE SVG: ImageMagick's
# built-in MSVG renderer silently DROPS <polyline>, so `magick favicon.svg
# icon.png` produces the dark tile and the green prompt block with the blue
# chevron MISSING. Verified by probing the rendered pixels. Rather than add a
# librsvg build dependency, the four primitives below reproduce the same
# geometry, colours and stroke caps exactly.
#
# Keep in sync with web/public/favicon.svg. A designer replacing the mark should
# update that SVG, mirror the primitives here, and re-run this script.
set -euo pipefail
cd "$(dirname "$0")"

draw() {
  magick -size 512x512 xc:none \
    -fill '#1a1b26' -stroke none -draw 'roundrectangle 0,0 511,511 96,96' \
    -fill none -stroke '#292e42' -strokewidth 4 -draw 'roundrectangle 24,24 488,488 76,76' \
    -fill none -stroke '#7aa2f7' -strokewidth 40 \
      -draw 'stroke-linecap round stroke-linejoin round polyline 156,176 250,256 156,336' \
    -fill '#9ece6a' -stroke none -draw 'roundrectangle 288,316 408,352 10,10' \
    "$1"
}

draw muxterm-desktop-512.png
for size in 16 24 32 48 64 128 256; do
  magick muxterm-desktop-512.png -filter Lanczos -resize "${size}x${size}" \
    "muxterm-desktop-${size}.png"
done
echo "regenerated $(find . -maxdepth 1 -name 'muxterm-desktop-*.png' | wc -l) PNGs from the muxterm brand mark"
