package mcp

// Trigger tools: automations that spawn a lane with no human present.
//
// FOUR TOOLS, NOT FIVE. The fifth would be a trigger_history, and folding the
// fire log into list_triggers instead is deliberate: the question a human
// actually asks is "what is set up, and has it been working", and that should
// cost one call. A separate history tool would mean the common question needs
// two, and the fire log is the half people forget to ask for.
//
// Every one of them returns the FULL current set, mutations included. A caller
// that just disabled something sees what else is still armed without asking
// again -- which for a feature whose whole risk is unattended work is worth the
// slightly larger reply.

import (
	"fmt"
	"strings"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// triggerTools groups the trigger tool handlers.
type triggerTools struct {
	c *Client
}

func newTriggerTools(c *Client) *triggerTools { return &triggerTools{c: c} }

// triggerHistoryInReply bounds how much of each trigger's fire log rides on a
// list_triggers reply. The store keeps more; this is what an agent reading the
// answer needs to see a pattern without paying for a full log per trigger.
const triggerHistoryInReply = 5

func (tt *triggerTools) createTrigger(args map[string]any) (string, error) {
	name, err := argString(args, "name")
	if err != nil {
		return "", err
	}
	kind, err := argString(args, "kind")
	if err != nil {
		return "", err
	}
	workspace, err := argString(args, "workspace")
	if err != nil {
		return "", err
	}
	harness, err := argString(args, "harness")
	if err != nil {
		return "", err
	}
	prompt, _, err := argStringOptional(args, "prompt")
	if err != nil {
		return "", err
	}
	goal, _, err := argStringOptional(args, "goal")
	if err != nil {
		return "", err
	}
	schedule, _, err := argStringOptional(args, "schedule")
	if err != nil {
		return "", err
	}
	path, _, err := argStringOptional(args, "path")
	if err != nil {
		return "", err
	}
	maxRuns := 0
	if _, ok := args["max_runs"]; ok {
		maxRuns, err = argInt(args, "max_runs")
		if err != nil {
			return "", err
		}
	}

	// The SAME guard spawn_lane applies, applied here for the same reason and
	// with more force. S1 exists because a lane is a full coding agent with a
	// shell, so delegating an edit is the obvious way around a block that only
	// covered this session's own tools. A trigger is that, plus a clock: the
	// edit happens repeatedly, and at a time nobody chose to be present for.
	if err := guardCosConfig(prompt, goal); err != nil {
		return "", err
	}

	views, err := tt.c.conn.CreateTrigger(sessiond.Trigger{
		Name:      name,
		Kind:      kind,
		Schedule:  schedule,
		Path:      path,
		Workspace: workspace,
		Harness:   harness,
		Prompt:    prompt,
		Goal:      goal,
		MaxRuns:   maxRuns,
		// Created ENABLED. A trigger that has to be turned on after being
		// created is a trigger half the callers will forget to turn on, and
		// "why did my automation never run" is a worse failure than one extra
		// fire -- every other safeguard here already limits what that fire can
		// cost.
		Enabled: true,
	})
	if err != nil {
		return "", err
	}
	return tt.render(views, name)
}

func (tt *triggerTools) listTriggers(args map[string]any) (string, error) {
	views, err := tt.c.conn.ListTriggers()
	if err != nil {
		return "", err
	}
	return tt.render(views, "")
}

func (tt *triggerTools) setTriggerEnabled(args map[string]any) (string, error) {
	id, err := argString(args, "trigger_id")
	if err != nil {
		return "", err
	}
	enabled, present, err := argBool(args, "enabled")
	if err != nil {
		return "", err
	}
	if !present {
		return "", fmt.Errorf("enabled is required (true to arm, false to stop)")
	}
	views, err := tt.c.conn.SetTriggerEnabled(id, enabled)
	if err != nil {
		return "", err
	}
	return tt.render(views, id)
}

func (tt *triggerTools) deleteTrigger(args map[string]any) (string, error) {
	id, err := argString(args, "trigger_id")
	if err != nil {
		return "", err
	}
	views, err := tt.c.conn.DeleteTrigger(id)
	if err != nil {
		return "", err
	}
	return tt.render(views, "")
}

// render projects the daemon's view into the tool reply.
//
// The fire log is trimmed to its TAIL. A trigger's most recent outcomes are
// what say whether it is working; the oldest five of twenty are history nobody
// asked for in this call.
func (tt *triggerTools) render(views []sessiond.TriggerView, focus string) (string, error) {
	out := make([]map[string]any, 0, len(views))
	for _, v := range views {
		row := map[string]any{
			"id":        v.ID,
			"name":      v.Name,
			"kind":      v.Kind,
			"enabled":   v.Enabled,
			"workspace": v.Workspace,
			"harness":   v.Harness,
			"run_count": v.RunCount,
		}
		if v.Schedule != "" {
			row["schedule"] = v.Schedule
		}
		if v.Path != "" {
			row["path"] = v.Path
		}
		if v.Goal != "" {
			row["goal"] = v.Goal
		} else if v.Prompt != "" {
			row["prompt"] = v.Prompt
		}
		if v.MaxRuns > 0 {
			row["max_runs"] = v.MaxRuns
		}
		if v.LastFireAt > 0 {
			row["last_fire_at"] = v.LastFireAt
		}
		if v.NextFireAt > 0 {
			row["next_fire_at"] = v.NextFireAt
		}
		if v.ScheduleError != "" {
			row["schedule_error"] = v.ScheduleError
		}
		if v.DisabledReason != "" {
			row["disabled_reason"] = v.DisabledReason
		}
		if v.ConsecutiveFailures > 0 {
			row["consecutive_failures"] = v.ConsecutiveFailures
		}
		if v.Running {
			// Surfaced BEFORE a skip happens rather than only after: this is
			// the reason the next fire would be skipped, and knowing it now is
			// the difference between "my trigger is broken" and "my last lane
			// is still going".
			row["lane_running"] = true
		}
		history := v.History
		if len(history) > triggerHistoryInReply {
			history = history[len(history)-triggerHistoryInReply:]
		}
		fires := make([]map[string]any, 0, len(history))
		for _, f := range history {
			fire := map[string]any{"at": f.At, "outcome": f.Outcome}
			if f.Detail != "" {
				fire["detail"] = f.Detail
			}
			if f.WorkspaceID != "" {
				fire["workspace_id"] = f.WorkspaceID
				fire["pane_id"] = f.PaneID
			}
			fires = append(fires, fire)
		}
		if len(fires) > 0 {
			row["recent_fires"] = fires
		}
		out = append(out, row)
	}
	result := map[string]any{
		"triggers": out,
		"machine":  tt.c.Machine(),
		"limits": map[string]any{
			"max_concurrent_trigger_lanes": 3,
			"disable_after_failures":       3,
			"watch_debounce":               "2s",
		},
	}
	if focus != "" {
		result["focus"] = focus
	}
	return jsonText(result), nil
}

// triggerKindsDoc is shared by the create_trigger schema and its description so
// the two cannot drift.
var triggerKindsDoc = strings.Join([]string{sessiond.TriggerKindSchedule, sessiond.TriggerKindWatch}, "|")
