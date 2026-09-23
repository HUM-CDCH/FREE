"""Counting a request's input tokens with the served model's own tokenizer, before the request is sent (design §8).

Character or byte counts are not an enforceable budget. The counter is obtained from the endpoint that will serve
the calls and pinned to it. Ollama has no tokenize route, but `/api/show` with `verbose` returns the served model's
vocabulary, merges and pre-tokenizer; the byte-level BPE is rebuilt from exactly those, and the chat-template
overhead is measured once by a one-token probe on the real `/v1/chat/completions` route with the flags every
extraction call sends. vLLM counts the rendered request itself on `/tokenize`. Any other endpoint, an unknown
pre-tokenizer or an unreported context size refuses the grounded Catalog path before a single extraction call.
Every call's server-reported prompt count is compared with the count afterwards; a mismatch is reported.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Protocol

import requests
from tokenizers import Regex, Tokenizer, models, pre_tokenizers

# The pre-tokenizer regexes this service reproduces, by the name GGUF records in `tokenizer.ggml.pre`.
PRE_TOKENIZERS = {
    "qwen2": r"(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+"
             r"|\s+(?!\S)|\s+",
}
CONTROL_TYPES = (3, 4)  # GGUF token types parsed as one token wherever they occur: control, user-defined
PROBE_SCHEMA = {"type": "object", "properties": {}, "additionalProperties": False}
_COUNTERS: dict[tuple[str, str], TokenCounter] = {}  # per endpoint and model; rebuilt when the digest changes


class BudgetUnavailable(ValueError):
    """No verified way to count this endpoint's requests; the grounded path refuses before any extraction call."""


class Http(Protocol):
    def post(self, url: str, json: dict, timeout: float) -> Any: ...
    def get(self, url: str, timeout: float) -> Any: ...


def ollama_tokenizer(show: dict) -> Tokenizer:
    """The served model's byte-level BPE, rebuilt from its own `/api/show` vocabulary, merges and pre-tokenizer."""
    info = show.get("model_info") or {}
    if info.get("tokenizer.ggml.model") != "gpt2":
        raise BudgetUnavailable(f"the served tokenizer is {info.get('tokenizer.ggml.model')!r}, not the byte-level "
                                "BPE (gpt2) this service can reproduce")
    split = PRE_TOKENIZERS.get(info.get("tokenizer.ggml.pre"))
    if split is None:
        raise BudgetUnavailable(f"the served pre-tokenizer {info.get('tokenizer.ggml.pre')!r} is not one this "
                                "service reproduces")
    tokens: list[str] = info["tokenizer.ggml.tokens"]
    merges = [tuple(merge.split(" ", 1)) for merge in info["tokenizer.ggml.merges"]]
    tokenizer = Tokenizer(models.BPE(vocab={token: index for index, token in enumerate(tokens)}, merges=merges,
                                     byte_fallback=False))
    tokenizer.pre_tokenizer = pre_tokenizers.Sequence([
        pre_tokenizers.Split(Regex(split), behavior="isolated", invert=False),
        pre_tokenizers.ByteLevel(add_prefix_space=False, use_regex=False)])
    types = info.get("tokenizer.ggml.token_type") or []
    tokenizer.add_special_tokens([token for token, kind in zip(tokens, types, strict=False) if kind in CONTROL_TYPES])
    return tokenizer


@dataclass
class TokenCounter:
    source: str
    model: str
    model_digest: str | None
    template_tokens: int | None
    context_tokens: int | None
    _tokenizer: Tokenizer | None = field(default=None, repr=False)
    _http: Any = field(default=None, repr=False)
    _base: str = ""
    _headers: dict = field(default_factory=dict, repr=False)
    probes: list[dict] = field(default_factory=list)  # calibration requests the last counter_for sent to the model

    def request_tokens(self, system: str, user: str) -> int:
        """The input tokens of one system+user request as the server will count them."""
        if self._tokenizer is not None:
            return self._count(system) + self._count(user) + (self.template_tokens or 0)
        response = self._http.post(f"{self._base}/tokenize", json={
            "model": self.model, "add_generation_prompt": True,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}, timeout=60,
            **({"headers": self._headers} if self._headers else {}))
        response.raise_for_status()
        return int(response.json()["count"])

    def _count(self, text: str) -> int:
        return len(self._tokenizer.encode(text, add_special_tokens=False).ids)

    def identity(self) -> dict:
        return {"source": self.source, "model": self.model, "model_digest": self.model_digest,
                "template_tokens": self.template_tokens}


def counter_for(url: str, model: str, *, http: Http = requests, headers: dict | None = None) -> TokenCounter:
    """The verified counter of the endpoint behind `url` (a chat-completions URL) serving `model`. It is rebuilt when
    the served digest changes, and the context the server serves now is read on every use; every calibration request
    sent to the model on the way is in `probes`, for the caller to report as a model call."""
    base = url.split("/v1/", 1)[0].rstrip("/")
    extra = {"headers": headers} if headers else {}
    tags = http.get(f"{base}/api/tags", timeout=30, **extra)
    listed = tags.json().get("models", []) if tags.status_code == 200 else []
    digest = next((entry.get("digest") for entry in listed if model in (entry.get("name"), entry.get("model"))), None)
    counter = _COUNTERS.get((base, model))
    if counter is not None and counter.model_digest == digest:
        counter.probes = []
        _read_context(counter, url, base, http, extra)
        return counter
    show = http.post(f"{base}/api/show", json={"model": model, "verbose": True}, timeout=120, **extra)
    if show.status_code == 200 and "tokenizer.ggml.tokens" in (show.json().get("model_info") or {}):
        tokenizer = ollama_tokenizer(show.json())
        counter = TokenCounter("ollama:/api/show", model, digest, None, None, _tokenizer=tokenizer)
        served = _probe(counter, url, http, extra)
        counter.template_tokens = served - counter._count("S") - counter._count("U")
        counter.context_tokens = _ollama_context(base, model, http, extra)
    else:
        counter = TokenCounter("vllm:/tokenize", model, None, None, None, _http=http, _base=base,
                               _headers=headers or {})
        if not _read_context(counter, url, base, http, extra):
            raise BudgetUnavailable(f"no verified tokenizer for {model!r} at {base}: neither Ollama's /api/show "
                                    "vocabulary nor a vLLM /tokenize route answered")
    _COUNTERS[(base, model)] = counter
    return counter


def _probe(counter: TokenCounter, url: str, http: Http, extra: dict) -> int:
    """One-token request on the real route with the flags every extraction call sends; returns the served prompt
    count. It is a model call, so it is recorded in `probes`."""
    clock = time.monotonic()
    probe = http.post(url, json={
        "model": counter.model, "temperature": 0, "max_tokens": 1, "reasoning_effort": "none",
        "messages": [{"role": "system", "content": "S"}, {"role": "user", "content": "U"}],
        "response_format": {"type": "json_schema", "json_schema": {"name": "reply", "schema": PROBE_SCHEMA,
                                                                  "strict": True}}}, timeout=600, **extra)
    probe.raise_for_status()
    usage = probe.json()["usage"]
    counter.probes.append({"input_tokens": int(usage["prompt_tokens"]),
                           "output_tokens": usage.get("completion_tokens"),
                           "seconds": round(time.monotonic() - clock, 3)})
    return int(usage["prompt_tokens"])


def _ollama_context(base: str, model: str, http: Http, extra: dict) -> int | None | bool:
    """The context the loaded model is served with; False when Ollama answers but has not loaded it, None when it
    cannot say."""
    running = http.get(f"{base}/api/ps", timeout=30, **extra)
    if running.status_code != 200:
        return None
    loaded = [entry for entry in running.json().get("models", []) if model in (entry.get("name"), entry.get("model"))]
    return loaded[0].get("context_length") if loaded else False


def _read_context(counter: TokenCounter, url: str, base: str, http: Http, extra: dict) -> bool:
    """Set the counter's context to what the server serves now; False when the endpoint gave no count at all."""
    if counter._tokenizer is not None:
        context = _ollama_context(base, counter.model, http, extra)
        if context is False:  # unloaded since: one probe loads it with the extraction flags
            _probe(counter, url, http, extra)
            context = _ollama_context(base, counter.model, http, extra)
        counter.context_tokens = context or None
        return True
    tokenize = http.post(f"{base}/tokenize", json={"model": counter.model, "add_generation_prompt": True, "messages": [
        {"role": "user", "content": "U"}]}, timeout=60, **extra)
    if tokenize.status_code != 200 or "count" not in tokenize.json():
        counter.context_tokens = None  # unknown now, never the context an earlier read found
        return False
    counter.context_tokens = tokenize.json().get("max_model_len")
    return True
