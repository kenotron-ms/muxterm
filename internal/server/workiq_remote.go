package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"golang.org/x/oauth2"
)

// Microsoft publishes this public client and hosted MCP endpoint in
// microsoft/work-iq plugins/workiq/.mcp.json at 7fde3f8e6477fc75c79a7d8386e8501105b2d9bd.
// Device authorization works on a server with no browser or loopback callback.
const (
	workIQRemoteID       = "workiq"
	workIQRemoteEndpoint = "https://workiq.svc.cloud.microsoft/mcp"
	workIQClientID       = "ba081686-5d24-4bc6-a0d6-d034ecffed87"
	workIQScope          = "fdcc1f02-fc51-4226-8753-f668596af7f7/WorkIQAgent.Ask"
	workIQDeviceURL      = "https://login.microsoftonline.com/organizations/oauth2/v2.0/devicecode"
	workIQTokenURL       = "https://login.microsoftonline.com/organizations/oauth2/v2.0/token"
)

type workIQDeviceAttempt struct {
	code, userCode, verificationURL string
	expires                         time.Time
	cancel                          context.CancelFunc
	generation                      uint64
	errorText                       string
}

var workIQDevice = struct {
	sync.Mutex
	attempt *workIQDeviceAttempt
	next    uint64
}{}

func workIQRemoteRecord() (remoteConnection, bool, error) {
	var record remoteConnection
	var found bool
	err := withRemoteConnections(func(records map[string]remoteConnection) error {
		record, found = records[workIQRemoteID]
		return nil
	})
	return record, found, err
}

func workIQState() (map[string]any, error) {
	result := map[string]any{
		"mode": "remote", "endpoint": workIQRemoteEndpoint,
		"state": "disconnected", "toolCount": 0,
		"discoveredTools": []remoteToolSummary{}, "allowedTools": []string{},
	}
	record, found, err := workIQRemoteRecord()
	if err != nil {
		return nil, err
	}
	if found && record.Provider == workIQRemoteID && record.Endpoint == workIQRemoteEndpoint && record.Token != nil {
		result["state"] = "authorized"
		result["toolCount"] = record.ToolCount
		result["discoveredTools"] = record.public().DiscoveredTools
		result["allowedTools"] = record.public().AllowedTools
		if !record.CheckedAt.IsZero() {
			result["checkedAt"] = record.CheckedAt
		}
		if record.CheckError != "" {
			result["state"] = "needs-attention"
			result["error"] = record.CheckError
		} else if !record.CheckedAt.IsZero() && time.Since(record.CheckedAt) < 5*time.Minute && len(record.AllowedTools) > 0 {
			result["state"] = "ready"
		}
	}
	workIQDevice.Lock()
	if attempt := workIQDevice.attempt; attempt != nil {
		if attempt.errorText != "" {
			result["state"] = "needs-attention"
			result["error"] = attempt.errorText
		} else if time.Now().Before(attempt.expires) {
			result["state"] = "pending"
			result["verificationUrl"] = attempt.verificationURL
			result["userCode"] = attempt.userCode
			result["expiresAt"] = attempt.expires
		} else {
			result["state"] = "needs-attention"
			result["error"] = "Microsoft sign-in code expired; try again"
		}
	}
	workIQDevice.Unlock()
	return result, nil
}

func writeWorkIQState(w http.ResponseWriter) {
	state, err := workIQState()
	if err != nil {
		http.Error(w, "Microsoft connection settings could not be read", http.StatusInternalServerError)
		return
	}
	writeSDKJSON(w, http.StatusOK, state)
}

func (s *Server) handleWorkIQRemote(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeWorkIQState(w)
	case http.MethodDelete:
		cancelWorkIQDevice()
		if err := withRemoteConnections(func(records map[string]remoteConnection) error {
			delete(records, workIQRemoteID)
			return saveRemoteConnections(records)
		}); err != nil {
			http.Error(w, "Microsoft connection could not be removed", http.StatusInternalServerError)
			return
		}
		writeWorkIQState(w)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func cancelWorkIQDevice() {
	workIQDevice.Lock()
	defer workIQDevice.Unlock()
	if workIQDevice.attempt != nil {
		workIQDevice.attempt.cancel()
		workIQDevice.attempt = nil
	}
	workIQDevice.next++
}

func (s *Server) handleWorkIQLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodDelete {
		cancelWorkIQDevice()
		writeWorkIQState(w)
		return
	}
	workIQDevice.Lock()
	pending := workIQDevice.attempt != nil && workIQDevice.attempt.errorText == "" && time.Now().Before(workIQDevice.attempt.expires)
	workIQDevice.Unlock()
	if pending {
		writeWorkIQState(w)
		return
	}
	// A new attempt invalidates any earlier poller before contacting Entra.
	cancelWorkIQDevice()
	form := url.Values{"client_id": {workIQClientID}, "scope": {workIQScope + " offline_access"}}
	request, err := http.NewRequestWithContext(r.Context(), http.MethodPost, workIQDeviceURL, strings.NewReader(form.Encode()))
	if err != nil {
		http.Error(w, "Microsoft sign-in could not start", http.StatusBadGateway)
		return
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := safeRemoteHTTPClient(15 * time.Second).Do(request)
	if err != nil {
		http.Error(w, "Microsoft sign-in could not start", http.StatusBadGateway)
		return
	}
	defer response.Body.Close()
	var body struct {
		DeviceCode      string `json:"device_code"`
		UserCode        string `json:"user_code"`
		VerificationURI string `json:"verification_uri"`
		ExpiresIn       int    `json:"expires_in"`
		Interval        int    `json:"interval"`
	}
	if response.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(response.Body, 16<<10)).Decode(&body) != nil ||
		body.DeviceCode == "" || body.UserCode == "" || body.ExpiresIn < 30 || body.ExpiresIn > 3600 {
		http.Error(w, "Microsoft device sign-in is unavailable", http.StatusBadGateway)
		return
	}
	verification, err := validatedPublicURL(body.VerificationURI)
	if err != nil || verification.Hostname() != "microsoft.com" && !strings.HasSuffix(verification.Hostname(), ".microsoft.com") {
		http.Error(w, "Microsoft returned an unexpected sign-in URL", http.StatusBadGateway)
		return
	}
	pollCtx, cancel := context.WithCancel(context.Background())
	workIQDevice.Lock()
	workIQDevice.next++
	attempt := &workIQDeviceAttempt{
		code: body.DeviceCode, userCode: body.UserCode, verificationURL: verification.String(),
		expires: time.Now().Add(time.Duration(body.ExpiresIn) * time.Second), cancel: cancel, generation: workIQDevice.next,
	}
	workIQDevice.attempt = attempt
	workIQDevice.Unlock()
	interval := body.Interval
	if interval < 5 {
		interval = 5
	}
	go pollWorkIQDevice(pollCtx, attempt, time.Duration(interval)*time.Second)
	writeWorkIQState(w)
}

func workIQAttemptCurrent(attempt *workIQDeviceAttempt) bool {
	workIQDevice.Lock()
	defer workIQDevice.Unlock()
	return workIQDevice.attempt == attempt && workIQDevice.next == attempt.generation
}

func finishWorkIQAttempt(attempt *workIQDeviceAttempt, message string) {
	workIQDevice.Lock()
	defer workIQDevice.Unlock()
	if workIQDevice.attempt == attempt && workIQDevice.next == attempt.generation {
		attempt.code = ""
		attempt.errorText = message
		if message == "" {
			workIQDevice.attempt = nil
		}
	}
}

func pollWorkIQDevice(ctx context.Context, attempt *workIQDeviceAttempt, interval time.Duration) {
	defer attempt.cancel()
	for time.Now().Before(attempt.expires) {
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		if !workIQAttemptCurrent(attempt) {
			return
		}
		form := url.Values{
			"grant_type":  {"urn:ietf:params:oauth:grant-type:device_code"},
			"client_id":   {workIQClientID},
			"device_code": {attempt.code},
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, workIQTokenURL, strings.NewReader(form.Encode()))
		if err != nil {
			finishWorkIQAttempt(attempt, "Microsoft sign-in could not be completed")
			return
		}
		request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		response, err := safeRemoteHTTPClient(15 * time.Second).Do(request)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			finishWorkIQAttempt(attempt, "Microsoft sign-in could not be reached")
			return
		}
		var result struct {
			AccessToken  string `json:"access_token"`
			RefreshToken string `json:"refresh_token"`
			TokenType    string `json:"token_type"`
			ExpiresIn    int    `json:"expires_in"`
			Error        string `json:"error"`
		}
		err = json.NewDecoder(io.LimitReader(response.Body, 32<<10)).Decode(&result)
		response.Body.Close()
		if err != nil {
			finishWorkIQAttempt(attempt, "Microsoft returned an unreadable sign-in response")
			return
		}
		if response.StatusCode != http.StatusOK {
			switch result.Error {
			case "authorization_pending":
				continue
			case "slow_down":
				interval += 5 * time.Second
				continue
			case "authorization_declined", "access_denied":
				finishWorkIQAttempt(attempt, "Microsoft sign-in was declined")
			case "expired_token", "bad_verification_code":
				finishWorkIQAttempt(attempt, "Microsoft sign-in code expired; try again")
			default:
				finishWorkIQAttempt(attempt, "Microsoft sign-in failed; check tenant consent and account access")
			}
			return
		}
		if result.AccessToken == "" || result.RefreshToken == "" || !strings.EqualFold(result.TokenType, "Bearer") || result.ExpiresIn <= 0 {
			finishWorkIQAttempt(attempt, "Microsoft did not return renewable access")
			return
		}
		revision, err := randomURLSafeString(12)
		if err != nil {
			finishWorkIQAttempt(attempt, "Microsoft connection could not be saved")
			return
		}
		// Serialize the final token commit with Cancel and Disconnect. A
		// cancelled attempt must never recreate an enabled connection. Readers
		// release the connection file lock before taking workIQDevice's mutex.
		workIQDevice.Lock()
		if workIQDevice.attempt != attempt || workIQDevice.next != attempt.generation {
			workIQDevice.Unlock()
			return
		}
		err = withRemoteConnections(func(records map[string]remoteConnection) error {
			records[workIQRemoteID] = remoteConnection{
				ID: workIQRemoteID, Provider: workIQRemoteID, Name: "Microsoft 365",
				Endpoint: workIQRemoteEndpoint, Issuer: "https://login.microsoftonline.com/organizations/v2.0",
				TokenURL: workIQTokenURL, ClientID: workIQClientID, Scopes: []string{workIQScope, "offline_access"},
				Token:        &oauth2.Token{AccessToken: result.AccessToken, RefreshToken: result.RefreshToken, TokenType: "Bearer", Expiry: time.Now().Add(time.Duration(result.ExpiresIn) * time.Second)},
				AuthRevision: revision,
			}
			return saveRemoteConnections(records)
		})
		workIQDevice.Unlock()
		if err != nil {
			if ctx.Err() == nil {
				finishWorkIQAttempt(attempt, "Microsoft connection could not be saved")
			}
			return
		}
		finishWorkIQAttempt(attempt, "")
		return
	}
	finishWorkIQAttempt(attempt, "Microsoft sign-in code expired; try again")
}

func (s *Server) handleWorkIQCheck(w http.ResponseWriter, r *http.Request) {
	record, found, err := workIQRemoteRecord()
	if err != nil || !found || record.Provider != workIQRemoteID {
		http.Error(w, "sign in to Microsoft first", http.StatusConflict)
		return
	}
	s.handleRemoteCheck(w, r, workIQRemoteID)
}

func (s *Server) handleWorkIQTools(w http.ResponseWriter, r *http.Request) {
	record, found, err := workIQRemoteRecord()
	if err != nil || !found || record.Provider != workIQRemoteID {
		http.Error(w, "sign in to Microsoft first", http.StatusConflict)
		return
	}
	s.handleRemoteTools(w, r, workIQRemoteID)
}
