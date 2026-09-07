package mcp

import (
	"fmt"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// Read-only file access across the machine boundary.
//
// The gap these two tools close: a chief-of-staff session can SEE a remote
// pane's scrollback through get_screen, but could not read the file the work
// actually lives in. Terminal output was reachable; the document beside it was
// not.
//
// They are machine-scoped exactly the way PR #90's tools are -- a "machine"
// parameter, absent meaning local, resolved through machines.resolve, and never
// silently answered with this machine when a remote was named. Both run through
// the same wrap() the other sessiond-backed tools use, so a remote that goes
// quiet produces a wall-clock timeout NAMING THE MACHINE rather than a hang,
// and never a local answer to a remote question.
//
// ⛔ READ-ONLY, AND NOT BY POLITENESS. There is no write, create, delete,
// rename, chmod or exec tool here, and no argument to either of these can
// become one: the operation executes in internal/sessiond/fsread.go on the far
// machine, and that file contains no mutating syscall. See its header.

const (
	// fsToolDefaultBytes is what read_file returns when the caller names no
	// limit. Deliberately far below the daemon's own 4 MiB ceiling, because
	// the two bounds protect different things: the daemon's protects the wire
	// and the far machine, this one protects the CALLER'S CONTEXT WINDOW. A
	// tool result is text an agent has to carry, and 4 MiB of it would flood
	// the very session that asked for it.
	fsToolDefaultBytes = 64 << 10

	// fsToolMaxBytes caps an explicit limit at the tool. The daemon clamps
	// again on its side; a bound that only one end enforces is a bound that
	// stops existing the moment something else speaks the protocol.
	fsToolMaxBytes = 1 << 20
)

// fsTools binds the read-only filesystem tools to one resolved client, which
// is either this machine's daemon or a named remote's. Which one it is has
// already been decided by clientPool.get before this exists.
type fsTools struct{ c *Client }

func newFSTools(c *Client) *fsTools { return &fsTools{c: c} }

// readFile returns a bounded window of a file on the client's machine.
//
// The bounds and their reasons:
//   - limit: bytes per call, default 64 KiB, capped at 1 MiB here and 4 MiB at
//     the daemon.
//   - offset: absent means "read this file" and a file over the daemon's 64 MiB
//     whole-file limit is refused BY NAME with its actual size. Present --
//     including 0 -- means "read this window" and works at any file size.
//     Negative counts back from the end, which is how a large file is tailed
//     without first learning its size.
//   - the wall-clock bound applied by wrap(), which names the machine.
func (ft *fsTools) readFile(args map[string]any) (string, error) {
	path, err := argString(args, "path")
	if err != nil {
		return "", err
	}

	limit := fsToolDefaultBytes
	if n, lerr := argInt(args, "limit"); lerr == nil {
		if n <= 0 {
			return "", fmt.Errorf("argument limit: must be a positive number of bytes, got %d", n)
		}
		limit = n
	}
	if limit > fsToolMaxBytes {
		limit = fsToolMaxBytes
	}

	var offset *int64
	if raw, present := args["offset"]; present && raw != nil {
		n, oerr := argInt(args, "offset")
		if oerr != nil {
			return "", oerr
		}
		v := int64(n)
		offset = &v
	}

	reply, err := ft.c.conn.ReadFile(path, offset, limit)
	if err != nil {
		return "", ft.fsError("read_file", path, err)
	}

	out := map[string]any{
		"machine":   ft.c.Machine(),
		"path":      reply.Path,
		"size":      reply.FileSize,
		"offset":    derefOffset(reply.Offset),
		"bytes":     len(reply.Content),
		"eof":       reply.EOF,
		"truncated": reply.Truncated,
		"content":   reply.Content,
	}
	// Reported ONLY when it differs, so its presence is the signal: this is a
	// different file from the one you named, and here is which one.
	if reply.ResolvedPath != "" && reply.ResolvedPath != reply.Path {
		out["resolved_path"] = reply.ResolvedPath
		out["followed_symlink"] = true
	}
	if reply.NextOffset != nil {
		out["next_offset"] = *reply.NextOffset
	}
	return jsonText(out), nil
}

// listDir lists a directory on the client's machine.
func (ft *fsTools) listDir(args map[string]any) (string, error) {
	path, err := argString(args, "path")
	if err != nil {
		return "", err
	}
	limit := 0 // 0 = take the daemon's default
	if n, lerr := argInt(args, "limit"); lerr == nil {
		if n <= 0 {
			return "", fmt.Errorf("argument limit: must be a positive number of entries, got %d", n)
		}
		limit = n
	}

	reply, err := ft.c.conn.ListDir(path, limit)
	if err != nil {
		return "", ft.fsError("list_dir", path, err)
	}

	entries := make([]map[string]any, 0, len(reply.Entries))
	for _, e := range reply.Entries {
		row := map[string]any{"name": e.Name, "kind": e.Kind, "size": e.Size}
		if e.Mode != "" {
			row["mode"] = e.Mode
		}
		if e.ModTime != "" {
			row["modified"] = e.ModTime
		}
		if e.SymlinkTo != "" {
			row["symlink_to"] = e.SymlinkTo
		}
		entries = append(entries, row)
	}

	out := map[string]any{
		"machine":   ft.c.Machine(),
		"path":      reply.Path,
		"count":     len(entries),
		"truncated": reply.Truncated,
		"entries":   entries,
	}
	if reply.ResolvedPath != "" && reply.ResolvedPath != reply.Path {
		out["resolved_path"] = reply.ResolvedPath
		out["followed_symlink"] = true
	}
	return jsonText(out), nil
}

// fsError renders a daemon filesystem failure with the machine named.
//
// Naming the machine is not decoration. "no such file or directory: /etc/foo"
// is a question ("on which machine?") rather than an answer, and the whole
// hazard this surface is built around is a reader who believes they are looking
// at one machine while looking at another.
func (ft *fsTools) fsError(op, path string, err error) error {
	// The daemon's own message already names the path, so repeating it here
	// would produce "read /x: resolving /x: no such file". What this layer adds
	// is the machine and the stable code.
	if de, ok := err.(*sessiond.DaemonError); ok {
		return fmt.Errorf("machine %q: %s: [%s] %s", ft.c.Machine(), op, de.Code, de.Err)
	}
	return fmt.Errorf("machine %q: %s %s: %w", ft.c.Machine(), op, path, err)
}

// derefOffset renders a possibly-absent wire offset as a plain number. The
// pointer distinguishes "not paging" from "paging from zero" on the REQUEST;
// on a reply the offset is always known, so a nil here is simply zero.
func derefOffset(p *int64) int64 {
	if p == nil {
		return 0
	}
	return *p
}

// registerFSTools registers read_file and list_dir.
func registerFSTools(srv *Server, wrap func(func(*Client, map[string]any) (string, error)) ToolFunc) {
	srv.Register(
		"read_file",
		"read a file on a machine, as text, READ-ONLY. Defaults to this machine; pass machine to read a file on "+
			"a connected remote instead -- this is the only way to see a file that is not on this machine. "+
			"path must be ABSOLUTE or start with ~/ (which expands to the home of the user the daemon on THAT "+
			"machine runs as); a relative path is refused rather than resolved against an invisible working "+
			"directory. Bounded on purpose: at most 64 KiB per call by default and 1 MiB with an explicit limit; "+
			"a file over 64 MiB is refused by name unless you pass an offset. Pass offset to read a window "+
			"(0 to page from the start, NEGATIVE to tail from the end) -- windowed reads work at any file size, "+
			"and next_offset in the result is what to pass next. eof reports whether the window reached the end. "+
			"Distinct errors, not one shrug: fs-not-found, fs-is-a-directory, fs-permission-denied, "+
			"fs-file-too-large, fs-not-utf8, fs-not-a-regular-file. There is NO write, create, delete or execute "+
			"counterpart to this tool at any layer",
		map[string]any{
			"type": "object",
			"properties": withMachine(map[string]any{
				"path": map[string]any{
					"type":        "string",
					"description": "absolute path on that machine, or one starting with ~/ ; a relative path is an error",
				},
				"offset": map[string]any{
					"type": "integer",
					"description": "byte offset to read from. Omit to read the file from the start (refused above 64 MiB). " +
						"0 or more pages from that byte; negative counts back from the END of the file (a tail), " +
						"which works at any file size",
				},
				"limit": map[string]any{
					"type":        "integer",
					"description": "maximum bytes to return (default 65536, max 1048576)",
				},
			}),
			"required": []string{"path"},
		},
		wrap(func(c *Client, args map[string]any) (string, error) {
			return newFSTools(c).readFile(args)
		}),
	)

	srv.Register(
		"list_dir",
		"list a directory on a machine, READ-ONLY. Defaults to this machine; pass machine to list a directory on "+
			"a connected remote instead. Each entry carries name, kind (file|dir|symlink|other), size, mode and "+
			"modified time; a symlink is reported AS a symlink with symlink_to, never silently as what it points "+
			"at. path follows the same rule as read_file: absolute, or starting with ~/. Bounded: 500 entries by "+
			"default, 2000 maximum, and truncated=true in the result means more existed and were not returned. "+
			"Use this to navigate to a file, then read_file to read it",
		map[string]any{
			"type": "object",
			"properties": withMachine(map[string]any{
				"path": map[string]any{
					"type":        "string",
					"description": "absolute directory path on that machine, or one starting with ~/",
				},
				"limit": map[string]any{
					"type":        "integer",
					"description": "maximum entries to return (default 500, max 2000)",
				},
			}),
			"required": []string{"path"},
		},
		wrap(func(c *Client, args map[string]any) (string, error) {
			return newFSTools(c).listDir(args)
		}),
	)
}
