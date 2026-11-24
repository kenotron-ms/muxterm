#!/usr/bin/env python3
"""Derive installable PNG sizes from reviewed, square raster icon artwork.

Usage: build-pwa-raster-icons.py SOURCE.png OUTPUT_DIR

SOURCE.png is the finished Gemini image for one backdrop. Keep its main subject
within the center 60 percent so the maskable icon remains legible when cropped.
This script only resizes and pads that artwork; it does not draw icon subjects.
"""

import argparse
import subprocess
from pathlib import Path


def magick(*args: str) -> None:
    subprocess.run(["magick", *args], check=True)


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
    if width != height or width < 512:
        parser.error(f"source must be square and at least 512px: {dimensions}")
    if opaque != "True":
        parser.error("source needs an opaque, solid-color background for launcher masks")

    background = subprocess.check_output(
        ["magick", str(source), "-format", "%[pixel:p{0,0}]", "info:"], text=True
    ).strip()

    for name, size in (
        ("icon-512.png", 512),
        ("icon-192.png", 192),
        ("apple-touch-icon.png", 180),
        ("favicon-32.png", 32),
    ):
        magick(str(source), "-resize", f"{size}x{size}", "-strip", "-depth", "8", str(output_dir / name))

    magick(
        str(source), "-resize", "400x400", "-background", background,
        "-gravity", "center", "-extent", "512x512", "-strip", "-depth", "8",
        str(output_dir / "icon-maskable-512.png"),
    )


if __name__ == "__main__":
    main()
