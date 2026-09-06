package server

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/kenotron-ms/muxterm/internal/authserver"
)

const (
	pkceCookieName = "muxterm_pkce"
	pkceCookieTTL  = 5 * time.Minute
)

type pkceState struct {
	State    string `json:"state"`
	Verifier string `json:"verifier"`
	ReturnTo string `json:"return_to"`
}

// handleAuthLogin initiates the muxterm-web OAuth 2.1 + PKCE login flow: it
// generates a fresh code_verifier/state pair, stashes them (plus the
// original return_to path) in a short-lived HttpOnly cookie, and redirects
// the browser to /authorize. See design doc Data Flow "Browser login".
func (s *Server) handleAuthLogin(w http.ResponseWriter, r *http.Request) {
	verifier, err := randomURLSafeString(64)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	state, err := randomURLSafeString(32)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	returnTo := safeReturnTo(r.URL.Query().Get("return_to"))

	ps := pkceState{State: state, Verifier: verifier, ReturnTo: returnTo}
	raw, err := json.Marshal(ps)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     pkceCookieName,
		Value:    base64.URLEncoding.EncodeToString(raw),
		Path:     "/auth/",
		HttpOnly: true,
		Secure:   s.secureCookies(),
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(pkceCookieTTL.Seconds()),
	})

	challenge := codeChallengeS256(verifier)
	q := url.Values{
		"response_type":         {"code"},
		"client_id":             {authserver.ClientWeb},
		"redirect_uri":          {s.webRedirectURI},
		"state":                 {state},
		"code_challenge":        {challenge},
		"code_challenge_method": {"S256"},
	}
	http.Redirect(w, r, "/authorize?"+q.Encode(), http.StatusFound)
}

// handleAuthCallback completes the flow: validates state against the PKCE
// cookie, exchanges the code for an access token in-process (same binary,
// same process — see design doc), sets the long-lived session cookie, and
// redirects back to the originally requested path.
func (s *Server) handleAuthCallback(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie(pkceCookieName)
	if err != nil {
		http.Error(w, "missing or expired login state; try again", http.StatusBadRequest)
		return
	}
	raw, err := base64.URLEncoding.DecodeString(cookie.Value)
	if err != nil {
		http.Error(w, "invalid login state", http.StatusBadRequest)
		return
	}
	var ps pkceState
	if err := json.Unmarshal(raw, &ps); err != nil {
		http.Error(w, "invalid login state", http.StatusBadRequest)
		return
	}
	// Consume the PKCE cookie immediately; it is single-use.
	http.SetCookie(w, &http.Cookie{Name: pkceCookieName, Value: "", Path: "/auth/", Secure: s.secureCookies(), MaxAge: -1})

	if r.URL.Query().Get("state") != ps.State {
		http.Error(w, "state mismatch", http.StatusBadRequest)
		return
	}
	if errParam := r.URL.Query().Get("error"); errParam != "" {
		http.Error(w, "login failed: "+errParam, http.StatusUnauthorized)
		return
	}
	code := r.URL.Query().Get("code")
	if code == "" {
		http.Error(w, "missing code", http.StatusBadRequest)
		return
	}

	accessToken, expiresIn, err := s.authSrv.ExchangeAuthorizationCode(authserver.ClientWeb, code, ps.Verifier, s.webRedirectURI)
	if err != nil {
		http.Error(w, "token exchange failed: "+err.Error(), http.StatusUnauthorized)
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookieName,
		Value:    accessToken,
		Path:     "/",
		HttpOnly: true,
		Secure:   s.secureCookies(),
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(expiresIn.Seconds()),
	})

	http.Redirect(w, r, ps.ReturnTo, http.StatusFound)
}

// handleAuthLogout revokes the current session's access token (checked as
// a bearer header first, then the session cookie) and, ONLY on successful
// revocation, expires the muxterm_session cookie client-side. If deletion
// fails, the cookie is left untouched and an error is returned — never
// report a token as revoked when the deletion did not actually succeed
// (see design doc Error Handling, "Logout failure"). If no token/cookie is
// present at all, this is a no-op success (204) — logging out when you're
// already logged out is not an error.
func (s *Server) handleAuthLogout(w http.ResponseWriter, r *http.Request) {
	token, ok := bearerToken(r)
	if !ok {
		if cookie, err := r.Cookie(SessionCookieName); err == nil {
			token = cookie.Value
		}
	}
	if token == "" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err := s.authSrv.RevokeAccessToken(r.Context(), token); err != nil {
		http.Error(w, "logout failed: "+err.Error(), http.StatusInternalServerError)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   s.secureCookies(),
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
	w.WriteHeader(http.StatusNoContent)
}

func codeChallengeS256(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func randomURLSafeString(nBytes int) (string, error) {
	b := make([]byte, nBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// secureCookies reports whether auth cookies should carry the Secure
// attribute. It is keyed off the configured public origin's scheme rather
// than set unconditionally: Secure cookies are dropped by browsers over
// plain http, which would break local development and any deployment that
// legitimately terminates at http on a trusted network.
func (s *Server) secureCookies() bool {
	s.cfgMu.RLock()
	sc := s.cfg.Server
	s.cfgMu.RUnlock()
	if !sc.BehindReverseProxy {
		return false
	}
	return strings.HasPrefix(strings.ToLower(sc.BaseURL()), "https://")
}

// safeReturnTo constrains a post-login redirect to a path inside muxterm.
//
// Anything that could be read by a browser as another origin resolves to
// "/". url.Parse alone is not sufficient: browsers following the WHATWG URL
// spec normalize a backslash to a forward slash at path-start, so "/\evil"
// is treated as "//evil" -- a protocol-relative URL to another host -- while
// url.Parse reports it as an ordinary relative path. Percent-encoded C0
// control characters and whitespace are likewise stripped before that
// normalization, so "/%09//evil" collapses to "//evil". Both are rejected
// here by decoding and scrubbing before the prefix checks.
func safeReturnTo(raw string) string {
	const fallback = "/"
	if raw == "" {
		return fallback
	}
	// Decode so encoded control characters cannot hide the shape of the
	// value from the checks below; ignore decode errors and fall through to
	// checking the raw form.
	decoded := raw
	if unescaped, err := url.PathUnescape(raw); err == nil {
		decoded = unescaped
	}
	// Browsers treat backslash as a path separator; normalize before
	// checking so "/\evil.com" cannot pass as a relative path.
	normalized := strings.ReplaceAll(decoded, "\\", "/")
	// Strip leading C0 controls, space, and DEL, which browsers ignore.
	normalized = strings.TrimLeft(normalized, "\x00\x01\x02\x03\x04\x05\x06\x07\x08\t\n\v\f\r\x0e\x0f\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f \x7f")
	if !strings.HasPrefix(normalized, "/") || strings.HasPrefix(normalized, "//") {
		return fallback
	}
	// Any remaining control character or whitespace anywhere in the value is
	// a header-splitting or normalization hazard; refuse rather than guess.
	if strings.ContainsFunc(normalized, func(r rune) bool { return r < 0x20 || r == 0x7f }) {
		return fallback
	}
	parsed, err := url.Parse(normalized)
	if err != nil || parsed.IsAbs() || parsed.Host != "" || parsed.Scheme != "" {
		return fallback
	}
	return normalized
}
