package voice

import (
	"strings"

	"time"
)

// Voice approvals.
//
// The chief of staff asks permission before some actions. In text that is a
// card with two buttons. Spoken, it is a channel where "no" and "go" differ
// by one phoneme, over a microphone, in a room with other noise, transcribed
// by a model that will happily produce a confident wrong word.
//
// Three rules make that survivable, and all three are enforced HERE rather
// than in the prompt, because a prompt is guidance and this is a gate:
//
//  1. TWO STEPS, ALWAYS. The first call to answer_approval never transmits
//     anything. It records an intent and sends back a line for the model to
//     read aloud. Only a second call, naming the same request and the same
//     decision, transmits. A model that tries to do it in one call is
//     refused -- including when it sets confirm true on the first call.
//  2. DENY BY DEFAULT. An unrecognized decision is a denial. An intent that
//     goes stale is discarded, and the underlying request then times out to
//     DENIED on its own, which is the sidecar's existing behaviour.
//  3. THE DECISION MAY NOT CHANGE BETWEEN THE STEPS. Confirming "approve"
//     after intending "deny" is not a confirmation, it is a different
//     answer, and it starts again.
//
// Denying by mistake costs one retry. Approving by mistake runs a command on
// the user's machine. The asymmetry is the whole design.

// approvalIntent is a decision that has been read back but not yet
// transmitted.
type approvalIntent struct {
	decision string
	at       time.Time
}

// approvalIntentTTL is how long a read-back decision stays confirmable.
//
// Long enough for a person to say "yes", short enough that an intent cannot
// sit around and be confirmed by an unrelated later utterance. Expiry
// transmits NOTHING: the request simply stays pending, and the sidecar times
// it out to denied.
const approvalIntentTTL = 90 * time.Second

func (s *Sideband) runApproval(callID string, args map[string]any) {
	requestID := strings.TrimSpace(str(args["request_id"]))
	decision := normalizeDecision(str(args["decision"]))
	confirm, _ := args["confirm"].(bool)

	if requestID == "" {
		s.answer(callID, "No approval request was named, so nothing was answered.",
			"Ask the user which request they mean.")
		return
	}

	s.mu.Lock()
	intent, had := s.pending[requestID]
	if had && time.Since(intent.at) > approvalIntentTTL {
		delete(s.pending, requestID)
		had = false
	}
	s.mu.Unlock()

	// Step one: record and read back. This branch covers the model that
	// jumps straight to confirm:true, which is refused rather than
	// honoured -- the confirmation has to be something the USER said, and
	// on a first call there is nothing they could have been confirming.
	if !had {
		s.mu.Lock()
		s.pending[requestID] = &approvalIntent{decision: decision, at: time.Now()}
		s.mu.Unlock()

		word := "deny"
		if decision == "approve" {
			word = "approve"
		}
		s.answer(callID,
			"Not sent yet. Read the decision back to the user and get their confirmation first.",
			"Say: you said "+word+" -- confirm? Then wait. Only if they clearly agree, call "+
				ToolApproval+" again with the same request id, the same decision, and confirm true. "+
				"If they disagree, change their mind, or are unclear, call it again with decision deny.")
		return
	}

	// A second call that is not a confirmation. Treated as a fresh
	// intent, not as a confirmation of the old one.
	if !confirm {
		s.mu.Lock()
		s.pending[requestID] = &approvalIntent{decision: decision, at: time.Now()}
		s.mu.Unlock()
		s.answer(callID, "Still not sent. Confirm the decision with the user first.",
			"Read the decision back to the user once more and wait for a clear yes.")
		return
	}

	// A confirmation that changes the decision is not a confirmation.
	if intent.decision != decision {
		s.mu.Lock()
		s.pending[requestID] = &approvalIntent{decision: decision, at: time.Now()}
		s.mu.Unlock()
		s.answer(callID,
			"That is a different decision from the one read back, so nothing was sent.",
			"Read the NEW decision back to the user and get a clear confirmation before trying again.")
		return
	}

	s.mu.Lock()
	delete(s.pending, requestID)
	s.mu.Unlock()

	approved := decision == "approve"
	reason := "denied by voice"
	if approved {
		reason = "approved by voice"
	}
	if err := s.bridge.Approve(requestID, approved, reason); err != nil {
		// The send failed, so the sidecar does NOT have the decision.
		// Saying "approved" here would be a claim about a request that
		// is on its way to a timeout denial. Say what actually
		// happened.
		s.answer(callID, "That could not be sent: "+trimErr(err)+
			". Nothing was approved; the request will time out and be denied.",
			"Tell the user the decision did not get through and the request will be denied.")
		return
	}

	if approved {
		s.answer(callID, "Approved.", "Confirm to the user that you approved it.")
		return
	}
	s.answer(callID, "Denied.", "Confirm to the user that you denied it.")
}

// normalizeDecision maps what a speech model might produce onto the closed
// pair, and maps everything else onto "deny".
//
// The default arm is the point of this function. An unrecognized word is not
// an error to report and retry around -- it is a denial, because the only
// safe reading of "I did not understand that" on this channel is no.
func normalizeDecision(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "approve", "approved", "yes", "allow", "ok", "okay", "go", "go ahead", "confirm", "y":
		return "approve"
	default:
		return "deny"
	}
}

// pendingApprovalCount is test-facing: it reports how many intents are
// waiting on a confirmation.
func (s *Sideband) pendingApprovalCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.pending)
}
