//go:build darwin

package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa -framework WebKit
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#include <stdlib.h>

static void* browserCreate(void* windowPtr, const char* address) {
    NSWindow* window = (NSWindow*)windowPtr;
    if (window == nil || window.contentView == nil) return NULL;
    WKWebViewConfiguration* configuration = [[WKWebViewConfiguration alloc] init];
    configuration.websiteDataStore = [WKWebsiteDataStore defaultDataStore];
    WKWebView* browser = [[WKWebView alloc] initWithFrame:NSZeroRect configuration:configuration];
    [configuration release];
    browser.hidden = YES;
    browser.allowsBackForwardNavigationGestures = YES;
    [window.contentView addSubview:browser];
    NSString* raw = [NSString stringWithUTF8String:address];
    NSURL* url = [NSURL URLWithString:raw];
    if (url != nil && raw.length > 0) [browser loadRequest:[NSURLRequest requestWithURL:url]];
    return browser;
}

static void browserRemove(void* pointer) {
    WKWebView* browser = (WKWebView*)pointer;
    [browser stopLoading];
    [browser removeFromSuperview];
    [browser release];
}

static void browserShow(void* pointer, bool show) {
    ((WKWebView*)pointer).hidden = !show;
}

static void browserFrame(void* pointer, void* windowPtr, double x, double y, double width, double height) {
    NSWindow* window = (NSWindow*)windowPtr;
    NSView* content = window.contentView;
    double bottom = content.bounds.size.height - y - height;
    ((WKWebView*)pointer).frame = NSMakeRect(x, bottom, width, height);
}

static void browserNavigate(void* pointer, const char* address) {
    WKWebView* browser = (WKWebView*)pointer;
    NSURL* url = [NSURL URLWithString:[NSString stringWithUTF8String:address]];
    if (url != nil) [browser loadRequest:[NSURLRequest requestWithURL:url]];
}

static void browserGoBack(void* pointer) { [(WKWebView*)pointer goBack]; }
static void browserGoForward(void* pointer) { [(WKWebView*)pointer goForward]; }
static void browserReload(void* pointer) { [(WKWebView*)pointer reload]; }
static bool browserCanGoBack(void* pointer) { return [(WKWebView*)pointer canGoBack]; }
static bool browserCanGoForward(void* pointer) { return [(WKWebView*)pointer canGoForward]; }
static const char* browserURL(void* pointer) {
    NSString* value = [[((WKWebView*)pointer).URL absoluteString] copy];
    if (value == nil) return strdup("");
    const char* result = strdup(value.UTF8String);
    [value release];
    return result;
}
static const char* browserTitle(void* pointer) {
    NSString* value = [((WKWebView*)pointer).title copy];
    if (value == nil) return strdup("");
    const char* result = strdup(value.UTF8String);
    [value release];
    return result;
}
*/
import "C"

import (
	"errors"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
)

type browserTab struct {
	id      string
	view    unsafe.Pointer
	started bool
}

type browserRect struct{ X, Y, Width, Height float64 }

func (c *Companion) browserOpen(id, address string) error {
	window, ok := c.app.Window.GetByName("muxterm")
	if !ok {
		return errors.New("muxterm window is not open")
	}
	c.mu.Lock()
	if c.browserTabs[id] != nil {
		c.activeBrowser = id
		c.mu.Unlock()
		c.browserLayout()
		return nil
	}
	c.mu.Unlock()
	var pointer unsafe.Pointer
	application.InvokeSync(func() {
		if native := window.NativeWindow(); native != nil {
			value := C.CString(address)
			pointer = C.browserCreate(native, value)
			C.free(unsafe.Pointer(value))
		}
	})
	if pointer == nil {
		return errors.New("could not create native browser view")
	}
	c.mu.Lock()
	if c.browserTabs == nil {
		c.browserTabs = make(map[string]*browserTab)
	}
	c.browserTabs[id] = &browserTab{id: id, view: pointer, started: address != ""}
	c.activeBrowser = id
	c.mu.Unlock()
	c.browserLayout()
	return nil
}

// Callers hold bridgeMu so a native view cannot be removed during this snapshot.
func (c *Companion) browserLayout() {
	window, ok := c.app.Window.GetByName("muxterm")
	if !ok {
		return
	}
	c.mu.Lock()
	rect, visible := c.browserRect, c.browserVisible
	active := c.activeBrowser
	tabs := make([]browserTab, 0, len(c.browserTabs))
	for _, tab := range c.browserTabs {
		tabs = append(tabs, *tab)
	}
	c.mu.Unlock()
	application.InvokeSync(func() {
		for _, tab := range tabs {
			show := visible && tab.started && tab.id == active && rect.Width > 0 && rect.Height > 0
			C.browserShow(tab.view, C.bool(show))
			if show {
				C.browserFrame(tab.view, window.NativeWindow(), C.double(rect.X), C.double(rect.Y), C.double(rect.Width), C.double(rect.Height))
			}
		}
	})
}

func (c *Companion) browserSelect(id string) error {
	c.mu.Lock()
	if c.browserTabs[id] == nil {
		c.mu.Unlock()
		return errors.New("browser tab not found")
	}
	c.activeBrowser = id
	c.mu.Unlock()
	c.browserLayout()
	return nil
}

func (c *Companion) browserClose(id string) {
	c.mu.Lock()
	tab := c.browserTabs[id]
	delete(c.browserTabs, id)
	if c.activeBrowser == id {
		c.activeBrowser = ""
		for next := range c.browserTabs {
			if c.activeBrowser == "" || next < c.activeBrowser {
				c.activeBrowser = next
			}
		}
	}
	c.mu.Unlock()
	if tab != nil {
		application.InvokeSync(func() { C.browserRemove(tab.view) })
	}
	c.browserLayout()
}

// Reset native views when the muxterm page changes: the old page can no longer
// send close messages once its origin stops matching activeMuxtermURL.
func (c *Companion) browserCloseAll() {
	c.mu.Lock()
	tabs := make([]browserTab, 0, len(c.browserTabs))
	for _, tab := range c.browserTabs {
		tabs = append(tabs, *tab)
	}
	c.browserTabs = nil
	c.activeBrowser = ""
	c.browserRect, c.browserVisible = browserRect{}, false
	c.mu.Unlock()
	if len(tabs) > 0 {
		application.InvokeSync(func() {
			for _, tab := range tabs {
				C.browserRemove(tab.view)
			}
		})
	}
}

func (c *Companion) browserAction(id string, action string, address string) error {
	c.mu.Lock()
	tab := c.browserTabs[id]
	c.mu.Unlock()
	if tab == nil {
		return errors.New("browser tab not found")
	}
	if action == "navigate" {
		c.mu.Lock()
		tab.started = true
		c.mu.Unlock()
		defer c.browserLayout()
	}
	application.InvokeSync(func() {
		switch action {
		case "navigate":
			value := C.CString(address)
			C.browserNavigate(tab.view, value)
			C.free(unsafe.Pointer(value))
		case "back":
			C.browserGoBack(tab.view)
		case "forward":
			C.browserGoForward(tab.view)
		case "reload":
			C.browserReload(tab.view)
		}
	})
	return nil
}

type browserTabState struct {
	ID           string `json:"id"`
	URL          string `json:"url"`
	Title        string `json:"title"`
	CanGoBack    bool   `json:"canGoBack"`
	CanGoForward bool   `json:"canGoForward"`
}

func (c *Companion) browserState() (string, []browserTabState) {
	c.mu.Lock()
	active := c.activeBrowser
	tabs := make([]browserTab, 0, len(c.browserTabs))
	for _, tab := range c.browserTabs {
		tabs = append(tabs, *tab)
	}
	c.mu.Unlock()
	states := make([]browserTabState, 0, len(tabs))
	application.InvokeSync(func() {
		for _, tab := range tabs {
			urlValue, titleValue := C.browserURL(tab.view), C.browserTitle(tab.view)
			states = append(states, browserTabState{ID: tab.id, URL: C.GoString(urlValue), Title: C.GoString(titleValue), CanGoBack: bool(C.browserCanGoBack(tab.view)), CanGoForward: bool(C.browserCanGoForward(tab.view))})
			C.free(unsafe.Pointer(urlValue))
			C.free(unsafe.Pointer(titleValue))
		}
	})
	return active, states
}
