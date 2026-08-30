package recoveryhooks

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

const (
	controlNamePrefix = ".muxterm-recovery-"
	targetLockName    = controlNamePrefix + "transaction.lock"
	tempPrefix        = controlNamePrefix + "tmp-"
)

type rootHandle struct {
	fd      int
	device  uint64
	inode   uint64
	lineage []fileIdentity
}

type filePolicy uint8

const (
	filePolicyConfig filePolicy = iota + 1
	filePolicyOwned
)

type fileIdentity struct {
	device uint64
	inode  uint64
	mode   uint32
	nlink  uint64
	uid    uint32
	size   int64
}

type targetHandle struct {
	parentFD       int
	parentIdentity fileIdentity
	leaf           string
}

type currentObject struct {
	fd             int
	exists         bool
	identity       fileIdentity
	digest         [sha256.Size]byte
	current        CurrentFile
	parentIdentity fileIdentity
	leaf           string
	policy         filePolicy
}

type tempObject struct {
	fd       int
	name     string
	identity fileIdentity
	digest   [sha256.Size]byte
}

type publishResult struct {
	commit          CommitState
	renameAttempted bool
	renamed         bool
}

// openManagedRoot reaches an absolute, caller-validated root through a single
// descriptor walk. The only pathname opened after / is a single relative
// component passed to an already validated descriptor.
func openManagedRoot(path string, createFinal bool) (*rootHandle, error) {
	if err := validateRootPath(path); err != nil {
		return nil, redactPhaseError(err, ErrUnsafePath, "validate managed root")
	}

	rootFD, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, fixedPhaseError(ErrUnsafePath, "open filesystem root")
	}
	parentFD := rootFD
	defer func() {
		if parentFD >= 0 {
			closeFD(&parentFD)
		}
	}()

	rootIdentity, err := statIdentity(parentFD)
	if err != nil || !safeAncestorDirectory(rootIdentity) {
		return nil, fixedPhaseError(ErrUnsafePath, "validate filesystem root")
	}
	lineage := []fileIdentity{rootIdentity}

	components := strings.Split(strings.TrimPrefix(path, "/"), "/")
	for index, component := range components {
		final := index == len(components)-1
		var before unix.Stat_t
		err = unix.Fstatat(parentFD, component, &before, unix.AT_SYMLINK_NOFOLLOW)
		if err != nil {
			if !final || !createFinal || !errors.Is(err, unix.ENOENT) {
				return nil, fixedPhaseError(ErrUnsafePath, "stat managed root component")
			}
			return createManagedRoot(parentFD, component, lineage)
		}

		beforeIdentity := identityFromStat(&before)
		if !safeAncestorDirectory(beforeIdentity) {
			return nil, fixedPhaseError(ErrUnsafePath, "validate managed root component")
		}
		if final && !safeFinalRoot(beforeIdentity, createFinal) {
			return nil, fixedPhaseError(ErrUnsafePath, "validate managed root final")
		}

		nextFD, err := unix.Openat(
			parentFD,
			component,
			unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC,
			0,
		)
		if err != nil {
			return nil, fixedPhaseError(ErrUnsafePath, "open managed root component")
		}

		nextIdentity, statErr := statIdentity(nextFD)
		if statErr != nil || !sameIdentity(beforeIdentity, nextIdentity) ||
			!sameFileType(beforeIdentity, nextIdentity) ||
			!safeAncestorDirectory(nextIdentity) ||
			(final && !safeFinalRoot(nextIdentity, createFinal)) {
			closeFD(&nextFD)
			return nil, fixedPhaseError(ErrUnsafePath, "verify managed root component")
		}
		if err := verifyNamedDirectory(parentFD, component, nextIdentity); err != nil {
			closeFD(&nextFD)
			return nil, redactPhaseError(err, ErrUnsafePath, "verify managed root name")
		}

		closeFD(&parentFD)
		parentFD = nextFD
		lineage = append(lineage, nextIdentity)
	}

	identity, err := statIdentity(parentFD)
	if err != nil || !safeFinalRoot(identity, createFinal) {
		return nil, fixedPhaseError(ErrUnsafePath, "verify managed root final")
	}
	handle := &rootHandle{
		fd:      parentFD,
		device:  identity.device,
		inode:   identity.inode,
		lineage: append([]fileIdentity(nil), lineage...),
	}
	parentFD = -1
	return handle, nil
}

func createManagedRoot(parentFD int, component string, lineage []fileIdentity) (*rootHandle, error) {
	if err := verifyAncestorDirectory(parentFD); err != nil {
		return nil, redactPhaseError(err, ErrUnsafePath, "verify state root parent")
	}
	if err := unix.Mkdirat(parentFD, component, 0o700); err != nil {
		return nil, fixedPhaseError(ErrUnsafePath, "create state root")
	}

	childFD, err := unix.Openat(
		parentFD,
		component,
		unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC,
		0,
	)
	if err != nil {
		return nil, fixedPhaseError(ErrUnsafePath, "open created state root")
	}
	keepChild := false
	defer func() {
		if !keepChild {
			closeFD(&childFD)
		}
	}()

	created, err := statIdentity(childFD)
	if err != nil || !sameFileType(created, fileIdentity{mode: uint32(unix.S_IFDIR)}) ||
		created.uid != effectiveUID() {
		return nil, fixedPhaseError(ErrUnsafePath, "verify created state root")
	}
	if err := unix.Fchmod(childFD, 0o700); err != nil {
		return nil, fixedPhaseError(ErrUnsafePath, "chmod state root")
	}
	created, err = statIdentity(childFD)
	if err != nil || !safeFinalRoot(created, true) {
		return nil, fixedPhaseError(ErrUnsafePath, "verify state root mode")
	}
	if err := verifyNamedDirectory(parentFD, component, created); err != nil {
		return nil, redactPhaseError(err, ErrUnsafePath, "verify created state root name")
	}
	if err := unix.Fsync(childFD); err != nil {
		return nil, fixedPhaseError(ErrUnsafePath, "fsync state root")
	}
	if err := unix.Fsync(parentFD); err != nil {
		return nil, fixedPhaseError(ErrUnsafePath, "fsync state root parent")
	}

	keepChild = true
	return &rootHandle{
		fd:      childFD,
		device:  created.device,
		inode:   created.inode,
		lineage: append(append([]fileIdentity(nil), lineage...), created),
	}, nil
}

// openGlobalLock creates or opens the private state-root lock and takes it
// once. The lock remains on disk; its descriptor is released by Manager.Close.
func openGlobalLock(root *rootHandle) (int, error) {
	if root == nil || root.fd < 0 || root.inode == 0 {
		return -1, fixedPhaseError(ErrUnsafePath, "validate manager lock root")
	}
	if err := verifyPrivateStateRoot(root); err != nil {
		return -1, redactPhaseError(err, ErrUnsafePath, "validate manager lock root")
	}

	fd, err := openOwnedRegular(root.fd, managerLockName)
	if err != nil {
		return -1, redactPhaseError(err, ErrUnsafePath, "open manager lock")
	}
	if err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != nil {
		closeFD(&fd)
		if lockWouldBlock(err) {
			return -1, fixedPhaseError(ErrBusy, "acquire manager lock")
		}
		return -1, fixedPhaseError(ErrUnsafePath, "acquire manager lock")
	}
	if err := verifyNamedOwnedFile(root.fd, managerLockName, fd); err != nil {
		unlockAndClose(&fd)
		return -1, redactPhaseError(err, ErrUnsafePath, "verify manager lock")
	}
	if err := verifyPrivateStateRoot(root); err != nil {
		unlockAndClose(&fd)
		return -1, redactPhaseError(err, ErrUnsafePath, "revalidate manager lock root")
	}
	return fd, nil
}

// openTargetParent duplicates the retained anchor descriptor and descends only
// existing, descriptor-relative directories. The returned descriptor owns the
// sibling directory containing leaf.
func openTargetParent(root *rootHandle, relativePath string) (*targetHandle, error) {
	if err := validateRelativePath(relativePath); err != nil {
		return nil, redactPhaseError(err, ErrUnsafePath, "validate target path")
	}
	if root == nil || root.fd < 0 || root.inode == 0 {
		return nil, fixedPhaseError(ErrUnsafePath, "validate target root")
	}
	if err := verifyDirectoryIdentity(root.fd, root.device, root.inode); err != nil {
		return nil, redactPhaseError(err, ErrUnsafePath, "verify target root")
	}

	parentFD, err := duplicateCloseOnExec(root.fd)
	if err != nil {
		return nil, fixedPhaseError(ErrUnsafePath, "duplicate target root")
	}
	keepParent := false
	defer func() {
		if !keepParent {
			closeFD(&parentFD)
		}
	}()

	components := strings.Split(relativePath, "/")
	for _, component := range components[:len(components)-1] {
		var before unix.Stat_t
		if err := unix.Fstatat(parentFD, component, &before, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			return nil, fixedPhaseError(ErrUnsafePath, "stat target parent")
		}
		beforeIdentity := identityFromStat(&before)
		if !safeMutableDirectory(beforeIdentity) {
			return nil, fixedPhaseError(ErrUnsafePath, "validate target parent")
		}

		nextFD, err := unix.Openat(
			parentFD,
			component,
			unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC,
			0,
		)
		if err != nil {
			return nil, fixedPhaseError(ErrUnsafePath, "open target parent")
		}
		nextIdentity, statErr := statIdentity(nextFD)
		if statErr != nil || !sameIdentity(beforeIdentity, nextIdentity) ||
			!sameFileType(beforeIdentity, nextIdentity) || !safeMutableDirectory(nextIdentity) {
			closeFD(&nextFD)
			return nil, fixedPhaseError(ErrUnsafePath, "verify target parent")
		}
		if err := verifyNamedMutableDirectory(parentFD, component, nextIdentity); err != nil {
			closeFD(&nextFD)
			return nil, redactPhaseError(err, ErrUnsafePath, "verify target parent name")
		}

		closeFD(&parentFD)
		parentFD = nextFD
	}
	if err := verifyMutableDirectory(parentFD); err != nil {
		return nil, redactPhaseError(err, ErrUnsafePath, "verify target sibling directory")
	}
	parentIdentity, err := statIdentity(parentFD)
	if err != nil || !safeMutableDirectory(parentIdentity) {
		return nil, fixedPhaseError(ErrUnsafePath, "bind target sibling directory")
	}

	keepParent = true
	return &targetHandle{
		parentFD:       parentFD,
		parentIdentity: parentIdentity,
		leaf:           components[len(components)-1],
	}, nil
}

func closeTargetHandle(handle *targetHandle) {
	if handle == nil {
		return
	}
	closeFD(&handle.parentFD)
	handle.parentIdentity = fileIdentity{}
	handle.leaf = ""
}

// openTargetLock takes the package's one persistent transaction lock in the
// descriptor-authoritative target parent. The deliberately coarse physical
// lock makes different labels and manager state roots serialize the same
// directory without relying on pathname spelling or filesystem case rules.
func openTargetLock(ctx context.Context, target *targetHandle) (int, error) {
	if err := validateTargetHandle(target); err != nil {
		return -1, redactPhaseError(err, ErrUnsafePath, "validate target lock")
	}
	if err := checkContext(ctx, "wait target lock"); err != nil {
		return -1, err
	}

	fd, err := openOwnedRegular(target.parentFD, targetLockName)
	if err != nil {
		return -1, redactPhaseError(err, ErrUnsafePath, "open target lock")
	}
	for {
		err = unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB)
		if err == nil {
			if err := verifyNamedOwnedFile(target.parentFD, targetLockName, fd); err != nil {
				unlockAndClose(&fd)
				return -1, redactPhaseError(err, ErrUnsafePath, "verify target lock")
			}
			if err := verifyMutableDirectory(target.parentFD); err != nil {
				unlockAndClose(&fd)
				return -1, redactPhaseError(err, ErrUnsafePath, "revalidate target lock parent")
			}
			return fd, nil
		}
		if !lockWouldBlock(err) {
			closeFD(&fd)
			return -1, fixedPhaseError(ErrUnsafePath, "acquire target lock")
		}
		if err := waitForContext(ctx, 10*time.Millisecond, "wait target lock"); err != nil {
			closeFD(&fd)
			return -1, err
		}
	}
}

// readCurrent binds the current named object to an open descriptor and hashes
// bounded bytes. A missing leaf is represented by an object with fd == -1.
func readCurrent(target *targetHandle, policy filePolicy) (*currentObject, error) {
	maximum, err := maximumForPolicy(policy)
	if err != nil {
		return nil, err
	}
	if err := validateTargetHandle(target); err != nil {
		return nil, redactPhaseError(err, ErrUnsafePath, "validate current target")
	}
	if err := verifyParentForPolicy(target.parentFD, policy); err != nil {
		return nil, redactPhaseError(err, ErrUnsafePath, "verify current parent")
	}
	parentIdentity, err := statIdentity(target.parentFD)
	if err != nil || !sameIdentity(parentIdentity, target.parentIdentity) {
		return nil, fixedPhaseError(ErrUnsafePath, "bind current parent")
	}

	var before unix.Stat_t
	if err := unix.Fstatat(target.parentFD, target.leaf, &before, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		if errors.Is(err, unix.ENOENT) {
			empty := sha256.Sum256(nil)
			return &currentObject{
				fd:             -1,
				exists:         false,
				digest:         empty,
				parentIdentity: parentIdentity,
				leaf:           target.leaf,
				policy:         policy,
				current: CurrentFile{
					Exists: false,
				},
			}, nil
		}
		return nil, fixedPhaseError(ErrUnsafePath, "stat current file")
	}
	beforeIdentity := identityFromStat(&before)
	if !safeRegularFile(beforeIdentity, policy) || !withinLimit(beforeIdentity.size, maximum) {
		return nil, fixedPhaseError(ErrUnsafePath, "validate current file")
	}

	fd, err := unix.Openat(
		target.parentFD,
		target.leaf,
		unix.O_RDONLY|unix.O_NONBLOCK|unix.O_NOFOLLOW|unix.O_CLOEXEC,
		0,
	)
	if err != nil {
		return nil, fixedPhaseError(ErrUnsafePath, "open current file")
	}
	keepFD := false
	defer func() {
		if !keepFD {
			closeFD(&fd)
		}
	}()

	identity, err := statIdentity(fd)
	if err != nil || !sameFileMetadata(beforeIdentity, identity) ||
		!safeRegularFile(identity, policy) || !withinLimit(identity.size, maximum) {
		return nil, fixedPhaseError(ErrUnsafePath, "verify current file")
	}
	contents, digest, err := readAllFD(fd, identity, maximum)
	if err != nil {
		return nil, redactPhaseError(err, ErrUnsafePath, "read current file")
	}
	if err := verifyNamedFile(target.parentFD, target.leaf, fd, identity, policy); err != nil {
		return nil, redactPhaseError(err, ErrUnsafePath, "verify current file name")
	}

	keepFD = true
	return &currentObject{
		fd:             fd,
		exists:         true,
		identity:       identity,
		digest:         digest,
		parentIdentity: parentIdentity,
		leaf:           target.leaf,
		policy:         policy,
		current: CurrentFile{
			Exists: true,
			Bytes:  contents,
		},
	}, nil
}

func closeCurrentObject(object *currentObject) {
	if object == nil {
		return
	}
	closeFD(&object.fd)
	object.current.Bytes = nil
	object.parentIdentity = fileIdentity{}
	object.leaf = ""
	object.policy = 0
}

// revalidateOriginal detects a changed, substituted, or unlinked original
// immediately before publication. Renameat still lacks a portable same-UID CAS.
func revalidateOriginal(target *targetHandle, original *currentObject, policy filePolicy) error {
	maximum, err := maximumForPolicy(policy)
	if err != nil {
		return err
	}
	if err := validateCurrentBinding(target, original, policy); err != nil {
		return redactPhaseError(err, ErrInvalid, "validate original binding")
	}
	if err := verifyParentForPolicy(target.parentFD, policy); err != nil {
		return redactPhaseError(err, ErrUnsafePath, "verify original parent")
	}

	if !original.exists {
		var named unix.Stat_t
		err := unix.Fstatat(target.parentFD, target.leaf, &named, unix.AT_SYMLINK_NOFOLLOW)
		if errors.Is(err, unix.ENOENT) {
			return nil
		}
		return fixedPhaseError(ErrConflict, "revalidate absent original")
	}
	if original.fd < 0 || !safeRegularFile(original.identity, policy) ||
		!withinLimit(original.identity.size, maximum) {
		return fixedPhaseError(ErrInvalid, "validate original descriptor")
	}

	if !namedMatchesOriginal(target.parentFD, target.leaf, original.identity, policy) {
		return fixedPhaseError(ErrConflict, "revalidate original name")
	}
	if err := verifyFileIdentity(original.fd, original.identity, policy); err != nil {
		return fixedPhaseError(ErrConflict, "revalidate original descriptor")
	}
	contents, digest, err := readAllFD(original.fd, original.identity, maximum)
	if err != nil || digest != original.digest || !bytes.Equal(contents, original.current.Bytes) {
		return fixedPhaseError(ErrConflict, "revalidate original bytes")
	}
	if !namedMatchesOriginal(target.parentFD, target.leaf, original.identity, policy) {
		return fixedPhaseError(ErrConflict, "revalidate original name")
	}
	return nil
}

// publishAtomic writes only a new sibling inode until the Renameat commit point.
// BLOCKED-portable-hostile-same-uid-final-rename-cas: the portable syscall set
// has no compare-and-swap rename, so advisory locks cannot prevent a hostile
// same-UID writer from replacing either checked name after final validation.
func publishAtomic(
	ctx context.Context,
	target *targetHandle,
	original *currentObject,
	candidate []byte,
	policy filePolicy,
) (result publishResult, err error) {
	result.commit = CommitUnchanged
	maximum, err := maximumForPolicy(policy)
	if err != nil {
		return result, err
	}
	if len(candidate) > maximum {
		return result, fixedPhaseError(ErrInvalid, "validate publication candidate")
	}
	candidate = cloneBytes(candidate)
	if err := validateCurrentBinding(target, original, policy); err != nil {
		return result, redactPhaseError(err, ErrInvalid, "validate publication binding")
	}
	if err := checkContext(ctx, "start publication"); err != nil {
		return result, err
	}
	if err := verifyParentForPolicy(target.parentFD, policy); err != nil {
		return result, redactPhaseError(err, ErrUnsafePath, "verify publication parent")
	}

	temporary, err := createTemporary(target.parentFD)
	if err != nil {
		return result, err
	}
	defer closeFD(&temporary.fd)

	if err := checkContext(ctx, "write publication"); err != nil {
		return result, err
	}
	if err := writeAllFD(temporary.fd, candidate); err != nil {
		return result, redactWriteError(err, "write publication")
	}
	if err := unix.Fsync(temporary.fd); err != nil {
		return result, fixedPhaseError(ErrUnsafePath, "fsync publication temp")
	}

	if err := verifyTemporaryCandidate(target.parentFD, temporary, candidate, maximum); err != nil {
		return result, redactPhaseError(err, ErrUnsafePath, "verify publication temp")
	}
	if err := revalidateOriginal(target, original, policy); err != nil {
		return result, err
	}
	if err := verifyTemporaryCandidate(target.parentFD, temporary, candidate, maximum); err != nil {
		return result, redactPhaseError(err, ErrUnsafePath, "revalidate publication temp")
	}
	if err := checkContext(ctx, "commit publication"); err != nil {
		return result, err
	}

	result.renameAttempted = true
	if err := unix.Renameat(target.parentFD, temporary.name, target.parentFD, target.leaf); err != nil {
		result.commit = CommitIndeterminate
		return result, fixedPhaseError(ErrIndeterminate, "rename publication")
	}
	result.renamed = true
	if err := verifyPublished(target.parentFD, target.leaf, temporary, candidate, maximum, policy); err != nil {
		result.commit = CommitIndeterminate
		return result, fixedPhaseError(ErrIndeterminate, "verify published file")
	}
	if err := unix.Fsync(target.parentFD); err != nil {
		result.commit = CommitIndeterminate
		return result, fixedPhaseError(ErrIndeterminate, "fsync published parent")
	}

	result.commit = CommitDurable
	return result, nil
}

func readAllFD(fd int, expected fileIdentity, maximum int) ([]byte, [sha256.Size]byte, error) {
	var empty [sha256.Size]byte
	if fd < 0 || maximum < 0 || !withinLimit(expected.size, maximum) {
		return nil, empty, fixedPhaseError(ErrUnsafePath, "validate bounded read")
	}
	actual, err := statIdentity(fd)
	if err != nil || !sameFileMetadata(actual, expected) {
		return nil, empty, fixedPhaseError(ErrUnsafePath, "verify read identity")
	}

	contents := make([]byte, int(expected.size))
	for offset := 0; offset < len(contents); {
		count, readErr := unix.Pread(fd, contents[offset:], int64(offset))
		if count < 0 || count > len(contents)-offset {
			return nil, empty, fixedPhaseError(ErrUnsafePath, "invalid current read")
		}
		if count > 0 {
			offset += count
		}
		if readErr != nil {
			return nil, empty, fixedPhaseError(ErrUnsafePath, "pread current file")
		}
		if count == 0 {
			return nil, empty, fixedPhaseError(ErrUnsafePath, "short current file")
		}
	}

	var extra [1]byte
	count, readErr := unix.Pread(fd, extra[:], expected.size)
	if readErr != nil || count != 0 {
		return nil, empty, fixedPhaseError(ErrUnsafePath, "growth current file")
	}
	actual, err = statIdentity(fd)
	if err != nil || !sameFileMetadata(actual, expected) {
		return nil, empty, fixedPhaseError(ErrUnsafePath, "recheck read identity")
	}
	return contents, sha256.Sum256(contents), nil
}

func writeAllFD(fd int, contents []byte) error {
	if fd < 0 {
		return fixedPhaseError(ErrUnsafePath, "validate write file")
	}
	for len(contents) > 0 {
		count, err := unix.Write(fd, contents)
		if err != nil {
			return fixedPhaseError(ErrUnsafePath, "write file")
		}
		if count <= 0 {
			return io.ErrShortWrite
		}
		if count > len(contents) {
			return fixedPhaseError(ErrUnsafePath, "invalid write count")
		}
		contents = contents[count:]
	}
	return nil
}

func statIdentity(fd int) (fileIdentity, error) {
	if fd < 0 {
		return fileIdentity{}, fixedPhaseError(ErrUnsafePath, "validate descriptor")
	}
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		return fileIdentity{}, fixedPhaseError(ErrUnsafePath, "stat descriptor")
	}
	return identityFromStat(&stat), nil
}

func verifyDirectoryIdentity(fd int, device uint64, inode uint64) error {
	identity, err := statIdentity(fd)
	if err != nil || identity.device != device || identity.inode != inode ||
		!safeFinalRoot(identity, false) {
		return fixedPhaseError(ErrUnsafePath, "verify directory identity")
	}
	return nil
}

func verifyFileIdentity(fd int, expected fileIdentity, policy filePolicy) error {
	if _, err := maximumForPolicy(policy); err != nil {
		return err
	}
	actual, err := statIdentity(fd)
	if err != nil || !sameFileMetadata(actual, expected) || !safeRegularFile(actual, policy) {
		return fixedPhaseError(ErrUnsafePath, "verify file identity")
	}
	return nil
}

func sameIdentity(left, right fileIdentity) bool {
	return left.inode != 0 && left.device == right.device && left.inode == right.inode
}

func duplicateCloseOnExec(fd int) (int, error) {
	if fd < 0 {
		return -1, fixedPhaseError(ErrUnsafePath, "validate duplicate descriptor")
	}
	duplicated, err := unix.FcntlInt(uintptr(fd), unix.F_DUPFD_CLOEXEC, 0)
	if err != nil {
		return -1, fixedPhaseError(ErrUnsafePath, "duplicate descriptor")
	}
	return duplicated, nil
}

func validateCurrentBinding(target *targetHandle, object *currentObject, policy filePolicy) error {
	if err := validateTargetHandle(target); err != nil {
		return redactPhaseError(err, ErrUnsafePath, "validate bound target")
	}
	if _, err := maximumForPolicy(policy); err != nil {
		return err
	}
	if object == nil || object.exists != object.current.Exists ||
		object.policy != policy || object.leaf != target.leaf ||
		!sameIdentity(object.parentIdentity, target.parentIdentity) {
		return fixedPhaseError(ErrInvalid, "current object binding")
	}
	actual, err := statIdentity(target.parentFD)
	if err != nil || !sameIdentity(actual, object.parentIdentity) {
		return fixedPhaseError(ErrInvalid, "current object parent binding")
	}
	return nil
}

func closeFD(fd *int) {
	if fd == nil || *fd < 0 {
		return
	}
	_ = unix.Close(*fd)
	*fd = -1
}

func unlockAndClose(fd *int) {
	if fd == nil || *fd < 0 {
		return
	}
	_ = unix.Flock(*fd, unix.LOCK_UN)
	closeFD(fd)
}

func createTemporary(parentFD int) (*tempObject, error) {
	if err := verifyMutableDirectory(parentFD); err != nil {
		return nil, redactPhaseError(err, ErrUnsafePath, "verify temp parent")
	}
	for attempt := 0; attempt < maxTempAttempts; attempt++ {
		var random [16]byte
		count, err := rand.Read(random[:])
		if err != nil || count != len(random) {
			return nil, fixedPhaseError(ErrUnsafePath, "generate temp name")
		}
		name := tempPrefix + hex.EncodeToString(random[:])
		fd, err := unix.Openat(
			parentFD,
			name,
			unix.O_RDWR|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC,
			0o600,
		)
		if errors.Is(err, unix.EEXIST) {
			continue
		}
		if err != nil {
			return nil, fixedPhaseError(ErrUnsafePath, "create temp")
		}
		temporary := &tempObject{fd: fd, name: name}
		if err := unix.Fchmod(fd, 0o600); err != nil {
			closeFD(&temporary.fd)
			return nil, fixedPhaseError(ErrUnsafePath, "chmod temp")
		}
		identity, statErr := statIdentity(fd)
		if statErr != nil || !safeRegularFile(identity, filePolicyOwned) {
			closeFD(&temporary.fd)
			return nil, fixedPhaseError(ErrUnsafePath, "verify temp")
		}
		temporary.identity = identity
		if !namedMatchesTemporary(parentFD, name, fd, identity) {
			closeFD(&temporary.fd)
			return nil, fixedPhaseError(ErrUnsafePath, "verify temp name")
		}
		return temporary, nil
	}
	return nil, fixedPhaseError(ErrBusy, "allocate temp")
}

// verifyTemporaryCandidate binds the random name and descriptor to one complete
// candidate. Failure paths only close the descriptor: pathname unlink cannot be
// made identity-conditional portably, so a reserved 0600 orphan is safer than
// deleting an attacker-substituted object.
func verifyTemporaryCandidate(
	parentFD int,
	temporary *tempObject,
	candidate []byte,
	maximum int,
) error {
	if temporary == nil || temporary.fd < 0 || !validTemporaryName(temporary.name) {
		return fixedPhaseError(ErrUnsafePath, "validate temp candidate")
	}
	if err := verifyMutableDirectory(parentFD); err != nil {
		return redactPhaseError(err, ErrUnsafePath, "verify temp candidate parent")
	}
	identity, err := statIdentity(temporary.fd)
	if err != nil || !sameIdentity(identity, temporary.identity) ||
		!safeRegularFile(identity, filePolicyOwned) ||
		identity.size != int64(len(candidate)) {
		return fixedPhaseError(ErrUnsafePath, "verify temp candidate identity")
	}
	contents, digest, err := readAllFD(temporary.fd, identity, maximum)
	if err != nil || digest != sha256.Sum256(candidate) || !bytes.Equal(contents, candidate) {
		return fixedPhaseError(ErrUnsafePath, "verify temp candidate bytes")
	}
	if err := verifyNamedFile(parentFD, temporary.name, temporary.fd, identity, filePolicyOwned); err != nil {
		return redactPhaseError(err, ErrUnsafePath, "verify temp candidate name")
	}
	temporary.identity = identity
	temporary.digest = digest
	return nil
}

func verifyPublished(
	parentFD int,
	leaf string,
	temporary *tempObject,
	candidate []byte,
	maximum int,
	parentPolicy filePolicy,
) error {
	if temporary == nil || temporary.fd < 0 || !validLeaf(leaf) {
		return fixedPhaseError(ErrUnsafePath, "validate published file")
	}
	if err := verifyParentForPolicy(parentFD, parentPolicy); err != nil {
		return redactPhaseError(err, ErrUnsafePath, "verify published parent")
	}
	var named unix.Stat_t
	if err := unix.Fstatat(parentFD, leaf, &named, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return fixedPhaseError(ErrUnsafePath, "stat published file")
	}
	beforeIdentity := identityFromStat(&named)
	if !sameFileMetadata(beforeIdentity, temporary.identity) ||
		!safeRegularFile(beforeIdentity, filePolicyOwned) {
		return fixedPhaseError(ErrUnsafePath, "validate published file")
	}
	fd, err := unix.Openat(
		parentFD,
		leaf,
		unix.O_RDONLY|unix.O_NONBLOCK|unix.O_NOFOLLOW|unix.O_CLOEXEC,
		0,
	)
	if err != nil {
		return fixedPhaseError(ErrUnsafePath, "open published file")
	}
	defer closeFD(&fd)

	identity, err := statIdentity(fd)
	if err != nil || !sameFileMetadata(identity, beforeIdentity) ||
		!sameFileMetadata(identity, temporary.identity) || !safeRegularFile(identity, filePolicyOwned) {
		return fixedPhaseError(ErrUnsafePath, "verify published identity")
	}
	contents, digest, err := readAllFD(fd, temporary.identity, maximum)
	if err != nil || digest != temporary.digest || !bytes.Equal(contents, candidate) {
		return fixedPhaseError(ErrUnsafePath, "verify published bytes")
	}
	if err := verifyNamedFile(parentFD, leaf, fd, temporary.identity, filePolicyOwned); err != nil {
		return redactPhaseError(err, ErrUnsafePath, "recheck published name")
	}
	return nil
}

func openOwnedRegular(parentFD int, name string) (int, error) {
	if !validOwnedName(name) {
		return -1, fixedPhaseError(ErrInvalid, "validate owned file name")
	}
	if err := verifyMutableDirectory(parentFD); err != nil {
		return -1, redactPhaseError(err, ErrUnsafePath, "verify owned file parent")
	}
	for attempt := 0; attempt < 4; attempt++ {
		var before unix.Stat_t
		err := unix.Fstatat(parentFD, name, &before, unix.AT_SYMLINK_NOFOLLOW)
		if errors.Is(err, unix.ENOENT) {
			fd, createErr := unix.Openat(
				parentFD,
				name,
				unix.O_RDWR|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC,
				0o600,
			)
			if errors.Is(createErr, unix.EEXIST) {
				continue
			}
			if createErr != nil {
				return -1, fixedPhaseError(ErrUnsafePath, "create owned file")
			}
			if err := unix.Fchmod(fd, 0o600); err != nil {
				closeFD(&fd)
				return -1, fixedPhaseError(ErrUnsafePath, "chmod owned file")
			}
			identity, statErr := statIdentity(fd)
			if statErr != nil || !safeRegularFile(identity, filePolicyOwned) ||
				!namedMatchesTemporary(parentFD, name, fd, identity) {
				closeFD(&fd)
				return -1, fixedPhaseError(ErrUnsafePath, "verify created owned file")
			}
			if err := unix.Fsync(fd); err != nil {
				closeFD(&fd)
				return -1, fixedPhaseError(ErrUnsafePath, "fsync owned file")
			}
			if err := unix.Fsync(parentFD); err != nil {
				closeFD(&fd)
				return -1, fixedPhaseError(ErrUnsafePath, "fsync owned file parent")
			}
			return fd, nil
		}
		if err != nil {
			return -1, fixedPhaseError(ErrUnsafePath, "stat owned file")
		}

		beforeIdentity := identityFromStat(&before)
		if !safeRegularFile(beforeIdentity, filePolicyOwned) {
			return -1, fixedPhaseError(ErrUnsafePath, "validate owned file")
		}
		fd, openErr := unix.Openat(
			parentFD,
			name,
			unix.O_RDWR|unix.O_NONBLOCK|unix.O_NOFOLLOW|unix.O_CLOEXEC,
			0,
		)
		if openErr != nil {
			return -1, fixedPhaseError(ErrUnsafePath, "open owned file")
		}
		identity, statErr := statIdentity(fd)
		if statErr != nil || !sameFileMetadata(beforeIdentity, identity) ||
			!safeRegularFile(identity, filePolicyOwned) ||
			!namedMatchesTemporary(parentFD, name, fd, identity) {
			closeFD(&fd)
			return -1, fixedPhaseError(ErrUnsafePath, "verify owned file")
		}
		return fd, nil
	}
	return -1, fixedPhaseError(ErrBusy, "open owned file")
}

func verifyPrivateStateRoot(root *rootHandle) error {
	if err := verifyDirectoryIdentity(root.fd, root.device, root.inode); err != nil {
		return err
	}
	identity, err := statIdentity(root.fd)
	if err != nil || modePermissions(identity.mode) != 0o700 {
		return fixedPhaseError(ErrUnsafePath, "verify state root mode")
	}
	return nil
}

func verifyAncestorDirectory(fd int) error {
	identity, err := statIdentity(fd)
	if err != nil || !safeAncestorDirectory(identity) {
		return fixedPhaseError(ErrUnsafePath, "verify ancestor directory")
	}
	return nil
}

func verifyMutableDirectory(fd int) error {
	identity, err := statIdentity(fd)
	if err != nil || !safeMutableDirectory(identity) {
		return fixedPhaseError(ErrUnsafePath, "verify mutable directory")
	}
	return nil
}

func verifyParentForPolicy(fd int, policy filePolicy) error {
	identity, err := statIdentity(fd)
	if err != nil {
		return fixedPhaseError(ErrUnsafePath, "stat publication parent")
	}
	switch policy {
	case filePolicyConfig:
		if !safeMutableDirectory(identity) {
			return fixedPhaseError(ErrUnsafePath, "verify config parent")
		}
	case filePolicyOwned:
		if !safeFinalRoot(identity, true) {
			return fixedPhaseError(ErrUnsafePath, "verify manifest parent")
		}
	default:
		return fixedPhaseError(ErrInvalid, "file policy")
	}
	return nil
}

func verifyNamedDirectory(parentFD int, name string, expected fileIdentity) error {
	var named unix.Stat_t
	if err := unix.Fstatat(parentFD, name, &named, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return fixedPhaseError(ErrUnsafePath, "stat directory name")
	}
	identity := identityFromStat(&named)
	if !sameIdentity(identity, expected) || !sameFileType(identity, expected) ||
		!safeAncestorDirectory(identity) {
		return fixedPhaseError(ErrUnsafePath, "verify directory name")
	}
	return nil
}

func verifyNamedMutableDirectory(parentFD int, name string, expected fileIdentity) error {
	var named unix.Stat_t
	if err := unix.Fstatat(parentFD, name, &named, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return fixedPhaseError(ErrUnsafePath, "stat mutable directory name")
	}
	identity := identityFromStat(&named)
	if !sameIdentity(identity, expected) || !sameFileType(identity, expected) ||
		!safeMutableDirectory(identity) {
		return fixedPhaseError(ErrUnsafePath, "verify mutable directory name")
	}
	return nil
}

func verifyNamedFile(parentFD int, name string, fd int, expected fileIdentity, policy filePolicy) error {
	var named unix.Stat_t
	if err := unix.Fstatat(parentFD, name, &named, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return fixedPhaseError(ErrUnsafePath, "stat file name")
	}
	identity := identityFromStat(&named)
	if !sameFileMetadata(identity, expected) || !safeRegularFile(identity, policy) {
		return fixedPhaseError(ErrUnsafePath, "verify file name")
	}
	return verifyFileIdentity(fd, expected, policy)
}

func verifyNamedOwnedFile(parentFD int, name string, fd int) error {
	identity, err := statIdentity(fd)
	if err != nil || !safeRegularFile(identity, filePolicyOwned) {
		return fixedPhaseError(ErrUnsafePath, "verify owned file descriptor")
	}
	return verifyNamedFile(parentFD, name, fd, identity, filePolicyOwned)
}

func namedMatchesOriginal(parentFD int, name string, expected fileIdentity, policy filePolicy) bool {
	var named unix.Stat_t
	if err := unix.Fstatat(parentFD, name, &named, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return false
	}
	identity := identityFromStat(&named)
	return sameFileMetadata(identity, expected) && safeRegularFile(identity, policy)
}

func namedMatchesTemporary(parentFD int, name string, fd int, expected fileIdentity) bool {
	if fd < 0 {
		return false
	}
	var named unix.Stat_t
	if err := unix.Fstatat(parentFD, name, &named, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return false
	}
	namedIdentity := identityFromStat(&named)
	actual, err := statIdentity(fd)
	return err == nil && sameIdentity(namedIdentity, expected) && sameIdentity(actual, expected) &&
		sameIdentity(namedIdentity, actual) && safeRegularFile(namedIdentity, filePolicyOwned) &&
		safeRegularFile(actual, filePolicyOwned)
}

func maximumForPolicy(policy filePolicy) (int, error) {
	switch policy {
	case filePolicyConfig:
		return maxConfigBytes, nil
	case filePolicyOwned:
		return maxManifestBytes, nil
	default:
		return 0, fixedPhaseError(ErrInvalid, "file policy")
	}
}

func validateTargetHandle(target *targetHandle) error {
	if target == nil || target.parentFD < 0 || !validLeaf(target.leaf) ||
		target.parentIdentity.inode == 0 {
		return fixedPhaseError(ErrUnsafePath, "target handle")
	}
	actual, err := statIdentity(target.parentFD)
	if err != nil || !sameIdentity(actual, target.parentIdentity) || !safeMutableDirectory(actual) {
		return fixedPhaseError(ErrUnsafePath, "target handle identity")
	}
	return nil
}

func validLeaf(value string) bool {
	if value == "" || value == "." || value == ".." || len(value) > maxPathComponentBytes ||
		strings.ContainsRune(value, '\x00') || strings.ContainsRune(value, '\\') || strings.Contains(value, "/") {
		return false
	}
	for index := 0; index < len(value); index++ {
		if !isPathComponentByte(value[index]) {
			return false
		}
	}
	return true
}

func validOwnedName(value string) bool {
	return value == managerLockName || value == targetLockName
}

func validTemporaryName(value string) bool {
	return strings.HasPrefix(value, tempPrefix) && len(value) == len(tempPrefix)+32 &&
		isLowerHex(value[len(tempPrefix):])
}

func isLowerHex(value string) bool {
	for index := 0; index < len(value); index++ {
		if (value[index] < '0' || value[index] > '9') && (value[index] < 'a' || value[index] > 'f') {
			return false
		}
	}
	return true
}

func safeAncestorDirectory(identity fileIdentity) bool {
	return sameFileType(identity, fileIdentity{mode: uint32(unix.S_IFDIR)}) &&
		(identity.uid == effectiveUID() || identity.uid == 0) &&
		modePermissions(identity.mode)&0o022 == 0 && modePermissions(identity.mode)&0o500 == 0o500
}

func safeMutableDirectory(identity fileIdentity) bool {
	return sameFileType(identity, fileIdentity{mode: uint32(unix.S_IFDIR)}) &&
		identity.uid == effectiveUID() && modePermissions(identity.mode)&0o022 == 0 &&
		modePermissions(identity.mode)&0o500 == 0o500
}

func safeFinalRoot(identity fileIdentity, stateRoot bool) bool {
	if !sameFileType(identity, fileIdentity{mode: uint32(unix.S_IFDIR)}) || identity.uid != effectiveUID() {
		return false
	}
	permissions := modePermissions(identity.mode)
	if stateRoot {
		return permissions == 0o700
	}
	return permissions&0o022 == 0 && permissions&0o500 == 0o500
}

func safeRegularFile(identity fileIdentity, policy filePolicy) bool {
	if !sameFileType(identity, fileIdentity{mode: uint32(unix.S_IFREG)}) || identity.uid != effectiveUID() ||
		identity.nlink != 1 {
		return false
	}
	permissions := modePermissions(identity.mode)
	switch policy {
	case filePolicyConfig:
		return permissions&0o022 == 0 && permissions&0o7000 == 0
	case filePolicyOwned:
		return permissions == 0o600
	default:
		return false
	}
}

func withinLimit(size int64, maximum int) bool {
	return size >= 0 && maximum >= 0 && size <= int64(maximum)
}

func identityFromStat(stat *unix.Stat_t) fileIdentity {
	return fileIdentity{
		device: uint64(stat.Dev),
		inode:  uint64(stat.Ino),
		mode:   uint32(stat.Mode),
		nlink:  uint64(stat.Nlink),
		uid:    uint32(stat.Uid),
		size:   int64(stat.Size),
	}
}

func sameFileMetadata(left, right fileIdentity) bool {
	return sameIdentity(left, right) && left.mode == right.mode && left.nlink == right.nlink &&
		left.uid == right.uid && left.size == right.size
}

func sameFileType(left, right fileIdentity) bool {
	return left.mode&uint32(unix.S_IFMT) == right.mode&uint32(unix.S_IFMT)
}

func modePermissions(mode uint32) uint32 {
	return mode & 0o7777
}

func effectiveUID() uint32 {
	return uint32(os.Geteuid())
}

func lockWouldBlock(err error) bool {
	return errors.Is(err, unix.EWOULDBLOCK) || errors.Is(err, unix.EAGAIN)
}

func checkContext(ctx context.Context, phase string) error {
	if ctx == nil {
		return nil
	}
	select {
	case <-ctx.Done():
		return fixedPhaseError(ErrBusy, phase)
	default:
		return nil
	}
}

func waitForContext(ctx context.Context, delay time.Duration, phase string) error {
	if ctx == nil {
		time.Sleep(delay)
		return nil
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return fixedPhaseError(ErrBusy, phase)
	case <-timer.C:
		return nil
	}
}

func redactWriteError(err error, phase string) error {
	if errors.Is(err, io.ErrShortWrite) {
		return fixedPhaseError(ErrUnsafePath, phase)
	}
	return redactPhaseError(err, ErrUnsafePath, phase)
}

// Darwin environment fact: /tmp resolves through a symlink to world-writable
// /private/tmp. Production traversal intentionally grants it no exception, so
// external primitive probes must open their final owner-only fixture descriptors
// directly rather than misrepresenting /tmp ancestry as production-safe.
