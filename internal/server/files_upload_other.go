//go:build !linux

package server

import "errors"

// uploadExchangeSupported is false off Linux: there is no portable atomic
// directory-entry exchange. Uploads still work (new files and Keep both are
// linkat-based and portable); a confirmed Replace reports `retry` rather than
// falling back to a rename that would briefly unlink the user's existing file.
//
// Darwin has renameatx_np(RENAME_SWAP), which could back this later; wiring it
// up needs a real macOS host to verify against and is deliberately out of scope
// for the portability fix.
const uploadExchangeSupported = false

var errUploadExchangeUnsupported = errors.New("atomic directory-entry exchange is unsupported on this platform")

// exchangeUploadEntries is unreachable while uploadExchangeSupported is false;
// it exists so the commit path compiles on every GOOS.
func exchangeUploadEntries(_ int, _, _ string) error {
	return errUploadExchangeUnsupported
}
