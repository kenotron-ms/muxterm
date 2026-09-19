package sessiond

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/kenotron-ms/muxterm/internal/config"
)

// ApplyLaneApproval runs in the launching daemon, so remote callers use the
// destination machine's config and executable. Read on each spawn: an owner can
// change policy without restarting sessiond or disturbing existing lanes.
// Shell commands typed by hand and restored sessions are not new lane launches.
func ApplyLaneApproval(argv []string, override string) ([]string, error) {
	if override != "" && override != "prompt" && override != "never" {
		return nil, fmt.Errorf("lanes.approval: invalid override %q (want prompt or never)", override)
	}
	if len(argv) == 0 {
		return argv, nil
	}
	harness := filepath.Base(argv[0])
	if harness != HarnessCodex && harness != HarnessClaude {
		if override != "" {
			return nil, fmt.Errorf("lanes.approval: %s has no approval translation", harness)
		}
		return argv, nil
	}
	cfg, malformed, err := config.LoadStrictServer(config.DefaultPath())
	if err != nil {
		return nil, fmt.Errorf("lanes.approval: %w", err)
	}
	if malformed {
		return nil, fmt.Errorf("lanes.approval: cannot launch with malformed muxterm config %s", config.DefaultPath())
	}
	policy := cfg.Lanes.Approval
	if policy != "prompt" && policy != "never" {
		return nil, fmt.Errorf("lanes.approval: invalid value %q (want prompt or never)", policy)
	}
	if override != "" {
		policy = override
	}
	// Reject ambiguous raw launch options instead of claiming muxterm owns a
	// policy that a competing CLI option/profile/remote server could override.
	for i := 1; i < len(argv); i++ {
		arg := argv[i]
		if arg == "--" {
			break
		}
		if harness == HarnessCodex && (arg == "-c" || arg == "--config") && i+1 < len(argv) {
			i++
			if strings.HasPrefix(argv[i], "notify=") {
				continue
			}
			return nil, fmt.Errorf("lanes.approval: conflicting Codex config override %q", argv[i])
		}
		if strings.HasPrefix(arg, "-") {
			return nil, fmt.Errorf("lanes.approval: unsupported competing launch option %q", arg)
		}
	}
	path, err := exec.LookPath(argv[0])
	if err != nil {
		return nil, fmt.Errorf("lanes.approval: %w", err)
	}
	version, err := approvalProbe(path, "--version")
	if err != nil {
		return nil, err
	}
	// Verified translation: codex-cli 0.155.1; Claude Code 2.1.277 (host).
	// Claude 2.1.276 is intentionally NOT accepted without live verification.
	// Exact pinning is deliberate: Codex accepts unknown -c keys silently, so
	// --help alone cannot prove the policy survived an upgrade. Reverify before
	// extending this allowlist. No fallback to a launch without policy flags.
	var flags []string
	switch harness {
	case HarnessCodex:
		if version != "codex-cli 0.155.1" {
			return nil, approvalVersionError(harness, version)
		}
		flags = []string{"-c", "approval_policy=on-request", "-c", "sandbox_mode=workspace-write"}
		if policy == "never" {
			flags = []string{"-c", "approval_policy=never", "-c", "sandbox_mode=danger-full-access"}
		}
	case HarnessClaude:
		if version != "2.1.277 (Claude Code)" {
			return nil, approvalVersionError(harness, version)
		}
		flags = []string{"--permission-mode", "default"}
		if policy == "never" {
			flags = []string{"--dangerously-skip-permissions"}
		}
	}
	if _, err := approvalProbe(path, append(append([]string{}, flags...), "--help")...); err != nil {
		return nil, err
	}
	result := append([]string{path}, flags...)
	return append(result, argv[1:]...), nil
}

func approvalVersionError(harness, version string) error {
	return fmt.Errorf("lanes.approval: refusing %s version %q: approval translation is unverified; update muxterm's verified translation before launching", harness, version)
}

func approvalProbe(path string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, path, args...).CombinedOutput()
	if err != nil {
		if len(out) > 2048 {
			out = out[:2048]
		}
		return "", fmt.Errorf("lanes.approval: %s preflight failed (%v): %s", filepath.Base(path), err, strings.TrimSpace(string(out)))
	}
	return strings.TrimSpace(string(out)), nil
}
