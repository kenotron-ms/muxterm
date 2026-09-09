package server

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"

	muxcfg "github.com/kenotron-ms/muxterm/internal/config"
	"github.com/kenotron-ms/muxterm/internal/secretfile"
	"github.com/kenotron-ms/muxterm/internal/voice"
)

// The /api/voice/* family: the credential surface for realtime voice.
//
// Voice configuration used to be file-only, deliberately, on the grounds that
// a browser must not be able to repoint muxterm's credential. That decision
// has been overruled -- people configure this from a phone -- but the reasons
// behind it were real, so every one of them is answered here rather than
// waved away:
//
//   - WRITE-ONLY. A key goes in through PUT and NOTHING derived from its
//     value ever comes back. GET returns keyConfigured, a bool. Not a mask,
//     not a length, not the last four characters. Anyone with a session to
//     this muxterm can open Settings, so a readable-back key would turn one
//     compromised session into a stolen credential. (Note the divergence from
//     /api/ai/status, which does return a four-character hint.)
//
//   - NOT IN config.toml. The key is written to an owner-only 0600 file by
//     internal/secretfile. config.toml is mode 0644 on a real machine and
//     internal/config.Write pins it back to 0644 on every write, so a key
//     stored there would be world-readable by design.
//
//   - NOT ANYWHERE THE CALLER CHOOSES. A settings-written endpoint must be
//     https and must resolve to a known first-party host (see
//     allowedVoiceEndpoint). Hand-editing config.toml is NOT constrained this
//     way: the file is operator trust, a browser session is not. That split
//     is the whole answer to "a browser PATCH must not repoint the
//     credential" -- the browser can now pick WHICH first-party resource, and
//     still cannot pick an attacker's.
//
//   - REFUSED WHEN INCOMPLETE. An enabled section that does not say how it
//     authenticates is rejected HERE, at save time, with a message naming the
//     missing field -- the same rule config.Validate enforces at startup,
//     moved to the one moment a human can still fix it.
//
// Registered unconditionally, unlike /api/cos/voice/*, because the whole
// point is to configure voice while it is off.

// voiceSettingsMu serializes read-modify-write of the config file. Two tabs
// saving at once would otherwise race on the splice.
var voiceSettingsMu sync.Mutex

// voiceMode is the shape the FORM is in, not a config value. The three are
// genuinely different shapes -- Entra has no key at all -- so the client
// names which one it means instead of the server inferring it from a
// half-filled body.
const (
	voiceModeOpenAIKey  = "openai_key"
	voiceModeAzureKey   = "azure_key"
	voiceModeAzureEntra = "azure_entra"
)

// openAIEndpoint is fixed. There is exactly one OpenAI v1 base URL, and
// letting a browser type its own would reintroduce the credential-repointing
// hole for no benefit.
const openAIEndpoint = "https://api.openai.com/v1"

// allowedEntraScopes are the two audiences an Azure realtime resource
// actually accepts. A select, not a text field: an arbitrary scope is a
// request for a token for an arbitrary audience, and nobody configuring this
// from a phone benefits from being able to type one.
var allowedEntraScopes = []string{
	muxcfg.DefaultVoiceEntraScope, // https://ai.azure.com/.default
	"https://cognitiveservices.azure.com/.default",
}

// allowedVoiceEndpointSuffixes bounds where a SETTINGS-WRITTEN credential can
// be sent: first-party OpenAI and Microsoft hosts only, including the
// sovereign clouds. config.toml is not bound by this -- see the header.
var allowedVoiceEndpointSuffixes = []string{
	".openai.azure.com",
	".cognitiveservices.azure.com",
	".services.ai.azure.com",
	".openai.azure.us",
	".cognitiveservices.azure.us",
	".openai.azure.cn",
	".cognitiveservices.azure.cn",
}

// voiceStatus is everything the browser is allowed to know. Note what is
// absent: any field derived from a secret's value.
type voiceStatus struct {
	Enabled    bool   `json:"enabled"`
	Mode       string `json:"mode"`
	Endpoint   string `json:"endpoint"`
	Model      string `json:"model"`
	AuthMode   string `json:"authMode"`
	EntraScope string `json:"entraScope"`
	// KeySource is "stored", "env", "none" or "" (not a key mode). It says
	// WHERE the key comes from, never what it is.
	KeySource string `json:"keySource"`
	// KeyEnvVar is the environment variable NAME when a hand-edited config
	// sources the key that way. A name, not a value.
	KeyEnvVar string `json:"keyEnvVar"`
	// KeyConfigured is the entire truth this API tells about the secret.
	KeyConfigured bool `json:"keyConfigured"`
	// AllowedScopes drives the Entra scope select.
	AllowedScopes []string `json:"allowedScopes"`
	// ConfigPath and KeyPath are locations, shown so a user knows what to
	// edit by hand and what to back up. Never contents.
	ConfigPath string `json:"configPath"`
	KeyPath    string `json:"keyPath"`
	// RestartRequired is true when the saved configuration differs from
	// the one this process started with. Voice routes are wired at
	// startup, so a change lands on the next start, and saying so is
	// better than a microphone button that quietly does nothing.
	RestartRequired bool `json:"restartRequired"`
}

func (s *Server) voiceKeyStore() *secretfile.Store {
	return secretfile.New(voice.DefaultKeyPath())
}

// voiceConfigOnDisk reads the CURRENT file rather than trusting the config
// this process booted with: someone may have hand-edited it since, and the
// settings form should show what is actually there.
func (s *Server) voiceConfigOnDisk() muxcfg.VoiceConfig {
	if s.configPath == "" {
		return s.cfg.Voice
	}
	cfg, err := muxcfg.Load(s.configPath)
	if err != nil {
		log.Printf("voice_settings: load %s: %v", s.configPath, err)
		return s.cfg.Voice
	}
	return cfg.Voice
}

func (s *Server) buildVoiceStatus() voiceStatus {
	v := s.voiceConfigOnDisk()
	st := voiceStatus{
		Enabled:       v.Enabled,
		Mode:          voiceModeOf(v),
		Endpoint:      v.Endpoint,
		Model:         v.Model,
		AuthMode:      v.AuthMode,
		EntraScope:    v.Resolved().EntraScope,
		KeySource:     v.KeySource(),
		KeyEnvVar:     v.APIKeyEnv,
		AllowedScopes: allowedEntraScopes,
		ConfigPath:    s.configPath,
		KeyPath:       voice.DefaultKeyPath(),
	}
	switch st.KeySource {
	case "stored":
		st.KeyConfigured = s.voiceKeyStore().Present()
	case "env":
		st.KeyConfigured = strings.TrimSpace(os.Getenv(v.APIKeyEnv)) != ""
	case "":
		// Entra holds no secret at all. "Configured" for Entra means
		// the scope is set, which it always is after Resolved().
		st.KeyConfigured = v.AuthMode == muxcfg.VoiceAuthEntra
	}
	st.RestartRequired = voiceRuntimeDiffers(s.cfg.Voice, v)
	return st
}

// voiceModeOf picks which of the three form shapes a stored config is in.
//
// This is presentation only and changes nothing at runtime: auth_mode and
// endpoint are both stored explicitly and both shown verbatim in the form, so
// an endpoint this function does not recognise selects the Azure-key shape
// and displays its real value rather than rewriting it.
func voiceModeOf(v muxcfg.VoiceConfig) string {
	if v.AuthMode == muxcfg.VoiceAuthEntra {
		return voiceModeAzureEntra
	}
	if u, err := url.Parse(v.Endpoint); err == nil && strings.EqualFold(u.Host, "api.openai.com") {
		return voiceModeOpenAIKey
	}
	return voiceModeAzureKey
}

// voiceRuntimeDiffers reports whether a restart would change behaviour.
// Compares only what the running voice manager was built from.
func voiceRuntimeDiffers(running, onDisk muxcfg.VoiceConfig) bool {
	r, d := running.Resolved(), onDisk.Resolved()
	return r.Enabled != d.Enabled ||
		r.Endpoint != d.Endpoint ||
		r.Model != d.Model ||
		r.AuthMode != d.AuthMode ||
		r.EntraScope != d.EntraScope ||
		r.APIKeyEnv != d.APIKeyEnv ||
		r.APIKeyStored != d.APIKeyStored
}

func writeVoiceSettingsJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	// A status body is about a credential even when it contains none of
	// one; no cache anywhere should hold it.
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v) //nolint:errcheck
}

// writeVoiceSettingsError sends a message meant to be READ BY A HUMAN in the
// form. Every producer of one of these -- config.Validate, the allowlist
// below, internal/voice -- writes credential-free prose by construction.
func writeVoiceSettingsError(w http.ResponseWriter, code int, msg string) {
	writeVoiceSettingsJSON(w, code, map[string]any{"error": msg})
}

// handleVoiceSettingsGet returns the configuration and whether a secret is
// set. It never returns a secret. AuthMiddleware protects this route.
func (s *Server) handleVoiceSettingsGet(w http.ResponseWriter, _ *http.Request) {
	writeVoiceSettingsJSON(w, http.StatusOK, s.buildVoiceStatus())
}

type voiceSettingsRequest struct {
	Enabled    bool   `json:"enabled"`
	Mode       string `json:"mode"`
	Endpoint   string `json:"endpoint"`
	Model      string `json:"model"`
	EntraScope string `json:"entraScope"`
	// APIKey is write-only and OPTIONAL. Absent or empty means "leave the
	// stored key alone", which is what makes editing the model name
	// without re-typing a key possible.
	APIKey string `json:"apiKey"`
}

// handleVoiceSettingsPut validates, then persists: the key to its 0600 file,
// the rest to the [voice] section of config.toml, spliced so that every other
// section and every comment outside [voice] survives byte for byte.
//
// AuthMiddleware protects this route.
func (s *Server) handleVoiceSettingsPut(w http.ResponseWriter, r *http.Request) {
	var body voiceSettingsRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&body); err != nil {
		writeVoiceSettingsError(w, http.StatusBadRequest, "That request was not valid JSON.")
		return
	}
	if s.configPath == "" {
		writeVoiceSettingsError(w, http.StatusServiceUnavailable,
			"This server was started without a config file path, so settings cannot be saved.")
		return
	}

	voiceSettingsMu.Lock()
	defer voiceSettingsMu.Unlock()

	current := s.voiceConfigOnDisk()
	next := current
	next.Enabled = body.Enabled
	next.Model = strings.TrimSpace(body.Model)
	newKey := strings.TrimSpace(body.APIKey)

	switch body.Mode {
	case voiceModeAzureEntra:
		next.AuthMode = muxcfg.VoiceAuthEntra
		// Entra stores NO SECRET. A key arriving with an Entra save is
		// not a harmless extra field -- it means the client is confused
		// about which shape it is in, and silently dropping it would
		// leave a key on disk that nothing reads.
		if newKey != "" {
			writeVoiceSettingsError(w, http.StatusBadRequest,
				"Entra sign-in does not use a key. Remove the key, or choose an access-key mode.")
			return
		}
		ep, err := allowedVoiceEndpoint(strings.TrimSpace(body.Endpoint))
		if err != nil {
			writeVoiceSettingsError(w, http.StatusBadRequest, err.Error())
			return
		}
		next.Endpoint = ep
		scope := strings.TrimSpace(body.EntraScope)
		if scope == "" {
			scope = muxcfg.DefaultVoiceEntraScope
		}
		if !allowedScope(scope) {
			writeVoiceSettingsError(w, http.StatusBadRequest,
				"That Entra scope is not one this build accepts. Choose one of the listed scopes.")
			return
		}
		next.EntraScope = scope

	case voiceModeOpenAIKey, voiceModeAzureKey:
		next.AuthMode = muxcfg.VoiceAuthAPIKey
		if body.Mode == voiceModeOpenAIKey {
			next.Endpoint = openAIEndpoint
		} else {
			ep, err := allowedVoiceEndpoint(strings.TrimSpace(body.Endpoint))
			if err != nil {
				writeVoiceSettingsError(w, http.StatusBadRequest, err.Error())
				return
			}
			next.Endpoint = ep
		}
		// entra_scope is meaningless in a key mode; leaving a stale one
		// behind would show the wrong thing in the form next time.
		next.EntraScope = ""
		if newKey != "" {
			// Typing a key chooses the stored source. api_key_env has
			// to go, or it would keep winning and the key just typed
			// would never be read -- the worst possible outcome.
			next.APIKeyStored = true
			next.APIKeyEnv = ""
		}

	default:
		writeVoiceSettingsError(w, http.StatusBadRequest,
			`Choose how voice signs in: OpenAI key, Azure access key, or Azure with Entra sign-in.`)
		return
	}

	// C6, at the one moment a human can still fix it: an enabled section
	// that cannot work is refused, and the message names the field.
	if next.Enabled {
		if err := next.Validate(); err != nil {
			writeVoiceSettingsError(w, http.StatusBadRequest, humanizeVoiceValidation(err.Error()))
			return
		}
		if next.AuthMode == muxcfg.VoiceAuthAPIKey && newKey == "" && !s.voiceKeyPresent(next) {
			writeVoiceSettingsError(w, http.StatusBadRequest,
				"Voice cannot be turned on yet: no key is saved for this mode. Enter a key, or turn voice off until you have one.")
			return
		}
	}

	// Persist the key FIRST. If the config write then fails, the outcome is
	// a saved key that nothing reads -- inert. The reverse order would
	// leave a config claiming a key that is not there, which fails at the
	// microphone instead of here.
	if newKey != "" {
		if err := s.voiceKeyStore().Save(newKey); err != nil {
			// secretfile errors carry the path, never the key.
			log.Printf("voice_settings: save key: %v", err)
			writeVoiceSettingsError(w, http.StatusInternalServerError,
				"The key could not be written to disk, so nothing was saved.")
			return
		}
	}

	if err := muxcfg.WriteVoiceSection(s.configPath, next); err != nil {
		log.Printf("voice_settings: write config: %v", err)
		writeVoiceSettingsError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeVoiceSettingsJSON(w, http.StatusOK, s.buildVoiceStatus())
}

// voiceKeyPresent reports whether the source named by cfg currently holds
// anything. A bool; nothing about the value.
func (s *Server) voiceKeyPresent(cfg muxcfg.VoiceConfig) bool {
	switch cfg.KeySource() {
	case "stored":
		return s.voiceKeyStore().Present()
	case "env":
		return strings.TrimSpace(os.Getenv(cfg.APIKeyEnv)) != ""
	default:
		return false
	}
}

// handleVoiceSettingsDeleteKey clears the stored key and, if voice was
// enabled by it, turns voice off in the same write.
//
// Turning it off is not overreach: leaving enabled = true with api_key_stored
// = true and no key produces a section that passes Validate at startup and
// fails at the microphone, which is the exact failure mode this whole surface
// exists to eliminate.
//
// AuthMiddleware protects this route.
func (s *Server) handleVoiceSettingsDeleteKey(w http.ResponseWriter, _ *http.Request) {
	voiceSettingsMu.Lock()
	defer voiceSettingsMu.Unlock()

	if err := s.voiceKeyStore().Clear(); err != nil {
		log.Printf("voice_settings: clear key: %v", err)
		writeVoiceSettingsError(w, http.StatusInternalServerError, "The key could not be removed.")
		return
	}

	if s.configPath != "" {
		v := s.voiceConfigOnDisk()
		if v.APIKeyStored {
			v.APIKeyStored = false
			if v.AuthMode == muxcfg.VoiceAuthAPIKey && v.APIKeyEnv == "" {
				v.Enabled = false
			}
			if err := muxcfg.WriteVoiceSection(s.configPath, v); err != nil {
				log.Printf("voice_settings: write config after clear: %v", err)
				writeVoiceSettingsError(w, http.StatusInternalServerError,
					"The key was removed but the config file could not be updated.")
				return
			}
		}
	}
	writeVoiceSettingsJSON(w, http.StatusOK, s.buildVoiceStatus())
}

// handleVoiceSettingsCheck authenticates with the SAVED configuration and
// reports what happened, in prose.
//
// It checks what is on disk rather than what is in the form, so that there is
// exactly one place a credential can be and the answer describes reality. The
// cost is that a key must be saved before it can be tested; the benefit is
// that no route on this server accepts a raw secret for a transient purpose.
//
// AuthMiddleware protects this route.
func (s *Server) handleVoiceSettingsCheck(w http.ResponseWriter, r *http.Request) {
	v := s.voiceConfigOnDisk()
	if v.Endpoint == "" || v.AuthMode == "" {
		writeVoiceSettingsError(w, http.StatusBadRequest,
			"Nothing to check yet -- save an endpoint and a sign-in mode first.")
		return
	}
	if err := voice.CheckSettings(r.Context(), v, voice.DefaultKeyPath()); err != nil {
		// internal/voice never puts a credential in an error string;
		// this is safe to log and safe to show.
		log.Printf("voice_settings: check failed: %v", err)
		writeVoiceSettingsJSON(w, http.StatusOK, map[string]any{
			"ok":     false,
			"detail": strings.TrimPrefix(err.Error(), "voice: "),
		})
		return
	}
	writeVoiceSettingsJSON(w, http.StatusOK, map[string]any{
		"ok":     true,
		"detail": "Signed in successfully and the endpoint answered.",
	})
}

// allowedVoiceEndpoint bounds a SETTINGS-WRITTEN endpoint to https on a
// first-party host. See the file header for why the file path is not bound
// this way.
func allowedVoiceEndpoint(raw string) (string, error) {
	if raw == "" {
		return "", errIsMessage("Enter the endpoint URL for your Azure OpenAI resource, e.g. https://NAME.openai.azure.com/openai/v1")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", errIsMessage("That endpoint is not a valid URL.")
	}
	if u.Scheme != "https" {
		return "", errIsMessage("The endpoint must start with https:// -- a credential is sent to it.")
	}
	if u.Host == "" {
		return "", errIsMessage("That endpoint has no host name.")
	}
	host := strings.ToLower(u.Hostname())
	if host == "api.openai.com" {
		return strings.TrimSuffix(u.String(), "/"), nil
	}
	for _, suffix := range allowedVoiceEndpointSuffixes {
		if strings.HasSuffix(host, suffix) {
			return strings.TrimSuffix(u.String(), "/"), nil
		}
	}
	return "", errIsMessage("Settings only sends credentials to OpenAI and Azure OpenAI hosts (for example NAME.openai.azure.com). To use a different host, edit the [voice] section of the config file directly.")
}

func allowedScope(scope string) bool {
	for _, s := range allowedEntraScopes {
		if s == scope {
			return true
		}
	}
	return false
}

// humanizeVoiceValidation keeps config.Validate's field names -- which are
// the actionable part -- while dropping the "config: [voice]" prefix that
// means nothing to someone looking at a form.
func humanizeVoiceValidation(msg string) string {
	return strings.TrimPrefix(msg, "config: [voice] ")
}

type errIsMessage string

func (e errIsMessage) Error() string { return string(e) }
