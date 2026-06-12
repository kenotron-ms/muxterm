package proxy

import (
	"compress/gzip"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"

	"github.com/coder/websocket"
)

// ─── test helpers ─────────────────────────────────────────────────────────────

// proxyFor spins up an httptest.Server that mounts /p/ via NewHandler and
// /sw.js via ServeServiceWorker. targetAddr is the address of the upstream
// target (used to derive the proxy's base host).
func proxyFor(t *testing.T, targetAddr string) *httptest.Server {
	t.Helper()
	u, err := url.Parse(targetAddr)
	if err != nil {
		t.Fatalf("proxyFor: parse %q: %v", targetAddr, err)
	}
	host := u.Hostname()
	mux := http.NewServeMux()
	mux.Handle("/p/", NewHandler(host, nil))
	mux.HandleFunc("/sw.js", ServeServiceWorker)
	return httptest.NewServer(mux)
}

// portOf returns the port component of rawURL.
func portOf(t *testing.T, rawURL string) string {
	t.Helper()
	u, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("portOf: parse %q: %v", rawURL, err)
	}
	_, port, err := net.SplitHostPort(u.Host)
	if err != nil {
		t.Fatalf("portOf: split %q: %v", u.Host, err)
	}
	return port
}

// proxyURL builds the URL for accessing targetPort/path through the proxy.
func proxyURL(proxy, targetPort, path string) string {
	return proxy + "/p/" + targetPort + path
}

// noRedirectClient is an HTTP client that does not follow redirects, returning
// the last response as-is so tests can inspect Location headers directly.
var noRedirectClient = &http.Client{
	CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

// cookieRecorder is a minimal http.CookieJar that captures all cookies set
// during a test so they can be inspected afterwards.
type cookieRecorder struct {
	cookies []*http.Cookie
}

func (cr *cookieRecorder) SetCookies(_ *url.URL, cookies []*http.Cookie) {
	cr.cookies = append(cr.cookies, cookies...)
}

func (cr *cookieRecorder) Cookies(_ *url.URL) []*http.Cookie {
	return cr.cookies
}

// byName returns the last cookie with the given name, or nil.
func (cr *cookieRecorder) byName(name string) *http.Cookie {
	for i := len(cr.cookies) - 1; i >= 0; i-- {
		if cr.cookies[i].Name == name {
			return cr.cookies[i]
		}
	}
	return nil
}

// min returns the smaller of a and b.
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// ─── WORKS: happy-path tests ──────────────────────────────────────────────────

// TestWorks_HTTPProxyForwardsRequest verifies that the proxy forwards a plain
// HTTP GET to the upstream target and returns 200 with the target's body.
func TestWorks_HTTPProxyForwardsRequest(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, "hello from target") //nolint:errcheck
	}))
	defer target.Close()

	proxy := proxyFor(t, target.URL)
	defer proxy.Close()

	port := portOf(t, target.URL)
	resp, err := http.Get(proxyURL(proxy.URL, port, "/"))
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want %d", resp.StatusCode, http.StatusOK)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "target") {
		t.Errorf("body = %q, want it to contain 'target'", body)
	}
}

// TestWorks_ShimInjectedFirstInHead verifies that 'muxterm proxy shim' appears
// in the proxied HTML before the <title> element.
func TestWorks_ShimInjectedFirstInHead(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		io.WriteString(w, "<html><head><title>My App</title></head><body></body></html>") //nolint:errcheck
	}))
	defer target.Close()

	proxy := proxyFor(t, target.URL)
	defer proxy.Close()

	port := portOf(t, target.URL)
	resp, err := http.Get(proxyURL(proxy.URL, port, "/"))
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	s := string(body)

	shimIdx := strings.Index(s, "muxterm proxy shim")
	titleIdx := strings.Index(s, "<title>")
	if shimIdx == -1 {
		t.Error("body does not contain 'muxterm proxy shim'")
	}
	if titleIdx == -1 {
		t.Error("body does not contain '<title>'")
	}
	if shimIdx != -1 && titleIdx != -1 && shimIdx > titleIdx {
		t.Errorf("shim (pos %d) must appear before <title> (pos %d)", shimIdx, titleIdx)
	}
}

// TestWorks_WebSocketProxy_BidirectionalMessages dials a WebSocket through the
// proxy, sends "ping", and expects the target to echo back "echo:ping".
func TestWorks_WebSocketProxy_BidirectionalMessages(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "")
		ctx := r.Context()
		_, msg, err := conn.Read(ctx)
		if err != nil {
			return
		}
		conn.Write(ctx, websocket.MessageText, append([]byte("echo:"), msg...)) //nolint:errcheck
	}))
	defer target.Close()

	proxy := proxyFor(t, target.URL)
	defer proxy.Close()

	port := portOf(t, target.URL)
	wsURL := "ws" + strings.TrimPrefix(proxy.URL, "http") + "/p/" + port + "/"

	conn, _, err := websocket.Dial(context.Background(), wsURL, nil)
	if err != nil {
		t.Fatalf("WS dial: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	ctx := context.Background()
	if err := conn.Write(ctx, websocket.MessageText, []byte("ping")); err != nil {
		t.Fatalf("WS write: %v", err)
	}
	_, got, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("WS read: %v", err)
	}
	if string(got) != "echo:ping" {
		t.Errorf("WS response = %q, want %q", got, "echo:ping")
	}
}

// TestWorks_ServiceWorkerServedWithCorrectHeaders verifies that /sw.js returns
// 200, a JavaScript Content-Type, Service-Worker-Allowed: /, and a body that
// contains both "skipWaiting" and "clients.claim".
func TestWorks_ServiceWorkerServedWithCorrectHeaders(t *testing.T) {
	proxy := proxyFor(t, "http://localhost:0")
	defer proxy.Close()

	resp, err := http.Get(proxy.URL + "/sw.js")
	if err != nil {
		t.Fatalf("GET /sw.js: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want %d", resp.StatusCode, http.StatusOK)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "javascript") {
		t.Errorf("Content-Type = %q, want it to contain 'javascript'", ct)
	}
	if swa := resp.Header.Get("Service-Worker-Allowed"); swa != "/" {
		t.Errorf("Service-Worker-Allowed = %q, want '/'", swa)
	}
	body, _ := io.ReadAll(resp.Body)
	s := string(body)
	if !strings.Contains(s, "skipWaiting") {
		t.Error("sw.js body should contain 'skipWaiting'")
	}
	if !strings.Contains(s, "clients.claim") {
		t.Error("sw.js body should contain 'clients.claim'")
	}
}

// ─── FIX: previously broken behavior ─────────────────────────────────────────

// TestFix_GzipNotCorruptedByShimInjection verifies that the proxy transparently
// decompresses gzip-encoded target responses before injecting the shim, and
// does NOT forward a Content-Encoding header to the client.
func TestFix_GzipNotCorruptedByShimInjection(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Header().Set("Content-Encoding", "gzip")
		gz := gzip.NewWriter(w)
		defer gz.Close()
		io.WriteString(gz, "<html><head><title>Gzipped</title></head><body>original content</body></html>") //nolint:errcheck
	}))
	defer target.Close()

	proxy := proxyFor(t, target.URL)
	defer proxy.Close()

	port := portOf(t, target.URL)

	// DisableCompression prevents the Go HTTP client from auto-decompressing,
	// so we observe the raw response headers from the proxy.
	client := &http.Client{Transport: &http.Transport{DisableCompression: true}}
	resp, err := client.Get(proxyURL(proxy.URL, port, "/"))
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()

	if ce := resp.Header.Get("Content-Encoding"); ce != "" {
		t.Errorf("Content-Encoding = %q, proxy should strip gzip encoding after decompressing", ce)
	}
	body, _ := io.ReadAll(resp.Body)
	s := string(body)
	if !strings.Contains(s, "muxterm proxy shim") {
		t.Error("body should contain shim after proxy decompresses gzip")
	}
	if !strings.Contains(s, "original content") {
		t.Error("body should contain original content after decompression")
	}
}

// TestFix_RedirectLocationRewrittenToProxyPath verifies that when the upstream
// target redirects to an absolute localhost URL, the proxy rewrites the
// Location header to the /p/{port}/path form instead of forwarding the absolute
// URL verbatim.
func TestFix_RedirectLocationRewrittenToProxyPath(t *testing.T) {
	var targetPort string
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://localhost:"+targetPort+"/dashboard", http.StatusFound)
	}))
	defer target.Close()
	targetPort = portOf(t, target.URL) // set before any request is made

	proxy := proxyFor(t, target.URL)
	defer proxy.Close()

	resp, err := noRedirectClient.Get(proxyURL(proxy.URL, targetPort, "/"))
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusFound {
		t.Fatalf("status = %d, want %d (redirect)", resp.StatusCode, http.StatusFound)
	}
	loc := resp.Header.Get("Location")
	want := "/p/" + targetPort + "/dashboard"
	if loc != want {
		t.Errorf("Location = %q, want %q", loc, want)
	}
	if strings.HasPrefix(loc, "http://localhost") {
		t.Errorf("Location must not be an absolute localhost URL, got %q", loc)
	}
}

// TestFix_XHRCoveredByShim verifies that shimScript patches XMLHttpRequest so
// that XHR calls made by proxied pages are correctly routed, and that the shim
// appears in proxied HTML responses.
func TestFix_XHRCoveredByShim(t *testing.T) {
	if !strings.Contains(shimScript, "XMLHttpRequest") {
		t.Error("shimScript should contain 'XMLHttpRequest'")
	}
	if !strings.Contains(shimScript, "XMLHttpRequest.prototype.open") {
		t.Error("shimScript should contain 'XMLHttpRequest.prototype.open'")
	}

	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		io.WriteString(w, "<html><head><title>XHR Test</title></head><body></body></html>") //nolint:errcheck
	}))
	defer target.Close()

	proxy := proxyFor(t, target.URL)
	defer proxy.Close()

	port := portOf(t, target.URL)
	resp, err := http.Get(proxyURL(proxy.URL, port, "/"))
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "muxterm proxy shim") {
		t.Error("proxied HTML body should contain shim")
	}
}

// TestFix_WebSocketSubprotocolForwarded verifies that when a client dials a
// WebSocket with a subprotocol, the proxy forwards the Sec-Websocket-Protocol
// header to the target.
func TestFix_WebSocketSubprotocolForwarded(t *testing.T) {
	var gotProtocol string
	done := make(chan struct{})

	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotProtocol = r.Header.Get("Sec-Websocket-Protocol")
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			Subprotocols: []string{"chat"},
		})
		if err != nil {
			close(done)
			return
		}
		conn.Close(websocket.StatusNormalClosure, "") //nolint:errcheck
		close(done)
	}))
	defer target.Close()

	proxy := proxyFor(t, target.URL)
	defer proxy.Close()

	port := portOf(t, target.URL)
	wsURL := "ws" + strings.TrimPrefix(proxy.URL, "http") + "/p/" + port + "/"

	conn, _, err := websocket.Dial(context.Background(), wsURL, &websocket.DialOptions{
		Subprotocols: []string{"chat"},
	})
	if err != nil {
		t.Logf("WS dial: %v (proxy may not yet forward subprotocols)", err)
	} else {
		conn.Close(websocket.StatusNormalClosure, "") //nolint:errcheck
	}

	<-done

	if !strings.Contains(gotProtocol, "chat") {
		t.Errorf("target received Sec-Websocket-Protocol = %q, want to contain 'chat'", gotProtocol)
	}
}

// ─── SW: service-worker interception tests ────────────────────────────────────

// TestSW_ScriptLogicIsCorrect is table-driven: it verifies that swScript
// contains the expected routing logic fragments and does NOT contain "WebSocket".
func TestSW_ScriptLogicIsCorrect(t *testing.T) {
	cases := []struct {
		name     string
		contains bool
		fragment string
	}{
		{"has skipWaiting()", true, "skipWaiting()"},
		{"has clients.claim()", true, "clients.claim()"},
		{"hostname check excludes localhost", true, "url.hostname !== 'localhost'"},
		{"handles 127.0.0.1", true, "127.0.0.1"},
		{"builds proxy path prefix", true, "'/p/' + port"},
		{"includes url.pathname", true, "url.pathname"},
		{"includes url.search", true, "url.search"},
		{"does not intercept WebSocket", false, "WebSocket"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			has := strings.Contains(swScript, tc.fragment)
			if tc.contains && !has {
				t.Errorf("swScript should contain %q", tc.fragment)
			}
			if !tc.contains && has {
				t.Errorf("swScript should NOT contain %q", tc.fragment)
			}
		})
	}
}

// TestSW_ProxyHandlesSwControlledRequests verifies that a request to
// /p/{port}/api/data reaches the target with path /api/data.
func TestSW_ProxyHandlesSwControlledRequests(t *testing.T) {
	var gotPath string
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"data":"ok"}`) //nolint:errcheck
	}))
	defer target.Close()

	proxy := proxyFor(t, target.URL)
	defer proxy.Close()

	port := portOf(t, target.URL)
	resp, err := http.Get(proxyURL(proxy.URL, port, "/api/data"))
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()

	if gotPath != "/api/data" {
		t.Errorf("target received path %q, want %q", gotPath, "/api/data")
	}
}

// ─── SHARP EDGES: documented limitations ─────────────────────────────────────

// TestSharpEdge_SPARefreshLosesPortContext documents that a GET to /dashboard
// (without the /p/{port}/ prefix) returns 404 — the proxy has no way to infer
// which port to route to, so SPA deep-link refreshes are broken by design.
func TestSharpEdge_SPARefreshLosesPortContext(t *testing.T) {
	proxy := proxyFor(t, "http://localhost:0")
	defer proxy.Close()

	resp, err := http.Get(proxy.URL + "/dashboard")
	if err != nil {
		t.Fatalf("GET /dashboard: %v", err)
	}
	defer resp.Body.Close()

	t.Logf("LIMITATION: SPA refresh to /dashboard without /p/{port}/ prefix returns %d — port context is lost", resp.StatusCode)
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d, want %d (no route exists without /p/ prefix)", resp.StatusCode, http.StatusNotFound)
	}
}

// TestSharpEdge_CookiesNotIsolatedPerPort documents that cookies set by two
// different proxied services (at different ports) are NOT isolated from each
// other — they both belong to the proxy's origin, so the cookie jar is shared.
func TestSharpEdge_CookiesNotIsolatedPerPort(t *testing.T) {
	makeTarget := func(cookieValue string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.SetCookie(w, &http.Cookie{Name: "session", Value: cookieValue})
			io.WriteString(w, "ok") //nolint:errcheck
		}))
	}

	target1 := makeTarget("session-a")
	defer target1.Close()
	target2 := makeTarget("session-b")
	defer target2.Close()

	proxy := proxyFor(t, target1.URL)
	defer proxy.Close()

	jar := &cookieRecorder{}
	client := &http.Client{Jar: jar}

	port1 := portOf(t, target1.URL)
	port2 := portOf(t, target2.URL)

	resp1, err := client.Get(proxyURL(proxy.URL, port1, "/"))
	if err != nil {
		t.Fatalf("GET target1: %v", err)
	}
	resp1.Body.Close()

	resp2, err := client.Get(proxyURL(proxy.URL, port2, "/"))
	if err != nil {
		t.Fatalf("GET target2: %v", err)
	}
	resp2.Body.Close()

	shown := min(len(jar.cookies), 2)
	t.Logf("LIMITATION: cookies not isolated per port — %d cookie(s) recorded (showing up to %d); both ports share the proxy origin",
		len(jar.cookies), shown)
	if c := jar.byName("session"); c != nil {
		t.Logf("  'session' cookie = %q (last written wins; collision documented)", c.Value)
	}
}

// ─── NEW: proxy headers injection ─────────────────────────────────────────────

// TestWorks_ProxyHeadersInjectedIntoProxiedRequest verifies that when a
// HeadersFunc is supplied to NewHandler, the headers it returns are injected
// into every proxied request for the matching port.
func TestWorks_ProxyHeadersInjectedIntoProxiedRequest(t *testing.T) {
	var gotAuth string
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		io.WriteString(w, "ok") //nolint:errcheck
	}))
	defer target.Close()

	targetPort := portOf(t, target.URL)
	portNum, err := strconv.Atoi(targetPort)
	if err != nil {
		t.Fatalf("parse port %q: %v", targetPort, err)
	}

	mux := http.NewServeMux()
	mux.Handle("/p/", NewHandler(target.URL, HeadersFunc(func(p int) map[string]string {
		if p == portNum {
			return map[string]string{"Authorization": "Bearer tok123"}
		}
		return nil
	})))
	proxy := httptest.NewServer(mux)
	defer proxy.Close()

	resp, err := http.Get(proxyURL(proxy.URL, targetPort, "/"))
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()

	if gotAuth != "Bearer tok123" {
		t.Errorf("Authorization = %q, want %q", gotAuth, "Bearer tok123")
	}
}

// TestInjectShimContainsInteractionCommands verifies that the bridge IIFE
// contains all DOM interaction command implementations referenced by handleAction.
func TestInjectShimContainsInteractionCommands(t *testing.T) {
	result := string(injectShim([]byte("<html><head></head><body></body></html>")))
	for _, want := range []string{
		"function click(",
		"function fill(",
		"function type_(",
		"function press(",
		"function hover(",
		"function select_(",
		"function eval_(",
	} {
		if !strings.Contains(result, want) {
			t.Errorf("injectShim result does not contain %q", want)
		}
	}
}

// TestInjectShimContainsNavigationCommands verifies that the bridge IIFE
// contains goBack, goForward, and reload function implementations.
// reload must use location.replace(href) instead of location.reload()
// because the shim runs inside the frame.
func TestInjectShimContainsNavigationCommands(t *testing.T) {
	result := string(injectShim([]byte("<html><head></head><body></body></html>")))
	for _, want := range []string{
		"function goBack(",
		"function goForward(",
		"location.replace(",
	} {
		if !strings.Contains(result, want) {
			t.Errorf("injectShim result does not contain %q", want)
		}
	}
}

// TestInjectShimContainsAgentBridge verifies that the bridge IIFE appended to
// shimScript contains all required identifiers so that a parent frame can
// communicate with the proxied page via postMessage.
func TestInjectShimContainsAgentBridge(t *testing.T) {
	result := string(injectShim([]byte("<html><head></head><body></body></html>")))
	for _, want := range []string{
		"mux-shim-ready",
		"handleAction",
		"mux-page-navigated",
		"function snapshot()",
		"function resolveTarget(",
	} {
		if !strings.Contains(result, want) {
			t.Errorf("injectShim result does not contain %q", want)
		}
	}
}

// TestShimActionStringsMatchSpec verifies that handleAction uses the spec-defined
// public action strings ('type', 'select', 'eval', 'go-back', 'go-forward')
// rather than leaking internal JS function names (type_, select_, goBack…).
func TestShimActionStringsMatchSpec(t *testing.T) {
	result := string(injectShim([]byte("<html><head></head><body></body></html>")))
	for _, want := range []string{
		"case 'type':",
		"case 'select':",
		"case 'eval':",
		"case 'go-back':",
		"case 'go-forward':",
	} {
		if !strings.Contains(result, want) {
			t.Errorf("handleAction switch missing spec-compliant case string %q", want)
		}
	}
	for _, leaked := range []string{
		"case 'type_':",
		"case 'select_':",
		"case 'eval_':",
		"case 'goBack':",
		"case 'goForward':",
	} {
		if strings.Contains(result, leaked) {
			t.Errorf("handleAction switch leaks internal JS name as public API string: %q", leaked)
		}
	}
}

// TestShimFillSupportsTextarea verifies that fill() and type_() fall back to the
// HTMLTextAreaElement native setter so they don't crash on <textarea> elements.
func TestShimFillSupportsTextarea(t *testing.T) {
	result := string(injectShim([]byte("<html><head></head><body></body></html>")))
	if !strings.Contains(result, "HTMLTextAreaElement") {
		t.Error("fill()/type_() missing HTMLTextAreaElement fallback — crashes on <textarea> elements")
	}
}

// TestAgentSWScriptHasNoLeakyNavigationsArray verifies that the /p/sw.js service
// worker does not maintain an unbounded array of navigation URLs, which would
// leak memory indefinitely in long-running browser sessions.
func TestAgentSWScriptHasNoLeakyNavigationsArray(t *testing.T) {
	rr := httptest.NewRecorder()
	ServeAgentServiceWorker(rr, httptest.NewRequest("GET", "/p/sw.js", nil))
	body := rr.Body.String()
	if strings.Contains(body, "const navigations") {
		t.Error("pSwScript contains unbounded navigations[] array — memory leak in long-running SWs; remove it")
	}
}
