"""Model access for experiments: sampling and token probabilities, a content-addressed reply cache, and honest cost.

`kei_exp`'s `OpenAIChat` fixes temperature 0 and keeps no probabilities; the experiment adapter below adds both without
touching it, and refuses (rather than falls back) when the server cannot do provider-native structured output, so a
"schema" variant never quietly runs as a prompt-only one. A cached reply is served whole, marked `replayed`, and counted
apart from real inference: its recorded tokens and seconds are what it cost when it was made, never zero. The cache key
is the complete request (provider identity, model, prompt, schema, output limit, sampling, sample and attempt index), so
no configuration can reuse another's reply, and identical concurrent requests run once.
"""
from __future__ import annotations

import threading
import time
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Any

import requests

from experiments.extraction.manifest import digest, read, write_new
from kei_exp.canonical import canonical_json
from kei_exp.kie.extract.calls import Call, complete
from kei_exp.kie.extract.llm import THINKING_OFF, UNSUPPORTED, OpenAIChat, Reply, _messages, _plain, _reply


class BudgetExceeded(RuntimeError):
    """A case asked for more fresh model calls or tokens than its budget allows; nothing further is sent."""


class OutputConstraintUnsupported(RuntimeError):
    """The server refused provider-native structured output: a schema-constrained variant cannot run on it."""


@dataclass(frozen=True)
class ResearchReply(Reply):
    logprobs: tuple = ()          # the server's per-token records for the reply; empty when not requested or not given
    replayed: bool = False


@dataclass
class ResearchChat(OpenAIChat):
    """An OpenAI-compatible chat whose request carries the experiment's temperature, seed and token probabilities."""
    accepts_sampling = True

    def complete(self, *, system: str, user: str, schema: dict | None, max_tokens: int | None = None,
                 temperature: float = 0.0, seed: int | None = None, top_logprobs: int = 0) -> ResearchReply:
        payload: dict[str, Any] = {"model": self.model, "temperature": temperature,
                                   "max_tokens": max_tokens or self.max_tokens,
                                   "messages": _messages(system, user), "chat_template_kwargs": dict(THINKING_OFF)}
        if seed is not None:
            payload["seed"] = seed
        if top_logprobs:
            payload |= {"logprobs": True, "top_logprobs": top_logprobs}
        if schema is not None:
            payload["response_format"] = {"type": "json_schema", "json_schema": {
                "name": "reply", "schema": _plain(schema), "strict": True}}
        started = time.monotonic()
        response = requests.post(self.url, json=payload, headers=self.headers, timeout=self.timeout)
        refusal = getattr(response, "text", "") or ""
        if response.status_code == 400 and schema is not None and UNSUPPORTED.search(refusal):
            raise OutputConstraintUnsupported(refusal[:300])
        base = _reply(response, started, ())
        given = (response.json()["choices"][0].get("logprobs") or {}).get("content") or []
        return ResearchReply(**asdict(base), logprobs=tuple(given))


class Allowance:
    """The fresh model calls a whole study may still make, shared by every case it runs, so that retries and recovery cannot
    overrun the study's cap. `denied` counts the reservations it refused."""

    def __init__(self, calls: int):
        self.remaining, self.denied, self._lock = calls, 0, threading.Lock()

    def take(self) -> None:
        with self._lock:
            if self.remaining <= 0:
                self.denied += 1
                raise BudgetExceeded("the study's call allowance is spent")
            self.remaining -= 1


class Provider:
    """A chat behind a reply cache. `cache` is a directory (persistent, shared by studies) or None (this process);
    `identity` pins what the model name alone does not (endpoint, served revision, context) and is part of every key."""

    def __init__(self, chat, cache: Path | None = None, counter=None, identity: dict | None = None):
        self.chat, self.cache, self.counter = chat, cache, counter
        self.model = chat.model
        self.identity = identity if identity is not None else {"url": getattr(chat, "url", None)}
        self.allowance: Allowance | None = None
        self._memory: dict[str, ResearchReply] = {}
        self._flights: dict[str, threading.Lock] = {}
        self._guard = threading.Lock()

    def key(self, request: dict) -> str:
        return digest(canonical_json({"identity": self.identity, "model": self.model, "adapter": type(self.chat).__name__,
                                      **request}))

    def flight(self, key: str) -> threading.Lock:
        with self._guard:
            return self._flights.setdefault(key, threading.Lock())

    def lookup(self, key: str) -> ResearchReply | None:
        if key in self._memory:
            return self._memory[key]
        path = self.cache / key[:2] / f"{key}.json" if self.cache else None
        if path is not None and path.exists():
            stored = read(path)["reply"]
            return ResearchReply(**{**stored, "attempts": tuple(stored["attempts"]), "logprobs": tuple(stored["logprobs"])})
        return None

    def store(self, key: str, request: dict, reply: ResearchReply) -> None:
        self._memory[key] = reply
        if self.cache is not None:
            try:
                write_new(self.cache / key[:2] / f"{key}.json", {"request": request, "reply": asdict(reply)})
            except FileExistsError:   # a previous process stored the same complete request
                pass

    def view(self, calls: int, tokens: int | None = None) -> Metered:
        return Metered(self, calls, tokens)


def _side() -> dict:
    return dict.fromkeys(("calls", "input_tokens", "output_tokens", "seconds", "failed", "unknown_usage"), 0)


class Metered:
    """One case's view of a provider: its budgets and its own cost, real and replayed kept apart. One HTTP request is one
    call; a reply without usage is counted as unknown, never as zero tokens."""

    def __init__(self, provider: Provider, calls: int, tokens: int | None = None):
        self.provider, self.limit, self.token_limit = provider, calls, tokens
        self.model, self.counter = provider.model, provider.counter
        self.spent = {"fresh": _side(), "replayed": _side()}
        self.requests: list[str] = []    # the key of every request this view made, replayed or fresh, in order
        self._lock = threading.Lock()

    def _reserve(self) -> None:
        with self._lock:
            fresh = self.spent["fresh"]
            if fresh["calls"] >= self.limit:
                raise BudgetExceeded(f"{self.limit} fresh model calls spent")
            if self.token_limit is not None and fresh["input_tokens"] + fresh["output_tokens"] >= self.token_limit:
                raise BudgetExceeded(f"{self.token_limit} fresh tokens spent")
            if self.provider.allowance is not None:
                self.provider.allowance.take()
            fresh["calls"] += 1     # reserved before the call: a failed call still cost its slot

    def _record(self, reply: ResearchReply | None, seconds: float) -> None:
        with self._lock:
            side = self.spent["replayed" if reply is not None and reply.replayed else "fresh"]
            side["seconds"] = round(side["seconds"] + seconds, 6)
            if reply is None:
                side["failed"] += 1
            else:
                side["calls"] += reply.replayed
                side["input_tokens"] += reply.input_tokens or 0
                side["output_tokens"] += reply.output_tokens or 0
                side["unknown_usage"] += reply.input_tokens is None or reply.output_tokens is None

    def complete(self, *, attempt: int = 0, sample: int = 0, **request) -> ResearchReply:
        provider = self.provider
        request = {**request, "attempt": attempt, "sample": sample}
        key = provider.key(request)
        with self._lock:
            self.requests.append(key)
        with provider.flight(key):
            hit = provider.lookup(key)
            if hit is not None:
                reply = replace(hit, replayed=True)
                self._record(reply, reply.seconds)
                return reply
            self._reserve()
            started = time.monotonic()
            try:
                reply = provider.chat.complete(**{k: v for k, v in request.items() if k not in ("attempt", "sample")})
            except BaseException:
                self._record(None, time.monotonic() - started)
                raise
            if not isinstance(reply, ResearchReply):
                reply = ResearchReply(**asdict(reply))
            provider.store(key, request, reply)
            self._record(reply, reply.seconds)
            return reply


def ask(meter: Metered, *, stage: str, system: str, user: str, schema: dict | None, max_tokens: int,
        attempt: int = 0, sample: int = 0, **sampling) -> tuple[Any, list[Call], ResearchReply | None]:
    """One call read as JSON by the service's own `calls.complete`, plus the raw reply its signals are read from. A
    provider that cannot be reached is a failed call, not an aborted study; an exhausted budget or a refused output
    constraint still stops the case."""
    seen: list[ResearchReply] = []

    class Tap:
        model = meter.model

        def complete(self, **kw):
            seen.append(meter.complete(attempt=attempt, sample=sample, **kw, **sampling))
            return seen[-1]
    started = time.monotonic()
    try:
        parsed, calls = complete(Tap(), stage=stage, record=None, system=system, user=user, schema=schema,
                                 max_tokens=max_tokens, counter=meter.counter)
    except OSError as error:   # refused connection, timeout or HTTP status: requests' errors are OSErrors
        return None, [Call(stage, None, None, None, round(time.monotonic() - started, 6), None, False,
                           f"{type(error).__name__}: {error}"[:300])], None
    return parsed, calls, (seen[-1] if seen else None)
