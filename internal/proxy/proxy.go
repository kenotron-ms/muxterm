package proxy

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/coder/websocket"
)

// shimScript is injected into every proxied HTML page, right after <head>.
// Overrides window.fetch, window.XMLHttpRequest, and window.WebSocket to
// rewrite absolute localhost URLs through the proxy path (/p/{port}/...).
//
// This covers the first page load BEFORE the service worker is active.
// The SW handles subsequent loads as belt-and-suspenders.
const shimScript = `<script>
/* muxterm proxy shim (auto-injected) */
(function() {
  'use strict';

  function rewriteHTTP(u) {
    if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return null;
    return location.protocol + '//' + location.host + '/p/' + (u.port||'80') + u.pathname + u.search;
  }

  function rewriteWS(u) {
    if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return null;
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host + '/p/' + (u.port||'80') + u.pathname + u.search;
  }

  /* fetch */
  var _fetch = window.fetch;
  window.fetch = function(input, init) {
    try {
      var urlStr = (typeof input === 'string') ? input : input.url;
      var rewritten = rewriteHTTP(new URL(urlStr));
      if (rewritten) {
        console.debug('[muxterm shim] fetch', urlStr, '->', rewritten);
        input = (typeof input === 'string') ? rewritten : new Request(rewritten, input);
      }
    } catch(e) {}
    return _fetch.call(this, input, init);
  };

  /* XHR — covers jQuery.ajax, axios<1.0, old codebases */
  var _xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    try {
      var rewritten = rewriteHTTP(new URL(String(url), location.href));
      if (rewritten) {
        console.debug('[muxterm shim] XHR', url, '->', rewritten);
        arguments[1] = rewritten;
      }
    } catch(e) {}
    return _xhrOpen.apply(this, arguments);
  };

  /* WebSocket */
  var _WS = window.WebSocket;
  function MuxtermWS(url, protocols) {
    try {
      var rewritten = rewriteWS(new URL(url));
      if (rewritten) {
        console.debug('[muxterm shim] WebSocket', url, '->', rewritten);
        url = rewritten;
      }
    } catch(e) {}
    return protocols !== undefined ? new _WS(url, protocols) : new _WS(url);
  }
  MuxtermWS.prototype = _WS.prototype;
  MuxtermWS.CONNECTING = _WS.CONNECTING;
  MuxtermWS.OPEN       = _WS.OPEN;
  MuxtermWS.CLOSING    = _WS.CLOSING;
  MuxtermWS.CLOSED     = _WS.CLOSED;
  window.WebSocket = MuxtermWS;

  /* service worker (belt-and-suspenders: handles fetch on second+ load) */
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js', {scope: '/'})
      .then(function(r) { console.debug('[muxterm shim] SW registered, scope:', r.scope); })
      .catch(function(e) { console.warn('[muxterm shim] SW registration failed:', e); });
  }

  console.debug('[muxterm shim] active — fetch + XHR + WebSocket covered');
})();
</script>`

// swScript is served at /sw.js.
// Intercepts fetch requests from controlled pages, rewriting absolute
// localhost URLs to proxy paths. Activated immediately via skipWaiting +
// clients.claim so it takes effect within the current page lifecycle.
//
// NOTE: service workers cannot intercept new WebSocket() — the shim handles that.
const swScript = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  let url;
  try { url = new URL(event.request.url); } catch(e) { return; }

  // Only intercept localhost/127.0.0.1 requests
  if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return;

  const port = url.port || '80';
  const newURL = self.location.origin + '/p/' + port + url.pathname + url.search;
  console.debug('[muxterm SW] intercepted', event.request.url, '->', newURL);

  const method = event.request.method;
  event.respondWith(
    fetch(new Request(newURL, {
      method:      method,
      headers:     event.request.headers,
      body:        (method === 'GET' || method === 'HEAD') ? undefined : event.request.body,
      credentials: 'omit',
      mode:        'cors',
    }))
  );
});
`

// HeadersFunc is called per proxy request to inject extra HTTP headers; may be nil.
type HeadersFunc func(port int) map[string]string

// noFollowClient is used for HTTP proxying.
// - Timeout: 30s
// - CheckRedirect: passes 3xx responses back to the caller instead of following them.
var noFollowClient = &http.Client{
	Timeout: 30 * time.Second,
	CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

// var _ = context.Background is a blank import anchor ensuring the context
// package is included even if not referenced directly in other statements.
var _ = context.Background

// NewHandler returns an http.Handler for /p/{port}/ paths that proxies to
// targetHost. headersFunc may be nil; when non-nil it is called per request
// to inject additional headers into the upstream request.
//
// targetHost may be a bare hostname ("127.0.0.1") or a full URL
// ("http://127.0.0.1:PORT") — in the latter case only the hostname is used.
func NewHandler(targetHost string, headersFunc HeadersFunc) http.Handler {
	// Accept full URLs: extract just the hostname component.
	if strings.Contains(targetHost, "://") {
		if u, err := url.Parse(targetHost); err == nil {
			targetHost = u.Hostname()
		}
	}
	host := targetHost // capture for closure
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handleProxyTo(w, r, host, headersFunc)
	})
}

// ServeServiceWorker serves /sw.js with the headers required for correct SW
// registration scope and cache behaviour.
func ServeServiceWorker(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	// Required: allows SW at /sw.js to claim scope / (not just /sw.js directory)
	w.Header().Set("Service-Worker-Allowed", "/")
	w.Header().Set("Cache-Control", "no-store")
	fmt.Fprint(w, swScript)
}

// handleProxyTo routes /p/{port}/{rest...} to targetHost:{port}.
func handleProxyTo(w http.ResponseWriter, r *http.Request, targetHost string, headersFunc HeadersFunc) {
	tail := strings.TrimPrefix(r.URL.Path, "/p/")
	parts := strings.SplitN(tail, "/", 2)
	if len(parts) == 0 || parts[0] == "" {
		http.Error(w, "missing port in /p/{port}/", http.StatusBadRequest)
		return
	}
	port := parts[0]
	rest := "/"
	if len(parts) == 2 && parts[1] != "" {
		rest = "/" + parts[1]
	}
	if r.URL.RawQuery != "" {
		rest += "?" + r.URL.RawQuery
	}

	var portNum int
	fmt.Sscanf(port, "%d", &portNum) //nolint:errcheck

	if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		proxyWebSocket(w, r, targetHost, port, rest)
		return
	}

	var extraHeaders map[string]string
	if headersFunc != nil && portNum > 0 {
		extraHeaders = headersFunc(portNum)
	}

	proxyHTTP(w, r, targetHost, port, rest, extraHeaders)
}

// proxyHTTP forwards a plain HTTP request to targetHost:port and streams the
// response back, injecting the shim into text/html responses.
func proxyHTTP(w http.ResponseWriter, r *http.Request, targetHost, port, path string, extraHeaders map[string]string) {
	targetURL := fmt.Sprintf("http://%s:%s%s", targetHost, port, path)

	req, err := http.NewRequestWithContext(r.Context(), r.Method, targetURL, r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Forward safe headers; drop hop-by-hop
	hopByHop := map[string]bool{
		"connection": true, "upgrade": true, "proxy-connection": true,
		"keep-alive": true, "transfer-encoding": true, "te": true,
		"trailer": true, "proxy-authorization": true, "proxy-authenticate": true,
	}
	for k, vv := range r.Header {
		if hopByHop[strings.ToLower(k)] {
			continue
		}
		for _, v := range vv {
			req.Header.Add(k, v)
		}
	}
	// req.Header.Set("Host", ...) is silently ignored by Go's HTTP client.
	// The Request.Host field is what controls the outgoing Host header.
	req.Host = fmt.Sprintf("localhost:%s", port)

	// FIX: strip Accept-Encoding so Go's transport handles decompression.
	// Without this, if the browser sends Accept-Encoding: gzip and the target
	// responds with Content-Encoding: gzip, we'd try to inject the shim into
	// compressed bytes and corrupt the response.
	req.Header.Del("Accept-Encoding")

	// Inject caller-supplied extra headers (e.g. Authorization for auth proxies).
	for k, v := range extraHeaders {
		req.Header.Set(k, v)
	}

	resp, err := noFollowClient.Do(req)
	if err != nil {
		http.Error(w, "bad gateway: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// Copy response headers, stripping ones we manage ourselves.
	for k, vv := range resp.Header {
		switch strings.ToLower(k) {
		case "content-length":
			// May change after shim injection.
			continue
		case "content-encoding":
			// We forced uncompressed responses above; don't forward this.
			continue
		case "content-security-policy", "x-content-security-policy", "x-webkit-csp":
			// Would block injected scripts.
			continue
		case "location":
			// Handled separately below — rewrite localhost redirects.
			continue
		}
		for _, v := range vv {
			w.Header().Add(k, v)
		}
	}

	// FIX: rewrite Location header for localhost redirects.
	if loc := resp.Header.Get("Location"); loc != "" {
		rewritten := rewriteLocationHeader(loc, port)
		w.Header().Set("Location", rewritten)
	}

	// For HTML: inject shim, set correct Content-Length, then write.
	ct := resp.Header.Get("Content-Type")
	if strings.Contains(ct, "text/html") {
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		body = injectShim(body)
		w.Header().Set("Content-Length", fmt.Sprintf("%d", len(body)))
		w.WriteHeader(resp.StatusCode)
		w.Write(body) //nolint:errcheck
		return
	}

	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body) //nolint:errcheck
}

// rewriteLocationHeader rewrites a Location value from an absolute localhost
// URL to a proxy path so the browser follows the redirect through the proxy.
//
//	http://localhost:9001/dashboard -> /p/9001/dashboard
//	/relative/path                  -> unchanged
//	https://external.example.com/  -> unchanged
func rewriteLocationHeader(loc, currentPort string) string {
	u, err := url.Parse(loc)
	if err != nil {
		return loc
	}
	if u.Hostname() != "localhost" && u.Hostname() != "127.0.0.1" {
		return loc
	}
	p := u.Port()
	if p == "" {
		p = currentPort
	}
	result := "/p/" + p + u.Path
	if u.RawQuery != "" {
		result += "?" + u.RawQuery
	}
	return result
}

// injectShim inserts shimScript as the first child of <head> (case-insensitive).
// Falls back to prepending to the document if no <head> is found.
func injectShim(html []byte) []byte {
	shim := []byte(shimScript)
	lower := bytes.ToLower(html)

	headOpen := []byte("<head>")
	if idx := bytes.Index(lower, headOpen); idx >= 0 {
		at := idx + len(headOpen)
		out := make([]byte, 0, len(html)+len(shim))
		out = append(out, html[:at]...)
		out = append(out, shim...)
		out = append(out, html[at:]...)
		return out
	}

	// Fallback: prepend shim if no <head> found.
	out := make([]byte, 0, len(html)+len(shim))
	out = append(out, shim...)
	out = append(out, html...)
	return out
}

// proxyWebSocket bidirectionally proxies a WebSocket connection.
func proxyWebSocket(w http.ResponseWriter, r *http.Request, targetHost, port, path string) {
	ctx := r.Context()
	targetURL := fmt.Sprintf("ws://%s:%s%s", targetHost, port, path)

	protos := parseSubprotocols(r)

	// Forward auth + subprotocols to target.
	dialOpts := &websocket.DialOptions{
		HTTPHeader:   http.Header{},
		Subprotocols: protos,
	}
	for _, k := range []string{"Authorization", "Cookie"} {
		if v := r.Header.Get(k); v != "" {
			dialOpts.HTTPHeader.Set(k, v)
		}
	}

	targetConn, _, err := websocket.Dial(ctx, targetURL, dialOpts)
	if err != nil {
		http.Error(w, "could not connect to target: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer targetConn.CloseNow()

	clientConn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: []string{"*"},
		Subprotocols:   protos,
	})
	if err != nil {
		return
	}
	defer clientConn.CloseNow()

	errc := make(chan error, 2)

	go func() {
		for {
			mt, msg, err := targetConn.Read(ctx)
			if err != nil {
				errc <- fmt.Errorf("target read: %w", err)
				return
			}
			if err := clientConn.Write(ctx, mt, msg); err != nil {
				errc <- fmt.Errorf("client write: %w", err)
				return
			}
		}
	}()

	go func() {
		for {
			mt, msg, err := clientConn.Read(ctx)
			if err != nil {
				errc <- fmt.Errorf("client read: %w", err)
				return
			}
			if err := targetConn.Write(ctx, mt, msg); err != nil {
				errc <- fmt.Errorf("target write: %w", err)
				return
			}
		}
	}()

	<-errc
}

// parseSubprotocols splits the Sec-Websocket-Protocol request header on comma.
func parseSubprotocols(r *http.Request) []string {
	raw := r.Header.Get("Sec-Websocket-Protocol")
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
