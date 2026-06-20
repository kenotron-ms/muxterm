package sessiond

import "testing"

// TestBrowserManagerAuthorityIDFieldName is a compile-time check that
// BrowserManager has a field named authorityID (not authority).
// This test will fail to compile if the field is absent or misnamed.
func TestBrowserManagerAuthorityIDFieldName(t *testing.T) {
	var bm BrowserManager
	// Direct field access: compile error if field is not named authorityID.
	var _ map[int]string = bm.authorityID
}

// TestIsAuthorityEmptyClientIDNeverMatches verifies that an empty clientID
// is never considered the authority, even when no authority has been set
// for the pane (empty string zero-value should not match).
func TestIsAuthorityEmptyClientIDNeverMatches(t *testing.T) {
	bm := NewBrowserManager(nil, nil)
	if bm.IsAuthority(1, "") {
		t.Fatal("empty clientID should never be considered the authority")
	}
}

// TestSetAuthorityLazyInit verifies SetAuthority works on a zero-value
// BrowserManager (nil map) without panicking. This tests lazy initialization.
func TestSetAuthorityLazyInit(t *testing.T) {
	bm := &BrowserManager{} // nil authorityID map — no NewBrowserManager
	bm.SetAuthority(1, "client-a")
	if !bm.IsAuthority(1, "client-a") {
		t.Fatal("SetAuthority on nil map should lazily initialize and succeed")
	}
}
