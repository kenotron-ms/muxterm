//go:build !linux

package amplifierchat

import "os/exec"

func setPdeathsig(*exec.Cmd) {}
