# Realtime voice — automated end-to-end run

The only honest proof that a spoken conversation works is a spoken conversation.
A proof that needs a person at a microphone is a proof nobody re-runs, so this
harness drives the **real browser code path** with a **real WAV file** in place
of a mic, against the **real realtime endpoint**, and reads back what was
actually heard and said.

```
npm install
node run.mjs            # headless
node run.mjs --headed   # watch it happen
node run.mjs --keep     # keep the temp dir and server log for diagnosis
```

## What it asserts

A successful WebRTC handshake proves nothing on its own. What is asserted is
audio in **both** directions and a real action taken:

| # | Check | Component |
|---|---|---|
| 1 | an ephemeral secret is minted server-side, `ek_…` | C2 |
| 2 | a real `RTCPeerConnection` reaches `connected` against the endpoint | C4 |
| 3 | pre-synthesized speech is fed in place of a microphone | — |
| 4 | the **input** transcript comes back — the model *heard* it | C4 |
| 5 | inbound and outbound RTP bytes, packets, and rendered samples | C4 |
| 6 | a tool executes **server-side** over the sideband, and is answered | C5 |
| 7 | the late answer is **injected** as its own utterance | C5 |
| 8 | the model **speaks** that answer — an utterance after the injection | C5 |
| 9 | the composer's send slot swaps to the orb and back | C3, C4 |
| 10 | the long-lived credential appears nowhere in the browser | C2 |

On failure it dumps the full sideband trace and the transcript log, so a red run
says what happened rather than that something did.

## The utterance

There is no checked-in audio file and no dependency on a TTS package. The
harness opens a plain WebSocket to the same realtime endpoint, sends text, and
keeps the audio spoken back — genuine model speech, which is exactly the input
this feature has to survive. Leading and trailing silence are added; the
trailing silence is load-bearing, because server VAD ends a turn on a pause and
an utterance flush with the end of the file never gets committed.

`%noloop` on Chromium's `--use-file-for-fake-audio-capture` is also
load-bearing. Without it the file replays forever, so the harness "speaks" again
every few seconds and interrupts the assistant mid-answer through the very
barge-in support this feature is built on. The bug looks like a flaky model; it
is a looping microphone.

## Isolation

Throwaway `XDG_RUNTIME_DIR`, `XDG_DATA_HOME` **and** `XDG_CONFIG_HOME`, on port
8319, with its own chief-of-staff transcript
(`MUXTERM_COS_SESSION_ID=muxterm-cos-voice-e2e`). Production on 8311 and its
sessiond are never touched, and `~/.local/share/muxterm/restore-snapshot.json`
is never read or written — overriding only `XDG_RUNTIME_DIR` leaves the
crash-restore snapshot resolving to the production path, which is how a dev run
corrupts what production would restore.

Everything it starts, it stops. The server, the browser and the temp directory
are torn down on every exit path, and the teardown is printed.

## What it needs

- `az login` with access to the configured resource (`auth_mode = "entra"`)
- a Chromium from `~/.cache/ms-playwright` (Playwright's cache)
- Go and npm, to build the binary and the frontend it embeds

Not part of the muxterm build. `npm install` here installs nothing into the
shipped bundle.

## Configuration

| Variable | Default |
|---|---|
| `VOICE_E2E_PORT` | `8319` |
| `VOICE_E2E_ENDPOINT` | `OPENAI_BASE_URL` from `~/.config/muxterm/keys.env` |
| `VOICE_E2E_MODEL` | `gpt-realtime-2.1` |
| `VOICE_E2E_UTTERANCE` | a question about this machine, which forces a real tool call |
