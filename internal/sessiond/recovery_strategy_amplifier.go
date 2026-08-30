package sessiond

import (
	"bufio"
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	amplifierCorrelationMaxDirectoryEntries       = 4096
	amplifierCorrelationMaxCandidateDirectories   = 256
	amplifierCorrelationMaxMetadataBytes          = 64 * 1024
	amplifierCorrelationMaxMetadataDepth          = 32
	amplifierCorrelationMaxTranscriptFileBytes    = 16 * 1024 * 1024
	amplifierCorrelationMaxTranscriptAttemptBytes = 64 * 1024 * 1024
	amplifierCorrelationMaxTranscriptRecordBytes  = 4 * 1024 * 1024
	amplifierCorrelationMaxTranscriptFileLines    = 100_000
	amplifierCorrelationMaxTranscriptAttemptLines = 150_000
	amplifierCorrelationTranscriptReadBufferBytes = 64 * 1024
	amplifierCorrelationDirectoryReadBatch        = 64
	amplifierCorrelationSkew                      = 2 * time.Second

	amplifierMetadataFilename         = "metadata.json"
	amplifierTranscriptFilename       = "transcript.jsonl"
	amplifierTranscriptBackupFilename = "transcript.jsonl.backup"
)

var errAmplifierMetadataDepthExceeded = errors.New("recovery: metadata nesting depth exceeded")

// AmplifierRecoveryStrategy reconstructs only an exact amplifier-app-cli
// session. It owns neither process launch nor runtime registration.
type AmplifierRecoveryStrategy struct {
	executable   RecoveryExecutable
	projectsRoot string
}

var _ RecoveryStrategy = (*AmplifierRecoveryStrategy)(nil)

// NewAmplifierRecoveryStrategy validates and pins the executable and projects
// root without consulting PATH, HOME, or any ambient environment.
func NewAmplifierRecoveryStrategy(
	executable RecoveryExecutable,
	projectsRoot string,
) (*AmplifierRecoveryStrategy, error) {
	canonicalExecutable, err := canonicalAmplifierExecutable(executable)
	if err != nil {
		return nil, err
	}
	canonicalProjectsRoot, err := canonicalAmplifierProjectsRoot(projectsRoot)
	if err != nil {
		return nil, err
	}
	return &AmplifierRecoveryStrategy{
		executable:   canonicalExecutable,
		projectsRoot: canonicalProjectsRoot,
	}, nil
}

// AmplifierCorrelationRequest contains the pane-bounded evidence that can
// authorize a disk correlation. It intentionally has no terminal content or
// ambient process state.
type AmplifierCorrelationRequest struct {
	Fence            RecoveryFence
	WorkingDirectory RecoveryWorkingDirectoryBinding
	PaneLaunchedAt   time.Time
	ObservedAt       time.Time
}

// Capture accepts only exact amplifier identities from allowlisted sources.
func (strategy *AmplifierRecoveryStrategy) Capture(request RecoveryCaptureRequest) RecoveryCaptureResult {
	if strategy == nil {
		return newAmplifierCaptureResult(RecoveryValidationMalformed, nil)
	}
	capturedAt := time.Now().UTC()
	if validation := validateAmplifierFence(request.Fence); validation != RecoveryValidationValid {
		return newAmplifierCaptureResult(validation, nil)
	}
	if !allowedAmplifierCaptureSource(request.Source) {
		return newAmplifierCaptureResult(RecoveryValidationUnsupported, nil)
	}
	if !canonicalAmplifierUUID(request.SessionID) {
		return newAmplifierCaptureResult(RecoveryValidationMalformed, nil)
	}
	if !validAmplifierWorkingDirectoryBinding(request.WorkingDirectory) {
		return newAmplifierCaptureResult(RecoveryValidationMalformed, nil)
	}
	if request.ObservedAt.IsZero() ||
		request.WorkingDirectory.ObservedAt.After(request.ObservedAt) ||
		request.ObservedAt.After(capturedAt) {
		return newAmplifierCaptureResult(RecoveryValidationMalformed, nil)
	}

	capture := ExactSessionCapture{
		Schema:           RecoveryCaptureSchemaV1,
		Version:          RecoveryCaptureSchemaVersion,
		Pane:             request.Fence.Pane,
		StrategyID:       RecoveryStrategyAmplifier,
		Source:           request.Source,
		SessionID:        request.SessionID,
		WorkingDirectory: request.WorkingDirectory,
		RootGeneration:   request.Fence.RootProcessGeneration,
		CaptureEpoch:     request.Fence.CaptureEpoch,
		ObservedAt:       request.ObservedAt,
		CapturedAt:       capturedAt,
	}
	return newAmplifierCaptureResult(RecoveryValidationValid, &capture)
}

// ValidateCapture independently validates an existing capture against its
// current pane-qualified fence.
func (strategy *AmplifierRecoveryStrategy) ValidateCapture(
	request RecoveryCaptureValidationRequest,
) RecoveryCaptureValidationResult {
	if strategy == nil {
		return newAmplifierCaptureValidationResult(RecoveryValidationMalformed)
	}
	if validation := validateAmplifierFence(request.ExpectedFence); validation != RecoveryValidationValid {
		return newAmplifierCaptureValidationResult(validation)
	}

	switch validateAmplifierCapture(request.Capture) {
	case amplifierCaptureProblemNone:
	case amplifierCaptureProblemUnsupported:
		return newAmplifierCaptureValidationResult(RecoveryValidationUnsupported)
	default:
		return newAmplifierCaptureValidationResult(RecoveryValidationMalformed)
	}

	if request.Capture.Pane != request.ExpectedFence.Pane {
		return newAmplifierCaptureValidationResult(RecoveryValidationConflicting)
	}
	if request.Capture.RootGeneration != request.ExpectedFence.RootProcessGeneration ||
		request.Capture.CaptureEpoch != request.ExpectedFence.CaptureEpoch {
		return newAmplifierCaptureValidationResult(RecoveryValidationStale)
	}
	return newAmplifierCaptureValidationResult(RecoveryValidationValid)
}

// BuildResume constructs the sole structured launch form accepted for an
// exact Amplifier session. It does not launch a process.
func (strategy *AmplifierRecoveryStrategy) BuildResume(
	request RecoveryResumeRequest,
) RecoveryResumeResult {
	if strategy == nil {
		return newAmplifierResumeRejected(RecoveryDetailLaunchRejected)
	}

	if validation := validateAmplifierFence(request.Claim.Fence); validation != RecoveryValidationValid {
		if validation == RecoveryValidationUnsupported {
			return newAmplifierResumeRejected(RecoveryDetailStrategyUnsupported)
		}
		return newAmplifierResumeRejected(RecoveryDetailLaunchRejected)
	}
	if err := request.Claim.validateRecoveryContract(); err != nil ||
		request.Claim.State != RecoveryClaimStateClaimed {
		return newAmplifierResumeRejected(RecoveryDetailLaunchRejected)
	}

	if request.Capture.Schema != RecoveryCaptureSchemaV1 ||
		request.Capture.Version != RecoveryCaptureSchemaVersion {
		return newAmplifierResumeRejected(RecoveryDetailSchemaIncompatible)
	}
	if request.Capture.StrategyID != RecoveryStrategyAmplifier ||
		!allowedAmplifierCaptureSource(request.Capture.Source) {
		return newAmplifierResumeRejected(RecoveryDetailStrategyUnsupported)
	}
	if !validAmplifierWorkingDirectoryBinding(request.Capture.WorkingDirectory) {
		return newAmplifierResumeRejected(RecoveryDetailWorkingDirectoryInvalid)
	}
	if validateAmplifierCapture(request.Capture) != amplifierCaptureProblemNone ||
		!capturesMatchFence(request.Claim.Fence, request.Capture) {
		return newAmplifierResumeRejected(RecoveryDetailCaptureInvalid)
	}
	if err := validateAmplifierStoredExecutable(strategy.executable); err != nil {
		return newAmplifierResumeRejected(RecoveryDetailLaunchRejected)
	}

	argv, err := NewRecoveryArgv([]RecoveryArgument{
		"session",
		"resume",
		"--no-history",
		RecoveryArgument(request.Capture.SessionID),
	})
	if err != nil {
		return newAmplifierResumeRejected(RecoveryDetailLaunchRejected)
	}
	launch := RecoveryLaunchSpec{
		Executable:       strategy.executable,
		Argv:             argv,
		CWD:              request.Capture.WorkingDirectory.Directory,
		EnvironmentDelta: RecoveryEnvironmentDelta{},
	}
	if err := launch.validateRecoveryContract(); err != nil {
		return newAmplifierResumeRejected(RecoveryDetailLaunchRejected)
	}
	return RecoveryResumeResult{
		State:      RecoveryResumeConstructionReady,
		Launch:     &launch,
		DetailCode: RecoveryDetailNone,
	}
}

// ValidateObservedIdentity compares post-launch daemon evidence without
// normalizing either the session ID or working directory.
func (strategy *AmplifierRecoveryStrategy) ValidateObservedIdentity(
	request RecoveryObservedIdentityRequest,
) RecoveryObservedIdentityResult {
	if strategy == nil {
		return newAmplifierObservedIdentityResult(RecoveryValidationMalformed)
	}
	captureValidation := strategy.ValidateCapture(RecoveryCaptureValidationRequest{
		ExpectedFence: request.ExpectedFence,
		Capture:       request.Capture,
	})
	if captureValidation.Validation != RecoveryValidationValid {
		return RecoveryObservedIdentityResult{
			Validation: captureValidation.Validation,
			DetailCode: captureValidation.DetailCode,
		}
	}

	if !canonicalAmplifierUUID(request.Observed.SessionID) ||
		!canonicalAmplifierWorkingDirectory(request.Observed.WorkingDirectory) ||
		request.Observed.ObservedAt.IsZero() {
		return newAmplifierObservedIdentityResult(RecoveryValidationMalformed)
	}
	if request.Observed.ObservedAt.Before(request.Capture.CapturedAt) {
		return newAmplifierObservedIdentityResult(RecoveryValidationStale)
	}
	if request.Observed.SessionID != request.Capture.SessionID ||
		request.Observed.WorkingDirectory != request.Capture.WorkingDirectory.Directory {
		return newAmplifierObservedIdentityResult(RecoveryValidationMismatched)
	}
	return newAmplifierObservedIdentityResult(RecoveryValidationValid)
}

// Correlate finds an exact Amplifier session only when one and only one safe
// candidate in the CWD-derived project namespace proves the identity.
func (strategy *AmplifierRecoveryStrategy) Correlate(
	request AmplifierCorrelationRequest,
) RecoveryCaptureResult {
	capturedAt := time.Now().UTC()
	if strategy == nil {
		return newAmplifierCaptureResult(RecoveryValidationMalformed, nil)
	}
	if validation := validateAmplifierFence(request.Fence); validation != RecoveryValidationValid {
		return newAmplifierCaptureResult(validation, nil)
	}
	if !validAmplifierWorkingDirectoryBinding(request.WorkingDirectory) ||
		request.PaneLaunchedAt.IsZero() ||
		request.ObservedAt.IsZero() ||
		request.PaneLaunchedAt.After(request.WorkingDirectory.ObservedAt) ||
		request.WorkingDirectory.ObservedAt.After(request.ObservedAt) ||
		request.ObservedAt.After(capturedAt) {
		return newAmplifierCaptureResult(RecoveryValidationMalformed, nil)
	}

	owner, err := strategy.currentProjectsRootOwner()
	if err != nil {
		return newAmplifierCaptureResult(RecoveryValidationMalformed, nil)
	}
	root, rootState, _ := openAmplifierSafePath(strategy.projectsRoot, true, owner)
	if rootState != amplifierPathStable {
		return amplifierCorrelationPathFailure(rootState, false)
	}

	slug := amplifierProjectSlug(string(request.WorkingDirectory.Directory))
	if slug == "" {
		return finishAmplifierCorrelation(
			newAmplifierCaptureResult(RecoveryValidationMalformed, nil),
			root,
		)
	}
	projectPath := filepath.Join(strategy.projectsRoot, slug)
	sessionsPath := filepath.Join(projectPath, "sessions")
	if filepath.Base(projectPath) != slug ||
		amplifierProjectSlug(string(request.WorkingDirectory.Directory)) != slug ||
		!amplifierPathWithin(strategy.projectsRoot, projectPath) ||
		!amplifierPathWithin(strategy.projectsRoot, sessionsPath) {
		return finishAmplifierCorrelation(
			newAmplifierCaptureResult(RecoveryValidationMalformed, nil),
			root,
		)
	}

	project, projectState, _ := openAmplifierSafePath(projectPath, true, owner)
	if projectState != amplifierPathStable {
		return finishAmplifierCorrelation(
			amplifierCorrelationPathFailure(projectState, true),
			root,
		)
	}
	sessions, sessionsState, _ := openAmplifierSafePath(sessionsPath, true, owner)
	if sessionsState != amplifierPathStable {
		return finishAmplifierCorrelation(
			amplifierCorrelationPathFailure(sessionsState, true),
			project,
			root,
		)
	}

	windowStart := request.PaneLaunchedAt.Add(-amplifierCorrelationSkew)
	windowEnd := request.ObservedAt.Add(amplifierCorrelationSkew)
	transcriptBudget := amplifierTranscriptBudget{
		remainingBytes: amplifierCorrelationMaxTranscriptAttemptBytes,
		remainingLines: amplifierCorrelationMaxTranscriptAttemptLines,
	}
	candidates, enumerationState := collectAmplifierCandidates(
		sessions,
		request.WorkingDirectory.Directory,
		slug,
		owner,
		windowStart,
		windowEnd,
		&transcriptBudget,
	)
	if enumerationState != amplifierCandidateEvidenceValid {
		return finishAmplifierCorrelation(
			newAmplifierCaptureResult(RecoveryValidationAmbiguous, nil),
			sessions,
			project,
			root,
		)
	}

	validCandidates := make([]amplifierCandidateEvidence, 0, 1)
	invalidCandidates := 0
	for _, candidate := range candidates {
		if candidate.state == amplifierCandidateEvidenceAmbiguous && len(candidate.times) == 0 {
			return finishAmplifierCorrelation(
				newAmplifierCaptureResult(RecoveryValidationAmbiguous, nil),
				sessions,
				project,
				root,
			)
		}
		if candidate.relevant(windowStart, windowEnd) {
			switch candidate.state {
			case amplifierCandidateEvidenceValid:
				validCandidates = append(validCandidates, candidate)
			case amplifierCandidateEvidenceInvalid:
				invalidCandidates++
			default:
				return finishAmplifierCorrelation(
					newAmplifierCaptureResult(RecoveryValidationAmbiguous, nil),
					sessions,
					project,
					root,
				)
			}
		}
	}

	var result RecoveryCaptureResult
	switch {
	case len(validCandidates) == 0 && invalidCandidates == 0:
		result = newAmplifierCaptureResult(RecoveryValidationMissing, nil)
	case len(validCandidates) == 1 && invalidCandidates == 0:
		candidate := validCandidates[0]
		capture := ExactSessionCapture{
			Schema:     RecoveryCaptureSchemaV1,
			Version:    RecoveryCaptureSchemaVersion,
			Pane:       request.Fence.Pane,
			StrategyID: RecoveryStrategyAmplifier,
			Source:     RecoveryCaptureSourceVerifiedCorrelation,
			SessionID:  candidate.sessionID,
			WorkingDirectory: RecoveryWorkingDirectoryBinding{
				Directory:  request.WorkingDirectory.Directory,
				Validation: RecoveryValidationValid,
				ObservedAt: request.WorkingDirectory.ObservedAt,
			},
			RootGeneration: request.Fence.RootProcessGeneration,
			CaptureEpoch:   request.Fence.CaptureEpoch,
			ObservedAt:     request.ObservedAt,
			CapturedAt:     capturedAt,
		}
		result = newAmplifierCaptureResult(RecoveryValidationValid, &capture)
	case len(validCandidates) == 0 && invalidCandidates == 1:
		result = newAmplifierCaptureResult(RecoveryValidationMalformed, nil)
	default:
		result = newAmplifierCaptureResult(RecoveryValidationAmbiguous, nil)
	}
	return finishAmplifierCorrelation(result, sessions, project, root)
}

type amplifierCaptureProblem uint8

const (
	amplifierCaptureProblemNone amplifierCaptureProblem = iota
	amplifierCaptureProblemMalformed
	amplifierCaptureProblemUnsupported
	amplifierCaptureProblemWorkingDirectory
)

func validateAmplifierFence(fence RecoveryFence) RecoveryValidationState {
	if err := fence.Pane.validateRecoveryContract(); err != nil ||
		fence.Generation == 0 ||
		fence.RootProcessGeneration == 0 ||
		fence.CaptureEpoch == 0 {
		return RecoveryValidationMalformed
	}
	if fence.StrategyID != RecoveryStrategyAmplifier {
		return RecoveryValidationUnsupported
	}
	return RecoveryValidationValid
}

func validateAmplifierCapture(capture ExactSessionCapture) amplifierCaptureProblem {
	if capture.Schema != RecoveryCaptureSchemaV1 ||
		capture.Version != RecoveryCaptureSchemaVersion {
		return amplifierCaptureProblemMalformed
	}
	if capture.StrategyID != RecoveryStrategyAmplifier ||
		!allowedAmplifierCaptureSource(capture.Source) {
		return amplifierCaptureProblemUnsupported
	}
	if err := capture.Pane.validateRecoveryContract(); err != nil ||
		!canonicalAmplifierUUID(capture.SessionID) ||
		capture.RootGeneration == 0 ||
		capture.CaptureEpoch == 0 {
		return amplifierCaptureProblemMalformed
	}
	if !validAmplifierWorkingDirectoryBinding(capture.WorkingDirectory) {
		return amplifierCaptureProblemWorkingDirectory
	}
	if capture.ObservedAt.IsZero() ||
		capture.CapturedAt.IsZero() ||
		capture.WorkingDirectory.ObservedAt.After(capture.ObservedAt) ||
		capture.ObservedAt.After(capture.CapturedAt) {
		return amplifierCaptureProblemMalformed
	}
	return amplifierCaptureProblemNone
}

func allowedAmplifierCaptureSource(source RecoveryCaptureSource) bool {
	switch source {
	case RecoveryCaptureSourceLifecycle,
		RecoveryCaptureSourceVerifiedCorrelation,
		RecoveryCaptureSourceExplicitSelection:
		return true
	default:
		return false
	}
}

func canonicalAmplifierUUID(sessionID RecoveryOpaqueSessionID) bool {
	value := string(sessionID)
	if len(value) != 36 {
		return false
	}
	for index := 0; index < len(value); index++ {
		switch index {
		case 8, 13, 18, 23:
			if value[index] != '-' {
				return false
			}
		default:
			if !((value[index] >= '0' && value[index] <= '9') ||
				(value[index] >= 'a' && value[index] <= 'f')) {
				return false
			}
		}
	}
	decoded, err := hex.DecodeString(strings.ReplaceAll(value, "-", ""))
	if err != nil || len(decoded) != 16 {
		return false
	}
	for _, octet := range decoded {
		if octet != 0 {
			return true
		}
	}
	return false
}

func validAmplifierWorkingDirectoryBinding(binding RecoveryWorkingDirectoryBinding) bool {
	if err := binding.validateRecoveryContract(); err != nil ||
		binding.Validation != RecoveryValidationValid {
		return false
	}
	return canonicalAmplifierWorkingDirectory(binding.Directory)
}

func canonicalAmplifierWorkingDirectory(directory RecoveryWorkingDirectory) bool {
	if err := directory.validateRecoveryContract(); err != nil {
		return false
	}
	path := string(directory)
	before, err := os.Lstat(path)
	if err != nil || before.Mode()&os.ModeSymlink != 0 || !before.IsDir() {
		return false
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil || resolved != path {
		return false
	}
	after, err := os.Lstat(path)
	if err != nil ||
		after.Mode()&os.ModeSymlink != 0 ||
		!after.IsDir() ||
		!os.SameFile(before, after) {
		return false
	}
	resolved, err = filepath.EvalSymlinks(path)
	return err == nil && resolved == path
}

func canonicalAmplifierExecutable(executable RecoveryExecutable) (RecoveryExecutable, error) {
	if err := executable.validateRecoveryContract(); err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(string(executable))
	if err != nil {
		return "", fmt.Errorf("recovery: resolve amplifier executable: %w", err)
	}
	canonical := RecoveryExecutable(resolved)
	if err := canonical.validateRecoveryContract(); err != nil {
		return "", err
	}
	if err := validateAmplifierStoredExecutable(canonical); err != nil {
		return "", err
	}
	return canonical, nil
}

func validateAmplifierStoredExecutable(executable RecoveryExecutable) error {
	if err := executable.validateRecoveryContract(); err != nil {
		return err
	}
	resolved, err := filepath.EvalSymlinks(string(executable))
	if err != nil || resolved != string(executable) {
		return fmt.Errorf("recovery: amplifier executable changed")
	}
	info, err := os.Lstat(string(executable))
	if err != nil {
		return fmt.Errorf("recovery: stat amplifier executable: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return fmt.Errorf("recovery: amplifier executable is not a regular file")
	}
	if info.Mode().Perm()&0o022 != 0 {
		return fmt.Errorf("recovery: amplifier executable is group or other writable")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o111 == 0 {
		return fmt.Errorf("recovery: amplifier executable is not executable")
	}
	return nil
}

func canonicalAmplifierProjectsRoot(projectsRoot string) (string, error) {
	if err := validateAbsoluteCleanPath(
		projectsRoot,
		RecoveryMaxWorkingDirectoryBytes,
		"Amplifier projects root",
	); err != nil {
		return "", err
	}
	owner, ok := amplifierCurrentEUID()
	if !ok {
		return "", fmt.Errorf("recovery: current effective UID is unavailable")
	}
	resolved, err := filepath.EvalSymlinks(projectsRoot)
	if err != nil {
		return "", fmt.Errorf("recovery: resolve Amplifier projects root: %w", err)
	}
	if err := validateAbsoluteCleanPath(
		resolved,
		RecoveryMaxWorkingDirectoryBytes,
		"Amplifier projects root",
	); err != nil {
		return "", err
	}
	info, err := os.Lstat(resolved)
	if err != nil {
		return "", fmt.Errorf("recovery: stat Amplifier projects root: %w", err)
	}
	if !amplifierSafePathInfo(info, true, owner) {
		return "", fmt.Errorf("recovery: Amplifier projects root is unsafe")
	}
	return resolved, nil
}

func (strategy *AmplifierRecoveryStrategy) currentProjectsRootOwner() (uint64, error) {
	owner, ok := amplifierCurrentEUID()
	if !ok {
		return 0, fmt.Errorf("recovery: current effective UID is unavailable")
	}
	if err := validateAbsoluteCleanPath(
		strategy.projectsRoot,
		RecoveryMaxWorkingDirectoryBytes,
		"Amplifier projects root",
	); err != nil {
		return 0, err
	}
	resolved, err := filepath.EvalSymlinks(strategy.projectsRoot)
	if err != nil || resolved != strategy.projectsRoot {
		return 0, fmt.Errorf("recovery: Amplifier projects root changed")
	}
	info, err := os.Lstat(strategy.projectsRoot)
	if err != nil {
		return 0, fmt.Errorf("recovery: stat Amplifier projects root: %w", err)
	}
	if !amplifierSafePathInfo(info, true, owner) {
		return 0, fmt.Errorf("recovery: Amplifier projects root is unsafe")
	}
	return owner, nil
}

func amplifierCurrentEUID() (uint64, bool) {
	uid := os.Geteuid()
	if uid < 0 {
		return 0, false
	}
	return uint64(uid), true
}

func amplifierFileOwner(info os.FileInfo) (uint64, bool) {
	if info == nil || info.Sys() == nil {
		return 0, false
	}
	value := reflect.ValueOf(info.Sys())
	for value.IsValid() && (value.Kind() == reflect.Interface || value.Kind() == reflect.Pointer) {
		if value.IsNil() {
			return 0, false
		}
		value = value.Elem()
	}
	if !value.IsValid() || value.Kind() != reflect.Struct {
		return 0, false
	}
	uid := value.FieldByName("Uid")
	if !uid.IsValid() {
		return 0, false
	}
	switch uid.Kind() {
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return uid.Uint(), true
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		if uid.Int() < 0 {
			return 0, false
		}
		return uint64(uid.Int()), true
	default:
		return 0, false
	}
}

type amplifierPathState uint8

const (
	amplifierPathStable amplifierPathState = iota + 1
	amplifierPathMissing
	amplifierPathUnsafe
	amplifierPathUnstable
)

type amplifierOpenedPath struct {
	path      string
	file      *os.File
	initial   os.FileInfo
	owner     uint64
	directory bool
}

func openAmplifierSafePath(
	path string,
	directory bool,
	owner uint64,
) (*amplifierOpenedPath, amplifierPathState, os.FileInfo) {
	before, err := os.Lstat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, amplifierPathMissing, nil
		}
		return nil, amplifierPathUnsafe, nil
	}
	if !amplifierSafePathInfo(before, directory, owner) {
		return nil, amplifierPathUnsafe, before
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, amplifierPathUnstable, before
	}
	opened, err := file.Stat()
	if err != nil ||
		!amplifierSafePathInfo(opened, directory, owner) ||
		!os.SameFile(before, opened) ||
		!sameAmplifierFileState(before, opened) {
		_ = file.Close()
		return nil, amplifierPathUnstable, before
	}
	return &amplifierOpenedPath{
		path:      path,
		file:      file,
		initial:   opened,
		owner:     owner,
		directory: directory,
	}, amplifierPathStable, before
}

func (opened *amplifierOpenedPath) finish() amplifierPathState {
	if opened == nil || opened.file == nil {
		return amplifierPathUnstable
	}
	file := opened.file
	opened.file = nil

	final, err := file.Stat()
	state := amplifierPathStable
	if err != nil ||
		!amplifierSafePathInfo(final, opened.directory, opened.owner) ||
		!sameAmplifierFileState(opened.initial, final) {
		state = amplifierPathUnstable
	}
	current, lstatErr := os.Lstat(opened.path)
	if err != nil ||
		lstatErr != nil ||
		!amplifierSafePathInfo(current, opened.directory, opened.owner) ||
		!os.SameFile(final, current) ||
		!sameAmplifierFileState(opened.initial, current) {
		state = amplifierPathUnstable
	}
	if closeErr := file.Close(); closeErr != nil {
		state = amplifierPathUnstable
	}
	return state
}

func amplifierSafePathInfo(info os.FileInfo, directory bool, owner uint64) bool {
	if info == nil || info.Mode()&os.ModeSymlink != 0 {
		return false
	}
	if directory {
		if !info.IsDir() {
			return false
		}
	} else if !info.Mode().IsRegular() {
		return false
	}
	if info.Mode().Perm()&0o022 != 0 {
		return false
	}
	uid, ok := amplifierFileOwner(info)
	return ok && uid == owner
}

func sameAmplifierFileState(left, right os.FileInfo) bool {
	if left == nil ||
		right == nil ||
		left.Mode() != right.Mode() ||
		left.Size() != right.Size() ||
		!left.ModTime().Equal(right.ModTime()) {
		return false
	}
	leftOwner, leftOK := amplifierFileOwner(left)
	rightOwner, rightOK := amplifierFileOwner(right)
	return leftOK && rightOK && leftOwner == rightOwner
}

func finishAmplifierCorrelation(
	result RecoveryCaptureResult,
	paths ...*amplifierOpenedPath,
) RecoveryCaptureResult {
	stable := true
	for _, path := range paths {
		if path != nil && path.finish() != amplifierPathStable {
			stable = false
		}
	}
	if !stable {
		return newAmplifierCaptureResult(RecoveryValidationAmbiguous, nil)
	}
	return result
}

func amplifierCorrelationPathFailure(
	state amplifierPathState,
	missingIsCaptureMissing bool,
) RecoveryCaptureResult {
	switch state {
	case amplifierPathMissing:
		if missingIsCaptureMissing {
			return newAmplifierCaptureResult(RecoveryValidationMissing, nil)
		}
		return newAmplifierCaptureResult(RecoveryValidationMalformed, nil)
	case amplifierPathUnstable:
		return newAmplifierCaptureResult(RecoveryValidationAmbiguous, nil)
	default:
		return newAmplifierCaptureResult(RecoveryValidationMalformed, nil)
	}
}

func amplifierProjectSlug(directory string) string {
	slug := strings.NewReplacer("/", "-", "\\", "-", ":", "").Replace(directory)
	if !strings.HasPrefix(slug, "-") {
		slug = "-" + slug
	}
	return slug
}

func amplifierPathWithin(root, path string) bool {
	relative, err := filepath.Rel(root, path)
	if err != nil || relative == "." || filepath.IsAbs(relative) {
		return false
	}
	return relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

type amplifierCandidateEvidenceState uint8

const (
	amplifierCandidateEvidenceValid amplifierCandidateEvidenceState = iota + 1
	amplifierCandidateEvidenceInvalid
	amplifierCandidateEvidenceAmbiguous
)

type amplifierCandidateEvidence struct {
	sessionID RecoveryOpaqueSessionID
	state     amplifierCandidateEvidenceState
	times     []time.Time
}

func (candidate amplifierCandidateEvidence) relevant(start, end time.Time) bool {
	for _, timestamp := range candidate.times {
		if !timestamp.Before(start) && !timestamp.After(end) {
			return true
		}
	}
	return false
}

func collectAmplifierCandidates(
	sessions *amplifierOpenedPath,
	workingDirectory RecoveryWorkingDirectory,
	slug string,
	owner uint64,
	windowStart time.Time,
	windowEnd time.Time,
	transcriptBudget *amplifierTranscriptBudget,
) ([]amplifierCandidateEvidence, amplifierCandidateEvidenceState) {
	var candidates []amplifierCandidateEvidence
	entryCount := 0
	candidateDirectoryCount := 0
	for {
		readCount := amplifierCorrelationDirectoryReadBatch
		remainingWithSentinel := amplifierCorrelationMaxDirectoryEntries + 1 - entryCount
		if remainingWithSentinel < readCount {
			readCount = remainingWithSentinel
		}
		entries, err := sessions.file.ReadDir(readCount)
		for _, entry := range entries {
			entryCount++
			if entryCount > amplifierCorrelationMaxDirectoryEntries {
				return nil, amplifierCandidateEvidenceAmbiguous
			}
			candidatePath := filepath.Join(sessions.path, entry.Name())
			info, lstatErr := os.Lstat(candidatePath)
			if lstatErr != nil {
				return nil, amplifierCandidateEvidenceAmbiguous
			}
			sessionID := RecoveryOpaqueSessionID(entry.Name())
			if info.IsDir() {
				candidateDirectoryCount++
				if candidateDirectoryCount > amplifierCorrelationMaxCandidateDirectories {
					return nil, amplifierCandidateEvidenceAmbiguous
				}
				if canonicalAmplifierUUID(sessionID) {
					candidates = append(candidates, inspectAmplifierCandidate(
						candidatePath,
						sessionID,
						workingDirectory,
						slug,
						owner,
						windowStart,
						windowEnd,
						transcriptBudget,
					))
				}
			} else if canonicalAmplifierUUID(sessionID) {
				candidates = append(candidates, amplifierCandidateEvidence{
					sessionID: sessionID,
					state:     amplifierCandidateEvidenceInvalid,
					times:     []time.Time{info.ModTime()},
				})
			}
		}
		if err == io.EOF {
			return candidates, amplifierCandidateEvidenceValid
		}
		if err != nil {
			return nil, amplifierCandidateEvidenceAmbiguous
		}
	}
}

func inspectAmplifierCandidate(
	path string,
	sessionID RecoveryOpaqueSessionID,
	workingDirectory RecoveryWorkingDirectory,
	slug string,
	owner uint64,
	windowStart time.Time,
	windowEnd time.Time,
	transcriptBudget *amplifierTranscriptBudget,
) amplifierCandidateEvidence {
	candidate := amplifierCandidateEvidence{sessionID: sessionID}
	if filepath.Base(path) != string(sessionID) {
		candidate.state = amplifierCandidateEvidenceAmbiguous
		return candidate
	}
	directory, directoryState, directoryInfo := openAmplifierSafePath(path, true, owner)
	if directoryInfo != nil {
		candidate.times = append(candidate.times, directoryInfo.ModTime())
	}
	switch directoryState {
	case amplifierPathStable:
	case amplifierPathUnstable, amplifierPathMissing:
		candidate.state = amplifierCandidateEvidenceAmbiguous
		return candidate
	default:
		candidate.state = amplifierCandidateEvidenceInvalid
		return candidate
	}

	metadata := inspectAmplifierMetadata(
		filepath.Join(path, amplifierMetadataFilename),
		sessionID,
		workingDirectory,
		slug,
		owner,
	)
	candidate.times = append(candidate.times, metadata.times...)
	candidate.times = appendAmplifierTranscriptTimes(candidate.times, path)
	if metadata.state != amplifierCandidateEvidenceValid ||
		!candidate.relevant(windowStart, windowEnd) {
		candidate.state = metadata.state
		if directory.finish() != amplifierPathStable {
			candidate.state = amplifierCandidateEvidenceAmbiguous
		}
		return candidate
	}

	transcript := inspectAmplifierTranscript(path, owner, transcriptBudget)
	candidate.times = append(candidate.times, transcript.times...)
	if directory.finish() != amplifierPathStable {
		candidate.state = amplifierCandidateEvidenceAmbiguous
		return candidate
	}
	if metadata.state == amplifierCandidateEvidenceAmbiguous ||
		transcript.state == amplifierCandidateEvidenceAmbiguous {
		candidate.state = amplifierCandidateEvidenceAmbiguous
		return candidate
	}
	if metadata.state == amplifierCandidateEvidenceValid &&
		transcript.state == amplifierCandidateEvidenceValid {
		candidate.state = amplifierCandidateEvidenceValid
		return candidate
	}
	candidate.state = amplifierCandidateEvidenceInvalid
	return candidate
}

type amplifierMetadata struct {
	sessionID        RecoveryOpaqueSessionID
	workingDirectory RecoveryWorkingDirectory
	bundle           string
	created          time.Time
}

type amplifierMetadataEvidence struct {
	state amplifierCandidateEvidenceState
	times []time.Time
}

func inspectAmplifierMetadata(
	path string,
	expectedSessionID RecoveryOpaqueSessionID,
	expectedWorkingDirectory RecoveryWorkingDirectory,
	expectedSlug string,
	owner uint64,
) amplifierMetadataEvidence {
	file, state, info := openAmplifierSafePath(path, false, owner)
	if info != nil {
		result := amplifierMetadataEvidence{times: []time.Time{info.ModTime()}}
		switch state {
		case amplifierPathStable:
			size := file.initial.Size()
			if size < 0 || size > amplifierCorrelationMaxMetadataBytes {
				if file.finish() != amplifierPathStable {
					result.state = amplifierCandidateEvidenceAmbiguous
				} else {
					result.state = amplifierCandidateEvidenceAmbiguous
				}
				return result
			}
			data, err := io.ReadAll(io.LimitReader(file.file, size))
			metadata, parseState := parseAmplifierMetadata(data)
			if file.finish() != amplifierPathStable {
				result.state = amplifierCandidateEvidenceAmbiguous
				return result
			}
			if parseState == amplifierMetadataParseDepthExceeded {
				result.state = amplifierCandidateEvidenceAmbiguous
				return result
			}
			if err != nil || parseState != amplifierMetadataParseValid {
				result.state = amplifierCandidateEvidenceInvalid
				return result
			}
			result.times = append(result.times, metadata.created)
			if !canonicalAmplifierUUID(metadata.sessionID) ||
				!canonicalAmplifierWorkingDirectory(metadata.workingDirectory) ||
				!validAmplifierBundle(metadata.bundle) {
				result.state = amplifierCandidateEvidenceInvalid
				return result
			}
			if metadata.sessionID != expectedSessionID ||
				metadata.workingDirectory != expectedWorkingDirectory ||
				amplifierProjectSlug(string(metadata.workingDirectory)) != expectedSlug {
				result.state = amplifierCandidateEvidenceAmbiguous
				return result
			}
			result.state = amplifierCandidateEvidenceValid
			return result
		case amplifierPathUnstable:
			result.state = amplifierCandidateEvidenceAmbiguous
		default:
			result.state = amplifierCandidateEvidenceInvalid
		}
		return result
	}
	switch state {
	case amplifierPathUnstable:
		return amplifierMetadataEvidence{state: amplifierCandidateEvidenceAmbiguous}
	default:
		return amplifierMetadataEvidence{state: amplifierCandidateEvidenceInvalid}
	}
}

type amplifierMetadataParseState uint8

const (
	amplifierMetadataParseValid amplifierMetadataParseState = iota + 1
	amplifierMetadataParseMalformed
	amplifierMetadataParseDepthExceeded
)

func parseAmplifierMetadata(data []byte) (amplifierMetadata, amplifierMetadataParseState) {
	if !utf8.Valid(data) {
		return amplifierMetadata{}, amplifierMetadataParseMalformed
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	value, err := decodeAmplifierJSONValue(decoder, 0)
	if err != nil {
		if errors.Is(err, errAmplifierMetadataDepthExceeded) {
			return amplifierMetadata{}, amplifierMetadataParseDepthExceeded
		}
		return amplifierMetadata{}, amplifierMetadataParseMalformed
	}
	object, ok := value.(map[string]any)
	if !ok {
		return amplifierMetadata{}, amplifierMetadataParseMalformed
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return amplifierMetadata{}, amplifierMetadataParseMalformed
	}
	sessionID, sessionOK := object["session_id"].(string)
	workingDirectory, directoryOK := object["working_dir"].(string)
	bundle, bundleOK := object["bundle"].(string)
	created, createdOK := object["created"].(string)
	if !sessionOK || !directoryOK || !bundleOK || !createdOK {
		return amplifierMetadata{}, amplifierMetadataParseMalformed
	}
	createdAt, err := time.Parse(time.RFC3339Nano, created)
	if err != nil {
		return amplifierMetadata{}, amplifierMetadataParseMalformed
	}
	return amplifierMetadata{
		sessionID:        RecoveryOpaqueSessionID(sessionID),
		workingDirectory: RecoveryWorkingDirectory(workingDirectory),
		bundle:           bundle,
		created:          createdAt,
	}, amplifierMetadataParseValid
}

func decodeAmplifierJSONValue(decoder *json.Decoder, depth int) (any, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	delimiter, isDelimiter := token.(json.Delim)
	if !isDelimiter {
		return token, nil
	}
	if depth >= amplifierCorrelationMaxMetadataDepth {
		return nil, errAmplifierMetadataDepthExceeded
	}
	switch delimiter {
	case '{':
		object := make(map[string]any)
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return nil, err
			}
			key, ok := keyToken.(string)
			if !ok {
				return nil, fmt.Errorf("recovery: metadata object key is not a string")
			}
			if _, duplicate := object[key]; duplicate {
				return nil, fmt.Errorf("recovery: duplicate metadata key")
			}
			value, err := decodeAmplifierJSONValue(decoder, depth+1)
			if err != nil {
				return nil, err
			}
			object[key] = value
		}
		end, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		if end != json.Delim('}') {
			return nil, fmt.Errorf("recovery: metadata object is unterminated")
		}
		return object, nil
	case '[':
		array := make([]any, 0)
		for decoder.More() {
			value, err := decodeAmplifierJSONValue(decoder, depth+1)
			if err != nil {
				return nil, err
			}
			array = append(array, value)
		}
		end, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		if end != json.Delim(']') {
			return nil, fmt.Errorf("recovery: metadata array is unterminated")
		}
		return array, nil
	default:
		return nil, fmt.Errorf("recovery: invalid metadata delimiter")
	}
}

func validAmplifierBundle(bundle string) bool {
	trimmed := strings.TrimSpace(bundle)
	if trimmed == "" {
		return false
	}
	normalized := strings.ToLower(trimmed)
	return normalized != "unknown" && normalized != "bundle:unknown"
}

type amplifierTranscriptEvidence struct {
	state amplifierCandidateEvidenceState
	times []time.Time
}

type amplifierTranscriptFileState uint8

const (
	amplifierTranscriptFileMissing amplifierTranscriptFileState = iota + 1
	amplifierTranscriptFileValid
	amplifierTranscriptFileMalformed
	amplifierTranscriptFileUnsafe
	amplifierTranscriptFileUnstable
	amplifierTranscriptFileLimitExceeded
)

type amplifierTranscriptBudget struct {
	remainingBytes int64
	remainingLines int
}

func (budget *amplifierTranscriptBudget) reserveBytes(size int64) bool {
	if budget == nil || size < 0 || size > budget.remainingBytes {
		return false
	}
	budget.remainingBytes -= size
	return true
}

func (budget *amplifierTranscriptBudget) reserveLine() bool {
	if budget == nil || budget.remainingLines <= 0 {
		return false
	}
	budget.remainingLines--
	return true
}

func appendAmplifierTranscriptTimes(times []time.Time, path string) []time.Time {
	for _, name := range []string{
		amplifierTranscriptFilename,
		amplifierTranscriptBackupFilename,
	} {
		info, err := os.Lstat(filepath.Join(path, name))
		if err == nil {
			times = append(times, info.ModTime())
		}
	}
	return times
}

func inspectAmplifierTranscript(
	path string,
	owner uint64,
	budget *amplifierTranscriptBudget,
) amplifierTranscriptEvidence {
	primaryPath := filepath.Join(path, amplifierTranscriptFilename)
	backupPath := filepath.Join(path, amplifierTranscriptBackupFilename)
	primaryState, primaryTimes := inspectAmplifierTranscriptFile(primaryPath, owner, budget)
	result := amplifierTranscriptEvidence{times: primaryTimes}

	if primaryState == amplifierTranscriptFileValid {
		backupState, backupTimes := inspectAmplifierTranscriptFile(backupPath, owner, budget)
		result.times = append(result.times, backupTimes...)
		switch backupState {
		case amplifierTranscriptFileUnstable, amplifierTranscriptFileLimitExceeded:
			result.state = amplifierCandidateEvidenceAmbiguous
		case amplifierTranscriptFileUnsafe:
			result.state = amplifierCandidateEvidenceInvalid
		default:
			result.state = amplifierCandidateEvidenceValid
		}
		return result
	}
	if primaryState == amplifierTranscriptFileUnstable {
		result.state = amplifierCandidateEvidenceAmbiguous
		return result
	}
	if primaryState == amplifierTranscriptFileLimitExceeded {
		result.state = amplifierCandidateEvidenceAmbiguous
		return result
	}
	if primaryState == amplifierTranscriptFileUnsafe {
		backupState, backupTimes := inspectAmplifierTranscriptFile(backupPath, owner, budget)
		result.times = append(result.times, backupTimes...)
		if backupState == amplifierTranscriptFileUnstable ||
			backupState == amplifierTranscriptFileLimitExceeded {
			result.state = amplifierCandidateEvidenceAmbiguous
		} else {
			result.state = amplifierCandidateEvidenceInvalid
		}
		return result
	}

	backupState, backupTimes := inspectAmplifierTranscriptFile(backupPath, owner, budget)
	result.times = append(result.times, backupTimes...)
	switch backupState {
	case amplifierTranscriptFileValid:
		result.state = amplifierCandidateEvidenceValid
	case amplifierTranscriptFileUnstable, amplifierTranscriptFileLimitExceeded:
		result.state = amplifierCandidateEvidenceAmbiguous
	default:
		result.state = amplifierCandidateEvidenceInvalid
	}
	return result
}

func inspectAmplifierTranscriptFile(
	path string,
	owner uint64,
	budget *amplifierTranscriptBudget,
) (amplifierTranscriptFileState, []time.Time) {
	file, state, info := openAmplifierSafePath(path, false, owner)
	var times []time.Time
	if info != nil {
		times = append(times, info.ModTime())
	}
	switch state {
	case amplifierPathMissing:
		return amplifierTranscriptFileMissing, times
	case amplifierPathUnsafe:
		return amplifierTranscriptFileUnsafe, times
	case amplifierPathUnstable:
		return amplifierTranscriptFileUnstable, times
	}
	size := file.initial.Size()
	if size < 0 ||
		size > amplifierCorrelationMaxTranscriptFileBytes ||
		!budget.reserveBytes(size) {
		if file.finish() != amplifierPathStable {
			return amplifierTranscriptFileUnstable, times
		}
		return amplifierTranscriptFileLimitExceeded, times
	}
	parseState := parseAmplifierTranscript(io.LimitReader(file.file, size), budget)
	if file.finish() != amplifierPathStable {
		return amplifierTranscriptFileUnstable, times
	}
	switch parseState {
	case amplifierTranscriptParseValid:
		return amplifierTranscriptFileValid, times
	case amplifierTranscriptParseLimitExceeded:
		return amplifierTranscriptFileLimitExceeded, times
	default:
		return amplifierTranscriptFileMalformed, times
	}
}

type amplifierTranscriptParseState uint8

const (
	amplifierTranscriptParseValid amplifierTranscriptParseState = iota + 1
	amplifierTranscriptParseMalformed
	amplifierTranscriptParseLimitExceeded
)

func parseAmplifierTranscript(
	input io.Reader,
	budget *amplifierTranscriptBudget,
) amplifierTranscriptParseState {
	reader := bufio.NewReaderSize(input, amplifierCorrelationTranscriptReadBufferBytes)
	objects := 0
	physicalLines := 0
	for {
		line, err, exceeded := readAmplifierTranscriptRecord(reader)
		if len(line) > 0 || exceeded {
			if !budget.reserveLine() {
				return amplifierTranscriptParseLimitExceeded
			}
			physicalLines++
			if physicalLines > amplifierCorrelationMaxTranscriptFileLines {
				return amplifierTranscriptParseLimitExceeded
			}
		}
		if exceeded {
			return amplifierTranscriptParseLimitExceeded
		}
		if len(line) > 0 {
			trimmed := bytes.TrimSpace(line)
			if len(trimmed) > 0 {
				if !validAmplifierTranscriptObject(trimmed) {
					return amplifierTranscriptParseMalformed
				}
				objects++
			}
		}
		if err == io.EOF {
			if objects == 0 {
				return amplifierTranscriptParseMalformed
			}
			return amplifierTranscriptParseValid
		}
		if err != nil {
			return amplifierTranscriptParseMalformed
		}
	}
}

func readAmplifierTranscriptRecord(
	reader *bufio.Reader,
) ([]byte, error, bool) {
	var record []byte
	for {
		fragment, err := reader.ReadSlice('\n')
		if len(fragment) > amplifierCorrelationMaxTranscriptRecordBytes-len(record) {
			return nil, nil, true
		}
		if len(fragment) > 0 {
			required := len(record) + len(fragment)
			if cap(record) < required {
				nextCapacity := cap(record) * 2
				if nextCapacity < required {
					nextCapacity = required
				}
				if nextCapacity > amplifierCorrelationMaxTranscriptRecordBytes {
					nextCapacity = amplifierCorrelationMaxTranscriptRecordBytes
				}
				grown := make([]byte, len(record), nextCapacity)
				copy(grown, record)
				record = grown
			}
			record = append(record, fragment...)
		}
		switch err {
		case nil:
			return record, nil, false
		case bufio.ErrBufferFull:
			continue
		case io.EOF:
			return record, io.EOF, false
		default:
			return record, err, false
		}
	}
}

func validAmplifierTranscriptObject(data []byte) bool {
	if !utf8.Valid(data) {
		return false
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value map[string]json.RawMessage
	if err := decoder.Decode(&value); err != nil {
		return false
	}
	if value == nil {
		return false
	}
	var extra any
	return decoder.Decode(&extra) == io.EOF
}

func newAmplifierCaptureResult(
	validation RecoveryValidationState,
	capture *ExactSessionCapture,
) RecoveryCaptureResult {
	detail, _ := recoveryDetailForValidationState(validation)
	return RecoveryCaptureResult{
		Validation: validation,
		Capture:    capture,
		DetailCode: detail,
	}
}

func newAmplifierCaptureValidationResult(
	validation RecoveryValidationState,
) RecoveryCaptureValidationResult {
	detail, _ := recoveryDetailForValidationState(validation)
	return RecoveryCaptureValidationResult{
		Validation: validation,
		DetailCode: detail,
	}
}

func newAmplifierObservedIdentityResult(
	validation RecoveryValidationState,
) RecoveryObservedIdentityResult {
	detail, _ := recoveryDetailForValidationState(validation)
	return RecoveryObservedIdentityResult{
		Validation: validation,
		DetailCode: detail,
	}
}

func newAmplifierResumeRejected(detail RecoveryDetailCode) RecoveryResumeResult {
	return RecoveryResumeResult{
		State:      RecoveryResumeConstructionRejected,
		DetailCode: detail,
	}
}
