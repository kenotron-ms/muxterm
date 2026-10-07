package update

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"github.com/kenotron-ms/muxterm/internal/atomicfile"
)

const anonymousReleaseCacheAge = 24 * time.Hour
const authenticatedReleaseCacheAge = 15 * time.Minute
const failedCheckAge = 2 * time.Minute

// releaseCache is shared by every muxterm process under the same user. No
// credentials are stored here. The lock covers the network request as well as
// the read/write, so simultaneous fresh processes spend only one API request.
type releaseCache struct {
	URL         string    `json:"url"`
	Auth        bool      `json:"auth"`
	ETag        string    `json:"etag,omitempty"`
	Release     *Release  `json:"release,omitempty"`
	CheckedAt   time.Time `json:"checkedAt,omitempty"`
	AttemptedAt time.Time `json:"attemptedAt,omitempty"`
	RetryAt     time.Time `json:"retryAt,omitempty"`
	Error       string    `json:"error,omitempty"`
}

func releaseCachePath() (string, error) {
	if dir := os.Getenv("MUXTERM_UPDATE_CACHE_DIR"); dir != "" {
		return filepath.Join(dir, "github-release.json"), nil
	}
	dir, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "muxterm", "github-release.json"), nil
}

func lockedReleaseCache(fn func(*releaseCache) (*Release, error)) (*Release, error) {
	path, err := releaseCachePath()
	if err != nil {
		return nil, fmt.Errorf("locate update cache: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, fmt.Errorf("create update cache directory: %w", err)
	}
	lock, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, fmt.Errorf("open update cache lock: %w", err)
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return nil, fmt.Errorf("lock update cache: %w", err)
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)

	var cache releaseCache
	data, err := os.ReadFile(path)
	if err == nil {
		if err := json.Unmarshal(data, &cache); err != nil {
			// A torn or obsolete cache is safely replaced under the same lock.
			cache = releaseCache{}
		}
	} else if !os.IsNotExist(err) {
		return nil, fmt.Errorf("read update cache: %w", err)
	}
	rel, lookupErr := fn(&cache)
	data, err = json.Marshal(cache)
	if err != nil {
		return nil, fmt.Errorf("encode update cache: %w", err)
	}
	if err := atomicfile.Write(path, data, 0600); err != nil {
		return nil, fmt.Errorf("save update cache: %w", err)
	}
	return rel, lookupErr
}
