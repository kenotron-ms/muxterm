package mcp

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// Harness-agnostic transcript reading: what a lane actually SAID, as opposed to
// what its terminal currently shows.
//
// ⚠ NOTHING HERE MAY READ A WHOLE FILE. These files are append-only JSONL and
// grow without bound -- an amplifier session's events.jsonl on this machine is
// 276 MB, and a single LINE inside a transcript has been measured at 75 KB
// (one tool result containing a file). Both numbers are why every read below
// is a bounded tail taken by seeking from the END, and why each extracted
// string is truncated: a reader that slurps the file, or that faithfully
// returns a 75 KB tool result, converts "show me the last few turns" into an
// out-of-memory risk or a context-window flood.
//
// The caps are stated in the lane_transcript tool description as well as here,
// so the caller knows it is being handed a tail rather than a transcript.

const (
	// transcriptTailPerTurn is how many bytes of tail to budget per requested
	// turn. Generous on purpose: turns are not uniform, and one fat tool
	// result must not push ten ordinary turns out of the window.
	transcriptTailPerTurn = 64 * 1024

	// transcriptMinTail / transcriptMaxTail bound that budget. The maximum is
	// the HARD one: it holds no matter how large the file or how many turns
	// are asked for, so peak allocation for a single call is known in advance
	// and is independent of the input.
	transcriptMinTail = 256 * 1024
	transcriptMaxTail = 4 * 1024 * 1024

	// transcriptMaxText caps one extracted string. Enough to see what a turn
	// was about; far short of enough to paste a file into the answer.
	transcriptMaxText = 400

	// transcriptMaxTurns caps last_n, and with transcriptMaxText bounds the
	// whole result at roughly 100 x 400 chars.
	transcriptMaxTurns     = 100
	transcriptDefaultTurns = 10
)

// TranscriptTurn is one turn of a lane's conversation, flattened out of
// whichever on-disk format its harness writes.
//
// camelCase-free by construction: it has one field per concept and the JSON
// tags below are the CLI's spelling. The MCP tool projects it separately
// (transcriptTurnJSON) for the same reason fleetRowJSON exists.
type TranscriptTurn struct {
	Role string `json:"role"`
	Text string `json:"text"`
	Tool string `json:"tool,omitempty"`
	TS   string `json:"ts,omitempty"`
}

// Transcript is the result of reading one session's tail.
type Transcript struct {
	Harness string `json:"harness"`
	Path    string `json:"path"`
	// Truncated reports that the file was larger than the tail window, i.e.
	// that earlier turns exist and were never read. Always report this: a
	// caller that mistakes a tail for a whole conversation will confidently
	// describe a lane by its last ten turns.
	Truncated bool             `json:"truncated"`
	Turns     []TranscriptTurn `json:"turns"`
}

// transcriptFS is the file access a transcript read needs, and the seam that
// makes the same code work on this machine and on another one.
//
// PR #90 refused lane_transcript across machines with a reason that was true at
// the time: "a harness transcript is a file on the machine the session runs on,
// and this process has no way to read a file across a machine boundary." The
// sessiond protocol now carries read-file and list-dir (see
// internal/sessiond/protocol.go TypeReadFile), so the premise is gone and with
// it the refusal.
//
// It is an INTERFACE with two implementations rather than a branch, because the
// alternative -- "if remote, do it the other way" -- is how a local path and a
// remote path quietly stop behaving the same. Both implementations answer the
// same two questions and nothing else can differ.
type transcriptFS interface {
	// tail returns up to window bytes from the END of path, and whether bytes
	// before them were skipped. path may begin "~/", which each implementation
	// expands against the home of the user on ITS OWN machine.
	tail(path string, window int64) (data []byte, truncated bool, err error)
	// listNames returns the entry names directly under dir, or nil.
	listNames(dir string) []string
}

// ReadTranscript returns the last n turns of the session described by row,
// reading from THIS machine's filesystem. Used by the CLI, which is always on
// the same machine as the session it is reading.
func ReadTranscript(row sessiond.SessionState, n int) (Transcript, error) {
	return readTranscriptOn(localTranscriptFS{}, row, n)
}

// ReadTranscriptOn returns the last n turns of a session on c's machine,
// reading the file THROUGH THE DAEMON on that machine.
//
// It takes this route even when c is local. A local shortcut would mean the
// tool's two paths are different code, and the first divergence between them
// would show up as "it works here but not on boxb" with nothing to point at.
// One path, exercised locally every time it is used, is what makes the remote
// case trustworthy.
func ReadTranscriptOn(c *Client, row sessiond.SessionState, n int) (Transcript, error) {
	return readTranscriptOn(daemonTranscriptFS{c: c}, row, n)
}

// readTranscriptOn is the shared body.
//
// The harness decides the on-disk format AND the path, so an unknown harness is
// an error naming it rather than a guess at a layout: reading the wrong file,
// or no file, and reporting "no turns" would be a lie about a session that is
// talking perfectly well.
func readTranscriptOn(fsys transcriptFS, row sessiond.SessionState, n int) (Transcript, error) {
	if n <= 0 {
		n = transcriptDefaultTurns
	}
	if n > transcriptMaxTurns {
		n = transcriptMaxTurns
	}

	switch row.Harness {
	case sessiond.HarnessAmplifier:
		return readJSONLTail(fsys, row.Harness, amplifierTranscriptPath(row), n, amplifierTurn)
	case sessiond.HarnessClaude:
		return readJSONLTail(fsys, row.Harness, claudeTranscriptPath(fsys, row), n, claudeTurn)
	case "":
		return Transcript{}, fmt.Errorf("session %q declares no harness, so there is no transcript format to read "+
			"(readable: %s, %s)", row.SessionID, sessiond.HarnessAmplifier, sessiond.HarnessClaude)
	default:
		return Transcript{}, fmt.Errorf("session %q runs harness %q, whose transcript format muxterm does not know "+
			"(readable: %s, %s)", row.SessionID, row.Harness, sessiond.HarnessAmplifier, sessiond.HarnessClaude)
	}
}

// amplifierProjectSlug turns an absolute working directory into the directory
// name Amplifier files a project under: "/" and "\" become "-", ":" is
// dropped, and the result is forced to start with "-".
//
//	/home/ken/workspace/muxterm  ->  -home-ken-workspace-muxterm
func amplifierProjectSlug(cwd string) string {
	s := strings.NewReplacer("/", "-", "\\", "-", ":", "").Replace(cwd)
	if !strings.HasPrefix(s, "-") {
		s = "-" + s
	}
	return s
}

// amplifierTranscriptPath is ~/.amplifier/projects/<slug>/sessions/<id>/transcript.jsonl.
//
// Returned in TILDE form, deliberately and load-bearingly: the home directory
// that matters belongs to the user on the machine that owns the file, which is
// not necessarily this one and which this process cannot look up. Expanding it
// here would produce this machine's home in a path handed to another machine --
// the exact silently-wrong-file answer the whole surface exists to prevent. The
// far daemon expands it against its own user (internal/sessiond/fsread.go
// resolveReadPath), and the local implementation follows the same rule.
//
// transcript.jsonl, NOT the events.jsonl sitting beside it. They are not two
// views of the same thing: events.jsonl is an internal firehose (276 MB for one
// session on this machine) and transcript.jsonl is the conversation.
func amplifierTranscriptPath(row sessiond.SessionState) string {
	return path.Join("~", ".amplifier", "projects",
		amplifierProjectSlug(row.Project), "sessions", row.SessionID, "transcript.jsonl")
}

// claudeTranscriptPath is ~/.claude/projects/<slug>/<session-uuid>.jsonl.
//
// The session id is un-prefixed first: the Claude adapter namespaces every
// snapshot it writes as "claude-<uuid>" so it can only ever delete its own
// files (claude_adapter.go), but the file on disk is named by the bare uuid.
//
// The slug rule here is "every path separator and dot becomes -", which is what
// the directories on disk actually show ("/tmp/tmp.zzZdvMf1Vb/repo" is filed as
// "-tmp-tmp-zzZdvMf1Vb-repo"). Because that rule is OBSERVED rather than
// documented by the vendor, a miss falls back to locating the uuid by name
// under projects/ -- the file name is the session id, so the search is exact,
// and it costs one directory listing only when the derived path was wrong.
// The lookup is bounded at THREE round trips (derive, list, retry) because it
// may now be crossing an ssh hop. The original filepath.Glob over
// projects/*/<uuid>.jsonl could not survive that: a glob is a directory walk,
// and a walk is one remote call per directory. Matching the project slug with a
// normalised comparison asks the same question -- which project directory is
// this session filed under -- in a fixed number of calls.
func claudeTranscriptPath(fsys transcriptFS, row sessiond.SessionState) string {
	uuid := strings.TrimPrefix(row.SessionID, "claude-")
	root := path.Join("~", ".claude", "projects")

	slug := strings.NewReplacer("/", "-", "\\", "-", ".", "-", ":", "-").Replace(row.Project)
	if !strings.HasPrefix(slug, "-") {
		slug = "-" + slug
	}
	direct := path.Join(root, slug, uuid+".jsonl")

	for _, name := range fsys.listNames(root) {
		if name == slug {
			return direct // the observed rule held; no second guess needed
		}
	}
	want := normaliseSlug(slug)
	for _, name := range fsys.listNames(root) {
		if normaliseSlug(name) == want {
			return path.Join(root, name, uuid+".jsonl")
		}
	}
	return direct // report the derived path in the not-found error
}

// normaliseSlug collapses every run of non-alphanumeric characters to a single
// "-" and lowercases the rest, so two spellings of the same project directory
// compare equal. The vendor's slug rule is OBSERVED rather than documented, so
// an exact match is the primary test and this is only the fallback.
func normaliseSlug(s string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(s) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			dash = false
			continue
		}
		if !dash {
			b.WriteByte('-')
			dash = true
		}
	}
	return strings.Trim(b.String(), "-")
}

// localTranscriptFS reads transcripts from this machine's filesystem directly.
// It expands "~" against this machine's home, which is the same rule the far
// daemon applies against its own.
type localTranscriptFS struct{}

func (localTranscriptFS) expand(p string) string {
	if p != "~" && !strings.HasPrefix(p, "~/") {
		return p
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return p
	}
	return filepath.Join(home, strings.TrimPrefix(strings.TrimPrefix(p, "~"), "/"))
}

// tail seeks to size-window and reads exactly the remainder, so peak allocation
// is `window` whatever the file's size and whatever the length of any single
// line inside it.
func (l localTranscriptFS) tail(p string, window int64) ([]byte, bool, error) {
	f, err := os.Open(l.expand(p))
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = f.Close() }()

	st, err := f.Stat()
	if err != nil {
		return nil, false, err
	}
	size := st.Size()
	start := int64(0)
	truncated := false
	if size > window {
		start = size - window
		truncated = true
	}
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return nil, false, err
	}
	buf := make([]byte, size-start)
	if _, err := io.ReadFull(f, buf); err != nil && err != io.ErrUnexpectedEOF {
		return nil, false, err
	}
	return buf, truncated, nil
}

func (l localTranscriptFS) listNames(dir string) []string {
	ents, err := os.ReadDir(l.expand(dir))
	if err != nil {
		return nil
	}
	out := make([]string, 0, len(ents))
	for _, e := range ents {
		out = append(out, e.Name())
	}
	return out
}

// daemonTranscriptFS reads transcripts through the sessiond daemon on the
// client's machine -- the ONLY way to reach a file that is not on this one.
//
// The tail is expressed as a NEGATIVE offset, which the protocol defines as
// "count back from the end of the file". That is what makes a bounded tail of
// an arbitrarily large append-only log cost exactly one round trip and no size
// guess: without it, a tail would need a stat call first, and a file that grew
// between the two calls would be read from the wrong place.
type daemonTranscriptFS struct{ c *Client }

func (d daemonTranscriptFS) tail(p string, window int64) ([]byte, bool, error) {
	from := -window
	reply, err := d.c.conn.ReadFile(p, &from, int(window))
	if err != nil {
		return nil, false, err
	}
	// Offset > 0 means the daemon started partway into the file, which is
	// exactly what "you are looking at a tail" means to the caller.
	return []byte(reply.Content), derefOffset(reply.Offset) > 0, nil
}

func (d daemonTranscriptFS) listNames(dir string) []string {
	reply, err := d.c.conn.ListDir(dir, 0)
	if err != nil {
		return nil
	}
	out := make([]string, 0, len(reply.Entries))
	for _, e := range reply.Entries {
		out = append(out, e.Name)
	}
	return out
}

// tailLines returns the last `window` bytes of path as lines.
//
// This is the bounded read the whole file exists to guarantee. When the read
// lands mid-line the leading fragment is discarded rather than handed to a JSON
// decoder that would reject it anyway.
//
// truncated reports that bytes were skipped, which is what the caller turns
// into "you are looking at a tail".
func tailLines(fsys transcriptFS, p string, window int64) (lines [][]byte, truncated bool, err error) {
	buf, truncated, err := fsys.tail(p, window)
	if err != nil {
		return nil, false, err
	}

	split := bytes.Split(buf, []byte("\n"))
	if truncated && len(split) > 0 {
		split = split[1:] // partial first line: the window began mid-line
	}
	out := make([][]byte, 0, len(split))
	for _, l := range split {
		if len(bytes.TrimSpace(l)) > 0 {
			out = append(out, l)
		}
	}
	return out, truncated, nil
}

// turnFn decodes one JSONL record into a turn. ok=false drops the record.
type turnFn func(raw []byte) (TranscriptTurn, bool)

// readJSONLTail is the shared body of both harnesses: take a bounded tail,
// decode each line with the harness's own rule, keep the last n that survived.
func readJSONLTail(fsys transcriptFS, harness, p string, n int, decode turnFn) (Transcript, error) {
	window := int64(n) * transcriptTailPerTurn
	if window < transcriptMinTail {
		window = transcriptMinTail
	}
	if window > transcriptMaxTail {
		window = transcriptMaxTail
	}

	lines, truncated, err := tailLines(fsys, p, window)
	if err != nil {
		if isNotExist(err) {
			return Transcript{}, fmt.Errorf("no %s transcript at %s "+
				"(the session may not have written one yet)", harness, p)
		}
		return Transcript{}, fmt.Errorf("reading %s transcript %s: %w", harness, p, err)
	}

	turns := make([]TranscriptTurn, 0, len(lines))
	for _, raw := range lines {
		t, ok := decode(raw)
		if !ok {
			continue
		}
		turns = append(turns, t)
	}
	if len(turns) > n {
		turns = turns[len(turns)-n:]
		truncated = true
	}
	return Transcript{Harness: harness, Path: p, Truncated: truncated, Turns: turns}, nil
}

// isNotExist recognises "no such file" from EITHER filesystem. The local one
// answers with an os error; the daemon answers with a *DaemonError carrying
// CodeFSNotFound, which os.IsNotExist knows nothing about. Missing the second
// form would turn "this session has not written a transcript yet" -- a normal,
// explainable state -- into an opaque protocol error, and only on remote
// machines, which is the worst place to have a worse error message.
func isNotExist(err error) bool {
	if os.IsNotExist(err) {
		return true
	}
	var de *sessiond.DaemonError
	if errors.As(err, &de) {
		return de.Code == sessiond.CodeFSNotFound
	}
	return false
}

// clip truncates s to transcriptMaxText runes and collapses it to a single
// line. Rune-aware so a cut never lands inside a multi-byte character and
// produces invalid UTF-8 in the result.
func clip(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	r := []rune(s)
	if len(r) <= transcriptMaxText {
		return s
	}
	return string(r[:transcriptMaxText]) + "..."
}

// --- amplifier -------------------------------------------------------------

// amplifierRecord is one line of an Amplifier transcript.jsonl. The
// discriminator is .role; .content is a plain string for user and tool records
// and an array of typed blocks for assistant records, so it is decoded lazily.
type amplifierRecord struct {
	Role     string          `json:"role"`
	Name     string          `json:"name"` // tool name, on role=tool
	Content  json.RawMessage `json:"content"`
	Metadata struct {
		Timestamp string `json:"timestamp"`
	} `json:"metadata"`
}

type amplifierBlock struct {
	Type string `json:"type"` // text | thinking | tool_call
	Text string `json:"text"`
	Name string `json:"name"` // tool name, on type=tool_call
}

func amplifierTurn(raw []byte) (TranscriptTurn, bool) {
	var rec amplifierRecord
	if err := json.Unmarshal(raw, &rec); err != nil {
		return TranscriptTurn{}, false // half-written tail line, or not a record
	}
	turn := TranscriptTurn{Role: rec.Role, TS: rec.Metadata.Timestamp}

	switch rec.Role {
	case "user", "tool":
		var s string
		if err := json.Unmarshal(rec.Content, &s); err != nil {
			return TranscriptTurn{}, false
		}
		turn.Text = clip(s)
		turn.Tool = rec.Name
	case "assistant":
		var blocks []amplifierBlock
		if err := json.Unmarshal(rec.Content, &blocks); err != nil {
			return TranscriptTurn{}, false
		}
		var text []string
		var tools []string
		for _, b := range blocks {
			switch b.Type {
			case "text", "thinking":
				text = append(text, b.Text)
			case "tool_call":
				tools = append(tools, b.Name)
			}
		}
		turn.Text = clip(strings.Join(text, " "))
		turn.Tool = strings.Join(tools, ",")
	default:
		return TranscriptTurn{}, false
	}
	return turn, true
}

// --- claude ----------------------------------------------------------------

// claudeRecord is one line of a Claude Code session jsonl.
//
// The discriminator is .type, NOT .role -- a user-authored turn and a tool
// result are both type "user", and telling them apart is what promptSource and
// origin.kind are for. Getting that wrong reports every tool result as
// something the human said.
type claudeRecord struct {
	Type         string `json:"type"`
	Timestamp    string `json:"timestamp"`
	PromptSource string `json:"promptSource"`
	Origin       struct {
		Kind string `json:"kind"`
	} `json:"origin"`
	Content json.RawMessage `json:"content"` // type=system
	Message struct {
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

type claudeBlock struct {
	Type     string `json:"type"` // thinking | text | tool_use | tool_result
	Text     string `json:"text"`
	Thinking string `json:"thinking"`
	Name     string `json:"name"` // tool name, on type=tool_use
	// Content is a tool_result's payload, which is a plain string about half
	// the time and a nested block array the rest of the time. Kept raw and
	// rendered by claudeBlocksText rather than typed, because the nested shape
	// varies by tool and none of it is worth modelling for a clipped preview.
	Content json.RawMessage `json:"content"`
}

func claudeTurn(raw []byte) (TranscriptTurn, bool) {
	var rec claudeRecord
	if err := json.Unmarshal(raw, &rec); err != nil {
		return TranscriptTurn{}, false
	}
	turn := TranscriptTurn{TS: rec.Timestamp}

	switch rec.Type {
	case "assistant":
		var blocks []claudeBlock
		if err := json.Unmarshal(rec.Message.Content, &blocks); err != nil {
			return TranscriptTurn{}, false
		}
		var text []string
		var tools []string
		for _, b := range blocks {
			switch b.Type {
			case "text":
				text = append(text, b.Text)
			case "thinking":
				text = append(text, b.Thinking)
			case "tool_use":
				tools = append(tools, b.Name)
			}
		}
		turn.Role = "assistant"
		turn.Text = clip(strings.Join(text, " "))
		turn.Tool = strings.Join(tools, ",")

	case "user":
		// A real human turn carries promptSource "typed" AND origin.kind
		// "human", and its content is a plain string. Everything else with
		// type "user" is a tool result being handed back to the model.
		if rec.PromptSource == "typed" && rec.Origin.Kind == "human" {
			var s string
			if err := json.Unmarshal(rec.Message.Content, &s); err != nil {
				return TranscriptTurn{}, false
			}
			turn.Role = "user"
			turn.Text = clip(s)
			break
		}
		var blocks []claudeBlock
		if err := json.Unmarshal(rec.Message.Content, &blocks); err != nil {
			return TranscriptTurn{}, false
		}
		turn.Role = "tool"
		turn.Text = clip(claudeBlocksText(blocks))

	case "system":
		// Claude system records frequently carry "content": null, and Go
		// unmarshals a JSON null into a string as "" with a nil error -- so
		// the err check alone lets every one of them through as an empty
		// turn. A caller reading the last N turns of a session would get a
		// run of blank rows that are initialisation bookkeeping, not
		// conversation, and would have to guess that. Drop them.
		var s string
		if err := json.Unmarshal(rec.Content, &s); err != nil {
			return TranscriptTurn{}, false
		}
		if strings.TrimSpace(s) == "" {
			return TranscriptTurn{}, false
		}
		turn.Role = "system"
		turn.Text = clip(s)

	default:
		// Everything else is bookkeeping, not conversation: ai-title, mode,
		// permission-mode, last-prompt, attachment, file-history-snapshot, and
		// queue-operation -- the last of which alone is roughly a third of the
		// records in a session file and says nothing about what happened.
		return TranscriptTurn{}, false
	}
	return turn, true
}

// claudeBlocksText flattens a tool_result content array into a preview string.
// A nested payload that is not a plain string is rendered as its raw JSON,
// which is exactly as informative as any structure-aware rendering would be at
// 400 characters. clip() bounds the result either way.
func claudeBlocksText(blocks []claudeBlock) string {
	var parts []string
	for _, b := range blocks {
		switch {
		case b.Text != "":
			parts = append(parts, b.Text)
		case b.Thinking != "":
			parts = append(parts, b.Thinking)
		case len(b.Content) > 0:
			var s string
			if err := json.Unmarshal(b.Content, &s); err == nil {
				parts = append(parts, s)
			} else {
				parts = append(parts, string(b.Content))
			}
		}
	}
	return strings.Join(parts, " ")
}
