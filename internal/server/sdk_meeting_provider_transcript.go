package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	muxcfg "github.com/kenotron-ms/muxterm/internal/config"
	"github.com/kenotron-ms/muxterm/internal/voice"
)

type meetingTranscriptionOptions struct {
	LocalReady     bool   `json:"localReady"`
	LocalDetail    string `json:"localDetail"`
	ProviderReady  bool   `json:"providerReady"`
	ProviderName   string `json:"providerName"`
	ProviderModel  string `json:"providerModel"`
	ProviderDetail string `json:"providerDetail"`
}

type meetingVoiceTarget struct {
	config muxcfg.VoiceConfig
	model  string
	name   string
}

func (s *Server) meetingVoiceTarget() (meetingVoiceTarget, error) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		return meetingVoiceTarget{}, errors.New("Install ffmpeg on the Muxterm server before transcribing meetings")
	}
	cfg := s.voiceConfigOnDisk()
	if !cfg.Enabled {
		return meetingVoiceTarget{}, errors.New("Enable and save Voice in Settings before using its provider for meeting transcription")
	}
	if err := cfg.Validate(); err != nil {
		return meetingVoiceTarget{}, errors.New("Finish the Voice settings before using provider transcription")
	}
	if cfg.AuthMode == muxcfg.VoiceAuthAPIKey && !s.voiceKeyPresent(cfg) {
		return meetingVoiceTarget{}, errors.New("The configured Voice credential is unavailable")
	}
	u, err := url.Parse(cfg.Endpoint)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return meetingVoiceTarget{}, errors.New("The Voice endpoint must be an HTTPS OpenAI-compatible v1 URL")
	}
	model := strings.TrimSpace(cfg.TranscriptionModel)
	name := "Azure OpenAI"
	if strings.EqualFold(u.Hostname(), "api.openai.com") {
		name = "OpenAI"
		if model == "" {
			model = "gpt-transcribe"
		}
	} else if model == "" {
		return meetingVoiceTarget{}, errors.New("Set a meeting transcription deployment in Settings > Voice")
	}
	if len(model) > 120 || strings.ContainsAny(model, " \t\r\n") {
		return meetingVoiceTarget{}, errors.New("Meeting transcription model is invalid")
	}
	return meetingVoiceTarget{config: cfg, model: model, name: name}, nil
}

func (s *Server) handleMeetingTranscriptionOptions(w http.ResponseWriter, _ *http.Request) {
	options := meetingTranscriptionOptions{}
	if err := localMeetingTranscriberReady(); err != nil {
		options.LocalDetail = err.Error()
	} else {
		options.LocalReady = true
	}
	if target, err := s.meetingVoiceTarget(); err == nil {
		options.ProviderReady = true
		options.ProviderName = target.name
		options.ProviderModel = target.model
	} else {
		options.ProviderDetail = err.Error()
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, options)
}

func localMeetingTranscriberReady() error {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		return errors.New("Install ffmpeg on the Muxterm server")
	}
	command := os.Getenv("MUXTERM_MEETING_TRANSCRIBER")
	if command == "" {
		return errors.New("Set MUXTERM_MEETING_TRANSCRIBER to a local transcription executable on the Muxterm server")
	}
	if _, err := exec.LookPath(command); err != nil {
		return errors.New("The configured local transcription executable is unavailable")
	}
	return nil
}

// The file endpoint accepts at most 25 MB. One-minute 16 kHz mono PCM chunks
// are about 2 MB, so even a long meeting stays within the service limit.
const meetingProviderSegmentSeconds = 60

func transcribeMeetingWithVoice(ctx context.Context, input, dir string, target meetingVoiceTarget) ([]meetingSegment, error) {
	segmentDir, err := os.MkdirTemp(dir, ".provider-transcription-")
	if err != nil {
		return nil, fmt.Errorf("cannot prepare audio: %w", err)
	}
	defer os.RemoveAll(segmentDir)
	pattern := filepath.Join(segmentDir, "segment-%05d.wav")
	convert := exec.CommandContext(ctx, "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", input, "-map", "0:a:0", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "-f", "segment", "-segment_time", strconv.Itoa(meetingProviderSegmentSeconds), "-reset_timestamps", "1", pattern)
	if log, err := convert.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("audio conversion failed: %v: %s", err, strings.TrimSpace(string(log)))
	}
	files, err := filepath.Glob(filepath.Join(segmentDir, "segment-*.wav"))
	if err != nil || len(files) == 0 {
		return nil, errors.New("audio conversion produced no speech track")
	}
	credential, err := voice.NewCredential(target.config, voice.DefaultKeyPath())
	if err != nil {
		return nil, err
	}
	client := &http.Client{Timeout: 2 * time.Minute, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	segments := make([]meetingSegment, 0, len(files))
	var offsetMs int64
	for _, file := range files {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		info, err := os.Stat(file)
		if err != nil || info.Size() > 24<<20 || info.Size() < 80 {
			return nil, errors.New("converted audio segment is invalid or exceeds the provider upload limit")
		}
		// PCM16 mono at 16 kHz is 32 bytes/ms. WAV headers are at most a
		// few dozen bytes here, so this offset is within milliseconds.
		durationMs := (info.Size() - 80) / 32
		if durationMs < 1 {
			durationMs = 1
		}
		transcript, err := transcribeVoiceSegment(ctx, client, credential, target, file)
		if err != nil {
			return nil, err
		}
		if transcript != "" {
			segments = append(segments, meetingSegment{StartMs: offsetMs, EndMs: offsetMs + durationMs, Text: transcript})
		}
		offsetMs += durationMs
	}
	if len(segments) == 0 {
		return nil, errors.New("the transcription model returned no speech")
	}
	return segments, nil
}

func transcribeVoiceSegment(ctx context.Context, client *http.Client, credential voice.Credential, target meetingVoiceTarget, path string) (string, error) {
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	if err := form.WriteField("model", target.model); err != nil {
		return "", err
	}
	filePart, err := form.CreateFormFile("file", "meeting.wav")
	if err != nil {
		return "", err
	}
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	_, copyErr := io.Copy(filePart, file)
	closeErr := file.Close()
	if copyErr != nil {
		return "", copyErr
	}
	if closeErr != nil {
		return "", closeErr
	}
	if err := form.Close(); err != nil {
		return "", err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(target.config.Endpoint, "/")+"/audio/transcriptions", &body)
	if err != nil {
		return "", err
	}
	request.Header.Set("Content-Type", form.FormDataContentType())
	token, err := credential.Token(ctx)
	if err != nil {
		return "", err
	}
	if target.name == "Azure OpenAI" && credential.Mode() == muxcfg.VoiceAuthAPIKey {
		request.Header.Set("api-key", token)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := client.Do(request)
	if err != nil {
		return "", fmt.Errorf("%s transcription request failed: %w", target.name, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		// Provider error bodies can repeat an API key or submitted text.
		return "", fmt.Errorf("%s transcription returned HTTP %d; check the meeting transcription model and Voice credential", target.name, response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 2<<20+1))
	if err != nil || len(data) > 2<<20 {
		return "", errors.New("transcription response was too large")
	}
	var result struct {
		Text string `json:"text"`
	}
	if json.Unmarshal(data, &result) != nil {
		return "", errors.New("transcription provider returned invalid JSON")
	}
	return strings.TrimSpace(result.Text), nil
}
