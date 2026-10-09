"""Lossless NUL text at the JSONB boundary; provider requests and evidence stay unchanged.

Only actual NULs are escaped. Versioned paths distinguish them from literal JSON
escapes, so ordinary field names and closed-set values keep their SQL meaning.
Requests declare body encoding in tokenizer metadata; other history documents use
root metadata. Digests identify stored bytes; replay and reads restore the text.
"""
from __future__ import annotations

from copy import deepcopy
import json

MARKER = "_freeJsonbStrings"
VERSION = 1
# Traverse history containers, never arbitrary extracted objects such as modelValue/parsed.
CONTAINERS = frozenset({"input", "checkpoint", "snapshot", "selection", "effective", "capture", "candidates",
                        "request", "output", "values", "coverage", "manifest", "configuration", "candidate", "decision",
                        "captures", "failedCalls", "snapshots", "corrections", "plans", "selections", "attempts", "finalizations"})


def _escape(value):
    strings, keys = [], []
    def visit(item, path):
        if isinstance(item, str) and "\x00" in item:
            strings.append(path)
            return json.dumps(item, ensure_ascii=False)
        if isinstance(item, list):
            return [visit(part, [*path, index]) for index, part in enumerate(item)]
        if isinstance(item, dict):
            escape_keys = any("\x00" in key for key in item)
            if escape_keys:
                keys.append(path)
            return {(stored := json.dumps(key, ensure_ascii=False) if escape_keys else key):
                    visit(part, [*path, stored]) for key, part in item.items()}
        return item
    stored = visit(value, [])
    return stored, {"version": VERSION, "strings": strings, "keys": keys} if strings or keys else None


def _restore(value, encoding):
    if encoding.get("version") != VERSION:
        raise ValueError("unsupported history text encoding")
    restored = deepcopy(value)
    def at(path):
        part = restored
        for key in path:
            part = part[key]
        return part
    for path in encoding["strings"]:
        decoded = json.loads(at(path))
        if not isinstance(decoded, str):
            raise ValueError("invalid encoded JSONB string")
        at(path[:-1])[path[-1]] = decoded
    for path in reversed(encoding["keys"]):
        part = at(path)
        decoded = {json.loads(key): item for key, item in part.items()}
        part.clear()
        part.update(decoded)
    return restored


def _request(value):
    return isinstance(value, dict) and set(value) == {"provider", "composer", "tokenizer", "budget", "examples", "omissions", "body"}


def encode_storage(value):
    if isinstance(value, list):
        return [encode_storage(item) for item in value]
    if not isinstance(value, dict):
        return value
    if _request(value):
        body, encoding = _escape(value["body"])
        tokenizer = dict(value["tokenizer"])
        if encoding:
            if MARKER in tokenizer:
                raise ValueError("reserved request storage metadata")
            tokenizer[MARKER] = encoding
        return {**value, "body": body, "tokenizer": tokenizer, "examples": encode_storage(value["examples"])}
    encoded, encoding = _escape(value)
    if encoding:
        if MARKER in value:
            raise ValueError("reserved history storage metadata")
        encoded[MARKER] = encoding
    return encoded


def decode_storage(value):
    if isinstance(value, list):
        return [decode_storage(item) for item in value]
    if not isinstance(value, dict):
        return value
    if _request(value) and MARKER in value["tokenizer"]:
        tokenizer = {key: item for key, item in value["tokenizer"].items() if key != MARKER}
        return {**value, "tokenizer": tokenizer, "body": _restore(value["body"], value["tokenizer"][MARKER]),
                "examples": decode_storage(value["examples"])}
    if MARKER in value:
        return _restore({key: item for key, item in value.items() if key != MARKER}, value[MARKER])
    return {key: decode_storage(item) if key in CONTAINERS else item for key, item in value.items()}
