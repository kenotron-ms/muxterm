# Illustrated chat backdrops: final review

The [contact sheet](contact-sheet.png) shows all twelve seamless 240px tiles at their display size. Each tile has five different original object drawings. Their white SVG strokes act as a mask; the active light or dark app palette supplies the visible ink. The pattern uses 10% accent ink in light chat and 12% in dark chat, keeping messages readable.

| Backdrop | Story objects | Visual review |
| --- | --- | --- |
| Enchanted Paths | cottage, mushroom, frog, snail, lantern | Pass |
| Moonlit Trail | owl, fox, rabbit, tent, pine | Pass |
| Secret Greenhouse | bee, snail, butterfly, pot, watering can | Pass |
| Pocket Carnival | robot, duck, horse, dice, arcade cabinet | Pass |
| Stargazer Club | alien, UFO, rocket, telescope, planet | Pass |
| Puddle Parade | frog, duck, umbrella, rubber boot, boat | Pass |
| Midnight Celebration | fox, rabbit, cake, balloon, gift | Pass |
| Desert Daydream | camel, lizard, cactus, sun, canteen | Pass |
| The Little Atelier | cat, crane, paintbrush, folding fan, vase | Pass |
| After Hours Stroll | fox, bicycle, streetlamp, storefront, tram | Pass |
| Sweet Shop | mouse, fox, cupcake, teapot, biscuit | Pass |
| Curiosity Cabinet | ghost, dinosaur, bird, hourglass, magnifier | Pass |

The snail, horse, camel and dinosaur silhouettes were refined after the first sheet. Final review checked object recognition, spacing, repeat seams and message readability in a real chat at desktop, 390px and 320px widths, plus all twelve Appearance choices. The screenshots here were captured in Chromium against isolated `make dev-local` with a real sessiond and workspace: [dark phone](chat-dark-phone.png), [light phone](chat-light-phone.png), [dark desktop](chat-dark-desktop.png), [dark Appearance](appearance-dark.png), and [light Appearance](appearance-light.png).

## Size and angle refinement

The [before/after contact sheet](size-angle-before-after.png) compares all twelve patterns at their actual CSS display sizes and dark chat ink strength. The new 384px tiles give each story small, medium, and large versions of its original objects, with varied angles and a consistent dense rhythm. Upright objects such as cottages, storefronts, and lamps keep gentler tilts. Edge-crossing objects have wrapped copies so the tile repeats without cut-off seams. Backdrop IDs, palette-derived color, and Plain are unchanged.

The final Chromium views from isolated dev-local show [dark desktop chat](variation-chat-dark-desktop.png), [light desktop chat](variation-chat-light-desktop.png), [dark 390px chat](variation-chat-dark-390.png), [light 320px chat](variation-chat-light-320.png), [dark 320px Appearance](variation-appearance-dark-320.png), and [light 390px Appearance](variation-appearance-light-390.png). The browser pass checked each of the twelve choices in Appearance and in open and message-heavy chats at desktop, 390px, and 320px in both modes. Plain and an illustrated choice persisted after reload.
