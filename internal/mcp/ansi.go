package mcp

import "regexp"

// ansiOSC matches OSC (Operating System Command) sequences such as those used
// by terminal titles and shell integration (e.g. OSC 133 prompt markers).
// Pattern: ESC ] <text> (BEL | ESC \)
var ansiOSC = regexp.MustCompile(`\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)`)

// ansiCSI matches CSI (Control Sequence Introducer) sequences, covering ANSI
// color codes, cursor movement, and screen-clear commands.
// Pattern: ESC [ <params> <intermediates> <final>
var ansiCSI = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]`)

// ansiOther matches remaining single-character or two-character escape
// sequences that are not covered by OSC or CSI.
var ansiOther = regexp.MustCompile(`\x1b[()#][0-9A-Za-z]|\x1b[=>78Mc]`)

// StripANSI removes common ANSI/VT escape sequences from s and returns the
// result. It handles OSC title/shell-integration sequences, CSI
// color/cursor/clear sequences, and stray single-character escapes.
//
// The function is intentionally simple — it is not a full terminal emulator.
// Strip order: OSC → CSI → other.
func StripANSI(s string) string {
	s = ansiOSC.ReplaceAllString(s, "")
	s = ansiCSI.ReplaceAllString(s, "")
	s = ansiOther.ReplaceAllString(s, "")
	return s
}
