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
import tempfile
import time
from pathlib import Path
from typing import Any

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

MODE_PLAIN = "plain"
MODE_GOAL = "goal"

# Display bounds. A goal lane's first prompt is an entire inlined goal file and
# an artifact list is unbounded; neither belongs on a sidebar row, and neither
# should be allowed to grow a snapshot file without limit.
NAME_MAX_CHARS = 80
DOING_MAX_CHARS = 120
DONE_MEANS_MAX_CHARS = 400
KNOWS_MAX_ENTRIES = 50
KNOWS_ENTRY_MAX_CHARS = 256


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
    text = " ".join(text.split())
    if len(text) > limit:
        text = text[: limit - 1].rstrip() + "\u2026"
    return text


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
        "project",
        "name",
        "mode",
        "state",
        "waiting_for",
        "doing",
        "done_means",
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
        self.project = os.getcwd()
        self.name = ""
        self.mode = MODE_PLAIN
        self.state = STATE_WORKING
        self.waiting_for = ""
        self.doing = ""
        self.done_means = ""
        self.knows: list[str] = []
        self._knows_seen: set[str] = set()
        # goal_finished pins mode=goal across the moment the orchestrator drops
        # session_state["goal"], so a lane that just finished still reads as the
        # goal lane it was instead of silently reverting to "plain".
        self.goal_finished = False
        self.path = spool / f"{session_id}.json"
        self._last_payload: str | None = None

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
        self.waiting_for = reason

    def set_working(self, doing: str | None = None) -> None:
        self.state = STATE_WORKING
        self.waiting_for = ""
        if doing is not None:
            self.doing = doing

    def to_payload(self) -> dict[str, Any]:
        """Render the snapshot.

        Field names are the JSON tags of sessiond.SessionState. `pid` is the one
        addition -- the daemon consumes it to find the owning pane and does not
        forward it -- and paneId/workspaceId are deliberately absent because the
        daemon fills them during that join.
        """
        payload: dict[str, Any] = {
            "pid": self.pid,
            "pidStart": self.pid_start,
            "sessionId": self.session_id,
            "name": self.name,
            "mode": self.mode,
            "state": self.state,
            "updatedAt": int(time.time()),
        }
        if self.project:
            payload["project"] = self.project
        if self.waiting_for:
            payload["waitingFor"] = self.waiting_for
        if self.doing:
            payload["doing"] = self.doing
        if self.done_means:
            payload["doneMeans"] = self.done_means
        if self.knows:
            payload["knows"] = self.knows
        return payload

    # -- durability ---------------------------------------------------------

    def flush(self) -> None:
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
        if rendered == self._last_payload and self.path.exists():
            return

        body = json.dumps(payload, separators=(",", ":"))
        # A deterministic sibling temp name, not mkstemp: hooks for one session
        # run sequentially on a single event loop, so there is no writer to race
        # with, and a plain open() avoids the file-descriptor ownership hazard
        # of mkstemp + fdopen (a failure between the two either leaks the fd or
        # double-closes a number the runtime may already have handed out again).
        # It must be a sibling so os.replace stays within one filesystem, which
        # is what makes it atomic.
        tmp = self.path.with_name(f".{self.session_id}.tmp")
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with open(tmp, "w", encoding="utf-8") as handle:
                handle.write(body)
            os.chmod(tmp, 0o600)
            os.replace(tmp, self.path)
            self._last_payload = rendered
        except Exception as exc:
            logger.debug("hooks-muxterm-session: snapshot write failed: %s", exc)
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass

def sweep_stale(spool: Path) -> None:
    """Delete snapshots whose process is gone.

    A snapshot deliberately outlives its session so the home view can show how
    that session ended (see on_session_end). Something still has to reclaim
    them, and the daemon only reaps while a browser is subscribed -- so on a
    machine where nobody ever opens the home view, this sweep is the only one
    that ever runs.

    Identity, not just liveness: a file is removed when its process is gone OR
    when the pid is now held by a different process, which pidStart detects. A
    snapshot with no pidStart (written by an older hook, or off Linux) falls
    back to a liveness check alone.

    Entirely best-effort. Failing to sweep costs a stale file; raising here
    would cost a session.
    """
    if not os.path.isdir("/proc"):
        # Liveness here is a /proc existence test. Without /proc every pid would
        # look dead and the sweep would delete every live session's snapshot.
        # Do nothing rather than something destructive.
        return
    try:
        entries = list(spool.iterdir())
    except OSError:
        return
    for entry in entries:
        if entry.suffix != ".json" or not entry.is_file():
            continue
        try:
            with entry.open("r", encoding="utf-8") as fh:
                snap = json.load(fh)
            pid = snap.get("pid")
            if not isinstance(pid, int) or pid <= 0:
                continue
            # Our own pid is NOT special-cased. Our own snapshot carries our
            # own pidStart, so the identity check below keeps it; skipping it
            # would instead have punched a hole exactly where a recycled pid
            # needs catching.
            alive = os.path.exists(f"/proc/{pid}")
            if alive:
                recorded = snap.get("pidStart")
                if isinstance(recorded, int) and recorded > 0:
                    alive = _pid_start_time(pid) == recorded
            if not alive:
                entry.unlink(missing_ok=True)
        except Exception:
            continue


# Records are process-global rather than per-coordinator because a delegated
# sub-agent mounts this module again, against its own coordinator, inside this
# same process. Keying by session id is what lets a child find its root.
_RECORDS: dict[str, SessionRecord] = {}
# child session id -> parent session id, so a sub-agent's activity can be folded
# into the root row that actually owns a pane.
_PARENTS: dict[str, str] = {}
# child session id -> agent name, captured from session:fork for the `doing` line.
_AGENTS: dict[str, str] = {}


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

    def __init__(self, coordinator: Any, spool: Path) -> None:
        self._coordinator = coordinator
        self._spool = spool

    # -- goal mode ----------------------------------------------------------

    def _goal(self) -> dict[str, Any] | None:
        """Read the live /goal state off the coordinator.

        There is no --goal flag and no environment variable: `/goal` is a slash
        command that writes coordinator.session_state["goal"] (amplifier_app_cli
        main.py), and the loop-streaming orchestrator reads it back on every
        turn. Reading the same dict is therefore the authoritative answer, and
        it is live -- the orchestrator clears it the instant the loop ends.

        session_state is absent from the published type stub, so it is accessed
        defensively; a kernel that drops it degrades this to plain-mode, which
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
            record.mode = MODE_GOAL
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
            record.mode = MODE_PLAIN
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
        # published itself as `mode=plain, state=stopped`: a quiet plain session
        # resting at its prompt, which is exactly the reading that must never be
        # confused with a goal outcome, in the direction that HIDES a failure.
        if record.mode == MODE_GOAL:
            record.goal_finished = True

        if record.goal_finished:
            # Hold the goal identity through the terminal verdict so the row
            # still reads as the lane it was. Released by the next
            # prompt:submit, so a session that returns to ordinary chat
            # correctly degrades back to plain.
            return
        record.mode = MODE_PLAIN
        record.done_means = ""

    # -- record lookup ------------------------------------------------------

    def _record(self, data: dict[str, Any]) -> SessionRecord | None:
        """Resolve the pane-owning record for an event, creating it if needed.

        Every kernel event carries session_id and parent_id -- the registry
        stamps them as default fields on emit -- so this needs no state of its
        own beyond the fork chain.
        """
        session_id = data.get("session_id")
        if not isinstance(session_id, str) or not session_id:
            return None
        parent_id = data.get("parent_id")
        if isinstance(parent_id, str) and parent_id:
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

    @staticmethod
    def _is_child(data: dict[str, Any]) -> bool:
        parent_id = data.get("parent_id")
        return isinstance(parent_id, str) and bool(parent_id)

    def _agent_prefix(self, data: dict[str, Any]) -> str:
        """Label a sub-agent's activity so the root row stays honest."""
        session_id = data.get("session_id")
        agent = _AGENTS.get(session_id) if isinstance(session_id, str) else None
        return f"[{agent}] " if agent else "[delegate] "

    # -- handlers -----------------------------------------------------------

    async def on_session_start(self, event: str, data: dict[str, Any]) -> None:
        if self._is_child(data):
            return
        record = self._record(data)
        if record is None:
            return
        # Reclaim what previous sessions left behind. This is the only sweep
        # that runs on a machine where nobody ever opens the home view, and it
        # costs one directory listing per session start.
        sweep_stale(self._spool)
        self._sync_mode(record)
        record.flush()

    async def on_session_fork(self, event: str, data: dict[str, Any]) -> None:
        """Note nested activity on the root row.

        session:fork fires on the child's own coordinator before its
        session:start, carrying the parent id and the agent's name. Recording
        the lineage here is what lets every later child event find the root
        record, and naming the agent is what makes the root's `doing` line say
        something truer than "waiting".
        """
        session_id = data.get("session_id")
        parent_id = data.get("parent_id")
        if not isinstance(session_id, str) or not isinstance(parent_id, str):
            return
        _PARENTS[session_id] = parent_id
        metadata = data.get("metadata")
        agent = metadata.get("agent_name") if isinstance(metadata, dict) else None
        if isinstance(agent, str) and agent:
            _AGENTS[session_id] = agent
        record = _RECORDS.get(_root_id(session_id))
        if record is None:
            return
        record.set_working(_clip(f"delegating to {agent or 'sub-agent'}", DOING_MAX_CHARS))
        record.flush()

    async def on_prompt_submit(self, event: str, data: dict[str, Any]) -> None:
        record = self._record(data)
        if record is None:
            return
        if self._is_child(data):
            return
        # A new prompt is unambiguously the start of work: it clears any stale
        # blocked reason and releases the pinned terminal goal verdict.
        self._sync_mode(record, fresh_turn=True)
        if not record.name:
            record.name = _first_line(data.get("prompt"), NAME_MAX_CHARS)
        record.set_working("")
        record.flush()

    async def on_tool_pre(self, event: str, data: dict[str, Any]) -> None:
        record = self._record(data)
        if record is None:
            return
        tool = data.get("tool_name")
        doing = _describe_tool(tool, data.get("tool_input"))
        if self._is_child(data):
            record.doing = _clip(self._agent_prefix(data) + doing, DOING_MAX_CHARS)
        else:
            self._sync_mode(record)
            record.set_working(_clip(doing, DOING_MAX_CHARS))
        record.flush()

    async def on_tool_post(self, event: str, data: dict[str, Any]) -> None:
        record = self._record(data)
        if record is None:
            return
        if not self._is_child(data):
            self._sync_mode(record)
            # Post-tool the session is back to thinking. Leaving `doing` on the
            # finished tool would make a long provider call look like a stuck
            # tool call.
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
        error = data.get("error")
        if isinstance(error, dict):
            detail = error.get("msg") or error.get("type") or ""
        else:
            detail = error or ""
        label = data.get("tool_name") or data.get("provider") or "call"
        prefix = self._agent_prefix(data) if self._is_child(data) else ""
        record.doing = _clip(f"{prefix}{label} error: {detail}", DOING_MAX_CHARS)
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
        record.set_blocked(WAITING_FOR_PERMISSION)
        action = data.get("action") or data.get("tool_name")
        if action:
            record.doing = _clip(f"approval: {action}", DOING_MAX_CHARS)
        record.flush()

    async def on_approval_resolved(self, event: str, data: dict[str, Any]) -> None:
        record = self._record(data)
        if record is None:
            return
        if record.state == STATE_BLOCKED:
            record.set_working(record.doing)
        record.flush()

    async def on_user_notification(self, event: str, data: dict[str, Any]) -> None:
        """Explicit request for the user's attention.

        Handled because the contract names it, but note it is currently a dead
        channel: nothing in the installed kernel or any mounted module emits
        user:notification. End-of-turn notification runs off
        orchestrator:complete instead (the notify bundle emits its own
        notify:turn-complete), which is exactly why this handler must NOT be
        reachable from a normal turn ending -- a plain session resting at its
        prompt is not blocked.

        Because the channel is dead, its future ordering relative to
        end-of-turn is unknowable, and the two possibilities want opposite
        handling. If it were ever to fire AFTER end-of-turn, and the block
        survived the turn boundary, every idle plain session would surface as
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
        record.mode = MODE_GOAL
        condition = data.get("condition")
        if isinstance(condition, str) and condition:
            record.done_means = _clip(condition, DONE_MEANS_MAX_CHARS)
        state = data.get("state")
        if state == "achieved":
            record.state = STATE_DONE
            record.waiting_for = ""
            record.goal_finished = True
        elif state in ("stalled", "error"):
            record.state = STATE_FAILED
            record.waiting_for = ""
            record.goal_finished = True
        elif state in ("cap_hit", "cancelled"):
            record.state = STATE_STOPPED
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

        A plain session ending its turn and waiting for the user is its CONTRACT,
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
            record.waiting_for = ""
        record.flush()

    async def on_prompt_complete(self, event: str, data: dict[str, Any]) -> None:
        """Root-session end of turn: the CLI is back at its input prompt.

        Emitted only by the app layer after session.execute() returns, so a
        sub-agent never reaches this. For a goal run it fires once, after the
        whole loop, which is why it does not need a goal_final guard of its own.
        """
        if self._is_child(data):
            return
        record = self._record(data)
        if record is None:
            return
        self._sync_mode(record)
        if record.state in (STATE_WORKING, STATE_BLOCKED):
            record.state = STATE_STOPPED
            record.waiting_for = ""
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
        unrelated process that later inherits the pid. Reclamation happens at
        the next session's start (see sweep_stale) and, when a browser is
        watching, in the daemon's own dead-pid reaping.
        """
        if self._is_child(data):
            self._forget(data.get("session_id"))
            return
        record = self._record(data)
        if record is None:
            return
        if record.state in (STATE_WORKING, STATE_BLOCKED, STATE_STOPPED):
            record.state = STATE_DONE
            record.waiting_for = ""
        record.flush()

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
        # Any child still pointing at this root is unreachable too.
        for child, parent in list(_PARENTS.items()):
            if parent == session_id:
                _PARENTS.pop(child, None)
                _AGENTS.pop(child, None)


def _describe_tool(tool: Any, tool_input: Any) -> str:
    """One short human line for a tool call.

    Deliberately shallow: it names the tool and, where a single obvious subject
    exists, that subject. It never renders arbitrary tool arguments, because a
    prompt or a file body would blow the line budget and leak content into a
    file whose whole point is being cheap to read.
    """
    name = tool if isinstance(tool, str) and tool else "tool"
    if not isinstance(tool_input, dict):
        return name
    for key in ("file_path", "path", "pattern", "command", "url", "agent", "skill_name"):
        value = tool_input.get(key)
        if isinstance(value, str) and value:
            return f"{name}: {value}"
    return name
