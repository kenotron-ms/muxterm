// internal/ai/verify.go
package ai

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"
)

// VerdictState is the outcome of presenting a credential to its vendor.
//
// The three failure states are kept apart because they need different fixes
// and conflating them sends people down the wrong path: a rejected key must
// be replaced, an unreachable endpoint means check the network or the base
// URL, and an unexpected status usually means the endpoint is not the API you
// think it is.
type VerdictState string

const (
	// VerdictUnknown: nothing has asked the vendor since this server started.
	VerdictUnknown VerdictState = "unknown"
	// VerdictOK: the vendor accepted the credential.
	VerdictOK VerdictState = "ok"
	// VerdictRejected: the vendor answered 401/403. This is the Mac's failure.
	VerdictRejected VerdictState = "rejected"
	// VerdictUnreachable: the request never got an answer -- DNS, TLS,
	// timeout, no route. Says nothing about the credential.
	VerdictUnreachable VerdictState = "unreachable"
	// VerdictFailed: an answer arrived with a status that is neither success
	// nor an auth rejection (404 on a mistyped base URL, 429, a 5xx).
	VerdictFailed VerdictState = "failed"
	// VerdictAbsent: there is no credential to check.
	VerdictAbsent VerdictState = "absent"
)

// Verdict is one recorded check. It carries a status code and a timestamp,
// never a response body: on 401 and 403 the vendor's own message quotes the
// key's prefix and last four characters back at you, which is precisely the
// disclosure this API refuses to make.
type Verdict struct {
	State VerdictState `json:"state"`
	// HTTPStatus is the vendor's status code, 0 when no answer arrived.
	HTTPStatus int `json:"httpStatus,omitempty"`
	// Origin records which credential was checked, so a verdict cannot be
	// silently attributed to a key other than the one that was presented.
	Origin Origin `json:"origin,omitempty"`
	// CheckedAt is RFC3339, empty when State is VerdictUnknown.
	CheckedAt string `json:"checkedAt,omitempty"`
}

// VerifyTimeout bounds a single credential check.
const VerifyTimeout = 12 * time.Second

var verifyClient = &http.Client{Timeout: VerifyTimeout}

func (m *Manager) verdict(p Provider) Verdict {
	m.vmu.RLock()
	defer m.vmu.RUnlock()
	if v, ok := m.verdicts[p]; ok {
		return v
	}
	return Verdict{State: VerdictUnknown}
}

// RecordVerdict stores a verdict a caller obtained itself, for the one case
// where the check and the save are separate acts: the onboarding PUT verifies
// a candidate BEFORE writing it, and without this the freshly-saved key would
// read back as "not checked" a moment after the vendor accepted it.
func (m *Manager) RecordVerdict(p Provider, v Verdict) { m.recordVerdict(p, v) }

func (m *Manager) recordVerdict(p Provider, v Verdict) {
	m.vmu.Lock()
	if m.verdicts == nil {
		m.verdicts = map[Provider]Verdict{}
	}
	m.verdicts[p] = v
	m.vmu.Unlock()
}

func (m *Manager) forgetVerdict(p Provider) {
	m.vmu.Lock()
	delete(m.verdicts, p)
	m.vmu.Unlock()
}

// Verify presents the credential a lane would actually use for p to that
// provider, and records the outcome.
//
// It authenticates and stops there: the request is a GET of the vendor's
// model-list endpoint, which requires the credential and produces no
// completion, so a check costs a round trip and no tokens.
func (m *Manager) Verify(ctx context.Context, p Provider) Verdict {
	key, origin := m.effectiveKey(p)
	if key == "" {
		v := Verdict{State: VerdictAbsent, CheckedAt: nowRFC3339()}
		m.recordVerdict(p, v)
		return v
	}
	fileKeys := amplifierKeys()
	baseURL, _ := resolveBaseURL(providerSpecs[p], fileKeys)

	v := m.verifyKey(ctx, p, key, baseURL)
	v.Origin = origin
	m.recordVerdict(p, v)
	return v
}

// VerifyCandidate checks a key that has not been stored yet. Nothing is
// recorded: a candidate's verdict belongs to the save attempt that produced
// it, not to the machine's state.
func (m *Manager) VerifyCandidate(ctx context.Context, p Provider, key string) Verdict {
	baseURL, _ := resolveBaseURL(providerSpecs[p], amplifierKeys())
	return m.verifyKey(ctx, p, key, baseURL)
}

// verifyKey does the single authenticated GET.
//
// NOTHING FROM THE RESPONSE BODY IS EVER RETURNED OR LOGGED. A vendor's 401
// body reads "Incorrect API key provided: sk-proj-***...vp4A" -- it masks the
// middle and leaves the prefix and the last four characters intact. A literal
// scrub cannot remove that, because the masked form is not a substring of the
// key. The only safe handling is to drop the body, which is what this does
// for every status, not only for 401.
func (m *Manager) verifyKey(ctx context.Context, p Provider, key, baseURL string) Verdict {
	spec, ok := providerSpecs[p]
	if !ok {
		return Verdict{State: VerdictFailed, CheckedAt: nowRFC3339()}
	}

	ctx, cancel := context.WithTimeout(ctx, VerifyTimeout)
	defer cancel()

	url := strings.TrimRight(baseURL, "/") + spec.ModelsPath
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		// A base URL that will not parse is a configuration fault, not a
		// credential fault, and must not be reported as a rejection.
		log.Printf("ai: verify %s: malformed endpoint", spec.Label)
		return Verdict{State: VerdictFailed, CheckedAt: nowRFC3339()}
	}
	switch p {
	case ProviderAnthropic:
		req.Header.Set("x-api-key", key)
		req.Header.Set("anthropic-version", "2023-06-01")
	default:
		req.Header.Set("Authorization", "Bearer "+key)
	}

	resp, err := verifyClient.Do(req)
	if err != nil {
		// No answer arrived. This says nothing about the key, and telling a
		// user with a good key and a dropped VPN to "check the key" is how
		// an hour gets spent on the wrong thing.
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			log.Printf("ai: verify %s: timed out reaching the provider", spec.Label)
		} else {
			log.Printf("ai: verify %s: could not reach the provider", spec.Label)
		}
		return Verdict{State: VerdictUnreachable, CheckedAt: nowRFC3339()}
	}
	defer resp.Body.Close() //nolint:errcheck

	state := VerdictFailed
	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		state = VerdictOK
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		state = VerdictRejected
	}
	log.Printf("ai: verify %s: %s (HTTP %d)", spec.Label, state, resp.StatusCode)
	return Verdict{State: state, HTTPStatus: resp.StatusCode, CheckedAt: nowRFC3339()}
}

// VerifyAllInBackground checks every provider that has a credential, without
// blocking the caller.
//
// This is the whole point of the feature running at startup rather than only
// when somebody opens Settings: a stale key produces a healthy-looking
// machine, an open pane, and a lane that dies at its first turn with the
// reason visible only in pane scrollback. One free round trip per provider at
// boot turns that into a sentence on screen before anyone spawns anything.
//
// A provider with no credential is skipped -- there is nothing to present,
// and a machine with no keys must not generate network traffic.
func (m *Manager) VerifyAllInBackground() {
	for _, p := range Providers {
		if key, _ := m.effectiveKey(p); key == "" {
			continue
		}
		go m.Verify(context.Background(), p) //nolint:errcheck // verdict is recorded, not returned
	}
}

func nowRFC3339() string { return time.Now().UTC().Format(time.RFC3339) }
