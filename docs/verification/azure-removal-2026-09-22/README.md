Sandbox removal completed with SSH/remote machines intact and startup verified: YES.

Verification used this branch, `make dev-local` on port 8313, separate temporary runtime/data directories, and a copy of the owner's real config. No unit tests ran or were added. Production services, the live config, other worktrees, the owner's broker, Amplifier source/cache, and Azure resources were not modified. The disposable SSH container was a fixture: real OpenSSH, this branch's real muxterm binary, real sessiond, real shell processes. No mock or stub supplied the connection or terminal output.

## Boundary mapped before deletion

| Sandbox-only surface removed | Shared/surviving surface |
| --- | --- |
| `internal/sandboxazure`, config/profile schema, lifecycle availability/presentation/store/provider | General TOML loader and config round-trip; owner-only `Cos` remains excluded from JSON |
| Sandbox CLI, API routes and `WrapSandbox` | Normal authentication, config API, server startup |
| `internal/sandboxingress`, sandbox agent/ingress binaries, relay experiment and offline verifier | `sessiond-connect`, `DialConn`, frozen sessiond protocol and daemon |
| `internal/transport/relay`, broker/worker enrollment, relay JSON watcher and settings API/UI | `RemoteTransport`, `HostRef`, SSH transport/deployment adapter, remote manager and `/api/remotes` |
| Combined SSH/sandbox transport wrapper | Startup, local mode and MCP now inject `newSSHRemoteTransport()` directly |
| `sandboxes.ts`, Settings Sandboxes tab/actions/polling, sidebar inventory | Remotes Settings, connect dialog, remote host groups, workspace creation, MCP `machine:` and `list_machines` |
| Sandbox docs, scripts, evidence images and future sandbox transport/upload plans | SSH design and upload planning |

The remaining `sandbox request` waiting state in session-state, mux-home and mobile-demo describes agent filesystem permissions (the demo requests a file outside its workspace). It is not an Azure workspace. Codex approval/sandbox flags, HTML/CSP/iframe isolation, and unrelated browser/daemon relay code remain. The artifact API's iframe discussion is unrelated to machine provisioning. README and AGENTS contain only these unrelated meanings. Historical config-write evidence records its original sandbox presentation error.

Shared implementation comparison returned no changes:

```text
git diff --exit-code origin/main -- internal/transport/ssh internal/server/remotes.go internal/server/remotes_api.go internal/mcp/run.go internal/sessiond/protocol.go internal/sessiond/client.go cmd/muxterm/remote_transport.go
Shared SSH implementation diff exit=0
```

Only explanatory comments changed in `machines.go`, `transport.go`, `sessiond_connect.go`, and `sessiond/server.go`.

Shared SSH/Local badge CSS was separated from the deleted sandbox selector. Final browser computed styles ([receipt](badge-styles.log)):

```json
{"text":"Local","fontSize":"8px","flexShrink":"0","borderRadius":"3px"}
```

The SSH screenshot predates this final badge-style correction; terminal transport and behavior were unchanged by it.

## Static verification

```text
go build ./... exit=0
go vet ./... exit=0
npm run build exit=0
npm run check:fast exit=0
Warnings: 13
Errors: 0
```

Go build/vet emitted no diagnostics. Full web build and check output is in [web-build.log](web-build.log) and [web-check.log](web-check.log). The lint warnings remain visible in the latter. The final bundle output included:

```text
vite v6.4.2 building for production...
transforming...
✓ 14 modules transformed.
rendering chunks...
computing gzip size...
dist-public/public-doc.js  70.25 kB │ gzip: 22.79 kB
✓ built in 272ms
```

Removed symbols, config schema, API paths and transport references: [exact ripgrep command](symbol-scan.txt).

```text
rg removed-symbol scan:
exit=1; hits=0
```

## Real config startup and settings save

The copied TOML was byte-identical before startup, with `sandbox_azure.enabled = true` and one populated profile. Live/copy SHA-256:

```text
ae83cfebaf1e0cb50c7fe8dfc72554aaa96a6f596a814a4e399fe74566215920
sandbox_azure enabled: True
profile count: 1
2026/09/22 16:34:45 muxterm listening on 127.0.0.1:8313 (from --addr)
```

Command (no live config writes):

```sh
TMPDIR=/tmp/muxterm-removal-verify/runtime XDG_CONFIG_HOME=/tmp/muxterm-removal-verify/config make dev-local
```

The existing TOML decoder accepts unknown sections. There is no compatibility schema or feature flag. A subsequent real HTTP settings save against the isolated instance produced:

```text
PATCH /api/config HTTP 200
Retained [cos] identical after settings save: PASS
Changed font size persisted: PASS
Live config SHA256 unchanged: ae83cfebaf1e0cb50c7fe8dfc72554aaa96a6f596a814a4e399fe74566215920
Removed unknown Azure section discarded on settings save: True
```

The browser JSON omitted both `cos` and the obsolete Azure section. The generic round-trip machinery remained unchanged. Unknown obsolete Azure TOML was ignored on load and discarded on the next settings save of the copy; `[cos]` survived intact.

The owner's optional cleanup is **lines 68–89 inclusive** of `/home/ken/.config/muxterm/config.toml`: `[sandbox_azure]` at 68, its `enabled`, `kill_switch`, and `store_dir`, then `[[sandbox_azure.profile]]` at 73 and every field through `egress_hosts` at 89 (EOF). No other lines. The live file remained unchanged.

## Browser and real SSH verification

Playwright CLI observed the real running app and clicked Settings → Remotes. [Snapshot](settings-final.log):

```text
- button "Appearance"
- button "Notifications"
- button "AI"
- button "Voice"
- button "Remotes"
- generic: From ~/.ssh/config
```

No Sandboxes tab or inventory remained. Removed mutation routes answered:

```text
POST /api/sandboxes HTTP 404
PUT /api/relay HTTP 404
404 page not found
404 page not found
```

Playwright connected the disposable SSH fixture via the normal Connect machine dialog. [Browser snapshot](ssh-browser.log) showed `removal-fixture SSH`; the real API returned:

```json
{"connected":[{"id":"ssh:removal-fixture","name":"removal-fixture","target":"removal-fixture","transport":"ssh","managed":false,"state":"connected","probe":"present","path":"/usr/local/bin/muxterm"}],"discovered":[],"errors":[]}
```

[Raw MCP responses](final-mcp.log) recorded `list_machines` probing `ssh:removal-fixture` as reachable, creation/switch to a fresh `final-ssh-proof` workspace, creation of its pane, `send_input` with `machine: "ssh:removal-fixture"`, and `get_screen`. The local daemon initially did not exist before browser attachment; the remote probe succeeded independently.

Playwright then selected that remote workspace, focused xterm's hidden textarea and sent actual keyboard events. The remote daemon screen read back via MCP contained:

```text
# printf SSH_REMOVAL_PROOF; hostname
SSH_REMOVAL_PROOFf636f4b33d5c
# printf BROWSER_SSH_REMOVAL_PROOF; hostname
BROWSER_SSH_REMOVAL_PROOFf636f4b33d5c
#
```

[Raw daemon screen receipt](browser-daemon-screen.log), [browser screenshot](final-ssh.png). Earlier locator clicks timed out on the hidden xterm textarea; direct focus resolved the verification interaction. The fixture's default `/bin/sh` did not emit OSC completion markers, so an earlier `run_command` returned `exit_code: -1` despite capturing command output. Final verification used `send_input` and the actual daemon screen. No shell-completion claim was based on that timeout. Browser startup logged one script-fetch HTTP 404; settings and SSH verification completed with that console error recorded.

## Existing PRs and branches — inventory only

PR #161 (`feat/https-sandbox-relay`) was already MERGED on 2026-09-21T07:27:17Z. It was not open. [Open PR query](open-prs.json), [branch names and subjects](branch-subjects.txt), [worktree inventory](worktrees.txt).

Recommendation: close these five obsolete sandbox-evidence PRs without merging after this removal lands; archive their evidence in Git history. No PR was closed and no existing branch was deleted or force-pushed.

| Open PR | Branch |
| --- | --- |
| [#172](https://github.com/kenotron-ms/muxterm/pull/172) | `verify/sandbox-live-0605` |
| [#170](https://github.com/kenotron-ms/muxterm/pull/170) | `docs/relay-broker-unavailable-20260922` |
| [#168](https://github.com/kenotron-ms/muxterm/pull/168) | `verify/sandbox-live-20260922` |
| [#165](https://github.com/kenotron-ms/muxterm/pull/165) | `verify/sandbox-live-recheck` |
| [#164](https://github.com/kenotron-ms/muxterm/pull/164) | `docs/relay-endpoint-verification-20260921` |

The query contained **five** open sandbox-related PRs. The initial progress update counted six; that count was corrected from the saved query.

Recommendation: retire the local/origin copies of those five branches plus `docs/sandbox-live-blocker-20260920`, `feat/https-sandbox-relay`, and `feat/sandbox-relay-startup` after owner review; also retire origin-only `design/amplifier-sandboxes`, `feat/direct-azure-sandbox-v1`, and `docs/aca-egress-investigation-b1d205bf`. Preserve this removal branch until merged.

Associated worktrees remained untouched: `muxterm-azure-enable-20260922` (detached), `muxterm-relay-current-proof`, `muxterm-relay-endpoint-verification`, `muxterm-sandbox-live`, `muxterm-sandbox-live-0605`, `muxterm-sandbox-live-20260922`, `muxterm-sandbox-live-blocker`, `muxterm-sandbox-recheck` under `/home/ken/work`, and `/home/ken/workspace/muxterm-https-relay`. Recommendation: the owner can archive/remove these after preserving any uncommitted work. No cleanup was performed on them.

Two keyword/subject matches are not sandbox branches: `origin/gb/crash-recovery/recovery-relay-ui` is browser recovery relay work, and `fix/operator-name-badges-20260921` merely points at a sandbox-startup merge commit. Recommendation: retain both and assess them separately. No merge or release was performed.
