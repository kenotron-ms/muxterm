package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// The /api/files route: one directory listing, annotated with git status, for
// Mission Control's Files applet.
//
//	GET /api/files[?path=<absolute path>]   list that directory
//
// AuthMiddleware protects this route at mux registration, exactly like the
// config, AI, tunnel and remotes routes.
//
// SECURITY. This route is wrapped in protect() like every other /api route, and
// it adds NO authority beyond what /ws already grants -- the same auth boundary
// hands out a PTY, and a shell can cat any file this handler can list. So the
// guard here is CORRECTNESS (absolute, cleaned, actually a directory) rather
// than a jail, and it is deliberately not a jail. Do not invent a chroot: it
// would constrain the file browser without constraining the terminal sitting
// next to it, which is security theatre with a maintenance cost.
//
// The git half is best-effort by design. A directory outside any worktree, a
// machine with no git, or a `git status` that fails still returns the full
// listing with gitAvailable=false and one sentence in gitError. Losing the
// annotations must never cost the user the file listing.

// filesGitDeadline bounds the WHOLE git interrogation of one directory -- the
// toplevel lookup, the branch lookup and the status pass together, not each --
// so a wedged git cannot stack three timeouts onto one GET.
const filesGitDeadline = 5 * time.Second

// The status vocabulary on the wire. An entry with nothing to report carries
// "", which is why there is no constant for it: it is the absence of a status,
// not a status.
const (
	fileStatusModified   = "modified"
	fileStatusAdded      = "added"
	fileStatusDeleted    = "deleted"
	fileStatusUntracked  = "untracked"
	fileStatusRenamed    = "renamed"
	fileStatusConflicted = "conflicted"
)

// fileEntry is one row of the listing.
//
// Size and Modified come from Lstat, NOT Stat: a symlink reports its own size
// and its own mtime, and a symlink to a directory reports dir=false. Following
// it would let a listing hang on a dead NFS mount and would report a directory
// the user cannot expand as expandable.
type fileEntry struct {
	Name     string `json:"name"`
	Dir      bool   `json:"dir"`
	Size     int64  `json:"size"`
	Modified int64  `json:"modified"` // unix seconds
	Status   string `json:"status"`   // "" | modified | added | deleted | untracked | renamed | conflicted
}

// filesListResponse is GET /api/files. Entries is ALWAYS present and never
// null: the browser iterates it unconditionally.
type filesListResponse struct {
	Path         string      `json:"path"`         // the cleaned absolute directory listed
	Parent       string      `json:"parent"`       // "" at the filesystem root
	RepoRoot     string      `json:"repoRoot"`     // "" when not inside a worktree
	Branch       string      `json:"branch"`       // "" when detached or not a worktree
	GitAvailable bool        `json:"gitAvailable"` // false when git is missing, this is no worktree, or status failed
	GitError     string      `json:"gitError"`     // one human sentence when GitAvailable is false
	Entries      []fileEntry `json:"entries"`
}

func writeFilesJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v) //nolint:errcheck
}

// writeFilesError renders every 4xx/5xx body: {"error": "<sentence>"}.
func writeFilesError(w http.ResponseWriter, code int, err error) {
	writeFilesJSON(w, code, map[string]any{"error": err.Error()})
}

// handleFilesList answers GET /api/files[?path=<absolute path>].
//
// ?path is optional as a KEY and required as a VALUE: omitting it entirely
// means "wherever this server process is", which is the only sensible opening
// directory for a browser that has not chosen one yet; sending it empty is a
// caller bug and says so. Anything relative is refused rather than resolved
// against the server's cwd, because a browser that thinks it is asking for
// "web/src" and gets a listing of somewhere else has been lied to.
//
// AuthMiddleware protects this route at mux registration.
func (s *Server) handleFilesList(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	dir := q.Get("path")
	if !q.Has("path") {
		cwd, err := os.Getwd()
		if err != nil {
			writeFilesError(w, http.StatusInternalServerError, fmt.Errorf("this server cannot determine its own working directory: %w", err))
			return
		}
		dir = cwd
	}
	if strings.TrimSpace(dir) == "" {
		writeFilesError(w, http.StatusBadRequest, errors.New(`"path" is required and must be an absolute path`))
		return
	}
	if !filepath.IsAbs(dir) {
		writeFilesError(w, http.StatusBadRequest, fmt.Errorf("%q is not an absolute path", dir))
		return
	}
	dir = filepath.Clean(dir)

	info, err := os.Stat(dir)
	switch {
	case os.IsNotExist(err):
		writeFilesError(w, http.StatusNotFound, fmt.Errorf("%s does not exist", dir))
		return
	case err != nil:
		writeFilesError(w, http.StatusInternalServerError, err)
		return
	case !info.IsDir():
		writeFilesError(w, http.StatusBadRequest, fmt.Errorf("%s is not a directory", dir))
		return
	}

	git := inspectGit(r.Context(), dir)

	entries, err := readDirEntries(dir, git.changed)
	if err != nil {
		writeFilesError(w, http.StatusInternalServerError, err)
		return
	}

	writeFilesJSON(w, http.StatusOK, filesListResponse{
		Path:         dir,
		Parent:       parentOf(dir),
		RepoRoot:     git.repoRoot,
		Branch:       git.branch,
		GitAvailable: git.err == "",
		GitError:     git.err,
		Entries:      entries,
	})
}

// parentOf returns the directory above dir, or "" when dir IS the top. The
// filesystem root is its own Dir, and so is a volume root on Windows, which is
// what makes this comparison the portable spelling of "no parent".
func parentOf(dir string) string {
	parent := filepath.Dir(dir)
	if parent == dir {
		return ""
	}
	return parent
}

// readDirEntries lists dir and annotates each row from the changed-path map.
//
// An entry whose Lstat fails is SKIPPED rather than failing the listing: a file
// deleted between the readdir and the stat is normal on a live worktree, and
// losing the whole directory over one racing temp file would make the applet
// flicker into an error on every build.
func readDirEntries(dir string, changed map[string]string) ([]fileEntry, error) {
	names, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}

	// Never null. An empty directory is an empty array.
	out := make([]fileEntry, 0, len(names))
	for _, de := range names {
		// Lstat, not Stat: see fileEntry. Dotfiles are included -- in a
		// worktree they are exactly the files a developer edits.
		info, err := os.Lstat(filepath.Join(dir, de.Name()))
		if err != nil {
			continue
		}
		row := fileEntry{
			Name:     de.Name(),
			Dir:      info.IsDir(),
			Size:     info.Size(),
			Modified: info.ModTime().Unix(),
		}
		row.Status = statusFor(filepath.Join(dir, de.Name()), row.Dir, changed)
		out = append(out, row)
	}
	out = appendDeleted(dir, changed, out)

	// Directories first, then files, each case-insensitively by name. The
	// case-sensitive tie-break makes the order total, so two names differing
	// only in case cannot swap places between polls.
	sort.Slice(out, func(i, j int) bool {
		if out[i].Dir != out[j].Dir {
			return out[i].Dir
		}
		li, lj := strings.ToLower(out[i].Name), strings.ToLower(out[j].Name)
		if li != lj {
			return li < lj
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}

// appendDeleted adds a row for every path git calls DELETED that is a direct
// child of dir and is therefore no longer on disk for ReadDir to have found.
//
// WHY THIS EXISTS. The listing is built from what the filesystem holds, and a
// deleted file is precisely the thing that is not there any more -- so without
// this, a "changed" filter would confidently show a directory with an unstaged
// `rm` in it as having nothing changed. That is the one failure mode a status
// filter must not have: silently omitting a change while claiming to show
// changes. The frontend has always been ready for these rows (a deleted name is
// struck through); it was the server that never produced one.
//
// Only DIRECT children, and only paths that really are absent: a path that
// still exists was already emitted above with its own status, and emitting it
// twice would put the same name in the list twice.
//
// Size and Modified are zero, honestly: there is no file to measure.
func appendDeleted(dir string, changed map[string]string, out []fileEntry) []fileEntry {
	for p, st := range changed {
		if st != fileStatusDeleted {
			continue
		}
		if filepath.Dir(p) != dir {
			continue
		}
		if _, err := os.Lstat(p); err == nil {
			continue
		}
		out = append(out, fileEntry{Name: filepath.Base(p), Status: fileStatusDeleted})
	}
	return out
}

// statusFor resolves one entry's status against the changed-path map.
//
// A file gets a status only when git named it exactly. A DIRECTORY also gets
// "modified" when anything under it changed, whatever that change was: rolling
// up an "untracked" child as "untracked" would claim the directory itself is
// untracked, which is a different and usually false statement. "modified"
// means "there is something in here", which is all a collapsed row can honestly
// say.
//
// The scan is linear in the number of changed paths per entry. Bounded by a
// directory listing on one side and a worktree's dirty set on the other, that
// is a few thousand string comparisons on a bad day -- cheaper than the git
// subprocess that produced the map.
func statusFor(abs string, isDir bool, changed map[string]string) string {
	if st, ok := changed[abs]; ok {
		return st
	}
	if !isDir {
		return ""
	}
	prefix := abs + string(filepath.Separator)
	for p := range changed {
		if strings.HasPrefix(p, prefix) {
			return fileStatusModified
		}
	}
	return ""
}

// filesGit is what one git interrogation of a directory yields. err carries one
// human sentence and is the single source of gitAvailable: when it is empty the
// other three fields are trustworthy, and when it is not they are whatever
// could be learned before the failure.
type filesGit struct {
	repoRoot string
	branch   string
	changed  map[string]string // absolute path -> status token
	err      string
}

// inspectGit derives repo root, branch and the changed-path map for dir.
//
// Every failure path here is survivable and returns a filesGit the caller can
// still render: git missing, dir outside any worktree, or a status that failed.
// The one thing it never does is return an error that costs the caller its
// listing.
func inspectGit(ctx context.Context, dir string) filesGit {
	out := filesGit{changed: map[string]string{}}

	// LookPath first, so a machine with no git is a clean degraded state
	// rather than an exec error dressed up as a git failure.
	bin, err := exec.LookPath("git")
	if err != nil {
		out.err = "git is not on PATH"
		return out
	}

	ctx, cancel := context.WithTimeout(ctx, filesGitDeadline)
	defer cancel()

	root, err := runGit(ctx, bin, "-C", dir, "rev-parse", "--show-toplevel")
	if err != nil {
		// The overwhelmingly common cause is exactly what it says. Anything
		// rarer (an unreadable .git, a version too old) still leaves the user
		// with a working listing and a pointer at git.
		out.err = "not a git worktree"
		return out
	}
	out.repoRoot = filepath.Clean(root)

	// A branch lookup that fails is NOT fatal: an unborn HEAD (a repo with no
	// commits yet) has no branch to name but does have a status worth showing.
	// Detached HEAD reports the literal "HEAD", which is not a branch name, so
	// it reports as no branch at all.
	if branch, err := runGit(ctx, bin, "-C", dir, "rev-parse", "--abbrev-ref", "HEAD"); err == nil && branch != "HEAD" {
		out.branch = branch
	}

	// -C the ROOT, not dir: porcelain paths are then unambiguously relative to
	// the root, whichever subdirectory was asked for.
	status, err := runGitRaw(ctx, bin, "-C", out.repoRoot, "status", "--porcelain=v1", "--untracked-files=all", "-z")
	if err != nil {
		out.err = "git status failed: " + gitErrText(err)
		return out
	}
	out.changed = parsePorcelainZ(out.repoRoot, status)
	return out
}

// runGit runs one git subcommand and returns its trimmed stdout.
func runGit(ctx context.Context, bin string, args ...string) (string, error) {
	out, err := runGitRaw(ctx, bin, args...)
	return strings.TrimSpace(out), err
}

// runGitRaw runs one git subcommand and returns stdout BYTE-FOR-BYTE.
//
// Output(), never CombinedOutput(): stderr interleaved into a NUL-separated
// record stream would be parsed as filenames. stdin is nil so a git that
// decides to prompt (a credential helper, say) hits EOF immediately instead of
// hanging until the deadline.
func runGitRaw(ctx context.Context, bin string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Stdin = nil
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// gitErrText renders a subprocess failure as one human sentence, preferring
// git's own words on stderr to Go's "exit status 128".
func gitErrText(err error) string {
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		if msg := strings.TrimSpace(string(ee.Stderr)); msg != "" {
			if i := strings.IndexByte(msg, '\n'); i >= 0 {
				msg = msg[:i]
			}
			return msg
		}
	}
	return err.Error()
}

// parsePorcelainZ turns `status --porcelain=v1 -z` output into absolute path ->
// status token.
//
// The record is "XY<space>PATH" with NO trailing newline and no quoting: -z
// disables the quoting that would otherwise mangle a filename with a space,
// a quote or a newline in it, which is the reason this route pays for the NUL
// form instead of splitting lines.
//
// Renames are the one place the -z form differs from the human-readable one,
// and it is inverted from what the arrow suggests. Verified against a real
// repository:
//
//	human:  R  orig.txt -> renamed.txt
//	-z:     R  renamed.txt<NUL>orig.txt<NUL>
//
// so the record's OWN path is the DESTINATION and the extra field that follows
// is the ORIGIN. Consuming that extra field is not cosmetic: skip it and the
// origin is read as the next record's "XY path", and every status after the
// first rename is garbage.
//
// Only the destination is recorded. It is the path that exists on disk and
// therefore the only one that can appear in a listing, and for a copy (C) the
// origin genuinely has not changed -- claiming it did would be a lie about a
// file git says is clean.
func parsePorcelainZ(repoRoot, out string) map[string]string {
	changed := map[string]string{}
	fields := strings.Split(out, "\x00")
	for i := 0; i < len(fields); i++ {
		rec := fields[i]
		// "XY p" is the shortest legal record. This also swallows the empty
		// tail Split leaves after the final NUL.
		if len(rec) < 4 {
			continue
		}
		xy := rec[:2]
		if strings.ContainsAny(xy, "RC") {
			i++ // the origin path; see above
		}
		changed[filepath.Join(repoRoot, rec[3:])] = porcelainStatus(xy)
	}
	return changed
}

// porcelainStatus maps a porcelain XY pair onto the wire vocabulary.
//
// Order is the whole algorithm. Conflicts are tested before everything else
// because "AA" is both-added and "DD" is both-deleted -- reading either by its
// letters alone would report a merge conflict as an ordinary add or delete and
// send the user to commit it.
func porcelainStatus(xy string) string {
	switch {
	case xy == "??":
		return fileStatusUntracked
	case strings.ContainsRune(xy, 'U'), xy == "AA", xy == "DD":
		return fileStatusConflicted
	case strings.ContainsAny(xy, "RC"):
		return fileStatusRenamed
	case strings.ContainsRune(xy, 'D'):
		return fileStatusDeleted
	case strings.ContainsRune(xy, 'A'):
		return fileStatusAdded
	default:
		return fileStatusModified
	}
}
