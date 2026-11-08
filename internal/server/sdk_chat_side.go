package server

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// sideChatContext takes only completed turns, so a side question can be asked
// while the main agent is working without copying an unfinished response.
func (h *sdkChatHost) sideChatContext(parentID string) (string, error) {
	file, err := os.Open(filepath.Join(h.dir, parentID+".ndjson"))
	if err != nil {
		return "", fmt.Errorf("main chat history is unavailable: %w", err)
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64<<10), 16<<20)
	var completed []string
	var turn []string
	var assistant string
	for scanner.Scan() {
		var event sdkEvent
		if json.Unmarshal(scanner.Bytes(), &event) != nil {
			return "", fmt.Errorf("main chat history is damaged")
		}
		switch event.Type {
		case "input.accepted":
			if event.Kind == "user" && event.Origin == nil && event.Text != "" {
				turn = append(turn, "User: "+event.Text)
			}
		case "tool.started":
			assistant = ""
		case "assistant.delta":
			assistant += event.Text
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
		return "", err
	}
	if len(completed) > 6 {
		completed = completed[len(completed)-6:]
	}
	context := strings.Join(completed, "\n\n")
	if len(context) > 24000 {
		context = "…" + context[len(context)-24000:]
	}
	return "You are answering a side question about a separate, ongoing main chat. Use the following completed conversation as context. Keep this side conversation focused on explanation; do not alter the main chat or its goal.\n\nMain chat:\n" + context, nil
}
