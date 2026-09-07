// Package voice is muxterm's realtime speech-to-speech bridge.
//
// The shape, in one line: the realtime model is EARS AND A MOUTH, and the
// chief of staff keeps its brain.
//
//	Browser ──WebRTC (audio only)──▶ realtime endpoint
//	                                        ▲
//	muxterm ──────sideband WebSocket────────┘   (tool calls land HERE)
//	   │
//	   └──▶ internal/cos.Supervisor ──▶ the existing amplifier session
//
// Two channels, ONE realtime session. Audio takes the low-latency direct
// path between the browser and the vendor; tool calls take the trusted
// server path, because muxterm's tools run shell commands and tool authority
// in a browser tab is not something this codebase is willing to hand out.
// The browser is a pure audio transport and never sees a tool call.
//
// Three rules hold everywhere in this package:
//
//   - No credential is ever logged, returned in an error string, or written
//     to disk. The Entra/API credential stays in this process; only the
//     vendor's short-lived ephemeral secret is ever handed to a browser, and
//     the platform ENFORCES that split -- an SDP exchange presented with the
//     long-lived credential is refused with "This operation requires
//     ephemeral tokens for authentication".
//   - The synchronous tool path is BOUNDED. A chief-of-staff turn can run
//     for minutes; a realtime model expects a tool to return in seconds.
//     Blocking until turn_end is the design that breaks, so the synchronous
//     path gives up waiting and hands off to the asynchronous one, which
//     speaks the answer when it lands.
//   - The call id the sideband attaches to is derived by THIS process from
//     the vendor's own Location header, never accepted from the browser. A
//     browser-supplied call id would let a page point muxterm's
//     tool-executing sideband at a realtime session the page controls.
package voice

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/kenotron-ms/muxterm/internal/config"
)

// A Credential is the long-lived authentication this process holds. It never
// leaves the process: its only job is to authorize minting the short-lived
// ephemeral secret the browser gets instead.
type Credential interface {
	// Token returns a bearer token for the realtime endpoint. Callers must
	// treat the result as a secret: it is never logged or returned to a
	// client.
	Token(ctx context.Context) (string, error)
	// Mode is the config auth_mode this credential implements, for
	// diagnostics that need to say WHICH credential failed without saying
	// anything about its value.
	Mode() string
}

// NewCredential builds the credential named by cfg.AuthMode.
//
// cfg must already have passed VoiceConfig.Validate; an unrecognized mode
// here is a programming error rather than a user error and is reported as
// such.
func NewCredential(cfg config.VoiceConfig) (Credential, error) {
	switch cfg.AuthMode {
	case config.VoiceAuthEntra:
		return &entraCredential{scope: cfg.Resolved().EntraScope}, nil
	case config.VoiceAuthAPIKey:
		return &envCredential{env: cfg.APIKeyEnv}, nil
	default:
		return nil, fmt.Errorf("voice: unsupported auth_mode %q", cfg.AuthMode)
	}
}

// envCredential reads a static key from the environment at every use.
//
// Read per call, never cached in a field: an operator who rotates a key by
// restarting the shell that exported it should not have to restart muxterm,
// and a value that is never held is a value that cannot be dumped by a
// struct printf.
type envCredential struct{ env string }

func (c *envCredential) Mode() string { return config.VoiceAuthAPIKey }

func (c *envCredential) Token(context.Context) (string, error) {
	v := strings.TrimSpace(os.Getenv(c.env))
	if v == "" {
		return "", fmt.Errorf("voice: auth_mode is api_key but %s is unset or empty", c.env)
	}
	return v, nil
}

// entraCredential obtains a Microsoft Entra ID access token.
//
// Today it shells out to `az account get-access-token`, which yields a
// USER-DELEGATED token that expires hourly. That is right for development
// and wrong for a long-running gateway, which wants a service principal or
// managed identity. The whole of that difference is behind this one type and
// the Credential interface: swapping in DefaultAzureCredential is a new
// implementation of Token, not a change anywhere else in this package.
//
// Tokens are cached until shortly before their own expiry, because the az
// CLI takes on the order of a second and minting happens on a user gesture.
type entraCredential struct {
	scope string

	mu      sync.Mutex
	token   string
	expires time.Time
}

func (c *entraCredential) Mode() string { return config.VoiceAuthEntra }

// entraRefreshMargin is how long before expiry a cached token is discarded.
// Generous on purpose: an expired token surfaces as an opaque 401 at mint
// time, which is exactly the failure this package exists to make legible.
const entraRefreshMargin = 5 * time.Minute

func (c *entraCredential) Token(ctx context.Context) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.token != "" && time.Until(c.expires) > entraRefreshMargin {
		return c.token, nil
	}

	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "az", "account", "get-access-token",
		"--scope", c.scope, "--output", "json")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		// stderr is included because az's own diagnostics ("Please run
		// az login") are the actionable part, and az does not print
		// tokens to stderr. stdout, which does carry the token, is
		// never included.
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		if len(msg) > 400 {
			msg = msg[:400] + "…"
		}
		return "", fmt.Errorf("voice: az account get-access-token --scope %s failed: %s", c.scope, msg)
	}

	// expires_on is a UNIX SECONDS NUMBER while expiresOn is a local
	// datetime STRING. Decoding the former into a string field fails the
	// whole document, which is how a perfectly valid az response became
	// "output this build could not parse".
	var out struct {
		AccessToken string      `json:"accessToken"`
		ExpiresOn   json.Number `json:"expires_on"`
		Expires     string      `json:"expiresOn"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &out); err != nil {
		// The body is NOT quoted into the error: it contains the token.
		return "", errors.New("voice: az account get-access-token returned output this build could not parse")
	}
	if out.AccessToken == "" {
		return "", errors.New("voice: az account get-access-token returned no accessToken")
	}

	c.token = out.AccessToken
	// az reports expiry in a few shapes across versions. A parse failure is
	// not fatal: fall back to a conservative short cache, which costs an
	// extra az invocation and never serves an expired token.
	c.expires = time.Now().Add(10 * time.Minute)
	if secs, err := out.ExpiresOn.Int64(); err == nil && secs > 0 {
		c.expires = time.Unix(secs, 0)
	} else if ts := strings.TrimSpace(out.Expires); ts != "" {
		for _, layout := range []string{"2006-01-02 15:04:05.000000", "2006-01-02 15:04:05", time.RFC3339} {
			if t, err := time.ParseInLocation(layout, ts, time.Local); err == nil {
				c.expires = t
				break
			}
		}
	}
	return c.token, nil
}
