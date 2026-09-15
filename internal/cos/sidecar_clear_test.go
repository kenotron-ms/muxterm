package cos

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// TestSidecarClearContract runs sidecar/clear_test.py.
//
// The sidecar is python, and the single most important property of the whole
// clear feature lives inside it: clearing the conversation must replace the
// LIVE amplifier context, not just prune the transcript on disk. A prune that
// reaches only the disk is undone by the next turn's save, and in the meantime
// the human is looking at an empty conversation that the chief of staff can
// still quote back to them.
//
// That property cannot be tested from Go -- it is a call into an amplifier
// session object -- so it is tested in python, and this shells out to it so
// that `make test` (go test ./...) is still the one command that runs
// everything. The python file is also runnable on its own:
//
//	python3 internal/cos/sidecar/clear_test.py
func TestSidecarClearContract(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 not available; the chief-of-staff sidecar needs an interpreter to run at all")
	}

	script, err := filepath.Abs(filepath.Join("sidecar", "clear_test.py"))
	if err != nil {
		t.Fatalf("resolve clear_test.py: %v", err)
	}
	if _, err := os.Stat(script); err != nil {
		t.Fatalf("sidecar clear test missing: %v", err)
	}

	// Generous, because it is the whole file: each case is milliseconds, but a
	// cold interpreter on a loaded machine is not.
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, python, script)
	// A temp HOME and XDG_RUNTIME_DIR keep the test off this machine's real
	// muxterm state: the sidecar reads the live lane roster out of
	// $XDG_RUNTIME_DIR, and a test must never read -- let alone write -- the
	// roster a running daemon owns. (clear_test.py points XDG_RUNTIME_DIR at
	// its own temp dir per case as well; this is the belt to that's braces.)
	tmp := t.TempDir()
	cmd.Env = append(os.Environ(),
		"HOME="+tmp,
		"XDG_RUNTIME_DIR="+filepath.Join(tmp, "run"),
		"PYTHONDONTWRITEBYTECODE=1",
	)
	if err := os.MkdirAll(filepath.Join(tmp, "run"), 0o700); err != nil {
		t.Fatalf("make runtime dir: %v", err)
	}

	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("sidecar clear contract failed: %v\n%s", err, out)
	}
	t.Logf("sidecar/clear_test.py:\n%s", out)
}
