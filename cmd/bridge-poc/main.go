// Bridge-POC: standalone HTTP server that demonstrates the SW bridge
// approach used by muxterm's MCP agent workbench.
//
// nosec: localhost-only throwaway POC, no timeouts needed.
package main

import (
	"log"
	"net/http"
	"strings"
)

const addr = "localhost:9099"

// parentHTML is the final parent page — it does not change in later tasks.
const parentHTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>bridge-poc parent</title>
<style>
  body { font-family: system-ui, sans-serif; padding: 1rem; }
  iframe { display: block; margin: 1rem 0; border: 1px solid #888; }
  pre#result {
    background: #1a1b26;
    color: #c0caf5;
    padding: 0.75rem 1rem;
    border-radius: 4px;
    min-height: 3rem;
    white-space: pre-wrap;
  }
  button { margin-right: 0.5rem; }
</style>
</head>
<body>
<h2>SW Bridge POC — parent page</h2>
<iframe name="bridge-frame" id="bridge-frame" src="/p/"
        width="600" height="200" style="border:1px solid #888;"></iframe>
<div>
  <button id="btn-query">Query H1</button>
  <button id="btn-goto">Go to page2</button>
  <button id="btn-back">History Back</button>
</div>
<pre id="result">(no message yet)</pre>
<script>
var frame = document.getElementById('bridge-frame');
var result = document.getElementById('result');

function send(msg) {
  frame.contentWindow.postMessage(msg, '*');
}

document.getElementById('btn-query').addEventListener('click', function() {
  send({type: 'query', selector: 'h1'});
});
document.getElementById('btn-goto').addEventListener('click', function() {
  send({type: 'goto', url: '/p/page2'});
});
document.getElementById('btn-back').addEventListener('click', function() {
  send({type: 'history-back'});
});

window.addEventListener('message', function(e) {
  result.textContent = JSON.stringify(e.data, null, 2);
});
</script>
</body>
</html>`

// pageBodyP is the raw /p/ test page before SW injection.
const pageBodyP = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>bridge-poc /p/</title>
</head>
<body>
<h1>Test Page</h1>
<p>This is the embedded test page.</p>
<a href="/p/page2">Go to page 2</a>
</body>
</html>`

// pageBodyPage2 is the raw /p/page2 test page before SW injection.
// Used by the history.back() test.
const pageBodyPage2 = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>bridge-poc /p/page2</title>
</head>
<body>
<h1>Page 2</h1>
<p>You navigated here. Use History Back to go back.</p>
</body>
</html>`

// swRegistrationSnippet registers /p/sw.js so it can claim the /p/ scope
// without a Service-Worker-Allowed header.
const swRegistrationSnippet = `<script>
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/p/sw.js', { scope: '/p/' })
    .then(function(r) { console.log('[bridge-poc] SW registered', r.scope); })
    .catch(function(e) { console.error('[bridge-poc] SW registration failed', e); });
}
</script>`

// pageShimSnippet is the postMessage bridge injected before </body> in every
// /p/ response. It lets the parent page drive the frame via postMessage.
const pageShimSnippet = `<script>
(function() {
  window.addEventListener('message', function(e) {
    var cmd = e.data;
    if (!cmd || !cmd.type) { return; }
    if (cmd.type === 'query') {
      var el = document.querySelector(cmd.selector);
      window.parent.postMessage({ type: 'query-result', selector: cmd.selector, text: el ? el.textContent : null }, '*');
    } else if (cmd.type === 'goto') {
      window.location.href = cmd.url;
    } else if (cmd.type === 'history-back') {
      window.history.back();
      window.parent.postMessage({ type: 'history-back-called' }, '*');
    }
  });
  window.parent.postMessage({ type: 'shim-ready', url: window.location.href }, '*');
}());
</script>`

// serviceWorkerJS is the bridge SW for scope /p/. It records navigation URLs
// via the fetch event so the MCP server can know the current URL per pane
// without polling. skipWaiting + clients.claim make it take control immediately
// on first load (no second refresh needed). It does NOT intercept responses.
const serviceWorkerJS = `var navigations = [];
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function (e) {
  if (e.request.mode === 'navigate') {
    navigations.push(e.request.url);
    console.log('[bridge-poc sw] navigate', e.request.url, 'total:', navigations.length);
  }
  /* do not intercept — let requests through untouched */
});
`

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/", handleParent)
	mux.HandleFunc("/p/", handleProxied)    // matches /p/ and /p/page2
	mux.HandleFunc("/p/sw.js", handleServiceWorker)
	log.Printf("bridge-poc listening on http://%s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil { //nolint:gosec // nosec localhost-only throwaway POC, no timeouts needed
		log.Fatalf("ListenAndServe: %v", err)
	}
}

// handleParent serves the final parent page at exactly "/".
// Any other path yields 404.
func handleParent(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write([]byte(parentHTML)) //nolint:errcheck
}

// handleProxied serves /p/ test pages with the SW registration snippet injected.
func handleProxied(w http.ResponseWriter, r *http.Request) {
	var body string
	switch r.URL.Path {
	case "/p/", "/p":
		body = pageBodyP
	case "/p/page2":
		body = pageBodyPage2
	default:
		http.NotFound(w, r)
		return
	}
	out := inject(body, swRegistrationSnippet, pageShimSnippet)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write([]byte(out)) //nolint:errcheck
}

// handleServiceWorker serves the bridge service worker at /p/sw.js.
// Content-Type application/javascript is required or the browser refuses to
// register the worker. Cache-Control no-cache ensures POC re-runs serve the
// latest SW.
func handleServiceWorker(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Write([]byte(serviceWorkerJS)) //nolint:errcheck
}

// inject inserts headSnippet before </head> and bodySnippet before </body>.
// If the closing tag is absent, headSnippet is prepended and bodySnippet is
// appended. It never silently no-ops.
func inject(pageHTML, headSnippet, bodySnippet string) string {
	if headSnippet != "" {
		if strings.Contains(pageHTML, "</head>") {
			pageHTML = strings.Replace(pageHTML, "</head>", headSnippet+"\n</head>", 1)
		} else {
			pageHTML = headSnippet + pageHTML
		}
	}
	if bodySnippet != "" {
		if strings.Contains(pageHTML, "</body>") {
			pageHTML = strings.Replace(pageHTML, "</body>", bodySnippet+"\n</body>", 1)
		} else {
			pageHTML = pageHTML + bodySnippet
		}
	}
	return pageHTML
}
