# Config writes: diagnosis and live verification (2026-09-22)

## Proven cause

`update_config({"changes":{"lanes":{"approval":"never"}}})` returned success with
`prompt` because the HTTP handler decoded into `Config` and called the old,
field-by-field `config.Merge`, which never copied `Lanes`. The handler then
unconditionally replaced `newCfg.Lanes` with the existing disk value. It wrote
that unchanged policy, updated memory, broadcast it, and returned HTTP 200.
Unknown JSON keys were also silently discarded by the typed decoder, and disk
write/parse failures were only logged instead of returned.

This was **not stale memory, precedence, or validation rejecting `never`**. On the
unmodified baseline, the config file's inode and modification time changed, but
its policy remained `prompt`. Both the MCP write response and an independent MCP
read returned `prompt`.

## Change and boundaries

The HTTP path now uses a schema-driven, presence-aware patch against the latest
disk configuration. This fixes the general hand-maintained merge omission class:
JSON-visible fields are merged recursively without separate merge assignments;
explicit `patch:"readonly"` annotations preserve the existing file-only boundaries
for keys, workspace, driver, server, restore, voice, and missioncontrol. The
The JSON-hidden cos section remains inaccessible. The only newly
writable section is lanes. Its default remains `prompt`, and its only accepted
approval values remain `prompt` and `never`. Omitted fields remain unchanged;
explicit zero/false/empty values are no longer silently discarded by sentinel
merge logic. The legacy typed Merge helper is no longer used for HTTP writes.

Unknown/non-public keys, file-only settings (even if the supplied value matches
the current value), wrong types, nulls, non-object patches, and invalid lane
approval values return HTTP 400 with a setting path and reason. Malformed/unreadable
existing files, missing persistence configuration, write errors, and failed
read-back verification return HTTP 500, which the MCP tool propagates as an error.
The full read/merge/write/verify/publish operation is serialized. Memory and
broadcasts are updated only after successful verification.

Verification reopens the actual TOML file and compares the **original request's
supplied values** with the independently decoded file, using their schema types.
It does not compare a merge result to itself or trust the response body. A missing
file cannot ordinarily masquerade as a successful write of defaults: existence
is checked before the strict read. Unrelated on-disk owner edits are retained.

Limits: this is a point-in-time persistence contract, not an acknowledgement from
every browser. Disconnected clients or failed WebSocket delivery cannot be proven
to have consumed a broadcast. An external writer can still race this process or
change/delete the file after verification; no cross-process lock was added. The
existing directory fsync remains best-effort, so this is not proof against all
power-loss/filesystem failures. If verification fails after rename, the file may
already have changed; the operation returns an error and does not publish new
memory/broadcast state, rather than attempting a potentially destructive rollback.
No new semantic validation rules were invented for unrelated settings. Lane
launch behavior, existing per-lane overrides, and already-running agents were not
changed or exercised by this check. The read-back mismatch branch was inspected
but not fault-injected; actual permission and malformed-file failures were exercised.

## Isolation and commands

Read AGENTS.md before work. Origin/main was `ae2af03` (at v0.40.0, newer than the
reported v0.38.0). Created branch `fix/config-write-20260922` and worktree
`/home/ken/work/muxterm-config-write-20260922` because the original checkout had
another lane's uncommitted work. No unit tests were added or run.

Used the repository's `make dev-local`, with a temporary, uncommitted change to
`.air.local.toml` selecting `127.0.0.1:18333`, plus:

```sh
TMPDIR=/tmp/muxterm-config-write-20260922 \
XDG_CONFIG_HOME=/tmp/muxterm-config-write-20260922/config \
make dev-local
```

This used DEV_ISOLATE for runtime/data separation; the config override additionally
isolated all settings writes. The config was seeded with `[lanes] approval =
"prompt"`. Port 8313 was initially free but another lane claimed it during startup.
One early MCP probe consequently reached that other dev server; it returned the
unchanged `prompt` and is **excluded from the evidence below**. The other dev
stack's observed config path was `/tmp/muxterm-release-evidence/browser-config`.
All evidence below followed ownership verification of the listener at 18333.
Production ports 9090/8311 were never targeted and no production process was
signaled. No other worktree or source was reset or deleted.

`mcp.py` below denotes a throwaway live-client helper, not a unit test. Each call
started this worktree's `./bin/muxterm-dev mcp` in a **separate process** with:

```text
XDG_RUNTIME_DIR=/tmp/muxterm-config-write-20260922/muxterm-dev-local
XDG_DATA_HOME=/tmp/muxterm-config-write-20260922/muxterm-dev-local/data
XDG_CONFIG_HOME=/tmp/muxterm-config-write-20260922/config
```

It sent one newline-delimited JSON-RPC `tools/call` request, with the tool name
and JSON arguments shown below. Successful full config responses were summarized
to `tool`, `isError`, and `lanes` for readable output; errors were printed intact.
Browser checks used `npx --yes --package @playwright/cli playwright-cli
-s=config-write` and a real Chromium tab connected to the real dev sessiond.
A browser init script recorded incoming application WebSocket `config` frames.

## Baseline reproduction: actual output

```text
$ ss -ltnp 'sport = :18333'
LISTEN 0 4096 127.0.0.1:18333 0.0.0.0:* users:(("muxterm-dev",pid=2156062,fd=3))
$ stat -c 'before inode=%i mtime=%y' /tmp/muxterm-config-write-20260922/config/muxterm/config.toml
before inode=2420990 mtime=2026-09-22 05:12:58.867626361 +0000
$ python3 tmp/verification/mcp.py update_config '{"changes":{"lanes":{"approval":"never"}}}'
{"tool": "update_config", "isError": false, "lanes": {"approval": "prompt"}}
$ stat -c 'after inode=%i mtime=%y' /tmp/muxterm-config-write-20260922/config/muxterm/config.toml
after inode=2426548 mtime=2026-09-22 05:14:24.252743263 +0000
$ head -3 /tmp/muxterm-config-write-20260922/config/muxterm/config.toml
[lanes]
  approval = "prompt"

$ python3 tmp/verification/mcp.py get_config
{"tool": "get_config", "isError": false, "lanes": {"approval": "prompt"}}
```

## Fixed build: actual output

Stopped my original make/sessiond by explicit PID before editing. Started a fresh
DEV_ISOLATE runtime and a fresh workspace/pane for the fixed build.

```text
$ ps -C muxterm-dev -o pid,args
2160227 /home/ken/work/muxterm-config-write-20260922/bin/muxterm-dev serve --addr 127.0.0.1:18333 --no-auth
2160260 /home/ken/work/muxterm-config-write-20260922/bin/muxterm-dev sessiond
$ python3 tmp/verification/mcp.py update_config '{"changes":{"lanes":{"approval":"never"}}}'
{"tool": "update_config", "isError": false, "lanes": {"approval": "never"}}
$ head -3 /tmp/muxterm-config-write-20260922/config/muxterm/config.toml
[lanes]
  approval = "never"

$ python3 tmp/verification/mcp.py get_config
{"tool": "get_config", "isError": false, "lanes": {"approval": "never"}}
$ playwright-cli -s=config-write eval 'JSON.stringify(window.configFrames.map(c => ({lanes:c.lanes,cursor_blink:c.terminal.cursor_blink})))'
### Result
"[{\"lanes\":{\"approval\":\"prompt\"},\"cursor_blink\":false},{\"lanes\":{\"approval\":\"never\"},\"cursor_blink\":false}]"
```

The browser snapshot showed muxterm, a real workspace/pane and terminal prompt.
The two page-load console errors were the unavailable sandbox presentation (503)
and a script-fetch 404; neither was a config request failure.
The two captured config frames show the initial value and subsequent live broadcast.

## Negative paths: actual output

```text
$ python3 tmp/verification/mcp.py update_config '{"changes":{"lanes":{"approvall":"never"}}}'
{"jsonrpc": "2.0", "id": 1, "error": {"code": -32603, "message": "update_config: HTTP 400: lanes.approvall: unknown or non-public setting\n"}}
$ python3 tmp/verification/mcp.py update_config '{"changes":{"lanes":{"approval":"sometimes"}}}'
{"jsonrpc": "2.0", "id": 1, "error": {"code": -32603, "message": "update_config: HTTP 400: lanes.approval: invalid value \"sometimes\" (want prompt or never)\n"}}
$ python3 tmp/verification/mcp.py update_config '{"changes":{"server":{"addr":"127.0.0.1:9999"}}}'
{"jsonrpc": "2.0", "id": 1, "error": {"code": -32603, "message": "update_config: HTTP 400: server: file-only setting; cannot be changed through update_config or PATCH /api/config\n"}}
$ python3 tmp/verification/mcp.py update_config '{"changes":{"unknown_setting":true}}'
{"jsonrpc": "2.0", "id": 1, "error": {"code": -32603, "message": "update_config: HTTP 400: unknown_setting: unknown or non-public setting\n"}}
$ python3 tmp/verification/mcp.py update_config '{"changes":{"lanes":{"approval":null}}}'
{"jsonrpc": "2.0", "id": 1, "error": {"code": -32603, "message": "update_config: HTTP 400: lanes.approval: null is not a setting value\n"}}
$ python3 tmp/verification/mcp.py update_config '{"changes":{"lanes":{"approval":false}}}'
{"jsonrpc": "2.0", "id": 1, "error": {"code": -32603, "message": "update_config: HTTP 400: lanes.approval: invalid value: json: cannot unmarshal bool into Go value of type string\n"}}
```

Made only my dev config directory non-writable, then restored its permissions:

```text
$ chmod 500 /tmp/muxterm-config-write-20260922/config/muxterm
$ python3 tmp/verification/mcp.py update_config '{"changes":{"lanes":{"approval":"prompt"}}}'
{"jsonrpc": "2.0", "id": 1, "error": {"code": -32603, "message": "update_config: HTTP 500: lanes: persistence failed: config.Write: create temp: open /tmp/muxterm-config-write-20260922/config/muxterm/.config.toml.4173158807: permission denied\n"}}
$ chmod 755 /tmp/muxterm-config-write-20260922/config/muxterm
$ python3 tmp/verification/mcp.py get_config
{"tool": "get_config", "isError": false, "lanes": {"approval": "never"}}
$ head -3 /tmp/muxterm-config-write-20260922/config/muxterm/config.toml
[lanes]
  approval = "never"

$ playwright-cli -s=config-write eval 'JSON.stringify({frameCount:window.configFrames.length,last:window.configFrames.at(-1).lanes})'
### Result
"{\"frameCount\":2,\"last\":{\"approval\":\"never\"}}"
```

Backed up my dev config, replaced it with malformed TOML, and restored the backup
after checking the failure. Memory stayed unchanged; the malformed file was not
overwritten:

```text
$ python3 tmp/verification/mcp.py update_config '{"changes":{"lanes":{"approval":"prompt"}}}'
{"jsonrpc": "2.0", "id": 1, "error": {"code": -32603, "message": "update_config: HTTP 500: lanes: cannot update unreadable config file\n"}}
$ cat /tmp/muxterm-config-write-20260922/config/muxterm/config.toml
[lanes
$ python3 tmp/verification/mcp.py get_config
{"tool": "get_config", "isError": false, "lanes": {"approval": "never"}}
```

Verified omission preserves a true boolean (the old typed merge cleared it):

```text
$ python3 tmp/verification/mcp.py update_config '{"changes":{"terminal":{"cursor_blink":true}}}'
{"tool": "update_config", "isError": false, "lanes": {"approval": "never"}}
$ python3 tmp/verification/mcp.py update_config '{"changes":{"lanes":{"approval":"never"}}}'
{"tool": "update_config", "isError": false, "lanes": {"approval": "never"}}
$ curl -sf http://127.0.0.1:18333/api/config | python3 -c 'import json,sys; c=json.load(sys.stdin); print(json.dumps({"lanes":c["lanes"],"cursor_blink":c["terminal"]["cursor_blink"]}))'
{"lanes": {"approval": "never"}, "cursor_blink": true}
```

## Full serve + sessiond restart: actual output

Stopped my make PID 2159673 and sessiond PID 2160260 with TERM, retained the config,
moved the old runtime/data directory aside, and ran the same `make dev-local`
command again. Browser reloaded against the fresh daemon/workspace.

```text
$ ss -ltnp 'sport = :18333'
LISTEN 0 4096 127.0.0.1:18333 0.0.0.0:* users:(("muxterm-dev",pid=2161660,fd=3))
$ python3 tmp/verification/mcp.py get_config
{"tool": "get_config", "isError": false, "lanes": {"approval": "never"}}
$ head -3 /tmp/muxterm-config-write-20260922/config/muxterm/config.toml
[lanes]
  approval = "never"

$ playwright-cli -s=config-write reload
### Page
- Page URL: http://127.0.0.1:18333/
- Page Title: muxterm
- Console: 2 errors, 0 warnings
$ playwright-cli -s=config-write eval 'JSON.stringify(window.configFrames.map(c=>({lanes:c.lanes,cursor_blink:c.terminal.cursor_blink})))'
### Result
"[{\"lanes\":{\"approval\":\"never\"},\"cursor_blink\":true}]"
$ ps -C muxterm-dev -o pid,args
2161660 /home/ken/work/muxterm-config-write-20260922/bin/muxterm-dev serve --addr 127.0.0.1:18333 --no-auth
2161671 /home/ken/work/muxterm-config-write-20260922/bin/muxterm-dev sessiond
```

## Static checks and teardown

`go build ./...`, `go vet ./...`, and `git diff --check` exited 0 with no output.
`cd web && npm run check:fast` exited 0: typecheck passed and oxlint reported 13
pre-existing warnings, zero errors. No unit tests were run.

Stopped my final make PID 2161095 and sessiond PID 2161671 with TERM, closed the
named Playwright browser, and reverted the local-only air port change. Final output:

```text
Browser 'config-write' closed

$ ss -ltnp 'sport = :18333'
State Recv-Q Send-Q Local Address:Port Peer Address:PortProcess
$ ps -p 2161095,2161144,2161660,2161671 -o pid,stat,args
    PID STAT COMMAND
```

No processes from this verification remained. Production was not restarted. Nothing was merged
or released.
