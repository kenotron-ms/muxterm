package sessiond

import (
	"fmt"
	"strings"

	"github.com/go-rod/rod/lib/input"
	"github.com/go-rod/rod/lib/proto"
)

// HandleInput routes a BrowserInputMsg to the appropriate rod CDP call.
// Mouse coordinates are in Chromium viewport pixels (already mapped by client).
// Returns nil for unknown event types (forward-compatible).
func (bp *BrowserPage) HandleInput(msg BrowserInputMsg) error {
	switch msg.Type {
	case "mousemove":
		return bp.page.Mouse.MoveLinear(proto.Point{X: msg.X, Y: msg.Y}, 1)
	case "mousedown":
		return bp.page.Mouse.Down(mouseButton(msg.Button), 1)
	case "mouseup":
		return bp.page.Mouse.Up(mouseButton(msg.Button), 1)
	case "wheel":
		if err := bp.page.Mouse.MoveLinear(proto.Point{X: msg.X, Y: msg.Y}, 1); err != nil {
			return err
		}
		return bp.page.Mouse.Scroll(msg.DeltaX, msg.DeltaY, 1)
	case "keydown":
		k := keyFromName(msg.Key)
		if k == 0 {
			return nil // unknown key — ignore
		}
		// Keyboard.Press sends a single KeyDown CDP event and tracks the key
		// in rod's internal pressed-set so subsequent keys inherit the correct
		// modifier flags (e.g. ControlLeft held → 'c' gets the Ctrl modifier).
		// It does NOT send KeyUp — that is Keyboard.Release / Keyboard.Type.
		return bp.page.Keyboard.Press(k)
	case "keyup":
		k := keyFromName(msg.Key)
		if k == 0 {
			return nil // unknown key — ignore
		}
		// Keyboard.Release sends a single KeyUp CDP event and removes the key
		// from rod's pressed-set. If the key was never pressed (state drift),
		// it is a no-op — safe for out-of-order cleanup.
		return bp.page.Keyboard.Release(k)
	case "type":
		return bp.page.InsertText(msg.Text)
	case "navigate":
		return bp.handleNavigate(msg.URL)
	case "resize":
		return bp.page.SetViewport(&proto.EmulationSetDeviceMetricsOverride{
			Width:             msg.Width,
			Height:            msg.Height,
			DeviceScaleFactor: 1,
		})
	default:
		return nil
	}
}

// handleNavigate routes a navigation URL to the appropriate rod CDP call.
// Special pseudo-URLs "history:back", "history:forward", and "history:reload"
// trigger browser history operations. A plain URL is auto-prefixed with
// "https://" if it lacks a scheme. An empty URL returns an error.
func (bp *BrowserPage) handleNavigate(url string) error {
	switch url {
	case "history:back":
		return bp.page.NavigateBack()
	case "history:forward":
		return bp.page.NavigateForward()
	case "history:reload":
		return bp.page.Reload()
	case "":
		return fmt.Errorf("navigate: empty URL")
	default:
		if !strings.Contains(url, "://") {
			url = "https://" + url
		}
		return bp.page.Navigate(url)
	}
}

// mouseButton converts a browser mouse button name to a proto.InputMouseButton.
// Unknown names default to left button.
func mouseButton(name string) proto.InputMouseButton {
	switch name {
	case "middle":
		return proto.InputMouseButtonMiddle
	case "right":
		return proto.InputMouseButtonRight
	default:
		return proto.InputMouseButtonLeft
	}
}

// keyFromName converts a browser KeyboardEvent.key string to a rod input.Key.
// Returns 0 for unknown or unsupported keys (forward-compatible).
func keyFromName(name string) input.Key {
	// Single printable ASCII character.
	if len(name) == 1 {
		return input.Key(name[0])
	}
	// Named keys.
	switch name {
	case "Enter":
		return input.Enter
	case "Backspace":
		return input.Backspace
	case "Tab":
		return input.Tab
	case "Escape":
		return input.Escape
	case "Delete":
		return input.Delete
	case "ArrowLeft":
		return input.ArrowLeft
	case "ArrowRight":
		return input.ArrowRight
	case "ArrowUp":
		return input.ArrowUp
	case "ArrowDown":
		return input.ArrowDown
	case "Home":
		return input.Home
	case "End":
		return input.End
	case "PageUp":
		return input.PageUp
	case "PageDown":
		return input.PageDown
	case "F1":
		return input.F1
	case "F2":
		return input.F2
	case "F3":
		return input.F3
	case "F4":
		return input.F4
	case "F5":
		return input.F5
	case "F6":
		return input.F6
	case "F7":
		return input.F7
	case "F8":
		return input.F8
	case "F9":
		return input.F9
	case "F10":
		return input.F10
	case "F11":
		return input.F11
	case "F12":
		return input.F12
	case "Control":
		return input.ControlLeft
	case "Shift":
		return input.ShiftLeft
	case "Alt":
		return input.AltLeft
	case "Meta":
		return input.MetaLeft
	case "Space":
		return input.Space
	default:
		return 0
	}
}
