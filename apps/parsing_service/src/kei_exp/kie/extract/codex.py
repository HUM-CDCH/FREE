"""Deployment-owned Codex extraction: one isolated, tool-free app-server turn per durable call.

Codex exposes usage after inference, not a preflight tokenizer or a hard reply limit. Planning therefore reserves
UTF-8 bytes plus framing overhead, explicitly labelled an upper bound; a reply is accepted only when its reported
usage fits that bound and the reserved output. Compaction and tool activity fail the call. The complete request
and this policy are pinned by the ordinary capture/checkpoint path, just like HTTP model calls.
"""
from __future__ import annotations

import json
import os
import queue
import signal
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass
from contextlib import contextmanager
import re

from kei_exp.kie.extract.llm import EXTRACT_TIMEOUT, ModelOutputError, Reply, _plain

CONTEXT_TOKENS = 65536
FRAMING_TOKENS = 12288
POLICY = "codex:utf8-budget-v1"
# Keep the same restrictions as Studio's Codex connection. An empty working directory also excludes repository
# instructions and source files; the deployment login is the only host state this adapter needs.
RESTRICTIONS = {
    "mcp_servers": {}, "tools.web_search": False,
    **{f"features.{name}": False for name in (
        "apps", "browser_use", "code_mode_host", "computer_use", "context_management", "image_generation",
        "multi_agent", "shell_snapshot", "shell_tool", "tool_suggest", "unified_exec")},
    "model_auto_compact_token_limit": 1000000000,
}


@contextmanager
def _app_server(timeout):
    """One restricted process for discovery or extraction; close it on every success, timeout or failure."""
    deadline = time.monotonic() + timeout
    with tempfile.TemporaryDirectory(prefix="free-codex-extract-") as directory:
        arguments = [os.environ.get("KEI_CODEX_BINARY", "codex"), "app-server"]
        for key, value in RESTRICTIONS.items():
            arguments += ["-c", f"{key}={json.dumps(value)}"]
        process = subprocess.Popen(arguments, cwd=directory, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, text=True, encoding="utf-8", start_new_session=True)
        incoming = queue.Queue()

        def read_output():
            try:
                for line in process.stdout:
                    incoming.put(json.loads(line))
            except Exception:
                incoming.put(None)
            finally:
                incoming.put(None)

        reader = threading.Thread(target=read_output, daemon=True)
        reader.start()

        def send(identifier, method, params):
            process.stdin.write(json.dumps({"id": identifier, "method": method, "params": params}) + "\n")
            process.stdin.flush()

        def receive():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Codex extraction call timed out")
            try:
                event = incoming.get(timeout=remaining)
            except queue.Empty:
                raise TimeoutError("Codex extraction call timed out") from None
            if event is None:
                raise ModelOutputError("Codex app server ended before completing extraction")
            # Requests from the server ask the client to approve an action. Never approve, execute, or return
            # document content through tools, even if a future CLI changes a feature flag's meaning.
            if "method" in event and "id" in event:
                raise ModelOutputError("Codex requested an action during tool-free extraction")
            if "error" in event:
                raise ModelOutputError("Codex rejected the extraction request")
            return event

        try:
            send(1, "initialize", {"clientInfo": {"name": "free-extraction", "version": "1"}})
            while receive().get("id") != 1:
                pass
            process.stdin.write('{"method":"initialized"}\n'); process.stdin.flush()
            yield directory, send, receive
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            process.stdin.close()
            process.stdout.close()
            reader.join(timeout=1)


MODEL_ID = re.compile(r"[a-zA-Z0-9_.:/-]{1,122}")


def available_models() -> list[str]:
    """Read the deployment login's current catalog, including all pages, without starting a model turn."""
    models, cursors = [], set()
    with _app_server(15) as (_, send, receive):
        cursor = None
        for identifier in range(2, 102):
            send(identifier, "model/list", {"includeHidden": False, "limit": 100, "cursor": cursor})
            while True:
                event = receive()
                if event.get("id") == identifier:
                    break
            result = event.get("result", {})
            entries = result.get("data")
            if not isinstance(entries, list):
                raise ModelOutputError("Codex returned an invalid model catalog")
            for entry in entries:
                model = entry.get("model", entry.get("id"))
                if not entry.get("hidden", False) and isinstance(model, str) and MODEL_ID.fullmatch(model) and model not in models:
                    models.append(model)
            cursor = result.get("nextCursor")
            if cursor is None:
                return models
            if not isinstance(cursor, str) or cursor in cursors:
                raise ModelOutputError("Codex returned an invalid model catalog cursor")
            cursors.add(cursor)
        raise ModelOutputError("Codex model catalog exceeded its page limit")


@dataclass
class CodexCounter:
    model: str
    context_tokens: int = CONTEXT_TOKENS
    source: str = POLICY
    upper_bound: bool = True

    def request_tokens(self, system: str, user: str, schema: dict | None = None) -> int:
        # Count schema bytes too: constrained output instructions can enter the model's input. This is deliberately
        # conservative for multilingual text and is never compared for equality with Codex's actual usage.
        return FRAMING_TOKENS + len(json.dumps(
            {"system": system, "user": user, "schema": schema}, ensure_ascii=False).encode("utf-8"))

    def identity(self) -> dict:
        return {"source": self.source, "model": self.model, "model_digest": None, "template_tokens": None,
                "input_counting": "upper_bound"}


@dataclass
class CodexChat:
    model: str
    url: str = "codex://local"
    timeout: float = EXTRACT_TIMEOUT
    max_tokens: int = 8192

    def counter(self) -> CodexCounter:
        return CodexCounter(self.model)

    def request_body(self, *, system: str, user: str, schema: dict | None, max_tokens: int | None = None) -> dict:
        return {"model": self.model, "system": system, "user": user, "schema": schema,
                "max_tokens": max_tokens or self.max_tokens, "policy": POLICY}

    def complete(self, *, system: str, user: str, schema: dict | None, max_tokens: int | None = None) -> Reply:
        return self.complete_request(self.request_body(system=system, user=user, schema=schema, max_tokens=max_tokens))

    def complete_request(self, payload: dict, on_text=None) -> Reply:
        if payload.get("policy") != POLICY or payload.get("model") != self.model:
            raise ValueError("unsupported captured Codex request")
        counted = self.counter().request_tokens(payload["system"], payload["user"], payload["schema"])
        reserve = payload["max_tokens"]
        if type(reserve) is not int or reserve <= 0 or counted + reserve > CONTEXT_TOKENS:
            raise ModelOutputError("Codex request exceeds its conservative input/reply budget")
        started = time.monotonic()
        with _app_server(self.timeout) as (directory, send, receive):
            send(2, "thread/start", {"model": self.model, "cwd": directory, "ephemeral": True,
                 "approvalPolicy": "never", "sandbox": "read-only", "baseInstructions": payload["system"],
                 "developerInstructions": "Return only the requested JSON. Do not use tools or compact the source.",
                 "config": RESTRICTIONS})
            while True:
                event = receive()
                if event.get("id") == 2:
                    thread = event["result"]["thread"]["id"]
                    break
            send(3, "turn/start", {"threadId": thread,
                 "input": [{"type": "text", "text": payload["user"], "text_elements": []}],
                 "outputSchema": _plain(payload["schema"]), "effort": "low"})
            text, usage, window = None, None, None
            while True:
                event = receive()
                method, params = event.get("method"), event.get("params", {})
                if method == "thread/compacted":
                    raise ModelOutputError("Codex compacted the extraction source")
                if method in ("item/started", "item/completed"):
                    item = params["item"]
                    if item["type"] not in ("userMessage", "agentMessage", "reasoning"):
                        raise ModelOutputError("Codex attempted tools or compaction during extraction")
                    if method == "item/completed" and item["type"] == "agentMessage":
                        text = item["text"]
                if method == "item/agentMessage/delta" and on_text is not None:
                    on_text(params["delta"])
                if method == "thread/tokenUsage/updated":
                    usage = params["tokenUsage"]["total"]
                    window = params["tokenUsage"].get("modelContextWindow")
                if method == "turn/completed":
                    if params["turn"]["status"] != "completed" or text is None:
                        raise ModelOutputError("Codex extraction did not complete successfully")
                    break
            if (not usage or type(window) is not int or window < CONTEXT_TOKENS
                    or type(usage.get("inputTokens")) is not int or not 0 < usage["inputTokens"] <= counted):
                raise ModelOutputError(f"Codex input/context budget was not verified: input={usage.get('inputTokens') if usage else None}, "
                                      f"reserved={counted}, context={window}")
            if type(usage.get("outputTokens")) is not int or not 0 <= usage["outputTokens"] <= reserve:
                raise ModelOutputError("Codex reply exceeded its reserved output budget")
            return Reply(text, usage["inputTokens"], usage["outputTokens"], "stop", time.monotonic() - started)
