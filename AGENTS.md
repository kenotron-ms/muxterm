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

### Fast static checks (required before commit)

These are NOT tests. They are type and lint checks:
- `cd web && npm run check:fast` — oxlint + tsgo (0 errors required)
- `go build ./...` — must compile clean

### Existing test files

There are existing `*_test.go` and `*.test.ts` files in the repo. Do not delete them (too disruptive), but do not add new ones. If a test file breaks because of your changes, fix the test to match the new behavior — do not write new tests to "cover" your change.
