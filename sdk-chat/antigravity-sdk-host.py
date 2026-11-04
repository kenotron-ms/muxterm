"""JSON-line bridge from muxterm's Node sidecar to the Antigravity Python SDK."""

import asyncio
import json
import os
import sys
from pathlib import Path

from google.antigravity import Agent, LocalAgentConfig, hooks, types
from google.antigravity.hooks import policy


def output(value):
    sys.stdout.write(json.dumps(value, default=str, separators=(",", ":")) + "\n")
    sys.stdout.flush()


class Bridge:
    def __init__(self):
        self.agent = None
        self.response = None
        self.active = None
        self.busy = False
        self.steering = False
        self.stopping = False
        self.input_ids = []
        self.pending_tools = {}
        self.lock = asyncio.Lock()

    def event(self, event_type, **fields):
        output({"event": event_type, "payload": fields})

    async def start(self, command):
        cwd = command["cwd"]
        os.chdir(cwd)
        data_home = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share"))
        save_dir = data_home / "muxterm/sdk-chat/antigravity-sdk" / command["sessionId"]
        save_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        servers = [types.McpStdioServer(
            name=item["name"], command=item["command"], args=item["args"],
            env={entry["name"]: entry["value"] for entry in item["env"]},
        ) for item in command.get("servers", [])]

        @hooks.post_tool_call
        async def completed(result: types.ToolResult):
            name = str(result.name)
            pending = self.pending_tools.get(name, [])
            tool_id = pending.pop(0) if pending else result.id or result.step_id
            self.event("tool.completed", toolId=tool_id, name=name, raw=result.result,
                       failed=bool(result.error))

        config = LocalAgentConfig(
            workspaces=[cwd, *command.get("sourceFolders", [])],
            save_dir=str(save_dir),
            conversation_id=command.get("nativeId") or None,
            session_continuation_mode=(types.SessionContinuationMode.RESUME
                                       if command.get("nativeId") else None),
            mcp_servers=servers, policies=[policy.allow_all()], hooks=[completed],
            app_data_dir=str(data_home / "muxterm/sdk-chat/antigravity-sdk-app"),
        )
        self.agent = Agent(config)
        await self.agent.__aenter__()
        return {"nativeId": self.agent.conversation_id}

    @staticmethod
    def content(command):
        text = command.get("content") or "Please inspect the attached files."
        attachments = command.get("attachments", [])
        if attachments:
            text += "\n\nAttached files (absolute paths):\n" + "\n".join(
                "- " + item["path"] for item in attachments)
        images = [types.Image.from_file(item["path"]) for item in attachments
                  if item.get("kind") == "image" and item.get("contentType") in
                  ("image/png", "image/jpeg", "image/webp", "image/gif")]
        return [text, *images] if images else text

    async def consume(self, response):
        try:
            async for chunk in response.chunks:
                if isinstance(chunk, types.Text) and chunk.text:
                    self.event("assistant.delta", text=chunk.text)
                elif isinstance(chunk, types.ToolCall):
                    name = str(chunk.name)
                    tool_id = chunk.step_id or chunk.id
                    self.pending_tools.setdefault(name, []).append(tool_id)
                    self.event("tool.started", toolId=tool_id, name=name,
                               raw=chunk.args)
            if not self.steering and not self.stopping:
                self.busy = False
                self.event("turn.completed", inputIds=self.input_ids)
        except types.AntigravityCancelledError:
            if not self.steering:
                self.busy = False
                self.event("turn.cancelled", inputIds=self.input_ids)
        except Exception as error:
            self.busy = False
            self.event("error", inputIds=self.input_ids, message=str(error))
        finally:
            if self.active is asyncio.current_task():
                self.active = None

    async def send(self, command):
        async with self.lock:
            if self.busy:
                raise ValueError("Antigravity SDK turn already active")
            content = self.content(command)
            response = await self.agent.chat(content)
            self.response = response
            self.busy = True
            self.stopping = False
            self.input_ids = [command["inputId"]]
            self.event("turn.started")
            self.event("input.accepted", inputId=command["inputId"], kind="user",
                       source=command.get("source", "browser"), text=command.get("displayContent") or command.get("content", ""),
                       attachments=[{key: item[key] for key in ("id", "name", "kind") if key in item}
                                    for item in command.get("attachments", [])])
            self.active = asyncio.create_task(self.consume(response))
            return {"status": "accepted", "inputId": command["inputId"]}

    async def steer(self, command):
        async with self.lock:
            if not self.busy or not self.active:
                raise ValueError("No Antigravity SDK turn available to steer")
            content = self.content(command)
            self.steering = True
            try:
                active = self.active
                await self.response.cancel()
                await active
                if not self.busy:
                    raise RuntimeError("Antigravity turn failed while steering")
                response = await self.agent.chat(content)
                self.response = response
                self.input_ids.append(command["inputId"])
                self.event("input.accepted", inputId=command["inputId"], kind="steer",
                           source=command.get("source", "browser"), text=command.get("displayContent") or command.get("content", ""),
                           attachments=[{key: item[key] for key in ("id", "name", "kind") if key in item}
                                        for item in command.get("attachments", [])])
                self.event("turn.continued", inputIds=self.input_ids)
                self.active = asyncio.create_task(self.consume(response))
                return {"status": "accepted", "inputId": command["inputId"]}
            except Exception:
                if self.busy:
                    self.busy = False
                    self.event("session.uncertain", inputIds=self.input_ids,
                               message="Antigravity SDK could not continue the stopped turn")
                raise
            finally:
                self.steering = False

    async def interrupt(self):
        async with self.lock:
            if not self.busy or not self.active:
                raise ValueError("No active Antigravity SDK turn to stop")
            self.stopping = True
            active = self.active
            await self.response.cancel()
            await active
            if self.busy:
                self.busy = False
                self.event("turn.cancelled", inputIds=self.input_ids)
            self.stopping = False
            return {"status": "accepted"}

    async def close(self):
        if self.active and self.busy:
            active = self.active
            await self.response.cancel()
            await active
        if self.agent:
            await self.agent.__aexit__(None, None, None)
        return {"status": "closed"}

    async def dispatch(self, command):
        request_id = command.get("requestId")
        try:
            op = command.get("op")
            if op == "start":
                value = await self.start(command)
            elif op == "send":
                value = await self.send(command)
            elif op == "steer":
                value = await self.steer(command)
            elif op == "interrupt":
                value = await self.interrupt()
            elif op == "close":
                value = await self.close()
            else:
                raise ValueError("Unsupported Antigravity SDK operation")
            output({"reply": request_id, "value": value})
        except Exception as error:
            output({"reply": request_id, "error": str(error)})


async def main():
    bridge = Bridge()
    pending = set()
    while line := await asyncio.to_thread(sys.stdin.readline):
        command = json.loads(line)
        task = asyncio.create_task(bridge.dispatch(command))
        pending.add(task)
        task.add_done_callback(pending.discard)
        if command.get("op") == "close":
            await task
            break
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)


if __name__ == "__main__":
    asyncio.run(main())
