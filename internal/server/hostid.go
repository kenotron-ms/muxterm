package server

import (
	"errors"
	"fmt"
	"strings"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// Namespaced identifiers. One qualifier, one separator, six rules:
//
//	<HostRef.ID> "/" <daemon-local id>   remote,  e.g. "ssh:boxb/w1"
//	<daemon-local id>                    local,   e.g. "w1"
//	<HostRef.ID> "/"                     host selector (create-workspace only)
//
// The qualifier is always transport.HostRef.ID, never DisplayName: display
// names are mutable labels, and a workspace reference that breaks when someone
// relabels a host is a bug that only shows up in production.
//
// These rules are mirrored byte-for-byte in web/src/lib/host-ref.ts. Change one
// side and you must change the other.

// hostSep separates the host qualifier from the daemon-local id. It is a
// single byte on purpose: splitID has to be cheap and unambiguous, and rule P3
// (below) is what buys the second property.
const hostSep = "/"

// nsID formats a namespaced id (rule P1).
//
// The empty host is the local daemon and returns local UNCHANGED (rule P5).
// That is not an optimization, it is the zero-remote guarantee stated as an
// algebraic law: a browser with no remotes configured sees exactly the ids it
// sees today, because every stamp site in this package is this function.
func nsID(host, local string) string {
	if host == "" {
		return local
	}
	return host + hostSep + local
}

// splitID parses a namespaced id (rule P2): the FIRST separator wins, and an
// id carrying no separator is local -> ("", id).
//
// Rule P3 (a HostRef.ID must not contain "/") is what makes this total and
// unambiguous, and therefore what makes the round trip hold:
// splitID(nsID(h, l)) == (h, l) for every admissible h and every l (rule P4).
//
// An empty local part is the host selector (rule P6) -- legal only on
// create-workspace. splitID reports it faithfully and leaves that judgement to
// the caller, which is the only place that knows the message type.
func splitID(id string) (host, local string) {
	i := strings.Index(id, hostSep)
	if i < 0 {
		return "", id
	}
	return id[:i], id[i+1:]
}

// validHostID enforces rule P3 at registry admission (RemoteRegistry.Add).
//
// This is the single admission check that keeps splitID total: allow one "/"
// into a host id and every namespaced workspace id becomes ambiguous, silently
// and only for the host that did it. Reject it at the door instead.
func validHostID(id string) error {
	if id == "" {
		return errors.New("host id must not be empty")
	}
	if strings.Contains(id, hostSep) {
		return fmt.Errorf("host id %q must not contain %q: it would make every namespaced workspace id for that host ambiguous", id, hostSep)
	}
	return nil
}

// stampWorkspaces returns workspaces with every WorkspaceID qualified by host.
// It copies rather than mutating in place: the slice it is handed came off a
// daemon reply that the caller may still be holding, and the merge cache keeps
// its result indefinitely.
//
// For the local daemon (host "") the copy is field-for-field identical to the
// input, by rule P5.
func stampWorkspaces(host string, workspaces []sessiond.WorkspaceInfo) []sessiond.WorkspaceInfo {
	if len(workspaces) == 0 {
		return nil
	}
	out := make([]sessiond.WorkspaceInfo, len(workspaces))
	copy(out, workspaces)
	for i := range out {
		out[i].WorkspaceID = nsID(host, out[i].WorkspaceID)
	}
	return out
}

// stampSessions returns sessions with every row's WorkspaceID qualified by
// host. PaneID is deliberately untouched: it is workspace-local and qualified
// by the row's own workspaceId (design A.3).
func stampSessions(host string, sessions []sessiond.SessionState) []sessiond.SessionState {
	if len(sessions) == 0 {
		return nil
	}
	out := make([]sessiond.SessionState, len(sessions))
	copy(out, sessions)
	for i := range out {
		out[i].WorkspaceID = nsID(host, out[i].WorkspaceID)
	}
	return out
}
