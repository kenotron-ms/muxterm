package recoveryhooks

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"unicode/utf8"
)

const (
	maxIntegrationBytes   = 128
	maxAnchorBytes        = 64
	maxKindBytes          = 64
	maxLocatorBytes       = 512
	maxRelativePathBytes  = 1024
	maxRelativePathDepth  = 16
	maxConfigBytes        = 1 << 20
	maxFragmentBytes      = 64 << 10
	maxManifestBytes      = 256 << 10
	maxManifestEntries    = 64
	maxTempAttempts       = 64
	maxRootPathBytes      = 4096
	maxRootPathDepth      = 64
	maxPathComponentBytes = 255
	managerLockName       = "manager.lock"
	manifestFileName      = "manifest.json"
)

var (
	ErrInvalid       = errors.New("recoveryhooks: invalid")
	ErrUnsafePath    = errors.New("recoveryhooks: unsafe path")
	ErrConflict      = errors.New("recoveryhooks: conflict")
	ErrClosed        = errors.New("recoveryhooks: closed")
	ErrBusy          = errors.New("recoveryhooks: busy")
	ErrCorrupt       = errors.New("recoveryhooks: corrupt")
	ErrIndeterminate = errors.New("recoveryhooks: indeterminate")
)

type Integration string

type Anchor string

type Operation uint8

const (
	OperationInstall Operation = iota + 1
	OperationUninstall
	OperationStatus
)

type ConfigAnchor struct {
	Name Anchor
	Root string
}

type ConfigTarget struct {
	Anchor       Anchor
	RelativePath string
	Kind         string
}

// ManifestEntry is the entire durable manifest schema. It must remain
// content-free and must not gain recovery authority fields.
type ManifestEntry struct {
	Integration    Integration `json:"integration"`
	Anchor         Anchor      `json:"anchor"`
	RelativePath   string      `json:"relativePath"`
	Kind           string      `json:"kind"`
	Locator        string      `json:"locator"`
	FragmentSHA256 string      `json:"fragmentSHA256"`
}

type CurrentFile struct {
	Exists bool
	Bytes  []byte
}

type EditDisposition uint8

const (
	EditNoop EditDisposition = iota + 1
	EditChange
	EditConflict
)

// EditPlan carries a complete replacement candidate and an in-memory canonical
// fragment. Present describes the fragment after install/status and before
// uninstall.
type EditPlan struct {
	Disposition     EditDisposition
	Candidate       []byte
	Locator         string
	ManagedFragment []byte
	Present         bool
}

type SemanticEditor interface {
	Plan(context.Context, Operation, CurrentFile, *ManifestEntry) (EditPlan, error)
}

type ManagerOptions struct {
	Integration Integration
	StateRoot   string
	Anchors     []ConfigAnchor
}

type CommitState uint8

const (
	CommitUnchanged CommitState = iota + 1
	CommitDurable
	CommitIndeterminate
)

// Result deliberately excludes integration, anchor, path, locator, hash,
// content, callback, session, environment, credential, transcript, and
// filesystem authority values.
type Result struct {
	Operation   Operation
	Disposition EditDisposition
	Present     bool
	Commit      CommitState
}

// rootHandle and its descriptor helpers are provided by atomic_config.go.
type Manager struct {
	mu sync.Mutex

	integration Integration
	stateRoot   *rootHandle
	anchors     map[Anchor]*rootHandle
	anchorOrder []Anchor

	managerLockFD int
	initialized   bool
	closed        bool
	poisoned      bool
}

type normalizedManagerOptions struct {
	integration Integration
	stateRoot   string
	anchors     []ConfigAnchor
}

// OpenManager validates and copies every caller-controlled option before it
// invokes the descriptor-relative Task 2 helpers. State-root creation is only
// permitted for its final component; anchors are opened as existing roots.
func OpenManager(options ManagerOptions) (*Manager, error) {
	normalized, err := normalizeManagerOptions(options)
	if err != nil {
		return nil, err
	}

	manager := &Manager{
		integration:   normalized.integration,
		anchors:       make(map[Anchor]*rootHandle, len(normalized.anchors)),
		anchorOrder:   make([]Anchor, 0, len(normalized.anchors)),
		managerLockFD: -1,
		initialized:   true,
	}
	opened := false
	defer func() {
		if !opened {
			manager.closeDescriptorsLocked()
		}
	}()

	stateRoot, err := openManagedRoot(normalized.stateRoot, true)
	if err != nil {
		closeRootHandle(stateRoot)
		return nil, redactPhaseError(err, ErrUnsafePath, "open state root")
	}
	if !validRootHandle(stateRoot) {
		closeRootHandle(stateRoot)
		return nil, fixedPhaseError(ErrUnsafePath, "validate state root")
	}
	manager.stateRoot = stateRoot

	for _, anchor := range normalized.anchors {
		handle, err := openManagedRoot(anchor.Root, false)
		if err != nil {
			closeRootHandle(handle)
			return nil, redactPhaseError(err, ErrUnsafePath, "open anchor")
		}
		if !validRootHandle(handle) {
			closeRootHandle(handle)
			return nil, fixedPhaseError(ErrUnsafePath, "validate anchor")
		}
		if rootIsEqualOrBelow(manager.stateRoot, handle) {
			closeRootHandle(handle)
			return nil, fixedPhaseError(ErrUnsafePath, "state root below anchor")
		}
		if manager.hasRootAlias(handle) {
			closeRootHandle(handle)
			return nil, fixedPhaseError(ErrUnsafePath, "duplicate root descriptor")
		}

		manager.anchors[anchor.Name] = handle
		manager.anchorOrder = append(manager.anchorOrder, anchor.Name)
	}

	lockFD, err := openGlobalLock(manager.stateRoot)
	if err != nil {
		unlockAndClose(&lockFD)
		return nil, redactPhaseError(err, ErrUnsafePath, "acquire manager lock")
	}
	if lockFD < 0 {
		return nil, fixedPhaseError(ErrUnsafePath, "validate manager lock")
	}
	manager.managerLockFD = lockFD

	opened = true
	return manager, nil
}

// Close releases the lifetime manager lock and every retained descriptor in
// reverse ownership order. It is idempotent.
func (m *Manager) Close() error {
	if m == nil {
		return nil
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil
	}

	m.closeDescriptorsLocked()
	m.closed = true
	return nil
}

func (m *Manager) closeDescriptorsLocked() {
	if !m.initialized {
		m.managerLockFD = -1
		m.stateRoot = nil
		m.anchorOrder = nil
		m.anchors = nil
		return
	}

	unlockAndClose(&m.managerLockFD)
	m.managerLockFD = -1
	for index := len(m.anchorOrder) - 1; index >= 0; index-- {
		anchor := m.anchorOrder[index]
		closeRootHandle(m.anchors[anchor])
		delete(m.anchors, anchor)
	}
	m.anchorOrder = nil
	m.anchors = nil
	closeRootHandle(m.stateRoot)
	m.stateRoot = nil
	m.initialized = false
}

func (m *Manager) hasRootAlias(candidate *rootHandle) bool {
	if sameRootObject(m.stateRoot, candidate) {
		return true
	}
	for _, existing := range m.anchors {
		if sameRootObject(existing, candidate) {
			return true
		}
	}
	return false
}

func (m *Manager) ensureUsableLocked() error {
	if m == nil || !m.initialized || m.closed {
		return ErrClosed
	}
	if m.poisoned {
		return ErrIndeterminate
	}
	return nil
}

func (m *Manager) poisonLocked() {
	m.poisoned = true
}

func normalizeManagerOptions(options ManagerOptions) (normalizedManagerOptions, error) {
	anchors := make([]ConfigAnchor, len(options.Anchors))
	copy(anchors, options.Anchors)
	normalized := normalizedManagerOptions{
		integration: options.Integration,
		stateRoot:   options.StateRoot,
		anchors:     anchors,
	}

	if err := validateIntegration(normalized.integration); err != nil {
		return normalizedManagerOptions{}, err
	}
	if err := validateRootPath(normalized.stateRoot); err != nil {
		return normalizedManagerOptions{}, err
	}
	if len(normalized.anchors) == 0 || len(normalized.anchors) > maxManifestEntries {
		return normalizedManagerOptions{}, fixedPhaseError(ErrInvalid, "anchor count")
	}

	names := make(map[Anchor]struct{}, len(normalized.anchors))
	roots := make(map[string]struct{}, len(normalized.anchors)+1)
	roots[normalized.stateRoot] = struct{}{}
	for index := range normalized.anchors {
		anchor := normalized.anchors[index]
		if err := validateAnchor(anchor.Name); err != nil {
			return normalizedManagerOptions{}, err
		}
		if err := validateRootPath(anchor.Root); err != nil {
			return normalizedManagerOptions{}, err
		}
		if _, exists := names[anchor.Name]; exists {
			return normalizedManagerOptions{}, fixedPhaseError(ErrInvalid, "duplicate anchor")
		}
		if _, exists := roots[anchor.Root]; exists {
			return normalizedManagerOptions{}, fixedPhaseError(ErrUnsafePath, "duplicate root")
		}
		if rootPathIsEqualOrBelow(normalized.stateRoot, anchor.Root) {
			return normalizedManagerOptions{}, fixedPhaseError(ErrUnsafePath, "state root below anchor")
		}

		names[anchor.Name] = struct{}{}
		roots[anchor.Root] = struct{}{}
	}
	return normalized, nil
}

func validateIntegration(integration Integration) error {
	return validateIdentifier(string(integration), maxIntegrationBytes, "integration")
}

func validateAnchor(anchor Anchor) error {
	return validateIdentifier(string(anchor), maxAnchorBytes, "anchor")
}

func validateKind(kind string) error {
	return validateIdentifier(kind, maxKindBytes, "kind")
}

func validateIdentifier(value string, maximum int, phase string) error {
	if len(value) == 0 || len(value) > maximum || !isASCIIAlphanumeric(value[0]) {
		return fixedPhaseError(ErrInvalid, phase)
	}
	for index := 1; index < len(value); index++ {
		if !isASCIIAlphanumeric(value[index]) && value[index] != '.' &&
			value[index] != '_' && value[index] != '-' {
			return fixedPhaseError(ErrInvalid, phase)
		}
	}
	return nil
}

func validateLocator(locator string) error {
	if locator == "" || len(locator) > maxLocatorBytes || !utf8.ValidString(locator) ||
		strings.TrimSpace(locator) != locator {
		return fixedPhaseError(ErrInvalid, "locator")
	}
	for index := 0; index < len(locator); index++ {
		if locator[index] <= 0x1f || locator[index] == 0x7f {
			return fixedPhaseError(ErrInvalid, "locator")
		}
	}
	return nil
}

func validateRelativePath(path string) error {
	if path == "" || len(path) > maxRelativePathBytes || !utf8.ValidString(path) ||
		filepath.IsAbs(path) || filepath.Clean(path) != path ||
		strings.ContainsRune(path, '\x00') || strings.ContainsRune(path, '\\') ||
		strings.Contains(path, "//") {
		return fixedPhaseError(ErrUnsafePath, "relative path")
	}

	components := strings.Split(path, "/")
	if len(components) == 0 || len(components) > maxRelativePathDepth {
		return fixedPhaseError(ErrUnsafePath, "relative path")
	}
	for _, component := range components {
		if component == "." || component == ".." || len(component) == 0 ||
			len(component) > maxPathComponentBytes {
			return fixedPhaseError(ErrUnsafePath, "relative path")
		}
		for index := 0; index < len(component); index++ {
			if !isPathComponentByte(component[index]) {
				return fixedPhaseError(ErrUnsafePath, "relative path")
			}
		}
	}
	return nil
}

func validateRootPath(path string) error {
	if path == "" || path == "/" || len(path) > maxRootPathBytes ||
		!filepath.IsAbs(path) || filepath.Clean(path) != path ||
		strings.ContainsRune(path, '\x00') || strings.ContainsRune(path, '\\') {
		return fixedPhaseError(ErrUnsafePath, "root path")
	}

	components := strings.Split(strings.TrimPrefix(path, "/"), "/")
	if len(components) == 0 || len(components) > maxRootPathDepth {
		return fixedPhaseError(ErrUnsafePath, "root path")
	}
	for _, component := range components {
		if component == "" || component == "." || component == ".." ||
			len(component) > maxPathComponentBytes {
			return fixedPhaseError(ErrUnsafePath, "root path")
		}
	}
	return nil
}

func validateFragmentSHA256(value string) error {
	if len(value) != 64 {
		return fixedPhaseError(ErrInvalid, "fragment SHA-256")
	}
	for index := 0; index < len(value); index++ {
		if (value[index] < '0' || value[index] > '9') &&
			(value[index] < 'a' || value[index] > 'f') {
			return fixedPhaseError(ErrInvalid, "fragment SHA-256")
		}
	}
	return nil
}

func validateConfigTarget(target ConfigTarget) error {
	if err := validateAnchor(target.Anchor); err != nil {
		return err
	}
	if err := validateRelativePath(target.RelativePath); err != nil {
		return err
	}
	components := strings.Split(target.RelativePath, "/")
	if reservedConfigTargetLeaf(components[len(components)-1]) {
		return fixedPhaseError(ErrUnsafePath, "reserved config target")
	}
	return validateKind(target.Kind)
}

func validateManifestEntry(entry ManifestEntry) error {
	if err := validateIntegration(entry.Integration); err != nil {
		return err
	}
	if err := validateAnchor(entry.Anchor); err != nil {
		return err
	}
	if err := validateRelativePath(entry.RelativePath); err != nil {
		return err
	}
	if err := validateKind(entry.Kind); err != nil {
		return err
	}
	if err := validateLocator(entry.Locator); err != nil {
		return err
	}
	return validateFragmentSHA256(entry.FragmentSHA256)
}

func validateOperation(operation Operation) error {
	switch operation {
	case OperationInstall, OperationUninstall, OperationStatus:
		return nil
	default:
		return fixedPhaseError(ErrInvalid, "operation")
	}
}

func validateEditDisposition(disposition EditDisposition) error {
	switch disposition {
	case EditNoop, EditChange, EditConflict:
		return nil
	default:
		return fixedPhaseError(ErrInvalid, "edit disposition")
	}
}

func validateCommitState(state CommitState) error {
	switch state {
	case CommitUnchanged, CommitDurable, CommitIndeterminate:
		return nil
	default:
		return fixedPhaseError(ErrInvalid, "commit state")
	}
}

func validateCurrentFile(current CurrentFile) error {
	if len(current.Bytes) > maxConfigBytes || (!current.Exists && len(current.Bytes) != 0) {
		return fixedPhaseError(ErrInvalid, "current file")
	}
	return nil
}

func validateConfigBytes(data []byte) error {
	if len(data) > maxConfigBytes {
		return fixedPhaseError(ErrInvalid, "config bytes")
	}
	return nil
}

func validateManagedFragment(data []byte) error {
	if len(data) > maxFragmentBytes {
		return fixedPhaseError(ErrInvalid, "managed fragment")
	}
	return nil
}

func validateManifestBytes(data []byte) error {
	if len(data) > maxManifestBytes {
		return fixedPhaseError(ErrInvalid, "manifest bytes")
	}
	return nil
}

func cloneBytes(data []byte) []byte {
	if data == nil {
		return nil
	}
	clone := make([]byte, len(data))
	copy(clone, data)
	return clone
}

func cloneCurrentFile(current CurrentFile) CurrentFile {
	return CurrentFile{
		Exists: current.Exists,
		Bytes:  cloneBytes(current.Bytes),
	}
}

func cloneEditPlan(plan EditPlan) EditPlan {
	return EditPlan{
		Disposition:     plan.Disposition,
		Candidate:       cloneBytes(plan.Candidate),
		Locator:         plan.Locator,
		ManagedFragment: cloneBytes(plan.ManagedFragment),
		Present:         plan.Present,
	}
}

func validRootHandle(handle *rootHandle) bool {
	if handle == nil || handle.fd < 0 || handle.inode == 0 || len(handle.lineage) == 0 {
		return false
	}
	final := handle.lineage[len(handle.lineage)-1]
	return final.device == handle.device && final.inode == handle.inode
}

func sameRootObject(left, right *rootHandle) bool {
	return left != nil && right != nil && left.device == right.device && left.inode == right.inode
}

func rootIsEqualOrBelow(descendant, ancestor *rootHandle) bool {
	if !validRootHandle(descendant) || !validRootHandle(ancestor) {
		return false
	}
	for _, component := range descendant.lineage {
		if component.device == ancestor.device && component.inode == ancestor.inode {
			return true
		}
	}
	return false
}

func rootPathIsEqualOrBelow(path, ancestor string) bool {
	return path == ancestor || strings.HasPrefix(path, ancestor+"/")
}

func reservedConfigTargetLeaf(leaf string) bool {
	lower := strings.ToLower(leaf)
	return lower == strings.ToLower(managerLockName) ||
		lower == strings.ToLower(manifestFileName) ||
		strings.HasPrefix(lower, controlNamePrefix)
}

func closeRootHandle(handle *rootHandle) {
	if handle == nil || handle.fd < 0 {
		return
	}
	closeFD(&handle.fd)
	handle.fd = -1
	handle.lineage = nil
}

func redactPhaseError(cause, fallback error, phase string) error {
	switch {
	case errors.Is(cause, ErrInvalid):
		return fixedPhaseError(ErrInvalid, phase)
	case errors.Is(cause, ErrUnsafePath):
		return fixedPhaseError(ErrUnsafePath, phase)
	case errors.Is(cause, ErrConflict):
		return fixedPhaseError(ErrConflict, phase)
	case errors.Is(cause, ErrClosed):
		return fixedPhaseError(ErrClosed, phase)
	case errors.Is(cause, ErrBusy):
		return fixedPhaseError(ErrBusy, phase)
	case errors.Is(cause, ErrCorrupt):
		return fixedPhaseError(ErrCorrupt, phase)
	case errors.Is(cause, ErrIndeterminate):
		return fixedPhaseError(ErrIndeterminate, phase)
	default:
		return fixedPhaseError(fallback, phase)
	}
}

func fixedPhaseError(sentinel error, phase string) error {
	return fmt.Errorf("%w: %s", sentinel, phase)
}

func isASCIIAlphanumeric(value byte) bool {
	return value >= 'a' && value <= 'z' ||
		value >= 'A' && value <= 'Z' ||
		value >= '0' && value <= '9'
}

func isPathComponentByte(value byte) bool {
	return isASCIIAlphanumeric(value) || value == '.' || value == '_' || value == '-'
}
