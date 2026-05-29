package tmux

import "testing"

func TestParseTmuxVersion(t *testing.T) {
	tests := []struct {
		name      string
		input     string
		wantMajor int
		wantMinor int
		wantErr   bool
	}{
		{name: "3.5a", input: "tmux 3.5a", wantMajor: 3, wantMinor: 5},
		{name: "3.2", input: "tmux 3.2", wantMajor: 3, wantMinor: 2},
		{name: "3.0", input: "tmux 3.0", wantMajor: 3, wantMinor: 0},
		{name: "2.9a", input: "tmux 2.9a", wantMajor: 2, wantMinor: 9},
		{name: "next-3.5 error", input: "tmux next-3.5", wantErr: true},
		{name: "not tmux error", input: "not tmux", wantErr: true},
		{name: "empty error", input: "", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			major, minor, err := parseTmuxVersion(tt.input)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error, got major=%d minor=%d", major, minor)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if major != tt.wantMajor {
				t.Errorf("major: got %d, want %d", major, tt.wantMajor)
			}
			if minor != tt.wantMinor {
				t.Errorf("minor: got %d, want %d", minor, tt.wantMinor)
			}
		})
	}
}

func TestCheckVersion_Minimum32(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		wantErr bool
	}{
		{name: "3.5a ok", input: "tmux 3.5a", wantErr: false},
		{name: "3.2 ok", input: "tmux 3.2", wantErr: false},
		{name: "3.1 error", input: "tmux 3.1", wantErr: true},
		{name: "2.9a error", input: "tmux 2.9a", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := checkVersion(tt.input)
			if tt.wantErr && err == nil {
				t.Fatal("expected error, got nil")
			}
			if !tt.wantErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

func TestParseSessionList(t *testing.T) {
	input := "dev:3:1700000000\ntest:1:1700000001\n"
	got := parseSessionList(input)

	if len(got) != 2 {
		t.Fatalf("expected 2 sessions, got %d: %v", len(got), got)
	}
	if got[0] != "dev" {
		t.Errorf("session[0]: got %q, want %q", got[0], "dev")
	}
	if got[1] != "test" {
		t.Errorf("session[1]: got %q, want %q", got[1], "test")
	}
}

func TestParseSessionList_Empty(t *testing.T) {
	got := parseSessionList("")
	if got != nil {
		t.Errorf("expected nil, got %v", got)
	}

	got = parseSessionList("  \n  ")
	if got != nil {
		t.Errorf("expected nil for whitespace-only input, got %v", got)
	}
}

// Verify constants exist with expected values.
func TestConstants(t *testing.T) {
	if minMajor != 3 {
		t.Errorf("minMajor: got %d, want 3", minMajor)
	}
	if minMinor != 2 {
		t.Errorf("minMinor: got %d, want 2", minMinor)
	}
	if defaultSession != "muxterm" {
		t.Errorf("defaultSession: got %q, want %q", defaultSession, "muxterm")
	}
}
