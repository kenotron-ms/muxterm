package server

import (
	"crypto/subtle"
	"encoding/json"
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
	// localToken authenticates same-user helper processes on this machine
	// (today: the MCP server) that talk to the serve layer's HTTP API. It
	// is published only through a 0600 file inside the 0700 runtime dir,
	// so possession of it already implies the same UID that runs muxterm.
	//
	// It exists because those callers had NO credential at all: they were
	// admitted solely by the IsLocalhost() bypass above, which
	// behind_reverse_proxy disables -- so enabling reverse-proxy mode used
	// to 401 every tunnel and config tool with no indication why. Empty
	// string disables the check entirely (never matches).
	localToken string
}

// NewAuthMiddleware returns a middleware wired to authSrv, which may be
// nil if the platform login backend is unavailable at startup (see
// cmd/muxterm's newAuthServer) — in that case every non-loopback request
// is denied (fail closed), per the design doc's Error Handling section.
// noAuth mirrors the existing --no-auth dev-only flag: when set, ALL
// checks (including loopback and the fail-closed case) are skipped.
// behindReverseProxy disables the loopback bypass entirely.
// localToken is the same-user helper-process credential; pass "" to disable.
//
// Deliberately NOT parameterized by the configured public host. An earlier
// revision compared r.Host against it to pre-empt a login that could not
// complete, and that was wrong: nginx's documented default is
// `proxy_set_header Host $proxy_host` and Apache's ProxyPreserveHost
// defaults to Off, so on both the Host muxterm sees is the upstream
// loopback address, never the public one. The guard would have rejected
// every request on the majority of proxy configurations. An explicit
// default port and an IDN domain each break the comparison too.
//
// The underlying problem -- a login begun on one origin cannot finish on
// another -- is now explained where it actually surfaces, in
// handleAuthCallback, which needs no header trust to detect it.
func NewAuthMiddleware(authSrv *authserver.AuthServer, noAuth, behindReverseProxy bool, localToken string) *AuthMiddleware {
	return &AuthMiddleware{
		authSrv:            authSrv,
		noAuth:             noAuth,
		behindReverseProxy: behindReverseProxy,
		localToken:         localToken,
	}
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

		// Same-user local helper processes (MCP). Checked BEFORE the
		// authSrv==nil fail-closed gate on purpose: these callers hold a
		// credential that never depended on the login backend, so a PAM
		// outage must not take muxterm's own tooling down with it.
		if token, ok := bearerToken(r); ok && m.matchesLocalToken(token) {
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
	wantsHTML := strings.Contains(r.Header.Get("Accept"), "text/html")

	// The login backend is unavailable, so /auth/login is not even mounted
	// (see Server.registerRoutes). Redirecting there would send every
	// browser -- including one at the console -- into a 302 that answers
	// 404, with nothing anywhere saying why. Explain instead.
	if m.authSrv == nil {
		const msg = "muxterm cannot authenticate anyone right now: the login backend was " +
			"unavailable when the server started, so every request is denied.\n\n" +
			"Check the server log for the \"login backend unavailable\" line, fix the cause, " +
			"and restart muxterm."
		if wantsHTML {
			httpPlainText(w, http.StatusServiceUnavailable, msg)
			return
		}
		httpJSONError(w, http.StatusServiceUnavailable, "login_backend_unavailable", msg)
		return
	}

	if wantsHTML {
		// Rooted, and honestly so. An earlier revision emitted a relative
		// "../auth/login" here believing it would survive an outer path
		// prefix. It does not: http.Redirect resolves a relative URL
		// against the request path and path.Clean's the result BEFORE
		// writing Location, so the header is byte-identical to this line
		// in every case. Serving muxterm under a path prefix would require
		// writing Location by hand (as handleTunnelProxy does for its
		// trailing-slash redirect) plus a server-side notion of the mount
		// point -- deliberately out of scope here.
		http.Redirect(w, r, "/auth/login?return_to="+url.QueryEscape(r.URL.RequestURI()), http.StatusFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnauthorized)
	w.Write([]byte(`{"error":"invalid_token"}`)) //nolint:errcheck
}

// httpPlainText writes a bare text/plain body. Deliberately not HTML: this
// path runs when auth is broken or misconfigured, and a plain body cannot
// reflect any request-controlled value into markup.
func httpPlainText(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(code)
	w.Write([]byte("muxterm\n\n" + msg + "\n")) //nolint:errcheck
}

func httpJSONError(w http.ResponseWriter, code int, errCode, desc string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{ //nolint:errcheck
		"error":             errCode,
		"error_description": desc,
	})
}

// matchesLocalToken reports whether tok is the configured same-user helper
// token. Constant-time to keep the comparison from leaking the token a byte
// at a time; an empty configured token never matches anything.
func (m *AuthMiddleware) matchesLocalToken(tok string) bool {
	if m.localToken == "" || tok == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(tok), []byte(m.localToken)) == 1
}

func bearerToken(r *http.Request) (string, bool) {
	const prefix = "Bearer "
	h := r.Header.Get("Authorization")
	if strings.HasPrefix(h, prefix) {
		return strings.TrimPrefix(h, prefix), true
	}
	return "", false
}
