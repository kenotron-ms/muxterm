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

	cleanupOnce sync.Once
	readOnce    sync.Once
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
