//go:build integration_verification && linux

package main

// This observer is compiled only into explicitly tagged integration candidates,
// never normal builds or release assets. SIGUSR1 records a private goroutine
// profile without closing browser connections, unlike a fatal SIGQUIT dump.
import (
	"os"
	"os/signal"
	"path/filepath"
	"runtime/pprof"
	"syscall"
)

func init() {
	target := os.Getenv("MUXTERM_VERIFICATION_GOROUTINES")
	if !filepath.IsAbs(target) {
		return
	}
	requests := make(chan os.Signal, 1)
	signal.Notify(requests, syscall.SIGUSR1)
	go func() {
		for range requests {
			temporary := target + ".tmp"
			file, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
			if err != nil {
				continue
			}
			writeErr := pprof.Lookup("goroutine").WriteTo(file, 2)
			closeErr := file.Close()
			if writeErr == nil && closeErr == nil {
				_ = os.Rename(temporary, target)
			} else {
				_ = os.Remove(temporary)
			}
		}
	}()
}
