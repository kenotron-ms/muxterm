package update

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
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

// LatestRelease shares a persisted release and ETag across processes. A fresh
// cache returns without network I/O; an expired one is revalidated.
func LatestRelease(ctx context.Context) (*Release, error) {
	url := apiURL()
	var token string
	if url == defaultAPIURL {
		token = os.Getenv("GITHUB_TOKEN")
		if token == "" {
			token = os.Getenv("GH_TOKEN")
		}
	}
	return lockedReleaseCache(func(cache *releaseCache) (*Release, error) {
		if cache.URL != url || cache.Auth != (token != "") {
			*cache = releaseCache{URL: url, Auth: token != ""}
		}
		now := time.Now()
		if cache.Error != "" && now.Before(cache.RetryAt) {
			return nil, fmt.Errorf("GitHub API rate limit reached; retry after %s", cache.RetryAt.UTC().Format(time.RFC3339))
		}
		if cache.Error != "" && now.Sub(cache.AttemptedAt) < failedCheckAge {
			return nil, fmt.Errorf("%s", cache.Error)
		}
		if cache.Release != nil && now.Sub(cache.CheckedAt) < releaseCacheAge {
			return cache.Release, nil
		}
		if now.Before(cache.RetryAt) {
			return nil, fmt.Errorf("GitHub API rate limit reached; retry after %s", cache.RetryAt.UTC().Format(time.RFC3339))
		}
		rel, etag, remaining, reset, err := fetchLatestRelease(ctx, url, token, cache.ETag, cache.Release)
		cache.AttemptedAt = time.Now()
		if err != nil {
			cache.Error = err.Error()
			if remaining == 0 {
				cache.RetryAt = reset
			}
			return nil, err
		}
		cache.Release = rel
		cache.ETag = etag
		cache.CheckedAt = cache.AttemptedAt
		cache.Error = ""
		if remaining == 0 {
			cache.RetryAt = reset
		} else {
			cache.RetryAt = time.Time{}
		}
		return rel, nil
	})
}

func fetchLatestRelease(ctx context.Context, url, token, etag string, cached *Release) (*Release, string, int, time.Time, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, etag, -1, time.Time{}, fmt.Errorf("build release request: %w", err)
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if etag != "" && cached != nil {
		req.Header.Set("If-None-Match", etag)
	}

	resp, err := apiClient.Do(req)
	if err != nil {
		return nil, etag, -1, time.Time{}, fmt.Errorf("fetch latest release: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	remaining := -1
	if n, err := strconv.Atoi(resp.Header.Get("X-RateLimit-Remaining")); err == nil {
		remaining = n
	}
	reset := time.Time{}
	if unix, err := strconv.ParseInt(resp.Header.Get("X-RateLimit-Reset"), 10, 64); err == nil {
		reset = time.Unix(unix, 0).Add(time.Second)
	}
	if remaining == 0 && !reset.After(time.Now()) {
		reset = time.Now().Add(time.Hour)
	}
	if resp.StatusCode == http.StatusNotModified {
		if cached == nil {
			return nil, etag, remaining, reset, fmt.Errorf("release endpoint returned 304 without a cached release")
		}
		if newETag := resp.Header.Get("ETag"); newETag != "" {
			etag = newETag
		}
		return cached, etag, remaining, reset, nil
	}

	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, etag, remaining, reset, fmt.Errorf("fetch latest release: unexpected status %s", resp.Status)
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
		return nil, etag, remaining, reset, fmt.Errorf("decode latest release: %w", err)
	}
	if payload.TagName == "" {
		return nil, etag, remaining, reset, fmt.Errorf("latest release has no tag_name")
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
	return rel, resp.Header.Get("ETag"), remaining, reset, nil
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

	if IsDev(current) || strings.HasSuffix(filepath.Base(os.Args[0]), ".test") ||
		os.Getenv("MUXTERM_DEV_INSTANCE") == "1" ||
		os.Getenv("MUXTERM_DISABLE_UPDATE_CHECK") == "1" || os.Getenv("CI") != "" {
		// Short-circuit before any network call. Development and ephemeral
		// instances must not spend the shared IP budget or install a release.
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
