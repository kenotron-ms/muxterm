//go:build !darwin

package main

import "errors"

type browserRect struct{ X, Y, Width, Height float64 }
type browserTab struct{}
type browserTabState struct {
	ID           int    `json:"id"`
	URL          string `json:"url"`
	Title        string `json:"title"`
	CanGoBack    bool   `json:"canGoBack"`
	CanGoForward bool   `json:"canGoForward"`
}

func (c *Companion) browserOpen(string) (int, error) {
	return 0, errors.New("native browser view requires macOS")
}
func (c *Companion) browserLayout(browserRect, bool) {}
func (c *Companion) browserSelect(int) error         { return errors.New("native browser view requires macOS") }
func (c *Companion) browserClose(int)                {}
func (c *Companion) browserAction(int, string, string) error {
	return errors.New("native browser view requires macOS")
}
func (c *Companion) browserState() (int, []browserTabState) { return 0, nil }
func (c *Companion) evalMuxtermJS(string)                   {}
