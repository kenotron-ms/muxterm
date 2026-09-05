package sshconfig

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// configMode is the permission an ssh client config must have. 0600 is not
// cosmetic: the file names key material and, for some options, is refused by
// ssh outright when it is group- or world-writable.
const configMode fs.FileMode = 0o600

// sshDirMode is the permission for a freshly created ~/.ssh.
const sshDirMode fs.FileMode = 0o700

// backupSuffix prefixes the timestamp in a backup file name, so backups sort
// next to the config they came from and are obviously muxterm's doing.
const backupSuffix = ".muxterm-backup-"

// maxBackupAttempts bounds the search for an unused backup name within one
// timestamp second.
const maxBackupAttempts = 100

// ensureBackup copies the pre-edit contents to a timestamped sibling, ONCE per
// Manager (i.e. once per command invocation).
//
// Once per invocation is the right granularity: a backup exists so the user can
// undo what this command did, and a second copy taken after the first write
// would capture muxterm's own output rather than the state worth restoring.
//
// original is the exact content the edit was computed from, not a fresh read:
// backing up anything else could preserve a state that was never the input.
//
// The backup file is created with O_EXCL and given a numbered suffix on
// collision, so a backup written by an earlier run in the same second can never
// be silently overwritten — the one failure mode that would destroy the very
// thing being protected.
func (m *Manager) ensureBackup(original string, existed bool) error {
	if m.backupDone {
		return nil
	}
	if !existed {
		// Nothing to back up: the file is about to be created. Mark it done so
		// a later write in the same invocation does not suddenly produce one.
		m.backupDone = true
		return nil
	}

	base := m.path + backupSuffix + time.Now().Format("20060102T150405")
	path := base
	for n := 2; ; n++ {
		f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, configMode)
		if errors.Is(err, fs.ErrExist) {
			if n > maxBackupAttempts {
				return fmt.Errorf("backup %s: %d names already taken", base, maxBackupAttempts)
			}
			path = fmt.Sprintf("%s-%d", base, n)
			continue
		}
		if err != nil {
			return fmt.Errorf("create backup %s: %w", path, err)
		}
		if err := writeSyncClose(f, original); err != nil {
			_ = os.Remove(path)
			return fmt.Errorf("write backup %s: %w", path, err)
		}
		m.backupPath = path
		m.backupDone = true
		return nil
	}
}

// atomicWrite replaces path's contents with content, atomically.
//
// Write-temp-then-rename is what makes a crash safe: rename(2) within a
// directory is atomic, so a reader (ssh, mid-connection) sees either the whole
// old file or the whole new one, never a truncated config — which for this file
// would mean losing the user's keys and jump hosts to a power cut.
//
// The temp file is a SIBLING so the rename stays within one filesystem, and it
// is created 0600 before it holds anything, so the contents are never briefly
// readable by others.
func atomicWrite(path, content string) (err error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, sshDirMode); err != nil {
		return fmt.Errorf("create %s: %w", dir, err)
	}

	f, err := os.CreateTemp(dir, ".muxterm-ssh-config-*")
	if err != nil {
		return fmt.Errorf("create temp file in %s: %w", dir, err)
	}
	tmp := f.Name()
	defer func() {
		// A no-op once the rename has succeeded; on any failure path this is
		// what stops a half-written temp file from being left behind.
		if err != nil {
			_ = os.Remove(tmp)
		}
	}()

	if err = f.Chmod(configMode); err != nil {
		_ = f.Close()
		return fmt.Errorf("chmod temp file: %w", err)
	}
	if err = writeSyncClose(f, content); err != nil {
		return fmt.Errorf("write temp file: %w", err)
	}
	if err = os.Rename(tmp, path); err != nil {
		return fmt.Errorf("replace %s: %w", path, err)
	}
	// fsync the directory so the rename itself survives a crash, not just the
	// bytes it points at.
	if d, derr := os.Open(dir); derr == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}

// writeSyncClose writes content to f, flushes it to disk, and closes f. The
// Sync is what makes the subsequent rename meaningful: without it the rename
// could land while the data is still only in the page cache.
func writeSyncClose(f *os.File, content string) error {
	if _, err := f.WriteString(content); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}
