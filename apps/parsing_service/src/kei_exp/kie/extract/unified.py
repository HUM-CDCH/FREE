"""The unified Catalog: one method for every new Catalog Extraction, result version 3.

The request's `options.unified` pins the versioned defaults and any overrides of its five controls (input ceiling,
reply reserve, overlap, heading context, verification). Before any model call the effective per-stage budgets are
resolved from the served context into the execution record; general record discovery (`discovery.py`) follows, and
each entry's work is bound to that discovery's digest. All three live in the artifact. Durable execution resumes from
its own committed call outputs (`retained.py`), never from files beside the run. A request the server refuses is a
failed call of its window; a backend that is not ready ends the planning step.
An instruction-model entry call that loops on whitespace gets one bounded-grammar recovery with the same input
and output budget. Both calls remain recorded; only a successful recovery marks the first call recovered.

Every entry is read whole through counted windows of its own text (overlap within the entry), beside the record-free
lines before it when heading context is on. The fields model returns `{value, quote}` candidates, and `_item_text`
for each object in a list. Code, never the model, checks them: the value conforms to its field, the quote is text of
that entry, and a value is literal where its printed form lies inside the quote; a yes/no, an allowed label or a
derived field may instead be supported by the quoted passage, never by a fabricated literal span. A separate reasoning
request verifies candidates in counted batches; only a supported candidate is accepted. With verification off, or
where the schema's evidence policy asks for none, candidates stay proposals. A single pass (defaults 6) has
verification off and accepts what code grounded, linked as code's (`lexical`); a value whose quote is missing or
found nowhere stays in the record, a proposal without Evidence.

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
from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field, replace
from datetime import UTC, datetime
from functools import partial
from pathlib import Path
from typing import Any, Literal

import requests
from pydantic import BaseModel, ConfigDict, Field

from kei_exp.canonical import canonical_json
from kei_exp.failures import TransientBackendError, classify
from kei_exp.kie.blocks import Span
from kei_exp.kie.extract import discovery, gliformer, tokens
from kei_exp.kie.extract.acceptance import Outcome, typed_value
from kei_exp.kie.extract.calls import MAX_WHITESPACE, Call, complete, looped
from kei_exp.kie.extract.catalog_result import evidence_link, place, spans_json
from kei_exp.kie.extract.contexts import assemble_document, printed_once_in
from kei_exp.kie.extract.discovery import Window, occurrences, plan, ranges_json, split, text_of
from kei_exp.kie.extract.locate import BlockText, _spans, forms, locate, nearly, normalise, printed, raw_range
from kei_exp.kie.extract.llm import bounded
from kei_exp.kie.extract.models import ROLE, Router
from kei_exp.kie.extract.schema import Node, Schema, conform, evidence_policy, json_schema, notes
from kei_exp.kie.extract.stages import Issue, merge
from kei_exp.kie.extract.tokens import counters_for
from kei_exp.kie.extract.windows import Unit
from kei_exp.kie.passages import Evidence
from kei_exp.pagefile import PageTable

EXTRACTION_VERSION = 3
PROMPT_VERSION = 7  # 3: compact discovery places; 4: discovery WINDOW labels name their layout kinds;
# 5: entry, verification and document input retain the horizontal whitespace delimiting empty table cells.
# 6 (defaults 5): verification may correct a scalar, with its complete source quote.
# 7 (defaults 6): the entry call shows the requested value structure and asks for complete values.
PROMPT_VERSIONS = {5: 6, 6: 7}  # pinned per defaults version; earlier versions record 5
RECORD_VERSION = 1  # the execution record's layout
# The entry records' layout and checks, versioned apart from the execution record.
# 2: a value printed in the table row whose cell the quote names is literal there.
# 3: that row is searched cell by cell (a cell spanning rows no longer widens it to them), and only for a quote found in
# exactly one place.
# 4: a list item's values are looked for in its own located occurrence first, so a cell printed in several rows ("Niv.
# 6") is its own row's, never one at a window cut; and text a model copied nearly verbatim is repaired to the source
# (`NEAR`): a quote found nowhere, or a value not printed in its quote, within a few edits of exactly one place.
# 5: an item's unique single-row table occurrence takes priority over repeats in prose; its quoted values are
# located in that row's individual cells first, including repeated partial quotes. A verbatim value continuing
# across segments may extend its partial quote, with every segment kept in the value's evidence.
# 6: an item whose own text is not located (no `_item_text`, or one printed in several rows) is the table row its
# values name, when each value printed in exactly one single-row cell names the same row; its values are then looked
# for in that row first, so a value printed in every row ("Tand, human") is its own row's cell.
ENTRY_VERSION = 6
# How the document-level fields' windows are assembled, in the artifact and its fingerprint. 2: by
# `contexts.assemble_document`, every list occurrence kept (1 was `reconcile_values`' exact union, which dropped equal
# items, a single window's included). 3: an item two windows returned is joined only when their shared source
# prints it as exactly one occurrence.
DOCUMENT_VERSION = 3
ITEM = "_item_text"  # a list item's occurrence in the record: its identity, apart from its values' evidence
# Repair of nearly verbatim text: only a text field's value (not a date, number, yes/no, allowed label or derived field)
# of at least `NEAR` normalised characters, within max(3, length // 50) edits of exactly one place, and only an entry's
# (never a document field's). Measured on one excavation
# report (13 October 2026, NuExtract3-FP8): copies of 75, 478 and 655 characters were off by 3, 8 and 3 edits.
# A single pass keeps it without verification: the repair can only replace a long copy by the source's own text at its
# one place, flagged `quote_repaired`; whether that passage is the field's is the same open question as for any literal
# value, and a value left unrepaired would stay in the record anyway, without Evidence.
NEAR = 40
# The versioned service defaults: engineering choices. Reserves are sized for replies that list many boundaries or
# candidates; Auto input is the served context minus the stage's reserve; heading context and verification on; a failed
# window is halved at most six times. 1: discovery windows cut by the budget alone, one unit of overlap. 2: discovery
# windows never cross a printed page, ingestion's unit (`discovery.groups_of`), three units of overlap. Measured on one
# scanned 3-page catalogue excerpt (29 numbered entries; Qwen3.8-27B and NuExtract3, 7 October 2026, two runs each):
# version 1's single window read each entry's body as record-free, so no find type was extracted (0/29, value accuracy
# 0.52); page windows 16/29 (0.65); windows at ingestion's column cuts 24/29 (0.72), but over the excerpt repeated five
# times (145 entries) they missed 3 starts in a short column, page windows none. Moving to column windows is a new
# version with `"windows": "column"`, once `experiments/extraction/discovery_windows.py --windows column` holds on more
# than this one catalogue. 3: version 2, pipelined: a durable run reads the entries of the windows already read while
# later windows are still asked, and verifies them once discovery has ended (`extract`); the artifact is version 2's
# but for its execution record. 4: version 3, and an entry's reply may use the served context its counted input leaves,
# its reserve the floor that still sizes the windows (`_Budget.ask`); an explicit reply override or a native fields
# model keeps the reserve. Measured on one excavation report (13 October 2026, NuExtract3-FP8, 32768-token context): a
# record whose reply passed the 4096-token reserve was read again in halves, and an item at their cut was lost.
# 5: discovery uses the token budget across page breaks; the same verification call may correct scalar candidates
# with source-grounded values. Its reply reserve is 4096 to hold complete passages; list identities stay unchanged.
# 6: version 5 read in a single pass (`single_pass`): the entry call is the only reading of a value, shown the
# requested value structure; code grounds each candidate, and verification is off, so no call reads the scalars
# again. A located candidate is accepted with code's link (`linked_by` lexical), never called verified; one whose
# quote is missing or found nowhere stays in the record, a proposal without Evidence, as does a value of a field whose
# evidence policy is not `quoted`; a located quote that does not print its value still rejects it. Arbitration of
# disagreeing located scalars is kept.
# Switching verification on judges the fixed candidates (`VERIFY`); nothing re-extracts them.
_RESERVES = {"discovery": 4096, "entry": 4096, "verification": 2048, "arbitration": 512, "document": 2048}
DEFAULTS = {1: {"reserves": _RESERVES, "overlap": 1, "headings": True, "verification": True, "splits": 6},
            2: {"reserves": _RESERVES, "overlap": 3, "headings": True, "verification": True, "splits": 6,
                "windows": "page"},
            3: {"reserves": _RESERVES, "overlap": 3, "headings": True, "verification": True, "splits": 6,
                "windows": "page", "pipelined": True},
            4: {"reserves": _RESERVES, "overlap": 3, "headings": True, "verification": True, "splits": 6,
                "windows": "page", "pipelined": True, "entry_reply": "context"},
            5: {"reserves": {**_RESERVES, "verification": 4096}, "overlap": 3, "headings": True,
                "verification": True, "splits": 6, "windows": "budget", "pipelined": True,
                "entry_reply": "context", "corrections": True},
            6: {"reserves": _RESERVES, "overlap": 3, "headings": True, "verification": False, "splits": 6,
                "windows": "budget", "pipelined": True, "entry_reply": "context", "single_pass": True}}


class UnifiedOptions(BaseModel):
    """`options.unified`: the versioned defaults the method was admitted under and the overrides of its controls,
    absent where the defaults apply. Budgets change how primary text is partitioned, never how much of it is read."""
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)  # as Studio's schema: "yes" is no boolean
    defaults: Literal[1, 2, 3, 4, 5, 6]
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


# --- budgets and calls -----------------------------------------------------------------------------------------------

@dataclass
class _Budget:
    chat: Router
    counters: dict
    stages: dict[str, dict]  # stage -> {role, input_tokens, output_tokens}
    spare: frozenset[str] = frozenset()  # stages whose reply may use the context their counted input leaves

    def fits(self, stage: str, system: str, user: str, schema: dict) -> bool:
        return self.counters[ROLE[stage]].request_tokens(system, user, schema) <= self.stages[stage]["input_tokens"]

    def ask(self, stage: str, record: int | None, system: str, user: str, schema: dict, calls: list,
            issues: list, unit: str | None = None, page: int | None = None) -> dict | None:
        """One counted call; None when it failed or its reply is not the object asked.
        A request the server refused (an HTTP 500 on this request) is a failed call of this window, so the window is
        halved or fails alone; a backend that is not ready (`failures.classify`) ends the step for its retry."""
        clock = time.monotonic()
        attempts = []
        counter, ceiling, floor = self.counters[ROLE[stage]], self.stages[stage]["output_tokens"], None
        try:
            if stage in self.spare:  # a durable call's reply is trimmed to what its input leaves once it is captured
                floor = ceiling
                ceiling = counter.context_tokens if self.chat.runtime is not None else \
                    max(floor, counter.context_tokens - counter.request_tokens(system, user, schema))
            answer, attempts = complete(self.chat, stage=stage, record=record, system=system, user=user,
                                        schema=schema, max_tokens=ceiling, counter=counter,
                                        minimum_reply_tokens=floor, unit=unit, page=page)
            # Durable recovery reuses the finalized parent input in CapturePlanner; it must not be recomposed here.
            recovery = (bounded(self.chat.fields, MAX_WHITESPACE) if self.chat.runtime is None and stage == "entry"
                        and len(attempts) == 1 and looped(attempts[-1])
                        and getattr(self.chat.fields, "max_whitespace", None) is None else None)
            if recovery is not None:
                clock = time.monotonic()
                answer, again = complete(replace(self.chat, fields=recovery), stage=stage, record=record,
                    system=system, user=user, schema=schema, max_tokens=ceiling, counter=counter,
                    minimum_reply_tokens=floor, unit=unit, page=page)
                if again[-1].ok:
                    attempts[-1] = replace(attempts[-1], recovered=True)
                attempts += again
        except requests.RequestException as error:
            if isinstance(classify(error), TransientBackendError):
                raise
            status = getattr(error.response, "status_code", None)
            answer = None
            attempts += [Call(stage, record, None, None, time.monotonic() - clock, None, False,
                                           type(error).__name__ + (f": HTTP {status}" if status else ""), None,
                                           counter.context_tokens, ceiling)]
        # A call an earlier attempt saved under a unit carries the number its entry had then.
        calls += attempts if unit is None else [replace(call, record=record) for call in attempts]
        if not attempts[-1].ok:
            issues.append(Issue("call_failed", attempts[-1].error or f"{stage} call failed", record))
            return None
        if not isinstance(answer, dict) or any(name not in answer for name in schema.get("required", [])):
            issues.append(Issue("reply_malformed", f"the {stage} reply is not the requested object", record))
            return None
        return answer


def digest(record: dict) -> str:
    """The digest a record is embedded under: SHA-256 of its canonical JSON."""
    return hashlib.sha256(canonical_json(record)).hexdigest()


def _execution(evidence: Evidence, schema: Schema, options: UnifiedOptions, chat: Router, counters: dict) -> dict:
    """The execution record: the pins, and each stage's effective budget resolved from its role's served context."""
    native = isinstance(chat.fields, gliformer.GLiFormerFields)
    stages = {}
    for stage, reserve in DEFAULTS[options.defaults]["reserves"].items():
        context = counters[ROLE[stage]].context_tokens
        if type(context) is not int or context <= 0:
            raise BudgetRefused(f"the {ROLE[stage]} model's server reports no context size to budget against")
        output = 0 if native and ROLE[stage] == "fields" else options.output_tokens or reserve
        if (options.input_tokens or 0) + output > context:
            raise BudgetRefused(f"input {options.input_tokens} + reply {output} tokens exceed the {ROLE[stage]} "
                                f"model's served context of {context}")
        stages[stage] = {"role": ROLE[stage], "input_tokens": options.input_tokens or context - output,
                         "output_tokens": output}
    # `extraction_id` stays in the version 3 artifact's execution record, always null: durable attempts are named by
    # the coordination schema, not by this record.
    return {"version": RECORD_VERSION, "extraction_id": None,
            "source": {"run_id": evidence.run_id, "generation": evidence.generation, "digest": evidence.digest},
            "schema_sha256": digest(schema.model_dump(by_alias=True, exclude_none=True)),
            "method": options.dumped(), "defaults": DEFAULTS[options.defaults],
            "effective": {name: options.setting(name) for name in ("overlap", "headings", "verification", "splits")}
            | {name: value for name, value in DEFAULTS[options.defaults].items()
               if name in ("windows", "pipelined", "entry_reply", "corrections", "single_pass")}
            | {"stages": stages} | ({"headings": False, "verification": False} if native else {})
            | ({"entry_reply": "reserve"} if "entry_reply" in DEFAULTS[options.defaults]
               and (native or options.output_tokens) else {}),
            "models": chat.models, "prompt_version": PROMPT_VERSIONS.get(options.defaults, 5),
            "discovery_version": discovery.VERSION,
            "tokenizers": {role: {**counter.identity(), "context_tokens": counter.context_tokens}
                           for role, counter in counters.items()}}


def _linked_by(effective: dict) -> str:
    """Who accepts a located value: the verification call, or, with it off, only code (a single pass; earlier
    versions accept nothing then)."""
    return "verification" if effective["verification"] else "lexical"


def _call_json(call: Call) -> dict:
    """A call as a record keeps it: whole milliseconds, so the record's canonical bytes hold no float."""
    dumped = asdict(call)
    dumped["milliseconds"] = round(dumped.pop("seconds") * 1000)
    return dumped


def _call_of(call: dict) -> Call:
    return Call(**{key: value for key, value in call.items() if key != "milliseconds"},
                seconds=call["milliseconds"] / 1000)


def _issue_json(issue: Issue) -> dict:
    return {**asdict(issue), "path": list(issue.path) if issue.path else None}


def work_order(entries: list[dict], pages: dict[str, int], start_page: int | None) -> list[int]:
    """Entry indices in the order they are read (service README, start_page): by distance of each entry's first page
    from `start_page`, an entry whose page is unknown last, ties in source order; without a start page, source order.
    Assembly keeps source order whatever this returns, so the artifact is the same."""
    def distance(number: int) -> tuple[float, int]:
        ranges = entries[number].get("ranges") or []
        page = pages.get(ranges[0]["segment"]) if ranges else None
        return (0.0 if start_page is None else abs(page - start_page) if page is not None else float("inf"), number)
    return sorted(range(len(entries)), key=distance)


# --- extraction ----------------------------------------------------------------------------------------------------

def extract(run_dir: Path | None, evidence: Evidence, request, chat: Router, *, counter=None, chunks: int = 1) -> dict:
    """The version 3 artifact for `request` (the validated `run.ExtractRequest`) over `evidence`; the execution,
    discovery and entry records live only in the artifact (`run_dir` is not read). Entries run `chunks` at a time,
    nearest `options.start_page` first (`work_order`), assembled in source order. Pipelined (defaults 3), a durable
    run's planning reads the entries of the windows already read while discovery still waits on later ones
    (`NeedsCall`), publishing them under `unified-prefix`, and verifies them once discovery is complete; a run that is
    not durable reads discovery whole first, so its artifact is the same."""
    started, clock = datetime.now(UTC).isoformat(), time.monotonic()
    schema, options = request.schema_, request.options.unified
    if isinstance(chat.fields, gliformer.GLiFormerFields):
        gliformer.native_schema(schema)
        if options.headings is True or options.verification is True:
            raise ValueError("GLiFormer pure extraction cannot use heading context or value verification")
    counters = counter if isinstance(counter, dict) else (counters_for(chat) if counter is None
                                                           else dict.fromkeys(("fields", "reasoning"), counter))
    execution = _execution(evidence, schema, options, chat, counters)
    execution_sha256 = digest(execution)
    effective = execution["effective"]
    linked_by = _linked_by(effective)
    budget = _Budget(chat, counters, effective["stages"],
                     frozenset({"entry"}) if effective.get("entry_reply") == "context" else frozenset())
    from kei_exp.kie.extract.durable import Boundary, NeedsCall
    from kei_exp.kie.extract.retained import discovering, plan_execution, plan_records, saved_record
    # Durable runs keep it in their plans (`plan_execution`), one stage per distinct record: a resumed round whose
    # record changed (a deploy, a served context) adds a row instead of conflicting with the first.
    plan_execution(chat, f"unified-execution:{execution_sha256[:16]}", execution)
    pipelined = effective.get("pipelined", False)
    # Durable planning never waits on a model: an `ask` replays a saved reply or captures the call and raises
    # `NeedsCall`, so it reads in turn, without threads; the calls run in their own workflows (durable_extract).
    durable = getattr(chat, "runtime", None) is not None
    stopped: list[Boundary] = []

    def ask(*args) -> dict | None:
        """A discovery call; one that may not start (the run is pausing or stopping) is a window not read yet, so the
        entries already decided are still compiled before planning ends."""
        try:
            return budget.ask("discovery", *args)
        except Boundary as boundary:
            if not pipelined:
                raise
            stopped.append(boundary)
            raise NeedsCall() from None

    def discover() -> tuple[dict, bool]:
        description = schema.record_description + (DISCOVERY_SCOPE if options.defaults >= 5 else "")
        body = discovery.discover(evidence, description, partial(budget.fits, "discovery"),
                                  ask, overlap=effective["overlap"],
                                  splits=effective["splits"], by=effective.get("windows", "budget"), workers=chunks,
                                  progress=partial(discovering, chat), frontier=pipelined,
                                  unanswered=(NeedsCall,) if durable else ())
        if body is None:
            raise BudgetRefused("not even one character of source fits a discovery request beside its instructions")
        return {"version": discovery.VERSION, "execution_sha256": execution_sha256, "entries": body["entries"],
                "ledger": body["ledger"], "windows": body["windows"],
                "issues": [_issue_json(issue) for issue in body["issues"]],
                "calls": [_call_json(call) for call in body["calls"]]}, body.get("complete", True)
    found, complete = discover()
    run = _Run(schema, budget, {passage.id: passage.text for passage in evidence.passages}, effective,
               {passage.id: passage.table for passage in evidence.passages if passage.table is not None})
    passages = {passage.id: passage for passage in evidence.passages}
    pages = {passage.id: passage.page for passage in (*evidence.passages, *evidence.withheld)}

    def read(entries: list[dict]) -> list:
        """Every entry's work, nearest the start page first; the first failure in entry order is raised, and an entry
        never read is None. Durable planning reads every entry in turn: one that waits on a call (`NeedsCall`, or
        `Boundary` when no call may start) lets the next one in, and the workflow runs `chunks` calls of each role at
        once (durable_extract), so an entry waiting on its verification holds no entry back. A run that is
        not durable reads `chunks` entries at once, and its first failure stops the rest. Until discovery is complete,
        verification waits, so that the reasoning model reads discovery's windows; candidates are shown meanwhile."""
        def one(number: int) -> _Work:
            entry = entries[number]
            unit = f"{entry['id']}#{digest(entry['ranges'])[:16]}" if pipelined else None
            page = pages.get(entry["ranges"][0]["segment"]) if entry.get("ranges") else None  # as `work_order` reads it
            # A finished entry is a function of these, its counts and its saved replies: an earlier round of the
            # attempt that read and saved it leaves nothing to read or save again (a phase change, verification once
            # discovery is complete, is another key).
            place, kept = tokens.compiled([execution_sha256, number, entry, complete, unit],
                                         counters.values()) if durable else (None, None)
            if kept is not None:  # its scope is listed with every entry's (`plan_records`)
                return kept
            work = run.entry(number, entry, verify=complete, unit=unit, page=page)
            if not work.failed and not work.undecided:
                # A finished entry's accepted values are verified: their links are the final artifact's, so the
                # researcher sees them on the source while the other entries are still read.
                saved_record(chat, work.record, entry["ranges"], record=number, primary=entry["ranges"],
                             links=[_link(each, number, passages, linked_by) for each in work.found
                                      if each.kind == "accepted"])
                if place is not None:
                    tokens.keep_compiled(place, work)
            return work
        order, works = work_order(entries, pages, request.options.start_page), [None] * len(entries)
        raised: dict[int, BaseException] = {}
        if durable:
            for number in order:
                try:
                    works[number] = one(number)
                except (NeedsCall, Boundary) as waiting:  # the entries after it are still compiled
                    raised[number] = waiting
                except BaseException as error:  # noqa: BLE001 - raised below, the first in entry order
                    raised[number] = error
                    break
        else:
            halt = threading.Event()

            def guarded(number: int) -> _Work | None:
                if halt.is_set():
                    return None
                try:
                    return one(number)
                except BaseException:
                    halt.set()
                    raise
            with ThreadPoolExecutor(max_workers=max(1, chunks), thread_name_prefix="catalog-entry") as pool:
                futures = {number: pool.submit(guarded, number) for number in order}
            for number, future in futures.items():
                if (error := future.exception()) is not None:
                    raised[number] = error
                else:
                    works[number] = future.result()
        if raised:
            raise raised[min(raised)]
        return works
    if not complete:
        # Each entry of the windows read so far is final, so its number is: it is read and listed now.
        try:
            read(found["entries"])
        finally:
            if found["entries"]:
                plan_records(chat, "unified-prefix", [entry["ranges"] for entry in found["entries"]], partial=True)
        raise stopped[0] if stopped else NeedsCall()
    discovering(chat, None, None)
    plan_records(chat,"unified-records",[entry["ranges"] for entry in found["entries"]])
    entries = read(found["entries"])
    document = run.document(evidence) if schema.document_nodes else None
    if document is not None:
        from kei_exp.kie.extract.retained import saved_document
        saved_document(chat,document.values,complete=not document.failed and all(call.ok or call.recovered for call in document.calls))
    return _artifact(evidence, request, chat, started, clock, execution, found, entries, document)


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
    repaired: bool = False            # its quote or value is the source's text a model copied nearly verbatim


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

    def __init__(self, view: BlockText, shown: tuple[int, int], window: int, nodes: list[Node],
                 tables: dict[str, PageTable] | None = None, *, repair: bool = True, enclosing: bool = False):
        self.view, self.shown, self.window, self.nodes = view, shown, window, nodes
        self.tables, self.repair, self.enclosing = tables or {}, repair, enclosing

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
                    table_places = [spans for spans in places if self._item_row(spans)]
                    own = table_places if len(table_places) == 1 else places
                    spot = _key(own[0]) if len(own) == 1 else None

                def children(spot: tuple | None) -> list[_Found]:
                    return [each for child in node.children or []
                            for each in self._field((*path, index, child.name), child, entry.get(child.name), inner,
                                                    spot)]
                leaves = children(spot)
                if item is None and spot is None:
                    # Its own text not located, an item is the table row its values name. A value of the item (not of
                    # a list inside it) printed in one table place only, a single-row cell, names that row; others
                    # abstain. At least one must name a row, and all that do the same one.
                    rows: dict[tuple, list[list[Span]]] = {}
                    for leaf in leaves:
                        nested = any(isinstance(step, int) for step in leaf.path[len(path) + 1:])
                        if leaf.support != "literal" or nested:
                            continue
                        tabled = [spans for spans in (leaf.spans, *leaf.alternatives)
                                  if any(span.segment_id in self.tables for span in spans)]
                        if len(tabled) == 1 and self._item_row(tabled[0]):
                            rows.setdefault(tuple(self._item_row(tabled[0])), []).append(tabled[0])
                    if len(rows) == 1:
                        # Its first cell: what the model quotes as an item's own text is mostly its number.
                        (cells,) = rows.values()
                        leaves = children(_key(min(cells, key=lambda spans: spans[0].start)))
                found += leaves
        return found

    def _item_row(self, spans: list[Span]) -> list[tuple[int, int]]:
        """An item's identity must name one row, never a cell shared by several rows."""
        if len(spans) != 1 or spans[0].segment_id not in self.tables:
            return []
        span = spans[0]
        if any(cell.rowspan == 1 and cell.start <= span.start and span.end <= cell.end
               for cell in self.tables[span.segment_id].cells):
            return self._row(spans)
        return []

    def _row(self, spans: list[Span]) -> list[tuple[int, int]]:
        """The view range of each cell of the table row whose cell holds the whole quote, from the parse's own cells;
        none when the quote is not inside one table cell. Cells are searched apart, never as one range from the first to
        the last: a cell spanning several rows (or the text between cells) would otherwise widen it over other rows."""
        if len(spans) != 1 or spans[0].segment_id not in self.tables:
            return []
        span, cells = spans[0], self.tables[spans[0].segment_id].cells
        cell = next((each for each in cells if each.start <= span.start and span.end <= each.end), None)
        if cell is None:
            return []
        ranges = []
        for each in cells:
            if each.start < each.end and each.row <= cell.row < each.row + each.rowspan:
                try:
                    ranges.append(raw_range(self.view, [Span(segment_id=span.segment_id, start=each.start,
                                                             end=each.end)]))
                except IndexError:  # the cell lies outside this view
                    continue
        return ranges

    def _places(self, text: str, within: tuple[int, int] | None = None, numeric: bool = False) -> list[list[Span]]:
        """Occurrences in the view, those inside the text this window showed first."""
        places = located(self.view, text, within=within, numeric=numeric)
        return sorted(places, key=lambda spans: not self.shown[0] <= raw_range(self.view, spans)[0] < self.shown[1])

    def _near(self, text: str, within: tuple[int, int] | None = None) -> list[Span] | None:
        """The one place `text` was nearly copied from (`NEAR`), or None when it is short or is not one place."""
        length = len(normalise(text).text)
        if length < NEAR:
            return None
        places = nearly(self.view, text, max(3, length // 50), within=within)
        return places[0] if len(places) == 1 else None

    def _text(self, spans: list[Span]) -> str:
        """The source text a repaired quote or value stores, as an exact one is compared (`locate.printed`)."""
        start, end = raw_range(self.view, spans)
        return printed(self.view.text[start:end])

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
        # A list item's values are its own occurrence's first: a cell printed in several rows is this row's.
        item_spans = [Span(segment_id=s, start=a, end=b) for s, a, b in anchor] if anchor else []
        own = raw_range(self.view, item_spans) if item_spans else None
        row = self._item_row(item_spans)
        passage = isinstance(typed, bool) or node.allowed_values is not None or \
            evidence_policy(self.nodes, _field_path(path)) == "derived"  # a passage may support it, unprinted
        free = self.repair and node.type in ("string", "verbatim-string") and not passage
        quoted = []
        if found.quote and found.quote.strip():
            quoted = ([spans for within in row for spans in self._places(quote, within)]
                      or (self._places(quote, own) if own else []) or self._places(quote))
            if not quoted and free and (near := (self._near(quote, own) if own else None) or self._near(quote)):
                quoted, found.quote, found.repaired = [near], self._text(near), True
        if not quoted:
            found.reason = "quote_not_in_source" if found.quote and found.quote.strip() else "no_quote"
            return found
        numeric = isinstance(typed, (int, float)) and not isinstance(typed, bool)
        literal: list[list[Span]] = []
        for spans in quoted:
            for text in forms(typed):
                literal += [each for each in self._places(text, raw_range(self.view, spans), numeric)
                            if each not in literal]
        if not literal and len(quoted) == 1:  # one quoted table cell, such as a row's number, and the value printed
            for within in self._row(quoted[0]):  # in a cell of that row; a quote found in several places names none
                for text in forms(typed):
                    literal += [each for each in self._places(text, within, numeric) if each not in literal]
        if not literal and free and len(quoted) == 1:
            # A page break can divide the printed value beyond its quoted cell. Locate the complete value in
            # contiguous source text, enclosing that quote; never infer or join a table continuation. A single pass
            # (`enclosing`) also takes a whole passage quoted by part of it: nothing reads that value again.
            for text in forms(typed):
                for spans in self._places(text):
                    if len(spans) < 2 and not self.enclosing:
                        continue
                    start, end = raw_range(self.view, spans)
                    if any(start <= a and b <= end for a, b in (raw_range(self.view, quote) for quote in quoted)):
                        literal.append(spans)
        if not literal and free and len(quoted) == 1 and (near := self._near(typed, raw_range(self.view, quoted[0]))):
            literal, found.value, found.repaired = [near], self._text(near), True
        if literal:
            found.support, found.spans, found.alternatives = "literal", literal[0], literal[1:]
        elif passage:
            found.support, found.spans, found.alternatives = "supporting", quoted[0], quoted[1:]
        else:
            found.reason, found.spans = "value_not_in_quote", quoted[0]
            return found
        found.kind, found.reason = "candidate", None
        return found


# --- prompts -------------------------------------------------------------------------------------------------------

DISCOVERY_SCOPE = (" Keep each record whole: its internal headings, tables, citations and numbered list items belong to it; "
                   "they are neither new records nor record-free text. Only entries matching the record definition are peers. "
                   "Use other only for text outside every record, not sections inside one.")
ENTRY = ("You extract structured data from one record of a source document. A record is: {description}\n{notes}"
         "Answer every field with null when the record does not give it, or with an object: \"value\" (typed as the "
         "field) and \"quote\" (the exact text of the record that states or supports the value, copied character "
         "for character). For each object in a list also give \"_item_text\": the exact text of the record where that "
         "item appears, or null. Read values from the RECORD text; EARLIER and LATER text belongs to the same record "
         "and is shown so that a value crossing the cut is whole; CONTEXT is not part of the record. Never invent a "
         "value. Return only the JSON object.")
# Defaults 6 (`single_pass`): the entry call is the only reading of a value. Constrained decoding never shows the
# model its reply schema, and notes list described fields only, so the value structure is shown; complete values are
# asked here, as version 5's corrections asked them of a second reading.
SINGLE_PASS = ("\nGive each value complete: a descriptive field's whole passage across paragraphs or pages, without "
               "text of other fields.\nRequested value structure, before adding the value/evidence wrappers:\n{structure}")
VERIFY = ("You check values extracted from one record of a source document. A record is: {description}\n{notes}"
          "For each candidate answer \"supported\" when the record text states that value for that field of this "
          "record, \"unsupported\" when it does not (it says something else, or the value belongs to another record or "
          "only to the context), or \"unclear\". Judge only from the text shown. Return only the JSON object.")
VERIFY_COMPLETE = (
    "You check values extracted from one source record. A record is: {description}\n{notes}"
    "For each scalar field, read the source afresh and return the final complete value and an exact quote "
    "containing that entire value. Include the whole descriptive passage across paragraphs or pages, "
    "and exclude other fields. Do not summarize or invent. Return null if the record supplies no value. "
    "For list-item fields, return supported, unsupported, or unclear without changing the item identity. "
    "Use only RECORD, EARLIER TEXT and LATER TEXT, never CONTEXT. Return only the JSON object.")
ARBITRATION = ("Several verified candidate values were found in one record of a source document for one field. "
               "Choose the label of the candidate whose value is correct for the field, given its source text, or "
               "NONE when none is. Return only the JSON object.")
# With verification off (a single pass) candidates are located by code, never verified, and arbitration says so.
ARBITRATION_LOCATED = ARBITRATION.replace("Several verified candidate values were found",
                                          "Several candidate values, each located in the record's text, were found")
DOCUMENT = ("You extract fields that describe a whole source document, not one record.\n{notes}"
            "Answer every field with null when the text shown does not give it, or with an object: \"value\" (typed "
            "as the field) and \"quote\" (the exact supporting text, copied character for character). For each object "
            "in a list also give \"_item_text\": the exact text where that item appears, or null. Never invent a "
            "value. Return only the JSON object.")
REPAIRED = "a nearly verbatim copy was replaced by the source text it was copied from"
# A typed value whose citation is missing or found nowhere: code cannot judge it. A located quote that does not print
# its value (`value_not_in_quote`, such as a value of another table row) contradicts it and stays rejected.
UNCITED = ("no_quote", "quote_not_in_source")
VERDICTS = {"supported": ("accepted", None), "unsupported": ("rejected", "verification_rejected"),
            "unclear": ("proposed", "verification_unclear")}


def _notes(nodes: list[Node]) -> str:
    return "".join(f"{line}\n" for line in notes(nodes))


def _source_text(units: Sequence[Unit], texts: dict[str, str], tables: dict[str, PageTable]) -> str:
    """Discovery owns nonblank ranges; model input restores the empty columns beside each table line."""
    shown = []
    for unit in units:
        start, end = unit.start, unit.end
        if unit.segment in tables:
            text = texts[unit.segment]
            while start > 0 and text[start - 1] in " \t":
                start -= 1
            while end < len(text) and text[end] in " \t":
                end += 1
        shown.append(Unit(unit.segment, start, end))
    return text_of(shown, texts)


def _user(window: Window, texts: dict[str, str], marker: str, tables: dict[str, PageTable]) -> str:
    def source(units):
        return _source_text(units, texts, tables)
    parts = ([f"### CONTEXT (not part of the record)\n{source(window.heading)}"] if window.heading else []) + \
        ([f"### EARLIER TEXT\n{source(window.before)}"] if window.before else []) + \
        [f"### {marker}\n{source(window.primary)}\n### END {marker}"] + \
        ([f"### LATER TEXT\n{source(window.after)}"] if window.after else [])
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
    native: list[dict] | None = None
    unit: str | None = None  # the entry's capture identity apart from its number (`calls.complete`)
    page: int | None = None  # the entry's first page, for its calls' priority (`calls.complete`)


class _Run:
    def __init__(self, schema: Schema, budget: _Budget, texts: dict[str, str], effective: dict,
                 tables: dict[str, PageTable] | None = None):
        self.schema, self.budget, self.texts, self.effective = schema, budget, texts, effective
        self.tables = tables or {}
        self.nodes = schema.record_nodes

    def _read(self, stage: str, number: int | None, units: list[Unit], system: str, schema: dict, marker: str,
              heading: tuple[Unit, ...], out: _Work) -> list[tuple[Window, dict | None]]:
        """Every window's reply in source order; a failed window is halved up to the versioned number of times."""
        def fits(window: Window) -> bool:
            user = _user(window, self.texts, marker, self.tables) + "\n\nReturn the JSON object now."
            return self.budget.fits(stage, system, user, schema)
        windows = plan(units, self.texts, fits, overlap=self.effective["overlap"], heading=heading)
        if windows is None:
            raise BudgetRefused(f"not even one character of source fits a {stage} request beside its instructions")
        replies = []
        queue = [(window, 0) for window in windows]
        while queue:
            window, depth = queue.pop(0)
            user = _user(window, self.texts, marker, self.tables) + "\n\nReturn the JSON object now."
            answer = self.budget.ask(stage, number, system, user, schema, out.calls, out.issues, out.unit, out.page)
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

    def entry(self, number: int, entry: dict, *, verify: bool = True, unit: str | None = None,
              page: int | None = None) -> _Work:
        """The entry's windows read and checked, then (with `verify`) its candidates verified and settled; without, its
        record holds the candidates. With verification off nothing waits on `verify`: code settles it at once. `unit` names it
        for the capture identity of its calls, `page` for their priority."""
        out = _Work(unit=unit, page=page)
        if isinstance(self.budget.chat.fields, gliformer.GLiFormerFields):
            out.native = []
            if entry["end"] not in ("validated", "source_end"):
                out.failed = 1
                out.issues.append(Issue("entry_boundary_unresolved", "GLiFormer did not read an entry with an "
                                        "unresolved end", number))
                return out
            out.native, calls = gliformer.read_entry(
                self.budget.chat.fields, self.budget.counters["fields"], self.schema, entry, self.texts,
                ceiling=self.budget.stages["entry"]["input_tokens"], overlap=self.effective["overlap"],
                number=number, unit=unit)
            out.calls = [replace(call, record=number) for call in calls]
            out.windows = len(out.native)
            return out
        if not self.nodes:
            return out
        units = [Unit(each["segment"], each["start"], each["end"]) for each in entry["ranges"]]
        heading = tuple(Unit(each["segment"], each["start"], each["end"]) for each in entry["context"]) \
            if self.effective["headings"] else ()
        system = ENTRY.format(description=self.schema.record_description, notes=_notes(self.nodes))
        single = self.effective.get("single_pass", False)
        if single:
            system += SINGLE_PASS.format(structure=json.dumps(json_schema(self.nodes), ensure_ascii=False,
                                                              separators=(",", ":")))
        replies = self._read("entry", number, units, system, candidates_schema(self.nodes), "RECORD", heading, out)
        view = _view(units, self.texts)
        found: list[_Found] = []
        for index, (window, answer) in enumerate(replies):
            if answer is not None:
                first, last = (*window.before, *window.primary)[0], (*window.primary, *window.after)[-1]
                shown = (_position(units, first.segment, first.start), _position(units, last.segment, last.end))
                found += _Checker(view, shown, index, self.nodes, self.tables, enclosing=single).reply(answer)
        out.issues += [Issue("quote_repaired", REPAIRED, number, ("records", number, *path))
                       for path in sorted({_field_path(each.path) for each in found if each.repaired})]
        out.found, out.items = _merged(found, view, _edges(replies), out.issues, number)
        if not verify and self.effective["verification"]:
            out.record = conform(_placed(out.found, lambda each: each.kind == "candidate"), self.nodes)
            return out
        self._verify(number, replies, out)
        out.contest = self._settle(number, out, view)
        if not single:
            _renumbered(out.found)
            out.record = conform(_placed(out.found), self.nodes)
            return out
        # Nothing reads a value again: one whose quote is missing or found nowhere stays the record's, without Evidence.
        for each in out.found:
            if each.kind == "rejected" and each.reason in UNCITED:
                each.kind = "proposed"
        kept = _kept_in_items(out.found)
        _renumbered(out.found, kept)
        from kei_exp.kie.extract.retained import _reviewable_scalars
        out.record = _reviewable_scalars(conform(_placed(out.found, kept), self.nodes), self.nodes,
                                         [{"path": ["records", number, *each.path], "value": each.value}
                                          for each in out.found if each.kind == "proposed" and each.item is None],
                                         number)
        return out

    def _verify(self, number: int, replies: list[tuple[Window, dict | None]], out: _Work) -> None:
        """Verdicts on the candidates, batched per window in counted requests that are halved on overflow or failure."""
        for found in out.found:
            if found.kind != "candidate":
                continue
            policy = evidence_policy(self.nodes, _field_path(found.path))
            if policy != "quoted":
                found.kind, found.reason = "proposed", f"evidence_policy_{policy}"
            elif not self.effective["verification"]:  # a single pass accepts what code grounded, as code's link
                found.kind, found.reason = ("accepted", None) if self.effective.get("single_pass") else \
                    ("proposed", "verification_disabled")
        # Corrections address scalar fields; changing a list item would require rediscovering its identity.
        nodes = {}
        def scalars(children, path=()):
            for node in children:
                key = (*path, node.name)
                if node.type == "object":
                    scalars(node.children or [], key)
                elif node.type != "array" and evidence_policy(self.nodes, key) == "quoted":
                    nodes[key] = node
        if self.effective.get("corrections") and self.effective["verification"]:
            scalars(self.nodes)
        system = (VERIFY_COMPLETE if nodes else VERIFY).format(
            description=self.schema.record_description, notes=_notes(self.nodes))
        for index, (window, _) in enumerate(replies):
            batch = [found for found in out.found if found.window == index and (
                found.kind == "candidate" or found.kind == "rejected" and found.path in nodes and
                found.reason in ("no_quote", "quote_not_in_source", "value_not_in_quote"))]
            pending = [batch] if batch else []
            while pending:
                group = pending.pop(0)
                labels = [f"C{n}" for n in range(1, len(group) + 1)]
                user = _user(window, self.texts, "RECORD", self.tables) + "\n\n### CANDIDATES\n" + "\n".join(
                    f"{label}: {'.'.join(str(step) for step in _field_path(found.path))}" +
                    ("" if found.path in nodes else f" = {json.dumps(found.value, ensure_ascii=False)} "
                     f"(quoted: {json.dumps(found.quote, ensure_ascii=False)})")
                    for label, found in zip(labels, group, strict=True)) + "\n\nReturn the JSON object now."
                verdict = {"type": "string", "enum": list(VERDICTS)}
                schema = {"type": "object", "properties": {
                    label: _leaf(nodes[found.path]) if found.path in nodes else verdict
                    for label, found in zip(labels, group, strict=True)},
                          "required": labels, "additionalProperties": False}
                answer = self.budget.ask("verification", number, system, user, schema, out.calls, out.issues,
                                         out.unit, out.page) \
                    if self.budget.fits("verification", system, user, schema) else None
                if answer is not None and all(label in answer and (
                        (answer[label] is None or isinstance(answer[label], dict)) if found.path in nodes
                        else isinstance(answer[label], str) and answer[label] in VERDICTS)
                        for label, found in zip(labels, group, strict=True)):
                    for label, found in zip(labels, group, strict=True):
                        value = answer[label]
                        # The checker sees only this request's record text, never context or unseen windows.
                        view = _view([*window.before, *window.primary, *window.after], self.texts)
                        checker = _Checker(view, (0, len(view.text)), index, self.nodes, self.tables, repair=False)
                        if isinstance(value, dict) and "value" in value and value["value"] is None:
                            # A null quoting the candidate's own printed value contradicts itself: left for review.
                            quote = value.get("quote")
                            value = "unclear" if isinstance(quote, str) and quote.strip() and found.spans and any(
                                all(any(s.segment_id == q.segment_id and q.start <= s.start and s.end <= q.end
                                        for q in spans) for s in found.spans)
                                for spans in checker._places(quote)) else None
                        if value is None or isinstance(value, str):
                            if found.kind == "candidate":
                                found.kind, found.reason = VERDICTS[value or "unsupported"]
                            continue
                        corrected = checker._scalar(found.path, nodes[found.path], value, None, None)
                        if corrected.kind == "candidate" and found.kind == "candidate" and corrected.value == found.value:
                            found.kind = "accepted"
                            continue
                        out.found.append(corrected)
                        if corrected.kind == "candidate":
                            corrected.kind = "accepted"
                            found.kind, found.reason = "rejected", "verification_corrected"
                            out.issues.append(Issue("verification_corrected",
                                "verification replaced a candidate with a source-grounded correction",
                                number, ("records", number, *found.path)))
                        elif found.kind == "candidate":  # an answered check: a doubt for review, not failed processing
                            found.kind, found.reason = "proposed", "verification_unresolved"
                elif len(group) > 1:
                    pending[0:0] = [group[:len(group) // 2], group[len(group) // 2:]]
                else:
                    if group[0].kind == "candidate":
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
            system = ARBITRATION if self.effective["verification"] else ARBITRATION_LOCATED
            answer = self.budget.ask("arbitration", number, system, user, schema, out.calls, out.issues,
                                     out.unit, out.page) \
                if self.budget.fits("arbitration", system, user, schema) else None
            choice = answer.get("choice") if answer else None
            chosen = labels.index(choice) if choice in labels else None
            for position, found in enumerate(candidates):
                if position != chosen:
                    found.kind, found.reason = "proposed", "competing_value"
            if chosen is None:
                read = "verified" if self.effective["verification"] else "located"
                out.issues.append(Issue("competitors_unresolved", f"{len(candidates)} {read} values disagree",
                                        number, ("records", number, *path)))
            contest.append({"path": ["records", number, *path], "outcome": "unresolved" if chosen is None
                            else "arbitrated", "chosen": chosen,
                            "candidates": [{"value": found.value, "spans": spans_json(found.spans),
                                            "window": found.window} for found in candidates]})
        return contest

    def document(self, evidence: Evidence) -> _Work:
        """Document-level fields from their own windows over every admitted nonblank range; never verified. The
        windows' answers are assembled by `contexts.assemble_document`: every list occurrence kept, an equal item two
        windows both returned joined once when the source both were shown prints it (`overlap_items_joined`), equal
        items from other windows named (`possible_repeated_items`), a disagreeing scalar null with its conflict."""
        from kei_exp.kie.extract.retained import document_inputs
        document_schema,carried=document_inputs(self.budget.chat,self.schema)
        nodes = document_schema.document_nodes
        out = _Work()
        if not nodes:
            out.values=carried
            return out
        system = DOCUMENT.format(notes=_notes(nodes))
        units = discovery.units_of(evidence.passages)
        replies = self._read("document", None, units, system, candidates_schema(nodes), "SOURCE", (), out)
        per_window, shown_units = [], []
        for index, (window, answer) in enumerate(replies):
            if answer is None:
                continue
            shown = [*window.before, *window.primary, *window.after]
            found = _Checker(_view(shown, self.texts), (0, 0), index, nodes, self.tables, repair=False).reply(answer)
            out.found += found
            per_window.append(conform(_placed(found, lambda each: each.kind == "candidate"), nodes))
            shown_units.append(shown)

        def shared(first: int, second: int, item) -> bool:
            common = "\n".join(self.texts[a.segment][max(a.start, b.start):min(a.end, b.end)]
                               for a in shown_units[first] for b in shown_units[second]
                               if a.segment == b.segment and a.start < b.end and b.start < a.end)
            return printed_once_in(item, common)
        out.values, out.conflicts, repeats, joined = (assemble_document(per_window, shared) if len(per_window) > 1
            else (per_window[0], [], [], []) if per_window else ({}, [], [], []))
        out.issues += [Issue(code, json.dumps(each, ensure_ascii=False), None, tuple(each["path"]))
                       for code, group in (("possible_repeated_items", repeats), ("overlap_items_joined", joined))
                       for each in group]
        out.values = {**carried,**conform(out.values, nodes)}
        for found in out.found:
            if found.kind == "candidate":
                found.kind, found.reason = "proposed", "document_unverified"
        return out


def _accepted(leaf: _Found) -> bool:
    return leaf.kind == "accepted"


def _kept_in_items(found: list[_Found]) -> Callable[[_Found], bool]:
    """What a single pass's record keeps: an accepted value, and a proposal inside a list item code located by another
    of its values, so the item stays whole, with Evidence where it has it. An item none of whose values code located
    has no occurrence to tell it from an equal item another window read, nor a place in the list: it stays a proposal,
    as with verification (a partial item, at a null position, stays out too). A scalar field's proposals are settled
    as `retained._reviewable_scalars` settles them."""
    located = {leaf.item for leaf in found if leaf.kind == "accepted" and leaf.item is not None}
    return lambda leaf: leaf.kind == "accepted" or (leaf.kind == "proposed" and leaf.item in located
                                                     and None not in leaf.path)


def _renumbered(found: list[_Found], kept: Callable[[_Found], bool] = _accepted) -> None:
    """List positions made dense over the items that kept a value, at every list level, as `conform` compacts the
    record's lists: evidence then names the item it supports. An item left without one takes a null position."""
    accepted = [leaf.path for leaf in found if kept(leaf)]

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


def _placed(found: list[_Found], kept: Callable[[_Found], bool] = _accepted) -> dict:
    record: dict = {}
    for each in found:
        if kept(each) and None not in each.path:
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

def _link(found: _Found, number: int, passages: dict, linked_by: str = "verification") -> dict:
    """An accepted value's Evidence. `linked_by` names who accepted it: `verification`, a separate verification call;
    `lexical`, code alone, which located the model's quote and the value in it (a single pass with verification off)."""
    shared = evidence_link(Outcome("accepted", ("records", number, *found.path), found.value, spans=found.spans,
                                   alternatives=found.alternatives), passages, {})
    keep = ("path", "segment", "page", "bbox_pt", "cell", "precision", "hits", "spans", "alternatives", "raw")
    return {**{key: shared[key] for key in keep}, "verbatim": found.support == "literal", "support": found.support,
            "linked_by": linked_by,
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
    native = isinstance(chat.fields, gliformer.GLiFormerFields)
    native_windows, ungrounded = [], []
    if native:
        records = []
        for index, entry in enumerate(entries):
            for window in entry.native or []:
                rows = window["output"]["record"]
                native_windows.append({**window, "entry": found["entries"][index]["id"],
                                       "record_start": len(records), "record_count": len(rows)})
                records.extend(rows)
        ungrounded = [path for index, record in enumerate(records)
                      for path in gliformer.leaves(record, ("records", index))]
    else:
        records = [merge(entry.record, document.values if document else {}, evidence.source_name, schema)
                   for entry in entries]
    calls = [_call_of(call) for call in found["calls"]] + \
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
        "boundaries": not unresolved and all(entry["end"] in ("validated", "source_end") for entry in found["entries"]),
        "processing": not any(processing[stage]["failed"] for stage in ("discovery", "entries", "document"))
        and not processing["verification"]["undecided"],
        "evidence": not ungrounded and not any(each.kind == "proposed" for entry in entries for each in entry.found)
        and not any(contest["outcome"] == "unresolved" for entry in entries for contest in entry.contest),
        "recall": "unmeasured"}
    result = {
        "extraction_version": EXTRACTION_VERSION, "run_id": evidence.run_id, "generation": evidence.generation,
        "digest": evidence.digest, "strategy": "catalog", "model": chat.model, "models": chat.models,
        "prompt_version": execution["prompt_version"], "document_version": DOCUMENT_VERSION,
        "schema": schema.model_dump(by_alias=True, exclude_none=True),
        "options": request.options.dumped(), "started": started, "seconds": round(time.monotonic() - clock, 3),
        "execution": execution, "execution_sha256": digest(execution),
        "discovery": found, "discovery_sha256": digest(found),
        "records": records,
        "evidence": [_link(each, number, passages, _linked_by(execution["effective"])) for number, entry
                     in enumerate(entries) for each in entry.found if each.kind == "accepted"],
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
        "ungrounded": ungrounded, "unverified": [node.name for node in schema.document_nodes],
        "processing": processing, "completeness": completeness,
        "complete": completeness["boundaries"] and completeness["processing"] and completeness["evidence"],
        "issues": [*found["issues"], *(_issue_json(issue) for work in (*entries, *([document] if document else []))
                                       for issue in work.issues)],
        "calls": [asdict(call) for call in calls],
        "tokens": {"input": _total(call.input_tokens for call in calls),
                   "output": _total(call.output_tokens for call in calls)},
    }
    if native:
        result["native_fields"] = {"backend": "gliformer", "windows": native_windows}
    result["fingerprint"] = hashlib.sha256(canonical_json({
        "generation": evidence.generation, "digest": evidence.digest, "schema": result["schema"],
        "options": result["options"], "models": chat.models, "prompt_version": execution["prompt_version"],
        "document_version": DOCUMENT_VERSION,
        "execution_sha256": result["execution_sha256"], "discovery_sha256": result["discovery_sha256"]})).hexdigest()
    return result
