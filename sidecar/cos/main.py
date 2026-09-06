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
            line = await queue.get()
            if line is None:
                logger.info("stdin closed")
                break
            await self.dispatch(line)

        await self._drain_active_turn()

    def _on_signal(self, sig: int) -> None:
        logger.info("received signal %s -- shutting down", sig)
        self._stopping = True
        turn = self._turn
        if turn is not None and turn.task is not None:
            self.session.coordinator.cancellation.request_immediate()
            turn.task.cancel()

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
