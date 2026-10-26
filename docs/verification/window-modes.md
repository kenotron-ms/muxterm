# Window modes during UI verification

Use a fresh `make dev-local` instance on port 8313. Production ports 8311 and
9090 are never targets. Create a new chat and pane for each manual browser run.

| Mode | How to run | What it checks |
| --- | --- | --- |
| Browser tab | `playwright-cli open http://127.0.0.1:8313` | The ordinary web title row and sidebar. |
| Installed PWA with WCO | `xvfb-run -a -s '-screen 0 1920x1080x24' node web/scripts/capture-window-modes.mjs /home/ken/artifacts/<task-directory>` on headless Linux, or omit `xvfb-run` on a desktop with a display | Installs into a disposable Chrome profile, launches a real app window, asserts WCO is visible, and saves web/PWA screenshots and layout data. Requires Google Chrome. |
| Native macOS desktop | Run the **Mac App** workflow on the branch, download its `muxterm-macos-arm64` artifact, and open it on a disposable Mac. Local Mac builds use `desktop/build-mac.sh`. | The Wails/WebKit window and bundled server. It cannot run on Linux or substitute for the Chromium PWA. |

The capture command uses a separate Chrome profile inside the artifact directory
and exits after taking screenshots. By default it checks the New chat title row.
Pass a fresh dev-local chat ID as the second argument to open its utility pane and
check the tab row, font, and fills in both modes. Store detailed captures under
`/home/ken/artifacts/`; commit only a focused final screenshot if a PR needs
durable visual evidence.
