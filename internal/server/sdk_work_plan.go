package server

import (
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
)

// Work plans guide execution. The filed goal remains the completion contract.
type sdkWorkStep struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Status string `json:"status"`
}

type sdkWorkStepChange struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

var workStepID = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,63}$`)

func validWorkSteps(steps []sdkWorkStep, initial bool) error {
	if len(steps) == 0 || len(steps) > 24 {
		return errors.New("work plan needs 1-24 steps")
	}
	seen := map[string]bool{}
	for _, step := range steps {
		if !workStepID.MatchString(step.ID) || seen[step.ID] {
			return errors.New("work step IDs must be unique lowercase identifiers")
		}
		seen[step.ID] = true
		if strings.TrimSpace(step.Title) == "" || len([]rune(step.Title)) > 160 || strings.ContainsAny(step.Title, "\r\n") {
			return fmt.Errorf("invalid title for work step %s", step.ID)
		}
		if !slices.Contains([]string{"pending", "in_progress", "done", "blocked", "skipped"}, step.Status) || initial && step.Status != "pending" {
			return fmt.Errorf("invalid status for work step %s", step.ID)
		}
	}
	return nil
}

func applyWorkPlan(item *sdkWorkItem, plan *[]sdkWorkStep, changes []sdkWorkStepChange, reason string) error {
	steps := slices.Clone(item.Plan)
	if plan != nil {
		if strings.TrimSpace(reason) == "" || len(reason) > 2048 {
			return errors.New("replanning requires a short plan reason")
		}
		if err := validWorkSteps(*plan, false); err != nil {
			return err
		}
		old := map[string]sdkWorkStep{}
		for _, step := range steps {
			old[step.ID] = step
		}
		for _, step := range *plan {
			if previous, exists := old[step.ID]; exists && (previous.Title != step.Title || previous.Status != step.Status) {
				return fmt.Errorf("existing step %s must keep its title and status during replan", step.ID)
			}
		}
		for _, step := range steps {
			if (step.Status == "done" || step.Status == "skipped") && !slices.ContainsFunc(*plan, func(next sdkWorkStep) bool { return next.ID == step.ID }) {
				return fmt.Errorf("completed step %s must remain in the plan", step.ID)
			}
		}
		steps = slices.Clone(*plan)
	}
	seen := map[string]bool{}
	for _, change := range changes {
		if seen[change.ID] {
			return fmt.Errorf("duplicate step update %s", change.ID)
		}
		seen[change.ID] = true
		found := false
		for i := range steps {
			if steps[i].ID != change.ID {
				continue
			}
			found = true
			from, to := steps[i].Status, change.Status
			if !slices.Contains([]string{"pending", "in_progress", "done", "blocked", "skipped"}, to) ||
				(from == "done" || from == "skipped") && from != to ||
				from == "blocked" && to == "pending" {
				return fmt.Errorf("illegal step transition %s: %s to %s", change.ID, from, to)
			}
			steps[i].Status = to
			break
		}
		if !found {
			return fmt.Errorf("unknown work step %s", change.ID)
		}
	}
	item.Plan = steps
	if plan != nil {
		item.PlanRevision++
	}
	return nil
}

func validWorkPlanHistory(item *sdkWorkItem, plan []sdkWorkStep) error {
	known := map[string]string{}
	active := map[string]bool{}
	for _, step := range item.Plan {
		known[step.ID] = step.Title
		active[step.ID] = true
	}
	for _, step := range item.CreatePlan {
		known[step.ID] = step.Title
	}
	for _, update := range item.Updates {
		for _, step := range update.PlanBefore {
			known[step.ID] = step.Title
		}
		for _, step := range update.PlanAfter {
			known[step.ID] = step.Title
		}
	}
	for _, step := range plan {
		if title, exists := known[step.ID]; exists {
			if title != step.Title {
				return fmt.Errorf("step ID %s was previously used for a different title", step.ID)
			}
			if !active[step.ID] {
				return fmt.Errorf("removed step ID %s cannot be reused", step.ID)
			}
		}
	}
	return nil
}

func workPlanComplete(steps []sdkWorkStep) bool {
	if len(steps) == 0 {
		return true
	} // Legacy Work has no checklist.
	done := false
	for _, step := range steps {
		if step.Status == "done" {
			done = true
		}
		if step.Status != "done" && step.Status != "skipped" {
			return false
		}
	}
	return done
}

func planBeforeForUpdate(plan *[]sdkWorkStep, steps []sdkWorkStep) []sdkWorkStep {
	if plan == nil {
		return nil
	}
	return steps
}

func planAfterForUpdate(plan *[]sdkWorkStep, steps []sdkWorkStep) []sdkWorkStep {
	if plan == nil {
		return nil
	}
	return slices.Clone(steps)
}
