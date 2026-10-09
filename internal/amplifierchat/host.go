// Package amplifierchat runs the Python Amplifier chat adapter over NDJSON.
package amplifierchat

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

const DefaultReadyTimeout = 90 * time.Second
const EvError = "error"
const EvSidecarUncertain = "sidecar_uncertain"
const CodeSidecarExit = "sidecar_exit"

type Event struct {
	Ev      string          `json:"ev"`
	Code    string          `json:"code"`
	Message string          `json:"message"`
	ReqID   string          `json:"req_id"`
	Raw     json.RawMessage `json:"-"`
}
type reply struct {
	raw json.RawMessage
	err error
}
type Host struct {
	mu          sync.Mutex
	writeMu     sync.Mutex
	restartMu   sync.Mutex
	cmd         *exec.Cmd
	mcpBinary   string
	stdin       *os.File
	stdout      *os.File
	stderr      *os.File
	done        chan struct{}
	ready       chan struct{}
	readyErr    error
	readyOnce   sync.Once
	closed      bool
	stopping    bool
	pending     map[string]chan reply
	subscribers map[chan Event]struct{}
	sequence    uint64
}
type Subscription struct {
	host *Host
	ch   chan Event
}

func (s *Subscription) C() <-chan Event { return s.ch }
func (s *Subscription) Close() {
	s.host.mu.Lock()
	delete(s.host.subscribers, s.ch)
	s.host.mu.Unlock()
}

func CLIExecutable() (string, error) {
	if name, err := exec.LookPath("amplifier"); err == nil {
		return name, nil
	}
	home, err := os.UserHomeDir()
	if err == nil {
		name := filepath.Join(home, ".local", "bin", "amplifier")
		if info, err := os.Stat(name); err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0111 != 0 {
			return name, nil
		}
	}
	return "", errors.New("Amplifier CLI is not installed")
}

func ResolveInterpreter() (string, error) {
	if name := os.Getenv("MUXTERM_AMPLIFIER_PYTHON"); name != "" {
		return exec.LookPath(name)
	}
	if amp, err := CLIExecutable(); err == nil {
		if real, e := filepath.EvalSymlinks(amp); e == nil {
			amp = real
		}
		if f, e := os.Open(amp); e == nil {
			head := make([]byte, 4096)
			n, _ := f.Read(head)
			_ = f.Close()
			first, _, _ := strings.Cut(string(head[:n]), "\n")
			if strings.HasPrefix(first, "#!") {
				parts := strings.Fields(strings.TrimPrefix(first, "#!"))
				if len(parts) > 0 {
					if p, e := exec.LookPath(parts[0]); e == nil {
						return p, nil
					}
				}
			}
		}
	}
	return exec.LookPath("python3")
}
func CheckAmplifierCLI(ctx context.Context) error {
	binary, err := CLIExecutable()
	if err != nil {
		return err
	}
	// --version bypasses Amplifier's shared-venv guard. The read-only provider
	// listing exercises the same environment check used by actual chat runs.
	probe := exec.CommandContext(ctx, binary, "provider", "list")
	probe.Stdout = io.Discard
	probe.Stderr = io.Discard
	if probe.Run() != nil {
		return errors.New("Amplifier executable is unavailable for the selected Amplifier home and tool environment")
	}
	python, err := ResolveInterpreter()
	if err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, python, "-c", "import amplifier_app_cli")
	if err := cmd.Run(); err != nil {
		return errors.New("Amplifier's selected Python environment is missing amplifier-app-cli")
	}
	return nil
}
func New() *Host {
	return &Host{ready: make(chan struct{}), done: make(chan struct{}), pending: make(map[string]chan reply), subscribers: make(map[chan Event]struct{})}
}
func (h *Host) Start(mcpBinary string) error {
	python, err := ResolveInterpreter()
	if err != nil {
		return err
	}
	script, err := extractSidecar()
	if err != nil {
		return err
	}
	cwd, err := os.Getwd()
	if err != nil {
		return err
	}
	cmd := exec.Command(python, script, "--session-id", fmt.Sprintf("muxterm-sdk-host-%d", time.Now().UnixNano()), "--cwd", cwd)
	cmd.Dir = cwd
	env := make([]string, 0, len(os.Environ())+3)
	for _, item := range os.Environ() {
		key, _, _ := strings.Cut(item, "=")
		if strings.HasPrefix(key, "MUXTERM_LANE_") || strings.HasPrefix(key, "MUXTERM_ROOT_") {
			continue
		}
		env = append(env, item)
	}
	cmd.Env = append(env, "PYTHONUNBUFFERED=1", "PYTHONIOENCODING=utf-8", "MUXTERM_CHAT_MCP_BIN="+mcpBinary)
	setPdeathsig(cmd)
	stdinR, stdinW, err := os.Pipe()
	if err != nil {
		return err
	}
	stdoutR, stdoutW, err := os.Pipe()
	if err != nil {
		_ = stdinR.Close()
		_ = stdinW.Close()
		return err
	}
	stderrR, stderrW, err := os.Pipe()
	if err != nil {
		_ = stdinR.Close()
		_ = stdinW.Close()
		_ = stdoutR.Close()
		_ = stdoutW.Close()
		return err
	}
	cmd.Stdin = stdinR
	cmd.Stdout = stdoutW
	cmd.Stderr = stderrW
	if err := cmd.Start(); err != nil {
		for _, f := range []*os.File{stdinR, stdinW, stdoutR, stdoutW, stderrR, stderrW} {
			_ = f.Close()
		}
		return err
	}
	_ = stdinR.Close()
	_ = stdoutW.Close()
	_ = stderrW.Close()
	h.mu.Lock()
	h.ready = make(chan struct{})
	h.readyOnce = sync.Once{}
	h.readyErr = nil
	h.done = make(chan struct{})
	h.closed = false
	h.mcpBinary = mcpBinary
	h.cmd = cmd
	h.stdin = stdinW
	h.stdout = stdoutR
	h.stderr = stderrR
	h.mu.Unlock()
	go h.readStdout(stdoutR)
	go h.readStderr(stderrR)
	go h.wait(cmd, h.done)
	return nil
}
func (h *Host) WaitReady(ctx context.Context) error {
	select {
	case <-h.ready:
		h.mu.Lock()
		defer h.mu.Unlock()
		return h.readyErr
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (h *Host) markReady(err error) {
	h.readyOnce.Do(func() { h.mu.Lock(); h.readyErr = err; h.mu.Unlock(); close(h.ready) })
}
func (h *Host) Subscribe(depth int) *Subscription {
	if depth < 1 {
		depth = 1
	}
	ch := make(chan Event, depth)
	h.mu.Lock()
	h.subscribers[ch] = struct{}{}
	h.mu.Unlock()
	return &Subscription{host: h, ch: ch}
}
func (h *Host) publish(ev Event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subscribers {
		select {
		case ch <- ev:
		default:
		}
	}
}
func (h *Host) readStdout(f *os.File) {
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64*1024), 16<<20)
	for scanner.Scan() {
		raw := append([]byte(nil), scanner.Bytes()...)
		var ev Event
		if json.Unmarshal(raw, &ev) != nil {
			continue
		}
		ev.Raw = raw
		if ev.Ev == "ready" {
			h.markReady(nil)
		}
		if ev.ReqID != "" {
			h.mu.Lock()
			ch := h.pending[ev.ReqID]
			delete(h.pending, ev.ReqID)
			h.mu.Unlock()
			if ch != nil {
				if ev.Ev == EvError {
					ch <- reply{err: errors.New(ev.Message)}
				} else {
					ch <- reply{raw: raw}
				}
				continue
			}
		}
		h.publish(ev)
	}
	if err := scanner.Err(); err != nil && !errors.Is(err, os.ErrClosed) {
		log.Printf("amplifier chat output: %v", err)
	}
}
func (h *Host) readStderr(f *os.File) {
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 16*1024), 1<<20)
	for scanner.Scan() {
		log.Printf("amplifier chat: %s", scanner.Text())
	}
}
func (h *Host) wait(cmd *exec.Cmd, done chan struct{}) {
	err := cmd.Wait()
	h.mu.Lock()
	h.closed = true
	pending := h.pending
	h.pending = make(map[string]chan reply)
	h.mu.Unlock()
	h.markReady(fmt.Errorf("Amplifier chat sidecar exited: %v", err))
	for _, ch := range pending {
		ch <- reply{err: errors.New("Amplifier chat sidecar exited before replying")}
	}
	h.publish(Event{Ev: EvSidecarUncertain, Code: CodeSidecarExit})
	_ = h.stdin.Close()
	_ = h.stdout.Close()
	_ = h.stderr.Close()
	close(done)
}
func (h *Host) ensureRunning(ctx context.Context) error {
	h.restartMu.Lock()
	defer h.restartMu.Unlock()
	h.mu.Lock()
	closed, stopping, done, binary := h.closed, h.stopping, h.done, h.mcpBinary
	h.mu.Unlock()
	if stopping {
		return errors.New("Amplifier chat host is shutting down")
	}
	if !closed {
		return nil
	}
	select {
	case <-done:
	case <-ctx.Done():
		return ctx.Err()
	}
	if err := h.Start(binary); err != nil {
		return err
	}
	readyCtx, cancel := context.WithTimeout(ctx, DefaultReadyTimeout)
	defer cancel()
	return h.WaitReady(readyCtx)
}
func (h *Host) SDKCommand(ctx context.Context, command json.RawMessage) (json.RawMessage, error) {
	if err := h.ensureRunning(ctx); err != nil {
		return nil, err
	}
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return nil, errors.New("Amplifier chat sidecar is stopped")
	}
	h.sequence++
	id := fmt.Sprintf("%d", h.sequence)
	ch := make(chan reply, 1)
	h.pending[id] = ch
	h.mu.Unlock()
	line, err := json.Marshal(struct {
		Op      string          `json:"op"`
		ReqID   string          `json:"req_id"`
		Command json.RawMessage `json:"command"`
	}{Op: "sdk", ReqID: id, Command: command})
	if err != nil {
		return nil, err
	}
	line = append(line, '\n')
	h.writeMu.Lock()
	_, err = h.stdin.Write(line)
	h.writeMu.Unlock()
	if err != nil {
		h.mu.Lock()
		delete(h.pending, id)
		h.mu.Unlock()
		return nil, err
	}
	select {
	case result := <-ch:
		if result.err != nil {
			return nil, result.err
		}
		var frame struct {
			Ev     string          `json:"ev"`
			Result json.RawMessage `json:"result"`
		}
		if err := json.Unmarshal(result.raw, &frame); err != nil {
			return nil, err
		}
		if frame.Ev != "sdk_reply" {
			return nil, fmt.Errorf("unexpected Amplifier reply %q", frame.Ev)
		}
		return frame.Result, nil
	case <-ctx.Done():
		h.mu.Lock()
		delete(h.pending, id)
		h.mu.Unlock()
		return nil, ctx.Err()
	}
}
func (h *Host) Close() error {
	h.mu.Lock()
	h.stopping = true
	cmd := h.cmd
	done := h.done
	h.mu.Unlock()
	if cmd == nil {
		return nil
	}
	_ = cmd.Process.Signal(syscall.SIGTERM)
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		_ = cmd.Process.Kill()
		<-done
	}
	return nil
}
