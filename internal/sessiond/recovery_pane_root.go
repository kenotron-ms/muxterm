package sessiond

import (
	"errors"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/creack/pty"
)

// PaneLaunchOptions is the exact structured command, working directory, and
// environment for one terminal root process. Env nil inherits the daemon
// environment; a nonnil Env is the complete caller-provided environment.
type PaneLaunchOptions struct {
	Argv []string
	CWD  string
	Env  []string
}

// PaneRootIdentity identifies one immutable terminal-root process generation.
type PaneRootIdentity struct {
	Generation uint64
	PID        int
	StartedAt  time.Time
}

// PaneCallbacks receives effects emitted by a terminal root process.
//
// NON-REENTRANT DELIVERY CONTRACT: every callback runs synchronously while the
// owning Pane holds its generation delivery boundary. A callback MUST NOT
// synchronously call Write, Resize, Close, ReplaceRoot, or otherwise reenter
// lifecycle or I/O on that same Pane; doing so would wait on the boundary that
// is invoking it. Callbacks that need same-pane work must enqueue or otherwise
// defer that work until after the callback returns.
type PaneCallbacks struct {
	OnData   func(localID int, data []byte)
	OnExit   func(localID int, root PaneRootIdentity, exitCode int, runtimeMilliseconds int64)
	OnPrompt func(localID int, msg *Message)
	OnCWD    func(localID int, root PaneRootIdentity, cwd RecoveryWorkingDirectory)
}

// PaneForegroundProcessIdentity retains the process identity pin for a root's
// foreground process until Close releases it.
type PaneForegroundProcessIdentity struct {
	Root    PaneRootIdentity
	Process recoveryProcessIdentity
}

// Close releases the recovery process identity's pinned executable descriptor.
func (identity PaneForegroundProcessIdentity) Close() error {
	return identity.Process.Close()
}

var (
	errInvalidPaneLaunchOptions    = errors.New("sessiond: invalid pane launch options")
	errPaneRootGenerationExhausted = errors.New("sessiond: pane root generation exhausted")
	errPaneRootStartFailed         = errors.New("sessiond: pane root start failed")
	errPaneRootReplacementFailed   = errors.New("sessiond: pane root replacement failed")
)

// validatedPaneLaunchOptions is an immutable, copied launch request retained by
// a pane root. Its fields must only be passed to exec as structured values.
type validatedPaneLaunchOptions struct {
	argv []string
	cwd  string
	env  []string
}

// validatePaneLaunchOptions validates and deep-copies one structured launch
// request. Its errors intentionally contain no caller-controlled values.
func validatePaneLaunchOptions(options PaneLaunchOptions) (validatedPaneLaunchOptions, error) {
	if len(options.Argv) == 0 || options.Argv[0] == "" {
		return validatedPaneLaunchOptions{}, errInvalidPaneLaunchOptions
	}
	for _, argument := range options.Argv {
		if strings.IndexByte(argument, '\x00') >= 0 {
			return validatedPaneLaunchOptions{}, errInvalidPaneLaunchOptions
		}
	}
	if options.CWD == "" ||
		strings.IndexByte(options.CWD, '\x00') >= 0 ||
		!filepath.IsAbs(options.CWD) ||
		filepath.Clean(options.CWD) != options.CWD {
		return validatedPaneLaunchOptions{}, errInvalidPaneLaunchOptions
	}

	argv := make([]string, len(options.Argv))
	copy(argv, options.Argv)

	var env []string
	if options.Env != nil {
		env = make([]string, len(options.Env))
		names := make(map[string]struct{}, len(options.Env))
		for index, entry := range options.Env {
			separator := strings.IndexByte(entry, '=')
			if strings.IndexByte(entry, '\x00') >= 0 || separator <= 0 {
				return validatedPaneLaunchOptions{}, errInvalidPaneLaunchOptions
			}
			name := entry[:separator]
			if _, duplicate := names[name]; duplicate {
				return validatedPaneLaunchOptions{}, errInvalidPaneLaunchOptions
			}
			names[name] = struct{}{}
			env[index] = entry
		}
	}

	return validatedPaneLaunchOptions{
		argv: argv,
		cwd:  options.CWD,
		env:  env,
	}, nil
}

// shellPrivateFilter and filterResult reserve root-local storage for the
// authenticated private shell marker filter. This task deliberately adds no
// parsing behavior or call site.
type shellPrivateFilter struct {
	token   []byte
	pending []byte
}

type filterResult struct {
	data        []byte
	cwdRefresh  bool
	conflicting bool
}

// paneRoot owns exactly one terminal process generation. Fields above mu are
// fixed before publication and never reassigned. Fields below mu are root-local
// mutable state and require mu, except the Once values that serialize cleanup
// and read-loop startup.
type paneRoot struct {
	identity        PaneRootIdentity
	launch          validatedPaneLaunchOptions
	cmd             *exec.Cmd
	ptmx            *os.File
	processBoundary recoveryProcessBoundaryIdentity
	lifecycleSource shellLifecycleSource
	lifecycleToken  string
	cleanup         func()

	mu                sync.Mutex
	lifecycleParser   shellLifecycleParser
	lifecycle         lifecycleEvidence
	lifecycleParsing  bool
	lifecycleRevision uint64
	cwdFilter         shellPrivateFilter
	lastCWD           RecoveryWorkingDirectory
	cwdObserved       bool
	cwdConflicting    bool
	retired           bool
	exited            bool
	readStarted       bool

	cleanupOnce sync.Once
	readOnce    sync.Once
}

func clonePaneLaunchStrings(values []string) []string {
	if values == nil {
		return nil
	}
	cloned := make([]string, len(values))
	copy(cloned, values)
	return cloned
}

func startPaneRoot(
	generation uint64,
	launch validatedPaneLaunchOptions,
	source shellLifecycleSource,
	token string,
	cleanup func(),
	cols, rows int,
) (*paneRoot, error) {
	frozenLaunch := validatedPaneLaunchOptions{
		argv: clonePaneLaunchStrings(launch.argv),
		cwd:  launch.cwd,
		env:  clonePaneLaunchStrings(launch.env),
	}
	cmd := exec.Command(frozenLaunch.argv[0], frozenLaunch.argv[1:]...)
	cmd.Dir = frozenLaunch.cwd
	cmd.Env = clonePaneLaunchStrings(frozenLaunch.env)

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)})
	if err != nil {
		if cleanup != nil {
			cleanup()
		}
		return nil, err
	}
	startedAt := time.Now()
	processBoundary, _ := inspectRecoveryProcessBoundary(cmd.Process.Pid)

	return &paneRoot{
		identity: PaneRootIdentity{
			Generation: generation,
			PID:        cmd.Process.Pid,
			StartedAt:  startedAt,
		},
		launch:            frozenLaunch,
		cmd:               cmd,
		ptmx:              ptmx,
		processBoundary:   processBoundary,
		lifecycleSource:   source,
		lifecycleToken:    token,
		cleanup:           cleanup,
		lifecycleParser:   newShellLifecycleParser(token),
		lifecycleRevision: 1,
		cwdFilter: shellPrivateFilter{
			token: []byte(token),
		},
	}, nil
}

func (root *paneRoot) retire() {
	if root == nil {
		return
	}
	root.mu.Lock()
	root.retired = true
	root.mu.Unlock()
}

// replacementLive checks whether a root can still be replaced. When retire is
// true, it also retires the live root before releasing root.mu, so final
// publication cannot race an observed exit or another retirement.
func (root *paneRoot) replacementLive(retire bool) bool {
	if root == nil {
		return false
	}
	root.mu.Lock()
	defer root.mu.Unlock()
	if root.retired || root.exited {
		return false
	}
	if retire {
		root.retired = true
	}
	return true
}

func (root *paneRoot) markExited() {
	if root == nil {
		return
	}
	root.mu.Lock()
	if !root.exited {
		root.exited = true
		root.lifecycleRevision++
	}
	root.mu.Unlock()
}

func (root *paneRoot) cleanupRoot() {
	if root == nil {
		return
	}
	root.cleanupOnce.Do(func() {
		if root.cleanup != nil {
			root.cleanup()
		}
	})
}

// stop terminates a retired root. A root whose read loop started is reaped only
// by that loop; an unpublished or deliberately unstarted root is reaped here.
func (root *paneRoot) stop() {
	if root == nil {
		return
	}
	root.retire()
	root.readOnce.Do(func() {})

	root.mu.Lock()
	readStarted := root.readStarted
	root.mu.Unlock()

	if root.cmd != nil && root.cmd.Process != nil {
		_ = root.cmd.Process.Kill()
	}
	if root.ptmx != nil {
		_ = root.ptmx.Close()
	}
	if !readStarted && root.cmd != nil {
		_ = root.cmd.Wait()
		root.markExited()
	}
	root.cleanupRoot()
}

// writeReply writes one VT-emulator response only while this root remains
// unretired. Holding root.mu through the small PTY write makes retirement and
// PTY closure wait for an in-flight response without acquiring Pane.deliveryMu.
func (root *paneRoot) writeReply(data []byte) {
	if root == nil || len(data) == 0 {
		return
	}
	root.mu.Lock()
	defer root.mu.Unlock()
	if root.retired || root.ptmx == nil {
		return
	}
	for len(data) != 0 {
		written, err := root.ptmx.Write(data)
		if err != nil || written <= 0 {
			return
		}
		data = data[written:]
	}
}

var paneRootGeneration atomic.Uint64

// nextPaneRootGeneration allocates a globally unique nonzero root generation.
// Exhaustion is terminal: it never wraps or reuses zero.
func nextPaneRootGeneration() (uint64, error) {
	for {
		current := paneRootGeneration.Load()
		if current == math.MaxUint64 {
			return 0, errPaneRootGenerationExhausted
		}
		next := current + 1
		if paneRootGeneration.CompareAndSwap(current, next) {
			return next, nil
		}
	}
}
