# Landing report — today's PRs, v0.25.0, and the production upgrade

Written **before** the upgrade, because the upgrade terminates the pane this
session runs in. Anything after the `POST /api/update/apply` line is appended
only if this session survived, which it is not expected to.

---

## Phase 1 — Triage

| PR | Branch | Verdict | Reason |
|---|---|---|---|
| **#91** | `fix/one-token-for-top-chrome` | **ALREADY MERGED** | The title-bar token from the brief. Merged 20:17:34Z as #91, before this lane started. Tip of main on arrival (`3128981`). No action. |
| **#73** | `fix/dashboard-brand-markdown-titlebar` | **ALREADY CLOSED** | Closed 20:13:01Z by the earlier lane, four minutes before #91 landed. Confirmed, not reopened. |
| **#92** | `feat/remote-read-only-fs` | **MERGE** | CI `review` SUCCESS, MERGEABLE/CLEAN. Backend-only (Go), no overlap with the web work. Refusal invariant verified before merging (below). |
| **#89** | `feat/voice-orb-sole-control` | **MERGE** | CI `review` SUCCESS, MERGEABLE/CLEAN. The judgement call resolved in favour of merging — see below. |
| **#93** | `feat/mission-control-applets` | **MERGE** | CI `review` SUCCESS. Needed a merge of main and two conflict resolutions in `mux-cos.ts`; CI re-run green afterwards. |
| **#94** | `fix/reconnect-promptly` | **HOLD** | Explicitly out of scope. That lane is still working and its fix is unfinished. Not merged, not waited for. Its branch **is** pushed (see Phase 4 risk). |
| #67, #34, #33, #32, #9, #2 | — | **OUT OF SCOPE** | All predate today. Left untouched. |

### The #89 judgement call — resolved by reading the diff, no compromise needed

The seventh component (a composer mode-switch letting the user return to the
text box while a session stays live) **is present**. The lane that was killed by
a restart had already landed it, plus two fixes on top:

```
009edea fix(voice): Escape unwinds the layers in solo mode too, not just defers
1e7bfbb fix(voice): Escape ends the call only when the Escape was ours
ce3de46 feat(voice): a way back to the keyboard that is not a hang-up   <-- C7
e09752b feat(voice): the orb is the whole composer while a session is live
```

Verified as wired, not merely styled, on the branch tip:

```
 294:  @state() private _textMode = false;          <- the mode state
2380:            class="tomode"                     <- rendered: to the keyboard
2411:    if (this._live && !this._textMode) return this._renderVoiceComposer();
2434:                  <span class="micon" role="status">
2435:                    <span class="micdot"></span><span class="micword">microphone open</span>
2438:                    class="micback"             <- rendered: back to the orb
```

So: **merged whole, all seven.** No gap to file. The decision recorded in
`ce3de46` is that switching back leaves the session running — the orb already
hangs up, so a switch that also hung up would be a second hang-up button rather
than a mode switch. The open microphone is stated in words while a text box is
on screen, which is what makes that safe.

---

## Phase 2 — Merges

Order: least entangled first, so each later rebase met the most settled main.
`#91` (2 files) was already in. Then `#92` (backend only, no web overlap), then
`#89` (one web file), then `#93` (26 files, rebuilds the same web file).

### CI before and after

| PR | CI before merge | Fix needed | CI after fix |
|---|---|---|---|
| #92 | `review` SUCCESS | none | — |
| #89 | `review` SUCCESS | none | — |
| #93 | `review` SUCCESS (original head `986cbf9`) | merge of main + 2 conflict resolutions | `review` SUCCESS (run `34171643807`, 17m) |

### Merge confirmations

```
#92  MERGED 2026-09-07T23:53:09Z  ->  428f6f6
#89  MERGED 2026-09-07T23:53:15Z  ->  07fdb6c
#93  MERGED 2026-09-08T00:13:18Z  ->  50cc66f
```

Merge-commit style matched the repo's existing habit (`gh pr merge --merge`,
producing `Merge pull request #N from kenotron-ms/<branch>`), not chosen fresh.

### The foreseeable `mux-cos.ts` conflict — resolved by keeping both

`#89` added +437 lines to `web/src/components/mux-cos.ts`; `#93` gutted the same
file to move the right-hand surface into an applet host. Exactly two conflicts,
both resolved by keeping **both** behaviours:

1. **State block.** Kept `#89`'s `_held` and `_textMode` (composer takeover and
   the way back to the keyboard) *alongside* `#93`'s `_sheetOpen`. The only
   thing dropped was main's doc comment for the cards/tiles `shape` state —
   whose variable `#93` deletes when the card grid moves into the Dashboard
   applet. Verified `shape` has no remaining referent in the file.
2. **`:focus-visible` list.** Added `#89`'s `.tomode` and `.micback` so the two
   new voice controls keep their focus ring. Dropped `.card`, whose markup left
   this file for the same reason as above (verified: 0 occurrences of `.card`
   in `#93`'s version).

Post-resolution presence check — both PRs' work survives:

```
#89 pieces:  _held 7  _textMode 7  _renderVoiceComposer 3  .cbox.solo 3
             .tomode 4  .micback 5  micon 2  "microphone open" 5  orb-box:64px 1
#93 pieces:  _sheetOpen 6  mux-applets 5  applet 25
```

Local verification of the merged tree (not a re-run of either PR's own
verification — just proof the *merge* is sound):

```
tsc --noEmit          clean
vite build            clean (built in 2.04s)
go build ./...        clean
go test ./internal/mcp/... ./internal/sessiond/... ./internal/server/...
  ok  internal/mcp        0.163s
  ok  internal/sessiond   7.399s
  ok  internal/server     0.050s
```

### The two decisions that must not be dropped — both verified on final main

**1. `close_workspace` / `close_pane` still refuse a remote machine.** `#90`'s
refusal survives `#92` intact:

```go
// internal/mcp/run.go:316
return "", fmt.Errorf("machine %q: refused -- %s. Nothing was done on this machine instead", name, reason)

// internal/mcp/run.go:568   close_workspace
// internal/mcp/run.go:629   close_pane
localOnly(destructiveRemoteRefusal, ...)
```

`lane_transcript` **did** become machine-scoped, which is the legitimate half —
`#92` removes the specific reason that refusal existed for, and says so in a
comment at `run.go:24`. Read widened; write did not.

**2. `#73`'s overruled rename was not reintroduced.** The assistant's role is
still "chief of staff" throughout `mux-cos.ts` (lines 5, 16, 1709, 1849, 1895).
`#93` renames only the *surface* to Mission Control, which is its own decision:

```
web/src/components/mux-cos.ts:1643:        <h1>Mission Control</h1>
```

### Resulting main

```
50cc66f Merge pull request #93 from kenotron-ms/feat/mission-control-applets
81a08e0 Merge origin/main into feat/mission-control-applets
07fdb6c Merge pull request #89 from kenotron-ms/feat/voice-orb-sole-control
428f6f6 Merge pull request #92 from kenotron-ms/feat/remote-read-only-fs
3128981 Merge pull request #91 from kenotron-ms/fix/one-token-for-top-chrome
```

Open PRs remaining: #94 (held, still being worked) and the six that predate today.

---

## Phase 3 — Release

**v0.25.0**, annotated tag on `50cc66f`, pushed; `release.yml` + goreleaser
published it.

```
tag: v0.25.0 | published: 2026-09-08T00:16:58Z | draft: False | prerelease: False
  checksums.txt               281
  muxterm_darwin_amd64.tar.gz 22192868
  muxterm_darwin_arm64.tar.gz 21972570
  muxterm_linux_amd64.tar.gz  22093598
```

Four merges since v0.24.0, 39 files, +7397 / −1093:

- **#93** Mission Control — the right-hand surface becomes an applet host
  (Dashboard, Files, Pull Requests; PR state read server-side via `gh`, so no
  credential in the browser)
- **#89** the orb is the whole composer while a voice session is live, plus the
  mode switch back to the keyboard that does not hang up
- **#92** `read_file` and `list_dir` across the machine boundary, and
  `lane_transcript` with them
- **#91** one token decides the height of the app's top chrome

Version comes from the tag alone (`-X main.version={{.Version}}`); no version
file needed bumping.

---

## Phase 4 — Upgrade (about to run)

**Currently serving:** `muxterm 0.24.0`, binary at `/home/ken/.local/bin/muxterm`.

**Update machinery agrees** (muxterm's own, not hand-rolled):

```json
{"currentVersion":"0.24.0","latestVersion":"0.25.0","updateAvailable":true,"canUpdate":true,"devBuild":false,"method":"binary"}
```

**Mechanism:** `POST /api/update/apply` — `internal/update/apply.go` downloads,
checksum-verifies, and atomically renames the new binary over the running one,
then `update.Restart()` restarts sessiond and serve.

**Rollback artifact exists and is verified:**

```
/home/ken/.local/share/muxterm-rollback/muxterm-v0.24.0
  -> reports "muxterm 0.24.0"
```

**Exact rollback command:**

```bash
cp -p /home/ken/.local/share/muxterm-rollback/muxterm-v0.24.0 /home/ken/.local/bin/muxterm \
  && systemctl --user restart muxterm-sessiond muxterm
```

(The v0.25.0 GitHub release assets remain a second fallback for the forward
direction.)

### The cost, stated plainly

A restart kills the processes inside panes. **Agent sessions do not survive** —
only their on-disk transcripts do. Panes come back from the snapshot as empty
shells. `restore.enabled = true` and `snapshot_interval = "30s"` are set, so
`CheckRestoreCapability()` returns OK and the daemon will write a shutdown
snapshot rather than being left on the old binary.

This session is one of the sessions that dies.

### What else is running, and what the restart costs it

| Lane | Branch | Pushed? | At risk |
|---|---|---|---|
| reconnect fix (#94) | `fix/reconnect-promptly` | **YES** — local `cbd3346` == origin `cbd3346` | **No committed work at risk.** Only a ` D web/node_modules` symlink artifact is uncommitted, which is a known repo-wide quirk, not work. |
| socket steal | `fix/sessiond-socket-ownership` | **NO — no remote branch at all** | **AT RISK.** 5 modified tracked files (`Makefile`, `cmd/muxterm/main.go`, `internal/server/ws.go`, `internal/sessiond/protocol.go`, `internal/sessiond/server.go`) and 6 new untracked files (`socketowner.go`, `stranded*.go`, `systemdgate_*.go`), none committed. The **files survive on disk** in `/home/ken/workspace/muxterm-socket-ownership` — a restart does not wipe worktrees — but the agent driving them dies mid-task. Not committed on its behalf: not my worktree. |
| webview wrapper | `design/webview-wrapper` | no remote branch, but HEAD == old main `3128981`, tree clean, 0 untracked | **Nothing on disk to lose.** A research lane; its session dies, its transcript survives. |

The brief named only the reconnect lane; it is the one that is safely pushed.
The two lanes above turned up in `fleet_status` and are reported because one of
them genuinely is at risk.

### Config is not touched

`~/.config/muxterm/config.toml` (mtime Sep 7 17:52) is not written by the update
path — only the binary is replaced. Voice stays on `gpt-realtime-2.1-mini` with
`auth_mode = "entra"`.

### Pre-upgrade health

```
127.0.0.1:9090             HTTP 401   (auth required — healthy for this surface)
127.0.0.1:8311             HTTP 401
https://muxterm.ampbox.io  HTTP 401
systemd muxterm.service    active, NRestarts=0
sessiond                   running, socket /run/user/1000/muxterm/sessiond.sock
```

---

## Defects found and deliberately not fixed

1. **The `.pr` card in the new Pull Requests applet uses the ruled-out status
   idiom.** `web/src/components/applets/applet-prs.ts:289` gives a
   `border-radius: var(--r-card)` card a `border-left: 3px` whose colour carries
   status (`.pr.b-ok`, `.pr.b-need`). That is the pattern the user ruled out.
   It is **#93's own authored content**, present as submitted and as CI-reviewed
   — my conflict resolutions touched only `mux-cos.ts`, and reintroduced
   nothing. Named, not fixed: rewriting a PR's content is out of scope.
   *(The identical idiom on the Dashboard `.card`, `applet-dashboard.ts:295`, is
   pre-existing — verified byte-identical on main at `07fdb6c:mux-cos.ts:1410`
   before #93 relocated it. Not new.)*

2. **`web/node_modules` is a committed symlink pointing at an empty directory.**
   `/home/ken/workspace/muxterm/web/node_modules` is empty, so the symlink is
   broken in every fresh worktree and `npm run typecheck` fails with
   `tsc: not found`. Worked around locally by temporarily repointing my own
   worktree's symlink (read-only use of another worktree's `node_modules`) and
   restoring it before committing — verified `git diff HEAD -- web/node_modules`
   empty. Pre-existing; not fixed.

3. **`muxterm doctor` reports an addr mismatch.** The installed unit runs on
   `127.0.0.1:9090` but the config file does not say so. Pre-existing,
   cosmetic, not fixed.

---

## Summary against the four DONE conditions

- **(a)** Every PR considered carries exactly one terminal verdict: #91 already
  merged, #73 already closed, #92/#89/#93 **MERGED**, #94 **HELD** (lane still
  working, explicitly out of scope), six older PRs untouched as out of scope.
- **(b)** **v0.25.0 TAGGED and PUBLISHED** from the resulting main (`50cc66f`),
  2026-09-08T00:16:58Z, with all four release assets.
- **(c)** Upgrade — pending, immediately after this file is written.
- **(d)** This report was written **before** the upgrade was attempted.
