package main

import (
	"encoding/json"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"
)

type browserMessage struct {
	Type        string      `json:"type"`
	ID          string      `json:"id"`
	URL         string      `json:"url"`
	Destination string      `json:"destination"`
	Host        string      `json:"host"`
	ChatID      string      `json:"chatId"`
	Visible     bool        `json:"visible"`
	Rect        browserRect `json:"rect"`
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
		if message.Type == "remote-chats" {
			allowed := serverURL == localURL && localURL != ""
			c.bridgeMu.Unlock()
			if !allowed {
				return
			}
			snapshot := c.readRemoteChats(message.Host)
			encoded, _ := json.Marshal(snapshot)
			c.evalMuxtermJS("window.dispatchEvent(new CustomEvent('muxterm-remote-chats', {detail:" + string(encoded) + "}))")
			return
		}
		if message.Type == "open-remote-chat" {
			allowed := serverURL == localURL && localURL != ""
			c.bridgeMu.Unlock()
			if !allowed {
				return
			}
			if err := c.openRemoteChat(message.Host, message.ChatID); err != nil {
				encoded, _ := json.Marshal(map[string]string{"host": message.Host, "error": err.Error()})
				c.evalMuxtermJS("window.dispatchEvent(new CustomEvent('muxterm-remote-chat-error', {detail:" + string(encoded) + "}))")
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
			address, err := c.prepareBrowserURL(message.URL)
			actionErr = err
			if actionErr == nil {
				actionErr = c.app.Browser.OpenURL(address.String())
			}
		case "open-link":
			address, err := c.prepareBrowserURL(message.URL)
			actionErr = err
			if actionErr == nil {
				if message.Destination == "default" {
					actionErr = c.app.Browser.OpenURL(address.String())
				} else {
					c.mu.Lock()
					c.browserSeq++
					id := "browser-" + strconv.Itoa(c.browserSeq)
					c.mu.Unlock()
					actionErr = c.browserOpen(id, address.String())
					if actionErr == nil {
						payload, _ := json.Marshal(map[string]string{"id": id, "url": address.String()})
						c.evalMuxtermJS("window.dispatchEvent(new CustomEvent('muxterm-browser-open', {detail:" + string(payload) + "}))")
					}
				}
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
