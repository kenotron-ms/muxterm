#!/usr/bin/env python3
"""Derive installable PNG sizes from reviewed, square raster icon artwork.

Usage: build-pwa-raster-icons.py SOURCE.png OUTPUT_DIR

SOURCE.png is the finished Gemini image for one backdrop. The centered crop
removes the generous background margins in those images before resizing. The
maskable icon adds padding back so launchers can crop it safely. This script
does not draw icon subjects.
"""

import argparse
import math
import subprocess
import tempfile
from pathlib import Path


def magick(*args: str) -> None:
    subprocess.run(["magick", *args], check=True)


# Each source has different margins. Keep protruding leaves, wings and frosting
# inside the square while giving compact subjects like the cake more space.
CROP_FRACTIONS = {
    "arcade": 0.82,
    "botanical": 0.82,
    "citylights": 0.80,
    "confetti": 0.72,
    "contours": 0.82,
    "dunes": 0.82,
    "fan": 0.84,
    "geometry": 0.82,
    "moon-keep": 0.80,
    "night-grid": 0.80,
    "none": 0.80,
    "orbits": 0.84,
    "petals": 0.90,
    "rainfall": 0.86,
    "ridgeline": 0.88,
    "skybound": 0.82,
    "wayfarer": 0.80,
}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output_dir", type=Path)
    args = parser.parse_args()

    source = args.source.resolve(strict=True)
    output_dir = args.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)

    dimensions, opaque = subprocess.check_output(
        ["magick", "identify", "-format", "%wx%h %[opaque]", str(source)], text=True
    ).strip().split()
    width, height = map(int, dimensions.split("x"))
    minimum_size = math.ceil(512 / min(CROP_FRACTIONS.values()))
    if width != height or width < minimum_size:
        parser.error(f"source must be square and at least {minimum_size}px before cropping: {dimensions}")
    if opaque != "True":
        parser.error("source needs an opaque, solid-color background for launcher masks")

    crop_size = (int(width * CROP_FRACTIONS.get(source.stem, 0.80)) // 2) * 2
    with tempfile.TemporaryDirectory() as temp_dir:
        cropped = Path(temp_dir) / "cropped.png"
        magick(str(source), "-gravity", "center", "-crop", f"{crop_size}x{crop_size}+0+0", "+repage", str(cropped))
        background = subprocess.check_output(
            ["magick", str(cropped), "-format", "%[pixel:p{0,0}]", "info:"], text=True
        ).strip()

        for name, size in (
            ("icon-512.png", 512),
            ("icon-192.png", 192),
            ("apple-touch-icon.png", 180),
            ("favicon-32.png", 32),
        ):
            magick(str(cropped), "-resize", f"{size}x{size}", "-strip", "-depth", "8", str(output_dir / name))

        magick(
            str(cropped), "-resize", "400x400", "-background", background,
            "-gravity", "center", "-extent", "512x512", "-strip", "-depth", "8",
            str(output_dir / "icon-maskable-512.png"),
        )


if __name__ == "__main__":
    main()
