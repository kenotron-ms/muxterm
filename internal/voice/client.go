package voice

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/kenotron-ms/muxterm/internal/config"
)

// Client talks to the realtime endpoint on muxterm's behalf. It is the only
// thing in the process that holds the Credential.
type Client struct {
	cfg  config.VoiceConfig
	cred Credential
	http *http.Client
}

// diagnosticError carries only a finite, server-safe operational classification.
// It deliberately never wraps the underlying provider, credential, URL, or
// transport error: those can reflect credentials, response IDs, endpoints, or
// identity details. Browser endpoints use fixed copy; server logs use
// SafeDiagnostic so production can still distinguish failure classes.
type diagnosticError struct {
	operation string
	detail    string
}

func (e *diagnosticError) Error() string {
	return fmt.Sprintf("voice: %s: %s", e.operation, e.detail)
}

func newDiagnosticError(operation, detail string) error {
	return &diagnosticError{operation: operation, detail: detail}
}

// SafeDiagnostic returns an error description suitable for server logs. It
// exposes only diagnostics intentionally constructed by this package; unknown
// errors reduce to a fixed category instead of leaking their body/string.
func SafeDiagnostic(err error) string {
	var diagnostic *diagnosticError
	if errors.As(err, &diagnostic) {
		return diagnostic.Error()
	}
	return "voice: unexpected internal failure"
}

func transportDiagnostic(operation string, err error) error {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return newDiagnosticError(operation, "request timed out")
	case errors.Is(err, context.Canceled):
		return newDiagnosticError(operation, "request canceled")
	default:
		return newDiagnosticError(operation, "transport failed")
	}
}

// NewClient builds a Client for an already-validated config.
func NewClient(cfg config.VoiceConfig, cred Credential) *Client {
	return &Client{
		cfg:  cfg.Resolved(),
		cred: cred,
		// No global timeout: the SDP exchange and the mint are both
		// short, but each call sets its own context deadline, and a
		// client-level timeout would silently override those.
		http: &http.Client{},
	}
}

// Config returns the resolved config this client was built with.
func (c *Client) Config() config.VoiceConfig { return c.cfg }

// Ephemeral is a minted short-lived client secret. Value is a SECRET: it is
// handed to exactly one browser and is never logged.
type Ephemeral struct {
	Value     string `json:"value"`
	ExpiresAt int64  `json:"expires_at,omitempty"`
	SessionID string `json:"session_id,omitempty"`
}

// MintEphemeral creates a realtime session and returns its ephemeral client
// secret.
//
// The session's instructions and tools are fixed HERE, server-side, at mint
// time. That is deliberate: the tool list is the bridge's authority surface,
// and a browser that could name its own tools would be naming shell commands.
func (c *Client) MintEphemeral(ctx context.Context) (Ephemeral, error) {
	tok, err := c.cred.Token(ctx)
	if err != nil {
		return Ephemeral{}, newDiagnosticError("mint ephemeral secret", "credential unavailable")
	}

	session := map[string]any{
		"type":         "realtime",
		"model":        c.cfg.Model,
		"instructions": Instructions(),
		"tools":        ToolDefinitions(),
	}
	if c.cfg.Voice != "" {
		session["audio"] = map[string]any{
			"output": map[string]any{"voice": c.cfg.Voice},
		}
	}
	body, err := json.Marshal(map[string]any{"session": session})
	if err != nil {
		return Ephemeral{}, newDiagnosticError("mint ephemeral secret", "request encoding failed")
	}

	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.cfg.Endpoint+"/realtime/client_secrets", bytes.NewReader(body))
	if err != nil {
		return Ephemeral{}, newDiagnosticError("mint ephemeral secret", "request construction failed")
	}
	c.authorize(req, tok)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return Ephemeral{}, transportDiagnostic("mint ephemeral secret", err)
	}
	defer resp.Body.Close() //nolint:errcheck

	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return Ephemeral{}, c.safeProviderFailure("minting an ephemeral secret", resp.StatusCode)
	}

	var out struct {
		Value     string          `json:"value"`
		ExpiresAt int64           `json:"expires_at"`
		Session   json.RawMessage `json:"session"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		// raw carries the secret; it is never quoted into an error.
		return Ephemeral{}, newDiagnosticError("mint ephemeral secret", "provider response could not be parsed")
	}
	if out.Value == "" {
		return Ephemeral{}, newDiagnosticError("mint ephemeral secret", "provider returned no client secret")
	}
	var sess struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(out.Session, &sess)
	return Ephemeral{Value: out.Value, ExpiresAt: out.ExpiresAt, SessionID: sess.ID}, nil
}

// Answer is the result of an SDP exchange.
type Answer struct {
	SDP    string
	CallID string
}

// ExchangeSDP posts a browser's SDP offer to the realtime endpoint and
// returns the answer plus the CALL ID the vendor assigned.
//
// The call id comes out of the response's Location header, read by this
// process. That is the whole reason the exchange is proxied here rather than
// done straight from the browser: the sideband that attaches to that call id
// executes shell tools, so the id it attaches to must be one muxterm
// observed the vendor mint, not one a page handed it.
//
// The ephemeral secret is the bearer, not the long-lived credential. The
// platform requires this: presenting the long-lived credential here is
// refused outright with "This operation requires ephemeral tokens for
// authentication".
func (c *Client) ExchangeSDP(ctx context.Context, ephemeral, offerSDP string) (Answer, error) {
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()

	u := c.cfg.Endpoint + "/realtime/calls?model=" + url.QueryEscape(c.cfg.Model)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, strings.NewReader(offerSDP))
	if err != nil {
		return Answer{}, newDiagnosticError("SDP exchange", "request construction failed")
	}
	req.Header.Set("Authorization", "Bearer "+ephemeral)
	req.Header.Set("Content-Type", "application/sdp")

	resp, err := c.http.Do(req)
	if err != nil {
		return Answer{}, transportDiagnostic("SDP exchange", err)
	}
	defer resp.Body.Close() //nolint:errcheck

	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// Same withholding rule as the mint path. The bearer here is the
		// short-lived ephemeral secret rather than the long-lived
		// credential, but it is still a secret and a 401 body is still
		// the one place a vendor quotes part of it back.
		return Answer{}, c.safeProviderFailure("SDP exchange", resp.StatusCode)
	}

	loc := resp.Header.Get("Location")
	callID := ""
	if i := strings.LastIndex(loc, "/"); i >= 0 && i+1 < len(loc) {
		callID = loc[i+1:]
	}
	if callID == "" {
		// Not fatal for audio -- the browser can still talk to the
		// model -- but it IS fatal for tools, and a voice assistant
		// that cannot act is not the thing being built. Say so here
		// rather than let the sideband fail obscurely later.
		return Answer{SDP: string(raw)}, newDiagnosticError("SDP exchange", "provider returned no tool-call identifier")
	}
	return Answer{SDP: string(raw), CallID: callID}, nil
}

// authorize applies the credential in the form its mode requires.
func (c *Client) authorize(req *http.Request, tok string) {
	switch c.cred.Mode() {
	case config.VoiceAuthAPIKey:
		// Both spellings, because the same endpoint shape is served by
		// deployments that accept one or the other and neither is
		// harmful where it is ignored.
		req.Header.Set("api-key", tok)
		req.Header.Set("Authorization", "Bearer "+tok)
	default:
		req.Header.Set("Authorization", "Bearer "+tok)
	}
}

// authHint turns the single most confusing failure in this whole surface --
// an unexplained 401 from a resource whose key auth is switched off -- into a
// sentence that names the actual cause.
func (c *Client) authHint(status int) string {
	if status != http.StatusUnauthorized && status != http.StatusForbidden {
		return ""
	}
	if c.cred.Mode() == config.VoiceAuthAPIKey {
		return fmt.Sprintf(" (auth_mode is %q; if this resource has API-key authentication disabled, set auth_mode = %q)",
			config.VoiceAuthAPIKey, config.VoiceAuthEntra)
	}
	return fmt.Sprintf(" (auth_mode is %q against scope %s; check that the signed-in identity has access to this resource)",
		config.VoiceAuthEntra, c.cfg.EntraScope)
}

// WebSocketURL is the sideband address for one call id.
func (c *Client) WebSocketURL(callID string) (string, error) {
	u, err := url.Parse(c.cfg.Endpoint)
	if err != nil {
		return "", fmt.Errorf("voice: endpoint %q is not a valid URL: %w", c.cfg.Endpoint, err)
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	case "http":
		u.Scheme = "ws"
	}
	u.Path = strings.TrimSuffix(u.Path, "/") + "/realtime"
	q := u.Query()
	q.Set("call_id", callID)
	u.RawQuery = q.Encode()
	return u.String(), nil
}

// safeProviderFailure is deliberately body-free. Providers can reflect either
// the long-lived credential used for minting or the ephemeral SDP bearer.
func (c *Client) safeProviderFailure(stage string, status int) error {
	return newDiagnosticError(stage, fmt.Sprintf("provider returned HTTP %d%s", status, c.authHint(status)))
}
