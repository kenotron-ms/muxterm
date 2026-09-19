# Live lane approval verification — 2026-09-19

Verified with a real sessiond and real browser, using `make dev-local` in the
isolated approval worktree. Other work was using 8313, so this run used:

```sh
TMPDIR=/tmp/muxterm-approval-final \
XDG_CONFIG_HOME=/tmp/muxterm-approval-final/config \
make dev-local AIR='/home/ken/go/bin/air -build.args_bin serve,--addr,127.0.0.1:18319,--no-auth'
```

No unit tests were added or run. Production 9090/8311 and its sessiond were not
modified. SHA-256 checks of `~/.codex/config.toml` and
`~/.claude/settings.json` matched before and after verification. All fixture
daemons were stopped by their explicit, verified dev PIDs after verification.

## Process evidence

[argv.json](argv.json) contains `/proc/<pid>/cmdline` read from **eight actual
running harness processes**, selected by their dev runtime environment. These
are not builder outputs or mocked processes.

| Launch | Codex PID | Claude PID | Observed policy |
| --- | --- | --- | --- |
| CLI, absent muxterm config | 1128064 | 1128238 | on-request/workspace-write; permission-mode default |
| CLI, global never | 1128286 | 1128464 | never/danger-full-access; dangerously-skip-permissions |
| MCP spawn_lane, global never, override prompt | 1128495 | 1128668 | on-request/workspace-write; permission-mode default |
| MCP spawn_lane, global prompt, override never | 1128711 | 1128963 | never/danger-full-access; dangerously-skip-permissions |

All launches used fresh named workspaces. Global changes took effect without
restarting sessiond. MCP calls used the real stdio JSON-RPC server and daemon.

## Browser evidence

`playwright-cli` opened `http://127.0.0.1:18319`, selected each workspace,
and captured the terminal screens. Codex `/status` and Claude's footer report:

- [Codex default](codex-prompt.png): **Workspace (Ask for approval)**.
- [Codex opted in](codex-never.png): **Full Access**.
- [Claude default](claude-prompt.png): **manual mode on**.
- [Claude opted in](claude-never.png): **bypass permissions on**.

The default modes were effective despite this machine's existing bypass settings
in both harness dotfiles. The model's prose response was not the assertion;
process argv and the harness's own permission display were.

## Failure paths

These exercised the actual dev sessiond launch boundary:

| Input | Observed result |
| --- | --- |
| MCP approval `typo` | `pane-spawn-failed: lanes.approval: invalid override "typo"` |
| Global approval `typo` | `lanes.approval: invalid value "typo"` |
| Malformed config | `lanes.approval: cannot launch with malformed muxterm config` |
| Explicit Amplifier approval | `lanes.approval: amplifier has no approval translation` |
| Executable fixture reporting codex-cli 99.0.0 | `refusing codex version "codex-cli 99.0.0": approval translation is unverified` |
| Executable fixture reporting 0.155.1 but rejecting the flags | `codex preflight failed (exit status 2): unknown approval flag` |

The two executable fixtures were temporary files passed as `pane create --cmd`
to the real dev daemon. They were only negative-path fixtures; all successful
policy checks above ran the installed real harnesses.

A separate fresh dev-local runtime also fired a real scheduled Claude trigger:
PID 1132102 carried `--permission-mode default`. Its browser pane kept a label
derived from the prompt rather than the option value `default`.

`go build ./...`, `go vet ./...`, and `cd web && npm run check:fast` passed.
The frontend check reported existing warnings and zero errors.

A final fresh dev-local run verified policy persistence through a real browser
`PATCH /api/config`: after startup, the on-disk policy was changed to `never`.
A request changing font size to 15 and attempting `lanes.approval=prompt`
preserved `never` in the response and on disk. A subsequent real Claude process
(PID 1134179) carried `--dangerously-skip-permissions`. A malformed config was
also left byte-for-byte intact by a later browser preference save.
