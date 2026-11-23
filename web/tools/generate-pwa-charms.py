#!/usr/bin/env python3
"""Generate the finite, reviewed PWA icon set. Requires ImageMagick at build time only."""

from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1] / "public" / "pwa" / "variants"
COLORS = {
    "indigo": "#344C91",
    "teal": "#176D75",
    "coral": "#A94747",
    "ochre": "#85591E",
    "plum": "#6B4B83",
}

# These are deliberately filled silhouettes, drawn for a 32 px favicon as well
# as a 512 px launcher. The small dark cutouts establish the object without
# relying on fine strokes.
CHARMS = {
    "lantern": '''
      <path fill="#FFF4DB" d="M221 70h70v25h-70zM206 90h100l-9 41h-82zM189 137h134l20 264H169z"/>
      <path fill="#203044" d="M206 166h100l-10 173h-80z"/>
      <path fill="#FFD47C" d="M255 212c-11 26-29 38-29 62a30 30 0 0 0 60 0c0-21-17-42-31-62z"/>
      <path fill="#FFF4DB" d="M155 396h202v37H155zM188 119h136v30H188z"/>
      <path fill="none" stroke="#FFF4DB" stroke-width="22" stroke-linecap="round" d="M214 68a42 42 0 0 1 84 0"/>
    ''',
    "rocket": '''
      <path fill="#FFF4DB" d="M256 58c-72 60-91 135-79 239l79 80 79-80c12-104-7-179-79-239z"/>
      <path fill="#203044" d="M256 166a48 48 0 1 0 0 96 48 48 0 0 0 0-96z"/>
      <path fill="#9BD5D5" d="M256 180a34 34 0 1 0 0 68 34 34 0 0 0 0-68z"/>
      <path fill="#FFF4DB" d="M176 273l-63 63v76l92-52zM336 273l63 63v76l-92-52zM222 365v50l34 55 34-55v-50z"/>
      <path fill="#FFD47C" d="M242 371v49l14 29 14-29v-49z"/>
    ''',
    "key": '''
      <path fill="#FFF4DB" fill-rule="evenodd" d="M197 87a110 110 0 0 0-49 208l85 24 33-58-3-37a110 110 0 0 0-66-137zm0 57a53 53 0 1 1 0 106 53 53 0 0 1 0-106z"/>
      <path fill="#FFF4DB" d="M233 262l65-48 145 148-44 44-38-39-33 32-31-31 32-33z"/>
      <path fill="#FFD47C" d="M350 352l46 46-16 16-46-46z"/>
    ''',
    "hourglass": '''
      <path fill="#FFF4DB" d="M146 78h220v35H146zM146 399h220v35H146zM177 115h158v35c0 46-27 68-64 103 37 35 64 57 64 103v41H177v-41c0-46 27-68 64-103-37-35-64-57-64-103z"/>
      <path fill="#203044" d="M203 146h106c-1 34-21 48-53 78-32-30-52-44-53-78zM203 365c3-31 22-49 53-79 31 30 50 48 53 79z"/>
      <path fill="#FFD47C" d="M221 349c13-18 24-28 35-38 11 10 22 20 35 38z"/>
    ''',
}


def svg(charm: str, color: str, maskable: bool) -> str:
    scale = 0.65 if maskable else 0.78
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
      <rect width="512" height="512" fill="{color}"/>
      <path fill="#FFFFFF" opacity=".09" d="M0 0h512v120C381 88 191 101 0 210z"/>
      <g transform="translate(256 256) scale({scale}) translate(-256 -256)">{CHARMS[charm]}</g>
    </svg>'''


def convert(source: Path, target: Path, size: int) -> None:
    subprocess.run(
        ["magick", "-background", "none", "-density", "384", str(source),
         "-resize", f"{size}x{size}!", "-strip", f"PNG32:{target}"],
        check=True,
    )


def main() -> None:
    for charm in CHARMS:
        for color_name, color in COLORS.items():
            directory = ROOT / charm / color_name
            directory.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory() as temporary:
                normal = Path(temporary) / "normal.svg"
                mask = Path(temporary) / "mask.svg"
                normal.write_text(svg(charm, color, False))
                mask.write_text(svg(charm, color, True))
                (directory / "icon.svg").write_text(normal.read_text())
                for size, name in [(32, "favicon-32.png"), (180, "apple-touch-icon.png"),
                                   (192, "icon-192.png"), (512, "icon-512.png")]:
                    convert(normal, directory / name, size)
                convert(mask, directory / "icon-maskable-512.png", 512)


if __name__ == "__main__":
    main()
