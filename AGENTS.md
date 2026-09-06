## ⛔ NEVER KILL, RESTART, OR DISTURB THE RUNNING MUXTERM

**The live muxterm on this machine is the user's actual working environment. It is
hosting the terminal you are running inside right now. Killing it kills the session
that is reading this file. There is no recovery from inside.**

Never run any of these, in any form, for any reason:

```
pkill muxterm            killall muxterm           kill <muxterm pid>
pkill sessiond           kill <sessiond pid>       kill -9 anything muxterm-related
systemctl --user stop|restart|disable  muxterm | muxterm-sessiond | muxterm-proxy
muxterm kill | muxterm stop | muxterm restart      (against the installed binary)
make install / make install-stable                 (replaces the running binary)
```

This applies even when a restart looks obviously necessary — to load a config change,
to pick up a rebuild, to clear stale state, to test a fix. It is never necessary,
because you have two isolated alternatives below. **If you believe you have found a
case that genuinely requires touching the live server, stop and ask the user. Do not
decide this on your own.**

### What is off-limits (verify before touching anything)

| Unit | What it is | Port |
|---|---|---|
| `muxterm.service` | `muxterm serve --addr 127.0.0.1:9090` | 9090 |
| `muxterm-sessiond.service` | PTY daemon — **holds every live terminal, including yours** | unix socket |
| `muxterm-proxy.service` | Caddy loopback bridge → 9090 | **8311** |

`muxterm sessiond` is the one that matters most. It owns every running shell. Killing
it destroys in-flight work across every pane and workspace, not just yours.

**Port 8311 and port 9090 are production.** Never point a test, a browser, a build, or
a `curl` that mutates state at either one. Read-only `curl` against 9090 is acceptable
for inspection.

### Do dev work one of these two ways instead

**1. `make dev-local` — isolated second instance, same machine.** This is the default
choice and it is safe to start, kill, and restart freely.

```bash
make dev-local
#   muxterm-dev   http://127.0.0.1:8313   (air hot-reload, own bin/muxterm-dev)
#   runtime dir   ${TMPDIR:-/tmp}/muxterm-dev-local   (isolated sessiond socket/log)
#   production    127.0.0.1:8311 / 9090   -- untouched
```

It gets its own binary, its own port (8313), and its own `XDG_RUNTIME_DIR`, so its
sessiond cannot collide with the production one. Killing and restarting *this* stack is
encouraged (see verification hygiene below).

**2. A Digital Twin Universe (DTU) — fully isolated container.** Use this when the work
needs a realistic deployment: reverse proxies, TLS, systemd units, install/upgrade
paths, public origins, or anything that would otherwise tempt you to reconfigure the
real service. Load the `digital-twin-universe` skill, or delegate to
`digital-twin-universe:dtu-profile-builder`.

Anything involving `muxterm install`, `muxterm deploy`, systemd unit or launchd plist
generation, `public_origin`, `behind_reverse_proxy`, or the self-update path belongs in a
**DTU**. Those code paths exist to write service files, replace binaries, and rewrite
config — a DTU is the only place where being wrong about one of them is survivable.

### ⛔ Do NOT hand-roll a scratch instance on the host

Setting `XDG_RUNTIME_DIR` / `XDG_CONFIG_HOME` to temp dirs and starting a server on a
spare port is **not** isolation and is not permitted. It is a convention, enforced by
nothing:

- One command that forgets to set them writes to `~/.config/muxterm/config.toml` or
  `$XDG_RUNTIME_DIR/muxterm/server.url` — the live handoff file the running MCP tools
  read.
- Any code path that resolves a path without consulting those variables walks straight
  out of the sandbox. `muxterm doctor`, for one, reports on the **real** installed
  systemd unit regardless of what `XDG_*` is set to.
- A `pkill`/`killall` typed against "just my scratch process" matches production too.

If a change cannot be verified by `make dev-local`, verify it in a **DTU**. Do not
improvise a third option.

### Verifying without running muxterm at all

Most of what needs checking is not a running-server question, and these carry zero risk
to the user's environment:

- **Pure functions** (URL/origin normalization and validation, redirect-target
  construction, path guards): write a throwaway `main.go` under `tmp/`, `go run` it,
  print a table of inputs and outputs, then delete it. It never binds a port, never
  reads config, never touches the runtime dir.
- **Generated file contents** (systemd unit, launchd plist, config writes): call the
  rendering function directly and print the string. Do not install it.
- **Compile and lint**: `go build ./...` and `cd web && npm run check:fast`.

Reach for a DTU when the thing under test genuinely requires a live server, a browser, a
real service manager, or a network hop.

## Architectural invariants

### Terminal query ownership (CSI 6n, OSC 11;?)

sessiond's `VTBuffer` is authoritative for replying to `CSI 6n` (cursor
position) and `OSC 11;?` (background-color query); the browser must not also
reply, or the duplicate answer leaks into the shell (the `gh auth`
`^[]11;rgb:.../^[\^[[14;1R` bug). `web/src/lib/terminal-registry.ts`
enforces this with xterm.js parser hooks (`registerCsiHandler`/
`registerOscHandler`) registered right after `new Terminal(...)` that consume
only those exact query forms; OSC 11 setters and unrelated sequences fall
through to xterm.js normally. Do this at the parser level, not via
timing/`onData` byte filtering.

### Pane activity ownership

sessiond alone classifies pane activity from the current root-process
generation, authenticated streaming shell lifecycle, and foreground PTY process
group. Browser state, terminal text, titles, and input timing are never activity
authority. Only default interactive bash/zsh panes with current prompt evidence
may be idle; custom commands, unsupported environments, and inspection ambiguity
remain unknown.

sessiond alone also authorizes destructive pane and workspace closure. Browser
controls emit close intents, keep targets live until daemon authority responds,
and wait for authoritative pane/workspace broadcasts before removing structure.

## Testing Policy

### ⛔ DO NOT WRITE UNIT TESTS

Unit tests are banned in this project. Do not write them. Do not ask if you should write them. Do not write them "just for the pure logic". Do not write vitest tests, Go table-driven tests for internal functions, or any test that runs without a real browser and a real sessiond process.

**Why:** muxterm is an integration system — the browser, the sessiond PTY daemon, and real shell processes inside terminals. Nothing meaningful is testable in isolation. A unit test that checks `serializeGrid()` returns the right cell array tells you nothing about whether a reconnecting client sees a clean vim screen instead of garbage. A Go test that checks a resize handler updates a struct field tells you nothing about whether the PTY actually reflowed and the inner TUI redrew at the new size. These tests have accumulated across the codebase and none of them have ever caught a real bug or prevented a regression.

**What to do instead: VERIFICATION**

Every feature or fix must be verified by actually running muxterm and observing the behavior in a real browser. Use the `/muxterm-verify` skill and `playwright-cli` for this. Do not say a feature is done until you have seen it work with your own tool calls.

Verification pattern — **against `dev-local` on 8313, never production on 8311**:
```bash
# 1. Start the isolated dev stack (own binary, own port, own runtime dir)
make dev-local

# 2. Open and observe — 8313 is dev-local; 8311 and 9090 are the live server
playwright-cli open http://127.0.0.1:8313
playwright-cli snapshot
playwright-cli click e5
# ... verify the actual behavior
playwright-cli close
```

`make dev-local` rebuilds on change via `air`, so a separate `make build` step is not
needed. Do not run a bare `./bin/muxterm &` without an isolated `XDG_RUNTIME_DIR` — it
will contend with the production sessiond socket.

**You are not done until playwright-cli (or the muxterm-verify skill) confirms the feature works in a real browser.**

### Verification hygiene: fresh fixtures every time, especially when debugging

Lesson learned the hard way (multi-client resize/focus-authority fix, 2026-07-31): a long debugging session hammered a single reused workspace/pane with dozens of resize/attach/detach/reconnect cycles over several hours. The pane accumulated state that produced flaky, non-reproducible failures indistinguishable from real bugs — several hours were burned chasing a "regression" that was actually just test fixture rot, not the code under test.

**Rules to avoid this:**

- **Create a brand-new workspace (and therefore a brand-new pane) for every verification run**, especially every re-run while debugging something flaky. Never reuse a pane across multiple test iterations. A pane that's been resized/reattached dozens of times is not the same as a pane a real user just opened.
- **Kill and fully restart `make dev-local` (wiped `XDG_RUNTIME_DIR`) before a "clean" verification pass**, not just fresh browser sessions. A fresh browser tab against a long-lived, heavily-poked sessiond process is not a clean test. This applies to the **dev-local** stack only — restarting it is encouraged; the production units named at the top of this file remain off-limits.
- **Never edit source files while `air`'s dev-local watch loop is mid-test.** Concurrent edits trigger a rebuild that kills in-flight browser WebSocket connections, producing failures that look like application bugs but are actually the test harness pulling the rug out from under itself. Finish the test, *then* edit.
- **Check for stale sessiond processes from a different worktree before trusting a result.** `make dev-local` uses a fixed, worktree-independent socket path (`${TMPDIR:-/tmp}/muxterm-dev-local`) so it survives long paths — but that means two worktrees running `make dev-local` at different times can leave a stale daemon squatting on the same socket. Run `ps aux | grep sessiond` and confirm the binary path matches the worktree you're actually testing before trusting what you see in the browser.
- If a scenario is flaky (passes once, fails on the next identical-looking run), don't just re-run it more — that's the "3+ failures = question the pattern" signal. Rule out fixture/environment staleness with a fresh-everything run *before* concluding it's a real code defect.

### Fast static checks (required before commit)

These are NOT tests. They are type and lint checks:
- `cd web && npm run check:fast` — oxlint + tsgo (0 errors required)
- `go build ./...` — must compile clean

### Existing test files

There are existing `*_test.go` and `*.test.ts` files in the repo. Do not delete them (too disruptive), but do not add new ones. If a test file breaks because of your changes, fix the test to match the new behavior — do not write new tests to "cover" your change.
