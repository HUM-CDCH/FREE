"""Counting a request's input tokens with the served model's own tokenizer, before the request is sent (design §8).

Character or byte counts are not an enforceable budget. The endpoint that will serve the calls counts them itself:
vLLM's `/tokenize` renders a chat request through the served model's chat template and tokenizer and returns the
count, with the context the server serves (`max_model_len`). The body counted is the chat adapter's own
`tokenize_body`, so every template switch the real call sends (thinking off, a NuExtract template) is in the count.
An endpoint without `/tokenize` refuses the grounded Catalog path before a single extraction call. Every call's
server-reported prompt count is compared with the count afterwards; a mismatch is reported.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

import requests

SOURCE = "vllm:/tokenize"


class BudgetUnavailable(Exception):
    """No verified way to count this endpoint's requests; the grounded path refuses before any extraction call."""


class Http(Protocol):
    def post(self, url: str, json: dict, timeout: float, **kwargs) -> Any: ...


class Countable(Protocol):
    """What a counter needs of a chat adapter."""
    url: str
    model: str
    headers: dict

    def tokenize_body(self, *, system: str, user: str, schema: dict | None = None) -> dict: ...


@dataclass
class TokenCounter:
    source: str
    model: str
    context_tokens: int | None
    _chat: Any = field(default=None, repr=False)
    _http: Any = field(default=None, repr=False)
    _base: str = ""
    probes: list[dict] = field(default_factory=list)  # calibration requests sent to the model: none on /tokenize

    def request_tokens(self, system: str, user: str, schema: dict | None = None) -> int:
        """The input tokens of one system+user request as the server will count them."""
        return self._post(self._chat.tokenize_body(system=system, user=user, schema=schema))["count"]

    def identity(self) -> dict:
        return {"source": self.source, "model": self.model, "model_digest": None, "template_tokens": None}

    def _post(self, body: dict) -> dict:
        headers = getattr(self._chat, "headers", None)
        response = self._http.post(f"{self._base}/tokenize", json=body, timeout=60,
                                   **({"headers": headers} if headers else {}))
        response.raise_for_status()
        return response.json()


def counter_for(chat: Countable, *, http: Http = requests) -> TokenCounter:
    """The counter of the endpoint `chat` sends to, with the context that endpoint serves now."""
    base = chat.url.split("/v1/", 1)[0].rstrip("/")
    counter = TokenCounter(SOURCE, chat.model, None, _chat=chat, _http=http, _base=base)
    try:
        answer = counter._post(chat.tokenize_body(system="S", user="U"))
    except Exception as error:  # any failure here means the budget cannot be enforced
        raise BudgetUnavailable(f"no /tokenize route counted a request for {chat.model!r} at {base}: {error}") from error
    if "count" not in answer:
        raise BudgetUnavailable(f"no /tokenize route counted a request for {chat.model!r} at {base}")
    counter.context_tokens = answer.get("max_model_len")
    return counter
