package service

import (
	"os"
	"path/filepath"
	"testing"
)

func TestUninstall_Linux_StopsService(t *testing.T) {
	tmp := t.TempDir()
	unitPath := filepath.Join(tmp, "muxterm.service")
	sessiondPath := filepath.Join(tmp, "muxterm-sessiond.service")
	if err := os.WriteFile(unitPath, []byte("unit"), 0644); err != nil {
		t.Fatal(err)
	}
	cmd := &mockCommander{}

	err := uninstallLinux(unitPath, sessiondPath, cmd)
	if err != nil {
		t.Fatalf("uninstallLinux() error: %v", err)
	}

	if len(cmd.commands) != 3 {
		t.Fatalf("expected 3 commands, got %d", len(cmd.commands))
	}

	disableWeb := cmd.commands[0]
	if disableWeb.Name != "systemctl" || !sliceEqual(disableWeb.Args, []string{"--user", "disable", "--now", "muxterm.service"}) {
		t.Errorf("command[0] = %q %v, want systemctl [--user disable --now muxterm.service]", disableWeb.Name, disableWeb.Args)
	}

	disableSessiond := cmd.commands[1]
	if disableSessiond.Name != "systemctl" || !sliceEqual(disableSessiond.Args, []string{"--user", "disable", "--now", "muxterm-sessiond.service"}) {
		t.Errorf("command[1] = %q %v, want systemctl [--user disable --now muxterm-sessiond.service]", disableSessiond.Name, disableSessiond.Args)
	}

	reload := cmd.commands[2]
	if reload.Name != "systemctl" || !sliceEqual(reload.Args, []string{"--user", "daemon-reload"}) {
		t.Errorf("command[2] = %q %v, want systemctl [--user daemon-reload]", reload.Name, reload.Args)
	}
}

func TestUninstall_Linux_RemovesUnitFile(t *testing.T) {
	tmp := t.TempDir()
	unitPath := filepath.Join(tmp, "muxterm.service")
	if err := os.WriteFile(unitPath, []byte("unit"), 0644); err != nil {
		t.Fatal(err)
	}
	cmd := &mockCommander{}

	err := uninstallLinux(unitPath, filepath.Join(tmp, "muxterm-sessiond.service"), cmd)
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

	err := uninstallLinux(unitPath, filepath.Join(tmp, "muxterm-sessiond.service"), cmd)
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
