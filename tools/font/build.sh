#!/usr/bin/env bash
# Build the sidebar-preview bitmap font: Spleen 5x8 -> WOFF2.
#
# Run this only when the upstream font or the block-glyph set changes. The
# output (web/public/fonts/Spleen5x8.woff2, ~4.7 KB) is committed, so a normal
# `make build` never needs Python or network access.
#
#   ./tools/font/build.sh
#
# Why a build step at all, rather than downloading a ready-made WOFF2:
#
#   1. Spleen ships no OTF/WOFF2 at the 5x8 size -- only BDF/PCF/PSF/OTB/FON.
#      Every other size has web fonts; 5x8 does not.
#   2. Generic BDF->TTF converters mangle metrics. The popular Tom Thumb TTF on
#      GitHub is not monospace despite its filename (advances 256/768/1024) and
#      puts all ink below the baseline. bdf2web.py sets unitsPerEm = cellH * 64
#      so `font-size: 8px` yields an EXACTLY integer 5px advance -- fractional
#      advances antialias the whole grid into mush.
#   3. Spleen has 11 box-drawing glyphs but ZERO block elements. Blocks are not
#      decoration here: they are htop meters, progress bars, and the placeholder
#      the preview substitutes for wide/emoji cells no bitmap font can draw.
#      Without them those cells render as tofu.

set -euo pipefail
cd "$(dirname "$0")"

SRC_URL="https://raw.githubusercontent.com/fcambus/spleen/master/spleen-5x8.bdf"
OUT_DIR="../../web/public/fonts"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

command -v uv >/dev/null || { echo "need uv: https://docs.astral.sh/uv/" >&2; exit 1; }

echo "==> fetching Spleen 5x8 (BSD-2-Clause, Frederic Cambus)"
curl -sSfL -o "$WORK/spleen.bdf" "$SRC_URL"

echo "==> preparing python env"
uv venv -q "$WORK/.venv"
uv pip install -q --python "$WORK/.venv/bin/python" fonttools brotli
PY="$WORK/.venv/bin/python"

echo "==> dropping any non-modal advance widths (enforces monospace)"
"$PY" filter.py "$WORK/spleen.bdf" "$WORK/mono.bdf"

echo "==> adding block elements U+2580..2593"
"$PY" addblocks.py "$WORK/mono.bdf" "$WORK/final.bdf"

echo "==> converting to WOFF2"
( cd "$WORK" && "$PY" "$OLDPWD/bdf2web.py" final.bdf Spleen5x8 )

mkdir -p "$OUT_DIR"
cp "$WORK/Spleen5x8.woff2" "$OUT_DIR/"
echo "==> wrote $OUT_DIR/Spleen5x8.woff2 ($(wc -c < "$OUT_DIR/Spleen5x8.woff2") bytes)"

echo "==> verifying"
"$PY" - "$OUT_DIR/Spleen5x8.woff2" <<'VERIFY'
import sys
from fontTools.ttLib import TTFont

f = TTFont(sys.argv[1])
upem = f["head"].unitsPerEm
adv = {f["hmtx"][n][0] for n in f.getGlyphOrder() if n != ".notdef"}
assert len(adv) == 1, f"NOT MONOSPACE: {sorted(adv)}"
assert f["post"].isFixedPitch == 1, "post.isFixedPitch not set"
hh = f["hhea"]
line = (hh.ascender - hh.descender + hh.lineGap) / upem
assert abs(line - 1.0) < 1e-9, f"line box {line} em, expected exactly 1.000"
cell_w = adv.pop() / upem * 8
assert cell_w == int(cell_w), f"advance {cell_w}px at font-size 8px is fractional"

cmap = f.getBestCmap()
# Only the LIGHT box set is required. Heavy, double, dashed and rounded
# variants are folded to their light equivalent by the preview's sanitiser,
# so they deliberately do not need glyphs here.
LIGHT_BOX = [0x2500, 0x2502, 0x250C, 0x2510, 0x2514, 0x2518,
             0x251C, 0x2524, 0x252C, 0x2534, 0x253C]
for name, codepoints in [
    ("ASCII", range(0x20, 0x7F)),
    ("latin-1", range(0xA0, 0x100)),
    ("light box", LIGHT_BOX),
    ("block", range(0x2580, 0x2594)),
]:
    gaps = [c for c in codepoints if c not in cmap]
    assert not gaps, f"{name} gaps: {[hex(c) for c in gaps]}"

print(f"    monospace, {int(cell_w)}px advance at font-size 8px, line box 1.000 em")
print(f"    {len(cmap)} glyphs; ASCII, box-drawing and block elements all present")
VERIFY

echo "==> OK"
