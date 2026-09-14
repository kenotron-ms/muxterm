package workspaceauth

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// DefaultOwnerPath is private XDG data state, deliberately separate from
// config.toml and every browser/sessiond wire surface.
func DefaultOwnerPath() string {
	base := os.Getenv("XDG_DATA_HOME")
	if base == "" {
		base = filepath.Join(os.Getenv("HOME"), ".local", "share")
	}
	return filepath.Join(base, "muxterm", "instance-owner.json")
}

// LoadOwner loads and validates the private owner record.
func LoadOwner(path string) (InstanceOwner, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return InstanceOwner{}, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
		return InstanceOwner{}, errors.New("invalid owner record")
	}
	if !ownedByCurrentUser(info) {
		return InstanceOwner{}, errors.New("invalid owner record")
	}
	dir, err := os.Lstat(filepath.Dir(path))
	if err != nil || !dir.IsDir() || dir.Mode().Perm() != 0o700 || !ownedByCurrentUser(dir) {
		return InstanceOwner{}, errors.New("invalid owner record")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return InstanceOwner{}, err
	}
	var owner InstanceOwner
	if err := json.Unmarshal(data, &owner); err != nil {
		return InstanceOwner{}, errors.New("invalid owner record")
	}
	if err := owner.Validate(); err != nil {
		return InstanceOwner{}, errors.New("invalid owner record")
	}
	return owner, nil
}

// LoadOrCreateOwner reads path or atomically creates it only when it is
// missing. Exclusive creation prevents two simultaneous first starts from
// replacing each other's owner record; a losing process reloads the winner.
// A corrupt or inaccessible record is never replaced.
func LoadOrCreateOwner(path string) (InstanceOwner, error) {
	owner, err := LoadOwner(path)
	if err == nil {
		return owner, nil
	}
	if !os.IsNotExist(err) {
		return InstanceOwner{}, errors.New("owner record unavailable")
	}
	if err := ensureOwnerDir(filepath.Dir(path)); err != nil {
		return InstanceOwner{}, errors.New("owner record unavailable")
	}
	owner, err = NewEphemeralOwner()
	if err != nil {
		return InstanceOwner{}, errors.New("owner record unavailable")
	}
	if err := createOwnerExclusive(path, owner); err == nil {
		return owner, nil
	} else if !os.IsExist(err) {
		return InstanceOwner{}, errors.New("owner record unavailable")
	}
	for i := 0; i < 20; i++ {
		winner, err := LoadOwner(path)
		if err == nil {
			return winner, nil
		}
		time.Sleep(10 * time.Millisecond)
	}
	return InstanceOwner{}, errors.New("owner record unavailable")
}

// WriteOwner atomically writes a validated private record. The parent and
// resulting file are explicitly private even when they already existed.
func WriteOwner(path string, owner InstanceOwner) error {
	if err := owner.Validate(); err != nil {
		return errors.New("invalid owner record")
	}
	dir := filepath.Dir(path)
	if err := ensureOwnerDir(dir); err != nil {
		return err
	}
	data, err := json.Marshal(owner)
	if err != nil {
		return errors.New("encode owner record")
	}
	tmp, err := os.CreateTemp(dir, ".instance-owner-*")
	if err != nil {
		return errors.New("write owner record")
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return errors.New("secure owner record")
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return errors.New("write owner record")
	}
	if err := tmp.Close(); err != nil {
		return errors.New("write owner record")
	}
	if err := os.Rename(tmpName, path); err != nil {
		return errors.New("write owner record")
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return errors.New("secure owner record")
	}
	return nil
}

func ensureOwnerDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create owner directory")
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return fmt.Errorf("secure owner directory")
	}
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode().Perm() != 0o700 || !ownedByCurrentUser(info) {
		return errors.New("secure owner directory")
	}
	return nil
}

func createOwnerExclusive(path string, owner InstanceOwner) error {
	data, err := json.Marshal(owner)
	if err != nil {
		return errors.New("encode owner record")
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	ok := false
	defer func() {
		file.Close()
		if !ok {
			_ = os.Remove(path)
		}
	}()
	if _, err := file.Write(data); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Chmod(0o600); err != nil {
		return err
	}
	ok = true
	return nil
}
