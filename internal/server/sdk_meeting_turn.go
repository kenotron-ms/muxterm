package server

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// meetingTURNServer issues coturn REST credentials. The shared secret stays on
// the server; browsers receive only a password that expires after one day.
func meetingTURNServer() (map[string]any, error) {
	cfg, _, err := loadMeetingTURNConfig()
	if err != nil {
		return nil, err
	}
	if cfg.APIURL != "" {
		return fetchMeetingTURNServiceCredentials(cfg)
	}
	if len(cfg.URLs) == 0 {
		return nil, err
	}
	username := strconv.FormatInt(time.Now().Add(24*time.Hour).Unix(), 10) + ":" + randomMeetingSecret()
	mac := hmac.New(sha1.New, []byte(cfg.Secret))
	_, _ = mac.Write([]byte(username))
	return map[string]any{
		"urls": cfg.URLs, "username": username,
		"credential": base64.StdEncoding.EncodeToString(mac.Sum(nil)),
	}, nil
}

func fetchMeetingTURNServiceCredentials(cfg meetingTURNConfig) (map[string]any, error) {
	client := &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
		return errors.New("TURN service redirects are not allowed")
	}}
	req, err := http.NewRequest(http.MethodGet, cfg.APIURL+"/v1/turn-credentials", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	response, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("TURN service request failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("TURN service returned HTTP %d", response.StatusCode)
	}
	var issued struct {
		URLs       []string `json:"urls"`
		Username   string   `json:"username"`
		Credential string   `json:"credential"`
		ExpiresAt  int64    `json:"expiresAt"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 16<<10)).Decode(&issued); err != nil {
		return nil, errors.New("TURN service returned invalid credentials")
	}
	if issued.Username == "" || issued.Credential == "" || issued.ExpiresAt <= time.Now().Add(5*time.Minute).Unix() ||
		validateMeetingTURNConfig(meetingTURNConfig{URLs: issued.URLs, Secret: "temporary-validation-secret-32-chars"}) != nil {
		return nil, errors.New("TURN service returned invalid credentials")
	}
	return map[string]any{"urls": issued.URLs, "username": issued.Username, "credential": issued.Credential}, nil
}
