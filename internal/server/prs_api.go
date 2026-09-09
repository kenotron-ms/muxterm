package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The /api/prs routes: the pull requests muxterm's own sessions opened.
//
//	GET  /api/prs           the collected list, newest first
//	POST /api/prs/dismiss   {"key":"owner/name#123"} -- stop showing one
//
// AuthMiddleware protects both at mux registration, exactly like the config,
// AI, tunnel, files and remotes routes.
//
// ── WHAT CHANGED, AND WHY IT IS A DIFFERENT MODEL AND NOT A BUG FIX ────────
//
// This route used to take `?root=<abs>` worktree paths, resolve each to a
// GitHub repository with `git rev-parse --show-toplevel` + `gh repo view`, and
// `gh pr list` those repositories. With no roots it fell back to the SERVER's
// own working directory. That produced, on every poll:
//
//	{"root":"/home/ken","repo":"","error":
//	 "fatal: not a git repository (or any of the parent directories): .git"}
//
// -- because the browser derived roots from each session's `project` path, and
// every lane on this machine reports /home/ken (a lane cds into its worktree
// after launch, so the recorded path names no repository).
//
// Pointing it at a better directory would have been the wrong fix. The user's
// lanes work in many worktrees across many branches and some touch other
// repositories entirely, so there is no single directory whose repository is
// the answer -- and a repo scan cannot say which pull requests came out of
// sessions here, which was the actual question.
//
// So discovery is gone. The list is COLLECTED from what sessions declared:
// sessiond already scrapes a `gh pr create` URL out of a dying lane's output
// and writes it to the durable completion log, and prs_store.go turns that into
// a record that outlives the lane. See prs_store.go's header for the whole
// argument.
//
// gh is still used, for ONE thing: the current state of a pull request we have
// already collected. It is never how one is found, and it is never allowed to
// fail the request -- see the degradation rule below.
//
// ── THIS ROUTE ALWAYS ANSWERS 200 WITH THE LIST IT HAS ─────────────────────
//
// No gh, no login, no network: those are facts about the environment, reported
// alongside a list that still renders every number, title and link. The bug
// being replaced showed an error INSTEAD of what it knew; repeating that shape
// with a different error would be the same defect. A row that says "status
// unavailable" is fine. An applet that errors out is not.

const (
	// prsStatusTTL is how long a cached pull-request state is trusted. A
	// merge is not urgent news and the applet polls once a minute, so a
	// minute-by-minute GitHub call per pull request would be cost with no
	// reader. Five minutes with refresh-on-view is the cheap end of "updates".
	prsStatusTTL = 5 * time.Minute
	// prsStatusBatch caps how many statuses ONE request may refresh. A first
	// load holding 200 collected pull requests must not spend 200 API calls
	// before the browser sees a row: the batch refreshes the newest stale ones
	// and the next poll takes the next batch, so the list renders immediately
	// and converges.
	prsStatusBatch = 12
	// prsStatusConcurrency bounds gh processes in flight. These are
	// independent network round trips, so some parallelism is the difference
	// between one slow call and twelve; more than this is just load.
	prsStatusConcurrency = 4
	// prsViewDeadline bounds ONE `gh pr view`. A real API round trip.
	prsViewDeadline = 15 * time.Second
	// prsAuthDeadline bounds the one-shot `gh auth status` check.
	prsAuthDeadline = 5 * time.Second
)

// prRow is one collected pull request on the wire.
//
// Everything a row needs to be meaningful after its lane is gone is here and
// none of it is looked up at render time: the number, the repository, the
// title, which lane opened it, and when it was collected.
type prRow struct {
	Key    string `json:"key"`
	Repo   string `json:"repo"`
	Number int    `json:"number"`
	Title  string `json:"title"`
	URL    string `json:"url"`

	// State is GitHub's own word -- OPEN, MERGED, CLOSED -- or "" when no
	// status fetch has ever succeeded for this row. StatusError says why the
	// last attempt failed and may be set ALONGSIDE a state, which is the
	// "showing what we last knew" case.
	State       string `json:"state"`
	IsDraft     bool   `json:"isDraft"`
	StatusError string `json:"statusError"`

	Lane        string `json:"lane"`
	WorkspaceID string `json:"workspaceId"`
	CollectedAt int64  `json:"collectedAt"`
	Dismissed   bool   `json:"dismissed"`
}

// prsListResponse is GET /api/prs. PRs is ALWAYS present and never null: the
// browser iterates it unconditionally.
//
// StatusAvailable/StatusError describe the STATUS FETCH only. They never gate
// the list -- available:false ships a full list of rows whose states are stale
// or unknown, which is exactly what should happen when gh is logged out.
type prsListResponse struct {
	StatusAvailable bool    `json:"statusAvailable"`
	StatusError     string  `json:"statusError"`
	PRs             []prRow `json:"prs"`
}

// ghPRView is the subset of `gh pr view --json` this route reads.
type ghPRView struct {
	State   string `json:"state"`
	Title   string `json:"title"`
	IsDraft bool   `json:"isDraft"`
}

func writePRsJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v) //nolint:errcheck
}

// handlePRsList answers GET /api/prs.
//
// Three steps, in an order that matters: INGEST what sessiond has recorded
// since last time, REFRESH the statuses that have gone stale, then answer with
// everything stored. The answer is built from the store rather than from this
// pass's work, so a refresh that fetched nothing still returns the full list.
func (s *Server) handlePRsList(w http.ResponseWriter, r *http.Request) {
	s.prs.Ingest()

	statusErr := s.refreshPRStatuses(r.Context())

	out := prsListResponse{
		StatusAvailable: statusErr == "",
		StatusError:     statusErr,
		PRs:             []prRow{},
	}
	for _, p := range s.prs.All() {
		out.PRs = append(out.PRs, prRow{
			Key:         p.Key,
			Repo:        p.Repo,
			Number:      p.Number,
			Title:       p.Title,
			URL:         p.URL,
			State:       p.State,
			IsDraft:     p.IsDraft,
			StatusError: p.StatusError,
			Lane:        p.Lane,
			WorkspaceID: p.WorkspaceID,
			CollectedAt: p.CollectedAt,
			Dismissed:   p.Dismissed,
		})
	}
	writePRsJSON(w, http.StatusOK, out)
}

// prDismissRequest is the POST /api/prs/dismiss body.
type prDismissRequest struct {
	Key string `json:"key"`
}

// handlePRDismiss answers POST /api/prs/dismiss.
//
// It removes a row from THIS LIST and does nothing else, anywhere. The pull
// request is not closed, not merged, not commented on; muxterm holds no write
// credential for GitHub and this handler shells out to nothing. The applet's
// wording says so next to the control, because a dismiss button that reads like
// it might close a pull request is a trap.
//
// 404 for a key that is not collected, so a stale browser gets a real answer
// instead of a silent success it would render as a vanished row.
func (s *Server) handlePRDismiss(w http.ResponseWriter, r *http.Request) {
	var req prDismissRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil {
		writePRsJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	key := strings.TrimSpace(req.Key)
	if key == "" {
		writePRsJSON(w, http.StatusBadRequest, map[string]string{"error": "key is required"})
		return
	}
	if !s.prs.Dismiss(key) {
		writePRsJSON(w, http.StatusNotFound, map[string]string{"error": "no collected pull request with that key"})
		return
	}
	writePRsJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// refreshPRStatuses updates the stale cached states, and returns ONE human
// sentence when the status feature as a whole is unavailable ("" when it is
// fine).
//
// The sentence is about the FEATURE, not about a row: gh missing, or gh logged
// out. Per-row failures (a deleted repository, a permissions error, a timeout)
// belong on their row and are stored there by ApplyStatus, because one
// unreachable repository must not make every other row look broken -- the
// mistake the route being replaced made at the whole-applet level.
func (s *Server) refreshPRStatuses(ctx context.Context) string {
	stale := s.prs.NeedStatus(time.Now().Add(-prsStatusTTL).Unix(), prsStatusBatch)
	if len(stale) == 0 {
		// Nothing to do. Deliberately NOT reported as unavailable: with every
		// status fresh, whether gh works right now is not a question anyone
		// asked, and probing it to answer would be a subprocess per poll for
		// a sentence nobody reads.
		return ""
	}

	bin, err := exec.LookPath("gh")
	if err != nil {
		return "the GitHub CLI (gh) is not on PATH -- pull request status cannot be updated"
	}
	if err := ghAuthOK(ctx, bin); err != nil {
		return "the GitHub CLI is not authenticated (run: gh auth login) -- pull request status cannot be updated"
	}

	now := time.Now().Unix()
	sem := make(chan struct{}, prsStatusConcurrency)
	var wg sync.WaitGroup
	for _, p := range stale {
		wg.Add(1)
		go func(p CollectedPR) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			view, err := ghPRStatus(ctx, bin, p.Repo, p.Number)
			if err != nil {
				s.prs.ApplyStatus(p.Key, "", "", false, now, ghErrText(err))
				return
			}
			s.prs.ApplyStatus(p.Key, strings.ToUpper(view.State), view.Title, view.IsDraft, now, "")
		}(p)
	}
	wg.Wait()
	return ""
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

// ghPRStatus reads one pull request's current state.
//
// --repo is explicit, so this runs correctly from ANY working directory --
// which is the property the old root-scanning route did not have and could not
// be given. The repository comes from the URL sessiond scraped when the lane
// opened the pull request, so a repo nobody has a worktree for any more still
// refreshes.
func ghPRStatus(ctx context.Context, bin, repo string, number int) (ghPRView, error) {
	ctx, cancel := context.WithTimeout(ctx, prsViewDeadline)
	defer cancel()

	cmd := exec.CommandContext(ctx, bin,
		"pr", "view", strconv.Itoa(number),
		"--repo", repo,
		"--json", "state,title,isDraft",
	)
	// stdin is nil so a gh that decides to prompt (an expired token, say) hits
	// EOF immediately instead of hanging until the deadline. Output(), not
	// CombinedOutput(): gh writes warnings to stderr and mixing them into the
	// JSON would make it unparseable.
	cmd.Stdin = nil
	data, err := cmd.Output()
	if err != nil {
		return ghPRView{}, err
	}
	var view ghPRView
	if err := json.Unmarshal(data, &view); err != nil {
		return ghPRView{}, err
	}
	if view.State == "" {
		return ghPRView{}, errors.New("gh reported no state")
	}
	return view, nil
}

// ghErrText renders a gh failure as one short human sentence, preferring gh's
// own words on stderr to Go's "exit status 1". It is gitErrText's sibling in
// files_api.go, kept separate because it also clips: this string goes on a row
// in a narrow column, not into a footnote.
func ghErrText(err error) string {
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		if msg := strings.TrimSpace(string(ee.Stderr)); msg != "" {
			if i := strings.IndexByte(msg, '\n'); i >= 0 {
				msg = msg[:i]
			}
			return truncatePRTitle(msg)
		}
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timed out asking GitHub"
	}
	return truncatePRTitle(err.Error())
}
