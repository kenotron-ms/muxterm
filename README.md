# Browser evidence for PR #212

Screenshot of the sidebar rail from the verification run described in
[PR #212](https://github.com/kenotron-ms/muxterm/pull/212). Captured in a real
Chromium (playwright-cli) against an isolated dev instance on `127.0.0.1:8351`
with its own `XDG_RUNTIME_DIR=/tmp/muxterm-newsession` and `XDG_DATA_HOME`.
Production on 9090/8311 was never touched.

**This branch is an orphan and is never merged.** It exists so a reviewer can
see the pixels on the pull request page instead of a local filesystem path.
Nothing here is code; `main` is unaffected, and no artifact is committed to the
PR's source branch (`feat/sidebar-new-session-button`) — per AGENTS.md,
"Verification evidence storage".

| file | shows |
|---|---|
| `sidebar-new-session-20260925.png` | the rail, top to bottom: `Mission Control` → `Connect machine` (computer icon) → `New Session` (chat icon) → `Inbox`, all on Mission Control's shared `railEntryStyles` |

Same mechanism as `evidence/pr-117`.
