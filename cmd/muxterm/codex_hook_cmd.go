package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

type codexHookPayload struct {
	SessionID            string          `json:"session_id"`
	TurnID               string          `json:"turn_id"`
	CWD                  string          `json:"cwd"`
	HookEvent            string          `json:"hook_event_name"`
	Prompt               string          `json:"prompt"`
	ToolName             string          `json:"tool_name"`
	ToolUseID            string          `json:"tool_use_id"`
	ToolInput            json.RawMessage `json:"tool_input"`
	ToolResponse         json.RawMessage `json:"tool_response"`
	LastAssistantMessage string          `json:"last_assistant_message"`
	AgentID              string          `json:"agent_id"`
}

func runCodexHook(args []string) error {
	if len(args) != 0 {
		return errors.New("session codex-hook reads one native event from stdin")
	}
	body, err := io.ReadAll(io.LimitReader(os.Stdin, sessiond.MaxHookReportBytes+1))
	if err != nil {
		return fmt.Errorf("read Codex hook: %w", err)
	}
	var payload codexHookPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		return fmt.Errorf("decode Codex hook: %w", err)
	}
	if payload.SessionID == "" || payload.HookEvent == "" {
		return errors.New("Codex hook omitted session_id or hook_event_name")
	}
	report, err := codexReport(payload, body)
	if err != nil {
		return err
	}
	encoded, err := report.JSON()
	if err != nil {
		return err
	}
	_, err = sessiond.QueueHookReport(encoded)
	return err
}

func codexReport(p codexHookPayload, raw []byte) (sessiond.HookReport, error) {
	state, mode := sessiond.SessionStateWorking, sessiond.ModeInteractive
	project, name := p.CWD, p.SessionID
	doing, waiting := "", ""
	summary := ""
	coverage := "native lifecycle, local tools, plans, and permissions; hosted tools are not covered"
	event := "metadata.updated"
	clear := []string(nil)
	anchor := p.ToolUseID
	setState, setDoing, setName := true, true, false
	switch p.HookEvent {
	case "SessionStart":
		event, doing = "session.started", "Codex session started"
		setName = true
	case "UserPromptSubmit":
		event, doing, name, clear = "turn.started", p.Prompt, firstCodexLine(p.Prompt, 120), []string{"waiting_for", "summary", "todo"}
		anchor = p.TurnID
		setName = true
	case "PreToolUse":
		event, doing, clear = "tool.started", "Using "+p.ToolName, []string{"waiting_for"}
	case "PostToolUse":
		event, doing, clear = "tool.completed", "Used "+p.ToolName, []string{"waiting_for"}
	case "PermissionRequest":
		event, state, waiting, doing = "attention.required", sessiond.SessionStateBlocked, sessiond.WaitingForPermission, "Permission requested for "+p.ToolName
	case "Stop":
		// Stop is Codex's successful end-of-turn event, and carries the final
		// assistant report. Treating it as muxterm's deliberate-without-a-verdict
		// `stopped` state made every normally completed Codex lane claim that it
		// had no result. Interrupt has its own event below; failures do not emit a
		// successful Stop. This is therefore a declaration of completion, not an
		// inference from process exit or prose in the report.
		event, state, doing, summary, anchor = "turn.completed", sessiond.SessionStateDone, firstCodexLine(p.LastAssistantMessage, 240), p.LastAssistantMessage, p.TurnID
	case "Interrupt":
		event, state, doing, summary, anchor = "turn.interrupted", sessiond.SessionStateStopped, "Codex turn interrupted", "Codex turn interrupted", p.TurnID
	case "SessionEnd":
		// SessionEnd says only that the thread closed. Do not overwrite the
		// stronger Stop/Interrupt declaration that immediately preceded it.
		event, setState, setDoing = "session.ended", false, false
	case "PreCompact":
		event, doing = "progress.updated", "Compacting Codex context"
	case "PostCompact":
		event, doing = "progress.updated", "Codex context compacted"
	case "SubagentStart":
		event, doing, anchor = "session.started", "Codex subagent started", p.AgentID
	case "SubagentStop":
		event, anchor, setState, setDoing = "session.ended", p.AgentID, false, false
	default:
		return sessiond.HookReport{}, fmt.Errorf("unsupported Codex hook event %q", p.HookEvent)
	}
	if anchor == "" {
		hash := sha256.Sum256(raw)
		anchor = hex.EncodeToString(hash[:12])
	}
	eventID := strings.ToLower(p.HookEvent) + ":" + anchor
	if p.HookEvent == "Stop" && p.TurnID != "" {
		eventID = "codex:" + p.SessionID + ":" + p.TurnID + ":complete"
	}
	patch := sessiond.HookPatch{Project: &project, Mode: &mode, WaitingFor: &waiting, Coverage: &coverage}
	if setName {
		patch.Name = &name
	}
	if setState {
		patch.State = &state
	}
	if setDoing {
		patch.Doing = &doing
	}
	if p.HookEvent == "Stop" || p.HookEvent == "Interrupt" {
		patch.Summary = &summary
	}
	if p.HookEvent == "PostToolUse" && p.ToolName == "update_plan" {
		var response string
		if json.Unmarshal(p.ToolResponse, &response) != nil || response != "Plan updated" {
			return sessiond.HookReport{}, errors.New("Codex update_plan did not report a successful application")
		}
		var input struct {
			Plan []struct{ Step, Status string } `json:"plan"`
		}
		if err := json.Unmarshal(p.ToolInput, &input); err != nil {
			return sessiond.HookReport{}, fmt.Errorf("decode Codex plan: %w", err)
		}
		if len(input.Plan) > 0 {
			todo := &sessiond.TodoProgress{Total: len(input.Plan)}
			for _, item := range input.Plan {
				text := firstCodexLine(item.Step, 240)
				switch item.Status {
				case "completed":
					todo.Done++
				case "in_progress":
					todo.Current = text
				case "pending":
				default:
					return sessiond.HookReport{}, fmt.Errorf("unknown Codex plan status %q", item.Status)
				}
				todo.Items = append(todo.Items, sessiond.TodoItem{Text: text, Status: item.Status})
			}
			patch.Todo = todo
			if todo.Current != "" {
				patch.Doing = &todo.Current
			}
		}
	}
	pid, _ := strconv.Atoi(os.Getenv("MUXTERM_CODEX_PID"))
	return sessiond.HookReport{V: sessiond.HookReportVersion, Harness: sessiond.HarnessCodex,
		NativeSessionID: p.SessionID, NativeEvent: p.HookEvent, Event: event, EventID: eventID,
		TurnID: p.TurnID, ObservedAt: time.Now().UTC(), Process: &sessiond.HookProcess{PID: pid}, Clear: clear, Set: patch}, nil
}

func firstCodexLine(value string, limit int) string {
	value = strings.TrimSpace(strings.SplitN(value, "\n", 2)[0])
	runes := []rune(value)
	if len(runes) > limit {
		value = string(runes[:limit])
	}
	return value
}
