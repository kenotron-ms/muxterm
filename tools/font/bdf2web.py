#!/usr/bin/env python3
"""BDF -> TTF/WOFF2 preserving exact bitmap cell metrics.

The whole point: unitsPerEm = cellHeight * 64, so `font-size: <cellHeight>px`
yields an EXACTLY integer advance with no rounding anywhere in the pipeline.
Fractional advances are what turn a pixel font into mush (a 6.5px render
antialiases ~87% of ink pixels; 6px antialiases none).

Usage: bdf2web.py <in.bdf> <FamilyName> [cell_w] [cell_h]
"""

import sys

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

PX = 64  # font units per bitmap pixel


def parse_bdf(path: str):
    ascent = descent = 0
    glyphs = []
    cur = None
    bitmap: list[int] | None = None

    for raw in open(path, encoding="latin-1"):
        line = raw.strip()
        if line.startswith("FONT_ASCENT"):
            ascent = int(line.split()[1])
        elif line.startswith("FONT_DESCENT"):
            descent = int(line.split()[1])
        elif line.startswith("STARTCHAR"):
            cur = {"name": line.split(None, 1)[1]}
        elif line.startswith("ENCODING"):
            cur["cp"] = int(line.split()[1])
        elif line.startswith("DWIDTH"):
            cur["adv"] = int(line.split()[1])
        elif line.startswith("BBX"):
            w, h, ox, oy = (int(v) for v in line.split()[1:5])
            cur["bbx"] = (w, h, ox, oy)
        elif line == "BITMAP":
            bitmap = []
        elif line == "ENDCHAR":
            cur["rows"] = bitmap
            glyphs.append(cur)
            cur, bitmap = None, None
        elif bitmap is not None and line:
            bitmap.append(int(line, 16))

    return ascent, descent, glyphs


def draw(pen, g) -> None:
    """Emit one rectangle per horizontal run of set pixels.

    Merging runs (rather than one square per pixel) keeps the contour count
    low enough that the whole font stays a couple of KB.
    """
    w, h, ox, oy = g["bbx"]
    nbytes = (w + 7) // 8
    for ri, val in enumerate(g["rows"]):
        # BDF pads each row to a whole number of bytes, ink left-aligned.
        bits = [(val >> (nbytes * 8 - 1 - c)) & 1 for c in range(w)]
        y = oy + (h - 1 - ri)  # BDF rows run top-down; font Y runs bottom-up
        c = 0
        while c < w:
            if not bits[c]:
                c += 1
                continue
            start = c
            while c < w and bits[c]:
                c += 1
            x0, x1 = (ox + start) * PX, (ox + c) * PX
            y0, y1 = y * PX, (y + 1) * PX
            pen.moveTo((x0, y0))
            pen.lineTo((x1, y0))
            pen.lineTo((x1, y1))
            pen.lineTo((x0, y1))
            pen.closePath()


def main() -> None:
    src, family = sys.argv[1], sys.argv[2]
    ascent, descent, raw = parse_bdf(src)
    cell_h = ascent + descent
    upem = cell_h * PX

    advances = {g["adv"] for g in raw}
    if len(advances) != 1:
        sys.exit(f"NOT MONOSPACE: advance widths {sorted(advances)}")
    cell_w = advances.pop()

    order = [".notdef"]
    cmap, pens, widths = {}, {}, {".notdef": cell_w * PX}
    pen = TTGlyphPen(None)
    pens[".notdef"] = pen.glyph()

    for g in raw:
        name = g["name"].replace(" ", "_")
        if name in pens:
            continue
        p = TTGlyphPen(None)
        draw(p, g)
        pens[name] = p.glyph()
        widths[name] = g["adv"] * PX
        if g["cp"] >= 0:
            cmap[g["cp"]] = name
        order.append(name)

    fb = FontBuilder(upem, isTTF=True)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap(cmap)
    fb.setupGlyf(pens)
    fb.setupHorizontalMetrics({n: (widths[n], 0) for n in order})
    # lineGap 0 and ascent+descent == upem gives an exactly 1.000em line box.
    fb.setupHorizontalHeader(ascent=ascent * PX, descent=-descent * PX, lineGap=0)
    fb.setupNameTable(
        {
            "familyName": family,
            "styleName": "Regular",
            "uniqueFontIdentifier": f"{family};bdf2web",
            "fullName": family,
            "psName": family,
            "version": "Version 1.000",
        }
    )
    fb.setupOS2(
        sTypoAscender=ascent * PX,
        sTypoDescender=-descent * PX,
        sTypoLineGap=0,
        usWinAscent=ascent * PX,
        usWinDescent=descent * PX,
        sxHeight=3 * PX,
        sCapHeight=4 * PX,
    )
    fb.setupPost(isFixedPitch=1)
    # PANOSE bProportion=9 declares "monospaced" to the OS font matcher.
    pan = fb.font["OS/2"].panose
    pan.bFamilyType, pan.bSerifStyle, pan.bWeight, pan.bProportion = 2, 11, 5, 9
    fb.font["head"].lowestRecPPEM = cell_h

    fb.save(f"{family}.ttf")
    fb.font.flavor = "woff2"
    fb.save(f"{family}.woff2")

    print(
        f"cell {cell_w}x{cell_h}px  ascent={ascent} descent={descent}  "
        f"upem={upem} ({PX} units/px)  glyphs={len(order)}"
    )
    print(f"CSS: font-size: {cell_h}px; line-height: {cell_h}px;  -> {cell_w}px advance")


if __name__ == "__main__":
    main()
