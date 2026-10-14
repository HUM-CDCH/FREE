"""Counting a request's input tokens with the served model's own tokenizer, before the request is sent (design §8).

Character or byte counts are not an enforceable budget. The endpoint that will serve the calls counts them itself:
vLLM's `/tokenize` renders a chat request through the served model's chat template and tokenizer and returns the
count, with the context the server serves (`max_model_len`). The body counted is the chat adapter's own
`tokenize_body`, so every template switch the real call sends (thinking off, a NuExtract template) is in the count.
An endpoint without `/tokenize` refuses the grounded Catalog path before a single extraction call. Every call's
server-reported prompt count is compared with the count afterwards; a mismatch is reported.
"""
from __future__ import annotations

import hashlib
import json
import threading
from collections import OrderedDict
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Protocol

import requests

if TYPE_CHECKING:
    from kei_exp.kie.extract.models import Router

SOURCE = "vllm:/tokenize"
# Counts already made within one durable extraction attempt (`counting`). A durable planning round replays every earlier
# round's planning, so nearly all its counts repeat. A count is reused only inside the attempt that made it (attempts,
# and so tenants, share nothing), only at the same served tokenizer and template (`_serving`: the endpoint, model,
# request headers, served context and the token ids the server rendered for this round's probe) and only for the
# identical body, in the order it is sent. vLLM reports no tokenizer or template revision, so the probe is a fingerprint
# text (`PROBE_SYSTEM`, `PROBE_USER`: scripts, digits, whitespace, punctuation, JSON) that a changed tokenizer or template
# is very likely to render differently. Outside an attempt, when the server returns no probe token ids or no served
# context, or for a body that is not JSON, every count is sent. A change the fingerprint does not show (a replica behind
# the same URL with another tokenizer) is caught by the served prompt count each call reports: a call whose count
# differs fails and drops its attempt's counts (`forget`). Keys are fixed-size digests, so the cap is in bytes: the
# process keeps at most CACHED_COUNTS counts over all attempts (each under ENTRY_BYTES with its key and entry, so at
# most CACHED_BYTES), the least recently used first out, and at most CACHED_ATTEMPTS attempts; an attempt's counts are
# dropped when it is acknowledged. Planning threads (discovery slices, recipe chunks) do not see the attempt and send
# their counts.
CACHED_BYTES = 16 * 1024 * 1024
ENTRY_BYTES = 256
CACHED_COUNTS = CACHED_BYTES // ENTRY_BYTES
CACHED_ATTEMPTS = 8
_attempts: OrderedDict[str, OrderedDict[bytes, int]] = OrderedDict()
_kept = 0  # counts kept over all attempts
_attempts_lock = threading.Lock()
_attempt: ContextVar[str | None] = ContextVar("counting_attempt", default=None)


@contextmanager
def counting(attempt: str) -> Iterator[None]:
    """Counts made inside are kept for the rest of `attempt`'s planning rounds in this process."""
    token = _attempt.set(attempt)
    try:
        yield
    finally:
        _attempt.reset(token)


def forget(attempt: str) -> None:
    """Drop an attempt's kept counts once it has ended, or once one of them may be stale."""
    global _kept
    with _attempts_lock:
        _kept -= len(_attempts.pop(attempt, ()))


def kept() -> int:
    """How many counts the process keeps now, over all attempts."""
    with _attempts_lock:
        return _kept


def _keep(attempt: str, counted: OrderedDict[bytes, int], key: bytes, count: int) -> None:
    """Keep one count, evicting the least recently used ones over the caps; caller holds the lock."""
    global _kept
    if _attempts.get(attempt) is not counted:  # forgotten (or evicted) while this count was being sent
        return
    _attempts.move_to_end(attempt)
    if key not in counted:
        _kept += 1
    counted[key] = count
    counted.move_to_end(key)
    while len(_attempts) > CACHED_ATTEMPTS:
        _kept -= len(_attempts.popitem(last=False)[1])
    while _kept > CACHED_COUNTS:  # the current attempt is last: older attempts' counts go first
        oldest, entries = next(iter(_attempts.items()))
        if entries:
            entries.popitem(last=False)
            _kept -= 1
        if not entries and oldest != attempt:
            del _attempts[oldest]


def _digest(value: Any) -> bytes:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False).encode()).digest()


# The text of the request that reads the served context, a fingerprint of the served tokenizer and chat template: many
# scripts, digits, whitespace runs, punctuation and JSON, so a changed tokenizer or template renders other token ids.
PROBE_SYSTEM = ("Fingerprint of the served tokenizer and chat template. Words, digits 0123456789 3.14159 -42 1e10 "
                "1,234.56 12/10/2026, punctuation !\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~ tabs\tand  runs   of    spaces"
                "\nnew lines\r\nand\n\nparagraphs.")
PROBE_USER = ("Accents àèéìòù ÀÉÌ ÄÖÜß ñç œæ ø å, Ελληνικά, Русский, 中文字符, 日本語のかなカナ, 한국어, العربية, עברית, "
              "हिन्दी, ไทย, emoji 🙂🚀👍🏽, symbols € £ ¥ © ® ™ ° ± × ÷ → ∑ √ ∞ ≤ ≠. "
              '{"record": [{"id": 1, "name": "Ölmühle", "value": null, "ok": true}]} <tag a="x">text</tag> '
              "```code``` # Heading * item - item")
# The reply schema of the request that reads the served context: a template extractor renders no request without one.
PROBE_SCHEMA = {"type": "object", "properties": {"probe": {"type": ["string", "null"]}}, "required": ["probe"],
                "additionalProperties": False}


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
    _serving: bytes | None = None  # what fixes this endpoint's answers now; None keeps no count
    probes: list[dict] = field(default_factory=list)  # calibration requests sent to the model: none on /tokenize

    def request_tokens(self, system: str, user: str, schema: dict | None = None) -> int:
        """The input tokens of one system+user request as the server will count them."""
        body = self._chat.tokenize_body(system=system, user=user, schema=schema)
        attempt = _attempt.get()
        if attempt is None or self._serving is None:
            return self._post(body)["count"]
        try:  # the body as sent: key order is kept, a template may read it
            key = hashlib.sha256(self._serving + _digest(body)).digest()
        except (TypeError, ValueError):  # not JSON: the request itself will say so
            return self._post(body)["count"]
        with _attempts_lock:
            counted = _attempts.setdefault(attempt, OrderedDict())
            if key in counted:
                _attempts.move_to_end(attempt)
                counted.move_to_end(key)
                return counted[key]
        count = self._post(body)["count"]
        with _attempts_lock:
            _keep(attempt, counted, key, count)
        return count

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
        answer = counter._post(chat.tokenize_body(system=PROBE_SYSTEM, user=PROBE_USER, schema=PROBE_SCHEMA))
    except Exception as error:  # any failure here means the budget cannot be enforced
        raise BudgetUnavailable(f"no /tokenize route counted a request for {chat.model!r} at {base}: {error}") from error
    if "count" not in answer:
        raise BudgetUnavailable(f"no /tokenize route counted a request for {chat.model!r} at {base}")
    counter.context_tokens = answer.get("max_model_len")
    if isinstance(answer.get("tokens"), list) and isinstance(counter.context_tokens, int):
        counter._serving = _digest([base, chat.model, getattr(chat, "headers", None), counter.context_tokens,
                                    answer["tokens"]])
    return counter


def counters_for(chat: Router) -> dict[str, TokenCounter]:
    """The counter of the endpoint each role's calls go to; roles one chat serves share one counter."""
    from kei_exp.kie.extract.gliformer import GLiFormerFields
    counters = {id(client): client.counter() if isinstance(client, GLiFormerFields) else counter_for(client)
                for client in chat.chats().values()}
    return {role: counters[id(client)] for role, client in chat.chats().items()}
