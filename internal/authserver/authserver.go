package authserver

import (
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"time"

	"github.com/go-oauth2/oauth2/v4"
	"github.com/go-oauth2/oauth2/v4/manage"
	oaserver "github.com/go-oauth2/oauth2/v4/server"

	"github.com/kenotron-ms/muxterm/internal/authserver/loginbackend"
)

// AccessTokenTTL is the deliberate, documented deviation from the MCP
// spec's SHOULD-level short-lived-token recommendation. See design doc,
// internal/authserver section, for the rationale (single-account personal
// tool; periodic re-login is cheap).
const AccessTokenTTL = 30 * 24 * time.Hour

// AuthorizeCodeTTL is the lifetime of the one-time authorization code (not
// the access token). 10 minutes is generous for a human completing a
// password form.
const AuthorizeCodeTTL = 10 * time.Minute

// Config configures a new AuthServer.
type Config struct {
	// WebRedirectURI is the exact-match redirect URI for the muxterm-web
	// client (e.g. "http://127.0.0.1:8311/auth/callback" in Phase 1's
	// direct/local-dev mode). Phase 3 will derive this from public_origin
	// when behind_reverse_proxy is set.
	WebRedirectURI string
	// LoginBackend performs the actual resource-owner credential check.
	// Required.
	LoginBackend loginbackend.LoginBackend
	// TokenStoreDir is the directory the file-backed token store persists
	// into (owner-only permissions — see tokenstore.go).
	TokenStoreDir string
	// RateLimiter gates repeated failed login attempts. Required.
	RateLimiter *RateLimiter
}

// AuthServer wraps go-oauth2/oauth2 with muxterm's hardening
// configuration, hardcoded clients, file-backed token store, and
// PAM-backed login form.
type AuthServer struct {
	manager *manage.Manager
	srv     *oaserver.Server
	login   loginbackend.LoginBackend
	limiter *RateLimiter
	tmpl    *template.Template
}

// New wires a Manager (PKCE S256-only, authorization-code-grant-only, no
// refresh tokens, 30-day access-token TTL) with the hardcoded ClientStore,
// the file-backed TokenStore, and the loopback-port-wildcard redirect URI
// exception bounded to muxterm-mcp.
func New(cfg Config) (*AuthServer, error) {
	if cfg.LoginBackend == nil {
		return nil, errors.New("authserver: LoginBackend is required")
	}
	if cfg.RateLimiter == nil {
		return nil, errors.New("authserver: RateLimiter is required")
	}

	manager := manage.NewDefaultManager()
	manager.SetAuthorizeCodeExp(AuthorizeCodeTTL)
	manager.SetAuthorizeCodeTokenCfg(&manage.Config{
		AccessTokenExp:    AccessTokenTTL,
		IsGenerateRefresh: false, // no refresh tokens, ever — see design doc
	})
	manager.SetValidateURIHandler(validateRedirectURI)

	tokenStore, err := NewFileTokenStore(cfg.TokenStoreDir)
	if err != nil {
		return nil, fmt.Errorf("authserver: token store: %w", err)
	}
	manager.MapTokenStorage(tokenStore)
	manager.MapClientStorage(NewClientStore(cfg.WebRedirectURI))

	srvCfg := &oaserver.Config{
		TokenType:                   "Bearer",
		AllowedResponseTypes:        []oauth2.ResponseType{oauth2.Code},
		AllowedGrantTypes:           []oauth2.GrantType{oauth2.AuthorizationCode},
		AllowedCodeChallengeMethods: []oauth2.CodeChallengeMethod{oauth2.CodeChallengeS256},
		ForcePKCE:                   true,
	}
	srv := oaserver.NewServer(srvCfg, manager)
	srv.SetClientInfoHandler(oaserver.ClientFormHandler)

	as := &AuthServer{
		manager: manager,
		srv:     srv,
		login:   cfg.LoginBackend,
		limiter: cfg.RateLimiter,
		tmpl:    template.Must(template.New("login").Parse(loginPageHTML)),
	}
	srv.SetUserAuthorizationHandler(as.userAuthorizationHandler)
	return as, nil
}

// Manager exposes the underlying oauth2 Manager so internal/server's auth
// middleware can validate bearer tokens/cookies via LoadAccessToken.
func (a *AuthServer) Manager() *manage.Manager { return a.manager }

// ServeAuthorize handles GET/POST /authorize.
func (a *AuthServer) ServeAuthorize(w http.ResponseWriter, r *http.Request) {
	if err := a.srv.HandleAuthorizeRequest(w, r); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
	}
}

// ServeToken handles POST /token.
func (a *AuthServer) ServeToken(w http.ResponseWriter, r *http.Request) {
	if err := a.srv.HandleTokenRequest(w, r); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
	}
}

// ExchangeAuthorizationCode performs the code-for-token exchange
// in-process (no network round trip — same binary, same process, per
// design doc Data Flow step 6).
func (a *AuthServer) ExchangeAuthorizationCode(clientID, code, verifier, redirectURI string) (accessToken string, expiresIn time.Duration, err error) {
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"client_id":     {clientID},
		"code":          {code},
		"redirect_uri":  {redirectURI},
		"code_verifier": {verifier},
	}
	req := httptest.NewRequest(http.MethodPost, "/token", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()

	if err := a.srv.HandleTokenRequest(rec, req); err != nil {
		return "", 0, err
	}
	if rec.Code != http.StatusOK {
		return "", 0, fmt.Errorf("authserver: token exchange failed: %s", rec.Body.String())
	}
	var body struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int64  `json:"expires_in"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		return "", 0, fmt.Errorf("authserver: decode token response: %w", err)
	}
	return body.AccessToken, time.Duration(body.ExpiresIn) * time.Second, nil
}

func (a *AuthServer) userAuthorizationHandler(w http.ResponseWriter, r *http.Request) (string, error) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return "", nil
	}

	if r.Method == http.MethodGet {
		a.renderLoginPage(w, r, "")
		return "", nil
	}

	ip := clientIP(r)
	if !a.limiter.Reserve(ip) {
		a.renderLoginPage(w, r, "Too many failed attempts. Try again later.")
		return "", nil
	}

	password := r.FormValue("password")
	if err := a.login.Authenticate(password); err != nil {
		// Reserve(ip) already recorded this attempt as a failure atomically
		// before we called Authenticate — no separate RecordFailure call.
		a.renderLoginPage(w, r, "Invalid credentials.")
		return "", nil
	}
	a.limiter.RecordSuccess(ip)

	// Single OS account -> identity is implicit; "local" is a fixed,
	// non-secret label, not a username lookup.
	return "local", nil
}

var hiddenFieldNames = []string{
	"response_type", "client_id", "redirect_uri", "state",
	"code_challenge", "code_challenge_method", "scope",
}

type loginPageData struct {
	Error  string
	Hidden map[string]string
}

func (a *AuthServer) renderLoginPage(w http.ResponseWriter, r *http.Request, errMsg string) {
	hidden := make(map[string]string, len(hiddenFieldNames))
	for _, name := range hiddenFieldNames {
		hidden[name] = r.FormValue(name)
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if errMsg != "" {
		w.WriteHeader(http.StatusUnauthorized)
	}
	_ = a.tmpl.Execute(w, loginPageData{Error: errMsg, Hidden: hidden})
}

const loginPageHTML = `<!DOCTYPE html>
<html><head><title>muxterm login</title></head>
<body>
<h1>muxterm</h1>
{{if .Error}}<p style="color:red">{{.Error}}</p>{{end}}
<form method="POST">
{{range $k, $v := .Hidden}}<input type="hidden" name="{{$k}}" value="{{$v}}">
{{end}}
<label>Password: <input type="password" name="password" autocomplete="current-password" autofocus></label>
<button type="submit">Log in</button>
</form>
</body></html>`

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
