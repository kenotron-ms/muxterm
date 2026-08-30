//go:build linux

package sessiond

import (
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

const (
	recoveryUnixSocketPathMaximum    = 107
	recoveryProcessIdentitySupported = true
)

const recoveryLinuxProcFileMaximum = 64 * 1024

type recoveryLinuxProcessFacts struct {
	PID            int
	ParentPID      int
	ProcessGroupID int
	SessionID      int
	UID            uint32
	Start          recoveryProcessStartIdentity
}

func inspectRecoveryProcessBoundary(pid int) (recoveryProcessBoundaryIdentity, error) {
	if pid <= 0 {
		return recoveryProcessBoundaryIdentity{}, fmt.Errorf("recovery: process PID must be positive")
	}
	facts, err := recoveryLinuxProcessFactsForPID(pid)
	if err != nil {
		return recoveryProcessBoundaryIdentity{}, err
	}
	return recoveryProcessBoundaryIdentity{
		PID:       facts.PID,
		ParentPID: facts.ParentPID,
		UID:       facts.UID,
		Start:     facts.Start,
	}, nil
}

// inspectRecoveryProcess obtains bounded Linux kernel process facts from procfs
// and verifies them twice around executable inspection. It deliberately never
// asks a command line, terminal title, or basename to establish authority.
func inspectRecoveryProcess(pid int) (recoveryProcessIdentity, error) {
	if pid <= 0 {
		return recoveryProcessIdentity{}, fmt.Errorf("recovery: process PID must be positive")
	}

	before, err := recoveryLinuxProcessFactsForPID(pid)
	if err != nil {
		return recoveryProcessIdentity{}, err
	}
	workingDirectory, err := recoveryLinuxProcessWorkingDirectory(pid, before.UID)
	if err != nil {
		return recoveryProcessIdentity{}, err
	}
	executablePath, err := recoveryLinuxProcessExecutablePath(pid)
	if err != nil {
		return recoveryProcessIdentity{}, err
	}
	executableFD, err := unix.Open(
		recoveryLinuxProcPath(pid, "exe"),
		unix.O_PATH|unix.O_CLOEXEC,
		0,
	)
	if err != nil {
		return recoveryProcessIdentity{}, fmt.Errorf("recovery: pin process executable: %w", err)
	}
	executable, err := recoveryLinuxExecutableIdentityFromFD(
		executableFD,
		RecoveryExecutable(executablePath),
	)
	if err != nil {
		return recoveryProcessIdentity{}, err
	}

	var procExecutable unix.Stat_t
	if err := unix.Stat(recoveryLinuxProcPath(pid, "exe"), &procExecutable); err != nil {
		_ = executable.Close()
		return recoveryProcessIdentity{}, fmt.Errorf("recovery: stat process executable: %w", err)
	}
	procFile, err := recoveryLinuxFileIdentity(&procExecutable)
	if err != nil {
		_ = executable.Close()
		return recoveryProcessIdentity{}, err
	}
	if procFile != executable.File {
		_ = executable.Close()
		return recoveryProcessIdentity{}, fmt.Errorf("recovery: process executable changed during inspection")
	}

	after, err := recoveryLinuxProcessFactsForPID(pid)
	if err != nil {
		_ = executable.Close()
		return recoveryProcessIdentity{}, err
	}
	afterWorkingDirectory, err := recoveryLinuxProcessWorkingDirectory(pid, after.UID)
	if err != nil {
		_ = executable.Close()
		return recoveryProcessIdentity{}, err
	}
	var finalProcExecutable unix.Stat_t
	if err := unix.Stat(recoveryLinuxProcPath(pid, "exe"), &finalProcExecutable); err != nil {
		_ = executable.Close()
		return recoveryProcessIdentity{}, fmt.Errorf("recovery: recheck process executable: %w", err)
	}
	finalFile, err := recoveryLinuxFileIdentity(&finalProcExecutable)
	if err != nil {
		_ = executable.Close()
		return recoveryProcessIdentity{}, err
	}
	if !sameRecoveryLinuxProcessFacts(before, after) ||
		workingDirectory != afterWorkingDirectory ||
		finalFile != executable.File ||
		!recoveryExecutablePinMatches(executable) {
		_ = executable.Close()
		return recoveryProcessIdentity{}, fmt.Errorf("recovery: process changed during inspection")
	}

	return recoveryProcessIdentity{
		PID:              before.PID,
		ParentPID:        before.ParentPID,
		ProcessGroupID:   before.ProcessGroupID,
		SessionID:        before.SessionID,
		UID:              before.UID,
		Start:            before.Start,
		WorkingDirectory: workingDirectory,
		Executable:       executable,
	}, nil
}

// resolveRecoveryExecutable turns either one clean absolute executable path or
// one unambiguous PATH basename lookup into a stable file identity. A second
// distinct match is an authority ambiguity, not a fallback opportunity.
func resolveRecoveryExecutable(product, pathValue string, owner uint32) (recoveryExecutableIdentity, error) {
	if err := validateRecoveryProductBasename(product); err != nil {
		return recoveryExecutableIdentity{}, err
	}
	candidates, err := recoveryExecutableCandidates(product, pathValue)
	if err != nil {
		return recoveryExecutableIdentity{}, err
	}

	var resolved recoveryExecutableIdentity
	found := false
	for _, candidate := range candidates {
		identity, err := recoveryLinuxExecutableIdentity(candidate)
		if err != nil {
			_ = resolved.Close()
			return recoveryExecutableIdentity{}, err
		}
		if identity.Owner != owner {
			_ = identity.Close()
			_ = resolved.Close()
			return recoveryExecutableIdentity{}, fmt.Errorf("recovery: executable owner does not match expected owner")
		}
		if found && !sameRecoveryExecutable(resolved, identity) {
			_ = identity.Close()
			_ = resolved.Close()
			return recoveryExecutableIdentity{}, fmt.Errorf("recovery: executable lookup is ambiguous")
		}
		if found {
			_ = identity.Close()
			continue
		}
		resolved = identity
		found = true
	}
	if !found {
		return recoveryExecutableIdentity{}, fmt.Errorf("recovery: executable was not found")
	}
	return resolved, nil
}

// revalidateRecoveryExecutable verifies that the stored safe executable still
// names the exact same file object and has not become writable or otherwise
// unsafe immediately before an eventual exec.
func revalidateRecoveryExecutable(identity recoveryExecutableIdentity) error {
	if err := validateRecoveryAbsolutePath(string(identity.Path)); err != nil {
		return err
	}
	if identity.pin == nil || !recoveryExecutablePinMatches(identity) {
		return fmt.Errorf("recovery: executable pin is unavailable or changed")
	}
	current, err := recoveryLinuxExecutableIdentity(string(identity.Path))
	if err != nil {
		return err
	}
	defer current.Close()
	if !sameRecoveryExecutable(identity, current) {
		return fmt.Errorf("recovery: executable identity changed")
	}
	return nil
}

func validateRecoveryDirectoryPlatform(path string, owner uint32) error {
	fd, err := recoveryLinuxOpenDirectoryNoFollow(path)
	if err != nil {
		return err
	}
	defer unix.Close(fd)

	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		return fmt.Errorf("recovery: inspect directory descriptor: %w", err)
	}
	return validateRecoveryLinuxDirectoryStat(&stat, owner, false)
}

func validateRecoveryPrivateDirectory(path string, owner uint32) error {
	fd, err := recoveryLinuxOpenDirectoryNoFollow(path)
	if err != nil {
		return err
	}
	defer unix.Close(fd)

	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		return fmt.Errorf("recovery: inspect directory descriptor: %w", err)
	}
	return validateRecoveryLinuxDirectoryStat(&stat, owner, true)
}

func ensureRecoveryDirectoryPath(path string, owner uint32) error {
	if err := validateRecoveryAbsolutePath(path); err != nil {
		return err
	}
	components := strings.Split(strings.TrimPrefix(path, "/"), "/")
	current, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return fmt.Errorf("recovery: open filesystem root: %w", err)
	}
	defer func() { _ = unix.Close(current) }()

	creating := false
	for index, component := range components {
		if component == "" || component == "." || component == ".." {
			return fmt.Errorf("recovery: path contains an invalid component")
		}

		var before unix.Stat_t
		statErr := unix.Fstatat(current, component, &before, unix.AT_SYMLINK_NOFOLLOW)
		if statErr != nil && statErr != unix.ENOENT {
			return fmt.Errorf("recovery: inspect state path component: %w", statErr)
		}
		if statErr == unix.ENOENT {
			if !creating {
				var ancestor unix.Stat_t
				if err := unix.Fstat(current, &ancestor); err != nil {
					return fmt.Errorf("recovery: inspect nearest state ancestor: %w", err)
				}
				if err := validateRecoveryLinuxDirectoryStat(&ancestor, owner, false); err != nil {
					return fmt.Errorf("recovery: nearest existing state ancestor is unsafe: %w", err)
				}
				creating = true
			}
			created := false
			if err := unix.Mkdirat(current, component, recoveryOwnerOnlyDirectoryMode); err != nil {
				if err != unix.EEXIST {
					return fmt.Errorf("recovery: create owner-only state directory: %w", err)
				}
			} else {
				created = true
			}
			if created {
				if err := unix.Fchmodat(current, component, recoveryOwnerOnlyDirectoryMode, 0); err != nil {
					return fmt.Errorf("recovery: set owner-only state directory mode: %w", err)
				}
			}
		} else if before.Mode&unix.S_IFMT != unix.S_IFDIR {
			return fmt.Errorf("recovery: state path component is not a directory")
		}

		next, err := unix.Openat(
			current,
			component,
			unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC,
			0,
		)
		if err != nil {
			return fmt.Errorf("recovery: open state path component without following links: %w", err)
		}
		var after unix.Stat_t
		if err := unix.Fstat(next, &after); err != nil {
			_ = unix.Close(next)
			return fmt.Errorf("recovery: inspect opened state path component: %w", err)
		}
		if after.Mode&unix.S_IFMT != unix.S_IFDIR {
			_ = unix.Close(next)
			return fmt.Errorf("recovery: state path component is not a directory")
		}
		if statErr == nil && !sameRecoveryLinuxObject(&before, &after) {
			_ = unix.Close(next)
			return fmt.Errorf("recovery: state path component changed during inspection")
		}
		if creating || index == len(components)-1 {
			if err := validateRecoveryLinuxDirectoryStat(&after, owner, creating); err != nil {
				_ = unix.Close(next)
				return fmt.Errorf("recovery: state path component is unsafe: %w", err)
			}
		}
		if err := unix.Close(current); err != nil {
			_ = unix.Close(next)
			return fmt.Errorf("recovery: close state path component: %w", err)
		}
		current = next
	}
	return nil
}

func recoveryLinuxProcessFactsForPID(pid int) (recoveryLinuxProcessFacts, error) {
	statData, err := readRecoveryLinuxProcFile(recoveryLinuxProcPath(pid, "stat"))
	if err != nil {
		return recoveryLinuxProcessFacts{}, fmt.Errorf("recovery: read process stat: %w", err)
	}
	facts, err := parseRecoveryLinuxProcessStat(pid, statData)
	if err != nil {
		return recoveryLinuxProcessFacts{}, err
	}
	statusData, err := readRecoveryLinuxProcFile(recoveryLinuxProcPath(pid, "status"))
	if err != nil {
		return recoveryLinuxProcessFacts{}, fmt.Errorf("recovery: read process status: %w", err)
	}
	uid, err := parseRecoveryLinuxEffectiveUID(statusData)
	if err != nil {
		return recoveryLinuxProcessFacts{}, err
	}
	facts.UID = uid
	return facts, nil
}

// recoveryLinuxProcessWorkingDirectory reads the kernel-owned procfs cwd link
// through fixed storage, then verifies the resulting directory as a safe,
// owner-matching object before exposing it as process evidence.
func recoveryLinuxProcessWorkingDirectory(pid int, owner uint32) (RecoveryWorkingDirectory, error) {
	if pid <= 0 {
		return "", fmt.Errorf("recovery: process PID must be positive")
	}
	var buffer [RecoveryMaxWorkingDirectoryBytes + 1]byte
	count, err := unix.Readlink(recoveryLinuxProcPath(pid, "cwd"), buffer[:])
	if err != nil {
		return "", fmt.Errorf("recovery: inspect process working directory: %w", err)
	}
	if count <= 0 || count >= len(buffer) {
		return "", fmt.Errorf("recovery: process working directory exceeds its bound")
	}
	workingDirectory := string(buffer[:count])
	if err := validateRecoveryAbsolutePath(workingDirectory); err != nil {
		return "", fmt.Errorf("recovery: process working directory is unsafe: %w", err)
	}
	if err := validateRecoveryDirectory(workingDirectory, owner); err != nil {
		return "", fmt.Errorf("recovery: process working directory is unsafe: %w", err)
	}
	return RecoveryWorkingDirectory(workingDirectory), nil
}

func recoveryLinuxProcessExecutablePath(pid int) (string, error) {
	var buffer [RecoveryMaxExecutableBytes + 1]byte
	count, err := unix.Readlink(recoveryLinuxProcPath(pid, "exe"), buffer[:])
	if err != nil {
		return "", fmt.Errorf("recovery: inspect process executable: %w", err)
	}
	if count <= 0 || count >= len(buffer) {
		return "", fmt.Errorf("recovery: process executable exceeds its bound")
	}
	executablePath := string(buffer[:count])
	if err := validateRecoveryAbsolutePath(executablePath); err != nil {
		return "", fmt.Errorf("recovery: process executable path is unsafe: %w", err)
	}
	return executablePath, nil
}

func parseRecoveryLinuxProcessStat(expectedPID int, data []byte) (recoveryLinuxProcessFacts, error) {
	line := strings.TrimSpace(string(data))
	opening := strings.IndexByte(line, '(')
	closing := strings.LastIndexByte(line, ')')
	if opening <= 0 || closing <= opening || closing+2 >= len(line) || line[closing+1] != ' ' {
		return recoveryLinuxProcessFacts{}, fmt.Errorf("recovery: process stat is malformed")
	}
	reportedPID, err := strconv.Atoi(strings.TrimSpace(line[:opening]))
	if err != nil || reportedPID != expectedPID || reportedPID <= 0 {
		return recoveryLinuxProcessFacts{}, fmt.Errorf("recovery: process stat has an invalid PID")
	}
	fields := strings.Fields(line[closing+2:])
	// Field 3 is state at index 0; fields 4, 5, 6, and 22 are respectively
	// PPID, process group, session, and start time at indexes 1, 2, 3, and 19.
	if len(fields) <= 19 || len(fields[0]) != 1 {
		return recoveryLinuxProcessFacts{}, fmt.Errorf("recovery: process stat lacks required fields")
	}
	parentPID, err := strconv.Atoi(fields[1])
	if err != nil || parentPID < 0 {
		return recoveryLinuxProcessFacts{}, fmt.Errorf("recovery: process stat has an invalid parent PID")
	}
	processGroupID, err := strconv.Atoi(fields[2])
	if err != nil || processGroupID <= 0 {
		return recoveryLinuxProcessFacts{}, fmt.Errorf("recovery: process stat has an invalid process group")
	}
	sessionID, err := strconv.Atoi(fields[3])
	if err != nil || sessionID <= 0 {
		return recoveryLinuxProcessFacts{}, fmt.Errorf("recovery: process stat has an invalid session")
	}
	start, err := strconv.ParseUint(fields[19], 10, 64)
	if err != nil || start == 0 {
		return recoveryLinuxProcessFacts{}, fmt.Errorf("recovery: process stat has an invalid start identity")
	}
	return recoveryLinuxProcessFacts{
		PID:            reportedPID,
		ParentPID:      parentPID,
		ProcessGroupID: processGroupID,
		SessionID:      sessionID,
		Start:          recoveryProcessStartIdentity{Value: start},
	}, nil
}

func parseRecoveryLinuxEffectiveUID(data []byte) (uint32, error) {
	for _, line := range strings.Split(string(data), "\n") {
		if !strings.HasPrefix(line, "Uid:") {
			continue
		}
		fields := strings.Fields(strings.TrimPrefix(line, "Uid:"))
		if len(fields) != 4 {
			return 0, fmt.Errorf("recovery: process status has an invalid UID field")
		}
		uid, err := strconv.ParseUint(fields[1], 10, 32)
		if err != nil {
			return 0, fmt.Errorf("recovery: process status has an invalid effective UID")
		}
		return uint32(uid), nil
	}
	return 0, fmt.Errorf("recovery: process status lacks an effective UID")
}

func readRecoveryLinuxProcFile(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	data, err := io.ReadAll(io.LimitReader(file, recoveryLinuxProcFileMaximum+1))
	if err != nil {
		return nil, err
	}
	if len(data) > recoveryLinuxProcFileMaximum {
		return nil, fmt.Errorf("procfs data exceeds its bound")
	}
	return data, nil
}

func recoveryLinuxProcPath(pid int, name string) string {
	return "/proc/" + strconv.Itoa(pid) + "/" + name
}

func sameRecoveryLinuxProcessFacts(a, b recoveryLinuxProcessFacts) bool {
	return a.PID == b.PID &&
		a.ParentPID == b.ParentPID &&
		a.ProcessGroupID == b.ProcessGroupID &&
		a.SessionID == b.SessionID &&
		a.UID == b.UID &&
		a.Start == b.Start
}

func recoveryLinuxExecutableIdentity(path string) (recoveryExecutableIdentity, error) {
	fd, err := recoveryLinuxOpenExecutableNoFollow(path)
	if err != nil {
		return recoveryExecutableIdentity{}, err
	}
	return recoveryLinuxExecutableIdentityFromFD(fd, RecoveryExecutable(path))
}

func recoveryLinuxExecutableIdentityFromFD(fd int, path RecoveryExecutable) (recoveryExecutableIdentity, error) {
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		_ = unix.Close(fd)
		return recoveryExecutableIdentity{}, fmt.Errorf("recovery: inspect executable descriptor: %w", err)
	}
	if err := validateRecoveryLinuxExecutableStat(&stat); err != nil {
		_ = unix.Close(fd)
		return recoveryExecutableIdentity{}, err
	}
	file, err := recoveryLinuxFileIdentity(&stat)
	if err != nil {
		_ = unix.Close(fd)
		return recoveryExecutableIdentity{}, err
	}
	pin, err := newRecoveryExecutablePin(fd, path)
	if err != nil {
		_ = unix.Close(fd)
		return recoveryExecutableIdentity{}, err
	}
	return recoveryExecutableIdentity{
		Path:  path,
		Owner: stat.Uid,
		Mode:  stat.Mode,
		File:  file,
		pin:   pin,
	}, nil
}

func recoveryExecutablePinMatches(identity recoveryExecutableIdentity) bool {
	if identity.pin == nil {
		return false
	}
	return identity.pin.withDescriptor(func(fd int) error {
		var stat unix.Stat_t
		if err := unix.Fstat(fd, &stat); err != nil {
			return err
		}
		if err := validateRecoveryLinuxExecutableStat(&stat); err != nil {
			return err
		}
		file, err := recoveryLinuxFileIdentity(&stat)
		if err != nil {
			return err
		}
		if stat.Uid != identity.Owner || stat.Mode != identity.Mode || file != identity.File {
			return fmt.Errorf("recovery: pinned executable identity changed")
		}
		return nil
	}) == nil
}

func recoveryLinuxFileIdentity(stat *unix.Stat_t) (recoveryFileIdentity, error) {
	if stat == nil || stat.Ino == 0 {
		return recoveryFileIdentity{}, fmt.Errorf("recovery: executable has no stable file identity")
	}
	return recoveryFileIdentity{
		Device: stat.Dev,
		Inode:  stat.Ino,
	}, nil
}

func validateRecoveryLinuxExecutableStat(stat *unix.Stat_t) error {
	if stat == nil || stat.Mode&unix.S_IFMT != unix.S_IFREG {
		return fmt.Errorf("recovery: executable is not a regular file")
	}
	if stat.Mode&0o111 == 0 {
		return fmt.Errorf("recovery: executable is not executable")
	}
	if stat.Mode&0o022 != 0 {
		return fmt.Errorf("recovery: executable is group or world writable")
	}
	return nil
}

func validateRecoveryLinuxDirectoryStat(stat *unix.Stat_t, owner uint32, ownerOnly bool) error {
	if stat == nil || stat.Mode&unix.S_IFMT != unix.S_IFDIR {
		return fmt.Errorf("recovery: path is not a directory")
	}
	if stat.Uid != owner {
		return fmt.Errorf("recovery: directory owner does not match daemon owner")
	}
	if stat.Mode&0o022 != 0 {
		return fmt.Errorf("recovery: directory is group or world writable")
	}
	if ownerOnly && stat.Mode&0o7777 != recoveryOwnerOnlyDirectoryMode {
		return fmt.Errorf("recovery: directory is not owner-only mode 0700")
	}
	return nil
}

func recoveryLinuxOpenDirectoryNoFollow(path string) (int, error) {
	return recoveryLinuxOpenPathNoFollow(path, true)
}

func recoveryLinuxOpenExecutableNoFollow(path string) (int, error) {
	return recoveryLinuxOpenPathNoFollow(path, false)
}

func recoveryLinuxOpenPathNoFollow(path string, finalDirectory bool) (int, error) {
	if err := validateRecoveryAbsolutePath(path); err != nil {
		return -1, err
	}
	components := strings.Split(strings.TrimPrefix(path, "/"), "/")
	current, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, fmt.Errorf("recovery: open filesystem root: %w", err)
	}

	for index, component := range components {
		if component == "" || component == "." || component == ".." {
			_ = unix.Close(current)
			return -1, fmt.Errorf("recovery: path contains an invalid component")
		}
		final := index == len(components)-1
		var before unix.Stat_t
		if err := unix.Fstatat(current, component, &before, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			_ = unix.Close(current)
			return -1, fmt.Errorf("recovery: inspect path component without following links: %w", err)
		}
		expectedType := uint32(unix.S_IFDIR)
		if final && !finalDirectory {
			expectedType = unix.S_IFREG
		}
		if before.Mode&unix.S_IFMT != expectedType {
			_ = unix.Close(current)
			return -1, fmt.Errorf("recovery: path component has an unexpected type")
		}

		flags := unix.O_RDONLY | unix.O_NOFOLLOW | unix.O_CLOEXEC
		if expectedType == unix.S_IFDIR {
			flags |= unix.O_DIRECTORY
		}
		next, err := unix.Openat(current, component, flags, 0)
		if err != nil {
			_ = unix.Close(current)
			return -1, fmt.Errorf("recovery: open path component without following links: %w", err)
		}
		var after unix.Stat_t
		if err := unix.Fstat(next, &after); err != nil {
			_ = unix.Close(next)
			_ = unix.Close(current)
			return -1, fmt.Errorf("recovery: inspect opened path component: %w", err)
		}
		if after.Mode&unix.S_IFMT != expectedType || !sameRecoveryLinuxObject(&before, &after) {
			_ = unix.Close(next)
			_ = unix.Close(current)
			return -1, fmt.Errorf("recovery: path component changed during inspection")
		}
		if err := unix.Close(current); err != nil {
			_ = unix.Close(next)
			return -1, fmt.Errorf("recovery: close path component: %w", err)
		}
		current = next
	}
	return current, nil
}

func sameRecoveryLinuxObject(a, b *unix.Stat_t) bool {
	return a != nil && b != nil && a.Dev == b.Dev && a.Ino == b.Ino
}
