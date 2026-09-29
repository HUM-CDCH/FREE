"""The unified Catalog: one method for every new Catalog Extraction, result version 3.

The request's `options.unified` pins the versioned defaults and any overrides of its five controls (input ceiling,
reply reserve, overlap, heading context, verification). Before any model call the effective per-stage budgets are
resolved from the served context and published write-once as `catalog-execution.json` beside the result; general
record discovery (`discovery.py`) is then published write-once as `catalog-discovery.json`. A re-executed step
validates and reuses both: budgets the serving environment can no longer honor, or records of other inputs, fail
explicitly instead of being replaced.

Every entry is read whole through counted windows of its own text (overlap within the entry), beside the record-free
lines before it when heading context is on. The fields model returns `{value, quote}` candidates, and `_item_text`
for each object in a list. Code, never the model, checks them: the value conforms to its field, the quote is text of
that entry, and a value is literal where its printed form lies inside the quote; a yes/no, an allowed label or a
derived field may instead be supported by the quoted passage, never by a fabricated literal span. A separate reasoning
request verifies candidates in counted batches; only a supported candidate is accepted. With verification off, or
where the schema's evidence policy asks for none, candidates stay proposals.

Merging keeps structure and doubt. Equal observations are one; accepted scalars that disagree go to one counted
arbitration over the supplied candidates, or stay unresolved. A list item is one item across windows only when two
windows saw it with the same occurrence, values and support; an unmatched item at a window cut is kept as a partial
proposal, never joined with another. Document-level fields are read from their own windows over all admitted text and
stay unverified. Source accounting, processing and evidence are reported apart; recall is not measured.
"""
from __future__ import annotations

import hashlib
import json
import threading
import time
import unicodedata
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from functools import partial
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from kei_exp.canonical import canonical_json
from kei_exp.files import publish_once
from kei_exp.kie.blocks import Span
from kei_exp.kie.extract import discovery
from kei_exp.kie.extract.acceptance import Outcome, typed_value
from kei_exp.kie.extract.calls import Call, complete
from kei_exp.kie.extract.catalog_result import evidence_link, place, spans_json
from kei_exp.kie.extract.contexts import reconcile_values
from kei_exp.kie.extract.discovery import Window, occurrences, plan, ranges_json, split, text_of
from kei_exp.kie.extract.locate import BlockText, _spans, forms, locate, raw_range
from kei_exp.kie.extract.models import ROLE, Router
from kei_exp.kie.extract.schema import Node, Schema, conform, evidence_policy, json_schema, notes
from kei_exp.kie.extract.stages import Issue, merge
from kei_exp.kie.extract.tokens import counters_for
from kei_exp.kie.extract.windows import Unit
from kei_exp.kie.passages import Evidence

EXTRACTION_VERSION = 3
PROMPT_VERSION = 2  # 2: discovery places are one-line [line, text, kind, label] lists
RECORD_VERSION = 1
ITEM = "_item_text"  # a list item's occurrence in the record: its identity, apart from its values' evidence
# The versioned service defaults: engineering choices, none measured yet. Reserves are sized for replies that list
# many boundaries or candidates; Auto input is the served context minus the stage's reserve; one unit of overlap;
# heading context and verification on; a failed window is halved at most six times.
DEFAULTS = {1: {"reserves": {"discovery": 4096, "entry": 4096, "verification": 2048, "arbitration": 512,
                             "document": 2048},
                "overlap": 1, "headings": True, "verification": True, "splits": 6}}


class UnifiedOptions(BaseModel):
    """`options.unified`: the versioned defaults the method was admitted under and the overrides of its controls,
    absent where the defaults apply. Budgets change how primary text is partitioned, never how much of it is read."""
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)  # as Studio's schema: "yes" is no boolean
    defaults: Literal[1]
    input_tokens: int | None = Field(default=None, ge=512, le=1_048_576)
    output_tokens: int | None = Field(default=None, ge=64, le=65_536)
    overlap: int | None = Field(default=None, ge=0, le=4)
    headings: bool | None = None
    verification: bool | None = None

    def dumped(self) -> dict:
        return self.model_dump(exclude_none=True)

    def setting(self, name: str) -> Any:
        value = getattr(self, name, None)
        return DEFAULTS[self.defaults][name] if value is None else value


class BudgetRefused(ValueError):
    """The pinned budgets cannot be honored here, or no valid minimum request fits them. Nothing is clipped."""


class RecordConflict(ValueError):
    """A published execution or discovery record belongs to other inputs, or a different one was published first."""


# --- budgets, calls and the write-once records -----------------------------------------------------------------------

@dataclass
class _Budget:
    chat: Router
    counters: dict
    stages: dict[str, dict]  # stage -> {role, input_tokens, output_tokens}
    check: Callable[[], None]

    def fits(self, stage: str, system: str, user: str, schema: dict) -> bool:
        return self.counters[ROLE[stage]].request_tokens(system, user, schema) <= self.stages[stage]["input_tokens"]

    def ask(self, stage: str, record: int | None, system: str, user: str, schema: dict, calls: list,
            issues: list) -> dict | None:
        """One counted call after the cancellation check; None when it failed or its reply is not the object asked."""
        self.check()
        answer, attempts = complete(self.chat, stage=stage, record=record, system=system, user=user, schema=schema,
                                    max_tokens=self.stages[stage]["output_tokens"],
                                    counter=self.counters[ROLE[stage]])
        calls += attempts
        if not attempts[-1].ok:
            issues.append(Issue("call_failed", attempts[-1].error or f"{stage} call failed", record))
            return None
        if not isinstance(answer, dict) or any(name not in answer for name in schema.get("required", [])):
            issues.append(Issue("reply_malformed", f"the {stage} reply is not the requested object", record))
            return None
        return answer


def digest(record: dict) -> str:
    """The digest a record is published and embedded under: SHA-256 of its canonical JSON, the file's own bytes."""
    return hashlib.sha256(canonical_json(record)).hexdigest()


def _published(path: Path | None, make: Callable[[], dict], reusable: Callable[[dict], None]) -> dict:
    """The record already at `path` once `reusable` accepts it; otherwise `make()`'s, published there write-once."""
    if path is not None and path.exists():
        existing = json.loads(path.read_bytes())
        reusable(existing)
        return existing
    record = make()
    if path is not None:
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            publish_once(path, canonical_json(record))
        except FileExistsError as error:
            raise RecordConflict(f"another attempt published a different {path.name} for this extraction") from error
    return record


IDENTITY = ("version", "extraction_id", "source", "schema_sha256", "method", "defaults", "models", "prompt_version",
            "discovery_version")


def _execution(extraction_id: str | None, evidence: Evidence, schema: Schema, options: UnifiedOptions,
               chat: Router, counters: dict) -> dict:
    """The execution record: the pins, and each stage's effective budget resolved from its role's served context."""
    stages = {}
    for stage, reserve in DEFAULTS[options.defaults]["reserves"].items():
        context = counters[ROLE[stage]].context_tokens
        if type(context) is not int or context <= 0:
            raise BudgetRefused(f"the {ROLE[stage]} model's server reports no context size to budget against")
        output = options.output_tokens or reserve
        if (options.input_tokens or 0) + output > context:
            raise BudgetRefused(f"input {options.input_tokens} + reply {output} tokens exceed the {ROLE[stage]} "
                                f"model's served context of {context}")
        stages[stage] = {"role": ROLE[stage], "input_tokens": options.input_tokens or context - output,
                         "output_tokens": output}
    return {"version": RECORD_VERSION, "extraction_id": extraction_id,
            "source": {"run_id": evidence.run_id, "generation": evidence.generation, "digest": evidence.digest},
            "schema_sha256": digest(schema.model_dump(by_alias=True, exclude_none=True)),
            "method": options.dumped(), "defaults": DEFAULTS[options.defaults],
            "effective": {name: options.setting(name) for name in ("overlap", "headings", "verification", "splits")}
            | {"stages": stages},
            "models": chat.models, "prompt_version": PROMPT_VERSION, "discovery_version": discovery.VERSION,
            "tokenizers": {role: {**counter.identity(), "context_tokens": counter.context_tokens}
                           for role, counter in counters.items()}}


def _honorable(fresh: dict, counters: dict) -> Callable[[dict], None]:
    def check(existing: dict) -> None:
        if any(existing.get(key) != fresh[key] for key in IDENTITY):
            raise RecordConflict("the published catalog-execution.json pins other inputs than this request")
        for role, pinned in existing["tokenizers"].items():
            if {**pinned, "context_tokens": None} != {**fresh["tokenizers"][role], "context_tokens": None}:
                raise BudgetRefused(f"budget_unhonorable: the {role} tokenizer is no longer the one pinned")
        for stage, budget in existing["effective"]["stages"].items():
            context = counters[budget["role"]].context_tokens
            if budget["input_tokens"] + budget["output_tokens"] > context:
                raise BudgetRefused(f"budget_unhonorable: the pinned {stage} budget of {budget['input_tokens']} + "
                                    f"{budget['output_tokens']} tokens exceeds the served context of {context}")
    return check


def _discovery_reusable(execution_sha256: str, evidence: Evidence) -> Callable[[dict], None]:
    texts = {passage.id: passage.text for passage in (*evidence.passages, *evidence.withheld)}

    def check(existing: dict) -> None:
        if existing.get("version") != discovery.VERSION or existing.get("execution_sha256") != execution_sha256:
            raise RecordConflict("the published catalog-discovery.json was made for another execution record")
        for row in (*existing["ledger"], *(each for entry in existing["entries"] for each in entry["ranges"])):
            if not 0 <= row["start"] < row["end"] <= len(texts.get(row["segment"], "")):
                raise RecordConflict("the published catalog-discovery.json names text this source does not have")
    return check


def _call_json(call: Call) -> dict:
    """A call as a record keeps it: whole milliseconds, so the record's canonical bytes hold no float."""
    dumped = asdict(call)
    dumped["milliseconds"] = round(dumped.pop("seconds") * 1000)
    return dumped


def _issue_json(issue: Issue) -> dict:
    return {**asdict(issue), "path": list(issue.path) if issue.path else None}


# --- extraction ----------------------------------------------------------------------------------------------------

def extract(run_dir: Path | None, evidence: Evidence, request, chat: Router, *, counter=None, chunks: int = 1,
            before_entry: Callable[[], None] | None = None, extraction_id: str | None = None) -> dict:
    """The version 3 artifact for `request` (the validated `run.ExtractRequest`) over `evidence`. With an
    `extraction_id` the execution and discovery records are published under `run_dir` and reused on re-execution;
    without one (the CLI) they live only in the artifact. `before_entry` is called before every model call and before
    returning; what it raises ends the extraction. Entries run `chunks` at a time, assembled in source order."""
    started, clock = datetime.now(UTC).isoformat(), time.monotonic()
    schema, options = request.schema_, request.options.unified
    counters = counter if isinstance(counter, dict) else (counters_for(chat) if counter is None
                                                           else dict.fromkeys(("fields", "reasoning"), counter))
    check = before_entry or (lambda: None)
    check()
    directory = run_dir / "extractions" / extraction_id if run_dir is not None and extraction_id else None
    fresh = _execution(extraction_id, evidence, schema, options, chat, counters)
    execution = _published(directory / "catalog-execution.json" if directory else None, lambda: fresh,
                           _honorable(fresh, counters))
    execution_sha256 = digest(execution)
    effective = execution["effective"]
    budget = _Budget(chat, counters, effective["stages"], check)

    def discover() -> dict:
        body = discovery.discover(evidence, schema.record_description, partial(budget.fits, "discovery"),
                                  partial(budget.ask, "discovery"), overlap=effective["overlap"],
                                  splits=effective["splits"])
        if body is None:
            raise BudgetRefused("not even one character of source fits a discovery request beside its instructions")
        return {"version": discovery.VERSION, "execution_sha256": execution_sha256, "entries": body["entries"],
                "ledger": body["ledger"], "windows": body["windows"],
                "issues": [_issue_json(issue) for issue in body["issues"]],
                "calls": [_call_json(call) for call in body["calls"]]}
    found = _published(directory / "catalog-discovery.json" if directory else None, discover,
                       _discovery_reusable(execution_sha256, evidence))
    run = _Run(schema, budget, {passage.id: passage.text for passage in evidence.passages}, effective)
    halt = threading.Event()

    def one(numbered: tuple[int, dict]) -> _Work | None:
        if halt.is_set():
            return None
        try:
            return run.entry(*numbered)
        except BaseException:
            halt.set()
            raise
    with ThreadPoolExecutor(max_workers=max(1, chunks), thread_name_prefix="catalog-entry") as pool:
        futures = [pool.submit(one, numbered) for numbered in enumerate(found["entries"])]
    for future in futures:  # the first failure in entry order, once every entry has stopped
        if (error := future.exception()) is not None:
            raise error
    document = run.document(evidence) if schema.document_nodes else None
    check()
    return _artifact(evidence, request, chat, started, clock, execution, found,
                     [future.result() for future in futures], document)


# --- candidates ----------------------------------------------------------------------------------------------------

@dataclass
class _Found:
    """One candidate a window returned, as code checked it."""
    path: tuple                       # below the record: field names, and list positions local to the window
    value: Any
    quote: str | None
    window: int
    spans: list[Span] = field(default_factory=list)
    alternatives: list[list[Span]] = field(default_factory=list)
    support: str | None = None        # literal | supporting
    kind: str = "candidate"           # candidate, then accepted | proposed | rejected
    reason: str | None = None
    item: tuple | None = None         # (list path, window, local position) of the outermost list item it is in
    anchor: tuple | None = None       # that item's occurrence in the entry, when it was located exactly once


def _leaf(node: Node) -> dict:
    return {"type": ["object", "null"], "properties": {
        "value": json_schema([node])["properties"][node.name], "quote": {"type": "string"}},
        "required": ["value", "quote"], "additionalProperties": False}


def candidates_schema(nodes: list[Node]) -> dict:
    """The reply schema of an entry or document call: a `{value, quote}` candidate or null at every scalar."""
    return {"type": "object", "properties": {node.name: _candidate(node) for node in nodes},
            "required": [node.name for node in nodes], "additionalProperties": False}


def _candidate(node: Node) -> dict:
    if node.type == "array" and node.item_type is not None:
        return {"type": ["array", "null"], "items": _leaf(Node(id=node.id, name=node.name, type=node.item_type))}
    if node.type == "array":
        item = candidates_schema(node.children or [])
        return {"type": ["array", "null"], "items": {**item, "properties": {**item["properties"],
                ITEM: {"type": ["string", "null"]}}, "required": [*item["required"], ITEM]}}
    if node.type == "object":
        return {**candidates_schema(node.children or []), "type": ["object", "null"]}
    return _leaf(node)


def _unspaced(char: str) -> bool:
    """A character of a script written without spaces between words, where no word boundary can be required."""
    return unicodedata.name(char, "").startswith(("CJK", "HIRAGANA", "KATAKANA", "THAI", "LAO", "KHMER", "MYANMAR",
                                                  "TIBETAN", "IDEOGRAPHIC"))


def located(view: BlockText, text: str, *, within: tuple[int, int] | None = None,
            numeric: bool = False) -> list[list[Span]]:
    """`locate`, which requires word boundaries; text that starts or ends in a script written without spaces also
    where it occurs unbounded."""
    found = locate(view, text, within=within, numeric=numeric)
    edge = text.strip()
    if found or numeric or not edge or not (_unspaced(edge[0]) or _unspaced(edge[-1])):
        return found
    return [_spans(view, start, end) for start, end in occurrences(view.text, edge)
            if within is None or within[0] <= start and end <= within[1]]


def _key(spans: list[Span]) -> tuple:
    return tuple((span.segment_id, span.start, span.end) for span in spans)


def _field_path(path: tuple) -> tuple:
    return tuple(step for step in path if isinstance(step, str))


class _Checker:
    """Checks one window's candidates against `view`: an entry's whole text, or a document window's shown text."""

    def __init__(self, view: BlockText, shown: tuple[int, int], window: int, nodes: list[Node]):
        self.view, self.shown, self.window, self.nodes = view, shown, window, nodes

    def reply(self, answer: dict) -> list[_Found]:
        return [found for node in self.nodes for found in self._field((node.name,), node, answer.get(node.name))]

    def _rejected(self, path, value, reason, item=None, anchor=None) -> _Found:
        return _Found(path, value, None, self.window, kind="rejected", reason=reason, item=item, anchor=anchor)

    def _field(self, path: tuple, node: Node, answer: Any, item: tuple | None = None,
               anchor: tuple | None = None) -> list[_Found]:
        if answer is None:
            return []
        if node.type == "object":
            if not isinstance(answer, dict):
                return [self._rejected(path, answer, "malformed_candidate", item, anchor)]
            return [found for child in node.children or []
                    for found in self._field((*path, child.name), child, answer.get(child.name), item, anchor)]
        if node.type != "array":
            return [self._scalar(path, node, answer, item, anchor)]
        if not isinstance(answer, list):
            return [self._rejected(path, answer, "malformed_candidate", item, anchor)]
        found: list[_Found] = []
        for index, entry in enumerate(answer):
            inner = item or (path, self.window, index)
            if node.item_type is not None:
                found.append(self._scalar((*path, index), Node(id=node.id, name=node.name, type=node.item_type),
                                          entry, inner, anchor))
            elif not isinstance(entry, dict):
                found.append(self._rejected((*path, index), entry, "malformed_candidate", inner, anchor))
            else:
                spot = anchor
                if item is None and isinstance(entry.get(ITEM), str) and entry[ITEM].strip():
                    places = self._places(entry[ITEM])
                    spot = _key(places[0]) if len(places) == 1 else None
                found += [each for child in node.children or []
                          for each in self._field((*path, index, child.name), child, entry.get(child.name), inner,
                                                  spot)]
        return found

    def _places(self, text: str, within: tuple[int, int] | None = None, numeric: bool = False) -> list[list[Span]]:
        """Occurrences in the view, those inside the text this window showed first."""
        places = located(self.view, text, within=within, numeric=numeric)
        return sorted(places, key=lambda spans: not self.shown[0] <= raw_range(self.view, spans)[0] < self.shown[1])

    def _scalar(self, path: tuple, node: Node, candidate: Any, item: tuple | None, anchor: tuple | None) -> _Found:
        if not isinstance(candidate, dict):
            return self._rejected(path, candidate, "malformed_candidate", item, anchor)
        value, quote = candidate.get("value"), candidate.get("quote")
        found = self._rejected(path, value, None, item, anchor)
        found.quote = quote if isinstance(quote, str) else None
        typed = typed_value(value, node)
        if typed is None:
            found.reason = "type_mismatch"
            return found
        found.value = typed
        quoted = self._places(quote) if found.quote and found.quote.strip() else []
        if not quoted:
            found.reason = "quote_not_in_source" if found.quote and found.quote.strip() else "no_quote"
            return found
        numeric = isinstance(typed, (int, float)) and not isinstance(typed, bool)
        literal: list[list[Span]] = []
        for spans in quoted:
            for text in forms(typed):
                literal += [each for each in self._places(text, raw_range(self.view, spans), numeric)
                            if each not in literal]
        if literal:
            found.support, found.spans, found.alternatives = "literal", literal[0], literal[1:]
        elif isinstance(typed, bool) or node.allowed_values is not None or \
                evidence_policy(self.nodes, _field_path(path)) == "derived":
            found.support, found.spans, found.alternatives = "supporting", quoted[0], quoted[1:]
        else:
            found.reason, found.spans = "value_not_in_quote", quoted[0]
            return found
        found.kind, found.reason = "candidate", None
        return found


# --- prompts -------------------------------------------------------------------------------------------------------

ENTRY = ("You extract structured data from one record of a source document. A record is: {description}\n{notes}"
         "Answer every field with null when the record does not give it, or with an object: \"value\" (typed as the "
         "field) and \"quote\" (the exact text of the record that states or supports the value, copied character "
         "for character). For each object in a list also give \"_item_text\": the exact text of the record where that "
         "item appears, or null. Read values from the RECORD text; EARLIER and LATER text belongs to the same record "
         "and is shown so that a value crossing the cut is whole; CONTEXT is not part of the record. Never invent a "
         "value. Return only the JSON object.")
VERIFY = ("You check values extracted from one record of a source document. A record is: {description}\n{notes}"
          "For each candidate answer \"supported\" when the record text states that value for that field of this "
          "record, \"unsupported\" when it does not (it says something else, or the value belongs to another record or "
          "only to the context), or \"unclear\". Judge only from the text shown. Return only the JSON object.")
ARBITRATION = ("Several verified candidate values were found in one record of a source document for one field. "
               "Choose the label of the candidate whose value is correct for the field, given its source text, or "
               "NONE when none is. Return only the JSON object.")
DOCUMENT = ("You extract fields that describe a whole source document, not one record.\n{notes}"
            "Answer every field with null when the text shown does not give it, or with an object: \"value\" (typed "
            "as the field) and \"quote\" (the exact supporting text, copied character for character). For each object "
            "in a list also give \"_item_text\": the exact text where that item appears, or null. Never invent a "
            "value. Return only the JSON object.")
VERDICTS = {"supported": ("accepted", None), "unsupported": ("rejected", "verification_rejected"),
            "unclear": ("proposed", "verification_unclear")}


def _notes(nodes: list[Node]) -> str:
    return "".join(f"{line}\n" for line in notes(nodes))


def _user(window: Window, texts: dict[str, str], marker: str) -> str:
    parts = ([f"### CONTEXT (not part of the record)\n{text_of(window.heading, texts)}"] if window.heading else []) + \
        ([f"### EARLIER TEXT\n{text_of(window.before, texts)}"] if window.before else []) + \
        [f"### {marker}\n{text_of(window.primary, texts)}\n### END {marker}"] + \
        ([f"### LATER TEXT\n{text_of(window.after, texts)}"] if window.after else [])
    return "\n\n".join(parts)


def _view(units: list[Unit], texts: dict[str, str]) -> BlockText:
    return BlockText.of([(unit.segment, texts[unit.segment], Span(segment_id=unit.segment, start=unit.start,
                                                                   end=unit.end)) for unit in units])


def _position(units: list[Unit], segment: str, offset: int) -> int:
    """Where a raw offset of `segment` lies in the view built from `units`."""
    at = 0
    for unit in units:
        if unit.segment == segment and unit.start <= offset <= unit.end:
            return at + offset - unit.start
        at += unit.end - unit.start + 1
    return 0


# --- one entry and the document ------------------------------------------------------------------------------------

@dataclass
class _Work:
    """What one entry's (or the document's) windows produced."""
    found: list[_Found] = field(default_factory=list)
    record: dict = field(default_factory=dict)
    contest: list[dict] = field(default_factory=list)
    items: list[dict] = field(default_factory=list)
    omitted: list[dict] = field(default_factory=list)
    calls: list = field(default_factory=list)
    issues: list[Issue] = field(default_factory=list)
    windows: int = 0
    failed: int = 0
    undecided: int = 0
    values: dict = field(default_factory=dict)
    conflicts: list = field(default_factory=list)



class _Run:
    def __init__(self, schema: Schema, budget: _Budget, texts: dict[str, str], effective: dict):
        self.schema, self.budget, self.texts, self.effective = schema, budget, texts, effective
        self.nodes = schema.record_nodes

    def _read(self, stage: str, number: int | None, units: list[Unit], system: str, schema: dict, marker: str,
              heading: tuple[Unit, ...], out: _Work) -> list[tuple[Window, dict | None]]:
        """Every window's reply in source order; a failed window is halved up to the versioned number of times."""
        def fits(window: Window) -> bool:
            user = _user(window, self.texts, marker) + "\n\nReturn the JSON object now."
            return self.budget.fits(stage, system, user, schema)
        windows = plan(units, self.texts, fits, overlap=self.effective["overlap"], heading=heading)
        if windows is None:
            raise BudgetRefused(f"not even one character of source fits a {stage} request beside its instructions")
        replies = []
        queue = [(window, 0) for window in windows]
        while queue:
            window, depth = queue.pop(0)
            user = _user(window, self.texts, marker) + "\n\nReturn the JSON object now."
            answer = self.budget.ask(stage, number, system, user, schema, out.calls, out.issues)
            if answer is None and len(window.primary) > 1 and depth < self.effective["splits"]:
                halves = split(window, self.texts, fits, overlap=self.effective["overlap"])
                queue[0:0] = [(half, depth + 1) for half in halves]
                continue
            out.omitted += [{"stage": stage, "record": number, "kind": kind, **ranges_json([unit])[0]}
                            for kind, unit in window.omitted]
            if answer is None:
                out.failed += 1
                out.issues.append(Issue(f"{stage}_window_failed", f"no valid {stage} reply for "
                                        f"{discovery._where(window)}", number))
            replies.append((window, answer))
        out.windows += len(replies)
        return replies

    def entry(self, number: int, entry: dict) -> _Work:
        out = _Work()
        if not self.nodes:
            return out
        units = [Unit(each["segment"], each["start"], each["end"]) for each in entry["ranges"]]
        heading = tuple(Unit(each["segment"], each["start"], each["end"]) for each in entry["context"]) \
            if self.effective["headings"] else ()
        system = ENTRY.format(description=self.schema.record_description, notes=_notes(self.nodes))
        replies = self._read("entry", number, units, system, candidates_schema(self.nodes), "RECORD", heading, out)
        view = _view(units, self.texts)
        found: list[_Found] = []
        for index, (window, answer) in enumerate(replies):
            if answer is not None:
                first, last = (*window.before, *window.primary)[0], (*window.primary, *window.after)[-1]
                shown = (_position(units, first.segment, first.start), _position(units, last.segment, last.end))
                found += _Checker(view, shown, index, self.nodes).reply(answer)
        out.found, out.items = _merged(found, view, _edges(replies), out.issues, number)
        self._verify(number, replies, out)
        out.contest = self._settle(number, out, view)
        _renumbered(out.found)
        out.record = conform(_placed(out.found), self.nodes)
        return out

    def _verify(self, number: int, replies: list[tuple[Window, dict | None]], out: _Work) -> None:
        """Verdicts on the candidates, batched per window in counted requests that are halved on overflow or failure."""
        for found in out.found:
            if found.kind != "candidate":
                continue
            policy = evidence_policy(self.nodes, _field_path(found.path))
            if policy != "quoted":
                found.kind, found.reason = "proposed", f"evidence_policy_{policy}"
            elif not self.effective["verification"]:
                found.kind, found.reason = "proposed", "verification_disabled"
        system = VERIFY.format(description=self.schema.record_description, notes=_notes(self.nodes))
        for index, (window, _) in enumerate(replies):
            batch = [found for found in out.found if found.kind == "candidate" and found.window == index]
            pending = [batch] if batch else []
            while pending:
                group = pending.pop(0)
                labels = [f"C{n}" for n in range(1, len(group) + 1)]
                user = _user(window, self.texts, "RECORD") + "\n\n### CANDIDATES\n" + "\n".join(
                    f"{label}: {'.'.join(str(step) for step in _field_path(found.path))} = "
                    f"{json.dumps(found.value, ensure_ascii=False)} (quoted: {json.dumps(found.quote, ensure_ascii=False)})"
                    for label, found in zip(labels, group, strict=True)) + "\n\nReturn the JSON object now."
                schema = {"type": "object", "properties": {label: {"type": "string", "enum": list(VERDICTS)}
                                                           for label in labels},
                          "required": labels, "additionalProperties": False}
                answer = self.budget.ask("verification", number, system, user, schema, out.calls, out.issues) \
                    if self.budget.fits("verification", system, user, schema) else None
                if answer is not None and all(answer.get(label) in VERDICTS for label in labels):
                    for label, found in zip(labels, group, strict=True):
                        found.kind, found.reason = VERDICTS[answer[label]]
                elif len(group) > 1:
                    pending[0:0] = [group[:len(group) // 2], group[len(group) // 2:]]
                else:
                    group[0].kind, group[0].reason = "proposed", "verification_unresolved"
                    out.undecided += 1

    def _settle(self, number: int, out: _Work, view: BlockText) -> list[dict]:
        """One accepted value per scalar field: equal values join as alternative places; values that disagree go to
        one counted arbitration over all of them, or all stay unresolved proposals."""
        groups: dict[tuple, list[_Found]] = {}
        for found in out.found:
            if found.kind == "accepted" and found.item is None:
                groups.setdefault(found.path, []).append(found)
        contest = []
        for path, group in groups.items():
            values: dict[str, list[_Found]] = {}
            for found in group:
                values.setdefault(json.dumps(found.value, sort_keys=True), []).append(found)
            for same in values.values():
                first, *rest = same
                first.alternatives += [spans for each in rest for spans in (each.spans, *each.alternatives)
                                       if spans != first.spans and spans not in first.alternatives]
                for each in rest:
                    out.found.remove(each)
            if len(values) == 1:
                continue
            candidates = [same[0] for same in values.values()]
            labels = [f"C{n}" for n in range(1, len(candidates) + 1)]
            user = f"### Field\n{'.'.join(path)}\n\n### Candidates\n" + "\n".join(
                f"{label}: {json.dumps(found.value, ensure_ascii=False)} — …{_snippet(view, found.spans)}…"
                for label, found in zip(labels, candidates, strict=True)) + "\n\nReturn the JSON object now."
            schema = {"type": "object", "properties": {"choice": {"type": "string", "enum": [*labels, "NONE"]}},
                      "required": ["choice"], "additionalProperties": False}
            answer = self.budget.ask("arbitration", number, ARBITRATION, user, schema, out.calls, out.issues) \
                if self.budget.fits("arbitration", ARBITRATION, user, schema) else None
            choice = answer.get("choice") if answer else None
            chosen = labels.index(choice) if choice in labels else None
            for position, found in enumerate(candidates):
                if position != chosen:
                    found.kind, found.reason = "proposed", "competing_value"
            if chosen is None:
                out.issues.append(Issue("competitors_unresolved", f"{len(candidates)} verified values disagree",
                                        number, ("records", number, *path)))
            contest.append({"path": ["records", number, *path], "outcome": "unresolved" if chosen is None
                            else "arbitrated", "chosen": chosen,
                            "candidates": [{"value": found.value, "spans": spans_json(found.spans),
                                            "window": found.window} for found in candidates]})
        return contest

    def document(self, evidence: Evidence) -> _Work:
        """Document-level fields from their own windows over every admitted nonblank range; never verified."""
        nodes = self.schema.document_nodes
        out = _Work()
        system = DOCUMENT.format(notes=_notes(nodes))
        units = discovery.units_of(evidence.passages)
        replies = self._read("document", None, units, system, candidates_schema(nodes), "SOURCE", (), out)
        per_window = []
        for index, (window, answer) in enumerate(replies):
            if answer is None:
                continue
            shown = [*window.before, *window.primary, *window.after]
            found = _Checker(_view(shown, self.texts), (0, 0), index, nodes).reply(answer)
            out.found += found
            per_window.append(conform(_placed(found, "candidate"), nodes))
        out.values, out.conflicts = reconcile_values(per_window) if per_window else ({}, [])
        out.values = conform(out.values, nodes)
        for found in out.found:
            if found.kind == "candidate":
                found.kind, found.reason = "proposed", "document_unverified"
        return out


def _renumbered(found: list[_Found]) -> None:
    """List positions made dense over the items that kept an accepted value, at every list level, as `conform` compacts
    the record's lists: evidence then names the item it supports. An item left without one takes a null position."""
    accepted = [leaf.path for leaf in found if leaf.kind == "accepted"]

    def remap(path: tuple) -> tuple:
        steps: list = []
        for depth, step in enumerate(path):
            if isinstance(step, int):
                kept = sorted({other[depth] for other in accepted if len(other) > depth and other[:depth] == path[:depth]})
                if step not in kept:
                    return (*steps, None, *path[depth + 1:])
                step = kept.index(step)
            steps.append(step)
        return tuple(steps)
    paths = [remap(leaf.path) for leaf in found]
    for leaf, path in zip(found, paths, strict=True):
        leaf.path = path


def _placed(found: list[_Found], kind: str = "accepted") -> dict:
    record: dict = {}
    for each in found:
        if each.kind == kind and None not in each.path:
            place(record, each.path, each.value)
    return record


def _snippet(view: BlockText, spans: list[Span]) -> str:
    start, end = raw_range(view, spans)
    return view.text[max(0, start - 80):end + 80].replace("\n", " ")


# --- list items ----------------------------------------------------------------------------------------------------

def _edges(replies: list[tuple[Window, dict | None]]) -> dict[int, list[Unit]]:
    """Per window of an entry read in several, the units where an item it saw may continue in another window. On a
    side with overlap, that is the context shown there: an item whose evidence reaches into it crosses the cut. On a
    side without (overlap 0, or context left out to fit), the window cannot see past its own edge unit, so an item
    there may continue unseen."""
    last = len(replies) - 1
    return {index: [*(window.before or window.primary[:1]) * (index > 0),
                    *(window.after or window.primary[-1:]) * (index < last)]
            for index, (window, _) in enumerate(replies)} if last else {}


def _spans_of(leaves: list[_Found]) -> list[Span]:
    anchor = [Span(segment_id=s, start=a, end=b) for s, a, b in leaves[0].anchor or ()]
    return anchor + [span for leaf in leaves for span in leaf.spans]


def _merged(found: list[_Found], view: BlockText, edges: dict[int, list[Unit]], issues: list[Issue],
            number: int) -> tuple[list[_Found], list[dict]]:
    """The candidates with equal observations joined, and each list's observed, resolved and partial item counts.

    A list item is one item across windows only when its windows are distinct and every one saw the same occurrence,
    values and support; one window's matching items are kept apart and flagged. An unmatched item that touches a window
    cut may be incomplete: its values become partial proposals under a null position, never joined to another item."""
    kept: list[_Found] = []
    items: dict[tuple, list[_Found]] = {}
    for each in found:
        if each.item is not None:
            items.setdefault(each.item, []).append(each)
        elif not any(each.path == other.path and each.value == other.value and each.spans == other.spans
                     and each.kind == other.kind for other in kept):
            kept.append(each)
    groups: dict[tuple, list[tuple]] = {}
    counts: dict[tuple, dict] = {}
    for key, leaves in items.items():
        path = key[0]
        scalar = len(leaves) == 1 and len(leaves[0].path) == len(path) + 1
        identity = _key(leaves[0].spans) if scalar else leaves[0].anchor
        values = tuple(sorted((_field_path(leaf.path[len(path) + 1:]), json.dumps(leaf.value, sort_keys=True),
                               _key(leaf.spans)) for leaf in leaves if leaf.kind == "candidate"))
        groups.setdefault((path, identity if values else None, values), []).append(key)
        counts.setdefault(path, {"observed": 0, "resolved": 0, "partial": 0})["observed"] += 1
    placed: dict[tuple, list[tuple]] = {}
    for (path, identity, values), keys in groups.items():
        windows = [key[1] for key in keys]
        if identity is not None and len(keys) > 1 and len(set(windows)) == len(windows):
            placed.setdefault(path, []).append(keys[0])  # one whole item that several windows saw alike
            counts[path]["resolved"] += 1
            continue
        if values and len(keys) > 1:  # without one located occurrence per window, equal items may be one or several
            issues.append(Issue("item_identity_ambiguous", f"{len(keys)} list items share values and support but no "
                                "one-to-one occurrence; each is kept", number, ("records", number, *path)))
        for key in keys:
            leaves = items[key]
            scalar = len(leaves) == 1 and len(leaves[0].path) == len(path) + 1
            if not scalar and any(span.segment_id == unit.segment and span.start < unit.end and unit.start < span.end
                                  for span in _spans_of(leaves) for unit in edges.get(key[1], [])):
                counts[path]["partial"] += 1
                for leaf in leaves:
                    leaf.path = (*path, None, *leaf.path[len(path) + 1:])
                    if leaf.kind == "candidate":
                        leaf.kind, leaf.reason = "proposed", "partial_item"
                    kept.append(leaf)
                continue
            placed.setdefault(path, []).append(key)
            counts[path]["resolved"] += 1
    for path, keys in placed.items():
        def first(key: tuple) -> tuple:
            spans = _spans_of(items[key])
            start = min((raw_range(view, [span])[0] for span in spans), default=len(view.text))
            return start, key[1], key[2]
        for position, key in enumerate(sorted(keys, key=first)):
            for leaf in items[key]:
                leaf.path = (*path, position, *leaf.path[len(path) + 1:])
                kept.append(leaf)
    return kept, [{"path": ["records", number, *path], **count} for path, count in counts.items()]


# --- the artifact --------------------------------------------------------------------------------------------------

def _link(found: _Found, number: int, passages: dict) -> dict:
    shared = evidence_link(Outcome("accepted", ("records", number, *found.path), found.value, spans=found.spans,
                                   alternatives=found.alternatives), passages, {})
    keep = ("path", "segment", "page", "bbox_pt", "cell", "precision", "hits", "spans", "alternatives", "raw")
    return {**{key: shared[key] for key in keep}, "verbatim": found.support == "literal", "support": found.support,
            "linked_by": "verification",
            "item": [{"segment": s, "start": a, "end": b} for s, a, b in found.anchor] if found.anchor else None}


def _review(found: _Found, number: int | None, texts: dict[str, str]) -> dict:
    return {"path": ["records", number, *found.path] if number is not None else list(found.path),
            "value": found.value, "quote": found.quote, "support": found.support, "spans": spans_json(found.spans),
            "alternatives": [spans_json(spans) for spans in found.alternatives], "window": found.window,
            "reason": found.reason,
            "raw": "".join(texts[span.segment_id][span.start:span.end] for span in found.spans) or None,
            "item": {"window": found.item[1], "index": found.item[2]} if found.item and None in found.path else None}


def _total(values) -> int | None:
    known = [value for value in values if value is not None]
    return sum(known) if known else None


def _artifact(evidence: Evidence, request, chat: Router, started: str, clock: float, execution: dict,
              found: dict, entries: list[_Work], document: _Work | None) -> dict:
    schema = request.schema_
    texts = {passage.id: passage.text for passage in evidence.passages}
    passages = {passage.id: passage for passage in evidence.passages}
    records = [merge(entry.record, document.values if document else {}, evidence.source_name, schema)
               for entry in entries]
    calls = [Call(**{key: value for key, value in call.items() if key != "milliseconds"},
                  seconds=call["milliseconds"] / 1000) for call in found["calls"]] + \
        [call for work in (*entries, *([document] if document else [])) for call in work.calls]
    unresolved = [row for row in found["ledger"] if row["disposition"] == "unresolved"]
    processing = {
        "discovery": {"windows": len(found["windows"]), "failed": sum(not window["ok"] for window in found["windows"])},
        "entries": {"entries": len(entries), "windows": sum(each.windows for each in entries),
                    "failed": sum(each.failed for each in entries)},
        "verification": {"enabled": execution["effective"]["verification"],
                         "undecided": sum(each.undecided for each in entries)},
        "document": {"applicable": document is not None, "windows": document.windows if document else 0,
                     "failed": document.failed if document else 0}}
    completeness = {
        "accounting": True,  # every nonblank canonical range has one disposition in the ledger
        "boundaries": not unresolved and all(entry["end"] == "validated" for entry in found["entries"]),
        "processing": not any(processing[stage]["failed"] for stage in ("discovery", "entries", "document"))
        and not processing["verification"]["undecided"],
        "evidence": not any(each.kind == "proposed" for entry in entries for each in entry.found)
        and not any(contest["outcome"] == "unresolved" for entry in entries for contest in entry.contest),
        "recall": "unmeasured"}
    result = {
        "extraction_version": EXTRACTION_VERSION, "run_id": evidence.run_id, "generation": evidence.generation,
        "digest": evidence.digest, "strategy": "catalog", "model": chat.model, "models": chat.models,
        "prompt_version": PROMPT_VERSION, "schema": schema.model_dump(by_alias=True, exclude_none=True),
        "options": request.options.dumped(), "started": started, "seconds": round(time.monotonic() - clock, 3),
        "execution": execution, "execution_sha256": digest(execution),
        "discovery": found, "discovery_sha256": digest(found),
        "records": records,
        "evidence": [_link(each, number, passages) for number, entry in enumerate(entries) for each in entry.found
                     if each.kind == "accepted"],
        "proposed": [_review(each, number, texts) for number, entry in enumerate(entries) for each in entry.found
                     if each.kind == "proposed"],
        "rejected": [_review(each, number, texts) for number, entry in enumerate(entries) for each in entry.found
                     if each.kind == "rejected"],
        "competitors": [contest for entry in entries for contest in entry.contest],
        "items": [count for entry in entries for count in entry.items],
        "document": {"status": "unverified", "applicable": document is not None,
                     "candidates": [_review(each, None, texts) for each in (document.found if document else [])],
                     "conflicts": document.conflicts if document else []},
        "context_omitted": [row for work in (*entries, *([document] if document else [])) for row in work.omitted],
        "ungrounded": [], "unverified": [node.name for node in schema.document_nodes],
        "processing": processing, "completeness": completeness,
        "complete": completeness["boundaries"] and completeness["processing"] and completeness["evidence"],
        "issues": [*found["issues"], *(_issue_json(issue) for work in (*entries, *([document] if document else []))
                                       for issue in work.issues)],
        "calls": [asdict(call) for call in calls],
        "tokens": {"input": _total(call.input_tokens for call in calls),
                   "output": _total(call.output_tokens for call in calls)},
    }
    result["fingerprint"] = hashlib.sha256(canonical_json({
        "generation": evidence.generation, "digest": evidence.digest, "schema": result["schema"],
        "options": result["options"], "models": chat.models, "prompt_version": PROMPT_VERSION,
        "execution_sha256": result["execution_sha256"], "discovery_sha256": result["discovery_sha256"]})).hexdigest()
    return result
