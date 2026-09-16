// sandbox-verify is a deterministic offline verification executable. It never
// constructs Azure credentials or sends a network request.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"

	muxconfig "github.com/kenotron-ms/muxterm/internal/config"
	"github.com/kenotron-ms/muxterm/internal/sandboxazure"
	"github.com/kenotron-ms/muxterm/internal/sandboxingress"
	"github.com/kenotron-ms/muxterm/internal/server"
)

func main() {
	if err := verify(); err != nil {
		fmt.Fprintln(os.Stderr, "sandbox verifier: FAIL:", err)
		os.Exit(1)
	}
	fmt.Println("sandbox verifier: PASS (offline fake provider; no Azure credential or network request)")
}

func verify() error {
	if err := verifyIngressEnvironmentGuard(); err != nil {
		return err
	}
	if _, err := sandboxazure.NewController(sandboxazure.Config{}, factory(&fakeProvider{})); !errors.Is(err, sandboxazure.ErrDisabled) {
		return errors.New("unconfigured controller did not fail closed")
	}
	if err := verifyConfigRetention(); err != nil {
		return err
	}
	if err := verifyStoreSafety(); err != nil {
		return err
	}

	fake := &fakeProvider{items: make(map[string]sandboxazure.ProviderSandbox)}
	storeDir := mustTempDir()
	controller, err := sandboxazure.NewController(sandboxazure.Config{
		Enabled: true, StoreDir: storeDir,
		Profiles: []sandboxazure.Profile{profile()},
	}, factory(fake))
	if err != nil {
		return err
	}
	ctx := context.Background()
	const requestID = "11111111-1111-4111-8111-111111111111"
	created, err := controller.Create(ctx, "fixture", requestID)
	if err != nil {
		return fmt.Errorf("success create: %w", err)
	}
	if created.ObservedState != "creating" || created.OperationState != sandboxazure.OperationAccepted {
		return errors.New("accepted create falsely reported completion")
	}
	if err := verifyCreateContract(fake.lastSpec, profile().Checksum()); err != nil {
		return err
	}
	if _, err := controller.List(ctx); err != nil || fake.gets != 0 || fake.lists != 0 {
		return errors.New("local status unexpectedly acquired provider state")
	}
	retry, err := controller.Create(ctx, "fixture", requestID)
	if err != nil || retry.Handle != created.Handle || fake.creates != 1 {
		return errors.New("create idempotent retry called provider or changed handle")
	}
	if _, err := controller.Create(ctx, "different-profile", requestID); !errors.Is(err, sandboxazure.ErrRequestCollision) {
		return errors.New("request id reused for a different create was not rejected")
	}
	encoded, _ := json.Marshal(created)
	if strings.Contains(string(encoded), "provider-secret-id") || strings.Contains(string(encoded), "signer_private") {
		return errors.New("external view leaked private record data")
	}
	if err := controller.Attach(created.Handle, created.Generation, "a0000000-0000-4000-8000-000000000001"); !errors.Is(err, sandboxazure.ErrReconcileRequired) {
		return errors.New("attach before reconciliation was not rejected")
	}
	if _, err := controller.Stop(ctx, created.Handle, created.Generation, "a0000000-0000-4000-8000-000000000015"); !errors.Is(err, sandboxazure.ErrReconcileRequired) {
		return errors.New("accepted create allowed a superseding state mutation before reconciliation")
	}
	if _, err := controller.Destroy(ctx, created.Handle, created.Generation, "a0000000-0000-4000-8000-000000000023"); !errors.Is(err, sandboxazure.ErrReconcileRequired) {
		return errors.New("accepted create allowed destroy before reconciliation")
	}
	creating, err := controller.Reconcile(ctx, created.Handle, created.Generation, "a0000000-0000-4000-8000-000000000016")
	if err != nil || creating.Operation != "reconcile" || creating.OperationState != sandboxazure.OperationSucceeded ||
		creating.ReconcileState != sandboxazure.ReconcileNeeded || creating.ObservedState != "creating" {
		return errors.New("transitional create observation did not settle reconcile truth")
	}
	current, err := controller.Describe(ctx, created.Handle)
	if err != nil || current.Operation != "create" || current.OperationState != sandboxazure.OperationAccepted ||
		current.ReconcileState != sandboxazure.ReconcileNeeded {
		return errors.New("current view did not retain accepted lifecycle after transitional create observation")
	}
	retryReconcile, err := controller.Reconcile(ctx, created.Handle, created.Generation, "a0000000-0000-4000-8000-000000000016")
	if err != nil || retryReconcile.Operation != "reconcile" || retryReconcile.OperationState != sandboxazure.OperationSucceeded {
		return errors.New("completed transitional reconcile was not idempotently replayed")
	}
	item := fake.items["provider-secret-id"]
	item.State = "Running"
	fake.items["provider-secret-id"] = item
	reconciled, err := controller.Reconcile(ctx, created.Handle, created.Generation, "a0000000-0000-4000-8000-000000000024")
	if err != nil || reconciled.ReconcileState != sandboxazure.ReconcileClean || reconciled.ObservedState != "running" {
		return errors.New("accepted create was not reconciled to an observed running target")
	}
	if err := controller.Attach(created.Handle, created.Generation, "a0000000-0000-4000-8000-000000000022"); !errors.Is(err, sandboxazure.ErrAttachUnsupported) {
		return errors.New("reconciled attach did not retain explicit unsupported behavior")
	}
	if _, err := controller.Stop(ctx, created.Handle, created.Generation+1, "a0000000-0000-4000-8000-000000000002"); !errors.Is(err, sandboxazure.ErrStaleGeneration) {
		return errors.New("stale stop was not fenced")
	}
	fake.stopState = "Stopping"
	stopped, err := controller.Stop(ctx, created.Handle, created.Generation, "a0000000-0000-4000-8000-000000000003")
	if err != nil || stopped.Generation != 2 || stopped.Operation != "stop" {
		return errors.New("stop acceptance/generation fence failed")
	}
	duplicateStop, err := controller.Stop(ctx, created.Handle, created.Generation, "a0000000-0000-4000-8000-000000000003")
	if err != nil || duplicateStop.Generation != stopped.Generation || fake.stops != 1 {
		return errors.New("duplicate lifecycle request advanced generation or called provider")
	}
	if _, err := controller.Resume(ctx, created.Handle, stopped.Generation, "a0000000-0000-4000-8000-000000000003"); !errors.Is(err, sandboxazure.ErrRequestCollision) {
		return errors.New("request id reused for a different lifecycle action was not rejected")
	}
	if _, err := controller.Stop(ctx, differentHandle(created.Handle), stopped.Generation, "a0000000-0000-4000-8000-000000000003"); !errors.Is(err, sandboxazure.ErrRequestCollision) {
		return errors.New("request id reused for a different handle was not rejected")
	}
	if _, err := controller.Resume(ctx, created.Handle, stopped.Generation, "a0000000-0000-4000-8000-000000000017"); !errors.Is(err, sandboxazure.ErrReconcileRequired) {
		return errors.New("accepted stop allowed resume before reconciliation")
	}
	stopping, err := controller.Reconcile(ctx, created.Handle, stopped.Generation, "a0000000-0000-4000-8000-000000000014")
	if err != nil || stopping.Operation != "reconcile" || stopping.OperationState != sandboxazure.OperationSucceeded ||
		stopping.ObservedState != "stopping" || stopping.ReconcileState != sandboxazure.ReconcileNeeded {
		return errors.New("transitional stop observation did not settle reconcile truth")
	}
	current, err = controller.Describe(ctx, created.Handle)
	if err != nil || current.Operation != "stop" || current.OperationState != sandboxazure.OperationAccepted ||
		current.ReconcileState != sandboxazure.ReconcileNeeded {
		return errors.New("current view did not retain accepted lifecycle after transitional stop observation")
	}
	fake.stopState = "Idle"
	item = fake.items["provider-secret-id"]
	item.State = "Idle"
	fake.items["provider-secret-id"] = item
	refreshed, err := controller.Reconcile(ctx, created.Handle, stopped.Generation, "a0000000-0000-4000-8000-000000000025")
	if err != nil || refreshed.ObservedState != "idle" || refreshed.OperationState != sandboxazure.OperationSucceeded ||
		refreshed.ReconcileState != sandboxazure.ReconcileClean {
		return errors.New("explicit refresh did not recognize Idle as a stop terminal target")
	}
	if _, err := controller.Resume(ctx, created.Handle, created.Generation, "a0000000-0000-4000-8000-000000000004"); !errors.Is(err, sandboxazure.ErrStaleGeneration) {
		return errors.New("stale resume was not fenced")
	}
	resumed, err := controller.Resume(ctx, created.Handle, stopped.Generation, "a0000000-0000-4000-8000-000000000005")
	if err != nil || resumed.Generation != 3 || resumed.Operation != "resume" {
		return errors.New("resume acceptance/generation fence failed")
	}
	if _, err := controller.Destroy(ctx, created.Handle, stopped.Generation, "a0000000-0000-4000-8000-000000000006"); !errors.Is(err, sandboxazure.ErrStaleGeneration) {
		return errors.New("stale destroy was not fenced")
	}
	if _, err := controller.Destroy(ctx, created.Handle, resumed.Generation, "a0000000-0000-4000-8000-000000000018"); !errors.Is(err, sandboxazure.ErrReconcileRequired) {
		return errors.New("accepted resume allowed destroy before reconciliation")
	}
	restarted, err := controller.Reconcile(ctx, created.Handle, resumed.Generation, "a0000000-0000-4000-8000-000000000019")
	if err != nil || restarted.ReconcileState != sandboxazure.ReconcileClean || restarted.ObservedState != "running" {
		return errors.New("accepted resume was not reconciled to running")
	}
	destroyed, err := controller.Destroy(ctx, created.Handle, resumed.Generation, "a0000000-0000-4000-8000-000000000007")
	if err != nil || destroyed.Generation != 4 || destroyed.Operation != "destroy" {
		return errors.New("destroy acceptance/generation fence failed")
	}

	fake.createErr = sandboxazure.ClassifyHTTPStatusForFixture(http.StatusConflict)
	if !errors.Is(fake.createErr, sandboxazure.ErrProviderAmbiguous) {
		return errors.New("Azure HTTP 409 was not classified as ambiguous")
	}
	ambiguous, err := controller.Create(ctx, "fixture", "22222222-2222-4222-8222-222222222222")
	if !errors.Is(err, sandboxazure.ErrProviderAmbiguous) {
		return errors.New("ambiguous 409-equivalent create was not surfaced as ambiguous")
	}
	ambiguous, err = controller.Create(ctx, "fixture", "22222222-2222-4222-8222-222222222222")
	if err != nil || ambiguous.ReconcileState != sandboxazure.ReconcileNeeded {
		return errors.New("ambiguous create did not preserve retry/reconcile record")
	}
	fake.items["recovered-private-id"] = sandboxazure.ProviderSandbox{
		ID: "recovered-private-id", State: "Running",
		Labels: map[string]string{
			"muxterm.handle": ambiguous.Handle, "muxterm.request-id": "22222222-2222-4222-8222-222222222222",
		},
	}
	recovered, err := controller.Reconcile(ctx, ambiguous.Handle, ambiguous.Generation, "a0000000-0000-4000-8000-000000000008")
	if err != nil || recovered.ReconcileState != sandboxazure.ReconcileClean || recovered.ObservedState != "running" {
		return errors.New("ambiguous 409-equivalent create was not safely recovered by durable labels")
	}
	fake.createErr = sandboxazure.ErrProviderAmbiguous
	quarantined, err := controller.Create(ctx, "fixture", "55555555-5555-4555-8555-555555555555")
	if !errors.Is(err, sandboxazure.ErrProviderAmbiguous) {
		return errors.New("second ambiguous create was not surfaced")
	}
	quarantined, err = controller.Create(ctx, "fixture", "55555555-5555-4555-8555-555555555555")
	if err != nil {
		return errors.New("second ambiguous create record was not available for reconciliation")
	}
	quarantined, err = controller.Reconcile(ctx, quarantined.Handle, quarantined.Generation, "a0000000-0000-4000-8000-000000000009")
	if err != nil || quarantined.ReconcileState != sandboxazure.ReconcileQuarantined {
		return errors.New("unmatched ambiguous create was not quarantined")
	}

	fake.createErr = sandboxazure.ErrProviderRejected
	failed, err := controller.Create(ctx, "fixture", "33333333-3333-4333-8333-333333333333")
	if !errors.Is(err, sandboxazure.ErrProviderRejected) {
		return errors.New("rejected create was not surfaced")
	}
	failed, err = controller.Create(ctx, "fixture", "33333333-3333-4333-8333-333333333333")
	if err != nil || failed.OperationState != sandboxazure.OperationFailed {
		return errors.New("failed create record was not durable")
	}

	fake.createErr = nil
	handoff, err := controller.Create(ctx, "fixture", "44444444-4444-4444-8444-444444444444")
	if err != nil {
		return err
	}
	item = fake.items["provider-secret-id"]
	item.State = "Running"
	fake.items["provider-secret-id"] = item
	if _, err := controller.Reconcile(ctx, handoff.Handle, handoff.Generation, "a0000000-0000-4000-8000-000000000020"); err != nil {
		return errors.New("cleanup handoff create could not reconcile")
	}
	fake.deleteErr = sandboxazure.ErrProviderNotFound
	cleaned, err := controller.Destroy(ctx, handoff.Handle, handoff.Generation, "a0000000-0000-4000-8000-000000000010")
	if !errors.Is(err, sandboxazure.ErrProviderNotFound) || cleaned.OperationState != sandboxazure.OperationAmbiguous {
		return errors.New("destroy absence did not remain reconciliation-required")
	}

	fake.deleteErr = nil
	live, err := controller.Create(ctx, "fixture", "66666666-6666-4666-8666-666666666666")
	if err != nil {
		return err
	}
	item = fake.items["provider-secret-id"]
	item.State = "Running"
	fake.items["provider-secret-id"] = item
	if _, err := controller.Reconcile(ctx, live.Handle, live.Generation, "a0000000-0000-4000-8000-000000000021"); err != nil {
		return errors.New("kill-switch cleanup record could not reconcile")
	}
	killController, err := sandboxazure.NewController(sandboxazure.Config{
		Enabled: true, KillSwitch: true, StoreDir: storeDir,
		Profiles: []sandboxazure.Profile{profile()},
	}, factory(fake))
	if err != nil {
		return err
	}
	if _, err := killController.Create(ctx, "fixture", "77777777-7777-4777-8777-777777777777"); !errors.Is(err, sandboxazure.ErrKillSwitch) {
		return errors.New("kill switch did not block create")
	}
	if _, err := killController.Resume(ctx, live.Handle, live.Generation, "a0000000-0000-4000-8000-000000000011"); !errors.Is(err, sandboxazure.ErrKillSwitch) {
		return errors.New("kill switch did not block resume")
	}
	if err := killController.Attach(live.Handle, live.Generation, "a0000000-0000-4000-8000-000000000012"); !errors.Is(err, sandboxazure.ErrKillSwitch) {
		return errors.New("kill switch did not block attach")
	}
	if _, err := killController.List(ctx); err != nil {
		return errors.New("kill switch blocked truthful local list")
	}
	if _, err := killController.Destroy(ctx, live.Handle, live.Generation, "a0000000-0000-4000-8000-000000000013"); err != nil {
		return errors.New("kill switch blocked destroy cleanup")
	}

	if _, err := sandboxazure.NewController(sandboxazure.Config{
		Enabled: true, StoreDir: mustTempDir(), Profiles: []sandboxazure.Profile{{Name: "bad"}},
	}, factory(fake)); err == nil {
		return errors.New("out-of-scope profile was accepted")
	}
	if err := verifyHTTPAPI(controller); err != nil {
		return err
	}
	return nil
}

func verifyIngressEnvironmentGuard() error {
	allowed := []string{
		"MUXTERM_SANDBOX_PROTOCOL=1",
		"MUXTERM_SANDBOX_GENERATION=1",
		"MUXTERM_SANDBOX_PROFILE_CHECKSUM=not-a-secret",
		"MUXTERM_SANDBOX_INGRESS_VERIFY_KEY=public-value",
	}
	if err := sandboxingress.RejectInheritedCredentialEnvironment(allowed); err != nil {
		return errors.New("ingress rejected its allowed public verification key")
	}
	for _, name := range []string{
		"AZURE_CLIENT_ID", "ARM_CLIENT_ID", "MSI_ENDPOINT", "IDENTITY_ENDPOINT",
		"BROWSER_TOKEN", "APP_CLIENT_SECRET", "SERVICE_PRIVATE_KEY",
		"USER_CREDENTIAL", "EXTERNAL_API_KEY",
	} {
		if err := sandboxingress.RejectInheritedCredentialEnvironment([]string{name + "=value-not-inspected"}); !errors.Is(err, sandboxingress.ErrProtocol) {
			return errors.New("ingress accepted a credential-shaped inherited environment name")
		}
	}
	return nil
}

func verifyHTTPAPI(controller sandboxazure.Lifecycle) error {
	// The actual ServeMux routes are exercised through a loopback httptest
	// server. NoAuth remains false, so this follows normal protected-route
	// architecture's direct-localhost allowance.
	srv := server.New(server.Config{
		Sandbox:             controller,
		SandboxAvailability: sandboxazure.Availability{State: "ready", Detail: "fixture"},
		LocalToken:          "owner-local-fixture-token",
	})
	// Unconfigured has a stable, safe collection shape and no credentials.
	off := server.New(server.Config{
		SandboxAvailability: sandboxazure.Availability{State: "unconfigured", Detail: "not configured"},
		LocalToken:          "owner-local-fixture-token",
	})
	if code, _ := requestJSON(srv.Handler(), "GET", "/api/sandboxes", "", "", ""); code != http.StatusUnauthorized && code != http.StatusServiceUnavailable {
		return errors.New("sandbox API admitted unauthenticated loopback caller")
	}
	if code, body := requestJSON(off.Handler(), "GET", "/api/sandboxes", "", "", "owner-local-fixture-token"); code != 200 || !strings.Contains(body, `"state":"unconfigured"`) || strings.Contains(body, "provider-secret-id") {
		return errors.New("unconfigured API collection was not safe and explicit")
	}
	noAuth := server.New(server.Config{
		NoAuth: true, Sandbox: controller,
		SandboxAvailability: sandboxazure.Availability{State: "ready", Detail: "fixture"},
	})
	if code, body := requestJSON(noAuth.Handler(), "GET", "/api/sandboxes", "", "", "owner-local-fixture-token"); code != http.StatusServiceUnavailable || !strings.Contains(body, "sandbox_auth_required") {
		return errors.New("no-auth server topology exposed sandbox lifecycle")
	}
	// Strict request decoding rejects caller-provided credential/scope fields.
	if code, _ := requestJSON(srv.Handler(), "POST", "/api/sandboxes", "b0000000-0000-4000-8000-000000000001", `{"profile":"fixture","endpoint":"https://attacker.invalid"}`, "owner-local-fixture-token"); code != 400 {
		return errors.New("API accepted a browser Azure endpoint field")
	}
	if code, _ := requestJSON(srv.Handler(), "POST", "/api/sandboxes", "b0000000-0000-4000-8000-000000000002", `{"profile":"fixture","credential":"secret"}`, "owner-local-fixture-token"); code != 400 {
		return errors.New("API accepted a browser credential field")
	}
	if code, _ := requestJSON(srv.Handler(), "POST", "/api/sandboxes", "", `{"profile":"fixture"}`, "owner-local-fixture-token"); code != 400 {
		return errors.New("API accepted mutation without Idempotency-Key")
	}
	if code, _ := requestJSON(srv.Handler(), "POST", "/api/sandboxes/not-a-handle/destroy", "b0000000-0000-4000-8000-000000000003", `{"generation":1,"confirm_handle":"other"}`, "owner-local-fixture-token"); code != 400 {
		return errors.New("API accepted destructive confirmation for another handle")
	}
	firstCode, first := requestJSON(srv.Handler(), "POST", "/api/sandboxes", "b0000000-0000-4000-8000-000000000004", `{"profile":"fixture"}`, "owner-local-fixture-token")
	secondCode, second := requestJSON(srv.Handler(), "POST", "/api/sandboxes", "b0000000-0000-4000-8000-000000000004", `{"profile":"fixture"}`, "owner-local-fixture-token")
	if firstCode != 202 || secondCode != 202 || !strings.Contains(first, `"sandbox"`) || first != second {
		return errors.New("API did not replay an exact duplicate idempotent create")
	}
	if strings.Contains(first, "provider-secret-id") || strings.Contains(first, "signer_private") || strings.Contains(first, "credential") {
		return errors.New("API response leaked private sandbox data")
	}
	if code, body := requestJSON(srv.Handler(), "POST", "/api/sandboxes", "33333333-3333-4333-8333-333333333333", `{"profile":"fixture"}`, "owner-local-fixture-token"); code < 400 || !strings.Contains(body, `"operation_state":"failed"`) {
		return errors.New("API returned success for a persisted failed idempotency retry")
	}
	return nil
}

func verifyCreateContract(spec sandboxazure.CreateSpec, checksum string) error {
	if spec.DiskID == "" || spec.ImageDigest == "" || spec.Protocol != sandboxazure.RuntimeProtocol ||
		spec.AutoSuspendSeconds <= 0 || spec.AutoDeleteSeconds <= 0 || len(spec.ControllerCIDRs) != 1 ||
		spec.ControllerCIDRs[0] != "192.0.2.0/24" || len(spec.EgressHosts) != 1 ||
		spec.EgressHosts[0] != "packages.example.com" {
		return errors.New("sealed create omitted required image, lifecycle, or ingress policy")
	}
	if spec.Environment["MUXTERM_SANDBOX_PROTOCOL"] != "1" ||
		spec.Environment["MUXTERM_SANDBOX_PROFILE_CHECKSUM"] != checksum ||
		spec.Environment["MUXTERM_SANDBOX_GENERATION"] != "1" ||
		len(spec.Environment) != 4 {
		return errors.New("sealed create runtime environment was incomplete")
	}
	if _, err := sandboxingress.ParseRuntimeConfig(
		spec.Environment["MUXTERM_SANDBOX_PROTOCOL"],
		spec.Environment["MUXTERM_SANDBOX_PROFILE_CHECKSUM"],
		spec.Environment["MUXTERM_SANDBOX_GENERATION"],
		spec.Environment["MUXTERM_SANDBOX_INGRESS_VERIFY_KEY"],
		"/tmp/muxterm-ingress-fixture.sock",
	); err != nil {
		return errors.New("ingress adapter rejected the sealed runtime contract")
	}
	if err := verifyIngressReadiness(spec); err != nil {
		return err
	}
	payload := sandboxazure.CreatePayload(spec)
	ports, ok := payload["ports"].([]map[string]any)
	if !ok || len(ports) != 1 || ports[0]["port"] != 8443 {
		return errors.New("provider payload omitted fixed ingress port")
	}
	acl, ok := ports[0]["ipAccessControl"].(map[string]any)
	if !ok || acl["defaultAction"] != "Deny" {
		return errors.New("provider payload did not default-deny ingress")
	}
	egress, ok := payload["egressPolicy"].(map[string]any)
	if !ok || egress["defaultAction"] != "Deny" {
		return errors.New("provider payload did not default-deny egress")
	}
	hostRules, ok := egress["hostRules"].([]map[string]string)
	if !ok || len(hostRules) != 1 || hostRules[0]["pattern"] != "packages.example.com" || hostRules[0]["action"] != "Allow" {
		return errors.New("provider payload did not seal reviewed egress hosts")
	}
	noEgress := spec
	noEgress.EgressHosts = nil
	emptyPolicy, ok := sandboxazure.CreatePayload(noEgress)["egressPolicy"].(map[string]any)
	emptyRules, rulesOK := emptyPolicy["hostRules"].([]map[string]string)
	if !ok || !rulesOK || emptyPolicy["defaultAction"] != "Deny" || len(emptyRules) != 0 {
		return errors.New("empty egress profile did not produce explicit no-egress policy")
	}
	lifecycle, ok := payload["lifecycle"].(map[string]any)
	if !ok || lifecycle["autoDeletePolicy"] == nil || lifecycle["autoSuspendPolicy"] == nil ||
		payload["environment"].(map[string]string)["MUXTERM_SANDBOX_INGRESS_VERIFY_KEY"] == "" {
		return errors.New("provider payload omitted lifecycle or proof bindings")
	}
	next := "https://management.westus2.azuredevcompute.io/subscriptions/subscription/resourceGroups/resource-group/sandboxGroups/sandbox-group/sandboxes?api-version=2026-02-01-preview&continuation=x"
	if !sandboxazure.ValidContinuationForFixture(profile(), next) ||
		sandboxazure.ValidContinuationForFixture(profile(), "http://management.westus2.azuredevcompute.io/subscriptions/x") ||
		sandboxazure.ValidContinuationForFixture(profile(), "https://attacker.invalid/subscriptions/subscription/resourceGroups/resource-group/sandboxGroups/sandbox-group/sandboxes?api-version=2026-02-01-preview") {
		return errors.New("provider continuation admission was not pinned to configured HTTPS collection")
	}
	return nil
}

func verifyIngressReadiness(spec sandboxazure.CreateSpec) error {
	cfg, err := sandboxingress.ParseRuntimeConfig(
		spec.Environment["MUXTERM_SANDBOX_PROTOCOL"],
		spec.Environment["MUXTERM_SANDBOX_PROFILE_CHECKSUM"],
		spec.Environment["MUXTERM_SANDBOX_GENERATION"],
		spec.Environment["MUXTERM_SANDBOX_INGRESS_VERIFY_KEY"],
		"/tmp/muxterm-ingress-fixture.sock",
	)
	if err != nil {
		return err
	}
	adapter, err := sandboxingress.New(cfg)
	if err != nil {
		return err
	}
	ready := true
	handler := sandboxingress.RuntimeHandler(adapter, func() bool { return ready })
	for _, scenario := range []struct {
		method, target string
		code           int
	}{
		{http.MethodGet, "/healthz", http.StatusNoContent},
		{http.MethodPost, "/healthz", http.StatusNotFound},
		{http.MethodGet, "/healthz?detail=1", http.StatusNotFound},
		{http.MethodGet, "/other", http.StatusNotFound},
		{http.MethodGet, "/v1/sessiond?token=no", http.StatusForbidden},
	} {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(scenario.method, scenario.target, nil)
		handler.ServeHTTP(response, request)
		if response.Code != scenario.code || (scenario.target == "/healthz" && response.Body.Len() != 0) {
			return errors.New("ingress readiness route was not fixed and content-free")
		}
	}
	ready = false
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if response.Code != http.StatusServiceUnavailable || response.Body.Len() != 0 {
		return errors.New("ingress readiness stayed affirmative after sessiond loss")
	}
	return nil
}

func verifyStoreSafety() error {
	parent := mustTempDir()
	unsafe := filepath.Join(parent, "unsafe")
	if err := os.Mkdir(unsafe, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(unsafe, 0o777); err != nil {
		return err
	}
	if _, err := sandboxazure.NewStore(filepath.Join(unsafe, "records")); !errors.Is(err, sandboxazure.ErrUnsafeStore) {
		return errors.New("store accepted a non-private ancestor")
	}
	target := filepath.Join(parent, "target")
	if err := os.Mkdir(target, 0o700); err != nil {
		return err
	}
	link := filepath.Join(parent, "records-link")
	if err := os.Symlink(target, link); err != nil {
		return err
	}
	if _, err := sandboxazure.NewStore(link); !errors.Is(err, sandboxazure.ErrUnsafeStore) {
		return errors.New("store accepted a symlink root")
	}
	invalid := profile()
	invalid.ControllerCIDRs = []string{"0.0.0.0/0"}
	if err := invalid.Validate(); err == nil {
		return errors.New("profile accepted IPv4 default-route controller CIDR")
	}
	invalid.ControllerCIDRs = []string{"::/0"}
	if err := invalid.Validate(); err == nil {
		return errors.New("profile accepted IPv6 default-route controller CIDR")
	}
	invalid = profile()
	invalid.EgressHosts = []string{"https://attacker.example"}
	if err := invalid.Validate(); err == nil {
		return errors.New("profile accepted non-host egress policy input")
	}
	invalid = profile()
	invalid.EgressHosts = []string{"packages.example.com", "packages.example.com"}
	if err := invalid.Validate(); err == nil {
		return errors.New("profile accepted repeated egress host")
	}
	return nil
}

func requestJSON(handler http.Handler, method, path, key, body, localToken string) (int, string) {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.RemoteAddr = "127.0.0.1:12345"
	request.Header.Set("Content-Type", "application/json")
	if key != "" {
		request.Header.Set("Idempotency-Key", key)
	}
	if localToken != "" {
		request.Header.Set("Authorization", "Bearer "+localToken)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	data, _ := io.ReadAll(response.Result().Body)
	return response.Code, string(data)
}

func differentHandle(handle string) string {
	// A different syntactically valid UUID confirms lookup fails without
	// accepting a request ID under another lifecycle identity.
	if handle[0] == '0' {
		return "10000000-0000-4000-8000-000000000000"
	}
	return "00000000-0000-4000-8000-000000000000"
}

func verifyConfigRetention() error {
	dir := mustTempDir()
	path := filepath.Join(dir, "config.toml")
	const configured = `
[sandbox_azure]
enabled = true
kill_switch = false
store_dir = "/tmp/muxterm-sandbox-fixture"

[[sandbox_azure.profile]]
name = "fixture"
tenant_id = "tenant"
subscription_id = "subscription"
resource_group = "resource-group"
sandbox_group = "sandbox-group"
region = "westus2"
disk_id = "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.App/sandboxGroups/sg/diskImages/image"
image_digest = "registry.example/muxterm-sessiond@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
release_status = "active"
protocol = 1
cpu = "1000m"
memory = "2048Mi"
auto_suspend_seconds = 300
auto_delete_seconds = 3600
controller_cidrs = ["192.0.2.0/24"]
egress_hosts = ["packages.example.com"]

`
	if err := os.WriteFile(path, []byte(configured), 0o600); err != nil {
		return err
	}
	// Browser configuration updates use this encoder. The private section is
	// retained in TOML but excluded from JSON, so an unrelated settings update
	// cannot erase or edit its scope allowlist.
	parsed, err := muxconfig.Load(path)
	if err != nil {
		return err
	}
	if err := muxconfig.Write(path, parsed); err != nil {
		return err
	}
	loaded, err := sandboxazure.LoadConfig(path)
	if err != nil || !loaded.Enabled || len(loaded.Profiles) != 1 || loaded.Profiles[0].Name != "fixture" ||
		len(loaded.Profiles[0].EgressHosts) != 1 || loaded.Profiles[0].EgressHosts[0] != "packages.example.com" {
		return errors.New("owner-only sandbox configuration was not retained across config write")
	}
	return nil
}

func profile() sandboxazure.Profile {
	return sandboxazure.Profile{
		Name: "fixture", TenantID: "tenant", SubscriptionID: "subscription",
		ResourceGroup: "resource-group", SandboxGroup: "sandbox-group", Region: "westus2",
		DiskID:        "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.App/sandboxGroups/sg/diskImages/image",
		ImageDigest:   "registry.example/muxterm-sessiond@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		ReleaseStatus: "active",
		Protocol:      sandboxazure.RuntimeProtocol,
		CPU:           "1000m", Memory: "2048Mi", AutoSuspendSecond: 300, AutoDeleteSeconds: 3600,
		ControllerCIDRs: []string{"192.0.2.0/24"},
		EgressHosts:     []string{"packages.example.com"},
	}
}

func mustTempDir() string {
	dir, err := os.MkdirTemp("", "muxterm-sandbox-verify-")
	if err != nil {
		panic(err)
	}
	return dir
}

func factory(f *fakeProvider) sandboxazure.ProviderFactory {
	return func(sandboxazure.Profile) (sandboxazure.Provider, error) { return f, nil }
}

type fakeProvider struct {
	items     map[string]sandboxazure.ProviderSandbox
	creates   int
	stops     int
	gets      int
	lists     int
	createErr error
	deleteErr error
	lastSpec  sandboxazure.CreateSpec
	stopState string
}

func (f *fakeProvider) Create(_ context.Context, spec sandboxazure.CreateSpec) (sandboxazure.ProviderSandbox, error) {
	f.creates++
	f.lastSpec = spec
	if f.createErr != nil {
		return sandboxazure.ProviderSandbox{}, f.createErr
	}
	item := sandboxazure.ProviderSandbox{ID: "provider-secret-id", State: "Creating", Labels: spec.Labels}
	f.items[item.ID] = item
	return item, nil
}

func (f *fakeProvider) List(_ context.Context) ([]sandboxazure.ProviderSandbox, error) {
	f.lists++
	result := make([]sandboxazure.ProviderSandbox, 0, len(f.items))
	for _, item := range f.items {
		result = append(result, item)
	}
	return result, nil
}

func (f *fakeProvider) Get(_ context.Context, id string) (sandboxazure.ProviderSandbox, error) {
	f.gets++
	item, ok := f.items[id]
	if !ok {
		return sandboxazure.ProviderSandbox{}, sandboxazure.ErrProviderNotFound
	}
	return item, nil
}

func (f *fakeProvider) Stop(_ context.Context, id, _ string) error {
	f.stops++
	item, ok := f.items[id]
	if !ok {
		return sandboxazure.ErrProviderNotFound
	}
	item.State = f.stopState
	if item.State == "" {
		item.State = "Stopped"
	}
	f.items[id] = item
	return nil
}

func (f *fakeProvider) Resume(_ context.Context, id, _ string) error {
	item, ok := f.items[id]
	if !ok {
		return sandboxazure.ErrProviderNotFound
	}
	item.State = "Running"
	f.items[id] = item
	return nil
}

func (f *fakeProvider) Delete(_ context.Context, id, _ string) error {
	if f.deleteErr != nil {
		return f.deleteErr
	}
	delete(f.items, id)
	return nil
}
