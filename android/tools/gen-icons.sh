#!/usr/bin/env bash
# Regenerate the Android launcher icon from the PWA logo.
#
# The source of truth is web/public/icons/icon.svg -- a terminal prompt chevron
# and a cursor block on Tokyo Night ink. This script does NOT rasterise that SVG:
# ImageMagick has no librsvg here and its built-in MSVG renderer silently drops
# <polyline> strokes (verified 2026-09-09 -- the chevron came out as flat
# background while the <rect> rendered fine). The geometry below is therefore
# transcribed from the SVG and drawn with MVG primitives, which do honour
# stroke-linecap.
#
#   ./android/tools/gen-icons.sh            # write res/ assets
#   ./android/tools/gen-icons.sh --preview  # also write /tmp/icon-preview
#
# Usage note: run from the repo root.
set -euo pipefail

RES="android/app/src/main/res"
[ -d "$RES" ] || { echo "run from the repo root (no $RES)" >&2; exit 1; }

INK="#1a1b26"    # background      (theme_color / background_color in the manifest)
BLUE="#7aa2f7"   # prompt chevron
GREEN="#9ece6a"  # cursor block

# --- geometry -----------------------------------------------------------------
# Original SVG is a 512 box. Ink bounding box is x 136..408, so the ink centre
# sits at x=272 -- 16 units RIGHT of the box centre, because the cursor block
# hangs off to the right. We centre on the INK, not the box, or the mark reads
# visibly lopsided under a circular mask.
#
# Adaptive icons are a 108dp canvas whose outer 18dp on every side is masked
# away; only a 66dp-diameter circle at the centre is guaranteed visible. So the
# scale is set by the furthest painted pixel from the ink centre, not by the
# bounding box: the cursor block's outer corner arc, ~165 units out. k = 0.198
# puts the worst-case ink radius at 32.7dp inside the 33dp guarantee.
#
#   x' = 0.198*x + 0.13       y' = 0.198*y + 3.24
#
# Fit check against web/public/icons/icon.svg, which is the source of truth:
#   chevron 156,176 250,256 156,336 stroke 40  ->  31.0,38.0 49.6,53.8 31.0,69.6
#   stroke 40 -> 8            block x 288..408 -> 57.2..80.9
# Verified on the built APK 2026-09-09: the ink is centred to within half a
# pixel in both axes at 48/72/96dp, and the chevron and the block stay two
# separate connected components with 6.07px of clear ground between them at
# 48dp -- see docs/design/android-icon.md.
#
# ONE DELIBERATE DEPARTURE FROM THE PWA MARK. The web icon's cursor is a
# 120x36 dash (3.3:1). Transcribed literally it lands at ~4.8px tall in a 48dp
# launcher icon and the themed (monochrome) variant -- where the block loses the
# green that was doing all the work of separating it from the chevron -- read as
# one ambiguous blob when rendered and reviewed at that size on 2026-09-09. The
# block is therefore 52 units tall here rather than 36 (2.3:1), which costs
# nothing in scale (k is unchanged to three figures, because the binding corner
# barely moves) and takes the block to ~6.9px at 48dp. Same two shapes, same two
# colours, same arrangement -- a heavier cursor. The alternative, rejected as
# the larger change, was to edit web/public/icons/*.svg so web and Android stay
# byte-identical; see docs/design/android-auto.md.
K=0.198

# chevron, in 108-space
CHV="31.0,38.0 49.6,53.8 31.0,69.6"
CHV_W=8.0        # 40 * K, rounded
# cursor block, in 108-space: 57.2,63.7 -> 80.9,74.0, corner radius 2
BAR_X1=57.2; BAR_Y1=63.7; BAR_X2=80.9; BAR_Y2=74.0; BAR_R=2.0

# --- vector drawables ---------------------------------------------------------
mkdir -p "$RES/drawable" "$RES/mipmap-anydpi-v26"

cat > "$RES/drawable/ic_launcher_background.xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<!-- Adaptive icon background. Flat Tokyo Night ink, edge to edge: the launcher
     masks and parallaxes this layer, so anything inset (the PWA icon's hairline
     frame, for one) is cropped or slid off screen. Flat is the correct answer. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path
        android:fillColor="#1a1b26"
        android:pathData="M0,0h108v108h-108z" />
</vector>
XML

# foreground + monochrome differ only in colour, so emit them from one template.
emit_fg() { # $1 = out path, $2 = chevron colour, $3 = block colour, $4 = comment
    cat > "$1" <<XML
<?xml version="1.0" encoding="utf-8"?>
<!-- $4
     Geometry is web/public/icons/icon.svg mapped into the 108dp adaptive canvas
     by x' = 0.198x + 0.13, y' = 0.198y + 3.24, which centres the ink (not the
     box) and keeps every painted pixel inside the 66dp safe circle. Regenerate
     with android/tools/gen-icons.sh; do not hand-edit the numbers. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <!-- prompt chevron -->
    <path
        android:pathData="M31,38 L49.6,53.8 L31,69.6"
        android:strokeColor="$2"
        android:strokeWidth="8"
        android:strokeLineCap="round"
        android:strokeLineJoin="round" />
    <!-- cursor block -->
    <path
        android:fillColor="$3"
        android:pathData="M59.2,63.7 L78.9,63.7 A2,2 0 0 1 80.9,65.7 L80.9,72 A2,2 0 0 1 78.9,74 L59.2,74 A2,2 0 0 1 57.2,72 L57.2,65.7 A2,2 0 0 1 59.2,63.7 Z" />
</vector>
XML
}

emit_fg "$RES/drawable/ic_launcher_foreground.xml" "$BLUE" "$GREEN" \
    "Adaptive icon foreground: the prompt chevron and the cursor block."
emit_fg "$RES/drawable/ic_launcher_monochrome.xml" "#FFFFFF" "#FFFFFF" \
    "Android 13+ themed-icon layer. The system reads this layer's ALPHA and tints
     it from the wallpaper, so the colour here is arbitrary and the shapes must
     carry the whole logo. They do: chevron and block are separate solid forms
     with clear air between them, and neither depends on hue to be read."

for f in ic_launcher ic_launcher_round; do
cat > "$RES/mipmap-anydpi-v26/$f.xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<!-- <monochrome> is API 33+; API 26..32 parse the file and ignore the element,
     which is why it lives here rather than in a separate -v33 variant. -->
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
    <monochrome android:drawable="@drawable/ic_launcher_monochrome" />
</adaptive-icon>
XML
done

# --- raster fallbacks ---------------------------------------------------------
# minSdk is 26, so every supported device uses the adaptive XML above. These
# exist for the surfaces that ask for a plain bitmap anyway -- and the car
# launcher is one of them.
draw_content() { # $1 = canvas px  -> MVG for chevron + block, scaled from 108-space
    local s=$1
    local m; m=$(awk -v s="$s" 'BEGIN{printf "%.6f", s/108}')
    local pts; pts=$(for p in $CHV; do
        awk -v x="${p%,*}" -v y="${p#*,}" -v m="$m" 'BEGIN{printf "%.3f,%.3f ", x*m, y*m}'
    done)
    # Every colour is single-quoted: these strings go through `eval`, where a
    # bare #1a1b26 would start a comment and swallow the rest of the command.
    awk -v m="$m" -v w="$CHV_W" -v b="$BLUE" -v g="$GREEN" -v pts="$pts" \
        -v x1="$BAR_X1" -v y1="$BAR_Y1" -v x2="$BAR_X2" -v y2="$BAR_Y2" -v r="$BAR_R" 'BEGIN{
        q = sprintf("%c", 39)
        printf "-fill none -stroke %s%s%s -strokewidth %.3f -draw %sstroke-linecap round stroke-linejoin round polyline %s%s ", q, b, q, w*m, q, pts, q
        printf "-stroke none -fill %s%s%s -draw %sroundrectangle %.3f,%.3f %.3f,%.3f %.3f,%.3f%s ", q, g, q, q, x1*m, y1*m, x2*m, y2*m, r*m, r*m, q
    }'
}

render() { # $1 = size px, $2 = square|round, $3 = out
    local s=$1 shape=$2 out=$3
    local ss=$((s * 4))                      # 4x supersample, then Lanczos down
    local bg
    if [ "$shape" = round ]; then
        bg=$(awk -v s="$ss" "BEGIN{printf \"-draw 'circle %.1f,%.1f %.1f,%.1f'\", s/2, s/2, s/2, 0}")
    else
        # 96/512 of the box, exactly the PWA icon's corner radius
        bg=$(awk -v s="$ss" "BEGIN{r=s*96/512; printf \"-draw 'roundrectangle 0,0 %.1f,%.1f %.1f,%.1f'\", s-1, s-1, r, r}")
    fi
    eval magick -size "${ss}x${ss}" xc:none -fill "'$INK'" -stroke none "$bg" \
        "$(draw_content "$ss")" \
        -filter Lanczos -resize "${s}x${s}" -strip "'$out'"
}

declare -A DPI=( [mdpi]=48 [hdpi]=72 [xhdpi]=96 [xxhdpi]=144 [xxxhdpi]=192 )
for d in "${!DPI[@]}"; do
    mkdir -p "$RES/mipmap-$d"
    render "${DPI[$d]}" square "$RES/mipmap-$d/ic_launcher.png"
    render "${DPI[$d]}" round  "$RES/mipmap-$d/ic_launcher_round.png"
done

echo "wrote:"
find "$RES/drawable" "$RES/mipmap-anydpi-v26" $(printf "$RES/mipmap-%s " "${!DPI[@]}") \
    -name 'ic_launcher*' | sort | sed 's/^/  /'

# --- preview ------------------------------------------------------------------
# The only test that matters for a launcher icon is whether it survives being
# small. This renders the ADAPTIVE icon the way a launcher composites it -- the
# 108dp canvas cropped to the 72dp viewport, then masked -- at 48/72/96dp under
# the three masks real launchers use, plus the Android 13+ themed variant.
[ "${1:-}" = "--preview" ] || exit 0

OUT="docs/design/img"
mkdir -p "$OUT"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

adaptive() { # $1=size px  $2=chevron colour  $3=block colour  $4=bg colour  $5=out
    local s=$1 fgc=$2 blkc=$3 bgc=$4 out=$5
    local ss=$((s * 4))
    local full; full=$(awk -v v="$ss" 'BEGIN{printf "%d", v*108/72}')   # un-crop to 108dp
    local sv_blue=$BLUE sv_green=$GREEN
    BLUE=$fgc GREEN=$blkc
    eval magick -size "${full}x${full}" "xc:'$bgc'" "$(draw_content "$full")" \
        -gravity center -crop "${ss}x${ss}+0+0" +repage \
        -filter Lanczos -resize "${s}x${s}" -strip "'$out'"
    BLUE=$sv_blue GREEN=$sv_green
}

mask() { # $1=size $2=circle|squircle|rsquare $3=out
    local s=$1 ss=$(( $1 * 4 )) out=$3
    case $2 in
      circle)   magick -size "${s}x${s}" xc:black -fill white \
                  -draw "circle $((s/2)),$((s/2)) $((s/2)),0" -alpha off "$out" ;;
      squircle) magick -size "${ss}x${ss}" xc:black -fill white \
                  -draw "roundrectangle 0,0 $((ss-1)),$((ss-1)) $((ss*22/100)),$((ss*22/100))" \
                  -resize "${s}x${s}" -alpha off "$out" ;;
      rsquare)  magick -size "${ss}x${ss}" xc:black -fill white \
                  -draw "roundrectangle 0,0 $((ss-1)),$((ss-1)) $((ss*12/100)),$((ss*12/100))" \
                  -resize "${s}x${s}" -alpha off "$out" ;;
    esac
}

strip_of() { # $1=row-name $2=chevron $3=block $4=bg $5=maskshape -> $TMP/row-$1.png
    local files=()
    for s in 48 72 96; do
        adaptive "$s" "$2" "$3" "$4" "$TMP/a-$1-$s.png"
        mask "$s" "$5" "$TMP/m-$1-$s.png"
        magick "$TMP/a-$1-$s.png" "$TMP/m-$1-$s.png" -alpha off \
            -compose CopyOpacity -composite "$TMP/k-$1-$s.png"
        files+=("$TMP/k-$1-$s.png")
    done
    magick "${files[@]}" -background '#2b2b33' -gravity south -splice 0x10 +append \
        -background '#2b2b33' -gravity center -extent 300x116 "$TMP/row-$1.png"
}

strip_of circle   "$BLUE" "$GREEN" "$INK"     circle
strip_of squircle "$BLUE" "$GREEN" "$INK"     squircle
strip_of rsquare  "$BLUE" "$GREEN" "$INK"     rsquare
# themed: the system tints the monochrome layer's alpha over a wallpaper colour
strip_of themed   '#cfe0ff' '#cfe0ff' '#3a4a63' circle

cap() { magick -background '#2b2b33' -fill '#9aa0b4' -pointsize 15 \
        "label:  $1" -gravity west -extent 300x24 "$TMP/c-$2.png"; }
cap 'circle mask            48 / 72 / 96 dp' circle
cap 'squircle mask' squircle
cap 'rounded square' rsquare
cap 'themed / monochrome (Android 13+)' themed

magick "$TMP/c-circle.png" "$TMP/row-circle.png" \
       "$TMP/c-squircle.png" "$TMP/row-squircle.png" \
       "$TMP/c-rsquare.png" "$TMP/row-rsquare.png" \
       "$TMP/c-themed.png" "$TMP/row-themed.png" \
       -append -bordercolor '#2b2b33' -border 18 "$OUT/android-icon-preview.png"
echo "  $OUT/android-icon-preview.png"
