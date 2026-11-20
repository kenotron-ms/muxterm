//go:build darwin && cgo

package loginbackend

/*
#cgo LDFLAGS: -framework Foundation -framework OpenDirectory
#include <stdlib.h>
#include <string.h>

int muxtermVerifyLocalPassword(const char *username, const char *password);
*/
import "C"

import (
	"errors"
	"fmt"
	"os/user"
	"strings"
	"unsafe"
)

// OpenDirectoryBackend checks the password of the local macOS account that
// owns this muxterm process. It never accepts a username from the request.
type OpenDirectoryBackend struct {
	username string
}

func New() (LoginBackend, error) {
	u, err := user.Current()
	if err != nil {
		return nil, fmt.Errorf("opendirectory: determine current user: %w", err)
	}
	if u.Username == "" {
		return nil, errors.New("opendirectory: current username is empty")
	}
	return &OpenDirectoryBackend{username: u.Username}, nil
}

func (b *OpenDirectoryBackend) Authenticate(password string) error {
	if strings.IndexByte(password, 0) >= 0 {
		return errors.New("opendirectory: password contains a NUL byte")
	}
	username := C.CString(b.username)
	defer C.free(unsafe.Pointer(username))
	secret := C.CString(password)
	defer func() {
		C.memset(unsafe.Pointer(secret), 0, C.size_t(len(password)))
		C.free(unsafe.Pointer(secret))
	}()

	if C.muxtermVerifyLocalPassword(username, secret) != 1 {
		return errors.New("opendirectory: local account authentication failed")
	}
	return nil
}
