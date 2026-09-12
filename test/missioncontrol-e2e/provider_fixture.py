#!/usr/bin/env python3
"""Deterministic local OpenAI Responses API fixture for Mission Control E2E.

Run this only beside a prepared disposable server whose provider URL points at
this fixture.  It uses the actual request's advertised tools and conversation;
it does not emulate a sidecar or inject browser state.
"""

from __future__ import annotations

import argparse
import json
import threading
import time
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


def write_records(path: Path, records: list[dict[str, Any]]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(records, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def text_fragments(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [part for item in value for part in text_fragments(item)]
    if isinstance(value, dict):
        return [
            part
            for key, item in value.items()
            if key in {"text", "content", "input", "instructions"}
            for part in text_fragments(item)
        ]
    return []


def has_function_output(value: Any) -> bool:
    if isinstance(value, list):
        return any(has_function_output(item) for item in value)
    if isinstance(value, dict):
        return value.get("type") == "function_call_output" or any(
            has_function_output(item) for item in value.values()
        )
    return False


def latest_user_input(body: dict[str, Any]) -> list[Any]:
    inputs = body.get("input", [])
    if not isinstance(inputs, list):
        return []
    indexes = [
        index
        for index, item in enumerate(inputs)
        if isinstance(item, dict)
        and item.get("role") == "user"
        and not "\n".join(text_fragments(item)).startswith(
            '<system-reminder source="context-compaction">'
        )
    ]
    return inputs[indexes[-1] :] if indexes else inputs


def offered_function(body: dict[str, Any], name: str) -> dict[str, Any] | None:
    tools = body.get("tools", [])
    if not isinstance(tools, list):
        return None
    return next(
        (
            item
            for item in tools
            if isinstance(item, dict)
            and item.get("type") == "function"
            and item.get("name") == name
        ),
        None,
    )


def accepts(schema: Any, value: Any) -> bool:
    """Validate the small JSON Schema subset needed for fixture calls."""
    if not isinstance(schema, dict):
        return False
    if "enum" in schema and value not in schema["enum"]:
        return False
    kind = schema.get("type")
    if kind == "object":
        if not isinstance(value, dict):
            return False
        properties = schema.get("properties", {})
        if not isinstance(properties, dict):
            return False
        if any(key not in value for key in schema.get("required", [])):
            return False
        if schema.get("additionalProperties") is False and any(key not in properties for key in value):
            return False
        return all(key not in properties or accepts(properties[key], item) for key, item in value.items())
    if kind == "array":
        return isinstance(value, list) and all(accepts(schema.get("items", {}), item) for item in value)
    if kind == "string":
        return isinstance(value, str) and len(value) <= schema.get("maxLength", len(value))
    if kind == "boolean":
        return isinstance(value, bool)
    if kind == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    return kind is None


def requested_call(body: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
    current = latest_user_input(body)
    prompt = "\n".join(text_fragments(current))
    if has_function_output(current):
        return None
    if "FIXTURE_TODO_CALL" in prompt:
        name, arguments = "todo", {
            "action": "create",
            "todos": [{"content": "Fixture todo", "activeForm": "Recording fixture todo", "status": "in_progress"}],
        }
    elif "FIXTURE_GOAL_CALL" in prompt:
        name, arguments = "thread_goal", {
            "action": "set",
            "goal": "Fixture goal is scoped and non-autonomous",
        }
    else:
        return None
    descriptor = offered_function(body, name)
    if descriptor is None or not accepts(descriptor.get("parameters"), arguments):
        raise ValueError(f"requested {name} was not advertised with an accepting schema")
    return name, arguments


def response(response_id: str, model: str, output: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "id": response_id,
        "object": "response",
        "created_at": int(time.time()),
        "completed_at": int(time.time()),
        "status": "completed",
        "error": None,
        "incomplete_details": None,
        "model": model,
        "output": output,
        "parallel_tool_calls": False,
        "store": False,
        "usage": {
            "input_tokens": 17,
            "input_tokens_details": {"cached_tokens": 0},
            "output_tokens": 11,
            "output_tokens_details": {"reasoning_tokens": 0},
            "total_tokens": 28,
        },
    }


class Fixture:
    def __init__(self, records_path: Path, barrier_dir: Path | None) -> None:
        self.lock = threading.Lock()
        self.records_path = records_path
        self.records: list[dict[str, Any]] = []
        self.barrier_dir = barrier_dir
        self.records_path.parent.mkdir(parents=True, exist_ok=True)
        write_records(self.records_path, self.records)

    def wait_for_barrier(self, body: dict[str, Any]) -> None:
        """Block only an explicit test turn until its external release file exists."""
        prompt = "\n".join(text_fragments(latest_user_input(body)))
        marker = next((part for part in prompt.split() if part.startswith("FIXTURE_LATE_TURN=")), "")
        token = marker.removeprefix("FIXTURE_LATE_TURN=")
        if not token:
            return
        if self.barrier_dir is None or not token.isascii() or not token.replace("-", "").isalnum():
            raise ValueError("late turn requires configured safe barrier directory")
        self.barrier_dir.mkdir(parents=True, exist_ok=True)
        ready = self.barrier_dir / f"{token}.ready"
        release = self.barrier_dir / f"{token}.release"
        ready.write_text("ready\n", encoding="ascii")
        deadline = time.monotonic() + 60
        while not release.exists():
            if time.monotonic() >= deadline:
                raise ValueError("late turn barrier timed out")
            time.sleep(0.02)

    def record(self, value: dict[str, Any]) -> None:
        with self.lock:
            self.records.append(value)
            write_records(self.records_path, self.records)


class Handler(BaseHTTPRequestHandler):
    server_version = "MissionControlProviderFixture/1"

    @property
    def fixture(self) -> Fixture:
        return self.server.fixture  # type: ignore[attr-defined]

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def send_json(self, status: int, value: Any) -> None:
        encoded = json.dumps(value).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def send_sse(self, value: dict[str, Any]) -> None:
        item = value["output"][0]
        events: list[tuple[str, dict[str, Any]]] = [
            ("response.created", {"type": "response.created", "response": value}),
            ("response.in_progress", {"type": "response.in_progress", "response": value}),
        ]
        if item["type"] == "function_call":
            partial = {**item, "status": "in_progress", "arguments": ""}
            events.extend([
                ("response.output_item.added", {"type": "response.output_item.added", "output_index": 0, "item": partial}),
                ("response.function_call_arguments.delta", {"type": "response.function_call_arguments.delta", "response_id": value["id"], "item_id": item["id"], "output_index": 0, "delta": item["arguments"]}),
                ("response.function_call_arguments.done", {"type": "response.function_call_arguments.done", "response_id": value["id"], "item_id": item["id"], "output_index": 0, "arguments": item["arguments"]}),
                ("response.output_item.done", {"type": "response.output_item.done", "output_index": 0, "item": item}),
            ])
        else:
            content = item["content"][0]
            partial = {**item, "status": "in_progress", "content": []}
            events.extend([
                ("response.output_item.added", {"type": "response.output_item.added", "output_index": 0, "item": partial}),
                ("response.content_part.added", {"type": "response.content_part.added", "output_index": 0, "item_id": item["id"], "content_index": 0, "part": {**content, "text": ""}}),
                ("response.output_text.delta", {"type": "response.output_text.delta", "output_index": 0, "item_id": item["id"], "content_index": 0, "delta": content["text"]}),
                ("response.output_text.done", {"type": "response.output_text.done", "output_index": 0, "item_id": item["id"], "content_index": 0, "text": content["text"]}),
                ("response.content_part.done", {"type": "response.content_part.done", "output_index": 0, "item_id": item["id"], "content_index": 0, "part": content}),
                ("response.output_item.done", {"type": "response.output_item.done", "output_index": 0, "item": item}),
            ])
        events.append(("response.completed", {"type": "response.completed", "response": value}))
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        for event, data in events:
            self.wfile.write(f"event: {event}\ndata: {json.dumps(data)}\n\n".encode("utf-8"))
            self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/healthz":
            self.send_json(HTTPStatus.OK, {"ok": True})
        elif self.path == "/v1/models":
            self.send_json(HTTPStatus.OK, {"object": "list", "data": [{"id": "fixture-model", "object": "model"}]})
        else:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": {"message": "fixture endpoint not found"}})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/v1/responses":
            self.send_json(HTTPStatus.NOT_FOUND, {"error": {"message": "fixture endpoint not found"}})
            return
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))))
        except (ValueError, json.JSONDecodeError) as error:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": {"message": f"invalid JSON: {error}"}})
            return
        if not isinstance(body, dict):
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": {"message": "request must be an object"}})
            return
        try:
            call = requested_call(body)
        except ValueError as error:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": {"message": str(error)}})
            return
        response_id = "resp_fixture_" + uuid.uuid4().hex[:16]
        if call:
            name, arguments = call
            output = [{
                "id": "fc_" + response_id,
                "type": "function_call",
                "status": "completed",
                "call_id": "call_fixture_" + uuid.uuid4().hex[:16],
                "name": name,
                "arguments": json.dumps(arguments, separators=(",", ":")),
            }]
        else:
            full_text = "\n".join(text_fragments(body.get("input", [])))
            seen = [marker for marker in ("FIXTURE_CANARY_A", "FIXTURE_CANARY_B") if marker in full_text]
            output = [{
                "id": "msg_" + response_id,
                "type": "message",
                "status": "completed",
                "role": "assistant",
                "content": [{
                    "type": "output_text",
                    "text": "FIXTURE_PROVIDER_RESPONSE scope=" + (",".join(seen) if seen else "none"),
                    "annotations": [],
                }],
            }]
        value = response(response_id, str(body.get("model", "fixture-model")), output)
        self.fixture.record({"method": "POST", "path": self.path, "request": body, "response": value})
        try:
            # Record the accepted request before exposing the test-only barrier:
            # the harness can prove the held request reached this provider.
            self.fixture.wait_for_barrier(body)
        except ValueError as error:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": {"message": str(error)}})
            return
        if body.get("stream") is True or "text/event-stream" in self.headers.get("accept", ""):
            self.send_sse(value)
        else:
            self.send_json(HTTPStatus.OK, value)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--records", required=True, type=Path)
    parser.add_argument("--barrier-dir", type=Path, help="private directory for explicit FIXTURE_LATE_TURN release files")
    args = parser.parse_args()
    if args.host not in {"127.0.0.1", "::1", "localhost"}:
        parser.error("--host must be a loopback address")
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.fixture = Fixture(args.records, args.barrier_dir)  # type: ignore[attr-defined]
    print(json.dumps({"event": "listening", "port": args.port}), flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())