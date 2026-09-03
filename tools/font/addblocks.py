#!/usr/bin/env python3
"""Add the block-elements range (U+2580..2593) to any monospace BDF.

Spleen 5x8 ships 11 box-drawing glyphs but ZERO block elements. Blocks are not
decoration for a terminal preview: they are htop meters, progress bars,
sparklines, and -- in the sidebar preview -- the placeholder substituted for
wide/emoji cells that no bitmap font can ever draw. Without them those cells
render as tofu.

Cell dimensions are read from the BDF, so this works for any candidate font at
any size, not just Spleen 5x8.

Note the happy accident at 5x8: the eighth-block ladder (U+2581..2587) maps to
exactly one row per eighth, so vertical bar charts render at full precision.

Usage: addblocks.py <in.bdf> <out.bdf>
"""

import sys


def eighths(n: int, k: int) -> int:
    """k/8 of n cells, rounding halves up so a 'half' block reads as a half."""
    return int(n * k / 8 + 0.5)


def shade(w: int, h: int, level: str) -> list[int]:
    """Ordered-dither fills at roughly 25 / 50 / 75 percent coverage."""
    rows = []
    for y in range(h):
        v = 0
        for x in range(w):
            if level == "light":
                on = y % 2 == 0 and x % 2 == 0
            elif level == "medium":
                on = (x + y) % 2 == 0
            else:  # dark
                on = not (y % 2 and x % 2)
            if on:
                v |= 1 << (w - 1 - x)
        rows.append(v)
    return rows


def build(w: int, h: int) -> dict[int, tuple[str, list[int]]]:
    full = (1 << w) - 1
    g: dict[int, tuple[str, list[int]]] = {}

    def put(cp: int, rows: list[int]) -> None:
        g[cp] = (f"uni{cp:04X}", rows)

    # U+2580 upper half
    put(0x2580, [full] * eighths(h, 4) + [0] * (h - eighths(h, 4)))

    # U+2581..2588 lower 1/8 .. 8/8 (U+2584 half, U+2588 full)
    for k in range(1, 9):
        rows_on = eighths(h, k)
        put(0x2580 + k, [0] * (h - rows_on) + [full] * rows_on)

    # U+2589..258F left 7/8 .. 1/8 (U+258C is left half)
    for i, k in enumerate(range(7, 0, -1)):
        cols_on = eighths(w, k)
        bits = full ^ ((1 << (w - cols_on)) - 1)
        put(0x2589 + i, [bits] * h)

    # U+2590 right half
    right = (1 << (w - eighths(w, 4))) - 1
    put(0x2590, [right] * h)

    # U+2591..2593 shades
    for cp, level in ((0x2591, "light"), (0x2592, "medium"), (0x2593, "dark")):
        put(cp, shade(w, h, level))

    return g


def main() -> None:
    src, dst = sys.argv[1], sys.argv[2]
    lines = open(src, encoding="latin-1").read().splitlines()

    ascent = descent = 0
    adv: int | None = None
    have: set[int] = set()
    for line in lines:
        if line.startswith("FONT_ASCENT"):
            ascent = int(line.split()[1])
        elif line.startswith("FONT_DESCENT"):
            descent = int(line.split()[1])
        elif line.startswith("DWIDTH") and adv is None:
            adv = int(line.split()[1])
        elif line.startswith("ENCODING"):
            have.add(int(line.split()[1]))

    assert adv, "no DWIDTH found"
    w, h = adv, ascent + descent
    glyphs = {cp: g for cp, g in build(w, h).items() if cp not in have}
    nbytes = (w + 7) // 8
    pad = nbytes * 8 - w

    out: list[str] = []
    i = kept = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("STARTCHAR"):
            end = i
            while not lines[end].startswith("ENDCHAR"):
                end += 1
            out += lines[i : end + 1]
            kept += 1
            i = end + 1
            continue
        if line.startswith("ENDFONT"):
            for cp, (name, rows) in glyphs.items():
                out += [
                    f"STARTCHAR {name}",
                    f"ENCODING {cp}",
                    f"SWIDTH {round(w / h * 1000)} 0",
                    f"DWIDTH {w} 0",
                    f"BBX {w} {h} 0 {-descent}",
                    "BITMAP",
                    *[f"{r << pad:0{nbytes * 2}X}" for r in rows],
                    "ENDCHAR",
                ]
                kept += 1
            out.append("ENDFONT")
            i += 1
            continue
        out.append("CHARS PLACEHOLDER" if line.startswith("CHARS ") else line)
        i += 1

    open(dst, "w", encoding="latin-1").write(
        "\n".join(out).replace("CHARS PLACEHOLDER", f"CHARS {kept}") + "\n"
    )
    print(f"{dst}: cell {w}x{h}, added {len(glyphs)} block glyphs, {kept} total")


if __name__ == "__main__":
    main()
