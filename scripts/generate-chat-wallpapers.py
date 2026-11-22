#!/usr/bin/env python3
"""Draw the twelve original, palette-masked chat wallpaper tiles.

The icons share a 40-unit drawing box. Toroidal centroid relaxation gives each
object an even pocket of space without locking the wallpaper to visible rows.
"""

from __future__ import annotations

from pathlib import Path
import random


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web/src/assets/backdrop-subjects"
SIZE = 240

# Each fragment is a small line drawing made for this gallery. White is used as an
# alpha mask; the application theme supplies its visible colour.
ICONS = {
    "notebook": '<rect x="7" y="5" width="27" height="31" rx="3"/><path d="M13 5v31m6-23h10m-10 6h10m-10 6h7"/>',
    "pencil": '<path d="m10 31 4-9L31 5l5 5-17 17-9 4Zm4-9 5 5M27 9l5 5"/>',
    "mug": '<path d="M8 12h22v13a8 8 0 0 1-8 8h-6a8 8 0 0 1-8-8V12Zm22 3h4a5 5 0 0 1 0 10h-4M13 7c-2-2 2-3 0-5m7 5c-2-2 2-3 0-5"/>',
    "headphones": '<path d="M7 22v-5a13 13 0 0 1 26 0v5M7 21h6v12H9a4 4 0 0 1-4-4v-4a4 4 0 0 1 4-4Zm20 0h6a4 4 0 0 1 4 4v4a4 4 0 0 1-4 4h-6V21Z"/>',
    "lamp": '<path d="m12 20 7-15h7l7 15H12Zm11 0v13M14 35h18M11 35h24M17 25h12"/>',
    "tent": '<path d="M4 33 20 6l16 27H4Zm12 0 4-13 4 13M20 6v14M8 33l-3 3m27-3 3 3"/>',
    "pine": '<path d="m20 3-9 12h5L8 27h24l-8-12h5L20 3Zm0 24v10m-5 0h10"/>',
    "boot": '<path d="M10 5h14v18l5 5 7 2v6H6v-6l6-4-2-21Zm2 9h12M6 31h30"/>',
    "compass": '<circle cx="20" cy="20" r="16"/><path d="m25 15-3 7-7 3 3-7 7-3ZM20 2v4m0 28v4M2 20h4m28 0h4"/>',
    "lantern": '<path d="M14 11V7a6 6 0 0 1 12 0v4M9 14h22l-3 20H12L9 14Zm5 7h12m-11 8h10M12 34h16m-8-20v20"/>',
    "trowel": '<path d="M20 4v17m-4-14c0-4 8-4 8 0v4h-8V7Zm4 14c-8 1-12 6-12 10s5 6 12 6 12-2 12-6-4-9-12-10Z"/>',
    "watering": '<path d="M7 17h20l3 16H9L7 17Zm20 2 8-5 2 4-9 7M9 20c-7-2-7 10 0 10M13 12h12m-8-5h5m11 22 2 2m-3-7 2 2"/>',
    "pot": '<path d="M9 22h22l-3 14H12L9 22Zm9 0V8m2 10c-8-5-8-12-4-13 6 0 8 7 4 13Zm0-3c4-8 10-9 13-5-1 5-7 8-13 5Z"/>',
    "gloves": '<path d="M8 34 5 22l2-10 4 1 1 8-1-14 4-1 2 14 1-16 4 1-1 16 3-12 4 2-3 15-4 8H8Zm23 0-3-10 2-9 4 1 2 8 2 10h-7Z"/>',
    "seeds": '<path d="M8 7h24v29H8V7Zm0 7h24M14 28c4-8 9-8 13 0-5 4-9 4-13 0Zm6-4v-7"/>',
    "book": '<path d="M5 8c6-3 11-2 15 1 4-3 9-4 15-1v26c-6-2-11-2-15 1-4-3-9-3-15-1V8Zm15 1v26M9 14c3-1 6-1 8 0m6 0c3-1 6-1 8 0M9 20c3-1 6-1 8 0m6 0c3-1 6-1 8 0"/>',
    "glasses": '<path d="M4 17h5m22 0h5M17 18c2-2 4-2 6 0M6 15h11l-1 11c-2 4-9 4-11 0L4 18l2-3Zm17 0h11l2 3-1 8c-2 4-9 4-11 0l-1-11Z"/>',
    "bookmark": '<path d="M12 5h16v30l-8-6-8 6V5Zm4 7h8m-8 6h8"/>',
    "key": '<circle cx="12" cy="12" r="7"/><path d="m17 17 18 18m-7-7 4-4m-9-1 4-4M9 12h6"/>',
    "telescope": '<path d="m7 12 20-7 4 10-20 7-4-10Zm-1 3-3 1m28-5 5-2M21 20l-1 8m0 0-9 8m9-8 9 8M12 36h17"/>',
    "moon": '<path d="M30 5A16 16 0 1 0 35 31 16 16 0 0 1 30 5Z"/><path d="m7 5 1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3Z"/>',
    "chart": '<path d="M5 8 16 5l10 3 9-3v28l-9 3-10-3-11 3V8Zm11-3v28M26 8v28m-16-18 2 2 2-2-2-2-2 2Zm20 6 2 2 2-2-2-2-2 2Z"/>',
    "rocket": '<path d="M20 5c8 5 12 13 9 22l-9 6-9-6C8 18 12 10 20 5Zm-9 17-5 5v8l8-4m15-9 5 5v8l-8-4M16 34l4 5 4-5"/><circle cx="20" cy="18" r="4"/>',
    "planet": '<circle cx="20" cy="20" r="10"/><path d="M4 24c3-7 29-16 33-8 3 7-26 20-33 12m13-14 4-4m6 17 3 3"/>',
    "umbrella": '<path d="M4 19a16 16 0 0 1 32 0H4Zm16 0v13c0 6 9 6 9 0m-9-29v2M4 19c4-4 7-4 10 0 4-4 8-4 12 0 3-4 6-4 10 0"/>',
    "raincoat": '<path d="m14 5 6 5 6-5 9 8-5 8-3-3v18H13V18l-3 3-5-8 9-8Zm6 5v26m-6-20 6 4 6-4m-10 9h3m2 0h3"/>',
    "cloud": '<path d="M10 27c-9 0-9-12 0-13 2-10 16-12 21-3 10-1 12 15 2 16H10Zm3 6-2 4m11-4-2 4m12-4-2 4"/>',
    "puddle": '<path d="M5 25c3-3 7-2 10-3 4-8 11-7 14 0 10 0 11 10 0 11H11C4 33 1 29 5 25Zm9 2h12m-9 4h8"/>',
    "rubberboot": '<path d="M11 5h15v21l8 3v7H6v-7l6-4-1-20Zm1 10h14M6 31h28m-19-11h8"/>',
    "cake": '<path d="M6 20h28v15H6V20Zm0 6c3 3 6 3 9 0 3 3 7 3 10 0 3 3 6 3 9 0M20 20V8m-2 0c-2-3 0-5 2-6 2 1 4 3 2 6h-4Z"/>',
    "balloon": '<path d="M20 4c-9 0-13 7-12 15 1 7 6 11 12 11s11-4 12-11C33 11 29 4 20 4Zm-3 26 3 4 3-4m-3 4c-3 2 1 3-2 5"/>',
    "gift": '<path d="M6 17h28v19H6V17Zm-2-6h32v6H4v-6Zm16 0v25m0-25C5 11 10 2 15 4c4 1 5 7 5 7Zm0 0c15 0 10-9 5-7-4 1-5 7-5 7Z"/>',
    "partyhat": '<path d="M8 34 20 5l12 29H8Zm5-10 14-2M10 31l20-2M20 5l-4-4m4 4 3-4"/>',
    "candle": '<path d="M12 16h16v20H12V16Zm8-3c-4-3-3-8 0-11 4 4 4 8 0 11Zm-8 10h16m-16 6h16"/>',
    "cactus": '<path d="M16 36V10a5 5 0 0 1 10 0v26H16Zm0-8H9c-3 0-4-3-4-7v-7h6v7h5m10 0h5v-8h6v8c0 5-2 8-6 8h-5M12 36h18"/>',
    "sun": '<circle cx="20" cy="20" r="9"/><path d="M20 2v5m0 26v5M2 20h5m26 0h5M7 7l4 4m18 18 4 4M33 7l-4 4M11 29l-4 4"/>',
    "canteen": '<path d="M15 4h10v6H15V4Zm2 6h6m-8 0-6 8v15c0 4 22 4 22 0V18l-6-8M9 23h22m-22 7h22"/>',
    "map": '<path d="M4 9 15 5l10 4 11-4v27l-11 4-10-4-11 4V9Zm11-4v27M25 9v27m-6-16 4-4m-4 4 3 3"/>',
    "sandal": '<path d="M12 6c-4 6-5 12-6 19-1 7 4 11 11 11h11c8 0 9-8 3-11L18 7c-2-3-4-3-6-1Zm-4 18 18 1M13 13l15 17m-5-12-10 11"/>',
    "teapot": '<path d="M9 17h21v13c0 5-5 7-11 7s-10-2-10-7V17Zm3-5h16m-10-5h5m-3-3v3M9 21 3 18l-2 4 8 6m21-9h4c5 0 5 11-4 11"/>',
    "foldingfan": '<path d="M20 35 4 18Q20 0 36 18L20 35Zm0 0L8 15m12 20-5-27m5 27 5-27m-5 27 12-20M12 25h16"/>',
    "biscuit": '<circle cx="20" cy="20" r="15"/><path d="M12 13h2m12 2h2m-8 6h2m-8 5h2m12 1h2M20 7v2"/>',
    "saucer": '<ellipse cx="20" cy="29" rx="17" ry="6"/><path d="M11 11h17v11c0 5-4 7-9 7s-8-2-8-7V11Zm17 3h4c6 0 5 9-4 9M16 6c-2-2 1-3 0-5m7 5c-2-2 1-3 0-5"/>',
    "tray": '<path d="M4 24h32l-4 10H8L4 24Zm6-8h20l4 8H6l4-8Zm10-11v11m-4-11h8M8 34h24"/>',
    "storefront": '<path d="M6 17h28v19H6V17Zm-2 0 3-11h26l3 11H4Zm2 0c2 4 5 4 7 0 2 4 5 4 7 0 2 4 5 4 7 0 2 4 5 4 7 0M12 36V24h16v12"/>',
    "bicycle": '<circle cx="9" cy="29" r="7"/><circle cx="31" cy="29" r="7"/><path d="m9 29 9-14 8 14H9Zm17 0 5-15m-9-2h8m-15 3h7m-7-3 2 3"/>',
    "streetlamp": '<path d="M5 36h21m-15 0h8m-4 0V12c0-6 4-9 10-9h9m-5 0v8m-5 0h10l-2 7h-6l-2-7Zm-9 10h6m-6 8h6"/>',
    "takeaway": '<path d="M9 13h22l-2 23H11L9 13Zm4-5h14m-17 5 5-5h10l5 5M15 22h10m-10 5h10"/>',
    "music": '<path d="M16 28V9l17-4v20M16 13l17-4M16 28c0 6-12 8-12 2 0-5 12-6 12-2Zm17-3c0 6-12 8-12 2 0-5 12-6 12-2Z"/>',
    "scissors": '<circle cx="10" cy="30" r="5"/><circle cx="23" cy="30" r="5"/><path d="M14 26 33 7M20 26 5 7m18 3 8-3"/>',
    "ribbon": '<path d="M20 15c-8-14-19-9-16-1 2 5 11 5 16 1Zm0 0c8-14 19-9 16-1-2 5-11 5-16 1Zm-3 4-6 17 9-6 9 6-6-17"/><circle cx="20" cy="16" r="4"/>',
    "vase": '<path d="M12 6h16v5l-4 7 6 16c-5 4-15 4-20 0l6-16-4-7V6Zm4 12h8m-11 9h14"/>',
    "shears": '<circle cx="9" cy="31" r="5"/><circle cx="23" cy="31" r="5"/><path d="M13 27 30 6l5-2-2 5-16 18M20 27 6 7m15 5 6 6"/>',
    "bloom": '<circle cx="20" cy="19" r="4"/><path d="M20 15c-5-10 5-16 7-7 1 4-2 7-7 7Zm4 4c10-5 16 5 7 7-4 1-7-2-7-7Zm-4 4c5 10-5 16-7 7-1-4 2-7 7-7Zm-4-4C6 24 0 14 9 12c4-1 7 2 7 7ZM20 23v14"/>',
    "hammer": '<path d="m9 8 17-4 5 7-9 7-4-4-9 2V8Zm11 8 11 18-5 3-11-18"/>',
    "wrench": '<path d="M28 4a10 10 0 0 0-9 14L5 32l4 4 14-14A10 10 0 0 0 36 9l-7 7-5-5 7-7h-3Z"/>',
    "ruler": '<path d="m5 29 24-24 7 7-24 24-7-7Zm7-7 4 4m2-10 4 4m2-10 4 4"/>',
    "bolt": '<path d="M15 3h10l-2 14h9L17 37l2-15h-9L15 3Z"/>',
    "paintbrush": '<path d="m28 4 8 8-17 17-8-8L28 4Zm-17 17C7 22 5 27 5 34c8 0 12-3 14-5m6-21 7 7"/>',
    "ticket": '<path d="M6 8h28v8c-5 0-5 8 0 8v8H6v-8c5 0 5-8 0-8V8Zm17 0v4m0 5v5m0 5v5M11 15h7m-7 9h7"/>',
    "popcorn": '<path d="M7 14h26l-3 22H10L7 14Zm3 0c-4-2-3-8 2-8 2-5 7-5 10-1 5-4 10-1 9 4 4 0 6 4 2 5M13 20l2 12m12-12-2 12"/>',
    "drum": '<ellipse cx="20" cy="12" rx="14" ry="6"/><path d="M6 12v17c0 8 28 8 28 0V12M6 20l28 9M34 20 6 29m9-22-5-5m15 5 5-5"/>',
    "cupcake": '<path d="M9 19h22l-3 17H12L9 19Zm1 0c-6-5-1-11 5-9 0-6 10-8 12-2 7-1 9 7 4 11M15 25h10m-8 6h6M20 4V2"/>',
    "hourglass": '<path d="M9 5h22M9 35h22M12 5c0 9 8 11 8 15s-8 6-8 15m16-30c0 9-8 11-8 15s8 6 8 15M14 12l6 5 6-5m-12 18 6-5 6 5"/>',
    "magnifier": '<circle cx="16" cy="16" r="11"/><path d="m24 24 12 12-4 4-12-12M10 16a6 6 0 0 1 6-6"/>',
    "bottle": '<path d="M15 4h10v6H15V4Zm2 6v5c-6 3-9 9-9 15 0 7 24 7 24 0 0-6-3-12-9-15v-5M9 27h22M14 32h12"/>',
}

ICONS.update({
    "cottage": '<path d="M5 18 20 5l15 13M9 16v20h22V16M15 36V24h10v12M13 20h4m6 0h4M4 36h32"/>',
    "mushroom": '<path d="M4 22C4 9 11 5 20 5s16 4 16 17H4Zm10 0v10c0 5 12 5 12 0V22M8 17h24m-19-5h2m10 1h2"/>',
    "frog": '<path d="M6 18c0-7 6-12 14-12s14 5 14 12v8c0 6-6 10-14 10S6 32 6 26v-8Zm2-9c0-6 8-6 8 0m8 0c0-6 8-6 8 0M13 22h1m12 0h1M15 29c3 3 7 3 10 0"/>',
    "snail": '<circle cx="16" cy="21" r="10"/><path d="M16 13a8 8 0 1 1-8 8c0-4 3-6 6-6 4 0 6 3 6 6 0 3-2 5-5 5s-4-2-4-4M7 29H4c0 5 4 7 9 7h19c5 0 7-3 5-7l-4-5V13m0 0-2-6m2 6 3-6M28 11h2m6 0h2"/>',
    "owl": '<path d="M9 13 5 4l10 5h10l10-5-4 9v14c0 6-5 10-11 10S9 33 9 27V13Zm3 7a4 4 0 1 0 8 0 4 4 0 0 0-8 0Zm8 0a4 4 0 1 0 8 0 4 4 0 0 0-8 0Zm-3 7 3 3 3-3M15 37v2m10-2v2"/>',
    "fox": '<path d="M6 16 5 3l10 7h10l10-7-1 13c3 11-3 20-14 20S3 27 6 16Zm6 7h2m12 0h2m-11 6 3 3 3-3m-3 3v3m-8-16-4-3m24 3 4-3"/>',
    "rabbit": '<path d="M9 17C4 6 8 2 13 5l5 11h4L27 5c5-3 9 1 4 12 5 5 5 12 1 16-5 5-19 5-24 0-4-4-4-11 1-16Zm4 8h2m10 0h2m-9 5 2 2 2-2m-2 2v3"/>',
    "bee": '<path d="M7 23c0-7 6-11 13-11s13 4 13 11-6 11-13 11S7 30 7 23Zm6-9C5 9 8 3 15 5l5 7m7 2c8-5 5-11-2-9l-5 7M13 17v13m8-17v21m8-17v13M6 23H2m36 0h-4"/>',
    "butterfly": '<path d="M20 11C10-2 2 5 6 16c-9 9-1 18 14 8 15 10 23 1 14-8 4-11-4-18-14-5Zm0 0v19M9 12l7 5m15-5-7 5M9 24l7-3m15 3-7-3M17 8l-3-5m9 5 3-5"/>',
    "robot": '<path d="M8 12h24v22H8V12Zm12 0V5m-4 0h8M13 19h3m8 0h3m-14 8h14M8 25H4m28 0h4M13 34v4m14-4v4"/>',
    "duck": '<path d="M8 18c0-8 5-13 12-13s12 5 12 13v5l5 2-5 4v2c-3 7-21 7-24 0v-2l-5-4 5-2v-5Zm8 1h1m7 0h1m-5 4v5m-4 0 4 3 4-3M13 36v3m14-3v3"/>',
    "horse": '<path d="M7 32V20c0-5 5-8 10-8h7l5-8 6 3-2 7 4 5-3 5-6-2-5 4v6H7Zm5 0v7m14-7v7M7 25 3 19m24-6 5 1m-2 4h1M7 32h22"/>',
    "dice": '<rect x="6" y="6" width="28" height="28" rx="4"/><circle cx="13" cy="13" r="1.5"/><circle cx="27" cy="13" r="1.5"/><circle cx="20" cy="20" r="1.5"/><circle cx="13" cy="27" r="1.5"/><circle cx="27" cy="27" r="1.5"/>',
    "arcadecab": '<path d="M9 5h22l3 31H6L9 5Zm3 4h16v12H12V9Zm2 17h6m5 0h2m-10 5h2m8 0h2M6 36h28"/>',
    "alien": '<path d="M20 5C9 5 5 14 8 26c2 7 7 10 12 10s10-3 12-10C35 14 31 5 20 5Zm-8 15c0-5 6-5 7 1-2 4-6 4-7-1Zm16 0c0-5-6-5-7 1 2 4 6 4 7-1ZM16 30c3 2 5 2 8 0"/>',
    "ufo": '<path d="M11 20c1-9 5-14 9-14s8 5 9 14M4 21c0-4 7-6 16-6s16 2 16 6-7 8-16 8S4 25 4 21Zm11 13 5-4 5 4M11 35h18"/>',
    "boat": '<path d="M5 23h30l-4 11c-7 4-15 4-22 0L5 23Zm15-19v19M20 6 8 20h12m2-13 10 13H22M4 37c5-2 9-2 13 0 4-2 9-2 13 0 3-1 5-1 8 0"/>',
    "camel": '<path d="M5 29V19l6-2 4-8 5 8 4-7 6 8h2V9l4-4 3 2-1 6-3 3v13H5Zm5 0v10m21-10v10M5 20 2 17M33 13l5 2m-7-3h1"/>',
    "lizard": '<path d="M9 22c2-7 9-9 17-6l7-5 3 4-5 7c1 8-6 13-15 11l-9 4-3-4 7-7-2-4Zm15-3h2m-10 3-8-9m10 18-7-7m17-3 8 8"/>',
    "cat": '<path d="M7 16 6 4l10 7h8L34 4l-1 12c4 10-1 20-13 20S3 26 7 16Zm6 7h2m10 0h2m-10 6 3 2 3-2m-3 2v3M5 28l9 1m21-1-9 1"/>',
    "crane": '<path d="M20 21 5 9l13 3L30 4l-3 14 9 7-13-2-7 13 1-13L5 31l8-11m7 1 7-3"/>',
    "tram": '<path d="M6 10h28v22H6V10Zm4 5h8v8h-8v-8Zm12 0h8v8h-8v-8ZM6 27h28M12 32l-3 5m19-5 3 5M15 5h10m-5 0v5"/>',
    "mouse": '<path d="M7 18C4 12 7 6 13 6c4 0 6 2 7 5 1-3 3-5 7-5 6 0 9 6 6 12 3 10-3 18-13 18S4 28 7 18Zm7 4h1m10 0h1m-8 6 2 2 2-2m-2 2v3M5 32c-4 3-3 7 1 7"/>',
    "ghost": '<path d="M8 35V19C8 8 13 4 20 4s12 4 12 15v16l-6-4-6 4-6-4-6 4Zm7-17h2m6 0h2m-10 8c3 3 7 3 10 0"/>',
    "dinosaur": '<path d="M5 31 2 24l8 3c2-7 8-12 17-10V7l3-5 7 3-1 5-4 2v15c0 7-4 9-10 9H5v-5Zm8 5v3m15-4v4m-2-28h2M9 24l-4-3M16 17l2-5 3 5m0 0 3-5 3 6"/>',
    "bird": '<path d="M6 24c0-9 6-16 14-16s14 7 14 16-6 12-14 12S6 33 6 24Zm5-2c5-3 10-2 13 3m0-8h2m8 5 5 2-5 3M15 35v4m10-4v4"/>',
})

THEMES = {
    "contours": ("Enchanted Paths", "cottage mushroom frog snail lantern"),
    "ridgeline": ("Moonlit Trail", "owl fox rabbit tent pine"),
    "botanical": ("Secret Greenhouse", "bee snail butterfly pot watering"),
    "arcade": ("Pocket Carnival", "robot duck horse dice arcadecab"),
    "orbits": ("Stargazer Club", "alien ufo rocket telescope planet"),
    "rainfall": ("Puddle Parade", "frog duck umbrella rubberboot boat"),
    "confetti": ("Midnight Celebration", "fox rabbit cake balloon gift"),
    "dunes": ("Desert Daydream", "camel lizard cactus sun canteen"),
    "fan": ("The Little Atelier", "cat crane paintbrush foldingfan vase"),
    "citylights": ("After Hours Stroll", "fox bicycle streetlamp storefront tram"),
    "petals": ("Sweet Shop", "mouse fox cupcake teapot biscuit"),
    "geometry": ("Curiosity Cabinet", "ghost dinosaur bird hourglass magnifier"),
}


def positions(seed: int, count: int = 25) -> list[tuple[float, float]]:
    """Relax a farthest-point seed into even, seamless object spacing."""
    rng = random.Random(seed)
    points: list[tuple[float, float]] = []
    for _ in range(count):
        best = None
        best_distance = -1.0
        for _ in range(220):
            x, y = rng.random() * SIZE, rng.random() * SIZE
            distance = min((min(abs(x-px), SIZE-abs(x-px)) ** 2 +
                            min(abs(y-py), SIZE-abs(y-py)) ** 2) for px, py in points) if points else SIZE**2
            if distance > best_distance:
                best, best_distance = (x, y), distance
        points.append(best)
    # A farthest-point cloud has a few large cells and a few crowded pairs. Move
    # each center toward the center of its periodic Voronoi cell. Sampling the
    # same 4-unit grid on every iteration makes the result deterministic.
    for _ in range(16):
        sums = [[0.0, 0.0, 0] for _ in points]
        for sy in range(2, SIZE, 4):
            for sx in range(2, SIZE, 4):
                nearest = -1
                best_distance = float("inf")
                best_dx = best_dy = 0.0
                for index, (px, py) in enumerate(points):
                    dx = (sx - px + SIZE / 2) % SIZE - SIZE / 2
                    dy = (sy - py + SIZE / 2) % SIZE - SIZE / 2
                    distance = dx * dx + dy * dy
                    if distance < best_distance:
                        nearest, best_distance, best_dx, best_dy = index, distance, dx, dy
                sums[nearest][0] += best_dx
                sums[nearest][1] += best_dy
                sums[nearest][2] += 1
        points = [((x + .8 * dx / samples) % SIZE,
                   (y + .8 * dy / samples) % SIZE)
                  for (x, y), (dx, dy, samples) in zip(points, sums)]
    return points


def tile(theme_id: str, title: str, names: str, seed: int) -> str:
    names = names.split()
    rng = random.Random(seed + 1000)
    defs = "".join(
        f'<g id="{name}" fill="none" stroke="white" stroke-width="2.7" '
        f'stroke-linecap="round" stroke-linejoin="round">{ICONS[name]}</g>'
        for name in names
    )
    uses = []
    for i, (x, y) in enumerate(positions(seed)):
        name = names[(i * 7 + i // 5) % len(names)]
        angle = rng.choice((-24, -17, -10, -5, 6, 12, 19, 27))
        scale = (rng.uniform(1.04, 1.10) if i % 6 == 0 else
                 rng.uniform(.86, .91) if i % 6 == 3 else
                 rng.uniform(.93, 1.03))
        opacity = rng.choice((.75, .82, .89, .96))
        for dx in (-SIZE, 0, SIZE):
            for dy in (-SIZE, 0, SIZE):
                if not (-30 < x + dx < SIZE + 30 and -30 < y + dy < SIZE + 30):
                    continue
                uses.append(
                    f'<use href="#{name}" transform="translate({x+dx:.1f} {y+dy:.1f}) '
                    f'rotate({angle}) scale({scale:.2f}) translate(-20 -20)" opacity="{opacity}"/>'
                )
    return (f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
            f'viewBox="0 0 {SIZE} {SIZE}"><title>{title}</title><defs>{defs}</defs>'
            f'<g>{"".join(uses)}</g></svg>\n')


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for index, (theme_id, (title, names)) in enumerate(THEMES.items()):
        (OUT / f"{theme_id}.svg").write_text(tile(theme_id, title, names, 4127 + index * 109))


if __name__ == "__main__":
    main()
