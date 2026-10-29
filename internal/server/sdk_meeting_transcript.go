package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type meetingSegment struct {
	ID      string `json:"id"`
	StartMs int64  `json:"startMs"`
	EndMs   int64  `json:"endMs"`
	Text    string `json:"text"`
	Speaker string `json:"speaker"`
}

type meetingTranscript struct {
	Revision    int64             `json:"revision"`
	Segments    []meetingSegment  `json:"segments"`
	Corrections map[string]string `json:"corrections"`
}

func transcriptPath(chatID, meetingID string) string {
	return filepath.Join(meetingDir(chatID, meetingID), "transcript.json")
}

func readMeetingTranscript(chatID, meetingID string) (meetingTranscript, error) {
	data, err := os.ReadFile(transcriptPath(chatID, meetingID))
	if err != nil {
		return meetingTranscript{}, err
	}
	var transcript meetingTranscript
	err = json.Unmarshal(data, &transcript)
	return transcript, err
}

func writeMeetingTranscript(chatID, meetingID string, transcript meetingTranscript) error {
	data, err := json.Marshal(transcript)
	if err != nil {
		return err
	}
	return writeUtilityPages(transcriptPath(chatID, meetingID), data)
}

func (s *Server) handleSDKMeetingTranscript(w http.ResponseWriter, r *http.Request) {
	chatID, meetingID, ok := s.meetingLocation(w, r)
	if !ok {
		return
	}
	lock := s.pageDocumentLock("meeting-" + chatID)
	lock.Lock()
	defer lock.Unlock()
	meeting, err := readMeeting(chatID, meetingID)
	if errors.Is(err, os.ErrNotExist) {
		http.Error(w, "Meeting not found", 404)
		return
	}
	if err != nil {
		http.Error(w, "Cannot read meeting", 500)
		return
	}
	transcript, err := readMeetingTranscript(chatID, meetingID)
	if errors.Is(err, os.ErrNotExist) {
		http.Error(w, "Transcript not ready", 409)
		return
	}
	if err != nil {
		http.Error(w, "Cannot read transcript", 500)
		return
	}
	if r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, transcript)
		return
	}
	if meeting.TranscriptState != "ready" {
		http.Error(w, "Transcript not ready", 409)
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		http.Error(w, "Correction too large", 413)
		return
	}
	var input struct {
		Revision    int64             `json:"revision"`
		Corrections map[string]string `json:"corrections"`
	}
	if json.Unmarshal(data, &input) != nil || input.Corrections == nil {
		http.Error(w, "Invalid correction", 400)
		return
	}
	if input.Revision != transcript.Revision {
		http.Error(w, "Transcript changed elsewhere", 409)
		return
	}
	known := make(map[string]bool, len(transcript.Segments))
	for _, segment := range transcript.Segments {
		known[segment.ID] = true
	}
	for id, text := range input.Corrections {
		if !known[id] || len(text) > 10000 {
			http.Error(w, "Invalid corrected segment", 400)
			return
		}
	}
	transcript.Corrections = input.Corrections
	transcript.Revision++
	if err := writeMeetingTranscript(chatID, meetingID, transcript); err != nil {
		http.Error(w, "Cannot save correction", 500)
		return
	}
	writeJSON(w, http.StatusOK, transcript)
}

func vttTime(ms int64) string {
	seconds := ms / 1000
	return fmt.Sprintf("%02d:%02d:%02d.%03d", seconds/3600, (seconds/60)%60, seconds%60, ms%1000)
}

func (s *Server) handleSDKMeetingTranscriptExport(w http.ResponseWriter, r *http.Request) {
	chatID, meetingID, ok := s.meetingLocation(w, r)
	if !ok {
		return
	}
	lock := s.pageDocumentLock("meeting-" + chatID)
	lock.Lock()
	transcript, err := readMeetingTranscript(chatID, meetingID)
	lock.Unlock()
	if errors.Is(err, os.ErrNotExist) {
		http.Error(w, "Transcript not ready", 409)
		return
	}
	if err != nil {
		http.Error(w, "Cannot read transcript", 500)
		return
	}
	w.Header().Set("Content-Type", "text/vtt; charset=utf-8")
	w.Header().Set("Content-Disposition", "attachment; filename=meeting-"+meetingID+".vtt")
	_, _ = io.WriteString(w, "WEBVTT\n\n")
	for _, segment := range transcript.Segments {
		text := segment.Text
		if correction, exists := transcript.Corrections[segment.ID]; exists {
			text = correction
		}
		_, _ = fmt.Fprintf(w, "%s --> %s\n%s: %s\n\n", vttTime(segment.StartMs), vttTime(segment.EndMs), segment.Speaker, strings.ReplaceAll(text, "\n", " "))
	}
}

func (s *Server) handleSDKMeetingTranscribe(w http.ResponseWriter, r *http.Request) {
	chatID, meetingID, ok := s.meetingLocation(w, r)
	if !ok {
		return
	}
	meeting, ctx, status, message := s.queueMeetingTranscription(chatID, meetingID)
	if status != 0 {
		http.Error(w, message, status)
		return
	}
	go func() {
		defer s.meetingJobs.Done()
		s.runMeetingTranscription(ctx, chatID, meetingID)
	}()
	writeJSON(w, http.StatusAccepted, meeting)
}

func (s *Server) queueMeetingTranscription(chatID, meetingID string) (sdkMeeting, context.Context, int, string) {
	lock := s.pageDocumentLock("meeting-" + chatID)
	lock.Lock()
	defer lock.Unlock()
	meeting, err := readMeeting(chatID, meetingID)
	if errors.Is(err, os.ErrNotExist) {
		return sdkMeeting{}, nil, 404, "Meeting not found"
	}
	if err != nil {
		return sdkMeeting{}, nil, 500, "Cannot read meeting"
	}
	if meeting.TranscriptState == "queued" || meeting.TranscriptState == "processing" {
		if _, active := s.meetingTranscriptions.Load(meetingID); !active {
			meeting.TranscriptState = "failed"
			meeting.TranscriptError = "Transcription stopped before completion; retry it."
			if err := saveMeeting(meeting); err != nil {
				return sdkMeeting{}, nil, 500, "Cannot recover transcription state"
			}
		}
	}
	if meeting.RecordingState != "ready" || (meeting.TranscriptState != "not_started" && meeting.TranscriptState != "failed") {
		return sdkMeeting{}, nil, 409, "Transcription unavailable in current state"
	}
	meeting.TranscriptState = "queued"
	meeting.TranscriptError = ""
	if err := saveMeeting(meeting); err != nil {
		return sdkMeeting{}, nil, 500, "Cannot queue transcription"
	}
	parent := s.meetingJobContext
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithTimeout(parent, 30*time.Minute)
	s.meetingTranscriptions.Store(meetingID, cancel)
	s.meetingJobs.Add(1)
	return meeting, ctx, 0, ""
}

func (s *Server) runMeetingTranscription(ctx context.Context, chatID, meetingID string) {
	defer func() {
		if value, ok := s.meetingTranscriptions.LoadAndDelete(meetingID); ok {
			value.(context.CancelFunc)()
		}
	}()
	lock := s.pageDocumentLock("meeting-" + chatID)
	setState := func(state, errorText string) {
		lock.Lock()
		defer lock.Unlock()
		meeting, err := readMeeting(chatID, meetingID)
		if err != nil {
			return
		}
		meeting.TranscriptState = state
		meeting.TranscriptError = errorText
		_ = saveMeeting(meeting)
	}
	setState("processing", "")
	dir := meetingDir(chatID, meetingID)
	input := filepath.Join(dir, "original.media")
	wav := filepath.Join(dir, "transcription-input.wav")
	output := filepath.Join(dir, "transcription-output.json")
	defer os.Remove(wav)
	defer os.Remove(output)
	transcriber := os.Getenv("MUXTERM_MEETING_TRANSCRIBER")
	if transcriber == "" {
		setState("failed", "Local transcription is not configured. Set MUXTERM_MEETING_TRANSCRIBER to a self-hosted executable.")
		return
	}
	convert := exec.CommandContext(ctx, "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", input, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav)
	if log, err := convert.CombinedOutput(); err != nil {
		setState("failed", fmt.Sprintf("Audio conversion failed: %v: %s", err, strings.TrimSpace(string(log))))
		return
	}
	command := exec.CommandContext(ctx, transcriber, wav, output)
	command.Dir = dir
	if log, err := command.CombinedOutput(); err != nil {
		setState("failed", fmt.Sprintf("Local transcriber failed: %v: %s", err, strings.TrimSpace(string(log))))
		return
	}
	info, err := os.Stat(output)
	if err != nil || info.Size() > 10<<20 {
		setState("failed", "Local transcriber did not produce a valid bounded JSON file.")
		return
	}
	data, err := os.ReadFile(output)
	if err != nil || len(data) > 10<<20 {
		setState("failed", "Local transcriber did not produce a valid bounded JSON file.")
		return
	}
	var result struct {
		Segments []meetingSegment `json:"segments"`
	}
	if json.Unmarshal(data, &result) != nil || len(result.Segments) == 0 || len(result.Segments) > 10000 {
		setState("failed", "Local transcriber returned no valid segments.")
		return
	}
	sort.Slice(result.Segments, func(i, j int) bool { return result.Segments[i].StartMs < result.Segments[j].StartMs })
	for i := range result.Segments {
		segment := &result.Segments[i]
		if segment.StartMs < 0 || segment.EndMs <= segment.StartMs || len(segment.Text) == 0 || len(segment.Text) > 10000 {
			setState("failed", "Local transcriber returned an invalid segment.")
			return
		}
		segment.ID = sdkID()
		// The saved recording is a mixed track. It cannot prove who spoke.
		segment.Speaker = "Unknown speaker"
	}
	transcript := meetingTranscript{Revision: 1, Segments: result.Segments, Corrections: map[string]string{}}
	lock.Lock()
	meeting, readErr := readMeeting(chatID, meetingID)
	if readErr != nil || ctx.Err() != nil {
		lock.Unlock()
		return
	}
	err = writeMeetingTranscript(chatID, meetingID, transcript)
	if err == nil {
		meeting.TranscriptState = "ready"
		meeting.TranscriptError = ""
		err = saveMeeting(meeting)
	}
	lock.Unlock()
	if err != nil {
		setState("failed", "Cannot save transcript: "+err.Error())
	}
}

func (s *Server) handleSDKMeetingNote(w http.ResponseWriter, r *http.Request) {
	chatID, meetingID, ok := s.meetingLocation(w, r)
	if !ok {
		return
	}
	meetingLock := s.pageDocumentLock("meeting-" + chatID)
	meetingLock.Lock()
	defer meetingLock.Unlock()
	meeting, err := readMeeting(chatID, meetingID)
	if errors.Is(err, os.ErrNotExist) {
		http.Error(w, "Meeting not found", 404)
		return
	}
	if err != nil {
		http.Error(w, "Cannot read meeting", 500)
		return
	}
	if meeting.TranscriptState != "ready" {
		http.Error(w, "Transcript not ready", 409)
		return
	}
	if meeting.LinkedNoteID != "" {
		writeJSON(w, http.StatusOK, map[string]any{"note_id": meeting.LinkedNoteID})
		return
	}
	transcript, err := readMeetingTranscript(chatID, meetingID)
	if err != nil {
		http.Error(w, "Cannot read transcript", 500)
		return
	}
	pageLock := s.pageDocumentLock(chatID)
	pageLock.Lock()
	defer pageLock.Unlock()
	path := filepath.Join(sdkDataDir(), "pages", chatID+".json")
	doc, err := readUtilityPages(path)
	if err != nil {
		http.Error(w, "Cannot read notes", 500)
		return
	}
	for _, existing := range doc.Pages {
		if existing.LinkedMeetingID == meetingID {
			meeting.LinkedNoteID = existing.ID
			_ = saveMeeting(meeting)
			writeJSON(w, http.StatusOK, map[string]any{"note_id": existing.ID})
			return
		}
	}
	if len(doc.Pages) >= 100 {
		http.Error(w, "Too many notes", 413)
		return
	}
	content := []map[string]any{plainNoteParagraph("Meeting: " + meeting.Title + " · " + meeting.StartedAt)}
	for _, segment := range transcript.Segments {
		text := segment.Text
		if correction, exists := transcript.Corrections[segment.ID]; exists {
			text = correction
		}
		content = append(content, plainNoteParagraph(fmt.Sprintf("[%s] %s: %s", vttTime(segment.StartMs), segment.Speaker, text)))
	}
	if len(content) > 500 {
		http.Error(w, "Transcript too long for one note", 413)
		return
	}
	encoded, _ := json.Marshal(content)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	note := utilityPage{ID: sdkID(), Title: "Meeting: " + meeting.Title, Blocks: []utilityPageBlock{}, Content: encoded, CreatedAt: now, UpdatedAt: now, Revision: 1, LinkedMeetingID: meetingID}
	doc.Pages = append(doc.Pages, note)
	doc.Version++
	data, err := json.Marshal(doc)
	if err != nil || len(data) > 1<<20 {
		http.Error(w, "Notes too large", 413)
		return
	}
	if err := writeUtilityPages(path, data); err != nil {
		http.Error(w, "Cannot save linked note", 500)
		return
	}
	meeting.LinkedNoteID = note.ID
	if err := saveMeeting(meeting); err != nil {
		http.Error(w, "Cannot link meeting note", 500)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"note_id": note.ID})
}
