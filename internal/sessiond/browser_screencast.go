package sessiond

import (
	"encoding/base64"

	"github.com/go-rod/rod/lib/proto"
)

// startScreencast subscribes to Chromium's Page.screencastFrame events and
// begins streaming JPEG frames to BrowserManager's broadcast callback. It also
// subscribes to Page.frameNavigated to broadcast URL changes. Frames are sent
// non-blocking (the hub uses non-blocking sends with drop semantics at the
// WebSocket write layer). screencastFrameAck is called for every frame —
// without this Chromium stops sending. Spawns a goroutine that stops when
// stopCh is closed.
func (bp *BrowserPage) startScreencast() {
	// Subscribe to JPEG frame events. cancelFrames is the wait/cancel function
	// returned by EachEvent; calling it drains pending events and blocks until
	// the subscription ends (page context cancelled).
	cancelFrames := bp.page.EachEvent(func(e *proto.PageScreencastFrame) {
		data, err := base64.StdEncoding.DecodeString(string(e.Data))
		if err == nil && len(data) > 0 {
			bp.manager.broadcast(bp.paneID, data)
		}
		// Always ACK: without this Chromium stops sending frames.
		proto.PageScreencastFrameAck{SessionID: e.SessionID}.Call(bp.page) //nolint:errcheck
	})

	// Subscribe to navigation events to broadcast URL changes on main-frame
	// navigations (ParentID == "" identifies the top-level frame).
	cancelNav := bp.page.EachEvent(func(e *proto.PageFrameNavigated) {
		if e.Frame.ParentID == "" && e.Frame.URL != "" {
			bp.manager.broadcastJSON(BrowserURLMsg{
				Type:   TypeBrowserURL,
				PaneID: bp.paneID,
				URL:    e.Frame.URL,
			})
		}
	})

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

	// Background goroutine: when stopCh is closed, drain subscriptions and
	// send Page.stopScreencast to Chromium.
	go func() {
		<-bp.stopCh
		cancelFrames()
		cancelNav()
		proto.PageStopScreencast{}.Call(bp.page) //nolint:errcheck
	}()
}

// stopScreencast closes stopCh, causing the cleanup goroutine started in
// startScreencast to cancel event subscriptions and send Page.stopScreencast
// to Chromium. Safe to call only once; subsequent calls panic on close of
// closed channel.
func (bp *BrowserPage) stopScreencast() {
	close(bp.stopCh)
}
