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
    navigator.serviceWorker.register('/p/sw.js', {scope: '/p/'})
      .then(function(r) { console.debug('[muxterm shim] SW registered, scope:', r.scope); })
      .catch(function(e) { console.warn('[muxterm shim] SW registration failed:', e); });
  }

  console.debug('[muxterm shim] active — fetch + XHR + WebSocket covered');
})();

/* muxterm agent bridge — postMessage command interface */
(function() {
  'use strict';

  const _refs = new Map();

  function isVisible(el) {
    var s = window.getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  }

  function isInteractive(el) {
    var tag = el.tagName;
    if (tag === 'A' || tag === 'BUTTON' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.hasAttribute('onclick') || el.hasAttribute('tabindex')) return true;
    return false;
  }

  function getImplicitRole(el) {
    var roles = {
      'A': 'link', 'BUTTON': 'button', 'INPUT': 'textbox', 'TEXTAREA': 'textbox',
      'SELECT': 'combobox', 'IMG': 'img', 'NAV': 'navigation', 'MAIN': 'main',
      'HEADER': 'banner', 'FOOTER': 'contentinfo', 'FORM': 'form',
      'TABLE': 'table', 'LI': 'listitem', 'UL': 'list', 'OL': 'list',
      'H1': 'heading', 'H2': 'heading', 'H3': 'heading',
      'H4': 'heading', 'H5': 'heading', 'H6': 'heading'
    };
    return roles[el.tagName] || '';
  }

  function getAccessibleName(el) {
    var label = el.getAttribute('aria-label');
    if (label) return label;
    var alt = el.getAttribute('alt');
    if (alt) return alt;
    var title = el.getAttribute('title');
    if (title) return title;
    if (el.tagName === 'INPUT') {
      var ph = el.getAttribute('placeholder');
      if (ph) return ph;
    }
    if (el.tagName === 'BUTTON' || el.tagName === 'A') return (el.textContent || '').slice(0, 50);
    return '';
  }

  function buildTree(el, depth, counter) {
    var lines = [];
    var children = el.children;
    for (var i = 0; i < children.length; i++) {
      var child = children[i];
      if (!isVisible(child)) continue;
      var role = child.getAttribute('role') || getImplicitRole(child);
      var name = getAccessibleName(child);
      var ref = '';
      if (isInteractive(child) || role || name) {
        counter[0]++;
        var id = 'e' + counter[0];
        _refs.set(id, child);
        ref = ' [ref=' + id + ']';
      }
      var extra = '';
      var ph = child.getAttribute('placeholder');
      if (ph) extra += ' [placeholder=' + ph + ']';
      var cs = window.getComputedStyle(child);
      if (cs.cursor === 'pointer') extra += ' [cursor=pointer]';
      var tag = child.tagName;
      var level = '';
      if (tag === 'H1') level = ' [level=1]';
      else if (tag === 'H2') level = ' [level=2]';
      else if (tag === 'H3') level = ' [level=3]';
      else if (tag === 'H4') level = ' [level=4]';
      else if (tag === 'H5') level = ' [level=5]';
      else if (tag === 'H6') level = ' [level=6]';
      var indent = '';
      for (var d = 0; d < depth; d++) indent += '  ';
      var line = indent + '- ' + (role || tag.toLowerCase()) + (name ? ' "' + name + '"' : '');
      if (child.childNodes.length === 1 && child.childNodes[0].nodeType === 3) {
        var text = (child.textContent || '').trim();
        if (text && !name) line += ' "' + text.slice(0, 80) + '"';
      }
      line += ref + extra + level;
      lines.push(line);
      var sub = buildTree(child, depth + 1, counter);
      for (var j = 0; j < sub.length; j++) lines.push(sub[j]);
    }
    return lines;
  }

  function snapshot() {
    _refs.clear();
    var counter = [0];
    var lines = buildTree(document.body, 0, counter);
    return {snapshot: lines.join('\n')};
  }

  function resolveTarget(refOrSelector) {
    if (!refOrSelector) throw new Error('target is empty');
    if (/^e\d+$/.test(refOrSelector)) {
      var el = _refs.get(refOrSelector);
      if (!el) throw new Error('ref ' + refOrSelector + ' not found \u2014 call snapshot first');
      return el;
    }
    var found = document.querySelector(refOrSelector);
    if (!found) throw new Error('no element matches ' + refOrSelector);
    return found;
  }

  function click(target) {
    var el = resolveTarget(target);
    el.click();
    return Promise.resolve({ok: true});
  }

  function fill(target, value) {
    var el = resolveTarget(target);
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', {bubbles: true}));
    el.dispatchEvent(new Event('change', {bubbles: true}));
    return Promise.resolve({ok: true});
  }

  function type_(value) {
    var el = document.activeElement || document.body;
    var chars = value.split('');
    for (var i = 0; i < chars.length; i++) {
      var ch = chars[i];
      el.dispatchEvent(new KeyboardEvent('keydown', {key: ch, bubbles: true}));
      el.dispatchEvent(new KeyboardEvent('keypress', {key: ch, bubbles: true}));
      var tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, el.value + ch);
        el.dispatchEvent(new Event('input', {bubbles: true}));
      }
      el.dispatchEvent(new KeyboardEvent('keyup', {key: ch, bubbles: true}));
    }
    return Promise.resolve({ok: true});
  }

  function press(key) {
    var el = document.activeElement || document.body;
    el.dispatchEvent(new KeyboardEvent('keydown', {key: key, bubbles: true}));
    el.dispatchEvent(new KeyboardEvent('keyup', {key: key, bubbles: true}));
    if (key === 'Enter') {
      var tag = el.tagName;
      if (tag === 'INPUT' || tag === 'BUTTON') {
        el.dispatchEvent(new Event('submit', {bubbles: true}));
        if (el.form) el.form.dispatchEvent(new Event('submit', {bubbles: true}));
      }
    }
    return Promise.resolve({ok: true});
  }

  function hover(target) {
    var el = resolveTarget(target);
    el.dispatchEvent(new MouseEvent('mouseover', {bubbles: true}));
    el.dispatchEvent(new MouseEvent('mouseenter', {bubbles: true}));
    return Promise.resolve({ok: true});
  }

  function select_(target, value) {
    var el = resolveTarget(target);
    if (el.tagName !== 'SELECT') throw new Error('element is not a SELECT');
    el.value = value;
    el.dispatchEvent(new Event('change', {bubbles: true}));
    return Promise.resolve({ok: true});
  }

  function eval_(expr, ref) {
    try {
      var el = ref ? resolveTarget(ref) : undefined;
      var fn = new Function('el', 'return (' + expr + ')');
      var result = fn(el);
      if (result && typeof result.then === 'function') {
        return result.then(function(v) { return {result: v}; });
      }
      return Promise.resolve({result: result});
    } catch(e) {
      return Promise.reject(e);
    }
  }

  function handleAction(msg) {
    switch (msg.action) {
      case 'snapshot':  return Promise.resolve(snapshot());
      case 'click':     return click(msg.ref || msg.selector);
      case 'fill':      return fill(msg.ref || msg.selector, msg.value || '');
      case 'type_':     return type_(msg.value);
      case 'press':     return press(msg.key);
      case 'hover':     return hover(msg.ref || msg.selector);
      case 'select_':   return select_(msg.ref || msg.selector, msg.value);
      case 'eval_':     return eval_(msg.expr, msg.ref);
      case 'goBack':    return goBack();
      case 'goForward': return goForward();
      case 'reload':    return reload();
      default:          return Promise.reject('unknown action: ' + msg.action);
    }
  }

  window.addEventListener('message', function(ev) {
    var msg = ev.data;
    if (typeof msg.type !== 'string' || msg.type.indexOf('mux-') !== 0) return;
    var cid = msg.cid;
    handleAction(msg).then(function(result) {
      window.parent.postMessage(Object.assign({}, result, {type: msg.type + '-result', cid: cid}), '*');
    }).catch(function(err) {
      window.parent.postMessage({type: msg.type + '-result', cid: cid, error: String(err)}, '*');
    });
  });

  window.parent.postMessage({type: 'mux-shim-ready', url: location.href}, '*');

  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', function(ev) {
      if (ev.data.type === 'mux-page-navigated') {
        window.parent.postMessage({type: 'mux-page-navigated', url: ev.data.url}, '*');
      }
    });
  }
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

// pSwScript is served at /p/sw.js with scope /p/.
// Tracks navigation events and reports them to controlled clients via postMessage.
// No Service-Worker-Allowed header is needed because the script path (/p/sw.js)
// already covers the declared scope (/p/).
const pSwScript = `
const navigations = [];
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  if (e.request.mode === 'navigate') {
    navigations.push(e.request.url);
    self.clients.matchAll().then(clients => clients.forEach(c => c.postMessage({type:'mux-page-navigated', url:e.request.url})));
  }
  // falls through without intercepting
});
`

// ServeAgentServiceWorker serves /p/sw.js — the agent-scoped service worker.
// Scoped to /p/ so embedded proxied pages are isolated from muxterm's own origin surface.
func ServeAgentServiceWorker(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	fmt.Fprint(w, pSwScript)
}

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
