package server

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// completedChatTurns is the authoritative completed-turn reader shared by
// side chat and Voice. A final, streaming turn is deliberately excluded.
func (h *sdkChatHost) completedChatTurns(parentID string) ([]string, bool, error) {
	file, err := os.Open(filepath.Join(h.dir, parentID+".ndjson"))
	if err != nil {
		return nil, false, fmt.Errorf("main chat history is unavailable: %w", err)
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64<<10), 16<<20)
	// A streaming main chat may be appending its last event while we read.
	// Only newline-terminated records belong to this snapshot.
	scanner.Split(func(data []byte, atEOF bool) (int, []byte, error) {
		if end := bytes.IndexByte(data, '\n'); end >= 0 {
			return end + 1, data[:end], nil
		}
		if atEOF {
			return len(data), nil, nil
		}
		return 0, nil, nil
	})
	var completed []string
	var turn []string
	var assistant string
	for scanner.Scan() {
		var event sdkEvent
		if json.Unmarshal(scanner.Bytes(), &event) != nil {
			return nil, false, fmt.Errorf("main chat history is damaged")
		}
		switch event.Type {
		case "input.accepted":
			if event.Kind == "user" && event.Origin == nil && event.Source != "recovery" && event.Text != "" {
				turn = append(turn, "User: "+event.Text)
			}
		case "assistant.delta":
			const maxAssistantBytes = 128 << 10
			if len(assistant) < maxAssistantBytes {
				remaining := maxAssistantBytes - len(assistant)
				if len(event.Text) > remaining {
					assistant += strings.ToValidUTF8(event.Text[:remaining], "")
				} else {
					assistant += event.Text
				}
			}
		case "turn.completed":
			if assistant != "" {
				turn = append(turn, "Assistant: "+assistant)
			}
			if len(turn) != 0 {
				completed = append(completed, strings.Join(turn, "\n\n"))
			}
			turn = nil
			assistant = ""
		case "turn.cancelled", "session.uncertain", "error":
			turn = nil
			assistant = ""
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, false, err
	}
	return completed, len(turn) != 0 || assistant != "", nil
}

// sideChatContext takes only completed turns, so a side question can be asked
// while the main agent is working without copying an unfinished response.
func (h *sdkChatHost) sideChatContext(parentID string) (string, error) {
	completed, _, err := h.completedChatTurns(parentID)
	if err != nil {
		return "", err
	}
	if len(completed) > 6 {
		completed = completed[len(completed)-6:]
	}
	context := strings.Join(completed, "\n\n")
	if len(context) > 24000 {
		context = "…" + strings.ToValidUTF8(context[len(context)-24000:], "")
	}
	return "You are in an independent side chat. Handle the user’s request here, including ordinary work supported by your authorized tools. The main chat’s completed messages below are background context; keep this side chat’s transcript separate. Do not send input to, steer, or change the main chat or its goal by default. If a request requires action by the main chat, explain the specific boundary and offer to send a message there. Send only when the user explicitly asks; an explicit request to send is authorization.\nMain chat ID (sideParentId): " + parentID + "\n\nMain chat context:\n" + context, nil
}
