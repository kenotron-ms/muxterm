package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type nativeBrowserCommand struct {
	Action   string  `json:"action"`
	TabID    string  `json:"tab_id"`
	URL      string  `json:"url"`
	Selector string  `json:"selector"`
	Text     string  `json:"text"`
	DeltaX   float64 `json:"delta_x"`
	DeltaY   float64 `json:"delta_y"`
}

func (c *Companion) startBrowserAutomation() error {
	dir, err := os.MkdirTemp("/tmp", "muxterm-mac-browser-")
	if err != nil {
		return err
	}
	path := filepath.Join(dir, "browser.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		_ = os.RemoveAll(dir)
		return err
	}
	if err := os.Chmod(path, 0600); err != nil {
		_ = listener.Close()
		_ = os.RemoveAll(dir)
		return err
	}
	c.browserSocketDir = dir
	c.browserSocket = path
	c.browserListener = listener
	server := &http.Server{ReadHeaderTimeout: 5 * time.Second}
	server.Handler = http.HandlerFunc(c.handleNativeBrowserCommand)
	c.browserServer = server
	go func() { _ = server.Serve(listener) }()
	return nil
}

func (c *Companion) stopBrowserAutomation() {
	if c.browserServer != nil {
		_ = c.browserServer.Close()
	}
	if c.browserListener != nil {
		_ = c.browserListener.Close()
	}
	if c.browserSocketDir != "" {
		_ = os.RemoveAll(c.browserSocketDir)
	}
}

func (c *Companion) handleNativeBrowserCommand(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || r.URL.Path != "/action" {
		http.NotFound(w, r)
		return
	}
	var command nativeBrowserCommand
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&command); err != nil {
		http.Error(w, "invalid browser command", http.StatusBadRequest)
		return
	}
	c.bridgeMu.Lock()
	result, err := c.nativeBrowserAction(command)
	c.bridgeMu.Unlock()
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(result)
}

func (c *Companion) nativeBrowserAction(command nativeBrowserCommand) (any, error) {
	switch command.Action {
	case "tabs":
		active, tabs := c.browserState()
		return map[string]any{"active": active, "tabs": tabs}, nil
	case "open":
		address, err := c.prepareBrowserURL(command.URL)
		if err != nil {
			return nil, err
		}
		c.mu.Lock()
		c.browserSeq++
		id := "browser-" + strconv.Itoa(c.browserSeq)
		c.mu.Unlock()
		if err := c.browserOpen(id, address.String()); err != nil {
			return nil, err
		}
		payload, _ := json.Marshal(map[string]string{"id": id, "url": address.String()})
		c.evalMuxtermJS("window.dispatchEvent(new CustomEvent('muxterm-browser-open', {detail:" + string(payload) + "}))")
		return map[string]string{"tab_id": id, "url": address.String()}, nil
	case "select":
		if err := c.browserSelect(command.TabID); err != nil {
			return nil, err
		}
		return map[string]any{"tab_id": command.TabID}, nil
	case "navigate":
		address, err := c.prepareBrowserURL(command.URL)
		if err != nil {
			return nil, err
		}
		if err := c.browserAction(command.TabID, "navigate", address.String()); err != nil {
			return nil, err
		}
		return map[string]string{"tab_id": command.TabID, "url": address.String()}, nil
	case "inspect", "click", "type", "scroll", "screenshot":
		if command.TabID == "" {
			return nil, errors.New("tab_id is required")
		}
		if command.Action == "screenshot" {
			data, err := c.browserEvaluate(command.TabID, "", true)
			if err != nil {
				return nil, err
			}
			return map[string]string{"mimeType": "image/png", "data": data}, nil
		}
		script, err := nativeBrowserScript(command)
		if err != nil {
			return nil, err
		}
		value, err := c.browserEvaluate(command.TabID, script, false)
		if err != nil {
			return nil, err
		}
		var result any
		if err := json.Unmarshal([]byte(value), &result); err != nil {
			return nil, fmt.Errorf("browser returned invalid result: %w", err)
		}
		return result, nil
	default:
		return nil, fmt.Errorf("unknown browser action %q", command.Action)
	}
}

func nativeBrowserScript(command nativeBrowserCommand) (string, error) {
	switch command.Action {
	case "inspect":
		return `JSON.stringify({url:location.href,title:document.title,text:(document.body?.innerText||'').slice(0,20000),elements:Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"]')).slice(0,150).map(e=>{let p=[],n=e;while(n&&n.nodeType===1&&p.length<8){let i=1,s=n;while((s=s.previousElementSibling))if(s.localName===n.localName)i++;p.unshift(n.localName+':nth-of-type('+i+')');n=n.parentElement}return {selector:p.join(' > '),tag:e.localName,text:(e.innerText||e.getAttribute('aria-label')||e.value||'').slice(0,160),href:e.href||undefined}})})`, nil
	case "click":
		if strings.TrimSpace(command.Selector) == "" {
			return "", errors.New("selector is required")
		}
		return `(function(){const e=document.querySelector(` + strconv.Quote(command.Selector) + `);if(!e)return JSON.stringify({error:'element not found'});e.click();return JSON.stringify({clicked:true})})()`, nil
	case "type":
		if strings.TrimSpace(command.Selector) == "" {
			return "", errors.New("selector is required")
		}
		return `(function(){const e=document.querySelector(` + strconv.Quote(command.Selector) + `);if(!e)return JSON.stringify({error:'element not found'});e.focus();if('value'in e){const p=e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const setter=Object.getOwnPropertyDescriptor(p,'value')?.set;if(setter)setter.call(e,e.value+` + strconv.Quote(command.Text) + `);else e.value+=` + strconv.Quote(command.Text) + `;}else if(e.isContentEditable)e.textContent+=` + strconv.Quote(command.Text) + `;else return JSON.stringify({error:'element is not editable'});e.dispatchEvent(new Event('input',{bubbles:true}));return JSON.stringify({typed:true})})()`, nil
	case "scroll":
		if command.DeltaX < -100000 || command.DeltaX > 100000 || command.DeltaY < -100000 || command.DeltaY > 100000 {
			return "", errors.New("scroll distance is out of range")
		}
		return fmt.Sprintf(`(function(){window.scrollBy(%f,%f);return JSON.stringify({scrollX:window.scrollX,scrollY:window.scrollY})})()`, command.DeltaX, command.DeltaY), nil
	}
	return "", errors.New("unsupported browser script")
}
