//go:build !darwin && !linux

package sessiond

import (
	"errors"
	"os"
)

var errForegroundPGRPUnsupported = errors.New("sessiond: foreground process-group inspection unsupported")

func foregroundPGRPSupported() bool {
	return false
}

func inspectProcessGroup(pid int) (int, error) {
	return 0, errForegroundPGRPUnsupported
}

func inspectForegroundPGRP(ptmx *os.File) (int, error) {
	return 0, errForegroundPGRPUnsupported
}
