"""Publish declared Amplifier session state for muxterm.

Core 1.6.1 calls :func:`on_session_ready` after successful mounts and before a
prompt. `session:start`/`session:resume` happen only on the first execute.
`execution:start` is the installed core's actual turn-start event; this module
does not invent an ``orchestrator:start`` event.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Callable

from amplifier_core import HookResult
from amplifier_core.events import (
    APPROVAL_DENIED,
    APPROVAL_GRANTED,
    APPROVAL_REQUIRED,
    ARTIFACT_READ,
    CANCEL_COMPLETED,
    CANCEL_REQUESTED,
    EXECUTION_START,
    ORCHESTRATOR_COMPLETE,
    PROMPT_COMPLETE,
    PROMPT_SUBMIT,
    PROVIDER_ERROR,
    SESSION_END,
    SESSION_FORK,
    SESSION_RESUME,
    SESSION_START,
    TOOL_ERROR,
    TOOL_POST,
    TOOL_PRE,
    USER_NOTIFICATION,
)

from .state import SessionStateTracker, _valid_session_id, spool_dir, write_diagnostic

ORCHESTRATOR_GOAL_PROGRESS = "orchestrator:goal_progress"
_STATE_HOOK_PRIORITY = 100
_CAPABILITY = "hooks-muxterm-session/0.7.0"
_DIAGNOSTIC_CAPABILITY = "hooks-muxterm-session/0.7.0/diagnostic"
logger = logging.getLogger(__name__)

__amplifier_module_type__ = "hook"


@dataclass(slots=True)
class _Mounted:
    """Per-coordinator capability; duplicate mounts retain its generation."""

    tracker: SessionStateTracker | None
    only_root: bool
    publish_state: bool
    setproctitle: Any
    cleanup: Callable[[], None]
    diagnostic: dict[str, Any]
    ready_observed: bool = False


def _identity(coordinator: Any) -> tuple[str | None, str | None]:
    """Use coordinator identity before an event payload exists."""
    try:
        session_id = getattr(coordinator, "session_id", None)
        parent_id = getattr(coordinator, "parent_id", "__unattributed__")
    except Exception:
        return None, None
    return (
        session_id if isinstance(session_id, str) and session_id else None,
        parent_id if isinstance(parent_id, str) and parent_id else
        None if parent_id is None else "__unattributed__",
    )


def _existing(coordinator: Any) -> _Mounted | None:
    try:
        mounted = coordinator.get_capability(_CAPABILITY)
    except Exception:
        return None
    return mounted if isinstance(mounted, _Mounted) else None


def _diagnostic_code(diagnostic: dict[str, Any], code: str) -> None:
    codes = diagnostic.setdefault("codes", [])
    if isinstance(codes, list) and code not in codes and len(codes) < 16:
        codes.append(code)


async def on_session_ready(coordinator: Any) -> None:
    """Create the initialized root row and stamp its recoverable title."""
    mounted = _existing(coordinator)
    if mounted is None:
        return
    session_id, parent_id = _identity(coordinator)
    if (
        session_id is None
        or not _valid_session_id(session_id)
    ):
        return
    mounted.ready_observed = True
    mounted.diagnostic["readyCallback"] = "observed"
    # A child must establish its lineage before its later events are folded into
    # the root, but it never owns a title stamp or a card.
    if mounted.tracker is not None:
        await mounted.tracker.on_session_ready(session_id, parent_id)
        if mounted.diagnostic["status"] == "failed":
            write_diagnostic(
                spool_dir(), session_id, status="failed", code="hook-registration-failed"
            )
    else:
        write_diagnostic(
            spool_dir(),
            session_id,
            status="failed" if mounted.diagnostic["status"] == "failed" else "disabled",
            code=(
                "tracker-init-failed"
                if mounted.diagnostic["status"] == "failed"
                else "publish-disabled"
            ),
        )
    if mounted.only_root and parent_id is not None:
        return
    if mounted.setproctitle is not None:
        try:
            mounted.setproctitle.setproctitle(f"amplifier resume {session_id}")
        except Exception:
            logger.debug("hooks-muxterm-session: title stamp failed")


async def mount(
    coordinator: Any, config: dict[str, Any] | None = None
) -> Callable[[], None]:
    """Register this coordinator once and return its unregistration cleanup."""
    prior = _existing(coordinator)
    if prior is not None:
        return prior.cleanup

    config = config or {}
    only_root = bool(config.get("only_root_sessions", True))
    publish_state = bool(config.get("publish_state", True))
    diagnostic: dict[str, Any] = {
        "v": 1,
        "publisher": "hooks-muxterm-session/0.7.0",
        "status": "initialized",
        "codes": [],
        "readyCallback": "pending",
        # Optional kernel/module sources, deliberately kept off snapshot data.
        "optionalSourceEvents": [
            SESSION_RESUME,
            EXECUTION_START,
            CANCEL_REQUESTED,
            CANCEL_COMPLETED,
            ORCHESTRATOR_GOAL_PROGRESS,
        ],
    }
    try:
        import setproctitle as setproctitle_module
    except ImportError:
        setproctitle_module = None
        logger.warning("hooks-muxterm-session: setproctitle unavailable")

    tracker: SessionStateTracker | None = None
    if publish_state:
        try:
            tracker = SessionStateTracker(
                coordinator,
                spool_dir(),
                classify_enabled=bool(config.get("classify_end_of_turn", True)),
                classify_model=config.get("classify_model") or None,
                label_enabled=bool(config.get("label_first_prompt", True)),
                label_model=config.get("label_model") or None,
            )
        except Exception:
            diagnostic["status"] = "failed"
            _diagnostic_code(diagnostic, "tracker-init-failed")
            logger.warning("hooks-muxterm-session: tracker-init-failed")
    else:
        diagnostic["status"] = "disabled"
        _diagnostic_code(diagnostic, "publish-disabled")

    unregisters: list[Callable[[], Any]] = []

    def guarded(handler: Any) -> Any:
        async def wrapper(event: str, data: dict[str, Any]) -> HookResult:
            try:
                await handler(event, data if isinstance(data, dict) else {})
            except Exception:
                diagnostic["status"] = "failed"
                _diagnostic_code(diagnostic, "event-handler-failed")
            # A later successful write must not erase a failed registration or
            # handler from the commissioning result.
            if diagnostic["status"] == "failed":
                session_id, parent_id = _identity(coordinator)
                if parent_id is None:
                    write_diagnostic(
                        spool_dir(), session_id, status="failed",
                        code="hook-reporting-failed",
                    )
            return HookResult(action="continue")

        return wrapper

    async def title_fallback(event: str, data: dict[str, Any]) -> None:
        """Stamp on start/resume when an old core never invokes ready."""
        session_id = data.get("session_id")
        parent_id = data.get("parent_id", data.get("parent"))
        if not _valid_session_id(session_id):
            session_id, parent_id = _identity(coordinator)
        elif not _valid_session_id(parent_id):
            coordinator_session_id, coordinator_parent_id = _identity(coordinator)
            parent_id = (
                coordinator_parent_id
                if session_id == coordinator_session_id
                else "__unattributed__"
            )
        if not _valid_session_id(session_id) or (only_root and parent_id is not None):
            return
        if not mounted.ready_observed:
            mounted.diagnostic["readyCallback"] = "unobserved"
            _diagnostic_code(mounted.diagnostic, "ready-callback-unobserved")
            write_diagnostic(
                spool_dir(),
                session_id,
                status=(
                    "failed"
                    if mounted.diagnostic["status"] == "failed"
                    else "disabled"
                    if not mounted.publish_state
                    else "unobserved"
                ),
                code="ready-callback-unobserved",
            )
        if setproctitle_module is not None:
            try:
                setproctitle_module.setproctitle(f"amplifier resume {session_id}")
            except Exception:
                logger.debug("hooks-muxterm-session: title stamp failed")

    # Preserve recovery stamping for older cores that lack on_session_ready.
    for event in (SESSION_START, SESSION_RESUME):
        try:
            unregister = coordinator.hooks.register(
                event,
                guarded(title_fallback),
                priority=0,
                name=f"hooks-muxterm-session-title:{event}",
            )
            if callable(unregister):
                unregisters.append(unregister)
        except Exception:
            _diagnostic_code(diagnostic, f"registration-{event}")
            diagnostic["status"] = "failed"
            logger.warning("hooks-muxterm-session: title-registration-failed")

    if tracker is not None:
        handlers: list[tuple[str, Any]] = [
            (SESSION_START, tracker.on_session_start),
            (SESSION_RESUME, tracker.on_session_resume),
            (SESSION_FORK, tracker.on_session_fork),
            (PROMPT_SUBMIT, tracker.on_prompt_submit),
            (EXECUTION_START, tracker.on_orchestrator_start),
            (TOOL_PRE, tracker.on_tool_pre),
            (TOOL_POST, tracker.on_tool_post),
            (TOOL_ERROR, tracker.on_tool_error),
            (PROVIDER_ERROR, tracker.on_tool_error),
            (ARTIFACT_READ, tracker.on_artifact_read),
            (APPROVAL_REQUIRED, tracker.on_approval_required),
            (APPROVAL_GRANTED, tracker.on_approval_resolved),
            (APPROVAL_DENIED, tracker.on_approval_resolved),
            (CANCEL_REQUESTED, tracker.on_cancel_requested),
            (CANCEL_COMPLETED, tracker.on_cancel_completed),
            (USER_NOTIFICATION, tracker.on_user_notification),
            (ORCHESTRATOR_GOAL_PROGRESS, tracker.on_goal_progress),
            (ORCHESTRATOR_COMPLETE, tracker.on_orchestrator_complete),
            (PROMPT_COMPLETE, tracker.on_prompt_complete),
            (SESSION_END, tracker.on_session_end),
        ]
        for event, handler in handlers:
            try:
                unregister = coordinator.hooks.register(
                    event,
                    guarded(handler),
                    priority=_STATE_HOOK_PRIORITY,
                    name=f"hooks-muxterm-session-state:{event}",
                )
                if callable(unregister):
                    unregisters.append(unregister)
            except Exception:
                _diagnostic_code(diagnostic, f"registration-{event}")
                diagnostic["status"] = "failed"
                logger.warning("hooks-muxterm-session: event-registration-failed")

    cleaned = False

    def cleanup() -> None:
        nonlocal cleaned
        if cleaned:
            return
        cleaned = True
        for unregister in reversed(unregisters):
            try:
                unregister()
            except Exception:
                pass
        if tracker is not None:
            tracker.cleanup()
        try:
            coordinator.register_capability(_CAPABILITY, None)
            coordinator.register_capability(_DIAGNOSTIC_CAPABILITY, None)
        except Exception:
            pass

    mounted = _Mounted(
        tracker, only_root, publish_state, setproctitle_module, cleanup, diagnostic
    )
    try:
        coordinator.register_capability(_CAPABILITY, mounted)
        coordinator.register_capability(_DIAGNOSTIC_CAPABILITY, diagnostic)
    except Exception:
        cleanup()
    return cleanup