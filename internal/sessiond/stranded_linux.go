//go:build linux

package sessiond

import (
	"bufio"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// unixStateListening is the /proc/net/unix "St" column value for a socket in
// LISTENING state. The file's columns are:
//
//	Num RefCount Protocol Flags Type St Inode Path
//	 $1    $2       $3     $4    $5  $6  $7    $8
const unixStateListening = "01"

// FindStrandedListener reports whether a daemon is listening on a socket bound
// to path while no file exists at path -- the unreachable-but-alive state.
//
// Why /proc/net/unix is the only source that can answer this: the socket's
// bound name is recorded in the kernel at bind() time and SURVIVES the unlink,
// so it is still listed here long after `ls` says the file is gone. There is
// no filesystem-level way to observe the same fact, which is exactly why this
// failure is invisible without it.
//
// The stat check comes first and is the cheap disqualifier: if the name
// exists, nothing is stranded, whatever else may be true.
func FindStrandedListener(path string) (*StrandedDaemon, bool) {
	if path == "" {
		return nil, false
	}
	if _, err := os.Stat(path); err == nil {
		// The name exists. Whether it works is a different question, and not
		// this one -- a live socket and a stale file both land here.
		return nil, false
	}

	f, err := os.Open("/proc/net/unix")
	if err != nil {
		return nil, false
	}
	defer f.Close() //nolint:errcheck

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 8 {
			continue
		}
		if fields[5] != unixStateListening || fields[7] != path {
			continue
		}
		inode, convErr := strconv.ParseUint(fields[6], 10, 64)
		if convErr != nil {
			continue
		}
		return &StrandedDaemon{
			Path:  path,
			Inode: inode,
			PID:   pidHoldingSocketInode(inode),
		}, true
	}
	return nil, false
}

// pidHoldingSocketInode finds the process holding the socket with this inode
// by scanning /proc/<pid>/fd for the "socket:[<inode>]" symlink target.
//
// Returns 0 rather than guessing when nothing matches -- which is the normal
// outcome for a socket owned by another user, since their /proc/<pid>/fd is
// not readable. A wrong pid here would be printed in a `kill` command, so
// "unknown" is the only acceptable failure mode.
func pidHoldingSocketInode(inode uint64) int {
	want := "socket:[" + strconv.FormatUint(inode, 10) + "]"

	entries, err := os.ReadDir("/proc")
	if err != nil {
		return 0
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		pid, convErr := strconv.Atoi(entry.Name())
		if convErr != nil {
			continue
		}
		fdDir := filepath.Join("/proc", entry.Name(), "fd")
		fds, readErr := os.ReadDir(fdDir)
		if readErr != nil {
			continue // not ours to read; skip rather than guess
		}
		for _, fd := range fds {
			target, linkErr := os.Readlink(filepath.Join(fdDir, fd.Name()))
			if linkErr == nil && target == want {
				return pid
			}
		}
	}
	return 0
}
