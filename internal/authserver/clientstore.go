package authserver

import (
	"context"
	"fmt"
	"net/url"

	"github.com/go-oauth2/oauth2/v4"
	"github.com/go-oauth2/oauth2/v4/models"
)

// Hardcoded client IDs. See design doc "Client model" for why these two
// (and only these two) exist, and why they differ only in redirect URI
// validation shape, not permission level — full access is the only access
// level muxterm has, so there is nothing else to differentiate on.
const (
	ClientWeb = "muxterm-web"
	// ClientMCP is unused until Phase 2 (MCP-over-HTTP); the client entry
	// exists now so its redirect-URI validation shape is fixed from day
	// one, matching the design doc's intent.
	ClientMCP = "muxterm-mcp"

	// webDomainSentinel is the deliberately non-URL-shaped placeholder
	// Domain for ClientWeb. The authoritative per-request check runs in
	// AuthServer.ServeAuthorize, where the incoming request's Host is
	// available.
	webDomainSentinel = "muxterm-web:dynamic"

	// mcpDomainSentinel is the fixed placeholder Domain value for
	// ClientMCP. It is not itself a real redirect URI — it exists only so
	// validateRedirectURI can recognize "this is the muxterm-mcp client"
	// and apply the bounded loopback-port exception.
	mcpDomainSentinel = "http://127.0.0.1"
)

type staticClientStore struct {
	clients map[string]oauth2.ClientInfo
}

// NewClientStore returns the fixed ClientStore containing muxterm-web and
// muxterm-mcp. There is no dynamic client registration (see design doc
// "Alternatives Considered"). muxterm-web's redirect URI is validated
// dynamically in AuthServer.ServeAuthorize because only that layer has the
// incoming request needed to derive the browser's actual origin.
func NewClientStore() oauth2.ClientStore {
	return &staticClientStore{
		clients: map[string]oauth2.ClientInfo{
			ClientWeb: &models.Client{
				ID:     ClientWeb,
				Secret: "", // public client, no secret — PKCE only
				Domain: webDomainSentinel,
				Public: true,
			},
			ClientMCP: &models.Client{
				ID:     ClientMCP,
				Secret: "",
				Domain: mcpDomainSentinel,
				Public: true,
			},
		},
	}
}

func (s *staticClientStore) GetByID(_ context.Context, id string) (oauth2.ClientInfo, error) {
	c, ok := s.clients[id]
	if !ok {
		return nil, fmt.Errorf("authserver: unknown client_id %q", id)
	}
	return c, nil
}

// validateRedirectURI implements the library-level redirect URI checks.
// muxterm-web's authoritative exact-match check runs in
// AuthServer.ServeAuthorize because it requires the incoming request's Host.
// muxterm-mcp keeps the ONE bounded exception described in the design doc's
// "Client model": any port on http://127.0.0.1 is allowed, while scheme and
// host are still exact.
//
// Path is intentionally NOT validated for muxterm-mcp here: the exact
// callback path is a Phase 2 decision (MCP-over-HTTP's client contract
// isn't designed yet). Tighten this to an exact-path check in Phase 2 once
// that path is fixed — tracked as a known Phase 1 -> Phase 2 follow-up, not
// a gap in this phase's own scope (ClientMCP is unused until Phase 2).
func validateRedirectURI(clientDomain, redirectURI string) error {
	if clientDomain == redirectURI {
		return nil
	}

	if clientDomain == webDomainSentinel {
		// For authorization requests, the authoritative muxterm-web check
		// already happened in AuthServer.ServeAuthorize, which has real
		// *http.Request access this callback's (domain, redirectURI string)
		// signature does not. At token exchange, go-oauth2 binds the submitted
		// URI to the exact URI stored with the authorization code. This branch
		// is a documented, deliberate pass-through, not a missing check.
		return nil
	}

	if clientDomain == mcpDomainSentinel {
		u, err := url.Parse(redirectURI)
		if err != nil {
			return fmt.Errorf("authserver: invalid redirect_uri: %w", err)
		}
		if u.Scheme != "http" {
			return fmt.Errorf("authserver: redirect_uri scheme must be http for muxterm-mcp")
		}
		if u.Hostname() != "127.0.0.1" {
			return fmt.Errorf("authserver: redirect_uri host must be 127.0.0.1 for muxterm-mcp")
		}
		// Port is intentionally unchecked — the one bounded exception.
		return nil
	}

	return fmt.Errorf("authserver: redirect_uri does not match the registered client redirect URI")
}
