//go:build darwin

package sessiond

import "golang.org/x/sys/unix"

// tcgetsRequest is the ioctl request number for "get termios attributes" on
// this platform. Darwin (BSD-derived ioctl numbering) names it TIOCGETA,
// distinct from Linux's TCGETS both in name and numeric value; see
// termios_linux.go for that side.
const tcgetsRequest = unix.TIOCGETA
