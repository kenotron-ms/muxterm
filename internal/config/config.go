// Package config defines the muxterm configuration structure and hardcoded defaults.
package config

import (
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/BurntSushi/toml"
)

// Config is the top-level configuration for muxterm.
type Config struct {
	Theme          ThemeConfig          `toml:"theme"      json:"theme"`
	Font           FontConfig           `toml:"font"       json:"font"`
	Terminal       TerminalConfig       `toml:"terminal"   json:"terminal"`
	Sidebar        SidebarConfig        `toml:"sidebar"    json:"sidebar"`
	Keys           KeysConfig           `toml:"keys"       json:"keys"`
	Workspace      WorkspaceConfig      `toml:"workspace"  json:"workspace"`
	Driver         DriverConfig         `toml:"driver"     json:"driver"`
	Server         ServerConfig         `toml:"server"     json:"server"`
	Restore        RestoreConfig        `toml:"restore"    json:"restore"`
	Voice          VoiceConfig          `toml:"voice"      json:"voice"`
	MissionControl MissionControlConfig `toml:"missioncontrol" json:"missioncontrol"`
}

// MissionControlConfig holds opt-in Mission Control gates. Both switches must
// be true before the text-thread preview can start an isolated sidecar.
type MissionControlConfig struct {
	ThreadsV2   bool `toml:"threads_v2" json:"threads_v2"`
	TextPreview bool `toml:"text_preview" json:"text_preview"`
	// VoicePreview is an independent, default-off candidate gate. It never
	// inherits either legacy [voice].enabled or text_preview: a configured
	// threaded text preview must not open a microphone by accident.
	VoicePreview         bool `toml:"voice_preview" json:"voice_preview"`
	TextWorkerCap        int  `toml:"text_worker_cap" json:"text_worker_cap"`
	TextContextMaxTokens int  `toml:"text_context_max_tokens" json:"text_context_max_tokens"`
}

// ValidateTextContextMaxTokens accepts zero to retain context-simple's shipped
// budget. A configured value is deliberately bounded rather than becoming an
// arbitrary provider/module override.
func (m MissionControlConfig) ValidateTextContextMaxTokens() error {
	if m.TextContextMaxTokens == 0 {
		return nil
	}
	if m.TextContextMaxTokens < 256 || m.TextContextMaxTokens > 200_000 {
		return fmt.Errorf("config: [missioncontrol] text_context_max_tokens must be 0 or between 256 and 200000")
	}
	return nil
}

// Auth modes for VoiceConfig.AuthMode. These are the ONLY accepted values.
//
// There is no "guess" mode on purpose. The realtime endpoint muxterm was
// built against has API-key auth DISABLED at the resource level, and a
// consumer that assumes a key gets an HTTP 401 whose body says nothing about
// which of the two credentials it should have presented. Naming the mode is
// what turns that into a startup-time error message instead of a mystery.
const (
	// VoiceAuthEntra authenticates to the realtime endpoint with a
	// Microsoft Entra ID bearer token for the audience named by
	// VoiceConfig.EntraScope.
	VoiceAuthEntra = "entra"
	// VoiceAuthAPIKey authenticates with a static API key read from the
	// environment variable named by VoiceConfig.APIKeyEnv.
	VoiceAuthAPIKey = "api_key"
)

// VoiceConfig is the realtime speech-to-speech capability: where the realtime
// endpoint is, which deployment answers on it, and HOW TO AUTHENTICATE.
//
// Off by default. Turning it on costs money per minute of speech and opens a
// microphone, so it is an operator decision, never a default anyone backs
// into.
//
// Deliberately absent from Merge(), for the same reason ServerConfig is: this
// section names an outbound endpoint and an authentication mode, and a
// browser PATCH /api/config must not be able to repoint muxterm's credential
// at a host of the caller's choosing.
//
// No secret lives here. AuthMode selects WHICH credential source is used;
// the credential itself comes from the ambient Azure identity (entra) or an
// environment variable (api_key), and is never written to this file, never
// serialized to a browser, and never logged.
type VoiceConfig struct {
	// Enabled gates the whole capability. When false the /api/cos/voice/*
	// routes answer 404 and the browser never offers the control.
	Enabled bool `toml:"enabled" json:"enabled"`

	// Endpoint is the OpenAI-compatible v1 base URL of the realtime
	// service, with no trailing slash, e.g.
	// "https://example.openai.azure.com/openai/v1". Every realtime URL is
	// derived from it: {endpoint}/realtime/client_secrets mints the
	// ephemeral secret, {endpoint}/realtime/calls does the SDP exchange,
	// and the ws:// form of {endpoint}/realtime attaches the sideband.
	Endpoint string `toml:"endpoint" json:"endpoint"`

	// Model is the deployment/model name, e.g. "gpt-realtime-2.1".
	Model string `toml:"model" json:"model"`

	// AuthMode is VoiceAuthEntra or VoiceAuthAPIKey. Required when
	// Enabled: see the block comment above for why this is explicit.
	AuthMode string `toml:"auth_mode" json:"auth_mode"`

	// EntraScope is the token audience for VoiceAuthEntra. Defaults to
	// "https://ai.azure.com/.default", which is what an Azure AI Foundry
	// resource accepts; a Cognitive Services resource may want
	// "https://cognitiveservices.azure.com/.default" instead.
	EntraScope string `toml:"entra_scope,omitempty" json:"entra_scope"`

	// APIKeyEnv names the environment variable holding the key for
	// VoiceAuthAPIKey. The key's VALUE is never stored here.
	APIKeyEnv string `toml:"api_key_env,omitempty" json:"api_key_env"`

	// APIKeyStored says the key for VoiceAuthAPIKey lives in muxterm's
	// owner-only credential file (internal/secretfile, 0600, alongside
	// this config) rather than in an environment variable. It is what the
	// settings UI sets when someone types a key into the browser.
	//
	// This is a FLAG, not a key: the value is never in this file. Its
	// whole job is to answer "where does the key come from" explicitly,
	// because the alternative -- try the env var, fall back to the file --
	// is a guess, and this section's one hard rule is that credential
	// sourcing is never guessed. api_key_env still wins when both are set,
	// so a config that worked before this field existed still works.
	APIKeyStored bool `toml:"api_key_stored,omitempty" json:"api_key_stored"`

	// Voice is the spoken voice, e.g. "marin" or "alloy". Empty means the
	// model's own default.
	Voice string `toml:"voice,omitempty" json:"voice"`

	// SyncToolTimeout bounds the SYNCHRONOUS bridge tool. A chief-of-staff
	// turn can run for minutes and a realtime model expects a tool to
	// return in seconds, so the synchronous path gives up waiting after
	// this long and hands the turn to the asynchronous path, which speaks
	// the result when it lands. It never blocks until done.
	SyncToolTimeout time.Duration `toml:"sync_tool_timeout,omitempty" json:"sync_tool_timeout"`
}

// Validate enforces the one rule that cannot be defaulted: an enabled voice
// capability must say where it points and how it authenticates.
//
// When Enabled is false the section is inapplicable and is ignored entirely
// -- not an error -- so a half-filled [voice] section can sit in a config
// file without preventing muxterm from starting.
func (v VoiceConfig) Validate() error {
	if !v.Enabled {
		return nil
	}
	if v.Endpoint == "" {
		return errors.New(`config: [voice] enabled but endpoint is empty; set endpoint (e.g. "https://example.openai.azure.com/openai/v1")`)
	}
	u, err := url.Parse(v.Endpoint)
	if err != nil {
		return fmt.Errorf("config: [voice] endpoint %q is not a valid URL: %w", v.Endpoint, err)
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return fmt.Errorf("config: [voice] endpoint %q must use the https or http scheme", v.Endpoint)
	}
	if u.Host == "" {
		return fmt.Errorf("config: [voice] endpoint %q must include a host", v.Endpoint)
	}
	if v.Model == "" {
		return errors.New(`config: [voice] enabled but model is empty; set model (e.g. "gpt-realtime-2.1")`)
	}
	switch v.AuthMode {
	case VoiceAuthEntra, VoiceAuthAPIKey:
	case "":
		return fmt.Errorf(`config: [voice] enabled but auth_mode is empty; set auth_mode = %q or %q. This is not defaulted on purpose: a resource with key auth disabled answers an API-key request with a bare 401 that names neither credential`, VoiceAuthEntra, VoiceAuthAPIKey)
	default:
		return fmt.Errorf("config: [voice] auth_mode %q is not recognized; use %q or %q", v.AuthMode, VoiceAuthEntra, VoiceAuthAPIKey)
	}
	if v.AuthMode == VoiceAuthAPIKey && v.APIKeyEnv == "" && !v.APIKeyStored {
		return errors.New(`config: [voice] auth_mode = "api_key" requires either api_key_env naming the environment variable that holds the key, or api_key_stored = true to use the key saved through settings`)
	}
	return nil
}

// KeySource names where an api_key-mode credential is read from, for a
// caller that has to say so out loud. Never returns the key.
//
// The precedence encoded here is the one Validate accepts and the one
// internal/voice.NewCredential implements; they must agree, so it lives in
// one place.
func (v VoiceConfig) KeySource() string {
	if v.AuthMode != VoiceAuthAPIKey {
		return ""
	}
	switch {
	case v.APIKeyEnv != "":
		return "env"
	case v.APIKeyStored:
		return "stored"
	default:
		return "none"
	}
}

// Resolved returns v with every optional field filled in. Callers use this
// instead of reading the raw struct so a default lives in exactly one place.
func (v VoiceConfig) Resolved() VoiceConfig {
	if v.EntraScope == "" {
		v.EntraScope = DefaultVoiceEntraScope
	}
	if v.SyncToolTimeout <= 0 {
		v.SyncToolTimeout = DefaultVoiceSyncToolTimeout
	}
	return v
}

const (
	// DefaultVoiceEntraScope is the token audience an Azure AI Foundry
	// resource accepts. Verified working against a live resource whose
	// key auth is disabled.
	DefaultVoiceEntraScope = "https://ai.azure.com/.default"
	// DefaultVoiceSyncToolTimeout is how long the synchronous bridge tool
	// waits before handing off to the asynchronous path. Short enough that
	// the model does not sit silent, long enough that a quick answer still
	// arrives as a direct tool return.
	DefaultVoiceSyncToolTimeout = 12 * time.Second
)

// DefaultAddr is the ONE canonical listen address for muxterm's serve layer.
// Loopback-only by default: muxterm hands out interactive shells, so a
// wildcard bind is an opt-in decision an operator makes deliberately, never
// a default anyone backs into. Every default-addr site derives from here.
const DefaultAddr = "127.0.0.1:8311"

// ServerConfig holds deployment-topology settings: where muxterm listens,
// where it is publicly reachable, and whether the loopback auth bypass
// applies. These are POLICY and live in the config file rather than in the
// generated service unit, which `muxterm install` rewrites wholesale on
// every run.
//
// They are NEVER derived from request headers (X-Forwarded-Host,
// X-Forwarded-Proto, or anything else): headers are spoofable, and the
// design rejects trusting them for any trust-relevant value.
//
// These fields are deliberately absent from Merge(), which backs the
// browser-facing PATCH /api/config route -- a deployment-topology and
// security setting must not be mutable from a web request.
type ServerConfig struct {
	// Addr is the address the serve layer listens on, e.g.
	// "127.0.0.1:8311". This is POLICY and lives here rather than in the
	// generated systemd unit or launchd plist: `muxterm install` is the
	// documented upgrade command and rewrites those files wholesale, so a
	// value that lives only in ExecStart is discarded on the next upgrade.
	//
	// omitempty is load-bearing, not cosmetic. The browser's
	// PATCH /api/config path re-serializes this whole section back to
	// disk, so a field that is absent in memory would be written back as
	// `addr = ""` -- and net.Listen("tcp", "") does NOT error, it binds a
	// random port on every interface. Omitting the empty value keeps that
	// state off disk; ValidateAddr keeps it from being honored if it
	// arrives some other way.
	Addr string `toml:"addr,omitempty"       json:"addr"`
	// PublicOrigin is the canonical public origin at which muxterm is
	// reachable through its fronting reverse proxy, e.g.
	// "https://muxterm.ampbox.io". Scheme and host (with optional port)
	// only — no path, no trailing slash. Empty by default. Ignored
	// entirely when BehindReverseProxy is false.
	PublicOrigin string `toml:"public_origin"        json:"public_origin"`
	// BehindReverseProxy opts muxterm into reverse-proxy mode: every
	// public-facing URL muxterm builds derives from PublicOrigin, and the
	// IsLocalhost() auth bypass is disabled entirely. Opt-in, default
	// false. The bypass must go, because the proxy's own hop to muxterm is
	// indistinguishable from a genuinely local caller at the RemoteAddr
	// level — honoring it would silently grant unauthenticated access to
	// genuinely remote traffic.
	BehindReverseProxy bool `toml:"behind_reverse_proxy" json:"behind_reverse_proxy"`
}

// Validate enforces the design's fail-closed startup rule:
// behind_reverse_proxy without a usable public_origin is a hard
// configuration error, never a silent fall back to a loopback-derived URL
// — that fallback would reproduce the exact "browser redirected to
// 127.0.0.1" bug this configuration exists to fix. Callers MUST refuse to
// start the HTTP listener on a non-nil error.
//
// When BehindReverseProxy is false, PublicOrigin is inapplicable and is
// ignored entirely — not an error.
func (s ServerConfig) Validate() error {
	if !s.BehindReverseProxy {
		return nil
	}
	if s.PublicOrigin == "" {
		return errors.New(`config: behind_reverse_proxy is set but public_origin is empty; set public_origin (e.g. "https://muxterm.example.com") or unset behind_reverse_proxy`)
	}
	u, err := url.Parse(s.PublicOrigin)
	if err != nil {
		return fmt.Errorf("config: public_origin %q is not a valid URL: %w", s.PublicOrigin, err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("config: public_origin %q must use the http or https scheme", s.PublicOrigin)
	}
	if u.Host == "" {
		return fmt.Errorf("config: public_origin %q must include a host", s.PublicOrigin)
	}

	// Everything below rejects a public_origin that parses but is not an
	// ORIGIN. Each of these forms silently produces a broken redirect URI:
	// publicBaseURL()+"/auth/callback" appends the path to whatever it is
	// given, and authserver compares the result byte-for-byte against the
	// redirect_uri it derived the same way. Both sides therefore agree,
	// the comparison passes, and the browser is sent somewhere that never
	// reaches /auth/callback -- so login silently never completes and
	// nothing anywhere reports an error. Reject at startup instead.
	if u.Path != "" && u.Path != "/" {
		return fmt.Errorf("config: public_origin %q must not include a path (got %q); use scheme://host[:port] only", s.PublicOrigin, u.Path)
	}
	if u.RawQuery != "" {
		return fmt.Errorf("config: public_origin %q must not include a query string (got %q)", s.PublicOrigin, u.RawQuery)
	}
	if u.Fragment != "" {
		return fmt.Errorf("config: public_origin %q must not include a fragment (got %q)", s.PublicOrigin, u.Fragment)
	}
	if u.User != nil {
		return fmt.Errorf("config: public_origin %q must not include userinfo credentials", s.PublicOrigin)
	}
	if p := u.Port(); p != "" {
		n, err := strconv.Atoi(p)
		if err != nil || n < 1 || n > 65535 {
			return fmt.Errorf("config: public_origin %q has an invalid port %q; must be 1-65535", s.PublicOrigin, p)
		}
	}
	return nil
}

// Normalize returns a copy of s with PublicOrigin reduced to its canonical
// origin form: trailing slashes trimmed and the scheme and host lowercased.
// Host comparison is case-insensitive per RFC 3986, but the redirect-URI
// check in authserver is a byte comparison -- so an origin that differs
// only in case from what the browser sends would fail to match. Callers
// should normalize BEFORE Validate so that validation reports on the value
// that will actually be used.
func (s ServerConfig) Normalize() ServerConfig {
	if s.PublicOrigin == "" {
		return s
	}
	trimmed := strings.TrimRight(s.PublicOrigin, "/")
	if u, err := url.Parse(trimmed); err == nil && u.Host != "" {
		u.Scheme = strings.ToLower(u.Scheme)
		u.Host = strings.ToLower(u.Host)
		trimmed = u.String()
	}
	s.PublicOrigin = trimmed
	return s
}

// IsZero reports whether the section carries no operator intent at all.
// Used to distinguish "the file had no [server] section" from "the file
// failed to parse and we substituted defaults", which matter differently.
func (s ServerConfig) IsZero() bool {
	return s.Addr == "" && s.PublicOrigin == "" && !s.BehindReverseProxy
}

// Warnings reports configuration that is accepted but will not do what the
// operator most likely intended. These are deliberately NOT errors: unlike
// the fail-closed cases in Validate, none of them leaves muxterm in an
// ambiguous security posture, and refusing to start would turn a harmless
// misconfiguration into an outage on the one service the operator may need
// in order to fix it.
func (s ServerConfig) Warnings() []string {
	var w []string
	if s.PublicOrigin != "" && !s.BehindReverseProxy {
		w = append(w, fmt.Sprintf(
			"config: public_origin is set to %q but behind_reverse_proxy is false, so it is being IGNORED "+
				"and muxterm will keep deriving its public URLs from the listen address. "+
				"Set behind_reverse_proxy = true to use it, or clear public_origin to silence this.",
			s.PublicOrigin))
	}
	return w
}

// ValidateAddr checks that addr is a listen address muxterm can actually
// bind, and returns a diagnosis naming the offending part when it is not.
//
// Deliberately stricter than net.SplitHostPort, which accepts several
// strings that then fail or silently misbehave at net.Listen time:
//
//	""                  SplitHostPort errors, but net.Listen BINDS
//	                    [::]:<random> -- a wildcard bind on a port nobody
//	                    asked for, with no error anywhere
//	":0" / "host:0"     port 0 means "pick any free port", so the service
//	                    comes up unreachable at the address it printed
//	"127.0.0.1:8311 "   trailing space parses, then fails at Listen with
//	                    an opaque "unknown port" much later
//	"host:99999"        parses, fails at Listen
func ValidateAddr(addr string) error {
	if strings.TrimSpace(addr) == "" {
		return errors.New(`config: addr is empty; set [server].addr (e.g. "127.0.0.1:8311")`)
	}
	if addr != strings.TrimSpace(addr) {
		return fmt.Errorf("config: addr %q has leading or trailing whitespace", addr)
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("config: addr %q is not host:port: %w", addr, err)
	}
	_ = host // an empty host is a legitimate wildcard bind (":8311")
	n, err := strconv.Atoi(port)
	if err != nil {
		return fmt.Errorf("config: addr %q has a non-numeric port %q", addr, port)
	}
	if n < 1 || n > 65535 {
		return fmt.Errorf("config: addr %q has port %d; must be 1-65535 (0 would bind an arbitrary free port)", addr, n)
	}
	return nil
}

// BaseURL returns PublicOrigin ready to have an absolute path appended
// (trailing slashes trimmed, so "https://x/" + "/auth/callback" cannot
// produce a double slash that would break the exact-match redirect-URI
// comparison). Only meaningful when BehindReverseProxy is true.
func (s ServerConfig) BaseURL() string {
	return strings.TrimRight(s.PublicOrigin, "/")
}

// ThemeConfig controls visual palette selection.
type ThemeConfig struct {
	Palette string `toml:"palette" json:"palette"`
}

// FontConfig controls the terminal font family and size.
type FontConfig struct {
	Family string `toml:"family" json:"family"`
	Size   int    `toml:"size"   json:"size"`
}

// TerminalConfig controls terminal emulator behaviour.
// Bell accepts: "visual" | "audible" | "off".
type TerminalConfig struct {
	CursorStyle string `toml:"cursor_style"  json:"cursor_style"`
	CursorBlink bool   `toml:"cursor_blink"  json:"cursor_blink"`
	Scrollback  int    `toml:"scrollback"    json:"scrollback"`
	Bell        string `toml:"bell"          json:"bell"`
}

// SidebarConfig controls the workspace sidebar's live preview cards.
// Preview accepts: "full" | "compact" | "off".
//
// "off" is not merely a visual suppression: the browser never sends
// preview-subscribe, so the daemon renders no tiles and puts no preview bytes
// on the wire at all. That is also the answer for the privacy case (previously
// hidden workspace content becoming visible while screen-sharing).
type SidebarConfig struct {
	Preview string `toml:"preview" json:"preview"`
}

// KeysConfig defines muxterm's own UI keybindings.
// These are muxterm UI actions only.
type KeysConfig struct {
	NextSession    string `toml:"next_session"     json:"next_session"`
	Split          string `toml:"split"            json:"split"`
	MaximizeRegion string `toml:"maximize_region"  json:"maximize_region"`
	PopOut         string `toml:"pop_out"          json:"pop_out"`
	OpenLauncher   string `toml:"open_launcher"    json:"open_launcher"`
	FocusDriver    string `toml:"focus_driver"     json:"focus_driver"`
	// ToggleHome shows/hides the home view (the "needs input" surface).
	//
	// Backtick, not the usual ctrl+shift+<key>: ] \ m o p a are all taken, and
	// backtick was bound to nothing. It is a PRINTABLE character, so the client
	// must intercept the chord before xterm.js sees it while leaving a bare
	// backtick to type a backtick — see web/src/lib/keybindings.ts.
	// NOT ctrl+s: that is XOFF and freezes the terminal.
	ToggleHome string `toml:"toggle_home"      json:"toggle_home"`
}

// WorkspaceConfig controls workspace layout and presentation.
type WorkspaceConfig struct {
	DefaultPresentation string   `toml:"default_presentation" json:"default_presentation"`
	Rails               []string `toml:"rails"                json:"rails"`
}

// DriverConfig controls the muxterm-agent driver lifecycle.
// SharedWindowPolicy is RESERVED — parsed and carried through to the client
// but NOT acted on in Phase 5.
type DriverConfig struct {
	Autostart          bool   `toml:"autostart"           json:"autostart"`
	SharedWindowPolicy string `toml:"shared_window_policy" json:"shared_window_policy"`
	Launch             string `toml:"launch"              json:"launch"`
}

// RestoreConfig controls session-restore snapshotting: periodic capture of
// each pane's cwd, argv, agent identity, and recent output to disk, plus
// boot-time restore from the most recent snapshot — matching what
// tmux-resurrect + tmux-continuum do together for a real tmux session.
//
// Config-file-only, like DriverConfig/ServerConfig above: deliberately absent
// from Merge() (see its doc comment) since a browser PATCH must never toggle
// disk-persistence behavior.
type RestoreConfig struct {
	// Enabled turns periodic snapshotting and boot-time restore on or off.
	// When false, sessiond behaves exactly as it does today: a cold-start
	// blank default workspace on every start, nothing ever written to disk.
	Enabled bool `toml:"enabled" json:"enabled"`
	// SnapshotInterval is how often the daemon captures a fresh snapshot of
	// every live workspace/pane while running. Authored in TOML as a
	// duration string (e.g. "30s"); BurntSushi/toml decodes that directly
	// into a time.Duration.
	SnapshotInterval time.Duration `toml:"snapshot_interval" json:"snapshot_interval"`
}

// Load reads a TOML config file from path and returns a Config.
// Resolution rules:
//   - Missing file → Defaults(), no error (config is optional)
//   - Malformed file → Defaults() + logged warning, no error (a typo can never take the app down)
//   - Present and valid → Defaults() with the file's set fields applied on top (partial configs supported)
func Load(path string) (Config, error) {
	cfg, _, err := LoadStrictServer(path)
	return cfg, err
}

// LoadStrictServer loads path and additionally reports whether the file was
// present but unparseable.
//
// Load's contract -- a malformed file degrades to defaults with only a log
// line, so "a typo can never take the app down" -- is right for the
// cosmetic sections and wrong for [server]. Silently substituting defaults
// there moves the listener, and clears behind_reverse_proxy, which
// re-enables the loopback auth bypass. Both are silent, and both are
// exactly the kind of change an operator must never get by accident.
//
// So the degradation stays for everything else, and callers that depend on
// [server] -- serve and install -- use this and refuse to continue when
// malformed is true. The returned Config is still Defaults(), so a caller
// that does not care can ignore the flag and behave exactly as before.
func LoadStrictServer(path string) (cfg Config, malformed bool, err error) {
	cfg = Defaults()
	if _, statErr := os.Stat(path); errors.Is(statErr, fs.ErrNotExist) {
		return cfg, false, nil
	}
	if _, decErr := toml.DecodeFile(path, &cfg); decErr != nil {
		log.Printf("config: %s is malformed (%v); using built-in defaults", path, decErr)
		return Defaults(), true, nil
	}
	return cfg, false, nil
}

// Merge returns a copy of base with non-zero fields from partial applied.
// Rules:
//   - string fields: applied if partial value is non-empty
//   - int fields: applied if partial value is non-zero
//   - bool fields: always applied from partial (Go zero bool is false;
//     partial updates cannot clear a bool back to false — document this limitation)
func Merge(base, partial Config) Config {
	result := base
	if partial.Theme.Palette != "" {
		result.Theme.Palette = partial.Theme.Palette
	}
	if partial.Font.Family != "" {
		result.Font.Family = partial.Font.Family
	}
	if partial.Font.Size != 0 {
		result.Font.Size = partial.Font.Size
	}
	if partial.Terminal.CursorStyle != "" {
		result.Terminal.CursorStyle = partial.Terminal.CursorStyle
	}
	result.Terminal.CursorBlink = partial.Terminal.CursorBlink
	if partial.Terminal.Scrollback != 0 {
		result.Terminal.Scrollback = partial.Terminal.Scrollback
	}
	if partial.Terminal.Bell != "" {
		result.Terminal.Bell = partial.Terminal.Bell
	}
	if partial.Sidebar.Preview != "" {
		result.Sidebar.Preview = partial.Sidebar.Preview
	}
	return result
}

// Write encodes cfg as TOML and atomically replaces path with it. Parent
// directories are created if they do not exist.
//
// Genuinely atomic: encode into a temp file in the same directory, fsync
// it, then rename over the target. A rename within a directory is atomic,
// so a reader sees either the whole old file or the whole new one, never a
// partial write. The previous implementation truncated in place, which
// left a window where a crash or a full disk produced a half-written file
// -- and Load treats a half-written file as "malformed", substituting
// defaults. That is survivable for a font size and not survivable for a
// listen address.
func Write(path string, cfg Config) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("config.Write: mkdir: %w", err)
	}
	tmp, err := os.CreateTemp(dir, ".config.toml.*")
	if err != nil {
		return fmt.Errorf("config.Write: create temp: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op once the rename succeeds

	if err := toml.NewEncoder(tmp).Encode(cfg); err != nil {
		tmp.Close() //nolint:errcheck
		return fmt.Errorf("config.Write: encode: %w", err)
	}
	// fsync before rename: rename is atomic with respect to readers, but
	// without the sync the rename can land while the contents are still
	// only in the page cache, so a power loss yields an atomically-renamed
	// EMPTY file.
	if err := tmp.Sync(); err != nil {
		tmp.Close() //nolint:errcheck
		return fmt.Errorf("config.Write: sync: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("config.Write: close temp: %w", err)
	}
	// Match the 0644 the previous os.Create produced; CreateTemp makes 0600.
	if err := os.Chmod(tmpName, 0o644); err != nil {
		return fmt.Errorf("config.Write: chmod temp: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("config.Write: rename: %w", err)
	}
	// Atomicity and durability are separate properties. The rename above
	// gives readers all-or-nothing, but the directory entry itself lives in
	// the page cache until the OS flushes it -- so a crash here can leave a
	// file whose blocks are on disk and whose name reverted. Syncing the
	// parent closes that gap. Best-effort: the write has already succeeded
	// by every observable measure, so a sync failure must not report one
	// that did not happen.
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		d.Close() //nolint:errcheck
	}
	return nil
}

// Defaults returns a Config populated with hardcoded default values.
func Defaults() Config {
	return Config{
		Theme: ThemeConfig{
			Palette: "tokyo-night",
		},
		Font: FontConfig{
			// Default to the server-bundled JetBrains Mono Nerd Font.
			// The WOFF2 files are served from /fonts/ by the muxterm server,
			// so Nerd Font glyphs render correctly in any browser without
			// requiring the user to install fonts on their client machine.
			Family: "JetBrainsMonoNerdFont",
			Size:   13,
		},
		Terminal: TerminalConfig{
			CursorStyle: "block",
			CursorBlink: true,
			Scrollback:  10000,
			Bell:        "visual",
		},
		Sidebar: SidebarConfig{
			Preview: "full",
		},
		Keys: KeysConfig{
			NextSession:    "ctrl+shift+]",
			Split:          `ctrl+shift+\`,
			MaximizeRegion: "ctrl+shift+m",
			PopOut:         "ctrl+shift+o",
			OpenLauncher:   "ctrl+shift+p",
			FocusDriver:    "ctrl+shift+a",
			ToggleHome:     "ctrl+`",
		},
		Workspace: WorkspaceConfig{
			DefaultPresentation: "docked",
			Rails:               []string{"sessions"},
		},
		Driver: DriverConfig{
			Autostart:          false,
			SharedWindowPolicy: "follow",
			Launch:             "muxterm-agent",
		},
		// Direct/local-dev topology by default: no reverse proxy, no
		// public origin. Stated explicitly rather than left implicit so
		// the shipped default posture is readable here.
		Server: ServerConfig{
			PublicOrigin:       "",
			BehindReverseProxy: false,
		},
		Restore: RestoreConfig{
			Enabled:          true,
			SnapshotInterval: 30 * time.Second,
		},
		// Realtime voice is OFF by default and carries no endpoint. It
		// opens a microphone and bills per minute of speech; an
		// operator turns it on deliberately or not at all.
		Voice: VoiceConfig{
			Enabled:         false,
			EntraScope:      DefaultVoiceEntraScope,
			SyncToolTimeout: DefaultVoiceSyncToolTimeout,
		},
		// All four release gates default off: missioncontrol.threads_v2,
		// missioncontrol.text_preview, missioncontrol.voice_preview, and
		// voice.enabled. No candidate registers until each applicable gate
		// is deliberately enabled.
		MissionControl: MissionControlConfig{ThreadsV2: false, TextPreview: false, VoicePreview: false, TextWorkerCap: 4},
	}
}
