//go:build linux

package server

import "golang.org/x/sys/unix"

// uploadExchangeSupported reports whether this platform exposes an atomic
// directory-entry exchange. Only that primitive can publish a confirmed
// Replace without a window in which the target name does not exist, so the
// upload commit path declines Replace where it is false.
const uploadExchangeSupported = true

// exchangeUploadEntries atomically swaps the entries `a` and `b` in the
// directory referenced by dirfd. Linux does this with renameat2's
// RENAME_EXCHANGE, which is Linux-only: it is declared here, behind a build
// tag, because golang.org/x/sys/unix does not define unix.Renameat2 or
// unix.RENAME_EXCHANGE on any other GOOS and referencing them unguarded breaks
// the darwin build of this package (and therefore the release).
func exchangeUploadEntries(dirfd int, a, b string) error {
	return unix.Renameat2(dirfd, a, dirfd, b, unix.RENAME_EXCHANGE)
}
