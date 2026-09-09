package server

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

// Publishing a whole DIRECTORY TREE to one anonymous URL, so a recipient with
// no muxterm account can browse it: a small wiki, a docs folder, a set of
// linked markdown notes.
//
// ⛔ READ THIS BEFORE CHANGING ANYTHING HERE. Single-file publishing (see
// publish.go) is safe by CONSTRUCTION: its public route accepts an id and
// nothing else, so there is no path input and traversal is unrepresentable
// rather than filtered. THAT PROPERTY CANNOT SURVIVE A BROWSABLE TREE. A
// reader must be able to say WHICH page they want, so the route necessarily
// grows a caller-controlled path component, and the guarantee that made
// single-file publishing safe is gone.
//
// It is replaced -- not weakened -- by a different construction:
//
//	THE REQUEST SELECTS AN ENTRY FROM A FIXED SET. IT NEVER BUILDS A PATH.
//
// The tree is enumerated ONCE, at publish time, into a manifest keyed by
// cleaned relative slash-path. A request's path component is used as a MAP KEY
// and for nothing else. If it is not a key, the answer is 404 -- "..", encoded
// "..", doubly-encoded "..", an absolute path and a NUL byte are all simply
// absent from the map. When a key DOES hit, the path that is opened is rebuilt
// from the manifest's own stored relative path, never from the request bytes.
//
// On top of that, and independently, every single read re-proves containment
// against the pinned root by RESOLVED REAL PATH (filepath.Rel on two
// EvalSymlinks results -- never a string prefix test, which "/root-evil/x"
// defeats), re-verifies the root's device and inode, re-applies the exclusion
// policy, re-checks the per-file size bound, and opens through the same
// no-symlink-component + O_NOFOLLOW discipline publish.go uses. Two
// independent mechanisms, either of which is sufficient.
//
// THE NEW-FILE HAZARD, AND THE CHOICE MADE ABOUT IT. A single file is pinned
// by inode. A folder cannot be: files can be CREATED inside it after
// publishing, and under live semantics they would become world-readable the
// moment they appeared -- someone drops a credentials file, a database dump or
// a half-written draft into a published folder and it is instantly readable
// through a URL that was already sent.
//
// Three options were available:
//
//	(a) fully live      -- the tree is whatever is on disk right now.
//	(b) enumerate at publish time, serve only those paths, content still live.
//	(c) live, with an exclusion policy applied on every request.
//
// (b) AND (c) TOGETHER are implemented here. (b) preserves the publisher's
// mental model -- they published what they saw -- while content stays live, so
// edits to a published page still appear immediately, which was the entire
// point of live semantics. (c) is the belt to (b)'s braces: the exclusion
// policy is re-applied on every read, so it holds even if the manifest were
// ever built by a future code path that forgot.
//
// WHAT (b) COSTS, PLAINLY: a genuinely new page does NOT appear until the
// folder is published again. Adding wiki-page-3.md to a published wiki gets a
// 404 until the publisher republishes. That is a real limitation, it is stated
// in publish_folder's tool description rather than left to be discovered, and
// it is the price of not silently exposing whatever lands in the directory
// next.

const (
	// folderMaxFiles caps how many files one publication may cover.
	//
	// A COUNT limit, not a byte limit. The manifest is memory held for the
	// life of the publication and the directory index is a page a human
	// reads, so the thing worth bounding is how many ENTRIES exist, not how
	// many bytes they currently hold. See folderNoTotalSizeLimit.
	folderMaxFiles = 5000

	// folderMaxDepth caps how deep the enumeration walk descends, so a
	// pathological tree cannot turn one publish call into an unbounded walk.
	folderMaxDepth = 32

	// folderEnumerateDeadline bounds the whole publish-time walk, including
	// the one git subprocess. A publish that cannot finish promptly is a
	// publish of something too big to be a wiki.
	folderEnumerateDeadline = 20 * time.Second

	// folderGitDeadline bounds the single `git check-ignore` batch call.
	folderGitDeadline = 5 * time.Second

	// folderNoTotalSizeLimit documents an absence. There is deliberately NO
	// publish-time total-size cap: content is LIVE, so any total measured at
	// publish is stale the instant it is recorded, and a limit that stops
	// applying the moment the thing it bounds changes is not a limit. The
	// real bound is publicationMaxBytes, enforced PER FILE on EVERY read.
	folderNoTotalSizeLimit = true
)

// kindFolder is a publication whose subject is a directory tree rather than
// one file. It is a new VALUE of the existing kind field, deliberately: a file
// publication's row shape does not change at all, so anything already reading
// list_publications keeps working and can branch on kind when it wants to.
const kindFolder publicationKind = "folder"

// folderIndexNames are the basenames that make a directory render as a page
// instead of as a listing, in preference order. This is what makes a docs
// folder feel like a site rather than a file dump.
var folderIndexNames = []string{"index.md", "README.md", "readme.md", "index.markdown", "README.markdown"}

// treeFile is one enumerated file. Everything here is decided at publish time
// and never mutated; the CONTENT it points at is still read fresh on every
// request.
type treeFile struct {
	rel           string // cleaned relative slash path, the manifest key
	kind          publicationKind
	contentType   string
	filename      string
	sizeAtPublish int64
}

// treeDir is one enumerated directory, pre-sorted for rendering.
type treeDir struct {
	rel      string   // "" is the published root
	subdirs  []string // rel paths of child directories, sorted
	files    []string // rel paths of child files, sorted
	indexRel string   // rel path of index.md/README.md here, or ""
}

// folderTree is the manifest of one published directory: the pin, the fixed
// set of servable paths, and the pre-computed directory structure.
//
// Immutable after Create returns. Nothing at request time writes to it.
type folderTree struct {
	// root is the PIN: fully symlink-resolved and absolute. Every path this
	// publication can ever serve is rebuilt by joining root with a relative
	// path taken FROM THE MANIFEST, never from a request.
	root    string
	rootDev uint64
	rootIno uint64

	files map[string]*treeFile
	dirs  map[string]*treeDir

	totalSize    int64
	excludedN    int    // entries the exclusion policy dropped
	gitIgnoredN  int    // entries git said were ignored
	gitStatus    string // one sentence: what gitignore filtering did, or why it did not run
	truncated    bool   // true when folderMaxFiles stopped the walk (surfaced on the owner row)
	symlinkFileN int    // symlinks kept because they resolved INSIDE the root
	symlinkOutN  int    // symlinks dropped because they left the root
}

// FileCount is how many files this publication covers.
func (t *folderTree) FileCount() int { return len(t.files) }

// ---------------------------------------------------------------------------
// S4 -- the exclusion policy
// ---------------------------------------------------------------------------

// excludedDirNames are directory names never enumerated, whatever the
// publisher asked for.
//
// ⛔ .git IS THE SEVERE ONE AND THE REASON THIS LIST IS UNCONDITIONAL.
// Publishing a folder that contains .git publishes THE ENTIRE REPOSITORY
// HISTORY -- every branch, every blob, and every secret that was ever
// committed and later "removed", because removing a secret from the working
// tree does not remove it from the object store. Somebody publishing a docs
// folder from inside a repo would not expect that and has no reason to suspect
// it. Nothing about "publish this folder" implies "publish everything this
// folder has ever contained".
//
// The rest are the same class of mistake with smaller blast radii, plus
// node_modules, which is there to stop one npm project turning a wiki into a
// 40,000-entry enumeration.
var excludedDirNames = map[string]bool{
	".git": true, ".hg": true, ".svn": true, ".bzr": true,
	"node_modules": true,
}

// excludedExactNames are basenames never served, dotfile or not. This is NOT
// secret scanning -- there is deliberately none of that here, for the reason
// publish.go states: a half-built detector earns trust it cannot repay. It is
// a fixed deny-list of names that are private key material BY CONVENTION, and
// it is a floor beneath the real controls (you chose the folder, nothing
// outside it is served, it expires, you can revoke it).
var excludedExactNames = map[string]bool{
	"id_rsa": true, "id_dsa": true, "id_ecdsa": true, "id_ed25519": true,
	"authorized_keys": true, "known_hosts": true,
}

// excludedExtensions are extensions never served, same reasoning as above.
var excludedExtensions = map[string]bool{
	".pem": true, ".key": true, ".pfx": true, ".p12": true,
	".jks": true, ".keystore": true, ".ppk": true, ".asc": true,
	// Same criterion, found missing in review: Apple/APNs auth keys, PKCS
	// containers, GnuPG material, KeePass databases, OpenVPN profiles (which
	// embed an inline private key).
	".p8": true, ".pkcs8": true, ".pkcs12": true,
	".gpg": true, ".kdbx": true, ".ovpn": true,
}

// folderExcluded decides whether one directory entry is dropped, and says why.
//
// APPLIED AT ENUMERATION AND AGAIN ON EVERY READ, over every component of the
// relative path -- so a file whose PARENT is excluded is excluded even if the
// file itself looks innocent, and so the policy still holds for a manifest
// built by some future code path that forgot to apply it.
func folderExcluded(rel string, isDir bool) (bool, string) {
	if rel == "" {
		return false, ""
	}
	parts := strings.Split(rel, "/")
	for i, name := range parts {
		last := i == len(parts)-1
		asDir := isDir || !last

		// Every dotfile and dot-directory, at any depth. This is the rule
		// that covers .env, .ssh, .aws, .npmrc, .netrc and .git without
		// needing to have thought of each one. A dotfile is by convention
		// configuration or credentials, and nothing that reads like a wiki
		// page starts with a dot.
		if strings.HasPrefix(name, ".") {
			if name == ".git" {
				return true, "a .git directory is never served: it carries the repository's entire history"
			}
			return true, "dotfiles and dot-directories are never served"
		}
		if asDir && excludedDirNames[strings.ToLower(name)] {
			return true, strings.ToLower(name) + " is never served"
		}
		if !asDir {
			// ToLower like the two lookups around it. Without it ID_RSA
			// served while id_rsa was excluded -- and on a case-insensitive
			// filesystem (APFS by default) they are the same file.
			if excludedExactNames[strings.ToLower(name)] {
				return true, "this name is private key material by convention and is never served"
			}
			if excludedExtensions[strings.ToLower(filepath.Ext(name))] {
				return true, "this extension is private key material by convention and is never served"
			}
		}
	}
	return false, ""
}

// ---------------------------------------------------------------------------
// S1 -- containment
// ---------------------------------------------------------------------------

// errNotInTree is the ONE refusal every miss produces, whatever the real
// cause: not enumerated, excluded, traversal attempt, created after publish,
// or simply absent. Identical answers are what stop the manifest and the
// exclusion list from being enumerable by a reader probing paths, and stop a
// refusal from revealing whether a file exists.
var errNotInTree = errors.New("not in this publication")

// normalizeTreeRequest validates the caller-controlled path component and
// returns the manifest key it selects.
//
// VALIDATION, NOT NORMALIZATION. Nothing here rewrites a path into a
// "cleaner" one -- rewriting is where traversal bugs live, because the
// rewritten result is a path the caller influenced. A segment that is "..",
// ".", empty, or contains a NUL or a separator is REFUSED outright. Browsers
// resolve relative links before sending them, so a legitimate reader never
// produces one of these.
func normalizeTreeRequest(rest string) (string, error) {
	if strings.ContainsRune(rest, 0) {
		return "", errNotInTree
	}
	// A leading slash would mean an absolute path was smuggled through the
	// wildcard (%2f-encoded, since real separators are consumed by routing).
	if strings.HasPrefix(rest, "/") {
		return "", errNotInTree
	}
	// A trailing slash is how a directory is addressed; drop exactly one.
	rest = strings.TrimSuffix(rest, "/")
	if rest == "" {
		return "", nil // the published root itself
	}
	for _, seg := range strings.Split(rest, "/") {
		switch seg {
		case "", ".", "..":
			return "", errNotInTree
		}
		if strings.ContainsAny(seg, "\\\x00") {
			return "", errNotInTree
		}
	}
	// Cleaned form must equal the input, or the input was not already clean
	// and something is trying to say the same path two different ways.
	if path.Clean(rest) != rest {
		return "", errNotInTree
	}
	return rest, nil
}

// containedIn reports whether the fully-resolved path `abs` is inside the
// fully-resolved directory `root`.
//
// ⛔ filepath.Rel, NOT strings.HasPrefix. A prefix test says "/rootevil/x" is
// inside "/root", and says a symlink whose target merely BEGINS with the
// root's name is contained when it is not. Rel compares by path component and
// answers ".." or "../…" when the target is elsewhere, which is the actual
// question. Both arguments must already be EvalSymlinks results.
func containedIn(root, abs string) bool {
	if root == "" || abs == "" {
		return false
	}
	if abs == root {
		return true
	}
	rel, err := filepath.Rel(root, abs)
	if err != nil {
		return false
	}
	if rel == "." {
		return true
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return false
	}
	if filepath.IsAbs(rel) {
		return false
	}
	return true
}

// resolveInTree turns a MANIFEST-SUPPLIED relative path into an absolute path
// that has been proven, right now, to be inside the pinned root.
//
// The rel argument comes from the manifest, never from a request -- the
// request only chose which manifest entry to use. Even so this re-resolves and
// re-checks containment on every call, because the FILESYSTEM can change after
// publish time even though the manifest cannot: a page can be replaced by a
// symlink pointing at /etc/shadow between the publish and the read.
func resolveInTree(t *folderTree, rel string) (string, error) {
	joined := filepath.Join(t.root, filepath.FromSlash(rel))

	// EvalSymlinks is what implements S2's "follow only when contained":
	// symlinks ARE followed here, and then the RESULT is what has to pass
	// containment. A link pointing outside the root resolves to a path that
	// fails containment and is refused.
	resolved, err := filepath.EvalSymlinks(joined)
	if err != nil {
		if os.IsNotExist(err) {
			return "", faultSourceMissing(joined + " does not exist")
		}
		return "", faultUnreadable(err.Error())
	}
	if !containedIn(t.root, resolved) {
		// Deliberately an identity fault rather than a "missing" one: from
		// the publisher's side this is the interesting event -- something
		// inside their published tree now points out of it.
		return "", faultIdentity(rel + " resolves outside the published folder, so it is refused; no symlink may leave the published root")
	}
	return resolved, nil
}

// verifyTreeRoot re-proves that the published root is still the very same
// directory. Called on EVERY read.
//
// Without this, swapping the root directory itself for a symlink to somewhere
// else would silently re-point the whole publication: every path would still
// resolve, every containment check would pass (against the NEW root), and a
// URL already in someone's inbox would start serving a different tree.
func verifyTreeRoot(t *folderTree) error {
	if err := ensureNoSymlinkComponents(t.root); err != nil {
		return err
	}
	fi, err := os.Lstat(t.root)
	if err != nil {
		if os.IsNotExist(err) {
			return faultSourceMissing(t.root + " no longer exists")
		}
		return faultUnreadable(err.Error())
	}
	if !fi.IsDir() {
		return faultIdentity(t.root + " is no longer a directory")
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return faultIdentity("the identity of the published folder can no longer be determined")
	}
	if uint64(st.Dev) != t.rootDev || uint64(st.Ino) != t.rootIno { //nolint:unconvert // widths vary by platform
		return faultIdentity(fmt.Sprintf(
			"the folder at this path is now device %d inode %d, but this link was published for device %d inode %d",
			uint64(st.Dev), uint64(st.Ino), t.rootDev, t.rootIno)) //nolint:unconvert
	}
	return nil
}

// readTreeFile returns the CURRENT bytes of one manifest entry, having proven
// on this call that it is still inside the pinned root, still not excluded,
// still a regular file, and still within the size bound.
//
// This is the whole read path for a folder publication. It is deliberately the
// only way bytes leave one.
func readTreeFile(t *folderTree, tf *treeFile) ([]byte, os.FileInfo, error) {
	if err := verifyTreeRoot(t); err != nil {
		return nil, nil, err
	}
	// (c) -- the exclusion policy, re-applied per request rather than trusted
	// from enumeration time.
	if bad, _ := folderExcluded(tf.rel, false); bad {
		return nil, nil, errNotInTree
	}
	resolved, err := resolveInTree(t, tf.rel)
	if err != nil {
		return nil, nil, err
	}
	// From here it is publish.go's discipline verbatim: refuse a symlink at
	// any component, open with O_NOFOLLOW, and make every subsequent decision
	// against the DESCRIPTOR rather than the name.
	f, fi, err := openPinnedPath(resolved)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close() //nolint:errcheck

	// S6 -- per-file, on EVERY request. A live file can grow after publish.
	if fi.Size() > publicationMaxBytes {
		return nil, nil, faultTooLarge(fi.Size())
	}
	buf, err := readAllBounded(f)
	if err != nil {
		return nil, nil, err
	}
	return buf, fi, nil
}

// readAllBounded reads at most publicationMaxBytes, refusing a file that grew
// between the fstat and the read. Same shape as readPinned's body, and for the
// same reason: reading one byte PAST the limit is what catches a file that
// grew in the window between the stat and the copy.
func readAllBounded(f *os.File) ([]byte, error) {
	buf, err := io.ReadAll(io.LimitReader(f, publicationMaxBytes+1))
	if err != nil {
		return nil, faultUnreadable(err.Error())
	}
	if int64(len(buf)) > publicationMaxBytes {
		return nil, faultTooLarge(int64(len(buf)))
	}
	return buf, nil
}

// ---------------------------------------------------------------------------
// Enumeration -- (b), the manifest, built exactly once
// ---------------------------------------------------------------------------

// enumerateFolder walks root and builds the manifest.
//
// root must already be the fully-resolved, pinned path.
func enumerateFolder(ctx context.Context, root string, rootDev, rootIno uint64) (*folderTree, error) {
	t := &folderTree{
		root:    root,
		rootDev: rootDev,
		rootIno: rootIno,
		files:   make(map[string]*treeFile),
		dirs:    make(map[string]*treeDir),
	}
	t.dirs[""] = &treeDir{rel: ""}

	var walk func(dirRel string, depth int) error
	walk = func(dirRel string, depth int) error {
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("enumerating %s took longer than %s and was abandoned; this folder is too large to publish", root, folderEnumerateDeadline)
		}
		if depth > folderMaxDepth {
			return nil
		}
		abs := filepath.Join(root, filepath.FromSlash(dirRel))
		entries, err := os.ReadDir(abs)
		if err != nil {
			// An unreadable subdirectory is skipped, not fatal: a docs folder
			// with one root-owned directory in it is still publishable, and
			// the alternative is a publish that fails for a reason the
			// publisher cannot see.
			return nil
		}
		dir := t.dirs[dirRel]
		for _, e := range entries {
			name := e.Name()
			childRel := name
			if dirRel != "" {
				childRel = dirRel + "/" + name
			}

			info, ierr := e.Info() // Info() on a DirEntry is an lstat: a symlink reads as a symlink.
			if ierr != nil {
				continue
			}
			isSymlink := info.Mode()&os.ModeSymlink != 0

			if bad, _ := folderExcluded(childRel, e.IsDir()); bad {
				t.excludedN++
				continue
			}

			switch {
			case isSymlink:
				// S2 -- follow ONLY when the resolved target is still inside
				// the root, and only to a regular FILE.
				//
				// A symlinked DIRECTORY is never descended into, even a
				// contained one. Following one out of the root is exactly
				// what S1 forbids; following a contained one only produces a
				// second name for content already enumerated. The friendly
				// case people imagine -- a docs folder linking to a shared
				// assets directory elsewhere on disk -- is unreachable
				// safely, because it is by definition a link out of the root.
				// That is a real cost and it is stated, not hidden.
				resolved, rerr := filepath.EvalSymlinks(filepath.Join(root, filepath.FromSlash(childRel)))
				if rerr != nil || !containedIn(root, resolved) {
					t.symlinkOutN++
					continue
				}
				rfi, serr := os.Stat(resolved)
				if serr != nil || !rfi.Mode().IsRegular() {
					t.symlinkOutN++
					continue
				}
				if len(t.files) >= folderMaxFiles {
					t.truncated = true
					return nil
				}
				t.symlinkFileN++
				t.addFile(dir, childRel, rfi.Size())

			case e.IsDir():
				if _, seen := t.dirs[childRel]; !seen {
					t.dirs[childRel] = &treeDir{rel: childRel}
					dir.subdirs = append(dir.subdirs, childRel)
				}
				if err := walk(childRel, depth+1); err != nil {
					return err
				}

			case info.Mode().IsRegular():
				if len(t.files) >= folderMaxFiles {
					t.truncated = true
					return nil
				}
				t.addFile(dir, childRel, info.Size())

			default:
				// Sockets, FIFOs, devices. Never served.
				t.excludedN++
			}
		}
		return nil
	}

	if err := walk("", 0); err != nil {
		return nil, err
	}

	t.applyGitIgnore(ctx)
	t.pruneEmptyDirs()
	t.finalize()
	return t, nil
}

func (t *folderTree) addFile(dir *treeDir, rel string, size int64) {
	kind, ctype := publicationKindFor(rel)
	t.files[rel] = &treeFile{
		rel:           rel,
		kind:          kind,
		contentType:   ctype,
		filename:      safeAttachmentName(path.Base(rel)),
		sizeAtPublish: size,
	}
	dir.files = append(dir.files, rel)
	t.totalSize += size
}

// applyGitIgnore drops every enumerated file that git would ignore, in ONE
// subprocess.
//
// Best-effort by design, exactly like files_api.go's git half: no git on PATH,
// a root outside any worktree, or a failed call leaves the built-in exclusion
// set as the only filter and says so in gitStatus. This is a convenience --
// it keeps build output, local .env-adjacent junk and vendored trees out of a
// published docs folder -- and it is explicitly NOT the guarantee. The
// guarantee is the unconditional list above, which does not depend on git,
// on a .gitignore file, or on the publisher having written one.
//
// It runs at PUBLISH time only, because the manifest is fixed at publish time.
// A file that becomes ignored later is already outside the manifest's reach if
// it was created later, and stays served if it was enumerated -- consistent
// with (b), which is what the publisher was shown.
func (t *folderTree) applyGitIgnore(ctx context.Context) {
	if len(t.files) == 0 {
		t.gitStatus = "no files to check"
		return
	}
	bin, err := exec.LookPath("git")
	if err != nil {
		t.gitStatus = "git is not on PATH, so .gitignore was not consulted"
		return
	}
	gctx, cancel := context.WithTimeout(ctx, folderGitDeadline)
	defer cancel()

	rels := make([]string, 0, len(t.files))
	for rel := range t.files {
		rels = append(rels, rel)
	}
	sort.Strings(rels)

	var stdin bytes.Buffer
	for _, rel := range rels {
		stdin.WriteString(rel)
		stdin.WriteByte(0)
	}

	cmd := exec.CommandContext(gctx, bin, "-C", t.root, "check-ignore", "-z", "--stdin")
	cmd.Stdin = &stdin
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = nil
	runErr := cmd.Run()
	// check-ignore exits 0 when something was ignored, 1 when nothing was,
	// and 128 on a real error (not a worktree, most often).
	if runErr != nil {
		var ee *exec.ExitError
		if !errors.As(runErr, &ee) || ee.ExitCode() != 1 {
			t.gitStatus = "not a git worktree (or git failed), so .gitignore was not consulted"
			return
		}
	}
	dropped := 0
	for _, raw := range bytes.Split(stdout.Bytes(), []byte{0}) {
		// NOT TrimSpace. -z exists precisely so no trimming is needed:
		// records are NUL-delimited because a filename may contain spaces or
		// newlines. Trimming made a gitignored "secret .env.bak" miss the
		// lookup below and stay PUBLISHED -- a filter that fails open.
		rel := string(raw)
		if rel == "" {
			continue
		}
		rel = strings.TrimPrefix(filepath.ToSlash(rel), "./")
		if tf, ok := t.files[rel]; ok {
			delete(t.files, rel)
			t.totalSize -= tf.sizeAtPublish
			dropped++
		}
	}
	t.gitIgnoredN = dropped
	t.gitStatus = fmt.Sprintf("git check-ignore consulted; %d file(s) dropped as gitignored", dropped)
}

// pruneEmptyDirs removes directories that ended up with nothing servable in
// them, so the index never offers a link to an empty page.
func (t *folderTree) pruneEmptyDirs() {
	// Rebuild each directory's file list from the surviving manifest first --
	// applyGitIgnore may have removed entries.
	for _, d := range t.dirs {
		kept := d.files[:0]
		for _, rel := range d.files {
			if _, ok := t.files[rel]; ok {
				kept = append(kept, rel)
			}
		}
		d.files = kept
	}
	// Deepest-first so a parent sees its children's final state.
	rels := make([]string, 0, len(t.dirs))
	for rel := range t.dirs {
		rels = append(rels, rel)
	}
	sort.Slice(rels, func(i, j int) bool {
		return strings.Count(rels[i], "/") > strings.Count(rels[j], "/")
	})
	for _, rel := range rels {
		if rel == "" {
			continue
		}
		d := t.dirs[rel]
		if len(d.files) > 0 || len(d.subdirs) > 0 {
			continue
		}
		delete(t.dirs, rel)
		parentRel := ""
		if i := strings.LastIndex(rel, "/"); i >= 0 {
			parentRel = rel[:i]
		}
		if p, ok := t.dirs[parentRel]; ok {
			kept := p.subdirs[:0]
			for _, s := range p.subdirs {
				if s != rel {
					kept = append(kept, s)
				}
			}
			p.subdirs = kept
		}
	}
}

// finalize sorts every listing and picks each directory's index page.
func (t *folderTree) finalize() {
	for _, d := range t.dirs {
		sort.Strings(d.subdirs)
		sort.Slice(d.files, func(i, j int) bool {
			return strings.ToLower(path.Base(d.files[i])) < strings.ToLower(path.Base(d.files[j]))
		})
		for _, want := range folderIndexNames {
			cand := want
			if d.rel != "" {
				cand = d.rel + "/" + want
			}
			if _, ok := t.files[cand]; ok {
				d.indexRel = cand
				break
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Publish-time entry point
// ---------------------------------------------------------------------------

// rootComponentExcluded applies the exclusion policy to the PUBLISHED ROOT's
// own path, component by component, and names the offending component.
//
// It reuses folderExcluded rather than growing a second list, because two
// lists is how the two ends drift apart. Every component is treated as a
// directory, which is what each one is.
//
// This refuses more than strictly necessary -- a genuinely intended
// ~/.local/share/notes is refused too, and that is a real cost. The
// alternative was testing only the final component, which would still have
// published /repo/.git/objects and ~/.ssh/keys. When the choice is contested,
// the option that exposes less wins; the caller is told exactly which
// component to move out from under.
func rootComponentExcluded(abs string) (string, string) {
	rest := strings.Trim(filepath.ToSlash(abs), "/")
	if rest == "" {
		return "", ""
	}
	for _, name := range strings.Split(rest, "/") {
		if name == "" {
			continue
		}
		if bad, why := folderExcluded(name, true); bad {
			return name, why
		}
	}
	return "", ""
}

// resolvePublishFolder resolves and vets a caller-supplied directory path.
func resolvePublishFolder(p string) (string, os.FileInfo, error) {
	resolved, err := resolvePublishPath(p)
	if err != nil {
		return "", nil, err
	}
	fi, err := os.Lstat(resolved)
	if err != nil {
		return "", nil, fmt.Errorf("cannot read %s: %w", resolved, err)
	}
	if !fi.IsDir() {
		return "", nil, fmt.Errorf("%s is not a directory; use publish_file for a single file", resolved)
	}

	// Two refusals that are not about traversal at all, but about the one
	// mistake this feature makes easy to commit: publishing far more than you
	// meant to, in one call, to the public internet.
	if resolved == string(os.PathSeparator) {
		return "", nil, errors.New("refusing to publish the filesystem root")
	}

	// ⛔ THE EXCLUSION POLICY MUST APPLY TO THE ROOT ITSELF.
	//
	// folderExcluded is only ever asked about paths RELATIVE to the root, so
	// the root's own name was never tested. That made the entire deny-list
	// bypassable by naming the excluded thing directly:
	//
	//	publish_folder /repo/.git   -> config, HEAD, index, every loose object
	//	                               and pack: the whole history, including
	//	                               every secret ever committed and later
	//	                               "removed". excluded=0, status ok.
	//	publish_folder ~/.aws       -> credentials, served as text/plain
	//	publish_folder ~/.ssh/keys  -> basename "keys": no dot, no listed name
	//
	// The deny-list did not merely fail to fire here; it never ran. And the
	// tool description promises "NEVER SERVED, WHATEVER THE FOLDER CONTAINS:
	// any .git directory", which an agent acting for a user is entitled to
	// believe. So every component of the resolved root is now tested by the
	// SAME rules, and the refusal names the component so the caller learns
	// which one, rather than being told a flat no.
	if bad, why := rootComponentExcluded(resolved); bad != "" {
		return "", nil, fmt.Errorf("refusing to publish %s: the path goes through %q, and %s. Publish a folder outside it", resolved, bad, why)
	}
	if home, herr := os.UserHomeDir(); herr == nil && home != "" {
		if hres, rerr := filepath.EvalSymlinks(home); rerr == nil && hres == resolved {
			return "", nil, fmt.Errorf("refusing to publish %s: that is the whole home directory. Publish the specific folder you mean", resolved)
		}
	}
	return resolved, fi, nil
}

// CreateFolder pins a directory, enumerates it, and registers it under a fresh
// cryptographically random id.
//
// ttl behaves exactly as it does for a file: 0 means the default, and anything
// above the maximum is an error rather than a silent clamp.
func (r *PublicationRegistry) CreateFolder(dirPath string, ttl time.Duration) (*publication, error) {
	if ttl == 0 {
		ttl = publicationDefaultTTL
	}
	if ttl < 0 {
		return nil, fmt.Errorf("ttl must be positive")
	}
	if ttl > publicationMaxTTL {
		return nil, fmt.Errorf("ttl %s exceeds the maximum of %s for a public link", ttl, publicationMaxTTL)
	}

	resolved, fi, err := resolvePublishFolder(dirPath)
	if err != nil {
		return nil, err
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return nil, fmt.Errorf("cannot determine the identity (device and inode) of %s on this platform, so it cannot be published", resolved)
	}

	ctx, cancel := context.WithTimeout(context.Background(), folderEnumerateDeadline)
	defer cancel()
	tree, err := enumerateFolder(ctx, resolved, uint64(st.Dev), uint64(st.Ino)) //nolint:unconvert // widths vary by platform
	if err != nil {
		return nil, err
	}
	if len(tree.files) == 0 {
		return nil, fmt.Errorf("%s has nothing servable in it: every entry was excluded (dotfiles, .git, node_modules, key material) or the folder is empty. Nothing was published", resolved)
	}

	now := r.clock()
	p := &publication{
		requested:     dirPath,
		path:          resolved,
		dev:           uint64(st.Dev), //nolint:unconvert
		ino:           uint64(st.Ino), //nolint:unconvert
		kind:          kindFolder,
		contentType:   "text/html; charset=utf-8",
		filename:      safeAttachmentName(filepath.Base(resolved)),
		publishedAt:   now,
		expiresAt:     now.Add(ttl),
		sizeAtPublish: tree.totalSize,
		tree:          tree,
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	for range 20 {
		id, gerr := publicationGenID()
		if gerr != nil {
			return nil, fmt.Errorf("publish: no cryptographic randomness available: %w", gerr)
		}
		if _, exists := r.items[id]; exists {
			continue
		}
		p.id = id
		r.items[id] = p
		return p, nil
	}
	return nil, errors.New("publish: could not generate a unique id after 20 attempts")
}

// treeStatus produces the owner-facing status line for a folder publication.
//
// It re-checks the ROOT on every list call -- exists, still a directory, still
// the same device and inode, no symlinked component above it -- which is what
// makes "is any of it broken" answerable. It deliberately does NOT re-stat
// every enumerated file: for a five-thousand-entry manifest that is five
// thousand syscalls per list call, and the per-file answer is already given at
// read time by the reader who asks for that file.
func treeStatus(p *publication) (string, string) {
	if err := verifyTreeRoot(p.tree); err != nil {
		var fault *pubFault
		if errors.As(err, &fault) {
			return fault.Code, fault.Owner
		}
		return "error", err.Error()
	}
	return "ok", ""
}

// treeEntryURL builds the public URL path for one entry inside a publication.
// Each segment is escaped individually so a filename containing a space, a
// hash or a question mark produces a link that still addresses that file.
func treeEntryURL(base, rel string) string {
	if rel == "" {
		return base
	}
	parts := strings.Split(rel, "/")
	for i, s := range parts {
		parts[i] = escapeURLSegment(s)
	}
	return base + strings.Join(parts, "/")
}

// escapeURLSegment percent-encodes everything outside the unreserved set plus
// a few punctuation characters that are common in filenames and unambiguous
// inside a path segment. url.PathEscape leaves "?" and "#" alone, which would
// truncate the path at the query or the fragment.
func escapeURLSegment(s string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9',
			c == '-', c == '_', c == '.', c == '~':
			b.WriteByte(c)
		default:
			b.WriteByte('%')
			b.WriteByte(hex[c>>4])
			b.WriteByte(hex[c&0x0f])
		}
	}
	return b.String()
}

// treeNotFound is the single public refusal for every miss inside a tree.
// Identical for "never existed", "excluded", "created after publish" and
// "tried to traverse", so none of those states is distinguishable from
// outside.
func treeNotFound(w http.ResponseWriter) {
	publicRefusal(w, http.StatusNotFound,
		"This page is not part of the published folder.",
		"It may never have been there, it may have been added after the folder was published, or it may be a kind of file that is never served. Ask whoever sent the link.")
}
