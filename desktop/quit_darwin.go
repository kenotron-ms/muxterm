//go:build darwin

package main

/*
#cgo LDFLAGS: -framework Cocoa
#include <Cocoa/Cocoa.h>
#include <libproc.h>

static int askQuitPreference(void) {
    // Wails calls ShouldQuit from NSApplication's main-thread terminate hook.
    @autoreleasepool {
        NSAlert *alert = [[NSAlert alloc] init];
        [alert setMessageText:@"Keep terminal sessions running after Quit?"];
        [alert setInformativeText:@"Muxterm's local server will close. Keeping sessions running leaves the terminal daemon active so panes and jobs can continue until you reopen the app."];
        [alert addButtonWithTitle:@"Keep Running"];
        [alert addButtonWithTitle:@"Stop Sessions"];
        [alert addButtonWithTitle:@"Cancel"];
        NSModalResponse response = [alert runModal];
        [alert release];
        if (response == NSAlertFirstButtonReturn) return 1;
        if (response == NSAlertSecondButtonReturn) return 0;
        return -1;
    }
}
*/
import "C"

import (
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

func promptQuitPreference() (keep, chosen bool) {
	switch C.askQuitPreference() {
	case 1:
		return true, true
	case 0:
		return false, true
	default:
		return false, false
	}
}

func localSessionSocket() string {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(configDir, "muxterm-desktop", "local", "runtime", "muxterm", "sessiond.sock")
}

func localSessiondAlive() bool {
	socket := localSessionSocket()
	if socket == "" {
		return false
	}
	conn, err := net.DialTimeout("unix", socket, 150*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// Stop only the daemon answering this app's private socket, and only when its
// executable is the muxterm-server bundled beside this running Mac app.
func stopOwnedSessiond() {
	socket := localSessionSocket()
	if socket == "" {
		return
	}
	conn, err := net.DialTimeout("unix", socket, 150*time.Millisecond)
	if err != nil {
		return
	}
	defer conn.Close()
	unixConn, ok := conn.(*net.UnixConn)
	if !ok {
		return
	}
	raw, err := unixConn.SyscallConn()
	if err != nil {
		return
	}
	var pid int
	var socketErr error
	err = raw.Control(func(fd uintptr) {
		pid, socketErr = unix.GetsockoptInt(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERPID)
	})
	if err != nil || socketErr != nil || pid <= 0 {
		return
	}

	executable, err := os.Executable()
	if err != nil {
		return
	}
	want, err := filepath.EvalSymlinks(filepath.Join(filepath.Dir(executable), "muxterm-server"))
	if err != nil {
		return
	}
	path := make([]byte, 4096)
	if C.proc_pidpath(C.int(pid), unsafe.Pointer(&path[0]), C.uint32_t(len(path))) <= 0 {
		return
	}
	end := 0
	for end < len(path) && path[end] != 0 {
		end++
	}
	got, err := filepath.EvalSymlinks(string(path[:end]))
	if err != nil || got != want {
		log.Printf("leaving local sessiond running: executable does not match this Mac app")
		return
	}
	if err := syscall.Kill(pid, syscall.SIGTERM); err != nil && err != syscall.ESRCH {
		log.Printf("could not stop local sessiond: %v", err)
	}
}

func configureLocalServerProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func terminateLocalServerProcess(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
	}
}

func forceStopLocalServerProcess(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
}
