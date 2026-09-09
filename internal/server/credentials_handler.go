// internal/server/credentials_handler.go
package server

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/kenotron-ms/muxterm/internal/ai"
)

// The /api/credentials family onboards this machine's model-provider
// credentials -- the ones a LANE needs, not the ones muxterm's own AI
// features use (those are /api/ai/*, backed by the same store).
//
// WRITE-ONLY, WITHOUT EXCEPTION. A key goes in through PUT and never comes
// back out: no route here returns it, masks it, hints at it, reports its
// length, or quotes a vendor error body that might contain a fragment of it.
// What a GET returns is whether a credential is set, where it came from, and
// whether the vendor accepted it. There is no reveal, by design and not by
// omission.
//
// AuthMiddleware protects every route at mux registration, exactly like the
// /api/ai and config routes.

func writeCredJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v) //nolint:errcheck
}

func writeCredError(w http.ResponseWriter, code int, reason string) {
	writeCredJSON(w, code, map[string]any{"error": reason})
}

// credProvider pulls the {provider} path segment and refuses anything not in
// the catalog before a handler touches disk or the network.
func credProvider(w http.ResponseWriter, r *http.Request) (ai.Provider, bool) {
	p, ok := ai.KnownProvider(r.PathValue("provider"))
	if !ok {
		writeCredError(w, http.StatusNotFound, "unknown_provider")
		return "", false
	}
	return p, true
}

// handleCredentials answers "what does this machine already have?".
//
// No network I/O: presence is read from disk and the environment, and
// validity is whatever the last check recorded. A provider nothing has
// checked reports verdict "unknown", which the browser renders as not
// checked -- never as healthy.
func (s *Server) handleCredentials(w http.ResponseWriter, _ *http.Request) {
	writeCredJSON(w, http.StatusOK, s.ai.Report())
}

// handleCredentialsPut verifies a candidate key and stores it only if the
// vendor did not reject it.
//
// THE RULE, STATED SO IT CAN BE ARGUED WITH: a credential the provider
// actively rejected is never written. A credential that could not be checked
// -- no network, DNS down, a proxy that is not up yet -- IS written, and the
// response says so plainly, because refusing to save on an unreachable
// network would strand a user who is offline right now and correct about
// their key. Those two outcomes are different fixes, so they are different
// answers.
func (s *Server) handleCredentialsPut(w http.ResponseWriter, r *http.Request) {
	provider, ok := credProvider(w, r)
	if !ok {
		return
	}
	var body struct {
		APIKey string `json:"apiKey"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeCredError(w, http.StatusBadRequest, "invalid_json")
		return
	}
	if len(body.APIKey) < ai.MinKeyLen {
		writeCredError(w, http.StatusBadRequest, "invalid_key")
		return
	}

	verdict := s.ai.VerifyCandidate(r.Context(), provider, body.APIKey)
	if verdict.State == ai.VerdictRejected {
		// Nothing is stored. A saved-but-wrong key is exactly the failure
		// this feature exists to prevent, and storing it here would recreate
		// it one layer higher up.
		writeCredJSON(w, http.StatusBadRequest, map[string]any{
			"error":   "rejected",
			"verdict": verdict,
			"report":  s.ai.Report(),
		})
		return
	}

	if err := s.ai.SaveProviderKey(provider, body.APIKey); err != nil {
		// The error carries a path, never the key (internal/ai/keystore.go).
		log.Printf("credentials: save %s: %v", provider, err)
		writeCredError(w, http.StatusInternalServerError, "save_failed")
		return
	}

	// SaveProviderKey forgets the old verdict; re-record the one this
	// candidate earned so the UI does not flash "not checked" over a key it
	// just watched succeed.
	if verdict.State == ai.VerdictOK || verdict.State == ai.VerdictFailed {
		s.ai.RecordVerdict(provider, verdict)
	}

	// The Anthropic key is also muxterm's own AI capability key -- one store,
	// two consumers -- so a save here changes that flag and every tab is told.
	if provider == ai.ProviderAnthropic {
		s.hub.BroadcastAIStatus(s.ai.Status())
	}

	writeCredJSON(w, http.StatusOK, map[string]any{
		"verdict":      verdict,
		"report":       s.ai.Report(),
		"chiefOfStaff": s.chiefOfStaffAfterSave(),
		"lanesFromNow": "Lanes started from now on will use this credential.",
	})
}

// chiefOfStaffAfterSave brings the chief of staff into line with a credential
// that was just saved, and returns what it managed to do.
//
// A running sidecar is holding the environment it was SPAWNED with, so a key
// written to disk a moment ago is invisible to it; without this, a user who
// onboards in the browser gets working lanes and a chief-of-staff pane that
// goes on failing every turn with no explanation on screen. Which is precisely
// the shape of failure this feature exists to end, one layer up.
//
// It never starts a sidecar that was not already running -- see
// cosRelay.credentialsChanged.
func (s *Server) chiefOfStaffAfterSave() cosCredentialOutcome {
	if s.hub == nil || s.hub.cos == nil {
		return cosCredentialOutcome{
			State:   "not-started",
			Message: "The chief of staff will use this credential the next time you open it.",
		}
	}
	return s.hub.cos.credentialsChanged()
}

// handleCredentialsDelete removes muxterm's stored key for one provider.
// Idempotent.
//
// It does not claim the machine is now unconfigured: an environment variable
// or an entry in amplifier's keys.env may still be there, and the report
// returned here says which.
func (s *Server) handleCredentialsDelete(w http.ResponseWriter, r *http.Request) {
	provider, ok := credProvider(w, r)
	if !ok {
		return
	}
	if err := s.ai.ClearProviderKey(provider); err != nil {
		log.Printf("credentials: clear %s: %v", provider, err)
		writeCredError(w, http.StatusInternalServerError, "clear_failed")
		return
	}
	if provider == ai.ProviderAnthropic {
		s.hub.BroadcastAIStatus(s.ai.Status())
	}

	// Removing muxterm's copy changes WHICH credential a lane gets: an
	// environment variable or an entry in amplifier's keys.env may now be the
	// effective one, and the verdict just forgotten belonged to the key that
	// is gone. Re-check rather than answering "not checked" for a machine
	// that is one free GET away from a real answer.
	s.ai.Verify(r.Context(), provider)

	writeCredJSON(w, http.StatusOK, map[string]any{"report": s.ai.Report()})
}

// handleCredentialsCheck presents the credential a lane would actually use to
// its vendor and reports what came back.
//
// This is the check that would have caught the Mac: it tests the EFFECTIVE
// credential, whatever its origin, rather than only a key muxterm stored. It
// authenticates and stops -- a model-list GET, no completion, no tokens.
func (s *Server) handleCredentialsCheck(w http.ResponseWriter, r *http.Request) {
	provider, ok := credProvider(w, r)
	if !ok {
		return
	}
	verdict := s.ai.Verify(r.Context(), provider)
	writeCredJSON(w, http.StatusOK, map[string]any{
		"verdict": verdict,
		"report":  s.ai.Report(),
	})
}
