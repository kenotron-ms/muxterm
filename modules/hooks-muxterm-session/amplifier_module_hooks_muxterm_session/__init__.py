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
"""

import logging
from typing import Any

from amplifier_core import HookResult
from amplifier_core.events import SESSION_START

logger = logging.getLogger(__name__)

__amplifier_module_type__ = "hook"


async def mount(
    coordinator: Any, config: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Register the session:start hook.

    Config keys:
      only_root_sessions (bool): Skip child/sub-agent sessions (default:
        true). A sub-agent's session:start would otherwise overwrite the
        title with its own internal, transient session id, clobbering the
        user-visible root session's id that muxterm actually needs for
        recovery. This must stay true for correct behavior in the normal
        case -- it is exposed as a config knob only for advanced/test use.
    """
    config = config or {}
    only_root = config.get("only_root_sessions", True)

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
    logger.info("hooks-muxterm-session mounted (only_root=%s)", only_root)

    return {
        "name": "hooks-muxterm-session",
        "version": "0.2.0",
        "description": "Stamp session id into process title for muxterm crash recovery",
    }
