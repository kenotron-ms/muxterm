package mcp

import (
	"fmt"
	"net/http"
	"os"
	"strings"
)

func setChatCaller(request *http.Request) error {
	request.Header.Set("X-Muxterm-Agent", "1")
	if token := os.Getenv("MUXTERM_CHAT_ORIGIN_TOKEN"); token != "" {
		request.Header.Set("X-Muxterm-Origin", token)
	}
	if path := os.Getenv("MUXTERM_CHAT_ORIGIN_FILE"); path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("read caller capability: %w", err)
		}
		if strings.TrimSpace(string(data)) == "" {
			return fmt.Errorf("empty caller capability")
		}
		request.Header.Set("X-Muxterm-Origin", strings.TrimSpace(string(data)))
	}
	return nil
}

func scopedChatTool(name string) bool {
	switch name {
	case "send_chat_message", "get_chat_goal", "control_chat_goal", "report_goal_evidence":
		return true
	case "send_input", "run_command", "session_send", "close_pane", "close_workspace", "spawn_lane", "spawn_chat", "spawn_operator_lane", "link_operator_lane", "unlink_operator_lane", "move_chat", "append_page_markdown", "delete_chat_page", "add_page_visualization", "create_trigger", "set_trigger_enabled", "delete_trigger":
		return false
	}
	return true
}
