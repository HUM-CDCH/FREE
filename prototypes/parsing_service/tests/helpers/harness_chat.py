"""A scripted stand-in for the model on the synthetic catalogue: it reads the SOURCE the harness shows and answers in the
harness's own reply shape, with knobs for the errors a test needs. Every deterministic harness test uses it; nothing
here is a claim about a real model.
"""
from __future__ import annotations

import ast
import json
import re

from experiments.harness.model import ResearchReply
from experiments.harness.signals import value_offsets

BLOCK = re.compile(r'<block id="([^"]+)" label="[^"]*" page="(\d+)">(.*?)</block>', re.S)
ENTRY = re.compile(r"^(\d+)\. (\w+)\. Kreis (\w+)\. Funde: (.*)$")
DATED = re.compile(r"^(.*?)\.?(?: Datiert: (\d+)\.)?$")


def sections(user: str) -> dict[str, str]:
    found = {}
    for match in re.finditer(r"### ([A-Z ]+?)(?: \(context\))?\n(.*?)(?=\n\n### |\n\nReturn the JSON object now\.)", user, re.S):
        found[match.group(1)] = match.group(2)
    return found


def passages_of(text: str) -> list[tuple[str | None, str]]:
    blocks = BLOCK.findall(text)
    if blocks:
        return [(i, body) for i, _, body in blocks]
    return [(None, part) for part in text.split("\n\n") if part.strip()]


def entries_of(source: list[tuple[str | None, str]], earlier: list[tuple[str | None, str]], *, use_earlier: bool) -> list[dict]:
    """Records the way a careful reader sees them: an entry cut at a passage end continues in the next passage."""
    joined = list(source)
    if use_earlier and earlier and joined and not ENTRY.match(joined[0][1]) and ENTRY.match(earlier[-1][1]):
        joined = [earlier[-1], *joined]
    entries: list[dict] = []
    for segment, text in joined:
        head = ENTRY.match(text)
        if head:
            entries.append({"no": int(head.group(1)), "site": head.group(2), "kreis": head.group(3), "tail": [(segment, head.group(4))],
                            "ids": [segment], "cut": False})
        else:
            if entries and entries[-1]["tail"][-1][1].endswith(","):
                entries[-1]["tail"].append((segment, text))
                entries[-1]["ids"].append(segment)
            else:
                entries.append({"no": None, "site": None, "kreis": None, "tail": [(segment, text)], "ids": [segment], "cut": False})
    for entry in entries:
        entry["cut"] = entry["tail"][-1][1].endswith(",")
        body = " ".join(part for _, part in entry["tail"])
        finds_text, year = (lambda m: (m.group(1), m.group(2)))(DATED.match(body))
        entry["finds"] = [f.strip() for f in finds_text.rstrip(",").split(",") if f.strip()]
        entry["date"] = year
    return entries


class Reader:
    """`Reader(...).chat()` is a chat. Knobs are keyed by entry number and field."""

    def __init__(self, *, wrong=None, drop=(), fake_records=(), quotes=None, logprob=None, confidence=None, use_earlier=True,
                 raise_at=(), garbage_at=(), truncate_at=(), invalid_at=(), verdicts=None, choose="C1", model="fake/reader",
                 no_logprobs=False, supports_sampling=True, wrong_at=None, drop_at=None, ids=None, document_wrong=None, end_token=False,
                 offset_tokens=False):
        self.wrong, self.drop, self.fake_records = wrong or {}, set(drop), list(fake_records)
        self.quotes, self.logprob, self.confidence, self.use_earlier = quotes or {}, logprob or {}, confidence or {}, use_earlier
        self.raise_at, self.garbage_at, self.truncate_at, self.invalid_at = set(raise_at), set(garbage_at), set(truncate_at), set(invalid_at)
        self.verdicts, self.choose, self.no_logprobs = verdicts or {}, choose, no_logprobs
        self.model, self.accepts_sampling = model, supports_sampling
        self.wrong_at, self.drop_at, self.ids, self.document_wrong = wrong_at or {}, drop_at or {}, ids or {}, document_wrong or {}
        self.end_token, self.offset_tokens = end_token, offset_tokens
        self.calls: list[dict] = []

    # -- the chat protocol ------------------------------------------------------------------------------------
    def complete(self, *, system, user, schema, max_tokens=None, temperature=0.0, seed=None, top_logprobs=0) -> ResearchReply:
        n = len(self.calls)
        self.calls.append({"system": system, "user": user, "schema": schema, "max_tokens": max_tokens, "temperature": temperature,
                           "seed": seed, "top_logprobs": top_logprobs})
        if n in self.raise_at:
            raise OSError("connection refused")
        if n in self.garbage_at:
            return ResearchReply("not json at all", 10, 5, "stop", 0.0)
        if system.startswith("You check values"):
            answer = self._verify(user)
        elif system.startswith("Several values were found"):
            answer = {"choice": self.choose}
        elif "List every record in the SOURCE and, for each, every fact" in system:
            answer = self._document(user)
        else:
            answer = self._extract(user, schema, system, n)
        if n in self.invalid_at:
            answer = {"records": "nope"}
        text = json.dumps(answer, ensure_ascii=False)
        if n in self.truncate_at:
            return ResearchReply(text[:len(text) // 2], 10, max_tokens or 5, "length", 0.0)
        logprobs = () if self.no_logprobs or not top_logprobs else self._logprobs(text, top_logprobs)
        return ResearchReply(text, 100 + n, 50 + n, "stop", 0.25, logprobs=logprobs)

    # -- answers ----------------------------------------------------------------------------------------------
    def _extract(self, user: str, schema: dict | None, system: str = "", n: int = 0) -> dict:
        if schema is None:   # prompt-only constraint: the schema is in the instructions
            schema = json.loads(system.split("JSON matching this schema exactly: ", 1)[1].splitlines()[0])
        parts = sections(user)
        source = passages_of(parts.get("SOURCE", ""))
        earlier = passages_of(parts.get("EARLIER TEXT", ""))
        entries = entries_of(source, earlier, use_earlier=self.use_earlier)
        props = schema["properties"]["records"]["items"]["properties"]
        records = []
        for entry in [*entries, *self.fake_records[:1 if self.calls and len(self.calls) == 1 else 0]]:
            record = {}
            for name, spec in props.items():
                value, quotes, ids = self._field(entry, name, n)
                wrapper = spec.get("properties")
                if entry["no"] is not None and ((entry["no"], name) in self.drop or (entry["no"], name) in self.drop_at.get(n, ())):
                    value = quotes = None
                if value is None:
                    record[name] = None
                elif wrapper and "value" in wrapper:
                    cell = {"value": value}
                    if "quotes" in wrapper:
                        cell["quotes"] = quotes
                    if "ids" in wrapper:
                        cell["ids"] = [i for i in ids if i]
                    if "confidence" in wrapper:
                        cell["confidence"] = self.confidence.get((entry["no"], name), 0.9)
                    record[name] = cell
                else:
                    record[name] = value
            records.append(record)
        answer = {"records": records}
        if "begins_inside_record" in schema["properties"]:
            first, last = (source[0][1] if source else ""), (source[-1][1] if source else "")
            answer |= {"begins_inside_record": bool(source) and not ENTRY.match(first) and not (self.use_earlier and earlier),
                       "ends_inside_record": last.endswith(",")}
        return answer

    def _field(self, entry: dict, name: str, n: int = 0):
        no = entry["no"]
        truth = {"entry_no": (no, [str(no)] if no is not None else None), "site": (entry["site"], [entry["site"]]),
                 "kreis": (entry["kreis"], [entry["kreis"]]), "finds": (entry["finds"] or None, entry["finds"]),
                 "date": (entry["date"], [entry["date"]] if entry["date"] else None)}[name]
        value, quotes = truth
        if (no, name) in self.wrong:
            value = self.wrong[(no, name)]
        if (no, name) in self.wrong_at.get(n, {}):
            value = self.wrong_at[n][(no, name)]
        if (no, name) in self.ids:
            return value, quotes, self.ids[(no, name)]
        if (no, name) in self.quotes:
            quotes = self.quotes[(no, name)]
        return value, quotes, entry["ids"]

    def _document(self, user: str) -> dict:
        parts = sections(user)
        entries = entries_of(passages_of(parts.get("SOURCE", "")), [], use_earlier=False)
        return {"records": [{"facts": [{"label": "Nr", "value": str(e["no"])}, {"label": "Fundort", "value": self.document_wrong.get(e["no"], str(e["site"]))},
                                       {"label": "Kreis", "value": str(e["kreis"])}, *({"label": "Fund", "value": f} for f in e["finds"]),
                                       *([{"label": "Jahr", "value": e["date"]}] if e["date"] else [])]} for e in entries if e["no"] is not None]}

    def _verify(self, user: str) -> dict:
        answer = {}
        for label, name, value, cited in re.findall(r"### (C\d+): field (\w+)[^\n]*\nvalue: ([^\n]*)\ncited text:\n(.*?)(?=\n\n### |\n\nReturn)", user, re.S):
            items = ast.literal_eval(value)
            items = items if isinstance(items, list) else [items]
            forced = self.verdicts.get(name, {})
            answer[label] = {"supports_value": forced.get("supports_value", all(str(i) in cited for i in items)),
                             "supports_field": forced.get("supports_field", True),
                             "supports_record": forced.get("supports_record", True)}
        return answer

    def _logprobs(self, text: str, top: int) -> tuple:
        offsets = value_offsets(text)
        spans = {path: span for path, span in offsets.items() if path[:1] == ("records",) and len(path) in (3, 4) and
                 (len(path) == 3 or path[3] == "value")}
        entries, at = [], 0
        records = json.loads(text).get("records", [])
        for token in re.findall(r"\w+|[^\w\s]|\s+", text):
            lo, hi = at, at + len(token)
            lp = -0.001
            for (_, k, name, *_), (a, b) in spans.items():
                if lo < b and hi > a and token.strip('[]{},:" \n'):
                    entry_no = next(iter(v for v in (records[k].get("entry_no"),) if v is not None), None)
                    entry_no = entry_no["value"] if isinstance(entry_no, dict) else entry_no
                    lp = self.logprob.get((entry_no, name), -0.05)
            entries.append({"token": token, "logprob": lp, "bytes": list(token.encode()),
                            "top_logprobs": [{"token": token, "logprob": lp, "bytes": list(token.encode())},
                                             *({"token": f"alt{i}", "logprob": lp - 1.5 - i, "bytes": list(f"alt{i}".encode())} for i in range(top - 1))][:top]})
            at = hi
        if self.end_token:      # vLLM lists the end-of-turn token among the reply's tokens; the text omits it
            entries.append({"token": "<|im_end|>", "logprob": -0.001, "bytes": list(b"<|im_end|>"), "top_logprobs": []})
        if self.offset_tokens:  # tokens that do not rebuild the text: positions cannot be trusted
            entries.insert(0, {"token": "junk", "logprob": -0.5, "bytes": list(b"junk"), "top_logprobs": []})
        return tuple(entries)
