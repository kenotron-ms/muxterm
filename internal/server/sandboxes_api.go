package server

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/kenotron-ms/muxterm/internal/sandboxazure"
)

// The direct sandbox API only accepts muxterm handles, configured profile
// names, generation fences, and client idempotency keys. Azure endpoint,
// scope, provider identity, labels, signer material, and credentials are
// intentionally unrepresentable in these request types.
type sandboxEnvelope struct {
	Availability sandboxazure.Availability `json:"availability"`
	Sandboxes    []sandboxazure.View       `json:"sandboxes,omitempty"`
	Sandbox      *sandboxazure.View        `json:"sandbox,omitempty"`
	Error        string                    `json:"error,omitempty"`
}

type sandboxCreateRequest struct {
	Profile string `json:"profile"`
}

type sandboxActionRequest struct {
	Generation    uint64 `json:"generation"`
	ConfirmHandle string `json:"confirm_handle"`
}

func (s *Server) handleSandboxPresentation(w http.ResponseWriter, _ *http.Request) {
	if s.sandboxPresentation == nil {
		writeSandboxError(w, http.StatusServiceUnavailable, "Sandbox presentation is temporarily unavailable.")
		return
	}
	presentation, err := s.sandboxPresentation.Read()
	if err != nil {
		if errors.Is(err, sandboxazure.ErrPresentationConfiguration) {
			w.Header().Set("Cache-Control", "no-store")
			httpJSONError(w, http.StatusServiceUnavailable, "sandbox_presentation_unavailable",
				"Sandbox presentation is unavailable until muxterm is restarted with valid owner configuration.")
			return
		}
		writeSandboxError(w, http.StatusServiceUnavailable, "Sandbox presentation is temporarily unavailable.")
		return
	}
	writeSandboxJSON(w, http.StatusOK, presentation)
}

func (s *Server) handleSandboxesList(w http.ResponseWriter, r *http.Request) {
	if s.sandbox == nil {
		writeSandboxJSON(w, http.StatusOK, sandboxEnvelope{Availability: s.sandboxAvailability, Sandboxes: []sandboxazure.View{}})
		return
	}
	items, err := s.sandbox.List(r.Context())
	if err != nil {
		writeSandboxError(w, http.StatusServiceUnavailable, "Sandbox status is temporarily unavailable.")
		return
	}
	writeSandboxJSON(w, http.StatusOK, sandboxEnvelope{Availability: s.sandboxAvailability, Sandboxes: items})
}

func (s *Server) handleSandboxGet(w http.ResponseWriter, r *http.Request) {
	if s.sandbox == nil {
		writeSandboxError(w, http.StatusNotFound, s.sandboxAvailability.Detail)
		return
	}
	item, err := s.sandbox.Describe(r.Context(), r.PathValue("handle"))
	if err != nil {
		writeSandboxControllerError(w, err)
		return
	}
	writeSandboxJSON(w, http.StatusOK, sandboxEnvelope{Availability: s.sandboxAvailability, Sandbox: &item})
}

func (s *Server) handleSandboxCreate(w http.ResponseWriter, r *http.Request) {
	if s.sandbox == nil {
		writeSandboxError(w, http.StatusConflict, s.sandboxAvailability.Detail)
		return
	}
	requestID, ok := sandboxRequestID(w, r)
	if !ok {
		return
	}
	var body sandboxCreateRequest
	if !decodeSandboxJSON(w, r, &body) {
		return
	}
	if strings.TrimSpace(body.Profile) == "" {
		writeSandboxError(w, http.StatusBadRequest, "profile is required.")
		return
	}
	item, err := s.sandbox.Create(r.Context(), body.Profile, requestID)
	writeSandboxOutcome(w, s.sandboxAvailability, item, err)
}

func (s *Server) handleSandboxAction(w http.ResponseWriter, r *http.Request) {
	if s.sandbox == nil {
		writeSandboxError(w, http.StatusConflict, s.sandboxAvailability.Detail)
		return
	}
	requestID, ok := sandboxRequestID(w, r)
	if !ok {
		return
	}
	handle, action := r.PathValue("handle"), r.PathValue("action")
	var body sandboxActionRequest
	if !decodeSandboxJSON(w, r, &body) {
		return
	}
	if body.Generation == 0 {
		writeSandboxError(w, http.StatusBadRequest, "generation must be a positive integer.")
		return
	}
	if action == "destroy" && body.ConfirmHandle != handle {
		writeSandboxError(w, http.StatusBadRequest, "destroy requires confirm_handle matching the sandbox handle.")
		return
	}
	var (
		item sandboxazure.View
		err  error
	)
	switch action {
	case "stop":
		item, err = s.sandbox.Stop(r.Context(), handle, body.Generation, requestID)
	case "resume":
		item, err = s.sandbox.Resume(r.Context(), handle, body.Generation, requestID)
	case "destroy":
		item, err = s.sandbox.Destroy(r.Context(), handle, body.Generation, requestID)
	case "reconcile":
		item, err = s.sandbox.Reconcile(r.Context(), handle, body.Generation, requestID)
	case "attach":
		err = s.sandbox.Attach(handle, body.Generation, requestID)
	default:
		writeSandboxError(w, http.StatusNotFound, "Unknown sandbox action.")
		return
	}
	writeSandboxOutcome(w, s.sandboxAvailability, item, err)
}

func sandboxRequestID(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := r.Header.Get("Idempotency-Key")
	if _, err := uuid.Parse(id); err != nil {
		writeSandboxError(w, http.StatusBadRequest, "Idempotency-Key must be a UUID.")
		return "", false
	}
	return id, true
}

func decodeSandboxJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	decoder := json.NewDecoder(io.LimitReader(r.Body, 16<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		writeSandboxError(w, http.StatusBadRequest, "Sandbox request is not valid.")
		return false
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		writeSandboxError(w, http.StatusBadRequest, "Sandbox request must contain one JSON object.")
		return false
	}
	return true
}

func writeSandboxJSON(w http.ResponseWriter, code int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(value) //nolint:errcheck
}

func writeSandboxError(w http.ResponseWriter, code int, message string) {
	writeSandboxJSON(w, code, map[string]string{"error": message})
}

func writeSandboxControllerError(w http.ResponseWriter, err error) {
	writeSandboxJSON(w, sandboxErrorStatus(err), map[string]string{"error": sandboxErrorMessage(err)})
}

func writeSandboxOutcome(w http.ResponseWriter, availability sandboxazure.Availability, item sandboxazure.View, err error) {
	if item.Handle == "" {
		if err != nil {
			writeSandboxControllerError(w, err)
			return
		}
		writeSandboxError(w, http.StatusServiceUnavailable, "Sandbox operation did not return a durable record.")
		return
	}
	status := sandboxViewStatus(item)
	message := ""
	if err != nil {
		// A provider refusal/ambiguity can still return the owner-local durable
		// record for safe reconciliation, but it must never be a 2xx result.
		status = sandboxErrorStatus(err)
		if status < 400 {
			status = http.StatusConflict
		}
		message = sandboxErrorMessage(err)
	}
	writeSandboxJSON(w, status, sandboxEnvelope{Availability: availability, Sandbox: &item, Error: message})
}

// sandboxViewStatus makes replay status a function of durable operation state,
// not of whether the handler happened to return an error this time.
func sandboxViewStatus(item sandboxazure.View) int {
	switch item.OperationState {
	case sandboxazure.OperationAccepted:
		return http.StatusAccepted
	case sandboxazure.OperationSucceeded:
		return http.StatusOK
	case sandboxazure.OperationPending, sandboxazure.OperationFailed, sandboxazure.OperationAmbiguous:
		return http.StatusConflict
	default:
		return http.StatusConflict
	}
}

func sandboxErrorStatus(err error) int {
	switch {
	case errors.Is(err, sandboxazure.ErrRecordNotFound):
		return http.StatusNotFound
	case errors.Is(err, sandboxazure.ErrStaleGeneration), errors.Is(err, sandboxazure.ErrRequestCollision), errors.Is(err, sandboxazure.ErrReconcileRequired), errors.Is(err, sandboxazure.ErrReconcileQuarantined), errors.Is(err, sandboxazure.ErrKillSwitch):
		return http.StatusConflict
	case errors.Is(err, sandboxazure.ErrAttachUnsupported):
		return http.StatusNotImplemented
	case errors.Is(err, sandboxazure.ErrUnknownProfile), errors.Is(err, sandboxazure.ErrBadScope):
		return http.StatusBadRequest
	default:
		return http.StatusServiceUnavailable
	}
}

func sandboxErrorMessage(err error) string {
	switch {
	case errors.Is(err, sandboxazure.ErrRecordNotFound):
		return "Sandbox handle was not found."
	case errors.Is(err, sandboxazure.ErrUnknownProfile), errors.Is(err, sandboxazure.ErrBadScope):
		return "The requested sandbox profile is not configured."
	case errors.Is(err, sandboxazure.ErrReconcileQuarantined):
		return "Sandbox recovery is quarantined. An owner recovery procedure is required."
	case errors.Is(err, sandboxazure.ErrStaleGeneration), errors.Is(err, sandboxazure.ErrRequestCollision), errors.Is(err, sandboxazure.ErrReconcileRequired), errors.Is(err, sandboxazure.ErrKillSwitch), errors.Is(err, sandboxazure.ErrAttachUnsupported):
		return err.Error()
	default:
		// Never reflect provider/credential/transport errors; the controller
		// deliberately keeps them private too.
		return "Sandbox operation could not be confirmed. Reconcile before retrying."
	}
}
