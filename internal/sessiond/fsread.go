package sessiond

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// Read-only filesystem access, executed on the machine that owns the files.
//
// ⛔ THIS FILE IS THE READ-ONLY BOUNDARY, AND THE BOUNDARY IS THE ABSENCE OF
// CODE. Nothing here opens a file for writing, creates, truncates, renames,
// removes, chmods, chowns, or executes anything. There is no flag, argument or
// path that can make it do so, because the mutating call is not present to be
// reached. That is what makes the property structural rather than a promise
// checked at the edge: an argument validator can be bypassed by a second call
// site, a missing syscall cannot.
//
// The protocol above it is the other half of the same property: it defines
// read-file and list-dir and nothing else (protocol.go), so a frame asking the
// daemon to WRITE names an operation that does not exist and is dispatched to
// nothing.
//
// Every function here is bounded before it is executed. A remote read is not a
// local read: the caller is on the other side of an ssh pipe, cannot see how
// big the file is, and cannot interrupt a transfer already in flight. So the
// daemon decides how much it is willing to send, and it decides before it
// opens anything.

const (
	// FSMaxChunk is the hard ceiling on bytes returned by ONE read-file
	// reply, whatever the caller asks for and whatever the file's size. This
	// is the bound that makes "stream me a gigabyte over ssh" unrepresentable
	// rather than merely discouraged.
	//
	// 4 MiB matches the tail window the transcript reader already treats as
	// the largest reasonable single bounded read on this project
	// (internal/mcp/transcript.go transcriptMaxTail).
	FSMaxChunk = 4 << 20

	// FSDefaultChunk is what a request that names no limit receives. Small
	// enough to be cheap over a slow link, large enough for essentially every
	// configuration file, document and source file anyone reaches for.
	FSDefaultChunk = 256 << 10

	// FSMaxWholeFile bounds a WHOLE-FILE read -- a request with no offset,
	// meaning "give me this file" rather than "give me this window of it". A
	// file larger than this is refused with CodeFSTooLarge naming both the
	// limit and the file's real size.
	//
	// A windowed read (any non-nil offset, including zero) is exempt: it is
	// bounded by FSMaxChunk by construction, so it cannot stream gigabytes
	// however large the file is. That exemption is what lets a bounded tail
	// of a 300 MB append-only log work while a naive "read this log" is told
	// no, in words, with the number.
	FSMaxWholeFile = 64 << 20

	// FSDefaultDirEntries / FSMaxDirEntries bound one list-dir reply. A
	// directory with a million files must produce a truncated answer, not a
	// million-entry one.
	FSDefaultDirEntries = 500
	FSMaxDirEntries     = 2000
)

// FSError is a read-only filesystem failure carrying the stable code the
// daemon puts on the wire. Every failure below is one of these, so no caller
// ever has to pattern-match on error text to tell a missing file from a
// permission denial.
type FSError struct {
	Code string
	Msg  string
}

// Error implements the error interface.
func (e *FSError) Error() string { return e.Msg }

func fsErr(code, format string, a ...any) *FSError {
	return &FSError{Code: code, Msg: fmt.Sprintf(format, a...)}
}

// classifyFSError maps an os error onto a stable code. Anything unrecognised
// keeps its own text under CodeFSNotFound's sibling category rather than being
// silently relabelled as something more specific than we know.
func classifyFSError(op, path string, err error) *FSError {
	switch {
	case os.IsNotExist(err):
		return fsErr(CodeFSNotFound, "%s %s: no such file or directory on this machine", op, path)
	case os.IsPermission(err):
		return fsErr(CodeFSPermission, "%s %s: permission denied for the user this daemon runs as", op, path)
	default:
		return fsErr(CodeFSBadPath, "%s %s: %v", op, path, err)
	}
}

// resolveReadPath turns a caller-supplied path into the absolute, symlink-free
// path that will actually be read, and reports both.
//
// THE RULE, stated once and enforced in one place:
//
//   - An ABSOLUTE path is used as given.
//   - A path beginning "~" or "~/" expands to the home directory of the user
//     THIS DAEMON RUNS AS, on THIS machine. There is no other home it could
//     honestly mean: the daemon has one identity and reads as that identity.
//   - "~otheruser/..." is REFUSED. Expanding it would mean guessing at a passwd
//     lookup and could hand back a file belonging to someone the caller never
//     named.
//   - A RELATIVE path is REFUSED. The obvious base -- the daemon's working
//     directory -- is an implementation detail of however sessiond happened to
//     be started (a systemd unit, a login shell, "/"), it is invisible from the
//     calling machine, and it can differ between two machines that look
//     identical. Answering "config.toml" against it would be exactly the
//     silently-wrong-file failure this whole surface exists to avoid. The
//     conservative choice is to make the caller say which file it means.
//   - SYMLINKS ARE FOLLOWED, BUT NEVER SILENTLY. The resolved path is returned
//     on every reply, so a caller that asked for one path and is being handed
//     another can see it. Refusing symlinks outright was considered and
//     rejected: it would break ordinary, honest layouts (/home, /var/run,
//     per-machine dotfile farms) for no gain, since the resolved path is the
//     information the caller actually needs.
func resolveReadPath(p string) (requested, resolved string, err error) {
	p = strings.TrimSpace(p)
	if p == "" {
		return "", "", fsErr(CodeFSBadPath, "no path given")
	}

	switch {
	case p == "~" || strings.HasPrefix(p, "~/"):
		home, herr := os.UserHomeDir()
		if herr != nil || home == "" {
			return "", "", fsErr(CodeFSBadPath,
				"path %q starts with ~ but the home directory of the user this daemon runs as could not be determined", p)
		}
		p = filepath.Join(home, strings.TrimPrefix(strings.TrimPrefix(p, "~"), "/"))
	case strings.HasPrefix(p, "~"):
		return "", "", fsErr(CodeFSBadPath,
			"path %q expands another user's home directory, which this surface will not guess at; give an absolute path instead", p)
	}

	if !filepath.IsAbs(p) {
		return "", "", fsErr(CodeFSBadPath,
			"path %q is relative; give an absolute path or one starting with ~/. "+
				"The daemon's working directory is an implementation detail and is never used as a base, "+
				"because resolving against it would silently return a different file than the caller meant", p)
	}
	requested = filepath.Clean(p)

	resolved, rerr := filepath.EvalSymlinks(requested)
	if rerr != nil {
		return requested, "", classifyFSError("resolving", requested, rerr)
	}
	return requested, resolved, nil
}

// FileRead is the result of one bounded read.
type FileRead struct {
	Path         string
	ResolvedPath string
	Content      string
	Offset       int64
	FileSize     int64
	NextOffset   *int64
	EOF          bool
	Truncated    bool
}

// ReadFileBounded reads at most one bounded window of a regular file and
// returns it as text.
//
// offset is nil for "read this file" (subject to FSMaxWholeFile), non-nil for
// "read this window" (any file size, bounded by FSMaxChunk). A negative offset
// counts back from the end of the file, which is how a caller takes a tail
// without first having to learn the size.
//
// limit <= 0 means FSDefaultChunk; anything above FSMaxChunk is clamped here,
// on the daemon, so the ceiling holds no matter what any client sends.
func ReadFileBounded(path string, offset *int64, limit int) (*FileRead, error) {
	requested, resolved, err := resolveReadPath(path)
	if err != nil {
		return nil, err
	}

	// STAT BEFORE OPEN, and the order is not incidental. Opening a FIFO for
	// reading BLOCKS until some other process opens it for writing, so a
	// read-file aimed at a named pipe would hang the daemon's connection with
	// no error and no timeout on this side. Refusing every non-regular file
	// before anything is opened makes that unreachable.
	st, serr := os.Stat(resolved)
	if serr != nil {
		return nil, classifyFSError("reading", requested, serr)
	}
	switch {
	case st.IsDir():
		return nil, fsErr(CodeFSIsDir, "%s is a directory, not a file; use list_dir to see what is in it", requested)
	case !st.Mode().IsRegular():
		return nil, fsErr(CodeFSNotRegular,
			"%s is not a regular file (mode %s); reading a device, socket or named pipe would block or return something that is not the file's contents",
			requested, st.Mode())
	}
	size := st.Size()

	if limit <= 0 {
		limit = FSDefaultChunk
	}
	if limit > FSMaxChunk {
		limit = FSMaxChunk
	}

	start := int64(0)
	if offset == nil {
		// Whole-file read: the caller said "this file", not "this window".
		if size > FSMaxWholeFile {
			return nil, fsErr(CodeFSTooLarge,
				"%s is %d bytes, over the %d-byte whole-file limit; pass an offset (0 to page from the start, a negative value to tail from the end) to read it in bounded pieces",
				requested, size, int64(FSMaxWholeFile))
		}
	} else {
		start = *offset
		if start < 0 {
			// Tail: count back from the end, clamped at the start of file.
			start = size + start
			if start < 0 {
				start = 0
			}
		}
	}

	res := &FileRead{Path: requested, ResolvedPath: resolved, FileSize: size, Offset: start}

	if start >= size {
		// Past the end is not an error; it is an empty window at EOF. A
		// paging loop terminates here rather than having to special-case it.
		res.EOF = true
		return res, nil
	}

	// READ-ONLY, SPELLED OUT. os.Open would do the same thing; the explicit
	// O_RDONLY with a zero mode is here so that the one place this process
	// opens a file on a caller's behalf says on its face that it cannot
	// create and cannot write.
	f, oerr := os.OpenFile(resolved, os.O_RDONLY, 0)
	if oerr != nil {
		return nil, classifyFSError("reading", requested, oerr)
	}
	defer func() { _ = f.Close() }()

	want := size - start
	if want > int64(limit) {
		want = int64(limit)
	}
	buf := make([]byte, want)
	n, rerr := f.ReadAt(buf, start)
	if rerr != nil && rerr != io.EOF {
		return nil, classifyFSError("reading", requested, rerr)
	}
	buf = buf[:n]
	end := start + int64(n)

	// A caller-chosen offset can land in the middle of a multi-byte rune, at
	// either end of the window. Neither is a binary file, and reporting one as
	// such would be a lie about a perfectly good UTF-8 document, so both are
	// trimmed and the adjusted offsets are REPORTED rather than hidden.
	if start > 0 {
		trimmed := 0
		for trimmed < len(buf) && trimmed < utf8.UTFMax-1 && isUTF8Continuation(buf[trimmed]) {
			trimmed++
		}
		buf = buf[trimmed:]
		start += int64(trimmed)
		res.Offset = start
	}
	if end < size && len(buf) > 0 {
		// utf8.FullRune is what separates the two cases that look identical to
		// a naive validity check: a TRUNCATED rune at the window's edge (trim
		// it; the rest of its bytes arrive in the next page) and an INVALID
		// byte (a real binary file, which must be reported, not shaved away).
		i := len(buf) - 1
		for i > 0 && len(buf)-i < utf8.UTFMax && isUTF8Continuation(buf[i]) {
			i--
		}
		if !utf8.FullRune(buf[i:]) {
			end -= int64(len(buf) - i)
			buf = buf[:i]
		}
	}

	if !utf8.Valid(buf) {
		return nil, fsErr(CodeFSNotText,
			"%s is not valid UTF-8 at byte %d, so its contents cannot be returned as text; this surface reads text files only",
			requested, start+int64(firstInvalidUTF8(buf)))
	}

	res.Content = string(buf)
	res.EOF = end >= size
	if !res.EOF {
		next := end
		res.NextOffset = &next
		res.Truncated = true
	}
	return res, nil
}

// isUTF8Continuation reports whether b is a UTF-8 continuation byte (10xxxxxx),
// i.e. a byte that cannot begin a rune.
func isUTF8Continuation(b byte) bool { return b&0xC0 == 0x80 }

// firstInvalidUTF8 returns the byte index at which b stops being valid UTF-8,
// so an error can name where the binary content starts instead of only that it
// exists somewhere.
func firstInvalidUTF8(b []byte) int {
	for i := 0; i < len(b); {
		r, size := utf8.DecodeRune(b[i:])
		if r == utf8.RuneError && size <= 1 {
			return i
		}
		i += size
	}
	return len(b)
}

// DirList is the result of one bounded directory listing.
type DirList struct {
	Path         string
	ResolvedPath string
	Entries      []DirEntryInfo
	Truncated    bool
}

// ListDirBounded lists at most limit entries of a directory, name-sorted.
//
// limit <= 0 means FSDefaultDirEntries; anything above FSMaxDirEntries is
// clamped here on the daemon. Truncated reports that more entries existed and
// were not returned, so a caller never mistakes a capped listing for a complete
// one.
//
// Entry kinds come from the directory entry's own type, which is an LSTAT: a
// symlink is reported as a symlink with its target, not as whatever it points
// at. Size and mode come from an LSTAT too, and a per-entry stat failure
// (a dangling symlink, a race with a delete) degrades that one row rather than
// failing the whole listing -- a directory you can read should list even when
// one thing in it is broken.
func ListDirBounded(path string, limit int) (*DirList, error) {
	requested, resolved, err := resolveReadPath(path)
	if err != nil {
		return nil, err
	}

	st, serr := os.Stat(resolved)
	if serr != nil {
		return nil, classifyFSError("listing", requested, serr)
	}
	if !st.IsDir() {
		return nil, fsErr(CodeFSNotDir, "%s is not a directory; use read_file to read it", requested)
	}

	if limit <= 0 {
		limit = FSDefaultDirEntries
	}
	if limit > FSMaxDirEntries {
		limit = FSMaxDirEntries
	}

	names, rerr := os.ReadDir(resolved)
	if rerr != nil {
		return nil, classifyFSError("listing", requested, rerr)
	}
	sort.Slice(names, func(i, j int) bool { return names[i].Name() < names[j].Name() })

	out := &DirList{Path: requested, ResolvedPath: resolved}
	if len(names) > limit {
		names = names[:limit]
		out.Truncated = true
	}

	out.Entries = make([]DirEntryInfo, 0, len(names))
	for _, e := range names {
		row := DirEntryInfo{Name: e.Name(), Kind: entryKind(e.Type())}
		if info, ierr := e.Info(); ierr == nil {
			row.Size = info.Size()
			row.Mode = info.Mode().String()
			row.ModTime = info.ModTime().UTC().Format(time.RFC3339)
		}
		if row.Kind == "symlink" {
			if target, lerr := os.Readlink(filepath.Join(resolved, e.Name())); lerr == nil {
				row.SymlinkTo = target
			}
		}
		out.Entries = append(out.Entries, row)
	}
	return out, nil
}

// entryKind renders a directory entry's type as one of four stable tokens.
// "other" covers devices, sockets and fifos as a group: the caller's next move
// is the same for all of them (do not try to read it), so naming each one
// separately would add vocabulary without adding a decision.
func entryKind(m os.FileMode) string {
	switch {
	case m&os.ModeSymlink != 0:
		return "symlink"
	case m.IsDir():
		return "dir"
	case m.IsRegular():
		return "file"
	default:
		return "other"
	}
}
