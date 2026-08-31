//go:build linux

package sessiond

import "golang.org/x/sys/unix"

// tcgetsRequest is the ioctl request number for "get termios attributes" on
// this platform. Linux names it TCGETS; see termios_darwin.go for the BSD-
// style equivalent (TIOCGETA), which is a different name AND a different
// numeric value -- golang.org/x/sys/unix does not define TCGETS at all for
// GOOS=darwin, so this constant cannot be shared directly across platforms.
const tcgetsRequest = unix.TCGETS
