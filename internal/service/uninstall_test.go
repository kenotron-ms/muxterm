package service

import (
	"os"
	"path/filepath"
	"testing"
)

func TestUninstall_Linux_StopsService(t *testing.T) {
	tmp := t.TempDir()
	unitPath := filepath.Join(tmp, "muxterm.service")
	if err := os.WriteFile(unitPath, []byte("unit"), 0644); err != nil {
		t.Fatal(err)
	}
	cmd := &mockCommander{}

	err := uninstallLinux(unitPath, cmd)
	if err != nil {
		t.Fatalf("uninstallLinux() error: %v", err)
	}

	if len(cmd.commands) < 2 {
		t.Fatalf("expected at least 2 commands, got %d", len(cmd.commands))
	}

	disable := cmd.commands[0]
	if disable.Name != "systemctl" {
		t.Errorf("first command = %q, want systemctl", disable.Name)
	}
	wantDisableArgs := []string{"--user", "disable", "--now", "muxterm.service"}
	if !sliceEqual(disable.Args, wantDisableArgs) {
		t.Errorf("disable args = %v, want %v", disable.Args, wantDisableArgs)
	}

	reload := cmd.commands[1]
	if reload.Name != "systemctl" {
		t.Errorf("second command = %q, want systemctl", reload.Name)
	}
	wantReloadArgs := []string{"--user", "daemon-reload"}
	if !sliceEqual(reload.Args, wantReloadArgs) {
		t.Errorf("reload args = %v, want %v", reload.Args, wantReloadArgs)
	}
}

func TestUninstall_Linux_RemovesUnitFile(t *testing.T) {
	tmp := t.TempDir()
	unitPath := filepath.Join(tmp, "muxterm.service")
	if err := os.WriteFile(unitPath, []byte("unit"), 0644); err != nil {
		t.Fatal(err)
	}
	cmd := &mockCommander{}

	err := uninstallLinux(unitPath, cmd)
	if err != nil {
		t.Fatalf("uninstallLinux() error: %v", err)
	}

	if _, err := os.Stat(unitPath); !os.IsNotExist(err) {
		t.Error("unit file should have been removed")
	}
}

func TestUninstall_Linux_NoFileIsNotError(t *testing.T) {
	tmp := t.TempDir()
	unitPath := filepath.Join(tmp, "muxterm.service") // does not exist
	cmd := &mockCommander{}

	err := uninstallLinux(unitPath, cmd)
	if err != nil {
		t.Errorf("uninstallLinux() should not error on missing file, got: %v", err)
	}
}

func TestUninstall_Darwin_RunsLaunchctlUnload(t *testing.T) {
	tmp := t.TempDir()
	plistPath := filepath.Join(tmp, "com.muxterm.plist")
	if err := os.WriteFile(plistPath, []byte("plist"), 0644); err != nil {
		t.Fatal(err)
	}
	cmd := &mockCommander{}

	err := uninstallDarwin(plistPath, cmd)
	if err != nil {
		t.Fatalf("uninstallDarwin() error: %v", err)
	}

	if len(cmd.commands) < 1 {
		t.Fatal("expected at least 1 command")
	}

	unload := cmd.commands[0]
	if unload.Name != "launchctl" {
		t.Errorf("command = %q, want launchctl", unload.Name)
	}
	wantArgs := []string{"unload", plistPath}
	if !sliceEqual(unload.Args, wantArgs) {
		t.Errorf("args = %v, want %v", unload.Args, wantArgs)
	}
}

func TestUninstall_Darwin_RemovesPlistFile(t *testing.T) {
	tmp := t.TempDir()
	plistPath := filepath.Join(tmp, "com.muxterm.plist")
	if err := os.WriteFile(plistPath, []byte("plist"), 0644); err != nil {
		t.Fatal(err)
	}
	cmd := &mockCommander{}

	err := uninstallDarwin(plistPath, cmd)
	if err != nil {
		t.Fatalf("uninstallDarwin() error: %v", err)
	}

	if _, err := os.Stat(plistPath); !os.IsNotExist(err) {
		t.Error("plist file should have been removed")
	}
}
