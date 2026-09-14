"""Declare what this Amplifier session is doing, into a file muxterm reads.

Why this exists at all
----------------------
muxterm's daemon already classifies pane activity (internal/sessiond/activity.go)
by asking TIOCGPGRP which process group owns the terminal. That signal cannot
answer the only question the home view actually cares about: an agent that is
thinking owns the terminal, and an agent that is sitting at a permission prompt
waiting for a human ALSO owns the terminal. Identical PTY state, opposite
meanings. The distinction is the entire product and it is not recoverable by
inspection -- so the session declares it instead.

Transport: a file, deliberately
-------------------------------
One JSON snapshot per session, atomically replaced under a spool directory that
mirrors sessiond's own socketDir() (internal/sessiond/spawn.go). Not the binary
control protocol: speaking that from Python would couple this hook to a frame
codec it has no business knowing, and would make every daemon restart a
reconnect problem. Snapshots are idempotent whole-state documents, so a write
that is lost, raced, or skipped is repaired by the next event rather than
leaving the daemon holding a wrong delta forever.

The hook does NOT resolve its own pane or workspace. It records its pid; the
daemon knows which pane owns which process and performs that join. Teaching this
hook about muxterm's internals would put the same knowledge in two places.

Failure policy
--------------
Nothing here may block or break a session. Every handler body is wrapped, every
exception is swallowed at the boundary, and a hook that cannot write its spool
file simply stops contributing. The kernel also logs-and-skips a raising handler
(crates/amplifier-core/src/hooks.rs), so this is belt and braces -- appropriate,
because the cost of a bug here is a broken user session and the benefit is a
sidebar decoration.

Root sessions only
------------------
A delegated sub-agent gets its own coordinator and its own mount() call in the
SAME OS process, so module state here is shared across a root session and all
its children. Every child shares the root's pid, so writing a spool file per
sub-session would map several rows onto one pane. Only root sessions
(parent_id is None) own a file; a child's events fold into its root's `doing`
line, which is what "delegating to explorer" should mean anyway.
"""

from __future__ import annotations

import json
import logging
import os
import re
import stat
import tempfile
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

logger = logging.getLogger(__name__)

# --- contract mirror -------------------------------------------------------
# These strings are the wire contract with internal/sessiond/sessionstate.go
# and web/src/lib/session-state.ts. Changing one changes all three.

STATE_WORKING = "working"
STATE_BLOCKED = "blocked"
STATE_DONE = "done"
STATE_FAILED = "failed"
STATE_STOPPED = "stopped"

WAITING_FOR_PERMISSION = "permission prompt"
WAITING_FOR_INPUT = "input needed"

# Run mode. These names are harness-neutral on purpose: they answer "does going
# quiet mean broke or resting?", which is a universal distinction, whereas the
# old goal|plain spelling only named it correctly if you already knew what
# Amplifier's /goal command was. See internal/sessiond/sessionstate.go.
MODE_INTERACTIVE = "interactive"
MODE_AUTONOMOUS = "autonomous"

# The three states that are an ENDING rather than a moment. A snapshot in one
# of these outlives the process that wrote it -- the home view exists to answer
# "how did it end?", and a row that vanishes the instant the agent exits cannot.
TERMINAL_STATES = frozenset({STATE_DONE, STATE_FAILED, STATE_STOPPED})

# How long an ending is kept once its process is gone, when this sweep is the
# only thing reclaiming it.
#
# The daemon has a far better bound -- it reclaims an ending the moment that
# PANE runs something else or is closed, so the row lives exactly as long as the
# terminal it describes. This sweep has no pane knowledge, so it falls back to
# time. A day is chosen to be longer than any plausible "I came back to see what
# happened" and short enough that an unwatched machine does not accumulate.
ENDING_TTL_SECONDS = 24 * 60 * 60

# Which coding-agent CLI this producer speaks for. Amplifier's hook only ever
# writes one value; the field exists because the home view is a fleet view for
# any harness, and a row that does not say what is running it cannot be badged.
HARNESS = "amplifier"

# Snapshot schema version. Bump ONLY for a breaking change to the on-disk
# shape; a reader that does not understand the version skips the file with a
# logged reason rather than guessing. Additive optional fields do not need a
# bump -- that is what makes them additive. See docs/session-state-protocol.md.
SCHEMA_VERSION = 1
PUBLISHER = "hooks-muxterm-session/0.7.0"
MAX_SNAPSHOT_BYTES = 64 * 1024
_SESSION_ID = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
_LIFECYCLES = frozenset(
    {"initialized", "running", "resumed", "turn-complete", "completed", "failed", "cancelled", "unknown"}
)

# Display bounds. A goal lane's first prompt is an entire inlined goal file and
# an artifact list is unbounded; neither belongs on a sidebar row, and neither
# should be allowed to grow a snapshot file without limit.
NAME_MAX_CHARS = 80
DOING_MAX_CHARS = 120
# The one variable part of a mid-turn `doing` phrase -- a filename, a search
# pattern, an agent name. It shares the line with the phrase around it and, for
# a sub-agent, with an "[explorer] " prefix, so it is bounded well below
# DOING_MAX_CHARS: one long filename must not squeeze out the English half of
# the row, which is the half that says what is happening.
SUBJECT_MAX_CHARS = 60
DONE_MEANS_MAX_CHARS = 400
KNOWS_MAX_ENTRIES = 50
KNOWS_ENTRY_MAX_CHARS = 256
# The in-progress todo item's own text. It occupies the SAME card line `doing`
# would have, so it gets the same order of budget rather than a larger one.
TODO_CURRENT_MAX_CHARS = 100
TODO_MAX_ENTRIES = 999
TODO_ITEM_MAX_CHARS = 1_000
_TODO_STATUSES = frozenset({"pending", "in_progress", "completed"})
_DIAGNOSTIC_WARNED: set[tuple[str, str, str]] = set()


def spool_dir() -> Path:
    """Resolve the snapshot spool directory.

    Mirrors sessiond's socketDir() (internal/sessiond/spawn.go) exactly, so the
    writer and the reader cannot disagree about where snapshots live:

      - $XDG_RUNTIME_DIR set  -> $XDG_RUNTIME_DIR/muxterm/session-state
      - otherwise             -> <tmp>/muxterm-<uid>/session-state

    Deriving it from XDG_RUNTIME_DIR rather than hardcoding a path is what makes
    `make dev-local` isolation work for free: that target overrides
    XDG_RUNTIME_DIR, sessiond inherits it, panes inherit it from sessiond, and
    this hook -- running inside a pane -- lands in the same private tree as the
    daemon that will read it. A dev daemon can never read production's spool.

    MUXTERM_SESSION_STATE_DIR overrides both, for tests and odd deployments.
    """
    override = os.environ.get("MUXTERM_SESSION_STATE_DIR")
    if override:
        return Path(override)
    runtime = os.environ.get("XDG_RUNTIME_DIR")
    if runtime:
        return Path(runtime) / "muxterm" / "session-state"
    return Path(tempfile.gettempdir()) / f"muxterm-{os.getuid()}" / "session-state"


def _pid_session_id(pid: int) -> int:
    """Read a process's POSIX session id -- the join, reduced to one integer.

    sessiond gives every pane its own pty and makes the pane's root shell the
    leader of a new session, so every process started in that terminal carries
    that shell's pid as its session id. The daemon builds a map keyed on
    exactly those pids, which makes this a single lookup instead of a walk.

    It is recorded here, by the writer, rather than derived by the reader,
    because the reader may be looking at this file after this process has
    exited -- and an ancestor walk needs /proc entries that are gone by then.
    Capturing it while we are alive is what lets our FINAL row still be shown
    on the terminal we ran in, which is the whole question the home view
    exists to answer.

    Field 6 of /proc/<pid>/stat, index 3 of the fields AFTER comm. Split on the
    LAST ')' for the reason every other reader of this file does.

    Returns 0 when unavailable (non-Linux, or an unreadable stat), which the
    daemon treats as "no anchor" and falls back to its ancestor walk.
    """
    try:
        with open(f"/proc/{pid}/stat", "r", encoding="utf-8", errors="replace") as fh:
            line = fh.read()
        after = line[line.rindex(")") + 1 :].split()
        return int(after[3])
    except Exception:
        return 0


def _pid_start_time(pid: int) -> int:
    """Read a process's start time, so a pid can be identified rather than
    merely named.

    A pid alone is not an identity: it is recycled. A snapshot left behind by a
    session that ended can outlive its process, and if the daemon later sees
    that pid alive again -- now belonging to somebody's editor -- it would walk
    up from it, find a real pane, and publish a stale session row glued to a
    terminal that has nothing to do with it. Indistinguishable from a real row,
    and it persists for as long as the recycling process does.

    (pid, start_time) IS an identity: the kernel's boot-relative start time
    cannot repeat for a recycled pid. The daemon compares both.

    Field 22 of /proc/<pid>/stat, which is index 19 of the fields AFTER the
    comm field. Split on the LAST ')' for the same reason every other reader of
    this file does: comm is parenthesized and a process may rename itself to
    something containing spaces and parens.

    Returns 0 when unavailable (non-Linux, or an unreadable stat), which the
    daemon treats as "unverifiable" rather than "mismatched" -- degrading to
    today's pid-only behaviour rather than dropping the row.
    """
    try:
        with open(f"/proc/{pid}/stat", "r", encoding="utf-8", errors="replace") as fh:
            line = fh.read()
        after = line[line.rindex(")") + 1 :].split()
        return int(after[19])
    except Exception:
        return 0


def _clip(text: Any, limit: int) -> str:
    """Collapse arbitrary event text to one bounded display line."""
    if not isinstance(text, str):
        text = "" if text is None else str(text)
    # A snapshot is rendered outside this process.  Keep terminal controls and
    # other non-printing bytes out even when an event source supplies them.
    text = "".join(char if ord(char) >= 32 and ord(char) != 127 else " " for char in text)
    text = " ".join(text.split())
    if len(text) > limit:
        text = text[: limit - 1].rstrip() + "\u2026"
    return text


def _valid_session_id(session_id: Any) -> bool:
    return isinstance(session_id, str) and bool(_SESSION_ID.fullmatch(session_id)) and not session_id.startswith(".")


def _private_dir(path: Path) -> bool:
    """Create and validate an owner-private, non-symlink directory."""
    try:
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        info = path.lstat()
        return (
            stat.S_ISDIR(info.st_mode)
            and info.st_uid == os.getuid()
            and not (info.st_mode & 0o077)
        )
    except OSError:
        return False


def _atomic_write(path: Path, body: bytes) -> bool:
    """Atomically write a small private file without following temp symlinks."""
    if not _private_dir(path.parent):
        return False
    tmp_name = ""
    try:
        fd, tmp_name = tempfile.mkstemp(prefix=f".{path.stem}.", suffix=".tmp", dir=path.parent)
        with os.fdopen(fd, "wb") as handle:
            try:
                os.fchmod(handle.fileno(), 0o600)
                handle.write(body)
                handle.flush()
                try:
                    os.fsync(handle.fileno())
                except OSError:
                    pass
            except Exception:
                raise
        os.replace(tmp_name, path)
        return True
    except OSError:
        return False
    finally:
        if tmp_name:
            try:
                os.unlink(tmp_name)
            except FileNotFoundError:
                pass
            except OSError:
                pass


def write_diagnostic(
    spool: Path,
    session_id: Any,
    *,
    status: str,
    code: str,
    pid: int | None = None,
    pid_start: int | None = None,
) -> bool:
    """Best-effort bounded publisher diagnostic; it never contains raw errors."""
    if status not in {"initialized", "disabled", "failed", "unobserved", "observed"}:
        status = "failed"
    if not _valid_session_id(session_id):
        return False
    pid = os.getpid() if pid is None else pid
    pid_start = _pid_start_time(pid) if pid_start is None else pid_start
    payload = {
        "v": 1,
        "sessionId": session_id,
        "pid": pid if isinstance(pid, int) and pid > 0 else 0,
        "pidStart": pid_start if isinstance(pid_start, int) and pid_start > 0 else 0,
        "publisher": PUBLISHER,
        "status": status,
        "code": _clip(code, 64) or "unknown",
        "updatedAt": int(time.time()),
    }
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    if len(body) >= MAX_SNAPSHOT_BYTES:
        return False
    if not _private_dir(spool):
        _warn_diagnostic_once(session_id, status, "diagnostic-spool-unavailable")
        return False
    ok = _atomic_write(spool / ".reporting" / f"{session_id}.json", body)
    if not ok:
        _warn_diagnostic_once(session_id, status, "diagnostic-write-failed")
    return ok


def _warn_diagnostic_once(session_id: str, status: str, code: str) -> None:
    outcome = (session_id, status, code)
    if outcome not in _DIAGNOSTIC_WARNED:
        _DIAGNOSTIC_WARNED.add(outcome)
        # Code-only: no filesystem paths, exception strings, or tool payloads.
        logger.warning("hooks-muxterm-session: %s", code)


_NO_TODO_RESULT = object()


def _todo_progress(tool_input: Any, result: Any) -> dict[str, Any] | None | object:
    """Project a successful `todo` result's authoritative output into progress.

    TOOL_PRE is an attempted mutation, not a committed one.  TOOL_POST carries
    the actual tool result and only its narrowly-shaped ``result.output.todos``
    is authoritative.  ``None`` means an explicit successful empty list (clear);
    the sentinel means no mutation.
    """
    if not isinstance(tool_input, dict):
        return _NO_TODO_RESULT
    if tool_input.get("action") not in ("create", "update"):
        return _NO_TODO_RESULT
    if not isinstance(result, dict) or result.get("success") is not True:
        return _NO_TODO_RESULT
    output = result.get("output")
    if not isinstance(output, dict) or "todos" not in output:
        return _NO_TODO_RESULT
    todos = output.get("todos")
    if not isinstance(todos, list) or len(todos) > TODO_MAX_ENTRIES:
        return _NO_TODO_RESULT
    if not todos:
        return None

    done = 0
    current = ""
    for item in todos:
        if not isinstance(item, dict):
            return _NO_TODO_RESULT
        status = item.get("status")
        content = item.get("content")
        active_form = item.get("activeForm")
        if (
            status not in _TODO_STATUSES
            or not isinstance(content, str)
            or not content.strip()
            or len(content) > TODO_ITEM_MAX_CHARS
            or not isinstance(active_form, str)
            or not active_form.strip()
            or len(active_form) > TODO_ITEM_MAX_CHARS
        ):
            return _NO_TODO_RESULT
        if status == "completed":
            done += 1
        elif status == "in_progress" and not current:
            # activeForm first -- "Cutting the release" reads as a state, which
            # is what a progress line is for; `content` is imperative ("Cut the
            # release") and reads as an instruction to the reader.
            current = _clip(
                active_form,
                TODO_CURRENT_MAX_CHARS,
            )

    progress: dict[str, Any] = {"done": done, "total": len(todos)}
    if current:
        # Omitted when nothing is in progress -- a list that is all-pending or
        # all-complete has a truthful fraction and no current item, and inventing
        # one would be the same lie `doing` already tells.
        progress["current"] = current
    return progress


def _first_line(text: Any, limit: int) -> str:
    """Take the first meaningful line of a prompt, for use as a session name.

    A goal lane is launched headless as `/goal <the entire goal file>`, so the
    raw prompt is kilobytes of markdown with @mentions already expanded. The
    first non-empty line after stripping the slash command is the closest thing
    to a title that exists, and it cost nothing because a human typed it.
    """
    if not isinstance(text, str):
        return ""
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("/"):
            # "/goal ensure X" -> "ensure X"; a bare "/goal" falls through to
            # the next non-empty line rather than naming the session "/goal".
            parts = line.split(None, 1)
            line = parts[1].strip() if len(parts) > 1 else ""
            if not line:
                continue
        line = line.lstrip("#").strip()
        if line:
            return _clip(line, limit)
    return ""


class SessionRecord:
    """One session's live projection, and the writer for its snapshot file.

    Every mutation goes through a setter that marks the record dirty; `flush`
    is a no-op when the rendered payload is byte-identical to what is already on
    disk. That is what keeps a chatty tool:pre/tool:post stream from turning
    into a write storm on a tmpfs.
    """

    __slots__ = (
        "session_id",
        "pid",
        "pid_start",
        "sid",
        "sid_start",
        "project",
        "name",
        "label",
        "mode",
        "state",
        "lifecycle",
        "waiting_for",
        "doing",
        "done_means",
        "todo",
        "knows",
        "_knows_seen",
        "goal_finished",
        "path",
        "_last_payload",
    )

    def __init__(self, session_id: str, spool: Path) -> None:
        self.session_id = session_id
        self.pid = os.getpid()
        self.pid_start = _pid_start_time(self.pid)
        self.sid = _pid_session_id(self.pid)
        self.sid_start = _pid_start_time(self.sid) if self.sid > 0 else 0
        self.project = os.getcwd()
        self.name = ""
        # A 1-3 word tab label, derived once from the first prompt (label.py).
        # Empty means "nothing better than what the daemon already derived at
        # spawn from argv" -- see internal/sessiond/autolabel.go.
        self.label = ""
        self.mode = MODE_INTERACTIVE
        # A mounted, live process has not necessarily started executing a turn.
        self.state = STATE_STOPPED
        self.lifecycle = "initialized"
        self.waiting_for = ""
        self.doing = ""
        self.done_means = ""
        # Structured progress from this session's own todo list, or None when it
        # has never called the todo tool. None is load-bearing: it is what tells
        # the browser to fall back to `doing` rather than draw an empty 0/0.
        self.todo: dict[str, Any] | None = None
        self.knows: list[str] = []
        self._knows_seen: set[str] = set()
        # goal_finished pins mode=goal across the moment the orchestrator drops
        # session_state["goal"], so a lane that just finished still reads as the
        # goal lane it was instead of silently reverting to "plain".
        self.goal_finished = False
        self.path = spool / f"{session_id}.json"
        self._last_payload: str | None = None
        self._adopt_prior_ending()

    def _adopt_prior_ending(self) -> None:
        """Inherit the terminal verdict of an EARLIER run of this same session.

        A goal lane no longer ends when its loop ends: the pane immediately
        resumes that same session interactively so the work stays reachable
        (internal/sessiond/goallane.go). The resumed process is a NEW process
        with a NEW record, and without this it would publish
        `interactive/working` -- a lane that has finished its goal reporting
        that it is still working, and indistinguishable from an interactive
        lane that never had a goal. Those are the two readings the mode
        distinction exists to prevent, and it would produce both at once.

        Read from the session's own snapshot file, whose name is the session id,
        so this can only ever adopt from a previous run of the SAME session --
        never from a neighbouring one. The collector owns stale-spool cleanup,
        so this writer never removes another session's record before the
        handover can read its own terminal verdict.

        Deliberately narrow. Only an AUTONOMOUS snapshot in a TERMINAL state is
        adopted, which is exactly "a goal run that ended". An interactive
        ending, or a row still claiming to work, is left alone and the session
        starts fresh exactly as before -- being wrong here would pin a goal
        identity onto an ordinary chat session, and a wrong `doneMeans` is a
        stop condition nobody agreed to.

        The pin is released by the next prompt:submit
        (_sync_mode(fresh_turn=True)): the moment a human types, this stops
        being a finished goal lane and becomes the ordinary chat session it now
        is, and reads as one.
        """
        if not _valid_session_id(self.session_id):
            return
        try:
            if not _private_dir(self.path.parent):
                return
            fd = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, "rb") as handle:
                info = os.fstat(handle.fileno())
                if (
                    not stat.S_ISREG(info.st_mode)
                    or info.st_uid != os.getuid()
                    or info.st_mode & 0o077
                    or info.st_size >= MAX_SNAPSHOT_BYTES
                ):
                    return
                body = handle.read(MAX_SNAPSHOT_BYTES)
                if len(body) >= MAX_SNAPSHOT_BYTES:
                    return
                prior = json.loads(body)
        except Exception:
            # No prior snapshot, unreadable, or not JSON. A fresh session is
            # the correct and safe reading of all three.
            return
        if (
            not isinstance(prior, dict)
            or prior.get("v", SCHEMA_VERSION) != SCHEMA_VERSION
            or prior.get("sessionId") != self.session_id
            or prior.get("publisher") != PUBLISHER
        ):
            return
        if prior.get("mode") != MODE_AUTONOMOUS:
            return
        state = prior.get("state")
        if state not in TERMINAL_STATES:
            return
        if prior.get("lifecycle") not in {"completed", "failed", "cancelled"}:
            return

        self.mode = MODE_AUTONOMOUS
        self.state = state
        self.lifecycle = prior["lifecycle"]
        self.goal_finished = True
        # The stop condition is the one fact that makes this row legible as a
        # finished goal lane rather than as some idle session, and it cannot be
        # recovered from anywhere else once the loop has dropped it.
        prior_done_means = prior.get("doneMeans")
        if isinstance(prior_done_means, str) and prior_done_means:
            self.done_means = _clip(prior_done_means, DONE_MEANS_MAX_CHARS)
        # Name and label are carried for continuity only: the pane and the row
        # should not appear to become a different lane at the handover.
        prior_name = prior.get("name")
        if isinstance(prior_name, str) and prior_name:
            self.name = _clip(prior_name, NAME_MAX_CHARS)
        prior_label = prior.get("label")
        if isinstance(prior_label, str) and prior_label:
            self.label = _clip(prior_label, SUBJECT_MAX_CHARS)

    # -- projection ---------------------------------------------------------

    def note_read(self, path: Any) -> None:
        """Record a distinct artifact:read path.

        A session that read very little and then failed was starved, not merely
        unlucky, and that distinction is invisible without this list.
        """
        if not isinstance(path, str) or not path:
            return
        # Bound the ENTRY, not just the count: artifact:read carries whatever
        # the emitting tool put in data.path, and 50 unbounded strings are read
        # from disk, hashed, and fanned out to every browser on every change.
        path = _clip(path, KNOWS_ENTRY_MAX_CHARS)
        if path in self._knows_seen:
            return
        if len(self.knows) >= KNOWS_MAX_ENTRIES:
            return
        self._knows_seen.add(path)
        self.knows.append(path)

    def set_blocked(self, reason: str) -> None:
        self.state = STATE_BLOCKED
        self.lifecycle = "running"
        self.waiting_for = reason

    def set_working(self, doing: str | None = None) -> None:
        self.state = STATE_WORKING
        self.lifecycle = "running"
        self.waiting_for = ""
        if doing is not None:
            self.doing = doing

    def to_payload(self) -> dict[str, Any]:
        """Render the snapshot.

        Field names are the JSON tags of sessiond.SessionState. `v`, `pid`,
        `pidStart` and `sid` are the on-disk additions -- the daemon consumes
        them and forwards none of them -- and paneId/workspaceId are
        deliberately absent because the daemon fills them during the pane join.

        The full contract, including what a non-Amplifier producer must write,
        is docs/session-state-protocol.md.
        """
        payload: dict[str, Any] = {
            "v": SCHEMA_VERSION,
            "pid": self.pid,
            "pidStart": self.pid_start,
            "sessionId": self.session_id,
            "harness": HARNESS,
            "name": _clip(self.name or self.session_id, NAME_MAX_CHARS),
            "mode": self.mode,
            "state": self.state,
            "lifecycle": self.lifecycle if self.lifecycle in _LIFECYCLES else "unknown",
            "updatedAt": int(time.time()),
            # On-disk provenance only: sessiond does not forward this producer
            # implementation detail to browser consumers.
            "publisher": PUBLISHER,
        }
        if self.sid:
            # Omitted when /proc could not answer. The daemon then falls back
            # to walking our ancestry, which works while we are alive and not
            # after -- see _pid_session_id.
            payload["sid"] = self.sid
        if self.sid_start > 0:
            payload["sidStart"] = self.sid_start
        if self.project:
            payload["project"] = _clip(self.project, 1024)
        if self.label:
            # Omitted until the model has produced one. Absent means "keep
            # whatever the daemon derived at spawn"; an empty string here would
            # instead read as "this session declares it has no label".
            payload["label"] = _clip(self.label, SUBJECT_MAX_CHARS)
        if self.waiting_for:
            payload["waitingFor"] = _clip(self.waiting_for, SUBJECT_MAX_CHARS)
        if self.doing:
            payload["doing"] = _clip(self.doing, DOING_MAX_CHARS)
        if self.done_means:
            payload["doneMeans"] = _clip(self.done_means, DONE_MEANS_MAX_CHARS)
        if self.todo:
            # Absent, not zeroed, for a session that tracks no todos. A consumer
            # reading `"todo": {"done":0,"total":0}` would draw a stalled-looking
            # 0/0; absence lets it draw what it drew before this field existed.
            payload["todo"] = self.todo
        if self.knows:
            payload["knows"] = [_clip(path, KNOWS_ENTRY_MAX_CHARS) for path in self.knows[:KNOWS_MAX_ENTRIES]]
        return payload

    # -- durability ---------------------------------------------------------

    def flush(
        self, *, diagnostic_status: str = "unobserved", diagnostic_code: str = "snapshot-written"
    ) -> bool:
        """Atomically replace this session's snapshot file.

        Write-then-rename, so a reader mid-tick sees either the previous whole
        document or the next one, never a half-written one. os.replace is atomic
        within a filesystem and the temp file is created in the destination
        directory to guarantee that.

        updatedAt is excluded from the change comparison on purpose: a heartbeat
        that rewrites an otherwise identical file every event would defeat the
        coalescing entirely. Staleness is still visible to the daemon, which
        stamps its own observation time and prunes on liveness.
        """
        payload = self.to_payload()
        compare = dict(payload)
        compare.pop("updatedAt", None)
        rendered = json.dumps(compare, sort_keys=True)
        # The content cache assumes the file it last wrote still exists. The
        # daemon unilaterally removes snapshots it judges dead, and an operator
        # may clear the spool, so a false negative there would erase a LIVE
        # session from the home view permanently -- the hook would never re-emit,
        # because its content is not changing. That is worst precisely for a
        # session sitting blocked at a permission prompt, whose content is
        # exactly what will not change. One stat is cheap next to the write it
        # usually avoids.
        if rendered == self._last_payload and self.path.exists() and not self.path.is_symlink():
            return True

        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        try:
            if not _valid_session_id(self.session_id) or len(body) >= MAX_SNAPSHOT_BYTES:
                raise OSError("invalid-snapshot")
            if not _atomic_write(self.path, body):
                raise OSError("snapshot-write")
            self._last_payload = rendered
            write_diagnostic(
                self.path.parent,
                self.session_id,
                # This writer cannot know whether the collector saw it.  Receipt
                # acknowledgement belongs to the collector commissioning path.
                status=diagnostic_status,
                code=diagnostic_code,
                pid=self.pid,
                pid_start=self.pid_start,
            )
            return True
        except Exception:
            # Do not include exception text: it can contain paths or tool data.
            logger.debug("hooks-muxterm-session: snapshot-write-failed")
            write_diagnostic(
                self.path.parent,
                self.session_id,
                status="failed",
                code="snapshot-write-failed",
                pid=self.pid,
                pid_start=self.pid_start,
            )
            return False

# Records are process-global rather than per-coordinator because a delegated
# sub-agent mounts this module again, against its own coordinator, inside this
# same process. Keying by session id is what lets a child find its root.
_RECORDS: dict[str, SessionRecord] = {}
# child session id -> parent session id, so a sub-agent's activity can be folded
# into the root row that actually owns a pane.
_PARENTS: dict[str, str] = {}
# child session id -> agent name, captured from session:fork for the `doing` line.
_AGENTS: dict[str, str] = {}
# Root id -> outstanding ``session-id + separator + approval-id`` tokens.  A
# child approval must not be cleared by another child's resolution.
_APPROVALS: dict[str, set[str]] = {}


def _root_id(session_id: str) -> str:
    """Walk up the fork chain to the session that owns a pane.

    Bounded: a cycle or a pathological delegation depth returns whatever it
    reached rather than spinning. Nothing here is worth a hang.
    """
    seen: set[str] = set()
    current = session_id
    for _ in range(32):
        parent = _PARENTS.get(current)
        if parent is None or parent in seen:
            return current
        seen.add(current)
        current = parent
    return current


class SessionStateTracker:
    """Turns the kernel event stream into muxterm's declared session state.

    One instance per mounted coordinator. It holds the coordinator only to read
    `session_state["goal"]`, which is where the /goal loop keeps its live stop
    condition -- the sole reliable answer to "is this session autonomous?".
    """

    def __init__(
        self,
        coordinator: Any,
        spool: Path,
        *,
        classify_enabled: bool = True,
        classify_model: str | None = None,
        label_enabled: bool = True,
        label_model: str | None = None,
    ) -> None:
        self._coordinator = coordinator
        self._spool = spool
        self._classify_enabled = classify_enabled
        self._classify_model = classify_model
        self._label_enabled = label_enabled
        self._label_model = label_model
        self._session_id, self._parent_id = self._coordinator_identity()
        self._approval_serial = 0
        self._ready_seen = False
        self._lifecycle_events: set[str] = set()

    def _coordinator_identity(self) -> tuple[str | None, str | None]:
        try:
            session_id = getattr(self._coordinator, "session_id", None)
            parent_id = getattr(self._coordinator, "parent_id", "__unattributed__")
        except Exception:
            return None, None
        return (
            session_id if _valid_session_id(session_id) else None,
            parent_id if _valid_session_id(parent_id) else
            None if parent_id is None else "__unattributed__",
        )

    def _identity(self, data: dict[str, Any]) -> tuple[str | None, str | None]:
        """Resolve event identity, falling back to this coordinator, not root."""
        session_id = data.get("session_id")
        if not _valid_session_id(session_id):
            session_id = self._session_id
        parent_id = data.get("parent_id", data.get("parent"))
        if _valid_session_id(parent_id):
            return session_id, parent_id
        if session_id is not None and _valid_session_id(_PARENTS.get(session_id)):
            # A known child can omit parent_id on follow-on events.  Its known
            # lineage wins over treating its data as a root event.
            parent_id = _PARENTS[session_id]
        elif session_id == self._session_id:
            parent_id = self._parent_id
        else:
            # A foreign event with no known ancestry cannot commission a root.
            return None, None
        return session_id, parent_id

    async def on_session_ready(self, session_id: str, parent_id: str | None) -> None:
        """Publish the pre-prompt initialized root record exactly once."""
        if self._ready_seen:
            return
        self._ready_seen = True
        if parent_id is not None:
            _PARENTS[session_id] = parent_id
            return
        record = _RECORDS.get(session_id)
        if record is None:
            record = SessionRecord(session_id, self._spool)
            _RECORDS[session_id] = record
        if not (record.mode == MODE_AUTONOMOUS and record.goal_finished and record.state in TERMINAL_STATES):
            record.state = STATE_STOPPED
            record.waiting_for = ""
            record.doing = "Initialized; awaiting first prompt"
        else:
            record.doing = f"Initialized; previous goal {record.state}"
        # A previous goal verdict is not a terminal report from this NEW
        # process. Keep its state/mode for handover, but provenance is current.
        record.lifecycle = "initialized"
        record.flush(diagnostic_status="initialized", diagnostic_code="ready")

    # -- goal mode ----------------------------------------------------------

    def _goal(self) -> dict[str, Any] | None:
        """Read the live /goal state off the coordinator.

        The version-matched `/goal` command writes
        coordinator.session_state["goal"], and the loop-streaming orchestrator
        reads it back on every turn. Reading the same dict is authoritative and
        live -- the orchestrator clears it the instant the loop ends.

        session_state is absent from the published type stub, so it is accessed
        defensively; a kernel that drops it degrades this to interactive mode, which
        is the safe direction.
        """
        try:
            state = getattr(self._coordinator, "session_state", None)
            if not isinstance(state, dict):
                return None
            goal = state.get("goal")
            return goal if isinstance(goal, dict) else None
        except Exception:
            return None

    def _sync_mode(self, record: SessionRecord, fresh_turn: bool = False) -> None:
        """Re-derive mode from live goal state.

        Mode is evaluated per event rather than pinned at kickoff because in an
        interactive session `/goal` is typed several turns in, and the loop can
        end while the session keeps going. A stale "goal" label on a session
        that has returned to normal chat would make every idle turn look like a
        broken loop -- the exact failure this feature exists to avoid, wearing a
        different hat.
        """
        goal = self._goal()
        if goal is not None:
            record.mode = MODE_AUTONOMOUS
            record.goal_finished = False
            condition = goal.get("condition")
            if isinstance(condition, str) and condition:
                record.done_means = _clip(condition, DONE_MEANS_MAX_CHARS)
            return

        if fresh_turn:
            # A new prompt arrived with no goal active. Whatever this session
            # used to be, this turn is ordinary chat -- so release the pin
            # rather than re-arming it below, which would make a session that
            # ran one /goal read as a goal lane forever.
            record.goal_finished = False
            record.mode = MODE_INTERACTIVE
            record.done_means = ""
            return

        # The goal state is gone but this record still believes it is a goal
        # session: that transition IS the terminal moment, so pin it here.
        #
        # It must be pinned here rather than in on_goal_progress, because the
        # orchestrator clears session_state["goal"] and emits
        # orchestrator:complete BEFORE it emits the terminal goal_progress --
        # the summary in between is a provider call that takes seconds. Pinning
        # on the later event left a window in which a finished goal lane
        # published itself as `mode=interactive, state=stopped`: a quiet
        # interactive session resting at its prompt, which is exactly the
        # reading that must never be confused with a goal outcome, in the
        # direction that HIDES a failure.
        if record.mode == MODE_AUTONOMOUS:
            record.goal_finished = True

        if record.goal_finished:
            # Hold the goal identity through the terminal verdict so the row
            # still reads as the lane it was. Released by the next
            # prompt:submit, so a session that returns to ordinary chat
            # correctly degrades back to interactive.
            return
        record.mode = MODE_INTERACTIVE
        record.done_means = ""

    # -- record lookup ------------------------------------------------------

    def _record(self, data: dict[str, Any]) -> SessionRecord | None:
        """Resolve the pane-owning record for an event, creating it if needed.

        Every kernel event carries session_id and parent_id -- the registry
        stamps them as default fields on emit -- so this needs no state of its
        own beyond the fork chain.
        """
        session_id, parent_id = self._identity(data)
        if session_id is None:
            return None
        if parent_id is not None:
            _PARENTS[session_id] = parent_id
            root = _root_id(session_id)
            # A child never creates a row: it has no pane of its own, it shares
            # its root's pid. It only annotates the root that does.
            return _RECORDS.get(root)
        record = _RECORDS.get(session_id)
        if record is None:
            record = SessionRecord(session_id, self._spool)
            _RECORDS[session_id] = record
        return record

    def _is_child(self, data: dict[str, Any]) -> bool:
        _, parent_id = self._identity(data)
        return parent_id is not None

    def _agent_prefix(self, data: dict[str, Any]) -> str:
        """Label a sub-agent's activity so the root row stays honest."""
        session_id, _ = self._identity(data)
        agent = _AGENTS.get(session_id) if isinstance(session_id, str) else None
        return f"[{agent}] " if agent else "[delegate] "

    # -- handlers -----------------------------------------------------------

    async def on_session_start(self, event: str, data: dict[str, Any]) -> None:
        if "start" in self._lifecycle_events:
            return
        self._lifecycle_events.add("start")
        if self._is_child(data):
            return
        record = self._record(data)
        if record is None:
            return
        # This kernel event occurs only for first execute, so it is affirmative
        # running evidence (unlike a mounted/alive coordinator).
        self._sync_mode(record, fresh_turn=True)
        record.set_working(record.doing)
        record.flush()

    async def on_session_resume(self, event: str, data: dict[str, Any]) -> None:
        if "resume" in self._lifecycle_events:
            return
        self._lifecycle_events.add("resume")
        if self._is_child(data):
            return
        record = self._record(data)
        if record is None:
            return
        # Resume's first lifecycle event proves this process is executing now;
        # it must not retain an earlier terminal row as its current state.
        self._sync_mode(record, fresh_turn=True)
        record.state = STATE_WORKING
        record.lifecycle = "resumed"
        record.waiting_for = ""
        if not record.doing:
            record.doing = "Resumed; running"
        record.flush()

    async def on_session_fork(self, event: str, data: dict[str, Any]) -> None:
        """Note nested activity on the root row.

        session:fork fires on the child's own coordinator before its
        session:start, carrying the parent id and the agent's name. Recording
        the lineage here is what lets every later child event find the root
        record, and naming the agent is what makes the root's `doing` line say
        something truer than "waiting".
        """
        session_id, parent_id = self._identity(data)
        if session_id is None or parent_id is None:
            return
        _PARENTS[session_id] = parent_id
        metadata = data.get("metadata")
        agent = metadata.get("agent_name") if isinstance(metadata, dict) else None
        if isinstance(agent, str) and agent:
            _AGENTS[session_id] = agent
        record = _RECORDS.get(_root_id(session_id))
        if record is None:
            return
        if not _APPROVALS.get(record.session_id):
            record.set_working(_clip(f"delegating to {agent or 'sub-agent'}", DOING_MAX_CHARS))
        record.flush()

    async def on_orchestrator_start(self, event: str, data: dict[str, Any]) -> None:
        """Actual execution start, including turns without prompt:submit."""
        record = self._record(data)
        if record is None or self._is_child(data):
            return
        self._sync_mode(record, fresh_turn=True)
        if not _APPROVALS.get(record.session_id):
            record.set_working("Executing turn")
        record.flush()

    async def on_prompt_submit(self, event: str, data: dict[str, Any]) -> None:
        """A prompt was sent. Publish that immediately, then name the session.

        The structural state is flushed BEFORE the labelling call, exactly as
        on_prompt_complete flushes before classifying and for the same reason:
        this handler sits in front of the turn actually starting, so a slow or
        unreachable provider must cost a late label and never a delayed
        session.
        """
        record = self._record(data)
        if record is None:
            return
        if self._is_child(data):
            return
        # Prompt submit is not guaranteed for every execution.  It only resets
        # goal handover identity; execution:start is what claims active work.
        self._sync_mode(record, fresh_turn=True)
        if not record.name:
            record.name = _first_line(data.get("prompt"), NAME_MAX_CHARS)
        record.flush()

        await self._maybe_label(record, data)

    async def _maybe_label(self, record: Any, data: dict[str, Any]) -> None:
        """Derive this session's tab label from its FIRST prompt, once.

        A record that already carries a label never recomputes one, and that
        rule is load-bearing rather than an optimisation. A tab that renames
        itself mid-session is worse than one named `Pane 7`: the label exists
        so you can find this session again, and a name that moves is a name you
        cannot aim at twice. The `doing` line is the field that tracks what is
        happening now; this one holds still.

        Deriving it here, from the prompt, rather than from the assistant's
        closing text at end of turn, is deliberate -- see label.py's module
        docstring for why the label describes what was ASKED rather than what
        was concluded, and why a wrong label that persists for a whole turn is
        the failure being avoided.

        `None` from the labeller leaves the record untouched, which means the
        pane keeps the deterministic label the daemon derived from argv at
        spawn. Nothing here can make a tab worse than it already was.

        The gate is "already HAS a label", not "has already tried": a session
        whose first attempt returned None -- no provider mounted yet, one
        timeout -- may be named by a later prompt. That is not churn, because
        the value it is replacing is the empty string; the rule this protects
        is that a label never changes into a DIFFERENT label, and one settled
        here is settled for the life of the session.
        """
        if not self._label_enabled:
            return
        if record.label:
            return
        prompt = data.get("prompt")
        if not isinstance(prompt, str) or not prompt.strip():
            return
        try:
            from .label import label_session

            label = await label_session(
                self._coordinator, prompt, model=self._label_model
            )
        except Exception:
            # The hook must never take a session down with it.
            return
        if not label:
            return
        record.label = label
        record.flush()

    async def on_tool_pre(self, event: str, data: dict[str, Any]) -> None:
        record = self._record(data)
        if record is None:
            return
        tool = data.get("tool_name")
        # A tool call that cannot be named specifically -- a shell command
        # whose verb this hook does not recognise -- falls back to what the
        # session is FOR rather than to a generic verb. The record already
        # carries both candidates: the label derived once from the first prompt
        # (label.py) and, failing that, that prompt's first line. A row reading
        # "auth redirect loop" tells you which session you are looking at; one
        # reading "Running a shell command" is true of every row on the page.
        doing = _describe_tool(
            tool, data.get("tool_input"), fallback=record.label or record.name
        )
        if self._is_child(data):
            record.doing = _clip(self._agent_prefix(data) + doing, DOING_MAX_CHARS)
        else:
            self._sync_mode(record)
            # An outstanding approval wins over incidental tool activity.
            if record.state != STATE_BLOCKED:
                record.set_working(_clip(doing, DOING_MAX_CHARS))
        record.flush()

    async def on_tool_post(self, event: str, data: dict[str, Any]) -> None:
        record = self._record(data)
        if record is None:
            return
        if not self._is_child(data):
            if data.get("tool_name") == "todo":
                progress = _todo_progress(data.get("tool_input"), data.get("result"))
                if progress is not _NO_TODO_RESULT:
                    # Explicit output.todos=[] clears committed progress.
                    record.todo = progress
            self._sync_mode(record)
            # Post-tool the session is back to thinking. Leaving `doing` on the
            # finished tool would make a long provider call look like a stuck
            # tool call.
            if record.state != STATE_BLOCKED:
                record.set_working(record.doing)
        record.flush()

    async def on_tool_error(self, event: str, data: dict[str, Any]) -> None:
        """A tool or provider error is not a session failure.

        The agent routinely recovers -- a failed grep, a rate limit, a retried
        request. Marking the session `failed` here would light up the home view
        for something the agent is about to handle by itself, so this only
        annotates `doing` and leaves the state alone.
        """
        record = self._record(data)
        if record is None:
            return
        prefix = self._agent_prefix(data) if self._is_child(data) else ""
        # Error strings can contain credentials or raw request bodies. A failed
        # call is not a terminal verdict; disclose only that structural fact.
        record.doing = _clip(f"{prefix}Call failed; recovery not yet reported", DOING_MAX_CHARS)
        record.flush()

    async def on_artifact_read(self, event: str, data: dict[str, Any]) -> None:
        record = self._record(data)
        if record is None:
            return
        record.note_read(data.get("path"))
        record.flush()

    async def on_approval_required(self, event: str, data: dict[str, Any]) -> None:
        """A human is being asked to approve a tool call. This is real blocking.

        The approval provider's default timeout is None, so this wait is
        genuinely unbounded -- it is the one state where a session cannot make
        progress without a person. approval:granted / approval:denied always
        follow on every non-fatal path and clear it.
        """
        record = self._record(data)
        if record is None:
            return
        session_id, _ = self._identity(data)
        if session_id is None:
            return
        root = _root_id(session_id)
        approval_id = self._approval_id(data)
        if approval_id == "__unknown__":
            self._approval_serial += 1
            approval_id = f"__unknown__:{self._approval_serial}"
        _APPROVALS.setdefault(root, set()).add(f"{session_id}\x1f{approval_id}")
        record.set_blocked(WAITING_FOR_PERMISSION)
        action = data.get("action") or data.get("tool_name")
        if action:
            record.doing = _clip(f"approval: {action}", DOING_MAX_CHARS)
        record.flush()

    async def on_approval_resolved(self, event: str, data: dict[str, Any]) -> None:
        record = self._record(data)
        if record is None:
            return
        session_id, _ = self._identity(data)
        if session_id is None:
            return
        root = _root_id(session_id)
        pending = _APPROVALS.get(root)
        if pending is not None:
            approval_id = self._approval_id(data)
            matches = [
                token for token in pending if token.endswith(f"\x1f{approval_id}")
            ]
            if len(matches) == 1:
                pending.remove(matches[0])
            elif approval_id == "__unknown__" and len(pending) == 1:
                # Older optional approval emitters omit an id.  They can only
                # resolve an unambiguous lone request, never another child's.
                pending.clear()
            if not pending:
                _APPROVALS.pop(root, None)
        if record.state == STATE_BLOCKED and not _APPROVALS.get(root):
            record.set_working(record.doing)
        record.flush()

    @staticmethod
    def _approval_id(data: dict[str, Any]) -> str:
        for key in ("approval_id", "request_id", "id"):
            value = data.get(key)
            if isinstance(value, str) and value:
                return _clip(value, 128)
        # A scoped unknown remains distinct from a real id and supports the
        # old single-outstanding-request compatibility case above.
        return "__unknown__"

    async def on_cancel_requested(self, event: str, data: dict[str, Any]) -> None:
        record = self._record(data)
        if record is None or self._is_child(data):
            return
        # Requesting is not completion: cancellation can still fail or finish
        # normally. Keep the interim declaration non-terminal and unknown.
        record.state = STATE_WORKING
        record.lifecycle = "unknown"
        record.waiting_for = ""
        record.doing = "Cancelling"
        record.flush()

    async def on_cancel_completed(self, event: str, data: dict[str, Any]) -> None:
        record = self._record(data)
        if record is None or self._is_child(data):
            return
        record.state = STATE_STOPPED
        record.lifecycle = "cancelled"
        record.waiting_for = ""
        record.doing = "Cancelled"
        record.flush()

    async def on_user_notification(self, event: str, data: dict[str, Any]) -> None:
        """Explicit request for the user's attention.

        Handled because the contract names it, but note it is currently a dead
        channel: nothing in the installed kernel or any mounted module emits
        user:notification. End-of-turn notification runs off
        orchestrator:complete instead (the notify bundle emits its own
        notify:turn-complete), which is exactly why this handler must NOT be
        reachable from a normal turn ending -- an interactive session resting at its
        prompt is not blocked.

        Because the channel is dead, its future ordering relative to
        end-of-turn is unknowable, and the two possibilities want opposite
        handling. If it were ever to fire AFTER end-of-turn, and the block
        survived the turn boundary, every idle interactive session would surface as
        needing input -- the failure that makes the whole home view worthless.
        If it fires BEFORE, letting the turn boundary clear it under-reports a
        real block.

        The end-of-turn downgrade is therefore kept deliberately: under-alarming
        costs a missed nudge, over-alarming trains the user to ignore the
        indicator entirely, and only the second failure is unrecoverable. When
        something starts emitting this event, revisit with its real ordering in
        hand rather than guessing now.
        """
        record = self._record(data)
        if record is None:
            return
        record.set_blocked(WAITING_FOR_INPUT)
        message = data.get("message") or data.get("reason")
        if message:
            record.doing = _clip(str(message), DOING_MAX_CHARS)
        record.flush()

    async def on_goal_progress(self, event: str, data: dict[str, Any]) -> None:
        """The /goal loop reporting its own verdict.

        This is the only place a session is allowed to reach `failed`: the goal
        evaluator is the one component that knows what "done" meant for this
        run, because the user told it.
        """
        record = self._record(data)
        if record is None:
            return
        if self._is_child(data):
            # Child progress is useful narration but never a root verdict.
            summary = data.get("summary") or data.get("reason")
            if summary:
                record.doing = _clip(
                    self._agent_prefix(data) + str(summary), DOING_MAX_CHARS
                )
                record.flush()
            return
        record.mode = MODE_AUTONOMOUS
        condition = data.get("condition")
        if isinstance(condition, str) and condition:
            record.done_means = _clip(condition, DONE_MEANS_MAX_CHARS)
        state = data.get("state")
        if state == "achieved":
            record.state = STATE_DONE
            record.lifecycle = "completed"
            record.waiting_for = ""
            record.goal_finished = True
        elif state in ("stalled", "error"):
            record.state = STATE_FAILED
            record.lifecycle = "failed"
            record.waiting_for = ""
            record.goal_finished = True
        elif state in ("cap_hit", "cancelled"):
            record.state = STATE_STOPPED
            record.lifecycle = "cancelled"
            record.waiting_for = ""
            record.goal_finished = True
        else:
            record.set_working(record.doing)

        # `doing` is rebuilt from scratch each verdict rather than edited in
        # place: prepending a turn counter to whatever was already there would
        # accumulate "goal turn 3: goal turn 2: ..." across a long loop.
        summary = data.get("summary") or data.get("reason")
        turn = data.get("turn")
        if record.goal_finished:
            record.doing = _clip(str(summary), DOING_MAX_CHARS) if summary else ""
        elif isinstance(turn, int):
            tail = f": {summary}" if summary else ""
            record.doing = _clip(f"goal turn {turn}{tail}", DOING_MAX_CHARS)
        elif summary:
            record.doing = _clip(str(summary), DOING_MAX_CHARS)
        record.flush()

    async def on_orchestrator_complete(self, event: str, data: dict[str, Any]) -> None:
        """End of turn -- the load-bearing rule lives here.

        An interactive session ending its turn and waiting for the user is its CONTRACT,
        not a fault: it rests at `stopped` and must never be surfaced as needing
        input. A goal session mid-loop has not ended anything -- goal_final is
        False on every continuation -- and stays `working`. Without that guard a
        goal lane would appear to finish dozens of times in a row.

        A missing goal_final is treated as True, which is correct for a
        non-goal turn and for any orchestrator predating the flag.
        """
        if self._is_child(data):
            # A delegate finishing means the root is thinking again, not resting.
            record = self._record(data)
            if record is not None and record.state == STATE_WORKING:
                record.set_working("")
                record.flush()
            return
        record = self._record(data)
        if record is None:
            return
        if data.get("goal_final", True) is False:
            self._sync_mode(record)
            record.set_working(record.doing)
            record.flush()
            return
        self._sync_mode(record)
        if record.state in (STATE_WORKING, STATE_BLOCKED):
            record.state = STATE_STOPPED
            record.lifecycle = "turn-complete"
            record.waiting_for = ""
        record.flush()

    async def on_prompt_complete(self, event: str, data: dict[str, Any]) -> None:
        """Root-session end of turn: the CLI is back at its input prompt.

        Emitted only by the app layer after session.execute() returns, so a
        sub-agent never reaches this. For a goal run it fires once, after the
        whole loop, which is why it does not need a goal_final guard of its own.

        The structural verdict is published BEFORE any classification runs, and
        the classifier only ever amends it. This event fires at the instant the
        human gets their prompt back, so nothing may sit in front of it -- a
        row that updates a second late is fine, a session that stalls waiting
        on a model call is not.
        """
        if self._is_child(data):
            return
        record = self._record(data)
        if record is None:
            return
        self._sync_mode(record)
        already_blocked = record.state == STATE_BLOCKED
        if record.state in (STATE_WORKING, STATE_BLOCKED):
            record.state = STATE_STOPPED
            record.lifecycle = "turn-complete"
            record.waiting_for = ""
        record.flush()

        if already_blocked:
            # An explicit APPROVAL_REQUIRED or USER_NOTIFICATION already
            # settled this turn. The kernel told us outright; paying a model to
            # re-derive an answer we were handed would be pure cost.
            return
        await self._maybe_classify(record, data)

    async def _maybe_classify(self, record: Any, data: dict[str, Any]) -> None:
        """Read a finished turn and write the one line the row needs.

        `prompt:complete` proves the turn ended. It cannot distinguish "here is
        your answer" from "which option do you want?" -- both end a turn the
        same way. This reads the assistant's own closing text and asks a cheap
        model which one it was.

        The summary is written on BOTH branches, because a row in the home
        view's three-group lifecycle needs a line either way:

          - it wants you   -> the line says what to supply
          - it is over     -> the line says what it accomplished

        A finished session whose row reads only "stopped" has told you nothing
        you could not have guessed from the group it sits in. That is the whole
        reason the model is being asked at all.

        Every failure path leaves the structural verdict untouched. That
        direction is deliberate: a false alarm teaches people to ignore the
        indicator, which costs more than a missed one.
        """
        if not self._classify_enabled:
            return
        response = data.get("response")
        if not isinstance(response, str) or not response.strip():
            return
        try:
            from .classify import classify_turn

            verdict = await classify_turn(
                self._coordinator, response, model=self._classify_model
            )
        except Exception:
            # The hook must never take a session down with it.
            return
        if verdict is None:
            return
        needs_input, summary = verdict
        if needs_input:
            record.set_blocked(WAITING_FOR_INPUT)
        elif not summary:
            # Nothing to add to a row that already carries the right state.
            return
        if summary:
            record.doing = summary
        record.flush()

    async def on_session_end(self, event: str, data: dict[str, Any]) -> None:
        """The process is going away. Publish the ending and LEAVE the file.

        Deleting the snapshot here was tried and is wrong: the daemon samples
        the spool about once a second, so a write immediately followed by an
        unlink means it never observes the terminal state at all -- the row just
        vanishes from the home view. A lane that finished should say so. The
        whole point of the view is to answer "how did it end?", which a
        disappearing row cannot.

        Leaving the file behind is only safe because the snapshot carries
        pidStart as well as pid: a stale file cannot be misattributed to an
        unrelated process that later inherits the pid. Reclamation is
        bounded by collector policy: the daemon drops this row when its PANE
        runs something else or is closed. This writer never sweeps unrelated
        spool files.
        """
        if "end" in self._lifecycle_events:
            return
        self._lifecycle_events.add("end")
        if self._is_child(data):
            session_id, _ = self._identity(data)
            self._forget(session_id)
            return
        record = self._record(data)
        if record is None:
            return
        # Normal process completion does not mean its goal was achieved. Keep
        # an explicit terminal goal verdict; failed/cancelled process endings
        # still take precedence. Unknown status must never imply success.
        status = data.get("status")
        if status == "completed":
            if not (
                record.mode == MODE_AUTONOMOUS
                and record.goal_finished
                and record.state in TERMINAL_STATES
            ):
                record.state = STATE_DONE
            record.lifecycle = {
                STATE_DONE: "completed",
                STATE_FAILED: "failed",
                STATE_STOPPED: "cancelled",
            }[record.state]
            record.waiting_for = ""
        elif status == "failed":
            record.state = STATE_FAILED
            record.lifecycle = "failed"
            record.waiting_for = ""
        elif status == "cancelled":
            record.state = STATE_STOPPED
            record.lifecycle = "cancelled"
            record.waiting_for = ""
        else:
            record.state = STATE_STOPPED
            record.lifecycle = "unknown"
            record.waiting_for = ""
        record.flush()
        session_id, _ = self._identity(data)
        self._forget(session_id)

    @staticmethod
    def _forget(session_id: Any) -> None:
        """Drop a finished session from the process-global maps.

        These are shared by every session in the process (a delegated sub-agent
        mounts this module again against its own coordinator), so without this
        a long run with hundreds of delegations accumulates entries that are
        never reachable again.
        """
        if not isinstance(session_id, str) or not session_id:
            return
        _RECORDS.pop(session_id, None)
        _AGENTS.pop(session_id, None)
        _PARENTS.pop(session_id, None)
        _APPROVALS.pop(session_id, None)
        for pending in _APPROVALS.values():
            for token in tuple(pending):
                if token.startswith(f"{session_id}\x1f"):
                    pending.remove(token)
        # Any child still pointing at this root is unreachable too.
        for child, parent in list(_PARENTS.items()):
            if parent == session_id:
                _PARENTS.pop(child, None)
                _AGENTS.pop(child, None)
                for pending in _APPROVALS.values():
                    for token in tuple(pending):
                        if token.startswith(f"{child}\x1f"):
                            pending.remove(token)

    def cleanup(self) -> None:
        """Drop process-global bookkeeping, retaining the on-disk snapshot."""
        session_id, parent_id = self._coordinator_identity()
        if session_id is None:
            return
        if parent_id is None:
            self._forget(session_id)
            return
        _PARENTS.pop(session_id, None)
        _AGENTS.pop(session_id, None)
        for pending in _APPROVALS.values():
            for token in tuple(pending):
                if token.startswith(f"{session_id}\x1f"):
                    pending.remove(token)


# --- mid-turn narration ----------------------------------------------------
#
# What the row says WHILE a turn is running. At the END of a turn a model
# writes that line (classify.py); mid-turn there is deliberately no model,
# because this code runs on every single tool invocation and a provider
# round-trip per tool call would cost far more than the row is worth. So
# mid-turn narration is templating: a fixed English phrase per tool, plus at
# most one short subject lifted out of the arguments.
#
# The rule that shapes all of it is that tool ARGUMENTS are never rendered.
# They are unbounded by nature -- a prompt, a file body, a shell pipeline --
# and this line is one row in a list somebody scans, so a truncated fragment of
# a command teaches nothing about what the session is doing. That is not a
# hypothetical worry: this used to end in `return f"{name}: {value}"` with
# "command" among its keys, and live rows read
#
#     bash: cd /run/user/1000/muxterm/session-state && ls -la && echo "=== CO…
#
# A subject is lifted only when it is short AND is the thing the row is about:
# a file's basename, a search pattern, an agent name, a hostname. Where no such
# subject exists the phrase gets vaguer, never more literal -- a vague true
# phrase costs a little information, whereas a leaked argument costs the whole
# line and tells you nothing anyway.


def _arg(args: dict[str, Any], *keys: str) -> str:
    """First non-empty string argument among `keys`."""
    for key in keys:
        value = args.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return ""


def _phrase(verb: str, subject: str, when_unknown: str) -> str:
    """`Reading state.py`, or `Reading a file` when no subject survived."""
    return f"{verb} {subject or when_unknown}"


def _basename(path: Any) -> str:
    """The last component of a path -- the part that identifies it.

    Every session in the home view is running somewhere deep inside a worktree,
    so the leading directories are simultaneously identical across rows and
    long enough to eat the entire line budget on their own. `state.py` is the
    information; the sixty characters in front of it are not.
    """
    if not isinstance(path, str):
        return ""
    text = path.strip()
    if not text:
        return ""
    # An @mention ("@bundle:docs/README.md") names a file inside a bundle; the
    # half after the colon is an ordinary path.
    if text.startswith("@") and ":" in text:
        text = text.split(":", 1)[1]
    tail = text.rstrip("/").rsplit("/", 1)[-1]
    return _clip(tail or text, SUBJECT_MAX_CHARS)


# What a host may look like: letters, digits, dots, dashes, and the colons and
# brackets of an IPv6 literal. Anything else is not a host, whatever urlsplit
# says about it.
_HOSTNAME = re.compile(r"^[A-Za-z0-9._~\[\]:-]{1,253}$")


def _hostname(url: Any) -> str:
    """The host a URL points at, and nothing else.

    A URL is unbounded and routinely carries a query string, an access token or
    a session id. The host answers the only question the row is asking -- what
    is this session talking to -- and cannot leak a credential on the way.
    """
    if not isinstance(url, str) or not url.strip():
        return ""
    text = url.strip()
    try:
        # urlsplit needs an authority marker; "example.com/x" has none.
        host = urlsplit(text if "//" in text else "//" + text).hostname
    except ValueError:
        return ""
    # urlsplit is not a validator: handed "not a url at all" it hands back the
    # whole string as the host. Without this shape check the one argument this
    # function exists to keep off the row would go straight onto it.
    if not host or not _HOSTNAME.match(host):
        return ""
    return _clip(host, SUBJECT_MAX_CHARS)


# Shell command lines are scanned, never shown, so the scan is bounded twice:
# by how much of the string is read and by how many segments are considered. A
# command can legitimately be kilobytes long (a heredoc carrying a whole
# script), and the verb that names it is always in the first line or two.
_BASH_MAX_SCAN_CHARS = 1024
_BASH_MAX_SEGMENTS = 8

# Control operators. Splitting on these is what lets the scan walk PAST a
# preamble -- `cd /tmp && node -e "..."` is a node invocation, and taking
# argv[0] is exactly how `cd /run/user/...` ended up on a row.
_BASH_SPLIT = re.compile(r"&&|\|\||;|\||&|\n")

# An environment assignment in front of a command (`GOFLAGS=-mod=mod go test`).
_BASH_ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")

# Tokenisation. A quoted run counts as one word, so `cat 'my file.txt'` yields
# a filename rather than the word "my" -- a fragment of an argument is exactly
# the kind of half-truth this whole function exists to keep off the row.
_BASH_TOKEN = re.compile(r"'[^']*'|\"[^\"]*\"|\S+")

# A subcommand: lowercase, short, no path separator. The shape test is what
# keeps `git -C /some/worktree status` from reporting the worktree as the
# subcommand.
_BASH_SUBCOMMAND = re.compile(r"^[a-z][a-z0-9-]{0,23}$")

# Words that sit in FRONT of the command that matters: wrappers that delegate
# to their argument, and the shell keywords that open a branch or a loop body.
# Dropping them is not cosmetic -- `timeout 30 make build` is a build.
_BASH_SKIP_WORDS = frozenset(
    {
        "sudo", "env", "time", "nohup", "exec", "command", "builtin",
        "nice", "stdbuf", "timeout", "xargs", "watch",
        "then", "do", "else", "elif",
    }
)

# Verb -> phrase. Small on purpose: a verb belongs here only when its phrase
# beats the standing fallback, which is what this session is FOR. "Listing
# files" earns its place; a phrase like "Managing files" for `mv` does not, and
# such verbs are better left to fall through to the session's own label.
_BASH_VERBS = {
    "ls": "Listing files",
    "find": "Listing files",
    "fd": "Listing files",
    "tree": "Listing files",
    "grep": "Searching",
    "rg": "Searching",
    "ag": "Searching",
    "pytest": "Running tests",
    "vitest": "Running tests",
    "jest": "Running tests",
    "tsc": "Building",
    "cmake": "Building",
    "python": "Running a script",
    "python3": "Running a script",
    "node": "Running a script",
    "curl": "Fetching a web page",
    "wget": "Fetching a web page",
    "ps": "Checking processes",
    "pgrep": "Checking processes",
    "lsof": "Checking processes",
    "kill": "Stopping a process",
    "pkill": "Stopping a process",
    "killall": "Stopping a process",
    # A lane parked in `sleep 120` is polling something, and saying so is the
    # difference between a row that looks stuck and one that looks patient.
    "sleep": "Waiting",
}

# Verbs whose subject is a file worth naming.
_BASH_READ_VERBS = frozenset({"cat", "head", "tail", "bat", "less", "more"})

# Toolchain drivers: the first word says which ecosystem, the SUBCOMMAND says
# what is actually happening. `go build` and `go test` are different rows.
_BASH_DRIVERS = frozenset(
    {"go", "make", "npm", "pnpm", "yarn", "cargo", "uv", "just", "gradle", "mvn", "dotnet"}
)
_BASH_DRIVER_SUBS = {
    "test": "Running tests",
    "build": "Building",
    "compile": "Building",
    "install": "Installing dependencies",
    "ci": "Installing dependencies",
    "sync": "Installing dependencies",
    "add": "Installing dependencies",
    "run": "Running a script",
    "exec": "Running a script",
    "vet": "Checking the code",
    "lint": "Checking the code",
    "check": "Checking the code",
    "fmt": "Formatting code",
    "format": "Formatting code",
}
# What a driver means with no recognised subcommand. `make dev-local` is still
# a make invocation; `go mod tidy` is honestly just "go".
_BASH_DRIVER_DEFAULTS = {
    "make": "Building",
    "cargo": "Building",
    "gradle": "Building",
    "mvn": "Building",
    "dotnet": "Building",
}


def _bash_segments(command: str) -> list[list[str]]:
    """Split a command line into candidate commands, preamble already stripped.

    Each segment is returned as bare tokens with the leading noise removed:
    environment assignments, wrapper commands, stray flags, and the shell
    grouping punctuation that makes `(cd foo && make)` two words instead of a
    parenthesis. Segments are returned in order so the caller can walk forward
    until one of them is a command it recognises.
    """
    segments: list[list[str]] = []
    for raw in _BASH_SPLIT.split(command[:_BASH_MAX_SCAN_CHARS])[:_BASH_MAX_SEGMENTS]:
        tokens = [word.strip("()`'\"") for word in _BASH_TOKEN.findall(raw)]
        index = 0
        while index < len(tokens):
            word = tokens[index]
            if (
                not word
                or word in _BASH_SKIP_WORDS
                or _BASH_ASSIGNMENT.match(word)
                or word.startswith("-")
                or word.isdigit()
            ):
                index += 1
                continue
            break
        if index < len(tokens):
            segments.append(tokens[index:])
    return segments


def _bash_subcommand(rest: list[str]) -> str:
    """The subcommand word of a `git`/`go`/`npm` style invocation.

    Skips flags, and skips the argument of a short flag, because a short flag
    usually takes one (`git -C <dir> status`, `go -C <dir> build`). A long flag
    is left alone: `--no-pager` takes nothing, and swallowing the next word
    would eat the subcommand itself.
    """
    skip_next = False
    for token in rest:
        if skip_next:
            skip_next = False
            continue
        if token.startswith("--"):
            continue
        if token.startswith("-"):
            skip_next = len(token) == 2
            continue
        if _BASH_SUBCOMMAND.match(token):
            return token
        return ""
    return ""


def _bash_file_arg(rest: list[str]) -> str:
    """The file a `cat`/`head`/`tail` is aimed at, as a basename."""
    skip_next = False
    for token in rest:
        if skip_next:
            skip_next = False
            continue
        # A redirection and its target are plumbing, not the subject.
        if token.startswith((">", "<")):
            skip_next = True
            continue
        if token.startswith("-") or token.isdigit():
            continue
        # `cat $f` inside a loop names a file this hook cannot know. Printing
        # the variable instead would be a row that is confidently wrong, which
        # is worse than the vaguer phrase the caller falls back to.
        if "$" in token or "`" in token:
            return ""
        return _basename(token)
    return ""


def _bash_redirect_target(rest: list[str]) -> str:
    """The file a segment writes to, if it redirects into one.

    `cat > notes.md <<'EOF'` is a WRITE wearing a read verb's clothes, and it
    is how a shell writes a file. Without this the row would say "Reading",
    which is not vague -- it is false, and this line has no way to say sorry.
    """
    take_next = False
    for token in rest:
        if take_next:
            return _basename(token)
        if token.startswith(">"):
            tail = token.lstrip(">")
            if tail:
                return _basename(tail)
            take_next = True
    return ""


def _describe_bash(command: Any) -> str:
    """Name what a shell command is doing, without echoing any of it.

    Returns "" when nothing in the command line is recognisable, which is the
    signal for the caller to fall back to something better than a verb. The one
    thing this must never do is return the command itself.

    The scan walks segments until it finds a verb it knows rather than trusting
    the first word, because the first word is so often preamble -- `cd`, an
    environment assignment, a `mkdir` before the real work. An unrecognised
    verb is not an answer either, so a pipeline whose head means nothing here
    can still be named by something further along it.
    """
    if not isinstance(command, str) or not command.strip():
        return ""
    for tokens in _bash_segments(command):
        # `./scripts/build.sh` and `/usr/bin/make` are named by their last
        # component, exactly as a bare `make` is.
        verb = tokens[0].rsplit("/", 1)[-1]
        if verb == "git":
            # The one place a subcommand is echoed verbatim. `git status`,
            # `git rebase` and `git push` are different enough to matter and
            # short enough to fit, and the word is drawn from git's own
            # vocabulary rather than from anything a user typed.
            sub = _bash_subcommand(tokens[1:])
            return f"git {sub}" if sub else "Running git"
        if verb in _BASH_DRIVERS:
            sub = _bash_subcommand(tokens[1:])
            phrase = _BASH_DRIVER_SUBS.get(sub)
            if phrase:
                return phrase
            return _BASH_DRIVER_DEFAULTS.get(verb, f"Running {verb}")
        if verb in _BASH_READ_VERBS:
            written = _bash_redirect_target(tokens[1:])
            if written:
                return f"Editing {written}"
            return _phrase("Reading", _bash_file_arg(tokens[1:]), "a file")
        phrase = _BASH_VERBS.get(verb)
        if phrase:
            return phrase
        # An executable script (`./scripts/deploy.sh`) is named by what it is
        # rather than by what it does, which is all this can honestly say.
        if verb.endswith((".sh", ".py")):
            return "Running a script"
    return ""


def _describe_tool(tool: Any, tool_input: Any, fallback: str = "") -> str:
    """One short English phrase for a tool call in flight.

    Deliberately shallow: it names the action and, where a single obvious
    subject exists, that subject. It never renders arbitrary tool arguments,
    because a prompt or a file body would blow the line budget and leak content
    into a file whose whole point is being cheap to read.

    `fallback` is what the row should say when there is nothing specific to say
    -- a shell command this cannot name. Pass what the session is FOR, and the
    row degrades to that instead of to a verb that is true of every session on
    the page.
    """
    name = tool if isinstance(tool, str) and tool else ""
    args = tool_input if isinstance(tool_input, dict) else {}

    if name == "bash":
        described = _describe_bash(args.get("command"))
        if described:
            return described
        return _clip(fallback, SUBJECT_MAX_CHARS) or "Running a shell command"

    if name == "read_file":
        return _phrase("Reading", _basename(_arg(args, "file_path", "path")), "a file")
    if name in ("write_file", "edit_file", "apply_patch"):
        return _phrase("Editing", _basename(_arg(args, "file_path", "path")), "a file")
    if name in ("grep", "glob"):
        # A pattern is short by construction and is precisely what the search
        # is about, so it is one of the few arguments worth showing.
        pattern = _clip(_arg(args, "pattern"), SUBJECT_MAX_CHARS)
        return f"Searching for {pattern}" if pattern else "Searching"
    if name == "delegate":
        return _phrase("Delegating to", _clip(_arg(args, "agent"), SUBJECT_MAX_CHARS), "a sub-agent")
    if name == "load_skill":
        skill = _clip(_arg(args, "skill_name", "info"), SUBJECT_MAX_CHARS)
        return f"Loading the {skill} skill" if skill else "Loading a skill"
    if name == "web_search":
        query = _clip(_arg(args, "query"), SUBJECT_MAX_CHARS)
        return f"Searching the web for {query}" if query else "Searching the web"
    if name == "web_fetch":
        return _phrase("Fetching", _hostname(_arg(args, "url")), "a web page")
    if name == "todo":
        return "Updating the task list"

    # An unknown tool -- a recipe runner, an MCP server's verb -- still has one
    # thing worth saying about it, and it is the only part of the call that is
    # bounded and safe: its name. An event that arrives without even that has
    # nothing specific left, so it takes the standing fallback.
    if name:
        return f"Running {_clip(name, SUBJECT_MAX_CHARS)}"
    return _clip(fallback, SUBJECT_MAX_CHARS) or "Running a tool"
