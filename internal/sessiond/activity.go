package sessiond

import (
	"bytes"
	"os"
	"sync/atomic"
	"time"
)

// ActivityClassification is the daemon-owned safety classification for a pane.
type ActivityClassification string

const (
	ActivityIdle    ActivityClassification = "idle"
	ActivityBusy    ActivityClassification = "busy"
	ActivityUnknown ActivityClassification = "unknown"
)

// ActivityReason is the stable, user-safe reason behind a busy or unknown
// classification. These values are part of the close-warning contract.
type ActivityReason string

const (
	ActivityReasonCommandActive           ActivityReason = "command-active"
	ActivityReasonForegroundProcess       ActivityReason = "foreground-process"
	ActivityReasonCustomCommand           ActivityReason = "custom-command"
	ActivityReasonUnsupportedShell        ActivityReason = "unsupported-shell"
	ActivityReasonUnsupportedPlatform     ActivityReason = "unsupported-platform"
	ActivityReasonMissingLifecycle        ActivityReason = "missing-lifecycle"
	ActivityReasonStaleLifecycle          ActivityReason = "stale-lifecycle"
	ActivityReasonProcessInspectionFailed ActivityReason = "process-inspection-failed"
	ActivityReasonPTYInspectionFailed     ActivityReason = "pty-inspection-failed"
	ActivityReasonConflictingEvidence     ActivityReason = "conflicting-evidence"
)

// ActivityAssessment is a frozen classification for one root-process
// generation. Generation lets a future close transaction bind its decision to
// the exact process whose activity was inspected.
type ActivityAssessment struct {
	Classification ActivityClassification
	Reason         ActivityReason
	Generation     uint64
}

type shellLifecycleSource uint8

const (
	shellLifecycleCustom shellLifecycleSource = iota
	shellLifecycleUnsupported
	shellLifecycleBash
	shellLifecycleZsh
)

type lifecyclePhase uint8

const (
	lifecycleMissing lifecyclePhase = iota
	// lifecyclePromptConstructing is trusted evidence that the shell has begun
	// building a prompt but has not yet emitted its prompt-end marker. It is
	// deliberately not idle: prompt substitutions and hooks can still be
	// running while the root shell owns the foreground process group.
	lifecyclePromptConstructing
	lifecyclePromptActive
	lifecycleCommandActive
	lifecycleConflicting
)

type lifecycleEvidence struct {
	generation uint64
	phase      lifecyclePhase
	observedAt time.Time
}

type lifecycleMarker uint8

const (
	// The prompt-construction marker is emitted before PS1/PROMPT expansion;
	// the prompt marker is embedded at the end of the expanded prompt.
	lifecycleMarkerPromptConstructing lifecycleMarker = iota + 1
	lifecycleMarkerPrompt
	lifecycleMarkerCommand
	lifecycleMarkerConflict
)

const maxLifecycleSequence = 512

var nextProcessGeneration atomic.Uint64

// shellLifecycleParser recognizes authenticated OSC 133 lifecycle markers while
// retaining an incomplete OSC across PTY reads. pending is strictly bounded so
// arbitrary application output cannot grow daemon memory.
type shellLifecycleParser struct {
	token   []byte
	pending []byte
}

func newShellLifecycleParser(token string) shellLifecycleParser {
	return shellLifecycleParser{token: []byte(token)}
}

func (p *shellLifecycleParser) feed(data []byte) []lifecycleMarker {
	if len(p.token) == 0 || len(data) == 0 {
		return nil
	}

	input := data
	if len(p.pending) != 0 {
		combined := make([]byte, 0, len(p.pending)+len(data))
		combined = append(combined, p.pending...)
		combined = append(combined, data...)
		input = combined
		p.pending = nil
	}

	var markers []lifecycleMarker
	oscPrefix := []byte{0x1b, ']'}
	for len(input) != 0 {
		start := bytes.Index(input, oscPrefix)
		if start < 0 {
			// ESC and ']' may be split across reads.
			if input[len(input)-1] == 0x1b {
				p.pending = append(p.pending[:0], 0x1b)
			}
			return markers
		}

		payloadAndRest := input[start+len(oscPrefix):]
		termAt, termLen := oscTerminator(payloadAndRest)
		nestedAt := bytes.Index(payloadAndRest, oscPrefix)
		cancelAt := oscCancellation(payloadAndRest)
		if cancelAt >= 0 &&
			(termAt < 0 || cancelAt < termAt) &&
			(nestedAt < 0 || cancelAt < nestedAt) {
			// CAN/SUB return the terminal parser to ground state.
			input = payloadAndRest[cancelAt+1:]
			continue
		}
		if nestedAt >= 0 &&
			(termAt < 0 || nestedAt < termAt) &&
			(cancelAt < 0 || nestedAt < cancelAt) {
			// A new OSC before the old one terminates is malformed. Resync at
			// the newer prefix so an authenticated lifecycle transition cannot
			// be swallowed by unrelated output.
			markers = append(markers, lifecycleMarkerConflict)
			input = payloadAndRest[nestedAt:]
			continue
		}
		if cancelAt >= 0 && (termAt < 0 || cancelAt < termAt) {
			// CAN/SUB return the terminal parser to ground state.
			input = payloadAndRest[cancelAt+1:]
			continue
		}
		if termAt < 0 {
			candidateLen := len(oscPrefix) + len(payloadAndRest)
			if candidateLen <= maxLifecycleSequence {
				p.pending = make([]byte, 0, candidateLen)
				p.pending = append(p.pending, oscPrefix...)
				p.pending = append(p.pending, payloadAndRest...)
			} else if len(payloadAndRest) != 0 && payloadAndRest[len(payloadAndRest)-1] == 0x1b {
				// Drop an overlong OSC, but retain a possible split prefix.
				p.pending = append(p.pending[:0], 0x1b)
			}
			if candidateLen > maxLifecycleSequence {
				markers = append(markers, lifecycleMarkerConflict)
			}
			return markers
		}

		if len(oscPrefix)+termAt+termLen > maxLifecycleSequence {
			markers = append(markers, lifecycleMarkerConflict)
		} else if marker := p.marker(payloadAndRest[:termAt]); marker != 0 {
			markers = append(markers, marker)
		}
		input = payloadAndRest[termAt+termLen:]
	}
	return markers
}

func oscCancellation(data []byte) int {
	canAt := bytes.IndexByte(data, 0x18)
	subAt := bytes.IndexByte(data, 0x1a)
	switch {
	case canAt < 0:
		return subAt
	case subAt < 0 || canAt < subAt:
		return canAt
	default:
		return subAt
	}
}

func oscTerminator(data []byte) (at, length int) {
	belAt := bytes.IndexByte(data, '\x07')
	stAt := bytes.Index(data, []byte{0x1b, '\\'})
	switch {
	case belAt < 0 && stAt < 0:
		return -1, 0
	case belAt < 0:
		return stAt, 2
	case stAt < 0 || belAt < stAt:
		return belAt, 1
	default:
		return stAt, 2
	}
}

func (p *shellLifecycleParser) marker(payload []byte) lifecycleMarker {
	promptConstructingPrefix := []byte("133;B;")
	promptPrefix := []byte("133;A;")
	commandPrefix := []byte("133;C;")
	switch {
	case bytes.HasPrefix(payload, promptConstructingPrefix):
		value := payload[len(promptConstructingPrefix):]
		if bytes.Equal(value, p.token) {
			return lifecycleMarkerPromptConstructing
		}
	case bytes.HasPrefix(payload, promptPrefix):
		value := payload[len(promptPrefix):]
		if bytes.Equal(value, p.token) {
			return lifecycleMarkerPrompt
		}
	case bytes.HasPrefix(payload, commandPrefix):
		value := payload[len(commandPrefix):]
		if bytes.Equal(value, p.token) {
			return lifecycleMarkerCommand
		}
	}

	// Ignore ordinary OSC 133 produced by applications or unrelated shell
	// integrations. A sequence containing this pane's unexported token but not
	// matching either exact form is authenticated yet contradictory.
	if bytes.HasPrefix(payload, []byte("133;")) && bytes.Contains(payload, p.token) {
		return lifecycleMarkerConflict
	}
	return 0
}

func (p *Pane) bindRootProcess(pid int, source shellLifecycleSource, token string, startedAt time.Time) uint64 {
	generation := nextProcessGeneration.Add(1)
	p.activityMu.Lock()
	p.rootPID = pid
	p.rootGeneration = generation
	p.rootStartedAt = startedAt
	p.rootExited = false
	p.lifecycleSource = source
	p.lifecycleParser = newShellLifecycleParser(token)
	p.lifecycle = lifecycleEvidence{}
	p.lifecycleParsing = false
	p.activityRevision++
	p.activityMu.Unlock()
	return generation
}

func (p *Pane) observeLifecycleData(generation uint64, data []byte, observedAt time.Time) {
	p.activityMu.Lock()
	defer p.activityMu.Unlock()
	if generation != p.rootGeneration || p.rootExited {
		return
	}
	wasParsing := p.lifecycleParsing
	for _, marker := range p.lifecycleParser.feed(data) {
		phase := lifecycleConflicting
		switch marker {
		case lifecycleMarkerPromptConstructing:
			phase = lifecyclePromptConstructing
		case lifecycleMarkerPrompt:
			phase = lifecyclePromptActive
		case lifecycleMarkerCommand:
			phase = lifecycleCommandActive
		case lifecycleMarkerConflict:
			phase = lifecycleConflicting
		}
		p.lifecycle = lifecycleEvidence{
			generation: generation,
			phase:      phase,
			observedAt: observedAt,
		}
		p.activityRevision++
	}
	p.lifecycleParsing = len(p.lifecycleParser.pending) != 0
	if p.lifecycleParsing != wasParsing {
		p.activityRevision++
	}
}

func (p *Pane) markRootExited(generation uint64) {
	p.activityMu.Lock()
	if generation == p.rootGeneration {
		p.rootExited = true
		p.activityRevision++
	}
	p.activityMu.Unlock()
}

type activitySnapshot struct {
	source     shellLifecycleSource
	pid        int
	generation uint64
	startedAt  time.Time
	exited     bool
	ptmx       *os.File
	lifecycle  lifecycleEvidence
	parsing    bool
	revision   uint64
}

func (p *Pane) activitySnapshot() activitySnapshot {
	p.activityMu.Lock()
	defer p.activityMu.Unlock()
	return activitySnapshot{
		source:     p.lifecycleSource,
		pid:        p.rootPID,
		generation: p.rootGeneration,
		startedAt:  p.rootStartedAt,
		exited:     p.rootExited,
		ptmx:       p.ptmx,
		lifecycle:  p.lifecycle,
		parsing:    p.lifecycleParsing,
		revision:   p.activityRevision,
	}
}

// ProcessGeneration returns the stable generation of the pane's current root
// process. A replacement root process receives a new value and starts with no
// retained lifecycle evidence.
func (p *Pane) ProcessGeneration() uint64 {
	p.activityMu.Lock()
	defer p.activityMu.Unlock()
	return p.rootGeneration
}

// ClassifyActivity authoritatively combines root-process identity, foreground
// PTY ownership, and authenticated lifecycle state. It never weakens incomplete
// or failed inspection into idle.
func (p *Pane) ClassifyActivity() ActivityAssessment {
	const maxStableInspectionAttempts = 3
	for range maxStableInspectionAttempts {
		snapshot := p.activitySnapshot()
		if result, done := classifyWithoutInspection(snapshot); done {
			return result
		}

		rootPGRP, err := inspectProcessGroup(snapshot.pid)
		if err != nil || rootPGRP <= 0 {
			return ActivityAssessment{
				Classification: ActivityUnknown,
				Reason:         ActivityReasonProcessInspectionFailed,
				Generation:     snapshot.generation,
			}
		}
		foregroundPGRP, err := inspectForegroundPGRP(snapshot.ptmx)
		if err != nil || foregroundPGRP <= 0 {
			return ActivityAssessment{
				Classification: ActivityUnknown,
				Reason:         ActivityReasonPTYInspectionFailed,
				Generation:     snapshot.generation,
			}
		}
		if !p.activityUnchanged(snapshot) {
			continue
		}

		// Foreground ownership outranks lifecycle state. In particular, stale
		// or absent markers can never hide an external foreground process.
		if foregroundPGRP != rootPGRP {
			return ActivityAssessment{
				Classification: ActivityBusy,
				Reason:         ActivityReasonForegroundProcess,
				Generation:     snapshot.generation,
			}
		}

		result := classifyRootForeground(snapshot)
		if result.Classification != ActivityIdle {
			return result
		}

		// Idle is the destructive fast path, so narrow the process-transition
		// window with a second foreground query and another evidence revision
		// check. Repeated churn degrades to unknown below.
		foregroundPGRP, err = inspectForegroundPGRP(snapshot.ptmx)
		if err != nil || foregroundPGRP <= 0 {
			return ActivityAssessment{
				Classification: ActivityUnknown,
				Reason:         ActivityReasonPTYInspectionFailed,
				Generation:     snapshot.generation,
			}
		}
		if !p.activityUnchanged(snapshot) {
			continue
		}
		if foregroundPGRP != rootPGRP {
			return ActivityAssessment{
				Classification: ActivityBusy,
				Reason:         ActivityReasonForegroundProcess,
				Generation:     snapshot.generation,
			}
		}
		return result
	}

	return ActivityAssessment{
		Classification: ActivityUnknown,
		Reason:         ActivityReasonConflictingEvidence,
		Generation:     p.ProcessGeneration(),
	}
}

func classifyWithoutInspection(snapshot activitySnapshot) (ActivityAssessment, bool) {
	assessment := ActivityAssessment{Classification: ActivityUnknown, Generation: snapshot.generation}
	switch snapshot.source {
	case shellLifecycleCustom:
		assessment.Reason = ActivityReasonCustomCommand
		return assessment, true
	case shellLifecycleUnsupported:
		assessment.Reason = ActivityReasonUnsupportedShell
		return assessment, true
	case shellLifecycleBash, shellLifecycleZsh:
		// Continue with authoritative OS and lifecycle inspection.
	default:
		assessment.Reason = ActivityReasonConflictingEvidence
		return assessment, true
	}
	if !foregroundPGRPSupported() {
		assessment.Reason = ActivityReasonUnsupportedPlatform
		return assessment, true
	}
	if snapshot.exited || snapshot.pid <= 0 {
		assessment.Reason = ActivityReasonProcessInspectionFailed
		return assessment, true
	}
	return ActivityAssessment{}, false
}

func classifyRootForeground(snapshot activitySnapshot) ActivityAssessment {
	assessment := ActivityAssessment{Classification: ActivityUnknown, Generation: snapshot.generation}
	if snapshot.parsing {
		assessment.Reason = ActivityReasonConflictingEvidence
		return assessment
	}

	evidence := snapshot.lifecycle
	if evidence.phase == lifecycleMissing || evidence.observedAt.IsZero() {
		assessment.Reason = ActivityReasonMissingLifecycle
		return assessment
	}
	// Lifecycle is transition state, not a wall-clock lease: an unchanged prompt
	// remains authoritative however long it is displayed. "Stale" means the
	// evidence belongs to a prior root generation (or predates this one).
	if evidence.generation != snapshot.generation || evidence.observedAt.Before(snapshot.startedAt) {
		assessment.Reason = ActivityReasonStaleLifecycle
		return assessment
	}
	if evidence.observedAt.After(time.Now()) {
		assessment.Reason = ActivityReasonConflictingEvidence
		return assessment
	}

	switch evidence.phase {
	case lifecycleCommandActive:
		return ActivityAssessment{
			Classification: ActivityBusy,
			Reason:         ActivityReasonCommandActive,
			Generation:     snapshot.generation,
		}
	case lifecyclePromptActive:
		return ActivityAssessment{
			Classification: ActivityIdle,
			Generation:     snapshot.generation,
		}
	case lifecyclePromptConstructing:
		// The shell owns the foreground process group while rendering a prompt,
		// including synchronous prompt substitutions. Only the marker embedded
		// after expansion can establish idle authority.
		assessment.Reason = ActivityReasonConflictingEvidence
		return assessment
	case lifecycleConflicting:
		assessment.Reason = ActivityReasonConflictingEvidence
		return assessment
	default:
		assessment.Reason = ActivityReasonMissingLifecycle
		return assessment
	}
}

func (p *Pane) activityUnchanged(snapshot activitySnapshot) bool {
	p.activityMu.Lock()
	defer p.activityMu.Unlock()
	return p.rootPID == snapshot.pid &&
		p.rootGeneration == snapshot.generation &&
		p.rootExited == snapshot.exited &&
		p.lifecycleSource == snapshot.source &&
		p.ptmx == snapshot.ptmx &&
		p.activityRevision == snapshot.revision
}
