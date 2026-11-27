# Mobile Files: browse to preview concepts

These are interactive, browser rendered design mockups for review. Open [the prototype](index.html) with `?concept=focus` or `?concept=peek`; add `&state=browse`, `preview`, `actions`, `quick`, `html`, `error`, or `empty` to jump to a scene. The prototype uses realistic project files and a nested Markdown document. Its controls demonstrate navigation and menu placement; file operations are illustrative.

## Existing experience reviewed

The [Files Storybook scenes](../../../web/src/components/mux-sdk-utility.stories.ts) cover tree browsing, nested Markdown preview, Quick Open results and failures, file actions, HTML preview and failure, file load failure, oversized files, and empty states. I also inspected the current [Files layout](../../../web/src/components/mux-sdk-utility.ts) in source and rendered its desktop and 390px nested preview scenes in a browser. Desktop has a generous document beside the tree. At phone width the tree becomes a lower pane, taking 38% of the vertical space even while reading. The preview header, status row, file tree toolbar and main utility tab bar further divide the remaining height.

## Concept A: full page focus

The file list and the preview each get the full content area. Opening a file replaces the list. A clear back control and a persistent **Browse files** button return to the list; **Quick Open** stays in thumb reach. File actions open a native style bottom sheet. This preserves the desktop's document styling while removing the phone's lower tree pane.

| State | 390px | 320px |
| --- | --- | --- |
| Browse | [Screenshot](focus-390-browse.png) | [Screenshot](focus-320-browse.png) |
| Nested preview | [Screenshot](focus-390-preview.png) | [Screenshot](focus-320-preview.png) |
| File actions | [Screenshot](focus-390-actions.png) | [Screenshot](focus-320-actions.png) |
| Quick Open | [Screenshot](focus-390-quick.png) | [Screenshot](focus-320-quick.png) |
| HTML preview | [Screenshot](focus-390-html.png) | — |
| File unavailable | [Screenshot](focus-390-file-error.png) | — |
| HTML preview unavailable | [Screenshot](focus-390-html-error.png) | — |
| Folder unavailable | [Screenshot](focus-390-error.png) | — |
| Empty folder | [Screenshot](focus-390-empty.png) | — |

## Concept B: contextual peek

The browser remains the base screen. A file preview rises over it as a large sheet, leaving a strip of tree visible; it can expand to full height. Back or tapping outside closes the preview. Quick Open and actions use sheets as well. This keeps the browse context visible but nests sheets when file actions open.

| State | 390px | 320px |
| --- | --- | --- |
| Browse | [Screenshot](peek-390-browse.png) | [Screenshot](peek-320-browse.png) |
| Nested preview | [Screenshot](peek-390-preview.png) | [Screenshot](peek-320-preview.png) |
| File actions | [Screenshot](peek-390-actions.png) | [Screenshot](peek-320-actions.png) |
| Quick Open | [Screenshot](peek-390-quick.png) | [Screenshot](peek-320-quick.png) |
| HTML preview | [Screenshot](peek-390-html.png) | — |
| File unavailable | [Screenshot](peek-390-file-error.png) | — |
| HTML preview unavailable | [Screenshot](peek-390-html-error.png) | — |
| Folder unavailable | [Screenshot](peek-390-error.png) | — |
| Empty folder | [Screenshot](peek-390-empty.png) | — |

## Recommendation

**Choose Concept A.** It has the strongest reading space at 390px and 320px, one clear browse/preview mode at a time, and obvious return controls. Quick Open and actions are reachable near the bottom. It carries the desktop preview and project vocabulary forward without squeezing a tree under the document. The tradeoff is that the tree is hidden during reading; the persistent **Browse files** control makes the return path explicit and should preserve tree expansion and scroll position in implementation.

Concept B better preserves immediate spatial context and makes opening a file feel lightweight. Its 82% preview can feel cramped on a short phone, and opening actions creates a sheet over a sheet. The expand control helps reading space but adds another mode to learn. Both concepts use explicit labels rather than relying on a small folder icon alone.

The mockups deliberately stop at design. They do not change the production Files UI, and interactions such as download, Ask about file, source rendering and real sandbox execution are represented only by their controls.
