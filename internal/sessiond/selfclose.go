package sessiond

import "fmt"

// Self-close refusal: a connection may not close the workspace or the pane its
// own client process is running inside.
//
// WHY THE DAEMON AND NOT ONLY THE TOOL LIST. internal/mcp/run.go already
// withholds close_workspace and close_pane from any MCP server running inside a
// pane, and that is the layer that stops the honest mistake -- a lane told to
// "tear down what you started", reading its own workspace as something it
// started. This layer stops everything that gets past that one: a lane whose
// harness was configured with the tools by hand, a bundle that reaches the
// daemon another way, a CLI invocation from inside the pane, and the plain
// unforeseen. The tool list is advisory (it keys off an environment variable
// any process can set); this is not.
//
// The occupancy fact comes from the kernel. SO_PEERCRED gives the pid on the
// other end of the socket -- filled in by the kernel at connect time, so it
// cannot be spoofed by the caller and cannot go stale like a pidfile -- and an
// ancestor walk from that pid to a pane's root process is the same join the
// home view already uses to place a session's row (see resolvePaneForPID).
//
// WHO IS UNAFFECTED, and why that is not luck. The check asks one question --
// "is the calling process inside the thing it is asking to destroy?" -- so
// every legitimate closer answers no by construction:
//
//	the browser UI   its close travels browser -> `muxterm serve` -> daemon,
//	                 and serve is a service process, not a pane process
//	chief of staff   a sidecar of serve; it closes workspaces it does not
//	                 occupy, which is exactly the management action it exists
//	                 to perform
//	a lane           inside a pane, and answers yes only for its OWN workspace
//	                 or pane -- it can still close somebody else's as far as
//	                 this check is concerned, which is what the withheld tool
//	                 list above is for
//
// LIMITS, stated rather than papered over. peerPID is Linux-only (see
// peercred_other.go), and a connection arriving over the SSH transport reports
// the forwarder's pid. In both cases occupancy cannot be established and the
// close is ALLOWED -- this refuses what it can prove, and proves nothing about
// a peer it cannot inspect. The tool-list layer is unaffected by either.

// CodeSelfClose is the TypeError code for a refused self-close. ADDITIVE,
// post-v1: it introduces no new message type and no new field, only a new
// value for the existing Message.Code, which clients already treat as an
// opaque category string.
const CodeSelfClose = "self-close-refused"

// CloseFailureSelfOccupied is the close-outcome failureCode for the same
// refusal on the close-intent path. It sits beside the other CloseFailure*
// categories in close.go and is stable and user-safe like them.
const CloseFailureSelfOccupied = "self-occupied-close-target"

// occupiedPane returns the pane this connection's client process is running
// inside, if that can be established.
//
// Resolved per call rather than cached at connect time. The peer pid is fixed
// for the life of the connection, but which pane owns it is not: panes are
// created and closed underneath a long-lived connection, and a cached answer
// would eventually be a wrong one. Close requests are rare and human-paced, so
// one registry snapshot walk each is not a cost worth optimising away.
func (c *conn) occupiedPane() (paneRef, bool) {
	if c.peerPid <= 0 {
		return paneRef{}, false
	}
	return resolvePaneForPID(c.peerPid, paneOwners(c.srv.reg.snapshotView()))
}

// refuseSelfCloseWorkspace reports whether closing workspaceID would destroy
// the caller, and if so the message explaining it.
func (c *conn) refuseSelfCloseWorkspace(workspaceID string) (string, bool) {
	if workspaceID == "" {
		return "", false
	}
	ref, ok := c.occupiedPane()
	if !ok || ref.workspaceID != workspaceID {
		return "", false
	}
	return fmt.Sprintf(
		"refusing to close workspace %s: this session is running in pane %d of it, "+
			"and a session cannot close the workspace it occupies. Closing it would "+
			"kill this session mid-sentence and take its report with it. "+
			"Report your result and stop instead -- leave the workspace standing for the human.",
		workspaceID, ref.paneID,
	), true
}

// refuseSelfClosePane reports whether closing paneID in workspaceID would
// destroy the caller, and if so the message explaining it.
func (c *conn) refuseSelfClosePane(workspaceID string, paneID int) (string, bool) {
	if workspaceID == "" || paneID <= 0 {
		return "", false
	}
	ref, ok := c.occupiedPane()
	if !ok || ref.workspaceID != workspaceID || ref.paneID != paneID {
		return "", false
	}
	return fmt.Sprintf(
		"refusing to close pane %d: this session is running in it, and a session "+
			"cannot close the pane it occupies. Closing it would kill this session "+
			"mid-sentence and take its report with it. "+
			"Report your result and stop instead -- leave the pane standing for the human.",
		paneID,
	), true
}

// refuseSelfCloseTarget applies the right check for a close-intent target and
// returns the refusal message when the caller occupies it.
func (c *conn) refuseSelfCloseTarget(target CloseTarget) (string, bool) {
	switch target.Kind {
	case CloseTargetPane:
		return c.refuseSelfClosePane(target.WorkspaceID, target.PaneID)
	case CloseTargetWorkspace:
		return c.refuseSelfCloseWorkspace(target.WorkspaceID)
	default:
		// An unknown kind is not a target this can reason about; CloseIntent
		// rejects it as invalid a moment later.
		return "", false
	}
}
