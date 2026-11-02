"""Deployment-owned Claude Code extraction: one isolated, tool-free `claude -p` turn per durable call.

Claude Code, like Codex, exposes usage after inference, not a preflight tokenizer. Planning therefore reserves UTF-8
bytes plus framing overhead, explicitly labelled an upper bound; a reply is accepted only when its reported usage
fits that bound and the reserved output. Tools other than the structured reply, other models, and compaction fail
the call. The complete request and this policy are pinned by the ordinary capture/checkpoint path.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import signal
import subprocess
import tempfile
import threading
import time
from contextlib import suppress
from dataclasses import dataclass

from kei_exp.kie.extract.llm import EXTRACT_TIMEOUT, ModelOutputError, Reply, _plain

# The budget bounds system, source and schema bytes below Linux's 128 KiB limit on one argument, so the CLI's inline
# `--system-prompt` and `--json-schema` (it accepts no schema file) can always carry them.
CONTEXT_TOKENS = 65536
# Measured near 750 tokens for CLI 2.1.263 (its preamble and structured-output tool); the rest absorbs CLI updates.
FRAMING_TOKENS = 4096
POLICY = "claude:utf8-budget-v1"
EFFORT = "low"
URL = "claude://local"
# The CLI supplies its structured reply through this tool; it is the only one offered and the only one accepted.
REPLY_TOOL = "StructuredOutput"
BLOCKS = {"text", "thinking", "redacted_thinking", "tool_use"}
# One turn for the structured reply and one for its acknowledgement; a schema retry exhausts the limit and fails.
ARGUMENTS = ("-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--max-turns", "2",
             "--effort", EFFORT, "--tools", "", "--strict-mcp-config", "--setting-sources", "",
             "--no-session-persistence", "--disable-slash-commands")
# The child gets these from the worker and nothing else: no database credentials, and no host CLI configuration.
INHERITED = ("PATH", "LANG", "LC_ALL", "CLAUDE_CODE_OAUTH_TOKEN",
             "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS")
MODEL_ID = re.compile(r"[a-zA-Z0-9_.:/-]{1,122}")


def _environment(directory: str, max_tokens: int | None = None) -> dict[str, str]:
    # An empty home and configuration directory exclude user settings, memory, hooks and plugins; the deployment
    # credential comes from the environment. Non-essential traffic includes the CLI's own background model calls.
    environment = {name: os.environ[name] for name in INHERITED if os.environ.get(name)}
    environment |= {"HOME": directory, "CLAUDE_CONFIG_DIR": os.path.join(directory, ".claude"),
                    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"}
    if max_tokens is not None:
        environment["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] = str(max_tokens)
    return environment


def _binary() -> str:
    return os.environ.get("KEI_CLAUDE_BINARY", "claude")


def logged_in() -> bool:
    """Whether the deployment credential is configured for the CLI; this starts no model turn."""
    with tempfile.TemporaryDirectory(prefix="free-claude-extract-") as directory:
        answer = subprocess.run([_binary(), "auth", "status", "--json"], cwd=directory, env=_environment(directory),
                                capture_output=True, text=True, encoding="utf-8", timeout=15)
    return answer.returncode == 0 and json.loads(answer.stdout).get("loggedIn") is True


@dataclass
class ClaudeCodeCounter:
    model: str
    context_tokens: int = CONTEXT_TOKENS
    source: str = POLICY
    upper_bound: bool = True

    def request_tokens(self, system: str, user: str, schema: dict | None = None) -> int:
        # The schema enters the model's input as the structured-output tool. Deliberately conservative for
        # multilingual text and never compared for equality with Claude Code's actual usage.
        return FRAMING_TOKENS + len(json.dumps(
            {"system": system, "user": user, "schema": schema}, ensure_ascii=False).encode("utf-8"))

    @property
    def _serving(self) -> bytes:
        # Counts are a pure function of this policy and model: work planned from them stays valid (`tokens.compiled`).
        return hashlib.sha256(json.dumps([self.source, FRAMING_TOKENS, self.context_tokens, self.model]).encode()).digest()

    def identity(self) -> dict:
        return {"source": self.source, "model": self.model, "model_digest": None, "template_tokens": None,
                "input_counting": "upper_bound"}


@dataclass
class ClaudeCodeChat:
    model: str
    url: str = URL
    timeout: float = EXTRACT_TIMEOUT
    max_tokens: int = 8192

    def counter(self) -> ClaudeCodeCounter:
        return ClaudeCodeCounter(self.model)

    def request_body(self, *, system: str, user: str, schema: dict | None, max_tokens: int | None = None) -> dict:
        return {"model": self.model, "system": system, "user": user, "schema": schema,
                "max_tokens": max_tokens or self.max_tokens, "policy": POLICY}

    def complete(self, *, system: str, user: str, schema: dict | None, max_tokens: int | None = None) -> Reply:
        return self.complete_request(self.request_body(system=system, user=user, schema=schema, max_tokens=max_tokens))

    def complete_request(self, payload: dict, on_text=None) -> Reply:
        if payload.get("policy") != POLICY or payload.get("model") != self.model:
            raise ValueError("unsupported captured Claude Code request")
        counted = self.counter().request_tokens(payload["system"], payload["user"], payload["schema"])
        reserve = payload["max_tokens"]
        if type(reserve) is not int or reserve <= 0 or counted + reserve > CONTEXT_TOKENS:
            raise ModelOutputError("Claude Code request exceeds its conservative input/reply budget")
        started = time.monotonic()
        result = self._run(payload, reserve, on_text)
        if result.get("subtype") != "success" or result.get("is_error") is not False \
                or not isinstance(result.get("structured_output"), dict):
            raise ModelOutputError("Claude Code extraction did not complete successfully")
        # The CLI reports each model it called; anything but the selected one received the source without a capture.
        models = result.get("modelUsage")
        if not isinstance(models, dict) or set(models) != {self.model}:
            raise ModelOutputError(f"Claude Code called models {sorted(models or {})}, not only {self.model}")
        window = models[self.model].get("contextWindow")
        usage = result.get("usage") or {}
        # Cached prompt tokens are input too: a long source is reported almost entirely as cache creation.
        parts = [usage.get(name) for name in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")]
        input_tokens = sum(parts) if all(type(part) is int for part in parts) else None
        if (type(window) is not int or window < CONTEXT_TOKENS
                or input_tokens is None or not 0 < input_tokens <= counted):
            raise ModelOutputError(f"Claude Code input/context budget was not verified: input={input_tokens}, "
                                   f"reserved={counted}, context={window}")
        if type(usage.get("output_tokens")) is not int or not 0 <= usage["output_tokens"] <= reserve:
            raise ModelOutputError("Claude Code reply exceeded its reserved output budget")
        return Reply(json.dumps(result["structured_output"], ensure_ascii=False), input_tokens, usage["output_tokens"],
                     "stop", time.monotonic() - started)

    def _run(self, payload: dict, reserve: int, on_text) -> dict:
        """One restricted process in an empty directory; its final result event, once every event was allowed."""
        with tempfile.TemporaryDirectory(prefix="free-claude-extract-") as directory:
            arguments = [_binary(), *ARGUMENTS, "--model", self.model, "--system-prompt", payload["system"],
                         "--json-schema", json.dumps(_plain(payload["schema"]), ensure_ascii=False)]
            process = subprocess.Popen(arguments, cwd=directory, env=_environment(directory, reserve),
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                       text=True, encoding="utf-8", start_new_session=True)
            # The deadline covers the source write too: a child that stops reading would otherwise block past it.
            expired = threading.Event()

            def expire():
                expired.set()
                with suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGKILL)

            watchdog = threading.Timer(self.timeout, expire)
            watchdog.daemon = True
            watchdog.start()
            result = None
            try:
                try:
                    process.stdin.write(payload["user"])
                    process.stdin.close()
                except OSError:
                    pass  # the child ended; its output, or the deadline, says why
                for line in process.stdout:
                    try:
                        event = json.loads(line)
                    except ValueError:
                        raise ModelOutputError("Claude Code wrote an unreadable event") from None
                    result = self._allowed(event, on_text) or result
                process.wait()
                if expired.is_set():
                    raise TimeoutError("Claude Code extraction call timed out")
                if result is None:
                    raise ModelOutputError("Claude Code ended before completing extraction")
                return result
            finally:
                watchdog.cancel()
                watchdog.join()  # never signal the group once it is reaped and its id may be reused
                if process.poll() is None:
                    with suppress(ProcessLookupError):
                        os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    with suppress(ProcessLookupError):
                        os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                with suppress(OSError):  # unsent input after a kill
                    process.stdin.close()
                process.stdout.close()

    def _allowed(self, event: dict, on_text) -> dict | None:
        """Refuse any tool, server tool or compaction, even if a future CLI changes a flag's meaning; return a result."""
        kind = event.get("type")
        if kind == "system" and event.get("subtype") == "init":
            if set(event.get("tools") or ()) - {REPLY_TOOL} or event.get("mcp_servers"):
                raise ModelOutputError("Claude Code offered tools during tool-free extraction")
        if kind == "system" and event.get("subtype") == "compact_boundary":
            raise ModelOutputError("Claude Code compacted the extraction source")
        if kind == "assistant":
            for block in event["message"]["content"]:
                if block["type"] not in BLOCKS or block["type"] == "tool_use" and block.get("name") != REPLY_TOOL:
                    raise ModelOutputError("Claude Code attempted tools during extraction")
        if kind == "stream_event" and on_text is not None:
            delta = event["event"].get("delta")
            if isinstance(delta, dict) and delta.get("type") == "input_json_delta":
                on_text(delta["partial_json"])
        return event if kind == "result" else None
