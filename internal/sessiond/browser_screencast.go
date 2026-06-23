package sessiond

import (
	"context"
	"encoding/base64"
	"encoding/json"
)

// startScreencast sends Page.startScreencast to Chrome to begin JPEG frame
// delivery. Chrome will emit Page.screencastFrame events until
// Page.stopScreencast is called or the session ends. Returns the first CDP
// error, if any.
//
// maxWidth/maxHeight are passed in physical device pixels (renderWidth * dpr)
// so Chrome sends HiDPI frames on Retina displays. Pass 0 to let Chrome choose.
func (bp *BrowserPage) startScreencast(ctx context.Context) error {
	params := map[string]any{
		"format":        "jpeg",
		"quality":       90,
		"everyNthFrame": 1,
	}
	if bp.renderWidth > 0 && bp.renderHeight > 0 {
		dpr := bp.devicePixelRatio
		if dpr <= 0 {
			dpr = 1.0
		}
		// Ask Chrome to deliver frames at physical pixel dimensions so the
		// client renders crisp frames on Retina (devicePixelRatio=2) displays.
		params["maxWidth"] = int(float64(bp.renderWidth) * dpr)
		params["maxHeight"] = int(float64(bp.renderHeight) * dpr)
	}
	_, err := bp.cdp.Call(ctx, bp.sessionID, "Page.startScreencast", params)
	return err
}

// getCurrentURL returns the URL of the most recent top-level navigation.
// It reads the in-memory cache set by handleEvent, avoiding a CDP round-trip
// at reconnect time (when Chrome may be mid-layout after SetViewport).
func (bp *BrowserPage) getCurrentURL() string {
	return bp.currentURL
}

// captureScreenshot takes a JPEG screenshot of the current page and returns
// the raw JPEG bytes. Used for on-demand frames (e.g. browser-focus, reconnect).
func (bp *BrowserPage) captureScreenshot(ctx context.Context) ([]byte, error) {
	result, err := bp.cdp.Call(ctx, bp.sessionID, "Page.captureScreenshot", map[string]any{
		"format":  "jpeg",
		"quality": 90,
	})
	if err != nil {
		return nil, err
	}
	var r struct {
		Data string `json:"data"`
	}
	if err := json.Unmarshal(result, &r); err != nil {
		return nil, err
	}
	return base64.StdEncoding.DecodeString(r.Data)
}

// runEventLoop is the page's event goroutine. It starts the screencast then
// reads from the shared CDPConn events channel, dispatching events whose
// sessionID matches this page. For v1 (maxPages: 1) there is at most one page
// so all non-browser-level events belong to this page.
func (bp *BrowserPage) runEventLoop(ctx context.Context) {
	_ = bp.startScreencast(ctx)

	for {
		select {
		case <-ctx.Done():
			return
		case ev := <-bp.cdp.events:
			if ev.SessionID != bp.sessionID {
				// v1: only one page, so events should always match.
				// Drop events from other sessions (none expected).
				continue
			}
			bp.handleEvent(ctx, ev)
		}
	}
}

// handleEvent dispatches a CDP event for this page. Recognised events:
//   - Page.screencastFrame: decode JPEG bytes, broadcast to clients, send ACK.
//   - Page.frameNavigated:  broadcast URL on main-frame navigations.
func (bp *BrowserPage) handleEvent(ctx context.Context, ev cdpEvent) {
	switch ev.Method {
	case "Page.screencastFrame":
		var frame struct {
			Data      string `json:"data"`
			SessionID int    `json:"sessionId"`
		}
		if err := json.Unmarshal(ev.Params, &frame); err != nil {
			return
		}
		jpegBytes, err := base64.StdEncoding.DecodeString(frame.Data)
		if err == nil && len(jpegBytes) > 0 {
			bp.manager.broadcast(bp.paneID, jpegBytes)
		}
		// ACK must be sent or Chrome stops sending frames.
		bp.cdp.Call(ctx, bp.sessionID, "Page.screencastFrameAck", map[string]any{ //nolint:errcheck
			"sessionId": frame.SessionID,
		})

	case "Page.frameNavigated":
		var nav struct {
			Frame struct {
				URL      string `json:"url"`
				ParentID string `json:"parentId"`
			} `json:"frame"`
		}
		if err := json.Unmarshal(ev.Params, &nav); err != nil {
			return
		}
		// Only handle top-level frame navigations (parentId == "").
		if nav.Frame.ParentID == "" && nav.Frame.URL != "" {
			bp.manager.broadcastJSON(BrowserURLMsg{
				Type:   TypeBrowserURL,
				PaneID: bp.paneID,
				URL:    nav.Frame.URL,
			})
			// Cache for getCurrentURL() at reconnect time.
			bp.currentURL = nav.Frame.URL

			// Re-apply viewport and restart the screencast after every top-level
			// navigation. Chrome resets Emulation.setDeviceMetricsOverride on
			// navigation, so without this the first frames of the new page arrive
			// at deviceScaleFactor=1 (blurry on Retina). Restarting the screencast
			// also re-applies the maxWidth/maxHeight HiDPI params.
			//
			// We do NOT send a captureScreenshot here: frameNavigated fires when
			// the navigation is committed but the new page is still loading
			// (blank/white). Sending that screenshot would display an empty page
			// and confuse the client's letterbox state. The screencast delivers
			// correct frames as the page renders.
			// Re-apply the cached client viewport dimensions after navigation.
			// Chrome resets Emulation.setDeviceMetricsOverride on frameNavigated,
			// so without this the new page renders at a default/wrong size.
			//
			// We do NOT stop/restart the screencast here. The screencast keeps
			// running with the same maxWidth/maxHeight. The client (via ResizeObserver
			// → browser-focus) is the authority on viewport size; bp.renderWidth/Height
			// is the last size the client told us. Re-applying it here is enough.
			if bp.renderWidth > 0 && bp.renderHeight > 0 {
				_ = bp.SetViewport(ctx, bp.renderWidth, bp.renderHeight)
			}
		}
	}
}
