"""Version 1 transport: send the saved HTTP body without recomposition; a streamed call adds only the provider's
stream and usage options."""
from collections.abc import Callable
from dataclasses import dataclass
import json
import time
import unicodedata

import requests

from kei_exp.kie.extract.llm import UNSUPPORTED, ModelOutputError, Reply, _reply


class FormatRefused(Exception):
    """A saved refusal allows a separate, captured format fallback."""


class _ItemRepetitionGuard:
    """Scan complete direct array objects without interpreting or altering the reply."""

    def __init__(self, source, started):
        self.source = " ".join(unicodedata.normalize("NFC", source).split())
        self.started = started
        self.stack = []
        self.quoted = False
        self.escaped = False

    def feed(self, text):
        for char in text:
            for frame in self.stack:
                if frame.get("item") is not None:
                    frame["item"].append(char)
            if self.quoted:
                if self.escaped:
                    self.escaped = False
                elif char == "\\":
                    self.escaped = True
                elif char == '"':
                    self.quoted = False
                continue
            if char == '"':
                self.quoted = True
            if self.stack and self.stack[-1]["kind"] == "array":
                array = self.stack[-1]
                if array["expect"] and not char.isspace() and char != "]":
                    array["expect"] = False
                    if char == "{":
                        array["item"] = [char]
                    else:
                        array["last"] = None
                        array["count"] = array["bytes"] = 0
                if char == ",":
                    array["expect"] = True
            if char in "[{":
                self.stack.append({"kind": "array", "expect": True, "item": None,
                                   "last": None, "count": 0, "bytes": 0} if char == "[" else {"kind": "object"})
            elif char in "]}" and self.stack:
                self.stack.pop()
                if char == "}" and self.stack and self.stack[-1]["kind"] == "array":
                    array = self.stack[-1]
                    if array["item"] is None:
                        continue
                    raw = "".join(array["item"])
                    array["item"] = None
                    try:
                        item = json.loads(raw, strict=False)
                        anchor = item.get("_item_text")
                        anchor = " ".join(unicodedata.normalize("NFC", anchor).split()) if isinstance(anchor, str) else ""
                        canonical = json.dumps(item, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
                    except (ValueError, AttributeError):
                        anchor, canonical = "", None
                    if not anchor or anchor not in self.source:
                        array["last"] = None
                        array["count"] = array["bytes"] = 0
                        continue
                    if canonical != array["last"]:
                        # Overlapping matches conservatively count every source-supported occurrence.
                        occurrences, offset = 0, 0
                        while (offset := self.source.find(anchor, offset)) != -1:
                            occurrences += 1
                            offset += 1
                        array.update(last=canonical, count=0, bytes=0, occurrences=occurrences)
                    array["count"] += 1
                    array["bytes"] += len(raw.encode("utf-8"))
                    if array["count"] > max(32, 2 * array["occurrences"] + 8) and array["bytes"] >= 2048:
                        raise ModelOutputError(
                            f"nuextract-item-text-v1: {array['count']} adjacent items, "
                            f"{array['bytes']} bytes, {array['occurrences']} source occurrences; "
                            f"elapsed {time.monotonic() - self.started:.3f}s")


@dataclass
class CapturedChat:
    provider: dict
    payload: dict
    # Given, the reply is streamed and each piece of its text handed here as it is generated: a view while the call
    # runs. Only the transport changes; the reply is read and saved as the unstreamed request's.
    on_text: Callable[[str], None] | None = None
    stage: str | None = None

    @property
    def model(self):
        return self.provider["model"]

    def complete(self, **logical_request):
        if self.provider.get("adapter") == "codex-cli":
            from kei_exp.kie.extract.codex import CodexChat
            return CodexChat(model=self.model, timeout=self.provider["timeout"]).complete_request(
                self.payload, on_text=self.on_text)
        started=time.monotonic()
        guard = (_ItemRepetitionGuard(logical_request["user"], started)
                 if self.provider.get("adapter") == "nuextract" and self.stage == "entry" else None)
        if self.on_text is not None or guard is not None:
            return self._streamed(started, guard)
        response=requests.post(self.provider["url"],json=self.payload,timeout=self.provider["timeout"])
        if "response_format" in self.payload and response.status_code==400 and UNSUPPORTED.search(response.text):
            raise FormatRefused()
        return _reply(response,started,())

    def _streamed(self, started, guard):
        body={**self.payload,"stream":True,"stream_options":{"include_usage":True}}
        with requests.post(self.provider["url"],json=body,timeout=self.provider["timeout"],stream=True) as response:
            if "response_format" in self.payload and response.status_code==400 and UNSUPPORTED.search(response.text):
                raise FormatRefused()
            if not response.headers.get("content-type","").startswith("text/event-stream"):
                reply = _reply(response,started,())
                if guard is not None:
                    guard.feed(reply.text)
                if self.on_text is not None:
                    self.on_text(reply.text)
                return reply
            response.raise_for_status()
            text,finish,usage=[],None,{}
            for line in response.iter_lines():
                # Server-sent events; a line never splits a UTF-8 character.
                data=line.decode("utf-8").removeprefix("data:").strip() if line.startswith(b"data:") else ""
                if not data or data=="[DONE]":
                    continue
                chunk=json.loads(data)
                usage=chunk.get("usage") or usage
                for choice in chunk.get("choices") or ():
                    piece=(choice.get("delta") or {}).get("content") or ""
                    if piece:
                        if guard is not None:
                            guard.feed(piece)
                        text.append(piece)
                        if self.on_text is not None:
                            self.on_text(piece)
                    finish=choice.get("finish_reason") or finish
        if finish is None:
            raise ModelOutputError("stream ended without a finish reason")
        return Reply(text="".join(text),input_tokens=usage.get("prompt_tokens"),output_tokens=usage.get("completion_tokens"),
                     finish=finish,seconds=time.monotonic()-started)
