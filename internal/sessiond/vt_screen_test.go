package sessiond

import (
	"strings"
	"testing"
)

// TestVTBufferScreenText verifies that ScreenText returns a plain-text snapshot
// of the visible screen with trailing blank rows trimmed and no ANSI escapes.
func TestVTBufferScreenText(t *testing.T) {
	b := NewVTBuffer(20, 5)
	if _, err := b.Write([]byte("hello\r\nworld\r\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}

	text := b.ScreenText()

	// Must contain no ANSI escape sequences.
	if strings.ContainsRune(text, '\x1b') {
		t.Errorf("ScreenText contains ANSI escape: %q", text)
	}

	lines := strings.Split(text, "\n")
	if len(lines) < 2 {
		t.Fatalf("ScreenText: expected ≥2 lines, got %d: %q", len(lines), text)
	}

	// First line must be "hello" (cell-grid rows may have trailing spaces).
	if got := strings.TrimSpace(lines[0]); got != "hello" {
		t.Errorf("line[0] trimmed = %q, want %q", got, "hello")
	}

	// Second line must be "world".
	if got := strings.TrimSpace(lines[1]); got != "world" {
		t.Errorf("line[1] trimmed = %q, want %q", got, "world")
	}

	// Trailing blank rows must be trimmed: no consecutive trailing newlines.
	if strings.HasSuffix(text, "\n\n") {
		t.Errorf("ScreenText has trailing blank lines: %q", text)
	}
}

// TestVTBufferCursorPos verifies that CursorPos returns 0-based row and column.
func TestVTBufferCursorPos(t *testing.T) {
	b := NewVTBuffer(20, 5)
	if _, err := b.Write([]byte("abc")); err != nil {
		t.Fatalf("Write: %v", err)
	}

	row, col := b.CursorPos()
	if row != 0 {
		t.Errorf("CursorPos row = %d, want 0", row)
	}
	if col != 3 {
		t.Errorf("CursorPos col = %d, want 3", col)
	}
}
