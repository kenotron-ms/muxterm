package config

import (
	"strings"
	"testing"
	"time"
)

// The default posture: off, and an off section never blocks startup.
func TestVoiceDefaultsAreOffAndValid(t *testing.T) {
	d := Defaults()
	if d.Voice.Enabled {
		t.Fatal("realtime voice must be OFF by default: it opens a microphone and bills per minute")
	}
	if err := d.Voice.Validate(); err != nil {
		t.Fatalf("a disabled [voice] section must never be a startup error, got %v", err)
	}
	if d.Voice.EntraScope != DefaultVoiceEntraScope {
		t.Fatalf("entra_scope default = %q, want %q", d.Voice.EntraScope, DefaultVoiceEntraScope)
	}
	if d.Voice.SyncToolTimeout != DefaultVoiceSyncToolTimeout {
		t.Fatalf("sync_tool_timeout default = %v, want %v", d.Voice.SyncToolTimeout, DefaultVoiceSyncToolTimeout)
	}
}

// The load-bearing rule of C1: auth_mode is REQUIRED and never guessed.
// A resource with key auth disabled answers an API-key request with a bare
// 401 naming neither credential, so the mode has to be stated.
func TestVoiceAuthModeIsRequiredAndNeverGuessed(t *testing.T) {
	v := VoiceConfig{
		Enabled:  true,
		Endpoint: "https://example.openai.azure.com/openai/v1",
		Model:    "gpt-realtime-2.1",
	}
	err := v.Validate()
	if err == nil {
		t.Fatal("an enabled [voice] section with no auth_mode must be a hard config error")
	}
	if !strings.Contains(err.Error(), "auth_mode") {
		t.Fatalf("the error must name auth_mode so the operator knows what to set, got %q", err)
	}

	v.AuthMode = "bearer-ish"
	if err := v.Validate(); err == nil {
		t.Fatal("an unrecognized auth_mode must be rejected, not silently accepted")
	}

	v.AuthMode = VoiceAuthEntra
	if err := v.Validate(); err != nil {
		t.Fatalf("auth_mode = entra should validate, got %v", err)
	}
}

func TestVoiceAPIKeyModeRequiresEnvVarName(t *testing.T) {
	v := VoiceConfig{
		Enabled:  true,
		Endpoint: "https://example.openai.azure.com/openai/v1",
		Model:    "gpt-realtime-2.1",
		AuthMode: VoiceAuthAPIKey,
	}
	if err := v.Validate(); err == nil {
		t.Fatal(`auth_mode = "api_key" without api_key_env must be rejected: there is nowhere to read the key from`)
	}
	v.APIKeyEnv = "MUXTERM_VOICE_KEY"
	if err := v.Validate(); err != nil {
		t.Fatalf("api_key mode with api_key_env should validate, got %v", err)
	}
}

func TestVoiceEnabledRequiresEndpointAndModel(t *testing.T) {
	for _, tc := range []struct {
		name string
		v    VoiceConfig
		want string
	}{
		{"no endpoint", VoiceConfig{Enabled: true, Model: "m", AuthMode: VoiceAuthEntra}, "endpoint"},
		{"bad endpoint", VoiceConfig{Enabled: true, Endpoint: "ftp://x/y", Model: "m", AuthMode: VoiceAuthEntra}, "scheme"},
		{"no host", VoiceConfig{Enabled: true, Endpoint: "https:///openai/v1", Model: "m", AuthMode: VoiceAuthEntra}, "host"},
		{"no model", VoiceConfig{Enabled: true, Endpoint: "https://h/openai/v1", AuthMode: VoiceAuthEntra}, "model"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.v.Validate()
			if err == nil {
				t.Fatalf("want an error mentioning %q, got nil", tc.want)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error %q should mention %q", err, tc.want)
			}
		})
	}
}

func TestVoiceResolvedFillsOptionals(t *testing.T) {
	got := VoiceConfig{Enabled: true}.Resolved()
	if got.EntraScope != DefaultVoiceEntraScope {
		t.Fatalf("EntraScope = %q, want %q", got.EntraScope, DefaultVoiceEntraScope)
	}
	if got.SyncToolTimeout != DefaultVoiceSyncToolTimeout {
		t.Fatalf("SyncToolTimeout = %v, want %v", got.SyncToolTimeout, DefaultVoiceSyncToolTimeout)
	}
	custom := VoiceConfig{EntraScope: "https://other/.default", SyncToolTimeout: time.Second}.Resolved()
	if custom.EntraScope != "https://other/.default" || custom.SyncToolTimeout != time.Second {
		t.Fatalf("Resolved must not overwrite explicit values, got %+v", custom)
	}
}

// [voice] names an outbound endpoint and an auth mode. A browser PATCH
// /api/config must not be able to repoint muxterm's credential at a host of
// the caller's choosing, so Merge -- which backs that route -- must ignore
// the whole section, exactly as it ignores [server].
func TestVoiceIsNotMergeableFromTheBrowser(t *testing.T) {
	base := Defaults()
	base.Voice = VoiceConfig{
		Enabled:  true,
		Endpoint: "https://trusted.openai.azure.com/openai/v1",
		Model:    "gpt-realtime-2.1",
		AuthMode: VoiceAuthEntra,
	}
	attacker := Config{Voice: VoiceConfig{
		Enabled:  true,
		Endpoint: "https://attacker.example.com/openai/v1",
		Model:    "gpt-realtime-2.1",
		AuthMode: VoiceAuthAPIKey,
	}}
	got := Merge(base, attacker)
	if got.Voice.Endpoint != "https://trusted.openai.azure.com/openai/v1" {
		t.Fatalf("Merge repointed the voice endpoint to %q -- a browser must never be able to do that", got.Voice.Endpoint)
	}
	if got.Voice.AuthMode != VoiceAuthEntra {
		t.Fatalf("Merge changed auth_mode to %q from a request body", got.Voice.AuthMode)
	}
}
