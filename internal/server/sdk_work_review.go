package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// ReviewVersion distinguishes newly drafted Work from records created before
// design previews and revision-bound checks existed.
type sdkWorkDesignPreview struct {
	Version         string `json:"version"`
	ArtifactURL     string `json:"artifactUrl"`
	DesktopImageURL string `json:"desktopImageUrl,omitempty"`
	PhoneImageURL   string `json:"phoneImageUrl,omitempty"`
	AffectsDesktop  bool   `json:"affectsDesktop,omitempty"`
	AffectsPhone    bool   `json:"affectsPhone,omitempty"`
}

type sdkWorkGoalFinding struct {
	Rule       string `json:"rule"`
	Quote      string `json:"quote,omitempty"`
	Message    string `json:"message"`
	Suggestion string `json:"suggestion"`
}

type sdkWorkGoalCheck struct {
	GoalRevision int                  `json:"goalRevision"`
	GoalHash     string               `json:"goalHash"`
	Passed       bool                 `json:"passed"`
	Findings     []sdkWorkGoalFinding `json:"findings"`
	CheckedAt    time.Time            `json:"checkedAt"`
}

func workGoalHash(condition string) string {
	sum := sha256.Sum256([]byte(condition))
	return hex.EncodeToString(sum[:])
}

func workPreviewURL(value string) bool {
	if value == "" || len(value) > 2048 || strings.TrimSpace(value) != value {
		return false
	}
	u, err := url.Parse(value)
	return err == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Host != "" && u.User == nil
}

func validWorkDesignPreview(p *sdkWorkDesignPreview) bool {
	if p == nil || len(p.Version) > 80 || strings.TrimSpace(p.Version) == "" || !workPreviewURL(p.ArtifactURL) {
		return false
	}
	for _, image := range []string{p.DesktopImageURL, p.PhoneImageURL} {
		if image != "" && !workPreviewURL(image) {
			return false
		}
	}
	return true
}

func workRequiresPreview(item *sdkWorkItem) bool {
	if item.ReviewVersion == 0 {
		return false
	}
	if item.UIWork {
		return true
	}
	for _, label := range item.Labels {
		if slices.Contains([]string{"ui", "ux", "frontend", "visual-design", "web-ui", "mobile-ui"}, label) {
			return true
		}
	}
	return false
}

func workPreviewReady(item *sdkWorkItem) bool {
	if !workRequiresPreview(item) {
		return true
	}
	p := item.DesignPreview
	if !validWorkDesignPreview(p) {
		return false
	}
	// No surface flags means both surfaces need a preview.
	return (!p.AffectsDesktop && !p.AffectsPhone && p.DesktopImageURL != "" && p.PhoneImageURL != "") ||
		((!p.AffectsDesktop || p.DesktopImageURL != "") && (!p.AffectsPhone || p.PhoneImageURL != "") && (p.AffectsDesktop || p.AffectsPhone))
}

func workGoalCheckCurrent(item *sdkWorkItem) bool {
	return item.ReviewVersion == 0 ||
		(item.GoalCheck != nil &&
			item.GoalCheck.Passed &&
			item.GoalCheck.GoalRevision == item.GoalRevision &&
			item.GoalCheck.GoalHash == workGoalHash(item.GoalCondition))
}

// Filing is authorization to schedule the checked goal. Human-approved legacy
// records keep their separate approval receipt; neither path releases a hold.
func workGoalDispatchAuthorized(item *sdkWorkItem) bool {
	if item == nil || item.GoalCondition == "" || item.GoalRevision < 1 || !workGoalCheckCurrent(item) {
		return false
	}
	if item.GoalFiledRevision == item.GoalRevision {
		// Filed UI Work can develop its preview during execution. The preview gate
		// remains on the legacy human-approval path for existing records.
		return true
	}
	return item.GoalApproved == item.GoalRevision && item.GoalApprovedAt != nil && workPreviewReady(item)
}

func checkWorkGoal(condition string, revision int) sdkWorkGoalCheck {
	lower := strings.ToLower(condition)
	result := sdkWorkGoalCheck{GoalRevision: revision, GoalHash: workGoalHash(condition), Findings: []sdkWorkGoalFinding{}, CheckedAt: time.Now().UTC()}
	add := func(rule, quote, message, suggestion string) {
		result.Findings = append(result.Findings, sdkWorkGoalFinding{Rule: rule, Quote: quote, Message: message, Suggestion: suggestion})
	}
	if !strings.Contains(lower, "## outcome") && !strings.Contains(lower, "finish when") && !strings.Contains(lower, "done when") && !strings.Contains(lower, "complete when") {
		add("Outcome", "", "The finish state is not stated in a checkable form.", "Add an Outcome section naming the observable result and how it will be verified.")
	}
	if !strings.Contains(lower, "## limits") && !strings.Contains(lower, "## scope") && !strings.Contains(lower, "not required") && !strings.Contains(lower, "out of scope") {
		add("Scope", "", "The condition has no explicit scope boundary.", "Add a Limits or Scope section naming what this Work does not require.")
	}
	if !strings.Contains(lower, "blocker") && !strings.Contains(lower, "blocked") && !strings.Contains(lower, "unreachable") && !strings.Contains(lower, "cannot be completed") {
		add("Blocked exit", "", "The condition has no named blocked outcome.", "Say what to record and what to do if a required step cannot be completed.")
	}
	if workHasExternalAction(lower) && !strings.Contains(lower, "refus") && !strings.Contains(lower, "cannot be completed") && !strings.Contains(lower, "if blocked") && !strings.Contains(lower, "if a required step") {
		add("External refusal", "", "An external review, merge, or publish step has no explicit refusal path.", "Say how to record a refusal as a named blocker and what action remains.")
	}
	for _, finding := range sessiond.LintGoal(condition, sessiond.LaneUnattended) {
		// L6 flags the absence of a disjunctive exit in otherwise valid Work goals.
		// The blocked-exit check above supplies a more focused requirement here.
		if finding.Rule == "L6" {
			continue
		}
		add(finding.Rule, finding.Quote, finding.Reason, "Revise the quoted clause using the rule's suggested exit or scope boundary.")
	}
	// Compare explicit negative and positive instructions across clauses. This
	// catches direct contradictions; the human reviews semantic consistency.
	for _, contradiction := range workGoalContradictions(lower) {
		add("Consistency", contradiction, "A required action conflicts with a stated limit.", "Remove or revise one of the conflicting instructions.")
	}
	result.Passed = len(result.Findings) == 0
	return result
}

func workHasExternalAction(goal string) bool {
	for _, term := range []string{"merge", "publish", "deploy", "release with", "obtain required review", "pass ci"} {
		if strings.Contains(goal, term) {
			return true
		}
	}
	return false
}

func workGoalContradictions(goal string) []string {
	lines := strings.Split(goal, "\n")
	var prohibited []string
	for _, line := range lines {
		clause := strings.TrimLeft(strings.TrimSpace(line), "#-* ")
		if !strings.HasPrefix(clause, "do not ") {
			continue
		}
		clause = strings.TrimSuffix(strings.TrimPrefix(clause, "do not "), ".")
		for _, part := range strings.Split(strings.ReplaceAll(clause, " and ", " or "), " or ") {
			part = strings.TrimSpace(part)
			if len(part) >= 8 {
				prohibited = append(prohibited, part)
			}
		}
	}
	var found []string
	for _, phrase := range prohibited {
		for _, line := range lines {
			clause := strings.TrimLeft(strings.TrimSpace(line), "#-* ")
			if !strings.Contains(clause, phrase) || strings.HasPrefix(clause, "do not ") || strings.HasPrefix(clause, "never ") || strings.HasPrefix(clause, "no ") {
				continue
			}
			idx := strings.Index(clause, phrase)
			before := clause[:idx]
			if strings.Contains(before, "not ") || strings.Contains(before, "never ") || strings.Contains(before, "without ") {
				continue
			}
			found = append(found, phrase)
			break
		}
	}
	slices.Sort(found)
	found = slices.Compact(found)
	return found
}

func (s *Server) handleSDKWorkGoalCheck(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ClientRef        string `json:"clientRef"`
		ExpectedRevision int    `json:"expectedRevision"`
		GoalRevision     int    `json:"goalRevision"`
		Condition        string `json:"condition"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 16<<10)).Decode(&req) != nil || req.ClientRef == "" || len(req.ClientRef) > 256 || req.ExpectedRevision < 1 || req.GoalRevision < 1 || req.Condition == "" {
		http.Error(w, "clientRef, revisions, and exact condition required", 400)
		return
	}
	h := s.sdkChats
	h.mu.Lock()
	item := h.workItems[r.PathValue("id")]
	if item == nil {
		h.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	if item.Revision != req.ExpectedRevision || item.GoalRevision != req.GoalRevision || item.GoalCondition != req.Condition {
		h.mu.Unlock()
		http.Error(w, "Work goal changed; refresh and check the current condition", 409)
		return
	}
	if item.Status != "open" || item.Dispatch != nil || item.OwnerSessionID != "" {
		h.mu.Unlock()
		http.Error(w, "Work is already in motion", 409)
		return
	}
	if item.GoalCheck != nil && item.GoalCheck.GoalRevision == item.GoalRevision && item.GoalCheck.GoalHash == workGoalHash(item.GoalCondition) {
		copy := *item
		h.mu.Unlock()
		writeSDKJSON(w, 200, copy)
		return
	}
	copy := *item
	check := checkWorkGoal(item.GoalCondition, item.GoalRevision)
	copy.GoalCheck = &check
	copy.Revision++
	copy.UpdatedAt = time.Now().UTC()
	if err := h.saveWorkLocked(&copy); err != nil {
		h.mu.Unlock()
		http.Error(w, err.Error(), 500)
		return
	}
	h.mu.Unlock()
	writeSDKJSON(w, 200, copy)
}
