package mcp

import "testing"

// TestStripANSI verifies that StripANSI removes ANSI/VT escape sequences.
// The test names ("red", "plain", "cleared", "abc", "done") describe the
// primary scenario being exercised.
func TestStripANSI(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{
			name:  "red",
			input: "\x1b[31mred\x1b[0m",
			want:  "red",
		},
		{
			name:  "plain",
			input: "plain text",
			want:  "plain text",
		},
		{
			name:  "cleared",
			input: "\x1b[2J",
			want:  "",
		},
		{
			name:  "abc",
			input: "abc",
			want:  "abc",
		},
		{
			name:  "done",
			input: "\x1b]133;D;0\x07done",
			want:  "done",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := StripANSI(tt.input)
			if got != tt.want {
				t.Errorf("StripANSI(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}
