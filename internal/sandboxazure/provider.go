package sandboxazure

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore/policy"
	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
)

var (
	// ErrProviderRejected is reserved for local sealed-spec validation and
	// deterministic fake failures before any Azure request; Azure HTTP results
	// must never return it.
	ErrProviderRejected  = errors.New("direct Azure sandbox provider rejected the operation")
	ErrProviderNotFound  = errors.New("direct Azure sandbox provider resource was not found")
	ErrProviderAmbiguous = errors.New("direct Azure sandbox provider outcome is ambiguous")
)

const maxListPages = 100

// Provider supplies the only typed Azure paths the controller can invoke.
// It intentionally has no arbitrary URL, method, body, or credential API.
type Provider interface {
	Create(context.Context, CreateSpec) (ProviderSandbox, error)
	List(context.Context) ([]ProviderSandbox, error)
	Get(context.Context, string) (ProviderSandbox, error)
	Stop(context.Context, string, string) error
	Resume(context.Context, string, string) error
	Delete(context.Context, string, string) error
}

type CreateSpec struct {
	DiskID             string
	ImageDigest        string
	Protocol           int
	CPU                string
	Memory             string
	AutoSuspendSeconds int
	AutoDeleteSeconds  int
	ControllerCIDRs    []string
	EgressHosts        []string
	Environment        map[string]string // exactly controller-generated runtime bindings
	Labels             map[string]string
	RequestID          string
}

type ProviderSandbox struct {
	ID     string
	State  string
	Labels map[string]string
}

type ProviderFactory func(Profile) (Provider, error)

// AzureProvider is a narrow direct implementation of the current vendored
// SandboxGroupClient source: group create/list/get/delete and sandbox stop/
// resume routes. It has no operation beyond those named methods.
type AzureProvider struct {
	profile    Profile
	credential *azidentity.AzureCLICredential
	httpClient *http.Client
}

func NewAzureProvider(profile Profile) (*AzureProvider, error) {
	if err := profile.Validate(); err != nil {
		return nil, err
	}
	credential, err := azidentity.NewAzureCLICredential(&azidentity.AzureCLICredentialOptions{
		TenantID: profile.TenantID,
	})
	if err != nil {
		return nil, errors.New("direct Azure sandbox Azure CLI credential is unavailable")
	}
	return &AzureProvider{
		profile: profile, credential: credential,
		// Continuation admission pins the nextLink host. Redirect following
		// would bypass that check, so any redirect is returned and rejected as
		// a non-2xx provider response instead of being followed.
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}, nil
}

func AzureProviderFactory(p Profile) (Provider, error) { return NewAzureProvider(p) }

func (p *AzureProvider) Create(ctx context.Context, spec CreateSpec) (ProviderSandbox, error) {
	if err := spec.Validate(); err != nil {
		return ProviderSandbox{}, ErrProviderRejected
	}
	body := CreatePayload(spec)
	var out providerDocument
	err := p.do(ctx, http.MethodPut, p.groupPath()+"/sandboxes", spec.RequestID, body, &out)
	return ProviderSandbox{ID: out.ID, State: out.State, Labels: out.Labels}, err
}

// CreatePayload builds the one sealed current-vendored-SDK-compatible create
// document. It is intentionally typed—not an arbitrary URL/body facility—and
// is exposed so the deterministic verifier can inspect contract fields without
// acquiring credentials or contacting Azure.
func CreatePayload(spec CreateSpec) map[string]any {
	env := make(map[string]string, len(spec.Environment))
	for name, value := range spec.Environment {
		env[name] = value
	}
	labels := make(map[string]string, len(spec.Labels)+1)
	for name, value := range spec.Labels {
		labels[name] = value
	}
	cidrs := append([]string(nil), spec.ControllerCIDRs...)
	hostRules := make([]map[string]string, 0, len(spec.EgressHosts))
	for _, host := range spec.EgressHosts {
		hostRules = append(hostRules, map[string]string{"pattern": host, "action": "Allow"})
	}
	body := map[string]any{
		"sourcesRef": map[string]any{"diskImage": map[string]any{"id": spec.DiskID}},
		"resources":  map[string]string{"cpu": spec.CPU, "memory": spec.Memory},
		"lifecycle": map[string]any{"autoSuspendPolicy": map[string]any{
			"enabled": true, "interval": spec.AutoSuspendSeconds, "mode": "Disk",
		}},
		"environment": env,
		"egressPolicy": map[string]any{
			"defaultAction": "Deny",
			"hostRules":     hostRules,
		},
		"ports": []map[string]any{{
			"port": ingressPort,
			"ipAccessControl": map[string]any{
				"defaultAction": "Deny",
				"rules": []map[string]any{{
					"name": "muxterm-controller", "action": "Allow", "priority": 10,
					"sourceCidrs": cidrs,
				}},
			},
		}},
		"labels": labels,
	}
	body["lifecycle"].(map[string]any)["autoDeletePolicy"] = map[string]any{
		"enabled": true, "deleteIntervalInSeconds": spec.AutoDeleteSeconds,
	}
	// The registered disk is the actual provider source. This label is
	// intentionally private to provider reconciliation/audit evidence; it
	// binds the reviewed digest to the submitted immutable release.
	body["labels"].(map[string]string)["muxterm.image-digest"] = spec.ImageDigest
	return body
}

// Validate keeps the typed provider boundary fail-closed even if a future
// controller implementation constructs CreateSpec incorrectly.
func (s CreateSpec) Validate() error {
	if strings.TrimSpace(s.DiskID) == "" || !digestReference.MatchString(s.ImageDigest) ||
		s.Protocol != RuntimeProtocol || s.AutoSuspendSeconds < 60 ||
		s.AutoDeleteSeconds < 300 || s.AutoDeleteSeconds > 86400 ||
		s.AutoDeleteSeconds < s.AutoSuspendSeconds || len(s.ControllerCIDRs) == 0 || len(s.ControllerCIDRs) > 10 ||
		len(s.EgressHosts) > 10 ||
		s.CPU == "" || s.Memory == "" {
		return errors.New("invalid sealed sandbox create specification")
	}
	for _, cidr := range s.ControllerCIDRs {
		prefix, err := netip.ParsePrefix(cidr)
		if err != nil || prefix != prefix.Masked() || prefix.Bits() == 0 {
			return errors.New("invalid sealed sandbox controller CIDR")
		}
	}
	for _, host := range s.EgressHosts {
		if !validEgressHost(host) {
			return errors.New("invalid sealed sandbox egress host")
		}
	}
	required := []string{
		"MUXTERM_SANDBOX_PROTOCOL", "MUXTERM_SANDBOX_GENERATION",
		"MUXTERM_SANDBOX_PROFILE_CHECKSUM", "MUXTERM_SANDBOX_INGRESS_VERIFY_KEY",
	}
	for _, name := range required {
		if strings.TrimSpace(s.Environment[name]) == "" {
			return errors.New("missing sealed sandbox runtime environment")
		}
	}
	if len(s.Environment) != len(required) {
		return errors.New("sealed sandbox runtime environment contains unexpected values")
	}
	return nil
}

func (p *AzureProvider) List(ctx context.Context) ([]ProviderSandbox, error) {
	next := p.collectionURL()
	result := make([]ProviderSandbox, 0)
	for page := 0; page < maxListPages; page++ {
		var out providerListDocument
		if err := p.doURL(ctx, http.MethodGet, next, "", nil, &out); err != nil {
			return nil, err
		}
		for _, s := range out.Value {
			result = append(result, ProviderSandbox{ID: s.ID, State: s.State, Labels: s.Labels})
		}
		if out.NextLink == "" {
			return result, nil
		}
		if !p.validContinuation(out.NextLink) {
			return nil, ErrProviderAmbiguous
		}
		next = out.NextLink
	}
	return nil, ErrProviderAmbiguous
}

func (p *AzureProvider) Get(ctx context.Context, id string) (ProviderSandbox, error) {
	var out providerDocument
	err := p.do(ctx, http.MethodGet, p.sandboxPath(id), "", nil, &out)
	return ProviderSandbox{ID: out.ID, State: out.State, Labels: out.Labels}, err
}

func (p *AzureProvider) Stop(ctx context.Context, id, requestID string) error {
	return p.do(ctx, http.MethodPost, p.sandboxPath(id)+"/stop", requestID, nil, nil)
}

func (p *AzureProvider) Resume(ctx context.Context, id, requestID string) error {
	return p.do(ctx, http.MethodPost, p.sandboxPath(id)+"/resume", requestID, nil, nil)
}

func (p *AzureProvider) Delete(ctx context.Context, id, requestID string) error {
	return p.do(ctx, http.MethodDelete, p.sandboxPath(id), requestID, nil, nil)
}

type providerDocument struct {
	ID     string            `json:"id"`
	State  string            `json:"state"`
	Labels map[string]string `json:"labels"`
}

type providerListDocument struct {
	Value    []providerDocument `json:"value"`
	NextLink string             `json:"nextLink"`
}

// UnmarshalJSON matches the vendored client's list behavior: the data plane
// may return either a bare array or a {value,nextLink} page.
func (p *providerListDocument) UnmarshalJSON(data []byte) error {
	data = bytes.TrimSpace(data)
	var bare []providerDocument
	if len(data) > 0 && data[0] == '[' {
		if err := json.Unmarshal(data, &bare); err != nil {
			return err
		}
		p.Value, p.NextLink = bare, ""
		return nil
	}
	var wrapped struct {
		Value    []providerDocument `json:"value"`
		NextLink string             `json:"nextLink"`
	}
	if err := json.Unmarshal(data, &wrapped); err != nil {
		return err
	}
	p.Value, p.NextLink = wrapped.Value, wrapped.NextLink
	return nil
}

func (p *AzureProvider) do(ctx context.Context, method, path, requestID string, body any, out any) error {
	return p.doURL(ctx, method, p.collectionBaseURL()+path+"?"+url.Values{"api-version": {"2026-02-01-preview"}}.Encode(), requestID, body, out)
}

func (p *AzureProvider) doURL(ctx context.Context, method, endpoint, requestID string, body any, out any) error {
	token, err := p.credential.GetToken(ctx, policy.TokenRequestOptions{Scopes: []string{dataPlaneScope}})
	if err != nil {
		return errors.New("direct Azure sandbox Azure CLI token is unavailable")
	}
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return errors.New("direct Azure sandbox could not encode provider request")
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return errors.New("direct Azure sandbox could not construct provider request")
	}
	request.Header.Set("Authorization", "Bearer "+token.Token)
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if requestID != "" {
		request.Header.Set("x-ms-client-request-id", requestID)
	}
	response, err := p.httpClient.Do(request)
	if err != nil {
		return ErrProviderAmbiguous
	}
	defer response.Body.Close() //nolint:errcheck
	if response.StatusCode == http.StatusNotFound {
		return ErrProviderNotFound
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		// The vendored preview source does not establish that any generic HTTP
		// failure (including 409/412) proves no lifecycle effect. Typed 404 is
		// the sole source-backed absence result. All other non-2xx responses
		// remain ambiguous so create can reconcile only the controller labels.
		return ErrProviderAmbiguous
	}
	if out != nil && response.StatusCode != http.StatusNoContent {
		if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(out); err != nil {
			return errors.New("direct Azure sandbox provider response was invalid")
		}
	}
	return nil
}

// ClassifyHTTPStatusForFixture exposes the source-backed response boundary to
// the deterministic verifier without constructing credentials or issuing a
// provider request. ErrProviderRejected is intentionally reserved for local
// typed CreateSpec validation and deterministic fake-provider failures.
func ClassifyHTTPStatusForFixture(status int) error {
	switch {
	case status >= 200 && status < 300:
		return nil
	case status == http.StatusNotFound:
		return ErrProviderNotFound
	default:
		return ErrProviderAmbiguous
	}
}

func (p *AzureProvider) collectionBaseURL() string {
	return "https://management." + p.profile.Region + ".azuredevcompute.io"
}

func (p *AzureProvider) collectionURL() string {
	return p.collectionBaseURL() + p.groupPath() + "/sandboxes?" + url.Values{"api-version": {"2026-02-01-preview"}}.Encode()
}

// validContinuation permits only a provider-generated continuation pointing
// back to this configured regional collection over HTTPS. No browser input can
// reach this path and no arbitrary nextLink host is followed.
func (p *AzureProvider) validContinuation(next string) bool {
	u, err := url.Parse(next)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Fragment != "" {
		return false
	}
	base, _ := url.Parse(p.collectionBaseURL())
	if u.Host != base.Host || u.Path != p.groupPath()+"/sandboxes" {
		return false
	}
	versions := u.Query()["api-version"]
	return len(versions) == 1 && versions[0] == "2026-02-01-preview"
}

// ValidContinuationForFixture exposes only continuation admission logic for
// the deterministic verifier. It creates no credential and sends no request.
func ValidContinuationForFixture(profile Profile, next string) bool {
	return (&AzureProvider{profile: profile}).validContinuation(next)
}

func (p *AzureProvider) groupPath() string {
	return "/subscriptions/" + p.profile.SubscriptionID +
		"/resourceGroups/" + p.profile.ResourceGroup +
		"/sandboxGroups/" + p.profile.SandboxGroup
}

func (p *AzureProvider) sandboxPath(id string) string {
	return p.groupPath() + "/sandboxes/" + url.PathEscape(id)
}

var _ Provider = (*AzureProvider)(nil)

func providerError(err error) error {
	if err == nil || errors.Is(err, ErrProviderRejected) || errors.Is(err, ErrProviderNotFound) || errors.Is(err, ErrProviderAmbiguous) {
		return err
	}
	// Provider errors can contain IDs, URLs, response bodies, or identity
	// information. Never reflect them into a CLI/API error.
	return ErrProviderAmbiguous
}
