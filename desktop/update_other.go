//go:build !darwin

package main

func (c *Companion) initMacUpdater() error { return nil }
func (c *Companion) runMacUpdate(string)   {}
