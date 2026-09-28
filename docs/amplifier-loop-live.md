# Amplifier live inputs

Loop-live is the execution path for the Operator and Amplifier SDK chats. On every boot the sidecar installs `amplifier-module-loop-live` from `internal/cos/sidecar/loop-live-requirements.txt` into its selected Amplifier interpreter. Installation or module validation failure stops boot.

Provider and model selection comes from the existing Amplifier CLI `AppSettings`; startup fails if that environment resolves no provider/model. The live bundle selects `loop-live@main` as its root orchestrator. The sidecar owns one `session.execute("")` task and registers `Runtime` as `live.runtime`.

Lifecycle notices submit `service` inputs with source `muxterm-lane-lifecycle` while a human turn runs. Their payload is an observation, and loop-live does not let a service source authorize actions. The server accepts a human correction on the existing WebSocket as `{"type":"cos-steer","prompt":"...","client_ref":"stable-id"}`. It replies with `cos-steer-result` after local submission; the broadcast `input_accepted`, `input_delivered`, and `generation_finished` events carry the authoritative input and generation IDs. The `client_ref` must stay the same on a retry.

The runtime inbox and accepted-input identities are memory-only. A sidecar exit after acceptance produces an uncertain result for the host; muxterm never replays that input automatically. Bounded history events are observations, not a replay log.
