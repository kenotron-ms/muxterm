package sessiond

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Session-restore snapshotting: periodic capture of every live workspace and
// pane's cwd, argv, agent identity, and recent output to disk, plus
// boot-time restore from the most recent snapshot. This is muxterm's
// equivalent of tmux-resurrect + tmux-continuum: it does NOT re-adopt or
// resume the original OS process (there is none to resume -- the daemon
// restarted). It restores pane cwd, relaunches a recognized coding agent's
// exact argv verbatim (see agent_catalog.go), and seeds the last-seen output
// back into the pane as inert historical text above a fresh, live prompt.
const (
	snapshotVersion = 1

	// maxReplayBytesPerPane caps how much historical output each pane's
	// snapshot retains. If Replay() returns more, the trailing (most recent)
	// bytes are kept -- the *end* is "last output," not the beginning.
	maxReplayBytesPerPane = 256 * 1024

	// maxSnapshotBytes is the total on-disk snapshot budget across every
	// pane. If assembling the snapshot would exceed this, replay bytes
	// (never cwd/argv/agent metadata) are dropped from panes, largest first,
	// until the marshaled snapshot fits -- see enforceSnapshotBudget.
	maxSnapshotBytes = 8 * 1024 * 1024
)

// Snapshot is the on-disk, versioned schema for a full point-in-time capture
// of every workspace and pane sessiond knows about.
type Snapshot struct {
	Version    int                 `json:"version"`
	WrittenAt  time.Time           `json:"written_at"`
	Reason     string              `json:"reason"` // "periodic" | "shutdown"
	Workspaces []WorkspaceSnapshot `json:"workspaces"`
}

// WorkspaceSnapshot is one workspace's captured name, layout, and panes.
type WorkspaceSnapshot struct {
	Name string `json:"name"`

	// NameOrigin is "derived" or "explicit" -- who chose Name (autoname.go).
	// Stored as a plain string, like SessionIDSource below, so the file stays
	// self-describing to anyone reading it. Absent in snapshots written before
	// provenance existed, and restored as explicit; see
	// nameOriginFromSnapshot for why that is the safe direction.
	NameOrigin string `json:"name_origin,omitempty"`

	Layout map[string]string `json:"layout,omitempty"` // verbatim copy of Registry's per-workspace Layouts map
	Panes  []PaneSnapshot    `json:"panes"`
}

// PaneSnapshot is one pane's captured identity, foreground command, and
// recent output. There is deliberately no pid/FD-index/durable-identity
// field of any kind: nothing here is ever looked up by id after restore, a
// restored pane gets a fresh id via the normal allocation path exactly like
// any live-created pane.
type PaneSnapshot struct {
	Title string `json:"title"`

	// TitleOrigin is "derived" or "explicit" -- who chose Title (autoname.go).
	// It has to be persisted next to the title itself: without it, a rename
	// somebody typed comes back after a crash-recovery restart looking like a
	// guess, and the deriver overwrites it on the very next tick.
	TitleOrigin string `json:"title_origin,omitempty"`

	Cwd   string   `json:"cwd,omitempty"`
	Argv  []string `json:"argv,omitempty"`
	Agent string   `json:"agent,omitempty"` // catalog Name if matched, else ""

	// SessionID is a resumable Amplifier session id, when known. Populated
	// one of two ways, in priority order:
	//  1. Tier 1 (reliable): the hooks-muxterm-session hook stamped it into
	//     this pane's own process title via setproctitle -- see
	//     matchAmplifierSessionID.
	//  2. Tier 2 (best-effort): no hook installed; scraped from the pane's
	//     own captured output banner -- see scrapeAmplifierSessionID.
	// Empty when neither applies (not amplifier, or amplifier with no
	// discoverable session id).
	SessionID string `json:"session_id,omitempty"`

	// SessionIDSource records HOW SessionID was discovered: "hook" (tier 1)
	// or "scan" (tier 2). This exists purely for disclosure to the user in
	// the restore divider (see buildRestoreSeed) -- restorePane's own
	// resuming/liveness/argv-construction logic never branches on it, only
	// on SessionID and amplifierSessionLive. Deliberately a separate field
	// from ArgvIsCosmetic, even though the two happen to correlate today
	// (ArgvIsCosmetic is only ever true when SessionIDSource is "hook"):
	// ArgvIsCosmetic answers "is it safe to verbatim-exec Argv", a
	// different question from "how did we learn this id", and the two
	// should not be forced to share one field just because they currently
	// agree. Empty when SessionID is empty.
	SessionIDSource string `json:"session_id_source,omitempty"`

	// ArgvIsCosmetic is true only when Argv is the tier-1 setproctitle
	// string ("amplifier resume <id>"), NOT a real executable invocation.
	// restorePane must never verbatim-exec Argv when this is true; it
	// falls back to plain default-shell resolution instead (same as no
	// catalog match at all). Always false for claude/codex/opencode and
	// for amplifier panes recognized via the ordinary basename match
	// (tier 2), where Argv is always a real, previously-executed
	// invocation safe to relaunch verbatim.
	ArgvIsCosmetic bool `json:"argv_is_cosmetic,omitempty"`

	Cols       int       `json:"cols"`
	Rows       int       `json:"rows"`
	Replay     []byte    `json:"replay,omitempty"` // encoding/json base64s []byte automatically
	CapturedAt time.Time `json:"captured_at"`
}

// snapshotDir resolves the directory that holds the daemon's session-restore
// snapshot file. It follows the XDG Base Directory spec for the data dir,
// mirroring the XDG-with-HOME-fallback pattern already used by socketDir
// (spawn.go, $XDG_RUNTIME_DIR) and config.DefaultPath ($XDG_CONFIG_HOME):
//   - If XDG_DATA_HOME is set, uses $XDG_DATA_HOME/muxterm.
//   - Otherwise falls back to $HOME/.local/share/muxterm.
func snapshotDir() string {
	base := os.Getenv("XDG_DATA_HOME")
	if base == "" {
		base = filepath.Join(os.Getenv("HOME"), ".local", "share")
	}
	return filepath.Join(base, "muxterm")
}

// DefaultSnapshotPath returns the path to the daemon's session-restore
// snapshot file.
func DefaultSnapshotPath() string {
	return filepath.Join(snapshotDir(), "restore-snapshot.json")
}

// WriteSnapshot serializes snap as JSON and atomically writes it to path: a
// temp file in the same directory, then os.Rename over the target, so a
// concurrent reader (the next boot's restore) never observes a
// partially-written file.
func WriteSnapshot(path string, snap Snapshot) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("sessiond: create snapshot dir %s: %w", dir, err)
	}
	data, err := json.Marshal(snap)
	if err != nil {
		return fmt.Errorf("sessiond: marshal snapshot: %w", err)
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return fmt.Errorf("sessiond: write snapshot temp file %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("sessiond: rename snapshot into place at %s: %w", path, err)
	}
	return nil
}

// LoadSnapshot reads and parses the snapshot at path. A missing file returns
// the plain *os.PathError from os.ReadFile (callers use os.IsNotExist to
// distinguish "never written yet" from a genuine read/parse failure).
func LoadSnapshot(path string) (*Snapshot, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var snap Snapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		return nil, fmt.Errorf("sessiond: parse snapshot %s: %w", path, err)
	}
	return &snap, nil
}

// BuildSnapshot walks every live workspace and pane in reg and assembles a
// Snapshot ready to write to disk. reason is "periodic" or "shutdown".
//
// Registry.snapshotView() releases reg's lock before this function does any
// per-pane inspection (foreground pid resolution, /proc reads, VT grid
// serialization via Replay()), so a slow snapshot walk never blocks live
// registry mutations.
func BuildSnapshot(reg *Registry, reason string) Snapshot {
	views := reg.snapshotView()
	snap := Snapshot{
		Version:   snapshotVersion,
		WrittenAt: time.Now(),
		Reason:    reason,
	}
	for _, view := range views {
		wsSnap := WorkspaceSnapshot{Name: view.Name, NameOrigin: string(view.NameOrigin), Layout: view.Layout}
		for _, p := range view.Panes {
			wsSnap.Panes = append(wsSnap.Panes, capturePaneSnapshot(p))
		}
		snap.Workspaces = append(snap.Workspaces, wsSnap)
	}
	enforceSnapshotBudget(&snap)
	return snap
}

// capturePaneSnapshot captures one live pane's title, dimensions, replay
// buffer, and (best-effort) foreground cwd/argv/agent match -- including,
// for amplifier specifically, a resumable session id when one is
// discoverable (see the SessionID field's doc comment for the two tiers).
func capturePaneSnapshot(p *Pane) PaneSnapshot {
	info := p.Info()
	// Captured once, full and uncapped: scrapeAmplifierSessionID (tier 2)
	// needs the FULL replay, not the budget-capped version stored below.
	// amplifier's "Session ID: ..." banner prints once, at the very start
	// of a session -- exactly what capReplay's trailing-bytes-only cap
	// would discard first in any sufficiently long conversation.
	fullReplay := p.Replay()
	out := PaneSnapshot{
		Title: info.Title,
		// Captured through the pane's own lock rather than off PaneInfo: the
		// provenance is daemon-internal bookkeeping and has no business on the
		// wire type the browser and MCP both read.
		TitleOrigin: string(p.titleOriginSnapshot()),
		Cols:        info.Cols,
		Rows:        info.Rows,
		Replay:      capReplay(fullReplay),
		CapturedAt:  time.Now(),
	}

	pid, ok := resolveForegroundPID(p)
	if !ok {
		return out
	}
	cwd, argv, ok := foregroundCwdArgv(pid)
	if !ok {
		return out
	}
	out.Cwd = cwd
	out.Argv = argv

	if id, matched := matchAmplifierSessionID(argv); matched {
		// Tier 1: the hooks-muxterm-session hook stamped the real session
		// id into this pane's own process title. Argv here is that
		// cosmetic title string, not a real invocation -- ArgvIsCosmetic
		// tells restorePane never to exec it verbatim.
		out.Agent = "amplifier"
		out.SessionID = id
		out.SessionIDSource = "hook"
		out.ArgvIsCosmetic = true
	} else if name, matched := matchAgent(argv, defaultAgentCatalog()); matched {
		out.Agent = name
		if name == "amplifier" {
			// Tier 2: no hook installed for this session -- best-effort
			// scrape of the pane's own captured banner instead.
			if scraped, ok := scrapeAmplifierSessionID(fullReplay); ok {
				out.SessionID = scraped
				out.SessionIDSource = "scan"
			}
		}
	}
	return out
}

// amplifierSessionLive reports whether a resumable session for id still
// has its event log on disk under cwd's project. Follows amplifier-app-cli's
// own on-disk convention, confirmed against real session directories (not
// inferred from documentation):
//
//	~/.amplifier/projects/<slug>/sessions/<id>/events.jsonl
//
// where slug is cwd with every "/" replaced by "-" (e.g. cwd
// "/home/ken/workspace/muxterm" -> slug "-home-ken-workspace-muxterm").
//
// Checking for events.jsonl specifically, rather than just the bare
// sessions/<id>/ directory, matters: a session directory can in principle
// exist (or persist, e.g. after a partially-failed delete) without a valid
// event log inside it, which would let a restore attempt "amplifier
// resume" against a session with nothing to actually resume. Requiring the
// real file closes that gap.
func amplifierSessionLive(cwd, sessionID string) bool {
	if cwd == "" || sessionID == "" {
		return false
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return false
	}
	slug := strings.ReplaceAll(cwd, "/", "-")
	eventsPath := filepath.Join(home, ".amplifier", "projects", slug, "sessions", sessionID, "events.jsonl")
	info, err := os.Stat(eventsPath)
	return err == nil && !info.IsDir()
}

// ansiEscapeRE strips common ANSI/VT escape sequences (CSI, OSC, and
// simple two-byte escapes) so scrapeAmplifierSessionID can regex-match
// plain text underneath them. This is a best-effort stripper for the
// tier-2 fallback only -- it is not a full VT parser and does not need to
// be, since the only thing ever matched against its output is one literal
// banner substring, not a reconstructed terminal grid.
var ansiEscapeRE = regexp.MustCompile(`\x1b(?:\[[0-9;?]*[a-zA-Z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][A-Za-z0-9]|[=>NOPX^_\\])`)

// sessionIDBlockRE matches amplifier's FULL interactive-session startup
// banner block -- not just a bare "Session ID: <uuid>" line. Verified
// against a real running amplifier's actual output (captured via muxterm's
// own read-screen in a DTU), not inferred:
//
//	╭──────────────────────────────────────────────────╮
//	│ Amplifier Interactive Session                     │
//	│ Session ID: 9f5f12de-64c3-43b5-8f06-e70b7af28798   │
//	│ amplifier 2026.08.30-963d793 | core 1.6.1          │
//	│ Bundle: anchors | Provider: Anthropic | default    │
//	│ Commands: /help | Multi-line: Ctrl-J | Exit: Ctrl-D│
//	╰──────────────────────────────────────────────────╯
//
// A bare "Session ID: <uuid>" match is too weak on its own -- it is exactly
// the shape of text that could appear in an unrelated paste, a log excerpt,
// or even conversation text quoting a session id, none of which are this
// pane actually running a resumable amplifier session. Requiring the box
// top border and the literal "Amplifier Interactive Session" title
// immediately before it, and the box's own bottom border closing within a
// bounded number of lines afterward, makes a false positive require
// reproducing that whole distinctive, multi-line shape by coincidence --
// not just one phrase plus a GUID-shaped string.
//
// Deliberately NOT hardcoded: the exact wording/order of the version,
// bundle, and commands lines between "Session ID:" and the bottom border.
// Those are the lines most likely to change wording across amplifier
// releases; hardcoding them verbatim would make this regex brittle to
// changes that have nothing to do with whether a session id is genuinely
// present. The three anchors that ARE required -- the top border, the
// title line, and the bottom border -- are the structural parts of the
// banner, least likely to change shape release to release. If they ever
// do change, this should fail closed (no match, tier 2 simply finds
// nothing) rather than silently matching something that isn't really
// amplifier's startup banner -- the same fail-safe posture as everywhere
// else in this file.
//
// Whitespace (\s) is deliberately unconstrained on exact padding/count:
// terminal width varies at capture time, which varies the border's dash
// count and each line's trailing padding before its closing "│" -- none of
// that is meaningful signal, only the anchor text and box shape are.
var sessionIDBlockRE = regexp.MustCompile(
	`╭─+╮\s*` +
		`│\s*Amplifier Interactive Session\s*│\s*` +
		`│\s*Session ID:\s*([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\s*│` +
		`(?:.*\n){0,6}?` + // bounded slack for the version/bundle/commands lines, wording not hardcoded
		`╰─+╯`,
)

// scrapeAmplifierSessionID is the tier-2, best-effort fallback for panes
// running amplifier without the hooks-muxterm-session hook installed (see
// matchAmplifierSessionID for the reliable, hook-based tier 1 path). It
// strips ANSI escapes from fullReplay -- the pane's FULL captured replay,
// never the budget-capped Replay field -- and looks for the full banner
// block (sessionIDBlockRE), not a bare id line. If the banner appears more
// than once (e.g. after a /fork mid-conversation started a second one),
// the LAST occurrence is used, since that reflects whatever was actually
// active at capture time.
func scrapeAmplifierSessionID(fullReplay []byte) (string, bool) {
	plain := ansiEscapeRE.ReplaceAll(fullReplay, nil)
	matches := sessionIDBlockRE.FindAllSubmatch(plain, -1)
	if len(matches) == 0 {
		return "", false
	}
	last := matches[len(matches)-1]
	return string(last[1]), true
}

// resolveForegroundPID reuses the daemon's existing foreground-process-group
// inspection (activity.go / foreground_pgrp_supported.go) to find a pid
// belonging to whatever is currently running in this pane's foreground -- the
// shell itself when idle at its prompt, or a foreground child (a coding
// agent, an editor, etc.) otherwise. It does not re-derive any of that
// machinery, only reuses it.
//
// The returned process-group id is usable directly as a pid: POSIX process
// groups are named after the pid of their leader, which for an interactive
// shell's job control is exactly the process the shell put in the
// foreground.
func resolveForegroundPID(p *Pane) (int, bool) {
	if !foregroundPGRPSupported() {
		return 0, false
	}
	snap := p.activitySnapshot()
	if snap.exited || snap.ptmx == nil {
		return 0, false
	}
	pgrp, err := inspectForegroundPGRP(snap.ptmx)
	if err != nil || pgrp <= 0 {
		return 0, false
	}
	return pgrp, true
}

// capReplay returns the trailing maxReplayBytesPerPane bytes of data (the
// most recent output), or data unchanged if it is already within budget. The
// returned slice never aliases data's backing array when trimmed.
func capReplay(data []byte) []byte {
	if len(data) <= maxReplayBytesPerPane {
		return data
	}
	kept := make([]byte, maxReplayBytesPerPane)
	copy(kept, data[len(data)-maxReplayBytesPerPane:])
	return kept
}

// enforceSnapshotBudget drops replay bytes (never cwd/argv/agent/title
// metadata) from the pane with the largest retained replay, repeatedly,
// until the marshaled snapshot fits within maxSnapshotBytes or there is
// nothing left to drop. A snapshot that still doesn't fit once every pane's
// replay is empty is written oversized rather than failing outright -- an
// oversized write of pure metadata is vanishingly unlikely (it would require
// thousands of panes) and is still strictly better than losing the whole
// snapshot.
func enforceSnapshotBudget(snap *Snapshot) {
	for {
		data, err := json.Marshal(snap)
		if err != nil || len(data) <= maxSnapshotBytes {
			return
		}
		if !dropLargestReplay(snap) {
			return
		}
	}
}

// dropLargestReplay clears the Replay field of whichever pane across every
// workspace currently holds the largest replay buffer, and reports whether
// it found one to drop.
func dropLargestReplay(snap *Snapshot) bool {
	var target *PaneSnapshot
	maxLen := 0
	for wi := range snap.Workspaces {
		panes := snap.Workspaces[wi].Panes
		for pi := range panes {
			if l := len(panes[pi].Replay); l > maxLen {
				maxLen = l
				target = &panes[pi]
			}
		}
	}
	if target == nil {
		return false
	}
	target.Replay = nil
	return true
}

// StartSnapshotWriter starts a background goroutine that captures and writes
// a "periodic" snapshot every interval, until ctx is cancelled (matching
// tmux-continuum's periodic autosave). interval <= 0 falls back to 30s. The
// goroutine exits on its own when ctx is done; there is nothing for the
// caller to stop or wait on.
func StartSnapshotWriter(ctx context.Context, reg *Registry, interval time.Duration, path string) {
	if interval <= 0 {
		interval = 30 * time.Second
	}
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				snap := BuildSnapshot(reg, "periodic")
				if err := WriteSnapshot(path, snap); err != nil {
					log.Printf("sessiond: periodic snapshot write failed: %v", err)
				}
			}
		}
	}()
}

// RestoreFromSnapshot attempts to repopulate s's registry from the snapshot
// at path, mirroring tmux-continuum's boot-time restore. It is a no-op
// (returns 0) when restore is disabled, the snapshot file is missing or
// unparseable, or the snapshot has no workspaces. Callers can unconditionally
// follow this with Registry.EnsureDefault() (as ListenAndServe already
// does): EnsureDefault only acts on an empty registry, so it is a correct
// no-op whenever this function actually restored something, and today's
// exact cold-start fallback whenever it did not -- a corrupt/missing
// snapshot never blocks startup.
//
// Must be called before ListenAndServe's Accept() loop starts: there are no
// connections to race with yet, which is what lets each restored pane's
// historical divider be seeded into its buffer strictly before that pane's
// PTY/read-loop goroutines start (see restorePane / buildRestoreSeed).
func (s *Server) RestoreFromSnapshot(enabled bool, path string) int {
	if !enabled {
		return 0
	}
	snap, err := LoadSnapshot(path)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("sessiond: restore: snapshot at %s unreadable (%v); starting with a blank default workspace instead", path, err)
		}
		return 0
	}
	if len(snap.Workspaces) == 0 {
		return 0
	}

	restored := 0
	for _, wsSnap := range snap.Workspaces {
		wsID := s.reg.AddWorkspace(wsSnap.Name, "")
		// AddWorkspace records every creation as explicit, which is right for
		// every live caller and wrong for exactly this one: a name this daemon
		// derived last run must come back derived, or it freezes at whatever
		// the first session happened to be called and can never be refined.
		s.reg.restoreWorkspaceNameOrigin(wsID, nameOriginFromSnapshot(wsSnap.NameOrigin))
		for bp, layout := range wsSnap.Layout {
			s.reg.SaveLayout(wsID, bp, layout)
		}

		paneCount := 0
		for _, paneSnap := range wsSnap.Panes {
			if err := s.restorePane(wsID, paneSnap); err != nil {
				log.Printf("sessiond: restore: pane %q in workspace %s: %v", paneSnap.Title, wsID, err)
				continue
			}
			paneCount++
		}
		if paneCount == 0 {
			// Every pane in this workspace failed to spawn (or the snapshot
			// recorded none). Reap it rather than leaving a dangling empty
			// workspace behind; ReapIfEmpty recreates a blank default if
			// this was the last workspace standing, which is exactly
			// today's cold-start fallback.
			s.reg.ReapIfEmpty(wsID)
			continue
		}
		restored++
	}
	return restored
}

// restorePane constructs one restored pane in workspace wsID from paneSnap,
// wiring it into the live registry and broadcast plumbing exactly like a
// freshly created interactive pane (see createPane in server.go), with two
// differences: argv is decided from the snapshot rather than a client
// request (see the three-way choice below), and the pane's buffer is
// pre-seeded with the historical replay bytes plus a dim "restored" divider
// before NewPane starts the pty and its read-loop goroutine -- so no live
// byte can ever interleave with the seed. There is no client to race with
// yet at this point in boot anyway (the accept loop has not started).
func (s *Server) restorePane(wsID string, paneSnap PaneSnapshot) error {
	localID, ok := s.reg.AllocPaneID(wsID)
	if !ok {
		return fmt.Errorf("unknown workspace")
	}
	cols, rows := sizeOrDefault(paneSnap.Cols, paneSnap.Rows)

	// resuming is computed once and shared by both the seed text (below)
	// and the argv choice, so the divider's wording and what actually gets
	// executed can never disagree with each other.
	resuming := paneSnap.SessionID != "" && amplifierSessionLive(paneSnap.Cwd, paneSnap.SessionID)

	// Pre-seed the buffer BEFORE NewPane is called at all: this happens
	// before the pty is even started, let alone before the read-loop
	// goroutine that copies live PTY output into it, so there is no
	// possible ordering in which a live byte could interleave with the seed.
	buf := NewVTBuffer(cols, rows)
	_, _ = buf.Write(buildRestoreSeed(paneSnap, resuming))

	// Three-way argv choice, in priority order:
	//  1. A live, resumable session id -- construct a fresh "amplifier
	//     resume <id>" invocation. The captured Argv is NEVER used here:
	//     for tier 1 it is a cosmetic setproctitle string, not a real
	//     executable path.
	//  2. A catalog match whose Argv is a real invocation (ArgvIsCosmetic
	//     false) -- relaunch it verbatim, exactly like today's existing
	//     behaviour for claude/codex/opencode, and for amplifier when no
	//     session id was discoverable at all.
	//  3. Neither -- nil argv, default shell resolution. This is also
	//     where a tier-1-matched-but-no-longer-live pane lands: its Argv
	//     is cosmetic (ArgvIsCosmetic true), so it is never falsely
	//     relaunched as a bogus "executable."
	var argv []string
	switch {
	case resuming:
		argv = []string{"amplifier", "resume", paneSnap.SessionID}
	case paneSnap.Agent != "" && !paneSnap.ArgvIsCosmetic:
		argv = paneSnap.Argv
	}

	onPromptFn := func(id int, m *Message) {
		m.WorkspaceID = wsID
		m.PaneID = id
		s.broadcast(wsID, m)
	}
	p, err := NewPane(
		localID,
		argv,
		cols, rows,
		buf,
		func(id int, data []byte) { s.broadcastPaneData(wsID, id, data) },
		func(id int, exitCode int, runtimeMs int64) { s.handlePaneExit(wsID, id, exitCode, runtimeMs) },
		onPromptFn,
		paneSnap.Cwd,
	)
	if err != nil {
		return err
	}
	if paneSnap.Title != "" {
		// Restored with the provenance it was captured with, NOT through the
		// public rename verb: a title this daemon derived must stay derivable
		// so a later label can still refine it, and a title somebody typed
		// must stay untouchable. A snapshot too old to say restores as
		// explicit -- see nameOriginFromSnapshot.
		p.setTitle(paneSnap.Title, nameOriginFromSnapshot(paneSnap.TitleOrigin))
	}
	s.reg.PutPane(wsID, p)
	return nil
}

// buildRestoreSeed assembles the bytes written into a restored pane's buffer
// before its pty/read-loop starts: the captured historical replay verbatim,
// a defensive return-to-main-screen-and-reset-SGR (in case capture ended
// mid-alt-screen, e.g. a TUI was open when the snapshot was taken), and one
// printed, dim, inert divider line documenting what this pane was running
// and when -- worded differently depending on whether restorePane is about
// to actually resume the conversation (resuming) or just relaunch/fall
// back, so the divider never claims more than what actually happens next.
// The fresh shell/agent's own prompt (or resumed conversation) lands right
// after this, live, on the clean main screen.
func buildRestoreSeed(paneSnap PaneSnapshot, resuming bool) []byte {
	var out []byte
	out = append(out, paneSnap.Replay...)
	out = append(out, "\x1b[?1049l\x1b[0m"...)

	cwd := paneSnap.Cwd
	if cwd == "" {
		cwd = "(unknown)"
	}
	when := paneSnap.CapturedAt.Local().Format("2006-01-02 15:04:05")

	var divider string
	if resuming {
		// Discloses HOW the session id was found, not just that a resume
		// is happening: a hook-stamped id (tier 1) is deliberately placed
		// for exactly this purpose, while a scanned id (tier 2) is a
		// best-effort match against the captured banner text. These carry
		// different confidence levels, and the user should be able to see
		// which one produced this resume, not just that a resume happened.
		via := "unknown mechanism"
		switch paneSnap.SessionIDSource {
		case "hook":
			via = "via muxterm bundle hook"
		case "scan":
			via = "via scan of captured output"
		}
		divider = fmt.Sprintf(
			"\r\n\x1b[2m── muxterm: restored · resuming amplifier session %s (%s) · last seen %s · cwd %s ──\x1b[0m\r\n\r\n",
			paneSnap.SessionID, via, when, cwd,
		)
	} else {
		agent := paneSnap.Agent
		if agent == "" {
			agent = "shell"
		}
		divider = fmt.Sprintf(
			"\r\n\x1b[2m── muxterm: restored · was running %s · last seen %s · cwd %s ──\x1b[0m\r\n\r\n",
			agent, when, cwd,
		)
	}
	out = append(out, divider...)
	return out
}
