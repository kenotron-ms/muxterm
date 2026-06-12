package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// --- handleParent tests ---

func TestHandleParent_RootPath_Returns200(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := httptest.NewRecorder()
	handleParent(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200 got %d", rr.Code)
	}
}

func TestHandleParent_RootPath_ContainsSWBridgePOC(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := httptest.NewRecorder()
	handleParent(rr, req)
	body := rr.Body.String()
	if !strings.Contains(body, "SW Bridge POC") {
		t.Fatalf("response body missing 'SW Bridge POC'; got:\n%s", body)
	}
}

func TestHandleParent_RootPath_HasIframe(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := httptest.NewRecorder()
	handleParent(rr, req)
	body := rr.Body.String()
	if !strings.Contains(body, `id="bridge-frame"`) {
		t.Fatalf("response body missing bridge-frame iframe; got:\n%s", body)
	}
}

func TestHandleParent_RootPath_HasButtons(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := httptest.NewRecorder()
	handleParent(rr, req)
	body := rr.Body.String()
	for _, id := range []string{"btn-query", "btn-goto", "btn-back"} {
		if !strings.Contains(body, id) {
			t.Fatalf("response body missing button id %q; got:\n%s", id, body)
		}
	}
}

func TestHandleParent_RootPath_HasResultPre(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := httptest.NewRecorder()
	handleParent(rr, req)
	body := rr.Body.String()
	if !strings.Contains(body, `id="result"`) {
		t.Fatalf("response body missing pre#result; got:\n%s", body)
	}
}

func TestHandleParent_RootPath_ContentType(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := httptest.NewRecorder()
	handleParent(rr, req)
	ct := rr.Header().Get("Content-Type")
	if !strings.Contains(ct, "text/html") {
		t.Fatalf("expected text/html content-type, got %q", ct)
	}
}

func TestHandleParent_NonRootPath_Returns404(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/other", nil)
	rr := httptest.NewRecorder()
	handleParent(rr, req)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for /other, got %d", rr.Code)
	}
}

func TestHandleParent_NonRootPath_DoesNotReturnHTML(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/something", nil)
	rr := httptest.NewRecorder()
	handleParent(rr, req)
	body := rr.Body.String()
	if strings.Contains(body, "SW Bridge POC") {
		t.Fatalf("non-root path should not return parent HTML")
	}
}

// --- handleProxied tests ---

func TestHandleProxied_Returns200(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/p/", nil)
	rr := httptest.NewRecorder()
	handleProxied(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200 got %d", rr.Code)
	}
}

func TestHandleProxied_ContentType(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/p/", nil)
	rr := httptest.NewRecorder()
	handleProxied(rr, req)
	ct := rr.Header().Get("Content-Type")
	if !strings.Contains(ct, "text/html") {
		t.Fatalf("expected text/html content-type, got %q", ct)
	}
}

// Task 2: SW registration snippet injected into /p/ responses.

func TestHandleProxied_P_ContainsSWRegister(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/p/", nil)
	rr := httptest.NewRecorder()
	handleProxied(rr, req)
	body := rr.Body.String()
	if !strings.Contains(body, "serviceWorker.register") {
		t.Fatalf("expected serviceWorker.register in /p/ response, got:\n%s", body)
	}
}

func TestHandleProxied_P_HasTestPageH1(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/p/", nil)
	rr := httptest.NewRecorder()
	handleProxied(rr, req)
	body := rr.Body.String()
	if !strings.Contains(body, "<h1>Test Page</h1>") {
		t.Fatalf("expected <h1>Test Page</h1> in /p/ response, got:\n%s", body)
	}
}

func TestHandleProxied_P_HasLinkToPage2(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/p/", nil)
	rr := httptest.NewRecorder()
	handleProxied(rr, req)
	body := rr.Body.String()
	if !strings.Contains(body, "/p/page2") {
		t.Fatalf("expected link to /p/page2 in /p/ response, got:\n%s", body)
	}
}

func TestHandleProxied_P_SWRegisterBeforeCloseHead(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/p/", nil)
	rr := httptest.NewRecorder()
	handleProxied(rr, req)
	body := rr.Body.String()
	swIdx := strings.Index(body, "serviceWorker.register")
	headIdx := strings.Index(body, "</head>")
	if swIdx == -1 || headIdx == -1 || swIdx > headIdx {
		t.Fatalf("expected serviceWorker.register before </head>; swIdx=%d headIdx=%d\nbody:\n%s", swIdx, headIdx, body)
	}
}

func TestHandleProxied_Page2_HasPage2Content(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/p/page2", nil)
	rr := httptest.NewRecorder()
	handleProxied(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200 for /p/page2, got %d", rr.Code)
	}
	body := rr.Body.String()
	if !strings.Contains(body, "<h1>Page 2</h1>") {
		t.Fatalf("expected <h1>Page 2</h1> in /p/page2 response, got:\n%s", body)
	}
}

func TestHandleProxied_Page2_ContainsSWRegister(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/p/page2", nil)
	rr := httptest.NewRecorder()
	handleProxied(rr, req)
	body := rr.Body.String()
	if !strings.Contains(body, "serviceWorker.register") {
		t.Fatalf("expected serviceWorker.register in /p/page2 response, got:\n%s", body)
	}
}

func TestHandleProxied_UnknownPath_Returns404(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/p/unknown", nil)
	rr := httptest.NewRecorder()
	handleProxied(rr, req)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for /p/unknown, got %d", rr.Code)
	}
}

// --- handleServiceWorker tests ---

func TestHandleServiceWorker_Returns200(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/p/sw.js", nil)
	rr := httptest.NewRecorder()
	handleServiceWorker(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200 got %d", rr.Code)
	}
}

func TestHandleServiceWorker_ContentType(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/p/sw.js", nil)
	rr := httptest.NewRecorder()
	handleServiceWorker(rr, req)
	ct := rr.Header().Get("Content-Type")
	if !strings.Contains(ct, "application/javascript") {
		t.Fatalf("expected application/javascript content-type, got %q", ct)
	}
}

func TestHandleServiceWorker_BodyIsServiceWorkerJS(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/p/sw.js", nil)
	rr := httptest.NewRecorder()
	handleServiceWorker(rr, req)
	body := rr.Body.String()
	if body != serviceWorkerJS {
		t.Fatalf("expected body to equal serviceWorkerJS; got:\n%s", body)
	}
}

// --- inject() tests ---

func TestInject_InsertHeadSnippetBeforeCloseHead(t *testing.T) {
	page := "<html><head></head><body></body></html>"
	result := inject(page, "<meta charset=utf-8>", "")
	if !strings.Contains(result, "<meta charset=utf-8>\n</head>") {
		t.Fatalf("expected head snippet before </head>; got:\n%s", result)
	}
}

func TestInject_InsertBodySnippetBeforeCloseBody(t *testing.T) {
	page := "<html><head></head><body></body></html>"
	result := inject(page, "", "<script>var x=1;</script>")
	if !strings.Contains(result, "<script>var x=1;</script>\n</body>") {
		t.Fatalf("expected body snippet before </body>; got:\n%s", result)
	}
}

func TestInject_PrependHeadSnippetWhenNoCloseHeadMarker(t *testing.T) {
	page := "<html><body>content</body></html>"
	result := inject(page, "<meta charset=utf-8>", "")
	if !strings.HasPrefix(result, "<meta charset=utf-8>") {
		t.Fatalf("expected head snippet prepended when no </head>; got:\n%s", result)
	}
}

func TestInject_AppendBodySnippetWhenNoCloseBodyMarker(t *testing.T) {
	page := "<html><head></head>content"
	result := inject(page, "", "<script>var x=1;</script>")
	if !strings.HasSuffix(result, "<script>var x=1;</script>") {
		t.Fatalf("expected body snippet appended when no </body>; got:\n%s", result)
	}
}

func TestInject_BothSnippetsInserted(t *testing.T) {
	page := "<!DOCTYPE html><html><head></head><body></body></html>"
	result := inject(page, "<link rel=stylesheet>", "<script>init();</script>")
	if !strings.Contains(result, "<link rel=stylesheet>\n</head>") {
		t.Fatalf("head snippet not found; got:\n%s", result)
	}
	if !strings.Contains(result, "<script>init();</script>\n</body>") {
		t.Fatalf("body snippet not found; got:\n%s", result)
	}
}

func TestInject_OnlyFirstOccurrenceReplaced(t *testing.T) {
	// Multiple </head> tags — should only replace the first
	page := "<html><head></head><head></head></html>"
	result := inject(page, "SNIPPET", "")
	count := strings.Count(result, "SNIPPET\n</head>")
	if count != 1 {
		t.Fatalf("expected exactly 1 head injection, got %d; result:\n%s", count, result)
	}
}

// --- Task 4: serviceWorkerJS and handleServiceWorker ---

func TestServiceWorkerJS_ContainsNavigationsVar(t *testing.T) {
	if !strings.Contains(serviceWorkerJS, "navigations") {
		t.Fatalf("serviceWorkerJS missing 'navigations'; got:\n%s", serviceWorkerJS)
	}
}

func TestServiceWorkerJS_ContainsInstallListener(t *testing.T) {
	if !strings.Contains(serviceWorkerJS, "addEventListener('install'") {
		t.Fatalf("serviceWorkerJS missing addEventListener('install'; got:\n%s", serviceWorkerJS)
	}
}

func TestServiceWorkerJS_ContainsActivateListener(t *testing.T) {
	if !strings.Contains(serviceWorkerJS, "addEventListener('activate'") {
		t.Fatalf("serviceWorkerJS missing addEventListener('activate'; got:\n%s", serviceWorkerJS)
	}
}

func TestServiceWorkerJS_ContainsFetchListener(t *testing.T) {
	if !strings.Contains(serviceWorkerJS, "addEventListener('fetch'") {
		t.Fatalf("serviceWorkerJS missing addEventListener('fetch'; got:\n%s", serviceWorkerJS)
	}
}

func TestHandleServiceWorker_NoCacheHeader(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/p/sw.js", nil)
	rr := httptest.NewRecorder()
	handleServiceWorker(rr, req)
	cc := rr.Header().Get("Cache-Control")
	if cc != "no-cache" {
		t.Fatalf("expected Cache-Control: no-cache, got %q", cc)
	}
}

func TestHandleServiceWorker_BodyContainsFetchListener(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/p/sw.js", nil)
	rr := httptest.NewRecorder()
	handleServiceWorker(rr, req)
	body := rr.Body.String()
	if !strings.Contains(body, "addEventListener('fetch'") {
		t.Fatalf("expected addEventListener('fetch' in SW response, got:\n%s", body)
	}
}

// --- Task 3: pageShimSnippet tests ---

func TestPageShimSnippet_ContainsShimReady(t *testing.T) {
	if !strings.Contains(pageShimSnippet, "shim-ready") {
		t.Fatalf("pageShimSnippet missing 'shim-ready'; got:\n%s", pageShimSnippet)
	}
}

func TestPageShimSnippet_ContainsQueryHandler(t *testing.T) {
	if !strings.Contains(pageShimSnippet, "query-result") {
		t.Fatalf("pageShimSnippet missing 'query-result' handler; got:\n%s", pageShimSnippet)
	}
}

func TestPageShimSnippet_ContainsGotoHandler(t *testing.T) {
	if !strings.Contains(pageShimSnippet, "goto") {
		t.Fatalf("pageShimSnippet missing 'goto' handler; got:\n%s", pageShimSnippet)
	}
}

func TestPageShimSnippet_ContainsHistoryBackHandler(t *testing.T) {
	if !strings.Contains(pageShimSnippet, "history-back") {
		t.Fatalf("pageShimSnippet missing 'history-back' handler; got:\n%s", pageShimSnippet)
	}
}

func TestHandleProxied_P_ContainsShimReady(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/p/", nil)
	rr := httptest.NewRecorder()
	handleProxied(rr, req)
	body := rr.Body.String()
	if !strings.Contains(body, "shim-ready") {
		t.Fatalf("expected 'shim-ready' in /p/ response, got:\n%s", body)
	}
}

func TestHandleProxied_P_ShimBeforeCloseBody(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/p/", nil)
	rr := httptest.NewRecorder()
	handleProxied(rr, req)
	body := rr.Body.String()
	shimIdx := strings.Index(body, "shim-ready")
	bodyIdx := strings.Index(body, "</body>")
	if shimIdx == -1 || bodyIdx == -1 || shimIdx > bodyIdx {
		t.Fatalf("expected shim-ready before </body>; shimIdx=%d bodyIdx=%d\nbody:\n%s", shimIdx, bodyIdx, body)
	}
}

func TestHandleProxied_Page2_ContainsShimReady(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/p/page2", nil)
	rr := httptest.NewRecorder()
	handleProxied(rr, req)
	body := rr.Body.String()
	if !strings.Contains(body, "shim-ready") {
		t.Fatalf("expected 'shim-ready' in /p/page2 response, got:\n%s", body)
	}
}
