package sessiond

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/kenotron-ms/muxterm/internal/config"
)

// codexApprovalVerified lists the exact `codex --version` strings whose
// approval translation below has been verified by hand against a real CLI.
// Append to it only after reverifying; the block comment in ApplyLaneApproval
// records what "verified" means and how to repeat it.
var codexApprovalVerified = []string{
	"codex-cli 0.155.1",
	"codex-cli 0.157.0",
}

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
	prefix := 1
	wrapped := strings.HasPrefix(harness, "muxterm") && len(argv) > 1 && (argv[1] == HarnessCodex || argv[1] == HarnessClaude)
	if wrapped {
		harness = argv[1]
		prefix = 2
	}
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
	for i := prefix; i < len(argv); i++ {
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
	path, err := exec.LookPath(harness)
	if err != nil {
		return nil, fmt.Errorf("lanes.approval: %w", err)
	}
	version, err := approvalProbe(path, "--version")
	if err != nil {
		return nil, err
	}
	// VERIFIED TRANSLATIONS. Each harness pins the exact --version strings whose
	// approval translation was checked against a real CLI. There is deliberately
	// no fallback to a launch without policy flags.
	//
	// Exact pinning is deliberate and is STILL load-bearing on 0.157.0: Codex
	// accepts unknown -c keys silently, and `--help` short-circuits before config
	// validation, so the approvalProbe below cannot prove the policy survived an
	// upgrade. Measured on 0.157.0: `codex -c approval_policy=totally-bogus-value
	// --help` exits 0, exactly as `-c muxterm_unknown_key_xyz=1 --help` does.
	// That is why this allowlist exists and why widening it needs real evidence.
	//
	// codex-cli 0.157.0 added 2026-09-25, verified with `codex doctor`, which --
	// unlike --help -- does load and validate the invocation config:
	//   - approval_policy and sandbox_mode are still live, TYPED keys. A bogus
	//     value for either fails config load (exit 1) while an unknown key is
	//     accepted silently (exit 0), so the four values emitted below are
	//     genuinely being read rather than ignored.
	//   - all four values this function emits still load clean: approval_policy
	//     on-request and never, sandbox_mode workspace-write and
	//     danger-full-access.
	//   - sandbox_mode still BEHAVES as named, measured with `codex sandbox`:
	//     read-only denied a write inside the cwd, workspace-write allowed that
	//     write and denied one outside the workspace, and danger-full-access
	//     allowed the outside write.
	//   - the approval_policy enum did narrow in 0.157.0 -- `untrusted` is now
	//     rejected, where 0.155.1 accepted it -- but muxterm emits only
	//     on-request and never, both of which still load. A real CLI change,
	//     not a change to this translation.
	//
	// Re-verified independently 2026-09-26 against the same codex-cli 0.157.0.
	// Every measurement above reproduced exactly. One trap is worth writing
	// down, because the obvious way to re-run the sandbox_mode check gets it
	// wrong: `/tmp` is itself a WRITABLE ROOT under workspace-write, so an
	// "outside the workspace" control built with `mktemp -d` is allowed, and
	// workspace-write looks indistinguishable from danger-full-access. Use an
	// outside path that is neither under the cwd nor under /tmp (a directory in
	// $HOME works). With that control: read-only denied both writes,
	// workspace-write allowed the in-cwd write and DENIED the outside one, and
	// danger-full-access allowed both.
	//
	// Claude's pin is UNCHANGED and was not re-verified here: claude is not
	// installed on this host, and a version this function has never run against
	// is refused rather than guessed.
	var flags []string
	switch harness {
	case HarnessCodex:
		if !slices.Contains(codexApprovalVerified, version) {
			return nil, approvalVersionError(harness, version)
		}
		flags = []string{"-c", "approval_policy=on-request", "-c", "sandbox_mode=workspace-write"}
		if policy == "never" {
			flags = []string{"-c", "approval_policy=never", "-c", "sandbox_mode=danger-full-access"}
		}
	case HarnessClaude:
		if version != "2.1.280 (Claude Code)" {
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
	if wrapped {
		result := append([]string{argv[0], argv[1]}, flags...)
		return append(result, argv[2:]...), nil
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
