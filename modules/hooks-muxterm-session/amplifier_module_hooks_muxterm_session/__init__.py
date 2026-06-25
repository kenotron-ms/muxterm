"""Amplifier hook: write session_id to disk on session:start for muxterm crash recovery.

When muxterm's sessiond snapshots a pane running an Amplifier session, it uses
the detect.file strategy to read this file and build an "amplifier resume <id>"
restore command. That way, after a daemon crash, the exact Amplifier session is
resumed silently instead of dropping the user into a bare shell.

The file path written here must match the path configured in detect.file in
muxterm's restore.strategies config (default: ~/.local/share/muxterm/amplifier-session-id).
"""

import logging
import os
from pathlib import Path
from typing import Any

from amplifier_core import HookResult
from amplifier_core.events import SESSION_START

logger = logging.getLogger(__name__)

__amplifier_module_type__ = "hook"

_DEFAULT_RECOVERY_FILE = (
    Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    / "muxterm"
    / "amplifier-session-id"
)


async def mount(coordinator: Any, config: dict[str, Any] | None = None) -> None:
    """Register the session:start hook.

    Config keys:
      recovery_file (str):   Path to write the session ID (default: XDG data dir).
      only_root_sessions (bool): Skip child/sub-agent sessions (default: true).
    """
    config = config or {}
    recovery_file = Path(
        config.get("recovery_file", str(_DEFAULT_RECOVERY_FILE))
    ).expanduser()
    only_root = config.get("only_root_sessions", True)

    async def on_session_start(event: str, data: dict[str, Any]) -> HookResult:
        session_id: str = data["session_id"]
        parent_id: str | None = data.get("parent_id")

        # By default, skip sub-agent sessions — only the user-facing root
        # session needs to be recorded for crash recovery.
        if only_root and parent_id is not None:
            return HookResult(action="continue")

        try:
            recovery_file.parent.mkdir(parents=True, exist_ok=True)
            recovery_file.write_text(session_id, encoding="utf-8")
            logger.debug(
                "muxterm crash recovery: wrote session_id %s to %s",
                session_id,
                recovery_file,
            )
        except OSError as exc:
            logger.warning(
                "muxterm crash recovery: could not write session recovery file %s: %s",
                recovery_file,
                exc,
            )

        return HookResult(action="continue")

    coordinator.hooks.register(
        SESSION_START,
        on_session_start,
        priority=0,
        name="hooks-muxterm-session",
    )
    logger.info(
        "hooks-muxterm-session mounted (recovery_file=%s, only_root=%s)",
        recovery_file,
        only_root,
    )
