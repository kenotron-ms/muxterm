// Package workspaceauth contains muxterm's internal owner-only authorization
// vocabulary. It deliberately has no HTTP, token, user, host, or transport
// identity integration.
package workspaceauth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
)

const (
	ownerRecordVersion = 1
	metadataVersion    = 1
	policyRefVersion   = 1
	PolicyOwnerOnly    = "owner-only"
)

// PrincipalID is an opaque internal installation-owner identifier.
type PrincipalID string

// WorkspaceID is an opaque internal workspace security identifier. It is not
// a sessiond runtime workspace ID, pane ID, host ID, or browser identifier.
type WorkspaceID string

// InstanceOwner is the private, durable owner record for one muxterm instance.
type InstanceOwner struct {
	V         int         `json:"v"`
	Principal PrincipalID `json:"owner_principal_id"`
}

// PolicyRef is a forward-compatible policy reference slot without introducing
// a policy language, ACL, grant, or membership data.
type PolicyRef struct {
	V    int    `json:"v"`
	Kind string `json:"kind"`
	Ref  string `json:"ref"`
}

// Metadata is versioned owner-only workspace security data persisted only in
// the sessiond restore snapshot.
type Metadata struct {
	V         int         `json:"v"`
	Workspace WorkspaceID `json:"workspace_security_id"`
	Owner     PrincipalID `json:"owner_principal_id"`
	Policy    PolicyRef   `json:"policy"`
}

// Action and ResourceKind are deliberately typed so later sharing work has one
// evaluator seam instead of ad-hoc boolean checks.
type Action string
type ResourceKind string

const (
	ActionAccess Action = "access"
	ActionRead   Action = "read"
	ActionWrite  Action = "write"

	ResourceInstance  ResourceKind = "instance"
	ResourceWorkspace ResourceKind = "workspace"
)

// Resource identifies the authorization target. Workspace security IDs never
// cross muxterm's existing wire protocol.
type Resource struct {
	Kind               ResourceKind
	Workspace          WorkspaceID // daemon-private security ID; absent at browser boundary
	RuntimeWorkspaceID string      // trusted internal runtime lookup handle, never a principal
	HostID             string      // routing scope only, never a principal
}

// ErrUnauthorized is deliberately generic: callers must not use it to expose
// resource existence, owner identity, or metadata validation details.
var ErrUnauthorized = errors.New("authorization denied")

// Authorizer is the sole authorization evaluator used by this foundation.
type Authorizer interface {
	Authorize(PrincipalID, Action, Resource) error
}

type ownerOnlyAuthorizer struct{ owner PrincipalID }

// NewOwnerOnlyAuthorizer returns the only evaluator supported today.
func NewOwnerOnlyAuthorizer(owner InstanceOwner) (Authorizer, error) {
	if err := owner.Validate(); err != nil {
		return nil, fmt.Errorf("invalid instance owner")
	}
	return ownerOnlyAuthorizer{owner: owner.Principal}, nil
}

func (a ownerOnlyAuthorizer) Authorize(principal PrincipalID, _ Action, _ Resource) error {
	if principal == "" || principal != a.owner {
		return ErrUnauthorized
	}
	return nil
}

// NewEphemeralOwner creates an owner suitable for in-memory legacy
// constructors and code-level integration construction. It never persists.
func NewEphemeralOwner() (InstanceOwner, error) {
	id, err := newID()
	if err != nil {
		return InstanceOwner{}, fmt.Errorf("generate owner")
	}
	return InstanceOwner{V: ownerRecordVersion, Principal: PrincipalID(id)}, nil
}

// NewMetadata creates fresh owner-only metadata for one workspace.
func NewMetadata(owner InstanceOwner) (Metadata, error) {
	if err := owner.Validate(); err != nil {
		return Metadata{}, fmt.Errorf("invalid instance owner")
	}
	id, err := newID()
	if err != nil {
		return Metadata{}, fmt.Errorf("generate workspace security id")
	}
	return Metadata{
		V:         metadataVersion,
		Workspace: WorkspaceID(id),
		Owner:     owner.Principal,
		Policy:    PolicyRef{V: policyRefVersion, Kind: PolicyOwnerOnly},
	}, nil
}

func newID() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b[:]), nil
}

// Validate checks an instance owner record without disclosing record contents.
func (o InstanceOwner) Validate() error {
	if o.V != ownerRecordVersion || !validID(string(o.Principal)) {
		return errors.New("invalid owner record")
	}
	return nil
}

// ValidateFor verifies current metadata is owner-only and bound to owner.
func (m Metadata) ValidateFor(owner InstanceOwner) error {
	if err := owner.Validate(); err != nil || m.V != metadataVersion ||
		!validID(string(m.Workspace)) || !validID(string(m.Owner)) ||
		!m.Policy.validOwnerOnly() ||
		m.Owner != owner.Principal {
		return errors.New("invalid workspace security metadata")
	}
	return nil
}

// ValidateStructure verifies current metadata without asserting which instance
// owns it. It is used only to decide whether a missing owner record is unsafe
// to bootstrap.
func (m Metadata) ValidateStructure() error {
	if m.V != metadataVersion || !validID(string(m.Workspace)) || !validID(string(m.Owner)) ||
		!m.Policy.validOwnerOnly() {
		return errors.New("invalid workspace security metadata")
	}
	return nil
}

func (p PolicyRef) validOwnerOnly() bool {
	return p.V == policyRefVersion && p.Kind == PolicyOwnerOnly && p.Ref == ""
}

func validID(value string) bool {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	return err == nil && len(decoded) == 32 &&
		base64.RawURLEncoding.EncodeToString(decoded) == value
}

// Admission is a server-created subject plus a renewable validity check. The
// check is deliberately private and is never serialized, logged, or exposed to
// browser/sessiond/MCP wires.
type Admission struct {
	Principal PrincipalID
	valid     func() bool
}

// NewAdmission creates a code-only admission. The validity closure must be
// supplied by the server boundary; it is typically a token-store recheck.
func NewAdmission(principal PrincipalID, valid func() bool) (Admission, error) {
	if !validID(string(principal)) || valid == nil {
		return Admission{}, errors.New("invalid admission")
	}
	return Admission{Principal: principal, valid: valid}, nil
}

// NewLocalOwnerAdmission creates a renewable local-owner admission for
// --no-auth, loopback, and same-UID helper compatibility paths.
func NewLocalOwnerAdmission(principal PrincipalID) (Admission, error) {
	return NewAdmission(principal, func() bool { return true })
}

// Valid rechecks the admission without exposing why it is invalid.
func (a Admission) Valid() bool {
	return validID(string(a.Principal)) && a.valid != nil && a.valid()
}

func (a Admission) IsZero() bool { return a.Principal == "" && a.valid == nil }

type admissionContextKey struct{}

// WithAdmission is internal context plumbing; no request/header parsing can
// manufacture a principal or validity handle.
func WithAdmission(ctx context.Context, admission Admission) context.Context {
	return context.WithValue(ctx, admissionContextKey{}, admission)
}

// AdmissionFromContext returns the internally-injected admission, if any.
func AdmissionFromContext(ctx context.Context) (Admission, bool) {
	a, ok := ctx.Value(admissionContextKey{}).(Admission)
	return a, ok && !a.IsZero()
}
