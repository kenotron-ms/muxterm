package mcp

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
)

func registerChatCoordinationTools(srv *Server) {
	pt := newPublishTools()
	stringProp := map[string]any{"type": "string"}
	stringsProp := map[string]any{"type": "array", "items": stringProp}
	srv.Register("subscribe_chat_events", "Persist a session's subscription to topics from one or more source sessions. Topics: lifecycle, input, goal, work, session, error, or a custom topic. Repeating the same sources and topics returns the existing subscription. New events enter the subscriber's durable inbox; past events remain in source transcripts.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{"session_id": stringProp, "source_session_ids": stringsProp, "topics": stringsProp}), "required": []string{"session_id", "source_session_ids", "topics"}},
		func(args map[string]any) (string, error) {
			id, err := argString(args, "session_id")
			if err != nil {
				return "", err
			}
			sources, err := argStringSlice(args, "source_session_ids")
			if err != nil {
				return "", err
			}
			topics, err := argStringSlice(args, "topics")
			if err != nil {
				return "", err
			}
			body, _ := json.Marshal(map[string]any{"sources": sources, "topics": topics})
			result, err := pt.chatRequest(args, http.MethodPost, "/api/sdk-chats/"+url.PathEscape(id)+"/subscriptions", body)
			return string(result), err
		})
	srv.Register("list_chat_subscriptions", "List a session's durable topic subscriptions and source sessions.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{"session_id": stringProp}), "required": []string{"session_id"}},
		func(args map[string]any) (string, error) {
			id, err := argString(args, "session_id")
			if err != nil {
				return "", err
			}
			result, err := pt.chatRequest(args, http.MethodGet, "/api/sdk-chats/"+url.PathEscape(id)+"/subscriptions", nil)
			return string(result), err
		})
	srv.Register("unsubscribe_chat_events", "Remove a session's topic subscription. Already delivered inbox events remain readable.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{"session_id": stringProp, "subscription_id": stringProp}), "required": []string{"session_id", "subscription_id"}},
		func(args map[string]any) (string, error) {
			id, err := argString(args, "session_id")
			if err != nil {
				return "", err
			}
			sub, err := argString(args, "subscription_id")
			if err != nil {
				return "", err
			}
			result, err := pt.chatRequest(args, http.MethodDelete, "/api/sdk-chats/"+url.PathEscape(id)+"/subscriptions/"+url.PathEscape(sub), nil)
			return string(result), err
		})
	srv.Register("read_chat_inbox", "Read a session's persisted cross-session inbox from a byte cursor. Save the returned cursor and pass it as after to resume without duplicates. wait_ms (up to 30000) waits for a new event. Reading does not start or wake an agent.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{"session_id": stringProp, "after": stringProp, "limit": map[string]any{"type": "integer"}, "wait_ms": map[string]any{"type": "integer"}}), "required": []string{"session_id"}},
		func(args map[string]any) (string, error) {
			id, err := argString(args, "session_id")
			if err != nil {
				return "", err
			}
			path := "/api/sdk-chats/" + url.PathEscape(id) + "/inbox"
			query := url.Values{}
			if after, present, err := argStringOptional(args, "after"); err != nil {
				return "", err
			} else if present {
				query.Set("after", after)
			}
			for _, key := range []string{"limit", "wait_ms"} {
				if _, ok := args[key]; ok {
					n, err := argInt(args, key)
					if err != nil {
						return "", err
					}
					query.Set(key, strconv.Itoa(n))
				}
			}
			if len(query) > 0 {
				path += "?" + query.Encode()
			}
			result, err := pt.chatRequest(args, http.MethodGet, path, nil)
			return string(result), err
		})
	srv.Register("get_chat_inbox_attention", "Read this session's agent-selected inbox attention mode and the cursor consumed by its optional reminder hook. The default is manual; subscriptions never wake a session.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{"session_id": stringProp}), "required": []string{"session_id"}},
		func(args map[string]any) (string, error) {
			id, err := argString(args, "session_id")
			if err != nil {
				return "", err
			}
			result, err := pt.chatRequest(args, http.MethodGet, "/api/sdk-chats/"+url.PathEscape(id)+"/inbox-attention", nil)
			return string(result), err
		})
	srv.Register("set_chat_inbox_attention", "Choose manual inbox reads or an opt-in next-turn reminder for an Amplifier, ACP, or Copilot session. Reminder runs during an existing turn; it does not wake an idle chat. Codex can use read_chat_inbox directly.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{"session_id": stringProp, "mode": map[string]any{"type": "string", "enum": []string{"manual", "reminder"}}}), "required": []string{"session_id", "mode"}},
		func(args map[string]any) (string, error) {
			id, err := argString(args, "session_id")
			if err != nil {
				return "", err
			}
			mode, err := argString(args, "mode")
			if err != nil {
				return "", err
			}
			body, _ := json.Marshal(map[string]string{"mode": mode})
			result, err := pt.chatRequest(args, http.MethodPost, "/api/sdk-chats/"+url.PathEscape(id)+"/inbox-attention", body)
			return string(result), err
		})
	srv.Register("publish_chat_topic", "Publish a short event in a session's journal under a custom topic. Subscribed sessions receive it in their durable inbox. Reserved system topics and Goal state cannot be forged through this tool.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{"session_id": stringProp, "topic": stringProp, "text": stringProp}), "required": []string{"session_id", "topic", "text"}},
		func(args map[string]any) (string, error) {
			id, err := argString(args, "session_id")
			if err != nil {
				return "", err
			}
			topic, err := argString(args, "topic")
			if err != nil {
				return "", err
			}
			message, err := argString(args, "text")
			if err != nil {
				return "", err
			}
			body, _ := json.Marshal(map[string]string{"topic": topic, "text": message})
			result, err := pt.chatRequest(args, http.MethodPost, "/api/sdk-chats/"+url.PathEscape(id)+"/topics", body)
			if err != nil {
				return "", fmt.Errorf("publish_chat_topic: %w", err)
			}
			return string(result), nil
		})
}
