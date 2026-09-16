package sandboxazure

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

var (
	ErrStaleGeneration   = errors.New("direct Azure sandbox lifecycle generation is stale")
	ErrRequestCollision  = errors.New("direct Azure sandbox request id was already used for a different operation")
	ErrAttachUnsupported = errors.New("sandbox attach is unsupported: Azure Sandbox port transport has not established authenticated sessiond WebSocket framing")
	ErrReconcileRequired = errors.New("direct Azure sandbox requires reconciliation before this operation")
)

// operationTimeout bounds a serialized controller/provider attempt. The store
// lock is intentionally held across that one attempt, so two lifecycle changes
// cannot race the same durable mapping.
const operationTimeout = 30 * time.Second

// Lifecycle is the server-wiring seam. A future authenticated server adapter
// may depend on this typed owner-local interface; it must not accept Azure
// endpoints, credentials, provider IDs, or arbitrary requests from a browser.
type Lifecycle interface {
	List(context.Context) ([]View, error)
	Describe(context.Context, string) (View, error)
	Create(context.Context, string, string) (View, error)
	Stop(context.Context, string, uint64, string) (View, error)
	Resume(context.Context, string, uint64, string) (View, error)
	Destroy(context.Context, string, uint64, string) (View, error)
	Reconcile(context.Context, string, uint64, string) (View, error)
	Attach(string, uint64, string) error
}

// Controller is the lifecycle authority for muxterm's opaque handles and
// durable mapping. List and Describe report only persisted local truth and
// never construct a credential or make a cloud request. Reconcile is the sole
// explicit observation operation.
type Controller struct {
	config    Config
	store     *Store
	providers ProviderFactory
}

func NewController(config Config, providers ProviderFactory) (*Controller, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	if !config.Enabled {
		return nil, ErrDisabled
	}
	if providers == nil {
		return nil, errors.New("direct Azure sandbox provider factory is required")
	}
	store, err := NewStore(config.StoreDir)
	if err != nil {
		return nil, err
	}
	return &Controller{config: config, store: store, providers: providers}, nil
}

func (c *Controller) List(_ context.Context) ([]View, error) {
	var result []View
	err := c.store.WithLock(func() error {
		records, err := c.store.List()
		if err != nil {
			return err
		}
		for _, r := range records {
			result = append(result, r.View())
		}
		sort.Slice(result, func(i, j int) bool { return result[i].Handle < result[j].Handle })
		return nil
	})
	return result, err
}

func (c *Controller) Describe(_ context.Context, handle string) (View, error) {
	var result View
	err := c.store.WithLock(func() error {
		r, err := c.store.Load(handle)
		if err != nil {
			return err
		}
		result = r.View()
		return nil
	})
	return result, err
}

// Create persists an intent and stable UUID before calling Azure. A returned
// accepted state means only that the provider accepted the request, not that it
// reached Running. Exact retries return the original durable operation.
func (c *Controller) Create(ctx context.Context, profileName, requestID string) (View, error) {
	if c.config.KillSwitch {
		return View{}, ErrKillSwitch
	}
	if err := validRequestID(requestID); err != nil {
		return View{}, err
	}
	var result View
	err := c.store.WithLock(func() error {
		if prior, err := c.store.FindRequest(requestID); err == nil {
			op := prior.operation(requestID)
			if op == nil || op.Kind != "create" || op.ExpectedGeneration != 0 || prior.ProfileName != profileName {
				return ErrRequestCollision
			}
			result = prior.viewFor(*op)
			return nil
		} else if !errors.Is(err, ErrRecordNotFound) {
			return err
		}
		profile, err := c.config.Profile(profileName)
		if err != nil {
			return err
		}
		_, private, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return errors.New("direct Azure sandbox signer generation failed")
		}
		op := OperationRecord{RequestID: requestID, Kind: "create", ExpectedGeneration: 0, DesiredState: "running", State: OperationPending}
		r := Record{
			Handle: uuid.NewString(), ProfileName: profile.Name, ProfileChecksum: profile.Checksum(),
			Generation: 1, RequestID: requestID, Operation: op.Kind, OperationState: op.State,
			ExpectedGeneration: op.ExpectedGeneration, DesiredState: op.DesiredState, ObservedState: "unknown",
			ReconcileState: ReconcileNeeded, SignerPrivateKey: base64.RawStdEncoding.EncodeToString(private),
			Operations: []OperationRecord{op}, CreatedAt: time.Now().UTC(),
		}
		if err := c.store.Save(r); err != nil {
			return err
		}
		result = r.View()
		provider, err := c.providers(profile)
		if err != nil {
			c.setOperation(&r, requestID, OperationFailed)
			r.ReconcileState = ReconcileClean
			if saveErr := c.store.Save(r); saveErr != nil {
				return saveErr
			}
			result = r.View()
			return errors.New("direct Azure sandbox provider initialization failed")
		}
		spec, err := createSpec(profile, r)
		if err != nil {
			c.setOperation(&r, requestID, OperationFailed)
			r.ReconcileState = ReconcileClean
			if saveErr := c.store.Save(r); saveErr != nil {
				return saveErr
			}
			result = r.View()
			return errors.New("direct Azure sandbox runtime contract could not be admitted")
		}
		providerCtx, cancel := context.WithTimeout(ctx, operationTimeout)
		defer cancel()
		s, err := provider.Create(providerCtx, spec)
		if err != nil {
			err = c.recordProviderFailure(&r, requestID, err)
			result = r.View()
			return err
		}
		if strings.TrimSpace(s.ID) == "" {
			err = c.recordProviderFailure(&r, requestID, ErrProviderAmbiguous)
			result = r.View()
			return err
		}
		r.ProviderID, r.ObservedState, r.ReconcileState = s.ID, stateOrUnknown(s.State), ReconcileNeeded
		c.setOperation(&r, requestID, OperationAccepted)
		if err := c.store.Save(r); err != nil {
			return err
		}
		result = r.View()
		return nil
	})
	return result, err
}

// createSpec seals all provider-visible runtime inputs to profile policy and
// record-local identity. In particular the private signer is decoded only long
// enough to derive the public verification key supplied to the runtime.
func createSpec(profile Profile, r Record) (CreateSpec, error) {
	private, err := base64.RawStdEncoding.DecodeString(r.SignerPrivateKey)
	if err != nil || len(private) != ed25519.PrivateKeySize {
		return CreateSpec{}, errors.New("invalid private sandbox signer")
	}
	public := ed25519.PrivateKey(private).Public().(ed25519.PublicKey)
	env := make(map[string]string, 4)
	env["MUXTERM_SANDBOX_PROTOCOL"] = "1"
	env["MUXTERM_SANDBOX_GENERATION"] = strconv.FormatUint(r.Generation, 10)
	env["MUXTERM_SANDBOX_PROFILE_CHECKSUM"] = r.ProfileChecksum
	env["MUXTERM_SANDBOX_INGRESS_VERIFY_KEY"] = base64.RawStdEncoding.EncodeToString(public)
	return CreateSpec{
		DiskID: profile.DiskID, ImageDigest: profile.ImageDigest, Protocol: profile.Protocol,
		CPU: profile.CPU, Memory: profile.Memory,
		AutoSuspendSeconds: profile.AutoSuspendSecond, AutoDeleteSeconds: profile.AutoDeleteSeconds,
		ControllerCIDRs: append([]string(nil), profile.ControllerCIDRs...),
		Environment:     env, RequestID: r.RequestID,
		Labels: map[string]string{"muxterm.handle": r.Handle, "muxterm.request-id": r.RequestID},
	}, nil
}

func (c *Controller) Stop(ctx context.Context, handle string, generation uint64, requestID string) (View, error) {
	return c.mutate(ctx, "stop", "stopped", handle, generation, requestID, func(callCtx context.Context, p Provider, id, requestID string) error {
		return p.Stop(callCtx, id, requestID)
	})
}

func (c *Controller) Resume(ctx context.Context, handle string, generation uint64, requestID string) (View, error) {
	if c.config.KillSwitch {
		return View{}, ErrKillSwitch
	}
	return c.mutate(ctx, "resume", "running", handle, generation, requestID, func(callCtx context.Context, p Provider, id, requestID string) error {
		return p.Resume(callCtx, id, requestID)
	})
}

func (c *Controller) Destroy(ctx context.Context, handle string, generation uint64, requestID string) (View, error) {
	// Kill switch deliberately permits cleanup.
	return c.mutate(ctx, "destroy", "destroyed", handle, generation, requestID, func(callCtx context.Context, p Provider, id, requestID string) error {
		return p.Delete(callCtx, id, requestID)
	})
}

// Attach never starts a network dial. It still validates the caller's stable
// request ID and generation before returning the documented unsupported state.
func (c *Controller) Attach(handle string, generation uint64, requestID string) error {
	if err := validRequestID(requestID); err != nil {
		return err
	}
	return c.store.WithLock(func() error {
		r, err := c.store.Load(handle)
		if err != nil {
			return err
		}
		if generation != r.Generation {
			return ErrStaleGeneration
		}
		if c.config.KillSwitch {
			return ErrKillSwitch
		}
		if r.ReconcileState != ReconcileClean {
			return ErrReconcileRequired
		}
		if r.ObservedState != "running" {
			return errors.New("sandbox attach is unavailable until observed state is running")
		}
		return ErrAttachUnsupported
	})
}

// Reconcile is an explicit owner action, never an implicit status poll. For an
// ambiguous create it discovers exactly one label-matched provider resource;
// otherwise it observes the mapped resource without retrying any operation.
func (c *Controller) Reconcile(ctx context.Context, handle string, generation uint64, requestID string) (View, error) {
	if err := validRequestID(requestID); err != nil {
		return View{}, err
	}
	var result View
	err := c.store.WithLock(func() error {
		if prior, err := c.store.FindRequest(requestID); err == nil && prior.Handle != handle {
			return ErrRequestCollision
		} else if err != nil && !errors.Is(err, ErrRecordNotFound) {
			return err
		}
		r, err := c.store.Load(handle)
		if err != nil {
			return err
		}
		if old := r.operation(requestID); old != nil {
			if old.Kind != "reconcile" || old.ExpectedGeneration != generation {
				return ErrRequestCollision
			}
			result = r.viewFor(*old)
			return nil
		}
		if r.ReconcileState == ReconcileQuarantined {
			return ErrReconcileRequired
		}
		if generation != r.Generation {
			return ErrStaleGeneration
		}
		op := OperationRecord{RequestID: requestID, Kind: "reconcile", ExpectedGeneration: generation, DesiredState: r.DesiredState, State: OperationPending}
		r.Operations = append(r.Operations, op)
		r.RequestID, r.Operation, r.OperationState, r.ExpectedGeneration = op.RequestID, op.Kind, op.State, op.ExpectedGeneration
		if err := c.store.Save(r); err != nil {
			return err
		}
		result = r.View()
		profile, err := c.fencedProfile(r)
		if err != nil {
			err = c.recordObservationFailure(&r, requestID)
			result = r.View()
			return err
		}
		provider, err := c.providers(profile)
		if err != nil {
			err = c.recordObservationFailure(&r, requestID)
			result = r.View()
			return err
		}
		if r.ProviderID == "" && r.ReconcileState == ReconcileNeeded {
			providerCtx, cancel := context.WithTimeout(ctx, operationTimeout)
			found, err := provider.List(providerCtx)
			cancel()
			if err != nil {
				err = c.recordObservationFailure(&r, requestID)
				result = r.View()
				return err
			}
			var matches []ProviderSandbox
			for _, s := range found {
				if s.Labels["muxterm.handle"] == r.Handle && s.Labels["muxterm.request-id"] == r.Operations[0].RequestID {
					matches = append(matches, s)
				}
			}
			if len(matches) != 1 {
				r.ReconcileState = ReconcileQuarantined
				c.setOperation(&r, requestID, OperationFailed)
			} else {
				r.ProviderID, r.ObservedState = matches[0].ID, stateOrUnknown(matches[0].State)
				if targetReached(r.DesiredState, r.ObservedState) {
					r.ReconcileState = ReconcileClean
					c.markTargetIfObserved(&r)
					c.setOperation(&r, requestID, OperationSucceeded)
				} else {
					r.ReconcileState = ReconcileNeeded
					c.setOperation(&r, requestID, OperationPending)
				}
			}
			if err := c.store.Save(r); err != nil {
				return err
			}
			result = r.View()
			return nil
		}
		if r.ProviderID == "" {
			return ErrReconcileRequired
		}
		providerCtx, cancel := context.WithTimeout(ctx, operationTimeout)
		s, err := provider.Get(providerCtx, r.ProviderID)
		cancel()
		if errors.Is(err, ErrProviderNotFound) && r.DesiredState == "destroyed" {
			r.ObservedState, r.ReconcileState = "destroyed", ReconcileClean
			c.markTargetIfObserved(&r)
			c.setOperation(&r, requestID, OperationSucceeded)
		} else if err != nil {
			// Observation failure does not rewrite the previous lifecycle state.
			err = c.recordObservationFailure(&r, requestID)
			result = r.View()
			return err
		} else {
			r.ObservedState = stateOrUnknown(s.State)
			if targetReached(r.DesiredState, r.ObservedState) {
				r.ReconcileState = ReconcileClean
				c.markTargetIfObserved(&r)
				c.setOperation(&r, requestID, OperationSucceeded)
			} else {
				r.ReconcileState = ReconcileNeeded
				c.setOperation(&r, requestID, OperationPending)
			}
		}
		if err := c.store.Save(r); err != nil {
			return err
		}
		result = r.View()
		return nil
	})
	return result, err
}

func (c *Controller) mutate(ctx context.Context, operation, desired, handle string, generation uint64, requestID string, call func(context.Context, Provider, string, string) error) (View, error) {
	if err := validRequestID(requestID); err != nil {
		return View{}, err
	}
	var result View
	err := c.store.WithLock(func() error {
		if prior, err := c.store.FindRequest(requestID); err == nil && prior.Handle != handle {
			return ErrRequestCollision
		} else if err != nil && !errors.Is(err, ErrRecordNotFound) {
			return err
		}
		r, err := c.store.Load(handle)
		if err != nil {
			return err
		}
		if old := r.operation(requestID); old != nil {
			if old.Kind != operation || old.ExpectedGeneration != generation || old.DesiredState != desired {
				return ErrRequestCollision
			}
			result = r.viewFor(*old)
			return nil
		}
		if generation != r.Generation {
			return ErrStaleGeneration
		}
		if r.ReconcileState != ReconcileClean || r.ProviderID == "" {
			return ErrReconcileRequired
		}
		profile, err := c.fencedProfile(r)
		if err != nil {
			return err
		}
		provider, err := c.providers(profile)
		if err != nil {
			return errors.New("direct Azure sandbox provider initialization failed")
		}
		op := OperationRecord{RequestID: requestID, Kind: operation, ExpectedGeneration: generation, DesiredState: desired, State: OperationPending}
		r.Generation++
		r.RequestID, r.Operation, r.OperationState, r.ExpectedGeneration, r.DesiredState = requestID, operation, OperationPending, generation, desired
		r.Operations = append(r.Operations, op)
		if err := c.store.Save(r); err != nil {
			return err
		}
		result = r.View()
		providerCtx, cancel := context.WithTimeout(ctx, operationTimeout)
		err = call(providerCtx, provider, r.ProviderID, requestID)
		cancel()
		if err != nil {
			err = c.recordProviderFailure(&r, requestID, err)
			result = r.View()
			return err
		}
		c.setOperation(&r, requestID, OperationAccepted)
		r.ReconcileState = ReconcileNeeded
		if err := c.store.Save(r); err != nil {
			return err
		}
		result = r.View()
		return nil
	})
	return result, err
}

func (c *Controller) fencedProfile(r Record) (Profile, error) {
	p, err := c.config.Profile(r.ProfileName)
	if err != nil {
		return Profile{}, err
	}
	if p.Checksum() != r.ProfileChecksum {
		return Profile{}, errors.New("direct Azure sandbox profile checksum fence failed")
	}
	return p, nil
}

func (c *Controller) recordProviderFailure(r *Record, requestID string, err error) error {
	err = providerError(err)
	if errors.Is(err, ErrProviderRejected) {
		c.setOperation(r, requestID, OperationFailed)
		r.ReconcileState = ReconcileClean
	} else {
		c.setOperation(r, requestID, OperationAmbiguous)
		r.ReconcileState = ReconcileNeeded
	}
	if saveErr := c.store.Save(*r); saveErr != nil {
		return saveErr
	}
	return err
}

// recordObservationFailure marks only this reconcile attempt ambiguous. It
// deliberately leaves the preceding lifecycle operation and reconciliation
// requirement intact: an inability to observe is not evidence that a prior
// create/stop/resume/destroy failed.
func (c *Controller) recordObservationFailure(r *Record, requestID string) error {
	c.setOperation(r, requestID, OperationAmbiguous)
	if err := c.store.Save(*r); err != nil {
		return err
	}
	return ErrProviderAmbiguous
}

func (c *Controller) setOperation(r *Record, requestID string, state OperationState) {
	for i := range r.Operations {
		if r.Operations[i].RequestID == requestID {
			r.Operations[i].State = state
			break
		}
	}
	r.OperationState = state
}

func (c *Controller) markTargetIfObserved(r *Record) {
	if !targetReached(r.DesiredState, r.ObservedState) {
		return
	}
	for i := len(r.Operations) - 1; i >= 0; i-- {
		if r.Operations[i].Kind != "reconcile" && r.Operations[i].State == OperationAccepted {
			r.Operations[i].State = OperationSucceeded
			r.OperationState = OperationSucceeded
			return
		}
	}
}

func targetReached(desired, observed string) bool {
	switch desired {
	case "running":
		return observed == "running"
	case "stopped":
		return observed == "stopped" || observed == "suspended" || observed == "idle"
	case "destroyed":
		return observed == "destroyed"
	default:
		return false
	}
}

func (r Record) viewFor(op OperationRecord) View {
	v := r.View()
	v.RequestID, v.Operation, v.OperationState = op.RequestID, op.Kind, op.State
	v.ExpectedGeneration, v.DesiredState = op.ExpectedGeneration, op.DesiredState
	return v
}

func validRequestID(requestID string) error {
	if _, err := uuid.Parse(requestID); err != nil {
		return errors.New("direct Azure sandbox request id must be a UUID")
	}
	return nil
}

func stateOrUnknown(state string) string {
	if strings.TrimSpace(state) == "" {
		return "unknown"
	}
	return strings.ToLower(state)
}

var _ Lifecycle = (*Controller)(nil)
