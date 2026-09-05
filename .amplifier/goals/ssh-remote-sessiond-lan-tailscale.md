# Goal: SSH remote sessiond, LAN + Tailscale, validated on DTU

## Outcome

A muxterm CLI on this machine drives panes on a separate DTU host over real SSH —
create workspace, create pane, send input, read the screen back — and
`muxterm remote add` has written an idempotent, backed-up, marker-delimited entry
into `~/.ssh/config` that the connection actually uses.

## Done when A–H each resolve

Items A–G resolve independently to **PASS** or **BLOCKED**. A BLOCKED item requires a
named, specific blocker with the exact command and error observed; "didn't work" is not
a blocker. One item BLOCKED converts that item to a residual and does not block the goal.

**A — Refactor lands.**
`Serve(ln net.Listener)` extracted from `ListenAndServe` (`internal/sessiond/server.go:73`).
`DialConn(net.Conn)` added alongside `Dial` (`internal/sessiond/client.go:131`).
`go build ./...` clean and `cd web && npm run check:fast` reports 0 errors.
`internal/sessiond/protocol.go` unmodified.

**B — `muxterm sessiond-connect` exists** and pipes stdio to the local sessiond socket.
Proven by running `ssh localhost muxterm sessiond-connect` carrying a real session; paste
the command and its observed output into the transcript.

**C — Transport interface exists.**
`internal/transport/` defines `Transport` and `HostRef` with stable id separate from display
name; `internal/transport/ssh/` implements it. The SSH implementation resolves the remote
binary via `bash -lc` or an absolute path, and accepts any host address form — hostname, IPv4,
IPv6, tailnet name — with no LAN-specific assumption in the dial path.

**D — `muxterm remote add <name> --host <h> [--port <p>]` manages `~/.ssh/config`.**
All five properties demonstrated inline in the transcript:
1. Writes a block delimited by begin/end markers.
2. Backs up the prior file before the first write; show the backup path.
3. Running twice with the same name updates in place and does not duplicate; show the diff.
4. No line outside its own markers is modified or removed; show the pre-existing
   `Host amplifier-resolve-vm` block intact after the write.
5. `ssh <name> true` afterwards succeeds using only that entry.

**E — LAN scenario validated against a DTU host.**
From this machine: `muxterm --remote <dtu-host> workspace create`, `pane create`,
`pane send`, `read-screen`. Show actual command output proving a command executed on the
DTU host and its output returned — for example `uname -n` printing the DTU hostname rather
than this machine's. Exercise a non-default SSH port at least once.

**F — Tailscale scenario.**
The same sequence as E over a tailnet address. Resolves to PASS or BLOCKED on its own terms.

**G — Work committed.**
All changes committed on a branch off `design/remote-sessiond`. Nothing from
`web/node_modules`, `.amplifier/issues/`, or `.kenergy/` staged.

## H — The live production sessiond survives untouched

This is a hard constraint on every item above, checked in both terminal states.

The user's own muxterm session runs on the production daemon:

- socket `/run/user/1000/muxterm/sessiond.sock` (`XDG_RUNTIME_DIR=/run/user/1000`)
- binary `/home/ken/.local/bin/muxterm`
- workspace `w1` "try-0-15"

Required at the end of the run: that socket still answers, `muxterm workspace list` against
it still lists `try-0-15`, and its pane count is greater than or equal to the count at start.
Show the output.

Prohibited for the entire run:

- Any `pkill`, `kill`, `killall`, or `SIGTERM` matching `muxterm`, `sessiond`, or `serve`.
  To stop something this run started, kill it by the specific PID this run recorded at spawn.
- Writing to `/home/ken/.local/bin/muxterm`. `make build` writes `./bin/muxterm`; leave it there.
- `muxterm install`, `muxterm uninstall`, `muxterm update`, or anything invoking
  `internal/sessiond/restart.go`.
- Running any `muxterm` daemon, `serve`, or test command with the default `XDG_RUNTIME_DIR`,
  or with it pointing at `/run/user/1000`.
- Deleting or moving `/run/user/1000/muxterm/`.
- `systemctl` against any muxterm unit.

Required instead: every daemon, serve, and CLI invocation this run starts must set
`XDG_RUNTIME_DIR=/tmp/muxterm-remote-ssh`, matching the per-lane convention other worktrees
already use (`/tmp/muxterm-autoname-verify`, `/tmp/muxterm-mobile-review`). Pick a serve port
no other lane holds; :9090, :8790, :8388, :8311, and :8912 are taken.

Other worktrees under `/home/ken/workspace/muxterm-*` are running their own daemons and
serves. Leave every one of them alone.

## Teardown — required for DONE, in both terminal states

Every DTU instance created during this run is destroyed, and the transcript shows the
destroy command plus a listing proving none remain. Any instance deliberately kept is named
along with its owner and the reason. This applies whether the goal is achieved or ends in
NOT ACHIEVABLE.

## Not achievable exit

If SSH remoting cannot be made to work, stop and state which of A–H failed, the exact error,
and what was attempted. That is a valid terminal state. Teardown still applies.

## Scope-outs

- No web UI work. The sidebar, Home, and settings mocks are design artifacts; do not implement them.
- No MCP host-aware pane ids.
- No flow-control work — the D4 control lane and D6 relay queue are a later rollout step.
- No sandbox transport (design D2b).
- No edge namespacing or web relay (design D3) beyond what CLI `--remote` requires.
- No unit tests. AGENTS.md bans them; verification is running the thing.
- No production soak, no monitoring over elapsed time.
- Uniformity across every possible SSH configuration is NOT the goal. LAN, plus Tailscale if
  reachable, is sufficient.
- The pre-existing `amplifier-resolve-vm` host is not required to be reachable.
- No PR needs to be opened or merged.

## Known — speed aid only

These prevent re-derivation. They do not by themselves satisfy any item above.

- Design is committed on branch `design/remote-sessiond` as `799243b` and `bb80605`. Read
  `docs/designs/2026-09-05-remote-sessiond-design.md` first; D1, D2, D2c, and D7 govern this work.
- The premise is already proven: an unmodified muxterm binary worked through a TCP hop
  inserted into the socket path via `XDG_RUNTIME_DIR`. Control plane, input, and PTY output
  all worked. Do not re-prove it.
- Seams: `Dial` at `internal/sessiond/client.go:131`; `ListenAndServe` at
  `internal/sessiond/server.go:73`; `DaemonConn` at `internal/server/daemon.go:12-47`;
  `Hub.SetDialer` at `internal/server/ws.go:560`; `newSessiondDialer` at
  `cmd/muxterm/main.go:197`. `protocol.go` is frozen v1.
- Non-interactive `ssh` PATH is `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`
  with no `~/.local/bin`, so `ssh host muxterm …` returns command-not-found even when muxterm
  is installed. `ssh host 'bash -lc "command -v muxterm"'` resolves it.
- `ssh localhost` works here with key auth under `BatchMode=yes`; sshd listens on :22.
- `~/.ssh/config` currently holds exactly one entry, `Host amplifier-resolve-vm`, whose host
  times out on port 22. Do not use it for validation.
- `~/.ssh/known_hosts` is hashed and cannot be enumerated.
- Static checks before any commit: `go build ./...` and `cd web && npm run check:fast`.
- Stand up DTU instances with the `digital-twin-universe` skill or the
  `digital-twin-universe:dtu-profile-builder` agent.
- The DTU image needs a running sshd, an authorized key, and the muxterm binary present.
  `write`-ing the binary in or building it in the profile are both acceptable.
