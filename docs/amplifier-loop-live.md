# Amplifier live inputs

Loop-live is opt-in for the Operator through `MUXTERM_COS_LOOP_LIVE` or the CLI `--loop-live` flag. With the flag off, Operator keeps its original execution and event schema. Amplifier SDK chats always use loop-live in their separate Python socket sidecar. That sidecar installs its embedded `amplifier-loop-live-requirements.txt` if the module is missing; installation failure stops chat creation.

Provider and model selection comes from the existing Amplifier CLI `AppSettings`; startup fails if that environment resolves no provider/model. The live bundle selects `loop-live@main` as its root orchestrator. The sidecar owns one `session.execute("")` task and registers `Runtime` as `live.runtime`.

Lifecycle notices submit `service` inputs with source `muxterm-lane-lifecycle` while a human turn runs. Their payload is an observation, and loop-live does not let a service source authorize actions. The server accepts a human correction on the existing WebSocket as `{"type":"cos-steer","prompt":"...","client_ref":"stable-id"}`. It replies with `cos-steer-result` after local submission; the broadcast `input_accepted`, `input_delivered`, and `generation_finished` events carry the authoritative input and generation IDs. The `client_ref` must stay the same on a retry.

The runtime inbox and accepted-input identities are memory-only. A sidecar exit after acceptance produces an uncertain result for the host; muxterm never replays that input automatically. Bounded history events are observations, not a replay log.
