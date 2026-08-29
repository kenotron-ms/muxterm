package sessiond

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"

	"golang.org/x/sys/unix"
)

const (
	recoveryWriterLockName              = "writer.lock"
	recoverySnapshotCurrentName         = "snapshot.current"
	recoverySnapshotPreviousName        = "snapshot.previous"
	recoverySnapshotPendingName         = "snapshot.pending"
	recoverySnapshotPreviousPendingName = "snapshot.previous.pending"
	recoveryJournalCurrentName          = "journal.current"
	recoveryJournalPendingName          = "journal.pending"
	recoveryJournalPreviousName         = "journal.previous"
	recoveryJournalPreviousPendingName  = "journal.previous.pending"
	recoveryHistoryDirectoryName        = "history"
	recoveryHistoryPendingName          = "segment.pending"

	recoveryFrameHeaderBytes    = 80
	recoverySnapshotMaxBytes    = 32 * 1024 * 1024
	recoveryJournalHeaderMax    = 1024
	recoveryMinimumJournalBytes = recoveryFrameHeaderBytes + len(`{"baseGeneration":0}`)

	recoveryFrameSnapshot uint16 = iota + 1
	recoveryFrameJournalHeader
	recoveryFrameMutation
	recoveryFrameHistory
)

var recoveryFrameMagic = [8]byte{'M', 'U', 'X', 'R', 'S', 'T', 'O', '1'}

// fileRecoveryStore owns all descriptor-relative durable state. The checksums
// in its private framing detect accidental corruption and torn writes; they are
// not a defense against malicious tampering by the same effective UID with
// access to this root.
type fileRecoveryStore struct {
	mu sync.Mutex

	options RecoveryStoreOptions

	rootFD    int
	historyFD int
	lockFD    int
	journalFD int

	snapshot       RecoverySnapshot
	journalBase    RecoverySnapshot
	journalRecords int
	journalBytes   int64
	history        []recoveryStoredHistorySegment
	nextHistorySeq uint64

	closed   bool
	poisoned bool
}

type recoveryJournalHeader struct {
	BaseGeneration RecoveryStoreGeneration `json:"baseGeneration"`
}

type recoveryJournalMutation struct {
	Generation RecoveryStoreGeneration `json:"generation"`
	Mutation   RecoveryMutation        `json:"mutation"`
}

type recoveryHistoryWire struct {
	Sequence uint64                 `json:"sequence"`
	Segment  RecoveryHistorySegment `json:"segment"`
}

type recoveryFrame struct {
	kind    uint16
	payload []byte
}

type recoverySnapshotCandidate struct {
	exists   bool
	valid    bool
	snapshot RecoverySnapshot
}

type recoveryJournalCandidate struct {
	exists    bool
	valid     bool
	header    recoveryJournalHeader
	records   []recoveryJournalMutation
	bytesUsed int64
	tornAt    int
	corrupt   error
}

// OpenFileRecoveryStore opens one secure, owner-only recovery-store root. Root
// must be a clean absolute path other than "/" and only its missing final
// component may be created. All state paths below it are implementation names;
// caller values never contribute to a filename.
func OpenFileRecoveryStore(root string, options RecoveryStoreOptions) (RecoveryStore, error) {
	options, err := normalizedRecoveryStoreOptions(options)
	if err != nil {
		return nil, err
	}
	rootFD, err := openRecoveryRoot(root)
	if err != nil {
		return nil, err
	}
	store := &fileRecoveryStore{
		options:   options,
		rootFD:    rootFD,
		historyFD: -1,
		lockFD:    -1,
		journalFD: -1,
		snapshot:  NewRecoverySnapshot(),
	}
	cleanup := func() {
		store.closeDescriptors()
	}

	store.historyFD, err = ensureRecoveryOwnedDirectory(store.rootFD, recoveryHistoryDirectoryName)
	if err != nil {
		cleanup()
		return nil, err
	}
	store.lockFD, err = openRecoveryWriterLock(store.rootFD)
	if err != nil {
		cleanup()
		return nil, err
	}
	if err := store.openAndRecover(); err != nil {
		cleanup()
		return nil, err
	}
	return store, nil
}

func (store *fileRecoveryStore) Load() (RecoveryLoadResult, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.ensureUsable(); err != nil {
		return RecoveryLoadResult{}, err
	}
	history := make([]RecoveryHistorySegment, 0, len(store.history))
	for _, stored := range store.history {
		if recoverySnapshotHasPane(store.snapshot, stored.segment.Pane) {
			history = append(history, cloneRecoveryHistorySegment(stored.segment))
		}
	}
	return RecoveryLoadResult{
		Snapshot: cloneRecoverySnapshot(store.snapshot),
		History:  history,
	}, nil
}

func (store *fileRecoveryStore) Commit(
	expected RecoveryStoreGeneration,
	mutation RecoveryMutation,
) (RecoveryCommitResult, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.ensureUsable(); err != nil {
		return RecoveryCommitResult{}, err
	}
	if expected != store.snapshot.Generation {
		return RecoveryCommitResult{}, fmt.Errorf("%w: expected %d, current %d",
			ErrRecoveryStoreGenerationConflict, expected, store.snapshot.Generation)
	}

	_, canonicalMutation, err := stableRecoveryMutationJSON(mutation)
	if err != nil {
		return RecoveryCommitResult{}, err
	}
	candidate, err := ApplyRecoveryMutation(store.snapshot, canonicalMutation)
	if err != nil {
		return RecoveryCommitResult{}, err
	}
	// Encode the complete candidate before doing I/O. This proves the mutation
	// cannot make a future compaction unencodable after it was acknowledged.
	candidateJSON, err := stableRecoverySnapshotJSON(candidate)
	if err != nil || len(candidateJSON) > recoverySnapshotMaxBytes {
		return RecoveryCommitResult{}, fmt.Errorf("%w: candidate snapshot exceeds durable bound", ErrRecoveryStoreInvalid)
	}
	if _, err := encodeRecoveryFrame(recoveryFrameSnapshot, candidateJSON); err != nil {
		return RecoveryCommitResult{}, err
	}
	recordPayload, err := json.Marshal(recoveryJournalMutation{
		Generation: candidate.Generation,
		Mutation:   canonicalMutation,
	})
	if err != nil || len(recordPayload) > RecoveryStoreMaxMutationBytes {
		return RecoveryCommitResult{}, fmt.Errorf("%w: mutation record exceeds durable bound", ErrRecoveryStoreInvalid)
	}
	recordFrame, err := encodeRecoveryFrame(recoveryFrameMutation, recordPayload)
	if err != nil {
		return RecoveryCommitResult{}, err
	}
	journalHeader, err := recoveryJournalHeaderFrame(candidate.Generation)
	if err != nil {
		return RecoveryCommitResult{}, err
	}

	// The mutex makes this second check cheap and documents that an expected
	// generation gates the state actually about to be written.
	if expected != store.snapshot.Generation {
		return RecoveryCommitResult{}, fmt.Errorf("%w: expected %d, current %d",
			ErrRecoveryStoreGenerationConflict, expected, store.snapshot.Generation)
	}
	if len(recordFrame)+len(journalHeader) > store.options.MaxJournalBytes {
		return RecoveryCommitResult{}, fmt.Errorf("%w: journal byte limit cannot contain one mutation", ErrRecoveryStoreInvalid)
	}
	if store.journalRecords+1 > store.options.MaxJournalRecords ||
		store.journalBytes+int64(len(recordFrame)) > int64(store.options.MaxJournalBytes) {
		if err := store.publishSnapshotLocked(); err != nil {
			return RecoveryCommitResult{}, err
		}
	}
	if store.journalBytes+int64(len(recordFrame)) > int64(store.options.MaxJournalBytes) {
		return RecoveryCommitResult{}, fmt.Errorf("%w: journal byte limit cannot contain one mutation", ErrRecoveryStoreInvalid)
	}

	if err := writeRecoveryAll(store.journalFD, recordFrame); err != nil {
		return RecoveryCommitResult{}, store.poison(err)
	}
	if err := unix.Fsync(store.journalFD); err != nil {
		return RecoveryCommitResult{}, store.poison(err)
	}
	store.snapshot = candidate
	store.journalRecords++
	store.journalBytes += int64(len(recordFrame))
	return RecoveryCommitResult{Generation: candidate.Generation}, nil
}

func (store *fileRecoveryStore) PublishSnapshot() error {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.ensureUsable(); err != nil {
		return err
	}
	return store.publishSnapshotLocked()
}

func (store *fileRecoveryStore) FlushHistory(
	pane RecoveryPaneRef,
	lines []string,
) (RecoveryHistorySegment, error) {
	// Sanitize caller-owned input before taking the store mutex. Each line has a
	// hard scan cap, so a control-only prefix cannot monopolize structural
	// commits even when the caller supplies an arbitrarily long string.
	segment, err := newRecoveryHistorySegment(pane, lines, store.options)
	if err != nil {
		return RecoveryHistorySegment{}, err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.ensureUsable(); err != nil {
		return RecoveryHistorySegment{}, err
	}
	if !recoverySnapshotHasPane(store.snapshot, pane) {
		return RecoveryHistorySegment{}, fmt.Errorf("%w: history pane is not in the snapshot", ErrRecoveryStoreInvalid)
	}
	if len(segment.Lines) == 0 {
		return cloneRecoveryHistorySegment(segment), nil
	}
	if store.nextHistorySeq == math.MaxUint64 {
		return RecoveryHistorySegment{}, fmt.Errorf("%w: history sequence overflow", ErrRecoveryStoreInvalid)
	}
	sequence := store.nextHistorySeq
	segment, frame, err := fitRecoveryHistoryFrame(sequence, segment, store.options)
	if err != nil {
		return RecoveryHistorySegment{}, err
	}
	if len(segment.Lines) == 0 {
		return cloneRecoveryHistorySegment(segment), nil
	}
	if err := discardRecoveryPendingFile(store.historyFD, recoveryHistoryPendingName); err != nil {
		return RecoveryHistorySegment{}, err
	}
	pendingFD, err := createRecoveryFile(store.historyFD, recoveryHistoryPendingName, unix.O_WRONLY)
	if err != nil {
		return RecoveryHistorySegment{}, err
	}
	pendingOpen := true
	defer func() {
		if pendingOpen {
			_ = unix.Close(pendingFD)
		}
	}()
	if err := writeRecoveryAll(pendingFD, frame); err != nil {
		return RecoveryHistorySegment{}, store.poison(err)
	}
	if err := unix.Fsync(pendingFD); err != nil {
		return RecoveryHistorySegment{}, store.poison(err)
	}
	if err := unix.Close(pendingFD); err != nil {
		return RecoveryHistorySegment{}, store.poison(err)
	}
	pendingOpen = false

	filename := recoveryHistoryFilename(sequence)
	if exists, err := recoveryExpectedFileExists(store.historyFD, filename); err != nil {
		return RecoveryHistorySegment{}, err
	} else if exists {
		return RecoveryHistorySegment{}, store.poison(fmt.Errorf("history sequence file already exists"))
	}
	if err := unix.Renameat(store.historyFD, recoveryHistoryPendingName, store.historyFD, filename); err != nil {
		return RecoveryHistorySegment{}, store.poison(err)
	}
	if err := unix.Fsync(store.historyFD); err != nil {
		return RecoveryHistorySegment{}, store.poison(err)
	}

	store.history = append(store.history, recoveryStoredHistorySegment{
		sequence:   sequence,
		segment:    cloneRecoveryHistorySegment(segment),
		frameBytes: int64(len(frame)),
	})
	store.nextHistorySeq++
	if err := store.pruneHistoryLocked(); err != nil {
		return RecoveryHistorySegment{}, store.poison(err)
	}
	return cloneRecoveryHistorySegment(segment), nil
}

func (store *fileRecoveryStore) Close() error {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.closed {
		return nil
	}
	var result error
	if !store.poisoned {
		result = store.publishSnapshotLocked()
	}
	store.closeDescriptors()
	store.closed = true
	return result
}

func (store *fileRecoveryStore) ensureUsable() error {
	if store.closed {
		return ErrRecoveryStoreClosed
	}
	if store.poisoned {
		return ErrRecoveryStorePoisoned
	}
	return nil
}

func (store *fileRecoveryStore) poison(cause error) error {
	store.poisoned = true
	return fmt.Errorf("%w: durable I/O is uncertain: %v", ErrRecoveryStorePoisoned, cause)
}

func (store *fileRecoveryStore) closeDescriptors() {
	if store.journalFD >= 0 {
		_ = unix.Close(store.journalFD)
		store.journalFD = -1
	}
	if store.lockFD >= 0 {
		_ = unix.Flock(store.lockFD, unix.LOCK_UN)
		_ = unix.Close(store.lockFD)
		store.lockFD = -1
	}
	if store.historyFD >= 0 {
		_ = unix.Close(store.historyFD)
		store.historyFD = -1
	}
	if store.rootFD >= 0 {
		_ = unix.Close(store.rootFD)
		store.rootFD = -1
	}
}

func (store *fileRecoveryStore) openAndRecover() error {
	current, err := readRecoverySnapshotFile(store.rootFD, recoverySnapshotCurrentName)
	if err != nil {
		return err
	}
	previous, err := readRecoverySnapshotFile(store.rootFD, recoverySnapshotPreviousName)
	if err != nil {
		return err
	}
	currentJournal, err := readRecoveryJournalFile(store.rootFD, recoveryJournalCurrentName)
	if err != nil {
		return err
	}
	previousJournal, err := readRecoveryJournalFile(store.rootFD, recoveryJournalPreviousName)
	if err != nil {
		return err
	}

	pendingNames := []string{
		recoverySnapshotPendingName,
		recoveryJournalPendingName,
		recoverySnapshotPreviousPendingName,
		recoveryJournalPreviousPendingName,
	}
	pendingExists := false
	for _, name := range pendingNames {
		exists, err := recoveryExpectedFileExists(store.rootFD, name)
		if err != nil {
			return err
		}
		pendingExists = pendingExists || exists
	}

	if !currentJournal.exists {
		if current.exists || previous.exists || previousJournal.exists || pendingExists {
			return fmt.Errorf("%w: durable snapshots or pending files exist without a current journal", ErrRecoveryStoreCorrupt)
		}
		journalFD, err := createRecoveryJournal(store.rootFD, 0)
		if err != nil {
			return err
		}
		if err := unix.Close(journalFD); err != nil {
			return fmt.Errorf("%w: close new journal: %v", ErrRecoveryStoreUnsafePath, err)
		}
		currentJournal, err = readRecoveryJournalFile(store.rootFD, recoveryJournalCurrentName)
		if err != nil {
			return err
		}
	}

	var (
		base             RecoverySnapshot
		replayed         RecoverySnapshot
		selectedJournal  recoveryJournalCandidate
		selectedCurrent  bool
		currentReplayErr error
	)
	initialCurrent := !current.exists && !previous.exists &&
		currentJournal.valid &&
		currentJournal.header.BaseGeneration == 0
	if current.valid || initialCurrent {
		if !currentJournal.valid {
			if currentJournal.corrupt != nil {
				return currentJournal.corrupt
			}
			return fmt.Errorf("%w: current journal is invalid", ErrRecoveryStoreCorrupt)
		}
		if current.valid {
			base = current.snapshot
		} else {
			base = NewRecoverySnapshot()
		}
		replayed, currentReplayErr = replayRecoveryJournal(base, currentJournal.header, currentJournal.records)
		if currentReplayErr == nil {
			selectedJournal = currentJournal
			selectedCurrent = true
		}
	}

	// A legacy/interrupted rotation may have moved the current snapshot to the
	// previous name while leaving the covering current journal in place. Use
	// that compatible cross-name pair only to reconstruct and immediately
	// republish a matched current pair.
	if !selectedCurrent && !current.valid && previous.valid && currentJournal.valid {
		candidate, replayErr := replayRecoveryJournal(previous.snapshot, currentJournal.header, currentJournal.records)
		if replayErr == nil {
			base = previous.snapshot
			replayed = candidate
			selectedJournal = currentJournal
		}
	}

	if !selectedCurrent {
		fallbackAllowed := !current.valid || pendingExists
		if !selectedJournal.valid &&
			fallbackAllowed &&
			previous.valid &&
			previousJournal.valid &&
			previousJournal.tornAt < 0 {
			checkpoint, replayErr := replayRecoveryJournal(
				previous.snapshot,
				previousJournal.header,
				previousJournal.records,
			)
			if replayErr == nil && currentJournal.valid {
				candidate, currentErr := replayRecoveryJournal(
					checkpoint,
					currentJournal.header,
					currentJournal.records,
				)
				if currentErr == nil {
					replayed = candidate
					selectedJournal = currentJournal
				}
			}
		}
		if selectedJournal.valid == false {
			if currentReplayErr != nil {
				return currentReplayErr
			}
			if currentJournal.corrupt != nil {
				return currentJournal.corrupt
			}
			if current.exists && !current.valid {
				return fmt.Errorf("%w: current snapshot is corrupt and no matched previous pair remains", ErrRecoveryStoreCorrupt)
			}
			if previousJournal.corrupt != nil && previous.valid {
				return previousJournal.corrupt
			}
			return fmt.Errorf("%w: no recoverable snapshot and journal pair remains", ErrRecoveryStoreCorrupt)
		}
	}

	store.snapshot = replayed
	if selectedCurrent {
		journalFD, exists, err := openRecoveryExistingFile(
			store.rootFD,
			recoveryJournalCurrentName,
			unix.O_RDWR|unix.O_APPEND,
		)
		if err != nil || !exists {
			if err == nil {
				err = errors.New("selected current journal disappeared")
			}
			return err
		}
		if selectedJournal.tornAt >= 0 {
			if err := unix.Ftruncate(journalFD, int64(selectedJournal.tornAt)); err != nil {
				_ = unix.Close(journalFD)
				return fmt.Errorf("%w: truncate torn journal tail: %v", ErrRecoveryStoreCorrupt, err)
			}
			if err := unix.Fsync(journalFD); err != nil {
				_ = unix.Close(journalFD)
				return fmt.Errorf("%w: sync torn journal truncation: %v", ErrRecoveryStoreCorrupt, err)
			}
			selectedJournal.bytesUsed = int64(selectedJournal.tornAt)
		}
		store.journalFD = journalFD
		store.journalBase = cloneRecoverySnapshot(base)
		store.journalRecords = len(selectedJournal.records)
		store.journalBytes = selectedJournal.bytesUsed
	} else {
		if err := store.replaceCurrentPairLocked(replayed); err != nil {
			return err
		}
	}

	for _, name := range pendingNames {
		if err := discardRecoveryPendingFile(store.rootFD, name); err != nil {
			return err
		}
	}
	if err := store.loadHistoryLocked(); err != nil {
		return err
	}
	if store.journalRecords > store.options.MaxJournalRecords ||
		store.journalBytes > int64(store.options.MaxJournalBytes) {
		return store.publishSnapshotLocked()
	}
	return nil
}

func (store *fileRecoveryStore) publishSnapshotLocked() error {
	snapshotJSON, err := stableRecoverySnapshotJSON(store.snapshot)
	if err != nil || len(snapshotJSON) > recoverySnapshotMaxBytes {
		return fmt.Errorf("%w: snapshot exceeds durable bound", ErrRecoveryStoreInvalid)
	}
	snapshotFrame, err := encodeRecoveryFrame(recoveryFrameSnapshot, snapshotJSON)
	if err != nil {
		return err
	}
	journalFrame, err := recoveryJournalHeaderFrame(store.snapshot.Generation)
	if err != nil {
		return err
	}

	baseJSON, err := stableRecoverySnapshotJSON(store.journalBase)
	if err != nil || len(baseJSON) > recoverySnapshotMaxBytes {
		return store.poison(fmt.Errorf("journal base snapshot is invalid"))
	}
	baseFrame, err := encodeRecoveryFrame(recoveryFrameSnapshot, baseJSON)
	if err != nil {
		return store.poison(err)
	}
	currentJournalBytes, err := readRecoveryAll(store.journalFD, RecoveryStoreMaxJournalBytes)
	if err != nil {
		return store.poison(err)
	}
	header, records, _, tornAt, err := readRecoveryJournal(store.journalFD)
	if err != nil || tornAt >= 0 {
		if err == nil {
			err = errors.New("active journal has a torn tail")
		}
		return store.poison(err)
	}
	replayed, err := replayRecoveryJournal(store.journalBase, header, records)
	if err != nil {
		return store.poison(err)
	}
	replayedJSON, err := stableRecoverySnapshotJSON(replayed)
	if err != nil || !bytes.Equal(replayedJSON, snapshotJSON) {
		return store.poison(fmt.Errorf("active journal does not reproduce in-memory state"))
	}

	// Retain the complete old current pair first. Its journal spans from
	// journalBase through every acknowledged mutation, so it can reconstruct
	// the latest committed state if the newly published snapshot is corrupted.
	if err := installRecoveryPair(
		store.rootFD,
		recoverySnapshotPreviousPendingName,
		recoverySnapshotPreviousName,
		baseFrame,
		recoveryJournalPreviousPendingName,
		recoveryJournalPreviousName,
		currentJournalBytes,
	); err != nil {
		return store.poison(err)
	}

	// Both new files were fully written and synced before either current name is
	// replaced. The retained previous pair remains valid throughout the two
	// atomic renames and their directory syncs.
	if err := installRecoveryPair(
		store.rootFD,
		recoverySnapshotPendingName,
		recoverySnapshotCurrentName,
		snapshotFrame,
		recoveryJournalPendingName,
		recoveryJournalCurrentName,
		journalFrame,
	); err != nil {
		return store.poison(err)
	}
	return store.openPublishedCurrentJournal(store.snapshot, journalFrame)
}

func (store *fileRecoveryStore) replaceCurrentPairLocked(snapshot RecoverySnapshot) error {
	snapshotJSON, err := stableRecoverySnapshotJSON(snapshot)
	if err != nil || len(snapshotJSON) > recoverySnapshotMaxBytes {
		return store.poison(fmt.Errorf("replacement snapshot is invalid"))
	}
	snapshotFrame, err := encodeRecoveryFrame(recoveryFrameSnapshot, snapshotJSON)
	if err != nil {
		return store.poison(err)
	}
	journalFrame, err := recoveryJournalHeaderFrame(snapshot.Generation)
	if err != nil {
		return store.poison(err)
	}
	if err := installRecoveryPair(
		store.rootFD,
		recoverySnapshotPendingName,
		recoverySnapshotCurrentName,
		snapshotFrame,
		recoveryJournalPendingName,
		recoveryJournalCurrentName,
		journalFrame,
	); err != nil {
		return store.poison(err)
	}
	return store.openPublishedCurrentJournal(snapshot, journalFrame)
}

func (store *fileRecoveryStore) openPublishedCurrentJournal(
	base RecoverySnapshot,
	journalFrame []byte,
) error {
	newJournalFD, exists, err := openRecoveryExistingFile(
		store.rootFD,
		recoveryJournalCurrentName,
		unix.O_RDWR|unix.O_APPEND,
	)
	if err != nil || !exists {
		if err == nil {
			err = errors.New("new journal disappeared")
		}
		return store.poison(err)
	}
	oldJournalFD := store.journalFD
	store.journalFD = newJournalFD
	if oldJournalFD >= 0 {
		_ = unix.Close(oldJournalFD)
	}
	store.journalBase = cloneRecoverySnapshot(base)
	store.journalRecords = 0
	store.journalBytes = int64(len(journalFrame))
	return nil
}

func installRecoveryPair(
	dirFD int,
	snapshotPendingName string,
	snapshotName string,
	snapshotFrame []byte,
	journalPendingName string,
	journalName string,
	journalFrame []byte,
) error {
	for _, name := range []string{snapshotName, journalName} {
		if _, err := recoveryExpectedFileExists(dirFD, name); err != nil {
			return err
		}
	}
	if err := writeRecoveryPendingFile(dirFD, snapshotPendingName, snapshotFrame); err != nil {
		return err
	}
	if err := writeRecoveryPendingFile(dirFD, journalPendingName, journalFrame); err != nil {
		return err
	}
	if err := unix.Renameat(dirFD, snapshotPendingName, dirFD, snapshotName); err != nil {
		return err
	}
	if err := unix.Fsync(dirFD); err != nil {
		return err
	}
	if err := unix.Renameat(dirFD, journalPendingName, dirFD, journalName); err != nil {
		return err
	}
	return unix.Fsync(dirFD)
}

func writeRecoveryPendingFile(dirFD int, name string, data []byte) error {
	if err := discardRecoveryPendingFile(dirFD, name); err != nil {
		return err
	}
	fd, err := createRecoveryFile(dirFD, name, unix.O_WRONLY)
	if err != nil {
		return err
	}
	open := true
	defer func() {
		if open {
			_ = unix.Close(fd)
		}
	}()
	if err := writeRecoveryAll(fd, data); err != nil {
		return err
	}
	if err := unix.Fsync(fd); err != nil {
		return err
	}
	if err := unix.Close(fd); err != nil {
		return err
	}
	open = false
	return nil
}

func readRecoverySnapshotFile(dirFD int, name string) (recoverySnapshotCandidate, error) {
	fd, exists, err := openRecoveryExistingFile(dirFD, name, unix.O_RDONLY)
	if err != nil || !exists {
		return recoverySnapshotCandidate{exists: exists}, err
	}
	defer unix.Close(fd)
	data, err := readRecoveryAll(fd, recoveryFrameHeaderBytes+recoverySnapshotMaxBytes)
	if err != nil {
		return recoverySnapshotCandidate{exists: true}, nil
	}
	frames, _, torn, err := decodeRecoveryFrames(data, false)
	if err != nil || torn || len(frames) != 1 || frames[0].kind != recoveryFrameSnapshot {
		return recoverySnapshotCandidate{exists: true}, nil
	}
	var snapshot RecoverySnapshot
	if err := decodeRecoveryJSON(frames[0].payload, &snapshot); err != nil {
		return recoverySnapshotCandidate{exists: true}, nil
	}
	canonical, err := canonicalRecoverySnapshot(snapshot)
	if err != nil {
		return recoverySnapshotCandidate{exists: true}, nil
	}
	canonicalJSON, err := stableRecoverySnapshotJSON(canonical)
	if err != nil || !bytes.Equal(canonicalJSON, frames[0].payload) {
		return recoverySnapshotCandidate{exists: true}, nil
	}
	return recoverySnapshotCandidate{exists: true, valid: true, snapshot: canonical}, nil
}

func readRecoveryJournalFile(dirFD int, name string) (recoveryJournalCandidate, error) {
	fd, exists, err := openRecoveryExistingFile(dirFD, name, unix.O_RDONLY)
	if err != nil || !exists {
		return recoveryJournalCandidate{exists: exists}, err
	}
	defer unix.Close(fd)
	header, records, bytesUsed, tornAt, err := readRecoveryJournal(fd)
	if err != nil {
		return recoveryJournalCandidate{
			exists:  true,
			tornAt:  -1,
			corrupt: err,
		}, nil
	}
	return recoveryJournalCandidate{
		exists:    true,
		valid:     true,
		header:    header,
		records:   records,
		bytesUsed: bytesUsed,
		tornAt:    tornAt,
	}, nil
}

func readRecoveryJournal(
	fd int,
) (recoveryJournalHeader, []recoveryJournalMutation, int64, int, error) {
	data, err := readRecoveryAll(fd, RecoveryStoreMaxJournalBytes)
	if err != nil {
		return recoveryJournalHeader{}, nil, 0, -1, fmt.Errorf("%w: read journal: %v", ErrRecoveryStoreCorrupt, err)
	}
	frames, validEnd, torn, err := decodeRecoveryFrames(data, true)
	if err != nil {
		return recoveryJournalHeader{}, nil, 0, -1, err
	}
	if len(frames) == 0 || frames[0].kind != recoveryFrameJournalHeader {
		return recoveryJournalHeader{}, nil, 0, -1, fmt.Errorf("%w: journal has no header", ErrRecoveryStoreCorrupt)
	}
	var header recoveryJournalHeader
	if err := decodeRecoveryJSON(frames[0].payload, &header); err != nil {
		return recoveryJournalHeader{}, nil, 0, -1, fmt.Errorf("%w: invalid journal header", ErrRecoveryStoreCorrupt)
	}
	headerPayload, err := json.Marshal(header)
	if err != nil || !bytes.Equal(headerPayload, frames[0].payload) {
		return recoveryJournalHeader{}, nil, 0, -1, fmt.Errorf("%w: noncanonical journal header", ErrRecoveryStoreCorrupt)
	}

	records := make([]recoveryJournalMutation, 0, len(frames)-1)
	generation := header.BaseGeneration
	for index := 1; index < len(frames); index++ {
		frame := frames[index]
		if frame.kind != recoveryFrameMutation {
			return recoveryJournalHeader{}, nil, 0, -1, fmt.Errorf("%w: unexpected journal frame", ErrRecoveryStoreCorrupt)
		}
		var record recoveryJournalMutation
		if err := decodeRecoveryJSON(frame.payload, &record); err != nil {
			return recoveryJournalHeader{}, nil, 0, -1, fmt.Errorf("%w: invalid journal mutation", ErrRecoveryStoreCorrupt)
		}
		if generation == math.MaxUint64 || record.Generation != generation+1 {
			return recoveryJournalHeader{}, nil, 0, -1, fmt.Errorf("%w: journal generations are not contiguous", ErrRecoveryStoreCorrupt)
		}
		_, mutation, err := stableRecoveryMutationJSON(record.Mutation)
		if err != nil {
			return recoveryJournalHeader{}, nil, 0, -1, fmt.Errorf("%w: invalid journal mutation", ErrRecoveryStoreCorrupt)
		}
		record.Mutation = mutation
		canonicalPayload, err := json.Marshal(record)
		if err != nil || !bytes.Equal(canonicalPayload, frame.payload) {
			return recoveryJournalHeader{}, nil, 0, -1, fmt.Errorf("%w: noncanonical journal mutation", ErrRecoveryStoreCorrupt)
		}
		records = append(records, record)
		generation = record.Generation
	}
	tornAt := -1
	if torn {
		tornAt = validEnd
	}
	return header, records, int64(validEnd), tornAt, nil
}

func replayRecoveryJournal(
	snapshot RecoverySnapshot,
	header recoveryJournalHeader,
	records []recoveryJournalMutation,
) (RecoverySnapshot, error) {
	if header.BaseGeneration > snapshot.Generation {
		return RecoverySnapshot{}, fmt.Errorf("%w: journal base is newer than snapshot", ErrRecoveryStoreCorrupt)
	}
	generation := header.BaseGeneration
	for _, record := range records {
		if generation == math.MaxUint64 || record.Generation != generation+1 {
			return RecoverySnapshot{}, fmt.Errorf("%w: journal generations are not contiguous", ErrRecoveryStoreCorrupt)
		}
		generation = record.Generation
		if record.Generation <= snapshot.Generation {
			continue
		}
		next, err := ApplyRecoveryMutation(snapshot, record.Mutation)
		if err != nil || next.Generation != record.Generation {
			return RecoverySnapshot{}, fmt.Errorf("%w: journal mutation cannot be replayed", ErrRecoveryStoreCorrupt)
		}
		snapshot = next
	}
	if snapshot.Generation > header.BaseGeneration && generation < snapshot.Generation {
		return RecoverySnapshot{}, fmt.Errorf("%w: journal does not cover snapshot generation", ErrRecoveryStoreCorrupt)
	}
	return snapshot, nil
}

func recoveryJournalHeaderFrame(generation RecoveryStoreGeneration) ([]byte, error) {
	payload, err := json.Marshal(recoveryJournalHeader{BaseGeneration: generation})
	if err != nil || len(payload) > recoveryJournalHeaderMax {
		return nil, fmt.Errorf("%w: encode journal header", ErrRecoveryStoreInvalid)
	}
	return encodeRecoveryFrame(recoveryFrameJournalHeader, payload)
}

func encodeRecoveryHistoryFrame(
	sequence uint64,
	segment RecoveryHistorySegment,
	options RecoveryStoreOptions,
) ([]byte, error) {
	if sequence == 0 {
		return nil, fmt.Errorf("%w: history sequence is zero", ErrRecoveryStoreInvalid)
	}
	if err := validateRecoveryHistorySegment(segment, options); err != nil {
		return nil, err
	}
	payload, err := json.Marshal(recoveryHistoryWire{
		Sequence: sequence,
		Segment:  cloneRecoveryHistorySegment(segment),
	})
	if err != nil || len(payload) > RecoveryStoreMaxHistorySegmentBytes {
		return nil, fmt.Errorf("%w: history segment cannot be encoded within its bound", ErrRecoveryStoreInvalid)
	}
	return encodeRecoveryFrame(recoveryFrameHistory, payload)
}

func fitRecoveryHistoryFrame(
	sequence uint64,
	segment RecoveryHistorySegment,
	options RecoveryStoreOptions,
) (RecoveryHistorySegment, []byte, error) {
	candidate := cloneRecoveryHistorySegment(segment)
	for {
		frame, err := encodeRecoveryHistoryFrame(sequence, candidate, options)
		if err != nil {
			return RecoveryHistorySegment{}, nil, err
		}
		if len(frame)-recoveryFrameHeaderBytes <= options.MaxHistorySegmentBytes {
			return candidate, frame, nil
		}
		if len(candidate.Lines) == 0 {
			return candidate, nil, nil
		}
		candidate.Lines = append([]string(nil), candidate.Lines[1:]...)
	}
}

func decodeRecoveryHistoryFrame(
	data []byte,
	sequence uint64,
	options RecoveryStoreOptions,
) (RecoveryHistorySegment, error) {
	frames, _, torn, err := decodeRecoveryFrames(data, false)
	if err != nil || torn || len(frames) != 1 || frames[0].kind != recoveryFrameHistory {
		return RecoveryHistorySegment{}, fmt.Errorf("%w: invalid history segment frame", ErrRecoveryStoreCorrupt)
	}
	var wire recoveryHistoryWire
	if err := decodeRecoveryJSON(frames[0].payload, &wire); err != nil || wire.Sequence != sequence {
		return RecoveryHistorySegment{}, fmt.Errorf("%w: invalid history segment payload", ErrRecoveryStoreCorrupt)
	}
	if err := validateRecoveryHistorySegment(wire.Segment, options); err != nil {
		return RecoveryHistorySegment{}, fmt.Errorf("%w: invalid history segment", ErrRecoveryStoreCorrupt)
	}
	canonical, err := encodeRecoveryHistoryFrame(sequence, wire.Segment, options)
	if err != nil || !bytes.Equal(canonical, data) {
		return RecoveryHistorySegment{}, fmt.Errorf("%w: noncanonical history segment", ErrRecoveryStoreCorrupt)
	}
	return cloneRecoveryHistorySegment(wire.Segment), nil
}

func (store *fileRecoveryStore) loadHistoryLocked() error {
	if err := discardRecoveryPendingFile(store.historyFD, recoveryHistoryPendingName); err != nil {
		return err
	}
	names, err := readRecoveryDirectoryNames(store.historyFD, RecoveryStoreMaxHistorySegments)
	if err != nil {
		return err
	}
	segments := make([]recoveryStoredHistorySegment, 0)
	for _, name := range names {
		sequence, ok := parseRecoveryHistoryFilename(name)
		if !ok {
			continue
		}
		if len(segments) >= RecoveryStoreMaxHistorySegments {
			return fmt.Errorf("%w: history segment count exceeds hard limit", ErrRecoveryStoreCorrupt)
		}
		fd, exists, err := openRecoveryExistingFile(store.historyFD, name, unix.O_RDONLY)
		if err != nil || !exists {
			if err != nil {
				return err
			}
			return fmt.Errorf("%w: history segment disappeared", ErrRecoveryStoreCorrupt)
		}
		data, readErr := readRecoveryAll(fd, recoveryFrameHeaderBytes+RecoveryStoreMaxHistorySegmentBytes)
		_ = unix.Close(fd)
		if readErr != nil {
			return fmt.Errorf("%w: read history segment", ErrRecoveryStoreCorrupt)
		}
		segment, err := decodeRecoveryHistoryFrame(data, sequence, store.options)
		if err != nil {
			return err
		}
		segments = append(segments, recoveryStoredHistorySegment{
			sequence:   sequence,
			segment:    segment,
			frameBytes: int64(len(data)),
		})
	}
	sort.Slice(segments, func(left, right int) bool {
		return segments[left].sequence < segments[right].sequence
	})
	for index := 1; index < len(segments); index++ {
		if segments[index-1].sequence == segments[index].sequence {
			return fmt.Errorf("%w: duplicate history sequence", ErrRecoveryStoreCorrupt)
		}
	}
	store.history = segments
	store.nextHistorySeq = 1
	if len(segments) > 0 {
		if segments[len(segments)-1].sequence == math.MaxUint64 {
			store.nextHistorySeq = math.MaxUint64
		} else {
			store.nextHistorySeq = segments[len(segments)-1].sequence + 1
		}
	}
	return store.pruneHistoryLocked()
}

func (store *fileRecoveryStore) pruneHistoryLocked() error {
	kept := make([]recoveryStoredHistorySegment, 0, len(store.history))
	removed := make([]uint64, 0)
	for _, stored := range store.history {
		if recoverySnapshotHasPane(store.snapshot, stored.segment.Pane) {
			kept = append(kept, stored)
		} else {
			removed = append(removed, stored.sequence)
		}
	}
	var bytesUsed int64
	for _, stored := range kept {
		bytesUsed += stored.frameBytes
	}
	for len(kept) > store.options.MaxHistorySegments ||
		bytesUsed > int64(store.options.MaxHistoryTotalBytes) {
		removed = append(removed, kept[0].sequence)
		bytesUsed -= kept[0].frameBytes
		kept = kept[1:]
	}
	for _, sequence := range removed {
		if err := removeRecoveryExpectedFile(store.historyFD, recoveryHistoryFilename(sequence)); err != nil {
			return err
		}
	}
	if len(removed) > 0 {
		if err := unix.Fsync(store.historyFD); err != nil {
			return err
		}
	}
	store.history = kept
	if len(store.history) > 0 && store.nextHistorySeq <= store.history[len(store.history)-1].sequence {
		if store.history[len(store.history)-1].sequence == math.MaxUint64 {
			store.nextHistorySeq = math.MaxUint64
		} else {
			store.nextHistorySeq = store.history[len(store.history)-1].sequence + 1
		}
	}
	return nil
}

func encodeRecoveryFrame(kind uint16, payload []byte) ([]byte, error) {
	if !validRecoveryFrameKind(kind) || len(payload) > recoveryFramePayloadLimit(kind) {
		return nil, fmt.Errorf("%w: frame payload exceeds its bound", ErrRecoveryStoreInvalid)
	}
	frame := make([]byte, recoveryFrameHeaderBytes+len(payload))
	copy(frame[:8], recoveryFrameMagic[:])
	binary.BigEndian.PutUint16(frame[8:10], RecoveryStoreSchemaVersion)
	binary.BigEndian.PutUint16(frame[10:12], kind)
	binary.BigEndian.PutUint32(frame[12:16], uint32(len(payload)))
	headerDigest := sha256.Sum256(frame[:16])
	copy(frame[16:48], headerDigest[:])
	payloadDigest := sha256.Sum256(payload)
	copy(frame[48:80], payloadDigest[:])
	copy(frame[80:], payload)
	return frame, nil
}

func decodeRecoveryFrames(data []byte, allowTornFinal bool) ([]recoveryFrame, int, bool, error) {
	frames := make([]recoveryFrame, 0)
	offset := 0
	for offset < len(data) {
		if len(data)-offset < recoveryFrameHeaderBytes {
			if allowTornFinal {
				return frames, offset, true, nil
			}
			return nil, 0, false, fmt.Errorf("%w: incomplete durable frame header", ErrRecoveryStoreCorrupt)
		}
		header := data[offset : offset+recoveryFrameHeaderBytes]
		if !bytes.Equal(header[:8], recoveryFrameMagic[:]) {
			return nil, 0, false, fmt.Errorf("%w: unknown durable frame magic", ErrRecoveryStoreCorrupt)
		}
		expectedHeader := sha256.Sum256(header[:16])
		if !bytes.Equal(expectedHeader[:], header[16:48]) {
			return nil, 0, false, fmt.Errorf("%w: invalid durable frame header", ErrRecoveryStoreCorrupt)
		}
		if binary.BigEndian.Uint16(header[8:10]) != RecoveryStoreSchemaVersion {
			return nil, 0, false, fmt.Errorf("%w: unsupported durable frame schema", ErrRecoveryStoreCorrupt)
		}
		kind := binary.BigEndian.Uint16(header[10:12])
		if !validRecoveryFrameKind(kind) {
			return nil, 0, false, fmt.Errorf("%w: unknown durable frame kind", ErrRecoveryStoreCorrupt)
		}
		length := int(binary.BigEndian.Uint32(header[12:16]))
		if length > recoveryFramePayloadLimit(kind) {
			return nil, 0, false, fmt.Errorf("%w: durable frame length exceeds its bound", ErrRecoveryStoreCorrupt)
		}
		end := offset + recoveryFrameHeaderBytes + length
		if end > len(data) {
			if allowTornFinal {
				return frames, offset, true, nil
			}
			return nil, 0, false, fmt.Errorf("%w: incomplete durable frame payload", ErrRecoveryStoreCorrupt)
		}
		payload := data[offset+recoveryFrameHeaderBytes : end]
		expectedPayload := sha256.Sum256(payload)
		if !bytes.Equal(expectedPayload[:], header[48:80]) {
			return nil, 0, false, fmt.Errorf("%w: durable frame checksum failed", ErrRecoveryStoreCorrupt)
		}
		if len(frames) == RecoveryStoreMaxJournalRecords+1 {
			return nil, 0, false, fmt.Errorf("%w: durable frame count exceeds hard limit", ErrRecoveryStoreCorrupt)
		}
		frames = append(frames, recoveryFrame{
			kind:    kind,
			payload: append([]byte(nil), payload...),
		})
		offset = end
	}
	return frames, offset, false, nil
}

func validRecoveryFrameKind(kind uint16) bool {
	switch kind {
	case recoveryFrameSnapshot, recoveryFrameJournalHeader, recoveryFrameMutation, recoveryFrameHistory:
		return true
	default:
		return false
	}
}

func recoveryFramePayloadLimit(kind uint16) int {
	switch kind {
	case recoveryFrameSnapshot:
		return recoverySnapshotMaxBytes
	case recoveryFrameJournalHeader:
		return recoveryJournalHeaderMax
	case recoveryFrameMutation:
		return RecoveryStoreMaxMutationBytes
	case recoveryFrameHistory:
		return RecoveryStoreMaxHistorySegmentBytes
	default:
		return 0
	}
}

func writeRecoveryAll(fd int, data []byte) error {
	for len(data) > 0 {
		written, err := unix.Write(fd, data)
		if written > 0 {
			data = data[written:]
		}
		if err != nil {
			return err
		}
		if written == 0 {
			return io.ErrShortWrite
		}
	}
	return nil
}

func readRecoveryAll(fd int, maximum int) ([]byte, error) {
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		return nil, err
	}
	if stat.Size < 0 || stat.Size > int64(maximum) {
		return nil, errors.New("durable file exceeds its bound")
	}
	data := make([]byte, int(stat.Size))
	offset := 0
	for offset < len(data) {
		count, err := unix.Pread(fd, data[offset:], int64(offset))
		if count > 0 {
			offset += count
		}
		if err != nil {
			return nil, err
		}
		if count == 0 {
			return nil, io.ErrUnexpectedEOF
		}
	}
	return data, nil
}

func openRecoveryRoot(root string) (int, error) {
	if root == "" || root == "/" || !filepath.IsAbs(root) || filepath.Clean(root) != root ||
		strings.ContainsRune(root, '\x00') {
		return -1, fmt.Errorf("%w: root must be a non-root clean absolute path", ErrRecoveryStoreUnsafePath)
	}
	components := strings.Split(strings.TrimPrefix(root, "/"), "/")
	if len(components) == 0 {
		return -1, fmt.Errorf("%w: root has no path components", ErrRecoveryStoreUnsafePath)
	}
	current, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, fmt.Errorf("%w: open filesystem root: %v", ErrRecoveryStoreUnsafePath, err)
	}
	for index, component := range components {
		if component == "" || component == "." || component == ".." {
			_ = unix.Close(current)
			return -1, fmt.Errorf("%w: invalid root path component", ErrRecoveryStoreUnsafePath)
		}
		final := index == len(components)-1
		created := false
		var stat unix.Stat_t
		err := unix.Fstatat(current, component, &stat, unix.AT_SYMLINK_NOFOLLOW)
		if errors.Is(err, unix.ENOENT) {
			if !final {
				_ = unix.Close(current)
				return -1, fmt.Errorf("%w: only the final root component may be created", ErrRecoveryStoreUnsafePath)
			}
			if err := unix.Mkdirat(current, component, 0o700); err != nil && !errors.Is(err, unix.EEXIST) {
				_ = unix.Close(current)
				return -1, fmt.Errorf("%w: create root: %v", ErrRecoveryStoreUnsafePath, err)
			} else if err == nil {
				created = true
			}
			if err := unix.Fstatat(current, component, &stat, unix.AT_SYMLINK_NOFOLLOW); err != nil {
				_ = unix.Close(current)
				return -1, fmt.Errorf("%w: stat created root: %v", ErrRecoveryStoreUnsafePath, err)
			}
		} else if err != nil {
			_ = unix.Close(current)
			return -1, fmt.Errorf("%w: inspect root path: %v", ErrRecoveryStoreUnsafePath, err)
		}
		if stat.Mode&unix.S_IFMT != unix.S_IFDIR {
			_ = unix.Close(current)
			return -1, fmt.Errorf("%w: root component is not a real directory", ErrRecoveryStoreUnsafePath)
		}
		next, err := unix.Openat(
			current,
			component,
			unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC,
			0,
		)
		if err != nil {
			_ = unix.Close(current)
			return -1, fmt.Errorf("%w: open root component without following links: %v", ErrRecoveryStoreUnsafePath, err)
		}
		if created {
			if err := unix.Fchmod(next, 0o700); err != nil {
				_ = unix.Close(next)
				_ = unix.Close(current)
				return -1, fmt.Errorf("%w: secure created root: %v", ErrRecoveryStoreUnsafePath, err)
			}
			if err := unix.Fsync(next); err != nil {
				_ = unix.Close(next)
				_ = unix.Close(current)
				return -1, fmt.Errorf("%w: sync created root: %v", ErrRecoveryStoreUnsafePath, err)
			}
			if err := unix.Fsync(current); err != nil {
				_ = unix.Close(next)
				_ = unix.Close(current)
				return -1, fmt.Errorf("%w: sync root parent: %v", ErrRecoveryStoreUnsafePath, err)
			}
		}
		if !final {
			_ = unix.Close(current)
			current = next
			continue
		}
		if err := verifyRecoveryDirectoryFD(next, true); err != nil {
			_ = unix.Close(next)
			_ = unix.Close(current)
			return -1, err
		}
		_ = unix.Close(current)
		return next, nil
	}
	_ = unix.Close(current)
	return -1, fmt.Errorf("%w: root walk did not reach final component", ErrRecoveryStoreUnsafePath)
}

func ensureRecoveryOwnedDirectory(parentFD int, name string) (int, error) {
	var stat unix.Stat_t
	err := unix.Fstatat(parentFD, name, &stat, unix.AT_SYMLINK_NOFOLLOW)
	created := false
	if errors.Is(err, unix.ENOENT) {
		if err := unix.Mkdirat(parentFD, name, 0o700); err != nil && !errors.Is(err, unix.EEXIST) {
			return -1, fmt.Errorf("%w: create owned directory: %v", ErrRecoveryStoreUnsafePath, err)
		} else if err == nil {
			created = true
		}
		if err := unix.Fstatat(parentFD, name, &stat, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			return -1, fmt.Errorf("%w: inspect created directory: %v", ErrRecoveryStoreUnsafePath, err)
		}
	} else if err != nil {
		return -1, fmt.Errorf("%w: inspect owned directory: %v", ErrRecoveryStoreUnsafePath, err)
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFDIR {
		return -1, fmt.Errorf("%w: expected directory is not a real directory", ErrRecoveryStoreUnsafePath)
	}
	fd, err := unix.Openat(
		parentFD,
		name,
		unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC,
		0,
	)
	if err != nil {
		return -1, fmt.Errorf("%w: open owned directory without following links: %v", ErrRecoveryStoreUnsafePath, err)
	}
	if created {
		if err := unix.Fchmod(fd, 0o700); err != nil {
			_ = unix.Close(fd)
			return -1, fmt.Errorf("%w: secure created directory: %v", ErrRecoveryStoreUnsafePath, err)
		}
		if err := unix.Fsync(fd); err != nil {
			_ = unix.Close(fd)
			return -1, fmt.Errorf("%w: sync created directory: %v", ErrRecoveryStoreUnsafePath, err)
		}
		if err := unix.Fsync(parentFD); err != nil {
			_ = unix.Close(fd)
			return -1, fmt.Errorf("%w: sync directory parent: %v", ErrRecoveryStoreUnsafePath, err)
		}
	}
	if err := verifyRecoveryDirectoryFD(fd, true); err != nil {
		_ = unix.Close(fd)
		return -1, err
	}
	return fd, nil
}

func verifyRecoveryDirectoryFD(fd int, ownerOnly bool) error {
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		return fmt.Errorf("%w: inspect directory descriptor: %v", ErrRecoveryStoreUnsafePath, err)
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFDIR {
		return fmt.Errorf("%w: expected a real directory", ErrRecoveryStoreUnsafePath)
	}
	if ownerOnly && (int(stat.Uid) != os.Geteuid() || stat.Mode&0o7777 != 0o700) {
		return fmt.Errorf("%w: directory is not effective-UID owned mode 0700", ErrRecoveryStoreUnsafePath)
	}
	return nil
}

func openRecoveryWriterLock(rootFD int) (int, error) {
	fd, exists, err := openRecoveryExistingFile(rootFD, recoveryWriterLockName, unix.O_RDWR)
	if err != nil {
		return -1, err
	}
	if !exists {
		fd, err = createRecoveryFile(rootFD, recoveryWriterLockName, unix.O_RDWR)
		if err != nil {
			return -1, err
		}
		if err := unix.Fsync(rootFD); err != nil {
			_ = unix.Close(fd)
			return -1, fmt.Errorf("%w: sync new writer lock: %v", ErrRecoveryStoreUnsafePath, err)
		}
	}
	if err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != nil {
		_ = unix.Close(fd)
		if errors.Is(err, unix.EWOULDBLOCK) || errors.Is(err, unix.EAGAIN) {
			return -1, ErrRecoveryStoreAlreadyOpen
		}
		return -1, fmt.Errorf("%w: acquire writer lock: %v", ErrRecoveryStoreUnsafePath, err)
	}
	return fd, nil
}

func openRecoveryExistingFile(dirFD int, name string, flags int) (int, bool, error) {
	var stat unix.Stat_t
	err := unix.Fstatat(dirFD, name, &stat, unix.AT_SYMLINK_NOFOLLOW)
	if errors.Is(err, unix.ENOENT) {
		return -1, false, nil
	}
	if err != nil {
		return -1, false, fmt.Errorf("%w: inspect expected file: %v", ErrRecoveryStoreUnsafePath, err)
	}
	if err := verifyRecoveryRegularStat(&stat); err != nil {
		return -1, false, err
	}
	fd, err := unix.Openat(dirFD, name, flags|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, false, fmt.Errorf("%w: open expected file without following links: %v", ErrRecoveryStoreUnsafePath, err)
	}
	if err := verifyRecoveryRegularFD(fd); err != nil {
		_ = unix.Close(fd)
		return -1, false, err
	}
	return fd, true, nil
}

func createRecoveryFile(dirFD int, name string, flags int) (int, error) {
	fd, err := unix.Openat(
		dirFD,
		name,
		flags|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC,
		0o600,
	)
	if err != nil {
		return -1, fmt.Errorf("%w: create expected file: %v", ErrRecoveryStoreUnsafePath, err)
	}
	if err := unix.Fchmod(fd, 0o600); err != nil {
		_ = unix.Close(fd)
		_ = unix.Unlinkat(dirFD, name, 0)
		return -1, fmt.Errorf("%w: secure created file: %v", ErrRecoveryStoreUnsafePath, err)
	}
	if err := verifyRecoveryRegularFD(fd); err != nil {
		_ = unix.Close(fd)
		_ = unix.Unlinkat(dirFD, name, 0)
		return -1, err
	}
	return fd, nil
}

func verifyRecoveryRegularStat(stat *unix.Stat_t) error {
	if stat.Mode&unix.S_IFMT != unix.S_IFREG ||
		int(stat.Uid) != os.Geteuid() ||
		stat.Mode&0o7777 != 0o600 ||
		stat.Nlink != 1 {
		return fmt.Errorf("%w: expected file is not effective-UID owned regular mode 0600 with one link", ErrRecoveryStoreUnsafePath)
	}
	return nil
}

func verifyRecoveryRegularFD(fd int) error {
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		return fmt.Errorf("%w: inspect file descriptor: %v", ErrRecoveryStoreUnsafePath, err)
	}
	return verifyRecoveryRegularStat(&stat)
}

func recoveryExpectedFileExists(dirFD int, name string) (bool, error) {
	fd, exists, err := openRecoveryExistingFile(dirFD, name, unix.O_RDONLY)
	if fd >= 0 {
		_ = unix.Close(fd)
	}
	return exists, err
}

func discardRecoveryPendingFile(dirFD int, name string) error {
	fd, exists, err := openRecoveryExistingFile(dirFD, name, unix.O_RDONLY)
	if err != nil || !exists {
		return err
	}
	if err := unix.Close(fd); err != nil {
		return fmt.Errorf("%w: close expected file before removal: %v", ErrRecoveryStoreUnsafePath, err)
	}
	if err := unix.Unlinkat(dirFD, name, 0); err != nil {
		return fmt.Errorf("%w: remove expected file: %v", ErrRecoveryStoreUnsafePath, err)
	}
	if err := unix.Fsync(dirFD); err != nil {
		return fmt.Errorf("%w: sync expected file removal: %v", ErrRecoveryStoreUnsafePath, err)
	}
	return nil
}

func removeRecoveryExpectedFile(dirFD int, name string) error {
	fd, exists, err := openRecoveryExistingFile(dirFD, name, unix.O_RDONLY)
	if err != nil {
		return err
	}
	if !exists {
		return fmt.Errorf("%w: expected durable file is missing", ErrRecoveryStoreCorrupt)
	}
	if err := unix.Close(fd); err != nil {
		return fmt.Errorf("%w: close expected durable file: %v", ErrRecoveryStoreUnsafePath, err)
	}
	if err := unix.Unlinkat(dirFD, name, 0); err != nil {
		return fmt.Errorf("%w: remove expected durable file: %v", ErrRecoveryStoreUnsafePath, err)
	}
	return nil
}

func createRecoveryJournal(rootFD int, generation RecoveryStoreGeneration) (int, error) {
	frame, err := recoveryJournalHeaderFrame(generation)
	if err != nil {
		return -1, err
	}
	fd, err := createRecoveryFile(rootFD, recoveryJournalCurrentName, unix.O_RDWR|unix.O_APPEND)
	if err != nil {
		return -1, err
	}
	if err := writeRecoveryAll(fd, frame); err != nil {
		_ = unix.Close(fd)
		return -1, fmt.Errorf("%w: write new journal: %v", ErrRecoveryStoreUnsafePath, err)
	}
	if err := unix.Fsync(fd); err != nil {
		_ = unix.Close(fd)
		return -1, fmt.Errorf("%w: sync new journal: %v", ErrRecoveryStoreUnsafePath, err)
	}
	if err := unix.Fsync(rootFD); err != nil {
		_ = unix.Close(fd)
		return -1, fmt.Errorf("%w: sync new journal parent: %v", ErrRecoveryStoreUnsafePath, err)
	}
	return fd, nil
}

func readRecoveryDirectoryNames(dirFD int, maximumRecognized int) ([]string, error) {
	duplicate, err := unix.Dup(dirFD)
	if err != nil {
		return nil, fmt.Errorf("%w: duplicate history descriptor: %v", ErrRecoveryStoreUnsafePath, err)
	}
	directory := os.NewFile(uintptr(duplicate), "recovery-history")
	names := make([]string, 0, minimumInt(maximumRecognized, 128))
	for {
		entries, readErr := directory.ReadDir(128)
		for _, entry := range entries {
			if _, ok := parseRecoveryHistoryFilename(entry.Name()); !ok {
				continue
			}
			if len(names) >= maximumRecognized {
				_ = directory.Close()
				return nil, fmt.Errorf("%w: history segment count exceeds hard limit", ErrRecoveryStoreCorrupt)
			}
			names = append(names, entry.Name())
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			_ = directory.Close()
			return nil, fmt.Errorf("%w: read history directory: %v", ErrRecoveryStoreUnsafePath, readErr)
		}
	}
	if err := directory.Close(); err != nil {
		return nil, fmt.Errorf("%w: close history directory: %v", ErrRecoveryStoreUnsafePath, err)
	}
	sort.Strings(names)
	return names, nil
}

func recoveryHistoryFilename(sequence uint64) string {
	return fmt.Sprintf("segment-%020d.rec", sequence)
}

func parseRecoveryHistoryFilename(name string) (uint64, bool) {
	const prefix = "segment-"
	const suffix = ".rec"
	if !strings.HasPrefix(name, prefix) || !strings.HasSuffix(name, suffix) ||
		len(name) != len(prefix)+20+len(suffix) {
		return 0, false
	}
	digits := name[len(prefix) : len(name)-len(suffix)]
	for _, digit := range digits {
		if digit < '0' || digit > '9' {
			return 0, false
		}
	}
	sequence, err := strconv.ParseUint(digits, 10, 64)
	return sequence, err == nil && sequence != 0
}
