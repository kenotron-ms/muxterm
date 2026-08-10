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

	returnTo := r.URL.Query().Get("return_to")
	if returnTo == "" {
		returnTo = "/"
	} else if parsed, err := url.Parse(returnTo); err != nil || !strings.HasPrefix(returnTo, "/") || strings.HasPrefix(returnTo, "//") || parsed.IsAbs() || parsed.Host != "" {
		// Only redirect within muxterm after authentication. AuthMiddleware
		// always supplies a relative request URI, but /auth/login is public
		// and callers can invoke it directly.
		returnTo = "/"
	}

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
	http.SetCookie(w, &http.Cookie{Name: pkceCookieName, Value: "", Path: "/auth/", MaxAge: -1})

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
