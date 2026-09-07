package server

import (
	"context"
	"encoding/json"
	"net/http"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The /api/prs route: every open pull request across the worktrees Mission
// Control is showing, for its Pull Requests applet.
//
//	GET /api/prs?root=<abs>&root=<abs>...   one flat list across those roots
//
// AuthMiddleware protects this route at mux registration, exactly like the
// config, AI, tunnel and remotes routes.
//
// This route ALWAYS answers 200. Every way it can fall short -- no gh, no
// login, a root that is not a GitHub repo -- is a fact about the environment
// rather than a fault in the request, and each one is reported in the body
// (available/error, or a per-root error row) so the applet can render "here is
// what is wrong and what to do about it" instead of an HTTP failure with no
// explanation. That is also why there is no writePRsError here to pair with
// writePRsJSON: this family has no error status to write.
//
// It owns no state and caches nothing. gh is the source of truth and the poll
// interval belongs to the caller.

const (
	// prsAuthDeadline bounds the one-shot `gh auth status` check.
	prsAuthDeadline = 5 * time.Second
	// prsRepoDeadline bounds resolving ONE root to owner/repo (a git toplevel
	// lookup plus a gh repo view, which may hit the network).
	prsRepoDeadline = 10 * time.Second
	// prsListDeadline bounds ONE `gh pr list`. Generous because it is a real
	// API round trip that also fetches the check rollup for 50 PRs.
	prsListDeadline = 20 * time.Second
	// prsMaxRoots caps the roots one request may name. It is what bounds the
	// whole fan-out: at most this many gh processes are ever in flight, so no
	// semaphore is needed on top of it.
	prsMaxRoots = 12
)

// The check-rollup vocabulary on the wire. A PR with no checks at all carries
// "", which is why there is no constant for it.
const (
	prChecksPending = "pending"
	prChecksPassing = "passing"
	prChecksFailing = "failing"
)

// prRepoRow reports what one requested root resolved to. There is one row per
// ROOT, not per repo: two worktrees of the same repository are two rows, which
// is what lets the applet say which of the user's directories is which.
type prRepoRow struct {
	Root  string `json:"root"`
	Repo  string `json:"repo"`  // "" when resolution failed
	Error string `json:"error"` // "" when it succeeded
}

// prRow is one pull request. Key is repo#number -- unique across repos, which
// the number alone is not.
type prRow struct {
	Key            string `json:"key"`
	Repo           string `json:"repo"`
	Number         int    `json:"number"`
	Title          string `json:"title"`
	State          string `json:"state"`
	IsDraft        bool   `json:"isDraft"`
	Checks         string `json:"checks"` // "" | pending | passing | failing
	ReviewDecision string `json:"reviewDecision"`
	HeadRefName    string `json:"headRefName"`
	Author         string `json:"author"`
	URL            string `json:"url"`
	UpdatedAt      string `json:"updatedAt"`
}

// prsListResponse is GET /api/prs. Repos and PRs are ALWAYS present and never
// null: the browser iterates them unconditionally.
type prsListResponse struct {
	Available bool        `json:"available"`
	Error     string      `json:"error"`
	Repos     []prRepoRow `json:"repos"`
	PRs       []prRow     `json:"prs"`
}

// ghPullRequest is the subset of `gh pr list --json` this route reads.
type ghPullRequest struct {
	Number            int             `json:"number"`
	Title             string          `json:"title"`
	State             string          `json:"state"`
	IsDraft           bool            `json:"isDraft"`
	StatusCheckRollup []ghStatusCheck `json:"statusCheckRollup"`
	ReviewDecision    string          `json:"reviewDecision"`
	HeadRefName       string          `json:"headRefName"`
	UpdatedAt         string          `json:"updatedAt"`
	URL               string          `json:"url"`
	Author            struct {
		Login string `json:"login"`
	} `json:"author"`
}

// ghStatusCheck is ONE entry of a heterogeneous array: GitHub returns CheckRun
// objects (name/status/conclusion) and StatusContext objects (context/state)
// side by side in the same rollup. Decoding both into one permissive struct of
// four strings means a check of either kind lands in the fields it has and
// leaves the others empty, instead of failing the decode for the whole PR.
type ghStatusCheck struct {
	Name       string `json:"name"`
	Status     string `json:"status"`
	Conclusion string `json:"conclusion"`
	State      string `json:"state"`
}

func writePRsJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v) //nolint:errcheck
}

// handlePRsList answers GET /api/prs?root=<abs>&root=<abs>...
//
// ?root repeats, one per worktree the applet is showing. Zero roots is a legal
// request and answers with empty arrays -- a browser that has not opened a
// project yet should still learn whether gh works, so it can show the "install
// gh" or "run gh auth login" hint before the user picks anything.
//
// A root that cannot be resolved becomes a repos[] row carrying its error and
// is skipped for listing. It must never fail the request: one directory that is
// not a GitHub checkout would otherwise hide every PR from the ones that are.
//
// AuthMiddleware protects this route at mux registration.
func (s *Server) handlePRsList(w http.ResponseWriter, r *http.Request) {
	// Never null. Zero roots is two empty arrays.
	out := prsListResponse{
		Repos: []prRepoRow{},
		PRs:   []prRow{},
	}

	// LookPath first, so a machine without the GitHub CLI is a clean degraded
	// state with a sentence naming the missing binary.
	bin, err := exec.LookPath("gh")
	if err != nil {
		out.Error = "the GitHub CLI (gh) is not on PATH"
		writePRsJSON(w, http.StatusOK, out)
		return
	}
	if err := ghAuthOK(r.Context(), bin); err != nil {
		out.Error = "the GitHub CLI is not authenticated (run: gh auth login)"
		writePRsJSON(w, http.StatusOK, out)
		return
	}
	out.Available = true

	roots := r.URL.Query()["root"]
	if len(roots) > prsMaxRoots {
		roots = roots[:prsMaxRoots]
	}

	// Resolve first, sequentially: it is a cheap local git call plus a gh call
	// that is usually served from gh's own config, and doing it in order keeps
	// repos[] in the order the caller asked for.
	seen := map[string]bool{}
	distinct := make([]string, 0, len(roots))
	for _, root := range roots {
		row := prRepoRow{Root: root}
		repo, err := resolveGHRepo(r.Context(), bin, root)
		if err != nil {
			row.Error = gitErrText(err)
		} else {
			row.Repo = repo
			if !seen[repo] {
				seen[repo] = true
				distinct = append(distinct, repo)
			}
		}
		out.Repos = append(out.Repos, row)
	}

	out.PRs = listPRs(r.Context(), bin, distinct)

	// Newest first. Numbers are unique per repo, so the repo tie-break keeps
	// the order total and stops two repos' #91 from swapping between polls.
	sort.Slice(out.PRs, func(i, j int) bool {
		if out.PRs[i].Number != out.PRs[j].Number {
			return out.PRs[i].Number > out.PRs[j].Number
		}
		return out.PRs[i].Repo < out.PRs[j].Repo
	})

	writePRsJSON(w, http.StatusOK, out)
}

// ghAuthOK reports whether gh has a usable login.
//
// Exit code only: `gh auth status` writes a multi-account report to stderr that
// includes token scopes, and none of it belongs in an HTTP response. The one
// bit that matters is whether it succeeded.
func ghAuthOK(ctx context.Context, bin string) error {
	ctx, cancel := context.WithTimeout(ctx, prsAuthDeadline)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "auth", "status")
	cmd.Stdin = nil
	return cmd.Run()
}

// resolveGHRepo turns a worktree path into "owner/repo".
//
// Two steps, because a root is a directory and gh answers about repositories:
// git names the toplevel (so a subdirectory of a checkout resolves like the
// checkout itself), then gh reads the remote from THERE via cmd.Dir. gh has no
// -C flag, so cmd.Dir is the only way to ask it about a directory other than
// this server process's own.
func resolveGHRepo(ctx context.Context, bin, root string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, prsRepoDeadline)
	defer cancel()

	git, err := exec.LookPath("git")
	if err != nil {
		return "", err
	}
	top, err := runGit(ctx, git, "-C", root, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", err
	}

	cmd := exec.CommandContext(ctx, bin, "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner")
	cmd.Dir = filepath.Clean(top)
	cmd.Stdin = nil
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// listPRs fans out one `gh pr list` per distinct repo and merges the results.
//
// Concurrent because these are independent network round trips and the applet
// polls: N repos serially would make the slowest one everybody's latency. The
// fan-out needs no semaphore -- prsMaxRoots already caps it at 12 -- and each
// call carries its own deadline, so one slow repo cannot hold the others.
//
// A repo whose listing fails contributes nothing and is not reported: its
// repos[] row already resolved successfully, so the honest thing to show is the
// PRs that did come back rather than an error over the whole applet.
func listPRs(ctx context.Context, bin string, repos []string) []prRow {
	// Never null.
	out := []prRow{}
	if len(repos) == 0 {
		return out
	}

	var (
		mu sync.Mutex
		wg sync.WaitGroup
	)
	for _, repo := range repos {
		wg.Add(1)
		go func(repo string) {
			defer wg.Done()
			rows, err := ghPRList(ctx, bin, repo)
			if err != nil {
				return
			}
			mu.Lock()
			out = append(out, rows...)
			mu.Unlock()
		}(repo)
	}
	wg.Wait()
	return out
}

// ghPRList runs `gh pr list` for one repo and maps its rows.
func ghPRList(ctx context.Context, bin, repo string) ([]prRow, error) {
	ctx, cancel := context.WithTimeout(ctx, prsListDeadline)
	defer cancel()

	cmd := exec.CommandContext(ctx, bin,
		"pr", "list",
		"--repo", repo,
		"--state", "open",
		"--limit", "50",
		"--json", "number,title,state,isDraft,statusCheckRollup,reviewDecision,headRefName,updatedAt,url,author",
	)
	// stdin is nil so a gh that decides to prompt (an expired token, say) hits
	// EOF immediately instead of hanging until the deadline. Output(), not
	// CombinedOutput(): gh writes its warnings to stderr and mixing them into
	// the JSON would make it unparseable.
	cmd.Stdin = nil
	data, err := cmd.Output()
	if err != nil {
		return nil, err
	}

	var prs []ghPullRequest
	if err := json.Unmarshal(data, &prs); err != nil {
		return nil, err
	}

	rows := make([]prRow, 0, len(prs))
	for _, pr := range prs {
		rows = append(rows, prRow{
			Key:            repo + "#" + strconv.Itoa(pr.Number),
			Repo:           repo,
			Number:         pr.Number,
			Title:          pr.Title,
			State:          pr.State,
			IsDraft:        pr.IsDraft,
			Checks:         rollupChecks(pr.StatusCheckRollup),
			ReviewDecision: pr.ReviewDecision,
			HeadRefName:    pr.HeadRefName,
			Author:         pr.Author.Login,
			URL:            pr.URL,
			UpdatedAt:      pr.UpdatedAt,
		})
	}
	return rows, nil
}

// rollupChecks collapses a heterogeneous check rollup into one word.
//
// Worst news wins, and the order is the whole algorithm: a run that has already
// failed is reported as failing even while ten others are still queued, because
// the queued ones cannot un-fail it. Only when nothing has failed does a
// pending run outrank a passing one, and "passing" is reserved for the case
// where every entry has landed green. A rollup with no entries is "" -- no
// checks configured is not the same claim as "passing".
func rollupChecks(checks []ghStatusCheck) string {
	if len(checks) == 0 {
		return ""
	}
	pending := false
	for _, c := range checks {
		switch strings.ToUpper(c.Conclusion) {
		case "FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED":
			return prChecksFailing
		}
		switch strings.ToUpper(c.State) {
		case "FAILURE", "ERROR":
			return prChecksFailing
		case "PENDING":
			pending = true
		}
		switch strings.ToUpper(c.Status) {
		case "QUEUED", "IN_PROGRESS", "PENDING", "WAITING":
			pending = true
		}
	}
	if pending {
		return prChecksPending
	}
	return prChecksPassing
}
