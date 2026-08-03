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

// AuthMiddleware gates access to protected routes. Loopback bypass is
// unchanged from the pre-existing IsLocalhost()-based behavior; otherwise
// a valid session cookie (browser) or Authorization: Bearer token (all
// other callers) is required, validated against the AuthServer's token
// store.
type AuthMiddleware struct {
	authSrv *authserver.AuthServer // nil => login backend unavailable; fail closed for non-loopback callers
	noAuth  bool
}

// NewAuthMiddleware returns a middleware wired to authSrv, which may be
// nil if the platform login backend is unavailable at startup (see
// cmd/muxterm's newAuthServer) — in that case every non-loopback request
// is denied (fail closed), per the design doc's Error Handling section.
// noAuth mirrors the existing --no-auth dev-only flag: when set, ALL
// checks (including loopback and the fail-closed case) are skipped.
func NewAuthMiddleware(authSrv *authserver.AuthServer, noAuth bool) *AuthMiddleware {
	return &AuthMiddleware{authSrv: authSrv, noAuth: noAuth}
}

// Wrap returns next wrapped with the auth check.
func (m *AuthMiddleware) Wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if m.noAuth || IsLocalhost(r) {
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
