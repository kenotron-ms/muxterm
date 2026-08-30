package sessiond

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

const recoveryOwnerOnlyDirectoryMode = 0o700

const recoveryMaximumProcessAncestors = 64

const (
	recoveryMaximumExecutablePathEntries = 64
	recoveryMaximumExecutablePathBytes   = recoveryMaximumExecutablePathEntries * (RecoveryMaxExecutableBytes + 1)
)

// recoveryProcessStartIdentity is an opaque, platform-comparable process start
// value. Linux supplies clock ticks while Darwin supplies its kernel start-time
// representation; neither is ever projected outside daemon authority.
type recoveryProcessStartIdentity struct {
	Value uint64
}

type recoveryFileIdentity struct {
	Device     uint64
	Inode      uint64
	Generation uint64
}

type recoveryExecutableIdentity struct {
	Path  RecoveryExecutable
	Owner uint32
	Mode  uint32
	File  recoveryFileIdentity
	pin   *recoveryExecutablePin
}

// recoveryExecutablePin owns a descriptor for the exact executable object.
// Identity values may be copied: every copy shares this holder, and Close is
// idempotent so a copied identity can never close a reused descriptor.
type recoveryExecutablePin struct {
	mu   sync.Mutex
	file *os.File
}

type recoveryProcessIdentity struct {
	PID              int
	ParentPID        int
	ProcessGroupID   int
	SessionID        int
	UID              uint32
	Start            recoveryProcessStartIdentity
	WorkingDirectory RecoveryWorkingDirectory
	Executable       recoveryExecutableIdentity
}

type recoveryProcessBoundaryIdentity struct {
	PID       int
	ParentPID int
	UID       uint32
	Start     recoveryProcessStartIdentity
}

// Close releases the pinned executable object. Values returned by executable
// resolution own one shared, idempotently-closed pin; callers must keep it open
// for the runtime authority lifetime and close it when that lifetime ends.
func (identity recoveryExecutableIdentity) Close() error {
	if identity.pin == nil {
		return nil
	}
	return identity.pin.close()
}

func (identity recoveryProcessIdentity) Close() error {
	return identity.Executable.Close()
}

func newRecoveryExecutablePin(fd int, path RecoveryExecutable) (*recoveryExecutablePin, error) {
	if fd < 0 {
		return nil, fmt.Errorf("recovery: executable descriptor is invalid")
	}
	file := os.NewFile(uintptr(fd), string(path))
	if file == nil {
		return nil, fmt.Errorf("recovery: retain executable descriptor")
	}
	return &recoveryExecutablePin{file: file}, nil
}

func (pin *recoveryExecutablePin) withDescriptor(operation func(int) error) error {
	if pin == nil {
		return fmt.Errorf("recovery: executable pin is unavailable")
	}
	pin.mu.Lock()
	defer pin.mu.Unlock()
	if pin.file == nil {
		return fmt.Errorf("recovery: executable pin is closed")
	}
	return operation(int(pin.file.Fd()))
}

func (pin *recoveryExecutablePin) close() error {
	if pin == nil {
		return nil
	}
	pin.mu.Lock()
	defer pin.mu.Unlock()
	if pin.file == nil {
		return nil
	}
	err := pin.file.Close()
	pin.file = nil
	return err
}

// RecoveryStateRoot prepares only the owner-safe application intermediates and
// returns the durable recovery root. OpenFileRecoveryStore remains responsible
// for creating the final recovery component.
func RecoveryStateRoot() (string, error) {
	owner, err := recoveryCurrentOwner()
	if err != nil {
		return "", err
	}
	stateHome, err := recoveryStateHome(owner)
	if err != nil {
		return "", err
	}
	root := filepath.Join(stateHome, "muxterm", "recovery")
	if err := validateRecoveryAbsolutePath(root); err != nil {
		return "", err
	}

	if _, err := os.Lstat(root); err == nil {
		if err := validateRecoveryPrivateDirectory(root, owner); err != nil {
			return "", err
		}
		return root, nil
	} else if !os.IsNotExist(err) {
		return "", fmt.Errorf("recovery: inspect durable root: %w", err)
	}

	return root, nil
}

// RecoverySocketPath returns the dedicated recovery socket next to the main
// session socket. It performs only path validation: binding and stale cleanup
// belong to the later lock-owning production daemon.
func RecoverySocketPath(sessionSocket string) (string, error) {
	if err := validateRecoverySocketPath(sessionSocket); err != nil {
		return "", fmt.Errorf("recovery: invalid session socket path: %w", err)
	}
	socket := filepath.Join(filepath.Dir(sessionSocket), "recovery.sock")
	if err := validateRecoverySocketPath(socket); err != nil {
		return "", fmt.Errorf("recovery: invalid recovery socket path: %w", err)
	}
	return socket, nil
}

// validateRecoveryDirectory verifies that path is an existing, owner-owned,
// non-symlink directory with no group or world write access. Platform helpers
// use descriptor-relative traversal and inspect the opened final object.
func validateRecoveryDirectory(path string, owner uint32) error {
	if err := validateRecoveryAbsolutePath(path); err != nil {
		return err
	}
	return validateRecoveryDirectoryPlatform(path, owner)
}

// safeRecoveryHome returns the configured home only after validating the final
// opened directory. It intentionally creates nothing and never resolves a
// symlink supplied through HOME.
func safeRecoveryHome() (string, error) {
	owner, err := recoveryCurrentOwner()
	if err != nil {
		return "", err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("recovery: determine home directory: %w", err)
	}
	if err := validateRecoveryDirectory(home, owner); err != nil {
		return "", fmt.Errorf("recovery: unsafe home directory: %w", err)
	}
	return home, nil
}

func recoveryStateHome(owner uint32) (string, error) {
	if stateHome, configured := os.LookupEnv("XDG_STATE_HOME"); configured {
		if stateHome == "" {
			return "", fmt.Errorf("recovery: XDG state home is empty")
		}
		if err := validateRecoveryAbsolutePath(stateHome); err != nil {
			return "", fmt.Errorf("recovery: unsafe XDG state home: %w", err)
		}
		if err := ensureRecoveryDirectoryPath(stateHome, owner); err != nil {
			return "", fmt.Errorf("recovery: prepare XDG state home: %w", err)
		}
		muxterm := filepath.Join(stateHome, "muxterm")
		if err := ensureRecoveryDirectoryPath(muxterm, owner); err != nil {
			return "", fmt.Errorf("recovery: prepare XDG application state: %w", err)
		}
		return stateHome, nil
	}

	home, err := safeRecoveryHome()
	if err != nil {
		return "", err
	}
	local := filepath.Join(home, ".local")
	stateHome := filepath.Join(local, "state")
	muxterm := filepath.Join(stateHome, "muxterm")
	for _, directory := range []string{local, stateHome, muxterm} {
		if err := ensureRecoveryDirectoryPath(directory, owner); err != nil {
			return "", fmt.Errorf("recovery: prepare default application state: %w", err)
		}
	}
	return stateHome, nil
}

func recoveryCurrentOwner() (uint32, error) {
	owner := os.Geteuid()
	if owner < 0 {
		return 0, fmt.Errorf("recovery: effective UID is unavailable")
	}
	return uint32(owner), nil
}

func validateRecoveryAbsolutePath(path string) error {
	if len(path) > RecoveryMaxWorkingDirectoryBytes {
		return fmt.Errorf("recovery: path exceeds %d bytes", RecoveryMaxWorkingDirectoryBytes)
	}
	if path == "" || path == "/" || !filepath.IsAbs(path) || filepath.Clean(path) != path ||
		strings.ContainsRune(path, '\x00') || strings.ContainsRune(path, '\\') {
		return fmt.Errorf("recovery: path is not a non-root clean absolute path")
	}
	return nil
}

func validateRecoverySocketPath(path string) error {
	if err := validateRecoveryAbsolutePath(path); err != nil {
		return err
	}
	if len(path) > recoveryUnixSocketPathMaximum {
		return fmt.Errorf("recovery: Unix socket path exceeds %d bytes", recoveryUnixSocketPathMaximum)
	}
	return nil
}

// recoveryProcessAncestors resolves a process and its complete parent chain in
// bounded order. It obtains two independently stable snapshots per entry so a
// PID reuse, disappearance, or mutable process fact between ancestry steps
// fails closed instead of becoming a synthetic parent edge.
func recoveryProcessAncestors(pid, maximum int) ([]recoveryProcessIdentity, error) {
	if pid <= 0 {
		return nil, fmt.Errorf("recovery: process PID must be positive")
	}
	if maximum <= 0 || maximum > recoveryMaximumProcessAncestors {
		return nil, fmt.Errorf(
			"recovery: process ancestor maximum must be between 1 and %d",
			recoveryMaximumProcessAncestors,
		)
	}

	ancestors := make([]recoveryProcessIdentity, 0, maximum)
	fail := func(err error) ([]recoveryProcessIdentity, error) {
		closeRecoveryProcessIdentities(ancestors)
		return nil, err
	}
	seen := make(map[int]struct{}, maximum)
	currentPID := pid
	var child *recoveryProcessIdentity
	var ownerUID uint32
	for {
		if len(ancestors) == maximum {
			return fail(fmt.Errorf("recovery: process ancestry exceeds maximum"))
		}
		if _, exists := seen[currentPID]; exists {
			return fail(fmt.Errorf("recovery: process ancestry repeats a PID"))
		}

		var boundary recoveryProcessBoundaryIdentity
		if child != nil {
			var err error
			boundary, err = inspectRecoveryProcessBoundary(currentPID)
			if err != nil {
				return fail(err)
			}
			stableBoundary, err := inspectRecoveryProcessBoundary(currentPID)
			if err != nil {
				return fail(err)
			}
			if !sameRecoveryProcessBoundary(boundary, stableBoundary) {
				return fail(fmt.Errorf("recovery: parent process changed during boundary inspection"))
			}
			if boundary.UID != ownerUID {
				recheckedChild, err := inspectRecoveryProcess(child.PID)
				if err != nil {
					return fail(err)
				}
				edgeStable := sameRecoveryProcess(*child, recheckedChild) &&
					recheckedChild.ParentPID == boundary.PID
				_ = recheckedChild.Close()
				if !edgeStable {
					return fail(fmt.Errorf("recovery: process ancestry boundary edge changed"))
				}
				finalBoundary, err := inspectRecoveryProcessBoundary(currentPID)
				if err != nil {
					return fail(err)
				}
				if !sameRecoveryProcessBoundary(boundary, finalBoundary) {
					return fail(fmt.Errorf("recovery: process ancestry boundary changed"))
				}
				if err := revalidateRecoveryProcessAncestry(ancestors, &boundary); err != nil {
					return fail(err)
				}
				return ancestors, nil
			}
		}

		identity, err := inspectRecoveryProcess(currentPID)
		if err != nil {
			return fail(err)
		}
		stable, err := inspectRecoveryProcess(currentPID)
		if err != nil {
			_ = identity.Close()
			return fail(err)
		}
		if !sameRecoveryProcess(identity, stable) {
			_ = identity.Close()
			_ = stable.Close()
			return fail(fmt.Errorf("recovery: process changed during ancestry inspection"))
		}
		_ = stable.Close()
		if child == nil {
			ownerUID = identity.UID
		} else if !recoveryProcessBoundaryMatchesIdentity(boundary, identity) {
			_ = identity.Close()
			return fail(fmt.Errorf("recovery: parent process changed between boundary and full inspection"))
		}

		if child != nil {
			recheckedChild, err := inspectRecoveryProcess(child.PID)
			if err != nil {
				_ = identity.Close()
				return fail(err)
			}
			edgeStable := sameRecoveryProcess(*child, recheckedChild) &&
				recheckedChild.ParentPID == identity.PID
			_ = recheckedChild.Close()
			if !edgeStable {
				_ = identity.Close()
				return fail(fmt.Errorf("recovery: process ancestry edge changed during inspection"))
			}
		}

		seen[currentPID] = struct{}{}
		ancestors = append(ancestors, identity)
		child = &ancestors[len(ancestors)-1]
		switch {
		case identity.ParentPID < 0:
			return fail(fmt.Errorf("recovery: process has an invalid parent PID"))
		case identity.ParentPID == 0:
			if identity.PID != 1 {
				return fail(fmt.Errorf("recovery: process ancestry ended before init"))
			}
			if err := revalidateRecoveryProcessAncestry(ancestors, nil); err != nil {
				return fail(err)
			}
			return ancestors, nil
		default:
			currentPID = identity.ParentPID
		}
	}
}

func revalidateRecoveryProcessAncestry(
	ancestors []recoveryProcessIdentity,
	boundary *recoveryProcessBoundaryIdentity,
) error {
	for index := range ancestors {
		current, err := inspectRecoveryProcess(ancestors[index].PID)
		if err != nil {
			return err
		}
		same := sameRecoveryProcess(ancestors[index], current)
		if index+1 < len(ancestors) {
			same = same && current.ParentPID == ancestors[index+1].PID
		} else if boundary != nil {
			same = same && current.ParentPID == boundary.PID
		} else {
			same = same && current.PID == 1 && current.ParentPID == 0
		}
		_ = current.Close()
		if !same {
			return fmt.Errorf("recovery: process ancestry changed during final validation")
		}
	}
	if boundary != nil {
		current, err := inspectRecoveryProcessBoundary(boundary.PID)
		if err != nil {
			return err
		}
		if !sameRecoveryProcessBoundary(*boundary, current) {
			return fmt.Errorf("recovery: process ancestry boundary changed during final validation")
		}
	}
	return nil
}

func closeRecoveryProcessIdentities(identities []recoveryProcessIdentity) {
	for index := range identities {
		_ = identities[index].Close()
	}
}

// recoveryExecutableCandidates turns an absolute executable path or one
// executable basename into the existing clean PATH candidates. Platform-specific
// code opens every returned candidate without following links before trusting it.
func recoveryExecutableCandidates(product, pathValue string) ([]string, error) {
	if pathValue == "" {
		return nil, fmt.Errorf("recovery: executable path is empty")
	}
	if strings.ContainsAny(pathValue, `/\`) {
		if err := validateRecoveryAbsolutePath(pathValue); err != nil {
			return nil, err
		}
		if filepath.Base(pathValue) != product {
			return nil, fmt.Errorf("recovery: executable basename does not match product")
		}
		return []string{pathValue}, nil
	}
	if pathValue != product {
		return nil, fmt.Errorf("recovery: executable basename does not match product")
	}

	pathEnv, present := os.LookupEnv("PATH")
	if !present || pathEnv == "" {
		return nil, fmt.Errorf("recovery: executable PATH is unavailable")
	}
	if len(pathEnv) > recoveryMaximumExecutablePathBytes {
		return nil, fmt.Errorf("recovery: executable PATH exceeds %d bytes", recoveryMaximumExecutablePathBytes)
	}
	candidates := make([]string, 0, recoveryMaximumExecutablePathEntries)
	for entries, remaining := 0, pathEnv; ; {
		if entries == recoveryMaximumExecutablePathEntries {
			return nil, fmt.Errorf(
				"recovery: executable PATH exceeds %d entries",
				recoveryMaximumExecutablePathEntries,
			)
		}
		separator := strings.IndexByte(remaining, byte(os.PathListSeparator))
		directory := remaining
		if separator >= 0 {
			directory = remaining[:separator]
			remaining = remaining[separator+1:]
		}
		entries++
		if err := validateRecoveryAbsolutePath(directory); err != nil {
			return nil, fmt.Errorf("recovery: executable PATH contains an unsafe directory: %w", err)
		}
		if len(directory)+1+len(product) > RecoveryMaxExecutableBytes {
			return nil, fmt.Errorf("recovery: executable PATH candidate exceeds %d bytes", RecoveryMaxExecutableBytes)
		}
		candidate := filepath.Join(directory, product)
		if _, err := os.Lstat(candidate); err != nil {
			if os.IsNotExist(err) {
				if separator < 0 {
					break
				}
				continue
			}
			return nil, fmt.Errorf("recovery: inspect executable candidate: %w", err)
		}
		candidates = append(candidates, candidate)
		if separator < 0 {
			break
		}
	}
	if len(candidates) == 0 {
		return nil, fmt.Errorf("recovery: executable was not found")
	}
	return candidates, nil
}

func validateRecoveryProductBasename(product string) error {
	if len(product) > RecoveryMaxExecutableBytes {
		return fmt.Errorf("recovery: product exceeds %d bytes", RecoveryMaxExecutableBytes)
	}
	if product == "" || product == "." || product == ".." ||
		filepath.Base(product) != product || strings.ContainsAny(product, `/\`) ||
		strings.ContainsRune(product, '\x00') {
		return fmt.Errorf("recovery: product is not a clean executable basename")
	}
	return nil
}

// sameRecoveryExecutable compares the stable kernel file facts used as future
// product-ancestor authority. A basename or path alone can never make two
// executables equal; hard-link aliases to the same safe object can.
func sameRecoveryExecutable(a, b recoveryExecutableIdentity) bool {
	if !sameRecoveryExecutableFacts(a, b) || (a.pin == nil && b.pin == nil) {
		return false
	}
	return (a.pin == nil || recoveryExecutablePinMatches(a)) &&
		(b.pin == nil || recoveryExecutablePinMatches(b))
}

func sameRecoveryExecutableFacts(a, b recoveryExecutableIdentity) bool {
	return a.Owner == b.Owner &&
		a.Mode == b.Mode &&
		a.File.Inode != 0 &&
		a.File == b.File
}

func sameRecoveryProcess(a, b recoveryProcessIdentity) bool {
	return a.PID == b.PID &&
		a.ParentPID == b.ParentPID &&
		a.ProcessGroupID == b.ProcessGroupID &&
		a.SessionID == b.SessionID &&
		a.UID == b.UID &&
		a.Start.Value != 0 &&
		a.Start == b.Start &&
		a.WorkingDirectory == b.WorkingDirectory &&
		sameRecoveryExecutableFacts(a.Executable, b.Executable)
}

func sameRecoveryProcessBoundary(a, b recoveryProcessBoundaryIdentity) bool {
	return a.PID > 0 &&
		a.PID == b.PID &&
		a.ParentPID == b.ParentPID &&
		a.UID == b.UID &&
		a.Start.Value != 0 &&
		a.Start == b.Start
}

func recoveryProcessBoundaryMatchesIdentity(
	boundary recoveryProcessBoundaryIdentity,
	identity recoveryProcessIdentity,
) bool {
	return boundary.PID == identity.PID &&
		boundary.ParentPID == identity.ParentPID &&
		boundary.UID == identity.UID &&
		boundary.Start == identity.Start
}
