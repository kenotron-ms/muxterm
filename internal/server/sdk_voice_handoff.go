package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type sdkVoiceHandoff struct {
	Action  string `json:"action"`
	Message string `json:"message"`
}

// Realtime's action tool has no task text. Let a short-lived agent
// interpret the recent dialogue against the main chat before anything is sent.
// Its only output is a proposed message; it has no chat-message capability.
func (h *sdkVoiceHost) interpretDelegation(ctx context.Context, main sdkChat, nearDelegation string) (sdkVoiceHandoff, error) {
	mainContext, err := h.chats.sideChatContext(main.ID)
	if err != nil {
		return sdkVoiceHandoff{}, err
	}
	voiceContext := h.chats.recentVoiceContext(main.ID)
	if voiceContext == "" {
		return sdkVoiceHandoff{}, errors.New("voice transcript unavailable")
	}

	operatorID := sdkID()
	operator := &sdkChat{ID: operatorID, Title: "Voice handoff", Harness: main.Harness,
		Provider: main.Provider, Bundle: main.Bundle, Model: main.Model, Effort: main.Effort,
		ProjectPath: os.TempDir(), Permission: "read-only", Mode: "plan", Approval: "never",
		State: "starting", VoiceHandoff: true, UserTurns: 2, CreatedAt: time.Now().UTC()}
	events := make(chan sdkEvent, 256)
	h.chats.mu.Lock()
	h.chats.chats[operatorID] = operator
	h.chats.streams[operatorID] = map[chan sdkEvent]struct{}{events: {}}
	h.chats.mu.Unlock()
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, _ = h.chats.call(closeCtx, "interrupt", map[string]any{"sessionId": operatorID, "harness": main.Harness})
		_, _ = h.chats.call(closeCtx, "close", map[string]any{"sessionId": operatorID, "harness": main.Harness})
		h.chats.mu.Lock()
		delete(h.chats.streams, operatorID)
		delete(h.chats.chats, operatorID)
		h.chats.forgetChatOriginLocked(operatorID)
		h.chats.mu.Unlock()
		_ = os.Remove(filepath.Join(h.chats.dir, operatorID+".json"))
		_ = os.Remove(filepath.Join(h.chats.dir, operatorID+".ndjson"))
	}()
	if _, err := h.chats.call(ctx, "start", map[string]any{
		"sessionId": operatorID, "harness": main.Harness, "cwd": operator.ProjectPath,
		"bundle": main.Bundle, "provider": amplifierProviderModule(main.Harness, main.Provider),
		"model": main.Model, "effort": main.Effort, "approval": "never",
		"permission": "read-only", "mode": "plan", "catalog": true,
	}); err != nil {
		return sdkVoiceHandoff{}, err
	}
	prompt := "You are the voice companion's message operator. Read the main chat and the voice exchange, then decide what the USER most recently asked you to pass to the main task chat. " +
		"The voice transcript is noisy, may contain corrections or incomplete words, and can interleave with the voice assistant. The speech near delegation may include several utterances; use dialogue order to identify the latest request. Earlier utterances and assistant replies are context, not new instructions. " +
		"Use the main chat context to resolve references. Summarize the user's intent as one concise, actionable message on their behalf. Preserve their words verbatim when an exact quote is useful. " +
		"Do not invent a request or claim an action succeeded. Do not perform the task, call tools, edit files, or contact any chat. " +
		"Reply with ONLY JSON: {\"action\":\"send|status|cancel|end_voice|none\",\"message\":\"...\"}. " +
		"Use status for a question about task progress, cancel only for an explicit request to stop the task, and end_voice when the user says goodbye, says stop as a standalone request, or asks to stop or pause this voice conversation. End_voice leaves the main task running. Use none when the latest request is unclear. " +
		"For send, message must be the actual instruction or update to deliver, not a description of the conversation.\n\n" +
		mainContext + "\n\nLatest completed main-chat turns:\n" + h.transcript(main.ID) +
		"\n\nVoice exchange:\n" + voiceContext +
		"\n\nUser speech near this delegation:\n" + sanitizeVoiceContextText(nearDelegation, 1800)
	inputID := sdkID()
	result, err := h.chats.call(ctx, "send", map[string]any{"sessionId": operatorID,
		"input": map[string]any{"kind": "user", "source": "voice", "id": inputID,
			"content": prompt, "displayContent": "Interpret voice handoff", "model": main.Model, "effort": main.Effort}})
	if err != nil {
		return sdkVoiceHandoff{}, err
	}
	var ack struct {
		Status string `json:"status"`
	}
	if json.Unmarshal(result, &ack) != nil || ack.Status != "accepted" {
		return sdkVoiceHandoff{}, errors.New("voice operator did not accept the request")
	}
	var output strings.Builder
	for {
		select {
		case <-ctx.Done():
			return sdkVoiceHandoff{}, ctx.Err()
		case event := <-events:
			switch event.Type {
			case "assistant.delta":
				if output.Len()+len(event.Text) > 12000 {
					return sdkVoiceHandoff{}, errors.New("voice operator response too long")
				}
				output.WriteString(event.Text)
			case "assistant.interim":
				output.Reset()
			case "error", "session.uncertain", "turn.cancelled":
				return sdkVoiceHandoff{}, fmt.Errorf("voice operator turn ended: %s", event.Type)
			case "turn.completed":
				var handoff sdkVoiceHandoff
				if json.Unmarshal([]byte(strings.TrimSpace(output.String())), &handoff) != nil {
					return sdkVoiceHandoff{}, errors.New("voice operator did not return a handoff")
				}
				handoff.Message = strings.TrimSpace(handoff.Message)
				if len([]rune(handoff.Message)) > 1800 {
					return sdkVoiceHandoff{}, errors.New("voice operator message too long")
				}
				switch handoff.Action {
				case "send", "cancel":
					if handoff.Message == "" {
						return sdkVoiceHandoff{}, errors.New("voice operator message empty")
					}
				case "status", "end_voice", "none":
				default:
					return sdkVoiceHandoff{}, errors.New("voice operator action unavailable")
				}
				return handoff, nil
			}
		}
	}
}
