package sessiond

// File-watch triggers.
//
// Three things make naive file watching fail in practice, and each is handled
// here rather than left to the user to discover:
//
//   DEBOUNCE   one editor save emits several events; a build emits thousands.
//   IGNORES    watching a repo without excluding .git and node_modules buries
//              you in events and can pin a CPU.
//   LIMITS     inotify has a per-user watch cap, and exhausting it breaks
//              OTHER SOFTWARE on the machine, not just muxterm.
//
// loom -- the closest prior art, and the reason this list is not guesswork --
// has the debounce and neither of the other two.

import (
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

const (
	// triggerWatchDebounce is the quiet window a burst must clear before the
	// trigger fires once.
	//
	// loom uses 300ms and 300ms is right FOR LOOM, whose runs are shell
	// commands. A fire here launches an AI coding agent that makes commits and
	// costs money, so the window is longer on purpose: the cost of waiting an
	// extra second and a half is nil, and the cost of firing twice for one
	// `git checkout` is two lanes racing on the same tree.
	triggerWatchDebounce = 2 * time.Second

	// triggerWatchDirCap bounds how many directories one trigger may watch.
	//
	// fs.inotify.max_user_watches is a PER-USER limit shared with every editor,
	// language server and file indexer the user is running. Blowing through it
	// makes those tools fail in ways that look nothing like a muxterm bug.
	triggerWatchDirCap = 2000
)

// triggerWatchIgnoreDirs are never watched and never walked into.
//
// Skipped during the WALK, not filtered after the fact: a filtered .git still
// consumed a watch descriptor and still woke the process for every object git
// wrote. The point is to not watch them at all.
var triggerWatchIgnoreDirs = map[string]bool{
	".git":          true,
	".hg":           true,
	".svn":          true,
	"node_modules":  true,
	".venv":         true,
	"venv":          true,
	"__pycache__":   true,
	"target":        true,
	"dist":          true,
	"build":         true,
	".next":         true,
	".nuxt":         true,
	"vendor":        true,
	".idea":         true,
	".vscode":       true,
	".mypy_cache":   true,
	".pytest_cache": true,
	".ruff_cache":   true,
	".tox":          true,
	".gradle":       true,
	".terraform":    true,
	".cache":        true,
	"coverage":      true,
}

// triggerWatchIgnoreFile reports whether an event on this path is editor noise
// rather than a change worth a lane.
//
// Vim writes and removes a file literally called 4913 to test whether a
// directory is writable; every editor writes and renames a temp file beside the
// real one. Firing on those means firing several times per save even after the
// debounce, because they land in separate windows when a human types slowly.
func triggerWatchIgnoreFile(path string) bool {
	base := filepath.Base(path)
	switch {
	case base == "4913", base == ".DS_Store", base == "Thumbs.db":
		return true
	case strings.HasSuffix(base, "~"):
		return true
	case strings.HasSuffix(base, ".swp"), strings.HasSuffix(base, ".swx"), strings.HasSuffix(base, ".swo"):
		return true
	case strings.HasSuffix(base, ".tmp"), strings.HasSuffix(base, ".part"), strings.HasSuffix(base, ".crdownload"):
		return true
	case strings.HasPrefix(base, ".#"): // emacs lock files
		return true
	case strings.HasPrefix(base, "~$"): // office lock files
		return true
	}
	// Anything inside an ignored directory, for events that arrive on a path
	// we did not add a watch for (a rename INTO .git, for instance).
	for _, part := range strings.Split(filepath.ToSlash(path), "/") {
		if triggerWatchIgnoreDirs[part] {
			return true
		}
	}
	return false
}

// triggerWatcher is one trigger's live fsnotify watch.
type triggerWatcher struct {
	id   string
	root string
	w    *fsnotify.Watcher

	mu    sync.Mutex
	timer *time.Timer
	// dirs is what is currently watched, so a newly created subdirectory can
	// be added without re-walking the whole tree.
	dirs map[string]bool
}

// triggerWatchDirs walks root and returns the directories that should be
// watched, refusing rather than truncating when the tree is too large.
//
// REFUSING IS THE DELIBERATE CHOICE. A partially-watched tree is a trigger that
// silently never fires for half its paths, which from outside is
// indistinguishable from a broken trigger -- and it is discovered at 3am in a
// log nobody reads. Failing at create time puts the problem in front of a human
// while they are still looking at it.
func triggerWatchDirs(root string) ([]string, error) {
	info, err := os.Stat(root)
	if err != nil {
		return nil, fmt.Errorf("cannot watch %s: %w", root, err)
	}
	if !info.IsDir() {
		// A single file is watched by watching its directory and filtering:
		// editors replace files by rename, which destroys a watch registered
		// on the file itself and makes the trigger silently stop working after
		// the first save.
		return []string{filepath.Dir(root)}, nil
	}
	var dirs []string
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			// An unreadable subdirectory is skipped, not fatal: a repo with one
			// root-owned directory in it should still be watchable.
			if d != nil && d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.IsDir() {
			return nil
		}
		if path != root && triggerWatchIgnoreDirs[d.Name()] {
			return filepath.SkipDir
		}
		dirs = append(dirs, path)
		if len(dirs) > triggerWatchDirCap {
			return fmt.Errorf("more than %d directories under %s (ignoring %s and friends): "+
				"watching a tree this large risks exhausting the per-user inotify limit, "+
				"which breaks other software on this machine. Watch a subdirectory instead",
				triggerWatchDirCap, root, strings.Join(sortedIgnoreSample(), ", "))
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return dirs, nil
}

// sortedIgnoreSample names a few ignored directories for an error message.
func sortedIgnoreSample() []string {
	return []string{".git", "node_modules", ".venv", "target", "dist"}
}

// ensureWatcher starts a watch for t if one is not already running.
func (e *triggerEngine) ensureWatcher(t Trigger) {
	e.mu.Lock()
	_, exists := e.watchers[t.ID]
	e.mu.Unlock()
	if exists {
		return
	}
	tw, err := e.startWatcher(t)
	if err != nil {
		log.Printf("sessiond: trigger %q could not watch %s: %v", t.Name, t.Path, err)
		// Recorded so a watch that never armed is visible in the fire log
		// rather than being an absence. Disabled outright: a watch trigger
		// whose path does not exist will not start working by itself, and a
		// per-second retry that logs forever is worse than being off.
		e.store.RecordFire(t.ID, TriggerFire{
			At:      time.Now().Unix(),
			Outcome: FireError,
			Detail:  err.Error(),
		}, func(t *Trigger) {
			t.Enabled = false
			t.DisabledReason = "could not watch " + t.Path + ": " + err.Error()
		})
		return
	}
	e.mu.Lock()
	e.watchers[t.ID] = tw
	e.mu.Unlock()
}

func (e *triggerEngine) startWatcher(t Trigger) (*triggerWatcher, error) {
	dirs, err := triggerWatchDirs(t.Path)
	if err != nil {
		return nil, err
	}
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	tw := &triggerWatcher{id: t.ID, root: t.Path, w: w, dirs: make(map[string]bool, len(dirs))}
	for _, d := range dirs {
		if err := w.Add(d); err != nil {
			// One failed directory is not worth abandoning the whole watch --
			// unless it is the root, which means the watch is not doing what it
			// was asked to do at all.
			if d == t.Path {
				w.Close()
				return nil, fmt.Errorf("cannot watch %s: %w", d, err)
			}
			continue
		}
		tw.dirs[d] = true
	}
	go tw.run(e.fireCh)
	log.Printf("sessiond: trigger %q watching %s (%d directories, %s debounce)",
		t.Name, t.Path, len(tw.dirs), triggerWatchDebounce)
	return tw, nil
}

// run consumes fsnotify events, coalescing each burst into ONE fire.
//
// The debounce is a restartable timer rather than a rate limiter: every event
// pushes the deadline out, so a burst of a thousand build writes produces one
// fire triggerWatchDebounce after the LAST of them, not one per window during.
func (tw *triggerWatcher) run(fireCh chan<- string) {
	for {
		select {
		case ev, ok := <-tw.w.Events:
			if !ok {
				return
			}
			if triggerWatchIgnoreFile(ev.Name) {
				continue
			}
			// A new subdirectory has to be watched or changes inside it are
			// invisible. Bounded by the same cap so `mkdir -p a/b/c/...` in a
			// loop cannot walk past it.
			if ev.Op&fsnotify.Create != 0 {
				if info, err := os.Stat(ev.Name); err == nil && info.IsDir() {
					tw.addDir(ev.Name)
				}
			}
			tw.bump(fireCh)
		case err, ok := <-tw.w.Errors:
			if !ok {
				return
			}
			if !errors.Is(err, fsnotify.ErrEventOverflow) {
				log.Printf("sessiond: watch error under %s: %v", tw.root, err)
				continue
			}
			// The kernel queue overflowed: events were LOST. Firing is the
			// right answer -- something changed, we just cannot say what --
			// and it is exactly what the debounce is for.
			log.Printf("sessiond: watch queue overflowed under %s; firing on the assumption something changed", tw.root)
			tw.bump(fireCh)
		}
	}
}

func (tw *triggerWatcher) addDir(path string) {
	tw.mu.Lock()
	defer tw.mu.Unlock()
	if tw.dirs[path] || len(tw.dirs) >= triggerWatchDirCap {
		return
	}
	if triggerWatchIgnoreDirs[filepath.Base(path)] {
		return
	}
	if err := tw.w.Add(path); err == nil {
		tw.dirs[path] = true
	}
}

// bump restarts the debounce timer.
func (tw *triggerWatcher) bump(fireCh chan<- string) {
	tw.mu.Lock()
	defer tw.mu.Unlock()
	if tw.timer != nil {
		tw.timer.Stop()
	}
	id := tw.id
	tw.timer = time.AfterFunc(triggerWatchDebounce, func() {
		select {
		case fireCh <- id:
		default:
			// The engine is behind. A watch fire is an EDGE: a second edge
			// arriving while the first is still unprocessed means the same
			// thing as one, so dropping it loses nothing.
		}
	})
}

func (tw *triggerWatcher) close() {
	tw.mu.Lock()
	if tw.timer != nil {
		tw.timer.Stop()
		tw.timer = nil
	}
	tw.mu.Unlock()
	tw.w.Close()
}

// stopWatcher tears down a trigger's watch. Called when it is disabled or
// deleted, which is what makes both take effect immediately.
func (e *triggerEngine) stopWatcher(id string) {
	e.mu.Lock()
	tw := e.watchers[id]
	delete(e.watchers, id)
	e.mu.Unlock()
	if tw != nil {
		tw.close()
	}
}

// syncWatchers starts watches for every enabled watch trigger at startup.
func (e *triggerEngine) syncWatchers() {
	for _, t := range e.store.All() {
		if t.Kind == TriggerKindWatch && t.Enabled {
			e.ensureWatcher(t)
		}
	}
}

func (e *triggerEngine) closeWatchers() {
	e.mu.Lock()
	all := make([]*triggerWatcher, 0, len(e.watchers))
	for id, tw := range e.watchers {
		all = append(all, tw)
		delete(e.watchers, id)
	}
	e.mu.Unlock()
	for _, tw := range all {
		tw.close()
	}
}
