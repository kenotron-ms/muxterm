package main

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"time"
)

type browserPickRect struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

type browserPickResult struct {
	ID         string          `json:"id"`
	Kind       string          `json:"kind,omitempty"`
	URL        string          `json:"url,omitempty"`
	Title      string          `json:"title,omitempty"`
	Selector   string          `json:"selector,omitempty"`
	Tag        string          `json:"tag,omitempty"`
	Role       string          `json:"role,omitempty"`
	Name       string          `json:"name,omitempty"`
	Text       string          `json:"text,omitempty"`
	Rect       browserPickRect `json:"rect,omitempty"`
	Screenshot string          `json:"screenshot,omitempty"`
	Error      string          `json:"error,omitempty"`
	Cancelled  bool            `json:"cancelled,omitempty"`
}

func (c *Companion) emitBrowserPick(result browserPickResult) {
	encoded, _ := json.Marshal(result)
	c.evalMuxtermJS("window.dispatchEvent(new CustomEvent('muxterm-browser-target', {detail:" + string(encoded) + "}))")
}

func (c *Companion) browserPick(id, mode string) {
	result := browserPickResult{ID: id}
	if mode != "element" && mode != "area" {
		result.Error = "Choose an element or area"
		c.emitBrowserPick(result)
		return
	}
	var tokenBytes [16]byte
	if _, err := rand.Read(tokenBytes[:]); err != nil {
		result.Error = "Could not start browser selection"
		c.emitBrowserPick(result)
		return
	}
	token := fmt.Sprintf("%x", tokenBytes)
	code, err := assets.ReadFile("assets/pick.js")
	if err != nil {
		result.Error = "Could not load browser selection"
		c.emitBrowserPick(result)
		return
	}
	input, _ := json.Marshal(map[string]string{"mode": mode, "token": token})
	c.bridgeMu.Lock()
	if !c.browserViewVisible(id) {
		c.bridgeMu.Unlock()
		result.Error = "Show this browser tab before selecting a target"
		c.emitBrowserPick(result)
		return
	}
	_, err = c.browserEvaluate(id, "("+string(code)+")("+string(input)+")")
	c.bridgeMu.Unlock()
	if err != nil {
		result.Error = err.Error()
		c.emitBrowserPick(result)
		return
	}

	// Selection happens inside the separate WKWebView. Poll a tiny JSON result
	// instead of copying page content or screenshots on every pointer move.
	read := fmt.Sprintf("(() => { const key = %q; const value = window.__muxtermPickResults?.[key]; if (value) delete window.__muxtermPickResults[key]; return JSON.stringify(value || null); })()", token)
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(180 * time.Millisecond)
		c.bridgeMu.Lock()
		if !c.browserViewVisible(id) {
			_, _ = c.browserEvaluate(id, "window.__muxtermPickCancel?.(); 'cancelled'")
			c.bridgeMu.Unlock()
			result.Cancelled = true
			c.emitBrowserPick(result)
			return
		}
		payload, evalErr := c.browserEvaluate(id, read)
		if evalErr == nil && payload != "" && payload != "null" {
			evalErr = json.Unmarshal([]byte(payload), &result)
			result.ID = id
			if evalErr == nil && result.Kind == "area" {
				rect, rectErr := c.clampBrowserPickRect(result.Rect)
				if rectErr == nil {
					result.Screenshot, rectErr = c.browserScreenshotRegion(id, rect)
				}
				if len(result.Screenshot) > 1800000 {
					result.Screenshot = ""
					rectErr = errors.New("selected area image is too large")
				}
				if rectErr != nil {
					result.Error = "Could not capture the selected area: " + rectErr.Error()
				}
			}
		}
		c.bridgeMu.Unlock()
		if evalErr != nil {
			result.Error = evalErr.Error()
			c.emitBrowserPick(result)
			return
		}
		if payload != "" && payload != "null" {
			c.emitBrowserPick(result)
			return
		}
	}
	c.bridgeMu.Lock()
	_, _ = c.browserEvaluate(id, "window.__muxtermPickCancel?.(); 'cancelled'")
	c.bridgeMu.Unlock()
	result.Error = "Browser selection timed out"
	c.emitBrowserPick(result)
}

func (c *Companion) clampBrowserPickRect(selection browserPickRect) (browserRect, error) {
	c.mu.Lock()
	view := c.browserRect
	c.mu.Unlock()
	values := []float64{selection.X, selection.Y, selection.Width, selection.Height, view.Width, view.Height}
	for _, value := range values {
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return browserRect{}, errors.New("invalid area")
		}
	}
	x := math.Max(0, math.Min(selection.X, view.Width))
	y := math.Max(0, math.Min(selection.Y, view.Height))
	width := math.Min(selection.Width, view.Width-x)
	height := math.Min(selection.Height, view.Height-y)
	if width < 12 || height < 12 {
		return browserRect{}, errors.New("selected area is too small")
	}
	return browserRect{X: x, Y: y, Width: width, Height: height}, nil
}
