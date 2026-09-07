# Realtime voice conversation with the chief of staff — feasibility research

**Date:** 2026-09-07
**Repo state:** `kenotron-ms/muxterm`, branch `research/realtime-voice` off `origin/main` @ `794677b`
**Status:** research only. No muxterm behaviour was changed, nothing was provisioned, purchased, or enabled.

---

## The question

What exists today — in muxterm, in the Amplifier ecosystem, and in the model providers reachable
from this machine — to support **realtime, bidirectional voice conversation** with an assistant
acting in a chief-of-staff role?

Not dictation. Not push-to-talk transcription. A spoken conversation: the user talks, the assistant
talks back, both can interrupt.

## Verdict summary

| | Question | Verdict |
|---|---|---|
| **Q1** | What voice capability does muxterm already have? | **ANSWERED** — press-to-dictate STT only, browser-side, one utterance at a time, into a text box. Zero audio output. |
| **Q2** | Which realtime voice APIs are reachable through Amplifier's provider layer? | **ANSWERED** — none. The provider layer has no audio surface at all, and of the three named vendors zero have a working credential on this machine. |
| **Q3** | What exists in the Amplifier ecosystem for voice? | **ANSWERED** — nothing installed. Four uninstalled catalog entries and one documented architectural pattern. |
| **Q4** | What is the gap between today's dictation and real conversation? | **ANSWERED** — eight named gaps; the load-bearing one is that there is no audio-out path of any kind. |
| **Q5** | Recommendation | **ANSWERED** — architecture is ready and unusually favourable; the blocker is a credential, not code; do **not** route this through Amplifier's provider layer. |

### Reading the evidence markers

- **[VERIFIED]** — I read the code, or ran the check, and this is what it says.
- **[DOCUMENTED]** — vendor documentation says this. URL and check date given. Not independently tested.
- **[DERIVED]** — my arithmetic or inference from the above, labelled as such.

---

## Q1 — What voice capability does muxterm already have?

**Verdict: ANSWERED.**

**One-line answer: muxterm has press-to-dictate speech-to-text, running entirely in the browser via
the Web Speech API, which fills a text box that the user then presses send on. There is no
text-to-speech, no audio output, and no server-side audio of any kind.**

### The controller

All speech state lives in one singleton: `web/src/lib/voice-input-controller.ts` (358 lines).

**It is the browser's Web Speech API, not a server-side service** [VERIFIED]:

```ts
// web/src/lib/voice-input-controller.ts:71-78
function _resolveCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}
```

Feature availability is captured **once at module load**, and Android is deliberately excluded as a
product decision, not a workaround (`voice-input-controller.ts:86-87`).

### The mode it runs in — this is the crux

```ts
// web/src/lib/voice-input-controller.ts:210-212
const recognition = new _ctor();
recognition.continuous = false;
recognition.interimResults = false;
```

[VERIFIED] `continuous = false` and `interimResults = false` together mean: **one utterance per
button press, no partial results, and the session ends on the first final result.** The result
handler fans the text out to listeners and then immediately terminates the session:

```ts
// web/src/lib/voice-input-controller.ts:165-170
function _handleResult(token, text): void {
  if (token !== _tokenCounter || !_current) return;
  const { workspaceId, paneId } = _current.target;
  for (const cb of _transcriptListeners) cb({ text, workspaceId, paneId });
  _finishSession(token);        // <- back to idle. The mic is now off.
}
```

This is a well-built dictation primitive. It is architecturally incapable of being a conversation:
there is no continuous listening, no interim text, and the microphone closes itself after every
sentence.

### Where STT actually happens

[VERIFIED] In the browser, via the Web Speech API. Not on muxterm's server.

Confirmed by exhaustive negative search: grepping every `*.go` file in the repo for
`audio|voice|speech|opus|pcm|webrtc|transcri` returns **only** matches on the word *transcript* used
in the sense of *the conversation transcript* — e.g. `internal/server/cos.go:87`,
`internal/cos/supervisor.go:123`, `internal/cos/events.go:81`. Not one of them is speech-related.
There is no audio code on the server side at all.

⚠️ Worth knowing: [DOCUMENTED] "On some browsers, like Chrome, using Speech Recognition on a web
page involves a **server-based recognition engine**. Your audio is sent to a web service for
recognition processing, so it won't work offline."
(https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition, checked 2026-09-07). So the
current design is not "local and private" — in Chrome, the user's audio already leaves the machine,
it just goes to Google rather than to muxterm.

### The button

`web/src/components/mic-button.ts` (202 lines) is a **thin Lit component and nothing more**
[VERIFIED]. It renders a mic button, subscribes to the controller's pub/sub API, re-dispatches
transcripts as a bubbling `voice-transcript` DOM CustomEvent (`mic-button.ts:118-126`), toasts errors
(`:127-129`), and invalidates any in-flight session when it unmounts (`:147`). It renders **nothing
at all** if the API is unsupported (`:172`).

It is mounted in exactly one place: the **mobile** title bar (`web/src/components/title-bar.ts:388`).

### Two consumers of the transcript, not one

[VERIFIED] The singleton has two independent subscribers:

1. **Terminal dictation** — `web/src/app.ts:1686` `_onVoiceTranscript`, bound to the mic button's
   DOM event at `app.ts:1407`. Types the text into the focused pane's PTY.
2. **The chief-of-staff surface** — `web/src/components/mux-cos.ts:1242-1243`, which subscribes
   **directly to the singleton**, bypassing `mic-button.ts` entirely:

```ts
// web/src/components/mux-cos.ts:1242-1244
this._unsubTranscript = voiceInputController.onTranscript((p) => {
  this._takeTranscript(p.text);
});
```

The COS surface has its own mic button in the composer row (`mux-cos.ts:1769-1777`, the
`'Stop dictating'` / `'Dictate'` strings), toggled by `_toggleVoice` (`mux-cos.ts:2014-2017`).

### What `_takeTranscript` does — and deliberately does not do

```ts
// web/src/components/mux-cos.ts:2019-2039
/**
 * A finished transcript.
 *
 * It fills the COMPOSER; it does not send. Dictation is unreliable enough
 * that firing a turn off the back of it would make the surface feel like it
 * acts on things you did not say -- and the box is right there to fix a
 * word in before pressing send.
 */
private _takeTranscript(text: string): void {
  const t = text.trim();
  if (!t) return;
  this._draft = this._draft.trim() === '' ? t : `${this._draft.trimEnd()} ${t}`;
  ...
}
```

[VERIFIED] The dictated text is **appended to the composer draft and never sent.** There is a
deliberate, documented human-in-the-loop step between speaking and the assistant hearing anything.
That is a sound decision for dictation and a hard stop for conversation.

### Text-to-speech / audio out: none

[VERIFIED] Grepping `web/src` and `web/index.html` for
`speechSynthesis | SpeechSynthesisUtterance | new Audio( | AudioContext | <audio | HTMLAudioElement |
MediaSource | AudioWorklet | MediaRecorder | getUserMedia` returns **zero matches**.

muxterm cannot make a sound. There is no audio output path, no audio element, no synthesis call, and
no raw microphone capture (the Web Speech API handles the mic internally; muxterm never touches a
`MediaStream`).

### Q1 summary

| Capability | Present? | Evidence |
|---|---|---|
| Speech → text | ✅ Yes | `voice-input-controller.ts:71-78` (Web Speech API) |
| Continuous listening | ❌ No | `voice-input-controller.ts:211` `continuous = false` |
| Interim / partial results | ❌ No | `voice-input-controller.ts:212` `interimResults = false` |
| Auto-send after dictation | ❌ No, by design | `mux-cos.ts:2019-2027` (comment is explicit) |
| Server-side STT | ❌ No | zero audio matches in any `*.go` |
| Text → speech | ❌ **No** | zero matches, whole web tree |
| Any audio output | ❌ **No** | zero matches, whole web tree |
| Voice activity detection | ❌ No | not exposed by the Web Speech API at all |
| Barge-in | ❌ No | nothing to interrupt |

---

## Q2 — Which realtime voice APIs are reachable through Amplifier's provider layer?

**Verdict: ANSWERED.**

**One-line answer: none, on two independent grounds. Amplifier's provider abstraction has no audio
surface whatsoever, and of the three named vendors, zero have a working credential on this machine.**

### Ground 1 — the provider layer is text-only, structurally

[VERIFIED] The `Provider` protocol
(`~/.amplifier/cache/amplifier-core-61734c2990ff26ac/python/amplifier_core/interfaces.py:64`) has
exactly five members:

```python
class Provider(Protocol):
    @property
    def name(self) -> str: ...
    def get_info(self) -> ProviderInfo: ...
    async def list_models(self) -> list[ModelInfo]: ...
    async def complete(self, request: ChatRequest, **kwargs) -> ChatResponse: ...
    def parse_tool_calls(self, response: ChatResponse) -> list[ToolCall]: ...
```

There is no streaming-audio method, no bidirectional channel, no `AsyncIterator[bytes]`.
`complete()` is request → response over typed text messages.

The message envelope (`message_models.py`) supports: `text` (:31), `thinking` (:41),
`redacted_thinking` (:55), `tool_call` (:65), `tool_result` (:77), **`image` (:88)**, `reasoning`
(:98). **There is no `AudioBlock`.**

The note about `ImageBlock` matters: the envelope *was* extended once for a non-text modality. The
absence of an audio equivalent is a gap in the design, not an oversight of it.

The streaming layer is narrower still — `content_models.py:17-23` defines only four
`ContentBlockType` values: `TEXT`, `THINKING`, `TOOL_CALL`, `TOOL_RESULT`. Not even images.

An `AUDIO = "audio"` capability string exists (`capabilities.rs:36`, re-exported at
`amplifier_core/capabilities.py:19`) with the doc comment *"Model can process audio inputs."*
[VERIFIED] **No installed provider declares it, and nothing reads it.** It is a reserved constant
with no writer and no reader.

**Consequence:** adding realtime audio to Amplifier's provider layer is a kernel change — new
`ContentBlockType` values, a new content block, and either a new `Provider` method or an entirely
new protocol. It is not a module drop-in.

### Ground 2 — credentials actually present on this machine

I probed read-only (`GET /v1/models`), which neither provisions nor bills anything.

| Vendor | Credential | Verified status |
|---|---|---|
| **Anthropic** | `ANTHROPIC_API_KEY` set, `ANTHROPIC_BASE_URL=https://api.anthropic.com` | ✅ **HTTP 200 — valid**, 11 models visible |
| **OpenAI** | `OPENAI_API_KEY` set (`sk-proj-…`, 164 chars), `OPENAI_BASE_URL=https://api.openai.com/v1` | ❌ **HTTP 401 — `"Incorrect API key provided"`**, twice |
| **Google / Gemini** | — | ❌ **No credential.** No `GEMINI_*` or `GOOGLE_*` in env; no `~/.amplifier/.env`, no `credentials.json` |
| **Azure** | — | ❌ **No credential.** No `AZURE_*` in env |

[VERIFIED] **Control experiment:** the identical probe technique returned HTTP 200 from Anthropic in
the same script run. The OpenAI 401 is a real credential failure, not a bug in my probe. The base URL
is genuine `api.openai.com`, not a proxy or gateway that might reject a `/models` call.

### Ground 3 — what Amplifier is actually configured to use

[VERIFIED] `amplifier provider list` → **`providers (1 active)` → `anthropic`**.

`~/.amplifier/settings.yaml` configures exactly one provider module,
`provider-anthropic`, model `claude-opus-5`.

Nine provider modules are *cached* (`anthropic`, `azure-openai`, `chat-completions`, `gemini`,
`github-copilot`, `ollama`, `openai`, `openai-chatgpt`, `vllm`) but **none is a realtime/audio
provider**, and none is active. There is no `provider-openai-realtime` installed.

**The chief of staff's brain is Anthropic, and Anthropic ships no realtime speech-to-speech API.**
That is a structural fact worth sitting with: a provider-layer approach to voice would mean
*replacing the brain*, not adding a voice to it.

### Is the audio-streaming surface usable from a muxterm browser client?

Architecturally **yes** — and direct-from-browser is what all three vendors actually recommend. But
that path bypasses Amplifier's provider layer entirely.

[DOCUMENTED] All three support a browser client with an **ephemeral token** minted server-side, so
the long-lived key never reaches the browser:

| | Minting endpoint | Token TTL | Browser transport |
|---|---|---|---|
| **OpenAI Realtime** | `POST /v1/realtime/client_secrets` | 10–7200 s, **default 600 s** | **WebRTC** (recommended) |
| **Gemini Live** | `POST /v1beta/auth_tokens` | `expireTime` 30 min; `newSessionExpireTime` 1 min; `uses` 1 | **WebSocket only** (native) |
| **Azure OpenAI** | `POST /openai/v1/realtime/client_secrets` | **not documented** | **WebRTC** (recommended) |

Sources, all checked 2026-09-07:
https://platform.openai.com/docs/guides/realtime-webrtc.md ·
https://ai.google.dev/gemini-api/docs/ephemeral-tokens ·
https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/realtime-audio-webrtc

[DOCUMENTED] OpenAI, verbatim: *"When connecting to a Realtime model from the client (like a web
browser or mobile device), we recommend using WebRTC rather than WebSockets for more consistent
performance."* and *"you only use standard OpenAI API keys on the server, not in the browser."*

Two vendors also offer a **zero-credential-in-browser** variant where your server does the SDP
exchange: OpenAI's "unified interface" (`POST /v1/realtime/calls` from your server) and Azure's
`/connect` SDP proxy. Azure additionally offers `?webrtcfilter=on`, which restricts which data-channel
events reach the browser so your system prompt stays private.

### Status and models, for the record

[DOCUMENTED, checked 2026-09-07]

| | Status | Flagship realtime model |
|---|---|---|
| OpenAI Realtime | **GA** (docs carry a "Beta to GA migration" section) | `gpt-realtime-2.1` |
| Gemini Live | **Preview** (page states *"Preview: The Live API is in Preview."*) | `gemini-3.1-flash-live-preview` |
| Azure OpenAI realtime | API **GA**; `gpt-realtime-2.1` marked **preview** | `gpt-realtime-2` / `gpt-realtime` |

### Q2 summary

**No realtime voice API is reachable through Amplifier's provider layer, because that layer has no
audio surface to reach through.** Separately, and sufficient on its own, **no working credential
exists on this machine for any of the three vendors named.** The only valid credential is Anthropic,
which does not offer this capability.

---

## Q3 — What already exists in the Amplifier ecosystem for voice?

**Verdict: ANSWERED — nothing installed.** This is a well-evidenced negative, not an absence of
looking.

### What was searched

[VERIFIED] Case-insensitive, across `*.py *.md *.json *.yaml *.yml *.toml *.ts *.tsx *.js *.go *.sh`,
over all ~50 bundle directories in `~/.amplifier/cache/`, all of `~/.amplifier/` (config, registry,
settings, projects), and `amplifier_core/`, `amplifier_app_cli/`, `amplifier_foundation/` in
site-packages.

| Term | Result outside muxterm |
|---|---|
| `elevenlabs`, `deepgram`, `cartesia`, `assemblyai` | **0 matches anywhere on the machine** |
| `azure speech`, `cognitiveservices/speech` | 0 |
| `pyaudio`, `sounddevice` | 0 |
| `speechSynthesis`, `SpeechSynthesisUtterance` | **0 — no TTS anywhere, including muxterm** |
| `SpeechRecognition`, `microphone` | muxterm only |
| `vosk`, `espeak`, `piper`, `coqui`, `silero`, `riva` | 0 |
| `opus`, `STT` | 0 |
| `webrtc` | docs only — no implementation |
| `whisper`, `transcribe` | catalog rows only (below) |

**91 skills are installed. Zero are voice-related.** The contrast case is instructive: `image-vision`
exists and shows exactly what a modality skill looks like in this ecosystem — a `SKILL.md`, ready-to-
use scripts, and its own isolated `.venv`. No such artefact exists for audio. There is no `voice-*`,
`speech-*`, or `audio-*` skill directory anywhere.

**One MCP server is configured (`muxterm`, 18 tools). Zero of its tools are audio-related** — the Go
sources in `internal/mcp/` are terminal, workspace, layout, tunnel, and config tools.

**False positives, confirmed by reading rather than assumed:** `design-intelligence/agents/voice-
strategist.md` is a brand-tone/UX-writing agent; `wayfinder/context/wayfinder-voice.md` is a writing-
tone guide; `provider-gemini/README.md:113` explicitly states *"Multimodal capabilities (images,
video, audio) are **not yet implemented**"*; `tool-web/__init__.py:190` lists `"audio/"` in a MIME
prefix list used to **refuse** fetching binary content.

### What exists but is not installed

[VERIFIED] Four rows in `~/.amplifier/cache/amplifier-d1dda27a16518560/docs/MODULES.md` point at
external GitHub repos. None is in the cache, the registry, `settings.yaml`, or site-packages:

| Line | Module | Repo | What it claims |
|---|---|---|---|
| `:41` | `amplifier-voice` | `microsoft/amplifier-voice` | "Voice plugin for amplifierd — WebRTC voice interface using the OpenAI Realtime API" |
| `:287` | `app-voice` | `robotdad/amplifier-app-voice` | "Desktop voice assistant with native speech-to-speech via OpenAI Realtime API" |
| `:334` | `provider-openai-realtime` | `robotdad/amplifier-module-provider-openai-realtime` | "OpenAI Realtime API for native speech-to-speech interactions" |
| `:341` | `tool-whisper` | `robotdad/amplifier-module-tool-whisper` | "Speech-to-text transcription using OpenAI's Whisper API" |

Note: `amplifier-voice` is first-party but is an **`amplifierd` plugin**, and `amplifierd` is not
installed either. The other three are community modules from a single author, and the MODULES.md
community section carries an explicit security warning about arbitrary code execution.

### The ecosystem has already taken an architectural position

This is the most useful finding in Q3. [VERIFIED]
`~/.amplifier/cache/amplifier-foundation-c909465861f9d6ce/docs/APPLICATION_INTEGRATION_GUIDE.md:491-530`
documents **"Pattern D: Voice/Realtime Bridge"**, verbatim:

> **This is a bridge, not a replacement.** The voice model handles audio I/O, turn-taking,
> interruptions… Amplifier handles tool execution, agent spawning, and graph queries.
> **They meet at the tool boundary.**

The guide contains an illustrative `class VoiceBridge` snippet — documentation only, no shipped code.

**Amplifier's own guidance is that audio stays outside Amplifier, and the two systems meet at the
tool boundary.** That is exactly what Q5 independently concludes from the code. Two roads, same
destination — which is a good sign for the recommendation.

### One more corroboration

muxterm's own voice design doc, `docs/designs/2026-07-31-voice-input-design.md:17`, states: *"Zero
existing voice/speech/microphone code anywhere in the repo — confirmed via grep… no matches."*
Someone ran this same search in July 2026 and reached the same conclusion. This report is the second
independent confirmation.

---

## Q4 — The gap between today's dictation and true realtime conversation

**Verdict: ANSWERED.**

Today's flow, stated plainly: **press button → speak one sentence → the mic turns itself off → text
appears in a box → a human reads it → the human presses send → the assistant answers in text.**

A conversation is: **both parties' audio channels are open continuously, either can start talking at
any moment, and either can interrupt the other.**

These are not the same system with a feature missing. They are different systems. Here are the eight
specific gaps.

### Gap 1 — There is no audio out. At all.

This is the load-bearing gap and it dwarfs the others. [VERIFIED] Zero matches for any audio-output
API across the entire web tree (Q1). Everything else on this list is a refinement of a conversation;
this is the absence of half of one. muxterm currently cannot make a sound.

### Gap 2 — No voice activity detection, and no place to put one

[VERIFIED] `continuous = false`, `interimResults = false` (`voice-input-controller.ts:211-212`).
Turn-taking today is *a button press*.

[DOCUMENTED] The Web Speech API exposes **no VAD configuration whatsoever** — no threshold, no
silence duration, no semantic endpointing. `soundstart`/`speechstart` events fire but are not
configurable (https://webaudio.github.io/web-speech-api/, checked 2026-09-07). This is not a knob
muxterm has failed to turn; the knob does not exist.

All three realtime APIs provide server-side VAD natively [DOCUMENTED, 2026-09-07]:

| | Modes | Notable |
|---|---|---|
| OpenAI | `server_vad` (default) / `semantic_vad` / null | `semantic_vad` `eagerness` low/med/high → max 8 s / 4 s / 2 s |
| Gemini | automatic (default) / hybrid / manual | Google recommends `silenceDurationMs` **500–800 ms**; server default ~800 ms |
| Azure | `server_vad` / `semantic_vad` / `none` | sample config shows `silence_duration_ms: 200` |

⚠️ Footnote: OpenAI's reference states `silence_duration_ms` default **500 ms**, Azure's sample shows
**200 ms**, Google's server default is **~800 ms**. Three different numbers for the analogous knob —
do not assume portability of tuning.

### Gap 3 — Barge-in is structurally impossible today

You cannot interrupt something that never speaks (Gap 1). And the input side is half-duplex by
construction: `_handleResult` terminates the session on the first final result
(`voice-input-controller.ts:169`).

[DOCUMENTED] All three vendors support barge-in natively, and the client obligation differs by
transport — this is a real design input:

- **OpenAI over WebRTC/SIP:** *"the server manages a buffer of output audio, and thus knows how much
  audio has been played… The server will automatically truncate unplayed audio when there's a user
  interruption."* → **nothing required of the client.**
- **OpenAI over WebSocket:** client must watch `input_audio_buffer.speech_started`, stop playback,
  track ms played, and send `conversation.item.truncate`.
- **Gemini:** client watches `serverContent.interrupted === true` and — per Google's own code comment
  — *"should stop playing audio and clear queued playback here."*

(https://platform.openai.com/docs/guides/realtime-conversations.md ·
https://ai.google.dev/gemini-api/docs/live-guide, both checked 2026-09-07)

**This is a strong argument for WebRTC over WebSocket for a browser client:** the hardest part of
barge-in is handled server-side and costs zero client code.

### Gap 4 — The latency budget is not a conversational budget

Today's critical path contains an **unbounded human step by design**: `_takeTranscript` fills the
composer and deliberately does not send (`mux-cos.ts:2019-2027`). The time from "user stops speaking"
to "assistant starts working" is however long it takes a person to read a line of text and press a
button. No amount of tuning changes that; it is the intended behaviour.

Honest note on the numbers: **OpenAI and Google publish no time-to-first-audio figure.** Google's
"sub-second native audio streaming" is a product-page adjective on the 2.5 model, not a measurement.
The only concrete published figures are Microsoft's [DOCUMENTED, 2026-09-07]:

| Transport | Microsoft-published latency |
|---|---|
| WebRTC | **~100 ms** |
| WebSocket | **~200 ms** |

(https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/realtime-audio)

⚠️ These are headed "Connection methods" — they are **transport-level** figures with no stated
methodology, region, or percentile. Cite them as vendor guidance, not as a benchmark. This report
did not measure latency and does not claim an end-to-end number.

### Gap 5 — Long agent turns, where silence reads as failure — and muxterm's hidden advantage

This is the gap the goal was right to call out, and it is where muxterm is **better positioned than
almost any project attempting this.**

A chief-of-staff turn is not a chatbot reply. It runs tools, it thinks, it can take minutes. In text
that is fine — you watch it work. In voice, thirty seconds of silence is indistinguishable from a
crash.

[VERIFIED] **muxterm already emits exactly the narration material a voice channel needs.** The
sidecar protocol (`internal/cos/events.go:39-58`) defines a structured, real-time event stream:

```go
EvReady, EvTurnStart, EvDelta, EvThinking, EvToolStart, EvToolEnd,
EvApprovalRequest, EvTurnEnd, EvError, EvCancelled, ...
```

with fields per event kind (`events.go:110-140`) including `text` for `delta`/`thinking`, and
`name`, `args`, `ok`, `summary`, `ms` for `tool_start`/`tool_end`.

That stream already reaches the browser verbatim. `internal/server/cos.go:24` documents the wire
shape: `{"type":"cos-event","event":{...verbatim sidecar event...}}`, fanned out by a broker to every
subscribed tab. The client already switches on every kind — `mux-cos`'s store handles `turn_start`
(`cos-store.ts:465`), `delta` (`:484`), `thinking` (`:496`), `tool_start` (`:507`), `tool_end`
(`:525`), `approval_request` (`:558`), `turn_end` (`:579`).

And the deltas originate from a clean Amplifier hook — `internal/cos/sidecar/main.py:926`:

```python
hooks.register("llm:stream_block_delta", on_stream_delta, name="cos-delta")
```

which emits at `main.py:818`.

**A voice layer does not need to invent "what is it doing right now." That question is already
answered, structured, and streaming.** Most teams building voice over an agent have to build this
from nothing.

Vendor support for narrating long tool calls differs sharply [DOCUMENTED, 2026-09-07]:

- **OpenAI documents this explicitly.** `gpt-realtime-2`/`2.1` *"generates preambles by default"* —
  short spoken updates before longer tool use — with a prompting-guide section that names the exact
  case: *"you are about to call a tool that may take noticeable time"*, *"silence would make the
  assistant feel unresponsive."* Output items carry a **`phase`** field of `"commentary"` or
  `"final_answer"` so the client can treat them differently.
  (https://platform.openai.com/docs/guides/realtime-models-prompting.md)
- **Gemini 3.1 Flash Live blocks.** Verbatim: *"Asynchronous function calling is not yet supported in
  Gemini 3.1 Flash Live. **The model will not start responding until you've sent the tool response.**"*
  A 30-second tool call is 30 seconds of dead air with no vendor-documented filler mechanism.
  Gemini **2.5** has `behavior: NON_BLOCKING` plus `scheduling: INTERRUPT|WHEN_IDLE|SILENT`.
  (https://ai.google.dev/gemini-api/docs/live-tools)
- **Azure documents no long-tool-call guidance at all.**

⚠️ **No vendor documents a maximum tool-call duration or tool-call timeout.** All three: NOT
DOCUMENTED. This is the single most important undocumented fact for this project (see Q5's risk).

### Gap 6 — Approvals become a voice-safety surface

[VERIFIED] The COS pipeline emits `approval_request` events (`events.go:44`) and the client renders
them as cards with a countdown (`mux-cos.ts:1249` runs a 1 s ticker while approvals are pending).
The store's `answer()` carries an unusually blunt comment about why send-success must be checked
before marking a card answered:

> *"Marking the card answered is a claim that the sidecar has the decision; on a dead socket it does
> not, and it will time the request out to DENIED… Showing a green 'approved' for a request that is
> about to be denied is worse than showing nothing"* (`cos-store.ts:290-298`)

In a voice conversation this becomes: the assistant must *speak* the approval request and *hear* the
answer, on a channel where mishearing "no" as "go" has consequences, against a timeout that denies by
default. This is a genuine design problem, not a UI detail. It should be built last and deliberately.

### Gap 7 — Today's dictation is not even universally available

[DOCUMENTED, caniuse, checked 2026-09-07] The Web Speech API is **not Baseline** — MDN badges it
*"Limited availability."* The spec is a W3C **Community Group Report**, not a Recommendation.

| Browser | Status |
|---|---|
| Chrome / Chrome Android | ◐ Partial |
| Safari / iOS Safari | ◐ Partial |
| **Edge** | ❌ **Not supported**, all versions |
| **Opera** | ❌ **Not supported**, all versions |
| **Firefox** | ❌ **Disabled by default**, all versions |

⚠️ This contradicts a common assumption: **Edge and Opera are Chromium-based but caniuse records
them as unsupported.** Combined with muxterm's own deliberate Android exclusion
(`voice-input-controller.ts:86`), the existing mic button is a Chrome-and-Safari feature.

### Gap 8 — Session lifetime versus a long-lived surface

[DOCUMENTED, 2026-09-07] OpenAI and Azure cap a realtime session at **60 minutes**. Gemini caps
audio-only sessions at **15 minutes**, with a single WebSocket connection lasting **~10 minutes**
(extendable via `contextWindowCompression` and `sessionResumption`).

A chief-of-staff surface is meant to sit open all day. Session renewal and resumption is not
optional polish; it is a first-class requirement.

Also relevant to cost: OpenAI documents that *"the whole conversation is re-sent every turn"*, so
*"turns later in the session will be more expensive."*

### Gap 9 (bonus) — cost shape changes

[DOCUMENTED, 2026-09-07] Realtime audio is materially more expensive than text.

- OpenAI `gpt-realtime-2.1` per 1M tokens: text in $4 / out $24; **audio in $32 / out $64**. Audio
  input costs 8× text input *per token*, and audio consumes far more tokens per unit of meaning
  (user audio = 1 token/100 ms; assistant audio = 1 token/50 ms).
  [DERIVED — my arithmetic, not vendor-published] ≈ $0.019/min of speech in, ≈ $0.077/min out,
  before per-turn context re-billing.
- Gemini publishes per-minute figures directly: **$0.005/min in, $0.018/min out**
  (≈ $0.023/min two-way) for `gemini-3.1-flash-live-preview`.
  (https://ai.google.dev/gemini-api/docs/pricing)

---

## Q5 — Recommendation

**Verdict: ANSWERED.**

### The headline

**The architecture is ready, and better positioned than expected. The blocker is a credential, not
code. And the design should not go through Amplifier's provider layer.**

This is not "not practical yet." It is "practical, cheaper than you'd think, and gated on one
non-engineering thing."

### Step 0 — the blocker, stated plainly

**There is no working credential on this machine for any realtime voice API.**

- `OPENAI_API_KEY` is present and **verified invalid** (HTTP 401, twice, with a passing control).
- No Google credential exists.
- No Azure credential exists.
- The only valid credential is **Anthropic**, which is the chief of staff's brain and **ships no
  realtime speech-to-speech API**.

No amount of engineering routes around this. A working OpenAI or Azure OpenAI credential is a
prerequisite, and obtaining one is explicitly outside this research's scope (no provisioning,
purchasing, or sign-ups). **Step 0 is procurement.**

### The architectural decision — do not extend the provider layer

Two independent reasons:

1. **It's a kernel change, not a plugin.** Q2 established that `ContentBlockType` has four values,
   there is no `AudioBlock`, and `Provider` is request/response over text. Adding bidirectional audio
   means changing Amplifier's core message model.
2. **Amplifier's own documentation says don't.** `APPLICATION_INTEGRATION_GUIDE.md:491-530`,
   "Pattern D: Voice/Realtime Bridge": *"The voice model handles audio I/O, turn-taking,
   interruptions… Amplifier handles tool execution… **They meet at the tool boundary.**"*

And a third, decisive for this specific product: the chief of staff *is* Claude. Routing voice
through the provider layer would mean swapping the brain out for a realtime model. The user does not
want a different assistant that can talk — they want *their* chief of staff to talk.

**So: put the voice model in front of the chief of staff, not underneath it.** The realtime model
becomes ears and a mouth. The existing Amplifier session stays exactly as it is — same transcript,
same tools, same approvals, same Claude.

### The components, in build order

**1. Ephemeral-token endpoint (Go).** `POST /api/cos/voice/token` alongside the existing handlers in
`internal/server/`. Holds the real API key server-side, calls
`POST /v1/realtime/client_secrets`, returns the short-lived secret. This is the vendor-documented
pattern for all three vendors and it is the only piece that must not be skipped for security.
→ **~0.5–1 day.**

**2. Browser realtime session.** New `web/src/lib/voice-session-controller.ts` — a sibling to the
existing `voice-input-controller.ts`, following the same singleton convention. Use the official
`@openai/agents/realtime` SDK (`RealtimeAgent`, `RealtimeSession`, `OpenAIRealtimeWebRTC`); OpenAI's
voice-agents guide states *"the fastest path to a browser-based voice assistant is a `RealtimeAgent`
and `RealtimeSession`."* **Choose WebRTC.** Per Gap 3, WebRTC gets you server-side audio truncation
on barge-in for free — the hardest part of the problem costs zero client code.

At the end of this step you have a talking assistant that knows nothing about muxterm. That is the
right checkpoint: it proves audio in, audio out, VAD, and barge-in all work in this browser, on this
network, through this tunnel, before any integration risk is added.
→ **~2–4 days**, including `getUserMedia`/HTTPS/permissions reality, device selection, and the fact
that muxterm is often reached through a tunnel (WebRTC needs UDP+TCP **port 3478** per Azure's
documented firewall requirement).

**3. The bridge — exactly one tool.** Give the realtime agent a single function tool,
`ask_chief_of_staff(prompt)`. Its implementation calls the **existing** `cosTurn()` on the
**existing** WebSocket (`web/src/ws.ts:384`) and resolves when `turn_end` arrives.

Note what this does *not* touch: not `main.py`, not `supervisor.go`, not `events.go`, not the
Amplifier session. The entire integration is one function that calls a method that already exists.
→ **~1–2 days for a naive blocking version; ~3–5 days for the asynchronous version that survives a
long turn** (see the risk, below).

**4. Narration from the event stream.** Subscribe the voice session to the `cos-event` stream already
arriving in the browser and feed `tool_start` / `tool_end` / `thinking` in as spoken commentary.
This is the muxterm advantage from Gap 5 — the structured "what am I doing" stream already exists,
already streams, and already reaches the client. This is the difference between "it works" and "it
feels alive," but it is not required for a first conversation.
→ **~2–3 days.**

**5. Voice approvals — last, and deliberately.** `approval_request` spoken aloud, answered by voice.
Per Gap 6 this is a security surface with a deny-by-default timeout. Do not fold it into step 3
because it seems adjacent.
→ **~2–3 days plus review.**

### The single biggest technical risk

**The impedance mismatch between a sub-second voice turn and a chief-of-staff turn that can run for
minutes.**

Every realtime vendor's function-calling model assumes a tool returns in a short, bounded time. A
muxterm COS turn is an autonomous agent turn: it can chain tools for minutes and can emit an approval
request mid-flight that needs a human answer before it proceeds.

Three facts make this the sharp edge rather than a detail:

1. [DOCUMENTED] **No vendor documents a maximum tool-call duration or timeout.** All three: NOT
   DOCUMENTED. You cannot design against a published limit because there isn't one — you will find
   the limit empirically, in production.
2. [DOCUMENTED] OpenAI caps a session at 60 minutes and re-sends the whole conversation each turn.
   A long-held tool call inside a long session is the expensive corner of a pricing model that is
   already ~8× text.
3. The naive design — `ask_chief_of_staff` blocks until `turn_end` — is the one everybody writes
   first and it is the one that breaks. The correct design is materially different: **return from
   the tool almost immediately** ("I'm on it"), and narrate progress asynchronously from the
   `cos-event` stream (step 4), delivering the final answer as a *new* assistant utterance rather
   than as a tool return.

That inversion is why step 4 is not optional polish and why step 3's estimate has a wide band. It is
also why I would build step 2 standalone first: you want the audio layer proven before you meet this
problem.

**Secondary risks, named but smaller:** Gemini 3.1 Flash Live blocking on tool calls with no filler
mechanism makes it a poor fit for this specific product despite good pricing — if Gemini is chosen,
choose 2.5 with `NON_BLOCKING`. And WebRTC through muxterm's tunnel/public-origin setup is the kind
of thing that works on localhost and fails on the deployment you actually use; prove it in step 2.

### Honest effort estimate

| | Optimistic | Realistic |
|---|---|---|
| Demo: talk to the chief of staff, Chrome, your machine | ~4 days | **~1 week** |
| Good version: narration, reconnect, mobile Safari, error paths, approvals | ~2 weeks | **~2–3 weeks** |

Both assume Step 0 is already solved. Integration, session-resume, and the long-turn inversion
reliably cost more than the sum of the parts — I have added roughly 30–50% for that and would not
trust an estimate that hadn't.

### What not to do

**Do not build this on the Web Speech API.** It is the tempting shortest path — it's already there,
it's free, it works today. It is a dead end for conversation, on five independent grounds: no VAD
configuration exists in the API at all (Gap 2); the session terminates per utterance (Gap 2); there
is no barge-in because there is no audio out (Gap 3); it is not Baseline and does not work in Edge,
Opera, or Firefox (Gap 7); and in Chrome the audio is sent to Google's servers anyway (Q1), so the
privacy argument for keeping it doesn't hold either.

Keep it exactly as it is — a good dictation fallback for browsers and moments where a full realtime
session is overkill. It is well-built for what it is. It is just not the thing being asked for.

---

## Appendix — verification method

**Verified by reading code or running a check:**
- All muxterm code claims: read at `origin/main` @ `794677b` in a clean worktree.
- Exhaustive negative greps for audio/TTS across `web/src`, `web/index.html`, and all `*.go`.
- Amplifier provider protocol, message models, content models, capability constants: read in
  `~/.amplifier/cache/amplifier-core-61734c2990ff26ac/`.
- Credential status: read-only `GET /v1/models` against each vendor, with a cross-vendor control
  experiment to prove the probe technique was sound. No writes, no billable calls, no provisioning.
- `amplifier provider list` output.
- Ecosystem survey across ~50 cached bundles, 91 skills, the registry, and settings.

**Reported from vendor documentation, all checked 2026-09-07:**
- https://platform.openai.com/docs/guides/realtime.md and sub-guides (webrtc, websocket,
  conversations, vad, mcp, costs, models-prompting)
- https://developers.openai.com/api/reference/resources/realtime/subresources/client_secrets/methods/create.md
- https://openai.github.io/openai-agents-js/guides/voice-agents/
- https://ai.google.dev/gemini-api/docs/live, /live-guide, /live-tools, /live-session,
  /ephemeral-tokens, /pricing, /models
- https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/realtime-audio and
  /realtime-audio-webrtc
- https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition and /SpeechSynthesis
- https://webaudio.github.io/web-speech-api/
- https://caniuse.com/speech-recognition

**Not done, and deliberately so:** no latency or audio-quality benchmarking against live vendor
endpoints; no service enabled, purchased, or provisioned; no exhaustive survey of voice vendors
beyond the three named; no muxterm runtime behaviour changed; nothing started, so nothing needed
tearing down.

**Known documentation inconsistencies, flagged rather than resolved:** Azure's `realtime-audio`
how-to (updated 2026-07-29) omits `gpt-realtime-2.1` while the Foundry models page (2026-09-04) lists
it as preview; `silence_duration_ms` defaults differ across all three vendors (500 / 200 / ~800 ms);
`gpt-realtime-2.1` context window is documented as 128k on OpenAI direct but "32,000 input / 4,096
output" for Azure Realtime models.
