# App voice lease-end suppression

`AppVoiceLeaseEnded` is the conceptual lifecycle name; the v1 wire frame is
`app-voice-lease-ended`.

## Before

```text
Composer End/Exit
  -> voiceSessionController.stop()
  -> appStop() -> beginRelease()
  -> appVoiceOperations.releaseLease(previousLease)
  -> synchronous listener(null, "explicit_end")
  -> fail("The app voice lease ended.")
  -> composer .voice-error[role=alert]
```

The server independently released the exact owner epoch and later sent its
`app-voice-lease-ended { lease_epoch, reason: "explicit_end" }` receipt. The
browser coordinator already treated that receipt as release-fence cleanup, but
the earlier local lifecycle notification had already been presented as an
error.

## After

```text
Composer End/Exit
  -> voiceSessionController.exitByUser()
  -> capture { browserGeneration, leaseEpoch, sessionId }
  -> releaseLease(lease, localSessionId)
  -> { kind: "ended", source: "local_release", reason: "explicit_end",
       leaseEpoch, localSessionId }
  -> exact one-use match => "suppressed_user_exit"
  -> idle composer without error, chat notice, toast, alert, or console message
```

`localSessionId` is in-process transition data only; it is never sent in a
WebSocket frame. The existing authenticated WebSocket release and same-origin,
control-token, exact-epoch HTTP end remain unchanged. The later matching server
receipt clears only the existing release fence, so it cannot affect a newer
lease.

## Exact distinction

Suppression requires all of:

1. the explicit composer `exitByUser()` path;
2. a locally emitted `local_release` transition;
3. `reason === "explicit_end"`;
4. the same lease epoch, local provider-session ID (including the empty
   pre-mint value), and browser generation.

The marker is consumed by that one synchronous local transition and cleared for
every other terminal path and before a new start. It is not a timeout or a
global "ignore the next end" flag.

| Terminal condition | Presentation outcome |
| --- | --- |
| Composer End/Exit for the armed local session | Normal handled exit; no lease-ended message |
| Server/provider expiry or provider terminal event | Visible safe lease-ended failure |
| Owner disconnect, logout, or revocation | Visible safe lease-ended failure |
| Explicit competing-tab takeover | Visible takeover-specific failure |
| Foreign or stale epoch | Ignored by existing epoch fencing; never matched as an exit |
| Reordered/duplicate receipt for the released epoch | Clears only the release fence; never tears down a new lease |
| End that cannot be confirmed by either bounded path | Not classified as a suppressed server success; existing safe authority fencing remains in force |
