package sessiond

import (
	"time"

	"github.com/go-rod/rod/lib/proto"
)

// startScreencast subscribes to Chromium's Page.screencastFrame events and
// begins streaming JPEG frames to BrowserManager's broadcast callback. It also
// subscribes to Page.frameNavigated to broadcast URL changes. Frames are sent
// non-blocking (the hub uses non-blocking sends with drop semantics at the
// WebSocket write layer). screencastFrameAck is called for every frame —
// without this Chromium stops sending. Both EachEvent loops run for the pane's
// lifetime and exit cleanly when the page context is cancelled by ClosePage.
func (bp *BrowserPage) startScreencast() {
	// Subscribe to JPEG frame events. EachEvent returns the event loop itself;
	// `go ... ()` starts it immediately in a goroutine. PageScreencastFrame.Data
	// is []byte — Go's json.Unmarshal already base64-decodes it into raw JPEG
	// bytes, so no further decoding is needed.
	go bp.page.EachEvent(func(e *proto.PageScreencastFrame) {
		if len(e.Data) > 0 {
			bp.manager.broadcast(bp.paneID, e.Data)
		}
		// Always ACK: without this Chromium stops sending frames.
		proto.PageScreencastFrameAck{SessionID: e.SessionID}.Call(bp.page) //nolint:errcheck
	})()

	// Subscribe to navigation events to broadcast URL changes on main-frame
	// navigations (ParentID == "" identifies the top-level frame).
	go bp.page.EachEvent(func(e *proto.PageFrameNavigated) {
		if e.Frame.ParentID == "" && e.Frame.URL != "" {
			bp.manager.broadcastJSON(BrowserURLMsg{
				Type:   TypeBrowserURL,
				PaneID: bp.paneID,
				URL:    e.Frame.URL,
			})
		}
	})()

	// Start Chromium screencast: JPEG quality 75, 1280×720, every frame.
	quality := 75
	maxWidth := 1280
	maxHeight := 720
	everyNthFrame := 1
	proto.PageStartScreencast{ //nolint:errcheck
		Format:        proto.PageStartScreencastFormatJpeg,
		Quality:       &quality,
		MaxWidth:      &maxWidth,
		MaxHeight:     &maxHeight,
		EveryNthFrame: &everyNthFrame,
	}.Call(bp.page)

	// Heartbeat: Chrome stops screencasting static pages (no visual change →
	// no new frames). Every 2 seconds, stop and restart the screencast to
	// force Chrome to emit at least one fresh frame. The goroutine exits when
	// stopScreencast closes stopCh (called by ClosePage).
	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				_ = proto.PageStopScreencast{}.Call(bp.page)
				_ = proto.PageStartScreencast{
					Format:        proto.PageStartScreencastFormatJpeg,
					Quality:       &quality,
					MaxWidth:      &maxWidth,
					MaxHeight:     &maxHeight,
					EveryNthFrame: &everyNthFrame,
				}.Call(bp.page)
			case <-bp.stopCh:
				return
			}
		}
	}()
}

// stopScreencast closes stopCh. The EachEvent goroutines exit when the page
// context is cancelled by ClosePage; stopCh is retained for any other
// consumers that gate on pane teardown.
func (bp *BrowserPage) stopScreencast() {
	close(bp.stopCh)
}
