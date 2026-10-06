#!/usr/bin/env python3
"""Amplifier SDK chat sidecar over NDJSON stdio."""

# ---------------------------------------------------------------------------
# stdout discipline -- spec 2.1.  MUST run before importing anything that might
# print.  The amplifier stack writes token-usage footers and streaming overlay
# paint to stdout; a single stray byte corrupts the protocol stream.  So: keep
# the real stdout as a private fd, and point fd 1 at stderr so every naive
# print() in the process lands somewhere harmless.
# ---------------------------------------------------------------------------
import os  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402
_PROCESS_T0 = time.monotonic()

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
import base64  # noqa: E402
import copy  # noqa: E402
import dataclasses  # noqa: E402
import json  # noqa: E402
import logging  # noqa: E402
import signal  # noqa: E402
import shutil  # noqa: E402
import subprocess  # noqa: E402
import importlib.metadata  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
from dataclasses import dataclass, field  # noqa: E402
from datetime import datetime, timezone  # noqa: E402
from pathlib import Path  # noqa: E402
from typing import Any  # noqa: E402

_BOOT_T0 = time.monotonic()

def timing(stage: str, started: float | None = None) -> None:
    now = time.monotonic()
    logger.info("TIMING %s elapsed_ms=%.1f process_ms=%.1f", stage,
                (now - started) * 1000 if started is not None else 0,
                (now - _PROCESS_T0) * 1000)

logger = logging.getLogger("amplifier-chat")















LOOP_LIVE_SOURCE = "git+https://github.com/microsoft/amplifier-module-loop-live@36d242ed2a3a061e2e670779ca646edf85f006be"

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


SDK_CHAT_SESSIONS = {}
SDK_CHAT_PROTO = None
SDK_PREPARED_CACHE = {}
CAPS = dict(approvals=False, transcript_read=True, interrupt=True,
            live_input=True, attributed_service_input=True, native_steering=True)


def frame(session_id, event_type, **data):
    SDK_CHAT_PROTO.emit(ev="sdk_event", event={"sessionId": session_id,
                        "type": event_type, **data})


class UnattendedChatApproval:
    async def request_approval(self, *args):
        # Amplifier calls this as an ApprovalSystem for hook prompts and as
        # an ApprovalProvider for tool gates. Neither path can await a person
        # inside an unattended chat.
        if len(args) == 1:
            from amplifier_core import ApprovalResponse
            return ApprovalResponse(approved=True, reason="Chat runs unattended")
        if len(args) == 4:
            _prompt, options, _timeout, _default = args
            affirmative = ("allow always", "allow once", "allow", "yes", "approve", "continue", "proceed")
            choice = next((option for word in affirmative for option in options
                           if str(option).lower().startswith(word)), None)
            if choice is None:
                raise PermissionError("approval request has no affirmative option")
            return choice
        raise TypeError("unsupported approval request")


class QuietDisplay:
    nesting_depth = 0
    def show_message(self, message, level="info", source="hook"):
        print(f"[{source}] {message}", file=sys.stderr)
    def push_nesting(self): self.nesting_depth += 1
    def pop_nesting(self): self.nesting_depth = max(0, self.nesting_depth - 1)


def sdk_provider_context(messages, provider):
    """Keep unsigned reasoning out of Anthropic requests after a provider switch.

    OpenAI thinking blocks in saved Amplifier history have no Anthropic
    signature. Anthropic interprets them as native thinking blocks and rejects
    the entire request. Preserve the stored transcript and all text/tool history.
    """
    if provider != "provider-anthropic":
        return messages, 0
    context = []
    omitted = 0
    for message in messages:
        if not isinstance(message, dict):
            context.append(message)
            continue
        clean = message
        content = message.get("content")
        if isinstance(content, list):
            blocks = [block for block in content if not (
                isinstance(block, dict) and block.get("type") == "thinking"
                and not (isinstance(block.get("signature"), str) and block["signature"])
            )]
            omitted += len(content) - len(blocks)
            if len(blocks) != len(content):
                clean = ({**clean, "content": blocks} if blocks else
                         {key: value for key, value in clean.items() if key != "content"})
            if not blocks and not message.get("tool_calls"):
                continue
        # The Anthropic provider also reads this older separate thinking field.
        legacy = message.get("thinking_block")
        if isinstance(legacy, dict) and legacy.get("type") == "thinking" and not (
            isinstance(legacy.get("signature"), str) and legacy["signature"]
        ):
            clean = {key: value for key, value in clean.items() if key != "thinking_block"}
            omitted += 1
        context.append(clean)
    return context, omitted


class SDKChatSession:
    def __init__(self, session_id, cwd, bundle="anchors", provider="", model="", effort="", mode=""):
        self.id, self.cwd = session_id, cwd
        self.bundle, self.provider = bundle or "anchors", provider or ""
        self.selected_model, self.effort = model or "", effort or ""
        # Amplifier's own mode overlay (bundle-modes), not the harness-generic
        # agent/plan switch. Empty means no mode is active.
        self.mode = mode or ""
        self.session = self.runtime = self.task = self.store = None
        self.active = set()
        self.partial = ""
        self.model = ""
        self.available_providers = []
        self.available_bundles = []
        self.model_rows = None
        self.closed = False
        self.turn_started = None
        self.first_token_seen = False
        self.cancel_requested = False
        self.steering = False
        self.finish_task = None

    @staticmethod
    def image_content(command, coordinator):
        """Give loop-live a native image block instead of only a file path."""
        blocks = [{"type": "text", "text": command.text}]
        for item in command.attachments:
            data = Path(item["path"]).read_bytes()
            if data.startswith(b"\x89PNG\r\n\x1a\n"):
                media_type = "image/png"
            elif data.startswith(b"\xff\xd8\xff"):
                media_type = "image/jpeg"
            elif data.startswith((b"GIF87a", b"GIF89a")):
                media_type = "image/gif"
            elif data.startswith(b"RIFF") and data[8:12] == b"WEBP":
                media_type = "image/webp"
            else:
                raise ValueError("Unsupported attached image format")
            blocks.append({"type": "image", "source": {"type": "base64",
                           "media_type": media_type,
                           "data": base64.b64encode(data).decode("ascii")}})
        return blocks

    async def build(self):
        build_start = time.monotonic()
        from amplifier_app_cli.lib.settings import AppSettings, SettingsPaths
        from amplifier_app_cli.lib.bundle_loader.discovery import AppBundleDiscovery
        from amplifier_app_cli.paths import get_amplifier_home, get_bundle_search_paths
        from amplifier_app_cli.runtime.config import expand_env_vars, resolve_bundle_config
        from amplifier_app_cli.session_runner import SessionConfig, _create_bundle_session
        from amplifier_app_cli.session_store import SessionStore
        from rich.console import Console

        # Process cwd belongs to the shared sidecar. Resolve each chat's settings
        # and native store explicitly from its project path.
        project = Path(self.cwd).resolve()
        slug = str(project).replace("/", "-").replace("\\", "-").replace(":", "")
        if not slug.startswith("-"):
            slug = "-" + slug
        home = get_amplifier_home()
        settings = AppSettings(SettingsPaths(
            global_settings=home / "settings.yaml",
            project_settings=project / ".amplifier" / "settings.yaml",
            local_settings=project / ".amplifier" / "settings.local.yaml",
            session_settings=None,
        ))
        resolve_start = time.monotonic()
        try:
            # Preparation resolves every composed bundle and activates its modules.
            # It is independent of the chat ID; reuse that work for later chats in
            # this project, while giving each session its own mutable bundle/plan.
            settings_paths = (home / "settings.yaml", project / ".amplifier" / "settings.yaml",
                              project / ".amplifier" / "settings.local.yaml")
            settings_stamp = tuple((p.stat().st_mtime_ns, p.stat().st_size) if p.exists() else None
                                   for p in settings_paths)
            cache_key = (str(project), self.bundle, settings_stamp)
            cached = SDK_PREPARED_CACHE.get(cache_key)
            if cached is not None and time.monotonic() - cached[0] > 300:
                SDK_PREPARED_CACHE.pop(cache_key, None)
                cached = None
            if cached is None:
                cfg, prepared = await resolve_bundle_config(self.bundle, settings, None, project_slug=slug)
                if len(SDK_PREPARED_CACHE) >= 4:
                    SDK_PREPARED_CACHE.pop(next(iter(SDK_PREPARED_CACHE)))
                SDK_PREPARED_CACHE[cache_key] = (time.monotonic(), copy.deepcopy(cfg), prepared)
            else:
                cfg = copy.deepcopy(cached[1])
                timing("sdk.prepared_cache_hit", resolve_start)
            template = SDK_PREPARED_CACHE[cache_key][2]
            prepared = dataclasses.replace(template, mount_plan=copy.deepcopy(template.mount_plan),
                                           bundle=copy.deepcopy(template.bundle))
        except Exception as exc:
            raise RuntimeError(f"bundle '{self.bundle}' failed to load: {exc}") from exc
        timing("sdk.bundle_resolution", resolve_start)
        discovery_paths = [project / ".amplifier" / "bundles", *get_bundle_search_paths()]
        self.available_bundles = sorted({self.bundle, *(
            name for name in AppBundleDiscovery(search_paths=discovery_paths).list_bundles()
            if not name.startswith("muxterm-invocation-")
        )})
        providers = cfg.get("providers") or []
        self.available_providers = sorted(set(entry.get("module", "") for entry in providers if entry.get("module")))
        # A chat runs with one provider. Mounting unused providers delays replies.
        if not self.provider and providers:
            self.provider = providers[0].get("module") or providers[0].get("instance_id") or ""
        selected = [entry for entry in providers if entry.get("module") == self.provider
                    or entry.get("instance_id") == self.provider]
        if not selected:
            raise RuntimeError(f"provider '{self.provider or 'default'}' is unavailable for bundle '{self.bundle}'")
        cfg["providers"] = selected
        prepared.mount_plan["providers"] = copy.deepcopy(selected)
        prepared.bundle.providers = copy.deepcopy(selected)
        if self.selected_model:
            for entries in (cfg["providers"], prepared.mount_plan["providers"], prepared.bundle.providers):
                for entry in entries:
                    entry.setdefault("config", {})["default_model"] = self.selected_model
                    if self.effort:
                        entry["config"]["reasoning_effort"] = self.effort

        cfg = expand_env_vars(cfg)
        # Every SDK chat bundle gets the same muxterm MCP surface as Codex and
        # Claude. A project bundle may have no tool-mcp mount of its own.
        mcp_bin = os.environ.get("MUXTERM_CHAT_MCP_BIN")
        if not mcp_bin or not Path(mcp_bin).is_file():
            raise RuntimeError("muxterm SDK chat MCP binary unavailable")
        mcp_tool = {"module": "tool-mcp",
                    "source": "git+https://github.com/microsoft/amplifier-module-tool-mcp@main",
                    "config": {"servers": {"muxterm": {"command": mcp_bin, "args": ["mcp"]}}}}
        github_marker = (Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local" / "share")))
                         / "muxterm" / "sdk-chat" / "connections" / "github-enabled")
        github_enabled = github_marker.is_file()
        if github_enabled:
            mcp_tool["config"]["servers"]["github"] = {"command": mcp_bin,
                                                      "args": ["connection-mcp", "github"]}
        remote_connection_file = github_marker.with_name("remote.json")
        if remote_connection_file.is_file():
            mcp_tool["config"]["servers"]["remote"] = {"command": mcp_bin,
                                                       "args": ["connection-mcp", "remote"]}
        microsoft_root = github_marker.parent / "microsoft-graph"
        microsoft_servers = {}
        if (microsoft_root / "personal" / "enabled").is_file():
            microsoft_servers["microsoft_personal"] = {
                "command": mcp_bin, "args": ["connection-mcp", "microsoft-personal"]}
        mcp_tool["config"]["servers"].update(microsoft_servers)
        for tool_plan in (cfg.setdefault("tools", []), prepared.mount_plan.setdefault("tools", []),
                          prepared.bundle.tools):
            entry = next((tool for tool in tool_plan if tool.get("module") == "tool-mcp"), None)
            if entry is None:
                tool_plan.append(copy.deepcopy(mcp_tool))
            else:
                entry.setdefault("config", {}).setdefault("servers", {})["muxterm"] = {
                    "command": mcp_bin, "args": ["mcp"]}
                if github_enabled:
                    entry["config"]["servers"]["github"] = {"command": mcp_bin,
                                                          "args": ["connection-mcp", "github"]}
                if remote_connection_file.is_file():
                    entry["config"]["servers"]["remote"] = {"command": mcp_bin,
                                                          "args": ["connection-mcp", "remote"]}
                entry["config"]["servers"].update(microsoft_servers)
        # The skills CLI installs its canonical global copy here. Bundle authors
        # can choose their own skill sources, but all muxterm chats must also be
        # able to discover the owner's shared skills regardless of bundle.
        shared_skills = str(Path.home() / ".agents" / "skills")
        default_skill_sources = [".amplifier/skills", str(Path.home() / ".amplifier" / "skills")]
        skills_tool = {"module": "tool-skills",
                       "source": "git+https://github.com/microsoft/amplifier-bundle-skills@main#subdirectory=modules/tool-skills",
                       "config": {"skills": [*default_skill_sources, shared_skills]}}
        for tool_plan in (cfg.setdefault("tools", []), prepared.mount_plan.setdefault("tools", []),
                          prepared.bundle.tools):
            entry = next((tool for tool in tool_plan if tool.get("module") == "tool-skills"), None)
            if entry is None:
                tool_plan.append(copy.deepcopy(skills_tool))
            else:
                tool_config = entry.setdefault("config", {})
                # The newer `skills` key wins over `skills_dirs`, so carry
                # existing sources forward before adding the shared directory.
                sources = tool_config.get("skills")
                if sources is None:
                    sources = tool_config.get("skills_dirs")
                if sources is None:
                    sources = default_skill_sources
                if isinstance(sources, str):
                    sources = [sources]
                else:
                    sources = list(sources)
                if shared_skills not in sources:
                    sources.append(shared_skills)
                tool_config["skills"] = sources
        live = {"module": "loop-live", "source": LOOP_LIVE_SOURCE,
                "config": {"background_tools": [], "background_delegate": False}}
        cfg.setdefault("session", {})["orchestrator"] = live
        prepared.bundle.session["orchestrator"] = dict(live)
        prepared.mount_plan.setdefault("session", {})["orchestrator"] = dict(live)
        self.store = SessionStore(base_dir=home / "projects" / slug / "sessions")
        transcript = None
        if self.store.exists(self.id):
            transcript, _ = self.store.load(self.id)
            if not isinstance(transcript, list):
                raise RuntimeError("stored Amplifier transcript is invalid; refusing replay")
            transcript, omitted = sdk_provider_context(transcript, self.provider)
            if omitted:
                logger.info("SDK chat %s omitted %d unsigned thinking blocks from Anthropic context", self.id, omitted)
        cfg["working_dir"] = self.cwd
        cfg.setdefault("root_session_id", self.id)
        cfg.setdefault("application_host", "muxterm-sdk-chat")
        cfg.setdefault("project_slug", slug)
        cfg.setdefault("project_dir", self.cwd)
        cfg.setdefault("project_name", project.name)
        process_bundle_dir = Path.cwd() / ".amplifier" / "bundles"
        bundle_paths = [project / ".amplifier" / "bundles"] + [
            path for path in get_bundle_search_paths() if path != process_bundle_dir
        ]
        sc = SessionConfig(config=cfg, search_paths=bundle_paths, verbose=False,
                           session_id=self.id, bundle_name=self.bundle, prepared_bundle=prepared,
                           initial_transcript=transcript)
        devnull = open(os.devnull, "w")
        # _create_bundle_session passes Path.cwd() as session_cwd into
        # PreparedBundle.create_session. That value becomes the per-session
        # working_dir capability read by filesystem tools. The dispatch loop
        # refuses a build while another turn is active, so the temporary cwd
        # cannot redirect work already in flight.
        previous_cwd = os.getcwd()
        create_start = time.monotonic()
        try:
            os.chdir(self.cwd)
            try:
                self.session = await _create_bundle_session(sc, self.id, UnattendedChatApproval(), QuietDisplay(),
                                                            Console(quiet=True, file=devnull))
            except BaseException as exc:
                raise RuntimeError(f"bundle '{self.bundle}' provider '{self.provider or 'default'}' failed to load: {exc}") from exc
        finally:
            os.chdir(previous_cwd)
            devnull.close()
        timing("sdk.session_creation_provider_init", create_start)
        register_approval = self.session.coordinator.get_capability("approval.register_provider")
        if register_approval:
            register_approval(UnattendedChatApproval())
        providers = self.session.coordinator.get("providers") or {}
        self.model = next((f"{name}/{getattr(p, 'model', None) or getattr(p, 'default_model', '')}"
                           for name, p in providers.items()
                           if getattr(p, "model", None) or getattr(p, "default_model", None)), "")
        if not self.model:
            raise RuntimeError(f"provider '{self.provider or 'default'}' resolved no model for bundle '{self.bundle}'")
        import_start = time.monotonic()
        from amplifier_module_loop_live import mount as mount_loop_live
        from amplifier_module_loop_live.runtime import Runtime
        timing("sdk.loop_live_import", import_start)
        mount_start = time.monotonic()
        await mount_loop_live(self.session.coordinator, {"background_tools": [], "background_delegate": False})
        timing("sdk.loop_live_mount", mount_start)
        self.runtime = Runtime(session_id=self.id, observer=self.observe)
        self.session.coordinator.register_capability("live.runtime", self.runtime)
        self.session.coordinator.register_capability("live.attachments.encode", self.image_content)
        if transcript:
            context = self.session.coordinator.get("context")
            if context is None or not hasattr(context, "set_messages"):
                raise RuntimeError("Amplifier context cannot restore transcript")
            await context.set_messages(transcript)
        self.hooks()
        # Re-apply the chosen overlay before the dispatch loop runs, so a rebuilt
        # session (bundle/provider/model switch) keeps the mode the human picked.
        # A mode belongs to the bundle that defined it, so switching bundles can
        # legitimately leave it behind: drop it rather than failing the build.
        if self.mode:
            try:
                await self.apply_mode(self.mode)
            except Exception as exc:
                logger.info("SDK chat %s dropped mode '%s': %s", self.id, self.mode, exc)
                self.mode = ""
        self.task = asyncio.create_task(self.session.execute(""), name=f"amplifier-chat-{self.id}")
        self.task.add_done_callback(self.owner_done)
        frame(self.id, "session.started", nativeId=self.id, capabilities=CAPS, model=self.model,
              bundle=self.bundle, provider=self.provider or self.model.split("/", 1)[0])
        timing("sdk.build_total", build_start)

    def mode_discovery(self):
        """bundle-modes' discovery, or None when this bundle composes no modes."""
        state = getattr(self.session, "coordinator", None)
        if state is None:
            return None
        return state.session_state.get("mode_discovery")

    def available_modes(self):
        """Modes this bundle offers. Empty list means the bundle has no mode system."""
        discovery = self.mode_discovery()
        if discovery is None:
            return []
        try:
            listed = discovery.list_modes()
        except Exception:
            logger.warning("SDK chat %s could not list Amplifier modes", self.id, exc_info=True)
            return []
        # advertised=False marks modes meant for the model to discover, not a
        # human picker, so the chat surface shows only advertised ones.
        return [{"name": entry.name, "description": entry.description, "source": entry.source}
                for entry in listed if getattr(entry, "advertised", True)]

    def active_mode(self):
        state = getattr(self.session, "coordinator", None)
        if state is None:
            return ""
        return state.session_state.get("active_mode") or ""

    async def apply_mode(self, name):
        """Activate (or clear, when name is empty) an Amplifier mode.

        Goes through the mounted `mode` tool rather than writing session_state
        directly, so hooks-mode sees the same activation events a /mode switch
        produces. tool-mode's default gate_policy is "warn": the first set is
        refused with status "denied" and a retry proceeds. That gate exists to
        stop the model switching modes unprompted -- here a human clicked the
        picker, so the retry is the human's answer, not a bypass.
        """
        tool = self.session.coordinator.get("tools", "mode")
        if tool is None:
            raise ValueError("this Amplifier bundle does not provide a mode system")
        request = {"operation": "clear"} if not name else {"operation": "set", "name": name}
        result = await tool.execute(request)
        output = getattr(result, "output", None) or {}
        if not getattr(result, "success", False) and isinstance(output, dict) and output.get("status") == "denied":
            result = await tool.execute(request)
            output = getattr(result, "output", None) or {}
        if not getattr(result, "success", False):
            error = getattr(result, "error", None) or {}
            message = error.get("message") if isinstance(error, dict) else None
            raise ValueError(message or f"Amplifier refused mode '{name or 'default'}'")
        self.mode = self.active_mode()
        return self.mode

    def owner_done(self, task):
        if task.cancelled(): return
        error = task.exception()
        if not self.closed:
            frame(self.id, "error", message=f"Amplifier execute stopped: {error or 'owner exited'}")

    def hooks(self):
        from amplifier_core.models import HookResult
        hooks = self.session.coordinator.get("hooks")
        if hooks is None: raise RuntimeError("Amplifier hook registry unavailable")
        cont = HookResult(action="continue")
        async def delta(event, data):
            if data.get("block_type") == "thinking" and data.get("text"):
                frame(self.id, "thinking.delta", text=data["text"])
            elif data.get("text"):
                if not self.first_token_seen and self.turn_started is not None:
                    self.first_token_seen = True
                    timing("sdk.first_token", self.turn_started)
                frame(self.id, "assistant.delta", text=data["text"])
            return cont
        async def tool_start(event, data):
            frame(self.id, "tool.started", toolId=str(data.get("tool_call_id") or ""),
                  name=str(data.get("tool_name") or "Tool"), raw=data.get("tool_input"))
            return cont
        async def tool_end(event, data):
            frame(self.id, "tool.completed", toolId=str(data.get("tool_call_id") or ""),
                  name=str(data.get("tool_name") or "Tool"), raw=data.get("result") or data.get("error"),
                  failed=event == "tool:error")
            return cont
        async def provider_request(event, data):
            # Record the mounted provider at the request boundary. Explicit
            # selections mount exactly one module; a label alone cannot prove
            # which provider handled a turn. Never include provider config.
            providers = self.session.coordinator.get("providers") or {}
            if len(providers) == 1:
                name, provider = next(iter(providers.items()))
                frame(self.id, "provider.request", provider=name,
                      model=str(getattr(provider, "model", None) or
                                getattr(provider, "default_model", "")))
            return cont
        async def goal_progress(event, data):
            frame(self.id, "goal.progress", goalState=str(data.get("state") or ""),
                  goalReason=str(data.get("reason") or ""),
                  goalSummary=str(data.get("summary") or ""), raw=data)
            return cont
        async def delegate_spawned(event, data):
            frame(self.id, "delegate.spawned", childSessionId=str(data.get("sub_session_id") or ""),
                  parentSessionId=str(data.get("parent_session_id") or self.id),
                  agent=str(data.get("agent") or "Agent"), toolId=str(data.get("tool_call_id") or ""))
            return cont
        async def delegate_completed(event, data):
            frame(self.id, "delegate.completed", childSessionId=str(data.get("sub_session_id") or ""),
                  parentSessionId=str(data.get("parent_session_id") or self.id),
                  agent=str(data.get("agent") or "Agent"), toolId=str(data.get("tool_call_id") or ""),
                  failed=not bool(data.get("success")))
            return cont
        hooks.register("llm:stream_block_delta", delta, name="sdk-chat-delta")
        hooks.register("provider:request", provider_request, name="sdk-chat-provider-request")
        hooks.register("tool:pre", tool_start, name="sdk-chat-tool-start")
        hooks.register("tool:post", tool_end, name="sdk-chat-tool-end")
        hooks.register("tool:error", tool_end, name="sdk-chat-tool-error")
        hooks.register("orchestrator:goal_progress", goal_progress, name="sdk-chat-goal-progress")
        hooks.register("delegate:agent_spawned", delegate_spawned, name="sdk-chat-delegate-spawned")
        hooks.register("delegate:agent_completed", delegate_completed, name="sdk-chat-delegate-completed")

    def observe(self, event):
        kind = event.get("type")
        if kind == "input.accepted":
            frame(self.id, "input.accepted.runtime", inputId=event.get("input_id"),
                  kind=event.get("kind"), source=event.get("source"), sequence=event.get("sequence"))
        elif kind == "input.delivered":
            frame(self.id, "input.delivered", inputId=event.get("input_id"),
                  source=event.get("source"), delivery=event.get("delivery"),
                  sequence=event.get("sequence"))
        elif kind in ("generation.finished", "generation.failed", "generation.detached"):
            self.finish_task = asyncio.create_task(self.finish(event))

    async def finish(self, event):
        if self.turn_started is not None:
            timing("sdk.turn_completion", self.turn_started)
        ids = list(event.get("input_ids") or [])
        persisted = False
        try:
            context = self.session.coordinator.get("context")
            messages = await context.get_messages()
            if messages:
                self.store.save(self.id, messages, {"session_id": self.id,
                    "created": datetime.now(timezone.utc).isoformat(), "bundle": self.bundle,
                    "model": self.model, "working_dir": self.cwd})
                persisted = True
        except Exception as exc:
            frame(self.id, "error", message=f"Amplifier transcript persistence failed: {exc}")
        finished = event.get("type") == "generation.finished"
        if not self.steering and not (self.cancel_requested and not finished):
            frame(self.id, "generation.finished" if finished else "error", inputIds=ids,
                  generationId=event.get("generation_id"), persisted=persisted,
                  message=event.get("error_type", ""))
        if finished and not self.steering:
            frame(self.id, "turn.completed", inputIds=ids, generationId=event.get("generation_id"), persisted=persisted)
        if self.steering: self.active.clear()
        else: self.active.difference_update(ids)

    async def send(self, value):
        from amplifier_module_loop_live.runtime import Input
        kind, source, input_id = value.get("kind"), value.get("source"), value.get("id")
        content = value.get("content", "")
        display_content = value.get("displayContent", content)
        attachments = value.get("attachments") or []
        files = [item for item in attachments if item["kind"] != "image"]
        images = [item for item in attachments if item["kind"] == "image"]
        if files:
            manifest = "\n".join(
                f'- {json.dumps(item["name"])} ({item["kind"]}): {json.dumps(item["path"])}'
                for item in files
            )
            content = (content or "Please inspect the attached files.") + (
                "\n\nAttached files on the local filesystem (absolute paths):\n"
                + manifest + "\nRead the files at these paths before answering."
            )
        if images:
            content = (content or "Please inspect the attached images.") + "\n\nImages are attached directly to this message."
        if kind not in ("user", "steer", "service", "cancel_job", "stop"):
            raise ValueError(f"unsupported Amplifier input kind: {kind}")
        if not input_id or (kind not in ("stop", "cancel_job") and not content):
            raise ValueError("input id and content required")
        if kind == "service" and (not source or source in ("user", "browser", "system", "developer")):
            raise ValueError("service input requires a distinct non-authorizing source")
        if kind == "steer" and source not in ("user", "browser", "voice"):
            raise ValueError("steer input requires a human source")
        goal = value.get("goal") or ""
        if goal:
            if kind != "user" or self.active or self.session.coordinator.session_state.get("goal"):
                raise ValueError("goal requires a new idle user turn")
            self.session.coordinator.session_state["goal"] = {
                "condition": goal, "turns_used": 0, "cap": None,
            }
        try:
            await self.runtime.submit(Input(kind=kind, text=content,
                                            source=source if kind == "service" else "user", id=input_id,
                                            attachments=tuple(images)))
        except BaseException:
            if goal:
                self.session.coordinator.session_state["goal"] = None
            raise
        if kind == "user":
            self.turn_started = time.monotonic()
            self.first_token_seen = False
        self.active.add(input_id)
        frame(self.id, "input.accepted", inputId=input_id, kind=kind, source=source, text=display_content,
              attachments=[{"id": item["id"], "name": item["name"], "kind": item["kind"]}
                           for item in attachments])
        return {"status": "accepted", "inputId": input_id}

    async def close(self):
        self.closed = True
        if self.task and not self.task.done():
            from amplifier_module_loop_live.runtime import Input
            await self.runtime.submit(Input(kind="stop", target="cancel", id=f"close-{self.id}"))
            try:
                await asyncio.wait_for(self.task, timeout=5)
            except asyncio.TimeoutError:
                self.task.cancel()
                await asyncio.gather(self.task, return_exceptions=True)


async def command(cmd):
    op, sid = cmd.get("op"), cmd.get("sessionId")
    if op == "capabilities": return {"capabilities": CAPS}
    if op in ("start", "resume"):
        if cmd.get("harness") != "amplifier": raise ValueError("unsupported harness")
        if cmd.get("approval") != "never":
            raise ValueError("Invalid chat approval policy")
        previous = SDK_CHAT_SESSIONS.get(sid)
        if previous and previous.closed and previous.task and previous.task.done():
            del SDK_CHAT_SESSIONS[sid]
        if sid not in SDK_CHAT_SESSIONS:
            cwd = cmd.get("cwd")
            if not cwd or not Path(cwd).is_dir(): raise ValueError("Amplifier project folder unavailable")
            session = SDKChatSession(sid, cwd, cmd.get("bundle") or "anchors", cmd.get("provider") or "",
                                     cmd.get("model") or "", cmd.get("effort") or "", cmd.get("mode") or "")
            await session.build()
            SDK_CHAT_SESSIONS[sid] = session
        return {"sessionId": sid, "capabilities": CAPS}
    session = SDK_CHAT_SESSIONS.get(sid)
    if session is None: raise ValueError("Amplifier session is not resident; resume it first")
    if op == "title":
        from amplifier_foundation.session.metadata import SessionMetadataStore
        metadata_store = SessionMetadataStore(session.store.base_dir / sid)
        metadata = metadata_store.read()
        mode = cmd.get("mode")
        if mode in ("manual", "generated"):
            name = cmd.get("name")
            metadata = metadata_store.set_name(name, source=mode)
        return {"name": metadata.get("name", ""), "source": metadata.get("name_source", "")}
    if op == "settings":
        active_name = session.model.split("/", 1)[0]
        active_provider = session.provider or next(
            (name for name in session.available_providers if name == active_name or name.endswith("-" + active_name)),
            active_name)
        provider = next(iter((session.session.coordinator.get("providers") or {}).values()), None)
        active_model = session.model.split("/", 1)[-1]
        rows = self_rows = session.model_rows
        if self_rows is None:
            rows = []
        if provider is not None and self_rows is None:
            try:
                listed = await asyncio.wait_for(provider.list_models(), timeout=12)
                for item in listed:
                    capabilities = set(getattr(item, "capabilities", ()) or ())
                    if "tools" not in capabilities or "streaming" not in capabilities:
                        continue
                    model_id = str(item.id)
                    efforts = []
                    if hasattr(provider, "_get_capabilities"):
                        caps = provider._get_capabilities(model_id)
                        if getattr(caps, "supports_output_config", False):
                            efforts = list(getattr(caps, "supported_efforts", ()))
                    if not efforts:
                        efforts = list(getattr(item, "supported_efforts", ()) or ())
                    rows.append({"id": model_id, "label": str(item.display_name), "efforts": efforts})
            except Exception:
                pass
            session.model_rows = rows
        if not any(row["id"] == active_model for row in rows):
            rows.insert(0, {"id": active_model, "label": active_model, "efforts": []})
        return {"bundle": session.bundle, "provider": active_provider,
                "model": active_model, "effort": session.effort, "models": rows,
                "bundles": session.available_bundles, "providers": session.available_providers,
                "mode": session.active_mode(), "modes": session.available_modes()}
    if op == "select":
        if session.active: raise RuntimeError("finish the current Amplifier turn before changing settings")
        bundle = cmd.get("bundle") or session.bundle
        provider = cmd.get("provider") or session.provider
        current = await command({"op": "settings", "sessionId": sid})
        mode = (cmd.get("mode") if "mode" in cmd else current["mode"]) or ""
        switched = bundle != session.bundle or provider != current["provider"]
        model = "" if switched else (cmd.get("model") or current["model"])
        effort = "" if switched else (cmd.get("effort") or "")
        if not switched and model == current["model"] and effort == current["effort"]:
            # A mode is session state, not construction input, so switching only
            # the mode needs no rebuild -- the conversation survives intact.
            if mode != current["mode"]:
                await session.apply_mode(mode)
                return await command({"op": "settings", "sessionId": sid})
            return current
        if not switched:
            selected = next((row for row in current["models"] if row["id"] == model), None)
            if selected is None or (effort and effort not in selected["efforts"]):
                raise ValueError("unsupported model or effort for the active Amplifier provider")
        replacement = SDKChatSession(sid, session.cwd, bundle, provider, model, effort, mode)
        try:
            await replacement.build()
        except BaseException:
            if replacement.task:
                await replacement.close()
            raise
        await session.close()
        SDK_CHAT_SESSIONS[sid] = replacement
        return await command({"op": "settings", "sessionId": sid})
    if op == "send":
        value = cmd.get("input") or {}
        if value.get("kind") == "steer" and session.active:
            session.steering = session.cancel_requested = True
            await session.close()
            if session.finish_task: await session.finish_task
            replacement = SDKChatSession(sid, session.cwd, session.bundle, session.provider,
                                         session.selected_model, session.effort, session.mode)
            try:
                await replacement.build()
            except BaseException as exc:
                frame(sid, "error", message=f"Amplifier steering could not resume: {exc}")
                raise
            SDK_CHAT_SESSIONS[sid] = replacement
            return await replacement.send(value)
        return await session.send(value)
    if op == "interrupt":
        if not session.active: raise ValueError("No active Amplifier turn to stop")
        stopped_ids = list(session.active)
        session.cancel_requested = True
        await session.close()
        frame(sid, "turn.cancelled", inputIds=stopped_ids, message="Stopped by user")
        session.active.clear()
        return {"status": "accepted"}
    if op == "events": return {"status": "streaming"}
    if op == "close":
        await session.close(); del SDK_CHAT_SESSIONS[sid]; return {"status": "closed"}
    raise ValueError(f"unknown operation: {op}")


def ensure_loop_live_dependency() -> str:
    """Prepare the selected Amplifier interpreter for every normal sidecar boot."""
    package = "amplifier-module-loop-live"
    requirements = Path(__file__).resolve().parent / "loop-live-requirements.txt"
    if not requirements.is_file():
        raise RuntimeError(f"{package}: missing embedded requirements file {requirements}")
    pinned_commit = requirements.read_text().strip().rsplit("@", 1)[-1]
    try:
        installed = importlib.metadata.distribution(package)
        direct_url = installed.read_text("direct_url.json") or "{}"
        installed_commit = json.loads(direct_url).get("vcs_info", {}).get("commit_id", "")
        if installed_commit == pinned_commit:
            timing("process.loop_live_installed_cache_hit")
            return installed_commit
    except (importlib.metadata.PackageNotFoundError, ValueError, TypeError):
        pass
    uv = shutil.which("uv")
    command = ([uv, "pip", "install", "--python", sys.executable, "-r", str(requirements)]
               if uv else [sys.executable, "-m", "pip", "install", "-r", str(requirements)])
    logger.info("installing %s into %s", package, sys.executable)
    install_start = time.monotonic()
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    timing("process.loop_live_install", install_start)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise RuntimeError(f"failed to install {package} into {sys.executable}: {detail}")
    try:
        dist = importlib.metadata.distribution(package)
    except importlib.metadata.PackageNotFoundError as exc:
        raise RuntimeError(f"installed {package} but it is unavailable in {sys.executable}") from exc
    # Foundation imports this source from its managed cache during session
    # creation. Importing it here from site-packages would poison sys.modules
    # and cause Foundation's source validation to reject its own cache path.
    direct_url = dist.read_text("direct_url.json")
    if direct_url:
        try:
            sha = json.loads(direct_url).get("vcs_info", {}).get("commit_id", "")
        except (TypeError, ValueError):
            sha = ""
        if sha:
            logger.info("%s installed commit %s", package, sha)
            return sha
    logger.info("%s installed (commit metadata unavailable)", package)
    return ""


def parse_args(argv: list) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="amplifier-chat-sidecar")
    p.add_argument("--session-id", required=True)
    p.add_argument("--cwd", default=None)
    p.add_argument("--log-level", default="info", choices=["debug", "info", "warning", "error", "critical"])
    return p.parse_args(argv)


async def run(args: argparse.Namespace, proto: Proto) -> int:
    global SDK_CHAT_PROTO
    SDK_CHAT_PROTO = proto
    ensure_loop_live_dependency()
    proto.emit(ev="ready", session_id=args.session_id, bundle="sdk-only", tools=0,
               muxterm_tools=0, boot_ms=int((time.monotonic() - _BOOT_T0) * 1000),
               resumed=False, loop_live=True)
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()
    stopping = False

    def pump() -> None:
        while True:
            try:
                line = sys.stdin.readline()
            except Exception:
                line = ""
            loop.call_soon_threadsafe(queue.put_nowait, line or None)
            if not line:
                return

    def stop() -> None:
        nonlocal stopping
        stopping = True
        queue.put_nowait(None)

    threading.Thread(target=pump, name="amplifier-chat-stdin", daemon=True).start()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, stop)
        except (NotImplementedError, RuntimeError):
            pass
    while not stopping:
        line = await queue.get()
        if line is None:
            break
        try:
            msg = json.loads(line)
            if not isinstance(msg, dict):
                raise ValueError("expected a JSON object")
            op = msg.get("op")
            if op == "sdk":
                try:
                    result = await command(msg.get("command") or {})
                    proto.emit(ev="sdk_reply", req_id=msg.get("req_id"), result=result)
                except Exception as exc:
                    proto.emit(ev="error", req_id=msg.get("req_id"), code="sdk_failed",
                               message=str(exc), fatal=False)
            elif op == "ping":
                proto.emit(ev="pong")
            elif op == "shutdown":
                stopping = True
            else:
                proto.emit(ev="error", code="unknown_op", message=f"unknown op {op!r}", fatal=False)
        except (ValueError, TypeError) as exc:
            proto.emit(ev="error", code="bad_json", message=str(exc), fatal=False)
    for chat in list(SDK_CHAT_SESSIONS.values()):
        try:
            await chat.close()
        except Exception:
            logger.warning("SDK chat shutdown failed", exc_info=True)
    return 0


def main(argv=None) -> int:
    try:
        args = parse_args(sys.argv[1:] if argv is None else argv)
    except SystemExit as exc:
        if exc.code not in (0, None):
            _PROTO_STREAM.write(json.dumps({"ev": "error", "code": "init_failed",
                                            "message": "invalid arguments", "fatal": True}) + "\n")
            _PROTO_STREAM.flush()
        raise
    logging.basicConfig(stream=sys.stderr, level=getattr(logging, args.log_level.upper()),
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    if args.cwd:
        os.chdir(args.cwd)
    proto = Proto(_PROTO_STREAM)
    try:
        return asyncio.run(run(args, proto))
    except BaseException as exc:
        logger.exception("Amplifier sidecar failed")
        proto.emit(ev="error", code="fatal", message=f"{type(exc).__name__}: {exc}", fatal=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
