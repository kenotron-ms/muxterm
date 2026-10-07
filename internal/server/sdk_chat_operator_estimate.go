package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
)

// Timing is a distribution of completed human turns, never a percent-complete
// guess. Goal runs need their own population; a completed turn is not a goal.
type sdkLaneTiming struct {
	Category             string `json:"category"`
	Classification       string `json:"classification"`
	SampleSize           int    `json:"sampleSize"`
	BroadHistory         bool   `json:"broadHistory,omitempty"`
	EffortLowSeconds     int    `json:"effortLowSeconds,omitempty"`
	EffortHighSeconds    int    `json:"effortHighSeconds,omitempty"`
	ElapsedSeconds       int    `json:"elapsedSeconds,omitempty"`
	RemainingLowSeconds  *int   `json:"remainingLowSeconds,omitempty"`
	RemainingHighSeconds *int   `json:"remainingHighSeconds,omitempty"`
	SurvivorCount        int    `json:"survivorCount,omitempty"`
	ActualSeconds        int    `json:"actualSeconds,omitempty"`
}

type sdkEffortSample struct {
	category string
	seconds  int
}
type sdkEffortClass struct {
	key      string
	category string
	source   string
}
type sdkEffortEstimator struct {
	dir     string
	mu      sync.Mutex
	samples []sdkEffortSample
	loaded  time.Time
	loading bool
	classes map[string]sdkEffortClass
}

func newSDKEffortEstimator(dir string) *sdkEffortEstimator {
	return &sdkEffortEstimator{dir: dir, classes: map[string]sdkEffortClass{}}
}

func sdkEffortCategory(text string) string {
	text = strings.ToLower(text)
	change := sdkHasAny(text, "implement", "add ", "build ", "fix ", "change ", "create ", "wire ", "support ", "replace ", "update ")
	if change && sdkHasAny(text, "frontend", "browser", "ui", "web", "component") && sdkHasAny(text, "backend", "server", "api", "go ", "database", "sessiond") {
		return "cross_stack"
	}
	if change && sdkHasAny(text, "deploy", "release", "install", "upgrade", "systemd", "production") {
		return "operational"
	}
	if !change && sdkHasAny(text, "review", "inspect", "explain", "analyze", "summarize", "investigate", "find ") {
		return "review"
	}
	return "focused"
}

func sdkHasAny(text string, words ...string) bool {
	for _, word := range words {
		if strings.Contains(text, word) {
			return true
		}
	}
	return false
}

func sdkEffortValidCategory(category string) bool {
	return category == "review" || category == "focused" || category == "cross_stack" || category == "operational"
}

func (e *sdkEffortEstimator) timing(lane sdkChat) sdkLaneTiming {
	if e == nil {
		return sdkLaneTiming{Category: sdkEffortCategory(lane.Title), Classification: "historical_only"}
	}
	key := lane.ID + ":" + lane.Title + ":" + lane.TurnStartedAt.Format(time.RFC3339Nano)
	fallback := sdkEffortCategory(lane.Title)
	e.mu.Lock()
	if !e.loading && (e.loaded.IsZero() || time.Since(e.loaded) > 10*time.Minute) {
		e.loading = true
		go e.loadHistory()
	}
	classification := e.classes[lane.ID]
	if classification.key != key {
		classification = sdkEffortClass{key: key, category: fallback, source: "historical_only"}
		go e.classify(lane.ID, key, lane.Title)
		e.classes[lane.ID] = classification
	}
	samples := append([]sdkEffortSample(nil), e.samples...)
	e.mu.Unlock()
	result := sdkLaneTiming{Category: classification.category, Classification: classification.source, ActualSeconds: lane.LastTurnSeconds}
	if lane.State == "working" || lane.State == "starting" {
		if !lane.TurnStartedAt.IsZero() {
			result.ElapsedSeconds = max(0, int(time.Since(lane.TurnStartedAt).Seconds()))
		}
	}
	var selected []int
	for _, sample := range samples {
		if sample.category == result.Category {
			selected = append(selected, sample.seconds)
		}
	}
	if len(selected) < 8 {
		result.BroadHistory = true
		selected = selected[:0]
		for _, sample := range samples {
			selected = append(selected, sample.seconds)
		}
	}
	result.SampleSize = len(selected)
	if len(selected) < 8 {
		return result
	}
	sort.Ints(selected)
	result.EffortLowSeconds = sdkEffortQuantile(selected, .1)
	result.EffortHighSeconds = sdkEffortQuantile(selected, .9)
	if result.ElapsedSeconds > 0 {
		var survivors []int
		for _, seconds := range selected {
			if seconds > result.ElapsedSeconds {
				survivors = append(survivors, seconds-result.ElapsedSeconds)
			}
		}
		result.SurvivorCount = len(survivors)
		if len(survivors) >= 5 {
			low, high := sdkEffortQuantile(survivors, .1), sdkEffortQuantile(survivors, .9)
			result.RemainingLowSeconds, result.RemainingHighSeconds = &low, &high
		}
	}
	return result
}

func sdkEffortQuantile(sorted []int, proportion float64) int {
	return sorted[int(proportion*float64(len(sorted)-1))]
}

func (e *sdkEffortEstimator) loadHistory() {
	samples := sdkCompletedTurnSamples(e.dir)
	e.mu.Lock()
	e.samples, e.loaded, e.loading = samples, time.Now(), false
	e.mu.Unlock()
}

func sdkCompletedTurnSamples(dir string) []sdkEffortSample {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	cutoff := time.Now().Add(-180 * 24 * time.Hour)
	var samples []sdkEffortSample
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".ndjson") {
			continue
		}
		file, err := os.Open(filepath.Join(dir, entry.Name()))
		if err != nil {
			continue
		}
		scan := bufio.NewScanner(file)
		scan.Buffer(make([]byte, 64*1024), 8*1024*1024)
		var started time.Time
		category := ""
		for scan.Scan() {
			var event struct {
				At     time.Time `json:"at"`
				Type   string    `json:"type"`
				Kind   string    `json:"kind"`
				Source string    `json:"source"`
				Text   string    `json:"text"`
			}
			if json.Unmarshal(scan.Bytes(), &event) != nil || event.At.IsZero() {
				continue
			}
			switch event.Type {
			case "input.accepted":
				started, category = time.Time{}, ""
				if event.Kind == "user" && event.Source != "operator-lane" && event.At.After(cutoff) {
					started, category = event.At, sdkEffortCategory(event.Text)
				}
			case "turn.completed":
				if !started.IsZero() {
					seconds := int(event.At.Sub(started).Seconds() + .5)
					if seconds >= 1 && seconds <= 12*60*60 {
						samples = append(samples, sdkEffortSample{category: category, seconds: seconds})
					}
				}
				started = time.Time{}
			case "turn.cancelled", "error", "session.uncertain":
				started = time.Time{}
			}
		}
		_ = file.Close()
	}
	return samples
}

func (e *sdkEffortEstimator) classify(id, key, title string) {
	input := sdkLatestLaneRequest(e.dir, id)
	if input == "" {
		input = title
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	category, source := sdkClassifyEffort(ctx, input)
	if !sdkEffortValidCategory(category) {
		category, source = sdkEffortCategory(input), "historical_only"
	}
	e.mu.Lock()
	if current := e.classes[id]; current.key == key {
		e.classes[id] = sdkEffortClass{key: key, category: category, source: source}
	}
	e.mu.Unlock()
}

func sdkLatestLaneRequest(dir, id string) string {
	file, err := os.Open(filepath.Join(dir, id+".ndjson"))
	if err != nil {
		return ""
	}
	defer file.Close()
	scan := bufio.NewScanner(file)
	scan.Buffer(make([]byte, 64*1024), 8*1024*1024)
	latest := ""
	for scan.Scan() {
		var event struct {
			Type, Kind, Source, Text string
		}
		if json.Unmarshal(scan.Bytes(), &event) == nil && event.Type == "input.accepted" && event.Kind == "user" {
			latest = event.Text
		}
	}
	runes := []rune(latest)
	return string(runes[:min(len(runes), 1500)])
}

func sdkClassifyEffort(ctx context.Context, input string) (string, string) {
	if key := sdkAmplifierProviderKey("OPENAI_API_KEY"); key != "" {
		if category := sdkOpenAIDecision(ctx, key, input); category != "" {
			return category, "openai_decisions"
		}
	}
	if key := sdkAmplifierProviderKey("ANTHROPIC_API_KEY"); key != "" {
		if category := sdkAnthropicEffort(ctx, key, input); category != "" {
			return category, "anthropic"
		}
	}
	return sdkEffortCategory(input), "historical_only"
}

// Amplifier's standard keys.env is read only; key bytes stay inside provider
// requests and never enter logs, responses, or shell arguments.
func sdkAmplifierProviderKey(name string) string {
	if key := strings.TrimSpace(os.Getenv(name)); key != "" {
		return key
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	for _, filename := range []string{"keys.env", "key.env"} {
		file, err := os.Open(filepath.Join(home, ".amplifier", filename))
		if err != nil {
			continue
		}
		data, err := io.ReadAll(io.LimitReader(file, 64*1024))
		_ = file.Close()
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(data), "\n") {
			line = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "export "))
			key, value, found := strings.Cut(line, "=")
			if found && strings.TrimSpace(key) == name {
				value = strings.TrimSpace(value)
				if len(value) >= 2 && (value[0] == '\'' && value[len(value)-1] == '\'' || value[0] == '"' && value[len(value)-1] == '"') {
					value = value[1 : len(value)-1]
				}
				return value
			}
		}
	}
	return ""
}

func sdkOpenAIDecision(ctx context.Context, key, input string) string {
	request := map[string]any{
		"model": "gpt-6-luna",
		"input": input,
		"questions": []any{map[string]any{
			"type": "choice", "name": "effort", "instructions": "Choose the closest software request type by expected implementation breadth. Return one choice.",
			"choices": []any{
				map[string]string{"value": "review", "description": "Read-only investigation or explanation"},
				map[string]string{"value": "focused", "description": "Localized fix or one-surface change"},
				map[string]string{"value": "cross_stack", "description": "Several connected UI, backend, or data changes"},
				map[string]string{"value": "operational", "description": "Deployment, install, or production operation"},
			},
		}},
	}
	body, _ := json.Marshal(request)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.openai.com/v1/decisions", bytes.NewReader(body))
	if err != nil {
		return ""
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+key)
	client := &http.Client{Timeout: 4 * time.Second}
	response, err := client.Do(req)
	if err != nil {
		return ""
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return ""
	}
	var result struct {
		Answers []struct {
			Type   string `json:"type"`
			Choice string `json:"choice"`
		} `json:"answers"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 64*1024)).Decode(&result) == nil && len(result.Answers) > 0 && result.Answers[0].Type == "choice" && sdkEffortValidCategory(result.Answers[0].Choice) {
		return result.Answers[0].Choice
	}
	return ""
}

func sdkAnthropicEffort(ctx context.Context, key, input string) string {
	client := anthropic.NewClient(option.WithAPIKey(key))
	response, err := client.Messages.New(ctx, anthropic.MessageNewParams{
		Model: anthropic.ModelClaudeHaiku4_5, MaxTokens: 30,
		Messages: []anthropic.MessageParam{anthropic.NewUserMessage(anthropic.NewTextBlock(
			"Classify this software request by expected implementation breadth. Reply with exactly one token: review, focused, cross_stack, or operational.\nRequest: " + input,
		))},
	})
	if err != nil {
		return ""
	}
	for _, block := range response.Content {
		category := strings.TrimSpace(block.Text)
		if sdkEffortValidCategory(category) {
			return category
		}
	}
	return ""
}
