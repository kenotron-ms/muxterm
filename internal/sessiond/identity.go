package sessiond

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/kenotron-ms/muxterm/internal/atomicfile"
)

// machineIdentity is deliberately separate from snapshots and runtime state.
// It identifies one muxterm installation and survives daemon restarts; the
// daemon incarnation changes on each Server construction.
type machineIdentity struct {
	MachineID string    `json:"machine_id"`
	CreatedAt time.Time `json:"created_at"`
}

// MissionControlIdentity is the read-only result of the sessiond capability
// handshake. It intentionally advertises identity only, never threaded
// execution or voice support.
type MissionControlIdentity struct {
	ProtocolVersion   int    `json:"missioncontrolProtocolVersion"`
	MachineID         string `json:"machineId"`
	DaemonIncarnation string `json:"daemonIncarnation"`
}

const MissionControlIdentityProtocolVersion = 1

func missionControlIdentityPath() string {
	return filepath.Join(snapshotDir(), "missioncontrol", "machine-identity.json")
}

func loadOrCreateMachineIdentity() (machineIdentity, error) {
	path := missionControlIdentityPath()
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return machineIdentity{}, fmt.Errorf("sessiond: create machine identity dir: %w", err)
	}
	lock, err := os.OpenFile(path+".lock", os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return machineIdentity{}, fmt.Errorf("sessiond: open machine identity lock: %w", err)
	}
	defer func() {
		_ = syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
		_ = lock.Close()
	}()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return machineIdentity{}, fmt.Errorf("sessiond: lock machine identity: %w", err)
	}

	data, err := os.ReadFile(path)
	if err == nil {
		var identity machineIdentity
		if err := json.Unmarshal(data, &identity); err != nil {
			return machineIdentity{}, fmt.Errorf("sessiond: parse machine identity: %w", err)
		}
		if parsed, err := uuid.Parse(identity.MachineID); err != nil || parsed == uuid.Nil {
			return machineIdentity{}, errors.New("sessiond: machine identity is invalid; refusing to replace it")
		}
		return identity, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return machineIdentity{}, fmt.Errorf("sessiond: read machine identity: %w", err)
	}

	identity := machineIdentity{MachineID: uuid.New().String(), CreatedAt: time.Now().UTC()}
	encoded, err := json.Marshal(identity)
	if err != nil {
		return machineIdentity{}, fmt.Errorf("sessiond: encode machine identity: %w", err)
	}
	if err := atomicfile.Write(path, encoded, 0o600); err != nil {
		return machineIdentity{}, fmt.Errorf("sessiond: publish machine identity: %w", err)
	}
	return identity, nil
}
