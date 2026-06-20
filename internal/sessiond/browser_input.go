package sessiond

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"
)

// HandleInput routes a BrowserInputMsg to the appropriate raw CDP call.
// Mouse coordinates are in Chromium viewport pixels (already mapped by client).
// Returns nil for unknown event types (forward-compatible).
func (bp *BrowserPage) HandleInput(ctx context.Context, msg BrowserInputMsg) error {
	// Authority guard: if the event carries a clientId and the client is not
	// the current authority, silently drop mouse/keyboard input. Events without
	// a clientId (legacy format) are allowed through for backward compat.
	isInputEvent := msg.Type == "mousemove" || msg.Type == "mousedown" ||
		msg.Type == "mouseup" || msg.Type == "wheel" ||
		msg.Type == "keydown" || msg.Type == "keyup"
	if isInputEvent && msg.ClientID != "" && !bp.manager.IsAuthority(bp.paneID, msg.ClientID) {
		return nil // silently drop from non-authority clients
	}

	switch msg.Type {
	case "mousemove":
		_, err := bp.cdp.Call(ctx, bp.sessionID, "Input.dispatchMouseEvent", map[string]any{
			"type": "mouseMoved",
			"x":    msg.X,
			"y":    msg.Y,
		})
		if err == nil {
			bp.maybeSendCursor(ctx, msg.X, msg.Y)
		}
		return err

	case "mousedown":
		// Always move to the click position first so Chrome's internal cursor
		// state is correct before the press event. Some elements (buttons,
		// links, hit-test areas) only respond to mousePressed when a prior
		// mouseMoved has placed the cursor there.
		bp.cdp.Call(ctx, bp.sessionID, "Input.dispatchMouseEvent", map[string]any{ //nolint:errcheck
			"type": "mouseMoved",
			"x":   msg.X,
			"y":   msg.Y,
		})
		_, err := bp.cdp.Call(ctx, bp.sessionID, "Input.dispatchMouseEvent", map[string]any{
			"type":       "mousePressed",
			"x":          msg.X,
			"y":          msg.Y,
			"button":     cdpMouseButton(msg.Button),
			"clickCount": 1,
		})
		return err

	case "mouseup":
		_, err := bp.cdp.Call(ctx, bp.sessionID, "Input.dispatchMouseEvent", map[string]any{
			"type":       "mouseReleased",
			"x":          msg.X,
			"y":          msg.Y,
			"button":     cdpMouseButton(msg.Button),
			"clickCount": 1,
		})
		return err

	case "wheel":
		_, err := bp.cdp.Call(ctx, bp.sessionID, "Input.dispatchMouseEvent", map[string]any{
			"type":   "mouseWheel",
			"x":      msg.X,
			"y":      msg.Y,
			"deltaX": msg.DeltaX,
			"deltaY": msg.DeltaY,
		})
		return err

	case "keydown":
		key, code, text := cdpKeyParams(msg.Key)
		params := map[string]any{
			// rawKeyDown (not keyDown) triggers native browser actions:
			// Backspace deletes, Enter submits/newlines, Tab focuses next, etc.
			// keyDown only fires the JS keydown event — browser built-in
			// actions are ignored. rawKeyDown = native OS key press.
			"type": "rawKeyDown",
			"key":  key,
			"code": code,
		}
		if text != "" {
			params["text"] = text
			params["unmodifiedText"] = text
		}
		_, err := bp.cdp.Call(ctx, bp.sessionID, "Input.dispatchKeyEvent", params)
		return err

	case "keyup":
		key, code, _ := cdpKeyParams(msg.Key)
		_, err := bp.cdp.Call(ctx, bp.sessionID, "Input.dispatchKeyEvent", map[string]any{
			"type": "keyUp",
			"key":  key,
			"code": code,
		})
		return err

	case "navigate":
		return bp.handleNavigate(ctx, msg.URL)

	case "resize":
		_, err := bp.cdp.Call(ctx, bp.sessionID, "Emulation.setDeviceMetricsOverride", map[string]any{
			"width":             msg.Width,
			"height":            msg.Height,
			"deviceScaleFactor": 1,
			"mobile":            false,
		})
		return err

	case "browser-focus":
		// 1. Update Chromium viewport to match this client's canvas dimensions.
		if msg.RenderWidth > 0 && msg.RenderHeight > 0 {
			if err := bp.SetViewport(ctx, msg.RenderWidth, msg.RenderHeight); err != nil {
				return fmt.Errorf("browser-focus SetViewport: %w", err)
			}
		}
		// 2. Record this client as the input authority (last-focus-wins).
		bp.manager.SetAuthority(bp.paneID, msg.ClientID)
		// 3. Notify all connected clients who holds authority.
		bp.manager.broadcastJSON(BrowserGrantedMsg{
			Type:     TypeBrowserGranted,
			PaneID:   bp.paneID,
			ClientID: msg.ClientID,
		})
		// 4. Take a fresh screenshot so the canvas is not blank while screencast (re)starts.
		if shot, err := bp.captureScreenshot(ctx); err == nil && len(shot) > 0 {
			bp.manager.broadcast(bp.paneID, shot)
		}
		// 5. (Re)start the screencast.
		return bp.startScreencast(ctx)

	case "browser-blur":
		// Client releases input authority.
		bp.manager.ClearAuthority(bp.paneID, msg.ClientID)
		return nil

	case "browser-ready":
		// Legacy signal kept for backward compatibility during the Phase 1→2 transition.
		// New clients send browser-focus instead. Restart screencast only.
		return bp.startScreencast(ctx)

	default:
		return nil
	}
}

// handleNavigate routes a navigation URL to the appropriate CDP call.
// Special pseudo-URLs "history:back", "history:forward", and "history:reload"
// trigger browser history operations. A plain URL is auto-prefixed with
// "https://" if it lacks a scheme. An empty URL returns an error.
func (bp *BrowserPage) handleNavigate(ctx context.Context, url string) error {
	switch url {
	case "history:back":
		_, err := bp.cdp.Call(ctx, bp.sessionID, "Page.goBack", nil)
		return err
	case "history:forward":
		_, err := bp.cdp.Call(ctx, bp.sessionID, "Page.goForward", nil)
		return err
	case "history:reload":
		_, err := bp.cdp.Call(ctx, bp.sessionID, "Page.reload", nil)
		return err
	case "":
		return fmt.Errorf("navigate: empty URL")
	default:
		if !strings.Contains(url, "://") {
			url = "https://" + url
		}
		_, err := bp.cdp.Call(ctx, bp.sessionID, "Page.navigate", map[string]any{"url": url})
		return err
	}
}

// cdpMouseButton converts a browser mouse button name to the CDP button string.
// Unknown names default to left button.
func cdpMouseButton(name string) string {
	switch name {
	case "middle":
		return "middle"
	case "right":
		return "right"
	default:
		return "left"
	}
}

// cdpKeyParams converts a browser KeyboardEvent.key string to CDP key, code,
// and text parameters for Input.dispatchKeyEvent.
func cdpKeyParams(key string) (cdpKey, code, text string) {
	// Single printable character
	if len(key) == 1 {
		return key, "Key" + strings.ToUpper(key), key
	}
	// Named keys
	switch key {
	case "Enter":
		return "Enter", "Enter", "\r"
	case "Backspace":
		return "Backspace", "Backspace", ""
	case "Tab":
		return "Tab", "Tab", "\t"
	case "Escape":
		return "Escape", "Escape", ""
	case "Delete":
		return "Delete", "Delete", ""
	case "ArrowLeft":
		return "ArrowLeft", "ArrowLeft", ""
	case "ArrowRight":
		return "ArrowRight", "ArrowRight", ""
	case "ArrowUp":
		return "ArrowUp", "ArrowUp", ""
	case "ArrowDown":
		return "ArrowDown", "ArrowDown", ""
	case "Home":
		return "Home", "Home", ""
	case "End":
		return "End", "End", ""
	case "PageUp":
		return "PageUp", "PageUp", ""
	case "PageDown":
		return "PageDown", "PageDown", ""
	case "F1":
		return "F1", "F1", ""
	case "F2":
		return "F2", "F2", ""
	case "F3":
		return "F3", "F3", ""
	case "F4":
		return "F4", "F4", ""
	case "F5":
		return "F5", "F5", ""
	case "F6":
		return "F6", "F6", ""
	case "F7":
		return "F7", "F7", ""
	case "F8":
		return "F8", "F8", ""
	case "F9":
		return "F9", "F9", ""
	case "F10":
		return "F10", "F10", ""
	case "F11":
		return "F11", "F11", ""
	case "F12":
		return "F12", "F12", ""
	case "Control":
		return "Control", "ControlLeft", ""
	case "Shift":
		return "Shift", "ShiftLeft", ""
	case "Alt":
		return "Alt", "AltLeft", ""
	case "Meta":
		return "Meta", "MetaLeft", ""
	case " ", "Space":
		return " ", "Space", " "
	default:
		return key, key, ""
	}
}

// Package-level cursor throttle state. Shared across all pages (v1: one page).
var (
	lastCursorMu  sync.Mutex
	lastCursorVal string
	lastCursorTs  time.Time
)

// maybeSendCursor evaluates the CSS cursor at (x,y) via Runtime.evaluate
// and broadcasts a browser-cursor JSON message if the cursor changed.
// Throttled to max 20/sec. Runs the evaluation in a goroutine.
func (bp *BrowserPage) maybeSendCursor(ctx context.Context, x, y float64) {
	lastCursorMu.Lock()
	if time.Since(lastCursorTs) < 50*time.Millisecond {
		lastCursorMu.Unlock()
		return
	}
	lastCursorTs = time.Now()
	lastCursorMu.Unlock()

	go func() {
		result, err := bp.cdp.Call(ctx, bp.sessionID, "Runtime.evaluate", map[string]any{
			"expression": fmt.Sprintf(
				"((x,y)=>{const el=document.elementFromPoint(x,y);return el?getComputedStyle(el).cursor:'default';})(%g,%g)",
				x, y,
			),
			"returnByValue": true,
		})
		if err != nil {
			return
		}
		var r struct {
			Result struct {
				Value string `json:"value"`
			} `json:"result"`
		}
		if err := json.Unmarshal(result, &r); err != nil {
			return
		}
		cursor := r.Result.Value
		if cursor == "" {
			cursor = "default"
		}
		lastCursorMu.Lock()
		changed := cursor != lastCursorVal
		if changed {
			lastCursorVal = cursor
		}
		lastCursorMu.Unlock()
		if changed {
			bp.manager.broadcastJSON(map[string]any{
				"type":   "browser-cursor",
				"paneId": bp.paneID,
				"cursor": cursor,
			})
		}
	}()
}
