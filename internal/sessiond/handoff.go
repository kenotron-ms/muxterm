//go:build unix

package sessiond

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"sort"
	"syscall"
)

// HandoffPayload is the JSON envelope written by the old sessiond and read by
// the new sessiond during a live-upgrade state transfer. It carries a complete
// snapshot of the Registry plus enough metadata to reconstruct every pane.
type HandoffPayload struct {
	NextWSID   int       `json:"next_ws_id"`
	Workspaces []WSState `json:"workspaces"`
}

// WSState is one workspace's snapshot inside a HandoffPayload.
type WSState struct {
	ID         string            `json:"id"`
	Name       string            `json:"name"`
	ClientRef  string            `json:"client_ref"`
	NextPaneID int               `json:"next_pane_id"`
	Layouts    map[string]string `json:"layouts"`
	Panes      []PaneState       `json:"panes"`
}

// PaneState is one pane's snapshot inside a WSState.
// FDIndex is the index into the SCM_RIGHTS FD array received over the Unix
// socket; -1 means this pane has no PTY (browser pane).
// Argv is the resolved command slice used to start the pane's process. It is
// populated by crash-recovery snapshots (writeCrashSnapshot) and ignored by
// live-upgrade handoffs where the PTY FD is transferred directly.
type PaneState struct {
	LocalID      int               `json:"local_id"`
	Title        string            `json:"title"`
	SurfaceKind  string            `json:"surface_kind"`
	Cols         int               `json:"cols"`
	Rows         int               `json:"rows"`
	PID          int               `json:"pid"`
	FDIndex      int               `json:"fd_index"` // -1 for browser panes
	Argv         []string          `json:"argv,omitempty"`
	Dir          string            `json:"dir,omitempty"`
	Scrollback   []byte            `json:"scrollback,omitempty"`
	SeqTotal     uint64            `json:"seq_total,omitempty"`
	BrowserPort  int               `json:"browser_port,omitempty"`
	BrowserPath  string            `json:"browser_path,omitempty"`
	ProxyHeaders map[string]string `json:"proxy_headers,omitempty"`
}

// HandleHandoff is called by the old sessiond when it receives a TypeHandoff
// message from the new sessiond. It snapshots all registry state and PTY FDs,
// sends them to the new sessiond over handoffSocket, then calls os.Exit(0).
//
// This function must be called in its own goroutine; it never returns normally.
func (s *Server) HandleHandoff(handoffSocket string) {
	if handoffSocket == "" {
		log.Printf("sessiond: handoff: empty handoff socket path")
		return
	}

	// Snapshot the registry under its lock. We collect pane state (including
	// scrollback and PTY FDs) while holding the mutex so no concurrent
	// create-pane or close-pane can race with us.
	s.reg.mu.Lock()
	payload := HandoffPayload{
		NextWSID: s.reg.nextWSID,
	}
	var fds []int

	// Iterate workspaces in deterministic order so FDIndex lines up reliably.
	wsIDs := make([]string, 0, len(s.reg.workspaces))
	for id := range s.reg.workspaces {
		wsIDs = append(wsIDs, id)
	}
	sort.Strings(wsIDs)

	fdIndex := 0
	for _, wsID := range wsIDs {
		ws := s.reg.workspaces[wsID]
		wss := WSState{
			ID:         ws.ID,
			Name:       ws.Name,
			ClientRef:  ws.ClientRef,
			NextPaneID: ws.nextPaneID,
			Layouts:    ws.Layouts,
		}

		// Iterate panes in deterministic order.
		paneIDs := make([]int, 0, len(ws.Panes))
		for id := range ws.Panes {
			paneIDs = append(paneIDs, id)
		}
		sort.Ints(paneIDs)

		for _, pid := range paneIDs {
			p := ws.Panes[pid]

			// Snapshot the pane's mutable fields under the pane's own lock.
			p.mu.Lock()
			cols, rows, title := p.cols, p.rows, p.Title
			p.mu.Unlock()

			ps := PaneState{
				LocalID:      p.LocalID,
				Title:        title,
				SurfaceKind:  p.SurfaceKind,
				Cols:         cols,
				Rows:         rows,
				Argv:         p.argv,
				BrowserPort:  p.BrowserPort,
				BrowserPath:  p.BrowserPath,
				ProxyHeaders: p.ProxyHeaders,
				FDIndex:      -1,
			}

			if p.SurfaceKind != "browser" && p.ptmx != nil {
				// Snapshot scrollback and sequence counter.
				ps.Scrollback = p.Replay()
				ps.SeqTotal = p.Seq()

				// Capture the PTY master FD for SCM_RIGHTS transfer.
				if fd, err := p.GetPtmxFD(); err == nil {
					ps.FDIndex = fdIndex
					fds = append(fds, fd)
					fdIndex++
				} else {
					log.Printf("sessiond: handoff: pane %d GetPtmxFD: %v", p.LocalID, err)
				}

				// Capture the PID so the new sessiond can reap the child.
				if p.cmd != nil && p.cmd.Process != nil {
					ps.PID = p.cmd.Process.Pid
				}
			}

			wss.Panes = append(wss.Panes, ps)
		}
		payload.Workspaces = append(payload.Workspaces, wss)
	}
	s.reg.mu.Unlock()

	// Connect to the new sessiond's handoff socket.
	conn, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: handoffSocket, Net: "unix"})
	if err != nil {
		log.Printf("sessiond: handoff: dial %s: %v", handoffSocket, err)
		return
	}
	defer conn.Close()

	// Marshal payload and write with a 4-byte big-endian length prefix.
	jsonData, err := json.Marshal(payload)
	if err != nil {
		log.Printf("sessiond: handoff: marshal: %v", err)
		return
	}
	var lenBuf [4]byte
	binary.BigEndian.PutUint32(lenBuf[:], uint32(len(jsonData)))
	if _, err := conn.Write(lenBuf[:]); err != nil {
		log.Printf("sessiond: handoff: write length: %v", err)
		return
	}
	if _, err := conn.Write(jsonData); err != nil {
		log.Printf("sessiond: handoff: write JSON: %v", err)
		return
	}

	// Transfer PTY FDs via SCM_RIGHTS.
	if len(fds) > 0 {
		rights := syscall.UnixRights(fds...)
		if _, _, err := conn.WriteMsgUnix(nil, rights, nil); err != nil {
			log.Printf("sessiond: handoff: WriteMsgUnix: %v", err)
			return
		}
	}

	log.Printf("sessiond: handoff complete — transferred %d workspaces, %d PTY FDs; exiting", len(payload.Workspaces), len(fds))
	conn.Close()
	os.Exit(0)
}

// ReceiveHandoffConn reads a HandoffPayload (JSON + PTY FDs) from conn and
// returns a fully reconstructed Server ready to call ListenAndServe on.
// The caller owns creating and accepting from the handoff listener; this
// function only reads from the already-accepted *net.UnixConn.
func ReceiveHandoffConn(conn *net.UnixConn, canonicalSocket string) (*Server, error) {
	// Read 4-byte big-endian length prefix.
	var lenBuf [4]byte
	if _, err := io.ReadFull(conn, lenBuf[:]); err != nil {
		return nil, fmt.Errorf("read length prefix: %w", err)
	}
	jsonLen := binary.BigEndian.Uint32(lenBuf[:])
	if jsonLen == 0 || jsonLen > 64*1024*1024 {
		return nil, fmt.Errorf("implausible payload length %d", jsonLen)
	}

	// Read JSON payload.
	jsonData := make([]byte, jsonLen)
	if _, err := io.ReadFull(conn, jsonData); err != nil {
		return nil, fmt.Errorf("read JSON payload: %w", err)
	}

	var payload HandoffPayload
	if err := json.Unmarshal(jsonData, &payload); err != nil {
		return nil, fmt.Errorf("unmarshal payload: %w", err)
	}

	// Receive PTY FDs via SCM_RIGHTS (a single control message).
	// 4096 bytes is enough for ~250 FDs; far more than any realistic session count.
	var receivedFDs []int
	oob := make([]byte, 4096)
	_, oobn, _, _, err := conn.ReadMsgUnix(nil, oob)
	if err == nil && oobn > 0 {
		msgs, parseErr := syscall.ParseSocketControlMessage(oob[:oobn])
		if parseErr == nil {
			for _, m := range msgs {
				fdList, rightsErr := syscall.ParseUnixRights(&m)
				if rightsErr == nil {
					receivedFDs = append(receivedFDs, fdList...)
				}
			}
		}
	}

	// Construct a fresh Server with the canonical socket path.
	srv, err := NewServer(canonicalSocket)
	if err != nil {
		return nil, fmt.Errorf("NewServer: %w", err)
	}

	// Restore registry state directly (same package — unexported fields accessible).
	srv.reg.mu.Lock()
	srv.reg.nextWSID = payload.NextWSID
	for _, wss := range payload.Workspaces {
		layouts := wss.Layouts
		if layouts == nil {
			layouts = make(map[string]string)
		}
		ws := &Workspace{
			ID:         wss.ID,
			Name:       wss.Name,
			ClientRef:  wss.ClientRef,
			Panes:      make(map[int]*Pane),
			Layouts:    layouts,
			nextPaneID: wss.NextPaneID,
		}
		srv.reg.workspaces[wss.ID] = ws

		wsID := wss.ID // capture for closures
		for _, ps := range wss.Panes {
			var p *Pane
			switch ps.SurfaceKind {
			case "browser":
				p = NewBrowserPane(ps.LocalID, ps.BrowserPort, ps.BrowserPath, ps.ProxyHeaders)
			default:
				// Terminal pane — adopt the transferred PTY FD.
				if ps.FDIndex < 0 || ps.FDIndex >= len(receivedFDs) {
					log.Printf("sessiond: handoff: pane %d FDIndex %d out of range (have %d FDs); skipping",
						ps.LocalID, ps.FDIndex, len(receivedFDs))
					continue
				}
				rawFD := receivedFDs[ps.FDIndex]
				ptmx := os.NewFile(uintptr(rawFD), fmt.Sprintf("ptmx-pane%d", ps.LocalID))

				// Restore scrollback into a VTBuffer so get_screen works
				// after the handoff. VTBuffer.Write() processes VT sequences
				// through the emulator and reconstructs the grid state.
				buf := NewVTBuffer(ps.Cols, ps.Rows)
				if len(ps.Scrollback) > 0 {
					_, _ = buf.Write(ps.Scrollback)
				}

				onData := func(id int, data []byte) { srv.broadcastPaneData(wsID, id, data) }
				onExit := func(id int) { srv.handlePaneExit(wsID, id) }

				p = RestorePane(ptmx, ps.PID, ps.LocalID, ps.Cols, ps.Rows,
					ps.Title, ps.SurfaceKind, buf, onData, onExit)
			}
			ws.Panes[p.LocalID] = p
		}
	}
	srv.reg.mu.Unlock()

	log.Printf("sessiond: handoff received — restored %d workspaces, %d PTY FDs",
		len(payload.Workspaces), len(receivedFDs))
	return srv, nil
}
