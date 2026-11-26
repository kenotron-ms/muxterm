package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

type sdkWorkCompletion struct {
	ClosedWithoutReview    bool                `json:"closedWithoutReview,omitempty"`
	Reason                 string              `json:"reason"`
	Resolutions            []sdkWorkResolution `json:"resolutions,omitempty"`
	ReviewedUnreadComments bool                `json:"reviewedUnreadComments,omitempty"`
}

type sdkWorkResolution struct {
	sdkWorkStepChange
	Reason string `json:"reason"`
}

func (s *Server) handleSDKWorkComplete(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("X-Muxterm-Origin") != "" || (!humanBrowserRequest(r) && !s.remoteChatBridgeRequest(r)) {
		http.Error(w, "Mark complete requires an authorized human in the Work pane", http.StatusForbidden)
		return
	}
	var req struct {
		sdkWorkCompletion
		ClientRef        string   `json:"clientRef"`
		ExpectedRevision *int     `json:"expectedRevision"`
		Evidence         []string `json:"evidence"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 128<<10)).Decode(&req) != nil ||
		req.ExpectedRevision == nil || strings.TrimSpace(req.Reason) == "" || len(req.Reason) > 4096 {
		http.Error(w, "current Work revision and completion reason required", http.StatusBadRequest)
		return
	}
	changes := make([]sdkWorkStepChange, 0, len(req.Resolutions))
	for _, resolution := range req.Resolutions {
		changes = append(changes, resolution.sdkWorkStepChange)
	}
	s.applySDKWorkUpdate(w, r, sdkWorkUpdateRequest{
		ClientRef: req.ClientRef, ExpectedRevision: req.ExpectedRevision,
		Status: "done", Summary: "Marked complete by a human", Text: req.Reason,
		Evidence: req.Evidence, StepUpdates: changes,
	}, &req.sdkWorkCompletion)
}

func validateWorkCompletion(item *sdkWorkItem, completion *sdkWorkCompletion) error {
	if item.Status == "done" || item.Status == "cancelled" {
		return errors.New("Work is already closed")
	}
	if workStarting(item) {
		return errors.New("wait for Work kickoff reconciliation before completing")
	}
	if workCommentAttention(item, item.OwnerSessionID) != nil && !completion.ReviewedUnreadComments && !completion.ClosedWithoutReview {
		return errors.New("review comments still unread by the owner and confirm before completing")
	}
	resolutions := make(map[string]sdkWorkResolution, len(completion.Resolutions))
	for _, resolution := range completion.Resolutions {
		resolutions[resolution.ID] = resolution
	}
	for _, step := range item.Plan {
		if step.Status == "done" || step.Status == "skipped" {
			continue
		}
		resolution := resolutions[step.ID]
		if (resolution.Status != "done" && resolution.Status != "skipped") ||
			strings.TrimSpace(resolution.Reason) == "" || len(resolution.Reason) > 2048 {
			return fmt.Errorf("choose Done or Skipped and give a reason for %s", step.Title)
		}
		delete(resolutions, step.ID)
	}
	if len(resolutions) != 0 {
		return errors.New("only unresolved steps can be resolved")
	}
	return nil
}
