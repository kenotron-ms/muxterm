// internal/ai/provider.go
package ai

import (
	"os"
	"path/filepath"
)

// Provider is one model vendor a lane can be launched against. The string
// value is the wire identity used in the /api/credentials routes and in the
// browser, so it is a stable name, not a display label.
type Provider string

const (
	ProviderAnthropic Provider = "anthropic"
	ProviderOpenAI    Provider = "openai"
)

// Providers lists every provider this machine can be onboarded for, in the
// order the UI shows them. Anthropic is first because a lane with no
// Anthropic credential cannot run at all under the default routing matrix,
// whereas a missing OpenAI credential only narrows which roles resolve.
var Providers = []Provider{ProviderAnthropic, ProviderOpenAI}

// providerSpec is everything muxterm needs to know about one vendor to
// detect, verify, and inject its credential. It is deliberately small: this
// is a credential catalog, not a model catalog.
type providerSpec struct {
	// Label is the human name used in UI copy and log lines.
	Label string
	// KeyEnv is the environment variable the coding-agent harnesses read.
	// This is the vendor-level contract -- it outlives any particular
	// version of amplifier's own configuration format, which is the whole
	// reason muxterm injects an environment rather than editing a file.
	KeyEnv string
	// BaseURLEnv names the variable that repoints the vendor's API. muxterm
	// never SETS this -- it only reads it, so that a verification check runs
	// against the same endpoint a lane would actually call. Getting this
	// wrong means cheerfully verifying a key against api.anthropic.com while
	// every lane talks to a proxy, or the reverse.
	BaseURLEnv string
	// KeyFile is the basename of the file in muxterm's config directory that
	// holds a stored key.
	KeyFile string
	// DefaultBaseURL is the vendor's own API root, used when BaseURLEnv
	// resolves to nothing.
	DefaultBaseURL string
	// ModelsPath is the path, relative to the base URL, of a list endpoint
	// that requires authentication and returns no billable completion.
	// Presenting a credential to it is the cheapest honest proof that the
	// credential is accepted.
	ModelsPath string
}

var providerSpecs = map[Provider]providerSpec{
	ProviderAnthropic: {
		Label:          "Anthropic",
		KeyEnv:         "ANTHROPIC_API_KEY",
		BaseURLEnv:     "ANTHROPIC_BASE_URL",
		KeyFile:        KeyFileName,
		DefaultBaseURL: "https://api.anthropic.com",
		ModelsPath:     "/v1/models",
	},
	ProviderOpenAI: {
		Label:          "OpenAI",
		KeyEnv:         "OPENAI_API_KEY",
		BaseURLEnv:     "OPENAI_BASE_URL",
		KeyFile:        "openai_key",
		DefaultBaseURL: "https://api.openai.com/v1",
		ModelsPath:     "/models",
	},
}

// KnownProvider reports whether name is a provider muxterm can onboard, and
// returns it. Handlers use this to reject a path segment before it reaches
// anything that touches disk.
func KnownProvider(name string) (Provider, bool) {
	p := Provider(name)
	if _, ok := providerSpecs[p]; ok {
		return p, true
	}
	return "", false
}

// Label returns the vendor's display name, or the raw provider id when the
// provider is not in the catalog (which a handler should have refused first).
func (p Provider) Label() string {
	if spec, ok := providerSpecs[p]; ok {
		return spec.Label
	}
	return string(p)
}

// KeyEnv returns the environment variable name the harnesses read for p.
func (p Provider) KeyEnv() string {
	return providerSpecs[p].KeyEnv
}

// BaseURLEnv returns the environment variable name that repoints p's API.
func (p Provider) BaseURLEnv() string {
	return providerSpecs[p].BaseURLEnv
}

// ConfigDir returns the directory muxterm keeps its own credentials in:
// $XDG_CONFIG_HOME/muxterm, falling back to $HOME/.config/muxterm.
//
// This is muxterm's directory. Nothing here ever writes outside it -- in
// particular not into ~/.amplifier/, which belongs to a different tool and is
// hand-maintained by the user.
func ConfigDir() string {
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		base = filepath.Join(os.Getenv("HOME"), ".config")
	}
	return filepath.Join(base, "muxterm")
}

// KeyPath returns where p's stored key lives.
//
// Anthropic deliberately keeps the pre-existing "anthropic_key" filename
// rather than moving to a per-provider scheme: that file already holds the
// key muxterm's own AI features use, and a machine that has one should not
// have to be onboarded again. One key, one file, both consumers.
func KeyPath(p Provider) string {
	return filepath.Join(ConfigDir(), providerSpecs[p].KeyFile)
}
