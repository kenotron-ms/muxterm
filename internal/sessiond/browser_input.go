package sessiond

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
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
		btn := "none"
		if msg.Button != "" {
			btn = cdpMouseButton(msg.Button)
		}
		_, err := bp.cdp.Call(ctx, bp.sessionID, "Input.dispatchMouseEvent", map[string]any{
			"type":      "mouseMoved",
			"x":         msg.X,
			"y":         msg.Y,
			"button":    btn,
			"buttons":   msg.Buttons,
			"modifiers": msg.Modifiers,
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
			"type":      "mouseMoved",
			"x":         msg.X,
			"y":         msg.Y,
			"modifiers": msg.Modifiers,
		})
		_, err := bp.cdp.Call(ctx, bp.sessionID, "Input.dispatchMouseEvent", map[string]any{
			"type":       "mousePressed",
			"x":          msg.X,
			"y":          msg.Y,
			"button":     cdpMouseButton(msg.Button),
			"clickCount": 1,
			"modifiers":  msg.Modifiers,
		})
		return err

	case "mouseup":
		_, err := bp.cdp.Call(ctx, bp.sessionID, "Input.dispatchMouseEvent", map[string]any{
			"type":       "mouseReleased",
			"x":          msg.X,
			"y":          msg.Y,
			"button":     cdpMouseButton(msg.Button),
			"clickCount": 1,
			"modifiers":  msg.Modifiers,
		})
		return err

	case "wheel":
		_, err := bp.cdp.Call(ctx, bp.sessionID, "Input.dispatchMouseEvent", map[string]any{
			"type":      "mouseWheel",
			"x":         msg.X,
			"y":         msg.Y,
			"deltaX":    msg.DeltaX,
			"deltaY":    msg.DeltaY,
			"modifiers": msg.Modifiers,
		})
		return err

	case "keydown":
		key, code, text := cdpKeyParams(msg.Key)
		// rawKeyDown fires the keydown DOM event. Chrome needs windowsVirtualKeyCode
		// to dispatch editing commands for non-printable keys (Backspace deletes,
		// Enter submits, arrow keys move cursor, Tab moves focus, etc.).
		// Without this field, rawKeyDown fires the DOM event but Chrome silently
		// skips the corresponding editing action.
		params := map[string]any{
			"type":      "rawKeyDown",
			"key":       key,
			"code":      code,
			"modifiers": msg.Modifiers,
		}
		if kc, ok := windowsVirtualKeyCodeMap[msg.Key]; ok {
			params["windowsVirtualKeyCode"] = kc
			params["nativeVirtualKeyCode"] = kc
		} else if len([]rune(msg.Key)) == 1 {
			// Single printable character: keyCode is the Unicode code point
			// (uppercase for letters). This fills the field even when msg.Key
			// is e.g. "a" (keyCode=65) rather than being absent.
			r := []rune(msg.Key)[0]
			if r >= 'a' && r <= 'z' {
				r -= 32 // uppercase: 'a'→'A' (65), etc.
			}
			params["windowsVirtualKeyCode"] = int(r)
			params["nativeVirtualKeyCode"] = int(r)
		}
		if text != "" {
			params["text"] = text
			params["unmodifiedText"] = text
		}
		if _, err := bp.cdp.Call(ctx, bp.sessionID, "Input.dispatchKeyEvent", params); err != nil {
			return err
		}
		// For printable characters, also dispatch a "char" event. This is what
		// actually inserts text into a focused <input> or <textarea> in Chrome.
		// rawKeyDown only fires the keydown DOM event; text insertion requires
		// the textInput/char path. Control characters (\r, \t, etc.) are
		// handled by rawKeyDown's native actions and must NOT get a char event.
		// CDP modifier bits: Alt=1, Ctrl=2, Meta=4, Shift=8.
		// Do NOT send a char event for Ctrl+key or Meta/Cmd+key — those are
		// keyboard shortcuts (Ctrl+A=SelectAll, Ctrl+C=Copy, Cmd+V=Paste, etc.)
		// and must be handled by rawKeyDown alone, not text insertion.
		if r, _ := utf8.DecodeRuneInString(text); r != utf8.RuneError && r >= 0x20 && r != 0x7f && msg.Modifiers&(2|4) == 0 {
			_, err := bp.cdp.Call(ctx, bp.sessionID, "Input.dispatchKeyEvent", map[string]any{
				"type":           "char",
				"key":            text,
				"text":           text,
				"unmodifiedText": text,
				"modifiers":      msg.Modifiers,
			})
			return err
		}
		return nil

	case "keyup":
		key, code, _ := cdpKeyParams(msg.Key)
		upParams := map[string]any{
			"type":      "keyUp",
			"key":       key,
			"code":      code,
			"modifiers": msg.Modifiers,
		}
		if kc, ok := windowsVirtualKeyCodeMap[msg.Key]; ok {
			upParams["windowsVirtualKeyCode"] = kc
			upParams["nativeVirtualKeyCode"] = kc
		} else if len([]rune(msg.Key)) == 1 {
			r := []rune(msg.Key)[0]
			if r >= 'a' && r <= 'z' {
				r -= 32
			}
			upParams["windowsVirtualKeyCode"] = int(r)
			upParams["nativeVirtualKeyCode"] = int(r)
		}
		_, err := bp.cdp.Call(ctx, bp.sessionID, "Input.dispatchKeyEvent", upParams)
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
		// Only prepend https:// for bare hostnames. Schemes like data:, about:,
		// file:, blob: use a single colon (not ://), so we check for any colon.
		if !strings.Contains(url, ":") {
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
	case "none":
		return "none"
	default:
		return "left"
	}
}

// windowsVirtualKeyCodeMap maps KeyboardEvent.key strings to Windows virtual
// key codes (VK_* values). Chrome's CDP Input.dispatchKeyEvent requires this
// for non-printable keys to trigger editing commands (Backspace, arrow keys,
// Delete, Enter, Tab, etc.). Without it, rawKeyDown fires the DOM event but
// Chrome doesn't dispatch the corresponding editing command.
var windowsVirtualKeyCodeMap = map[string]int{
	"Backspace": 8,
	"Tab":       9,
	"Enter":     13,
	"Escape":    27,
	" ":         32, // Space
	"Space":     32,
	"PageUp":    33,
	"PageDown":  34,
	"End":       35,
	"Home":      36,
	"ArrowLeft": 37, "Left": 37,
	"ArrowUp": 38, "Up": 38,
	"ArrowRight": 39, "Right": 39,
	"ArrowDown": 40, "Down": 40,
	"Insert": 45,
	"Delete": 46,
	"F1":     112, "F2": 113, "F3": 114, "F4": 115,
	"F5":     116, "F6": 117, "F7": 118, "F8": 119,
	"F9":     120, "F10": 121, "F11": 122, "F12": 123,
	"Shift":   16,
	"Control": 17,
	"Alt":     18,
	"Meta":    91,
}

// digitCodes maps digit characters to their CDP code names.
// Declared at package level to avoid allocating a new map on every call.
var digitCodes = map[string]string{
	"0": "Digit0", "1": "Digit1", "2": "Digit2", "3": "Digit3", "4": "Digit4",
	"5": "Digit5", "6": "Digit6", "7": "Digit7", "8": "Digit8", "9": "Digit9",
}

// punctCodes maps punctuation characters (both unshifted and shifted) to CDP code names.
// Declared at package level to avoid allocating a new map on every call.
var punctCodes = map[string]string{
	"-": "Minus", "=": "Equal", "[": "BracketLeft", "]": "BracketRight",
	"\\": "Backslash", ";": "Semicolon", "'": "Quote", "`": "Backquote",
	",": "Comma", ".": "Period", "/": "Slash",
	// Shifted equivalents (same physical key, different character)
	"_": "Minus", "+": "Equal", "{": "BracketLeft", "}": "BracketRight",
	"|": "Backslash", ":": "Semicolon", "\"": "Quote", "~": "Backquote",
	"<": "Comma", ">": "Period", "?": "Slash",
	"!": "Digit1", "@": "Digit2", "#": "Digit3", "$": "Digit4", "%": "Digit5",
	"^": "Digit6", "&": "Digit7", "*": "Digit8", "(": "Digit9", ")": "Digit0",
}

// cdpKeyParams converts a browser KeyboardEvent.key string to CDP key, code,
// and text parameters for Input.dispatchKeyEvent.
func cdpKeyParams(key string) (cdpKey, code, text string) {
	// 1. Named keys — checked first so e.g. Space isn't mishandled by the
	//    single-char fallback below.
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
	}

	// 2. Digit keys — e.g. "1" → Digit1, not "Key1".
	if c, ok := digitCodes[key]; ok {
		return key, c, key
	}

	// 3. Punctuation and their shifted equivalents — e.g. "-" → Minus, "!" → Digit1.
	if c, ok := punctCodes[key]; ok {
		return key, c, key
	}

	// 4. Fallback for other single printable characters (letters, etc.).
	if len(key) == 1 {
		return key, "Key" + strings.ToUpper(key), key
	}

	// 5. Unknown / composite key (e.g. "Dead", "Unidentified").
	return key, key, ""
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
