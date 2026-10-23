//go:build !darwin

package main

import "errors"

type browserRect struct{ X, Y, Width, Height float64 }
type browserTab struct{}
type browserTabState struct {
	ID           string `json:"id"`
	URL          string `json:"url"`
	Title        string `json:"title"`
	CanGoBack    bool   `json:"canGoBack"`
	CanGoForward bool   `json:"canGoForward"`
}

func (c *Companion) browserOpen(string, string) error {
	return errors.New("native browser view requires macOS")
}
func (c *Companion) browserLayout(browserRect, bool) {}
func (c *Companion) browserSelect(string) error {
	return errors.New("native browser view requires macOS")
}
func (c *Companion) browserClose(string) {}
func (c *Companion) browserAction(string, string, string) error {
	return errors.New("native browser view requires macOS")
}
func (c *Companion) browserState() (string, []browserTabState) { return "", nil }
