# Browser evidence for PR #117

Screenshots of the real Pull Requests applet in a real Chromium (Playwright),
driven against an isolated muxterm on `127.0.0.1:8322` with its own
`XDG_RUNTIME_DIR` and `XDG_DATA_HOME`. Production on 9090/8311 was never
restarted and never written to.

**This branch is an orphan and is never merged.** It exists so a reviewer can
see the pixels without anything of the author's still running. Nothing here is
code; `main` is unaffected.

| file | verdict it proves |
|---|---|
| `C1-before-error.png` | C1 — the bug, on a v0.29.0 build |
| `C2-collected.png` | C2 — collected from sessions, two repos, lane names |
| `C3-outlives-lanes.png` | C3 — after the lanes, the workspaces, the completion log and both processes are gone |
| `C4-dismiss-persists.png` | C4 — dismissal after a reload |
| `C5-degraded.png` | C5 — `gh` off `PATH`, list intact |
| `C6-controls.png` | C6 — the applet's controls below the host's tab strip |

---

## Follow-on: `fix/collect-every-pr-a-lane-opens`

| file | verdict it proves |
|---|---|
| `F1-two-prs-one-lane.png` | one lane opened two pull requests, in two repositories; both are collected, both name that lane |

---

## Verified against `origin/main` after the merge

Everything above was captured from the PR branch. These two were captured from
a build of **`origin/main` at `3226495`**, which contains merge `c8097a4` — i.e.
the shipped code, not a proposal.

| file | shows |
|---|---|
| `M1-main-applet.png` | three PRs collected from three lanes in two repositories, after every lane's workspace was closed; no directory error anywhere |
| `M2-main-dismiss-reload.png` | `#112` dismissed, page reloaded, still dismissed — server-side, `dismissed: ['kenotron-ms/muxterm#112']` on disk |

---

## Defect found after shipping: a narrow pane lost its pull request

| file | shows |
|---|---|
| `W1-narrow-pane-collected.png` | a lane whose `gh pr create` URL hard-wrapped in a 40-column pane, now collected. On `main` this row does not exist at all. |
