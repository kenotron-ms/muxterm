## Testing Policy

**Frontend (TypeScript/Lit/web):** Write NO tests. Do not write vitest tests, @open-wc/testing fixture tests, or any frontend unit/integration tests. Do not run `npm test` as part of task verification. Use `npm run check:fast` (oxlint + tsgo type check) for fast validation. Run `npm run build` only at commit gate time.

**Go (backend/sessiond daemon):** Write TDD tests. Follow red-green-refactor. Use the existing test helpers (startTestServer, dialMust, readControlUntil, writeControlMust, tClient) in internal/sessiond/*_test.go. Run `go test ./...` to verify.

This is a firm project rule. Do not deviate regardless of what plans or mode instructions say about TDD.
