package voice

import (
	"fmt"
	"net/http"

	"github.com/kenotron-ms/muxterm/internal/config"
)

// Client checks a saved voice credential against its configured endpoint.
type Client struct {
	cfg  config.VoiceConfig
	cred Credential
	http *http.Client
}

func NewClient(cfg config.VoiceConfig, cred Credential) *Client {
	return &Client{cfg: cfg.Resolved(), cred: cred, http: &http.Client{}}
}

func (c *Client) authorize(req *http.Request, token string) {
	if c.cred.Mode() == config.VoiceAuthAPIKey {
		req.Header.Set("api-key", token)
	}
	req.Header.Set("Authorization", "Bearer "+token)
}

func (c *Client) authHint(status int) string {
	if status != http.StatusUnauthorized && status != http.StatusForbidden {
		return ""
	}
	if c.cred.Mode() == config.VoiceAuthAPIKey {
		return fmt.Sprintf(" (auth_mode is %q; if this resource has API-key authentication disabled, set auth_mode = %q)", config.VoiceAuthAPIKey, config.VoiceAuthEntra)
	}
	return fmt.Sprintf(" (auth_mode is %q against scope %s; check that the signed-in identity has access to this resource)", config.VoiceAuthEntra, c.cfg.EntraScope)
}
