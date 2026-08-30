//go:build unix

package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"time"
	"unicode/utf8"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

const (
	recoveryHookInputLimit = 64 * 1024
	recoveryHookInputWait  = 250 * time.Millisecond
	recoveryHookJSONDepth  = 16
)

type recoveryHookObservation struct {
	StrategyID sessiond.RecoveryStrategyID
	Source     sessiond.RecoveryLifecycleSource
	SessionID  sessiond.RecoveryOpaqueSessionID
	CWD        sessiond.RecoveryWorkingDirectory
}

type recoveryHookReadResult struct {
	data []byte
	err  error
}

type recoveryHookString struct {
	value   string
	present bool
}

func (value *recoveryHookString) UnmarshalJSON(data []byte) error {
	if value == nil || bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return errors.New("recovery hook string invalid")
	}
	var decoded string
	if err := json.Unmarshal(data, &decoded); err != nil {
		return errors.New("recovery hook string invalid")
	}
	value.value = decoded
	value.present = true
	return nil
}

type recoveryHookNullableString struct {
	value   string
	present bool
	null    bool
}

func (value *recoveryHookNullableString) UnmarshalJSON(data []byte) error {
	if value == nil {
		return errors.New("recovery hook nullable string invalid")
	}
	value.present = true
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		value.null = true
		value.value = ""
		return nil
	}
	var decoded string
	if err := json.Unmarshal(data, &decoded); err != nil {
		return errors.New("recovery hook nullable string invalid")
	}
	value.null = false
	value.value = decoded
	return nil
}

type recoveryHookBool struct {
	value   bool
	present bool
}

func (value *recoveryHookBool) UnmarshalJSON(data []byte) error {
	if value == nil || bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return errors.New("recovery hook boolean invalid")
	}
	var decoded bool
	if err := json.Unmarshal(data, &decoded); err != nil {
		return errors.New("recovery hook boolean invalid")
	}
	value.value = decoded
	value.present = true
	return nil
}

type recoveryHookNumber struct {
	present bool
}

func (value *recoveryHookNumber) UnmarshalJSON(data []byte) error {
	if value == nil || bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return errors.New("recovery hook number invalid")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	token, err := decoder.Token()
	if err != nil {
		return errors.New("recovery hook number invalid")
	}
	if _, ok := token.(json.Number); !ok {
		return errors.New("recovery hook number invalid")
	}
	if _, err := decoder.Token(); err != io.EOF {
		return errors.New("recovery hook number invalid")
	}
	value.present = true
	return nil
}

type claudeRecoveryHookInput struct {
	SessionID                recoveryHookString `json:"session_id"`
	TranscriptPath           recoveryHookString `json:"transcript_path"`
	CWD                      recoveryHookString `json:"cwd"`
	HookEventName            recoveryHookString `json:"hook_event_name"`
	Source                   recoveryHookString `json:"source"`
	PromptID                 recoveryHookString `json:"prompt_id"`
	PermissionMode           recoveryHookString `json:"permission_mode"`
	Model                    recoveryHookString `json:"model"`
	SessionTitle             recoveryHookString `json:"session_title"`
	AgentType                recoveryHookString `json:"agent_type"`
	AgentID                  recoveryHookString `json:"agent_id"`
	SecondsSinceLastResponse recoveryHookNumber `json:"seconds_since_last_response"`
	ContextTokens            recoveryHookNumber `json:"context_tokens"`
	PromptCacheLikelyExpired recoveryHookBool   `json:"prompt_cache_likely_expired"`
	EstimatedCacheWriteUSD   recoveryHookNumber `json:"estimated_cache_write_usd"`
}

type codexRecoveryHookInput struct {
	CWD            recoveryHookString         `json:"cwd"`
	HookEventName  recoveryHookString         `json:"hook_event_name"`
	Model          recoveryHookString         `json:"model"`
	PermissionMode recoveryHookString         `json:"permission_mode"`
	SessionID      recoveryHookString         `json:"session_id"`
	Source         recoveryHookString         `json:"source"`
	TranscriptPath recoveryHookNullableString `json:"transcript_path"`
}

type openCodeRecoveryHookInput struct {
	Event       recoveryHookString `json:"event"`
	Source      recoveryHookString `json:"source"`
	SessionID   recoveryHookString `json:"session_id"`
	CWD         recoveryHookString `json:"cwd"`
	RootSession recoveryHookBool   `json:"root_session"`
	UserBacked  recoveryHookBool   `json:"user_backed"`
}

func runRecoveryHook(tool string, input io.Reader) (exitCode int) {
	defer func() {
		if recover() != nil {
			exitCode = 0
		}
	}()

	data, ok := readRecoveryHookInput(input)
	if !ok {
		return 0
	}
	observation, err := parseRecoveryHookInput(tool, data)
	if err != nil {
		return 0
	}

	client, err := sessiond.DialRecoverySocket()
	if err != nil {
		return 0
	}
	defer func() { _ = client.Close() }()

	bootstrap, err := client.BootstrapLifecycle(sessiond.RecoveryLifecycleBootstrapRequest{
		SchemaVersion: sessiond.RecoveryCaptureSchemaVersion,
		StrategyID:    observation.StrategyID,
		Event:         sessiond.RecoveryLifecycleEventSessionStart,
		Source:        observation.Source,
	})
	if err != nil ||
		bootstrap.Disposition != sessiond.RecoveryLifecycleBootstrapAccepted ||
		bootstrap.LeaseDelivery == nil {
		return 0
	}

	_, _ = client.CaptureLifecycle(sessiond.PrivilegedLifecycleCaptureRequest{
		Callback: sessiond.RecoveryLifecycleCapture{
			Capability: bootstrap.LeaseDelivery.Capability,
			Evidence: sessiond.RecoveryObservedToolEvidence{
				SessionID:        observation.SessionID,
				WorkingDirectory: observation.CWD,
			},
		},
	})
	return 0
}

func readRecoveryHookInput(input io.Reader) ([]byte, bool) {
	deadline := time.Now().Add(recoveryHookInputWait)
	timer := time.NewTimer(recoveryHookInputWait)
	defer timer.Stop()

	result := make(chan recoveryHookReadResult, 1)
	go func() {
		readResult := recoveryHookReadResult{}
		defer func() {
			if recover() != nil {
				readResult = recoveryHookReadResult{err: errors.New("recovery hook input read failed")}
			}
			result <- readResult
		}()
		readResult.data, readResult.err = io.ReadAll(io.LimitReader(input, recoveryHookInputLimit+1))
	}()

	select {
	case readResult := <-result:
		if !time.Now().Before(deadline) || readResult.err != nil ||
			len(readResult.data) == 0 || len(readResult.data) > recoveryHookInputLimit {
			return nil, false
		}
		return readResult.data, true
	case <-timer.C:
		return nil, false
	}
}

func parseRecoveryHookInput(tool string, data []byte) (recoveryHookObservation, error) {
	if len(data) == 0 || len(data) > recoveryHookInputLimit {
		return recoveryHookObservation{}, errors.New("recovery hook input invalid")
	}
	if err := validateRecoveryHookJSON(data); err != nil {
		return recoveryHookObservation{}, errors.New("recovery hook JSON invalid")
	}

	switch tool {
	case string(sessiond.RecoveryStrategyClaudeCode):
		return parseClaudeRecoveryHookInput(data)
	case string(sessiond.RecoveryStrategyOpenCode):
		return parseOpenCodeRecoveryHookInput(data)
	case string(sessiond.RecoveryStrategyCodex):
		return parseCodexRecoveryHookInput(data)
	default:
		return recoveryHookObservation{}, errors.New("recovery hook tool unsupported")
	}
}

func validateRecoveryHookJSON(data []byte) error {
	if !utf8.Valid(data) {
		return errors.New("recovery hook JSON encoding invalid")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return errors.New("recovery hook JSON top level invalid")
	}
	if err := scanRecoveryHookJSONContainer(decoder, json.Delim('{'), 1); err != nil {
		return err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return errors.New("recovery hook JSON trailing value invalid")
	}
	return nil
}

func scanRecoveryHookJSONValue(decoder *json.Decoder, depth int) error {
	token, err := decoder.Token()
	if err != nil {
		return errors.New("recovery hook JSON value invalid")
	}
	delimiter, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	if delimiter != '{' && delimiter != '[' {
		return errors.New("recovery hook JSON delimiter invalid")
	}
	return scanRecoveryHookJSONContainer(decoder, delimiter, depth)
}

func scanRecoveryHookJSONContainer(decoder *json.Decoder, delimiter json.Delim, depth int) error {
	if depth > recoveryHookJSONDepth {
		return errors.New("recovery hook JSON nesting invalid")
	}

	switch delimiter {
	case '{':
		keys := make(map[string]struct{})
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return errors.New("recovery hook JSON object invalid")
			}
			key, ok := keyToken.(string)
			if !ok {
				return errors.New("recovery hook JSON object key invalid")
			}
			if _, duplicate := keys[key]; duplicate {
				return errors.New("recovery hook JSON duplicate key")
			}
			keys[key] = struct{}{}
			if err := scanRecoveryHookJSONValue(decoder, depth+1); err != nil {
				return err
			}
		}
		token, err := decoder.Token()
		if err != nil || token != json.Delim('}') {
			return errors.New("recovery hook JSON object unterminated")
		}
	case '[':
		for decoder.More() {
			if err := scanRecoveryHookJSONValue(decoder, depth+1); err != nil {
				return err
			}
		}
		token, err := decoder.Token()
		if err != nil || token != json.Delim(']') {
			return errors.New("recovery hook JSON array unterminated")
		}
	default:
		return errors.New("recovery hook JSON container invalid")
	}
	return nil
}

func decodeRecoveryHookSchema(data []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return errors.New("recovery hook schema invalid")
	}
	if _, err := decoder.Token(); err != io.EOF {
		return errors.New("recovery hook schema trailing value invalid")
	}
	return nil
}

func parseClaudeRecoveryHookInput(data []byte) (recoveryHookObservation, error) {
	var input claudeRecoveryHookInput
	if err := decodeRecoveryHookSchema(data, &input); err != nil {
		return recoveryHookObservation{}, errors.New("recovery hook Claude schema invalid")
	}
	if !requiredRecoveryHookStrings(
		input.SessionID,
		input.TranscriptPath,
		input.CWD,
		input.HookEventName,
		input.Source,
	) || input.HookEventName.value != "SessionStart" || input.AgentID.present {
		return recoveryHookObservation{}, errors.New("recovery hook Claude fields invalid")
	}
	source, ok := recoveryHookLifecycleSource(input.Source.value)
	if !ok || !validRecoveryHookUUID(input.SessionID.value) {
		return recoveryHookObservation{}, errors.New("recovery hook Claude identity invalid")
	}
	cwd, err := validateRecoveryHookWorkingDirectory(input.CWD.value)
	if err != nil {
		return recoveryHookObservation{}, errors.New("recovery hook Claude working directory invalid")
	}
	return recoveryHookObservation{
		StrategyID: sessiond.RecoveryStrategyClaudeCode,
		Source:     source,
		SessionID:  sessiond.RecoveryOpaqueSessionID(input.SessionID.value),
		CWD:        cwd,
	}, nil
}

func parseCodexRecoveryHookInput(data []byte) (recoveryHookObservation, error) {
	var input codexRecoveryHookInput
	if err := decodeRecoveryHookSchema(data, &input); err != nil {
		return recoveryHookObservation{}, errors.New("recovery hook Codex schema invalid")
	}
	if !requiredRecoveryHookStrings(
		input.CWD,
		input.HookEventName,
		input.Model,
		input.PermissionMode,
		input.SessionID,
		input.Source,
	) || !input.TranscriptPath.present ||
		(!input.TranscriptPath.null && input.TranscriptPath.value == "") ||
		input.HookEventName.value != "SessionStart" {
		return recoveryHookObservation{}, errors.New("recovery hook Codex fields invalid")
	}
	source, ok := recoveryHookLifecycleSource(input.Source.value)
	if !ok || !validRecoveryHookUUID(input.SessionID.value) {
		return recoveryHookObservation{}, errors.New("recovery hook Codex identity invalid")
	}
	cwd, err := validateRecoveryHookWorkingDirectory(input.CWD.value)
	if err != nil {
		return recoveryHookObservation{}, errors.New("recovery hook Codex working directory invalid")
	}
	return recoveryHookObservation{
		StrategyID: sessiond.RecoveryStrategyCodex,
		Source:     source,
		SessionID:  sessiond.RecoveryOpaqueSessionID(input.SessionID.value),
		CWD:        cwd,
	}, nil
}

func parseOpenCodeRecoveryHookInput(data []byte) (recoveryHookObservation, error) {
	var input openCodeRecoveryHookInput
	if err := decodeRecoveryHookSchema(data, &input); err != nil {
		return recoveryHookObservation{}, errors.New("recovery hook OpenCode schema invalid")
	}
	if !requiredRecoveryHookStrings(input.Event, input.Source, input.SessionID, input.CWD) ||
		!input.RootSession.present || !input.UserBacked.present ||
		input.Source.value != "managed-session" || !input.RootSession.value ||
		!validOpenCodeRecoveryHookSessionID(input.SessionID.value) {
		return recoveryHookObservation{}, errors.New("recovery hook OpenCode fields invalid")
	}

	var source sessiond.RecoveryLifecycleSource
	switch {
	case input.Event.value == "session.created" && !input.UserBacked.value:
		source = sessiond.RecoveryLifecycleSourceStartup
	case input.Event.value == "session.updated" && input.UserBacked.value:
		source = sessiond.RecoveryLifecycleSourceResume
	default:
		return recoveryHookObservation{}, errors.New("recovery hook OpenCode event invalid")
	}

	cwd, err := validateRecoveryHookWorkingDirectory(input.CWD.value)
	if err != nil {
		return recoveryHookObservation{}, errors.New("recovery hook OpenCode working directory invalid")
	}
	return recoveryHookObservation{
		StrategyID: sessiond.RecoveryStrategyOpenCode,
		Source:     source,
		SessionID:  sessiond.RecoveryOpaqueSessionID(input.SessionID.value),
		CWD:        cwd,
	}, nil
}

func requiredRecoveryHookStrings(values ...recoveryHookString) bool {
	for _, value := range values {
		if !value.present || value.value == "" {
			return false
		}
	}
	return true
}

func recoveryHookLifecycleSource(value string) (sessiond.RecoveryLifecycleSource, bool) {
	switch value {
	case "startup":
		return sessiond.RecoveryLifecycleSourceStartup, true
	case "resume":
		return sessiond.RecoveryLifecycleSourceResume, true
	case "clear":
		return sessiond.RecoveryLifecycleSourceClear, true
	case "compact":
		return sessiond.RecoveryLifecycleSourceCompact, true
	default:
		return "", false
	}
}

func validRecoveryHookUUID(value string) bool {
	if len(value) != 36 || value == "00000000-0000-0000-0000-000000000000" {
		return false
	}
	for index := range value {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			if value[index] != '-' {
				return false
			}
			continue
		}
		if (value[index] < '0' || value[index] > '9') &&
			(value[index] < 'a' || value[index] > 'f') {
			return false
		}
	}
	return true
}

func validOpenCodeRecoveryHookSessionID(value string) bool {
	if len(value) < 5 || len(value) > sessiond.RecoveryMaxOpaqueSessionIDBytes ||
		len(value) < len("ses_")+1 || value[:len("ses_")] != "ses_" {
		return false
	}
	for index := len("ses_"); index < len(value); index++ {
		character := value[index]
		if (character < 'a' || character > 'z') &&
			(character < 'A' || character > 'Z') &&
			(character < '0' || character > '9') &&
			character != '_' && character != '-' {
			return false
		}
	}
	return true
}

func validateRecoveryHookWorkingDirectory(value string) (sessiond.RecoveryWorkingDirectory, error) {
	if value == "" || len(value) > sessiond.RecoveryMaxWorkingDirectoryBytes ||
		!filepath.IsAbs(value) || filepath.Clean(value) != value {
		return "", errors.New("recovery hook working directory path invalid")
	}
	first, err := os.Lstat(value)
	if err != nil || first.Mode()&os.ModeSymlink != 0 || !first.IsDir() {
		return "", errors.New("recovery hook working directory object invalid")
	}
	resolved, err := filepath.EvalSymlinks(value)
	if err != nil || resolved != value {
		return "", errors.New("recovery hook working directory canonical form invalid")
	}
	second, err := os.Lstat(value)
	if err != nil || second.Mode()&os.ModeSymlink != 0 || !second.IsDir() || !os.SameFile(first, second) {
		return "", errors.New("recovery hook working directory changed")
	}
	return sessiond.RecoveryWorkingDirectory(value), nil
}
