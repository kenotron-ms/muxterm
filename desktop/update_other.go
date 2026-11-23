//go:build !darwin

package main

import "context"

func (c *Companion) initMacUpdater() error                { return nil }
func (c *Companion) runMacUpdate(context.Context, string) {}
func (c *Companion) runMacAutomaticUpdates()              {}
func (c *Companion) macAutoEligible() (bool, string) {
	return false, "Automatic Mac updates require a signed Mac app."
}
