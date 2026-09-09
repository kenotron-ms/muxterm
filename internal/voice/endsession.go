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
// The confirmation the user gets before this happens is REAL, and it is
// specified in exactly one place: the ENDING THE CONVERSATION section of
// Instructions(). It is not restated here, and this file must not add a
// second one.
//
// It used to. This tool was built the way answer_approval is built -- a
// server-side two-call gate, where the first call ends nothing and hands
// back a line for the model to read aloud. That is the right shape for
// approvals, where the gate protects a command that runs on the user's
// machine and the model's own prompt cannot be trusted to hold the line. It
// was the wrong shape here, for a reason specific to conversation: the model
// had ALREADY asked, because the instructions told it to, so the gate's
// read-back was a SECOND question, and the "ask them once more" branch below
// it was a third. The user asked to leave and got interrogated. A gate that
// costs one command is cheap; a gate that costs the user their exit is the
// failure it was supposed to prevent.
//
// So the gate is gone and one call hangs up. Two rules survive, and they are
// enforced HERE rather than in the prompt, because a prompt is guidance and
// these are mechanism:
//
//  1. THE GOODBYE IS HEARD BEFORE THE LINE DROPS. A session that ends must
//     be audibly different from one that fell over. Teardown waits for the
//     farewell audio to finish reaching the user -- observed, not assumed.
//  2. AN INTERRUPTED GOODBYE IS NOT A GOODBYE. If the user talks over the
//     farewell, the ending is abandoned and the conversation stays open.
//
// Rule 2 is what makes a single call safe, and it is worth being explicit
// about why, because it is the safety property the deleted gate was carrying.
// The asymmetry still runs the opposite way from approvals.go: there,
// ambiguity denies; here, ambiguity KEEPS THE SESSION OPEN. "stop", "end",
// "exit" and "quit" are ordinary words in a conversation about terminals, so
// a wrongly-started ending has to be survivable. It is -- the user hears a
// goodbye they did not ask for and simply talks, and abortEnd puts the
// conversation back. That costs them one sentence, the same as the old
// read-back did, but it is only spent when something has actually gone
// wrong, instead of on every single exit.

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

// runEnd hangs up. One call, no second question -- and no teardown until the
// goodbye has been heard.
//
// The tool result deliberately carries no decision for the model to make.
// Every earlier version of this function answered with something the model
// had to weigh -- get their confirmation first, ask them once more, wait for
// a clear yes -- and each of those sentences was another turn spent with the
// user waiting to be let go. What comes back now is a single imperative with
// one line in it, so the only thing the model can do next is say it.
func (s *Sideband) runEnd(callID string, args map[string]any) {
	farewell := strings.TrimSpace(str(args["farewell"]))

	s.mu.Lock()
	alreadyEnding := s.ending
	s.mu.Unlock()

	// A second call while the goodbye is already going out. Answering it
	// rather than dropping it keeps the model from trying again harder.
	if alreadyEnding {
		s.answer(callID, "The conversation is already ending; the goodbye is going out now.",
			"Say nothing further. The connection drops on its own once the user has heard the goodbye.")
		return
	}

	s.mu.Lock()
	s.ending = true
	ch := make(chan string, 8)
	s.farewellCh = ch
	s.mu.Unlock()

	line := farewell
	if line == "" {
		// The model may omit the farewell; the goodbye is not optional.
		line = "Goodbye."
	}
	s.emit(Trace{Kind: TraceEnding, Name: ToolEnd, Detail: "ending; farewell requested"})
	s.answer(callID,
		"Ending now. Say the goodbye. The connection stays open until the user has heard it, then drops on its own.",
		"Say this out loud to the user now, and nothing else -- no question, no offer, nothing after it: "+line)

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
// Nothing about the ending is kept. A user who talks over their own goodbye
// gets a session with no memory of having been on the way out, which is the
// point: a half-finished ending left lying around is exactly the residue that
// makes a model bring hanging up back up on its own two turns later.
func (s *Sideband) abortEnd() {
	s.mu.Lock()
	s.ending = false
	s.farewellCh = nil
	s.mu.Unlock()

	s.emit(Trace{Kind: TraceEnding, Name: ToolEnd, Detail: "aborted: the user spoke over the goodbye"})
	s.inject("The user interrupted the goodbye, so the conversation is STILL OPEN and nothing was ended.",
		"Stop saying goodbye. Listen to what the user just said and carry on with it. Do not ask whether "+
			"they still want to leave -- if they do, they will say so, and that is a fresh request.")
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

// isEnding is test-facing: it reports whether a goodbye is in flight.
func (s *Sideband) isEnding() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ending
}
