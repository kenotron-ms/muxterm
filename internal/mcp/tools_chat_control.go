package mcp

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

const chatLocalOnly = "Chats belong to this muxterm serve process; use a session on the target machine"

// Discovery projects Go-owned chat IDs without exposing native harness resume IDs.
// The same ID is accepted unchanged by send_chat_message and read_chat_session.
type discoverChat struct {
	ID             string    `json:"id"`
	Project        string    `json:"project"`
	ProjectID      string    `json:"project_id,omitempty"`
	ProjectPath    string    `json:"project_path"`
	Harness        string    `json:"harness"`
	Title          string    `json:"title"`
	State          string    `json:"state"`
	LastActivityAt time.Time `json:"last_activity_at"`
	LastActivity   string    `json:"last_activity,omitempty"`
}

type discoverProject struct {
	ID    string         `json:"id"`
	Name  string         `json:"name"`
	Path  string         `json:"path"`
	Chats []discoverChat `json:"chats"`
}

func (pt *publishTools) chatDiscovery() ([]discoverChat, []discoverProject, []discoverChat, error) {
	chatBody, err := pt.doRequest(http.MethodGet, "/api/sdk-chats", nil)
	if err != nil {
		return nil, nil, nil, err
	}
	projectBody, err := pt.doRequest(http.MethodGet, "/api/sdk-projects", nil)
	if err != nil {
		return nil, nil, nil, err
	}
	var rawChats []struct {
		ID, WorkspaceID, ProjectPath, Title, Harness, State, LastActivity string
		CreatedAt, UpdatedAt                                              time.Time
	}
	var rawProjects []struct{ ID, Name, Path string }
	if err := json.Unmarshal(chatBody, &rawChats); err != nil {
		return nil, nil, nil, fmt.Errorf("decode chats: %w", err)
	}
	if err := json.Unmarshal(projectBody, &rawProjects); err != nil {
		return nil, nil, nil, fmt.Errorf("decode projects: %w", err)
	}
	projects := make([]discoverProject, 0, len(rawProjects))
	byID := make(map[string]int, len(rawProjects))
	for _, p := range rawProjects {
		byID[p.ID] = len(projects)
		projects = append(projects, discoverProject{ID: p.ID, Name: p.Name, Path: p.Path, Chats: []discoverChat{}})
	}
	chats := make([]discoverChat, 0, len(rawChats))
	ungrouped := []discoverChat{}
	for _, c := range rawChats {
		activityAt := c.UpdatedAt
		if activityAt.IsZero() {
			activityAt = c.CreatedAt
		}
		row := discoverChat{ID: c.ID, Project: "Ungrouped", ProjectPath: c.ProjectPath,
			Harness: c.Harness, Title: c.Title, State: c.State,
			LastActivityAt: activityAt, LastActivity: c.LastActivity}
		if i, ok := byID[c.WorkspaceID]; ok {
			row.Project = projects[i].Name
			row.ProjectID = projects[i].ID
			projects[i].Chats = append(projects[i].Chats, row)
		} else {
			ungrouped = append(ungrouped, row)
		}
		chats = append(chats, row)
	}
	sort.Slice(chats, func(i, j int) bool { return chats[i].ID < chats[j].ID })
	sort.Slice(ungrouped, func(i, j int) bool { return ungrouped[i].ID < ungrouped[j].ID })
	sort.Slice(projects, func(i, j int) bool { return projects[i].ID < projects[j].ID })
	for i := range projects {
		sort.Slice(projects[i].Chats, func(a, b int) bool { return projects[i].Chats[a].ID < projects[i].Chats[b].ID })
	}
	return chats, projects, ungrouped, nil
}

// These tools use the same authenticated serve-layer handoff as publications.
// They address Go-owned SDK chat IDs, never terminal pane IDs.
func registerChatControlTools(srv *Server) {
	pt := newPublishTools()
	srv.Register("list_chats", "List every addressable Chat on this muxterm serve process. IDs can be passed unchanged to send_chat_message. Local machine only.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{})},
		func(args map[string]any) (string, error) {
			if err := refuseRemote(args, chatLocalOnly); err != nil {
				return "", err
			}
			chats, _, _, err := pt.chatDiscovery()
			if err != nil {
				return "", err
			}
			return jsonText(map[string]any{"chats": chats}), nil
		})
	srv.Register("search_chats", "Search addressable Chats by case-insensitive substring in title, project name, or project path. Set include_content to also search accepted inputs and assistant text. Results carry IDs usable by send_chat_message. Local machine only.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{
			"query":           map[string]any{"type": "string", "description": "non-empty case-insensitive substring of title, project name, or project path"},
			"include_content": map[string]any{"type": "boolean", "description": "also search accepted chat inputs and assistant output (default false)"},
		}), "required": []string{"query"}},
		func(args map[string]any) (string, error) {
			if err := refuseRemote(args, chatLocalOnly); err != nil {
				return "", err
			}
			query, err := argString(args, "query")
			if err != nil {
				return "", err
			}
			query = strings.ToLower(strings.TrimSpace(query))
			if query == "" {
				return "", fmt.Errorf("query must not be empty")
			}
			chats, _, _, err := pt.chatDiscovery()
			if err != nil {
				return "", err
			}
			contentIDs := map[string]bool{}
			if include, ok := args["include_content"].(bool); ok && include {
				body, err := pt.doRequest(http.MethodGet, "/api/sdk-chats/search-content?q="+url.QueryEscape(query), nil)
				if err != nil {
					return "", err
				}
				var found struct {
					IDs []string `json:"ids"`
				}
				if err := json.Unmarshal(body, &found); err != nil {
					return "", err
				}
				for _, id := range found.IDs {
					contentIDs[id] = true
				}
			} else if raw, present := args["include_content"]; present && raw != nil && !ok {
				return "", fmt.Errorf("include_content must be a boolean")
			}
			matches := []discoverChat{}
			for _, c := range chats {
				if strings.Contains(strings.ToLower(c.Title), query) || strings.Contains(strings.ToLower(c.Project), query) || strings.Contains(strings.ToLower(c.ProjectPath), query) || contentIDs[c.ID] {
					matches = append(matches, c)
				}
			}
			return jsonText(map[string]any{"query": query, "chats": matches}), nil
		})
	srv.Register("list_projects", "List every muxterm Chat project with its addressable Chats. Ungrouped Chats are returned separately. Local machine only.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{})},
		func(args map[string]any) (string, error) {
			if err := refuseRemote(args, chatLocalOnly); err != nil {
				return "", err
			}
			_, projects, ungrouped, err := pt.chatDiscovery()
			if err != nil {
				return "", err
			}
			return jsonText(map[string]any{"projects": projects, "ungrouped_chats": ungrouped}), nil
		})
	srv.Register("list_chat_sessions", "List addressable Chats with stable IDs, project, harness, title, current state, last activity and recent output. Local machine only.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{})},
		func(args map[string]any) (string, error) {
			if err := refuseRemote(args, chatLocalOnly); err != nil {
				return "", err
			}
			chats, err := pt.doRequest(http.MethodGet, "/api/sdk-chats", nil)
			if err != nil {
				return "", err
			}
			projects, err := pt.doRequest(http.MethodGet, "/api/sdk-projects", nil)
			if err != nil {
				return "", err
			}
			return jsonText(map[string]any{"sessions": json.RawMessage(chats), "projects": json.RawMessage(projects)}), nil
		})
	srv.Register("spawn_chat", "Delegate work to a project Chat by default. Optional goal starts an Amplifier stop-condition loop. approval controls Codex/Claude permissions for this Chat; never runs unattended. Returns its stable session ID. Local machine only.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{
			"project":  map[string]any{"type": "string", "description": "exact name of an existing project; omit for Ungrouped"},
			"harness":  map[string]any{"type": "string", "enum": []string{"amplifier", "claude", "codex"}},
			"prompt":   map[string]any{"type": "string", "description": "opening user turn"},
			"goal":     map[string]any{"type": "string", "description": "Amplifier stop condition; starts a real goal loop and supersedes prompt"},
			"approval": map[string]any{"type": "string", "enum": []string{"prompt", "never"}, "description": "Codex/Claude permission policy for this chat; default never for unattended work"},
		}), "required": []string{"harness"}},
		func(args map[string]any) (string, error) {
			if err := refuseRemote(args, chatLocalOnly); err != nil {
				return "", err
			}
			harness, err := argString(args, "harness")
			if err != nil {
				return "", err
			}
			if harness != "amplifier" && harness != "claude" && harness != "codex" {
				return "", fmt.Errorf("unsupported harness %q", harness)
			}
			prompt, err := argString(args, "prompt")
			if err != nil && args["prompt"] != nil {
				return "", err
			}
			goal, _, err := argStringOptional(args, "goal")
			if err != nil {
				return "", err
			}
			approval, _, err := argStringOptional(args, "approval")
			if err != nil {
				return "", err
			}
			if goal != "" && harness != "amplifier" {
				return "", fmt.Errorf("goal requires amplifier")
			}
			if approval != "" && approval != "prompt" && approval != "never" {
				return "", fmt.Errorf("approval must be prompt or never")
			}
			if approval != "" && harness == "amplifier" {
				return "", fmt.Errorf("amplifier has no chat approval translation")
			}
			if strings.TrimSpace(prompt) == "" && strings.TrimSpace(goal) == "" {
				return "", fmt.Errorf("prompt or goal required")
			}
			if goal != "" {
				prompt = goal
			}
			project, _, err := argStringOptional(args, "project")
			if err != nil {
				return "", err
			}
			payload := map[string]any{"harness": harness, "prompt": prompt, "goal": goal, "approval": approval}
			if project != "" {
				body, err := pt.doRequest(http.MethodGet, "/api/sdk-projects", nil)
				if err != nil {
					return "", err
				}
				var projects []struct{ ID, Name string }
				if err = json.Unmarshal(body, &projects); err != nil {
					return "", err
				}
				matches := 0
				for _, p := range projects {
					if p.Name == project {
						payload["workspaceId"] = p.ID
						matches++
					}
				}
				if matches != 1 {
					return "", fmt.Errorf("project %q matched %d projects; name must identify exactly one", project, matches)
				}
			}
			body, _ := json.Marshal(payload)
			result, err := pt.doRequest(http.MethodPost, "/api/sdk-chats", body)
			if err != nil {
				return "", fmt.Errorf("spawn_chat outcome uncertain; list_chat_sessions before creating another chat: %w", err)
			}
			return string(result), nil
		})
	srv.Register("send_chat_message", "Submit a durable, idempotent turn to a Chat by stable ID. While Amplifier is running, steering is delivered at its next request boundary. Accepted proves admission, not completion; read_chat_session shows delivery and output. Reuse client_ref to query the same receipt; uncertain never retries the input.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{
			"session_id": map[string]any{"type": "string"},
			"client_ref": map[string]any{"type": "string", "description": "caller-chosen stable idempotency key; reuse exactly on uncertain results"},
			"content":    map[string]any{"type": "string"},
		}), "required": []string{"session_id", "client_ref", "content"}},
		func(args map[string]any) (string, error) {
			if err := refuseRemote(args, chatLocalOnly); err != nil {
				return "", err
			}
			id, err := argString(args, "session_id")
			if err != nil {
				return "", err
			}
			key, err := argString(args, "client_ref")
			if err != nil {
				return "", err
			}
			content, err := argString(args, "content")
			if err != nil {
				return "", err
			}
			body, _ := json.Marshal(map[string]string{"clientRef": key, "content": content})
			result, err := pt.doRequest(http.MethodPost, "/api/sdk-chats/"+url.PathEscape(id)+"/control-send", body)
			if err != nil {
				return "", fmt.Errorf("send_chat_message delivery uncertain; retry only with the same client_ref: %w", err)
			}
			return string(result), nil
		})
	srv.Register("read_chat_session", "Read a Chat's recent persisted events and output by stable ID. Milestones retain input acceptance, delivery, and completion across long streamed replies. Local machine only.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{"session_id": map[string]any{"type": "string"}}), "required": []string{"session_id"}},
		func(args map[string]any) (string, error) {
			if err := refuseRemote(args, chatLocalOnly); err != nil {
				return "", err
			}
			id, err := argString(args, "session_id")
			if err != nil {
				return "", err
			}
			result, err := pt.doRequest(http.MethodGet, "/api/sdk-chats/"+url.PathEscape(id)+"/control-history", nil)
			if err != nil {
				return "", err
			}
			return string(result), nil
		})
}
