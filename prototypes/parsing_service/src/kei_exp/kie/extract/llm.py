"""One text-in, JSON-out chat completion against any OpenAI-compatible server, and how its reply is read.

vLLM and Ollama's `/v1` both take this shape. A call asks for a reply constrained to a JSON schema through
`response_format`, with reasoning off; a server that refuses that (HTTP 400) is asked once more without it, and the prompt's own
"return only the JSON object" has to do. `finish` is the server's finish_reason: "length" means the reply was
cut off, which the caller treats as a failed call rather than a short answer.
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
EXTRACT_URL = os.environ.get("KEI_EXTRACT_URL", "http://127.0.0.1:11434/v1/chat/completions")
EXTRACT_MODEL = os.environ.get("KEI_EXTRACT_MODEL", "qwen3:8b")
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


class Chat(Protocol):
    model: str

    def complete(self, *, system: str, user: str, schema: dict | None) -> Reply: ...


@dataclass
class OpenAIChat:
    url: str = EXTRACT_URL
    model: str = EXTRACT_MODEL
    timeout: float = EXTRACT_TIMEOUT
    headers: dict[str, str] = field(default_factory=dict)
    max_tokens: int = 8192

    def complete(self, *, system: str, user: str, schema: dict | None) -> Reply:
        # No reasoning: under greedy decoding a thinking model (Qwen3) can loop in its reasoning until
        # max_tokens and return no answer at all. Ollama's /v1 honours this field.
        payload: dict[str, Any] = {
            "model": self.model, "temperature": 0, "max_tokens": self.max_tokens, "reasoning_effort": "none",
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        }
        constrained = {**payload, "response_format": {"type": "json_schema", "json_schema": {
            "name": "reply", "schema": schema, "strict": True}}} if schema is not None else payload
        started = time.monotonic()
        response = requests.post(self.url, json=constrained, headers=self.headers, timeout=self.timeout)
        if response.status_code == 400 and schema is not None:  # no structured output here: the prompt asks for JSON
            response = requests.post(self.url, json=payload, headers=self.headers, timeout=self.timeout)
        response.raise_for_status()
        body = response.json()
        choice = body["choices"][0]
        usage = body.get("usage") or {}
        return Reply(text=choice["message"].get("content") or "", input_tokens=usage.get("prompt_tokens"),
                     output_tokens=usage.get("completion_tokens"), finish=choice.get("finish_reason"),
                     seconds=time.monotonic() - started)


_THINK = re.compile(r"<think>.*?</think>", re.DOTALL)
_FENCE = re.compile(r"\A```(?:json)?\s*|\s*```\Z")


def parse_json(text: str) -> Any:
    """The JSON in a reply, without a reasoning block or a code fence around it."""
    cleaned = _FENCE.sub("", _THINK.sub("", text).strip()).strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError as error:
        raise ModelOutputError(f"the model did not return JSON ({error}): {text[:500]!r}") from error
