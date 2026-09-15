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

// StartupError is the safe public classification for app-voice startup
// failures. Cause remains available to trusted callers through Unwrap, but
// must never be serialized or logged.
type StartupError struct {
	Stage      string
	HTTPStatus int
	Code       string
	Parameter  string
	cause      error
	class      startupErrorClass
}

type startupErrorClass uint8

const (
	startupErrorUnknown startupErrorClass = iota
	startupErrorCredential
	startupErrorDeadline
	startupErrorTransport
)

func (e *StartupError) Error() string { return e.Message() }

func (e *StartupError) Unwrap() error { return e.cause }

// Message returns a fixed safe message. No provider body, endpoint,
// credential, session ID, or wrapped error is included.
func (e *StartupError) Message() string {
	if e.Parameter == "session.audio.output.voice" {
		return "Voice provider rejected the session voice setting. Leave Voice empty for the provider default or select a supported voice."
	}
	switch e.Parameter {
	case "session.model":
		return "Voice provider rejected the session model setting. Select a supported voice model."
	case "session.tools":
		return "Voice provider rejected the session tools setting. Check provider support for voice mode."
	}
	switch e.HTTPStatus {
	case http.StatusUnauthorized, http.StatusForbidden:
		return "Voice provider authentication failed. Check the configured voice credential."
	case http.StatusTooManyRequests:
		return "Voice provider is temporarily busy. Try again shortly."
	}
	if e.Stage == "sideband" {
		return "Voice provider session started, but its tool connection could not be established. Try again."
	}
	switch e.class {
	case startupErrorCredential:
		return "Voice provider credentials are unavailable. Check the configured voice credential."
	case startupErrorDeadline:
		return "Voice provider did not respond before setup timed out. Try again."
	case startupErrorTransport:
		return "Voice provider connection could not be established. Try again."
	}
	switch e.Stage {
	case "sdp_exchange":
		return "Voice provider could not establish the voice connection. Try again."
	default:
		return "Voice provider could not start a session. Try again."
	}
}

// SafeStartupFailure extracts only the safe fields intended for app-voice
// diagnostics and responses. Untyped failures receive a fixed stage message.
func SafeStartupFailure(err error) StartupError {
	var startup *StartupError
	if errors.As(err, &startup) {
		return StartupError{
			Stage:      startup.Stage,
			HTTPStatus: startup.HTTPStatus,
			Code:       startup.Code,
			Parameter:  startup.Parameter,
			class:      startup.class,
		}
	}
	return StartupError{Stage: "session_mint"}
}

// MintEphemeral creates a realtime session and returns its ephemeral client
// secret.
//
// The session's instructions and tools are fixed HERE, server-side, at mint
// time. That is deliberate: the tool list is the bridge's authority surface,
// and a browser that could name its own tools would be naming shell commands.
func (c *Client) MintEphemeral(ctx context.Context) (Ephemeral, error) {
	return c.mintEphemeral(ctx, false)
}

// MintEphemeralScoped uses server_vad with create_response:false. The
// attachment must therefore wait for a server-owned capture/item mapping and
// deterministic prefix acknowledgement before asking the provider to respond.
func (c *Client) MintEphemeralScoped(ctx context.Context) (Ephemeral, error) {
	return c.mintEphemeral(ctx, true)
}

// MintEphemeralApp creates the persistent app bridge profile.  The browser
// never receives its bearer: SDP is proxied by the server.
func (c *Client) MintEphemeralApp(ctx context.Context) (Ephemeral, error) {
	return c.mintApp(ctx)
}

func (c *Client) mintApp(ctx context.Context) (Ephemeral, error) {
	tok, err := c.cred.Token(ctx)
	if err != nil {
		return Ephemeral{}, startupFailure("credential", 0, err)
	}
	session := map[string]any{
		"type": "realtime", "model": c.cfg.Model, "instructions": AppInstructions(),
		"tools": AppToolDefinitions(),
		"audio": map[string]any{
			"input": map[string]any{
				// v0.32 deliberately inherited the provider's server_vad
				// profile. Its measured gpt-realtime-2.1 baseline was
				// threshold=.5, prefix padding=300ms, silence=500ms, and
				// interruption enabled (docs/research/realtime-voice.md).
				// App Voice keeps create_response:false for its correlated
				// Operator handoff, so name that compatibility profile here
				// instead of letting a provider/model default shorten it.
				"turn_detection": map[string]any{
					"type":                "server_vad",
					"threshold":           0.5,
					"prefix_padding_ms":   300,
					"silence_duration_ms": 500,
					"interrupt_response":  true,
					"create_response":     false,
				},
				"transcription": map[string]any{"model": "whisper-1"},
			},
		},
	}
	if c.cfg.Voice != "" {
		session["audio"].(map[string]any)["output"] = map[string]any{"voice": c.cfg.Voice}
	}
	body, err := json.Marshal(map[string]any{"session": session})
	if err != nil {
		return Ephemeral{}, startupFailure("session_mint", 0, err)
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.cfg.Endpoint+"/realtime/client_secrets", bytes.NewReader(body))
	if err != nil {
		return Ephemeral{}, startupFailure("session_mint", 0, err)
	}
	c.authorize(req, tok)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return Ephemeral{}, startupFailure("session_mint", 0, err)
	}
	defer resp.Body.Close() //nolint:errcheck
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return Ephemeral{}, startupProviderFailure("session_mint", resp.StatusCode, raw)
	}
	var out struct {
		Value     string          `json:"value"`
		ExpiresAt int64           `json:"expires_at"`
		Session   json.RawMessage `json:"session"`
	}
	if err := json.Unmarshal(raw, &out); err != nil || out.Value == "" {
		return Ephemeral{}, startupFailure("session_mint", 0, err)
	}
	var sess struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(out.Session, &sess)
	return Ephemeral{Value: out.Value, ExpiresAt: out.ExpiresAt, SessionID: sess.ID}, nil
}

// ExchangeSDPApp is the app-voice variant of ExchangeSDP. It preserves the
// transport and call-ID policy while returning only safe startup errors.
func (c *Client) ExchangeSDPApp(ctx context.Context, ephemeral, offerSDP string) (Answer, error) {
	return c.exchangeSDP(ctx, ephemeral, offerSDP, true)
}

func (c *Client) exchangeSDP(ctx context.Context, ephemeral, offerSDP string, app bool) (Answer, error) {
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()

	u := c.cfg.Endpoint + "/realtime/calls?model=" + url.QueryEscape(c.cfg.Model)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, strings.NewReader(offerSDP))
	if err != nil {
		if !app {
			return Answer{}, fmt.Errorf("voice: build SDP request: %w", err)
		}
		return Answer{}, startupFailure("sdp_exchange", 0, err)
	}
	req.Header.Set("Authorization", "Bearer "+ephemeral)
	req.Header.Set("Content-Type", "application/sdp")

	resp, err := c.http.Do(req)
	if err != nil {
		if !app {
			return Answer{}, fmt.Errorf("voice: SDP exchange with the realtime endpoint failed: %w", err)
		}
		return Answer{}, startupFailure("sdp_exchange", 0, err)
	}
	defer resp.Body.Close() //nolint:errcheck

	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if !app {
			// Same withholding rule as the mint path. The bearer here is the
			// short-lived ephemeral secret rather than the long-lived
			// credential, but it is still a secret and a 401 body is still
			// the one place a vendor quotes part of it back.
			return Answer{}, fmt.Errorf("voice: SDP exchange returned HTTP %d: %s", resp.StatusCode, authSafeSnippet(raw, resp.StatusCode))
		}
		return Answer{}, startupProviderFailure("sdp_exchange", resp.StatusCode, raw)
	}
	loc := resp.Header.Get("Location")
	callID := ""
	if i := strings.LastIndex(loc, "/"); i >= 0 && i+1 < len(loc) {
		callID = loc[i+1:]
	}
	if callID == "" {
		if !app {
			// Not fatal for audio -- the browser can still talk to the
			// model -- but it IS fatal for tools, and a voice assistant
			// that cannot act is not the thing being built. Say so here
			// rather than let the sideband fail obscurely later.
			return Answer{SDP: string(raw)}, fmt.Errorf("voice: the realtime endpoint returned no Location header, so there is no call id to attach the tool sideband to")
		}
		return Answer{}, &StartupError{Stage: "sdp_exchange"}
	}
	return Answer{SDP: string(raw), CallID: callID}, nil
}

func (c *Client) mintEphemeral(ctx context.Context, scoped bool) (Ephemeral, error) {
	tok, err := c.cred.Token(ctx)
	if err != nil {
		return Ephemeral{}, err
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
	if scoped {
		audio := map[string]any{
			"input": map[string]any{
				"turn_detection": map[string]any{"type": "server_vad", "create_response": false},
			},
		}
		if c.cfg.Voice != "" {
			audio["output"] = map[string]any{"voice": c.cfg.Voice}
		}
		session["audio"] = audio
	}
	body, err := json.Marshal(map[string]any{"session": session})
	if err != nil {
		return Ephemeral{}, fmt.Errorf("voice: encode mint request: %w", err)
	}

	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.cfg.Endpoint+"/realtime/client_secrets", bytes.NewReader(body))
	if err != nil {
		return Ephemeral{}, fmt.Errorf("voice: build mint request: %w", err)
	}
	c.authorize(req, tok)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return Ephemeral{}, fmt.Errorf("voice: mint request to the realtime endpoint failed: %w", err)
	}
	defer resp.Body.Close() //nolint:errcheck

	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return Ephemeral{}, fmt.Errorf("voice: minting an ephemeral secret returned HTTP %d: %s%s",
			resp.StatusCode, authSafeSnippet(raw, resp.StatusCode), c.authHint(resp.StatusCode))
	}

	var out struct {
		Value     string          `json:"value"`
		ExpiresAt int64           `json:"expires_at"`
		Session   json.RawMessage `json:"session"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		// raw carries the secret; it is never quoted into an error.
		return Ephemeral{}, fmt.Errorf("voice: the realtime endpoint returned a mint response this build could not parse")
	}
	if out.Value == "" {
		return Ephemeral{}, fmt.Errorf("voice: the realtime endpoint minted no client secret")
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
	return c.exchangeSDP(ctx, ephemeral, offerSDP, false)
}

func startupFailure(stage string, status int, cause error) *StartupError {
	class := startupErrorUnknown
	if stage == "credential" {
		class = startupErrorCredential
	} else if errors.Is(cause, context.DeadlineExceeded) {
		class = startupErrorDeadline
	} else {
		var transport *url.Error
		if errors.As(cause, &transport) {
			class = startupErrorTransport
		}
	}
	return &StartupError{Stage: stage, HTTPStatus: status, cause: cause, class: class}
}

func startupProviderFailure(stage string, status int, body []byte) *StartupError {
	failure := &StartupError{Stage: stage, HTTPStatus: status}
	// Authentication responses can quote credentials. Their body is never
	// parsed, even for otherwise allowlisted fields.
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		return failure
	}
	var response struct {
		Error struct {
			Code  string `json:"code"`
			Type  string `json:"type"`
			Param string `json:"param"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &response) != nil {
		return failure
	}
	failure.Code = allowedStartupCode(response.Error.Code)
	if failure.Code == "" {
		failure.Code = allowedStartupCode(response.Error.Type)
	}
	failure.Parameter = allowedStartupParameter(response.Error.Param)
	return failure
}

func allowedStartupCode(value string) string {
	switch value {
	case "invalid_value", "invalid_request_error", "model_not_found",
		"unsupported_value", "unsupported_model", "quota_exceeded",
		"insufficient_quota", "rate_limit", "rate_limit_exceeded":
		return value
	default:
		return ""
	}
}

func allowedStartupParameter(value string) string {
	switch value {
	case "session.audio.output.voice", "session.model", "session.tools":
		return value
	default:
		return ""
	}
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

// authSafeSnippet is snippet() with one exception: on 401 and 403 the body is
// withheld entirely.
//
// The comment on snippet below used to say error bodies from these endpoints
// are "never credentials". That is true of every status except these two. A
// real response to a bad key reads:
//
//	Incorrect API key provided: sk-FAKE-***********************0000
//
// The vendor masks the middle and leaves the prefix and the last four
// characters, which is exactly what muxterm's own settings API refuses to
// return -- so quoting it into an error string (which is logged) would leak
// through the back door what the front door was built to withhold.
func authSafeSnippet(b []byte, status int) string {
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		return "(response withheld: it can quote part of the credential)"
	}
	return snippet(b)
}

// snippet bounds an error body so a vendor's HTML error page cannot flood a
// log line. Callers on an auth status must use authSafeSnippet instead.
func snippet(b []byte) string {
	s := strings.TrimSpace(string(b))
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) > 300 {
		return s[:300] + "…"
	}
	return s
}
