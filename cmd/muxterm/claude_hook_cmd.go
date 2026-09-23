package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

type claudeHookPayload struct {
	SessionID            string `json:"session_id"`
	CWD                  string `json:"cwd"`
	HookEvent            string `json:"hook_event_name"`
	PromptID             string `json:"prompt_id"`
	Prompt               string `json:"prompt"`
	ToolName             string `json:"tool_name"`
	ToolUseID            string `json:"tool_use_id"`
	LastAssistantMessage string `json:"last_assistant_message"`
	Reason               string `json:"reason"`
}

func runClaudeHook(args []string) error {
	if len(args) != 1 {
		return errors.New("session claude-hook requires one native event name")
	}
	body, err := io.ReadAll(io.LimitReader(os.Stdin, sessiond.MaxHookReportBytes+1))
	if err != nil {
		return fmt.Errorf("read Claude hook: %w", err)
	}
	var p claudeHookPayload
	if err := json.Unmarshal(body, &p); err != nil {
		return fmt.Errorf("decode Claude hook: %w", err)
	}
	if p.SessionID == "" || p.HookEvent == "" {
		return errors.New("Claude hook omitted session_id or hook_event_name")
	}
	report := claudeReport(p, body)
	encoded, err := report.JSON()
	if err != nil {
		return err
	}
	_, err = sessiond.QueueHookReport(encoded)
	return err
}

func claudeReport(p claudeHookPayload, raw []byte) sessiond.HookReport {
	state, mode := sessiond.SessionStateWorking, sessiond.ModeInteractive
	project, name, doing, waiting := p.CWD, p.SessionID, "", ""
	event, clear := "metadata.updated", []string(nil)
	setDoing := true
	setState := true
	setName := false
	switch p.HookEvent {
	case "SessionStart":
		event, doing = "session.started", "Claude session started"
		setName = true
	case "UserPromptSubmit":
		event, doing = "turn.started", p.Prompt
		name, setName = firstCodexLine(p.Prompt, 120), true
	case "PreToolUse":
		event, doing = "tool.started", "Using "+p.ToolName
	case "PostToolUse":
		event, doing = "tool.completed", "Used "+p.ToolName
	case "PostToolUseFailure":
		event, doing = "tool.failed", "Failed "+p.ToolName
	case "PermissionRequest":
		event, state, waiting, doing = "attention.required", sessiond.SessionStateBlocked, sessiond.WaitingForPermission, "Permission requested for "+p.ToolName
	case "Notification":
		event, state, waiting, doing = "attention.required", sessiond.SessionStateBlocked, sessiond.WaitingForInput, "Claude requires attention"
	case "Stop":
		event, state, doing = "turn.completed", sessiond.SessionStateStopped, p.LastAssistantMessage
	case "StopFailure":
		event, state, doing = "turn.failed", sessiond.SessionStateFailed, "Claude stopped with an API error"
	case "SessionEnd":
		event, state, setDoing = "session.ended", sessiond.SessionStateStopped, false
	case "SubagentStart":
		event, doing = "session.started", "Claude subagent started"
	case "SubagentStop":
		event, setState, setDoing = "session.ended", false, false
	case "PreCompact":
		event, doing = "progress.updated", "Compacting context"
	case "PostCompact":
		event, doing = "progress.updated", "Context compacted"
	default:
		doing = "Claude event: " + p.HookEvent
	}
	if event == "turn.started" {
		clear = []string{"waiting_for"}
	}
	h := sha256.Sum256(raw)
	anchor := p.ToolUseID
	if anchor == "" {
		anchor = p.PromptID
	}
	if anchor == "" {
		anchor = hex.EncodeToString(h[:12])
	}
	eventID := strings.ToLower(p.HookEvent) + ":" + anchor
	patch := sessiond.HookPatch{Project: &project, Mode: &mode, WaitingFor: &waiting}
	if setName {
		patch.Name = &name
	}
	if setState {
		patch.State = &state
	}
	if setDoing {
		patch.Doing = &doing
	}
	return sessiond.HookReport{V: sessiond.HookReportVersion, Harness: sessiond.HarnessClaude,
		NativeSessionID: p.SessionID, NativeEvent: p.HookEvent, Event: event, EventID: eventID,
		TurnID: p.PromptID, ObservedAt: time.Now().UTC(), Clear: clear,
		Set: patch}
}
