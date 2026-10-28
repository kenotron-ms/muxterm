package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type sdkMeeting struct {
	ID              string   `json:"id"`
	ChatID          string   `json:"chatId"`
	Title           string   `json:"title"`
	Kind            string   `json:"kind"`
	StartedAt       string   `json:"startedAt"`
	EndedAt         string   `json:"endedAt,omitempty"`
	Participants    []string `json:"participants"`
	RecordingState  string   `json:"recordingState"`
	TranscriptState string   `json:"transcriptState"`
	MediaType       string   `json:"mediaType,omitempty"`
	MediaBytes      int64    `json:"mediaBytes"`
	Chunks          int      `json:"chunks"`
	LastChunkAt     string   `json:"lastChunkAt,omitempty"`
	Error           string   `json:"error,omitempty"`
	TranscriptError string   `json:"transcriptError,omitempty"`
	LinkedNoteID    string   `json:"linkedNoteId,omitempty"`
}

func (s *Server) meetingLocation(w http.ResponseWriter, r *http.Request) (string, string, bool) {
	chatID, meetingID := r.PathValue("id"), r.PathValue("meetingID")
	if !safePageID(chatID) || (meetingID != "" && !safePageID(meetingID)) {
		http.Error(w, "Meeting not found", http.StatusNotFound)
		return "", "", false
	}
	s.sdkChats.mu.Lock()
	exists := s.sdkChats.chats[chatID] != nil
	s.sdkChats.mu.Unlock()
	if !exists {
		http.Error(w, "Chat not found", http.StatusNotFound)
		return "", "", false
	}
	return chatID, meetingID, true
}

func meetingRoot(chatID string) string { return filepath.Join(sdkDataDir(), "meetings", chatID) }
func meetingDir(chatID, meetingID string) string {
	return filepath.Join(meetingRoot(chatID), meetingID)
}

func readMeeting(chatID, meetingID string) (sdkMeeting, error) {
	data, err := os.ReadFile(filepath.Join(meetingDir(chatID, meetingID), "meeting.json"))
	if err != nil {
		return sdkMeeting{}, err
	}
	var meeting sdkMeeting
	err = json.Unmarshal(data, &meeting)
	if err == nil && (meeting.ID != meetingID || meeting.ChatID != chatID) {
		err = errors.New("invalid stored meeting")
	}
	return meeting, err
}

func saveMeeting(meeting sdkMeeting) error {
	dir := meetingDir(meeting.ChatID, meeting.ID)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(meeting, "", "  ")
	if err != nil {
		return err
	}
	return writeUtilityPages(filepath.Join(dir, "meeting.json"), data)
}

func meetingState(meeting sdkMeeting) sdkMeeting {
	if meeting.RecordingState == "recording" {
		last := meeting.StartedAt
		if meeting.LastChunkAt != "" {
			last = meeting.LastChunkAt
		}
		seen, err := time.Parse(time.RFC3339Nano, last)
		if err == nil && time.Since(seen) > 20*time.Second {
			meeting.RecordingState = "interrupted"
			meeting.Error = "Capture stopped before finalization. Saved chunks can still be finalized."
		}
	}
	return meeting
}

func (s *Server) handleSDKMeetings(w http.ResponseWriter, r *http.Request) {
	chatID, _, ok := s.meetingLocation(w, r)
	if !ok {
		return
	}
	lock := s.pageDocumentLock("meeting-" + chatID)
	lock.Lock()
	defer lock.Unlock()
	if r.Method == http.MethodGet {
		entries, err := os.ReadDir(meetingRoot(chatID))
		if errors.Is(err, os.ErrNotExist) {
			writeJSON(w, http.StatusOK, []sdkMeeting{})
			return
		}
		if err != nil {
			http.Error(w, "Cannot list meetings", 500)
			return
		}
		meetings := make([]sdkMeeting, 0, len(entries))
		for _, entry := range entries {
			if !entry.IsDir() || !safePageID(entry.Name()) {
				continue
			}
			meeting, err := readMeeting(chatID, entry.Name())
			if err == nil {
				meetings = append(meetings, meetingState(meeting))
			}
		}
		writeJSON(w, http.StatusOK, meetings)
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 4096))
	if err != nil {
		http.Error(w, "Meeting request too large", 413)
		return
	}
	var input struct {
		Title     string `json:"title"`
		Kind      string `json:"kind"`
		MediaType string `json:"mediaType"`
	}
	if json.Unmarshal(data, &input) != nil || len(input.Title) > 300 || (input.Kind != "recording" && input.Kind != "call") || !validMeetingMediaType(input.MediaType) {
		http.Error(w, "Invalid meeting", 400)
		return
	}
	if input.Kind == "call" {
		if _, reason := s.meetingInviteOrigin(); reason != "" {
			http.Error(w, reason, http.StatusConflict)
			return
		}
	}
	if strings.TrimSpace(input.Title) == "" {
		input.Title = "Quick recording"
	}
	meeting := sdkMeeting{ID: sdkID(), ChatID: chatID, Title: input.Title, Kind: input.Kind, StartedAt: time.Now().UTC().Format(time.RFC3339Nano), Participants: []string{"You"}, RecordingState: "recording", TranscriptState: "not_started", MediaType: input.MediaType}
	if input.Kind == "call" {
		meeting.RecordingState = "not_started"
	}
	if err := saveMeeting(meeting); err != nil {
		http.Error(w, "Cannot create meeting", 500)
		return
	}
	writeJSON(w, http.StatusCreated, meeting)
}

func validMeetingMediaType(value string) bool {
	switch value {
	case "", "audio/webm", "audio/webm;codecs=opus", "audio/ogg", "audio/mp4", "video/webm", "video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/mp4":
		return true
	}
	return false
}

func (s *Server) handleSDKMeeting(w http.ResponseWriter, r *http.Request) {
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
	if r.Method == http.MethodDelete {
		if err := os.RemoveAll(meetingDir(chatID, meetingID)); err != nil {
			http.Error(w, "Cannot delete meeting", 500)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(w, http.StatusOK, meetingState(meeting))
}

func (s *Server) handleSDKMeetingChunk(w http.ResponseWriter, r *http.Request) {
	chatID, meetingID, ok := s.meetingLocation(w, r)
	if !ok {
		return
	}
	index, err := strconv.Atoi(r.URL.Query().Get("index"))
	if err != nil || index < 0 {
		http.Error(w, "Invalid chunk index", 400)
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
	if meeting.RecordingState != "recording" && meeting.RecordingState != "interrupted" {
		http.Error(w, "Meeting is not recording", 409)
		return
	}
	if index != meeting.Chunks {
		http.Error(w, fmt.Sprintf("Expected chunk %d", meeting.Chunks), 409)
		return
	}
	chunk, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 10<<20))
	if err != nil || len(chunk) == 0 {
		http.Error(w, "Empty or oversized media chunk", 413)
		return
	}
	if meeting.MediaBytes+int64(len(chunk)) > 1<<30 {
		http.Error(w, "Recording exceeds 1 GiB", 413)
		return
	}
	name := filepath.Join(meetingDir(chatID, meetingID), fmt.Sprintf("chunk-%08d", index))
	if err := os.WriteFile(name, chunk, 0600); err != nil {
		http.Error(w, "Cannot save media chunk", 500)
		return
	}
	meeting.Chunks++
	meeting.MediaBytes += int64(len(chunk))
	meeting.LastChunkAt = time.Now().UTC().Format(time.RFC3339Nano)
	meeting.RecordingState = "recording"
	meeting.Error = ""
	if err := saveMeeting(meeting); err != nil {
		http.Error(w, "Cannot save recording state", 500)
		return
	}
	writeJSON(w, http.StatusOK, meeting)
}

func (s *Server) handleSDKMeetingFinish(w http.ResponseWriter, r *http.Request) {
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
	if meeting.RecordingState == "ready" {
		writeJSON(w, http.StatusOK, meeting)
		return
	}
	if meeting.Chunks == 0 {
		http.Error(w, "No media was captured", 409)
		return
	}
	dir := meetingDir(chatID, meetingID)
	temp, err := os.CreateTemp(dir, ".media-*")
	if err != nil {
		http.Error(w, "Cannot finalize recording", 500)
		return
	}
	defer os.Remove(temp.Name())
	defer temp.Close()
	for i := 0; i < meeting.Chunks; i++ {
		chunk, err := os.Open(filepath.Join(dir, fmt.Sprintf("chunk-%08d", i)))
		if err != nil {
			http.Error(w, "Recording chunk missing", 500)
			return
		}
		_, copyErr := io.Copy(temp, chunk)
		_ = chunk.Close()
		if copyErr != nil {
			http.Error(w, "Cannot finalize recording", 500)
			return
		}
	}
	if err := temp.Chmod(0600); err != nil {
		http.Error(w, "Cannot finalize recording", 500)
		return
	}
	if err := temp.Sync(); err != nil {
		http.Error(w, "Cannot finalize recording", 500)
		return
	}
	if err := temp.Close(); err != nil {
		http.Error(w, "Cannot finalize recording", 500)
		return
	}
	if err := os.Rename(temp.Name(), filepath.Join(dir, "original.media")); err != nil {
		http.Error(w, "Cannot finalize recording", 500)
		return
	}
	meeting.RecordingState = "ready"
	if meeting.Kind == "recording" {
		meeting.EndedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	meeting.Error = ""
	if err := saveMeeting(meeting); err != nil {
		http.Error(w, "Cannot save meeting state", 500)
		return
	}
	writeJSON(w, http.StatusOK, meeting)
}

func (s *Server) handleSDKMeetingRecordStart(w http.ResponseWriter, r *http.Request) {
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
	if meeting.Kind != "call" || meeting.EndedAt != "" || meeting.RecordingState != "not_started" {
		http.Error(w, "Call cannot start recording", 409)
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1024))
	if err != nil {
		http.Error(w, "Invalid media type", 400)
		return
	}
	var input struct {
		MediaType string `json:"mediaType"`
	}
	if json.Unmarshal(data, &input) != nil || !validMeetingMediaType(input.MediaType) || !strings.HasPrefix(input.MediaType, "video/") {
		http.Error(w, "Invalid video recording format", 400)
		return
	}
	meeting.MediaType = input.MediaType
	meeting.RecordingState = "recording"
	if err := saveMeeting(meeting); err != nil {
		http.Error(w, "Cannot save recording state", 500)
		return
	}
	writeJSON(w, http.StatusOK, meeting)
}

func (s *Server) handleSDKMeetingEnd(w http.ResponseWriter, r *http.Request) {
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
	if meeting.Kind != "call" {
		http.Error(w, "Not a call meeting", 400)
		return
	}
	if meeting.EndedAt == "" {
		meeting.EndedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	if meeting.RecordingState == "recording" {
		meeting.RecordingState = "interrupted"
		meeting.Error = "Call ended before recording finalized. Recover saved media."
	}
	if err := saveMeeting(meeting); err != nil {
		http.Error(w, "Cannot end meeting", 500)
		return
	}
	writeJSON(w, http.StatusOK, meeting)
}

func (s *Server) handleSDKMeetingMedia(w http.ResponseWriter, r *http.Request) {
	chatID, meetingID, ok := s.meetingLocation(w, r)
	if !ok {
		return
	}
	meeting, err := readMeeting(chatID, meetingID)
	if errors.Is(err, os.ErrNotExist) {
		http.Error(w, "Meeting not found", 404)
		return
	}
	if err != nil {
		http.Error(w, "Cannot read meeting", 500)
		return
	}
	if meeting.RecordingState != "ready" {
		http.Error(w, "Recording not finalized", 409)
		return
	}
	w.Header().Set("Content-Type", meeting.MediaType)
	w.Header().Set("Content-Disposition", "inline; filename=meeting-"+meetingID+".webm")
	http.ServeFile(w, r, filepath.Join(meetingDir(chatID, meetingID), "original.media"))
}
