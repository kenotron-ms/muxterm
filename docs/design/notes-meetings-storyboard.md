# Notes and Meetings in the utility pane

The sequence started in `Concepts/Notes and Meetings`. The reviewable product scenes are now in `Screens/Utility`: they mount the same `mux-sdk-utility` and `mux-meetings` elements used by the app. Storybook media and people are marked **SAMPLE**. A browser run on isolated `make dev-local` is required to prove capture and calling.

## Shared structure

Notes and Meetings occupy ordinary utility tabs beside Files. Each opens a searchable item rail and a viewing surface without creating an item. The utility tab strip, rail rows, fields, buttons, feedback, empty states, and confirmation dialog come from existing components. Notes keep the BlockNote editor already used by Pages. Meetings add camera tiles, a screen stage, media playback, and transcript rows because the Files and Notes viewers have no equivalent.

The Files pane places its viewer beside a list; Notes and Meetings keep that split model and use a vertical layout at phone width. Selected items remain inside the owning tab. `mux-meetings` remains mounted while another utility tab is selected, so a call or recording keeps running. The Storybook production scenes cover empty library, note editor, recorder, call preflight, waiting, two-person call, screen sharing, call recording, combined sharing/recording, review, and phone widths.

## Story 1: Find, edit, and open a Note

1. Open Notes. The library loads without adding a note. Search title or body, then select an ID to edit in the same tab.
2. Choose New note only when ready to create one. The editor autosaves with saving, saved, and failed states. A stale document version produces a conflict banner; the local draft remains in browser storage and can be saved as a separate recovered note.
3. Existing Pages records remain in the same JSON document at `$XDG_DATA_HOME/muxterm/sdk-chat/pages/<chat-id>.json`. Their IDs, BlockNote JSON, and legacy blocks are preserved. Existing `#muxterm-page-<id>` links still select the same content in Notes. No destructive migration runs. A backup of that JSON file is a rollback copy; restoring it while the chat is closed restores its original Pages content.
4. MCP list/search, read, create, replace at an expected version, append, and open-exact-ID tools operate on the owning chat. Content writes do not navigate the browser. `open_chat_note` explicitly opens Notes and selects the ID.

Deleting a note asks for confirmation and includes its child Pages. A failed save keeps the local text visible; conflict recovery offers a separate copy.

## Story 2: Record now

1. Open Meetings. The library is empty until Record or Start call is chosen. Search and select past meetings in the item rail.
2. Record requests microphone permission and shows the selected input. The second, explicit Start recording gesture creates the meeting and starts browser `MediaRecorder` capture. The live state shows elapsed time and Stop and save.
3. Each media chunk goes to `$XDG_DATA_HOME/muxterm/sdk-chat/meetings/<chat-id>/<meeting-id>/chunk-*`. A browser IndexedDB copy remains until the server acknowledges each chunk. Finalization joins the chunks into `original.media`. If capture or upload is interrupted, the meeting exposes recovery from server and browser chunks instead of claiming a complete recording.
4. The meeting review plays and exports the preserved original. Server metadata stores stable ID, chat ID, title, participants, start/end times, media size/type, and recording/transcript state.

Switching utility tabs keeps the recorder mounted. A page reload stops browser capture but saved chunks remain recoverable; the UI labels an old unfinished capture as interrupted.

## Story 3: Invite one guest

1. Start call first checks whether this Muxterm instance has an operator-configured, public HTTPS `public_origin` in `behind_reverse_proxy` mode. Local mode shows the hosting requirement before requesting camera or microphone. Create call and invite is the explicit action that creates a meeting and a random 192-bit guest capability. The server returns the invite URL using its configured origin; the browser address and request Host header never supply that origin. The invite expires after one hour for new guests and can be revoked by ending the call.
2. A guest opens `/guest/<token>` without a muxterm account and must explicitly join. The first guest receives a separate lease. A second guest using the same link is rejected. The guest page has access only to that meeting's title and signaling, never to chat, notes, recordings, or transcript endpoints.
3. The two browsers exchange SDP and ICE candidates through muxterm's signaling routes; media flows over WebRTC. Both have mute, camera, share, and leave controls. Browser `getDisplayMedia` lets a participant choose a tab, window, or display; the shared track becomes the main stage while video tiles remain visible. Stopping share leaves the call connected.
4. Call recording is an additional gesture. The host mixes both audio tracks and captures the active video/screen stage into a local video recording. The guest receives a recording indicator. Stopping recording keeps the call open; End call preserves the meeting and revokes the invite.
5. Both call surfaces show ICE state and the selected candidate pair as Direct or TURN relay, without exposing candidate IP addresses. If no pair is selected after 12 seconds, they show a stalled state without calling it a browser failure. A failed call shows whether TURN was configured and any ICE server error code the browser reported. These observations narrow troubleshooting; browsers do not reveal a definitive NAT or firewall cause. Storybook includes direct, relayed, stalled, and failed sample states.

No meeting SaaS or third-party transcription service is used. The default ICE server list is empty, so direct local-network candidates may connect. Set `MUXTERM_MEETING_ICE_SERVERS` to a JSON array of browser `RTCIceServer` objects pointing to an operator-controlled STUN/TURN deployment for NAT cases, for example `[{"urls":"turns:turn.example.net:5349","username":"...","credential":"..."}]`. TURN relays encrypted WebRTC packets when direct connectivity fails; deployment and credentials are operator responsibilities. Do not point this variable at an untrusted relay if media ownership matters.

Guest calls require the operator to host Muxterm where the guest can reach it over HTTPS, with `[server] behind_reverse_proxy = true` and `public_origin = "https://muxterm.example.net"`. Local recordings and transcripts remain available without public hosting. This config is an operator declaration, not a network reachability probe: test the invite from a second network before relying on it. TURN can run on the same host as Muxterm if its own listening and relay ports are reachable; it is a separate service and is recommended for networks that block direct browser traffic.

## Story 4: Transcript and linked Note

1. The review surface shows available transcription choices once original media is ready. **Transcribe on this server** keeps audio local: the server converts the media to 16 kHz mono WAV with `ffmpeg` and invokes the executable named by `MUXTERM_MEETING_TRANSCRIBER`, passing the WAV input path and JSON output path as its only arguments. A separately labeled provider action is available when Settings > Voice has a file transcription model and credential; it requires a confirmation that saved audio will be sent to that provider.
2. The executable must write `{"segments":[{"startMs":0,"endMs":1200,"text":"..."}]}`. Its implementation and speech model stay under operator control. A local Vosk or whisper.cpp wrapper is suitable. The server bounds and validates results, then stores original segment text in `transcript.json`. The call recording currently mixes audio, so every segment is labeled **Unknown speaker**; it does not guess speaker names.
3. Queued, processing, ready, and failed are distinct states. Failure leaves `original.media` playable and provides Retry from original. Corrections are stored separately from original segment text with a revision token. Timestamp clicks seek playback, VTT export includes corrections, and Create linked note copies timestamped segments into a Note carrying the meeting ID.
4. Delete meeting asks for confirmation and removes its server media, chunks, transcript, and metadata. There is no automatic retention purge. Back up the `meetings` directory if operator retention is required. The guest cannot fetch any of these files. A host browser may temporarily hold unsent chunks in its local IndexedDB until retry or deletion.

The local speech model is configured outside muxterm. If `MUXTERM_MEETING_TRANSCRIBER` is absent, the local action is unavailable with a configuration message. The Voice setting's live voice model is not a file transcription model. On OpenAI, the file model defaults to `gpt-transcribe`; Azure requires a separately named transcription deployment. Provider transcription sends one-minute WAV chunks using the saved Voice credential, then stores the resulting text in Muxterm. It does not run without the user's explicit provider choice and confirmation. A transcript records whether it was made locally or by the provider.

The included `tools/meeting-vosk-transcriber.py` is an optional offline adapter. Install `vosk` in the Python environment that runs that executable, download a model onto the operator's machine, and set `MUXTERM_VOSK_MODEL` to the model directory and `MUXTERM_MEETING_TRANSCRIBER` to the adapter's absolute path. Install `ffmpeg` on the same machine. Keep the model and Python environment outside the repository. The adapter emits timestamped segments; accuracy and language coverage follow the chosen local model. Authenticated muxterm users and filesystem operators can access the stored media and transcript; the guest invite exposes only the call title and signaling.

## Storybook and real-browser checks

Use Storybook at `http://127.0.0.1:6006/?path=/story/screens-utility--meeting-video-call` for the production component's sample states. Switch the story suffix to `meeting-library`, `meeting-review`, `meeting-recorder`, `meeting-call-preflight`, `meeting-hosting-required`, `meeting-waiting`, `meeting-direct-route`, `meeting-relay-route`, `meeting-connection-stalled`, `meeting-connection-failed`, `meeting-screen-share`, `meeting-recording`, or `meeting-recording-screen-share`. Phone scenes start with `phone-meeting-`. Notes are under `screens-utility--notes-library` and `screens-utility--note-editor`.

Use isolated `make dev-local` on port 8313 for working interactions. Storybook scenes never count as proof of microphone capture, signaling, screen sharing, persistence, or local transcription.
