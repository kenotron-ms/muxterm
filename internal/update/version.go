// Package update implements muxterm's self-update: resolving the latest
// published release, comparing it against the running binary's version,
// replacing the binary in place, and restarting the process.
//
// Everything here is deliberately fail-closed. When anything is uncertain --
// an unparseable version, a network error, an unpublished platform -- the
// package reports "no update available" rather than risk replacing a working
// binary with something it could not verify.
package update

import (
	"fmt"
	"regexp"
	"runtime"
	"strconv"
	"strings"
)

// gitDescribeRe matches the commit-count tail that `git describe --tags
// --always --dirty` appends to a tag once commits land on top of it
// (e.g. "0.12.0-5-gdeadbee"). Dev builds are stamped this way by the Makefile.
var gitDescribeRe = regexp.MustCompile(`-\d+-g[0-9a-f]{7,}(-dirty)?$`)

// semverRe matches a released version string: MAJOR.MINOR.PATCH with optional
// prerelease and build-metadata suffixes. Release ldflags strip the tag's
// leading "v", so a released binary reports e.g. "0.12.0".
var semverRe = regexp.MustCompile(`^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$`)

// IsDev reports whether v is a development build rather than a released
// version. Development builds are never offered an update: their binary is
// managed by whoever built it, not by the release pipeline.
func IsDev(v string) bool {
	if v == "" || v == "dev" {
		return true
	}
	v = strings.TrimPrefix(v, "v")
	if strings.HasSuffix(v, "-dirty") {
		return true
	}
	if gitDescribeRe.MatchString(v) {
		return true
	}
	// Anything that is not a well-formed release version (a bare commit sha,
	// a hand-edited string, ...) is treated as a dev build.
	return !semverRe.MatchString(v)
}

// Newer reports whether candidate is a strictly newer release than current.
//
// It compares MAJOR.MINOR.PATCH numerically and ignores build metadata. A
// version carrying a prerelease suffix sorts before the same version without
// one, so 1.2.0-rc.1 -> 1.2.0 is an upgrade. Two different prereleases of the
// same core version are not ordered against each other: that case, like any
// version either side fails to parse, returns false. Never claim an update
// when uncertain.
func Newer(current, candidate string) bool {
	cur, curPre, ok := parseVersion(current)
	if !ok {
		return false
	}
	cand, candPre, ok := parseVersion(candidate)
	if !ok {
		return false
	}
	for i := range cur {
		if cand[i] != cur[i] {
			return cand[i] > cur[i]
		}
	}
	// Same core version: only a prerelease -> final transition is an upgrade.
	return curPre != "" && candPre == ""
}

// parseVersion splits a version string into its three numeric components and
// its prerelease suffix. Build metadata is discarded. ok is false when the
// string is not MAJOR.MINOR.PATCH.
func parseVersion(v string) (nums [3]int, prerelease string, ok bool) {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if i := strings.IndexByte(v, '+'); i >= 0 {
		v = v[:i]
	}
	if i := strings.IndexByte(v, '-'); i >= 0 {
		prerelease = v[i+1:]
		v = v[:i]
	}
	parts := strings.Split(v, ".")
	if len(parts) != 3 {
		return nums, "", false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return nums, "", false
		}
		nums[i] = n
	}
	return nums, prerelease, true
}

// Method describes how this build can update itself.
type Method string

const (
	MethodBinary      Method = "binary"      // in-place replace is supported
	MethodHomebrew    Method = "homebrew"    // macOS: defer to brew
	MethodUnsupported Method = "unsupported" // no release asset for this platform
)

// Platform reports how (or whether) this build can update itself in place,
// plus a human-readable reason when it cannot. The reason is empty for
// MethodBinary.
//
// This inspects runtime.GOOS/runtime.GOARCH rather than using build tags so
// the whole package compiles unchanged on every target.
func Platform() (Method, string) {
	switch {
	case runtime.GOOS == "darwin":
		// install.sh redirects macOS users to Homebrew, so the binary a mac
		// user is running is brew-managed; replacing it behind brew's back
		// would leave the formula and the installed binary out of sync.
		return MethodHomebrew, "Installed via Homebrew — run `brew upgrade muxterm` to update."
	case runtime.GOOS == "linux" && runtime.GOARCH == "amd64":
		return MethodBinary, ""
	default:
		// linux/arm64 in particular is deliberately not published -- see the
		// goreleaser build comment about the PAM binding's build constraints.
		return MethodUnsupported, fmt.Sprintf("No release build is published for %s/%s.", runtime.GOOS, runtime.GOARCH)
	}
}
