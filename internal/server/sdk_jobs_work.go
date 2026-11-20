package server

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"time"
)

// Work events are saved inside their Work update before any Job sees them.
// Scanning that ledger also recovers the gap between the Work write and run admission.
func (m *sdkJobs) scanWorkEvents() {
	m.mu.Lock()
	jobs := make([]sdkJob, 0, len(m.jobs))
	var earliest time.Time
	for _, job := range m.jobs {
		if job.Enabled && job.WorkTrigger != nil {
			jobs = append(jobs, *job)
			if earliest.IsZero() || job.WorkTrigger.Since.Before(earliest) {
				earliest = job.WorkTrigger.Since
			}
		}
	}
	m.mu.Unlock()
	if len(jobs) == 0 {
		return
	}
	m.chats.mu.Lock()
	events := make([]sdkJobWorkEvent, 0)
	for _, item := range m.chats.workItems {
		if item.UpdatedAt.Before(earliest) {
			continue
		}
		for _, update := range item.Updates {
			if update.JobEvent != nil && !update.JobEvent.At.Before(earliest) {
				events = append(events, *update.JobEvent)
			}
		}
	}
	m.chats.mu.Unlock()
	for _, event := range events {
		for _, job := range jobs {
			if event.SourceSessionID == job.ChatID || !jobWorkTriggerMatches(job.WorkTrigger, &event) {
				continue
			}
			m.admitWorkEvent(job.ID, event)
		}
	}
}

func workEventRunID(jobID, eventID string) string {
	sum := sha256.Sum256([]byte(jobID + ":" + eventID))
	return "work-" + hex.EncodeToString(sum[:16])
}

func (m *sdkJobs) admitWorkEvent(jobID string, event sdkJobWorkEvent) {
	runID := workEventRunID(jobID, event.ID)
	// Completed runs can leave the in-memory history after pruning, so the
	// durable file check is still needed. Keep that syscall outside m.mu.
	if _, err := os.Stat(filepath.Join(m.dir, "runs", runID+".json")); err == nil || !errors.Is(err, os.ErrNotExist) {
		return
	}
	m.mu.Lock()
	job := m.jobs[jobID]
	if job == nil || !job.Enabled || !jobWorkTriggerMatches(job.WorkTrigger, &event) || job.ChatID == event.SourceSessionID {
		m.mu.Unlock()
		return
	}
	if m.runs[runID] != nil {
		m.mu.Unlock()
		return
	}
	// The run identity is derived from the durable Work update. A busy Job
	// keeps the event pending and starts it after the current turn finishes.
	run := m.newRunLocked(job, "work", nil, "pending")
	delete(m.runs, run.ID)
	run.ID = runID
	run.WorkEvent = &event
	m.runs[runID] = run
	m.appendLogLocked(run, "work", fmt.Sprintf("Work %s entered %s at revision %d.", event.WorkID, event.Type, event.Revision))
	// A run file is saved first. Its deterministic ID prevents duplicate
	// admission even when the process stops before dispatch.
	if err := m.saveRunLocked(run); err != nil {
		delete(m.runs, runID)
		m.mu.Unlock()
		return
	}
	m.mu.Unlock()
}

func (m *sdkJobs) dispatchPendingWorkEvents() {
	m.mu.Lock()
	jobIDs := make([]string, 0, len(m.jobs))
	for id := range m.jobs {
		jobIDs = append(jobIDs, id)
	}
	m.mu.Unlock()
	for _, jobID := range jobIDs {
		m.mu.Lock()
		job := m.jobs[jobID]
		if job == nil || job.ActiveRunID != "" {
			m.mu.Unlock()
			continue
		}
		var pending *sdkJobRun
		for _, run := range m.runs {
			if run.JobID == jobID && run.Status == "pending" && run.WorkEvent != nil && (pending == nil || run.WorkEvent.At.Before(pending.WorkEvent.At)) {
				pending = run
			}
		}
		if pending == nil {
			m.mu.Unlock()
			continue
		}
		chatID := job.ChatID
		m.mu.Unlock()
		m.chats.mu.Lock()
		chat := m.chats.chats[chatID]
		state, archived := "", false
		if chat != nil {
			state, archived = chat.State, chat.Archived
		}
		m.chats.mu.Unlock()
		if state == "working" || state == "starting" {
			continue
		}
		m.mu.Lock()
		job = m.jobs[jobID]
		if job == nil || job.ActiveRunID != "" || pending.Status != "pending" {
			m.mu.Unlock()
			continue
		}
		if !job.Enabled || !jobWorkTriggerMatches(job.WorkTrigger, pending.WorkEvent) || archived || chat == nil || state == "uncertain" {
			reason := "Job was disabled before dispatch"
			if job.Enabled && !jobWorkTriggerMatches(job.WorkTrigger, pending.WorkEvent) {
				reason = "Work trigger changed before dispatch"
			}
			if archived {
				reason = "Job chat was archived before dispatch"
			}
			if chat == nil {
				reason = "Job chat is missing"
			}
			status := "skipped"
			if state == "uncertain" {
				reason = "Job chat outcome is uncertain; inspect the chat before another run"
				status = "outcome-unknown"
			}
			m.finishLocked(job, pending, status, reason)
			m.mu.Unlock()
			continue
		}
		pending.Status = "queued"
		m.appendLogLocked(pending, "admission", "Work event run queued for the job chat.")
		if err := m.saveRunLocked(pending); err != nil {
			pending.Status = "pending"
			m.mu.Unlock()
			continue
		}
		previous := *job
		job.ActiveRunID = pending.ID
		job.UpdatedAt = time.Now().UTC()
		if err := m.saveJobLocked(job); err != nil {
			*job = previous
			m.finishLocked(job, pending, "failed", "Could not persist Work run admission: "+err.Error())
			m.mu.Unlock()
			continue
		}
		copyJob := *job
		runID := pending.ID
		dispatchContext := m.ctx
		m.dispatchWG.Add(1)
		m.mu.Unlock()
		go func() { defer m.dispatchWG.Done(); m.dispatch(dispatchContext, copyJob, runID) }()
	}
}

func newJobWorkEvent(item *sdkWorkItem, update *sdkWorkUpdate) *sdkJobWorkEvent {
	if update.Status != "review" && update.Status != "blocked" && update.Status != "done" {
		return nil
	}
	return &sdkJobWorkEvent{
		ID: update.ID, WorkID: item.ID, Type: update.Status, Revision: item.Revision, At: update.At,
		Title: item.Title, Summary: update.Summary, BlockedReason: item.BlockedReason, Outcome: item.Outcome,
		ProjectIDs: slices.Clone(item.ProjectIDs), Labels: slices.Clone(item.Labels), SourceSessionID: update.SessionID,
	}
}
