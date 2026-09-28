#!/usr/bin/env python3
"""Amplifier SDK chat sidecar: versioned NDJSON on a Unix socket.

The CLI app layer resolves the owner's existing bundle, provider and model.
Go owns durable chat records, input receipts, and the normalized event stream.
"""
import asyncio
import json
import os
import signal
import sys
from datetime import datetime, timezone
from pathlib import Path

SOCKET = sys.argv[1]
CLIENTS = set()
SESSIONS = {}
CAPS = dict(approvals=False, transcript_read=True, interrupt=True,
            live_input=True, attributed_service_input=True, native_steering=True)


def frame(session_id, event_type, **data):
    line = json.dumps({"v": 1, "event": {"sessionId": session_id, "type": event_type, **data}}, default=str).encode() + b"\n"
    for client in tuple(CLIENTS):
        if not client.is_closing():
            client.write(line)


class DenyApproval:
    async def request_approval(self, prompt, options, timeout, default):
        denied = next((o for o in options if str(o).lower().startswith(("deny", "no", "reject"))), None)
        if denied is None:
            raise PermissionError("Amplifier approval requires Go authorization")
        return denied


class QuietDisplay:
    nesting_depth = 0
    def show_message(self, message, level="info", source="hook"):
        print(f"[{source}] {message}", file=sys.stderr)
    def push_nesting(self): self.nesting_depth += 1
    def pop_nesting(self): self.nesting_depth = max(0, self.nesting_depth - 1)


class Session:
    def __init__(self, session_id, cwd):
        self.id, self.cwd = session_id, cwd
        self.session = self.runtime = self.task = self.store = None
        self.active = set()
        self.partial = ""
        self.model = ""
        self.closed = False

    async def build(self):
        from amplifier_app_cli.lib.settings import AppSettings
        from amplifier_app_cli.paths import get_bundle_search_paths
        from amplifier_app_cli.runtime.config import expand_env_vars, resolve_bundle_config
        from amplifier_app_cli.session_runner import SessionConfig, _create_bundle_session
        from amplifier_app_cli.session_store import SessionStore
        from rich.console import Console

        settings = AppSettings()
        cfg, prepared = await resolve_bundle_config("anchors", settings, None)
        cfg = expand_env_vars(cfg)
        live = {"module": "loop-live", "source": "git+https://github.com/microsoft/amplifier-module-loop-live@main",
                "config": {"background_tools": [], "background_delegate": False}}
        cfg.setdefault("session", {})["orchestrator"] = live
        prepared.bundle.session["orchestrator"] = dict(live)
        self.store = SessionStore()
        transcript = None
        if self.store.exists(self.id):
            transcript, _ = self.store.load(self.id)
            if not isinstance(transcript, list):
                raise RuntimeError("stored Amplifier transcript is invalid; refusing replay")
        cfg["working_dir"] = self.cwd
        cfg.setdefault("root_session_id", self.id)
        cfg.setdefault("application_host", "muxterm-sdk-chat")
        sc = SessionConfig(config=cfg, search_paths=get_bundle_search_paths(), verbose=False,
                           session_id=self.id, bundle_name="anchors", prepared_bundle=prepared,
                           initial_transcript=transcript)
        devnull = open(os.devnull, "w")
        old_cwd = os.getcwd()
        try:
            os.chdir(self.cwd)
            self.session = await _create_bundle_session(sc, self.id, DenyApproval(), QuietDisplay(),
                                                        Console(quiet=True, file=devnull))
        finally:
            os.chdir(old_cwd)
            devnull.close()
        providers = self.session.coordinator.get("providers") or {}
        self.model = next((f"{name}/{getattr(p, 'model', None) or getattr(p, 'default_model', '')}"
                           for name, p in providers.items()
                           if getattr(p, "model", None) or getattr(p, "default_model", None)), "")
        if not self.model:
            raise RuntimeError("Amplifier AppSettings resolved no provider/model")
        from amplifier_module_loop_live import mount as mount_loop_live
        from amplifier_module_loop_live.runtime import Runtime
        await mount_loop_live(self.session.coordinator, {"background_tools": [], "background_delegate": False})
        self.runtime = Runtime(session_id=self.id, observer=self.observe)
        self.session.coordinator.register_capability("live.runtime", self.runtime)
        if transcript:
            context = self.session.coordinator.get("context")
            if context is None or not hasattr(context, "set_messages"):
                raise RuntimeError("Amplifier context cannot restore transcript")
            await context.set_messages(transcript)
        self.hooks()
        self.task = asyncio.create_task(self.session.execute(""), name=f"amplifier-chat-{self.id}")
        self.task.add_done_callback(self.owner_done)
        frame(self.id, "session.started", nativeId=self.id, capabilities=CAPS, model=self.model)

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
            if data.get("block_type") != "thinking" and data.get("text"):
                frame(self.id, "assistant.delta", text=data["text"])
            return cont
        async def tool_start(event, data):
            frame(self.id, "tool.started", toolId=str(data.get("tool_call_id") or ""),
                  name=str(data.get("tool_name") or "Tool"), raw=data.get("tool_input"))
            return cont
        async def tool_end(event, data):
            frame(self.id, "tool.completed", toolId=str(data.get("tool_call_id") or ""),
                  name=str(data.get("tool_name") or "Tool"))
            return cont
        hooks.register("llm:stream_block_delta", delta, name="sdk-chat-delta")
        hooks.register("tool:pre", tool_start, name="sdk-chat-tool-start")
        hooks.register("tool:post", tool_end, name="sdk-chat-tool-end")
        hooks.register("tool:error", tool_end, name="sdk-chat-tool-error")

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
            asyncio.create_task(self.finish(event))

    async def finish(self, event):
        ids = list(event.get("input_ids") or [])
        persisted = False
        try:
            context = self.session.coordinator.get("context")
            messages = await context.get_messages()
            if messages:
                self.store.save(self.id, messages, {"session_id": self.id,
                    "created": datetime.now(timezone.utc).isoformat(), "bundle": "anchors",
                    "model": self.model, "working_dir": self.cwd})
                persisted = True
        except Exception as exc:
            frame(self.id, "error", message=f"Amplifier transcript persistence failed: {exc}")
        finished = event.get("type") == "generation.finished"
        frame(self.id, "generation.finished" if finished else "error", inputIds=ids,
              generationId=event.get("generation_id"), persisted=persisted,
              message=event.get("error_type", ""))
        if finished:
            frame(self.id, "turn.completed", inputIds=ids, generationId=event.get("generation_id"), persisted=persisted)
        self.active.difference_update(ids)

    async def send(self, value):
        from amplifier_module_loop_live.runtime import Input
        kind, source, input_id = value.get("kind"), value.get("source"), value.get("id")
        content = value.get("content", "")
        if kind not in ("user", "steer", "service", "cancel_job", "stop"):
            raise ValueError(f"unsupported Amplifier input kind: {kind}")
        if not input_id or (kind not in ("stop", "cancel_job") and not content):
            raise ValueError("input id and content required")
        if kind == "service" and (not source or source in ("user", "browser", "system", "developer")):
            raise ValueError("service input requires a distinct non-authorizing source")
        if kind == "steer" and source not in ("user", "browser"):
            raise ValueError("steer input requires a human source")
        await self.runtime.submit(Input(kind=kind, text=content,
                                        source=source if kind == "service" else "user", id=input_id))
        self.active.add(input_id)
        frame(self.id, "input.accepted", inputId=input_id, kind=kind, source=source, text=content)
        return {"status": "accepted", "inputId": input_id}

    async def close(self):
        self.closed = True
        if self.task and not self.task.done():
            from amplifier_module_loop_live.runtime import Input
            await self.runtime.submit(Input(kind="stop", id=f"close-{self.id}"))
            await asyncio.wait_for(self.task, timeout=5)


async def command(cmd):
    op, sid = cmd.get("op"), cmd.get("sessionId")
    if op == "capabilities": return {"capabilities": CAPS}
    if op in ("start", "resume"):
        if cmd.get("harness") != "amplifier": raise ValueError("unsupported harness")
        if sid not in SESSIONS:
            cwd = cmd.get("cwd")
            if not cwd or not Path(cwd).is_dir(): raise ValueError("Amplifier project folder unavailable")
            session = Session(sid, cwd)
            await session.build()
            SESSIONS[sid] = session
        return {"sessionId": sid, "capabilities": CAPS}
    session = SESSIONS.get(sid)
    if session is None: raise ValueError("Amplifier session is not resident; resume it first")
    if op == "send": return await session.send(cmd.get("input") or {})
    if op == "interrupt":
        return await session.send({"kind": "stop", "source": "browser", "id": f"interrupt-{sid}"})
    if op == "events": return {"status": "streaming"}
    if op == "close":
        await session.close(); del SESSIONS[sid]; return {"status": "closed"}
    raise ValueError(f"unknown operation: {op}")


async def client(reader, writer):
    CLIENTS.add(writer)
    try:
        while line := await reader.readline():
            cmd = None
            try:
                cmd = json.loads(line)
                if cmd.get("v") != 1 or not cmd.get("requestId"):
                    raise ValueError("unsupported protocol")
                result = await command(cmd)
                response = {"v": 1, "requestId": cmd["requestId"], "result": result}
            except BaseException as exc:
                response = {"v": 1, "requestId": cmd.get("requestId") if isinstance(cmd, dict) else None,
                            "error": str(exc)}
            writer.write(json.dumps(response).encode() + b"\n")
            await writer.drain()
    finally:
        CLIENTS.discard(writer)
        writer.close()


async def main():
    try: os.unlink(SOCKET)
    except FileNotFoundError: pass
    server = await asyncio.start_unix_server(client, SOCKET)
    os.chmod(SOCKET, 0o600)
    async with server: await server.serve_forever()


if __name__ == "__main__":
    try: asyncio.run(main())
    except KeyboardInterrupt: pass
