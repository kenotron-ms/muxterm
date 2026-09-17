package sandboxazure

import (
	"errors"
	"io/fs"
	"sort"
	"strings"
)

type PresentationState string

const (
	PresentationUnconfigured  PresentationState = "unconfigured"
	PresentationDisabled      PresentationState = "disabled"
	PresentationKillSwitch    PresentationState = "kill-switch"
	PresentationLifecycleOnly PresentationState = "lifecycle-only"
)

type PresentationAttachAvailability string

const (
	PresentationAttachUnavailable PresentationAttachAvailability = "unavailable"
)

type PresentationObservedState string

const (
	PresentationObservedAccepted   PresentationObservedState = "accepted"
	PresentationObservedCreating   PresentationObservedState = "creating"
	PresentationObservedRunning    PresentationObservedState = "running"
	PresentationObservedStopping   PresentationObservedState = "stopping"
	PresentationObservedStopped    PresentationObservedState = "stopped"
	PresentationObservedSuspended  PresentationObservedState = "suspended"
	PresentationObservedIdle       PresentationObservedState = "idle"
	PresentationObservedDestroying PresentationObservedState = "destroying"
	PresentationObservedDestroyed  PresentationObservedState = "destroyed"
	PresentationObservedUnknown    PresentationObservedState = "unknown"
)

var (
	ErrPresentationConfiguration = errors.New("direct Azure sandbox presentation configuration is unavailable")
	ErrPresentationStore         = errors.New("direct Azure sandbox presentation store is unavailable")
)

// Presentation is the complete browser-safe, owner-local Azure Sandbox
// inventory. It deliberately has no provider, endpoint, identity, scope,
// credential, runtime, or proof fields.
type Presentation struct {
	ConfigurationState PresentationState              `json:"configuration_state"`
	AttachAvailability PresentationAttachAvailability `json:"attach_availability"`
	ReasonCode         string                         `json:"reason_code"`
	Reason             string                         `json:"reason"`
	Profiles           []string                       `json:"profiles"`
	Records            []PresentationRecord           `json:"records"`
}

// PresentationRecord is the narrow local durable projection used by Settings
// and the sidebar. The handle is opaque and all other fields are lifecycle
// observations only.
type PresentationRecord struct {
	Handle        string                    `json:"handle"`
	Profile       string                    `json:"profile"`
	ObservedState PresentationObservedState `json:"observed_state"`
	Generation    uint64                    `json:"generation"`
}

// PresentationReader retains only a browser-safe projection and store path
// derived from the already-loaded sealed configuration. It never owns a
// Provider and never performs reconciliation or any network operation.
type PresentationReader struct {
	storeDir           string
	presentation       Presentation
	configurationError bool
}

func NewPresentationReader(config Config) *PresentationReader {
	reader := &PresentationReader{
		presentation: presentationForConfig(config),
	}
	if config.Enabled {
		reader.storeDir = config.StoreDir
	}
	return reader
}

// NewUnavailablePresentationReader represents a configuration load/validation
// failure without reflecting the source path or any operator-authored value.
func NewUnavailablePresentationReader() *PresentationReader {
	return &PresentationReader{configurationError: true}
}

func (r *PresentationReader) Read() (Presentation, error) {
	if r == nil || r.configurationError {
		return Presentation{}, ErrPresentationConfiguration
	}
	// Copy slices before returning so a caller cannot mutate the cached,
	// configuration-derived projection retained by the reader.
	presentation := r.presentation
	presentation.Profiles = append(make([]string, 0, len(r.presentation.Profiles)), r.presentation.Profiles...)
	presentation.Records = make([]PresentationRecord, 0)
	if r.storeDir == "" {
		return presentation, nil
	}

	store, err := OpenStoreReadOnly(r.storeDir)
	if err != nil {
		return Presentation{}, ErrPresentationStore
	}
	records, err := store.List()
	// A lifecycle save atomically replaces a record. If the replacement lands
	// between Load's open and inode verification, retry the complete
	// owner-local read once: both snapshots are safe, while an actual unsafe
	// path continues to fail closed on the second check.
	if errors.Is(err, ErrUnsafeStore) {
		records, err = store.List()
	}
	if errors.Is(err, fs.ErrNotExist) {
		return presentation, nil
	}
	if err != nil {
		return Presentation{}, ErrPresentationStore
	}
	presentation.Records = make([]PresentationRecord, 0, len(records))
	for _, record := range records {
		// Store.Load already validates the durable schema. Re-check the
		// presentation boundary so an unexpected provider state is reduced to
		// a fixed lifecycle vocabulary before it reaches a browser.
		if record.Handle == "" || !safeSegment.MatchString(record.ProfileName) {
			continue
		}
		presentation.Records = append(presentation.Records, PresentationRecord{
			Handle:        record.Handle,
			Profile:       record.ProfileName,
			ObservedState: presentationLifecycleState(record.ObservedState),
			Generation:    record.Generation,
		})
	}
	sort.Slice(presentation.Records, func(i, j int) bool {
		if presentation.Records[i].Handle != presentation.Records[j].Handle {
			return presentation.Records[i].Handle < presentation.Records[j].Handle
		}
		return presentation.Records[i].Profile < presentation.Records[j].Profile
	})
	return presentation, nil
}

func presentationForConfig(config Config) Presentation {
	state, code, reason := PresentationLifecycleOnly, "attach-unavailable", "Azure Sandbox terminal/workspace connection unavailable: authenticated session transport is not established."
	switch {
	case !config.Present:
		state, code, reason = PresentationUnconfigured, "not-configured", "Azure Sandboxes are not configured on this muxterm."
	case !config.Enabled:
		state, code, reason = PresentationDisabled, "disabled-by-owner", "Azure Sandboxes are configured but disabled by the owner."
	case config.KillSwitch:
		state, code, reason = PresentationKillSwitch, "kill-switch-enabled", "Azure Sandbox terminal/workspace connection unavailable because the owner kill switch is enabled."
	}
	return Presentation{
		ConfigurationState: state,
		AttachAvailability: PresentationAttachUnavailable,
		ReasonCode:         code,
		Reason:             reason,
		Profiles:           presentationProfileNames(config),
		Records:            make([]PresentationRecord, 0),
	}
}

func presentationProfileNames(config Config) []string {
	names := make([]string, 0, len(config.Profiles))
	seen := make(map[string]struct{}, len(config.Profiles))
	for _, profile := range config.Profiles {
		// Profile names are the only configuration values admitted to the
		// browser. Keep the existing closed-name policy at this boundary too,
		// including for a disabled section that is not lifecycle-validated.
		if !safeSegment.MatchString(profile.Name) {
			continue
		}
		if _, ok := seen[profile.Name]; ok {
			continue
		}
		seen[profile.Name] = struct{}{}
		names = append(names, profile.Name)
	}
	sort.Strings(names)
	return names
}

func presentationLifecycleState(state string) PresentationObservedState {
	normalized := PresentationObservedState(strings.ToLower(strings.TrimSpace(state)))
	switch normalized {
	case PresentationObservedAccepted:
		return PresentationObservedAccepted
	case PresentationObservedCreating:
		return PresentationObservedCreating
	case PresentationObservedRunning:
		return PresentationObservedRunning
	case PresentationObservedStopping:
		return PresentationObservedStopping
	case PresentationObservedStopped:
		return PresentationObservedStopped
	case PresentationObservedSuspended:
		return PresentationObservedSuspended
	case PresentationObservedIdle:
		return PresentationObservedIdle
	case PresentationObservedDestroying:
		return PresentationObservedDestroying
	case PresentationObservedDestroyed:
		return PresentationObservedDestroyed
	default:
		return PresentationObservedUnknown
	}
}
