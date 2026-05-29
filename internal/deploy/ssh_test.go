package deploy

import (
	"fmt"
	"strings"
	"testing"
)

// mockRunner captures commands for verification.
type mockRunner struct {
	commands []struct {
		name string
		args []string
	}
	err error // if set, Run returns this error
}

func (m *mockRunner) Run(name string, args ...string) ([]byte, error) {
	m.commands = append(m.commands, struct {
		name string
		args []string
	}{name, args})
	if m.err != nil {
		return nil, m.err
	}
	return nil, nil
}

func TestDeploy_SCPsBinary(t *testing.T) {
	mock := &mockRunner{}
	d := &Deployer{runner: mock, binaryPath: "/usr/local/bin/muxterm"}

	if err := d.Deploy("root@example.com"); err != nil {
		t.Fatalf("Deploy() error: %v", err)
	}

	// First command should be scp
	if len(mock.commands) == 0 {
		t.Fatal("no commands executed")
	}
	cmd := mock.commands[0]
	if cmd.name != "scp" {
		t.Fatalf("first command = %q, want scp", cmd.name)
	}
	args := strings.Join(cmd.args, " ")
	if !strings.Contains(args, "/usr/local/bin/muxterm") {
		t.Errorf("scp args missing binary path: %v", cmd.args)
	}
	if !strings.Contains(args, "root@example.com:/usr/local/bin/muxterm") {
		t.Errorf("scp args missing target: %v", cmd.args)
	}
}

func TestDeploy_CreatesSystemdUnit(t *testing.T) {
	mock := &mockRunner{}
	d := &Deployer{runner: mock, binaryPath: "/usr/local/bin/muxterm"}

	if err := d.Deploy("root@example.com"); err != nil {
		t.Fatalf("Deploy() error: %v", err)
	}

	found := false
	for _, cmd := range mock.commands {
		if cmd.name == "ssh" {
			args := strings.Join(cmd.args, " ")
			if strings.Contains(args, "muxterm.service") && strings.Contains(args, "/etc/systemd/system/") {
				found = true
				break
			}
		}
	}
	if !found {
		t.Error("no ssh command writes muxterm.service to /etc/systemd/system/")
	}
}

func TestDeploy_StartsService(t *testing.T) {
	mock := &mockRunner{}
	d := &Deployer{runner: mock, binaryPath: "/usr/local/bin/muxterm"}

	if err := d.Deploy("root@example.com"); err != nil {
		t.Fatalf("Deploy() error: %v", err)
	}

	found := false
	for _, cmd := range mock.commands {
		if cmd.name == "ssh" {
			args := strings.Join(cmd.args, " ")
			if strings.Contains(args, "systemctl") && strings.Contains(args, "enable") {
				found = true
				break
			}
		}
	}
	if !found {
		t.Error("no ssh command with systemctl enable found")
	}
}

func TestDeploy_SCPFailure(t *testing.T) {
	mock := &mockRunner{err: fmt.Errorf("connection refused")}
	d := &Deployer{runner: mock, binaryPath: "/usr/local/bin/muxterm"}

	err := d.Deploy("root@example.com")
	if err == nil {
		t.Fatal("Deploy() should fail when scp fails")
	}
	if !strings.Contains(err.Error(), "copy binary") {
		t.Errorf("error = %q, want it to contain 'copy binary'", err.Error())
	}
}

func TestSystemdUnit_ContainsSecret(t *testing.T) {
	secret := "abc123deadbeef"
	addr := "0.0.0.0:8080"
	unit := systemdUnit(secret, addr)

	if !strings.Contains(unit, secret) {
		t.Errorf("unit does not contain secret %q", secret)
	}
	if !strings.Contains(unit, addr) {
		t.Errorf("unit does not contain addr %q", addr)
	}
	if !strings.Contains(unit, "muxterm serve") {
		t.Errorf("unit does not contain 'muxterm serve'")
	}
}
