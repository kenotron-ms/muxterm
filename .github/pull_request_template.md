## Interface review

For UI changes, name the Storybook pattern used or link the new story. Describe
any specialized control and add it to `docs/design-system/inventory.md`.

- [ ] New or changed states are visible in Storybook.
- [ ] Feature styles use `--ui-*` semantic tokens; I lowered the baseline for removed legacy styling or native controls, or documented a necessary exception in the inventory.
- [ ] I reviewed the changed screen in isolated dev-local Chromium at wide and phone widths and attached final screenshots.
- [ ] `npm run check:fast`, `npm run check:ui`, `npm run build:storybook`, and `go build ./...` pass.

For non-UI changes, these interface items are not applicable.
