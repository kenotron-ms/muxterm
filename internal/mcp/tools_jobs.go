package mcp

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// Scheduled jobs belong to the serve-layer Chat host. These tools use the same
// authenticated API as the Jobs screen, including its remote-machine routing.
func registerJobTools(srv *Server) {
	pt := newPublishTools()
	stringProp := map[string]any{"type": "string"}
	jobProp := map[string]any{"type": "string", "description": "Job ID from list_jobs"}
	workTriggerProp := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"events":      map[string]any{"type": "array", "items": map[string]any{"type": "string", "enum": []string{"review", "blocked", "done"}}},
			"project_ids": map[string]any{"type": "array", "items": stringProp},
			"labels":      map[string]any{"type": "array", "items": stringProp},
		},
		"required": []string{"events"},
	}
	definitionProps := map[string]any{
		"name":           stringProp,
		"brief":          map[string]any{"type": "string", "description": "Standing instructions sent on each run"},
		"schedule":       map[string]any{"type": "string", "description": "Five-field cron expression; empty for a Work-event-only job"},
		"schedule_label": map[string]any{"type": "string", "description": "Readable schedule shown in the Jobs screen"},
		"timezone":       map[string]any{"type": "string", "description": "IANA time zone, default UTC on creation"},
		"work_trigger":   workTriggerProp,
		"enabled":        map[string]any{"type": "boolean"},
	}
	jobPath := func(args map[string]any) (string, error) {
		id, err := argString(args, "job_id")
		if err != nil {
			return "", err
		}
		if strings.TrimSpace(id) == "" {
			return "", fmt.Errorf("job_id is required")
		}
		return "/api/sdk-jobs/" + url.PathEscape(id), nil
	}

	srv.Register("list_jobs", "List Scheduled jobs on the selected machine, including enabled state, next run, active run, latest result, schedule, Work-event trigger and owning chat.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{})},
		func(args map[string]any) (string, error) {
			return jobToolRequest(pt, args, http.MethodGet, "/api/sdk-jobs", nil, "jobs")
		})

	srv.Register("get_job", "Read one Scheduled job by ID. Use list_jobs to discover IDs; this read does not start or change a job.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{"job_id": jobProp}), "required": []string{"job_id"}},
		func(args map[string]any) (string, error) {
			path, err := jobPath(args)
			if err != nil {
				return "", err
			}
			return jobToolRequest(pt, args, http.MethodGet, path, nil, "job")
		})

	createProps := map[string]any{"client_ref": map[string]any{"type": "string", "description": "Unique retry key for this creation"}, "chat_id": map[string]any{"type": "string", "description": "Existing Chat that will receive each job run"}}
	for key, value := range definitionProps {
		createProps[key] = value
	}
	srv.Register("create_job", "Create a Scheduled job for an existing Chat. Supply a five-field cron schedule, a Work-event trigger, or both; one Chat can own one job. Enabled defaults to true. Reuse client_ref when retrying an uncertain creation; do not choose another Chat without checking the result.",
		map[string]any{"type": "object", "properties": withMachine(createProps), "required": []string{"client_ref", "chat_id", "name", "brief"}},
		func(args map[string]any) (string, error) {
			ref, err := jobClientRef(args)
			if err != nil {
				return "", err
			}
			chatID, err := argString(args, "chat_id")
			if err != nil {
				return "", err
			}
			name, err := argString(args, "name")
			if err != nil {
				return "", err
			}
			brief, err := argString(args, "brief")
			if err != nil {
				return "", err
			}
			body := map[string]any{"clientRef": ref, "chatId": chatID, "name": name, "brief": brief}
			if err := jobOptionalDefinition(args, body); err != nil {
				return "", err
			}
			return jobToolRequest(pt, args, http.MethodPost, "/api/sdk-jobs", body, "job")
		})

	updateProps := map[string]any{"job_id": jobProp, "clear_work_trigger": map[string]any{"type": "boolean", "description": "Remove the Work-event trigger; a cron schedule must remain"}}
	for key, value := range definitionProps {
		updateProps[key] = value
	}
	srv.Register("update_job", "Edit a Scheduled job, including its standing instructions, cron schedule, Work events, or enabled state. Omitted fields stay as they are. Set enabled=false to pause future fires; an active run continues. Set clear_work_trigger=true to remove Work events. The server refuses a job with neither cron nor Work events.",
		map[string]any{"type": "object", "properties": withMachine(updateProps), "required": []string{"job_id"}},
		func(args map[string]any) (string, error) {
			path, err := jobPath(args)
			if err != nil {
				return "", err
			}
			body := map[string]any{}
			if err := jobOptionalDefinition(args, body); err != nil {
				return "", err
			}
			clear, _, err := argBool(args, "clear_work_trigger")
			if err != nil {
				return "", err
			}
			if clear {
				if _, present := body["workTrigger"]; present {
					return "", fmt.Errorf("pass either work_trigger or clear_work_trigger=true")
				}
				body["workTrigger"] = nil
			}
			if len(body) == 0 {
				return "", fmt.Errorf("at least one job field must be updated")
			}
			return jobToolRequest(pt, args, http.MethodPatch, path, body, "job")
		})

	srv.Register("run_job", "Queue one manual run of a Scheduled job in its existing Chat. An active run or busy Chat is refused. Reuse client_ref when retrying an uncertain call; a matching retained run is returned instead of starting another.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{"job_id": jobProp, "client_ref": map[string]any{"type": "string", "description": "Unique retry key for this manual run"}}), "required": []string{"job_id", "client_ref"}},
		func(args map[string]any) (string, error) {
			path, err := jobPath(args)
			if err != nil {
				return "", err
			}
			ref, err := jobClientRef(args)
			if err != nil {
				return "", err
			}
			return jobToolRequest(pt, args, http.MethodPost, path+"/run", map[string]any{"clientRef": ref}, "run")
		})

	srv.Register("list_job_runs", "Read up to 300 recent runs of one Scheduled job, newest first. Use get_job_run for the selected run's detailed log.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{"job_id": jobProp}), "required": []string{"job_id"}},
		func(args map[string]any) (string, error) {
			path, err := jobPath(args)
			if err != nil {
				return "", err
			}
			return jobToolRequest(pt, args, http.MethodGet, path+"/runs", nil, "runs")
		})

	srv.Register("get_job_run", "Read one Scheduled job run with its status, summary, trigger, and event log.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{"job_id": jobProp, "run_id": map[string]any{"type": "string", "description": "Run ID from list_job_runs"}}), "required": []string{"job_id", "run_id"}},
		func(args map[string]any) (string, error) {
			path, err := jobPath(args)
			if err != nil {
				return "", err
			}
			runID, err := argString(args, "run_id")
			if err != nil {
				return "", err
			}
			if strings.TrimSpace(runID) == "" {
				return "", fmt.Errorf("run_id is required")
			}
			return jobToolRequest(pt, args, http.MethodGet, path+"/runs/"+url.PathEscape(runID), nil, "run")
		})
}

func jobClientRef(args map[string]any) (string, error) {
	ref, err := argString(args, "client_ref")
	if err != nil {
		return "", err
	}
	ref = strings.TrimSpace(ref)
	if ref == "" || len(ref) > 128 {
		return "", fmt.Errorf("client_ref must be 1 to 128 characters")
	}
	return ref, nil
}

func jobOptionalDefinition(args, body map[string]any) error {
	for _, field := range []struct{ tool, api string }{
		{"name", "name"}, {"brief", "brief"}, {"schedule", "schedule"},
		{"schedule_label", "scheduleLabel"}, {"timezone", "timezone"},
	} {
		value, present, err := argStringOptional(args, field.tool)
		if err != nil {
			return err
		}
		if present {
			body[field.api] = value
		}
	}
	if enabled, present, err := argBool(args, "enabled"); err != nil {
		return err
	} else if present {
		body["enabled"] = enabled
	}
	if raw, present := args["work_trigger"]; present {
		trigger, ok := raw.(map[string]any)
		if !ok {
			return fmt.Errorf("work_trigger must be an object")
		}
		for key := range trigger {
			if key != "events" && key != "project_ids" && key != "labels" {
				return fmt.Errorf("unknown work_trigger field %q", key)
			}
		}
		events, err := argStringSlice(trigger, "events")
		if err != nil {
			return err
		}
		if len(events) == 0 {
			return fmt.Errorf("work_trigger.events must contain at least one event")
		}
		projects, err := argStringSlice(trigger, "project_ids")
		if err != nil {
			return err
		}
		labels, err := argStringSlice(trigger, "labels")
		if err != nil {
			return err
		}
		body["workTrigger"] = map[string]any{"events": events, "projectIds": projects, "labels": labels}
	}
	return nil
}

func jobToolRequest(pt *publishTools, args map[string]any, method, path string, body map[string]any, resultKey string) (string, error) {
	var payload []byte
	if body != nil {
		payload, _ = json.Marshal(body)
	}
	result, err := pt.chatRequest(args, method, path, payload)
	if err != nil {
		return "", err
	}
	var value any
	if err := json.Unmarshal(result, &value); err != nil {
		return "", fmt.Errorf("decode Scheduled job response: %w", err)
	}
	machine, _, _ := argStringOptional(args, "machine")
	if machine == "" {
		machine = "local"
	}
	return jsonText(map[string]any{"machine": machine, resultKey: value}), nil
}
