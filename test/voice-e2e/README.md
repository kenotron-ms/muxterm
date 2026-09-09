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

Two harnesses live here, and they prove different halves:

| | `run.mjs` | `exit-conversation.mjs` |
|---|---|---|
| proves | the **plumbing** — WebRTC, the mint, the sideband, the orb | the **conversation** — what the model says, and when it calls a tool |
| drives | Chromium, a fake mic, a real muxterm server | the realtime endpoint directly, no server, no browser |
| turns | one utterance | many, scripted |

`run.mjs` cannot hold a conversation: Chromium's fake microphone plays one file
once, so there is no second thing to say. `exit-conversation.mjs` cannot see the
bridge: there is no muxterm process in it. Neither replaces the other.

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

---

# The spoken exit — `exit-conversation.mjs`

Whether a voice session asks to leave once or three times is not decided by any
branch in this repository. It is decided by a model reading `Instructions()` and
choosing when to call `end_voice_session`. You cannot prove that by reading the
code, and walking the prompt for the right sentences proves only that the
sentences are present — never that the model behaves. The evidence has to be a
conversation.

```
node exit-conversation.mjs                  # all three
node exit-conversation.mjs --only=yes       # one of yes|no|done-with
node exit-conversation.mjs --repeat=5       # the same conversations, five times
node exit-conversation.mjs --json=out.json  # the whole record, machine-readable
node exit-conversation.mjs --trace          # every realtime event, for diagnosis
```

| Scenario | The claim |
|---|---|
| `yes` | "I think I'm done here" → **one** question → "Yes" → `end_voice_session` in the **very next turn**. Turns in between are counted and printed. |
| `no` | "No, not yet" → the subject is dropped, and does not come back on three later, unrelated turns. |
| `done-with` | four finished *tasks* in a row — "done with that file", "that's done", "all done there", "finished with it" — never ask about leaving. |

`done-with` is the one that matters most and is easiest to forget: a
hair-trigger exit is a worse bug than a stubborn one, so the scenario piles the
word "done" up on purpose, which is the state a hair-trigger fires in.

## What makes it honest

- The instructions and the tool list are read out of `internal/voice` **at run
  time** (`sessionspec/`), never pasted into the harness. A pasted copy proves
  that the copy behaves, which is not a fact about muxterm, and it stops being
  true the first time the real prompt is edited.
- The human side is **spoken**. Each line is synthesized to PCM16 by the same
  endpoint and fed in as input audio, so the model hears the phrase rather than
  reading it, and what it heard is printed whenever it differs.
- `end_voice_session` is answered with `endsession.go`'s own strings, byte for
  byte, so the turn *after* the hang-up is the turn production would produce.
- A model is not a function. `--repeat` exists because one green conversation is
  an anecdote, and the verdict reports `N/N` rather than "passed".
- An empty turn is retried once and then **fails the run** rather than being
  scored. Nothing can be concluded from a response the platform closed with
  nothing in it, so nothing is claimed.

## What it does not cover

**Turn segmentation.** Production uses server VAD to decide when the user has
stopped talking; this commits each utterance explicitly, so a turn boundary here
is a harness decision rather than a VAD decision. Everything under test — what
the model says, whether it asks twice, when the tool fires — is downstream of
that boundary. `run.mjs` is the one that exercises real VAD.

**The bridge.** There is no muxterm server and no chief of staff in this run.
The four working tools get short canned answers; only `end_voice_session` is
answered the way muxterm answers it. `run.mjs` proves the bridge.

## Two things in the plumbing are load-bearing

Both were learned the hard way, and both produce a transcript that *reads*
fine while being false:

- **Wait for `input_audio_buffer.committed` and for the input transcription
  before `response.create`.** Commit is asynchronous. Asking for a response too
  early hands the endpoint a conversation whose last item is still being
  written, which comes back as an empty turn the content filter closed — and
  every later answer shifted one turn late. On screen that looks exactly like a
  model ignoring the user and then asking an unprompted question. The bug looks
  like the feature failing; it is the harness talking over itself.
- **A failed wait must leave the event cursor alone.** An earlier version
  consumed every event it inspected, so one optional read that timed out
  swallowed the whole turn behind it.

Needs the same `az login` as `run.mjs`, and nothing else — no browser, no
server, no build.
