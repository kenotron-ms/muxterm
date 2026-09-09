// internal/ai/detect.go
package ai

import (
	"os"
	"strings"
)

// Origin names where a credential came from. It is not a judgement about
// whether the credential WORKS -- that is Verdict's job, and keeping the two
// apart is the point of this file. A key that is present and rejected is the
// exact failure this feature exists to end, and calling it "configured" is
// how that failure stayed invisible.
type Origin string

const (
	// OriginMuxterm: muxterm's own store, injected into every lane it spawns.
	OriginMuxterm Origin = "muxterm"
	// OriginEnvironment: already in the muxterm server's environment, and so
	// inherited by anything it launches.
	OriginEnvironment Origin = "environment"
	// OriginAmplifier: defined in ~/.amplifier/keys.env, which the amplifier
	// CLI reads for itself. muxterm only looks.
	OriginAmplifier Origin = "amplifier"
	// OriginNone: nowhere muxterm can see.
	OriginNone Origin = "none"
)

// ProviderState is the full, separated truth about one provider on this
// machine: every place a credential was found, which one actually wins, and
// -- reported apart from all of that -- whether it was accepted the last time
// anything asked the vendor.
type ProviderState struct {
	Provider Provider `json:"provider"`
	Label    string   `json:"label"`
	KeyEnv   string   `json:"keyEnv"`

	// Present is true when a credential exists in at least one place.
	Present bool `json:"present"`
	// Origin is where the credential a lane will actually use comes from.
	Origin Origin `json:"origin"`
	// InMuxterm / InEnvironment / InAmplifierFile report each source
	// independently, so the UI can say "you have three of these and they may
	// not agree" instead of picking one and hiding the rest.
	InMuxterm       bool `json:"inMuxterm"`
	InEnvironment   bool `json:"inEnvironment"`
	InAmplifierFile bool `json:"inAmplifierFile"`

	// BaseURL is the endpoint a lane would call. Not a secret, and load
	// bearing: a machine repointed at a proxy is verified against the proxy.
	BaseURL       string `json:"baseURL"`
	BaseURLOrigin Origin `json:"baseURLOrigin"`

	// StorePath is where muxterm would write a stored key. A path, never
	// contents.
	StorePath string `json:"storePath"`

	// Verdict is the last live check. Never inferred from presence.
	Verdict Verdict `json:"verdict"`
}

// Report is the whole answer to "what does this machine already have?".
//
// No field of it, at any depth, carries a credential value, a mask, a hint,
// or a length. Every string in here is a variable name, a file path, an
// endpoint, or an explanation.
type Report struct {
	Providers []ProviderState `json:"providers"`

	// Blocked is true when a lane launched on this machine right now would
	// fail. BlockedReason says why in a sentence a person can act on --
	// "lanes cannot run on this machine because no Anthropic credential is
	// configured" is worth more than a red dot.
	Blocked       bool   `json:"blocked"`
	BlockedReason string `json:"blockedReason"`

	// AmplifierKeysPath is <amplifier home>/keys.env; AmplifierKeysFound
	// reports whether it exists. muxterm reads this file and never writes it.
	AmplifierKeysPath  string `json:"amplifierKeysPath"`
	AmplifierKeysFound bool   `json:"amplifierKeysFound"`

	// AmplifierHomePath is the directory that file lives in, resolved the way
	// amplifier resolves it ($AMPLIFIER_HOME, then ~/.amplifier), and
	// AmplifierHomeFound reports whether the directory is there at all.
	//
	// Reported apart from the keys file because they mean different things.
	// No directory means amplifier is very likely not installed here, and the
	// only honest move is to say that. muxterm does not create it: conjuring
	// a config tree for a tool that is not on the machine would make an
	// unconfigured box look like a configured one, which is the exact
	// confusion this whole feature exists to end.
	AmplifierHomePath  string `json:"amplifierHomePath"`
	AmplifierHomeFound bool   `json:"amplifierHomeFound"`

	// StoreDir is muxterm's own credential directory.
	StoreDir string `json:"storeDir"`

	// RemoteGap is the sentence the UI must show verbatim: credentials are
	// per-machine and muxterm does not forward them. See O6 in the PR body.
	RemoteGap string `json:"remoteGap"`
}

// RemoteGapNotice is stated in the API, in the settings surface, and in the
// PR body, in the same words. A user who configures credentials here and then
// spawns a lane on a remote machine hits the identical first-turn failure
// with no warning, so the one thing this feature must not do is imply
// otherwise by staying silent.
const RemoteGapNotice = "These credentials apply to this machine only. " +
	"muxterm does not send them over SSH: a lane spawned on a remote machine uses that machine's own credentials, " +
	"which must be set up there separately."

// Report inspects every credential source muxterm can see and returns the
// separated presence-and-validity picture.
//
// It performs no network I/O. Validity comes from whatever the last Verify
// recorded; a provider nothing has checked reports VerdictUnknown, which the
// UI renders as "not checked", not as "fine".
func (m *Manager) Report() Report {
	fileKeys := amplifierKeys()
	amplifierPath := AmplifierKeysPath()
	_, statErr := os.Stat(amplifierPath)

	rep := Report{
		AmplifierKeysPath:  amplifierPath,
		AmplifierKeysFound: amplifierPath != "" && statErr == nil,
		AmplifierHomePath:  AmplifierHome(),
		AmplifierHomeFound: AmplifierHomeExists(),
		StoreDir:           ConfigDir(),
		RemoteGap:          RemoteGapNotice,
	}

	for _, p := range Providers {
		rep.Providers = append(rep.Providers, m.providerState(p, fileKeys))
	}

	// Anthropic is the credential a lane cannot start without under the
	// default routing matrix, so it alone decides Blocked. A missing OpenAI
	// credential narrows which model roles resolve and is reported on its own
	// row; it does not stop a lane from running.
	for _, st := range rep.Providers {
		if st.Provider != ProviderAnthropic {
			continue
		}
		switch {
		case !st.Present:
			rep.Blocked = true
			rep.BlockedReason = "Lanes cannot run on this machine: no Anthropic credential is configured."
		case st.Verdict.State == VerdictRejected:
			rep.Blocked = true
			rep.BlockedReason = "Lanes will fail on their first turn: " + st.Label +
				" rejected the credential this machine is using."
		}
	}
	return rep
}

// providerState resolves one provider against all three sources.
//
// The precedence encoded here is not muxterm's invention and must not drift
// from reality: amplifier's KeyManager sets a variable from keys.env only
// when it is absent from the process environment, so an environment variable
// beats the file. muxterm's own store is injected INTO that environment at
// spawn (see internal/sessiond/lane_env.go), so it beats both. Getting this
// order wrong would make the report confidently name the wrong credential.
func (m *Manager) providerState(p Provider, fileKeys map[string]string) ProviderState {
	spec := providerSpecs[p]

	inStore := m.stored(p) != ""
	inEnv := strings.TrimSpace(os.Getenv(spec.KeyEnv)) != ""
	inFile := strings.TrimSpace(fileKeys[spec.KeyEnv]) != ""

	origin := OriginNone
	switch {
	case inStore:
		origin = OriginMuxterm
	case inEnv:
		origin = OriginEnvironment
	case inFile:
		origin = OriginAmplifier
	}

	baseURL, baseOrigin := resolveBaseURL(spec, fileKeys)

	return ProviderState{
		Provider:        p,
		Label:           spec.Label,
		KeyEnv:          spec.KeyEnv,
		Present:         origin != OriginNone,
		Origin:          origin,
		InMuxterm:       inStore,
		InEnvironment:   inEnv,
		InAmplifierFile: inFile,
		BaseURL:         baseURL,
		BaseURLOrigin:   baseOrigin,
		StorePath:       m.storePath(p),
		Verdict:         m.verdict(p),
	}
}

// resolveBaseURL finds the endpoint a lane would actually call, following the
// same environment-beats-file order as the key itself. muxterm never sets a
// base URL; it only needs to know which one to verify against.
func resolveBaseURL(spec providerSpec, fileKeys map[string]string) (string, Origin) {
	if v := strings.TrimSpace(os.Getenv(spec.BaseURLEnv)); v != "" {
		return v, OriginEnvironment
	}
	if v := strings.TrimSpace(fileKeys[spec.BaseURLEnv]); v != "" {
		return v, OriginAmplifier
	}
	return spec.DefaultBaseURL, OriginNone
}

// effectiveKey returns the credential a lane on this machine would present
// for p, following the documented precedence, together with where it came
// from. The value never leaves this package except as an Authorization
// header on a request to the vendor, or as an environment variable handed to
// a lane muxterm is spawning.
func (m *Manager) effectiveKey(p Provider) (string, Origin) {
	if key := m.stored(p); key != "" {
		return key, OriginMuxterm
	}
	spec := providerSpecs[p]
	if key := strings.TrimSpace(os.Getenv(spec.KeyEnv)); key != "" {
		return key, OriginEnvironment
	}
	if key := strings.TrimSpace(amplifierKeys()[spec.KeyEnv]); key != "" {
		return key, OriginAmplifier
	}
	return "", OriginNone
}

// LaneEnv returns the environment assignments to add to a lane muxterm is
// about to spawn: one per provider muxterm has a STORED key for, and nothing
// else.
//
// Only stored keys are injected, deliberately. A credential already in the
// environment is inherited without help, and one in amplifier's keys.env is
// read by amplifier itself -- re-injecting either would add exposure and
// change nothing. On a machine where muxterm has stored nothing, this returns
// nil and a lane launches exactly as it does today.
func (m *Manager) LaneEnv() []string {
	var env []string
	for _, p := range Providers {
		if key := m.stored(p); key != "" {
			env = append(env, providerSpecs[p].KeyEnv+"="+key)
		}
	}
	return env
}
