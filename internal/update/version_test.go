package update

import "testing"

func TestPlatformReleaseBuilds(t *testing.T) {
	for _, tc := range []struct {
		goos, goarch string
		method       Method
	}{
		{"linux", "amd64", MethodBinary},
		{"linux", "arm64", MethodBinary},
		{"linux", "riscv64", MethodUnsupported},
		{"darwin", "arm64", MethodHomebrew},
	} {
		method, reason := platform(tc.goos, tc.goarch)
		if method != tc.method {
			t.Errorf("platform(%q, %q) = %q, want %q", tc.goos, tc.goarch, method, tc.method)
		}
		if method == MethodBinary && reason != "" {
			t.Errorf("platform(%q, %q) reason = %q, want empty", tc.goos, tc.goarch, reason)
		}
	}
}
