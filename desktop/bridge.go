package main

import (
	"encoding/json"
	"net/url"
	"sort"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"
)

type browserMessage struct {
	Type    string      `json:"type"`
	ID      int         `json:"id"`
	URL     string      `json:"url"`
	Visible bool        `json:"visible"`
	Rect    browserRect `json:"rect"`
}

func (c *Companion) browserMessage(window application.Window, raw string, origin *application.OriginInfo) {
	if !strings.HasPrefix(raw, "muxterm.desktop:") || window.Name() != "muxterm" || origin == nil || !origin.IsMainFrame {
		return
	}
	c.mu.Lock()
	serverURL := c.activeMuxtermURL
	c.mu.Unlock()
	server, serverErr := url.Parse(serverURL)
	messageURL, messageErr := url.Parse(origin.Origin)
	if serverErr != nil || messageErr != nil || server.Scheme != messageURL.Scheme || !strings.EqualFold(server.Host, messageURL.Host) {
		return
	}
	var message browserMessage
	if err := json.Unmarshal([]byte(strings.TrimPrefix(raw, "muxterm.desktop:")), &message); err != nil {
		return
	}
	go func() {
		c.bridgeMu.Lock()
		defer c.bridgeMu.Unlock()
		var actionErr error
		switch message.Type {
		case "layout":
			if message.Rect.Width >= 0 && message.Rect.Height >= 0 && message.Rect.Width < 10000 && message.Rect.Height < 10000 {
				c.browserLayout(message.Rect, message.Visible)
			}
		case "open":
			_, actionErr = c.openBrowserTab(message.URL)
		case "navigate":
			address, err := c.prepareBrowserURL(message.URL)
			actionErr = err
			if actionErr == nil {
				actionErr = c.browserAction(message.ID, "navigate", address.String())
			}
		case "back", "forward", "reload":
			actionErr = c.browserAction(message.ID, message.Type, "")
		case "external":
			address, err := c.prepareBrowserURL(message.URL)
			actionErr = err
			if actionErr == nil {
				actionErr = c.app.Browser.OpenURL(address.String())
			}
		case "select":
			actionErr = c.browserSelect(message.ID)
		case "close":
			c.browserClose(message.ID)
		case "status":
		default:
			return
		}
		active, tabs := c.browserState()
		sort.Slice(tabs, func(i, j int) bool { return tabs[i].ID < tabs[j].ID })
		state := struct {
			Active int               `json:"active"`
			Tabs   []browserTabState `json:"tabs"`
			Error  string            `json:"error,omitempty"`
		}{Active: active, Tabs: tabs}
		if actionErr != nil {
			state.Error = actionErr.Error()
		}
		encoded, _ := json.Marshal(state)
		c.evalMuxtermJS("window.__muxtermDesktopReceive?.(" + string(encoded) + ")")
	}()
}
