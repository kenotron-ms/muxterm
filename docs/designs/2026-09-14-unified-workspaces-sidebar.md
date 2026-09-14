# Unified Workspaces Sidebar

## Decision

Every sidebar item below **Workspaces** is a workspace. Local, SSH-hosted, and
`sandbox:<id>` workspaces differ only by their lightweight execution-source host group;
they are not destinations, chat contexts, or dashboard sections.

The earlier design-prototype alternatives are superseded. In particular, there is no
`Sandboxed workspaces` source band and pane count is retained as the compact, trailing
workspace-row detail.

## Implementation contract

- Keep one compact **Mission Control** row above the sole **Workspaces** heading. Its
  visible label is exactly `Mission Control`; its configured shortcut is tooltip and
  accessibility metadata only. Its click event and existing Mission Control behavior do
  not change.
- Render the existing local and remote host groups as lightweight disclosures. Put a
  source token *after* the host display name: `LOCAL` for the unqualified local host,
  `SSH` for `ssh:<id>`, `AZURE` for the authoritative `sandbox:<id>` namespace, and a
  neutral fallback for an unrecognized qualified host. Display names remain presentation
  values; stable host IDs remain identity.
- Separate host groups with a subtle divider. Keep existing remote stale/retry/create and
  connect behavior where it already exists; this change adds no host-control protocol.
- Render each workspace as one row: color-only status dot, ellipsized name, then one
  fixed trailing pane-count/close slot. The close control replaces the count in that
  exact slot on fine-pointer hover or keyboard focus; narrow/coarse presentation exposes
  it only for the attached workspace. Existing close intent, confirmation, and
  authoritative reconciliation remain the only close path.
- Use a safe activity seam on `workspace-list`: sessiond aggregates its own pane
  classifications as `busy`, `idle`, or `unknown` (busy wins; idle requires all panes to
  be idle; missing/unknown panes are unknown) and coalesces trusted lifecycle transitions
  into a new snapshot. The browser consumes direct local `needsInput`/`working`
  declarations before the daemon aggregate. Remote relay session records can be cached
  across a drop, so remote rows use only a connected host's aggregate and otherwise fail
  closed to `unknown` until a per-host freshness generation exists. Missing activity from
  an older daemon is also `unknown`, never inferred from screen content, focus, labels,
  browser timing, or terminal output.
- Do not touch existing workspace preview request, pixel renderer, tooltip sizing,
  active-pane selection, terminal layout, or preview scheduling.

## Scope boundary

This implementation excludes Mission Control behavior, composer/voice, Lobby or channel
UI, sharing/invites/ACL/authentication, remote transport or sandbox runtime work, data
migration/configuration, and production service changes. It adds no new tests; the
existing registry expectation is extended for the additive activity field.

## Verification record

- `npm run check:fast` and `npm run build` pass. The build retains the repository's
  existing CSS `@charset` and chunk-size warnings.
- `go test ./internal/sessiond -count=1` passes; the new registry activity expectation
  is covered by its existing test. The full suite remains blocked in this worktree by
  the unmodified `internal/server` test `TestAttachCompositionOrderingSurvivesConcurrentReplay`,
  which panics in out-of-scope `app_voice.go`; this pass intentionally does not change
  the voice path.
- An isolated `make dev-local` instance on `127.0.0.1:8313` supplied browser evidence in
  `tmp/unified-workspaces-sidebar-evidence/`: lifecycle idle → working → idle refresh,
  desktop hover and keyboard count → close swap with identical geometry, existing
  preview canvas, close confirmation/cancel, and desktop plus 390×844 portrait and
  844×390 landscape fixtures for LOCAL/SSH/AZURE groups. The instance and its
  `/tmp/muxterm-dev-local` runtime were removed after verification.