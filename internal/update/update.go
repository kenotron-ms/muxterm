package update

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"runtime"
	"strings"
	"time"
)

const (
	// repo is the GitHub repository the release assets are published to. It
	// matches install.sh's REPO.
	repo = "kenotron-ms/muxterm"

	// defaultAPIURL is the GitHub API endpoint install.sh uses to resolve the
	// latest tag.
	defaultAPIURL = "https://api.github.com/repos/" + repo + "/releases/latest"

	// downloadURLPrefix is the release-asset download URL form, used to
	// synthesize asset URLs when the release payload omits the assets array.
	downloadURLPrefix = "https://github.com/" + repo + "/releases/download/"

	// checksumsAsset is the sha256sum-format manifest published alongside the
	// tarballs (goreleaser's checksum.name_template).
	checksumsAsset = "checksums.txt"

	// binaryName is the file inside the tarball that becomes the installed
	// binary (goreleaser's builds[].binary).
	binaryName = "muxterm"

	// apiURLEnv overrides the release-source endpoint. Set it to a URL that
	// serves the same GitHub release JSON contract to exercise the update path
	// against a stub instead of the live GitHub API. Empty or unset uses
	// defaultAPIURL.
	apiURLEnv = "MUXTERM_UPDATE_API_URL"
)

// apiClient talks to the release-metadata endpoint only. The payload is a few
// kilobytes of JSON, so a short timeout is right; asset downloads use their
// own, much longer, client (see apply.go).
var apiClient = &http.Client{Timeout: 15 * time.Second}

// Release is a published muxterm release and its downloadable assets.
type Release struct {
	Tag    string            // e.g. "v0.12.0"
	Assets map[string]string // asset name -> download URL
}

// AssetName returns the release tarball name for the running platform, e.g.
// "muxterm_linux_amd64.tar.gz".
func AssetName() string {
	return fmt.Sprintf("%s_%s_%s.tar.gz", binaryName, runtime.GOOS, runtime.GOARCH)
}

// apiURL returns the release-metadata endpoint, honoring the MUXTERM_UPDATE_API_URL override.
func apiURL() string {
	if u := os.Getenv(apiURLEnv); u != "" {
		return u
	}
	return defaultAPIURL
}

// LatestRelease fetches the newest published release.
func LatestRelease(ctx context.Context) (*Release, error) {
	url := apiURL()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("build release request: %w", err)
	}
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := apiClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch latest release: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, fmt.Errorf("fetch latest release: unexpected status %s", resp.Status)
	}

	var payload struct {
		TagName string `json:"tag_name"`
		Assets  []struct {
			Name string `json:"name"`
			URL  string `json:"browser_download_url"`
		} `json:"assets"`
	}
	// Cap the body: an override endpoint is not necessarily trustworthy about size.
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode latest release: %w", err)
	}
	if payload.TagName == "" {
		return nil, fmt.Errorf("latest release has no tag_name")
	}

	rel := &Release{Tag: payload.TagName, Assets: make(map[string]string, len(payload.Assets)+2)}
	for _, a := range payload.Assets {
		if a.Name == "" || a.URL == "" {
			continue
		}
		rel.Assets[a.Name] = a.URL
	}
	if len(rel.Assets) == 0 {
		// No assets array: synthesize the two URLs this package needs from the
		// tag, using the documented release-download URL form.
		for _, name := range []string{AssetName(), checksumsAsset} {
			rel.Assets[name] = downloadURLPrefix + payload.TagName + "/" + name
		}
	}
	return rel, nil
}

// Status is the self-update state of the running binary, as served by
// GET /api/update/status.
type Status struct {
	CurrentVersion  string `json:"currentVersion"`
	LatestVersion   string `json:"latestVersion"` // leading "v" stripped; "" when unknown
	UpdateAvailable bool   `json:"updateAvailable"`
	CanUpdate       bool   `json:"canUpdate"`
	DevBuild        bool   `json:"devBuild"`
	Method          Method `json:"method"`
	Reason          string `json:"reason,omitempty"` // why not actionable
	Error           string `json:"error,omitempty"`  // release check failed
}

// Check resolves the current update status for the running binary. It never
// returns an error: a failed release lookup populates Error and leaves
// CanUpdate false, because a status endpoint that 500s on a flaky network is
// worse than one that reports "could not check".
//
// The resolved release is returned alongside the status so a caller that goes
// on to install it does not have to fetch it a second time. Two fetches would
// double GitHub API consumption and, if a release were published between them,
// would decide CanUpdate against one release and install a different one.
//
// The release is nil whenever no lookup happened or the lookup failed — a dev
// build or a populated Error. It is always non-nil when CanUpdate is true.
func Check(ctx context.Context, current string) (Status, *Release) {
	method, reason := Platform()
	st := Status{CurrentVersion: current, Method: method}

	if IsDev(current) {
		// Short-circuit before any network call: a dev build has nothing to
		// compare against and must never be replaced by a release binary.
		st.DevBuild = true
		st.Reason = "Development build — updates are managed by your build, not by releases."
		return st, nil
	}

	rel, err := LatestRelease(ctx)
	if err != nil {
		st.Error = err.Error()
		return st, nil
	}

	st.LatestVersion = strings.TrimPrefix(rel.Tag, "v")
	st.UpdateAvailable = Newer(current, rel.Tag)
	st.CanUpdate = st.UpdateAvailable && method == MethodBinary
	if st.UpdateAvailable && method != MethodBinary {
		st.Reason = reason
	}
	return st, rel
}
