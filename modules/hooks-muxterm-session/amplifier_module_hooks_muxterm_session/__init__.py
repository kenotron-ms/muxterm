"""Amplifier hook: stamp the session id into this process's title on
session:start, so muxterm's crash-recovery snapshot can discover and resume
the exact session after sessiond restarts.

Mechanism (why setproctitle, not a file or an env var):

setproctitle rewrites the process's argv[0] in-place in the original memory
block, making the new title visible in /proc/<pid>/cmdline (Linux) and via
KERN_PROCARGS2 sysctl (macOS) -- i.e. visible to any OTHER process (such as
muxterm's sessiond) that inspects this pane's foreground process, with no
IPC, no sidecar file, and no per-pane path to keep straight or invalidate.

os.environ["KEY"] = value does NOT work for this: the kernel's
/proc/<pid>/environ reflects only the initial environment at exec time, not
runtime modifications made after the process starts. setproctitle is the
correct mechanism because it modifies the same memory region
/proc/<pid>/cmdline reads.

The title is set to "amplifier resume <session-id>" -- muxterm's
foregroundCwdArgv() (internal/sessiond/foreground_cwd_argv_linux.go) already
reads this via the existing /proc/<pid>/cmdline capture performed for every
pane; a small matcher (internal/sessiond/agent_catalog.go) recognizes this
exact shape and extracts the id from it, so no new capture path is needed on
muxterm's side -- only a new pattern to recognize.

Why this hook exists at all (rather than amplifier-app-cli doing this
itself): amplifier-app-cli does not yet stamp its own process title -- see
branch feat/stamp-session-id-env-var in that repo, which implements this
identical mechanism but is unmerged. Doing it here, as an Amplifier hook
shipped with muxterm's own bundle, means muxterm does not have to wait on
that landing upstream: any session started with this bundle installed
(`muxterm amplifier install`) gets the stamp regardless of what
amplifier-app-cli's own main branch does or doesn't do. Without this hook
installed, muxterm's restore path falls back to best-effort scraping the
session id out of the pane's captured output instead (see snapshot.go) --
strictly weaker, but the hook needs zero cooperation from anyone to exist.

This module also publishes the session's DECLARED state -- what it is doing,
and in particular whether it is working or waiting on a human -- to a spool
directory the daemon reads. See state.py for why that channel has to exist:
sessiond's PTY-based activity classifier cannot tell thinking from waiting,
because both own the terminal.
"""

import logging
from typing import Any

from amplifier_core import HookResult
from amplifier_core.events import (
    APPROVAL_DENIED,
    APPROVAL_GRANTED,
    APPROVAL_REQUIRED,
    ARTIFACT_READ,
    ORCHESTRATOR_COMPLETE,
    PROMPT_COMPLETE,
    PROMPT_SUBMIT,
    PROVIDER_ERROR,
    SESSION_END,
    SESSION_FORK,
    SESSION_START,
    TOOL_ERROR,
    TOOL_POST,
    TOOL_PRE,
    USER_NOTIFICATION,
)

from .state import SessionStateTracker, spool_dir

# The /goal loop's own progress event. Not a kernel constant -- it is emitted by
# the loop-streaming orchestrator, which is a module rather than the kernel, so
# there is nothing in amplifier_core.events to import. Spelled out here with its
# origin named so a future reader does not go looking for a constant that was
# never there.
ORCHESTRATOR_GOAL_PROGRESS = "orchestrator:goal_progress"

logger = logging.getLogger(__name__)

__amplifier_module_type__ = "hook"

# Registered below the redaction hook (priority 10) so payloads reaching these
# handlers have already been scrubbed -- this hook writes prompt text and file
# paths to disk, so it should never see raw secrets in the first place.
_STATE_HOOK_PRIORITY = 100


async def mount(
    coordinator: Any, config: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Register the process-title stamp and the session-state publisher.

    Config keys:
      only_root_sessions (bool): Skip child/sub-agent sessions (default:
        true). A sub-agent's session:start would otherwise overwrite the
        title with its own internal, transient session id, clobbering the
        user-visible root session's id that muxterm actually needs for
        recovery. This must stay true for correct behavior in the normal
        case -- it is exposed as a config knob only for advanced/test use.
      classify_end_of_turn (bool): At end of turn, ask a cheap model whether
        the assistant's closing message was actually a question for the human,
        and if so surface the session as "needs input" with the ask summarised
        (default: true). Turning it off leaves the structural verdict alone:
        a finished turn simply reports `stopped`, which is what it did before
        this existed. Every failure path already degrades to that, so this
        knob is for cost control, not correctness.
      classify_model (str): Model id for that classification. Defaults to
        whatever the session's provider resolves on its own.
      label_first_prompt (bool): At the FIRST prompt of a session, ask a cheap
        model for a 1-3 word label naming what the session is about, for
        muxterm's pane tab (default: true). One call per session, not per
        turn. Turning it off leaves the deterministic label the daemon derives
        from the launch argv at spawn (internal/sessiond/autolabel.go), which
        is also where every failure path already lands -- so this knob is for
        cost control, not correctness.
      label_model (str): Model id for that labelling. Defaults to whatever the
        session's provider resolves on its own.
      publish_state (bool): Publish session-state snapshots for muxterm's
        home view (default: true). Turning it off leaves the title stamp,
        and therefore crash recovery, fully intact -- the two capabilities
        share a module but not a dependency.
    """
    config = config or {}
    only_root = config.get("only_root_sessions", True)
    publish_state = config.get("publish_state", True)
    classify_end_of_turn = config.get("classify_end_of_turn", True)
    classify_model = config.get("classify_model") or None
    label_first_prompt = config.get("label_first_prompt", True)
    label_model = config.get("label_model") or None

    try:
        import setproctitle as setproctitle_module
    except ImportError:
        logger.warning(
            "hooks-muxterm-session: setproctitle not installed; session-id "
            "stamping disabled (muxterm's crash recovery will fall back to "
            "best-effort output scraping for panes running amplifier)"
        )
        setproctitle_module = None

    async def on_session_start(event: str, data: dict[str, Any]) -> HookResult:
        if setproctitle_module is None:
            return HookResult(action="continue")

        session_id: str = data["session_id"]
        parent_id: str | None = data.get("parent_id")

        if only_root and parent_id is not None:
            return HookResult(action="continue")

        try:
            setproctitle_module.setproctitle(f"amplifier resume {session_id}")
            logger.debug(
                "hooks-muxterm-session: stamped process title for session %s",
                session_id,
            )
        except Exception as exc:  # setproctitle can fail on unsupported platforms
            logger.warning(
                "hooks-muxterm-session: could not stamp process title: %s", exc
            )

        return HookResult(action="continue")

    coordinator.hooks.register(
        SESSION_START,
        on_session_start,
        priority=0,
        name="hooks-muxterm-session",
    )

    published = (
        _register_state_publisher(
            coordinator,
            classify_enabled=classify_end_of_turn,
            classify_model=classify_model,
            label_enabled=label_first_prompt,
            label_model=label_model,
        )
        if publish_state
        else False
    )

    logger.info(
        "hooks-muxterm-session mounted (only_root=%s, publish_state=%s)",
        only_root,
        published,
    )

    return {
        "name": "hooks-muxterm-session",
        "version": "0.3.0",
        "description": (
            "Stamp session id into process title for muxterm crash recovery, "
            "and publish declared session state for muxterm's home view"
        ),
    }


def _register_state_publisher(
    coordinator: Any,
    *,
    classify_enabled: bool = True,
    classify_model: str | None = None,
    label_enabled: bool = True,
    label_model: str | None = None,
) -> bool:
    """Wire the session-state tracker onto the kernel event stream.

    Returns whether publishing was armed. A failure here is logged and
    swallowed: a session must start and run normally even if muxterm's home
    view learns nothing about it.
    """
    try:
        tracker = SessionStateTracker(
            coordinator,
            spool_dir(),
            classify_enabled=classify_enabled,
            classify_model=classify_model,
            label_enabled=label_enabled,
            label_model=label_model,
        )
    except Exception as exc:
        logger.warning(
            "hooks-muxterm-session: session-state publishing disabled (%s)", exc
        )
        return False

    def guarded(handler: Any, label: str) -> Any:
        """Make a handler structurally incapable of harming the session.

        The kernel already logs-and-skips a raising handler, so this is the
        second of two independent guarantees rather than the only one. It is
        worth having anyway: the cost of a bug in an advisory sidebar feed must
        never be a broken user session, and `continue` is returned on every
        path so nothing downstream is altered either.
        """

        async def wrapper(event: str, data: dict[str, Any]) -> HookResult:
            try:
                await handler(event, data)
            except Exception as exc:
                logger.debug(
                    "hooks-muxterm-session: %s handler failed: %s", label, exc
                )
            return HookResult(action="continue")

        return wrapper

    # Event -> projection. Ordered as the session lives, not alphabetically.
    #
    # PROVIDER_ERROR shares TOOL_ERROR's handler deliberately: both mean "a call
    # failed and the agent will probably recover", and neither is a reason to
    # mark a session failed.
    #
    # USER_NOTIFICATION is registered even though nothing in the current kernel
    # emits it -- it is named in the contract, and an empty subscription costs
    # nothing. It is emphatically NOT how a resting plain session is detected;
    # see on_orchestrator_complete for the rule that actually decides that.
    handlers: list[tuple[str, Any]] = [
        (SESSION_START, tracker.on_session_start),
        (SESSION_FORK, tracker.on_session_fork),
        (PROMPT_SUBMIT, tracker.on_prompt_submit),
        (TOOL_PRE, tracker.on_tool_pre),
        (TOOL_POST, tracker.on_tool_post),
        (TOOL_ERROR, tracker.on_tool_error),
        (PROVIDER_ERROR, tracker.on_tool_error),
        (ARTIFACT_READ, tracker.on_artifact_read),
        (APPROVAL_REQUIRED, tracker.on_approval_required),
        (APPROVAL_GRANTED, tracker.on_approval_resolved),
        (APPROVAL_DENIED, tracker.on_approval_resolved),
        (USER_NOTIFICATION, tracker.on_user_notification),
        (ORCHESTRATOR_GOAL_PROGRESS, tracker.on_goal_progress),
        (ORCHESTRATOR_COMPLETE, tracker.on_orchestrator_complete),
        (PROMPT_COMPLETE, tracker.on_prompt_complete),
        (SESSION_END, tracker.on_session_end),
    ]

    for event, handler in handlers:
        try:
            coordinator.hooks.register(
                event,
                guarded(handler, event),
                priority=_STATE_HOOK_PRIORITY,
                name=f"hooks-muxterm-session-state:{event}",
            )
        except Exception as exc:
            logger.debug(
                "hooks-muxterm-session: could not register %s: %s", event, exc
            )
    return True
