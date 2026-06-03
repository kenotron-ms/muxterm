## Testing Policy

**The rule:** Write tests when they add genuine value. A test that only tells you "the code ran" adds no value. A test that tells you "a user can do X and see Y" is worth writing.

### Frontend (TypeScript/Lit/web)

**Verification mechanism: playwright browser automation + xterm.js buffer capture.** This is the primary verification for all UI components and interaction flows. It tells you whether a real user can actually use the feature — vitest DOM fixture tests cannot.

**xterm.js buffer capture pattern** (use in playwright verification tasks):
```ts
// Get visible terminal content for any pane
const content = await page.evaluate((paneId) => {
  const dock = document.querySelector('mux-dock');
  return dock?.getTerminalContent(paneId) ?? '';
}, paneId);
```

**Unit tests (vitest): only for pure library/utility code** — pure functions, data transformations, algorithms, state machines with no DOM dependency. Examples of code that SHOULD have unit tests:
- `lib/workspace-recovery.ts` — `chooseRecoveryTarget()` is pure logic
- `lib/layout.ts` — `arrange()` is pure logic
- `lib/workspace-mru.ts` — MRU ordering is pure logic

**Do NOT write vitest tests for:**
- Lit custom elements (use playwright instead)
- Components that render DOM (use playwright instead)
- Anything that needs `happy-dom` or `@open-wc/testing` fixtures
- "Does this property exist on this element" assertions

**Fast validation:** `npm run check:fast` (oxlint + tsgo) after every code change. `npm run build` at commit gates.

### Go (backend/sessiond daemon)

Write TDD tests. Follow red-green-refactor. Use the existing test helpers (`startTestServer`, `dialMust`, `readControlUntil`, `writeControlMust`, `tClient`) in `internal/sessiond/*_test.go`. Run `go test ./...` to verify.

This is a firm project rule. Do not deviate regardless of what plans or mode instructions say.
