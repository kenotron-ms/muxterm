package sessiond

import (
	"context"
	"encoding/base64"
	"encoding/json"
)

// jpegHeight returns the pixel height encoded in a JPEG's SOF marker.
// Returns 0 if the data is not a valid JPEG or the SOF marker is not found
// in the first ~8 KB (it always appears well before the image data in
// Chrome-generated screencasts). No full JPEG decode is needed — we only
// scan the segment headers.
func jpegHeight(data []byte) int {
	if len(data) < 4 || data[0] != 0xFF || data[1] != 0xD8 {
		return 0
	}
	i := 2
	for i+3 < len(data) {
		if data[i] != 0xFF {
			return 0
		}
		marker := data[i+1]
		i += 2
		if marker == 0xD8 { // extra SOI — skip
			continue
		}
		if marker == 0xD9 || marker == 0xDA { // EOI or SOS — done
			return 0
		}
		if i+2 > len(data) {
			return 0
		}
		segLen := int(data[i])<<8 | int(data[i+1])
		if segLen < 2 {
			return 0
		}
		// SOF markers: C0-C3, C5-C7, C9-CB, CD-CF
		isSOF := (marker >= 0xC0 && marker <= 0xC3) ||
			(marker >= 0xC5 && marker <= 0xC7) ||
			(marker >= 0xC9 && marker <= 0xCB) ||
			(marker >= 0xCD && marker <= 0xCF)
		if isSOF {
			// SOF data layout (relative to segment start, after FF marker):
			//   offset 0-1: segment length (2 bytes)
			//   offset 2:   sample precision (1 byte)
			//   offset 3-4: image height (2 bytes, big-endian)
			//   offset 5-6: image width  (2 bytes, big-endian)
			if i+4 < len(data) {
				return int(data[i+3])<<8 | int(data[i+4])
			}
			return 0
		}
		i += segLen
	}
	return 0
}

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
//   - Page.frameStartedLoading: stop screencast before navigation commits.
//   - Page.screencastFrame:     decode JPEG bytes, broadcast to clients, send ACK.
//   - Page.frameNavigated:      restart screencast after navigation commits.
func (bp *BrowserPage) handleEvent(ctx context.Context, ev cdpEvent) {
	switch ev.Method {
	case "Page.frameStartedLoading":
		// A top-level navigation has started but not yet committed.
		// Chrome will reset Emulation.setDeviceMetricsOverride at commit time
		// (Page.frameNavigated). If the screencast is still running then, Chrome
		// delivers frames at the reverted viewport size (e.g. 1280×600) which
		// appear as letterbox bars on the client.
		//
		// Stopping the screencast HERE — before commit — ensures Chrome is not
		// screencasting when the viewport resets. Page.frameNavigated restarts it
		// after re-applying the correct viewport. For navigations initiated via
		// handleNavigate (URL bar, back/forward) the screencast is already stopped
		// before we get here; this stop is idempotent.
		//
		// Filter to main frame only to avoid stopping the screencast for iframe
		// sub-resource loads. mainFrameID is set on the first frameNavigated.
		var fsl struct {
			FrameID string `json:"frameId"`
		}
		if err := json.Unmarshal(ev.Params, &fsl); err != nil {
			return
		}
		if bp.mainFrameID == "" || fsl.FrameID == bp.mainFrameID {
			_, _ = bp.cdp.Call(ctx, bp.sessionID, "Page.stopScreencast", nil)
		}

	case "Page.screencastFrame":
		var frame struct {
			Data      string `json:"data"`
			SessionID int    `json:"sessionId"`
		}
		if err := json.Unmarshal(ev.Params, &frame); err != nil {
			return
		}
		// ACK must be sent or Chrome stops sending frames.
		bp.cdp.Call(ctx, bp.sessionID, "Page.screencastFrameAck", map[string]any{ //nolint:errcheck
			"sessionId": frame.SessionID,
		})
		jpegBytes, err := base64.StdEncoding.DecodeString(frame.Data)
		if err == nil && len(jpegBytes) > 0 {
			bp.manager.broadcast(bp.paneID, jpegBytes)
		}

	case "Page.frameNavigated":
		var nav struct {
			Frame struct {
				ID       string `json:"id"`
				URL      string `json:"url"`
				ParentID string `json:"parentId"`
			} `json:"frame"`
		}
		if err := json.Unmarshal(ev.Params, &nav); err != nil {
			return
		}
		// Only handle top-level frame navigations (parentId == "").
		if nav.Frame.ParentID == "" && nav.Frame.URL != "" {
			// Track the main frame ID so frameStartedLoading can filter
			// iframe sub-resource loads from real top-level navigations.
			if bp.mainFrameID == "" {
				bp.mainFrameID = nav.Frame.ID
			}

			bp.manager.broadcastJSON(BrowserURLMsg{
				Type:   TypeBrowserURL,
				PaneID: bp.paneID,
				URL:    nav.Frame.URL,
			})
			bp.currentURL = nav.Frame.URL

			// Re-apply the client-authoritative viewport and restart the screencast.
			// Chrome resets Emulation.setDeviceMetricsOverride at navigation commit.
			// The screencast was already stopped by frameStartedLoading (for link
			// clicks) or handleNavigate (for URL bar / back / forward). This
			// SetViewport + startScreencast re-establishes the correct viewport and
			// resumes streaming at the right dimensions.
			if bp.renderWidth > 0 && bp.renderHeight > 0 {
				_ = bp.SetViewport(ctx, bp.renderWidth, bp.renderHeight)
				_ = bp.startScreencast(ctx)
			}
		}
	}
}
