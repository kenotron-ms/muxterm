//go:build !darwin

package main

import (
	"os"
	"os/exec"
)

func promptQuitPreference() (bool, bool)    { return false, true }
func localSessiondAlive() bool              { return false }
func stopOwnedSessiond()                    {}
func configureLocalServerProcess(*exec.Cmd) {}
func terminateLocalServerProcess(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = cmd.Process.Signal(os.Interrupt)
	}
}
func forceStopLocalServerProcess(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}
