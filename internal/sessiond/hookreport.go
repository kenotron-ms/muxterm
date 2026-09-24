package sessiond

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/kenotron-ms/muxterm/internal/atomicfile"
)

const (
	HookReportVersion = 2
	// Turn-end reports carry the harness's complete final assistant message.
	// This is a transport rejection ceiling, not a truncation limit: an
	// oversized report fails loudly rather than publishing altered text.
	MaxHookReportBytes = 1 << 20
)

type HookProcess struct {
	PID      int    `json:"pid,omitempty"`
	PIDStart uint64 `json:"pid_start,omitempty"`
	SID      int    `json:"sid,omitempty"`
}

type HookPatch struct {
	Project    *string       `json:"project,omitempty"`
	Name       *string       `json:"name,omitempty"`
	Label      *string       `json:"label,omitempty"`
	Mode       *string       `json:"mode,omitempty"`
	State      *string       `json:"state,omitempty"`
	WaitingFor *string       `json:"waiting_for,omitempty"`
	Doing      *string       `json:"doing,omitempty"`
	Summary    *string       `json:"summary,omitempty"`
	DoneMeans  *string       `json:"done_means,omitempty"`
	Coverage   *string       `json:"coverage,omitempty"`
	Todo       *TodoProgress `json:"todo,omitempty"`
	Knows      *[]string     `json:"knows,omitempty"`
}

type HookReport struct {
	V               int          `json:"v"`
	Harness         string       `json:"harness"`
	NativeSessionID string       `json:"native_session_id"`
	NativeEvent     string       `json:"native_event"`
	Event           string       `json:"event"`
	EventID         string       `json:"event_id"`
	TurnID          string       `json:"turn_id,omitempty"`
	RunID           string       `json:"run_id,omitempty"`
	ObservedAt      time.Time    `json:"observed_at"`
	Process         *HookProcess `json:"process,omitempty"`
	Set             HookPatch    `json:"set,omitempty"`
	Clear           []string     `json:"clear,omitempty"`
}

type HookQueueReceipt struct {
	Status   string `json:"status"`
	ReportID string `json:"report_id"`
}

type hookReceipt struct {
	Status    string    `json:"status"`
	ReportID  string    `json:"report_id"`
	SessionID string    `json:"session_id,omitempty"`
	Error     string    `json:"error,omitempty"`
	At        time.Time `json:"at"`
}

type sessionRegistry struct {
	V        int                      `json:"v"`
	Sessions map[string]sessionRecord `json:"sessions"`
	Events   map[string]string        `json:"events"`
}

type sessionRecord struct {
	InstallationID string       `json:"installation_id"`
	Harness        string       `json:"harness"`
	NativeID       string       `json:"native_session_id"`
	Row            SessionState `json:"row"`
	LastObservedAt time.Time    `json:"last_observed_at,omitempty"`
	PID            int          `json:"pid,omitempty"`
	PIDStart       uint64       `json:"pid_start,omitempty"`
	SID            int          `json:"sid,omitempty"`
}

type hookReportStore struct {
	root           string
	installationID string
}

func HookReportRoot() string {
	if override := os.Getenv("MUXTERM_HOOK_REPORT_ROOT"); override != "" {
		return override
	}
	return filepath.Join(snapshotDir(), "agent-sessions")
}

// LookupHookSession resolves a muxterm session id to the durable row and the
// native identity needed by an explicit managed resume.
func LookupHookSession(sessionID string) (SessionState, string, error) {
	store := newHookReportStore("")
	reg, err := store.loadRegistry()
	if err != nil {
		return SessionState{}, "", err
	}
	for _, record := range reg.Sessions {
		if record.Row.SessionID == sessionID {
			return record.Row, record.NativeID, nil
		}
	}
	return SessionState{}, "", fmt.Errorf("session %q was not found in the durable hook registry", sessionID)
}

func QueueHookReport(body []byte) (HookQueueReceipt, error) {
	if len(body) == 0 {
		return HookQueueReceipt{}, errors.New("hook report is empty")
	}
	if len(body) > MaxHookReportBytes {
		return HookQueueReceipt{}, fmt.Errorf("hook report is %d bytes, over the %d-byte limit", len(body), MaxHookReportBytes)
	}
	if !utf8.Valid(body) {
		return HookQueueReceipt{}, errors.New("hook report must be UTF-8")
	}
	reportID := uuid.New().String()
	dir := filepath.Join(HookReportRoot(), "inbox")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return HookQueueReceipt{}, fmt.Errorf("create hook inbox: %w", err)
	}
	tmp := filepath.Join(dir, "."+reportID+".tmp")
	path := filepath.Join(dir, reportID+".json")
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return HookQueueReceipt{}, fmt.Errorf("create hook report: %w", err)
	}
	remove := true
	defer func() {
		_ = f.Close()
		if remove {
			_ = os.Remove(tmp)
		}
	}()
	if _, err := f.Write(body); err != nil {
		return HookQueueReceipt{}, fmt.Errorf("write hook report: %w", err)
	}
	if err := f.Sync(); err != nil {
		return HookQueueReceipt{}, fmt.Errorf("sync hook report: %w", err)
	}
	if err := f.Close(); err != nil {
		return HookQueueReceipt{}, fmt.Errorf("close hook report: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return HookQueueReceipt{}, fmt.Errorf("publish hook report: %w", err)
	}
	remove = false
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return HookQueueReceipt{Status: "queued", ReportID: reportID}, nil
}

func NewCodexCompletionReport(row SessionState, nativeID, eventID, turnID string, pid int) HookReport {
	project, name, mode, state, doing, summary := row.Project, row.Name, row.Mode, row.State, row.Doing, row.Summary
	start, _ := processStartTime(pid)
	sid, _ := processSessionID(pid)
	return HookReport{
		V: HookReportVersion, Harness: HarnessCodex, NativeSessionID: nativeID,
		NativeEvent: "agent-turn-complete", Event: "turn.completed", EventID: eventID,
		TurnID: turnID, ObservedAt: time.Now().UTC(), Process: &HookProcess{PID: pid, PIDStart: start, SID: sid},
		Set: HookPatch{Project: &project, Name: &name, Mode: &mode, State: &state, Doing: &doing, Summary: &summary},
	}
}

func (r HookReport) JSON() ([]byte, error) { return json.Marshal(r) }

func newHookReportStore(installationID string) *hookReportStore {
	return &hookReportStore{root: HookReportRoot(), installationID: installationID}
}

func (s *hookReportStore) consume() {
	dir := filepath.Join(s.root, "inbox")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	type queued struct {
		reportID string
		path     string
		report   HookReport
	}
	queue := make([]queued, 0, len(entries))
	for _, entry := range entries {
		if !entry.Type().IsRegular() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		reportID := strings.TrimSuffix(entry.Name(), ".json")
		path := filepath.Join(dir, entry.Name())
		body, err := os.ReadFile(path)
		if err != nil || len(body) > MaxHookReportBytes {
			continue
		}
		report, err := decodeHookReport(body)
		if err != nil {
			s.reject(reportID, report, err)
			_ = os.Remove(path)
			continue
		}
		queue = append(queue, queued{reportID: reportID, path: path, report: report})
	}
	// Producers publish through independent short-lived hook processes, and
	// UUID filenames contain no causal order. Applying a randomly ordered batch
	// can let SessionEnd make earlier tool/plan reports look stale. The native
	// observation timestamp is required by the envelope, so order the complete
	// durable batch before mutating the single-writer registry.
	sort.SliceStable(queue, func(i, j int) bool {
		return queue[i].report.ObservedAt.Before(queue[j].report.ObservedAt)
	})
	for _, item := range queue {
		if err := s.accept(item.reportID, item.report); err != nil {
			s.reject(item.reportID, item.report, err)
		}
		_ = os.Remove(item.path)
	}
}

func decodeHookReport(body []byte) (HookReport, error) {
	var report HookReport
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&report); err != nil {
		return report, fmt.Errorf("invalid JSON envelope: %w", err)
	}
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return report, errors.New("invalid JSON envelope: multiple values")
	}
	if report.V != HookReportVersion {
		return report, fmt.Errorf("unsupported hook report version %d", report.V)
	}
	if report.Harness != HarnessCodex && report.Harness != HarnessClaude && report.Harness != HarnessAmplifier {
		return report, fmt.Errorf("unsupported harness %q", report.Harness)
	}
	if report.NativeSessionID == "" || report.NativeEvent == "" || report.EventID == "" || report.ObservedAt.IsZero() {
		return report, errors.New("native_session_id, native_event, event_id, and observed_at are required")
	}
	allowed := map[string]bool{"session.started": true, "session.ended": true, "turn.started": true, "turn.completed": true, "turn.failed": true, "turn.interrupted": true, "tool.started": true, "tool.completed": true, "tool.failed": true, "attention.required": true, "attention.resolved": true, "progress.updated": true, "context.read": true, "metadata.updated": true}
	if !allowed[report.Event] {
		return report, fmt.Errorf("unsupported normalized event %q", report.Event)
	}
	if len(report.EventID) > 256 || len(report.NativeSessionID) > 256 {
		return report, errors.New("native_session_id and event_id are limited to 256 bytes")
	}
	for _, field := range report.Clear {
		switch field {
		case "project", "label", "waiting_for", "doing", "summary", "done_means", "todo", "knows":
		default:
			return report, fmt.Errorf("unsupported clear field %q", field)
		}
	}
	return report, nil
}

func (s *hookReportStore) accept(reportID string, report HookReport) error {
	reg, err := s.loadRegistry()
	if err != nil {
		return err
	}
	eventKey := report.Harness + "\x00" + report.NativeSessionID + "\x00" + report.EventID
	if sessionID := reg.Events[eventKey]; sessionID != "" {
		return s.writeReceipt(hookReceipt{Status: "accepted", ReportID: reportID, SessionID: sessionID, At: time.Now().UTC()})
	}
	alias := report.Harness + "\x00" + report.NativeSessionID
	record, found := reg.Sessions[alias]
	if !found {
		sessionID := report.Harness + "-" + report.NativeSessionID
		if !ValidSessionID(sessionID) {
			sessionID = report.Harness + "-" + uuid.NewSHA1(uuid.NameSpaceOID, []byte(report.NativeSessionID)).String()
		}
		record = sessionRecord{InstallationID: s.installationID, Harness: report.Harness, NativeID: report.NativeSessionID,
			Row: SessionState{SessionID: sessionID, Harness: report.Harness, Name: report.NativeSessionID, Mode: ModeInteractive, State: SessionStateWorking}}
	}
	if !record.LastObservedAt.IsZero() && report.ObservedAt.Before(record.LastObservedAt) {
		reg.Events[eventKey] = record.Row.SessionID
		if err := s.saveRegistry(reg); err != nil {
			return err
		}
		return s.writeReceipt(hookReceipt{Status: "accepted", ReportID: reportID, SessionID: record.Row.SessionID, At: time.Now().UTC()})
	}
	if report.Set.Name != nil && report.NativeEvent == "UserPromptSubmit" && record.Row.Name != "" && record.Row.Name != report.NativeSessionID {
		report.Set.Name = nil // the first prompt names the session; later turns do not rename it
	}
	applyHookPatch(&record.Row, report.Set, report.Clear)
	record.Row.ExecutionID = report.RunID
	if record.Row.ExecutionID == "" {
		record.Row.ExecutionID = report.NativeSessionID
	}
	if report.TurnID != "" {
		record.Row.TurnID = report.TurnID
	} else if report.Set.State != nil && sessionStateIsTerminal(*report.Set.State) {
		// Amplifier currently reports whole-state transitions without a native
		// turn id. Its ingress event id is still a durable per-transition anchor.
		record.Row.TurnID = report.EventID
	}
	record.LastObservedAt = report.ObservedAt
	record.Row.Harness = report.Harness
	record.Row.Reporting = "reporting"
	if report.Harness == HarnessCodex && report.NativeEvent == "agent-turn-complete" {
		record.Row.Reporting = "completion-only"
	}
	record.Row.ReportingError = ""
	record.Row.LastReportAt = report.ObservedAt.Unix()
	record.Row.UpdatedAt = report.ObservedAt.Unix()
	if report.Process != nil {
		record.PID = report.Process.PID
		record.PIDStart = report.Process.PIDStart
		record.SID = report.Process.SID
	}
	if record.Row.Name == "" {
		record.Row.Name = report.NativeSessionID
	}
	if !ValidMode(record.Row.Mode) || !ValidState(record.Row.State) || !ValidWaitingFor(record.Row.WaitingFor) {
		return errors.New("set contains an invalid mode, state, or waiting_for value")
	}
	reg.Sessions[alias] = record
	reg.Events[eventKey] = record.Row.SessionID
	if err := s.saveRegistry(reg); err != nil {
		return err
	}
	if err := s.project(record); err != nil {
		return err
	}
	return s.writeReceipt(hookReceipt{Status: "accepted", ReportID: reportID, SessionID: record.Row.SessionID, At: time.Now().UTC()})
}

func applyHookPatch(row *SessionState, set HookPatch, clear []string) {
	if set.Project != nil {
		row.Project = *set.Project
	}
	if set.Name != nil {
		row.Name = *set.Name
	}
	if set.Label != nil {
		row.Label = *set.Label
	}
	if set.Mode != nil {
		row.Mode = *set.Mode
	}
	if set.State != nil {
		row.State = *set.State
	}
	if set.WaitingFor != nil {
		row.WaitingFor = *set.WaitingFor
	}
	if set.Doing != nil {
		row.Doing = *set.Doing
	}
	if set.Summary != nil {
		row.Summary = *set.Summary
	}
	if set.DoneMeans != nil {
		row.DoneMeans = *set.DoneMeans
	}
	if set.Coverage != nil {
		row.ReportingCoverage = *set.Coverage
	}
	if set.Todo != nil {
		todo := *set.Todo
		row.Todo = &todo
	}
	if set.Knows != nil {
		row.Knows = append([]string(nil), (*set.Knows)...)
	}
	for _, field := range clear {
		switch field {
		case "project":
			row.Project = ""
		case "label":
			row.Label = ""
		case "waiting_for":
			row.WaitingFor = ""
		case "doing":
			row.Doing = ""
		case "summary":
			row.Summary = ""
		case "done_means":
			row.DoneMeans = ""
		case "todo":
			row.Todo = nil
		case "knows":
			row.Knows = nil
		}
	}
}

func (s *hookReportStore) reject(reportID string, report HookReport, cause error) {
	reg, err := s.loadRegistry()
	if err == nil {
		id := "report-" + reportID
		alias := "rejected\x00" + reportID
		reg.Sessions[alias] = sessionRecord{InstallationID: s.installationID, Harness: report.Harness, NativeID: report.NativeSessionID,
			Row: SessionState{SessionID: id, Harness: report.Harness, Name: "Session report rejected", Mode: ModeInteractive, State: SessionStateFailed, Doing: cause.Error(), Reporting: "rejected", ReportingError: cause.Error(), LastReportAt: time.Now().Unix(), UpdatedAt: time.Now().Unix()}}
		_ = s.saveRegistry(reg)
		_ = s.project(reg.Sessions[alias])
	}
	_ = s.writeReceipt(hookReceipt{Status: "rejected", ReportID: reportID, Error: cause.Error(), At: time.Now().UTC()})
}

func (s *hookReportStore) projectAll() {
	reg, err := s.loadRegistry()
	if err != nil {
		return
	}
	for _, record := range reg.Sessions {
		_ = s.project(record)
	}
}

func (s *hookReportStore) project(record sessionRecord) error {
	pid := record.PID
	if pid <= 0 {
		pid = os.Getpid()
	}
	_, err := writeSessionSnapshot(record.Row, pid, record.PIDStart, record.SID)
	return err
}

func (s *hookReportStore) loadRegistry() (sessionRegistry, error) {
	reg := sessionRegistry{V: 1, Sessions: map[string]sessionRecord{}, Events: map[string]string{}}
	body, err := os.ReadFile(filepath.Join(s.root, "registry.json"))
	if errors.Is(err, os.ErrNotExist) {
		return reg, nil
	}
	if err != nil {
		return reg, fmt.Errorf("read session registry: %w", err)
	}
	if err := json.Unmarshal(body, &reg); err != nil {
		return reg, fmt.Errorf("parse session registry: %w", err)
	}
	if reg.V != 1 {
		return reg, fmt.Errorf("unsupported session registry version %d", reg.V)
	}
	if reg.Sessions == nil {
		reg.Sessions = map[string]sessionRecord{}
	}
	if reg.Events == nil {
		reg.Events = map[string]string{}
	}
	return reg, nil
}

func (s *hookReportStore) saveRegistry(reg sessionRegistry) error {
	if err := os.MkdirAll(s.root, 0o700); err != nil {
		return err
	}
	body, err := json.Marshal(reg)
	if err != nil {
		return err
	}
	return atomicfile.Write(filepath.Join(s.root, "registry.json"), body, 0o600)
}

func (s *hookReportStore) writeReceipt(receipt hookReceipt) error {
	dir := filepath.Join(s.root, "receipts")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	body, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	return atomicfile.Write(filepath.Join(dir, receipt.ReportID+".json"), body, 0o600)
}
