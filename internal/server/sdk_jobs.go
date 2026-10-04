package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/robfig/cron/v3"
)

// A job is one persistent SDK conversation with versioned standing instructions.
// Run metadata lives separately so a long-running job never rewrites an endless
// chat or run-history document when its schedule changes.
type sdkJob struct {
	ID            string     `json:"id"`
	ChatID        string     `json:"chatId"`
	Name          string     `json:"name"`
	Brief         string     `json:"brief"`
	Revision      int        `json:"revision"`
	Schedule      string     `json:"schedule"`
	ScheduleLabel string     `json:"scheduleLabel"`
	Timezone      string     `json:"timezone"`
	Enabled       bool       `json:"enabled"`
	NextRun       time.Time  `json:"nextRun,omitempty"`
	PendingAt     *time.Time `json:"pendingAt,omitempty"`
	ActiveRunID   string     `json:"activeRunId,omitempty"`
	LastRunID     string     `json:"lastRunId,omitempty"`
	CreatedAt     time.Time  `json:"createdAt"`
	UpdatedAt     time.Time  `json:"updatedAt"`
}

type sdkJobLog struct {
	At      time.Time `json:"at"`
	Kind    string    `json:"kind"`
	Message string    `json:"message"`
}

type sdkJobRun struct {
	ID          string      `json:"id"`
	JobID       string      `json:"jobId"`
	ChatID      string      `json:"chatId"`
	Trigger     string      `json:"trigger"`
	ScheduledAt *time.Time  `json:"scheduledAt,omitempty"`
	Revision    int         `json:"revision"`
	Brief       string      `json:"brief"`
	Status      string      `json:"status"`
	StartedAt   time.Time   `json:"startedAt"`
	FinishedAt  *time.Time  `json:"finishedAt,omitempty"`
	Summary     string      `json:"summary,omitempty"`
	Logs        []sdkJobLog `json:"logs"`
}

type sdkJobSummary struct {
	sdkJob
	LatestRun *sdkJobRun `json:"latestRun,omitempty"`
}

type sdkJobs struct {
	mu         sync.Mutex
	ctx        context.Context
	dir        string
	chats      *sdkChatHost
	jobs       map[string]*sdkJob
	runs       map[string]*sdkJobRun
	byChat     map[string]string
	dispatchWG sync.WaitGroup
}

var errJobOccurrenceRecorded = errors.New("scheduled occurrence already recorded")

func (m *sdkJobs) activeChat(chatID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	job := m.jobs[m.byChat[chatID]]
	return job != nil && job.ActiveRunID != ""
}

func jobSchedule(expression, zone string, after time.Time) (time.Time, error) {
	if strings.TrimSpace(expression) == "" {
		return time.Time{}, errors.New("schedule is required")
	}
	location, err := time.LoadLocation(zone)
	if err != nil {
		return time.Time{}, errors.New("unknown time zone")
	}
	parsed, err := cron.ParseStandard(expression)
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid five-field schedule: %w", err)
	}
	next := parsed.Next(after.In(location))
	if next.IsZero() {
		return time.Time{}, errors.New("schedule has no next occurrence")
	}
	return next.UTC(), nil
}

func writeJobFile(path string, value any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	temp := path + ".tmp"
	if err := os.WriteFile(temp, data, 0600); err != nil {
		return err
	}
	return os.Rename(temp, path)
}

func newSDKJobs(chats *sdkChatHost) *sdkJobs {
	manager := &sdkJobs{ctx: context.Background(), dir: filepath.Join(chats.dir, "jobs"), chats: chats, jobs: map[string]*sdkJob{}, runs: map[string]*sdkJobRun{}, byChat: map[string]string{}}
	entries, _ := os.ReadDir(manager.dir)
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(manager.dir, entry.Name()))
		if err != nil {
			continue
		}
		var job sdkJob
		if json.Unmarshal(data, &job) != nil || job.ID == "" || job.ChatID == "" {
			continue
		}
		manager.jobs[job.ID] = &job
		manager.byChat[job.ChatID] = job.ID
	}
	runDir := filepath.Join(manager.dir, "runs")
	runEntries, _ := os.ReadDir(runDir)
	for _, entry := range runEntries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(runDir, entry.Name()))
		if err != nil {
			continue
		}
		var run sdkJobRun
		if json.Unmarshal(data, &run) == nil && run.ID != "" && manager.jobs[run.JobID] != nil {
			manager.runs[run.ID] = &run
		}
	}
	// A stopped server cannot prove the result of an in-flight turn. Preserve
	// the record and require an explicit new run rather than retrying a side effect.
	now := time.Now().UTC()
	for _, run := range manager.runs {
		if run.Status != "queued" && run.Status != "running" {
			continue
		}
		run.Status = "outcome-unknown"
		run.FinishedAt = &now
		run.Logs = append(run.Logs, sdkJobLog{At: now, Kind: "recovery", Message: "Server stopped before this run's outcome was confirmed."})
		_ = manager.saveRunLocked(run)
	}
	for _, job := range manager.jobs {
		if job.PendingAt != nil {
			recorded := false
			for _, run := range manager.runs {
				if run.JobID == job.ID && run.ScheduledAt != nil && run.ScheduledAt.Equal(*job.PendingAt) {
					recorded = true
					break
				}
			}
			if !recorded {
				occurrence := *job.PendingAt
				missed := manager.newRunLocked(job, "schedule", &occurrence, "skipped")
				missed.FinishedAt = &now
				missed.Summary = "Server stopped before this occurrence could be dispatched"
				missed.Logs = append(missed.Logs, sdkJobLog{At: now, Kind: "recovery", Message: missed.Summary})
				_ = manager.saveRunLocked(missed)
				job.LastRunID = missed.ID
			}
			job.PendingAt = nil
		}
		if job.ActiveRunID != "" {
			job.ActiveRunID = ""
		}
		if job.Enabled && (job.NextRun.IsZero() || !job.NextRun.After(now)) {
			if !job.NextRun.IsZero() {
				occurrence := job.NextRun
				missed := manager.newRunLocked(job, "schedule", &occurrence, "skipped")
				missed.FinishedAt = &now
				missed.Summary = "Missed while the server was unavailable"
				missed.Logs = append(missed.Logs, sdkJobLog{At: now, Kind: "schedule", Message: missed.Summary})
				_ = manager.saveRunLocked(missed)
				job.LastRunID = missed.ID
			}
			job.NextRun, _ = jobSchedule(job.Schedule, job.Timezone, now)
		}
		_ = manager.saveJobLocked(job)
	}
	manager.pruneRunsLocked()
	return manager
}

// Keep recent run summaries and active runs in memory. Completed run files stay
// on disk, so the process footprint does not grow for the lifetime of a job.
func (m *sdkJobs) pruneRunsLocked() {
	byJob := make(map[string][]*sdkJobRun)
	for _, run := range m.runs {
		byJob[run.JobID] = append(byJob[run.JobID], run)
	}
	for jobID, runs := range byJob {
		sort.Slice(runs, func(i, j int) bool { return runs[i].StartedAt.After(runs[j].StartedAt) })
		for i, run := range runs {
			if i >= 300 && run.ID != m.jobs[jobID].ActiveRunID && run.ID != m.jobs[jobID].LastRunID && run.FinishedAt != nil {
				delete(m.runs, run.ID)
			}
		}
	}
}

func (m *sdkJobs) saveJobLocked(job *sdkJob) error {
	return writeJobFile(filepath.Join(m.dir, job.ID+".json"), job)
}
func (m *sdkJobs) saveRunLocked(run *sdkJobRun) error {
	return writeJobFile(filepath.Join(m.dir, "runs", run.ID+".json"), run)
}
func (m *sdkJobs) newRunLocked(job *sdkJob, trigger string, occurrence *time.Time, status string) *sdkJobRun {
	run := &sdkJobRun{ID: sdkID(), JobID: job.ID, ChatID: job.ChatID, Trigger: trigger, ScheduledAt: occurrence, Revision: job.Revision, Brief: job.Brief, Status: status, StartedAt: time.Now().UTC(), Logs: []sdkJobLog{}}
	m.runs[run.ID] = run
	return run
}
func (m *sdkJobs) appendLogLocked(run *sdkJobRun, kind, message string) {
	if len(run.Logs) >= 1000 {
		return
	}
	if len(message) > 2000 {
		message = message[:2000] + "…"
	}
	run.Logs = append(run.Logs, sdkJobLog{At: time.Now().UTC(), Kind: kind, Message: message})
}
func (m *sdkJobs) finishLocked(job *sdkJob, run *sdkJobRun, status, summary string) {
	now := time.Now().UTC()
	run.Status = status
	run.FinishedAt = &now
	run.Summary = summary
	m.appendLogLocked(run, "finish", summary)
	if err := m.saveRunLocked(run); err != nil {
		log.Printf("scheduled job %s: cannot persist run %s outcome: %v", job.ID, run.ID, err)
		return
	}
	previousJob := *job
	if job.ActiveRunID == run.ID {
		job.ActiveRunID = ""
	}
	job.LastRunID = run.ID
	if run.ScheduledAt != nil && job.PendingAt != nil && run.ScheduledAt.Equal(*job.PendingAt) {
		job.PendingAt = nil
	}
	job.UpdatedAt = now
	if err := m.saveJobLocked(job); err != nil {
		*job = previousJob
		log.Printf("scheduled job %s: cannot persist completed run pointer: %v", job.ID, err)
	}
	m.pruneRunsLocked()
}
func (m *sdkJobs) onChatEvent(event sdkEvent) {
	m.mu.Lock()
	defer m.mu.Unlock()
	job := m.jobs[m.byChat[event.SessionID]]
	if job == nil || job.ActiveRunID == "" {
		return
	}
	run := m.runs[job.ActiveRunID]
	if run == nil {
		return
	}
	switch event.Type {
	case "input.accepted":
		if event.InputID != run.ID {
			return
		}
		run.Status = "running"
		m.appendLogLocked(run, "admission", "Agent accepted the run in the job chat.")
	case "tool.started":
		if run.Status != "running" {
			return
		}
		m.appendLogLocked(run, "tool", "Started "+event.Name)
	case "tool.completed":
		if run.Status != "running" {
			return
		}
		outcome := "Completed "
		if event.Failed {
			outcome = "Failed "
		}
		m.appendLogLocked(run, "tool", outcome+event.Name)
	case "assistant.delta":
		if run.Status != "running" {
			return
		}
		// Keep the beginning of the answer so the run list starts with a
		// readable result instead of a fragment cut from the middle of a word.
		remaining := 800 - len([]rune(run.Summary))
		if remaining > 0 {
			part := []rune(event.Text)
			if len(part) > remaining {
				part = part[:remaining]
			}
			run.Summary += string(part)
		}
		return // high-frequency text deltas remain in the authoritative chat log
	case "turn.completed":
		if run.Status != "running" {
			return
		}
		if strings.TrimSpace(run.Summary) == "" {
			m.finishLocked(job, run, "outcome-unknown", "Agent ended without a result report")
		} else {
			m.finishLocked(job, run, "succeeded", strings.TrimSpace(run.Summary))
		}
		return
	case "turn.cancelled":
		if run.Status != "running" {
			return
		}
		m.finishLocked(job, run, "cancelled", "Agent turn was stopped")
		return
	case "session.uncertain":
		m.finishLocked(job, run, "outcome-unknown", event.Message)
		return
	case "error":
		if run.Status != "running" && run.Status != "queued" {
			return
		}
		m.finishLocked(job, run, "failed", event.Message)
		return
	default:
		return
	}
	_ = m.saveRunLocked(run)
}

func (m *sdkJobs) startRun(jobID, trigger string, occurrence *time.Time) (*sdkJobRun, error) {
	// Read the chat state before taking the jobs lock. No code path should need
	// to acquire the chat lock while holding the jobs lock.
	m.mu.Lock()
	job := m.jobs[jobID]
	if job == nil {
		m.mu.Unlock()
		return nil, errors.New("job not found")
	}
	chatID := job.ChatID
	m.mu.Unlock()
	m.chats.mu.Lock()
	chat := m.chats.chats[chatID]
	state := ""
	if chat != nil {
		state = chat.State
	}
	m.chats.mu.Unlock()
	m.mu.Lock()
	job = m.jobs[jobID]
	if job == nil {
		m.mu.Unlock()
		return nil, errors.New("job not found")
	}
	if occurrence != nil {
		for _, previous := range m.runs {
			if previous.JobID == jobID && previous.ScheduledAt != nil && previous.ScheduledAt.Equal(*occurrence) {
				m.mu.Unlock()
				return nil, errJobOccurrenceRecorded
			}
		}
	}
	if job.ActiveRunID != "" {
		m.mu.Unlock()
		return nil, errors.New("a run is already active")
	}
	if chat == nil || job.ChatID != chatID {
		m.mu.Unlock()
		return nil, errors.New("job chat is missing")
	}
	if state == "working" || state == "starting" || state == "uncertain" {
		m.mu.Unlock()
		return nil, fmt.Errorf("job chat is %s", state)
	}
	run := m.newRunLocked(job, trigger, occurrence, "queued")
	m.appendLogLocked(run, "admission", "Run queued from "+trigger+" trigger using brief revision "+fmt.Sprint(job.Revision)+".")
	job.ActiveRunID = run.ID
	previousPending := job.PendingAt
	if occurrence != nil {
		job.PendingAt = nil
	}
	job.UpdatedAt = time.Now().UTC()
	if err := m.saveRunLocked(run); err != nil {
		delete(m.runs, run.ID)
		job.ActiveRunID = ""
		job.PendingAt = previousPending
		m.mu.Unlock()
		return nil, err
	}
	if err := m.saveJobLocked(job); err != nil {
		job.ActiveRunID = ""
		job.PendingAt = previousPending
		run.Status = "failed"
		m.appendLogLocked(run, "error", "Could not persist run admission: "+err.Error())
		_ = m.saveRunLocked(run)
		m.mu.Unlock()
		return nil, err
	}
	copyJob := *job
	dispatchContext := m.ctx
	m.dispatchWG.Add(1)
	m.mu.Unlock()
	go func() { defer m.dispatchWG.Done(); m.dispatch(dispatchContext, copyJob, run.ID) }()
	return run, nil
}
func (m *sdkJobs) dispatch(parent context.Context, job sdkJob, runID string) {
	ctx, cancel := context.WithTimeout(parent, 3*time.Minute)
	defer cancel()
	m.chats.mu.Lock()
	chat := m.chats.chats[job.ChatID]
	m.chats.mu.Unlock()
	if chat == nil {
		m.failDispatch(job.ID, runID, "job chat disappeared", false)
		return
	}
	if err := m.chats.resume(ctx, chat); err != nil {
		m.failDispatch(job.ID, runID, "Could not resume job chat: "+err.Error(), false)
		return
	}
	content := fmt.Sprintf("Scheduled job run %s (%s). Standing instructions, revision %d:\n\n%s\n\nPerform the work now. Use code or tools where useful. Report what happened and any uncertainty.", runID, job.Name, job.Revision, job.Brief)
	result, err := m.chats.call(ctx, "send", map[string]any{"sessionId": job.ChatID, "input": map[string]any{"kind": "user", "source": "scheduled-job", "id": runID, "content": content, "displayContent": "Run job: " + job.Name, "model": chat.Model, "effort": chat.Effort}})
	if err != nil {
		m.failDispatch(job.ID, runID, "Run delivery uncertain: "+err.Error(), true)
		return
	}
	var acknowledgement struct{ Status, InputID string }
	if json.Unmarshal(result, &acknowledgement) != nil || acknowledgement.Status != "accepted" || acknowledgement.InputID != runID {
		m.failDispatch(job.ID, runID, "Run delivery acknowledgement was invalid", true)
	}
}
func (m *sdkJobs) failDispatch(jobID, runID, message string, uncertain bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	job, run := m.jobs[jobID], m.runs[runID]
	if job == nil || run == nil || job.ActiveRunID != runID {
		return
	}
	status := "failed"
	if uncertain {
		status = "outcome-unknown"
	}
	m.finishLocked(job, run, status, message)
}
func (m *sdkJobs) loop(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			m.tick(now.UTC())
		}
	}
}
func (m *sdkJobs) tick(now time.Time) {
	type dueJob struct {
		id         string
		occurrence time.Time
	}
	due := []dueJob{}
	m.mu.Lock()
	ids := make([]string, 0, len(m.jobs))
	for id := range m.jobs {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	// Persist each due occurrence separately so one slow disk write does not
	// hold event delivery behind every other job due at the same instant.
	for _, id := range ids {
		m.mu.Lock()
		job := m.jobs[id]
		if !job.Enabled || job.NextRun.IsZero() || job.NextRun.After(now) {
			m.mu.Unlock()
			continue
		}
		previous := *job
		occurrence := job.NextRun
		job.PendingAt = &occurrence
		next, err := jobSchedule(job.Schedule, job.Timezone, now)
		if err != nil {
			job.Enabled = false
			job.NextRun = time.Time{}
		} else {
			job.NextRun = next
		}
		job.UpdatedAt = now
		if err := m.saveJobLocked(job); err != nil {
			*job = previous
			m.mu.Unlock()
			continue
		}
		due = append(due, dueJob{job.ID, occurrence})
		m.mu.Unlock()
	}
	for _, entry := range due {
		if _, err := m.startRun(entry.id, "schedule", &entry.occurrence); err != nil {
			if errors.Is(err, errJobOccurrenceRecorded) {
				continue
			}
			m.mu.Lock()
			if job := m.jobs[entry.id]; job != nil {
				run := m.newRunLocked(job, "schedule", &entry.occurrence, "skipped")
				m.finishLocked(job, run, "skipped", err.Error())
			}
			m.mu.Unlock()
		}
	}
}

func (s *Server) handleSDKJobs(w http.ResponseWriter, r *http.Request) {
	m := s.sdkJobs
	if r.Method == http.MethodGet {
		m.mu.Lock()
		rows := make([]sdkJobSummary, 0, len(m.jobs))
		for _, job := range m.jobs {
			summary := sdkJobSummary{sdkJob: *job}
			if run := m.runs[job.LastRunID]; run != nil {
				copy := *run
				copy.Logs = nil
				summary.LatestRun = &copy
			}
			if run := m.runs[job.ActiveRunID]; run != nil {
				copy := *run
				copy.Logs = nil
				summary.LatestRun = &copy
			}
			rows = append(rows, summary)
		}
		m.mu.Unlock()
		sort.Slice(rows, func(i, j int) bool { return rows[i].CreatedAt.After(rows[j].CreatedAt) })
		writeSDKJSON(w, 200, rows)
		return
	}
	var request struct {
		ChatID, Name, Brief, Schedule, ScheduleLabel, Timezone string
		Enabled                                                *bool
	}
	if json.NewDecoder(io.LimitReader(r.Body, 32<<10)).Decode(&request) != nil {
		http.Error(w, "invalid JSON", 400)
		return
	}
	request.Name = strings.TrimSpace(request.Name)
	request.Brief = strings.TrimSpace(request.Brief)
	request.ScheduleLabel = strings.TrimSpace(request.ScheduleLabel)
	if request.ScheduleLabel == "" {
		request.ScheduleLabel = request.Schedule
	}
	if request.Name == "" || len([]rune(request.Name)) > 100 || request.Brief == "" || len(request.Brief) > 10000 || len(request.ScheduleLabel) > 140 {
		http.Error(w, "name or standing instructions are invalid", 400)
		return
	}
	if request.Timezone == "" {
		request.Timezone = "UTC"
	}
	next, err := jobSchedule(request.Schedule, request.Timezone, time.Now())
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	m.chats.mu.Lock()
	chat := m.chats.chats[request.ChatID]
	m.chats.mu.Unlock()
	if chat == nil {
		http.Error(w, "job chat not found", 404)
		return
	}
	now := time.Now().UTC()
	enabled := true
	if request.Enabled != nil {
		enabled = *request.Enabled
	}
	job := &sdkJob{ID: sdkID(), ChatID: request.ChatID, Name: request.Name, Brief: request.Brief, Revision: 1, Schedule: request.Schedule, ScheduleLabel: request.ScheduleLabel, Timezone: request.Timezone, Enabled: enabled, NextRun: next, CreatedAt: now, UpdatedAt: now}
	if !enabled {
		job.NextRun = time.Time{}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.byChat[job.ChatID] != "" {
		http.Error(w, "this chat already has a scheduled job", 409)
		return
	}
	if err := m.saveJobLocked(job); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	m.jobs[job.ID] = job
	m.byChat[job.ChatID] = job.ID
	writeSDKJSON(w, 201, job)
}

func (s *Server) handleSDKJob(w http.ResponseWriter, r *http.Request) {
	m := s.sdkJobs
	id := r.PathValue("id")
	m.mu.Lock()
	defer m.mu.Unlock()
	job := m.jobs[id]
	if job == nil {
		http.NotFound(w, r)
		return
	}
	if r.Method == http.MethodGet {
		writeSDKJSON(w, 200, job)
		return
	}
	var request struct {
		Name, Brief, Schedule, ScheduleLabel, Timezone *string
		Enabled                                        *bool
	}
	if json.NewDecoder(io.LimitReader(r.Body, 32<<10)).Decode(&request) != nil {
		http.Error(w, "invalid JSON", 400)
		return
	}
	previous := *job
	if request.Name != nil {
		name := strings.TrimSpace(*request.Name)
		if name == "" || len([]rune(name)) > 100 {
			http.Error(w, "invalid name", 400)
			return
		}
		job.Name = name
	}
	if request.Brief != nil {
		brief := strings.TrimSpace(*request.Brief)
		if brief == "" || len(brief) > 10000 {
			*job = previous
			http.Error(w, "invalid standing instructions", 400)
			return
		}
		if brief != job.Brief {
			job.Brief = brief
			job.Revision++
		}
	}
	if request.Schedule != nil {
		job.Schedule = strings.TrimSpace(*request.Schedule)
		if request.ScheduleLabel == nil {
			job.ScheduleLabel = job.Schedule
		}
	}
	if request.ScheduleLabel != nil {
		label := strings.TrimSpace(*request.ScheduleLabel)
		if label == "" || len(label) > 140 {
			*job = previous
			http.Error(w, "invalid schedule label", 400)
			return
		}
		job.ScheduleLabel = label
	}
	if request.Timezone != nil {
		job.Timezone = *request.Timezone
	}
	if request.Enabled != nil {
		job.Enabled = *request.Enabled
	}
	if job.Enabled {
		next, err := jobSchedule(job.Schedule, job.Timezone, time.Now())
		if err != nil {
			*job = previous
			http.Error(w, err.Error(), 400)
			return
		}
		job.NextRun = next
	} else {
		job.NextRun = time.Time{}
	}
	job.UpdatedAt = time.Now().UTC()
	if err := m.saveJobLocked(job); err != nil {
		*job = previous
		http.Error(w, err.Error(), 500)
		return
	}
	writeSDKJSON(w, 200, job)
}
func (s *Server) handleSDKJobRun(w http.ResponseWriter, r *http.Request) {
	m := s.sdkJobs
	jobID := r.PathValue("id")
	m.mu.Lock()
	job := m.jobs[jobID]
	m.mu.Unlock()
	if job == nil {
		http.NotFound(w, r)
		return
	}
	run, err := m.startRun(jobID, "manual", nil)
	if err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	writeSDKJSON(w, http.StatusAccepted, run)
}
func (s *Server) handleSDKJobRuns(w http.ResponseWriter, r *http.Request) {
	m := s.sdkJobs
	jobID := r.PathValue("id")
	m.mu.Lock()
	if m.jobs[jobID] == nil {
		m.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	rows := make([]sdkJobRun, 0)
	for _, run := range m.runs {
		if run.JobID == jobID {
			copy := *run
			copy.Logs = nil
			rows = append(rows, copy)
		}
	}
	m.mu.Unlock()
	sort.Slice(rows, func(i, j int) bool { return rows[i].StartedAt.After(rows[j].StartedAt) })
	if len(rows) > 300 {
		rows = rows[:300]
	}
	writeSDKJSON(w, 200, rows)
}
func (s *Server) handleSDKJobRunDetail(w http.ResponseWriter, r *http.Request) {
	m := s.sdkJobs
	m.mu.Lock()
	run := m.runs[r.PathValue("run")]
	if run == nil || run.JobID != r.PathValue("id") {
		m.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	copy := *run
	copy.Logs = append([]sdkJobLog(nil), run.Logs...)
	m.mu.Unlock()
	writeSDKJSON(w, 200, copy)
}
