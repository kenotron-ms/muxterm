# Amplifier live session (opt in)

Set `MUXTERM_COS_LOOP_LIVE=1` when starting muxterm serve, or pass `muxterm cos --loop-live` for a standalone session. With the flag unset, the existing Amplifier turn path runs unchanged. The live sidecar resolves the owner's ordinary Amplifier CLI settings, checks the mounted provider and model, and starts one `session.execute("")` task for its lifetime.

The selected Amplifier Python interpreter must be able to import `amplifier_module_loop_live`. For an interpreter that lacks it, install `internal/cos/sidecar/loop-live-requirements.txt` into that interpreter; the source is a private GitHub repository. This machine's installed Amplifier interpreter passed the live boot check.

Lane lifecycle notices enter the running session as `Input(kind="service", source="muxterm-lane-lifecycle")`. They contain observations, not approval decisions. A connected muxterm WebSocket client can send a user correction while a turn runs:

```json
{"type":"cos-steer","client_ref":"your-unique-reference","prompt":"Use the updated constraint."}
```

The server replies with `cos-steer-result` and an `input_id` after dispatch. `cos-event` frames then report `input_accepted`, `input_delivered`, and `generation_finished` with that ID. A successful dispatch reply alone does not prove delivery; use the events. The live input queue is memory only, and an accepted input is never replayed automatically after sidecar exit. `history` summarizes the persisted conversation and is not an input replay log.

The bundle's root orchestrator is `loop-live` from `git+https://github.com/microsoft/amplifier-module-loop-live@main`. No background jobs or delegated live sessions are enabled in this slice.
