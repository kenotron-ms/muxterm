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
may be idle; custom commands, browser panes, unsupported environments, and
inspection ambiguity remain unknown.

sessiond alone also authorizes destructive pane and workspace closure. Browser
controls emit close intents, keep targets live until daemon authority responds,
and wait for authoritative pane/workspace broadcasts before removing structure.

## Testing Policy

### ⛔ DO NOT WRITE UNIT TESTS

Unit tests are banned in this project. Do not write them. Do not ask if you should write them. Do not write them "just for the pure logic". Do not write vitest tests, Go table-driven tests for internal functions, or any test that runs without a real browser and a real sessiond process.

**Why:** muxterm is an integration system — the browser, the sessiond PTY daemon, and real shell processes inside terminals. Nothing meaningful is testable in isolation. A unit test that checks `_normalizeUrl()` returns the right string tells you nothing about whether a user can open a browser pane. A Go test that checks `injectBase()` modifies a byte slice tells you nothing about whether X-Frame-Options is actually stripped in a real HTTP response. These tests have accumulated across the codebase and none of them have ever caught a real bug or prevented a regression.

**What to do instead: VERIFICATION**

Every feature or fix must be verified by actually running muxterm and observing the behavior in a real browser. Use the `/muxterm-verify` skill and `playwright-cli` for this. Do not say a feature is done until you have seen it work with your own tool calls.

Verification pattern:
```bash
# 1. Build
make build

# 2. Run
./bin/muxterm &

# 3. Open and observe
playwright-cli open http://localhost:8311
playwright-cli snapshot
playwright-cli click e5
# ... verify the actual behavior
playwright-cli close
```

**You are not done until playwright-cli (or the muxterm-verify skill) confirms the feature works in a real browser.**

### Verification hygiene: fresh fixtures every time, especially when debugging

Lesson learned the hard way (multi-client resize/focus-authority fix, 2026-07-31): a long debugging session hammered a single reused workspace/pane with dozens of resize/attach/detach/reconnect cycles over several hours. The pane accumulated state that produced flaky, non-reproducible failures indistinguishable from real bugs — several hours were burned chasing a "regression" that was actually just test fixture rot, not the code under test.

**Rules to avoid this:**

- **Create a brand-new workspace (and therefore a brand-new pane) for every verification run**, especially every re-run while debugging something flaky. Never reuse a pane across multiple test iterations. A pane that's been resized/reattached dozens of times is not the same as a pane a real user just opened.
- **Kill and fully restart `make dev-local` (wiped `XDG_RUNTIME_DIR`) before a "clean" verification pass**, not just fresh browser sessions. A fresh browser tab against a long-lived, heavily-poked sessiond process is not a clean test.
- **Never edit source files while `air`'s dev-local watch loop is mid-test.** Concurrent edits trigger a rebuild that kills in-flight browser WebSocket connections, producing failures that look like application bugs but are actually the test harness pulling the rug out from under itself. Finish the test, *then* edit.
- **Check for stale sessiond processes from a different worktree before trusting a result.** `make dev-local` uses a fixed, worktree-independent socket path (`${TMPDIR:-/tmp}/muxterm-dev-local`) so it survives long paths — but that means two worktrees running `make dev-local` at different times can leave a stale daemon squatting on the same socket. Run `ps aux | grep sessiond` and confirm the binary path matches the worktree you're actually testing before trusting what you see in the browser.
- If a scenario is flaky (passes once, fails on the next identical-looking run), don't just re-run it more — that's the "3+ failures = question the pattern" signal. Rule out fixture/environment staleness with a fresh-everything run *before* concluding it's a real code defect.

### Fast static checks (required before commit)

These are NOT tests. They are type and lint checks:
- `cd web && npm run check:fast` — oxlint + tsgo (0 errors required)
- `go build ./...` — must compile clean

### Existing test files

There are existing `*_test.go` and `*.test.ts` files in the repo. Do not delete them (too disruptive), but do not add new ones. If a test file breaks because of your changes, fix the test to match the new behavior — do not write new tests to "cover" your change.
