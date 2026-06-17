// spike/pty-handoff — PTY master FD handoff between two processes via SCM_RIGHTS
//
// Proves that a live PTY master can be transferred from one process to another
// while the shell stays alive — no SIGHUP, no interruption.
//
// Usage:  go run .   (runs the full handoff automatically)
package main

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"syscall"
	"time"
	"unsafe"

	"github.com/creack/pty"
)

const socketPath = "/tmp/pty-handoff-spike.sock"

type Metadata struct {
	PID  int    `json:"pid"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "_receive" {
		runReceiver()
		return
	}
	runSender()
}

// ─── Sender ────────────────────────────────────────────────────────────────────

func runSender() {
	fmt.Println("[sender] Creating PTY + /bin/bash...")

	cmd := exec.Command("/bin/bash", "--norc", "--noprofile")
	cmd.Env = []string{
		"TERM=xterm-256color",
		"PS1=$ ",
		"HOME=" + os.Getenv("HOME"),
	}

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: 24, Cols: 80})
	if err != nil {
		fatalf("[sender] pty.Start: %v", err)
	}

	pid := cmd.Process.Pid
	fmt.Printf("[sender] Shell PID=%d  PTY fd=%d\n", pid, int(ptmx.Fd()))
	time.Sleep(100 * time.Millisecond)

	// Start receiver subprocess (re-exec this binary)
	os.Remove(socketPath)
	recv := exec.Command(os.Args[0], "_receive")
	recv.Stdout = os.Stdout
	recv.Stderr = os.Stderr
	recv.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} // own process group
	if err := recv.Start(); err != nil {
		fatalf("[sender] start receiver: %v", err)
	}

	// Listen on Unix socket, wait for receiver
	ln, err := net.Listen("unix", socketPath)
	if err != nil {
		fatalf("[sender] listen: %v", err)
	}
	fmt.Println("[sender] Waiting for receiver to connect on", socketPath)

	conn, err := ln.Accept()
	if err != nil {
		fatalf("[sender] accept: %v", err)
	}
	ln.Close()

	// ── Send PTY FD + metadata via SCM_RIGHTS using WriteMsgUnix ─────────────
	meta, _ := json.Marshal(Metadata{PID: pid, Cols: 80, Rows: 24})

	// Get raw fd inside Control — valid only during callback, but ptmx stays
	// open until we call ptmx.Close() below, so the fd number is stable.
	var rawFD int
	ptmxSC, _ := ptmx.SyscallConn()
	ptmxSC.Control(func(fd uintptr) { rawFD = int(fd) })

	oob := syscall.UnixRights(rawFD)
	uc := conn.(*net.UnixConn)
	if _, _, err := uc.WriteMsgUnix(meta, oob, nil); err != nil {
		fatalf("[sender] WriteMsgUnix: %v", err)
	}

	fmt.Println("[sender] ✓ PTY master FD sent — closing own reference and exiting")
	conn.Close()
	// Closing sender's copy drops kernel ref count to 1 (receiver holds it).
	// No SIGHUP because receiver still has the master open.
	ptmx.Close()
	fmt.Printf("[sender] Done. Shell PID %d now lives in receiver.\n", pid)
	os.Exit(0)
}

// ─── Receiver ─────────────────────────────────────────────────────────────────

func runReceiver() {
	time.Sleep(80 * time.Millisecond) // let sender create the socket

	fmt.Println("[receiver] Connecting to sender...")
	var conn net.Conn
	var err error
	for i := 0; i < 30; i++ {
		conn, err = net.Dial("unix", socketPath)
		if err == nil {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if err != nil {
		fatalf("[receiver] dial: %v", err)
	}
	defer conn.Close()

	// ── Receive FD + metadata via ReadMsgUnix ─────────────────────────────────
	data := make([]byte, 512)
	// CmsgSpace for one int-sized FD
	oob := make([]byte, syscall.CmsgSpace(int(unsafe.Sizeof(int32(0)))))

	uc := conn.(*net.UnixConn)
	n, oobn, _, _, err := uc.ReadMsgUnix(data, oob)
	if err != nil {
		fatalf("[receiver] ReadMsgUnix: %v", err)
	}

	var meta Metadata
	json.Unmarshal(data[:n], &meta)
	fmt.Printf("[receiver] Metadata: PID=%d Cols=%d Rows=%d\n", meta.PID, meta.Cols, meta.Rows)

	// Parse control message to extract FD
	scms, err := syscall.ParseSocketControlMessage(oob[:oobn])
	if err != nil || len(scms) == 0 {
		fatalf("[receiver] ParseSocketControlMessage: %v (oobn=%d)", err, oobn)
	}
	fds, err := syscall.ParseUnixRights(&scms[0])
	if err != nil || len(fds) == 0 {
		fatalf("[receiver] ParseUnixRights: %v", err)
	}
	fmt.Printf("[receiver] Received PTY master as local fd %d\n", fds[0])

	ptmx := os.NewFile(uintptr(fds[0]), "pty-master-recv")
	if ptmx == nil {
		fatalf("[receiver] os.NewFile returned nil")
	}

	// ── Collect PTY output ────────────────────────────────────────────────────
	// PTY is a file, not a socket — SetReadDeadline is a no-op. Close ptmx
	// explicitly to unblock the goroutine after the probe window.
	outputCh := make(chan string, 128)
	go func() {
		buf := make([]byte, 4096)
		for {
			nr, err := ptmx.Read(buf)
			if nr > 0 {
				outputCh <- string(buf[:nr])
			}
			if err != nil {
				close(outputCh)
				return
			}
		}
	}()

	time.Sleep(150 * time.Millisecond) // drain initial bash prompt

	// ── Probe the shell ───────────────────────────────────────────────────────
	fmt.Println("[receiver] Sending probe commands to transferred PTY...")
	ptmx.Write([]byte("echo HANDOFF_MARKER_$(echo alive)\n"))
	time.Sleep(350 * time.Millisecond)
	ptmx.Write([]byte("echo SHELL_PID=$$\n"))
	time.Sleep(350 * time.Millisecond)

	// Close ptmx → unblocks goroutine → closes outputCh → range exits
	ptmx.Close()

	// ── Collect + print output ────────────────────────────────────────────────
	fmt.Println("\n[receiver] ── PTY output ─────────────────────")
	var all string
	for chunk := range outputCh {
		all += chunk
		fmt.Print(chunk)
	}
	fmt.Println("\n[receiver] ── end ────────────────────────────")

	// ── Verdict ───────────────────────────────────────────────────────────────
	marker  := contains(all, "HANDOFF_MARKER_alive")
	shellPID := contains(all, "SHELL_PID=")

	fmt.Println()
	if marker {
		fmt.Printf("PASS  HANDOFF_MARKER_alive seen — shell PID %d survived the process boundary\n", meta.PID)
	} else {
		fmt.Printf("FAIL  HANDOFF_MARKER_alive not seen  (got %d bytes)\n", len(all))
	}
	if shellPID {
		fmt.Println("PASS  SHELL_PID echo worked — PTY fully interactive after handoff")
	}

	if marker && shellPID {
		fmt.Println("\nSPIKE RESULT: SCM_RIGHTS PTY handoff works.")
		fmt.Println("Old sessiond can pass PTY masters to new sessiond; shells never see a SIGHUP.")
		os.Exit(0)
	}
	os.Exit(1)
}

func contains(s, sub string) bool {
	if len(sub) == 0 || len(s) < len(sub) {
		return false
	}
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

func fatalf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}
