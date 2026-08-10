# Rapid Local Dev Workflow Implementation Plan

> **For execution:** Use `/build-like-ken` mode.

**Goal:** Add a single command, `make dev-local`, that stands up a fully isolated second muxterm instance on this Mac — its own binary (`bin/muxterm-dev`), its own port (`127.0.0.1:8313`), its own sessiond socket/log/runtime directory (`${TMPDIR:-/tmp}/muxterm-dev-local/`) — so Go and web changes can be iterated on with fast rebuild-and-restart, with zero possibility of touching the currently-running production `serve`/`sessiond` pair.

**Architecture:** Two new files only — `.air.local.toml` (a forked air config binding port 8313 and pointing `bin` at `./bin/muxterm-dev`) and a new `dev-local` target in the existing `Makefile` (creates `${TMPDIR:-/tmp}/muxterm-dev-local/`, exports `XDG_RUNTIME_DIR` into that directory, backgrounds `vite build --watch`, and runs `air -c .air.local.toml` in the foreground). Isolation comes from three independent axes that all have to hold simultaneously: a different compiled binary path, a different TCP port, and a different `XDG_RUNTIME_DIR`-controlled sessiond socket directory. No existing file (`.air.toml`, `Caddyfile`, or any other `Makefile` target) is modified in a way that changes its behavior — `.PHONY` gets one new name appended, nothing else.

> **Correction (post-Task-3-verification):** Task 3's first verification pass used a worktree-local runtime path, `tmp/muxterm-dev-runtime/`. On this machine that path, once joined with `muxterm/sessiond.sock`, exceeded macOS's 104-byte `sockaddr_un` limit, so sessiond failed to bind (`bind: invalid argument`) in a retry loop and no terminal pane could connect. This plan has been corrected throughout to use `${TMPDIR:-/tmp}/muxterm-dev-local/` instead — short, fixed, and independent of worktree checkout path length — and Task 3 was re-executed against the corrected path.

**Tech Stack:** Go (`go build`, `cosmtrek/air` for hot-reload), Vite (`vite build --watch` for the web frontend), GNU Make, TOML config, macOS/zsh shell.

**Verification approach:** No unit tests are written or run anywhere in this plan — this repo bans unit tests (see `AGENTS.md`). Every task is verified with real execution: static syntax/config checks first (cheap, zero-risk), then actually building and running the isolated dev stack, then driving a real browser against it with `playwright-cli` per the `muxterm-verify` convention already documented in this repo's `AGENTS.md`. Every verification step that touches process/port/socket state explicitly re-checks the production instance's baseline (PID, port, socket directory, file sizes/mtimes) immediately before and after, to prove it was never touched.

---

## ⚠️ Non-negotiable safety rules (read before starting)

1. **This plan executes ONLY inside the git worktree `/Users/ken/workspace/muxterm/.worktrees/chore-rapid-dev-workflow` on branch `chore/rapid-dev-workflow`.** Do not `cd` into, read from as a working directory, or write to any other worktree or branch. The production binary lives in a **completely separate repo checkout** at `/Users/ken/workspace/ms/muxterm/bin/muxterm` — that path is read-only reference information in this plan, never a target of any command below.
2. **NEVER kill, restart, signal, or send any input to PID 58493 (production `serve --no-auth --addr 127.0.0.1:8311`) or PID 58494 (production `sessiond`).** If, at execution time, `lsof -i :8311` shows different PIDs than 58493/58494 (the machine may have rebooted or the app restarted since the design was written), then **whatever PIDs are currently shown become the new "must remain untouched" baseline** for the rest of this plan — the goal is proving the currently-running production instance is undisturbed, not matching these specific historical numbers.
3. **NEVER write to, delete from, or otherwise touch `$TMPDIR/muxterm-501/`** (production's sessiond socket/log/`server.url` directory — the default path when no `XDG_RUNTIME_DIR` is set for UID 501). If production's actual socket directory is found to differ at execution time (check with `lsof -p <production-sessiond-pid> | grep sock` if needed), treat that actual directory as the "must remain untouched" baseline instead.
4. **Never run any command in this plan without first exporting/scoping `XDG_RUNTIME_DIR` to `${TMPDIR:-/tmp}/muxterm-dev-local`** as shown in each task. Running `air -c .air.local.toml` or `./bin/muxterm-dev serve` without that env var set is not covered by this plan and must not be attempted.
5. If at any point a verification step shows the production baseline has changed unexpectedly, **stop immediately** and report this to the user rather than continuing or attempting a fix.

---

### Task 1: Create `.air.local.toml`

**Files:**
- Create: `.air.local.toml` (repo root — same directory as the existing `.air.toml`)

**Implementation**

Create the file with exactly this content (verbatim from the design document — do not alter whitespace, comments, or values):

```toml
# air config for muxterm LOCAL dev mode (this Mac only).
# Fully decoupled from .air.toml (ampbox.io remote-VM dev config) -- edits to
# one MUST NOT be assumed to apply to the other.
#
# Isolation: XDG_RUNTIME_DIR must be set (by `make dev-local`) before invoking
# air, so the sessiond this spawns uses ${TMPDIR:-/tmp}/muxterm-dev-local/
# instead of the default $TMPDIR/muxterm-<uid>/ where the native companion
# app's production sessiond lives. Never run this without that env var set.
#
# Port 8313 -- distinct from both production (8311) and the remote-VM dev
# config's 8312.

root = "."
tmp_dir = "tmp"

[build]
  bin = "./bin/muxterm-dev"
  args_bin = ["serve", "--addr", "127.0.0.1:8313", "--no-auth"]
  cmd = "go build -o ./bin/muxterm-dev ./cmd/muxterm"
  delay = 200
  stop_on_error = false

  include_dir = ["cmd", "internal", "web/dist"]
  include_ext = ["go", "stamp"]
  exclude_dir = ["tmp", "vendor", "testdata", "web/src", "web/node_modules"]
  exclude_regex = ["_test\\.go$"]

[color]
  build = "yellow"
  runner = "green"
  watcher = "cyan"
  main = "magenta"
  app = ""

[log]
  time = false

[screen]
  clear_on_rebuild = false
  keep_scroll = true
```

Notes for context (do not act on these, just be aware):
- `tmp_dir = "tmp"` here is **air's own** scratch directory for its build metadata (same value as the existing `.air.toml` uses) — this is unrelated to `XDG_RUNTIME_DIR` / the sessiond runtime directory, which is a separate concept set later by the Makefile in Task 2.
- `bin/` and `tmp/` are already covered by the repo's existing `.gitignore` (`bin/` on line 2, `tmp/` on line 36), so no gitignore changes are needed for the artifacts this file's `[build]` section produces.
- This file itself (`.air.local.toml`) is **git-tracked**, not ignored — same as the existing `.air.toml`.

**Static Analysis**

First confirm the file is valid TOML:

```bash
cd /Users/ken/workspace/muxterm/.worktrees/chore-rapid-dev-workflow
python3 -c "import tomllib; tomllib.load(open('.air.local.toml','rb')); print('valid toml')"
```

Expected output:
```
valid toml
```
(no traceback/exception)

Then confirm the file is NOT excluded by any gitignore rule (it must be trackable, like `.air.toml`):

```bash
git check-ignore -v .air.local.toml
```

Expected: **no output at all**, and the command's exit code is `1`. Check the exit code explicitly:

```bash
git check-ignore -v .air.local.toml; echo "exit code: $?"
```

Expected output:
```
exit code: 1
```
(If it prints a matching gitignore rule and exits `0`, something is wrong — a `.air.local.toml` should never match `*.toml`-style ignores because no such rule exists in this repo's `.gitignore`; stop and investigate before proceeding.)

**Verification**

```bash
diff <(git show HEAD:.air.toml 2>/dev/null; echo NOFILE) /dev/null >/dev/null 2>&1; ls -la .air.local.toml
```

Expected: `ls -la .air.local.toml` shows the file exists with a non-zero size (roughly 1.1–1.3 KB).

**Commit**

```bash
git add .air.local.toml
git commit -m "feat: add isolated air config for local Mac dev loop (.air.local.toml)"
```

Expected: commit succeeds, `git log -1 --stat` shows exactly one file added: `.air.local.toml`.

---

### Task 2: Add `make dev-local` target to `Makefile`

**Files:**
- Modify: `Makefile:1` (the `.PHONY` line)
- Modify: `Makefile` (add a new `dev-local:` target — insert it directly after the existing `dev:` target, i.e., after line 40 and before the `# Install demo npm dependencies...` comment on line 42, so it sits logically next to the other "start a dev stack" target)

**Implementation**

Step 2a — update the `.PHONY` line. The current line 1 reads:

```makefile
.PHONY: build dev demo demo-install install-stable test clean web
```

Change it to:

```makefile
.PHONY: build dev dev-local demo demo-install install-stable test clean web
```

Use `edit_file` (or equivalent) with:
- old_string: `.PHONY: build dev demo demo-install install-stable test clean web`
- new_string: `.PHONY: build dev dev-local demo demo-install install-stable test clean web`

Step 2b — insert the new target. Find this existing block (the end of the `dev:` target, lines 36–40):

```makefile
	echo "  muxterm       http://127.0.0.1:9091  (air hot-reload)"; \
	echo "  demo backend  http://localhost:9002   (log: tmp/demo-backend.out)"; \
	echo "  demo frontend http://localhost:5173   (log: tmp/demo-frontend.out)"; \
	$(AIR)

# Install demo npm dependencies (run once, or after package.json changes).
```

Replace it with (this keeps the existing `dev:` target's last 4 lines completely unchanged, and inserts the new target plus its explanatory comment and a blank line before the `demo-install` comment):

```makefile
	echo "  muxterm       http://127.0.0.1:9091  (air hot-reload)"; \
	echo "  demo backend  http://localhost:9002   (log: tmp/demo-backend.out)"; \
	echo "  demo frontend http://localhost:5173   (log: tmp/demo-frontend.out)"; \
	$(AIR)

# Dev-local mode: fully isolated second muxterm instance on THIS Mac only.
#   - own binary   bin/muxterm-dev (air-managed, rebuilds on Go/web changes)
#   - own port     127.0.0.1:8313  (distinct from prod 8311 and remote-VM dev 8312)
#   - own runtime  ${TMPDIR:-/tmp}/muxterm-dev-local/ (XDG_RUNTIME_DIR override) --
#     sessiond socket/log/server.url all live here instead of the default
#     $TMPDIR/muxterm-<uid>/ where production's sessiond lives, so production is
#     never dialed, signaled, or read/written by this target under any circumstance.
#     A short, fixed, OS-temp-based path is used instead of a worktree-local path
#     (e.g. tmp/muxterm-dev-runtime) because a worktree-local path can push the
#     resulting sessiond.sock path over macOS's 104-byte sockaddr_un limit,
#     causing sessiond to fail to bind.
#   - No Caddy, no demo backend/frontend -- this is a same-machine loop only.
# Ctrl-C stops the Vite watcher and the air-owned bin/muxterm-dev process.
# Requires: air (falls back to $(HOME)/go/bin/air if not on PATH).
dev-local:
	@mkdir -p tmp
	@export XDG_RUNTIME_DIR="$${TMPDIR:-/tmp}"; \
	XDG_RUNTIME_DIR="$${XDG_RUNTIME_DIR%/}/muxterm-dev-local"; \
	export XDG_RUNTIME_DIR; \
	mkdir -p "$$XDG_RUNTIME_DIR"; \
	cd $(WEB_SRC) && npx vite build --watch > ../tmp/dev-local-vite.out 2>&1 & VITE_PID=$$!; \
	trap 'kill $$VITE_PID 2>/dev/null || true' EXIT INT TERM; \
	echo "dev-local stack:"; \
	echo "  muxterm-dev   http://127.0.0.1:8313  (air hot-reload)"; \
	echo "  vite watch    logging to tmp/dev-local-vite.out"; \
	echo "  runtime dir   $$XDG_RUNTIME_DIR  (isolated sessiond socket/log)"; \
	echo "  production    127.0.0.1:8311 -- untouched"; \
	$(AIR) -c .air.local.toml

# Install demo npm dependencies (run once, or after package.json changes).
```

Use `edit_file` with:
- old_string: the 5-line block shown above ending in the `demo-install` comment (copy exactly, including the blank line before `# Install demo...`)
- new_string: the replacement block shown above

**Do not touch** any other part of the `Makefile` — the `build`, `dev`, `demo`, `demo-install`, `install-stable`, `web`, `test`, `test-web`, and `clean` targets must be byte-for-byte identical to their current content after this edit (only the `.PHONY` line and the new `dev-local` block change).

**Static Analysis**

```bash
cd /Users/ken/workspace/muxterm/.worktrees/chore-rapid-dev-workflow
make -n dev-local
```

Expected: Make prints the shell commands it *would* run (the `mkdir -p ...`, the `export XDG_RUNTIME_DIR=...` line, etc.) with **no error** like `*** missing separator` or `No rule to make target`. Because the recipe lines use `@`-prefixed shell one-liners joined by `\`, `-n` will print roughly:

```
mkdir -p tmp
export XDG_RUNTIME_DIR="${TMPDIR:-/tmp}"; \
XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR%/}/muxterm-dev-local"; \
export XDG_RUNTIME_DIR; \
mkdir -p "$XDG_RUNTIME_DIR"; \
cd ./web && npx vite build --watch > ../tmp/dev-local-vite.out 2>&1 & VITE_PID=$!; trap 'kill $VITE_PID 2>/dev/null || true' EXIT INT TERM; echo "dev-local stack:"; echo "  muxterm-dev   http://127.0.0.1:8313  (air hot-reload)"; echo "  vite watch    logging to tmp/dev-local-vite.out"; echo "  runtime dir   $XDG_RUNTIME_DIR  (isolated sessiond socket/log)"; echo "  production    127.0.0.1:8311 -- untouched"; /Users/ken/go/bin/air -c .air.local.toml
```

(Exact `$(AIR)` resolution and quoting may look slightly different depending on shell — what matters is: no Make syntax error, and the printed command references `.air.local.toml`, port `8313`, and a path ending in `muxterm-dev-local` (not `tmp/muxterm-dev-runtime`).)

Then confirm the `.PHONY` line was updated correctly:

```bash
grep '.PHONY' Makefile
```

Expected output:
```
.PHONY: build dev dev-local demo demo-install install-stable test clean web
```

Then confirm no other target's recipe changed, by diffing against the last commit:

```bash
git diff Makefile
```

Expected: the diff shows **only** the `.PHONY` line change and the new `dev-local:` block (plus its comment) being added — no other lines removed or modified anywhere in the file.

**Verification**

```bash
make -n dev >/dev/null 2>&1; echo "dev target still parses: exit $?"
make -n build >/dev/null 2>&1; echo "build target still parses: exit $?"
```

Expected output:
```
dev target still parses: exit 0
build target still parses: exit 0
```

This proves the edit didn't break Make's parsing of the pre-existing targets.

**Commit**

```bash
git add Makefile
git commit -m "feat: add make dev-local target for isolated local Mac dev loop"
```

Expected: commit succeeds, `git log -1 --stat` shows exactly one file changed: `Makefile`.

---

### Task 3: End-to-end real verification (no code changes — pure verification task)

This task makes **no permanent code changes** and has **no commit**. Any throwaway edits made in step 3e must be reverted before finishing. This entire task is real execution per the muxterm-verify convention in `AGENTS.md` — no unit tests are written at any point.

Work directory for every command below: `/Users/ken/workspace/muxterm/.worktrees/chore-rapid-dev-workflow`.

#### 3a. Pre-flight production health check (baseline, BEFORE touching anything)

```bash
lsof -i :8311
```

Expected: a `muxterm` process LISTENing on `127.0.0.1:8311`, PID `58493` (per the design). **If the PID shown is different**, that's fine — record whatever PID is actually shown right now. That recorded PID (call it `PROD_SERVE_PID`) is the baseline for the rest of this task; it must be identical every time you re-check it below.

```bash
ps -p 58494 -o pid,comm
```

Expected: shows the production `sessiond` process is alive (PID `58494` per the design, or whatever the currently-actually-running sessiond PID is — record it as `PROD_SESSIOND_PID`).

```bash
ls -la "$TMPDIR/muxterm-501/"
```

Expected: lists the existing `sessiond.sock`, `sessiond.log`, `server.url` files. Record their current sizes and modification times (`mtime`) as the baseline — call this the "3a baseline". **If this directory does not exist or has different contents** (e.g. the UID isn't 501, or `TMPDIR` resolves differently), find production's actual socket directory instead (e.g. via `lsof -p $PROD_SESSIOND_PID | grep sock`) and use THAT as the baseline directory for every subsequent re-check in this task.

#### 3b. Build and start

Start the dev-local stack as a background process so this session can continue issuing verification commands against it:

```bash
cd /Users/ken/workspace/muxterm/.worktrees/chore-rapid-dev-workflow
make dev-local > tmp/dev-local-session.out 2>&1 &
echo "dev-local PID: $!"
```

(Using `run_in_background: true` if invoking via the bash tool, since this is a long-running foreground process by design.)

Wait a few seconds for the first Go build and Vite build to complete, then inspect the captured output:

```bash
sleep 8
cat tmp/dev-local-session.out
```

Expected: the banner lines appear, in this order (interleaved with air's own build log lines like `building...`, `running...`):
```
dev-local stack:
  muxterm-dev   http://127.0.0.1:8313  (air hot-reload)
  vite watch    logging to tmp/dev-local-vite.out
  runtime dir   ${TMPDIR:-/tmp}/muxterm-dev-local  (isolated sessiond socket/log)
  production    127.0.0.1:8311 -- untouched
```
followed by air's `building...` / `running...` lines and finally a log line from the app itself, e.g. `muxterm listening on 127.0.0.1:8313` and `access token: ...` (since `.air.local.toml` passes `--no-auth`, the printed token is unused, but the listening line confirms serve started).

If instead you see a bind error or a Go compile error, **stop here** — do not proceed to 3c — and report the exact error output.

#### 3c. Confirm isolated startup

```bash
ls -la "${TMPDIR:-/tmp}/muxterm-dev-local/muxterm/"
```

Expected: shows **new** `sessiond.sock`, `sessiond.log`, `server.url` files here, with recent mtimes (created in the last few seconds) — this is a directory distinct from `$TMPDIR/muxterm-501/`.

```bash
lsof -i :8313
```

Expected: a `muxterm-dev` process LISTENing on `127.0.0.1:8313`.

```bash
ps aux | grep muxterm-dev | grep -v grep
```

Expected: shows the new dev binary's PID(s) — this PID must be **different** from `PROD_SERVE_PID` and `PROD_SESSIOND_PID` recorded in 3a.

Now re-check the production baseline to prove nothing changed as a side effect of starting dev-local:

```bash
lsof -i :8311
ls -la "$TMPDIR/muxterm-501/"
```

Expected: **identical** PID (`PROD_SERVE_PID`) still listening on 8311, and identical file sizes/mtimes for the production socket dir as recorded in the 3a baseline (the `sessiond.log` mtime may have advanced slightly if production is actively logging on its own — that's fine and expected; what must NOT change is which PID owns port 8311, and no NEW files should appear in that directory).

#### 3d. Real browser verification

```bash
playwright-cli open http://127.0.0.1:8313
playwright-cli snapshot
```

Expected: the snapshot shows the real muxterm UI rendering — a title bar containing the text `muxterm`, a sidebar/workspace picker, and a dockview-style pane area with at least one terminal pane visible.

Click into a terminal pane, type a distinctive string, and press enter:

```bash
playwright-cli click <terminal-pane-element-ref-from-snapshot>
playwright-cli type "echo VERIFY_DEV_LOCAL_8313"
playwright-cli press Enter
playwright-cli snapshot
```

Expected: the second snapshot shows `VERIFY_DEV_LOCAL_8313` echoed back in the terminal pane's visible text output — proving a real, working PTY session is running on the isolated dev-local sessiond (not just "a process that bound a port").

```bash
playwright-cli close
```

#### 3e. Hot-reload verification (throwaway edits — MUST be reverted before moving on)

**Go-side change.** Edit `cmd/muxterm/main.go`, in `runServe`, change this line (currently at `cmd/muxterm/main.go:257`):

```go
	log.Printf("muxterm listening on %s", cfg.Addr)
```

to:

```go
	log.Printf("muxterm listening on %s (dev-local hot-reload test)", cfg.Addr)
```

Save the file. Watch `tmp/dev-local-session.out` (or the terminal running `make dev-local`, if run in the foreground):

```bash
sleep 2
tail -n 20 tmp/dev-local-session.out
```

Expected: air's output shows it detected the `.go` change, printed a rebuild log line, and a new `muxterm listening on 127.0.0.1:8313 (dev-local hot-reload test)` line appears — proving air rebuilt and restarted `bin/muxterm-dev`.

Reconfirm production is still unaffected (this rebuild only restarts `bin/muxterm-dev`, never touches production):

```bash
lsof -i :8311
```
Expected: identical `PROD_SERVE_PID` still there.

**Web-side change.** Edit `web/src/components/title-bar.ts:165`, change:

```html
        <span>muxterm</span>
```

to:

```html
        <span>muxterm DEV</span>
```

Save the file. Watch the Vite watcher log and then the air log:

```bash
sleep 3
tail -n 20 tmp/dev-local-vite.out
sleep 2
tail -n 20 tmp/dev-local-session.out
```

Expected: `tmp/dev-local-vite.out` shows a new Vite build completing (writes `web/dist/build.stamp`), and `tmp/dev-local-session.out` shows air detecting the `.stamp` file change and rebuilding/restarting `bin/muxterm-dev` again (since `web/dist` is embedded via `go:embed`, a Go rebuild is required to pick up the new frontend assets).

Confirm the change is visible in a real browser:

```bash
playwright-cli open http://127.0.0.1:8313
playwright-cli snapshot
```

Expected: the title bar in the snapshot now reads `muxterm DEV` instead of `muxterm`.

```bash
playwright-cli close
```

**Revert both throwaway edits** — this is required, do not skip:

```bash
git checkout -- cmd/muxterm/main.go web/src/components/title-bar.ts
git status --short
```

Expected: `git status --short` output is **empty** (clean working tree) — confirming no residual changes remain beyond the Task 1 and Task 2 commits already made earlier in this plan.

#### 3f. Teardown verification

Stop the foreground `make dev-local` process (send SIGINT to the backgrounded job started in 3b):

```bash
jobs -l
kill -INT %1
```

(If `make dev-local` was started via the bash tool's `run_in_background`, send SIGINT to the PID printed in 3b instead: `kill -INT <dev-local-pid>`.)

```bash
sleep 3
ps aux | grep muxterm-dev | grep -v grep
```

Expected: **no** `muxterm-dev serve` process remains running. (A detached dev-local `sessiond` process may still be present in the process list per the design's documented `Setsid` semantics — if you see a lingering process whose command line references `sessiond` and the `${TMPDIR:-/tmp}/muxterm-dev-local` path, that is expected and not a failure. It can be cleaned up later by deleting `${TMPDIR:-/tmp}/muxterm-dev-local/` if ever desired — do not delete it as part of this plan.)

```bash
ps aux | grep "vite build --watch" | grep -v grep
```

Expected: no lingering Vite watcher process (killed by the `trap ... EXIT INT TERM` in the `dev-local` Makefile target).

**Final production re-check** — the critical final proof:

```bash
lsof -i :8311
ls -la "$TMPDIR/muxterm-501/"
```

Expected: **identical** to the 3a baseline — same `PROD_SERVE_PID` listening on 8311, same files in the production socket directory with sizes/mtimes consistent with normal ongoing production activity (not disturbed by anything in this plan). This proves production was never touched across the entire build → run → browser-verify → hot-reload → teardown cycle.

**No commit for Task 3** — this is a pure verification task, and the throwaway edits in 3e must be reverted (already done above), not committed.

---

## Summary of commits produced by this plan

1. `feat: add isolated air config for local Mac dev loop (.air.local.toml)` (Task 1)
2. `feat: add make dev-local target for isolated local Mac dev loop` (Task 2)

Task 3 produces zero commits — it is verification-only, and its two throwaway edits (`cmd/muxterm/main.go`, `web/src/components/title-bar.ts`) are reverted within the task itself.
