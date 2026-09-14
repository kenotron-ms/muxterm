package server

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"

	"github.com/go-oauth2/oauth2/v4/manage"
	"github.com/kenotron-ms/muxterm/internal/authserver"
	"github.com/kenotron-ms/muxterm/internal/workspaceauth"
)

// SessionCookieName is the HttpOnly cookie holding the opaque access token
// for browser sessions (set by internal/server/authclient.go's callback
// handler).
const SessionCookieName = "muxterm_session"

// AuthMiddleware gates access to protected routes. A loopback IP is not an OS
// user identity, so normal browser requests require the existing login
// admission. --no-auth remains the explicit insecure development/test escape.
type AuthMiddleware struct {
	authSrv *authserver.AuthServer // nil => login backend unavailable; fail closed for browser callers
	noAuth  bool
	// behindReverseProxy is retained for constructor/config compatibility.
	// Authentication no longer changes based on a caller IP address.
	behindReverseProxy bool
	// localToken authenticates same-user helper processes on this machine
	// (today: the MCP server) that talk to the serve layer's HTTP API. It
	// is published only through a 0600 file inside the 0700 runtime dir,
	// so possession of it already implies the same UID that runs muxterm.
	//
	// It keeps the same-user helper channel separate from browser login.
	// Empty string disables the check entirely (never matches).
	localToken string
	authorizer workspaceauth.Authorizer
	admission  workspaceauth.Admission
}

// SetAuthorization installs the server-created owner admission and centralized
// evaluator. It is intentionally code-only: no request data is ever parsed as
// a principal or admission.
func (m *AuthMiddleware) SetAuthorization(authorizer workspaceauth.Authorizer, admission workspaceauth.Admission) {
	m.authorizer = authorizer
	m.admission = admission
}

// NewAuthMiddleware returns a middleware wired to authSrv, which may be
// nil if the platform login backend is unavailable at startup (see
// cmd/muxterm's newAuthServer) — browser requests then fail closed.
// noAuth mirrors the existing explicitly insecure development/test escape.
// behindReverseProxy is retained for constructor compatibility.
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
	owner, err := workspaceauth.NewEphemeralOwner()
	if err != nil {
		panic("server: authorization initialization failed")
	}
	authorizer, err := workspaceauth.NewOwnerOnlyAuthorizer(owner)
	if err != nil {
		panic("server: authorization initialization failed")
	}
	admission, err := workspaceauth.NewLocalOwnerAdmission(owner.Principal)
	if err != nil {
		panic("server: authorization initialization failed")
	}
	return &AuthMiddleware{
		authSrv:            authSrv,
		noAuth:             noAuth,
		behindReverseProxy: behindReverseProxy,
		localToken:         localToken,
		authorizer:         authorizer,
		admission:          admission,
	}
}

// Wrap returns next wrapped with the auth check.
func (m *AuthMiddleware) Wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if m.noAuth {
			m.admit(w, r, next, m.admission)
			return
		}
		// Same-user local helper processes (MCP). Checked BEFORE the
		// authSrv==nil fail-closed gate on purpose: these callers hold a
		// credential that never depended on the login backend.
		if token, ok := bearerToken(r); ok && m.matchesLocalToken(token) {
			m.admit(w, r, next, m.admission)
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
				m.admit(w, r, next, m.tokenAdmission(mgr, token))
				return
			}
		}

		if cookie, err := r.Cookie(SessionCookieName); err == nil && cookie.Value != "" {
			if _, err := mgr.LoadAccessToken(r.Context(), cookie.Value); err == nil {
				m.admit(w, r, next, m.tokenAdmission(mgr, cookie.Value))
				return
			}
		}

		m.deny(w, r)
	})
}

// admit attaches the internal current-owner subject only after existing
// admission succeeds, then authorizes all protected HTTP work before a handler
// sees the request.
func (m *AuthMiddleware) admit(w http.ResponseWriter, r *http.Request, next http.Handler, admission workspaceauth.Admission) {
	if !admission.Valid() || m.authorizer == nil {
		httpJSONError(w, http.StatusForbidden, "authorization_denied", "authorization denied")
		return
	}
	if m.authorizer != nil {
		if err := m.authorizer.Authorize(admission.Principal, workspaceauth.ActionAccess, workspaceauth.Resource{Kind: workspaceauth.ResourceInstance}); err != nil {
			httpJSONError(w, http.StatusForbidden, "authorization_denied", "authorization denied")
			return
		}
		r = r.WithContext(workspaceauth.WithAdmission(r.Context(), admission))
	}
	next.ServeHTTP(w, r)
}

// tokenAdmission captures the token only inside a renewal closure. Every later
// workspace authorization rechecks the existing OAuth manager, so expiry or
// revocation invalidates an already-upgraded WebSocket without exposing the
// token on any wire, log, or error.
func (m *AuthMiddleware) tokenAdmission(mgr *manage.Manager, token string) workspaceauth.Admission {
	admission, err := workspaceauth.NewAdmission(m.admission.Principal, func() bool {
		if !m.admission.Valid() {
			return false
		}
		_, err := mgr.LoadAccessToken(context.Background(), token)
		return err == nil
	})
	if err != nil {
		return workspaceauth.Admission{}
	}
	return admission
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
