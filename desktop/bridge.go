package main

import (
	"encoding/json"
	"net/url"
	"sort"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"
)

type browserMessage struct {
	Type      string      `json:"type"`
	ID        string      `json:"id"`
	RequestID string      `json:"requestId"`
	URL       string      `json:"url"`
	Mode      string      `json:"mode"`
	Visible   bool        `json:"visible"`
	Rect      browserRect `json:"rect"`
}

func (c *Companion) chooseChatFolder(window application.Window, requestID string) {
	if requestID == "" {
		return
	}
	path, err := c.app.Dialog.OpenFile().AttachToWindow(window).SetTitle("Choose a folder for your chat").CanChooseFiles(false).CanChooseDirectories(true).PromptForSingleSelection()
	result := struct {
		ID    string `json:"id"`
		Path  string `json:"path,omitempty"`
		Error string `json:"error,omitempty"`
	}{ID: requestID, Path: path}
	if err != nil {
		result.Error = err.Error()
	}
	encoded, _ := json.Marshal(result)
	c.evalMuxtermJS("window.dispatchEvent(new CustomEvent('muxterm-folder-chosen', {detail:" + string(encoded) + "}))")
}

func (c *Companion) evalMuxtermJS(script string) {
	if window, ok := c.app.Window.GetByName("muxterm"); ok {
		window.ExecJS(script)
	}
}

func (c *Companion) browserMessage(window application.Window, raw string, origin *application.OriginInfo) {
	if !strings.HasPrefix(raw, "muxterm.desktop:") || window.Name() != "muxterm" || origin == nil || !origin.IsMainFrame {
		return
	}
	var message browserMessage
	if err := json.Unmarshal([]byte(strings.TrimPrefix(raw, "muxterm.desktop:")), &message); err != nil {
		return
	}
	originURL := origin.Origin
	go func() {
		c.bridgeMu.Lock()
		c.mu.Lock()
		serverURL := c.activeMuxtermURL
		localURL := ""
		if c.local != nil {
			localURL = c.local.url
		}
		c.mu.Unlock()
		server, serverErr := url.Parse(serverURL)
		messageURL, messageErr := url.Parse(originURL)
		if serverErr != nil || messageErr != nil || server.Scheme != messageURL.Scheme || !strings.EqualFold(server.Host, messageURL.Host) {
			c.bridgeMu.Unlock()
			return
		}
		if message.Type == "mac-update-check" || message.Type == "mac-update-install" {
			allowed := serverURL == localURL && localURL != ""
			c.bridgeMu.Unlock()
			if allowed {
				c.runMacUpdate(message.Type)
			} else {
				c.evalMuxtermJS("window.dispatchEvent(new CustomEvent('muxterm-mac-update', {detail:{phase:'error',error:'Mac updates require the local Muxterm workspace.'}}))")
			}
			return
		}
		if message.Type == "choose-chat-folder" {
			allowed := serverURL == localURL && localURL != ""
			c.bridgeMu.Unlock()
			if allowed {
				c.chooseChatFolder(window, message.ID)
			} else {
				encoded, _ := json.Marshal(struct {
					ID       string `json:"id"`
					Fallback bool   `json:"fallback"`
				}{ID: message.ID, Fallback: true})
				c.evalMuxtermJS("window.dispatchEvent(new CustomEvent('muxterm-folder-chosen', {detail:" + string(encoded) + "}))")
			}
			return
		}
		defer c.bridgeMu.Unlock()
		var actionErr error
		switch message.Type {
		case "layout":
			if message.Rect.Width >= 0 && message.Rect.Height >= 0 && message.Rect.Width < 10000 && message.Rect.Height < 10000 {
				c.mu.Lock()
				c.browserRect, c.browserVisible = message.Rect, message.Visible
				c.mu.Unlock()
				c.browserLayout()
			}
		case "open":
			if message.ID == "" {
				return
			}
			address := ""
			if message.URL != "" {
				u, err := c.prepareBrowserURL(message.URL)
				actionErr = err
				if err == nil {
					address = u.String()
				}
			}
			if actionErr == nil {
				actionErr = c.browserOpen(message.ID, address)
			}
		case "navigate":
			address, err := c.prepareBrowserURL(message.URL)
			actionErr = err
			if actionErr == nil {
				actionErr = c.browserAction(message.ID, "navigate", address.String())
			}
		case "back", "forward", "reload":
			actionErr = c.browserAction(message.ID, message.Type, "")
		case "external":
			address, err := prepareExternalURL(message.URL)
			actionErr = err
			if actionErr == nil {
				actionErr = c.app.Browser.OpenURL(address.String())
			}
		case "select":
			actionErr = c.browserSelect(message.ID)
		case "pick":
			go c.browserPick(message.ID, message.Mode, message.RequestID)
		case "pick-cancel":
			_, _ = c.browserEvaluate(message.ID, "window.__muxtermPickCancel?.(); 'cancelled'")
		case "ready":
		case "close":
			c.browserClose(message.ID)
		case "status":
		default:
			return
		}
		active, tabs := c.browserState()
		sort.Slice(tabs, func(i, j int) bool { return tabs[i].ID < tabs[j].ID })
		if message.Type == "ready" {
			replay := func(tab browserTabState) {
				encoded, _ := json.Marshal(struct {
					ID  string `json:"id"`
					URL string `json:"url"`
				}{ID: tab.ID, URL: tab.URL})
				c.evalMuxtermJS("window.__muxtermDesktopOpen?.(" + string(encoded) + ")")
			}
			for _, tab := range tabs {
				if tab.ID != active {
					replay(tab)
				}
			}
			for _, tab := range tabs {
				if tab.ID == active {
					replay(tab)
					break
				}
			}
		}
		state := struct {
			Active string            `json:"active"`
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
