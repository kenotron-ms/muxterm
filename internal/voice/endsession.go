package voice

import (
	"strings"
	"time"
)

// Ending the conversation by speaking.
//
// Every other way out of a live voice session is a mouse or a keyboard --
// which is no way out at all for someone who is talking, hands busy, or
// across the room. So the model gets a tool that hangs up. That tool is the
// only one in the surface that acts on the CONVERSATION rather than on the
// chief of staff, and it is the only one whose mistake cannot be retried:
// approving the wrong thing runs a command, but ending the wrong thing takes
// away the microphone that would have said "no, wait".
//
// Three rules make that survivable, and all three are enforced HERE rather
// than in the prompt, because a prompt is guidance and this is a gate:
//
//  1. TWO STEPS, ALWAYS. The first call ends nothing. It records an intent
//     and sends back a line for the model to read aloud. Only a second call,
//     with confirm true, ends anything. A model that tries to do it in one
//     call is refused -- including when it sets confirm true on the first
//     call, which is the shape a model reaches for when it is being
//     agreeable rather than careful.
//  2. THE GOODBYE IS HEARD BEFORE THE LINE DROPS. A session that ends must
//     be audibly different from one that fell over. Teardown waits for the
//     farewell audio to finish reaching the user -- observed, not assumed.
//  3. AN INTERRUPTED GOODBYE IS NOT A GOODBYE. If the user talks over the
//     farewell, the ending is abandoned and the conversation stays open.
//
// The asymmetry is the whole design, and it runs the opposite way from
// approvals.go. There, ambiguity denies. Here, ambiguity KEEPS THE SESSION
// OPEN: "stop", "end", "exit" and "quit" are ordinary words in a
// conversation about terminals, processes and commands, and a false positive
// that silently cuts a live session is worse than one extra beat of
// confirmation. Staying connected by mistake costs a sentence. Hanging up by
// mistake costs the user the only channel they had.

// endIntent is a request to hang up that has been read back to the user but
// not yet acted on.
type endIntent struct{ at time.Time }

// endIntentTTL is how long a read-back ending stays confirmable.
//
// Shorter than approvals.go's ninety seconds, deliberately. Both windows
// exist so an intent cannot be confirmed by an unrelated later utterance,
// but the damage differs: a stale approval that gets confirmed runs one
// command the user can see and undo, while a stale ending that gets
// confirmed takes the microphone away mid-sentence. A person who means to
// hang up says so within a few seconds, so nothing is lost by closing the
// window early, and one accidental ending is avoided by it.
const endIntentTTL = 60 * time.Second

// What the read loop tells a farewell that is waiting to be heard.
const (
	sigAudioStarted = "audio_started"
	sigAudioStopped = "audio_stopped"
	sigAudioCleared = "audio_cleared"
	sigResponseDone = "response_done"
)

// farewellDeadline bounds the wait for a goodbye to be heard.
//
// If it expires the session ends anyway. That is not an accidental ending:
// the user asked twice and confirmed out loud, so honouring it late is
// right, and leaving a session live because a vendor event went missing
// would recreate the exact failure this tool exists to fix -- a microphone
// that stays open after the user asked for it to close.
const farewellDeadline = 25 * time.Second

// farewellDrainGrace is the fallback when a transport publishes no output
// audio buffer events at all.
//
// response.done says the model finished GENERATING, not that the user
// finished HEARING; on WebRTC there is still audio draining to the browser
// when it arrives. So it is treated as a hint, not a signal: it arms a timer
// that any real audio event cancels. Long enough that a goodbye which is
// about to start speaking wins the race against a response.done belonging to
// the read-back the user just confirmed.
const farewellDrainGrace = 5 * time.Second

// runEnd is the gate. It never ends a session on a first call, and it never
// ends one before the goodbye has been heard.
func (s *Sideband) runEnd(callID string, args map[string]any) {
	// Mirrors approvals.go: a confirm that is not a JSON boolean is not a
	// confirmation. The zero value is false, which routes to the
	// read-back step -- the safe arm.
	confirm, _ := args["confirm"].(bool)
	farewell := strings.TrimSpace(str(args["farewell"]))

	s.mu.Lock()
	alreadyEnding := s.ending
	intent := s.endIntent
	if intent != nil && time.Since(intent.at) > endIntentTTL {
		s.endIntent = nil
		intent = nil
	}
	s.mu.Unlock()

	// A second confirmed call while the goodbye is going out. Answering it
	// rather than dropping it keeps the model from trying again harder.
	if alreadyEnding {
		s.answer(callID, "The conversation is already ending; the goodbye is going out now.",
			"Say nothing further. The connection drops on its own once the user has heard the goodbye.")
		return
	}

	// STEP ONE: record and read back. This branch also covers the model
	// that jumps straight to confirm true, which is refused rather than
	// honoured -- the confirmation has to be something the USER said, and
	// on a first call there is nothing they could have been confirming.
	if intent == nil {
		s.mu.Lock()
		s.endIntent = &endIntent{at: time.Now()}
		s.mu.Unlock()
		s.emit(Trace{Kind: TraceEnding, Name: ToolEnd, Detail: "intent recorded; session still live"})
		s.answer(callID,
			"Nothing was ended. The conversation is still live. Read this back to the user and get their confirmation first.",
			"Say: you want to end the conversation -- confirm? Then wait. Only if they clearly agree, call "+
				ToolEnd+" again with confirm true. If they say no, change their mind, are unclear, or "+
				"turn out to have meant stopping a task rather than the conversation, do not call it again.")
		return
	}

	// A second call that is not a confirmation. Treated as a fresh intent,
	// not as a confirmation of the old one.
	if !confirm {
		s.mu.Lock()
		s.endIntent = &endIntent{at: time.Now()}
		s.mu.Unlock()
		s.answer(callID, "Still nothing ended. Confirm with the user first.",
			"Ask them once more, plainly, whether they want to end the conversation, and wait for a clear yes.")
		return
	}

	// CONFIRMED. From here the session is ending -- but not yet.
	s.mu.Lock()
	s.endIntent = nil
	s.ending = true
	ch := make(chan string, 8)
	s.farewellCh = ch
	s.mu.Unlock()

	line := farewell
	if line == "" {
		// The model may omit the farewell; the goodbye is not optional.
		line = "Goodbye."
	}
	s.emit(Trace{Kind: TraceEnding, Name: ToolEnd, Detail: "confirmed; farewell requested"})
	s.answer(callID,
		"Confirmed. Say the goodbye now. The connection stays open until the user has heard it, then drops on its own.",
		"Say this out loud to the user now, and nothing else: "+line)

	go s.awaitFarewell(ch)
}

// awaitFarewell holds the connection open until the goodbye has actually
// reached the user, and only then tears it down.
//
// The ordering problem this solves is the whole of C3. Tearing down when the
// confirmed call returns would cut the goodbye off before a single word of
// it left the server: the tool result comes back in milliseconds and the
// speech has not been generated yet, let alone played. Nor is it enough to
// wait for response.done, which means the model finished GENERATING -- on
// WebRTC there is still audio in flight to the browser at that moment.
//
// So the wait is on the output audio buffer, which is the one signal that
// describes DELIVERY: started when the user begins hearing it, stopped when
// the buffer has drained, cleared when they talked over it. Nothing here
// assumes the audio landed because a call returned.
func (s *Sideband) awaitFarewell(ch chan string) {
	var (
		audioStarted bool
		drain        <-chan time.Time
	)
	limit := time.After(farewellDeadline)

	for {
		select {
		case sig := <-ch:
			switch sig {
			case sigAudioStarted:
				// The goodbye is being heard. Any fallback timer armed
				// by an earlier response.done is now wrong.
				audioStarted = true
				drain = nil
			case sigAudioStopped:
				if !audioStarted {
					// Audio that was already in flight when the user
					// confirmed, finishing now. Not the goodbye.
					continue
				}
				s.finishEnd("goodbye heard in full")
				return
			case sigAudioCleared:
				if !audioStarted {
					continue
				}
				// Barge-in. The user is talking over their own
				// goodbye, and the only honest reading of that is
				// that they have something else to say.
				s.abortEnd()
				return
			case sigResponseDone:
				if !audioStarted {
					drain = time.After(farewellDrainGrace)
				}
			}
		case <-drain:
			s.finishEnd("goodbye spoken; no audio buffer events on this transport")
			return
		case <-limit:
			s.finishEnd("goodbye not confirmed heard within the deadline; ending as asked")
			return
		case <-s.done:
			// The sideband went away underneath us -- a browser hangup,
			// or a server shutdown. Either way the teardown already
			// happened.
			return
		}
	}
}

// finishEnd tears the session down through the SAME path the browser's
// POST /api/cos/voice/end reaches.
//
// One teardown implementation, not two. A second one would drift, and the
// half that drifted would be the one that leaves a microphone live.
func (s *Sideband) finishEnd(why string) {
	s.mu.Lock()
	if !s.ending {
		s.mu.Unlock()
		return
	}
	s.farewellCh = nil
	end := s.endSession
	s.mu.Unlock()

	s.emit(Trace{Kind: TraceEnded, Name: ToolEnd, Detail: why})

	if end == nil {
		// Nothing above wired a teardown. Close what this object owns
		// rather than leave a session that has said goodbye still able
		// to run tools.
		s.Close()
		return
	}
	end("ended by spoken request")
}

// abortEnd puts the conversation back the way it was.
//
// The intent is cleared, not kept: a user who interrupts their own goodbye
// has to ask again from the top, which is one extra sentence and removes any
// chance of a half-confirmed ending completing later on its own.
func (s *Sideband) abortEnd() {
	s.mu.Lock()
	s.ending = false
	s.farewellCh = nil
	s.endIntent = nil
	s.mu.Unlock()

	s.emit(Trace{Kind: TraceEnding, Name: ToolEnd, Detail: "aborted: the user spoke over the goodbye"})
	s.inject("The user interrupted the goodbye, so the conversation is STILL OPEN and nothing was ended.",
		"Stop saying goodbye. Listen to what the user just said and carry on with it. If they do still "+
			"want to end the conversation, start again with "+ToolEnd+" and confirm false.")
}

// signalFarewell hands the read loop's view of the audio to a farewell that
// is waiting. A no-op when nothing is ending, which is almost always.
func (s *Sideband) signalFarewell(sig string) {
	s.mu.Lock()
	ch := s.farewellCh
	s.mu.Unlock()
	if ch == nil {
		return
	}
	select {
	case ch <- sig:
	default:
		// Buffered and bounded: a flood of audio events must not block
		// the read loop, and a farewell needs only the first of each.
	}
}

// isEnding is test-facing: it reports whether a confirmed goodbye is in
// flight.
func (s *Sideband) isEnding() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ending
}

// hasEndIntent is test-facing: it reports whether an ending has been read
// back and is waiting on a confirmation.
func (s *Sideband) hasEndIntent() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.endIntent != nil
}
