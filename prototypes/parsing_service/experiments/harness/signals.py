"""Confidence signals. A signal a provider cannot give is None (missing), never zero.

Token probabilities are read off the tokens of the field's own value in the reply text: the JSON keys, quotes, commas
and brackets around it are excluded by character offsets, and a token that straddles a boundary counts only if it holds
value characters. The probabilities are the server's as reported (raw or processed is a property of the deployment;
see the provider audit), conditional on the reply prefix: they are not probabilities that a value is correct. The
alternatives at the first value token are top-k tokens, not alternative values, and their entropy is a lower bound.
"""
from __future__ import annotations

import json
import math
import re
from typing import Any

JSON_PUNCTUATION = '[]{},:" \n\t\r'
SIGNALS = ("verbalized", "p_first", "p_mean", "p_span", "margin", "entropy_topk", "agreement", "view_agreement",
           "align", "verdict", "ocr", "conflict", "invalid")


def value_offsets(text: str) -> dict[tuple, tuple[int, int]]:
    """The character range of every JSON value of a reply, by path (object keys and array indices). Raises ValueError
    or IndexError on text that is not one JSON document."""
    decoder = json.JSONDecoder(strict=False)
    found: dict[tuple, tuple[int, int]] = {}

    def skip(i: int) -> int:
        while i < len(text) and text[i] in " \t\r\n":
            i += 1
        return i

    def value(i: int, path: tuple) -> int:
        i = start = skip(i)
        if text[i] == "{":
            i = skip(i + 1)
            while text[i] != "}":
                key, i = decoder.raw_decode(text, i)
                i = skip(i)
                if text[i] != ":":
                    raise ValueError("expected a colon")
                i = skip(value(i + 1, (*path, key)))
                i = skip(i + 1) if text[i] == "," else i
            end = i + 1
        elif text[i] == "[":
            i, n = skip(i + 1), 0
            while text[i] != "]":
                i = skip(value(i, (*path, n)))
                n += 1
                i = skip(i + 1) if text[i] == "," else i
            end = i + 1
        else:
            end = decoder.raw_decode(text, i)[1]
        found[path] = (start, end)
        return end
    value(min((i for i in (text.find("{"), text.find("[")) if i >= 0), default=0), ())
    return found


SPECIAL_TAIL = re.compile(r"(<\|[^|>]*\|>)+")


def _tokens(reply) -> tuple[list[tuple[int, int, dict]], bytes] | None:
    """Byte ranges of the reply's tokens, provided they rebuild the reply text exactly. vLLM lists the end-of-turn token
    (`<|im_end|>`) among the reply's tokens though the text omits it, so a tail of special tokens is allowed."""
    pieces = []
    for entry in reply.logprobs:
        raw = bytes(entry["bytes"]) if entry.get("bytes") is not None else entry["token"].encode()
        pieces.append((raw, entry))
    joined = b"".join(raw for raw, _ in pieces)
    text = reply.text.encode()
    if not joined.startswith(text) or (joined[len(text):] and not SPECIAL_TAIL.fullmatch(joined[len(text):].decode(errors="replace"))):
        return None     # the server's tokens are not the text (stripped, rewritten): position is unknown
    ranges, at = [], 0
    for raw, entry in pieces:
        ranges.append((at, at + len(raw), entry))
        at += len(raw)
    return ranges, joined


def value_stats(reply, path: tuple) -> dict[str, float | int | None] | None:
    """First-token and mean/span probabilities and first-token margin and top-k entropy of the value at `path`, or None
    when the reply carries no token probabilities, they do not rebuild the text, or the path is not in it."""
    if reply is None or not getattr(reply, "logprobs", None):
        return None
    try:
        offsets = value_offsets(reply.text)
    except (ValueError, IndexError):
        return None
    tokens = _tokens(reply)
    if path not in offsets or tokens is None:
        return None
    ranges, joined = tokens
    leaves = [(a, b) for other, (a, b) in offsets.items() if other[:len(path)] == path and reply.text[a] not in "{["]
    leaves = [(a + 1, b - 1) if reply.text[a] == '"' else (a, b) for a, b in leaves if reply.text[a:b].strip() != "null"]
    if not leaves:
        return None                      # no value: nothing to be confident about
    spans = [(len(reply.text[:a].encode()), len(reply.text[:b].encode())) for a, b in leaves]
    kept = [entry for lo, hi, entry in ranges
            if any(lo < end and hi > start and joined[max(lo, start):min(hi, end)].decode(errors="ignore").strip(JSON_PUNCTUATION)
                   for start, end in spans)]
    if not kept:
        return None
    logprobs = [entry["logprob"] for entry in kept]
    top = sorted((math.exp(t["logprob"]) for t in kept[0].get("top_logprobs") or []), reverse=True)   # vLLM masks with -9999: p = 0
    return {"tokens": len(kept), "p_first": math.exp(logprobs[0]), "p_mean": math.exp(sum(logprobs) / len(logprobs)),
            "p_span": math.exp(sum(logprobs)),
            "margin": (top[0] - top[1]) / (top[0] + top[1]) if len(top) >= 2 else None,
            "entropy_topk": (-sum(p * math.log(p) for p in top if p > 0) or 0.0) if top else None}     # never -0.0


def assemble(winners: list[dict], *, votes: tuple[int, int] | None, view: bool | None,
             evidence: list[dict], verdict: dict | None, ocr: float | None, conflict: bool, invalid: bool | None) -> dict[str, Any]:
    """The signals of one consolidated field. `winners` are the candidate fields that state the chosen value; `votes` is
    (samples agreeing, samples) when the field was sampled more than once."""
    def mean(values: list[float]) -> float | None:
        return sum(values) / len(values) if values else None

    def stat(name: str) -> float | None:
        return mean([c["stats"][name] for c in winners if c.get("stats") and c["stats"].get(name) is not None])
    exact = {"exact": 1.0, "normalized": 0.9, "fuzzy": None, "passage": 0.5, "passage+value": 0.8}
    align = [entry["score"] if entry["method"] == "fuzzy" else exact.get(entry["method"]) for entry in evidence if entry["spans"]]
    verdicts = None if not verdict else [v for k, v in verdict.items() if k.startswith("supports_") and v is not None]
    return {"verbalized": mean([c["verbalized"] for c in winners if isinstance(c.get("verbalized"), (int, float))]),
            "p_first": stat("p_first"), "p_mean": stat("p_mean"), "p_span": stat("p_span"), "margin": stat("margin"),
            "entropy_topk": stat("entropy_topk"),
            "agreement": None if votes is None else votes[0] / votes[1],
            "view_agreement": None if view is None else float(view),
            "align": mean([a for a in align if a is not None]) if align else None,
            "verdict": None if not verdicts else sum(verdicts) / len(verdicts),
            "ocr": ocr, "conflict": float(conflict), "invalid": None if invalid is None else float(invalid)}
