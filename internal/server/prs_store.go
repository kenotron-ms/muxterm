package server

// The collected pull requests: what muxterm knows a lane opened, kept after
// the lane is gone.
//
// WHY THIS FILE EXISTS AT ALL, since a `gh pr list` is one line. The applet
// used to run exactly that, against a repository found from a working
// directory, and it was wrong in two directions at once:
//
//   - It asked the WRONG QUESTION. The user's lanes work in many worktrees
//     across many branches and some of them touch other repositories
//     entirely, so there is no "current directory" whose repo is the answer.
//     The muxterm server is not itself in a checkout, so the fallback
//     produced `fatal: not a git repository (or any of the parent
//     directories): .git` on every poll -- an error where a list should be.
//   - It could not answer the question that was actually asked: "a lane might
//     have closed out, but I don't know what PRs have been opened that we know
//     about". A repo scan lists what GitHub has; it cannot say which of those
//     came out of a session here, and it cannot show one at all when the repo
//     is one nobody has a worktree for any more.
//
// So this is a COLLECTOR, not a scanner. muxterm already detects the pull
// request a lane opened -- sessiond scans a dying pane's output for a
// `gh pr create` URL and writes it into the durable completion log
// (internal/sessiond/completion.go, completionPRFrom). That detection is the
// source. This file's whole job is to notice those and never forget them.
//
// ┌─ THE PROPERTY THAT GIVES THE FEATURE ITS VALUE ────────────────────────┐
// │  A COLLECTED PULL REQUEST OUTLIVES ITS LANE.                           │
// │                                                                        │
// │  Lanes die constantly: a release restart killed six at once the night  │
// │  this was written, and their pull requests stayed open and unmerged.   │
// │  A list keyed to live sessions would be empty minutes after the work   │
// │  was done, which is precisely the gap. So a record here survives the   │
// │  session's death, a server restart, a sessiond restart, the            │
// │  acknowledgement of the completion it came from, and that completion   │
// │  aging out of the 200-record log.                                      │
// └────────────────────────────────────────────────────────────────────────┘
//
// PERSISTENCE FOLLOWS completions.json RATHER THAN INVENTING A SECOND SHAPE.
// Same directory (snapshotDir -- $XDG_DATA_HOME/muxterm), same single bounded
// JSON document, same atomic tmp+rename, same "a missing or corrupt file is an
// empty store, never a failure to start". The path is derived FROM
// sessiond.DefaultCompletionsPath's directory rather than re-deriving XDG
// here, so the two files cannot drift apart in a dev instance with its own
// XDG_DATA_HOME.
//
// SINGLE WRITER, AND IT IS THIS PROCESS. sessiond owns completions.json and
// this store never writes it; the server owns collected-prs.json and sessiond
// never reads it. The two processes share a directory and nothing else, which
// is why no lock is needed between them.

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// collectedPRVersion is the schema version written into every record. A record
// declaring a higher version was written by a newer build and is kept on disk
// but not published -- completionRecordVersion's rule, for its reason: a reader
// that does not understand a shape should decline it, not guess.
const collectedPRVersion = 1

// collectedPRCapacity bounds the store. A record is a few hundred bytes and
// this is the user's own history of work, so the ceiling is generous: it exists
// to stop an unbounded file, not to expire anything a person still wants.
const collectedPRCapacity = 500

// collectedPRTitleBytes bounds a stored title. GitHub does not enforce a short
// one and a pathological title should not be able to grow the document.
const collectedPRTitleBytes = 300

// prURLPattern matches a GitHub pull-request URL and captures owner, repo and
// number.
//
// This is where the REPOSITORY comes from, and it matters that it comes from
// here. A record's Project path is the session's working directory, which for
// every lane on this machine is /home/ken -- the lane cds into its worktree
// after launch, so the path muxterm recorded names no repository at all. The
// URL sessiond scraped out of `gh pr create`'s own output is first-hand and
// unambiguous, and it is the only field that can attribute a pull request to a
// repository the user no longer has a worktree for.
//
// Deliberately permissive about the host (github.com, an enterprise host) and
// strict about the shape.
var prURLPattern = regexp.MustCompile(`^https?://[A-Za-z0-9.:-]+/([A-Za-z0-9._-]+)/([A-Za-z0-9._-]+)/pull/([0-9]+)`)

// prRepoFromURL extracts "owner/name" from a pull request URL. ok is false for
// anything that is not one, which callers treat as "repository unknown" rather
// than as a reason to drop the record.
func prRepoFromURL(u string) (repo string, number int, ok bool) {
	m := prURLPattern.FindStringSubmatch(strings.TrimSpace(u))
	if m == nil {
		return "", 0, false
	}
	n, err := strconv.Atoi(m[3])
	if err != nil || n <= 0 {
		return "", 0, false
	}
	return m[1] + "/" + m[2], n, true
}

// prKey is the identity of a collected pull request: "owner/name#number", or
// "#number" when the repository could not be determined.
//
// Repo-qualified because a number alone collides -- this machine's sessions
// have worked in kenotron-ms/muxterm and microsoft/amplifier-bundle-resolve,
// and both have a #12. The key is what dismissal is written in, so a key that
// can collide is a dismissal that hides the wrong row.
func prKey(repo string, number int) string {
	return repo + "#" + strconv.Itoa(number)
}

// CollectedPR is one pull request muxterm knows about, and everything needed to
// make its row meaningful after the lane that opened it is gone.
//
// JSON field names are a persisted format. Add fields, never rename them.
type CollectedPR struct {
	V      int    `json:"v"`
	Key    string `json:"key"`
	Repo   string `json:"repo"`
	Number int    `json:"number"`
	URL    string `json:"url"`
	Title  string `json:"title,omitempty"`

	// WHERE IT CAME FROM. Captured at collection time rather than looked up
	// later, because by the time anyone reads this the workspace has usually
	// been reaped and the session id names nothing. Lane is the human name
	// (workspace name, else label, else session name); the ids are kept so a
	// row can still be traced when the name is unhelpful.
	Lane        string `json:"lane,omitempty"`
	WorkspaceID string `json:"workspaceId,omitempty"`
	SessionID   string `json:"sessionId,omitempty"`
	CollectedAt int64  `json:"collectedAt"`

	// Dismissed is the user putting this row down. PERMANENT: see
	// prCollector.Dismiss.
	Dismissed bool `json:"dismissed,omitempty"`

	// LAST KNOWN STATUS, cached. State is GitHub's own word (OPEN, MERGED,
	// CLOSED) and is "" until a status fetch has ever succeeded. StatusError
	// carries the reason the most recent attempt failed and is cleared by a
	// success; a row with a stale State AND a StatusError is showing the last
	// thing we actually knew, which is more useful than showing nothing.
	State       string `json:"state,omitempty"`
	IsDraft     bool   `json:"isDraft,omitempty"`
	StatusAt    int64  `json:"statusAt,omitempty"`
	StatusError string `json:"statusError,omitempty"`
}

// collectedPRsFile is the on-disk document.
type collectedPRsFile struct {
	V   int           `json:"v"`
	PRs []CollectedPR `json:"prs"`
}

// prCollector holds every collected pull request, in memory and on disk.
//
// Its own mutex, never shared with Server.mu: it is touched from HTTP handlers
// that also shell out to `gh`, and a slow network call must not be able to
// stall a config read or a WebSocket attach.
type prCollector struct {
	mu   sync.Mutex
	path string
	prs  []CollectedPR

	// completionsPath is the file the ingest reads. Held rather than resolved
	// per call so a test can point both halves at a temp directory.
	completionsPath string

	// ingestedMod is the completion log's modification time as of the last
	// ingest. An ingest is a JSON decode of a file that changes only when a
	// lane exits, so skipping it when nothing changed makes the applet's
	// one-minute poll free.
	ingestedMod int64
	ingestedSz  int64

	// statusErr is the last background refresh's FEATURE-level verdict: gh
	// missing, or gh logged out. "" means the last pass was fine.
	//
	// It lives here rather than on the request because the refresh no longer
	// runs inside one. A GET reports what the most recent pass found, which is
	// the honest answer to "is status working" -- and never the reason to
	// withhold a row.
	statusErr string

	// writeErrLogged suppresses repeat logging of a persistent write failure
	// (a full disk, a read-only home). The in-memory records stay correct and
	// the applet keeps working; only durability is lost, and saying so once is
	// enough. completionStore.persistLocked does the same.
	writeErrLogged bool
}

// DefaultCollectedPRsPath returns the durable collected-PR store's location.
//
//	$MUXTERM_COLLECTED_PRS_PATH   (explicit override, tests and odd deploys)
//	<dir of the completion log>/collected-prs.json
//
// The directory is taken from sessiond's own answer rather than re-derived, so
// a dev server with its own XDG_DATA_HOME cannot end up reading the real
// completion log while writing a sandbox store, or the reverse.
func DefaultCollectedPRsPath() string {
	if override := os.Getenv("MUXTERM_COLLECTED_PRS_PATH"); override != "" {
		return override
	}
	return filepath.Join(filepath.Dir(sessiond.DefaultCompletionsPath()), "collected-prs.json")
}

// newPRCollector loads the store at path, tolerating every kind of absence.
//
// A missing, unreadable, or malformed file yields an EMPTY collector rather
// than a failure: losing the collected list is a bad day; refusing to serve the
// terminal multiplexer over it is a worse one.
func newPRCollector(path, completionsPath string) *prCollector {
	c := &prCollector{path: path, completionsPath: completionsPath}
	data, err := os.ReadFile(path)
	if err != nil {
		return c
	}
	var doc collectedPRsFile
	if err := json.Unmarshal(data, &doc); err != nil {
		return c
	}
	for _, p := range doc.PRs {
		if p.V > collectedPRVersion || p.Key == "" || p.Number <= 0 {
			continue
		}
		c.prs = append(c.prs, p)
	}
	c.sortLocked()
	return c
}

// Ingest folds sessiond's durable completion log into the store.
//
// ADDITIVE, NEVER SUBTRACTIVE, and that is the whole design. A record is
// created the first time a pull request is seen and then belongs to this store
// forever: it is not re-derived from the completion log on each pass, so it
// survives that log being trimmed at 200 records, the completion being
// acknowledged, and sessiond being restarted with an empty one. Nothing here
// ever deletes.
//
// The one thing an existing record does take from a later pass is a URL or a
// lane name it was missing, because a fuller row is strictly better and neither
// field is user state.
//
// Returns whether anything changed.
func (c *prCollector) Ingest() bool {
	st, err := os.Stat(c.completionsPath)
	if err != nil {
		// No completion log yet (a fresh machine, or a dev instance whose
		// sessiond has never reaped a lane). Not an error: there is simply
		// nothing to collect, and whatever is already stored still shows.
		return false
	}
	mod, size := st.ModTime().UnixNano(), st.Size()

	c.mu.Lock()
	unchanged := mod == c.ingestedMod && size == c.ingestedSz
	c.mu.Unlock()
	if unchanged {
		return false
	}

	data, err := os.ReadFile(c.completionsPath)
	if err != nil {
		return false
	}
	var doc struct {
		Records []sessiond.CompletionRecord `json:"records"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return false
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	c.ingestedMod, c.ingestedSz = mod, size

	changed := false
	for _, r := range doc.Records {
		for _, cand := range completionPRCandidates(r) {
			if c.upsertLocked(r, cand) {
				changed = true
			}
		}
	}
	if !changed {
		return false
	}
	c.sortLocked()
	c.trimLocked()
	c.persistLocked()
	return true
}

// prCandidate is one pull request a completion record names.
type prCandidate struct {
	repo   string
	number int
	url    string
}

// completionPRCandidates lists every pull request one record names.
//
// A LANE CAN OPEN MORE THAN ONE, and until sessiond kept them all this loop had
// only the record's headline PR to work with -- so the second pull request a
// lane opened was invisible to every reader, forever. PRURLs is the full set in
// print order; PRURL is the last of them and is still honoured on its own for
// records written before PRURLs existed.
//
// The declared number (`muxterm session report --pr N`) is included even when
// nothing printed a link, because it is the lane's own claim about what it
// produced. Its repository is genuinely unknown and is left so: guessing one
// from the session's working directory is how a pull request gets attributed to
// the wrong project.
func completionPRCandidates(r sessiond.CompletionRecord) []prCandidate {
	urls := r.PRURLs
	if len(urls) == 0 && strings.TrimSpace(r.PRURL) != "" {
		urls = []string{r.PRURL}
	}

	out := make([]prCandidate, 0, len(urls)+1)
	seen := make(map[string]bool, len(urls)+1)
	for _, u := range urls {
		repo, number, ok := prRepoFromURL(u)
		if !ok {
			continue
		}
		key := prKey(repo, number)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, prCandidate{repo: repo, number: number, url: strings.TrimSpace(u)})
	}

	if r.PR > 0 {
		// The headline number, when no URL accounted for it -- a declared PR
		// with no link printed.
		accounted := false
		for _, cand := range out {
			if cand.number == r.PR {
				accounted = true
				break
			}
		}
		if !accounted && !seen[prKey("", r.PR)] {
			out = append(out, prCandidate{number: r.PR})
		}
	}
	return out
}

// upsertLocked records one candidate, or fills in what an existing row was
// missing. It reports whether anything changed.
func (c *prCollector) upsertLocked(r sessiond.CompletionRecord, cand prCandidate) bool {
	key := prKey(cand.repo, cand.number)
	if i := c.indexOfLocked(key); i >= 0 {
		changed := false
		if c.prs[i].URL == "" && cand.url != "" {
			c.prs[i].URL = cand.url
			changed = true
		}
		if c.prs[i].Lane == "" {
			if lane := completionLaneName(r); lane != "" {
				c.prs[i].Lane = lane
				changed = true
			}
		}
		return changed
	}
	c.prs = append(c.prs, CollectedPR{
		V:           collectedPRVersion,
		Key:         key,
		Repo:        cand.repo,
		Number:      cand.number,
		URL:         cand.url,
		Lane:        completionLaneName(r),
		WorkspaceID: r.WorkspaceID,
		SessionID:   r.SessionID,
		CollectedAt: r.EndedAt,
	})
	return true
}

// completionLaneName is what to call the lane that opened a pull request.
//
// Every fallback is a real identifier a human can act on. It mirrors
// CompletionRecord.LaneName's order but stops before "w7 pane 1": on a PR row
// a workspace coordinate that no longer exists is noise, and an empty lane
// column reads better than a dead pointer.
func completionLaneName(r sessiond.CompletionRecord) string {
	for _, candidate := range []string{r.WorkspaceName, r.Label, r.Name} {
		if s := strings.TrimSpace(candidate); s != "" {
			return s
		}
	}
	return ""
}

// All returns every record, newest first.
func (c *prCollector) All() []CollectedPR {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]CollectedPR(nil), c.prs...)
}

// Dismiss stops a pull request appearing in the collector. It reports whether
// the key was found.
//
// PERMANENT, DELIBERATELY. A later status change does NOT bring a dismissed row
// back: not when it merges, not when it is reopened, not when a fresh ingest
// sees it again. A dismissal that undoes itself is not a dismissal, and if the
// user put a row down they meant it. The record is KEPT with the flag set --
// completions.json's Acknowledged, for its reason -- so re-collecting the same
// pull request tomorrow cannot resurrect it.
//
// IT TOUCHES NOTHING ON GITHUB. Dismissing removes a row from this list and has
// no other effect anywhere; the pull request is not closed, not merged, not
// commented on. The UI says so where the control is.
func (c *prCollector) Dismiss(key string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	i := c.indexOfLocked(key)
	if i < 0 {
		return false
	}
	if c.prs[i].Dismissed {
		return true // already down; idempotent, and still a success
	}
	c.prs[i].Dismissed = true
	c.persistLocked()
	return true
}

// NeedStatus returns the non-dismissed records whose cached status is older
// than staleBefore, newest first, capped at max.
//
// Dismissed rows are excluded on purpose: refreshing a row nobody is looking at
// is GitHub API budget spent on nothing.
func (c *prCollector) NeedStatus(staleBefore int64, max int) []CollectedPR {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]CollectedPR, 0, max)
	for _, p := range c.prs {
		if p.Dismissed || p.Repo == "" {
			continue
		}
		if p.StatusAt > staleBefore {
			continue
		}
		out = append(out, p)
		if len(out) >= max {
			break
		}
	}
	return out
}

// ApplyStatus records the outcome of one status fetch.
//
// A FAILURE NEVER CLEARS WHAT WE ALREADY KNEW. state == "" with a non-empty
// errText leaves State and IsDraft exactly as they were and only annotates the
// row, so a network blip turns "merged" into "merged (status unavailable)"
// rather than into nothing. That distinction is the whole of C5's degradation
// requirement: a row that cannot refresh must still say what it last knew.
func (c *prCollector) ApplyStatus(key, state, title string, isDraft bool, at int64, errText string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	i := c.indexOfLocked(key)
	if i < 0 {
		return
	}
	if state == "" {
		c.prs[i].StatusError = errText
		// StatusAt is still stamped: without it a permanently failing fetch
		// would be retried on every single poll forever.
		c.prs[i].StatusAt = at
		c.persistLocked()
		return
	}
	c.prs[i].State = state
	c.prs[i].IsDraft = isDraft
	c.prs[i].StatusAt = at
	c.prs[i].StatusError = ""
	if t := strings.TrimSpace(title); t != "" {
		c.prs[i].Title = truncatePRTitle(t)
	}
	c.persistLocked()
}

func truncatePRTitle(s string) string {
	if len(s) <= collectedPRTitleBytes {
		return s
	}
	end := collectedPRTitleBytes
	for end > 0 && s[end]&0xC0 == 0x80 {
		end--
	}
	return s[:end]
}

func (c *prCollector) indexOfLocked(key string) int {
	for i := range c.prs {
		if c.prs[i].Key == key {
			return i
		}
	}
	return -1
}

// sortLocked keeps the store newest-first: collection time descending, then
// number descending so the order is total and two rows collected in the same
// second cannot swap between polls.
func (c *prCollector) sortLocked() {
	sort.SliceStable(c.prs, func(i, j int) bool {
		if c.prs[i].CollectedAt != c.prs[j].CollectedAt {
			return c.prs[i].CollectedAt > c.prs[j].CollectedAt
		}
		if c.prs[i].Number != c.prs[j].Number {
			return c.prs[i].Number > c.prs[j].Number
		}
		return c.prs[i].Key < c.prs[j].Key
	})
}

// trimLocked drops the OLDEST records past capacity. The slice is newest-first,
// so that is the tail.
func (c *prCollector) trimLocked() {
	if len(c.prs) > collectedPRCapacity {
		c.prs = c.prs[:collectedPRCapacity]
	}
}

// StatusError reports the last background refresh's feature-level verdict.
func (c *prCollector) StatusError() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.statusErr
}

// SetStatusError records it. Not persisted: it describes this process's last
// attempt, and a stale one read off disk at startup would be a claim about a
// network that is no longer the one we are on.
func (c *prCollector) SetStatusError(msg string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.statusErr = msg
}

// persistLocked atomically rewrites the store, following completionStore's
// tmp+rename discipline so a reader never sees a half-written document.
//
// A write failure is logged once and otherwise swallowed: the in-memory list is
// still correct and still served, and failing an HTTP GET because a cache file
// could not be written would trade a durability problem for a broken applet.
func (c *prCollector) persistLocked() {
	err := os.MkdirAll(filepath.Dir(c.path), 0o700)
	if err == nil {
		var data []byte
		data, err = json.Marshal(collectedPRsFile{V: collectedPRVersion, PRs: c.prs})
		if err == nil {
			tmp := c.path + ".tmp"
			if err = os.WriteFile(tmp, data, 0o600); err == nil {
				if err = os.Rename(tmp, c.path); err != nil {
					os.Remove(tmp)
				}
			}
		}
	}
	if err != nil {
		if !c.writeErrLogged {
			c.writeErrLogged = true
			log.Printf("muxterm: could not persist collected pull requests %s: %v (the list remains in memory for this server's lifetime)", c.path, err)
		}
		return
	}
	c.writeErrLogged = false
}
