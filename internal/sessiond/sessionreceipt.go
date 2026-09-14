package sessiond

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

const (
	sessionReceiptDirName       = ".receipts"
	maxSessionReceiptOutcomes   = 256
	maxSessionReceiptBytes      = 4 << 10
	newSessionSnapshotPublisher = "hooks-muxterm-session/0.7.0"
)

type sessionReceipt struct {
	V              int    `json:"v"`
	SessionID      string `json:"sessionId"`
	PID            int    `json:"pid"`
	PIDStart       uint64 `json:"pidStart"`
	Publisher      string `json:"publisher"`
	Status         string `json:"status"`
	Code           string `json:"code"`
	SnapshotSHA256 string `json:"snapshotSha256"`
	CollectorPID   int    `json:"collectorPid"`
	CollectorStart uint64 `json:"collectorStart"`
	ObservedAt     int64  `json:"observedAt"`
	WorkspaceID    string `json:"workspaceId,omitempty"`
	PaneID         int    `json:"paneId,omitempty"`
}

// readSessionSnapshot reads one producer document through a descriptor that
// cannot be redirected to a symlink or blocking FIFO after directory discovery.
// It deliberately retains the digest of the exact bytes read for a later
// collector receipt; no caller re-reads a snapshot to acknowledge it.
func readSessionSnapshot(path string) (sessionSnapshot, bool) {
	if !privateSessionDir(filepath.Dir(path)) {
		return sessionSnapshot{}, false
	}
	data, ok := readPrivateSessionFile(path)
	if !ok {
		return sessionSnapshot{}, false
	}
	sum := sha256.Sum256(data)
	snap := sessionSnapshot{
		rawRead:        true,
		snapshotSHA256: hex.EncodeToString(sum[:]),
	}
	if err := json.Unmarshal(data, &snap); err != nil {
		return snap, false
	}
	return snap, true
}

func readPrivateSessionFile(path string) ([]byte, bool) {
	return readPrivateFile(path, maxSessionSnapshotBytes)
}

func readPrivateFile(path string, maxBytes int64) ([]byte, bool) {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, false
	}
	file := os.NewFile(uintptr(fd), path)
	defer file.Close()

	info, err := file.Stat()
	if err != nil || !privateSameUserRegular(info) || info.Size() > maxBytes {
		return nil, false
	}
	data, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil || int64(len(data)) > maxBytes {
		return nil, false
	}
	return data, true
}

func privateSameUserRegular(info os.FileInfo) bool {
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		return false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == uint32(os.Getuid())
}

func privateSameUserDir(info os.FileInfo) bool {
	if !info.IsDir() || info.Mode().Perm()&0o077 != 0 {
		return false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == uint32(os.Getuid())
}

// privateSessionDir refuses symlinks and directories that another local user
// could populate. Collection and receipt management operate only below these
// owner-private boundaries.
func privateSessionDir(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && privateSameUserDir(info)
}

func (s *sessionStore) receiptFor(snap sessionSnapshot, status, code string, pane paneRef) {
	if snap.Publisher == "" || !snap.rawRead || !ValidSessionID(snap.SessionID) {
		return
	}
	workspaceID, paneID := "", 0
	if status == "observed" {
		workspaceID, paneID = pane.workspaceID, pane.paneID
	}
	outcome := status + "\x00" + code + "\x00" + snap.snapshotSHA256 + "\x00" + workspaceID + "\x00" + strconv.Itoa(paneID)
	start, _ := processStartTime(os.Getpid())
	receipt := sessionReceipt{
		V:              1,
		SessionID:      snap.SessionID,
		PID:            snap.PID,
		PIDStart:       snap.PIDStart,
		Publisher:      snap.Publisher,
		Status:         status,
		Code:           code,
		SnapshotSHA256: snap.snapshotSHA256,
		CollectorPID:   os.Getpid(),
		CollectorStart: start,
		ObservedAt:     time.Now().Unix(),
		WorkspaceID:    workspaceID,
		PaneID:         paneID,
	}
	if s.receiptOutcomes[snap.SessionID] == outcome && s.receiptMatches(receipt) {
		return
	}
	if s.receiptMatches(receipt) {
		if s.receiptOutcomes == nil {
			s.receiptOutcomes = make(map[string]string)
		}
		if len(s.receiptOutcomes) < maxSessionReceiptOutcomes {
			s.receiptOutcomes[snap.SessionID] = outcome
		}
		return
	}
	if err := writeSessionReceipt(s.dir, receipt); err != nil {
		s.warnReceiptFailure(snap.SessionID, outcome, code)
		return
	}
	if s.receiptOutcomes == nil {
		s.receiptOutcomes = make(map[string]string)
	}
	if _, known := s.receiptOutcomes[snap.SessionID]; known || len(s.receiptOutcomes) < maxSessionReceiptOutcomes {
		s.receiptOutcomes[snap.SessionID] = outcome
	}
}

func writeSessionReceipt(spool string, receipt sessionReceipt) error {
	if !privateSessionDir(spool) {
		return os.ErrPermission
	}
	dir := filepath.Join(spool, sessionReceiptDirName)
	if err := os.Mkdir(dir, 0o700); err != nil && !os.IsExist(err) {
		return err
	}
	if !privateSessionDir(dir) {
		return os.ErrPermission
	}
	body, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	if len(body) > maxSessionReceiptBytes {
		return syscall.EFBIG
	}
	path := filepath.Join(dir, receipt.SessionID+".json")
	file, err := os.CreateTemp(dir, "."+receipt.SessionID+".")
	if err != nil {
		return err
	}
	tmp := file.Name()
	if err = file.Chmod(0o600); err == nil {
		_, err = file.Write(body)
	}
	if err == nil {
		err = file.Close()
	} else {
		_ = file.Close()
	}
	if err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

func (s *sessionStore) receiptMatches(want sessionReceipt) bool {
	sessionID := want.SessionID
	if !ValidSessionID(sessionID) || !privateSessionDir(s.dir) {
		return false
	}
	dir := filepath.Join(s.dir, sessionReceiptDirName)
	if !privateSessionDir(dir) {
		return false
	}
	body, ok := readPrivateFile(filepath.Join(dir, sessionID+".json"), maxSessionReceiptBytes)
	if !ok {
		return false
	}
	var have sessionReceipt
	return json.Unmarshal(body, &have) == nil &&
		have.V == want.V &&
		have.SessionID == want.SessionID &&
		have.PID == want.PID &&
		have.PIDStart == want.PIDStart &&
		have.CollectorPID == want.CollectorPID &&
		have.CollectorStart == want.CollectorStart &&
		have.Publisher == want.Publisher &&
		have.Status == want.Status &&
		have.Code == want.Code &&
		have.SnapshotSHA256 == want.SnapshotSHA256 &&
		have.WorkspaceID == want.WorkspaceID &&
		have.PaneID == want.PaneID
}

// removeReceipt removes only the collector's own bounded acknowledgement file.
// It never follows or removes an unexpected entry in the receipts directory.
func (s *sessionStore) removeReceipt(sessionID string) {
	delete(s.receiptOutcomes, sessionID)
	if !ValidSessionID(sessionID) || !privateSessionDir(s.dir) {
		return
	}
	dir := filepath.Join(s.dir, sessionReceiptDirName)
	if !privateSessionDir(dir) {
		return
	}
	path := filepath.Join(dir, sessionID+".json")
	info, err := os.Lstat(path)
	if err != nil || !privateSameUserRegular(info) {
		return
	}
	_ = os.Remove(path)
}
