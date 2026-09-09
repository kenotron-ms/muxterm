package voice

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/kenotron-ms/muxterm/internal/config"
)

// CheckAuth answers the only question a credential form can usefully ask:
// does this credential actually authenticate against this endpoint?
//
// It is the C4 affordance. A credential saved and not checked becomes a
// runtime failure minutes or days later, at the moment someone presses the
// microphone -- which is exactly the confusing experience that hand-editing
// TOML produced and that this settings surface exists to end.
//
// TWO STEPS, because they fail for different reasons and a user needs to know
// which one broke:
//
//  1. ACQUIRE the credential. For entra that runs `az account get-access-token`
//     and fails when nobody is signed in; for api_key it reads the env var or
//     the saved key file and fails when neither holds anything. No network.
//  2. PRESENT it to the endpoint, with an authenticated GET {endpoint}/models.
//
// Step 2 is deliberately a model LIST, not a realtime session: listing is
// free and instantaneous, and it exercises the identical auth path that
// minting does -- same header shape from Client.authorize, same resource,
// same tenant. Nothing here opens a microphone, creates a session, or bills a
// minute of audio.
//
// The returned error is safe to show a user and safe to log: it names the
// mode, the scope and the endpoint, and never the credential. The 401/403
// text comes from Client.authHint, the same sentence the mint path produces,
// because there is exactly one right explanation for "this resource has key
// auth switched off" and it should not be written twice.
func (c *Client) CheckAuth(ctx context.Context) error {
	tok, err := c.cred.Token(ctx)
	if err != nil {
		// Already a legible, credential-free sentence from
		// credential.go -- "az account get-access-token failed: Please
		// run az login", or "MUXTERM_VOICE_KEY is unset or empty".
		return err
	}
	if tok == "" {
		return errors.New("voice: the credential resolved to an empty value")
	}

	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.cfg.Endpoint+"/models", nil)
	if err != nil {
		return fmt.Errorf("voice: build the check request: %w", err)
	}
	c.authorize(req, tok)

	resp, err := c.http.Do(req)
	if err != nil {
		// DNS, TLS, connection refused, timeout. A user with a valid
		// credential and a typo in the hostname lands here, and telling
		// them to "check the key" would be wrong.
		return fmt.Errorf("voice: could not reach %s -- check the endpoint URL and this machine's network: %w", c.cfg.Endpoint, err)
	}
	defer resp.Body.Close() //nolint:errcheck

	// Read and discard: the body of a success is a model list nobody here
	// needs, and draining it lets the connection be reused.
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))

	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		return nil

	case resp.StatusCode == http.StatusUnauthorized, resp.StatusCode == http.StatusForbidden:
		// THE VENDOR BODY IS DROPPED HERE, and only here, because on this
		// exact status it quotes the credential back. Observed from
		// OpenAI with a deliberately fake key:
		//
		//	Incorrect API key provided: sk-FAKE-***********************0000
		//
		// The middle is masked; the PREFIX AND THE LAST FOUR CHARACTERS
		// are not. Those are precisely what the settings API refuses to
		// return, so passing this body through to the browser -- or into
		// the log -- would hand back through the check button what GET
		// was built never to reveal.
		//
		// A literal scrub of the token cannot fix this: the masked form
		// is not a substring of the key, so there is nothing to search
		// for. Dropping the body on 401/403 is the only reliable answer,
		// and it costs little, because on this status muxterm's own
		// explanation is the useful one anyway.
		return fmt.Errorf("voice: %s rejected this credential (HTTP %d)%s",
			c.cfg.Endpoint, resp.StatusCode, c.authHint(resp.StatusCode))

	case resp.StatusCode == http.StatusNotFound:
		// The credential was accepted well enough to get routed; the
		// path is what is wrong. Naming the expected shape saves a
		// round of guessing.
		return fmt.Errorf("voice: %s answered HTTP 404 -- the endpoint should be the OpenAI-compatible v1 base URL, e.g. https://NAME.openai.azure.com/openai/v1 for Azure or https://api.openai.com/v1 for OpenAI", c.cfg.Endpoint)
	default:
		return fmt.Errorf("voice: the endpoint rejected this credential with HTTP %d: %s%s",
			resp.StatusCode, snippet(raw), c.authHint(resp.StatusCode))
	}
}

// CheckSettings builds a throwaway client for cfg and runs CheckAuth against
// it, so a credential can be verified WITHOUT voice being enabled and without
// touching the live Manager.
//
// That ordering matters for the flow this surface is built around: save the
// credential, prove it works, and only then turn the capability on. Requiring
// voice to be enabled before it could be tested would force everyone through
// the broken-in-production state this is meant to prevent.
func CheckSettings(ctx context.Context, cfg config.VoiceConfig, keyPath string) error {
	// Validate against an Enabled copy: the structural rules (endpoint,
	// model, auth_mode) are exactly the ones a check needs satisfied, and
	// Validate short-circuits to nil for a disabled section.
	probe := cfg
	probe.Enabled = true
	if err := probe.Validate(); err != nil {
		return err
	}
	cred, err := NewCredential(probe, keyPath)
	if err != nil {
		return err
	}
	return NewClient(probe, cred).CheckAuth(ctx)
}
