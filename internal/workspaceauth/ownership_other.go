//go:build !linux

package workspaceauth

import "io/fs"

// Ownership cannot be determined portably on this platform. Mode checks still
// apply; platforms that expose a reliable UID should add a platform file.
func ownedByCurrentUser(fs.FileInfo) bool { return true }
