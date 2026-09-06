#!/usr/bin/env python3
"""muxterm Chief-of-Staff sidecar.

One long-lived in-process amplifier session, driven by NDJSON over stdio.
See docs/designs/2026-09-06-cos-sidecar-spec.md sections 2 and 3.1 -- that
document is the contract; this file implements it.

Run with the amplifier venv interpreter (the one whose site-packages holds
amplifier_app_cli), e.g.::

    ~/.local/share/uv/tools/amplifier/bin/python3 sidecar/cos/main.py \
        --session-id muxterm-cos --bundle anchors --cwd /path/to/repo
"""

# ---------------------------------------------------------------------------
# stdout discipline -- spec 2.1.  MUST run before importing anything that might
# print.  The amplifier stack writes token-usage footers and streaming overlay
# paint to stdout; a single stray byte corrupts the protocol stream.  So: keep
# the real stdout as a private fd, and point fd 1 at stderr so every naive
# print() in the process lands somewhere harmless.
# ---------------------------------------------------------------------------
import os  # noqa: E402
import sys  # noqa: E402

_REAL_STDOUT_FD = os.dup(1)
os.dup2(2, 1)
_PROTO_STREAM = os.fdopen(_REAL_STDOUT_FD, "w", buffering=1, encoding="utf-8")

# Keep a reference to the original sys.stdout object so it is not garbage
# collected (which would close fd 1, now a dup of stderr) and repoint the name
# at stderr so sys.stdout writes are line-buffered onto stderr.
_ORIGINAL_SYS_STDOUT = sys.stdout
sys.stdout = sys.stderr

import argparse  # noqa: E402
import asyncio  # noqa: E402
import json  # noqa: E402
import logging  # noqa: E402
import signal  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
from dataclasses import dataclass, field  # noqa: E402
from datetime import datetime, timezone  # noqa: E402
from decimal import Decimal  # noqa: E402
from pathlib import Path  # noqa: E402
from typing import Any  # noqa: E402

_BOOT_T0 = time.monotonic()

logger = logging.getLogger("cos")

SESSION_COST_CHANNEL = "session.cost"
DEFAULT_APPROVAL_TIMEOUT = 300.0
SUMMARY_LIMIT = 240

# Serve-loop wake-up token.  Pushed onto the op queue by the signal handler so
# an IDLE sidecar (parked on queue.get(), which no signal interrupts) re-reads
# its stop flag immediately instead of waiting out the service manager's
# TimeoutStopSec.  A distinct object, not None: None already means "stdin
# closed", and conflating the two would log the wrong reason for the exit.
_WAKE = object()

# -- history op -------------------------------------------------------------
# Replay budget.  These caps exist because events.jsonl for this very session
# is megabytes with 90KB+ single lines: the history payload is a SUMMARY of
# the conversation, never the conversation's raw material.  Raw tool results
# and llm payloads are never included at any limit.
HISTORY_DEFAULT_LIMIT = 50
HISTORY_MAX_LIMIT = 200
HISTORY_PROMPT_LIMIT = 2000
HISTORY_TEXT_LIMIT = 4000
HISTORY_ARGS_LIMIT = 200
HISTORY_MAX_BLOCKS = 40

# -- clear op ---------------------------------------------------------------
# Where muxterm publishes one JSON file per live agent lane.  Each carries a
# "sessionId"; the FILENAME is that same id, which is the fallback when the
# file is unreadable or half-written.
SESSION_STATE_REL = ("muxterm", "session-state")
# How much of a session id has to appear in a message for it to count as a
# reference.  A full uuid is the normal case; 8 hex characters is the short
# form humans and tools paste around, and matching it errs toward KEEPING.
LANE_ID_PREFIX = 8


# ---------------------------------------------------------------------------
# Protocol writer
# ---------------------------------------------------------------------------
class Proto:
    """NDJSON writer onto the real stdout.  One JSON object per line."""

    def __init__(self, stream) -> None:
        self._stream = stream
        self._lock = threading.Lock()

    def emit(self, **fields: Any) -> None:
        line = json.dumps(fields, ensure_ascii=False, default=str)
        with self._lock:
            try:
                self._stream.write(line + "\n")
                self._stream.flush()
            except (BrokenPipeError, ValueError):
                # Host went away.  Nothing useful to do; the supervisor will
                # notice the process exit.
                logger.warning("protocol stream closed; dropping event")


# ---------------------------------------------------------------------------
# Approvals -- spec 3.1 / law 3
# ---------------------------------------------------------------------------
class ApprovalBroker:
    """Emits approval_request and awaits the matching approval op.

    A request that is never answered resolves to DENIED when the timeout
    expires.  Timeout never resolves to approved.
    """

    def __init__(self, proto: Proto, timeout: float) -> None:
        self._proto = proto
        self._timeout = timeout
        self._pending: dict[str, asyncio.Future] = {}
        self._seq = 0
        self.current_turn_id: str | None = None

    async def ask(
        self,
        *,
        tool: str,
        detail: str,
        options: list[str] | None = None,
        timeout: float | None = None,
    ) -> tuple[bool, str, str | None]:
        """Returns (approved, reason, explicit_choice)."""
        loop = asyncio.get_running_loop()
        self._seq += 1
        request_id = f"a-{self._seq}"
        wait_for = self._timeout if timeout is None else timeout
        fut: asyncio.Future = loop.create_future()
        self._pending[request_id] = fut

        payload: dict[str, Any] = {
            "ev": "approval_request",
            "request_id": request_id,
            "tool": tool,
            "detail": detail,
            "timeout": wait_for,
        }
        if self.current_turn_id:
            payload["turn_id"] = self.current_turn_id
        if options:
            payload["options"] = options
        self._proto.emit(**payload)

        try:
            approved, reason, choice = await asyncio.wait_for(fut, timeout=wait_for)
        except (asyncio.TimeoutError, TimeoutError):
            logger.warning("approval %s timed out after %ss -- denying", request_id, wait_for)
            return False, f"no response within {wait_for}s", None
        finally:
            self._pending.pop(request_id, None)
        return approved, reason, choice

    def resolve(self, request_id: str, approved: bool, reason: str, choice: str | None) -> bool:
        fut = self._pending.get(request_id)
        if fut is None or fut.done():
            return False
        fut.set_result((approved, reason, choice))
        return True


def _pick_option(options: list[str], approved: bool) -> str:
    """Map a boolean host decision onto one of the kernel's option strings."""
    allow_words = ("allow once", "allow", "yes", "approve", "continue", "proceed")
    deny_words = ("deny", "no", "reject", "cancel", "stop")
    words = allow_words if approved else deny_words
    lowered = [o.lower() for o in options]
    for word in words:
        for i, opt in enumerate(lowered):
            if opt.startswith(word):
                return options[i]
    return options[0] if approved else options[-1]


class HostApprovalSystem:
    """amplifier_core.approval.ApprovalSystem -- hook-driven ask_user gates."""

    def __init__(self, broker: ApprovalBroker) -> None:
        self._broker = broker

    async def request_approval(self, prompt: str, options: list[str], timeout: float, default: str) -> str:
        approved, _reason, choice = await self._broker.ask(
            tool="hook",
            detail=prompt,
            options=list(options),
            timeout=timeout if timeout and timeout > 0 else None,
        )
        if choice and choice in options:
            return choice
        return _pick_option(list(options), approved)


class HostApprovalProvider:
    """amplifier_core.interfaces.ApprovalProvider -- tool approval gates."""

    def __init__(self, broker: ApprovalBroker) -> None:
        self._broker = broker

    async def request_approval(self, request: Any) -> Any:
        from amplifier_core import ApprovalResponse

        detail = getattr(request, "action", "") or ""
        details = getattr(request, "details", None)
        if details:
            try:
                detail = f"{detail}\n{json.dumps(details, default=str)[:1000]}"
            except Exception:
                pass
        approved, reason, _choice = await self._broker.ask(
            tool=getattr(request, "tool_name", "unknown"),
            detail=detail,
            timeout=getattr(request, "timeout", None),
        )
        return ApprovalResponse(approved=approved, reason=reason)


class HostDisplay:
    """amplifier_core display system.  Hook chatter goes to stderr, not stdout."""

    def __init__(self) -> None:
        self._nesting = 0

    def show_message(self, message: str, level: str = "info", source: str = "hook") -> None:
        fn = {"error": logger.error, "warning": logger.warning}.get(level, logger.info)
        fn("[%s] %s", source, message)

    def push_nesting(self) -> None:
        self._nesting += 1

    def pop_nesting(self) -> None:
        if self._nesting > 0:
            self._nesting -= 1

    @property
    def nesting_depth(self) -> int:
        return self._nesting


# ---------------------------------------------------------------------------
# Turn bookkeeping
# ---------------------------------------------------------------------------
@dataclass
class Turn:
    id: str
    prompt: str
    started: float = 0.0
    task: "asyncio.Task | None" = None
    terminal_sent: bool = False
    cancel_requests: int = 0
    saw_stream_delta: bool = False
    tool_started_at: dict[str, float] = field(default_factory=dict)
    tool_ended: set = field(default_factory=set)
    # Foreground-delta gate -- see _register_hooks().  Background hook LLM
    # calls (muxterm pane labelling, session naming) emit their token deltas
    # onto the same hook bus with the same session_id; without this gate their
    # JSON answers stream into the chat as if the assistant had said them.
    fg_open: bool = False
    fg_request_id: "str | None" = None
    saw_provider_request: bool = False
    deltas_emitted: int = 0
    deltas_dropped: int = 0


def _clip(text: Any, limit: int = SUMMARY_LIMIT) -> str:
    s = text if isinstance(text, str) else str(text)
    s = s.replace("\n", " ").strip()
    return s if len(s) <= limit else s[: limit - 1] + "\u2026"


def _trim(text: Any, limit: int) -> str:
    """Length-cap that KEEPS newlines -- for replayed prose, not log lines."""
    s = text if isinstance(text, str) else str(text)
    return s if len(s) <= limit else s[: limit - 1] + "\u2026"


# ---------------------------------------------------------------------------
# Transcript shape
#
# Both the `clear` and `history` ops read the same transcript and need the
# same notion of a TURN, so the grouping lives here once.  The transcript is a
# flat message list; a turn is:
#
#   [ephemeral system-reminder user message]*  <- injected by the harness
#   user message                               <- the human's actual prompt
#   (assistant | tool | ephemeral user)*       <- the reply and its tool work
#
# Grouping is load-bearing for BOTH callers.  history renders a turn as a
# unit; clear must never drop half of one, because an assistant message
# holding a tool_call whose tool result was pruned away is exactly the broken
# transcript _repair_transcript() exists to clean up after.
# ---------------------------------------------------------------------------
def _is_ephemeral(msg: Any) -> bool:
    if not isinstance(msg, dict):
        return False
    md = msg.get("metadata")
    return bool(isinstance(md, dict) and md.get("ephemeral"))


def _opens_turn(msg: Any) -> bool:
    """True for the human's own prompt, false for everything else."""
    if not isinstance(msg, dict) or msg.get("role") != "user":
        return False
    if _is_ephemeral(msg):
        return False
    content = msg.get("content")
    if isinstance(content, list):
        # A user message carrying tool_result blocks is a CONTINUATION of the
        # turn the tool ran in, not a new prompt.
        return not any(
            isinstance(b, dict) and b.get("type") in ("tool_result", "tool_use_result")
            for b in content
        )
    return True


def _group_turns(messages: list) -> list[list[int]]:
    """Index groups, one per turn, covering every message exactly once."""
    if not messages:
        return []
    prompts = [i for i, m in enumerate(messages) if _opens_turn(m)]
    if not prompts:
        # No human prompt anywhere: one opaque group.  Nothing is ever half
        # dropped this way.
        return [list(range(len(messages)))]
    starts: list[int] = []
    for p in prompts:
        s = p
        # Absorb the reminder block injected immediately ahead of the prompt:
        # a kept prompt with its preamble pruned is a ghost, and a dropped
        # prompt whose preamble survived is a bigger one.
        while s > 0 and _is_ephemeral(messages[s - 1]):
            s -= 1
        starts.append(s)
    starts[0] = 0  # anything before the first prompt belongs with it
    groups = []
    for n, s in enumerate(starts):
        end = starts[n + 1] if n + 1 < len(starts) else len(messages)
        groups.append(list(range(s, end)))
    return groups


def _msg_epoch(msg: Any) -> "float | None":
    """Message timestamp in epoch seconds, or None when it cannot be read."""
    if not isinstance(msg, dict):
        return None
    md = msg.get("metadata")
    raw = md.get("timestamp") if isinstance(md, dict) else None
    if not isinstance(raw, str) or not raw:
        return None
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def _msg_iso(msg: Any) -> str:
    if not isinstance(msg, dict):
        return ""
    md = msg.get("metadata")
    raw = md.get("timestamp") if isinstance(md, dict) else None
    return raw if isinstance(raw, str) else ""


def _turn_prompt(members: list) -> str:
    """The human's own words in this turn, or "" if it has none."""
    for m in members:
        if _opens_turn(m):
            content = m.get("content")
            if isinstance(content, str):
                return content
            if isinstance(content, list):
                return "\n".join(
                    b.get("text", "") for b in content
                    if isinstance(b, dict) and b.get("type") == "text"
                )
    return ""


def _tool_result_summary(content: Any) -> tuple:
    """(ok, one-line summary) for a tool result message.

    Mirrors on_tool_post exactly, so a replayed tool line and a live one read
    the same.  The RAW result never leaves this function.
    """
    result: Any = content
    if isinstance(content, str):
        try:
            result = json.loads(content)
        except (ValueError, TypeError):
            return True, _clip(content)
    if isinstance(result, dict):
        err = result.get("error")
        if err:
            return False, _clip(err)
        out = result.get("output")
        return True, _clip(out.get("content", out) if isinstance(out, dict) else out)
    return True, _clip(result)


def _summarize_turn(index: int, members: list) -> "dict | None":
    """One replay turn: prompt, blocks, timestamp.  Nothing raw."""
    prompt = _turn_prompt(members)
    blocks: list = []
    by_call: dict = {}
    ts = ""
    # Elapsed time is DERIVED from the transcript's own timestamps, so a
    # replayed turn carries the same "2.7s" a live one did.  Cost is not
    # derived and is not sent: the transcript does not record it per turn, and
    # a plausible-looking invented number is worse than an absent one.
    stamps = [t for t in (_msg_epoch(m) for m in members) if t is not None]
    elapsed_ms = int((max(stamps) - min(stamps)) * 1000) if len(stamps) > 1 else 0

    def add_tool(call_id: str, name: str, args: Any) -> None:
        if len(blocks) >= HISTORY_MAX_BLOCKS:
            return
        block = {
            "kind": "tool",
            "call_id": str(call_id or ""),
            "name": str(name or ""),
            "args": _clip(json.dumps(args, ensure_ascii=False, default=str), HISTORY_ARGS_LIMIT)
            if isinstance(args, (dict, list)) else _clip(args or "", HISTORY_ARGS_LIMIT),
            "ok": True,
            "summary": "",
            "ms": 0,
        }
        if block["args"] in ("{}", "[]", "null"):
            block["args"] = ""
        blocks.append(block)
        if block["call_id"]:
            by_call[block["call_id"]] = block

    def add_text(kind: str, text: str) -> None:
        text = _trim(text, HISTORY_TEXT_LIMIT)
        if not text:
            return
        tail = blocks[-1] if blocks else None
        if tail is not None and tail.get("kind") == kind:
            tail["text"] = _trim(tail["text"] + text, HISTORY_TEXT_LIMIT)
            return
        if len(blocks) >= HISTORY_MAX_BLOCKS:
            return
        blocks.append({"kind": kind, "text": text})

    for m in members:
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        if not ts:
            ts = _msg_iso(m)
        if role == "assistant":
            content = m.get("content")
            if isinstance(content, str):
                add_text("text", content)
            elif isinstance(content, list):
                saw_call = False
                for b in content:
                    if not isinstance(b, dict):
                        continue
                    btype = b.get("type")
                    if btype == "text":
                        add_text("text", b.get("text") or "")
                    elif btype == "thinking":
                        add_text("thinking", b.get("thinking") or b.get("text") or "")
                    elif btype in ("tool_call", "tool_use"):
                        saw_call = True
                        add_tool(b.get("id") or b.get("tool_call_id") or "",
                                 b.get("name") or b.get("tool") or "",
                                 b.get("input") if b.get("input") is not None else b.get("arguments"))
                if not saw_call:
                    # Providers that carry calls only in the sibling key.
                    for call in m.get("tool_calls") or []:
                        if isinstance(call, dict):
                            add_tool(call.get("id") or "",
                                     call.get("tool") or call.get("name") or "",
                                     call.get("arguments") if call.get("arguments") is not None
                                     else call.get("input"))
        elif role == "tool":
            call_id = str(m.get("tool_call_id") or "")
            ok, summary = _tool_result_summary(m.get("content"))
            block = by_call.get(call_id)
            if block is None:
                add_tool(call_id, m.get("name") or "", None)
                block = by_call.get(call_id) or (blocks[-1] if blocks else None)
            if block is not None:
                block["ok"] = ok
                block["summary"] = summary
                if not block["name"]:
                    block["name"] = str(m.get("name") or "")

    if not prompt and not blocks:
        return None
    return {
        "id": f"h-{index}",
        "prompt": _trim(prompt, HISTORY_PROMPT_LIMIT),
        "ts": ts,
        "ms": elapsed_ms,
        "blocks": blocks,
    }


# ---------------------------------------------------------------------------
# Live lanes
#
# The hard rule on clear (spec gap 1): never drop a message that references a
# lane that is still alive.  muxterm writes one JSON file per live agent
# session under $XDG_RUNTIME_DIR/muxterm/session-state/, named for the session
# id it describes, so that directory IS the fleet roster.
#
# Every decision here errs toward KEEPING.  A file that cannot be parsed still
# contributes its filename; liveness is NOT re-checked against /proc, because
# a lane whose state file is still on disk is a lane muxterm still believes
# in.  Over-keeping is a harmless surprise; dropping a live lane's context is
# not.
# ---------------------------------------------------------------------------
def _live_lane_ids(exclude: str = "") -> set:
    base = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    d = Path(base).joinpath(*SESSION_STATE_REL)
    ids = set()
    try:
        entries = sorted(d.glob("*.json"))
    except OSError:
        logger.warning("could not read session-state dir %s", d, exc_info=True)
        return ids
    for p in entries:
        ids.add(p.stem)  # the filename is the session id by construction
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            logger.debug("session-state %s unreadable; using its filename", p, exc_info=True)
            continue
        if isinstance(data, dict):
            sid = data.get("sessionId")
            if isinstance(sid, str) and sid:
                ids.add(sid)
    # The chief of staff is ITSELF a lane in that roster -- hooks-muxterm-session
    # registers the sidecar's own amplifier session like any other.  Protecting
    # it here would mean every message that names the session this transcript
    # BELONGS TO survives forever, which is a clear that never clears.
    ids.discard(exclude)
    return ids


def _is_uuidish(sid: str) -> bool:
    """True for the uuid-shaped ids muxterm gives agent lanes."""
    stripped = sid.replace("-", "")
    return len(stripped) >= 32 and all(c in "0123456789abcdefABCDEF" for c in stripped)


def _lane_needles(ids: set) -> list:
    """The substrings whose presence in a message protects it from a prune.

    The short-form prefix is added ONLY for uuid-shaped ids.  A named session
    id is a word, and eight characters of a word is a word: `muxterm-cos`
    would contribute the needle `muxterm-`, which matches every message that
    mentions muxterm at all -- a "protection" that quietly cancels the whole
    feature.  Eight hex characters of a uuid is a real identifier and matching
    it is the intended over-keep.
    """
    needles = set()
    for sid in ids:
        if not sid:
            continue
        needles.add(sid)
        if len(sid) > LANE_ID_PREFIX and _is_uuidish(sid):
            needles.add(sid[:LANE_ID_PREFIX])
    return sorted(needles)


def _mentions_lane(msg: Any, needles: list) -> str:
    """The first live lane id this message mentions, or "" for none.

    The WHOLE message is searched as serialized JSON -- prompt text, assistant
    text, tool arguments and tool results alike -- because a lane id is just
    as load-bearing inside a tool call as it is in prose.
    """
    if not needles:
        return ""
    try:
        blob = json.dumps(msg, ensure_ascii=False, default=str)
    except Exception:
        blob = str(msg)
    for needle in needles:
        if needle in blob:
            return needle
    return ""


# ---------------------------------------------------------------------------
# Sidecar
# ---------------------------------------------------------------------------
class Sidecar:
    def __init__(self, args: argparse.Namespace, proto: Proto) -> None:
        self.args = args
        self.proto = proto
        self.session_id: str = args.session_id
        self.bundle: str = args.bundle
        self.broker = ApprovalBroker(proto, args.approval_timeout)
        self.display = HostDisplay()
        self.session: Any = None
        self.store: Any = None
        self.resumed = False
        self.tool_count = 0
        self.muxterm_tool_count = 0
        self._turn: "Turn | None" = None
        self._forced_approval: set = set()
        self._stopping = False
        self._prev_cost: "Decimal | None" = None
        # Set by serve(); read by _on_signal to wake the loop.  Both stay None
        # until then, so a signal before serve() has nothing to poke and
        # nothing to crash on.
        self._loop: "asyncio.AbstractEventLoop | None" = None
        self._queue: "asyncio.Queue | None" = None

    # -- boot ---------------------------------------------------------------
    async def build(self) -> Any:
        """The verified recipe -- spec section 0.  The order here is load-bearing."""
        from amplifier_app_cli.commands.init import auto_init_from_env, check_first_run
        from amplifier_app_cli.lib.settings import AppSettings
        from amplifier_app_cli.paths import get_bundle_search_paths
        from amplifier_app_cli.project_utils import get_project_slug
        from amplifier_app_cli.runtime.config import expand_env_vars, resolve_bundle_config
        from amplifier_app_cli.session_runner import (
            SessionConfig,
            _create_bundle_session,
            register_mention_handling,
            register_session_spawning,
        )
        from amplifier_app_cli.session_store import SessionStore
        from rich.console import Console

        devnull = open(os.devnull, "w")
        console = Console(quiet=True, file=devnull)

        # Provider auto-install after an amplifier update; without this a
        # resumed session can come up with zero providers.  Never interactive.
        try:
            if check_first_run():
                auto_init_from_env(console)
        except Exception:
            logger.debug("first-run check skipped", exc_info=True)

        settings = AppSettings()
        cfg, prepared = await resolve_bundle_config(self.bundle, settings, None)
        # MANDATORY: without this hook-context-intelligence dies validating
        # "Unknown level: '${AMPLIFIER_CONTEXT_INTELLIGENCE_LOG_LEVEL:INFO}'".
        cfg = expand_env_vars(cfg)

        # -- resume ---------------------------------------------------------
        # The session lives in the ordinary amplifier session store for this
        # project slug, so `amplifier resume <id>` in a terminal still works.
        self.store = SessionStore()
        transcript = None
        if self.store.exists(self.session_id):
            try:
                loaded, _meta = self.store.load(self.session_id)
                if loaded:
                    transcript = loaded
            except Exception:
                logger.warning("could not load transcript for %s", self.session_id, exc_info=True)
        self.resumed = transcript is not None

        cwd = str(Path.cwd().resolve())
        root_meta = {
            "working_dir": cwd,
            "root_session_id": self.session_id,
            "application_host": "muxterm-cos",
            "bundle_name": self.bundle,
            "project_slug": get_project_slug(),
            "project_dir": cwd,
            "project_name": Path(cwd).name,
        }
        # Mirrors create_initialized_session: stamp before creation so hooks
        # mounted during create_session see the values.
        cfg["working_dir"] = cwd
        for key, value in root_meta.items():
            cfg.setdefault(key, value)

        sc = SessionConfig(
            config=cfg,
            search_paths=get_bundle_search_paths(),
            verbose=False,
            session_id=self.session_id,
            bundle_name=self.bundle,
            prepared_bundle=prepared,
            initial_transcript=transcript,
        )
        session = await _create_bundle_session(
            sc, self.session_id, HostApprovalSystem(self.broker), self.display, console
        )
        # _create_bundle_session already performs both registrations; repeated
        # here for parity with the spec's recipe (both are delegating wrappers,
        # so a second call changes no behaviour).
        register_mention_handling(session)
        register_session_spawning(session)
        self.session = session

        # session.config is not guaranteed to be the same dict object as cfg.
        session.config["working_dir"] = cwd
        for key, value in root_meta.items():
            session.config.setdefault(key, value)

        if transcript:
            context = session.coordinator.get("context")
            if context is not None and hasattr(context, "set_messages"):
                await context.set_messages(transcript)
                logger.info("restored %d messages from transcript", len(transcript))
            else:
                logger.warning("context module lacks set_messages -- transcript NOT restored")
                self.resumed = False

            from amplifier_app_cli.cost_history import restore_session_cost

            try:
                events_path = self.store.base_dir / self.session_id / "events.jsonl"
                restore_session_cost(session.coordinator, self.session_id, events_path)
            except Exception:
                logger.debug("prior session cost restore skipped", exc_info=True)

        register = session.coordinator.get_capability("approval.register_provider")
        if register:
            register(HostApprovalProvider(self.broker))
            logger.info("registered host approval provider")
        else:
            logger.warning("no approval.register_provider capability -- tool approvals unavailable")

        # Policy seam: force host approval for named tools even when the bundle
        # runs hooks-approval in policy_driven_only mode (the anchors bundle
        # does, so nothing would ever trigger an approval on its own).
        # Comma separated tool names.  Applied per tool:pre -- see
        # _register_hooks() for why a one-shot seed does not survive.
        forced = os.environ.get("MUXTERM_COS_REQUIRE_APPROVAL", "").strip()
        self._forced_approval = set(n.strip() for n in forced.split(",") if n.strip())
        if self._forced_approval:
            logger.info("host approval forced for tools: %s", sorted(self._forced_approval))

        tools = session.coordinator.get("tools") or {}
        self.tool_count = len(tools)
        self.muxterm_tool_count = len([t for t in tools if t.startswith("mcp_muxterm_")])
        logger.info("tools mounted (%d): %s", self.tool_count, sorted(tools))

        self._register_hooks()
        return session

    # -- streaming hooks ----------------------------------------------------
    def _register_hooks(self) -> None:
        from amplifier_core.models import HookResult

        hooks = self.session.coordinator.get("hooks")
        if hooks is None:
            logger.error("no hook registry -- streaming events unavailable")
            return

        cont = HookResult(action="continue")
        root = self.session_id

        def trace(event: str, data: dict) -> None:
            if logger.isEnabledFor(logging.DEBUG):
                logger.debug("hook %s keys=%s", event, sorted(data.keys()))

        def is_root(data: dict) -> bool:
            sid = data.get("session_id")
            return sid is None or sid == root

        async def on_provider_request(event: str, data: dict) -> Any:
            # loop-streaming emits this immediately before each of ITS OWN llm
            # calls.  Background hook calls never do -- which is what makes it
            # a usable foreground marker.
            turn = self._turn
            if turn is None or not is_root(data):
                return cont
            turn.saw_provider_request = True
            turn.fg_open = True
            turn.fg_request_id = None
            return cont

        async def on_llm_response(event: str, data: dict) -> Any:
            turn = self._turn
            if turn is None or not is_root(data):
                return cont
            turn.fg_open = False
            turn.fg_request_id = None
            return cont

        async def on_stream_delta(event: str, data: dict) -> Any:
            trace(event, data)
            turn = self._turn
            if turn is None or not is_root(data):
                return cont
            text = data.get("text")
            if not text:
                return cont
            if not turn.fg_open:
                # Outside any orchestrator llm call: a background hook.
                turn.deltas_dropped += 1
                return cont
            request_id = data.get("request_id")
            if turn.fg_request_id is None:
                turn.fg_request_id = request_id
            elif request_id != turn.fg_request_id:
                # A second call overlapping the foreground one.
                turn.deltas_dropped += 1
                return cont
            turn.saw_stream_delta = True
            turn.deltas_emitted += 1
            kind = "thinking" if data.get("block_type") == "thinking" else "delta"
            self.proto.emit(ev=kind, turn_id=turn.id, text=text)
            return cont

        async def on_content_block_end(event: str, data: dict) -> Any:
            # Fallback thinking source for the non-streaming provider path,
            # where no llm:stream_* events are emitted at all.  Suppressed as
            # soon as this turn has seen a single stream delta, so the two
            # sources can never both report the same block.
            trace(event, data)
            turn = self._turn
            if turn is None or turn.saw_stream_delta or not is_root(data):
                return cont
            block = data.get("block")
            if not isinstance(block, dict) or block.get("type") != "thinking":
                return cont
            text = block.get("thinking") or block.get("text")
            if text:
                self.proto.emit(ev="thinking", turn_id=turn.id, text=text)
            return cont

        async def on_tool_pre(event: str, data: dict) -> Any:
            trace(event, data)
            turn = self._turn
            if turn is None:
                return cont
            call_id = str(data.get("tool_call_id") or "")
            turn.tool_started_at[call_id] = time.monotonic()
            args = data.get("tool_input")
            payload = {
                "ev": "tool_start",
                "turn_id": turn.id,
                "call_id": call_id,
                "name": data.get("tool_name") or "unknown",
                "args": args if isinstance(args, dict) else {},
            }
            if not is_root(data):
                payload["sub"] = data.get("session_id")
            self.proto.emit(**payload)
            return cont

        def emit_tool_end(turn: Turn, data: dict, ok: bool, summary: str) -> None:
            call_id = str(data.get("tool_call_id") or "")
            if call_id and call_id in turn.tool_ended:
                return
            if call_id:
                turn.tool_ended.add(call_id)
            started = turn.tool_started_at.pop(call_id, None)
            ms = int((time.monotonic() - started) * 1000) if started else 0
            payload = {
                "ev": "tool_end",
                "turn_id": turn.id,
                "call_id": call_id,
                "ok": ok,
                "summary": summary,
                "ms": ms,
            }
            if not is_root(data):
                payload["sub"] = data.get("session_id")
            self.proto.emit(**payload)

        async def on_tool_post(event: str, data: dict) -> Any:
            trace(event, data)
            turn = self._turn
            if turn is None:
                return cont
            result = data.get("result")
            ok = True
            summary = ""
            if isinstance(result, dict):
                err = result.get("error")
                ok = not err
                if err:
                    summary = _clip(err)
                else:
                    out = result.get("output")
                    summary = _clip(out.get("content", out) if isinstance(out, dict) else out)
            else:
                summary = _clip(result)
            emit_tool_end(turn, data, ok, summary)
            return cont

        async def on_tool_error(event: str, data: dict) -> Any:
            trace(event, data)
            turn = self._turn
            if turn is None:
                return cont
            emit_tool_end(turn, data, False, _clip(data.get("error") or data.get("message") or "tool error"))
            return cont

        if self._forced_approval:
            forced = set(self._forced_approval)
            state = self.session.coordinator.session_state

            async def on_tool_pre_force_approval(event: str, data: dict) -> Any:
                # bundle-modes' "mode-tools" handler (priority -20) OVERWRITES
                # session_state["require_approval_tools"] on every tool:pre --
                # unconditionally clearing it when no mode is active.  So the
                # host's requirement has to be re-applied between that handler
                # and hooks-approval's own (priority -10).
                existing = state.get("require_approval_tools") or set()
                state["require_approval_tools"] = set(existing) | forced
                return cont

            hooks.register("tool:pre", on_tool_pre_force_approval,
                           priority=-15, name="cos-force-approval")

        hooks.register("provider:request", on_provider_request, name="cos-fg-open")
        hooks.register("llm:response", on_llm_response, name="cos-fg-close")
        hooks.register("llm:stream_block_delta", on_stream_delta, name="cos-delta")
        hooks.register("content_block:end", on_content_block_end, name="cos-thinking-fallback")
        hooks.register("tool:pre", on_tool_pre, name="cos-tool-pre")
        hooks.register("tool:post", on_tool_post, name="cos-tool-post")
        hooks.register("tool:error", on_tool_error, name="cos-tool-error")

    # -- persistence --------------------------------------------------------
    async def _messages(self) -> list:
        context = self.session.coordinator.get("context")
        if context is None or not hasattr(context, "get_messages"):
            return []
        return await context.get_messages()

    def _model_name(self) -> str:
        providers = self.session.coordinator.get("providers") or {}
        for name, provider in providers.items():
            model = getattr(provider, "model", None) or getattr(provider, "default_model", None)
            if model:
                return f"{name}/{model}"
        return "unknown"

    async def _save_session(self) -> None:
        messages = await self._messages()
        if not messages:
            return
        existing = self.store.get_metadata(self.session_id) or {}
        metadata = {
            **existing,
            "session_id": self.session_id,
            "created": existing.get("created", datetime.now(timezone.utc).isoformat()),
            "bundle": self.bundle,
            "model": self._model_name(),
            "turn_count": len([m for m in messages if m.get("role") == "user"]),
            "working_dir": str(Path.cwd().resolve()),
        }
        self.store.save(self.session_id, messages, metadata)

    async def _repair_transcript(self) -> None:
        """Pre-turn repair of orphaned tool calls left behind by a cancelled turn."""
        context = self.session.coordinator.get("context")
        if context is None or not hasattr(context, "get_messages"):
            return
        try:
            messages = await context.get_messages()
            if not messages:
                return
            from amplifier_foundation.session import diagnose_transcript, repair_transcript

            diagnosis = diagnose_transcript(messages)
            if diagnosis["status"] != "broken":
                return
            repaired = repair_transcript(messages, diagnosis)
            if hasattr(context, "set_messages"):
                await context.set_messages(repaired)
            await self._save_session()
            logger.warning("pre-turn transcript repair: %s", diagnosis.get("failure_modes"))
        except Exception:
            logger.debug("pre-turn transcript repair failed", exc_info=True)

    async def _costs(self):
        """Returns (turn_cost, session_cost) as strings, or (None, None)."""
        try:
            contributions = await self.session.coordinator.collect_contributions(SESSION_COST_CHANNEL)
        except Exception:
            logger.debug("cost collection failed", exc_info=True)
            return None, None
        total = None
        for c in contributions:
            if isinstance(c, dict) and c.get("cost_usd") is not None:
                try:
                    total = (total or Decimal("0")) + Decimal(str(c["cost_usd"]))
                except Exception:
                    continue
        if total is None:
            return None, None
        turn = total - self._prev_cost if self._prev_cost is not None else total
        self._prev_cost = total
        return str(turn), str(total)

    # -- turn execution -----------------------------------------------------
    async def _run_turn(self, turn: Turn) -> None:
        # turn_start was emitted synchronously when the turn was accepted, so
        # that a shutdown arriving before this task is first scheduled can
        # never produce a terminal event with no turn_start ahead of it.
        self.broker.current_turn_id = turn.id
        response = ""
        error_msg = None
        cancelled = False
        try:
            await self._repair_transcript()
            self.session.coordinator.cancellation.reset()
            prompt = await self._expand_mentions(turn.prompt)
            response = await self.session.execute(prompt)
            if self.session.coordinator.cancellation.is_cancelled:
                cancelled = True
        except asyncio.CancelledError:
            cancelled = True
            raise
        except BaseException as exc:  # noqa: BLE001 -- a turn must never kill the sidecar
            error_msg = f"{type(exc).__name__}: {exc}"
            logger.exception("turn %s failed", turn.id)
        finally:
            # Every await below is defended: a terminal event must still be
            # emitted while a CancelledError propagates through this frame.
            ms = int((time.monotonic() - turn.started) * 1000)
            turn_cost = session_cost = None
            try:
                turn_cost, session_cost = await self._costs()
            except BaseException:
                logger.debug("cost lookup failed during teardown", exc_info=True)
            try:
                await self._save_session()
            except BaseException:
                logger.warning("session save failed for turn %s", turn.id, exc_info=True)

            if cancelled or turn.cancel_requests:
                self._emit_terminal(turn, ev="cancelled", response=response, ms=ms,
                                    turn_cost=turn_cost, session_cost=session_cost)
            elif error_msg is not None:
                self.proto.emit(ev="error", turn_id=turn.id, code="turn_failed",
                                message=error_msg, fatal=False)
                self._emit_terminal(turn, ev="turn_end", response=response, ms=ms,
                                    turn_cost=turn_cost, session_cost=session_cost,
                                    error=error_msg)
            else:
                self._emit_terminal(turn, ev="turn_end", response=response, ms=ms,
                                    turn_cost=turn_cost, session_cost=session_cost)
            logger.info("turn %s: %d deltas emitted, %d dropped (background llm calls)",
                        turn.id, turn.deltas_emitted, turn.deltas_dropped)
            if not turn.saw_provider_request:
                logger.warning(
                    "turn %s saw no provider:request -- this orchestrator does not mark "
                    "its own llm calls, so token deltas were suppressed entirely",
                    turn.id)
            self.broker.current_turn_id = None
            if self._turn is turn:
                self._turn = None

    def _emit_terminal(self, turn: Turn, *, ev: str, response: str, ms: int,
                       turn_cost, session_cost, error=None) -> None:
        if turn.terminal_sent:
            logger.error("second terminal event suppressed for turn %s", turn.id)
            return
        turn.terminal_sent = True
        payload = {"ev": ev, "turn_id": turn.id, "response": response or "", "ms": ms}
        if turn_cost is not None:
            payload["cost_usd"] = turn_cost
        if session_cost is not None:
            payload["session_cost_usd"] = session_cost
        if error is not None:
            payload["error"] = error
        self.proto.emit(**payload)

    async def _expand_mentions(self, prompt: str) -> str:
        try:
            from amplifier_app_cli.main import process_runtime_mentions

            return await process_runtime_mentions(self.session, prompt)
        except Exception:
            logger.debug("mention expansion skipped", exc_info=True)
            return prompt

    # -- transcript housekeeping --------------------------------------------
    def _session_dir(self) -> Path:
        return Path(self.store.base_dir) / self.session_id

    def _can_set_context_messages(self) -> bool:
        """Whether the live context can be REPLACED, not just read.

        A clear that cannot do this is a lie (see _handle_clear), so this is
        asked before anything is written rather than discovered afterwards.
        """
        context = self.session.coordinator.get("context")
        return context is not None and hasattr(context, "set_messages")

    async def _set_context_messages(self, messages: list) -> bool:
        """Replace the live session's context, the same way boot restores it.

        build() does `await context.set_messages(transcript)` after loading
        from the store; a prune has to do exactly that again, or the process
        keeps answering from the messages the user just deleted until it is
        restarted.
        """
        context = self.session.coordinator.get("context")
        if context is None or not hasattr(context, "set_messages"):
            return False
        await context.set_messages(messages)
        return True

    async def _transcript(self) -> list:
        """The live transcript, preferring memory and falling back to disk."""
        try:
            messages = await self._messages()
        except Exception:
            logger.debug("in-memory transcript unavailable", exc_info=True)
            messages = []
        if messages:
            return list(messages)
        try:
            from amplifier_foundation.session.store import load_transcript

            return load_transcript(self._session_dir())
        except Exception:
            logger.debug("on-disk transcript unavailable", exc_info=True)
            return []

    async def _handle_clear(self, msg: dict) -> None:
        """Prune the persisted transcript.  older_than_days 0/absent = all.

        Two rules are non-negotiable, and both are refusals rather than
        best-effort behaviour:

          1. NEVER while a turn is in flight.  The turn is actively appending
             to this transcript and will save it again at turn end, which
             would resurrect everything this prune removed -- and rewriting
             the file underneath a running turn is a straight data race.
          2. NEVER drop a message that references a live lane.  See
             _live_lane_ids(): the roster is read fresh on every clear, and
             every ambiguity resolves toward keeping.
        """
        req_id = msg.get("req_id") if isinstance(msg.get("req_id"), str) else None

        def fail(message: str, code: str = "clear_failed", **extra) -> None:
            payload = {"ev": "error", "code": code, "message": message, "fatal": False}
            payload.update(extra)
            if req_id:
                payload["req_id"] = req_id
            self.proto.emit(**payload)

        if self._turn is not None:
            fail(f"turn {self._turn.id} is still running; clearing now would race it")
            return

        # RULE 3, and it is a refusal for the same reason as the other two: a
        # prune that cannot also replace the LIVE context is not a clear, it is
        # a delayed undo.  The next turn ends with _save_session(), which writes
        # the whole in-memory transcript back over the pruned file, and
        # everything the user just deleted returns -- after they were told it
        # was gone.  Checked BEFORE the backup and the write, so a session that
        # cannot honour a clear is left exactly as it was.
        if not self._can_set_context_messages():
            fail("this session cannot forget anything: its context module has no "
                 "set_messages, so a prune would be undone by the next turn's save. "
                 "Nothing was changed.",
                 code="clear_unsupported")
            return

        raw_days = msg.get("older_than_days", 0)
        try:
            days = int(raw_days or 0)
        except (TypeError, ValueError):
            fail(f"older_than_days must be a number, got {raw_days!r}")
            return
        if days < 0:
            fail("older_than_days cannot be negative")
            return

        try:
            from amplifier_foundation.session.store import (
                TRANSCRIPT_FILENAME,
                backup,
                load_transcript,
                write_transcript,
            )
        except Exception as exc:  # noqa: BLE001
            fail(f"session store unavailable: {type(exc).__name__}: {exc}")
            return

        session_dir = self._session_dir()
        transcript_path = session_dir / TRANSCRIPT_FILENAME
        backup_path = None
        try:
            # EXISTENCE FIRST, then backup.  A session that has never been
            # saved has no transcript file, and asking to back one up is not a
            # read failure -- it is "there was nothing to clear", which is
            # removed:0.  (backup() happens to return None for a missing file
            # rather than raising, so this ordering is belt and braces; the
            # point is that the answer no longer depends on that.)  Everything
            # after the backup is recoverable by hand.
            if transcript_path.exists():
                backup_path = backup(transcript_path, "cos-clear")
                messages = load_transcript(session_dir)
            else:
                messages = []
        except Exception as exc:  # noqa: BLE001
            logger.exception("clear: could not read the transcript")
            fail(f"could not read the transcript: {type(exc).__name__}: {exc}")
            return

        if not messages:
            # Nothing on disk.  Still clear memory, so a session that has
            # taken turns but not yet been saved does not keep answering from
            # a transcript the user just asked to forget -- and say so if that
            # fails, for the reason spelled out at the end of this function.
            try:
                reset = await self._set_context_messages([])
            except Exception as exc:  # noqa: BLE001
                logger.exception("clear: context reset on an empty transcript failed")
                fail(f"nothing was on disk to prune, but this session's live memory could "
                     f"not be reset ({type(exc).__name__}: {exc}), so unsaved turns would "
                     f"come back on the next save. Restart the chief of staff to clear them",
                     code="clear_partial", removed=0, kept=0, reloaded=False)
                return
            if not reset:
                fail("nothing was on disk to prune, and this session's live memory could not "
                     "be reset, so unsaved turns would come back on the next save. Restart "
                     "the chief of staff to clear them",
                     code="clear_partial", removed=0, kept=0, reloaded=False)
                return
            payload = {"ev": "cleared", "removed": 0, "kept": 0,
                       "removed_turns": 0, "kept_turns": 0, "protected": [],
                       "reloaded": True}
            if req_id:
                payload["req_id"] = req_id
            self.proto.emit(**payload)
            return

        cutoff = None if days <= 0 else time.time() - days * 86400
        needles = _lane_needles(_live_lane_ids(exclude=self.session_id))
        logger.info("clear: older_than_days=%d, %d live-lane needle(s): %s",
                    days, len(needles), needles)
        groups = _group_turns(messages)

        keep_idx: set = set()
        kept_turns = 0
        protected: list = []
        for group in groups:
            members = [messages[i] for i in group]
            stamps = [t for t in (_msg_epoch(m) for m in members) if t is not None]
            newest = max(stamps) if stamps else None

            reason = ""
            hit = ""
            for m in members:
                hit = _mentions_lane(m, needles)
                if hit:
                    reason = "live-lane"
                    break
            if not reason:
                if cutoff is None:
                    # "clear everything" means everything that is not pinned.
                    pass
                elif newest is None:
                    # Unknown age.  KEEP -- see the module note: over-keeping
                    # is a harmless surprise, dropping is not.
                    reason = "undated"
                elif newest >= cutoff:
                    reason = "recent"

            if reason:
                kept_turns += 1
                keep_idx.update(group)
                if reason == "live-lane":
                    protected.append({"lane": hit, "prompt": _clip(_turn_prompt(members), 120)})

        kept = [m for i, m in enumerate(messages) if i in keep_idx]
        removed_count = len(messages) - len(kept)
        removed_turns = len(groups) - kept_turns

        # Grouping should keep tool_call/tool_result pairs together, but the
        # cost of being wrong is a transcript the NEXT turn cannot send, so
        # check anyway and repair before anything is written.
        try:
            from amplifier_foundation.session import diagnose_transcript, repair_transcript

            diagnosis = diagnose_transcript(kept)
            if diagnosis.get("status") == "broken":
                logger.warning("clear: repairing pruned transcript: %s", diagnosis.get("failure_modes"))
                kept = repair_transcript(kept, diagnosis)
        except Exception:
            logger.debug("clear: post-prune diagnosis skipped", exc_info=True)

        try:
            write_transcript(session_dir, kept)
        except Exception as exc:  # noqa: BLE001
            logger.exception("clear: could not write the pruned transcript")
            fail(f"could not write the pruned transcript: {type(exc).__name__}: {exc}")
            return

        # SessionStore._load_transcript falls back to transcript.jsonl.backup
        # when the main file will not parse.  Leaving the pre-prune copy there
        # means a corrupted write could resurrect exactly what the user asked
        # to forget, so the recovery copy is pruned too.  The timestamped
        # bak-cos-clear-* file above is the audit trail.
        #
        # Its OWN try: the prune has already landed by this point, and
        # reporting a failed clear because a secondary copy could not be
        # rewritten would be a lie about what happened to the transcript.
        try:
            recovery = session_dir / (TRANSCRIPT_FILENAME + ".backup")
            if recovery.exists():
                recovery.write_text(
                    "".join(json.dumps(m, ensure_ascii=False) + "\n" for m in kept),
                    encoding="utf-8",
                )
        except Exception:
            logger.warning("clear: pruned the transcript but not its recovery copy "
                           "(%s); a corrupt-file recovery could resurrect cleared messages",
                           session_dir / (TRANSCRIPT_FILENAME + ".backup"), exc_info=True)

        reloaded = False
        reload_error = ""
        try:
            reloaded = await self._set_context_messages(kept)
        except Exception as exc:  # noqa: BLE001
            reload_error = f"{type(exc).__name__}: {exc}"
            logger.exception("clear: could not reload the live context")

        logger.info("clear: removed %d/%d messages (%d/%d turns), backup=%s, protected=%d, reloaded=%s",
                    removed_count, len(messages), removed_turns, len(groups), backup_path,
                    len(protected), reloaded)

        if not reloaded:
            # DISK PRUNED, MEMORY NOT.  Reporting "cleared" here would be the
            # worst available answer: the user is told N messages are gone,
            # then the next turn's _save_session() writes the untouched
            # in-memory transcript back and every one of them returns.  The
            # up-front _can_set_context_messages() check makes this rare -- it
            # means set_messages existed and then RAISED -- but rare is not
            # never, and the truth is what has to travel.  The state is on
            # disk, in the backup named below; a restart re-reads the pruned
            # file and makes memory agree.
            logger.error("clear: disk pruned, memory NOT -- reporting clear_partial")
            fail(
                f"the transcript on disk was pruned ({removed_count} of {len(messages)} "
                f"messages removed, {len(kept)} kept) but this session's live memory was "
                f"NOT: the next turn would bring them back. Restart the chief of staff to "
                f"make it forget them for real"
                + (f" ({reload_error})" if reload_error else "")
                + f". Backup: {backup_path}",
                code="clear_partial",
                removed=removed_count,
                kept=len(kept),
                removed_turns=removed_turns,
                kept_turns=kept_turns,
                protected=protected,
                reloaded=False,
            )
            return

        payload = {
            "ev": "cleared",
            "removed": removed_count,
            "kept": len(kept),
            "removed_turns": removed_turns,
            "kept_turns": kept_turns,
            "protected": protected,
            "reloaded": reloaded,
        }
        if req_id:
            payload["req_id"] = req_id
        self.proto.emit(**payload)

    async def _handle_history(self, msg: dict) -> None:
        """Answer with the newest N turns, summarized.

        Summarized is the whole point: role, text, thinking, and a one-line
        tool summary.  Never a raw tool result, never an llm payload -- the
        events log for this session is megabytes with 90KB single lines, and a
        replay that carried that would be worse than no replay at all.
        """
        req_id = msg.get("req_id") if isinstance(msg.get("req_id"), str) else None
        try:
            limit = int(msg.get("limit") or HISTORY_DEFAULT_LIMIT)
        except (TypeError, ValueError):
            limit = HISTORY_DEFAULT_LIMIT
        limit = max(1, min(limit, HISTORY_MAX_LIMIT))

        turns: list = []
        try:
            messages = await self._transcript()
            groups = _group_turns(messages)
            for n, group in enumerate(groups[-limit:], start=max(0, len(groups) - limit)):
                turn = _summarize_turn(n, [messages[i] for i in group])
                if turn is not None:
                    turns.append(turn)
        except Exception as exc:  # noqa: BLE001
            logger.exception("history: could not build the replay")
            payload = {"ev": "error", "code": "history_failed",
                       "message": f"{type(exc).__name__}: {exc}", "fatal": False}
            if req_id:
                payload["req_id"] = req_id
            self.proto.emit(**payload)
            return

        payload = {"ev": "history", "turns": turns, "session_id": self.session_id}
        if req_id:
            payload["req_id"] = req_id
        self.proto.emit(**payload)

    # -- op dispatch --------------------------------------------------------
    def _handle_turn(self, msg: dict) -> None:
        turn_id = msg.get("turn_id")
        prompt = msg.get("prompt")
        if not isinstance(turn_id, str) or not turn_id:
            self.proto.emit(ev="error", code="bad_request",
                            message="turn requires a string turn_id", fatal=False)
            return
        if not isinstance(prompt, str) or not prompt.strip():
            self.proto.emit(ev="error", turn_id=turn_id, code="bad_request",
                            message="turn requires a non-empty prompt", fatal=False)
            return
        if self._turn is not None:
            # LAW 1: one turn at a time.  Never queue internally -- Go queues.
            self.proto.emit(ev="error", turn_id=turn_id, code="busy",
                            message=f"turn {self._turn.id} is still running", fatal=False)
            return
        turn = Turn(id=turn_id, prompt=prompt, started=time.monotonic())
        self._turn = turn
        self.proto.emit(ev="turn_start", turn_id=turn.id)
        turn.task = asyncio.create_task(self._run_turn(turn), name=f"cos-turn-{turn_id}")
        turn.task.add_done_callback(self._turn_done)

    def _turn_done(self, task: asyncio.Task) -> None:
        if task.cancelled():
            return
        exc = task.exception()
        if exc is not None:
            logger.error("turn task ended with %r", exc)

    def _handle_cancel(self, msg: dict) -> None:
        turn_id = msg.get("turn_id")
        turn = self._turn
        if turn is None or (turn_id and turn_id != turn.id):
            self.proto.emit(ev="error", turn_id=turn_id, code="not_active",
                            message="no such active turn", fatal=False)
            return
        turn.cancel_requests += 1
        cancellation = self.session.coordinator.cancellation
        if turn.cancel_requests == 1:
            cancellation.request_graceful()
            logger.info("graceful cancel requested for %s", turn.id)
        else:
            cancellation.request_immediate()
            logger.info("immediate cancel requested for %s", turn.id)
            if turn.task is not None:
                turn.task.cancel()

    def _handle_approval(self, msg: dict) -> None:
        request_id = msg.get("request_id")
        if not isinstance(request_id, str):
            self.proto.emit(ev="error", code="bad_request",
                            message="approval requires a string request_id", fatal=False)
            return
        approved = bool(msg.get("approved"))
        reason = msg.get("reason") or ("approved by host" if approved else "denied by host")
        choice = msg.get("choice") if isinstance(msg.get("choice"), str) else None
        if not self.broker.resolve(request_id, approved, str(reason), choice):
            self.proto.emit(ev="error", code="unknown_approval",
                            message=f"no pending approval {request_id}", fatal=False)

    async def dispatch(self, line: str) -> None:
        line = line.strip()
        if not line:
            return
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as exc:
            self.proto.emit(ev="error", code="bad_json", message=str(exc), fatal=False)
            return
        if not isinstance(msg, dict):
            self.proto.emit(ev="error", code="bad_json", message="expected a JSON object", fatal=False)
            return
        op = msg.get("op")
        if op == "turn":
            self._handle_turn(msg)
        elif op == "cancel":
            self._handle_cancel(msg)
        elif op == "approval":
            self._handle_approval(msg)
        elif op == "clear":
            await self._handle_clear(msg)
        elif op == "history":
            await self._handle_history(msg)
        elif op == "ping":
            self.proto.emit(ev="pong")
        elif op == "shutdown":
            self._stopping = True
        else:
            # Never fatal (law 5), but never silent either -- silence is the
            # failure mode this protocol exists to eliminate.
            self.proto.emit(ev="error", code="unknown_op", message=f"unknown op {op!r}", fatal=False)

    # -- serve loop ---------------------------------------------------------
    async def serve(self) -> None:
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()
        # Held on self so _on_signal can WAKE this loop.  Without that, an
        # idle sidecar parked on queue.get() sets _stopping and then keeps
        # waiting for a line that is not coming, and systemd pays the full
        # TimeoutStopSec before SIGKILL ends it.
        self._loop = loop
        self._queue = queue

        def pump() -> None:
            while True:
                try:
                    line = sys.stdin.readline()
                except Exception:
                    line = ""
                loop.call_soon_threadsafe(queue.put_nowait, line or None)
                if not line:
                    return

        threading.Thread(target=pump, name="cos-stdin", daemon=True).start()

        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                loop.add_signal_handler(sig, lambda s=sig: self._on_signal(s))
            except (NotImplementedError, RuntimeError):
                pass

        while not self._stopping:
            item = await queue.get()
            if item is _WAKE:
                # A signal arrived while this loop was parked.  Nothing to
                # dispatch; the while condition re-reads _stopping and ends
                # the loop.  Distinct from None so a wake is never logged as
                # "stdin closed".
                continue
            if item is None:
                logger.info("stdin closed")
                break
            await self.dispatch(item)

        await self._drain_active_turn()

    def _on_signal(self, sig: int) -> None:
        logger.info("received signal %s -- shutting down", sig)
        self._stopping = True
        turn = self._turn
        if turn is not None and turn.task is not None:
            self.session.coordinator.cancellation.request_immediate()
            turn.task.cancel()
        # WAKE THE SERVE LOOP.  _stopping is only re-read at the top of the
        # loop, and an idle sidecar is blocked inside queue.get() -- which no
        # signal interrupts.  Setting the flag without this leaves the process
        # sitting there until stdin closes or the service manager escalates to
        # SIGKILL (TimeoutStopSec, 90s by default).  call_soon_threadsafe is
        # correct from the loop thread too, and is what makes this safe if the
        # handler is ever reached from a non-asyncio signal path.
        if self._loop is not None and self._queue is not None:
            try:
                self._loop.call_soon_threadsafe(self._queue.put_nowait, _WAKE)
            except RuntimeError:
                # The loop is already closing; it is not going to sit idle.
                pass

    async def _drain_active_turn(self) -> None:
        turn = self._turn
        if turn is None or turn.task is None:
            return
        logger.info("shutdown with turn %s active -- cancelling", turn.id)
        turn.cancel_requests += 1
        try:
            self.session.coordinator.cancellation.request_immediate()
        except Exception:
            pass
        turn.task.cancel()
        try:
            await asyncio.wait_for(asyncio.shield(turn.task), timeout=15)
        except (asyncio.CancelledError, asyncio.TimeoutError, TimeoutError):
            pass
        except Exception:
            logger.debug("turn teardown raised", exc_info=True)
        if not turn.terminal_sent:
            # Guarantee: no turn_start is ever left without a terminal event.
            turn.terminal_sent = True
            self.proto.emit(ev="cancelled", turn_id=turn.id, response="",
                            ms=int((time.monotonic() - turn.started) * 1000))


# ---------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------
def parse_args(argv: list) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="cos", description="muxterm Chief-of-Staff sidecar")
    p.add_argument("--session-id", required=True, help="amplifier session id (also the resume key)")
    p.add_argument("--bundle", default="anchors", help="bundle to load (default: anchors)")
    p.add_argument("--cwd", default=None, help="working directory; sets project slug and session store")
    p.add_argument("--log-level", default="info",
                   choices=["debug", "info", "warning", "error", "critical"])
    p.add_argument("--approval-timeout", type=float, default=DEFAULT_APPROVAL_TIMEOUT,
                   help="seconds before an unanswered approval is DENIED (default: 300)")
    return p.parse_args(argv)


async def run(args: argparse.Namespace, proto: Proto) -> int:
    sidecar = Sidecar(args, proto)
    try:
        session = await sidecar.build()
    except SystemExit as exc:
        # _create_bundle_session calls sys.exit(1) on module validation errors.
        proto.emit(ev="error", code="init_failed",
                   message=f"session creation aborted ({exc.code})", fatal=True)
        return 1
    except BaseException as exc:  # noqa: BLE001
        logger.exception("boot failed")
        proto.emit(ev="error", code="init_failed", message=f"{type(exc).__name__}: {exc}", fatal=True)
        return 1

    try:
        async with session:
            proto.emit(
                ev="ready",
                session_id=sidecar.session_id,
                bundle=sidecar.bundle,
                tools=sidecar.tool_count,
                muxterm_tools=sidecar.muxterm_tool_count,
                boot_ms=int((time.monotonic() - _BOOT_T0) * 1000),
                resumed=sidecar.resumed,
            )
            await sidecar.serve()
    except BaseException as exc:  # noqa: BLE001
        logger.exception("serve loop failed")
        proto.emit(ev="error", code="fatal", message=f"{type(exc).__name__}: {exc}", fatal=True)
        return 1
    return 0


def _fatal(message: str) -> None:
    """Last-resort protocol error, usable before Proto exists."""
    try:
        _PROTO_STREAM.write(json.dumps({
            "ev": "error", "code": "init_failed", "message": message, "fatal": True}) + "\n")
        _PROTO_STREAM.flush()
    except Exception:
        pass


def main(argv=None) -> int:
    try:
        args = parse_args(sys.argv[1:] if argv is None else argv)
    except SystemExit as exc:
        # A bad argument is a fatal init failure (spec 3.1) -- argparse would
        # otherwise exit silently as far as the protocol stream is concerned.
        if exc.code not in (0, None):
            _fatal("invalid arguments; see stderr")
        raise

    logging.basicConfig(
        stream=sys.stderr,
        level=getattr(logging, args.log_level.upper()),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    # Must happen before the session is built: get_project_slug(), SessionStore
    # and session_cwd all read Path.cwd() at call time.
    if args.cwd:
        try:
            os.chdir(args.cwd)
        except OSError as exc:
            _fatal(f"cannot chdir to {args.cwd}: {exc}")
            return 1

    proto = Proto(_PROTO_STREAM)
    try:
        return asyncio.run(run(args, proto))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
