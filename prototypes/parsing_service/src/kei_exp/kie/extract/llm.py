"""One text-in, JSON-out chat completion against an OpenAI-compatible vLLM server, and how its reply is read.

A call asks for a reply constrained to a JSON schema through `response_format`, with thinking switched off in the
chat template. Only a refusal that positively says structured output is unsupported is asked once more without it
(the prompt's own "return only the JSON object" then has to do); a malformed schema, an overlong input or any other
refusal surfaces unchanged. The refused attempt is kept on the reply, so the artifact records every call. `finish`
is the server's finish_reason: "length" means the reply was cut off, which the caller treats as a failed call
rather than a short answer. `tokenize_body` is the same request as vLLM's `/tokenize` counts it.
"""
from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass, field
from typing import Any, Protocol

import requests

from kei_exp.files import load_dotenv

load_dotenv()
EXTRACT_URL = os.environ.get("KEI_EXTRACT_URL", "http://127.0.0.1:8002/v1/chat/completions")
EXTRACT_MODEL = os.environ.get("KEI_EXTRACT_MODEL", "Qwen/Qwen3.8-27B-FP8")
EXTRACT_TIMEOUT = float(os.environ.get("KEI_EXTRACT_TIMEOUT", "600"))


class ModelOutputError(ValueError):
    """The model answered, but not with the JSON asked for; the message carries the start of the reply."""


@dataclass(frozen=True)
class Reply:
    text: str
    input_tokens: int | None
    output_tokens: int | None
    finish: str | None
    seconds: float
    attempts: tuple[str, ...] = ()      # refused earlier attempts of this call, each as the server's words


# A refusal that names structured output as unsupported, in the wordings vLLM and OpenAI-compatible proxies
# use; nothing else earns a second attempt without the schema.
UNSUPPORTED = re.compile(r"(?is)(response_format|json_schema|structured output|guided).{0,80}"
                         r"(not supported|unsupported|not implemented)|(not supported|unsupported|does not support|"
                         r"not implemented).{0,80}(response_format|json_schema|structured output|guided)")


# No thinking: under greedy decoding a thinking model (Qwen3.x) can loop in its reasoning until max_tokens and return
# no answer at all. vLLM passes this to the chat template; the Qwen3.x and NuExtract3 templates honour it.
THINKING_OFF = {"enable_thinking": False}


def _messages(system: str, user: str) -> list[dict]:
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


class Chat(Protocol):
    model: str

    def complete(self, *, system: str, user: str, schema: dict | None, max_tokens: int | None = None) -> Reply: ...


@dataclass
class OpenAIChat:
    url: str = EXTRACT_URL
    model: str = EXTRACT_MODEL
    timeout: float = EXTRACT_TIMEOUT
    headers: dict[str, str] = field(default_factory=dict)
    max_tokens: int = 8192

    def tokenize_body(self, *, system: str, user: str, schema: dict | None = None) -> dict:
        """The body vLLM's /tokenize renders into exactly the prompt `complete` sends (the schema does not enter it)."""
        return {"model": self.model, "add_generation_prompt": True, "messages": _messages(system, user),
                "chat_template_kwargs": dict(THINKING_OFF)}

    def complete(self, *, system: str, user: str, schema: dict | None, max_tokens: int | None = None) -> Reply:
        payload: dict[str, Any] = {
            "model": self.model, "temperature": 0, "max_tokens": max_tokens or self.max_tokens,
            "messages": _messages(system, user), "chat_template_kwargs": dict(THINKING_OFF),
        }
        constrained = {**payload, "response_format": {"type": "json_schema", "json_schema": {
            "name": "reply", "schema": schema, "strict": True}}} if schema is not None else payload
        started = time.monotonic()
        attempts: tuple[str, ...] = ()
        response = requests.post(self.url, json=constrained, headers=self.headers, timeout=self.timeout)
        refusal = getattr(response, "text", "") or ""
        if response.status_code == 400 and schema is not None and UNSUPPORTED.search(refusal):
            attempts = (f"HTTP 400: {refusal[:300]}",)
            response = requests.post(self.url, json=payload, headers=self.headers, timeout=self.timeout)
        response.raise_for_status()
        body = response.json()
        choice = body["choices"][0]
        usage = body.get("usage") or {}
        return Reply(text=choice["message"].get("content") or "", input_tokens=usage.get("prompt_tokens"),
                     output_tokens=usage.get("completion_tokens"), finish=choice.get("finish_reason"),
                     seconds=time.monotonic() - started, attempts=attempts)


_THINK = re.compile(r"<think>.*?</think>", re.DOTALL)
_FENCE = re.compile(r"\A```(?:json)?\s*|\s*```\Z")


def parse_json(text: str) -> Any:
    """The JSON in a reply, without a reasoning block or a code fence around it."""
    cleaned = _FENCE.sub("", _THINK.sub("", text).strip()).strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError as error:
        raise ModelOutputError(f"the model did not return JSON ({error}): {text[:500]!r}") from error
