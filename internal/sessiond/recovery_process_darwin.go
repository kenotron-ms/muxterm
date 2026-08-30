//go:build darwin && cgo

package sessiond

/*
#include <errno.h>
#include <libproc.h>
#include <mach/vm_prot.h>
#include <stdint.h>
#include <string.h>
#include <sys/proc_info.h>

static int
muxterm_proc_pidpath(int pid, char *buffer, uint32_t size)
{
	int count = proc_pidpath(pid, buffer, size);
	return count > 0 ? count : -errno;
}

static int
muxterm_proc_pidcwd(int pid, char *path, uint32_t path_size)
{
	struct proc_vnodepathinfo info;
	memset(&info, 0, sizeof(info));
	errno = 0;
	int count = proc_pidinfo(
		pid,
		PROC_PIDVNODEPATHINFO,
		0,
		&info,
		sizeof(info));
	if (count <= 0) {
		return -(errno != 0 ? errno : EIO);
	}
	if (count != sizeof(info)) {
		return -EIO;
	}

	size_t length = strnlen(info.pvi_cdir.vip_path, MAXPATHLEN);
	if (length == 0 || length >= MAXPATHLEN || length + 1 > path_size) {
		return -ENAMETOOLONG;
	}
	memcpy(path, info.pvi_cdir.vip_path, length + 1);
	return (int)length;
}

struct muxterm_proc_region {
	uint64_t address;
	uint64_t size;
	uint64_t offset;
	uint32_t protection;
	uint32_t device;
	uint64_t inode;
	uint32_t generation;
	uint32_t owner;
	uint32_t mode;
};

static int
muxterm_proc_pidregion(
	int pid,
	uint64_t address,
	struct muxterm_proc_region *result,
	char *path,
	uint32_t path_size)
{
	struct proc_regionwithpathinfo region;
	memset(&region, 0, sizeof(region));
	errno = 0;
	int count = proc_pidinfo(
		pid,
		PROC_PIDREGIONPATHINFO,
		address,
		&region,
		sizeof(region));
	if (count <= 0) {
		if (errno == EINVAL) {
			return 0;
		}
		return -(errno != 0 ? errno : EIO);
	}
	if (count != sizeof(region)) {
		return -EIO;
	}

	size_t length = strnlen(region.prp_vip.vip_path, MAXPATHLEN);
	if (length >= MAXPATHLEN || length + 1 > path_size) {
		return -ENAMETOOLONG;
	}
	memcpy(path, region.prp_vip.vip_path, length + 1);
	result->address = region.prp_prinfo.pri_address;
	result->size = region.prp_prinfo.pri_size;
	result->offset = region.prp_prinfo.pri_offset;
	result->protection = region.prp_prinfo.pri_protection;
	result->device = region.prp_vip.vip_vi.vi_stat.vst_dev;
	result->inode = region.prp_vip.vip_vi.vi_stat.vst_ino;
	result->generation = region.prp_vip.vip_vi.vi_stat.vst_gen;
	result->owner = region.prp_vip.vip_vi.vi_stat.vst_uid;
	result->mode = region.prp_vip.vip_vi.vi_stat.vst_mode;
	return 1;
}
*/
import "C"

import (
	"fmt"
	"strings"
	"unsafe"

	"golang.org/x/sys/unix"
)

const (
	recoveryUnixSocketPathMaximum    = 103
	recoveryProcessIdentitySupported = true
)

const (
	recoveryDarwinProcPIDPathMaximum = 4 * 1024
	recoveryDarwinRegionMaximum      = 4 * 1024
	recoveryDarwinExecutableBlocked  = "BLOCKED-DARWIN-PEER-PID/EXEC-VNODE"
)

type recoveryDarwinRegion struct {
	Address    uint64
	Size       uint64
	Offset     uint64
	Protection uint32
	Owner      uint32
	Mode       uint32
	File       recoveryFileIdentity
	Path       string
}

type recoveryDarwinProcessFacts struct {
	PID            int
	ParentPID      int
	ProcessGroupID int
	UID            uint32
	Start          recoveryProcessStartIdentity
}

func inspectRecoveryProcessBoundary(pid int) (recoveryProcessBoundaryIdentity, error) {
	if pid <= 0 {
		return recoveryProcessBoundaryIdentity{}, fmt.Errorf("recovery: process PID must be positive")
	}
	facts, err := recoveryDarwinProcessFactsForPID(pid)
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

// inspectRecoveryProcess obtains Darwin process facts and the main executable
// vnode from kernel process/VM-region APIs. proc_pidpath is used only to
// correlate p_textvp with mapped executable regions; pathname metadata never
// establishes authority.
func inspectRecoveryProcess(pid int) (recoveryProcessIdentity, error) {
	if pid <= 0 {
		return recoveryProcessIdentity{}, fmt.Errorf("recovery: process PID must be positive")
	}

	before, err := recoveryDarwinProcessFactsForPID(pid)
	if err != nil {
		return recoveryProcessIdentity{}, err
	}
	workingDirectory, err := recoveryDarwinProcessWorkingDirectory(pid, before.UID)
	if err != nil {
		return recoveryProcessIdentity{}, err
	}
	beforeGroup, err := unix.Getpgid(pid)
	if err != nil || beforeGroup <= 0 || beforeGroup != before.ProcessGroupID {
		return recoveryProcessIdentity{}, fmt.Errorf("recovery: process group is unavailable")
	}
	beforeSession, err := unix.Getsid(pid)
	if err != nil || beforeSession <= 0 {
		return recoveryProcessIdentity{}, fmt.Errorf("recovery: process session is unavailable")
	}
	executable, err := recoveryDarwinRunningExecutableIdentity(pid)
	if err != nil {
		return recoveryProcessIdentity{}, err
	}
	verifiedExecutable, err := recoveryDarwinRunningExecutableIdentity(pid)
	if err != nil {
		_ = executable.Close()
		return recoveryProcessIdentity{}, err
	}
	if !sameRecoveryExecutableFacts(executable, verifiedExecutable) ||
		!recoveryExecutablePinMatches(executable) ||
		!recoveryExecutablePinMatches(verifiedExecutable) {
		_ = executable.Close()
		_ = verifiedExecutable.Close()
		return recoveryProcessIdentity{}, fmt.Errorf("recovery: process executable changed during inspection")
	}
	if err := verifiedExecutable.Close(); err != nil {
		_ = executable.Close()
		return recoveryProcessIdentity{}, fmt.Errorf("recovery: release verified process executable: %w", err)
	}

	after, err := recoveryDarwinProcessFactsForPID(pid)
	if err != nil {
		_ = executable.Close()
		return recoveryProcessIdentity{}, err
	}
	afterWorkingDirectory, err := recoveryDarwinProcessWorkingDirectory(pid, after.UID)
	if err != nil {
		_ = executable.Close()
		return recoveryProcessIdentity{}, err
	}
	afterGroup, err := unix.Getpgid(pid)
	if err != nil || afterGroup <= 0 {
		_ = executable.Close()
		return recoveryProcessIdentity{}, fmt.Errorf("recovery: recheck process group is unavailable")
	}
	afterSession, err := unix.Getsid(pid)
	if err != nil || afterSession <= 0 {
		_ = executable.Close()
		return recoveryProcessIdentity{}, fmt.Errorf("recovery: recheck process session is unavailable")
	}
	if !sameRecoveryDarwinProcessFacts(before, after) ||
		workingDirectory != afterWorkingDirectory ||
		beforeGroup != afterGroup ||
		beforeSession != afterSession ||
		afterGroup != after.ProcessGroupID {
		_ = executable.Close()
		return recoveryProcessIdentity{}, fmt.Errorf("recovery: process changed during inspection")
	}

	return recoveryProcessIdentity{
		PID:              before.PID,
		ParentPID:        before.ParentPID,
		ProcessGroupID:   before.ProcessGroupID,
		SessionID:        beforeSession,
		UID:              before.UID,
		Start:            before.Start,
		WorkingDirectory: workingDirectory,
		Executable:       executable,
	}, nil
}

// resolveRecoveryExecutable turns either one clean absolute executable path or
// one unambiguous PATH basename lookup into a stable vnode identity. A second
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
		identity, err := recoveryDarwinExecutableIdentity(candidate)
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
// names the exact same vnode and has not become writable or otherwise unsafe
// immediately before an eventual exec.
func revalidateRecoveryExecutable(identity recoveryExecutableIdentity) error {
	if err := validateRecoveryAbsolutePath(string(identity.Path)); err != nil {
		return err
	}
	if identity.pin == nil || !recoveryExecutablePinMatches(identity) {
		return fmt.Errorf("recovery: executable pin is unavailable or changed")
	}
	current, err := recoveryDarwinExecutableIdentity(string(identity.Path))
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
	fd, err := recoveryDarwinOpenDirectoryNoFollow(path)
	if err != nil {
		return err
	}
	defer unix.Close(fd)

	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		return fmt.Errorf("recovery: inspect directory descriptor: %w", err)
	}
	return validateRecoveryDarwinDirectoryStat(&stat, owner, false)
}

func validateRecoveryPrivateDirectory(path string, owner uint32) error {
	fd, err := recoveryDarwinOpenDirectoryNoFollow(path)
	if err != nil {
		return err
	}
	defer unix.Close(fd)

	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		return fmt.Errorf("recovery: inspect directory descriptor: %w", err)
	}
	return validateRecoveryDarwinDirectoryStat(&stat, owner, true)
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
				if err := validateRecoveryDarwinDirectoryStat(&ancestor, owner, false); err != nil {
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
		} else if before.Mode&uint16(unix.S_IFMT) != uint16(unix.S_IFDIR) {
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
		if after.Mode&uint16(unix.S_IFMT) != uint16(unix.S_IFDIR) {
			_ = unix.Close(next)
			return fmt.Errorf("recovery: state path component is not a directory")
		}
		if statErr == nil && !sameRecoveryDarwinObject(&before, &after) {
			_ = unix.Close(next)
			return fmt.Errorf("recovery: state path component changed during inspection")
		}
		if creating || index == len(components)-1 {
			if err := validateRecoveryDarwinDirectoryStat(&after, owner, creating); err != nil {
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

func recoveryDarwinProcessFactsForPID(pid int) (recoveryDarwinProcessFacts, error) {
	kinfo, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil || kinfo == nil {
		if err != nil {
			return recoveryDarwinProcessFacts{}, fmt.Errorf("recovery: inspect process: %w", err)
		}
		return recoveryDarwinProcessFacts{}, fmt.Errorf("recovery: process facts are unavailable")
	}
	reportedPID := int(kinfo.Proc.P_pid)
	parentPID := int(kinfo.Eproc.Ppid)
	processGroupID := int(kinfo.Eproc.Pgid)
	startSeconds := kinfo.Proc.P_starttime.Sec
	startMicroseconds := kinfo.Proc.P_starttime.Usec
	if reportedPID != pid || reportedPID <= 0 ||
		parentPID < 0 ||
		processGroupID <= 0 ||
		startSeconds < 0 ||
		startMicroseconds < 0 ||
		startMicroseconds >= 1_000_000 {
		return recoveryDarwinProcessFacts{}, fmt.Errorf("recovery: process facts are incomplete")
	}
	seconds := uint64(startSeconds)
	if seconds > ^uint64(0)/1_000_000 {
		return recoveryDarwinProcessFacts{}, fmt.Errorf("recovery: process start identity overflows")
	}
	start := seconds*1_000_000 + uint64(startMicroseconds)
	if start == 0 {
		return recoveryDarwinProcessFacts{}, fmt.Errorf("recovery: process start identity is unavailable")
	}
	return recoveryDarwinProcessFacts{
		PID:            reportedPID,
		ParentPID:      parentPID,
		ProcessGroupID: processGroupID,
		UID:            kinfo.Eproc.Ucred.Uid,
		Start:          recoveryProcessStartIdentity{Value: start},
	}, nil
}

// recoveryDarwinProcessWorkingDirectory obtains a bounded cwd path from the
// kernel vnode record and verifies the resulting directory object before it
// becomes process evidence.
func recoveryDarwinProcessWorkingDirectory(pid int, owner uint32) (RecoveryWorkingDirectory, error) {
	if pid <= 0 {
		return "", fmt.Errorf("recovery: process PID must be positive")
	}
	var buffer [recoveryDarwinProcPIDPathMaximum]byte
	count := C.muxterm_proc_pidcwd(
		C.int(pid),
		(*C.char)(unsafe.Pointer(&buffer[0])),
		C.uint32_t(len(buffer)),
	)
	if count <= 0 || int(count) >= len(buffer) || buffer[int(count)] != 0 {
		return "", fmt.Errorf("recovery: process working directory is unavailable")
	}
	workingDirectory := string(buffer[:int(count)])
	if err := validateRecoveryAbsolutePath(workingDirectory); err != nil {
		return "", fmt.Errorf("recovery: process working directory is unsafe: %w", err)
	}
	if err := validateRecoveryDirectory(workingDirectory, owner); err != nil {
		return "", fmt.Errorf("recovery: process working directory is unsafe: %w", err)
	}
	return RecoveryWorkingDirectory(workingDirectory), nil
}

func recoveryDarwinProcessPath(pid int) (string, error) {
	var buffer [recoveryDarwinProcPIDPathMaximum]byte
	count := C.muxterm_proc_pidpath(
		C.int(pid),
		(*C.char)(unsafe.Pointer(&buffer[0])),
		C.uint32_t(len(buffer)),
	)
	if count <= 0 {
		return "", fmt.Errorf("recovery: process executable path is unavailable")
	}
	if int(count) >= len(buffer) || buffer[int(count)] != 0 {
		return "", fmt.Errorf("recovery: process executable path is unavailable")
	}
	path := string(buffer[:int(count)])
	if err := validateRecoveryAbsolutePath(path); err != nil {
		return "", fmt.Errorf("recovery: process executable path is unsafe: %w", err)
	}
	return path, nil
}

func recoveryDarwinRunningExecutableIdentity(pid int) (recoveryExecutableIdentity, error) {
	textPath, err := recoveryDarwinProcessPath(pid)
	if err != nil {
		return recoveryExecutableIdentity{}, fmt.Errorf("%s: %w", recoveryDarwinExecutableBlocked, err)
	}

	var executable recoveryExecutableIdentity
	found := false
	address := uint64(0)
	reachedEnd := false
	for count := 0; count < recoveryDarwinRegionMaximum; count++ {
		region, end, err := recoveryDarwinProcessRegion(pid, address)
		if err != nil {
			return recoveryExecutableIdentity{}, err
		}
		if end {
			reachedEnd = true
			break
		}
		if region.Size == 0 || region.Address > ^uint64(0)-region.Size {
			return recoveryExecutableIdentity{}, fmt.Errorf(
				"%s: process VM region does not make bounded progress",
				recoveryDarwinExecutableBlocked,
			)
		}
		next := region.Address + region.Size
		if next <= address {
			return recoveryExecutableIdentity{}, fmt.Errorf(
				"%s: process VM region repeats or moves backward",
				recoveryDarwinExecutableBlocked,
			)
		}
		address = next

		// proc_pidpath is the kernel's p_textvp pathname and is used only to
		// correlate that main image with executable mapped vnode records. The
		// returned authority is exclusively the vnode's owner/mode/file facts.
		if region.Path != textPath || region.Protection&0x4 == 0 || region.File.Inode == 0 {
			continue
		}
		candidate := recoveryExecutableIdentity{
			Path:  RecoveryExecutable(textPath),
			Owner: region.Owner,
			Mode:  region.Mode,
			File:  region.File,
		}
		if err := validateRecoveryDarwinObservedExecutable(candidate); err != nil {
			return recoveryExecutableIdentity{}, fmt.Errorf(
				"%s: unsafe main-image vnode: %w",
				recoveryDarwinExecutableBlocked,
				err,
			)
		}
		if found && !sameRecoveryExecutableFacts(executable, candidate) {
			return recoveryExecutableIdentity{}, fmt.Errorf(
				"%s: main-image path identifies multiple executable vnodes",
				recoveryDarwinExecutableBlocked,
			)
		}
		executable = candidate
		found = true
	}
	if !reachedEnd {
		return recoveryExecutableIdentity{}, fmt.Errorf(
			"%s: process VM region traversal exceeds %d entries",
			recoveryDarwinExecutableBlocked,
			recoveryDarwinRegionMaximum,
		)
	}
	if !found {
		return recoveryExecutableIdentity{}, fmt.Errorf(
			"%s: no executable vnode correlates with the process main image",
			recoveryDarwinExecutableBlocked,
		)
	}
	pinned, err := recoveryDarwinExecutableIdentity(textPath)
	if err != nil {
		return recoveryExecutableIdentity{}, fmt.Errorf(
			"%s: pin main-image executable: %w",
			recoveryDarwinExecutableBlocked,
			err,
		)
	}
	if !sameRecoveryExecutableFacts(executable, pinned) || !recoveryExecutablePinMatches(pinned) {
		_ = pinned.Close()
		return recoveryExecutableIdentity{}, fmt.Errorf(
			"%s: main-image vnode does not match pinned executable",
			recoveryDarwinExecutableBlocked,
		)
	}
	return pinned, nil
}

func recoveryDarwinProcessRegion(pid int, address uint64) (recoveryDarwinRegion, bool, error) {
	var raw C.struct_muxterm_proc_region
	var path [recoveryDarwinProcPIDPathMaximum]byte
	result := C.muxterm_proc_pidregion(
		C.int(pid),
		C.uint64_t(address),
		&raw,
		(*C.char)(unsafe.Pointer(&path[0])),
		C.uint32_t(len(path)),
	)
	if result == 0 {
		return recoveryDarwinRegion{}, true, nil
	}
	if result < 0 {
		return recoveryDarwinRegion{}, false, fmt.Errorf(
			"%s: inspect process VM region (errno %d)",
			recoveryDarwinExecutableBlocked,
			int(-result),
		)
	}
	regionPath := C.GoString((*C.char)(unsafe.Pointer(&path[0])))
	return recoveryDarwinRegion{
		Address:    uint64(raw.address),
		Size:       uint64(raw.size),
		Offset:     uint64(raw.offset),
		Protection: uint32(raw.protection),
		Owner:      uint32(raw.owner),
		Mode:       uint32(raw.mode),
		File: recoveryFileIdentity{
			Device:     uint64(raw.device),
			Inode:      uint64(raw.inode),
			Generation: uint64(raw.generation),
		},
		Path: regionPath,
	}, false, nil
}

func validateRecoveryDarwinObservedExecutable(identity recoveryExecutableIdentity) error {
	if identity.File.Inode == 0 {
		return fmt.Errorf("recovery: executable has no stable vnode identity")
	}
	if identity.Mode&uint32(unix.S_IFMT) != uint32(unix.S_IFREG) {
		return fmt.Errorf("recovery: executable is not a regular file")
	}
	if identity.Mode&0o111 == 0 {
		return fmt.Errorf("recovery: executable is not executable")
	}
	if identity.Mode&0o022 != 0 {
		return fmt.Errorf("recovery: executable is group or world writable")
	}
	return nil
}

func sameRecoveryDarwinProcessFacts(a, b recoveryDarwinProcessFacts) bool {
	return a.PID == b.PID &&
		a.ParentPID == b.ParentPID &&
		a.ProcessGroupID == b.ProcessGroupID &&
		a.UID == b.UID &&
		a.Start == b.Start
}

func recoveryDarwinExecutableIdentity(path string) (recoveryExecutableIdentity, error) {
	fd, err := recoveryDarwinOpenExecutableNoFollow(path)
	if err != nil {
		return recoveryExecutableIdentity{}, err
	}
	return recoveryDarwinExecutableIdentityFromFD(fd, RecoveryExecutable(path))
}

func recoveryDarwinExecutableIdentityFromFD(fd int, path RecoveryExecutable) (recoveryExecutableIdentity, error) {
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		_ = unix.Close(fd)
		return recoveryExecutableIdentity{}, fmt.Errorf("recovery: inspect executable descriptor: %w", err)
	}
	if err := validateRecoveryDarwinExecutableStat(&stat); err != nil {
		_ = unix.Close(fd)
		return recoveryExecutableIdentity{}, err
	}
	file, err := recoveryDarwinFileIdentity(&stat)
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
		Mode:  uint32(stat.Mode),
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
		if err := validateRecoveryDarwinExecutableStat(&stat); err != nil {
			return err
		}
		file, err := recoveryDarwinFileIdentity(&stat)
		if err != nil {
			return err
		}
		if stat.Uid != identity.Owner || uint32(stat.Mode) != identity.Mode || file != identity.File {
			return fmt.Errorf("recovery: pinned executable identity changed")
		}
		return nil
	}) == nil
}

func recoveryDarwinFileIdentity(stat *unix.Stat_t) (recoveryFileIdentity, error) {
	if stat == nil || stat.Ino == 0 || stat.Dev < 0 {
		return recoveryFileIdentity{}, fmt.Errorf("recovery: executable has no stable vnode identity")
	}
	return recoveryFileIdentity{
		Device:     uint64(uint32(stat.Dev)),
		Inode:      stat.Ino,
		Generation: uint64(stat.Gen),
	}, nil
}

func validateRecoveryDarwinExecutableStat(stat *unix.Stat_t) error {
	if stat == nil || stat.Mode&uint16(unix.S_IFMT) != uint16(unix.S_IFREG) {
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

func validateRecoveryDarwinDirectoryStat(stat *unix.Stat_t, owner uint32, ownerOnly bool) error {
	if stat == nil || stat.Mode&uint16(unix.S_IFMT) != uint16(unix.S_IFDIR) {
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

func recoveryDarwinOpenDirectoryNoFollow(path string) (int, error) {
	return recoveryDarwinOpenPathNoFollow(path, true)
}

func recoveryDarwinOpenExecutableNoFollow(path string) (int, error) {
	return recoveryDarwinOpenPathNoFollow(path, false)
}

func recoveryDarwinOpenPathNoFollow(path string, finalDirectory bool) (int, error) {
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
		expectedType := uint16(unix.S_IFDIR)
		if final && !finalDirectory {
			expectedType = uint16(unix.S_IFREG)
		}
		if before.Mode&uint16(unix.S_IFMT) != expectedType {
			_ = unix.Close(current)
			return -1, fmt.Errorf("recovery: path component has an unexpected type")
		}

		flags := unix.O_RDONLY | unix.O_NOFOLLOW | unix.O_CLOEXEC
		if expectedType == uint16(unix.S_IFDIR) {
			flags |= unix.O_DIRECTORY
		} else {
			flags = unix.O_EVTONLY | unix.O_NOFOLLOW | unix.O_CLOEXEC
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
		if after.Mode&uint16(unix.S_IFMT) != expectedType || !sameRecoveryDarwinObject(&before, &after) {
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

func sameRecoveryDarwinObject(a, b *unix.Stat_t) bool {
	return a != nil && b != nil && a.Dev == b.Dev && a.Ino == b.Ino && a.Gen == b.Gen
}
