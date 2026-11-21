# Realtime voice providers

Voice settings select one active transport. The OpenAI GPT-Live path uses the
existing WebRTC session and server observer; its endpoint, model, authentication,
Azure scope, and credential stay saved when Gemini Live is selected. The Gemini
path uses a separate browser WebSocket session with 16 kHz PCM microphone input,
24 kHz PCM playback, interruption-aware playback, and server-minted single-use
tokens. Its model and credential source are separate from the OpenAI fields.

The provider boundary is the voice session used by SDK chats and the settings
status returned by the server. A new provider needs its own session transport,
credential and endpoint validation, transcript event mapping, and tool response
adapter. Do not route another provider through the OpenAI SDP flow simply because
it also supports realtime audio.

Azure OpenAI Realtime may use the existing OpenAI-compatible transport when its
resource supports that protocol, but an independent Azure adapter and auth flow
would require live validation. Local NVIDIA NemotronLabs VoiceChat 11B is not
offered in settings. Before offering it, test it on the actual AI rig for latency,
barge-in, tool calls, and resource use, including the documented limitation that
tool execution cannot be interrupted.
