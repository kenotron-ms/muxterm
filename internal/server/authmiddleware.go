package server

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/kenotron-ms/muxterm/internal/authserver"
)

// SessionCookieName is the HttpOnly cookie holding the opaque access token
// for browser sessions (set by internal/server/authclient.go's callback
// handler).
const SessionCookieName = "muxterm_session"

// AuthMiddleware gates access to protected routes. The loopback bypass
// applies only in direct/local-dev mode; when muxterm runs behind a reverse
// proxy the bypass is disabled entirely (see behindReverseProxy below).
// Otherwise a valid session cookie (browser) or Authorization: Bearer token
// (all other callers) is required, validated against the AuthServer's token
// store.
type AuthMiddleware struct {
	authSrv *authserver.AuthServer // nil => login backend unavailable; fail closed for non-loopback callers
	noAuth  bool
	// behindReverseProxy disables the IsLocalhost() bypass unconditionally.
	// A fronting proxy's own hop to muxterm is indistinguishable from a
	// genuinely local caller at the RemoteAddr level — and in the real
	// production topology it is not even loopback — so honoring the bypass
	// here would silently grant unauthenticated access to genuinely remote
	// traffic, defeating the entire point of running behind the proxy. This
	// is a static, config-gated switch: never auto-detected, never derived
	// from a forwarded header.
	behindReverseProxy bool
}

// NewAuthMiddleware returns a middleware wired to authSrv, which may be
// nil if the platform login backend is unavailable at startup (see
// cmd/muxterm's newAuthServer) — in that case every non-loopback request
// is denied (fail closed), per the design doc's Error Handling section.
// noAuth mirrors the existing --no-auth dev-only flag: when set, ALL
// checks (including loopback and the fail-closed case) are skipped.
// behindReverseProxy disables the loopback bypass entirely.
func NewAuthMiddleware(authSrv *authserver.AuthServer, noAuth, behindReverseProxy bool) *AuthMiddleware {
	return &AuthMiddleware{authSrv: authSrv, noAuth: noAuth, behindReverseProxy: behindReverseProxy}
}

// Wrap returns next wrapped with the auth check.
func (m *AuthMiddleware) Wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if m.noAuth {
			next.ServeHTTP(w, r)
			return
		}
		// Loopback bypass — direct/local-dev mode only. Behind a reverse
		// proxy every request must complete the real OAuth flow regardless
		// of which interface it arrived on.
		if !m.behindReverseProxy && IsLocalhost(r) {
			next.ServeHTTP(w, r)
			return
		}

		if m.authSrv == nil {
			// Login backend unavailable at startup: fail closed. See
			// design doc Error Handling — "Login backend unavailable ...
			// must fail closed."
			m.deny(w, r)
			return
		}

		mgr := m.authSrv.Manager()

		if token, ok := bearerToken(r); ok {
			if _, err := mgr.LoadAccessToken(r.Context(), token); err == nil {
				next.ServeHTTP(w, r)
				return
			}
		}

		if cookie, err := r.Cookie(SessionCookieName); err == nil && cookie.Value != "" {
			if _, err := mgr.LoadAccessToken(r.Context(), cookie.Value); err == nil {
				next.ServeHTTP(w, r)
				return
			}
		}

		m.deny(w, r)
	})
}

func (m *AuthMiddleware) deny(w http.ResponseWriter, r *http.Request) {
	if strings.Contains(r.Header.Get("Accept"), "text/html") {
		http.Redirect(w, r, "/auth/login?return_to="+url.QueryEscape(r.URL.RequestURI()), http.StatusFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnauthorized)
	w.Write([]byte(`{"error":"invalid_token"}`)) //nolint:errcheck
}

func bearerToken(r *http.Request) (string, bool) {
	const prefix = "Bearer "
	h := r.Header.Get("Authorization")
	if strings.HasPrefix(h, prefix) {
		return strings.TrimPrefix(h, prefix), true
	}
	return "", false
}
