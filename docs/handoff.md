# Muxterm: shared SDK harness runtimes and adapter lifecycle

## Objective

Use at most one long-lived harness runtime process per supported harness across muxterm. Represent individual chats as native sessions or threads on that shared runtime.

The user explicitly expects one Codex app-server for the entire muxterm instance. Apply the same process cap to every retained SDK chat harness. The shared muxterm Node sidecar is common infrastructure; every long-lived harness runtime or adapter process it starts counts toward that harness's cap. Tool commands and MCP servers are separate from this harness-runtime count. A sidecar that launches another harness backend per chat does not satisfy the requirement.

**Support gate:** Retain a harness only if it has at most one resident harness process across chats with correct isolation and lifecycle. SDK-owned subprocesses may run individual turns if they exit on their own when each turn ends; a process kept alive per chat between turns fails. If the actual installed version cannot satisfy this, remove that harness from new-chat choices, adapter dispatch, and supported-harness documentation. Do not keep a resident per-chat fallback. Preserve existing chat metadata and native history, and document how users can access or export conversations from a removed harness. This gate exists because idle per-chat backend costs defeat the performance objective.

This checkout is on the user's development machine. Implement and verify here using isolated `make dev-local`. Do not modify or restart the live muxterm services.

## Critical ownership boundary

**Muxterm owns its adapters. Each harness owns its internal lifecycle.**

Muxterm should manage:

- Shared harness connections and SDK clients.
- Per-chat adapter sessions and native session/thread IDs.
- Event subscriptions, routing, pending requests, and muxterm metadata.
- Registration and disposal of muxterm-provided tools and callbacks.
- Detachment through documented harness APIs when an adapter no longer needs a native session.

Muxterm should not implement custom cleanup of harness internals: idle worker eviction, process reaping, cache management, or forced thread unloading. Let each harness manage those resources through its supported lifecycle.

On close or archive, release muxterm's adapter resources. Use the native detach, unsubscribe, or session-close API where its semantics fit; do not assume a destructive native archive/delete operation is equivalent to hiding a chat in muxterm. Active work and autonomous goals must follow an explicit, documented policy.

On muxterm shutdown, dispose the shared clients through their supported APIs.

Success requires correct sharing and disposal of adapter resources **and no more than one resident harness runtime process per retained harness** after multiple chats finish their turns. SDK-owned per-turn processes may overlap while turns run, but must terminate without muxterm reaping. If a harness keeps extra agent workers resident per chat, it fails the support gate. For Codex, the explicit target remains one shared app-server with multiple threads routed through it.

## Investigation findings

Read-only investigation on 2026-11-03 found 16 muxterm-owned native Codex app-server processes:

| Muxterm chat metadata | Running app servers |
| --- | ---: |
| Working | 2 |
| Ready / between turns | 10 |
| Archived | 4 |
| Total | 16 |

The native Codex processes alone accounted for approximately 3.1 GiB of resident memory, excluding Node wrappers and MCP children.

Short samples showed aggregate kernel write accounting of approximately 0.43–0.49 MB/s. These are sampled process I/O counters, not a sustained throughput benchmark or a complete attribution of all writes.

Each old app-server repeatedly logged a remote-control authentication retry:

```text
waiting to resolve remote control preference until authentication is available
error=remote control requires ChatGPT authentication; API key auth is not supported
```

This occurred approximately once per second per server. One recent window contained 4,286 remote-control log messages and 26 logged local RPC requests.

A brief syscall trace of a mostly idle server confirmed reads from the shared Codex logging database, WAL writes, and SQLite temporary-file writes. The retry originates inside `codex_app_server_transport::transport::remote_control::websocket`. There was no evidence that a desktop app or another device was repeatedly connecting.

The Codex retry and muxterm's adapter ownership are separate issues: unnecessary Codex background logging was multiplied across the per-chat app-servers.

## Current adapter behavior

These findings describe the baseline inspected before the shared-runtime work below:

| Harness | Observed adapter ownership |
| --- | --- |
| Codex | Each `CodexStream` spawns `codex app-server --stdio` |
| Copilot | Each chat constructs and starts a `CopilotClient` |
| ACP: Pi, OpenCode, DeepSeek | Each `ACPStream` spawns an agent process |
| Claude | Each chat owns a streaming SDK query whose input generator waits between turns; child-process lifetime was not measured |
| Amplifier | Shared Python host containing separate in-process chat sessions |

For Codex, `s.codex ||= new CodexStream(...)` reuses an instance within a chat. It does not share an app-server across chats. The sidecar's session map prevents duplicate creation for the same chat ID.

Before the archive change, archiving saved a metadata flag without detaching the adapter. Browser disconnection removed its event subscription while retaining the backend session. The sidecar exposed a `close` operation, but Go had no per-chat caller invoking it.

Do not turn these findings into a muxterm idle-reaper project. Fix connection ownership and adapter detachment, and allow the harness to manage the consequences internally.

## Implementation requirements

1. Introduce shared runtime ownership outside individual chat adapters. Concurrent first use must not create duplicate shared clients or processes.
2. Initialize each shared transport once. Create or resume native sessions for individual chats on that connection.
3. Route responses, notifications, questions, tool calls, and errors using native session/thread identity. Avoid shared mutable state that can mix chats.
4. Preserve independent working directories, permissions, model selections, histories, goals, and cancellation behavior.
5. Preserve per-chat MCP identity and authorization. The earlier installed Codex sidecar supplied a chat-specific `MUXTERM_CHAT_ORIGIN_FILE` through process configuration; that variable is absent from the checkout inspected in the later [harness spike](spikes/shared-harness-runtime.md). Trace the actual target checkout's identity path. Moving to one server must not bind every chat to one chat's identity. Verify a supported session-scoped configuration or tool-routing mechanism before choosing an implementation.
6. Release subscriptions, routing entries, callbacks, and pending adapter requests when their chat adapter is disposed. Closing one chat must not dispose the shared client used by others.
7. Define archive behavior independently from native history deletion and from cancellation of active work.
8. Handle shared-runtime failures centrally. Clear stale adapter references and expose uncertain delivery explicitly. Never automatically replay input that the harness may already have accepted.
9. Reuse shared model/config discovery where appropriate without mixing session-specific selections.
10. Dispose shared clients once on muxterm shutdown through supported SDK or protocol APIs.

Verify multiplexing and the one-process cap for each actual SDK and version. Do not assume a session-oriented protocol guarantees that every agent implementation supports concurrent sessions in one process. Remove harnesses that fail the support gate, including their new-chat entry points and dispatch paths; preserve and document access to historical data. Do not silently retain the per-chat client pattern under a new manager abstraction.

The read-only [per-harness spike](spikes/shared-harness-runtime.md) found that installed Pi ACP launches a Pi subprocess per chat and closes other sessions during load. Claude session history persists independently of process lifetime. Its SDK offers one-shot `query()` calls with session resume as a possible per-turn process path, while muxterm currently keeps a streaming input generator waiting between turns. Measure actual child lifetime: an SDK `result` marks turn completion, not process exit. Verify process exit and required feature behavior before retaining Claude; remove it if the per-turn path cannot meet both. Amplifier already shares its host, so inspect adapter/session disposal rather than replacing its host architecture unnecessarily.

## Source locations

Repository: <https://github.com/kenotron-ms/muxterm>

Start with:

- `sdk-chat/sidecar.mjs`
- `sdk-chat/codex-stream.mjs`
- `sdk-chat/acp-stream.mjs`
- `sdk-chat/copilot-stream.mjs`, where present
- `internal/server/sdk_chat.go`
- `internal/amplifierchat/sidecar/main.py`
- `web/src/components/mux-sdk-chat.ts`

An earlier inspection of `/home/ken/workspace/muxterm` saw branch `fix/chat-streaming-activity` at commit `22703035` with substantial pre-existing modifications. That snapshot is historical. Use the current files in this checkout as the implementation baseline and inspect their current state before editing.

The installed sidecar inspected on the working machine was under:

```text
/home/ken/.cache/muxterm/sdk-chat/1cd363023afa23bb/
```

Its adapters resolved installed CLI commands from PATH. The running Codex version was 0.163.0. Verify current source, dependencies, and executable resolution in this checkout.

Official Codex protocol documentation: <https://learn.chatgpt.com/docs/app-server>

The documentation exposes multiple loaded threads, native thread IDs, and thread subscription/unsubscription. Confirm exact methods and semantics against the version used by muxterm.

## Verification

Follow this checkout's `AGENTS.md`: use isolated `make dev-local` for real-browser integration verification, add no unit tests, and run the required build/type/lint checks.

Use real harness integrations to verify:

- Concurrent chat creation shares the harness client/runtime, including simultaneous first use.
- Two chats produce distinguishable output and receive only their own events, tool calls, and question responses.
- Different working directories, permissions, and MCP identities remain independent.
- Interrupting one chat does not interrupt another.
- Closing or archiving a chat releases its adapter resources while other chats continue.
- Reopening resumes the intended native session without creating duplicate subscriptions.
- Browser reconnect does not duplicate clients, sessions, or event delivery.
- Shared-runtime failure leaves adapter state recoverable and does not replay uncertain input.
- Shutdown disposes shared clients through supported APIs.

Collect evidence of shared adapter/client ownership and correct native lifecycle calls. Observe internal process behavior, but do not force internal worker cleanup to make a process-count assertion pass.

Do not install a development build over production or restart live muxterm services without separate authorization. The prior working-machine `AGENTS.md` explicitly prohibited disturbing the live muxterm/sessiond environment.

## Implementation and development verification

The implementation shares one Copilot SDK client across chats, disconnects individual Copilot sessions when archived, and stops the shared client on sidecar shutdown. A client ping during active turns detects a dead shared runtime, marks accepted turns uncertain, drops every stale adapter, and waits for the old client to stop before starting a replacement. Codex now owns one native app-server outside chat adapters, routes notifications by thread ID, applies MCP configuration per thread, and unsubscribes individual threads on archive. Launching the packaged native binary directly avoids keeping the package's JavaScript launcher as a second resident process. DeepSeek Harness now has one ACP transport with multiple native sessions and `session/close` on archive. DSH native session initialization is serialized on that connection; prompts on established sessions remain concurrent. An ACP prompt rejected after submission is marked uncertain, including when the connection rejects before its child exit callback. Pi and OpenCode are removed from new-chat choices and adapter dispatch; their saved muxterm histories remain readable. Go serializes send and archive for each chat and closes the resident adapter before marking a chat archived. Claude retains async streaming input during active turns and lets its SDK-owned process exit after each turn. An SDK stream failure with yielded input reports uncertain delivery. The Claude and Amplifier sidecars reject close during active work. Amplifier calls its supported session cleanup API on archive.

On this machine, an isolated `make dev-local` stack on port 8313 and a real browser verified two Copilot chats with distinct native histories and outputs. Both finished through one `copilot-runtime` child of the dev sidecar. Archiving the first chat made its sidecar adapter nonresident; a direct `options` request returned `Session is not resident; resume it first`. The second chat completed another turn, and restoring the first let it resume and complete a new turn through the same runtime child. This verifies the observed path, not every lifecycle or failure condition in the goal. The isolated dev stack was stopped after this run. No live muxterm services were restarted.

A later fresh isolated dev-local browser run verified two concurrently created Codex chats with distinct native thread IDs and outputs through one native app-server child. Both threads had separate `muxterm mcp` children carrying their own `MUXTERM_CHAT_SESSION_ID` environment values. Archiving one chat detached its sidecar adapter while the same app-server PID and the other chat remained live. The other chat completed another turn; restoring the first chat resumed its original native thread and history through that same app-server. A standalone app-server probe also confirmed that distinct `thread/start` configuration values reach each thread's MCP subprocess. This proved thread-scoped MCP process identity; later capability checks below add the server-side authorization evidence. The isolated dev stack was stopped after the run.

Another fresh isolated dev-local browser run verified two DeepSeek Harness chats created concurrently in the same directory. They had distinct native ACP session IDs, separate outputs, and two MCP subprocesses with different `MUXTERM_CHAT_SESSION_ID` values under one resident DeepSeek ACP process. Archiving one detached its adapter while the other chat completed another turn. Restoring the first resumed its original native session and history through the same ACP process. The browser new-chat list excluded Pi and OpenCode, and direct create requests for both returned HTTP 400. Saved muxterm histories are still served by `GET /api/sdk-chats/{id}/history?view=messages`; no native history deletion was added. This verifies the observed path but does not yet prove cross-chat MCP authorization or runtime-failure behavior. The isolated dev stack was stopped after the run.

A fresh isolated dev-local browser run verified Claude's finite-per-turn streaming query. Two chats in one project produced separate replies. During a 12-second Bash turn, the second chat accepted another user input before the turn finished; its streamed answer included markers from both inputs. A later browser message resumed the same native Claude session ID and used context from the preceding turn. `ps --ppid` showed no Claude child under the shared sidecar after either settled turn. The async input generator remains open during active work, then closes after the SDK result so the SDK-owned child exits naturally.

A second fresh dev-local run verified **steering**, which is the required streaming-input behavior. A `kind: steer` input interrupted an active 18-second Bash command; the history recorded the interrupted tool, the accepted correction, `turn.continued`, and a `STEERED_ANSWER` completion before the sleep would have finished. In the browser, another active Bash turn showed the “Steer running turn” composer. Entering a correction there stopped the tool, displayed the correction as an interjection in the expanded work group, and produced `UI_STEERED`. The Claude SDK child was absent under the sidecar after the turn settled. This observed path does not yet prove archive, shared-runtime failure, or shutdown behavior. Both isolated dev stacks were stopped after their runs.

The current patch also issues a separate serve-side capability for each resident chat. Codex, Copilot, DeepSeek, and Claude pass a private per-adapter lease file to their muxterm MCP subprocess; Amplifier passes the same capability through its per-session MCP configuration. The MCP bridge reads the capability for each HTTP request, and `control-send` checks that the sender owns the target or has a direct operator/lane link. Receipt reuse is bound to the sender chat. Archiving revokes the capability and removes its file. Each reopen uses a new file path because a native harness can leave an old MCP child alive after unsubscribe; the old child must not acquire the replacement capability by reading the same path.

In a fresh dev-local browser run, two Codex chats in the same directory had one app-server, separate MCP child environment tags, distinct 0600 capability files, and separate outputs. An actual `muxterm mcp` `send_chat_message` call from chat A to chat B returned HTTP 403, while A's self-send succeeded and appeared only in A's browser transcript. After A was archived, its file was gone and its old token returned 403; B's MCP self-send still completed. A second fresh run archived and reopened one Codex chat: the new capability file path differed, the old token stayed rejected, the native thread ID was preserved, and the browser showed both turns. This verifies the Codex MCP control-send boundary and revocation. Both dev stacks were stopped after their runs.

A fresh dev-local run created Copilot, DeepSeek, Claude, and Amplifier chats in one project; all returned separate expected outputs. Process environment inspection found distinct capability leases in each harness's muxterm MCP subprocess. Claude's MCP environment was sampled during an active turn because its SDK child exits at idle. Cross-chat `control-send` requests carrying each harness's actual capability returned HTTP 403. Two Amplifier chats in the same directory shared one Python host. Archiving A revoked its token, B completed another turn, and restoring A preserved its native ID and history. After operator A was linked directly to lane B, A's new token could send to B (HTTP 202); A's old archived token still received HTTP 403.

That run also exposed an Amplifier cleanup defect: archiving A left its old mounted MCP subprocess alive, and restoring A added another. The adapter now calls the installed Amplifier session's supported `cleanup()` method after its turn and transcript tasks settle. In a second fresh dev-local browser run, two concurrently created Amplifier chats shared one host and each had one MCP child. Archiving A removed only A's MCP child. B then completed another turn. Reopening A resumed its native history and created one new MCP child; the browser showed both of A's turns and no duplicate A child remained. The isolated dev stacks were stopped after their runs.

In a fresh dev-local failure run, two active Codex chats shared one app-server. Terminating only that verified dev-local child marked both chats `uncertain` without replaying their input. The browser displayed the recovery warning. An explicit new message to A resumed its original native thread and returned `RECOVERED_A` while B remained uncertain. A DeepSeek failure attempt in that run did not establish the intended condition: both turns had already settled by the time the DSH child was terminated.

In a separate clean dev-local browser run, two active Copilot chats shared one runtime child. Terminating only that verified dev-local child produced `session.uncertain` for both chats and removed the stale runtime. The browser showed the recovery warning and did not replay either accepted input. Explicit recovery messages returned `RECOVERED_A` and `RECOVERED_B` in their original native session IDs through one replacement runtime child. A final fresh run after serializing old-client stop and replacement start repeated this result: both chats became uncertain after the dev-only child was killed, browser and API recovery returned `FINAL_RECOVER_A` and `FINAL_RECOVER_B`, the original native IDs remained, and only one replacement runtime child remained at idle. Stopping that dev-local stack removed its sidecar and Copilot child and closed port 8313.

The same clean dev-local run terminated Claude's SDK-owned child during a Bash sleep. The chat became `uncertain`, and the browser displayed the recovery warning with the interrupted work. An explicit message returned `CLAUDE_RECOVERED` on the same native session ID. The replacement per-turn child was absent after the result, confirming natural exit in this recovery path. Two new DeepSeek chats in that run remained in `starting` for over 60 seconds, and the create requests timed out before native turn acceptance. A later single-chat start succeeded, and two more sessions initialized concurrently on that existing runtime. DSH native session creation is now serialized to avoid the cold-start race.

A lifecycle run verified active-turn interrupt in the browser for Codex, Copilot, Claude, and Amplifier; each showed “Stopped by you” and returned to ready. Claude was then archived and restored, preserved its native session ID, replied `CLAUDE_REOPENED`, and had no child at idle. After the browser was closed and reopened, Claude's transcript still showed the reply, its event count remained 20, and the shared sidecar still had only its Codex and Copilot runtime children. The isolated stack was stopped after the run.

The first real DeepSeek runtime-failure attempt exposed a race: killing its verified dev-only child during an accepted Bash `sleep 60` left the chat `failed` with `ACP connection closed`. The prompt promise rejected before the child exit callback; the adapter cleared its busy flag and emitted a normal error. After the fix, a fresh browser run created two DeepSeek chats concurrently from cold start, producing distinct native IDs under one DSH process. Killing that process during an accepted Bash sleep marked A `uncertain`, displayed the recovery warning, and did not replay input. Explicit messages returned `DSH_RECOVER_A` and `DSH_RECOVER_B` on their original native IDs through one replacement process. Interrupting B showed “Stopped by you”; archiving B left A usable; restoring B preserved its native ID and returned `B_REOPENED`. Browser reconnect left B's event count at 14 and the DSH process count at one.

That run also verified Amplifier host failure. Two chats shared one host. Killing only that verified dev-local host during A's active turn marked A `uncertain` in the browser, while idle B stayed ready. The UI stated that the accepted input was not replayed. Explicit messages returned `AMP_RECOVER_A` and `AMP_RECOVER_B` on their original native IDs through one replacement Python host.

A shutdown audit found that the default Air stop killed the dev Go server before its graceful adapter cleanup ran. The runtime processes exited but four 0600 capability files remained. The local Air config now sends interrupt and allows 20 seconds for graceful exit; the Go sidecar close window is 15 seconds. The sidecar revokes leases before awaiting concurrent adapter closes, then calls the supported shared-client stop paths. In a fresh final run, five browser-visible chats were ready. At idle there was exactly one Codex app-server, one Copilot runtime, one DSH runtime, one Amplifier Python host, and no Claude child. Stopping `make dev-local` logged a clean sidecar exit; all four runtime processes and the sidecar disappeared, the four capability files were gone, and port 8313 was closed. The isolated stack and browser are stopped.

A separate browser run tested working-directory isolation. For each of Codex, Copilot, DeepSeek, Claude, and Amplifier, chats in two different folders used shell tools to report their own `pwd` and read distinct `ALPHA_MARKER` and `BRAVO_MARKER` files. All ten replies matched their own folders; the browser displayed the correct marker and path for each retained harness. Amplifier A repeated `pwd` after a 15-second sleep while Amplifier B initialized in the other folder, and A still read its own marker. One process per resident harness remained at idle. Codex A and Claude A were then set to read-only, while their B peers stayed full-permission. The read-only chats did not create requested fixture files; Codex reported `Read-only file system`, and Claude remained in plan mode. The full-permission peers created and read back their own files. The browser showed these results and the distinct permission settings.

A fresh browser reconnect run visited one ready chat for each retained harness, closed the browser, reopened it, and revisited all five transcripts. Every expected reply appeared both times. For each chat, the counts of `input.accepted`, `assistant.delta`, and `turn.completed` stayed at one before and after reconnect. The shared sidecar still had exactly one Codex, Copilot, and DeepSeek child, and the Go server one Amplifier host; Claude had no idle child. The stack stopped cleanly, with zero remaining capability files and port 8313 closed.

The per-chat capability initially guarded only `control-send`. A final authorization audit found that an SDK-owned MCP process could otherwise address another chat's history or page route through its local server token. The serve-side origin boundary now checks the capability on every chat-specific HTTP route, and content search filters out chats outside the caller's own or directly linked operator/lane relationship. An agent cannot enable operator mode or replace its lane set; a human-enabled operator may still link a lane through its dedicated MCP tool. In two fresh same-directory Codex chats, an actual `muxterm mcp` transcript request from A to unrelated B returned HTTP 403 while A's self-read succeeded. Direct integration requests confirmed B's page mutation was denied, A's own page route reached its handler, B's content was absent from A's search, and a human's normal B history read still worked. After a human enabled A as operator, A's actual `link_operator_lane` MCP call succeeded, A and B could read each other's histories, and B could not mutate A's links. Archiving A revoked its capability and removed its lease file; its old token then received HTTP 403 even for its own history, while B remained usable. The browser displayed both distinct chats. This boundary scopes local SDK chat routes; other global MCP APIs continue to use their existing local authorization.

## Release branch integration on current main

On 2026-11-03 this implementation was applied to the current `origin/main` in a separate worktree and verified on this machine with isolated `make dev-local` at port 8313. The latest main chat goal, inbox, and steering paths were retained. A provider schema issue exposed by real Amplifier turns was fixed by removing a top-level JSON Schema `oneOf` from `check_connection`; the handler still enforces exactly one identifier.

In the fresh release-branch browser run, concurrent first use produced two separate native chats and correct folder markers for each of Codex, Copilot, DeepSeek Harness, Claude, and Amplifier. The idle process snapshot showed one Codex app-server, one Copilot runtime, one DSH ACP process, one Amplifier host, and no Claude child. Two Codex chats in the same folder had distinct native thread IDs; A's capability could read A's history (HTTP 200) and was refused B's history (HTTP 403). Archiving A detached it and rotated its lease on reopen; B completed another turn, A resumed its original native thread, and both follow-up replies were visible after browser reload. Pi and OpenCode creation returned HTTP 400 and were absent from new-chat choices. A later browser check of the New Chat catalog returned 5 Claude, 20 Copilot, 44 DeepSeek, and 5 Amplifier model choices before chat creation. Temporary catalog sessions used no chat capability or MCP server, left no origin leases, and Claude's finite empty SDK query exited without an idle child. A later fresh browser run steered an active Claude Bash sleep; the installed SDK reported the interrupted original input as `error_during_execution` and then completed the steer. Muxterm treated only that acknowledged original-input result as a continuation, showed `STEERED_OK` in the browser, returned the chat to ready, and had no idle Claude child. The isolated stacks stopped with port 8313 closed and no origin lease files. No production service was restarted or replaced.

## Acceptance status on isolated dev-local

| Check | Result | Evidence |
| --- | --- | --- |
| Process/support gate | PASS | One resident runtime each for Codex, Copilot, DeepSeek, Amplifier after two chats; Claude's SDK-owned child exited after each settled turn. Pi and OpenCode absent from new-chat options and dispatch, HTTP 400 on creation, saved muxterm history readable. |
| Shared runtime and routing | PASS | Concurrent first use, distinct native IDs, outputs, cwd markers, read-only/full-permission behavior, and per-chat MCP capabilities observed with real integrations and browser. |
| Archive/reopen | PASS | Adapter detach and native identity preservation observed for all retained harnesses; peer chats continued through the same shared runtime. |
| Failure and recovery | PASS | Dev-only runtime/child termination yielded uncertain delivery for Codex, Copilot, DeepSeek, Claude, and Amplifier; explicit recovery preserved native IDs and did not replay accepted input. |
| Interrupt and reconnect | PASS | Browser showed stopped turns for all five retained harnesses; reconnect preserved one accepted input, answer, and completion per chat with no new resident runtime. |
| Shutdown | PASS | Graceful dev-local stop removed all shared clients, sidecar, capability files, and port 8313. |
| Static checks and handoff | PASS | `go build ./...`, `go vet ./...`, `cd web && npm run check:fast`, Node syntax checks, and `git diff --check` passed; detailed evidence is above. |

The web check emitted warnings but zero errors. No production muxterm service or port was touched.

## Earlier machine-level mitigation

A machine-level Codex policy file was added at `/etc/codex/requirements.toml`:

```toml
# Disable Codex remote control on this machine.
allow_remote_control = false
```

A temporary Codex 0.163.0 app-server confirmed remote control was disabled by this policy and was then terminated. Existing app-servers continued retrying because they had not restarted. No reduction in their retry activity was claimed after the policy change.

This command was also attempted:

```bash
codex app-server daemon disable-remote-control
```

It refused with:

```text
Error: app server is running but is not managed by codex app-server daemon
```

The retired `features.remote_control` flag is not the supported disable mechanism for the investigated version.

These machine-specific mitigations are background context, not the implementation of shared muxterm adapter ownership.
