package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/kenotron-ms/muxterm/internal/sshconfig"
	"github.com/kenotron-ms/muxterm/internal/transport"
)

// The /api/remotes family: the six doors the browser uses to see, add, remove,
// connect, disconnect and provision the machines this process can reach.
//
//	GET    /api/remotes[?probe=1]        list every candidate, partitioned
//	POST   /api/remotes                  write an ssh config entry (does NOT connect)
//	DELETE /api/remotes/{id}             disconnect, then remove that entry
//	POST   /api/remotes/{id}/connect     probe, admit to the registry, start sessions
//	POST   /api/remotes/{id}/disconnect  drop membership and every browser's session
//	POST   /api/remotes/{id}/provision   "Install & connect"
//
// AuthMiddleware protects all six at mux registration, exactly like the config,
// AI and tunnel routes.
//
// Every route answers with the shapes in the plan's C.0-C.6 and nothing else.
// The one thing to keep in mind while reading: this file OWNS no state. The
// hosts live in RemoteRegistry (process-wide), the connections live in
// hostSession (per browser, design D5), and the ssh config lives in
// internal/sshconfig. These handlers only join those three together.
//
// {id} is a HostRef.ID such as "ssh:boxb". A colon is a legal pchar in a path
// segment and r.PathValue("id") returns it decoded; rule P3 (no "/" in a host
// id, enforced by RemoteRegistry.Add) is what guarantees it stays ONE segment.

// Probe tokens on the wire. They are the transport-neutral spelling of
// ProbeReport.State, and they are byte-identical to what the ssh transport's
// ProbeState.String() produces, so there is no mapping table here to drift out
// of step with one over there.
const (
	probePresent        = "present"
	probeLoginShellOnly = "login-shell-only"
	probeAbsent         = "absent"
	probeUnknown        = "unknown"
)

// remoteStateConnecting is what /connect and /provision report. It is
// deliberately NOT a HostState: no host is ever IN this state. It means "a
// connect has been started and the outcome will arrive on host-state", which is
// the only honest thing a handler that does not wait for the dial can say.
const remoteStateConnecting = "connecting"

const (
	// remotesDiscoverDeadline bounds one transport discovery pass. Discovery
	// is a local ssh-config parse today, so this only exists so a future
	// network-backed transport cannot hang a GET forever.
	remotesDiscoverDeadline = 5 * time.Second
	// remotesProbeDeadline bounds the WHOLE ?probe=1 fan-out, not one probe:
	// anything that has not answered by then stays "unknown", which is a
	// better answer than a slow list.
	remotesProbeDeadline = 5 * time.Second
	// remotesProbeConcurrency caps ssh processes in flight during that
	// fan-out. A config with 40 hosts must not fork 40 ssh clients at once.
	remotesProbeConcurrency = 8
	// remotesConnectDeadline bounds the ONE synchronous probe POST /connect
	// makes so the connect dialog can render its trace from real data.
	remotesConnectDeadline = 10 * time.Second
	// remotesInstallDeadline bounds "Install & connect" end to end. Deploying
	// a binary over ssh is slow and this is the number the plan fixes.
	remotesInstallDeadline = 180 * time.Second
)

// hostRow is the single row shape every response array is made of (plan C.0).
//
// Field names and omissions are the wire contract; do not add fields here
// without changing the plan first.
type hostRow struct {
	ID        string    `json:"id"`        // HostRef.ID -- the key for every other route
	Name      string    `json:"name"`      // HostRef.DisplayName -- DISPLAY ONLY, never a key
	Target    string    `json:"target"`    // the .r-sub line
	Transport string    `json:"transport"` // section heading key (ux D7)
	Managed   bool      `json:"managed"`   // written by muxterm between its markers
	State     HostState `json:"state"`
	Probe     string    `json:"probe"`
	Path      string    `json:"path,omitempty"`  // omitted when unknown/absent
	Error     string    `json:"error,omitempty"` // omitted unless state=unreachable
}

// remotesListResponse is GET /api/remotes (plan C.1). All three arrays are
// ALWAYS present and never null: the browser iterates them unconditionally.
type remotesListResponse struct {
	Connected  []hostRow `json:"connected"`
	Discovered []hostRow `json:"discovered"`
	Errors     []hostRow `json:"errors"`
}

// remoteAddResponse is POST /api/remotes (plan C.2).
type remoteAddResponse struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Target string `json:"target"`
	Action string `json:"action"`
	Backup string `json:"backup,omitempty"`
}

// remoteRemoveResponse is DELETE /api/remotes/{id} (plan C.3).
type remoteRemoveResponse struct {
	ID     string `json:"id"`
	Action string `json:"action"`
	Backup string `json:"backup,omitempty"`
}

// remoteConnectResponse is POST /{id}/connect and /{id}/provision (C.4, C.6).
type remoteConnectResponse struct {
	ID    string `json:"id"`
	State string `json:"state"`
	Probe string `json:"probe"`
	Path  string `json:"path,omitempty"`
	User  string `json:"user,omitempty"`
}

// remoteDisconnectResponse is POST /{id}/disconnect (plan C.5).
type remoteDisconnectResponse struct {
	ID    string    `json:"id"`
	State HostState `json:"state"`
}

func writeRemotesJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v) //nolint:errcheck
}

// writeRemotesError renders every 4xx/5xx body: {"error": "<verbatim text>"}.
//
// Verbatim is the point. internal/sshconfig's errors already explain the
// hand-written-Host collision and the duplicate-marker case in full sentences
// written for a human, and ssh's own "No route to host" is more useful than
// anything this package could write about it. Paraphrasing them loses
// information the user needs.
func writeRemotesError(w http.ResponseWriter, code int, err error) {
	writeRemotesJSON(w, code, map[string]any{"error": err.Error()})
}

// remotes returns the process-wide host registry (nil-safe).
func (s *Server) remotes() *RemoteRegistry { return s.hub.Remotes() }

// remoteTransport returns the configured transport, or nil when this process
// was wired without one.
func (s *Server) remoteTransport() RemoteTransport { return s.remotes().Transport() }

// errNoTransport is what the five mutating routes answer when no transport was
// wired. A build with no transport cannot reach another machine at all, so
// refusing is the honest answer -- and GET still returns three empty arrays,
// so the settings pane renders "nothing here" rather than an error.
var errNoTransport = errors.New("no remote transport is configured: this muxterm cannot reach other machines")

// remoteSSHConfig returns a manager for the ssh config this process edits.
//
// One manager per REQUEST, which is internal/sshconfig's own unit of work: a
// Manager takes at most one backup during its lifetime, so a fresh one per
// request is what keeps a long-running server from either filling ~/.ssh with
// copies or (worse) skipping the backup on the second edit of the day.
func remoteSSHConfig() (*sshconfig.Manager, error) {
	path, err := sshconfig.DefaultPath()
	if err != nil {
		return nil, err
	}
	return sshconfig.New(path), nil
}

// The registry accessors these handlers read and write -- Observed, Note and
// NoteProbe -- live on RemoteRegistry in remotes.go, next to the state they
// guard. Nothing in this file touches a registry field directly.
//
// The probe cache is why NoteProbe exists at all: a bare GET /api/remotes must
// never block on N ssh round trips, so it serves whatever was learned last and
// reports "unknown" for anything unprobed. Only ?probe=1 and the
// connect/provision paths refresh it.

// handleRemotesList answers GET /api/remotes[?probe=1] (plan C.1).
//
// The three arrays partition ONE candidate set -- every host the transport can
// see plus every registry member -- so a host appears exactly once and no row
// can silently disappear from the settings pane. The partition is by STATE:
//
//	connected|reconnecting -> "connected"   (Disconnect / Retry)
//	unreachable            -> "errors"      (raw ssh error + Retry)
//	anything else          -> "discovered"  (Connect / Install & connect)
//
// Two consequences worth stating, because they are not literally in C.1's
// one-line descriptions: a registry member that has not reported a state yet
// renders in "discovered", which is where the user can act on it; and a host
// that failed its connect probe renders in "errors" even though the failure
// stopped it from becoming a member, which is exactly what C.4 promises ("the
// registry records unreachable + that error so the settings row shows it").
func (s *Server) handleRemotesList(w http.ResponseWriter, r *http.Request) {
	// Never null. Zero remotes is three empty arrays, and that is the whole
	// zero-remote contract for this route.
	out := remotesListResponse{
		Connected:  []hostRow{},
		Discovered: []hostRow{},
		Errors:     []hostRow{},
	}

	reg := s.remotes()
	tr := reg.Transport()
	if tr == nil {
		writeRemotesJSON(w, http.StatusOK, out)
		return
	}

	// The ssh config supplies two things discovery cannot: which entries
	// muxterm owns (and may therefore remove), and the user@hostname:port a
	// managed alias actually resolves to, so the .r-sub line shows something a
	// human recognises instead of the alias twice.
	m, err := remoteSSHConfig()
	if err != nil {
		writeRemotesError(w, http.StatusInternalServerError, err)
		return
	}
	listing, err := m.List()
	if err != nil {
		writeRemotesError(w, http.StatusInternalServerError, err)
		return
	}
	managed := make(map[string]sshconfig.Entry, len(listing.Managed))
	for _, e := range listing.Managed {
		managed[e.Name] = e
	}

	dctx, cancel := context.WithTimeout(r.Context(), remotesDiscoverDeadline)
	discovered, err := tr.Discover(dctx)
	cancel()
	if err != nil {
		writeRemotesError(w, http.StatusBadGateway, err)
		return
	}

	// Registry members are candidates too. A member whose Host block was
	// hand-edited out of the ssh config is still a machine this process is
	// talking to; dropping it from the listing would strand a live session
	// with no button to end it.
	candidates := make([]transport.HostRef, 0, len(discovered)+8)
	seen := make(map[string]bool, len(discovered)+8)
	for _, h := range discovered {
		if !seen[h.ID] {
			seen[h.ID] = true
			candidates = append(candidates, h)
		}
	}
	for _, h := range reg.Hosts() {
		if !seen[h.ID] {
			seen[h.ID] = true
			candidates = append(candidates, h)
		}
	}

	// ?probe=1 refreshes the probe cache for the DISCOVERED hosts only -- the
	// connect dialog is the only caller, and what it needs to know is which of
	// the hosts it is about to offer need installing. A bare GET spends no ssh
	// round trips at all.
	fresh := map[string]ProbeReport{}
	if probeRequested(r) {
		fresh = probeHosts(r.Context(), tr, reg, discovered)
	}

	fallbackTransport := tr.Name()
	for _, h := range candidates {
		row := remoteRow(reg, h, managed, fresh, fallbackTransport)
		switch row.State {
		case HostConnected, HostReconnecting:
			out.Connected = append(out.Connected, row)
		case HostUnreachable:
			out.Errors = append(out.Errors, row)
		default:
			out.Discovered = append(out.Discovered, row)
		}
	}
	sortRows(out.Connected)
	sortRows(out.Discovered)
	sortRows(out.Errors)

	writeRemotesJSON(w, http.StatusOK, out)
}

// probeRequested reports whether the caller asked for a live probe pass.
func probeRequested(r *http.Request) bool {
	v := r.URL.Query().Get("probe")
	return v == "1" || v == "true"
}

// remoteRow renders one candidate.
func remoteRow(reg *RemoteRegistry, h transport.HostRef, managed map[string]sshconfig.Entry, fresh map[string]ProbeReport, fallbackTransport string) hostRow {
	state, errText, probe := reg.Observed(h.ID)
	if p, ok := fresh[h.ID]; ok {
		probe = p
	}

	row := hostRow{
		ID:        h.ID,
		Name:      h.DisplayName,
		Target:    h.Addr,
		Transport: transportOf(h.ID, fallbackTransport),
		State:     state,
		Probe:     probeUnknown,
	}
	if e, ok := managed[aliasOf(h)]; ok {
		row.Managed = true
		row.Target = formatTarget(e.User, e.HostName, e.Port)
	}
	if probe.State != "" {
		row.Probe = probe.State
	}
	// A path is only meaningful when muxterm was actually found there.
	if row.Probe == probePresent || row.Probe == probeLoginShellOnly {
		row.Path = probe.Path
	}
	if state == HostUnreachable {
		row.Error = errText
	}
	return row
}

// sortRows orders rows by display name, then id. Stable ordering keeps the
// settings pane from reshuffling between polls; the id tie-break makes the
// order total, since display names are not unique by contract.
func sortRows(rows []hostRow) {
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].Name != rows[j].Name {
			return rows[i].Name < rows[j].Name
		}
		return rows[i].ID < rows[j].ID
	})
}

// transportOf returns the transport qualifier of a host id ("ssh" for
// "ssh:boxb"), falling back to the configured transport's name for an id that
// carries none. It is the section-heading key in Settings (ux D7): one section
// per transport, so a second transport adds a section without a code change.
func transportOf(id, fallback string) string {
	if i := strings.Index(id, ":"); i > 0 {
		return id[:i]
	}
	return fallback
}

// aliasOf returns the ssh-config alias for a host: its display name, or the id
// with its transport qualifier stripped when there is none. This is the key
// the sshconfig listing is indexed by.
func aliasOf(h transport.HostRef) string {
	if h.DisplayName != "" {
		return h.DisplayName
	}
	if i := strings.Index(h.ID, ":"); i >= 0 {
		return h.ID[i+1:]
	}
	return h.ID
}

// probeHosts probes hosts concurrently and returns whatever finished in time.
//
// Bounded three ways: at most remotesProbeConcurrency ssh processes at once, a
// single deadline over the whole pass, and no result at all for a probe that
// errored. That last one matters: a probe that could NOT RUN (host down, key
// rejected) is not an answer, and reporting it as "absent" would tell the user
// to install muxterm on a machine that is simply switched off.
//
// It deliberately does not record unreachable in the registry: these are hosts
// the user has merely been offered, not ones they asked to connect, and
// filling the error section with them would be noise.
func probeHosts(ctx context.Context, tr RemoteTransport, reg *RemoteRegistry, hosts []transport.HostRef) map[string]ProbeReport {
	out := make(map[string]ProbeReport, len(hosts))
	if len(hosts) == 0 {
		return out
	}

	ctx, cancel := context.WithTimeout(ctx, remotesProbeDeadline)
	defer cancel()

	var (
		mu sync.Mutex
		wg sync.WaitGroup
	)
	sem := make(chan struct{}, remotesProbeConcurrency)
	for _, h := range hosts {
		wg.Add(1)
		go func(h transport.HostRef) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-sem }()

			rep, err := tr.Probe(ctx, h)
			if err != nil {
				return // stays "unknown"
			}
			reg.NoteProbe(h.ID, rep)
			mu.Lock()
			out[h.ID] = rep
			mu.Unlock()
		}(h)
	}

	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-ctx.Done():
		// Deadline hit. Cancelling ctx kills the outstanding ssh processes;
		// the snapshot below takes whatever already landed and everything else
		// reports "unknown", which is what the plan asks for.
	}

	mu.Lock()
	defer mu.Unlock()
	snapshot := make(map[string]ProbeReport, len(out))
	for k, v := range out {
		snapshot[k] = v
	}
	return snapshot
}

// handleRemotesAdd answers POST /api/remotes (plan C.2).
//
// It writes an ssh config entry and NOTHING else. Adding does not connect:
// they are two decisions, and collapsing them would mean a typo'd host both
// edits the user's config and starts a background dial.
func (s *Server) handleRemotesAdd(w http.ResponseWriter, r *http.Request) {
	if s.remoteTransport() == nil {
		writeRemotesError(w, http.StatusServiceUnavailable, errNoTransport)
		return
	}

	var body struct {
		Name   string `json:"name"`
		Target string `json:"target"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeRemotesError(w, http.StatusBadRequest, fmt.Errorf("invalid JSON body: %w", err))
		return
	}

	user, hostname, port, err := parseTarget(body.Target)
	if err != nil {
		writeRemotesError(w, http.StatusBadRequest, err)
		return
	}

	name := strings.TrimSpace(body.Name)
	derived := name == ""
	if derived {
		name = hostname
	}
	if err := sshconfig.ValidateName(name); err != nil {
		if derived {
			// The caller did not choose this name, we did -- so say so, and
			// say what to do about it.
			err = fmt.Errorf("%w\n\nThis name was derived from the target; send an explicit \"name\" to choose one yourself", err)
		}
		writeRemotesError(w, http.StatusBadRequest, err)
		return
	}

	m, err := remoteSSHConfig()
	if err != nil {
		writeRemotesError(w, http.StatusInternalServerError, err)
		return
	}
	action, addErr := m.Add(sshconfig.Entry{
		Name:     name,
		HostName: hostname,
		Port:     port,
		User:     user,
	})
	if addErr != nil {
		// The backup path is reported on the FAILURE path too: a failed write
		// is exactly when the user most needs to know where their previous
		// config went.
		writeRemotesJSON(w, http.StatusBadRequest, map[string]any{
			"error":  addErr.Error(),
			"backup": m.BackupPath(),
		})
		return
	}

	writeRemotesJSON(w, http.StatusCreated, remoteAddResponse{
		ID:     "ssh:" + name,
		Name:   name,
		Target: formatTarget(user, hostname, port),
		Action: string(action),
		Backup: m.BackupPath(),
	})
}

// handleRemotesRemove answers DELETE /api/remotes/{id} (plan C.3).
//
// Disconnect first, then edit the config: tearing the sessions down while the
// entry still exists means the browsers see one clean never-connected
// transition instead of a reconnect loop against a host that has just lost its
// ssh config block.
func (s *Server) handleRemotesRemove(w http.ResponseWriter, r *http.Request) {
	if s.remoteTransport() == nil {
		writeRemotesError(w, http.StatusServiceUnavailable, errNoTransport)
		return
	}
	id := r.PathValue("id")
	if id == "" {
		writeRemotesError(w, http.StatusBadRequest, errors.New("host id is required"))
		return
	}
	// The managed block is keyed by the ssh alias, which is the id without its
	// transport qualifier.
	name := strings.TrimPrefix(id, "ssh:")

	m, err := remoteSSHConfig()
	if err != nil {
		writeRemotesError(w, http.StatusInternalServerError, err)
		return
	}
	listing, err := m.List()
	if err != nil {
		writeRemotesError(w, http.StatusInternalServerError, err)
		return
	}
	found := false
	for _, e := range listing.Managed {
		if e.Name == name {
			found = true
			break
		}
	}
	if !found {
		// A hand-written Host block is reported by List and is NEVER removed
		// by muxterm: everything outside its own markers is sacred.
		writeRemotesError(w, http.StatusNotFound, fmt.Errorf(
			"%s has no muxterm-managed entry named %q (hand-written Host blocks are never removed by muxterm)",
			listing.Path, name))
		return
	}

	s.remotes().Remove(id)

	action, removeErr := m.Remove(name)
	if removeErr != nil {
		writeRemotesJSON(w, http.StatusInternalServerError, map[string]any{
			"error":  removeErr.Error(),
			"backup": m.BackupPath(),
		})
		return
	}

	writeRemotesJSON(w, http.StatusOK, remoteRemoveResponse{
		ID:     id,
		Action: string(action),
		Backup: m.BackupPath(),
	})
}

// handleRemotesConnect answers POST /api/remotes/{id}/connect (plan C.4).
//
// The probe is SYNCHRONOUS -- one ssh round trip in the good case -- so the
// connect dialog can render its trace from real data instead of guesses. The
// dial is not: it belongs to each browser's own session, and its outcome
// arrives on host-state.
func (s *Server) handleRemotesConnect(w http.ResponseWriter, r *http.Request) {
	tr := s.remoteTransport()
	if tr == nil {
		writeRemotesError(w, http.StatusServiceUnavailable, errNoTransport)
		return
	}
	id := r.PathValue("id")
	if id == "" {
		writeRemotesError(w, http.StatusBadRequest, errors.New("host id is required"))
		return
	}
	reg := s.remotes()

	host, err := s.resolveHost(r.Context(), tr, id)
	if err != nil {
		writeRemotesError(w, http.StatusBadGateway, err)
		return
	}

	// Idempotent: connecting an already-connected host is a no-op. It does not
	// even spend an ssh round trip re-probing a machine that is, by
	// definition, answering right now.
	if _, member := reg.Get(id); member {
		if state, _, cached := reg.Observed(id); state == HostConnected {
			writeRemotesJSON(w, http.StatusAccepted, connectResponseFor(id, cached))
			return
		}
	}

	pctx, cancel := context.WithTimeout(r.Context(), remotesConnectDeadline)
	defer cancel()
	report, err := tr.Probe(pctx, host)
	if err != nil {
		// The probe could not run at all: the host is down, or the key was
		// rejected. Record it so the settings row carries ssh's own words, and
		// hand those same words back verbatim.
		reg.Note(id, HostUnreachable, err.Error())
		writeRemotesError(w, http.StatusBadGateway, err)
		return
	}
	reg.NoteProbe(id, report)

	// probe == "absent" still connects: the session will fail and report
	// unreachable, and the UI should have offered "Install & connect"
	// instead. Refusing here would invent a rule the plan does not have.
	if err := reg.Add(host); err != nil {
		// The only way Add fails is rule P3 -- an id containing "/", which
		// would make every namespaced workspace id for that host ambiguous.
		writeRemotesError(w, http.StatusBadRequest, err)
		return
	}

	writeRemotesJSON(w, http.StatusAccepted, connectResponseFor(id, report))
}

// handleRemotesDisconnect answers POST /api/remotes/{id}/disconnect (C.5).
//
// Registry.Remove drops membership and, on every browser, cancels the session,
// deletes that host's merged workspace/session rows, re-emits both merged
// documents and emits a final host-state{never-connected}. This is the ONE
// case where a host's workspaces vanish rather than ghosting -- because the
// user asked for that.
//
// Idempotent: disconnecting a host that is not a member still answers 200,
// because the state the caller asked for is the state they get.
func (s *Server) handleRemotesDisconnect(w http.ResponseWriter, r *http.Request) {
	if s.remoteTransport() == nil {
		writeRemotesError(w, http.StatusServiceUnavailable, errNoTransport)
		return
	}
	id := r.PathValue("id")
	if id == "" {
		writeRemotesError(w, http.StatusBadRequest, errors.New("host id is required"))
		return
	}

	s.remotes().Remove(id)

	writeRemotesJSON(w, http.StatusOK, remoteDisconnectResponse{
		ID:    id,
		State: HostNeverConnected,
	})
}

// handleRemotesProvision answers POST /api/remotes/{id}/provision (plan C.6) --
// the "Install & connect" button.
//
// login-shell-only is SUCCESS, not a warning: the ssh transport dials through
// `bash -lc` precisely so a ~/.local/bin install works. Treating it as a
// problem would be a warning about a non-problem.
func (s *Server) handleRemotesProvision(w http.ResponseWriter, r *http.Request) {
	tr := s.remoteTransport()
	if tr == nil {
		writeRemotesError(w, http.StatusServiceUnavailable, errNoTransport)
		return
	}
	id := r.PathValue("id")
	if id == "" {
		writeRemotesError(w, http.StatusBadRequest, errors.New("host id is required"))
		return
	}
	reg := s.remotes()

	host, err := s.resolveHost(r.Context(), tr, id)
	if err != nil {
		writeRemotesError(w, http.StatusBadGateway, err)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), remotesInstallDeadline)
	defer cancel()

	if err := tr.Install(ctx, host); err != nil {
		writeRemotesError(w, http.StatusBadGateway, err)
		return
	}

	report, err := tr.Probe(ctx, host)
	if err != nil {
		reg.Note(id, HostUnreachable, err.Error())
		writeRemotesError(w, http.StatusBadGateway, err)
		return
	}
	reg.NoteProbe(id, report)

	resp := connectResponseFor(id, report)
	switch report.State {
	case probePresent, probeLoginShellOnly:
		if err := reg.Add(host); err != nil {
			writeRemotesError(w, http.StatusBadRequest, err)
			return
		}
	default:
		// The install reported success but muxterm still is not there. Say so
		// rather than starting a session that can only fail: "connecting"
		// would be a claim this handler cannot make.
		resp.State = string(HostNeverConnected)
	}

	writeRemotesJSON(w, http.StatusOK, resp)
}

// connectResponseFor builds the C.4/C.6 body from a probe report.
func connectResponseFor(id string, report ProbeReport) remoteConnectResponse {
	out := remoteConnectResponse{
		ID:    id,
		State: remoteStateConnecting,
		Probe: report.State,
		User:  report.User,
	}
	if out.Probe == "" {
		out.Probe = probeUnknown
	}
	if out.Probe == probePresent || out.Probe == probeLoginShellOnly {
		out.Path = report.Path
	}
	return out
}

// resolveHost turns a host id into the HostRef to dial.
//
// Three sources in order: the registry (a host already admitted keeps the ref
// it was admitted with), discovery (the ssh config, which is where a host the
// user just added or has always had lives), and finally the id itself. That
// last fallback is what makes a manual "user@host" work the moment its config
// entry is written, and it is honest: for this transport the id IS the ssh
// target, qualified. A host that resolves to nothing dialable fails at the
// probe with ssh's own error, which is a better message than anything a
// lookup miss here could produce.
func (s *Server) resolveHost(ctx context.Context, tr RemoteTransport, id string) (transport.HostRef, error) {
	if h, ok := s.remotes().Get(id); ok {
		return h, nil
	}

	dctx, cancel := context.WithTimeout(ctx, remotesDiscoverDeadline)
	defer cancel()
	hosts, err := tr.Discover(dctx)
	if err != nil {
		return transport.HostRef{}, err
	}
	for _, h := range hosts {
		if h.ID == id {
			return h, nil
		}
	}

	alias := strings.TrimPrefix(id, tr.Name()+":")
	return transport.HostRef{ID: id, DisplayName: alias, Addr: alias}, nil
}

// parseTarget splits "[user@]host[:port]" (plan C.2). host is required; user
// and port are optional and a zero port means "let ssh use its default".
//
// The user is split on the LAST "@" so a username containing one does not
// swallow the host. The port is split on the last ":" only when there is
// exactly one, so a bare IPv6 literal ("::1") is read as a host rather than as
// a host with a nonsense port; the bracketed form ("[::1]:2222") carries a
// port unambiguously and is parsed as such.
func parseTarget(raw string) (user, host string, port int, err error) {
	t := strings.TrimSpace(raw)
	if t == "" {
		return "", "", 0, errors.New(`"target" is required, in the form [user@]host[:port]`)
	}
	if i := strings.LastIndex(t, "@"); i >= 0 {
		user, t = t[:i], t[i+1:]
		if user == "" {
			return "", "", 0, fmt.Errorf("invalid target %q: the part before %q is empty", raw, "@")
		}
	}

	host = t
	switch {
	case strings.HasPrefix(host, "["):
		end := strings.Index(host, "]")
		if end < 0 {
			return "", "", 0, fmt.Errorf("invalid target %q: unbalanced %q", raw, "[")
		}
		rest := host[end+1:]
		host = host[1:end]
		if rest != "" {
			if !strings.HasPrefix(rest, ":") {
				return "", "", 0, fmt.Errorf("invalid target %q: expected %q after %q", raw, ":", "]")
			}
			if port, err = parsePort(raw, rest[1:]); err != nil {
				return "", "", 0, err
			}
		}
	case strings.Count(host, ":") == 1:
		i := strings.Index(host, ":")
		if port, err = parsePort(raw, host[i+1:]); err != nil {
			return "", "", 0, err
		}
		host = host[:i]
	}

	if host == "" {
		return "", "", 0, fmt.Errorf("invalid target %q: a host is required", raw)
	}
	return user, host, port, nil
}

func parsePort(raw, s string) (int, error) {
	p, err := strconv.Atoi(s)
	if err != nil {
		return 0, fmt.Errorf("invalid target %q: %q is not a port number", raw, s)
	}
	if p < 1 || p > 65535 {
		return 0, fmt.Errorf("invalid target %q: port %d is out of range (a TCP port is 1-65535)", raw, p)
	}
	return p, nil
}

// formatTarget renders "[user@]host[:port]" -- the .r-sub line, and the
// canonical echo of what was written into the ssh config.
func formatTarget(user, host string, port int) string {
	var b strings.Builder
	if user != "" {
		b.WriteString(user)
		b.WriteString("@")
	}
	if port != 0 && strings.Contains(host, ":") {
		// An IPv6 literal has to be bracketed before a port can be appended,
		// or "::1:2222" is unparseable by everything downstream.
		b.WriteString("[" + host + "]")
	} else {
		b.WriteString(host)
	}
	if port != 0 {
		fmt.Fprintf(&b, ":%d", port)
	}
	return b.String()
}
